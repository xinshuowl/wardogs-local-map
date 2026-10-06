import { WEAPONS } from './artillery-data.js';

const dragCurve = [[0, .71], [30, .69], [61, .66], [91, .64], [122, .65], [150, .66], [183, .68], [213, .72], [244, .8], [274, .92], [300, 1.1], [335, 1.25], [366, 1.33], [396, 1.39], [427, 1.44], [450, 1.48], [488, 1.5], [518, 1.54], [549, 1.57], [579, 1.58], [600, 1.6]];
const peakCache = new Map();
const solutionCache = new Map();
const stepSeconds = .01;

export function weaponById(identifier) {
  const weapon = WEAPONS.find(entry => entry.id === identifier);
  if (!weapon) throw new RangeError('未知的战狗游戏武器。');
  return weapon;
}

function dragCoefficient(speed) {
  const boundedSpeed = Math.max(0, Math.min(600, speed));
  for (let index = 1; index < dragCurve.length; index++) {
    const [upperSpeed, upperDrag] = dragCurve[index];
    if (boundedSpeed > upperSpeed) continue;
    const [lowerSpeed, lowerDrag] = dragCurve[index - 1];
    return lowerDrag + (upperDrag - lowerDrag) * (boundedSpeed - lowerSpeed) / (upperSpeed - lowerSpeed);
  }
  return dragCurve.at(-1)[1];
}

export function integrateCannon(rawMils, startingHeight = 3.2, collect = false) {
  if (![rawMils, startingHeight].every(Number.isFinite)) throw new RangeError('刻度与高差必须是有限数值。');
  const weapon = weaponById('l52-cannon');
  const angle = rawMils * .001 + .016808;
  const area = weapon.diameter ** 2 * 7853981515e-14;
  const dragFactor = weapon.dragScale * .6 * area / weapon.mass;
  let horizontalVelocity = Math.cos(angle) * 300;
  let verticalVelocity = Math.sin(angle) * 300;
  let distance = 0;
  let height = startingHeight;
  const samples = collect ? [{ distance: 0, height, time: 0 }] : null;
  for (let step = 0; step < 100000; step++) {
    const previousHeight = height;
    const speed = Math.hypot(horizontalVelocity, verticalVelocity);
    const deceleration = dragCoefficient(speed) * dragFactor * speed * speed;
    const horizontalDirection = speed * speed > 1e-8 ? horizontalVelocity / speed : 0;
    const verticalDirection = speed * speed > 1e-8 ? verticalVelocity / speed : 0;
    const midpointHorizontal = horizontalVelocity - deceleration * horizontalDirection * .005;
    const midpointVertical = verticalVelocity - (deceleration * verticalDirection + 9.8) * .005;
    const midpointSpeed = Math.hypot(midpointHorizontal, midpointVertical);
    const midpointDrag = dragCoefficient(midpointSpeed) * dragFactor * midpointSpeed * midpointSpeed;
    const midpointHorizontalDirection = midpointSpeed * midpointSpeed > 1e-8 ? midpointHorizontal / midpointSpeed : 0;
    const midpointVerticalDirection = midpointSpeed * midpointSpeed > 1e-8 ? midpointVertical / midpointSpeed : 0;
    height += midpointVertical * stepSeconds;
    distance += midpointHorizontal * stepSeconds;
    verticalVelocity -= (midpointDrag * midpointVerticalDirection + 9.8) * stepSeconds;
    horizontalVelocity -= midpointDrag * midpointHorizontalDirection * stepSeconds;
    const time = (step + 1) * stepSeconds;
    samples?.push({ distance, height, time });
    if (height <= 0 && previousHeight > 0) return { distance, time, reached: true, samples };
    if (midpointVertical < 0 && height <= 0) return { distance: 0, time: 0, reached: false, samples };
  }
  return { distance, time: 1000, reached: false, samples };
}

function cannonPeak(startingHeight) {
  const key = String(startingHeight);
  if (peakCache.has(key)) return peakCache.get(key);
  let lower = 20;
  let upper = 1400;
  for (let iteration = 0; iteration < 20; iteration++) {
    const first = lower + (upper - lower) / 3;
    const second = upper - (upper - lower) / 3;
    if (integrateCannon(first, startingHeight).distance < integrateCannon(second, startingHeight).distance) lower = first;
    else upper = second;
  }
  const mils = (lower + upper) / 2;
  const peak = { mils, range: integrateCannon(mils, startingHeight).distance };
  if (peakCache.size >= 200) peakCache.clear();
  peakCache.set(key, peak);
  return peak;
}

