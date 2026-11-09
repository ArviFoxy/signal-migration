// The wizard's view: the step list, connections and "Clear everything" on the left, the current step on the right.
// It holds no state of its own beyond what is on screen: it reads the workflow (app/workflow.ts) and calls its
// actions, and re-renders when the workflow changes.
//
// The sidebar stays on screen while a long step (100+ packs) scrolls; on narrow screens it becomes a bar at the top
// whose connections open in a card.

import { html, nothing, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ConnectionState, Workflow } from '../app/workflow';
import '../kinds/stickers/ui/done-step';
import '../kinds/stickers/ui/migrate-step';
import '../kinds/stickers/ui/packs-step';
import '../kinds/stickers/ui/review-step';
import type { Connection } from './connections-panel';
import './connections-panel';
import { icons, LightElement, primaryButton, secondaryButton, STEP_LABELS, stepHeader, stickyFooter } from './layout';
import './signal-step';
import './telegram-step';

const STEP_ORDER = ['start', 'telegram', 'packs', 'signal', 'review', 'migrate', 'done'] as const;

@customElement('migration-app')
export class MigrationApp extends LightElement {
  @property({ attribute: false }) workflow!: Workflow;
  #onChange = () => this.requestUpdate();
  #shownStep: string | undefined;

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('workflow')) {
      (changed.get('workflow') as Workflow | undefined)?.removeEventListener('change', this.#onChange);
      this.workflow.addEventListener('change', this.#onChange);
    }
  }

  /** A new step starts at the top of the page. */
  protected updated(): void {
    if (this.workflow.route !== this.#shownStep) {
      this.#shownStep = this.workflow.route;
      window.scrollTo({ top: 0 });
      this.querySelector('main')?.scrollTo({ top: 0 });
    }
  }

  private connections(): { telegram: Connection; signal: Connection; index: Connection } {
    const w = this.workflow;
    const telegramStatus: Record<ConnectionState, string> = {
      off: 'Not connected',
      wait: 'Waiting for sign-in',
      on: 'Signed in',
      ended: 'Signed out',
    };
    const signalStatus: Record<ConnectionState, string> = {
      off: 'Not linked',
      wait: 'Waiting for scan',
      on: 'Linked',
      ended: w.unlinkedAutomatically ? 'Unlinked automatically' : 'Unlinked',
    };
    const added = w.stickers?.addedToIndex ?? 0;
    const contacted = w.stickers !== null && w.stickers.entries.length > 0;
    return {
      telegram: {
        state: w.telegram,
        status: telegramStatus[w.telegram],
        action: { label: 'Sign out', event: 'telegram-sign-out' },
      },
      signal: { state: w.signal, status: signalStatus[w.signal], action: { label: 'Unlink', event: 'signal-unlink' } },
      index: {
        state: !contacted ? 'off' : w.route === 'done' ? 'ended' : 'on',
        status: !contacted
          ? 'Not contacted'
          : added > 0
            ? `${added} pack${added === 1 ? '' : 's'} added`
            : 'List downloaded',
      },
    };
  }

  /** The connections, "Clear everything" and the source code link; in the sidebar, or in a card on narrow screens. */
  private connectionsPanel(placement: 'side' | 'below') {
    const connections = this.connections();
    const w = this.workflow;
    const clearId = `clear-everything-${placement}`;
    return html`<connections-panel
        .telegram=${connections.telegram}
        .signal=${connections.signal}
        .index=${connections.index}
        .placement=${placement}
        .clearTarget=${clearId}
        .canClear=${w.telegramSession !== null || w.device !== null || w.stickers !== null}
        @telegram-sign-out=${() => w.signOutOfTelegram()}
        @signal-unlink=${() => w.unlinkSignal()}
      ></connections-panel>
      ${html`<div
        id=${clearId}
        popover
        class="m-auto w-[min(420px,calc(100vw-32px))] rounded-2xl bg-white p-6 text-ink shadow-[0_8px_40px_rgba(20,20,30,0.18)] ring-1 ring-line backdrop:bg-ink/20"
      >
        <div class="flex flex-col gap-4">
          <h3 class="font-display text-lg font-semibold">Clear everything?</h3>
          <p class="text-[15px]">
            This signs out of Telegram, unlinks the Signal device, and deletes what this page keeps in your browser.
            Packs already uploaded and installed stay in Signal.
          </p>
          <div class="flex justify-end gap-3">
            <button type="button" popovertarget=${clearId} popovertargetaction="hide" class=${secondaryButton}>
              Cancel
            </button>
            <button
              type="button"
              class="${primaryButton} bg-danger hover:bg-danger"
              @click=${() => {
                document.getElementById(clearId)?.hidePopover();
                void w.clearEverything();
              }}
            >
              Clear everything
            </button>
          </div>
        </div>
      </div>`}`;
  }

  private nav() {
    const current = STEP_ORDER.indexOf(this.workflow.route);
    return html`<nav
      aria-label="Migration steps"
      class="hidden w-[272px] flex-none flex-col gap-7 border-r border-line bg-panel px-7 py-8 lg:flex"
    >
      <div class="font-display text-[19px] leading-snug font-semibold tracking-[-0.01em]">
        Telegram to Signal Migration 🦊
      </div>
      <ol class="flex flex-col gap-4">
        ${STEP_LABELS.map((label, i) => {
          const done = i < current;
          const active = i === current;
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
    const current = STEP_ORDER.indexOf(this.workflow.route);
    const label =
      current < STEP_LABELS.length ? `Step ${current + 1} of ${STEP_LABELS.length} · ${STEP_LABELS[current]}` : 'Done';
    return html`<header
      class="flex items-center justify-between gap-3 border-b border-line bg-panel px-4 py-3 lg:hidden"
    >
      <span class="flex flex-col">
        <span class="font-display text-base leading-snug font-semibold">Telegram to Signal Migration 🦊</span>
        <span class="text-xs text-muted">${label}</span>
      </span>
      <button type="button" popovertarget="connections-sheet" class=${secondaryButton}>Connections</button>
      <div
        id="connections-sheet"
        popover
        class="m-auto w-[min(400px,calc(100vw-32px))] overflow-visible rounded-2xl bg-panel p-5 text-ink shadow-[0_8px_40px_rgba(20,20,30,0.18)] backdrop:bg-ink/20"
      >
        <div class="flex flex-col gap-3">${this.connectionsPanel('below')}</div>
      </div>
    </header>`;
  }

  private startStep() {
    const w = this.workflow;
    const card = (symbol: ReturnType<typeof icons.download>, name: string, text: string) =>
      html`<li class="flex flex-col gap-2 rounded-xl bg-panel p-[18px] ring-1 ring-line ring-inset">
        ${symbol}<span class="text-[15px] font-semibold">${name}</span><span class="text-sm text-muted">${text}</span>
      </li>`;
    return html`${stepHeader(1, 'What to move', 'Copies what you choose from Telegram into your Signal account.')}
      <fieldset class="flex min-w-0 flex-col gap-3">
        <legend class="mb-3 text-sm font-semibold">From Telegram</legend>
        <label class="flex items-center gap-4 rounded-xl bg-accent-soft px-5 py-[18px] ring-2 ring-accent ring-inset">
          <input type="checkbox" class="size-5 flex-none accent-accent" checked disabled />
          <span class="flex flex-col gap-0.5">
            <span class="text-base font-semibold">Sticker packs</span>
            <span class="text-sm text-muted">Installed packs, in your Telegram order</span>
          </span>
        </label>
      </fieldset>
      <section aria-labelledby="start-connections" class="flex flex-col gap-3">
        <h2 id="start-connections" class="text-sm font-semibold">Connections</h2>
        <ul class="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          ${card(icons.download(), 'Telegram', 'Signed in for the migration, to read your packs. Signed out at the end.')}
          ${card(icons.link(), 'Signal', 'Linked only while the migration runs, to install and upload packs.')}
          ${card(
            icons.database(),
            'Sticker pack index',
            'A list of packs already on Signal, used to avoid uploading them again. It receives only the hash and Signal pack ID of each pack that you upload.',
          )}
        </ul>
      </section>
      ${stickyFooter(
        html`<span></span> <button type="button" class=${primaryButton} @click=${() => w.start()}>Start</button>`,
      )}`;
  }

  private content() {
    const w = this.workflow;
    if (w.restoring) return stepHeader(null, 'Continuing your migration', 'Signing in again and reading your packs…');
    switch (w.route) {
      case 'start':
        return this.startStep();
      case 'telegram':
        return html`<telegram-step
          class="contents"
          .session=${w.telegramSession}
          .authState=${w.telegramAuth}
          @restart-telegram=${() => w.restartTelegram()}
          @back=${() => w.navigate('start')}
          @next=${() => w.continueFromTelegram()}
        ></telegram-step>`;
      case 'packs':
        return html`<sticker-packs-step
          class="contents"
          .migration=${w.stickers}
          @select=${(event: CustomEvent<{ entries: never[]; selected: boolean }>) =>
            w.setSelected(event.detail.entries, event.detail.selected)}
          @back=${() => w.navigate('telegram')}
          @next=${() => w.continueFromPacks()}
        ></sticker-packs-step>`;
      case 'signal':
        return html`<signal-step
          class="contents"
          .workflow=${w}
          @back=${() => w.navigate('packs')}
          @next=${() => w.navigate('review')}
        ></signal-step>`;
      case 'review':
        return html`<sticker-review-step
          class="contents"
          .migration=${w.stickers}
          @back=${() => w.navigate('signal')}
          @start=${() => w.startMigration()}
        ></sticker-review-step>`;
      case 'migrate':
        return html`<sticker-migrate-step
          class="contents"
          .migration=${w.stickers}
          @retry=${() => w.startMigration()}
          @relink=${() => w.navigate('signal')}
          @finish=${() => w.finish()}
        ></sticker-migrate-step>`;
      case 'done':
        return html`<sticker-done-step
          class="contents"
          .migration=${w.stickers}
          .telegramStatus=${w.telegram === 'on' ? 'Signing out…' : 'Signed out'}
          .signalStatus=${w.device ? 'Unlinking…' : w.unlinkedAutomatically ? 'Unlinked automatically' : 'Unlinked'}
          @restart=${() => w.startOver()}
        ></sticker-done-step>`;
    }
  }

  render() {
    const w = this.workflow;
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
      ${
        w.error
          ? html`<div
              role="alert"
              class="fixed bottom-6 left-1/2 z-50 flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-start gap-3 rounded-xl bg-ink px-4 py-3 text-sm text-white shadow-[0_8px_32px_rgba(20,20,30,0.3)]"
            >
              <span class="flex-1">${w.error}</span>
              <button
                type="button"
                aria-label="Dismiss"
                class="cursor-pointer text-white/70 hover:text-white"
                @click=${() => w.dismissError()}
              >
                ×
              </button>
            </div>`
          : nothing
      }
    </div>`;
  }
}
