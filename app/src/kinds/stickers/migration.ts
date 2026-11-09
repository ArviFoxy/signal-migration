// The sticker pack migration: which of the user's Telegram packs Signal already has, which someone else has
// uploaded, which need uploading, and the run that installs and uploads them.
//
// Nothing is stored between visits. A later visit computes the same state from Telegram, the sticker pack index
// and the Signal account, so a migration that stopped (closed tab, rate limit) continues where it was.

import type { StoredStickerPack } from '../../signal/storage';
import type { SignalConnection } from '../../signal/connection';
import type { TelegramClient } from '../../telegram/client';
import { convertSticker } from './convert';
import { type PackIdentity, packIdentity } from './identity';
import { assignPositions, insertPacks } from './order';
import { PackIndex, toHex } from './pack-index';
import { readInstalledPacks, type TelegramPack } from './telegram-packs';
import { MAX_STICKERS, RateLimitedError, type StickerFile, uploadStickerPack } from './upload';

export type PackState =
  /** Looking the pack up in the index. */
  | 'checking'
  /** Installed in the user's Signal. */
  | 'in-signal'
  /** Someone already uploaded it; it only needs installing. */
  | 'available'
  | 'to-upload'
  /** Someone else is uploading it right now; checked again later. */
  | 'claimed-elsewhere'
  | 'downloading'
  | 'uploading'
  | 'installing'
  | 'failed';

export type PackEntry = {
  pack: TelegramPack;
  /** The pack's place in the user's Telegram order. */
  rank: number;
  identity: PackIdentity;
  selected: boolean;
  state: PackState;
  packId: Uint8Array | null;
  progress: { done: number; total: number } | null;
  error: string | null;
};

export type RunPhase = 'idle' | 'running' | 'done';

const CONCURRENT_VERIFICATIONS = 6;
const CONCURRENT_STICKERS = 3;
/** How long to wait before looking again at a pack someone else claimed. */
const CLAIM_RECHECK_MS = 2 * 60_000;
const STORAGE_WRITE_ATTEMPTS = 5;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signal's display order: by position, then by pack ID as a hex string. */
function signalOrder(a: StoredStickerPack, b: StoredStickerPack): number {
  return a.position - b.position || (toHex(a.packId) < toHex(b.packId) ? -1 : 1);
}

