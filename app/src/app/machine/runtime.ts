// Runs the app's state machine: the one place where the state changes and where work starts and stops.
//
// After every event it takes the new state from the pure transition (app/index.ts), then
// - starts the work the state describes and cancels the work it no longer describes (by key); an event from work
//   that was cancelled is dropped, so a stale TDLib client or an abandoned linking cannot change the state;
// - writes the record when it changed, in order, and reports each write as an event (record/saved, record/failed).
// Events from work are delivered after the current event has been handled, one at a time.

import type { StickerMigration } from '../../kinds/stickers/migration';
import { DEFAULT_DEVICE_NAME } from '../../signal/device-name';
import type { AppServices } from '../services';
import { runWork, type Resources } from './activities';
import { type AppState, appTransition, appWork, recordOf } from './app';
import type { Context } from './core';
import { randomHex } from '../../core/random';
import type { AppEvent } from './events';
import { recordText } from './record';
import type { Work } from './work';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Runtime extends EventTarget {
  state: AppState = { kind: 'locking' };
  readonly #resources: Resources = { telegram: new Map(), devices: new Map() };
  /** The work started, by key, until the state no longer describes it. */
  readonly #work = new Map<string, AbortController>();
  #queue: AppEvent[] = [];
  #handling = false;
  /** The record as last written or being written, as text; null until the record was read. */
  #recordText: string | null = null;
  #writing: Promise<void> = Promise.resolve();
  #migration: StickerMigration | null = null;

  constructor(
    readonly services: AppServices,
    /** Draws the values a transition may use; tests pass fixed ones. */
    private readonly context: () => Context = () => ({ nonce: randomHex(8) }),
  ) {
    super();
  }

  /** Starts the machine: the work of the first state. */
  start(): void {
    this.#syncWork();
  }

  /** Handles `event`, and then every event it led to. */
  dispatch(event: AppEvent): void {
    this.#queue.push(event);
    if (this.#handling) return;
    this.#handling = true;
    let changed = false;
    try {
      for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
        if (next.type === 'record/loaded') this.#recordText = recordText(next.record);
        const state = appTransition(this.state, next, this.context());
        if (state === this.state) continue;
        this.state = state;
        changed = true;
      }
    } finally {
      this.#handling = false;
    }
    if (!changed) return;
    this.#syncWork();
    this.#saveRecord();
    this.#followMigration();
    this.dispatchEvent(new Event('change'));
  }

  #syncWork(): void {
    const wanted = new Map<string, Work>(appWork(this.state).map((work) => [work.key, work]));
    for (const [key, controller] of this.#work) {
      if (wanted.has(key)) continue;
      controller.abort();
      this.#work.delete(key);
    }
    for (const [key, work] of wanted) {
      if (this.#work.has(key)) continue;
      const controller = new AbortController();
      this.#work.set(key, controller);
      const emit = (event: AppEvent) =>
        queueMicrotask(() => {
          if (this.#work.get(key) === controller && !controller.signal.aborted) this.dispatch(event);
        });
      void runWork(work, {
        services: this.services,
        resources: this.#resources,
        emit,
        cancel: controller.signal,
        deviceName: () => ('signal' in this.state ? this.state.signal.deviceName : DEFAULT_DEVICE_NAME),
      }).catch(() => undefined);
    }
  }

  #saveRecord(): void {
    const record = recordOf(this.state);
    if (record === undefined || this.#recordText === null) return;
    const text = recordText(record);
    if (text === this.#recordText) return;
    this.#recordText = text;
    this.#writing = this.#writing.then(async () => {
      try {
        if (record === null) await this.services.snapshots.clear();
        else await this.services.snapshots.save(record);
        this.dispatch({ type: 'record/saved', telegram: record?.telegram ?? null });
      } catch (error) {
        // Written again with the next change.
        if (this.#recordText === text) this.#recordText = '';
        this.dispatch({ type: 'record/failed', error: message(error) });
      }
    });
  }

  /** The pack list changes by its own operations; the view and the record follow it. */
  #followMigration(): void {
    const packs = 'packs' in this.state ? this.state.packs : null;
    const migration = packs?.kind === 'read' ? packs.migration : null;
    if (migration === this.#migration) return;
    this.#migration?.removeEventListener('change', this.#onMigrationChange);
    migration?.addEventListener('change', this.#onMigrationChange);
    this.#migration = migration;
  }

  #onMigrationChange = (): void => {
    this.#saveRecord();
    this.dispatchEvent(new Event('change'));
  };

  /** Resolves once the record writes started so far are done. */
  async written(): Promise<void> {
    await this.#writing;
  }
}
