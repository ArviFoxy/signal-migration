// Serves the test page on this computer only, and prints results the page posts to /log.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

http
  .createServer((request, response) => {
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
  })
  .listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}/`));
