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
    media: Pick<SavedMedia, 'fileId' | 'remoteId' | 'size'>,
    use: (size: number, readChunks: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

const MESSAGES_PER_REQUEST = 100;

export function savedMessagesOf(client: Pick<TelegramClient, 'invoke' | 'run' | 'withDownloadedFile'>): SavedSource {
  const invoke = ((query: { _: string }) => client.invoke(query as never)) as Td.Invoke;
  /** The TDLib run that produced the file IDs in the most recent `readMessages` call. */
  let readRun = -1;

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
        chatRun = run;
        chatId = chat.id;
        return chatId;
      };
      const byId = new Map<number, SavedMessage>();
      let from = 0;
      for (;;) {
        const page = await patiently(() =>
          untilNotRestarted(async () =>
            invoke({
              _: 'getChatHistory',
              chat_id: await ensureChat(),
              from_message_id: from,
              offset: 0,
              limit: MESSAGES_PER_REQUEST,
              only_local: false,
            }),
          ),
        );
        const messages = (page.messages ?? []).filter((message): message is Td.message => message != null);
        if (messages.length === 0) break;
        for (const message of messages) byId.set(message.id, savedMessageOf(message));
        const oldest = Math.min(...messages.map((message) => message.id));
        // An answer that does not go further back would be asked for again forever.
        if (from !== 0 && oldest >= from) break;
        from = oldest;
        onProgress(byId.size);
      }
      readRun = client.run;
      return [...byId.values()].sort((a, b) => a.id - b.id);
    },

    withMedia(media, use) {
      return patiently(() =>
        untilNotRestarted(async () => {
          let fileId = media.fileId;
          // TDLib numbers files anew after a restart, so resolve the permanent remote ID in the current run.
          if (client.run !== readRun && media.remoteId) {
            const file = await invoke({ _: 'getRemoteFile', remote_file_id: media.remoteId });
            fileId = file.id;
          }
          return client.withDownloadedFile(fileId, use);
        }),
      );
    },
  };
}
