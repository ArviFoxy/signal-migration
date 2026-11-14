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
  /** The number of the small profile picture among the files of Telegram's library, when there is a picture. */
  photoFileId?: number;
  /** A very small and blurred copy of the picture, as base64 of a JPEG file, which Telegram sends along with the person. */
  photoPreview?: string;
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
      /** The number of the group's small picture among the files of Telegram's library, when there is one. */
      photoFileId?: number;
      /** A very small and blurred copy of the picture, as base64 of a JPEG file. */
      photoPreview?: string;
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
  /**
   * `onProgress` gets how many of the groups are read, and how many seconds the rest should take once enough is read
   * to estimate that. Only groups are counted: one-to-one chats take no time to read.
   */
  readPeople(onProgress: (done: number, total: number, secondsLeft: number | null) => void): Promise<TelegramPeople>;
  /** The bytes of a picture, by the file number a person or a group carries. */
  readPhoto(fileId: number): Promise<Uint8Array>;
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

/** How many groups are read at the same time. */
const GROUPS_AT_ONCE = 3;
/** The time left is estimated once this many groups are read and this many seconds have passed. */
const GROUPS_BEFORE_ESTIMATE = 5;
const SECONDS_BEFORE_ESTIMATE = 5;

/**
 * Sends a request, and again after the wait Telegram names when it says the requests come too fast; `onWait` hears
 * of each wait.
 */
async function patiently<T>(request: () => Promise<T>, onWait: () => void): Promise<T> {
  for (let waits = 0; ; waits++) {
    try {
      return await request();
    } catch (error) {
      const named =
        error instanceof TelegramError && error.code === TOO_FAST ? /retry after (\d+)/.exec(error.message) : null;
      const seconds = named ? Number(named[1]) : null;
      if (seconds === null || seconds > LONGEST_WAIT_S || waits >= WAITS_PER_REQUEST) throw error;
      onWait();
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 250));
    }
  }
}

const MAIN_LIST = { _: 'chatListMain' } as const;

/**
 * The people of the account behind `client`. `report` gets one line when the reading is done, saying how long each
 * kind of request took in all; `now` is the clock, in milliseconds.
 */
export function peopleOf(
  client: Pick<TelegramClient, 'invoke' | 'readFile'>,
  report: (line: string) => void = () => undefined,
  now: () => number = () => performance.now(),
): PeopleSource {
  const spent = new Map<string, { count: number; ms: number }>();
  let waits = 0;
  const invoke = (async (query: { _: string }) => {
    const started = now();
    try {
      return await patiently(
        () => untilNotRestarted(() => client.invoke(query as never)),
        () => waits++,
      );
    } finally {
      const kind = spent.get(query._) ?? { count: 0, ms: 0 };
      spent.set(query._, { count: kind.count + 1, ms: kind.ms + now() - started });
    }
  }) as Td.Invoke;

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
    // What TDLib already knows of the group answers without a request to Telegram's servers. The size is 0 there
    // when TDLib does not know it.
    const known = await invoke({ _: 'getSupergroup', supergroup_id: type.supergroup_id });
    if (known.member_count > GROUP_SIZE_LIMIT) return null;
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
    readPhoto: (fileId) => client.readFile(fileId),
    async readPeople(onProgress) {
      const started = now();
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
          ...(user.profile_photo ? { photoFileId: user.profile_photo.small.id } : {}),
          ...(user.profile_photo?.minithumbnail ? { photoPreview: user.profile_photo.minithumbnail.data } : {}),
        });
        return true;
      };

      // First what TDLib answers by itself: which chats are one-to-one chats and which are groups.
      const ids = await chatIds();
      const entries: (ChatEntry | null)[] = ids.map(() => null);
      const groups: {
        index: number;
        chatId: number;
        title: string;
        type: Td.chatTypeBasicGroup | Td.chatTypeSupergroup;
        photoFileId: number | undefined;
        photoPreview: string | undefined;
      }[] = [];
      for (const [index, chatId] of ids.entries()) {
        const chat = await invoke({ _: 'getChat', chat_id: chatId });
        const type = chat.type;
        if (type._ === 'chatTypePrivate') {
          if (await isPerson(type.user_id)) entries[index] = { kind: 'person', userId: type.user_id };
        } else if (type._ === 'chatTypeBasicGroup' || (type._ === 'chatTypeSupergroup' && !type.is_channel)) {
          groups.push({
            index,
            chatId,
            title: chat.title,
            type,
            photoFileId: chat.photo?.small.id,
            photoPreview: chat.photo?.minithumbnail?.data,
          });
        }
      }
      onProgress(0, groups.length, null);

      // Then the groups, whose members Telegram's servers are asked for: a few groups at a time.
      const groupsStarted = now();
      let groupsRead = 0;
      const readGroup = async (group: (typeof groups)[number]) => {
        // A group whose members Telegram refuses to give is passed over, and the rest is still read.
        const members = await memberIds(group.type).catch((error: unknown) => {
          if (error instanceof TelegramError && error.code !== TOO_FAST) return null;
          throw error;
        });
        const present: number[] = [];
        for (const userId of members ?? []) if (await isPerson(userId)) present.push(userId);
        if (present.length > 0)
          entries[group.index] = {
            kind: 'group',
            chatId: group.chatId,
            title: group.title,
            memberIds: present,
            memberCount: present.length,
            ...(group.photoFileId === undefined ? {} : { photoFileId: group.photoFileId }),
            ...(group.photoPreview === undefined ? {} : { photoPreview: group.photoPreview }),
          };
        groupsRead++;
        const seconds = (now() - groupsStarted) / 1000;
        const estimable = groupsRead >= GROUPS_BEFORE_ESTIMATE && seconds >= SECONDS_BEFORE_ESTIMATE;
        const secondsLeft = estimable ? Math.round((seconds / groupsRead) * (groups.length - groupsRead)) : null;
        onProgress(groupsRead, groups.length, secondsLeft);
      };
      const waiting = [...groups];
      await Promise.all(
        Array.from({ length: GROUPS_AT_ONCE }, async () => {
          for (let group = waiting.shift(); group; group = waiting.shift()) await readGroup(group);
        }),
      );

      const requests = [...spent]
        .map(([kind, { count, ms }]) => `${kind} ${count} times in ${(ms / 1000).toFixed(1)} s`)
        .join(', ');
      report(
        `Reading the people from Telegram took ${((now() - started) / 1000).toFixed(1)} s for ${ids.length} chats, ` +
          `${groups.length} of them groups. Requests: ${requests}. ` +
          `Waited ${waits} times because Telegram said the requests came too fast.`,
      );
      return { chats: entries.filter((entry) => entry !== null), people };
    },
  };
}
