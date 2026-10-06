import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import * as THREE from '../vendor/three/three.module.js';
import { SpatialColliders } from '../spatial-colliders.js';
import { PropView } from '../prop-view.js';
import { ModelPresence, modelRanges, modelLod, selectModels } from '../model-residency.js';
import { drainWork, sortInSlices, vertexNormalsInSlices } from '../frame-work.js';
import { MaterialBatches } from '../material-batches.js';
import { ShaderWarmup } from '../shader-warmup.js';
import { TerrainView } from '../terrain-view.js';
import { TerrainDetail } from '../terrain-detail.js';
import { DetailHeightStore } from '../terrain-height-detail.js';
import { ScenePerformance } from '../scene-performance.js';
import { ArtilleryNavigation } from '../artillery-navigation.js';
import { instanceHit, MapCollision } from '../map-collision.js';

const geometry = new THREE.BoxGeometry(2, 2, 2);
const material = new THREE.MeshBasicMaterial();
const objects = [];
for (let row = 0; row < 50; row++) for (let column = 0; column < 50; column++) {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(column * 12, 2, row * 12); object.updateMatrixWorld(); objects.push(object);
}
const spatial = new SpatialColliders(8); spatial.setGroup('buildings', objects);
const ray = new THREE.Raycaster(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, -1, 0), 0, 10);
const baselineHit = ray.intersectObjects(objects, false)[0];
const indexedHit = spatial.intersect(ray)[0];
assert.equal(indexedHit.object, baselineHit.object);
assert.equal(indexedHit.distance, baselineHit.distance);
assert.ok(spatial.lastCandidates <= 2, 'A local support ray must not scan all 2500 buildings');
const localCandidates = spatial.lastCandidates;
const large = new THREE.Mesh(new THREE.BoxGeometry(600, 2, 600), material); large.position.y = -3; large.updateMatrixWorld();
spatial.setGroup('large', [large]); assert.equal(spatial.overflow.size, 1);
for (const position of [[0, 8, 0], [-.999, 8, -.999], [12, 8, 12], [3, 8, 3], [70, 8, 70]]) {
  ray.ray.origin.fromArray(position);
  const expected = ray.intersectObjects([...objects, large], false);
  const actual = spatial.intersect(ray);
  assert.deepEqual(actual.map(hit => Number(hit.distance.toFixed(7))), expected.map(hit => Number(hit.distance.toFixed(7))));
}
spatial.removeGroup('buildings'); assert.equal(spatial.entries.size, 1);
spatial.clear(); assert.equal(spatial.cells.size, 0); assert.equal(spatial.entries.size, 0);
assert.equal(new SpatialColliders(NaN).cellSize, 4);
large.geometry.dispose();

const terrain = { metresToWorld: 1, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: { domElement: { dataset: {} } } };
const props = new PropView(terrain);
props.manifest = { meshes: [{ name: 'test building', type: 'buildings', solid: true }], materials: {} };
props.prototypes.set(0, [{ geometry, material: null, materialName: 'test building', triangles: 12 }]);
const data = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 4, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0]);
const selection = [{ data, offset: 0 }];
props.updateBatches(new Map([[0, selection]]));
const batch = props.batches.get(0)[0]; assert.ok(batch.material?.isMaterial, 'New LOD geometry must receive a real material before rendering'); const matrixVersion = batch.instanceMatrix.version; const colorVersion = batch.instanceColor.version;
const collider = props.colliders[0];
props.updateBatches(new Map([[0, [{ data, offset: 0 }]]]));
assert.equal(batch.instanceMatrix.version, matrixVersion, 'Unchanged selections must not upload matrices again');
assert.equal(batch.instanceColor.version, colorVersion, 'Unchanged selections must not upload colors again');
assert.equal(props.colliders[0], collider, 'Unchanged selections must reuse exact collision meshes');
props.updateBatches(new Map()); assert.equal(props.colliderIndex.entries.size, 0); assert.equal(batch.visible, false);
props.updateBatches(new Map([[0, selection]])); assert.equal(props.colliderIndex.entries.size, 1); assert.equal(batch.visible, true);
props.updateBatches(new Map([[0, [{ data, offset: 0 }, { data, offset: 11 }]]]));
assert.ok(batch.instanceMatrix.version > matrixVersion); assert.equal(props.colliderIndex.entries.size, 2);
props.reset();

assert.equal(modelRanges(12, 'balanced', true).buildings, 1200);
assert.deepEqual(modelRanges(12, 'balanced', true), modelRanges(1800, 'balanced', true), 'Navigation coverage must not follow the artificial 12m look target');
assert.equal(modelRanges(12, 'balanced', false).buildings, 420);
assert.equal(modelLod(650, 9, 'balanced', 1), 1);
assert.equal(modelLod(650, 9, 'balanced', 2), 2);
assert.equal(modelLod(590, 11, 'balanced', 2), 1);
assert.equal(modelLod(250, 22, 'high', 0), 0);
assert.equal(modelLod(250, 22, 'high', 2), 1);
const modelCandidates = Array.from({ length: 10 }, (_, index) => ({ mesh: 0, type: 'buildings', data, offset: index * 11, distance: 70 + index, order: index, baseTriangles: 100, detailKey: '0:1', detailTriangles: 700 }));
const modelBudgets = { buildings: 10, trees: 0, props: 0 }; const modelLimits = { buildings: 2400, trees: 0, props: 0 };
const coarseSelection = selectModels(modelCandidates.map(candidate => ({ ...candidate, detailKey: undefined })), modelBudgets, modelLimits);
const detailSelection = selectModels(modelCandidates.map(candidate => ({ ...candidate })), modelBudgets, modelLimits);
assert.deepEqual(detailSelection.counts, coarseSelection.counts, 'Loading fine LODs cannot remove other reserved coarse instances');
assert.equal(detailSelection.counts.buildings, 10); assert.ok(detailSelection.triangles.buildings <= 2400);
assert.equal(detailSelection.grouped.get('0:1').length, 2);
const swapped = selectModels(modelCandidates.map(candidate => ({ ...candidate, distance: 100 - candidate.order, detailKey: undefined })), modelBudgets, modelLimits);
assert.deepEqual(swapped.grouped.get(0).map(instance => instance.offset), coarseSelection.grouped.get(0).map(instance => instance.offset), 'Camera sorting must not reorder unchanged GPU batches');

