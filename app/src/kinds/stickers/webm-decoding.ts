// Calls into the WebM decoder (webm-decoder.c): what a video sticker is, and its frames at a size and frame rate.
// The app calls these in a worker (webm-worker.ts); the tests call them directly.

import type { WebmDecoderModule } from 'webm-decoder';

export type WebmInfo = { width: number; height: number; duration: number; frameRate: number | null };

export class WebmDecodeError extends Error {}

/** Copies `file` into the decoder's memory for `use`, and frees it afterwards. */
function withFile<T>(decoder: WebmDecoderModule, file: Uint8Array, use: (pointer: number) => T): T {
  const pointer = decoder._malloc(file.length);
  if (!pointer) throw new WebmDecodeError('out of memory');
  try {
    decoder.HEAPU8.set(file, pointer);
    return use(pointer);
  } finally {
    decoder._free(pointer);
  }
}

const failure = (decoder: WebmDecoderModule) => new WebmDecodeError(decoder.UTF8ToString(decoder._webm_error()));

/** The video's size, duration in seconds and frame rate (null when the file does not say). */
export function probeWebm(decoder: WebmDecoderModule, file: Uint8Array): WebmInfo {
  return withFile(decoder, file, (input) => {
    const info = decoder._malloc(4 * 8);
    if (!info) throw new WebmDecodeError('out of memory');
    try {
      if (decoder._webm_probe(input, file.length, info) < 0) throw failure(decoder);
      // Read after the call: the decoder's memory may have grown, which replaces HEAPF64.
      const [width, height, duration, frameRate] = decoder.HEAPF64.subarray(info / 8, info / 8 + 4);
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
  const frameBytes = size * size * 4;
  return withFile(decoder, file, (input) => {
    const output = decoder._malloc(frameBytes * count);
    if (!output) throw new WebmDecodeError('out of memory');
    try {
      const written = decoder._webm_render(input, file.length, size, frameRate, count, output);
      if (written < 0) throw failure(decoder);
      return Array.from(
        { length: written },
        (_, k) => decoder.HEAPU8.slice(output + k * frameBytes, output + (k + 1) * frameBytes).buffer,
      );
    } finally {
      decoder._free(output);
    }
  });
}
