// The workflow: the app's one state machine, and the only place that changes the app's state.
//
// It is a hierarchical state machine. Its own state is the phase of the process:
//
//   loading ──▶ setup (start ▸ telegram ▸ signal ▸ packs ▸ review) ──▶ migrating ──▶ finishing ──▶ finished
//                 ▲                                                                                 │
//                 ├────────── clearing ◀── "Disconnect and clear local state", from any phase       │
//                 └─────────────────────────────────────────────────────── start over ◀────────────┘
//
// nextPhase() lists these transitions. Inside it are two child machines for the accounts, `telegram`
// (TelegramLogin) and `signal` (SignalLink), and the migration's data, `stickers`. The children change only on the
// workflow's commands, and report every change to it.
//
// Nothing about the screen is stored. The step shown is computed from the whole state (stepShown): the furthest step,
// up to the one the user asked for, whose needs are met. So when Signal is unlinked from the phone during the
// review, the Signal step shows; once linked again, the review shows again, however that came about.
//
// Each state has its activities, started by #reconcile() after every change: a QR code for Telegram while the
// Telegram step shows, the packs read for each new Telegram session, a QR code for Signal while the Signal step
// shows, Signal's installed packs read for each device, and the migration run while migrating with both accounts
// connected.
//
// What a reload needs is kept in the browser as a snapshot: a projection of the state, written after every change.
// The child machines also write it at the moments that matter, and wait for it: a new Telegram instance before
// TDLib starts on it, a Signal device as soon as it is linked. A reload therefore finds every login this page
// started, however the page ended, and continues from the same state.

import { type PackEntry, StickerMigration } from '../kinds/stickers/migration';
import type { AppServices, LinkedDevice, StoredDevice, TelegramSession } from './services';
import { type SignalState, SignalLink, type UnlinkReason } from './signal-link';
import { TelegramLogin, type TelegramState } from './telegram-login';

export const STEPS = ['start', 'telegram', 'signal', 'packs', 'review', 'migrate'] as const;
export type Step = (typeof STEPS)[number];
export type SetupStep = Exclude<Step, 'migrate'>;
const SETUP_STEPS: readonly string[] = STEPS.filter((step) => step !== 'migrate');

export type Phase =
  /** Reading the snapshot. */
  | { kind: 'loading' }
  /** Choosing what to migrate and connecting the accounts; `step` is the step the user asked for. */
  | { kind: 'setup'; step: SetupStep }
  | { kind: 'migrating' }
  /** Unlinking Signal and signing out of Telegram after the migration. */
  | { kind: 'finishing' }
  /** Done. The migration screen stays, in its final state. */
  | { kind: 'finished' }
  /** Unlinking, signing out and deleting what this page kept, then back to the start. */
  | { kind: 'clearing' };

export type PhaseEvent =
  | { type: 'loaded'; phase: Phase }
  | { type: 'go-to'; step: SetupStep }
  | { type: 'start-migration' }
  | { type: 'finish' }
  | { type: 'finished' }
  | { type: 'clear' }
  | { type: 'cleared' }
  | { type: 'start-over' };

/** The workflow's transitions: the phase after `event`, or null when the event does not apply in `phase`. */
export function nextPhase(phase: Phase, event: PhaseEvent): Phase | null {
  switch (event.type) {
    case 'loaded':
      return phase.kind === 'loading' ? event.phase : null;
    case 'go-to':
      return phase.kind === 'setup' ? { kind: 'setup', step: event.step } : null;
    case 'start-migration':
      return phase.kind === 'setup' ? { kind: 'migrating' } : null;
    case 'finish':
      return phase.kind === 'migrating' ? { kind: 'finishing' } : null;
    case 'finished':
      return phase.kind === 'finishing' ? { kind: 'finished' } : null;
    case 'clear':
      return phase.kind === 'loading' || phase.kind === 'clearing' ? null : { kind: 'clearing' };
    case 'cleared':
      return phase.kind === 'clearing' ? { kind: 'setup', step: 'start' } : null;
    case 'start-over':
      return phase.kind === 'finished' ? { kind: 'setup', step: 'start' } : null;
  }
}

