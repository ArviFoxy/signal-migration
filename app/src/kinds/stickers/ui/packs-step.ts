// Step 3: the user's Telegram sticker packs. Reads them, looks each up in the sticker pack index, downloads previews
// and the files of packs to upload, and lets the user choose which packs to move.

import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { icons, primaryButton, progressBar, secondaryButton, stepHeader } from '../../../ui/layout';
import { MAX_STICKERS } from '../upload';
import type { PackEntry } from '../migration';
import { isOnSignal, MigrationView, packDescription, stateChip } from './view';

type Filter = 'all' | 'signal' | 'upload';

/** Object URLs of each pack's preview images, made once per pack. */
const previewUrls = new WeakMap<PackEntry, string[]>();
function previews(entry: PackEntry): string[] {
  let urls = previewUrls.get(entry);
  if (!urls && entry.thumbnails.length > 0) {
    urls = entry.thumbnails.map((thumbnail) =>
      URL.createObjectURL(new Blob([thumbnail.data as Uint8Array<ArrayBuffer>], { type: thumbnail.mimeType })),
    );
    previewUrls.set(entry, urls);
  }
  return urls ?? [];
}

@customElement('sticker-packs-step')
export class StickerPacksStep extends MigrationView {
  /** Whether the Telegram session is still open, so that failed downloads can be retried. */
  @property({ attribute: false }) telegramOpen = false;
  @state() private filter: Filter = 'all';
  @state() private search = '';

  private visible(): PackEntry[] {
    const query = this.search.trim().toLowerCase();
    return this.migration.entries.filter((entry) => {
      if (this.filter === 'signal' && !isOnSignal(entry.state)) return false;
      if (this.filter === 'upload' && isOnSignal(entry.state)) return false;
      return query === '' || entry.pack.title.toLowerCase().includes(query);
    });
  }

  private selectAll(selected: boolean): void {
    for (const entry of this.visible()) this.migration.setSelected(entry, selected);
  }

  private card(entry: PackEntry) {
    const tooLarge = entry.pack.stickers.length > MAX_STICKERS;
    const urls = previews(entry);
    return html`<li>
      <label class="flex h-full cursor-pointer flex-col gap-2.5 rounded-xl p-3.5 ring-1 ring-card-line ring-inset">
        <span class="flex items-start justify-between">
          <span class="grid w-[72px] grid-cols-2 gap-1">
            ${[0, 1, 2, 3].map((i) =>
              urls[i]
                ? html`<img src=${urls[i]} alt="" class="aspect-square w-full rounded-md bg-panel object-contain" />`
                : html`<span class="block aspect-square rounded-md bg-segment"></span>`,
            )}
          </span>
          <input
            type="checkbox"
            class="size-[18px] accent-accent"
            aria-label=${`Move ${entry.pack.title}`}
            .checked=${entry.selected}
            ?disabled=${tooLarge}
            @change=${(event: Event) => this.migration.setSelected(entry, (event.target as HTMLInputElement).checked)}
          />
        </span>
        <span class="text-[15px] font-semibold [overflow-wrap:anywhere]">${entry.pack.title}</span>
        <span class="text-[13px] text-muted">${packDescription(entry)}</span>
        ${tooLarge ? html`<span class="text-xs text-danger">Signal packs hold at most ${MAX_STICKERS} stickers</span>` : stateChip(entry.state)}
        ${entry.error ? html`<span class="text-xs text-danger">${entry.error}</span>` : nothing}
      </label>
    </li>`;
  }

