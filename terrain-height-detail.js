let manifestPromise;
export function sceneManifest() {
  manifestPromise ||= fetch('./assets/scene-manifest.json').then(response => { if (!response.ok) throw new Error('精细场景清单缺失'); return response.json(); }).catch(error => { manifestPromise = null; throw error; });
  return manifestPromise;
}

export class DetailHeightStore {
  constructor() { this.maps = new Map(); }
  async record(map) {
    if (!this.maps.has(map.id)) this.maps.set(map.id, sceneManifest().then(manifest => ({ descriptor: manifest[map.id]?.detail || null, tiles: new Map(), jobs: new Map(), version: 0 })).catch(error => { this.maps.delete(map.id); throw error; }));
    const record = await this.maps.get(map.id); this[map.id] = record; return record;
  }
  version(mapId) { return this[mapId]?.version || 0; }
  coordinates(map, descriptor, position) {
    return position.map((value, axis) => Math.max(0, Math.min((axis ? descriptor.rows : descriptor.cols) - 1, (map.bounds[axis] + value / 2048 * map.bounds[2] - descriptor.origin[axis]) / descriptor.step[axis])));
  }
  sampleRaw(record, column, row) {
    const descriptor = record.descriptor; const columnTile = Math.floor(column / descriptor.samples); const rowTile = Math.floor(row / descriptor.samples);
    let cached = record.sampleTile;
    if (!cached || cached.column !== columnTile || cached.row !== rowTile) {
      const key = columnTile + '_' + rowTile; const tile = record.tiles.get(key); if (!tile) return null;
      cached = { column: columnTile, row: rowTile, key, tile }; record.sampleTile = cached;
    }
    cached.tile.lastUsed = record.accessVersion = (record.accessVersion || 0) + 1;
    return cached.tile.values[(row - rowTile * descriptor.samples) * cached.tile.width + column - columnTile * descriptor.samples];
  }
  sample(map, position) {
    const record = this[map.id]; if (!record?.descriptor) return null;
    const descriptor = record.descriptor;
    const column = Math.max(0, Math.min(descriptor.cols - 1, (map.bounds[0] + position[0] / 2048 * map.bounds[2] - descriptor.origin[0]) / descriptor.step[0]));
    const row = Math.max(0, Math.min(descriptor.rows - 1, (map.bounds[1] + position[1] / 2048 * map.bounds[2] - descriptor.origin[1]) / descriptor.step[1]));
    const left = Math.floor(column); const top = Math.floor(row); const right = Math.min(left + 1, descriptor.cols - 1); const bottom = Math.min(top + 1, descriptor.rows - 1);
    const upperLeft = this.sampleRaw(record, left, top); const upperRight = this.sampleRaw(record, right, top);
    const lowerLeft = this.sampleRaw(record, left, bottom); const lowerRight = this.sampleRaw(record, right, bottom);
    if (upperLeft === null || upperRight === null || lowerLeft === null || lowerRight === null) return null;
    const horizontal = column - left; const vertical = row - top;
    const upper = upperLeft * (1 - horizontal) + upperRight * horizontal; const lower = lowerLeft * (1 - horizontal) + lowerRight * horizontal;
    return (descriptor.heightOffset + (upper * (1 - vertical) + lower * vertical - 32768) * descriptor.heightScale) / 100;
  }
  async tile(record, column, row) {
    const descriptor = record.descriptor; const key = column + '_' + row;
    if (record.tiles.has(key)) { record.tiles.get(key).lastUsed = record.accessVersion = (record.accessVersion || 0) + 1; return; }
    if (!record.jobs.has(key)) record.jobs.set(key, (async () => {
      const response = await fetch('./' + descriptor.directory + '/' + key + '.bin'); if (!response.ok) throw new Error('精细高度区块缺失：' + key);
      const buffer = await response.arrayBuffer(); const width = Math.min(descriptor.samples, descriptor.cols - column * descriptor.samples); const height = Math.min(descriptor.samples, descriptor.rows - row * descriptor.samples);
      if (buffer.byteLength !== width * height * 2) throw new Error('精细高度区块长度无效');
      const view = new DataView(buffer); const values = new Uint16Array(width * height); for (let index = 0; index < values.length; index++) values[index] = view.getUint16(index * 2, true);
      record.tiles.set(key, { width, height, values, lastUsed: record.accessVersion = (record.accessVersion || 0) + 1 }); record.version++;
      while (record.tiles.size > 128) {
        let oldest; let oldestAccess = Infinity;
        for (const [tileKey, tile] of record.tiles) if ((tile.lastUsed || 0) < oldestAccess) { oldest = tileKey; oldestAccess = tile.lastUsed || 0; }
        record.tiles.delete(oldest); if (record.sampleTile?.key === oldest) record.sampleTile = null;
      }
    })().finally(() => record.jobs.delete(key)));
    await record.jobs.get(key);
  }
  async ensure(map, positions, radius = 0) {
    const record = await this.record(map); if (!record.descriptor) return false;
    const descriptor = record.descriptor; const keys = new Map(); const margin = radius / descriptor.sampleMetres;
    for (const position of positions) {
      const [column, row] = this.coordinates(map, descriptor, position);
      const left = Math.max(0, Math.floor((column - margin) / descriptor.samples)); const right = Math.min(descriptor.tilesX - 1, Math.floor((column + margin + 1) / descriptor.samples));
      const top = Math.max(0, Math.floor((row - margin) / descriptor.samples)); const bottom = Math.min(descriptor.tilesY - 1, Math.floor((row + margin + 1) / descriptor.samples));
      for (let vertical = top; vertical <= bottom; vertical++) for (let horizontal = left; horizontal <= right; horizontal++) keys.set(horizontal + '_' + vertical, [horizontal, vertical]);
    }
    const pending = [...keys.values()];
    for (let index = 0; index < pending.length; index += 6) await Promise.all(pending.slice(index, index + 6).map(([column, row]) => this.tile(record, column, row)));
    return true;
  }
}
export const detailHeights = new DetailHeightStore();
