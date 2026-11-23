// Signal's chat WebSocket protocol: request/response messages in both directions, matched by id, over a
// WebSocket (tungstenite) inside the page's own TLS session (rustls), carried through our relay.

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  type WebSocketRequestMessage,
  type WebSocketResponseMessage,
  WebSocketMessage_Type,
  WebSocketMessageSchema,
  WebSocketRequestMessageSchema,
  WebSocketResponseMessageSchema,
} from '../gen/chat_websocket_pb';
import { NoAnswerError, REQUEST_TIME_LIMIT_S } from '../core/time-limit';
import { TlsWebSocket } from '../wasm/signal_migration_wasm';
import { RelayLink } from './tunnel';
import { loadSignalWasm } from './wasm';

export const CHAT_HOST = 'chat.signal.org';

/**
 * A binary message channel. A message or a close that arrives before its handler is set is kept and handed to the
 * handler when it is set, so a server that speaks first is heard.
 */
export interface MessageChannel {
  send(bytes: Uint8Array): void;
  close(code?: number): void;
  onMessage: (bytes: Uint8Array) => void;
  /** `reason` is the text the server sent with its close code, or says what broke the connection. */
  onClose: (code: number, reason: string) => void;
}

/** The server answered the WebSocket upgrade with an HTTP error instead of opening the connection. */
export class HandshakeRefusedError extends Error {
  constructor(
    host: string,
    path: string,
    readonly status: number,
  ) {
    super(`${host} refused the WebSocket to ${path} with HTTP ${status}`);
  }
}

/**
 * Opens a WebSocket to `host`'s `path` with extra handshake `headers` ("Name: value"), through the relay. Gives up
 * with a NoAnswerError when it has not opened within the request time limit.
 */
