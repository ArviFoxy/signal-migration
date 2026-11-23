// The Telegram packs of the signed-in account: read from Telegram and looked up in the index, then which of them
// the Signal account already has.
//
//   none ─signed in─▶ reading ─▶ read ─(device linked)─▶ read, Signal's packs read
//                       │
//                       └─▶ failed ─Try again─▶ reading
//
// The packs belong to one Telegram instance; another login reads them again. The pack list itself is data
// (StickerMigration), changed by its own operations; the state refers to it.

import type { StickerMigration } from '../../../kinds/stickers/migration';
import type { DeviceKey } from '../signal/state';

export type PacksState =
  | { kind: 'none' }
  | { kind: 'reading'; instance: string; attempt: number; progress: { done: number; total: number } | null }
  /** `signalRead`: the linked device lifetime whose installed packs were read, or null; `signalError`: why reading failed. */
  | {
      kind: 'read';
      instance: string;
      attempt: number;
      migration: StickerMigration;
      signalRead: DeviceKey | null;
      signalError: string | null;
      signalAttempt: number;
    }
  | { kind: 'failed'; instance: string; attempt: number; error: string };

export type PacksEvent =
  | { type: 'packs/progress'; done: number; total: number }
  | { type: 'packs/read'; migration: StickerMigration }
  | { type: 'packs/read-failed'; error: string }
  | { type: 'packs/signal-read'; deviceKey: DeviceKey }
  | { type: 'packs/signal-failed'; error: string }
  | { type: 'packs/try-again' };
