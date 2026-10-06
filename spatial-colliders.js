import * as THREE from './vendor/three/three.module.js';

export class SpatialColliders {
  constructor(cellSize = 4) {
    this.cellSize = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 4;
    this.cells = new Map();
    this.groups = new Map();
    this.entries = new Set();
    this.overflow = new Set();
    this.point = new THREE.Vector3();
    this.lastCandidates = 0;
  }

  clear() {
    this.cells.clear(); this.groups.clear(); this.entries.clear(); this.overflow.clear();
    this.lastCandidates = 0;
  }

  removeGroup(identifier) {
    for (const entry of this.groups.get(identifier) || []) {
      this.entries.delete(entry); this.overflow.delete(entry);
      for (const key of entry.keys) {
        const cell = this.cells.get(key); cell?.delete(entry);
        if (!cell?.size) this.cells.delete(key);
      }
    }
    this.groups.delete(identifier);
  }

  setGroup(identifier, objects) {
    this.removeGroup(identifier);
    const entries = [];
    for (const object of objects) {
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const bounds = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
      if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) continue;
      const entry = { object, bounds, keys: [] };
      const left = Math.floor(bounds.min.x / this.cellSize); const right = Math.floor(bounds.max.x / this.cellSize);
      const top = Math.floor(bounds.min.z / this.cellSize); const bottom = Math.floor(bounds.max.z / this.cellSize);
      if ((right - left + 1) * (bottom - top + 1) > 256) this.overflow.add(entry);
      else for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) {
        const key = column + ':' + row;
        if (!this.cells.has(key)) this.cells.set(key, new Set());
        this.cells.get(key).add(entry); entry.keys.push(key);
      }
      this.entries.add(entry); entries.push(entry);
    }
    this.groups.set(identifier, entries);
  }

  candidates(raycaster) {
    const ray = raycaster.ray; const far = raycaster.far;
    if (far < 0 || !this.entries.size) { this.lastCandidates = 0; return []; }
    let selected;
    if (!Number.isFinite(far)) selected = this.entries;
    else {
      const endX = ray.origin.x + ray.direction.x * far; const endZ = ray.origin.z + ray.direction.z * far;
      const left = Math.floor((Math.min(ray.origin.x, endX) - 1e-7) / this.cellSize); const right = Math.floor((Math.max(ray.origin.x, endX) + 1e-7) / this.cellSize);
      const top = Math.floor((Math.min(ray.origin.z, endZ) - 1e-7) / this.cellSize); const bottom = Math.floor((Math.max(ray.origin.z, endZ) + 1e-7) / this.cellSize);
      if ((right - left + 1) * (bottom - top + 1) > 512) selected = this.entries;
      else {
        selected = new Set(this.overflow);
        for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) for (const entry of this.cells.get(column + ':' + row) || []) selected.add(entry);
      }
    }
    const candidates = [];
    for (const entry of selected) {
      if (!ray.intersectBox(entry.bounds, this.point)) continue;
      if (!entry.bounds.containsPoint(ray.origin) && this.point.distanceTo(ray.origin) > far + 1e-7) continue;
      candidates.push(entry.object);
    }
    this.lastCandidates = candidates.length;
    return candidates;
  }

  intersect(raycaster) { return raycaster.intersectObjects(this.candidates(raycaster), false); }
}
