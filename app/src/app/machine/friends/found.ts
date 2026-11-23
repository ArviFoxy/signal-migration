// Friends found; their Telegram pictures arrive while the setup shows.

import { type Context, type ExhaustiveVariantHandlers, IGNORE } from '../core';
import type { FriendsEvent, FriendsState } from './state';

export const found: ExhaustiveVariantHandlers<FriendsState, 'found', FriendsEvent, Context> = {
  'friends/progress': IGNORE,
  'friends/found': IGNORE,
  'friends/failed': IGNORE,
  'friends/photo': (state, event) => {
    const photos = new Map(state.photos);
    photos.set(event.of, event.data);
    return { ...state, photos };
  },
  'friends/try-again': IGNORE,
};
