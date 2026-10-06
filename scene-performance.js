import * as THREE from './vendor/three/three.module.js';
import { shadowFrame } from './scene-shadows.js';

const profiles = ['low', 'balanced', 'high'];

export class ScenePerformance {
  constructor(terrain) {
    this.terrain = terrain;
    this.samples = [];
    this.lastFrame = 0;
    this.lastDisplay = 0;
    this.slowFrames = 0;
    this.fastFrames = 0;
    this.previousCamera = terrain.camera.position.clone();
    this.raycaster = new THREE.Raycaster();
    this.selection = new THREE.Box3Helper(new THREE.Box3(), '#d5ed79');
    this.selection.visible = false;
    terrain.scene.add(this.selection);
    this.profile = terrain.container.clientWidth < 650 ? 'low' : 'balanced';
    terrain.renderProfile = this.profile;
  }

  setSettings(settings) {
    this.settings = settings;
    const enteringAuto = settings.quality === 'auto' && this.requestedQuality !== 'auto';
    const deviceMemory = globalThis.navigator?.deviceMemory;
    const hardwareConcurrency = globalThis.navigator?.hardwareConcurrency;
    const constrained = (deviceMemory && deviceMemory <= 4) || (hardwareConcurrency && hardwareConcurrency <= 4);
    const profile = profiles.includes(settings.quality) ? settings.quality : enteringAuto ? (this.terrain.container.clientWidth < 650 || constrained ? 'low' : 'balanced') : this.profile;
    this.requestedQuality = settings.quality;
    const changed = profile !== this.terrain.renderProfile;
    this.profile = profile;
    const terrain = this.terrain;
    terrain.renderProfile = profile;
    const ratio = profile === 'high' ? 1.75 : profile === 'low' ? 1 : 1.25;
    terrain.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, ratio));
    const shadows = Boolean(settings.shadows && profile !== 'low');
    if (terrain.renderer.shadowMap.enabled !== shadows) {
      terrain.renderer.shadowMap.enabled = shadows;
      terrain.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      terrain.scene.traverse(object => { if (object.material) for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.needsUpdate = true; });
    }
    terrain.sun.castShadow = shadows;
    const resolution = profile === 'high' ? 2048 : 1024;
    if (terrain.sun.shadow.mapSize.x !== resolution) {
      terrain.sun.shadow.map?.dispose();
      terrain.sun.shadow.map = null;
      terrain.sun.shadow.mapSize.set(resolution, resolution);
    }
    if (terrain.distantSun) {
      terrain.distantSun.castShadow = shadows;
      const distant = terrain.distantSun.shadow;
      if (distant.mapSize.x !== resolution) { distant.map?.dispose(); distant.map = null; distant.mapSize.set(resolution, resolution); }
      distant.needsUpdate = shadows;
    }
    this.shadowStamp = '';
    this.distantShadowStamp = '';
    terrain.renderer.shadowMap.autoUpdate = false;
    terrain.renderer.shadowMap.needsUpdate = shadows;
    terrain.resize();
    if (changed) {
      this.benchmark = null;
      terrain.detail.signature = '';
      terrain.props.work = null;
    }
    terrain.props.wake();
    terrain.renderer.domElement.dataset.quality = profile;
    this.display();
  }

  update(timestamp) {
    const terrain = this.terrain;
    const delta = timestamp - this.lastFrame;
    const continuous = Boolean(this.benchmark || this.continuousFrame);
    this.lastFrame = timestamp;
    if (this.benchmark && delta > 0) this.benchmark.samples.push(delta);
    if (continuous && delta > 0 && delta < 1000) {
      this.samples.push(delta);
      if (this.samples.length > 300) this.samples.shift();
      if (this.settings?.quality === 'auto' && !this.benchmark) {
        this.slowFrames = delta > 38 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1);
        this.fastFrames = delta < 18 ? this.fastFrames + 1 : 0;
        if (this.slowFrames > 24 && this.profile !== 'low') {
          this.profile = profiles[Math.max(0, profiles.indexOf(this.profile) - 1)];
          this.slowFrames = 0;
          this.setSettings(this.settings);
        } else if (this.fastFrames > 240 && this.profile === 'low' && terrain.container.clientWidth >= 650) {
          this.profile = 'balanced'; this.fastFrames = 0; this.setSettings(this.settings);
        }
      }
    }
    if (this.settings?.collision && terrain.artilleryCameraMode !== 'walk' && (terrain.props.colliders?.length || terrain.props.colliderCoverage?.size) && this.previousCamera.distanceTo(terrain.camera.position) > .005) {
      const movement = terrain.camera.position.clone().sub(this.previousCamera);
      const distance = movement.length();
      if (distance < 60) {
        this.raycaster.set(this.previousCamera, movement.normalize());
        this.raycaster.near = 0;
        this.raycaster.far = distance + .25;
        const hits = terrain.props.intersectColliders ? terrain.props.intersectColliders(this.raycaster) : this.raycaster.intersectObjects(terrain.props.colliders, false);
        const hit = hits[0];
        if (hit) terrain.camera.position.copy(this.previousCamera).addScaledVector(movement, Math.max(0, hit.distance - .3));
      }
    }
    this.previousCamera.copy(terrain.camera.position);
    this.updateShadows(timestamp);
    if (timestamp - this.lastDisplay > 700) { this.display(); this.lastDisplay = timestamp; }
    if (this.benchmark && timestamp < this.benchmark.until) terrain.invalidate();
    else if (this.benchmark) {
      const samples = this.benchmark.samples.slice().sort((first, second) => first - second);
      const elapsed = timestamp - this.benchmark.start;
      const fps = this.benchmark.frames * 1000 / Math.max(1, elapsed);
      if (this.benchmark.forward && terrain.artilleryCameraMode === this.benchmark.mode) {
        const saved = this.benchmark.camera; terrain.camera.position.copy(saved.position); terrain.camera.quaternion.copy(saved.quaternion); terrain.controls.target.copy(saved.target);
        Object.assign(terrain.artillery.navigation, { feet: saved.feet, velocity: saved.velocity, grounded: saved.grounded, lastTime: 0 });
        terrain.artillery.navigation.euler.setFromQuaternion(terrain.camera.quaternion, 'YXZ'); terrain.artillery.navigation.warmKey = null; this.previousCamera.copy(terrain.camera.position); terrain.invalidate();
      }
      const cpuMs = Object.fromEntries(Object.entries(this.benchmark.cpuTotals).map(([name, total]) => [name, Number((total / Math.max(1, this.benchmark.cpuFrames)).toFixed(3))]));
      const report = { map: terrain.map?.id, mode: this.benchmark.mode, moving: this.benchmark.forward, quality: this.profile, cpuMs, cpuMaxMs: this.benchmark.cpuMaximum, p99FrameMs: Number((samples[Math.floor(samples.length * .99)] || 0).toFixed(1)), maxFrameMs: Number((samples.at(-1) || 0).toFixed(1)), stalledFrames: samples.filter(value => value > 50).length, durationSeconds: elapsed / 1000, frames: this.benchmark.frames, fps: Number(fps.toFixed(1)), p95FrameMs: Number((samples[Math.floor(samples.length * .95)] || 0).toFixed(1)), drawCalls: terrain.renderer.info.render.calls, triangles: terrain.renderer.info.render.triangles, geometries: terrain.renderer.info.memory.geometries, textures: terrain.renderer.info.memory.textures, longFrames: this.benchmark.longFrames, at: new Date().toISOString() };
      this.benchmark = null;
      terrain.callbacks.onBenchmark?.(report);
    }
    if (this.benchmark) this.benchmark.frames++;
  }

  updateShadows(timestamp) {
    const terrain = this.terrain;
    const metadata = terrain.renderer.domElement?.dataset;
    if (metadata) metadata.shadows = terrain.renderer.shadowMap.enabled ? terrain.distantSun ? 'cascaded' : 'local' : 'off';
    if (!terrain.renderer.shadowMap.enabled) return;
    const shadowRevision = terrain.shadowRevision || 0;
    if (this.shadowStamp && timestamp - this.lastShadow < 100 && shadowRevision === this.shadowRevisionAtUpdate) {
      terrain.invalidate?.();
      return;
    }
    if (terrain.distantSun) {
      const distantFrame = shadowFrame(terrain, true);
      const distantStamp = [...distantFrame.target.toArray(), ...distantFrame.position.toArray(), distantFrame.extent, terrain.shadowRevision || 0].map(value => value.toFixed(4)).join(':') + ':' + terrain.props.group?.visible;
      if (distantStamp !== this.distantShadowStamp) {
        if (!this.distantShadowStamp || timestamp - this.lastDistantShadow >= 400) {
          this.applyShadowFrame(terrain.distantSun, distantFrame);
          terrain.distantSun.shadow.needsUpdate = true;
          this.distantShadowStamp = distantStamp; this.lastDistantShadow = timestamp;
          if (metadata) { metadata.shadowFarExtentMetres = String(Math.round(distantFrame.extentMetres)); metadata.shadowBlend = 'near-far-fade'; }
        } else terrain.invalidate();
      }
    }
    const frame = shadowFrame(terrain);
    const stamp = [...frame.target.toArray(), ...frame.position.toArray(), frame.extent, terrain.shadowRevision || 0].map(value => value.toFixed(5)).join(':') + ':' + terrain.props.group?.visible;
    if (stamp === this.shadowStamp) return;
    if (this.shadowStamp && timestamp - this.lastShadow < 100) { terrain.invalidate(); return; }
    this.applyShadowFrame(terrain.sun, frame);
    Object.assign(terrain.renderer.domElement.dataset, { shadowExtentMetres: String(frame.extentMetres), shadowTexelMetres: frame.texelMetres.toFixed(3), shadowNormalBiasMetres: '.16', shadowMapSize: String(frame.resolution) });
    this.lastShadow = timestamp;
    this.shadowRevisionAtUpdate = shadowRevision;
    this.shadowStamp = stamp;
  }

  applyShadowFrame(light, frame) {
    light.target.position.copy(frame.target);
    if (!light.target.parent) this.terrain.scene.add(light.target);
    light.position.copy(frame.position);
    const shadow = light.shadow;
    Object.assign(shadow.camera, { left: -frame.extent, right: frame.extent, top: frame.extent, bottom: -frame.extent, near: frame.near, far: frame.far });
    shadow.camera.updateProjectionMatrix();
    shadow.bias = frame.bias;
    shadow.normalBias = frame.normalBias;
    this.terrain.renderer.shadowMap.needsUpdate = true;
  }

  recordFrame(costs, moving = false, resources = null) {
    this.frameCost = costs;
    this.continuousFrame = Boolean(this.benchmark || moving || this.terrain.frame !== null);
    if (!this.benchmark) return;
    this.benchmark.cpuFrames++;
    if (costs.total > 25 && this.benchmark.longFrames.length < 32) this.benchmark.longFrames.push({ frame: this.benchmark.frames, costs: Object.fromEntries(Object.entries(costs).map(([name, value]) => [name, Number(value.toFixed(3))])), resources });
    for (const [name, value] of Object.entries(costs)) {
      this.benchmark.cpuTotals[name] = (this.benchmark.cpuTotals[name] || 0) + value;
      this.benchmark.cpuMaximum[name] = Number(Math.max(this.benchmark.cpuMaximum[name] || 0, value).toFixed(3));
    }
  }

  measure() {
    this.samples = [];
    const start = performance.now();
    this.lastFrame = start;
    this.benchmark = { start, until: start + 10000, mode: this.terrain.artilleryCameraMode || 'orbit', forward: ['fly', 'walk'].includes(this.terrain.artilleryCameraMode) && Boolean(document.getElementById('navigation-benchmark-forward')?.checked), camera: { position: this.terrain.camera.position.clone(), quaternion: this.terrain.camera.quaternion.clone(), target: this.terrain.controls.target.clone(), feet: this.terrain.artillery.navigation.feet, velocity: this.terrain.artillery.navigation.velocity, grounded: this.terrain.artillery.navigation.grounded }, frames: 0, samples: [], cpuFrames: 0, cpuTotals: {}, cpuMaximum: {}, longFrames: [] };
    this.terrain.invalidate();
  }

  display() {
    const terrain = this.terrain;
    const fps = this.samples.length > 4 ? 1000 / (this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length) : null;
    const report = { fps, quality: this.profile, draws: terrain.renderer.info.render.calls, triangles: terrain.renderer.info.render.triangles, textures: terrain.renderer.info.memory.textures, geometries: terrain.renderer.info.memory.geometries, benchmarking: Boolean(this.benchmark), cpuMs: this.frameCost };
    terrain.renderer.domElement.dataset.fps = fps ? fps.toFixed(1) : '';
    terrain.callbacks.onPerformance?.(report);
  }

  inspect(clientX, clientY) {
    const terrain = this.terrain;
    const rectangle = terrain.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2((clientX - rectangle.left) / rectangle.width * 2 - 1, 1 - (clientY - rectangle.top) / rectangle.height * 2), terrain.camera);
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    const hit = terrain.props.pick(this.raycaster);
    if (!hit) { this.selection.visible = false; terrain.callbacks.onInspect?.(null); terrain.invalidate(); return null; }
    const info = terrain.props.manifest.meshes[hit.object.userData.modelIndex];
    const matrix = new THREE.Matrix4();
    hit.object.getMatrixAt(hit.instanceId, matrix);
    matrix.premultiply(hit.object.matrixWorld);
    hit.object.geometry.computeBoundingBox();
    this.selection.box.copy(hit.object.geometry.boundingBox).applyMatrix4(matrix);
    this.selection.visible = true;
    const position = [hit.point.x + 1024, hit.point.z + 1024];
    const height = hit.point.y / terrain.metresToWorld + terrain.heightBaseline;
    terrain.callbacks.onInspect?.({ name: info.name, category: info.type, height, ground: terrain.heightAt(position), position, lod: hit.object.userData.lod });
    terrain.invalidate();
    return { position, height };
  }

  clearSelection() {
    this.selection.visible = false;
    this.terrain.callbacks.onInspect?.(null);
  }

  clear() {
    this.clearSelection();
    this.samples = [];
    this.lastFrame = 0;
    this.continuousFrame = false;
    this.slowFrames = 0; this.fastFrames = 0;
    this.benchmark = null;
    this.shadowStamp = '';
    this.distantShadowStamp = '';
    this.shadowRevisionAtUpdate = -1;
  }
}
