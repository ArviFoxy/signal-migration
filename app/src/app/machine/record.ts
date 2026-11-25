// What survives closing or reloading the tab: the record, kept in the browser. It is computed from the state after
// every event (recordOf) and written when it changed, in order; each write is confirmed by an event (record/saved,
// record/failed), which the states that start something lasting wait for. Reopening continues from it (app/loading.ts).

import {
  EMPTY_STICKER_PROGRESS,
  type PendingUploadedPack,
  type StickerRunProgress,
  type UploadLimitState,
} from '../../kinds/stickers/migration';
import type { StoredDevice } from '../services';
import { type Chosen, SETUP_STEPS, type SetupStep } from './app/steps';

export { EMPTY_STICKER_PROGRESS, type PendingUploadedPack, type StickerRunProgress, type UploadLimitState };

/** Completed Friends addition scoped to one Signal account (`aci`). */
export type FriendsAddedRecord = { aci: string; count: number };

/** Completed Saved Messages copy scoped to one Signal account (`aci`). */
export type SavedDoneRecord = { aci: string; copied: number };

export type Record = {
  version: 6;
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
  /** Telegram user IDs of found friends the user ticked. */
  tickedFriends: number[];
  /** Completed Friends addition for this migration; null until written and announced. */
  friendsAdded: FriendsAddedRecord | null;
  /** The saved messages are copied from this date on (seconds since 1970); null copies from the first message. */
  savedFrom: number | null;
  /** Telegram's ID of the last saved message that is in Signal; null before the first. */
  savedSentUpTo: number | null;
  /** Completed Saved Messages copy for this migration; null until every chosen message is in Signal. */
  savedDone: SavedDoneRecord | null;
  /** Sticker packs uploaded by this browser that are not yet installed in Signal storage. */
  pendingPacks: PendingUploadedPack[];
  /** Signal sticker upload rate-limit state for the linked Signal account. */
  uploadLimit: UploadLimitState | null;
  /** Telegram set IDs installed from another user's copy in the public index during this migration. */
  installedFromIndex: string[];
  /** Telegram set IDs uploaded by this migration. */
  uploadedPacks: string[];
  /** Number of packs this migration added to the public index. */
  addedToIndex: number;
};

/** The record before pending pack uploads, upload cooldowns, and kind-completion markers were persisted. */
type RecordVersion5 = Omit<
  Record,
  | 'version'
  | 'friendsAdded'
  | 'savedDone'
  | 'pendingPacks'
  | 'uploadLimit'
  | 'installedFromIndex'
  | 'uploadedPacks'
  | 'addedToIndex'
> & { version: 5 };

/** The record before saved messages could be moved. */
type RecordVersion4 = Omit<RecordVersion5, 'version' | 'chosen' | 'savedFrom' | 'savedSentUpTo'> & {
  version: 4;
  chosen: { stickers: boolean; friends: boolean };
};

/** The records of earlier versions, which reopening still continues from. Sticker packs were all they moved. */
type RecordVersion3 = Omit<RecordVersion4, 'version' | 'chosen' | 'tickedFriends'> & { version: 3 };

type RecordVersion2 = {
  version: 2;
  phase: 'setup' | 'migrating' | 'finishing' | 'clearing';
  step: SetupStep;
  telegram: string | null;
  signal: StoredDevice | null;
  deselected: string[];
};

const EMPTY_PROGRESS_FIELDS = {
  friendsAdded: null as FriendsAddedRecord | null,
  savedDone: null as SavedDoneRecord | null,
  pendingPacks: [] as PendingUploadedPack[],
  uploadLimit: null as UploadLimitState | null,
  installedFromIndex: [] as string[],
  uploadedPacks: [] as string[],
  addedToIndex: 0,
};

function readPendingPacks(value: unknown): PendingUploadedPack[] {
  if (!Array.isArray(value)) return [];
  const packs: PendingUploadedPack[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as PendingUploadedPack).setId === 'string' &&
      (item as PendingUploadedPack).packId instanceof Uint8Array &&
      (item as PendingUploadedPack).packKey instanceof Uint8Array &&
      typeof (item as PendingUploadedPack).listed === 'boolean'
    ) {
      const pack = item as PendingUploadedPack;
      packs.push({
        setId: pack.setId,
        packId: pack.packId.slice(),
        packKey: pack.packKey.slice(),
        listed: pack.listed,
      });
    }
  }
  return packs;
}