const scenePresence = new ModelPresence();
const presenceMeshes = [{ type: 'buildings' }];
const presenceSettings = { buildings: true };
drainWork(scenePresence.retain(detailSelection.grouped, presenceMeshes, presenceSettings));
const absentSelection = drainWork(scenePresence.retain(new Map(), presenceMeshes, presenceSettings)).value;
assert.equal(absentSelection.counts.buildings, 10, 'Leaving the loading range or selection budget must keep every previously displayed instance in the 3D scene');
assert.equal(absentSelection.grouped.get(0).length, 10, 'Retained instances use available coarse geometry instead of vanishing');
const restoredSelection = drainWork(scenePresence.retain(detailSelection.grouped, presenceMeshes, presenceSettings)).value;
assert.equal(restoredSelection.counts.buildings, 10, 'A returning fine LOD must replace its coarse instance without duplicating it');
assert.equal(scenePresence.count, 10);
assert.equal(drainWork(scenePresence.retain(new Map(), presenceMeshes, { buildings: false })).value.grouped.size, 0);
assert.equal(drainWork(scenePresence.retain(new Map(), presenceMeshes, presenceSettings)).value.counts.buildings, 10, 'Explicit layer toggles hide and restore retained scene models');

const navigationCamera = new THREE.PerspectiveCamera(50, 1, .1, 5000);
navigationCamera.position.set(0, 2, 0); navigationCamera.lookAt(0, 2, -10); navigationCamera.updateMatrixWorld();
const navigationTerrain = { metresToWorld: 1, renderer: { domElement: { dataset: {} }, shadowMap: {} }, invalidate() {}, callbacks: {}, scene: new THREE.Scene(), active: true, ready: true, heightFactor: 1, artilleryCameraMode: 'walk', renderProfile: 'balanced', camera: navigationCamera,
  controls: { getDistance: () => 12, target: new THREE.Vector3(0, 2, -12) }, container: { clientHeight: 900 } };
const navigationModels = new PropView(navigationTerrain);
navigationModels.manifest = { tileSizeMetres: 256, originMetres: [0, 0], meshes: [{ name: 'test building', type: 'buildings', solid: true, bounds: [-1, -1, -1, 1, 1, 1] }], materials: {}, tiles: [] };
navigationModels.prototypes.set(0, [{ geometry: geometry.clone(), material: null, materialName: 'navigation building', triangles: 12 }]);
for (const [order, depth] of [10, -800, 800].entries()) {
  const tile = { key: String(order), x: 0, z: Math.floor(depth / 256), counts: { buildings: 1, trees: 0, props: 0 } };
  navigationModels.manifest.tiles.push(tile);
  navigationModels.tileCache.set(tile.key, [{ mesh: 0, order, instances: 1, data: new Float32Array([0, 0, depth, 0, 0, 0, 1, 1, 1, 1, 0]) }]);
}
navigationModels.requestBundle = () => Promise.resolve(); navigationModels.lastUpdate = -Infinity; navigationModels.update();
assert.equal(navigationTerrain.renderer.domElement.dataset.modelBuildings, '2', 'Keep nearby geometry behind the camera and buildings beyond the old 420m limit');
assert.equal(navigationTerrain.renderer.domElement.dataset.modelRangeBuildings, '1200');
const residentTile = navigationModels.tileCache.get('0');
for (let index = 0; index < 200; index++) navigationModels.tileCache.set('visited-' + index, []);
navigationModels.lastUpdate = -Infinity; navigationModels.wake(); navigationModels.update();
assert.equal(navigationModels.tileCache.size, 203, 'Visited position data must remain cached beyond the previous 192-tile limit in on-demand mode');
assert.equal(navigationModels.tileCache.get('0'), residentTile);
navigationModels.read = () => { throw new Error('Cached positions must not be read again'); };
await navigationModels.requestTile({ key: 'visited-0' });
const waitingMaterial = new THREE.MeshBasicMaterial(); waitingMaterial.visible = false;
navigationModels.prototypes.set('0:1', [{ geometry: geometry.clone(), material: new THREE.MeshBasicMaterial(), triangles: 12 }, { geometry: geometry.clone(), material: waitingMaterial, triangles: 12 }]);
navigationModels.lastUpdate = -Infinity; navigationModels.wake(); navigationModels.update();
assert.equal(navigationModels.batches.has('0:1'), false, 'Keep the coarse model until every fine-LOD material is visible');
waitingMaterial.visible = true; navigationModels.lastUpdate = -Infinity; navigationModels.wake(); navigationModels.update();
assert.equal(navigationModels.batches.get('0:1')[0].count, 1);
assert.equal(navigationModels.colliders.length, 2, 'Only nearby building parts need support-ray meshes; distant buildings stay rendered');
navigationCamera.lookAt(0, 2, 10); navigationCamera.updateMatrixWorld();
navigationModels.lastUpdate = -Infinity; navigationModels.wake(); navigationModels.update();
assert.equal(navigationTerrain.renderer.domElement.dataset.modelSceneInstances, '3', 'Turning around adds the new direction without removing the previous direction from the scene');
navigationCamera.position.set(10000, 2, 0); navigationCamera.lookAt(10010, 2, 0); navigationCamera.updateMatrixWorld();
navigationModels.lastUpdate = -Infinity; navigationModels.wake(); navigationModels.update();
assert.equal(navigationTerrain.renderer.domElement.dataset.modelCandidates, '0');
assert.equal(navigationModels.batches.get(0)[0].visible, true);
assert.equal(navigationModels.batches.get(0)[0].count, 3, 'Models remain renderable even ten kilometres beyond the loading range');
assert.equal(navigationModels.colliders.length, 0, 'Retained distant geometry must not expand nearby support collision work');
navigationCamera.position.set(0, 2, 0); navigationCamera.lookAt(0, 2, -10); navigationCamera.updateMatrixWorld();
const immediateHit = navigationModels.pick(new THREE.Raycaster(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 0, 1000));
assert.ok(immediateHit && Math.abs(immediateHit.distance - 799) < 1e-6, 'Returning to a previously visited 3D view must have geometry immediately, before any loading/selection update');
navigationTerrain.artilleryCameraMode = 'orbit'; navigationTerrain.controls.target.set(10000, 0, 0);
navigationModels.lastUpdate = -Infinity; navigationModels.wake(); navigationModels.update();
assert.equal(navigationTerrain.renderer.domElement.dataset.modelSceneInstances, '3', 'Ordinary 3D Map orbit retains visited models just like Fly and Walk');
assert.equal(navigationModels.colliders.length, 1, 'Ordinary orbit keeps only the nearby building collider while retaining all three scene models');
navigationModels.reset();
assert.equal(navigationModels.tileCache.size, 0, 'Changing maps releases retained position data');
assert.equal(navigationModels.presence.count, 0);

