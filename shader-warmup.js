import * as THREE from './vendor/three/three.module.js';

export class ShaderWarmup {
  constructor(terrain, batching) {
    this.terrain = terrain;
    this.batching = batching;
    this.supported = typeof terrain.renderer.compileAsync === 'function';
    this.entries = new Map();
    this.queue = [];
    this.running = 0;
    this.disposed = false;
    if (!this.supported) return;
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.placeholder = new THREE.MeshStandardMaterial();
    this.instance = new THREE.InstancedMesh(this.geometry, this.placeholder, 1);
    this.instance.setColorAt(0, new THREE.Color(1, 1, 1));
    this.instance.receiveShadow = true;
    {
      this.batch = new THREE.BatchedMesh(1, 4, 6, this.placeholder);
      const identifier = this.batch.addInstance(this.batch.addGeometry(this.geometry));
      this.batch.setColorAt(identifier, new THREE.Color(1, 1, 1));
      this.batch.receiveShadow = true;
    }
  }

  get pending() { return this.queue.length + this.running; }

  prepare(material) {
    if (!this.supported) return Promise.resolve();
    const renderer = this.terrain.renderer;
    const key = JSON.stringify([material.type, material.side, material.transparent, material.alphaTest > 0, material.alphaHash, material.flatShading, Boolean(material.map), Boolean(material.normalMap), Boolean(this.terrain.scene.environment), material.normalMapType, renderer.shadowMap.enabled, renderer.shadowMap.type, material.customProgramCacheKey()]);
    if (this.entries.has(key)) return this.entries.get(key).promise;
    let resolveReady;
    let rejectReady;
    const promise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const entry = { key, material, promise, resolve: resolveReady, reject: rejectReady };
    this.entries.set(key, entry);
    this.queue.push(entry);
    this.terrain.invalidate();
    return promise;
  }

  update() {
    if (this.disposed || this.running || !this.queue.length) return;
    const entry = this.queue.shift();
    this.running = 1;
    this.activeMaterial = entry.material;
    this.compile(entry);
  }

  async compile(entry) {
    try {
      this.instance.material = entry.material;
      await this.terrain.renderer.compileAsync(this.instance, this.terrain.camera, this.terrain.scene);
      if (!this.disposed && this.batch && (this.batching || entry.material.transparent)) {
        this.batch.material = entry.material;
        await this.terrain.renderer.compileAsync(this.batch, this.terrain.camera, this.terrain.scene);
      }
      if (this.disposed) throw new DOMException('Cancelled', 'AbortError');
      entry.resolve();
    } catch (error) { this.entries.delete(entry.key); entry.reject(error); }
    finally { this.running = 0; this.activeMaterial = null; if (this.disposed) this.cleanup(); else this.terrain.invalidate(); }
  }

  deferMaterialDisposal(material) {
    if (!this.running || material !== this.activeMaterial) return false;
    this.deferredMaterial = material;
    return true;
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.queue) entry.reject(new DOMException('Cancelled', 'AbortError'));
    this.queue = [];
    this.entries.clear();
    if (!this.running) this.cleanup();
  }

  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    this.deferredMaterial?.dispose();
    this.instance?.dispose();
    this.batch?.dispose();
    this.geometry?.dispose();
    this.placeholder?.dispose();
  }
}
