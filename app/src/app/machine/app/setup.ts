// Choosing what to migrate and connecting the accounts. The step on screen follows from the state (steps.ts); the
// session's rules (settle.ts) start a Telegram login on the Telegram step and a QR code on the Signal step.

import type { Context, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import { beginEnding, linkedDevice, sessionOf } from './session';
import type { AppState } from './state';

export const setup: VariantHandlers<AppState, 'setup', AppEvent, Context> = {
  'go-to': (state, event) => ({ ...state, step: event.step }),
  // The packs are read, and Signal's installed packs from the linked device.
  'start-migration': (state) => {
    const device = linkedDevice(state.signal);
    const packs = state.packs;
    if (state.step !== 'review' || !device || packs.kind !== 'read' || packs.signalRead !== device.deviceId)
      return state;
    if (packs.migration.selected.length === 0) return state;
    return { ...sessionOf(state), kind: 'migrating', run: { attempt: 1, status: 'running', error: null } };
  },
  // Signing out from the connections panel goes back to the start rather than to a new login.
  'telegram/stop': (state) => ({ ...state, step: 'start' }),
  clear: (state, _, context) => beginEnding(state, 'clear', context),
};
