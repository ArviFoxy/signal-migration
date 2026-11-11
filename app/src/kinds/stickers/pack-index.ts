// The sticker pack index on our server: which Telegram packs someone has already uploaded to Signal, and under
// which Signal pack ID. An entry is a pack's lookup key (identity.ts) and its pack ID, 48 bytes in all.
//
// The page downloads the whole index and matches it locally, so the server never learns which packs a user has.
// It sends the server a lookup key only when adding an upload.
//
// Anyone can add an entry, so an entry alone shows nothing. The page installs someone else's copy only after it
// compared the copy with the Telegram pack itself (compare-pack.ts). It compares at most MAX_COMPARISONS copies of
// a pack and then uploads the pack, so that bad copies cost a bounded amount of work.

import { fetchWithTimeLimit, REQUEST_TIME_LIMIT_S, SERVER_TIME_LIMIT_S } from '../../core/time-limit';
import { fromBinary } from '@bufbuild/protobuf';
import { type StickerPack, StickerPackSchema } from '../../gen/Stickers_pb';
import { loadSignalWasm } from '../../signal/wasm';
import { decryptStickerFile } from '../../wasm/signal_migration_wasm';
import { type OriginalPack, type PictureComparison, isFaithfulCopy } from './compare-pack';

const LOOKUP_KEY_LENGTH = 32;
const PACK_ID_LENGTH = 16;
const ENTRY_LENGTH = LOOKUP_KEY_LENGTH + PACK_ID_LENGTH;
/** The server returns at most this many entries per read (MAX_ENTRIES_PER_READ in crates/server/src/index.rs). */
const MAX_ENTRIES_PER_READ = 100_000;
/** Signal's CDN under a publicly trusted certificate, readable from any page. */
const PUBLIC_CDN = 'https://cdn-ca.signal.org';

/**
 * How long after its manifest was written a copy is left alone. For 30 minutes its uploader can replace the files
 * (Signal's upload forms are valid that long), and Signal's CDN goes on handing out a copy it stored earlier. It
 * was seen to do so for more than an hour; a day is assumed. After both, everyone is given the same, final files.
 */
export const SETTLED_AFTER_MS = (30 + 24 * 60) * 60 * 1000;
/** How many copies of a pack are compared with the Telegram pack before the page uploads the pack itself. */
export const MAX_COMPARISONS = 3;
/** How many listed copies are looked at from each end of the list while looking for usable ones. */
const MAX_LOOKS_PER_END = 10;

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The server's answers, as in crates/server/src/index.rs. "busy": its limit per address, or Signal's CDN did not
 * tell the server whether the pack exists; either way the entry can be sent again later.
 */
export type AddResult = 'added' | 'busy';

/** The index server's three operations. */
export interface IndexBackend {
  /** Entries from number `from` on, concatenated; at most the server's page size. */
  read(from: number): Promise<Uint8Array>;
  add(entry: Uint8Array): Promise<AddResult>;
}

/** A pack's encrypted manifest, and when it was last written, in milliseconds since 1970 (null when not known). */
export type FetchedManifest = { bytes: Uint8Array; lastModified: number | null };

/** Reads a pack's encrypted manifest from Signal's CDN; null when the CDN has no such pack. */
export type ManifestSource = (packId: Uint8Array) => Promise<FetchedManifest | null>;

/** Reads one encrypted sticker file of a pack from Signal's CDN; null when the CDN has no such file. */
export type StickerSource = (packId: Uint8Array, number: number) => Promise<Uint8Array | null>;

const fetchServer = (url: string, init?: RequestInit) =>
  fetchWithTimeLimit('The migration server', SERVER_TIME_LIMIT_S, url, init);

/** The index on the server that served this page. */
export const httpIndexBackend: IndexBackend = {
  async read(from) {
    const response = await fetchServer(`/v1/sticker-packs/index?from=${from}`);
    if (!response.ok) throw new Error(`reading the sticker pack index answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  async add(entry) {
    const response = await fetchServer('/v1/sticker-packs/index', {
      method: 'POST',
      body: entry as Uint8Array<ArrayBuffer>,
    });
    if (response.status === 201 || response.status === 200) return 'added';
    if (response.status === 429 || response.status === 503) return 'busy';
    throw new Error(`adding to the sticker pack index answered ${response.status}`);
  },
};

/** A file of a pack on Signal's public CDN; null when the CDN has no such file. */
async function fromPublicCdn(packId: Uint8Array, file: string): Promise<Response | null> {
  const response = await fetchWithTimeLimit(
    'Signal',
    REQUEST_TIME_LIMIT_S,
    `${PUBLIC_CDN}/stickers/${toHex(packId)}/${file}`,
  );
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Signal's CDN answered ${response.status} for a file of a sticker pack`);
  return response;
}

export const manifestFromPublicCdn: ManifestSource = async (packId) => {
  const response = await fromPublicCdn(packId, 'manifest.proto');
  if (!response) return null;
  const written = Date.parse(response.headers.get('last-modified') ?? '');
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    lastModified: Number.isNaN(written) ? null : written,
  };
};

export const stickerFromPublicCdn: StickerSource = async (packId, number) => {
  const response = await fromPublicCdn(packId, `full/${number}`);
  return response && new Uint8Array(await response.arrayBuffer());
};

