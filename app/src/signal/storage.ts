// The account's storage service: reading installed sticker packs and writing them with their order, and reading
// and adding contacts.
//
// The key derivations and encryption run in WebAssembly on libsignal's crates (crates/signal-wasm/src/crypto.rs),
// following Signal Desktop's ts/services/storage.preload.ts for the read and write protocol.

import { clone, create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  ContactRecord_NameSchema,
  ContactRecordSchema,
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
  type StorageRecord,
  StorageRecordSchema,
  WriteOperationSchema,
} from '../gen/SignalStorage_pb';
import {
  decryptStorageBlob,
  encryptStorageBlob,
  storageManifestKey,
  storageRecordKey,
} from '../wasm/signal_migration_wasm';
import { fromHex, toBase64, toHex } from '../core/bytes';
import { httpsRequest } from './http-client';
import { randomBytes } from '../core/random';
import { basicAuthorization } from './session';
import type { ChatChannel, HttpsRequest } from './transport';
import { loadSignalWasm } from './wasm';

const STORAGE_HOST = 'storage.signal.org';

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

/** A contact of the account, by the identifiers its record holds. */
export type StoredContact = {
  accountId: string | null;
  phoneNumberIdentity: string | null;
  /** A plus sign and digits. */
  phoneNumber: string | null;
};

/** An account whose profile key the user's Signal holds: a person the user is in touch with on Signal. */
export type KnownAccount = { accountId: string; profileKey: Uint8Array };

/** The manifest and the contacts at one manifest version; the basis of a write. */
export type ContactSnapshot = {
  version: bigint;
  manifest: ManifestRecord;
  contacts: StoredContact[];
  /** The contacts that have an account ID and a profile key. */
  knownAccounts: KnownAccount[];
};

/** A contact to add. It has an account ID or a phone number identity, or both. */
export type NewContact = StoredContact & {
  /** The name Signal's apps show for the contact, in place of the name the person chose on Signal. */
  nickname: { given: string; family: string };
};

const PROFILE_KEY_LENGTH = 32;

/** How many records one read may ask for, as in Signal Desktop (ts/services/storageConstants.std.ts). */
const MAX_READ_KEYS = 2500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_KEY_LENGTH = 32;

/** An ID in the form with hyphens, from its 16 bytes. */
function idFromBytes(bytes: Uint8Array): string {
  const digits = toHex(bytes);
  return [digits.slice(0, 8), digits.slice(8, 12), digits.slice(12, 16), digits.slice(16, 20), digits.slice(20)].join(
    '-',
  );
}

export function bytesOfId(id: string): Uint8Array {
  if (!UUID_PATTERN.test(id)) throw new Error(`invalid Signal UUID: ${id}`);
  return fromHex(id.replaceAll('-', ''));
}

/**
 * The ID a record holds. Prefers the canonical 16-byte binary form and falls back to the legacy text field only
 * when it is a well-formed hyphenated UUID.
 */
function idOf(text: string, bytes: Uint8Array): string | null {
  if (bytes.length === 16) return idFromBytes(bytes);
  return UUID_PATTERN.test(text) ? text.toLowerCase() : null;
}

export type StorageKeySource = Uint8Array | (() => Uint8Array);

export class StorageClient {
  #authorization: string;
  #storageServiceKey: StorageKeySource;
  #deviceId: number;
  #https: HttpsRequest;

  private constructor(
    authorization: string,
    storageServiceKey: StorageKeySource,
    deviceId: number,
    https: HttpsRequest,
  ) {
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
    storageServiceKey: StorageKeySource,
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

  #readKey(): Uint8Array {
    const key = typeof this.#storageServiceKey === 'function' ? this.#storageServiceKey() : this.#storageServiceKey;
    if (key.length !== STORAGE_KEY_LENGTH || key.every((byte) => byte === 0)) {
      throw new Error('the storage service key is missing or zeroed');
    }
    return key;
  }

