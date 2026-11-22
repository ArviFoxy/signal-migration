// Every event of the app: the machines' own, and the top level's.

import type { SetupStep } from './app/steps';
import type { FriendsEvent } from './friends/state';
import type { PacksEvent } from './packs/state';
import type { Record } from './record';
import type { SavedEvent } from './saved/state';
import type { SignalEvent } from './signal/state';
import type { TelegramEvent } from './telegram/state';

export type AppEvent =
  | TelegramEvent
  | SignalEvent
  | PacksEvent
  | FriendsEvent
  | SavedEvent
  // From the browser.
  | { type: 'lock/held' }
  | { type: 'lock/elsewhere' }
  | { type: 'record/loaded'; record: Record | null }
  | { type: 'record/load-failed'; error: string }
  | { type: 'leftovers/deleted' }
  // From the migration run.
  | { type: 'run/ended' }
  | { type: 'run/failed'; error: string }
  | { type: 'run/friends-added'; count: number }
  | { type: 'run/friends-failed'; error: string }
  /** The saved message with this ID, and every one before it, is in Signal. */
  | { type: 'run/saved-sent'; upTo: number }
  | { type: 'run/saved-failed'; error: string }
  // From the user.
  | { type: 'go-to'; step: SetupStep }
  | { type: 'choose'; what: 'stickers' | 'friends' | 'saved'; chosen: boolean }
  | { type: 'tick-friends'; userIds: number[]; ticked: boolean }
  /** Copy the saved messages from this date on (seconds since 1970); null copies from the first message. */
  | { type: 'copy-saved-from'; from: number | null }
  | { type: 'start-migration' }
  | { type: 'run/retry' }
  | { type: 'finish' }
  | { type: 'clear' }
  | { type: 'end/retry' }
  | { type: 'end/forget'; part: 'telegram' | 'signal' }
  | { type: 'start-over' }
  | { type: 'dismiss' }
  | { type: 'load/retry' };