export async function openTunnelWebSocket(host: string, path: string, headers: string[]): Promise<MessageChannel> {
  await loadSignalWasm();
  const socket = new TlsWebSocket(host, path, headers);
  return new Promise((resolve, reject) => {
    let opened = false;
    let closed = false;
    let onMessage: MessageChannel['onMessage'] | null = null;
    let onClose: MessageChannel['onClose'] | null = null;
    const early: Uint8Array[] = [];
    let earlyClose: [number, string] | null = null;
    let link: RelayLink | null = null;
    let openTimer: ReturnType<typeof setTimeout> | undefined;

    const channel: MessageChannel = {
      send: (bytes) => {
        if (closed) throw new SocketClosedError(1000);
        socket.send(bytes);
        link?.flush();
      },
      close: (code = 1000) => {
        if (closed) return;
        closed = true;
        clearTimeout(openTimer);
        socket.close(code);
        link?.close();
        link = null;
        socket.free();
      },
      get onMessage() {
        return onMessage ?? (() => undefined);
      },
      set onMessage(handler) {
        onMessage = handler;
        for (const message of early.splice(0)) {
          if (closed) break;
          handler(message);
        }
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
    const deliver = (message: Uint8Array) => (onMessage ? onMessage(message) : early.push(message));
    const finish = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      clearTimeout(openTimer);
      const refusedStatus = socket.refusedStatus;
      link?.close();
      link = null;
      socket.free();
      if (opened && onClose) onClose(code, reason);
      else if (opened) earlyClose = [code, reason];
      else if (refusedStatus !== undefined) reject(new HandshakeRefusedError(host, path, refusedStatus));
      else reject(new Error(`WebSocket to ${host}${path} did not open: ${reason}`));
    };

    try {
      link = new RelayLink(
        host,
        socket,
        () => {
          if (closed) return;
          // If the server sent HTTP 101 and a WebSocket Close frame in the same TLS burst, `socket.isOpen` is already
          // false while `socket.closeCode` is set; still treat the handshake as opened so close codes (4008, 4401)
          // reach the caller via `earlyClose`.
          if (!opened && (socket.isOpen || socket.closeCode !== undefined)) {
            opened = true;
            clearTimeout(openTimer);
            resolve(channel);
          }
          for (const message of socket.takeMessages() as Uint8Array[]) {
            if (closed) return;
            deliver(message);
          }
          // A message handler may have called `channel.close()` synchronously, freeing `socket`.
          if (closed) return;
          const code = socket.closeCode;
          if (code !== undefined) finish(code, socket.closeReason || 'closed by the server');
        },
        (reason) => finish(1006, reason),
      );
    } catch (error) {
      closed = true;
      socket.free();
      reject(error);
      return;
    }

    openTimer = setTimeout(() => {
      if (opened || closed) return;
      closed = true;
      link?.close();
      link = null;
      socket.free();
      reject(new NoAnswerError('Signal', REQUEST_TIME_LIMIT_S));
    }, REQUEST_TIME_LIMIT_S * 1000);
  });
}

/** How often to send Signal's keepalive request. Signal's clients use about 30 s; idle connections get dropped. */
const KEEPALIVE_INTERVAL_MS = 30_000;

/** The socket closed while a request was waiting for its response. */
export class SocketClosedError extends Error {
  constructor(readonly code: number) {
    super(`socket closed (code ${code})`);
  }
}

/** Answers a request the server sends; returns the HTTP status to reply with. */
export type ServerRequestHandler = (request: WebSocketRequestMessage) => number;

export type SignalSocketHandlers = {
  onServerRequest?: ServerRequestHandler;
  onUnexpectedClose?: (code: number) => void;
};

export class SignalSocket {
  #channel: MessageChannel;
  #nextId = 1n;
  #pending = new Map<
    bigint,
    { resolve: (response: WebSocketResponseMessage) => void; reject: (error: Error) => void }
  >();
  #keepalive: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #closedByUs = false;
  #onServerRequest: ServerRequestHandler | null = null;
  #onUnexpectedClose: ((code: number) => void) | null = null;
  #earlyRequests: WebSocketRequestMessage[] = [];
  #earlyUnexpectedClose: number | null = null;

  constructor(channel: MessageChannel, keepalivePath: string, handlers: SignalSocketHandlers = {}) {
    this.#channel = channel;
    if (handlers.onServerRequest) this.#onServerRequest = handlers.onServerRequest;
    if (handlers.onUnexpectedClose) this.#onUnexpectedClose = handlers.onUnexpectedClose;

    channel.onClose = (code) => this.#handleRemoteClose(code);
    channel.onMessage = (bytes) => this.#receive(bytes);

    if (!this.#closed) {
      this.#keepalive = setInterval(() => {
        if (this.#closed) return;
        void this.request('GET', keepalivePath).catch((error: unknown) => {
          // A timed-out keepalive means the TCP connection is half-open/dead; tear it down so callers reconnect.
          if (error instanceof NoAnswerError && !this.#closed) {
            this.#handleRemoteClose(1006);
            this.#channel.close(1006);
          }
        });
      }, KEEPALIVE_INTERVAL_MS);
    }
  }

  get onServerRequest(): ServerRequestHandler {
    return this.#onServerRequest ?? (() => 200);
  }

  set onServerRequest(handler: ServerRequestHandler) {
    this.#onServerRequest = handler;
    for (const request of this.#earlyRequests.splice(0)) {
      if (this.#closed) break;
      this.#answerServerRequest(request, handler);
    }
  }

  /** Called when the server or the network closes the socket; not called after `close()`. */
  get onUnexpectedClose(): (code: number) => void {
    return this.#onUnexpectedClose ?? (() => undefined);
  }

  set onUnexpectedClose(handler: (code: number) => void) {
    this.#onUnexpectedClose = handler;
    if (this.#earlyUnexpectedClose !== null && !this.#closedByUs) {
      const code = this.#earlyUnexpectedClose;
      this.#earlyUnexpectedClose = null;
      handler(code);
    }
  }

  #stopKeepalive(): void {
    if (this.#keepalive !== null) {
      clearInterval(this.#keepalive);
      this.#keepalive = null;
    }
  }

  #handleRemoteClose(code: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopKeepalive();
    for (const { reject } of this.#pending.values()) reject(new SocketClosedError(code));
    this.#pending.clear();
    if (!this.#closedByUs) {
      if (this.#onUnexpectedClose) this.#onUnexpectedClose(code);
      else this.#earlyUnexpectedClose = code;
    }
  }

  /** Sends a request; fails with a NoAnswerError when Signal does not answer within the request time limit. */
  request(
    verb: string,
    path: string,
    options: { body?: Uint8Array; headers?: string[] } = {},
  ): Promise<WebSocketResponseMessage> {
    const id = this.#nextId++;
    const request = create(WebSocketRequestMessageSchema, {
      id,
      verb,
      path,
      headers: options.headers ?? [],
      body: options.body,
    });
    const message = create(WebSocketMessageSchema, { type: WebSocketMessage_Type.REQUEST, request });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new NoAnswerError('Signal', REQUEST_TIME_LIMIT_S));
      }, REQUEST_TIME_LIMIT_S * 1000);
      this.#pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.#channel.send(toBinary(WebSocketMessageSchema, message));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  close(): void {
    this.#closedByUs = true;
    this.#closed = true;
    this.#stopKeepalive();
    for (const { reject } of this.#pending.values()) reject(new SocketClosedError(1000));
    this.#pending.clear();
    this.#channel.close();
  }

  #answerServerRequest(request: WebSocketRequestMessage, handler: ServerRequestHandler): void {
    const status = handler(request);
    if (this.#closed) return;
    const response = create(WebSocketResponseMessageSchema, {
      id: request.id,
      status,
      message: status === 200 ? 'OK' : 'Error',
    });
    try {
      this.#channel.send(
        toBinary(
          WebSocketMessageSchema,
          create(WebSocketMessageSchema, { type: WebSocketMessage_Type.RESPONSE, response }),
        ),
      );
    } catch {
      // The channel closed before the reply went out.
    }
  }

  #receive(bytes: Uint8Array): void {
    const message = fromBinary(WebSocketMessageSchema, bytes);
    if (message.type === WebSocketMessage_Type.RESPONSE && message.response !== undefined) {
      this.#pending.get(message.response.id)?.resolve(message.response);
      this.#pending.delete(message.response.id);
    } else if (message.type === WebSocketMessage_Type.REQUEST && message.request !== undefined) {
      if (this.#onServerRequest) this.#answerServerRequest(message.request, this.#onServerRequest);
      else this.#earlyRequests.push(message.request);
    }
  }
}

/**
 * Opens a Signal chat socket at `path` through the relay: TLS to chat.signal.org inside the tunnel, then the
 * WebSocket upgrade with `headers` (for example Authorization). `keepalivePath` is `/v1/keepalive/provisioning`
 * on a linking socket and `/v1/keepalive` otherwise.
 */
export async function connectChat(
  path: string,
  keepalivePath: string,
  headers: string[] = [],
  handlers: SignalSocketHandlers = {},
): Promise<SignalSocket> {
  return new SignalSocket(await openTunnelWebSocket(CHAT_HOST, path, headers), keepalivePath, handlers);
}
