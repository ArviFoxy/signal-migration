// libsignal's check of an enclave's attestation, as built for the browser with BoringSSL (crates/attestation-wasm).
// It is run against the attestation of a contact discovery enclave that libsignal's own tests record, so that a
// build which links but cannot verify, or which accepts what it must refuse, fails here.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { EnclaveHandshake, initSync } from '../src/wasm/attestation_wasm';

const recorded = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../third_party/libsignal/rust/attest/tests/data/${name}`, import.meta.url)));

const enclaveId = recorded('cdsi.mrenclave');
const attestation = recorded('cdsi.handshakestart');
// The file holds the time of the recording as seconds since 1970, in 8 bytes.
const recordedAt = Number(new DataView(recorded('cdsi.timestamp').buffer).getBigUint64(0));
const TWO_YEARS = 2 * 365 * 24 * 3600;

const withOneBitChanged = (bytes: Uint8Array) => {
  const changed = bytes.slice();
  changed[changed.length >> 1]! ^= 1;
  return changed;
};

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../src/wasm/attestation_wasm_bg.wasm', import.meta.url)) });
});

describe('the attestation check in the browser build', () => {
  it('accepts the recorded attestation at the time of the recording', () => {
    const handshake = EnclaveHandshake.forContactDiscovery(enclaveId, attestation, recordedAt);
    expect(handshake.initialRequest().length).toBeGreaterThan(0);
  });

  it('refuses it two years later, when its certificates have run out', () => {
    expect(() => EnclaveHandshake.forContactDiscovery(enclaveId, attestation, recordedAt + TWO_YEARS)).toThrow();
  });

  it('refuses it when one bit of it is changed', () => {
    expect(() => EnclaveHandshake.forContactDiscovery(enclaveId, withOneBitChanged(attestation), recordedAt)).toThrow();
  });

  it('refuses it for the ID of other enclave code', () => {
    expect(() => EnclaveHandshake.forContactDiscovery(withOneBitChanged(enclaveId), attestation, recordedAt)).toThrow();
  });
});
