// The sticker pack index on our server: which Telegram packs someone has already uploaded to Signal, and under
// which Signal pack ID. An entry is a pack's lookup key (identity.ts) and its pack ID, 48 bytes in all.
//
// The page downloads the whole index and matches it locally, so the server never learns which packs a user has.
// It sends the server only lookup keys, when claiming a pack before uploading it and when adding the upload.
// An entry is trusted only after the pack's manifest, fetched from Signal's CDN, decrypts with the pack key that
// the user derived from the Telegram pack: a wrong or forged entry fails that check and is ignored.

import { fromBinary } from '@bufbuild/protobuf';
import { StickerPackSchema } from '../../gen/Stickers_pb';
import { loadSignalWasm } from '../../signal/wasm';
import { decryptStickerFile } from '../../wasm/signal_migration_wasm';

const LOOKUP_KEY_LENGTH = 32;
const PACK_ID_LENGTH = 16;
const ENTRY_LENGTH = LOOKUP_KEY_LENGTH + PACK_ID_LENGTH;
/** The server returns at most this many entries per read (MAX_ENTRIES_PER_READ in crates/server/src/index.rs). */
const MAX_ENTRIES_PER_READ = 100_000;
/** Signal's CDN under a publicly trusted certificate, readable from any page. */
const PUBLIC_CDN = 'https://cdn-ca.signal.org';

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** The server's answers, as in crates/server/src/index.rs. "busy" is its per-address rate limit. */
export type ClaimResult = 'granted' | 'held-by-someone-else' | 'busy';
export type AddResult = 'added' | 'busy';

/** The index server's three operations. */
export interface IndexBackend {
  /** Entries from number `from` on, concatenated; at most the server's page size. */
  read(from: number): Promise<Uint8Array>;
  claim(lookupKey: Uint8Array, claimant: Uint8Array): Promise<ClaimResult>;
  add(entry: Uint8Array): Promise<AddResult>;
}

/** Reads a pack's encrypted manifest from Signal's CDN; null when the CDN has no such pack. */
export type ManifestSource = (packId: Uint8Array) => Promise<Uint8Array | null>;

/** The index on the server that served this page. */
export const httpIndexBackend: IndexBackend = {
  async read(from) {
    const response = await fetch(`/v1/sticker-packs/index?from=${from}`);
    if (!response.ok) throw new Error(`reading the sticker pack index answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  async claim(lookupKey, claimant) {
    const body = new Uint8Array([...lookupKey, ...claimant]);
    const response = await fetch('/v1/sticker-packs/claims', { method: 'POST', body });
    if (response.status === 201) return 'granted';
    if (response.status === 409) return 'held-by-someone-else';
    if (response.status === 429) return 'busy';
    throw new Error(`claiming a sticker pack answered ${response.status}`);
  },
  async add(entry) {
    const response = await fetch('/v1/sticker-packs/index', { method: 'POST', body: entry as Uint8Array<ArrayBuffer> });
    if (response.status === 201 || response.status === 200) return 'added';
    if (response.status === 429) return 'busy';
    throw new Error(`adding to the sticker pack index answered ${response.status}`);
  },
};

export const manifestFromPublicCdn: ManifestSource = async (packId) => {
  const response = await fetch(`${PUBLIC_CDN}/stickers/${toHex(packId)}/manifest.proto`);
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Signal's CDN answered ${response.status} for a sticker pack manifest`);
  return new Uint8Array(await response.arrayBuffer());
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
  #pageSize: number;
  /** A random token for this page's claims, so that it can renew them; it identifies nothing beyond this visit. */
  readonly #claimant = crypto.getRandomValues(new Uint8Array(32));
  #packIds = new Map<string, Uint8Array[]>();
  #entryCount = 0;
  #verified = new Map<string, Uint8Array>();

  constructor(
    backend: IndexBackend = httpIndexBackend,
    manifests: ManifestSource = manifestFromPublicCdn,
    pageSize = MAX_ENTRIES_PER_READ,
  ) {
    this.#backend = backend;
    this.#manifests = manifests;
    this.#pageSize = pageSize;
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

  /** The pack ID of the first entry for `lookupKey` whose manifest opens with `packKey`, or null. */
  async find(lookupKey: Uint8Array, packKey: Uint8Array): Promise<Uint8Array | null> {
    const key = toHex(lookupKey);
    const known = this.#verified.get(key);
    if (known) return known;
    for (const packId of this.#packIds.get(key) ?? []) {
      const manifest = await this.#manifests(packId);
      if (manifest && (await manifestOpens(manifest, packKey))) {
        this.#verified.set(key, packId);
        return packId;
      }
    }
    return null;
  }

  /** Claims the pack for upload for 15 minutes, or renews this page's own claim. */
  claim(lookupKey: Uint8Array): Promise<ClaimResult> {
    return this.#backend.claim(lookupKey, this.#claimant);
  }

  /** Adds an uploaded pack, which also ends its claim. */
  async add(lookupKey: Uint8Array, packId: Uint8Array): Promise<AddResult> {
    const entry = new Uint8Array(ENTRY_LENGTH);
    entry.set(lookupKey, 0);
    entry.set(packId, LOOKUP_KEY_LENGTH);
    const result = await this.#backend.add(entry);
    if (result === 'added') this.#verified.set(toHex(lookupKey), packId);
    return result;
  }
}
