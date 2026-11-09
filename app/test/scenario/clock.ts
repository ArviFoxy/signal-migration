// Simulated time. Sleeping advances the clock at once, running anything scheduled in between, so a scenario with
// hours of rate-limit waits finishes in milliseconds. Only one task sleeps at a time in the migration, so the
// clock is a single timeline.

import type { Clock } from '../../src/core/clock';

export class VirtualClock implements Clock {
  #time = Date.UTC(2026, 10, 9, 12, 0, 0);
  #events: { at: number; run: () => void | Promise<void> }[] = [];

  now(): number {
    return this.#time;
  }

  /** Runs `run` when the clock reaches `ms` from now. */
  after(ms: number, run: () => void | Promise<void>): void {
    this.#events.push({ at: this.#time + ms, run });
  }

  async sleep(ms: number): Promise<void> {
    await this.advance(ms);
  }

  /** Moves the clock forward by `ms`, running the scheduled events that fall within it, in time order. */
  async advance(ms: number): Promise<void> {
    const target = this.#time + Math.max(0, ms);
    for (;;) {
      this.#events.sort((a, b) => a.at - b.at);
      const next = this.#events[0];
      if (!next || next.at > target) break;
      this.#events.shift();
      this.#time = Math.max(this.#time, next.at);
      await next.run();
    }
    this.#time = target;
    await Promise.resolve();
  }
}

/** The page closed: thrown by a page clock when the migration would wait longer than the user stays. */
export class PageClosed extends Error {
  constructor() {
    super('the page was closed');
  }
}

/** One visit's view of the clock. With `leaveAfterWaitOf`, the user closes the page instead of waiting that long. */
export class PageClock implements Clock {
  constructor(
    readonly clock: VirtualClock,
    readonly leaveAfterWaitOf: number | null = null,
  ) {}

  now(): number {
    return this.clock.now();
  }

  async sleep(ms: number): Promise<void> {
    if (this.leaveAfterWaitOf !== null && ms > this.leaveAfterWaitOf) throw new PageClosed();
    await this.clock.sleep(ms);
  }
}
