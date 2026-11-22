# Sketch: migrating Saved Messages

This is a feasibility sketch for one possible feature. It is not a design. Telegram has a chat with oneself,
called Saved Messages. The app would copy its messages into Signal's equivalent, called Note to Self.

The sketch says what Telegram and Signal allow, what the feature would look like, what it would cost, and what is
still unknown. The facts come from reading TDLib's source (`third_party/td`), the sources of Signal's clients and
server, and this repository. Nothing here has been run against the real Telegram or Signal. Section 8 lists what
must be tried first.

## 1. The main findings

1. **The app needs one new ability: sending messages with attachments to Note to Self.** The app can already
   encrypt and send a message to the user's other devices. It cannot yet build a chat message or upload an
   attachment.
2. **Imported messages can keep their original dates, but not their place among existing messages.** Signal's
   server accepts any past date. Signal Desktop and Signal for Android show that date on the message. Both list a
   conversation in the order in which the messages arrived, so the app must send the oldest message first, and
   all imported messages appear after whatever Note to Self already holds.
3. **The app cannot read Note to Self.** A newly linked device receives no earlier messages. The migration can
   still be repeated without making duplicates, because Signal's apps drop a message that they already have
   (section 5).
4. **Signal cannot import messages in bulk.** Its backup files are read only when a device is registered or
   linked. Sending the messages one by one is the only way.

## 2. What Telegram provides

TDLib reads the history of a chat with `getChatHistory`, at most 100 messages per request, newest first. Each
message has:

- a date, and an edit date if it was edited;
- its content: text with formatting, a photo, a video, a GIF, an audio file, a voice note, a round video message,
  a file, a sticker, a location, a contact, a poll, and several rarer kinds;
- where it was forwarded from, if it was forwarded;
- the message it replies to;
- an album number that groups the photos and videos which were sent together.

Two kinds of message cannot be copied: media that was set to delete itself and has expired, and messages of a
kind that TDLib does not know.

Telegram also has _protected content_. The owner of a group or channel can switch on "Restrict saving content",
and a bot can send a message as protected. Telegram's apps then refuse to forward, save or copy these messages,
and TDLib marks them as not to be saved. A message that cannot be forwarded cannot be forwarded into Saved
Messages either, so we expect no protected message there. The app would still check the mark and leave such a
message out.

Telegram allows files of up to 2 GB, or 4 GB with Telegram Premium. A file in Saved Messages can be that large.

## 3. What Signal allows a linked device to do

**Sending to Note to Self.** Signal Desktop writes a Note to Self message by sending it only to the account's
other devices. The message is a _sent transcript_: the message that a device sends to the user's other devices
to tell them what it sent. Its recipient is the user's own account. The app would do the same. The server
applies no per-message rate limit on this path. It limits the bytes sent to about 2 MB per second after a first
128 MiB.

**Dates and order.**

| Question                               | Signal Desktop                  | Signal for Android      |
| -------------------------------------- | ------------------------------- | ----------------------- |
| Which date does the message show?      | The date the sender set         | The date the sender set |
| In which order are messages listed?    | The order in which they arrived | The order of arrival    |
| Which date do the day separators show? | The day of the import           | Not checked             |

Signal for iOS was not read.

**Attachments.** A device encrypts the file, asks Signal's server for an upload address, and uploads the
encrypted file to one of Signal's content servers (`cdn2.signal.org` or `cdn3.signal.org`). The relay of the
migration server already allows both hosts. The limits are:

- 100 MiB per file by default. Signal's servers can change this number.
- 32 attachments per message.
- 50 uploads at once, then one upload every 1.2 seconds.
- 1 GiB of uploads at once, then about 1 MB per second.

**Text.** A message body holds at most 2 KiB. Longer text goes into a text attachment of at most 64 KiB, which
Signal's apps show as a long message. Signal has five text styles: bold, italic, strikethrough, monospace and
spoiler.

**Disappearing messages.** A message that carries no timer switches off the timer of the conversation it arrives
in. If the user has set a timer on Note to Self, the import would switch it off. A message that carries a timer
and an old date would be deleted at once.

## 4. How each kind of content would be copied

| In Telegram                          | In Signal                                                               |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Text                                 | Text. Long text becomes a long message.                                 |
| Bold, italic, strikethrough, spoiler | The same style                                                          |
| Code                                 | Monospace                                                               |
| Underline, block quote               | No equivalent. The text stays, the style is lost.                       |
| A link behind a word                 | The address is written after the word.                                  |
| Photo, video, audio file, file       | An attachment of the same kind                                          |
| Album of photos and videos           | One message with several attachments                                    |
| GIF                                  | A video attachment that Signal's apps play as a GIF                     |
| Voice note                           | A voice note, if Signal's apps play Telegram's audio format (not known) |
| Round video message                  | An ordinary video                                                       |
| Sticker                              | An image. Animated stickers need the app's existing conversion.         |
| Location, contact, poll              | Text that describes it. Signal's own forms of these can come later.     |
| Forwarded message                    | The message itself. Where it was forwarded from is not copied.          |
| Reply to another saved message       | A Signal quote of the copied message                                    |
| Expired, unknown or protected        | Not copied. The app counts them and tells the user.                     |