  async #request(method: string, path: string, body?: Uint8Array) {
    return this.#https(STORAGE_HOST, method, path, [this.#authorization, 'Content-Type: application/x-protobuf'], body);
  }

  async #readManifest(): Promise<{ version: bigint; manifest: ManifestRecord }> {
    const storageKey = this.#readKey();
    const response = await this.#request('GET', '/v1/storage/manifest');
    if (response.status !== 200) throw new Error(`reading the storage manifest answered ${response.status}`);
    const stored = fromBinary(StorageManifestSchema, response.body);
    const manifest = fromBinary(
      ManifestRecordSchema,
      decryptStorageBlob(storageManifestKey(storageKey, stored.version), stored.value),
    );
    return { version: stored.version, manifest };
  }

  /** Reads and decrypts every record of `type` listed in `manifest`, chunked to `MAX_READ_KEYS`. */
  async #readRecords(
    manifest: ManifestRecord,
    type: ManifestRecord_Identifier_Type,
  ): Promise<{ id: Uint8Array; record: StorageRecord }[]> {
    const ids = manifest.identifiers.filter((id) => id.type === type).map((id) => id.raw);
    const results: { id: Uint8Array; record: StorageRecord }[] = [];
    for (let start = 0; start < ids.length; start += MAX_READ_KEYS) {
      const response = await this.#request(
        'PUT',
        '/v1/storage/read',
        toBinary(
          ReadOperationSchema,
          create(ReadOperationSchema, { readKey: ids.slice(start, start + MAX_READ_KEYS) }),
        ),
      );
      if (response.status !== 200) throw new Error(`reading storage records answered ${response.status}`);
      const storageKey = this.#readKey();
      for (const item of fromBinary(StorageItemsSchema, response.body).items) {
        const key = storageRecordKey(storageKey, manifest.recordIkm, item.key);
        const record = fromBinary(StorageRecordSchema, decryptStorageBlob(key, item.value));
        results.push({ id: item.key, record });
      }
    }
    return results;
  }

  /** Reads the manifest and every sticker pack record it lists. */
  async readStickerPacks(): Promise<StickerPackSnapshot> {
    const { version, manifest } = await this.#readManifest();
    const packs: StoredStickerPack[] = [];
    const removed: RemovedStickerPack[] = [];
    for (const { id, record } of await this.#readRecords(manifest, ManifestRecord_Identifier_Type.STICKER_PACK)) {
      if (record.record.case !== 'installedStickerPack') continue;
      const pack: InstalledStickerPackRecord = record.record.value;
      if (pack.deletedAtTimestamp !== 0n) removed.push({ recordId: id, packId: pack.packId });
      else packs.push({ recordId: id, packId: pack.packId, packKey: pack.packKey, position: pack.position });
    }
    return { version, manifest, packs, removed };
  }

  /**
   * Writes sticker pack records as one atomic manifest update on top of `snapshot`. Each written pack gets a new
   * record id; a superseded record is removed. Returns false when the manifest changed since the snapshot
   * (HTTP 409); read again and recompute in that case.
   */
  async writeStickerPacks(snapshot: StickerPackSnapshot, writes: StickerPackWrite[]): Promise<boolean> {
    return this.#write(
      snapshot,
      writes.map((write) => ({
        type: ManifestRecord_Identifier_Type.STICKER_PACK,
        record: {
          case: 'installedStickerPack',
          value: create(InstalledStickerPackRecordSchema, {
            packId: write.packId,
            packKey: write.packKey,
            position: write.position,
          }),
        },
      })),
      writes.flatMap((write) => (write.replaces ? [write.replaces] : [])),
    );
  }

  /** Reads the manifest and the identifiers of every contact it lists. */
  async readContacts(): Promise<ContactSnapshot> {
    const { version, manifest } = await this.#readManifest();
    const contacts: StoredContact[] = [];
    const knownAccounts: KnownAccount[] = [];
    for (const { record } of await this.#readRecords(manifest, ManifestRecord_Identifier_Type.CONTACT)) {
      if (record.record.case !== 'contact') continue;
      const contact = record.record.value;
      const accountId = idOf(contact.aci, contact.aciBinary);
      if (accountId && contact.profileKey.length === PROFILE_KEY_LENGTH)
        knownAccounts.push({ accountId, profileKey: contact.profileKey });
      contacts.push({
        accountId,
        phoneNumberIdentity: idOf(contact.pni, contact.pniBinary),
        phoneNumber: contact.e164 || null,
      });
    }
    return { version, manifest, contacts, knownAccounts };
  }

  /**
   * Adds contacts as one atomic manifest update on top of `snapshot`. Returns false when the manifest changed since
   * the snapshot (HTTP 409); read again and decide again in that case. The caller leaves out people who are among
   * the snapshot's contacts: a second record for a person would overwrite what the user set for them.
   *
   * A record carries the identifiers, the nickname and `whitelisted`. That field says the user accepted the
   * conversation with the person: Signal for Android lists only such a contact, and a message from the person
   * arrives without the step of accepting a request. A record sets nothing else: no blocking, no keys.
   */
  async addContacts(snapshot: ContactSnapshot, contacts: NewContact[]): Promise<boolean> {
    return this.#write(
      snapshot,
      contacts.map((contact) => ({
        type: ManifestRecord_Identifier_Type.CONTACT,
        record: {
          case: 'contact',
          value: create(ContactRecordSchema, {
            aci: contact.accountId ?? '',
            aciBinary: contact.accountId ? bytesOfId(contact.accountId) : new Uint8Array(0),
            pni: contact.phoneNumberIdentity ?? '',
            pniBinary: contact.phoneNumberIdentity ? bytesOfId(contact.phoneNumberIdentity) : new Uint8Array(0),
            e164: contact.phoneNumber ?? '',
            whitelisted: true,
            nickname: create(ContactRecord_NameSchema, contact.nickname),
          }),
        },
      })),
      [],
    );
  }

  /** Inserts `records` and removes the records `removed` names, as one manifest update on top of `snapshot`. */
  async #write(
    snapshot: { version: bigint; manifest: ManifestRecord },
    records: { type: ManifestRecord_Identifier_Type; record: StorageRecord['record'] }[],
    removed: Uint8Array[],
  ): Promise<boolean> {
    const storageKey = this.#readKey();
    const newVersion = snapshot.version + 1n;
    const removedIds = new Set(removed.map(toBase64));
    const identifiers = snapshot.manifest.identifiers.filter((id) => !removedIds.has(toBase64(id.raw)));
    const insertItem = [];
    for (const { type, record } of records) {
      const recordId = randomBytes(16);
      const key = storageRecordKey(storageKey, snapshot.manifest.recordIkm, recordId);
      insertItem.push(
        create(StorageItemSchema, {
          key: recordId,
          value: encryptStorageBlob(key, toBinary(StorageRecordSchema, create(StorageRecordSchema, { record }))),
        }),
      );
      identifiers.push(create(ManifestRecord_IdentifierSchema, { raw: recordId, type }));
    }
    // Clone the existing manifest so unknown future protobuf fields ($unknown) survive our write.
    const manifest = clone(ManifestRecordSchema, snapshot.manifest);
    manifest.version = newVersion;
    manifest.sourceDevice = this.#deviceId;
    manifest.identifiers = identifiers;
    const encryptedManifest = encryptStorageBlob(
      storageManifestKey(storageKey, newVersion),
      toBinary(ManifestRecordSchema, manifest),
    );
    const operation = create(WriteOperationSchema, {
      manifest: create(StorageManifestSchema, { version: newVersion, value: encryptedManifest }),
      insertItem,
      deleteKey: removed,
    });
    const response = await this.#request('PUT', '/v1/storage/', toBinary(WriteOperationSchema, operation));
    if (response.status === 409) return false;
    if (response.status !== 200) throw new Error(`writing storage records answered ${response.status}`);
    return true;
  }
}
