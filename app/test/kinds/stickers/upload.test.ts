import { fromBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { StickerPackSchema } from '../src/gen/Stickers_pb';
import { manifestFor, multipartBody, type UploadFormItem } from '../src/kinds/stickers/upload';

const item: UploadFormItem = {
  id: 0,
  key: 'stickers/0123456789abcdef0123456789abcdef/full/0',
  credential: 'AKIAEXAMPLE/20261109/us-east-1/s3/aws4_request',
  acl: 'private',
  algorithm: 'AWS4-HMAC-SHA256',
  date: '20261109T120000Z',
  policy: 'eyJleHBpcmF0aW9uIjoiMjAyNi0xMS0wOVQxMjozMDowMFoifQ==',
  signature: 'deadbeef',
};

describe('multipartBody', () => {
  // Detects: a malformed multipart body (boundaries, line breaks) or the file not being the last field, which S3 POST
  // uploads require.
  it('parses as multipart/form-data with the policy fields, then the file last', async () => {
    const file = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
    const boundary = '----------------0123456789abcdef';
    const parsed = await new Response(multipartBody(item, file, boundary), { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }).formData();
    const names = [...parsed.keys()];
    expect(names).toEqual(['key', 'x-amz-credential', 'acl', 'x-amz-algorithm', 'x-amz-date', 'policy', 'x-amz-signature', 'Content-Type', 'file']);
    expect(parsed.get('key')).toBe(item.key);
    expect(parsed.get('policy')).toBe(item.policy);
    expect(parsed.get('x-amz-signature')).toBe(item.signature);
  });

  // Detects: the file's bytes being altered or cut. The parser above reads a part without a file name as text, as the
  // multipart standard says (Signal Desktop sends the file that way too), so the bytes are compared in the raw body:
  // they sit between the file part's blank line and the closing boundary.
  it('carries the file bytes unchanged', () => {
    const file = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
    const boundary = '----------------0123456789abcdef';
    const body = Buffer.from(multipartBody(item, file, boundary));
    const start = body.indexOf('\r\n\r\n', body.indexOf('name="file"')) + 4;
    const end = body.lastIndexOf(`\r\n--${boundary}--\r\n`);
    expect(new Uint8Array(body.subarray(start, end))).toEqual(file);
  });
});

describe('manifestFor', () => {
  // Detects: sticker IDs that do not match the upload slots (clients fetch sticker n from /full/n), lost emoji, a
  // missing cover, or an author field, which would let anyone with the pack see where it came from.
  it('numbers the stickers in order, uses the first as the cover, and sets no author', () => {
    const image = new Uint8Array([1]);
    const manifest = fromBinary(StickerPackSchema, manifestFor({ title: 'Cats', stickers: [{ image, emoji: '😺' }, { image, emoji: '😾' }] }));
    expect(manifest.title).toBe('Cats');
    expect(manifest.author).toBe('');
    expect(manifest.stickers.map((s) => [s.id, s.emoji])).toEqual([
      [0, '😺'],
      [1, '😾'],
    ]);
    expect(manifest.cover?.id).toBe(0);
  });
});
