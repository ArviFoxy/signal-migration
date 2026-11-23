// Reading the account's contacts from the storage service and adding new ones, against the simulated Signal
// service, which stores the records encrypted as the real one does.

import { create, fromBinary, type MessageInitShape, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  type ContactRecord,
  ContactRecordSchema,
  ManifestRecord_Identifier_Type,
  ManifestRecord_IdentifierSchema,
  ManifestRecordSchema,
  ReadOperationSchema,
  StorageItemsSchema,
  StorageManifestSchema,
  StorageRecordSchema,
} from '../src/gen/SignalStorage_pb';
import { type ContactSnapshot, type NewContact, StorageClient } from '../src/signal/storage';
import {
  decryptStorageBlob,
  encryptStorageBlob,
  storageManifestKey,
  storageRecordKey,
  storageServiceKeyFromMasterKey,
} from '../src/wasm/signal_migration_wasm';
import { storageRecord } from './scenario/storage-builder';
import { User, World } from './scenario/world';
import './wasm';

/** An ID in the form with hyphens, ending in `number`. */
const id = (number: number) => `${'0'.repeat(8)}-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const bytesOf = (text: string) => Uint8Array.from(text.replaceAll('-', '').match(/../g)!, (pair) => parseInt(pair, 16));
const fromHex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));

const contact = (fields: MessageInitShape<typeof ContactRecordSchema>) =>
  storageRecord(ManifestRecord_Identifier_Type.CONTACT, {
    case: 'contact',
    value: create(ContactRecordSchema, fields),
  });

const MARA: NewContact = {
  accountId: null,
  phoneNumberIdentity: id(2),
  phoneNumber: '+12025550102',
  nickname: { given: 'Mara', family: 'Lindqvist' },
};

/** Every contact record the storage service holds for the user, decrypted as the phone would. */
function storedContactRecords(world: World, user: User, snapshot: ContactSnapshot): ContactRecord[] {
  const storageKey = storageServiceKeyFromMasterKey(user.masterKey);
  const records: ContactRecord[] = [];
  for (const [recordId, encrypted] of world.signal.storageItems(user.aci)) {
    const key = storageRecordKey(storageKey, snapshot.manifest.recordIkm, fromHex(recordId));
    const record = fromBinary(StorageRecordSchema, decryptStorageBlob(key, encrypted)).record;
    if (record.case === 'contact') records.push(record.value);
  }
  return records;
}

describe("the account's contacts in the storage service", () => {
  it('reads the identifiers of a contact, whether a client stored an ID as text or as bytes', async () => {
    const world = new World();
    const user = new User(world);
    const phoneStorage = await user.phone.storage();
    await user.phone.writeRecords(
      (await phoneStorage.readContacts()).manifest,
      [],
      [contact({ aci: id(1).toUpperCase(), e164: '+12025550101' }), contact({ pniBinary: bytesOf(id(2)) })],
    );

    const { contacts } = await (await user.linkDevice().storage()).readContacts();
    expect(contacts).toEqual([
      { accountId: id(1), phoneNumberIdentity: null, phoneNumber: '+12025550101' },
      { accountId: null, phoneNumberIdentity: id(2), phoneNumber: null },
    ]);
  });

  it('lists the accounts whose profile key the user holds, which contact discovery is told about', async () => {
    const world = new World();
    const user = new User(world);
    const profileKey = new Uint8Array(32).fill(7);
    const phoneStorage = await user.phone.storage();
    await user.phone.writeRecords(
      (await phoneStorage.readContacts()).manifest,
      [],
      [contact({ aci: id(1), profileKey }), contact({ aci: id(2) }), contact({ pni: id(3), e164: '+12025550103' })],
    );

    const { knownAccounts } = await (await user.linkDevice().storage()).readContacts();
    expect(knownAccounts).toEqual([{ accountId: id(1), profileKey }]);
  });

  it('adds a contact that the phone then reads', async () => {
    const world = new World();
    const user = new User(world);
    const storage = await user.linkDevice().storage();
    expect(await storage.addContacts(await storage.readContacts(), [MARA])).toBe(true);

    const { contacts } = await (await user.phone.storage()).readContacts();
    expect(contacts).toEqual([{ accountId: null, phoneNumberIdentity: id(2), phoneNumber: '+12025550102' }]);
  });

  it('gives the added contact its nickname and the mark of an accepted conversation, and sets nothing else', async () => {
    const world = new World();
    const user = new User(world);
    const storage = await user.linkDevice().storage();
    const snapshot = await storage.readContacts();
    await storage.addContacts(snapshot, [MARA]);

    const [stored] = storedContactRecords(world, user, snapshot);
    expect(stored).toMatchObject({
      pni: id(2),
      e164: '+12025550102',
      whitelisted: true,
      nickname: { given: 'Mara', family: 'Lindqvist' },
      aci: '',
      blocked: false,
      hidden: false,
      archived: false,
    });
    expect(stored!.pniBinary).toEqual(bytesOf(id(2)));
    expect(stored!.profileKey).toHaveLength(0);
    expect(stored!.identityKey).toHaveLength(0);
  });

  it('leaves the records of the existing contacts as they are', async () => {
    const world = new World();
    const user = new User(world, { contacts: 3 });
    const before = new Map(world.signal.storageItems(user.aci));
    const storage = await user.linkDevice().storage();
    await storage.addContacts(await storage.readContacts(), [MARA]);

    const after = world.signal.storageItems(user.aci);
    expect(after.size).toBe(4);
    for (const [recordId, encrypted] of before) expect(after.get(recordId)).toEqual(encrypted);
  });

  it('adds nothing when another device changed the storage in between', async () => {
    const world = new World();
    const user = new User(world);
    const storage = await user.linkDevice().storage();
    const snapshot = await storage.readContacts();
    world.signal.beforeNextStorageWrite(() =>
      user.phone.writeRecords(snapshot.manifest, [], [contact({ aci: id(9) })]),
    );

    expect(await storage.addContacts(snapshot, [MARA])).toBe(false);
    const { contacts } = await storage.readContacts();
    expect(contacts).toEqual([{ accountId: id(9), phoneNumberIdentity: null, phoneNumber: null }]);
  });

  // Detects: malformed legacy text aci taking precedence over canonical 16-byte aciBinary or passing invalid UUIDs
  // into contact discovery's accountKeys().
  it('prefers canonical 16-byte binary UUIDs and ignores malformed legacy text IDs', async () => {
    const world = new World();
    const user = new User(world);
    const profileKey = new Uint8Array(32).fill(5);
    const phoneStorage = await user.phone.storage();
    await user.phone.writeRecords(
      (await phoneStorage.readContacts()).manifest,
      [],
      [
        contact({ aci: 'not-a-valid-uuid', aciBinary: bytesOf(id(4)), profileKey }),
        contact({ aci: 'still-invalid-uuid', profileKey }),
      ],
    );

    const { contacts, knownAccounts } = await (await user.linkDevice().storage()).readContacts();
    expect(contacts).toEqual([
      { accountId: id(4), phoneNumberIdentity: null, phoneNumber: null },
      { accountId: null, phoneNumberIdentity: null, phoneNumber: null },
    ]);
    expect(knownAccounts).toEqual([{ accountId: id(4), profileKey }]);
  });

  // Detects: StorageClient.#write rebuilding ManifestRecord from scratch and dropping unknown future protobuf fields.
  it('preserves unknown ManifestRecord protobuf fields when writing a new manifest version', async () => {
    const world = new World();
    const user = new User(world);
    const phoneStorage = await user.phone.storage();
    const snapshot = await phoneStorage.readContacts();
    // Tag for field 99, wire type 2 (length-delimited): varint((99 << 3) | 2 = 794) = [0x9a, 0x06].
    const rawManifest = toBinary(ManifestRecordSchema, snapshot.manifest);
    const tagAndPayload = new Uint8Array([0x9a, 0x06, 4, 0xde, 0xad, 0xbe, 0xef]);
    const withUnknownBytes = new Uint8Array(rawManifest.length + tagAndPayload.length);
    withUnknownBytes.set(rawManifest, 0);
    withUnknownBytes.set(tagAndPayload, rawManifest.length);
    const manifestWithUnknown = fromBinary(ManifestRecordSchema, withUnknownBytes);
    expect(manifestWithUnknown.$unknown).toHaveLength(1);

    const storage = await user.linkDevice().storage();
    expect(
      await storage.addContacts(
        {
          ...snapshot,
          manifest: manifestWithUnknown,
        },
        [MARA],
      ),
    ).toBe(true);

    const updated = await (await user.phone.storage()).readContacts();
    expect(updated.manifest.$unknown).toEqual(manifestWithUnknown.$unknown);
  });

  // Detects: StorageClient.readStickerPacks sending all sticker pack record IDs in a single /v1/storage/read
  // request instead of chunking at 2500 keys like readContacts().
  it('chunks readStickerPacks requests at MAX_READ_KEYS (2500)', async () => {
    const storageKey = new Uint8Array(32).fill(9);
    const recordIkm = new Uint8Array(32).fill(3);
    const identifiers = Array.from({ length: 2505 }, (_, i) => {
      const raw = new Uint8Array(16);
      raw[0] = i & 0xff;
      raw[1] = (i >> 8) & 0xff;
      return create(ManifestRecord_IdentifierSchema, { raw, type: ManifestRecord_Identifier_Type.STICKER_PACK });
    });
    const manifest = create(ManifestRecordSchema, {
      version: 1n,
      sourceDevice: 1,
      identifiers,
      recordIkm,
    });
    const encryptedManifest = encryptStorageBlob(
      storageManifestKey(storageKey, 1n),
      toBinary(ManifestRecordSchema, manifest),
    );
    const readChunkSizes: number[] = [];
    const storage = await StorageClient.open(
      {
        async request() {
          return {
            status: 200,
            message: 'OK',
            headers: [],
            body: new TextEncoder().encode('{"username":"u","password":"p"}'),
          };
        },
      },
      storageKey,
      2,
      async (_host, method, path, _headers, body) => {
        if (method === 'GET' && path === '/v1/storage/manifest') {
          return {
            status: 200,
            header: () => undefined,
            body: toBinary(
              StorageManifestSchema,
              create(StorageManifestSchema, { version: 1n, value: encryptedManifest }),
            ),
          };
        }
        if (method === 'PUT' && path === '/v1/storage/read') {
          const readOp = fromBinary(ReadOperationSchema, body!);
          readChunkSizes.push(readOp.readKey.length);
          return {
            status: 200,
            header: () => undefined,
            body: toBinary(StorageItemsSchema, create(StorageItemsSchema)),
          };
        }
        return { status: 404, header: () => undefined, body: new Uint8Array(0) };
      },
    );

    await storage.readStickerPacks();
    expect(readChunkSizes).toEqual([2500, 5]);
  });
});
