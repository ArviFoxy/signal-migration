// Storage service key derivation and encryption, checked against an independent computation with Node's crypto
// module (a separate implementation of HMAC, HKDF and AES-GCM from the WebCrypto code under test).

import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptBlob, deriveManifestKey, deriveRecordKey, deriveStorageServiceKey, encryptBlob } from '../src/signal/storage';

const masterKey = new Uint8Array(32).map((_, i) => i);
const recordId = new Uint8Array(16).map((_, i) => 200 - i);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('storage service keys (Signal Desktop and Android derivations)', () => {
  // Detects: a wrong label or HMAC direction, which would make every record unreadable.
  it('derives the storage service key as HMAC-SHA256(master key, "Storage Service Encryption")', async () => {
    const expected = createHmac('sha256', masterKey).update('Storage Service Encryption').digest('hex');
    expect(hex(await deriveStorageServiceKey(masterKey))).toBe(expected);
  });

  // Detects: formatting the version wrongly (for example with a BigInt "n" suffix) in the manifest key label.
  it('derives the manifest key from the decimal version', async () => {
    const storageKey = await deriveStorageServiceKey(masterKey);
    const expected = createHmac('sha256', storageKey).update('Manifest_42').digest('hex');
    expect(hex(await deriveManifestKey(storageKey, 42n))).toBe(expected);
  });

  // Detects: a wrong HKDF salt or info layout when the manifest carries a recordIkm.
  it('derives record keys with HKDF over recordIkm and the record id', async () => {
    const storageKey = await deriveStorageServiceKey(masterKey);
    const recordIkm = new Uint8Array(32).fill(7);
    const info = Buffer.concat([Buffer.from('20240801_SIGNAL_STORAGE_SERVICE_ITEM_'), recordId]);
    const expected = Buffer.from(hkdfSync('sha256', recordIkm, Buffer.alloc(0), info, 32)).toString('hex');
    expect(hex(await deriveRecordKey(storageKey, recordIkm, recordId))).toBe(expected);
  });

  // Detects: the legacy derivation using unpadded or URL-safe base64, which Signal does not use.
  it('derives record keys from "Item_<padded base64 id>" without a recordIkm', async () => {
    const storageKey = await deriveStorageServiceKey(masterKey);
    const expected = createHmac('sha256', storageKey).update(`Item_${Buffer.from(recordId).toString('base64')}`).digest('hex');
    expect(hex(await deriveRecordKey(storageKey, undefined, recordId))).toBe(expected);
  });
});

describe('storage blob encryption (12-byte IV || AES-256-GCM ciphertext and tag)', () => {
  const key = new Uint8Array(32).fill(3);
  const plaintext = new TextEncoder().encode('installed sticker pack record');

  // Detects: a layout other clients cannot decrypt (IV position, tag placement).
  it('produces blobs another AES-GCM implementation decrypts', async () => {
    const blob = Buffer.from(await encryptBlob(key, plaintext));
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    const decrypted = Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
    expect(decrypted.toString()).toBe('installed sticker pack record');
  });

  // Detects: failing to read records written by other clients.
  it('decrypts blobs another AES-GCM implementation produced', async () => {
    const iv = Buffer.alloc(12, 9);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const blob = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    expect(new TextDecoder().decode(await decryptBlob(key, blob))).toBe('installed sticker pack record');
  });
});
