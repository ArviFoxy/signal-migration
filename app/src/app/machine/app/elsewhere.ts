// Another tab runs the migration. This one changes nothing, and continues once the other tab has closed.

import type { Context, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import type { Work } from '../work';
import type { AppState } from './state';

export const elsewhere: VariantHandlers<AppState, 'elsewhere', AppEvent, Context> = {
  'lock/held': () => ({ kind: 'loading', record: undefined, attempt: 1 }),
};

export const elsewhereWork = (): Work[] => [{ kind: 'lock', key: 'lock-wait', wait: true }];
