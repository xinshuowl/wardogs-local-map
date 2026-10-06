import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/three/meshopt_decoder.module.js';
import { SpatialColliders } from './spatial-colliders.js';
import { ModelPresence, modelRanges, modelLod, selectModelsWork } from './model-residency.js';
import { drainWork } from './frame-work.js';
import { MaterialBatches } from './material-batches.js';
import { ShaderWarmup } from './shader-warmup.js';
import { resolveModelMaterial } from './model-materials.js';
import { applySceneShadows } from './scene-shadows.js';
import { splitMirroredInstances } from './model-geometry.js';

let decoderWorkers = 0;
if (MeshoptDecoder.supported && typeof Worker === 'function') {
  try { decoderWorkers = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 4) - 1)); MeshoptDecoder.useWorkers(decoderWorkers); }
  catch { MeshoptDecoder.useWorkers(0); decoderWorkers = 0; }
}

const categories = ['buildings', 'trees', 'props'];
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

class LocalQueue {
  constructor(limit, signal) {
    this.limit = limit;
    this.signal = signal;
    this.running = 0;
    this.jobs = [];
  }

  add(job, priority = 0) {
    return new Promise((resolve, reject) => {
      const entry = { job, resolve, reject, priority };
      const next = this.jobs.findIndex(queued => queued.priority < priority);
      if (next < 0) this.jobs.push(entry);
      else this.jobs.splice(next, 0, entry);
      this.next();
    });
  }

  next() {
    while (this.running < this.limit && this.jobs.length) {
      const entry = this.jobs.shift();
      if (this.signal.aborted) { entry.reject(new DOMException('Cancelled', 'AbortError')); continue; }
      this.running++;
      Promise.resolve().then(() => { if (this.signal.aborted) throw new DOMException('Cancelled', 'AbortError'); return entry.job(); }).then(entry.resolve, entry.reject).finally(() => { this.running--; this.next(); });
    }
  }
}

function meshIdentifier(object) {
  for (let ancestor = object; ancestor; ancestor = ancestor.parent) {
    const match = /^m(\d+)$/.exec(ancestor.name);
    if (match) return Number(match[1]);
  }
  return null;
}

function decodeTile(buffer, manifest) {
  if (buffer.byteLength < 4) throw new Error('模型位置文件不完整。');
  const header = new DataView(buffer);
  const count = header.getUint32(0, true);
  let offset = (count * 2 + 1) * 4;
  if (offset > buffer.byteLength) throw new Error('模型位置文件头损坏。');
  const groups = [];
  for (let index = 0; index < count; index++) {
    const mesh = header.getUint32(4 + index * 8, true);
    const instances = header.getUint32(8 + index * 8, true);
    const length = instances * 11;
    if (!manifest.meshes[mesh] || offset + length * 4 > buffer.byteLength) throw new Error('模型位置数据与清单不匹配。');
    groups.push({ mesh, data: new Float32Array(buffer, offset, length), instances });
    offset += length * 4;
  }
  if (offset !== buffer.byteLength) throw new Error('模型位置文件长度异常。');
  return groups;
}

export class PropView {
  constructor(terrain) {
    this.terrain = terrain;
    this.environmentMap = terrain.scene.environment;
    this.environmentIntensity = terrain.environment?.skySettings?.skyLightIntensity ?? 1;
    this.settings = Object.fromEntries(categories.map(category => [category, true]));
    this.generation = 0;
    this.timer = null;
    this.lastUpdate = 0;
    this.cameraStamp = '';
    this.statusStamp = '';
    this.group = new THREE.Group();
    this.group.name = 'WARDOGS genuine props';
    terrain.scene.add(this.group);
    this.matrix = new THREE.Matrix4();
    this.position = new THREE.Vector3();
    this.rotation = new THREE.Quaternion();
    this.scale = new THREE.Vector3();
    this.sphere = new THREE.Sphere();
    this.frustum = new THREE.Frustum();
    this.projection = new THREE.Matrix4();
    this.tint = new THREE.Color();
    this.reset();
  }

  reset() {
    this.controller?.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
    this.shaderWarmup?.dispose();
    this.drawBatches?.dispose();
    for (const batches of this.batches?.values() || []) for (const batch of batches) { this.group.remove(batch); batch.dispose(); }
    for (const parts of this.prototypes?.values() || []) for (const part of parts) part.geometry.dispose();
    for (const material of new Set(this.materials?.values() || [])) if (!this.shaderWarmup?.deferMaterialDisposal(material)) material.dispose();
    for (const texture of this.textures?.values() || []) { texture.dispose(); texture.image?.close?.(); }
    this.controller = new AbortController();
    this.assetQueue = new LocalQueue(2, this.controller.signal);
    this.textureQueue = new LocalQueue(6, this.controller.signal);
    this.tileCache = new Map();
    this.lodHistory = new WeakMap();
    this.presence = new ModelPresence();
    this.work = null;
    this.textureUploads = [];
    this.colliderInstances = new Map();
    this.colliderFocus = new Map();
    this.colliderCoverage = new Map();
    this.preloadRun = 0;
    this.preloadStatus = { state: 'idle', completed: 0, total: 0 };
    this.tileJobs = new Map();
    this.failedTiles = new Set();
    this.bundleJobs = new Map();
    this.completedBundles = new Set();
    this.failedBundles = new Set();
    this.prototypes = new Map();
    this.colliders = [];
    this.colliderIndex = new SpatialColliders(this.terrain.metresToWorld * 32);
    this.colliderGroups = new Map();
    this.batchSelections = new Map();
    this.pickBounds = new Map();
    this.batches = new Map();
    this.materials = new Map();
    this.materialPool = new Map();
    this.materialDescriptors = new Map();
    this.drawBatches = new MaterialBatches(this.group, Boolean(this.terrain.renderer.extensions?.has('WEBGL_multi_draw')));
    this.terrain.renderer.domElement.dataset.modelDrawBatching = this.drawBatches.enabled ? 'multi-draw' : 'instanced';
    this.shaderWarmup = new ShaderWarmup(this.terrain, this.drawBatches.enabled);
    this.textureJobs = new Map();
    this.failedTextureJobs = new Set();
    this.textures = new Map();
    this.texturePending = 0;
    this.textureFailures = 0;
    this.shaderFailures = 0;
    this.visibleCounts = { buildings: 0, trees: 0, props: 0 };
    this.wantedTiles = [];
    this.manifest = null;
    this.error = null;
    this.cameraStamp = '';
    this.statusStamp = '';
    this.dirty = true;
    this.group.visible = false;
  }

