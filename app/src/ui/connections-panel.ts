// What the page is connected to right now, in the bottom-left corner, with a way to disconnect each.

import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { shared } from './styles';

@customElement('connections-panel')
export class ConnectionsPanel extends LitElement {
  static styles = [
    shared,
    css`
      :host {
        position: fixed;
        left: 16px;
        bottom: 16px;
        z-index: 10;
        max-width: calc(100vw - 32px);
      }
      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .badge {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        padding: 0 4px 0 12px;
        border-radius: 16px;
        background: var(--surface);
        box-shadow: 0 0 0 1px var(--border), 0 2px 8px rgb(0 0 0 / 0.08);
        font-size: 13px;
      }
      .badge.info {
        padding-right: 12px;
        cursor: pointer;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ok);
      }
      .detail {
        margin-top: 8px;
        max-width: 360px;
        font-size: 13px;
      }
    `,
  ];

  /** The Telegram account's display name, or null when not logged in. */
  @property({ attribute: false }) telegram: string | null = null;
  /** The linked Signal device's ID, or null when not linked. */
  @property({ attribute: false }) signalDevice: number | null = null;
  @state() private showIndexDetail = false;

  private request(name: string): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  render() {
    return html`<div class="badges">
        ${this.telegram !== null
          ? html`<span class="badge"><span class="dot"></span>Telegram: ${this.telegram}<button class="secondary small" @click=${() => this.request('telegram-log-out')}>Log out</button></span>`
          : nothing}
        ${this.signalDevice !== null
          ? html`<span class="badge"><span class="dot"></span>Signal: linked device ${this.signalDevice}<button class="secondary small" @click=${() => this.request('signal-unlink')}>Unlink</button></span>`
          : nothing}
        <span class="badge info" role="button" tabindex="0" aria-expanded=${this.showIndexDetail} @click=${() => (this.showIndexDetail = !this.showIndexDetail)}>
          <span class="dot"></span>Sticker pack index
        </span>
      </div>
      ${this.showIndexDetail
        ? html`<div class="card detail">
            This site's server keeps a list of sticker packs already uploaded to Signal. Of your packs it receives only a hash
            of each one this page uploads, to find packs someone already uploaded; the list is downloaded and matched in this
            page. Your connection to Signal also passes through the server, encrypted so that only Signal can read it.
          </div>`
        : nothing}`;
  }
}
