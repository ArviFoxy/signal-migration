// Makes a page that shows, for some saved stickers, what the choice between size and frame rate looks like:
//
//   node measure/choices.mjs <originals> <out> <pack ID>/<number> ...
//
// <originals> is the folder serve-export.mjs fills. For each named sticker, headless Chrome encodes the animation
// at 512, 384, 256, 192 and 128 pixels, each at the highest frame rate at which the file fits Signal's limit, with
// the app's own decoder and encoder, and also as the app converts it today and at full size without a limit.
// <out> gets the files and index.html, which shows them at the size Signal shows a sticker in a conversation. A
// tile can be chosen as the best of its sticker; served by serve-folder.mjs, the page keeps what was chosen in
// <out>/selections.json.

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const [originals, out, ...rest] = process.argv.slice(2);
// With --filters <key file>, each sticker is shown as the app converts it with each way of scaling video frames
// down. The page does not say which tile is which: the tiles of a sticker are in a random order under the letters
// A, B and C, and the key file, which belongs outside <out>, says which filter each letter stands for.
const keyFile = rest.includes('--filters') ? rest[rest.indexOf('--filters') + 1] : null;
const filters = keyFile !== null;
const ids = rest.filter((argument) => argument !== '--filters' && argument !== keyFile);
if (ids.length === 0 || (filters && !keyFile)) {
  throw new Error('usage: choices.mjs <originals> <out> [--filters <key file>] <pack ID>/<number> ...');
}
/** A run stops when the browsers have sent nothing for this long. */
const SILENCE_LIMIT_MS = 300_000;
const PROCESSES = 12;

const jobs = ids.map((id) => {
  const [pack, number] = id.split('/');
  const name = fs.readdirSync(path.join(originals, pack)).find((file) => file.startsWith(`${number}.`));
  if (!name) throw new Error(`no sticker ${id}`);
  const { title } = JSON.parse(fs.readFileSync(path.join(originals, pack, 'pack.json'), 'utf8'));
  return { id, format: name.split('.')[1], file: path.join(originals, pack, name), title };
});
const byId = new Map(jobs.map((job) => [job.id, job]));

const app = path.resolve(import.meta.dirname, '..');
const webmDecoder = path.resolve(app, '../build/webm-decoder');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'choices-site-'));
await build({
  entryPoints: ['measure/choices-page.ts', 'src/kinds/stickers/apng-worker.ts', 'src/kinds/stickers/webm-worker.ts'],
  entryNames: '[name]',
  absWorkingDir: app,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: root,
  alias: { 'webm-decoder': path.join(webmDecoder, 'webm-decoder.js') },
  external: ['node:*'],
  logLevel: 'warning',
});
fs.copyFileSync(path.join(webmDecoder, 'webm-decoder.wasm'), path.join(root, 'webm-decoder.wasm'));
fs.writeFileSync(
  path.join(root, 'index.html'),
  '<!doctype html><meta charset="utf-8"><script type="module" src="/choices-page.js"></script>',
);

