// Reading Saved Messages (kinds/saved/telegram-saved.ts) against a stand-in for TDLib that answers getChatHistory
// the way TDLib does: from the newest message backwards, from the message asked for, at most 100 per request, and
// sometimes fewer than asked for (td_api.tl, getChatHistory).

import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';
import { savedMessagesOf } from '../../../src/kinds/saved/telegram-saved';
import {
  type TelegramClient,
  TelegramError,
  type TelegramFileRef,
  TelegramRestartedError,
} from '../../../src/telegram/client';

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
function telegram(
  count: number,
  pageSize: (request: number) => number = () => 100,
  restartOnHistory: number | null = null,
) {
  const requests: { _: string; [key: string]: unknown }[] = [];
  let run = 1;
  let knownInRun = new Set<number>();
  let histories = 0;
  let restarted = false;
  const invoke = async (query: { _: string; [key: string]: unknown }) => {
    requests.push(query);
    switch (query._) {
      case 'getMe':
        return { _: 'user', id: MY_USER_ID };
      case 'createPrivateChat':
        if (query.user_id !== MY_USER_ID) throw new Error('asked for the chat with someone else');
        knownInRun.add(MY_USER_ID);
        return { _: 'chat', id: MY_USER_ID };
      case 'getChatHistory': {
        if (query.chat_id !== MY_USER_ID) throw new Error('asked for another chat');
        if (!knownInRun.has(MY_USER_ID)) throw new TelegramError(400, 'Chat not found');
        if (restartOnHistory !== null && !restarted && histories === restartOnHistory) {
          restarted = true;
          run++;
          knownInRun = new Set();
          throw new TelegramRestartedError();
        }
        const limit = Math.min(Number(query.limit), 100, histories === 0 ? 1 : pageSize(histories));
        histories++;
        const from = Number(query.from_message_id);
        // From 0: the newest messages. Otherwise: the messages before the one asked for.
        const before = from === 0 ? count + 1 : from / 2 ** 20;
        const numbers = [];
        for (let number = before - 1; number >= 1 && numbers.length < limit; number--) numbers.push(number);
        return { _: 'messages', total_count: count, messages: numbers.map(message) };
      }
      case 'getRemoteFile':
        return { _: 'file', id: Number(String(query.remote_file_id).replace('remote-', '')) + run * 1000 };
      default:
        throw new Error(`not simulated: ${query._}`);
    }
  };
  const downloadedRefs: TelegramFileRef[] = [];
  const client = {
    invoke,
    get run() {
      return run;
    },
    async withFileRef<T>(
      ref: TelegramFileRef,
      use: (size: number, readChunks: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>) => Promise<T>,
    ): Promise<T> {
      downloadedRefs.push(ref);
      const fileId =
        ref.run === run
          ? ref.fileId
          : ((await invoke({ _: 'getRemoteFile', remote_file_id: ref.remoteId })) as { id: number }).id;
      const data = new TextEncoder().encode(`file-${fileId}`);
      return use(data.length, async (onChunk) => {
        await onChunk(data);
      });
    },
  } as unknown as Pick<TelegramClient, 'invoke' | 'run' | 'withFileRef'>;
  return {
    client,
    requests,
    downloadedRefs,
    bumpRun: () => {
      run++;
      knownInRun = new Set();
    },
  };
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

  // Detects: reading failing with "Chat not found" after TDLib restarts mid-read, because TDLib forgets the chat in
  // memory (use_chat_info_database: false) until createPrivateChat is sent again in the new run.
  it('recreates the chat and finishes reading when TDLib restarts mid-read', async () => {
    const { client, requests } = telegram(250, () => 100, 2);
    const messages = await savedMessagesOf(client).readMessages(() => undefined);
    expect(messages).toHaveLength(250);
    expect(requests.filter((r) => r._ === 'createPrivateChat')).toHaveLength(2);
  });

  // Detects: reading media failing after TDLib restarts between reading the message list and downloading a file,
  // because TDLib assigns fresh file IDs on each run.
  it('passes run-tagged file references through withFileRef so restarted runs resolve via getRemoteFile', async () => {
    const { client, requests, downloadedRefs, bumpRun } = telegram(2);
    const source = savedMessagesOf(client);
    await source.readMessages(() => undefined);
    bumpRun();
    const received: Uint8Array[] = [];
    const ref: TelegramFileRef = { run: 1, fileId: 7, remoteId: 'remote-7' };
    await source.withMedia!({ file: ref, size: 10 }, async (_size, readChunks) => {
      await readChunks(async (chunk) => {
        received.push(chunk);
      });
    });
    expect(downloadedRefs).toEqual([ref]);
    expect(requests.some((r) => r._ === 'getRemoteFile' && r.remote_file_id === 'remote-7')).toBe(true);
    expect(new TextDecoder().decode(received[0])).toBe('file-2007');
  });

  // Detects: TDLib restarting during createPrivateChat leaving ensureChat() returning an old chat id without
  // throwing TelegramRestartedError, causing getChatHistory in the new run to fail with 400 Chat not found.
  it('retries when TDLib restarts during createPrivateChat', async () => {
    let run = 1;
    let knownInRun = new Set<number>();
    let createCalls = 0;
    const invoke = async (query: { _: string }) => {
      switch (query._) {
        case 'getMe':
          return { _: 'user', id: MY_USER_ID };
        case 'createPrivateChat':
          createCalls++;
          if (createCalls === 1) {
            // Simulate a restart finishing just before createPrivateChat returns: new run does not know the chat.
            run++;
            knownInRun = new Set();
            return { _: 'chat', id: MY_USER_ID };
          }
          knownInRun.add(MY_USER_ID);
          return { _: 'chat', id: MY_USER_ID };
        case 'getChatHistory':
          if (!knownInRun.has(MY_USER_ID)) throw new TelegramError(400, 'Chat not found');
          return { _: 'messages', total_count: 0, messages: [] };
        default:
          throw new Error(`not simulated: ${query._}`);
      }
    };
    const client = {
      invoke,
      get run() {
        return run;
      },
      withFileRef: async () => {
        throw new Error('unused');
      },
    } as unknown as Pick<TelegramClient, 'invoke' | 'run' | 'withFileRef'>;

    expect(await savedMessagesOf(client).readMessages(() => undefined)).toEqual([]);
    expect(createCalls).toBe(2);
  });

  // Detects: after TDLib restarts into Run 2, calling getRemoteFile produces a file handle with no FileSourceId
  // that fails with FILE_REFERENCE_EXPIRED instead of refreshing the message via createPrivateChat + getMessage.
  it('refreshes a saved message via getMessage after TDLib restarts instead of failing on getRemoteFile', async () => {
    let run = 1;
    let knownChatInRun = new Set<number>();
    const requests: { run: number; _: string; [key: string]: unknown }[] = [];
    const MSG_ID = 7 * 2 ** 20;

    const invoke = async (query: { _: string; [key: string]: unknown }) => {
      requests.push({ run, ...query });
      switch (query._) {
        case 'getMe':
          return { _: 'user', id: MY_USER_ID };
        case 'createPrivateChat':
          knownChatInRun.add(MY_USER_ID);
          return { _: 'chat', id: MY_USER_ID };
        case 'getChatHistory':
          if (!knownChatInRun.has(MY_USER_ID)) throw new TelegramError(400, 'Chat not found');
          if (Number(query.from_message_id) !== 0) return { _: 'messages', total_count: 1, messages: [] };
          return {
            _: 'messages',
            total_count: 1,
            messages: [
              {
                _: 'message',
                id: MSG_ID,
                date: 1_700_000_001,
                content: {
                  _: 'messageDocument',
                  caption: { _: 'formattedText', text: '', entities: [] },
                  document: {
                    _: 'document',
                    file_name: 'a.bin',
                    mime_type: 'application/octet-stream',
                    document: {
                      _: 'file',
                      id: 11,
                      size: 5,
                      expected_size: 5,
                      remote: { _: 'remoteFile', id: 'remote-old' },
                    },
                  },
                },
              },
            ],
          };
        case 'getMessage':
          if (!knownChatInRun.has(MY_USER_ID)) throw new TelegramError(400, 'Chat not found');
          if (query.message_id !== MSG_ID) throw new TelegramError(404, 'Not Found');
          return {
            _: 'message',
            id: MSG_ID,
            date: 1_700_000_001,
            content: {
              _: 'messageDocument',
              caption: { _: 'formattedText', text: '', entities: [] },
              document: {
                _: 'document',
                file_name: 'a.bin',
                mime_type: 'application/octet-stream',
                document: {
                  _: 'file',
                  id: 22,
                  size: 5,
                  expected_size: 5,
                  remote: { _: 'remoteFile', id: 'remote-fresh' },
                },
              },
            },
          };
        default:
          throw new Error(`not simulated: ${query._}`);
      }
    };

    const client = {
      invoke,
      get run() {
        return run;
      },
      async withFileRef<T>(
        ref: TelegramFileRef,
        use: (size: number, readChunks: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>) => Promise<T>,
      ): Promise<T> {
        if (ref.run !== run) throw new TelegramError(400, 'FILE_REFERENCE_EXPIRED');
        const data = new TextEncoder().encode(`fresh-${ref.fileId}`);
        return use(data.length, async (onChunk) => onChunk(data));
      },
    } as unknown as Pick<TelegramClient, 'invoke' | 'run' | 'withFileRef'>;

    const source = savedMessagesOf(client);
    const [savedMsg] = await source.readMessages(() => undefined);
    // Simulate TDLib restarting into Run 2.
    run = 2;
    knownChatInRun = new Set();

    const received: Uint8Array[] = [];
    await source.withMedia!(
      savedMsg.media!,
      async (_size, readChunks) => {
        await readChunks(async (chunk) => {
          received.push(chunk);
        });
      },
      undefined,
      { messageId: savedMsg.id },
    );

    expect(new TextDecoder().decode(received[0])).toBe('fresh-22');
    expect(requests.some((r) => r.run === 2 && r._ === 'createPrivateChat')).toBe(true);
    expect(requests.some((r) => r.run === 2 && r._ === 'getMessage' && r.message_id === MSG_ID)).toBe(true);
  });

  // Detects: TDLib's FileManager::on_download_error_impl rewriting 429 flood waits to code 400
  // ("Too Many Requests: retry after N"), causing patiently() to abort downloads instead of waiting and retrying.
  it('retries and reports onWait when TDLib downloadFile fails with code 400 Too Many Requests: retry after', async () => {
    let attempts = 0;
    const waits: (number | null)[] = [];
    const client = {
      invoke: async () => {
        throw new Error('unused');
      },
      get run() {
        return 1;
      },
      async withFileRef<T>(
        _ref: TelegramFileRef,
        use: (size: number, readChunks: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>) => Promise<T>,
      ): Promise<T> {
        attempts++;
        if (attempts === 1) {
          throw new TelegramError(400, 'Too Many Requests: retry after 0');
        }
        const data = new TextEncoder().encode('ok');
        return use(data.length, async (onChunk) => onChunk(data));
      },
    } as unknown as Pick<TelegramClient, 'invoke' | 'run' | 'withFileRef'>;

    const source = savedMessagesOf(client);
    const received: Uint8Array[] = [];
    await source.withMedia!(
      { file: { run: 1, fileId: 1, remoteId: 'r1' }, size: 2 },
      async (_size, readChunks) => {
        await readChunks(async (chunk) => {
          received.push(chunk);
        });
      },
      undefined,
      { onWait: (until: number | null) => waits.push(until) },
    );
    expect(attempts).toBe(2);
    expect(new TextDecoder().decode(received[0])).toBe('ok');
    expect(waits.length).toBe(2);
    expect(typeof waits[0]).toBe('number');
    expect(waits[1]).toBeNull();
  });
});
