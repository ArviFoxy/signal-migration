// Step 6: the migration, laid out after Apple's list conventions. Every selected pack is in one list, in the user's
// Telegram order, and rows never move. Each row starts with a status symbol (a check when installed, a progress ring
// while working, a clock while waiting for Signal's upload limit, an empty circle before its turn) and has one line
// saying what is happening. The list keeps the pack being worked on in view, unless the user has just scrolled;
// "Jump to the current pack" brings it back. The overall progress stays at the top, the actions at the bottom.

import { html, nothing, svg, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  icons,
  primaryButton,
  progressBar,
  secondaryButton,
  stepHeader,
  stickyBar,
  stickyFooter,
} from '../../../ui/layout';
import type { PackEntry, PackState } from '../migration';
import { conversionDescription, formatDuration, MigrationView } from './view';

type Filter = 'all' | 'active' | 'waiting' | 'done' | 'failed';

const WORKING: PackState[] = ['checking', 'downloading', 'converting', 'uploading', 'installing'];
/** How long the list stops following the current pack after the user scrolls it. */
const USER_SCROLL_PAUSE_MS = 8000;

function group(entry: PackEntry): Exclude<Filter, 'all'> {
  if (entry.state === 'in-signal') return 'done';
  if (entry.state === 'failed') return 'failed';
  if (WORKING.includes(entry.state)) return 'active';
  return 'waiting';
}

/** "0:42" under an hour, "1 h 12 min" above. */
function countdown(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds >= 3600) return formatDuration(ms);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A ring that fills with `fraction`, or turns when the fraction is unknown. */
function progressRing(fraction: number | null): TemplateResult {
  const circumference = 2 * Math.PI * 9;
  return html`<svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    aria-hidden="true"
    class=${fraction === null ? 'animate-spin' : ''}
  >
    ${svg`<circle cx="12" cy="12" r="9" fill="none" stroke="#ECECE8" stroke-width="3"></circle>
      <circle cx="12" cy="12" r="9" fill="none" stroke="#C96A1B" stroke-width="3" stroke-linecap="round"
        stroke-dasharray=${`${(fraction ?? 0.3) * circumference} ${circumference}`} transform="rotate(-90 12 12)"></circle>`}
  </svg>`;
}

const SYMBOLS = {
  done: html`<span class="flex size-6 items-center justify-center rounded-full bg-accent text-white"
    >${icons.check(13)}</span
  >`,
  failed: html`<span class="flex size-6 items-center justify-center rounded-full bg-danger text-sm font-bold text-white"
    >!</span
  >`,
  waiting: html`<span class="block size-6 rounded-full ring-[1.5px] ring-line-strong ring-inset"></span>`,
  limit: html`<svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#C96A1B"
    stroke-width="2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    ${svg`<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>`}
  </svg>`,
};

@customElement('sticker-migrate-step')
export class StickerMigrateStep extends MigrationView {
  /** The workflow finished: Signal unlinked, Telegram signed out, nothing kept. The screen stays as it was. */
  @property({ attribute: false }) finished = false;
  /** Unlinking Signal and signing out of Telegram, before `finished`. */
  @property({ attribute: false }) ending = false;
  @state() private filter: Filter = 'all';
  @state() private currentOutOfView = false;
  #ticker: ReturnType<typeof setInterval> | null = null;
  #userScrolledAt = 0;
  #followed: PackEntry | null = null;
  #observer: IntersectionObserver | null = null;
  #noteUserScroll = () => (this.#userScrolledAt = Date.now());

