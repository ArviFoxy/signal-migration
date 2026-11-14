// The app's state machine as the views use it: the runtime (machine/runtime.ts) with what the views read from the
// state, and the user's actions as events. Nothing here holds state of its own.

import { contactsToAdd } from '../kinds/friends/search';
import type { PackEntry, StickerMigration } from '../kinds/stickers/migration';
import { DEFAULT_DEVICE_NAME } from '../signal/device-name';
import {
  type AppState,
  type Chosen,
  INITIAL_CHOICE,
  isSession,
  linkedDevice,
  type SetupStep,
  setupStepShown,
  signedInInstance,
  type Step,
  stepOf,
} from './machine/app';
import type { Context } from './machine/core';
import type { FriendsState } from './machine/friends';
import { Runtime } from './machine/runtime';
import { initialSignal, type SignalState } from './machine/signal';
import { initialTelegram, type LoginMethod, type LoginQuery, type TelegramState } from './machine/telegram';
import type { AppServices, StoredDevice } from './services';

export { type Chosen, STEPS, type SetupStep, type Step, stepIncluded } from './machine/app';
export type { FriendsState };
export type { AppState };

/** The Telegram login as the Telegram step shows it. */
export class TelegramView extends EventTarget {
  constructor(private readonly workflow: Workflow) {
    super();
  }

  get state(): TelegramState {
    const state = this.workflow.state;
    return isSession(state) ? state.telegram : initialTelegram;
  }

  get method(): LoginMethod {
    return this.state.method;
  }

  /** Why the last attempt failed. */
  get error(): string | null {
    const state = this.state;
    return 'error' in state ? state.error : null;
  }

  /** While a request the user sent (a phone number, a code, a password) is being answered. */
  get sending(): boolean {
    const state = this.state;
    return state.kind === 'login' && state.request !== null && state.request._ !== 'requestQrCodeAuthentication';
  }

  /** The TDLib instance the login uses. */
  get instance(): string | null {
    const state = this.state;
    return 'instance' in state ? state.instance : null;
  }

  useMethod(method: LoginMethod): void {
    this.workflow.dispatch({ type: 'telegram/use-method', method });
  }

  submit(query: LoginQuery): void {
    this.workflow.dispatch({ type: 'telegram/submit', query });
  }

  retry(): void {
    this.workflow.dispatch({ type: 'telegram/retry' });
  }
}

/** The Signal device as the Signal step shows it. */
export class SignalView extends EventTarget {
  constructor(private readonly workflow: Workflow) {
    super();
  }

  get state(): SignalState {
    const state = this.workflow.state;
    return isSession(state) ? state.signal : initialSignal(DEFAULT_DEVICE_NAME);
  }

  get device(): StoredDevice | null {
    return linkedDevice(this.state);
  }

  get error(): string | null {
    const state = this.state;
    return 'error' in state ? state.error : null;
  }

  get deviceName(): string {
    return this.state.deviceName;
  }

  set deviceName(name: string) {
    this.workflow.dispatch({ type: 'signal/device-name', name });
  }

  retry(): void {
    this.workflow.dispatch({ type: 'signal/retry' });
  }
}

export class Workflow extends Runtime {
  readonly telegram = new TelegramView(this);
  readonly signal = new SignalView(this);

  constructor(services: AppServices, context?: () => Context) {
    super(services, context);
    this.addEventListener('change', () => {
      this.telegram.dispatchEvent(new Event('change'));
      this.signal.dispatchEvent(new Event('change'));
    });
  }

  /** The step on screen. */
  get step(): Step {
    return isSession(this.state) ? stepOf(this.state) : 'start';
  }

  /** Whether `step` could be on screen if the user asked for it (for the address bar). */
  canShow(step: Step): boolean {
    const state = this.state;
    if (state.kind !== 'setup' || step === 'migrate') return step === this.step;
    return (
      setupStepShown(
        step,
        signedInInstance(state.telegram) !== null,
        linkedDevice(state.signal) !== null,
        state.chosen,
      ) === step
    );
  }

  /** What the user chose to move. */
  get chosen(): Chosen {
    return isSession(this.state) ? this.state.chosen : INITIAL_CHOICE;
  }

  choose(what: keyof Chosen, chosen: boolean): void {
    this.dispatch({ type: 'choose', what, chosen });
  }

  /** The search for friends: none while friends are not chosen or an account is not connected. */
  get friends(): FriendsState {
    return isSession(this.state) ? this.state.friends : { kind: 'none' };
  }

