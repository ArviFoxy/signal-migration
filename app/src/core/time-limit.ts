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

/** The message for a request that got no answer within its time limit. */
export const noAnswer = (party: Party, seconds: number) => `${party} did not answer within ${seconds} seconds.`;

/** A request that got no answer within its time limit. */
export class NoAnswerError extends Error {
  constructor(
    readonly party: Party,
    readonly seconds: number,
  ) {
    super(noAnswer(party, seconds));
  }
}

/** How long Telegram and Signal may take to answer one request. */
export const REQUEST_TIME_LIMIT_S = 60;
/** How long the migration server may take to answer one request. */
export const SERVER_TIME_LIMIT_S = 30;

function combineSignals(first: AbortSignal | null | undefined, second: AbortSignal): AbortSignal {
  if (!first) return second;
  if ('any' in AbortSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([first, second]);
  }
  const combined = new AbortController();
  const forward = (source: AbortSignal) => {
    if (!combined.signal.aborted) combined.abort(source.reason);
  };
  if (first.aborted) forward(first);
  else if (second.aborted) forward(second);
  else {
    first.addEventListener('abort', () => forward(first), { once: true });
    second.addEventListener('abort', () => forward(second), { once: true });
  }
  return combined.signal;
}

/** `fetch`, given up after `seconds` with a NoAnswerError naming `party`. Composes any caller-supplied `init.signal`. */
export function fetchWithTimeLimit(
  party: Party,
  seconds: number,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const signal = combineSignals(init.signal, controller.signal);
  return withTimeLimit(fetch(url, { ...init, signal }), seconds * 1000, () => {
    controller.abort();
    return new NoAnswerError(party, seconds);
  });
}

/**
 * Fetches `url` and runs `consume(response)` (for example reading `arrayBuffer()` or `json()`) under one shared
 * deadline, aborting the underlying fetch if either response headers or body reading stall past `seconds`.
 */
export function withFetchTimeLimit<T>(
  party: Party,
  seconds: number,
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  fetchImpl: typeof fetch = (input, options) => fetch(input, options),
): Promise<T> {
  const controller = new AbortController();
  const signal = combineSignals(init.signal, controller.signal);
  const work = (async () => {
    const response = await fetchImpl(url, { ...init, signal });
    return consume(response);
  })();
  return withTimeLimit(work, seconds * 1000, () => {
    controller.abort();
    return new NoAnswerError(party, seconds);
  });
}
