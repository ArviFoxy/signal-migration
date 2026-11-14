// Random whole numbers (src/core/random.ts), with the browser's generator replaced by chosen draws.

import { afterEach, expect, it, vi } from 'vitest';
import { randomInt } from '../src/core/random';

/** Makes the generator give these 32-bit numbers, one per call. */
function draws(...numbers: number[]): void {
  const left = [...numbers];
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (left.length === 0) throw new Error('more numbers drawn than the test provides');
    (array as Uint32Array)[0] = left.shift()!;
    return array;
  });
}

afterEach(() => vi.restoreAllMocks());

// Detects: a draw outside the range folded back into it by a remainder, which makes some numbers more likely
// than others. For 1 to 16380, fourteen bits are taken, so 16380 to 16383 stand for no number of the range.
it('throws away a draw that stands for no number of the range, and draws again', () => {
  draws(16380, 16383, 41);
  expect(randomInt(1, 16380)).toBe(42);
});

// Detects: the ends of the range left out, or a number beyond them returned.
it('gives the smallest number for the smallest draw and the largest for the largest that fits', () => {
  draws(0);
  expect(randomInt(1, 16380)).toBe(1);
  draws(16379);
  expect(randomInt(1, 16380)).toBe(16380);
  draws(0xffffffff);
  expect(randomInt(0, 0xffffffff)).toBe(0xffffffff);
});

// Detects: the bits above those the range needs changing the result, which would again favour some numbers.
it('takes only as many bits of a draw as the range needs', () => {
  draws(0xabcd0000 + 7);
  expect(randomInt(1, 64)).toBe(8);
});

// Detects: a range that holds no number, or more numbers than one draw can tell apart, answered with a number.
it('refuses a range it cannot draw from', () => {
  expect(() => randomInt(5, 4)).toThrow();
  expect(() => randomInt(0, 2 ** 32)).toThrow();
});
