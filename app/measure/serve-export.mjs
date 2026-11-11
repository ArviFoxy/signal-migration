// Serves the app with the addition of export-page.ts over HTTPS and keeps the sticker files that page sends:
//
//   node measure/serve-export.mjs <port> <address> <certificate.pem> <key.pem> <telegram.env> <folder>
//
// after `npm run build`. <telegram.env> holds TELEGRAM_API_ID and TELEGRAM_API_HASH; <folder> gets one folder per
// pack, named by Telegram's ID of the pack, with the sticker files as Telegram has them and pack.json (the title,
// and each sticker's emoji and format). It answers what the page asks the migration server for a Telegram login:
// the configuration, and an empty sticker pack index. It has no tunnel to Signal.

import { build } from 'esbuild';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const [port, address, certificate, key, telegramEnv, folder] = process.argv.slice(2);
if (!folder) throw new Error('usage: serve-export.mjs <port> <address> <certificate> <key> <telegram.env> <folder>');
const app = path.resolve(import.meta.dirname, '..');
const dist = path.join(app, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/ is missing: run `npm run build` first');

const settings = Object.fromEntries(
  fs
    .readFileSync(telegramEnv, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
);
const config = JSON.stringify({
  telegram: { apiId: Number(settings.TELEGRAM_API_ID), apiHash: settings.TELEGRAM_API_HASH, testDc: false },
});

// The built app, with the page's script in place of the app's.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-site-'));
for (const file of fs.readdirSync(dist, { withFileTypes: true })) {
  if (file.isDirectory()) fs.cpSync(path.join(dist, file.name), path.join(root, file.name), { recursive: true });
  else if (!/\.(br|gz|map)$/.test(file.name)) fs.copyFileSync(path.join(dist, file.name), path.join(root, file.name));
}
await build({
  entryPoints: { main: 'measure/export-page.ts' },
  absWorkingDir: app,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: root,
  alias: {
    tdweb: path.resolve(app, '../build/tdweb/dist/tdweb.js'),
    'webm-decoder': path.resolve(app, '../build/webm-decoder/webm-decoder.js'),
  },
  external: ['node:*'],
  logLevel: 'warning',
});

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};
const MAX_FILE_BYTES = 8 * 1024 * 1024;
fs.mkdirSync(folder, { recursive: true });

function body(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_FILE_BYTES) reject(new Error('the file is too large'));
      else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

const server = https.createServer(
  { cert: fs.readFileSync(certificate), key: fs.readFileSync(key) },
  async (request, response) => {
    const answer = (status, type, content = '') => response.writeHead(status, { 'content-type': type }).end(content);
    try {
      const { pathname } = new URL(request.url, 'https://x');
      const file = /^\/export\/file\/(-?\d+)\/(\d+)\.(tgs|webm|webp)$/.exec(pathname);
      const pack = /^\/export\/pack\/(-?\d+)$/.exec(pathname);
      if (request.method === 'POST' && file) {
        fs.mkdirSync(path.join(folder, file[1]), { recursive: true });
        fs.writeFileSync(path.join(folder, file[1], `${file[2].padStart(3, '0')}.${file[3]}`), await body(request));
        return answer(204, 'text/plain');
      }
      if (request.method === 'POST' && pack) {
        const description = JSON.parse((await body(request)).toString('utf8'));
        fs.writeFileSync(path.join(folder, pack[1], 'pack.json'), JSON.stringify(description));
        console.log(`saved a pack of ${description.stickers.length} stickers`);
        return answer(204, 'text/plain');
      }
      if (request.method !== 'GET') return answer(405, 'text/plain');
      if (pathname === '/export/saved') {
        const saved = fs.readdirSync(folder).filter((name) => fs.existsSync(path.join(folder, name, 'pack.json')));
        return answer(200, 'application/json', JSON.stringify(saved));
      }
      if (pathname === '/v1/config') return answer(200, 'application/json', config);
      if (pathname === '/v1/sticker-packs/index') return answer(200, 'application/octet-stream');
      const wanted = path.join(root, pathname.replace(/\/$/, '/index.html'));
      if (!wanted.startsWith(root) || !fs.existsSync(wanted) || fs.statSync(wanted).isDirectory()) {
        return answer(404, 'text/plain');
      }
      response.writeHead(200, { 'content-type': TYPES[path.extname(wanted)] ?? 'application/octet-stream' });
      fs.createReadStream(wanted).pipe(response);
    } catch (error) {
      answer(500, 'text/plain', String(error));
    }
  },
);
server.listen(Number(port), address, () => console.log(`serving on https://${address}:${port}/`));
