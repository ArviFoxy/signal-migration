// The Saved Messages timeline (kinds/saved/timeline.ts): calendar bucketing, individual-day cutoff mapping, presets
// and non-overlapping axis ticks.

import { describe, expect, it } from 'vitest';
import { messagesToCopy } from '../../../src/kinds/saved/copy';
import type { SavedMessage } from '../../../src/kinds/saved/messages';
import {
  axisTicks,
  buildTimeline,
  dayOffsetForFrom,
  fromForDayOffset,
  presetsFor,
} from '../../../src/kinds/saved/timeline';

const localSec = (year: number, month: number, day: number, hour = 12) =>
  Math.floor(new Date(year, month - 1, day, hour).getTime() / 1000);

const msg = (number: number, date: number, parts: Partial<SavedMessage> = {}): SavedMessage => ({
  id: number * 2 ** 20,
  date,
  kind: 'text',
  body: `note ${number}`,
  styles: [],
  ...parts,
});

describe('Saved Messages timeline', () => {
  // Detects: messages being dropped or double-counted across buckets, or copyable vs left-out splits disagreeing with
  // the total.
  it('assigns every message to one bucket and separates copyable messages from left-out kinds', () => {
    const messages = [
      msg(1, localSec(2020, 1, 5)),
      msg(2, localSec(2020, 1, 20), {
        kind: 'photo',
        media: { fileId: 1, remoteId: 'r1', size: 120_000, contentType: 'image/jpeg' },
      }),
      msg(3, localSec(2023, 6, 15), {
        kind: 'file',
        media: { fileId: 2, remoteId: 'r2', size: 110 * 1024 * 1024, contentType: 'application/zip' },
      }),
      msg(4, localSec(2026, 9, 12), { kind: 'other', body: '' }),
    ];
    const timeline = buildTimeline(messages);
    expect(timeline.unit).toBe('month');
    const totals = timeline.buckets.reduce(
      (sum, bucket) => ({
        copyable: sum.copyable + bucket.copyable,
        leftOut: sum.leftOut + bucket.leftOut,
        total: sum.total + bucket.total,
      }),
      { copyable: 0, leftOut: 0, total: 0 },
    );
    expect(totals).toEqual({ copyable: 2, leftOut: 2, total: 4 });
    expect(timeline.buckets.every((bucket) => bucket.total === bucket.copyable + bucket.leftOut)).toBe(true);
  });

  // Detects: a cutoff day offset failing to round-trip through savedFrom, or day 0 / spanDays failing to select all /
  // none of the messages.
  it('maps day 0 to all messages, spanDays to none, and round-trips every intermediate day', () => {
    const messages = [
      msg(1, localSec(2024, 3, 1, 9)),
      msg(2, localSec(2024, 3, 10, 14)),
      msg(3, localSec(2024, 3, 31, 23)),
      msg(4, localSec(2024, 4, 2, 18)),
    ];
    const timeline = buildTimeline(messages);
    expect(timeline.spanDays).toBe(33);

    // Day 0 -> null (all messages).
    const allFrom = fromForDayOffset(timeline, 0);
    expect(allFrom).toBeNull();
    expect(dayOffsetForFrom(timeline, allFrom)).toBe(0);
    expect(messagesToCopy(messages, allFrom)).toHaveLength(4);

    // spanDays -> strictly after last message (no messages).
    const noneFrom = fromForDayOffset(timeline, timeline.spanDays);
    expect(noneFrom).not.toBeNull();
    expect(messagesToCopy(messages, noneFrom)).toHaveLength(0);
    expect(dayOffsetForFrom(timeline, noneFrom)).toBe(timeline.spanDays);

    // Every intermediate day (including across spring DST) round-trips exactly.
    for (let offset = 1; offset < timeline.spanDays; offset++) {
      const from = fromForDayOffset(timeline, offset);
      expect(dayOffsetForFrom(timeline, from)).toBe(offset);
    }

    // Cutting at Mar 10 includes Mar 10, Mar 31, Apr 2 and excludes Mar 1.
    const mar10 = fromForDayOffset(timeline, 9);
    expect(messagesToCopy(messages, mar10).map((m) => m.id)).toEqual([messages[1].id, messages[2].id, messages[3].id]);
  });

  // Detects: a single-day chat crashing or dividing by zero when building buckets, presets, or ticks.
  it('handles messages all sent on a single day', () => {
    const messages = [msg(1, localSec(2026, 5, 10, 8)), msg(2, localSec(2026, 5, 10, 21))];
    const timeline = buildTimeline(messages);
    expect(timeline.spanDays).toBe(1);
    expect(timeline.buckets).toHaveLength(1);
    expect(timeline.buckets[0].total).toBe(2);
    expect(presetsFor(timeline).map((p) => p.id)).toEqual(['all', 'none']);
    expect(axisTicks(timeline, 320)).toHaveLength(1);
    expect(messagesToCopy(messages, fromForDayOffset(timeline, 0))).toHaveLength(2);
    expect(messagesToCopy(messages, fromForDayOffset(timeline, 1))).toHaveLength(0);
  });

  // Detects: intermediate year/month ticks colliding with start/end labels on narrow phone viewports.
  it('keeps axis tick labels separated on both phone and desktop widths', () => {
    const messages = [msg(1, localSec(2018, 10, 23)), msg(2, localSec(2026, 9, 12))];
    const timeline = buildTimeline(messages);
    for (const width of [310, 640]) {
      const ticks = axisTicks(timeline, width);
      expect(ticks[0].dayOffset).toBe(0);
      expect(ticks[ticks.length - 1].dayOffset).toBe(timeline.spanDays);
      for (let i = 1; i < ticks.length; i++) {
        const dx = ((ticks[i].dayOffset - ticks[i - 1].dayOffset) / timeline.spanDays) * width;
        expect(dx).toBeGreaterThanOrEqual(45);
      }
    }
  });
});
