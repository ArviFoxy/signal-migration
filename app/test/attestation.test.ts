// libsignal's check of an enclave's attestation, as built for the browser with BoringSSL (crates/attestation-wasm).
// It is run against the attestations that libsignal's own tests come with, so that a build which links but cannot
// verify, or which accepts what it must refuse, fails here.
//
// `cdsi.*` is a genuine attestation of Signal's contact discovery enclave in its staging environment, recorded with
// the time of the recording. `cds2_test.*` is that of a test enclave whose security data is outdated on purpose.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { contactDiscoveryEnclaveId, EnclaveHandshake, initSync } from '../src/wasm/attestation_wasm';

const module = readFileSync(new URL('../src/wasm/attestation_wasm_bg.wasm', import.meta.url));
const recorded = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../third_party/libsignal/rust/attest/tests/data/${name}`, import.meta.url)));

const enclaveId = recorded('cdsi.mrenclave');
const attestation = recorded('cdsi.handshakestart');
// The file holds the time of the recording as seconds since 1970, in 8 bytes.
const recordedAt = Number(new DataView(recorded('cdsi.timestamp').buffer).getBigUint64(0));
const TWO_YEARS = 2 * 365 * 24 * 3600;

const withBitChanged = (bytes: Uint8Array, position: number) => {
  const changed = bytes.slice();
  changed[position]! ^= 1 << (position % 8);
  return changed;
};

/** One field of a protocol buffer message that holds bytes: its number, its length, the bytes. */
function bytesField(number: number, bytes: Uint8Array): number[] {
  const length: number[] = [];
  let rest = bytes.length;
  for (; rest >= 0x80; rest >>>= 7) length.push((rest & 0x7f) | 0x80);
  return [(number << 3) | 2, ...length, rest, ...bytes];
}

beforeAll(() => {
  initSync({ module });
});

describe('the attestation check in the browser build', () => {
  it('accepts the recorded attestation at the time of the recording', () => {
    const handshake = EnclaveHandshake.forContactDiscovery(enclaveId, attestation, recordedAt);
    expect(handshake.initialRequest().length).toBeGreaterThan(0);
  });

  it('refuses it two years later, when its certificates have run out', () => {
    expect(() => EnclaveHandshake.forContactDiscovery(enclaveId, attestation, recordedAt + TWO_YEARS)).toThrow(
      /attestation is not valid for/,
    );
  });

  it('refuses it when one bit of it is changed, wherever the bit is', () => {
    const positions = Array.from({ length: 100 }, (_, index) => Math.floor((index * attestation.length) / 100));
    const accepted = positions.filter((position) => {
      try {
        EnclaveHandshake.forContactDiscovery(enclaveId, withBitChanged(attestation, position), recordedAt);
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted).toEqual([]);
  });

  // The app asks for the production enclave by this ID, and the recorded attestation is of other enclave code.
  it('refuses a genuine attestation of other enclave code than the code asked for', () => {
    expect(() => EnclaveHandshake.forContactDiscovery(contactDiscoveryEnclaveId(), attestation, recordedAt)).toThrow(
      /expected mrenclave/,
    );
  });

  // For an ID that libsignal does not know, it accepts none of the processor's security advisories, and the recorded
  // attestation carries one that is accepted for Signal's enclaves alone. So the check ends there, before the IDs
  // are compared.
  it('refuses it for an ID that names no enclave of Signal', () => {
    expect(() => EnclaveHandshake.forContactDiscovery(withBitChanged(enclaveId, 0), attestation, recordedAt)).toThrow(
      /unaccepted advisory/,
    );
  });
});

// libsignal has a switch, for its tests alone, that makes the check accept outdated security data. A module built
// with it would accept enclaves that Signal's apps refuse.
describe("libsignal's test switch", () => {
  // libsignal puts this text into every build that has the switch on, so that it can be looked for.
  it('is off in the module the app ships', () => {
    expect(module.includes('ATTEST TEST-UTIL IS ENABLED')).toBe(false);
  });

  // The module's own tests (crates/attestation-wasm) run with the switch on and accept this attestation at this time.
  it('is off: the attestation of the test enclave, which only a build with the switch accepts, is refused', () => {
    const testEnclaveId = Uint8Array.from(Buffer.from(Buffer.from(recorded('cds2_test.mrenclave')).toString(), 'hex'));
    const message = Uint8Array.from([
      ...bytesField(1, new Uint8Array(32)),
      ...bytesField(2, recorded('cds2_test.evidence')),
      ...bytesField(3, recorded('cds2_test.endorsements')),
    ]);
    expect(() => EnclaveHandshake.forContactDiscovery(testEnclaveId, message, 1655857680)).toThrow(
      /attestation is not valid for/,
    );
  });
});
