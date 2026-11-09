// Reads the user's installed Telegram sticker packs, in the order the user arranged them in Telegram.

import type * as Td from 'tdlib-types';
import type { TelegramClient } from '../../telegram/client';

export type StickerFormat = 'webp' | 'tgs' | 'webm';

export type TelegramSticker = {
  file: Td.file;
  /** Telegram's identifier of the sticker file, the same for every user and stable over time. */
  uniqueId: string;
  emoji: string;
  format: StickerFormat;
  width: number;
  height: number;
};

export type TelegramPack = {
  setId: string;
  title: string;
  stickers: TelegramSticker[];
};

const FORMATS: Record<Td.StickerFormat['_'], StickerFormat> = { stickerFormatWebp: 'webp', stickerFormatTgs: 'tgs', stickerFormatWebm: 'webm' };
const CONCURRENT_REQUESTS = 4;

function toPack(set: Td.stickerSet): TelegramPack {
  return {
    setId: set.id,
    title: set.title,
    stickers: set.stickers.map((sticker) => ({
      file: sticker.sticker,
      uniqueId: sticker.sticker.remote.unique_id,
      emoji: sticker.emoji,
      format: FORMATS[sticker.format._],
      width: sticker.width,
      height: sticker.height,
    })),
  };
}

/** Lists the installed regular sticker packs with all their stickers. `onProgress` gets (packs read, packs total). */
export async function readInstalledPacks(client: TelegramClient, onProgress: (done: number, total: number) => void = () => undefined): Promise<TelegramPack[]> {
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