export function solveCannon(range, startingHeight = 3.2) {
  if (![range, startingHeight].every(Number.isFinite) || range <= 0) return [];
  const key = range + ':' + startingHeight;
  if (solutionCache.has(key)) return solutionCache.get(key).map(shot => ({ ...shot }));
  const peak = cannonPeak(startingHeight);
  const shots = [];
  if (range <= peak.range) {
    for (const [minimumMils, maximumMils, arc] of [[20, peak.mils, 'low'], [peak.mils, 1400, 'high']]) {
      const minimumDistance = integrateCannon(minimumMils, startingHeight).distance;
      const maximumDistance = integrateCannon(maximumMils, startingHeight).distance;
      if (range < Math.min(minimumDistance, maximumDistance) || range > Math.max(minimumDistance, maximumDistance)) continue;
      const ascending = maximumDistance > minimumDistance;
      let lower = minimumMils;
      let upper = maximumMils;
      for (let iteration = 0; iteration < 12; iteration++) {
        const midpoint = (lower + upper) / 2;
        if ((integrateCannon(midpoint, startingHeight).distance < range) === ascending) lower = midpoint;
        else upper = midpoint;
      }
      const rawMils = (lower + upper) / 2;
      const result = integrateCannon(rawMils, startingHeight);
      if (result.reached && Math.abs(result.distance - range) <= 10) shots.push({ arc, rawMils, mils: rawMils, time: result.time, range });
    }
  }
  if (solutionCache.size >= 400) solutionCache.clear();
  solutionCache.set(key, shots);
  return shots.map(shot => ({ ...shot }));
}

function solveMortar(range) {
  const weapon = weaponById('l81-mortar');
  if (range < weapon.minRange || range > weapon.maxRange) return [];
  for (let index = 1; index < weapon.rangeTable.length; index++) {
    const [firstMils, firstRange, firstTime] = weapon.rangeTable[index - 1];
    const [secondMils, secondRange, secondTime] = weapon.rangeTable[index];
    if (range < secondRange || range > firstRange) continue;
    const fraction = (range - firstRange) / (secondRange - firstRange);
    const rawMils = firstMils + (secondMils - firstMils) * fraction;
    return [{ arc: 'low', rawMils, mils: rawMils + weapon.displayOffset, time: firstTime + (secondTime - firstTime) * fraction, range }];
  }
  return [];
}

export function solveWeapon(identifier, range, drop = 0, preferredArc = 'low') {
  const weapon = weaponById(identifier);
  if (![range, drop].every(Number.isFinite) || range < 0) throw new RangeError('距离与高差必须是有效数值。');
  const shots = identifier === 'l52-cannon' ? solveCannon(range) : solveMortar(range);
  const selected = shots.find(shot => shot.arc === preferredArc) || shots[0] || null;
  const correctionNeeded = identifier === 'l52-cannon' && Boolean(selected) && Math.abs(drop) >= 5;
  const corrected = correctionNeeded ? solveCannon(range, 3.2 + drop).find(shot => shot.arc === selected.arc) || null : null;
  const status = shots.length ? 'in-range' : range < weapon.minRange ? 'too-close' : 'too-far';
  return { weapon, range, drop, shots, selected, status, correctionNeeded, corrected, correctionUnreachable: correctionNeeded && !corrected };
}

export function validPosition(position) {
  return Array.isArray(position) && position.length === 2 && position.every(coordinate => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 2048);
}

export function mapToGame(map, position) {
  if (!validPosition(position)) throw new RangeError('坐标超出当前地图边界。');
  const extent = map.bounds[2] / 10000;
  return { x: position[0] / 2048 * extent, y: (2048 - position[1]) / 2048 * extent };
}

export function gameToMap(map, coordinates) {
  const extent = map.bounds[2] / 10000;
  if (![coordinates.x, coordinates.y].every(value => Number.isFinite(value) && value >= 0 && value <= extent)) throw new RangeError('游戏坐标必须在 0–' + extent.toFixed(2) + ' 范围内。');
  return [coordinates.x / extent * 2048, 2048 - coordinates.y / extent * 2048];
}

