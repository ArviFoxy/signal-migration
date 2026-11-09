// The scenario framework for sticker packs, on top of the shared core (../world.ts): Telegram sticker packs, the
// sticker pack index, packs on Signal's CDN, the phone's view of installed packs, and visits to the migration page.
//
// Everything below StickerMigration is the app's real code: pack identity, the index client with manifest
// verification, sticker encryption and upload, the storage client, and the ordering. Only the network, the clock
// and the browser-only sticker conversion are simulated.

import { create, fromBinary } from '@bufbuild/protobuf';
import { InstalledStickerPackRecordSchema, ManifestRecord_Identifier_Type } from '../../../src/gen/SignalStorage_pb';
import { StickerPackSchema } from '../../../src/gen/Stickers_pb';
import { ConversionError, type ConvertSticker } from '../../../src/kinds/stickers/convert';
import { packIdentity } from '../../../src/kinds/stickers/identity';
import { StickerMigration } from '../../../src/kinds/stickers/migration';
import { PackIndex } from '../../../src/kinds/stickers/pack-index';
import type { StickerFormat, TelegramPack, TelegramSource } from '../../../src/kinds/stickers/telegram-packs';
import { uploadStickerPack } from '../../../src/kinds/stickers/upload';
import type { StoredStickerPack } from '../../../src/signal/storage';
import type { ChatChannel } from '../../../src/signal/transport';
import { decryptStickerFile } from '../../../src/wasm/signal_migration_wasm';
import { PageClock, PageClosed } from '../clock';
import type { UploadLimit } from '../fake-signal';
import type { FakeTelegram } from '../fake-telegram';
import { storageRecord } from '../storage-builder';
import { type SimulatedAccount, type StorageOptions, User, World } from '../world';
import { FakeIndex } from './fake-index';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const signalOrder = (a: StoredStickerPack, b: StoredStickerPack) =>
  a.position - b.position || (hex(a.packId) < hex(b.packId) ? -1 : 1);
const startsWith = (bytes: Uint8Array, prefix: Uint8Array) => prefix.every((byte, i) => bytes[i] === byte);

export type StickerSpec = { uniqueId: string; emoji: string; format: StickerFormat; bytes: Uint8Array };
export type PackSpec = { title: string; stickers: StickerSpec[] };

/** Sticker files starting with these bytes fail to convert, like an animation that cannot fit Signal's limit. */
export const UNCONVERTIBLE = new TextEncoder().encode('UNCONVERTIBLE');

/**
 * Stands in for the browser-only conversion (checked in a browser separately): the image is the file itself, and
 * animations report a size and frame rate as the real conversion does.
 */
export const simulatedConvert: ConvertSticker = async (file, format) => {
  if (startsWith(file, UNCONVERTIBLE))
    throw new ConversionError('the animation does not fit in 300 KiB even at small size and frame rate');
  return {
    image: file.slice(),
    animation: format === 'webp' ? null : { size: 384, frameRate: 30, sourceFrameRate: format === 'tgs' ? 60 : null },
    reencoded: false,
  };
};

/** The user's installed Telegram sticker packs, with their files in the user's simulated Telegram account. */
class TelegramStickers implements TelegramSource {
  readonly #packs: TelegramPack[];
  readonly #fileTitles = new Map<number, string>();

