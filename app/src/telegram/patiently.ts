// Sending a request to Telegram again after the wait it names when requests come too fast.

import { TelegramError } from './client';

/** Telegram answers 429 when requests come too fast, and names the seconds to wait before the next one. */
export const TOO_FAST = 429;
/**
 * Longest flood wait retried automatically. TDLib's NetQueryDelayer already absorbs waits up to 60 seconds internally
 * (`total_timeout_limit = 60` in NetQueryCreator.cpp) and surfaces "Too Many Requests: retry after N" only beyond that.
 */
const LONGEST_WAIT_S = 300;
const WAITS_PER_REQUEST = 3;

function retryAfterSeconds(error: unknown): number | null {
  if (!(error instanceof TelegramError)) return null;
  // TDLib's FileManager::on_download_error_impl rewrites 429 download errors to code 400 while preserving the message.
  const isRateLimit =
    error.code === TOO_FAST || (error.code === 400 && /^Too Many Requests: retry after \d+/.test(error.message));
  if (!isRateLimit) return null;
  const named = /retry after (\d+)/.exec(error.message);
  return named ? Number(named[1]) : null;
}

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
 * waits and asks again for up to a minute for one request, without a word; its rate-limit answer arrives only beyond
 * that. `onWait` is told the deadline (ms since 1970) while waiting, and null once waiting ends.
 */
export async function patiently<T>(
  request: () => Promise<T>,
  cancel?: AbortSignal,
  onWait?: (until: number | null) => void,
): Promise<T> {
  for (let waits = 0; ; waits++) {
    cancel?.throwIfAborted();
    try {
      return await request();
    } catch (error) {
      cancel?.throwIfAborted();
      const seconds = retryAfterSeconds(error);
      if (seconds === null || seconds > LONGEST_WAIT_S || waits >= WAITS_PER_REQUEST) throw error;
      const waitMs = seconds * 1000 + 250;
      onWait?.(Date.now() + waitMs);
      try {
        await wait(waitMs, cancel);
      } finally {
        onWait?.(null);
      }
    }
  }
}
