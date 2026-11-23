# Telegram to Signal Migration 🔒🦊

A web app that migrates data from Telegram to Signal:
- sticker packs,
- Telegram contacts found on Signal by their phone number,
- Saved Messages (copied into Note to Self).

The web app runs locally in your browser. The Rust server cannot see any private data: it serves as an end-to-end encrypted relay to Signal (encrypted in the browser with Signal's key) and a shared index of uploaded sticker pack IDs. The web app is built by GitHub actions and hosted on GitHub Pages.

You as an user:
- trust GitHub (not me) to attest that the delivered page matches the source code in this repo,
- can verify from the source code that the app does not reveal any private information to the backend. 

## Parts

| Path | Description |
| --- | --- |
| `app/` | The web app (TypeScript and Lit). |
| `crates/signal-wasm/` | `libsignal` and `rustls` compiled to WebAssembly: device linking, prekeys, sessions, account keys, sticker and storage encryption, and TLS to Signal. |
| `crates/attestation-wasm/` | Signal contact discovery compiled to WebAssembly: checks the enclave attestation with `libsignal` and encrypts the lookup. BoringSSL handles the certificate and signature checks and is built for WebAssembly by `scripts/build-boringssl-wasm.sh`. |
| `crates/server/` | The Rust server: static files, the Signal WebSocket relay, and the sticker pack index. |
| `third_party/td` | Telegram's TDLib, compiled to WebAssembly by `scripts/build-tdweb.sh` with one patch in `scripts/tdweb/`. |
| `app/src/kinds/stickers/webm-decoder.c` | Video sticker decoder built from FFmpeg's WebM demuxer and libvpx's VP9 decoder (`scripts/build-webm-decoder.sh`). |

## Connections

```
browser ──── WebSocket, MTProto ─────────────────────────────▶ Telegram (*.web.telegram.org)
browser ──── WebSocket ──▶ server ──── TCP ─────────────────▶ Signal (chat, storage, cdn, cdsi hosts)
             └──────────── TLS between the browser and Signal ───┘
browser ──── HTTPS ──────▶ GitHub Pages (static app files, Sigstore attestation bundle)
browser ──── HTTPS ──────▶ server (/v1/config, sticker pack index; static files in self-hosted mode)
browser ──── HTTPS ──────────────────────────────────────────▶ Signal's public CDN (cdn-ca.signal.org)
             server ──── HTTPS ─────────────────────────────▶ Signal's public CDN (cdn-ca.signal.org)
```

The browser connects to Telegram directly, but it cannot connect straight to Signal's servers: they use Signal's own
certificate authority, which browsers do not trust. Instead, the browser opens a WebSocket to `/tunnel/{host}` on this
server. If `{host}` is in the server's allowlist (`chat`, `storage`, `cdn`, `cdn2`, `cdn3`, and `cdsi` under
`.signal.org`), the server opens a TCP connection to it and forwards bytes in both directions. The browser runs its own
TLS session through that tunnel, trusting only the root certificates from `libsignal`. The server only connects to
`cdsi.signal.org` (Signal's contact discovery) when the user chooses to look for friends.

Signal's public CDN (`cdn-ca.signal.org`) has a certificate that browsers trust and serves encrypted sticker pack files
publicly. The browser downloads previously uploaded pack copies from it, and the server checks it to make sure a pack
exists before adding it to the index.

## What the server sees

- **Relay:** Encrypted bytes, which Signal host they go to, and when.
- **Index:** A 32-byte lookup key and a 16-byte Signal pack ID for each uploaded pack. Client IP addresses are kept in
  memory for rate limiting and are never logged. When a new entry is submitted, the server sends a `HEAD` request for
  the pack's manifest to Signal's public CDN to check that the pack exists, without downloading any pack files.
- **Nothing else:** No Telegram traffic, Signal credentials, pack keys, stickers, phone numbers, or names.

## Pack keys and the index

The browser computes two keys for each sticker pack (`app/src/kinds/stickers/identity.ts`):

- **Lookup key** = `HKDF-SHA256(SHA-256(identity), "signal-migration sticker-pack lookup v1")`, where `identity` is the
  pack's title followed by each sticker's Telegram file ID and emoji in order. This can be computed before downloading
  any stickers.
- **Pack key** = `HKDF-SHA256(SHA-256(content), "signal-migration pack key v2")`, where `content` is the pack's title
  followed by each sticker's original file bytes and emoji in order. Only someone who has every sticker can compute it.

Both encodings start with a fixed label and prefix every field with a 4-byte length, so two different packs never
encode to the same bytes. This scheme is fixed: changing it would break lookups for every pack uploaded before it.

Everyone who migrates the same Telegram pack gets the same keys, so later users can reuse earlier uploads. The index
(`/v1/sticker-packs/index`) is an append-only list of 48-byte entries; each entry concatenates the lookup key and pack
ID (`lookup key ‖ pack ID`). The browser downloads the whole index and searches it locally, so the server never learns
which packs a user looks up.

Anyone can submit an entry, and the server accepts it if Signal has that pack and its pack ID is not already listed.
Since index entries are untrusted, the browser checks any copy uploaded by someone else against the Telegram pack
before installing it (`compare-pack.ts`):

- The manifest must decrypt with the pack key and contain only the title, emoji, and sticker numbering that the app
  writes.
- Static stickers within Signal's size limit must match the Telegram file byte for byte.
- Larger static stickers are re-encoded at lower quality, and animations are converted to animated PNG (APNG). For
  both, the browser renders the uploaded copy and compares it visually against the original at the same size and frame
  rate (`compare-pictures.ts`). Animations must use one of the app's target sizes and frame rates, and their files may
  contain only image data. Each frame must stay within a tolerance that covers lossy encoding (`STILL_TOLERANCE`,
  `ANIMATION_TOLERANCE`).

The browser checks at most three copies of a pack: the oldest usable copy, then the newest, then the second newest. It
finds those by scanning at most the ten oldest and ten newest entries for the pack. If none pass, it converts and
uploads the pack and adds a new entry. Right before uploading, it pulls any new entries added since its last check and
tries them first in case someone uploaded the pack in the meantime.

Bad copies added after a good one have no effect, since the oldest copy passes and the browser stops there. If the
oldest copy is bad, the first user who hits it uploads a good copy, which becomes the newest entry and gets reused by
later users. Someone who keeps adding bad copies of a pack can still force users to re-upload it.

Copies are checked as soon as they appear in the index rather than after a waiting period, so the check reflects what
Signal's CDN served at that moment. Signal's upload forms stay valid for 30 minutes, so the uploader can overwrite the
files during that window after a browser has already checked them. Signal's CDN also caches earlier versions for a
while (more than 90 minutes when measured), so a browser can still get the old version to check even after a
replacement. We accept that risk. Outside that window, the browser will not install a copy whose images differ from the
Telegram pack by more than the tolerance.

## Signal

- **Linking:** The browser links itself to the account as a secondary device (`PUT /v1/devices/link`). It derives the
  storage service key from the linking message's account entropy pool, keeps only that key, and discards the pool.
- **Installing:** The browser writes packs to Signal's storage service as sticker pack records, using `position` to
  keep the Telegram order.
- **Syncing other devices:** The phone does not pick up storage changes on its own, so the browser sends two sync
  messages to the account's other devices: one listing the packs to install, and a second asking them to re-read the
  storage service. Two messages are needed because Signal for Android only handles one kind of request per sync
  message. Both are encrypted with `libsignal` sessions started from each device's prekey bundle.
- **Limits:** Signal allows 50 uploads in a burst, then one every 72 minutes. A pack can have at most 200 stickers.
  Signal on iOS ignores `position` and always shows the newest pack first.

Stickers are converted to formats Signal accepts (`app/src/kinds/stickers/convert.ts`): static WebP stays WebP, while
Lottie (TGS) and WebM animations become APNG, scaled down in size or frame rate where needed to fit under 300 KiB. WebM
stickers store transparency as a second VP9 stream alongside the main video. libvpx's VP9 decoder supports that alpha
stream, while FFmpeg's built-in decoder does not, so the WebAssembly decoder combines FFmpeg's Matroska demuxer and
`swscale` with libvpx's VP9 decoder. That build of FFmpeg is under LGPL 2.1 and libvpx is under a BSD license;
`scripts/build-webm-decoder.sh` pins the exact versions.

## Friends

Looking for Telegram friends on Signal is optional and off by default on the start page. The app skips all of this
unless the user turns it on.

- **Who is included:** Everyone the user has a one-to-one chat with, members of the user's groups with up to 1,000
  members, and the user's Telegram contact list (`app/src/kinds/friends/telegram-people.ts`). Bots and deleted accounts
  are excluded. A person can only be matched if Telegram shows the user their phone number.
- **Querying Signal:** The browser sends those phone numbers to Signal's contact discovery service, which Signal's own
  apps use to check a phone's address book. It runs inside an enclave, a protected part of the server that Signal's
  operators cannot inspect. The enclave sends an attestation signed with the CPU manufacturer's key proving which code
  is running inside. The browser checks that attestation with `libsignal` and encrypts the phone numbers so only the
  enclave can read them (`crates/attestation-wasm/`, `app/src/signal/contact-discovery.ts`). Signal rate-limits lookups
  per account; if it rejects a request, the response says how long to wait before trying again.
- **Response:** For each phone number that has a discoverable Signal account, the service returns its phone number
  identity. It only returns the account ID if the user's Signal account already has that person's profile key. The app
  sends the access keys derived from those stored profile keys, which lets it spot people who are already Signal
  contacts.
- **Adding contacts:** Nobody is selected by default. For each person the user selects, the app writes a contact record
  to Signal's storage service with their Signal identifiers, phone number, Telegram name as a nickname, and the
  `whitelisted` flag. That flag marks the conversation as accepted; without it, Signal for Android does not list the
  contact. Afterward, the app asks the account's other devices to re-read the storage service.

## Saved Messages

Copying Telegram's Saved Messages (the chat with yourself) into Signal's Note to Self is also optional and off by
default on the start page. See `docs/saved_messages.md` for background and open questions.

- **Reading:** The app loads the chat's message list first (`app/src/kinds/saved/telegram-saved.ts`) without
  downloading any media files. During the migration, it downloads each file from Telegram, encrypts it in chunks in
  WebAssembly (`crates/signal-wasm/src/crypto.rs`), uploads it, and deletes the local copy right away.
- **What is copied:** Every supported message from a start date picked on a timeline of the chat (all messages by
  default). That covers text (messages over 2,048 bytes are uploaded as `text/x-signal-plain`), photos, videos, GIFs,
  voice notes, audio files, round video messages, stickers (animated ones converted to APNG), arbitrary files, and
  grouped albums. Text formatting that Signal supports is kept, and links are expanded by putting the URL after the link
  text. Files over Signal's 100 MiB encrypted upload limit, protected or self-destructing messages, and unsupported types
  like locations or polls are skipped and counted. Forwarding info is not copied.
- **How messages are sent:** Each attachment is encrypted in Signal's attachment format (logarithmic zero padding,
  AES-256-CBC, HMAC-SHA256, and a SHA-256 digest) and uploaded in chunks to Signal's CDN
  (`app/src/signal/attachment.ts`). The app then sends each message to the account's other devices as a sent transcript
  (the sync message a device uses to report what it sent), with the user's own account as the recipient
  (`app/src/signal/note-to-self.ts`). Each message carries its original Telegram date, which Signal displays. Signal
  orders conversations by arrival time rather than message date, so the app sends messages oldest first and they show
  up after whatever Note to Self already has.
