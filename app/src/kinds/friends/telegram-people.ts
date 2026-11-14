// The people of a Telegram account, as its chat list shows them: everyone the user has a one-to-one chat with, and
// the members of the user's groups. Telegram has no list of friends, so these are the people a user can mean.

import type * as Td from 'tdlib-types';
import { type TelegramClient, TelegramError, untilNotRestarted } from '../../telegram/client';

export type Person = {
  userId: number;
  /** The names as Telegram shows them to the user; the family name can be empty. */
  givenName: string;
  familyName: string;
  /** A plus sign and digits, when Telegram shows the user this person's phone number. */
  phoneNumber: string | null;
};

export const nameOf = (person: Person) => [person.givenName, person.familyName].filter(Boolean).join(' ');

/** One row of the chat list: a one-to-one chat, or a group with the people in it. */
export type ChatEntry =
  | { kind: 'person'; userId: number }
  | {
      kind: 'group';
      chatId: number;
      title: string;
      memberIds: number[];
      /** How many people the group has. A list made from this one can keep fewer of them in `memberIds`. */
      memberCount: number;
    };

export type TelegramPeople = {
  /** In the order of the user's chat list. */
  chats: ChatEntry[];
  people: Map<number, Person>;
};

/**
 * The largest group whose members are read. A larger group is left out of the list as a group; its members still
 * appear when the user has a one-to-one chat with them or shares a smaller group with them.
 */
export const GROUP_SIZE_LIMIT = 1000;

/** Where the people come from: the user's account in the app, simulated data in tests. */
export interface PeopleSource {
  readPeople(onProgress: (done: number, total: number) => void): Promise<TelegramPeople>;
}

/** How many chats Telegram is asked to load, and how many members of a large group it gives, in one request. */
const CHATS_PER_REQUEST = 100;
const MEMBERS_PER_REQUEST = 200;
/** TDLib answers 404 to a request for more chats once it has loaded them all. */
const ALL_LOADED = 404;
/** More chats than an account has. TDLib takes the count as a 32-bit number, so it cannot be arbitrarily large. */
const EVERY_CHAT = 1_000_000;

/** Telegram answers 429 when requests come too fast, and names the seconds to wait before the next one. */
const TOO_FAST = 429;
const LONGEST_WAIT_S = 60;
const WAITS_PER_REQUEST = 3;

/** Sends a request, and again after the wait Telegram names when it says the requests come too fast. */
async function patiently<T>(request: () => Promise<T>): Promise<T> {
  for (let waits = 0; ; waits++) {
    try {
      return await request();
    } catch (error) {
      const named =
        error instanceof TelegramError && error.code === TOO_FAST ? /retry after (\d+)/.exec(error.message) : null;
      const seconds = named ? Number(named[1]) : null;
      if (seconds === null || seconds > LONGEST_WAIT_S || waits >= WAITS_PER_REQUEST) throw error;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 250));
    }
  }
}

const MAIN_LIST = { _: 'chatListMain' } as const;

export function peopleOf(client: Pick<TelegramClient, 'invoke'>): PeopleSource {
  const invoke = ((query: never) => patiently(() => untilNotRestarted(() => client.invoke(query)))) as Td.Invoke;

  /** The IDs of all chats in the main list, in its order. */
  async function chatIds(): Promise<number[]> {
    for (;;) {
      try {
        await invoke({ _: 'loadChats', chat_list: MAIN_LIST, limit: CHATS_PER_REQUEST });
      } catch (error) {
        if (error instanceof TelegramError && error.code === ALL_LOADED) break;
        throw error;
      }
    }
    return (await invoke({ _: 'getChats', chat_list: MAIN_LIST, limit: EVERY_CHAT })).chat_ids;
  }

  /** The members of a group that are accounts of people: no bots, no deleted accounts, no channels writing as members. */
  const userIdsOf = (members: readonly Td.chatMember[]) =>
    members.flatMap((member) => (member.member_id._ === 'messageSenderUser' ? [member.member_id.user_id] : []));

  /** The user IDs of a group's members, or null when the group is too large or does not show its members. */
  async function memberIds(type: Td.chatTypeBasicGroup | Td.chatTypeSupergroup): Promise<number[] | null> {
    if (type._ === 'chatTypeBasicGroup') {
      return userIdsOf((await invoke({ _: 'getBasicGroupFullInfo', basic_group_id: type.basic_group_id })).members);
    }
    const info = await invoke({ _: 'getSupergroupFullInfo', supergroup_id: type.supergroup_id });
    if (!info.can_get_members || info.member_count > GROUP_SIZE_LIMIT) return null;
    const ids: number[] = [];
    for (let offset = 0; offset < info.member_count; offset += MEMBERS_PER_REQUEST) {
      const page = await invoke({
        _: 'getSupergroupMembers',
        supergroup_id: type.supergroup_id,
        filter: { _: 'supergroupMembersFilterRecent' },
        offset,
        limit: MEMBERS_PER_REQUEST,
      });
      ids.push(...userIdsOf(page.members));
      if (page.members.length === 0) break;
    }
    return ids;
  }

  return {
    async readPeople(onProgress) {
      const self = (await invoke({ _: 'getMe' })).id;
      const people = new Map<number, Person>();
      /** Notes the person behind `userId` and says whether it is one: not the user, a bot or a deleted account. */
      const isPerson = async (userId: number): Promise<boolean> => {
        if (userId === self) return false;
        if (people.has(userId)) return true;
        const user = await invoke({ _: 'getUser', user_id: userId });
        if (user.type._ !== 'userTypeRegular') return false;
        people.set(userId, {
          userId,
          givenName: user.first_name,
          familyName: user.last_name,
          phoneNumber: user.phone_number ? `+${user.phone_number}` : null,
        });
        return true;
      };

      const ids = await chatIds();
      const chats: ChatEntry[] = [];
      for (const [index, chatId] of ids.entries()) {
        onProgress(index, ids.length);
        const chat = await invoke({ _: 'getChat', chat_id: chatId });
        const type = chat.type;
        if (type._ === 'chatTypePrivate') {
          if (await isPerson(type.user_id)) chats.push({ kind: 'person', userId: type.user_id });
        } else if (type._ === 'chatTypeBasicGroup' || (type._ === 'chatTypeSupergroup' && !type.is_channel)) {
          // A group whose members Telegram refuses to give is passed over, and the rest is still read.
          const members = await memberIds(type).catch((error: unknown) => {
            if (error instanceof TelegramError && error.code !== TOO_FAST) return null;
            throw error;
          });
          if (!members) continue;
          const present: number[] = [];
          for (const userId of members) if (await isPerson(userId)) present.push(userId);
          if (present.length > 0)
            chats.push({
              kind: 'group',
              chatId,
              title: chat.title,
              memberIds: present,
              memberCount: present.length,
            });
        }
      }
      onProgress(ids.length, ids.length);
      return { chats, people };
    },
  };
}
