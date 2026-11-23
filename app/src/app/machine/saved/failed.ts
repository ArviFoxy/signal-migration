// Reading failed; "Try again" reads again.

import { type Context, type ExhaustiveVariantHandlers, IGNORE } from '../core';
import type { SavedEvent, SavedState } from './state';

export const failed: ExhaustiveVariantHandlers<SavedState, 'failed', SavedEvent, Context> = {
  'saved/progress': IGNORE,
  'saved/read': IGNORE,
  'saved/failed': IGNORE,
  'saved/try-again': (state) => ({ kind: 'reading', instance: state.instance, attempt: state.attempt + 1, read: 0 }),
};
