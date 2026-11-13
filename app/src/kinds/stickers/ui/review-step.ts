// Step 5: what the migration will do: install packs already on Signal, upload the rest, and the wait that Signal's
// upload limit adds. Long lists start collapsed, for 100+ packs.

import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { primaryButton, secondaryButton, stepHeader, stickyFooter } from '../../../ui/layout';
import { estimatedUploadWaitMs, UPLOAD_BURST, UPLOAD_INTERVAL_MS } from '../migration';
import { formatDuration, MigrationView } from './view';

const COLLAPSED_ROWS = 6;

@customElement('sticker-review-step')
export class StickerReviewStep extends MigrationView {
  /** The packs are read from Telegram, the index and Signal. */
  @property({ attribute: false }) ready = false;
  @state() private showAll = false;

  render() {
    if (!this.migration) return stepHeader(5, 'Review', 'Reading your packs…');
    const selected = this.migration.selected;
    const inSignal = selected.filter((entry) => entry.state === 'in-signal').length;
    const install = selected.filter((entry) => entry.state === 'available').length;
    const toUpload = selected.filter((entry) => entry.state !== 'in-signal' && entry.state !== 'available');
    const wait = estimatedUploadWaitMs(toUpload.length);
    const animated = toUpload
      .map((entry) => ({
        title: entry.pack.title,
        count: entry.pack.stickers.filter((sticker) => sticker.format !== 'webp').length,
      }))
      .filter((pack) => pack.count > 0);
    const shown = this.showAll ? animated : animated.slice(0, COLLAPSED_ROWS);
    const card = (tone: string, label: string, value: string, detail: string) =>
      html`<li class="flex flex-col gap-1.5 rounded-xl p-5 ${tone}">
        <span class="text-sm font-semibold">${label}</span>
        <span class="font-display text-4xl font-semibold">${value}</span>
        <span class="text-sm text-muted">${detail}</span>
      </li>`;
    return html`${stepHeader(
        5,
        'Review',
        `${selected.length} sticker pack${selected.length === 1 ? '' : 's'} selected${inSignal > 0 ? `, ${inSignal} already in your Signal` : ''}.`,
      )}
      <ul class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        ${card('bg-accent-soft [&>span:first-child]:text-accent', 'Verify and install', String(install), 'packs already on Signal')}
        ${card('bg-upload-soft [&>span:first-child]:text-upload-text', 'Upload', String(toUpload.length), 'packs new to Signal')}
        ${card(
          'bg-panel ring-1 ring-line ring-inset [&>span:first-child]:text-muted',
          'Waiting for Signal',
          wait === 0 ? 'None' : `≈ ${formatDuration(wait)}`,
          `${UPLOAD_BURST} uploads at once, then 1 per ${UPLOAD_INTERVAL_MS / 60_000} min`,
        )}
      </ul>
      <p class="text-sm text-muted">
        New packs go into your Signal sticker list in your Telegram order. Packs already in Signal keep their place.
        Keep this tab open while it uploads. After a reload, it continues where it stopped.
      </p>
      ${
        animated.length > 0
          ? html`<section aria-labelledby="converted" class="flex flex-col gap-3">
              <h2 id="converted" class="text-base font-semibold">
                Converted to animated PNG for Signal · ${animated.length} pack${animated.length === 1 ? '' : 's'}
              </h2>
              <ul class="flex shrink-0 flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset">
                ${shown.map(
                  (pack) =>
                    html`<li class="flex justify-between gap-3 border-b border-[#F0F0EC] px-4 py-2.5 last:border-b-0">
                      <span class="min-w-0 truncate text-sm font-medium">${pack.title}</span>
                      <span class="flex-none text-sm text-muted">${pack.count} animated</span>
                    </li>`,
                )}
              </ul>
              ${
                animated.length > COLLAPSED_ROWS
                  ? html`<button
                      type="button"
                      class="cursor-pointer self-start text-sm font-medium text-accent hover:underline"
                      @click=${() => (this.showAll = !this.showAll)}
                    >
                      ${this.showAll ? 'Show fewer' : `Show all ${animated.length}`}
                    </button>`
                  : nothing
              }
            </section>`
          : nothing
      }
      ${stickyFooter(
        html`<button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>
          <button
            type="button"
            class=${primaryButton}
            ?disabled=${!this.ready || install + toUpload.length === 0}
            @click=${() => this.emit('start')}
          >
            Start migration
          </button>`,
      )}`;
  }
}
