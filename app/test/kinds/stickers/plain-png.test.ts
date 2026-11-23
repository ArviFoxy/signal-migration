// Which PNG files hold nothing but their picture. A copy of an animated sticker must be such a file, so that it
// cannot show one thing in this page and another in a Signal app.

import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import UPNG from 'upng-js';
import { isPlainPng } from '../../../src/kinds/stickers/plain-png';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Chunk = { kind: string; data: Uint8Array };

/** The chunks of a PNG file. */
function chunksOf(file: Uint8Array): Chunk[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const chunks: Chunk[] = [];
  for (let at = SIGNATURE.length; at < file.length;) {
    const length = view.getUint32(at);
    chunks.push({
      kind: String.fromCharCode(...file.subarray(at + 4, at + 8)),
      data: file.slice(at + 8, at + 8 + length),
    });
    at += 12 + length;
  }
  return chunks;
}

/** A PNG file of these chunks, each with its checksum, computed by Node's zlib. */
function fileOf(chunks: Chunk[]): Uint8Array {
  const bytes: number[] = [...SIGNATURE];
  for (const { kind, data } of chunks) {
    const body = new Uint8Array([...kind].map((letter) => letter.charCodeAt(0)).concat([...data]));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, data.length);
    const sum = new Uint8Array(4);
    new DataView(sum.buffer).setUint32(0, crc32(body));
    bytes.push(...length, ...body, ...sum);
  }
  return new Uint8Array(bytes);
}

const pixels = (value: number) => new Uint8Array(8 * 8 * 4).fill(value).buffer;
/** An animation of three frames and a single picture, as the app's encoder writes them. */
const animation = new Uint8Array(UPNG.encode([pixels(40), pixels(120), pixels(200)], 8, 8, 256, [33, 33, 33]));
const still = new Uint8Array(UPNG.encode([pixels(40)], 8, 8, 256));

