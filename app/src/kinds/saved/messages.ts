// A message of Telegram's Saved Messages, as the migration keeps it, and how its text and media become a Signal
// Note to Self message.
//
// Saved Messages is the chat a Telegram user has with themselves. Its text (including long messages above 2 KiB),
// photos, videos, GIFs, voice notes, audio files, round video messages, stickers, and arbitrary documents are copied
// into Signal's Note to Self. Messages with files above Signal's attachment limit, protected/self-destructing
// messages, and unsupported kinds (locations, polls, expired media, etc.) are counted and left out.

import type * as Td from 'tdlib-types';
import { attachmentFits, MAX_LONG_TEXT_BYTES } from '../../signal/attachment';
import { type Note, type StyledRange, type TextStyle } from '../../signal/note-to-self';
import type { StickerFormat } from '../stickers/telegram-packs';

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

/** Media attached to a Telegram Saved Message, enough to check size limits and download on migration. */
export type SavedMedia = {
  /** TDLib file ID in the run that read the message list. */
  fileId: number;
  /** TDLib `remote.id`, used with `getRemoteFile` if TDLib restarts before the file is downloaded. */
  remoteId: string;
  /** Plaintext byte length reported by TDLib (`size || expected_size`), or 0 if unknown until downloaded. */
  size: number;
  contentType: string;
  fileName?: string;
  width?: number;
  height?: number;
  duration?: number;
  /** Set on Telegram stickers so animated formats (TGS, WebM) can be converted to APNG. */
  stickerFormat?: StickerFormat;
  /** Animated GIF video (`AttachmentPointer.Flags.GIF`). */
  gif?: boolean;
  /** Voice note (`AttachmentPointer.Flags.VOICE_MESSAGE`). */
  voiceNote?: boolean;
  /** Sticker displayed without a frame (`AttachmentPointer.Flags.BORDERLESS`). */
  borderless?: boolean;
};

