// The record could not be read. Nothing is assumed about what it holds; "Try again" reads it again.

import type { Context, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import type { AppState } from './state';

export const loadFailed: VariantHandlers<AppState, 'load-failed', AppEvent, Context> = {
  'load/retry': (state) => ({ kind: 'loading', record: undefined, attempt: state.attempt + 1 }),
};
