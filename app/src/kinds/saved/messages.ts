// A message of Telegram's Saved Messages, as the migration keeps it, and how its text becomes a Signal message.
//
// Saved Messages is the chat a Telegram user has with themselves. Its messages are copied into Signal's Note to
// Self. This version copies text messages. A message with media, and a text too long for one Signal message, are
// counted and left out until attachments can be sent.

import type * as Td from 'tdlib-types';
import { bodyFits, type Note, type StyledRange, type TextStyle } from '../../signal/note-to-self';

export type SavedKind =
  | 'text'
  | 'photo'
  | 'video'
  | 'gif'
  | 'audio'
  | 'voice-note'
  | 'video-message'
  | 'file'
  | 'sticker'
  /** Everything else: a location, a contact, a poll, expired media, a kind Telegram's library does not know. */
  | 'other';

export type SavedMessage = {
  /** Telegram's ID of the message in the chat. Later messages have larger IDs. */
  id: number;
  /** When the message was sent, in seconds since 1970. */
  date: number;
  kind: SavedKind;
  /** The text of a text message, or the caption of a message with media; empty when there is none. */
  body: string;
  styles: StyledRange[];
};

const KINDS: Partial<Record<Td.MessageContent['_'], SavedKind>> = {
  messageText: 'text',
  messagePhoto: 'photo',
  messageVideo: 'video',
  messageAnimation: 'gif',
  messageAudio: 'audio',
  messageVoiceNote: 'voice-note',
  messageVideoNote: 'video-message',
  messageDocument: 'file',
  messageSticker: 'sticker',
};

const STYLES: Partial<Record<Td.TextEntityType['_'], TextStyle>> = {
  textEntityTypeBold: 'bold',
  textEntityTypeItalic: 'italic',
  textEntityTypeStrikethrough: 'strikethrough',
  textEntityTypeSpoiler: 'spoiler',
  textEntityTypeCode: 'monospace',
  textEntityTypePre: 'monospace',
  textEntityTypePreCode: 'monospace',
};

/**
 * Telegram's formatted text as a Signal body with styles. Signal has no link behind a word, so the address is
 * written after the word, in parentheses. Telegram's underline and block quote have no equivalent in Signal: the
 * text stays and the style is lost. Both count positions in UTF-16 code units.
 */
export function styledText(formatted: Td.formattedText): { body: string; styles: StyledRange[] } {
  const text = formatted.text;
  const entities = formatted.entities ?? [];
  // What is written into the text, and where: the address of each link, after its last character.
  const insertions = entities
    .flatMap((entity) => {
      if (entity.type._ !== 'textEntityTypeTextUrl') return [];
      const shown = text.slice(entity.offset, entity.offset + entity.length);
      return shown === entity.type.url ? [] : [{ at: entity.offset + entity.length, text: ` (${entity.type.url})` }];
    })
    .sort((a, b) => a.at - b.at);
  let body = '';
  let copied = 0;
  for (const insertion of insertions) {
    body += text.slice(copied, insertion.at) + insertion.text;
    copied = insertion.at;
  }
  body += text.slice(copied);
  /** Where a position of the original text is in the body: after what was written in at or before it. */
  const moved = (position: number, inclusive: boolean) =>
    position +
    insertions
      .filter((insertion) => (inclusive ? insertion.at <= position : insertion.at < position))
      .reduce((sum, insertion) => sum + insertion.text.length, 0);
  const styles = entities.flatMap((entity): StyledRange[] => {
    const style = STYLES[entity.type._];
    if (!style || entity.length <= 0) return [];
    const start = moved(entity.offset, true);
    return [{ start, length: moved(entity.offset + entity.length, false) - start, style }];
  });
  return { body, styles };
}

/** A message of the chat as the migration keeps it. */
export function savedMessageOf(message: Td.message): SavedMessage {
  const content = message.content;
  const kind = KINDS[content._] ?? 'other';
  const formatted = content._ === 'messageText' ? content.text : 'caption' in content ? content.caption : null;
  return {
    id: message.id,
    date: message.date,
    kind,
    ...(formatted ? styledText(formatted) : { body: '', styles: [] }),
  };
}

/** Why a message is not copied by this version, or null when it is copied. */
export function reasonLeftOut(message: SavedMessage): 'media' | 'too-long' | 'other' | null {
  if (message.kind === 'other') return 'other';
  if (message.kind !== 'text') return 'media';
  if (message.body === '') return 'other';
  return bodyFits(message.body) ? null : 'too-long';
}

/**
 * Telegram numbers the messages of a chat on its servers; TDLib's message ID is that number shifted by 20 bits.
 */
const serverNumberOf = (id: number) => Math.floor(id / 2 ** 20);

/**
 * The Signal message for a saved message. Its timestamp is computed from the Telegram message alone: Telegram's
 * date, in whole seconds, and for the milliseconds the last three digits of Telegram's number of the message. So
 * every run gives the same message the same timestamp, and Signal's apps drop a message that was copied before
 * (signal/note-to-self.ts). Two messages of one chat have the same timestamp only if they were sent in the same
 * second and their numbers are 1000 apart.
 */
export function noteOf(message: SavedMessage): Note {
  return {
    timestamp: message.date * 1000 + (serverNumberOf(message.id) % 1000),
    body: message.body,
    styles: message.styles,
  };
}