  constructor(
    readonly files: FakeTelegram,
    specs: PackSpec[],
  ) {
    this.#packs = specs.map((spec, setIndex) => ({
      setId: String(setIndex + 1),
      title: spec.title,
      stickers: spec.stickers.map((sticker) => {
        const fileId = files.addFile(sticker.bytes);
        this.#fileTitles.set(fileId, spec.title);
        return {
          ...sticker,
          fileId,
          thumbnail: { fileId: files.addFile(sticker.bytes.slice(0, 8)), mimeType: 'image/webp' },
        };
      }),
    }));
  }

  async readPacks(onProgress: (done: number, total: number) => void): Promise<TelegramPack[]> {
    onProgress(this.#packs.length, this.#packs.length);
    return structuredClone(
      this.#packs.map(({ setId, title, stickers }) => ({
        setId,
        title,
        stickers: stickers.map(({ fileId, uniqueId, emoji, format, thumbnail }) => ({
          fileId,
          uniqueId,
          emoji,
          format,
          thumbnail,
        })),
      })),
    );
  }

  readFile(fileId: number): Promise<Uint8Array> {
    return this.files.readFile(fileId);
  }

  /** How many sticker files (not previews) of the pack `title` were read. */
  stickerReads(title: string): number {
    let reads = 0;
    for (const [fileId, read] of this.files.reads) if (this.#fileTitles.get(fileId) === title) reads += read;
    return reads;
  }

  /** The next read of any sticker file of the pack `title` fails. */
  failNextStickerRead(title: string): void {
    this.files.failNextRead(
      [...this.#fileTitles].filter(([, packTitle]) => packTitle === title).map(([fileId]) => fileId),
    );
  }
}

export type VisitOptions = {
  /** Which packs stay selected, by title; all by default. */
  select?: (title: string) => boolean;
  /** The user closes the page instead of waiting longer than this many milliseconds. */
  leaveAfterWaitOf?: number;
  /** Called on every change of the migration's state, for acting at a precise moment. */
  onChange?: (migration: StickerMigration, account: SimulatedAccount) => void;
};

/** One open migration page; its steps can be run one by one, or all in order with `StickerUser.visit`. */
export class StickerPage {
  readonly migration: StickerMigration;
  account: SimulatedAccount | null = null;
  left = false;

  constructor(
    readonly user: StickerUser,
    readonly options: VisitOptions,
  ) {
    const { world } = user;
    const index = new PackIndex(world.index.backend, world.signal.manifestSource, world.index.pageSize);
    this.migration = new StickerMigration({
      clock: new PageClock(world.clock, options.leaveAfterWaitOf ?? null),
      convert: simulatedConvert,
      index,
    });
    this.migration.addEventListener('change', () => {
      if (this.account) options.onChange?.(this.migration, this.account);
    });
  }

  /** Reads the packs, looks them up in the index, loads the previews and applies the selection. */
  async readTelegram(): Promise<void> {
    await this.migration.readTelegram(this.user.stickers);
    await this.migration.lookUpInIndex();
    await this.migration.loadPreviews(this.user.stickers);
    for (const entry of this.migration.entries) {
      if (this.options.select && !this.options.select(entry.pack.title)) this.migration.setSelected(entry, false);
    }
  }

  async download(): Promise<void> {
    await this.migration.download(this.user.stickers);
  }

  /** Links a new device and reads which packs the account has. */
  async linkSignal(): Promise<void> {
    this.account = this.user.linkDevice();
    await this.migration.readSignal(this.account);
  }

  async run(): Promise<void> {
    try {
      await this.migration.run(this.account!);
    } catch (error) {
      if (!(error instanceof PageClosed)) throw error;
      this.left = true;
    }
  }

  entry(title: string) {
    return this.migration.entries.find((entry) => entry.pack.title === title)!;
  }
}

export class StickerUser extends User {
  readonly stickers: TelegramStickers;

  constructor(
    override readonly world: StickerWorld,
    packs: PackSpec[],
    storage: StorageOptions,
  ) {
    super(world, storage);
    this.stickers = new TelegramStickers(this.telegram, packs);
  }

  /** Installed packs in the order Signal shows them. */
  async installedPacks(): Promise<StoredStickerPack[]> {
    return (await (await this.phone.storage()).readStickerPacks()).packs.sort(signalOrder);
  }

  /** The titles of the installed packs, in the order Signal shows them, read from each pack's manifest. */
  async installedTitles(): Promise<string[]> {
    return (await this.installedPacks()).map((pack) => this.world.readManifest(pack.packId, pack.packKey).title);
  }

  /** Installs a pack from the phone, at the end of the list as Signal does (largest position plus one). */
  async installOnPhone(pack: { packId: Uint8Array; packKey: Uint8Array }): Promise<void> {
    const storage = await this.phone.storage();
    const snapshot = await storage.readStickerPacks();
    const position = Math.max(-1, ...snapshot.packs.map((stored) => stored.position)) + 1;
    if (!(await storage.writeStickerPacks(snapshot, [{ ...pack, position }])))
      throw new Error('the phone write conflicted');
  }

  /** Uninstalls a pack from the phone, which leaves a record with its deletion time, as Signal does. */
  async uninstallOnPhone(packId: Uint8Array): Promise<void> {
    const snapshot = await (await this.phone.storage()).readStickerPacks();
    const stored = snapshot.packs.find((pack) => hex(pack.packId) === hex(packId))!;
    const removal = storageRecord(ManifestRecord_Identifier_Type.STICKER_PACK, {
      case: 'installedStickerPack',
      value: create(InstalledStickerPackRecordSchema, { packId, deletedAtTimestamp: 1n }),
    });
    await this.phone.writeRecords(snapshot.manifest, [stored.recordId], [removal]);
  }

  openPage(options: VisitOptions = {}): StickerPage {
    return new StickerPage(this, options);
  }

  /** A whole visit: Telegram, download, Signal, migration. */
  async visit(options: VisitOptions = {}): Promise<StickerPage> {
    const page = this.openPage(options);
    await page.readTelegram();
    await page.download();
    await page.linkSignal();
    await page.run();
    return page;
  }
}

export class StickerWorld extends World {
  readonly index: FakeIndex;
  #nextUniqueId = 1;
  /** An account outside the scenario's users, which publishes packs. */
  #publisher: ChatChannel | null = null;

  constructor(options: { uploadLimit?: UploadLimit; indexPageSize?: number } = {}) {
    super(options);
    this.index = new FakeIndex(this.clock, options.indexPageSize ?? 3);
  }

  /** A Telegram pack with `count` stickers of one format; `unconvertible` lists stickers that cannot be converted. */
  pack(title: string, count = 3, options: { format?: StickerFormat; unconvertible?: number[] } = {}): PackSpec {
    const format = options.format ?? 'webp';
    return {
      title,
      stickers: Array.from({ length: count }, (_, i) => {
        const uniqueId = `sticker-${this.#nextUniqueId++}`;
        const body = new TextEncoder().encode(`${format} image of ${title} #${i} (${uniqueId})`);
        const bytes = options.unconvertible?.includes(i) ? new Uint8Array([...UNCONVERTIBLE, ...body]) : body;
        return { uniqueId, emoji: ['😀', '😺', '🦊', '🐉'][i % 4], format, bytes };
      }),
    };
  }

  user(packs: PackSpec[], storage: StorageOptions = {}): StickerUser {
    return new StickerUser(this, packs, storage);
  }

  /** The decrypted manifest of a pack on the CDN. */
  readManifest(packId: Uint8Array, packKey: Uint8Array) {
    const manifest = this.signal.cdnFile(`stickers/${hex(packId)}/manifest.proto`);
    if (!manifest) throw new Error('no such pack on the CDN');
    return fromBinary(StickerPackSchema, decryptStickerFile(manifest, packKey));
  }

  /** The decrypted sticker files of a pack on the CDN. */
  readStickers(packId: Uint8Array, packKey: Uint8Array): Uint8Array[] {
    return this.readManifest(packId, packKey).stickers.map((sticker) =>
      decryptStickerFile(this.signal.cdnFile(`stickers/${hex(packId)}/full/${sticker.id}`)!, packKey),
    );
  }

  #publisherChat(): ChatChannel {
    this.#publisher ??= this.signal.chat(this.signal.createAccount(), 1);
    return this.#publisher;
  }

  /** A pack someone published on Signal directly, with a random key; it is in no index. */
  async publishSignalPack(title: string): Promise<{ packId: Uint8Array; packKey: Uint8Array }> {
    const packKey = crypto.getRandomValues(new Uint8Array(32));
    const stickers = [{ image: new TextEncoder().encode(`${title} sticker`), emoji: '⭐' }];
    const packId = await uploadStickerPack(
      this.#publisherChat(),
      { title, stickers },
      packKey,
      undefined,
      this.signal.https,
    );
    return { packId, packKey };
  }

  /** Another user migrating a Telegram pack: uploads it under its derived key and adds it to the index. */
  async migrateElsewhere(spec: PackSpec): Promise<Uint8Array> {
    const identity = await packIdentity(spec);
    const stickers = await Promise.all(
      spec.stickers.map(async (sticker) => ({
        image: (await simulatedConvert(sticker.bytes, sticker.format)).image,
        emoji: sticker.emoji,
      })),
    );
    const packId = await uploadStickerPack(
      this.#publisherChat(),
      { title: spec.title, stickers },
      identity.packKey,
      undefined,
      this.signal.https,
    );
    await this.index.backend.add(new Uint8Array([...identity.lookupKey, ...packId]));
    return packId;
  }
}
