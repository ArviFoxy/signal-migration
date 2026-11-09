// The connections panel at the bottom of the step list: what the page is connected to right now, a way to
// disconnect each, and for each a card attached to its row that says what the connection is, first plainly, then
// technically. The card shows while the pointer is over the row, or while its info button has focus (a tap on touch
// screens). Below the panel, a link to the source code.

import { html, nothing, svg, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { icons, LightElement } from './layout';

export type ConnectionState = 'off' | 'wait' | 'on' | 'ended';
export type Connection = { state: ConnectionState; status: string; action?: { label: string; event: string } };

const SOURCE_CODE = 'https://github.com/ArviFoxy/signal-migration';

const DOTS: Record<ConnectionState, string> = {
  on: 'bg-accent',
  wait: 'bg-white ring-2 ring-upload ring-inset',
  ended: 'bg-ended',
  off: 'bg-white ring-1 ring-line-strong ring-inset',
};

const code = (text: string) => html`<code class="rounded bg-segment px-1 py-0.5 text-[12px]">${text}</code>`;

/** What each connection is: one plain sentence about the connection and its encryption, then one technical line. */
const INFO: Record<'telegram' | 'signal' | 'index', { title: string; plain: string; technical: TemplateResult }> = {
  telegram: {
    title: 'Telegram',
    plain: 'Your browser talks to Telegram directly. The connection is encrypted, and only Telegram can read it.',
    technical: html`Your browser runs TDLib, Telegram's own library. TDLib connects to ${code('*.web.telegram.org')}
    over a WebSocket and encrypts everything with MTProto, Telegram's protocol.`,
  },
  signal: {
    title: 'Signal',
    plain:
      'Your browser talks to Signal through the migration server, which this website comes from. The connection is encrypted end to end, so the migration server passes it on but cannot read it.',
    technical: html`Signal uses their own certificate authority which is not trusted by the browser. To work around this
    the browser opens a WebSocket to the migration server, and runs its own TLS connection to ${code('*.signal.org')}
    inside it, checked against Signal's root certificate.`,
  },
  index: {
    title: 'Sticker pack index',
    plain:
      'The migration server keeps a list of the packs already on Signal. When you upload a pack, the migration server receives only its hash and its Signal pack ID. It cannot access your stickers.',
    technical: html`Your browser downloads the whole list over HTTPS and looks up your packs on your computer. Packs
    uploaded by this migration are encrypted with a key derived from the Telegram pack.`,
  },
};

const githubMark = html`<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  ${svg`<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>`}
</svg>`;

/**
 * Where the cards open: beside the panel (the sidebar on wide screens), with the arrow pointing left at the row, or
 * below each row (the connections sheet on narrow screens), with the arrow pointing up.
 */
const PLACEMENT = {
  side: {
    card: 'left-full bottom-0 ml-4 w-[320px] before:absolute before:inset-y-0 before:-left-4 before:w-4',
    arrow: '-left-[7px] bottom-[18px] border-b border-l',
  },
  below: {
    card: 'inset-x-0 top-full mt-3 before:absolute before:inset-x-0 before:-top-3 before:h-3',
    arrow: '-top-[7px] right-[18px] border-t border-l',
  },
};

@customElement('connections-panel')
export class ConnectionsPanel extends LightElement {
  @property({ attribute: false }) telegram!: Connection;
  @property({ attribute: false }) signal!: Connection;
  @property({ attribute: false }) index!: Connection;
  @property({ attribute: false }) placement: keyof typeof PLACEMENT = 'side';
  /** The ID of the confirmation card that "Disconnect and clear local state" opens. */
  @property({ attribute: false }) clearTarget = '';
  /** Whether there is anything to clear; the button stays in place either way. */
  @property({ attribute: false }) canClear = false;

  private card(id: keyof typeof INFO) {
    const info = INFO[id];
    const placement = PLACEMENT[this.placement];
    return html`<div
      id="connection-info-${this.placement}-${id}"
      role="tooltip"
      class="connection-card invisible absolute z-50 rounded-xl bg-white p-4 text-ink opacity-0 shadow-[0_8px_32px_rgba(20,20,30,0.16)] ring-1 ring-line transition-opacity duration-150 ${placement.card}"
    >
      <span class="absolute size-3.5 rotate-45 border-line bg-white ${placement.arrow}"></span>
      <p class="flex items-start gap-2.5">
        <span class="mt-[3px]">${icons.lock()}</span>
        <span class="flex flex-col gap-1.5">
          <span class="text-sm leading-snug">${info.plain}</span>
          <span class="text-xs leading-relaxed text-muted">${info.technical}</span>
        </span>
      </p>
    </div>`;
  }

  private row(id: keyof typeof INFO, connection: Connection) {
    const action = connection.action && connection.state === 'on' ? connection.action : null;
    return html`<li
      class="connection-row relative flex items-start gap-2.5 rounded-[10px] bg-white py-2.5 pr-1.5 pl-3 ring-1 ring-line ring-inset hover:ring-line-strong"
    >
      <!-- The dot is centred on the name's line. -->
      <span class="flex h-[18px] flex-none items-center">
        <span class="size-2.5 rounded-full ${DOTS[connection.state]}"></span>
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-[13px] leading-[18px] font-semibold">${INFO[id].title}</span>
        <span class="text-xs leading-4 whitespace-nowrap text-muted">
          ${connection.status}${
            action
              ? html` ·
                  <button
                    type="button"
                    class="cursor-pointer font-semibold text-danger hover:underline"
                    @click=${() => this.emit(action.event)}
                  >
                    ${action.label}
                  </button>`
              : nothing
          }
        </span>
      </span>
      <button
        type="button"
        aria-label="About the ${INFO[id].title} connection"
        aria-describedby="connection-info-${this.placement}-${id}"
        class="-my-1 flex size-8 flex-none cursor-pointer items-center justify-center rounded-lg text-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        ${icons.info()}
      </button>
      ${this.card(id)}
    </li>`;
  }

  render() {
    return html`<section aria-labelledby="connections-heading-${this.placement}" class="flex flex-col gap-2.5">
      <h2
        id="connections-heading-${this.placement}"
        class="text-xs font-semibold tracking-[0.04em] text-muted uppercase"
      >
        Connections
      </h2>
      <ul class="flex flex-col gap-2">
        ${this.row('telegram', this.telegram)} ${this.row('signal', this.signal)} ${this.row('index', this.index)}
      </ul>
      <button
        type="button"
        popovertarget=${this.clearTarget}
        ?disabled=${!this.canClear}
        class="mt-1 cursor-pointer self-start text-[13px] font-semibold text-danger hover:underline disabled:cursor-default disabled:text-line-strong disabled:no-underline"
      >
        Disconnect and clear local state
      </button>
      <a
        href=${SOURCE_CODE}
        target="_blank"
        rel="noopener noreferrer"
        class="mt-1 inline-flex items-center gap-2 self-start text-[13px] font-medium text-muted hover:text-ink"
      >
        ${githubMark} Source code on GitHub
      </a>
    </section>`;
  }
}
