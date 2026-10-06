import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../vendor/three/three.module.js';
import { shadowFrame, terrainDepthMaterial, applySceneShadows } from '../scene-shadows.js';
import { ScenePerformance } from '../scene-performance.js';
import { TerrainEnvironment, temperatureColor } from '../terrain-environment.js';
import { ArtilleryScene } from '../artillery-scene.js';
import { fogRange, skyColors } from '../scene-atmosphere.js';
import { resolveModelMaterial } from '../model-materials.js';
import { PropView } from '../prop-view.js';
import { access } from 'node:fs/promises';

const records = JSON.parse(await readFile(new URL('../assets/scene-manifest.json', import.meta.url), 'utf8'));
let passed = 0;

function check(name, action) {
  action();
  passed++;
  console.log('PASS: ' + name);
}

function terrainFor(factor = 2048 / 16328) {
  const terrain = {
    metresToWorld: factor, renderProfile: 'balanced', artilleryCameraMode: 'walk',
    camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3(), getDistance: () => 12 * factor },
    descriptor: { minimumMetres: -1000, maximumMetres: 200 },
    scene: new THREE.Scene(), sun: new THREE.DirectionalLight(), hemisphere: new THREE.HemisphereLight(),
    sunDirection: new THREE.Vector3(-.1, .7, .7).normalize(),
    renderer: { domElement: { dataset: {} }, shadowMap: { enabled: true, needsUpdate: false } },
    props: { statusStamp: 'loaded' }, invalidations: 0, invalidate() { this.invalidations++; }
  };
  terrain.scene.add(terrain.sun);
  return terrain;
}

check('shadow offsets use game metres across map scales', () => {
  for (const factor of [1, .125, 2]) {
    const frame = shadowFrame(terrainFor(factor));
    assert.ok(Math.abs(frame.normalBias / factor - .16) < 1e-9);
    assert.ok(Math.abs(frame.bias * (frame.far - frame.near) / factor + .04) < 1e-9);
    assert.equal(frame.extent / factor, 120);
    assert.ok(frame.texelMetres < .25);
  }
});

check('closeup and navigation shadows retain detail when orbit distance changes', () => {
  const terrain = terrainFor();
  for (const mode of ['fly', 'walk', 'gun', 'target', 'sight']) {
    terrain.artilleryCameraMode = mode;
    terrain.controls.getDistance = () => 300;
    assert.equal(shadowFrame(terrain).extentMetres, 120);
  }
  terrain.artilleryCameraMode = 'orbit';
  assert.equal(shadowFrame(terrain).extentMetres, 1200);
  terrain.renderProfile = 'high';
  assert.equal(shadowFrame(terrain).resolution, 2048);
});

check('sub-texel camera panning does not crawl the shadow projection', () => {
  const terrain = terrainFor(1);
  terrain.artilleryCameraMode = 'orbit';
  const before = shadowFrame(terrain);
  const horizontal = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), terrain.sunDirection).normalize();
  terrain.controls.target.addScaledVector(horizontal, before.texelMetres * .2);
  const after = shadowFrame(terrain);
  assert.ok(Math.abs(before.target.dot(horizontal) - after.target.dot(horizontal)) < 1e-9);
  terrain.controls.target.addScaledVector(horizontal, before.texelMetres);
  const crossed = shadowFrame(terrain);
  assert.ok(Math.abs(crossed.target.clone().sub(before.target).dot(horizontal) - before.texelMetres) < 1e-9);
});

check('throttled shadows apply the final camera movement without another input event', () => {
  const terrain = terrainFor();
  const performance = Object.create(ScenePerformance.prototype);
  performance.terrain = terrain;
  performance.updateShadows(1000);
  const oldTarget = terrain.sun.target.position.clone();
  terrain.camera.position.x += 5;
  terrain.renderer.shadowMap.needsUpdate = false;
  performance.updateShadows(1050);
  assert.ok(terrain.invalidations > 0);
  assert.ok(terrain.sun.target.position.equals(oldTarget));
  performance.updateShadows(1101);
  assert.ok(!terrain.sun.target.position.equals(oldTarget));
  assert.equal(terrain.renderer.shadowMap.needsUpdate, true);
  terrain.renderer.shadowMap.needsUpdate = false;
  performance.updateShadows(1300);
  assert.equal(terrain.renderer.shadowMap.needsUpdate, false);
  terrain.props.statusStamp = 'background preload progressed';
  performance.updateShadows(1500);
  assert.equal(terrain.renderer.shadowMap.needsUpdate, false);
});

check('late caster or weapon changes refresh shadows while the camera stays still', () => {
  const terrain = terrainFor();
  const performance = Object.create(ScenePerformance.prototype);
  performance.terrain = terrain;
  performance.updateShadows(1000);
  terrain.renderer.shadowMap.needsUpdate = false;
  terrain.shadowRevision = 1;
  performance.updateShadows(1200);
  assert.equal(terrain.renderer.shadowMap.needsUpdate, true);
  terrain.renderer.shadowMap.enabled = false;
  terrain.renderer.shadowMap.needsUpdate = false;
  terrain.shadowRevision++;
  performance.updateShadows(1400);
  assert.equal(terrain.renderer.shadowMap.needsUpdate, false);
  assert.equal(terrain.renderer.domElement.dataset.shadows, 'off');
});

