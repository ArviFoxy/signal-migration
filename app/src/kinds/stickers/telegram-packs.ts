// The user's installed Telegram sticker packs, in the order the user arranged them in Telegram, and the files of
// their stickers.

import type * as Td from 'tdlib-types';
import { type TelegramClient, untilNotRestarted } from '../../telegram/client';

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
/** A file given out before a restart of TDLib that its pack no longer has. */
const FILE_GONE = 'the sticker is no longer in its pack on Telegram';

/** A file this source gave out: TDLib's number for it in the run that gave it, and how to find it again. */
type IssuedFile = { run: number; id: number; setId: string; uniqueId: string };

function toPack(set: Td.stickerSet, issue: (file: Td.file) => number): TelegramPack {
  return {
    setId: set.id,
    title: set.title,
    stickers: set.stickers.map((sticker) => {
      const mimeType = sticker.thumbnail ? IMAGE_THUMBNAILS[sticker.thumbnail.format._] : undefined;
      return {
        fileId: issue(sticker.sticker),
        uniqueId: sticker.sticker.remote.unique_id,
        emoji: sticker.emoji,
        format: FORMATS[sticker.format._],
        thumbnail: sticker.thumbnail && mimeType ? { fileId: issue(sticker.thumbnail.file), mimeType } : null,
      };
    }),
  };
}

/**
 * The logged-in Telegram account as a source of packs and files.
 *
 * TDLib numbers files anew in every run, so after a restart an old number may name another file. The packs therefore
 * carry this source's own file numbers. A file given out in an earlier run is found again by reading its pack in the
 * current run and matching Telegram's permanent identifier of the file (`unique_id`).
 */
export function telegramSource(client: TelegramClient): TelegramSource {
  const issued: IssuedFile[] = [];
  /** The files of a pack in one run, by their permanent identifier; keyed by run and pack. */
  const reread = new Map<string, Promise<Map<string, number>>>();

  const readPack = async (setId: string): Promise<TelegramPack> => {
    const run = client.run;
    const set = await client.invoke({ _: 'getStickerSet', set_id: setId });
    return toPack(set, (file) => issued.push({ run, id: file.id, setId, uniqueId: file.remote.unique_id }) - 1);
  };

  const filesInRun = (run: number, setId: string): Promise<Map<string, number>> => {
    const key = `${run}:${setId}`;
    let files = reread.get(key);
    if (!files) {
      files = client.invoke({ _: 'getStickerSet', set_id: setId }).then((set) => {
        const byUniqueId = new Map<string, number>();
        for (const sticker of set.stickers)
          for (const file of [sticker.sticker, sticker.thumbnail?.file])
            if (file?.remote.unique_id) byUniqueId.set(file.remote.unique_id, file.id);
        return byUniqueId;
      });
      reread.set(key, files);
      files.catch(() => reread.delete(key));
    }
    return files;
  };

  /** TDLib's number in the current run for a file this source gave out. */
  const currentId = async (fileId: number): Promise<number> => {
    const file = issued[fileId];
    if (file.run === client.run) return file.id;
    const id = file.uniqueId ? (await filesInRun(client.run, file.setId)).get(file.uniqueId) : undefined;
    if (id === undefined) throw new Error(FILE_GONE);
    return id;
  };

  return {
    readPacks: (onProgress) => untilNotRestarted(() => readInstalledPacks(client, readPack, onProgress)),
    readFile: (fileId) => untilNotRestarted(async () => client.readFile(await currentId(fileId))),
  };
}

/** Lists the installed regular sticker packs with all their stickers. `onProgress` gets (packs read, packs total). */
async function readInstalledPacks(
  client: TelegramClient,
  readPack: (setId: string) => Promise<TelegramPack>,
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
      packs[index] = await readPack(sets[index].id);
      onProgress(++done, sets.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_REQUESTS, sets.length) }, readNext));
  return packs;
}
