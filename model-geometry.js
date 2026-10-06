export function mirroredGeometry(source) {
  const geometry = source.clone().scale(-1, 1, 1);
  if (!geometry.index) geometry.setIndex(Array.from({ length: geometry.attributes.position.count }, (_, index) => index));
  const indices = geometry.index.array;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const next = indices[offset + 1]; indices[offset + 1] = indices[offset + 2]; indices[offset + 2] = next;
  }
  geometry.index.needsUpdate = true;
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export function* splitMirroredInstances(grouped, prototypes) {
  const result = new Map();
  for (const [identifier, instances] of grouped) {
    const regular = []; const mirrored = [];
    for (let index = 0; index < instances.length; index++) {
      const instance = instances[index]; const { data, offset } = instance;
      (data[offset + 7] * data[offset + 8] * data[offset + 9] < 0 ? mirrored : regular).push(instance);
      if (index % 256 === 255) yield;
    }
    if (regular.length) result.set(identifier, regular);
    if (!mirrored.length) continue;
    const key = (typeof identifier === 'number' ? identifier + ':2' : identifier) + ':mirror';
    const originals = prototypes.get(identifier);
    const parts = prototypes.get(key) || [];
    if (parts.length < originals.length) {
      prototypes.set(key, parts);
      for (const part of originals.slice(parts.length)) {
        parts.push({ ...part, geometry: mirroredGeometry(part.geometry) });
        yield;
      }
    }
    result.set(key, mirrored);
  }
  return result;
}
