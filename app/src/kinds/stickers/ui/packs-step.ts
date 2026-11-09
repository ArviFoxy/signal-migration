// Step 3: the user's Telegram sticker packs, laid out for 100+ packs. The list shows as soon as it is read; previews
// fill in and each pack is looked up in the sticker pack index while the user chooses. The filters stay at the top
// of the window and the actions at the bottom while the grid scrolls.

import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  icons,
  primaryButton,
  progressBar,
  secondaryButton,
  stepHeader,
  stickyBar,
  stickyFooter,
} from '../../../ui/layout';
import type { PackEntry } from '../migration';
import { MAX_STICKERS } from '../upload';
import { isOnSignal, MigrationView, packDescription } from './view';

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

/** A pack's state in a few words, with a dot in its colour. */
function packStatus(entry: PackEntry) {
  const [colour, text] =
    entry.state === 'checking'
      ? ['bg-line-strong', 'Checking…']
      : isOnSignal(entry.state)
        ? ['bg-accent', 'On Signal']
        : ['bg-upload', 'Upload needed'];
  return html`<span class="flex items-center gap-1.5 text-xs text-muted">
    <span class="size-2 flex-none rounded-full ${colour}"></span>${text}
  </span>`;
}

@customElement('sticker-packs-step')
export class StickerPacksStep extends MigrationView {
  @state() private filter: Filter = 'all';
  @state() private search = '';

  private visible(): PackEntry[] {
    const query = this.search.trim().toLowerCase();
    return this.migration.entries.filter((entry) => {
      if (this.filter === 'signal' && !isOnSignal(entry.state)) return false;
      if (this.filter === 'upload' && (isOnSignal(entry.state) || entry.state === 'checking')) return false;
      return query === '' || entry.pack.title.toLowerCase().includes(query);
    });
  }

  private select(entries: PackEntry[], selected: boolean): void {
    this.emit('select', { entries, selected });
  }

  private card(entry: PackEntry) {
    const tooLarge = entry.pack.stickers.length > MAX_STICKERS;
    const urls = previews(entry);
    return html`<li>
      <label
        class="flex h-full cursor-pointer flex-col gap-2 rounded-xl p-2.5 ring-1 ring-card-line ring-inset hover:ring-line-strong has-checked:bg-accent-soft/60 has-checked:ring-accent/40"
      >
        <span class="flex items-start justify-between gap-2">
          <span class="grid w-16 flex-none grid-cols-2 gap-0.5">
            ${[0, 1, 2, 3].map((i) =>
              urls[i]
                ? html`<img src=${urls[i]} alt="" class="aspect-square w-full rounded bg-panel object-contain" />`
                : html`<span class="block aspect-square rounded bg-segment"></span>`,
            )}
          </span>
          <span class="flex items-center gap-1 text-[11px] font-medium text-muted">
            Add
            <input
              type="checkbox"
              class="size-4 accent-accent"
              aria-label=${`Add ${entry.pack.title} to your Signal`}
              .checked=${entry.selected}
              ?disabled=${tooLarge}
              @change=${(event: Event) => this.select([entry], (event.target as HTMLInputElement).checked)}
            />
          </span>
        </span>
        <span
          class="line-clamp-2 text-[13px] leading-snug font-semibold [overflow-wrap:anywhere]"
          title=${entry.pack.title}
          >${entry.pack.title}</span
        >
        <span class="mt-auto flex flex-col gap-1">
          <span class="text-xs text-muted">${packDescription(entry)}</span>
          ${
            tooLarge
              ? html`<span class="text-xs text-danger">Over ${MAX_STICKERS} stickers</span>`
              : entry.error
                ? html`<span class="text-xs text-danger">${entry.error}</span>`
                : packStatus(entry)
          }
        </span>
      </label>
    </li>`;
  }