- **Repeating:** Signal drops duplicate messages that share a sender and timestamp. The app derives each timestamp
  solely from the Telegram message, so re-sending a message after an interruption or in a later run still only creates
  one copy.
- **Disappearing messages:** Copied messages carry no disappearing timer. Since Signal updates a conversation's timer
  to match incoming messages, importing Saved Messages turns off any timer set on Note to Self.

## What the browser stores

While a migration is in progress (until it finishes or the user clears it), the app keeps the following in IndexedDB:

- TDLib's database with the Telegram session, saved right after sign-in, plus a backup copy of its login file in the
  app's own database. The app restores that backup whenever TDLib starts, because TDLib often segfaults and its
  database has to be reset to recover.
- The linked Signal device's password, storage service key, account identity key pair, and registration ID.
- Progress and choices so the migration can resume after a reload: what the user chose to move, deselected sticker
  packs, Telegram user IDs of selected friends, the Saved Messages start date, and the Telegram ID of the last copied
  message.

When the migration finishes, the app unlinks the Signal device, signs out of Telegram, and deletes all of it.

## Verified builds

The web app does not assume the backend server is honest or uncompromised; it enforces confidentiality and integrity in
the browser itself (outside availability and the traffic metadata described above). A malicious server could only break
those guarantees by serving modified code, so hosting the static frontend on GitHub Pages with signed build provenance
removes the server from code delivery without requiring the server itself to be attested.

