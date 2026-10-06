export function applyGroundMaterial(material, terrain, landscape, masks, layers, surface) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = shader => {
    previous(shader);
    masks.forEach((texture, index) => { shader.uniforms['groundMask' + index] = { value: texture }; });
    layers.forEach((texture, index) => { shader.uniforms['groundLayer' + index] = { value: texture }; });
    shader.uniforms.groundSurface = { value: surface };
    shader.uniforms.groundMetres = { value: terrain.map.bounds[2] / 100 };
    shader.uniforms.groundFactor = { value: terrain.metresToWorld };
    const declarations = masks.map((_, index) => 'uniform sampler2D groundMask' + index + ';').concat(layers.map((_, index) => 'uniform sampler2D groundLayer' + index + ';')).join('\n');
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 groundUv; varying float groundDistance;').replace('#include <begin_vertex>', '#include <begin_vertex>\ngroundUv = vec2((position.x + 1024.0) / 2048.0, 1.0 - (position.z + 1024.0) / 2048.0);').replace('#include <project_vertex>', '#include <project_vertex>\ngroundDistance = length(mvPosition.xyz);');
    const weights = layers.map((_, index) => 'texture2D(groundMask' + Math.floor(index / 3) + ', groundUv).' + ['r', 'g', 'b'][index % 3]);
    const blended = layers.map((_, index) => {
      const period = landscape.layers[index] === 'Rock' ? '10.24' : '4.0';
      return `vec2 groundTile${index} = groundUv * groundMetres / ${period};
        groundBlend += texture2D(groundLayer${index}, groundTile${index}).rgb * groundWeight${index};
        if (groundRelief > 0.0) {
          vec2 surfaceUv${index} = vec2(fract(groundTile${index}.x), 1.0 - fract(groundTile${index}.y)) * (252.0 / 256.0) + vec2(2.0 / 256.0);
          surfaceUv${index}.y = (surfaceUv${index}.y + ${index.toFixed(1)}) / ${layers.length.toFixed(1)};
          groundSurfaceBlend += texture2D(groundSurface, surfaceUv${index}) * groundWeight${index};
        }`;
    }).join('\n');
    const logic = weights.map((weight, index) => 'float groundWeight' + index + ' = ' + weight + ';').join('\n') + `
      float groundTotal = ${layers.map((_, index) => 'groundWeight' + index).join(' + ')};
      vec3 groundBlend = vec3(0.0);
      vec4 groundSurfaceBlend = vec4(0.0);
      float groundRelief = 1.0 - smoothstep(80.0 * groundFactor, 250.0 * groundFactor, groundDistance);
      float groundFade = 0.92 * (1.0 - smoothstep(1300.0 * groundFactor, 4000.0 * groundFactor, groundDistance));
      ${blended}
      if (groundTotal > 0.001) {
        float aerialVariation = clamp(dot(diffuseColor.rgb, vec3(0.2126,0.7152,0.0722)) / 0.18, 0.8, 1.15);
        diffuseColor.rgb = mix(diffuseColor.rgb, groundBlend / groundTotal * aerialVariation, groundFade);
        groundSurfaceBlend /= groundTotal;
      } else { groundRelief = 0.0; }
    `;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + declarations + '\nuniform sampler2D groundSurface; varying vec2 groundUv; varying float groundDistance; uniform float groundMetres; uniform float groundFactor;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + logic)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, groundSurfaceBlend.a, groundRelief);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (groundRelief > 0.0) {
          vec3 groundEast = (viewMatrix * vec4(1.0,0.0,0.0,0.0)).xyz;
          vec3 groundNorth = normalize(cross(normal, groundEast));
          groundEast = normalize(cross(groundNorth, normal));
          vec3 groundNormal = normalize(groundSurfaceBlend.rgb * 2.0 - 1.0);
          normal = normalize(mix(normal, mat3(groundEast, groundNorth, normal) * groundNormal, groundRelief));
        }`)
      .replace('#include <opaque_fragment>', 'outgoingLight = mix(outgoingLight, diffuseColor.rgb, (1.0 - groundFade) * 0.8);\n#include <opaque_fragment>');
  };
  material.customProgramCacheKey = () => 'local-ground-surfaces-v2-' + terrain.map.id;
  material.needsUpdate = true;
}
