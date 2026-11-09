// A phone number field: the country (flag and calling code, chosen from the browser's own list) and the number,
// formatted for the country as it is typed. A number pasted or filled in with + switches to its country. It reports
// the number in international form, or null while it cannot be one, as a "phone" event.

import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LightElement } from './layout';
import {
  type Country,
  type CountryCode,
  countries,
  defaultCountry,
  exampleFor,
  international,
  typed,
} from './phone-number';

let countryList: Country[] | null = null;

@customElement('phone-input')
export class PhoneInput extends LightElement {
  /** The number field's ID, for its label. */
  @property() fieldId = 'phone-number';
  @property({ type: Boolean }) disabled = false;
  @state() private country: CountryCode = defaultCountry(navigator.languages);
  @state() private text = '';

  /** The number in international form, or null while it cannot be a number of the country. */
  get value(): string | null {
    return international(this.country, this.text);
  }

  #changed(): void {
    this.emit('phone', this.value);
  }

  #onInput(event: InputEvent): void {
    const input = event.target as HTMLInputElement;
    // Formatting while deleting would put back the space or bracket just deleted.
    if (event.inputType.startsWith('delete')) {
      this.text = input.value;
    } else {
      const field = typed(this.country, input.value);
      this.country = field.country;
      this.text = field.text;
      input.value = field.text;
    }
    this.#changed();
  }

  #onCountry(event: Event): void {
    this.country = (event.target as HTMLSelectElement).value as CountryCode;
    this.text = typed(this.country, this.text.replace(/^\+\S*\s*/, '')).text;
    this.#changed();
  }

  render() {
    countryList ??= countries();
    const country = countryList.find((entry) => entry.code === this.country);
    return html`<div
      class="flex min-h-11 items-stretch rounded-[10px] bg-white ring-1 ring-line-strong ring-inset focus-within:ring-2 focus-within:ring-accent ${this.disabled ? 'opacity-60' : ''}"
    >
      <span class="relative flex flex-none items-center gap-1.5 border-r border-line pr-2.5 pl-3.5">
        <span aria-hidden="true" class="text-lg leading-none">${country?.flag ?? nothing}</span>
        <span aria-hidden="true" class="text-[15px] tabular-nums">+${country?.callingCode}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          class="text-muted"
        >
          <path d="M6 9l6 6 6-6"></path>
        </svg>
        <select
          aria-label="Country"
          class="absolute inset-0 cursor-pointer opacity-0"
          ?disabled=${this.disabled}
          .value=${this.country}
          @change=${(event: Event) => this.#onCountry(event)}
        >
          ${countryList.map(
            (entry) =>
              html`<option value=${entry.code} ?selected=${entry.code === this.country}>
                ${entry.flag} ${entry.name} (+${entry.callingCode})
              </option>`,
          )}
        </select>
      </span>
      <input
        id=${this.fieldId}
        type="tel"
        inputmode="tel"
        autocomplete="tel"
        required
        ?disabled=${this.disabled}
        .value=${this.text}
        placeholder=${exampleFor(this.country)}
        @input=${(event: InputEvent) => this.#onInput(event)}
        class="min-w-0 flex-1 rounded-r-[10px] bg-transparent px-3.5 text-[15px] tracking-wide placeholder:text-line-strong focus:outline-none"
      />
    </div>`;
  }
}
