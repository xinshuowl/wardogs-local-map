import * as THREE from './vendor/three/three.module.js';
import { MapCollision, mapWorldPoint, instanceHit } from './map-collision.js';

const movementCodes = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight']);

export class ArtilleryNavigation {
  constructor(terrain) {
    this.terrain = terrain;
    this.keys = new Set();
    this.queuedKeys = new Set();
    this.mode = null;
    this.lastTime = 0;
    this.collision = new MapCollision();
    this.raycaster = new THREE.Raycaster();
    this.velocity = 0;
    this.grounded = true;
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.hud = document.getElementById('artillery-navigation');
    const canvas = terrain.renderer.domElement;
    canvas.addEventListener('pointerdown', event => {
      if (!this.mode || event.button !== 0 || event.target.closest('button')) return;
      terrain.container.parentElement.focus({ preventScroll: true });
      if (event.pointerType === 'mouse' && document.pointerLockElement !== canvas) {
        const request = canvas.requestPointerLock?.();
        request?.catch?.(() => { this.hud.querySelector('.navigation-hint').textContent = '拖动场景环视；WASD 移动，Shift 加速，Esc 返回环绕。'; });
      }
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointermove', event => {
      if (!this.mode || document.pointerLockElement === canvas || !this.drag || this.drag.id !== event.pointerId) return;
      this.look(event.clientX - this.drag.x, event.clientY - this.drag.y);
      this.drag.x = event.clientX; this.drag.y = event.clientY;
    });
    const stopDrag = () => { this.drag = null; };
    canvas.addEventListener('pointerup', stopDrag);
    canvas.addEventListener('pointercancel', stopDrag);
    document.addEventListener('mousemove', event => { if (this.mode && document.pointerLockElement === canvas) this.look(event.movementX, event.movementY); });
    document.addEventListener('keydown', event => {
      if (!this.mode || event.target.closest('input,textarea,select') || document.querySelector('dialog[open]') || !movementCodes.has(event.code)) return;
      event.preventDefault();
      this.keys.add(event.code); this.queuedKeys.add(event.code); terrain.invalidate();
    });
    document.addEventListener('keyup', event => { this.keys.delete(event.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.queuedKeys.clear(); this.drag = null; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.keys.clear(); this.queuedKeys.clear(); } });
    for (const button of this.hud?.querySelectorAll('[data-navigation-key]') || []) {
      button.addEventListener('pointerdown', event => { if (!this.mode) return; event.preventDefault(); button.setPointerCapture(event.pointerId); this.keys.add(button.dataset.navigationKey); this.queuedKeys.add(button.dataset.navigationKey); terrain.invalidate(); });
      for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(eventName, () => this.keys.delete(button.dataset.navigationKey));
    }
  }

  start(mode) {
    this.mode = mode;
    this.keys.clear(); this.queuedKeys.clear(); this.drag = null; this.lastTime = 0;
    this.euler.setFromQuaternion(this.terrain.camera.quaternion, 'YXZ');
    this.velocity = 0; this.grounded = true; this.jumpHeld = false; this.collisionRecord = null; this.warmKey = null; this.warmRequest = null; this.warmRetry = null;
    if (mode === 'walk') {
      const camera = this.terrain.camera; const factor = this.terrain.metresToWorld;
      this.feet = this.supportHeight(camera.position.x, camera.position.z, camera.position.y - 1.7 * factor);
      camera.position.y = this.feet + 1.7 * factor; this.syncTarget();
    }
    if (this.hud) {
      this.hud.hidden = false;
      this.hud.dataset.mode = mode;
      const jump = this.hud.querySelector('[data-navigation-key="Space"]');
      jump?.classList.toggle('navigation-altitude', mode !== 'walk');
      jump?.setAttribute('aria-label', mode === 'walk' ? '步行跳跃' : '飞行上升');
      if (jump) jump.textContent = mode === 'walk' ? '↟' : '＋';
      this.hud.querySelector('.navigation-hint').textContent = mode === 'walk' ? '步行 Walk · WASD 移动，Space 跳跃，Shift 加速；支持台阶、重力与屋顶表面。Esc 返回环绕。' : '飞行 Fly · 点击场景环视，WASD 移动，Space 上升，Ctrl 下降，Shift 加速，Esc 返回。';
    }
    this.terrain.invalidate();
  }

  stop() {
    this.mode = null;
    this.warmRequest = null; this.warmRetry = null;
    this.keys.clear(); this.queuedKeys.clear(); this.drag = null; this.lastTime = 0;
    if (this.hud) this.hud.hidden = true;
    if (document.pointerLockElement === this.terrain.renderer.domElement) document.exitPointerLock?.();
  }

