// Choosing what to migrate and connecting the accounts. The step on screen follows from the state (steps.ts); the
// session's rules (settle.ts) start a Telegram login on the Telegram step and a QR code on the Signal step.

import { contactsToAdd } from '../../../kinds/friends/search';
import type { Context, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import { beginEnding, linkedDevice, sessionOf } from './session';
import type { AppState } from './state';

export const setup: VariantHandlers<AppState, 'setup', AppEvent, Context> = {
  'go-to': (state, event) => ({ ...state, step: event.step }),
  choose: (state, event) => ({ ...state, chosen: { ...state.chosen, [event.what]: event.chosen } }),
  // Each chosen kind is ready: the packs are read, and Signal's installed packs from the linked device; the friends
  // are looked for. And there is something to move.
  'start-migration': (state) => {
    const device = linkedDevice(state.signal);
    const { chosen, packs, friends } = state;
    if (state.step !== 'review' || !device) return state;
    if (chosen.stickers && (packs.kind !== 'read' || packs.signalRead !== device.deviceId)) return state;
    if (chosen.friends && friends.kind !== 'found') return state;
    const packCount = chosen.stickers && packs.kind === 'read' ? packs.migration.selected.length : 0;
    const friendCount =
      chosen.friends && friends.kind === 'found' ? contactsToAdd(friends.search, state.tickedFriends).length : 0;
    if (packCount + friendCount === 0) return state;
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
