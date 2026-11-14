// The page of measure.mjs: takes one sticker after another from the server that served it and measures the picture
// comparison on it with the app's own code, in whatever browser opened the page.
//
// ?phase=convert: converts the original as the app does, sends the converted file back, and compares the converted
// file with the original. ?phase=cross: compares a file that another browser converted with the original as this
// browser draws it. ?phase=altered: alters the frames of a converted file in ways a replaced copy could differ, and
// measures each altered file against the original, to see what the comparison's tolerance lets through.

import UPNG from 'upng-js';
import { ANIMATION_TOLERANCE, animationDifference, stillDifference } from '../src/kinds/stickers/compare-pictures';
import {
  allowedFrameRates,
  convertSticker,
  frameCount,
  frameDelay,
  openAnimation,
} from '../src/kinds/stickers/convert';
import { largestDifference } from '../src/kinds/stickers/frame-difference';
import { isPlainPng } from '../src/kinds/stickers/plain-png';
import { isPlainWebp } from '../src/kinds/stickers/plain-webp';
import type { StickerFormat } from '../src/kinds/stickers/telegram-packs';

type Job = { id: string; format: StickerFormat; original: string; conversion?: string; madeBy?: string };

const parameters = new URLSearchParams(location.search);
const browser = parameters.get('browser')!;
const phase = parameters.get('phase')!;

const read = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const send = (url: string, body: Uint8Array | string) => fetch(url, { method: 'POST', body: body as BodyInit });

const difference = (converted: Uint8Array, original: Uint8Array, format: StickerFormat) =>
  format === 'webp' ? stillDifference(converted, original) : animationDifference(converted, original, format);

/**
 * Paints over one pixel of a frame with the given opacity, in black or in white, whichever is further from what is
 * there, so that the paint shows on any picture. A clear pixel counts as white.
 */
function paint(out: Uint8Array, frame: Uint8Array, at: number, opacity: number): void {
  const covered = frame[at + 3] / 255;
  const brightness = ((frame[at] + frame[at + 1] + frame[at + 2]) / 3) * covered + 255 * (1 - covered);
  const colour = brightness >= 128 ? 0 : 255;
  const under = covered * (1 - opacity);
  const total = opacity + under;
  for (let c = 0; c < 3; c++) out[at + c] = Math.round((colour * opacity + frame[at + c] * under) / total);
  out[at + 3] = Math.round(total * 255);
}

/** A disc painted over the middle of a frame, `share` of the frame wide. */
const disc = (share: number, opacity: number) => (frame: Uint8Array, size: number) => {
  const out = frame.slice();
  const [middle, radius] = [size / 2, (share * size) / 2];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x + 0.5 - middle) ** 2 + (y + 0.5 - middle) ** 2 > radius ** 2) continue;
      paint(out, frame, (y * size + x) * 4, opacity);
    }
  }
  return out;
};

/** What someone could do to a copy, each as a change to one frame (RGBA, size x size). */
const ALTERATIONS: Record<string, (frame: Uint8Array, size: number) => Uint8Array> = {
  ...Object.fromEntries(
    [1, 2, 3].map((by) => [
      `moved ${by} px`,
      (frame: Uint8Array, size: number) => {
        const out = new Uint8Array(frame.length);
        for (let y = 0; y < size; y++)
          out.set(frame.subarray(y * size * 4, (y * size + size - by) * 4), (y * size + by) * 4);
        return out;
      },
    ]),
  ),
  'spot, 3% of the width': disc(0.03, 1),
  'spot, 5% of the width': disc(0.05, 1),
  'spot, 10% of the width': disc(0.1, 1),
  'veil of 15% opacity, a quarter of the width': disc(0.25, 0.15),
  'veil of 30% opacity, a quarter of the width': disc(0.25, 0.3),
  ...Object.fromEntries(
    [1, 2].map((thick) => [
      `line, ${thick} px`,
      (frame: Uint8Array, size: number) => {
        const out = frame.slice();
        for (let y = size >> 1; y < (size >> 1) + thick; y++)
          for (let x = 0; x < size; x++) paint(out, frame, (y * size + x) * 4, 1);
        return out;
      },
    ]),
  ),
  ...Object.fromEntries(
    [0.9, 0.75].map((share) => [
      `red at ${share * 100}%`,
      (frame: Uint8Array) => {
        const out = frame.slice();
        for (let at = 0; at < out.length; at += 4) out[at] = Math.round(frame[at] * share);
        return out;
      },
    ]),
  ),
};
/** The alterations are measured on this many frames of an animation at most, spread over it. */
const ALTERED_FRAMES = 6;

/**
 * The largest difference that each alteration of a converted file gives against the original as this browser
 * draws it, by the app's measure.
 */
async function alteredDifferences(job: Job): Promise<object> {
  const [original, conversion] = [await read(job.original), await read(job.conversion!)];
  const image = UPNG.decode(conversion.buffer as ArrayBuffer);
  const copy = UPNG.toRGBA8(image).map((frame) => new Uint8Array(frame));
  const size = image.width;
  const delays = image.frames.map((frame) => frame.delay);
  const animation = await openAnimation(original, job.format as 'tgs' | 'webm');
  try {
    const rates = allowedFrameRates(animation);
    const rate =
      delays.length === 0 ? rates[0] : rates.find((allowed) => delays.every((delay) => delay === frameDelay(allowed)));
    if (rate === undefined || frameCount(animation, rate) !== copy.length) return { error: 'not a conversion' };
    const drawn = (await animation.render(size, rate)).map((frame) => new Uint8Array(frame));
    const count = Math.min(ALTERED_FRAMES, copy.length);
    const frames = Array.from({ length: count }, (_, k) => Math.floor((k * copy.length) / count));
    return {
      madeBy: job.madeBy,
      size,
      tolerance: ANIMATION_TOLERANCE,
      altered: Object.fromEntries(
        Object.entries(ALTERATIONS).map(([name, alter]) => [
          name,
          Math.max(...frames.map((i) => largestDifference(alter(copy[i], size), drawn[i], size, size))),
        ]),
      ),
    };
  } finally {
    animation.close();
  }
}

async function measure(job: Job): Promise<object> {
  if (phase === 'altered') return alteredDifferences(job);
  const original = await read(job.original);
  if (phase === 'convert') {
    const started = performance.now();
    const converted = await convertSticker(original, job.format);
    const convertedAt = performance.now();
    await send(`/conversion/${browser}/${job.id}`, converted.image);
    const comparedFrom = performance.now();
    const found = await difference(converted.image, original, job.format);
    return {
      originalBytes: original.length,
      convertedBytes: converted.image.length,
      animation: converted.animation,
      reencoded: converted.reencoded,
      plain: job.format === 'webp' ? isPlainWebp(converted.image) : isPlainPng(converted.image),
      convertMs: Math.round(convertedAt - started),
      compareMs: Math.round(performance.now() - comparedFrom),
      difference: found,
    };
  }
  const conversion = await read(job.conversion!);
  const started = performance.now();
  const found = await difference(conversion, original, job.format);
  return { madeBy: job.madeBy, compareMs: Math.round(performance.now() - started), difference: found };
}

async function run(): Promise<void> {
  for (;;) {
    const response = await fetch(`/job?browser=${browser}&phase=${phase}`);
    if (response.status !== 200) break;
    const job = (await response.json()) as Job;
    let measured: object;
    try {
      measured = await measure(job);
    } catch (error) {
      measured = { error: error instanceof Error ? error.message : String(error) };
    }
    await send('/result', JSON.stringify({ id: job.id, format: job.format, browser, phase, ...measured }));
  }
  document.title = 'finished';
}

void run();
