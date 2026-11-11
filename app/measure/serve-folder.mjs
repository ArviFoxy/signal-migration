// Serves a folder of files over HTTPS, for looking at a page that choices.mjs made from another device, and keeps
// what is chosen on that page in <folder>/selections.json:
//
//   node measure/serve-folder.mjs <port> <address> <certificate.pem> <key.pem> <folder>

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const [port, address, certificate, key, folder] = process.argv.slice(2);
if (!folder) throw new Error('usage: serve-folder.mjs <port> <address> <certificate> <key> <folder>');
const root = path.resolve(folder);
const TYPES = { '.html': 'text/html', '.png': 'image/png', '.json': 'application/json' };
https
  .createServer({ cert: fs.readFileSync(certificate), key: fs.readFileSync(key) }, (request, response) => {
    const { pathname } = new URL(request.url, 'https://x');
    if (request.method === 'POST' && pathname.endsWith('/selections')) {
      const kept = path.join(root, decodeURIComponent(pathname), '..', 'selections.json');
      if (!kept.startsWith(root)) return response.writeHead(404).end();
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        try {
          const selections = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          fs.writeFileSync(kept, JSON.stringify(selections, null, 1));
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
      return;
    }
    const wanted = path.join(root, decodeURIComponent(pathname).replace(/\/$/, '/index.html'));
    if (!wanted.startsWith(root) || !fs.existsSync(wanted) || fs.statSync(wanted).isDirectory()) {
      return response.writeHead(404).end();
    }
    response.writeHead(200, { 'content-type': TYPES[path.extname(wanted)] ?? 'application/octet-stream' });
    fs.createReadStream(wanted).pipe(response);
  })
  .listen(Number(port), address, () => console.log(`serving ${root} on https://${address}:${port}/`));
