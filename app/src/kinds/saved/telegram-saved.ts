// Reading Saved Messages and their media files from Telegram: the chat a user has with themselves.
//
// TDLib gives a chat's history from the newest message backwards, at most 100 messages per request, and may give
// fewer than asked for. The end of the history is a request that gives none. Media files are downloaded on demand
// during migration and read in chunks via `readFilePart`, re-resolving their TDLib file ID via `getRemoteFile` if
// TDLib restarted since the history was read.

import type * as Td from 'tdlib-types';
import { type TelegramClient, untilNotRestarted } from '../../telegram/client';
import { patiently } from '../../telegram/patiently';
import { type SavedMedia, type SavedMessage, savedMessageOf } from './messages';

/** Where the saved messages and their media come from: the user's account in the app, simulated data in tests. */
export interface SavedSource {
  /** Every message of Saved Messages, oldest first. `onProgress` gets the number of messages read so far. */
  readMessages(onProgress: (read: number) => void): Promise<SavedMessage[]>;
  /**
   * Downloads `media` and passes its exact byte length and a chunked reader to `use`, deleting the local copy once
   * `use` completes. Optional in text-only test doubles.
   */
  withMedia?<T>(
    media: Pick<SavedMedia, 'file' | 'size'>,
    use: (size: number, readChunks: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

const MESSAGES_PER_REQUEST = 100;

export function savedMessagesOf(client: Pick<TelegramClient, 'invoke' | 'run' | 'withFileRef'>): SavedSource {
  const invoke = ((query: { _: string }) => client.invoke(query as never)) as Td.Invoke;

  return {
    async readMessages(onProgress) {
      const me = await patiently(() => untilNotRestarted(() => invoke({ _: 'getMe' })));
      let chatRun = -1;
      let chatId = 0;
      const ensureChat = async () => {
        if (chatRun === client.run) return chatId;
        const run = client.run;
        // The chat with oneself is Saved Messages. With use_chat_info_database off, a fresh TDLib run needs the chat
        // created in memory before getChatHistory can read it.
        const chat = await invoke({ _: 'createPrivateChat', user_id: me.id, force: false });
        if (client.run === run) {
          chatRun = run;
          chatId = chat.id;
        }
        return chat.id;
      };
      const byId = new Map<number, SavedMessage>();
      let from = 0;
      for (;;) {
        let pageRun = 0;
        const page = await patiently(() =>
          untilNotRestarted(async () => {
            const id = await ensureChat();
            const before = client.run;
            const result = await invoke({
              _: 'getChatHistory',
              chat_id: id,
              from_message_id: from,
              offset: 0,
              limit: MESSAGES_PER_REQUEST,
              only_local: false,
            });
            pageRun = client.run === before ? before : 0;
            return result;
          }),
        );
        const messages = (page.messages ?? []).filter((message): message is Td.message => message != null);
        if (messages.length === 0) break;
        for (const message of messages) byId.set(message.id, savedMessageOf(message, pageRun));
        const oldest = Math.min(...messages.map((message) => message.id));
        // An answer that does not go further back would be asked for again forever.
        if (from !== 0 && oldest >= from) break;
        from = oldest;
        onProgress(byId.size);
      }
      return [...byId.values()].sort((a, b) => a.id - b.id);
    },

    withMedia(media, use) {
      return patiently(() => client.withFileRef(media.file, use));
    },
  };
}
