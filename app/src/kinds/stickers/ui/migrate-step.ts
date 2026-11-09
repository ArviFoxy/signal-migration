// Step 6: the migration running: installs, the upload queue, and the wait for Signal's upload limit.

import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { icons, primaryButton, progressBar, secondaryButton, stepHeader } from '../../../ui/layout';
import type { PackEntry } from '../migration';
import { conversionDescription, formatDuration, MigrationView } from './view';

const CHIP = 'rounded-full px-2.5 py-1 text-xs font-semibold';
const TONES = {
  done: 'bg-accent-chip text-accent-chip-text',
  active: 'bg-upload-chip text-upload-text',
  waiting: 'bg-segment text-muted',
  failed: 'bg-[#FBE4E1] text-danger',
};

function status(entry: PackEntry, next: boolean): { label: string; tone: keyof typeof TONES } {
  const progress = entry.progress ? ` ${entry.progress.done}/${entry.progress.total}` : '';
  switch (entry.state) {
    case 'in-signal':
      return { label: 'Installed', tone: 'done' };
    case 'converting':
      return { label: `Converting${progress}`, tone: 'active' };
    case 'uploading':
      return { label: `Uploading${progress}`, tone: 'active' };
    case 'installing':
      return { label: 'Installing', tone: 'active' };
    case 'checking':
      return { label: 'Checking the index', tone: 'active' };
    case 'claimed-elsewhere':
      return { label: 'Someone else is uploading it', tone: 'waiting' };
    case 'failed':
      return { label: 'Failed', tone: 'failed' };
    default:
      return { label: next ? 'Next' : 'Waiting', tone: 'waiting' };
  }
}

@customElement('sticker-migrate-step')
export class StickerMigrateStep extends MigrationView {
  render() {
    const migration = this.migration;
    const installs = migration.installProgress;
    const uploads = migration.uploadProgress;
    const queue = migration.uploadQueue;
    const remaining = queue.filter((entry) => entry.state !== 'in-signal' && entry.state !== 'failed').length;
    const nextIndex = queue.findIndex((entry) => entry.state === 'to-upload');
    const failed = migration.selected.filter((entry) => entry.state === 'failed').length;
    const finished = migration.phase === 'done' || migration.phase === 'stopped';
    const waitUntil = migration.uploadAllowedAt;
    const now = Date.now();
    return html`${stepHeader(6, finished ? 'Migration finished' : 'Migrating', 'Keep this page open until the uploads finish. If it closes, the next visit continues where this one stopped.')}
      ${
        installs.total > 0
          ? html`<section aria-labelledby="installing" class="flex flex-col gap-2">
              <div class="flex flex-wrap justify-between gap-3">
                <h2 id="installing" class="inline-flex items-center gap-2 text-base font-semibold">
                  ${installs.done === installs.total ? html`<span class="text-accent">${icons.check(18)}</span>` : nothing}Installed
                </h2>
                <span class="text-sm text-muted">${installs.done} of ${installs.total} packs</span>
              </div>
              ${progressBar('Installed packs', installs.done, installs.total)}
            </section>`
          : nothing
      }
      ${
        uploads.total > 0
          ? html`<section aria-labelledby="uploading" class="flex flex-col gap-2">
              <div class="flex flex-wrap justify-between gap-3">
                <h2 id="uploading" class="text-base font-semibold">Uploading</h2>
                <span class="text-sm text-muted">${uploads.done} of ${uploads.total} packs</span>
              </div>
              ${progressBar('Uploaded packs', uploads.done, uploads.total, 'upload')}
              ${
                waitUntil
                  ? html`<div class="flex flex-wrap gap-6 text-sm">
                      <span><span class="text-muted">Next upload</span> in ${formatDuration(waitUntil - now)}</span>
                      <span
                        ><span class="text-muted">Last upload</span> in about
                        ${formatDuration(waitUntil - now + Math.max(0, remaining - 1) * migration.uploadIntervalMs)}</span
                      >
                    </div>`
                  : nothing
              }
              <p class="text-sm text-muted">
                Each uploaded pack's hash and Signal pack ID are added to the pack index. Signal is unlinked
                automatically after the last upload.
              </p>
            </section>`
          : nothing
      }
      ${migration.stopReason ? html`<p class="text-danger" role="alert">${migration.stopReason}.</p>` : nothing}
      ${
        queue.length > 0
          ? html`<ul
              aria-label="Upload queue"
              class="flex flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset"
            >
              ${queue.map((entry, i) => {
                const { label, tone } = status(entry, i === nextIndex);
                const conversion = conversionDescription(entry.conversion);
                return html`<li
                  class="flex flex-wrap items-center justify-between gap-2 border-b border-[#F0F0EC] px-[18px] py-3 last:border-b-0"
                >
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-[15px] font-medium [overflow-wrap:anywhere]">${entry.pack.title}</span>
                    ${conversion ? html`<span class="text-[13px] text-muted">${conversion}</span>` : nothing}
                    ${entry.error ? html`<span class="text-[13px] text-danger">${entry.error}</span>` : nothing}
                  </span>
                  <span class="${CHIP} ${TONES[tone]}">${label}</span>
                </li>`;
              })}
            </ul>`
          : nothing
      }
      <div class="mt-auto flex flex-wrap justify-between gap-3">
        ${
          finished
            ? html`${
                  migration.phase === 'stopped'
                    ? html`<button type="button" class=${secondaryButton} @click=${() => this.emit('relink')}>
                        Link Signal again
                      </button>`
                    : failed > 0
                      ? html`<button type="button" class=${secondaryButton} @click=${() => this.emit('retry')}>
                          Retry failed packs
                        </button>`
                      : html`<span></span>`
                } <button type="button" class=${primaryButton} @click=${() => this.emit('finish')}>Finish</button>`
            : html`<button
                type="button"
                class=${secondaryButton}
                @click=${() => (migration.paused ? migration.resume() : migration.pause())}
              >
                ${migration.paused ? 'Resume uploads' : 'Pause uploads'}
              </button>`
        }
      </div>`;
  }
}
