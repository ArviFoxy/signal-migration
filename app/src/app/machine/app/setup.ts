// Choosing what to migrate and connecting the accounts. The step on screen follows from the state (steps.ts); the
// session's rules (settle.ts) start a Telegram login on the Telegram step and a QR code on the Signal step.

import { contactsToAdd } from '../../../kinds/friends/search';
import { messagesToCopy } from '../../../kinds/saved/copy';
import type { Context, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import { beginEnding, sessionOf } from './session';
import type { AppState } from './state';

export const setup: VariantHandlers<AppState, 'setup', AppEvent, Context> = {
  'go-to': (state, event) => ({ ...state, step: event.step }),
  choose: (state, event) => ({ ...state, chosen: { ...state.chosen, [event.what]: event.chosen } }),
  // Another date is another set of messages, so what a run has sent no longer says where to continue. Signal's
  // apps drop the messages that are sent a second time. Re-selecting the same cutoff is a no-op.
  'copy-saved-from': (state, event) =>
    event.from === state.savedFrom ? state : { ...state, savedFrom: event.from, savedSentUpTo: null },
  // Each chosen kind is ready: the packs are read, and Signal's installed packs from the linked device; the friends
  // are looked for; the saved messages are read. And there is something to move.
  'start-migration': (state) => {
    const linked = state.signal.kind === 'linked' ? state.signal : null;
    const { chosen, packs, friends, saved } = state;
    if (state.step !== 'review' || !linked) return state;
    if (chosen.stickers && (packs.kind !== 'read' || packs.signalRead !== linked.deviceKey)) return state;
    if (chosen.friends && friends.kind !== 'found') return state;
    if (chosen.saved && saved.kind !== 'read') return state;
    const packCount = chosen.stickers && packs.kind === 'read' ? packs.migration.selected.length : 0;
    const friendCount =
      chosen.friends && friends.kind === 'found' ? contactsToAdd(friends.search, state.tickedFriends).length : 0;
    const savedCount =
      chosen.saved && saved.kind === 'read' ? messagesToCopy(saved.messages, state.savedFrom).length : 0;
    if (packCount + friendCount + savedCount === 0) return state;
    return {
      ...sessionOf(state),
      kind: 'migrating',
      run: { attempt: 1, status: 'running', friendsAdded: null, error: null },
    };
  },
  // Signing out from the connections panel goes back to the start rather than to a new login.
  'telegram/stop': (state) => ({ ...state, step: 'start' }),
  clear: (state, _, context) => beginEnding(state, 'clear', context),
};
