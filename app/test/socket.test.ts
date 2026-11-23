// Low-level Signal transport tests: RelayLink, httpsRequest WASM lifetime, and SignalSocket framing/keepalive/timers.

import { create, toBinary } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WebSocketMessage_Type,
  WebSocketMessageSchema,
  WebSocketRequestMessageSchema,
} from '../src/gen/chat_websocket_pb';
import { REQUEST_TIME_LIMIT_S } from '../src/core/time-limit';
import { httpsRequest } from '../src/signal/http-client';
import { type MessageChannel, SignalSocket, SocketClosedError } from '../src/signal/socket';
import { RelayLink } from '../src/signal/tunnel';
import { TlsHttpRequest } from '../src/wasm/signal_migration_wasm';
import './wasm';

vi.mock('../src/signal/wasm', () => ({ loadSignalWasm: vi.fn(async () => undefined) }));

function fakeChannel() {
  let onMessage: MessageChannel['onMessage'] | null = null;
  let onClose: MessageChannel['onClose'] | null = null;
  const early: Uint8Array[] = [];
  let earlyClose: [number, string] | null = null;
  const sent: Uint8Array[] = [];
  let closed = false;
  let throwOnSend = false;

  const channel: MessageChannel = {
    send(bytes) {
      if (throwOnSend || closed) throw new SocketClosedError(1000);
      sent.push(bytes);
    },
    close() {
      closed = true;
    },
    get onMessage() {
      return onMessage ?? (() => undefined);
    },
    set onMessage(handler) {
      onMessage = handler;
      for (const msg of early.splice(0)) handler(msg);
    },
    get onClose() {
      return onClose ?? (() => undefined);
    },
    set onClose(handler) {
      onClose = handler;
      if (earlyClose) {
        const args = earlyClose;
        earlyClose = null;
        handler(...args);
      }
    },
  };

  return {
    channel,
    sent,
    isClosed: () => closed,
    setThrowOnSend: (v: boolean) => (throwOnSend = v),
    pushMessage(bytes: Uint8Array) {
      if (onMessage) onMessage(bytes);
      else early.push(bytes);
    },
    pushClose(code: number, reason = '') {
      closed = true;
      if (onClose) onClose(code, reason);
      else earlyClose = [code, reason];
    },
  };
}

describe('RelayLink and httpsRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Detects: RelayLink.flush() draining outgoing TLS ciphertext from WASM while WebSocket is still CONNECTING.
  it('does not drain outgoing ciphertext while the WebSocket is still connecting', () => {
    let drained = 0;
    class StubWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      readyState = StubWebSocket.CONNECTING;
      binaryType = '';
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
      onclose: (() => void) | null = null;
      sent: Uint8Array[] = [];
      send(data: Uint8Array) {
        this.sent.push(data);
      }
      close() {}
    }
    vi.stubGlobal('WebSocket', StubWebSocket);
    vi.stubGlobal('location', { protocol: 'https:', host: 'app.example', href: 'https://app.example/' });

    const link = new RelayLink(
      'cdn.signal.org',
      {
        receiveEncrypted: () => undefined,
        takeEncrypted: () => {
          drained++;
          return new Uint8Array([1, 2, 3]);
        },
      },
      () => undefined,
      () => undefined,
    );
    link.flush();
    expect(drained).toBe(0);
    link.close();
  });

  // Detects: httpsRequest freeing the WASM TlsHttpRequest before calling link.close(), which triggers a WASM UAF
  // (`takeEncrypted` on freed pointer) on every single completed HTTPS request.
  it('closes the relay link before freeing TlsHttpRequest on a completed response', async () => {
    let instance!: StubWebSocket;
    class StubWebSocket {
      static readonly OPEN = 1;
      readyState = StubWebSocket.OPEN;
      binaryType = '';
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        instance = this;
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', StubWebSocket);
    vi.stubGlobal('location', { protocol: 'https:', host: 'app.example', href: 'https://app.example/' });

    let freed = false;
    let takeEncryptedAfterFree = false;
    let complete = false;
    vi.spyOn(TlsHttpRequest.prototype, 'receiveEncrypted').mockImplementation(() => {
      complete = true;
    });
    vi.spyOn(TlsHttpRequest.prototype, 'takeEncrypted').mockImplementation(() => {
      if (freed) takeEncryptedAfterFree = true;
      return new Uint8Array(0);
    });
    vi.spyOn(TlsHttpRequest.prototype, 'isComplete', 'get').mockImplementation(() => complete);
    vi.spyOn(TlsHttpRequest.prototype, 'status', 'get').mockReturnValue(200);
    vi.spyOn(TlsHttpRequest.prototype, 'rawHeaders').mockReturnValue([]);
    vi.spyOn(TlsHttpRequest.prototype, 'body').mockReturnValue(new Uint8Array([42]));
    const origFree = TlsHttpRequest.prototype.free;
    vi.spyOn(TlsHttpRequest.prototype, 'free').mockImplementation(function (this: TlsHttpRequest) {
      freed = true;
      origFree.call(this);
    });

    const promise = httpsRequest('cdn.signal.org', 'GET', '/test');
    await Promise.resolve();
    await Promise.resolve();
    instance.onmessage?.({ data: new Uint8Array([1]).buffer });
    const response = await promise;
    expect(response.status).toBe(200);
    expect(takeEncryptedAfterFree).toBe(false);
  });
});

