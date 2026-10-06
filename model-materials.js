const replacementSurfaces = {
  DefaultMaterial: 'concrete', MI_ApartmentSkirting: 'paint', MI_Apartment_ConcreteTiles_01a: 'tiles',
  MI_Apartment_FloorTrim_01a: 'wood', MI_BlackUnlit: 'black', MM_BlackUnlit: 'black',
  MI_Camo_Net_Splinter_01a: 'camo', MI_ChainLinkFence01a_Wire: 'wire',
  MI_Electric_Icon_Sheet_01a: 'label', MI_EmissiveLightGreen_Dim_02: 'green-light',
  MI_Football_Merchandise_Posters_01a: 'paper', MI_GlassBulb_Emissive_01a: 'bulb',
  MI_GlassDusty: 'glass', MI_KitchenTiles: 'tiles', MI_Landscape_Blending: 'soil',
  MI_Landscape_BlendingNoTessellation: 'soil', MI_Laptop: 'plastic',
  MI_LaptopScreenAnimated_01a: 'screen', MI_LeafScatter: 'leaves', MI_Metal_Grate_01a: 'grate',
  MI_Mural_01a: 'plaster', MI_Ozeti_Mural_01a: 'plaster', MI_Resi_ExtensionWall_01a: 'plaster',
  MI_Road_Signs_07a: 'label', MI_Rug_Large_01a: 'fabric', MI_Tiling_Cinder_Blocks_01a: 'brick',
  MI_Tiling_WallPaper_01: 'wallpaper', MI_Tower_Number_01a: 'label',
  MI_Tree_Beech_Bark_Roots_01a: 'bark', MI_WindowFrame_Glass_Opaque: 'opaque-glass',
  MM_Blank: 'paint', Mi_ResidentialFoundations_01a: 'concrete', WorldGridMaterial: 'concrete',
  MI_FootballStadium_Goal_Net_01a: 'net', M_Grid: 'concrete', M_HighVis_Bombzone: 'warning',
  MI_CB_FrontTrays_01b: 'metal', SplineEditorMeshMat: 'soil'
};

const aliases = {
  MI_Tree_Beech_Bark_Roots_01a: ['MI_Tree_Beech_Bark_Moss_01a', 'MI_Tree_Beech_Bark_Debris_01a'],
  MI_Rug_Large_01a: ['MI_Rug_Medium_Small_01a'],
  MI_Apartment_ConcreteTiles_01a: ['MI_Tiles_Exterior_01a'],
  Mi_ResidentialFoundations_01a: ['MI_Concrete_01a', 'MI_ChurchFoundations_01a'],
  MI_Road_Signs_07a: ['MI_Road_Signs_Blank_01a']
};

const surfaceColors = {
  black: [0.002, 0.002, 0.002], glass: [0.48, 0.57, 0.6], 'opaque-glass': [0.06, 0.09, 0.1],
  'green-light': [0.06, 0.42, 0.1], bulb: [0.85, 0.73, 0.46], screen: [0.025, 0.09, 0.13],
  plastic: [0.045, 0.048, 0.052], metal: [0.28, 0.3, 0.31], warning: [0.8, 0.46, 0.04]
};

const repairedBaseColors = {
  '833873520a0b6149.webp': '@steel-floor.webp',
  'ec54d508479b3b1a.webp': '@interior-wood.webp',
  'f6cefd2b258cf789.webp': '@interior-painted-wood.webp',
  '0b28d5b1c7645328.webp': '@industrial-girders.webp'
};

export function resolveModelMaterial(name, source = {}, materials = {}) {
  let descriptor = { ...source };
  const missing = !source.baseColor && !source.color;
  const surface = replacementSurfaces[name];
  if (missing) {
    const alias = aliases[name]?.find(candidate => materials[candidate]?.baseColor);
    if (alias) descriptor = { ...materials[alias], replacement: alias };
    else if (surfaceColors[surface]) descriptor = { ...descriptor, color: surfaceColors[surface], replacement: surface };
    else descriptor = { ...descriptor, baseColor: '@' + (surface || 'concrete') + '.webp', replacement: surface || 'concrete', repeat: [1, 1], colorGain: 1 };
  }
  if (repairedBaseColors[source.baseColor]) {
    descriptor.baseColor = repairedBaseColors[source.baseColor];
    descriptor.replacement = 'dark-source:' + source.baseColor;
    descriptor.colorGain = 1;
  } else if (source.baseColor === 'b7cceb6cf4fe7597.webp' && source.color) {
    descriptor.baseColor = null;
    descriptor.replacement = 'empty-source:color';
  }
  const glass = !/Opaque|Bulb|Emissive/i.test(name) && (/Glass/i.test(name) || surface === 'glass');
  const decal = /Decal/i.test(name);
  const cutout = ['wire', 'net', 'grate', 'camo', 'leaves'].includes(surface);
  const nonMetalSurface = /Paint|Rust|Tarp|Fabric|Cloth|Canvas|Wood|Timber|Rubber|Plastic|Glass|Decal|Corrugated.*WPO/i.test(name);
  const bareMetal = /(?:Metal|Steel|Iron|Chrome|Alumin|Wire|Grate|FrontTrays)/i.test(name) && !nonMetalSurface;
  const rough = /Concrete|Brick|Stone|Rock|Soil|Asphalt|Bark|Plaster/i.test(name);
  descriptor.roughness = source.roughness ?? (glass ? .16 : bareMetal ? .46 : rough ? .96 : /Wood|Timber|Rug|Fabric|Tarp|Cloth|Canvas/i.test(name) ? .88 : .78);
  descriptor.metalness = source.metalness ?? (bareMetal ? .72 : 0);
  descriptor.opacity = source.opacity ?? (glass ? /Church/i.test(name) ? .58 : /Dirty|Dust/i.test(name) ? .4 : .24 : 1);
  descriptor.transparent = glass || descriptor.opacity < 1;
  descriptor.castShadow = !glass && !decal && !/Emissive|Screen/i.test(name);
  descriptor.envMapIntensity = source.envMapIntensity ?? (glass ? 1.1 : bareMetal ? .85 : .4);
  if (cutout) descriptor.alpha = true;
  if (name === 'MI_Dumpster_01_Decals') {
    descriptor.baseColor = '@dumpster-decals.webp'; descriptor.alpha = true; descriptor.repeat = [1, 1];
  }
  descriptor.decal = decal;
  if (/Emissive|Screen/i.test(name)) {
    descriptor.emissive = /Green/i.test(name) ? '#3ab55a' : /Screen/i.test(name) ? '#548ca5' : '#ffd799';
    descriptor.emissiveIntensity = /Dim|Screen/i.test(name) ? .25 : .7;
  }
  return descriptor;
}
