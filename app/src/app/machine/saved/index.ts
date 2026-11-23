// The saved messages machine: the variants' handlers put together. The session describes its work
// (app/session.ts).

import { byExhaustiveVariant, type Context, IGNORE } from '../core';
import { failed } from './failed';
import { reading } from './reading';
import type { SavedEvent, SavedState } from './state';

export * from './state';

const ignoreAll = {
  'saved/progress': IGNORE,
  'saved/read': IGNORE,
  'saved/failed': IGNORE,
  'saved/try-again': IGNORE,
} as const;

export const savedTransition: (state: SavedState, event: SavedEvent, context: Context) => SavedState =
  byExhaustiveVariant<SavedState, SavedEvent, Context>({ none: ignoreAll, reading, read: ignoreAll, failed });
