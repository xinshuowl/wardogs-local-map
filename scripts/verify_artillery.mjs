import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { WEAPONS } from '../artillery-data.js';
import * as THREE from '../vendor/three/three.module.js';
import { ArtilleryNavigation } from '../artillery-navigation.js';
import { ArtilleryScene } from '../artillery-scene.js';
import { TerrainView } from '../terrain-view.js';
import { solveWeapon, solveCannon, gameToMap, mapToGame, firingVector, correctedTarget, createTrajectory } from '../artillery-ballistics.js';
import { validArtilleryState } from '../artillery.js';

export async function verifyArtillery() {
  const root = resolve(import.meta.dirname, '..');
  const fixtures = JSON.parse(await readFile(resolve(root, 'scripts/artillery-reference-fixtures.json'), 'utf8'));
  const maps = JSON.parse((await readFile(resolve(root, 'map-data.js'), 'utf8')).replace(/^window.WARDOGS_MAPS = /, '').trim().replace(/;$/, ''));
  let checked = 0;
  for (const fixture of fixtures.cannon) {
    const actual = solveCannon(fixture.range, fixture.startingHeight);
    assert.equal(actual.length, fixture.shots.length, 'Cannon arc availability');
    for (let index = 0; index < actual.length; index++) {
      assert.equal(actual[index].arc, fixture.shots[index].arc);
      assert.ok(Math.abs(actual[index].mils - fixture.shots[index].mils) < .001, 'Cannon game mils mismatch');
      assert.ok(Math.abs(actual[index].time - fixture.shots[index].time) < .001, 'Cannon flight time mismatch');
    }
    checked++;
  }
  const mortar = WEAPONS.find(weapon => weapon.id === 'l81-mortar');
  for (const [rawMils, range, time] of mortar.rangeTable) {
    const actual = solveWeapon(mortar.id, range).selected;
    assert.equal(actual.mils, rawMils + 650, 'Mortar game display offset');
    assert.equal(actual.time, time, 'Mortar table flight time');
  }
  assert.equal(solveWeapon(mortar.id, 323).selected.mils, 667);
  assert.equal(solveWeapon(mortar.id, 340).selected.mils, 650);
  assert.equal(solveWeapon(mortar.id, 79).status, 'too-close');
  assert.equal(solveWeapon(mortar.id, 685).status, 'too-far');
  assert.equal(solveWeapon('l52-cannon', 323).shots.length, 0);
  assert.equal(solveWeapon('l52-cannon', 2000).selected.mils.toFixed(0), '250');
  assert.equal(solveWeapon('l52-cannon', 2000, -21).corrected.mils.toFixed(0), '262');
  assert.equal(solveWeapon('l52-cannon', 2000, 4.9).corrected, null);
  assert.equal(solveWeapon(mortar.id, 340, 70).corrected, null, 'Mortar must not use cannon correction');
  assert.throws(() => solveWeapon(mortar.id, NaN));
  assert.throws(() => solveWeapon('unknown', 340));
  for (const map of Object.values(maps)) {
    for (const coordinates of [{ x: 77.09, y: 69.95 }, { x: 0, y: 0 }, { x: map.bounds[2] / 10000, y: map.bounds[2] / 10000 }]) {
      const result = mapToGame(map, gameToMap(map, coordinates));
      assert.ok(Math.abs(result.x - coordinates.x) < 1e-9 && Math.abs(result.y - coordinates.y) < 1e-9, 'Game coordinate round trip');
    }
    const gun = gameToMap(map, { x: 77.09, y: 69.95 });
    const target = gameToMap(map, { x: 97.09, y: 69.95 });
    const vector = firingVector(map, gun, target);
    assert.ok(Math.abs(vector.range - 2000) < 1e-8);
    assert.ok(Math.abs(vector.bearing - 90) < 1e-8);
    assert.equal(Math.round(vector.bearingMils), 1571, 'Reference uses radians × 1000, not NATO mils');
    const corrected = mapToGame(map, correctedTarget(map, gun, target, 100, 25));
    assert.ok(Math.abs(corrected.x - 98.09) < 1e-8 && Math.abs(corrected.y - 69.7) < 1e-8, 'Observer corrections are relative to gun bearing');
    const north = firingVector(map, gun, gameToMap(map, { x: 77.09, y: 79.95 }));
    assert.ok(Math.abs(north.bearing) < 1e-8);
    assert.throws(() => gameToMap(map, { x: -1, y: 0 }));
    assert.throws(() => correctedTarget(map, gun, [2048, 2048], 1000000, 1000000));
    for (const identifier of ['l81-mortar', 'l52-cannon']) {
      const solution = solveWeapon(identifier, identifier === mortar.id ? 340 : 2000).selected;
      const trajectory = createTrajectory(identifier, solution, gun, target, 30, 5);
      assert.equal(trajectory.length, 129);
      assert.equal(trajectory[0][2], 30);
      assert.equal(trajectory.at(-1)[2], 5);
      assert.deepEqual(trajectory[0].slice(0, 2), gun);
      assert.deepEqual(trajectory.at(-1).slice(0, 2), target);
      assert.ok(trajectory.every(point => point.every(Number.isFinite)), 'Finite trajectory');
      assert.ok(Math.max(...trajectory.map(point => point[2])) > 30);
    }
  }
  const valid = { weapon: mortar.id, arc: 'low', points: [[100, 200], [300, 400]], overrides: [null, 30] };
  assert.ok(validArtilleryState(valid));
  for (const invalid of [{ ...valid, points: [[-1, 10], [20, 30]] }, { ...valid, weapon: 'unknown' }, { ...valid, overrides: [Infinity, 0] }, { ...valid, arc: 'invalid' }, { ...valid, arcPinned: 'yes' }, { ...valid, correction: { add: Infinity, right: 0 } }, { ...valid, step: 11 }]) assert.ok(!validArtilleryState(invalid));
  const navigation = Object.create(ArtilleryNavigation.prototype);
  navigation.keys = new Set(['KeyW']);
  navigation.mode = 'walk'; navigation.lastTime = 0;
  navigation.feet = 8; navigation.velocity = 0; navigation.grounded = true; navigation.jumpHeld = false;
  navigation.terrain = { ready: true, map: { id: 'bakurani', bounds: [0, 0, 204800] }, settings: { collision: false }, props: { colliders: [] }, renderer: { domElement: { dataset: {} } }, camera: new THREE.PerspectiveCamera(), metresToWorld: 1, controls: { target: new THREE.Vector3() }, surfacePoint: () => new THREE.Vector3(0, 8, 0) };
  assert.ok(navigation.update(100));
  assert.equal(navigation.terrain.camera.position.y, 9.7, 'Walk follows local ground height');
  assert.ok(navigation.terrain.camera.position.z < 0, 'Walk moves forward');
  navigation.keys = new Set(['Space']);
  const walkAltitude = navigation.terrain.camera.position.y;
  navigation.update(125);
  assert.ok(navigation.terrain.camera.position.y > walkAltitude, 'Walk jumps above its support surface');
  navigation.keys.clear();
  for (let frame = 0; frame < 120; frame++) navigation.update(150 + frame * 16);
  assert.equal(navigation.grounded, true, 'Walk lands under gravity');
  assert.equal(navigation.terrain.camera.position.y, 9.7, 'Jump lands on the support surface');
  navigation.lastTime = 0;
  navigation.mode = 'fly'; navigation.keys = new Set(['Space']);
  const altitude = navigation.terrain.camera.position.y;
  navigation.update(150);
  assert.ok(navigation.terrain.camera.position.y > altitude, 'Fly rises with Space');
  navigation.keys = new Set(['KeyD']); navigation.terrain.camera.position.x = 1024;
  navigation.update(200);
  assert.equal(navigation.terrain.camera.position.x, 1024, 'Navigation stays within map bounds');
  navigation.keys.clear();
  assert.equal(navigation.update(250), false, 'Idle navigation does not render continuously');
  navigation.queuedKeys = new Set(['KeyW']);
  const previousDepth = navigation.terrain.camera.position.z;
  assert.equal(navigation.update(300), true, 'Short key or touch tap must survive release before render');
  assert.ok(navigation.terrain.camera.position.z < previousDepth);
  assert.equal(navigation.update(350), false, 'Tap pulse is consumed once');
  const roofNavigation = Object.create(ArtilleryNavigation.prototype);
  roofNavigation.raycaster = new THREE.Raycaster();
  const roof = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4), new THREE.MeshBasicMaterial()); roof.position.y = 3; roof.updateMatrixWorld();
  roofNavigation.terrain = { metresToWorld: 1, settings: { collision: true }, props: { colliders: [roof] }, surfacePoint: () => new THREE.Vector3(0, 0, 0) };
  assert.equal(roofNavigation.supportHeight(0, 0, 4), 4, 'Loaded geometry supports walking on roofs');
  assert.equal(roofNavigation.supportHeight(10, 0, 4), 0, 'Outside the roof, support falls back to terrain');
  roof.geometry.dispose(); roof.material.dispose();
  const scene = Object.create(ArtilleryScene.prototype);
  const camera = new THREE.PerspectiveCamera(48, 1, 1, 18000); camera.position.set(5, 10, 20);
  const originalPosition = camera.position.clone();
  scene.terrain = { camera, heightBaseline: 0, heightFactor: 1, metresToWorld: 1, active: true, ready: true, surfacePoint: () => new THREE.Vector3(), controls: { target: new THREE.Vector3(), minDistance: 4, maxDistance: 7000, maxPolarAngle: 1.4, update() {} }, renderer: { domElement: { dataset: {} } }, performance: { previousCamera: new THREE.Vector3() }, invalidate() {} };
  scene.navigation = { stop() {} };
  const cannonPivot = new THREE.Group(); const mortarBarrel = new THREE.Group();
  scene.pitchNodes = [{ object: cannonPivot, axis: 'z', sign: 1 }, { object: mortarBarrel, axis: 'x', sign: -1 }];
  scene.metadata = { selected: { rawMils: 250 }, corrected: { rawMils: 262 } }; scene.updatePitch();
  assert.equal(cannonPivot.rotation.z, .262); assert.equal(mortarBarrel.rotation.x, -.262);
  scene.metadata = { selected: { rawMils: 700 } }; scene.updatePitch(); assert.equal(mortarBarrel.rotation.x, -.7);
  scene.metadata = { gun: [1024, 1024], target: [1030, 1020], originHeight: 0, targetHeight: 5 };
  scene.markerGroup = new THREE.Group();
  const gunMarker = new THREE.Group(); gunMarker.userData.artilleryMarker = 'gun';
  const targetMarker = new THREE.Group(); targetMarker.userData.artilleryMarker = 'target';
  scene.markerGroup.add(gunMarker, targetMarker);
  scene.setCamera('gun');
  assert.equal(gunMarker.visible, false, 'Gun marker must not hide the nearby weapon');
  assert.equal(targetMarker.visible, true);
  TerrainView.prototype.focus.call(scene.terrain, [1024, 1024], .5, true);
  assert.ok(Math.abs(camera.position.distanceTo(scene.terrain.controls.target) - .5) < 1e-9, 'Near gun zoom must honor the active minimum distance');
  scene.setCamera('target');
  assert.equal(targetMarker.visible, false);
  scene.setCamera('sight');
  assert.equal(scene.markerGroup.visible, false, 'Sight must not be obstructed by marker poles');
  assert.equal(scene.terrain.controls.enabled, false, 'Sight locks orbit controls');
  assert.equal(scene.terrain.camera.fov, 30);
  assert.ok(scene.terrain.controls.minDistance < 1, 'Sight must not be clamped to far orbit distance');
  const expectedDirection = scene.terrain.controls.target.clone().sub(camera.position).normalize();
  assert.ok(expectedDirection.dot(camera.getWorldDirection(new THREE.Vector3())) > .99999, 'Sight points at the target');
  scene.setCamera('orbit');
  assert.ok(camera.position.distanceTo(originalPosition) < 1e-9, 'Orbit restores previous camera');
  assert.equal(scene.terrain.controls.minDistance, 4);
  assert.equal(scene.terrain.controls.maxPolarAngle, 1.4);
  console.log('PASS: ' + checked + ' reference cannon fixtures, 17 mortar table rows, game mils, terrain correction, coordinate bounds, observer corrections, trajectory endpoints saved-state validation, Fly/Walk navigation and sight camera restore');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyArtillery();
