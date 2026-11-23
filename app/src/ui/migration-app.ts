// The wizard's view: the step list, connections and "Disconnect and clear local state" on the left, the current step on the right.
// It holds no state of its own beyond what is on screen: it reads the workflow (app/workflow.ts) and calls its
// actions, and re-renders when the workflow changes.
//
// The sidebar stays on screen while a long step (100+ packs) scrolls; on narrow screens it becomes a bar at the top
// whose connections open in a card.

import { html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ATTESTATIONS_URL } from '../attestation/config';
import type { BuildVerification } from '../attestation/verify';
import type { SignalState, UnlinkReason } from '../app/machine/signal';
import type { TelegramState } from '../app/machine/telegram';
import type { Step, Workflow } from '../app/workflow';
import '../kinds/friends/ui/friends-step';
import '../kinds/saved/ui/saved-step';
import '../kinds/stickers/ui/packs-step';
import type { Connection, ConnectionState } from './connections-panel';
import './connections-panel';
import {
  assertNever,
  icons,
  LightElement,
  primaryButton,
  secondaryButton,
  stepHeader,
  stepLabels,
  stepPosition,
  stepsFor,
  stickyFooter,
} from './layout';
import type { MigrateFriends, MigrateSaved } from './migrate-step';
import './migrate-step';
import './review-step';
import './signal-step';
import './telegram-step';

type BannerView = { kind: 'none' } | { kind: 'notice'; key: string; message: string; retryable: boolean };

const TELEGRAM_STATUS: Record<TelegramState['kind'], [ConnectionState, string]> = {
  off: ['off', 'Not connected'],
  creating: ['wait', 'Connecting'],
  starting: ['wait', 'Connecting'],
  login: ['wait', 'Waiting for sign-in'],
  saving: ['on', 'Signed in'],
  'signed-in': ['on', 'Signed in'],
  'signing-out': ['wait', 'Signing out'],
  'ending-by-itself': ['wait', 'Signing out'],
  stopped: ['off', 'Not connected'],
  deleting: ['wait', 'Signing out'],
};

const SIGNAL_STATUS: Record<SignalState['kind'], [ConnectionState, string]> = {
  off: ['off', 'Not linked'],
  linking: ['wait', 'Waiting for scan'],
  linked: ['on', 'Linked'],
  unlinking: ['wait', 'Unlinking'],
};

const UNLINKED: Partial<Record<UnlinkReason, string>> = {
  'by-user': 'Unlinked',
  'from-phone': 'Unlinked from the phone',
  'at-finish': 'Unlinked automatically',
};

