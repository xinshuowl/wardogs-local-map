import * as THREE from './vendor/three/three.module.js';

export function fogRange(settings, terrain) {
  const factor = terrain.metresToWorld || 1;
  const distance = terrain.controls.getDistance() / factor;
  const near = Math.max(1750, settings.startDistance * .01);
  const far = Math.max(50000 * .009 / Math.max(.001, settings.density), distance * 2.8 + 16000, near + 1000);
  return { near: near * factor, far: far * factor };
}

export function skyColors(settings) {
  const haze = Math.min(1, settings.atmosphere.mieScale * .3);
  const horizon = new THREE.Color('#b5cbdc').lerp(new THREE.Color('#d9d5c5'), haze);
  const zenith = new THREE.Color('#5181b8');
  const scatter = new THREE.Color(...settings.atmosphere.rayleigh);
  zenith.lerp(scatter, .12 * Math.min(1.5, settings.atmosphere.rayleighScale / 30.21148));
  return { horizon, zenith, ground: new THREE.Color('#656558'), haze };
}

export function skyTexture(settings, sun, sunColor) {
  const width = 256;
  const height = 128;
  const data = new Uint16Array(width * height * 4);
  const colors = skyColors(settings);
  const direction = new THREE.Vector3();
  const color = new THREE.Color();
  for (let row = 0; row < height; row++) {
    const latitude = Math.PI * row / (height - 1);
    for (let column = 0; column < width; column++) {
      const longitude = 2 * Math.PI * (column / width - .5);
      direction.set(Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), Math.sin(latitude) * Math.sin(longitude));
      const altitude = direction.y;
      color.copy(colors.horizon).lerp(altitude >= 0 ? colors.zenith : colors.ground, Math.pow(Math.abs(altitude), altitude >= 0 ? .45 : .22));
      const solar = Math.max(0, direction.dot(sun));
      const glow = Math.pow(solar, 24) * (.045 + colors.haze * .12) + Math.pow(solar, 1500) * 1.5;
      const offset = (row * width + column) * 4;
      data[offset] = THREE.DataUtils.toHalfFloat(color.r + sunColor.r * glow);
      data[offset + 1] = THREE.DataUtils.toHalfFloat(color.g + sunColor.g * glow);
      data[offset + 2] = THREE.DataUtils.toHalfFloat(color.b + sunColor.b * glow);
      data[offset + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.flipY = true;
  texture.needsUpdate = true;
  return texture;
}
