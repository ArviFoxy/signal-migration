// The migration wizard: the step list and connections panel on the left, the current step on the right.
//
// Flow: what to move → Telegram login → sticker packs (read, looked up in the index, downloaded; then Telegram is
// signed out) → Signal linking → review → migration → done (Signal unlinked). Logins exist only while the page runs.

import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type * as Td from 'tdlib-types';
import { StickerMigration } from '../kinds/stickers/migration';
import '../kinds/stickers/ui/done-step';
import '../kinds/stickers/ui/migrate-step';
import '../kinds/stickers/ui/packs-step';
import '../kinds/stickers/ui/review-step';
import type { Connection, ConnectionState } from './connections-panel';
import './connections-panel';
import { icons, LightElement, primaryButton, STEP_LABELS, stepHeader } from './layout';
import { type AppServices, type LinkedDevice, realServices, type TelegramSession } from './services';
import './signal-step';
import './telegram-step';

type Step = 'start' | 'telegram' | 'packs' | 'signal' | 'review' | 'migrate' | 'done';
const STEP_ORDER: Step[] = ['start', 'telegram', 'packs', 'signal', 'review', 'migrate', 'done'];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Each step element lays out its sections like the main column does. */
const STEP_CLASS = 'flex flex-1 flex-col gap-8';

