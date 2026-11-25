// Which saved messages are copied, and copying them (text, long text, media, files, stickers, and albums) into
// Signal's Note to Self.
//
// Signal's apps list a conversation in the order in which its messages arrived. So the messages are sent oldest
// first, one after the other, and what is copied is everything from a date on: a later run can add newer messages
// behind the copied ones, but older messages added later would stand behind newer ones.

import {
  attachmentFits,
  type AttachmentMetadata,
  AttachmentTooLargeError,
  bytesSource,
  MAX_ATTACHMENTS_PER_MESSAGE,
  uploadAttachment,
  type UploadedAttachment,
} from '../../signal/attachment';
import {
  AttachmentPointer_Flags,
  bodyFits,
  LONG_TEXT_CONTENT_TYPE,
  type Note,
  trimBody,
} from '../../signal/note-to-self';
import type { SignalAccount } from '../../signal/transport';
import { ConversionError, type ConvertSticker } from '../stickers/convert';
import { reasonLeftOut, type SavedMedia, type SavedMessage, timestampOf } from './messages';
import type { SavedSource } from './telegram-saved';

/** The messages copied when the user chose to copy from `from` on (seconds since 1970); all when null. */
export function messagesToCopy(messages: readonly SavedMessage[], from: number | null): SavedMessage[] {
  return messages.filter((message) => (from === null || message.date >= from) && reasonLeftOut(message) === null);
}

/** Of `messages`, those sent after the message `sentUpTo`, which is the last one a run has sent; all when null. */
export const notYetSent = (messages: readonly SavedMessage[], sentUpTo: number | null): SavedMessage[] =>
  sentUpTo === null ? [...messages] : messages.filter((message) => message.id > sentUpTo);

export type LeftOut = { tooLarge: number; other: number };

/** How many messages from `from` on are not copied, by the reason. */
export function leftOutFrom(messages: readonly SavedMessage[], from: number | null): LeftOut {
  const count: LeftOut = { tooLarge: 0, other: 0 };
  for (const message of messages) {
    if (from !== null && message.date < from) continue;
    const reason = reasonLeftOut(message);
    if (reason === 'too-large') count.tooLarge++;
    else if (reason === 'other') count.other++;
  }
  return count;
}

/** Count and total known byte size of copyable messages that carry media from `from` on. */
export function mediaSummaryFrom(
  messages: readonly SavedMessage[],
  from: number | null,
): { withMedia: number; mediaBytes: number } {
  let withMedia = 0;
  let mediaBytes = 0;
  for (const message of messages) {
    if (from !== null && message.date < from) continue;
    if (reasonLeftOut(message) !== null || !message.media) continue;
    withMedia++;
    mediaBytes += message.media.size;
  }
  return { withMedia, mediaBytes };
}

/** One Signal Note to Self message, either a single Telegram message or a grouped Telegram media album. */
export type SavedGroup = {
  /** Telegram messages merged into this Signal message, oldest first. */
  messages: SavedMessage[];
  /** Largest Telegram message ID in the group, recorded in `savedSentUpTo` once sent. */
  lastId: number;
};

/**
 * Groups consecutive copyable messages sharing the same non-empty Telegram `media_album_id` into one Signal message
 * (up to Signal's limit of 32 attachments per message, reserving a slot if the album has a long caption).
 */
export function groupSavedMessages(messages: readonly SavedMessage[]): SavedGroup[] {
  const groups: SavedGroup[] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    const prevFirst = previous?.messages[0];
    const sameAlbum =
      Boolean(message.albumId) &&
      Boolean(message.media) &&
      Boolean(prevFirst?.media) &&
      prevFirst?.albumId === message.albumId &&
      // Keep room for a long-text attachment if any item in the album has a body > 2048 bytes.
      previous!.messages.length < MAX_ATTACHMENTS_PER_MESSAGE - 1;
    if (sameAlbum) {
      previous!.messages.push(message);
      previous!.lastId = message.id;
    } else {
      groups.push({ messages: [message], lastId: message.id });
    }
  }
  return groups;
}

const textEncoder = new TextEncoder();

function flagsOf(media: SavedMedia): number | undefined {
  let flags = 0;
  if (media.voiceNote) flags |= AttachmentPointer_Flags.VOICE_MESSAGE;
  if (media.borderless) flags |= AttachmentPointer_Flags.BORDERLESS;
  if (media.gif) flags |= AttachmentPointer_Flags.GIF;
  return flags || undefined;
}

function metadataOf(media: SavedMedia, caption?: string): AttachmentMetadata {
  return {
    contentType: media.contentType,
    fileName: media.fileName,
    width: media.width,
    height: media.height,
    flags: flagsOf(media),
    caption: caption || undefined,
    audioDurationSeconds: media.duration,
  };
}

async function readAllBytes(
  readChunks: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
  size: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let offset = 0;
  await readChunks(async (chunk) => {
    out.set(chunk, offset);
    offset += chunk.length;
  });
  return offset === size ? out : out.subarray(0, offset);
}

