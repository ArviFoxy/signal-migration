// The packs are read. With a linked device, the packs its account has are read too, once per linked device lifetime.

import { type Context, type ExhaustiveVariantHandlers, IGNORE } from '../core';
import type { PacksEvent, PacksState } from './state';

export const read: ExhaustiveVariantHandlers<PacksState, 'read', PacksEvent, Context> = {
  'packs/progress': IGNORE,
  'packs/read': IGNORE,
  'packs/read-failed': IGNORE,
  'packs/signal-read': (state, event) => ({ ...state, signalRead: event.deviceKey, signalError: null }),
  'packs/signal-failed': (state, event) => ({
    ...state,
    signalError: `Reading the sticker packs in your Signal failed: ${event.error}`,
  }),
  'packs/try-again': (state) =>
    state.signalError ? { ...state, signalError: null, signalAttempt: state.signalAttempt + 1 } : state,
};
