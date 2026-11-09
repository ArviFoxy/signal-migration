// Which key the linking message gives for the storage service (signal/link.ts storageServiceKeyOf). The expected
// keys come from outside this project: a known answer from Signal's clients, and libsignal's derivation recomputed
// here with WebCrypto.

import { describe, expect, it } from 'vitest';
import { storageServiceKeyOf } from '../src/signal/link';
import './wasm';

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * libsignal account-keys (lib.rs): the SVR key ("master key") is HKDF-SHA256 of the 64-character pool with no salt
 * and info "20240801_SIGNAL_SVR_MASTER_KEY"; the storage service key is HMAC-SHA256(SVR key, "Storage Service
 * Encryption").
 */
async function storageKeyFromPool(pool: string): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey('raw', utf8(pool), 'HKDF', false, ['deriveBits']);
  const svrKey = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('20240801_SIGNAL_SVR_MASTER_KEY') },
    ikm,
    256,
  );
  const hmacKey = await crypto.subtle.importKey('raw', svrKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, utf8('Storage Service Encryption')));
}

describe('the storage service key from the linking message', () => {
  // Detects: reading the master key, which current phones leave empty (Signal-Android LinkDeviceApi.kt), instead of
  // the account entropy pool they send.
  it('comes from the account entropy pool when the phone sends one', async () => {
    const pool = 'a1b2c3d4e5f6g7h8i9j0klmnopqrstuvwxyz0123456789abcdefghijklmnopqr';
    const key = storageServiceKeyOf({ accountEntropyPool: pool, masterKey: new Uint8Array(0) });
    expect(key).toEqual(await storageKeyFromPool(pool));
  });

  // Detects: no longer supporting phones that send only the master key. Known answer from Signal-iOS
  // MasterKeyTest.testDerivedKeys, as quoted in libsignal account-keys lib.rs.
  it('comes from the master key when the phone sends only that', () => {
    const key = storageServiceKeyOf({ accountEntropyPool: '', masterKey: new Uint8Array(32).fill(0x2a) });
    expect(key).toEqual(bytes('3f31b618172a9f8ad45e290788e6176736e6161d4ea0e8050f8553521f59c200'));
  });

  // Detects: linking going ahead without a key to read Signal's sticker packs.
  it('is refused when the phone sends neither', () => {
    expect(() => storageServiceKeyOf({ accountEntropyPool: '', masterKey: new Uint8Array(0) })).toThrow();
  });
});
