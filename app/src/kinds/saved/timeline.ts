// A timeline of Telegram's Saved Messages for choosing a cutoff day.
//
// Messages are grouped into calendar buckets so the user can see when they wrote most messages at a glance, while
// the cutoff itself moves at individual-day precision in the user's local time zone. All calendar arithmetic goes
// through Date(year, month, day + offset) and UTC-midnight day numbers so Daylight Saving Time transitions never
// skip or repeat a day.

import { reasonLeftOut, type SavedMessage } from './messages';

export type BucketUnit = 'day' | 'week' | 'month' | 'quarter';

/** One bar of the timeline histogram; `startDay` and `endDay` are day offsets from the first message's day. */
export type TimelineBucket = {
  startDay: number;
  endDay: number;
  /** Copyable text messages in this bucket. */
  text: number;
  /** Messages in this bucket not copied by this version (media, too long, other). */
  leftOut: number;
  total: number;
};

/** A calendar day in the user's local time zone. */
export type LocalDay = { year: number; month: number; day: number };

export type Timeline = {
  /** Local calendar day of the earliest message. */
  firstDay: LocalDay;
  /** Integer local day index of `firstDay` (days since 1970-01-01). */
  firstDayNumber: number;
  /** Local calendar day of the latest message. */
  lastDay: LocalDay;
  /** Latest message timestamp, in seconds since 1970. */
  lastDate: number;
  /** Number of calendar days from `firstDay` through `lastDay`, inclusive (at least 1). */
  spanDays: number;
  unit: BucketUnit;
  buckets: TimelineBucket[];
  /** Largest `total` across all buckets (at least 1). */
  maxBucket: number;
  /** Total number of messages in the chat. */
  totalMessages: number;
};

export type TimelinePreset = { id: 'all' | '1y' | '30d' | 'none'; label: string; dayOffset: number };

export type AxisTick = {
  dayOffset: number;
  label: string;
  align: 'start' | 'middle' | 'end';
  edge: boolean;
};

const MS_PER_DAY = 86_400_000;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const localDayOf = (seconds: number): LocalDay => {
  const date = new Date(seconds * 1000);
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
};

const dayNumberOf = (day: LocalDay): number => Math.round(Date.UTC(day.year, day.month, day.day) / MS_PER_DAY);

const dayNumberFromSeconds = (seconds: number): number => dayNumberOf(localDayOf(seconds));

/** Local midnight at `firstDay + dayOffset`, in seconds since 1970. */
export function dayStartSeconds(timeline: Pick<Timeline, 'firstDay'>, dayOffset: number): number {
  const { year, month, day } = timeline.firstDay;
  return Math.floor(new Date(year, month, day + dayOffset).getTime() / 1000);
}

