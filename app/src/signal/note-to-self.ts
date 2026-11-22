// A message in Note to Self, Signal's conversation with oneself.
//
// A device writes into Note to Self by sending the message to the account's other devices only, as a "sent
// transcript": the sync message with which a device tells the others what it sent (SyncMessage.Sent), here with the
// account itself as the recipient. Signal Desktop does the same (sendSyncMessageOnly).
//
// Signal's apps identify a message by its sender and its timestamp. They show the timestamp as the message's date,
// and they drop a transcript whose sender and timestamp match a message they have (Signal-Desktop
// handleDataMessage, Signal-Android's unique index on date_sent, from and thread in MessageTable,
// Signal-iOS SentMessageTranscriptReceiverImpl). So the same note sent twice with the same timestamp appears once.
//
// A note carries no timer for disappearing messages. A message with a timer and an old timestamp would be deleted
// at once.

import { create, toBinary } from '@bufbuild/protobuf';
import {
  AttachmentPointer_Flags,
  AttachmentPointerSchema,
  BodyRange_Style,
  ContentSchema,
} from '../gen/SignalService_pb';
import { randomBytes } from '../core/random';
import type { UploadedAttachment } from './attachment';
import { syncPadding } from './own-devices';

export { AttachmentPointer_Flags };

export type TextStyle = 'bold' | 'italic' | 'spoiler' | 'strikethrough' | 'monospace';

/** A style on a part of the body; `start` and `length` count UTF-16 code units, as Signal's apps do. */
export type StyledRange = { start: number; length: number; style: TextStyle };

export type Note = {
  /** The date of the message in milliseconds since 1970. Together with the account, it identifies the message. */
  timestamp: number;
  body: string;
  styles: StyledRange[];
  /** Uploaded attachments for this message (photos, videos, files, voice notes, long-text attachment). */
  attachments?: UploadedAttachment[];
};

/**
 * The longest inline body a message carries, in bytes of UTF-8. Signal's apps refuse a message with a longer one
 * (Signal-Desktop MAX_MESSAGE_BODY_BYTE_LENGTH, Signal-Android MAX_INLINE_BODY_SIZE_BYTES); longer text travels as a
 * `text/x-signal-plain` attachment with a trimmed inline body.
 */
export const MAX_BODY_BYTES = 2048;
/** MIME type Signal uses for the full body of a message longer than `MAX_BODY_BYTES`. */
export const LONG_TEXT_CONTENT_TYPE = 'text/x-signal-plain';

const textEncoder = new TextEncoder();

export const bodyFits = (body: string): boolean => textEncoder.encode(body).length <= MAX_BODY_BYTES;

/**
 * Trims `body` to at most `maxBytes` of UTF-8 without splitting a Unicode code point or UTF-16 surrogate pair
 * (matching Signal-Desktop `longAttachment.std.ts`).
 */
export function trimBody(body: string, maxBytes = MAX_BODY_BYTES): string {
  if (textEncoder.encode(body).length <= maxBytes) return body;
  let bytes = 0;
  let end = 0;
  for (const char of body) {
    const charBytes = textEncoder.encode(char).length;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return end > 0 ? body.slice(0, end) : '\uFFFE';
}

const STYLE: Record<TextStyle, BodyRange_Style> = {
  bold: BodyRange_Style.BOLD,
  italic: BodyRange_Style.ITALIC,
  spoiler: BodyRange_Style.SPOILER,
  strikethrough: BodyRange_Style.STRIKETHROUGH,
  monospace: BodyRange_Style.MONOSPACE,
};

function pointerOf(attachment: UploadedAttachment) {
  return create(AttachmentPointerSchema, {
    attachmentIdentifier: { case: 'cdnKey', value: attachment.cdnKey },
    cdnNumber: attachment.cdnNumber,
    clientUuid: randomBytes(16),
    contentType: attachment.contentType,
    key: attachment.key,
    size: attachment.size,
    digest: attachment.digest,
    uploadTimestamp: BigInt(attachment.uploadTimestamp),
    ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
    ...(attachment.width ? { width: attachment.width } : {}),
    ...(attachment.height ? { height: attachment.height } : {}),
    ...(attachment.flags ? { flags: attachment.flags } : {}),
    ...(attachment.caption ? { caption: attachment.caption } : {}),
    ...(attachment.audioDurationSeconds ? { audioDurationSeconds: attachment.audioDurationSeconds } : {}),
  });
}

/** The sync message, as a serialized Content, that puts `note` into the Note to Self of the account `ownAci`. */
export function noteToSelfMessage(ownAci: string, note: Note): Uint8Array {
  if (!bodyFits(note.body)) throw new Error(`a message body may have at most ${MAX_BODY_BYTES} bytes`);
  const timestamp = BigInt(note.timestamp);
  const attachments = (note.attachments ?? []).map(pointerOf);
  return toBinary(
    ContentSchema,
    create(ContentSchema, {
      content: {
        case: 'syncMessage',
        value: {
          content: {
            case: 'sent',
            value: {
              destinationServiceId: ownAci,
              timestamp,
              message: {
                ...(note.body !== '' ? { body: note.body } : {}),
                timestamp,
                attachments,
                bodyRanges: note.styles.map(({ start, length, style }) => ({
                  start,
                  length,
                  associatedValue: { case: 'style' as const, value: STYLE[style] },
                })),
              },
            },
          },
          padding: syncPadding(),
        },
      },
    }),
  );
}