  look(horizontal, vertical) {
    this.euler.y -= horizontal * .0025;
    this.euler.x = Math.max(-Math.PI * .49, Math.min(Math.PI * .49, this.euler.x - vertical * .0025));
    this.terrain.camera.quaternion.setFromEuler(this.euler);
    this.syncTarget();
    this.terrain.invalidate();
  }

  syncTarget() {
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.terrain.camera.quaternion);
    this.terrain.controls.target.copy(this.terrain.camera.position).addScaledVector(direction, 12 * this.terrain.metresToWorld);
  }

  supportHeight(horizontal, vertical, feet) {
    const terrain = this.terrain; const factor = terrain.metresToWorld;
    const ground = terrain.surfacePoint([horizontal + 1024, vertical + 1024]).y;
    if (!terrain.settings.collision || !(terrain.props.colliders?.length || terrain.props.colliderCoverage?.size)) return ground;
    this.raycaster.set(new THREE.Vector3(horizontal, feet + .65 * factor, vertical), new THREE.Vector3(0, -1, 0));
    this.raycaster.near = 0; this.raycaster.far = Math.max(2 * factor, feet - ground + factor);
    const hits = terrain.props.intersectColliders ? terrain.props.intersectColliders(this.raycaster) : this.raycaster.intersectObjects(terrain.props.colliders, false);
    const hit = hits.find(hit => {
      const normal = hit.face?.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
      return normal && normal.y > .35 && hit.point.y >= ground - .1 * factor;
    });
    return hit ? Math.max(ground, hit.point.y) : ground;
  }

  walkingBounds(instance) {
    this.walkingInstances ||= new WeakMap();
    if (!this.walkingInstances.has(instance)) {
      const expanded = { ...instance, bounds: instance.bounds.map((value, axis) => value + (axis < 3 ? -.25 : .25) / Math.max(.01, Math.abs(instance.scale[axis % 3]))) };
      const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...instance.position), new THREE.Quaternion(...instance.quaternion), new THREE.Vector3(...instance.scale));
      const box = new THREE.Box3(new THREE.Vector3(...expanded.bounds.slice(0, 3)), new THREE.Vector3(...expanded.bounds.slice(3))).applyMatrix4(matrix).expandByScalar(.001);
      this.walkingInstances.set(instance, { expanded, bounds: [...box.min.toArray(), ...box.max.toArray()] });
    }
    return this.walkingInstances.get(instance);
  }

  blocked(start, end) {
    if (!this.terrain.settings.collision || !this.collisionRecord) return false;
    const terrain = this.terrain;
    const first = mapWorldPoint(terrain.map, [start.x + 1024, start.z + 1024], start.y / terrain.metresToWorld + terrain.heightBaseline);
    const second = mapWorldPoint(terrain.map, [end.x + 1024, end.z + 1024], end.y / terrain.metresToWorld + terrain.heightBaseline);
    const lower = [Math.min(first[0], second[0]), Math.min(first[1], second[1]) + .9, Math.min(first[2], second[2])];
    const upper = [Math.max(first[0], second[0]), Math.max(first[1], second[1]) + 1.6, Math.max(first[2], second[2])];
    const instances = this.collision.nearby(this.collisionRecord, first, 4);
    if (terrain.renderer?.domElement) { terrain.renderer.domElement.dataset.walkObbCandidates = String(this.collisionRecord.spatial?.lastCandidates || 0); terrain.renderer.domElement.dataset.walkObbInstances = String(this.collisionRecord.spatial?.instances.size || 0); }
    for (const instance of instances) {
      const prepared = this.walkingBounds(instance);
      if (lower.some((value, axis) => value > prepared.bounds[axis + 3] || upper[axis] < prepared.bounds[axis])) continue;
      for (const height of [.9, 1.6]) {
        const source = [first[0], first[1] + height, first[2]]; const target = [second[0], second[1] + height, second[2]];
        if (instanceHit(source, target, prepared.expanded) !== null) return true;
      }
    }
    return false;
  }

  moveWalk(movement, elapsed, jumping) {
    const terrain = this.terrain; const camera = terrain.camera; const factor = terrain.metresToWorld;
    const world = mapWorldPoint(terrain.map, [camera.position.x + 1024, camera.position.z + 1024], this.feet / factor + terrain.heightBaseline);
    const warmKey = terrain.map.id + ':' + Math.floor(world[0] / 64) + ':' + Math.floor(world[2] / 64);
    if (warmKey !== this.warmKey && terrain.settings.collision && (this.warmRetry?.key !== warmKey || performance.now() >= this.warmRetry.at)) {
      this.warmKey = warmKey; const map = terrain.map;
      const revision = terrain.revision; const request = this.warmRequest = {};
      const current = () => this.mode === 'walk' && terrain.revision === revision && terrain.map.id === map.id && this.warmRequest === request && this.warmKey === warmKey;
      this.collision.warm(map, world).then(record => {
        if (!current()) return;
        this.collisionRecord = record; this.warmRetry = null;
        delete terrain.renderer.domElement.dataset.walkCollision;
        terrain.invalidate();
      }).catch(() => {
        if (!current()) return;
        this.warmKey = null; this.warmRetry = { key: warmKey, at: performance.now() + 1000 };
        terrain.renderer.domElement.dataset.walkCollision = 'unavailable';
      });
    }
    for (const axis of ['x', 'z']) {
      if (!movement[axis]) continue;
      const start = new THREE.Vector3(camera.position.x, this.feet, camera.position.z); const end = start.clone(); end[axis] = Math.max(-1024, Math.min(1024, end[axis] + movement[axis]));
      const support = this.supportHeight(end.x, end.z, this.feet);
      if (this.grounded && support - this.feet > .65 * factor) continue;
      if (this.blocked(start, end)) continue;
      camera.position[axis] = end[axis];
      if (this.grounded && support >= this.feet - .65 * factor) this.feet = support;
    }
    if (jumping && !this.jumpHeld && this.grounded) { this.velocity = 5.4 * factor; this.grounded = false; }
    this.jumpHeld = jumping;
    this.velocity -= 18 * factor * elapsed;
    const next = this.feet + this.velocity * elapsed;
    const support = this.supportHeight(camera.position.x, camera.position.z, Math.max(this.feet, next));
    if (this.velocity <= 0 && next <= support) { this.feet = support; this.velocity = 0; this.grounded = true; }
    else { this.feet = next; this.grounded = false; }
    camera.position.y = this.feet + 1.7 * factor; this.syncTarget();
    terrain.renderer.domElement.dataset.walkGrounded = String(this.grounded);
    terrain.renderer.domElement.dataset.walkFeet = (this.feet / factor + terrain.heightBaseline).toFixed(2);
    return movement.lengthSq() > 0 || !this.grounded || this.keys.size > 0;
  }

  update(timestamp) {
    if (!this.mode || !this.terrain.ready) return false;
    const elapsed = this.lastTime ? Math.min(.05, Math.max(0, (timestamp - this.lastTime) / 1000)) : 1 / 60;
    this.lastTime = timestamp;
    const benchmark = this.terrain.performance?.benchmark;
    const testKeys = benchmark?.forward && benchmark.mode === this.mode && timestamp < benchmark.until ? ['KeyW'] : [];
    const frameKeys = new Set([...this.keys, ...this.queuedKeys || [], ...testKeys]);
    this.queuedKeys?.clear();
    if (!frameKeys.size && this.mode !== 'walk') return false;
    const camera = this.terrain.camera;
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    if (this.mode === 'walk') { direction.y = 0; direction.normalize(); }
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion); right.y = 0; right.normalize();
    const movement = new THREE.Vector3();
    const held = (...codes) => codes.some(code => frameKeys.has(code));
    if (held('KeyW', 'ArrowUp')) movement.add(direction);
    if (held('KeyS', 'ArrowDown')) movement.sub(direction);
    if (held('KeyD', 'ArrowRight')) movement.add(right);
    if (held('KeyA', 'ArrowLeft')) movement.sub(right);
    if (this.mode === 'fly') {
      if (held('Space')) movement.y += 1;
      if (held('ControlLeft', 'ControlRight')) movement.y -= 1;
    }
    if (!movement.lengthSq() && this.mode !== 'walk') return false;
    const speed = (this.mode === 'walk' ? 6 : 15) * (held('ShiftLeft', 'ShiftRight') ? 3 : 1) * this.terrain.metresToWorld;
    if (this.mode === 'walk') return this.moveWalk(movement.lengthSq() ? movement.normalize().multiplyScalar(speed * elapsed) : movement, elapsed, held('Space'));
    camera.position.addScaledVector(movement.normalize(), speed * elapsed);
    camera.position.x = Math.max(-1024, Math.min(1024, camera.position.x));
    camera.position.z = Math.max(-1024, Math.min(1024, camera.position.z));
    const ground = this.terrain.surfacePoint([camera.position.x + 1024, camera.position.z + 1024]).y;
    camera.position.y = this.mode === 'walk' ? ground + 1.7 * this.terrain.metresToWorld : Math.max(ground + 1.7 * this.terrain.metresToWorld, camera.position.y);
    this.syncTarget();
    return true;
  }
}
