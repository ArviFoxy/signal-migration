// The Telegram friends found on Signal, for the signed-in Telegram account and the linked Signal device.
//
//   none ─both accounts connected─▶ looking ─▶ found
//                                      │
//                                      └─▶ failed ─Try again─▶ looking
//
// A search belongs to one Telegram instance and one Signal device; another login or another device looks again.

import type { FriendSearch } from '../../../kinds/friends/search';

export type FriendsState =
  | { kind: 'none' }
  /** `progress`: how much of the Telegram chat list is read, once known. */
  | {
      kind: 'looking';
      instance: string;
      deviceId: number;
      attempt: number;
      progress: { done: number; total: number } | null;
    }
  | { kind: 'found'; instance: string; deviceId: number; attempt: number; search: FriendSearch }
  | { kind: 'failed'; instance: string; deviceId: number; attempt: number; error: string };

export type FriendsEvent =
  | { type: 'friends/progress'; done: number; total: number }
  | { type: 'friends/found'; search: FriendSearch }
  | { type: 'friends/failed'; error: string }
  | { type: 'friends/try-again' };
