// Step 3: the user's Telegram sticker packs. Shows the list as soon as it is read, with previews filling in, while
// each pack is looked up in the sticker pack index. After Continue, downloads the chosen packs that are not on
// Signal yet.

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
  /** Choosing packs, or downloading the chosen ones after Continue. */
  @property({ attribute: false }) stage: 'choose' | 'download' = 'choose';
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
          <span class="flex items-center gap-1.5 text-xs font-medium text-muted">
            Add to Signal
            <input
              type="checkbox"
              class="size-[18px] accent-accent"
              aria-label=${`Add ${entry.pack.title} to your Signal`}
              .checked=${entry.selected}
              ?disabled=${tooLarge}
              @change=${(event: Event) => this.migration.setSelected(entry, (event.target as HTMLInputElement).checked)}
            />
          </span>
        </span>
        <span class="text-[15px] font-semibold [overflow-wrap:anywhere]">${entry.pack.title}</span>
        <span class="text-[13px] text-muted">${packDescription(entry)}</span>
        ${tooLarge ? html`<span class="text-xs text-danger">Signal packs hold at most ${MAX_STICKERS} stickers</span>` : stateChip(entry.state)}
        ${entry.error ? html`<span class="text-xs text-danger">${entry.error}</span>` : nothing}
      </label>
    </li>`;
  }

  /** The download after Continue: progress over all stickers, and each pack's state. */
  private downloadView() {
    const progress = this.migration.downloadProgress;
    const packs = this.migration.selected.filter(
      (entry) => entry.downloaded || entry.state === 'failed' || entry.progress,
    );
    const finished = progress !== null && progress.packsDone === progress.packsTotal;
    const failed = packs.filter((entry) => entry.state === 'failed').length;
    const chip = (entry: PackEntry) =>
      entry.state === 'failed'
        ? html`<span class="rounded-full bg-[#FBE4E1] px-2.5 py-1 text-xs font-semibold text-danger">Failed</span>`
        : entry.downloaded
          ? html`<span class="rounded-full bg-accent-chip px-2.5 py-1 text-xs font-semibold text-accent-chip-text"
              >Downloaded</span
            >`
          : entry.progress
            ? html`<span class="rounded-full bg-upload-chip px-2.5 py-1 text-xs font-semibold text-upload-text"
                >Downloading ${entry.progress.done}/${entry.progress.total}</span
              >`
            : html`<span class="rounded-full bg-segment px-2.5 py-1 text-xs font-semibold text-muted">Waiting</span>`;
    const waiting = this.migration.toDownload.filter((entry) => !packs.includes(entry));
    return html`${stepHeader(3, 'Sticker packs', 'Downloading the chosen packs that are not on Signal yet from Telegram.')}
      <section aria-labelledby="download-heading" class="flex flex-col gap-2">
        <div class="flex flex-wrap justify-between gap-3">
          <h2 id="download-heading" class="text-base font-semibold">
            ${progress === null ? 'Checking which packs are already on Signal…' : finished ? 'Downloaded' : `Downloading ${progress.current ?? ''}`}
          </h2>
          ${
            progress
              ? html`<span class="text-sm text-muted"
                  >${progress.stickersDone} of ${progress.stickersTotal} stickers · pack
                  ${Math.min(progress.packsDone + 1, progress.packsTotal)} of ${progress.packsTotal}</span
                >`
              : nothing
          }
        </div>
        ${progressBar('Stickers downloaded', progress?.stickersDone ?? 0, progress?.stickersTotal || 1, 'upload')}
      </section>
      <ul
        aria-label="Packs to download"
        class="flex flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset"
      >
        ${[...packs, ...waiting].map(
          (entry) =>
            html`<li
              class="flex flex-wrap items-center justify-between gap-2 border-b border-[#F0F0EC] px-[18px] py-3 last:border-b-0"
            >
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="text-[15px] font-medium [overflow-wrap:anywhere]">${entry.pack.title}</span>
                ${entry.error ? html`<span class="text-[13px] text-danger">${entry.error}</span>` : nothing}
              </span>
              ${chip(entry)}
            </li>`,
        )}
      </ul>
      <div class="mt-auto flex flex-wrap justify-end gap-3">
        ${
          finished && failed > 0
            ? html`<button type="button" class=${secondaryButton} @click=${() => this.emit('skip-failed')}>
                  Continue without them
                </button>
                <button type="button" class=${primaryButton} @click=${() => this.emit('retry-download')}>Retry</button>`
            : finished
              ? html`<button type="button" class=${primaryButton} @click=${() => this.emit('skip-failed')}>
                  Continue
                </button>`
              : nothing
        }
      </div>`;
  }

  render() {
    if (this.stage === 'download') return this.downloadView();
    const { entries, readProgress } = this.migration;
    const reading = entries.length === 0;
    const onSignal = entries.filter((entry) => isOnSignal(entry.state)).length;
    const checked = entries.filter((entry) => entry.state !== 'checking').length;
    const selected = entries.filter((entry) => entry.selected).length;
    const toUpload = entries.filter(
      (entry) => entry.selected && entry.state !== 'checking' && !isOnSignal(entry.state),
    ).length;
    const tabs: { id: Filter; label: string }[] = [
      { id: 'all', label: `All · ${entries.length}` },
      { id: 'signal', label: `On Signal · ${onSignal}` },
      { id: 'upload', label: `Not on Signal · ${checked - onSignal}` },
    ];
    const visible = this.visible();
    return html`${stepHeader(3, 'Sticker packs', reading ? 'Reading your packs from Telegram…' : `${entries.length} packs found in Telegram. Choose the ones to add to Signal.`)}
      ${
        reading && readProgress
          ? html`<div class="flex flex-col gap-2">
              <div class="flex justify-between text-sm">
                <span>Read</span><span class="text-muted">${readProgress.done} of ${readProgress.total} packs</span>
              </div>
              ${progressBar('Packs read', readProgress.done, readProgress.total)}
            </div>`
          : nothing
      }
      <div class="flex items-start gap-3.5 rounded-xl bg-panel px-[18px] py-3.5 ring-1 ring-line ring-inset">
        ${icons.database()}
        <div class="flex flex-col gap-1 text-sm">
          <span class="font-semibold">Sticker pack index</span>
          <span
            >The list of packs already on Signal is downloaded and matched on this computer. Nothing about your packs is
            sent.</span
          >
          <span class="text-muted">
            After each upload, the pack's hash and Signal pack ID are added to the list, so that others can install the
            pack instead of uploading it again.
          </span>
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
                    />Add all
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
        <span class="text-sm text-muted"
          >${selected} of ${entries.length} packs to add to your
          Signal${toUpload > 0 ? `, ${toUpload} of them to upload` : ''}</span
        >
        <div class="flex gap-3">
          <button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>
          <button
            type="button"
            class=${primaryButton}
            ?disabled=${reading || selected === 0}
            @click=${() => this.emit('next')}
          >
            Continue
          </button>
        </div>
      </div>`;
  }
}
