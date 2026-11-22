// Builds the web app into dist/: bundles each entry point, content-hashes the built files, emits index.html with
// Subresource Integrity hashes, and copies the static files and WebAssembly modules.
// The bundles and the stylesheet are minified; source maps lead back to the sources.
//
// TDLib's web client (tdweb) is bundled from ../build/tdweb/dist/tdweb.js, which scripts/build-tdweb-js.sh builds
// with this project's patches; the "tdweb" package in node_modules provides only its types. tdweb.js starts a worker
// by a file name relative to the page, and the worker loads its second part and TDLib's WebAssembly module the same
// way, so those files are copied to the root of dist/.
//
// The WebM decoder for video stickers is bundled from ../build/webm-decoder, which scripts/build-webm-decoder.sh
// builds; its WebAssembly module is copied to the root of dist/ with a content hash in its name. Its loader also runs
// in Node, for the tests, and imports Node's modules there, which a browser never reaches, so they stay out of the
// bundle.
//
// Options:
//   --fixtures     Builds the screen fixtures (fixtures/fixtures.ts) into dist-fixtures/, for fixtures/screens.mjs.
//   --no-compress  Skips generating .br and .gz sidecars (used when building for GitHub Pages, which compresses on the fly).
//   BACKEND_ORIGIN Optional backend origin (e.g. "https://signal.vixhole.fun") baked into the bundle at build time;
//                  omitted or empty uses the page's own origin.
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const tdwebDist = '../build/tdweb/dist';
const webmDecoder = '../build/webm-decoder';
const fixtures = process.argv.includes('--fixtures');
const compress = !process.argv.includes('--no-compress');
const outdir = fixtures ? 'dist-fixtures' : 'dist';

function normalizeBackendOrigin(raw) {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return '';
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`BACKEND_ORIGIN must use http or https: ${trimmed}`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`BACKEND_ORIGIN must not include a path, query or fragment: ${trimmed}`);
  }
  return parsed.origin;
}

function shortHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

function sriSha384(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

function copyHashed(sourcePath, stem, ext) {
  const bytes = fs.readFileSync(sourcePath);
  const name = `${stem}-${shortHash(bytes)}${ext}`;
  fs.writeFileSync(path.join(outdir, name), bytes);
  return name;
}

function outputNameFor(metafile, entryPoint) {
  const expected = path.resolve(entryPoint);
  for (const [outPath, info] of Object.entries(metafile.outputs)) {
    if (info.entryPoint && path.resolve(info.entryPoint) === expected) {
      return path.basename(outPath);
    }
  }
  throw new Error(`esbuild produced no output for entry point ${entryPoint}`);
}

const commonEsbuild = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir,
  minify: true,
  sourcemap: true,
  alias: { tdweb: path.resolve(tdwebDist, 'tdweb.js'), 'webm-decoder': path.resolve(webmDecoder, 'webm-decoder.js') },
  external: ['node:*'],
};

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

if (fixtures) {
  await build({
    ...commonEsbuild,
    entryPoints: ['fixtures/fixtures.ts', 'src/fonts.css'],
    entryNames: '[name]',
    assetNames: 'fonts/[name]-[hash]',
    loader: { '.woff2': 'file', '.woff': 'file' },
  });
  execFileSync(
    'node_modules/.bin/tailwindcss',
    ['--input', 'src/styles.css', '--output', `${outdir}/styles.css`, '--minify'],
    { stdio: 'inherit' },
  );
  fs.copyFileSync('fixtures/fixtures.html', `${outdir}/index.html`);
  process.exit(0);
}

const backendOrigin = normalizeBackendOrigin(process.env.BACKEND_ORIGIN);

// 1. Copy and content-hash the WebAssembly modules first so their exact names can be baked into workers and main.js.
const signalWasm = copyHashed('src/wasm/signal_migration_wasm_bg.wasm', 'signal_migration_wasm_bg', '.wasm');
const attestationWasm = copyHashed('src/wasm/attestation_wasm_bg.wasm', 'attestation_wasm_bg', '.wasm');
const webmDecoderWasm = copyHashed(path.join(webmDecoder, 'webm-decoder.wasm'), 'webm-decoder', '.wasm');

