// Every event of the app: the machines' own, and the top level's.

import type { SetupStep } from './app/steps';
import type { PacksEvent } from './packs/state';
import type { Record } from './record';
import type { SignalEvent } from './signal/state';
import type { TelegramEvent } from './telegram/state';

export type AppEvent =
  | TelegramEvent
  | SignalEvent
  | PacksEvent
  // From the browser.
  | { type: 'lock/held' }
  | { type: 'lock/elsewhere' }
  | { type: 'record/loaded'; record: Record | null }
  | { type: 'record/load-failed'; error: string }
  | { type: 'leftovers/deleted' }
  // From the migration run.
  | { type: 'run/ended' }
  | { type: 'run/failed'; error: string }
  // From the user.
  | { type: 'go-to'; step: SetupStep }
  | { type: 'start-migration' }
  | { type: 'run/retry' }
  | { type: 'finish' }
  | { type: 'clear' }
  | { type: 'end/retry' }
  | { type: 'end/forget'; part: 'telegram' | 'signal' }
  | { type: 'start-over' }
  | { type: 'dismiss' }
  | { type: 'load/retry' };
