// Looking failed; "Try again" looks again.

import type { Context, VariantHandlers } from '../core';
import type { FriendsEvent, FriendsState } from './state';

export const failed: VariantHandlers<FriendsState, 'failed', FriendsEvent, Context> = {
  'friends/try-again': (state) => ({
    kind: 'looking',
    instance: state.instance,
    deviceId: state.deviceId,
    attempt: state.attempt + 1,
    progress: null,
  }),
};