export function firingVector(map, gun, target) {
  if (!validPosition(gun) || !validPosition(target)) throw new RangeError('炮位与目标坐标无效。');
  const metresPerUnit = map.bounds[2] / 100 / 2048;
  const east = (target[0] - gun[0]) * metresPerUnit;
  const north = (gun[1] - target[1]) * metresPerUnit;
  const radians = (Math.atan2(east, north) + Math.PI * 2) % (Math.PI * 2);
  return { range: Math.hypot(east, north), bearing: radians * 180 / Math.PI, bearingMils: radians * 1000, east, north };
}

export function correctedTarget(map, gun, target, addMetres, rightMetres) {
  if (![addMetres, rightMetres].every(Number.isFinite)) throw new RangeError('修正距离无效。');
  const vector = firingVector(map, gun, target);
  const eastDirection = vector.range > 0 ? vector.east / vector.range : 0;
  const northDirection = vector.range > 0 ? vector.north / vector.range : 1;
  const metresPerUnit = map.bounds[2] / 100 / 2048;
  const result = [target[0] + (eastDirection * addMetres + northDirection * rightMetres) / metresPerUnit, target[1] - (northDirection * addMetres - eastDirection * rightMetres) / metresPerUnit];
  if (!validPosition(result)) throw new RangeError('修正后的目标超出地图边界。');
  return result;
}

export function createTrajectory(identifier, shot, gun, target, originHeight, targetHeight, segments = 128) {
  if (!shot || !validPosition(gun) || !validPosition(target) || ![originHeight, targetHeight].every(Number.isFinite) || !Number.isInteger(segments) || segments < 2 || segments > 2048) return [];
  const drop = originHeight - targetHeight;
  const output = [];
  const integrated = identifier === 'l52-cannon' ? integrateCannon(shot.rawMils, drop, true) : null;
  const samples = integrated?.reached && integrated.distance > 0 ? integrated.samples : null;
  const visualAngle = Math.min(85 * Math.PI / 180, shot.rawMils * .001 + (identifier === 'l81-mortar' ? 1.311 : .102));
  const apex = shot.range * Math.tan(visualAngle) / 4;
  let sampleIndex = 0;
  for (let index = 0; index <= segments; index++) {
    const fraction = index / segments;
    let curveHeight = 4 * apex * fraction * (1 - fraction);
    let time = shot.time * fraction;
    if (samples) {
      const distance = integrated.distance * fraction;
      while (sampleIndex < samples.length - 2 && samples[sampleIndex + 1].distance < distance) sampleIndex++;
      const first = samples[sampleIndex];
      const second = samples[sampleIndex + 1];
      const interpolation = (distance - first.distance) / (second.distance - first.distance || 1);
      curveHeight = first.height + (second.height - first.height) * interpolation - drop * (1 - fraction);
      time = first.time + (second.time - first.time) * interpolation;
    }
    const height = index === 0 ? originHeight : index === segments ? targetHeight : originHeight + (targetHeight - originHeight) * fraction + curveHeight;
    output.push([gun[0] + (target[0] - gun[0]) * fraction, gun[1] + (target[1] - gun[1]) * fraction, height, time]);
  }
  return output;
}

export function sampleTerrainHeight(map, descriptor, heights, position) {
  if (!validPosition(position) || !descriptor || heights.length !== descriptor.cols * descriptor.rows) return null;
  const column = Math.max(0, Math.min(descriptor.cols - 1, (map.bounds[0] + position[0] / 2048 * map.bounds[2] - descriptor.origin[0]) / descriptor.step[0]));
  const row = Math.max(0, Math.min(descriptor.rows - 1, (map.bounds[1] + position[1] / 2048 * map.bounds[2] - descriptor.origin[1]) / descriptor.step[1]));
  const left = Math.floor(column);
  const top = Math.floor(row);
  const right = Math.min(left + 1, descriptor.cols - 1);
  const bottom = Math.min(top + 1, descriptor.rows - 1);
  const horizontal = column - left;
  const vertical = row - top;
  const upper = heights[top * descriptor.cols + left] * (1 - horizontal) + heights[top * descriptor.cols + right] * horizontal;
  const lower = heights[bottom * descriptor.cols + left] * (1 - horizontal) + heights[bottom * descriptor.cols + right] * horizontal;
  return (descriptor.heightOffset + (upper * (1 - vertical) + lower * vertical - 32768) * descriptor.heightScale) / 100;
}