check('all three skies preserve their sun direction after moving the target', () => {
  const terrain = terrainFor();
  const environment = new TerrainEnvironment(terrain);
  for (const record of Object.values(records)) {
    terrain.controls.target.set(500, 50, -700);
    environment.skyFor(record.sky);
    const actual = terrain.sun.position.clone().sub(terrain.sun.target.position).normalize();
    assert.ok(actual.distanceTo(terrain.sunDirection) < 1e-9);
    assert.ok(actual.y > 0);
    assert.ok(terrain.sun.target.parent === terrain.scene);
    assert.ok(terrain.hemisphere.intensity > record.sky.skyLightIntensity);
    assert.equal(environment.sky.colorSpace, THREE.LinearSRGBColorSpace);
    assert.equal(terrain.scene.background, environment.sky);
    assert.ok(terrain.scene.fog.color.equals(skyColors(record.sky).horizon));
    let disposed = 0;
    environment.sky.addEventListener('dispose', () => disposed++);
    environment.clear();
    assert.equal(disposed, 1);
    assert.equal(terrain.scene.background, null);
    assert.equal(terrain.scene.environment, null);
  }
});

check('all maps remain visible at overview and maximum orbit distance', () => {
  for (const record of Object.values(records)) for (const factor of [.125, 1]) {
    const terrain = terrainFor(factor);
    for (const distance of [12, 1500 / Math.tan(24 * Math.PI / 180) / factor, 7000 / factor]) {
      terrain.controls.getDistance = () => distance * factor;
      const range = fogRange(record.sky.fog, terrain);
      assert.equal(range.near / factor, 1750);
      const farthestSurface = (distance + 16328) * factor;
      assert.ok(farthestSurface < range.far * .7, 'Whole-map surfaces must not reach opaque fog');
    }
  }
});

check('high flight shadows stay on the ground and distant coverage extends beyond the near map', () => {
  const terrain = terrainFor(1);
  terrain.ready = true; terrain.surfacePoint = () => new THREE.Vector3(0, 20, 0);
  terrain.camera.position.set(0, 620, 0);
  const near = shadowFrame(terrain); const far = shadowFrame(terrain, true);
  assert.ok(near.extentMetres >= 600);
  assert.ok(Math.abs(near.target.y - 20) < near.texelMetres * 2);
  assert.ok(far.extentMetres >= near.extentMetres * 3);
  terrain.artilleryCameraMode = 'orbit';
  for (const distance of [120, 797, 3000, 16000]) {
    terrain.controls.getDistance = () => distance;
    assert.ok(shadowFrame(terrain, true).extentMetres >= shadowFrame(terrain).extentMetres * 3, 'Orbit retains a larger distant layer at every zoom');
  }
});

check('distant shadow throttling eventually applies the final caster change', () => {
  const terrain = terrainFor(); terrain.distantSun = new THREE.DirectionalLight('#fff', 0);
  const performance = Object.create(ScenePerformance.prototype); performance.terrain = terrain;
  performance.updateShadows(1000); const before = performance.distantShadowStamp;
  terrain.shadowRevision = 5; performance.updateShadows(1100);
  assert.equal(performance.distantShadowStamp, before);
  performance.updateShadows(1401); assert.notEqual(performance.distantShadowStamp, before);
  assert.equal(terrain.renderer.domElement.dataset.shadows, 'cascaded');
  const shader = { fragmentShader: '#include <lights_fragment_begin>' };
  const material = applySceneShadows(new THREE.MeshStandardMaterial()); material.onBeforeCompile(shader);
  assert.ok(shader.fragmentShader.includes('mix(farShade, nearShade, nearWeight)'));
  assert.ok(shader.fragmentShader.includes('smoothstep(0.78, 0.98, farEdge)'));
  material.dispose();
});