/** Whether the manifest decrypts and parses with `packKey` (the decryption checks its MAC). */
async function manifestOpens(manifest: Uint8Array, packKey: Uint8Array): Promise<boolean> {
  await loadSignalWasm();
  try {
    fromBinary(StickerPackSchema, decryptStickerFile(manifest, packKey));
    return true;
  } catch {
    return false;
  }
}

export class PackIndex {
  #backend: IndexBackend;
  #manifests: ManifestSource;
  #stickers: StickerSource;
  #pageSize: number;
  #packIds = new Map<string, Uint8Array[]>();
  #entryCount = 0;
  /** The copies this page compared and found faithful, by lookup key and pack key. */
  #faithful = new Map<string, Uint8Array>();

  constructor(
    backend: IndexBackend = httpIndexBackend,
    manifests: ManifestSource = manifestFromPublicCdn,
    pageSize = MAX_ENTRIES_PER_READ,
    stickers: StickerSource = stickerFromPublicCdn,
  ) {
    this.#backend = backend;
    this.#manifests = manifests;
    this.#pageSize = pageSize;
    this.#stickers = stickers;
  }

  /** Reads the entries added since the last read. */
  async refresh(): Promise<void> {
    for (;;) {
      const body = await this.#backend.read(this.#entryCount);
      const count = Math.floor(body.length / ENTRY_LENGTH);
      for (let i = 0; i < count; i++) {
        const entry = body.subarray(i * ENTRY_LENGTH, (i + 1) * ENTRY_LENGTH);
        const key = toHex(entry.subarray(0, LOOKUP_KEY_LENGTH));
        this.#packIds.set(key, [...(this.#packIds.get(key) ?? []), entry.slice(LOOKUP_KEY_LENGTH)]);
      }
      this.#entryCount += count;
      if (count < this.#pageSize) return;
    }
  }

  /** A pack's manifest from Signal's CDN, decrypted with `packKey`; null when it is missing or does not decrypt. */
  async manifest(packId: Uint8Array, packKey: Uint8Array): Promise<StickerPack | null> {
    const encrypted = await this.#manifests(packId);
    if (!encrypted) return null;
    await loadSignalWasm();
    try {
      return fromBinary(StickerPackSchema, decryptStickerFile(encrypted.bytes, packKey));
    } catch {
      return null;
    }
  }

  /** The pack IDs of the entries for `lookupKey`, not yet checked against any key. */
  candidates(lookupKey: Uint8Array): Uint8Array[] {
    return this.#packIds.get(toHex(lookupKey)) ?? [];
  }

  /**
   * The copies of a pack that are worth comparing, in the order to compare them, with their manifests: the oldest
   * listed copy that is usable, then the newest, then the second newest. A copy is usable when Signal's CDN has
   * it, its manifest was written at least SETTLED_AFTER_MS before `now`, and the manifest decrypts with `packKey`.
   * Each copy is looked for only when the one before it was taken.
   *
   * The oldest copy comes first because bad copies added to a pack that already has a good one are then never
   * looked at. The newest come next because a good copy that someone uploaded after meeting bad ones is the newest.
   */
  async *#copiesToCompare(
    lookupKey: Uint8Array,
    packKey: Uint8Array,
    now: number,
  ): AsyncGenerator<{ packId: Uint8Array; manifest: Uint8Array }> {
    const listed = this.candidates(lookupKey);
    const usable = async (packId: Uint8Array) => {
      const manifest = await this.#manifests(packId);
      if (!manifest || manifest.lastModified === null || now - manifest.lastModified < SETTLED_AFTER_MS) return null;
      return (await manifestOpens(manifest.bytes, packKey)) ? { packId, manifest: manifest.bytes } : null;
    };
    let found = 0;
    /** The newest entry that was looked at from the oldest end. */
    let looked = -1;
    while (found === 0 && looked + 1 < Math.min(listed.length, MAX_LOOKS_PER_END)) {
      const copy = await usable(listed[++looked]);
      if (copy) {
        found++;
        yield copy;
      }
    }
    const lastLook = Math.max(looked + 1, listed.length - MAX_LOOKS_PER_END);
    for (let i = listed.length - 1; i >= lastLook && found < MAX_COMPARISONS; i--) {
      const copy = await usable(listed[i]);
      if (copy) {
        found++;
        yield copy;
      }
    }
  }

  /**
   * The pack ID of a listed copy that the page compared with the Telegram pack and found faithful, or null when
   * none of the copies it compared is. `now` is the time in milliseconds since 1970.
   */
  async findFaithful(
    pack: { lookupKey: Uint8Array; packKey: Uint8Array; original: OriginalPack },
    pictures: PictureComparison,
    now: number,
  ): Promise<Uint8Array | null> {
    const key = `${toHex(pack.lookupKey)}:${toHex(pack.packKey)}`;
    const known = this.#faithful.get(key);
    if (known) return known;
    await loadSignalWasm();
    for await (const copy of this.#copiesToCompare(pack.lookupKey, pack.packKey, now)) {
      const files = { manifest: async () => copy.manifest, sticker: this.#stickers };
      if (await isFaithfulCopy(copy.packId, pack.packKey, pack.original, files, pictures)) {
        this.#faithful.set(key, copy.packId);
        return copy.packId;
      }
    }
    return null;
  }

  /** Adds an uploaded pack. */
  async add(lookupKey: Uint8Array, packId: Uint8Array): Promise<AddResult> {
    const entry = new Uint8Array(ENTRY_LENGTH);
    entry.set(lookupKey, 0);
    entry.set(packId, LOOKUP_KEY_LENGTH);
    return this.#backend.add(entry);
  }
}
