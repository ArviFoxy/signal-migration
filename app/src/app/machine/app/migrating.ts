// Migrating the selected packs. The run is work of this state: it ends with the state, cancelled. The session's
// rules (settle.ts) end the migration once every selected pack is in Signal and the other devices were told, and go
// back to the setup when a login is lost.

import type { Context, Variant, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import type { Work } from '../work';
import { beginEnding, linkedDevice, sessionOf, signedInInstance } from './session';
import type { AppState } from './state';

type Migrating = Variant<AppState, 'migrating'>;

export const migrating: VariantHandlers<AppState, 'migrating', AppEvent, Context> = {
  'run/ended': (state) => ({ ...state, run: { ...state.run, status: 'ended' } }),
  'run/failed': (state, event) => ({
    ...state,
    run: { ...state.run, status: 'failed', error: `The migration stopped: ${event.error}` },
  }),
  'run/retry': (state) => ({ ...state, run: { attempt: state.run.attempt + 1, status: 'running', error: null } }),
  finish: (state, _, context) => beginEnding(state, 'finish', context),
  clear: (state, _, context) => beginEnding(state, 'clear', context),
  'telegram/stop': (state) => ({ ...sessionOf(state), kind: 'setup', step: 'start' }),
};

/** The run, once the packs and Signal's installed packs are read. */
export function migratingWork(state: Migrating): Work[] {
  const instance = signedInInstance(state.telegram);
  const device = linkedDevice(state.signal);
  const packs = state.packs;
  if (state.run.status !== 'running' || !instance || !device || state.signal.kind !== 'linked') return [];
  if (packs.kind !== 'read' || packs.signalRead !== device.deviceId) return [];
  return [{ kind: 'run', key: `run:${state.run.attempt}`, instance, migration: packs.migration, device }];
}
