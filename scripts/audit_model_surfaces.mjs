import { readFile, writeFile } from 'node:fs/promises';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/three/meshopt_decoder.module.js';

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
await MeshoptDecoder.ready;
const report = {};
for (const map of ['bakurani', 'ozeti', 'zestafona']) {
  const base = new URL('../assets/models/' + map + '/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  const summary = { materials: Object.keys(manifest.materials).length, bundles: 0, parts: 0, vertices: 0, zeroNormals: 0, invalidNormals: 0, missingNormals: 0, missingUV: 0, negativeNodes: 0, instances: 0, tinted: 0, darkTinted: 0, mirrored: 0, singular: 0, models: {}, geometryIssues: [] };
  for (const [bundleIndex, bundle] of manifest.bundles.entries()) {
    for (const [lod, resource] of Object.entries(bundle.lods || { 2: bundle })) {
      const bytes = await readFile(new URL(resource.file, base));
      const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse(object => {
        if (!object.isMesh) return;
        let identifier;
        for (let ancestor = object; ancestor; ancestor = ancestor.parent) { const match = /^m(\d+)$/.exec(ancestor.name); if (match) { identifier = Number(match[1]); break; } }
        const model = summary.models[identifier] ||= { name: manifest.meshes[identifier]?.name, bundle: bundleIndex, materials: [], instances: 0, tinted: 0, darkTinted: 0, mirrored: 0, examples: [] };
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) if (!model.materials.includes(material.name)) model.materials.push(material.name);
        const geometry = object.geometry; const normal = geometry.attributes.normal;
        const issues = { model: identifier, lod, material: materials.map(material => material.name), zero: 0, invalid: 0, missingUV: !geometry.attributes.uv, missingNormals: !normal, negativeNode: object.matrixWorld.determinant() < 0 };
        summary.parts++; summary.vertices += geometry.attributes.position.count;
        if (normal) for (let index = 0; index < normal.count; index++) {
          const length = Math.hypot(normal.getX(index), normal.getY(index), normal.getZ(index));
          if (!Number.isFinite(length)) issues.invalid++;
          else if (length < .01) issues.zero++;
        }
        summary.zeroNormals += issues.zero; summary.invalidNormals += issues.invalid;
        summary.missingNormals += Number(issues.missingNormals); summary.missingUV += Number(issues.missingUV); summary.negativeNodes += Number(issues.negativeNode);
        if (issues.zero || issues.invalid || issues.missingNormals || issues.missingUV || issues.negativeNode) summary.geometryIssues.push(issues);
        geometry.dispose(); for (const material of materials) material.dispose();
      });
      summary.bundles++; global.gc?.();
    }
  }
  for (const tile of manifest.tiles) {
    const bytes = await readFile(new URL(tile.file, base));
    const groups = bytes.readUInt32LE(0); let cursor = 4 + groups * 8;
    for (let group = 0; group < groups; group++) {
      const identifier = bytes.readUInt32LE(4 + group * 8); const count = bytes.readUInt32LE(8 + group * 8);
      const model = summary.models[identifier];
      summary.instances += count; model.instances += count;
      for (let index = 0; index < count; index++) {
        const offset = cursor + index * 44; const packed = Math.round(bytes.readFloatLE(offset + 40));
        const determinant = bytes.readFloatLE(offset + 28) * bytes.readFloatLE(offset + 32) * bytes.readFloatLE(offset + 36);
        if (packed > 0) { summary.tinted++; model.tinted++; }
        if (packed > 0 && Math.max(packed >>> 16 & 255, packed >>> 8 & 255, packed & 255) < 64) {
          summary.darkTinted++; model.darkTinted++;
          if (model.examples.length < 2) model.examples.push({ tile: tile.file, instance: index, color: packed, transform: Array.from({ length: 11 }, (_, component) => bytes.readFloatLE(offset + component * 4)) });
        }
        if (determinant < 0) { summary.mirrored++; model.mirrored++; if (!model.mirrorExample) model.mirrorExample = { tile: tile.file, instance: index, transform: Array.from({ length: 11 }, (_, component) => bytes.readFloatLE(offset + component * 4)) }; }
        if (Math.abs(determinant) < 1e-9) summary.singular++;
      }
      cursor += count * 44;
    }
  }
  report[map] = summary;
  const { models, geometryIssues, ...counts } = summary;
  console.log(JSON.stringify({ map, ...counts, darkest: Object.entries(models).filter(([, model]) => model.darkTinted).sort((first, second) => second[1].darkTinted - first[1].darkTinted).slice(0, 8).map(([identifier, model]) => ({ identifier, name: model.name, dark: model.darkTinted, materials: model.materials })) }));
}
await writeFile(new URL('../.validation/model-surfaces-audit.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
