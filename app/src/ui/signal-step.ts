// Step 4: linking this page as a device of the user's Signal account, by a QR code scanned in Signal on the phone.
// It shows the link machine's state (app/signal-link.ts); the workflow starts linking while this step shows.

import { html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import QRCode from 'qrcode';
import type { SignalLink } from '../app/signal-link';
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
  @property({ attribute: false }) link!: SignalLink;
  /** The QR code image, drawn from the link it shows. */
  @state() private qrImage: { url: string; image: string } | null = null;
  #onChange = () => this.requestUpdate();

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('link')) {
      (changed.get('link') as SignalLink | undefined)?.removeEventListener('change', this.#onChange);
      this.link.addEventListener('change', this.#onChange);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.link?.removeEventListener('change', this.#onChange);
  }

  private get qrUrl(): string | null {
    return this.link.state.kind === 'linking' ? this.link.state.qrUrl : null;
  }

  protected updated(): void {
    const url = this.qrUrl;
    if (url && this.qrImage?.url !== url) {
      void QRCode.toDataURL(url, { margin: 1, width: 224 }).then((image) => {
        if (this.qrUrl === url) this.qrImage = { url, image };
      });
    }
  }

  render() {
    const link = this.link;
    const device = link.device;
    const url = this.qrUrl;
    return html`${stepHeader(4, 'Connect Signal', 'Links your browser as a device of your Signal account.')}
      ${
        device
          ? html`<p class="flex items-center gap-2 font-semibold text-accent">
              ${icons.check(18)} Linked as device ${device.deviceId}
            </p>`
          : html`<div class="flex flex-wrap items-center gap-10">
                ${qrBox(url && this.qrImage?.url === url ? this.qrImage.image : null, 'QR code for linking a Signal device')}
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
                  .value=${link.deviceName}
                  @input=${(event: Event) => (link.deviceName = (event.target as HTMLInputElement).value)}
                  class="min-h-11 rounded-[10px] px-3.5 text-[15px] ring-1 ring-line-strong ring-inset focus:ring-2 focus:ring-accent focus:outline-none"
                />
              </label>`
      }
      ${
        link.error
          ? html`<div class="flex flex-col items-start gap-3">
              <p class="text-danger" role="alert">${link.error}</p>
              ${
                device
                  ? nothing
                  : html`<button type="button" class=${secondaryButton} @click=${() => link.retry()}>
                      Show a new code
                    </button>`
              }
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
            ${connectionEnd(icons.relay(), 'Tunnel', 'the migration server')} ${connectionArrow('TCP')}
            ${connectionEnd(icons.servers(), 'Signal servers', 'operated by Signal')}
          </div>
        </div>
        <figcaption class="flex flex-col gap-1.5 text-sm">
          <span>
            The connection to Signal is end-to-end encrypted. The migration server, which this website comes from, only
            passes the encrypted bytes through the tunnel and cannot read them.
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
