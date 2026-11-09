// The phone number rules of the Telegram login (ui/phone-number.ts). The numbers are from ranges reserved for fiction,
// so that they are nobody's: 555-0100 to 555-0199 in the United States (NANPA), 07700 900000 to 07700 900999 in the
// United Kingdom (Ofcom). The expected forms follow the numbering plans: a British mobile number is dialled 07700 …
// at home and +44 7700 … from abroad.

import { describe, expect, it } from 'vitest';
import { countries, defaultCountry, international, typed } from '../src/ui/phone-number';

describe('phone numbers', () => {
  // Detects: a number typed the way people write it at home (with its leading 0) sent to Telegram wrongly.
  it('turns a number in the national format into the international one', () => {
    expect(international('GB', '07700 900123')).toBe('+447700900123');
    expect(international('US', '(201) 555-0123')).toBe('+12015550123');
  });

  // Detects: a pasted or autofilled international number read as a number of the country shown, or its country lost.
  it('switches to the country of a number that starts with +', () => {
    const field = typed('US', '+44 7700 900123');
    expect(field.country).toBe('GB');
    expect(field.text).toBe('07700 900123');
    expect(international(field.country, field.text)).toBe('+447700900123');
  });

  // Detects: Continue offered for a number that is too short to be one.
  it('gives no number while it is too short', () => {
    // Numbers in the United States have 10 digits.
    expect(international('US', '201 555')).toBeNull();
  });

  // Detects: the field starting at a country that the browser's settings do not suggest.
  it('starts at the country of the browser language', () => {
    expect(defaultCountry(['de-AT', 'en-US'])).toBe('AT');
    expect(defaultCountry(['pl'])).toBe('PL');
    expect(defaultCountry([])).toBe('US');
  });

  // Detects: a country missing from the list, or shown with the wrong calling code or flag.
  it('lists the countries with their calling codes and flags', () => {
    const germany = countries().find((country) => country.code === 'DE');
    expect(germany).toEqual({ code: 'DE', name: 'Germany', callingCode: '49', flag: '🇩🇪' });
  });
});
