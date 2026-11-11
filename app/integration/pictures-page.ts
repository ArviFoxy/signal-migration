// The page of pictures.test.ts: the app's sticker conversion and picture comparison, for the test to call. Files
// stay in the page under names, so that the test moves each file into the page once.

import { animationDifference, browserPictures, stillDifference } from '../src/kinds/stickers/compare-pictures';
import { convertSticker } from '../src/kinds/stickers/convert';
import { isPlainPng } from '../src/kinds/stickers/plain-png';
import { isPlainWebp } from '../src/kinds/stickers/plain-webp';
import type { StickerFormat } from '../src/kinds/stickers/telegram-packs';

const files = new Map<string, Uint8Array>();

function file(name: string): Uint8Array {
  const found = files.get(name);
  if (!found) throw new Error(`the page holds no file named ${name}`);
  return found;
}

/** A generator of numbers between 0 and 1 that gives the same sequence for the same seed (mulberry32). */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const pictures = {
  /** Keeps a file, given in base64, under `name`. */
  put(name: string, base64: string): void {
    files.set(
      name,
      Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
    );
  },

  /** Converts the file `from` as the app does and keeps the result under `to`. */
  async convert(from: string, format: StickerFormat, to: string) {
    const converted = await convertSticker(file(from), format);
    files.set(to, converted.image);
    return { bytes: converted.image.length, animation: converted.animation, reencoded: converted.reencoded };
  },

  sameAnimation: (converted: string, original: string, format: 'tgs' | 'webm') =>
    browserPictures.sameAnimation(file(converted), file(original), format),
  sameStill: (converted: string, original: string) => browserPictures.sameStill(file(converted), file(original)),
  animationDifference: (converted: string, original: string, format: 'tgs' | 'webm') =>
    animationDifference(file(converted), file(original), format),
  stillDifference: (converted: string, original: string) => stillDifference(file(converted), file(original)),
  isPlainPng: (name: string) => isPlainPng(file(name)),
  isPlainWebp: (name: string) => isPlainWebp(file(name)),

  /**
   * Draws a still picture of 512 × 512 pixels with fine detail, so that its lossless WebP is larger than Signal's
   * limit, and keeps the WebP under `name`. With `mark`, the picture has one more disc, 40 pixels wide. With
   * `transparent`, a band on its left is see-through. Returns the size of the file in bytes.
   */
  async drawStill(name: string, mark: boolean, transparent = false): Promise<number> {
    const size = 512;
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d')!;
    const random = seededRandom(7);
    const gradient = context.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#2060c0');
    gradient.addColorStop(1, '#f0c040');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    for (let i = 0; i < 40; i++) {
      context.fillStyle = `hsl(${Math.floor(random() * 360)} 70% 55% / 0.8)`;
      context.beginPath();
      context.arc(random() * size, random() * size, 10 + random() * 50, 0, 2 * Math.PI);
      context.fill();
    }
    if (mark) {
      context.fillStyle = '#101010';
      context.beginPath();
      context.arc(400, 100, 20, 0, 2 * Math.PI);
      context.fill();
    }
    const image = context.getImageData(0, 0, size, size);
    for (let at = 0; at < image.data.length; at += 4) {
      for (let channel = 0; channel < 3; channel++) image.data[at + channel] += Math.round((random() - 0.5) * 24);
    }
    context.putImageData(image, 0, 0);
    if (transparent) context.clearRect(0, 0, 96, size);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 1 });
    files.set(name, new Uint8Array(await blob.arrayBuffer()));
    return blob.size;
  },
};

export type PicturesPage = typeof pictures;
Object.assign(window, { pictures });
