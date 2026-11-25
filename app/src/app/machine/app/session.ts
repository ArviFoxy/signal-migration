// What the phases with a session share: passing events to the machines, the rules that follow from the state, and
// the work the session describes.

import type { Context } from '../core';
import type { AppEvent } from '../events';
import { friendsTransition, type FriendsEvent, type FriendsState } from '../friends';
import { packsTransition, type PacksEvent, type PacksState } from '../packs';
import { EMPTY_STICKER_PROGRESS, type SavedDoneRecord } from '../record';
import { savedTransition, type SavedEvent, type SavedState } from '../saved';
import { signalTransition, signalWork, type SignalEvent, type SignalState } from '../signal';
import { telegramTransition, telegramWork, type TelegramEvent, type TelegramState } from '../telegram';
import type { Work } from '../work';
import { type EndReason, type Session, type SessionState, sessionOf } from './state';
import { type Chosen, setupStepShown, type Step } from './steps';

/** What a new visit starts with: sticker packs. Looking for friends asks Signal about phone numbers, so the user chooses it. */
export const INITIAL_CHOICE: Chosen = { stickers: true, friends: false, saved: false };

const isTelegramEvent = (event: AppEvent): event is TelegramEvent =>
  event.type.startsWith('telegram/') || event.type.startsWith('record/');
const isSignalEvent = (event: AppEvent): event is SignalEvent => event.type.startsWith('signal/');
const isPacksEvent = (event: AppEvent): event is PacksEvent => event.type.startsWith('packs/');
const isFriendsEvent = (event: AppEvent): event is FriendsEvent => event.type.startsWith('friends/');
const isSavedEvent = (event: AppEvent): event is SavedEvent => event.type.startsWith('saved/');

/** The notice an event brings, or the current one. */
function noticeAfter(notice: string | null, event: AppEvent, state: SessionState): string | null {
  if (event.type === 'telegram/fatal')
    return event.restarted
      ? `Telegram's library stopped after an internal error and was restarted. (TDLib: ${event.error})`
      : `Telegram's library stopped after an internal error. (TDLib: ${event.error})`;
  if (event.type === 'signal/unlinked-from-phone' && state.signal.kind === 'linked')
    return 'Signal was unlinked from your phone. Link it again to continue.';
  if (event.type === 'record/failed') return `This browser could not keep the migration's progress: ${event.error}`;
  if (event.type === 'dismiss') return null;
  return notice;
}

const withoutError = <S extends { error?: string | null }>(state: S): S =>
  'error' in state && state.error ? { ...state, error: null } : state;

/** Passes `event` to the session's machines; each ignores the events that are not its own. */
export function toMachines<S extends SessionState>(state: S, event: AppEvent, context: Context): S {
  let { telegram, signal, packs, friends, tickedFriends, friendsAdded, saved } = state;
  if (isTelegramEvent(event)) telegram = telegramTransition(telegram, event, context);
  if (isSignalEvent(event)) signal = signalTransition(signal, event, context);
  if (isPacksEvent(event)) packs = packsTransition(packs, event, context);
  if (isFriendsEvent(event)) friends = friendsTransition(friends, event, context);
  if (isSavedEvent(event)) saved = savedTransition(saved, event, context);
  if (event.type === 'tick-friends') {
    const others = tickedFriends.filter((userId) => !event.userIds.includes(userId));
    const nextTicked = event.ticked ? [...others, ...event.userIds] : others;
    const prevSet = new Set(tickedFriends);
    const changed = nextTicked.length !== prevSet.size || nextTicked.some((id) => !prevSet.has(id));
    if (changed) {
      tickedFriends = nextTicked;
      friendsAdded = null;
    }
  }
  if (event.type === 'dismiss') {
    // Errors that offer nothing to do; a stopped login keeps its error, which goes with "Try again".
    if (telegram.kind === 'off' || telegram.kind === 'signed-in') telegram = withoutError(telegram);
    if (signal.kind === 'off' || signal.kind === 'linked') signal = withoutError(signal);
  }
  let notice = noticeAfter(state.notice, event, state);
  // Telegram ended a login of this visit and the page has removed it: the sign-in that follows says why.
  if (state.telegram.kind === 'deleting' && state.telegram.byTelegram && telegram.kind === 'off')
    notice = 'Telegram ended the last login. Sign in again.';
  const same =
    telegram === state.telegram &&
    signal === state.signal &&
    packs === state.packs &&
    friends === state.friends &&
    tickedFriends === state.tickedFriends &&
    friendsAdded === state.friendsAdded &&
    saved === state.saved &&
    notice === state.notice;
  return same ? state : { ...state, telegram, signal, packs, friends, tickedFriends, friendsAdded, saved, notice };
}

export { sessionOf };