/** Local calendar day at `firstDay + dayOffset`. */
export function localDayAt(timeline: Pick<Timeline, 'firstDay'>, dayOffset: number): LocalDay {
  const { year, month, day } = timeline.firstDay;
  const date = new Date(year, month, day + dayOffset);
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

/** "Oct 23, 2018": a short, unambiguous date label. */
export const formatDay = (day: LocalDay): string => `${SHORT_MONTHS[day.month]} ${day.day}, ${day.year}`;

/** Short unit label for the histogram's scale marker ("14 / mo"). */
export const UNIT_LABEL: Record<BucketUnit, string> = {
  day: 'day',
  week: 'wk',
  month: 'mo',
  quarter: 'qtr',
};

function chooseUnit(spanDays: number): BucketUnit {
  if (spanDays <= 90) return 'day';
  if (spanDays <= 630) return 'week';
  if (spanDays <= 3650) return 'month';
  return 'quarter';
}

/** Creates empty calendar buckets covering `[0, spanDays)`. */
function makeBuckets(firstDay: LocalDay, firstDayNumber: number, spanDays: number, unit: BucketUnit): TimelineBucket[] {
  const buckets: TimelineBucket[] = [];
  if (unit === 'day' || unit === 'week') {
    const step = unit === 'day' ? 1 : 7;
    for (let start = 0; start < spanDays; start += step) {
      buckets.push({ startDay: start, endDay: Math.min(spanDays, start + step), text: 0, leftOut: 0, total: 0 });
    }
    return buckets;
  }
  const monthStep = unit === 'month' ? 1 : 3;
  let year = firstDay.year;
  let month = unit === 'quarter' ? Math.floor(firstDay.month / 3) * 3 : firstDay.month;
  for (;;) {
    const startNumber = dayNumberOf({ year, month, day: 1 });
    const nextMonth = month + monthStep;
    const nextYear = year + Math.floor(nextMonth / 12);
    const wrappedMonth = nextMonth % 12;
    const endNumber = dayNumberOf({ year: nextYear, month: wrappedMonth, day: 1 });
    const startDay = Math.max(0, startNumber - firstDayNumber);
    const endDay = Math.min(spanDays, endNumber - firstDayNumber);
    if (startDay >= spanDays) break;
    if (endDay > startDay) buckets.push({ startDay, endDay, text: 0, leftOut: 0, total: 0 });
    year = nextYear;
    month = wrappedMonth;
  }
  return buckets;
}

/** Builds the timeline histogram for a non-empty list of saved messages. */
export function buildTimeline(messages: readonly SavedMessage[]): Timeline {
  if (messages.length === 0) throw new Error('a timeline needs at least one message');
  let firstDate = messages[0].date;
  let lastDate = messages[0].date;
  for (const message of messages) {
    if (message.date < firstDate) firstDate = message.date;
    if (message.date > lastDate) lastDate = message.date;
  }
  const firstDay = localDayOf(firstDate);
  const lastDay = localDayOf(lastDate);
  const firstDayNumber = dayNumberOf(firstDay);
  const lastDayNumber = dayNumberOf(lastDay);
  const spanDays = Math.max(1, lastDayNumber - firstDayNumber + 1);
  const unit = chooseUnit(spanDays);
  const buckets = makeBuckets(firstDay, firstDayNumber, spanDays, unit);

  // Assign each message to the bucket covering its local day.
  for (const message of messages) {
    const offset = Math.min(spanDays - 1, Math.max(0, dayNumberFromSeconds(message.date) - firstDayNumber));
    // Binary search on sorted disjoint buckets.
    let low = 0;
    let high = buckets.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (offset < buckets[mid].endDay) high = mid;
      else low = mid + 1;
    }
    const bucket = buckets[low];
    if (reasonLeftOut(message) === null) bucket.text++;
    else bucket.leftOut++;
    bucket.total++;
  }

  let maxBucket = 1;
  for (const bucket of buckets) if (bucket.total > maxBucket) maxBucket = bucket.total;
  return {
    firstDay,
    firstDayNumber,
    lastDay,
    lastDate,
    spanDays,
    unit,
    buckets,
    maxBucket,
    totalMessages: messages.length,
  };
}

/**
 * The `savedFrom` timestamp for a slider day offset: null at day 0 (all messages), local midnight for an
 * intermediate day, and strictly after `lastDate` at `spanDays` (no messages).
 */
export function fromForDayOffset(timeline: Timeline, dayOffset: number): number | null {
  if (dayOffset <= 0) return null;
  if (dayOffset >= timeline.spanDays)
    return Math.max(dayStartSeconds(timeline, timeline.spanDays), timeline.lastDate + 1);
  return dayStartSeconds(timeline, dayOffset);
}

/** The slider day offset corresponding to a stored `savedFrom` timestamp (0 for null, `spanDays` past the end). */
export function dayOffsetForFrom(timeline: Timeline, from: number | null): number {
  if (from === null) return 0;
  if (from > timeline.lastDate) return timeline.spanDays;
  if (from <= dayStartSeconds(timeline, 0)) return 0;
  return Math.min(timeline.spanDays, Math.max(0, dayNumberFromSeconds(from) - timeline.firstDayNumber));
}

