// Builds the web app into dist/: bundles each entry point, copies the static files and the WebAssembly modules.
// The bundles are not minified.
//
// TDLib's web client (tdweb, built by scripts/build-tdweb.sh) is bundled from its dist/tdweb.js. That file starts a
// worker by a file name relative to the page, and the worker loads its second part and TDLib's WebAssembly module
// the same way, so those files are copied to the root of dist/.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const tdwebDist = '../third_party/td/example/web/tdweb/dist';
const entries = ['src/main.ts', 'src/diagnostics.ts', 'src/kinds/stickers/apng-worker.ts'];

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist', { recursive: true });
await build({ entryPoints: entries, entryNames: '[name]', bundle: true, format: 'esm', target: 'es2022', outdir: 'dist', sourcemap: true });
fs.cpSync('public', 'dist', { recursive: true });
fs.copyFileSync('src/wasm/signal_migration_wasm_bg.wasm', 'dist/signal_migration_wasm_bg.wasm');
for (const file of fs.readdirSync(tdwebDist)) {
  if (file !== 'tdweb.js') fs.copyFileSync(path.join(tdwebDist, file), path.join('dist', file));
}
