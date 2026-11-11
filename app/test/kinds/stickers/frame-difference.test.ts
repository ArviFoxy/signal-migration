// How different two drawings are: the measure that decides whether a converted sticker shows its original.

import { describe, expect, it } from 'vitest';
import { largestDifference } from '../../../src/kinds/stickers/frame-difference';

/** A frame of `width` × `height` pixels, each of the colour `rgba`. */
function frame(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let at = 0; at < pixels.length; at += 4) pixels.set(rgba, at);
  return pixels;
}

/** Paints the rectangle from (left, top), `wide` × `high`, in the colour `rgba`. */
function paint(
  pixels: Uint8Array,
  width: number,
  [left, top, wide, high]: number[],
  rgba: [number, number, number, number],
): Uint8Array {
  for (let y = top; y < top + high; y++) for (let x = left; x < left + wide; x++) pixels.set(rgba, (y * width + x) * 4);
  return pixels;
}

describe('the difference between two frames', () => {
  // Detects: equal frames measured as different, which would refuse every honest copy.
  it('is zero for equal frames', () => {
    const grey = frame(64, 48, [90, 90, 90, 255]);
    expect(largestDifference(grey, grey.slice(), 64, 48)).toBe(0);
  });

  // Detects: a change to a small part of a large picture averaged away. One square of 16 × 16 pixels whose red
  // channel differs by 100 gives 100 / 4 = 25 in that square, and 0.02 as a mean over the frame of 512 × 512.
  it('is that of the most different square, not the mean over the frame', () => {
    const one = frame(512, 512, [10, 10, 10, 255]);
    const other = paint(one.slice(), 512, [160, 320, 16, 16], [110, 10, 10, 255]);
    expect(largestDifference(one, other, 512, 512)).toBe(25);
  });

  // Detects: the colour of pixels that nobody sees counted. An encoder is free to change it.
  it('ignores the colour of transparent pixels', () => {
    expect(largestDifference(frame(32, 32, [200, 0, 0, 0]), frame(32, 32, [0, 0, 200, 0]), 32, 32)).toBe(0);
  });

  // Detects: opacity left out, so that a picture could be made to appear or vanish. Opaque white against fully
  // transparent differs by 255 in every channel.
  it('counts a change of opacity', () => {
    expect(largestDifference(frame(32, 32, [255, 255, 255, 255]), frame(32, 32, [255, 255, 255, 0]), 32, 32)).toBe(255);
  });

  // Detects: the small errors of reducing a picture to 256 colours measured as large. Every colour channel off by 2
  // gives 3 × 2 / 4 = 1.5.
  it('is small for small errors in every pixel', () => {
    expect(largestDifference(frame(48, 48, [100, 100, 100, 255]), frame(48, 48, [102, 98, 102, 255]), 48, 48)).toBe(
      1.5,
    );
  });

  // Detects: the squares at the right and bottom edge, which are narrower when the size is no multiple of 16,
  // skipped or averaged over pixels they do not have. A strip 4 pixels wide whose red channel differs by 80 gives
  // 80 / 4 = 20.
  it('measures the narrower squares at the edges over their own pixels', () => {
    const one = frame(20, 20, [0, 0, 0, 255]);
    const other = paint(one.slice(), 20, [16, 0, 4, 20], [80, 0, 0, 255]);
    expect(largestDifference(one, other, 20, 20)).toBe(20);
  });

  // Detects: frames of other sizes than stated compared as far as they go.
  it('refuses frames that do not have the stated size', () => {
    expect(() => largestDifference(frame(16, 16, [0, 0, 0, 0]), frame(16, 15, [0, 0, 0, 0]), 16, 16)).toThrow();
  });
});
