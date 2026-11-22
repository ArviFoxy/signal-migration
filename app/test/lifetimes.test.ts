// Managed lifetimes: retryable lazy loaders (core/lazy.ts), blob object URL pools (ui/object-urls.ts), and socket /
// tunnel teardown guards (signal/socket.ts, signal/tunnel.ts).

import { afterEach, expect, it, vi } from 'vitest';
import { retryableOnce } from '../src/core/lazy';
import { type MessageChannel, openTunnelWebSocket, SignalSocket, SocketClosedError } from '../src/signal/socket';
import { RelayLink } from '../src/signal/tunnel';
import { ObjectUrlPool } from '../src/ui/object-urls';

const tunnelMocks = vi.hoisted(() => ({
  onReceive: null as (() => void) | null,
  tlsSocket: null as {
    isOpen: boolean;
    messages: Uint8Array[];
    freed: boolean;
    usedAfterFree: boolean;
    closed: number;
  } | null,
}));

vi.mock('../src/signal/wasm', () => ({ loadSignalWasm: async () => undefined }));
vi.mock('../src/wasm/signal_migration_wasm', () => ({
  TlsWebSocket: class {
    isOpen = true;
    messages: Uint8Array[] = [];
    freed = false;
    usedAfterFree = false;
    closed = 0;
    refusedStatus = undefined;
    closeReason = '';
    constructor() {
      tunnelMocks.tlsSocket = this;
    }
    get closeCode(): number | undefined {
      if (this.freed) this.usedAfterFree = true;
      return undefined;
    }
    takeMessages(): Uint8Array[] {
      if (this.freed) this.usedAfterFree = true;
      return this.messages.splice(0);
    }
    send(): void {
      if (this.freed) this.usedAfterFree = true;
    }
    close(): void {
      if (this.freed) this.usedAfterFree = true;
      this.closed++;
    }
    free(): void {
      if (this.freed) this.usedAfterFree = true;
      this.freed = true;
    }
    receiveEncrypted(): void {}
    takeEncrypted(): Uint8Array {
      return new Uint8Array();
    }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  tunnelMocks.onReceive = null;
  tunnelMocks.tlsSocket = null;
});

// Detects: a transient failure (such as fetching WebAssembly while offline) permanently poisoning a lazy loader.
it('retries a failed lazy load on the next call, and caches a successful one', async () => {
  let attempts = 0;
  const load = retryableOnce(async () => {
    attempts++;
    if (attempts === 1) throw new Error('network down');
    return 'loaded';
  });

  await expect(load()).rejects.toThrow('network down');
  const [first, second] = await Promise.all([load(), load()]);
  expect(first).toBe('loaded');
  expect(second).toBe('loaded');
  expect(attempts).toBe(2);
});

// Detects: blob object URLs leaking when a view unmounts or switches datasets, or empty entries locking out later loads.
it('caches and revokes blob object URLs per pool without locking out empty results', () => {
  const revoked: string[] = [];
  let next = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => `blob:test/${++next}`,
    revokeObjectURL: (url: string) => revoked.push(url),
  });

  const pool = new ObjectUrlPool<object>();
  const key = {};
  expect(pool.get(key, () => [])).toEqual([]);
  expect(pool.get(key, () => [URL.createObjectURL(new Blob())])).toEqual(['blob:test/1']);
  expect(pool.get(key, () => ['should-not-run'])).toEqual(['blob:test/1']);

  const second = {};
  expect(pool.getOne(second, () => URL.createObjectURL(new Blob()))).toBe('blob:test/2');

  pool.revokeAll();
  expect(revoked).toEqual(['blob:test/1', 'blob:test/2']);
  // After revocation the pool is usable again without returning stale revoked URLs.
  expect(pool.getOne(second, () => URL.createObjectURL(new Blob()))).toBe('blob:test/3');
});

// Detects: closing SignalSocket leaving in-flight requests hanging until their 60 s timeout fires.
it('rejects pending SignalSocket requests immediately on close without calling onUnexpectedClose', async () => {
  const channel: MessageChannel = {
    send: () => undefined,
    close: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
  };
  const socket = new SignalSocket(channel, '/v1/keepalive');
  let unexpected = false;
  socket.onUnexpectedClose = () => (unexpected = true);

  const pending = socket.request('GET', '/v1/devices');
  socket.close();

  await expect(pending).rejects.toThrow(SocketClosedError);
  expect(unexpected).toBe(false);
});

// Detects: RelayLink delivering an event to a freed WebAssembly endpoint after close().
it('detaches WebSocket listeners on RelayLink.close so late messages cannot reach a freed endpoint', () => {
  let receiveCount = 0;
  let flushCount = 0;
  let closeReason: string | null = null;
  let created: FakeWebSocket | null = null;
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 1;
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      created = this;
    }
    send(): void {}
    close(): void {}
  }
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });

  const link = new RelayLink(
    'chat.signal.org',
    {
      receiveEncrypted: () => receiveCount++,
      takeEncrypted: () => {
        flushCount++;
        return new Uint8Array();
      },
    },
    () => undefined,
    (reason) => (closeReason = reason),
  );
  link.close();

  expect(created!.onopen).toBeNull();
  expect(created!.onmessage).toBeNull();
  expect(created!.onclose).toBeNull();
  expect(receiveCount).toBe(0);
  expect(closeReason).toBeNull();
  const flushesAfterClose = flushCount;
  link.flush();
  expect(flushCount).toBe(flushesAfterClose);
});

// Detects: synchronous channel.close() inside onMessage freeing the WASM TlsWebSocket right before onReceive reads
// socket.closeCode (use-after-free), or send() after close() calling into the freed WASM pointer.
it('survives synchronous channel.close() inside onMessage without touching the freed TlsWebSocket', async () => {
  let ws: {
    readyState: number;
    binaryType: string;
    onopen: (() => void) | null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null;
    onclose: (() => void) | null;
    send: () => void;
    close: () => void;
  } | null = null;
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 1;
    binaryType = '';
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      ws = this;
    }
    send(): void {}
    close(): void {}
  }
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });

  const opening = openTunnelWebSocket('chat.signal.org', '/v1/websocket/', []);
  // Wait a microtask for `await loadSignalWasm()` before triggering the WebSocket event.
  await Promise.resolve();
  ws!.onmessage!({ data: new ArrayBuffer(0) });
  const channel = await opening;

  let received = 0;
  channel.onMessage = () => {
    received++;
    channel.close();
  };
  tunnelMocks.tlsSocket!.messages.push(new Uint8Array([1]), new Uint8Array([2]));
  ws!.onmessage!({ data: new ArrayBuffer(0) });

  expect(received).toBe(1);
  expect(tunnelMocks.tlsSocket!.freed).toBe(true);
  expect(tunnelMocks.tlsSocket!.usedAfterFree).toBe(false);
  expect(() => channel.send(new Uint8Array([3]))).toThrow(SocketClosedError);
  expect(tunnelMocks.tlsSocket!.usedAfterFree).toBe(false);
});
