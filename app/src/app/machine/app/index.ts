// The app's state machine: an event goes to the session's machines, then to the phase's handlers, then the rules
// that follow from the state apply (settle.ts). All of it is pure; the runtime (../runtime.ts) does the work the
// state describes (appWork) and keeps the record (recordOf).

import { byVariant, type Context } from '../core';
import type { AppEvent } from '../events';
import type { Record } from '../record';
import { keptDevice } from '../signal';
import { keptInstance } from '../telegram';
import type { Work } from '../work';
import { done } from './done';
import { elsewhere, elsewhereWork } from './elsewhere';
import { endFailed } from './end-failed';
import { ending } from './ending';
import { loadFailed } from './load-failed';
import { loading, loadingWork } from './loading';
import { locking, lockingWork } from './locking';
import { migrating, migratingWork } from './migrating';
import { sessionWork, toMachines } from './session';
import { settle } from './settle';
import { setup } from './setup';
import { type AppState, isSession } from './state';

export * from './state';
export { INITIAL_CHOICE, stepOf, linkedDevice, signedInInstance } from './session';
export * from './steps';

const byPhase = byVariant<AppState, AppEvent, Context>({
  locking,
  elsewhere,
  loading,
  'load-failed': loadFailed,
  setup,
  migrating,
  ending,
  'end-failed': endFailed,
  done,
});

export function appTransition(state: AppState, event: AppEvent, context: Context): AppState {
  const afterMachines = isSession(state) ? toMachines(state, event, context) : state;
  return settle(byPhase(afterMachines, event, context), context);
}

export function appWork(state: AppState): Work[] {
  switch (state.kind) {
    case 'locking':
      return lockingWork();
    case 'elsewhere':
      return elsewhereWork();
    case 'loading':
      return loadingWork(state);
    case 'load-failed':
      return [];
    case 'migrating':
      return [...sessionWork(state), ...migratingWork(state)];
    default:
      return sessionWork(state);
  }
}

/**
 * What the browser keeps: undefined while nothing is known yet (before the record was read), null when nothing is
 * left to keep.
 */
export function recordOf(state: AppState): Record | null | undefined {
  if (!isSession(state)) return undefined;
  const telegram = keptInstance(state.telegram);
  const signal = keptDevice(state.signal);
  const nothingKept = telegram === null && signal === null;
  if (nothingKept && (state.kind === 'done' || (state.kind === 'setup' && state.step === 'start'))) return null;
  const packs = state.packs;
  const deselected =
    packs.kind === 'read'
      ? packs.migration.entries.filter((entry) => !entry.selected).map((entry) => entry.pack.setId)
      : state.deselected;
  const ending = state.kind === 'ending' || state.kind === 'end-failed' || state.kind === 'done';
  if (ending && nothingKept) return null;
  return {
    version: 4,
    phase: ending ? 'ending' : state.kind === 'migrating' ? 'migrating' : 'setup',
    step: state.kind === 'setup' ? state.step : 'review',
    why: state.kind === 'ending' || state.kind === 'end-failed' ? state.reason : ending ? 'finish' : null,
    telegram,
    signal,
    chosen: state.chosen,
    deselected,
    tickedFriends: state.tickedFriends,
  };
}
