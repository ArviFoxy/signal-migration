// What survives a reload: the record, kept in the browser. It is computed from the state after every event
// (recordOf) and written when it changed, in order; each write is confirmed by an event (record/saved, record/
// failed), which the states that start something lasting wait for. A reload continues from it (app/loading.ts).

import type { StoredDevice } from '../services';
import { type Chosen, SETUP_STEPS, type SetupStep } from './app/steps';

export type Record = {
  version: 4;
  phase: 'setup' | 'migrating' | 'ending';
  /** The step asked for, in setup. */
  step: SetupStep;
  /** In the ending phase: why the migration ends. */
  why: 'finish' | 'clear' | null;
  /** The TDLib instance holding the Telegram login. */
  telegram: string | null;
  signal: StoredDevice | null;
  /** What the user chose to move. */
  chosen: Chosen;
  /** Telegram sticker set IDs the user deselected. */
  deselected: string[];
  /** Telegram user IDs of found friends the user unticked. */
  untickedFriends: number[];
};

/** The records of earlier versions, which a reload still continues from. Sticker packs were all they moved. */
type RecordVersion3 = Omit<Record, 'version' | 'chosen' | 'untickedFriends'> & { version: 3 };

type RecordVersion2 = {
  version: 2;
  phase: 'setup' | 'migrating' | 'finishing' | 'clearing';
  step: SetupStep;
  telegram: string | null;
  signal: StoredDevice | null;
  deselected: string[];
};

/** The record in `value` as read from the browser, or null when it is none that this version knows. */
export function readRecord(value: unknown): Record | null {
  const record = value as Record | RecordVersion3 | RecordVersion2 | null;
  if (!record || typeof record !== 'object' || !SETUP_STEPS.includes(record.step)) return null;
  const stickersOnly = { chosen: { stickers: true, friends: false }, untickedFriends: [] };
  if (record.version === 4 && ['setup', 'migrating', 'ending'].includes(record.phase)) return record;
  if (record.version === 3 && ['setup', 'migrating', 'ending'].includes(record.phase))
    return { ...record, version: 4, ...stickersOnly };
  if (record.version === 2 && ['setup', 'migrating', 'finishing', 'clearing'].includes(record.phase)) {
    const ending = record.phase === 'finishing' ? 'finish' : record.phase === 'clearing' ? 'clear' : null;
    return {
      ...stickersOnly,
      version: 4,
      phase: ending ? 'ending' : (record.phase as 'setup' | 'migrating'),
      step: record.step,
      why: ending,
      telegram: record.telegram,
      signal: record.signal,
      deselected: record.deselected,
    };
  }
  return null;
}

/** The record as text, to tell whether it changed. */
export const recordText = (record: Record | null): string =>
  JSON.stringify(record, (_, value) => (value instanceof Uint8Array ? Array.from(value) : value));