/** The step on screen: the furthest step, up to the one asked for, whose needs are met. */
export function stepShown(phase: Phase, telegram: TelegramState, signal: SignalState): Step {
  switch (phase.kind) {
    case 'loading':
    case 'clearing':
      return 'start';
    case 'finishing':
    case 'finished':
      return 'migrate';
  }
  const signedIn = telegram.kind === 'ready';
  const linked = signal.kind === 'linked' || signal.kind === 'unlinking';
  const needsMet: Record<Step, boolean> = {
    start: true,
    telegram: true,
    // Both logins come before choosing packs, so that nobody chooses among 100+ packs before both are known to work.
    signal: signedIn,
    packs: signedIn && linked,
    review: signedIn && linked,
    migrate: signedIn && linked,
  };
  const target: Step = phase.kind === 'migrating' ? 'migrate' : phase.step;
  let shown: Step = 'start';
  for (const step of STEPS) {
    if (!needsMet[step]) break;
    shown = step;
    if (step === target) break;
  }
  return shown;
}

/** What is kept in the browser between visits. */
export type Snapshot = {
  version: 2;
  phase: 'setup' | 'migrating' | 'finishing' | 'clearing';
  /** The step asked for, in setup. */
  step: SetupStep;
  /** The TDLib instance holding the Telegram login. */
  telegram: string | null;
  signal: StoredDevice | null;
  /** Telegram sticker set IDs the user deselected. */
  deselected: string[];
};

function phaseOf(snapshot: Snapshot): Phase {
  return snapshot.phase === 'setup' ? { kind: 'setup', step: snapshot.step } : { kind: snapshot.phase };
}

