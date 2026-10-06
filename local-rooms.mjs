import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { validShape } from './tactical-drawing.js';

export function createRoomHandler(root) {
  const rooms = new Map();
  const directory = join(root, '.local-data', 'rooms');
  const json = (response, status, record) => { const body = JSON.stringify(record); response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); response.end(body); };
  async function getRoom(name) {
    if (!rooms.has(name)) {
      if (rooms.size >= 64) throw new Error('Too many active rooms');
      rooms.set(name, (async () => {
        let record = { revision: 0, client: '', shapes: [] };
        try { const stored = JSON.parse(await readFile(join(directory, name + '.json'), 'utf8')); if (Number.isInteger(stored.revision) && Array.isArray(stored.shapes) && stored.shapes.length <= 500 && stored.shapes.every(validShape)) record = stored; } catch {}
        return { record, listeners: new Set(), queue: Promise.resolve() };
      })());
    }
    return rooms.get(name);
  }
  return async (request, response, pathname) => {
    const match = pathname.match(/^\/api\/local\/rooms\/([a-z0-9-]{3,40})(\/events)?$/);
    if (!match) return false;
    if (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) { json(response, 403, { error: 'Cross-origin writes are not allowed' }); return true; }
    try {
      const room = await getRoom(match[1]);
      if (request.method === 'GET' && match[2]) {
        if (room.listeners.size >= 12) { json(response, 429, { error: 'Room connection limit reached' }); return true; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write('event: state\ndata: ' + JSON.stringify(room.record) + '\n\n'); room.listeners.add(response);
        const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
        request.on('close', () => { clearInterval(heartbeat); room.listeners.delete(response); });
      } else if (request.method === 'GET' && !match[2]) json(response, 200, room.record);
      else if (request.method === 'POST' && !match[2]) {
        if (!request.headers['content-type']?.startsWith('application/json')) { json(response, 415, { error: 'JSON required' }); return true; }
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 8000000) { json(response, 413, { error: 'Room payload too large' }); return true; } chunks.push(chunk); }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(response, 400, { error: 'Invalid JSON' }); return true; }
        if (!Number.isInteger(data.revision) || typeof data.client !== 'string' || !/^client-[a-z0-9-]{1,60}$/i.test(data.client) || !Array.isArray(data.shapes) || data.shapes.length > 500 || !data.shapes.every(validShape) || new Set(data.shapes.map(shape => shape.id)).size !== data.shapes.length) { json(response, 400, { error: 'Invalid room data' }); return true; }
        room.queue = room.queue.catch(() => {}).then(async () => {
          if (data.revision !== room.record.revision) { json(response, 409, room.record); return; }
          const next = { revision: room.record.revision + 1, client: data.client, shapes: data.shapes };
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, match[1] + '.json.tmp'), JSON.stringify(next));
          await rename(join(directory, match[1] + '.json.tmp'), join(directory, match[1] + '.json'));
          room.record = next;
          for (const listener of room.listeners) listener.write('event: state\ndata: ' + JSON.stringify(next) + '\n\n');
          json(response, 200, next);
        });
        await room.queue;
      } else json(response, 405, { error: 'Method not allowed' });
    } catch (error) { if (!response.headersSent) json(response, 500, { error: error.message }); else response.end(); }
    return true;
  };
}

