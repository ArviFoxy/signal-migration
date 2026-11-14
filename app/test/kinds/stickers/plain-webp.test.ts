// Which WebP files hold nothing but one still picture, and how the app makes one of what a browser's encoder
// writes. A copy of a still sticker that the app had to encode again must be such a file, so that it cannot show one
// thing in this page and another in a Signal app.

import { describe, expect, it } from 'vitest';
import { isPlainWebp, plainWebp } from '../../../src/kinds/stickers/plain-webp';

type Chunk = { kind: string; data: number[] };

/** A WebP file of these chunks, laid out as the container format says (RIFF: little-endian lengths, even padding). */
function fileOf(chunks: Chunk[]): Uint8Array {
  const letters = (text: string) => [...text].map((letter) => letter.charCodeAt(0));
  const length = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
  const body = chunks.flatMap(({ kind, data }) => [
    ...letters(kind),
    ...length(data.length),
    ...data,
    ...(data.length % 2 ? [0] : []),
  ]);
  return new Uint8Array([...letters('RIFF'), ...length(body.length + 4), ...letters('WEBP'), ...body]);
}

const picture = { kind: 'VP8 ', data: [1, 2, 3, 4, 5] };
const lossless = { kind: 'VP8L', data: [1, 2, 3, 4] };
const transparency = { kind: 'ALPH', data: [9, 9, 9] };
/** The header chunk of the extended form; `flags` announces what the file holds. */
const header = (flags: number) => ({ kind: 'VP8X', data: [flags, 0, 0, 0, 7, 0, 0, 7, 0, 0] });
const TRANSPARENCY = 0x10;
const ANIMATION = 0x02;
const COLOUR_PROFILE = 0x20;

describe('a plain WebP file', () => {
  // Detects: the still pictures a browser's encoder writes refused, with or without transparency, which would make
  // every pack with a large still sticker fail its comparison.
  it('is one still picture in any of the forms an encoder writes', () => {
    expect(isPlainWebp(fileOf([picture]))).toBe(true);
    expect(isPlainWebp(fileOf([lossless]))).toBe(true);
    expect(isPlainWebp(fileOf([header(TRANSPARENCY), transparency, picture]))).toBe(true);
    expect(isPlainWebp(fileOf([header(TRANSPARENCY), lossless]))).toBe(true);
    expect(isPlainWebp(fileOf([header(0), picture]))).toBe(true);
  });

  // Detects: an animation accepted as a still picture. This page draws its first frame, and a Signal app may play
  // the others.
  it('holds no animation', () => {
    const frame = { kind: 'ANMF', data: [0, 0, 0, 0, 0, 0, 7, 0, 0, 7, 0, 0, 40, 0, 0, 0] };
    const animation = { kind: 'ANIM', data: [0, 0, 0, 0, 0, 0] };
    expect(isPlainWebp(fileOf([header(ANIMATION), animation, frame, frame]))).toBe(false);
    expect(isPlainWebp(fileOf([header(ANIMATION), picture]))).toBe(false);
    expect(isPlainWebp(fileOf([header(0), animation, frame]))).toBe(false);
  });

  // Detects: data that one decoder uses and the next ignores, such as a colour profile, which changes the colours
  // only where it is applied.
  it('holds no colour profile and no other data', () => {
    const profile = { kind: 'ICCP', data: [1, 2] };
    expect(isPlainWebp(fileOf([header(COLOUR_PROFILE), profile, picture]))).toBe(false);
    expect(isPlainWebp(fileOf([header(COLOUR_PROFILE), picture]))).toBe(false);
    expect(isPlainWebp(fileOf([header(0), picture, { kind: 'EXIF', data: [1, 2] }]))).toBe(false);
    expect(isPlainWebp(fileOf([picture, { kind: 'XMP ', data: [1, 2] }]))).toBe(false);
    expect(isPlainWebp(fileOf([picture, picture]))).toBe(false);
    expect(isPlainWebp(fileOf([header(TRANSPARENCY), transparency, transparency, picture]))).toBe(false);
  });

  // Detects: bytes that the container does not account for, where anything can be kept: after the file's stated
  // end, or in a chunk that says it is longer than the file.
  it('is a whole WebP file with nothing after it', () => {
    const file = fileOf([header(TRANSPARENCY), transparency, picture]);
    expect(isPlainWebp(new Uint8Array([...file, 0]))).toBe(false);
    expect(isPlainWebp(file.subarray(0, file.length - 1))).toBe(false);
    const tooLong = file.slice();
    tooLong[file.length - 10] = 200;
    expect(isPlainWebp(tooLong)).toBe(false);
    expect(isPlainWebp(new Uint8Array(0))).toBe(false);
    expect(isPlainWebp(fileOf([]))).toBe(false);
  });

  // Detects: a file of another kind taken for WebP because a browser reads it all the same: an animated PNG or a
  // GIF given where a still WebP belongs.
  it('is no file of another kind', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
    expect(isPlainWebp(png)).toBe(false);
    const wave = fileOf([picture]);
    wave.set([87, 65, 86, 69], 8);
    expect(isPlainWebp(wave)).toBe(false);
  });
});

describe('a still WebP picture without what its encoder added', () => {
  const profile = { kind: 'ICCP', data: [1, 2, 3] };
  // What Chrome's canvas encoder writes (seen in Chrome): a header that announces a colour profile, the profile,
  // and the picture, lossy or lossless, with its transparency.
  const fromBrowser = [
    [header(COLOUR_PROFILE), profile, picture],
    [header(COLOUR_PROFILE), profile, lossless],
    [header(COLOUR_PROFILE | TRANSPARENCY), profile, transparency, picture],
    [header(COLOUR_PROFILE | TRANSPARENCY), profile, lossless],
  ];

  // Detects: the app uploading still pictures that other users' browsers refuse as copies, because the colour
  // profile or its announcement in the header was left in.
  it('holds nothing but the picture', () => {
    for (const chunks of fromBrowser) expect(isPlainWebp(plainWebp(fileOf(chunks)))).toBe(true);
  });

  // Detects: the picture or its transparency changed, lost or reordered while the profile is taken out, or the
  // size of the picture in the header lost.
  it('keeps the picture, its transparency and its size as they were', () => {
    expect(plainWebp(fileOf(fromBrowser[2]))).toEqual(fileOf([header(TRANSPARENCY), transparency, picture]));
    expect(plainWebp(fileOf(fromBrowser[1]))).toEqual(fileOf([header(0), lossless]));
    expect(plainWebp(fileOf([picture]))).toEqual(fileOf([picture]));
  });

  // Detects: an animation or a file of another kind passed on as if it were a still picture.
  it('is not made of an animation or of a file that is not WebP', () => {
    const frame = { kind: 'ANMF', data: [0, 0, 0, 0, 0, 0, 7, 0, 0, 7, 0, 0, 40, 0, 0, 0] };
    expect(() => plainWebp(fileOf([header(ANIMATION), { kind: 'ANIM', data: [0, 0, 0, 0, 0, 0] }, frame]))).toThrow();
    expect(() => plainWebp(fileOf([header(ANIMATION), picture]))).toThrow();
    expect(() => plainWebp(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toThrow();
  });
});
