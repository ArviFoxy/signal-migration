// Signal's chat WebSocket protocol: request/response messages in both directions, matched by id,
// over a WebSocket that runs inside our TLS tunnel.

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  type WebSocketRequestMessage,
  type WebSocketResponseMessage,
  WebSocketMessage_Type,
  WebSocketMessageSchema,
  WebSocketRequestMessageSchema,
  WebSocketResponseMessageSchema,
} from '../gen/chat_websocket_pb';
import { TlsTunnel } from './tunnel';
import { type MessageChannel, openWebSocket } from './websocket-client';

export const CHAT_HOST = 'chat.signal.org';

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
  #pending = new Map<bigint, { resolve: (response: WebSocketResponseMessage) => void; reject: (error: Error) => void }>();
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
    this.#keepalive = setInterval(() => void this.request('GET', keepalivePath).catch(() => undefined), KEEPALIVE_INTERVAL_MS);
  }

  request(verb: string, path: string, options: { body?: Uint8Array; headers?: string[] } = {}): Promise<WebSocketResponseMessage> {
    const id = this.#nextId++;
    const request = create(WebSocketRequestMessageSchema, { id, verb, path, headers: options.headers ?? [], body: options.body });
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
      const response = create(WebSocketResponseMessageSchema, { id: message.request.id, status, message: status === 200 ? 'OK' : 'Error' });
      this.#channel.send(toBinary(WebSocketMessageSchema, create(WebSocketMessageSchema, { type: WebSocketMessage_Type.RESPONSE, response })));
    }
  }
}

/**
 * Opens a Signal chat socket at `path` through the relay: TLS to chat.signal.org inside the tunnel, then the
 * WebSocket upgrade with `headers` (for example Authorization). `keepalivePath` is `/v1/keepalive/provisioning`
 * on a linking socket and `/v1/keepalive` otherwise.
 */
export async function connectChat(path: string, keepalivePath: string, headers: string[] = []): Promise<SignalSocket> {
  const tunnel = await TlsTunnel.open(CHAT_HOST);
  const channel = await openWebSocket(tunnel, CHAT_HOST, path, headers);
  return new SignalSocket(channel, keepalivePath);
}
