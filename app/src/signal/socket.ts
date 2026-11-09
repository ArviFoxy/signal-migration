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
import { TlsWebSocket } from '../wasm/signal_migration_wasm';
import { RelayLink } from './tunnel';
import { loadSignalWasm } from './wasm';

export const CHAT_HOST = 'chat.signal.org';

/** A binary message channel. */
export interface MessageChannel {
  send(bytes: Uint8Array): void;
  close(code?: number): void;
  onMessage: (bytes: Uint8Array) => void;
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

/** Opens a WebSocket to `host`'s `path` with extra handshake `headers` ("Name: value"), through the relay. */
export async function openTunnelWebSocket(host: string, path: string, headers: string[]): Promise<MessageChannel> {
  await loadSignalWasm();
  const socket = new TlsWebSocket(host, path, headers);
  return new Promise((resolve, reject) => {
    let opened = false;
    let closed = false;
    const channel: MessageChannel = {
      send: (bytes) => {
        socket.send(bytes);
        link.flush();
      },
      close: (code = 1000) => {
        if (closed) return;
        closed = true;
        socket.close(code);
        link.close();
        socket.free();
      },
      onMessage: () => undefined,
      onClose: () => undefined,
    };
    const finish = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      const refusedStatus = socket.refusedStatus;
      link.close();
      socket.free();
      if (opened) channel.onClose(code, reason);
      else if (refusedStatus !== undefined) reject(new HandshakeRefusedError(host, path, refusedStatus));
      else reject(new Error(`WebSocket to ${host}${path} did not open: ${reason}`));
    };
    const link = new RelayLink(
      host,
      socket,
      () => {
        if (!opened && socket.isOpen) {
          opened = true;
          resolve(channel);
        }
        for (const message of socket.takeMessages() as Uint8Array[]) channel.onMessage(message);
        const code = socket.closeCode;
        if (code !== undefined) finish(code, 'closed by the server');
      },
      (reason) => finish(1006, reason),
    );
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

export class SignalSocket {
  #channel: MessageChannel;
  #nextId = 1n;
  #pending = new Map<
    bigint,
    { resolve: (response: WebSocketResponseMessage) => void; reject: (error: Error) => void }
  >();
  #keepalive: ReturnType<typeof setInterval>;
  #closedByUs = false;
  onServerRequest: ServerRequestHandler = () => 200;
  /** Called when the server or the network closes the socket; not called after `close()`. */
  onUnexpectedClose: (code: number) => void = () => undefined;

  constructor(channel: MessageChannel, keepalivePath: string) {
    this.#channel = channel;
    channel.onMessage = (bytes) => this.#receive(bytes);
    channel.onClose = (code) => {
      clearInterval(this.#keepalive);
      for (const { reject } of this.#pending.values()) reject(new SocketClosedError(code));
      this.#pending.clear();
      if (!this.#closedByUs) this.onUnexpectedClose(code);
    };
    this.#keepalive = setInterval(
      () => void this.request('GET', keepalivePath).catch(() => undefined),
      KEEPALIVE_INTERVAL_MS,
    );
  }

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
      this.#pending.set(id, { resolve, reject });
      this.#channel.send(toBinary(WebSocketMessageSchema, message));
    });
  }

  close(): void {
    this.#closedByUs = true;
    clearInterval(this.#keepalive);
    this.#channel.close();
  }

  #receive(bytes: Uint8Array): void {
    const message = fromBinary(WebSocketMessageSchema, bytes);
    if (message.type === WebSocketMessage_Type.RESPONSE && message.response !== undefined) {
      this.#pending.get(message.response.id)?.resolve(message.response);
      this.#pending.delete(message.response.id);
    } else if (message.type === WebSocketMessage_Type.REQUEST && message.request !== undefined) {
      const status = this.onServerRequest(message.request);
      const response = create(WebSocketResponseMessageSchema, {
        id: message.request.id,
        status,
        message: status === 200 ? 'OK' : 'Error',
      });
      this.#channel.send(
        toBinary(
          WebSocketMessageSchema,
          create(WebSocketMessageSchema, { type: WebSocketMessage_Type.RESPONSE, response }),
        ),
      );
    }
  }
}

/**
 * Opens a Signal chat socket at `path` through the relay: TLS to chat.signal.org inside the tunnel, then the
 * WebSocket upgrade with `headers` (for example Authorization). `keepalivePath` is `/v1/keepalive/provisioning`
 * on a linking socket and `/v1/keepalive` otherwise.
 */
export async function connectChat(path: string, keepalivePath: string, headers: string[] = []): Promise<SignalSocket> {
  return new SignalSocket(await openTunnelWebSocket(CHAT_HOST, path, headers), keepalivePath);
}
