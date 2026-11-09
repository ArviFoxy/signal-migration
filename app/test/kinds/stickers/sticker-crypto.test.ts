// Sticker pack file encryption (libsignal crates in WebAssembly), checked against a real Signal pack.

import '../../wasm';
import { fromBinary } from '@bufbuild/protobuf';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StickerPackSchema } from '../../../src/gen/Stickers_pb';
import { decryptStickerFile, encryptStickerFile } from '../../../src/wasm/signal_migration_wasm';

// Signal's own public "Bandit the Cat" pack: manifest from cdn-ca.signal.org/stickers/9acc9e8aba563d26a4994e69263e3b25.
const banditManifest = new Uint8Array(readFileSync(new URL('../../fixtures/bandit-manifest.bin', import.meta.url)));
const banditKey = Buffer.from('5a6dff3948c28efb9b7aaf93ecc375c69fc316e78077ed26867a14d10a0f6a12', 'hex');

describe('sticker pack files', () => {
  // Detects: a key derivation or file layout that differs from what Signal's clients upload.
  it('decrypts a real pack manifest uploaded by Signal', () => {
    const pack = fromBinary(StickerPackSchema, decryptStickerFile(banditManifest, banditKey));
    expect({ title: pack.title, author: pack.author, stickers: pack.stickers.length }).toEqual({
      title: 'Bandit the Cat',
      author: 'Agnes Lee',
      stickers: 24,
    });
  });

  // Detects: uploads that the same scheme cannot read back.
  it('decrypts what it encrypts', () => {
    const data = new TextEncoder().encode('a sticker');
    expect(new TextDecoder().decode(decryptStickerFile(encryptStickerFile(data, banditKey), banditKey))).toBe(
      'a sticker',
    );
  });

  // Detects: accepting a file with a wrong pack key or altered bytes (index entries are verified this way).
  it('rejects a wrong pack key and an altered file', () => {
    const wrongKey = new Uint8Array(32).fill(1);
    expect(() => decryptStickerFile(banditManifest, wrongKey)).toThrow();
    const altered = banditManifest.slice();
    altered[30] ^= 1;
    expect(() => decryptStickerFile(altered, banditKey)).toThrow();
  });
});
