// The user's installed Telegram sticker packs, in the order the user arranged them in Telegram, and the files of
// their stickers.

import type * as Td from 'tdlib-types';
import type { TelegramClient } from '../../telegram/client';

export type StickerFormat = 'webp' | 'tgs' | 'webm';

/** A small preview image of a sticker, in a format an <img> element shows. */
export type Thumbnail = { fileId: number; mimeType: string };

export type TelegramSticker = {
  fileId: number;
  /** Telegram's identifier of the sticker file, the same for every user and stable over time. */
  uniqueId: string;
  emoji: string;
  format: StickerFormat;
  thumbnail: Thumbnail | null;
};

export type TelegramPack = {
  setId: string;
  title: string;
  stickers: TelegramSticker[];
};

/** Where the migration reads Telegram data from: the user's account in the app, simulated data in tests. */
export interface TelegramSource {
  readPacks(onProgress: (done: number, total: number) => void): Promise<TelegramPack[]>;
  readFile(fileId: number): Promise<Uint8Array>;
}

const FORMATS: Record<Td.StickerFormat['_'], StickerFormat> = {
  stickerFormatWebp: 'webp',
  stickerFormatTgs: 'tgs',
  stickerFormatWebm: 'webm',
};
const IMAGE_THUMBNAILS: Partial<Record<Td.ThumbnailFormat['_'], string>> = {
  thumbnailFormatWebp: 'image/webp',
  thumbnailFormatJpeg: 'image/jpeg',
  thumbnailFormatPng: 'image/png',
  thumbnailFormatGif: 'image/gif',
};
const CONCURRENT_REQUESTS = 4;

function toPack(set: Td.stickerSet): TelegramPack {
  return {
    setId: set.id,
    title: set.title,
    stickers: set.stickers.map((sticker) => {
      const mimeType = sticker.thumbnail ? IMAGE_THUMBNAILS[sticker.thumbnail.format._] : undefined;
      return {
        fileId: sticker.sticker.id,
        uniqueId: sticker.sticker.remote.unique_id,
        emoji: sticker.emoji,
        format: FORMATS[sticker.format._],
        thumbnail: sticker.thumbnail && mimeType ? { fileId: sticker.thumbnail.file.id, mimeType } : null,
      };
    }),
  };
}

/** Lists the installed regular sticker packs with all their stickers. `onProgress` gets (packs read, packs total). */
async function readInstalledPacks(
  client: TelegramClient,
  onProgress: (done: number, total: number) => void,
): Promise<TelegramPack[]> {
  const { sets } = await client.invoke({ _: 'getInstalledStickerSets', sticker_type: { _: 'stickerTypeRegular' } });
  const packs: TelegramPack[] = new Array(sets.length);
  let next = 0;
  let done = 0;
  onProgress(0, sets.length);
  const readNext = async (): Promise<void> => {
    while (next < sets.length) {
      const index = next++;
      packs[index] = toPack(await client.invoke({ _: 'getStickerSet', set_id: sets[index].id }));
      onProgress(++done, sets.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_REQUESTS, sets.length) }, readNext));
  return packs;
}

/** The logged-in Telegram account as a source of packs and files. */
export function telegramSource(client: TelegramClient): TelegramSource {
  return {
    readPacks: (onProgress) => readInstalledPacks(client, onProgress),
    readFile: (fileId) => client.readFile(fileId),
  };
}
