// Whether a PNG file holds nothing but its picture.
//
// A PNG file is a list of chunks. Some kinds of chunk make one decoder show another picture than the next one
// does: a first picture that is not part of the animation, colour corrections, or data a decoder skips when its
// checksum is wrong. A sticker that others uploaded is compared as this page's decoder shows it, so it may hold
// only the chunks that the app's own encoder writes, in a strict canonical order with validated headers, bounds,
// and APNG sequence numbers that leave no room for polyglots or oversized decompression bombs.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The chunks that the app's encoder (upng-js) writes. */
const KINDS = new Set(['IHDR', 'sRGB', 'acTL', 'PLTE', 'tRNS', 'fcTL', 'IDAT', 'fdAT', 'IEND']);

const MAX_PNG_SIZE = 512;
const MAX_PNG_FRAMES = 300;
const MAX_DECODED_RGBA_BYTES = 160 * 1024 * 1024;

const VALID_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

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

type Chunk = { kind: string; data: Uint8Array; view: DataView };

function parseChunks(file: Uint8Array): Chunk[] | null {
  if (file.length < SIGNATURE.length || SIGNATURE.some((byte, i) => file[i] !== byte)) return null;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const chunks: Chunk[] = [];
  let at = SIGNATURE.length;
  while (at < file.length) {
    if (at + 12 > file.length) return null;
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > file.length) return null;
    const kind = String.fromCharCode(...file.subarray(at + 4, at + 8));
    if (!KINDS.has(kind)) return null;
    if (checksum(file.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) return null;
    const data = file.subarray(at + 8, at + 8 + length);
    chunks.push({ kind, data, view: new DataView(data.buffer, data.byteOffset, data.byteLength) });
    at = end;
    if (kind === 'IEND') break;
  }
  if (at !== file.length || chunks.length < 3) return null;
  if (chunks[0].kind !== 'IHDR' || chunks[chunks.length - 1].kind !== 'IEND') return null;
  if (chunks[chunks.length - 1].data.length !== 0) return null;
  return chunks;
}

/**
 * Whether `file` is a PNG or animated PNG that holds only the chunks the app's encoder writes, each with a correct
 * checksum, valid IHDR/acTL/fcTL/fdAT structure, bounded dimensions and frame count, and monotonic APNG sequence
 * numbers, from the header chunk to an empty end chunk with nothing after it. In an animated one, the animation's
 * first frame is the file's first picture (`IDAT`) and loops forever (`num_plays === 0`).
 */