Publishing a `v*` release triggers `.github/workflows/release.yml`, which builds the web app fresh from source on a
GitHub-hosted runner (without reusing cached build outputs), signs a single SLSA v1.0 build provenance attestation
covering every deployed file via GitHub Artifact Attestations (`actions/attest`), and deploys the static files and
Sigstore bundle (`attestation.sigstore.json`) to GitHub Pages.

On startup, the page verifies `attestation.sigstore.json` in the browser (`app/src/attestation/`) against the pinned
Sigstore Public Good root (`app/src/attestation/trusted-root.json`): the Fulcio X.509 certificate chain and Certificate
Transparency SCT, the Rekor transparency log inclusion proof and checkpoint, the GitHub Actions OIDC identity
(repository, `github-hosted` runner, `release` trigger, `refs/tags/v*`, and `.github/workflows/release.yml`), and the
DSSE signature over the in-toto statement. It then checks the SHA-256 digests of `index.html` and the loaded scripts and
stylesheets against the signed subject list, and checks lazy WebAssembly modules and workers before instantiating them.
When verified, the sidebar shows a green shield linking directly to GitHub's attestation page.

An in-page check detects unattested copies, cache skew, and tampered lazy assets, but cannot defend against a compromise
of GitHub Pages itself (malicious JavaScript served by the page host could draw a fake badge). Because every deployed
file is listed directly as an attestation subject, any file served by the site can be verified independently outside the
browser with the GitHub CLI:

```sh
curl -fsSLO https://arvifoxy.github.io/signal-migration/index.html
gh attestation verify index.html --repo ArviFoxy/signal-migration
```

## Build

You need Node.js, Rust (`rustup` picks the version from `rust-toolchain.toml`), `wasm-bindgen-cli` 0.2.130, CMake, and
`libclang` (for generating BoringSSL bindings).

```sh
git clone --recurse-submodules https://github.com/ArviFoxy/signal-migration
cd signal-migration
scripts/build-tdweb.sh          # TDLib; slow, needed once. Installs Emscripten 3.1.1 under build/ unless EMSDK is set
scripts/build-webm-decoder.sh   # WebM decoder; a few minutes, needed once. Installs Emscripten 7.0.0 under build/
scripts/build-boringssl-wasm.sh # BoringSSL; a few minutes, needed once. Fetches wasi-sdk 34 into build/ unless WASI_SDK is set
cd app && npm install && npm run build
cd ../crates/server && cargo build --release
```

Dependabot (`.github/dependabot.yml`) checks weekly for updates to npm and Cargo packages, submodules, and GitHub
Actions. A weekly workflow also runs `scripts/check-pinned-versions.sh` to check the versions pinned in
`scripts/build-webm-decoder.sh`, `scripts/build-boringssl-wasm.sh`, and `app/src/attestation/trusted-root.json`, opening
an issue when any fall behind. `scripts/update-sigstore-root.mjs` refreshes the pinned Sigstore root via TUF.

To build a static frontend that talks to a separate backend origin (as `.github/workflows/release.yml` does for GitHub
Pages), pass `BACKEND_ORIGIN` and `--no-compress`:

```sh
cd app && BACKEND_ORIGIN=https://signal.vixhole.fun npm run build -- --no-compress
```

## Run

```sh
STATIC_DIR=app/dist INDEX_FILE=/var/lib/signal-migration/index.bin \
TELEGRAM_API_ID=... TELEGRAM_API_HASH=... \
crates/server/target/release/signal-migration-server
```

| Variable | Meaning |
| --- | --- |
| `HOST`, `PORT` | Where the server listens (default `127.0.0.1:8080`). |
| `STATIC_DIR` | Optional path to the built app (`app/dist`). Omit when hosting the frontend elsewhere (such as GitHub Pages). |
| `FRONTEND_REDIRECT_URL` | Optional URL that `GET /` redirects to when `STATIC_DIR` is unset. |
| `ALLOWED_ORIGINS` | Optional comma-separated list of browser origins (e.g. `https://arvifoxy.github.io`) allowed for CORS on `/v1/*` and WebSocket `Origin` checks on `/tunnel/{host}`. |
| `INDEX_FILE` | Path to the sticker pack index. Keep it on a disk that gets backed up. |
| `TLS_CERT`, `TLS_KEY` | PEM certificate and key files for HTTPS. Browsers only allow the app over HTTPS or `localhost`. |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Telegram API credentials from [my.telegram.org](https://my.telegram.org). |
| `TELEGRAM_TEST_DC` | Set to `1` to use Telegram's test servers during development. |

## Tests

```sh
cd app && npm test                                                    # app tests against simulated Telegram, Signal, and index servers
cd app && npm run test:attestation                                    # contact discovery in Node.js (WebAssembly) against a mock enclave
cd crates/server && cargo test                                        # server tests
cd crates/signal-wasm && cargo test --target x86_64-unknown-linux-gnu # signal-wasm Rust tests, run natively
cd app && npm run screens                                             # screenshots of every screen in build/screens
cd app && npm run test:integration                                    # Chrome integration tests (run after `npm run build`)
```

The integration tests (`app/integration/`) drive headless Chrome over the Chrome DevTools Protocol. `built-app.test.ts`
runs the real server against the built app to test things that only show up with the real server, built files, and a
real browser together. `pictures.test.ts` runs the app's sticker conversion and compares the output against the
originals, which needs a real browser's canvas and workers.