export const signedInInstance = (telegram: TelegramState): string | null =>
  telegram.kind === 'signed-in' ? telegram.instance : null;

export const linkedDevice = (signal: SignalState) =>
  signal.kind === 'linked' || signal.kind === 'unlinking' ? signal.device : null;

/** Completed Friends count for the active Signal account (or preserved final count after unlinking at finish). */
export function friendsAddedFor(state: Pick<Session, 'signal' | 'friendsAdded'>): number | null {
  if (!state.friendsAdded) return null;
  const device = linkedDevice(state.signal);
  if (!device) return state.friendsAdded.count;
  return device.aci === state.friendsAdded.aci ? state.friendsAdded.count : null;
}

/** Completed Saved Messages summary for the active Signal account (or preserved final summary after unlinking). */
export function savedDoneFor(state: Pick<Session, 'signal' | 'savedDone'>): SavedDoneRecord | null {
  if (!state.savedDone) return null;
  const device = linkedDevice(state.signal);
  if (!device) return state.savedDone;
  return device.aci === state.savedDone.aci ? state.savedDone : null;
}

/** The step on screen in a state with a session. */
export function stepOf(state: SessionState): Step {
  switch (state.kind) {
    case 'setup':
      return setupStepShown(
        state.step,
        signedInInstance(state.telegram) !== null,
        linkedDevice(state.signal) !== null,
        state.chosen,
      );
    case 'ending':
    case 'end-failed':
      return state.reason === 'clear' ? 'start' : 'migrate';
    case 'migrating':
    case 'done':
      return 'migrate';
  }
}

/**
 * The packs follow the login: read for each new signed-in instance, dropped when there is none. They are not read
 * at all when the user did not choose sticker packs. When Signal is unlinked, `signalRead` is cleared so a newly
 * linked account always re-reads its installed packs.
 */
export function packsFollowLogin(session: Session): Session {
  const instance = session.chosen.stickers ? signedInInstance(session.telegram) : null;
  const packs = session.packs;
  const current = packs.kind === 'none' ? null : packs.instance;
  if (instance === current) {
    if (
      packs.kind === 'read' &&
      session.signal.kind === 'off' &&
      (packs.signalRead !== null || packs.signalError !== null)
    ) {
      return { ...session, packs: { ...packs, signalRead: null, signalError: null } };
    }
    return session;
  }
  if (!instance && session.telegram.kind === 'saving') return session;
  const deselected =
    packs.kind === 'read'
      ? packs.migration.entries.filter((entry) => !entry.selected).map((entry) => entry.pack.setId)
      : session.deselected;
  const stickerProgress = packs.kind === 'read' ? packs.migration.snapshotProgress() : session.stickerProgress;
  const next: PacksState = instance ? { kind: 'reading', instance, attempt: 1, progress: null } : { kind: 'none' };
  return { ...session, packs: next, deselected, stickerProgress };
}

/**
 * The friends follow both accounts: looked for once friends are chosen, Telegram is signed in and a Signal device is
 * linked, and again for another login or device lifetime. Without one of the three there is no search. When `skip`
 * is true (already finished for this account in `migrating`), reopening does not re-scan Telegram or Signal CDSI.
 */
export function friendsFollowAccounts(session: Session, skip = false): Session {
  const instance = signedInInstance(session.telegram);
  const linked = session.signal.kind === 'linked' ? session.signal : null;
  const friends = session.friends;
  if (!session.chosen.friends || !instance || !linked) {
    if (friends.kind === 'none') return session;
    // A login being saved, or a device being unlinked at the end, is not gone yet.
    if (session.chosen.friends && (session.telegram.kind === 'saving' || session.signal.kind === 'unlinking'))
      return session;
    return { ...session, friends: { kind: 'none' } };
  }
  if (skip && friends.kind === 'none') return session;
  if (friends.kind !== 'none' && friends.instance === instance && friends.deviceKey === linked.deviceKey)
    return session;
  const looking: FriendsState = {
    kind: 'looking',
    instance,
    deviceKey: linked.deviceKey,
    attempt: 1,
    progress: null,
  };
  return { ...session, friends: looking };
}

/**
 * The saved messages follow the login, as the packs do: read for each new signed-in instance when the user chose
 * them, dropped when there is no login. When `skip` is true (already finished for this account in `migrating`),
 * reopening does not re-paginate Telegram Saved Messages history.
 */
export function savedFollowLogin(session: Session, skip = false): Session {
  const instance = session.chosen.saved ? signedInInstance(session.telegram) : null;
  const saved = session.saved;
  const current = saved.kind === 'none' ? null : saved.instance;
  if (instance === current) return session;
  if (!instance && session.telegram.kind === 'saving') return session;
  if (skip && saved.kind === 'none') return session;
  const next: SavedState = instance ? { kind: 'reading', instance, attempt: 1, read: 0 } : { kind: 'none' };
  return { ...session, saved: next };
}

