// Finding the Signal accounts of the people of a Telegram account, and adding the chosen ones to the account's
// Signal contacts.
//
// A source is one way of finding accounts. The first asks Signal's contact discovery about the phone numbers that
// Telegram shows the user. Others can follow; what the user sees does not depend on which source found a person.

import type { DiscoveredAccount } from '../../signal/contact-discovery';
import type { KnownAccount, NewContact, StoredContact } from '../../signal/storage';
import type { SignalAccount } from '../../signal/transport';
import { type ChatEntry, nameOf, type PeopleSource, type Person, type ReadingProgress } from './telegram-people';

/** The identifiers of a Signal account, as far as a source learned them. */
export type SignalIdentifiers = StoredContact;

/**
 * One way of finding the Signal accounts of people from Telegram, by their Telegram user IDs. `known` are the accounts
 * the user is in touch with on Signal already; a source that can uses them to say when a found person is one of them.
 */
export interface FriendSource {
  find(people: Person[], known: KnownAccount[]): Promise<Map<number, SignalIdentifiers>>;
}

/** The source that asks about the phone numbers Telegram shows; `discover` is Signal's contact discovery. */
export function phoneNumberSource(
  discover: (phoneNumbers: string[], known: KnownAccount[]) => Promise<DiscoveredAccount[]>,
): FriendSource {
  return {
    async find(people, known) {
      const byNumber = new Map<string, number[]>();
      for (const person of people) {
        if (!person.phoneNumber) continue;
        byNumber.set(person.phoneNumber, [...(byNumber.get(person.phoneNumber) ?? []), person.userId]);
      }
      const found = new Map<number, SignalIdentifiers>();
      if (byNumber.size === 0) return found;
      for (const account of await discover([...byNumber.keys()], known)) {
        for (const userId of byNumber.get(account.phoneNumber) ?? []) {
          found.set(userId, {
            accountId: account.accountId,
            phoneNumberIdentity: account.phoneNumberIdentity,
            phoneNumber: account.phoneNumber,
          });
        }
      }
      return found;
    },
  };
}

export type FoundFriend = {
  person: Person;
  signal: SignalIdentifiers;
  /** The person is among the account's Signal contacts already. */
  inSignal: boolean;
};

export type FriendSearch = {
  /** The chats with someone found, in the order of the Telegram chat list; a group lists its found members. */
  chats: ChatEntry[];
  found: Map<number, FoundFriend>;
  /** The found people who are on the user's Telegram contact list, in the order of their names. */
  contacts: number[];
  /** How many people were looked for. */
  looked: number;
};

/** How far a search is: reading the chats of the Telegram account, or asking Signal about the phone numbers found. */
export type SearchProgress = ({ part: 'telegram' } & ReadingProgress) | { part: 'signal'; phoneNumbers: number };

/** Whether two sets of identifiers name the same account. */
const sameAccount = (one: SignalIdentifiers, other: SignalIdentifiers) =>
  (one.accountId !== null && one.accountId === other.accountId) ||
  (one.phoneNumberIdentity !== null && one.phoneNumberIdentity === other.phoneNumberIdentity) ||
  (one.phoneNumber !== null && one.phoneNumber === other.phoneNumber);

/** What a later source adds to what an earlier one found about the same person. */
const merged = (first: SignalIdentifiers | undefined, later: SignalIdentifiers): SignalIdentifiers => ({
  accountId: first?.accountId ?? later.accountId,
  phoneNumberIdentity: first?.phoneNumberIdentity ?? later.phoneNumberIdentity,
  phoneNumber: first?.phoneNumber ?? later.phoneNumber,
});

/**
 * Reads the people of the Telegram account, asks every source about them and marks who is among the Signal
 * account's contacts already. `onProgress` says which of the two parts runs and how far it is.
 */
