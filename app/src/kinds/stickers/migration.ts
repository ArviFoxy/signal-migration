// The sticker pack migration, in the order of the wizard:
// 1. readTelegram: the user's installed packs in Telegram order. Then, while the user chooses packs,
//    lookUpInIndex finds which are already on Signal and loadPreviews loads up to four preview images per pack.
// 2. readSignal: which packs the Signal account already has.
// 3. run: installs the packs someone already uploaded, then takes the rest pack by pack: download from Telegram,
//    convert, upload to Signal, add to the index, install. Signal's upload limit sets the pace (50 at once, then one
//    every 72 minutes by default), so only the pack being uploaded and the next one are held in memory; the next is
//    downloaded and converted while waiting for the limit.
//
// Nothing is stored between visits. A later visit computes the same state from Telegram, the sticker pack index
// and the Signal account, so a migration that stopped (closed page, rate limit) continues where it was.
// The services it uses (clock, conversion, index) are passed in, so that tests can run it against simulations.

import type { Clock } from '../../core/clock';
import type { StoredStickerPack } from '../../signal/storage';
import type { SignalAccount } from '../../signal/transport';
import type { ConvertedSticker, ConvertSticker } from './convert';
import { DownloadStalledError } from '../../telegram/download';
import { contentPackKey, type PackIdentity, packIdentity } from './identity';
import { assignPositions, insertPacks } from './order';
import { type PackIndex, toHex } from './pack-index';
import type { TelegramPack, TelegramSource } from './telegram-packs';
import { MAX_STICKERS, RateLimitedError, type StickerFile, uploadStickerPack } from './upload';

export type PackState =
  /** Looking the pack up in the index. */
  | 'checking'
  /** Installed in the user's Signal. */
  | 'in-signal'
  /**
   * Someone already uploaded it; it only needs installing. Unless its key is known already (`packKey`), its
   * stickers are downloaded first to compute the key and check the upload.
   */
  | 'available'
  | 'to-upload'
  | 'downloading'
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
  /**
   * The pack's key in Signal, once known: from the account's storage when installed, or computed from the
   * downloaded stickers (identity.ts contentPackKey).
   */
  packKey: Uint8Array | null;
  /** Up to four preview images for the pack list. */
  thumbnails: { data: Uint8Array; mimeType: string }[];
  /** Whether the pack's stickers are downloaded and converted, ready to upload. */
  prepared: boolean;
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
/** How many installed packs are told to the other devices in one go, during the migration. */
const ANNOUNCE_BATCH = 10;
export const UPLOAD_INTERVAL_MS = 72 * 60_000;

const THUMBNAILS_PER_PACK = 4;
const CONCURRENT_VERIFICATIONS = 6;
const CONCURRENT_DOWNLOADS = 4;
const CONCURRENT_CONVERSIONS = 2;
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

/**
 * `work`, or an AbortError as soon as `cancel` fires. The work itself is not stopped: a request already sent finishes
 * on its own, and its result is no longer awaited.
 */
