// Phone numbers for the Telegram login: the countries to choose from, the country to start with, the number
// formatted as the user types it, and the number in international form (E.164) that TDLib gets. The rules come from
// libphonenumber-js, a port of Google's libphonenumber; the country names come from the browser (Intl.DisplayNames).

import {
  AsYouType,
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  isSupportedCountry,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/min';
import metadata from 'libphonenumber-js/min/metadata';
import examples from 'libphonenumber-js/mobile/examples';

export type { CountryCode };

export type Country = { code: CountryCode; name: string; callingCode: string; flag: string };

/** A country's flag emoji, from its two-letter code. */
export const flagOf = (code: string) =>
  String.fromCodePoint(...[...code.toUpperCase()].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));

/** Every country, by name in `language`. */
export function countries(language = 'en'): Country[] {
  const names = new Intl.DisplayNames([language], { type: 'region' });
  return getCountries()
    .map((code) => ({
      code,
      name: names.of(code) ?? code,
      callingCode: getCountryCallingCode(code),
      flag: flagOf(code),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, language));
}

/**
 * The country to start with: the region of the first of the browser's languages that names one, or the region its
 * language is most spoken in ("de" in Germany); the United States without any.
 */
export function defaultCountry(languages: readonly string[]): CountryCode {
  for (const language of languages) {
    let region: string | undefined;
    try {
      region = new Intl.Locale(language).maximize().region;
    } catch {
      continue;
    }
    if (region && isSupportedCountry(region)) return region;
  }
  return 'US';
}

/** The country that a calling code belongs to first: the United States for 1, Great Britain for 44. */
const mainCountry = (callingCode: string): CountryCode | undefined =>
  (metadata as { country_calling_codes: Record<string, CountryCode[]> }).country_calling_codes[callingCode]?.[0];

/**
 * What the field holds after the user typed or pasted `text`, formatted for its country. A whole number that starts
 * with + switches the field to its country: the one its digits name, or else the country its calling code belongs to
 * first. Until it is whole, it stays as typed, formatted.
 */
export function typed(country: CountryCode, text: string): { country: CountryCode; text: string } {
  if (text.trim().startsWith('+')) {
    const number = parsePhoneNumberFromString(text);
    const switchTo = number?.isPossible() ? (number.country ?? mainCountry(number.countryCallingCode)) : undefined;
    if (!number || !switchTo) return { country, text: new AsYouType().input(text) };
    return { country: switchTo, text: number.formatNational() };
  }
  return { country, text: new AsYouType(country).input(text) };
}

/** The number in international form (+447700900123), or null while it cannot be a number of `country`. */
export function international(country: CountryCode, text: string): string | null {
  const number = parsePhoneNumberFromString(text, country);
  return number?.isPossible() ? number.number : null;
}

/** A mobile number of `country` as an example, formatted as the user would type it. */
export const exampleFor = (country: CountryCode): string => getExampleNumber(country, examples)?.formatNational() ?? '';
