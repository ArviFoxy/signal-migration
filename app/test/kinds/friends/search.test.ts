// The friend search and the adding of contacts: which people are found, in which order they are shown, who counts
// as being in Signal already, and what is written. Signal's storage service is the simulated one.

import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { ContactRecordSchema, ManifestRecord_Identifier_Type } from '../../../src/gen/SignalStorage_pb';
import {
  addContacts,
  contactsToAdd,
  findFriends,
  type FriendSource,
  phoneNumberSource,
  type SignalIdentifiers,
} from '../../../src/kinds/friends/search';
import type { ChatEntry, PeopleSource, Person } from '../../../src/kinds/friends/telegram-people';
import { storageRecord } from '../../scenario/storage-builder';
import { User, World } from '../../scenario/world';
import '../../wasm';

/** An ID in the form with hyphens, ending in `number`. */
const id = (number: number) => `${'0'.repeat(8)}-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;

const person = (userId: number, givenName: string, phoneNumber: string | null = null): Person => ({
  userId,
  givenName,
  familyName: '',
  phoneNumber,
});

const MARA = person(2, 'Mara', '+12025550102');
const JONAS = person(3, 'Jonas');
const AIKO = person(6, 'Aiko', '+447700900106');

const telegram = (chats: ChatEntry[], people: Person[]): PeopleSource => ({
  readPeople: () => Promise.resolve({ chats, people: new Map(people.map((one) => [one.userId, one])) }),
});

/** A source that finds exactly `accounts`, by Telegram user ID. */
const finding = (accounts: Record<number, Partial<SignalIdentifiers>>): FriendSource => ({
  find: () =>
    Promise.resolve(
      new Map(
        Object.entries(accounts).map(([userId, signal]) => [
          Number(userId),
          { accountId: null, phoneNumberIdentity: null, phoneNumber: null, ...signal },
        ]),
      ),
    ),
});

const signalContact = (fields: { pni?: string; e164?: string }) =>
  storageRecord(ManifestRecord_Identifier_Type.CONTACT, {
    case: 'contact',
    value: create(ContactRecordSchema, fields),
  });

describe('the source that asks about phone numbers', () => {
  it('asks only about people whose number Telegram shows, and gives each account to its person', async () => {
    const asked: string[][] = [];
    const source = phoneNumberSource((numbers) => {
      asked.push(numbers);
      return Promise.resolve([{ phoneNumber: MARA.phoneNumber!, phoneNumberIdentity: id(2), accountId: null }]);
    });
    const found = await source.find([MARA, JONAS, AIKO]);
    expect(asked).toEqual([[MARA.phoneNumber, AIKO.phoneNumber]]);
    expect([...found]).toEqual([
      [MARA.userId, { accountId: null, phoneNumberIdentity: id(2), phoneNumber: MARA.phoneNumber }],
    ]);
  });

  it('does not ask Signal at all when Telegram shows no number', async () => {
    let asked = false;
    const source = phoneNumberSource(() => {
      asked = true;
      return Promise.resolve([]);
    });
    expect((await source.find([JONAS])).size).toBe(0);
    expect(asked).toBe(false);
  });
});

describe('the friend search', () => {
  const chats: ChatEntry[] = [
    { kind: 'group', chatId: 100, title: 'Flat 12', memberIds: [3, 6] },
    { kind: 'person', userId: 3 },
    { kind: 'group', chatId: 101, title: 'Hiking crew', memberIds: [2, 3] },
    { kind: 'person', userId: 2 },
    { kind: 'group', chatId: 102, title: 'Nobody here', memberIds: [3] },
  ];

  it('keeps the chats with someone found, in the order of the chat list, each group with its found members', async () => {
    const world = new World();
    const account = new User(world).linkDevice();
    const source = finding({ 2: { phoneNumberIdentity: id(2) }, 6: { accountId: id(6) } });
    const search = await findFriends(telegram(chats, [MARA, JONAS, AIKO]), account, [source], () => undefined);
    expect(search.chats).toEqual([
      { kind: 'group', chatId: 100, title: 'Flat 12', memberIds: [6] },
      { kind: 'group', chatId: 101, title: 'Hiking crew', memberIds: [2] },
      { kind: 'person', userId: 2 },
    ]);
    expect([...search.found.keys()]).toEqual([2, 6]);
    expect(search.looked).toBe(3);
  });

  it('marks a person who is among the Signal contacts already, by any identifier the two share', async () => {
    const world = new World();
    const user = new User(world);
    const phoneStorage = await user.phone.storage();
    await user.phone.writeRecords(
      (await phoneStorage.readContacts()).manifest,
      [],
      [signalContact({ e164: MARA.phoneNumber! })],
    );
    const source = finding({
      2: { phoneNumberIdentity: id(2), phoneNumber: MARA.phoneNumber },
      6: { phoneNumberIdentity: id(6), phoneNumber: AIKO.phoneNumber },
    });
    const search = await findFriends(
      telegram(chats, [MARA, JONAS, AIKO]),
      user.linkDevice(),
      [source],
      () => undefined,
    );
    expect(search.found.get(2)!.inSignal).toBe(true);
    expect(search.found.get(6)!.inSignal).toBe(false);
  });

  it('puts together what two sources found about one person', async () => {
    const world = new World();
    const account = new User(world).linkDevice();
    const sources = [finding({ 2: { phoneNumberIdentity: id(2) } }), finding({ 2: { accountId: id(20) } })];
    const search = await findFriends(telegram(chats, [MARA]), account, sources, () => undefined);
    expect(search.found.get(2)!.signal).toEqual({ accountId: id(20), phoneNumberIdentity: id(2), phoneNumber: null });
  });
});

describe('adding the chosen friends to Signal', () => {
  const search = async (user: User) =>
    findFriends(
      telegram(
        [
          { kind: 'person', userId: 2 },
          { kind: 'person', userId: 6 },
        ],
        [MARA, AIKO],
      ),
      user.linkDevice(),
      [
        finding({
          2: { phoneNumberIdentity: id(2), phoneNumber: MARA.phoneNumber },
          6: { phoneNumberIdentity: id(6), phoneNumber: AIKO.phoneNumber },
        }),
      ],
      () => undefined,
    );

  it('leaves out the people the user unticked, and names each contact as on Telegram', async () => {
    const world = new World();
    const contacts = contactsToAdd(await search(new User(world)), [AIKO.userId]);
    expect(contacts).toEqual([
      {
        accountId: null,
        phoneNumberIdentity: id(2),
        phoneNumber: MARA.phoneNumber,
        nickname: { given: 'Mara', family: '' },
      },
    ]);
  });

  it('writes the contacts and tells the other devices to read the storage service again', async () => {
    const world = new World();
    const user = new User(world);
    const account = user.linkDevice();
    expect(await addContacts(account, contactsToAdd(await search(user), []))).toBe(2);

    const { contacts } = await (await user.phone.storage()).readContacts();
    expect(contacts.map((contact) => contact.phoneNumber)).toEqual([MARA.phoneNumber, AIKO.phoneNumber]);
    expect(world.signal.toldToFetchStorage.get(user.aci)).toBe(1);
  });

  it('does not add a person a second time, and then tells the other devices nothing', async () => {
    const world = new World();
    const user = new User(world);
    const account = user.linkDevice();
    const contacts = contactsToAdd(await search(user), []);
    await addContacts(account, contacts);
    expect(await addContacts(account, contacts)).toBe(0);

    expect((await (await user.phone.storage()).readContacts()).contacts).toHaveLength(2);
    expect(world.signal.toldToFetchStorage.get(user.aci)).toBe(1);
  });

  it('writes again when another device changed the storage in between, without the person that device added', async () => {
    const world = new World();
    const user = new User(world);
    const account = user.linkDevice();
    const contacts = contactsToAdd(await search(user), []);
    const manifest = (await (await user.phone.storage()).readContacts()).manifest;
    world.signal.beforeNextStorageWrite(() =>
      user.phone.writeRecords(manifest, [], [signalContact({ pni: id(2), e164: MARA.phoneNumber! })]),
    );
    expect(await addContacts(account, contacts)).toBe(1);

    const stored = (await (await user.phone.storage()).readContacts()).contacts;
    expect(stored.map((contact) => contact.phoneNumber).sort()).toEqual([MARA.phoneNumber, AIKO.phoneNumber].sort());
  });
});
