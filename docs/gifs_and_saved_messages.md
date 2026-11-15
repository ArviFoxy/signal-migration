# Sketch: migrating saved GIFs and Saved Messages

This is a feasibility sketch for two possible features. It is not a design. It says what Telegram and Signal allow,
what each feature would look like, what it would cost, and what is still unknown. The facts come from reading
TDLib's source (`third_party/td`), the sources of Signal's clients and server, and this repository. Nothing here
has been run against the real Telegram or Signal. Section 7 lists what must be tried first.

The two features are:

- **Saved GIFs.** Telegram keeps a list of GIFs that the user saved. The app would copy them to Signal.
- **Saved Messages.** Telegram has a chat with oneself, called Saved Messages. The app would copy its messages
  into Signal's equivalent, called Note to Self.

## 1. The main findings

1. **Signal has no list of saved GIFs.** Signal syncs favourite stickers between devices and nothing comparable
   for GIFs. A GIF in Signal is a Giphy search result that is sent as a message. The only place where migrated
   GIFs can live is a conversation, and Note to Self is the natural one.
2. **Both features therefore need the same new ability: sending messages with attachments to Note to Self.** The
   app can already encrypt and send a message to the user's other devices. It cannot yet build a chat message or
   upload an attachment.
3. **Imported messages can keep their original dates, but not their place among existing messages.** Signal's
   server accepts any past date. Signal Desktop and Signal for Android show that date on the message. Both list a
   conversation in the order in which the messages arrived, so the app must send the oldest message first, and
   all imported messages appear after whatever Note to Self already holds.
4. **Signal cannot import messages in bulk.** Its backup files are read only when a device is registered or
   linked. Sending the messages one by one is the only way.

## 2. What Telegram provides

**Saved GIFs.** TDLib's request `getSavedAnimations` returns the whole list. An account can hold 200 saved GIFs,
or 400 with Telegram Premium; Telegram's servers set these numbers. Only MP4 videos can be saved to the list, so
every entry is a short MP4 video. Each entry has a width, a height, a duration and a file that the app can
download as it downloads sticker files today.

**Saved Messages.** TDLib reads the history of a chat with `getChatHistory`, at most 100 messages per request,
newest first. Each message has:

- a date, and an edit date if it was edited;
- its content: text with formatting, a photo, a video, a GIF, an audio file, a voice note, a round video message,
  a file, a sticker, a location, a contact, a poll, and several rarer kinds;
- where it was forwarded from, if it was forwarded: a user, a chat or a channel, with the original date. Telegram
  gives only a name when the original sender hides their account;
- the message it replies to;
- an album number that groups the photos and videos which were sent together.

Three kinds of message cannot be copied: media that was set to delete itself and has expired, messages of a kind
that TDLib does not know, and messages whose content Telegram marks as protected from saving.

Telegram allows files of up to 2 GB, or 4 GB with Premium. A file in Saved Messages can be that large.

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

**GIFs.** Signal's apps treat an MP4 attachment as a GIF when the message marks it as one. They then play it in
a loop without sound. Telegram's saved GIFs are already MP4 videos, so the app can pass the files through
unchanged.

**Disappearing messages.** A message that carries no timer switches off the timer of the conversation it arrives
in. If the user has set a timer on Note to Self, the import would switch it off. A message that carries a timer
and an old date would be deleted at once.

## 4. Saved GIFs

**What the user gets.** Each chosen GIF becomes one message in Note to Self that plays as a GIF. To use a GIF,
the user opens Note to Self and forwards it. Signal has no GIF panel that the app could fill.

**Flow.** A new choice on the start page, "Saved GIFs". A step that shows the GIFs as a grid, where the user
selects which to copy. The migration downloads each file from Telegram, encrypts it, uploads it and sends the
message.

**Cost.** At most 400 files. The upload limit allows 50 at once and 50 per minute after that, so 400 GIFs take
about 7 minutes.

**The weak point.** Up to 400 single messages in Note to Self are not a GIF collection. They are a long list that
the user has to scroll. This is the best that Signal allows. Whether it is worth building is a product decision.

## 5. Saved Messages

**What the user gets.** The messages of Saved Messages appear in Note to Self, oldest first, each with its
original date, after the messages that Note to Self already holds.

**How each kind of content would be copied.**