/** A Signal device linked by an earlier version is unlinked, so that the user links again. */
export function unlinkOldDevice(session: Session, context: Context): Session {
  const signal = session.signal;
  if (signal.kind !== 'linked' || signal.device.identityPrivate || signal.error) return session;
  return { ...session, signal: signalTransition(signal, { type: 'signal/unlink', reason: 'old-version' }, context) };
}

/** Starts ending: signs out of Telegram and unlinks Signal. A clear also drops the packs. */
export function beginEnding(state: SessionState, reason: EndReason, context: Context): SessionState {
  const signal =
    state.signal.kind === 'linking'
      ? signalTransition(state.signal, { type: 'signal/cancel' }, context)
      : signalTransition(
          state.signal,
          { type: 'signal/unlink', reason: reason === 'finish' ? 'at-finish' : 'by-user' },
          context,
        );
  const telegram = telegramTransition(state.telegram, { type: 'telegram/stop' }, context);
  const cleared = reason === 'clear';
  const stickerProgress = cleared
    ? EMPTY_STICKER_PROGRESS
    : state.packs.kind === 'read'
      ? state.packs.migration.snapshotProgress()
      : state.stickerProgress;
  return {
    kind: 'ending',
    reason,
    telegram,
    signal,
    chosen: cleared ? INITIAL_CHOICE : state.chosen,
    packs: cleared ? { kind: 'none' } : state.packs,
    deselected: cleared ? [] : state.deselected,
    stickerProgress,
    friends: cleared ? { kind: 'none' } : state.friends,
    tickedFriends: cleared ? [] : state.tickedFriends,
    friendsAdded: cleared ? null : state.friendsAdded,
    saved: cleared ? { kind: 'none' } : state.saved,
    savedFrom: cleared ? null : state.savedFrom,
    savedSentUpTo: cleared ? null : state.savedSentUpTo,
    savedDone: cleared ? null : state.savedDone,
    notice: state.notice,
  };
}

/** A new session, after a clear. */
export function freshSession(state: Session): Session {
  return {
    telegram: {
      kind: 'off',
      method: state.telegram.method,
      signedOut: state.telegram.kind === 'off' && state.telegram.signedOut,
      error: null,
    },
    signal: state.signal,
    chosen: INITIAL_CHOICE,
    packs: { kind: 'none' },
    deselected: [],
    stickerProgress: EMPTY_STICKER_PROGRESS,
    friends: { kind: 'none' },
    tickedFriends: [],
    friendsAdded: null,
    saved: { kind: 'none' },
    savedFrom: null,
    savedSentUpTo: null,
    savedDone: null,
    notice: state.notice,
  };
}

/** The work of the session's machines, and of the packs, which needs the Signal device too. */
export function sessionWork(state: SessionState): Work[] {
  const work = [...telegramWork(state.telegram), ...signalWork(state.signal)];
  const packs = state.packs;
  const active = state.kind === 'setup' || state.kind === 'migrating';
  if (!active) return work;
  const friends = state.friends;
  if (friends.kind === 'looking' && state.signal.kind === 'linked')
    work.push({
      kind: 'find-friends',
      key: `find-friends:${friends.instance}:${friends.deviceKey}:${friends.attempt}`,
      instance: friends.instance,
      deviceKey: state.signal.deviceKey,
      device: state.signal.device,
    });
  if (friends.kind === 'found' && state.kind === 'setup')
    work.push({
      kind: 'load-friend-photos',
      key: `friend-photos:${friends.instance}:${friends.deviceKey}:${friends.attempt}`,
      instance: friends.instance,
      search: friends.search,
    });
  const saved = state.saved;
  if (saved.kind === 'reading')
    work.push({ kind: 'read-saved', key: `read-saved:${saved.instance}:${saved.attempt}`, instance: saved.instance });
  if (packs.kind === 'reading')
    work.push({
      kind: 'read-packs',
      key: `read-packs:${packs.instance}:${packs.attempt}`,
      instance: packs.instance,
      deselected: state.deselected,
      progress: state.stickerProgress,
    });
  if (packs.kind !== 'read') return work;
  if (state.kind === 'setup')
    work.push({
      kind: 'load-previews',
      key: `previews:${packs.instance}:${packs.attempt}`,
      instance: packs.instance,
      migration: packs.migration,
    });
  const linked = state.signal.kind === 'linked' ? state.signal : null;
  if (linked && packs.signalRead !== linked.deviceKey && !packs.signalError)
    work.push({
      kind: 'read-signal',
      key: `read-signal:${linked.deviceKey}:${packs.signalAttempt}`,
      migration: packs.migration,
      deviceKey: linked.deviceKey,
      device: linked.device,
    });
  return work;
}
