// Reading failed; "Try again" reads again.

import type { Context, VariantHandlers } from '../core';
import type { SavedEvent, SavedState } from './state';

export const failed: VariantHandlers<SavedState, 'failed', SavedEvent, Context> = {
  'saved/try-again': (state) => ({ kind: 'reading', instance: state.instance, attempt: state.attempt + 1, read: 0 }),
};
