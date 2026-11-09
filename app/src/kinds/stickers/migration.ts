// The sticker pack migration, in the order of the wizard:
// 1. readTelegram: the user's installed packs in Telegram order, each looked up in the sticker pack index.
// 2. download: preview images of every pack, and the sticker files of each pack that needs uploading. After this
//    the app logs out of Telegram, so the files are kept in memory until they are uploaded.
// 3. readSignal: which packs the Signal account already has.
// 4. run: installs the packs someone already uploaded, then uploads and installs the rest one by one, within
//    Signal's upload limit.
//
// Nothing is stored between visits. A later visit computes the same state from Telegram, the sticker pack index
// and the Signal account, so a migration that stopped (closed page, rate limit) continues where it was.
// The services it uses (clock, conversion, index) are passed in, so that tests can run it against simulations.

import type { Clock } from '../../core/clock';
import type { StoredStickerPack } from '../../signal/storage';
import type { SignalAccount } from '../../signal/transport';
import type { ConvertedSticker, ConvertSticker } from './convert';
import { type PackIdentity, packIdentity } from './identity';
import { assignPositions, insertPacks } from './order';
import { type PackIndex, toHex } from './pack-index';
import type { TelegramPack, TelegramSource } from './telegram-packs';
import { MAX_STICKERS, RateLimitedError, type StickerFile, uploadStickerPack } from './upload';

export type PackState =
  /** Looking the pack up in the index. */
  | 'checking'
  /** Installed in the user's Signal. */
  | 'in-signal'
  /** Someone already uploaded it; it only needs installing. */
  | 'available'
  | 'to-upload'
  /** Someone else is uploading it right now; looked at again later. */
  | 'claimed-elsewhere'
  | 'converting'
  | 'uploading'
  | 'installing'
  | 'failed';

/** How converting a pack changed its stickers, for showing what was reduced to fit Signal's limits. */
export type ConversionSummary = {
  animated: number;
  smallestSize: number | null;
  lowestFrameRate: number | null;
  highestSourceFrameRate: number | null;
  reencoded: number;
};

export type PackEntry = {
  pack: TelegramPack;
  /** The pack's place in the user's Telegram order. */
  rank: number;
  identity: PackIdentity;
  selected: boolean;
  state: PackState;
  packId: Uint8Array | null;
  /** Up to four preview images for the pack list. */
  thumbnails: { data: Uint8Array; mimeType: string }[];
  /** Whether the pack's sticker files are in memory; only packs to upload need them. */
  downloaded: boolean;
  progress: { done: number; total: number } | null;
  conversion: ConversionSummary | null;
  error: string | null;
};

export type RunPhase = 'idle' | 'running' | 'done' | 'stopped';

/** The services the migration uses besides Telegram and Signal. */
export type MigrationServices = { clock: Clock; convert: ConvertSticker; index: PackIndex };

/**
 * Signal-Server's default limit on sticker pack uploads per account (RateLimiters.java): 50 at once, then one every
 * 72 minutes. Used only for estimates; the actual waits follow the Retry-After that Signal's server answers with.
 */
export const UPLOAD_BURST = 50;
export const UPLOAD_INTERVAL_MS = 72 * 60_000;

const THUMBNAILS_PER_PACK = 4;
const CONCURRENT_VERIFICATIONS = 6;
const CONCURRENT_DOWNLOADS = 4;
const CONCURRENT_CONVERSIONS = 2;
/** How long to wait before looking again at a pack someone else claimed. */
const CLAIM_RECHECK_MS = 2 * 60_000;
/** How long to wait when the index server limits this address. */
const INDEX_BUSY_WAIT_MS = 60_000;
const INDEX_ATTEMPTS = 10;
const STORAGE_WRITE_ATTEMPTS = 5;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

function summarize(converted: ConvertedSticker[]): ConversionSummary {
  const animations = converted.flatMap((sticker) => (sticker.animation ? [sticker.animation] : []));
  const minimum = (values: number[]) => (values.length > 0 ? Math.min(...values) : null);
  const sourceRates = animations.flatMap((animation) =>
    animation.sourceFrameRate === null ? [] : [animation.sourceFrameRate],
  );
  return {
    animated: animations.length,
    smallestSize: minimum(animations.map((animation) => animation.size)),
    lowestFrameRate: minimum(animations.map((animation) => animation.frameRate)),
    highestSourceFrameRate: sourceRates.length > 0 ? Math.max(...sourceRates) : null,
    reencoded: converted.filter((sticker) => sticker.reencoded).length,
  };
}

