// web-server.mjs
//
// Minimal static host for the v2 web app. Serves public/v2 with correct MIME
// types and an SPA fallback. This is exactly what a static deployment
// (Netlify, Vercel, Cloudflare Pages, or a plain nginx root) does — the
// script exists so you can run `npm run web:serve` locally before pointing
// trebu.ratimics.com at whatever static host you land on.

import http from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'v2',
);
const PORT = Number(process.env.PORT || 4173);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveFile(res, filePath) {
  const stat = statSync(filePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
  });
  createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer((request, response) => {
  const urlPath = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  const decoded = decodeURIComponent(urlPath);
  const requested = path.normalize(decoded).replace(/^([.][.][/\\])+/, '');
  let filePath = path.join(ROOT, requested);

  if (requested.endsWith('/') || requested === '' ) {
    filePath = path.join(filePath, 'index.html');
  }
  if (serveFile(response, filePath)) return;

  // SPA fallback: any unknown path renders the shell.
  if (existsSync(path.join(ROOT, 'index.html'))) {
    serveFile(response, path.join(ROOT, 'index.html'));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Trebuchet web client serving ${ROOT}`);
  console.log(`http://127.0.0.1:${PORT}/`);
});