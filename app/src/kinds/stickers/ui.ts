// The sticker pack steps of the wizard: choosing packs, reviewing what will happen, and the migration's progress.
// Each element shows a StickerMigration and re-renders when it changes.

import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { shared } from '../../ui/styles';
import { MAX_STICKERS } from './upload';
import type { PackEntry, PackState, StickerMigration } from './migration';

const STATE_LABELS: Record<PackState, string> = {
  checking: 'Checking…',
  'in-signal': 'In your Signal',
  available: 'Already uploaded',
  'to-upload': 'Needs uploading',
  'claimed-elsewhere': 'Someone is uploading it',
  downloading: 'Downloading from Telegram',
  uploading: 'Uploading to Signal',
  installing: 'Installing',
  failed: 'Failed',
};

const listStyles = css`
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  li {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 4px 12px;
    padding: 10px 0;
    border-top: 1px solid var(--border);
  }
  li .title {
    overflow-wrap: anywhere;
  }
  li .state {
    font-size: 13px;
    color: var(--muted);
    text-align: right;
  }
  li .state.done {
    color: var(--ok-text);
  }
  li .state.failed {
    color: var(--error);
  }
  li .wide {
    grid-column: 2 / 4;
    font-size: 13px;
  }
  input[type='checkbox'] {
    width: 20px;
    height: 20px;
    min-height: 0;
    accent-color: var(--accent);
  }
  .rank {
    min-width: 2ch;
    color: var(--muted);
    font-size: 13px;
    text-align: right;
  }
`;

/** Base class: holds the migration and re-renders on its changes. */
class MigrationView extends LitElement {
  @property({ attribute: false }) migration!: StickerMigration;
  #onChange = () => this.requestUpdate();

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('migration')) {
      (changed.get('migration') as StickerMigration | undefined)?.removeEventListener('change', this.#onChange);
      this.migration?.addEventListener('change', this.#onChange);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.migration?.removeEventListener('change', this.#onChange);
  }

  protected emit(name: string): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }
}

const stickerCount = (entry: PackEntry) => `${entry.pack.stickers.length} sticker${entry.pack.stickers.length === 1 ? '' : 's'}`;

@customElement('sticker-packs')
export class StickerPacks extends MigrationView {
  static styles = [shared, listStyles];

  private selectAll(selected: boolean): void {
    for (const entry of this.migration.entries) if (entry.pack.stickers.length <= MAX_STICKERS) this.migration.setSelected(entry, selected);
  }

  render() {
    const { entries, readProgress } = this.migration;
    if (entries.length === 0) {
      return html`<div class="stack">
        <h2>Your Telegram sticker packs</h2>
        ${readProgress ? html`<p class="muted">Reading packs: ${readProgress.done} of ${readProgress.total}</p><progress max=${readProgress.total} value=${readProgress.done}></progress>` : html`<p class="muted">Reading packs…</p>`}
      </div>`;
    }
    const selected = entries.filter((entry) => entry.selected).length;
    const checking = entries.some((entry) => entry.state === 'checking');
    return html`<div class="stack">
      <h2>Your Telegram sticker packs</h2>
      <p class="muted">${entries.length} packs, in your Telegram order. ${selected} selected.</p>
      <div class="row">
        <button class="secondary small" @click=${() => this.selectAll(true)}>Select all</button>
        <button class="secondary small" @click=${() => this.selectAll(false)}>Select none</button>
      </div>
      <ul>
        ${entries.map(
          (entry) => html`<li>
            <input
              type="checkbox"
              aria-label=${`Migrate ${entry.pack.title}`}
              .checked=${entry.selected}
              ?disabled=${entry.pack.stickers.length > MAX_STICKERS}
              @change=${(event: Event) => this.migration.setSelected(entry, (event.target as HTMLInputElement).checked)}
            />
            <span class="title">${entry.pack.title} <span class="muted">· ${stickerCount(entry)}</span></span>
            <span class="state">${entry.pack.stickers.length > MAX_STICKERS ? `Over ${MAX_STICKERS} stickers` : STATE_LABELS[entry.state]}</span>
          </li>`,
        )}
      </ul>
      <div class="row"><button ?disabled=${selected === 0 || checking} @click=${() => this.emit('continue')}>Continue</button></div>
    </div>`;
  }
}

@customElement('sticker-review')
export class StickerReview extends MigrationView {
  static styles = shared;

  render() {
    const selected = this.migration.entries.filter((entry) => entry.selected);
    const count = (state: PackState) => selected.filter((entry) => entry.state === state).length;
    const inSignal = count('in-signal');
    const install = count('available');
    const upload = selected.length - inSignal - install;
    return html`<div class="stack">
      <h2>Review</h2>
      <div class="card stack">
        <p><strong>${inSignal}</strong> already in your Signal</p>
        <p><strong>${install}</strong> to install, already uploaded by someone</p>
        <p><strong>${upload}</strong> to upload to Signal, then install</p>
      </div>
      <p class="muted">New packs go into your Signal sticker list in your Telegram order. Packs already in Signal keep their place.</p>
      <div class="row"><button ?disabled=${install + upload === 0} @click=${() => this.emit('start')}>Start</button></div>
    </div>`;
  }
}

@customElement('sticker-progress')
export class StickerProgress extends MigrationView {
  static styles = [shared, listStyles];

  render() {
    const { phase, uploadAllowedAt } = this.migration;
    const selected = this.migration.entries.filter((entry) => entry.selected);
    const done = selected.filter((entry) => entry.state === 'in-signal').length;
    const failed = selected.filter((entry) => entry.state === 'failed');
    return html`<div class="stack">
      <h2>${phase === 'done' ? 'Migration finished' : 'Migrating'}</h2>
      <p class="muted">${done} of ${selected.length} packs in your Signal${failed.length > 0 ? `, ${failed.length} failed` : ''}.</p>
      <progress max=${selected.length} value=${done}></progress>
      ${uploadAllowedAt
        ? html`<p>Signal limits how many sticker packs an account can upload. The next upload starts at ${new Date(uploadAllowedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; keep this page open.</p>`
        : nothing}
      ${phase === 'done'
        ? html`<div class="row">
            ${failed.length > 0 ? html`<button class="secondary" @click=${() => this.emit('retry')}>Retry failed packs</button>` : nothing}
            <button @click=${() => this.emit('finish')}>Finish</button>
          </div>`
        : nothing}
      <ul>
        ${selected.map(
          (entry) => html`<li>
            <span class="rank">${entry.rank + 1}</span>
            <span class="title">${entry.pack.title}</span>
            <span class="state ${entry.state === 'in-signal' ? 'done' : entry.state === 'failed' ? 'failed' : ''}"
              >${STATE_LABELS[entry.state]}${entry.progress && entry.state !== 'in-signal' ? ` ${entry.progress.done}/${entry.progress.total}` : ''}</span
            >
            ${entry.error ? html`<span class="wide error">${entry.error}</span>` : nothing}
          </li>`,
        )}
      </ul>
    </div>`;
  }
}