/** The estimated wait for `uploads` pack uploads under Signal's default limit, from a full allowance. */
export function estimatedUploadWaitMs(uploads: number): number {
  return Math.max(0, uploads - UPLOAD_BURST) * UPLOAD_INTERVAL_MS;
}

class IndexUnavailableError extends Error {
  constructor() {
    super('the sticker pack index kept limiting requests from this address; try again later');
  }
}

export class StickerMigration extends EventTarget {
  entries: PackEntry[] = [];
  readProgress: { done: number; total: number } | null = null;
  downloadProgress: { done: number; total: number } | null = null;
  phase: RunPhase = 'idle';
  stopReason: string | null = null;
  /** While waiting for Signal's upload limit: when the next upload is allowed (ms since the epoch). */
  uploadAllowedAt: number | null = null;
  /**
   * The time between uploads under Signal's limit: the wait Signal reported when the limit was first reached, when
   * the allowance had just run out; Signal-Server's default until then.
   */
  uploadIntervalMs = UPLOAD_INTERVAL_MS;
  #limitReached = false;
  /** Packs uploaded, packs added to the index and packs installed during this visit. */
  uploaded = 0;
  addedToIndex = 0;
  installed = 0;
  #services: MigrationServices;
  #files = new Map<PackEntry, Uint8Array[]>();
  #converted = new Map<PackEntry, StickerFile[]>();
  #paused = false;
  #resume: (() => void) | null = null;
  /** The packs each run set out to install from the index, and to upload; for progress across runs of a visit. */
  #plannedInstalls = new Set<PackEntry>();
  #plannedUploads = new Set<PackEntry>();

  constructor(services: MigrationServices) {
    super();
    this.#services = services;
  }

