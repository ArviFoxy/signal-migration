// Converts Telegram sticker files into files Signal accepts.
//
// Signal's sticker creator accepts static images and animated PNG (APNG), up to 300 KiB and 512 x 512 pixels, and
// an APNG must be square and loop forever (Signal Desktop sticker-creator/src/util/processImage.ts). Telegram has
// three formats:
// - WebP, static: passed through unchanged when within the size limit, otherwise re-encoded at lower quality,
//   as a file that holds only the picture (plain-webp.ts).
// - TGS, a gzipped Lottie animation: drawn frame by frame with lottie-web, then encoded as APNG.
// - WebM, VP9 video with transparency: decoded frame by frame with FFmpeg and libvpx compiled to WebAssembly
//   (webm-decoder.c), then encoded as APNG.
// Decoding video and encoding APNG (upng-js, with a 256-colour palette) run in workers. The frame size and frame
// rate are lowered until the file fits the size limit.

import lottie from 'lottie-web/build/player/lottie_light_canvas';
import { plainWebp } from './plain-webp';
import { withTimeLimit } from '../../core/time-limit';
import type { StickerFormat } from './telegram-packs';
import { MAX_STICKER_BYTES } from './upload';
import type { WebmInfo } from './webm-decoding';
import type { WebmCall } from './webm-worker';

const MAX_SIZE = 512;
/** Telegram animations run at up to 60 frames per second. Fewer frames leave more of the size limit for each frame. */
const MAX_FRAME_RATE = 30;
const PALETTE_COLOURS = 256;
/** The square sizes and the frame rates an animation is encoded at, the largest that fits first. */
export const SIZES = [512, 448, 384, 320, 256, 224, 192, 160, 128];
const FRAME_RATES = [30, 24, 20, 15, 12, 10];
const MAX_ATTEMPTS = 6;
/** Aim this far under the limit when predicting a file's size from an earlier attempt. */
const PREDICTION_MARGIN = 0.9;

export class ConversionError extends Error {}

/** What a conversion produced. For an animation: the square size and frame rate it was encoded at. */
export type ConvertedSticker = {
  image: Uint8Array;
  /** sourceFrameRate is null when the file does not say. */
  animation: { size: number; frameRate: number; sourceFrameRate: number | null } | null;
  /** A static image that was re-encoded at lower quality to fit the size limit. */
  reencoded: boolean;
};

/** Converts one Telegram sticker file; the app uses convertSticker, tests a simulated conversion. */
export type ConvertSticker = (file: Uint8Array, format: StickerFormat) => Promise<ConvertedSticker>;

/** The step a conversion is at, so that a conversion that stops can say where. */
type Step = { now: string };

/** An animation that can be drawn at a given square size and frame rate, as RGBA frames. */
export type Animation = {
  duration: number;
  sourceFrameRate: number | null;
  render(size: number, frameRate: number): Promise<ArrayBuffer[]>;
  close(): void;
};

/** A worker that answers requests by ID, started on first use. */
class WorkerChannel {
  #worker: Worker | null = null;
  #nextId = 0;
  readonly #pending = new Map<number, { resolve: (result: never) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly url: string,
    /** What the worker is, for the error when it fails as a whole. */
    private readonly name: string,
  ) {}

  request<T>(message: object, transfer: Transferable[] = []): Promise<T> {
    if (!this.#worker) {
      const worker = new Worker(this.url, { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ id: number; result?: never; error?: string }>) => {
        const request = this.#pending.get(event.data.id);
        this.#pending.delete(event.data.id);
        if (event.data.error !== undefined) request?.reject(new ConversionError(event.data.error));
        else request?.resolve(event.data.result as never);
      };
      worker.onerror = (event) => this.stop(new ConversionError(`${this.name} failed: ${event.message}`));
      this.#worker = worker;
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (result: never) => void, reject });
      this.#worker!.postMessage({ id, ...message }, transfer);
    });
  }

  /** Stops the worker and fails every request waiting for it; the next request starts a new worker. */
  stop(error: Error): void {
    this.#worker?.terminate();
    this.#worker = null;
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
  }
}

const encoder = new WorkerChannel('/apng-worker.js', 'the animation encoder');
const videoDecoder = new WorkerChannel('/webm-worker.js', 'the video decoder');

