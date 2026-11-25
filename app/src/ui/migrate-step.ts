// The migrate step: shows each chosen kind (friends, saved messages, and sticker packs) as sibling cards at the same
// nesting level so parallel progress is clear at a glance. Active progress bars animate subtly; rate-limited ones stay
// still in warm amber with an hourglass and countdown. Sticker packs nests a subcard holding its filter tabs and
// scrollable pack window; rows stay in Telegram order and follow the active pack unless the user scrolled away.

import { html, nothing, svg, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { MigrationRunStatus } from '../app/workflow';
import type { SavedWait } from '../kinds/saved/copy';
import type { PackEntry, PackState, StickerMigration } from '../kinds/stickers/migration';
import { conversionDescription, formatDuration, MigrationView } from '../kinds/stickers/ui/view';
import {
  assertNever,
  icons,
  primaryButton,
  progressBar,
  type ProgressState,
  secondaryButton,
  stepHeader,
  stickyFooter,
} from './layout';

export type MigrateFriends =
  { kind: 'looking' } | { kind: 'failed' } | { kind: 'ready'; toAdd: number; added: number | null };

export type MigrateSaved =
  { kind: 'reading' } | { kind: 'failed' } | { kind: 'ready'; toCopy: number; copied: number; wait?: SavedWait | null };

type MigrateStepView =
  | { kind: 'finished'; migration: StickerMigration | null }
  | { kind: 'ending'; migration: StickerMigration | null }
  | { kind: 'without-packs' }
  | { kind: 'reading-packs'; failed: boolean }
  | { kind: 'packs'; migration: StickerMigration };

type Filter = 'all' | 'active' | 'waiting' | 'done' | 'failed';

const WORKING: PackState[] = ['checking', 'downloading', 'comparing', 'converting', 'uploading', 'installing'];

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
  limit: html`<span
    class="flex size-6 items-center justify-center rounded-full bg-upload-soft text-upload"
    aria-hidden="true"
    >${icons.hourglass(14, '#C96A1B')}</span
  >`,
};

const DEFAULT_RUN: MigrationRunStatus = {
  ended: false,
  completed: false,
  canRetry: false,
  failed: false,
  ending: false,
  finished: false,
};

