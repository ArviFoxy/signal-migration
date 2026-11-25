// The app's state machine as the views use it: the runtime (machine/runtime.ts) with what the views read from the
// state, and the user's actions as events. Nothing here holds state of its own.

import { contactsToAdd } from '../kinds/friends/search';
import {
  type LeftOut,
  leftOutFrom,
  mediaSummaryFrom,
  messagesToCopy,
  notYetSent,
  type SavedWait,
} from '../kinds/saved/copy';
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
import { migrationProgress } from './machine/app/migrating';
import type { Context } from './machine/core';
import type { FriendsState } from './machine/friends';
import type { PacksState } from './machine/packs';
import type { SavedState } from './machine/saved';
import { Runtime } from './machine/runtime';
import { initialSignal, type SignalState } from './machine/signal';
import { initialTelegram, type LoginMethod, type LoginQuery, type TelegramState } from './machine/telegram';
import type { AppServices, StoredDevice } from './services';

export { type Chosen, STEPS, type SetupStep, type Step, stepIncluded } from './machine/app';
export type { FriendsState, PacksState, SavedState };
export type { AppState };

/** Cross-kind migration progress and actions, derived once in the workflow rather than recomputed in views. */
export type MigrationRunStatus = {
  /** Every chosen kind has stopped working (completed, finished with pack failures, or hit a run error). */
  ended: boolean;
  /** Every chosen kind finished with no run-level error. */
  completed: boolean;
  /** Either a run-level error occurred or at least one pack failed / was not announced yet. */
  canRetry: boolean;
  /** The run stopped with a run-level error. */
  failed: boolean;
  /** Unlinking Signal and signing out of Telegram. */
  ending: boolean;
  /** Logged out of Telegram and Signal; nothing kept in the browser. */
  finished: boolean;
};

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

  /** The Telegram user IDs of found friends the user ticked. */
  get tickedFriends(): readonly number[] {
    return isSession(this.state) ? this.state.tickedFriends : [];
  }

  tickFriends(userIds: number[], ticked: boolean): void {
    this.dispatch({ type: 'tick-friends', userIds, ticked });
  }

  /** How many friends are chosen to be added: found, not in Signal yet, and ticked. */
  get friendsToAdd(): number {
    const friends = this.friends;
    return friends.kind === 'found' ? contactsToAdd(friends.search, this.tickedFriends).length : 0;
  }

  /** How many friends the run has added to the Signal contacts, once it has; null before, and without a run. */
  get friendsAdded(): number | null {
    const state = this.state;
    if (state.kind === 'migrating') return state.run.friendsAdded;
    return state.kind === 'done' && state.chosen.friends ? this.friendsToAdd : null;
  }

  /** The reading of Saved Messages: none while they are not chosen or Telegram is not signed in. */
  get saved(): SavedState {
    return isSession(this.state) ? this.state.saved : { kind: 'none' };
  }

  /** The date from which the saved messages are copied (seconds since 1970); null copies from the first message. */
  get savedFrom(): number | null {
    return isSession(this.state) ? this.state.savedFrom : null;
  }

  copySavedFrom(from: number | null): void {
    this.dispatch({ type: 'copy-saved-from', from });
  }

  /**
   * The saved messages of the chosen dates: how many are copied, how many of them are in Signal, how many carry
   * media (and their known byte size), and how many are left out, by the reason. Null until the messages are read.
   */
  get savedCopy(): {
    toCopy: number;
    copied: number;
    withMedia: number;
    mediaBytes: number;
    leftOut: LeftOut;
  } | null {
    const state = this.state;
    if (!isSession(state) || state.saved.kind !== 'read') return null;
    const toCopy = messagesToCopy(state.saved.messages, state.savedFrom);
    return {
      toCopy: toCopy.length,
      copied: toCopy.length - notYetSent(toCopy, state.savedSentUpTo).length,
      ...mediaSummaryFrom(state.saved.messages, state.savedFrom),
      leftOut: leftOutFrom(state.saved.messages, state.savedFrom),
    };
  }

  /** Active Signal or Telegram rate-limit pause while copying Saved Messages; null when actively copying or idle. */
  get savedWait(): SavedWait | null {
    return this.state.kind === 'migrating' ? (this.state.run.savedWait ?? null) : null;
  }

  /** The reading of sticker packs: none while stickers are not chosen or Telegram is not signed in. */
  get packs(): PacksState {
    return isSession(this.state) ? this.state.packs : { kind: 'none' };
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
    return state.signal.kind !== 'linked' || state.packs.signalRead === state.signal.deviceKey;
  }

  /** Each kind the user chose is ready for the migration: the packs are read, the friends are looked for. */
  get ready(): boolean {
    const chosen = this.chosen;
    return (
      (!chosen.stickers || this.packsReady) &&
      (!chosen.friends || this.friends.kind === 'found') &&
      (!chosen.saved || this.saved.kind === 'read')
    );
  }

  /** The run stopped with an error. */
  get runFailed(): boolean {
    return this.state.kind === 'migrating' && this.state.run.status === 'failed';
  }

  /** Cross-kind migration completion and retry status for the migrate screen (shares predicate with settleMigrating). */
  get migrationRun(): MigrationRunStatus {
    const state = this.state;
    if (state.kind === 'done') {
      return { ended: true, completed: true, canRetry: false, failed: false, ending: false, finished: true };
    }
    if (state.kind === 'ending') {
      return { ended: true, completed: true, canRetry: false, failed: false, ending: true, finished: false };
    }
    if (!isSession(state)) {
      return { ended: false, completed: false, canRetry: false, failed: false, ending: false, finished: false };
    }
    const progress = migrationProgress(state);
    return {
      ended: progress.ended,
      completed: progress.completed,
      canRetry: progress.canRetry,
      failed: progress.failed,
      ending: false,
      finished: false,
    };
  }

  /** The newest failure of background work: reading the packs or Signal's packs, the run. */
  get error(): string | null {
    const state = this.state;
    if (!isSession(state)) return null;
    if (state.friends.kind === 'failed') return state.friends.error;
    if (state.saved.kind === 'failed') return state.saved.error;
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
    this.dispatch({ type: 'start-migration' });
  }

  /** Runs again what failed: reading packs, reading Signal, reading friends or saved messages, or the run. */
  tryAgain(): void {
    const state = this.state;
    if (state.kind === 'migrating' && state.run.status !== 'running') {
      this.stickers?.retryFailed();
      this.dispatch({ type: 'run/retry' });
    }
    this.dispatch({ type: 'packs/try-again' });
    this.dispatch({ type: 'friends/try-again' });
    this.dispatch({ type: 'saved/try-again' });
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
