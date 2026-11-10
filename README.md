# Telegram to Signal Migration 🔒🦊

A web app that moves Telegram sticker packs into a Signal account. All the work happens in the browser. The server
serves the app, passes encrypted traffic on to Signal, and keeps a shared list of packs already uploaded.

## Parts

| Part | What it is |
| --- | --- |
| `app/` | The web app: TypeScript and Lit. |
| `crates/signal-wasm/` | libsignal and rustls compiled to WebAssembly: device linking, prekeys, sessions, account keys, sticker and storage encryption, and the TLS connection to Signal. |
| `crates/server/` | The server, in Rust: static files, the relay to Signal, the sticker pack index. |
| `third_party/td` | TDLib, Telegram's library, compiled to WebAssembly by `scripts/build-tdweb.sh`, with one patch (`scripts/tdweb/`). |
| `app/src/kinds/stickers/webm-decoder.c` | The decoder for video stickers: FFmpeg's WebM reader and libvpx's VP9 decoder, compiled to WebAssembly by `scripts/build-webm-decoder.sh`. |

## Connections

```
browser ──── WebSocket, MTProto ─────────────────────────────▶ Telegram (*.web.telegram.org)
browser ──── WebSocket ──▶ server ──── TCP ─────────────────▶ Signal (chat, storage, cdn hosts)
             └──────────── TLS between the browser and Signal ───┘
browser ──── HTTPS ──────▶ server (app files, sticker pack index)
```

Telegram is reached directly. Signal is not, because Signal's servers use certificates from Signal's own
certificate authority, which browsers do not trust. The browser therefore opens a WebSocket to the server
(`/tunnel/{host}`), which connects to that host if it is on its list (`chat`, `storage`, `cdn`, `cdn2`, `cdn3`
`.signal.org`) and copies bytes both ways. Inside, the browser runs its own TLS session with Signal, accepting only
Signal's root certificates (the ones libsignal ships).

## What the server sees

- **Relay:** encrypted bytes, which Signal host they go to, and when.
- **Index:** for each uploaded pack, a 32-byte lookup key and the 16-byte Signal pack ID. Client addresses are used
  for rate limits, in memory only, and are not logged.
- **Nothing else:** no Telegram traffic, no Signal credentials, no pack keys, no stickers.

## Pack keys and the index

Each pack has two values, computed in the browser (`app/src/kinds/stickers/identity.ts`):

- **Lookup key** = HKDF-SHA256(SHA-256(identity), `signal-migration sticker-pack lookup v1`). The identity is the
  pack's title and each sticker's Telegram file ID and emoji, in order. It is known before anything is downloaded.
- **Pack key** = HKDF-SHA256(SHA-256(content), `signal-migration pack key v2`). The content is the pack's title and
  each sticker's original file and emoji, in order. Only someone who has every sticker can compute it.

Both encodings start with a fixed label and give every field a 4-byte length, so two different packs never encode
the same. This scheme is fixed: changing it would make every earlier upload unfindable.

Everyone who migrates the same Telegram pack computes the same values, so a pack is uploaded once. Right before
each upload, the browser reads the entries added since its last read and looks the pack up again. The index
(`/v1/sticker-packs/index`) is an append-only list of 48-byte entries, `lookup key ‖ pack ID`. The browser downloads
all of it and searches it locally. Before installing a pack from an entry, it downloads the pack's stickers, computes
the pack key and checks that the pack's manifest on Signal's CDN decrypts with it.

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

## What the browser stores

IndexedDB stores locally, until the migration ends or the user clears it:

- TDLib's database with the Telegram session, saved right after sign-in, and a copy of its login file in a
  database of the app's own, which is written back each time TDLib starts; The copy of login credentials is needed because TDLib often segfaults and its database has to be reset to recover.
- the linked device's password, storage service key, account identity key pair and registration ID;
- the selection and progress, so that a reload continues.

At the end, the device is unlinked, Telegram is signed out, and all of it is deleted.

## Build

You need Node.js, Rust (rustup picks the version from `rust-toolchain.toml`) and `wasm-bindgen-cli` 0.2.130.

```sh
git clone --recurse-submodules https://github.com/ArviFoxy/signal-migration
cd signal-migration
scripts/build-tdweb.sh          # TDLib; slow, needed once. Installs Emscripten 3.1.1 under build/ unless EMSDK is set
scripts/build-webm-decoder.sh   # the WebM decoder; a few minutes, needed once. Installs Emscripten 7.0.0 under build/
cd app && npm install && npm run build
cd ../crates/server && cargo build --release
```

Dependabot (`.github/dependabot.yml`) proposes newer npm and Cargo packages, submodules and GitHub Actions each
week. The versions pinned in `scripts/build-webm-decoder.sh` are checked by a weekly workflow
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
cd crates/server && cargo test   # the server
cd crates/signal-wasm && cargo test --target x86_64-unknown-linux-gnu   # the WebAssembly module's Rust code, run natively
cd app && npm run screens        # a screenshot of every screen, in build/screens
```
