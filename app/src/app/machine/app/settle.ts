// The rules that follow from the state rather than from an event, applied after every event until none applies:
// - setup: a Telegram login starts on the Telegram step, a QR code for Signal shows on the Signal step and stops
//   when it is left;
// - setup and migrating: the packs follow the login; a device linked by an earlier version is unlinked;
// - migrating: a lost login goes back to the setup; once every selected pack is in Signal and the other devices were
//   told, the migration ends;
// - ending: both parts are driven to their end; then done (or the start, after a clear), or end-failed.
// Each rule is a pure function of the state.

import type { Context } from '../core';
import { signalTransition, type SignalState } from '../signal';
import { telegramTransition, type TelegramState } from '../telegram';
import {
  beginEnding,
  freshSession,
  friendsFollowAccounts,
  linkedDevice,
  packsFollowLogin,
  sessionOf,
  stepOf,
  unlinkOldDevice,
} from './session';
import { type AppState, isSession, type Session, type SessionState } from './state';

/** `state` with `session`'s parts, or `state` itself when they are the same. */
function withSession<S extends SessionState>(state: S, session: Session): S {
  const same = (Object.keys(session) as (keyof Session)[]).every((key) => session[key] === state[key]);
  return same ? state : { ...state, ...session };
}

function settleSetup(state: Extract<AppState, { kind: 'setup' }>, context: Context): AppState {
  let next = withSession(state, friendsFollowAccounts(packsFollowLogin(unlinkOldDevice(sessionOf(state), context))));
  const step = stepOf(next);
  if (step === 'telegram' && next.telegram.kind === 'off' && !next.telegram.error)
    next = { ...next, telegram: telegramTransition(next.telegram, { type: 'telegram/start' }, context) };
  if (step === 'signal' && next.signal.kind === 'off' && !next.signal.error)
    next = { ...next, signal: signalTransition(next.signal, { type: 'signal/link' }, context) };
  if (step !== 'signal' && next.signal.kind === 'linking')
    next = { ...next, signal: signalTransition(next.signal, { type: 'signal/cancel' }, context) };
  return next;
}

function settleMigrating(state: Extract<AppState, { kind: 'migrating' }>, context: Context): AppState {
  const next = withSession(state, friendsFollowAccounts(packsFollowLogin(unlinkOldDevice(sessionOf(state), context))));
  // A login lost during the migration (signed out elsewhere, unlinked from the phone): the setup shows the step to
  // log in again, and the user starts the migration again from the review. A login being restored after a reload
  // (starting, within its time limit) or saved is not lost.
  const telegramLost = !['starting', 'saving', 'signed-in'].includes(next.telegram.kind);
  if (telegramLost || next.signal.kind !== 'linked') return { ...sessionOf(next), kind: 'setup', step: 'review' };
  // Done once each chosen kind is done. Sticker packs: every pack is in Signal and the other devices were told; the
  // phone shows nothing otherwise. Friends: the contacts are written.
  if (next.chosen.friends && next.run.friendsAdded === null) return next;
  if (next.chosen.stickers) {
    const packs = next.packs;
    if (next.run.status !== 'ended' || packs.kind !== 'read') return next;
    const migration = packs.migration;
    if (!migration.selected.every((entry) => entry.state === 'in-signal') || migration.unannounced !== 0) return next;
  } else if (next.run.status === 'failed') {
    return next;
  }
  return beginEnding(next, 'finish', context);
}

/** A login state that is not on its way to its end, so the end asks for it again. */
function needsStop(telegram: TelegramState): boolean {
  switch (telegram.kind) {
    case 'creating':
    case 'login':
    case 'saving':
      return true;
    case 'signed-in':
      return !telegram.error;
    case 'starting':
      return !telegram.stop;
    default:
      return false;
  }
}

type Outcome = 'ended' | 'pending' | { failed: string };

function telegramOutcome(telegram: TelegramState): Outcome {
  if (telegram.kind === 'off') return 'ended';
  if (telegram.kind === 'signed-in' && telegram.error) return { failed: telegram.error };
  if (telegram.kind === 'stopped') return { failed: `Signing out of Telegram failed: ${telegram.error}` };
  return 'pending';
}

function signalOutcome(signal: SignalState): Outcome {
  if (signal.kind === 'off') return 'ended';
  if (signal.kind === 'linked' && signal.error) return { failed: signal.error };
  return 'pending';
}

const failure = (outcome: Outcome) => (typeof outcome === 'object' ? outcome.failed : null);

function settleEnding(state: Extract<AppState, { kind: 'ending' | 'end-failed' }>, context: Context): AppState {
  let { telegram, signal } = state;
  if (state.kind === 'ending') {
    if (needsStop(telegram)) telegram = telegramTransition(telegram, { type: 'telegram/stop' }, context);
    if (signal.kind === 'linking') signal = signalTransition(signal, { type: 'signal/cancel' }, context);
    else if (signal.kind === 'linked' && !signal.error)
      signal = signalTransition(
        signal,
        { type: 'signal/unlink', reason: state.reason === 'finish' ? 'at-finish' : 'by-user' },
        context,
      );
  }
  const session = { ...sessionOf(state), telegram, signal };
  const telegramEnd = telegramOutcome(telegram);
  const signalEnd = signalOutcome(signal);
  if (telegramEnd === 'ended' && signalEnd === 'ended')
    return state.reason === 'finish'
      ? { ...session, kind: 'done' }
      : { ...freshSession(session), kind: 'setup', step: 'start' };
  if (state.kind === 'ending') {
    if (telegramEnd === 'pending' || signalEnd === 'pending') return withSession(state, session);
    return {
      ...session,
      kind: 'end-failed',
      reason: state.reason,
      telegramError: failure(telegramEnd),
      signalError: failure(signalEnd),
    };
  }
  const telegramError = failure(telegramEnd);
  const signalError = failure(signalEnd);
  if (telegramError === state.telegramError && signalError === state.signalError) return withSession(state, session);
  return { ...state, ...session, telegramError, signalError };
}

function settleOnce(state: AppState, context: Context): AppState {
  if (!isSession(state)) return state;
  switch (state.kind) {
    case 'setup':
      return settleSetup(state, context);
    case 'migrating':
      return settleMigrating(state, context);
    case 'ending':
    case 'end-failed':
      return settleEnding(state, context);
    case 'done':
      return state;
  }
}

/** Applies the rules until none changes the state. */
export function settle(state: AppState, context: Context): AppState {
  for (let round = 0; round < 10; round++) {
    const next = settleOnce(state, context);
    if (next === state) return state;
    state = next;
  }
  return state;
}

export { linkedDevice };
