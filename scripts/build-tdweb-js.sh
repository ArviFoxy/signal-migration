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

# Replace legacy webpack 4 / regenerator-runtime Function() shims with globalThis so tdweb and its worker run under
# strict CSP without 'unsafe-eval'.
node -e '
const fs = require("node:fs");
const path = require("node:path");
const dir = path.resolve("dist");
let replacedRegenerator = 0;
let replacedGlobal = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
  const full = path.join(dir, file);
  let src = fs.readFileSync(full, "utf8");
  const next1 = src.replaceAll("Function(\"r\", \"regeneratorRuntime = r\")(runtime);", () => {
    replacedRegenerator++;
    return "globalThis.regeneratorRuntime = runtime;";
  });
  const next2 = next1.replaceAll("g = g || new Function(\"return this\")();", () => {
    replacedGlobal++;
    return "g = g || globalThis;";
  });
  if (next2 !== src) fs.writeFileSync(full, next2);
  if (/\bFunction\s*\(/.test(next2)) {
    throw new Error(`Unexpected Function() call remains in ${file}`);
  }
}
if (replacedRegenerator === 0 || replacedGlobal === 0) {
  throw new Error(`Expected tdweb CSP shims to match (regenerator=${replacedRegenerator}, global=${replacedGlobal})`);
}
'
