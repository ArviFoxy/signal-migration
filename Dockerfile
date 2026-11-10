# Builds the server binary and the web app (app/dist) on Debian 13. The binary links against Debian 13's C library, so
# it runs on Debian 13 and on any Linux with a newer one. Each build step is its own stage and copies in only the
# files it reads, so Docker's cache rebuilds a step only when one of those files changed: TDLib's build, the slowest,
# reruns only when third_party/td or its scripts change.
#
#   docker build --output type=local,dest=out .
#
# writes out/signal-migration-server and out/dist/. The stages `tdweb` and `webm-decoder` hold only their output
# files, so either can be built alone (`--target tdweb --output ...`) and handed back to a later build in its place
# (`--build-context tdweb=<folder>`).

FROM debian:trixie AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake gperf perl make python3 pkg-config wget curl git ca-certificates xz-utils patch rustup \
    && rm -rf /var/lib/apt/lists/*
# Node.js 26, the version the app is built and tested with.
ARG NODE_VERSION=v26.13.0
ARG NODE_SHA256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
RUN curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz \
    && echo "$NODE_SHA256  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz
WORKDIR /src

# TDLib's web client.
FROM base AS tdweb-build
COPY third_party/td third_party/td
COPY scripts/build-tdweb.sh scripts/build-tdweb-js.sh scripts/
COPY scripts/tdweb scripts/tdweb
RUN scripts/build-tdweb.sh

FROM scratch AS tdweb
COPY --from=tdweb-build /src/build/tdweb/dist /

# The video sticker decoder.
FROM base AS webm-decoder-build
COPY scripts/build-webm-decoder.sh scripts/
COPY app/src/kinds/stickers/webm-decoder.c app/src/kinds/stickers/
RUN scripts/build-webm-decoder.sh

FROM scratch AS webm-decoder
COPY --from=webm-decoder-build /src/build/webm-decoder/webm-decoder.js /src/build/webm-decoder/webm-decoder.wasm /

# Everything above this stage is what the `tdweb` and `webm-decoder` stages are built from; CI's cache keys for the
# two cover exactly these lines.
#
# The Rust toolchain both crates' rust-toolchain.toml select, with the WebAssembly target, and the wasm-bindgen
# command-line tool at the version of the wasm-bindgen crate in Cargo.lock, which it must match.
FROM base AS rust
# protoc: libsignal's spqr crate compiles protocol buffer definitions when it builds.
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/root/.cargo/bin:$PATH
COPY crates/server/rust-toolchain.toml crates/signal-wasm/Cargo.lock /tmp/
RUN toolchain=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' /tmp/rust-toolchain.toml) \
    && wasm_bindgen=$(sed -n '/^name = "wasm-bindgen"$/{n;s/^version = "\(.*\)"/\1/p}' /tmp/Cargo.lock) \
    && rustup toolchain install "$toolchain" --profile minimal --target wasm32-unknown-unknown \
    && cargo +"$toolchain" install wasm-bindgen-cli --version "$wasm_bindgen" --locked

# The web app, with the two above, and the server.
FROM rust AS build
COPY . .
COPY --from=tdweb / build/tdweb/dist/
COPY --from=webm-decoder / build/webm-decoder/
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/root/.cargo/registry \
    cd app && npm ci && npm run build
RUN --mount=type=cache,target=/root/.cargo/registry \
    cd crates/server && cargo build --release --locked

FROM scratch
COPY --from=build /src/crates/server/target/release/signal-migration-server /
COPY --from=build /src/app/dist /dist