function isSnapshot(value: unknown): value is Snapshot {
  const snapshot = value as Snapshot | null;
  return (
    snapshot?.version === 2 &&
    ['setup', 'migrating', 'finishing', 'clearing'].includes(snapshot.phase) &&
    SETUP_STEPS.includes(snapshot.step)
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How long to wait for leftover Telegram data to be deleted at load; the rest is tried at the next load. */
const LEFTOVER_TIMEOUT_MS = 5000;

export class Workflow extends EventTarget {
  phase: Phase = { kind: 'loading' };
  readonly telegram: TelegramLogin;
  readonly signal: SignalLink;
  stickers: StickerMigration | null = null;
  /** A failure of background work (reading packs, the index, the browser's storage), until dismissed. */
  error: string | null = null;
  /** The Telegram session the packs were read from. */
  #stickersSession: TelegramSession | null = null;
  #readingSignal = false;
  #running = false;
  /** Background work that failed and waits for "Try again". */
  #failed = new Set<'packs' | 'signal' | 'run'>();
  #deselected: string[] = [];
  #keptTelegram: string | null = null;
  #keptSignal: StoredDevice | null = null;
  #savedJson: string | null = null;
  #saving: Promise<void> = Promise.resolve();
  #reconcileQueued = false;
  #continuing: Promise<void> = Promise.resolve();

  constructor(readonly services: AppServices) {
    super();
    this.telegram = new TelegramLogin(services.telegram, (instance) => {
      this.#keptTelegram = instance;
      return this.#save();
    });
    this.signal = new SignalLink(services.signal, (device) => {
      this.#keptSignal = device;
      return this.#save();
    });
    this.telegram.addEventListener('change', this.#onChange);
    this.signal.addEventListener('change', this.#onChange);
  }

  #onChange = (): void => {
    this.dispatchEvent(new Event('change'));
    void this.#save();
    if (!this.#reconcileQueued) {
      this.#reconcileQueued = true;
      queueMicrotask(() => {
        this.#reconcileQueued = false;
        this.#reconcile();
      });
    }
  };

  /** Applies a transition; false when the event does not apply in the current phase. */
  #dispatch(event: PhaseEvent): boolean {
    const next = nextPhase(this.phase, event);
    if (!next) return false;
    this.phase = next;
    this.#onChange();
    return true;
  }

  get step(): Step {
    return stepShown(this.phase, this.telegram.state, this.signal.state);
  }

  /**
   * Whether `step` can be on screen now, without anything else happening first: in setup, a step whose needs are
   * met; otherwise only the step shown. The address bar can go only to such a step.
   */
  canShow(step: Step): boolean {
    if (this.phase.kind !== 'setup' || step === 'migrate') return step === this.step;
    return stepShown({ kind: 'setup', step }, this.telegram.state, this.signal.state) === step;
  }

  /** Whether "Disconnect and clear local state" has anything to do. */
  get canClear(): boolean {
    if (this.phase.kind === 'loading' || this.phase.kind === 'clearing' || this.phase.kind === 'finished') return false;
    return !(
      this.phase.kind === 'setup' &&
      this.phase.step === 'start' &&
      this.telegram.state.kind === 'off' &&
      this.signal.state.kind === 'off'
    );
  }

  /** The packs are read and looked up in the index, and Signal's installed packs are read from the linked device. */
  get packsReady(): boolean {
    const device = this.signal.device;
    const stickers = this.stickers;
    return !!stickers?.lookedUp && (device === null || stickers.signalReadFrom === device);
  }

  /** Whether background work failed and can be tried again. */
  get canTryAgain(): boolean {
    return this.#failed.size > 0;
  }

  // Saving

  #snapshot(): Snapshot | null | undefined {
    const phase = this.phase;
    if (phase.kind === 'loading') return undefined;
    const telegram = this.#keptTelegram;
    const signal = this.#keptSignal;
    const nothingKept = telegram === null && signal === null;
    if (nothingKept && (phase.kind === 'finished' || phase.kind === 'clearing')) return null;
    if (nothingKept && phase.kind === 'setup' && phase.step === 'start') return null;
    return {
      version: 2,
      // A finished migration that left a login behind (the unlink or sign-out failed) ends it at the next visit.
      phase: phase.kind === 'finished' ? 'finishing' : phase.kind,
      step: phase.kind === 'setup' ? phase.step : 'review',
      telegram,
      signal,
      deselected: this.stickers
        ? this.stickers.entries.filter((entry) => !entry.selected).map((entry) => entry.pack.setId)
        : this.#deselected,
    };
  }

  /** Writes the snapshot if it changed; writes happen in order. Resolves once this state is written. */
  #save(): Promise<void> {
    const snapshot = this.#snapshot();
    if (snapshot === undefined) return this.#saving;
    const json = JSON.stringify(snapshot, (_, value) => (value instanceof Uint8Array ? Array.from(value) : value));
    const write = async () => {
      if (json === this.#savedJson) return;
      if (snapshot === null) await this.services.snapshots.clear();
      else await this.services.snapshots.save(snapshot);
      this.#savedJson = json;
    };
    this.#saving = this.#saving.then(write).catch((error) => {
      this.error = `This browser could not keep the migration's progress: ${message(error)}`;
      this.dispatchEvent(new Event('change'));
    });
    return this.#saving;
  }

  // Activities

  #reconcile(): void {
    const phase = this.phase.kind;
    if (phase === 'loading' || phase === 'clearing') return;
    const step = this.step;
    const session = this.telegram.session;
    const device = this.signal.device;
    const active = phase === 'setup' || phase === 'migrating';

    if (step === 'telegram' && this.telegram.state.kind === 'off' && this.telegram.error === null)
      void this.telegram.start();

    if (active && this.stickers && this.#stickersSession !== session) this.#dropStickers();
    if (active && session && !this.stickers && !this.#failed.has('packs')) this.#readPacks(session);

    if (step === 'signal' && this.signal.state.kind === 'off' && this.signal.error === null) this.signal.link();
    if (step !== 'signal' && this.signal.state.kind === 'linking') this.signal.cancel();

    const stickers = this.stickers;
    if (!active || !stickers || !stickers.lookedUp || !device) return;
    if (stickers.signalReadFrom !== device) {
      if (!this.#readingSignal && !this.#failed.has('signal')) this.#readSignal(stickers, device);
      return;
    }
    if (phase !== 'migrating' || !session || this.#running) return;
    const selected = stickers.selected;
    // Done once every pack is in Signal and the other devices were told; the phone shows nothing otherwise.
    if (selected.every((entry) => entry.state === 'in-signal') && stickers.unannounced === 0) {
      void this.finish();
    } else if (
      !this.#failed.has('run') &&
      (selected.some((entry) => entry.state !== 'in-signal' && entry.state !== 'failed') ||
        (stickers.unannounced > 0 && stickers.announceError === null))
    ) {
      this.#run(stickers, session, device);
    }
  }

  #dropStickers(): void {
    this.stickers?.pause();
    this.stickers?.removeEventListener('change', this.#onChange);
    if (this.stickers) this.#deselected = this.#snapshot()?.deselected ?? this.#deselected;
    this.stickers = null;
    this.#stickersSession = null;
    this.#running = false;
    this.#failed.clear();
  }

  #readPacks(session: TelegramSession): void {
    const stickers = new StickerMigration(this.services.migration());
    stickers.addEventListener('change', this.#onChange);
    this.stickers = stickers;
    this.#stickersSession = session;
    void (async () => {
      try {
        await stickers.readTelegram(session.source);
        if (this.stickers !== stickers) return;
        for (const entry of stickers.entries)
          if (this.#deselected.includes(entry.pack.setId)) stickers.setSelected(entry, false);
        if (this.phase.kind === 'setup') void stickers.loadPreviews(session.source);
        await stickers.lookUpInIndex();
      } catch (error) {
        if (this.stickers !== stickers) return;
        this.#failed.add('packs');
        this.error = `Reading your sticker packs failed: ${message(error)}`;
      }
      this.#onChange();
    })();
  }

  #readSignal(stickers: StickerMigration, device: LinkedDevice): void {
    this.#readingSignal = true;
    void stickers
      .readSignal(device)
      .then(
        () => undefined,
        (error) => {
          if (this.stickers !== stickers || this.signal.device !== device) return;
          this.#failed.add('signal');
          this.error = `Reading the sticker packs in your Signal failed: ${message(error)}`;
        },
      )
      .finally(() => {
        this.#readingSignal = false;
        this.#onChange();
      });
  }

  #run(stickers: StickerMigration, session: TelegramSession, device: LinkedDevice): void {
    this.#running = true;
    void stickers
      .run(device, session.source)
      .catch((error) => {
        if (this.stickers !== stickers) return;
        this.#failed.add('run');
        this.error = `The migration stopped: ${message(error)}`;
      })
      .finally(() => {
        if (this.stickers === stickers) this.#running = false;
        this.#onChange();
      });
  }

  // Events from the user

  /** Start, Continue, Back and the address bar: asks for a step. False when not in setup. */
  goTo(step: Step): boolean {
    if (step === 'migrate') return this.phase.kind === 'migrating';
    return this.#dispatch({ type: 'go-to', step });
  }

  setSelected(entries: PackEntry[], selected: boolean): void {
    for (const entry of entries) this.stickers?.setSelected(entry, selected);
  }

  /** Starts the migration, from the review. */
  startMigration(): void {
    const stickers = this.stickers;
    if (this.step !== 'review' || !this.packsReady || !stickers || stickers.selected.length === 0) return;
    stickers.stopPreviews();
    this.#dispatch({ type: 'start-migration' });
  }

  /** Runs again what failed: reading packs, reading Signal, or the packs that failed to migrate. */
  tryAgain(): void {
    if (this.#failed.has('packs')) this.#dropStickers();
    this.#failed.clear();
    this.stickers?.retryFailed();
    this.error = null;
    this.#onChange();
  }

  signOutOfTelegram(): Promise<void> {
    if (this.phase.kind === 'setup') this.#dispatch({ type: 'go-to', step: 'start' });
    return this.telegram.stop();
  }

  unlinkSignal(): Promise<void> {
    return this.signal.unlink('by-user');
  }

  /** Ends the migration: unlinks Signal and signs out of Telegram. The migration screen stays, in its final state. */
  async finish(): Promise<void> {
    if (!this.#dispatch({ type: 'finish' })) return;
    await this.#endAccounts('at-finish');
    this.#dispatch({ type: 'finished' });
  }

  /**
   * Unlinks Signal, signs out of Telegram and deletes what this page keeps in the browser, then goes back to the
   * start. Packs already added stay in Signal and in the index. What fails to end stays, with its error shown.
   */
  async clear(): Promise<void> {
    if (!this.#dispatch({ type: 'clear' })) return;
    await this.#clearing();
  }

  async #clearing(): Promise<void> {
    this.#dropStickers();
    this.#deselected = [];
    this.error = null;
    await this.#endAccounts('by-user');
    await this.#deleteLeftovers();
    this.#dispatch({ type: 'cleared' });
  }

  /** After a finished migration, starts a new one. */
  startOver(): void {
    if (!this.#dispatch({ type: 'start-over' })) return;
    this.#dropStickers();
    this.#deselected = [];
  }

  async #endAccounts(reason: UnlinkReason): Promise<void> {
    this.stickers?.pause();
    await this.signal.unlink(reason);
    await this.telegram.stop();
  }

  /** Deletes Telegram data in this browser that no login of this page holds: ended logins, older versions. */
  async #deleteLeftovers(): Promise<void> {
    const work = (async () => {
      for (const instance of await this.services.telegram.instances()) {
        if (instance !== this.#keptTelegram && instance !== this.telegram.instance)
          await this.services.telegram.deleteInstance(instance);
      }
    })().catch(() => undefined);
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, LEFTOVER_TIMEOUT_MS))]);
  }

  dismissError(): void {
    this.error = null;
    this.telegram.error = null;
    this.signal.error = null;
    this.#onChange();
  }

  // Loading

  /** Reads the snapshot and continues from it: the same phase, the same logins. */
  async load(): Promise<void> {
    if (this.phase.kind !== 'loading') return;
    const stored = await this.services.snapshots.load().catch(() => null);
    const snapshot = isSnapshot(stored) ? stored : null;
    if (snapshot) {
      this.#savedJson = JSON.stringify(snapshot, (_, value) =>
        value instanceof Uint8Array ? Array.from(value) : value,
      );
      this.#deselected = snapshot.deselected;
      this.#keptTelegram = snapshot.telegram;
      this.#keptSignal = snapshot.signal;
      if (snapshot.signal) this.signal.restore(snapshot.signal);
      if (snapshot.telegram) void this.telegram.resume(snapshot.telegram);
    }
    await this.#deleteLeftovers();
    this.#dispatch({ type: 'loaded', phase: snapshot ? phaseOf(snapshot) : { kind: 'setup', step: 'start' } });
    // A finish or a clear that a closed page left unfinished goes on.
    const loaded = this.phase as Phase;
    if (loaded.kind === 'finishing') {
      this.#continuing = this.#endAccounts('at-finish').then(() => void this.#dispatch({ type: 'finished' }));
    } else if (loaded.kind === 'clearing') {
      this.#continuing = this.#clearing();
    }
  }

  /** Waits until the workflow and its child machines have run every operation started so far. */
  async settled(): Promise<void> {
    await this.#continuing;
    await Promise.all([this.telegram.settled(), this.signal.settled()]);
    await this.#saving;
  }
}
