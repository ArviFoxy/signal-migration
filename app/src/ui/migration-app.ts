// The migration wizard: start, Telegram login, choosing packs, linking Signal, review, migration, done.
// Logins exist only while the page runs. At "done" the Signal device is unlinked and Telegram logged out.

import { css, html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type * as Td from 'tdlib-types';
import { StickerMigration } from '../kinds/stickers/migration';
import '../kinds/stickers/ui';
import type { SignalConnection } from '../signal/connection';
import { type TelegramApp, TelegramClient } from '../telegram/client';
import './connections-panel';
import './signal-link';
import { shared } from './styles';
import './telegram-login';

type Step = 'start' | 'telegram' | 'packs' | 'signal' | 'review' | 'migrate' | 'done';
const STEPS: { step: Step; label: string }[] = [
  { step: 'telegram', label: 'Telegram' },
  { step: 'packs', label: 'Packs' },
  { step: 'signal', label: 'Signal' },
  { step: 'review', label: 'Review' },
  { step: 'migrate', label: 'Migrate' },
  { step: 'done', label: 'Done' },
];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

@customElement('migration-app')
export class MigrationApp extends LitElement {
  static styles = [
    shared,
    css`
      :host {
        display: block;
        max-width: 720px;
        margin: 0 auto;
        padding: 24px 16px 120px;
      }
      nav ol {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 16px;
        margin: 0 0 24px;
        padding: 0;
        list-style: none;
        font-size: 13px;
        color: var(--muted);
      }
      nav li[aria-current='step'] {
        color: var(--text);
        font-weight: 600;
      }
    `,
  ];

  @state() private step: Step = 'start';
  @state() private telegram: TelegramClient | null = null;
  @state() private telegramState: Td.AuthorizationState | null = null;
  @state() private telegramName: string | null = null;
  @state() private signal: SignalConnection | null = null;
  @state() private error: string | null = null;
  @state() private migration = new StickerMigration();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('beforeunload', (event) => {
      if (this.signal || this.telegramName !== null) event.preventDefault();
    });
  }

  private fail(error: unknown): void {
    this.error = message(error);
  }

  private async startTelegram(): Promise<void> {
    this.error = null;
    this.step = 'telegram';
    const response = await fetch('/v1/config');
    const config = (await response.json()) as { telegram: TelegramApp | null };
    if (!config.telegram) throw new Error('This server has no Telegram app identity configured (TELEGRAM_API_ID and TELEGRAM_API_HASH).');
    this.telegram = await TelegramClient.start(config.telegram, (authState) => {
      this.telegramState = authState;
      if (authState._ === 'authorizationStateReady') void this.onTelegramReady().catch((error) => this.fail(error));
      if (authState._ === 'authorizationStateClosed') this.telegramName = null;
    });
  }

  private async restartTelegram(): Promise<void> {
    const old = this.telegram;
    this.telegram = null;
    this.telegramState = null;
    await old?.close();
    await this.startTelegram();
  }

  private async onTelegramReady(): Promise<void> {
    const me = await this.telegram!.invoke({ _: 'getMe' });
    this.telegramName = [me.first_name, me.last_name].filter(Boolean).join(' ');
    if (this.step !== 'telegram') return;
    this.step = 'packs';
    this.migration = new StickerMigration();
    await this.migration.readTelegram(this.telegram!);
  }

  private async onLinked(connection: SignalConnection): Promise<void> {
    this.signal = connection;
    connection.onUnlinked = () => {
      this.signal = null;
      if (this.step === 'review') this.step = 'signal';
    };
    await this.migration.readSignal(connection);
    this.step = 'review';
  }

  private async run(): Promise<void> {
    if (!this.signal) {
      this.step = 'signal';
      return;
    }
    this.step = 'migrate';
    await this.migration.run(this.telegram!, this.signal);
    if (this.migration.entries.filter((entry) => entry.selected).every((entry) => entry.state === 'in-signal')) await this.finish();
  }

  /** Unlinks the Signal device and logs out of Telegram. */
  private async finish(): Promise<void> {
    this.step = 'done';
    const errors: string[] = [];
    await this.signal?.unlink().catch((error) => errors.push(`Unlinking Signal failed: ${message(error)}`));
    await this.logOutTelegram().catch((error) => errors.push(`Logging out of Telegram failed: ${message(error)}`));
    this.error = errors.length > 0 ? errors.join(' ') : null;
  }

  private async logOutTelegram(): Promise<void> {
    const client = this.telegram;
    this.telegram = null;
    await client?.logOut();
    this.telegramName = null;
    this.telegramState = null;
  }

  private async onBadgeTelegramLogOut(): Promise<void> {
    await this.logOutTelegram();
    if (this.step !== 'done') {
      this.migration = new StickerMigration();
      await this.startTelegram();
    }
  }

  private async onBadgeSignalUnlink(): Promise<void> {
    await this.signal?.unlink();
    this.signal = null;
    if (this.step === 'review') this.step = 'signal';
  }

  private content() {
    switch (this.step) {
      case 'start':
        return html`<div class="stack">
          <h1>Telegram stickers to Signal</h1>
          <p>Copies your installed Telegram sticker packs into your Signal account, in your Telegram order.</p>
          <p class="muted">You log in to Telegram and link Signal for this visit only. Both are disconnected at the end, and nothing is stored in this browser.</p>
          <div class="row"><button @click=${() => this.startTelegram().catch((error) => this.fail(error))}>Start</button></div>
        </div>`;
      case 'telegram':
        return html`<telegram-login .client=${this.telegram} .authState=${this.telegramState} @start-over=${() => this.restartTelegram().catch((error) => this.fail(error))}></telegram-login>`;
      case 'packs':
        return html`<sticker-packs .migration=${this.migration} @continue=${() => (this.step = this.signal ? 'review' : 'signal')}></sticker-packs>`;
      case 'signal':
        return html`<signal-link @linked=${(event: CustomEvent<SignalConnection>) => this.onLinked(event.detail).catch((error) => this.fail(error))}></signal-link>`;
      case 'review':
        return html`<sticker-review .migration=${this.migration} @start=${() => this.run().catch((error) => this.fail(error))}></sticker-review>`;
      case 'migrate':
        return html`<sticker-progress
          .migration=${this.migration}
          @retry=${() => this.run().catch((error) => this.fail(error))}
          @finish=${() => this.finish()}
        ></sticker-progress>`;
      case 'done': {
        const installed = this.migration.entries.filter((entry) => entry.selected && entry.state === 'in-signal').length;
        return html`<div class="stack">
          <h1>Done</h1>
          <p>${installed} sticker pack${installed === 1 ? ' is' : 's are'} in your Signal.</p>
          <p class="muted">${this.signal ? 'Unlinking Signal…' : 'The linked Signal device is removed.'} ${this.telegram ? 'Logging out of Telegram…' : 'Telegram is logged out.'}</p>
        </div>`;
      }
    }
  }

  render() {
    const current = STEPS.findIndex((entry) => entry.step === this.step);
    return html`${this.step === 'start'
        ? nothing
        : html`<nav aria-label="Steps">
            <ol>
              ${STEPS.map((entry, i) => html`<li aria-current=${i === current ? 'step' : 'false'}>${i + 1}. ${entry.label}</li>`)}
            </ol>
          </nav>`}
      ${this.content()} ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      <connections-panel
        .telegram=${this.telegramName}
        .signalDevice=${this.signal?.deviceId ?? null}
        @telegram-log-out=${() => this.onBadgeTelegramLogOut().catch((error) => this.fail(error))}
        @signal-unlink=${() => this.onBadgeSignalUnlink().catch((error) => this.fail(error))}
      ></connections-panel>`;
  }
}
