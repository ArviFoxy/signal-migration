# Telegram to Signal Migration 🔒🦊

A web app that moves Telegram data into a Signal account: sticker packs, and the user's Telegram friends who are on
Signal, as Signal contacts. All the work happens in the browser. The server serves the app, passes encrypted traffic
on to Signal, and keeps a shared list of packs already uploaded.

## Parts

| Part | What it is |
| --- | --- |
| `app/` | The web app: TypeScript and Lit. |
| `crates/signal-wasm/` | libsignal and rustls compiled to WebAssembly: device linking, prekeys, sessions, account keys, sticker and storage encryption, and the TLS connection to Signal. |
| `crates/attestation-wasm/` | libsignal's check of an enclave's attestation, and the encrypted exchange with Signal's contact discovery, compiled to WebAssembly. libsignal does the check's certificate and signature work with BoringSSL, a C library, which `scripts/build-boringssl-wasm.sh` builds for WebAssembly. |
| `crates/server/` | The server, in Rust: static files, the relay to Signal, the sticker pack index. |
| `third_party/td` | TDLib, Telegram's library, compiled to WebAssembly by `scripts/build-tdweb.sh`, with one patch (`scripts/tdweb/`). |
| `app/src/kinds/stickers/webm-decoder.c` | The decoder for video stickers: FFmpeg's WebM reader and libvpx's VP9 decoder, compiled to WebAssembly by `scripts/build-webm-decoder.sh`. |

## Connections

```
browser ──── WebSocket, MTProto ─────────────────────────────▶ Telegram (*.web.telegram.org)
browser ──── WebSocket ──▶ server ──── TCP ─────────────────▶ Signal (chat, storage, cdn, cdsi hosts)
             └──────────── TLS between the browser and Signal ───┘
browser ──── HTTPS ──────▶ server (app files, sticker pack index)
browser ──── HTTPS ──────────────────────────────────────────▶ Signal's public CDN (cdn-ca.signal.org)
             server ──── HTTPS ─────────────────────────────▶ Signal's public CDN (cdn-ca.signal.org)
```

Telegram is reached directly. Signal is not, because Signal's servers use certificates from Signal's own
certificate authority, which browsers do not trust. The browser therefore opens a WebSocket to the server
(`/tunnel/{host}`), which connects to that host if it is on its list (`chat`, `storage`, `cdn`, `cdn2`, `cdn3`,
`cdsi` `.signal.org`) and copies bytes both ways. Inside, the browser runs its own TLS session with Signal, accepting
only Signal's root certificates (the ones libsignal ships). The server connects to `cdsi.signal.org`, Signal's contact
discovery, only for a user who looks for friends.

Signal's public CDN has a certificate that browsers trust and serves the encrypted files of every sticker pack to
anyone. The browser reads from it the copies of a pack that others uploaded. The server asks it whether a pack
exists before listing the pack in the index.

## What the server sees

- **Relay:** encrypted bytes, which Signal host they go to, and when.
- **Index:** for each uploaded pack, a 32-byte lookup key and the 16-byte Signal pack ID. Client addresses are used
  for rate limits, in memory only, and are not logged. For a new entry, the server requests the headers of the
  pack's manifest from Signal's public CDN, to learn whether Signal has the pack. It downloads no file of a pack.
- **Nothing else:** no Telegram traffic, no Signal credentials, no pack keys, no stickers, no phone numbers and no
  names of people.

## Pack keys and the index

Each pack has two values, computed in the browser (`app/src/kinds/stickers/identity.ts`):

- **Lookup key** = HKDF-SHA256(SHA-256(identity), `signal-migration sticker-pack lookup v1`). The identity is the
  pack's title and each sticker's Telegram file ID and emoji, in order. It is known before anything is downloaded.
- **Pack key** = HKDF-SHA256(SHA-256(content), `signal-migration pack key v2`). The content is the pack's title and
  each sticker's original file and emoji, in order. Only someone who has every sticker can compute it.

Both encodings start with a fixed label and give every field a 4-byte length, so two different packs never encode
the same. This scheme is fixed: changing it would make every earlier upload unfindable.