function body(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

const queue = [...jobs];
const results = [];
let lastHeard = Date.now();
const fileName = (id, name) => path.join(out, `${id.replace('/', '-')}-${name}.png`);
fs.mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer(async (request, response) => {
  const answer = (status, type = 'text/plain', content = '') =>
    response.writeHead(status, { 'content-type': type }).end(content);
  try {
    lastHeard = Date.now();
    const url = new URL(request.url, 'http://x');
    const file = /^\/file\/(-?\d+\/\d+)\/([a-z0-9]+)$/.exec(url.pathname);
    const original = /^\/original\/(-?\d+\/\d+)$/.exec(url.pathname);
    if (request.method === 'POST' && file) {
      fs.writeFileSync(fileName(file[1], file[2]), await body(request));
      return answer(204);
    }
    if (request.method === 'POST' && url.pathname === '/result') {
      results.push(JSON.parse((await body(request)).toString('utf8')));
      console.log(`  ${results.length} of ${jobs.length}`);
      return answer(204);
    }
    if (url.pathname === '/job') {
      const job = queue.shift();
      if (!job) return answer(204);
      return answer(
        200,
        'application/json',
        JSON.stringify({ id: job.id, format: job.format, original: `/original/${job.id}` }),
      );
    }
    if (original && byId.has(original[1])) {
      return answer(200, 'application/octet-stream', fs.readFileSync(byId.get(original[1]).file));
    }
    const wanted = path.join(root, url.pathname.replace(/\/$/, '/index.html'));
    if (!wanted.startsWith(root) || !fs.existsSync(wanted)) return answer(404);
    answer(200, TYPES[path.extname(wanted)] ?? 'application/octet-stream', fs.readFileSync(wanted));
  } catch (error) {
    answer(500, 'text/plain', String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const browsers = [];
for (let i = 0; i < Math.min(PROCESSES, jobs.length); i++) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'choices-chrome-'));
  const child = spawn(
    process.env.CHROME ?? 'google-chrome-stable',
    ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', filters ? `${base}?mode=filters` : base],
    { stdio: 'ignore' },
  );
  browsers.push({ child, profile });
}
while (results.length < jobs.length && Date.now() - lastHeard < SILENCE_LIMIT_MS) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
for (const { child, profile } of browsers) {
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
  fs.rmSync(profile, { recursive: true, force: true });
}
server.close();
fs.rmSync(root, { recursive: true, force: true });
if (results.length < jobs.length) console.log(`stopped: ${jobs.length - results.length} stickers did not finish`);

/** How long one pass of an animated PNG file takes, in milliseconds: its number of frames times its first delay. */
function passMs(file) {
  const data = fs.readFileSync(file);
  let frames = 1;
  for (let at = 8; at + 12 <= data.length; at += 12 + data.readUInt32BE(at)) {
    const kind = data.toString('latin1', at + 4, at + 8);
    if (kind === 'acTL') frames = data.readUInt32BE(at + 8);
    // A frame's delay is a fraction of a second, kept after its sequence number, size and place.
    if (kind === 'fcTL')
      return Math.round((frames * 1000 * data.readUInt16BE(at + 28)) / (data.readUInt16BE(at + 30) || 100));
  }
  return 1000;
}

const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const bytes = (count) =>
  count >= 1024 * 1024 ? `${(count / 1024 / 1024).toFixed(1)} MiB` : `${Math.round(count / 1024)} KiB`;
const rate = (value) => `${Number(value.toFixed(1))} fps`;
// A tile that can be chosen names its sticker and what it is; the one without a limit is only for comparing.
const tile = (id, name, encoded, note = '') =>
  `<figure${note === 'today' ? ' class="today"' : ''}` +
  (note === 'no limit'
    ? ''
    : ` role="button" tabindex="0" aria-pressed="false" data-sticker="${id}" data-choice="${escape(encoded.label ?? `${encoded.size} px, ${rate(encoded.rate)}`)}"`) +
  `><img loading="lazy" src="${escape(path.basename(fileName(id, name)))}" alt="">` +
  `<figcaption>${encoded.label ? `${escape(encoded.label)} · ` : ''}${encoded.size} px · ${rate(encoded.rate)} · ${bytes(encoded.bytes)}${note ? ` · ${note}` : ''}</figcaption></figure>`;
/** A tile that says only its letter. */
const blindTile = (id, letter) =>
  `<figure role="button" tabindex="0" aria-pressed="false" data-sticker="${id}" data-choice="${letter}">` +
  `<img loading="lazy" src="${escape(path.basename(fileName(id, letter.toLowerCase())))}" alt="">` +
  `<figcaption>${letter}</figcaption></figure>`;
const key = {};
const sections = jobs.map((job) => {
  const result = results.find((candidate) => candidate.id === job.id);
  const number = job.id.split('/')[1];
  const kind = job.format === 'tgs' ? 'vector' : 'video';
  if (!result || result.error)
    return `<h2>${escape(job.title)} #${number}</h2><p>${escape(result?.error ?? 'not finished')}</p>`;
  if (filters) {
    const files = result.variants.map((variant) => fs.readFileSync(fileName(job.id, variant.name)));
    for (const variant of result.variants) fs.rmSync(fileName(job.id, variant.name));
    // A sticker that fits at full size is not scaled, so its three files are the same and there is nothing to choose.
    if (files.every((file) => file.equals(files[0]))) {
      fs.rmSync(fileName(job.id, 'full'));
      return '';
    }
    const order = result.variants.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    key[job.id] = {};
    const blind = order.map((variantNumber, position) => {
      const letter = 'ABC'[position];
      const { label, size, rate: frameRate, bytes: fileBytes } = result.variants[variantNumber];
      fs.writeFileSync(fileName(job.id, letter.toLowerCase()), files[variantNumber]);
      key[job.id][letter] = { filter: label, size, frameRate, bytes: fileBytes };
      return blindTile(job.id, letter);
    });
    const tiles = [...blind, tile(job.id, 'full', result.full, 'no limit')];
    return `<h2>${escape(job.title)} #${number} · ${kind} · ${result.duration.toFixed(1)} s</h2><div class="row" data-period="${passMs(fileName(job.id, 'full'))}">${tiles.join('')}</div>`;
  }
  const tiles = [
    ...result.variants.map((variant) => tile(job.id, variant.name ?? `${variant.size}`, variant)),
    ...(result.today === null
      ? []
      : result.today.error
        ? [`<figure class="today"><figcaption>today: does not fit</figcaption></figure>`]
        : [tile(job.id, 'today', result.today, 'today')]),
    tile(job.id, 'full', result.full, 'no limit'),
  ];
  return `<h2>${escape(job.title)} #${number} · ${kind} · ${result.duration.toFixed(1)} s</h2><div class="row" data-period="${passMs(fileName(job.id, 'full'))}">${tiles.join('')}</div>`;
});
fs.writeFileSync(
  path.join(out, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sticker size and frame rate</title>
<style>
:root { --background: #ffffff; --text: #1b1b1f; --muted: #5e5e66; --mark: #2c6bed; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --background: #1b1b1f; --text: #e9e9ee; --muted: #a0a0aa; --mark: #7aa5ff; }
}
:root[data-theme="dark"] { --background: #1b1b1f; --text: #e9e9ee; --muted: #a0a0aa; --mark: #7aa5ff; }
body { margin: 0; padding: 12px; background: var(--background); color: var(--text); font: 14px system-ui, sans-serif; }
h2 { font-size: 15px; margin: 28px 0 10px; }
.row { display: flex; flex-wrap: wrap; gap: 12px; }
figure { margin: 0; width: min(175px, calc((100vw - 36px) / 2)); }
img { width: 100%; aspect-ratio: 1; display: block; }
figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
.today figcaption { color: var(--mark); }
figure[role="button"] { cursor: pointer; }
figure[aria-pressed="true"] img { outline: 4px solid var(--mark); outline-offset: -4px; }
figure[aria-pressed="true"] figcaption { color: var(--text); font-weight: 600; }
#chosen { position: sticky; top: 0; margin: -12px -12px 0; padding: 8px 12px; background: var(--background); color: var(--muted); }
</style>
</head>
<body>
<div id="chosen"></div>
${sections.join('\n')}
<script src="tiles.js"></script>
</body>
</html>
`,
);
fs.copyFileSync(path.join(import.meta.dirname, 'tiles.js'), path.join(out, 'tiles.js'));
if (filters) {
  fs.writeFileSync(keyFile, JSON.stringify(key, null, 1));
  // Choices made on an earlier page were made under other letters.
  fs.rmSync(path.join(out, 'selections.json'), { force: true });
}
console.log(`${results.length} stickers, page at ${path.join(out, 'index.html')}`);
