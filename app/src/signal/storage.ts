// The account's storage service: reading installed sticker packs and writing them with their order.
//
// The key derivations and encryption run in WebAssembly on libsignal's crates (crates/signal-wasm/src/crypto.rs),
// following Signal Desktop's ts/services/storage.preload.ts for the read and write protocol.

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  type InstalledStickerPackRecord,
  InstalledStickerPackRecordSchema,
  type ManifestRecord,
  ManifestRecord_Identifier_Type,
  ManifestRecord_IdentifierSchema,
  ManifestRecordSchema,
  ReadOperationSchema,
  StorageItemSchema,
  StorageItemsSchema,
  StorageManifestSchema,
  StorageRecordSchema,
  WriteOperationSchema,
} from '../gen/SignalStorage_pb';
import {
  decryptStorageBlob,
  encryptStorageBlob,
  storageManifestKey,
  storageRecordKey,
} from '../wasm/signal_migration_wasm';
import { httpsRequest } from './http-client';
import { basicAuthorization } from './session';
import type { ChatChannel, HttpsRequest } from './transport';
import { loadSignalWasm } from './wasm';

const STORAGE_HOST = 'storage.signal.org';
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** An installed sticker pack as recorded in the storage service. */
export type StoredStickerPack = { recordId: Uint8Array; packId: Uint8Array; packKey: Uint8Array; position: number };

/** A record left by uninstalling a pack: the pack ID with a deletion time. */
export type RemovedStickerPack = { recordId: Uint8Array; packId: Uint8Array };

/** The manifest and sticker pack records at one manifest version; the basis of a write. */
export type StickerPackSnapshot = {
  version: bigint;
  manifest: ManifestRecord;
  packs: StoredStickerPack[];
  removed: RemovedStickerPack[];
};

/** A sticker pack to (re)write with a position; `replaces` is the record it supersedes, if any. */
export type StickerPackWrite = { packId: Uint8Array; packKey: Uint8Array; position: number; replaces?: Uint8Array };

export class StorageClient {
  #authorization: string;
  #storageServiceKey: Uint8Array;
  #deviceId: number;
  #https: HttpsRequest;

  private constructor(authorization: string, storageServiceKey: Uint8Array, deviceId: number, https: HttpsRequest) {
    this.#authorization = authorization;
    this.#storageServiceKey = storageServiceKey;
    this.#deviceId = deviceId;
    this.#https = https;
  }

  /**
   * Gets storage service credentials over the logged-in chat connection of device `deviceId`. `storageServiceKey` is
   * derived from the account's master key once, at linking (link.ts); the master key itself is not kept.
   */
  static async open(
    chat: ChatChannel,
    storageServiceKey: Uint8Array,
    deviceId: number,
    https: HttpsRequest = httpsRequest,
  ): Promise<StorageClient> {
    const response = await chat.request('GET', '/v1/storage/auth');
    if (response.status !== 200)
      throw new Error(`GET /v1/storage/auth answered ${response.status} ${response.message}`);
    const { username, password } = JSON.parse(new TextDecoder().decode(response.body)) as {
      username: string;
      password: string;
    };
    await loadSignalWasm();
    return new StorageClient(basicAuthorization(username, password), storageServiceKey, deviceId, https);
  }

