// Reading the messages from Telegram.

import type { Context, VariantHandlers } from '../core';
import type { SavedEvent, SavedState } from './state';

export const reading: VariantHandlers<SavedState, 'reading', SavedEvent, Context> = {
  'saved/progress': (state, event) => ({ ...state, read: event.read }),
  'saved/read': (state, event) => ({
    kind: 'read',
    instance: state.instance,
    attempt: state.attempt,
    messages: event.messages,
  }),
  'saved/failed': (state, event) => ({
    kind: 'failed',
    instance: state.instance,
    attempt: state.attempt,
    error: `Reading your Saved Messages failed: ${event.error}`,
  }),
};
