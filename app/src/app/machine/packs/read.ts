// The packs are read. With a linked device, the packs its account has are read too, once per device.

import type { Context, VariantHandlers } from '../core';
import type { PacksEvent, PacksState } from './state';

export const read: VariantHandlers<PacksState, 'read', PacksEvent, Context> = {
  'packs/signal-read': (state, event) => ({ ...state, signalRead: event.deviceId, signalError: null }),
  'packs/signal-failed': (state, event) => ({
    ...state,
    signalError: `Reading the sticker packs in your Signal failed: ${event.error}`,
  }),
  'packs/try-again': (state) =>
    state.signalError ? { ...state, signalError: null, signalAttempt: state.signalAttempt + 1 } : state,
};
