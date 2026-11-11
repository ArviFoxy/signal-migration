// Whether a PNG file holds nothing but its picture.
//
// A PNG file is a list of chunks. Some kinds of chunk make one decoder show another picture than the next one
// does: a first picture that is not part of the animation, colour corrections, or data a decoder skips when its
// checksum is wrong. A sticker that others uploaded is compared as this page's decoder shows it, so it may hold
// only the chunks that the app's own encoder writes, in an order that leaves no such choice.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The chunks that the app's encoder (upng-js) writes. */
const KINDS = new Set(['IHDR', 'sRGB', 'acTL', 'PLTE', 'tRNS', 'fcTL', 'IDAT', 'fdAT', 'IEND']);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/** The CRC-32 checksum that PNG uses. */
function checksum(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Whether `file` is a PNG or animated PNG that holds only the chunks the app's encoder writes, each with a correct
 * checksum, from the header chunk to the end chunk with nothing after it. In an animated one, the animation's first
 * frame is the file's first picture.
 */
export function isPlainPng(file: Uint8Array): boolean {
  if (file.length < SIGNATURE.length || SIGNATURE.some((byte, i) => file[i] !== byte)) return false;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const kinds: string[] = [];
  let at = SIGNATURE.length;
  while (at < file.length) {
    if (at + 12 > file.length) return false;
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > file.length) return false;
    const kind = String.fromCharCode(...file.subarray(at + 4, at + 8));
    if (!KINDS.has(kind)) return false;
    if (checksum(file.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) return false;
    kinds.push(kind);
    at = end;
    if (kind === 'IEND') break;
  }
  if (at !== file.length || kinds[0] !== 'IHDR' || kinds[kinds.length - 1] !== 'IEND') return false;
  if (
    kinds.filter((kind) => kind === 'IHDR' || kind === 'IEND' || kind === 'acTL').length !==
    (kinds.includes('acTL') ? 3 : 2)
  ) {
    return false;
  }
  const firstPicture = kinds.indexOf('IDAT');
  if (firstPicture < 0) return false;
  if (!kinds.includes('acTL')) return !kinds.includes('fcTL') && !kinds.includes('fdAT');
  // The animation is announced before the first picture, and a frame starts before it: the first picture is a frame.
  const firstFrame = kinds.indexOf('fcTL');
  return kinds.indexOf('acTL') < firstPicture && firstFrame >= 0 && firstFrame < firstPicture;
}
