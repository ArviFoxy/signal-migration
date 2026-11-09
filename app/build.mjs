// Builds the web app into dist/: bundles each entry point, copies the static files and the WebAssembly modules.
// The bundles are not minified.
//
// TDLib's web client (tdweb) is bundled from ../build/tdweb/dist/tdweb.js, which scripts/build-tdweb-js.sh builds
// with this project's patches; the "tdweb" package in node_modules provides only its types. tdweb.js starts a worker
// by a file name relative to the page, and the worker loads its second part and TDLib's WebAssembly module the same
// way, so those files are copied to the root of dist/.
//
// The WebM decoder for video stickers is bundled from ../build/webm-decoder, which scripts/build-webm-decoder.sh
// builds; its WebAssembly module is copied to the root of dist/. Its loader also runs in Node, for the tests, and
// imports Node's modules there, which a browser never reaches, so they stay out of the bundle.
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const tdwebDist = '../build/tdweb/dist';
const webmDecoder = '../build/webm-decoder';
// With --fixtures it builds the screen fixtures instead (fixtures/fixtures.ts), into dist-fixtures/, for
// fixtures/screens.mjs; that build is never served.
const fixtures = process.argv.includes('--fixtures');
const outdir = fixtures ? 'dist-fixtures' : 'dist';
const entries = fixtures
  ? ['fixtures/fixtures.ts', 'src/fonts.css']
  : ['src/main.ts', 'src/kinds/stickers/apng-worker.ts', 'src/kinds/stickers/webm-worker.ts', 'src/fonts.css'];

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
  alias: { tdweb: path.resolve(tdwebDist, 'tdweb.js'), 'webm-decoder': path.resolve(webmDecoder, 'webm-decoder.js') },
  external: ['module', 'fs', 'path', 'url'],
});
execFileSync('node_modules/.bin/tailwindcss', ['--input', 'src/styles.css', '--output', `${outdir}/styles.css`], {
  stdio: 'inherit',
});
if (fixtures) {
  fs.copyFileSync('fixtures/fixtures.html', `${outdir}/index.html`);
  process.exit(0);
}
fs.copyFileSync('public/index.html', `${outdir}/index.html`);
fs.copyFileSync('src/wasm/signal_migration_wasm_bg.wasm', `${outdir}/signal_migration_wasm_bg.wasm`);
fs.copyFileSync(path.join(webmDecoder, 'webm-decoder.wasm'), `${outdir}/webm-decoder.wasm`);
for (const file of fs.readdirSync(tdwebDist)) {
  if (file !== 'tdweb.js') fs.copyFileSync(path.join(tdwebDist, file), path.join(outdir, file));
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
