// Sending a request to Telegram again after the wait it names when requests come too fast.

import { TelegramError } from './client';

/** Telegram answers 429 when requests come too fast, and names the seconds to wait before the next one. */
export const TOO_FAST = 429;
const LONGEST_WAIT_S = 60;
const WAITS_PER_REQUEST = 3;

function wait(ms: number, cancel?: AbortSignal): Promise<void> {
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

/**
 * Sends a request, and again after the wait Telegram names when it says the requests come too fast. TDLib itself
 * waits and asks again for up to a minute for one request, without a word; its answer 429 arrives only beyond that.
 */
export async function patiently<T>(request: () => Promise<T>, cancel?: AbortSignal): Promise<T> {
  for (let waits = 0; ; waits++) {
    cancel?.throwIfAborted();
    try {
      return await request();
    } catch (error) {
      cancel?.throwIfAborted();
      const named =
        error instanceof TelegramError && error.code === TOO_FAST ? /retry after (\d+)/.exec(error.message) : null;
      const seconds = named ? Number(named[1]) : null;
      if (seconds === null || seconds > LONGEST_WAIT_S || waits >= WAITS_PER_REQUEST) throw error;
      await wait(seconds * 1000 + 250, cancel);
    }
  }
}