Everyone who migrates the same Telegram pack computes the same values, so a later user finds an earlier upload.
The index (`/v1/sticker-packs/index`) is an append-only list of 48-byte entries, `lookup key ‖ pack ID`. The browser
downloads all of it and searches it locally, so the server does not learn which packs a user looks up.

Anyone can add an entry. The server adds one only if Signal has that pack and no entry lists that pack ID yet. An
entry says nothing about what the pack contains, so the browser installs a copy that someone else uploaded only
after comparing it with the Telegram pack itself (`compare-pack.ts`):

- The copy's manifest must decrypt with the pack key and hold the title, the emoji and the numbering that the app
  writes, and nothing else.
- A still sticker within Signal's size limit must be the Telegram file, byte for byte.
- A larger still, which the app encodes again at lower quality, and an animation, which the app converts to an
  animated PNG, are drawn and compared with the original drawn at the same size and frame rate
  (`compare-pictures.ts`). An animation must have one of the sizes and frame rates the app converts to, and its file
  may hold nothing but the pictures. Each frame may differ from the original by a tolerance that covers what the
  encoding loses (`ANIMATION_TOLERANCE`, `STILL_TOLERANCE`).

The browser compares at most three copies of a pack: the oldest one that can be used, then the newest, then the
second newest. To find them it looks at no more than the ten oldest and the ten newest entries of the pack. If no
copy passes, it converts and uploads the pack and adds an entry. Right before the upload, it reads the entries added
since its last read and looks again.

Bad copies listed after a good one cost nothing, because the oldest copy passes and no other is read. When the
oldest copy is bad, the first user who meets it uploads a good copy, which is then the newest one and is found by
the users after them. Someone who keeps adding bad copies of a pack can make users upload that pack again.

A copy is compared as soon as it is listed, so that no pack waits. The comparison shows what Signal's CDN served at
that moment. For 30 minutes after an upload began, its uploader can replace the files, because Signal's upload forms
are valid that long. A copy that was faithful when a browser compared it shows other pictures afterwards if its
uploader replaces them in that time. Signal's CDN also goes on serving a version it read earlier (for more than 90
minutes when measured), so a browser can still be given the earlier version to compare after the replacement. This
risk is accepted. In every other case, a browser installs no copy whose pictures differ from the Telegram pack by
more than the tolerance.

## Signal

- **Linking:** the browser becomes a linked device of the account (`PUT /v1/devices/link`). From the linking message
  it keeps the storage service key, derived from the account entropy pool, and drops the pool itself.
- **Installing:** packs are written to the account's storage service as sticker pack records. The `position` field
  holds the Telegram order.
- **Telling other devices:** the phone does not pick up storage changes by itself, so the browser sends sync
  messages to the account's other devices: one with the packs to install, then one asking them to read the storage
  service again. Android acts on only one kind of request per sync message, hence two. The messages are encrypted
  with libsignal sessions started from each device's prekey bundle.
- **Limits:** Signal allows 50 uploads, then one every 72 minutes. A pack has at most 200 stickers. Signal on iOS
  ignores `position` and shows the newest pack first.

Stickers are converted to what Signal accepts: static WebP stays WebP; Lottie (TGS) and WebM animations become
animated PNG, at a lower size and frame rate where needed to fit 300 KiB (`app/src/kinds/stickers/convert.ts`).
A WebM sticker keeps its transparency as a second VP9 stream beside the video, which libvpx's decoder reads and
FFmpeg's own does not; the decoder is built with only FFmpeg's Matroska reader, libvpx's VP9 decoder and swscale.
That build of FFmpeg is under the LGPL 2.1, libvpx under a BSD licence; the script names the exact versions.

## Friends

The user can choose on the start page to look for Telegram friends on Signal. Nothing below happens otherwise.

- **Who is looked for:** everyone the user has a one-to-one chat with, the members of the user's groups of up to
  1000 members, and the user's Telegram contact list (`app/src/kinds/friends/telegram-people.ts`). Bots and deleted
  accounts are left out. A person can be found only if Telegram shows the user their phone number.
- **Asking Signal:** the phone numbers go to Signal's contact discovery, the service that Signal's own apps ask about
  the phone's address book. It runs inside an enclave: a protected part of a server that Signal's operators cannot
  look into. The enclave sends an attestation, a statement signed with a key of the processor's maker that says which
  program runs inside. The browser checks it with libsignal's own code and encrypts the phone numbers for the enclave
  alone (`crates/attestation-wasm/`, `app/src/signal/contact-discovery.ts`). Signal limits how many numbers an
  account may look up in a period of time; a refusal names the wait.
