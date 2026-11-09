// Step 2: logging in to Telegram, by scanning a QR code with Telegram on the phone, or with the phone number, the
// code Telegram sends and the Two-Step Verification password if the account has one. It shows the login machine's
// state (app/telegram-login.ts) and sends it the user's input; the machine decides everything else.

import { html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import QRCode from 'qrcode';
import type { LoginQuery, TelegramLogin } from '../app/telegram-login';
import {
  connectionArrow,
  connectionEnd,
  icons,
  instructions,
  LightElement,
  linkButton,
  primaryButton,
  qrBox,
  secondaryButton,
  stepHeader,
  stickyFooter,
} from './layout';
@customElement('telegram-step')
export class TelegramStep extends LightElement {
  @property({ attribute: false }) login!: TelegramLogin;
  /** The QR code image, drawn from the link it shows. */
  @state() private qrImage: { link: string; url: string } | null = null;
  @state() private showPassword = false;
  #onChange = () => this.requestUpdate();

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('login')) {
      (changed.get('login') as TelegramLogin | undefined)?.removeEventListener('change', this.#onChange);
      this.login.addEventListener('change', this.#onChange);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.login?.removeEventListener('change', this.#onChange);
  }

  /** The QR code's link, while TDLib waits for it to be scanned. */
  private get qrLink(): string | null {
    const state = this.login.state;
    return state.kind === 'login' && state.auth._ === 'authorizationStateWaitOtherDeviceConfirmation'
      ? state.auth.link
      : null;
  }

  protected updated(): void {
    const link = this.qrLink;
    if (link && this.qrImage?.link !== link) {
      void QRCode.toDataURL(link, { margin: 1, width: 224 }).then((url) => {
        if (this.qrLink === link) this.qrImage = { link, url };
      });
    }
  }

  private submit(event: SubmitEvent, build: (value: string) => LoginQuery): void {
    event.preventDefault();
    const input = (event.target as HTMLFormElement).querySelector('input')!;
    void this.login.submit(build(input.value.trim()));
  }

  private form(label: string, type: string, autocomplete: string, build: (value: string) => LoginQuery) {
    return html`<form
      class="flex max-w-md flex-wrap items-end gap-3"
      @submit=${(event: SubmitEvent) => this.submit(event, build)}
    >
      <label class="flex min-w-[220px] flex-1 flex-col gap-2">
        <span class="text-sm font-semibold">${label}</span>
        ${
          type === 'password'
            ? html`<span class="relative flex items-center">
                <span class="pointer-events-none absolute left-3.5 flex text-muted">${icons.lock('currentColor')}</span>
                <input
                  type=${this.showPassword ? 'text' : 'password'}
                  autocomplete=${autocomplete}
                  placeholder="••••••••"
                  required
                  ?disabled=${this.login.sending}
                  class="min-h-11 w-full rounded-[10px] bg-panel pr-11 pl-10 text-[15px] tracking-wide ring-1 ring-line-strong ring-inset placeholder:text-line-strong focus:bg-white focus:ring-2 focus:ring-accent focus:outline-none"
                />
                <button
                  type="button"
                  aria-label=${this.showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed=${this.showPassword}
                  class="absolute right-1 flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-segment"
                  @click=${() => (this.showPassword = !this.showPassword)}
                >
                  ${this.showPassword ? icons.eyeOff() : icons.eye()}
                </button>
              </span>`
            : html`<input
                type=${type}
                autocomplete=${autocomplete}
                required
                ?disabled=${this.login.sending}
                class="min-h-11 rounded-[10px] px-3.5 text-[15px] ring-1 ring-line-strong ring-inset focus:ring-2 focus:ring-accent focus:outline-none"
              />`
        }
      </label>
      <button type="submit" class=${primaryButton} ?disabled=${this.login.sending}>Continue</button>
    </form>`;
  }

  private body() {
    const login = this.login;
    const state = login.state;
    if (state.kind === 'off') {
      return login.error
        ? html`<button type="button" class="${secondaryButton} self-start" @click=${() => login.retry()}>
            Try again
          </button>`
        : html`<p class="text-muted">${state.signedOut ? 'Signed out of Telegram.' : 'Not connected.'}</p>`;
    }
    if (state.kind === 'stopping') return html`<p class="text-muted">Signing out of Telegram…</p>`;
    if (state.kind === 'ready')
      return html`<p class="flex items-center gap-2 font-semibold text-accent">
        ${icons.check(18)} Signed in to Telegram
      </p>`;
    const auth = state.kind === 'login' ? state.auth : null;
    if (
      login.method === 'qr' &&
      (auth === null ||
        auth._ === 'authorizationStateWaitPhoneNumber' ||
        auth._ === 'authorizationStateWaitOtherDeviceConfirmation')
    ) {
      const link = this.qrLink;
      return html`<div class="flex flex-wrap items-center gap-10">
        ${qrBox(link && this.qrImage?.link === link ? this.qrImage.url : null, 'QR code for Telegram sign-in')}
        ${instructions(
          [
            'Open Telegram on your phone',
            'Settings › Devices › Link Desktop Device',
            'Point the camera at this code',
            'If your account has a Two-Step Verification password, enter it here after scanning',
          ],
          html`<button type="button" class=${linkButton} @click=${() => login.useMethod('phone')}>
            Sign in with phone number instead
          </button>`,
        )}
      </div>`;
    }
    switch (auth?._) {
      case undefined:
        return html`<p class="text-muted">Connecting to Telegram…</p>`;
      case 'authorizationStateWaitPhoneNumber':
        return html`${this.form('Phone number, in international format', 'tel', 'tel', (phone_number) => ({ _: 'setAuthenticationPhoneNumber', phone_number }))}
          <p class="text-sm text-muted">
            After the code that Telegram sends, the page asks for your Two-Step Verification password if your account
            has one.
          </p>
          <button type="button" class="${linkButton} self-start" @click=${() => login.useMethod('qr')}>
            Sign in with a QR code instead
          </button>`;
      case 'authorizationStateWaitCode':
        return this.form(
          `Code Telegram sent${auth.code_info.phone_number ? ` to ${auth.code_info.phone_number}` : ''}`,
          'text',
          'one-time-code',
          (code) => ({ _: 'checkAuthenticationCode', code }),
        );
      case 'authorizationStateWaitEmailCode':
        return this.form(
          `Code Telegram sent to ${auth.code_info.email_address_pattern}`,
          'text',
          'one-time-code',
          (code) => ({
            _: 'checkAuthenticationEmailCode',
            code: { _: 'emailAddressAuthenticationCode', code },
          }),
        );
      case 'authorizationStateWaitPassword':
        return html`${this.form('Two-Step Verification password', 'password', 'current-password', (password) => ({
            _: 'checkAuthenticationPassword',
            password,
          }))}
          <p class="text-sm text-muted">
            The extra password set in Telegram under Settings › Privacy and Security › Two-Step Verification.
          </p>
          ${auth.password_hint ? html`<p class="text-sm text-muted">Hint: ${auth.password_hint}</p>` : nothing}`;
      default:
        return html`<p>
          This account needs a login step that is not supported here (${auth?._}). Sign in once in a Telegram app, then
          try again.
        </p>`;
    }
  }

  render() {
    const login = this.login;
    const ready = login.state.kind === 'ready';
    const description = ready
      ? 'Telegram is connected.'
      : login.method === 'qr'
        ? 'Scan the code with the Telegram app on your phone.'
        : 'Sign in with your phone number.';
    return html`${stepHeader(2, 'Connect Telegram', description)}
      <div class="flex flex-col gap-4">
        ${this.body()} ${login.error ? html`<p class="text-danger" role="alert">${login.error}</p>` : nothing}
      </div>
      <figure class="flex flex-col gap-3 rounded-xl bg-panel p-[18px] ring-1 ring-line ring-inset">
        <div class="flex flex-wrap items-center gap-3 md:flex-nowrap">
          ${connectionEnd(icons.computer(), 'This browser', 'signal-migration page')}
          ${connectionArrow('MTProto, encrypted')}
          ${connectionEnd(icons.servers(), 'Telegram servers', 'operated by Telegram')}
        </div>
        <figcaption class="text-sm">
          Direct connection, no server in between. Signed out of Telegram when the migration is done.
        </figcaption>
      </figure>
      ${stickyFooter(
        html`<button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>
          <button type="button" class=${primaryButton} ?disabled=${!ready} @click=${() => this.emit('next')}>
            Continue
          </button>`,
      )}`;
  }
}
