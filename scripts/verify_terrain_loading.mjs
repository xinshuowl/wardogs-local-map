import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.js';
import { TerrainView } from '../terrain-view.js';
import { TerrainDetail } from '../terrain-detail.js';
import { DetailHeightStore, detailHeights } from '../terrain-height-detail.js';
import { TerrainEnvironment } from '../terrain-environment.js';
import { ScenePerformance } from '../scene-performance.js';
import { ArtilleryNavigation } from '../artillery-navigation.js';
import { PropView } from '../prop-view.js';

const originalGlobals = new Map(['fetch', 'Image', 'document', 'window', 'matchMedia', 'performance'].map(name => [name, globalThis[name]]));
const originalRecord = detailHeights.record;
const originalEnsure = detailHeights.ensure;
const originalLoadTexture = THREE.TextureLoader.prototype.loadAsync;
let passed = 0;

function deferred() {
  let resolve; let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const mapFor = id => ({ id, bounds: [0, 0, 102400], center: [1024, 1024], detail: { x: 512, y: 512, size: 512 }, image: id + '.webp', detailImage: id + '-detail.webp' });
const descriptorFor = id => ({ file: id + '.bin', cols: 129, rows: 129, sampleMetres: 8, origin: [0, 0], step: [800, 800], minimumMetres: 0, maximumMetres: 0, heightOffset: 0, heightScale: 100 });
const flatBuffer = () => new Uint16Array(129 * 129).fill(32768).buffer;

function terrainFor(map = mapFor('terrain-test')) {
  const terrain = Object.create(TerrainView.prototype);
  Object.assign(terrain, {
    map, revision: 0, ready: true, heightFactor: 1, heightBaseline: 0, metresToWorld: 2, renderProfile: 'low', settings: {},
    descriptor: descriptorFor(map.id), heights: new Uint16Array(129 * 129).fill(32768),
    scene: new THREE.Scene(), overlayGroup: new THREE.Group(), gridGroup: new THREE.Group(), drawingGroup: new THREE.Group(),
    camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3(), getDistance: () => 20, update() {} },
    renderer: { domElement: { dataset: {} }, shadowMap: {}, capabilities: { maxTextureSize: 16, getMaxAnisotropy: () => 1 } },
    props: { settings: { buildings: false, trees: false, props: false, loading: 'stream' }, report() {}, reset() {}, loadMap() {}, wake() {} },
    performance: { clear() {} }, artillery: { clear() {}, update() {} }, callbacks: {},
    environment: { loaded: [], clear() {}, load(nextMap) { this.loaded.push(nextMap.id); } },
    invalidate() {}, focus() {}, createSkirt() {}, createGrid() {}, setSettings() {}, targetPosition: () => map.center
  });
  terrain.terrainMaterial = new THREE.MeshStandardMaterial();
  terrain.mesh = new THREE.Mesh(terrain.createGeometry(), terrain.terrainMaterial);
  terrain.detail = new TerrainDetail(terrain);
  return terrain;
}

function installMapFetch(mapIds) {
  const manifest = Object.fromEntries(mapIds.map(id => [id, descriptorFor(id)]));
  globalThis.fetch = async url => String(url).endsWith('manifest.json')
    ? { ok: true, json: async () => manifest }
    : { ok: true, arrayBuffer: async () => flatBuffer() };
}

function walkerFor(terrain) {
  const walker = Object.create(ArtilleryNavigation.prototype);
  Object.assign(walker, { terrain, keys: new Set(), queuedKeys: new Set(), euler: new THREE.Euler(0, 0, 0, 'YXZ'), raycaster: new THREE.Raycaster() });
  terrain.settings.collision = true;
  walker.start('walk');
  return walker;
}

async function check(name, task) {
  await task(); passed++;
  console.log('PASS: ' + name);
}

