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

export const STEP_LABELS = [
  'What to move',
  'Telegram login',
  'Signal login',
  'Select sticker packs',
  'Review',
  'Migrate',
  // Not a screen of its own: the migration screen's final state, once both logins are ended.
  'Done and logged out',
];

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
  computer: (size = 22) =>
    icon(svg`<rect x="4" y="5" width="16" height="11" rx="2"></rect><path d="M2 19h20"></path>`, size, '#1B1B1F'),
  servers: (size = 22) =>
    icon(
      svg`<rect x="4" y="4" width="16" height="7" rx="1.5"></rect><rect x="4" y="13" width="16" height="7" rx="1.5"></rect><path d="M8 7.5h.01"></path><path d="M8 16.5h.01"></path>`,
      size,
      '#1B1B1F',
    ),
  relay: (size = 22) =>
    icon(
      svg`<path d="M4 12h16"></path><path d="M12 4v16"></path><circle cx="12" cy="12" r="3"></circle>`,
      size,
      '#1B1B1F',
    ),
  lock: (colour = '#3F3CBB', size = 16) =>
    icon(
      svg`<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>`,
      size,
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

/** A part of a connection diagram: one end or relay, or the link between two of them. */
export type DiagramPart = { symbol: TemplateResult; name: string } | { link: string };

/**
 * A small diagram of a connection, for the connections cards: the ends and what lies between them, and under them a
 * bracket from one end to the other that says how the connection is encrypted.
 */
export function connectionDiagram(parts: DiagramPart[], encryption: string): TemplateResult {
  return html`<div class="flex flex-col border-t border-line pt-4 pb-2" aria-hidden="true">
    <div class="flex items-start">
      ${parts.map((part) =>
        'link' in part
          ? html`<div class="flex min-w-0 flex-1 flex-col items-center gap-1 px-1 pt-2">
              <span class="text-[10px] leading-none whitespace-nowrap text-muted">${part.link}</span>
              <svg
                width="100%"
                height="8"
                viewBox="0 0 100 8"
                preserveAspectRatio="none"
                fill="none"
                stroke="#3F3CBB"
                stroke-width="1.5"
                stroke-linecap="round"
              >
                <path d="M1 4h98"></path>
                <path d="M5 1L1 4l4 3"></path>
                <path d="M95 1l4 3-4 3"></path>
              </svg>
            </div>`
          : html`<div class="flex w-[76px] flex-none flex-col items-center gap-1 text-center">
              <span class="flex size-8 items-center justify-center rounded-full bg-accent-soft">${part.symbol}</span>
              <span class="text-[11px] leading-tight font-semibold">${part.name}</span>
            </div>`,
      )}
    </div>
    <!-- From the centre of the first end to the centre of the last. -->
    <div class="relative mx-[38px] mt-2 h-3 rounded-b-md border-x-[1.5px] border-b-[1.5px] border-accent">
      <span
        class="absolute top-full left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 bg-white px-2 text-[10px] font-semibold whitespace-nowrap text-accent"
        >${icons.lock('#3F3CBB', 11)} ${encryption}</span
      >
    </div>
  </div>`;
}

/** The card of a login method: the QR code or the form, and beside it (below on narrow screens) what to do. */
export function loginCard(main: TemplateResult, side: TemplateResult | typeof nothing = nothing): TemplateResult {
  return html`<div
    class="flex flex-col gap-6 rounded-2xl bg-panel p-5 ring-1 ring-line ring-inset sm:p-6 md:flex-row md:items-start md:gap-8"
  >
    ${main} ${side === nothing ? nothing : html`<div class="flex min-w-0 flex-1 flex-col gap-5">${side}</div>`}
  </div>`;
}

/** The QR code box; a placeholder until the code exists. */
export function qrBox(dataUrl: string | null, label: string): TemplateResult {
  return dataUrl
    ? html`<img
        src=${dataUrl}
        alt=${label}
        class="size-56 flex-none self-center rounded-xl bg-white p-2 ring-1 ring-line ring-inset md:self-start"
      />`
    : html`<div
        role="img"
        aria-label=${label}
        class="flex size-56 flex-none items-center justify-center self-center rounded-xl bg-white text-sm text-muted ring-1 ring-line ring-inset md:self-start"
      >
        Preparing the code…
      </div>`;
}

/** Numbered instructions for scanning a QR code. */
export function instructions(steps: (string | TemplateResult)[]): TemplateResult {
  return html`<ol class="flex flex-col gap-3.5">
    ${steps.map(
      (text, i) =>
        html`<li class="flex items-start gap-3">
          <span
            class="flex size-6 flex-none items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent"
            >${i + 1}</span
          ><span class="pt-0.5 text-[15px] leading-snug">${text}</span>
        </li>`,
    )}
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
