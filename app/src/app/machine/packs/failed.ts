// Reading the packs failed; "Try again" reads them again.

import { type Context, type ExhaustiveVariantHandlers, IGNORE } from '../core';
import type { PacksEvent, PacksState } from './state';

export const failed: ExhaustiveVariantHandlers<PacksState, 'failed', PacksEvent, Context> = {
  'packs/progress': IGNORE,
  'packs/read': IGNORE,
  'packs/read-failed': IGNORE,
  'packs/signal-read': IGNORE,
  'packs/signal-failed': IGNORE,
  'packs/try-again': (state) => ({
    kind: 'reading',
    instance: state.instance,
    attempt: state.attempt + 1,
    progress: null,
  }),
};
