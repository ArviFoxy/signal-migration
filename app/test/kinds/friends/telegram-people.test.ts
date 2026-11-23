// Reading the people of a Telegram account from TDLib's answers: who counts as a person, which groups are read, and
// the order of the chat list.

import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';
import { GROUP_SIZE_LIMIT, peopleOf, type ReadingProgress } from '../../../src/kinds/friends/telegram-people';
import { TelegramError, type TelegramFileRef, TelegramRestartedError } from '../../../src/telegram/client';

type UserKind = 'userTypeRegular' | 'userTypeBot' | 'userTypeDeleted';
type FakeUser = { name: [string, string]; phone?: string; kind?: UserKind; photo?: number };
type FakeChat =
  | { private: number }
  | { basicGroup: string; members: number[] }
  | {
      supergroup: string;
      members: number[];
      /** The size Telegram names, when it is not the number of members listed here. */
      memberCount?: number;
      hidden?: boolean;
      refused?: boolean;
      /** The size TDLib knows without asking Telegram's servers. */
      knownSize?: number;
    }
  | { channel: string };

const SELF = 1;

/** A Telegram account with these users and this chat list, answering the requests the reader sends. */
function account(
  users: Record<number, FakeUser>,
  chats: FakeChat[],
  options: { tooFastOnce?: boolean; now?: () => number; contacts?: number[]; restartOnGetChat?: number } = {},
) {
  const requests: string[] = [];
  let run = 1;
  let loaded = 0;
  let getChatsSeen = 0;
  let restarted = false;
  const member = (userId: number) => ({ member_id: { _: 'messageSenderUser', user_id: userId } });
  const chatAt = (chatId: number) => chats[chatId - 100]!;
  let tooFast = options.tooFastOnce ?? false;
  const invoke = (async (query: { _: string } & Record<string, unknown>) => {
    requests.push(query._);
    // TDLib takes counts as 32-bit numbers and refuses a request with a larger one.
    for (const count of [query.limit, query.offset])
      if (typeof count === 'number' && count > 2 ** 31 - 1) throw new Error(`${query._}: ${count} is no 32-bit number`);
    switch (query._) {
      case 'getMe':
        return { id: SELF };
      case 'getContacts':
        return { user_ids: options.contacts ?? [] };
      case 'loadChats': {
        // TDLib loads the list piece by piece and answers 404 once nothing is left.
        if (loaded >= chats.length) throw new TelegramError(404, 'Not Found');
        loaded = Math.min(chats.length, loaded + 2);
        return { _: 'ok' };
      }
      case 'getChats':
        return { chat_ids: chats.slice(0, loaded).map((_, index) => 100 + index) };
      case 'getChat': {
        if (options.restartOnGetChat !== undefined && !restarted && getChatsSeen === options.restartOnGetChat) {
          restarted = true;
          run++;
          loaded = 0;
          throw new TelegramRestartedError();
        }
        if (loaded < chats.length) throw new TelegramError(400, 'Chat not found');
        getChatsSeen++;
        const chat = chatAt(query.chat_id as number);
        if ('private' in chat) return { title: '', type: { _: 'chatTypePrivate', user_id: chat.private } };
        if ('basicGroup' in chat) {
          return { title: chat.basicGroup, type: { _: 'chatTypeBasicGroup', basic_group_id: query.chat_id } };
        }
        const title = 'supergroup' in chat ? chat.supergroup : chat.channel;
        return {
          title,
          type: { _: 'chatTypeSupergroup', supergroup_id: query.chat_id, is_channel: 'channel' in chat },
        };
      }
      case 'getUser': {
        const user = users[query.user_id as number];
        if (!user) throw new TelegramError(400, 'User not found');
        return {
          first_name: user.name[0],
          last_name: user.name[1],
          phone_number: user.phone ?? '',
          type: { _: user.kind ?? 'userTypeRegular' },
          ...(user.photo
            ? {
                profile_photo: {
                  small: { id: user.photo, remote: { id: `remote-${user.photo}` } },
                  minithumbnail: { data: 'cHJldmlldw==' },
                },
              }
            : {}),
        };
      }
      case 'getBasicGroupFullInfo': {
        const chat = chatAt(query.basic_group_id as number) as Extract<FakeChat, { basicGroup: string }>;
        return { members: chat.members.map(member) };
      }
      case 'getSupergroup': {
        const chat = chatAt(query.supergroup_id as number) as Extract<FakeChat, { supergroup: string }>;
        return { member_count: chat.knownSize ?? 0 };
      }
      case 'getSupergroupMembers': {
        const chat = chatAt(query.supergroup_id as number) as Extract<FakeChat, { supergroup: string }>;
        if (chat.refused) throw new TelegramError(400, 'CHANNEL_PRIVATE');
        // Telegram refuses the member list of a group that hides its members.
        if (chat.hidden) throw new TelegramError(400, 'CHAT_ADMIN_REQUIRED');
        if (tooFast) {
          tooFast = false;
          throw new TelegramError(429, 'Too Many Requests: retry after 0');
        }
        const offset = query.offset as number;
        return {
          total_count: chat.memberCount ?? chat.members.length,
          members: chat.members.slice(offset, offset + (query.limit as number)).map(member),
        };
      }
      default:
        throw new Error(`unexpected request ${query._}`);
    }
  }) as unknown as Td.Invoke;
  const readFileRef = (photo: TelegramFileRef) => Promise.resolve(Uint8Array.of(photo.fileId));
  return {
    source: peopleOf(
      {
        invoke,
        get run() {
          return run;
        },
        readFileRef,
      },
      options.now,
    ),
    requests,
  };
}

