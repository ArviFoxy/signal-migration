// The page of measure.mjs: takes one sticker after another from the server that served it and measures the picture
// comparison on it with the app's own code, in whatever browser opened the page.
//
// ?phase=convert: converts the original as the app does, sends the converted file back, and compares the converted
// file with the original. ?phase=cross: compares a file that another browser converted with the original as this
// browser draws it.

import { animationDifference, stillDifference } from '../src/kinds/stickers/compare-pictures';
import { convertSticker } from '../src/kinds/stickers/convert';
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

async function measure(job: Job): Promise<object> {
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
