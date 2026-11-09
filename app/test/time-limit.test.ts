import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeLimit } from '../src/core/time-limit';

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
});
