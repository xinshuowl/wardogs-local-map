import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/three/meshopt_decoder.module.js';
import * as THREE from '../vendor/three/three.module.js';
import { TerrainView } from '../terrain-view.js';
import { TerrainDetail } from '../terrain-detail.js';
import { verifyArtillery } from './verify_artillery.mjs';
import { PropView } from '../prop-view.js';
import { ScenePerformance } from '../scene-performance.js';

const root = resolve(import.meta.dirname, '..');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const maps = JSON.parse((await readFile(resolve(root, 'map-data.js'), 'utf8')).replace(/^window.WARDOGS_MAPS = /, '').trim().replace(/;$/, ''));
const heights = JSON.parse(await readFile(resolve(root, 'assets/terrain/manifest.json'), 'utf8'));
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
await MeshoptDecoder.ready;
globalThis.matchMedia = () => ({ matches: false });
const summary = [];
for (const mapId of ['bakurani', 'ozeti', 'zestafona']) {
  const base = resolve(root, 'assets/models', mapId);
  const manifest = JSON.parse(await readFile(resolve(base, 'manifest.json'), 'utf8'));
  const counts = { buildings: 0, trees: 0, props: 0 };
  let files = 0;
  let geometryFiles = 0;
  let primitives = 0;
  for (const tile of manifest.tiles) {
    const data = await readFile(resolve(base, tile.file));
    assert(data.length === tile.bytes && digest(data) === tile.sha256, mapId + ': corrupt tile ' + tile.file);
    const groups = data.readUInt32LE(0);
    let offset = 4 + groups * 8;
    for (let index = 0; index < groups; index++) {
      const identifier = data.readUInt32LE(4 + index * 8);
      const instances = data.readUInt32LE(8 + index * 8);
      assert(manifest.meshes[identifier] && offset + instances * 44 <= data.length, 'Invalid model group');
      counts[manifest.meshes[identifier].type] += instances;
      for (let byte = offset; byte < offset + instances * 44; byte += 4) assert(Number.isFinite(data.readFloatLE(byte)), 'Non-finite transform');
      offset += instances * 44;
    }
    assert(offset === data.length, 'Unexpected tile suffix');
    files++;
  }
  for (const category of Object.keys(counts)) assert(counts[category] === manifest.counts[category], 'Model count mismatch');
  for (const bundle of manifest.bundles) {
    for (const [lod, resource] of Object.entries(bundle.lods || { 2: bundle })) {
      const buffer = await readFile(resolve(base, resource.file));
      assert(buffer.length === resource.bytes && digest(buffer) === resource.sha256, 'Corrupt GLB ' + resource.file);
      assert(buffer.readUInt32LE(0) === 0x46546c67 && buffer.readUInt32LE(8) === buffer.length, 'Invalid GLB header');
      if (!process.argv.includes('--quick')) {
        const gltf = await loader.parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), base + '/');
        const found = new Set();
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse(object => {
          if (!object.isMesh) return;
          for (let ancestor = object; ancestor; ancestor = ancestor.parent) { const match = /^m(\d+)$/.exec(ancestor.name); if (match) { found.add(Number(match[1])); break; } }
          for (const coordinate of object.geometry.attributes.position.array) assert(Number.isFinite(coordinate), 'Non-finite LOD' + lod + ' vertex');
          object.geometry.dispose();
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
          primitives++;
        });
        for (const identifier of bundle.meshes) assert(found.has(identifier), 'LOD' + lod + ' missing model ' + identifier);
      }
      geometryFiles++;
      global.gc?.();
    }
  }
  const terrain = Object.create(TerrainView.prototype);
  Object.assign(terrain, { map: maps[mapId], descriptor: heights[mapId], heightFactor: 1, renderProfile: 'high', ready: true, scene: new THREE.Scene(), renderer: { shadowMap: {}, domElement: { dataset: {} } }, controls: { getDistance: () => 45 }, terrainMaterial: new THREE.MeshStandardMaterial() });
  terrain.metresToWorld = 2048 / (terrain.map.bounds[2] / 100);
  terrain.heightBaseline = terrain.descriptor.minimumMetres;
  const heightBuffer = await readFile(resolve(root, terrain.descriptor.file));
  terrain.heights = new Uint16Array(heightBuffer.length / 2);
  for (let index = 0; index < terrain.heights.length; index++) terrain.heights[index] = heightBuffer.readUInt16LE(index * 2);
  terrain.targetPosition = () => terrain.map.center;
  terrain.detail = new TerrainDetail(terrain);
  terrain.mesh = new THREE.Mesh(terrain.createGeometry(), terrain.terrainMaterial);
  const originalIndices = terrain.mesh.geometry.index.count;
  terrain.detail.update();
  assert(terrain.detail.patch && terrain.detail.patch.geometry.attributes.position.count > 1000, 'Missing native-resolution terrain patch');
  assert(terrain.mesh.geometry.drawRange.count < originalIndices, 'Coarse terrain not removed beneath detail patch');
  for (const coordinate of terrain.detail.patch.geometry.attributes.position.array) assert(Number.isFinite(coordinate), 'Non-finite detailed terrain');
  const normal = terrain.detail.patch.geometry.attributes.normal;
  for (let index = 0; index < normal.count; index++) assert(normal.getY(index) > 0, 'Downward terrain normal');
  terrain.detail.clear();
  terrain.mesh.geometry.dispose();
  terrain.terrainMaterial.dispose();
  summary.push({ map: mapId, positionFiles: files, geometryFiles, decodedPrimitives: primitives, components: counts, textureMaximum: manifest.maximumTextureSize, nativeTerrainSample: terrain.descriptor.sampleMetres });
  console.log(JSON.stringify(summary.at(-1)));
}
await verifyArtillery();
const artilleryManifest = JSON.parse(await readFile(resolve(root, 'assets/artillery/manifest.json'), 'utf8'));
for (const [filename, resource] of Object.entries(artilleryManifest.resources)) {
  const buffer = await readFile(resolve(root, 'assets/artillery', filename));
  assert(buffer.length === resource.bytes && digest(buffer) === resource.sha256, 'Corrupt artillery model ' + filename);
  const gltf = await loader.parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '');
  gltf.scene.traverse(object => { if (object.isMesh) { for (const coordinate of object.geometry.attributes.position.array) assert(Number.isFinite(coordinate), 'Invalid artillery vertex'); object.geometry.dispose(); for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose(); } });
}
const picking = Object.create(PropView.prototype);
picking.group = new THREE.Group();
picking.group.position.set(2, 0, 0);
picking.group.scale.setScalar(2);
picking.pickBounds = new Map();
const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const boxMaterial = new THREE.MeshBasicMaterial();
const instances = new THREE.InstancedMesh(boxGeometry, boxMaterial, 2);
instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, -3));
instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, -6));
picking.group.add(instances);
picking.group.updateMatrixWorld(true);
picking.batches = new Map([[7, [instances]]]);
const pickingRay = new THREE.Raycaster(new THREE.Vector3(2, 0, 0), new THREE.Vector3(0, 0, -1));
const picked = picking.pick(pickingRay);
assert(picked?.instanceId === 0 && Math.abs(picked.distance - 5) < 1e-7, 'Incorrect nearest model instance or transformed bounds');
pickingRay.far = 4;
assert(picking.pick(pickingRay) === null, 'Model picking ignores ray distance');
pickingRay.far = Infinity;
instances.visible = false;
assert(picking.pick(pickingRay) === null, 'Invisible batch is selectable');
instances.visible = true;
boxMaterial.visible = false;
assert(picking.pick(pickingRay) === null, 'Invisible material is selectable');
boxMaterial.visible = true;
picking.group.visible = false;
assert(picking.pick(pickingRay) === null, 'Disabled model layers are selectable');

