// Logging in to Telegram, by scanning a QR code with Telegram on the phone, or with the phone number, the code
// Telegram sends and the Two-Step Verification password if the account has one. It shows the login machine's state
// (app/machine/telegram) and sends it the user's input; the machine decides everything else.

import { html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import QRCode from 'qrcode';
import type { LoginQuery } from '../app/machine/telegram';
import type { TelegramView } from '../app/workflow';
import {
  assertNever,
  icons,
  instructions,
  LightElement,
  formCard,
  linkButton,
  loginCard,
  primaryButton,
  qrBox,
  secondaryButton,
  stepHeader,
  type StepPosition,
  stickyFooter,
} from './layout';
import './phone-input';
import { codeExpired, signInError } from './telegram-errors';

type TelegramBodyView =
  | { kind: 'off-error' }
  | { kind: 'off-idle'; signedOut: boolean }
  | { kind: 'ended-by-telegram' }
  | { kind: 'signing-out' }
  | { kind: 'signed-in' }
  | { kind: 'qr'; link: string | null; canRetry: boolean }
  | { kind: 'connecting' }
  | { kind: 'phone' }
  | { kind: 'code'; phoneNumber: string }
  | { kind: 'email-code'; pattern: string }
  | { kind: 'password'; hint: string }
  | { kind: 'unsupported'; authType: string };

@customElement('telegram-step')
export class TelegramStep extends LightElement {
  @property({ attribute: false }) login!: TelegramView;
  /** Where the step stands in the step list. */
  @property({ attribute: false }) position: StepPosition | null = null;
  /** The QR code image, drawn from the link it shows. */
  @state() private qrImage: { link: string; url: string } | null = null;
  @state() private showPassword = false;
  /** The phone number entered, in international form, or null while it cannot be one. */
  @state() private phone: string | null = null;
  #onChange = () => this.requestUpdate();

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('login')) {
      (changed.get('login') as TelegramView | undefined)?.removeEventListener('change', this.#onChange);
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
    const state = this.login.state;
    const isPassword = state.kind === 'login' && state.auth._ === 'authorizationStateWaitPassword';
    if (!isPassword && this.showPassword) this.showPassword = false;
  }

  private submit(event: SubmitEvent, build: (value: string) => LoginQuery, trim: boolean): void {
    event.preventDefault();
    const input = (event.target as HTMLFormElement).querySelector('input')!;
    this.login.submit(build(trim ? input.value.trim() : input.value));
  }

  /** The phone number form: the number goes to TDLib in international form, once it can be one. */
  private phoneForm() {
    const sending = this.login.sending;
    return html`<form
      class="flex flex-wrap items-end gap-3"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        if (this.phone) this.login.submit({ _: 'setAuthenticationPhoneNumber', phone_number: this.phone });
      }}
    >
      <div class="flex min-w-[260px] flex-1 flex-col gap-2">
        <label for="telegram-phone" class="text-sm font-semibold">Phone number</label>
        <phone-input
          fieldId="telegram-phone"
          ?disabled=${sending}
          @phone=${(event: CustomEvent<string | null>) => (this.phone = event.detail)}
        ></phone-input>
      </div>
      <button type="submit" class=${primaryButton} ?disabled=${sending || !this.phone}>Continue</button>
    </form>`;
  }

  private form(label: string, type: string, autocomplete: string, build: (value: string) => LoginQuery) {
    const trim = type !== 'password';
    return html`<form
      class="flex flex-wrap items-end gap-3"
      @submit=${(event: SubmitEvent) => this.submit(event, build, trim)}
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
                  required
                  ?disabled=${this.login.sending}
                  class="min-h-11 w-full rounded-[10px] bg-white pr-11 pl-10 text-[15px] tracking-wide ring-1 ring-line-strong ring-inset focus:ring-2 focus:ring-accent focus:outline-none"
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
                class="min-h-11 rounded-[10px] bg-white px-3.5 text-[15px] ring-1 ring-line-strong ring-inset focus:ring-2 focus:ring-accent focus:outline-none"
              />`
        }
      </label>
      <button type="submit" class=${primaryButton} ?disabled=${this.login.sending}>Continue</button>
    </form>`;
  }

  /** Why the last attempt failed: during the sign-in, as a sentence for Telegram's error (telegram-errors.ts). */
  private error() {
    const login = this.login;
    if (!login.error) return nothing;
    const message = login.state.kind === 'login' ? signInError(login.error) : login.error;
    return html`<div class="flex flex-col items-start gap-3">
      <p class="text-sm text-danger" role="alert">${message}</p>
      ${
        login.state.kind === 'login' && codeExpired(login.error)
          ? html`<button
              type="button"
              class=${secondaryButton}
              ?disabled=${login.sending}
              @click=${() =>
                login.submit({ _: 'resendAuthenticationCode', reason: { _: 'resendCodeReasonUserRequest' } })}
            >
              Send a new code
            </button>`
          : nothing
      }
    </div>`;
  }

  /** A sign-in form in its card: the form, the hints that go with it, why it failed, and another way to sign in. */
  private formCard(form: ReturnType<TelegramStep['form']>, hints: unknown[] = [], other: unknown = nothing) {
    return formCard(
      html`<div class="flex flex-col gap-3">
          ${form}
          ${hints.length > 0 ? html`<div class="flex flex-col gap-1.5 text-sm text-pretty text-muted">${hints}</div>` : nothing}
        </div>
        ${this.error()} ${other}`,
    );
  }

  private bodyView(): TelegramBodyView {
    const login = this.login;
    const state = login.state;
    if (state.kind === 'off' || state.kind === 'stopped') {
      return login.error
        ? { kind: 'off-error' }
        : { kind: 'off-idle', signedOut: state.kind === 'off' && state.signedOut };
    }
    if (this.endedByTelegram) return { kind: 'ended-by-telegram' };
    if (
      state.kind === 'signing-out' ||
      state.kind === 'ending-by-itself' ||
      (state.kind === 'deleting' && state.signedOut)
    ) {
      return { kind: 'signing-out' };
    }
    if (state.kind === 'saving' || state.kind === 'signed-in') return { kind: 'signed-in' };
    const auth = state.kind === 'login' ? state.auth : null;
    if (
      login.method === 'qr' &&
      (auth === null ||
        auth._ === 'authorizationStateWaitPhoneNumber' ||
        auth._ === 'authorizationStateWaitOtherDeviceConfirmation')
    ) {
      const link = this.qrLink;
      return { kind: 'qr', link, canRetry: !link && Boolean(login.error) };
    }
    if (!auth) return { kind: 'connecting' };
    switch (auth._) {
      case 'authorizationStateWaitPhoneNumber':
        return { kind: 'phone' };
      case 'authorizationStateWaitCode':
        return { kind: 'code', phoneNumber: auth.code_info.phone_number ?? '' };
      case 'authorizationStateWaitEmailCode':
        return { kind: 'email-code', pattern: auth.code_info.email_address_pattern };
      case 'authorizationStateWaitPassword':
        return { kind: 'password', hint: auth.password_hint };
      default:
        return { kind: 'unsupported', authType: auth._ };
    }
  }

  private body() {
    const login = this.login;
    const view = this.bodyView();
    switch (view.kind) {
      case 'off-error':
        return html`<div class="flex flex-col items-start gap-3">
          ${this.error()}
          <button type="button" class=${secondaryButton} @click=${() => login.retry()}>Try again</button>
        </div>`;
      case 'off-idle':
        return html`<p class="text-muted">${view.signedOut ? 'Signed out of Telegram.' : 'Not connected.'}</p>`;
      case 'ended-by-telegram':
        return nothing;
      case 'signing-out':
        return html`<p class="text-muted">Signing out of Telegram…</p>`;
      case 'signed-in':
        return html`<div class="flex flex-col gap-3">
          <p class="flex items-center gap-2 font-semibold text-accent">${icons.check(18)} Signed in to Telegram</p>
          ${this.error()}
        </div>`;
      case 'qr':
        return loginCard(
          qrBox(
            view.link && this.qrImage?.link === view.link ? this.qrImage.url : null,
            'QR code for Telegram sign-in',
          ),
          html`${instructions([
              'Open Telegram on your phone',
              'Settings › Devices › Add Device',
              'Point the camera at this code',
              'If your account has a Two-Step Verification password, enter it here after scanning',
            ])}
            ${this.error()}
            ${
              view.canRetry
                ? html`<button
                    type="button"
                    class="${secondaryButton} self-start"
                    ?disabled=${login.sending}
                    @click=${() => login.retry()}
                  >
                    Try again
                  </button>`
                : nothing
            }
            <button
              type="button"
              class="${linkButton} self-start"
              ?disabled=${login.sending}
              @click=${() => login.useMethod('phone')}
            >
              Sign in with phone number instead
            </button>`,
        );
      case 'connecting':
        return html`<p class="text-muted">Connecting to Telegram…</p>`;
      case 'phone':
        return keyed(
          view.kind,
          this.formCard(
            this.phoneForm(),
            [
              html`<p>
                After the code that Telegram sends, your browser asks for your Two-Step Verification password if your
                account has one.
              </p>`,
            ],
            html`<button
              type="button"
              class="${linkButton} self-start"
              ?disabled=${login.sending}
              @click=${() => login.useMethod('qr')}
            >
              Sign in with a QR code instead
            </button>`,
          ),
        );
      case 'code':
        return keyed(
          view.kind,
          this.formCard(
            this.form(
              `Code Telegram sent${view.phoneNumber ? ` to ${view.phoneNumber}` : ''}`,
              'text',
              'one-time-code',
              (code) => ({ _: 'checkAuthenticationCode', code }),
            ),
          ),
        );
      case 'email-code':
        return keyed(
          view.kind,
          this.formCard(
            this.form(`Code Telegram sent to ${view.pattern}`, 'text', 'one-time-code', (code) => ({
              _: 'checkAuthenticationEmailCode',
              code: { _: 'emailAddressAuthenticationCode', code },
            })),
          ),
        );
      case 'password':
        return keyed(
          view.kind,
          this.formCard(
            this.form('Two-Step Verification password', 'password', 'current-password', (password) => ({
              _: 'checkAuthenticationPassword',
              password,
            })),
            [
              html`<p>
                The extra password set in Telegram under
                <span class="whitespace-nowrap">Settings › Privacy and Security › Two-Step Verification</span>.
              </p>`,
              ...(view.hint ? [html`<p>Hint: ${view.hint}</p>`] : []),
            ],
          ),
        );
      case 'unsupported':
        return html`<p>
          This account needs a login step that is not supported here (${view.authType}). Sign in once in a Telegram app,
          then try again.
        </p>`;
      default:
        return assertNever(view);
    }
  }

  /** Telegram ended a login of this visit, and the page is removing it. */
  private get endedByTelegram(): boolean {
    const state = this.login.state;
    return (state.kind === 'ending-by-itself' || state.kind === 'deleting') && state.byTelegram;
  }

  render() {
    const login = this.login;
    const ready = login.state.kind === 'signed-in';
    const description = ready
      ? 'Telegram is connected.'
      : this.endedByTelegram
        ? 'Telegram ended this login. Removing it from your browser…'
        : login.method === 'qr'
          ? 'Scan the code with the Telegram app on your phone.'
          : 'Sign in with your phone number.';
    return html`${stepHeader(this.position, 'Connect Telegram', description)} ${this.body()}
    ${stickyFooter(
      html`<button type="button" class=${secondaryButton} @click=${() => this.emit('back')}>Back</button>
        <button type="button" class=${primaryButton} ?disabled=${!ready} @click=${() => this.emit('next')}>
          Continue
        </button>`,
    )}`;
  }
}
