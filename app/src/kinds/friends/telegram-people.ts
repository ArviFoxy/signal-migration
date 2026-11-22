// The people of a Telegram account: everyone the user has a one-to-one chat with, the members of the user's groups,
// and the user's contact list. Telegram has no list of friends, so these are the people a user can mean.

import type * as Td from 'tdlib-types';
import {
  fileRef,
  type TelegramClient,
  TelegramError,
  type TelegramFileRef,
  TelegramRestartedError,
  untilNotRestarted,
} from '../../telegram/client';
import { patiently, TOO_FAST } from '../../telegram/patiently';

export type Person = {
  userId: number;
  /** The names as Telegram shows them to the user; the family name can be empty. */
  givenName: string;
  familyName: string;
  /** A plus sign and digits, when Telegram shows the user this person's phone number. */
  phoneNumber: string | null;
  /** Run-tagged reference to the small profile picture, when there is one. */
  photo?: TelegramFileRef;
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
      /** Run-tagged reference to the group's small picture, when there is one. */
      photo?: TelegramFileRef;
      /** A very small and blurred copy of the picture, as base64 of a JPEG file. */
      photoPreview?: string;
    };

export type TelegramPeople = {
  /** In the order of the user's chat list. */
  chats: ChatEntry[];
  /** The people of the user's Telegram contact list: those the user saved, with or without a chat. */
  contactIds: number[];
  people: Map<number, Person>;
};

/**
 * The largest group whose members are read. A larger group is left out of the list as a group; its members still
 * appear when the user has a one-to-one chat with them or shares a smaller group with them.
 */
export const GROUP_SIZE_LIMIT = 1000;

/** How far the reading is. Only groups are counted: one-to-one chats and the contact list take no time to read. */
export type ReadingProgress = {
  /** How many groups are read to the end, of `groups` in all. */
  groupsRead: number;
  groups: number;
  /**
   * The part of the groups that is read, from 0 to 1. A group being read counts with the part of its members that
   * has arrived, so this moves with every answer from Telegram.
   */
  share: number;
  /** How many people are read so far, each counted once. */
  people: number;
  /** The seconds the rest should take, once enough is read to estimate that. */
  secondsLeft: number | null;
};

/** Where the people come from: the user's account in the app, simulated data in tests. */
export interface PeopleSource {
  readPeople(onProgress: (progress: ReadingProgress) => void): Promise<TelegramPeople>;
  /** The bytes of a picture, by the run-tagged reference a person or a group carries. */
  readPhoto(photo: TelegramFileRef): Promise<Uint8Array>;
}

/** How many chats Telegram is asked to load, and how many members of a large group it gives, in one request. */
const CHATS_PER_REQUEST = 100;
const MEMBERS_PER_REQUEST = 200;
/** TDLib answers 404 to a request for more chats once it has loaded them all. */
const ALL_LOADED = 404;
/** More chats than an account has. TDLib takes the count as a 32-bit number, so it cannot be arbitrarily large. */
const EVERY_CHAT = 1_000_000;

/** How many groups are read at the same time. */
const GROUPS_AT_ONCE = 3;
/** The time left is estimated once this many groups are read and this many seconds have passed. */
const GROUPS_BEFORE_ESTIMATE = 5;
const SECONDS_BEFORE_ESTIMATE = 5;

const MAIN_LIST = { _: 'chatListMain' } as const;

/**
 * The people of the account behind `client`. `now` is the clock, in milliseconds, by which the time left is
 * estimated.
 */