/** Asks the worker that encodes and reads animated PNG files (apng-worker.ts). */
export const askPngWorker = <T>(message: object, transfer: Transferable[] = []): Promise<T> =>
  encoder.request<T>(message, transfer);

/** The delay between two frames of an animation encoded at `frameRate`, in milliseconds, as the file holds it. */
export const frameDelay = (frameRate: number) => Math.round(1000 / frameRate);

/** How many frames an animation has when it is encoded at `frameRate`. */
export const frameCount = (animation: Animation, frameRate: number) =>
  Math.max(1, Math.round(animation.duration * frameRate));

/** The frame rates an animation may be encoded at: the listed ones up to its own rate, or its own when it is lower. */
export function allowedFrameRates(animation: Animation): number[] {
  const sourceRate = Math.min(animation.sourceFrameRate ?? MAX_FRAME_RATE, MAX_FRAME_RATE);
  const lowerRates = FRAME_RATES.filter((rate) => rate <= sourceRate);
  return lowerRates.length > 0 ? lowerRates : [sourceRate];
}

function encodeApng(frames: ArrayBuffer[], size: number, frameRate: number): Promise<Uint8Array> {
  const delays = frames.map(() => frameDelay(frameRate));
  return encoder
    .request<ArrayBuffer>({ frames, width: size, height: size, delays, colours: PALETTE_COLOURS }, frames)
    .then((png) => new Uint8Array(png));
}

/**
 * How long one sticker may take to convert. A large animated sticker takes several seconds, over a few attempts at
 * smaller sizes; a conversion still running after this waits for something that will not come (an animation or
 * video that never reports being loaded, an encoder that stopped answering).
 */
export const CONVERSION_TIME_LIMIT_MS = 120_000;

/**
 * Encodes at the largest size and frame rate that fits. The file size is predicted as proportional to the number
 * of pixels over all frames; each attempt that comes out too large corrects the factor.
 */
async function encodeToFit(animation: Animation, step: Step): Promise<ConvertedSticker> {
  const rates = allowedFrameRates(animation);
  const candidates = SIZES.flatMap((size) =>
    rates.map((rate) => ({ size, rate, pixels: size * size * frameCount(animation, rate) })),
  ).sort((a, b) => b.pixels - a.pixels);
  const smallest = candidates[candidates.length - 1];
  let bytesPerPixel = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const predicted = candidates.find((c) => c.pixels * bytesPerPixel <= MAX_STICKER_BYTES * PREDICTION_MARGIN);
    // The prediction comes from larger sizes and can be wrong for the smallest one, so the smallest is tried
    // before giving up: when nothing is predicted to fit, and on the last attempt.
    const candidate = predicted && attempt < MAX_ATTEMPTS - 1 ? predicted : smallest;
    const frames = await animation.render(candidate.size, candidate.rate);
    step.now = `encoding ${frames.length} frames at ${candidate.size} px, ${candidate.rate} fps (attempt ${attempt + 1})`;
    const png = await encodeApng(frames, candidate.size, candidate.rate);
    if (png.length <= MAX_STICKER_BYTES) {
      return {
        image: png,
        animation: { size: candidate.size, frameRate: candidate.rate, sourceFrameRate: animation.sourceFrameRate },
        reencoded: false,
      };
    }
    if (candidate === smallest) break;
    bytesPerPixel = Math.max(bytesPerPixel, png.length / candidate.pixels);
  }
  throw new ConversionError(
    `the animation does not fit in ${MAX_STICKER_BYTES / 1024} KiB even at small size and frame rate`,
  );
}

function newCanvas(size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new ConversionError('this browser cannot draw on a canvas');
  return { canvas, context };
}