Signal has no field for where a message was forwarded from. Writing the name of the original sender into the
text would put another person's name into the user's Signal, so the origin is left out.

Telegram's list of saved GIFs is not migrated. Signal has no list of saved GIFs, and Note to Self is not a place
for them.

## 5. Repeating the migration without duplicates

The migration must be safe to repeat: after an interruption, and when the user runs it again weeks later. The app
cannot compare with what Note to Self holds, because it cannot read Note to Self. Signal's apps do the comparison
instead.

Signal identifies a message by its sender and its date in milliseconds. Signal Desktop drops a sent transcript
whose sender and date match a message that it has, and Signal for Android has a database rule that refuses a
second message with the same date, sender and conversation. Signal for iOS was not checked.

The app therefore computes the date of each copied message from the Telegram message alone: Telegram's date in
seconds, and for the milliseconds a number computed from Telegram's message ID. Every run then gives the same
message the same date, and a message that was copied before is dropped by the devices that have it.

Two consequences:

- A message that the user edits in Telegram after it was copied is not copied again.
- The devices drop a repeated message only after it was sent. Without knowing what was copied, a second run
  would upload every attachment again. Within one visit the saved progress holds the Telegram ID of the last
  message sent. Across visits, the app needs another way to know where the last run ended; this is open.

## 6. What the user chooses

The app first reads the whole list of messages from Telegram, without any files. This takes one request per 100
messages. The app then knows, for every date, how many messages and how many bytes lie after it.

Whether the user chooses a cutoff date, and how the screen shows it, is not designed. One idea is a timeline of
the chat with a movable cutoff, which shows the number of messages and the estimated time for the part that
would be copied. Three facts constrain the design:

- Messages are listed in the order of arrival. A later run can add newer messages after the copied ones. A
  later run with an earlier cutoff would put older messages after newer ones.
- The time is decided by the media. Text is fast: several messages per second. Media is bound by Signal's upload
  limit of about 1 MB per second after the first gibibyte, so 10 GB of media take about two and a half hours
  beyond the first gibibyte.
- Files above Signal's limit of 100 MiB cannot be copied whatever the user chooses.

## 7. What has to be built

1. Building a chat message and its sent transcript. The message definitions are already generated in the app.
   Sending it reuses the code that sends to the user's own devices.
2. Encrypting an attachment in Signal's attachment format. This is new code in the Rust module, next to the
   sticker encryption.
3. Asking for an upload address and uploading to `cdn2` or `cdn3`. The two servers use different upload
   protocols. The sticker upload is a simpler third one and cannot be reused.
4. Reading a Telegram file and uploading it in parts. The app reads a file into memory in one piece today, which
   is fine for stickers and not for a video of 80 MiB. TDLib has a request for reading a part of a file
   (`readFilePart`).
5. Reading the history and applying the table of section 4.
6. The usual parts of a new kind of data: state, steps, saved progress, start page, selection, review and
   migration screens, fixtures, tests. The friends feature is the template. The simulated Signal of the tests
   needs attachments and received messages.

A reasonable order is: one text message to Note to Self, checked on a phone; then all text messages; then
attachments on small files; then large files.

All media bytes pass through the relay of the migration server. The server can carry this load.

## 8. Not known yet

To try before any design:

1. That a phone shows a sent transcript from the app as a normal Note to Self message, with the original date.
   Signal Desktop works this way, so this is likely.
2. How Signal for iOS dates and orders such messages, whether it drops a repeated message, and what Android's
   day separators show.
3. That a message sent twice appears once, on a phone and on Signal Desktop.
4. Whether the import can leave a timer on Note to Self as it was.
5. Whether Signal's apps play Telegram's voice notes (Opus audio in an Ogg file).
6. Whether one request reads all of Saved Messages, or whether its topics must be read one by one. Telegram can
   divide Saved Messages into topics by the chat a message was forwarded from.
7. How much memory the browser build of TDLib needs for a large file.
8. What Signal's spam check does with several thousand messages to oneself. Its rules are not public.

## 9. Open decisions

- The cutoff and its screen (section 6).
- How a later run knows where the last run ended (section 5).
- What the app does with files above 100 MiB: skip and list them, or stop and ask.