const previousAnimationFrame = globalThis.requestAnimationFrame;
try {
  globalThis.requestAnimationFrame = callback => queueMicrotask(() => callback(performance.now()));
  const makePreloader = () => {
    const loader = Object.create(PropView.prototype);
    Object.assign(loader, { generation: 1, preloadRun: 0, settings: { loading: 'preload' }, preloadStatus: { state: 'idle' }, tileCache: new Map(), textureJobs: new Map(), failedTiles: new Set(), failedBundles: new Set(), textureFailures: 0,
      manifest: { tiles: [{ key: 'a' }, { key: 'b' }, { key: 'c' }], bundles: [{ lods: { 0: {}, 1: {}, 2: {} } }], textures: { 'color.webp': {}, 'normal.webp': {} }, materials: {} }, calls: [], wake() {}, materialFor() {} });
    loader.requestTile = async tile => { loader.calls.push('tile:' + tile.key); loader.tileCache.set(tile.key, []); };
    loader.requestBundle = async (index, lod) => { loader.calls.push('bundle:' + index + ':' + lod); };
    loader.textureFor = async filename => { loader.calls.push('texture:' + filename); };
    return loader;
  };
  const preload = makePreloader(); await preload.preloadMap();
  assert.equal(preload.preloadStatus.state, 'ready'); assert.equal(preload.preloadStatus.completed, 8); assert.equal(preload.preloadStatus.total, 8);
  assert.equal(preload.tileCache.size, 3); assert.ok([0, 1, 2].every(lod => preload.calls.includes('bundle:0:' + lod)));
  assert.ok(preload.calls.includes('texture:color.webp') && preload.calls.includes('texture:normal.webp'));
  await preload.preloadMap(); assert.equal(preload.calls.length, 8, 'Completed preloads must not redownload');
  const cancelled = makePreloader(); cancelled.wake = () => { if (cancelled.preloadStatus.completed) cancelled.settings.loading = 'stream'; };
  await cancelled.preloadMap(); assert.ok(cancelled.calls.length <= 2); assert.notEqual(cancelled.preloadStatus.state, 'ready');
  const failed = makePreloader(); failed.textureFor = async () => { throw new Error('Expected missing texture'); };
  await failed.preloadMap(); assert.equal(failed.preloadStatus.state, 'partial'); assert.equal(failed.preloadStatus.failures, 2);
  const reset = makePreloader(); reset.requestTile = async () => { reset.generation++; }; await reset.preloadMap(); assert.notEqual(reset.preloadStatus.state, 'ready');
} finally {
  if (previousAnimationFrame === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = previousAnimationFrame;
}


let logicalClock = 0;
function* countedWork() { for (let index = 0; index < 12; index++) { logicalClock++; yield; } return 12; }
const budgetedWork = countedWork();
assert.equal(drainWork(budgetedWork, 3, () => logicalClock).done, false);
assert.equal(logicalClock, 3, 'Work must yield when the frame budget is exhausted');
assert.equal(drainWork(budgetedWork).value, 12);
function* uploadWork() { yield 'frame'; return 'uploaded'; }
const uploadTask = uploadWork();
assert.equal(drainWork(uploadTask).done, true);
const boundedUpload = uploadWork();
assert.equal(drainWork(boundedUpload, performance.now() + 1000).done, false);
assert.equal(drainWork(boundedUpload).value, 'uploaded');
const sortable = Array.from({ length: 4097 }, (_, index) => ({ key: Math.imul(index, 37) % 31, index }));
const sorted = sortable.slice().sort((first, second) => first.key - second.key);
drainWork(sortInSlices(sortable, (first, second) => first.key - second.key));
assert.deepEqual(sortable, sorted, 'Incremental sorting must preserve ordering and equal-key stability');

const normalGeometry = new THREE.PlaneGeometry(16, 16, 32, 32).rotateX(-Math.PI / 2);
const normalVertices = normalGeometry.attributes.position;
for (let index = 0; index < normalVertices.count; index++) normalVertices.setY(index, Math.sin(normalVertices.getX(index)) * .4 + Math.cos(normalVertices.getZ(index)) * .7);
normalGeometry.computeVertexNormals();
const normalResult = drainWork(vertexNormalsInSlices(normalVertices.array, normalGeometry.index.array)).value;
for (let index = 0; index < normalResult.length; index++) assert.ok(Math.abs(normalResult[index] - normalGeometry.attributes.normal.array[index]) < 1e-6, 'Sliced normals must match Three.js on uneven terrain');
normalGeometry.dispose();

const atomicProps = new PropView({ ...terrain, invalidate() {} });
atomicProps.manifest = { meshes: [{ name: 'atomic LOD building', type: 'buildings', solid: false }], materials: {} };
atomicProps.prototypes.set(0, [{ geometry: geometry.clone(), material, triangles: 12 }]);
atomicProps.prototypes.set('0:1', [{ geometry: geometry.clone(), material, triangles: 12 }]);
const atomicData = new Float32Array(70 * 11);
for (let index = 0; index < 70; index++) atomicData.set([index, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0], index * 11);
const atomicInstances = Array.from({ length: 70 }, (_, index) => ({ data: atomicData, offset: index * 11 }));
atomicProps.updateBatches(new Map([[0, atomicInstances]]));
const coarseBatch = atomicProps.batches.get(0)[0];
const fineWork = atomicProps.updateBatchesWork(new Map([['0:1', atomicInstances]]));
assert.equal(fineWork.next().done, false);
assert.equal(coarseBatch.visible, true, 'Retain the old coarse mesh while preparing a fine LOD');
assert.equal(atomicProps.batches.has('0:1'), false, 'Do not show a partially populated fine mesh');
drainWork(fineWork);
assert.equal(coarseBatch.visible, false);
assert.equal(atomicProps.batches.get('0:1')[0].visible, true);
atomicProps.work = atomicProps.updateBatchesWork(new Map([[0, atomicInstances]]));
atomicProps.reset();
assert.equal(atomicProps.work, null, 'Map reset cancels staged work');
assert.equal(atomicProps.batches.size, 0);

const batchedGroup = new THREE.Group();
const materialBatcher = new MaterialBatches(batchedGroup, true);
const batchedProxies = [];
const batchedMatrix = new THREE.Matrix4();
const batchedColor = new THREE.Color();
for (let index = 0; index < 100; index++) {
  const proxy = new THREE.InstancedMesh(geometry.clone(), material, 1);
  proxy.setMatrixAt(0, batchedMatrix.makeTranslation(index * 3, index % 4, 0));
  proxy.setColorAt(0, new THREE.Color().setRGB(index / 100, .4, .7));
  batchedGroup.add(proxy);
  materialBatcher.sync(proxy);
  batchedProxies.push(proxy);
}
assert.equal(batchedGroup.children.length, 1, 'Different small geometries sharing a material should issue one multi-draw group');
assert.equal(batchedGroup.children[0].instanceCount, 100);
for (let index = 0; index < batchedProxies.length; index++) {
  const proxy = batchedProxies[index];
  const entry = materialBatcher.records.get(proxy).instances[0];
  entry.pool.mesh.getMatrixAt(entry.id, batchedMatrix);
  assert.equal(batchedMatrix.elements[12], index * 3);
  entry.pool.mesh.getColorAt(entry.id, batchedColor);
  assert.ok(Math.abs(batchedColor.r - index / 100) < 1e-6);
  materialBatcher.hide(proxy);
}
const residentPool = batchedGroup.children[0];
const residentRecord = materialBatcher.records.get(batchedProxies[0]);
const residentSlot = residentRecord.instances[0];
const residentGeometry = residentPool.geometry;
assert.equal(residentPool.visible, false, 'A fully hidden pool must not draw or cast shadows');
assert.deepEqual(materialBatcher.stats, { pools: 1, geometries: 100, instances: 100, visibleInstances: 0, createdPools: 1 });
let redundantUploads = 0;
const residentMatrixSetter = residentPool.setMatrixAt.bind(residentPool);
const residentColorSetter = residentPool.setColorAt.bind(residentPool);
residentPool.setMatrixAt = (...args) => { redundantUploads++; return residentMatrixSetter(...args); };
residentPool.setColorAt = (...args) => { redundantUploads++; return residentColorSetter(...args); };
for (let cycle = 0; cycle < 20; cycle++) {
  for (const proxy of batchedProxies) materialBatcher.sync(proxy);
  assert.equal(materialBatcher.stats.visibleInstances, 100);
  for (const proxy of batchedProxies) materialBatcher.hide(proxy);
}
assert.equal(redundantUploads, 0, 'Revisiting an unchanged selection must only toggle visibility, without matrix/color uploads');
assert.equal(materialBatcher.records.get(batchedProxies[0]), residentRecord);
assert.equal(residentRecord.instances[0], residentSlot, 'Repeated departures and returns reuse the exact GPU instance slot');
assert.equal(residentPool.geometry, residentGeometry);
assert.equal(materialBatcher.stats.createdPools, 1, 'Hidden resident pools must survive any number of selection cycles');
materialBatcher.sync(batchedProxies[0]);
assert.equal(residentPool.visible, true);
assert.equal(residentPool.getVisibleAt(residentSlot.id), true);
assert.equal(residentPool.getVisibleAt(materialBatcher.records.get(batchedProxies[1]).instances[0].id), false, 'Showing one resident model must not show its hidden neighbours');
const shrinkingProxy = new THREE.InstancedMesh(geometry, material, 4);
for (let index = 0; index < 4; index++) shrinkingProxy.setMatrixAt(index, batchedMatrix.makeTranslation(index, 0, 0));
materialBatcher.sync(shrinkingProxy);
const shrinkingSlots = materialBatcher.records.get(shrinkingProxy).instances.slice();
shrinkingProxy.count = 1; materialBatcher.sync(shrinkingProxy);
assert.equal(materialBatcher.stats.instances, 104);
assert.equal(materialBatcher.stats.visibleInstances, 2);
assert.equal(shrinkingSlots[3].pool.mesh.getVisibleAt(shrinkingSlots[3].id), false);
materialBatcher.hide(shrinkingProxy); materialBatcher.hide(shrinkingProxy);
shrinkingProxy.count = 4; materialBatcher.sync(shrinkingProxy);
assert.deepEqual(materialBatcher.records.get(shrinkingProxy).instances, shrinkingSlots, 'Shrinking then expanding reuses retained slots');
assert.equal(materialBatcher.stats.visibleInstances, 5);
shrinkingProxy.count = 0; materialBatcher.sync(shrinkingProxy);
assert.equal(materialBatcher.stats.visibleInstances, 1);
materialBatcher.remove(shrinkingProxy); shrinkingProxy.dispose();
for (const proxy of batchedProxies) materialBatcher.remove(proxy);
assert.equal(materialBatcher.stats.instances, 0);
assert.equal(residentPool.visible, false);
materialBatcher.sync(batchedProxies[0]);
assert.equal(materialBatcher.stats.createdPools, 1, 'Geometry remains reusable after an instance allocation is replaced');
const transparentMaterial = material.clone(); transparentMaterial.transparent = true;
const transparentProxy = new THREE.InstancedMesh(geometry, transparentMaterial, 1);
materialBatcher.sync(transparentProxy);
assert.equal(transparentProxy.parent, null, 'Transparent instances render through the sorted pool');
assert.equal(materialBatcher.records.get(transparentProxy).instances[0].pool.mesh.sortObjects, true);
const repeatedProxy = new THREE.InstancedMesh(geometry, material, 65);
materialBatcher.sync(repeatedProxy);
assert.equal(repeatedProxy.parent, batchedGroup, 'Many copies of one mesh retain efficient instancing');
const fallbackBatcher = new MaterialBatches(batchedGroup, false);
const fallbackProxy = new THREE.InstancedMesh(geometry, material, 1);
fallbackBatcher.sync(fallbackProxy);
assert.equal(fallbackProxy.parent, batchedGroup, 'Browsers without multi-draw retain the original render path');
const sortedProxy = new THREE.InstancedMesh(geometry, transparentMaterial, 2);
sortedProxy.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, -10));
sortedProxy.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, -30));
fallbackBatcher.sync(sortedProxy);
const sortedRecord = fallbackBatcher.records.get(sortedProxy);
const sortedPool = sortedRecord.instances[0].pool.mesh;
const sortCamera = new THREE.PerspectiveCamera(50, 1, .1, 100);
sortCamera.updateMatrixWorld();
sortedPool.onBeforeRender(null, null, sortCamera, sortedPool.geometry, transparentMaterial);
assert.equal(sortedPool._multiDrawCount, 2);
assert.equal(sortedPool._indirectTexture.image.data[0], sortedRecord.instances[1].id, 'Glass renders back to front even without multi-draw');
sortCamera.position.set(0, 0, -40); sortCamera.lookAt(0, 0, 0); sortCamera.updateMatrixWorld();
sortedPool.onBeforeRender(null, null, sortCamera, sortedPool.geometry, transparentMaterial);
assert.equal(sortedPool._indirectTexture.image.data[0], sortedRecord.instances[0].id, 'Turning to the reverse side updates transparent instance order');
sortedProxy.dispose();
for (const proxy of batchedProxies) { proxy.dispose(); proxy.geometry.dispose(); }
transparentProxy.dispose(); transparentMaterial.dispose(); repeatedProxy.dispose(); fallbackProxy.dispose();
let disposedResidentPools = 0;
residentGeometry.addEventListener('dispose', () => { disposedResidentPools++; });
materialBatcher.dispose(); fallbackBatcher.dispose();
assert.equal(disposedResidentPools, 1);
assert.equal(materialBatcher.pools.size, 0);
assert.equal(materialBatcher.records.size, 0);
assert.equal(batchedGroup.children.filter(child => child.isBatchedMesh).length, 0, 'Map disposal releases all retained GPU pools');

