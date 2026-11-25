/**
 * Echo Life Total Rebirth — AAA Botanical Vegetation Manifest (A03).
 * Generated deterministically by `docs/echo-life/total-rebuild/scripts/build_vegetation.py`.
 * All GLBs are standard glTF 2.0 binary with WebP textures (EXT_texture_webp) and ZERO WASM decoders.
 * Ground pivot: Y = 0 exact base contact in glTF meters.
 */

export type VegetationCategory = 'tree' | 'shrub' | 'flower' | 'fern' | 'plant' | 'grass' | 'rock';

export interface VegetationSpecies {
  readonly id: string;
  readonly category: VegetationCategory;
  readonly lod0Url: string;
  readonly lod1Url?: string;
  readonly height: number;
  readonly crownRadius: number;
  readonly seasonalTintable: boolean;
  readonly windStiffness: number;
  readonly trisLod0: number;
  readonly trisLod1: number;
  readonly normalScale?: number;
  readonly license: string;
}

export const VEGETATION_MANIFEST: readonly VegetationSpecies[] = [
  { id: 'veg-tree-jacaranda', category: 'tree', lod0Url: '/echo-life/vegetation/veg-tree-jacaranda-lod0-d013b547292a.glb', lod1Url: '/echo-life/vegetation/veg-tree-jacaranda-lod1-7c716260c60e.glb', height: 9.5, crownRadius: 5.801, seasonalTintable: true, windStiffness: 0.42, trisLod0: 17514, trisLod1: 2800, license: 'CC0-1.0' },
  { id: 'veg-tree-shade-a', category: 'tree', lod0Url: '/echo-life/vegetation/veg-tree-shade-a-lod0-13e33a870e1d.glb', lod1Url: '/echo-life/vegetation/veg-tree-shade-a-lod1-f0b21e414bd8.glb', height: 6.8, crownRadius: 3.325, seasonalTintable: true, windStiffness: 0.48, trisLod0: 16201, trisLod1: 3051, license: 'CC0-1.0' },
  { id: 'veg-tree-shade-b', category: 'tree', lod0Url: '/echo-life/vegetation/veg-tree-shade-b-lod0-4ca9873cd847.glb', lod1Url: '/echo-life/vegetation/veg-tree-shade-b-lod1-8dbeabd56524.glb', height: 5.4, crownRadius: 3.928, seasonalTintable: true, windStiffness: 0.5, trisLod0: 15403, trisLod1: 2898, license: 'CC0-1.0' },
  { id: 'veg-tree-sapling', category: 'tree', lod0Url: '/echo-life/vegetation/veg-tree-sapling-lod0-f69a94b14e61.glb', lod1Url: '/echo-life/vegetation/veg-tree-sapling-lod1-d52c70b59f7e.glb', height: 4.8, crownRadius: 2.352, seasonalTintable: true, windStiffness: 0.35, trisLod0: 14800, trisLod1: 2631, license: 'CC0-1.0' },
  { id: 'veg-tree-pine', category: 'tree', lod0Url: '/echo-life/vegetation/veg-tree-pine-lod0-926002284af5.glb', lod1Url: '/echo-life/vegetation/veg-tree-pine-lod1-4e07f878faea.glb', height: 11.5, crownRadius: 3.406, seasonalTintable: false, windStiffness: 0.62, trisLod0: 15102, trisLod1: 2960, license: 'CC0-1.0' },
  { id: 'veg-tree-palm-royal', category: 'tree', lod0Url: '/echo-life/aaa-v2/botanical/veg_palm_royal_aaa-3c018eade865.glb', lod1Url: '/echo-life/aaa-v2/botanical/veg_palm_royal_aaa_lod1-c16f20a786b7.glb', height: 8.93, crownRadius: 2.85, seasonalTintable: false, windStiffness: 0.34, trisLod0: 5708, trisLod1: 2570, license: 'Project-Owned' },
  { id: 'veg-tree-flame-poinciana', category: 'tree', lod0Url: '/echo-life/vegetation/veg-tree-flame-poinciana-lod0-fb7f015898c9.glb', lod1Url: '/echo-life/vegetation/veg-tree-flame-poinciana-lod1-369f531d2528.glb', height: 7.5, crownRadius: 5.561, seasonalTintable: true, windStiffness: 0.44, trisLod0: 13404, trisLod1: 3470, license: 'Project-Owned' },
  { id: 'veg-tree-banyan', category: 'tree', lod0Url: '/echo-life/vegetation/veg-tree-banyan-lod0-89bb6c7978f7.glb', lod1Url: '/echo-life/vegetation/veg-tree-banyan-lod1-d3786f6a6fb6.glb', height: 8.5, crownRadius: 5.306, seasonalTintable: true, windStiffness: 0.56, trisLod0: 15269, trisLod1: 3130, license: 'Project-Owned' },
  { id: 'veg-shrub-a', category: 'shrub', lod0Url: '/echo-life/vegetation/veg-shrub-a-c6772a9e7104.glb', height: 0.9, crownRadius: 0.437, seasonalTintable: true, windStiffness: 0.62, trisLod0: 3028, trisLod1: 3028, license: 'CC0-1.0' },
  { id: 'veg-shrub-b', category: 'shrub', lod0Url: '/echo-life/vegetation/veg-shrub-b-0ba489ded744.glb', height: 1.45, crownRadius: 1.132, seasonalTintable: true, windStiffness: 0.58, trisLod0: 2370, trisLod1: 2370, license: 'CC0-1.0' },
  { id: 'veg-shrub-garden', category: 'shrub', lod0Url: '/echo-life/vegetation/veg-shrub-garden-7e60bdee2f05.glb', height: 0.68, crownRadius: 0.192, seasonalTintable: true, windStiffness: 0.66, trisLod0: 2954, trisLod1: 2954, license: 'CC0-1.0' },
  { id: 'veg-shrub-hedge', category: 'shrub', lod0Url: '/echo-life/vegetation/veg-shrub-hedge-cdc2729f0a2b.glb', height: 0.72, crownRadius: 0.368, seasonalTintable: true, windStiffness: 0.72, trisLod0: 3046, trisLod1: 3046, license: 'CC0-1.0' },
  { id: 'veg-flower-gazania', category: 'flower', lod0Url: '/echo-life/vegetation/veg-flower-gazania-0edec0989d8b.glb', height: 0.36, crownRadius: 0.457, seasonalTintable: false, windStiffness: 0.4, trisLod0: 1421, trisLod1: 1421, license: 'CC0-1.0' },
  { id: 'veg-flower-ursinia', category: 'flower', lod0Url: '/echo-life/vegetation/veg-flower-ursinia-aa131ccc63ef.glb', height: 0.32, crownRadius: 0.401, seasonalTintable: false, windStiffness: 0.38, trisLod0: 1825, trisLod1: 1825, license: 'CC0-1.0' },
  { id: 'veg-fern-clump', category: 'fern', lod0Url: '/echo-life/vegetation/veg-fern-clump-fed22308b091.glb', height: 0.55, crownRadius: 0.632, seasonalTintable: true, windStiffness: 0.45, trisLod0: 2080, trisLod1: 2080, license: 'CC0-1.0' },
  { id: 'veg-plant-anthurium', category: 'plant', lod0Url: '/echo-life/vegetation/veg-plant-anthurium-1d7f652bbfb1.glb', height: 0.65, crownRadius: 0.605, seasonalTintable: false, windStiffness: 0.55, trisLod0: 2506, trisLod1: 2506, license: 'CC0-1.0' },
  { id: 'veg-plant-calathea', category: 'plant', lod0Url: '/echo-life/vegetation/veg-plant-calathea-ff68e2052ad4.glb', height: 0.52, crownRadius: 0.353, seasonalTintable: false, windStiffness: 0.56, trisLod0: 2470, trisLod1: 2470, license: 'CC0-1.0' },
  { id: 'veg-grass-bermuda', category: 'grass', lod0Url: '/echo-life/vegetation/veg-grass-bermuda-2c396e5f84ec.glb', height: 0.24, crownRadius: 0.234, seasonalTintable: true, windStiffness: 0.22, trisLod0: 1882, trisLod1: 1882, license: 'CC0-1.0' },
  { id: 'veg-grass-meadow', category: 'grass', lod0Url: '/echo-life/vegetation/veg-grass-meadow-d7e9636404d1.glb', height: 0.38, crownRadius: 0.433, seasonalTintable: true, windStiffness: 0.25, trisLod0: 2062, trisLod1: 2062, license: 'CC0-1.0' },
  { id: 'veg-rock-boulder', category: 'rock', lod0Url: '/echo-life/vegetation/veg-rock-boulder-177db9523089.glb', height: 0.78, crownRadius: 0.775, seasonalTintable: false, windStiffness: 1.0, trisLod0: 1728, trisLod1: 1728, license: 'Project-Owned' },
  { id: 'veg-rock-garden', category: 'rock', lod0Url: '/echo-life/vegetation/veg-rock-garden-d247318bc7e9.glb', height: 0.36, crownRadius: 0.309, seasonalTintable: false, windStiffness: 1.0, trisLod0: 899, trisLod1: 899, normalScale: 1.35, license: 'CC0-1.0' },
  { id: 'veg-rock-border', category: 'rock', lod0Url: '/echo-life/vegetation/veg-rock-border-30009f3ab705.glb', height: 0.22, crownRadius: 0.183, seasonalTintable: false, windStiffness: 1.0, trisLod0: 749, trisLod1: 749, normalScale: 1.35, license: 'CC0-1.0' },
] as const;

export type VegetationSpeciesId = (typeof VEGETATION_MANIFEST)[number]['id'];

export const VEGETATION_BY_ID: Readonly<Record<string, VegetationSpecies>> = Object.fromEntries(
  VEGETATION_MANIFEST.map((species) => [species.id, species]),
);
