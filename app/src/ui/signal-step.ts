// Step 4: linking this page as a device of the user's Signal account, by a QR code scanned in Signal on the phone.
// It shows the link machine's state (app/signal-link.ts); the workflow starts linking while this step shows.

import { html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import QRCode from 'qrcode';
import type { SignalView } from '../app/workflow';
import {
  icons,
  instructions,
  LightElement,
  loginCard,
  primaryButton,
  qrBox,
  secondaryButton,
  stepHeader,
  stickyFooter,
} from './layout';

@customElement('signal-step')
export class SignalStep extends LightElement {
  @property({ attribute: false }) link!: SignalView;
  /** The QR code image, drawn from the link it shows. */
  @state() private qrImage: { url: string; image: string } | null = null;
  #onChange = () => this.requestUpdate();

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('link')) {
      (changed.get('link') as SignalView | undefined)?.removeEventListener('change', this.#onChange);
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
    const error = link.error
      ? html`<div class="flex flex-col items-start gap-3">
          <p class="text-sm text-danger" role="alert">${link.error}</p>
          ${
            device
              ? nothing
              : html`<button type="button" class=${secondaryButton} @click=${() => link.retry()}>
                  Show a new code
                </button>`
          }
        </div>`
      : nothing;
    return html`${stepHeader(3, 'Connect Signal', 'Links your browser as a device of your Signal account.')}
    ${
      device
        ? html`<div class="flex flex-col gap-3">
            <p class="flex items-center gap-2 font-semibold text-accent">
              ${icons.check(18)} Linked as device ${device.deviceId}
            </p>
            ${error}
          </div>`
        : loginCard(
            qrBox(url && this.qrImage?.url === url ? this.qrImage.image : null, 'QR code for linking a Signal device'),
            html`${instructions([
                'Open Signal on your phone',
                'Settings › Linked devices › Link new device',
                'Point the camera at this code',
              ])}
              <label class="flex max-w-xs flex-col gap-2">
                <span class="text-sm font-semibold">Device name</span>
                <input
                  type="text"
                  .value=${link.deviceName}
                  @input=${(event: Event) => (link.deviceName = (event.target as HTMLInputElement).value)}
                  class="min-h-11 rounded-[10px] bg-white px-3.5 text-[15px] ring-1 ring-line-strong ring-inset focus:ring-2 focus:ring-accent focus:outline-none"
                />
              </label>
              ${error}`,
          )
    }
    ${stickyFooter(
      html`<button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>
        <button type="button" class=${primaryButton} ?disabled=${!device} @click=${() => this.emit('next')}>
          Continue
        </button>`,
    )}`;
  }
}