const immediateGroup = new THREE.Group();
const immediateBatcher = new MaterialBatches(immediateGroup, true);
const immediateProxy = new THREE.InstancedMesh(geometry, material, 2);
immediateProxy.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 570));
immediateProxy.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, 630));
immediateBatcher.sync(immediateProxy);
const immediateRecord = immediateBatcher.records.get(immediateProxy);
const immediatePool = immediateRecord.instances[0].pool.mesh;
const immediateCamera = new THREE.PerspectiveCamera(50, 1, .1, 1000);
immediateCamera.position.set(0, 0, 600);
immediateCamera.updateMatrixWorld();
immediatePool.onBeforeRender(null, null, immediateCamera, immediatePool.geometry, material);
assert.equal(immediatePool._multiDrawCount, 1);
assert.equal(immediatePool._indirectTexture.image.data[0], immediateRecord.instances[0].id);
immediateCamera.lookAt(0, 0, 630); immediateCamera.updateMatrixWorld();
immediatePool.onBeforeRender(null, null, immediateCamera, immediatePool.geometry, material);
assert.equal(immediatePool._multiDrawCount, 1);
assert.equal(immediatePool._indirectTexture.image.data[0], immediateRecord.instances[1].id, 'The renderer must draw the returning direction in the same frame without model-selection work');
assert.ok(immediateRecord.instances.every(instance => instance.pool.mesh.getVisibleAt(instance.id)));
immediateBatcher.dispose(); immediateProxy.dispose();

