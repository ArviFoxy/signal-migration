// The friends are found. The Telegram pictures of the people and groups shown arrive one by one.

import type { Context, VariantHandlers } from '../core';
import type { FriendsEvent, FriendsState } from './state';

export const found: VariantHandlers<FriendsState, 'found', FriendsEvent, Context> = {
  'friends/photo': (state, event) => ({ ...state, photos: new Map(state.photos).set(event.of, event.data) }),
};
