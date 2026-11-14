// Reading the people of a Telegram account from TDLib's answers: who counts as a person, which groups are read, and
// the order of the chat list.

import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';
import { GROUP_SIZE_LIMIT, peopleOf } from '../../../src/kinds/friends/telegram-people';
import { TelegramError } from '../../../src/telegram/client';

type UserKind = 'userTypeRegular' | 'userTypeBot' | 'userTypeDeleted';
type FakeUser = { name: [string, string]; phone?: string; kind?: UserKind };
type FakeChat =
  | { private: number }
  | { basicGroup: string; members: number[] }
  | { supergroup: string; members: number[]; memberCount?: number; hidden?: boolean }
  | { channel: string };

const SELF = 1;

/** A Telegram account with these users and this chat list, answering the requests the reader sends. */
function account(users: Record<number, FakeUser>, chats: FakeChat[]) {
  const requests: string[] = [];
  let loaded = 0;
  const member = (userId: number) => ({ member_id: { _: 'messageSenderUser', user_id: userId } });
  const chatAt = (chatId: number) => chats[chatId - 100]!;
  const invoke = (async (query: { _: string } & Record<string, unknown>) => {
    requests.push(query._);
    switch (query._) {
      case 'getMe':
        return { id: SELF };
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
        const user = users[query.user_id as number]!;
        return {
          first_name: user.name[0],
          last_name: user.name[1],
          phone_number: user.phone ?? '',
          type: { _: user.kind ?? 'userTypeRegular' },
        };
      }
      case 'getBasicGroupFullInfo': {
        const chat = chatAt(query.basic_group_id as number) as Extract<FakeChat, { basicGroup: string }>;
        return { members: chat.members.map(member) };
      }
      case 'getSupergroupFullInfo': {
        const chat = chatAt(query.supergroup_id as number) as Extract<FakeChat, { supergroup: string }>;
        return { member_count: chat.memberCount ?? chat.members.length, can_get_members: !chat.hidden };
      }
      case 'getSupergroupMembers': {
        const chat = chatAt(query.supergroup_id as number) as Extract<FakeChat, { supergroup: string }>;
        const offset = query.offset as number;
        return { members: chat.members.slice(offset, offset + (query.limit as number)).map(member) };
      }
      default:
        throw new Error(`unexpected request ${query._}`);
    }
  }) as unknown as Td.Invoke;
  return { source: peopleOf({ invoke }), requests };
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
      { kind: 'group', chatId: 100, title: 'Flat 12', memberIds: [3, 6] },
      { kind: 'person', userId: 2 },
      { kind: 'group', chatId: 102, title: 'Hiking crew', memberIds: [2, 6] },
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

  it('leaves out the user, bots and deleted accounts, as chats and as members', async () => {
    const { source } = account(USERS, [
      { private: 4 },
      { private: 5 },
      { private: SELF },
      { basicGroup: 'Flat 12', members: [SELF, 4, 5, 6] },
    ]);
    const { chats, people } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'group', chatId: 103, title: 'Flat 12', memberIds: [6] }]);
    expect([...people.keys()]).toEqual([6]);
  });

  it('leaves out channels, groups above the size limit and groups that hide their members', async () => {
    const { source, requests } = account(USERS, [
      { channel: 'News' },
      { supergroup: 'A city', members: [2], memberCount: GROUP_SIZE_LIMIT + 1 },
      { supergroup: 'Hidden', members: [2], hidden: true },
      { private: 6 },
    ]);
    const { chats } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'person', userId: 6 }]);
    expect(requests).not.toContain('getSupergroupMembers');
  });

  it('reads the members of a large group in several requests', async () => {
    const members = Array.from({ length: 450 }, (_, index) => 1000 + index);
    const users = Object.fromEntries(members.map((id) => [id, { name: ['Member', String(id)] } as FakeUser]));
    const { source, requests } = account({ ...USERS, ...users }, [{ supergroup: 'Big', members }]);
    const { chats } = await source.readPeople(() => undefined);
    expect(chats).toEqual([{ kind: 'group', chatId: 100, title: 'Big', memberIds: members }]);
    expect(requests.filter((request) => request === 'getSupergroupMembers')).toHaveLength(3);
  });
});
