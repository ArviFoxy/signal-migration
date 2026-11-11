// WebP files that hold nothing but one still picture.
//
// A WebP file is a list of chunks in a RIFF container. Besides a picture it can hold an animation, of which this
// page would draw only the first frame, and a colour profile or other data that one decoder uses and the next
// ignores. A still sticker that others uploaded is compared as this page draws it, so it may hold only one picture
// and its transparency. A browser's encoder adds a colour profile, so the app takes it out of what it uploads.

type Chunk = { kind: string; data: Uint8Array };

/** In the header chunk of the extended form, the bit that says the picture has transparency. */
const HAS_TRANSPARENCY = 0x10;
/** The chunks a file with one still picture consists of, in order: the simple forms and the extended ones. */
const LAYOUTS = new Set(['VP8 ', 'VP8L', 'VP8X,VP8 ', 'VP8X,VP8L', 'VP8X,ALPH,VP8 ']);
/** The chunks of a picture: the header of the extended form, the transparency, and the lossy or lossless picture. */
const PICTURE_KINDS = new Set(['VP8X', 'ALPH', 'VP8 ', 'VP8L']);
/** The chunks an encoder may add to a still picture: a colour profile and descriptions of the picture. */
const ADDED_KINDS = new Set(['ICCP', 'EXIF', 'XMP ']);
/** In the header chunk of the extended form, the bits that announce those added chunks. */
const ANNOUNCES_ADDED = 0x20 | 0x08 | 0x04;

/** The chunks of a WebP file; null when `file` is not one whole WebP container. */
function chunksOf(file: Uint8Array): Chunk[] | null {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const name = (at: number) => String.fromCharCode(...file.subarray(at, at + 4));
  if (file.length < 12 || name(0) !== 'RIFF' || name(8) !== 'WEBP') return null;
  if (view.getUint32(4, true) !== file.length - 8) return null;
  const chunks: Chunk[] = [];
  for (let at = 12; at < file.length;) {
    if (at + 8 > file.length) return null;
    const length = view.getUint32(at + 4, true);
    // A chunk of odd length is followed by one unused byte.
    const end = at + 8 + length + (length % 2);
    if (end > file.length) return null;
    chunks.push({ kind: name(at), data: file.subarray(at + 8, at + 8 + length) });
    at = end;
  }
  return chunks;
}

/** A WebP file of these chunks. */
function fileOf(chunks: Chunk[]): Uint8Array {
  const length = chunks.reduce((sum, { data }) => sum + 8 + data.length + (data.length % 2), 12);
  const file = new Uint8Array(length);
  const view = new DataView(file.buffer);
  const write = (at: number, text: string) =>
    file.set(
      [...text].map((letter) => letter.charCodeAt(0)),
      at,
    );
  write(0, 'RIFF');
  view.setUint32(4, length - 8, true);
  write(8, 'WEBP');
  let at = 12;
  for (const { kind, data } of chunks) {
    write(at, kind);
    view.setUint32(at + 4, data.length, true);
    file.set(data, at + 8);
    at += 8 + data.length + (data.length % 2);
  }
  return file;
}

/**
 * Whether `file` is a WebP file that holds one still picture, with or without transparency, and nothing else: no
 * animation, no colour profile, no other data, and nothing after the container.
 */
export function isPlainWebp(file: Uint8Array): boolean {
  const chunks = chunksOf(file);
  if (!chunks || !LAYOUTS.has(chunks.map((chunk) => chunk.kind).join(','))) return false;
  if (chunks[0].kind !== 'VP8X') return true;
  // The header of the extended form announces what else the file holds; only transparency may be announced.
  const header = chunks[0].data;
  return header.length === 10 && (header[0] & ~HAS_TRANSPARENCY) === 0;
}

/**
 * A still WebP picture without the colour profile and other data its encoder added: the same picture and
 * transparency, byte for byte, in a file for which isPlainWebp holds. A canvas holds sRGB colours, which is what a
 * decoder takes a picture without a profile to have. Throws when `file` is not a still WebP picture.
 */
export function plainWebp(file: Uint8Array): Uint8Array {
  const chunks = chunksOf(file);
  if (!chunks) throw new Error('the file is not a WebP file');
  const notAStill = new Error('the WebP file does not hold one still picture');
  if (chunks.some((chunk) => !PICTURE_KINDS.has(chunk.kind) && !ADDED_KINDS.has(chunk.kind))) throw notAStill;
  const picture = chunks
    .filter((chunk) => PICTURE_KINDS.has(chunk.kind))
    .map((chunk) => {
      if (chunk.kind !== 'VP8X') return chunk;
      if (chunk.data.length !== 10 || (chunk.data[0] & ~(HAS_TRANSPARENCY | ANNOUNCES_ADDED)) !== 0) throw notAStill;
      const header = chunk.data.slice();
      header[0] &= HAS_TRANSPARENCY;
      return { kind: chunk.kind, data: header };
    });
  const plain = fileOf(picture);
  if (!isPlainWebp(plain)) throw notAStill;
  return plain;
}