  connectedCallback(): void {
    super.connectedCallback();
    // The countdown to the next upload is redrawn every second.
    this.#ticker = setInterval(() => {
      if (this.migration?.uploadAllowedAt) this.requestUpdate();
    }, 1000);
    for (const event of ['wheel', 'touchmove', 'keydown'])
      window.addEventListener(event, this.#noteUserScroll, { passive: true });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.#ticker) clearInterval(this.#ticker);
    for (const event of ['wheel', 'touchmove', 'keydown']) window.removeEventListener(event, this.#noteUserScroll);
    this.#observer?.disconnect();
  }

  /** The row of the current pack, followed when it changes unless the user scrolled recently. */
  protected updated(): void {
    if (!this.migration) return;
    const current = this.migration.current;
    const row = current ? this.querySelector<HTMLElement>(`[data-rank="${current.rank}"]`) : null;
    if (current !== this.#followed) {
      this.#followed = current;
      this.#observer?.disconnect();
      if (row) {
        this.#observer = new IntersectionObserver(([seen]) => (this.currentOutOfView = !seen.isIntersecting), {
          threshold: 0.5,
        });
        this.#observer.observe(row);
        if (Date.now() - this.#userScrolledAt > USER_SCROLL_PAUSE_MS)
          row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else {
        this.currentOutOfView = false;
      }
    }
  }

  private jumpToCurrent(): void {
    const current = this.migration?.current;
    if (current)
      this.querySelector(`[data-rank="${current.rank}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.#userScrolledAt = 0;
  }

  /** The status symbol and the line saying what is happening to a pack. */
  private describe(entry: PackEntry, isCurrent: boolean): { symbol: TemplateResult; detail: string; tone: string } {
    const migration = this.migration!;
    const progress = entry.progress;
    const of = (noun: string) => (progress ? ` · ${progress.done} of ${progress.total} ${noun}` : '');
    const fraction = progress && progress.total > 0 ? progress.done / progress.total : null;
    switch (entry.state) {
      case 'in-signal': {
        const conversion = conversionDescription(entry.conversion);
        const detail = migration.wasOnSignal(entry) ? 'Installed · was already on Signal' : 'Uploaded and installed';
        return { symbol: SYMBOLS.done, detail: conversion ? `${detail} · ${conversion}` : detail, tone: 'text-muted' };
      }
      case 'failed':
        return { symbol: SYMBOLS.failed, detail: entry.error ?? 'Failed', tone: 'text-danger' };
      case 'checking':
        return {
          symbol: progressRing(null),
          detail: 'Checking whether someone uploaded it meanwhile',
          tone: 'text-upload-text',
        };
      case 'downloading':
        return {
          symbol: progressRing(fraction),
          detail: `Downloading from Telegram${of('stickers')}`,
          tone: 'text-upload-text',
        };
      case 'converting':
        return {
          symbol: progressRing(fraction),
          detail: `Converting for Signal${of('stickers')}`,
          tone: 'text-upload-text',
        };
      case 'uploading':
        return {
          symbol: progressRing(fraction),
          detail: `Uploading to Signal${of('files')}`,
          tone: 'text-upload-text',
        };
      case 'installing':
        return { symbol: progressRing(null), detail: 'Adding to your sticker list', tone: 'text-upload-text' };
      case 'claimed-elsewhere':
        return {
          symbol: SYMBOLS.limit,
          detail: 'Someone else is uploading it · checking again soon',
          tone: 'text-muted',
        };
      case 'available':
        return { symbol: SYMBOLS.waiting, detail: 'Already on Signal · will be installed', tone: 'text-muted' };
      default:
        if (isCurrent && migration.uploadAllowedAt) {
          return {
            symbol: SYMBOLS.limit,
            detail: `Waiting for Signal's upload limit · ${countdown(migration.uploadAllowedAt - Date.now())}`,
            tone: 'text-upload-text',
          };
        }
        return { symbol: SYMBOLS.waiting, detail: entry.prepared ? 'Ready to upload' : 'Waiting', tone: 'text-muted' };
    }
  }

  private row(entry: PackEntry, isCurrent: boolean) {
    const { symbol, detail, tone } = this.describe(entry, isCurrent);
    return html`<li
      data-rank=${entry.rank}
      class="flex min-h-14 items-center gap-3 border-b border-[#F0F0EC] px-4 py-2 last:border-b-0 ${isCurrent ? 'bg-upload-soft/60' : ''}"
    >
      <span class="flex size-6 flex-none items-center justify-center">${symbol}</span>
      <span class="flex min-w-0 flex-col">
        <span class="truncate text-[15px] ${isCurrent ? 'font-semibold' : 'font-medium'}">${entry.pack.title}</span>
        <span class="truncate text-[13px] ${tone}" title=${detail}>${detail}</span>
      </span>
    </li>`;
  }

  /** The footer's actions; the footer is always there, so that nothing moves when the migration ends. */
  private actions(ended: boolean, failed: number) {
    const migration = this.migration!;
    const jump =
      this.currentOutOfView && migration.current
        ? html`<button
            type="button"
            class="cursor-pointer text-sm font-medium text-accent hover:underline"
            @click=${() => this.jumpToCurrent()}
          >
            Jump to the current pack
          </button>`
        : html`<span></span>`;
    if (this.finished) {
      return html`${jump}<button type="button" class=${secondaryButton} @click=${() => this.emit('restart')}>
          Start over
        </button>`;
    }
    if (this.ending) {
      return html`${jump}<button type="button" class=${primaryButton} disabled>Finishing…</button>`;
    }
    if (!ended) {
      return html`${jump}<button
          type="button"
          class=${secondaryButton}
          @click=${() => (migration.paused ? migration.resume() : migration.pause())}
        >
          ${migration.paused ? 'Resume uploads' : 'Pause uploads'}
        </button>`;
    }
    const retry =
      failed > 0
        ? html`<button type="button" class=${secondaryButton} @click=${() => this.emit('retry')}>
            Retry failed packs
          </button>`
        : nothing;
    return html`${jump}<span class="flex gap-3"
        >${retry}<button type="button" class=${primaryButton} @click=${() => this.emit('finish')}>Finish</button></span
      >`;
  }

  /** One line under the overall progress: the wait for Signal's limit, what is happening, or how it ended. */
  private statusLine(ended: boolean, failed: number, remainingUploads: number) {
    const migration = this.migration!;
    const waitUntil = migration.uploadAllowedAt;
    if (waitUntil) {
      const left = waitUntil - Date.now();
      return html`<span class="text-muted">Signal's upload limit: next upload in</span>
        <span class="font-medium tabular-nums">${countdown(left)}</span>
        <span class="text-muted">· all uploaded in about</span>
        <span class="font-medium"
          >${formatDuration(left + Math.max(0, remainingUploads - 1) * migration.uploadIntervalMs)}</span
        >`;
    }
    if (ended) {
      return html`<span class="text-muted"
        >${failed > 0 ? `${failed} pack${failed === 1 ? '' : 's'} failed` : 'All selected packs are in your Signal'}</span
      >`;
    }
    const current = migration.current;
    return html`<span class="text-muted"
      >${migration.paused ? 'Paused' : current ? `Working on ${current.pack.title}` : 'Working'}</span
    >`;
  }

  render() {
    const migration = this.migration;
    if (!migration)
      return this.finished
        ? stepHeader(7, 'Done and logged out', 'Logged out of Telegram and Signal. Nothing is kept in your browser.')
        : stepHeader(6, 'Migrating', 'Reading your packs from Telegram…');
    const selected = migration.selected;
    const ended = migration.phase === 'done' || migration.phase === 'stopped';
    const done = selected.filter((entry) => entry.state === 'in-signal').length;
    const failed = selected.filter((entry) => entry.state === 'failed').length;
    const remainingUploads = migration.uploadQueue.filter(
      (entry) => entry.state !== 'in-signal' && entry.state !== 'failed',
    ).length;
    const current = migration.current;
    const counts = { all: selected.length, active: 0, waiting: 0, done: 0, failed: 0 };
    for (const entry of selected) counts[group(entry)]++;
    const shown = this.filter === 'all' ? selected : selected.filter((entry) => group(entry) === this.filter);
    const tabs: { id: Filter; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'active', label: 'In progress' },
      { id: 'waiting', label: 'Waiting' },
      { id: 'done', label: 'Installed' },
      { id: 'failed', label: 'Failed' },
    ];
    const description = this.finished
      ? 'Logged out of Telegram and Signal. Nothing is kept in your browser.'
      : this.ending
        ? 'Logging out of Telegram and Signal…'
        : 'Keep this tab open until the uploads finish. After a reload, it continues where it stopped.';
    const title = this.finished ? 'Done and logged out' : ended || this.ending ? 'Migration finished' : 'Migrating';

    return html`${stepHeader(this.finished ? 7 : 6, title, description)}
    ${stickyBar(
      html`<div class="flex flex-col gap-1.5">
          <div class="flex justify-between gap-3 text-sm">
            <span class="font-semibold">In your Signal</span>
            <span class="text-muted tabular-nums">${done} of ${selected.length} packs</span>
          </div>
          ${progressBar('Packs in your Signal', done, selected.length)}
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="text-sm">${this.statusLine(ended, failed, remainingUploads)}</span>
          <div
            role="group"
            aria-label="Filter the list"
            class="inline-flex flex-wrap gap-1 rounded-[10px] bg-segment p-1"
          >
            ${tabs.map(
              (tab) =>
                html`<button
                  type="button"
                  aria-pressed=${tab.id === this.filter}
                  class="min-h-7 cursor-pointer rounded-lg px-2.5 text-[13px] font-medium ${
                    tab.id === this.filter ? 'bg-white text-ink shadow-[0_1px_2px_rgba(20,20,30,0.12)]' : 'text-muted'
                  }"
                  @click=${() => (this.filter = tab.id)}
                >
                  ${tab.label} · ${counts[tab.id]}
                </button>`,
            )}
          </div>
        </div>`,
    )}
    ${migration.stopReason ? html`<p class="text-danger" role="alert">${migration.stopReason}.</p>` : nothing}
    ${
      shown.length === 0
        ? html`<p class="text-sm text-muted">No packs here.</p>`
        : html`<ul aria-label="Packs" class="flex flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset">
            ${shown.map((entry) => this.row(entry, entry === current))}
          </ul>`
    }
    ${stickyFooter(this.actions(ended, failed))}`;
  }
}
