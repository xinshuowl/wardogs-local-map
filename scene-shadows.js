import * as THREE from './vendor/three/three.module.js';

export function terrainDepthMaterial() {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor = packDepthToRGBA( fragCoordZ );', 'float terrainDepthSlope = max(abs(dFdx(fragCoordZ)), abs(dFdy(fragCoordZ)));\n\tgl_FragColor = packDepthToRGBA(min(1.0, fragCoordZ + 2.0 * terrainDepthSlope));');
  };
  material.customProgramCacheKey = () => 'terrain-shadow-slope-v1';
  return material;
}

export function applySceneShadows(material) {
  const previous = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = shader => {
    previous(shader);
    const sample = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
    const blended = `
      #if NUM_DIR_LIGHT_SHADOWS > 1 && UNROLLED_LOOP_INDEX == 0
        if (directLight.visible && receiveShadow) {
          vec3 nearCoord = vDirectionalShadowCoord[0].xyz / vDirectionalShadowCoord[0].w;
          vec3 farCoord = vDirectionalShadowCoord[1].xyz / vDirectionalShadowCoord[1].w;
          float nearEdge = max(abs(nearCoord.x * 2.0 - 1.0), abs(nearCoord.y * 2.0 - 1.0));
          float farEdge = max(abs(farCoord.x * 2.0 - 1.0), abs(farCoord.y * 2.0 - 1.0));
          float nearWeight = 1.0 - smoothstep(0.72, 0.96, nearEdge);
          nearWeight *= step(0.0, nearCoord.z) * step(nearCoord.z, 1.0);
          DirectionalLightShadow farSettings = directionalLightShadows[1];
          float nearShade = getShadow(directionalShadowMap[0], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[0]);
          float farShade = getShadow(directionalShadowMap[1], farSettings.shadowMapSize, farSettings.shadowIntensity, farSettings.shadowBias, farSettings.shadowRadius, vDirectionalShadowCoord[1]);
          farShade = mix(farShade, 1.0, smoothstep(0.78, 0.98, farEdge));
          directLight.color *= mix(farShade, nearShade, nearWeight);
        }
      #else
        ${sample}
      #endif`;
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(sample, blended));
  };
  material.customProgramCacheKey = () => key + '-shadow-blend-v1';
  return material;
}

export function shadowFrame(terrain, distant = false) {
  const factor = terrain.metresToWorld || 1;
  const navigating = ['fly', 'walk', 'gun', 'target', 'sight'].includes(terrain.artilleryCameraMode);
  const distance = terrain.controls.getDistance() / factor;
  const direction = terrain.sunDirection?.clone() || new THREE.Vector3(-240, 650, 380).normalize();
  const horizontal = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction);
  if (horizontal.lengthSq() < .0001) horizontal.set(1, 0, 0);
  horizontal.normalize();
  const vertical = new THREE.Vector3().crossVectors(direction, horizontal).normalize();
  const target = (navigating ? terrain.camera.position : terrain.controls.target).clone();
  let altitude = 0;
  if (navigating) {
    const forward = new THREE.Vector3();
    terrain.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() > .0001) target.addScaledVector(forward.normalize(), 40 * factor);
    if (terrain.surfacePoint && terrain.ready) {
      const ground = terrain.surfacePoint([Math.max(0, Math.min(2048, target.x + 1024)), Math.max(0, Math.min(2048, target.z + 1024))]);
      altitude = Math.max(0, (terrain.camera.position.y - ground.y) / factor);
      target.y = ground.y;
    }
  }
  const nearExtent = navigating ? Math.max(120, Math.min(1200, Math.ceil(altitude / 25) * 25)) : Math.max(120, Math.min(1200, Math.ceil(distance * 1.4 / 25) * 25));
  const extentMetres = distant ? Math.min(12000, Math.max(800, nearExtent * (navigating ? 6 : 4), distance * (navigating ? 0 : 1.4))) : nearExtent;
  const extent = extentMetres * factor;
  const resolution = terrain.renderProfile === 'high' ? 2048 : 1024;
  const texel = extent * 2 / resolution;
  for (const axis of [horizontal, vertical]) {
    const coordinate = target.dot(axis);
    target.addScaledVector(axis, Math.round(coordinate / texel) * texel - coordinate);
  }
  const heightSpan = Math.max(0, (terrain.descriptor?.maximumMetres || 0) - (terrain.descriptor?.minimumMetres || 0)) * factor;
  const offset = Math.max(800 * factor, extent * 2 + heightSpan);
  const near = .5 * factor;
  const far = offset + extent * 2 + heightSpan;
  return { target, position: target.clone().addScaledVector(direction, offset), extent, extentMetres, resolution, near, far, bias: -.04 * factor / (far - near), normalBias: (distant ? .35 : .16) * factor, texelMetres: texel / factor };
}