const distributedGroup = new THREE.Group();
const distributedBatcher = new MaterialBatches(distributedGroup, true);
const distributedProxy = new THREE.InstancedMesh(geometry, material, 513);
distributedProxy.userData.perInstanceCulling = true;
for (let index = 0; index < 513; index++) distributedProxy.setMatrixAt(index, new THREE.Matrix4().makeTranslation(index, 0, -30));
distributedBatcher.sync(distributedProxy);
assert.equal(distributedBatcher.stats.pools, 3, 'Persistent repeated models require per-instance culling across bounded multi-draw pools');
assert.equal(distributedBatcher.stats.visibleInstances, 513);
assert.equal(distributedProxy.parent, null, 'The picking proxy must not also render all off-screen historical instances');
distributedBatcher.hide(distributedProxy); distributedBatcher.sync(distributedProxy);
assert.equal(distributedBatcher.stats.pools, 3);
assert.equal(distributedBatcher.stats.visibleInstances, 513);
const previousCell = distributedBatcher.records.get(distributedProxy).instances[0].pool;
distributedProxy.setMatrixAt(0, new THREE.Matrix4().makeTranslation(4096, 0, -30));
distributedProxy.instanceMatrix.needsUpdate = true;
distributedBatcher.sync(distributedProxy);
const nextCell = distributedBatcher.records.get(distributedProxy).instances[0].pool;
assert.notEqual(nextCell, previousCell, 'Changing selected instance positions must move GPU slots into the matching spatial pool');
assert.equal(distributedBatcher.stats.visibleInstances, 513);
assert.equal(distributedBatcher.stats.instances, 513);
assert.equal(nextCell.mesh.frustumCulled, true);
assert.ok(nextCell.mesh.boundingSphere.containsPoint(new THREE.Vector3(4096, 0, -30)), 'Pool bounds must include newly placed geometry');
distributedBatcher.dispose(); distributedProxy.dispose();