  async read(url, bytes, generation) {
    const response = await fetch(url, { signal: this.controller.signal });
    if (!response.ok) throw new Error('缺少本地模型资源：' + url);
    const buffer = await response.arrayBuffer();
    if (generation !== this.generation) throw new DOMException('Cancelled', 'AbortError');
    if (bytes !== undefined && buffer.byteLength !== bytes) throw new Error('模型资源文件不完整：' + url);
    return buffer;
  }

  async loadMap(map) {
    const generation = this.generation;
    this.base = 'assets/models/' + map.id + '/';
    this.report('loading');
    try {
      const buffer = await this.read(this.base + 'manifest.json', undefined, generation);
      const manifest = JSON.parse(new TextDecoder().decode(buffer));
      if (manifest.map !== map.id || manifest.floatsPerInstance !== 11 || manifest.coverage !== 'full-map') throw new Error('本地模型清单版本不匹配。');
      this.manifest = manifest;
      manifest.tiles.forEach((tile, order) => { tile.order = order; });
      this.colliderIndex = new SpatialColliders(this.terrain.metresToWorld * 32);
      this.group.scale.setScalar(this.terrain.metresToWorld);
      this.group.position.set(-map.bounds[0] / 100 * this.terrain.metresToWorld - 1024, -this.terrain.heightBaseline * this.terrain.metresToWorld, -map.bounds[1] / 100 * this.terrain.metresToWorld - 1024);
      this.group.updateMatrixWorld(true);
      this.loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      this.terrain.renderer.domElement.dataset.decoderWorkers = String(decoderWorkers);
      this.wake();
      if (this.settings.loading === 'preload') this.preloadMap();
    } catch (error) {
      if (generation !== this.generation || error.name === 'AbortError') return;
      this.error = error.message;
      this.report('error');
    }
  }

  setSettings(settings) {
    if (['buildings', 'trees', 'props'].some(category => this.settings[category] && settings[category] === false)) this.terrain.performance?.clearSelection();
    this.work = null;
    const previousLoading = this.settings.loading;
    this.settings = { ...this.settings, ...settings };
    if (previousLoading !== this.settings.loading) {
      if (this.settings.loading === 'preload' && this.manifest) this.preloadMap();
      else { this.preloadRun++; this.preloadStatus.state = 'idle'; }
    }
    this.wake();
  }

  wake() {
    this.dirty = true;
    this.terrain.invalidate();
  }

  suspend() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  requestTile(tile, preload = false) {
    if (this.tileCache.has(tile.key) || this.failedTiles.has(tile.key)) return Promise.resolve();
    if (this.tileJobs.has(tile.key)) return this.tileJobs.get(tile.key);
    const generation = this.generation;
    const queue = this.assetQueue;
    const base = this.base;
    const manifest = this.manifest;
    const job = queue.add(async () => {
      if (!preload && !this.wantedTiles.some(wanted => wanted.key === tile.key)) return;
      if (preload && this.settings.loading !== 'preload') return;
      const buffer = await this.read(base + tile.file, tile.bytes, generation);
      const groups = decodeTile(buffer, manifest);
      if (generation !== this.generation) return;
      for (const group of groups) group.order = tile.order || 0;
      this.tileCache.set(tile.key, groups);
    }, preload ? -1 : 1).catch(error => {
      if (generation === this.generation && error.name !== 'AbortError') this.failedTiles.add(tile.key);
    }).finally(() => {
      if (generation !== this.generation) return;
      this.tileJobs.delete(tile.key);
      this.wake();
    });
    this.tileJobs.set(tile.key, job);
    return job;
  }