  #changed(): void {
    this.dispatchEvent(new Event('change'));
  }

  get selected(): PackEntry[] {
    return this.entries.filter((entry) => entry.selected);
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Packs to install that someone already uploaded: how many are in Signal now, of how many. */
  get installProgress(): { done: number; total: number } {
    const planned = [...this.#plannedInstalls];
    return { done: planned.filter((entry) => entry.state === 'in-signal').length, total: planned.length };
  }

  /** Packs to upload, in the order they are uploaded. */
  get uploadQueue(): PackEntry[] {
    return [...this.#plannedUploads];
  }

  get uploadProgress(): { done: number; total: number } {
    const planned = this.uploadQueue;
    return { done: planned.filter((entry) => entry.state === 'in-signal').length, total: planned.length };
  }

  /** Reads the installed Telegram packs and looks each one up in the index. */
  async readTelegram(telegram: TelegramSource): Promise<void> {
    const packs = await telegram.readPacks((done, total) => {
      this.readProgress = { done, total };
      this.#changed();
    });
    this.entries = await Promise.all(
      packs.map(async (pack, rank) => ({
        pack,
        rank,
        identity: await packIdentity({
          title: pack.title,
          stickers: pack.stickers.map(({ uniqueId, emoji }) => ({ uniqueId, emoji })),
        }),
        selected: pack.stickers.length > 0 && pack.stickers.length <= MAX_STICKERS,
        state: 'checking' as PackState,
        packId: null,
        thumbnails: [],
        downloaded: false,
        progress: null,
        conversion: null,
        error: null,
      })),
    );
    this.#changed();
    await this.#services.index.refresh();
    await forEachConcurrently(this.entries, CONCURRENT_VERIFICATIONS, async (entry) => {
      entry.packId = await this.#services.index.find(entry.identity.lookupKey, entry.identity.packKey);
      entry.state = entry.packId ? 'available' : 'to-upload';
      this.#changed();
    });
  }

  /** Downloads every pack's previews and the sticker files of each pack to upload. A failed pack is marked failed. */
  async download(telegram: TelegramSource): Promise<void> {
    const pending = this.entries.filter(
      (entry) =>
        entry.thumbnails.length === 0 ||
        (entry.state === 'to-upload' && !entry.downloaded) ||
        (entry.state === 'failed' && !entry.downloaded),
    );
    let done = 0;
    this.downloadProgress = { done, total: pending.length };
    this.#changed();
    await forEachConcurrently(pending, CONCURRENT_DOWNLOADS, async (entry) => {
      try {
        if (entry.thumbnails.length === 0) {
          const previews = entry.pack.stickers
            .flatMap((sticker) => (sticker.thumbnail ? [sticker.thumbnail] : []))
            .slice(0, THUMBNAILS_PER_PACK);
          entry.thumbnails = await Promise.all(
            previews.map(async (thumbnail) => ({
              data: await telegram.readFile(thumbnail.fileId),
              mimeType: thumbnail.mimeType,
            })),
          );
        }
        if (entry.state === 'to-upload' || entry.state === 'failed') {
          const files: Uint8Array[] = [];
          for (const sticker of entry.pack.stickers) files.push(await telegram.readFile(sticker.fileId));
          this.#files.set(entry, files);
          entry.downloaded = true;
          if (entry.state === 'failed') Object.assign(entry, { state: 'to-upload', error: null });
        }
      } catch (error) {
        Object.assign(entry, { state: 'failed', error: `downloading from Telegram failed: ${message(error)}` });
      }
      this.downloadProgress = { done: ++done, total: pending.length };
      this.#changed();
    });
  }

  /** Marks the packs the Signal account already has installed. */
  async readSignal(signal: SignalAccount): Promise<void> {
    const { packs } = await (await signal.storage()).readStickerPacks();
    for (const entry of this.entries) {
      const installed = packs.find((stored) => sameBytes(stored.packKey, entry.identity.packKey));
      if (installed) Object.assign(entry, { state: 'in-signal', packId: installed.packId, error: null });
    }
    this.#changed();
  }

  setSelected(entry: PackEntry, selected: boolean): void {
    entry.selected = selected && entry.pack.stickers.length <= MAX_STICKERS;
    this.#changed();
  }

  pause(): void {
    this.#paused = true;
    this.#changed();
  }

  resume(): void {
    this.#paused = false;
    this.#resume?.();
    this.#resume = null;
    this.#changed();
  }

  /**
   * Installs packs into the Signal account's storage service, each at its place in the order (order.ts). Other
   * devices can change the storage meanwhile; the write then fails with a conflict and is computed again.
   * A record left by uninstalling the same pack earlier is replaced rather than kept beside the new one.
   */
  async #install(signal: SignalAccount, adding: PackEntry[]): Promise<void> {
    const rankByKey = new Map(this.entries.map((entry) => [toHex(entry.identity.packKey), entry.rank]));
    for (let attempt = 0; attempt < STORAGE_WRITE_ATTEMPTS; attempt++) {
      const storage = await signal.storage();
      const snapshot = await storage.readStickerPacks();
      const installed = new Set(snapshot.packs.map((stored) => toHex(stored.packKey)));
      const missing = adding.filter((entry) => !installed.has(toHex(entry.identity.packKey)));
      if (missing.length === 0) return;
      type Placed = { stored: StoredStickerPack } | { entry: PackEntry };
      const existing = [...snapshot.packs]
        .sort(signalOrder)
        .map((stored) => ({ item: { stored } as Placed, rank: rankByKey.get(toHex(stored.packKey)) ?? null }));
      const order = insertPacks(
        existing,
        missing.map((entry) => ({ item: { entry } as Placed, rank: entry.rank })),
      );
      const positions = assignPositions(order.map((placed) => ('stored' in placed ? placed.stored.position : null)));
      const writes = order.flatMap((placed, i) => {
        if ('entry' in placed) {
          const packId = placed.entry.packId!;
          const removed = snapshot.removed.find((record) => sameBytes(record.packId, packId));
          return [
            { packId, packKey: placed.entry.identity.packKey, position: positions[i], replaces: removed?.recordId },
          ];
        }
        const { stored } = placed;
        return stored.position === positions[i]
          ? []
          : [{ packId: stored.packId, packKey: stored.packKey, position: positions[i], replaces: stored.recordId }];
      });
      if (await storage.writeStickerPacks(snapshot, writes)) {
        this.installed += missing.length;
        return;
      }
    }
    throw new Error('the Signal account kept changing while installing packs; try again');
  }

  /** Claims the pack; false when someone else holds the claim. Waits while the index server limits requests. */
  async #claim(entry: PackEntry): Promise<boolean> {
    for (let attempt = 0; attempt < INDEX_ATTEMPTS; attempt++) {
      const result = await this.#services.index.claim(entry.identity.lookupKey);
      if (result !== 'busy') return result === 'granted';
      await this.#services.clock.sleep(INDEX_BUSY_WAIT_MS);
    }
    throw new IndexUnavailableError();
  }

  async #addToIndex(entry: PackEntry): Promise<void> {
    for (let attempt = 0; attempt < INDEX_ATTEMPTS; attempt++) {
      if ((await this.#services.index.add(entry.identity.lookupKey, entry.packId!)) === 'added') {
        this.addedToIndex++;
        return;
      }
      await this.#services.clock.sleep(INDEX_BUSY_WAIT_MS);
    }
    throw new IndexUnavailableError();
  }

  async #convert(entry: PackEntry): Promise<StickerFile[]> {
    const files = this.#files.get(entry);
    if (!files) throw new Error('the sticker files were not downloaded from Telegram; start again to download them');
    const stickers = entry.pack.stickers;
    const converted: ConvertedSticker[] = new Array(stickers.length);
    let done = 0;
    entry.progress = { done, total: stickers.length };
    await forEachConcurrently(
      stickers.map((sticker, i) => ({ sticker, i })),
      CONCURRENT_CONVERSIONS,
      async ({ sticker, i }) => {
        converted[i] = await this.#services.convert(files[i], sticker.format);
        entry.progress = { done: ++done, total: stickers.length };
        this.#changed();
      },
    );
    entry.conversion = summarize(converted);
    return converted.map((sticker, i) => ({ image: sticker.image, emoji: stickers[i].emoji }));
  }

  /** Migrates one pack that is not installed. Returns false when someone else holds its claim. */
  async #migrateOne(signal: SignalAccount, entry: PackEntry): Promise<boolean> {
    const { lookupKey, packKey } = entry.identity;
    // Someone may have uploaded the pack since the index was read.
    entry.state = 'checking';
    this.#changed();
    await this.#services.index.refresh();
    entry.packId = await this.#services.index.find(lookupKey, packKey);
    if (!entry.packId) {
      if (!(await this.#claim(entry))) return false;
      if (!this.#converted.has(entry)) {
        entry.state = 'converting';
        this.#changed();
        this.#converted.set(entry, await this.#convert(entry));
      }
      entry.state = 'uploading';
      this.#changed();
      const content = { title: entry.pack.title, stickers: this.#converted.get(entry)! };
      entry.packId = await signal.withChat((chat) =>
        uploadStickerPack(
          chat,
          content,
          packKey,
          (done, total) => {
            entry.progress = { done, total };
            this.#changed();
          },
          signal.https,
        ),
      );
      this.uploaded++;
      this.#converted.delete(entry);
      this.#files.delete(entry);
      await this.#addToIndex(entry);
    }
    entry.state = 'installing';
    this.#changed();
    await this.#install(signal, [entry]);
    Object.assign(entry, { state: 'in-signal', progress: null, error: null });
    return true;
  }

  async #waitWhilePaused(): Promise<void> {
    while (this.#paused) await new Promise<void>((resolve) => (this.#resume = resolve));
  }

  /** Installs every selected pack: first those already uploaded, in one write, then the rest one by one. */
  async run(signal: SignalAccount): Promise<void> {
    const { clock } = this.#services;
    Object.assign(this, { phase: 'running', stopReason: null });
    this.#changed();
    const available = this.selected.filter((entry) => entry.state === 'available');
    for (const entry of available) this.#plannedInstalls.add(entry);
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

    const queue = this.selected.filter(
      (entry) => entry.state === 'to-upload' || entry.state === 'claimed-elsewhere' || entry.state === 'failed',
    );
    for (const entry of queue) if (!this.#plannedInstalls.has(entry)) this.#plannedUploads.add(entry);
    this.#changed();
    const recheckAt = new Map<PackEntry, number>();
    while (queue.length > 0) {
      await this.#waitWhilePaused();
      if (!signal.isLinked) break;
      const index = queue.findIndex((entry) => (recheckAt.get(entry) ?? 0) <= clock.now());
      if (index < 0) {
        await clock.sleep(Math.min(...queue.map((entry) => recheckAt.get(entry)!)) - clock.now());
        continue;
      }
      const [entry] = queue.splice(index, 1);
      entry.error = null;
      try {
        if (!(await this.#migrateOne(signal, entry))) {
          entry.state = 'claimed-elsewhere';
          recheckAt.set(entry, clock.now() + CLAIM_RECHECK_MS);
          queue.push(entry);
        }
      } catch (error) {
        if (error instanceof RateLimitedError) {
          entry.state = 'to-upload';
          queue.unshift(entry);
          const waitMs = (error.retryAfterSeconds ?? UPLOAD_INTERVAL_MS / 1000) * 1000;
          if (!this.#limitReached) this.uploadIntervalMs = waitMs;
          this.#limitReached = true;
          this.uploadAllowedAt = clock.now() + waitMs;
          this.#changed();
          await clock.sleep(this.uploadAllowedAt - clock.now());
          this.uploadAllowedAt = null;
        } else {
          Object.assign(entry, { state: 'failed', error: message(error), progress: null });
        }
      }
      this.#changed();
    }
    if (!signal.isLinked)
      Object.assign(this, { phase: 'stopped', stopReason: 'Signal was unlinked before the migration finished' });
    else this.phase = 'done';
    this.#changed();
  }
}