describe('SignalSocket', () => {
  afterEach(() => vi.useRealTimers());

  // Detects: SignalSocket draining early server-first requests (e.g. PUT /v1/address) into the default handler
  // before the caller assigns onServerRequest.
  it('delivers an early server request to onServerRequest instead of dropping it', () => {
    vi.useFakeTimers();
    const fake = fakeChannel();
    const requestMsg = toBinary(
      WebSocketMessageSchema,
      create(WebSocketMessageSchema, {
        type: WebSocketMessage_Type.REQUEST,
        request: create(WebSocketRequestMessageSchema, {
          id: 1n,
          verb: 'PUT',
          path: '/v1/address',
          body: new Uint8Array([1, 2, 3]),
        }),
      }),
    );
    fake.pushMessage(requestMsg);

    const seen: string[] = [];
    const socket = new SignalSocket(fake.channel, '/v1/keepalive/provisioning');
    socket.onServerRequest = (req) => {
      seen.push(req.path);
      return 200;
    };
    expect(seen).toEqual(['/v1/address']);
    socket.close();
  });

  // Detects: early close arriving before onUnexpectedClose is assigned (losing 4401) and leaking keepalive interval.
  it('delivers an early close code to onUnexpectedClose and does not start keepalives on a closed channel', async () => {
    vi.useFakeTimers();
    const fake = fakeChannel();
    fake.pushClose(4401, 'removed');

    const codes: number[] = [];
    const socket = new SignalSocket(fake.channel, '/v1/keepalive');
    socket.onUnexpectedClose = (code) => codes.push(code);

    expect(codes).toEqual([4401]);
    expect(vi.getTimerCount()).toBe(0);
    socket.close();
  });

  // Detects: a half-open dead socket never being torn down when keepalive times out, wedging SignalConnection.
  it('closes the socket and notifies onUnexpectedClose when a keepalive times out', async () => {
    vi.useFakeTimers();
    const fake = fakeChannel();
    const codes: number[] = [];
    const socket = new SignalSocket(fake.channel, '/v1/keepalive');
    socket.onUnexpectedClose = (code) => codes.push(code);

    await vi.advanceTimersByTimeAsync(30_000 + REQUEST_TIME_LIMIT_S * 1000 + 100);
    expect(fake.isClosed()).toBe(true);
    expect(codes).toEqual([1006]);
    socket.close();
  });

  // Detects: leaking a 60s request timeout when channel.send() throws synchronously.
  it('clears the request timer when channel.send() throws synchronously', async () => {
    vi.useFakeTimers();
    const fake = fakeChannel();
    const socket = new SignalSocket(fake.channel, '/v1/keepalive');
    fake.setThrowOnSend(true);

    const timersBefore = vi.getTimerCount();
    await expect(socket.request('GET', '/v1/test')).rejects.toThrow(SocketClosedError);
    expect(vi.getTimerCount()).toBe(timersBefore);
    socket.close();
  });
});
