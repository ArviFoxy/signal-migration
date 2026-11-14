// How different two drawings of a sticker are.

/** The side of the squares in which two frames are compared, in pixels. */
export const SQUARE = 16;
/**
 * How far apart the squares are placed. They overlap by half, so that a mark up to this wide lies whole in one of
 * them wherever it is. With squares side by side, a mark on the line between two of them counts half in each, and
 * on a corner a quarter.
 */
const STEP = SQUARE / 2;

type Frame = Uint8Array | Uint8ClampedArray;
/** A rectangle of a frame: the pixels from `left` to before `right` and from `top` to before `bottom`. */
type Part = { left: number; top: number; right: number; bottom: number };

/**
 * One value of a pixel, in units of 1/255: a colour multiplied by the pixel's opacity, or for channel 3 the
 * opacity itself. The colour of a transparent pixel is 0 this way, whatever the file holds for it.
 */
const valueAt = (frame: Frame, at: number, channel: number) =>
  channel === 3 ? frame[at + 3] * 255 : frame[at + channel] * frame[at + 3];

/** The sum over a part of how far the values of two frames lie apart, pixel by pixel, in units of 1/255. */
function apart(one: Frame, other: Frame, width: number, { left, top, right, bottom }: Part) {
  let sum = 0;
  for (let y = top; y < bottom; y++) {
    for (let at = (y * width + left) * 4; at < (y * width + right) * 4; at += 4) {
      for (let channel = 0; channel < 4; channel++) {
        sum += Math.abs(valueAt(one, at, channel) - valueAt(other, at, channel));
      }
    }
  }
  return sum;
}

/**
 * The sum over a part of how far the values of `frame` lie outside what `other` allows at the same place, in units
 * of 1/255. `other` allows its own value there and, on either side of it, up to half the range of its values at
 * that pixel and the eight around it, and nothing outside that range.
 */
function outsideAllowed(frame: Frame, other: Frame, width: number, height: number, { left, top, right, bottom }: Part) {
  let sum = 0;
  for (let y = top; y < bottom; y++) {
    const firstRow = Math.max(y - 1, 0);
    const lastRow = Math.min(y + 1, height - 1);
    for (let x = left; x < right; x++) {
      const firstColumn = Math.max(x - 1, 0);
      const lastColumn = Math.min(x + 1, width - 1);
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const value = valueAt(frame, at, channel);
        const there = valueAt(other, at, channel);
        // An equal value is allowed whatever the neighbours are, so they need no look.
        if (value === there) continue;
        let least = there;
        let most = there;
        for (let row = firstRow; row <= lastRow; row++) {
          for (let near = (row * width + firstColumn) * 4; near <= (row * width + lastColumn) * 4; near += 4) {
            const neighbour = valueAt(other, near, channel);
            if (neighbour < least) least = neighbour;
            if (neighbour > most) most = neighbour;
          }
        }
        const slack = (most - least) / 2;
        if (value < there) sum += Math.max(0, Math.max(least, there - slack) - value);
        else sum += Math.max(0, value - Math.min(most, there + slack));
      }
    }
  }
  return sum;
}

/**
 * The largest difference between two RGBA frames of the same size, taken square by square: within each square of
 * SQUARE × SQUARE pixels, the mean over the four channels of how far each value lies from what the other frame
 * allows there. The colours are multiplied by their opacity first, so the colour of a transparent pixel does not
 * count. The result lies between 0 and 255.
 *
 * A mean over the whole frame would hide a change to a small part of the picture. The largest square does not.
 *
 * A frame allows more than its own value where the picture changes from one pixel to the next: up to half the range
 * of the pixel and its eight neighbours, on either side of its value. Two browsers draw the same edge up to half a
 * pixel apart, which changes how much of an edge pixel each side covers by up to half, and so its value by up to
 * half that range. Without this, such an edge counts for more than anything encoding loses. In a plain area the
 * range is nothing, and every difference counts in full. Each frame is held against what the other allows and the
 * larger result counts, so that a line or a spot that only one of them has is not forgiven by its own range.
 *
 * `atLeast` is a difference that is already known, such as the largest of the earlier frames of an animation. The
 * result is the larger of it and this frame's difference, and squares that cannot exceed it are passed over.
 */
export function largestDifference(one: Frame, other: Frame, width: number, height: number, atLeast = 0): number {
  if (one.length !== width * height * 4 || other.length !== one.length) {
    throw new Error('the frames do not have the stated size');
  }
  // The frame in blocks of STEP × STEP pixels, of which a square is four, so that the squares that share a block
  // share the work on it.
  const across = Math.ceil(width / STEP);
  const down = Math.ceil(height / STEP);
  const block = (column: number, row: number): Part => ({
    left: column * STEP,
    top: row * STEP,
    right: Math.min((column + 1) * STEP, width),
    bottom: Math.min((row + 1) * STEP, height),
  });
  const liesApart = new Float64Array(across * down);
  for (let row = 0; row < down; row++) {
    for (let column = 0; column < across; column++) {
      liesApart[row * across + column] = apart(one, other, width, block(column, row));
    }
  }
  // How far each frame lies outside what the other allows, per block. Worked out when a square first needs it.
  const oneOutside = new Float64Array(across * down).fill(-1);
  const otherOutside = new Float64Array(across * down).fill(-1);

  let largest = atLeast;
  // The last square of a row or column starts one block before the end, so that none is narrower than a block.
  for (let row = 0; row === 0 || row + 1 < down; row++) {
    for (let column = 0; column === 0 || column + 1 < across; column++) {
      const lastRow = Math.min(row + 1, down - 1);
      const lastColumn = Math.min(column + 1, across - 1);
      const pixels =
        (Math.min((row + 2) * STEP, height) - row * STEP) * (Math.min((column + 2) * STEP, width) - column * STEP);
      const scale = pixels * 4 * 255;
      // What a frame allows always includes its own value, so a square never counts for more than its values lie
      // apart. Where that is no more than the largest difference so far, the square cannot change the result, and
      // most squares are settled this way, without a look at the neighbours.
      let squareApart = 0;
      for (let blockRow = row; blockRow <= lastRow; blockRow++) {
        for (let blockColumn = column; blockColumn <= lastColumn; blockColumn++) {
          squareApart += liesApart[blockRow * across + blockColumn];
        }
      }
      if (squareApart / scale <= largest) continue;
      let oneSum = 0;
      let otherSum = 0;
      for (let blockRow = row; blockRow <= lastRow; blockRow++) {
        for (let blockColumn = column; blockColumn <= lastColumn; blockColumn++) {
          const index = blockRow * across + blockColumn;
          if (oneOutside[index] < 0) {
            oneOutside[index] = outsideAllowed(one, other, width, height, block(blockColumn, blockRow));
            otherOutside[index] = outsideAllowed(other, one, width, height, block(blockColumn, blockRow));
          }
          oneSum += oneOutside[index];
          otherSum += otherOutside[index];
        }
      }
      largest = Math.max(largest, Math.max(oneSum, otherSum) / scale);
    }
  }
  return largest;
}
