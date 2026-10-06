import * as THREE from './vendor/three/three.module.js';
import { sceneManifest } from './terrain-height-detail.js';
import { fogRange, skyColors, skyTexture } from './scene-atmosphere.js';
import { applyGroundMaterial } from './ground-material.js';

export function temperatureColor(temperature) {
  const value = Math.max(1000, Math.min(40000, temperature)) / 100;
  const red = value <= 66 ? 255 : 329.698727446 * (value - 60) ** -.1332047592;
  const green = value <= 66 ? 99.4708025861 * Math.log(value) - 161.1195681661 : 288.1221695283 * (value - 60) ** -.0755148492;
  const blue = value >= 66 ? 255 : value <= 19 ? 0 : 138.5177312231 * Math.log(value - 10) - 305.0447927307;
  return new THREE.Color().setRGB(...[red, green, blue].map(component => Math.max(0, Math.min(255, component)) / 255), THREE.SRGBColorSpace);
}

export class TerrainEnvironment {
  constructor(terrain) { this.terrain = terrain; this.textures = []; this.revision = 0; this.fogStamp = ''; }
  clear() {
    this.revision++;
    this.terrain.scene.background = null;
    this.terrain.scene.environment = null;
    this.terrain.props?.setEnvironment?.(null);
    this.sky?.dispose(); this.sky = null;
    this.environmentMap?.dispose(); this.environmentMap = null;
    this.skySettings = null;
    this.fogStamp = '';
    this.textures.forEach(texture => texture.dispose()); this.textures = [];
    this.terrain.scene.fog = null;
  }
  async load(map) {
    this.clear(); const revision = this.revision;
    let failed = false;
    try {
      const record = (await sceneManifest())[map.id]; if (!record || revision !== this.revision) return;
      this.skyFor(record.sky);
      const landscape = record.landscape; const loader = new THREE.TextureLoader();
      const files = [...landscape.files, ...landscape.layers.map(layer => layer + '.webp'), '@ground-surface.webp'];
      const textures = await Promise.all(files.map(async (filename, index) => {
        const texture = await loader.loadAsync(filename.startsWith('@') ? './assets/material-surfaces/' + filename.slice(1) : './' + landscape.directory + '/' + filename);
        if (failed || revision !== this.revision) { texture.dispose(); return null; }
        this.textures.push(texture);
        texture.colorSpace = index < landscape.files.length || filename.startsWith('@') ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        texture.flipY = !filename.startsWith('@'); texture.wrapS = texture.wrapT = index < landscape.files.length || filename.startsWith('@') ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        const anisotropy = this.terrain.renderProfile === 'high' ? 8 : this.terrain.renderProfile === 'low' ? 2 : 4;
        texture.anisotropy = Math.min(anisotropy, this.terrain.renderer.capabilities.getMaxAnisotropy()); texture.needsUpdate = true; return texture;
      }));
      if (revision !== this.revision) return;
      this.textures = textures;
      const masks = textures.slice(0, landscape.files.length); const layers = textures.slice(landscape.files.length, -1);
      const material = this.terrain.terrainMaterial;
      applyGroundMaterial(material, this.terrain, landscape, masks, layers, textures.at(-1));
      this.terrain.detail.clear(true);
      this.terrain.renderer.domElement.dataset.groundLayers = String(layers.length);
      this.terrain.renderer.domElement.dataset.groundSurface = 'normal-roughness-atlas';
      this.terrain.invalidate();
    } catch (error) {
      failed = true;
      if (revision === this.revision) {
        this.textures.forEach(texture => texture.dispose()); this.textures = [];
        this.terrain.renderer.domElement.dataset.groundLayers = 'error'; this.terrain.callbacks.onArtilleryError?.('地表材质加载失败：' + error.message);
      }
    }
  }
  skyFor(settings) {
    if (!settings) return;
    const terrain = this.terrain; const pitch = settings.sun.pitch * Math.PI / 180; const yaw = settings.sun.yaw * Math.PI / 180;
    const sun = new THREE.Vector3(-Math.cos(pitch) * Math.cos(yaw), -Math.sin(pitch), -Math.cos(pitch) * Math.sin(yaw)).normalize();
    terrain.sunDirection = sun; terrain.sun.color.copy(temperatureColor(settings.sun.temperature)); terrain.sun.intensity = 2;
    terrain.sun.target.position.copy(terrain.controls.target);
    terrain.sun.position.copy(terrain.sun.target.position).addScaledVector(sun, 1000);
    if (!terrain.sun.target.parent) terrain.scene.add(terrain.sun.target);
    terrain.shadowRevision = (terrain.shadowRevision || 0) + 1;
    const colors = skyColors(settings);
    terrain.hemisphere.intensity = 1.25 * settings.skyLightIntensity;
    terrain.hemisphere.color.copy(colors.horizon); terrain.hemisphere.groundColor.copy(colors.ground);
    this.sky = skyTexture(settings, sun, terrain.sun.color);
    terrain.scene.background = this.sky;
    if (terrain.renderer.isWebGLRenderer) {
      const generator = new THREE.PMREMGenerator(terrain.renderer);
      this.environmentMap = generator.fromEquirectangular(this.sky);
      terrain.scene.environment = this.environmentMap.texture;
      terrain.scene.environmentIntensity = .35 * settings.skyLightIntensity;
      terrain.props?.setEnvironment?.(this.environmentMap.texture, settings.skyLightIntensity);
      generator.dispose();
    }
    this.skySettings = settings;
    const range = fogRange(settings.fog, terrain);
    terrain.scene.fog = new THREE.Fog(colors.horizon, range.near, range.far);
    Object.assign(terrain.renderer.domElement.dataset, { environmentLighting: 'sky-reflection', fogNearMetres: String(range.near / terrain.metresToWorld), fogFarMetres: String(range.far / terrain.metresToWorld) });
    terrain.renderer.domElement.dataset.skyWorld = settings.world;
  }
  update() {
    if (!this.skySettings || !this.terrain.scene.fog) return;
    const range = fogRange(this.skySettings.fog, this.terrain);
    const stamp = range.near.toFixed(1) + ':' + range.far.toFixed(1);
    if (stamp === this.fogStamp) return;
    this.fogStamp = stamp;
    Object.assign(this.terrain.scene.fog, range);
    this.terrain.renderer.domElement.dataset.fogFarMetres = String(Math.round(range.far / this.terrain.metresToWorld));
  }
}