// TDLib's worker scripts and WebAssembly binary already carry content hashes in their filenames.
const tdlibFiles = [];
for (const file of fs.readdirSync(tdwebDist).sort()) {
  if (file !== 'tdweb.js') {
    fs.copyFileSync(path.join(tdwebDist, file), path.join(outdir, file));
    tdlibFiles.push(file);
  }
}

// 2. Build the worker bundles with the hashed WebM decoder filename baked in.
const workersResult = await build({
  ...commonEsbuild,
  entryPoints: ['src/kinds/stickers/apng-worker.ts', 'src/kinds/stickers/webm-worker.ts'],
  entryNames: '[name]-[hash]',
  metafile: true,
  define: {
    __ASSET_FILES__: JSON.stringify({ webmDecoderWasm }),
  },
});
const apngWorker = outputNameFor(workersResult.metafile, 'src/kinds/stickers/apng-worker.ts');
const webmWorker = outputNameFor(workersResult.metafile, 'src/kinds/stickers/webm-worker.ts');

// 3. Build the main entry point and font stylesheet with all hashed asset names and backend origin baked in.
const appResult = await build({
  ...commonEsbuild,
  entryPoints: ['src/main.ts', 'src/fonts.css'],
  entryNames: '[name]-[hash]',
  assetNames: 'fonts/[name]-[hash]',
  loader: { '.woff2': 'file', '.woff': 'file' },
  metafile: true,
  define: {
    __BACKEND_ORIGIN__: JSON.stringify(backendOrigin),
    __ASSET_FILES__: JSON.stringify({ signalWasm, attestationWasm, webmDecoderWasm, apngWorker, webmWorker }),
    __TDLIB_FILES__: JSON.stringify(tdlibFiles),
  },
});
const mainJs = outputNameFor(appResult.metafile, 'src/main.ts');
const fontsCss = outputNameFor(appResult.metafile, 'src/fonts.css');

// 4. Build and content-hash the Tailwind stylesheet.
const rawStylesPath = path.join(outdir, 'styles.css');
execFileSync('node_modules/.bin/tailwindcss', ['--input', 'src/styles.css', '--output', rawStylesPath, '--minify'], {
  stdio: 'inherit',
});
const stylesBytes = fs.readFileSync(rawStylesPath);
const stylesCss = `styles-${shortHash(stylesBytes)}.css`;
fs.renameSync(rawStylesPath, path.join(outdir, stylesCss));

// 5. Emit index.html referencing the hashed assets with Subresource Integrity hashes.
const fontsSri = sriSha384(fs.readFileSync(path.join(outdir, fontsCss)));
const stylesSri = sriSha384(stylesBytes);
const mainSri = sriSha384(fs.readFileSync(path.join(outdir, mainJs)));
const indexHtml = fs
  .readFileSync('public/index.html', 'utf8')
  .replace(
    '<link rel="stylesheet" href="./fonts.css" />',
    `<link rel="stylesheet" href="./${fontsCss}" integrity="${fontsSri}" />`,
  )
  .replace(
    '<link rel="stylesheet" href="./styles.css" />',
    `<link rel="stylesheet" href="./${stylesCss}" integrity="${stylesSri}" />`,
  )
  .replace(
    '<script type="module" src="./main.js"></script>',
    `<script type="module" src="./${mainJs}" integrity="${mainSri}"></script>`,
  );
if (!indexHtml.includes(fontsCss) || !indexHtml.includes(stylesCss) || !indexHtml.includes(mainJs)) {
  throw new Error('public/index.html did not contain expected asset tags to rewrite');
}
fs.writeFileSync(path.join(outdir, 'index.html'), indexHtml);

if (!compress) process.exit(0);

// Brotli and gzip copies of every file a browser downloads, which the server sends to browsers that accept them.
// TDLib's module takes about 25 s to compress with brotli, so compressed copies are cached under ../build by the
// SHA-256 of the file's content.
const cacheDir = '../build/compressed';
fs.mkdirSync(cacheDir, { recursive: true });
for (const file of fs.readdirSync(outdir)) {
  if (!/\.(js|css|wasm|html)$/.test(file)) continue;
  const content = fs.readFileSync(path.join(outdir, file));
  const hash = createHash('sha256').update(content).digest('hex');
  for (const [extension, compressBytes] of [
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
    if (!fs.existsSync(cached)) fs.writeFileSync(cached, compressBytes());
    fs.copyFileSync(cached, path.join(outdir, `${file}.${extension}`));
  }
}
