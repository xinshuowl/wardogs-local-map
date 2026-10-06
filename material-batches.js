import * as THREE from './vendor/three/three.module.js';

export class MaterialBatches {
  constructor(group, enabled = false) {
    this.group = group;
    this.enabled = enabled;
    this.pools = new Map();
    this.records = new Map();
    this.createdPools = 0;
    this.matrix = new THREE.Matrix4();
    this.color = new THREE.Color();
    this.bounds = new THREE.Sphere();
  }

  remove(batch) {
    const record = this.records.get(batch);
    if (!record) return;
    this.setVisible(record, false);
    for (const instance of record.instances) {
      instance.pool.mesh.deleteInstance(instance.id);
    }
    this.records.delete(batch);
  }

  hide(batch) {
    batch.visible = false;
    const record = this.records.get(batch);
    if (record) this.setVisible(record, false);
  }

  setVisible(record, visible) {
    if (record.visible === visible) return;
    for (let index = 0; index < record.count; index++) {
      const instance = record.instances[index];
      instance.pool.mesh.setVisibleAt(instance.id, visible);
      instance.pool.visibleInstances += visible ? 1 : -1;
      instance.pool.mesh.visible = instance.pool.visibleInstances > 0;
    }
    record.visible = visible;
  }

  keyFor(batch) {
    const geometry = batch.geometry;
    const format = Object.entries(geometry.attributes).sort(([first], [second]) => first.localeCompare(second)).map(([name, attribute]) => name + ':' + attribute.itemSize + ':' + attribute.normalized + ':' + attribute.array.constructor.name).join(',');
    return batch.material.uuid + ':' + batch.castShadow + ':' + Boolean(geometry.index) + ':' + format;
  }

  poolFor(batch, cell, formatKey) {
    const geometry = batch.geometry;
    const key = formatKey + ':' + cell;
    let pools = this.pools.get(key);
    if (!pools) { pools = []; this.pools.set(key, pools); }
    let pool = pools.find(candidate => candidate.geometryIds.has(geometry) && candidate.mesh.instanceCount < 256);
    if (!pool) pool = pools.find(candidate => candidate.mesh.instanceCount < 256 && candidate.mesh.unusedVertexCount >= geometry.attributes.position.count && candidate.mesh.unusedIndexCount >= (geometry.index?.count || 0));
    if (!pool) {
      const mesh = new THREE.BatchedMesh(256, 16384, 65536, batch.material);
      mesh.perObjectFrustumCulled = true;
      mesh.sortObjects = batch.material.transparent;
      mesh.frustumCulled = true;
      mesh.boundingSphere = new THREE.Sphere();
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
      mesh.matrixWorld.copy(this.group.matrixWorld);
      mesh.castShadow = batch.castShadow;
      mesh.receiveShadow = batch.receiveShadow;
      mesh.name = 'Shared material models';
      this.group.add(mesh);
      pool = { mesh, cell, geometryIds: new Map(), visibleInstances: 0 };
      pools.push(pool);
      this.createdPools++;
    }
    if (!pool.geometryIds.has(geometry)) pool.geometryIds.set(geometry, pool.mesh.addGeometry(geometry));
    return pool;
  }

  sync(batch) {
    batch.visible = true;
    const geometry = batch.geometry;
    const eligible = (this.enabled || batch.material.transparent) && (batch.count <= 64 || batch.userData.perInstanceCulling) && geometry.attributes.position.count <= 16384 && (geometry.index?.count || 0) <= 65536 && !Object.keys(geometry.morphAttributes).length;
    if (!eligible) {
      this.remove(batch);
      if (batch.parent !== this.group) this.group.add(batch);
      return;
    }
    if (batch.parent === this.group) this.group.remove(batch);
    let record = this.records.get(batch);
    if (!record) { record = { instances: [], count: 0, visible: true, version: -1, colorVersion: -1, key: this.keyFor(batch) }; this.records.set(batch, record); }
    this.setVisible(record, true);
    const colorVersion = batch.instanceColor?.version ?? -1;
    const unchanged = record.count === batch.count && record.version === batch.instanceMatrix.version && record.colorVersion === colorVersion;
    if (unchanged) return;
    const changedAttributes = [[batch.instanceMatrix, record.version, 16], [batch.instanceColor, record.colorVersion, 3]].filter(([attribute, version]) => attribute && attribute.version !== version);
    let firstChanged = 0;
    let lastChanged = batch.count;
    if (record.version >= 0 && changedAttributes.every(([attribute, version]) => attribute.version === version + 1 && attribute.updateRanges.length)) {
      firstChanged = Math.min(batch.count, record.count);
      lastChanged = batch.count > record.count ? batch.count : 0;
      for (const [attribute, , stride] of changedAttributes) for (const range of attribute.updateRanges) {
        firstChanged = Math.min(firstChanged, Math.floor(range.start / stride));
        lastChanged = Math.max(lastChanged, Math.ceil((range.start + range.count) / stride));
      }
      lastChanged = Math.min(lastChanged, batch.count);
    }
    for (let index = batch.count; index < record.count; index++) {
      const instance = record.instances[index];
      instance.pool.mesh.setVisibleAt(instance.id, false);
      instance.pool.visibleInstances--;
      instance.pool.mesh.visible = instance.pool.visibleInstances > 0;
    }
    for (let index = firstChanged; index < lastChanged; index++) {
      batch.getMatrixAt(index, this.matrix);
      const cell = Math.floor(this.matrix.elements[12] / 512) + ':' + Math.floor(this.matrix.elements[14] / 512);
      let instance = record.instances[index];
      if (instance && instance.pool.cell !== cell) {
        instance.pool.mesh.deleteInstance(instance.id);
        if (index < record.count) instance.pool.visibleInstances--;
        instance.pool.mesh.visible = instance.pool.visibleInstances > 0;
        instance = null;
      }
      const created = !instance;
      if (!instance) {
        const pool = this.poolFor(batch, cell, record.key);
        instance = { pool, id: pool.mesh.addInstance(pool.geometryIds.get(geometry)) };
        record.instances[index] = instance;
      }
      if (created || index >= record.count) {
        instance.pool.mesh.setVisibleAt(instance.id, true);
        instance.pool.visibleInstances++;
        instance.pool.mesh.visible = true;
      }
      if (batch.instanceColor) batch.getColorAt(index, this.color);
      else this.color.setRGB(1, 1, 1);
      instance.pool.mesh.setMatrixAt(instance.id, this.matrix);
      instance.pool.mesh.setColorAt(instance.id, this.color);
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      instance.pool.mesh.boundingSphere.union(this.bounds.copy(geometry.boundingSphere).applyMatrix4(this.matrix));
    }
    record.count = batch.count;
    record.version = batch.instanceMatrix.version;
    record.colorVersion = colorVersion;
  }

  get stats() {
    const result = { pools: 0, geometries: 0, instances: 0, visibleInstances: 0, createdPools: this.createdPools };
    for (const pools of this.pools.values()) for (const pool of pools) {
      result.pools++;
      result.geometries += pool.geometryIds.size;
      result.instances += pool.mesh.instanceCount;
      result.visibleInstances += pool.visibleInstances;
    }
    return result;
  }

  dispose() {
    for (const pools of this.pools.values()) for (const pool of pools) {
      this.group.remove(pool.mesh);
      pool.mesh.dispose();
    }
    this.pools.clear();
    this.records.clear();
  }
}

