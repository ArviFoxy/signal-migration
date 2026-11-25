// The comparison of a converted sticker with its Telegram file (src/kinds/stickers/compare-pictures.ts), in a real
// Chrome: it draws with the browser's canvas and runs the conversion's workers, which only a browser has. The
// stickers are converted by the app's own conversion and then compared.
//
// Every altered original below differs from the real one by several times what the comparison tolerates, and the
// app's own conversions differ from their originals by a small part of it, so these tests do not depend on the
// exact tolerance.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchChrome } from './chrome.mjs';
import { startPicturesSite } from './pictures-site.mjs';

let chrome: Awaited<ReturnType<typeof launchChrome>>;
let site: Awaited<ReturnType<typeof startPicturesSite>>;
let tab: Awaited<ReturnType<typeof chrome.openTab>>;

/** Calls a function of the page (pictures-page.ts) and resolves to what it returns; an error in the page is thrown. */
async function page<T>(name: string, ...args: unknown[]): Promise<T> {
  const expression = `Promise.resolve(pictures.${name}(${args.map((arg) => JSON.stringify(arg)).join(',')}))`;
  const { result } = await tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value as T;
}

const put = (name: string, file: Uint8Array) => page<void>('put', name, Buffer.from(file).toString('base64'));

const fixed = (value: unknown) => ({ a: 0, k: value });
type Fill = Record<string, unknown>;
const plain = (red: number, green: number, blue: number): Fill => ({
  ty: 'fl',
  c: fixed([red, green, blue, 1]),
  o: fixed(100),
  r: 1,
});
const blueToYellow: Fill = {
  ty: 'gf',
  o: fixed(100),
  r: 1,
  s: fixed([-90, 0]),
  e: fixed([90, 0]),
  t: 1,
  g: { p: 2, k: fixed([0, 0.1, 0.3, 0.9, 1, 1, 0.9, 0.2]) },
};

/** A Lottie layer: a disc that moves along `route`, a list of [frame, x, y]. */
function disc(index: number, fill: Fill, width: number, route: number[][], opacity = 100) {
  const position = route.map(([frame, x, y], i) =>
    i < route.length - 1
      ? {
          t: frame,
          s: [x, y, 0],
          e: [route[i + 1][1], route[i + 1][2], 0],
          i: { x: 0.5, y: 0.5 },
          o: { x: 0.5, y: 0.5 },
        }
      : { t: frame, s: [x, y, 0] },
  );
  return {
    ddd: 0,
    ind: index,
    ty: 4,
    sr: 1,
    ks: {
      o: fixed(opacity),
      r: fixed(0),
      p: { a: 1, k: position },
      a: fixed([0, 0, 0]),
      s: fixed([100, 100, 100]),
    },
    ao: 0,
    shapes: [
      {
        ty: 'gr',
        it: [
          { ty: 'el', d: 1, p: fixed([0, 0]), s: fixed([width, width]) },
          fill,
          { ty: 'tr', p: fixed([0, 0]), a: fixed([0, 0]), s: fixed([100, 100]), r: fixed(0), o: fixed(100) },
        ],
      },
    ],
    ip: 0,
    op: 120,
    st: 0,
    bm: 0,
  };
}

/**
 * A Telegram animated sticker (TGS, a gzipped Lottie animation) of two seconds: three discs that move, one of them
 * with a colour gradient. The options alter it: the colour of the first disc, how far the second disc leaves its
 * route in pixels, and a fourth disc 24 pixels wide in a corner.
 */
function animatedSticker(options: { firstDisc?: number[]; detour?: number; fourthDisc?: boolean } = {}): Uint8Array {
  const [red, green, blue] = options.firstDisc ?? [0.9, 0.2, 0.2];
  const detour = options.detour ?? 0;
  const layers = [
    disc(1, plain(red, green, blue), 170, [
      [0, 120, 140],
      [60, 390, 200],
      [120, 120, 140],
    ]),
    disc(2, blueToYellow, 180, [
      [0, 380, 380],
      [40, 250, 300 + detour],
      [80, 150, 380 - detour],
      [120, 380, 380],
    ]),
    disc(
      3,
      plain(0.2, 0.7, 0.3),
      120,
      [
        [0, 256, 80],
        [60, 256, 430],
        [120, 256, 80],
      ],
      70,
    ),
  ];
  if (options.fourthDisc) {
    layers.unshift(
      disc(4, plain(0.05, 0.05, 0.05), 24, [
        [0, 60, 460],
        [120, 60, 460],
      ]),
    );
  }
  const lottie = { v: '5.7.0', fr: 60, ip: 0, op: 120, w: 512, h: 512, ddd: 0, assets: [], layers };
  return zlib.gzipSync(JSON.stringify(lottie));
}

