// Logging in to Telegram: by scanning a QR code with a Telegram app that is already logged in, or with the phone
// number, the code Telegram sends, and the cloud password if the account has one. Each step follows TDLib's
// authorization state.

import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import QRCode from 'qrcode';
import type * as Td from 'tdlib-types';
import type { TelegramClient } from '../telegram/client';
import { shared } from './styles';

@customElement('telegram-login')
export class TelegramLogin extends LitElement {
  static styles = shared;

  @property({ attribute: false }) client: TelegramClient | null = null;
  @property({ attribute: false }) authState: Td.AuthorizationState | null = null;
  @state() private qrCode: string | null = null;
  @state() private qrLink: string | null = null;
  @state() private error: string | null = null;
  @state() private sending = false;

  protected updated(): void {
    const state = this.authState;
    if (state?._ === 'authorizationStateWaitOtherDeviceConfirmation' && state.link !== this.qrLink) {
      this.qrLink = state.link;
      void QRCode.toDataURL(state.link, { margin: 1, width: 240 }).then((url) => (this.qrCode = url));
    }
  }

  /** Sends one login request; a refusal (wrong code, wrong password) is shown and the state stays. */
  private async send(query: Parameters<TelegramClient['invoke']>[0]): Promise<void> {
    if (!this.client) return;
    this.sending = true;
    this.error = null;
    try {
      await this.client.invoke(query);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.sending = false;
    }
  }

  private submit(event: SubmitEvent, build: (value: string) => Parameters<TelegramClient['invoke']>[0]): void {
    event.preventDefault();
    const input = (event.target as HTMLFormElement).querySelector('input')!;
    void this.send(build(input.value.trim()));
  }

  private startOver(): void {
    this.dispatchEvent(new CustomEvent('start-over', { bubbles: true, composed: true }));
  }

  private form(label: string, type: string, autocomplete: string, build: (value: string) => Parameters<TelegramClient['invoke']>[0]) {
    return html`<form class="row" @submit=${(event: SubmitEvent) => this.submit(event, build)}>
      <input type=${type} autocomplete=${autocomplete} aria-label=${label} placeholder=${label} required ?disabled=${this.sending} />
      <button type="submit" ?disabled=${this.sending}>Continue</button>
    </form>`;
  }

  private body() {
    const state = this.authState;
    switch (state?._) {
      case undefined:
      case 'authorizationStateWaitTdlibParameters':
        return html`<p class="muted">Starting Telegram…</p>`;
      case 'authorizationStateWaitPhoneNumber':
        return html`<div class="row">
            <button ?disabled=${this.sending} @click=${() => this.send({ _: 'requestQrCodeAuthentication', other_user_ids: [] })}>Log in with a QR code</button>
          </div>
          <p class="muted">Or with your phone number, in international format:</p>
          ${this.form('Phone number', 'tel', 'tel', (phone_number) => ({ _: 'setAuthenticationPhoneNumber', phone_number }))}`;
      case 'authorizationStateWaitOtherDeviceConfirmation':
        return html`${this.qrCode ? html`<img class="qr" src=${this.qrCode} alt="QR code for logging in to Telegram" />` : nothing}
          <p>In Telegram on your phone: Settings › Devices › Link Desktop Device, then scan this code.</p>
          <div class="row"><button class="secondary small" @click=${this.startOver}>Use the phone number instead</button></div>`;
      case 'authorizationStateWaitCode':
        return html`<p>Enter the code Telegram sent${state.code_info.phone_number ? ` for ${state.code_info.phone_number}` : ''}.</p>
          ${this.form('Code', 'text', 'one-time-code', (code) => ({ _: 'checkAuthenticationCode', code }))}
          <div class="row"><button class="secondary small" @click=${this.startOver}>Start over</button></div>`;
      case 'authorizationStateWaitEmailCode':
        return html`<p>Enter the code Telegram sent to ${state.code_info.email_address_pattern}.</p>
          ${this.form('Code', 'text', 'one-time-code', (code) => ({ _: 'checkAuthenticationEmailCode', code: { _: 'emailAddressAuthenticationCode', code } }))}`;
      case 'authorizationStateWaitPassword':
        return html`<p>Enter your Telegram cloud password${state.password_hint ? html` <span class="muted">(hint: ${state.password_hint})</span>` : nothing}.</p>
          ${this.form('Password', 'password', 'current-password', (password) => ({ _: 'checkAuthenticationPassword', password }))}`;
      case 'authorizationStateReady':
        return html`<p>Logged in.</p>`;
      case 'authorizationStateLoggingOut':
      case 'authorizationStateClosing':
      case 'authorizationStateClosed':
        return html`<p class="muted">Telegram is closed.</p>`;
      default:
        return html`<p>This account needs a step this page does not support (${state?._}). Log in once in a Telegram app, then try again.</p>
          <div class="row"><button class="secondary small" @click=${this.startOver}>Start over</button></div>`;
    }
  }

  render() {
    return html`<div class="stack">
      <h2>Log in to Telegram</h2>
      ${this.body()} ${this.error ? html`<p class="error">${this.error}</p>` : nothing}
    </div>`;
  }
}
