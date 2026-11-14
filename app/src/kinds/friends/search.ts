// Finding the Signal accounts of the people of a Telegram account, and adding the chosen ones to the account's
// Signal contacts.
//
// A source is one way of finding accounts. The first asks Signal's contact discovery about the phone numbers that
// Telegram shows the user. Others can follow; what the user sees does not depend on which source found a person.

import type { DiscoveredAccount } from '../../signal/contact-discovery';
import type { NewContact, StoredContact } from '../../signal/storage';
import type { SignalAccount } from '../../signal/transport';
import type { ChatEntry, PeopleSource, Person } from './telegram-people';

/** The identifiers of a Signal account, as far as a source learned them. */
export type SignalIdentifiers = StoredContact;

/** One way of finding the Signal accounts of people from Telegram, by their Telegram user IDs. */
export interface FriendSource {
  find(people: Person[]): Promise<Map<number, SignalIdentifiers>>;
}

/** The source that asks about the phone numbers Telegram shows; `discover` is Signal's contact discovery. */
export function phoneNumberSource(discover: (phoneNumbers: string[]) => Promise<DiscoveredAccount[]>): FriendSource {
  return {
    async find(people) {
      const byNumber = new Map<string, number[]>();
      for (const person of people) {
        if (!person.phoneNumber) continue;
        byNumber.set(person.phoneNumber, [...(byNumber.get(person.phoneNumber) ?? []), person.userId]);
      }
      const found = new Map<number, SignalIdentifiers>();
      if (byNumber.size === 0) return found;
      for (const account of await discover([...byNumber.keys()])) {
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
  /** How many people were looked for. */
  looked: number;
};

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
 * account's contacts already. `onProgress` follows the reading of the chat list.
 */
export async function findFriends(
  people: PeopleSource,
  account: SignalAccount,
  sources: FriendSource[],
  onProgress: (done: number, total: number) => void,
): Promise<FriendSearch> {
  const telegram = await people.readPeople(onProgress);
  const everyone = [...telegram.people.values()];
  const identifiers = new Map<number, SignalIdentifiers>();
  for (const source of sources) {
    for (const [userId, signal] of await source.find(everyone)) {
      identifiers.set(userId, merged(identifiers.get(userId), signal));
    }
  }
  const { contacts } = await (await account.storage()).readContacts();
  const found = new Map<number, FoundFriend>();
  for (const [userId, signal] of identifiers) {
    const person = telegram.people.get(userId);
    if (person)
      found.set(userId, { person, signal, inSignal: contacts.some((contact) => sameAccount(contact, signal)) });
  }
  const chats = telegram.chats.flatMap((chat): ChatEntry[] => {
    if (chat.kind === 'person') return found.has(chat.userId) ? [chat] : [];
    const memberIds = chat.memberIds.filter((userId) => found.has(userId));
    return memberIds.length > 0 ? [{ ...chat, memberIds }] : [];
  });
  return { chats, found, looked: everyone.length };
}

/** The contacts to add: everyone found who is not in Signal yet and whom the user left ticked. */
export function contactsToAdd(search: FriendSearch, unticked: readonly number[]): NewContact[] {
  return [...search.found.values()]
    .filter((friend) => !friend.inSignal && !unticked.includes(friend.person.userId))
    .map((friend) => ({
      ...friend.signal,
      nickname: { given: friend.person.givenName, family: friend.person.familyName },
    }));
}

/** How often adding is tried again when another device changed the storage service in between. */
const WRITE_ATTEMPTS = 5;

/**
 * Adds `contacts` to the account's Signal contacts and tells its other devices. A person who has become a contact
 * in the meantime is left as they are. Returns how many were added.
 */
export async function addContacts(account: SignalAccount, contacts: NewContact[]): Promise<number> {
  const storage = await account.storage();
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const snapshot = await storage.readContacts();
    const fresh = contacts.filter((contact) => !snapshot.contacts.some((stored) => sameAccount(stored, contact)));
    if (fresh.length === 0) return 0;
    if (await storage.addContacts(snapshot, fresh)) {
      await account.announceStorageChange();
      return fresh.length;
    }
  }
  throw new Error('your Signal contacts kept changing while they were being written');
}
