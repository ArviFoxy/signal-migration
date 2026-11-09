// HTTP/1.1 response parsing (RFC 9112 message framing) on hand-built responses with known bodies.

import { describe, expect, it } from 'vitest';
import { parseHttpResponse } from '../src/signal/http-client';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (body: Uint8Array) => new TextDecoder().decode(body);

describe('parseHttpResponse', () => {
  // Detects: losing or duplicating data across chunk boundaries in chunked transfer coding.
  it('joins a chunked body', () => {
    const response = parseHttpResponse(bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n'), false);
    expect(response?.status).toBe(200);
    expect(text(response!.body)).toBe('Wikipedia');
  });

  // Detects: returning a truncated body as if complete.
  it('waits for the rest of a Content-Length body', () => {
    expect(parseHttpResponse(bytes('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhello'), false)).toBeNull();
    const response = parseHttpResponse(bytes('HTTP/1.1 409 Conflict\r\nContent-Length: 10\r\n\r\nhelloworld'), false);
    expect(response?.status).toBe(409);
    expect(text(response!.body)).toBe('helloworld');
  });

  // Detects: hanging forever on a body delimited only by the end of the connection.
  it('ends an undelimited body at the end of the stream', () => {
    expect(parseHttpResponse(bytes('HTTP/1.1 200 OK\r\n\r\npartial'), false)).toBeNull();
    expect(text(parseHttpResponse(bytes('HTTP/1.1 200 OK\r\n\r\npartial'), true)!.body)).toBe('partial');
  });

  // Detects: treating an incomplete chunked body as complete.
  it('waits for the terminating chunk', () => {
    expect(parseHttpResponse(bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n'), false)).toBeNull();
  });
});
