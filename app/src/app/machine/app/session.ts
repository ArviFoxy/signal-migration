// What the phases with a session share: passing events to the machines, the rules that follow from the state, and
// the work the session describes.

import type { Context } from '../core';
import type { AppEvent } from '../events';
import { packsTransition, type PacksEvent, type PacksState } from '../packs';
import { signalTransition, signalWork, type SignalEvent, type SignalState } from '../signal';
import { telegramTransition, telegramWork, type TelegramEvent, type TelegramState } from '../telegram';
import type { Work } from '../work';
import { type EndReason, type Session, type SessionState, sessionOf } from './state';
import { setupStepShown, type Step } from './steps';

const isTelegramEvent = (event: AppEvent): event is TelegramEvent =>
  event.type.startsWith('telegram/') || event.type.startsWith('record/');
const isSignalEvent = (event: AppEvent): event is SignalEvent => event.type.startsWith('signal/');
const isPacksEvent = (event: AppEvent): event is PacksEvent => event.type.startsWith('packs/');

/** The notice an event brings, or the current one. */
function noticeAfter(notice: string | null, event: AppEvent): string | null {
  if (event.type === 'telegram/fatal')
    return event.restarted
      ? `Telegram's library stopped after an internal error and was restarted. (TDLib: ${event.error})`
      : `Telegram's library stopped after an internal error. (TDLib: ${event.error})`;
  if (event.type === 'record/failed') return `This browser could not keep the migration's progress: ${event.error}`;
  if (event.type === 'dismiss') return null;
  return notice;
}

const withoutError = <S extends { error?: string | null }>(state: S): S =>
  'error' in state && state.error ? { ...state, error: null } : state;

/** Passes `event` to the session's machines; each ignores the events that are not its own. */
export function toMachines<S extends SessionState>(state: S, event: AppEvent, context: Context): S {
  let { telegram, signal, packs } = state;
  if (isTelegramEvent(event)) telegram = telegramTransition(telegram, event, context);
  if (isSignalEvent(event)) signal = signalTransition(signal, event, context);
  if (isPacksEvent(event)) packs = packsTransition(packs, event, context);
  if (event.type === 'dismiss') {
    // Errors that offer nothing to do; a stopped login keeps its error, which goes with "Try again".
    if (telegram.kind === 'off' || telegram.kind === 'signed-in') telegram = withoutError(telegram);
    if (signal.kind === 'off' || signal.kind === 'linked') signal = withoutError(signal);
  }
  let notice = noticeAfter(state.notice, event);
  // Telegram ended a login of this visit and the page has removed it: the sign-in that follows says why.
  if (state.telegram.kind === 'deleting' && state.telegram.byTelegram && telegram.kind === 'off')
    notice = 'Telegram ended the last login. Sign in again.';
  if (telegram === state.telegram && signal === state.signal && packs === state.packs && notice === state.notice)
    return state;
  return { ...state, telegram, signal, packs, notice };
}

export { sessionOf };

export const signedInInstance = (telegram: TelegramState): string | null =>
  telegram.kind === 'signed-in' ? telegram.instance : null;

export const linkedDevice = (signal: SignalState) =>
  signal.kind === 'linked' || signal.kind === 'unlinking' ? signal.device : null;

/** The step on screen in a state with a session. */
export function stepOf(state: SessionState): Step {
  switch (state.kind) {
    case 'setup':
      return setupStepShown(state.step, signedInInstance(state.telegram) !== null, linkedDevice(state.signal) !== null);
    case 'ending':
    case 'end-failed':
      return state.reason === 'clear' ? 'start' : 'migrate';
    case 'migrating':
    case 'done':
      return 'migrate';
  }
}

/** The packs follow the login: read for each new signed-in instance, dropped when there is none. */
export function packsFollowLogin(session: Session): Session {
  const instance = signedInInstance(session.telegram);
  const packs = session.packs;
  const current = packs.kind === 'none' ? null : packs.instance;
  if (instance === current) return session;
  if (!instance && session.telegram.kind === 'saving') return session;
  const deselected =
    packs.kind === 'read'
      ? packs.migration.entries.filter((entry) => !entry.selected).map((entry) => entry.pack.setId)
      : session.deselected;
  const next: PacksState = instance ? { kind: 'reading', instance, attempt: 1 } : { kind: 'none' };
  return { ...session, packs: next, deselected };
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
  const packs: PacksState = reason === 'clear' ? { kind: 'none' } : state.packs;
  const deselected = reason === 'clear' ? [] : state.deselected;
  return { kind: 'ending', reason, telegram, signal, packs, deselected, notice: state.notice };
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
    packs: { kind: 'none' },
    deselected: [],
    notice: state.notice,
  };
}

/** The work of the session's machines, and of the packs, which needs the Signal device too. */
export function sessionWork(state: SessionState): Work[] {
  const work = [...telegramWork(state.telegram), ...signalWork(state.signal)];
  const packs = state.packs;
  const active = state.kind === 'setup' || state.kind === 'migrating';
  if (!active) return work;
  if (packs.kind === 'reading')
    work.push({
      kind: 'read-packs',
      key: `read-packs:${packs.instance}:${packs.attempt}`,
      instance: packs.instance,
      deselected: state.deselected,
    });
  if (packs.kind !== 'read') return work;
  if (state.kind === 'setup')
    work.push({
      kind: 'load-previews',
      key: `previews:${packs.instance}:${packs.attempt}`,
      instance: packs.instance,
      migration: packs.migration,
    });
  const device = state.signal.kind === 'linked' ? state.signal.device : null;
  if (device && packs.signalRead !== device.deviceId && !packs.signalError)
    work.push({
      kind: 'read-signal',
      key: `read-signal:${device.deviceId}:${packs.signalAttempt}`,
      migration: packs.migration,
      device,
    });
  return work;
}
