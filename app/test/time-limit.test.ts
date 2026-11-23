import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoAnswerError, withFetchTimeLimit, withTimeLimit } from '../src/core/time-limit';

describe('withTimeLimit', () => {
  afterEach(() => vi.useRealTimers());

  // Detects: waiting forever for something that never comes (a sticker whose animation never reports being loaded,
  // an encoder that stopped answering), which stops the whole migration at that pack.
  it('fails work that has not finished in time, and stops it', async () => {
    vi.useFakeTimers();
    let stopped = false;
    const result = withTimeLimit(new Promise(() => undefined), 120_000, () => {
      stopped = true;
      return new Error('took too long');
    });
    const outcome = result.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await outcome).toBe('took too long');
    expect(stopped).toBe(true);
  });

  // Detects: a limit that also stops work that finished in time.
  it('returns work that finishes in time, and stops nothing', async () => {
    vi.useFakeTimers();
    let stopped = false;
    const result = withTimeLimit(Promise.resolve('converted'), 120_000, () => {
      stopped = true;
      return new Error('took too long');
    });
    expect(await result).toBe('converted');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(stopped).toBe(false);
  });

  // Detects: response headers arriving in time while the response body stalls forever without aborting fetch.
  it('aborts and rejects when a fetched body stalls past the time limit', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fakeFetch: typeof fetch = (async (_input, init) => {
      init?.signal?.addEventListener('abort', () => (aborted = true));
      return {
        arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined),
      } as unknown as Response;
    }) as typeof fetch;

    const promise = withFetchTimeLimit(
      'Signal',
      10,
      'https://cdn.example/file',
      {},
      (response) => response.arrayBuffer(),
      fakeFetch,
    );
    const outcome = promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(NoAnswerError);
    expect(aborted).toBe(true);
  });

  // Detects: withFetchTimeLimit overwriting a caller-supplied AbortSignal instead of composing it.
  it('forwards caller AbortSignal into fetch', async () => {
    const caller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fakeFetch: typeof fetch = (async (_input, init) => {
      receivedSignal = init?.signal ?? undefined;
      return new Response('ok');
    }) as typeof fetch;

    await withFetchTimeLimit(
      'The migration server',
      10,
      'https://server.example/x',
      { signal: caller.signal },
      (r) => r.text(),
      fakeFetch,
    );
    expect(receivedSignal?.aborted).toBe(false);
    caller.abort();
    expect(receivedSignal?.aborted).toBe(true);
  });
});
