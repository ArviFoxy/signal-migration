// The linked device when Signal refuses its login, and when it sends after a reload before WASM is loaded
// (signal/connection.ts). Opening the logged-in connection is replaced; everything above it is the app's own code.

import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { SignalConnection } from '../src/signal/connection';
import { OwnDevices } from '../src/signal/own-devices';
import { SignalSession } from '../src/signal/session';
import { HandshakeRefusedError } from '../src/signal/socket';
import { loadSignalWasm } from '../src/signal/wasm';
import { initSync } from '../src/wasm/signal_migration_wasm';

vi.mock('../src/signal/session', () => ({ SignalSession: { open: vi.fn() }, basicAuthorization: () => '' }));
vi.mock('../src/signal/wasm', () => ({
  loadSignalWasm: vi.fn(async () => {
    initSync({ module: readFileSync(new URL('../src/wasm/signal_migration_wasm_bg.wasm', import.meta.url)) });
  }),
}));

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

// Detects: sending a note to self on a restored device after a reload crashing because the Signal WebAssembly module
// has not been loaded yet (nothing else on a saved-messages-only reload loads it first).
it('loads Signal WebAssembly before sending a note to self on a restored device', async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const requests: { verb: string; path: string }[] = [];
  vi.mocked(SignalSession.open).mockResolvedValue({
    onUnexpectedClose: () => undefined,
    async request(verb: string, path: string) {
      requests.push({ verb, path });
      return {
        status: verb === 'GET' ? 404 : 200,
        message: '',
        headers: [],
        body: new Uint8Array(),
      };
    },
    async unlinkSelf() {},
  } as unknown as SignalSession);

  const device = SignalConnection.restore({
    aci: 'simulated-account',
    deviceId: 3,
    password: 'simulated',
    storageServiceKey: new Uint8Array(32).fill(7),
    identityPublic: new Uint8Array([0x05, ...publicRaw]),
    identityPrivate: pkcs8.slice(-32),
    registrationId: 1,
  });

  const freeSpy = vi.spyOn(OwnDevices.prototype, 'free');
  await device.sendNoteToSelf({ timestamp: 1_700_000_000_000, body: 'hello', styles: [] });
  expect(loadSignalWasm).toHaveBeenCalled();
  expect(requests.map((r) => `${r.verb} ${r.path}`)).toEqual([
    'GET /v2/keys/simulated-account/*',
    'PUT /v1/messages/simulated-account',
  ]);

  await device.unlink();
  expect(freeSpy).toHaveBeenCalledTimes(1);
  freeSpy.mockRestore();
});

// Detects: failed unlink() closing the session without clearing #session, so every subsequent retry hits the closed
// socket and fails with SocketClosedError(1000).
it('opens a fresh session on retry after a failed unlink', async () => {
  let opens = 0;
  vi.mocked(SignalSession.open).mockImplementation(async () => {
    const attempt = ++opens;
    let closed = false;
    return {
      onUnexpectedClose: () => undefined,
      async unlinkSelf() {
        try {
          if (closed) throw new Error('socket closed (code 1000)');
          if (attempt === 1) throw new Error('unlink answered 500');
        } finally {
          closed = true;
        }
      },
      close() {
        closed = true;
      },
    } as unknown as SignalSession;
  });

  const device = SignalConnection.restore({
    aci: 'simulated-account',
    deviceId: 3,
    password: 'simulated',
    storageServiceKey: new Uint8Array(32).fill(7),
  });
  await expect(device.unlink()).rejects.toThrow(/500/);
  await expect(device.unlink()).resolves.toBeUndefined();
  expect(opens).toBe(2);
});

// Detects: in-place zeroing of storageServiceKey on device removal allowing an active StorageClient to encrypt a
// manifest write with an all-zero key.
it('refuses StorageClient writes after the device is removed instead of encrypting with a zeroed key', async () => {
  vi.mocked(SignalSession.open).mockResolvedValue({
    onUnexpectedClose: () => undefined,
    async request() {
      return {
        status: 200,
        message: 'OK',
        headers: [],
        body: new TextEncoder().encode(JSON.stringify({ username: 'u', password: 'p' })),
      };
    },
    async unlinkSelf() {},
    close() {},
  } as unknown as SignalSession);

  const device = SignalConnection.restore({
    aci: 'simulated-account',
    deviceId: 3,
    password: 'simulated',
    storageServiceKey: new Uint8Array(32).fill(7),
  });
  let putAttempted = false;
  (device as unknown as { https: unknown }).https = async () => {
    putAttempted = true;
    return { status: 200, header: () => undefined, body: new Uint8Array() };
  };

  const storage = await device.storage();
  await device.unlink();
  await expect(
    storage.addContacts(
      {
        version: 1n,
        manifest: {
          $typeName: 'signalservice.ManifestRecord',
          version: 1n,
          sourceDevice: 1,
          identifiers: [],
          recordIkm: new Uint8Array(32).fill(1),
        },
        contacts: [],
        knownAccounts: [],
      },
      [],
    ),
  ).rejects.toThrow(/unlinked|zero/i);
  expect(putAttempted).toBe(false);
});
