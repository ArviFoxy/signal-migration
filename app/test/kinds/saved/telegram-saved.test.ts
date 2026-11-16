// Reading Saved Messages (kinds/saved/telegram-saved.ts) against a stand-in for TDLib that answers getChatHistory
// the way TDLib does: from the newest message backwards, from the message asked for, at most 100 per request, and
// sometimes fewer than asked for (td_api.tl, getChatHistory).

import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';
import { savedMessagesOf } from '../../../src/kinds/saved/telegram-saved';
import type { TelegramClient } from '../../../src/telegram/client';

const MY_USER_ID = 5_000_001;

const message = (number: number) =>
  ({
    _: 'message',
    id: number * 2 ** 20,
    date: 1_600_000_000 + number,
    content: { _: 'messageText', text: { _: 'formattedText', text: `note ${number}`, entities: [] } },
  }) as unknown as Td.message;

/**
 * A chat with oneself holding the messages numbered 1 to `count`. `pageSize` gives how many messages each answer
 * holds at most; the first answer holds one message, as TDLib's often does.
 */
function telegram(count: number, pageSize: (request: number) => number = () => 100) {
  const requests: { _: string; [key: string]: unknown }[] = [];
  let histories = 0;
  const invoke = async (query: { _: string; [key: string]: unknown }) => {
    requests.push(query);
    switch (query._) {
      case 'getMe':
        return { _: 'user', id: MY_USER_ID };
      case 'createPrivateChat':
        if (query.user_id !== MY_USER_ID) throw new Error('asked for the chat with someone else');
        return { _: 'chat', id: MY_USER_ID };
      case 'getChatHistory': {
        if (query.chat_id !== MY_USER_ID) throw new Error('asked for another chat');
        const limit = Math.min(Number(query.limit), 100, histories === 0 ? 1 : pageSize(histories));
        histories++;
        const from = Number(query.from_message_id);
        // From 0: the newest messages. Otherwise: the messages before the one asked for.
        const before = from === 0 ? count + 1 : from / 2 ** 20;
        const numbers = [];
        for (let number = before - 1; number >= 1 && numbers.length < limit; number--) numbers.push(number);
        return { _: 'messages', total_count: count, messages: numbers.map(message) };
      }
      default:
        throw new Error(`not simulated: ${query._}`);
    }
  };
  return { client: { invoke } as unknown as Pick<TelegramClient, 'invoke'>, requests };
}

describe('reading Saved Messages', () => {
  // Detects: reading another chat than the one with oneself; stopping at the first answer, which holds a single
  // message; messages lost or doubled between answers; and an order other than oldest first, which is the order
  // the messages are sent to Signal in.
  it('reads the whole chat with oneself, oldest first, each message once', async () => {
    const { client, requests } = telegram(250);
    const progress: number[] = [];
    const messages = await savedMessagesOf(client).readMessages((read) => progress.push(read));
    expect(messages.map((m) => m.id / 2 ** 20)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    expect(messages[0]).toMatchObject({ kind: 'text', body: 'note 1', date: 1_600_000_001 });
    expect(requests.find((r) => r._ === 'createPrivateChat')).toMatchObject({ user_id: MY_USER_ID });
    expect(progress.at(-1)).toBe(250);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  // Detects: taking an answer with fewer messages than asked for as the end of the history. TDLib says it may
  // give fewer; only an empty answer is the end.
  it('goes on after an answer with fewer messages than asked for', async () => {
    const { client } = telegram(120, (request) => (request % 2 === 0 ? 7 : 100));
    const messages = await savedMessagesOf(client).readMessages(() => undefined);
    expect(messages).toHaveLength(120);
  });

  it('gives no messages for an empty chat', async () => {
    const { client } = telegram(0);
    expect(await savedMessagesOf(client).readMessages(() => undefined)).toEqual([]);
  });
});
