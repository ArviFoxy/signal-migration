// Serves the test page and prints results the page posts to /log.
// HOST and PORT choose where it listens (default 127.0.0.1:8080). With TLS_CERT and TLS_KEY set
// it serves HTTPS, which a page opened from another machine needs: browsers disable WebCrypto
// on plain-HTTP pages unless they come from localhost.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm' };

function handle(request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'POST' && url.pathname === '/log') {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      console.log(body);
      response.end();
    });
    return;
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
}

const tls = process.env.TLS_CERT && process.env.TLS_KEY;
const server = tls
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handle)
  : http.createServer(handle);
server.listen(PORT, HOST, () => console.log(`${tls ? 'https' : 'http'}://${HOST}:${PORT}/`));
