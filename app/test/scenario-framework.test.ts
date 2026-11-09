// Checks of the scenario framework's own simulations against an independent implementation.

import { describe, expect, it } from 'vitest';
import { multipartBody } from '../src/kinds/stickers/upload';
import { parseMultipart } from './scenario/multipart';

describe('the scenario framework', () => {
  // Detects: the simulated CDN's multipart parser disagreeing with a standard parser, which would make upload
  // scenarios pass or fail for the wrong reason.
  it('parses an upload body as the standard multipart parser does', async () => {
    const item = {
      id: 0,
      key: 'stickers/abc/full/0',
      credential: 'c',
      acl: 'private',
      algorithm: 'AWS4-HMAC-SHA256',
      date: 'd',
      policy: 'p',
      signature: 's',
    };
    const boundary = '----------------0123';
    const body = multipartBody(item, new TextEncoder().encode('file bytes'), boundary);
    const contentType = `multipart/form-data; boundary=${boundary}`;
    const standard = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    const ours = parseMultipart(body, contentType);
    expect([...ours.keys()]).toEqual([...standard.keys()]);
    for (const [name, value] of standard) expect(new TextDecoder().decode(ours.get(name))).toBe(value);
  });
});
