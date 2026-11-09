// The limit on downloads that make no progress (telegram/download.ts), with TDLib's answers simulated and time faked.

import type * as Td from 'tdlib-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadWithStallLimit } from '../src/telegram/download';

type File = { size: number; expected_size: number; local: { downloaded_size: number } };

/** TDLib: downloadFile answers when `complete` resolves; getFile reports `progress()`, or never answers. */
function tdlib(progress: (() => number) | null, complete: Promise<void>, size: number) {
  const requests: string[] = [];
  const invoke = (async (query: { _: string }) => {
    requests.push(query._);
    if (query._ === 'downloadFile') return complete;
    if (query._ === 'getFile') {
      if (!progress) return new Promise(() => undefined);
      return { size, expected_size: size, local: { downloaded_size: progress() } } satisfies File;
    }
    return { _: 'ok' };
  }) as unknown as Td.Invoke;
  return { invoke, requests };
}

describe('downloading a Telegram file', () => {
  afterEach(() => vi.useRealTimers());

  // Detects: waiting forever for a download that stopped receiving bytes, which stops the whole migration.
  it('gives up on a download that receives nothing for a minute, and cancels it', async () => {
    vi.useFakeTimers();
    const { invoke, requests } = tdlib(() => 12 * 1024, new Promise(() => undefined), 48 * 1024);
    const outcome = downloadWithStallLimit(invoke, 7).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await outcome).toBe('downloading from Telegram made no progress for 60 seconds (12 of 48 KB received)');
    expect(requests).toContain('cancelDownloadFile');
  });

  // Detects: a TDLib that no longer answers at all (after a crash) also stopping the migration.
  it('gives up when TDLib does not answer at all', async () => {
    vi.useFakeTimers();
    const { invoke } = tdlib(null, new Promise(() => undefined), 0);
    const outcome = downloadWithStallLimit(invoke, 7).catch(() => 'given up');
    await vi.advanceTimersByTimeAsync(80_000);
    expect(await outcome).toBe('given up');
  });

  // Detects: a slow download that keeps receiving bytes taken for a stalled one.
  it('waits for a slow download that keeps making progress', async () => {
    vi.useFakeTimers();
    let received = 0;
    let finish: () => void = () => undefined;
    const complete = new Promise<void>((resolve) => (finish = resolve));
    const { invoke } = tdlib(() => (received += 1024), complete, 200 * 1024);
    let done = false;
    const outcome = downloadWithStallLimit(invoke, 7).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(150_000);
    expect(done).toBe(false);
    finish();
    await outcome;
    expect(done).toBe(true);
  });
});
