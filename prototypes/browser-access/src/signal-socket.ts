import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  type WebSocketRequestMessage,
  type WebSocketResponseMessage,
  WebSocketMessage_Type,
  WebSocketMessageSchema,
  WebSocketRequestMessageSchema,
  WebSocketResponseMessageSchema,
} from './gen/chat_websocket_pb';

/** Answers a request the server sends; returns the HTTP status to reply with. */
export type ServerRequestHandler = (request: WebSocketRequestMessage) => number;

/**
 * A Signal chat WebSocket: request/response messages in both directions, matched by id.
 * Server-initiated requests (queued messages, "queue empty") go to `onServerRequest`.
 */
/** How often to send Signal's keepalive request. Signal's clients use about 30 s; idle sockets get dropped. */
const KEEPALIVE_INTERVAL_MS = 30_000;

export class SignalSocket {
  #socket: WebSocket;
  #nextId = 1n;
  #pending = new Map<bigint, { resolve: (response: WebSocketResponseMessage) => void; reject: (error: Error) => void }>();
  #keepalive: ReturnType<typeof setInterval>;
  #closedByUs = false;
  onServerRequest: ServerRequestHandler = () => 200;
  /** Called when the server or a proxy closes the socket; not called after `close()`. */
  onUnexpectedClose: (code: number) => void = () => undefined;

  private constructor(socket: WebSocket, keepalivePath: string) {
    this.#socket = socket;
    socket.onmessage = (event) => this.#receive(new Uint8Array(event.data as ArrayBuffer));
    socket.onclose = (event) => {
      clearInterval(this.#keepalive);
      for (const { reject } of this.#pending.values()) reject(new Error(`socket closed (code ${event.code})`));
      this.#pending.clear();
      if (!this.#closedByUs) this.onUnexpectedClose(event.code);
    };
    this.#keepalive = setInterval(() => void this.request('GET', keepalivePath).catch(() => undefined), KEEPALIVE_INTERVAL_MS);
  }

  /** `keepalivePath` is `/v1/keepalive/provisioning` on a linking socket and `/v1/keepalive` on a chat socket. */
  static open(url: string, keepalivePath: string): Promise<SignalSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => resolve(new SignalSocket(socket, keepalivePath));
      socket.onerror = () => reject(new Error('WebSocket failed to open'));
    });
  }

  request(verb: string, path: string, options: { body?: Uint8Array; headers?: string[] } = {}): Promise<WebSocketResponseMessage> {
    const id = this.#nextId++;
    const request = create(WebSocketRequestMessageSchema, { id, verb, path, headers: options.headers ?? [], body: options.body });
    const message = create(WebSocketMessageSchema, { type: WebSocketMessage_Type.REQUEST, request });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(toBinary(WebSocketMessageSchema, message));
    });
  }

  close(): void {
    this.#closedByUs = true;
    clearInterval(this.#keepalive);
    this.#socket.close();
  }

  #receive(bytes: Uint8Array): void {
    const message = fromBinary(WebSocketMessageSchema, bytes);
    if (message.type === WebSocketMessage_Type.RESPONSE && message.response !== undefined) {
      this.#pending.get(message.response.id)?.resolve(message.response);
      this.#pending.delete(message.response.id);
    } else if (message.type === WebSocketMessage_Type.REQUEST && message.request !== undefined) {
      const status = this.onServerRequest(message.request);
      const response = create(WebSocketResponseMessageSchema, { id: message.request.id, status, message: status === 200 ? 'OK' : 'Error' });
      this.#socket.send(toBinary(WebSocketMessageSchema, create(WebSocketMessageSchema, { type: WebSocketMessage_Type.RESPONSE, response })));
    }
  }
}
