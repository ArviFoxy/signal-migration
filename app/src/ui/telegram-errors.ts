// What a failed Telegram sign-in step tells the user. TDLib passes on Telegram's error names (PHONE_CODE_INVALID,
// ...), and turns Telegram's request to wait into "Too Many Requests: retry after N" (NetQueryDelayer.cpp in
// third_party/td). Known names get a sentence; other names are shown as they are; sentences pass unchanged.

const MESSAGES: Record<string, string> = {
  PHONE_NUMBER_INVALID: 'Telegram says this phone number is not valid. Check the country and the number.',
  PHONE_NUMBER_BANNED: 'Telegram has banned this phone number.',
  PHONE_NUMBER_FLOOD: 'Telegram has paused sign-ins for this number after too many attempts. Try again later.',
  PHONE_PASSWORD_FLOOD: 'Telegram has paused sign-ins for this number after too many attempts. Try again later.',
  PHONE_CODE_INVALID: 'That is not the code Telegram sent. Check it and enter it again.',
  PHONE_CODE_EMPTY: 'That is not the code Telegram sent. Check it and enter it again.',
  PHONE_CODE_EXPIRED: 'The code has expired.',
  EMAIL_CODE_INVALID: 'That is not the code Telegram sent to your email address.',
  CODE_INVALID: 'That is not the code Telegram sent to your email address.',
  PASSWORD_HASH_INVALID: 'The password is wrong.',
};

/** A wait as Telegram asks for it: in seconds under two minutes, in minutes under two hours, else in hours. */
export function waitText(seconds: number): string {
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? '' : 's'}`;
  if (seconds < 120) return unit(seconds, 'second');
  if (seconds < 2 * 3600) return unit(Math.ceil(seconds / 60), 'minute');
  return unit(Math.ceil(seconds / 3600), 'hour');
}

/** The sentence for an error of a sign-in step. */
export function signInError(error: string): string {
  const wait = /^Too Many Requests: retry after (\d+)$/.exec(error);
  if (wait) return `Too many attempts. Telegram asks you to wait ${waitText(Number(wait[1]))} before trying again.`;
  if (error in MESSAGES) return MESSAGES[error];
  if (/^[A-Z][A-Z0-9_]+$/.test(error)) return `Telegram refused the sign-in: ${error}`;
  return error;
}

/** Whether the error is the code having expired, which "Send a new code" answers. */
export const codeExpired = (error: string | null) => error === 'PHONE_CODE_EXPIRED';
