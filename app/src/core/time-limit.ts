// Time limits for work that waits on something outside the page's control (a server, a browser event, a worker's
// answer), which may never come.

/** `work`'s result, or the error `expire` returns once `ms` have passed; `expire` also stops what is still running. */
export function withTimeLimit<T>(work: Promise<T>, ms: number, expire: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(expire()), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** Who a request went to. */
export type Party = 'Telegram' | 'Signal' | 'The migration server';

/** A request that got no answer within its time limit. */
export class NoAnswerError extends Error {
  constructor(
    readonly party: Party,
    readonly seconds: number,
  ) {
    super(`${party} did not answer within ${seconds} seconds.`);
  }
}

/** How long Telegram and Signal may take to answer one request. */
export const REQUEST_TIME_LIMIT_S = 60;
/** How long the migration server may take to answer one request. */
export const SERVER_TIME_LIMIT_S = 30;

/** `fetch`, given up after `seconds` with a NoAnswerError naming `party`. */
export function fetchWithTimeLimit(
  party: Party,
  seconds: number,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  return withTimeLimit(fetch(url, { ...init, signal: controller.signal }), seconds * 1000, () => {
    controller.abort();
    return new NoAnswerError(party, seconds);
  });
}
