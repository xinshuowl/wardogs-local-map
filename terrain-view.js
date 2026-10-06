import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { PropView } from './prop-view.js';
import { TerrainDetail } from './terrain-detail.js';
import { ScenePerformance } from './scene-performance.js';
import { ArtilleryScene } from './artillery-scene.js';
import { detailHeights } from './terrain-height-detail.js';
import { TerrainEnvironment } from './terrain-environment.js';
import { terrainDepthMaterial, applySceneShadows } from './scene-shadows.js';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const hiddenPosition = [-100000, -100000];

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('本地地形纹理未能加载。'));
    image.src = url;
  });
}

async function readLocal(url, type) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('本地 3D 资源缺失：' + url);
  return type === 'json' ? response.json() : response.arrayBuffer();
}

export class TerrainView {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.active = false;
    this.ready = false;
    this.contextLost = false;
    this.contextRestorePromise = null;
    this.revision = 0;
    this.frame = null;
    this.hoverFrame = null;
    this.pendingHover = null;
    this.heightFactor = 1;
    this.pointerStarts = new Map();
    this.hadMultiplePointers = false;
    this.settings = { brightness: 60, view: 'tactical' };
    this.brightnessUniform = { value: 1 };
    this.saturationUniform = { value: .22 };
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = .95;
    this.renderer.domElement.setAttribute('aria-label', '真实三维地形，拖动旋转，右键拖动平移，滚轮缩放');
    this.renderer.domElement.dataset.terrain = 'loading';
    container.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#20281e');
    this.hemisphere = new THREE.HemisphereLight('#d9e5c8', '#38402b', 1.5);
    this.scene.add(this.hemisphere);
    const sun = new THREE.DirectionalLight('#fff0d3', 1.4);
    sun.position.set(-500, 1400, 700);
    this.scene.add(sun);
    this.sun = sun;
    this.distantSun = new THREE.DirectionalLight('#ffffff', 0);
    this.distantSun.shadow.autoUpdate = false;
    this.scene.add(this.distantSun, this.distantSun.target);
    this.camera = new THREE.PerspectiveCamera(48, 1, 1, 18000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .12;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 7000;
    this.controls.minPolarAngle = .015;
    this.controls.maxPolarAngle = Math.PI * .475;
    this.controls.zoomSpeed = .85;
    this.controls.rotateSpeed = .65;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('change', () => this.invalidate());
    this.raycaster = new THREE.Raycaster();
    this.vector = new THREE.Vector3();
    this.overlayGroup = new THREE.Group();
    this.scene.add(this.overlayGroup);
    this.gridGroup = new THREE.Group();
    this.scene.add(this.gridGroup);
    this.drawingGroup = new THREE.Group();
    this.scene.add(this.drawingGroup);
    this.artillery = new ArtilleryScene(this);
    this.artilleryCameraMode = 'orbit';
    this.camera.position.set(0, 500, 700);
    this.props = new PropView(this);
    this.detail = new TerrainDetail(this);
    this.performance = new ScenePerformance(this);
    this.environment = new TerrainEnvironment(this);
    this.controls.update();
    this.bindPointers();
    this.resize();
    this.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.contextLost = true;
      this.ready = false;
      this.props.suspend();
      if (this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; }
      this.callbacks.onContextLost?.();
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      if (!this.contextLost || !this.map || this.contextRestorePromise) return;
      const map = this.map;
      const camera = { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(), target: this.controls.target.clone() };
      this.contextRestorePromise = this.loadMap(map).then(restored => {
        if (!restored || this.map?.id !== map.id) return;
        this.camera.position.copy(camera.position);
        this.camera.quaternion.copy(camera.quaternion);
        this.controls.target.copy(camera.target);
        this.controls.update();
        this.contextLost = false;
        this.callbacks.onContextRestored?.();
        this.invalidate();
      }).catch(error => {
        this.callbacks.onError?.('3D 图形上下文恢复失败：' + error.message);
      }).finally(() => { this.contextRestorePromise = null; });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; }
        this.props.suspend();
      } else if (this.active && !this.contextLost) {
        this.props.wake();
        this.invalidate();
      }
    });
  }

  bindPointers() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', event => {
      if (['sight', 'fly', 'walk'].includes(this.artilleryCameraMode)) return;
      this.container.parentElement.focus({ preventScroll: true });
      this.pointerStarts.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button, moved: false });
      if (this.pointerStarts.size > 1) this.hadMultiplePointers = true;
    });
    canvas.addEventListener('pointermove', event => {
      const start = this.pointerStarts.get(event.pointerId);
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) start.moved = true;
      if (!this.active || !this.ready || this.contextLost || this.pointerStarts.size || ['fly', 'walk', 'sight'].includes(this.artilleryCameraMode)) return;
      this.pendingHover = { clientX: event.clientX, clientY: event.clientY };
      const updateHover = () => {
        this.hoverFrame = null;
        if (!this.pendingHover || !this.active || !this.ready || this.contextLost) return;
        const hover = this.pendingHover;
        this.pendingHover = null;
        const position = this.pick(hover.clientX, hover.clientY);
        this.callbacks.onHover(position, position ? this.heightAt(position) : null);
      };
      if (typeof requestAnimationFrame === 'function') {
        if (this.hoverFrame === null) this.hoverFrame = requestAnimationFrame(updateHover);
      } else updateHover();
    });
    const end = event => {
      const start = this.pointerStarts.get(event.pointerId);
      this.pointerStarts.delete(event.pointerId);
      if (event.type === 'pointerup' && start && start.button === 0 && !start.moved && !this.hadMultiplePointers && this.active && this.ready) {
        if (!event.shiftKey && !this.callbacks.isToolActive() && this.performance.inspect(event.clientX, event.clientY)) return;
        const position = this.pick(event.clientX, event.clientY);
        if (position) this.callbacks.onClick(position, event.shiftKey);
      }
      if (!this.pointerStarts.size) this.hadMultiplePointers = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => { if (!this.pointerStarts.size) { this.pendingHover = null; this.callbacks.onHover(null, null); } });
    canvas.addEventListener('dblclick', event => {
      if (!this.active || !this.ready || this.callbacks.isToolActive()) return;
      const position = this.pick(event.clientX, event.clientY);
      if (position) this.focus(position, this.controls.getDistance() * .7);
    });
  }

  async loadMap(map) {
    const revision = ++this.revision;
    this.ready = false;
    this.renderer.domElement.dataset.terrain = 'loading';
    this.map = map;
    this.clearTerrain();
    this.props.report('loading');
    this.invalidate();
    this.manifestPromise ||= readLocal('assets/terrain/manifest.json', 'json').catch(error => { this.manifestPromise = null; throw error; });
    const manifest = await this.manifestPromise;
    if (revision !== this.revision) return false;
    const descriptor = manifest[map.id];
    if (!descriptor) throw new Error('此地图没有本地高度数据。');
    const [buffer, image, detailImage] = await Promise.all([
      readLocal(descriptor.file, 'buffer'), loadImage(map.image), loadImage(map.detailImage)
    ]);
    if (revision !== this.revision) return false;
    if (buffer.byteLength !== descriptor.cols * descriptor.rows * 2) throw new Error('本地高度文件不完整，请重新生成地形包。');
    this.descriptor = descriptor;
    const view = new DataView(buffer);
    this.heights = new Uint16Array(descriptor.cols * descriptor.rows);
    for (let index = 0; index < this.heights.length; index++) this.heights[index] = view.getUint16(index * 2, true);
    this.metresToWorld = 2048 / (map.bounds[2] / 100);
    this.heightBaseline = descriptor.minimumMetres;
    this.textureSources = [image, detailImage];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(4096, this.renderer.capabilities.maxTextureSize);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法合成离线地图纹理。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const textureScale = canvas.width / 2048;
    context.drawImage(detailImage, map.detail.x * textureScale, map.detail.y * textureScale, 512 * textureScale, 512 * textureScale);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const anisotropy = this.renderProfile === 'high' ? 8 : this.renderProfile === 'low' ? 2 : 4;
    texture.anisotropy = Math.min(anisotropy, this.renderer.capabilities.getMaxAnisotropy());
    this.terrainMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0, shadowSide: THREE.FrontSide });
    this.terrainMaterial.onBeforeCompile = shader => {
      shader.uniforms.atlasBrightness = this.brightnessUniform;
      shader.uniforms.atlasSaturation = this.saturationUniform;
      shader.fragmentShader = 'uniform float atlasBrightness; uniform float atlasSaturation;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\nfloat atlasLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\ndiffuseColor.rgb = mix(vec3(atlasLuma), diffuseColor.rgb, atlasSaturation) * atlasBrightness;');
    };
    applySceneShadows(this.terrainMaterial);
    const geometry = this.createGeometry();
    this.mesh = new THREE.Mesh(geometry, this.terrainMaterial);
    this.terrainDepthMaterial = terrainDepthMaterial();
    this.mesh.customDepthMaterial = this.terrainDepthMaterial;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);
    this.createSkirt();
    this.createGrid();
    this.ready = true;
    const metadata = this.renderer.domElement.dataset;
    metadata.terrain = map.id;
    metadata.vertices = String(geometry.attributes.position.count);
    metadata.heightRange = descriptor.minimumMetres + ':' + descriptor.maximumMetres;
    metadata.heightVersion = descriptor.sourceVersion;
    metadata.heightFactor = String(this.heightFactor);
    this.focus(map.center, 100, true);
    this.setSettings(this.settings);
    this.props.loadMap(map);
    let detailRecord;
    try { detailRecord = await detailHeights.record(map); }
    catch (error) { if (revision === this.revision) this.ready = false; throw error; }
    if (revision !== this.revision) return false;
    this.detailDescriptor = detailRecord.descriptor;
    this.environment.load(map);
    this.invalidate();
    return true;
  }

  heightAt(position) {
    const precise = this.map ? detailHeights.sample(this.map, position) : null;
    if (Number.isFinite(precise)) return precise;
    if (!this.heights || !this.descriptor) return null;
    const descriptor = this.descriptor;
    const rawX = this.map.bounds[0] + position[0] / 2048 * this.map.bounds[2];
    const rawY = this.map.bounds[1] + position[1] / 2048 * this.map.bounds[2];
    const column = clamp((rawX - descriptor.origin[0]) / descriptor.step[0], 0, descriptor.cols - 1);
    const row = clamp((rawY - descriptor.origin[1]) / descriptor.step[1], 0, descriptor.rows - 1);
    const left = Math.floor(column);
    const top = Math.floor(row);
    const right = Math.min(left + 1, descriptor.cols - 1);
    const bottom = Math.min(top + 1, descriptor.rows - 1);
    const horizontal = column - left;
    const vertical = row - top;
    const upper = this.heights[top * descriptor.cols + left] * (1 - horizontal) + this.heights[top * descriptor.cols + right] * horizontal;
    const lower = this.heights[bottom * descriptor.cols + left] * (1 - horizontal) + this.heights[bottom * descriptor.cols + right] * horizontal;
    return (descriptor.heightOffset + ((upper * (1 - vertical) + lower * vertical) - 32768) * descriptor.heightScale) / 100;
  }

  surfacePoint(position, lift = 0) {
    let height = (this.heightAt(position) - this.heightBaseline) * this.metresToWorld * this.heightFactor;
    if (lift && this.mesh && !this.detail?.contains(position)) height = Math.max(height, this.meshHeightAt(position));
    return new THREE.Vector3(position[0] - 1024, height + lift, position[1] - 1024);
  }

  meshHeightAt(position) {
    const rawX = this.map.bounds[0] + position[0] / 2048 * this.map.bounds[2];
    const rawY = this.map.bounds[1] + position[1] / 2048 * this.map.bounds[2];
    const column = clamp((rawX - this.descriptor.origin[0]) / this.descriptor.step[0] / this.meshStride, 0, this.meshColumns - 1);
    const row = clamp((rawY - this.descriptor.origin[1]) / this.descriptor.step[1] / this.meshStride, 0, this.meshRows - 1);
    const left = Math.min(Math.floor(column), this.meshColumns - 2);
    const top = Math.min(Math.floor(row), this.meshRows - 2);
    const horizontal = column - left;
    const vertical = row - top;
    const index = top * this.meshColumns + left;
    const positions = this.mesh.geometry.attributes.position;
    if (horizontal + vertical <= 1) return positions.getY(index) * (1 - horizontal - vertical) + positions.getY(index + 1) * horizontal + positions.getY(index + this.meshColumns) * vertical;
    return positions.getY(index + this.meshColumns + 1) * (horizontal + vertical - 1) + positions.getY(index + 1) * (1 - vertical) + positions.getY(index + this.meshColumns) * (1 - horizontal);
  }

  createGeometry() {
    const stride = Math.max(1, Math.round((matchMedia('(max-width:650px)').matches ? 64 : 32) / this.descriptor.sampleMetres));
    this.meshStride = stride;
    const columns = Math.ceil((this.descriptor.cols - 1) / stride) + 1;
    const rows = Math.ceil((this.descriptor.rows - 1) / stride) + 1;
    const positions = new Float32Array(columns * rows * 3);
    const coordinates = new Float32Array(columns * rows * 2);
    const indices = columns * rows > 65535 ? new Uint32Array((columns - 1) * (rows - 1) * 6) : new Uint16Array((columns - 1) * (rows - 1) * 6);
    let indexOffset = 0;
    this.samples = new Array(columns * rows);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const rawX = this.descriptor.origin[0] + Math.min(column * stride, this.descriptor.cols - 1) * this.descriptor.step[0];
        const rawY = this.descriptor.origin[1] + Math.min(row * stride, this.descriptor.rows - 1) * this.descriptor.step[1];
        const point = [(rawX - this.map.bounds[0]) / this.map.bounds[2] * 2048, (rawY - this.map.bounds[1]) / this.map.bounds[2] * 2048];
        const index = row * columns + column;
        this.samples[index] = point;
        positions[index * 3] = point[0] - 1024; positions[index * 3 + 1] = (this.heightAt(point) - this.heightBaseline) * this.metresToWorld * this.heightFactor; positions[index * 3 + 2] = point[1] - 1024;
        coordinates[index * 2] = point[0] / 2048; coordinates[index * 2 + 1] = 1 - point[1] / 2048;
        if (column < columns - 1 && row < rows - 1) {
          const next = index + columns;
          indices[indexOffset++] = index; indices[indexOffset++] = next; indices[indexOffset++] = index + 1; indices[indexOffset++] = index + 1; indices[indexOffset++] = next; indices[indexOffset++] = next + 1;
        }
      }
    }
    this.meshColumns = columns;
    this.meshRows = rows;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(coordinates, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  createSkirt() {
    if (this.skirt) { this.scene.remove(this.skirt); this.skirt.geometry.dispose(); this.skirt.material.dispose(); }
    const boundary = [];
    for (let column = 0; column < this.meshColumns; column++) boundary.push(column);
    for (let row = 1; row < this.meshRows; row++) boundary.push(row * this.meshColumns + this.meshColumns - 1);
    for (let column = this.meshColumns - 2; column >= 0; column--) boundary.push((this.meshRows - 1) * this.meshColumns + column);
    for (let row = this.meshRows - 2; row > 0; row--) boundary.push(row * this.meshColumns);
    boundary.push(boundary[0]);
    const vertices = [];
    for (let index = 0; index < boundary.length - 1; index++) {
      const first = this.surfacePoint(this.samples[boundary[index]]);
      const second = this.surfacePoint(this.samples[boundary[index + 1]]);
      vertices.push(first.x, first.y, first.z, first.x, -16, first.z, second.x, second.y, second.z, second.x, second.y, second.z, first.x, -16, first.z, second.x, -16, second.z);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.computeVertexNormals();
    this.skirt = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#3e4533', roughness: 1, side: THREE.DoubleSide }));
    this.scene.add(this.skirt);
  }

  clearGroup(group) {
    for (const object of [...group.children]) {
      group.remove(object);
      object.geometry?.dispose();
      object.material?.dispose();
    }
  }

  clearTerrain() {
    this.environment?.clear();
    this.detailDescriptor = null;
    this.performance?.clear();
    this.detail?.clear(true);
    this.textureSources = null;
    this.props.reset();
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.map?.dispose();
      this.mesh.material.dispose();
    }
    if (this.skirt) { this.scene.remove(this.skirt); this.skirt.geometry.dispose(); this.skirt.material.dispose(); }
    this.mesh = null;
    this.terrainDepthMaterial?.dispose();
    this.terrainDepthMaterial = null;
    this.skirt = null;
    this.heights = null;
    this.descriptor = null;
    this.samples = [];
    this.clearGroup(this.overlayGroup);
    this.clearGroup(this.gridGroup);
    this.clearGroup(this.drawingGroup);
    this.artillery.clear();
    this.drawingSignature = '';
  }

  surfaceLine(points, color, opacity = .65, closed = false) {
    const source = closed ? [...points, points[0]] : points;
    const vertices = [];
    for (let index = 0; index < source.length - 1; index++) {
      const first = source[index];
      const second = source[index + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(second[0] - first[0], second[1] - first[1]) / 3));
      for (let sample = 0; sample < steps; sample++) {
        const fraction = sample / steps;
        vertices.push(this.surfacePoint([first[0] + (second[0] - first[0]) * fraction, first[1] + (second[1] - first[1]) * fraction], .6));
      }
    }
    vertices.push(this.surfacePoint(source.at(-1), .6));
    const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  }

  createGrid() {
    this.clearGroup(this.gridGroup);
    for (let index = 0; index <= 16; index++) {
      const offset = index * 128;
      this.gridGroup.add(this.surfaceLine([[offset, 0], [offset, 2048]], '#c5d4ae', .14));
      this.gridGroup.add(this.surfaceLine([[0, offset], [2048, offset]], '#c5d4ae', .14));
    }
  }

  setOverlays(zones, control, color) {
    this.overlaySpec = { zones, control, color };
    if (!this.ready) return;
    this.clearGroup(this.overlayGroup);
    for (const zone of zones) this.overlayGroup.add(this.surfaceLine(zone.polygon, zone.color || color, .48, true));
    if (control) {
      const points = Array.from({ length: 128 }, (_, index) => {
        const angle = index / 128 * Math.PI * 2;
        return [control.position[0] + Math.cos(angle) * control.radius, control.position[1] + Math.sin(angle) * control.radius];
      });
      this.overlayGroup.add(this.surfaceLine(points, color, .9, true));
    }
    this.invalidate();
  }

  setDrawing(points) {
    const signature = JSON.stringify(points);
    if (!this.ready || signature === this.drawingSignature) return;
    this.drawingSignature = signature;
    this.drawingPoints = points;
    this.clearGroup(this.drawingGroup);
    if (points.length > 1) this.drawingGroup.add(this.surfaceLine(points, '#e3f1a0', 1));
    this.invalidate();
  }

  setSettings(settings) {
    this.settings = { ...settings };
    this.gridGroup.visible = Boolean(settings.grid);
    this.brightnessUniform.value = clamp(settings.brightness / 70, .4, 1.65);
    this.saturationUniform.value = settings.view === 'satellite' ? .95 : .72;
    this.props.setSettings({ ...(settings.models || { buildings: true, trees: true, props: true }), loading: settings.modelLoading || 'stream' });
    this.performance.setSettings(settings);
    this.invalidate();
  }

  setHeightFactor(value) {
    const factor = clamp(Number(value), 1, 3);
    if (!Number.isFinite(factor) || !this.ready || this.heightFactor === factor || (factor !== 1 && ['buildings', 'trees', 'props'].some(category => this.props.settings[category]))) return;
    const previousHeight = this.controls.target.y;
    this.heightFactor = factor;
    this.detail.clear();
    const positions = this.mesh.geometry.attributes.position;
    for (let index = 0; index < this.samples.length; index++) positions.setY(index, this.surfacePoint(this.samples[index]).y);
    positions.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingBox();
    this.mesh.geometry.computeBoundingSphere();
    this.createSkirt();
    this.createGrid();
    if (this.overlaySpec) this.setOverlays(this.overlaySpec.zones, this.overlaySpec.control, this.overlaySpec.color);
    const points = this.drawingPoints || [];
    this.drawingSignature = '';
    this.setDrawing(points);
    this.controls.target.y = this.surfacePoint(this.targetPosition()).y;
    this.camera.position.y += this.controls.target.y - previousHeight;
    this.controls.update();
    this.renderer.domElement.dataset.heightFactor = String(factor);
    this.props.wake();
    if (this.artilleryMetadata) this.artillery.update(this.artilleryPoints, this.artilleryMetadata);
    this.invalidate();
  }

  setActive(active) {
    this.active = active;
    this.controls.enabled = active && !this.contextLost && !['sight', 'fly', 'walk'].includes(this.artilleryCameraMode);
    this.pointerStarts.clear();
    this.hadMultiplePointers = false;
    if (active && !document.hidden && !this.contextLost) { this.resize(); this.props.wake(); this.invalidate(); }
    else { this.props.suspend(); if (this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; } }
  }

  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  invalidate() {
    if (!this.active || this.frame !== null || this.contextLost || document.hidden) return;
    this.frame = requestAnimationFrame(timestamp => {
      this.frame = null;
      const frameStart = performance.now();
      const navigationMoving = this.artillery.navigation.update(timestamp);
      const navigationEnd = performance.now();
      this.controls.update();
      if (this.ready) {
        const target = this.targetPosition();
        const ground = this.surfacePoint(target).y;
        const correction = ground - this.controls.target.y;
        if (Math.abs(correction) > .05 && this.artilleryCameraMode === 'orbit') { this.controls.target.y = ground; this.camera.position.y += correction; this.controls.update(); }
        const cameraMapPosition = [this.camera.position.x + 1024, this.camera.position.z + 1024];
        if (cameraMapPosition.every(coordinate => coordinate >= 0 && coordinate <= 2048)) {
          const minimum = this.surfacePoint(cameraMapPosition).y + (this.artilleryCameraMode === 'orbit' ? .8 : .2 * this.metresToWorld);
          if (this.camera.position.y < minimum) { this.camera.position.y = minimum; this.controls.update(); }
        }
      }
      this.environment.update();
      this.performance.update(timestamp);
      const collisionEnd = performance.now();
      if (['fly', 'walk'].includes(this.artilleryCameraMode)) this.artillery.navigation.syncTarget();
      this.camera.updateMatrixWorld();
      this.detail.update(false, performance.now() + 2);
      const detailEnd = performance.now();
      this.props.update(performance.now() + 3);
      const propsEnd = performance.now();
      const programsBefore = this.renderer.info.programs.length;
      const geometriesBefore = this.renderer.info.memory.geometries;
      this.renderer.render(this.scene, this.camera);
      const renderEnd = performance.now();
      const metadata = this.renderer.domElement.dataset;
      metadata.drawCalls = String(this.renderer.info.render.calls);
      metadata.triangles = String(this.renderer.info.render.triangles);
      metadata.shaderPrograms = String(this.renderer.info.programs.length);
      const navigationActive = ['fly', 'walk'].includes(this.artilleryCameraMode);
      if (!navigationActive || timestamp - (this.lastOverlayUpdate || 0) >= 100 || this.navigationWasMoving && !navigationMoving) {
        this.lastOverlayUpdate = timestamp; this.callbacks.onChange();
      }
      this.navigationWasMoving = navigationMoving;
      this.performance.recordFrame({ navigation: navigationEnd - frameStart, cameraAndCollision: collisionEnd - navigationEnd, terrainDetail: detailEnd - collisionEnd, models: propsEnd - detailEnd, renderSubmission: renderEnd - propsEnd, total: performance.now() - frameStart }, navigationMoving, { programs: this.renderer.info.programs.length, newPrograms: this.renderer.info.programs.length - programsBefore, newGeometries: this.renderer.info.memory.geometries - geometriesBefore, textureUploads: this.props.textureUploads.length, shaderWarmups: this.props.shaderWarmup.pending });
      if (navigationMoving) this.invalidate();
    });
  }

  setArtillery(points, metadata = null) {
    this.artilleryPoints = points;
    this.artilleryMetadata = metadata;
    if (this.ready) this.artillery.update(points, metadata);
  }

  setArtilleryView(mode) {
    if (this.ready) this.artillery.setCamera(mode);
  }

  fitArtillery(points, trajectory) {
    if (this.ready) this.artillery.fit(points, trajectory);
  }

  targetPosition() {
    return [clamp(this.controls.target.x + 1024, 0, 2048), clamp(this.controls.target.z + 1024, 0, 2048)];
  }

  focus(position, distance = this.controls.getDistance(), resetHeading = false) {
    if (!this.ready) return;
    const direction = resetHeading ? new THREE.Vector3(0, .72, .7).normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(this.surfacePoint(position));
    this.camera.position.copy(this.controls.target).addScaledVector(direction, clamp(distance, this.controls.minDistance, this.controls.maxDistance));
    if (resetHeading) this.performance.previousCamera.copy(this.camera.position);
    this.controls.update();
    this.invalidate();
  }

  overview() {
    const distance = 1500 / Math.tan(this.camera.fov / 2 * Math.PI / 180) / Math.min(1, this.camera.aspect);
    this.focus([1024, 1024], distance, true);
  }

  topView() {
    const distance = this.controls.getDistance();
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(0, distance, distance * .025));
    this.controls.update();
    this.invalidate();
  }

  zoom(factor) {
    this.focus(this.targetPosition(), this.controls.getDistance() / factor);
  }

  pan(horizontal, vertical) {
    if (!this.ready) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const forward = new THREE.Vector3(-offset.x, 0, -offset.z).normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const step = this.controls.getDistance() * .08;
    const next = this.controls.target.clone().addScaledVector(right, horizontal * step).addScaledVector(forward, vertical * step);
    this.focus([clamp(next.x + 1024, 0, 2048), clamp(next.z + 1024, 0, 2048)]);
  }

  metrics() {
    const distance = this.controls.getDistance();
    const direction = this.camera.position.clone().sub(this.controls.target);
    return { target: this.targetPosition(), distance, zoom: 420 / distance * 100, scale: this.container.clientHeight / (2 * distance * Math.tan(this.camera.fov / 2 * Math.PI / 180)), heading: Math.atan2(direction.x, direction.z) * 180 / Math.PI };
  }

  project(position) {
    if (!this.ready) return hiddenPosition;
    const surface = this.surfacePoint(position, 1);
    const projected = surface.clone().project(this.camera);
    if (projected.z < -1 || projected.z > 1) return hiddenPosition;
    const distance = Math.hypot(surface.x - this.camera.position.x, surface.z - this.camera.position.z);
    const steps = clamp(Math.ceil(distance / 12), 8, 120);
    for (let sample = 1; sample < steps - 1; sample++) {
      const fraction = sample / steps;
      const horizontal = this.camera.position.x + (surface.x - this.camera.position.x) * fraction;
      const depth = this.camera.position.z + (surface.z - this.camera.position.z) * fraction;
      if (horizontal < -1024 || horizontal > 1024 || depth < -1024 || depth > 1024) continue;
      const height = this.camera.position.y + (surface.y - this.camera.position.y) * fraction;
      if (height < this.surfacePoint([horizontal + 1024, depth + 1024]).y - 1) return hiddenPosition;
    }
    return [(projected.x + 1) / 2 * this.container.clientWidth, (1 - projected.y) / 2 * this.container.clientHeight];
  }

  pick(clientX, clientY) {
    if (!this.ready) return null;
    const rectangle = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2((clientX - rectangle.left) / rectangle.width * 2 - 1, 1 - (clientY - rectangle.top) / rectangle.height * 2), this.camera);
    const surfaces = this.detail.patch ? [this.detail.patch, this.mesh] : [this.mesh];
    let hit = this.raycaster.intersectObjects(surfaces, false)[0];
    this.lastPickHeight = null;
    if (this.callbacks.isArtilleryActive?.()) {
      const modelHit = this.props.pick(this.raycaster);
      if (modelHit && (!hit || modelHit.distance < hit.distance)) { hit = modelHit; this.lastPickHeight = hit.point.y / (this.metresToWorld * this.heightFactor) + this.heightBaseline; }
    }
    if (!hit) return null;
    return [clamp(hit.point.x + 1024, 0, 2048), clamp(hit.point.z + 1024, 0, 2048)];
  }
}
