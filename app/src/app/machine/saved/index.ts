// The saved messages machine: the variants' handlers put together. The session describes its work
// (app/session.ts).

import { byVariant, type Context } from '../core';
import { failed } from './failed';
import { reading } from './reading';
import type { SavedEvent, SavedState } from './state';

export * from './state';

export const savedTransition: (state: SavedState, event: SavedEvent, context: Context) => SavedState = byVariant<
  SavedState,
  SavedEvent,
  Context
>({ none: {}, reading, read: {}, failed });