try {
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) };
  globalThis.Image = class {
    set src(value) { this.url = value; queueMicrotask(() => this.onload()); }
  };
  detailHeights.record = async () => ({ descriptor: null });

  await check('terrain manifest retries after a transient failure', async () => {
    const terrain = terrainFor();
    installMapFetch(['terrain-test']);
    const successfulFetch = globalThis.fetch;
    let manifestRequests = 0;
    globalThis.fetch = async url => {
      if (String(url).endsWith('manifest.json') && ++manifestRequests === 1) throw new Error('transient manifest failure');
      return successfulFetch(url);
    };
    await assert.rejects(terrain.loadMap(terrain.map), /transient manifest failure/);
    assert.equal(await terrain.loadMap(terrain.map), true);
    assert.equal(manifestRequests, 2);
    assert.equal(terrain.ready, true);
    assert.equal(terrain.mesh.castShadow, true);
    assert.equal(terrain.terrainMaterial.shadowSide, THREE.FrontSide);
    assert.equal(terrain.mesh.customDepthMaterial, terrain.terrainDepthMaterial);
    let depthDisposals = 0;
    terrain.terrainDepthMaterial.addEventListener('dispose', () => depthDisposals++);
    terrain.clearTerrain();
    assert.equal(depthDisposals, 1);
  });

  await check('late base data cannot replace the newer map', async () => {
    const terrain = terrainFor();
    installMapFetch(['older', 'newer']);
    const successfulFetch = globalThis.fetch;
    const olderBuffer = deferred();
    globalThis.fetch = async url => url === 'older.bin' ? { ok: true, arrayBuffer: () => olderBuffer.promise } : successfulFetch(url);
    const olderLoad = terrain.loadMap(mapFor('older'));
    await flush();
    assert.equal(await terrain.loadMap(mapFor('newer')), true);
    const newerMesh = terrain.mesh;
    olderBuffer.resolve(flatBuffer());
    assert.equal(await olderLoad, false);
    assert.equal(terrain.map.id, 'newer'); assert.equal(terrain.mesh, newerMesh);
    assert.deepEqual(terrain.environment.loaded, ['newer']);
    terrain.clearTerrain();
  });

  await check('failed precision metadata leaves the map retryable without invalidating a newer load', async () => {
    const terrain = terrainFor();
    installMapFetch(['terrain-test', 'older', 'newer']);
    let records = 0;
    detailHeights.record = async () => { if (++records === 1) throw new Error('transient scene manifest failure'); return { descriptor: null }; };
    await assert.rejects(terrain.loadMap(terrain.map), /transient scene manifest failure/);
    assert.equal(terrain.ready, false);
    assert.equal(await terrain.loadMap(terrain.map), true);
    assert.equal(terrain.ready, true);
    const olderRecord = deferred();
    detailHeights.record = async map => map.id === 'older' ? olderRecord.promise : { descriptor: null };
    const olderLoad = terrain.loadMap(mapFor('older'));
    await flush();
    await terrain.loadMap(mapFor('newer'));
    const rejection = assert.rejects(olderLoad, /late metadata failure/);
    olderRecord.reject(new Error('late metadata failure')); await rejection;
    assert.equal(terrain.ready, true); assert.equal(terrain.map.id, 'newer');
    terrain.clearTerrain();
    detailHeights.record = async () => ({ descriptor: null });
  });

  await check('late precision metadata cannot overwrite the newer map', async () => {
    const terrain = terrainFor();
    installMapFetch(['older', 'newer']);
    const olderRecord = deferred();
    const newerDescriptor = { ratio: 4 };
    detailHeights.record = async map => map.id === 'older' ? olderRecord.promise : { descriptor: newerDescriptor };
    const olderLoad = terrain.loadMap(mapFor('older'));
    await flush();
    assert.equal(await terrain.loadMap(mapFor('newer')), true);
    olderRecord.resolve({ descriptor: { ratio: 8 } });
    assert.equal(await olderLoad, false);
    assert.equal(terrain.detailDescriptor, newerDescriptor);
    assert.deepEqual(terrain.environment.loaded, ['newer']);
    terrain.clearTerrain();
    detailHeights.record = async () => ({ descriptor: null });
  });

  await check('clearing a detail patch restores pickable terrain during sliced replacement', () => {
    const terrain = terrainFor();
    const completeIndex = terrain.mesh.geometry.index.array.slice();
    terrain.detail.update();
    const oldPatch = terrain.detail.patch;
    assert.equal(oldPatch.castShadow, true);
    assert.equal(oldPatch.receiveShadow, true);
    assert.equal(oldPatch.customDepthMaterial, terrain.terrainDepthMaterial);
    let disposed = 0;
    oldPatch.geometry.addEventListener('dispose', () => disposed++);
    assert.ok(terrain.mesh.geometry.drawRange.count < completeIndex.length);
    terrain.detail.clear(true);
    terrain.detail.update(false, 0);
    assert.equal(disposed, 1); assert.equal(terrain.detail.patch, null); assert.ok(terrain.detail.work);
    assert.deepEqual(terrain.mesh.geometry.index.array, completeIndex);
    assert.equal(terrain.mesh.geometry.drawRange.count, completeIndex.length);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
    assert.ok(ray.intersectObject(terrain.mesh, false).length > 0);
    terrain.detail.update(); assert.ok(terrain.detail.patch);
    terrain.clearTerrain();
  });

  await check('height exaggeration works with every model layer disabled', () => {
    for (const loading of ['stream', 'preload']) {
      const terrain = terrainFor();
      terrain.props.settings.loading = loading;
      terrain.heights.fill(32770);
      terrain.setHeightFactor(2);
      assert.equal(terrain.heightFactor, 2);
      assert.equal(terrain.mesh.geometry.attributes.position.getY(0), 8);
      terrain.props.settings.buildings = true;
      terrain.setHeightFactor(3); assert.equal(terrain.heightFactor, 2);
      terrain.setHeightFactor(1); assert.equal(terrain.heightFactor, 1);
      terrain.clearTerrain();
    }
  });

  await check('precision requests retry with a cooldown and ignore old-map failures', async () => {
    const terrain = terrainFor(); terrain.detailDescriptor = { ratio: 4 };
    let now = 10; let requests = 0;
    globalThis.performance = { now: () => now };
    detailHeights.ensure = async () => { if (++requests === 1) throw new Error('transient detail tile failure'); };
    terrain.detail.update(false, 0); await flush();
    terrain.detail.update(false, 0); await flush(); assert.equal(requests, 1);
    now += 1001;
    terrain.detail.update(false, 0); await flush(); assert.equal(requests, 2);
    const olderRequest = deferred();
    detailHeights.ensure = () => olderRequest.promise;
    terrain.detail.clear(true); terrain.detail.update(false, 0);
    terrain.revision++; terrain.detail.clear(true);
    terrain.detail.precisionRequest = 'newer-request';
    delete terrain.renderer.domElement.dataset.detailHeightError;
    olderRequest.reject(new Error('old-map failure')); await flush();
    assert.equal(terrain.detail.precisionRequest, 'newer-request');
    assert.equal(terrain.renderer.domElement.dataset.detailHeightError, undefined);
    terrain.clearTerrain();
    detailHeights.ensure = originalEnsure;
    globalThis.performance = originalGlobals.get('performance');
  });

  await check('height cache retains hot samples and evicts genuinely older tiles', async () => {
    const store = new DetailHeightStore();
    const descriptor = { samples: 2, cols: 260, rows: 2, heightOffset: 0, heightScale: 100 };
    const record = { descriptor, tiles: new Map(), jobs: new Map(), version: 0 };
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint16Array(4).fill(32768).buffer });
    await store.tile(record, 0, 0);
    for (let column = 1; column <= 128; column++) { assert.equal(store.sampleRaw(record, 0, 0), 32768); await store.tile(record, column, 0); }
    assert.equal(record.tiles.size, 128); assert.equal(store.sampleRaw(record, 0, 0), 32768);
    assert.equal(record.tiles.has('1_0'), false);
    await store.tile(record, 2, 0); await store.tile(record, 129, 0);
    assert.equal(record.tiles.has('2_0'), true); assert.equal(record.tiles.has('3_0'), false);
    assert.equal(record.jobs.size, 0);
  });

  await check('walking collision warming recovers in the same cell after its cooldown', async () => {
    const terrain = terrainFor(); const walker = walkerFor(terrain);
    let now = 10; let requests = 0;
    globalThis.performance = { now: () => now };
    const failedRequest = deferred(); const recoveredRecord = { recovered: true };
    walker.collision = { warm: () => { requests++; return requests === 1 ? failedRequest.promise : Promise.resolve(recoveredRecord); } };
    walker.moveWalk(new THREE.Vector3(), 1 / 60, false);
    const key = walker.warmKey;
    walker.moveWalk(new THREE.Vector3(), 1 / 60, false); assert.equal(requests, 1);
    failedRequest.reject(new Error('transient collision failure')); await flush();
    assert.equal(walker.warmKey, null); assert.equal(walker.warmRetry.key, key);
    assert.equal(terrain.renderer.domElement.dataset.walkCollision, 'unavailable');
    walker.moveWalk(new THREE.Vector3(), 1 / 60, false); assert.equal(requests, 1);
    now += 999; walker.moveWalk(new THREE.Vector3(), 1 / 60, false); assert.equal(requests, 1);
    now += 1; walker.moveWalk(new THREE.Vector3(), 1 / 60, false); await flush();
    assert.equal(requests, 2); assert.equal(walker.warmKey, key); assert.equal(walker.collisionRecord, recoveredRecord);
    assert.equal(walker.warmRetry, null); assert.equal(terrain.renderer.domElement.dataset.walkCollision, undefined);
    walker.moveWalk(new THREE.Vector3(), 1 / 60, false); assert.equal(requests, 2);
    terrain.clearTerrain();
    globalThis.performance = originalGlobals.get('performance');
  });

  await check('old-map collision failures cannot alter a newer walking session', async () => {
    for (const nextMapId of ['newer-map', 'terrain-test']) {
      const terrain = terrainFor(); const walker = walkerFor(terrain);
      const olderRequest = deferred(); const newerRequest = deferred();
      let requests = 0;
      walker.collision = { warm: () => ++requests === 1 ? olderRequest.promise : newerRequest.promise };
      walker.moveWalk(new THREE.Vector3(), 1 / 60, false);
      walker.stop(); terrain.map = mapFor(nextMapId); terrain.revision++; walker.start('walk');
      walker.moveWalk(new THREE.Vector3(), 1 / 60, false);
      const newerKey = walker.warmKey; const activeRequest = walker.warmRequest;
      olderRequest.reject(new Error('old-map collision failure')); await flush();
      assert.equal(walker.warmKey, newerKey); assert.equal(walker.warmRequest, activeRequest);
      assert.equal(walker.warmRetry, null); assert.equal(terrain.renderer.domElement.dataset.walkCollision, undefined);
      walker.moveWalk(new THREE.Vector3(), 1 / 60, false); assert.equal(requests, 2);
      const newerRecord = { map: nextMapId }; newerRequest.resolve(newerRecord); await flush();
      assert.equal(walker.collisionRecord, newerRecord);
      terrain.clearTerrain();
    }
  });

  await check('height tile requests deduplicate, retry failures and preserve seam interpolation', async () => {
    const store = new DetailHeightStore();
    const descriptor = { samples: 2, cols: 4, rows: 2, origin: [0, 0], step: [1, 1], heightOffset: 0, heightScale: 100 };
    const record = { descriptor, tiles: new Map(), jobs: new Map(), version: 0 };
    const response = deferred(); let requests = 0;
    globalThis.fetch = () => { requests++; return response.promise; };
    const first = store.tile(record, 0, 0); const second = store.tile(record, 0, 0);
    assert.equal(requests, 1);
    response.resolve({ ok: true, arrayBuffer: async () => new Uint16Array([32768, 32769, 32778, 32779]).buffer });
    await Promise.all([first, second]); assert.equal(record.jobs.size, 0);
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });
    await assert.rejects(store.tile(record, 1, 0), /长度无效/); assert.equal(record.jobs.size, 0);
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint16Array([32770, 32771, 32780, 32781]).buffer });
    await store.tile(record, 1, 0);
    store.seam = record;
    assert.equal(store.sample({ id: 'seam', bounds: [0, 0, 2048] }, [1.5, .5]), 6.5);
  });

  const landscape = { directory: 'mock-landscape', files: ['mask'], layers: ['early', 'late'] };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ 'environment-test': { landscape } }) });
  function environmentFor() {
    const terrain = terrainFor(mapFor('environment-test'));
    terrain.environment = new TerrainEnvironment(terrain);
    return terrain;
  }
  function trackedTexture() {
    const texture = new THREE.Texture(); texture.userData.disposals = 0;
    texture.addEventListener('dispose', () => texture.userData.disposals++);
    return texture;
  }

  await check('partial environment failures dispose completed and late textures once', async () => {
    const terrain = environmentFor(); const requests = new Map();
    THREE.TextureLoader.prototype.loadAsync = url => { const request = deferred(); requests.set(url.split('/').at(-1), request); return request.promise; };
    const loading = terrain.environment.load(terrain.map); await flush();
    const early = trackedTexture(); const late = trackedTexture();
    requests.get('mask').resolve(early); await flush();
    assert.equal(terrain.environment.textures.length, 1);
    requests.get('early.webp').reject(new Error('missing texture'));
    await loading; assert.equal(early.userData.disposals, 1);
    requests.get('late.webp').resolve(late); await flush();
    const surface = trackedTexture(); requests.get('ground-surface.webp').resolve(surface); await flush();
    assert.equal(surface.userData.disposals, 1);
    assert.equal(late.userData.disposals, 1); assert.equal(terrain.environment.textures.length, 0);
    assert.equal(terrain.renderer.domElement.dataset.groundLayers, 'error');
    terrain.clearTerrain(); assert.equal(early.userData.disposals, 1); assert.equal(late.userData.disposals, 1);
  });

  await check('environment cancellation disposes in-flight textures without touching its replacement', async () => {
    const terrain = environmentFor(); const requests = [];
    THREE.TextureLoader.prototype.loadAsync = () => { const request = deferred(); requests.push(request); return request.promise; };
    const olderLoad = terrain.environment.load(terrain.map); await flush();
    const oldTextures = Array.from({ length: 4 }, trackedTexture);
    requests[0].resolve(oldTextures[0]); await flush();
    const newerLoad = terrain.environment.load(terrain.map); await flush();
    assert.equal(oldTextures[0].userData.disposals, 1);
    const newTextures = Array.from({ length: 4 }, trackedTexture);
    for (let index = 0; index < 4; index++) requests[index + 4].resolve(newTextures[index]);
    await newerLoad;
    for (let index = 1; index < 4; index++) requests[index].resolve(oldTextures[index]);
    await olderLoad;
    assert.deepEqual(oldTextures.map(texture => texture.userData.disposals), [1, 1, 1, 1]);
    assert.deepEqual(newTextures.map(texture => texture.userData.disposals), [0, 0, 0, 0]);
    assert.deepEqual(terrain.environment.textures, newTextures);
    terrain.clearTerrain(); assert.deepEqual(newTextures.map(texture => texture.userData.disposals), [1, 1, 1, 1]);
  });

  await check('manual and automatic quality changes preserve residency and GPU resources', () => {
    const geometry = new THREE.BoxGeometry(); const material = new THREE.MeshStandardMaterial(); const texture = new THREE.Texture();
    material.map = texture;
    const resident = new THREE.Mesh(geometry, material);
    let disposals = 0;
    for (const resource of [geometry, material, texture]) resource.addEventListener('dispose', () => disposals++);
    const presence = new Map([['visited-model', resident]]);
    const textures = new Map([['cached-texture', texture]]);
    const terrain = {
      container: { clientWidth: 1000 }, camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), ready: true, renderProfile: 'balanced', detail: {},
      renderer: { setPixelRatio() {}, shadowMap: { enabled: false }, domElement: { dataset: {} }, info: { render: { calls: 1, triangles: 12 }, memory: { geometries: 1, textures: 1 } } },
      sun: { shadow: { mapSize: new THREE.Vector2(), camera: { updateProjectionMatrix() {} } } },
      props: { presence, textures, manifest: {}, reset() { throw new Error('quality must not reset residents'); }, loadMap() { throw new Error('quality must not reload maps'); }, wake() { this.dirty = true; } },
      callbacks: {}, resize() {}, invalidate() {}
    };
    terrain.scene.add(resident);
    const controller = new ScenePerformance(terrain);
    controller.setSettings({ quality: 'balanced' });
    for (const quality of ['high', 'low', 'balanced', 'auto']) {
      const previousProfile = terrain.renderProfile;
      terrain.props.work = { oldBudget: true }; terrain.props.dirty = false;
      controller.setSettings({ quality });
      if (previousProfile !== terrain.renderProfile) assert.equal(terrain.props.work, null);
      assert.equal(terrain.props.dirty, true);
      assert.equal(terrain.props.presence, presence); assert.equal(terrain.props.textures, textures);
      assert.equal(presence.get('visited-model'), resident); assert.equal(resident.parent, terrain.scene);
      assert.equal(resident.geometry, geometry); assert.equal(resident.material.map, texture); assert.equal(disposals, 0);
    }
    terrain.props.work = { oldBudget: true }; controller.profile = 'low'; controller.setSettings({ quality: 'auto' });
    assert.equal(terrain.renderProfile, 'low'); assert.equal(terrain.props.work, null); assert.equal(disposals, 0);
    for (const resource of [geometry, material, texture, controller.selection.geometry, controller.selection.material]) resource.dispose();
  });

  for (const localAnchor of [true, false]) await check('two rapid orbit moves collide outside stale coverage ' + (localAnchor ? 'with a local collider' : 'with an empty local circle'), () => {
    const previousPerformance = globalThis.performance;
    globalThis.performance = { now: () => 1000 };
    const terrain = {
      metresToWorld: .125, heightFactor: 1, active: true, ready: true, renderProfile: 'balanced', artilleryCameraMode: 'orbit',
      container: { clientWidth: 1000 }, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
      controls: { target: new THREE.Vector3(), getDistance: () => 100 },
      renderer: { domElement: { dataset: {} }, shadowMap: { enabled: false } }, callbacks: {}, invalidate() {}
    };
    const props = terrain.props = new PropView(terrain);
    const controller = new ScenePerformance(terrain);
    try {
      props.group.scale.setScalar(terrain.metresToWorld); props.group.updateMatrixWorld(true); props.group.visible = true;
      const geometry = new THREE.BoxGeometry(2, 2, 2); const material = new THREE.MeshBasicMaterial();
      props.manifest = { meshes: [{ name: 'resident wall', type: 'buildings', solid: true, runtimeRadius: Math.sqrt(3) }], materials: {} };
      props.prototypes.set(0, [{ geometry, material, triangles: 12 }]); props.materials.set('resident wall', material);
      const data = new Float32Array([0, 0, localAnchor ? 10 : 1600, 0, 0, 0, 1, 1, 1, 1, 0, 800, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0]);
      props.updateBatches(new Map([[0, [{ data, offset: 0 }, { data, offset: 11 }]]]));
      assert.equal(props.colliders.length, localAnchor ? 1 : 0, 'The wall is resident but outside the initial local collider circle');
      assert.equal(props.batches.get(0)[0].count, 2);
      const originalColliders = props.colliders;
      controller.settings = { collision: true };
      props.lastUpdate = performance.now();
      terrain.camera.position.x = 50; controller.update(16);
      assert.equal(terrain.camera.position.x, 50, 'The first movement has no obstruction');
      props.update();
      assert.equal(props.work, null, 'The 140ms throttle prevents a collision-coverage rebuild between frames');
      assert.equal(props.colliders, originalColliders);
      const sweep = new THREE.Raycaster(new THREE.Vector3(50, 0, 0), new THREE.Vector3(1, 0, 0), 0, 59.25);
      const wall = props.pick(sweep);
      assert.ok(wall && Math.abs(wall.point.x - 99.875) < 1e-6, 'The wall remains rendered and pickable before collision coverage refreshes');
      const hits = props.intersectColliders(sweep);
      assert.ok(hits.length > 0 && Math.abs(hits[0].point.x - 99.875) < 1e-6, 'An out-of-coverage sweep must find the nearest resident solid wall');
      terrain.camera.position.x = 109; controller.update(32);
      assert.ok(Math.abs(terrain.camera.position.x - 99.575) < 1e-6, 'The second sub-60-world movement must stop 0.3 world units before the wall');
      assert.equal(props.colliders, originalColliders, 'Fallback must not require rebuilding the local support mesh collection');
      assert.equal(props.batches.get(0)[0].count, 2, 'Collision fallback must preserve all resident render instances');
    } finally {
      props.reset(); controller.selection.geometry.dispose(); controller.selection.material.dispose();
      globalThis.performance = previousPerformance;
    }
  });

  console.log('PASS: ' + passed + ' terrain loading, cache, disposal, quality and collision checks');
} finally {
  detailHeights.record = originalRecord;
  detailHeights.ensure = originalEnsure;
  THREE.TextureLoader.prototype.loadAsync = originalLoadTexture;
  for (const [name, value] of originalGlobals) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
}
