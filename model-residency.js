import { drainWork, sortInSlices } from './frame-work.js';

export class ModelPresence {
  constructor() {
    this.groups = new Map();
    this.count = 0;
  }

  *retain(selected, meshes, settings) {
    const grouped = new Map();
    const current = new Map();
    let processed = 0;
    for (const [identifier, instances] of selected) {
      const mesh = typeof identifier === 'number' ? identifier : Number(identifier.split(':')[0]);
      grouped.set(identifier, instances.slice());
      for (const instance of instances) {
        if (++processed % 256 === 0) yield;
        if (!current.has(instance.data)) current.set(instance.data, new Set());
        current.get(instance.data).add(instance.offset);
        let group = this.groups.get(instance.data);
        if (!group) { group = { mesh, instances: new Map() }; this.groups.set(instance.data, group); }
        if (!group.instances.has(instance.offset)) { group.instances.set(instance.offset, instance); this.count++; }
      }
    }
    for (const [data, group] of this.groups) {
      if (!settings[meshes[group.mesh].type]) continue;
      for (const instance of group.instances.values()) {
        if (++processed % 256 === 0) yield;
        if (current.get(data)?.has(instance.offset)) continue;
        if (!grouped.has(group.mesh)) grouped.set(group.mesh, []);
        grouped.get(group.mesh).push(instance);
      }
    }
    const counts = { buildings: 0, trees: 0, props: 0 };
    for (const [identifier, instances] of grouped) {
      const mesh = typeof identifier === 'number' ? identifier : Number(identifier.split(':')[0]);
      counts[meshes[mesh].type] += instances.length;
      yield* sortInSlices(instances, (first, second) => first.order - second.order);
    }
    return { grouped, counts };
  }
}

export function modelRanges(distance, profile, navigating) {
  if (navigating) return profile === 'low' ? { buildings: 800, trees: 300, props: 160 } : profile === 'high' ? { buildings: 1600, trees: 700, props: 400 } : { buildings: 1200, trees: 550, props: 280 };
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const distant = distance > 2400;
  return { buildings: clamp(distance * 1.6, 420, 22000), trees: distant ? 0 : clamp(distance * .65, 180, 650), props: distant ? 0 : clamp(distance * .4, 90, 280) };
}

export function modelLod(distance, pixels, profile, previous = 2) {
  if (profile === 'low') return 2;
  if (profile === 'high' && distance < (previous === 0 ? 260 : 200) && pixels > (previous === 0 ? 20 : 28)) return 0;
  if (distance < (previous <= 1 ? 720 : 600) && pixels > (previous <= 1 ? 6 : 10)) return 1;
  return 2;
}

export function selectModels(candidates, budgets, triangleLimits) {
  return drainWork(selectModelsWork(candidates, budgets, triangleLimits)).value;
}

export function* selectModelsWork(candidates, budgets, triangleLimits) {
  yield* sortInSlices(candidates, (first, second) => first.distance - second.distance || first.order - second.order);
  const counts = { buildings: 0, trees: 0, props: 0 };
  const triangles = { buildings: 0, trees: 0, props: 0 };
  const selected = [];
  let processed = 0;
  for (const candidate of candidates) {
    if (++processed % 256 === 0) yield;
    const category = candidate.type;
    const limit = triangleLimits[category] * (candidate.distance < 60 ? 1 : .7);
    if (counts[category] >= budgets[category] || triangles[category] + candidate.baseTriangles > limit) continue;
    counts[category]++;
    triangles[category] += candidate.baseTriangles;
    selected.push({ ...candidate, key: candidate.mesh });
  }
  for (const candidate of selected) {
    if (++processed % 256 === 0) yield;
    const extra = candidate.detailTriangles - candidate.baseTriangles;
    if (candidate.detailKey !== undefined && triangles[candidate.type] + extra <= triangleLimits[candidate.type]) {
      candidate.key = candidate.detailKey;
      triangles[candidate.type] += extra;
    }
  }
  const grouped = new Map();
  for (const candidate of selected) {
    if (++processed % 256 === 0) yield;
    if (!grouped.has(candidate.key)) grouped.set(candidate.key, []);
    grouped.get(candidate.key).push({ data: candidate.data, offset: candidate.offset, order: candidate.order });
  }
  for (const instances of grouped.values()) yield* sortInSlices(instances, (first, second) => first.order - second.order);
  return { grouped, counts, triangles };
}