let completeProgram;
let compiledKinds = [];
const shaderTerrain = { camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), invalidate() {}, renderer: { shadowMap: { enabled: false, type: 1 }, compileAsync: object => { compiledKinds.push(object.isBatchedMesh ? 'batch' : 'instance'); return new Promise(resolve => { completeProgram = resolve; }); } } };
const shaderWarmer = new ShaderWarmup(shaderTerrain, true);
const shaderMaterial = new THREE.MeshStandardMaterial();
const shaderAlias = shaderMaterial.clone();
const readyProgram = shaderWarmer.prepare(shaderMaterial);
assert.equal(shaderWarmer.prepare(shaderAlias), readyProgram, 'Equivalent materials reuse the same program warmup');
shaderWarmer.update(); assert.equal(shaderWarmer.pending, 1);
completeProgram(); await Promise.resolve(); await Promise.resolve();
assert.deepEqual(compiledKinds, ['instance', 'batch'], 'Warm both ordinary instancing and multi-draw variants');
completeProgram(); await readyProgram; await Promise.resolve();
assert.equal(shaderWarmer.pending, 0);
shaderWarmer.dispose(); shaderMaterial.dispose(); shaderAlias.dispose();
const cancelledWarmer = new ShaderWarmup(shaderTerrain, true);
const cancelledMaterial = new THREE.MeshStandardMaterial();
const cancelledProgram = cancelledWarmer.prepare(cancelledMaterial);
const rejectedProgram = assert.rejects(cancelledProgram, { name: 'AbortError' });
cancelledWarmer.dispose(); await rejectedProgram; cancelledMaterial.dispose();
const activeWarmer = new ShaderWarmup(shaderTerrain, true);
const activeMaterial = new THREE.MeshStandardMaterial(); let activeDisposed = false;
activeMaterial.addEventListener('dispose', () => { activeDisposed = true; });
const activeProgram = activeWarmer.prepare(activeMaterial);
const activeRejection = assert.rejects(activeProgram, { name: 'AbortError' });
activeWarmer.update(); activeWarmer.dispose();
assert.equal(activeWarmer.deferMaterialDisposal(activeMaterial), true);
assert.equal(activeDisposed, false, 'Do not remove renderer program state while compileAsync still polls it');
completeProgram(); await activeRejection;
assert.equal(activeDisposed, true, 'Release cancelled shader resources after polling completes');

const store = new DetailHeightStore();
const sampleMap = { id: 'sampler-test', bounds: [0, 0, 2048] };
const descriptor = { cols: 4, rows: 4, origin: [0, 0], step: [1, 1], samples: 2, heightOffset: 250, heightScale: 100 };
const record = { descriptor, tiles: new Map() };
for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
  const values = new Uint16Array(4);
  for (let vertical = 0; vertical < 2; vertical++) for (let horizontal = 0; horizontal < 2; horizontal++) values[vertical * 2 + horizontal] = 32768 + column * 2 + horizontal + (row * 2 + vertical) * 10;
  record.tiles.set(column + '_' + row, { width: 2, height: 2, values });
}
store[sampleMap.id] = record;
for (const position of [[1.25, 1.75], [0, 0], [3, 3], [1.999, 2.001], [-10, 8]]) {
  const horizontal = Math.max(0, Math.min(3, position[0])); const vertical = Math.max(0, Math.min(3, position[1]));
  assert.ok(Math.abs(store.sample(sampleMap, position) - (2.5 + horizontal + vertical * 10)) < 1e-9, 'Bilinear sampling stays exact across tile boundaries');
}
assert.equal(store.sample({ ...sampleMap, id: 'unloaded' }, [1, 1]), null);