const collision = Object.create(ScenePerformance.prototype);
collision.samples = [];
collision.lastFrame = 0;
collision.lastDisplay = 100;
collision.settings = { quality: 'balanced', collision: true };
collision.previousCamera = new THREE.Vector3(-2, 0, 0);
collision.raycaster = new THREE.Raycaster();
collision.benchmark = null;
const collisionCamera = new THREE.PerspectiveCamera();
collisionCamera.position.set(2, 0, 0);
const wall = new THREE.Mesh(boxGeometry, boxMaterial);
wall.updateMatrixWorld(true);
collision.terrain = { camera: collisionCamera, props: { colliders: [wall], statusStamp: '' }, controls: { target: new THREE.Vector3(), getDistance: () => 2 }, renderer: { shadowMap: { enabled: false } } };
collision.update(100);
assert(Math.abs(collisionCamera.position.x + .8) < 1e-7, 'Camera passes through visible building geometry');
collision.settings.collision = false;
collisionCamera.position.set(2, 0, 0);
collision.update(110);
assert(collisionCamera.position.x === 2, 'Disabled collision still blocks camera');
instances.dispose();
boxGeometry.dispose();
boxMaterial.dispose();
console.log('PASS: resource hashes, all available LODs, native terrain patches, model picking, building collision, real artillery GLBs and reference game firing solutions');
