// The connections panel at the bottom of the step list: what the page is connected to right now, with a way to
// disconnect each, and what the sticker pack index receives.

import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { icons, LightElement } from './layout';

export type ConnectionState = 'off' | 'wait' | 'on' | 'ended';
export type Connection = { state: ConnectionState; status: string; action?: { label: string; event: string } };

const DOTS: Record<ConnectionState, string> = {
  on: 'bg-accent',
  wait: 'bg-white ring-2 ring-upload ring-inset',
  ended: 'bg-ended',
  off: 'bg-white ring-1 ring-line-strong ring-inset',
};

@customElement('connections-panel')
export class ConnectionsPanel extends LightElement {
  @property({ attribute: false }) telegram!: Connection;
  @property({ attribute: false }) signal!: Connection;
  @property({ attribute: false }) index!: Connection;
  @state() private showIndexDetail = false;

  private row(name: string, connection: Connection, info = false) {
    return html`<li
      class="flex min-h-[52px] items-center gap-2.5 rounded-[10px] bg-white py-1 pr-1.5 pl-3 ring-1 ring-line ring-inset"
    >
      <span class="size-2.5 flex-none rounded-full ${DOTS[connection.state]}"></span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="text-[13px] font-semibold">${name}</span>
        <span class="text-xs text-muted">${connection.status}</span>
      </span>
      ${
        connection.action && connection.state === 'on'
          ? html`<button
              type="button"
              class="min-h-11 cursor-pointer rounded-lg px-3 text-[13px] font-semibold text-danger hover:bg-panel"
              @click=${() => this.emit(connection.action!.event)}
            >
              ${connection.action.label}
            </button>`
          : nothing
      }
      ${
        info
          ? html`<button
              type="button"
              aria-label="What the sticker pack index receives"
              aria-expanded=${this.showIndexDetail}
              class="flex size-11 cursor-pointer items-center justify-center rounded-lg hover:bg-panel"
              @click=${() => (this.showIndexDetail = !this.showIndexDetail)}
            >
              ${icons.info()}
            </button>`
          : nothing
      }
    </li>`;
  }

  render() {
    return html`<section aria-labelledby="connections-heading" class="flex flex-col gap-2.5">
      <h2 id="connections-heading" class="text-xs font-semibold tracking-[0.04em] text-muted uppercase">Connections</h2>
      <ul class="flex flex-col gap-2">
        ${this.row('Telegram', this.telegram)} ${this.row('Signal', this.signal)}
        ${this.row('Sticker pack index', this.index, true)}
      </ul>
      ${
        this.showIndexDetail
          ? html`<p class="rounded-[10px] bg-white p-3 text-xs ring-1 ring-line ring-inset">
              This site's server keeps a list of sticker packs that are already on Signal, to find packs that someone
              already uploaded. For each pack that you upload, it receives only the pack's hash and its Signal pack ID.
            </p>`
          : nothing
      }
    </section>`;
  }
}
