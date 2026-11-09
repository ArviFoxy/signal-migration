// The WebSocket protocol (RFC 6455), client side, over any byte stream.
//
// Running it inside our own TLS session lets the page send the handshake headers Signal requires,
// including Authorization, which the browser's WebSocket API cannot set.

import type { ByteStream } from './tunnel';

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A message channel with the parts of the browser WebSocket interface that SignalSocket uses. */
export interface MessageChannel {
  send(bytes: Uint8Array): void;
  close(code?: number): void;
  onMessage: (bytes: Uint8Array) => void;
  onClose: (code: number, reason: string) => void;
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Encodes one masked client frame (clients must mask, RFC 6455 section 5.3). */
export function encodeFrame(opcode: number, payload: Uint8Array, maskKey: Uint8Array): Uint8Array {
  const length = payload.length;
  const headerLength = 2 + (length < 126 ? 0 : length < 65536 ? 2 : 8) + 4;
  const frame = new Uint8Array(headerLength + length);
  frame[0] = 0x80 | opcode;
  let offset = 2;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length < 65536) {
    frame[1] = 0x80 | 126;
    new DataView(frame.buffer).setUint16(2, length);
    offset = 4;
  } else {
    frame[1] = 0x80 | 127;
    new DataView(frame.buffer).setBigUint64(2, BigInt(length));
    offset = 10;
  }
  frame.set(maskKey, offset);
  offset += 4;
  for (let i = 0; i < length; i++) frame[offset + i] = payload[i] ^ maskKey[i & 3];
  return frame;
}

export type DecodedFrame = { fin: boolean; opcode: number; payload: Uint8Array; frameLength: number };

/** Decodes one server frame from the start of `buffer`, or returns null if it is not complete yet. */
export function decodeFrame(buffer: Uint8Array): DecodedFrame | null {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = view.getUint16(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = view.getBigUint64(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
    length = Number(big);
    offset = 10;
  }
  const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = buffer.slice(offset, offset + length);
  if (maskKey) for (let i = 0; i < length; i++) payload[i] ^= maskKey[i & 3];
  return { fin, opcode, payload, frameLength: offset + length };
}

/**
 * Opens a WebSocket over `stream`: sends the HTTP/1.1 upgrade request for `host` and `path` with the extra
 * `headers` ("Name: value"), checks the 101 response, then exchanges binary messages.
 */
export async function openWebSocket(stream: ByteStream, host: string, path: string, headers: string[] = []): Promise<MessageChannel> {
  const key = base64(crypto.getRandomValues(new Uint8Array(16)));
  const expectedAccept = base64(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key + HANDSHAKE_GUID))));
  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...headers,
    '',
    '',
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    let buffer: Uint8Array = new Uint8Array(0);
    let channel: WebSocketChannel | null = null;
    stream.onClose = (reason) => {
      if (channel) channel.streamClosed(reason);
      else reject(new Error(`stream closed during the WebSocket handshake: ${reason}`));
    };
    stream.onData = (bytes) => {
      if (channel) return channel.receive(bytes);
      buffer = concat(buffer, bytes);
      const end = findHeaderEnd(buffer);
      if (end < 0) return;
      const head = new TextDecoder().decode(buffer.subarray(0, end));
      const rest = buffer.subarray(end + 4);
      const [statusLine, ...headerLines] = head.split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      const accept = headerLines.find((line) => line.toLowerCase().startsWith('sec-websocket-accept:'))?.split(':')[1]?.trim();
      if (status !== 101) {
        stream.close();
        return reject(new Error(`WebSocket upgrade refused: ${statusLine}`));
      }
      if (accept !== expectedAccept) {
        stream.close();
        return reject(new Error('WebSocket upgrade answered with a wrong Sec-WebSocket-Accept'));
      }
      channel = new WebSocketChannel(stream);
      resolve(channel);
      if (rest.length > 0) channel.receive(rest);
    };
    stream.write(new TextEncoder().encode(request));
  });
}

function findHeaderEnd(buffer: Uint8Array): number {
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) return i;
  }
  return -1;
}

class WebSocketChannel implements MessageChannel {
  onMessage: (bytes: Uint8Array) => void = () => undefined;
  onClose: (code: number, reason: string) => void = () => undefined;
  #stream: ByteStream;
  #buffer: Uint8Array = new Uint8Array(0);
  #fragments: Uint8Array[] = [];
  #closed = false;

  constructor(stream: ByteStream) {
    this.#stream = stream;
  }

  send(bytes: Uint8Array): void {
    this.#sendFrame(OPCODE_BINARY, bytes);
  }

  close(code = 1000): void {
    if (this.#closed) return;
    const payload = new Uint8Array(2);
    new DataView(payload.buffer).setUint16(0, code);
    this.#sendFrame(OPCODE_CLOSE, payload);
    this.#finish(code, 'closed by this page');
  }

  receive(bytes: Uint8Array): void {
    this.#buffer = concat(this.#buffer, bytes);
    for (;;) {
      const frame = decodeFrame(this.#buffer);
      if (frame === null) return;
      this.#buffer = this.#buffer.subarray(frame.frameLength);
      this.#handle(frame);
      if (this.#closed) return;
    }
  }

  streamClosed(reason: string): void {
    this.#finish(1006, reason);
  }

  #handle(frame: DecodedFrame): void {
    switch (frame.opcode) {
      case OPCODE_PING:
        return this.#sendFrame(OPCODE_PONG, frame.payload);
      case OPCODE_PONG:
        return;
      case OPCODE_CLOSE: {
        const code = frame.payload.length >= 2 ? new DataView(frame.payload.buffer).getUint16(0) : 1005;
        const reason = new TextDecoder().decode(frame.payload.subarray(2));
        if (!this.#closed) this.#sendFrame(OPCODE_CLOSE, frame.payload.subarray(0, 2));
        return this.#finish(code, reason);
      }
      case OPCODE_TEXT:
      case OPCODE_BINARY:
      case OPCODE_CONTINUATION: {
        this.#fragments.push(frame.payload);
        if (!frame.fin) return;
        const message = this.#fragments.reduce(concat, new Uint8Array(0));
        this.#fragments = [];
        return this.onMessage(message);
      }
    }
  }

  #sendFrame(opcode: number, payload: Uint8Array): void {
    if (this.#closed) return;
    this.#stream.write(encodeFrame(opcode, payload, crypto.getRandomValues(new Uint8Array(4))));
  }

  #finish(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stream.close();
    this.onClose(code, reason);
  }
}