for (const map of ['bakurani', 'ozeti', 'zestafona']) {
  const manifest = JSON.parse(await readFile(new URL('../assets/models/' + map + '/manifest.json', import.meta.url), 'utf8'));
  const resolved = Object.entries(manifest.materials).map(([name, source]) => ({ name, source, material: resolveModelMaterial(name, source, manifest.materials) }));
  for (const { material } of resolved) {
    for (const field of ['baseColor', 'normal']) if (material[field]) {
      const path = material[field].startsWith('@') ? '../assets/material-surfaces/' + material[field].slice(1) : '../assets/models/' + map + '/textures/' + material[field];
      await access(new URL(path, import.meta.url));
    }
  }
  check(map + ' materials resolve missing surfaces, glass opacity and cutout decals', () => {
    for (const { name, source, material } of resolved) {
      assert.ok(material.baseColor || material.color, name + ' has no replacement');
      if (!source.baseColor && !source.color) assert.ok(material.replacement, name + ' must identify its replacement');
      if (source.blend === 'translucent' && /Glass/i.test(name)) { assert.ok(material.opacity < 1); assert.equal(material.castShadow, false); }
      if (name === 'MI_Dumpster_01_Decals') { assert.equal(material.transparent, false); assert.equal(material.opacity, 1); assert.equal(material.alpha, true); }
    }
    const wire = resolved.find(item => item.name === 'MI_ChainLinkFence01a_Wire');
    assert.equal(wire.material.alpha, true);
    assert.ok(wire.material.metalness > .5);
  });
  check(map + ' cloth and mixed surfaces retain diffuse lighting', () => {
    for (const name of ['MI_MetalStallDesk_Tarp_01b', 'MI_PickUp_IZH_Atlas_Wood_Chrome', 'MI_LC_Corrugated_Metal_WPO_01a']) {
      const item = resolved.find(candidate => candidate.name === name);
      assert.ok(item, name + ' is present in the real map');
      assert.equal(item.material.metalness, 0, name);
      assert.ok(item.material.roughness >= .78, name);
    }
  });
}

check('explicit source PBR settings override fallback classification, including zero', () => {
  const source = { metalness: .3, roughness: 0, envMapIntensity: 0 };
  const material = resolveModelMaterial('MI_MetalStallDesk_Tarp_01b', source);
  for (const field of Object.keys(source)) assert.equal(material[field], source[field]);
});

check('shared model materials track late skies, map replacement and environment disposal', () => {
  const terrain = terrainFor();
  terrain.props = new PropView(terrain);
  terrain.environment = new TerrainEnvironment(terrain);
  const props = terrain.props;
  props.manifest = { materials: {
    MI_BareMetal: { color: [.3, .3, .3] },
    MI_Steel: { color: [.3, .3, .3] },
    MI_Metal_Tarp: { color: [.3, .3, .3] },
    MI_Glass: { color: [.3, .3, .3] }
  } };
  const metal = props.materialFor('MI_BareMetal');
  const cloth = props.materialFor('MI_Metal_Tarp');
  assert.equal(metal.envMap, null);
  assert.equal(props.materialFor('MI_Steel'), metal);
  for (const record of Object.values(records)) {
    const target = new THREE.WebGLRenderTarget(1, 1);
    terrain.scene.environment = target.texture;
    terrain.environment.environmentMap = target;
    terrain.environment.skySettings = record.sky;
    props.setEnvironment(target.texture, record.sky.skyLightIntensity);
    const glass = props.materialFor('MI_Glass');
    assert.equal(metal.envMap, terrain.scene.environment);
    assert.equal(glass.envMap, terrain.scene.environment);
    assert.equal(metal.envMapIntensity, .85 * record.sky.skyLightIntensity);
    assert.equal(cloth.envMapIntensity, .4 * record.sky.skyLightIntensity);
    assert.equal(glass.envMapIntensity, 1.1 * record.sky.skyLightIntensity);
    target.addEventListener('dispose', () => {
      assert.equal(metal.envMap, null, 'Release material references before disposing the old sky');
      assert.equal(glass.envMap, null);
      assert.equal(props.environmentMap, null);
    });
    terrain.environment.clear();
    assert.equal(props.materialFor('MI_BareMetal'), metal, 'Sky changes retain material identity');
  }
  props.reset();
});

check('sun temperatures are converted from display RGB into linear light', () => {
  const cool = temperatureColor(8000);
  const encoded = cool.clone().convertLinearToSRGB();
  assert.ok(cool.r < encoded.r && cool.g < encoded.g);
  assert.equal(cool.b, 1);
  assert.ok(temperatureColor(6500).r > cool.r);
});

check('terrain depth bias follows the shadow texel slope without changing model bias', () => {
  const material = terrainDepthMaterial();
  const shader = { fragmentShader: THREE.ShaderLib.depth.fragmentShader };
  material.onBeforeCompile(shader);
  assert.notEqual(shader.fragmentShader, THREE.ShaderLib.depth.fragmentShader);
  assert.ok(shader.fragmentShader.includes('dFdx(fragCoordZ)'));
  assert.ok(shader.fragmentShader.includes('dFdy(fragCoordZ)'));
  assert.equal(material.depthPacking, THREE.RGBADepthPacking);
  assert.equal(shadowFrame(terrainFor()).normalBias, .16 * terrainFor().metresToWorld);
  material.dispose();
});

const artillery = Object.create(ArtilleryScene.prototype);
const weapon = new THREE.Group();
weapon.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
Object.assign(artillery, { models: new Map(), materials: new Map(), loader: { loadAsync: async () => ({ scene: weapon }) } });
const loaded = await artillery.model('test-weapon.glb', { materials: {} });
check('loaded artillery geometry casts and receives scene shadows', () => {
  loaded.traverse(object => { if (object.isMesh) { assert.equal(object.castShadow, true); assert.equal(object.receiveShadow, true); } });
});
loaded.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });

console.log('PASS: ' + passed + ' lighting and shadow checks');