export function isPlainPng(file: Uint8Array): boolean {
  const chunks = parseChunks(file);
  if (!chunks) return false;

  // Validate IHDR (must be unique and first).
  const ihdr = chunks[0];
  if (ihdr.data.length !== 13) return false;
  const width = ihdr.view.getUint32(0);
  const height = ihdr.view.getUint32(4);
  if (width < 1 || height < 1 || width > MAX_PNG_SIZE || height > MAX_PNG_SIZE) return false;
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const compression = ihdr.data[10];
  const filter = ihdr.data[11];
  const interlace = ihdr.data[12];
  const allowedDepths = VALID_BIT_DEPTHS[colorType];
  if (!allowedDepths || !allowedDepths.includes(bitDepth)) return false;
  if (compression !== 0 || filter !== 0 || interlace !== 0) return false;

  let seenSrgb = false;
  let seenPlte = false;
  let plteEntries = 0;
  let seenTrns = false;
  let animated = false;
  let expectedFrames = 0;
  let expectedSeq = 0;
  let fcTLCount = 0;

  // State machine over chunks between IHDR and IEND:
  // - 'pre-idat': sRGB, PLTE, tRNS, optional acTL, and (if animated) frame 0's fcTL.
  // - 'in-idat': one or more contiguous IDAT chunks (frame 0).
  // - 'expect-fdat': immediately after an fcTL for frame >= 1; requires at least one fdAT.
  // - 'in-fdat': one or more contiguous fdAT chunks; followed by next fcTL or IEND.
  let stage: 'pre-idat' | 'in-idat' | 'expect-fdat' | 'in-fdat' = 'pre-idat';

  for (let i = 1; i < chunks.length - 1; i++) {
    const { kind, data, view } = chunks[i];
    switch (kind) {
      case 'IHDR':
      case 'IEND':
        return false;

      case 'sRGB':
        if (stage !== 'pre-idat' || seenSrgb || seenPlte || data.length !== 1 || data[0] > 3) return false;
        seenSrgb = true;
        break;

      case 'PLTE':
        if (
          stage !== 'pre-idat' ||
          seenPlte ||
          seenTrns ||
          colorType === 0 ||
          colorType === 4 ||
          data.length < 3 ||
          data.length > 768 ||
          data.length % 3 !== 0
        ) {
          return false;
        }
        seenPlte = true;
        plteEntries = data.length / 3;
        break;

      case 'tRNS':
        if (stage !== 'pre-idat' || seenTrns) return false;
        if (colorType === 3) {
          if (!seenPlte || data.length === 0 || data.length > plteEntries) return false;
        } else if (colorType === 0) {
          if (data.length !== 2) return false;
        } else if (colorType === 2) {
          if (data.length !== 6) return false;
        } else {
          return false;
        }
        seenTrns = true;
        break;

      case 'acTL': {
        if (stage !== 'pre-idat' || animated || data.length !== 8) return false;
        const numFrames = view.getUint32(0);
        const numPlays = view.getUint32(4);
        if (numPlays !== 0) return false;
        if (numFrames < 1 || numFrames > MAX_PNG_FRAMES) return false;
        if (width * height * 4 * numFrames > MAX_DECODED_RGBA_BYTES) return false;
        animated = true;
        expectedFrames = numFrames;
        break;
      }

      case 'fcTL': {
        if (data.length !== 26) return false;
        if (stage === 'pre-idat') {
          // Frame 0's fcTL must appear before IDAT (so IDAT IS frame 0), and only once before IDAT.
          if (!animated || fcTLCount !== 0) return false;
        } else if (stage === 'in-idat' || stage === 'in-fdat') {
          if (!animated) return false;
        } else {
          // Cannot have two fcTLs in a row without fdAT in between.
          return false;
        }
        const seq = view.getUint32(0);
        const frameWidth = view.getUint32(4);
        const frameHeight = view.getUint32(8);
        const xOffset = view.getUint32(12);
        const yOffset = view.getUint32(16);
        const disposeOp = data[24];
        const blendOp = data[25];
        if (seq !== expectedSeq++) return false;
        if (frameWidth < 1 || frameHeight < 1) return false;
        if (xOffset + frameWidth > width || yOffset + frameHeight > height) return false;
        if (disposeOp > 2 || blendOp > 1) return false;
        if (fcTLCount === 0) {
          // APNG spec: frame 0 must match IHDR dimensions at (0, 0) and must not use DISPOSE_OP_PREVIOUS (2).
          if (xOffset !== 0 || yOffset !== 0 || frameWidth !== width || frameHeight !== height || disposeOp === 2) {
            return false;
          }
        }
        fcTLCount++;
        if (fcTLCount > expectedFrames) return false;
        if (stage !== 'pre-idat') stage = 'expect-fdat';
        break;
      }

      case 'IDAT':
        if (stage === 'pre-idat') {
          if (colorType === 3 && !seenPlte) return false;
          if (animated && fcTLCount !== 1) return false;
          stage = 'in-idat';
        } else if (stage !== 'in-idat') {
          // Non-contiguous IDAT after fcTL/fdAT is invalid PNG.
          return false;
        }
        break;

      case 'fdAT': {
        if (!animated || (stage !== 'expect-fdat' && stage !== 'in-fdat')) return false;
        if (data.length < 4) return false;
        const seq = view.getUint32(0);
        if (seq !== expectedSeq++) return false;
        stage = 'in-fdat';
        break;
      }

      default:
        return false;
    }
  }

  if (stage === 'pre-idat' || stage === 'expect-fdat') return false;
  if (animated && fcTLCount !== expectedFrames) return false;
  return true;
}