@customElement('migrate-step')
export class MigrateStep extends MigrationView {
  /** Cross-kind run status derived by the workflow (completion, retryability, ending, finished). */
  @property({ attribute: false }) run: MigrationRunStatus = DEFAULT_RUN;
  /** Whether sticker packs are among what the user chose to move. */
  @property({ attribute: false }) stickers = true;
  /** The friends chosen to be added and how many the run has added, once it has; null when friends are not chosen. */
  @property({ attribute: false }) friends: MigrateFriends | null = null;
  /** The saved messages to copy and how many of them are in Signal, or loading/failed; null if not chosen. */
  @property({ attribute: false }) saved: MigrateSaved | null = null;
  @state() private filter: Filter = 'all';
  /** Where the current pack's row is: in the list's view, or above or below it. */
  @state() private currentIs: 'in-view' | 'above' | 'below' = 'in-view';
  #ticker: ReturnType<typeof setInterval> | null = null;
  /** The pack the list last followed, and the row element watched for being in view. */
  #followed: PackEntry | null = null;
  #watched: Element | null = null;
  #hasFollowed = false;
  #observer: IntersectionObserver | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    // Rate-limit countdowns (sticker upload limit and Saved Messages) are redrawn every second while active.
    this.#ticker = setInterval(() => {
      if (this.run.failed || this.run.ended) return;
      if (this.migration?.uploadAllowedAt || (this.saved?.kind === 'ready' && this.saved.wait?.until)) {
        this.requestUpdate();
      }
    }, 1000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.#ticker) clearInterval(this.#ticker);
    this.#observer?.disconnect();
  }

  private get list(): HTMLElement | null {
    return this.querySelector('ul[aria-label="Packs"]');
  }

  private rowOf(entry: PackEntry | null): HTMLElement | null {
    return entry ? (this.list?.querySelector<HTMLElement>(`[data-rank="${entry.rank}"]`) ?? null) : null;
  }

  /** Scrolls the list so that `row` is in its middle; the list scrolls, not the page. */
  private scrollToRow(row: HTMLElement, behavior: ScrollBehavior = 'smooth'): void {
    const list = this.list!;
    list.scrollTo({ top: row.offsetTop - (list.clientHeight - row.offsetHeight) / 2, behavior });
  }

  /**
   * Follows the current pack: when the migration moves on to the next pack, the list scrolls to it if the previous
   * one was in view. A user who scrolled away is not pulled back; the button on the scrollbar brings them back.
   */
  protected updated(): void {
    const current = this.migration?.current ?? null;
    const row = this.rowOf(current);
    if (row !== this.#watched) {
      this.#watched = row;
      this.#observer?.disconnect();
      if (row) {
        this.#observer = new IntersectionObserver(
          ([seen]) => {
            const view = seen.rootBounds;
            this.currentIs = seen.isIntersecting
              ? 'in-view'
              : view && seen.boundingClientRect.top < view.top
                ? 'above'
                : 'below';
          },
          { root: this.list, threshold: 0.5 },
        );
        this.#observer.observe(row);
      } else {
        this.currentIs = 'in-view';
      }
    }
    if (current !== this.#followed) {
      const follow = this.currentIs === 'in-view';
      this.#followed = current;
      // The first time, the list opens at the current pack at once; later it moves along smoothly.
      if (row && follow) this.scrollToRow(row, this.#hasFollowed ? 'smooth' : 'instant');
      if (row) this.#hasFollowed = true;
    }
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
        const detail = migration.wasOnSignal(entry)
          ? 'Installed · was already on Signal'
          : migration.wasAlreadyInSignal(entry)
            ? 'Already in your Signal'
            : 'Uploaded and installed';
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
      case 'comparing':
        return {
          symbol: progressRing(fraction),
          detail: `Comparing with a copy on Signal${of('stickers')}`,
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
      case 'available':
        return {
          symbol: SYMBOLS.waiting,
          detail: 'Uploaded by someone else · will be verified and installed',
          tone: 'text-muted',
        };
      default:
        if (isCurrent && !this.run.failed && !this.run.ended && migration.uploadAllowedAt) {
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

  /**
   * The button at the foot of the list's scrollbar that goes to the current pack, pointing to where it is. It shows
   * only while the current pack is out of view, over the list, so that nothing moves when it appears.
   */
  private currentButton(current: PackEntry | null) {
    const hidden = !current || !this.rowOf(current) || this.currentIs === 'in-view';
    const arrow = this.currentIs === 'above' ? 'M12 19V5M5 12l7-7 7 7' : 'M12 5v14M5 12l7 7 7-7';
    return html`<button
      type="button"
      aria-hidden=${hidden}
      tabindex=${hidden ? -1 : 0}
      class="absolute right-5 bottom-3 flex cursor-pointer items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[13px] font-semibold text-accent shadow-[0_2px_12px_rgba(20,20,30,0.18)] ring-1 ring-line transition-opacity duration-150 ${
        hidden ? 'pointer-events-none opacity-0' : 'opacity-100'
      }"
      @click=${() => {
        const row = this.rowOf(current);
        if (row) this.scrollToRow(row);
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        aria-hidden="true"
      >
        ${svg`<path d=${arrow} stroke-linecap="round" stroke-linejoin="round"></path>`}
      </svg>
      Current task
    </button>`;
  }

  /** The footer's actions; the footer is always there, so that nothing moves when the migration ends. */
  private actions(failedPacks: number) {
    const run = this.run;
    const spacer = html`<span></span>`;
    if (run.finished) {
      return html`${spacer}<button type="button" class=${secondaryButton} @click=${() => this.emit('restart')}>
          Start over
        </button>`;
    }
    if (run.ending) {
      return html`${spacer}<button type="button" class=${primaryButton} disabled>Finishing…</button>`;
    }
    if (!run.ended) {
      return html`${spacer}<button type="button" class=${secondaryButton} @click=${() => this.emit('back-to-start')}>
          Back to start
        </button>`;
    }
    const back = html`<button type="button" class=${secondaryButton} @click=${() => this.emit('back-to-start')}>
      Back to start
    </button>`;
    const retry = run.canRetry
      ? html`<button type="button" class=${secondaryButton} @click=${() => this.emit('retry')}>
          ${!run.failed && failedPacks > 0 ? 'Retry failed packs' : 'Try again'}
        </button>`
      : nothing;
    return html`${back}<span class="flex gap-3"
        >${retry}<button type="button" class=${primaryButton} @click=${() => this.emit('finish')}>Finish</button></span
      >`;
  }

  /** One line under the sticker packs progress bar: throttled countdown with hourglass, active pack, or summary. */
  private statusLine(ended: boolean, failed: number, remainingUploads: number) {
    const migration = this.migration!;
    if (migration.announceError) {
      const count = migration.unannounced;
      return html`<span class="text-danger"
        >Your phone has not been told about ${count} installed pack${count === 1 ? '' : 's'} yet:
        ${migration.announceError}</span
      >`;
    }
    const waitUntil = !this.run.failed && !ended ? migration.uploadAllowedAt : null;
    if (waitUntil) {
      const left = waitUntil - Date.now();
      return html`<span class="flex items-start gap-1.5 text-upload-text">
        <span class="mt-[2px] flex-none">${icons.hourglass(14, '#8A4A0F')}</span>
        <span>
          Signal's upload limit: next upload in
          <span class="font-semibold tabular-nums">${countdown(left)}</span> · all uploaded in about
          <span class="font-semibold"
            >${formatDuration(left + Math.max(0, remainingUploads - 1) * migration.uploadIntervalMs)}</span
          >
        </span>
      </span>`;
    }
    if (ended) {
      return html`<span class="text-muted"
        >${failed > 0 ? `${failed} pack${failed === 1 ? '' : 's'} failed` : 'All selected packs are in your Signal'}</span
      >`;
    }
    if (this.run.failed) {
      return html`<span class="text-danger">Stopped · click Try again to continue from here</span>`;
    }
    const current = migration.current;
    return html`<span class="text-muted">${current ? `Working on ${current.pack.title}` : 'Working…'}</span>`;
  }

  /** What happens to the chosen friends: one sibling card at the same level as Saved Messages and Sticker packs. */
  private friendsBlock() {
    const friends = this.friends;
    if (!friends) return nothing;
    let text: string;
    switch (friends.kind) {
      case 'looking':
        text = 'Looking for your friends…';
        break;
      case 'failed':
        text = 'Could not look up your friends';
        break;
      case 'ready': {
        const count = `${friends.toAdd} friend${friends.toAdd === 1 ? '' : 's'}`;
        text =
          friends.toAdd === 0
            ? 'Nobody to add'
            : friends.added !== null
              ? `${count} added to your Signal contacts`
              : this.run.failed
                ? `${count} not added to your Signal contacts yet`
                : `Adding ${count} to your Signal contacts…`;
        break;
      }
      default:
        return assertNever(friends);
    }
    return html`<section
      aria-label="Friends"
      class="flex flex-none items-center justify-between gap-3 rounded-xl bg-white px-4 py-3.5 ring-1 ring-card-line ring-inset"
    >
      <span class="text-sm font-semibold whitespace-nowrap">Friends</span>
      <span class="text-right text-sm text-muted">${text}</span>
    </section>`;
  }

  /** What happens to the saved messages: sibling card with a working/throttled/stopped progress bar and status line. */
  private savedBlock() {
    const saved = this.saved;
    if (!saved) return nothing;
    switch (saved.kind) {
      case 'reading':
        return html`<section
          aria-label="Saved Messages"
          class="flex flex-none flex-col gap-2 rounded-xl bg-white px-4 py-3.5 ring-1 ring-card-line ring-inset"
        >
          <div class="flex items-baseline justify-between gap-3">
            <span class="text-sm font-semibold whitespace-nowrap">Saved Messages</span>
            <span class="text-right text-sm ${this.run.failed ? 'text-danger' : 'text-muted'}"
              >${this.run.failed ? 'Stopped before your Saved Messages finished reading' : 'Reading your Saved Messages…'}</span
            >
          </div>
          ${progressBar(
            'Reading Saved Messages',
            0,
            1,
            this.run.failed ? 'danger' : 'accent',
            this.run.failed ? 'failed' : 'active',
          )}
        </section>`;
      case 'failed':
        return html`<section
          aria-label="Saved Messages"
          class="flex flex-none items-center justify-between gap-3 rounded-xl bg-white px-4 py-3.5 ring-1 ring-card-line ring-inset"
        >
          <span class="text-sm font-semibold">Saved Messages</span>
          <span class="text-sm text-danger">Could not read your Saved Messages</span>
        </section>`;
      case 'ready': {
        const count = `${saved.toCopy.toLocaleString('en')} message${saved.toCopy === 1 ? '' : 's'}`;
        const done = saved.copied >= saved.toCopy;
        const text =
          saved.toCopy === 0
            ? 'Nothing to copy'
            : done
              ? `${count} copied to Note to Self`
              : `${saved.copied.toLocaleString('en')} of ${count} copied to Note to Self`;
        const wait = !done && !this.run.failed ? (saved.wait ?? null) : null;
        let barColour: 'accent' | 'upload' | 'danger' = 'accent';
        let barState: ProgressState = 'idle';
        if (!done && saved.toCopy > 0) {
          if (this.run.failed) {
            barColour = 'danger';
            barState = 'failed';
          } else if (wait) {
            barColour = 'upload';
            barState = 'throttled';
          } else if (!this.run.ended) {
            barColour = 'accent';
            barState = 'active';
          }
        }
        const status =
          saved.toCopy === 0 || done
            ? nothing
            : this.run.failed
              ? html`<span class="text-[13px] text-danger">Stopped · click Try again to continue from here</span>`
              : wait
                ? html`<span class="flex items-start gap-1.5 text-[13px] text-upload-text tabular-nums">
                    <span class="mt-[2px] flex-none">${icons.hourglass(14, '#8A4A0F')}</span>
                    <span>
                      ${
                        wait.until !== null
                          ? html`Waiting for ${wait.service}'s rate limit · next in
                              <span class="font-semibold">${countdown(wait.until - Date.now())}</span>`
                          : html`Waiting for ${wait.service}'s download rate limit…`
                      }
                    </span>
                  </span>`
                : !this.run.ended
                  ? html`<span class="text-[13px] text-muted">Copying to Note to Self…</span>`
                  : nothing;
        return html`<section
          aria-label="Saved Messages"
          class="flex flex-none flex-col gap-2 rounded-xl bg-white px-4 py-3.5 ring-1 ring-card-line ring-inset"
        >
          <div class="flex items-baseline justify-between gap-3">
            <span class="text-sm font-semibold whitespace-nowrap">Saved Messages</span>
            <span class="text-right text-sm text-muted tabular-nums">${text}</span>
          </div>
          ${saved.toCopy === 0 ? nothing : progressBar('Saved messages copied', saved.copied, saved.toCopy, barColour, barState)}
          ${status}
        </section>`;
      }
      default:
        return assertNever(saved);
    }
  }

  /** Placeholder Sticker packs card while packs are still loading from Telegram after a reload. */
  private readingPacksBlock(failed: boolean) {
    return html`<section
      aria-label="Sticker packs"
      class="flex flex-none flex-col gap-2 rounded-xl bg-white px-4 py-3.5 ring-1 ring-card-line ring-inset"
    >
      <div class="flex items-center justify-between gap-3">
        <span class="text-sm font-semibold">Sticker packs</span>
        <span class="text-sm ${failed ? 'text-danger' : 'text-muted'}"
          >${failed ? 'Stopped before your packs finished reading' : 'Reading your packs from Telegram…'}</span
        >
      </div>
      ${progressBar('Reading sticker packs', 0, 1, failed ? 'danger' : 'accent', failed ? 'failed' : 'active')}
    </section>`;
  }

  /** Sticker packs card: top progress bar matching Saved Messages, with an inset subcard for the stickers window. */
  private packsBlock(migration: StickerMigration) {
    const selected = migration.selected;
    const stickersEnded =
      migration.phase === 'done' ||
      migration.phase === 'stopped' ||
      this.run.ending ||
      this.run.finished ||
      (this.run.ended && !this.run.failed);
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
    let barColour: 'accent' | 'upload' | 'danger' = 'accent';
    let barState: ProgressState = 'idle';
    if (!this.run.failed && !stickersEnded && migration.uploadAllowedAt) {
      barColour = 'upload';
      barState = 'throttled';
    } else if (!stickersEnded && !this.run.failed) {
      barColour = 'accent';
      barState = 'active';
    } else if (this.run.failed && done < selected.length) {
      barColour = 'danger';
      barState = 'failed';
    }

    return {
      failed,
      template: html`<section
        aria-label="Sticker packs"
        class="flex min-h-[280px] flex-none flex-col rounded-xl bg-white ring-1 ring-card-line ring-inset lg:min-h-0 lg:flex-1"
      >
        <div class="flex flex-none flex-col gap-2 px-4 pt-3.5 pb-3">
          <div class="flex items-baseline justify-between gap-3">
            <span class="text-sm font-semibold whitespace-nowrap">Sticker packs</span>
            <span class="text-right text-sm text-muted tabular-nums">${done} of ${selected.length} packs</span>
          </div>
          ${progressBar('Packs in your Signal', done, selected.length, barColour, barState)}
          <div class="text-[13px]">${this.statusLine(stickersEnded, failed, remainingUploads)}</div>
          ${migration.stopReason ? html`<p class="text-[13px] text-danger" role="alert">${migration.stopReason}.</p>` : nothing}
        </div>
        <div class="mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-panel/40">
          <div
            class="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-line bg-panel/70 px-3 py-2"
          >
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
          </div>
          ${
            shown.length === 0
              ? html`<p class="flex-1 bg-white px-4 py-6 text-sm text-muted">No packs here.</p>`
              : html`<div class="relative flex min-h-[200px] flex-1 flex-col lg:min-h-0">
                  <ul
                    aria-label="Packs"
                    class="scrollbar-visible relative flex max-h-[60vh] flex-col overflow-y-auto overscroll-contain bg-white lg:max-h-none lg:min-h-0 lg:flex-1"
                  >
                    ${shown.map((entry) => this.row(entry, entry === current))}
                  </ul>
                  ${this.currentButton(current)}
                </div>`
          }
        </div>
      </section>`,
    };
  }

  private view(): MigrateStepView {
    const migration = this.stickers ? this.migration : null;
    if (this.run.finished) return { kind: 'finished', migration };
    if (this.run.ending) return { kind: 'ending', migration };
    if (!this.stickers) return { kind: 'without-packs' };
    if (!migration) return { kind: 'reading-packs', failed: this.run.failed };
    return { kind: 'packs', migration };
  }

  private renderWithPacks(migration: StickerMigration, title: string, description: string) {
    const packs = this.packsBlock(migration);
    return html`${stepHeader(this.position, title, description)}
      <div class="flex min-h-0 flex-col gap-4 lg:flex-1">
        ${this.friendsBlock()} ${this.savedBlock()} ${packs.template}
      </div>
      ${stickyFooter(this.actions(packs.failed))}`;
  }

  private runningDescription(): string {
    if (this.run.failed) {
      return 'The migration stopped before everything finished. Your progress is saved — try again when you are ready.';
    }
    if (this.run.completed) {
      return 'Some items could not be moved yet. You can retry them or finish now.';
    }
    return 'Your progress is saved in this browser. Closing this tab pauses the migration — reopen this page anytime to pick up where you left off.';
  }

  render() {
    const view = this.view();
    switch (view.kind) {
      case 'finished': {
        const title = 'Done and logged out';
        const description = 'Logged out of Telegram and Signal. Nothing is kept in your browser.';
        if (view.migration) return this.renderWithPacks(view.migration, title, description);
        return html`${stepHeader(this.position, title, description)}
          <div class="flex flex-col gap-4">${this.friendsBlock()} ${this.savedBlock()}</div>
          ${stickyFooter(this.actions(0))}`;
      }
      case 'ending': {
        const title = 'Migration finished';
        const description = 'Logging out of Telegram and Signal…';
        if (view.migration) return this.renderWithPacks(view.migration, title, description);
        return html`${stepHeader(this.position, title, description)}
          <div class="flex flex-col gap-4">${this.friendsBlock()} ${this.savedBlock()}</div>
          ${stickyFooter(this.actions(0))}`;
      }
      case 'without-packs':
        return html`${stepHeader(
            this.position,
            this.run.completed ? 'Migration finished' : 'Migrating',
            this.runningDescription(),
          )}
          <div class="flex flex-col gap-4">${this.friendsBlock()} ${this.savedBlock()}</div>
          ${stickyFooter(this.actions(0))}`;
      case 'reading-packs':
        return html`${stepHeader(
            this.position,
            'Migrating',
            view.failed
              ? 'The migration stopped before your packs finished reading. Your progress is saved — try again when you are ready.'
              : this.runningDescription(),
          )}
          <div class="flex flex-col gap-4">
            ${this.friendsBlock()} ${this.savedBlock()} ${this.readingPacksBlock(view.failed)}
          </div>
          ${stickyFooter(this.actions(0))}`;
      case 'packs':
        return this.renderWithPacks(
          view.migration,
          this.run.completed ? 'Migration finished' : 'Migrating',
          this.runningDescription(),
        );
      default:
        return assertNever(view);
    }
  }
}
