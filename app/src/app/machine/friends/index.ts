// The friends machine: the variants' handlers put together. Its work depends on both accounts, so the session
// describes it (app/session.ts).

import { byVariant, type Context } from '../core';
import { failed } from './failed';
import { found } from './found';
import { looking } from './looking';
import type { FriendsEvent, FriendsState } from './state';

export * from './state';

export const friendsTransition: (state: FriendsState, event: FriendsEvent, context: Context) => FriendsState =
  byVariant<FriendsState, FriendsEvent, Context>({ none: {}, looking, found, failed });
