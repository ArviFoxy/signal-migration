// The packs machine: the variants' handlers put together. Its work depends on the Signal device too, so the
// session describes it (app/session.ts).

import { byExhaustiveVariant, type Context, IGNORE } from '../core';
import { failed } from './failed';
import { read } from './read';
import { reading } from './reading';
import type { PacksEvent, PacksState } from './state';

export * from './state';

export const packsTransition: (state: PacksState, event: PacksEvent, context: Context) => PacksState =
  byExhaustiveVariant<PacksState, PacksEvent, Context>({
    none: {
      'packs/progress': IGNORE,
      'packs/read': IGNORE,
      'packs/read-failed': IGNORE,
      'packs/signal-read': IGNORE,
      'packs/signal-failed': IGNORE,
      'packs/try-again': IGNORE,
    },
    reading,
    read,
    failed,
  });
