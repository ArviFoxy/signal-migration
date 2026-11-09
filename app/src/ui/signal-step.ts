// Step 4: linking this page as a device of the user's Signal account, by a QR code scanned in Signal on the phone.

import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import QRCode from 'qrcode';
import type { Workflow } from '../app/workflow';
import { DEFAULT_DEVICE_NAME } from '../signal/link';
import {
  connectionArrow,
  connectionEnd,
  icons,
  instructions,
  LightElement,
  primaryButton,
  qrBox,
  secondaryButton,
  stepHeader,
  stickyFooter,
} from './layout';

@customElement('signal-step')
export class SignalStep extends LightElement {
  @property({ attribute: false }) workflow!: Workflow;
  @state() private qrCode: string | null = null;
  @state() private deviceName = DEFAULT_DEVICE_NAME;

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.workflow.device && this.workflow.signal !== 'wait') void this.link();
  }

  private async link(): Promise<void> {
    this.qrCode = null;
    await this.workflow.linkSignal(
      (url) => void QRCode.toDataURL(url, { margin: 1, width: 224 }).then((dataUrl) => (this.qrCode = dataUrl)),
      () => this.deviceName,
    );
  }

  render() {
    const device = this.workflow.device;
    const failed = !device && this.workflow.signal !== 'wait' && this.workflow.error !== null;
    return html`${stepHeader(4, 'Connect Signal', 'Links this app as a device of your Signal account.')}
      ${
        device
          ? html`<p class="flex items-center gap-2 font-semibold text-accent">
              ${icons.check(18)} Linked as device ${device.deviceId}
            </p>`
          : html`<div class="flex flex-wrap items-center gap-10">
                ${qrBox(this.qrCode, 'QR code for linking a Signal device')}
                ${instructions([
                  'Open Signal on your phone',
                  'Settings › Linked devices › Link new device',
                  'Point the camera at this code',
                ])}
              </div>
              <label class="flex max-w-[360px] flex-col gap-2">
                <span class="text-sm font-semibold">Device name</span>
                <input
                  type="text"
                  .value=${this.deviceName}
                  @input=${(event: Event) => (this.deviceName = (event.target as HTMLInputElement).value)}
                  class="min-h-11 rounded-[10px] px-3.5 text-[15px] ring-1 ring-line-strong ring-inset focus:ring-2 focus:ring-accent focus:outline-none"
                />
              </label>`
      }
      ${
        failed
          ? html`<div class="flex flex-wrap items-center gap-3">
              <button type="button" class=${secondaryButton} @click=${() => this.link()}>Show a new code</button>
            </div>`
          : nothing
      }
      <figure class="flex flex-col gap-3 rounded-xl bg-panel p-[18px] ring-1 ring-line ring-inset">
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-sm font-semibold text-accent">
            ${icons.lock()} End-to-end encrypted between this browser and Signal's servers
          </div>
          <div class="flex flex-wrap items-center gap-3 md:flex-nowrap">
            ${connectionEnd(icons.computer(), 'This browser', 'signal-migration page')} ${connectionArrow('WebSocket')}
            ${connectionEnd(icons.relay(), 'Tunnel', "this site's server")} ${connectionArrow('TCP')}
            ${connectionEnd(icons.servers(), 'Signal servers', 'operated by Signal')}
          </div>
        </div>
        <figcaption class="flex flex-col gap-1.5 text-sm">
          <span>
            The connection to Signal is end-to-end encrypted. This site's server only passes the encrypted bytes through
            the tunnel and cannot read them.
          </span>
          <span class="text-muted">
            The tunnel is needed because browsers cannot connect to Signal's servers directly. Signal uses certificates
            from its own certificate authority, which browsers do not trust.
          </span>
          <span class="text-muted"
            >Linked only while the migration runs, and unlinked automatically when it finishes.</span
          >
        </figcaption>
      </figure>
      ${stickyFooter(
        html`<button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>
          <button type="button" class=${primaryButton} ?disabled=${!device} @click=${() => this.emit('next')}>
            Continue
          </button>`,
      )}`;
  }
}
