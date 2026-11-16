// Migrating the selected packs. The run is work of this state: it ends with the state, cancelled. The session's
// rules (settle.ts) end the migration once every selected pack is in Signal and the other devices were told, and go
// back to the setup when a login is lost.

import { contactsToAdd } from '../../../kinds/friends/search';
import { messagesToCopy, notYetSent } from '../../../kinds/saved/copy';
import type { Context, Variant, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import type { Work } from '../work';
import { beginEnding, linkedDevice, sessionOf, signedInInstance } from './session';
import type { AppState } from './state';

type Migrating = Variant<AppState, 'migrating'>;

export const migrating: VariantHandlers<AppState, 'migrating', AppEvent, Context> = {
  'run/ended': (state) => ({ ...state, run: { ...state.run, status: 'ended' } }),
  'run/failed': (state, event) => ({
    ...state,
    run: { ...state.run, status: 'failed', error: `The migration stopped: ${event.error}` },
  }),
  'run/friends-added': (state, event) => ({ ...state, run: { ...state.run, friendsAdded: event.count } }),
  'run/friends-failed': (state, event) => ({
    ...state,
    run: { ...state.run, status: 'failed', error: `Adding your friends to Signal failed: ${event.error}` },
  }),
  'run/saved-sent': (state, event) => ({ ...state, savedSentUpTo: event.upTo }),
  'run/saved-failed': (state, event) => ({
    ...state,
    run: { ...state.run, status: 'failed', error: `Copying your Saved Messages to Signal failed: ${event.error}` },
  }),
  'run/retry': (state) => ({
    ...state,
    run: { ...state.run, attempt: state.run.attempt + 1, status: 'running', error: null },
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
  const device = linkedDevice(state.signal);
  const { chosen, packs, friends, run } = state;
  if (run.status === 'failed' || !instance || !device || state.signal.kind !== 'linked') return [];
  const work: Work[] = [];
  if (chosen.friends && friends.kind === 'found' && run.friendsAdded === null)
    work.push({
      kind: 'add-friends',
      key: `add-friends:${run.attempt}`,
      contacts: contactsToAdd(friends.search, state.tickedFriends),
      device,
    });
  const messages = savedLeft(state);
  if (messages.length > 0) work.push({ kind: 'copy-saved', key: `copy-saved:${run.attempt}`, messages, device });
  if (chosen.stickers && run.status === 'running' && packs.kind === 'read' && packs.signalRead === device.deviceId)
    work.push({ kind: 'run', key: `run:${run.attempt}`, instance, migration: packs.migration, device });
  return work;
}
