// Linking the temporary Signal device: a QR code that the user scans in Signal on their phone.

import { html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import QRCode from 'qrcode';
import { SignalConnection } from '../signal/connection';
import { DEVICE_NAME } from '../signal/link';
import { shared } from './styles';

@customElement('signal-link')
export class SignalLink extends LitElement {
  static styles = shared;

  @state() private qrCode: string | null = null;
  @state() private error: string | null = null;
  @state() private linking = false;

  connectedCallback(): void {
    super.connectedCallback();
    void this.link();
  }

  private async link(): Promise<void> {
    this.linking = true;
    this.error = null;
    this.qrCode = null;
    try {
      const connection = await SignalConnection.link((url) => void QRCode.toDataURL(url, { margin: 1, width: 240 }).then((dataUrl) => (this.qrCode = dataUrl)));
      this.dispatchEvent(new CustomEvent<SignalConnection>('linked', { detail: connection, bubbles: true, composed: true }));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.linking = false;
    }
  }

  render() {
    return html`<div class="stack">
      <h2>Link Signal</h2>
      ${this.qrCode && this.linking
        ? html`<img class="qr" src=${this.qrCode} alt="QR code for linking a device in Signal" />
            <p>In Signal on your phone: Settings › Linked devices › Link new device, then scan this code.</p>
            <p class="muted">It appears as “${DEVICE_NAME}” and is unlinked when the migration is done.</p>`
        : nothing}
      ${this.linking && !this.qrCode ? html`<p class="muted">Connecting to Signal…</p>` : nothing}
      ${this.error ? html`<p class="error">${this.error}</p><div class="row"><button @click=${() => this.link()}>Try again</button></div>` : nothing}
    </div>`;
  }
}