function readUploadLimit(value: unknown): UploadLimitState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as UploadLimitState;
  if (typeof candidate.aci !== 'string' || typeof candidate.intervalMs !== 'number' || candidate.intervalMs <= 0)
    return null;
  const allowedAt =
    typeof candidate.allowedAt === 'number' && Number.isFinite(candidate.allowedAt) ? candidate.allowedAt : null;
  return { aci: candidate.aci, allowedAt, intervalMs: candidate.intervalMs };
}

function readFriendsAdded(value: unknown): FriendsAddedRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as FriendsAddedRecord;
  if (typeof candidate.aci !== 'string' || typeof candidate.count !== 'number' || candidate.count < 0) return null;
  return { aci: candidate.aci, count: candidate.count };
}

function readSavedDone(value: unknown): SavedDoneRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as SavedDoneRecord;
  if (typeof candidate.aci !== 'string' || typeof candidate.copied !== 'number' || candidate.copied < 0) return null;
  return { aci: candidate.aci, copied: candidate.copied };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Extracts the sticker-run progress portion of a persisted record. */
export function stickerProgressOf(record: Record | null): StickerRunProgress {
  if (!record) return EMPTY_STICKER_PROGRESS;
  return {
    pendingPacks: record.pendingPacks.map((pack) => ({
      setId: pack.setId,
      packId: pack.packId.slice(),
      packKey: pack.packKey.slice(),
      listed: pack.listed,
    })),
    uploadLimit: record.uploadLimit ? { ...record.uploadLimit } : null,
    installedFromIndex: [...record.installedFromIndex],
    uploadedPacks: [...record.uploadedPacks],
    addedToIndex: record.addedToIndex,
  };
}

/** The record in `value` as read from the browser, or null when it is none that this version knows. */
export function readRecord(value: unknown): Record | null {
  const record = value as Record | RecordVersion5 | RecordVersion4 | RecordVersion3 | RecordVersion2 | null;
  if (!record || typeof record !== 'object' || !SETUP_STEPS.includes(record.step)) return null;
  const noSaved = { savedFrom: null, savedSentUpTo: null };
  const stickersOnly = { chosen: { stickers: true, friends: false, saved: false }, tickedFriends: [], ...noSaved };
  const phases = ['setup', 'migrating', 'ending'];
  if (record.version === 6 && phases.includes(record.phase)) {
    return {
      ...record,
      friendsAdded: readFriendsAdded(record.friendsAdded),
      savedDone: readSavedDone(record.savedDone),
      pendingPacks: readPendingPacks(record.pendingPacks),
      uploadLimit: readUploadLimit(record.uploadLimit),
      installedFromIndex: readStringArray(record.installedFromIndex),
      uploadedPacks: readStringArray(record.uploadedPacks),
      addedToIndex:
        typeof record.addedToIndex === 'number' && Number.isFinite(record.addedToIndex) && record.addedToIndex >= 0
          ? record.addedToIndex
          : 0,
    };
  }
  if (record.version === 5 && phases.includes(record.phase)) return { ...record, ...EMPTY_PROGRESS_FIELDS, version: 6 };
  if (record.version === 4 && phases.includes(record.phase))
    return { ...record, ...EMPTY_PROGRESS_FIELDS, version: 6, chosen: { ...record.chosen, saved: false }, ...noSaved };
  if (record.version === 3 && phases.includes(record.phase))
    return { ...record, ...EMPTY_PROGRESS_FIELDS, version: 6, ...stickersOnly };
  if (record.version === 2 && ['setup', 'migrating', 'finishing', 'clearing'].includes(record.phase)) {
    const ending = record.phase === 'finishing' ? 'finish' : record.phase === 'clearing' ? 'clear' : null;
    return {
      ...stickersOnly,
      ...EMPTY_PROGRESS_FIELDS,
      version: 6,
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
