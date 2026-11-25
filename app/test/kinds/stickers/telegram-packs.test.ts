// Reading installed Telegram sticker packs and files across TDLib restarts (kinds/stickers/telegram-packs.ts).
// Simulates TDLib with use_database: false (third_party/td StickersManager.cpp): each fresh run starts with an empty
// in-memory sticker set cache, so getStickerSet(set_id) answers 400 "Sticker set not found" until
// getInstalledStickerSets or searchStickerSet populates the set's access_hash in that run.

import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';
import { telegramSource } from '../../../src/kinds/stickers/telegram-packs';
import { type TelegramClient, TelegramError, TelegramRestartedError } from '../../../src/telegram/client';

type SimPack = {
  id: string;
  name: string;
  title: string;
  installed: boolean;
  stickers: { uniqueId: string; emoji: string; bytes: Uint8Array }[];
};

function simulatedTelegram(
  packs: SimPack[],
  options: {
    restartOnGetSetCall?: number;
    rateLimitOnceOn?: string[];
  } = {},
) {
  let run = 1;
  let knownSets = new Set<string>();
  let nextFileId = 1;
  const filesByRun = new Map<string, Uint8Array>();
  const requests: { run: number; _: string; [key: string]: unknown }[] = [];
  const rateLimited = new Set(options.rateLimitOnceOn ?? []);
  let getSetCalls = 0;
  let restarted = false;

  const stickerSetResult = (pack: SimPack, forRun: number): Td.stickerSet =>
    ({
      _: 'stickerSet',
      id: pack.id,
      title: pack.title,
      name: pack.name,
      stickers: pack.stickers.map((s) => {
        const id = nextFileId++;
        filesByRun.set(`${forRun}:${id}`, s.bytes);
        return {
          _: 'sticker',
          emoji: s.emoji,
          format: { _: 'stickerFormatWebp' },
          sticker: {
            _: 'file',
            id,
            remote: { _: 'remoteFile', id: `remote-${s.uniqueId}`, unique_id: s.uniqueId },
          },
        };
      }),
    }) as unknown as Td.stickerSet;

  const invokeInRun = async (pinnedRun: number, query: { _: string; [key: string]: unknown }) => {
    if (pinnedRun !== run) throw new TelegramRestartedError();
    requests.push({ run: pinnedRun, ...query });
    if (rateLimited.has(query._)) {
      rateLimited.delete(query._);
      throw new TelegramError(429, 'Too Many Requests: retry after 0');
    }
    switch (query._) {
      case 'getInstalledStickerSets': {
        const installed = packs.filter((p) => p.installed);
        for (const pack of installed) knownSets.add(pack.id);
        return {
          _: 'stickerSets',
          sets: installed.map((p) => ({ _: 'stickerSetInfo', id: p.id, title: p.title, name: p.name })),
        };
      }
      case 'getStickerSet': {
        getSetCalls++;
        if (options.restartOnGetSetCall === getSetCalls && !restarted) {
          restarted = true;
          run++;
          knownSets = new Set();
          throw new TelegramRestartedError();
        }
        const setId = String(query.set_id);
        if (!knownSets.has(setId)) {
          throw new TelegramError(400, 'Sticker set not found');
        }
        const pack = packs.find((p) => p.id === setId);
        if (!pack) throw new TelegramError(400, 'Sticker set not found');
        return stickerSetResult(pack, pinnedRun);
      }
      case 'searchStickerSet': {
        const pack = packs.find((p) => p.name === query.name);
        if (!pack) throw new TelegramError(400, 'Sticker set not found');
        knownSets.add(pack.id);
        return stickerSetResult(pack, pinnedRun);
      }
      default:
        throw new Error(`not simulated: ${query._}`);
    }
  };

  const client = {
    get run() {
      return run;
    },
    invoke: (query: { _: string; [key: string]: unknown }) => invokeInRun(run, query),
    invokeInRun,
    async readFile(fileId: number, pinnedRun: number = run) {
      if (pinnedRun !== run) throw new TelegramRestartedError();
      const bytes = filesByRun.get(`${pinnedRun}:${fileId}`);
      if (!bytes) throw new TelegramError(400, 'File not found');
      return bytes;
    },
  } as unknown as TelegramClient;

  return {
    client,
    requests,
    bumpRun() {
      run++;
      knownSets = new Set();
    },
  };
}