describe('a plain PNG file', () => {
  // Detects: the app's own conversions refused, which would make every pack with animations fail its comparison.
  it('is what the encoder of the app writes, animated or not', () => {
    expect(isPlainPng(animation)).toBe(true);
    expect(isPlainPng(still)).toBe(true);
    expect(isPlainPng(fileOf(chunksOf(animation)))).toBe(true);
  });

  // Detects: conversions of the size and kind the app really makes refused: more colours than the palette holds,
  // transparency, and frames that differ in every pixel.
  it("is what the encoder writes for an animation of a sticker's size", () => {
    const size = 128;
    const frames = Array.from({ length: 10 }, (_, frame) => {
      const rgba = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          rgba.set(
            [(x * 2 + frame * 20) % 256, (y * 2) % 256, (x + y + frame * 7) % 256, x < 20 ? 0 : 255],
            (y * size + x) * 4,
          );
        }
      }
      return rgba.buffer;
    });
    const delays = frames.map(() => 33);
    expect(isPlainPng(new Uint8Array(UPNG.encode(frames, size, size, 256, delays)))).toBe(true);
  });

  // Detects: chunks that change what a decoder shows, or that hide data, let through.
  it('holds no chunk of another kind', () => {
    for (const kind of ['tEXt', 'gAMA', 'iCCP', 'eXIf', 'zTXt']) {
      const chunks = chunksOf(animation);
      chunks.splice(1, 0, { kind, data: new Uint8Array([1, 2, 3]) });
      expect(isPlainPng(fileOf(chunks)), kind).toBe(false);
    }
  });

  // Detects: an animated file whose first picture is not a frame. Decoders that do not know animations show that
  // picture, and decoders that do never show it.
  it('has the first frame of its animation as its first picture', () => {
    const chunks = chunksOf(animation);
    const firstFrame = chunks.findIndex((chunk) => chunk.kind === 'fcTL');
    const firstPicture = chunks.findIndex((chunk) => chunk.kind === 'IDAT');
    expect(firstFrame).toBeLessThan(firstPicture);
    const [frame] = chunks.splice(firstFrame, 1);
    chunks.splice(firstPicture, 0, frame);
    expect(isPlainPng(fileOf(chunks))).toBe(false);
  });

  // Detects: a chunk with a wrong checksum accepted. Some decoders skip such a chunk and others read it.
  it('has a correct checksum on every chunk', () => {
    const file = animation.slice();
    const end = file.length - 12;
    file[end - 1] ^= 1;
    expect(isPlainPng(file)).toBe(false);
  });

  // Detects: bytes after the end of the picture, a file cut short, or something that is no PNG file accepted.
  it('is a whole PNG file with nothing after it', () => {
    expect(isPlainPng(new Uint8Array([...animation, 0]))).toBe(false);
    expect(isPlainPng(animation.subarray(0, animation.length - 5))).toBe(false);
    expect(isPlainPng(animation.subarray(0, 20))).toBe(false);
    expect(isPlainPng(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isPlainPng(new Uint8Array())).toBe(false);
    const twoPictures = chunksOf(still);
    expect(isPlainPng(fileOf([...twoPictures, ...twoPictures]))).toBe(false);
  });

  // Detects: a file that announces its animation twice, or announces none and still carries frames.
  it('announces its animation once, before the first picture, or not at all', () => {
    const chunks = chunksOf(animation);
    const announced = chunks.findIndex((chunk) => chunk.kind === 'acTL');
    expect(
      isPlainPng(fileOf([...chunks.slice(0, announced + 1), chunks[announced], ...chunks.slice(announced + 1)])),
    ).toBe(false);
    expect(isPlainPng(fileOf(chunks.filter((chunk) => chunk.kind !== 'acTL')))).toBe(false);
    const late = chunks.filter((chunk) => chunk.kind !== 'acTL');
    late.splice(late.findIndex((chunk) => chunk.kind === 'IDAT') + 1, 0, chunks[announced]);
    expect(isPlainPng(fileOf(late))).toBe(false);
  });

  // Detects: APNG polyglot where fdAT immediately follows IDAT without a preceding fcTL, or where sequence numbers,
  // frame counts, play counts, IHDR dimensions, or frame rectangles are malformed.
  it('rejects APNG polyglots, bad sequence numbers, non-zero play count, and oversized IHDR', () => {
    const chunks = chunksOf(animation);
    const idatIdx = chunks.findIndex((c) => c.kind === 'IDAT');
    const firstFdat = chunks.find((c) => c.kind === 'fdAT')!;

    // 1. Polyglot: fdAT placed directly after IDAT without an intervening fcTL.
    const polyglot = chunks.slice();
    polyglot.splice(idatIdx + 1, 0, { kind: 'fdAT', data: firstFdat.data.slice() });
    expect(isPlainPng(fileOf(polyglot)), 'fdAT directly after IDAT').toBe(false);

    // 2. Non-zero acTL.num_plays (Signal requires infinite loop num_plays === 0).
    const finiteLoop = chunks.map((c) => {
      if (c.kind !== 'acTL') return c;
      const data = c.data.slice();
      new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(4, 1);
      return { kind: c.kind, data };
    });
    expect(isPlainPng(fileOf(finiteLoop)), 'non-zero num_plays').toBe(false);

    // 3. Corrupted fcTL sequence_number (skipping from 0 to 99).
    const badSeq = chunks.map((c, idx) => {
      if (c.kind !== 'fcTL' || idx <= idatIdx) return c;
      const data = c.data.slice();
      new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(0, 99);
      return { kind: c.kind, data };
    });
    expect(isPlainPng(fileOf(badSeq)), 'non-monotonic sequence_number').toBe(false);

    // 4. Out-of-bounds fcTL frame rectangle (x_offset + width > IHDR width).
    const outOfBounds = chunks.map((c, idx) => {
      if (c.kind !== 'fcTL' || idx <= idatIdx) return c;
      const data = c.data.slice();
      new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(12, 5); // x_offset=5, width=8 > 8
      return { kind: c.kind, data };
    });
    expect(isPlainPng(fileOf(outOfBounds)), 'out-of-bounds fcTL rect').toBe(false);

    // 5. Oversized IHDR (decompression bomb: 4096x4096).
    const huge = chunksOf(still).map((c) => {
      if (c.kind !== 'IHDR') return c;
      const data = c.data.slice();
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      view.setUint32(0, 4096);
      view.setUint32(4, 4096);
      return { kind: c.kind, data };
    });
    expect(isPlainPng(fileOf(huge)), 'oversized IHDR 4096x4096').toBe(false);

    // 6. Frame 0 fcTL with dispose_op = 2 (APNG_DISPOSE_OP_PREVIOUS is invalid on frame 0).
    const badFrame0Dispose = chunks.map((c, idx) => {
      if (c.kind !== 'fcTL' || idx > idatIdx) return c;
      const data = c.data.slice();
      data[24] = 2;
      return { kind: c.kind, data };
    });
    expect(isPlainPng(fileOf(badFrame0Dispose)), 'frame 0 dispose_op=2').toBe(false);

    // 7. Non-empty IEND chunk.
    const nonEmptyIend = chunksOf(still).map((c) =>
      c.kind === 'IEND' ? { kind: 'IEND', data: new Uint8Array([1]) } : c,
    );
    expect(isPlainPng(fileOf(nonEmptyIend)), 'non-empty IEND').toBe(false);
  });
});
