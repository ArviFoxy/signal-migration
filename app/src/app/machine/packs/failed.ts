// Reading the packs failed; "Try again" reads them again.

import type { Context, VariantHandlers } from '../core';
import type { PacksEvent, PacksState } from './state';

export const failed: VariantHandlers<PacksState, 'failed', PacksEvent, Context> = {
  'packs/try-again': (state) => ({ kind: 'reading', instance: state.instance, attempt: state.attempt + 1 }),
};