/** Active rate-limit or throttle pause during Saved Messages migration (`until` is ms since 1970, or null if unknown). */
export type SavedWait = {
  service: 'Signal' | 'Telegram';
  until: number | null;
};

async function uploadSavedMedia(
  account: Pick<SignalAccount, 'withChat' | 'https'>,
  source: SavedSource,
  messageId: number,
  media: SavedMedia,
  caption: string | undefined,
  convert: ConvertSticker | undefined,
  cancel: AbortSignal,
  onWait?: (wait: SavedWait | null) => void,
): Promise<UploadedAttachment> {
  if (!source.withMedia) {
    throw new Error('reading Telegram media files is not available in this session');
  }
  const signalWait = onWait
    ? (until: number | null) => onWait(until === null ? null : { service: 'Signal', until })
    : undefined;
  const telegramWait = onWait
    ? (until: number | null) => onWait(until === null ? null : { service: 'Telegram', until })
    : undefined;
  const telegramWaiting = onWait
    ? (waiting: boolean) => onWait(waiting ? { service: 'Telegram', until: null } : null)
    : undefined;
  return source.withMedia(
    media,
    async (size, readChunks) => {
      cancel.throwIfAborted();
      if (!attachmentFits(size)) throw new AttachmentTooLargeError(size);
      if (media.stickerFormat && media.stickerFormat !== 'webp' && convert) {
        const raw = await readAllBytes(readChunks, size);
        const converted = await convert(raw, media.stickerFormat);
        const convertedSize = converted.animation?.size;
        return uploadAttachment(
          account,
          bytesSource(converted.image),
          {
            contentType: 'image/png',
            width: convertedSize ?? media.width,
            height: convertedSize ?? media.height,
            flags: AttachmentPointer_Flags.BORDERLESS,
            caption: caption || undefined,
          },
          cancel,
          undefined,
          signalWait,
        );
      }
      return uploadAttachment(account, { size, readChunks }, metadataOf(media, caption), cancel, undefined, signalWait);
    },
    cancel,
    { messageId, onWait: telegramWait, onWaiting: telegramWaiting },
  );
}

export type CopyOptions = {
  source?: SavedSource;
  convert?: ConvertSticker;
  /** Called when a group is permanently uncopyable (oversized unknown-size file or unconvertible sticker) and skipped. */
  onSkipped?: (group: SavedGroup, error: Error) => void;
  /** Called when copying pauses for a Signal or Telegram rate limit, and with null once copying resumes. */
  onWait?: (wait: SavedWait | null) => void;
};

/**
 * Sends `messages` to Note to Self in their order, grouping Telegram albums, uploading any media and long-text
 * attachments to Signal's CDN, and sending each message with its deterministic timestamp. `onSent` gets the Telegram
 * ID of the last message in each group once Signal has accepted it (or once a permanently uncopyable group is
 * skipped so later messages are not wedged). Stops between messages when `cancel` fires.
 */
export async function copyToNoteToSelf(
  account: Pick<SignalAccount, 'withChat' | 'https' | 'sendNoteToSelf'>,
  messages: readonly SavedMessage[],
  onSent: (id: number, immediate?: boolean) => void,
  cancel: AbortSignal,
  options: CopyOptions = {},
): Promise<void> {
  const signalWait = options.onWait
    ? (until: number | null) => options.onWait!(until === null ? null : { service: 'Signal', until })
    : undefined;
  for (const group of groupSavedMessages(messages)) {
    if (cancel.aborted) return;
    const first = group.messages[0];
    // The first non-empty caption/text in an album becomes the message body; any later captions stay on their item.
    const bodyOwner = group.messages.find((item) => item.body !== '') ?? first;
    const fullBody = bodyOwner.body;
    const styles = bodyOwner.styles;

    const attachments: UploadedAttachment[] = [];
    let body = fullBody;

    try {
      if (fullBody !== '' && !bodyFits(fullBody)) {
        const textBytes = textEncoder.encode(fullBody);
        attachments.push(
          await uploadAttachment(
            account,
            bytesSource(textBytes),
            { contentType: LONG_TEXT_CONTENT_TYPE },
            cancel,
            undefined,
            signalWait,
          ),
        );
        body = trimBody(fullBody);
      }

      for (const item of group.messages) {
        if (!item.media) continue;
        const itemCaption = item !== bodyOwner && item.body !== '' ? item.body : undefined;
        attachments.push(
          await uploadSavedMedia(
            account,
            options.source!,
            item.id,
            item.media,
            itemCaption,
            options.convert,
            cancel,
            options.onWait,
          ),
        );
      }
    } catch (error) {
      if (cancel.aborted) return;
      if (error instanceof AttachmentTooLargeError || error instanceof ConversionError) {
        options.onSkipped?.(group, error);
        onSent(group.lastId, true);
        continue;
      }
      throw error;
    }

    if (cancel.aborted) return;
    const note: Note = {
      timestamp: timestampOf(first),
      body,
      styles,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    try {
      await account.sendNoteToSelf(note, { cancel, onWait: signalWait });
    } catch (error) {
      if (cancel.aborted) return;
      throw error;
    }
    onSent(group.lastId, attachments.length > 0);
  }
}
