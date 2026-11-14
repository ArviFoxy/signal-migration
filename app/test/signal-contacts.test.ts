// Reading the account's contacts from the storage service and adding new ones, against the simulated Signal
// service, which stores the records encrypted as the real one does.

import { create, fromBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  type ContactRecord,
  ContactRecordSchema,
  ManifestRecord_Identifier_Type,
  StorageRecordSchema,
} from '../src/gen/SignalStorage_pb';
import type { ContactSnapshot, NewContact } from '../src/signal/storage';
import {
  decryptStorageBlob,
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
});
