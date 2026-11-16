// Which saved messages are copied, and copying them into Signal's Note to Self.
//
// Signal's apps list a conversation in the order in which its messages arrived. So the messages are sent oldest
// first, one after the other, and what is copied is everything from a date on: a later run can add newer messages
// behind the copied ones, but older messages added later would stand behind newer ones.

import type { SignalAccount } from '../../signal/transport';
import { noteOf, reasonLeftOut, type SavedMessage } from './messages';

/** The messages copied when the user chose to copy from `from` on (seconds since 1970); none while it is null. */
export function messagesToCopy(messages: readonly SavedMessage[], from: number | null): SavedMessage[] {
  if (from === null) return [];
  return messages.filter((message) => message.date >= from && reasonLeftOut(message) === null);
}

/** Of `messages`, those sent after the message `sentUpTo`, which is the last one a run has sent; all when null. */
export const notYetSent = (messages: readonly SavedMessage[], sentUpTo: number | null): SavedMessage[] =>
  sentUpTo === null ? [...messages] : messages.filter((message) => message.id > sentUpTo);

export type LeftOut = { media: number; tooLong: number; other: number };

/** How many messages from `from` on are not copied, by the reason. */
export function leftOutFrom(messages: readonly SavedMessage[], from: number | null): LeftOut {
  const count: LeftOut = { media: 0, tooLong: 0, other: 0 };
  for (const message of messages) {
    if (from !== null && message.date < from) continue;
    const reason = reasonLeftOut(message);
    if (reason === 'media') count.media++;
    else if (reason === 'too-long') count.tooLong++;
    else if (reason === 'other') count.other++;
  }
  return count;
}

/**
 * Sends `messages` to Note to Self in their order. `onSent` gets the ID of each message once Signal has accepted
 * it. Stops between two messages when `cancel` fires.
 */
export async function copyToNoteToSelf(
  account: Pick<SignalAccount, 'sendNoteToSelf'>,
  messages: readonly SavedMessage[],
  onSent: (id: number) => void,
  cancel: AbortSignal,
): Promise<void> {
  for (const message of messages) {
    if (cancel.aborted) return;
    await account.sendNoteToSelf(noteOf(message));
    onSent(message.id);
  }
}