beforeAll(async () => {
  site = await startPicturesSite();
  chrome = await launchChrome();
  tab = await chrome.openTab();
  await tab.navigate(site.base);
  if (!(await tab.waitFor('window.pictures', 10_000))) {
    throw new Error(`the page did not start: ${tab.errors.join('; ')}`);
  }
  const video = fs.readFileSync(path.resolve(import.meta.dirname, '../test/fixtures/stickers/moving-square.webm'));
  await put('video.webm', video);
  await put('animation.tgs', animatedSticker());
  await put('other-colour.tgs', animatedSticker({ firstDisc: [0.2, 0.2, 0.9] }));
  await put('other-route.tgs', animatedSticker({ detour: 30 }));
  await put('fourth-disc.tgs', animatedSticker({ fourthDisc: true }));
  await page('convert', 'video.webm', 'webm', 'video.png');
  await page('convert', 'animation.tgs', 'tgs', 'animation.png');
  const stillBytes = await page<number>('drawStill', 'still.webp', false);
  await page('drawStill', 'marked-still.webp', true);
  const still = await page<{ reencoded: boolean }>('convert', 'still.webp', 'webp', 'still-converted.webp');
  if (stillBytes <= 300 * 1024 || !still.reencoded) throw new Error('the still picture was not encoded again');
  await page('drawStill', 'see-through.webp', false, true);
  await page('convert', 'see-through.webp', 'webp', 'see-through-converted.webp');
}, 120_000);

afterAll(async () => {
  await chrome?.close();
  await site?.stop();
});

// Detects: the comparison refusing copies that the app itself made, so that no pack is ever taken from the index
// and every user uploads every pack again.
it("accepts the app's own conversion of a video sticker", async () => {
  expect(await page('sameAnimation', 'video.png', 'video.webm', 'webm')).toBe(true);
});

it("accepts the app's own conversion of a vector animation", async () => {
  expect(await page('sameAnimation', 'animation.png', 'animation.tgs', 'tgs')).toBe(true);
});

it("accepts the app's own lower-quality encoding of a large still picture", async () => {
  expect(await page('sameStill', 'still-converted.webp', 'still.webp')).toBe(true);
});

it("accepts the app's own lower-quality encoding of a still picture with transparency", async () => {
  expect(await page('sameStill', 'see-through-converted.webp', 'see-through.webp')).toBe(true);
});

// Detects: the files that this browser's encoders write refused by the check that a file holds nothing but its
// picture (plain-png.ts, plain-webp.ts), so that every converted sticker fails its comparison.
it("finds nothing but the picture in the app's own conversions", async () => {
  expect(await page('isPlainPng', 'video.png'), 'the converted video').toBe(true);
  expect(await page('isPlainPng', 'animation.png'), 'the converted vector animation').toBe(true);
  expect(await page('isPlainWebp', 'still-converted.webp'), 'the still picture').toBe(true);
  expect(await page('isPlainWebp', 'see-through-converted.webp'), 'the still picture with transparency').toBe(true);
});

// Detects: the comparison accepting a copy that shows something else than the Telegram sticker, so that a copy with
// replaced pictures is installed.
it('refuses an animation in which a shape has another colour', async () => {
  expect(await page('sameAnimation', 'animation.png', 'other-colour.tgs', 'tgs')).toBe(false);
});

it('refuses an animation in which a shape moves along another route', async () => {
  expect(await page('sameAnimation', 'animation.png', 'other-route.tgs', 'tgs')).toBe(false);
});

it('refuses an animation with one more small shape', async () => {
  expect(await page('sameAnimation', 'animation.png', 'fourth-disc.tgs', 'tgs')).toBe(false);
});

it('refuses a still picture with one more small shape', async () => {
  expect(await page('sameStill', 'still-converted.webp', 'marked-still.webp')).toBe(false);
});

// Detects: a file of another length or frame rate than the app makes for this original being drawn and compared
// frame by frame anyway, where the frames no longer belong to the same moments.
it('refuses the conversion of an animation of another length', async () => {
  expect(await page('sameAnimation', 'video.png', 'animation.tgs', 'tgs')).toBe(false);
});

// Detects: APNG polyglot (fdAT directly after IDAT without fcTL) passing isPlainPng on a real converted animation.
it('refuses a real APNG polyglot where fdAT immediately follows IDAT without fcTL', async () => {
  const animBytes = Uint8Array.from(Buffer.from(await page<string>('getBase64', 'animation.png'), 'base64'));
  const view = new DataView(animBytes.buffer, animBytes.byteOffset, animBytes.byteLength);
  const chunks: { kind: string; data: Uint8Array }[] = [];
  for (let at = 8; at < animBytes.length;) {
    const len = view.getUint32(at);
    chunks.push({
      kind: String.fromCharCode(...animBytes.subarray(at + 4, at + 8)),
      data: animBytes.slice(at + 8, at + 8 + len),
    });
    at += 12 + len;
  }
  const idatIdx = chunks.findIndex((c) => c.kind === 'IDAT');
  const firstFdat = chunks.find((c) => c.kind === 'fdAT')!;
  const polyChunks = chunks.slice();
  polyChunks.splice(idatIdx + 1, 0, { kind: 'fdAT', data: firstFdat.data.slice() });
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const { kind, data } of polyChunks) {
    const body = new Uint8Array([...kind].map((c) => c.charCodeAt(0)).concat([...data]));
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, data.length);
    const sumBuf = new Uint8Array(4);
    new DataView(sumBuf.buffer).setUint32(0, zlib.crc32(body));
    parts.push(...lenBuf, ...body, ...sumBuf);
  }
  await put('polyglot.png', new Uint8Array(parts));
  expect(await page('isPlainPng', 'polyglot.png')).toBe(false);
});