  render() {
    const { entries, readProgress } = this.migration;
    const reading = entries.length === 0;
    const checking = entries.filter((entry) => entry.state === 'checking').length;
    const onSignal = entries.filter((entry) => isOnSignal(entry.state)).length;
    const selected = entries.filter((entry) => entry.selected).length;
    const toUpload = entries.filter(
      (entry) => entry.selected && entry.state !== 'checking' && !isOnSignal(entry.state),
    ).length;
    const tabs: { id: Filter; label: string }[] = [
      { id: 'all', label: `All · ${entries.length}` },
      { id: 'signal', label: `On Signal · ${onSignal}` },
      { id: 'upload', label: `Upload needed · ${entries.length - onSignal - checking}` },
    ];
    const visible = this.visible();
    const allVisibleSelected =
      visible.length > 0 && visible.every((entry) => entry.selected || entry.pack.stickers.length > MAX_STICKERS);
    if (reading) {
      return html`${stepHeader(3, 'Sticker packs', 'Reading your packs from Telegram…')}
      ${
        readProgress
          ? html`<div class="flex flex-col gap-2">
              <div class="flex justify-between text-sm">
                <span>Read</span><span class="text-muted">${readProgress.done} of ${readProgress.total} packs</span>
              </div>
              ${progressBar('Packs read', readProgress.done, readProgress.total)}
            </div>`
          : nothing
      }
      ${stickyFooter(html`<button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>`)}`;
    }
    return html`${stepHeader(3, 'Sticker packs', 'Choose the packs to add to your Signal.')}
    ${stickyBar(
      html`<div class="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="Filter packs" class="inline-flex flex-wrap gap-1 rounded-[10px] bg-segment p-1">
            ${tabs.map(
              (tab) =>
                html`<button
                  type="button"
                  aria-pressed=${tab.id === this.filter}
                  class="min-h-8 cursor-pointer rounded-lg px-3 text-[13px] font-medium ${
                    tab.id === this.filter ? 'bg-white text-ink shadow-[0_1px_2px_rgba(20,20,30,0.12)]' : 'text-muted'
                  }"
                  @click=${() => (this.filter = tab.id)}
                >
                  ${tab.label}
                </button>`,
            )}
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <label
              class="inline-flex min-h-9 items-center gap-2 rounded-[10px] px-3 ring-1 ring-line-strong ring-inset"
            >
              ${icons.search()}
              <span class="sr-only">Search packs</span>
              <input
                type="search"
                placeholder="Search"
                class="w-32 bg-transparent text-sm outline-none sm:w-44"
                .value=${this.search}
                @input=${(event: Event) => (this.search = (event.target as HTMLInputElement).value)}
              />
            </label>
            <label class="inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                class="size-4 accent-accent"
                .checked=${allVisibleSelected}
                @change=${(event: Event) => this.select(visible, (event.target as HTMLInputElement).checked)}
              />Add all${this.filter !== 'all' || this.search ? ' shown' : ''}
            </label>
          </div>
        </div>
        ${
          checking > 0
            ? html`<p class="text-xs text-muted">
                Checking which packs are already on Signal: ${entries.length - checking} of ${entries.length}
              </p>`
            : nothing
        }`,
    )}
    ${
      visible.length === 0
        ? html`<p class="text-sm text-muted">No pack matches.</p>`
        : html`<ul class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
            ${visible.map((entry) => this.card(entry))}
          </ul>`
    }
    ${stickyFooter(
      html`<span class="text-sm text-muted">
          <strong class="font-semibold text-ink">${selected}</strong> of ${entries.length} packs to
          add${
            toUpload > 0
              ? html`, <strong class="font-semibold text-ink">${toUpload}</strong> of them to upload`
              : nothing
          }
        </span>
        <span class="flex gap-3">
          <button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>
          <button type="button" class=${primaryButton} ?disabled=${selected === 0} @click=${() => this.emit('next')}>
            Continue
          </button>
        </span>`,
    )}`;
  }
}