async function forEachConcurrently<T>(items: T[], limit: number, action: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const work = async () => {
    while (next < items.length) await action(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class StickerMigration extends EventTarget {
  entries: PackEntry[] = [];
  readProgress: { done: number; total: number } | null = null;
  phase: RunPhase = 'idle';
  /** While waiting for Signal's upload limit: when the next upload is allowed (ms since the epoch). */
  uploadAllowedAt: number | null = null;
  readonly index = new PackIndex();
  /** Converted stickers kept in memory while a pack waits for Signal's upload limit. */
  #converted = new Map<PackEntry, StickerFile[]>();

  #changed(): void {
    this.dispatchEvent(new Event('change'));
  }

  /** Reads the installed Telegram packs and looks each one up in the index. */
  async readTelegram(telegram: TelegramClient): Promise<void> {
    const packs = await readInstalledPacks(telegram, (done, total) => {
      this.readProgress = { done, total };
      this.#changed();
    });
    this.entries = await Promise.all(
      packs.map(async (pack, rank) => ({
        pack,
        rank,
        identity: await packIdentity({ title: pack.title, stickers: pack.stickers.map(({ uniqueId, emoji }) => ({ uniqueId, emoji })) }),
        selected: pack.stickers.length > 0 && pack.stickers.length <= MAX_STICKERS,
        state: 'checking' as PackState,
        packId: null,
        progress: null,
        error: null,
      })),
    );
    this.#changed();
    await this.index.refresh();
    await forEachConcurrently(this.entries, CONCURRENT_VERIFICATIONS, async (entry) => {
      entry.packId = await this.index.find(entry.identity.lookupKey, entry.identity.packKey);
      entry.state = entry.packId ? 'available' : 'to-upload';
      this.#changed();
    });
  }

  /** Marks the packs the Signal account already has installed. */
  async readSignal(signal: SignalConnection): Promise<void> {
    const { packs } = await (await signal.storage()).readStickerPacks();
    for (const entry of this.entries) {
      const installed = packs.find((stored) => sameBytes(stored.packKey, entry.identity.packKey));
      if (installed) {
        entry.state = 'in-signal';
        entry.packId = installed.packId;
      }
    }
    this.#changed();
  }

  setSelected(entry: PackEntry, selected: boolean): void {
    entry.selected = selected;
    this.#changed();
  }

  /**
   * Installs packs into the Signal account's storage service, each at its place in the order (order.ts). Other
   * devices can change the storage meanwhile; the write then fails with a conflict, and is computed again.
   */
  async #install(signal: SignalConnection, adding: PackEntry[]): Promise<void> {
    const rankByKey = new Map(this.entries.map((entry) => [toHex(entry.identity.packKey), entry.rank]));
    for (let attempt = 0; attempt < STORAGE_WRITE_ATTEMPTS; attempt++) {
      const storage = await signal.storage();
      const snapshot = await storage.readStickerPacks();
      const installed = new Set(snapshot.packs.map((stored) => toHex(stored.packKey)));
      const missing = adding.filter((entry) => !installed.has(toHex(entry.identity.packKey)));
      if (missing.length === 0) return;
      type Placed = { stored: StoredStickerPack } | { entry: PackEntry };
      const existing = [...snapshot.packs].sort(signalOrder).map((stored) => ({ item: { stored } as Placed, rank: rankByKey.get(toHex(stored.packKey)) ?? null }));
      const order = insertPacks(existing, missing.map((entry) => ({ item: { entry } as Placed, rank: entry.rank })));
      const positions = assignPositions(order.map((placed) => ('stored' in placed ? placed.stored.position : null)));
      const writes = order.flatMap((placed, i) => {
        if ('entry' in placed) return [{ packId: placed.entry.packId!, packKey: placed.entry.identity.packKey, position: positions[i] }];
        const { stored } = placed;
        return stored.position === positions[i] ? [] : [{ packId: stored.packId, packKey: stored.packKey, position: positions[i], replaces: stored.recordId }];
      });
      if (await storage.writeStickerPacks(snapshot, writes)) return;
    }
    throw new Error('the Signal account kept changing while installing packs; try again');
  }

  async #downloadAndConvert(telegram: TelegramClient, entry: PackEntry): Promise<StickerFile[]> {
    const stickers = entry.pack.stickers;
    const files: StickerFile[] = new Array(stickers.length);
    let done = 0;
    entry.progress = { done, total: stickers.length };
    await forEachConcurrently(
      stickers.map((sticker, i) => ({ sticker, i })),
      CONCURRENT_STICKERS,
      async ({ sticker, i }) => {
        files[i] = { image: await convertSticker(await telegram.readFile(sticker.file), sticker.format), emoji: sticker.emoji };
        entry.progress = { done: ++done, total: stickers.length };
        this.#changed();
      },
    );
    return files;
  }

  /** Migrates one pack that needs uploading. Returns false when someone else holds its claim. */
  async #migrateOne(telegram: TelegramClient, signal: SignalConnection, entry: PackEntry): Promise<boolean> {
    const { lookupKey, packKey } = entry.identity;
    if (!this.#converted.has(entry)) {
      // Someone may have uploaded the pack since the index was read.
      entry.state = 'checking';
      this.#changed();
      await this.index.refresh();
      entry.packId = await this.index.find(lookupKey, packKey);
      if (!entry.packId) {
        if (!(await this.index.claim(lookupKey))) return false;
        entry.state = 'downloading';
        this.#changed();
        this.#converted.set(entry, await this.#downloadAndConvert(telegram, entry));
      }
    }
    if (!entry.packId) {
      entry.state = 'uploading';
      this.#changed();
      const content = { title: entry.pack.title, author: `t.me/addstickers/${entry.pack.name}`, stickers: this.#converted.get(entry)! };
      entry.packId = await signal.withSession((session) =>
        uploadStickerPack(session, content, packKey, (done, total) => {
          entry.progress = { done, total };
          this.#changed();
        }),
      );
      this.#converted.delete(entry);
      await this.index.add(lookupKey, entry.packId);
    }
    entry.state = 'installing';
    this.#changed();
    await this.#install(signal, [entry]);
    entry.state = 'in-signal';
    entry.progress = null;
    return true;
  }

  /** Installs every selected pack: first those already uploaded, in one write, then the rest one by one. */
  async run(telegram: TelegramClient, signal: SignalConnection): Promise<void> {
    this.phase = 'running';
    this.#changed();
    const selected = this.entries.filter((entry) => entry.selected);
    const available = selected.filter((entry) => entry.state === 'available');
    if (available.length > 0) {
      for (const entry of available) entry.state = 'installing';
      this.#changed();
      try {
        await this.#install(signal, available);
        for (const entry of available) entry.state = 'in-signal';
      } catch (error) {
        for (const entry of available) Object.assign(entry, { state: 'failed', error: message(error) });
      }
      this.#changed();
    }

    const queue = selected.filter((entry) => entry.state === 'to-upload' || entry.state === 'claimed-elsewhere' || entry.state === 'failed');
    const recheckAt = new Map<PackEntry, number>();
    while (queue.length > 0) {
      const now = Date.now();
      const index = queue.findIndex((entry) => (recheckAt.get(entry) ?? 0) <= now);
      if (index < 0) {
        await sleep(Math.min(...queue.map((entry) => recheckAt.get(entry)!)) - now);
        continue;
      }
      const [entry] = queue.splice(index, 1);
      entry.error = null;
      try {
        if (!(await this.#migrateOne(telegram, signal, entry))) {
          entry.state = 'claimed-elsewhere';
          recheckAt.set(entry, Date.now() + CLAIM_RECHECK_MS);
          queue.push(entry);
        }
      } catch (error) {
        if (error instanceof RateLimitedError) {
          entry.state = 'to-upload';
          queue.unshift(entry);
          this.uploadAllowedAt = Date.now() + (error.retryAfterSeconds ?? 3600) * 1000;
          this.#changed();
          await sleep(this.uploadAllowedAt - Date.now());
          this.uploadAllowedAt = null;
        } else {
          Object.assign(entry, { state: 'failed', error: message(error), progress: null });
          if (!signal.isLinked) break;
        }
      }
      this.#changed();
    }
    this.phase = 'done';
    this.#changed();
  }
}