  /** The Telegram user IDs of found friends the user unticked. */
  get untickedFriends(): readonly number[] {
    return isSession(this.state) ? this.state.untickedFriends : [];
  }

  tickFriends(userIds: number[], ticked: boolean): void {
    this.dispatch({ type: 'tick-friends', userIds, ticked });
  }

  /** How many friends are chosen to be added: found, not in Signal yet, and left ticked. */
  get friendsToAdd(): number {
    const friends = this.friends;
    return friends.kind === 'found' ? contactsToAdd(friends.search, this.untickedFriends).length : 0;
  }

  /** How many friends the run has added to the Signal contacts, once it has; null before, and without a run. */
  get friendsAdded(): number | null {
    const state = this.state;
    if (state.kind === 'migrating') return state.run.friendsAdded;
    return state.kind === 'done' && state.chosen.friends ? this.friendsToAdd : null;
  }

  /** The pack list, once read. */
  get stickers(): StickerMigration | null {
    const state = this.state;
    return isSession(state) && state.packs.kind === 'read' ? state.packs.migration : null;
  }

  /** The packs are read and looked up, and Signal's installed packs are read from the linked device. */
  get packsReady(): boolean {
    const state = this.state;
    if (!isSession(state) || state.packs.kind !== 'read') return false;
    const device = linkedDevice(state.signal);
    return device === null || state.packs.signalRead === device.deviceId;
  }

  /** The newest failure of background work: reading the packs or Signal's packs, the run. */
  get error(): string | null {
    const state = this.state;
    if (!isSession(state)) return null;
    if (state.friends.kind === 'failed') return state.friends.error;
    if (state.packs.kind === 'failed') return state.packs.error;
    if (state.packs.kind === 'read' && state.packs.signalError) return state.packs.signalError;
    if (state.kind === 'migrating' && state.run.error) return state.run.error;
    return null;
  }

  /** What the user should know, until dismissed. */
  get notice(): string | null {
    return isSession(this.state) ? this.state.notice : null;
  }

  get canTryAgain(): boolean {
    return this.error !== null;
  }

  /** Whether "Disconnect and clear local state" has anything to do. */
  get canClear(): boolean {
    const state = this.state;
    if (state.kind === 'migrating') return true;
    if (state.kind !== 'setup') return false;
    return !(state.step === 'start' && state.telegram.kind === 'off' && state.signal.kind === 'off');
  }

  /** Asks for a step of the setup; from the migration, it stops the run and keeps both logins. */
  goTo(step: Step): boolean {
    if (step === 'migrate') return this.state.kind === 'migrating';
    if (this.state.kind !== 'setup' && this.state.kind !== 'migrating') return false;
    this.dispatch({ type: 'go-to', step: step as SetupStep });
    return true;
  }

  setSelected(entries: PackEntry[], selected: boolean): void {
    for (const entry of entries) this.stickers?.setSelected(entry, selected);
  }

  startMigration(): void {
    this.stickers?.stopPreviews();
    this.dispatch({ type: 'start-migration' });
  }

  /** Runs again what failed: reading packs, reading Signal, or the packs that failed to migrate. */
  tryAgain(): void {
    const state = this.state;
    if (state.kind === 'migrating') {
      this.stickers?.retryFailed();
      this.dispatch({ type: 'run/retry' });
    } else {
      this.dispatch({ type: 'packs/try-again' });
      this.dispatch({ type: 'friends/try-again' });
    }
  }

  dismissError(): void {
    this.dispatch({ type: 'dismiss' });
  }

  finish(): void {
    this.dispatch({ type: 'finish' });
  }

  clear(): void {
    this.dispatch({ type: 'clear' });
  }

  signOutOfTelegram(): void {
    this.dispatch({ type: 'telegram/stop' });
  }

  unlinkSignal(): void {
    this.dispatch({ type: 'signal/unlink', reason: 'by-user' });
  }

  startOver(): void {
    this.dispatch({ type: 'start-over' });
  }

  /** On "Not everything could be logged out": ends the failed parts again. */
  retryEnd(): void {
    this.dispatch({ type: 'end/retry' });
  }

  /** On "Not everything could be logged out": deletes a part from the browser without ending it. */
  forget(part: 'telegram' | 'signal'): void {
    this.dispatch({ type: 'end/forget', part });
  }

  retryLoad(): void {
    this.dispatch({ type: 'load/retry' });
  }

  /** Resolves once the record writes started so far are done. */
  settled(): Promise<void> {
    return this.written();
  }
}