/** Quick-selection presets appropriate for the timeline's span. */
export function presetsFor(timeline: Timeline): TimelinePreset[] {
  const presets: TimelinePreset[] = [{ id: 'all', label: 'All', dayOffset: 0 }];
  if (timeline.spanDays > 365) {
    const { year, month, day } = timeline.lastDay;
    const ago = new Date(year - 1, month, day);
    const oneYearAgo = dayNumberOf({ year: ago.getFullYear(), month: ago.getMonth(), day: ago.getDate() });
    const offset = Math.min(timeline.spanDays - 1, Math.max(1, oneYearAgo - timeline.firstDayNumber));
    presets.push({ id: '1y', label: 'Last year', dayOffset: offset });
  } else if (timeline.spanDays > 35) {
    presets.push({ id: '30d', label: 'Last 30 days', dayOffset: timeline.spanDays - 30 });
  }
  presets.push({ id: 'none', label: 'None', dayOffset: timeline.spanDays });
  return presets;
}

/**
 * Non-overlapping time axis ticks for a plot of `plotWidth` pixels: start and end dates at the edges, plus
 * calendar boundaries in between.
 */
export function axisTicks(timeline: Timeline, plotWidth: number): AxisTick[] {
  const { firstDay, firstDayNumber, lastDay, spanDays } = timeline;
  if (spanDays === 1) {
    return [{ dayOffset: 0, label: formatDay(firstDay), align: 'start', edge: true }];
  }
  const compact = plotWidth < 400;
  const edgeLabel = (day: LocalDay) =>
    compact && spanDays > 365 ? `${SHORT_MONTHS[day.month]} ${day.year}` : formatDay(day);
  const startLabel = edgeLabel(firstDay);
  const endLabel = edgeLabel(lastDay);
  const edgeMargin = Math.max(58, Math.max(startLabel.length, endLabel.length) * 6.8 + 12);
  const minGap = compact ? 50 : 54;
  const xOf = (offset: number) => (offset / spanDays) * plotWidth;

  const candidates: { dayOffset: number; label: string }[] = [];
  if (spanDays > 500) {
    const years = lastDay.year - firstDay.year;
    const step = years > 16 ? 5 : years > 8 || (years > 4 && compact) ? 2 : 1;
    const firstYear = firstDay.year + 1;
    const alignedStart = step > 1 ? Math.ceil(firstYear / step) * step : firstYear;
    for (let year = alignedStart; year <= lastDay.year; year += step) {
      const offset = dayNumberOf({ year, month: 0, day: 1 }) - firstDayNumber;
      if (offset > 0 && offset < spanDays) candidates.push({ dayOffset: offset, label: String(year) });
    }
  } else if (spanDays > 90) {
    const step = spanDays > 300 ? 3 : spanDays > 180 ? 2 : 1;
    let year = firstDay.year;
    let month = firstDay.month + 1;
    if (month >= 12) {
      year++;
      month = 0;
    }
    if (step > 1) {
      const rem = month % step;
      if (rem !== 0) {
        month += step - rem;
        if (month >= 12) {
          year++;
          month -= 12;
        }
      }
    }
    for (;;) {
      const offset = dayNumberOf({ year, month, day: 1 }) - firstDayNumber;
      if (offset >= spanDays) break;
      if (offset > 0) {
        const label = month === 0 ? `${SHORT_MONTHS[0]} ${year}` : SHORT_MONTHS[month];
        candidates.push({ dayOffset: offset, label });
      }
      month += step;
      if (month >= 12) {
        year += Math.floor(month / 12);
        month %= 12;
      }
    }
  } else if (spanDays > 10) {
    const step = spanDays > 56 ? 14 : spanDays > 21 ? 7 : 3;
    for (let offset = step; offset < spanDays; offset += step) {
      const day = localDayAt(timeline, offset);
      candidates.push({ dayOffset: offset, label: `${SHORT_MONTHS[day.month]} ${day.day}` });
    }
  }

  const middle: AxisTick[] = [];
  let lastX = -Infinity;
  for (const candidate of candidates) {
    const x = xOf(candidate.dayOffset);
    if (x < edgeMargin || x > plotWidth - edgeMargin) continue;
    if (x - lastX < minGap) continue;
    middle.push({ dayOffset: candidate.dayOffset, label: candidate.label, align: 'middle', edge: false });
    lastX = x;
  }

  return [
    { dayOffset: 0, label: startLabel, align: 'start', edge: true },
    ...middle,
    { dayOffset: spanDays, label: endLabel, align: 'end', edge: true },
  ];
}
