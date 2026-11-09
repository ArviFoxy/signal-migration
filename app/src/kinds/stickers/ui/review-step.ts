// Step 5: what the migration will do: install packs already on Signal, upload the rest, and the wait that Signal's
// upload limit adds.

import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { primaryButton, secondaryButton, stepHeader } from '../../../ui/layout';
import { estimatedUploadWaitMs, UPLOAD_BURST, UPLOAD_INTERVAL_MS } from '../migration';
import { formatDuration, MigrationView } from './view';

@customElement('sticker-review-step')
export class StickerReviewStep extends MigrationView {
  render() {
    const selected = this.migration.selected;
    const inSignal = selected.filter((entry) => entry.state === 'in-signal').length;
    const install = selected.filter((entry) => entry.state === 'available').length;
    const upload = selected.length - inSignal - install;
    const wait = estimatedUploadWaitMs(upload);
    const animated = selected
      .filter((entry) => entry.state !== 'in-signal' && entry.state !== 'available')
      .map((entry) => ({
        title: entry.pack.title,
        count: entry.pack.stickers.filter((sticker) => sticker.format !== 'webp').length,
      }))
      .filter((pack) => pack.count > 0);
    const card = (tone: string, label: string, value: string, detail: string) =>
      html`<li class="flex flex-col gap-1.5 rounded-xl p-5 ${tone}">
        <span class="text-sm font-semibold">${label}</span>
        <span class="font-display text-4xl font-semibold">${value}</span>
        <span class="text-sm text-muted">${detail}</span>
      </li>`;
    return html`${stepHeader(5, 'Review', `${selected.length} sticker pack${selected.length === 1 ? '' : 's'} selected${inSignal > 0 ? `, ${inSignal} already in your Signal` : ''}.`)}
      <ul class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        ${card('bg-accent-soft [&>span:first-child]:text-accent', 'Install now', String(install), 'packs already on Signal')}
        ${card('bg-upload-soft [&>span:first-child]:text-upload-text', 'Upload', String(upload), 'packs new to Signal')}
        ${card(
          'bg-panel ring-1 ring-line ring-inset [&>span:first-child]:text-muted',
          'Waiting for Signal',
          wait === 0 ? 'None' : `≈ ${formatDuration(wait)}`,
          `${UPLOAD_BURST} uploads at once, then 1 per ${UPLOAD_INTERVAL_MS / 60_000} min`,
        )}
      </ul>
      ${
        animated.length > 0
          ? html`<section aria-labelledby="converted" class="flex flex-col gap-3">
              <h2 id="converted" class="text-base font-semibold">Converted to animated PNG for Signal</h2>
              <ul class="flex flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset">
                ${animated.map(
                  (pack) =>
                    html`<li
                      class="flex flex-wrap justify-between gap-2 border-b border-[#F0F0EC] px-[18px] py-3.5 last:border-b-0"
                    >
                      <span class="text-[15px] font-semibold">${pack.title}</span>
                      <span class="text-sm text-muted"
                        >${pack.count} animated sticker${pack.count === 1 ? '' : 's'}</span
                      >
                    </li>`,
                )}
              </ul>
            </section>`
          : nothing
      }
      <div class="mt-auto flex flex-wrap justify-between gap-3">
        <button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>
        <button
          type="button"
          class=${primaryButton}
          ?disabled=${install + upload === 0}
          @click=${() => this.emit('start')}
        >
          Start migration
        </button>
      </div>`;
  }
}