// Detects: untrusted .tgs Lottie JSON with fonts.list or external assets triggering SSRF requests or injecting
// <link rel="stylesheet"> elements into document.head when lottie-web loads the sticker.
it('strips fonts and external assets from .tgs stickers so lottie-web makes zero external requests', async () => {
  site.trapHits.length = 0;
  const linksBefore = await page<number>('headLinkCount');
  const raw = JSON.parse(zlib.gunzipSync(animatedSticker()).toString('utf8')) as Record<string, unknown>;
  raw.fonts = {
    list: [
      {
        origin: 1,
        fPath: `${site.base}trap/font.css`,
        fClass: '',
        fFamily: 'EvilFont',
        fWeight: '',
        fStyle: 'Regular',
        fName: 'EvilFont-Regular',
        ascent: 75,
      },
    ],
  };
  raw.assets = [
    {
      id: 'evil_img',
      w: 64,
      h: 64,
      u: `${site.base}trap/`,
      p: 'evil.png',
      e: 0,
    },
  ];
  await put('trapped.tgs', zlib.gzipSync(JSON.stringify(raw)));
  await page('convert', 'trapped.tgs', 'tgs', 'trapped.png');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(site.trapHits).toEqual([]);
  expect(await page<number>('headLinkCount')).toBe(linksBefore);
});

// Detects: a corrupt-zlib untrusted PNG throwing out of animationDifference/sameAnimation (aborting pack
// verification) instead of returning null/false so the next candidate or upload proceeds.
it('returns false cleanly when comparing a PNG with corrupted zlib data', async () => {
  const animBytes = Uint8Array.from(Buffer.from(await page<string>('getBase64', 'animation.png'), 'base64'));
  const view = new DataView(animBytes.buffer, animBytes.byteOffset, animBytes.byteLength);
  const chunks: { kind: string; data: Uint8Array }[] = [];
  for (let at = 8; at < animBytes.length;) {
    const len = view.getUint32(at);
    chunks.push({
      kind: String.fromCharCode(...animBytes.subarray(at + 4, at + 8)),
      data: animBytes.slice(at + 8, at + 8 + len),
    });
    at += 12 + len;
  }
  const corrupt = chunks.map((c) =>
    c.kind === 'IDAT' ? { kind: 'IDAT', data: new Uint8Array([0xff, 0xff, 0xff]) } : c,
  );
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const { kind, data } of corrupt) {
    const body = new Uint8Array([...kind].map((c) => c.charCodeAt(0)).concat([...data]));
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, data.length);
    const sumBuf = new Uint8Array(4);
    new DataView(sumBuf.buffer).setUint32(0, zlib.crc32(body));
    parts.push(...lenBuf, ...body, ...sumBuf);
  }
  await put('corrupt-zlib.png', new Uint8Array(parts));
  expect(await page('sameAnimation', 'corrupt-zlib.png', 'animation.tgs', 'tgs')).toBe(false);
});

// Detects: a tiny gzip-bomb .tgs unpacking unbounded JSON into browser memory.
it('rejects a .tgs gzip bomb exceeding the decompressed size limit', async () => {
  const bomb = zlib.gzipSync(' '.repeat(5 * 1024 * 1024) + '{}');
  await put('bomb.tgs', bomb);
  await expect(page('convert', 'bomb.tgs', 'tgs', 'bomb.png')).rejects.toThrow(/large|limit|size/i);
});

// Detects: Emscripten ignoring Module.wasmBinary and calling new URL("webm-decoder.wasm", import.meta.url) inside a
// blob: worker on attested builds, causing every .webm sticker to fail with "Failed to construct 'URL': Invalid URL".
it('decodes a WebM video sticker in a blob: worker initialized with wasmBinary (attested build path)', async () => {
  const result = await page<{ duration: number; frameRate: number; frameCount: number; firstFrameBytes: number }>(
    'decodeWebmInBlobWorker',
    'video.webm',
  );
  expect(result.duration).toBeGreaterThan(0);
  expect(result.frameCount).toBe(3);
  expect(result.firstFrameBytes).toBe(128 * 128 * 4);
});
