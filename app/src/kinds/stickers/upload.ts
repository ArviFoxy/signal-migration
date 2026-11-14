// Uploads a sticker pack to Signal, as Signal Desktop's sticker creator does (ts/textsecure/WebAPI.preload.ts,
// putStickers and makePutParams; sticker-creator/src/util/crypto.ts):
// 1. The chat server hands out an upload form: a new random pack ID and one signed upload policy per file
//    (GET /v1/sticker/pack/form/{count}). Each policy is valid for 30 minutes.
// 2. The manifest and each sticker are encrypted with the pack key and posted to cdn.signal.org as
//    multipart/form-data, through our relay inside the page's own TLS session.
//
// The server rate-limits forms per account (Signal-Server's StickerController uses the sticker pack limiter).

import { create, toBinary } from '@bufbuild/protobuf';
import { StickerPackSchema, StickerPack_StickerSchema } from '../../gen/Stickers_pb';
import { httpsRequest } from '../../signal/http-client';
import { randomHex } from '../../core/random';
import { type ChatChannel, chatHeader, type HttpsRequest } from '../../signal/transport';
import { loadSignalWasm } from '../../signal/wasm';
import { encryptStickerFile } from '../../wasm/signal_migration_wasm';

/**
 * Signal-Server accepts an encrypted sticker of up to 301 KiB (StickerController.MAXIMUM_STICKER_SIZE_BYTES, "add 1
 * kiB for encryption overhead"), and encryption adds at most 64 bytes (IV, padding, MAC). So 300 KiB of image fits.
 */
export const MAX_STICKER_BYTES = 300 * 1024;
/** Signal-Server's limit on the number of files in one form; the cover reuses a sticker here, so all are stickers. */
export const MAX_STICKERS = 200;
const CDN_HOST = 'cdn.signal.org';
const CONCURRENT_UPLOADS = 3;

export type UploadFormItem = {
  id: number;
  key: string;
  credential: string;
  acl: string;
  algorithm: string;
  date: string;
  policy: string;
  signature: string;
};
export type UploadForm = { packId: string; manifest: UploadFormItem; stickers: UploadFormItem[] };

/** Signal refused an upload form because the account reached its sticker pack limit. */
export class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number | null) {
    super(
      retryAfterSeconds === null
        ? 'Signal limits how many sticker packs one account can upload'
        : `Signal allows the next sticker pack upload in ${retryAfterSeconds} s`,
    );
  }
}

const encoder = new TextEncoder();

/** The multipart/form-data body of one upload: the policy fields in Signal Desktop's order, then the file. */
export function multipartBody(item: UploadFormItem, file: Uint8Array, boundary: string): Uint8Array<ArrayBuffer> {
  const field = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head =
    field('key', item.key) +
    field('x-amz-credential', item.credential) +
    field('acl', item.acl) +
    field('x-amz-algorithm', item.algorithm) +
    field('x-amz-date', item.date) +
    field('policy', item.policy) +
    field('x-amz-signature', item.signature) +
    field('Content-Type', 'application/octet-stream') +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const parts = [encoder.encode(head), file, encoder.encode(tail)];
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

async function postToCdn(https: HttpsRequest, item: UploadFormItem, file: Uint8Array): Promise<void> {
  const boundary = `----------------${randomHex(16)}`;
  const response = await https(
    CDN_HOST,
    'POST',
    '/',
    [`Content-Type: multipart/form-data; boundary=${boundary}`],
    multipartBody(item, file, boundary),
  );
  if (response.status < 200 || response.status >= 300)
    throw new Error(`uploading ${item.key} answered ${response.status}`);
}

export async function requestUploadForm(chat: ChatChannel, count: number): Promise<UploadForm> {
  const response = await chat.request('GET', `/v1/sticker/pack/form/${count}`);
  if (response.status === 413 || response.status === 429) {
    const retryAfter = Number(chatHeader(response.headers, 'Retry-After'));
    throw new RateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
  if (response.status !== 200)
    throw new Error(`requesting a sticker upload form answered ${response.status} ${response.message}`);
  return JSON.parse(new TextDecoder().decode(response.body)) as UploadForm;
}

export type StickerFile = { image: Uint8Array; emoji: string };
/**
 * What goes into the uploaded pack: the title, and each sticker's image and emoji. The manifest has no author, and
 * nothing else from Telegram (no pack name or link) goes into it, so the Signal pack does not point back to Telegram.
 */
export type PackContent = { title: string; stickers: StickerFile[] };

const hexToBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));

/** The plaintext manifest. The first sticker is the cover. */
export function manifestFor(content: PackContent): Uint8Array {
  const stickers = content.stickers.map((sticker, id) =>
    create(StickerPack_StickerSchema, { id, emoji: sticker.emoji }),
  );
  return toBinary(StickerPackSchema, create(StickerPackSchema, { title: content.title, cover: stickers[0], stickers }));
}

/**
 * Uploads the pack under `packKey` over the logged-in `chat` connection and `https` to the CDN, and returns its new
 * pack ID. `onProgress` gets (files uploaded, files total).
 */
export async function uploadStickerPack(
  chat: ChatChannel,
  content: PackContent,
  packKey: Uint8Array,
  onProgress: (done: number, total: number) => void = () => undefined,
  https: HttpsRequest = httpsRequest,
): Promise<Uint8Array> {
  if (content.stickers.length === 0 || content.stickers.length > MAX_STICKERS)
    throw new Error(`a Signal sticker pack holds 1 to ${MAX_STICKERS} stickers, not ${content.stickers.length}`);
  await loadSignalWasm();
  const form = await requestUploadForm(chat, content.stickers.length);
  const total = content.stickers.length + 1;
  let done = 0;
  await postToCdn(https, form.manifest, encryptStickerFile(manifestFor(content), packKey));
  onProgress(++done, total);
  let next = 0;
  const uploadNext = async () => {
    while (next < content.stickers.length) {
      const index = next++;
      await postToCdn(https, form.stickers[index], encryptStickerFile(content.stickers[index].image, packKey));
      onProgress(++done, total);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENT_UPLOADS }, uploadNext));
  return hexToBytes(form.packId);
}
