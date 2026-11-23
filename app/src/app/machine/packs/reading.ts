// Reading the packs from Telegram and looking them up in the index.

import { type Context, type ExhaustiveVariantHandlers, IGNORE } from '../core';
import type { PacksEvent, PacksState } from './state';

export const reading: ExhaustiveVariantHandlers<PacksState, 'reading', PacksEvent, Context> = {
  'packs/progress': (state, event) => ({ ...state, progress: { done: event.done, total: event.total } }),
  'packs/read': (state, event) => ({
    kind: 'read',
    instance: state.instance,
    attempt: state.attempt,
    migration: event.migration,
    signalRead: null,
    signalError: null,
    signalAttempt: 0,
  }),
  'packs/read-failed': (state, event) => ({
    kind: 'failed',
    instance: state.instance,
    attempt: state.attempt,
    error: `Reading your sticker packs failed: ${event.error}`,
  }),
  'packs/signal-read': IGNORE,
  'packs/signal-failed': IGNORE,
  'packs/try-again': IGNORE,
};
