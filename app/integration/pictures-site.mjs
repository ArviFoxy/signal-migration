// Builds and serves the page of pictures.test.ts: pictures-page.ts with the two workers of the sticker conversion
// and the video decoder's WebAssembly module, in a new directory that `stop` removes.

import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const app = path.resolve(import.meta.dirname, '..');
const webmDecoder = path.resolve(app, '../build/webm-decoder');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };

/** Resolves to the site's address (`base`) and a function that stops it. */
export async function startPicturesSite() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pictures-site-'));
  await build({
    entryPoints: [
      'integration/pictures-page.ts',
      'src/kinds/stickers/apng-worker.ts',
      'src/kinds/stickers/webm-worker.ts',
    ],
    entryNames: '[name]',
    absWorkingDir: app,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outdir: root,
    alias: { 'webm-decoder': path.join(webmDecoder, 'webm-decoder.js') },
    external: ['node:*'],
    logLevel: 'silent',
  });
  fs.copyFileSync(path.join(webmDecoder, 'webm-decoder.wasm'), path.join(root, 'webm-decoder.wasm'));
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><meta charset="utf-8"><script type="module" src="/pictures-page.js"></script>',
  );
  const server = http.createServer((request, response) => {
    const file = path.join(root, new URL(request.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root) || !fs.existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
