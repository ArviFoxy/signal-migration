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
/** The smallest square size an animation is encoded at. */
const MIN_SIZE = 128;
/** The square sizes an animation is encoded at: every number of pixels from 512 down to 128. */
export const SIZES = Array.from({ length: MAX_SIZE - MIN_SIZE + 1 }, (_, step) => MAX_SIZE - step);
/**
 * The longest delay between two frames that an animation is encoded with, in milliseconds: 4 frames per second.
 * An animation whose own frames are further apart keeps its own rate.
 */
const MAX_FRAME_DELAY_MS = 250;
/**
 * How many pixels of size one frame per second is worth, for vector animations and for video stickers. Most
 * animations fit Signal's limit only when both the size and the frame rate are lowered, and a large picture that
 * barely moves is no better than a small one that moves well. A size and frame rate are therefore rated by the
 * smaller of the size and this number times the frame rate, and the best rated that fits is taken.
 *
 * The numbers were chosen by eye on twelve real stickers that fit only far below full quality, each shown at five
 * sizes with the highest frame rate that fits. For vector animations, 192 pixels at 6 to 10 frames per second was
 * preferred to 256 at 5 or 6 and to 128 at 12 to 15: their sharp edges suffer from a small size. For videos, the
 * smallest size at the highest frame rate was preferred every time (128 pixels at 8 to 12 frames per second to
 * 192 at 4 to 6): natural, soft pictures lose little at a small size. The numbers reproduce eleven of the twelve
 * choices.
 */
export const PIXELS_PER_FRAME_RATE = { tgs: 24, webm: 12 } as const;
/** How many encodings the search for a size and frame rate makes at most, those it starts with included. */
const MAX_ATTEMPTS = 8;
/**
 * The encodings the search starts with: small ones, so that they cost little. Two sizes at one frame rate show how
 * this animation's file grows with its size, and the smaller size at a higher frame rate shows how it grows with
 * the number of frames (see Growth). Together they predict the file sizes of all the others.
 *
 * The frame rate is one that the usual 60, 30 and 24 frames per second are no multiple of. Many animations hold a
 * drawing for several frames, and at a rate that falls in step with the holds, frames repeat and the file is far
 * smaller than at the rates around it (40% in one measured case), which would mislead every prediction.
 */
const FIRST_SIZES = [128, 256];
const FIRST_FRAME_RATE = 7;
const HIGHER_FIRST_FRAME_RATE = 21;
/**
 * A candidate is tried when its predicted file size is at most this share of the limit. The prediction is off by a
 * few percent, and the candidates lie close together, so one predicted to fit only just is not worth the risk.
 */
const PREDICTION_MARGIN = 0.97;
/**
 * After a candidate that fits, another is tried only when it is clearly better: it rates at least 1.03 times as
 * high, or it is no smaller and no slower and either at least 1.05 times as large or as fast, or at the full size
 * or the animation's own frame rate. The second case is for an animation whose own frame rate is low, where the
 * rating no longer rises with the size.
 */
const CLEARLY_HIGHER_RATING = 1.03;
const CLEARLY_LARGER = 1.05;

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

/** A size and frame rate an animation can be encoded at, with the number of frames it then has. */
export type Candidate = { size: number; rate: number; frames: number };

/** An encoding that was made: the size and number of frames, and how many bytes the file has. */
export type Encoding = { size: number; frames: number; bytes: number };

/**
 * Which of two candidates is preferred: positive when it is `one`. The rating is the smaller of the size and
 * `pixelsPerFrameRate` times the frame rate, so a candidate rates high only when both are high. Of equally rated
 * ones, the higher frame rate is preferred, and then the larger size.
 */
function preference(one: Candidate, other: Candidate, pixelsPerFrameRate: number): number {
  return (
    rating(one, pixelsPerFrameRate) - rating(other, pixelsPerFrameRate) ||
    one.rate - other.rate ||
    one.size - other.size
  );
}

const rating = (candidate: Candidate, pixelsPerFrameRate: number) =>
  Math.min(candidate.size, pixelsPerFrameRate * candidate.rate);

/** The most preferred of `candidates` (see `preference`), or undefined when there is none. */
export function bestRated(candidates: Candidate[], pixelsPerFrameRate: number): Candidate | undefined {
  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (!best || preference(candidate, best, pixelsPerFrameRate) > 0) best = candidate;
  }
  return best;
}

/**
 * How an animation's file grows: its bytes are in proportion to the size of its frames to the power `sizePower`
 * times their number to the power `framePower`. Both differ from one animation to the next. Flat colour keeps
 * fewer bytes per pixel at a large size than fine detail does. And a file stores for each frame only what changed
 * since the one before: in a drawn animation that is most of the picture, so every frame costs about the same
 * (a power near 1), while in footage with a still background frames close in time hardly differ, so more frames
 * cost little (a power near 0.25 was measured).
 */
