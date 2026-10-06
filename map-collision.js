export function segmentBoxHit(start, end, bounds) {
  let enter = 0;
  let leave = 1;
  for (let axis = 0; axis < 3; axis++) {
    const delta = end[axis] - start[axis];
    if (Math.abs(delta) < 1e-9) {
      if (start[axis] < bounds[axis] || start[axis] > bounds[axis + 3]) return null;
      continue;
    }
    let near = (bounds[axis] - start[axis]) / delta;
    let far = (bounds[axis + 3] - start[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near);
    leave = Math.min(leave, far);
    if (enter > leave) return null;
  }
  return enter;
}

export function inverseInstancePoint(point, instance) {
  const offset = point.map((value, axis) => value - instance.position[axis]);
  const [quatX, quatY, quatZ, quatW] = instance.quaternion;
  const conjugate = [-quatX, -quatY, -quatZ];
  const cross = [conjugate[1] * offset[2] - conjugate[2] * offset[1], conjugate[2] * offset[0] - conjugate[0] * offset[2], conjugate[0] * offset[1] - conjugate[1] * offset[0]];
  const doubled = cross.map(value => value * 2);
  const rotation = [conjugate[1] * doubled[2] - conjugate[2] * doubled[1], conjugate[2] * doubled[0] - conjugate[0] * doubled[2], conjugate[0] * doubled[1] - conjugate[1] * doubled[0]];
  return offset.map((value, axis) => (value + quatW * doubled[axis] + rotation[axis]) / (instance.scale[axis] || 1));
}

export function instanceHit(start, end, instance) {
  return segmentBoxHit(inverseInstancePoint(start, instance), inverseInstancePoint(end, instance), instance.bounds);
}

export function mapWorldPoint(map, point, height = point[2]) {
  const metres = map.bounds[2] / 100;
  return [map.bounds[0] / 100 + point[0] / 2048 * metres, height, map.bounds[1] / 100 + point[1] / 2048 * metres];
}

export function worldMapPoint(map, point) {
  return [(point[0] * 100 - map.bounds[0]) / map.bounds[2] * 2048, (point[2] * 100 - map.bounds[1]) / map.bounds[2] * 2048, point[1]];
}

export function trajectoryObstruction(path, instances, heightAt) {
  if (path.length < 2) return { blocked: false };
  const origin = path[0];
  const target = path.at(-1);
  const endpoint = point => Math.hypot(point[0] - origin[0], point[2] - origin[2]) < 1.5 || Math.hypot(point[0] - target[0], point[2] - target[2]) < 1.5;
  if (Math.hypot(...origin.map((value, axis) => value - target[axis])) < 5) return { blocked: false };
  const minimum = [0, 2].map(axis => Math.min(...path.map(point => point[axis])));
  const maximum = [0, 2].map(axis => Math.max(...path.map(point => point[axis])));
  const candidates = instances.filter(instance => instance.position[0] + instance.radius >= minimum[0] && instance.position[0] - instance.radius <= maximum[0] && instance.position[2] + instance.radius >= minimum[1] && instance.position[2] - instance.radius <= maximum[1]);
  for (let index = 0; index < path.length - 1; index++) {
    const start = path[index];
    const end = path[index + 1];
    if (endpoint(start) && endpoint(end)) continue;
    let closest = null;
    let fraction = Infinity;
    const midpoint = start.map((value, axis) => (value + end[axis]) / 2);
    const halfLength = Math.hypot(...end.map((value, axis) => value - start[axis])) / 2;
    for (const instance of candidates) {
      const radius = instance.radius + halfLength;
      if ((midpoint[0] - instance.position[0]) ** 2 + (midpoint[2] - instance.position[2]) ** 2 > radius ** 2 || Math.abs(midpoint[1] - instance.position[1]) > radius) continue;
      const hit = instanceHit(start, end, instance);
      if (hit === null || hit >= fraction) continue;
      const point = start.map((value, axis) => value + (end[axis] - value) * hit);
      if (!endpoint(point)) { closest = { blocked: true, reason: 'object', point, name: instance.name }; fraction = hit; }
    }
    if (closest) return closest;
  }
  for (let index = 0; index < path.length - 1; index++) {
    const fraction = index / (path.length - 1);
    if (fraction <= .03 || fraction >= .97) continue;
    for (const point of [path[index], path[index].map((value, axis) => (value + path[index + 1][axis]) / 2)]) {
      const ground = heightAt(point[0], point[2]);
      if (Number.isFinite(ground) && point[1] <= ground) return { blocked: true, reason: 'terrain', point: [point[0], ground, point[2]] };
    }
  }
  return { blocked: false };
}

export class MapCollision {
  constructor() { this.maps = new Map(); }

  async record(map) {
    if (!this.maps.has(map.id)) this.maps.set(map.id, fetch('./assets/models/' + map.id + '/manifest.json').then(async response => {
      if (!response.ok) throw new Error('碰撞模型清单缺失');
      const manifest = await response.json();
      return { manifest, tiles: new Map(), jobs: new Map(), available: new Map(manifest.tiles.map(tile => [tile.key, tile])) };
    }).catch(error => { this.maps.delete(map.id); throw error; }));
    return this.maps.get(map.id);
  }

  async loadTile(map, record, key) {
    if (record.tiles.has(key)) return record.tiles.get(key);
    if (!record.available.has(key)) return [];
    if (!record.jobs.has(key)) record.jobs.set(key, (async () => {
      const tile = record.available.get(key);
      const response = await fetch('./assets/models/' + map.id + '/' + tile.file);
      if (!response.ok) throw new Error('碰撞区块缺失：' + key);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== tile.bytes) throw new Error('碰撞区块长度错误');
      const header = new DataView(buffer);
      const groupCount = header.getUint32(0, true);
      let offset = (groupCount * 2 + 1) * 4;
      const instances = [];
      for (let group = 0; group < groupCount; group++) {
        const mesh = record.manifest.meshes[header.getUint32(4 + group * 8, true)];
        const count = header.getUint32(8 + group * 8, true);
        if (offset + count * 44 > buffer.byteLength) throw new Error('碰撞区块位置数据越界');
        if (!mesh?.solid || !mesh.bounds) { offset += count * 44; continue; }
        for (let index = 0; index < count; index++) {
          const values = Array.from({ length: 11 }, (_, component) => header.getFloat32(offset + component * 4, true));
          offset += 44;
          if (!mesh?.solid || !mesh.bounds) continue;
          const scale = values.slice(7, 10);
          const radius = Math.hypot(...[0, 1, 2].map(axis => Math.max(Math.abs(mesh.bounds[axis]), Math.abs(mesh.bounds[axis + 3])) * scale[axis]));
          instances.push({ position: values.slice(0, 3), quaternion: values.slice(3, 7), scale, bounds: mesh.bounds, radius, name: mesh.name });
        }
      }
      if (offset !== buffer.byteLength) throw new Error('碰撞区块位置数据长度异常');
      record.tiles.set(key, instances);
      this.indexInstances(record, instances);
      return instances;
    })().catch(error => { record.jobs.delete(key); throw error; }));
    return record.jobs.get(key);
  }

  keys(record, points, margin = 30) {
    const keys = new Set();
    const origin = record.manifest.originMetres;
    const size = record.manifest.tileSizeMetres;
    for (const point of points) for (const horizontal of [-margin, 0, margin]) for (const vertical of [-margin, 0, margin]) {
      const key = Math.floor((point[0] + horizontal - origin[0]) / size) + '_' + Math.floor((point[2] + vertical - origin[1]) / size);
      if (record.available.has(key)) keys.add(key);
    }
    return [...keys];
  }

  async check(map, paths, heightAt) {
    const record = await this.record(map);
    const points = paths.flatMap(path => path.points.map(point => mapWorldPoint(map, point)));
    const keys = this.keys(record, points, 128);
    const groups = [];
    for (let index = 0; index < keys.length; index += 6) groups.push(...await Promise.all(keys.slice(index, index + 6).map(key => this.loadTile(map, record, key))));
    const instances = groups.flat();
    return Object.fromEntries(paths.map(path => {
      const obstruction = trajectoryObstruction(path.points.map(point => mapWorldPoint(map, point)), instances, (horizontal, vertical) => heightAt(worldMapPoint(map, [horizontal, 0, vertical])));
      return [path.arc, { ...obstruction, point: obstruction.point ? worldMapPoint(map, obstruction.point) : null }];
    }));
  }

  async warm(map, point) {
    const record = await this.record(map);
    await Promise.all(this.keys(record, [point], 60).map(key => this.loadTile(map, record, key)));
    return record;
  }

  indexInstances(record, instances) {
    record.spatial ||= { cells: new Map(), overflow: new Set(), instances: new Set(), size: 64, lastCandidates: 0 };
    const spatial = record.spatial;
    for (const instance of instances) {
      if (spatial.instances.has(instance)) continue;
      spatial.instances.add(instance);
      const left = Math.floor((instance.position[0] - instance.radius) / spatial.size); const right = Math.floor((instance.position[0] + instance.radius) / spatial.size);
      const top = Math.floor((instance.position[2] - instance.radius) / spatial.size); const bottom = Math.floor((instance.position[2] + instance.radius) / spatial.size);
      if (![left, right, top, bottom].every(Number.isFinite) || (right - left + 1) * (bottom - top + 1) > 256) { spatial.overflow.add(instance); continue; }
      for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) {
        const key = column + ':' + row;
        if (!spatial.cells.has(key)) spatial.cells.set(key, new Set());
        spatial.cells.get(key).add(instance);
      }
    }
  }

  nearby(record, point, radius = 8) {
    if (!record || ![point[0], point[2], radius].every(Number.isFinite)) return [];
    if (!record.spatial) this.indexInstances(record, [...record.tiles.values()].flat());
    const spatial = record.spatial; const margin = Math.max(0, radius);
    const left = Math.floor((point[0] - margin) / spatial.size); const right = Math.floor((point[0] + margin) / spatial.size);
    const top = Math.floor((point[2] - margin) / spatial.size); const bottom = Math.floor((point[2] + margin) / spatial.size);
    let selected;
    if ((right - left + 1) * (bottom - top + 1) > 512) selected = spatial.instances;
    else {
      selected = new Set(spatial.overflow);
      for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) for (const instance of spatial.cells.get(column + ':' + row) || []) selected.add(instance);
    }
    spatial.lastCandidates = selected.size;
    const nearby = [];
    for (const instance of selected) {
      const distance = instance.radius + radius;
      if (distance >= 0 && (instance.position[0] - point[0]) ** 2 + (instance.position[2] - point[2]) ** 2 <= distance ** 2) nearby.push(instance);
    }
    return nearby;
  }
}
