import { fromBinary } from '@bufbuild/protobuf';
import { StickerPackSchema } from './gen/Stickers_pb';

/** The sticker CDN host with a publicly trusted certificate and open CORS. */
const STICKER_CDN = 'https://cdn-ca.signal.org';

export type StickerPackManifest = { title: string; author: string; stickerCount: number; encryptedBytes: number };

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('not a hex string');
  return new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
}

async function stickerKeys(packKey: Uint8Array<ArrayBuffer>): Promise<{ aesKey: CryptoKey; macKey: CryptoKey }> {
  const inputKey = await crypto.subtle.importKey('raw', packKey, 'HKDF', false, ['deriveBits']);
  // Signal's clients call HKDF without a salt, which RFC 5869 defines as 32 zero bytes for SHA-256.
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('Sticker Pack') },
      inputKey,
      512,
    ),
  );
  // The first 32 derived bytes are the AES-256 key, the last 32 the HMAC-SHA256 key.
  const aesKey = await crypto.subtle.importKey('raw', derived.slice(0, 32), 'AES-CBC', false, ['decrypt']);
  const macKey = await crypto.subtle.importKey('raw', derived.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return { aesKey, macKey };
}

/** Verifies and decrypts one encrypted sticker file: 16-byte IV, AES-256-CBC ciphertext, 32-byte HMAC over IV and ciphertext. */
export async function decryptStickerFile(data: Uint8Array<ArrayBuffer>, packKey: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (data.length < 16 + 16 + 32) throw new Error('file is shorter than the encryption overhead');
  const { aesKey, macKey } = await stickerKeys(packKey);
  const macStart = data.length - 32;
  const authentic = await crypto.subtle.verify('HMAC', macKey, data.subarray(macStart), data.subarray(0, macStart));
  if (!authentic) throw new Error('HMAC mismatch: wrong pack key or corrupted file');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: data.subarray(0, 16) }, aesKey, data.subarray(16, macStart)));
}

/** Downloads, verifies and decrypts a pack's manifest. */
export async function fetchManifest(packIdHex: string, packKeyHex: string): Promise<StickerPackManifest> {
  const response = await fetch(`${STICKER_CDN}/stickers/${packIdHex}/manifest.proto`);
  if (!response.ok) throw new Error(`CDN answered ${response.status}`);
  const encrypted = new Uint8Array(await response.arrayBuffer());
  const pack = fromBinary(StickerPackSchema, await decryptStickerFile(encrypted, hexToBytes(packKeyHex)));
  return { title: pack.title, author: pack.author, stickerCount: pack.stickers.length, encryptedBytes: encrypted.length };
}
