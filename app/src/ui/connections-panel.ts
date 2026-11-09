// The connections panel at the bottom of the step list: what the page is connected to right now, a way to
// disconnect each, and for each a card that says what the connection is, first plainly, then technically.
// Below it, a link to the source code.

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

/** What each connection is: one plain sentence, then the technical details. */
const INFO: Record<'telegram' | 'signal' | 'index', { title: string; plain: string; technical: TemplateResult }> = {
  telegram: {
    title: 'Telegram',
    plain:
      'Your browser talks to Telegram directly, over an encrypted connection that only Telegram can read. No server of this site is in between.',
    technical: html`TDLib, Telegram's own library, runs in this page. It opens a WebSocket over TLS to Telegram's
    servers (${code('wss://*.web.telegram.org/apiws')}) and encrypts everything inside it with Telegram's MTProto
    protocol.`,
  },
  signal: {
    title: 'Signal',
    plain:
      "Your browser talks to Signal through a tunnel on this site's server. The connection is end-to-end encrypted between your browser and Signal, so this site cannot read it.",
    technical: html`The page opens a WebSocket to this site (${code('/tunnel/<host>')}). Inside it, the page runs its
    own TLS session with ${code('chat.signal.org')}, ${code('storage.signal.org')} and ${code('cdn.signal.org')},
    checked against Signal's root certificate (rustls in WebAssembly). The server forwards the encrypted bytes over TCP.
    The tunnel is needed because browsers do not trust Signal's own certificate authority.`,
  },
  index: {
    title: 'Sticker pack index',
    plain:
      "This site's server keeps a list of sticker packs that are already on Signal, to find packs that someone already uploaded. For each pack that you upload, it receives only the pack's hash and its Signal pack ID.",
    technical: html`HTTPS to this site. The page downloads the whole list and matches it on this computer, so the server
    does not learn which packs you have. To claim and add an upload, it sends a 32-byte key derived from the pack's
    content with HKDF-SHA256, and with an added pack its 16-byte Signal pack ID.`,
  },
};

const githubMark = html`<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  ${svg`<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>`}
</svg>`;

@customElement('connections-panel')
export class ConnectionsPanel extends LightElement {
  @property({ attribute: false }) telegram!: Connection;
  @property({ attribute: false }) signal!: Connection;
  @property({ attribute: false }) index!: Connection;

  private card(id: keyof typeof INFO, connection: Connection) {
    const info = INFO[id];
    return html`<div
      id="connection-info-${id}"
      popover
      class="m-auto w-[min(440px,calc(100vw-32px))] rounded-2xl bg-white p-6 text-ink shadow-[0_8px_40px_rgba(20,20,30,0.18)] ring-1 ring-line backdrop:bg-ink/20"
    >
      <div class="flex flex-col gap-4">
        <div class="flex items-start justify-between gap-3">
          <div class="flex flex-col gap-1">
            <h3 class="font-display text-lg font-semibold">${info.title}</h3>
            <span class="flex items-center gap-2 text-sm text-muted">
              <span class="size-2.5 flex-none rounded-full ${DOTS[connection.state]}"></span>${connection.status}
            </span>
          </div>
          <button
            type="button"
            popovertarget="connection-info-${id}"
            popovertargetaction="hide"
            aria-label="Close"
            class="flex size-9 cursor-pointer items-center justify-center rounded-lg text-xl leading-none text-muted hover:bg-panel"
          >
            ×
          </button>
        </div>
        <p class="flex items-start gap-2 text-[15px]">${icons.lock()}<span>${info.plain}</span></p>
        <div class="flex flex-col gap-1.5 rounded-xl bg-panel p-4 ring-1 ring-line ring-inset">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted uppercase">Technical details</span>
          <p class="text-[13px] leading-relaxed text-muted">${info.technical}</p>
        </div>
      </div>
    </div>`;
  }

  private row(id: keyof typeof INFO, connection: Connection) {
    return html`<li
      class="flex min-h-[52px] items-center gap-2 rounded-[10px] bg-white py-1.5 pr-1 pl-3 ring-1 ring-line ring-inset"
    >
      <span class="flex min-w-0 flex-1 items-start gap-2.5">
        <!-- The dot is centred on the name's line, not on the name and status together. -->
        <span class="flex h-[18px] flex-none items-center">
          <span class="size-2.5 rounded-full ${DOTS[connection.state]}"></span>
        </span>
        <span class="flex min-w-0 flex-col">
          <span class="text-[13px] leading-[18px] font-semibold">${INFO[id].title}</span>
          <span class="text-xs leading-4 text-muted">${connection.status}</span>
        </span>
      </span>
      ${
        connection.action && connection.state === 'on'
          ? html`<button
              type="button"
              class="min-h-11 cursor-pointer rounded-lg px-2 text-[13px] font-semibold text-danger hover:bg-panel"
              @click=${() => this.emit(connection.action!.event)}
            >
              ${connection.action.label}
            </button>`
          : nothing
      }
      <button
        type="button"
        popovertarget="connection-info-${id}"
        aria-label="About the ${INFO[id].title} connection"
        class="flex size-11 flex-none cursor-pointer items-center justify-center rounded-lg hover:bg-panel"
      >
        ${icons.info()}
      </button>
      ${this.card(id, connection)}
    </li>`;
  }

  render() {
    return html`<section aria-labelledby="connections-heading" class="flex flex-col gap-2.5">
      <h2 id="connections-heading" class="text-xs font-semibold tracking-[0.04em] text-muted uppercase">Connections</h2>
      <ul class="flex flex-col gap-2">
        ${this.row('telegram', this.telegram)} ${this.row('signal', this.signal)} ${this.row('index', this.index)}
      </ul>
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