const sourceCollision = new MapCollision();
const sourceInstances = objects.map((object, index) => ({ id: index, position: object.position.toArray(), radius: index % 3 + 1 }));
sourceInstances.push({ id: 2500, position: [0, 0, 0], radius: 5000 });
const sourceRecord = { tiles: new Map([['first', sourceInstances.slice(0, 1250)], ['second', sourceInstances.slice(1250)]]) };
for (const point of [[0, 0, 0], [120, 0, 120], [-1, 0, 64], [300, 0, 300], [800, 0, 800]]) {
  const expected = sourceInstances.filter(instance => Math.hypot(instance.position[0] - point[0], instance.position[2] - point[2]) <= instance.radius + 4).map(instance => instance.id).sort((first, second) => first - second);
  const actual = sourceCollision.nearby(sourceRecord, point, 4).map(instance => instance.id).sort((first, second) => first - second);
  assert.deepEqual(actual, expected, 'Source OBB spatial queries preserve the old radius test');
  assert.ok(sourceRecord.spatial.lastCandidates < 80, 'Source walking queries must not flatten all loaded collision tiles');
}
const walker = Object.create(ArtilleryNavigation.prototype);
walker.terrain = { settings: { collision: true }, map: { bounds: [-102400, -102400, 204800] }, metresToWorld: 1, heightBaseline: 0 };
walker.collisionRecord = {}; let nearby = [];
walker.collision = { nearby: () => nearby };
for (let index = 0; index < 120; index++) {
  const angle = index * .21;
  const instance = { position: [0, index % 3 - 1, 0], quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(angle * .7, angle, angle * .4)).toArray(), scale: [index % 2 ? -1.5 : 1, 1 + index % 3, .75], bounds: [-2, 0, -3, 2, 2, 3] };
  nearby = [instance];
  const start = new THREE.Vector3(Math.sin(index) * 5, 0, Math.cos(index) * 5); const end = start.clone().add(new THREE.Vector3(.6, 0, .4));
  const expanded = { ...instance, bounds: instance.bounds.map((value, axis) => value + (axis < 3 ? -.25 : .25) / Math.max(.01, Math.abs(instance.scale[axis % 3]))) };
  const expected = [.9, 1.6].some(height => instanceHit([start.x, height, start.z], [end.x, height, end.z], expanded) !== null);
  assert.equal(walker.blocked(start, end), expected, 'Cached walking broadphase preserves rotated and mirrored OBB collisions');
  assert.equal(walker.walkingBounds(instance), walker.walkingBounds(instance));
}

