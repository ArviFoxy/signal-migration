// Pieces shared by every wizard step: the base element, the step header, buttons, and icons.
//
// Elements render into the page itself rather than a shadow root, so that the one Tailwind stylesheet
// (src/styles.css) styles all of them.

import { html, LitElement, nothing, svg, type TemplateResult } from 'lit';

export class LightElement extends LitElement {
  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected emit<T>(name: string, detail?: T): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }
}

export const STEP_LABELS = ['What to move', 'Telegram', 'Sticker packs', 'Signal', 'Review', 'Migrate'];

export const primaryButton =
  'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-[10px] bg-accent px-6 text-[15px] font-semibold text-white hover:bg-accent-strong disabled:cursor-default disabled:opacity-50';
export const secondaryButton =
  'inline-flex min-h-11 cursor-pointer items-center justify-center rounded-[10px] bg-white px-[22px] text-[15px] font-semibold text-ink ring-1 ring-line-strong ring-inset hover:bg-panel disabled:cursor-default disabled:opacity-50';
export const linkButton = 'cursor-pointer text-sm font-medium text-accent underline hover:text-accent-strong';

/** The eyebrow, title and description at the top of a step. `step` is 1-based; null for the final screen. */
export function stepHeader(step: number | null, title: string, description: string | TemplateResult): TemplateResult {
  return html`<header class="flex flex-col gap-2">
    ${step === null ? nothing : html`<p class="text-[13px] font-semibold tracking-[0.04em] text-accent uppercase">Step ${step} of ${STEP_LABELS.length}</p>`}
    <h1 class="font-display text-[34px] font-semibold tracking-[-0.01em]">${title}</h1>
    <p class="text-base text-muted">${description}</p>
  </header>`;
}

/** A labelled progress bar. */
export function progressBar(
  label: string,
  done: number,
  total: number,
  colour: 'accent' | 'upload' = 'accent',
): TemplateResult {
  const width = total > 0 ? Math.round((done / total) * 100) : 0;
  return html`<div
    role="progressbar"
    aria-label=${label}
    aria-valuemin="0"
    aria-valuemax=${total}
    aria-valuenow=${done}
    class="h-2 overflow-hidden rounded bg-line"
  >
    <div class="h-full ${colour === 'accent' ? 'bg-accent' : 'bg-upload'}" style="width: ${width}%"></div>
  </div>`;
}

const icon = (paths: TemplateResult, size = 22, colour = 'currentColor', strokeWidth = 2) =>
  html`<svg
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke=${colour}
    stroke-width=${strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="flex-none"
  >
    ${paths}
  </svg>`;

export const icons = {
  check: (size = 14) => icon(svg`<path d="M5 12l5 5L20 7"></path>`, size, 'currentColor', 3),
  download: () =>
    icon(svg`<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M4 20h16"></path>`, 22, '#3F3CBB'),
  link: () =>
    icon(
      svg`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"></path><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"></path>`,
      22,
      '#3F3CBB',
    ),
  database: () =>
    icon(
      svg`<ellipse cx="12" cy="6" rx="7" ry="3"></ellipse><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"></path><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"></path>`,
      22,
      '#3F3CBB',
    ),
  computer: () =>
    icon(svg`<rect x="4" y="5" width="16" height="11" rx="2"></rect><path d="M2 19h20"></path>`, 22, '#1B1B1F'),
  servers: () =>
    icon(
      svg`<rect x="4" y="4" width="16" height="7" rx="1.5"></rect><rect x="4" y="13" width="16" height="7" rx="1.5"></rect><path d="M8 7.5h.01"></path><path d="M8 16.5h.01"></path>`,
      22,
      '#1B1B1F',
    ),
  relay: () =>
    icon(
      svg`<path d="M4 12h16"></path><path d="M12 4v16"></path><circle cx="12" cy="12" r="3"></circle>`,
      22,
      '#1B1B1F',
    ),
  lock: (colour = '#3F3CBB') =>
    icon(
      svg`<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>`,
      16,
      colour,
    ),
  eye: () =>
    icon(
      svg`<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>`,
      18,
    ),
  eyeOff: () =>
    icon(
      svg`<path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2"></path><path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path><path d="M3 3l18 18"></path>`,
      18,
    ),
  search: () => icon(svg`<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path>`, 16, '#5B5F6A'),
  info: () =>
    icon(
      svg`<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>`,
      16,
      '#5B5F6A',
    ),
};

/** A two-headed arrow with a label above it, for the connection diagrams. */
export function connectionArrow(label: string): TemplateResult {
  return html`<div class="flex min-w-12 flex-[1_1_48px] flex-col items-center gap-0.5">
    <span class="text-center text-xs text-muted">${label}</span>
    <svg
      width="100%"
      height="12"
      viewBox="0 0 140 12"
      preserveAspectRatio="none"
      fill="none"
      stroke="#3F3CBB"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M2 6h136"></path>
      <path d="M8 1L2 6l6 5"></path>
      <path d="M132 1l6 5-6 5"></path>
    </svg>
  </div>`;
}

/** One end of a connection diagram. */
export function connectionEnd(symbol: TemplateResult, name: string, detail: string): TemplateResult {
  return html`<div class="flex items-center gap-2.5 rounded-xl bg-white px-4 py-3 ring-1 ring-[#DADBE0] ring-inset">
    ${symbol}
    <span class="flex flex-col"
      ><span class="text-sm font-semibold">${name}</span><span class="text-xs text-muted">${detail}</span></span
    >
  </div>`;
}

/** The QR code box; a placeholder until the code exists. */
export function qrBox(dataUrl: string | null, label: string): TemplateResult {
  return dataUrl
    ? html`<img
        src=${dataUrl}
        alt=${label}
        class="size-60 flex-none rounded-2xl bg-white p-2 ring-1 ring-[#DADBE0] ring-inset"
      />`
    : html`<div
        role="img"
        aria-label=${label}
        class="flex size-60 flex-none items-center justify-center rounded-2xl bg-panel text-sm text-muted ring-1 ring-[#DADBE0] ring-inset"
      >
        Preparing the code…
      </div>`;
}

/** Numbered instructions next to a QR code. */
export function instructions(
  steps: (string | TemplateResult)[],
  extra: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  return html`<ol class="flex flex-[1_1_260px] flex-col gap-[18px]">
    ${steps.map((text, i) => html`<li class="flex items-baseline gap-3.5"><span class="w-[18px] flex-none font-semibold text-accent">${i + 1}</span><span class="text-base">${text}</span></li>`)}
    ${extra === nothing ? nothing : html`<li class="pl-8">${extra}</li>`}
  </ol>`;
}

/** The step's actions, kept at the bottom of the window while a long step scrolls. */
export function stickyFooter(content: TemplateResult): TemplateResult {
  return html`<div
    class="sticky bottom-0 z-20 -mx-4 mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line bg-white/95 px-4 py-3 backdrop-blur sm:-mx-10 sm:px-10 lg:-mx-12 lg:px-12"
  >
    ${content}
  </div>`;
}

/** A bar kept at the top of the window while a long step scrolls: filters, or the progress of a running step. */
export function stickyBar(content: TemplateResult): TemplateResult {
  return html`<div
    class="sticky top-0 z-20 -mx-4 flex flex-col gap-3 border-b border-line bg-white/95 px-4 py-3 backdrop-blur sm:-mx-10 sm:px-10 lg:-mx-12 lg:px-12"
  >
    ${content}
  </div>`;
}
