import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'promotional-video');
await mkdir(resolve(output, 'review'), { recursive: true });
let encoder;
let completed;
let nextFrame = 0;
let encoderLog = '';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:4181');
    if (request.method === 'POST') {
      if (request.headers.origin !== 'http://127.0.0.1:4181') { response.writeHead(403).end(); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('Frame exceeds size limit'); chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      if (url.pathname === '/capture/start') {
        if (encoder) throw new Error('Render already running');
        nextFrame = 0;
        encoderLog = '';
        encoder = spawn('ffmpeg', ['-hide_banner', '-y', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(output, 'video-only.mp4')], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        encoder.stderr.on('data', data => { encoderLog += data.toString(); });
        encoder.stdin.on('error', () => {});
        completed = once(encoder, 'close');
      } else if (url.pathname === '/capture/frame') {
        if (!encoder || Number(url.searchParams.get('index')) !== nextFrame || nextFrame >= 1800) throw new Error('Unexpected frame');
        if (encoder.exitCode !== null) throw new Error(encoderLog);
        if ([90, 270, 480, 675, 810, 1035, 1305, 1500, 1695].includes(nextFrame)) await writeFile(resolve(output, 'review', `frame-${String(nextFrame).padStart(4, '0')}.jpg`), body);
        if (!encoder.stdin.write(body)) await once(encoder.stdin, 'drain');
        nextFrame++;
      } else if (url.pathname === '/capture/finish') {
        if (!encoder || nextFrame !== 1800) throw new Error('Incomplete render');
        encoder.stdin.end();
        const [code] = await completed;
        encoder = null;
        await writeFile(resolve(output, 'review', 'encoder.log'), encoderLog);
        if (code !== 0) throw new Error(encoderLog);
      } else if (url.pathname === '/capture/still') {
        const name = url.searchParams.get('name');
        if (!/^[a-z0-9-]{1,50}$/.test(name)) throw new Error('Invalid still name');
        await writeFile(resolve(output, 'review', name + '.jpg'), body);
      } else { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ frames: nextFrame }));
      return;
    }
    if (url.pathname === '/capture/status') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ frames: nextFrame, rendering: Boolean(encoder) })); return; }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/promotional-video/source/stage.html' : url.pathname);
    const filename = resolve(root, '.' + pathname);
    if (!filename.startsWith(root + sep) || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) { response.writeHead(403).end(); return; }
    const info = await stat(filename);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': mime[extname(filename)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
    createReadStream(filename).pipe(response);
  } catch (error) { response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message); }
});
server.listen(4181, '127.0.0.1', () => console.log('Promo renderer: http://127.0.0.1:4181/'));
process.on('SIGINT', () => { encoder?.kill(); server.close(); process.exit(); });
