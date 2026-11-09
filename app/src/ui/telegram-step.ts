// Step 2: logging in to Telegram, by scanning a QR code with Telegram on the phone, or with the phone number, the
// code Telegram sends and the Two-Step Verification password if the account has one. Each screen follows TDLib's authorization state.

import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import QRCode from 'qrcode';
import type * as Td from 'tdlib-types';
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
import type { TelegramSession } from '../app/services';

type Query = Parameters<TelegramSession['invoke']>[0];

@customElement('telegram-step')
export class TelegramStep extends LightElement {
  @property({ attribute: false }) session: TelegramSession | null = null;
  @property({ attribute: false }) authState: Td.AuthorizationState | null = null;
  @state() private mode: 'qr' | 'phone' = 'qr';
  @state() private qrCode: string | null = null;
  @state() private error: string | null = null;
  @state() private sending = false;
  @state() private showPassword = false;
  #qrLink: string | null = null;
  #qrRequestedFor: TelegramSession | null = null;

  protected updated(): void {
    const authState = this.authState;
    if (
      authState?._ === 'authorizationStateWaitPhoneNumber' &&
      this.mode === 'qr' &&
      this.session &&
      this.#qrRequestedFor !== this.session
    ) {
      this.#qrRequestedFor = this.session;
      void this.send({ _: 'requestQrCodeAuthentication', other_user_ids: [] });
    }
    if (authState?._ === 'authorizationStateWaitOtherDeviceConfirmation' && authState.link !== this.#qrLink) {
      this.#qrLink = authState.link;
      void QRCode.toDataURL(authState.link, { margin: 1, width: 224 }).then((url) => (this.qrCode = url));
    }
  }

  /** Sends one login request; a refusal (wrong code, wrong password) is shown and the state stays. */
  private async send(query: Query): Promise<void> {
    if (!this.session) return;
    this.sending = true;
    this.error = null;
    try {
      await this.session.invoke(query);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.sending = false;
    }
  }

  private submit(event: SubmitEvent, build: (value: string) => Query): void {
    event.preventDefault();
    const input = (event.target as HTMLFormElement).querySelector('input')!;
    void this.send(build(input.value.trim()));
  }

  /** TDLib cannot switch from a QR login to a phone login, so the login starts again. */
  private usePhone(): void {
    this.mode = 'phone';
    this.qrCode = null;
    this.#qrLink = null;
    if (this.authState?._ !== 'authorizationStateWaitPhoneNumber') this.emit('restart-telegram');
  }

  private useQr(): void {
    this.mode = 'qr';
    this.#qrRequestedFor = null;
    if (this.authState?._ !== 'authorizationStateWaitPhoneNumber') this.emit('restart-telegram');
    else this.requestUpdate();
  }

  private form(label: string, type: string, autocomplete: string, build: (value: string) => Query) {
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
                  ?disabled=${this.sending}
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
                ?disabled=${this.sending}
                class="min-h-11 rounded-[10px] px-3.5 text-[15px] ring-1 ring-line-strong ring-inset focus:ring-2 focus:ring-accent focus:outline-none"
              />`
        }
      </label>
      <button type="submit" class=${primaryButton} ?disabled=${this.sending}>Continue</button>
    </form>`;
  }

  private body() {
    const authState = this.authState;
    if (
      this.mode === 'qr' &&
      (authState === null ||
        authState._ === 'authorizationStateWaitTdlibParameters' ||
        authState._ === 'authorizationStateWaitPhoneNumber' ||
        authState._ === 'authorizationStateWaitOtherDeviceConfirmation')
    ) {
      return html`<div class="flex flex-wrap items-center gap-10">
        ${qrBox(authState?._ === 'authorizationStateWaitOtherDeviceConfirmation' ? this.qrCode : null, 'QR code for Telegram sign-in')}
        ${instructions(
          [
            'Open Telegram on your phone',
            'Settings › Devices › Link Desktop Device',
            'Point the camera at this code',
            'If your account has a Two-Step Verification password, enter it on this page after scanning',
          ],
          html`<button type="button" class=${linkButton} @click=${this.usePhone}>
            Sign in with phone number instead
          </button>`,
        )}
      </div>`;
    }
    switch (authState?._) {
      case undefined:
      case 'authorizationStateWaitTdlibParameters':
        return html`<p class="text-muted">Starting Telegram…</p>`;
      case 'authorizationStateWaitPhoneNumber':
        return html`${this.form('Phone number, in international format', 'tel', 'tel', (phone_number) => ({ _: 'setAuthenticationPhoneNumber', phone_number }))}
          <p class="text-sm text-muted">
            After the code that Telegram sends, the page asks for your Two-Step Verification password if your account
            has one.
          </p>
          <button type="button" class="${linkButton} self-start" @click=${this.useQr}>
            Sign in with a QR code instead
          </button>`;
      case 'authorizationStateWaitCode':
        return this.form(
          `Code Telegram sent${authState.code_info.phone_number ? ` to ${authState.code_info.phone_number}` : ''}`,
          'text',
          'one-time-code',
          (code) => ({ _: 'checkAuthenticationCode', code }),
        );
      case 'authorizationStateWaitEmailCode':
        return this.form(
          `Code Telegram sent to ${authState.code_info.email_address_pattern}`,
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
          ${authState.password_hint ? html`<p class="text-sm text-muted">Hint: ${authState.password_hint}</p>` : nothing}`;
      case 'authorizationStateReady':
        return html`<p class="flex items-center gap-2 font-semibold text-accent">
          ${icons.check(18)} Signed in to Telegram
        </p>`;
      case 'authorizationStateLoggingOut':
      case 'authorizationStateClosing':
      case 'authorizationStateClosed':
        return html`<p class="text-muted">Signed out of Telegram.</p>`;
      default:
        return html`<p>
          This account needs a step this page does not support (${authState?._}). Sign in once in a Telegram app, then
          try again.
        </p>`;
    }
  }

  render() {
    const ready = this.authState?._ === 'authorizationStateReady';
    return html`${stepHeader(2, 'Connect Telegram', this.mode === 'qr' ? 'Scan the code with the Telegram app on your phone.' : 'Sign in with your phone number.')}
      <div class="flex flex-col gap-4">
        ${this.body()} ${this.error ? html`<p class="text-danger" role="alert">${this.error}</p>` : nothing}
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
