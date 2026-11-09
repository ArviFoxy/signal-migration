// The packs machine: the variants' handlers put together. Its work depends on the Signal device too, so the
// session describes it (app/session.ts).

import { byVariant, type Context } from '../core';
import { failed } from './failed';
import { read } from './read';
import { reading } from './reading';
import type { PacksEvent, PacksState } from './state';

export * from './state';

export const packsTransition: (state: PacksState, event: PacksEvent, context: Context) => PacksState = byVariant<
  PacksState,
  PacksEvent,
  Context
>({ none: {}, reading, read, failed });