  requestBundle(index, lod = 2, preload = false) {
    const jobKey = index + ':' + lod;
    if (this.bundleJobs.has(jobKey)) return this.bundleJobs.get(jobKey);
    if (this.failedBundles.has(jobKey)) return Promise.resolve();
    const generation = this.generation;
    const bundle = this.manifest.bundles[index];
    const descriptor = bundle.lods?.[lod] || (lod === 2 ? bundle : null);
    if (!descriptor) return;
    const base = this.base;
    const job = this.assetQueue.add(async () => {
      const buffer = await this.read(base + descriptor.file, descriptor.bytes, generation);
      const gltf = await this.loader.parseAsync(buffer, base);
      gltf.scene.updateMatrixWorld(true);
      const meshes = [];
      const originalMaterials = new Set();
      const decoded = new Map();
      gltf.scene.traverse(object => { if (object.isMesh) meshes.push(object); });
      let sliceStart = performance.now();
      for (const mesh of meshes) {
        const identifier = meshIdentifier(mesh);
        const sourceMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        originalMaterials.add(sourceMaterial);
        if (generation === this.generation && this.manifest.meshes[identifier]) {
          const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
          for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name);
          if (!geometry.attributes.normal) geometry.computeVertexNormals();
          geometry.computeBoundingSphere();
          geometry.computeBoundingBox();
          const part = { geometry, material: null, materialName: sourceMaterial?.name || '', triangles: (geometry.index?.count || geometry.attributes.position.count) / 3 };
          const key = lod === 2 ? identifier : identifier + ':' + lod;
          if (!decoded.has(key)) decoded.set(key, []);
          decoded.get(key).push(part);
        }
        mesh.geometry.dispose();
        if (performance.now() - sliceStart >= 6) { await frame(); sliceStart = performance.now(); }
      }
      for (const material of originalMaterials) material?.dispose();
      if (generation !== this.generation) { for (const parts of decoded.values()) for (const part of parts) part.geometry.dispose(); return; }
      for (const identifier of bundle.meshes) if (!decoded.has(lod === 2 ? identifier : identifier + ':' + lod)) {
        for (const parts of decoded.values()) for (const part of parts) part.geometry.dispose();
        throw new Error('模型包缺少部件 ' + identifier);
      }
      for (const [key, parts] of decoded) this.prototypes.set(key, parts);
      this.completedBundles.add(jobKey);
    }, preload ? -1 : lod === 2 ? 3 : 2).catch(error => {
      if (generation === this.generation && error.name !== 'AbortError') this.failedBundles.add(jobKey);
    }).finally(() => { if (generation === this.generation) this.wake(); });
    this.bundleJobs.set(jobKey, job);
    return job;
  }

  async preloadMap() {
    if (!this.manifest || this.preloadStatus.state === 'loading' || this.preloadStatus.state === 'ready') return;
    const generation = this.generation;
    const run = ++this.preloadRun;
    const manifest = this.manifest;
    const current = () => generation === this.generation && run === this.preloadRun && this.settings.loading === 'preload';
    const tasks = manifest.tiles.map(tile => async () => {
      await this.requestTile(tile, true);
      if (current() && !this.tileCache.has(tile.key) && !this.failedTiles.has(tile.key)) await this.requestTile(tile, true);
    });
    for (const lod of [2, 1, 0]) for (let index = 0; index < manifest.bundles.length; index++) {
      if (manifest.bundles[index].lods?.[lod] || lod === 2) tasks.push(() => this.requestBundle(index, lod, true));
    }
    for (const filename of Object.keys(manifest.textures || {})) tasks.push(() => this.textureFor(filename, [1, 1], THREE.SRGBColorSpace));
    this.preloadStatus = { state: 'loading', completed: 0, total: tasks.length, failures: 0 };
    this.wake();
    for (let index = 0; index < tasks.length; index += 2) {
      if (!current()) return;
      await Promise.all(tasks.slice(index, index + 2).map(async task => {
        try { await task(); }
        catch (error) { if (current() && error.name !== 'AbortError') this.preloadStatus.failures++; }
        if (current()) this.preloadStatus.completed++;
      }));
      if (!current()) return;
      while (globalThis.document?.hidden && current()) await new Promise(resolve => globalThis.document.addEventListener('visibilitychange', resolve, { once: true }));
      if (!current()) return;
      this.wake();
      await frame();
    }
    if (!current()) return;
    for (const name of Object.keys(manifest.materials)) this.materialFor(name);
    await Promise.allSettled([...this.textureJobs.values()]);
    if (!current()) return;
    const failures = this.preloadStatus.failures + this.failedTiles.size + this.failedBundles.size + this.textureFailures;
    this.preloadStatus.state = failures ? 'partial' : 'ready';
    this.preloadStatus.failures = failures;
    this.wake();
  }

  textureFor(filename, repeat, colorSpace) {
    const variant = filename + ':' + colorSpace + ':' + (repeat || [1, 1]).join('x');
    if (this.textureJobs.has(variant)) return this.textureJobs.get(variant);
    const generation = this.generation;
    const sourceKey = filename + ':source';
    const base = this.base;
    let source = this.textureJobs.get(sourceKey);
    if (!source) {
      source = this.textureQueue.add(async () => {
        const url = filename.startsWith('@') ? 'assets/material-surfaces/' + filename.slice(1) : base + 'textures/' + filename;
        const buffer = await this.read(url, undefined, generation);
        const size = this.manifest.textures?.[filename];
        const limit = this.terrain.renderProfile === 'low' ? 512 : this.manifest.maximumTextureSize || 1024;
        const factor = size ? Math.min(1, limit / Math.max(size.width, size.height)) : 1;
        const resize = size && factor < 1 ? { resizeWidth: Math.max(1, Math.round(size.width * factor)), resizeHeight: Math.max(1, Math.round(size.height * factor)) } : {};
        const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/webp' }), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none', ...resize });
        if (generation !== this.generation) { bitmap.close(); throw new DOMException('Cancelled', 'AbortError'); }
        const texture = new THREE.Texture(bitmap);
        texture.flipY = false;
        this.textures.set(sourceKey, texture);
        return texture;
      });
      this.textureJobs.set(sourceKey, source);
      source.catch(() => { if (generation === this.generation) this.failedTextureJobs.add(sourceKey); });
    }
    const job = source.then(sourceTexture => {
      if (generation !== this.generation) throw new DOMException('Cancelled', 'AbortError');
      const texture = sourceTexture.clone();
      texture.colorSpace = colorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(...(repeat || [1, 1]));
      const anisotropy = this.terrain.renderProfile === 'high' ? 8 : this.terrain.renderProfile === 'low' ? 2 : 4;
      texture.anisotropy = Math.min(anisotropy, this.terrain.renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      this.textures.set(variant, texture);
      return texture;
    });
    this.textureJobs.set(variant, job);
    job.catch(() => { if (generation === this.generation) this.failedTextureJobs.add(variant); });
    return job;
  }

  setEnvironment(texture, intensity = 1) {
    this.environmentMap = texture;
    this.environmentIntensity = intensity;
    const updated = new Set();
    for (const [name, material] of this.materials) {
      if (updated.has(material)) continue;
      updated.add(material);
      material.envMap = texture;
      material.envMapIntensity = material.userData.environmentIntensity * intensity;
      material.needsUpdate = true;
      if (texture) this.prepareMaterial(material, this.materialDescriptors.get(name));
    }
  }

  materialFor(name) {
    if (this.materials.has(name)) return this.materials.get(name);
    const descriptor = resolveModelMaterial(name, this.manifest.materials[name], this.manifest.materials);
    this.materialDescriptors.set(name, descriptor);
    const signature = JSON.stringify([descriptor.baseColor || null, Boolean(descriptor.alpha), descriptor.baseColor ? descriptor.tint || [1, 1, 1] : descriptor.color || null, descriptor.normal || null, descriptor.repeat || [1, 1], descriptor.colorGain || 1, descriptor.roughness, descriptor.metalness, descriptor.opacity, descriptor.transparent, descriptor.castShadow, descriptor.envMapIntensity, descriptor.decal, descriptor.emissive, descriptor.emissiveIntensity]);
    if (this.materialPool.has(signature)) {
      const shared = this.materialPool.get(signature); this.materials.set(name, shared); return shared;
    }
    const material = new THREE.MeshStandardMaterial({ roughness: descriptor.roughness, metalness: descriptor.metalness, opacity: descriptor.opacity, envMap: this.environmentMap, envMapIntensity: descriptor.envMapIntensity * this.environmentIntensity });
    material.userData.environmentIntensity = descriptor.envMapIntensity;
    material.userData.castShadow = descriptor.castShadow;
    material.userData.replacement = descriptor.replacement || null;
    if (this.shaderWarmup.supported) material.visible = false;
    if (descriptor.baseColor) material.color.setRGB(...(descriptor.tint || [1, 1, 1]));
    else if (descriptor.color) material.color.setRGB(...descriptor.color);
    else material.color.set('#b4b09d');
    if (descriptor.alpha) { material.alphaTest = .42; material.side = THREE.DoubleSide; material.visible = false; }
    if (descriptor.transparent) { material.transparent = true; material.depthWrite = false; material.side = THREE.DoubleSide; material.forceSinglePass = true; }
    if (descriptor.decal) { material.polygonOffset = true; material.polygonOffsetFactor = -1; material.polygonOffsetUnits = -1; }
    if (descriptor.emissive) { material.emissive.set(descriptor.emissive); material.emissiveIntensity = descriptor.emissiveIntensity; }
    const gain = { value: descriptor.colorGain || 1 };
    material.onBeforeCompile = shader => {
      shader.uniforms.modelColorGain = gain;
      shader.fragmentShader = 'uniform float modelColorGain;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= modelColorGain;');
    };
    material.customProgramCacheKey = () => 'wardogs-genuine-models-v1';
    applySceneShadows(material);
    this.materials.set(name, material);
    this.materialPool.set(signature, material);
    for (const [field, property, space] of [['baseColor', 'map', THREE.SRGBColorSpace], ['normal', 'normalMap', THREE.NoColorSpace]]) {
      if (!descriptor[field]) continue;
      this.bindMaterialTexture(material, descriptor, field, property, space);
    }
    this.prepareMaterial(material, descriptor);
    return material;
  }

  bindMaterialTexture(material, descriptor, field, property, space) {
    const generation = this.generation;
    material.userData.failedTextures?.delete(field);
    this.texturePending++;
    this.textureFor(descriptor[field], descriptor.repeat, space).then(texture => {
        if (generation !== this.generation) return;
        const apply = () => {
          material[property] = texture;
          material.userData.programPending = false;
          if (field === 'baseColor' && !this.shaderWarmup.supported) material.visible = true;
          if (field === 'normal') material.normalScale.set(1, -1);
          material.needsUpdate = true;
          if (field === 'baseColor' && descriptor.alpha) this.terrain.shadowRevision = (this.terrain.shadowRevision || 0) + 1;
          this.prepareMaterial(material, descriptor);
          this.wake();
        };
        if (this.terrain.renderer.initTexture) this.textureUploads.push({ texture, apply });
        else apply();
      }).catch(error => {
        if (generation !== this.generation || error.name === 'AbortError') return;
        this.textureFailures++;
        material.userData.failedTextures ||= new Set();
        material.userData.failedTextures.add(field);
        material.userData.programPending = false;
        this.prepareMaterial(material, descriptor);
      }).finally(() => {
        if (generation !== this.generation) return;
        this.texturePending--;
        this.wake();
      });
  }

  retryFailures() {
    if (!this.manifest) return this.loadMap(this.terrain.map);
    for (const key of this.failedBundles) this.bundleJobs.delete(key);
    this.failedBundles.clear();
    this.failedTiles.clear();
    for (const key of this.failedTextureJobs) this.textureJobs.delete(key);
    this.failedTextureJobs.clear();
    this.textureFailures = 0;
    this.shaderFailures = 0;
    this.error = null;
    const retried = new Set();
    for (const [name, material] of this.materials) {
      if (retried.has(material)) continue;
      retried.add(material);
      const descriptor = this.materialDescriptors.get(name) || this.manifest.materials[name] || {};
      if (material.userData.programFailed) {
        material.userData.programPending = false;
        material.userData.programFailed = false;
        this.prepareMaterial(material, descriptor);
      }
      for (const [field, property, space] of [['baseColor', 'map', THREE.SRGBColorSpace], ['normal', 'normalMap', THREE.NoColorSpace]]) {
        if (material.userData.failedTextures?.has(field)) this.bindMaterialTexture(material, descriptor, field, property, space);
      }
    }
    if (this.preloadStatus.state === 'partial') this.preloadStatus.state = 'idle';
    if (this.settings.loading === 'preload') this.preloadMap();
    this.wake();
  }

  prepareMaterial(material, descriptor) {
    const failed = material.userData.failedTextures;
    if (!this.shaderWarmup.supported || material.userData.programPending || descriptor.baseColor && !material.map && !failed?.has('baseColor') || descriptor.normal && !material.normalMap && !failed?.has('normal')) return;
    const generation = this.generation;
    material.userData.programPending = true;
    this.shaderWarmup.prepare(material).then(() => {
      if (generation !== this.generation) return;
      if (!material.visible) this.terrain.shadowRevision = (this.terrain.shadowRevision || 0) + 1;
      material.visible = !descriptor.alpha || Boolean(material.map);
      this.wake();
    }).catch(error => {
      if (generation !== this.generation || error.name === 'AbortError') return;
      if (!material.visible) this.terrain.shadowRevision = (this.terrain.shadowRevision || 0) + 1;
      material.visible = !descriptor.alpha || Boolean(material.map);
      this.error = '图形程序预热失败：' + error.message;
      material.userData.programFailed = true;
      this.shaderFailures++;
      this.wake();
    });
  }

  update(deadline = Infinity) {
    if (!this.manifest || !this.terrain.active || !this.terrain.ready) return;
    const terrain = this.terrain;
    if (this.textureUploads.length) {
      const upload = this.textureUploads.shift();
      terrain.renderer.initTexture(upload.texture);
      upload.apply();
      terrain.invalidate();
    }
    this.shaderWarmup.update();
    terrain.renderer.domElement.dataset.modelShaderWarmups = String(this.shaderWarmup.pending);
    terrain.renderer.domElement.dataset.modelTextureUploads = String(this.textureUploads.length);
    const distance = terrain.controls.getDistance() / terrain.metresToWorld;
    const enabled = categories.some(category => this.settings[category]);
    this.group.visible = enabled && terrain.heightFactor === 1;
    if (!this.group.visible) {
      this.work = null;
      terrain.renderer.domElement.dataset.modelWorkPending = '0';
      this.visibleCounts = { buildings: 0, trees: 0, props: 0 };
      this.wantedTiles = [];
      this.report(enabled ? 'overview' : 'off');
      return;
    }
    const stamp = [...terrain.camera.position.toArray(), ...terrain.camera.quaternion.toArray(), ...terrain.controls.target.toArray(), terrain.camera.aspect, terrain.camera.fov].map(value => value.toFixed(3)).join(':') + ':' + terrain.artilleryCameraMode + ':' + terrain.renderProfile;
    if (this.work) {
      this.advanceWork(deadline);
      return;
    }
    if (!this.dirty && stamp === this.cameraStamp) return;
    const elapsed = performance.now() - this.lastUpdate;
    if (elapsed < 140) {
      if (this.timer === null) this.timer = setTimeout(() => { this.timer = null; this.terrain.invalidate(); }, 145 - elapsed);
      return;
    }
    this.cameraStamp = stamp;
    this.lastUpdate = performance.now();
    this.dirty = false;
    this.work = this.updateModels(distance);
    this.advanceWork(deadline);
  }

  advanceWork(deadline) {
    const result = drainWork(this.work, deadline);
    if (result.done) this.work = null;
    this.terrain.renderer.domElement.dataset.modelWorkPending = this.work ? '1' : '0';
    this.terrain.invalidate();
  }

  *updateModels(distance) {
    const terrain = this.terrain;
    const cameraPosition = terrain.camera.position.clone();
    const metres = terrain.metresToWorld;
    const navigating = ['fly', 'walk', 'sight'].includes(terrain.artilleryCameraMode);
    const center = navigating ? terrain.camera.position : terrain.controls.target;
    const targetX = (center.x - this.group.position.x) / metres;
    const targetZ = (center.z - this.group.position.z) / metres;
    const profile = terrain.renderProfile || 'balanced';
    const distant = !navigating && distance > 2400;
    const ranges = modelRanges(distance, profile, navigating);
    const maximumRange = Math.max(...categories.map(category => this.settings[category] ? ranges[category] : 0));
    const tileSize = this.manifest.tileSizeMetres;
    const origin = this.manifest.originMetres;
    this.wantedTiles = this.manifest.tiles.map(tile => ({ ...tile, distance: Math.hypot(origin[0] + (tile.x + .5) * tileSize - targetX, origin[1] + (tile.z + .5) * tileSize - targetZ) })).filter(tile => tile.distance < maximumRange + tileSize * .72 && (distant ? tile.counts.buildings > 0 : Object.values(tile.counts).some(count => count))).sort((first, second) => distant ? second.counts.buildings - first.counts.buildings : first.distance - second.distance).slice(0, navigating ? profile === 'low' ? 64 : profile === 'high' ? 176 : 128 : profile === 'low' ? 32 : profile === 'high' ? 96 : 64);
    for (const tile of this.wantedTiles) this.requestTile(tile);
    this.projection.copy(terrain.camera.projectionMatrix);
    if (navigating) { this.projection.elements[0] /= 1.3; this.projection.elements[5] /= 1.3; }
    this.projection.multiply(terrain.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
    const candidates = [];
    let processed = 0;
    const triangleLimits = profile === 'high' ? { buildings: 6000000, trees: 900000, props: 600000 } : profile === 'low' ? { buildings: 1600000, trees: 160000, props: 120000 } : { buildings: 3000000, trees: 400000, props: 300000 };
    const screenFactor = terrain.container.clientHeight / (2 * Math.tan(terrain.camera.fov * Math.PI / 360));
    const density = navigating ? 1 : distance > 700 ? 4 : distance > 450 ? 2 : 1;
    const minimumPixels = { buildings: distant ? .35 : .7, trees: 1.3, props: 2 };
    const budgets = profile === 'low' ? { buildings: 22000, trees: 2600, props: 1800 } : profile === 'high' ? { buildings: 65000, trees: 7500, props: 5500 } : { buildings: 38000, trees: 4500, props: 3000 };
    for (const tile of this.wantedTiles) {
      const groups = this.tileCache.get(tile.key);
      if (!groups) continue;
      for (const group of groups) {
        yield;
        const info = this.manifest.meshes[group.mesh];
        if (!this.settings[info.type] || /SM_RVTD/.test(info.name)) continue;
        const parts = this.prototypes.get(group.mesh);
        if (!parts) { this.requestBundle(info.bundle); continue; }
        for (const part of parts) part.material ||= this.materialFor(part.materialName);
        if (!parts.some(part => part.material.visible)) continue;
        const bounds = info.bounds;
        const radius = info.runtimeRadius ??= Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]) / 2 + Math.hypot((bounds[3] + bounds[0]) / 2, (bounds[4] + bounds[1]) / 2, (bounds[5] + bounds[2]) / 2);
        const baseTriangles = parts.runtimeTriangles ??= parts.reduce((sum, part) => sum + part.triangles, 0);
        const data = group.data;
        let history = this.lodHistory.get(data);
        if (!history) { history = new Uint8Array(group.instances).fill(2); this.lodHistory.set(data, history); }
        for (let index = 0; index < group.instances; index++) {
          if (++processed % 256 === 0) yield;
          const offset = index * 11;
          const rawX = data[offset];
          const rawY = data[offset + 1];
          const rawZ = data[offset + 2];
          const scaledRadiusMetres = radius * Math.max(Math.abs(data[offset + 7]), Math.abs(data[offset + 8]), Math.abs(data[offset + 9]));
          if ((rawX - targetX) ** 2 + (rawZ - targetZ) ** 2 > (ranges[info.type] + scaledRadiusMetres) ** 2) continue;
          if (info.type === 'trees' && density > 1 && ((Math.imul(Math.round(rawX), 73856093) ^ Math.imul(Math.round(rawZ), 19349663)) >>> 0) % density) continue;
          const scaledRadius = scaledRadiusMetres * metres;
          this.sphere.center.set(rawX * metres + this.group.position.x, rawY * metres + this.group.position.y, rawZ * metres + this.group.position.z);
          this.sphere.radius = scaledRadius;
          const cameraDistance = this.sphere.center.distanceTo(cameraPosition);
          const cameraMetres = cameraDistance / metres;
          if (cameraMetres > 60 && !this.frustum.intersectsSphere(this.sphere)) continue;
          const pixels = scaledRadius * screenFactor / Math.max(1, cameraDistance);
          if (cameraMetres > 60 && pixels < minimumPixels[info.type]) continue;
          const lod = distant ? 2 : modelLod(cameraMetres, pixels, profile, history[index]);
          history[index] = lod;
          if (lod !== 2) this.requestBundle(info.bundle, lod);
          const preferred = group.mesh + ':' + lod;
          const detail = lod !== 2 ? this.prototypes.get(preferred) : null;
          if (detail) for (const part of detail) part.material ||= this.materialFor(part.materialName);
          const ready = detail?.every(part => part.material.visible);
          candidates.push({ mesh: group.mesh, data, offset, type: info.type, distance: cameraMetres, order: group.order * 2000000 + offset, baseTriangles,
            detailKey: ready ? preferred : undefined, detailTriangles: ready ? detail.runtimeTriangles ??= detail.reduce((sum, part) => sum + part.triangles, 0) : baseTriangles });
        }
      }
    }
    const selected = yield* selectModelsWork(candidates, budgets, triangleLimits);
    const { grouped, counts } = yield* this.presence.retain(selected.grouped, this.manifest.meshes, this.settings);
    const metadata = terrain.renderer.domElement.dataset;
    metadata.modelCandidates = String(candidates.length);
    metadata.modelDeferred = String(candidates.length - Object.values(selected.counts).reduce((sum, count) => sum + count, 0));
    metadata.modelSceneInstances = String(Object.values(counts).reduce((sum, count) => sum + count, 0));
    metadata.modelSeenInstances = String(this.presence.count);
    metadata.modelPresence = 'scene';
    metadata.modelRangeBuildings = String(ranges.buildings);
    metadata.modelRangeTrees = String(ranges.trees);
    metadata.modelRangeProps = String(ranges.props);
    yield* this.updateBatchesWork(grouped);
    for (const lod of [0, 1, 2]) this.terrain.renderer.domElement.dataset['modelLod' + lod] = String([...grouped].filter(([key]) => (typeof key === 'number' ? 2 : Number(String(key).split(':')[1])) === lod).reduce((sum, [, instances]) => sum + instances.length, 0));
    this.visibleCounts = counts;
    const failed = this.failedTiles.size + this.failedBundles.size + this.textureFailures + this.shaderFailures;
    const pending = this.tileJobs.size + this.texturePending + this.bundleJobs.size - this.completedBundles.size - this.failedBundles.size + this.textureUploads.length + this.shaderWarmup.pending;
    this.report(failed ? 'partial' : pending ? 'loading' : 'ready');
  }

  updateBatches(grouped) {
    drainWork(this.updateBatchesWork(grouped));
  }

  *updateBatchesWork(grouped) {
    const terrain = this.terrain;
    grouped = yield* splitMirroredInstances(grouped, this.prototypes);
    const byModel = new Map();
    for (const identifier of new Set([...grouped.keys(), ...this.batches.keys()])) {
      const modelIndex = typeof identifier === 'number' ? identifier : Number(identifier.split(':')[0]);
      if (!byModel.has(modelIndex)) byModel.set(modelIndex, []);
      byModel.get(modelIndex).push(identifier);
    }
    const navigating = ['fly', 'walk', 'sight'].includes(terrain.artilleryCameraMode);
    const factor = terrain.metresToWorld;
    const focusX = Math.round((terrain.camera.position.x - this.group.position.x) / factor / 24) * 24;
    const focusZ = Math.round((terrain.camera.position.z - this.group.position.z) / factor / 24) * 24;
    const collisionRange = navigating ? 144 : Math.max(144, 60 / factor + 24);
    const focusStamp = focusX + ':' + focusZ + ':' + collisionRange;
    let uploadBytes = 0;
    let newParts = 0;
    for (const [modelIndex, identifiers] of byModel) {
      const updates = [];
      for (const identifier of identifiers) {
        const instances = grouped.get(identifier);
        if (!instances) continue;
        const lod = typeof identifier === 'number' ? 2 : Number(identifier.split(':')[1]);
        const mirrored = typeof identifier === 'string' && identifier.endsWith(':mirror');
        const info = this.manifest.meshes[modelIndex];
        const parts = this.prototypes.get(identifier);
        for (const part of parts) part.material ||= this.materialFor(part.materialName);
        const existing = this.batches.get(identifier);
        const recreated = !existing || existing.length !== parts.length || existing[0].instanceMatrix.count < instances.length;
        const previous = this.batchSelections.get(identifier);
        const capacity = recreated ? Math.max(16, 2 ** Math.ceil(Math.log2(instances.length))) : existing[0].instanceMatrix.count;
        let firstChanged = 0;
        let lastChanged = instances.length;
        if (!recreated && previous) {
          while (firstChanged < instances.length && instances[firstChanged].data === previous[firstChanged]?.data && instances[firstChanged].offset === previous[firstChanged]?.offset) firstChanged++;
          while (lastChanged > firstChanged && instances[lastChanged - 1].data === previous[lastChanged - 1]?.data && instances[lastChanged - 1].offset === previous[lastChanged - 1]?.offset) lastChanged--;
        }
        const matrices = new Float32Array((lastChanged - firstChanged) * 16);
        const colors = new Float32Array((lastChanged - firstChanged) * 3);
        for (let index = firstChanged; index < lastChanged; index++) {
          const { data, offset } = instances[index];
          this.position.fromArray(data, offset);
          this.rotation.fromArray(data, offset + 3);
          this.scale.fromArray(data, offset + 7);
          if (mirrored) this.scale.x *= -1;
          this.matrix.compose(this.position, this.rotation, this.scale).toArray(matrices, (index - firstChanged) * 16);
          if (data[offset + 10] > 0) this.tint.setHex(Math.round(data[offset + 10]), THREE.SRGBColorSpace);
          else this.tint.setRGB(1, 1, 1);
          this.tint.toArray(colors, (index - firstChanged) * 3);
          if (index % 64 === 63) yield;
        }
        const selectionChanged = recreated || firstChanged !== instances.length || previous?.length !== instances.length;
        let bounds = existing?.[0].boundingSphere;
        if (selectionChanged || !bounds) {
          const box = new THREE.Box3();
          const radius = info.runtimeRadius || (parts.runtimeRadius ??= Math.max(...parts.map(part => {
            if (!part.geometry.boundingSphere) part.geometry.computeBoundingSphere();
            return part.geometry.boundingSphere.radius + part.geometry.boundingSphere.center.length();
          })));
          for (let index = 0; index < instances.length; index++) {
            if (index % 256 === 255) yield;
            const { data, offset } = instances[index];
            const extent = radius * Math.max(Math.abs(data[offset + 7]), Math.abs(data[offset + 8]), Math.abs(data[offset + 9]));
            box.expandByPoint(this.position.set(data[offset] - extent, data[offset + 1] - extent, data[offset + 2] - extent));
            box.expandByPoint(this.position.set(data[offset] + extent, data[offset + 1] + extent, data[offset + 2] + extent));
          }
          bounds = box.getBoundingSphere(new THREE.Sphere());
        }
        const refreshColliders = selectionChanged || this.colliderFocus.get(identifier) !== focusStamp;
        let colliders = this.colliderGroups.get(identifier) || [];
        let cached = this.colliderInstances.get(identifier);
        if (refreshColliders) {
          colliders = [];
          const nextCache = new Map();
          if (info.solid && info.type === 'buildings') for (let index = 0; index < instances.length; index++) {
            if (index % 64 === 63) yield;
            const { data, offset } = instances[index];
            const radius = (info.runtimeRadius || 0) * Math.max(Math.abs(data[offset + 7]), Math.abs(data[offset + 8]), Math.abs(data[offset + 9]));
            if ((data[offset] - focusX) ** 2 + (data[offset + 2] - focusZ) ** 2 > (collisionRange + radius) ** 2) continue;
            let meshes = cached?.get(data)?.get(offset);
            if (!meshes || meshes.length !== parts.length || meshes[0]?.geometry !== parts[0].geometry) {
              this.position.fromArray(data, offset); this.rotation.fromArray(data, offset + 3); this.scale.fromArray(data, offset + 7);
              if (mirrored) this.scale.x *= -1;
              this.matrix.compose(this.position, this.rotation, this.scale);
              meshes = parts.map(part => {
                const collider = new THREE.Mesh(part.geometry, part.material);
                collider.matrixAutoUpdate = false;
                collider.matrixWorld.multiplyMatrices(this.group.matrixWorld, this.matrix);
                return collider;
              });
            }
            if (!nextCache.has(data)) nextCache.set(data, new Map());
            nextCache.get(data).set(offset, meshes);
            colliders.push(...meshes);
          }
          cached = nextCache;
        }
        updates.push({ identifier, instances, parts, info, lod, existing, recreated, capacity, firstChanged, matrices, colors, bounds, colliders, cached, refreshColliders });
        yield;
      }
      for (const identifier of identifiers) if (!grouped.has(identifier)) {
        if (this.batches.get(identifier)?.some(batch => batch.visible)) terrain.shadowRevision = (terrain.shadowRevision || 0) + 1;
        for (const batch of this.batches.get(identifier) || []) this.drawBatches.hide(batch);
        this.colliderIndex.removeGroup(identifier);
        this.colliderGroups.delete(identifier);
        this.colliderInstances.delete(identifier);
        this.colliderFocus.delete(identifier);
        this.colliderCoverage.delete(identifier);
      }
      for (const update of updates) {
        const { identifier, instances, parts, info, lod, recreated, capacity, firstChanged, matrices, colors, bounds, colliders, cached, refreshColliders } = update;
        let batches = update.existing;
        if (recreated) {
          for (const batch of batches || []) { this.drawBatches.remove(batch); this.group.remove(batch); batch.dispose(); }
          const matrixAttribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(THREE.DynamicDrawUsage);
          const colorAttribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
          batches = parts.map(part => {
            const batch = new THREE.InstancedMesh(part.geometry, part.material, 0);
            batch.instanceMatrix = matrixAttribute;
            batch.instanceColor = colorAttribute;
            batch.frustumCulled = true;
            batch.matrixAutoUpdate = false;
            batch.matrixWorldAutoUpdate = false;
            batch.matrixWorld.copy(this.group.matrixWorld);
            batch.name = info.name;
            batch.userData.modelIndex = modelIndex;
            batch.userData.lod = lod;
            batch.userData.perInstanceCulling = true;
            batch.castShadow = part.material.userData.castShadow !== false && (info.type === 'buildings' || info.type === 'trees' || Boolean(info.solid && Math.max(info.bounds[3] - info.bounds[0], info.bounds[4] - info.bounds[1], info.bounds[5] - info.bounds[2]) >= 4));
            batch.receiveShadow = true;
            this.group.add(batch);
            return batch;
          });
          this.batches.set(identifier, batches);
          newParts += parts.length;
        }
        if (matrices.length) {
          const matrixAttribute = batches[0].instanceMatrix;
          const colorAttribute = batches[0].instanceColor;
          matrixAttribute.array.set(matrices, firstChanged * 16);
          colorAttribute.array.set(colors, firstChanged * 3);
          matrixAttribute.clearUpdateRanges(); colorAttribute.clearUpdateRanges();
          matrixAttribute.addUpdateRange(firstChanged * 16, matrices.length);
          colorAttribute.addUpdateRange(firstChanged * 3, colors.length);
          matrixAttribute.needsUpdate = true; colorAttribute.needsUpdate = true;
          uploadBytes += matrices.byteLength + colors.byteLength;
        }
        if (recreated || matrices.length || batches.some(batch => batch.count !== instances.length || !batch.visible)) terrain.shadowRevision = (terrain.shadowRevision || 0) + 1;
        for (const batch of batches) { batch.count = instances.length; batch.boundingSphere = bounds; batch.visible = true; this.drawBatches.sync(batch); }
        this.batchSelections.set(identifier, instances);
        if (refreshColliders) {
          this.colliderGroups.set(identifier, colliders);
          this.colliderInstances.set(identifier, cached);
          this.colliderFocus.set(identifier, focusStamp);
          if (info.solid && info.type === 'buildings') this.colliderCoverage.set(identifier, { focusX, focusZ, range: collisionRange });
          this.colliderIndex.setGroup(identifier, colliders);
        } else if (!this.colliderIndex.groups.has(identifier)) this.colliderIndex.setGroup(identifier, colliders);
      }
      if (uploadBytes >= 524288 || newParts >= 12) { uploadBytes = 0; newParts = 0; yield 'frame'; }
      else yield;
    }
    const residency = this.drawBatches.stats;
    const metadata = terrain.renderer.domElement.dataset;
    metadata.modelResidentPools = String(residency.pools);
    metadata.modelResidentGeometries = String(residency.geometries);
    metadata.modelResidentInstances = String(residency.instances);
    metadata.modelHiddenInstances = String(residency.instances - residency.visibleInstances);
    metadata.modelPoolAllocations = String(residency.createdPools);
    this.colliders = [...grouped.keys()].flatMap(identifier => this.colliderGroups.get(identifier) || []);
    terrain.renderer.domElement.dataset.collisionMeshes = String(this.colliderIndex.entries.size);
  }

  intersectColliders(raycaster) {
    const hits = this.colliderIndex.intersect(raycaster);
    const factor = this.terrain.metresToWorld;
    const start = raycaster.ray.at(raycaster.near, new THREE.Vector3());
    const end = raycaster.ray.at(Number.isFinite(raycaster.far) ? raycaster.far : 0, new THREE.Vector3());
    const uncovered = new Set();
    for (const [key, coverage] of this.colliderCoverage) {
      const outside = point => Math.hypot((point.x - this.group.position.x) / factor - coverage.focusX, (point.z - this.group.position.z) / factor - coverage.focusZ) > coverage.range;
      if (!Number.isFinite(raycaster.far) || outside(start) || outside(end)) uncovered.add(key);
    }
    if (uncovered.size) {
      const hit = this.pick(raycaster, { keys: uncovered, solidOnly: true });
      if (hit && (!hits.length || hit.distance < hits[0].distance)) hits.unshift(hit);
    }
    this.terrain.renderer.domElement.dataset.collisionCandidates = String(this.colliderIndex.lastCandidates);
    this.terrain.renderer.domElement.dataset.collisionFallbackGroups = String(uncovered.size);
    return hits;
  }

  pick(raycaster, { keys = null, solidOnly = false } = {}) {
    if (!this.group.visible) return null;
    const instanceMatrix = new THREE.Matrix4();
    const worldMatrix = new THREE.Matrix4();
    const inverse = new THREE.Matrix4();
    const localRay = new THREE.Ray();
    const intersection = new THREE.Vector3();
    const carrier = new THREE.Mesh();
    const worldBounds = new THREE.Sphere();
    carrier.matrixAutoUpdate = false;
    let closest = null;
    for (const [key, batches] of this.batches) {
      if (keys && !keys.has(key)) continue;
      if (solidOnly) {
        const info = this.manifest.meshes[typeof key === 'number' ? key : Number(key.split(':')[0])];
        if (!info.solid || info.type !== 'buildings') continue;
      }
      if (!batches[0]?.visible || !batches.some(batch => batch.material.visible)) continue;
      if (batches[0].boundingSphere && !raycaster.ray.intersectsSphere(worldBounds.copy(batches[0].boundingSphere).applyMatrix4(batches[0].matrixWorld))) continue;
      let bounds = this.pickBounds.get(key);
      if (!bounds || bounds.parts !== batches.length) {
        const box = new THREE.Box3();
        for (const batch of batches) { batch.geometry.computeBoundingBox(); box.union(batch.geometry.boundingBox); }
        bounds = { box, parts: batches.length };
        this.pickBounds.set(key, bounds);
      }
      const first = batches[0];
      for (let index = 0; index < first.count; index++) {
        first.getMatrixAt(index, instanceMatrix);
        worldMatrix.multiplyMatrices(first.matrixWorld, instanceMatrix);
        if (worldMatrix.determinant() === 0) continue;
        localRay.copy(raycaster.ray).applyMatrix4(inverse.copy(worldMatrix).invert());
        if (!localRay.intersectBox(bounds.box, intersection)) continue;
        const lowerDistance = bounds.box.containsPoint(localRay.origin) ? 0 : intersection.applyMatrix4(worldMatrix).distanceTo(raycaster.ray.origin);
        if (lowerDistance > raycaster.far || closest && lowerDistance > closest.distance) continue;
        carrier.matrixWorld.copy(worldMatrix);
        for (const batch of batches) {
          if (!batch.material.visible) continue;
          carrier.geometry = batch.geometry;
          carrier.material = batch.material;
          const hits = [];
          carrier.raycast(raycaster, hits);
          for (const hit of hits) if (!closest || hit.distance < closest.distance) { hit.object = batch; hit.instanceId = index; closest = hit; }
        }
      }
    }
    return closest;
  }

  showcase() {
    if (!this.manifest) return this.terrain.map.center;
    return this.manifest.showcaseMetres.map((coordinate, axis) => (coordinate * 100 - this.terrain.map.bounds[axis]) / this.terrain.map.bounds[2] * 2048);
  }

  report(state) {
    const counts = this.visibleCounts;
    const instances = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const status = { state, instances, counts, preload: { ...this.preloadStatus }, loading: this.settings.loading || 'stream', tiles: this.tileCache.size, bundles: this.prototypes.size, textures: this.textures.size, error: this.error, preparing: this.textureUploads.length + this.shaderWarmup.pending, failures: this.failedTiles.size + this.failedBundles.size + this.textureFailures + this.shaderFailures, pending: this.tileJobs.size + this.texturePending + this.bundleJobs.size - this.completedBundles.size - this.failedBundles.size + this.textureUploads.length + this.shaderWarmup.pending };
    const stamp = JSON.stringify(status);
    if (stamp === this.statusStamp) return;
    this.statusStamp = stamp;
    const metadata = this.terrain.renderer.domElement.dataset;
    metadata.modelLoading = this.settings.loading || 'stream';
    metadata.modelPreload = this.preloadStatus.state;
    metadata.modelPreloadCompleted = String(this.preloadStatus.completed);
    metadata.modelPreloadTotal = String(this.preloadStatus.total);
    metadata.models = state;
    metadata.modelInstances = String(instances);
    metadata.modelBuildings = String(counts.buildings);
    metadata.modelTrees = String(counts.trees);
    metadata.modelProps = String(counts.props);
    metadata.modelTiles = String(status.tiles);
    metadata.modelMeshes = String(status.bundles);
    metadata.modelTextures = String(status.textures);
    metadata.modelPending = String(status.pending);
    metadata.modelVersion = this.manifest?.sourceVersion || '';
    this.terrain.callbacks.onModels?.(status);
  }
}
