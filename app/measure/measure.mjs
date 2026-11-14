// Measures the picture comparison on real stickers, to choose its tolerances (compare-pictures.ts):
//
//   node measure/measure.mjs <originals> <results> [--processes N] [--limit N] [--browsers chrome,firefox]
//   node measure/measure.mjs <originals> <results> --summary
//
// <originals> is the folder serve-export.mjs fills. Every animated sticker and every still sticker above Signal's
// size limit is converted by the app's own code in headless Chrome and in headless Firefox, and each converted file
// is compared with its original twice: in the browser that made it, and in the other browser, which draws the
// original its own way. An honest copy that a user's browser compares was made in some other browser, so the
// second number is the one the tolerance has to cover.
//
// <results>/results.jsonl gets one line per measurement, as it is made; <results>/conversions the converted files.
// A measurement that is already in results.jsonl is not made again, so a run that stopped can be started again.
// After a change to the conversion or the comparison, start with an empty <results>.
//
// Last, every fifth animation that Chrome converted is altered in ways a replaced copy could differ (a spot, a
// line, a veil, another colour, the picture moved), and each altered file is measured against its original. The
// summary says which share of them the comparison would accept.

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const [originals, results, ...flags] = process.argv.slice(2);
if (!results) throw new Error('usage: measure.mjs <originals> <results> [--processes N] [--limit N] [--summary]');
const flag = (name, fallback) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : fallback);
const processes = Number(flag('--processes', 8));
const limit = Number(flag('--limit', Infinity));
const browsers = flag('--browsers', 'chrome,firefox').split(',');
/** Signal's limit for one sticker file; a still within it is uploaded as it is and compared byte for byte. */
const MAX_STICKER_BYTES = 300 * 1024;
/** A run stops when no browser has answered for this long. */
const SILENCE_LIMIT_MS = 300_000;
const resultsFile = path.join(results, 'results.jsonl');
fs.mkdirSync(path.join(results, 'conversions'), { recursive: true });