  async #request(method: string, path: string, body?: Uint8Array) {
    return this.#https(STORAGE_HOST, method, path, [this.#authorization, 'Content-Type: application/x-protobuf'], body);
  }

  async #readManifest(): Promise<{ version: bigint; manifest: ManifestRecord }> {
    const response = await this.#request('GET', '/v1/storage/manifest');
    if (response.status !== 200) throw new Error(`reading the storage manifest answered ${response.status}`);
    const stored = fromBinary(StorageManifestSchema, response.body);
    const manifest = fromBinary(
      ManifestRecordSchema,
      decryptStorageBlob(storageManifestKey(this.#storageServiceKey, stored.version), stored.value),
    );
    return { version: stored.version, manifest };
  }

  /** Reads the manifest and every sticker pack record it lists. */
  async readStickerPacks(): Promise<StickerPackSnapshot> {
    const { version, manifest } = await this.#readManifest();
    const ids = manifest.identifiers
      .filter((id) => id.type === ManifestRecord_Identifier_Type.STICKER_PACK)
      .map((id) => id.raw);
    const packs: StoredStickerPack[] = [];
    const removed: RemovedStickerPack[] = [];
    if (ids.length > 0) {
      const response = await this.#request(
        'PUT',
        '/v1/storage/read',
        toBinary(ReadOperationSchema, create(ReadOperationSchema, { readKey: ids })),
      );
      if (response.status !== 200) throw new Error(`reading storage records answered ${response.status}`);
      for (const item of fromBinary(StorageItemsSchema, response.body).items) {
        const key = storageRecordKey(this.#storageServiceKey, manifest.recordIkm, item.key);
        const record = fromBinary(StorageRecordSchema, decryptStorageBlob(key, item.value));
        if (record.record.case !== 'installedStickerPack') continue;
        const pack: InstalledStickerPackRecord = record.record.value;
        if (pack.deletedAtTimestamp !== 0n) removed.push({ recordId: item.key, packId: pack.packId });
        else packs.push({ recordId: item.key, packId: pack.packId, packKey: pack.packKey, position: pack.position });
      }
    }
    return { version, manifest, packs, removed };
  }

  /**
   * Writes sticker pack records as one atomic manifest update on top of `snapshot`. Each written pack gets a new
   * record id; a superseded record is removed. Returns false when the manifest changed since the snapshot
   * (HTTP 409); read again and recompute in that case.
   */
  async writeStickerPacks(snapshot: StickerPackSnapshot, writes: StickerPackWrite[]): Promise<boolean> {
    const newVersion = snapshot.version + 1n;
    const removed = new Set(writes.flatMap((w) => (w.replaces ? [base64(w.replaces)] : [])));
    const identifiers = snapshot.manifest.identifiers.filter((id) => !removed.has(base64(id.raw)));
    const insertItem = [];
    for (const write of writes) {
      const recordId = crypto.getRandomValues(new Uint8Array(16));
      const record = create(StorageRecordSchema, {
        record: {
          case: 'installedStickerPack',
          value: create(InstalledStickerPackRecordSchema, {
            packId: write.packId,
            packKey: write.packKey,
            position: write.position,
          }),
        },
      });
      const key = storageRecordKey(this.#storageServiceKey, snapshot.manifest.recordIkm, recordId);
      insertItem.push(
        create(StorageItemSchema, {
          key: recordId,
          value: encryptStorageBlob(key, toBinary(StorageRecordSchema, record)),
        }),
      );
      identifiers.push(
        create(ManifestRecord_IdentifierSchema, { raw: recordId, type: ManifestRecord_Identifier_Type.STICKER_PACK }),
      );
    }
    const manifest = create(ManifestRecordSchema, {
      version: newVersion,
      sourceDevice: this.#deviceId,
      identifiers,
      recordIkm: snapshot.manifest.recordIkm,
    });
    const encryptedManifest = encryptStorageBlob(
      storageManifestKey(this.#storageServiceKey, newVersion),
      toBinary(ManifestRecordSchema, manifest),
    );
    const operation = create(WriteOperationSchema, {
      manifest: create(StorageManifestSchema, { version: newVersion, value: encryptedManifest }),
      insertItem,
      deleteKey: writes.flatMap((w) => (w.replaces ? [w.replaces] : [])),
    });
    const response = await this.#request('PUT', '/v1/storage/', toBinary(WriteOperationSchema, operation));
    if (response.status === 409) return false;
    if (response.status !== 200) throw new Error(`writing storage records answered ${response.status}`);
    return true;
  }
}
