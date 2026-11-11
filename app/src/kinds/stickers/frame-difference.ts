// How different two drawings of a sticker are.

/** The side of the squares in which two frames are compared, in pixels. */
export const SQUARE = 16;

/**
 * The largest difference between two RGBA frames of the same size, taken square by square: within each square of
 * SQUARE × SQUARE pixels, the mean absolute difference of the four channels. The colours are multiplied by their
 * opacity first, so the colour of a transparent pixel does not count. The result lies between 0 and 255.
 *
 * A mean over the whole frame would hide a change to a small part of the picture. The largest square does not.
 */
export function largestDifference(
  one: Uint8Array | Uint8ClampedArray,
  other: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): number {
  if (one.length !== width * height * 4 || other.length !== one.length) {
    throw new Error('the frames do not have the stated size');
  }
  let largest = 0;
  for (let top = 0; top < height; top += SQUARE) {
    for (let left = 0; left < width; left += SQUARE) {
      const bottom = Math.min(top + SQUARE, height);
      const right = Math.min(left + SQUARE, width);
      let sum = 0;
      for (let y = top; y < bottom; y++) {
        for (let at = (y * width + left) * 4; at < (y * width + right) * 4; at += 4) {
          const opacity = one[at + 3];
          const otherOpacity = other[at + 3];
          sum += Math.abs(opacity - otherOpacity);
          for (let channel = 0; channel < 3; channel++) {
            sum += Math.abs(one[at + channel] * opacity - other[at + channel] * otherOpacity) / 255;
          }
        }
      }
      largest = Math.max(largest, sum / ((bottom - top) * (right - left) * 4));
    }
  }
  return largest;
}