const readResults = () =>
  fs.existsSync(resultsFile)
    ? fs
        .readFileSync(resultsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

function summary() {
  const rows = readResults();
  const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const groups = new Map();
  for (const row of rows.filter((row) => row.phase !== 'altered')) {
    const made = row.phase === 'convert' ? row.browser : row.madeBy;
    const key = `${row.format.padEnd(5)} made in ${made.padEnd(8)} compared in ${row.browser.padEnd(8)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  console.log('difference between a converted sticker and its original, on the scale of 0 to 255');
  for (const [key, group] of [...groups].sort()) {
    const measured = group.filter((row) => typeof row.difference === 'number');
    const sorted = measured.map((row) => row.difference).sort((a, b) => a - b);
    const refused = group.filter((row) => row.difference === null).length;
    const errors = group.filter((row) => row.error !== undefined);
    const show = (value) => (value === undefined ? '-' : value.toFixed(2).padStart(6));
    console.log(
      `${key}  n=${String(measured.length).padStart(5)}  median ${show(quantile(sorted, 0.5))}  99% ${show(quantile(sorted, 0.99))}` +
        `  99.9% ${show(quantile(sorted, 0.999))}  largest ${show(sorted.at(-1))}  not a conversion ${refused}  failed ${errors.length}`,
    );
    for (const row of measured.sort((a, b) => b.difference - a.difference).slice(0, 5)) {
      console.log(`      ${row.difference.toFixed(2).padStart(6)}  ${row.id}`);
    }
    for (const message of new Set(errors.map((row) => row.error))) console.log(`      failed: ${message}`);
  }
  const converted = rows.filter((row) => row.phase === 'convert' && row.convertMs !== undefined);
  for (const browser of new Set(converted.map((row) => row.browser))) {
    for (const format of new Set(converted.map((row) => row.format))) {
      const group = converted.filter((row) => row.browser === browser && row.format === format);
      if (group.length === 0) continue;
      const mean = (field) => group.reduce((sum, row) => sum + row[field], 0) / group.length;
      const notPlain = group.filter((row) => !row.plain).length;
      console.log(
        `${format.padEnd(5)} in ${browser.padEnd(8)} n=${String(group.length).padStart(5)}  converting ${mean('convertMs').toFixed(0)} ms` +
          `  comparing ${mean('compareMs').toFixed(0)} ms each on average  files with more than the picture: ${notPlain}`,
      );
    }
  }
  const altered = rows.filter((row) => row.altered);
  if (altered.length === 0) return;
  const tolerance = altered[0].tolerance;
  const failed = rows.filter((row) => row.phase === 'altered' && !row.altered).length;
  console.log(
    `altered copies of ${altered.length} animations (${failed} failed): the share within the tolerance of ${tolerance}`,
  );
  for (const alteration of Object.keys(altered[0].altered)) {
    const sorted = altered.map((row) => row.altered[alteration]).sort((a, b) => a - b);
    const within = sorted.filter((value) => value <= tolerance).length;
    console.log(
      `  ${alteration.padEnd(44)} ${String(Math.round((100 * within) / sorted.length)).padStart(3)}%` +
        `   smallest ${sorted[0].toFixed(1).padStart(5)}  median ${quantile(sorted, 0.5).toFixed(1).padStart(5)}`,
    );
  }
}

if (flags.includes('--summary')) {
  summary();
  process.exit(0);
}

// Every animated sticker, and every still above the limit, as <pack ID>/<number>.
const jobs = [];
for (const pack of fs.readdirSync(originals).sort()) {
  if (!fs.existsSync(path.join(originals, pack, 'pack.json'))) continue;
  for (const file of fs.readdirSync(path.join(originals, pack)).sort()) {
    const [number, format] = file.split('.');
    if (format !== 'tgs' && format !== 'webm' && format !== 'webp') continue;
    if (format === 'webp' && fs.statSync(path.join(originals, pack, file)).size <= MAX_STICKER_BYTES) continue;
    jobs.push({ id: `${pack}/${number}`, format, file: path.join(originals, pack, file) });
  }
}
// With a limit, the stickers are taken evenly from the whole list, so that every pack contributes.
const chosen =
  jobs.length <= limit ? jobs : Array.from({ length: limit }, (_, i) => jobs[Math.floor((i * jobs.length) / limit)]);
const byId = new Map(chosen.map((job) => [job.id, job]));
console.log(`${jobs.length} stickers to measure, ${chosen.length} chosen`);

const app = path.resolve(import.meta.dirname, '..');
const webmDecoder = path.resolve(app, '../build/webm-decoder');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-site-'));
await build({
  entryPoints: ['measure/measure-page.ts', 'src/kinds/stickers/apng-worker.ts', 'src/kinds/stickers/webm-worker.ts'],
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
  '<!doctype html><meta charset="utf-8"><script type="module" src="/measure-page.js"></script>',
);

const conversionFile = (browser, id) => path.join(results, 'conversions', browser, `${id}.bin`);
const measured = new Set(readResults().map((row) => `${row.phase}|${row.browser}|${row.id}`));
const queues = new Map();
let outstanding = 0;
let lastAnswer = Date.now();
let answered = 0;
let total = 0;
let phaseStarted = Date.now();

function body(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = http.createServer(async (request, response) => {
  const answer = (status, type = 'text/plain', content = '') =>
    response.writeHead(status, { 'content-type': type }).end(content);
  try {
    const url = new URL(request.url, 'http://x');
    const conversion = /^\/conversion\/(chrome|firefox)\/(-?\d+\/\d+)$/.exec(url.pathname);
    const original = /^\/original\/(-?\d+\/\d+)$/.exec(url.pathname);
    if (request.method === 'POST' && conversion) {
      const file = conversionFile(conversion[1], conversion[2]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, await body(request));
      return answer(204);
    }
    if (request.method === 'POST' && url.pathname === '/result') {
      fs.appendFileSync(resultsFile, `${(await body(request)).toString('utf8')}\n`);
      outstanding--;
      lastAnswer = Date.now();
      if (++answered % 100 === 0 || answered === total) {
        const elapsed = (Date.now() - phaseStarted) / 1000;
        const left = (elapsed / answered) * (total - answered);
        console.log(`  ${answered} of ${total} after ${elapsed.toFixed(0)} s, about ${left.toFixed(0)} s left`);
      }
      return answer(204);
    }
    if (url.pathname === '/job') {
      const job = queues.get(`${url.searchParams.get('phase')}|${url.searchParams.get('browser')}`)?.shift();
      if (!job) return answer(204);
      outstanding++;
      return answer(200, 'application/json', JSON.stringify(job));
    }
    if (conversion)
      return answer(200, 'application/octet-stream', fs.readFileSync(conversionFile(conversion[1], conversion[2])));
    if (original && byId.has(original[1]))
      return answer(200, 'application/octet-stream', fs.readFileSync(byId.get(original[1]).file));
    const wanted = path.join(root, url.pathname.replace(/\/$/, '/index.html'));
    if (!wanted.startsWith(root) || !fs.existsSync(wanted)) return answer(404);
    answer(200, TYPES[path.extname(wanted)] ?? 'application/octet-stream', fs.readFileSync(wanted));
  } catch (error) {
    answer(500, 'text/plain', String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

/** Starts a headless browser on `url` with a profile of its own; resolves to a function that stops it. */
function open(browser, url) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `measure-${browser}-`));
  const [command, args] =
    browser === 'chrome'
      ? [
          process.env.CHROME ?? 'google-chrome-stable',
          ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', url],
        ]
      : [process.env.FIREFOX ?? 'firefox', ['--headless', '--no-remote', '--profile', profile, url]];
  const child = spawn(command, args, { stdio: 'ignore' });
  return () =>
    new Promise((resolve) => {
      child.once('exit', () => {
        fs.rmSync(profile, { recursive: true, force: true });
        resolve();
      });
      child.kill();
    });
}

/** Hands the jobs of one phase to the browsers and waits until every job has an answer. */
async function runPhase(phase, jobsOf) {
  total = 0;
  for (const browser of browsers) {
    const queue = jobsOf(browser).filter((job) => !measured.has(`${phase}|${browser}|${job.id}`));
    queues.set(`${phase}|${browser}`, queue);
    total += queue.length;
  }
  console.log(`${phase}: ${total} measurements to make`);
  if (total === 0) return;
  answered = 0;
  outstanding = 0;
  phaseStarted = lastAnswer = Date.now();
  const stops = [];
  for (const browser of browsers) {
    const count = Math.min(processes, queues.get(`${phase}|${browser}`).length);
    for (let i = 0; i < count; i++) stops.push(open(browser, `${base}?browser=${browser}&phase=${phase}`));
  }
  while (answered < total && Date.now() - lastAnswer < SILENCE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (answered < total)
    console.log(`${phase}: stopped, no answer for ${SILENCE_LIMIT_MS / 1000} s; ${total - answered} left`);
  await Promise.all(stops.map((stop) => stop()));
}

const job = ({ id, format }) => ({ id, format, original: `/original/${id}` });
await runPhase('convert', () => chosen.map(job));
await runPhase('cross', (browser) =>
  browsers
    .filter((other) => other !== browser)
    .flatMap((other) =>
      chosen
        .filter(({ id }) => fs.existsSync(conversionFile(other, id)))
        .map((made) => ({ ...job(made), conversion: `/conversion/${other}/${made.id}`, madeBy: other })),
    ),
);
await runPhase('altered', (browser) =>
  browser === 'chrome'
    ? chosen
        .filter(({ id, format }) => format !== 'webp' && fs.existsSync(conversionFile('chrome', id)))
        .filter((_, number) => number % 5 === 0)
        .map((made) => ({ ...job(made), conversion: `/conversion/chrome/${made.id}`, madeBy: 'chrome' }))
    : [],
);
server.close();
fs.rmSync(root, { recursive: true, force: true });
summary();
