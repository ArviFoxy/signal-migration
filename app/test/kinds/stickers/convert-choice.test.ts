// Which size and frame rate the conversion takes for an animation that does not fit Signal's limit at full quality
// (convert.ts bestRated). The expectations are judgments made by eye on real stickers on 2026-11-11: each case lists
// the sizes and frame rates that fit one sticker and names the one that looked best.

import { describe, expect, it } from 'vitest';
import {
  allowedFrameRates,
  type Animation,
  bestRated,
  type Candidate,
  frameDelay,
  PIXELS_PER_FRAME_RATE,
  predictedBytes,
  SIZES,
} from '../../../src/kinds/stickers/convert';

/** Candidates for an animation of three seconds, written as "size@rate". */
const candidates = (...options: string[]): Candidate[] =>
  options.map((option) => {
    const [size, rate] = option.split('@').map(Number);
    return { size, rate, frames: Math.round(3 * rate) };
  });
const chosen = (kind: 'tgs' | 'webm', ...options: string[]) => {
  const best = bestRated(candidates(...options), PIXELS_PER_FRAME_RATE[kind])!;
  return `${best.size}@${best.rate}`;
};

describe('the size and frame rate taken for an animation that has to be reduced', () => {
  // Detects: vector animations coming out large but nearly still, or moving well but blurred, where a middle
  // choice looked best.
  it.each([
    [['384@4', '256@6', '192@8', '128@15', '128@12'], '192@8'],
    [['256@5', '192@6', '128@12'], '192@6'],
    [['384@4', '256@6', '192@10', '128@15', '160@10'], '192@10'],
    [['256@5', '192@8', '128@12', '160@10'], '192@8'],
  ])('takes the size with a frame rate to match for a vector animation: %j', (options, judgedBest) => {
    expect(chosen('tgs', ...options)).toBe(judgedBest);
  });

  // Detects: video stickers coming out as a slide show at a larger size, where the smaller size with more frames
  // looked better every time.
  it.each([
    [['192@5', '128@10'], '128@10'],
    [['192@5', '128@12', '128@10'], '128@12'],
    [['256@4', '192@6', '128@12'], '128@12'],
    [['192@4', '128@8'], '128@8'],
  ])('keeps a video sticker moving: %j', (options, judgedBest) => {
    expect(chosen('webm', ...options)).toBe(judgedBest);
  });

  // Detects: a sticker that fits at full size reduced anyway, or a lower frame rate taken where a higher one fits
  // at the same size.
  it('takes the full size and the highest frame rate when they fit', () => {
    expect(chosen('tgs', '512@30', '512@24', '448@30', '128@4')).toBe('512@30');
    expect(chosen('webm', '512@30', '512@24', '448@30', '128@4')).toBe('512@30');
  });

  // Detects: of two candidates that rate the same, the larger and slower one taken for a video, where the smaller
  // one with more frames looked better (128 pixels at 12 frames per second against 192 at 6 and 256 at 4).
  it('takes the higher frame rate of equally rated candidates, and then the larger size', () => {
    expect(chosen('webm', '160@8', '128@12')).toBe('128@12');
    expect(chosen('tgs', '192@8', '224@8')).toBe('224@8');
  });
});

describe('the file size expected for a size and frame rate', () => {
  // A file that follows a known law: bytes = 40 x size^1.2 x frames.
  const law = (size: number, frames: number) => ({ size, frames, bytes: 40 * size ** 1.2 * frames });

  // Detects: the conversion taking a size that turns out too large, or a needlessly small one, because the
  // prediction assumes the same bytes per pixel at every size. Smaller frames keep more bytes per pixel.
  it('follows how the bytes per frame grew between the two encodings nearest in size', () => {
    const encodings = [law(512, 90), law(192, 24)];
    expect(predictedBytes(encodings, { size: 256, rate: 10, frames: 30 })).toBeCloseTo(law(256, 30).bytes, 3);
    expect(predictedBytes(encodings, { size: 128, rate: 15, frames: 45 })).toBeCloseTo(law(128, 45).bytes, 3);
  });

  // Detects: the frame rate ignored in the prediction, so that a candidate with twice the frames is expected to
  // have the same file size.
  it('grows in proportion to the number of frames', () => {
    const encodings = [law(512, 90), law(192, 24)];
    const slow = predictedBytes(encodings, { size: 192, rate: 4, frames: 12 });
    expect(predictedBytes(encodings, { size: 192, rate: 8, frames: 24 })).toBeCloseTo(2 * slow, 3);
  });

  // Detects: the first attempt not being the best candidate, because something is ruled out before anything is
  // known about the animation.
  it('rules nothing out before the first encoding', () => {
    expect(predictedBytes([], { size: 512, rate: 30, frames: 90 })).toBe(0);
  });
});

describe('the sizes and frame rates a conversion may have', () => {
  /** An animation of three seconds whose file has this frame rate. */
  const animationAt = (sourceFrameRate: number): Animation => ({
    duration: 3,
    sourceFrameRate,
    render: async () => [],
    close: () => undefined,
  });

  // Detects: copies that an earlier version of the app converted no longer accepted as conversions, because the
  // size or frame rate it took has left the set. Earlier versions took nine sizes and six frame rates, and the
  // file's own rate for a video slower than all six.
  it('still holds every size and frame rate that earlier versions took', () => {
    for (const size of [512, 448, 384, 320, 256, 224, 192, 160, 128]) expect(SIZES).toContain(size);
    for (const rate of [30, 24, 20, 15, 12, 10]) expect(allowedFrameRates(animationAt(60))).toContain(rate);
    expect(allowedFrameRates(animationAt(13.916666666666666))).toEqual(expect.arrayContaining([12, 10]));
    expect(allowedFrameRates(animationAt(8.333333333333334))).toContain(8.333333333333334);
    expect(allowedFrameRates(animationAt(2))).toEqual([2]);
  });

  // Detects: a frame rate above the file's own, which would repeat frames and spend bytes on nothing.
  it("holds no frame rate above the file's own or above 30", () => {
    expect(Math.max(...allowedFrameRates(animationAt(60)))).toBe(30);
    expect(Math.max(...allowedFrameRates(animationAt(20)))).toBe(20);
  });

  // Detects: two frame rates writing the same delay between frames into the file, so that the comparison cannot
  // tell at which of them a copy was made. A file's own rate that is no whole number shares its delay with none.
  it.each([60, 30, 13.916666666666666, 8.333333333333334])(
    'gives every frame rate its own delay between frames, for a file of %d frames per second',
    (sourceFrameRate) => {
      const delays = allowedFrameRates(animationAt(sourceFrameRate)).map(frameDelay);
      expect(new Set(delays).size).toBe(delays.length);
    },
  );

  // Detects: frame rates left out for being no round number. A file holds the delay between frames in whole
  // milliseconds, and every such delay from 33 to 250 is a frame rate the conversion can take.
  it('holds a frame rate for every delay in whole milliseconds from 33 to 250, and every size from 128 to 512', () => {
    const delays = allowedFrameRates(animationAt(60)).map(frameDelay);
    expect(delays).toEqual(Array.from({ length: 250 - 33 + 1 }, (_, step) => 33 + step));
    expect(SIZES).toEqual(Array.from({ length: 512 - 128 + 1 }, (_, step) => 512 - step));
  });
});