const previousWindow = globalThis.window; const previousMatchMedia = globalThis.matchMedia;
try {
  globalThis.window = { devicePixelRatio: 1 }; globalThis.matchMedia = () => ({ matches: false });
  let resets = 0;
  const settingsTerrain = { container: { clientWidth: 1000 }, camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), ready: true, renderProfile: 'balanced', detail: {},
    renderer: { setPixelRatio() {}, shadowMap: { enabled: false }, domElement: { dataset: {} }, info: { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } } },
    sun: { shadow: { mapSize: new THREE.Vector2(), camera: { updateProjectionMatrix() {} } } }, controls: { target: new THREE.Vector3(), getDistance: () => 1 },
    props: { manifest: {}, reset() { resets++; }, loadMap() {}, wake() {}, statusStamp: '' }, callbacks: {}, resize() {}, invalidate() {} };
  const performance = new ScenePerformance(settingsTerrain);
  const automatic = { quality: 'auto', shadows: false, collision: false };
  performance.setSettings(automatic); performance.profile = 'low'; performance.setSettings(automatic);
  performance.profile = 'balanced'; performance.setSettings(automatic);
  assert.equal(resets, 0, 'Automatic LOD changes must not dispose and redownload the map');
  for (let index = 1; index <= 30; index++) performance.update(index * 145);
  assert.equal(performance.profile, 'balanced', 'Idle scheduling intervals must not be mistaken for slow rendering');
  assert.equal(performance.samples.length, 0);
  performance.setSettings({ ...automatic, quality: 'high' }); assert.equal(resets, 0, 'Manual quality changes must preserve loaded resources and scene instances');

  let focused = [1024, 1024]; let viewDistance = 20;
  const native = Object.create(TerrainView.prototype);
  Object.assign(native, { ready: true, map: { id: 'terrain-test', bounds: [0, 0, 102400], detail: { x: 512, y: 512, size: 512 } },
    descriptor: { cols: 129, rows: 129, sampleMetres: 8, origin: [0, 0], step: [800, 800], heightOffset: 0, heightScale: 100 },
    heights: new Uint16Array(129 * 129).fill(32768), heightBaseline: 0, metresToWorld: 2, heightFactor: 1, renderProfile: 'low', scene: new THREE.Scene(),
    terrainMaterial: new THREE.MeshBasicMaterial(), renderer: { domElement: { dataset: {} }, shadowMap: {} }, controls: { getDistance: () => viewDistance }, targetPosition: () => focused });
  native.mesh = new THREE.Mesh(native.createGeometry(), native.terrainMaterial);
  const original = native.mesh.geometry.index.array.slice(); const detail = new TerrainDetail(native); native.detail = detail;
  for (const center of [[1024, 1024], [256, 256]]) {
    focused = center; detail.update();
    const [, left, top, right, bottom] = detail.signature.split(':').map(Number);
    const expected = [];
    for (let row = 0; row < native.meshRows - 1; row++) for (let column = 0; column < native.meshColumns - 1; column++) {
      if (column >= left && column < right && row >= top && row < bottom) continue;
      const vertex = row * native.meshColumns + column; const next = vertex + native.meshColumns;
      expected.push(vertex, next, vertex + 1, vertex + 1, next, next + 1);
    }
    assert.deepEqual(Array.from(native.mesh.geometry.index.array.slice(0, native.mesh.geometry.drawRange.count)), expected, 'Packed coarse rows match the original triangle topology');
    assert.equal(detail.patch.geometry.index.count, (Math.sqrt(detail.patch.geometry.attributes.position.count) - 1) ** 2 * 6);
  }
  const retainedPatch = detail.patch; let disposedPatch = false;
  retainedPatch.geometry.addEventListener('dispose', () => { disposedPatch = true; });
  focused = [1024, 256]; detail.update(false, 0);
  const firstPending = detail.pendingSignature;
  assert.equal(detail.patch, retainedPatch); assert.equal(disposedPatch, false, 'Keep old terrain while the replacement is incomplete');
  focused = [768, 1024]; detail.update(false, 0);
  assert.notEqual(detail.pendingSignature, firstPending, 'A new location supersedes unfinished terrain work');
  detail.update(); assert.notEqual(detail.patch, retainedPatch); assert.equal(disposedPatch, true);
  viewDistance = 6000; detail.update();
  assert.deepEqual(native.mesh.geometry.index.array, original, 'Far view restores the complete base terrain');
  detail.clear(true); native.mesh.geometry.dispose(); native.terrainMaterial.dispose();

  const handlers = new Map(); let picks = 0;
  const hoverTerrain = { renderer: { domElement: { addEventListener: (name, listener) => handlers.set(name, listener) } }, active: true, ready: true, pointerStarts: new Map(),
    artilleryCameraMode: 'fly', pick: () => { picks++; return [0, 0]; }, heightAt: () => 0, callbacks: { onHover() {} } };
  TerrainView.prototype.bindPointers.call(hoverTerrain);
  const move = { pointerId: 1, clientX: 0, clientY: 0 };
  for (const mode of ['fly', 'walk', 'sight']) { hoverTerrain.artilleryCameraMode = mode; handlers.get('pointermove')(move); }
  assert.equal(picks, 0, 'Mouse look must not raycast terrain and every visible model');
  hoverTerrain.artilleryCameraMode = 'orbit'; handlers.get('pointermove')(move); assert.equal(picks, 1, 'Orbit retains hover picking');
} finally {
  if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  if (previousMatchMedia === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = previousMatchMedia;
}
geometry.dispose(); material.dispose();

const probe = createServer(); await new Promise(resolveReady => probe.listen(0, '127.0.0.1', resolveReady));
const port = probe.address().port; await new Promise(resolveClosed => probe.close(resolveClosed));
const root = resolve(import.meta.dirname, '..');
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), MAP_HOST: '127.0.0.1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  await new Promise((resolveReady, reject) => {
    let output = ''; const timeout = setTimeout(() => reject(new Error('Test server startup timed out')), 10000);
    server.stdout.on('data', chunk => { output += chunk; if (output.includes('WARDOGS local map:')) { clearTimeout(timeout); resolveReady(); } });
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error('Test server exited: ' + code)); });
  });
  const base = 'http://127.0.0.1:' + port;
  const first = await fetch(base + '/README.md'); const content = await first.text(); const etag = first.headers.get('etag');
  assert.equal(first.status, 200); assert.ok(etag);
  const compressed = await fetch(base + '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(compressed.status, 200); assert.equal(compressed.headers.get('content-encoding'), 'gzip'); assert.ok((await compressed.text()).includes('WARDOGS_MAPS'));
  const cached = await fetch(base + '/README.md', { headers: { 'If-None-Match': etag } }); assert.equal(cached.status, 304); assert.equal(await cached.text(), '');
  const stale = await fetch(base + '/README.md', { headers: { 'If-None-Match': 'W/"stale"' } }); assert.equal(stale.status, 200); assert.equal(await stale.text(), content);
  const modified = await fetch(base + '/README.md', { headers: { 'If-Modified-Since': first.headers.get('last-modified') } }); assert.equal(modified.status, 304);
  const head = await fetch(base + '/README.md', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(content));
  for (const path of ['/.local-data/server-4173.log', '/%2elocal-data/server-4173.log', '/.validation/replica-2026-10-03.json']) assert.equal((await fetch(base + path)).status, 403);
  for (const path of ['/assets%5c..%5c.validation%5csynthetic.txt', '/assets%5c..%5c.local-data%5csynthetic.txt']) assert.equal((await fetch(base + path)).status, 403, 'Encoded Windows separators must not bypass private-directory protection');
} finally {
  if (server.exitCode === null && server.signalCode === null) await new Promise(resolveExit => { server.once('exit', resolveExit); server.kill(); });
}
console.log('PASS: sliced frame budgets/sorting/normals, atomic LOD and terrain swaps, shared-material multi-draw and fallbacks, shader warmup/cancel, local collision candidates ' + localCandidates + '/2500, full-map preload/cancel/failures, navigation coverage and stable coarse/LOD budgets, cached instance uploads, exact terrain sampling/topology, no hover scans during navigation, stable auto-quality resources, gzip and HTTP conditional caching, private-directory protection');