@customElement('migration-app')
export class MigrationApp extends LightElement {
  @property({ attribute: false }) workflow!: Workflow;
  @property({ attribute: false }) build: BuildVerification = { kind: 'unverified', url: ATTESTATIONS_URL };
  @state() private dismissedBannerKey: string | null = null;
  #lastRawBannerKey: string | null = null;
  #onChange = () => this.requestUpdate();
  #shownStep: string | undefined;

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('workflow')) {
      (changed.get('workflow') as Workflow | undefined)?.removeEventListener('change', this.#onChange);
      this.workflow.addEventListener('change', this.#onChange);
      this.dismissedBannerKey = null;
      this.#lastRawBannerKey = null;
    }
    if (this.workflow) {
      const rawKey = this.rawBanner()?.key ?? null;
      if (rawKey !== this.#lastRawBannerKey) {
        this.#lastRawBannerKey = rawKey;
        this.dismissedBannerKey = null;
      }
    }
  }

  private closePopover(id: string): void {
    const popover = this.querySelector<HTMLElement>(`#${id}`);
    if (popover?.matches(':popover-open')) popover.hidePopover();
  }

  /** A new step starts at the top of the page. */
  protected updated(): void {
    if (this.workflow && this.workflow.step !== this.#shownStep) {
      this.#shownStep = this.workflow.step;
      window.scrollTo({ top: 0 });
      this.querySelector('main')?.scrollTo({ top: 0 });
    }
  }

  private connections(): { telegram: Connection; signal: Connection; index: Connection } {
    const w = this.workflow;
    const telegram = w.telegram.state;
    const signal = w.signal.state;
    let [telegramState, telegramStatus] = TELEGRAM_STATUS[telegram.kind];
    if (telegram.kind === 'off' && telegram.signedOut) [telegramState, telegramStatus] = ['ended', 'Signed out'];
    // Giving up an unfinished login (switching to the phone number, for example) is not signing out.
    if (telegram.kind === 'deleting' && !telegram.signedOut) [telegramState, telegramStatus] = ['wait', 'Connecting'];
    let [signalState, signalStatus] = SIGNAL_STATUS[signal.kind];
    const unlinked = signal.kind === 'off' && signal.unlinked ? UNLINKED[signal.unlinked] : undefined;
    if (unlinked) [signalState, signalStatus] = ['ended', unlinked];
    const added = w.stickers?.addedToIndex ?? 0;
    const contacted = w.stickers !== null && w.stickers.entries.length > 0;
    return {
      telegram: {
        state: telegramState,
        status: telegramStatus,
        action: { label: 'Sign out', event: 'telegram-sign-out' },
      },
      signal: { state: signalState, status: signalStatus, action: { label: 'Unlink', event: 'signal-unlink' } },
      index: {
        state: !contacted ? 'off' : w.state.kind === 'done' ? 'ended' : 'on',
        status: !contacted
          ? 'Not contacted'
          : added > 0
            ? `${added} pack${added === 1 ? '' : 's'} added`
            : 'List downloaded',
      },
    };
  }

  /** The connections, "Disconnect and clear local state" and the source code link; in the sidebar, or in a card on narrow screens. */
  private connectionsPanel(placement: 'side' | 'below') {
    const connections = this.connections();
    const w = this.workflow;
    return html`<connections-panel
      .telegram=${connections.telegram}
      .signal=${connections.signal}
      .index=${connections.index}
      .placement=${placement}
      .clearTarget=${'clear-everything'}
      .canClear=${w.canClear}
      .build=${this.build}
      @telegram-sign-out=${() => {
        this.closePopover('connections-sheet');
        w.signOutOfTelegram();
      }}
      @signal-unlink=${() => {
        this.closePopover('connections-sheet');
        w.unlinkSignal();
      }}
    ></connections-panel>`;
  }

  /** One shared confirmation popover hoisted outside the sidebar and mobile connections sheet. */
  private clearPopover() {
    const w = this.workflow;
    return html`<div
      id="clear-everything"
      popover
      class="m-auto w-[min(420px,calc(100vw-32px))] rounded-2xl bg-white p-6 text-ink shadow-[0_8px_40px_rgba(20,20,30,0.18)] ring-1 ring-line backdrop:bg-ink/20"
    >
      <div class="flex flex-col gap-4">
        <h3 class="font-display text-lg font-semibold">Disconnect and clear local state?</h3>
        <p class="text-[15px]">
          This signs your browser out of Telegram, unlinks your browser from your Signal account, and deletes what the
          migration keeps in your browser, then starts over. Nothing in your Telegram or Signal account is deleted.
          Packs already added stay in Signal.
        </p>
        <div class="flex justify-end gap-3">
          <button type="button" popovertarget="clear-everything" popovertargetaction="hide" class=${secondaryButton}>
            Cancel
          </button>
          <button
            type="button"
            class="${primaryButton} bg-danger hover:bg-danger"
            @click=${() => {
              this.closePopover('clear-everything');
              this.closePopover('connections-sheet');
              void w.clear();
            }}
          >
            Disconnect and clear
          </button>
        </div>
      </div>
    </div>`;
  }

  /** The entry of the step list that is current: the last one ("Done and logged out") once the migration finished. */
  private currentEntry(): number {
    const steps = stepsFor(this.workflow.chosen);
    return this.workflow.state.kind === 'done' ? steps.length : steps.indexOf(this.workflow.step);
  }

  /** The step before (-1) or after (1) `step` among the steps for what the user chose. */
  private beside(step: Step, direction: -1 | 1): Step {
    const steps = stepsFor(this.workflow.chosen);
    return steps[steps.indexOf(step) + direction] ?? step;
  }

  private nav() {
    const current = this.currentEntry();
    const finished = this.workflow.state.kind === 'done';
    return html`<nav
      aria-label="Migration steps"
      class="hidden w-[272px] flex-none flex-col gap-7 border-r border-line bg-panel px-7 py-8 lg:flex"
    >
      <div class="font-display text-[19px] leading-snug font-semibold tracking-[-0.01em]">
        Telegram to Signal Migration 🔒🦊
      </div>
      <ol class="flex flex-col gap-4">
        ${stepLabels(this.workflow.chosen).map((label, i) => {
          const active = i === current;
          const done = i < current || (finished && active);
          const circle = done
            ? 'bg-accent text-white'
            : active
              ? 'bg-white text-accent ring-2 ring-accent ring-inset'
              : 'bg-white text-muted ring-1 ring-line-strong ring-inset';
          const text = active ? 'font-semibold text-ink' : done ? 'font-medium text-ink' : 'font-medium text-muted';
          return html`<li class="flex items-center gap-3" aria-current=${active ? 'step' : 'false'}>
            <span
              class="flex size-7 flex-none items-center justify-center rounded-full text-[13px] font-semibold ${circle}"
              >${done ? icons.check() : i + 1}</span
            >
            <span class="text-sm ${text}">${label}</span>
          </li>`;
        })}
      </ol>
      <div class="mt-auto flex flex-col gap-3">${this.connectionsPanel('side')}</div>
    </nav>`;
  }

  /** The bar that replaces the sidebar on narrow screens. */
  private topBar() {
    const current = this.currentEntry();
    const labels = stepLabels(this.workflow.chosen);
    const label = `Step ${current + 1} of ${labels.length} · ${labels[current]}`;
    return html`<header
      class="flex items-center justify-between gap-3 border-b border-line bg-panel px-4 py-3 lg:hidden"
    >
      <span class="flex flex-col">
        <span class="font-display text-base leading-snug font-semibold">Telegram to Signal Migration 🔒🦊</span>
        <span class="text-xs text-muted">${label}</span>
      </span>
      <button type="button" popovertarget="connections-sheet" class=${secondaryButton}>Connections</button>
      <div
        id="connections-sheet"
        popover
        class="m-auto max-h-[calc(100dvh-32px)] w-[min(400px,calc(100vw-32px))] overflow-y-auto rounded-2xl bg-panel p-5 text-ink shadow-[0_8px_40px_rgba(20,20,30,0.18)] backdrop:bg-ink/20"
      >
        <div class="flex flex-col gap-3">${this.connectionsPanel('below')}</div>
      </div>
    </header>`;
  }

  private startStep() {
    const w = this.workflow;
    const chosen = w.chosen;
    const changeable = w.state.kind === 'setup';
    const choice = (what: 'stickers' | 'friends' | 'saved', title: string) => {
      const frame = chosen[what] ? 'bg-accent-soft ring-2 ring-accent' : 'bg-white ring-1 ring-line-strong';
      return html`<label class="flex cursor-pointer items-center gap-4 rounded-xl px-5 py-[18px] ring-inset ${frame}">
        <input
          type="checkbox"
          class="size-5 flex-none cursor-pointer accent-accent"
          .checked=${chosen[what]}
          ?disabled=${!changeable}
          @change=${(event: Event) => w.choose(what, (event.target as HTMLInputElement).checked)}
        />
        <span class="text-base font-semibold">${title}</span>
      </label>`;
    };
    return html`${stepHeader(
        stepPosition('start', chosen),
        'What to move',
        'Copies what you choose from Telegram into your Signal account.',
      )}
      <fieldset class="flex min-w-0 flex-col gap-3">
        <legend class="mb-3 text-sm font-semibold">From Telegram</legend>
        ${choice('stickers', 'Sticker packs')} ${choice('friends', 'Find your Telegram friends on Signal')}
        ${choice('saved', 'Saved Messages')}
      </fieldset>
      ${stickyFooter(
        html`<span></span>
          <button
            type="button"
            class=${primaryButton}
            ?disabled=${!changeable || !(chosen.stickers || chosen.friends || chosen.saved)}
            @click=${() => w.goTo(this.beside('signal', 1))}
          >
            Start
          </button>`,
      )}`;
  }

  /** Another tab runs the migration. */
  private elsewhere() {
    return stepHeader(null, 'The migration is open in another tab', 'Close it to continue here.');
  }

  /** The record could not be read. */
  private loadFailed(error: string) {
    return html`<div class="flex flex-col items-start gap-3 pt-8 lg:pt-0">
      <p class="text-danger" role="alert">${error}</p>
      <button type="button" class=${secondaryButton} @click=${() => this.workflow.retryLoad()}>Try again</button>
    </div>`;
  }

  /** Signing out of Telegram or unlinking Signal failed at the end, or during a clear. */
  private endFailed(telegramError: string | null, signalError: string | null) {
    const w = this.workflow;
    const part = (error: string, explanation: string, forget: () => void) =>
      html`<section class="flex flex-col items-start gap-2">
        <p class="text-danger" role="alert">${error}</p>
        <button type="button" class=${secondaryButton} @click=${forget}>Forget it</button>
        <p class="text-sm text-muted">${explanation}</p>
      </section>`;
    return html`<h1 class="font-display text-[34px] font-semibold tracking-[-0.01em]">
        Not everything could be logged out
      </h1>
      ${
        telegramError
          ? part(
              telegramError,
              'This deletes the Telegram login from your browser without ending it. End the session in Telegram under Settings › Devices.',
              () => w.forget('telegram'),
            )
          : nothing
      }
      ${
        signalError
          ? part(
              signalError,
              'This deletes the Signal device from your browser without unlinking it. Remove it in Signal under Settings › Linked devices.',
              () => w.forget('signal'),
            )
          : nothing
      }
      ${stickyFooter(
        html`<span></span>
          <button type="button" class=${primaryButton} @click=${() => w.retryEnd()}>Try again</button>`,
      )}`;
  }

  private content() {
    const w = this.workflow;
    const state = w.state;
    switch (state.kind) {
      case 'locking':
      case 'loading':
        return nothing;
      case 'elsewhere':
        return this.elsewhere();
      case 'load-failed':
        return this.loadFailed(state.error);
      case 'end-failed':
        return this.endFailed(state.telegramError, state.signalError);
    }
    const position = stepPosition(w.state.kind === 'done' ? 'done' : w.step, w.chosen);
    switch (w.step) {
      case 'start':
        return this.startStep();
      case 'telegram':
        return html`<telegram-step
          class="contents"
          .login=${w.telegram}
          .position=${position}
          @back=${() => w.goTo('start')}
          @next=${() => w.goTo(this.beside('signal', 1))}
        ></telegram-step>`;
      case 'signal':
        return html`<signal-step
          class="contents"
          .link=${w.signal}
          .position=${position}
          @back=${() => w.goTo('telegram')}
          @next=${() => w.goTo(this.beside('signal', 1))}
        ></signal-step>`;
      case 'packs':
        return html`<sticker-packs-step
          class="contents"
          .packs=${w.packs}
          .migration=${w.stickers}
          .position=${position}
          .allowEmpty=${w.chosen.friends || w.chosen.saved}
          @try-again=${() => w.tryAgain()}
          @select=${(event: CustomEvent<{ entries: never[]; selected: boolean }>) =>
            w.setSelected(event.detail.entries, event.detail.selected)}
          @back=${() => w.goTo('signal')}
          @next=${() => w.goTo(this.beside('packs', 1))}
        ></sticker-packs-step>`;
      case 'friends':
        return html`<friends-step
          class="contents"
          .friends=${w.friends}
          .ticked=${w.tickedFriends}
          .position=${position}
          @tick=${(event: CustomEvent<{ userIds: number[]; ticked: boolean }>) =>
            w.tickFriends(event.detail.userIds, event.detail.ticked)}
          @try-again=${() => w.tryAgain()}
          @back=${() => w.goTo(this.beside('friends', -1))}
          @next=${() => w.goTo(this.beside('friends', 1))}
        ></friends-step>`;
      case 'saved':
        return html`<saved-step
          class="contents"
          .saved=${w.saved}
          .from=${w.savedFrom}
          .copy=${w.savedCopy}
          .position=${position}
          @copy-from=${(event: CustomEvent<{ from: number | null }>) => w.copySavedFrom(event.detail.from)}
          @try-again=${() => w.tryAgain()}
          @back=${() => w.goTo(this.beside('saved', -1))}
          @next=${() => w.goTo('review')}
        ></saved-step>`;
      case 'review':
        return html`<review-step
          class="contents"
          .migration=${w.stickers}
          .position=${position}
          .stickers=${w.chosen.stickers}
          .friends=${w.chosen.friends ? w.friendsToAdd : null}
          .saved=${w.chosen.saved ? (w.savedCopy?.toCopy ?? 0) : null}
          .ready=${w.ready}
          @back=${() => w.goTo(this.beside('review', -1))}
          @start=${() => w.startMigration()}
        ></review-step>`;
      case 'migrate': {
        const friends: MigrateFriends | null = !w.chosen.friends
          ? null
          : w.friends.kind === 'found' || w.state.kind === 'done'
            ? { kind: 'ready', toAdd: w.friendsToAdd, added: w.friendsAdded }
            : w.friends.kind === 'failed'
              ? { kind: 'failed' }
              : { kind: 'looking' };
        const savedCopy = w.savedCopy;
        const saved: MigrateSaved | null = !w.chosen.saved
          ? null
          : savedCopy
            ? { kind: 'ready', toCopy: savedCopy.toCopy, copied: savedCopy.copied }
            : w.saved.kind === 'failed'
              ? { kind: 'failed' }
              : { kind: 'reading' };
        return html`<migrate-step
          class="contents"
          .migration=${w.stickers}
          .position=${position}
          .stickers=${w.chosen.stickers}
          .friends=${friends}
          .saved=${saved}
          .run=${w.migrationRun}
          @retry=${() => w.tryAgain()}
          @finish=${() => w.finish()}
          @back-to-start=${() => w.goTo('start')}
          @restart=${() => w.startOver()}
        ></migrate-step>`;
      }
    }
  }

  /**
   * The newest failure or notice: background work's, TDLib's, or, during the setup and the migration, an account's
   * when its step is not on screen. The end shows the accounts' failures on its own screen.
   */
  private rawBanner(): { key: string; message: string; retryable: boolean } | null {
    const w = this.workflow;
    if (w.error) return { key: `error:${w.error}`, message: w.error, retryable: w.canTryAgain };
    if (w.notice) return { key: `notice:${w.notice}`, message: w.notice, retryable: false };
    const accounts = w.state.kind === 'setup' || w.state.kind === 'migrating';
    if (accounts && w.step !== 'telegram' && w.telegram.error)
      return { key: `telegram:${w.telegram.error}`, message: w.telegram.error, retryable: false };
    if (accounts && w.step !== 'signal' && w.signal.error)
      return { key: `signal:${w.signal.error}`, message: w.signal.error, retryable: false };
    return null;
  }

  private bannerView(): BannerView {
    const raw = this.rawBanner();
    if (!raw || raw.key === this.dismissedBannerKey) return { kind: 'none' };
    return { kind: 'notice', key: raw.key, message: raw.message, retryable: raw.retryable };
  }

  private renderBanner() {
    const w = this.workflow;
    const banner = this.bannerView();
    switch (banner.kind) {
      case 'none':
        return nothing;
      case 'notice':
        return html`<div
          role="alert"
          class="fixed bottom-6 left-1/2 z-50 flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-start gap-3 rounded-xl bg-ink px-4 py-3 text-sm text-white shadow-[0_8px_32px_rgba(20,20,30,0.3)]"
        >
          <span class="flex-1">${banner.message}</span>
          ${
            banner.retryable
              ? html`<button type="button" class="cursor-pointer font-semibold text-white" @click=${() => w.tryAgain()}>
                  Try again
                </button>`
              : nothing
          }
          <button
            type="button"
            aria-label="Dismiss"
            class="cursor-pointer text-white/70 hover:text-white"
            @click=${() => {
              this.dismissedBannerKey = banner.key;
              w.dismissError();
            }}
          >
            ×
          </button>
        </div>`;
      default:
        return assertNever(banner);
    }
  }

  render() {
    const w = this.workflow;
    if (!w) return nothing;
    // On wide screens: a card that fills the window inside a margin, with the step list on the left and the step on
    // the right; only the step scrolls, inside the card. On narrow screens: the page itself scrolls.
    return html`<div class="min-h-screen bg-page font-sans text-ink lg:h-screen lg:p-8">
      <div
        class="mx-auto flex w-full max-w-[1200px] flex-col bg-white lg:h-full lg:flex-row lg:overflow-hidden lg:rounded-[20px] lg:shadow-[0_1px_2px_rgba(20,20,30,0.06),0_12px_32px_rgba(20,20,30,0.08)]"
      >
        ${this.nav()} ${this.topBar()}
        <main class="flex min-w-0 flex-1 flex-col gap-8 px-4 pt-8 sm:px-10 lg:overflow-y-auto lg:px-12 lg:pt-0">
          <!-- The top padding inside the scrolling column, so that sticky bars stick to its top edge. -->
          <div class="-mb-8 hidden h-10 flex-none lg:block" aria-hidden="true"></div>
          ${this.content()}
        </main>
      </div>
      ${this.clearPopover()} ${this.renderBanner()}
    </div>`;
  }
}