const USERS: Record<number, FakeUser> = {
  [SELF]: { name: ['The', 'User'], phone: '12025550100' },
  2: { name: ['Mara', 'Lindqvist'], phone: '12025550102' },
  3: { name: ['Jonas', ''] },
  4: { name: ['Helper', 'Bot'], kind: 'userTypeBot' },
  5: { name: ['', ''], kind: 'userTypeDeleted' },
  6: { name: ['Aiko', 'Tanaka'], phone: '447700900106' },
};

describe('the people of a Telegram account', () => {
  it('lists one-to-one chats and groups in the order of the chat list', async () => {
    const { source } = account(USERS, [
      { basicGroup: 'Flat 12', members: [SELF, 3, 6] },
      { private: 2 },
      { supergroup: 'Hiking crew', members: [2, SELF, 6] },
      { private: 3 },
    ]);
    const { chats } = await source.readPeople(() => undefined);
    expect(chats).toEqual([
      { kind: 'group', chatId: 100, title: 'Flat 12', memberIds: [3, 6], memberCount: 2 },
      { kind: 'person', userId: 2 },
      { kind: 'group', chatId: 102, title: 'Hiking crew', memberIds: [2, 6], memberCount: 2 },
      { kind: 'person', userId: 3 },
    ]);
  });

  it('gives a phone number only where Telegram shows one, with its plus sign', async () => {
    const { source } = account(USERS, [{ private: 2 }, { private: 3 }]);
    const { people } = await source.readPeople(() => undefined);
    expect(people.get(2)).toEqual({
      userId: 2,
      givenName: 'Mara',
      familyName: 'Lindqvist',
      phoneNumber: '+12025550102',
    });
    expect(people.get(3)).toEqual({ userId: 3, givenName: 'Jonas', familyName: '', phoneNumber: null });
  });

  it("carries a person's picture: its run-tagged file reference and Telegram's small copy of it", async () => {
    const { source } = account({ ...USERS, 7: { name: ['Ines', 'Duarte'], photo: 55 } }, [
      { private: 7 },
      { private: 3 },
    ]);
    const { people } = await source.readPeople(() => undefined);
    expect(people.get(7)).toMatchObject({
      photo: { run: 1, fileId: 55, remoteId: 'remote-55' },
      photoPreview: 'cHJldmlldw==',
    });
    expect(people.get(3)).not.toHaveProperty('photo');
    expect(await source.readPhoto(people.get(7)!.photo!)).toEqual(Uint8Array.of(55));
  });

  // Detects: reading people failing with "Chat not found" after TDLib restarts mid-scan because
  // use_chat_info_database is off and loadChats was not re-run in the new TDLib run.
  it('reloads the chat list and finishes reading when TDLib restarts mid-getChat', async () => {
    const { source, requests } = account(
      { ...USERS, 7: { name: ['Ines', 'Duarte'], photo: 55 } },
      [{ private: 2 }, { private: 7 }, { private: 3 }],
      { restartOnGetChat: 1 },
    );
    const { chats, people } = await source.readPeople(() => undefined);
    expect(chats).toEqual([
      { kind: 'person', userId: 2 },
      { kind: 'person', userId: 7 },
      { kind: 'person', userId: 3 },
    ]);
    expect(people.get(7)?.photo).toEqual({ run: 2, fileId: 55, remoteId: 'remote-55' });
    // loadChats ran in run 1 and again in run 2 after the restart.
    expect(requests.filter((request) => request === 'loadChats').length).toBeGreaterThanOrEqual(4);
  });

  it('reads the contact list, with people the user has no chat with', async () => {
    const { source } = account(USERS, [{ private: 2 }], { contacts: [6, 2, 4] });
    const { chats, people, contactIds } = await source.readPeople(() => undefined);
    // The bot on the contact list is left out; Aiko has no chat and is a person to look for all the same.
    expect(contactIds).toEqual([6, 2]);
    expect(people.get(6)).toMatchObject({ givenName: 'Aiko', phoneNumber: '+447700900106' });
    expect(chats).toEqual([{ kind: 'person', userId: 2 }]);
  });

  it('leaves out the user, bots and deleted accounts, as chats and as members', async () => {
    const { source } = account(USERS, [
      { private: 4 },
      { private: 5 },
      { private: SELF },
      { basicGroup: 'Flat 12', members: [SELF, 4, 5, 6] },
    ]);
    const { chats, people } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'group', chatId: 103, title: 'Flat 12', memberIds: [6], memberCount: 1 }]);
    expect([...people.keys()]).toEqual([6]);
  });

  it('leaves out channels, groups above the size limit and groups that hide their members', async () => {
    const { source, requests } = account(USERS, [
      { channel: 'News' },
      { supergroup: 'A city', members: [2], memberCount: GROUP_SIZE_LIMIT + 1 },
      { supergroup: 'Hidden', members: [2], hidden: true },
      { private: 6 },
    ]);
    const { chats, people } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'person', userId: 6 }]);
    // The size of a group comes with the first of its members; they are not taken from a group that is too large.
    expect([...people.keys()]).toEqual([6]);
    expect(requests.filter((request) => request === 'getSupergroupMembers')).toHaveLength(2);
  });

  it('passes over a member the library holds no record of, and keeps the others', async () => {
    const { source } = account(USERS, [{ basicGroup: 'Flat 12', members: [2, 999, 6] }]);
    const { chats } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'group', chatId: 100, title: 'Flat 12', memberIds: [2, 6], memberCount: 2 }]);
  });

  it('passes over a group whose members Telegram refuses to give, and reads the rest', async () => {
    const { source } = account(USERS, [{ supergroup: 'Left long ago', members: [2], refused: true }, { private: 6 }]);
    const { chats } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'person', userId: 6 }]);
  });

  it('asks again after the wait when Telegram says the requests come too fast', async () => {
    const { source, requests } = account(USERS, [{ supergroup: 'Hiking crew', members: [2, 6] }], {
      tooFastOnce: true,
    });
    const { chats } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'group', chatId: 100, title: 'Hiking crew', memberIds: [2, 6], memberCount: 2 }]);
    expect(requests.filter((request) => request === 'getSupergroupMembers')).toHaveLength(2);
  });

  it('does not ask the servers about a group that is already known to be too large', async () => {
    const { source, requests } = account(USERS, [
      { supergroup: 'A city', members: [2], knownSize: GROUP_SIZE_LIMIT + 1 },
      { private: 6 },
    ]);
    const { chats } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'person', userId: 6 }]);
    expect(requests).not.toContain('getSupergroupMembers');
  });

  it('counts the groups it reads, and estimates the time left once several are read', async () => {
    // A clock on which every reading of the time is a second later than the last.
    let seconds = 0;
    const groups: FakeChat[] = Array.from({ length: 8 }, (_, index) => ({
      supergroup: `Group ${index}`,
      members: [2],
    }));
    const { source } = account(USERS, [{ private: 6 }, { private: 3 }, ...groups], { now: () => 1000 * seconds++ });
    const reported: ReadingProgress[] = [];
    await source.readPeople((progress) => {
      expect(progress.groups).toBe(8);
      reported.push(progress);
    });
    expect(reported.map((progress) => progress.groupsRead)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(reported.map((progress) => progress.share)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((read) => read / 8));
    // No estimate before five groups are read; one for every group after that, ending at nothing left.
    expect(reported.slice(0, 5).map((progress) => progress.secondsLeft)).toEqual([null, null, null, null, null]);
    for (const progress of reported.slice(5)) expect(progress.secondsLeft).toBeGreaterThanOrEqual(0);
    expect(reported.at(-1)!.secondsLeft).toBe(0);
  });

  it('reads the members of a large group in several requests', async () => {
    const members = Array.from({ length: 450 }, (_, index) => 1000 + index);
    const users = Object.fromEntries(members.map((id) => [id, { name: ['Member', String(id)] } as FakeUser]));
    const { source, requests } = account({ ...USERS, ...users }, [{ supergroup: 'Big', members }]);
    const { chats } = await source.readPeople(() => undefined);
    expect(chats).toEqual([
      { kind: 'group', chatId: 100, title: 'Big', memberIds: members, memberCount: members.length },
    ]);
    expect(requests.filter((request) => request === 'getSupergroupMembers')).toHaveLength(3);
  });

  // Detects: a display that stands still while a large group is read, and a count of people that jumps at its end.
  it('reports each answer about a large group: the part of it that arrived and the people read so far', async () => {
    const members = Array.from({ length: 450 }, (_, index) => 1000 + index);
    const users = Object.fromEntries(members.map((id) => [id, { name: ['Member', String(id)] } as FakeUser]));
    const { source } = account({ ...USERS, ...users }, [{ private: 2 }, { supergroup: 'Big', members }]);
    const reported: ReadingProgress[] = [];
    await source.readPeople((progress) => reported.push(progress));
    expect(reported.map((progress) => [progress.groupsRead, progress.people])).toEqual([
      [0, 1],
      [0, 201],
      [0, 401],
      [1, 451],
    ]);
    expect(reported.map((progress) => progress.share)).toEqual([0, 200 / 450, 400 / 450, 1]);
  });

  // Detects: rawInvoke AND withChats both wrapping calls in patiently(), amplifying 429 retries from 3 to 15 (4x4).
  it('retries a persistent 429 flood wait once per outer layer (4 total attempts, not 16)', async () => {
    const requests: string[] = [];
    const invoke = (async (query: { _: string }) => {
      requests.push(query._);
      switch (query._) {
        case 'getMe':
          return { id: SELF };
        case 'getContacts':
          return { user_ids: [] };
        case 'loadChats':
          if (requests.filter((r) => r === 'loadChats').length > 1) throw new TelegramError(404, 'Not Found');
          return { _: 'ok' };
        case 'getChats':
          return { chat_ids: [100] };
        case 'getChat':
          return { title: 'Flooded', type: { _: 'chatTypeSupergroup', supergroup_id: 100, is_channel: false } };
        case 'getSupergroup':
          return { member_count: 10 };
        case 'getSupergroupMembers':
          throw new TelegramError(429, 'Too Many Requests: retry after 0');
        default:
          throw new Error(`unexpected ${query._}`);
      }
    }) as unknown as Td.Invoke;

    const source = peopleOf({ invoke, run: 1, readFileRef: async () => new Uint8Array() });
    await expect(source.readPeople(() => undefined)).rejects.toThrow(/Too Many Requests/);
    expect(requests.filter((r) => r === 'getSupergroupMembers')).toHaveLength(4);
  });

  // Detects: overlapping offset pages in getSupergroupMembers duplicating a member ID and inflating memberCount.
  it('deduplicates member IDs when supergroup member pages overlap', async () => {
    const requests: string[] = [];
    const page1 = [2, 3];
    const page2 = [3, 6];
    let pageCalls = 0;
    const invoke = (async (query: { _: string; user_id?: number }) => {
      requests.push(query._);
      switch (query._) {
        case 'getMe':
          return { id: SELF };
        case 'getContacts':
          return { user_ids: [] };
        case 'loadChats':
          if (requests.filter((r) => r === 'loadChats').length > 1) throw new TelegramError(404, 'Not Found');
          return { _: 'ok' };
        case 'getChats':
          return { chat_ids: [100] };
        case 'getChat':
          return { title: 'Shifting', type: { _: 'chatTypeSupergroup', supergroup_id: 100, is_channel: false } };
        case 'getSupergroup':
          return { member_count: 300 };
        case 'getSupergroupMembers': {
          const members = (pageCalls++ === 0 ? page1 : page2).map((user_id) => ({
            member_id: { _: 'messageSenderUser', user_id },
          }));
          return { total_count: 300, members };
        }
        case 'getUser': {
          const u = USERS[query.user_id!];
          return {
            first_name: u.name[0],
            last_name: u.name[1],
            phone_number: u.phone ?? '',
            type: { _: 'userTypeRegular' },
          };
        }
        default:
          throw new Error(`unexpected ${query._}`);
      }
    }) as unknown as Td.Invoke;

    const source = peopleOf({ invoke, run: 1, readFileRef: async () => new Uint8Array() });
    const { chats } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'group', chatId: 100, title: 'Shifting', memberIds: [2, 3, 6], memberCount: 3 }]);
  });

  // Detects: blindly prefixing '+' onto already-prefixed, leading-zero, too-short, or non-digit Telegram phone strings.
  it('normalizes and validates Telegram phone numbers before emitting E.164', async () => {
    const { source } = account(
      {
        [SELF]: USERS[SELF],
        10: { name: ['Plus', 'Already'], phone: '+12025550110' },
        11: { name: ['Leading', 'Zero'], phone: '0012025550111' },
        12: { name: ['Junk', 'Text'], phone: 'not-a-number' },
        13: { name: ['Too', 'Short'], phone: '1234' },
        14: { name: ['Valid', 'Bare'], phone: '12025550114' },
      },
      [{ private: 10 }, { private: 11 }, { private: 12 }, { private: 13 }, { private: 14 }],
    );
    const { people } = await source.readPeople(() => undefined);
    expect(people.get(10)?.phoneNumber).toBe('+12025550110');
    expect(people.get(11)?.phoneNumber).toBeNull();
    expect(people.get(12)?.phoneNumber).toBeNull();
    expect(people.get(13)?.phoneNumber).toBeNull();
    expect(people.get(14)?.phoneNumber).toBe('+12025550114');
  });

  // Detects: TDLib restarting between getChat and getUser causing getUser to answer 400 User not found in the fresh
  // run and silently drop the friend instead of reloading chats and retrying.
  it('reloads chats instead of dropping a private-chat friend when TDLib restarts before getUser', async () => {
    let run = 1;
    let loaded = false;
    let restarted = false;
    const invoke = (async (query: { _: string; user_id?: number }) => {
      switch (query._) {
        case 'getMe':
          return { id: SELF };
        case 'getContacts':
          return { user_ids: [] };
        case 'loadChats':
          if (loaded) throw new TelegramError(404, 'Not Found');
          loaded = true;
          return { _: 'ok' };
        case 'getChats':
          return { chat_ids: [100] };
        case 'getChat':
          if (!loaded) throw new TelegramError(400, 'Chat not found');
          if (!restarted) {
            restarted = true;
            // Restart right after getChat succeeds, wiping the in-memory user cache of TDLib.
            run++;
            loaded = false;
          }
          return { title: '', type: { _: 'chatTypePrivate', user_id: 2 } };
        case 'getUser':
          if (!loaded) throw new TelegramError(400, 'User not found');
          return {
            first_name: 'Mara',
            last_name: 'Lindqvist',
            phone_number: '12025550102',
            type: { _: 'userTypeRegular' },
          };
        default:
          throw new Error(`unexpected ${query._}`);
      }
    }) as unknown as Td.Invoke;

    const source = peopleOf({
      invoke,
      get run() {
        return run;
      },
      readFileRef: async () => new Uint8Array(),
    });
    const { chats, people } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'person', userId: 2 }]);
    expect(people.get(2)?.givenName).toBe('Mara');
  });
});
