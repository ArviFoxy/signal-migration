// Taking the lock that lets one tab run the migration: two tabs would share the record and the logins.

import type { Context, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import type { Work } from '../work';
import type { AppState } from './state';

export const locking: VariantHandlers<AppState, 'locking', AppEvent, Context> = {
  'lock/held': () => ({ kind: 'loading', record: undefined, attempt: 1 }),
  'lock/elsewhere': () => ({ kind: 'elsewhere' }),
};

export const lockingWork = (): Work[] => [{ kind: 'lock', key: 'lock', wait: false }];
