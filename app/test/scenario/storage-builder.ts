// Builds encrypted storage service contents the way a Signal client does (Signal Desktop's
// ts/services/storage.preload.ts), for the simulated phone: the account's initial storage, and changes the app
// never makes itself. Each migration kind builds its own record types with `storageRecord`.

import { create, toBinary } from '@bufbuild/protobuf';
import {
  ContactRecordSchema,
  type ManifestRecord,
  ManifestRecord_Identifier_Type,
  ManifestRecord_IdentifierSchema,
  ManifestRecordSchema,
  type StorageRecord,
  StorageManifestSchema,
  StorageRecordSchema,
  WriteOperationSchema,
} from '../../src/gen/SignalStorage_pb';
import {
  encryptStorageBlob,
  storageManifestKey,
  storageRecordKey,
  storageServiceKeyFromMasterKey,
} from '../../src/wasm/signal_migration_wasm';
import { hex } from './bytes';

/** A storage record with a new random record ID, ready to encrypt. */
export type NewRecord = { recordId: Uint8Array; type: ManifestRecord_Identifier_Type; plaintext: Uint8Array };

export function storageRecord(type: ManifestRecord_Identifier_Type, record: StorageRecord['record']): NewRecord {
  return {
    recordId: crypto.getRandomValues(new Uint8Array(16)),
    type,
    plaintext: toBinary(StorageRecordSchema, create(StorageRecordSchema, { record })),
  };
}

export function contactRecord(name: string): NewRecord {
  return storageRecord(ManifestRecord_Identifier_Type.CONTACT, {
    case: 'contact',
    value: create(ContactRecordSchema, { givenName: name }),
  });
}

function encryptItems(masterKey: Uint8Array, recordIkm: Uint8Array, records: NewRecord[]) {
  const storageKey = storageServiceKeyFromMasterKey(masterKey);
  return records.map((record) => ({
    key: record.recordId,
    value: encryptStorageBlob(storageRecordKey(storageKey, recordIkm, record.recordId), record.plaintext),
  }));
}

function encryptManifest(masterKey: Uint8Array, manifest: ManifestRecord): Uint8Array {
  return encryptStorageBlob(
    storageManifestKey(storageServiceKeyFromMasterKey(masterKey), manifest.version),
    toBinary(ManifestRecordSchema, manifest),
  );
}

/** An account's first storage contents: manifest version 1 listing `records`. */
export function initialStorage(masterKey: Uint8Array, recordIkm: Uint8Array, records: NewRecord[]) {
  const manifest = create(ManifestRecordSchema, {
    version: 1n,
    sourceDevice: 1,
    recordIkm,
    identifiers: records.map((record) =>
      create(ManifestRecord_IdentifierSchema, { raw: record.recordId, type: record.type }),
    ),
  });
  return {
    version: 1n,
    manifest: encryptManifest(masterKey, manifest),
    items: encryptItems(masterKey, recordIkm, records),
  };
}

/** A write operation on top of `manifest` (at its version) that removes `deleted` records and adds `added` ones. */
export function writeOperation(
  masterKey: Uint8Array,
  manifest: ManifestRecord,
  deleted: Uint8Array[],
  added: NewRecord[],
): Uint8Array {
  const deletedHex = new Set(deleted.map(hex));
  const next = create(ManifestRecordSchema, {
    version: manifest.version + 1n,
    sourceDevice: 1,
    recordIkm: manifest.recordIkm,
    identifiers: [
      ...manifest.identifiers.filter((id) => !deletedHex.has(hex(id.raw))),
      ...added.map((record) => create(ManifestRecord_IdentifierSchema, { raw: record.recordId, type: record.type })),
    ],
  });
  return toBinary(
    WriteOperationSchema,
    create(WriteOperationSchema, {
      manifest: create(StorageManifestSchema, { version: next.version, value: encryptManifest(masterKey, next) }),
      insertItem: encryptItems(masterKey, manifest.recordIkm, added),
      deleteKey: deleted,
    }),
  );
}
