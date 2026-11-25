// Downloading a Telegram file through TDLib, with a limit on how long it may make no progress. TDLib answers a
// synchronous downloadFile only once the file is complete, so a download that stalls, or a TDLib that stopped,
// would otherwise be waited for forever.

import type * as Td from 'tdlib-types';
import { TelegramRestartedError } from './client';

/** A download that received no new bytes within the limit; it was cancelled. */
export class DownloadStalledError extends Error {
  constructor(
    readonly received: number,
    readonly total: number,
    limitMs: number,
  ) {
    const kb = (bytes: number) => Math.round(bytes / 1024);
    super(
      `downloading from Telegram made no progress for ${limitMs / 1000} seconds (${kb(received)} of ${kb(total)} KB received)`,
    );
  }
}

/**
 * How long a download may receive nothing before it counts as stalled. Must exceed TDLib's internal NetQueryDelayer
 * timeout (`total_timeout_limit = 60` s in NetQueryCreator.cpp) so Telegram's <= 60 s flood-wait delays complete or
 * surface as "Too Many Requests: retry after N" instead of being cancelled early as stalls.
 */
export const STALL_LIMIT_MS = 90_000;
/** How often TDLib is asked how far the download got. */
const PROGRESS_POLL_MS = 5_000;
/** How long without new bytes before `onWaiting(true)` is called so the UI can explain TDLib's internal throttle. */
const WAITING_NOTIFY_MS = 10_000;

/** Races `promise` against a timeout of `ms` and optional `cancel`, always clearing timers and listeners. */
function raceWait<T>(promise: Promise<T>, ms: number, onTimeout: T, cancel?: AbortSignal): Promise<T> {
  if (cancel?.aborted) return Promise.reject(cancel.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      cancel?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancel!.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(onTimeout);
    }, ms);
    cancel?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/** Downloads a file completely; fails with DownloadStalledError when no bytes arrive for `limitMs`. */
export async function downloadWithStallLimit(
  invoke: Td.Invoke,
  fileId: number,
  limitMs = STALL_LIMIT_MS,
  pollMs = PROGRESS_POLL_MS,
  cancel?: AbortSignal,
  onWaiting?: (waiting: boolean) => void,
): Promise<void> {
  cancel?.throwIfAborted();
  let finished = false;
  const download = invoke({
    _: 'downloadFile',
    file_id: fileId,
    priority: 1,
    offset: 0,
    limit: 0,
    synchronous: true,
  }).finally(() => (finished = true));
  // Avoid unhandled rejections if we exit early on stall or abort while downloadFile settles later.
  download.catch(() => undefined);
  const cancelDownload = () => {
    void invoke({ _: 'cancelDownloadFile', file_id: fileId, only_if_pending: false }).catch(() => undefined);
  };
  let received = 0;
  let total = 0;
  let progressAt = Date.now();
  let notifiedWaiting = false;
  const setWaiting = (waiting: boolean) => {
    if (notifiedWaiting === waiting) return;
    notifiedWaiting = waiting;
    onWaiting?.(waiting);
  };
  try {
    while (!finished) {
      await raceWait(
        download.then(
          () => undefined,
          () => undefined,
        ),
        pollMs,
        undefined,
        cancel,
      );
      if (finished) break;
      // TDLib may not answer at all (when it stopped), so the question about progress has a limit too.
      let restarted = false;
      const file = await raceWait(
        invoke({ _: 'getFile', file_id: fileId }).catch((error: unknown) => {
          if (error instanceof TelegramRestartedError) {
            restarted = true;
            return null;
          }
          return null;
        }),
        pollMs,
        null,
        cancel,
      );
      if (finished) break;
      if (restarted) throw new TelegramRestartedError();
      if (file) {
        total = file.expected_size || file.size || total;
        if (file.local.downloaded_size > received) {
          received = file.local.downloaded_size;
          progressAt = Date.now();
          setWaiting(false);
        }
      }
      const idleMs = Date.now() - progressAt;
      if (idleMs >= limitMs) {
        cancelDownload();
        throw new DownloadStalledError(received, total, limitMs);
      }
      if (idleMs >= WAITING_NOTIFY_MS) setWaiting(true);
    }
  } catch (error) {
    if (cancel?.aborted && !(error instanceof DownloadStalledError)) cancelDownload();
    throw error;
  } finally {
    setWaiting(false);
  }
  await download;
}
