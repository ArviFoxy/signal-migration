# signal-migration: plan

A local desktop app that moves a user's data from Telegram into their Signal
account through a step-by-step wizard. The first migration kind is sticker
packs. More kinds follow later, so the app is built around a migration-kind
boundary from the start.

Research behind this plan: `~/signal/research/telegram-sticker-migration.md`.
UI sketch: https://claude.ai/artifact/D4M5TQLHTrck4RSBj9WbgH

Status of statements: "decided" is the user's choice; "proposed" is a design
choice awaiting review; "prior knowledge" is not yet checked against code or
docs in this project; "spike" marks something a prototype must measure before
the design relies on it.

## Decisions

- Desktop app in Node.js and TypeScript, UI in Lit, modular. (decided)
- Backend in Rust. (decided)
- No Python anywhere, including build and conversion tools. (decided)
- Wizard look: modern, clean, one step per screen. (decided)
- Sticker packs are public data. Index entries store the Signal pack ID in the
  clear. (decided)
- The app contacts three services: Telegram, Signal, and the pack index. (decided)

## Architecture

```
┌──────────────────────────── Electron app (user's machine) ───────────────────────────┐
│ renderer (Lit UI, sandboxed, no Node)                                                 │
│   wizard shell · step views · per-kind views                                          │
│        │ typed IPC (preload, contextBridge)                                           │
│ main process (Node)                                                                   │
│   engine: job queue, scheduler, SQLite state                                          │
│   telegram: MTProto client ─────────────────────────────► Telegram                    │
│   signal-device: linked device (libsignal-client) ──────► Signal chat server + CDN    │
│   kinds/stickers: discovery, source_id, keys, index client ──► pack index (Rust)      │
│   converter sidecar (Rust binary) ◄── stdin/stdout                                    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

The renderer never holds a Telegram session or Signal keys. It runs with
`contextIsolation`, `sandbox` and no Node integration, and talks to the main
process through a small typed IPC surface. (proposed)

## Repository layout

npm workspaces for TypeScript and a Cargo workspace for Rust, in one repo.
(proposed)

```
apps/desktop/            Electron main, preload, window and tray, packaging
packages/ui/             Lit components: wizard shell, step views, shared widgets
packages/engine/         migration-kind interface, job queue, scheduler, SQLite state
packages/telegram/       Telegram client: QR login, sticker sets, downloads, logout
packages/signal-device/  Signal linked device: linking, sticker upload, sync messages
packages/kind-stickers/  sticker-pack migration kind
crates/index-format/     entry layout and key derivation, shared test vectors
crates/index-server/     the pack index backend
crates/convert/          sticker converter, built as a sidecar binary
```

## The migration-kind boundary

Each kind of data (sticker packs now, others later) is one package that plugs
into the engine and the wizard. The wizard's steps are fixed: what to move,
connect the sources a kind needs, the kind's own selection step, connect
Signal, review, migrate, done. A kind contributes:

- which sources it needs (Telegram for sticker packs),
- discovery: read the user's items from the source,
- its selection view and its review summary for the wizard,
- planning: turn selected items into jobs,
- job handlers for the job types it defines.

The interface stays as small as sticker packs need until a second kind exists.
The second kind shows which parts are really shared. (proposed)

## Telegram

- Library: mtcute or gramjs, both TypeScript MTProto clients that run in Node.
  QR login is `auth.exportLoginToken`. (prior knowledge; the spike decides)
- Flow: QR login, `messages.getAllStickers` and `messages.getFavedStickers`,
  `messages.getStickerSet` per set, download every document, `auth.logOut`.
  The session lives only for the downloads.
- The app needs its own `api_id` from my.telegram.org, shipped in the build.
- Originals are cached locally, keyed by set id and set hash. A later run skips
  sets whose hash has not changed. Telegram ids never leave the machine.

## Converter (Rust sidecar)

A Rust command-line binary that the main process runs per sticker. It reads
the original from stdin and writes a file Signal accepts: static WebP passed
through or re-encoded, APNG for animated and video stickers. Each output is at
most 512 px, at most 3 s, at most 300 KB. (proposed)

- TGS: gunzip, render the Lottie animation with rlottie bindings.
- WebM: decode VP9 with libvpx or the FFmpeg libraries.
- APNG: the `png` crate's animation encoder, with a search over frame rate,
  size and palette until the file fits 300 KB.
- Palette reduction: `imagequant` gives the best quality but is GPL-3.0.
  `color_quant` is MIT. The licence decision below settles which.

A sidecar keeps native code out of Electron's Node ABI, and it can be tested on
its own with fixture stickers. Output need not be deterministic, because
`source_id` hashes the Telegram originals, not the converted files.

## Signal linked device

Built on `@signalapp/libsignal-client`, the npm package of libsignal's Node
bridge. Signal-Desktop is the reference implementation for each flow.
(proposed; Signal-Desktop is not cloned yet)

1. Linking: the provisioning WebSocket gives a link URL shown as a QR code. The
   primary phone sends an encrypted provisioning message. The app registers as
   a device with its prekeys, including the Kyber last-resort prekeys.
2. Upload: `GET /v1/sticker/pack/form/{count}` (authenticated) returns the pack
   ID and one signed upload form per file. The app encrypts the manifest and
   each sticker with keys from `pack_key` (HKDF, "Sticker Pack") and posts them
   to the CDN.
3. Install: a `SyncMessage` with `StickerPackOperation` INSTALL, encrypted to
   the user's own other devices, so each pack appears on all of them.
4. Message queue: a linked device receives every incoming message. The app must
   fetch and acknowledge its queue so messages do not pile up on the server. It
   never stores message contents.
5. Unlink at the end, from the app or from the phone.

This module has the most protocol work and the most risk. It is the first spike.

## Sticker-pack kind

From the research note, section 7:

```
source_id  = SHA-256( for each sticker in set order: SHA-256(original bytes) || emoji )
pack_key   = HKDF-SHA256(source_id, info = "signal-migration pack key v1",   32 bytes)
lookup_key = HKDF-SHA256(source_id, info = "signal-migration sticker-pack lookup v1", 32 bytes)
entry      = lookup_key || pack_id                                           (48 bytes)
```

The lookup label names the kind, so a later kind's index cannot collide with
this one. Before installing, the app verifies an entry by fetching the manifest
from the CDN and checking its HMAC with `pack_key`.

Jobs: `download` (Telegram), `convert` (sidecar), `upload` (Signal, rate
limited), `install` (sync message), `index-append`.

## Engine

- A job queue persisted in SQLite, so a migration that takes days survives
  restarts and resumes where it stopped.
- A scheduler that respects Signal's upload limit: a burst of 50, then one per
  72 minutes per account. On a rate-limit response it waits for the
  server-given retry time.
- The app keeps running in the system tray while uploads are queued.

## Pack index backend (Rust)

- axum on tokio. (proposed)
- Storage: one append-only file of 48-byte records. Record number is the
  offset. An in-memory set rejects duplicates. The file can be backed up or
  mirrored as a plain static file.
- `GET /v1/sticker-packs/index?from=<n>` returns records from number `n`.
- `POST /v1/sticker-packs/index` with a 48-byte body appends one record.
- No accounts, no request logging of IP addresses. Appends are limited per IP
  address with in-memory token buckets that are never written to disk.
- Optional spam check: before accepting an entry, confirm the pack ID has a
  manifest on Signal's CDN.
- TLS through a reverse proxy or rustls. Hosting is an open decision.

## Testing

Tests follow the testing guidelines: each one names the failure it catches,
and expectations come from a source outside the implementation. (proposed)

- `index-format`: HKDF checked against the RFC 5869 test vectors. Derivations
  and entry layout checked by agreement between the independent Rust and
  TypeScript implementations on shared vectors.
- Converter: every output from a fixture set of real Telegram stickers meets
  Signal's limits (format, 512 px, 3 s, 300 KB), and each output's frame count
  and duration match the source within a stated tolerance.
- Index server: integration tests over HTTP for append, duplicate rejection,
  range reads and the per-IP limit.
- Engine: the scheduler under a virtual clock, against the documented limit.
- Signal device: an end-to-end run against a real account, only with the
  user's go-ahead each time, because it links a device to that account.

Runtime targets and ceilings for each test command and for the converter are
set once the spikes have measured them. The user sets the numbers.

## Phases

0. **Spikes**, each ending in a measured result:
   1. Telegram: QR login, list installed and favourite sets, download them,
      log out. Measure time and bytes for a real collection. Check whether two
      downloads of the same sticker are byte-identical (research open
      question 1).
   2. Signal: link a device, upload one pack, send an INSTALL sync message,
      see it on the phone. Needs the user's go-ahead.
   3. Converter: 50 real animated and video stickers to APNG within 300 KB.
      Measure quality settings reached and time per sticker.
1. `index-format`, `index-server`, the index client, `source_id` and key
   derivation.
2. Engine: job queue, persistence, scheduler.
3. Signal device module, complete: queue draining, unlink, error handling.
4. Lit wizard, following the sketch.
5. Packaging with electron-builder for Linux, Windows and macOS.

## Open decisions

1. Licence. `@signalapp/libsignal-client` is AGPL-3.0, so the app is
   AGPL-compatible open source. `imagequant` would add GPL-3.0, which AGPL-3.0
   permits.
2. Telegram library: mtcute or gramjs, after the spike.
3. Where the index backend is hosted.
4. Code signing for macOS and Windows builds. Unsigned builds show OS warnings.
