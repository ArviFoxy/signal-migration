// Parses a multipart/form-data body into its named parts, as bytes. Used by the simulated CDN to read uploads.

import { indexOf } from './bytes';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function parseMultipart(body: Uint8Array, contentType: string): Map<string, Uint8Array> {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error('multipart body without a boundary');
  const delimiter = encoder.encode(`--${boundary}`);
  const nextDelimiter = encoder.encode(`\r\n--${boundary}`);
  const headerEnd = encoder.encode('\r\n\r\n');
  const parts = new Map<string, Uint8Array>();
  let start = indexOf(body, delimiter);
  if (start !== 0) throw new Error('multipart body does not start with its boundary');
  for (;;) {
    const afterDelimiter = start + delimiter.length;
    if (decoder.decode(body.subarray(afterDelimiter, afterDelimiter + 2)) === '--') break;
    const headersEnd = indexOf(body, headerEnd, afterDelimiter);
    const next = indexOf(body, nextDelimiter, headersEnd);
    if (headersEnd < 0 || next < 0) throw new Error('truncated multipart body');
    const headers = decoder.decode(body.subarray(afterDelimiter + 2, headersEnd));
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (!name) throw new Error('multipart part without a name');
    parts.set(name, body.slice(headersEnd + 4, next));
    start = next + 2;
  }
  return parts;
}
