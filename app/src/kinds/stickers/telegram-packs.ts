// The user's installed Telegram sticker packs, in the order the user arranged them in Telegram, and the files of
// their stickers.

import type * as Td from 'tdlib-types';
import { type TelegramClient, TelegramError, untilNotRestarted } from '../../telegram/client';
import { patiently } from '../../telegram/patiently';

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
  readPacks(onProgress: (done: number, total: number) => void, cancel?: AbortSignal): Promise<TelegramPack[]>;
  readFile(fileId: number, cancel?: AbortSignal): Promise<Uint8Array>;
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
type IssuedFile = { run: number; id: number; setId: string; setName: string; uniqueId: string };

/** Races a shared promise against one caller's AbortSignal without aborting the shared work for other callers. */
function withAbort<T>(promise: Promise<T>, cancel?: AbortSignal): Promise<T> {
  if (!cancel) return promise;
  if (cancel.aborted) return Promise.reject(cancel.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancel.reason ?? new DOMException('Aborted', 'AbortError'));
    cancel.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cancel.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        cancel.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

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
  /**
   * Per-run installed sticker sets fetch. Because TDLib runs with `useDatabase: false`, every fresh run starts with an
   * empty in-memory sticker-set cache, so `getStickerSet(set_id)` returns 400 "Sticker set not found" until
   * `getInstalledStickerSets` populates the sets' access hashes in that run.
   */
  const installedInRun = new Map<number, Promise<Td.stickerSetInfo[]>>();
  /** The files of a pack in one run, by their permanent identifier; keyed by run and pack. */
  const reread = new Map<string, Promise<Map<string, number>>>();

  const ensureInstalledInRun = (run: number): Promise<Td.stickerSetInfo[]> => {
    let list = installedInRun.get(run);
    if (!list) {
      list = patiently(() =>
        client.invokeInRun(run, { _: 'getInstalledStickerSets', sticker_type: { _: 'stickerTypeRegular' } }),
      ).then(({ sets }) => sets);
      installedInRun.set(run, list);
      list.catch(() => {
        if (installedInRun.get(run) === list) installedInRun.delete(run);
      });
    }
    return list;
  };

  const readPack = async (run: number, setId: string, setName: string, cancel?: AbortSignal): Promise<TelegramPack> => {
    const set = await patiently(() => client.invokeInRun(run, { _: 'getStickerSet', set_id: setId }), cancel);
    const name = set.name || setName;
    return toPack(
      set,
      (file) => issued.push({ run, id: file.id, setId, setName: name, uniqueId: file.remote.unique_id }) - 1,
    );
  };

  const fetchSetInRun = async (run: number, setId: string, setName: string): Promise<Td.stickerSet> => {
    await ensureInstalledInRun(run);
    try {
      return await patiently(() => client.invokeInRun(run, { _: 'getStickerSet', set_id: setId }));
    } catch (error) {
      // A pack uninstalled on another device after readPacks is no longer in getInstalledStickerSets; look it up by
      // its short name so TDLib fetches its access hash from Telegram.
      if (setName && error instanceof TelegramError && error.code === 400 && /not found/i.test(error.message)) {
        return patiently(() => client.invokeInRun(run, { _: 'searchStickerSet', name: setName, ignore_cache: false }));
      }
      throw error;
    }
  };

  const filesInRun = (run: number, setId: string, setName: string): Promise<Map<string, number>> => {
    const key = `${run}:${setId}`;
    let files = reread.get(key);
    if (!files) {
      files = fetchSetInRun(run, setId, setName).then((set) => {
        const byUniqueId = new Map<string, number>();
        for (const sticker of set.stickers)
          for (const file of [sticker.sticker, sticker.thumbnail?.file])
            if (file?.remote.unique_id) byUniqueId.set(file.remote.unique_id, file.id);
        return byUniqueId;
      });
      reread.set(key, files);
      files.catch(() => {
        if (reread.get(key) === files) reread.delete(key);
      });
    }
    return files;
  };

  /** TDLib's number in one run for a file this source gave out, paired with that run. */
  const currentId = async (fileId: number, cancel?: AbortSignal): Promise<{ run: number; id: number }> => {
    const run = client.run;
    const file = issued[fileId];
    if (file.run === run) return { run, id: file.id };
    const id = file.uniqueId
      ? (await withAbort(filesInRun(run, file.setId, file.setName), cancel)).get(file.uniqueId)
      : undefined;
    if (id === undefined) throw new Error(FILE_GONE);
    return { run, id };
  };

  return {
    readPacks: (onProgress, cancel) =>
      untilNotRestarted(() => {
        cancel?.throwIfAborted();
        return readInstalledPacks(client.run, ensureInstalledInRun, readPack, onProgress, cancel);
      }),
    readFile: (fileId, cancel) =>
      untilNotRestarted(async () => {
        cancel?.throwIfAborted();
        const { run, id } = await currentId(fileId, cancel);
        return patiently(() => client.readFile(id, run, cancel), cancel);
      }),
  };
}

/** Lists the installed regular sticker packs with all their stickers. `onProgress` gets (packs read, packs total). */
async function readInstalledPacks(
  run: number,
  ensureInstalledInRun: (run: number) => Promise<Td.stickerSetInfo[]>,
  readPack: (run: number, setId: string, setName: string, cancel?: AbortSignal) => Promise<TelegramPack>,
  onProgress: (done: number, total: number) => void,
  cancel?: AbortSignal,
): Promise<TelegramPack[]> {
  cancel?.throwIfAborted();
  const sets = await withAbort(ensureInstalledInRun(run), cancel);
  cancel?.throwIfAborted();
  const packs: TelegramPack[] = new Array(sets.length);
  let next = 0;
  let done = 0;
  onProgress(0, sets.length);
  const readNext = async (): Promise<void> => {
    while (next < sets.length) {
      cancel?.throwIfAborted();
      const index = next++;
      packs[index] = await readPack(run, sets[index].id, sets[index].name, cancel);
      cancel?.throwIfAborted();
      onProgress(++done, sets.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_REQUESTS, sets.length) }, readNext));
  return packs;
}
