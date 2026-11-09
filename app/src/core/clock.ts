// Time as the migration sees it: the real clock in the app, a simulated one in tests, so that waits of hours
// (Signal's upload limit, upload claims) take no time in a test.

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};
