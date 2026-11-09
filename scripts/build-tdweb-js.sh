#!/usr/bin/env bash
# Builds tdweb's JavaScript into build/tdweb/dist, from a copy of third_party/td/example/web/tdweb with the patches in
# scripts/tdweb applied. The WebAssembly module (src/prebuilt) comes from scripts/build-tdweb.sh.
#
# sync-database.patch adds a "syncDatabase" request: it copies TDLib's database to IndexedDB at once and answers when
# done. tdweb on its own copies it every 5 seconds and when TDLib closes, so a login could be lost by closing the
# page right after signing in.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
source_dir=$repo/third_party/td/example/web/tdweb
work=$repo/build/tdweb
[ -d "$source_dir/src/prebuilt" ] || { echo "tdweb's WebAssembly module is missing: run scripts/build-tdweb.sh" >&2; exit 1; }
[ -d "$source_dir/node_modules" ] || (cd "$source_dir" && npm ci)

rm -rf "$work"
mkdir -p "$work"
cp -r "$source_dir/src" "$source_dir/package.json" "$source_dir/webpack.config.js" "$work/"

ln -s "$source_dir/node_modules" "$work/node_modules"
for patch in "$repo"/scripts/tdweb/*.patch; do
  patch --quiet -d "$work" -p1 < "$patch"
done
cd "$work"
npx webpack --mode production