export type Growth = { sizePower: number; framePower: number };

/** What is assumed for a power that the encodings made so far do not show. */
const ASSUMED_GROWTH: Growth = { sizePower: 1.5, framePower: 1 };

/** The growth that fits the encodings made so far best (least squares on the logarithms). */
export function growthOf(encodings: Encoding[]): Growth {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const centred = (values: number[]) => values.map((value) => value - mean(values));
  const sizes = centred(encodings.map((encoding) => Math.log(encoding.size)));
  const frames = centred(encodings.map((encoding) => Math.log(encoding.frames)));
  const bytes = centred(encodings.map((encoding) => Math.log(encoding.bytes)));
  const dot = (one: number[], other: number[]) => one.reduce((sum, value, i) => sum + value * other[i], 0);
  const [ss, ff, sf, sb, fb] = [
    dot(sizes, sizes),
    dot(frames, frames),
    dot(sizes, frames),
    dot(sizes, bytes),
    dot(frames, bytes),
  ];
  const determinant = ss * ff - sf * sf;
  let { sizePower, framePower } = ASSUMED_GROWTH;
  if (determinant > 1e-6 * ss * ff && determinant > 1e-12) {
    sizePower = (sb * ff - fb * sf) / determinant;
    framePower = (fb * ss - sb * sf) / determinant;
  } else if (ss > 1e-9) {
    // The encodings do not show the two apart: the frames are taken to cost the assumed power.
    sizePower = (sb - framePower * sf) / ss;
  } else if (ff > 1e-9) {
    framePower = (fb - sizePower * sf) / ff;
  }
  const within = (value: number, least: number, most: number) => Math.min(Math.max(value, least), most);
  return { sizePower: within(sizePower, 0.3, 2.5), framePower: within(framePower, 0.05, 1.3) };
}

/**
 * The bytes to expect for `candidate`, from the encodings made so far (0 when there is none): those of the
 * encoding nearest to it in size and number of frames, carried over to its size and number of frames by the
 * growth that fits all of them.
 */
export function predictedBytes(encodings: Encoding[], candidate: Candidate): number {
  if (encodings.length === 0) return 0;
  const { sizePower, framePower } = growthOf(encodings);
  const distance = (encoding: Encoding) =>
    Math.abs(Math.log(encoding.size / candidate.size)) + Math.abs(Math.log(encoding.frames / candidate.frames));
  const nearest = encodings.reduce((best, encoding) => (distance(encoding) < distance(best) ? encoding : best));
  return (
    nearest.bytes * (candidate.size / nearest.size) ** sizePower * (candidate.frames / nearest.frames) ** framePower
  );
}

/**
 * The frame rate that goes with a delay of `delay` milliseconds between frames. A file holds the delay in whole
 * milliseconds, so the delay is what can be chosen. A whole number of frames per second whose delay rounds to
 * `delay` is that number, which is how earlier versions of the app encoded 30, 24, 15 and 12 frames per second;
 * every other delay has its exact rate.
 */
function rateOfDelay(delay: number): number {
  const whole = Math.round(1000 / delay);
  return frameDelay(whole) === delay ? whole : 1000 / delay;
}

/**
 * The frame rates an animation may be encoded at, the highest first: its own rate (30 at most), and below it one
 * for every delay in whole milliseconds up to MAX_FRAME_DELAY_MS.
 */
