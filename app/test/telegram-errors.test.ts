// The sentences for failed Telegram sign-in steps (ui/telegram-errors.ts). The expected sentences are the ones the
// owner approved for each error.

import { describe, expect, it } from 'vitest';
import { signInError, waitText } from '../src/ui/telegram-errors';

describe('sign-in errors', () => {
  // Detects: a known Telegram error shown as its raw name, or with another sentence than the approved one.
  it('says what each known error means', () => {
    expect(signInError('PHONE_NUMBER_INVALID')).toBe(
      'Telegram says this phone number is not valid. Check the country and the number.',
    );
    expect(signInError('PHONE_NUMBER_BANNED')).toBe('Telegram has banned this phone number.');
    expect(signInError('PHONE_NUMBER_FLOOD')).toBe(
      'Telegram has paused sign-ins for this number after too many attempts. Try again later.',
    );
    expect(signInError('PHONE_CODE_INVALID')).toBe('That is not the code Telegram sent. Check it and enter it again.');
    expect(signInError('PHONE_CODE_EXPIRED')).toBe('The code has expired.');
    expect(signInError('EMAIL_CODE_INVALID')).toBe('That is not the code Telegram sent to your email address.');
    expect(signInError('PASSWORD_HASH_INVALID')).toBe('The password is wrong.');
  });

  // Detects: Telegram's request to wait shown raw, or with the wait in an unreadable unit.
  it('says how long Telegram asks to wait', () => {
    expect(signInError('Too Many Requests: retry after 300')).toBe(
      'Too many attempts. Telegram asks you to wait 5 minutes before trying again.',
    );
    expect(waitText(1)).toBe('1 second');
    expect(waitText(45)).toBe('45 seconds');
    expect(waitText(3700)).toBe('62 minutes');
    expect(waitText(7200)).toBe('2 hours');
    expect(waitText(90000)).toBe('25 hours');
  });

  // Detects: an unknown error hidden, or one of the app's own sentences reworded.
  it('names an unknown error and leaves sentences as they are', () => {
    expect(signInError('SMS_CODE_CREATE_FAILED')).toBe('Telegram refused the sign-in: SMS_CODE_CREATE_FAILED');
    expect(signInError('Telegram did not answer within 60 seconds.')).toBe(
      'Telegram did not answer within 60 seconds.',
    );
  });
});
