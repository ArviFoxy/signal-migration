// Calls into the WebM decoder (webm-decoder.c): what a video sticker is, and its frames at a size and frame rate.
// The app calls these in a worker (webm-worker.ts); the tests call them directly.

import type { WebmDecoderModule } from 'webm-decoder';

export type WebmInfo = { width: number; height: number; duration: number; frameRate: number | null };

export class WebmDecodeError extends Error {}

/** Matches MAX_FRAME_DIM and MAX_OUTPUT_BYTES in webm-decoder.c so JS never wraps a 32-bit _malloc argument. */
const MAX_FRAME_DIM = 4096;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

/** Copies `file` into the decoder's memory for `use`, and frees it afterwards. */
function withFile<T>(decoder: WebmDecoderModule, file: Uint8Array, use: (pointer: number) => T): T {
  if (file.length === 0 || file.length > MAX_FILE_BYTES) throw new WebmDecodeError('invalid video size');
  const pointer = decoder._malloc(file.length) >>> 0;
  if (!pointer) throw new WebmDecodeError('out of memory');
  try {
    decoder.HEAPU8.set(file, pointer);
    return use(pointer);
  } finally {
    decoder._free(pointer);
  }
}

const failure = (decoder: WebmDecoderModule) => new WebmDecodeError(decoder.UTF8ToString(decoder._webm_error() >>> 0));

/** The video's size, duration in seconds and frame rate (null when the file does not say). */
export function probeWebm(decoder: WebmDecoderModule, file: Uint8Array): WebmInfo {
  return withFile(decoder, file, (input) => {
    const info = decoder._malloc(4 * 8) >>> 0;
    if (!info) throw new WebmDecodeError('out of memory');
    try {
      if (decoder._webm_probe(input, file.length, info) < 0) throw failure(decoder);
      // Read after the call: the decoder's memory may have grown, which replaces HEAPF64.
      const offset = info >>> 3;
      const [width, height, duration, frameRate] = decoder.HEAPF64.subarray(offset, offset + 4);
      return { width, height, duration, frameRate: frameRate > 0 ? frameRate : null };
    } finally {
      decoder._free(info);
    }
  });
}

/**
 * `count` square RGBA frames of `size` pixels: frame k is the video frame showing at k / frameRate seconds, scaled
 * to fit and centred on transparency.
 */
export function renderWebm(
  decoder: WebmDecoderModule,
  file: Uint8Array,
  size: number,
  frameRate: number,
  count: number,
): ArrayBuffer[] {
  if (
    !Number.isInteger(size) ||
    size <= 0 ||
    size > MAX_FRAME_DIM ||
    !Number.isInteger(count) ||
    count <= 0 ||
    !Number.isFinite(frameRate) ||
    frameRate <= 0
  ) {
    throw new WebmDecodeError('invalid render parameters');
  }
  const frameBytes = size * size * 4;
  const totalBytes = frameBytes * count;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_OUTPUT_BYTES) {
    throw new WebmDecodeError('invalid render parameters');
  }
  return withFile(decoder, file, (input) => {
    const output = decoder._malloc(totalBytes) >>> 0;
    if (!output) throw new WebmDecodeError('out of memory');
    try {
      const written = decoder._webm_render(input, file.length, size, frameRate, count, output);
      if (written < 0) throw failure(decoder);
      if (written > count) throw new WebmDecodeError('invalid frame count');
      return Array.from(
        { length: written },
        (_, k) => decoder.HEAPU8.slice(output + k * frameBytes, output + (k + 1) * frameBytes).buffer,
      );
    } finally {
      decoder._free(output);
    }
  });
}
