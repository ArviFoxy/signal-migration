// The page of choices.mjs: for one sticker after another, encodes the animation at several sizes, each at the
// highest frame rate at which the file still fits Signal's limit, and sends the files to the server that served
// it. The result shows what the choice between size and frame rate looks like.

import {
  type Animation,
  askPngWorker,
  convertSticker,
  frameDelay,
  openAnimation,
  setVideoScaling,
} from '../src/kinds/stickers/convert';
import { MAX_STICKER_BYTES } from '../src/kinds/stickers/upload';

type Job = { id: string; format: 'tgs' | 'webm'; original: string };
type Encoded = { size: number; rate: number; frames: number; bytes: number; name?: string; label?: string };

/** With ?mode=filters the page converts each video sticker once for each way of scaling its frames down. */
const mode = new URLSearchParams(location.search).get('mode');
const FILTERS = ['area averaging', 'Lanczos', 'Lanczos, sharpened'];

const SIZES = [512, 384, 256, 192, 128];
/** Frame rates from the highest the app uses down to ones it does not use today. */
const RATES = [30, 24, 20, 15, 12, 10, 8, 6, 5, 4];

const send = (url: string, body: Uint8Array | string) => fetch(url, { method: 'POST', body: body as BodyInit });

async function encode(animation: Animation, size: number, rate: number): Promise<Uint8Array> {
  const frames = await animation.render(size, rate);
  const delays = frames.map(() => frameDelay(rate));
  return new Uint8Array(
    await askPngWorker<ArrayBuffer>({ frames, width: size, height: size, delays, colours: 256 }, frames),
  );
}

async function choicesFor(job: Job): Promise<object> {
  const original = new Uint8Array(await (await fetch(job.original)).arrayBuffer());
  const animation = await openAnimation(original, job.format);
  try {
    const sourceRate = Math.min(animation.sourceFrameRate ?? 30, 30);
    const rates = RATES.filter((rate) => rate <= sourceRate + 0.01);
    const frames = (rate: number) => Math.max(1, Math.round(animation.duration * rate));
    const keep = async (file: Uint8Array, size: number, rate: number, name: string): Promise<Encoded> => {
      await send(`/file/${job.id}/${name}`, file);
      return { size, rate, frames: frames(rate), bytes: file.length };
    };

    // The animation as it is, at full size and its own frame rate, however large the file.
    const full = await keep(await encode(animation, 512, rates[0]), 512, rates[0], 'full');

    // For each size, the highest frame rate that fits. A smaller size fits at least the rate the size before it did.
    const variants: Encoded[] = [];
    let slowestNeeded = rates.length;
    for (const size of SIZES) {
      const files = new Map<number, Uint8Array>();
      let low = 0;
      let high = slowestNeeded;
      while (low < high) {
        const middle = (low + high) >> 1;
        const file = await encode(animation, size, rates[middle]);
        if (file.length <= MAX_STICKER_BYTES) {
          files.set(middle, file);
          high = middle;
        } else {
          low = middle + 1;
        }
      }
      if (low < rates.length) {
        const file = files.get(low) ?? (await encode(animation, size, rates[low]));
        if (file.length <= MAX_STICKER_BYTES) {
          variants.push(await keep(file, size, rates[low], `${size}`));
          slowestNeeded = low;
        }
      }
    }

    // What the app's conversion chooses today.
    let today: Encoded | { error: string };
    try {
      const converted = await convertSticker(original, job.format);
      const { size, frameRate } = converted.animation!;
      today = await keep(converted.image, size, frameRate, 'today');
    } catch (error) {
      today = { error: error instanceof Error ? error.message : String(error) };
    }
    return { duration: animation.duration, sourceRate: animation.sourceFrameRate, full, variants, today };
  } finally {
    animation.close();
  }
}

/** The sticker as the app converts it with each scaling filter, and at full size without a limit. */
async function filtersFor(job: Job): Promise<object> {
  const original = new Uint8Array(await (await fetch(job.original)).arrayBuffer());
  const variants: Encoded[] = [];
  for (const [filter, label] of FILTERS.entries()) {
    await setVideoScaling(filter);
    const converted = await convertSticker(original, job.format);
    const { size, frameRate } = converted.animation!;
    const name = `filter${filter}`;
    await send(`/file/${job.id}/${name}`, converted.image);
    variants.push({ size, rate: frameRate, frames: 0, bytes: converted.image.length, name, label });
  }
  await setVideoScaling(0);
  const animation = await openAnimation(original, job.format);
  try {
    const rate = Math.min(animation.sourceFrameRate ?? 30, 30);
    const file = await encode(animation, 512, rate);
    await send(`/file/${job.id}/full`, file);
    const full = { size: 512, rate, frames: 0, bytes: file.length };
    return { duration: animation.duration, sourceRate: animation.sourceFrameRate, full, variants, today: null };
  } finally {
    animation.close();
  }
}

async function run(): Promise<void> {
  for (;;) {
    const response = await fetch('/job');
    if (response.status !== 200) break;
    const job = (await response.json()) as Job;
    let result: object;
    try {
      result = await (mode === 'filters' ? filtersFor(job) : choicesFor(job));
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    await send('/result', JSON.stringify({ id: job.id, format: job.format, ...result }));
  }
  document.title = 'finished';
}

void run();