export function allowedFrameRates(animation: Animation): number[] {
  const sourceRate = Math.min(animation.sourceFrameRate ?? MAX_FRAME_RATE, MAX_FRAME_RATE);
  // One frame rate for each delay, so that the delays in a file say at which rate it was made.
  const byDelay = new Map<number, number>();
  for (let delay = frameDelay(sourceRate); delay <= MAX_FRAME_DELAY_MS; delay++) {
    const rate = rateOfDelay(delay);
    if (rate <= sourceRate) byDelay.set(delay, rate);
  }
  byDelay.set(frameDelay(sourceRate), sourceRate);
  return [...byDelay.values()].sort((a, b) => b - a);
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
 * Encodes at the most preferred size and frame rate that fits (see `preference`). It starts with two small
 * encodings, which predict the file sizes of the others (predictedBytes), and then tries the most preferred
 * candidate that is predicted to fit. Each encoding that is made improves the prediction. After one that fits, a
 * more preferred candidate is tried as long as one is predicted to fit, up to MAX_ATTEMPTS encodings in all.
 */
async function encodeToFit(animation: Animation, pixelsPerFrameRate: number, step: Step): Promise<ConvertedSticker> {
  const rates = allowedFrameRates(animation);
  const candidates: Candidate[] = SIZES.flatMap((size) =>
    rates.map((rate) => ({ size, rate, frames: frameCount(animation, rate) })),
  );
  const encodings: Encoding[] = [];
  const tried = new Set<Candidate>();
  type Fitting = { candidate: Candidate; png: Uint8Array };
  /** Encodes `candidate`; gives the file when it fits the limit. */
  const attempt = async (candidate: Candidate): Promise<Fitting | null> => {
    const frames = await animation.render(candidate.size, candidate.rate);
    step.now = `encoding ${frames.length} frames at ${candidate.size} px, ${candidate.rate} fps (attempt ${tried.size + 1})`;
    const png = await encodeApng(frames, candidate.size, candidate.rate);
    tried.add(candidate);
    encodings.push({ size: candidate.size, frames: candidate.frames, bytes: png.length });
    return png.length <= MAX_STICKER_BYTES ? { candidate, png } : null;
  };
  const preferred = (one: Fitting | null, other: Fitting | null) =>
    one && (!other || preference(one.candidate, other.candidate, pixelsPerFrameRate) > 0) ? one : other;
  let best: Fitting | null = null;
  const nearestRate = (wanted: number) =>
    rates.reduce((nearest, rate) => (Math.abs(rate - wanted) < Math.abs(nearest - wanted) ? rate : nearest));
  const candidateAt = (size: number, rate: number) =>
    candidates.find((candidate) => candidate.size === size && candidate.rate === rate)!;
  const firstRate = nearestRate(FIRST_FRAME_RATE);
  const first = FIRST_SIZES.map((size) => candidateAt(size, firstRate));
  // The encoding at a higher frame rate is left out when the animation has too few frames to tell.
  const faster = candidateAt(FIRST_SIZES[0], nearestRate(HIGHER_FIRST_FRAME_RATE));
  if (faster.frames >= first[0].frames * 1.3) first.push(faster);
  for (const candidate of first) best = preferred(await attempt(candidate), best);

  // Their logarithms, worked out once: every candidate's file size is predicted again after each encoding.
  const logSize = candidates.map((candidate) => Math.log(candidate.size));
  const logFrames = candidates.map((candidate) => Math.log(candidate.frames));
  const fullRate = rates[0];
  while (tried.size < MAX_ATTEMPTS) {
    const fitting = best?.candidate;
    const clearlyBetter = (candidate: Candidate) =>
      !fitting ||
      rating(candidate, pixelsPerFrameRate) >= rating(fitting, pixelsPerFrameRate) * CLEARLY_HIGHER_RATING ||
      (candidate.size >= fitting.size &&
        candidate.rate >= fitting.rate &&
        (candidate.size >= fitting.size * CLEARLY_LARGER ||
          candidate.rate >= fitting.rate * CLEARLY_LARGER ||
          (candidate.size === MAX_SIZE && fitting.size < MAX_SIZE) ||
          (candidate.rate === fullRate && fitting.rate < fullRate)));
    const { sizePower, framePower } = growthOf(encodings);
    const made = encodings.map((encoding) => ({
      logSize: Math.log(encoding.size),
      logFrames: Math.log(encoding.frames),
      logBytes: Math.log(encoding.bytes),
    }));
    const logLimit = Math.log(MAX_STICKER_BYTES * PREDICTION_MARGIN);
    /** Whether candidate number `i` is predicted to fit: predictedBytes, on the logarithms worked out above. */
    const predictedToFit = (i: number) => {
      let nearest = made[0];
      let least = Infinity;
      for (const encoding of made) {
        const distance = Math.abs(encoding.logSize - logSize[i]) + Math.abs(encoding.logFrames - logFrames[i]);
        if (distance < least) [nearest, least] = [encoding, distance];
      }
      return (
        nearest.logBytes +
          sizePower * (logSize[i] - nearest.logSize) +
          framePower * (logFrames[i] - nearest.logFrames) <=
        logLimit
      );
    };
    const worthTrying = candidates.filter(
      (candidate, i) => !tried.has(candidate) && clearlyBetter(candidate) && predictedToFit(i),
    );
    const next = bestRated(worthTrying, pixelsPerFrameRate);
    if (!next) break;
    best = preferred(await attempt(next), best);
  }
  // The prediction can be wrong for the smallest candidate, so it is tried before giving up.
  const smallest = candidates.reduce((least, candidate) =>
    candidate.size * candidate.size * candidate.frames < least.size * least.size * least.frames ? candidate : least,
  );
  if (!best && !tried.has(smallest)) best = await attempt(smallest);
  if (!best) {
    throw new ConversionError(
      `the animation does not fit in ${MAX_STICKER_BYTES / 1024} KiB even at small size and frame rate`,
    );
  }
  return {
    image: best.png,
    animation: {
      size: best.candidate.size,
      frameRate: best.candidate.rate,
      sourceFrameRate: animation.sourceFrameRate,
    },
    reencoded: false,
  };
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
    return await encodeToFit(animation, PIXELS_PER_FRAME_RATE[format], step);
  } finally {
    animation.close();
  }
}
