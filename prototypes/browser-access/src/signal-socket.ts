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
export class SignalSocket {
  #socket: WebSocket;
  #nextId = 1n;
  #pending = new Map<bigint, (response: WebSocketResponseMessage) => void>();
  onServerRequest: ServerRequestHandler = () => 200;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => this.#receive(new Uint8Array(event.data as ArrayBuffer));
  }

  static open(url: string): Promise<SignalSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => resolve(new SignalSocket(socket));
      socket.onerror = () => reject(new Error('WebSocket failed to open'));
    });
  }

  request(verb: string, path: string, options: { body?: Uint8Array; headers?: string[] } = {}): Promise<WebSocketResponseMessage> {
    const id = this.#nextId++;
    const request = create(WebSocketRequestMessageSchema, { id, verb, path, headers: options.headers ?? [], body: options.body });
    const message = create(WebSocketMessageSchema, { type: WebSocketMessage_Type.REQUEST, request });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, resolve);
      this.#socket.onclose = () => reject(new Error(`socket closed before the response to ${verb} ${path}`));
      this.#socket.send(toBinary(WebSocketMessageSchema, message));
    });
  }

  close(): void {
    this.#socket.onclose = null;
    this.#socket.close();
  }

  #receive(bytes: Uint8Array): void {
    const message = fromBinary(WebSocketMessageSchema, bytes);
    if (message.type === WebSocketMessage_Type.RESPONSE && message.response !== undefined) {
      this.#pending.get(message.response.id)?.(message.response);
      this.#pending.delete(message.response.id);
    } else if (message.type === WebSocketMessage_Type.REQUEST && message.request !== undefined) {
      const status = this.onServerRequest(message.request);
      const response = create(WebSocketResponseMessageSchema, { id: message.request.id, status, message: status === 200 ? 'OK' : 'Error' });
      this.#socket.send(toBinary(WebSocketMessageSchema, create(WebSocketMessageSchema, { type: WebSocketMessage_Type.RESPONSE, response })));
    }
  }
}
