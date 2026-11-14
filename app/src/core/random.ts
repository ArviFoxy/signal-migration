// Random bytes and numbers from the browser's cryptographic generator. Everything random in the app is drawn here,
// so that the few ways of getting it wrong are in one place.

/** `count` random bytes. */
export const randomBytes = (count: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(count));

/** `byteCount` random bytes as hexadecimal digits. */
export const randomHex = (byteCount: number): string =>
  Array.from(randomBytes(byteCount), (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * A whole number from `min` to `max`, each equally likely.
 *
 * The remainder of a random 32-bit number is not used: unless the count of wanted numbers divides 2^32, the
 * remainders at the low end come up slightly more often. Instead, as many random bits are taken as the count needs,
 * and a draw that falls outside it is thrown away and drawn again. Fewer than half of the draws are thrown away.
 */
export function randomInt(min: number, max: number): number {
  const count = max - min + 1;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || count < 1 || count > 2 ** 32) {
    throw new Error(`no random number can be drawn from ${min} to ${max}`);
  }
  const mask = 2 ** Math.ceil(Math.log2(count)) - 1;
  for (;;) {
    const drawn = (crypto.getRandomValues(new Uint32Array(1))[0] & mask) >>> 0;
    if (drawn < count) return min + drawn;
  }
}
