import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import * as THREE from '../vendor/three/three.module.js';
import { mirroredGeometry, splitMirroredInstances } from '../model-geometry.js';
import { drainWork } from '../frame-work.js';
import { PropView } from '../prop-view.js';
import { resolveModelMaterial } from '../model-materials.js';

const vertex = new THREE.Vector3(); const normal = new THREE.Vector3(); const first = new THREE.Vector3(); const second = new THREE.Vector3(); const third = new THREE.Vector3();
{
  const prototypes = new Map([[0, [{ geometry: new THREE.BoxGeometry() }, { geometry: new THREE.PlaneGeometry() }]]]);
  const data = new Float32Array([0, 0, 0, 0, 0, 0, 1, -1, 1, 1, 0]);
  const grouped = new Map([[0, [{ data, offset: 0 }]]]);
  const interrupted = splitMirroredInstances(grouped, prototypes); interrupted.next();
  assert.equal(prototypes.get('0:2:mirror').length, 1, 'Track staged geometry so map reset can release it');
  drainWork(splitMirroredInstances(grouped, prototypes));
  assert.equal(prototypes.get('0:2:mirror').length, 2, 'A replacement update finishes previously interrupted multipart geometry');
  for (const parts of prototypes.values()) for (const part of parts) part.geometry.dispose();
}
for (const indexed of [true, false]) {
  const original = new THREE.BoxGeometry(2, 3, 4).translate(1, 2, -1);
  const geometry = indexed ? original : original.toNonIndexed();
  const mirrored = mirroredGeometry(geometry);
  const transform = new THREE.Matrix4().compose(new THREE.Vector3(5, 3, -9), new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, .7, -.2)), new THREE.Vector3(-2, .7, 1.2));
  const corrected = transform.clone().multiply(new THREE.Matrix4().makeScale(-1, 1, 1));
  const originalNormal = new THREE.Matrix3().getNormalMatrix(transform); const correctedNormal = new THREE.Matrix3().getNormalMatrix(corrected);
  for (let index = 0; index < geometry.attributes.position.count; index++) {
    vertex.fromBufferAttribute(geometry.attributes.position, index).applyMatrix4(transform);
    first.fromBufferAttribute(mirrored.attributes.position, index).applyMatrix4(corrected);
    assert.ok(vertex.distanceTo(first) < 1e-6, 'Mirrored geometry retains exact world placement');
    normal.fromBufferAttribute(geometry.attributes.normal, index).applyMatrix3(originalNormal).normalize();
    second.fromBufferAttribute(mirrored.attributes.normal, index).applyMatrix3(correctedNormal).normalize();
    assert.ok(normal.distanceTo(second) < 1e-6, 'Mirrored normals retain outward direction');
  }
  for (let offset = 0; offset < mirrored.index.count; offset += 3) {
    first.fromBufferAttribute(mirrored.attributes.position, mirrored.index.getX(offset));
    second.fromBufferAttribute(mirrored.attributes.position, mirrored.index.getX(offset + 1));
    third.fromBufferAttribute(mirrored.attributes.position, mirrored.index.getX(offset + 2));
    normal.fromBufferAttribute(mirrored.attributes.normal, mirrored.index.getX(offset));
    assert.ok(second.sub(first).cross(third.sub(first)).dot(normal) > 0, 'Triangle winding agrees with outward normal');
  }
  mirrored.dispose(); geometry.dispose(); if (!indexed) original.dispose();
}

