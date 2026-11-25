// Reading Saved Messages and their media files from Telegram: the chat a user has with themselves.
//
// TDLib gives a chat's history from the newest message backwards, at most 100 messages per request, and may give
// fewer than asked for. The end of the history is a request that gives none. Media files are downloaded on demand
// during migration and read in chunks via `readFilePart`, reloading the message via `getMessage` if TDLib restarted
// or its file reference expired since the history was read.

import type * as Td from 'tdlib-types';
import {
  type TelegramClient,
  TelegramError,
  type TelegramFileRef,
  TelegramRestartedError,
  untilNotRestarted,
} from '../../telegram/client';
import { patiently } from '../../telegram/patiently';
import { type SavedMedia, type SavedMessage, savedMessageOf } from './messages';

export type SavedMediaOptions = {
  /** Telegram message ID in Saved Messages, used to refresh an expired/restarted file reference via `getMessage`. */
  messageId?: number;
  /** Called with a deadline (ms since 1970) while waiting on a Telegram rate limit, and null once waiting ends. */
  onWait?: (until: number | null) => void;
  /** Called when a Telegram download is waiting silently (e.g. inside TDLib's internal flood-wait delay). */
  onWaiting?: (waiting: boolean) => void;
};

/** Where the saved messages and their media come from: the user's account in the app, simulated data in tests. */
export interface SavedSource {
  /** Every message of Saved Messages, oldest first. `onProgress` gets the number of messages read so far. */
  readMessages(onProgress: (read: number) => void, cancel?: AbortSignal): Promise<SavedMessage[]>;
  /**
   * Downloads `media` and passes its exact byte length and a chunked reader to `use`, deleting the local copy once
   * `use` completes. Optional in text-only test doubles.
   */
  withMedia?<T>(
    media: Pick<SavedMedia, 'file' | 'size'>,
    use: (size: number, readChunks: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>) => Promise<T>,
    cancel?: AbortSignal,
    options?: SavedMediaOptions,
  ): Promise<T>;
}

const MESSAGES_PER_REQUEST = 100;
/**
 * Bounded backoff delays when TDLib's synchronous `downloadFile` fails with its generic error
 * `400 "File download has failed or was canceled"` (FileManager.cpp:3029) even after refreshing via `getMessage`,
 * which is how TDLib surfaces >60 s download flood waits.
 */
const DOWNLOAD_RETRY_DELAYS_MS = [15_000, 30_000] as const;

function abortableWait(ms: number, cancel?: AbortSignal): Promise<void> {
  if (cancel?.aborted) return Promise.reject(cancel.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancel!.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cancel?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    cancel?.addEventListener('abort', onAbort, { once: true });
  });
}

function isDownloadRetryableError(error: unknown): boolean {
  return (
    error instanceof TelegramError &&
    error.code === 400 &&
    (/file download has failed or was canceled/i.test(error.message) ||
      /file.?reference/i.test(error.message) ||
      /no valid file reference/i.test(error.message))
  );
}

export function savedMessagesOf(
  client: Pick<TelegramClient, 'invoke' | 'run' | 'withFileRef'> &
    Partial<Pick<TelegramClient, 'invokeInRun' | 'withDownloadedFile'>>,
  config: { downloadRetryDelaysMs?: readonly number[] } = {},
): SavedSource {
  const retryDelaysMs = config.downloadRetryDelaysMs ?? DOWNLOAD_RETRY_DELAYS_MS;
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

  let myUserId: number | null = null;
  let chatRun = -1;
  let chatId = 0;

  const ensureChat = async (run: number): Promise<number> => {
    if (chatRun === run) return chatId;
    if (myUserId === null) {
      const me = await invokeInRun(run, { _: 'getMe' });
      myUserId = me.id;
    }
    // The chat with oneself is Saved Messages. With use_chat_info_database off, a fresh TDLib run needs the chat
    // created in memory before getChatHistory or getMessage can read it.
    const chat = await invokeInRun(run, { _: 'createPrivateChat', user_id: myUserId, force: false });
    chatRun = run;
    chatId = chat.id;
    return chat.id;
  };

  return {
    async readMessages(onProgress, cancel) {
      cancel?.throwIfAborted();
      const byId = new Map<number, SavedMessage>();
      let from = 0;
      for (;;) {
        cancel?.throwIfAborted();
        let pageRun = 0;
        const page = await patiently(
          () =>
            untilNotRestarted(async () => {
              cancel?.throwIfAborted();
              const run = client.run;
              const id = await ensureChat(run);
              const result = await invokeInRun(run, {
                _: 'getChatHistory',
                chat_id: id,
                from_message_id: from,
                offset: 0,
                limit: MESSAGES_PER_REQUEST,
                only_local: false,
              });
              pageRun = run;
              return result;
            }),
          cancel,
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

    async withMedia(media, use, cancel, options) {
      const messageId = options?.messageId;
      const onWait = options?.onWait;
      const onWaiting = options?.onWaiting;

      if (messageId === undefined) {
        return patiently(() => client.withFileRef(media.file, use, undefined, cancel, onWaiting), cancel, onWait);
      }

      const reloadInRun = (run: number): Promise<TelegramFileRef> =>
        patiently(
          async () => {
            cancel?.throwIfAborted();
            const id = await ensureChat(run);
            const fresh = await invokeInRun(run, { _: 'getMessage', chat_id: id, message_id: messageId });
            const freshFile = savedMessageOf(fresh, run).media?.file;
            if (!freshFile) throw new Error('the Telegram message or its media is no longer available');
            return freshFile;
          },
          cancel,
          onWait,
        );

      const downloadInRun = (file: TelegramFileRef, run: number) => {
        // Pin directly to `run` via withDownloadedFile when available so a mid-download TDLib restart throws
        // TelegramRestartedError out to our outer loop and re-enters getMessage (instead of falling back to
        // getRemoteFile inside client.withFileRef).
        if (client.withDownloadedFile) {
          return client.withDownloadedFile(file.fileId, use, undefined, run, cancel, onWaiting);
        }
        return client.withFileRef(file, use, undefined, cancel, onWaiting);
      };

      let file = media.file;
      let refreshedInRun = -1;
      let retryAttempt = 0;

      return untilNotRestarted(async () => {
        for (;;) {
          cancel?.throwIfAborted();
          const run = client.run;
          // After a TDLib restart, getRemoteFile creates a file without a FileSourceId (or size), so expired
          // file_references cannot self-repair; reload the message in the current run instead.
          if (file.run !== run) {
            file = await reloadInRun(run);
            refreshedInRun = run;
          }
          try {
            return await downloadInRun(file, run);
          } catch (error) {
            if (cancel?.aborted || !isDownloadRetryableError(error)) throw error;
            if (refreshedInRun !== run) {
              file = await reloadInRun(run);
              refreshedInRun = run;
              continue;
            }
            if (retryAttempt >= retryDelaysMs.length) throw error;
            const waitMs = retryDelaysMs[retryAttempt++];
            onWait?.(Date.now() + waitMs);
            try {
              await abortableWait(waitMs, cancel);
            } finally {
              onWait?.(null);
            }
            const nextRun = client.run;
            file = await reloadInRun(nextRun);
            refreshedInRun = nextRun;
          }
        }
      });
    },
  };
}
