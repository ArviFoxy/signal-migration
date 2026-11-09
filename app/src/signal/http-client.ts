// HTTP/1.1 requests to a Signal host, through our relay, inside the page's own TLS session.

import { TlsTunnel } from './tunnel';

export type HttpResponse = { status: number; statusText: string; headers: Map<string, string>; body: Uint8Array };

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function indexOfCrlf(buffer: Uint8Array, from: number, double: boolean): number {
  const needle = double ? [13, 10, 13, 10] : [13, 10];
  outer: for (let i = from; i + needle.length <= buffer.length; i++) {
    for (let j = 0; j < needle.length; j++) if (buffer[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Parses an HTTP/1.1 response. Returns null while more bytes are needed. With `streamEnded`, a body without
 * Content-Length or chunked encoding ends at the end of the stream.
 */
export function parseHttpResponse(buffer: Uint8Array, streamEnded: boolean): HttpResponse | null {
  const headerEnd = indexOfCrlf(buffer, 0, true);
  if (headerEnd < 0) return null;
  const [statusLine, ...lines] = new TextDecoder().decode(buffer.subarray(0, headerEnd)).split('\r\n');
  const [, statusCode, ...reason] = statusLine.split(' ');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const response = (body: Uint8Array): HttpResponse => ({ status: Number(statusCode), statusText: reason.join(' '), headers, body });
  let offset = headerEnd + 4;

  if (headers.get('transfer-encoding')?.toLowerCase().includes('chunked')) {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const sizeEnd = indexOfCrlf(buffer, offset, false);
      if (sizeEnd < 0) return null;
      const size = parseInt(new TextDecoder().decode(buffer.subarray(offset, sizeEnd)).split(';')[0], 16);
      if (Number.isNaN(size)) throw new Error('malformed chunk size');
      const dataStart = sizeEnd + 2;
      if (size === 0) return response(concat(chunks));
      if (buffer.length < dataStart + size + 2) return null;
      chunks.push(buffer.subarray(dataStart, dataStart + size));
      offset = dataStart + size + 2;
    }
  }
  const length = headers.get('content-length');
  if (length !== undefined) {
    const end = offset + Number(length);
    return buffer.length >= end ? response(buffer.slice(offset, end)) : null;
  }
  return streamEnded ? response(buffer.slice(offset)) : null;
}

/** Sends one request to `host` (with `Connection: close`) and returns the response. `headers` are "Name: value". */
export async function httpsRequest(host: string, method: string, path: string, headers: string[] = [], body?: Uint8Array): Promise<HttpResponse> {
  const tunnel = await TlsTunnel.open(host);
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let done = false;
    const attempt = (streamEnded: boolean) => {
      if (done) return;
      try {
        const response = parseHttpResponse(concat(chunks), streamEnded);
        if (response) {
          done = true;
          tunnel.close();
          resolve(response);
        } else if (streamEnded) {
          done = true;
          reject(new Error(`connection to ${host} ended before a complete response`));
        }
      } catch (error) {
        done = true;
        tunnel.close();
        reject(error);
      }
    };
    tunnel.onData = (bytes) => {
      chunks.push(bytes);
      attempt(false);
    };
    tunnel.onClose = () => attempt(true);
    const head = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: close', `Content-Length: ${body?.length ?? 0}`, ...headers, '', ''].join('\r\n');
    tunnel.write(new TextEncoder().encode(head));
    if (body && body.length > 0) tunnel.write(body);
  });
}