export function peopleOf(
  client: Pick<TelegramClient, 'invoke' | 'run' | 'readFileRef'>,
  now: () => number = () => performance.now(),
): PeopleSource {
  const rawInvoke = ((query: { _: string }) => patiently(() => client.invoke(query as never))) as Td.Invoke;
  const invoke = ((query: { _: string }) =>
    patiently(() => untilNotRestarted(() => client.invoke(query as never)))) as Td.Invoke;

  let chatsLoadedInRun = -1;
  let loadingChats: { run: number; promise: Promise<void> } | null = null;

  /**
   * With `use_chat_info_database: false`, each fresh TDLib run starts with an empty chat list in memory. Loading
   * chats once per run lets `getChats`, `getChat`, and `getSupergroup` survive a mid-read TDLib restart.
   */
  const ensureChatsLoaded = (): Promise<void> => {
    const run = client.run;
    if (chatsLoadedInRun === run) return Promise.resolve();
    if (loadingChats?.run === run) return loadingChats.promise;
    const promise = (async () => {
      for (;;) {
        try {
          await rawInvoke({ _: 'loadChats', chat_list: MAIN_LIST, limit: CHATS_PER_REQUEST });
        } catch (error) {
          if (error instanceof TelegramError && error.code === ALL_LOADED) break;
          throw error;
        }
        if (client.run !== run) throw new TelegramRestartedError();
      }
      if (client.run !== run) throw new TelegramRestartedError();
      chatsLoadedInRun = run;
    })();
    loadingChats = { run, promise };
    const clear = () => {
      if (loadingChats?.promise === promise) loadingChats = null;
    };
    promise.then(clear, clear);
    return promise;
  };

  /** Runs an operation that requires the chat list to be loaded in the current TDLib run. */
  const withChats = <T>(operation: () => Promise<T>): Promise<T> =>
    patiently(() =>
      untilNotRestarted(async () => {
        await ensureChatsLoaded();
        return operation();
      }),
    );

  /** The IDs of all chats in the main list, in its order. */
  function chatIds(): Promise<number[]> {
    return withChats(
      async () => (await rawInvoke({ _: 'getChats', chat_list: MAIN_LIST, limit: EVERY_CHAT })).chat_ids,
    );
  }

  /** The members of a group that are accounts of people: no bots, no deleted accounts, no channels writing as members. */
  const userIdsOf = (members: readonly Td.chatMember[]) =>
    members.flatMap((member) => (member.member_id._ === 'messageSenderUser' ? [member.member_id.user_id] : []));

  /**
   * Reads the members of a group. Each answer from Telegram is handed to `take`: the user IDs in it, and the part
   * of the group, from 0 to 1, that has arrived with it. Nothing is handed over for a group above the size limit.
   * Telegram refuses the request for a group that does not show its members.
   */
  async function readMembers(
    type: Td.chatTypeBasicGroup | Td.chatTypeSupergroup,
    take: (userIds: number[], part: number) => Promise<void>,
  ): Promise<void> {
    if (type._ === 'chatTypeBasicGroup') {
      const info = await withChats(() =>
        rawInvoke({ _: 'getBasicGroupFullInfo', basic_group_id: type.basic_group_id }),
      );
      return take(userIdsOf(info.members), 1);
    }
    // What TDLib already knows of the group answers without a request to Telegram's servers. The size is 0 there
    // when TDLib does not know it.
    const known = await withChats(() => rawInvoke({ _: 'getSupergroup', supergroup_id: type.supergroup_id }));
    if (known.member_count > GROUP_SIZE_LIMIT) return;
    // Every answer names the size of the group, so the first one says whether the group is read at all.
    for (let offset = 0; ; offset += MEMBERS_PER_REQUEST) {
      const page = await withChats(() =>
        rawInvoke({
          _: 'getSupergroupMembers',
          supergroup_id: type.supergroup_id,
          filter: { _: 'supergroupMembersFilterRecent' },
          offset,
          limit: MEMBERS_PER_REQUEST,
        }),
      );
      if (page.total_count > GROUP_SIZE_LIMIT) return;
      const arrived = offset + MEMBERS_PER_REQUEST;
      const last = page.members.length === 0 || arrived >= page.total_count;
      await take(userIdsOf(page.members), last ? 1 : arrived / page.total_count);
      if (last) return;
    }
  }

  return {
    readPhoto: (photo) => patiently(() => client.readFileRef(photo)),
    async readPeople(onProgress) {
      const self = (await invoke({ _: 'getMe' })).id;
      const people = new Map<number, Person>();
      /** Notes the person behind `userId` and says whether it is one: not the user, a bot or a deleted account. */
      const isPerson = async (userId: number): Promise<boolean> => {
        if (userId === self) return false;
        if (people.has(userId)) return true;
        // The library answers from the records that came with the chats and the member lists. An account it holds
        // no record of is passed over.
        let run = 0;
        const user = await patiently(() =>
          untilNotRestarted(async () => {
            const before = client.run;
            const found = await rawInvoke({ _: 'getUser', user_id: userId });
            run = client.run === before ? before : 0;
            return found;
          }),
        ).catch((error: unknown) => {
          if (error instanceof TelegramError && error.code !== TOO_FAST) return null;
          throw error;
        });
        if (!user || user.type._ !== 'userTypeRegular') return false;
        people.set(userId, {
          userId,
          givenName: user.first_name,
          familyName: user.last_name,
          phoneNumber: user.phone_number ? `+${user.phone_number}` : null,
          ...(user.profile_photo ? { photo: fileRef(user.profile_photo.small, run) } : {}),
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
        photo: TelegramFileRef | undefined;
        photoPreview: string | undefined;
      }[] = [];
      for (const [index, chatId] of ids.entries()) {
        let run = 0;
        const chat = await withChats(async () => {
          const before = client.run;
          const result = await rawInvoke({ _: 'getChat', chat_id: chatId });
          run = client.run === before ? before : 0;
          return result;
        });
        const type = chat.type;
        if (type._ === 'chatTypePrivate') {
          if (await isPerson(type.user_id)) entries[index] = { kind: 'person', userId: type.user_id };
        } else if (type._ === 'chatTypeBasicGroup' || (type._ === 'chatTypeSupergroup' && !type.is_channel)) {
          groups.push({
            index,
            chatId,
            title: chat.title,
            type,
            photo: chat.photo ? fileRef(chat.photo.small, run) : undefined,
            photoPreview: chat.photo?.minithumbnail?.data,
          });
        }
      }
      // The contact list comes in one request, with the records of the people on it.
      const contactIds: number[] = [];
      for (const userId of (await invoke({ _: 'getContacts' })).user_ids)
        if (await isPerson(userId)) contactIds.push(userId);

      // Then the groups, whose members Telegram's servers are asked for: a few groups at a time.
      const groupsStarted = now();
      let groupsRead = 0;
      /** Of each group being read, the part of its members that has arrived. */
      const partsArrived = new Map<number, number>();
      const tell = () => {
        let arrived = groupsRead;
        for (const part of partsArrived.values()) arrived += part;
        const seconds = (now() - groupsStarted) / 1000;
        const estimable = groupsRead >= GROUPS_BEFORE_ESTIMATE && seconds >= SECONDS_BEFORE_ESTIMATE;
        onProgress({
          groupsRead,
          groups: groups.length,
          share: groups.length > 0 ? arrived / groups.length : 1,
          people: people.size,
          secondsLeft: estimable ? Math.round((seconds / arrived) * (groups.length - arrived)) : null,
        });
      };
      tell();
      const readGroup = async (group: (typeof groups)[number]) => {
        const present: number[] = [];
        // A group whose members Telegram refuses to give is passed over, and the rest is still read. What arrived
        // of a group before a refusal is kept.
        await readMembers(group.type, async (userIds, part) => {
          for (const userId of userIds) if (await isPerson(userId)) present.push(userId);
          if (part < 1) {
            partsArrived.set(group.chatId, part);
            tell();
          }
        }).catch((error: unknown) => {
          if (error instanceof TelegramError && error.code !== TOO_FAST) return;
          throw error;
        });
        if (present.length > 0)
          entries[group.index] = {
            kind: 'group',
            chatId: group.chatId,
            title: group.title,
            memberIds: present,
            memberCount: present.length,
            ...(group.photo === undefined ? {} : { photo: group.photo }),
            ...(group.photoPreview === undefined ? {} : { photoPreview: group.photoPreview }),
          };
        partsArrived.delete(group.chatId);
        groupsRead++;
        tell();
      };
      const waiting = [...groups];
      await Promise.all(
        Array.from({ length: GROUPS_AT_ONCE }, async () => {
          for (let group = waiting.shift(); group; group = waiting.shift()) await readGroup(group);
        }),
      );

      return { chats: entries.filter((entry) => entry !== null), people, contactIds };
    },
  };
}