  render() {
    const { entries, readProgress, downloadProgress } = this.migration;
    const reading = entries.length === 0;
    const checking = entries.some((entry) => entry.state === 'checking');
    const downloading = downloadProgress !== null && downloadProgress.done < downloadProgress.total;
    const failed = entries.filter((entry) => entry.state === 'failed').length;
    const onSignal = entries.filter((entry) => isOnSignal(entry.state)).length;
    const selected = entries.filter((entry) => entry.selected).length;
    const tabs: { id: Filter; label: string }[] = [
      { id: 'all', label: `All · ${entries.length}` },
      { id: 'signal', label: `On Signal · ${onSignal}` },
      { id: 'upload', label: `To upload · ${entries.length - onSignal}` },
    ];
    const visible = this.visible();
    return html`${stepHeader(3, 'Sticker packs', reading ? 'Reading your packs from Telegram…' : `${entries.length} packs found in Telegram.`)}
      ${
        reading
          ? readProgress
            ? html`<div class="flex flex-col gap-2">
                <div class="flex justify-between text-sm">
                  <span>Read</span><span class="text-muted">${readProgress.done} of ${readProgress.total} packs</span>
                </div>
                ${progressBar('Packs read', readProgress.done, readProgress.total)}
              </div>`
            : nothing
          : html`<div class="flex flex-col gap-2">
              <div class="flex justify-between text-sm">
                <span>Downloaded</span
                ><span class="text-muted"
                  >${downloadProgress ? `${downloadProgress.done} of ${downloadProgress.total} packs` : 'Waiting'}</span
                >
              </div>
              ${progressBar('Packs downloaded', downloadProgress?.done ?? 0, downloadProgress?.total ?? 1)}
              ${
                failed > 0 && !downloading && this.telegramOpen
                  ? html`<div class="flex flex-wrap items-center gap-3">
                      <span class="text-sm text-danger"
                        >${failed} pack${failed === 1 ? '' : 's'} could not be downloaded.</span
                      >
                      <button type="button" class=${secondaryButton} @click=${() => this.emit('retry-download')}>
                        Retry
                      </button>
                    </div>`
                  : nothing
              }
            </div>`
      }
      <div class="flex items-start gap-3.5 rounded-xl bg-panel px-[18px] py-3.5 ring-1 ring-line ring-inset">
        ${icons.database()}
        <div class="flex flex-col gap-1 text-sm">
          <span class="font-semibold">Sticker pack index</span>
          <span
            >The list of packs already on Signal was downloaded and matched on this computer. Nothing about your packs
            was sent.</span
          >
          <span class="text-muted"
            >After each upload, the pack's hash and Signal pack ID are added to the list, so that others can install the
            pack instead of uploading it again.</span
          >
        </div>
      </div>
      ${
        reading
          ? nothing
          : html`<div class="flex flex-wrap items-center justify-between gap-3">
                <div
                  role="group"
                  aria-label="Filter packs"
                  class="inline-flex flex-wrap gap-1 rounded-[10px] bg-segment p-1"
                >
                  ${tabs.map(
                    (tab) =>
                      html`<button
                        type="button"
                        aria-pressed=${tab.id === this.filter}
                        class="min-h-9 cursor-pointer rounded-lg px-3.5 text-sm font-medium ${tab.id === this.filter ? 'bg-white text-ink shadow-[0_1px_2px_rgba(20,20,30,0.12)]' : 'text-muted'}"
                        @click=${() => (this.filter = tab.id)}
                      >
                        ${tab.label}
                      </button>`,
                  )}
                </div>
                <div class="flex flex-wrap items-center gap-4">
                  <label class="inline-flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      class="size-[18px] accent-accent"
                      .checked=${visible.length > 0 && visible.every((entry) => entry.selected || entry.pack.stickers.length > MAX_STICKERS)}
                      @change=${(event: Event) => this.selectAll((event.target as HTMLInputElement).checked)}
                    />Select all
                  </label>
                  <label
                    class="inline-flex min-h-10 items-center gap-2 rounded-[10px] px-3 ring-1 ring-line-strong ring-inset"
                  >
                    ${icons.search()}
                    <span class="sr-only">Search packs</span>
                    <input
                      type="search"
                      placeholder="Search"
                      class="w-36 bg-transparent text-sm outline-none"
                      .value=${this.search}
                      @input=${(event: Event) => (this.search = (event.target as HTMLInputElement).value)}
                    />
                  </label>
                </div>
              </div>
              <ul class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3.5">
                ${visible.map((entry) => this.card(entry))}
              </ul>`
      }
      <div class="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-2">
        <span class="text-sm text-muted">${selected} of ${entries.length} selected</span>
        <div class="flex gap-3">
          <button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>
          <button
            type="button"
            class=${primaryButton}
            ?disabled=${reading || checking || downloading || selected === 0}
            @click=${() => this.emit('next')}
          >
            Continue
          </button>
        </div>
      </div>`;
  }
}
