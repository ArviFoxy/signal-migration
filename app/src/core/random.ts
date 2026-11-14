// Random bytes from the browser's cryptographic generator. Every draw of random bytes in the app is made here.
//
// A random whole number in a range is not made here from bytes: turning bytes into a range is where a bias comes
// in. It comes from the `rand` library in the Rust module (`randomInt` in crates/signal-wasm/src/crypto.rs).

/** `count` random bytes. */
export const randomBytes = (count: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(count));

/** `byteCount` random bytes as hexadecimal digits. */
export const randomHex = (byteCount: number): string =>
  Array.from(randomBytes(byteCount), (byte) => byte.toString(16).padStart(2, '0')).join('');