async function lottieAnimation(tgs: Uint8Array, step: Step): Promise<Animation> {
  step.now = 'unpacking the animation';
  const json = await new Response(
    new Blob([tgs as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).text();
  const data = JSON.parse(json) as { fr: number; ip: number; op: number };
  const totalFrames = data.op - data.ip;
  return {
    duration: totalFrames / data.fr,
    sourceFrameRate: data.fr,
    async render(size, frameRate) {
      const { context } = newCanvas(size);
      // With a canvas context and no container, lottie-web draws into that context, scaled to the canvas.
      const animation = lottie.loadAnimation({
        container: undefined as unknown as Element,
        renderer: 'canvas',
        loop: false,
        autoplay: false,
        animationData: structuredClone(data),
        rendererSettings: { context, clearCanvas: true },
      });
      step.now = `waiting for the animation to load, at ${size} px`;
      if (!animation.isLoaded)
        await new Promise<void>((resolve) => animation.addEventListener('DOMLoaded', () => resolve()));
      const frames: ArrayBuffer[] = [];
      const count = Math.max(1, Math.round((totalFrames / data.fr) * frameRate));
      for (let k = 0; k < count; k++) {
        step.now = `drawing frame ${k + 1} of ${count} at ${size} px`;
        animation.goToAndStop(Math.min((k * data.fr) / frameRate, totalFrames - 1), true);
        frames.push(context.getImageData(0, 0, size, size).data.buffer);
      }
      animation.destroy();
      return frames;
    },
    close() {},
  };
}

/** A video sticker, decoded in the worker (webm-worker.ts). The file is copied to the worker, not moved. */
async function webmAnimation(webm: Uint8Array, step: Step): Promise<Animation> {
  step.now = 'reading the video';
  const info = await videoDecoder.request<WebmInfo>({ kind: 'probe', file: webm } satisfies WebmCall);
  return {
    duration: info.duration,
    sourceFrameRate: info.frameRate,
    async render(size, frameRate) {
      const count = Math.max(1, Math.round(info.duration * frameRate));
      step.now = `decoding ${count} frames at ${size} px`;
      return videoDecoder.request<ArrayBuffer[]>({
        kind: 'render',
        file: webm,
        size,
        frameRate,
        count,
      } satisfies WebmCall);
    },
    close() {},
  };
}

/** The animation in a Telegram sticker file. */
export function openAnimation(file: Uint8Array, format: 'tgs' | 'webm'): Promise<Animation> {
  const step: Step = { now: 'starting' };
  return format === 'tgs' ? lottieAnimation(file, step) : webmAnimation(file, step);
}

/** The largest width or height of a still picture that had to be encoded again. */
export const MAX_STILL_SIZE = MAX_SIZE;

async function reencodeWebp(webp: Uint8Array): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([webp as Uint8Array<ArrayBuffer>], { type: 'image/webp' }));
  const scale = Math.min(1, MAX_SIZE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (blob.size > MAX_STICKER_BYTES) continue;
    const file = new Uint8Array(await blob.arrayBuffer());
    // The browser's encoder adds a colour profile. Without it the file holds only the picture, which is what
    // other users' browsers accept as a copy (compare-pack.ts). A browser that cannot write WebP gives a PNG.
    return blob.type === 'image/webp' ? plainWebp(file) : file;
  }
  throw new ConversionError(`the image does not fit in ${MAX_STICKER_BYTES / 1024} KiB`);
}

/** Stops both workers and fails what they were asked with `error`. The next request starts them again. */
export function stopWorkers(error: Error): void {
  encoder.stop(error);
  videoDecoder.stop(error);
}

/** The file to upload to Signal for one Telegram sticker file. */
export const convertSticker: ConvertSticker = (file, format) => {
  const step: Step = { now: 'starting' };
  return withTimeLimit(convert(file, format, step), CONVERSION_TIME_LIMIT_MS, () => {
    const error = new ConversionError(
      `converting took longer than ${CONVERSION_TIME_LIMIT_MS / 1000} seconds, at: ${step.now}`,
    );
    stopWorkers(error);
    return error;
  });
};

async function convert(file: Uint8Array, format: StickerFormat, step: Step): Promise<ConvertedSticker> {
  if (format === 'webp') {
    return file.length <= MAX_STICKER_BYTES
      ? { image: file, animation: null, reencoded: false }
      : { image: await reencodeWebp(file), animation: null, reencoded: true };
  }
  const animation = format === 'tgs' ? await lottieAnimation(file, step) : await webmAnimation(file, step);
  try {
    return await encodeToFit(animation, step);
  } finally {
    animation.close();
  }
}
