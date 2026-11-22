// Sending a request to Telegram again after the wait it names when requests come too fast.

import { TelegramError } from './client';

/** Telegram answers 429 when requests come too fast, and names the seconds to wait before the next one. */
export const TOO_FAST = 429;
const LONGEST_WAIT_S = 60;
const WAITS_PER_REQUEST = 3;

/**
 * Sends a request, and again after the wait Telegram names when it says the requests come too fast. TDLib itself
 * waits and asks again for up to a minute for one request, without a word; its answer 429 arrives only beyond that.
 */
export async function patiently<T>(request: () => Promise<T>): Promise<T> {
  for (let waits = 0; ; waits++) {
    try {
      return await request();
    } catch (error) {
      const named =
        error instanceof TelegramError && error.code === TOO_FAST ? /retry after (\d+)/.exec(error.message) : null;
      const seconds = named ? Number(named[1]) : null;
      if (seconds === null || seconds > LONGEST_WAIT_S || waits >= WAITS_PER_REQUEST) throw error;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 250));
    }
  }
}
