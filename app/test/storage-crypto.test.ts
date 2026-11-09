// Storage service key derivation and encryption (libsignal crates in WebAssembly), checked against an independent
// computation with Node's crypto module.

import './wasm';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptStorageBlob,
  encryptStorageBlob,
  storageManifestKey,
  storageRecordKey,
  storageServiceKeyFromMasterKey,
} from '../src/wasm/signal_migration_wasm';

const masterKey = new Uint8Array(32).map((_, i) => i);
const recordId = new Uint8Array(16).map((_, i) => 200 - i);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('storage service keys (Signal Desktop and Android derivations)', () => {
  // Detects: a wrong label or HMAC direction, which would make every record unreadable.
  it('derives the storage service key as HMAC-SHA256(master key, "Storage Service Encryption")', () => {
    const expected = createHmac('sha256', masterKey).update('Storage Service Encryption').digest('hex');
    expect(hex(storageServiceKeyFromMasterKey(masterKey))).toBe(expected);
  });

  // Detects: formatting the version wrongly in the manifest key label.
  it('derives the manifest key from the decimal version', () => {
    const storageKey = storageServiceKeyFromMasterKey(masterKey);
    expect(hex(storageManifestKey(storageKey, 42n))).toBe(
      createHmac('sha256', storageKey).update('Manifest_42').digest('hex'),
    );
  });

  // Detects: a wrong HKDF salt or info layout when the manifest carries a recordIkm.
  it('derives record keys with HKDF over recordIkm and the record id', () => {
    const storageKey = storageServiceKeyFromMasterKey(masterKey);
    const recordIkm = new Uint8Array(32).fill(7);
    const info = Buffer.concat([Buffer.from('20240801_SIGNAL_STORAGE_SERVICE_ITEM_'), recordId]);
    const expected = Buffer.from(hkdfSync('sha256', recordIkm, Buffer.alloc(0), info, 32)).toString('hex');
    expect(hex(storageRecordKey(storageKey, recordIkm, recordId))).toBe(expected);
  });

  // Detects: the legacy derivation using unpadded or URL-safe base64, which Signal does not use.
  it('derives record keys from "Item_<padded base64 id>" without a recordIkm', () => {
    const storageKey = storageServiceKeyFromMasterKey(masterKey);
    const expected = createHmac('sha256', storageKey)
      .update(`Item_${Buffer.from(recordId).toString('base64')}`)
      .digest('hex');
    expect(hex(storageRecordKey(storageKey, new Uint8Array(0), recordId))).toBe(expected);
  });
});

describe('storage blob encryption (12-byte nonce || AES-256-GCM ciphertext || tag)', () => {
  const key = new Uint8Array(32).fill(3);
  const plaintext = new TextEncoder().encode('installed sticker pack record');

  // Detects: a layout other clients cannot decrypt (nonce position, tag placement).
  it('produces blobs another AES-GCM implementation decrypts', () => {
    const blob = Buffer.from(encryptStorageBlob(key, plaintext));
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    expect(Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]).toString()).toBe(
      'installed sticker pack record',
    );
  });

  // Detects: failing to read records written by other clients, or accepting altered ones.
  it('decrypts blobs another AES-GCM implementation produced, and rejects altered ones', () => {
    const iv = Buffer.alloc(12, 9);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const blob = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    expect(new TextDecoder().decode(decryptStorageBlob(key, blob))).toBe('installed sticker pack record');
    blob[20] ^= 1;
    expect(() => decryptStorageBlob(key, blob)).toThrow();
  });
});
