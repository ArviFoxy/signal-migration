// Done, and logged out. "Start over" begins a new migration.

import type { Context, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import { freshSession } from './session';
import type { AppState } from './state';

export const done: VariantHandlers<AppState, 'done', AppEvent, Context> = {
  'start-over': (state) => ({ ...freshSession(state), kind: 'setup', step: 'start' }),
};
