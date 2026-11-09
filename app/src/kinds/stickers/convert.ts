// Converts Telegram sticker files into files Signal accepts.
//
// Signal's sticker creator accepts static images and animated PNG (APNG), up to 300 KiB and 512 x 512 pixels, and
// an APNG must be square and loop forever (Signal Desktop sticker-creator/src/util/processImage.ts). Telegram has
// three formats:
// - WebP, static: passed through unchanged when within the size limit, otherwise re-encoded at lower quality.
// - TGS, a gzipped Lottie animation: drawn frame by frame with lottie-web, then encoded as APNG.
// - WebM video with transparency: drawn frame by frame from a video element, then encoded as APNG.
// APNG encoding (upng-js, with a 256-colour palette) runs in a worker. The frame size and frame rate are lowered
// until the file fits the size limit.

import lottie from 'lottie-web/build/player/lottie_light_canvas';
import type { StickerFormat } from './telegram-packs';
import { MAX_STICKER_BYTES } from './upload';

const MAX_SIZE = 512;
/** Telegram animations run at up to 60 frames per second. Fewer frames leave more of the size limit for each frame. */
const MAX_FRAME_RATE = 30;
const PALETTE_COLOURS = 256;
const SIZES = [512, 448, 384, 320, 256, 224, 192, 160, 128];
const FRAME_RATES = [30, 24, 20, 15, 12, 10];
const MAX_ATTEMPTS = 6;
/** Aim this far under the limit when predicting a file's size from an earlier attempt. */
const PREDICTION_MARGIN = 0.9;

export class ConversionError extends Error {}

/** An animation that can be drawn at a given square size and frame rate, as RGBA frames. */
type Animation = {
  duration: number;
  sourceFrameRate: number;
  render(size: number, frameRate: number): Promise<ArrayBuffer[]>;
  close(): void;
};

let worker: Worker | null = null;
let nextRequest = 0;
const pending = new Map<number, (png: ArrayBuffer) => void>();

function encodeApng(frames: ArrayBuffer[], size: number, frameRate: number): Promise<Uint8Array> {
  if (!worker) {
    worker = new Worker('/apng-worker.js', { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; png: ArrayBuffer }>) => {
      pending.get(event.data.id)?.(event.data.png);
      pending.delete(event.data.id);
    };
  }
  const id = nextRequest++;
  const delays = frames.map(() => Math.round(1000 / frameRate));
  return new Promise((resolve) => {
    pending.set(id, (png) => resolve(new Uint8Array(png)));
    worker!.postMessage({ id, frames, width: size, height: size, delays, colours: PALETTE_COLOURS }, frames);
  });
}

/**
 * Encodes at the largest size and frame rate that fits. The file size is predicted as proportional to the number
 * of pixels over all frames; each attempt that comes out too large corrects the factor.
 */
async function encodeToFit(animation: Animation): Promise<Uint8Array> {
  const sourceRate = Math.min(animation.sourceFrameRate, MAX_FRAME_RATE);
  const frameCount = (rate: number) => Math.max(1, Math.round(animation.duration * rate));
  const lowerRates = FRAME_RATES.filter((rate) => rate <= sourceRate);
  const rates = lowerRates.length > 0 ? lowerRates : [sourceRate];
  const candidates = SIZES.flatMap((size) => rates.map((rate) => ({ size, rate, pixels: size * size * frameCount(rate) }))).sort((a, b) => b.pixels - a.pixels);
  let bytesPerPixel = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = candidates.find((c) => c.pixels * bytesPerPixel <= MAX_STICKER_BYTES * PREDICTION_MARGIN);
    if (!candidate) break;
    const png = await encodeApng(await animation.render(candidate.size, candidate.rate), candidate.size, candidate.rate);
    if (png.length <= MAX_STICKER_BYTES) return png;
    bytesPerPixel = Math.max(bytesPerPixel, png.length / candidate.pixels);
  }
  throw new ConversionError(`the animation does not fit in ${MAX_STICKER_BYTES / 1024} KiB even at small size and frame rate`);
}

function newCanvas(size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new ConversionError('this browser cannot draw on a canvas');
  return { canvas, context };
}

async function lottieAnimation(tgs: Uint8Array): Promise<Animation> {
  const json = await new Response(new Blob([tgs as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
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
      if (!animation.isLoaded) await new Promise<void>((resolve) => animation.addEventListener('DOMLoaded', () => resolve()));
      const frames: ArrayBuffer[] = [];
      const count = Math.max(1, Math.round((totalFrames / data.fr) * frameRate));
      for (let k = 0; k < count; k++) {
        animation.goToAndStop(Math.min((k * data.fr) / frameRate, totalFrames - 1), true);
        frames.push(context.getImageData(0, 0, size, size).data.buffer);
      }
      animation.destroy();
      return frames;
    },
    close() {},
  };
}

function waitFor(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener(event, done);
      video.removeEventListener('error', failed);
      resolve();
    };
    const failed = () => {
      video.removeEventListener(event, done);
      video.removeEventListener('error', failed);
      reject(new ConversionError('this browser cannot decode the video sticker'));
    };
    video.addEventListener(event, done);
    video.addEventListener('error', failed);
  });
}

async function videoAnimation(webm: Uint8Array): Promise<Animation> {
  const url = URL.createObjectURL(new Blob([webm as Uint8Array<ArrayBuffer>], { type: 'video/webm' }));
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const loaded = waitFor(video, 'loadeddata');
  video.src = url;
  await loaded;
  const seek = async (time: number) => {
    if (Math.abs(video.currentTime - time) < 1e-6) return;
    const seeked = waitFor(video, 'seeked');
    video.currentTime = time;
    await seeked;
  };
  // A WebM file without a duration in its header reports Infinity until the end has been read.
  if (!Number.isFinite(video.duration)) await seek(1e9);
  const duration = video.duration;
  return {
    duration,
    sourceFrameRate: MAX_FRAME_RATE,
    async render(size, frameRate) {
      const { context } = newCanvas(size);
      const scale = size / Math.max(video.videoWidth, video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      const frames: ArrayBuffer[] = [];
      const count = Math.max(1, Math.round(duration * frameRate));
      for (let k = 0; k < count; k++) {
        await seek(Math.min(k / frameRate, Math.max(0, duration - 0.001)));
        context.clearRect(0, 0, size, size);
        context.drawImage(video, (size - width) / 2, (size - height) / 2, width, height);
        frames.push(context.getImageData(0, 0, size, size).data.buffer);
      }
      return frames;
    },
    close() {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}

async function reencodeWebp(webp: Uint8Array): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([webp as Uint8Array<ArrayBuffer>], { type: 'image/webp' }));
  const scale = Math.min(1, MAX_SIZE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (blob.size <= MAX_STICKER_BYTES) return new Uint8Array(await blob.arrayBuffer());
  }
  throw new ConversionError(`the image does not fit in ${MAX_STICKER_BYTES / 1024} KiB`);
}

/** The file to upload to Signal for one Telegram sticker file. */
export async function convertSticker(file: Uint8Array, format: StickerFormat): Promise<Uint8Array> {
  if (format === 'webp') return file.length <= MAX_STICKER_BYTES ? file : reencodeWebp(file);
  const animation = format === 'tgs' ? await lottieAnimation(file) : await videoAnimation(file);
  try {
    return await encodeToFit(animation);
  } finally {
    animation.close();
  }
}
