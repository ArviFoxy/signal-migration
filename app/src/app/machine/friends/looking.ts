// Reading the people from Telegram and asking Signal about them.

import type { Context, VariantHandlers } from '../core';
import type { FriendsEvent, FriendsState } from './state';

export const looking: VariantHandlers<FriendsState, 'looking', FriendsEvent, Context> = {
  'friends/progress': (state, event) => ({ ...state, progress: event.progress }),
  'friends/found': (state, event) => ({
    kind: 'found',
    instance: state.instance,
    deviceId: state.deviceId,
    attempt: state.attempt,
    search: event.search,
    photos: new Map(),
  }),
  'friends/failed': (state, event) => ({
    kind: 'failed',
    instance: state.instance,
    deviceId: state.deviceId,
    attempt: state.attempt,
    error: `Looking for your friends on Signal failed: ${event.error}`,
  }),
};
