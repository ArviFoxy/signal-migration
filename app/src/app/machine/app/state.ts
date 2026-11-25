// The app's state: one value, a union of the phases of the process. The setup, the migration and its end share the
// session: the Telegram login, the Signal device and the packs, each a machine of its own.
//
//   locking ─▶ loading ─▶ setup ─▶ migrating ─▶ ending ─▶ done
//      │          │         ▲                     │  ▲
//      ▼          ▼         │                     ▼  │ Try again
//   elsewhere  load-failed  └──── ending (clear) ◀── end-failed ── Forget it ──▶ done, or setup after a clear
//
// "Disconnect and clear" ends the same way as the migration's end, and then goes back to the start.

import type { SavedWait } from '../../../kinds/saved/copy';
import type { FriendsState } from '../friends/state';
import type { PacksState } from '../packs/state';
import type { FriendsAddedRecord, Record, SavedDoneRecord, StickerRunProgress } from '../record';
import type { SavedState } from '../saved/state';
import type { SignalState } from '../signal/state';
import type { TelegramState } from '../telegram/state';
import type { Chosen, SetupStep } from './steps';

export type Session = {
  telegram: TelegramState;
  signal: SignalState;
  /** What the user chose to move. */
  chosen: Chosen;
  packs: PacksState;
  /** Telegram sticker set IDs the user deselected, kept for when the packs are read again. */
  deselected: string[];
  /** Minimal sticker-migration progress kept across tab closes (pending uploads, cooldown, counts). */
  stickerProgress: StickerRunProgress;
  friends: FriendsState;
  /** Telegram user IDs of found friends the user ticked, kept for when the friends are looked for again. */
  tickedFriends: number[];
  /** Completed Friends addition for this migration (scoped by Signal ACI); null until written and announced. */
  friendsAdded: FriendsAddedRecord | null;
  saved: SavedState;
  /** The saved messages are copied from this date on (seconds since 1970); null copies from the first message. */
  savedFrom: number | null;
  /**
   * Telegram's ID of the last saved message that is in Signal, so that a run continues behind it; null before the
   * first.
   */
  savedSentUpTo: number | null;
  /** Completed Saved Messages copy for this migration (scoped by Signal ACI); null until every message is sent. */
  savedDone: SavedDoneRecord | null;
  /** Something the user should know, until dismissed: TDLib was restarted, the record could not be written. */
  notice: string | null;
};

/**
 * The migration run; `attempt` counts the runs, so that each is new work. `status` is that of the sticker packs' run.
 * `error`: why the last run stopped.
 */
export type Run = {
  attempt: number;
  status: 'running' | 'ended' | 'failed';
  error: string | null;
  /** Active rate-limit pause during Saved Messages copying; null/omitted while actively copying or idle. */
  savedWait?: SavedWait | null;
};

/** Why the migration ends: it finished, or the user asked to disconnect and clear. */
export type EndReason = 'finish' | 'clear';

export type AppState =
  /** Taking the lock that lets one tab run the migration. */
  | { kind: 'locking' }
  /** Another tab runs the migration; this one waits until it closes. */
  | { kind: 'elsewhere' }
  /** Reading the record (`record` undefined), then deleting Telegram data that no login holds. */
  | { kind: 'loading'; record: Record | null | undefined; attempt: number }
  | { kind: 'load-failed'; error: string; attempt: number }
  /** Choosing what to migrate and connecting the accounts; `step` is the step the user asked for. */
  | (Session & { kind: 'setup'; step: SetupStep })
  | (Session & { kind: 'migrating'; run: Run })
  /** Signing out of Telegram and unlinking Signal. */
  | (Session & { kind: 'ending'; reason: EndReason })
  /** Not everything could be ended; `telegramError` and `signalError` say what failed. */
  | (Session & { kind: 'end-failed'; reason: EndReason; telegramError: string | null; signalError: string | null })
  /** Done, and logged out. The migration screen stays, in its final state. */
  | (Session & { kind: 'done' });

export type SessionState = Extract<AppState, { telegram: TelegramState }>;

export const isSession = (state: AppState): state is SessionState => 'telegram' in state;

/** The session part of a state. */
export const sessionOf = (state: SessionState): Session => ({
  telegram: state.telegram,
  signal: state.signal,
  chosen: state.chosen,
  packs: state.packs,
  deselected: state.deselected,
  stickerProgress: state.stickerProgress,
  friends: state.friends,
  tickedFriends: state.tickedFriends,
  friendsAdded: state.friendsAdded,
  saved: state.saved,
  savedFrom: state.savedFrom,
  savedSentUpTo: state.savedSentUpTo,
  savedDone: state.savedDone,
  notice: state.notice,
});