const enc = (text: string) => new TextEncoder().encode(text);

describe('reading Telegram sticker packs across TDLib restarts', () => {
  // Detects: after TDLib restarts (useDatabase: false), filesInRun calling getStickerSet(set_id) directly without
  // re-hydrating getInstalledStickerSets in the new run, causing every remaining pack to fail with
  // "Sticker set not found".
  it('hydrates installed sticker sets once in a new run before re-reading packs after a TDLib restart', async () => {
    const packs: SimPack[] = [
      {
        id: '101',
        name: 'red_fox',
        title: 'Red Fox',
        installed: true,
        stickers: [{ uniqueId: 'u1', emoji: '🦊', bytes: enc('fox-1') }],
      },
      {
        id: '102',
        name: 'bambi_pack',
        title: 'Bambi pack',
        installed: true,
        stickers: [{ uniqueId: 'u2', emoji: '🦌', bytes: enc('bambi-1') }],
      },
      {
        id: '103',
        name: 'rumcat',
        title: 'Rumcat',
        installed: true,
        stickers: [{ uniqueId: 'u3', emoji: '🐱', bytes: enc('cat-1') }],
      },
    ];
    const { client, requests, bumpRun } = simulatedTelegram(packs);
    const source = telegramSource(client);

    const read = await source.readPacks(() => undefined);
    expect(read).toHaveLength(3);

    // TDLib restarts into Run 2 with an empty in-memory sticker_sets_ map.
    bumpRun();

    const downloaded = await Promise.all(read.map((p) => source.readFile(p.stickers[0].fileId)));
    expect(downloaded.map((b) => new TextDecoder().decode(b))).toEqual(['fox-1', 'bambi-1', 'cat-1']);

    // Run 2 should call getInstalledStickerSets exactly once, shared across all 3 packs.
    const run2ListCalls = requests.filter((r) => r.run === 2 && r._ === 'getInstalledStickerSets');
    expect(run2ListCalls).toHaveLength(1);
  });

  // Detects: a pack that was uninstalled on another device between readPacks and readFile failing permanently after
  // a TDLib restart instead of falling back to searchStickerSet(name).
  it('falls back to searchStickerSet by name when getStickerSet answers Sticker set not found in a new run', async () => {
    const packs: SimPack[] = [
      {
        id: '201',
        name: 'gone_pack',
        title: 'Uninstalled Pack',
        installed: true,
        stickers: [{ uniqueId: 'u201', emoji: '⭐', bytes: enc('star-1') }],
      },
    ];
    const { client, requests, bumpRun } = simulatedTelegram(packs);
    const source = telegramSource(client);

    const [pack] = await source.readPacks(() => undefined);
    packs[0].installed = false;
    bumpRun();

    const bytes = await source.readFile(pack.stickers[0].fileId);
    expect(new TextDecoder().decode(bytes)).toBe('star-1');
    expect(requests.some((r) => r.run === 2 && r._ === 'searchStickerSet' && r.name === 'gone_pack')).toBe(true);
  });

  // Detects: TDLib restarting mid-readPacks leaving subsequent readPack calls in Run 2 without getInstalledStickerSets.
  it('re-hydrates installed sets and succeeds when TDLib restarts mid-readPacks', async () => {
    const packs: SimPack[] = [
      {
        id: '301',
        name: 'pack_a',
        title: 'A',
        installed: true,
        stickers: [{ uniqueId: 'ua', emoji: '🅰', bytes: enc('a') }],
      },
      {
        id: '302',
        name: 'pack_b',
        title: 'B',
        installed: true,
        stickers: [{ uniqueId: 'ub', emoji: '🅱', bytes: enc('b') }],
      },
    ];
    const { client } = simulatedTelegram(packs, { restartOnGetSetCall: 2 });
    const source = telegramSource(client);

    const read = await source.readPacks(() => undefined);
    expect(read.map((p) => p.title)).toEqual(['A', 'B']);
  });

  // Detects: Telegram 429 flood waits on getInstalledStickerSets or getStickerSet failing the migration instead of
  // retrying patiently.
  it('retries patiently when Telegram answers 429 on sticker set requests', async () => {
    const packs: SimPack[] = [
      {
        id: '401',
        name: 'rate_limited',
        title: 'Rate Limited',
        installed: true,
        stickers: [{ uniqueId: 'ur', emoji: '🐢', bytes: enc('slow') }],
      },
    ];
    const { client } = simulatedTelegram(packs, { rateLimitOnceOn: ['getInstalledStickerSets', 'getStickerSet'] });
    const source = telegramSource(client);

    const read = await source.readPacks(() => undefined);
    expect(read).toHaveLength(1);
    expect(new TextDecoder().decode(await source.readFile(read[0].stickers[0].fileId))).toBe('slow');
  });

  // Detects: a shared per-run 429 sleep in ensureInstalledInRun staying stuck for up to 300 s after TDLib restarts
  // into a new run, and readFile failing on TDLib's 400 "File download has failed or was canceled" without refreshing.
  it('aborts a stale run 429 wait immediately on restart and refreshes a sticker set on 400 download failure', async () => {
    let run = 1;
    let runController = new AbortController();
    let listCalls = 0;
    let setCalls = 0;
    let readCalls = 0;

    const makeSet = (fileId: number): Td.stickerSet =>
      ({
        _: 'stickerSet',
        id: '501',
        title: 'Fresh',
        name: 'fresh_pack',
        stickers: [
          {
            _: 'sticker',
            emoji: '✨',
            format: { _: 'stickerFormatWebp' },
            sticker: { _: 'file', id: fileId, remote: { _: 'remoteFile', id: 'r501', unique_id: 'u501' } },
          },
        ],
      }) as unknown as Td.stickerSet;

    const client = {
      get run() {
        return run;
      },
      runSignal(forRun: number) {
        if (forRun !== run) {
          const c = new AbortController();
          c.abort();
          return c.signal;
        }
        return runController.signal;
      },
      async invokeInRun(pinnedRun: number, query: { _: string }) {
        if (pinnedRun !== run) throw new TelegramRestartedError();
        if (query._ === 'getInstalledStickerSets') {
          listCalls++;
          if (listCalls === 1) {
            setTimeout(() => {
              run = 2;
              const prev = runController;
              runController = new AbortController();
              prev.abort();
            }, 15);
            throw new TelegramError(429, 'Too Many Requests: retry after 120');
          }
          return { _: 'stickerSets', sets: [{ _: 'stickerSetInfo', id: '501', title: 'Fresh', name: 'fresh_pack' }] };
        }
        if (query._ === 'getStickerSet') {
          setCalls++;
          return makeSet(10 + setCalls);
        }
        throw new Error(`not simulated: ${query._}`);
      },
      async readFile(fileId: number) {
        readCalls++;
        if (readCalls === 1) throw new TelegramError(400, 'File download has failed or was canceled');
        return enc(`sticker-${fileId}`);
      },
    } as unknown as TelegramClient;

    const source = telegramSource(client);
    const startedAt = Date.now();
    const [pack] = await source.readPacks(() => undefined);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(run).toBe(2);

    const bytes = await source.readFile(pack.stickers[0].fileId);
    expect(readCalls).toBe(2);
    expect(setCalls).toBe(2);
    expect(new TextDecoder().decode(bytes)).toBe('sticker-12');
  });
});
