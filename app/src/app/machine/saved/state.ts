// The messages of Telegram's Saved Messages, for the signed-in Telegram account.
//
//   none ─signed in─▶ reading ─▶ read
//                        │
//                        └─▶ failed ─Try again─▶ reading
//
// A reading belongs to one Telegram instance; another login reads again.

import type { SavedMessage } from '../../../kinds/saved/messages';

export type SavedState =
  | { kind: 'none' }
  /** `read`: how many messages are read so far. */
  | { kind: 'reading'; instance: string; attempt: number; read: number }
  /** `messages`: every message of the chat, oldest first. */
  | { kind: 'read'; instance: string; attempt: number; messages: readonly SavedMessage[] }
  | { kind: 'failed'; instance: string; attempt: number; error: string };

export type SavedEvent =
  | { type: 'saved/progress'; read: number }
  | { type: 'saved/read'; messages: SavedMessage[] }
  | { type: 'saved/failed'; error: string }
  | { type: 'saved/try-again' };