@customElement('migration-app')
export class MigrationApp extends LightElement {
  @property({ attribute: false }) services: AppServices = realServices;
  @state() private step: Step = 'start';
  @state() private telegram: TelegramSession | null = null;
  @state() private telegramState: Td.AuthorizationState | null = null;
  @state() private telegramConnection: ConnectionState = 'off';
  @state() private signal: LinkedDevice | null = null;
  @state() private signalConnection: ConnectionState = 'off';
  @state() private unlinkedAutomatically = false;
  @state() private migration: StickerMigration | null = null;
  @state() private error: string | null = null;
  @state() private movingStickers = true;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('beforeunload', (event) => {
      if (this.signal || this.telegramConnection === 'on') event.preventDefault();
    });
  }

  private run(action: () => Promise<void>): void {
    this.error = null;
    action().catch((error) => (this.error = message(error)));
  }

  private go(step: Step): void {
    this.step = step;
    this.error = null;
    window.scrollTo({ top: 0 });
  }

  private async startTelegram(): Promise<void> {
    this.go('telegram');
    const app = await this.services.telegramApp();
    if (!app)
      throw new Error('This site has no Telegram app identity configured yet, so it cannot sign in to Telegram.');
    this.telegramConnection = 'wait';
    this.telegram = await this.services.startTelegram(app, (authState) => {
      this.telegramState = authState;
      if (authState._ === 'authorizationStateReady') {
        this.telegramConnection = 'on';
        if (this.step === 'telegram') this.run(() => this.readPacks());
      }
    });
  }

  private async restartTelegram(): Promise<void> {
    const old = this.telegram;
    Object.assign(this, { telegram: null, telegramState: null });
    await old?.close();
    await this.startTelegram();
  }

  private async signOutOfTelegram(): Promise<void> {
    const session = this.telegram;
    this.telegram = null;
    await session?.logOut();
    this.telegramConnection = 'ended';
  }

  /** Reads and downloads the packs, then signs out of Telegram unless a download failed. */
  private async readPacks(): Promise<void> {
    this.go('packs');
    if (this.migration?.entries.length) return;
    const migration = new StickerMigration(this.services.migration());
    // The connections panel shows the migration's progress (packs added to the index).
    migration.addEventListener('change', () => this.requestUpdate());
    this.migration = migration;
    await migration.readTelegram(this.telegram!.source);
    await migration.download(this.telegram!.source);
    if (!migration.entries.some((entry) => entry.state === 'failed')) await this.signOutOfTelegram();
  }

  private async retryDownload(): Promise<void> {
    await this.migration!.download(this.telegram!.source);
    if (!this.migration!.entries.some((entry) => entry.state === 'failed')) await this.signOutOfTelegram();
  }

  private async leavePacks(): Promise<void> {
    if (this.telegram) await this.signOutOfTelegram();
    this.go(this.signal ? 'review' : 'signal');
  }

  private async onLinked(device: LinkedDevice): Promise<void> {
    this.signal = device;
    this.signalConnection = 'on';
    device.onUnlinked = () => {
      this.signal = null;
      this.signalConnection = 'ended';
      if (this.step === 'review') this.go('signal');
    };
    await this.migration!.readSignal(device);
    this.go('review');
  }

  private async migrate(): Promise<void> {
    if (!this.signal) {
      this.go('signal');
      return;
    }
    this.go('migrate');
    await this.migration!.run(this.signal);
    if (this.migration!.selected.every((entry) => entry.state === 'in-signal')) await this.finish();
  }

  /** Unlinks the Signal device and ends any Telegram session. */
  private async finish(): Promise<void> {
    this.go('done');
    const errors: string[] = [];
    if (this.signal) {
      await this.signal.unlink().catch((error) => errors.push(`Unlinking Signal failed: ${message(error)}`));
      this.unlinkedAutomatically = true;
    }
    if (this.telegram)
      await this.signOutOfTelegram().catch((error) => errors.push(`Signing out of Telegram failed: ${message(error)}`));
    this.error = errors.length > 0 ? errors.join(' ') : null;
  }

  private async unlinkFromPanel(): Promise<void> {
    await this.signal?.unlink();
  }

  private restart(): void {
    Object.assign(this, {
      migration: null,
      telegramState: null,
      telegramConnection: 'off',
      signalConnection: 'off',
      unlinkedAutomatically: false,
    });
    this.go('start');
  }

  private connections(): { telegram: Connection; signal: Connection; index: Connection } {
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
      ended: this.unlinkedAutomatically ? 'Unlinked automatically' : 'Unlinked',
    };
    const signalState: ConnectionState =
      this.signalConnection === 'off' && this.step === 'signal' ? 'wait' : this.signalConnection;
    const migration = this.migration;
    const added = migration?.addedToIndex ?? 0;
    const indexContacted = migration !== null && migration.entries.length > 0;
    return {
      telegram: {
        state: this.telegramConnection,
        status: telegramStatus[this.telegramConnection],
        action: { label: 'Sign out', event: 'telegram-sign-out' },
      },
      signal: {
        state: signalState,
        status: signalStatus[signalState],
        action: { label: 'Unlink', event: 'signal-unlink' },
      },
      index: {
        state: !indexContacted ? 'off' : this.step === 'done' ? 'ended' : 'on',
        status: !indexContacted
          ? 'Not contacted'
          : added > 0
            ? `${added} pack${added === 1 ? '' : 's'} added`
            : 'List downloaded',
      },
    };
  }

  private nav() {
    const current = STEP_ORDER.indexOf(this.step);
    const connections = this.connections();
    return html`<nav
      aria-label="Migration steps"
      class="flex flex-[1_1_240px] flex-col gap-7 border-r border-line bg-panel px-7 py-8"
    >
      <div class="font-display text-base font-semibold">signal-migration</div>
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
      <connections-panel
        class="mt-auto"
        .telegram=${connections.telegram}
        .signal=${connections.signal}
        .index=${connections.index}
        @telegram-sign-out=${() => this.run(() => this.signOutOfTelegram())}
        @signal-unlink=${() => this.run(() => this.unlinkFromPanel())}
      ></connections-panel>
    </nav>`;
  }

  private startStep() {
    const card = (symbol: ReturnType<typeof icons.download>, name: string, text: string) =>
      html`<li class="flex flex-col gap-2 rounded-xl bg-panel p-[18px] ring-1 ring-line ring-inset">
        ${symbol}<span class="text-[15px] font-semibold">${name}</span><span class="text-sm text-muted">${text}</span>
      </li>`;
    return html`${stepHeader(1, 'What to move', 'Copies what you choose from Telegram into your Signal account.')}
      <fieldset class="flex min-w-0 flex-col gap-3">
        <legend class="mb-3 text-sm font-semibold">From Telegram</legend>
        <label
          class="flex cursor-pointer items-center gap-4 rounded-xl px-5 py-[18px] ring-1 ring-line-strong ring-inset has-checked:bg-accent-soft has-checked:ring-2 has-checked:ring-accent"
        >
          <input
            type="checkbox"
            class="size-5 flex-none accent-accent"
            .checked=${this.movingStickers}
            @change=${(event: Event) => (this.movingStickers = (event.target as HTMLInputElement).checked)}
          />
          <span class="flex flex-col gap-0.5">
            <span class="text-base font-semibold">Sticker packs</span>
            <span class="text-sm text-muted">Installed packs, in your Telegram order</span>
          </span>
        </label>
      </fieldset>
      <section aria-labelledby="start-connections" class="flex flex-col gap-3">
        <h2 id="start-connections" class="text-sm font-semibold">Connections</h2>
        <ul class="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          ${card(icons.download(), 'Telegram', 'Signs in to read your packs, then signs out.')}
          ${card(icons.link(), 'Signal', 'Linked only while the migration runs, to install and upload packs.')}
          ${card(icons.database(), 'Sticker pack index', 'A list of packs already on Signal, used to avoid uploading them again. It receives only the hash and Signal pack ID of each pack that you upload.')}
        </ul>
      </section>
      <div class="mt-auto flex flex-wrap justify-end gap-3">
        <button
          type="button"
          class=${primaryButton}
          ?disabled=${!this.movingStickers}
          @click=${() => this.run(() => this.startTelegram())}
        >
          Start
        </button>
      </div>`;
  }

  private content() {
    switch (this.step) {
      case 'start':
        return this.startStep();
      case 'telegram':
        return html`<telegram-step
          class=${STEP_CLASS}
          .session=${this.telegram}
          .authState=${this.telegramState}
          @restart-telegram=${() => this.run(() => this.restartTelegram())}
          @back=${() => this.go('start')}
          @next=${() => this.run(() => this.readPacks())}
        ></telegram-step>`;
      case 'packs':
        return html`<sticker-packs-step
          class=${STEP_CLASS}
          .migration=${this.migration}
          .telegramOpen=${this.telegram !== null}
          @retry-download=${() => this.run(() => this.retryDownload())}
          @back=${() => this.go('telegram')}
          @next=${() => this.run(() => this.leavePacks())}
        ></sticker-packs-step>`;
      case 'signal':
        return html`<signal-step
          class=${STEP_CLASS}
          .services=${this.services}
          .linked=${this.signal}
          @linked=${(event: CustomEvent<LinkedDevice>) => this.run(() => this.onLinked(event.detail))}
          @back=${() => this.go('packs')}
          @next=${() => this.go('review')}
        ></signal-step>`;
      case 'review':
        return html`<sticker-review-step
          class=${STEP_CLASS}
          .migration=${this.migration}
          @back=${() => this.go('signal')}
          @start=${() => this.run(() => this.migrate())}
        ></sticker-review-step>`;
      case 'migrate':
        return html`<sticker-migrate-step
          class=${STEP_CLASS}
          .migration=${this.migration}
          @retry=${() => this.run(() => this.migrate())}
          @relink=${() => this.go('signal')}
          @finish=${() => this.run(() => this.finish())}
        ></sticker-migrate-step>`;
      case 'done':
        return html`<sticker-done-step
          class=${STEP_CLASS}
          .migration=${this.migration}
          .telegramStatus=${this.telegramConnection === 'on' ? 'Signing out…' : 'Signed out'}
          .signalStatus=${this.signal ? 'Unlinking…' : this.unlinkedAutomatically ? 'Unlinked automatically' : 'Unlinked'}
          @restart=${() => this.restart()}
        ></sticker-done-step>`;
    }
  }

  render() {
    return html`<div class="flex min-h-screen items-start justify-center bg-page px-4 py-12 font-sans text-ink">
      <div
        class="flex min-h-[720px] w-full max-w-[1120px] flex-wrap overflow-hidden rounded-2xl bg-white shadow-[0_1px_2px_rgba(20,20,30,0.06),0_8px_24px_rgba(20,20,30,0.06)]"
      >
        ${this.nav()}
        <main class="flex min-w-0 flex-[999_1_560px] flex-col gap-8 px-6 py-10 sm:px-12">
          ${this.content()} ${this.error ? html`<p class="text-danger" role="alert">${this.error}</p>` : nothing}
        </main>
      </div>
    </div>`;
  }
}
