export function drainWork(work, deadline = Infinity, clock = () => performance.now()) {
  let result = { done: false };
  while (clock() < deadline) {
    result = work.next();
    if (result.done || result.value === 'frame' && deadline !== Infinity) break;
  }
  return result;
}

export function* sortInSlices(values, compare) {
  let source = values;
  let target = new Array(values.length);
  let operations = 0;
  for (let width = 1; width < values.length; width *= 2) {
    for (let start = 0; start < values.length; start += width * 2) {
      const middle = Math.min(start + width, values.length);
      const end = Math.min(start + width * 2, values.length);
      let left = start;
      let right = middle;
      for (let output = start; output < end; output++) {
        target[output] = left < middle && (right >= end || compare(source[left], source[right]) <= 0) ? source[left++] : source[right++];
        if (++operations % 512 === 0) yield;
      }
    }
    [source, target] = [target, source];
  }
  if (source !== values) for (let index = 0; index < values.length; index++) {
    values[index] = source[index];
    if (index % 512 === 511) yield;
  }
  return values;
}

export function* vertexNormalsInSlices(vertices, indices) {
  const normals = new Float32Array(vertices.length);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const first = indices[offset] * 3;
    const second = indices[offset + 1] * 3;
    const third = indices[offset + 2] * 3;
    const edgeX = vertices[third] - vertices[second];
    const edgeY = vertices[third + 1] - vertices[second + 1];
    const edgeZ = vertices[third + 2] - vertices[second + 2];
    const sideX = vertices[first] - vertices[second];
    const sideY = vertices[first + 1] - vertices[second + 1];
    const sideZ = vertices[first + 2] - vertices[second + 2];
    const normalX = edgeY * sideZ - edgeZ * sideY;
    const normalY = edgeZ * sideX - edgeX * sideZ;
    const normalZ = edgeX * sideY - edgeY * sideX;
    for (const vertex of [first, second, third]) {
      normals[vertex] += normalX;
      normals[vertex + 1] += normalY;
      normals[vertex + 2] += normalZ;
    }
    if (offset % 1536 === 1533) yield;
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    normals[offset] /= length;
    normals[offset + 1] /= length;
    normals[offset + 2] /= length;
    if (offset % 1536 === 1533) yield;
  }
  return normals;
}
