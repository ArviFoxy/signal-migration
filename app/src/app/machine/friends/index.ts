// The friends machine: the variants' handlers put together. The session describes its work (app/session.ts).

import { byExhaustiveVariant, type Context, IGNORE } from '../core';
import { failed } from './failed';
import { found } from './found';
import { looking } from './looking';
import type { FriendsEvent, FriendsState } from './state';

export * from './state';

export const friendsTransition: (state: FriendsState, event: FriendsEvent, context: Context) => FriendsState =
  byExhaustiveVariant<FriendsState, FriendsEvent, Context>({
    none: {
      'friends/progress': IGNORE,
      'friends/found': IGNORE,
      'friends/failed': IGNORE,
      'friends/photo': IGNORE,
      'friends/try-again': IGNORE,
    },
    looking,
    found,
    failed,
  });
