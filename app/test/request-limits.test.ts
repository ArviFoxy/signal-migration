// The time limits on requests to Signal (signal/socket.ts, signal/http-client.ts) and to the migration server
// (core/time-limit.ts). The WebAssembly TLS objects and the relay are replaced by ones that never get an answer, so
// that only the limits can end the wait. The texts are the approved ones.

import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithTimeLimit } from '../src/core/time-limit';
import { httpsRequest } from '../src/signal/http-client';
import { type MessageChannel, openTunnelWebSocket, SignalSocket } from '../src/signal/socket';

const relay = vi.hoisted(() => ({ closed: 0, freed: 0 }));

vi.mock('../src/signal/wasm', () => ({ loadSignalWasm: async () => undefined }));
vi.mock('../src/signal/tunnel', () => ({
  RelayLink: class {
    flush(): void {}
    close(): void {
      relay.closed++;
    }
  },
}));
vi.mock('../src/wasm/signal_migration_wasm', () => {
  /** A TLS connection whose server never answers. */
  class Silent {
    isOpen = false;
    isComplete = false;
    refusedStatus = undefined;
    closeCode = undefined;
    free(): void {
      relay.freed++;
    }
    takeMessages(): Uint8Array[] {
      return [];
    }
  }
  return { TlsWebSocket: Silent, TlsHttpRequest: Silent };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.assign(relay, { closed: 0, freed: 0 });
});

/** The message `work` fails with once `ms` have passed, or null if it has not failed by then. */
async function failureAfter(work: Promise<unknown>, ms: number): Promise<string | null> {
  let failure: string | null = null;
  work.catch((error: Error) => (failure = error.message));
  await vi.advanceTimersByTimeAsync(ms);
  return failure;
}

// Detects: a Signal request that is never answered keeping the migration waiting forever (an upload, an install,
// the unlink at the end).
it('fails a Signal request that gets no answer within 60 seconds', async () => {
  vi.useFakeTimers();
  const channel: MessageChannel = {
    send: () => undefined,
    close: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
  };
  const socket = new SignalSocket(channel, '/v1/keepalive');
  const request = socket.request('GET', '/v1/devices');
  expect(await failureAfter(request, 59_000)).toBeNull();
  expect(await failureAfter(request, 1_000)).toBe('Signal did not answer within 60 seconds.');
  socket.close();
});

// Detects: a connection to Signal that never opens keeping the QR code or a step waiting forever, and its relay
// left open.
it('gives up opening a Signal socket after 60 seconds, and closes the relay', async () => {
  vi.useFakeTimers();
  const opening = openTunnelWebSocket('chat.signal.org', '/v1/websocket/', []);
  expect(await failureAfter(opening, 60_000)).toBe('Signal did not answer within 60 seconds.');
  expect(relay.closed).toBe(1);
  expect(relay.freed).toBe(1);
});

// Detects: an HTTPS request to Signal (an upload to its CDN, a storage read) waiting forever.
it('gives up an HTTPS request to Signal after 60 seconds, and closes the relay', async () => {
  vi.useFakeTimers();
  const request = httpsRequest('storage.signal.org', 'GET', '/v1/storage/manifest');
  expect(await failureAfter(request, 60_000)).toBe('Signal did not answer within 60 seconds.');
  expect(relay.closed).toBe(1);
});

// Detects: a request to the migration server (the index, the configuration) waiting forever, and the request left
// running.
it('gives up a request to the migration server after 30 seconds, and stops it', async () => {
  vi.useFakeTimers();
  let aborted = false;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    init.signal?.addEventListener('abort', () => (aborted = true));
    return new Promise(() => undefined);
  });
  const request = fetchWithTimeLimit('The migration server', 30, '/v1/sticker-packs/index?from=0');
  expect(await failureAfter(request, 30_000)).toBe('The migration server did not answer within 30 seconds.');
  expect(aborted).toBe(true);
});
