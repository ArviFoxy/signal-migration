// The WebM decoder (webm-decoder.c, built by scripts/build-webm-decoder.sh), run in Node on a video sticker whose
// pixels are known: test/fixtures/stickers/moving-square.webm, 64 x 48 pixels, 10 frames at 10 frames per second,
// fully transparent except an opaque red 16 x 16 square that moves 4 pixels to the right per frame. It was made
// with ffmpeg (an overlay on a transparent background, VP9 with transparency, lossless). ffmpeg's own libvpx decoder
// reads frame f with the square at x = 4 (f + 1) to 4 (f + 1) + 15 and y = 16 to 31, coloured (253, 0, 0) inside
// and (242, 2, 4) on its top and bottom two rows, where the encoder's colour subsampling blended in the transparent
// rows next to them.

import fs from 'node:fs';
import createWebmDecoder, { type WebmDecoderModule } from 'webm-decoder';
import { beforeAll, expect, it } from 'vitest';
import { probeWebm, renderWebm } from '../../../src/kinds/stickers/webm-decoding';

const file = new Uint8Array(fs.readFileSync(new URL('../../fixtures/stickers/moving-square.webm', import.meta.url)));
let decoder: WebmDecoderModule;
beforeAll(async () => {
  decoder = await createWebmDecoder();
});

/** The pixel at (x, y) of a square RGBA frame of `size` pixels. */
const pixel = (frame: ArrayBuffer, size: number, x: number, y: number) =>
  Array.from(new Uint8Array(frame, (y * size + x) * 4, 4));

/** Where the square is in source frame f, in source pixels. */
const squareLeft = (f: number) => 4 * (f + 1);

const isRed = ([r, g, b, a]: number[]) => r >= 240 && g <= 10 && b <= 10 && a === 255;
const isClear = ([, , , a]: number[]) => a === 0;

// Detects: the size, duration or frame rate misread, which sets how many frames the APNG gets.
it('reads the video size, duration and frame rate', () => {
  expect(probeWebm(decoder, file)).toEqual({ width: 64, height: 48, duration: 1, frameRate: 10 });
});

// Detects: transparency lost (the background coming out black and opaque, as with FFmpeg's own VP9 decoder), the
// colours wrong, or the frames out of order.
it('keeps the transparency, colour and motion of every frame at the video size', () => {
  const frames = renderWebm(decoder, file, 64, 10, 10);
  expect(frames).toHaveLength(10);
  frames.forEach((frame, f) => {
    // The 64 x 48 video sits in the 64 x 64 square from y = 8.
    const left = squareLeft(f);
    expect(isRed(pixel(frame, 64, left, 8 + 16)), `frame ${f}: the square's left edge`).toBe(true);
    expect(isRed(pixel(frame, 64, left + 15, 8 + 31)), `frame ${f}: the square's lower right corner`).toBe(true);
    expect(isClear(pixel(frame, 64, left - 1, 8 + 16)), `frame ${f}: left of the square`).toBe(true);
    expect(isClear(pixel(frame, 64, left + 16, 8 + 16)), `frame ${f}: right of the square`).toBe(true);
    expect(isClear(pixel(frame, 64, 0, 8)), `frame ${f}: the video's corner`).toBe(true);
    expect(isClear(pixel(frame, 64, 32, 0)), `frame ${f}: the padding above the video`).toBe(true);
  });
});

// Detects: frames taken at the wrong moments when the frame rate is lowered, which plays the sticker too fast or
// too slow.
it('takes the frame showing at each moment when the frame rate is lowered', () => {
  const frames = renderWebm(decoder, file, 64, 5, 5);
  expect(frames).toHaveLength(5);
  frames.forEach((frame, k) => {
    // Output frame k is at k / 5 seconds, when source frame 2k shows.
    expect(isRed(pixel(frame, 64, squareLeft(2 * k), 8 + 16)), `frame ${k}`).toBe(true);
    expect(isClear(pixel(frame, 64, squareLeft(2 * k) - 1, 8 + 16)), `frame ${k}`).toBe(true);
  });
});

// Detects: a smaller size scaled wrongly (stretched, off centre), or the edges of the visible part darkened by the
// colour of transparent pixels.
it('scales to fit the square, centred, without darkening the edges', () => {
  const [frame] = renderWebm(decoder, file, 32, 10, 1);
  // At half size the video is 32 x 24 from y = 4, and the square of frame 0 spans x 2..9, y 4 + 8..4 + 15.
  expect(isRed(pixel(frame, 32, 2, 12))).toBe(true);
  expect(isRed(pixel(frame, 32, 9, 19))).toBe(true);
  expect(isClear(pixel(frame, 32, 1, 12))).toBe(true);
  expect(isClear(pixel(frame, 32, 10, 12))).toBe(true);
  expect(isClear(pixel(frame, 32, 16, 3))).toBe(true);
  // At a third, the square's edge falls inside output pixels, which are partly covered: their colour stays red.
  const [third] = renderWebm(decoder, file, 21, 10, 1);
  const edges = Array.from({ length: 21 * 21 }, (_, i) => Array.from(new Uint8Array(third, i * 4, 4))).filter(
    ([, , , a]) => a > 0 && a < 255,
  );
  expect(edges.length).toBeGreaterThan(0);
  for (const [r, g, b] of edges) expect([r >= 240, g <= 10, b <= 10]).toEqual([true, true, true]);
});

// Detects: a file that is not a video sticker accepted silently, or failing without saying why.
it('says why a file cannot be decoded', () => {
  expect(() => probeWebm(decoder, new Uint8Array([1, 2, 3, 4]))).toThrow(/^the file is not a WebM video: /);
});

/** `video` with the duration its file states (the Duration element of the WebM header) replaced by `milliseconds`. */
function withStatedDuration(video: Uint8Array, milliseconds: number): Uint8Array {
  const at = video.findIndex((byte, i) => byte === 0x44 && video[i + 1] === 0x89 && video[i + 2] === 0x88);
  if (at < 0) throw new Error('the file states no duration');
  const changed = video.slice();
  new DataView(changed.buffer).setFloat64(at + 3, milliseconds);
  return changed;
}

// Detects: an animated sticker converted to a single still picture because its file states one frame's time as its
// duration, as some of Telegram's video stickers do.
it('goes by the frames when the stated duration ends before the last frame starts', () => {
  expect(probeWebm(decoder, withStatedDuration(file, 33)).duration).toBeCloseTo(1, 9);
});

// Detects: the pause at the end of an animation cut off. A stated duration that reaches past the last frame says
// how long that frame is held.
it('keeps a stated duration that reaches past the last frame', () => {
  expect(probeWebm(decoder, withStatedDuration(file, 3000)).duration).toBe(3);
});

// Detects: the last column of a video of odd width left unwritten by the colour conversion. It showed as a line of
// transparent or random pixels at the edge, and the same file decoded differently from one run to the next. The
// fixtures are 63 x 48 pixels of opaque red, without and with a transparency channel, made with ffmpeg.
it.each(['odd-width.webm', 'odd-width-transparency.webm'])(
  'draws every column of a video of odd width (%s)',
  (name) => {
    const video = new Uint8Array(fs.readFileSync(new URL(`../../fixtures/stickers/${name}`, import.meta.url)));
    const [frame] = renderWebm(decoder, video, 63, 10, 1);
    // The 63 x 48 video sits in the 63 x 63 square from y = 7.
    for (const x of [0, 31, 61, 62]) expect(isRed(pixel(frame, 63, x, 7 + 24)), `column ${x}`).toBe(true);
  },
);