function untilCancelled<T>(work: Promise<T>, cancel: AbortSignal): Promise<T> {
  if (cancel.aborted) return Promise.reject(cancel.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancel.reason);
    cancel.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => cancel.removeEventListener('abort', onAbort));
  });
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
  phase: RunPhase = 'idle';
  /** Every pack was looked up in the index (lookUpInIndex finished). */
  lookedUp = false;
  /** The Signal account whose installed packs were last read (readSignal). */
  signalReadFrom: SignalAccount | null = null;
  stopReason: string | null = null;
  /** While waiting for Signal's upload limit: when the next upload is allowed (ms since the epoch). */
  uploadAllowedAt: number | null = null;
  /**
   * The time between uploads under Signal's limit: the wait Signal reported when the limit was first reached, when
   * the allowance had just run out; Signal-Server's default until then.
   */
  uploadIntervalMs = UPLOAD_INTERVAL_MS;
  #limitReached = false;
  /** Why telling the account's other devices about installed packs failed, until it works. */
  announceError: string | null = null;
  /** Installed packs that the account's other devices were not told about yet. */
  #unannounced = new Set<PackEntry>();
  /** Packs uploaded, packs added to the index and packs installed during this visit. */
  uploaded = 0;
  addedToIndex = 0;
  installed = 0;
  #services: MigrationServices;
  #converted = new Map<PackEntry, StickerFile[]>();
  /** Downloaded sticker files, waiting to be converted. */
  #originals = new Map<PackEntry, Uint8Array[]>();
  #lookup: Promise<void> | null = null;
  #previewsStopped = false;
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

  /** Packs to install that someone already uploaded: how many are in Signal now, of how many. */
  get installProgress(): { done: number; total: number } {
    const planned = [...this.#plannedInstalls];
    return { done: planned.filter((entry) => entry.state === 'in-signal').length, total: planned.length };
  }

  /** Packs to upload, in the order they are uploaded. */
  /** Whether the pack was on Signal already when the migration started (installed, not uploaded). */
  wasOnSignal(entry: PackEntry): boolean {
    return this.#plannedInstalls.has(entry);
  }

  /** The pack the migration is working on or waiting with: the first selected one not yet in Signal or failed. */
  get current(): PackEntry | null {
    return this.selected.find((entry) => entry.state !== 'in-signal' && entry.state !== 'failed') ?? null;
  }

  get uploadQueue(): PackEntry[] {
    return [...this.#plannedUploads];
  }

  get uploadProgress(): { done: number; total: number } {
    const planned = this.uploadQueue;
    return { done: planned.filter((entry) => entry.state === 'in-signal').length, total: planned.length };
  }

  /** Reads the list of installed Telegram packs. Their states stay "checking" until lookUpInIndex. */
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
        packKey: null,
        thumbnails: [],
        prepared: false,
        progress: null,
        conversion: null,
        error: null,
      })),
    );
    this.#changed();
  }

  /** Looks every pack up in the index: "available" when someone uploaded it, "to-upload" otherwise. Runs once. */
  lookUpInIndex(): Promise<void> {
    this.#lookup ??= (async () => {
      await this.#services.index.refresh();
      await forEachConcurrently(this.entries, CONCURRENT_VERIFICATIONS, async (entry) => {
        entry.state = this.#services.index.candidates(entry.identity.lookupKey).length > 0 ? 'available' : 'to-upload';
        this.#changed();
      });
      this.lookedUp = true;
      this.#changed();
    })();
    this.#lookup.catch(() => (this.#lookup = null));
    return this.#lookup;
  }

  /**
   * Loads up to four preview images per pack, in Telegram order, until stopPreviews. A preview that fails to load is
   * left out; the pack shows placeholders instead.
   */
  async loadPreviews(telegram: TelegramSource): Promise<void> {
    await forEachConcurrently(this.entries, CONCURRENT_DOWNLOADS, async (entry) => {
      if (this.#previewsStopped || entry.thumbnails.length > 0) return;
      const previews = entry.pack.stickers
        .flatMap((sticker) => (sticker.thumbnail ? [sticker.thumbnail] : []))
        .slice(0, THUMBNAILS_PER_PACK);
      try {
        entry.thumbnails = await Promise.all(
          previews.map(async (thumbnail) => ({
            data: await telegram.readFile(thumbnail.fileId),
            mimeType: thumbnail.mimeType,
          })),
        );
      } catch {
        entry.thumbnails = [];
      }
      this.#changed();
    });
  }

  /** Stops loading previews; the ones not yet loaded are not needed after the user has chosen. */
  stopPreviews(): void {
    this.#previewsStopped = true;
  }

  /**
   * Marks the packs the Signal account already has installed: an installed pack that the index lists for a Telegram
   * pack, and whose manifest, decrypted with the key in the account, has that pack's title and its stickers' emoji
   * in order. Anyone can add an index entry, so the entry alone does not show that the installed pack is this one.
   */
  async readSignal(signal: SignalAccount): Promise<void> {
    const { packs } = await (await signal.storage()).readStickerPacks();
    const { index } = this.#services;
    await forEachConcurrently(this.entries, CONCURRENT_VERIFICATIONS, async (entry) => {
      const candidates = new Set(index.candidates(entry.identity.lookupKey).map(toHex));
      for (const stored of packs.filter((pack) => candidates.has(toHex(pack.packId)))) {
        const manifest = await index.manifest(stored.packId, stored.packKey);
        const stickers = entry.pack.stickers;
        if (
          manifest?.title === entry.pack.title &&
          manifest.stickers.length === stickers.length &&
          manifest.stickers.every((sticker, i) => sticker.emoji === stickers[i].emoji)
        ) {
          Object.assign(entry, { state: 'in-signal', packId: stored.packId, packKey: stored.packKey, error: null });
          return;
        }
      }
    });
    this.signalReadFrom = signal;
    this.#changed();
  }

  setSelected(entry: PackEntry, selected: boolean): void {
    entry.selected = selected && entry.pack.stickers.length <= MAX_STICKERS;
    this.#changed();
  }

  /** How many installed packs the account's other devices were not told about yet. */
  get unannounced(): number {
    return this.#unannounced.size;
  }

  /**
   * Tells the account's other devices about installed packs (SignalAccount.announceStickerPacks), so that they
   * show them. Packs are told in batches, to stay within Signal's rate limit for messages: `force` sends whatever
   * is waiting, otherwise a batch goes once it holds ANNOUNCE_BATCH packs. A failure keeps the packs waiting.
   */
  async #announce(signal: SignalAccount, installed: PackEntry[], force: boolean): Promise<void> {
    for (const entry of installed) if (entry.packId) this.#unannounced.add(entry);
    if (this.#unannounced.size === 0 || (!force && this.#unannounced.size < ANNOUNCE_BATCH)) return;
    const batch = [...this.#unannounced];
    try {
      await signal.announceStickerPacks(batch.map((entry) => ({ packId: entry.packId!, packKey: entry.packKey! })));
      for (const entry of batch) this.#unannounced.delete(entry);
      this.announceError = null;
    } catch (error) {
      this.announceError = message(error);
    }
    this.#changed();
  }

  /** Puts the packs that failed back in line, for the next run. */
  retryFailed(): void {
    this.announceError = null;
    for (const entry of this.selected)
      if (entry.state === 'failed') Object.assign(entry, { state: 'to-upload', error: null, progress: null });
    this.#changed();
  }

  /**
   * Installs packs into the Signal account's storage service, each at its place in the order (order.ts). Other
   * devices can change the storage meanwhile; the write then fails with a conflict and is computed again.
   * A record left by uninstalling the same pack earlier is replaced rather than kept beside the new one.
   */
  async #install(signal: SignalAccount, adding: PackEntry[]): Promise<void> {
    const rankByKey = new Map(
      this.entries.flatMap((entry) => (entry.packKey ? [[toHex(entry.packKey), entry.rank] as const] : [])),
    );
    for (let attempt = 0; attempt < STORAGE_WRITE_ATTEMPTS; attempt++) {
      const storage = await signal.storage();
      const snapshot = await storage.readStickerPacks();
      const installed = new Set(snapshot.packs.map((stored) => toHex(stored.packKey)));
      const missing = adding.filter((entry) => !installed.has(toHex(entry.packKey!)));
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
          return [{ packId, packKey: placed.entry.packKey!, position: positions[i], replaces: removed?.recordId }];
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

  /**
   * Downloads a pack's stickers from Telegram and computes its pack key from them. The files wait in memory for
   * the conversion.
   */
  async #download(telegram: TelegramSource, entry: PackEntry): Promise<void> {
    if (this.#originals.has(entry) || this.#converted.has(entry)) return;
    const stickers = entry.pack.stickers;
    let done = 0;
    Object.assign(entry, { state: 'downloading', progress: { done, total: stickers.length } });
    this.#changed();
    const files: Uint8Array[] = new Array(stickers.length);
    try {
      await forEachConcurrently(
        stickers.map((_, i) => i),
        CONCURRENT_DOWNLOADS,
        async (i) => {
          files[i] = await telegram.readFile(stickers[i].fileId).catch((error: unknown) => {
            if (!(error instanceof DownloadStalledError)) throw error;
            throw new Error(`sticker ${i + 1}: ${error.message}`, { cause: error });
          });
          entry.progress = { done: ++done, total: stickers.length };
          this.#changed();
        },
      );
    } catch (error) {
      if ((error as Error).cause instanceof DownloadStalledError) throw error;
      throw new Error(`downloading from Telegram failed: ${message(error)}`);
    }
    entry.packKey = await contentPackKey({
      title: entry.pack.title,
      stickers: files.map((file, i) => ({ file, emoji: stickers[i].emoji })),
    });
    this.#originals.set(entry, files);
  }

  /** Downloads a pack's stickers and converts them; the result waits in memory for the upload. */
  async #prepare(telegram: TelegramSource, entry: PackEntry): Promise<void> {
    if (this.#converted.has(entry)) return;
    await this.#download(telegram, entry);
    const stickers = entry.pack.stickers;
    const step = async <T>(
      state: PackState,
      work: (index: number) => Promise<T>,
      concurrency: number,
    ): Promise<T[]> => {
      const results: T[] = new Array(stickers.length);
      let done = 0;
      Object.assign(entry, { state, progress: { done, total: stickers.length } });
      this.#changed();
      await forEachConcurrently(
        stickers.map((_, i) => i),
        concurrency,
        async (i) => {
          results[i] = await work(i);
          entry.progress = { done: ++done, total: stickers.length };
          this.#changed();
        },
      );
      return results;
    };
    const files = this.#originals.get(entry)!;
    const converted = await step(
      'converting',
      (i) =>
        this.#services.convert(files[i], stickers[i].format).catch((error: unknown) => {
          throw new Error(`sticker ${i + 1} (${stickers[i].format}): ${message(error)}`);
        }),
      CONCURRENT_CONVERSIONS,
    );
    entry.conversion = summarize(converted);
    this.#originals.delete(entry);
    this.#converted.set(
      entry,
      converted.map((sticker, i) => ({ image: sticker.image, emoji: stickers[i].emoji })),
    );
    Object.assign(entry, { prepared: true, progress: null });
    this.#changed();
  }

  /** Someone may have uploaded the pack since the index was last read: the pack ID of their upload, or null. */
  async #uploadedMeanwhile(entry: PackEntry): Promise<Uint8Array | null> {
    await this.#services.index.refresh();
    return this.#services.index.find(entry.identity.lookupKey, entry.packKey!);
  }

  /**
   * Migrates one pack that is not installed. The index is asked again right before the upload, so that a pack
   * someone uploaded meanwhile is installed instead of uploaded twice.
   */
  async #migrateOne(signal: SignalAccount, telegram: TelegramSource, entry: PackEntry): Promise<void> {
    entry.state = 'checking';
    this.#changed();
    // The pack key comes from the stickers themselves, so they are downloaded before the index is asked.
    await this.#download(telegram, entry);
    entry.packId = await this.#uploadedMeanwhile(entry);
    if (!entry.packId) {
      this.#plannedInstalls.delete(entry);
      this.#plannedUploads.add(entry);
      await this.#prepare(telegram, entry);
      entry.state = 'checking';
      this.#changed();
      entry.packId = await this.#uploadedMeanwhile(entry);
    }
    if (!entry.packId) {
      entry.state = 'uploading';
      this.#changed();
      const content = { title: entry.pack.title, stickers: this.#converted.get(entry)! };
      entry.packId = await signal.withChat((chat) =>
        uploadStickerPack(
          chat,
          content,
          entry.packKey!,
          (done, total) => {
            entry.progress = { done, total };
            this.#changed();
          },
          signal.https,
        ),
      );
      this.uploaded++;
      await this.#addToIndex(entry);
    } else if (this.#plannedUploads.delete(entry)) {
      // Uploaded by someone else while this page converted it: an install after all.
      this.#plannedInstalls.add(entry);
    }
    this.#converted.delete(entry);
    this.#originals.delete(entry);
    entry.state = 'installing';
    this.#changed();
    await this.#install(signal, [entry]);
    Object.assign(entry, { state: 'in-signal', progress: null, error: null });
  }

  /**
   * Installs every selected pack: first those already uploaded, in one write, then the rest pack by pack, reading
   * their stickers from `telegram`.
   */
  async run(
    signal: SignalAccount,
    telegram: TelegramSource,
    cancel: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const { clock } = this.#services;
    Object.assign(this, { phase: 'running', stopReason: null });
    this.#changed();
    // Packs installed before this run (an earlier visit, or by the user) may not have reached the other devices.
    await this.#announce(
      signal,
      this.selected.filter((entry) => entry.state === 'in-signal'),
      false,
    );
    // Packs already on Signal whose key is known are installed at once; the others need their stickers first.
    for (const entry of this.selected) if (entry.state === 'available') this.#plannedInstalls.add(entry);
    const available = this.selected.filter((entry) => entry.state === 'available' && entry.packKey);
    if (available.length > 0) {
      for (const entry of available) entry.state = 'installing';
      this.#changed();
      try {
        await this.#install(signal, available);
        for (const entry of available) entry.state = 'in-signal';
        await this.#announce(signal, available, true);
      } catch (error) {
        for (const entry of available) Object.assign(entry, { state: 'failed', error: message(error) });
      }
      this.#changed();
    }

    // Packs on Signal whose key needs their stickers come first: installing them never waits for the upload limit.
    const queue = this.selected
      .filter((entry) => entry.state === 'available' || entry.state === 'to-upload' || entry.state === 'failed')
      .sort((a, b) => Number(b.state === 'available') - Number(a.state === 'available'));
    for (const entry of queue) if (!this.#plannedInstalls.has(entry)) this.#plannedUploads.add(entry);
    this.#changed();
    while (queue.length > 0) {
      cancel.throwIfAborted();
      if (!signal.isLinked) break;
      const entry = queue.shift()!;
      entry.error = null;
      try {
        await untilCancelled(this.#migrateOne(signal, telegram, entry), cancel);
        await this.#announce(signal, [entry], false);
      } catch (error) {
        // A cancelled run leaves the pack as it was; the next run takes it up again.
        if (cancel.aborted) throw error;
        if (error instanceof RateLimitedError) {
          entry.state = 'to-upload';
          queue.unshift(entry);
          const waitMs = (error.retryAfterSeconds ?? UPLOAD_INTERVAL_MS / 1000) * 1000;
          if (!this.#limitReached) this.uploadIntervalMs = waitMs;
          this.#limitReached = true;
          // The packs installed so far reach the phone before the wait.
          await this.#announce(signal, [], true);
          this.uploadAllowedAt = clock.now() + waitMs;
          this.#changed();
          // While waiting, the next pack is downloaded and converted. If that fails, it is tried again in its turn.
          const next = queue.find((other) => other !== entry && other.state === 'to-upload' && !other.prepared);
          await untilCancelled(
            Promise.all([
              clock.sleep(this.uploadAllowedAt - clock.now()),
              next &&
                this.#prepare(telegram, next).then(
                  () => {
                    next.state = 'to-upload';
                    this.#changed();
                  },
                  () => {
                    Object.assign(next, { state: 'to-upload', progress: null });
                    this.#changed();
                  },
                ),
            ]),
            cancel,
          );
          this.uploadAllowedAt = null;
        } else {
          Object.assign(entry, { state: 'failed', error: message(error), progress: null });
        }
      }
      this.#changed();
    }
    if (signal.isLinked) await this.#announce(signal, [], true);
    if (!signal.isLinked)
      Object.assign(this, { phase: 'stopped', stopReason: 'Signal was unlinked before the migration finished' });
    else this.phase = 'done';
    this.#changed();
  }
}
