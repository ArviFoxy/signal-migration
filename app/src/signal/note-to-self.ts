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
import { BodyRange_Style, ContentSchema } from '../gen/SignalService_pb';
import { syncPadding } from './own-devices';

export type TextStyle = 'bold' | 'italic' | 'spoiler' | 'strikethrough' | 'monospace';

/** A style on a part of the body; `start` and `length` count UTF-16 code units, as Signal's apps do. */
export type StyledRange = { start: number; length: number; style: TextStyle };

export type Note = {
  /** The date of the message in milliseconds since 1970. Together with the account, it identifies the message. */
  timestamp: number;
  body: string;
  styles: StyledRange[];
};

/**
 * The longest body a message carries, in bytes of UTF-8. Signal's apps refuse a message with a longer one
 * (Signal-Desktop MAX_MESSAGE_BODY_BYTE_LENGTH, Signal-Android MAX_INLINE_BODY_SIZE_BYTES); longer text travels as an
 * attachment.
 */
export const MAX_BODY_BYTES = 2048;

export const bodyFits = (body: string): boolean => new TextEncoder().encode(body).length <= MAX_BODY_BYTES;

const STYLE: Record<TextStyle, BodyRange_Style> = {
  bold: BodyRange_Style.BOLD,
  italic: BodyRange_Style.ITALIC,
  spoiler: BodyRange_Style.SPOILER,
  strikethrough: BodyRange_Style.STRIKETHROUGH,
  monospace: BodyRange_Style.MONOSPACE,
};

/** The sync message, as a serialized Content, that puts `note` into the Note to Self of the account `ownAci`. */
export function noteToSelfMessage(ownAci: string, note: Note): Uint8Array {
  if (!bodyFits(note.body)) throw new Error(`a message body may have at most ${MAX_BODY_BYTES} bytes`);
  const timestamp = BigInt(note.timestamp);
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
                body: note.body,
                timestamp,
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
