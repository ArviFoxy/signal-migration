// Compares a sticker pack on Signal that someone else uploaded with the Telegram pack it is said to copy. The page
// installs such a copy only when this comparison finds no difference.
//
// The copy must be what this app would upload for the Telegram pack: the same title, no author, the stickers in
// the same order with the same emoji, the first sticker as the cover, and each sticker file either the Telegram
// file itself or a conversion that shows the same.

import { fromBinary } from '@bufbuild/protobuf';
import { StickerPackSchema } from '../../gen/Stickers_pb';
import { decryptStickerFile } from '../../wasm/signal_migration_wasm';
import { isPlainPng } from './plain-png';
import type { StickerFormat } from './telegram-packs';
import { MAX_STICKER_BYTES } from './upload';

export type OriginalSticker = { file: Uint8Array; emoji: string; format: StickerFormat };
/** A Telegram pack as the page downloaded it. */
export type OriginalPack = { title: string; stickers: OriginalSticker[] };

/** A pack's files on Signal's CDN, still encrypted. Each gives null when the CDN has no such file. */
export type PackFiles = {
  manifest(packId: Uint8Array): Promise<Uint8Array | null>;
  sticker(packId: Uint8Array, number: number): Promise<Uint8Array | null>;
};

/** Says whether a converted file shows the same as the Telegram file it was made from. */
export type PictureComparison = {
  sameStill(converted: Uint8Array, original: Uint8Array): Promise<boolean>;
  sameAnimation(converted: Uint8Array, original: Uint8Array, format: 'tgs' | 'webm'): Promise<boolean>;
};

/** How many sticker files are fetched and compared at the same time. */
const CONCURRENT_STICKERS = 6;

function decrypted(file: Uint8Array, packKey: Uint8Array): Uint8Array | null {
  try {
    return decryptStickerFile(file, packKey);
  } catch {
    return null;
  }
}

const sameBytes = (one: Uint8Array, other: Uint8Array) =>
  one.length === other.length && one.every((byte, i) => byte === other[i]);

/** Whether the decrypted manifest is the one this app writes for `original` (upload.ts manifestFor). */
export function manifestMatches(manifest: Uint8Array, original: OriginalPack): boolean {
  let pack;
  try {
    pack = fromBinary(StickerPackSchema, manifest);
  } catch {
    return false;
  }
  // A field this app does not write, such as a content type, counts as a difference.
  const plain = (message: { $unknown?: unknown[] } | undefined) => (message?.$unknown ?? []).length === 0;
  if (!plain(pack) || pack.title !== original.title || pack.author !== '') return false;
  if (pack.stickers.length !== original.stickers.length) return false;
  const stickersMatch = pack.stickers.every(
    (sticker, i) => plain(sticker) && sticker.id === i && sticker.emoji === original.stickers[i].emoji,
  );
  const cover = pack.cover;
  return (
    stickersMatch && cover !== undefined && plain(cover) && cover.id === 0 && cover.emoji === original.stickers[0].emoji
  );
}

/** Whether the file on Signal is what this app would upload for the Telegram sticker, or shows the same. */
async function stickerMatches(
  file: Uint8Array,
  original: OriginalSticker,
  pictures: PictureComparison,
): Promise<boolean> {
  if (original.format === 'webp') {
    // A still picture within Signal's size limit is uploaded as it is.
    if (original.file.length <= MAX_STICKER_BYTES) return sameBytes(file, original.file);
    return pictures.sameStill(file, original.file);
  }
  return isPlainPng(file) && (await pictures.sameAnimation(file, original.file, original.format));
}

/**
 * Whether the Signal pack `packId` is a copy of `original` that this app could have uploaded. A file that Signal
 * does not have, or that does not decrypt under the pack key, is a difference. An error while fetching is thrown:
 * it says nothing about the copy.
 */
export async function isFaithfulCopy(
  packId: Uint8Array,
  packKey: Uint8Array,
  original: OriginalPack,
  files: PackFiles,
  pictures: PictureComparison,
  onProgress: (done: number, total: number) => void = () => undefined,
): Promise<boolean> {
  if (original.stickers.length === 0) return false;
  const encryptedManifest = await files.manifest(packId);
  const manifest = encryptedManifest && decrypted(encryptedManifest, packKey);
  if (!manifest || !manifestMatches(manifest, original)) return false;

  let next = 0;
  let done = 0;
  let different = false;
  const compareNext = async () => {
    while (!different && next < original.stickers.length) {
      const number = next++;
      const encrypted = await files.sticker(packId, number);
      const file = encrypted && decrypted(encrypted, packKey);
      if (!file || !(await stickerMatches(file, original.stickers[number], pictures))) different = true;
      onProgress(++done, original.stickers.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENT_STICKERS }, compareNext));
  return !different;
}
