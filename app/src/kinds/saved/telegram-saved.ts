// Reading Saved Messages from Telegram: the chat a user has with themselves.
//
// TDLib gives a chat's history from the newest message backwards, at most 100 messages per request, and may give
// fewer than asked for. The end of the history is a request that gives none.

import type * as Td from 'tdlib-types';
import { type TelegramClient, untilNotRestarted } from '../../telegram/client';
import { patiently } from '../../telegram/patiently';
import { type SavedMessage, savedMessageOf } from './messages';

/** Where the saved messages come from: the user's account in the app, simulated data in tests. */
export interface SavedSource {
  /** Every message of Saved Messages, oldest first. `onProgress` gets the number of messages read so far. */
  readMessages(onProgress: (read: number) => void): Promise<SavedMessage[]>;
}

const MESSAGES_PER_REQUEST = 100;

export function savedMessagesOf(client: Pick<TelegramClient, 'invoke'>): SavedSource {
  const invoke = ((query: { _: string }) =>
    patiently(() => untilNotRestarted(() => client.invoke(query as never)))) as Td.Invoke;

  return {
    async readMessages(onProgress) {
      const me = await invoke({ _: 'getMe' });
      // The chat with oneself is Saved Messages.
      const chat = await invoke({ _: 'createPrivateChat', user_id: me.id, force: false });
      const byId = new Map<number, SavedMessage>();
      let from = 0;
      for (;;) {
        const page = await invoke({
          _: 'getChatHistory',
          chat_id: chat.id,
          from_message_id: from,
          offset: 0,
          limit: MESSAGES_PER_REQUEST,
          only_local: false,
        });
        const messages = (page.messages ?? []).filter((message): message is Td.message => message != null);
        if (messages.length === 0) break;
        for (const message of messages) byId.set(message.id, savedMessageOf(message));
        const oldest = Math.min(...messages.map((message) => message.id));
        // An answer that does not go further back would be asked for again forever.
        if (from !== 0 && oldest >= from) break;
        from = oldest;
        onProgress(byId.size);
      }
      return [...byId.values()].sort((a, b) => a.id - b.id);
    },
  };
}
