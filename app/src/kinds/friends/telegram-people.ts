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
  readPeople(onProgress: (progress: ReadingProgress) => void, cancel?: AbortSignal): Promise<TelegramPeople>;
  /** The bytes of a picture, by the run-tagged reference a person or a group carries. */
  readPhoto(photo: TelegramFileRef, cancel?: AbortSignal): Promise<Uint8Array>;
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
const E164_DIGITS = /^[1-9]\d{4,14}$/;

/** Normalizes a TDLib `user.phone_number` string into strict E.164 (`+<digits>`), or null if invalid/empty. */
function normalizeTelegramPhone(raw: string): string | null {
  const digits = raw.trim().replace(/^\+/, '');
  return E164_DIGITS.test(digits) ? `+${digits}` : null;
}

/**
 * The people of the account behind `client`. `now` is the clock, in milliseconds, by which the time left is
 * estimated.
 */
export function peopleOf(
  client: Pick<TelegramClient, 'invoke' | 'run' | 'readFileRef'> & Partial<Pick<TelegramClient, 'invokeInRun'>>,
  now: () => number = () => performance.now(),
): PeopleSource {
  // Single raw invoke without nested patiently(): outer loops own flood-wait retries so 429s never multiply.
  const rawInvoke = ((query: { _: string }) => client.invoke(query as never)) as Td.Invoke;
  const invokeInRun = async <T extends Td.$FunctionName>(
    run: number,
    query: { readonly _: T } & Td.$FunctionInputByName[T],
  ): Promise<Td.$FunctionResultByName[T]> => {
    if (client.invokeInRun) return client.invokeInRun(run, query as never) as Promise<Td.$FunctionResultByName[T]>;
    if (client.run !== run) throw new TelegramRestartedError();
    const result = (await client.invoke(query as never)) as Td.$FunctionResultByName[T];
    if (client.run !== run) throw new TelegramRestartedError();
    return result;
  };

  let chatsLoadedInRun = -1;
  let loadingChats: { run: number; promise: Promise<void> } | null = null;

  /**
   * With `use_chat_info_database: false`, each fresh TDLib run starts with an empty chat list in memory. Loading
   * chats once per run lets `getChats`, `getChat`, and `getSupergroup` survive a mid-read TDLib restart.
   */
  const ensureChatsLoaded = (cancel?: AbortSignal): Promise<number> => {
    const run = client.run;
    if (chatsLoadedInRun === run) return Promise.resolve(run);
    if (loadingChats?.run === run) return loadingChats.promise.then(() => run);
    const promise = (async () => {
      for (;;) {
        cancel?.throwIfAborted();
        try {
          await invokeInRun(run, { _: 'loadChats', chat_list: MAIN_LIST, limit: CHATS_PER_REQUEST });
        } catch (error) {
          if (error instanceof TelegramError && error.code === ALL_LOADED) break;
          throw error;
        }
      }
      if (client.run !== run) throw new TelegramRestartedError();
      chatsLoadedInRun = run;
    })();
    loadingChats = { run, promise };
    const clear = () => {
      if (loadingChats?.promise === promise) loadingChats = null;
    };
    promise.then(clear, clear);
    return promise.then(() => run);
  };

  /** Runs an operation that requires the chat list to be loaded in the current TDLib run. */
  const withChats = <T>(operation: (run: number) => Promise<T>, cancel?: AbortSignal): Promise<T> =>
    patiently(
      () =>
        untilNotRestarted(async () => {
          cancel?.throwIfAborted();
          const run = await ensureChatsLoaded(cancel);
          return operation(run);
        }),
      cancel,
    );

  /** The IDs of all chats in the main list, in its order. */
  function chatIds(cancel?: AbortSignal): Promise<number[]> {
    return withChats(
      async (run) => (await invokeInRun(run, { _: 'getChats', chat_list: MAIN_LIST, limit: EVERY_CHAT })).chat_ids,
      cancel,
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
    take: (userIds: number[], part: number, run: number) => Promise<void>,
    cancel?: AbortSignal,
  ): Promise<void> {
    if (type._ === 'chatTypeBasicGroup') {
      await withChats(async (run) => {
        const info = await invokeInRun(run, { _: 'getBasicGroupFullInfo', basic_group_id: type.basic_group_id });
        await take(userIdsOf(info.members), 1, run);
      }, cancel);
      return;
    }
    // What TDLib already knows of the group answers without a request to Telegram's servers. The size is 0 there
    // when TDLib does not know it.
    const known = await withChats(
      (run) => invokeInRun(run, { _: 'getSupergroup', supergroup_id: type.supergroup_id }),
      cancel,
    );
    if (known.member_count > GROUP_SIZE_LIMIT) return;
    // Every answer names the size of the group, so the first one says whether the group is read at all.
    for (let offset = 0; ; offset += MEMBERS_PER_REQUEST) {
      cancel?.throwIfAborted();
      const stop = await withChats(async (run) => {
        const page = await invokeInRun(run, {
          _: 'getSupergroupMembers',
          supergroup_id: type.supergroup_id,
          filter: { _: 'supergroupMembersFilterRecent' },
          offset,
          limit: MEMBERS_PER_REQUEST,
        });
        if (page.total_count > GROUP_SIZE_LIMIT) return true;
        const arrived = offset + MEMBERS_PER_REQUEST;
        const last = page.members.length === 0 || arrived >= page.total_count;
        await take(userIdsOf(page.members), last ? 1 : arrived / page.total_count, run);
        return last;
      }, cancel);
      if (stop) return;
    }
  }

  return {
    readPhoto: (photo, cancel) => patiently(() => client.readFileRef(photo, cancel), cancel),
    async readPeople(onProgress, cancel) {
      cancel?.throwIfAborted();
      const invoke = ((query: { _: string }) =>
        patiently(() => untilNotRestarted(() => rawInvoke(query as never)), cancel)) as Td.Invoke;
      const self = (await invoke({ _: 'getMe' })).id;
      const people = new Map<number, Person>();
      /**
       * Notes the person behind `userId` in `run` and says whether it is one: not the user, a bot or a deleted
       * account. Throws `TelegramRestartedError` if TDLib restarted out of `run`, so the caller reloads that run's
       * context (chats / contacts / group page) instead of silently dropping users with 400 User not found.
       */
      const isPersonInRun = async (userId: number, run: number): Promise<boolean> => {
        if (userId === self) return false;
        if (people.has(userId)) return true;
        cancel?.throwIfAborted();
        const user = await invokeInRun(run, { _: 'getUser', user_id: userId }).catch((error: unknown) => {
          if (error instanceof TelegramError && error.code !== TOO_FAST) {
            if (client.run !== run) throw new TelegramRestartedError();
            return null;
          }
          throw error;
        });
        if (!user || user.type._ !== 'userTypeRegular') return false;
        people.set(userId, {
          userId,
          givenName: user.first_name,
          familyName: user.last_name,
          phoneNumber: normalizeTelegramPhone(user.phone_number),
          ...(user.profile_photo ? { photo: fileRef(user.profile_photo.small, run) } : {}),
          ...(user.profile_photo?.minithumbnail ? { photoPreview: user.profile_photo.minithumbnail.data } : {}),
        });
        return true;
      };

      // First what TDLib answers by itself: which chats are one-to-one chats and which are groups.
      const ids = await chatIds(cancel);
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
        cancel?.throwIfAborted();
        const chatEntry = await withChats(async (run) => {
          const chat = await invokeInRun(run, { _: 'getChat', chat_id: chatId });
          const type = chat.type;
          if (type._ === 'chatTypePrivate') {
            return (await isPersonInRun(type.user_id, run))
              ? ({ kind: 'person' as const, userId: type.user_id } satisfies ChatEntry)
              : null;
          }
          if (type._ === 'chatTypeBasicGroup' || (type._ === 'chatTypeSupergroup' && !type.is_channel)) {
            return {
              kind: 'group-pending' as const,
              index,
              chatId,
              title: chat.title,
              type,
              photo: chat.photo ? fileRef(chat.photo.small, run) : undefined,
              photoPreview: chat.photo?.minithumbnail?.data,
            };
          }
          return null;
        }, cancel);
        if (!chatEntry) continue;
        if (chatEntry.kind === 'person') {
          entries[index] = chatEntry;
        } else {
          const { kind: _kind, ...group } = chatEntry;
          groups.push(group);
        }
      }
      // The contact list comes in one request, with the records of the people on it.
      const contactIds = await patiently(
        () =>
          untilNotRestarted(async () => {
            cancel?.throwIfAborted();
            const run = client.run;
            const contacts = await invokeInRun(run, { _: 'getContacts' });
            const resolved: number[] = [];
            for (const userId of contacts.user_ids) {
              if (await isPersonInRun(userId, run)) resolved.push(userId);
            }
            return resolved;
          }),
        cancel,
      );

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
        const seen = new Set<number>();
        // A group whose members Telegram refuses to give is passed over, and the rest is still read. What arrived
        // of a group before a refusal is kept.
        await readMembers(
          group.type,
          async (userIds, part, run) => {
            for (const userId of userIds) {
              if (seen.has(userId)) continue;
              if (await isPersonInRun(userId, run)) {
                seen.add(userId);
                present.push(userId);
              }
            }
            if (part < 1) {
              partsArrived.set(group.chatId, part);
              tell();
            }
          },
          cancel,
        ).catch((error: unknown) => {
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
          for (let group = waiting.shift(); group; group = waiting.shift()) {
            cancel?.throwIfAborted();
            await readGroup(group);
          }
        }),
      );

      return { chats: entries.filter((entry) => entry !== null), people, contactIds };
    },
  };
}
