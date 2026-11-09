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

/** The server asked the page to slow down; try again later. */
export class IndexBusyError extends Error {
  constructor(action: string) {
    super(`the sticker pack index is limiting ${action} from this address; try again in a minute`);
  }
}

/** Whether `packId` on Signal's CDN is a sticker pack encrypted with `packKey`. */
export async function verifyPack(packId: Uint8Array, packKey: Uint8Array): Promise<boolean> {
  const response = await fetch(`${PUBLIC_CDN}/stickers/${toHex(packId)}/manifest.proto`);
  if (response.status === 403 || response.status === 404) return false;
  if (!response.ok) throw new Error(`Signal's CDN answered ${response.status} for a sticker pack manifest`);
  await loadSignalWasm();
  try {
    fromBinary(StickerPackSchema, decryptStickerFile(new Uint8Array(await response.arrayBuffer()), packKey));
    return true;
  } catch {
    return false;
  }
}

export class PackIndex {
  #packIds = new Map<string, Uint8Array[]>();
  #entryCount = 0;
  #verified = new Map<string, Uint8Array | null>();

  /** Reads the entries added since the last read. */
  async refresh(): Promise<void> {
    for (;;) {
      const response = await fetch(`/v1/sticker-packs/index?from=${this.#entryCount}`);
      if (!response.ok) throw new Error(`reading the sticker pack index answered ${response.status}`);
      const body = new Uint8Array(await response.arrayBuffer());
      const count = Math.floor(body.length / ENTRY_LENGTH);
      for (let i = 0; i < count; i++) {
        const entry = body.subarray(i * ENTRY_LENGTH, (i + 1) * ENTRY_LENGTH);
        const key = toHex(entry.subarray(0, LOOKUP_KEY_LENGTH));
        this.#packIds.set(key, [...(this.#packIds.get(key) ?? []), entry.slice(LOOKUP_KEY_LENGTH)]);
      }
      this.#entryCount += count;
      if (count < MAX_ENTRIES_PER_READ) return;
    }
  }

  /** The pack ID of the first entry for `lookupKey` that verifies with `packKey`, or null. */
  async find(lookupKey: Uint8Array, packKey: Uint8Array): Promise<Uint8Array | null> {
    const key = toHex(lookupKey);
    const known = this.#verified.get(key);
    if (known) return known;
    for (const packId of this.#packIds.get(key) ?? []) {
      if (await verifyPack(packId, packKey)) {
        this.#verified.set(key, packId);
        return packId;
      }
    }
    return null;
  }

  /** Whether any entry exists for `lookupKey`, verified or not. */
  has(lookupKey: Uint8Array): boolean {
    return this.#packIds.has(toHex(lookupKey));
  }

  /**
   * Claims the pack for upload for 15 minutes, so that nobody else uploads it meanwhile. Returns false when someone
   * else holds the claim.
   */
  async claim(lookupKey: Uint8Array): Promise<boolean> {
    const response = await fetch('/v1/sticker-packs/claims', { method: 'POST', body: lookupKey as Uint8Array<ArrayBuffer> });
    if (response.status === 201) return true;
    if (response.status === 409) return false;
    if (response.status === 429) throw new IndexBusyError('claims');
    throw new Error(`claiming a sticker pack answered ${response.status}`);
  }

  /** Adds an uploaded pack, which also ends its claim. */
  async add(lookupKey: Uint8Array, packId: Uint8Array): Promise<void> {
    const entry = new Uint8Array(ENTRY_LENGTH);
    entry.set(lookupKey, 0);
    entry.set(packId, LOOKUP_KEY_LENGTH);
    const response = await fetch('/v1/sticker-packs/index', { method: 'POST', body: entry });
    if (response.status === 429) throw new IndexBusyError('additions');
    if (response.status !== 201 && response.status !== 200) throw new Error(`adding to the sticker pack index answered ${response.status}`);
    const key = toHex(lookupKey);
    this.#packIds.set(key, [...(this.#packIds.get(key) ?? []), packId]);
    this.#verified.set(key, packId);
  }
}
