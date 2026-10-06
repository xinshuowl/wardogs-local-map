import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/three/meshopt_decoder.module.js';
import { ArtilleryNavigation } from './artillery-navigation.js';
import { applySceneShadows } from './scene-shadows.js';

export class ArtilleryScene {
  constructor(terrain) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.weaponGroup = new THREE.Group();
    this.group.add(this.markerGroup, this.weaponGroup);
    terrain.scene.add(this.group);
    this.loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    this.models = new Map();
    this.materials = new Map();
    this.pitchNodes = [];
    this.cameraMode = 'orbit';
    this.navigation = new ArtilleryNavigation(terrain);
    this.revision = 0;
  }

  clearMarkers() {
    for (const object of [...this.markerGroup.children]) {
      object.removeFromParent();
      object.traverse(child => { child.geometry?.dispose(); if (Array.isArray(child.material)) child.material.forEach(material => material.dispose()); else child.material?.dispose(); });
    }
  }

  clear() {
    this.revision++;
    this.clearMarkers();
    this.weaponGroup.clear();
    this.metadata = null;
    this.currentWeapon = null;
    this.terrain.shadowRevision = (this.terrain.shadowRevision || 0) + 1;
    this.setCamera('orbit');
    const dataset = this.terrain.renderer.domElement.dataset;
    delete dataset.artilleryWeapon;
    delete dataset.artilleryModel;
    this.terrain.invalidate();
  }

  worldPoint(position, height) {
    const terrain = this.terrain;
    return new THREE.Vector3(position[0] - 1024, (height - terrain.heightBaseline) * terrain.metresToWorld * terrain.heightFactor, position[1] - 1024);
  }

  addMarker(position, height, color, kind) {
    if (!position || !Number.isFinite(height)) return;
    const factor = this.terrain.metresToWorld;
    const point = this.worldPoint(position, height);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.06 * factor, .06 * factor, 5 * factor, 6), new THREE.MeshBasicMaterial({ color, depthWrite: false }));
    pole.position.copy(point).y += 2.5 * factor;
    pole.userData.artilleryMarker = kind;
    this.markerGroup.add(pole);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(.65 * factor, 12, 8), new THREE.MeshBasicMaterial({ color }));
    marker.position.copy(point).y += 5 * factor;
    marker.userData.artilleryMarker = kind;
    this.markerGroup.add(marker);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6 * factor, 1.8 * factor, 36), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(point).y += .08 * factor;
    ring.userData.artilleryMarker = kind;
    this.markerGroup.add(ring);
  }

  update(points, metadata) {
    if (!metadata) { this.clear(); return; }
    this.metadata = metadata;
    this.clearMarkers();
    this.addMarker(metadata.gun, metadata.originHeight, '#edc079', 'gun');
    this.addMarker(metadata.target, metadata.targetHeight, '#ef708d', 'target');
    if (metadata.radii) {
      for (const radius of [metadata.radii.min, metadata.radii.max]) this.addRadius(metadata.gun, radius, '#edc079', .4);
      this.addRadius(metadata.target, metadata.radii.blast, '#ef708d', .7);
      this.addRadius(metadata.target, metadata.radii.effective, '#edc079', .8);
    }
    if (metadata.obstruction?.point) this.addMarker(metadata.obstruction.point, metadata.obstruction.point[2], '#ff5349', 'blocked');
    if (points?.length) {
      const vertices = points.map(point => this.worldPoint(point, point[2]));
      this.markerGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(vertices), new THREE.LineBasicMaterial({ color: metadata.blocked ? '#ef708d' : '#edc079', depthTest: true })));
    }
    if (metadata.gun && Number.isFinite(metadata.originHeight)) {
      this.weaponGroup.position.copy(this.worldPoint(metadata.gun, metadata.originHeight));
      this.weaponGroup.scale.setScalar(this.terrain.metresToWorld);
      if (metadata.target) this.weaponGroup.rotation.y = Math.atan2(metadata.target[0] - metadata.gun[0], metadata.target[1] - metadata.gun[1]) + (metadata.weapon === 'l52-cannon' ? -Math.PI / 2 : 0);
      this.updatePitch();
      this.terrain.renderer.domElement.dataset.artilleryWeapon = metadata.weapon;
      if (this.currentWeapon !== metadata.weapon) this.loadWeapon(metadata.weapon);
    } else {
      this.weaponGroup.clear(); this.currentWeapon = null;
      delete this.terrain.renderer.domElement.dataset.artilleryModel;
    }
    if (['gun', 'target', 'sight'].includes(this.cameraMode)) this.setCamera(this.cameraMode);
    this.terrain.invalidate();
  }

  addRadius(center, radius, color, opacity) {
    if (!center || !Number.isFinite(radius) || radius <= 0) return;
    const vertices = [];
    for (let index = 0; index <= 192; index++) {
      const angle = index / 192 * Math.PI * 2;
      const position = [center[0] + Math.cos(angle) * radius * this.terrain.metresToWorld, center[1] + Math.sin(angle) * radius * this.terrain.metresToWorld];
      const point = this.terrain.surfacePoint(position); point.y += .45 * this.terrain.metresToWorld;
      vertices.push(point);
    }
    this.markerGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(vertices), new THREE.LineBasicMaterial({ color, opacity, transparent: true, depthWrite: false })));
  }

  updatePitch() {
    const elevation = (this.metadata?.corrected?.rawMils ?? this.metadata?.selected?.rawMils ?? 0) / 1000;
    for (const node of this.pitchNodes) node.object.rotation[node.axis] = elevation * node.sign;
    this.terrain.renderer.domElement.dataset.artilleryPitch = elevation.toFixed(4);
    this.terrain.shadowRevision = (this.terrain.shadowRevision || 0) + 1;
  }

  async loadManifest() {
    this.manifestPromise ||= fetch('./assets/artillery/manifest.json').then(response => { if (!response.ok) throw new Error('炮兵模型清单缺失'); return response.json(); }).catch(error => { this.manifestPromise = null; throw error; });
    return this.manifestPromise;
  }

  async model(filename, manifest) {
    if (!this.models.has(filename)) {
      const promise = this.loader.loadAsync('./assets/artillery/' + filename).then(gltf => {
        gltf.scene.traverse(object => {
          if (!object.isMesh) return;
          const resolveMaterial = previous => {
            const name = previous?.name || '';
            if (!this.materials.has(name)) {
              const definition = manifest.materials[name];
              const material = new THREE.MeshStandardMaterial({ color: definition?.color || '#889078', roughness: definition?.roughness ?? .9, metalness: definition?.metalness ?? 0 });
              applySceneShadows(material);
              material.name = name;
              this.materials.set(name, material);
            }
            previous?.dispose();
            return this.materials.get(name);
          };
          object.material = Array.isArray(object.material) ? object.material.map(resolveMaterial) : resolveMaterial(object.material);
          object.castShadow = true;
          object.receiveShadow = true;
          object.frustumCulled = true;
        });
        return gltf.scene;
      });
      this.models.set(filename, promise);
    }
    try { return await this.models.get(filename); }
    catch (error) { this.models.delete(filename); throw error; }
  }

  async loadWeapon(identifier) {
    const revision = ++this.revision;
    this.currentWeapon = identifier;
    this.weaponGroup.clear();
    this.pitchNodes = [];
    this.terrain.renderer.domElement.dataset.artilleryModel = 'loading';
    try {
      const manifest = await this.loadManifest();
      const parts = manifest.weapons[identifier];
      if (!parts?.length) throw new Error('此武器没有模型组件');
      const loaded = await Promise.all(parts.map(part => this.model(part.url, manifest)));
      if (revision !== this.revision || this.currentWeapon !== identifier) return;
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const object = loaded[index].clone(true);
        object.position.fromArray(part.p || [0, 0, 0]);
        object.quaternion.fromArray(part.q || [0, 0, 0, 1]);
        object.scale.fromArray(part.s || [1, 1, 1]);
        if (part.pivot) {
          const pivot = new THREE.Group();
          pivot.position.fromArray(part.pivot);
          object.position.sub(pivot.position);
          pivot.add(object); this.weaponGroup.add(pivot);
          this.pitchNodes.push({ object: pivot, axis: 'z', sign: 1 });
        } else {
          this.weaponGroup.add(object);
          if (part.url === 'SM_Mortar_Barrel.glb') this.pitchNodes.push({ object, axis: 'x', sign: -1 });
        }
      }
      this.updatePitch();
      this.terrain.renderer.domElement.dataset.artilleryModel = 'ready';
      this.terrain.invalidate();
    } catch (error) {
      if (revision !== this.revision) return;
      this.currentWeapon = null;
      this.terrain.renderer.domElement.dataset.artilleryModel = 'error';
      this.terrain.callbacks.onArtilleryError?.('炮兵模型加载失败：' + error.message + '。计算工具仍可用。');
    }
  }

  setCamera(mode) {
    const terrain = this.terrain;
    if (this.markerGroup) {
      this.markerGroup.visible = mode !== 'sight';
      for (const object of this.markerGroup.children) object.visible = !(mode === 'gun' && object.userData.artilleryMarker === 'gun' || mode === 'target' && object.userData.artilleryMarker === 'target');
    }
    if (mode === 'orbit') {
      this.navigation.stop();
      if (this.savedCamera) {
        terrain.camera.position.copy(this.savedCamera.position);
        terrain.controls.target.copy(this.savedCamera.target);
        terrain.camera.fov = this.savedCamera.fov;
        terrain.camera.near = this.savedCamera.near;
        terrain.controls.minDistance = this.savedCamera.minDistance;
        terrain.controls.maxPolarAngle = this.savedCamera.maxPolarAngle;
        terrain.camera.updateProjectionMatrix();
        this.savedCamera = null;
      }
      this.cameraMode = 'orbit';
      terrain.artilleryCameraMode = 'orbit';
      terrain.renderer.domElement.dataset.artilleryView = 'orbit';
      terrain.controls.enabled = terrain.active;
      terrain.controls.enableDamping = true;
      terrain.controls.update();
      terrain.invalidate();
      return;
    }
    const metadata = this.metadata;
    if ((!metadata?.gun || !metadata.target || ![metadata.originHeight, metadata.targetHeight].every(Number.isFinite)) && !['fly', 'walk'].includes(mode)) return;
    if (!this.savedCamera) this.savedCamera = { position: terrain.camera.position.clone(), target: terrain.controls.target.clone(), fov: terrain.camera.fov, near: terrain.camera.near, minDistance: terrain.controls.minDistance, maxPolarAngle: terrain.controls.maxPolarAngle };
    this.cameraMode = mode;
    terrain.artilleryCameraMode = mode;
    terrain.renderer.domElement.dataset.artilleryView = mode;
    const gun = metadata?.gun && Number.isFinite(metadata.originHeight) ? this.worldPoint(metadata.gun, metadata.originHeight) : terrain.surfacePoint(terrain.targetPosition());
    const target = metadata?.target && Number.isFinite(metadata.targetHeight) ? this.worldPoint(metadata.target, metadata.targetHeight) : terrain.controls.target.clone();
    const factor = terrain.metresToWorld;
    const direction = target.clone().sub(gun);
    direction.y = 0;
    if (direction.lengthSq() < .001) direction.set(1, 0, 0);
    direction.normalize();
    this.navigation.stop();
    terrain.controls.enableDamping = false;
    terrain.controls.minDistance = .4 * factor;
    terrain.controls.maxPolarAngle = Math.PI * .995;
    terrain.controls.update();
    terrain.camera.near = Math.max(.01, .15 * factor);
    terrain.camera.fov = mode === 'sight' ? 30 : 48;
    terrain.camera.updateProjectionMatrix();
    if (['fly', 'walk'].includes(mode)) {
      terrain.controls.enabled = false;
      if (mode === 'walk') {
        const walkDirection = terrain.camera.getWorldDirection(new THREE.Vector3()); walkDirection.y = 0;
        if (walkDirection.lengthSq() < .001) walkDirection.copy(direction);
        terrain.camera.lookAt(terrain.camera.position.clone().add(walkDirection.normalize()));
      }
      this.navigation.start(mode);
      this.navigation.syncTarget();
    } else if (mode === 'sight') {
      const eye = gun.clone().addScaledVector(direction, -2.5 * factor);
      eye.y += 2.2 * factor;
      const look = target.clone(); look.y += factor;
      const aimDirection = look.sub(eye).normalize();
      terrain.controls.target.copy(eye).addScaledVector(aimDirection, 12 * factor);
      terrain.camera.position.copy(eye);
      terrain.controls.enabled = false;
    } else {
      const center = mode === 'target' ? target : gun;
      terrain.controls.target.copy(center).y += 1.2 * factor;
      terrain.camera.position.copy(center).addScaledVector(direction, mode === 'target' ? 9 * factor : -9 * factor);
      terrain.camera.position.y += 4.5 * factor;
      terrain.controls.enabled = terrain.active;
    }
    terrain.camera.lookAt(terrain.controls.target);
    terrain.performance.previousCamera.copy(terrain.camera.position);
    terrain.controls.update();
    terrain.invalidate();
  }

  fit(points, trajectory) {
    if (!points.length || !this.terrain.ready) return;
    this.setCamera('orbit');
    const terrain = this.terrain;
    const vertices = trajectory?.length ? trajectory.map(point => this.worldPoint(point, point[2])) : points.map(point => terrain.surfacePoint(point));
    const box = new THREE.Box3().setFromPoints(vertices);
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(5, box.getSize(new THREE.Vector3()).length() / 2);
    const halfFov = terrain.camera.fov * Math.PI / 360;
    const distance = Math.max(12, radius / Math.sin(halfFov) / Math.min(1, terrain.camera.aspect) * 1.25);
    terrain.controls.target.copy(center);
    const offset = new THREE.Vector3(0, .8, .6).normalize().multiplyScalar(Math.min(7000, distance));
    terrain.camera.position.copy(center).add(offset);
    terrain.artilleryCameraMode = 'fit';
    terrain.controls.update();
    terrain.performance.previousCamera.copy(terrain.camera.position);
    terrain.invalidate();
  }
}
