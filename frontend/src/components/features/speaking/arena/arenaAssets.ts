/** Immutable URLs: Nginx caches public assets for one year. */
export const arenaCast = {
  LYRA: '/speaking/arena/lyra/cast-538d9dc8b304.glb',
  KAI: '/speaking/arena/kai/cast-b321f65719b0.glb',
} as const;

export const arenaArchipelagoAssets = {
  MOTORBOATS: { pelagic:'/speaking/arena/pelagic-8b3d562ac999.glb', tern:'/speaking/arena/tern-5f4034a79e02.glb' },
  ROWBOAT: '/speaking/arena/rowboat-43e277eda27f.glb',
  PROPS: '/speaking/arena/archipelago-props-6ea5df8a29ce.glb',
  TERRACE_PLANT: '/speaking/arena/terrace-plant-83c432b302aa.glb',
} as const;

export interface ArenaLodAssetUrls {
  readonly lod0: string;
  readonly lod1: string;
}

export interface ArenaPbrTextureSetUrls {
  readonly color: string;
  readonly normal: string;
  readonly orm: string;
}

const V7_BY_SLUG = {
  'palm-coconut-curved': {
    lod0: '/speaking/arena/v7/palm-coconut-curved-ccb95a8b7089.glb',
    lod1: '/speaking/arena/v7/palm-coconut-curved-lod1-79685169d2a6.glb',
  },
  'palm-royal-tall': {
    lod0: '/speaking/arena/v7/palm-royal-tall-f05a4c869c6d.glb',
    lod1: '/speaking/arena/v7/palm-royal-tall-lod1-13bad0f79116.glb',
  },
  'tree-tropical-banyan': {
    lod0: '/speaking/arena/v7/tree-tropical-banyan-95cfe6efbe4e.glb',
    lod1: '/speaking/arena/v7/tree-tropical-banyan-lod1-8dad954bb0a3.glb',
  },
  'tree-tropical-canopy': {
    lod0: '/speaking/arena/v7/tree-tropical-canopy-6b3671131443.glb',
    lod1: '/speaking/arena/v7/tree-tropical-canopy-lod1-ee51fa474281.glb',
  },
  'tree-mango-fruiting': {
    lod0: '/speaking/arena/v7/tree-mango-fruiting-892538f42789.glb',
    lod1: '/speaking/arena/v7/tree-mango-fruiting-lod1-c392b8428c59.glb',
  },
  'tree-banana-fruiting': {
    lod0: '/speaking/arena/v7/tree-banana-fruiting-a5570554e535.glb',
    lod1: '/speaking/arena/v7/tree-banana-fruiting-lod1-e58ee72ba41d.glb',
  },
  'bush-bougainvillea': {
    lod0: '/speaking/arena/v7/bush-bougainvillea-cc4266b7b725.glb',
    lod1: '/speaking/arena/v7/bush-bougainvillea-lod1-953420f5cced.glb',
  },
  'bush-hibiscus': {
    lod0: '/speaking/arena/v7/bush-hibiscus-083595f9ca43.glb',
    lod1: '/speaking/arena/v7/bush-hibiscus-lod1-f8fc9a15371b.glb',
  },
  'fern-tropical-cluster': {
    lod0: '/speaking/arena/v7/fern-tropical-cluster-875691ab53e4.glb',
    lod1: '/speaking/arena/v7/fern-tropical-cluster-lod1-c7f714f4562a.glb',
  },
  'grass-beach-dune': {
    lod0: '/speaking/arena/v7/grass-beach-dune-12426c5c777e.glb',
    lod1: '/speaking/arena/v7/grass-beach-dune-lod1-12426c5c777e.glb',
  },
  'karst-spire-tall': {
    lod0: '/speaking/arena/v7/karst-spire-tall-d2a0a38566e7.glb',
    lod1: '/speaking/arena/v7/karst-spire-tall-lod1-ecee3be63dce.glb',
  },
  'karst-arch-cove': {
    lod0: '/speaking/arena/v7/karst-arch-cove-56d870711a95.glb',
    lod1: '/speaking/arena/v7/karst-arch-cove-lod1-9cf49d69fddb.glb',
  },
  'rock-coastal-cluster': {
    lod0: '/speaking/arena/v7/rock-coastal-cluster-6c6e76abf665.glb',
    lod1: '/speaking/arena/v7/rock-coastal-cluster-lod1-9f80dd47278f.glb',
  },
  'pavilion-tropical-speaking': {
    lod0: '/speaking/arena/v7/pavilion-tropical-speaking-ff8db77b31c3.glb',
    lod1: '/speaking/arena/v7/pavilion-tropical-speaking-lod1-ba43615056a9.glb',
  },
  'village-stilt-house': {
    lod0: '/speaking/arena/v7/village-stilt-house-a7968deede40.glb',
    lod1: '/speaking/arena/v7/village-stilt-house-lod1-9bde5451e09a.glb',
  },
  'village-market-stall': {
    lod0: '/speaking/arena/v7/village-market-stall-b80b85672956.glb',
    lod1: '/speaking/arena/v7/village-market-stall-lod1-3343d8420856.glb',
  },
  'harbor-whale-monument': {
    lod0: '/speaking/arena/v7/harbor-whale-monument-929f6c5b8438.glb',
    lod1: '/speaking/arena/v7/harbor-whale-monument-lod1-06d223f3c1cf.glb',
  },
  'harbor-lighthouse': {
    lod0: '/speaking/arena/v7/harbor-lighthouse-bf0ceeb7b5ba.glb',
    lod1: '/speaking/arena/v7/harbor-lighthouse-lod1-9fbef546a4fe.glb',
  },
  'vessel-skiff': {
    lod0: '/speaking/arena/v7/vessel-skiff-6eb9d23cefe4.glb',
    lod1: '/speaking/arena/v7/vessel-skiff-lod1-d506dfe9b228.glb',
  },
  'vessel-sampan': {
    lod0: '/speaking/arena/v7/vessel-sampan-fc8eb38361a6.glb',
    lod1: '/speaking/arena/v7/vessel-sampan-lod1-a24aae80bb96.glb',
  },
  'vessel-pelagic': {
    lod0: '/speaking/arena/v7/vessel-pelagic-794618437f9e.glb',
    lod1: '/speaking/arena/v7/vessel-pelagic-lod1-0fe0079cdcf0.glb',
  },
  'vessel-tern': {
    lod0: '/speaking/arena/v7/vessel-tern-1dce75904422.glb',
    lod1: '/speaking/arena/v7/vessel-tern-lod1-9390ea4ad8f9.glb',
  },
  'vessel-cruiser': {
    lod0: '/speaking/arena/v7/vessel-cruiser-19b53e87b39d.glb',
    lod1: '/speaking/arena/v7/vessel-cruiser-lod1-9db51ddc00a2.glb',
  },
  'vessel-trawler': {
    lod0: '/speaking/arena/v7/vessel-trawler-3d6f6a480211.glb',
    lod1: '/speaking/arena/v7/vessel-trawler-lod1-333ce0fc5538.glb',
  },
  'vessel-sailboat': {
    lod0: '/speaking/arena/v7/vessel-sailboat-6fa931a4155f.glb',
    lod1: '/speaking/arena/v7/vessel-sailboat-lod1-a2363f2273b3.glb',
  },
  'prop-fishing-rod': {
    lod0: '/speaking/arena/v7/prop-fishing-rod-aedfd8f38ea7.glb',
    lod1: '/speaking/arena/v7/prop-fishing-rod-lod1-a3e8bbb1174f.glb',
  },
  'prop-bobber': {
    lod0: '/speaking/arena/v7/prop-bobber-6e0a803830c5.glb',
    lod1: '/speaking/arena/v7/prop-bobber-lod1-a19ea550e6af.glb',
  },
  'prop-fruits': {
    lod0: '/speaking/arena/v7/prop-fruits-fd8867545e51.glb',
    lod1: '/speaking/arena/v7/prop-fruits-lod1-e7b6d2b177ee.glb',
  },
} as const satisfies Record<string, ArenaLodAssetUrls>;