| In Telegram                          | In Signal                                                               |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Text                                 | Text. Long text becomes a long message.                                 |
| Bold, italic, strikethrough, spoiler | The same style                                                          |
| Code                                 | Monospace                                                               |
| Underline, block quote               | No equivalent. The text stays, the style is lost.                       |
| A link behind a word                 | The address is written after the word.                                  |
| Photo, video, audio file, file       | An attachment of the same kind                                          |
| Album of photos and videos           | One message with several attachments                                    |
| GIF                                  | An MP4 attachment marked as a GIF                                       |
| Voice note                           | A voice note, if Signal's apps play Telegram's audio format (not known) |
| Round video message                  | An ordinary video                                                       |
| Sticker                              | An image. Animated stickers need the app's existing conversion.         |
| Location, contact, poll              | Text that describes it. Signal's own forms of these can come later.     |
| Forwarded message                    | A first line in the text: who it was forwarded from, and when           |
| Reply to another saved message       | A Signal quote of the copied message                                    |
| Expired, unknown or protected        | Not copied. The app counts them and tells the user.                     |

**Order and resuming.** The app first reads the whole list of messages from Telegram, without any files. This
gives the count and the total size, which the app shows before the user starts. It then sends from the oldest to
the newest. The saved progress needs only one number: the Telegram ID of the last message that was sent.

**Dates.** Telegram's dates are in whole seconds, and Signal identifies a message by its date in milliseconds.
The app gives every message a different millisecond within its second.

**Large files.** The app reads a Telegram file into memory in one piece today, and it uploads in one piece. That
is fine for stickers and GIFs and not for a video of 80 MiB. Saved Messages needs reading and uploading in
parts. TDLib has a request for reading a part of a file (`readFilePart`). Files above Signal's limit of 100 MiB
cannot be copied; the app lists them.

**Cost.** Text is fast: several messages per second. Media is bound by Signal's upload limit of about 1 MB per
second after the first gibibyte. A Saved Messages chat with 10 GB of media takes about two and a half hours
beyond the first gibibyte. All of these bytes pass through the relay of the migration server, which the sticker
and friend features never loaded like this.

## 6. What has to be built

Shared by both features:

1. Building a chat message and its sent transcript. The message definitions are already generated in the app.
   Sending it reuses the code that sends to the user's own devices.
2. Encrypting an attachment in Signal's attachment format. This is new code in the Rust module, next to the
   sticker encryption.
3. Asking for an upload address and uploading to `cdn2` or `cdn3`. The two servers use different upload
   protocols. The sticker upload is a simpler third one and cannot be reused.
4. The simulated Signal of the tests needs attachments and received messages.

For GIFs: reading the list, a selection step, and the usual parts of a new kind of data (state, steps, saved
progress, start page, review and migration screens, fixtures, tests). The friends feature is the template.

For Saved Messages, in addition: reading the history, the table of section 5, reading and uploading large files
in parts, and a selection step.

A reasonable order is: one text message to Note to Self, checked on a phone; then attachments; then GIFs, which
exercise everything shared on small files; then Saved Messages as text; then its media; then large files.

## 7. Not known yet

To try before any design:

1. That a phone shows a sent transcript from the app as a normal Note to Self message, with the original date.
   Signal Desktop works this way, so this is likely.
2. How Signal for iOS dates and orders such messages, and what Android's day separators show.
3. That sending the same message again after an interruption does not show it twice.
4. Whether the import can leave a timer on Note to Self as it was.
5. Whether Signal's apps play Telegram's voice notes (Opus audio in an Ogg file).
6. Whether one request reads all of Saved Messages, or whether its topics must be read one by one. Telegram can
   divide Saved Messages into topics by the chat a message was forwarded from.
7. How large saved GIFs are in practice, and how much memory the browser build of TDLib needs for a large file.
8. What Signal's spam check does with several thousand messages to oneself. Its rules are not public.

## 8. Decisions for the product

- Whether saved GIFs as up to 400 messages in Note to Self are worth having.
- Whether Saved Messages is copied whole, or the user selects by date, by kind of content, or by size.
- What the app does with files above 100 MiB: skip and list them, or stop and ask.
- Whether a forwarded message names the person it came from. That name is another person's data, and it would
  be written into the user's Signal.
- Whether the migration server can carry several gigabytes per user through its relay.
