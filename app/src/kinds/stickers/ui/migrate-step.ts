// Step 6: the migration running, laid out for 100+ packs. The progress, the wait for Signal's upload limit and
// Pause stay at the top of the window; the pack in progress comes first in the queue, and the queue can be filtered.

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
import type { PackEntry, PackState } from '../migration';
import { conversionDescription, formatDuration, MigrationView } from './view';

type Filter = 'all' | 'active' | 'waiting' | 'done' | 'failed';

const CHIP = 'flex-none rounded-full px-2.5 py-0.5 text-xs font-semibold';
const TONES = {
  done: 'bg-accent-chip text-accent-chip-text',
  active: 'bg-upload-chip text-upload-text',
  waiting: 'bg-segment text-muted',
  failed: 'bg-[#FBE4E1] text-danger',
};

const ACTIVE: PackState[] = ['checking', 'downloading', 'converting', 'uploading', 'installing'];

function group(entry: PackEntry): Exclude<Filter, 'all'> {
  if (entry.state === 'in-signal') return 'done';
  if (entry.state === 'failed') return 'failed';
  if (ACTIVE.includes(entry.state)) return 'active';
  return 'waiting';
}

function status(entry: PackEntry, next: boolean): { label: string; tone: keyof typeof TONES } {
  const progress = entry.progress ? ` ${entry.progress.done}/${entry.progress.total}` : '';
  switch (entry.state) {
    case 'in-signal':
      return { label: 'Installed', tone: 'done' };
    case 'checking':
      return { label: 'Checking the index', tone: 'active' };
    case 'downloading':
      return { label: `Downloading${progress}`, tone: 'active' };
    case 'converting':
      return { label: `Converting${progress}`, tone: 'active' };
    case 'uploading':
      return { label: `Uploading${progress}`, tone: 'active' };
    case 'installing':
      return { label: 'Installing', tone: 'active' };
    case 'claimed-elsewhere':
      return { label: 'Someone else is uploading it', tone: 'waiting' };
    case 'failed':
      return { label: 'Failed', tone: 'failed' };
    default:
      return { label: next ? 'Next' : entry.prepared ? 'Ready' : 'Waiting', tone: 'waiting' };
  }
}

@customElement('sticker-migrate-step')
export class StickerMigrateStep extends MigrationView {
  @state() private filter: Filter = 'all';

  private row(entry: PackEntry, next: boolean) {
    const { label, tone } = status(entry, next);
    const conversion = conversionDescription(entry.conversion);
    return html`<li
      class="flex items-center justify-between gap-3 border-b border-[#F0F0EC] px-4 py-2.5 last:border-b-0"
    >
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="truncate text-sm font-medium">${entry.pack.title}</span>
        ${conversion ? html`<span class="truncate text-xs text-muted">${conversion}</span>` : nothing}
        ${entry.error ? html`<span class="text-xs text-danger">${entry.error}</span>` : nothing}
      </span>
      <span class="${CHIP} ${TONES[tone]}">${label}</span>
    </li>`;
  }

  render() {
    const migration = this.migration;
    const installs = migration.installProgress;
    const uploads = migration.uploadProgress;
    const finished = migration.phase === 'done' || migration.phase === 'stopped';
    const failed = migration.selected.filter((entry) => entry.state === 'failed').length;
    const waitUntil = migration.uploadAllowedAt;
    const now = Date.now();

    // The queue: packs in progress first, then the rest in upload order.
    const queue = migration.uploadQueue;
    const ordered = [
      ...queue.filter((entry) => group(entry) === 'active'),
      ...queue.filter((entry) => group(entry) !== 'active'),
    ];
    const nextEntry = queue.find((entry) => entry.state === 'to-upload');
    const counts = { all: queue.length, active: 0, waiting: 0, done: 0, failed: 0 };
    for (const entry of queue) counts[group(entry)]++;
    const shown = this.filter === 'all' ? ordered : ordered.filter((entry) => group(entry) === this.filter);
    const remaining = counts.active + counts.waiting;
    const tabs: { id: Filter; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'active', label: 'In progress' },
      { id: 'waiting', label: 'Waiting' },
      { id: 'done', label: 'Installed' },
      { id: 'failed', label: 'Failed' },
    ];

