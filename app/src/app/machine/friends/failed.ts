// Looking for friends failed; "Try again" looks again.

import { type Context, type ExhaustiveVariantHandlers, IGNORE } from '../core';
import type { FriendsEvent, FriendsState } from './state';

export const failed: ExhaustiveVariantHandlers<FriendsState, 'failed', FriendsEvent, Context> = {
  'friends/progress': IGNORE,
  'friends/found': IGNORE,
  'friends/failed': IGNORE,
  'friends/photo': IGNORE,
  'friends/try-again': (state) => ({
    kind: 'looking',
    instance: state.instance,
    deviceKey: state.deviceKey,
    attempt: state.attempt + 1,
    progress: null,
  }),
};
