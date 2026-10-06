import * as THREE from './vendor/three/three.module.js';
import { detailHeights } from './terrain-height-detail.js';
import { drainWork, vertexNormalsInSlices } from './frame-work.js';

export class TerrainDetail {
  constructor(terrain) {
    this.terrain = terrain;
    this.signature = '';
    this.patch = null;
  }

  clear(resetMaterial = false) {
    if (this.patch) { this.terrain.scene.remove(this.patch); this.patch.geometry.dispose(); }
    const base = this.terrain.mesh?.geometry;
    if (base?.userData.completeIndex) { base.index.array.set(base.userData.completeIndex); base.index.needsUpdate = true; base.setDrawRange(0, base.userData.completeIndex.length); }
    this.patch = null;
    this.signature = '';
    this.work = null;
    this.pendingSignature = null;
    this.bounds = null;
    if (resetMaterial) { this.precisionRequest = null; this.precisionRetryAt = 0; this.detailMaterial?.dispose(); this.detailTexture?.dispose(); this.detailMaterial = null; this.detailTexture = null; }
  }

  contains(position) {
    const bounds = this.bounds;
    return Boolean(this.patch && bounds && position[0] >= bounds[0] && position[0] <= bounds[2] && position[1] >= bounds[1] && position[1] <= bounds[3]);
  }

  update(force = false, deadline = Infinity) {
    const terrain = this.terrain;
    if (!terrain.ready || !terrain.mesh) return;
    const distance = terrain.controls.getDistance() / terrain.metresToWorld;
    const enabled = distance < 2600;
    let span = terrain.renderProfile === 'high' ? 32 : terrain.renderProfile === 'low' ? 12 : 22;
    const usePrecision = Boolean(terrain.detailDescriptor && distance < 800);
    const refinement = usePrecision ? terrain.detailDescriptor.ratio : 1;
    if (usePrecision) span = Math.max(2, Math.ceil((terrain.renderProfile === 'high' ? 192 : terrain.renderProfile === 'low' ? 96 : 144) / (terrain.meshStride * terrain.descriptor.sampleMetres)));
    const target = terrain.targetPosition();
    const descriptor = terrain.descriptor;
    const column = (terrain.map.bounds[0] + target[0] / 2048 * terrain.map.bounds[2] - descriptor.origin[0]) / descriptor.step[0] / terrain.meshStride;
    const row = (terrain.map.bounds[1] + target[1] / 2048 * terrain.map.bounds[2] - descriptor.origin[1]) / descriptor.step[1] / terrain.meshStride;
    const centerColumn = Math.round(column / 8) * 8;
    const centerRow = Math.round(row / 8) * 8;
    const left = Math.max(0, centerColumn - span);
    const top = Math.max(0, centerRow - span);
    const right = Math.min(terrain.meshColumns - 1, centerColumn + span);
    const bottom = Math.min(terrain.meshRows - 1, centerRow + span);
    const signature = [enabled, left, top, right, bottom, terrain.heightFactor, terrain.map.id, refinement, detailHeights.version(terrain.map.id)].join(':');
    const requestKey = [terrain.map.id, left, top, right, bottom].join(':');
    if (usePrecision && this.precisionRequest !== requestKey && performance.now() >= (this.precisionRetryAt || 0)) {
      this.precisionRequest = requestKey;
      const revision = terrain.revision;
      const heightVersion = detailHeights.version(terrain.map.id);
      const radius = (span + 8) * terrain.meshStride * terrain.descriptor.sampleMetres;
      detailHeights.ensure(terrain.map, [target], radius).then(() => {
        if (revision !== terrain.revision || detailHeights.version(terrain.map.id) === heightVersion) return;
        this.signature = ''; terrain.invalidate(); terrain.callbacks.onHeightDetail?.();
      }).catch(error => {
        if (revision !== terrain.revision) return;
        if (this.precisionRequest === requestKey) { this.precisionRequest = null; this.precisionRetryAt = performance.now() + 1000; }
        terrain.renderer.domElement.dataset.detailHeightError = error.message;
      });
    }
    if (!force && signature === this.signature && !this.work) return;
    if (force || !this.work || this.pendingSignature !== signature) {
      this.pendingSignature = signature;
      this.work = this.build({ signature, enabled, left, top, right, bottom, refinement });
    }
    const result = drainWork(this.work, deadline);
    if (result.done) { this.work = null; this.pendingSignature = null; }
    else terrain.invalidate();
    terrain.renderer.domElement.dataset.detailWorkPending = this.work ? '1' : '0';
  }

