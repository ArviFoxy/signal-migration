// The saved messages step: a timeline histogram of Telegram's Saved Messages with an individual-day cutoff slider
// for choosing which messages are copied into Signal's Note to Self.
//
// What is copied is everything from a day on, because Signal's apps list a conversation in arrival order
// (kinds/saved/copy.ts). The cutoff starts at all messages (from === null).

import { html, nothing, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
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
import { type LeftOut, leftOutFrom, mediaSummaryFrom, messagesToCopy } from '../copy';
import type { SavedMessage } from '../messages';
import {
  axisTicks,
  buildTimeline,
  dayOffsetForFrom,
  formatDay,
  fromForDayOffset,
  localDayAt,
  presetsFor,
  type Timeline,
  UNIT_LABEL,
} from '../timeline';

// One screen in every state: the same title and description, with the progress of the reading where the timeline will be.
const TITLE = 'Saved Messages';
const DESCRIPTION = 'Select which messages to copy to Note to Self in Signal.';
const messages = (count: number) => `${count.toLocaleString('en')} message${count === 1 ? '' : 's'}`;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const CHART_HEIGHT = 136;
const PAD_X = 8;
const TOP_Y = 28;
const BASE_Y = 102;
const BAR_AREA = BASE_Y - TOP_Y;

let nextClipId = 0;

@customElement('saved-step')
export class SavedStep extends LightElement {
  @property({ attribute: false }) saved: SavedState = { kind: 'none' };
  /** The cutoff timestamp (seconds since 1970); null copies all messages. */
  @property({ attribute: false }) from: number | null = null;
  /** For the committed cutoff: how many messages are copied, how many carry media, and how many are left out. */
  @property({ attribute: false }) copy: {
    toCopy: number;
    withMedia: number;
    mediaBytes: number;
    leftOut: LeftOut;
  } | null = null;
  @property({ attribute: false }) position: StepPosition | null = null;

  /** Uncommitted day offset while the user is dragging the handle, so dragging does not spam storage writes. */
  @state() private draftDay: number | null = null;
  /** Measured width of the timeline stage in CSS pixels. */
  @state() private stageWidth = 640;

  readonly #clipPrefix = `saved-tl-${++nextClipId}`;
  #cachedMessages: readonly SavedMessage[] | null = null;
  #cachedTimeline: Timeline | null = null;
  #dragging = false;
  #observer: ResizeObserver | null = null;
  #observedStage: Element | null = null;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#observer?.disconnect();
    this.#observer = null;
    this.#observedStage = null;
  }

  protected updated(): void {
    const stage = this.querySelector('[data-timeline-stage]');
    if (stage === this.#observedStage) return;
    this.#observer?.disconnect();
    this.#observedStage = stage;
    if (!stage) return;
    const width = Math.round(stage.getBoundingClientRect().width);
    if (width > 0 && Math.abs(width - this.stageWidth) >= 2) this.stageWidth = width;
    if (typeof ResizeObserver === 'undefined') return;
    this.#observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0 && Math.abs(next - this.stageWidth) >= 2) this.stageWidth = next;
    });
    this.#observer.observe(stage);
  }

  private timelineOf(all: readonly SavedMessage[]): Timeline {
    if (this.#cachedMessages !== all || !this.#cachedTimeline) {
      this.#cachedMessages = all;
      this.#cachedTimeline = buildTimeline(all);
    }
    return this.#cachedTimeline;
  }

  private dayFromPointer(timeline: Timeline, stage: Element, clientX: number): number {
    const rect = stage.getBoundingClientRect();
    const plotW = Math.max(1, rect.width - 2 * PAD_X);
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left - PAD_X) / plotW));
    return Math.round(fraction * timeline.spanDays);
  }

  private commitDay(timeline: Timeline, dayOffset: number): void {
    const clamped = Math.min(timeline.spanDays, Math.max(0, dayOffset));
    this.draftDay = null;
    this.emit('copy-from', { from: fromForDayOffset(timeline, clamped) });
  }

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

  private renderTimeline(timeline: Timeline, dayOffset: number, selectedTotal: number) {
    const width = Math.max(260, this.stageWidth);
    const plotW = width - 2 * PAD_X;
    const xOf = (offset: number) => PAD_X + (offset / timeline.spanDays) * plotW;
    const cutoffX = xOf(dayOffset);
    const isAll = dayOffset <= 0;
    const isNone = dayOffset >= timeline.spanDays;
    const cutoffText = isNone ? 'None' : formatDay(localDayAt(timeline, dayOffset));
    const presets = presetsFor(timeline);
    const ticks = axisTicks(timeline, plotW);

    const beforeId = `${this.#clipPrefix}-before`;
    const afterId = `${this.#clipPrefix}-after`;
    const midY = TOP_Y + BAR_AREA / 2;

    const bars = timeline.buckets
      .filter((bucket) => bucket.total > 0)
      .map((bucket) => {
        const rawX = xOf(bucket.startDay);
        const spanW = xOf(bucket.endDay) - rawX;
        const gap = spanW > 4 ? 1.5 : spanW > 2.5 ? 0.8 : 0;
        const barW = Math.max(2, spanW - gap);
        const barX = Math.min(PAD_X + plotW - barW, Math.max(PAD_X, rawX + (spanW - barW) / 2));
        const totalH = Math.max(2, (bucket.total / timeline.maxBucket) * BAR_AREA);
        const copyableH = (bucket.copyable / bucket.total) * totalH;
        const leftOutH = totalH - copyableH;
        return { x: barX, w: barW, totalH, copyableH, leftOutH };
      });

    // Clamp the floating date pill so it stays inside the chart width at both edges.
    const pillHalf = Math.max(36, cutoffText.length * 3.6 + 12);
    const pillX = Math.min(width - pillHalf, Math.max(pillHalf, cutoffX));

    return html`<section
      aria-label="Message timeline"
      class="flex flex-col gap-3 rounded-2xl bg-panel p-4 ring-1 ring-line ring-inset sm:p-5"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-col gap-0.5 text-sm sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-1.5">
          <span class="flex items-baseline gap-1.5">
            ${
              isNone
                ? html`<span class="text-muted">Selection:</span><strong class="font-semibold text-ink">None</strong>`
                : html`<span class="text-muted">Copy from</span>
                    <strong class="font-semibold text-ink tabular-nums">${cutoffText}</strong>`
            }
          </span>
          <span aria-hidden="true" class="hidden text-muted sm:inline">·</span>
          <span class="text-muted tabular-nums">
            ${isAll ? `all ${messages(timeline.totalMessages)}` : `${selectedTotal.toLocaleString('en')} of ${messages(timeline.totalMessages)}`}
          </span>
        </div>
        <div role="group" aria-label="Quick selection" class="inline-flex gap-1 rounded-[10px] bg-segment p-1">
          ${presets.map((preset) => {
            const active = dayOffset === preset.dayOffset;
            return html`<button
              type="button"
              aria-pressed=${active}
              class="min-h-8 cursor-pointer rounded-lg px-2.5 text-[13px] font-medium ${
                active ? 'bg-white text-ink shadow-[0_1px_2px_rgba(20,20,30,0.12)]' : 'text-muted hover:text-ink'
              }"
              @click=${() => this.commitDay(timeline, preset.dayOffset)}
            >
              ${preset.label}
            </button>`;
          })}
        </div>
      </div>

      <div class="group relative select-none">
        <input
          type="range"
          class="peer sr-only"
          min="0"
          max=${timeline.spanDays}
          step="1"
          .value=${String(dayOffset)}
          aria-label="Copy messages starting from"
          aria-valuetext=${cutoffText}
          @input=${(event: Event) => {
            this.draftDay = Number((event.target as HTMLInputElement).value);
          }}
          @change=${(event: Event) => {
            this.commitDay(timeline, Number((event.target as HTMLInputElement).value));
          }}
        />
        <div
          data-timeline-stage
          class="relative h-[136px] cursor-ew-resize touch-none peer-focus-visible:[&_[data-knob]]:ring-2 peer-focus-visible:[&_[data-knob]]:ring-accent peer-focus-visible:[&_[data-knob]]:ring-offset-2"
          @pointerdown=${(event: PointerEvent) => {
            const stage = event.currentTarget as HTMLElement;
            this.#dragging = true;
            stage.setPointerCapture(event.pointerId);
            this.draftDay = this.dayFromPointer(timeline, stage, event.clientX);
            this.querySelector<HTMLInputElement>('input[type="range"]')?.focus({ preventScroll: true });
          }}
          @pointermove=${(event: PointerEvent) => {
            if (!this.#dragging) return;
            this.draftDay = this.dayFromPointer(timeline, event.currentTarget as HTMLElement, event.clientX);
          }}
          @pointerup=${(event: PointerEvent) => {
            if (!this.#dragging) return;
            this.#dragging = false;
            const day = this.dayFromPointer(timeline, event.currentTarget as HTMLElement, event.clientX);
            this.commitDay(timeline, day);
          }}
          @pointercancel=${() => {
            if (!this.#dragging) return;
            this.#dragging = false;
            this.commitDay(timeline, this.draftDay ?? dayOffset);
          }}
        >
          <svg
            class="block h-[136px] w-full overflow-visible"
            viewBox="0 0 ${width} ${CHART_HEIGHT}"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            ${svg`<defs>
              <clipPath id=${beforeId}>
                <rect x="0" y="0" width=${Math.max(0, cutoffX).toFixed(1)} height=${CHART_HEIGHT}></rect>
              </clipPath>
              <clipPath id=${afterId}>
                <rect
                  x=${cutoffX.toFixed(1)}
                  y="0"
                  width=${Math.max(0, width - cutoffX).toFixed(1)}
                  height=${CHART_HEIGHT}
                ></rect>
              </clipPath>
            </defs>`}
            ${
              !isNone
                ? svg`<rect
                    x=${cutoffX.toFixed(1)}
                    y=${TOP_Y}
                    width=${Math.max(0, PAD_X + plotW - cutoffX).toFixed(1)}
                    height=${BAR_AREA}
                    fill="var(--color-accent)"
                    fill-opacity="0.07"
                    rx="2"
                  ></rect>`
                : nothing
            }
            ${svg`<line
              x1=${PAD_X}
              y1=${TOP_Y}
              x2=${PAD_X + plotW}
              y2=${TOP_Y}
              stroke="var(--color-line)"
              stroke-width="1"
              stroke-dasharray="2 3"
            ></line>
            <line
              x1=${PAD_X}
              y1=${midY.toFixed(1)}
              x2=${PAD_X + plotW}
              y2=${midY.toFixed(1)}
              stroke="var(--color-line)"
              stroke-width="1"
              stroke-dasharray="2 3"
            ></line>`}
            ${svg`<g clip-path=${`url(#${beforeId})`}>
              ${bars.map(
                (bar) => svg`<rect
                  x=${bar.x.toFixed(1)}
                  y=${(BASE_Y - bar.totalH).toFixed(1)}
                  width=${bar.w.toFixed(1)}
                  height=${bar.totalH.toFixed(1)}
                  fill="var(--color-line-strong)"
                  fill-opacity="0.55"
                  rx="1"
                ></rect>`,
              )}
            </g>`}
            ${svg`<g clip-path=${`url(#${afterId})`}>
              ${bars.map(
                (bar) =>
                  svg`${
                    bar.leftOutH > 0.5
                      ? svg`<rect
                        x=${bar.x.toFixed(1)}
                        y=${(BASE_Y - bar.totalH).toFixed(1)}
                        width=${bar.w.toFixed(1)}
                        height=${bar.leftOutH.toFixed(1)}
                        fill="var(--color-line-strong)"
                        rx="1"
                      ></rect>`
                      : nothing
                  }${
                    bar.copyableH > 0.5
                      ? svg`<rect
                        x=${bar.x.toFixed(1)}
                        y=${(BASE_Y - bar.copyableH).toFixed(1)}
                        width=${bar.w.toFixed(1)}
                        height=${bar.copyableH.toFixed(1)}
                        fill="var(--color-accent)"
                        rx="1"
                      ></rect>`
                      : nothing
                  }`,
              )}
            </g>`}
            ${svg`<text
              x=${PAD_X + 4}
              y=${TOP_Y + 12}
              font-size="10"
              fill="var(--color-muted)"
              paint-order="stroke"
              stroke="var(--color-panel)"
              stroke-width="4"
              stroke-linejoin="round"
            >${timeline.maxBucket.toLocaleString('en')} / ${UNIT_LABEL[timeline.unit]}</text>`}
            ${svg`<line
              x1=${PAD_X}
              y1=${BASE_Y}
              x2=${PAD_X + plotW}
              y2=${BASE_Y}
              stroke="var(--color-line-strong)"
              stroke-width="2"
              stroke-linecap="round"
            ></line>`}
            ${
              !isNone
                ? svg`<line
                    x1=${cutoffX.toFixed(1)}
                    y1=${BASE_Y}
                    x2=${PAD_X + plotW}
                    y2=${BASE_Y}
                    stroke="var(--color-accent)"
                    stroke-width="2.5"
                    stroke-linecap="round"
                  ></line>`
                : nothing
            }
            ${ticks.map((tick) => {
              const tx = xOf(tick.dayOffset);
              return svg`<line
                x1=${tx.toFixed(1)}
                y1=${BASE_Y}
                x2=${tx.toFixed(1)}
                y2=${BASE_Y + (tick.edge ? 7 : 5)}
                stroke="var(--color-muted)"
                stroke-opacity=${tick.edge ? '0.6' : '0.35'}
                stroke-width="1"
              ></line>
              <text
                x=${tx.toFixed(1)}
                y=${BASE_Y + 21}
                text-anchor=${tick.align}
                font-size="11"
                font-weight=${tick.edge ? '600' : '400'}
                fill=${tick.edge ? 'var(--color-ink)' : 'var(--color-muted)'}
              >${tick.label}</text>`;
            })}
            ${svg`<line
              x1=${cutoffX.toFixed(1)}
              y1="20"
              x2=${cutoffX.toFixed(1)}
              y2=${BASE_Y}
              stroke="var(--color-accent)"
              stroke-width="2"
            ></line>`}
          </svg>

          <span
            aria-hidden="true"
            class="pointer-events-none absolute top-0 -translate-x-1/2 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white tabular-nums shadow-[0_2px_6px_rgba(20,20,30,0.2)]"
            style="left: ${pillX.toFixed(1)}px"
          >
            ${cutoffText}
          </span>
          <span
            data-knob
            aria-hidden="true"
            class="pointer-events-none absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[2.5px] border-accent bg-white shadow-[0_1px_4px_rgba(20,20,30,0.25)]"
            style="top: ${BASE_Y}px; left: ${cutoffX.toFixed(1)}px"
          >
            <span class="size-1.5 rounded-full bg-accent"></span>
          </span>
        </div>
      </div>
    </section>`;
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
        <span class="text-sm text-muted tabular-nums"
          >${count === 0 ? 'Nothing to copy' : `${messages(count)} to copy`}</span
        >
        <button type="button" class=${primaryButton} @click=${() => this.emit('next')}>Continue</button>
      </span>`;
    if (all.length === 0) {
      return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
        <p class="text-sm text-muted">Your Saved Messages are empty.</p>
        ${this.footer(next(0))}`;
    }

    const timeline = this.timelineOf(all);
    const dayOffset = this.draftDay ?? dayOffsetForFrom(timeline, this.from);
    const effectiveFrom = this.draftDay === null ? this.from : fromForDayOffset(timeline, this.draftDay);
    const useCommitted = this.draftDay === null && this.copy !== null;
    const toCopy = useCommitted ? this.copy!.toCopy : messagesToCopy(all, effectiveFrom).length;
    const leftOut = useCommitted ? this.copy!.leftOut : leftOutFrom(all, effectiveFrom);
    const media = useCommitted
      ? { withMedia: this.copy!.withMedia, mediaBytes: this.copy!.mediaBytes }
      : mediaSummaryFrom(all, effectiveFrom);
    const selectedTotal = toCopy + leftOut.tooLarge + leftOut.other;

    const leftOutRows: [number, string][] = [
      [leftOut.tooLarge, 'with a file too large for Signal: not copied'],
      [leftOut.other, 'of other kinds: not copied'],
    ];

    return html`${stepHeader(this.position, TITLE, DESCRIPTION)}
      ${this.renderTimeline(timeline, dayOffset, selectedTotal)}
      <ul
        aria-label="What is copied"
        class="flex shrink-0 flex-col overflow-hidden rounded-xl ring-1 ring-card-line ring-inset"
      >
        <li class="flex items-center justify-between gap-3 border-b border-[#F0F0EC] px-4 py-2.5 last:border-b-0">
          <span class="flex items-center gap-2 text-sm">
            <span aria-hidden="true" class="size-2 flex-none rounded-[2px] bg-accent"></span>
            <span class="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-1.5">
              <span class="font-medium">Messages to copy</span>
              ${
                media.withMedia > 0
                  ? html`<span aria-hidden="true" class="hidden text-muted sm:inline">·</span
                      ><span class="text-xs text-muted tabular-nums sm:text-sm"
                        >${media.withMedia.toLocaleString('en')} with
                        media${media.mediaBytes > 0 ? ` (${formatBytes(media.mediaBytes)})` : ''}</span
                      >`
                  : nothing
              }
            </span>
          </span>
          <span class="flex-none text-sm font-medium tabular-nums">${toCopy.toLocaleString('en')}</span>
        </li>
        ${leftOutRows
          .filter(([count]) => count > 0)
          .map(
            ([count, why]) =>
              html`<li
                class="flex items-center justify-between gap-3 border-b border-[#F0F0EC] px-4 py-2.5 last:border-b-0"
              >
                <span class="flex items-center gap-2 text-sm text-muted">
                  <span aria-hidden="true" class="size-2 flex-none rounded-[2px] bg-line-strong"></span>
                  Messages ${why}
                </span>
                <span class="flex-none text-sm text-muted tabular-nums">${count.toLocaleString('en')}</span>
              </li>`,
          )}
      </ul>
      <p class="text-sm text-muted">
        Copied messages keep their original dates, but appear after anything already in Note to Self. Previously
        migrated messages will not be duplicated.
      </p>
      ${this.footer(next(toCopy))}`;
  }
}
