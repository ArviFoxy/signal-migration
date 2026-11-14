// The background work a state can describe, as data. The runtime (runtime.ts) starts the work for each key a new
// state describes and cancels the work whose key it no longer describes; activities.ts says what each kind does.
// A key names one piece of work: work that ended stays known under its key while the state still describes it, so
// it is not started again.

import type { FriendSearch } from '../../kinds/friends/search';
import type { StickerMigration } from '../../kinds/stickers/migration';
import type { NewContact } from '../../signal/storage';
import type { StoredDevice } from '../services';
import type { AppEvent } from './events';
import type { LoginQuery } from './telegram/state';

export type Work =
  /** Sends `event` once `seconds` have passed. */
  | { kind: 'timer'; key: string; seconds: number; event: AppEvent }
  /** Takes the browser lock that lets one tab run the migration; `wait`: until the tab holding it closes. */
  | { kind: 'lock'; key: string; wait: boolean }
  | { kind: 'load-record'; key: string }
  /** Deletes the TDLib instances in the browser other than `keep`. */
  | { kind: 'delete-leftovers'; key: string; keep: string | null }
  /** Runs TDLib on `instance` and reports its login states. */
  | { kind: 'tdlib'; key: string; instance: string }
  | { kind: 'tdlib-request'; key: string; instance: string; query: LoginQuery }
  | { kind: 'tdlib-checkpoint'; key: string; instance: string }
  | { kind: 'tdlib-logout'; key: string; instance: string }
  | { kind: 'tdlib-delete'; key: string; instance: string }
  /** Shows a QR code and links a Signal device when the phone scans it. */
  | { kind: 'signal-link'; key: string }
  /** Reports when the device is unlinked from the phone. */
  | { kind: 'signal-watch'; key: string; device: StoredDevice }
  | { kind: 'signal-unlink'; key: string; device: StoredDevice }
  /** Reads the Telegram packs and looks them up in the index. */
  | { kind: 'read-packs'; key: string; instance: string; deselected: string[] }
  | { kind: 'load-previews'; key: string; instance: string; migration: StickerMigration }
  /** Reads which packs the Signal account has. */
  | { kind: 'read-signal'; key: string; migration: StickerMigration; device: StoredDevice }
  /** Reads the people of the Telegram account and looks for their Signal accounts. */
  | { kind: 'find-friends'; key: string; instance: string; device: StoredDevice }
  /** Reads the Telegram pictures of the people and groups a finished search shows. */
  | { kind: 'load-friend-photos'; key: string; instance: string; search: FriendSearch }
  /** Adds the chosen friends to the Signal contacts. */
  | { kind: 'add-friends'; key: string; contacts: NewContact[]; device: StoredDevice }
  /** Migrates the selected packs. */
  | { kind: 'run'; key: string; instance: string; migration: StickerMigration; device: StoredDevice };
