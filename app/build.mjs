// Builds the web app into dist/: bundles each entry point, copies the static files and the WebAssembly modules.
// The bundles are not minified.
//
// With --demo it builds the demo instead, into dist-demo/: the same wizard against simulated Telegram and Signal
// accounts, served by the server in demo mode on its own port (crates/server, MODE=demo). The app's build never
// contains the demo.
//
// TDLib's web client (tdweb, built by scripts/build-tdweb.sh) is bundled from its dist/tdweb.js. That file starts a
// worker by a file name relative to the page, and the worker loads its second part and TDLib's WebAssembly module
// the same way, so those files are copied to the root of dist/.
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const tdwebDist = '../third_party/td/example/web/tdweb/dist';
const demo = process.argv.includes('--demo');
const outdir = demo ? 'dist-demo' : 'dist';
const entries = [demo ? 'demo/demo.ts' : 'src/main.ts', 'src/kinds/stickers/apng-worker.ts', 'src/fonts.css'];

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: entries,
  entryNames: '[name]',
  assetNames: 'fonts/[name]-[hash]',
  loader: { '.woff2': 'file', '.woff': 'file' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir,
  sourcemap: true,
});
execFileSync('node_modules/.bin/tailwindcss', ['--input', 'src/styles.css', '--output', `${outdir}/styles.css`], {
  stdio: 'inherit',
});
fs.copyFileSync(demo ? 'demo/demo.html' : 'public/index.html', `${outdir}/index.html`);
fs.copyFileSync('src/wasm/signal_migration_wasm_bg.wasm', `${outdir}/signal_migration_wasm_bg.wasm`);
if (!demo) {
  for (const file of fs.readdirSync(tdwebDist)) {
    if (file !== 'tdweb.js') fs.copyFileSync(path.join(tdwebDist, file), path.join(outdir, file));
  }
}

// Brotli and gzip copies of every file a browser downloads, which the server sends to browsers that accept them.
// TDLib's module takes about 25 s to compress with brotli, so compressed copies are cached under ../build by the
// SHA-256 of the file's content.
const cacheDir = '../build/compressed';
fs.mkdirSync(cacheDir, { recursive: true });
for (const file of fs.readdirSync(outdir)) {
  if (!/\.(js|css|wasm|html)$/.test(file)) continue;
  const content = fs.readFileSync(path.join(outdir, file));
  const hash = createHash('sha256').update(content).digest('hex');
  for (const [extension, compress] of [
    [
      'br',
      () =>
        brotliCompressSync(content, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: content.length },
        }),
    ],
    ['gz', () => gzipSync(content, { level: 9 })],
  ]) {
    const cached = path.join(cacheDir, `${hash}.${extension}`);
    if (!fs.existsSync(cached)) fs.writeFileSync(cached, compress());
    fs.copyFileSync(cached, path.join(outdir, `${file}.${extension}`));
  }
}
