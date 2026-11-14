// Reading the people of a Telegram account from TDLib's answers: who counts as a person, which groups are read, and
// the order of the chat list.

import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';
import { GROUP_SIZE_LIMIT, peopleOf, type ReadingProgress } from '../../../src/kinds/friends/telegram-people';
import { TelegramError } from '../../../src/telegram/client';

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
  options: { tooFastOnce?: boolean; now?: () => number; report?: (line: string) => void; contacts?: number[] } = {},
) {
  const requests: string[] = [];
  let loaded = 0;
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
            ? { profile_photo: { small: { id: user.photo }, minithumbnail: { data: 'cHJldmlldw==' } } }
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
  const readFile = (fileId: number) => Promise.resolve(Uint8Array.of(fileId));
  return { source: peopleOf({ invoke, readFile }, options.report, options.now), requests };
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

  it("carries a person's picture: its file number and Telegram's small copy of it", async () => {
    const { source } = account({ ...USERS, 7: { name: ['Ines', 'Duarte'], photo: 55 } }, [
      { private: 7 },
      { private: 3 },
    ]);
    const { people } = await source.readPeople(() => undefined);
    expect(people.get(7)).toMatchObject({ photoFileId: 55, photoPreview: 'cHJldmlldw==' });
    expect(people.get(3)).not.toHaveProperty('photoFileId');
    expect(await source.readPhoto(55)).toEqual(Uint8Array.of(55));
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

  it('reports how long the requests took, without naming a chat or a person', async () => {
    const lines: string[] = [];
    const { source } = account(USERS, [{ supergroup: 'Hiking crew', members: [2, 6] }, { private: 3 }], {
      report: (line) => lines.push(line),
    });
    await source.readPeople(() => undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/for 2 chats, 1 of them groups/);
    expect(lines[0]).toMatch(/getSupergroupMembers 1 times/);
    for (const name of ['Hiking crew', 'Mara', 'Aiko', '12025550102']) expect(lines[0]).not.toContain(name);
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
});