    return html`${stepHeader(6, finished ? 'Migration finished' : 'Migrating', 'Keep this page open until the uploads finish. After a reload it continues where it stopped.')}
    ${stickyBar(
      html`<div class="grid gap-4 sm:grid-cols-2">
          ${
            installs.total > 0
              ? html`<div class="flex flex-col gap-1.5">
                  <div class="flex justify-between gap-3 text-sm">
                    <span class="inline-flex items-center gap-1.5 font-semibold">
                      ${installs.done === installs.total ? html`<span class="text-accent">${icons.check(16)}</span>` : nothing}Installed
                      from earlier uploads
                    </span>
                    <span class="text-muted">${installs.done} of ${installs.total}</span>
                  </div>
                  ${progressBar('Packs installed from earlier uploads', installs.done, installs.total)}
                </div>`
              : nothing
          }
          ${
            uploads.total > 0
              ? html`<div class="flex flex-col gap-1.5">
                  <div class="flex justify-between gap-3 text-sm">
                    <span class="font-semibold">Uploaded and installed</span>
                    <span class="text-muted">${uploads.done} of ${uploads.total}</span>
                  </div>
                  ${progressBar('Packs uploaded and installed', uploads.done, uploads.total, 'upload')}
                </div>`
              : nothing
          }
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="text-sm">
            ${
              waitUntil
                ? html`<span class="text-muted">Signal's upload limit: next upload in</span>
                    ${formatDuration(waitUntil - now)}<span class="text-muted"> · last in about</span>
                    ${formatDuration(waitUntil - now + Math.max(0, remaining - 1) * migration.uploadIntervalMs)}`
                : finished
                  ? html`<span class="text-muted"
                      >${failed > 0 ? `${failed} pack${failed === 1 ? '' : 's'} failed` : 'All packs are in your Signal'}</span
                    >`
                  : html`<span class="text-muted">${migration.paused ? 'Paused' : 'Running'}</span>`
            }
          </span>
          ${
            finished
              ? nothing
              : html`<button
                  type="button"
                  class="${secondaryButton} min-h-9 px-4 text-sm"
                  @click=${() => (migration.paused ? migration.resume() : migration.pause())}
                >
                  ${migration.paused ? 'Resume' : 'Pause'}
                </button>`
          }
        </div>`,
    )}
    ${migration.stopReason ? html`<p class="text-danger" role="alert">${migration.stopReason}.</p>` : nothing}
    ${
      queue.length > 0
        ? html`<section aria-label="Upload queue" class="flex flex-col gap-3">
            <div
              role="group"
              aria-label="Filter the queue"
              class="inline-flex flex-wrap gap-1 self-start rounded-[10px] bg-segment p-1"
            >
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
                    ${tab.label} · ${counts[tab.id]}
                  </button>`,
              )}
            </div>
            ${
              shown.length === 0
                ? html`<p class="text-sm text-muted">No packs here.</p>`
                : html`<ul class="flex flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset">
                    ${shown.map((entry) => this.row(entry, entry === nextEntry))}
                  </ul>`
            }
          </section>`
        : nothing
    }
    ${
      finished
        ? stickyFooter(
            html`${
                migration.phase === 'stopped'
                  ? html`<button type="button" class=${secondaryButton} @click=${() => this.emit('relink')}>
                      Link Signal again
                    </button>`
                  : failed > 0
                    ? html`<button type="button" class=${secondaryButton} @click=${() => this.emit('retry')}>
                        Retry failed packs
                      </button>`
                    : html`<span></span>`
              } <button type="button" class=${primaryButton} @click=${() => this.emit('finish')}>Finish</button>`,
          )
        : nothing
    }`;
  }
}