for (const multiDraw of [false, true]) {
  const terrain = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), metresToWorld: 1, renderer: { domElement: { dataset: {} }, extensions: { has: () => multiDraw } }, invalidate() {}, artilleryCameraMode: 'walk' };
  const props = new PropView(terrain); const material = new THREE.MeshStandardMaterial();
  props.group.visible = true;
  props.manifest = { meshes: [{ name: 'mirrored building', type: 'buildings', solid: true }], materials: {} };
  props.prototypes.set(0, [{ geometry: new THREE.BoxGeometry(2, 2, 2), material, triangles: 12 }]);
  props.prototypes.set('0:0', [{ geometry: new THREE.BoxGeometry(2, 2, 2), material, triangles: 12 }]);
  const data = new Float32Array([0, 0, -6, 0, 0, 0, 1, 1, 1, 1, 0, 4, 0, -6, 0, 0, 0, 1, -1, 1, 1, 0]);
  const selection = [{ data, offset: 0 }, { data, offset: 11 }];
  props.updateBatches(new Map([[0, selection]]));
  const mirror = props.batches.get('0:2:mirror')[0];
  assert.equal(props.batches.get(0)[0].count, 1); assert.equal(mirror.count, 1);
  const matrix = new THREE.Matrix4(); mirror.getMatrixAt(0, matrix);
  assert.ok(matrix.determinant() > 0, 'No negative determinant reaches instanced GPU transforms');
  assert.equal(props.colliders.length, 2);
  const ray = new THREE.Raycaster(new THREE.Vector3(4, 0, 0), new THREE.Vector3(0, 0, -1), 0, 20);
  assert.equal(props.pick(ray)?.distance, 5, 'Mirrored front surfaces remain pickable');
  assert.equal(props.colliderIndex.intersect(ray)[0]?.distance, 5, 'Mirrored collision matches rendered geometry');
  if (multiDraw) {
    const entry = props.drawBatches.records.get(mirror).instances[0];
    entry.pool.mesh.getMatrixAt(entry.id, matrix); assert.ok(matrix.determinant() > 0);
  }
  const version = mirror.instanceMatrix.version;
  props.updateBatches(new Map([[0, selection]])); assert.equal(mirror.instanceMatrix.version, version);
  props.updateBatches(new Map([['0:0', selection]]));
  assert.equal(mirror.visible, false); assert.equal(props.batches.get('0:0:mirror')[0].count, 1);
  props.updateBatches(new Map([[0, selection]])); assert.equal(props.batches.get('0:2:mirror')[0], mirror);
  let disposed = 0; props.prototypes.get('0:2:mirror')[0].geometry.addEventListener('dispose', () => disposed++);
  props.reset(); assert.equal(disposed, 1); material.dispose();
}

const repairs = JSON.parse(await readFile(new URL('../assets/material-surfaces/dark-surface-repairs.json', import.meta.url), 'utf8'));
for (const map of ['bakurani', 'ozeti', 'zestafona']) {
  const manifest = JSON.parse(await readFile(new URL('../assets/models/' + map + '/manifest.json', import.meta.url), 'utf8'));
  let repaired = 0;
  for (const [name, source] of Object.entries(manifest.materials)) {
    const material = resolveModelMaterial(name, source, manifest.materials);
    if (repairs[source.baseColor]) {
      assert.equal(material.baseColor, '@' + repairs[source.baseColor].replacement);
      assert.equal(material.normal, source.normal); assert.deepEqual(material.repeat, source.repeat);
      assert.equal(material.colorGain, 1, 'Reconstructed base colors must not receive the old global gain');
      await access(new URL('../assets/material-surfaces/' + material.baseColor.slice(1), import.meta.url)); repaired++;
    } else if (source.baseColor === 'b7cceb6cf4fe7597.webp') {
      assert.equal(material.baseColor, null); assert.deepEqual(material.color, source.color); repaired++;
    } else if (source.baseColor && name !== 'MI_Dumpster_01_Decals') assert.equal(material.baseColor, source.baseColor, name + ': unrelated dark atlases remain unchanged');
  }
  console.log('PASS: ' + map + ', ' + Object.keys(manifest.materials).length + ' materials audited, ' + repaired + ' known dark entries repaired');
}
console.log('PASS: indexed/non-indexed mirror winding, normals, instanced/multi-draw parity, picking, collision, LOD reuse and disposal');