export type SavedMessage = {
  /** Telegram's ID of the message in the chat. Later messages have larger IDs. */
  id: number;
  /** When the message was sent, in seconds since 1970. */
  date: number;
  kind: SavedKind;
  /** The text of a text message, or the caption of a message with media; empty when there is none. */
  body: string;
  styles: StyledRange[];
  /** Present on copyable media messages (photos, videos, GIFs, audio, voice notes, files, stickers). */
  media?: SavedMedia;
  /** Non-zero Telegram `media_album_id` grouping attachments sent together as one album. */
  albumId?: string;
  /** True for protected (`can_be_saved === false`) or self-destructing / secret messages. */
  protected?: boolean;
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

const STICKER_FORMATS: Partial<Record<Td.StickerFormat['_'], StickerFormat>> = {
  stickerFormatWebp: 'webp',
  stickerFormatTgs: 'tgs',
  stickerFormatWebm: 'webm',
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

const textEncoder = new TextEncoder();

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

function fileInfo(file: Td.file | undefined): { fileId: number; remoteId: string; size: number } | null {
  if (!file) return null;
  return {
    fileId: file.id,
    remoteId: file.remote?.id ?? '',
    size: file.size || file.expected_size || 0,
  };
}

function largestPhotoSize(sizes: Td.photoSize[] | undefined): Td.photoSize | null {
  if (!sizes || sizes.length === 0) return null;
  let best: Td.photoSize | null = null;
  for (const size of sizes) {
    if (!best || size.width * size.height >= best.width * best.height) best = size;
  }
  return best;
}

function extractMedia(content: Td.MessageContent): SavedMedia | undefined {
  switch (content._) {
    case 'messagePhoto': {
      const largest = largestPhotoSize(content.photo?.sizes);
      const info = fileInfo(largest?.photo);
      if (!largest || !info) return undefined;
      return {
        ...info,
        contentType: 'image/jpeg',
        width: largest.width || undefined,
        height: largest.height || undefined,
      };
    }
    case 'messageVideo': {
      const info = fileInfo(content.video?.video);
      if (!info) return undefined;
      return {
        ...info,
        contentType: content.video.mime_type || 'video/mp4',
        width: content.video.width || undefined,
        height: content.video.height || undefined,
        duration: content.video.duration || undefined,
      };
    }
    case 'messageAnimation': {
      const info = fileInfo(content.animation?.animation);
      if (!info) return undefined;
      const contentType = content.animation.mime_type || 'video/mp4';
      return {
        ...info,
        contentType,
        width: content.animation.width || undefined,
        height: content.animation.height || undefined,
        duration: content.animation.duration || undefined,
        gif: contentType.startsWith('video/'),
      };
    }
    case 'messageVideoNote': {
      const info = fileInfo(content.video_note?.video);
      if (!info) return undefined;
      const length = content.video_note.length || undefined;
      return {
        ...info,
        contentType: 'video/mp4',
        width: length,
        height: length,
        duration: content.video_note.duration || undefined,
      };
    }
    case 'messageVoiceNote': {
      const info = fileInfo(content.voice_note?.voice);
      if (!info) return undefined;
      return {
        ...info,
        contentType: content.voice_note.mime_type || 'audio/ogg',
        duration: content.voice_note.duration || undefined,
        voiceNote: true,
      };
    }
    case 'messageAudio': {
      const info = fileInfo(content.audio?.audio);
      if (!info) return undefined;
      return {
        ...info,
        contentType: content.audio.mime_type || 'audio/mpeg',
        fileName: content.audio.file_name || undefined,
        duration: content.audio.duration || undefined,
      };
    }
    case 'messageDocument': {
      const info = fileInfo(content.document?.document);
      if (!info) return undefined;
      return {
        ...info,
        contentType: content.document.mime_type || 'application/octet-stream',
        fileName: content.document.file_name || undefined,
      };
    }
    case 'messageSticker': {
      const format = content.sticker?.format ? STICKER_FORMATS[content.sticker.format._] : undefined;
      const info = fileInfo(content.sticker?.sticker);
      if (!format || !info) return undefined;
      return {
        ...info,
        contentType: format === 'webp' ? 'image/webp' : 'image/png',
        width: content.sticker.width || undefined,
        height: content.sticker.height || undefined,
        stickerFormat: format,
        borderless: true,
      };
    }
    default:
      return undefined;
  }
}

/** A message of the chat as the migration keeps it. */
export function savedMessageOf(message: Td.message): SavedMessage {
  const content = message.content;
  const kind = KINDS[content._] ?? 'other';
  const formatted = content._ === 'messageText' ? content.text : 'caption' in content ? content.caption : null;
  const isSecret = 'is_secret' in content && Boolean(content.is_secret);
  const isProtected = message.can_be_saved === false || Boolean(message.self_destruct_type) || isSecret;
  const media = isProtected ? undefined : extractMedia(content);
  const albumId = message.media_album_id && message.media_album_id !== '0' ? message.media_album_id : undefined;
  return {
    id: message.id,
    date: message.date,
    kind,
    ...(formatted ? styledText(formatted) : { body: '', styles: [] }),
    ...(media ? { media } : {}),
    ...(albumId ? { albumId } : {}),
    ...(isProtected ? { protected: true } : {}),
  };
}

/** Why a message is not copied, or null when it is copied. */
export function reasonLeftOut(message: SavedMessage): 'too-large' | 'other' | null {
  if (message.protected) return 'other';
  if (message.kind === 'other') return 'other';
  if (message.kind === 'text') {
    if (message.body === '') return 'other';
    return textEncoder.encode(message.body).length <= MAX_LONG_TEXT_BYTES ? null : 'too-large';
  }
  if (!message.media) return 'other';
  if (message.media.size > 0 && !attachmentFits(message.media.size)) return 'too-large';
  if (message.body !== '' && textEncoder.encode(message.body).length > MAX_LONG_TEXT_BYTES) return 'too-large';
  return null;
}

/**
 * Telegram numbers the messages of a chat on its servers; TDLib's message ID is that number shifted by 20 bits.
 */
const serverNumberOf = (id: number) => Math.floor(id / 2 ** 20);

/** Deterministic Signal timestamp for a Telegram message so repeat runs deduplicate across Signal's apps. */
export function timestampOf(message: Pick<SavedMessage, 'id' | 'date'>): number {
  return message.date * 1000 + (serverNumberOf(message.id) % 1000);
}

/**
 * The Signal message for a text-only saved message. Its timestamp is computed from the Telegram message alone:
 * Telegram's date in whole seconds, and for the milliseconds the last three digits of Telegram's number of the
 * message. So every run gives the same message the same timestamp, and Signal's apps drop a message that was copied
 * before (signal/note-to-self.ts).
 */
export function noteOf(message: SavedMessage): Note {
  return {
    timestamp: timestampOf(message),
    body: message.body,
    styles: message.styles,
  };
}