  *build({ signature, enabled, left, top, right, bottom, refinement }) {
    const terrain = this.terrain;
    const descriptor = terrain.descriptor;
    const base = terrain.mesh.geometry;
    base.userData.completeIndex ||= base.index.array.slice();
    if (!enabled || right <= left || bottom <= top) { this.clear(); this.signature = signature; return; }
    const columns = (right - left) * terrain.meshStride * refinement + 1;
    const rows = (bottom - top) * terrain.meshStride * refinement + 1;
    const vertices = new Float32Array(columns * rows * 3);
    const coordinates = new Float32Array(columns * rows * 2);
    const indices = columns * rows > 65535 ? new Uint32Array((columns - 1) * (rows - 1) * 6) : new Uint16Array((columns - 1) * (rows - 1) * 6);
    let indexOffset = 0;
    const position = [0, 0];
    const first = [];
    const last = [];
    const minimum = new THREE.Vector3(Infinity, Infinity, Infinity);
    const maximum = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const point = new THREE.Vector3();
    for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
      for (let columnIndex = 0; columnIndex < columns; columnIndex++) {
        const rawX = descriptor.origin[0] + Math.min(left * terrain.meshStride + columnIndex / refinement, descriptor.cols - 1) * descriptor.step[0];
        const rawY = descriptor.origin[1] + Math.min(top * terrain.meshStride + rowIndex / refinement, descriptor.rows - 1) * descriptor.step[1];
        position[0] = (rawX - terrain.map.bounds[0]) / terrain.map.bounds[2] * 2048; position[1] = (rawY - terrain.map.bounds[1]) / terrain.map.bounds[2] * 2048;
        const edge = rowIndex === 0 || columnIndex === 0 || rowIndex === rows - 1 || columnIndex === columns - 1;
        const height = edge ? terrain.meshHeightAt(position) : (terrain.heightAt(position) - terrain.heightBaseline) * terrain.metresToWorld * terrain.heightFactor;
        const vertex = rowIndex * columns + columnIndex;
        vertices[vertex * 3] = position[0] - 1024; vertices[vertex * 3 + 1] = height; vertices[vertex * 3 + 2] = position[1] - 1024;
        point.fromArray(vertices, vertex * 3); minimum.min(point); maximum.max(point);
        coordinates[vertex * 2] = position[0] / 2048; coordinates[vertex * 2 + 1] = 1 - position[1] / 2048;
        if (vertex === 0) first.push(...position);
        if (vertex === columns * rows - 1) last.push(...position);
        if (columnIndex < columns - 1 && rowIndex < rows - 1) { const next = vertex + columns; indices[indexOffset++] = vertex; indices[indexOffset++] = next; indices[indexOffset++] = vertex + 1; indices[indexOffset++] = vertex + 1; indices[indexOffset++] = next; indices[indexOffset++] = next + 1; }
        if (vertex % 128 === 127) yield;
      }
    }
    const normals = yield* vertexNormalsInSlices(vertices, indices);
    let material = terrain.terrainMaterial;
    const detail = terrain.map.detail;
    const detailSize = detail.size || 512;
    if (terrain.textureSources && first[0] >= detail.x && first[1] >= detail.y && last[0] <= detail.x + detailSize && last[1] <= detail.y + detailSize) {
      if (!this.detailTexture) {
        this.detailTexture = new THREE.Texture(terrain.textureSources[1]);
        this.detailTexture.colorSpace = THREE.SRGBColorSpace;
        this.detailTexture.anisotropy = Math.min(8, terrain.renderer.capabilities.getMaxAnisotropy());
        this.detailTexture.needsUpdate = true;
        this.detailMaterial = terrain.terrainMaterial.clone();
        this.detailMaterial.map = this.detailTexture;
        this.detailMaterial.onBeforeCompile = terrain.terrainMaterial.onBeforeCompile;
      }
      material = this.detailMaterial;
      for (let index = 0; index < columns * rows; index++) {
        coordinates[index * 2] = (vertices[index * 3] + 1024 - detail.x) / detailSize; coordinates[index * 2 + 1] = 1 - (vertices[index * 3 + 2] + 1024 - detail.y) / detailSize;
        if (index % 512 === 511) yield;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(coordinates, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.boundingBox = new THREE.Box3(minimum, maximum);
    geometry.boundingSphere = new THREE.Sphere(geometry.boundingBox.getCenter(new THREE.Vector3()), minimum.distanceTo(maximum) / 2);
    const previous = this.patch;
    this.patch = new THREE.Mesh(geometry, material);
    this.patch.customDepthMaterial = terrain.terrainDepthMaterial;
    this.patch.receiveShadow = true;
    this.patch.castShadow = true;
    this.patch.name = 'Native ' + descriptor.sampleMetres / refinement + 'm terrain detail';
    this.bounds = [...first, ...last];
    terrain.scene.add(this.patch);
    if (previous) { terrain.scene.remove(previous); previous.geometry.dispose(); }
    this.signature = signature;
    const complete = base.userData.completeIndex;
    const rowSize = (terrain.meshColumns - 1) * 6;
    let cursor = 0;
    for (let baseRow = 0; baseRow < terrain.meshRows - 1; baseRow++) {
      const rowOffset = baseRow * rowSize;
      if (baseRow < top || baseRow >= bottom) {
        base.index.array.set(complete.subarray(rowOffset, rowOffset + rowSize), cursor); cursor += rowSize;
      } else {
        const prefix = left * 6; const suffix = rowSize - right * 6;
        base.index.array.set(complete.subarray(rowOffset, rowOffset + prefix), cursor); cursor += prefix;
        base.index.array.set(complete.subarray(rowOffset + right * 6, rowOffset + rowSize), cursor); cursor += suffix;
      }
    }
    base.index.needsUpdate = true;
    base.setDrawRange(0, cursor);
    terrain.renderer.shadowMap.needsUpdate = true;
    terrain.shadowRevision = (terrain.shadowRevision || 0) + 1;
    terrain.invalidate();
    terrain.renderer.domElement.dataset.detailVertices = String(columns * rows);
    terrain.renderer.domElement.dataset.detailSampleMetres = String(descriptor.sampleMetres / refinement);
  }
}
