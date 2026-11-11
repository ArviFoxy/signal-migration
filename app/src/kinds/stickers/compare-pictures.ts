// Compares a converted sticker with the Telegram file it was made from, by drawing both in this browser.
//
// A converted file is accepted when it is one of the conversions this app makes (convert.ts) and shows the same
// picture: the original is drawn at the converted file's size and frame rate, and every frame may differ from the
// drawn one by at most a tolerance. The tolerance covers what encoding loses, such as reducing an animation to 256
// colours.

import type { OpenedPng } from './apng-worker';
import type { PictureComparison } from './compare-pack';
import { withTimeLimit } from '../../core/time-limit';
import {
  CONVERSION_TIME_LIMIT_MS,
  MAX_STILL_SIZE,
  SIZES,
  allowedFrameRates,
  askPngWorker,
  frameCount,
  frameDelay,
  openAnimation,
  stopWorkers,
} from './convert';
import { largestDifference } from './frame-difference';

/**
 * How different a frame of a converted animation may be from the original drawn at the same size and moment, as
 * frame-difference.ts measures it (0 to 255, for the most different square of the frame).
 *
 * Measured with measure/measure.mjs on 345 vector animations and 191 video stickers from 24 real packs, each
 * converted in Chrome and in Firefox and compared in both. The largest difference of the app's own conversions was
 * 9.8 for vector animations and 7.7 for videos, and no larger where one browser compared what the other had made:
 * what is left is what reducing a frame to 256 colours loses. The tolerance is one and a half times the largest.
 * A copy with a sticker above it is refused and the pack is uploaded again.
 *
 * What it lets through, measured on altered copies of 108 of the animations: always a line one pixel wide, or a
 * tenth less of one colour; on one animation in four a spot 3% of the picture wide; on one in twenty-five or fewer
 * a spot 5% wide, a veil of 15% opacity or a line two pixels wide.
 */
export const ANIMATION_TOLERANCE = 15;
/**
 * The same for a still picture that was encoded again at lower quality. None of 1,899 real still stickers was
 * large enough to need that, and a drawn picture with fine detail differed by 2.2, so this is the tolerance of
 * the animations.
 */
export const STILL_TOLERANCE = 15;

/** A copy of the bytes in a buffer of their own, to hand to a worker. */
const ownBuffer = (bytes: Uint8Array) => bytes.slice().buffer;

/**
 * How different a converted animation is from the original drawn at the converted file's size and frame rate: the
 * largest difference over its frames (frame-difference.ts). Null when the file is not a conversion this app makes
 * of the original: another size, frame rate or number of frames.
 */
export async function animationDifference(
  converted: Uint8Array,
  original: Uint8Array,
  format: 'tgs' | 'webm',
): Promise<number | null> {
  const png = ownBuffer(converted);
  const opened = await askPngWorker<OpenedPng>({ open: png }, [png]);
  const notAConversion = async () => {
    await askPngWorker<null>({ compare: { key: opened.key, frames: null } });
    return null;
  };
  if (opened.width !== opened.height || !SIZES.includes(opened.width)) return notAConversion();
  const animation = await openAnimation(original, format);
  try {
    const rates = allowedFrameRates(animation);
    // A file with one picture holds no delay. It is a conversion only of an animation that has one frame at every
    // allowed rate.
    const rate =
      opened.delays.length === 0
        ? rates.every((allowed) => frameCount(animation, allowed) === 1)
          ? rates[0]
          : undefined
        : rates.find((allowed) => opened.delays.every((delay) => delay === frameDelay(allowed)));
    if (rate === undefined || frameCount(animation, rate) !== opened.frameCount) return notAConversion();
    const frames = await animation.render(opened.width, rate);
    return await askPngWorker<number>({ compare: { key: opened.key, frames } }, frames);
  } finally {
    animation.close();
  }
}

async function sameAnimation(converted: Uint8Array, original: Uint8Array, format: 'tgs' | 'webm'): Promise<boolean> {
  const difference = await animationDifference(converted, original, format);
  return difference !== null && difference <= ANIMATION_TOLERANCE;
}

/** The picture in a file, drawn at `width` × `height` pixels, as RGBA. */
function drawn(bitmap: ImageBitmap, width: number, height: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

/**
 * How different a still picture that was encoded again is from the original drawn at its size
 * (frame-difference.ts). Null when the file is not a picture this browser reads, or not of the size the app makes.
 */
export async function stillDifference(converted: Uint8Array, original: Uint8Array): Promise<number | null> {
  const asBitmap = (bytes: Uint8Array) =>
    createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/webp' }));
  let copy: ImageBitmap;
  try {
    copy = await asBitmap(converted);
  } catch {
    return null;
  }
  const source = await asBitmap(original);
  try {
    // The app scales a picture down so that neither side is longer than MAX_STILL_SIZE (convert.ts reencodeWebp).
    const scale = Math.min(1, MAX_STILL_SIZE / Math.max(source.width, source.height));
    if (copy.width !== Math.round(source.width * scale) || copy.height !== Math.round(source.height * scale)) {
      return null;
    }
    return largestDifference(
      drawn(copy, copy.width, copy.height),
      drawn(source, copy.width, copy.height),
      copy.width,
      copy.height,
    );
  } finally {
    copy.close();
    source.close();
  }
}

async function sameStill(converted: Uint8Array, original: Uint8Array): Promise<boolean> {
  const difference = await stillDifference(converted, original);
  return difference !== null && difference <= STILL_TOLERANCE;
}

/**
 * Fails a comparison that takes longer than a conversion may. Drawing the original is most of both, so a longer one
 * waits for something that will not come, as in convert.ts.
 */
function withinTimeLimit(comparison: Promise<boolean>): Promise<boolean> {
  return withTimeLimit(comparison, CONVERSION_TIME_LIMIT_MS, () => {
    const error = new Error(`comparing a sticker took longer than ${CONVERSION_TIME_LIMIT_MS / 1000} seconds`);
    stopWorkers(error);
    return error;
  });
}

/** Compares pictures by drawing them in this browser. */
export const browserPictures: PictureComparison = {
  sameStill: (converted, original) => withinTimeLimit(sameStill(converted, original)),
  sameAnimation: (converted, original, format) => withinTimeLimit(sameAnimation(converted, original, format)),
};