export async function findFriends(
  people: PeopleSource,
  account: SignalAccount,
  sources: FriendSource[],
  onProgress: (progress: SearchProgress) => void,
): Promise<FriendSearch> {
  const telegram = await people.readPeople((progress) => onProgress({ part: 'telegram', ...progress }));
  const everyone = [...telegram.people.values()];
  onProgress({ part: 'signal', phoneNumbers: everyone.filter((person) => person.phoneNumber !== null).length });
  const { contacts: inSignal, knownAccounts } = await (await account.storage()).readContacts();
  const identifiers = new Map<number, SignalIdentifiers>();
  for (const source of sources) {
    for (const [userId, signal] of await source.find(everyone, knownAccounts)) {
      identifiers.set(userId, merged(identifiers.get(userId), signal));
    }
  }
  const found = new Map<number, FoundFriend>();
  for (const [userId, signal] of identifiers) {
    const person = telegram.people.get(userId);
    if (person)
      found.set(userId, { person, signal, inSignal: inSignal.some((contact) => sameAccount(contact, signal)) });
  }
  const chats = telegram.chats.flatMap((chat): ChatEntry[] => {
    if (chat.kind === 'person') return found.has(chat.userId) ? [chat] : [];
    const memberIds = chat.memberIds.filter((userId) => found.has(userId));
    return memberIds.length > 0 ? [{ ...chat, memberIds }] : [];
  });
  const name = (userId: number) => nameOf(found.get(userId)!.person);
  const contacts = telegram.contactIds
    .filter((userId) => found.has(userId))
    .sort((one, other) => name(one).localeCompare(name(other)));
  return { chats, found, contacts, looked: everyone.length };
}

type Group = Extract<ChatEntry, { kind: 'group' }>;

/**
 * What the list of found friends shows: the chats or the Telegram contact list, the chats with their groups or as
 * people alone, and the text in the search box.
 */
export type FriendListView = { list: 'chats' | 'contacts'; groups: boolean; text: string };

/** One row of that list: a found person, or a group with its found members. */
export type FriendRow = { kind: 'person'; friend: FoundFriend } | { kind: 'group'; chat: Group };

/**
 * The rows of a search for `view`. A person is shown when the name contains the text; a group when its title or
 * the name of one of its found members does.
 */
export function friendRows(search: FriendSearch, view: FriendListView): FriendRow[] {
  const friendOf = (userId: number) => search.found.get(userId)!;
  const text = view.text.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(text);
  const named = (friend: FoundFriend) => matches(nameOf(friend.person));
  const person = (friend: FoundFriend): FriendRow => ({ kind: 'person', friend });
  if (view.list === 'contacts') return search.contacts.map(friendOf).filter(named).map(person);
  if (!view.groups) {
    // Each person once, in the order in which the chat list first shows them.
    const order = new Set(search.chats.flatMap((chat) => (chat.kind === 'person' ? [chat.userId] : chat.memberIds)));
    return [...order].map(friendOf).filter(named).map(person);
  }
  return search.chats.flatMap((chat): FriendRow[] => {
    if (chat.kind === 'person') return named(friendOf(chat.userId)) ? [person(friendOf(chat.userId))] : [];
    const shown = matches(chat.title) || chat.memberIds.some((userId) => named(friendOf(userId)));
    return shown ? [{ kind: 'group', chat }] : [];
  });
}

/** The people in `rows`, each once; a group counts with its found members. Ticking all that is shown ticks these. */
export function friendsIn(rows: FriendRow[], search: FriendSearch): FoundFriend[] {
  const userIds = new Set(
    rows.flatMap((row) => (row.kind === 'person' ? [row.friend.person.userId] : row.chat.memberIds)),
  );
  return [...userIds].map((userId) => search.found.get(userId)!);
}

/** The contacts to add: everyone found who is not in Signal yet and whom the user ticked. */
export function contactsToAdd(search: FriendSearch, ticked: readonly number[]): NewContact[] {
  return [...search.found.values()]
    .filter((friend) => !friend.inSignal && ticked.includes(friend.person.userId))
    .map((friend) => ({
      ...friend.signal,
      nickname: { given: friend.person.givenName, family: friend.person.familyName },
    }));
}

/** How often adding is tried again when another device changed the storage service in between. */
const WRITE_ATTEMPTS = 5;

/**
 * Adds `contacts` to the account's Signal contacts and tells its other devices. A person who has become a contact
 * in the meantime is left as they are. The other devices are told also when every person is a contact already: an
 * earlier attempt can have written them and stopped before telling. Returns how many were added.
 */
export async function addContacts(account: SignalAccount, contacts: NewContact[]): Promise<number> {
  if (contacts.length === 0) return 0;
  const storage = await account.storage();
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const snapshot = await storage.readContacts();
    const fresh = contacts.filter((contact) => !snapshot.contacts.some((stored) => sameAccount(stored, contact)));
    if (fresh.length === 0 || (await storage.addContacts(snapshot, fresh))) {
      await account.announceStorageChange();
      return fresh.length;
    }
  }
  throw new Error('your Signal contacts kept changing while they were being written');
}
