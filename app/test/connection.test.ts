// The linked device when Signal refuses its login (signal/connection.ts). Opening the logged-in connection is
// replaced, so that the server can refuse it; everything above it is the app's own code.

import { expect, it, vi } from 'vitest';
import { SignalConnection } from '../src/signal/connection';
import { SignalSession } from '../src/signal/session';
import { HandshakeRefusedError } from '../src/signal/socket';
import './wasm';

vi.mock('../src/signal/session', () => ({ SignalSession: { open: vi.fn() }, basicAuthorization: () => '' }));

/** A device as the browser keeps it, with Signal answering its login with `status` at the WebSocket upgrade. */
function deviceRefusedWith(status: number): SignalConnection {
  vi.mocked(SignalSession.open).mockImplementation(async () => {
    throw new HandshakeRefusedError('chat.signal.org', '/v1/websocket/', status);
  });
  return SignalConnection.restore({
    aci: 'simulated-account',
    deviceId: 3,
    password: 'simulated',
    storageServiceKey: new Uint8Array(32).fill(7),
    identityPublic: new Uint8Array(33).fill(5),
    identityPrivate: new Uint8Array(32).fill(9),
    registrationId: 1,
  });
}

// Detects: a device removed while the page was closed (Signal then refuses its login with 403) that can never be
// unlinked, so that "Finish" and "Disconnect and clear" fail and its keys stay in the browser.
it('counts a device whose login is refused as unknown as unlinked', async () => {
  const device = deviceRefusedWith(403);
  let told = false;
  device.onUnlinked = () => (told = true);
  await device.unlink();
  expect(device.isLinked).toBe(false);
  expect(told).toBe(true);
  expect(device.stored.storageServiceKey.every((byte) => byte === 0)).toBe(true);
  expect(device.stored.identityPrivate!.every((byte) => byte === 0)).toBe(true);
});

// Detects: any failed login taken for a removed device, so that a device still linked is forgotten and can no
// longer be unlinked.
it('keeps a device linked when its login fails for another reason', async () => {
  const device = deviceRefusedWith(500);
  await expect(device.unlink()).rejects.toThrow(HandshakeRefusedError);
  expect(device.isLinked).toBe(true);
});
