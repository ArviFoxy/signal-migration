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
  // A pixel that is nearly clear is left out: it holds its colour in too few steps to tell.
  const [third] = renderWebm(decoder, file, 21, 10, 1);
  const edges = Array.from({ length: 21 * 21 }, (_, i) => Array.from(new Uint8Array(third, i * 4, 4))).filter(
    ([, , , a]) => a >= 64 && a < 255,
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

/** The weights of a Lanczos filter of three lobes for resizing `length` samples to `targetLength`, worked out here. */
function lanczosTaps(length: number, targetLength: number): { first: number; weights: number[] }[] {
  const lanczos = (x: number) =>
    x === 0 ? 1 : Math.abs(x) >= 3 ? 0 : (3 * Math.sin(Math.PI * x) * Math.sin((Math.PI * x) / 3)) / (Math.PI * x) ** 2;
  const scale = length / targetLength;
  const width = Math.max(scale, 1);
  return Array.from({ length: targetLength }, (_, t) => {
    const centre = (t + 0.5) * scale - 0.5;
    const first = Math.ceil(centre - 3 * width);
    const raw = Array.from({ length: Math.ceil(6 * width) + 1 }, (_, k) => lanczos((first + k - centre) / width));
    const total = raw.reduce((sum, weight) => sum + weight, 0);
    return { first, weights: raw.map((weight) => weight / total) };
  });
}

/**
 * A picture (RGBA with colours multiplied by opacity, width x height) resized by a Lanczos filter and then
 * sharpened by 0.7 times its difference from a blur over the eight neighbours, as webm-decoder.c says it scales.
 * Worked out here independently of the decoder.
 */
function scaledByHand(source: number[], width: number, height: number, toWidth: number, toHeight: number): number[] {
  const within = (value: number, most: number) => Math.min(Math.max(value, 0), most);
  const across = lanczosTaps(width, toWidth);
  const down = lanczosTaps(height, toHeight);
  const rows = new Float64Array(toWidth * height * 4);
  for (let y = 0; y < height; y++)
    for (let t = 0; t < toWidth; t++)
      for (let c = 0; c < 4; c++)
        rows[(y * toWidth + t) * 4 + c] = across[t].weights.reduce(
          (sum, weight, k) => sum + weight * source[(y * width + within(across[t].first + k, width - 1)) * 4 + c],
          0,
        );
  const fitted = new Float64Array(toWidth * toHeight * 4);
  for (let t = 0; t < toHeight; t++)
    for (let x = 0; x < toWidth; x++)
      for (let c = 0; c < 4; c++)
        fitted[(t * toWidth + x) * 4 + c] = down[t].weights.reduce(
          (sum, weight, k) => sum + weight * rows[(within(down[t].first + k, height - 1) * toWidth + x) * 4 + c],
          0,
        );
  return Array.from(fitted, (value, at) => {
    const [x, y, c] = [(at >> 2) % toWidth, Math.floor((at >> 2) / toWidth), at & 3];
    let blurred = 0;
    for (const dy of [-1, 0, 1])
      for (const dx of [-1, 0, 1])
        blurred +=
          (2 - Math.abs(dy)) *
          (2 - Math.abs(dx)) *
          fitted[(within(y + dy, toHeight - 1) * toWidth + within(x + dx, toWidth - 1)) * 4 + c];
    return within(Math.round(value + 0.7 * (value - blurred / 16)), 255);
  });
}

// Detects: a change to how video frames are scaled down (another filter, another amount of sharpening). The
// comparison of a copy with its original draws the original with this scaling, so after such a change the copies
// that earlier versions made no longer pass it. The scaling itself was chosen by eye, blind, on real stickers.
it('scales with a Lanczos filter and sharpens, as worked out independently', () => {
  // The video's own pixels, 64 x 48 from y = 8 of the square, with colours multiplied by opacity.
  const own = new Uint8Array(renderWebm(decoder, file, 64, 10, 1)[0]);
  const source: number[] = [];
  for (let at = 8 * 64 * 4; at < 56 * 64 * 4; at += 4)
    source.push(...[0, 1, 2].map((c) => Math.floor((own[at + c] * own[at + 3] + 127) / 255)), own[at + 3]);
  // At 40 pixels the video is 40 x 30 from y = 5.
  const expected = scaledByHand(source, 64, 48, 40, 30);
  const scaled = new Uint8Array(renderWebm(decoder, file, 40, 10, 1)[0]);
  let largest = 0;
  for (let i = 0; i < 40 * 30; i++) {
    const at = (5 * 40 + i) * 4;
    const opacity = scaled[at + 3];
    largest = Math.max(largest, Math.abs(opacity - expected[i * 4 + 3]));
    for (let c = 0; c < 3; c++)
      largest = Math.max(largest, Math.abs((scaled[at + c] * opacity) / 255 - expected[i * 4 + c]));
  }
  expect(largest).toBeLessThanOrEqual(2);
  // The filter leaves a faint halo beside a hard edge, and overshoots inside it: both are there.
  expect(expected.some((value, at) => at % 4 === 3 && value > 0 && value < 30)).toBe(true);
});