- **The answer:** for each number that has an account which can be found by number, the account's phone number
  identity. The account ID comes back only for a person whose profile key the user's Signal already holds. The app
  sends those keys' access keys along, and so recognises the people who are among the user's Signal contacts already.
- **Adding:** nobody is ticked until the user ticks them. Each ticked person becomes a contact record in the
  account's storage service: the identifiers, the phone number, the Telegram name as nickname, and `whitelisted`,
  the field that says the user accepted the conversation, without which Signal for Android does not list the
  contact. The account's other devices are then asked to read the storage service again.

## What the browser stores

IndexedDB stores locally, until the migration ends or the user clears it:

- TDLib's database with the Telegram session, saved right after sign-in, and a copy of its login file in a
  database of the app's own, which is written back each time TDLib starts; The copy of login credentials is needed because TDLib often segfaults and its database has to be reset to recover.
- the linked device's password, storage service key, account identity key pair and registration ID;
- what the user chose to move, the deselected packs, the Telegram user IDs of the ticked friends and the progress,
  so that a reload continues.

At the end, the device is unlinked, Telegram is signed out, and all of it is deleted.

## Build

You need Node.js, Rust (rustup picks the version from `rust-toolchain.toml`), `wasm-bindgen-cli` 0.2.130, CMake,
and libclang, with which the bindings to BoringSSL are generated.

```sh
git clone --recurse-submodules https://github.com/ArviFoxy/signal-migration
cd signal-migration
scripts/build-tdweb.sh          # TDLib; slow, needed once. Installs Emscripten 3.1.1 under build/ unless EMSDK is set
scripts/build-webm-decoder.sh   # the WebM decoder; a few minutes, needed once. Installs Emscripten 7.0.0 under build/
scripts/build-boringssl-wasm.sh # BoringSSL; a few minutes, needed once. Fetches wasi-sdk 34 into build/ unless WASI_SDK is set
cd app && npm install && npm run build
cd ../crates/server && cargo build --release
```

Dependabot (`.github/dependabot.yml`) proposes newer npm and Cargo packages, submodules and GitHub Actions each
week. The versions pinned in `scripts/build-webm-decoder.sh` and `scripts/build-boringssl-wasm.sh` are checked by a
weekly workflow
(`scripts/check-pinned-versions.sh`), which opens an issue when one is behind.

## Run

```sh
STATIC_DIR=app/dist INDEX_FILE=/var/lib/signal-migration/index.bin \
TELEGRAM_API_ID=... TELEGRAM_API_HASH=... \
crates/server/target/release/signal-migration-server
```

| Variable | Meaning |
| --- | --- |
| `HOST`, `PORT` | Where the server listens. Default `127.0.0.1:8080`. |
| `STATIC_DIR` | The built app, `app/dist`. |
| `INDEX_FILE` | The sticker pack index. Keep it on a disk that is backed up. |
| `TLS_CERT`, `TLS_KEY` | PEM files, to serve HTTPS. Browsers run the app only over HTTPS or on `localhost`. |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | The Telegram app identity from [my.telegram.org](https://my.telegram.org). |
| `TELEGRAM_TEST_DC` | `1` to use Telegram's test servers, for development. |

## Tests

```sh
cd app && npm test               # the app, against simulated Telegram, Signal and index servers
cd app && npm run test:attestation   # the exchange with contact discovery against a stand-in enclave, as WebAssembly in Node.js
cd crates/server && cargo test   # the server
cd crates/signal-wasm && cargo test --target x86_64-unknown-linux-gnu   # the WebAssembly module's Rust code, run natively
cd app && npm run screens        # a screenshot of every screen, in build/screens
cd app && npm run test:integration   # what needs a real Chrome; after `npm run build`
```

The integration tests (`app/integration/`) drive a headless Chrome over its DevTools protocol. `built-app.test.ts`
starts the real server on the built app; each of its tests checks one thing that only the real server, the built
files and a real browser together show. `pictures.test.ts` converts stickers with the app's conversion and compares
them with their originals, which needs the browser's canvas and workers.