export type ArenaV7AssetSlug = keyof typeof V7_BY_SLUG;

/**
 * ECHO ARCHIPELAGO v7 — Content-hashed Zero-WASM 3D Asset Registry (`KHR_mesh_quantization` + `EXT_texture_webp`).
 * Zero runtime WASM decoders (`NO EXT_meshopt_compression`, `NO KHR_draco_mesh_compression`, `NO KHR_texture_basisu`).
 */
export const arenaV7Assets = {
  manifestUrl: '/speaking/arena/v7/v7-manifest.json',
  bySlug: V7_BY_SLUG,

  vegetation: {
    palmCoconutCurved: V7_BY_SLUG['palm-coconut-curved'],
    palmRoyalTall: V7_BY_SLUG['palm-royal-tall'],
    treeTropicalBanyan: V7_BY_SLUG['tree-tropical-banyan'],
    treeTropicalCanopy: V7_BY_SLUG['tree-tropical-canopy'],
    treeMangoFruiting: V7_BY_SLUG['tree-mango-fruiting'],
    treeBananaFruiting: V7_BY_SLUG['tree-banana-fruiting'],
    bushBougainvillea: V7_BY_SLUG['bush-bougainvillea'],
    bushHibiscus: V7_BY_SLUG['bush-hibiscus'],
    fernTropicalCluster: V7_BY_SLUG['fern-tropical-cluster'],
    grassBeachDune: V7_BY_SLUG['grass-beach-dune'],
  },

  landmarks: {
    karstSpireTall: V7_BY_SLUG['karst-spire-tall'],
    karstArchCove: V7_BY_SLUG['karst-arch-cove'],
    rockCoastalCluster: V7_BY_SLUG['rock-coastal-cluster'],
    pavilionTropicalSpeaking: V7_BY_SLUG['pavilion-tropical-speaking'],
    villageStiltHouse: V7_BY_SLUG['village-stilt-house'],
    villageMarketStall: V7_BY_SLUG['village-market-stall'],
    harborWhaleMonument: V7_BY_SLUG['harbor-whale-monument'],
    harborLighthouse: V7_BY_SLUG['harbor-lighthouse'],
  },

  vessels: {
    skiff: V7_BY_SLUG['vessel-skiff'],
    sampan: V7_BY_SLUG['vessel-sampan'],
    pelagic: V7_BY_SLUG['vessel-pelagic'],
    tern: V7_BY_SLUG['vessel-tern'],
    cruiser: V7_BY_SLUG['vessel-cruiser'],
    trawler: V7_BY_SLUG['vessel-trawler'],
    sailboat: V7_BY_SLUG['vessel-sailboat'],
  },

  props: {
    fishingRod: V7_BY_SLUG['prop-fishing-rod'],
    bobber: V7_BY_SLUG['prop-bobber'],
    fruits: V7_BY_SLUG['prop-fruits'],
  },

  pbr: {
    sandGolden: {
      color: '/speaking/arena/v7/pbr/sand_golden-color-34227a9e9682.webp',
      normal: '/speaking/arena/v7/pbr/sand_golden-normal-5bb7135286d9.webp',
      orm: '/speaking/arena/v7/pbr/sand_golden-orm-e9b84a4db83b.webp',
    },
    limestoneKarst: {
      color: '/speaking/arena/v7/pbr/limestone_karst-color-2038a08b8413.webp',
      normal: '/speaking/arena/v7/pbr/limestone_karst-normal-39da7170c5aa.webp',
      orm: '/speaking/arena/v7/pbr/limestone_karst-orm-6972cd197620.webp',
    },
    woodPierWeathered: {
      color: '/speaking/arena/v7/pbr/wood_pier_weathered-color-554bf0e802ff.webp',
      normal: '/speaking/arena/v7/pbr/wood_pier_weathered-normal-55c3e7e635e6.webp',
      orm: '/speaking/arena/v7/pbr/wood_pier_weathered-orm-0286c85e8cb9.webp',
    },
    stoneHarborTravertine: {
      color: '/speaking/arena/v7/pbr/stone_harbor_travertine-color-6521a2df80c4.webp',
      normal: '/speaking/arena/v7/pbr/stone_harbor_travertine-normal-ee0451ad735a.webp',
      orm: '/speaking/arena/v7/pbr/stone_harbor_travertine-orm-e8e515e86f5f.webp',
    },
  } satisfies Record<string, ArenaPbrTextureSetUrls>,

  env: {
    clarensMiddayHdr: '/speaking/arena/v7/env/clarens_midday_1k-0b73f9b71d16.hdr',
    belfastSunsetHdr: '/speaking/arena/v7/env/belfast_sunset_1k-cec532d8dd38.hdr',
    clarensMiddaySkyWebp: '/speaking/arena/v7/env/clarens_midday_sky-53b573fc472a.webp',
  },
} as const;
