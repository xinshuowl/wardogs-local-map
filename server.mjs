import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve, sep } from 'node:path';

import { createRoomHandler } from './local-rooms.mjs';
import { createSteamPlayersService } from './steam-players.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const gzipExtensions = new Set(['.html', '.css', '.js', '.json', '.svg']);
const roomHandler = createRoomHandler(root);
const getSteamPlayers = createSteamPlayersService();
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.includes('\\')) { response.writeHead(403).end('Forbidden'); return; }
    if (await roomHandler(request, response, pathname)) return;
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
      return;
    }
    if (pathname === '/api/steam/players') {
      const content = JSON.stringify(await getSteamPlayers());
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(content), 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : content);
      return;
    }
    if (pathname === '/api/local/health') {
      const content = JSON.stringify({ app: 'wardogs-local-map', version: '3.0', backend: 'node', capabilities: ['local-rooms', 'sse'] });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(content), 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : content);
      return;
    }
    const filename = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(root + sep) || pathname.includes('\0') || pathname.split('/').some(segment => segment.startsWith('.'))) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const details = await stat(filename);
    if (!details.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    const etag = 'W/"' + details.size.toString(16) + '-' + details.mtimeMs.toString(16) + '"';
    const extension = extname(filename);
    const compressed = gzipExtensions.has(extension) && /(?:^|,)\s*gzip(?:\s*;|,|$)/i.test(request.headers['accept-encoding'] || '');
    const headers = { 'Content-Type': mimeTypes[extension] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ETag: etag, 'Last-Modified': details.mtime.toUTCString(), Vary: 'Accept-Encoding' };
    if (compressed) headers['Content-Encoding'] = 'gzip';
    const condition = request.headers['if-none-match'];
    const unchanged = condition ? condition.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag.replace(/^W\//, '')) : request.headers['if-modified-since'] && Math.floor(details.mtimeMs / 1000) <= Math.floor(Date.parse(request.headers['if-modified-since']) / 1000);
    if (unchanged) { response.writeHead(304, headers).end(); return; }
    response.writeHead(200, compressed ? headers : { ...headers, 'Content-Length': details.size });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(filename);
    stream.on('error', error => response.destroy(error));
    response.on('close', () => stream.destroy());
    if (compressed) stream.pipe(createGzip()).pipe(response);
    else stream.pipe(response);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end('Not found');
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT to another port and retry.` : error.message);
  process.exitCode = 1;
});
server.listen(port, process.env.MAP_HOST || '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + port;
  console.log('WARDOGS local map: ' + url + '\nPress Ctrl+C to stop.');
  if (process.argv.includes('--open') && process.platform === 'win32') {
    const browser = spawn('explorer.exe', [url], { detached: true, windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => console.log('Open the local URL manually.'));
    browser.unref();
  }
});
