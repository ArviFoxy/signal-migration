// The saved messages step: how many messages Telegram's Saved Messages hold, and from which date on they are copied
// into Signal's Note to Self.
//
// What is copied is everything from a date on, because Signal's apps list a conversation in the order in which its
// messages arrived (kinds/saved/copy.ts). No date is chosen at first, so nothing is copied until the user chooses.

import { html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { SavedState } from '../../../app/workflow';
import {
  LightElement,
  primaryButton,
  progressBar,
  secondaryButton,
  stepHeader,
  type StepPosition,
  stickyFooter,
} from '../../../ui/layout';
import type { LeftOut } from '../copy';

// One screen in every state: the same title and description, with the progress of the reading where the choice will be.
const TITLE = 'Saved Messages';
const DESCRIPTION = 'Select which messages to copy to Note to Self in Signal.';
const messages = (count: number) => `${count.toLocaleString('en')} message${count === 1 ? '' : 's'}`;

/** A date as the value of a date field, in the user's time zone: 2024-03-09. */
function fieldValue(seconds: number): string {
  const date = new Date(seconds * 1000);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The start of the day of a date field's value, in the user's time zone, in seconds since 1970. */
function startOfDay(value: string): number | null {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  return Math.floor(new Date(year, month - 1, day).getTime() / 1000);
}

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric' });

@customElement('saved-step')
export class SavedStep extends LightElement {
  @property({ attribute: false }) saved: SavedState = { kind: 'none' };
  /** The date from which messages are copied (seconds since 1970); null while none is chosen. */
  @property({ attribute: false }) from: number | null = null;
  /** For the chosen date: how many messages are copied and how many are left out. */
  @property({ attribute: false }) copy: { toCopy: number; leftOut: LeftOut } | null = null;
  @property({ attribute: false }) position: StepPosition | null = null;

  private footer(next: unknown) {
    return stickyFooter(
      html`<button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>${next}`,
    );
  }

  private reading(read: number) {
    const label = 'Reading your Saved Messages';
    return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
      <div class="flex flex-col gap-1.5">
        <div class="flex justify-between gap-3 text-sm">
          <span class="font-semibold">${label}</span>
          <span class="flex-none whitespace-nowrap text-muted tabular-nums">${messages(read)} read</span>
        </div>
        <div class="animate-pulse">${progressBar(label, 1, 1)}</div>
      </div>
      ${this.footer(html`<button type="button" class=${primaryButton} disabled>Continue</button>`)}`;
  }

  render() {
    const saved = this.saved;
    if (saved.kind === 'none') return this.reading(0);
    if (saved.kind === 'reading') return this.reading(saved.read);
    if (saved.kind === 'failed') {
      return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
      ${this.footer(
        html`<button type="button" class=${primaryButton} @click=${() => this.emit('try-again')}>Try again</button>`,
      )}`;
    }

    const all = saved.messages;
    const next = (count: number) =>
      html`<span class="flex items-center gap-4">
        <span class="text-sm text-muted">${count === 0 ? 'Nothing to copy' : `${messages(count)} to copy`}</span>
        <button type="button" class=${primaryButton} @click=${() => this.emit('next')}>Continue</button>
      </span>`;
    if (all.length === 0) {
      return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
        <p class="text-sm text-muted">Your Saved Messages are empty.</p>
        ${this.footer(next(0))}`;
    }

    const first = all[0].date;
    const last = all[all.length - 1].date;
    const from = this.from;
    const copy = this.copy;
    const leftOut: [number, string][] = copy
      ? [
          [copy.leftOut.media, 'with a photo, a video or a file: not copied yet'],
          [copy.leftOut.tooLong, 'too long for one Signal message: not copied yet'],
          [copy.leftOut.other, 'of other kinds: not copied'],
        ]
      : [];
    return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
      <p class="text-[15px]">Your Saved Messages hold ${messages(all.length)}, from ${day(first)} to ${day(last)}.</p>
      <div class="flex flex-wrap items-center gap-3">
        <label class="flex items-center gap-3 text-[15px] font-semibold">
          Copy the messages from
          <input
            type="date"
            class="min-h-11 rounded-[10px] bg-white px-3 text-[15px] font-normal ring-1 ring-line-strong ring-inset"
            min=${fieldValue(first)}
            max=${fieldValue(last)}
            .value=${from === null ? '' : fieldValue(from)}
            @change=${(event: Event) =>
              this.emit('copy-from', { from: startOfDay((event.target as HTMLInputElement).value) })}
          />
        </label>
        <button
          type="button"
          class=${secondaryButton}
          @click=${() => this.emit('copy-from', { from: startOfDay(fieldValue(first)) })}
        >
          From the first message
        </button>
      </div>
      ${
        from === null || !copy
          ? nothing
          : html`<ul
              aria-label="What is copied"
              class="flex shrink-0 flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset"
            >
              <li class="flex justify-between gap-3 border-b border-[#F0F0EC] px-4 py-2.5 last:border-b-0">
                <span class="text-sm font-medium">Text messages to copy</span>
                <span class="flex-none text-sm tabular-nums">${copy.toCopy.toLocaleString('en')}</span>
              </li>
              ${leftOut
                .filter(([count]) => count > 0)
                .map(
                  ([count, why]) =>
                    html`<li class="flex justify-between gap-3 border-b border-[#F0F0EC] px-4 py-2.5 last:border-b-0">
                      <span class="text-sm text-muted">Messages ${why}</span>
                      <span class="flex-none text-sm text-muted tabular-nums">${count.toLocaleString('en')}</span>
                    </li>`,
                )}
            </ul>`
      }
      <p class="text-sm text-muted">
        The messages are added to Note to Self after the messages that are already there. Each keeps its date.
      </p>
      ${this.footer(next(copy?.toCopy ?? 0))}`;
  }
}
