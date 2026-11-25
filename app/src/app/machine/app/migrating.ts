// Migrating the selected packs. The run is work of this state: it ends with the state, cancelled. The session's
// rules (settle.ts) end the migration once every selected pack is in Signal and the other devices were told, and go
// back to the setup when a login is lost.

import { contactsToAdd } from '../../../kinds/friends/search';
import { messagesToCopy, notYetSent } from '../../../kinds/saved/copy';
import type { Context, Variant, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import type { Work } from '../work';
import { beginEnding, sessionOf, signedInInstance } from './session';
import type { AppState, SessionState } from './state';

type Migrating = Variant<AppState, 'migrating'>;

/** Single source of truth for cross-kind migration completion, shared by `settleMigrating` and `Workflow.migrationRun`. */
export type MigrationProgress = {
  /** Sticker packs stopped running (all installed, or stopped with pack failures / unannounced). */
  stickersEnded: boolean;
  /** Every selected sticker pack is in Signal and announced to other devices. */
  stickersAllInstalled: boolean;
  /** Chosen friends have been found and written to Signal. */
  friendsDone: boolean;
  /** Chosen Saved Messages have been read and all sent to Signal. */
  savedDone: boolean;
  /** Every chosen kind is completely finished with no run error or unannounced/failed packs (triggers `beginEnding`). */
  readyToFinish: boolean;
  /** Every chosen kind has finished or stopped running (including ended with pack failures). */
  ended: boolean;
  /** Every chosen kind finished cleanly without run-level error or failed/unannounced packs. */
  completed: boolean;
  /** Either a run-level error occurred or at least one pack failed / was not announced yet. */
  canRetry: boolean;
  /** Run-level failure is active. */
  failed: boolean;
};

export function migrationProgress(state: SessionState): MigrationProgress {
  const { chosen, packs, friends, saved } = state;
  const migration = packs.kind === 'read' ? packs.migration : null;
  const failed = state.kind === 'migrating' && state.run.status === 'failed';
  const failedPacks = migration ? migration.selected.filter((entry) => entry.state === 'failed').length : 0;
  const unannounced = migration ? migration.unannounced : 0;

  const stickersEnded =
    !chosen.stickers ||
    (migration !== null &&
      ((state.kind === 'migrating' && state.run.status === 'ended') ||
        state.kind === 'ending' ||
        state.kind === 'done' ||
        migration.phase === 'done' ||
        migration.phase === 'stopped'));
  const stickersAllInstalled =
    !chosen.stickers ||
    (stickersEnded &&
      migration !== null &&
      migration.selected.every((entry) => entry.state === 'in-signal') &&
      unannounced === 0);

  const friendsDone =
    !chosen.friends ||
    state.kind === 'done' ||
    state.kind === 'ending' ||
    (friends.kind === 'found' && state.kind === 'migrating' && state.run.friendsAdded !== null);

  const savedDone =
    !chosen.saved ||
    state.kind === 'done' ||
    state.kind === 'ending' ||
    (saved.kind === 'read' && savedLeft(state).length === 0);

  const readyToFinish = stickersAllInstalled && friendsDone && savedDone && !failed;
  const completed = stickersEnded && friendsDone && savedDone && !failed;
  const ended = failed || completed;
  const canRetry = failed || failedPacks > 0 || Boolean(migration?.announceError);
  return {
    stickersEnded,
    stickersAllInstalled,
    friendsDone,
    savedDone,
    readyToFinish,
    ended,
    completed,
    canRetry,
    failed,
  };
}

export const migrating: VariantHandlers<AppState, 'migrating', AppEvent, Context> = {
  'run/ended': (state) => ({ ...state, run: { ...state.run, status: 'ended' } }),
  'run/failed': (state, event) => ({
    ...state,
    run: { ...state.run, status: 'failed', error: `The migration stopped: ${event.error}`, savedWait: null },
  }),
  'run/friends-added': (state, event) => ({ ...state, run: { ...state.run, friendsAdded: event.count } }),
  'run/friends-failed': (state, event) => ({
    ...state,
    run: { ...state.run, status: 'failed', error: `Adding your friends to Signal failed: ${event.error}` },
  }),
  'run/saved-sent': (state, event) => ({
    ...state,
    savedSentUpTo: event.upTo,
    run: state.run.savedWait ? { ...state.run, savedWait: null } : state.run,
  }),
  'run/saved-wait': (state, event) => ({
    ...state,
    run: { ...state.run, savedWait: event.wait },
  }),
  'run/saved-failed': (state, event) => ({
    ...state,
    run: {
      ...state.run,
      status: 'failed',
      error: `Copying your Saved Messages to Signal failed: ${event.error}`,
      savedWait: null,
    },
  }),
  'run/retry': (state) => ({
    ...state,
    run: { ...state.run, attempt: state.run.attempt + 1, status: 'running', error: null, savedWait: null },
  }),
  finish: (state, _, context) => beginEnding(state, 'finish', context),
  clear: (state, _, context) => beginEnding(state, 'clear', context),
  'telegram/stop': (state) => ({ ...sessionOf(state), kind: 'setup', step: 'start' }),
  // Back to the setup, signed in and linked; the run stops with this state, and a new one continues from Signal.
  'go-to': (state, event) => ({ ...sessionOf(state), kind: 'setup', step: event.step }),
};

/** The saved messages a run still has to send, oldest first. */
export function savedLeft(state: Pick<Migrating, 'chosen' | 'saved' | 'savedFrom' | 'savedSentUpTo'>) {
  if (!state.chosen.saved || state.saved.kind !== 'read') return [];
  return notYetSent(messagesToCopy(state.saved.messages, state.savedFrom), state.savedSentUpTo);
}

/**
 * The run of each chosen kind. Sticker packs: once the packs and Signal's installed packs are read. Friends: once
 * they are looked for, until the contacts are written. Saved messages: once they are read, while some are not sent.
 */
export function migratingWork(state: Migrating): Work[] {
  const instance = signedInInstance(state.telegram);
  const { chosen, packs, friends, run } = state;
  if (run.status === 'failed' || !instance || state.signal.kind !== 'linked') return [];
  const { deviceKey, device } = state.signal;
  const work: Work[] = [];
  if (chosen.friends && friends.kind === 'found' && run.friendsAdded === null)
    work.push({
      kind: 'add-friends',
      key: `add-friends:${run.attempt}`,
      contacts: contactsToAdd(friends.search, state.tickedFriends),
      deviceKey,
      device,
    });
  const messages = savedLeft(state);
  if (messages.length > 0)
    work.push({ kind: 'copy-saved', key: `copy-saved:${run.attempt}`, instance, messages, deviceKey, device });
  if (chosen.stickers && run.status === 'running' && packs.kind === 'read' && packs.signalRead === deviceKey)
    work.push({ kind: 'run', key: `run:${run.attempt}`, instance, migration: packs.migration, deviceKey, device });
  return work;
}
