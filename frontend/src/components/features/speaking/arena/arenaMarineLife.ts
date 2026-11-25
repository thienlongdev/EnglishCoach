/**
 * ECHO ARCHIPELAGO — 14-Species Anatomical 3D Marine Ecosystem, Zero-GC SoA Boids,
 * Physical Fish-to-Bait-to-Fight AI, Underwater Spectral Optics, and Synchronized Surface Shadows.
 *
 * Portions adapted from Abyssal Garden — Copyright (c) 2026 Maksymilian Dendura, MIT License.
 *
 * Architectural Highlights:
 * - Complete 14-species catalog (`MARINE_SPECIES`) with realistic weights/lengths, island habitats,
 *   depth bands, rarity, English descriptive vocabulary, and bilingual speaking prompts.
 * - 11 closed-manifold procedural 3D body-plan `InstancedMesh` batches (`G0..G10`):
 *   13-station superellipse hulls, double-sided hydrofoil fins (dorsal, 2nd dorsal, finlets,
 *   pectoral, pelvic, anal, lunate/heterocercal/hypocercal caudal, Moorish Idol whip pennant,
 *   Flying Fish biplane wings, Manta cephalic lobes, Eagle Ray duck-bill snout, volumetric 3D
 *   Sea Turtle head/flippers), and raised 3D corneal eyes (`partId = 4`).
 * - Analytical deformed vertex normals + explicit procedural markings for all 14 `pat` IDs +
 *   `bindUnderwaterOptics()` integration with `UNDERWATER_OPTICS_GLSL` (`tWater` caustics,
 *   `tZoneMap` grotto bioluminescence, `tShadow` PCF sunbeams, Beer-Lambert volumetric fog).
 * - 36 ecologically placed schools covering all 10 pier/shore `fishing_spot` cast zones, shallow
 *   surface-shadow lagoons, and 4 deep Abyssal Garden biomes, with `> 180 m` distance + frustum
 *   culling that skips dynamic `bufferSubData` uploads on unseen schools.
 * - Cone-free physical SoA Fish AI (`FREE_BOIDS -> APPROACHING_BAIT -> INVESTIGATING_BAIT ->
 *   BITING -> HOOKED_FIGHTING -> CAUGHT_HELD -> ESCAPING_OR_RELEASED`) driving real 3D fish nose
 *   nibbles, strikes, 3D lateral/diving/leaping line fights, and catch-and-release splash-backs.
 */

import * as T from 'three';
import type {
  ActiveBaitDescriptor,
  ArenaQualityTier,
  MarineSpeciesSpec,
  SurfaceFishSchool,
} from './arenaContracts';
import { arenaWaveHeight } from './arenaSea';
import {
  ARENA_BOAT_LIMIT,
  ARENA_WATER_Y,
  arenaBathymetry,
  arenaDryWalkable,
  arenaIslandAt,
  arenaLayout,
  arenaWaterDepth,
} from './arenaTerrain';
import { arenaSwimGroundY } from './arenaSwimming';
import { UNDERWATER_OPTICS_GLSL, type SharedUnderwaterUniforms } from './arenaUnderwaterShaders';

export const MARINE_SPECIES: readonly MarineSpeciesSpec[] = [
  {
    id: 'clownfish',
    nameEn: 'Ocellaris Clownfish',
    nameVi: 'Cá hề san hô',
    scientificName: 'Amphiprion ocellaris',
    habitatEn: 'Coral Lagoon sea anemones and warm shallow reefs',
    habitatVi: 'Hải quỳ đầm san hô và rạn nước nông ấm áp',
    islandZoneIds: ['coral_lagoon', 'tropical_beach', 'reef', 'strand'],
    rarity: 'common',
    minWeightKg: 0.08,
    maxWeightKg: 0.28,
    minLengthCm: 7,
    maxLengthCm: 12,
    depthMin: 0.5,
    depthMax: 4.5,
    schooling: true,
    resistance: 0.22,
    colorPrimary: '#f46d25',
    colorAccent: '#ffffff',
    vocabWords: ['anemone', 'symbiotic', 'vibrant', 'stripes', 'shelter'],
    speakingPromptEn:
      'Describe how the clownfish and sea anemone protect each other, then share an example of great teamwork in your own life.',
    speakingPromptVi:
      'Miêu tả mối quan hệ cộng sinh giữa cá hề và hải quỳ bằng tiếng Anh, rồi kể một ví dụ về tinh thần đồng đội của bạn.',
  },
  {
    id: 'butterflyfish',
    nameEn: 'Threadfin Butterflyfish',
    nameVi: 'Cá bướm chỉ vàng',
    scientificName: 'Chaetodon auriga',
    habitatEn: 'Coral Lagoon gardens and Tropical Beach shallows',
    habitatVi: 'Vườn san hô và vùng nước nông bãi biển nhiệt đới',
    islandZoneIds: ['coral_lagoon', 'tropical_beach', 'commons', 'green_mountain'],
    rarity: 'common',
    minWeightKg: 0.12,
    maxWeightKg: 0.42,
    minLengthCm: 12,
    maxLengthCm: 21,
    depthMin: 0.6,
    depthMax: 6.0,
    schooling: true,
    resistance: 0.26,
    colorPrimary: '#f6cf3f',
    colorAccent: '#1e293b',
    vocabWords: ['delicate', 'chevron', 'agile', 'coral polyps', 'graceful'],
    speakingPromptEn:
      'Use vivid color and pattern adjectives to describe this butterflyfish to a partner who has not seen it yet.',
    speakingPromptVi:
      'Dùng các tính từ miêu tả màu sắc và hoa văn sống động bằng tiếng Anh để tả loài cá bướm này cho bạn cùng phòng.',
  },
  {
    id: 'angelfish',
    nameEn: 'Regal Angelfish',
    nameVi: 'Cá thiên thần hoàng gia',
    scientificName: 'Pygoplites diacanthus',
    habitatEn: 'Coral Lagoon ledges and Karst Cove overhangs',
    habitatVi: 'Bậc thềm đầm san hô và vách đá vôi rợp bóng',
    islandZoneIds: ['coral_lagoon', 'karst_bay', 'green_mountain', 'reef'],
    rarity: 'uncommon',
    minWeightKg: 0.25,
    maxWeightKg: 0.78,
    minLengthCm: 15,
    maxLengthCm: 26,
    depthMin: 1.1,
    depthMax: 9.0,
    schooling: true,
    resistance: 0.36,
    colorPrimary: '#f59e0b',
    colorAccent: '#3b82f6',
    vocabWords: ['iridescent', 'striking', 'reef ledge', 'dorsal fin', 'ornate'],
    speakingPromptEn:
      'Compare the bold stripes of the regal angelfish with camouflaged fish. Why might bright colors help on a coral reef?',
    speakingPromptVi:
      'So sánh những dải màu rực rỡ của cá thiên thần với loài cá ngụy trang và thảo luận vì sao màu sáng lại hữu ích nơi rạn san hô.',
  },
  {
    id: 'surgeonfish',
    nameEn: 'Pacific Blue Tang',
    nameVi: 'Cá đuôi gai xanh',
    scientificName: 'Paracanthurus hepatus',
    habitatEn: 'Sunlit reef crests and Harbor timber pilings',
    habitatVi: 'Đỉnh rạn san hô ngập nắng và chân cầu cảng gỗ',
    islandZoneIds: ['commons', 'coral_lagoon', 'tropical_beach', 'fishing_village'],
    rarity: 'common',
    minWeightKg: 0.3,
    maxWeightKg: 0.85,
    minLengthCm: 16,
    maxLengthCm: 30,
    depthMin: 0.7,
    depthMax: 8.0,
    schooling: true,
    resistance: 0.34,
    colorPrimary: '#1d74e8',
    colorAccent: '#facc15',
    vocabWords: ['cobalt', 'herbivore', 'algae', 'shoal', 'streamlined'],
    speakingPromptEn:
      'Blue tangs graze on algae so corals can breathe. Explain in English how small daily habits keep an environment healthy.',
    speakingPromptVi:
      'Cá đuôi gai ăn tảo giúp san hô phát triển khỏe mạnh. Hãy giải thích bằng tiếng Anh cách những thói quen nhỏ giữ gìn môi trường.',
  },
  {
    id: 'parrotfish',
    nameEn: 'Rainbow Parrotfish',
    nameVi: 'Cá vẹt ngũ sắc',
    scientificName: 'Scarus guacamaia',
    habitatEn: 'Coral Lagoon slopes and sandy beach reefs',
    habitatVi: 'Sườn đầm san hô và rạn cát ven bãi biển',
    islandZoneIds: ['coral_lagoon', 'tropical_beach', 'fishing_village', 'green_mountain'],
    rarity: 'uncommon',
    minWeightKg: 1.2,
    maxWeightKg: 4.8,
    minLengthCm: 32,
    maxLengthCm: 68,
    depthMin: 0.9,
    depthMax: 10.0,
    schooling: true,
    resistance: 0.52,
    colorPrimary: '#14b8a6',
    colorAccent: '#f97316',
    vocabWords: ['beak-like', 'turquoise', 'white sand', 'ecosystem', 'shimmering'],
    speakingPromptEn:
      'Did you know parrotfish create tropical white beach sand by nibbling coral rock? Retell this surprising fact in your own words.',
    speakingPromptVi:
      'Bạn có biết cá vẹt tạo ra cát trắng mịn cho bãi biển nhiệt đới không? Hãy kể lại điều thú vị này theo cách diễn đạt tiếng Anh của bạn.',
  },
  {
    id: 'moorish_idol',
    nameEn: 'Moorish Idol',
    nameVi: 'Cá thần tượng',
    scientificName: 'Zanclus cornutus',
    habitatEn: 'Karst Bay arches and clear Coral Lagoon channels',
    habitatVi: 'Vòm đá vịnh Karst và luồng nước trong vắt đầm san hô',
    islandZoneIds: ['karst_bay', 'coral_lagoon', 'green_mountain', 'outer_archipelago'],
    rarity: 'rare',
    minWeightKg: 0.18,
    maxWeightKg: 0.55,
    minLengthCm: 14,
    maxLengthCm: 24,
    depthMin: 1.2,
    depthMax: 11.0,
    schooling: true,
    resistance: 0.44,
    colorPrimary: '#f8fafc',
    colorAccent: '#eab308',
    vocabWords: ['pennant', 'crest', 'contrasting', 'silhouette', 'slender'],
    speakingPromptEn:
      'Describe the dramatic black, white, and gold silhouette of the Moorish idol so clearly a listener could sketch it.',
    speakingPromptVi:
      'Miêu tả dáng vẻ đen, trắng và vàng đặc trưng của cá thần tượng thật rõ ràng để người nghe có thể phác họa lại.',
  },
  {
    id: 'grouper',
    nameEn: 'Coral Trout Grouper',
    nameVi: 'Cá mú chấm san hô',
    scientificName: 'Plectropomus leopardus',
    habitatEn: 'Fishing Village piers and submerged Karst boulders',
    habitatVi: 'Cầu cảng làng chài và các tảng đá ngầm ven vịnh',
    islandZoneIds: ['fishing_village', 'karst_bay', 'commons', 'lighthouse'],
    rarity: 'uncommon',
    minWeightKg: 1.8,
    maxWeightKg: 7.6,
    minLengthCm: 38,
    maxLengthCm: 78,
    depthMin: 1.8,
    depthMax: 14.0,
    schooling: false,
    resistance: 0.64,
    colorPrimary: '#dc4b3e',
    colorAccent: '#38bdf8',
    vocabWords: ['ambush', 'crimson', 'spotted', 'crevice', 'patient'],
    speakingPromptEn:
      'Talk about coastal cuisine and sustainable fishing: how can island communities protect slow-growing reef groupers?',
    speakingPromptVi:
      'Trò chuyện về ẩm thực biển và đánh bắt bền vững: cộng đồng cư dân đảo có thể bảo vệ loài cá mú san hô như thế nào?',
  },
  {
    id: 'mackerel',
    nameEn: 'Spanish Mackerel',
    nameVi: 'Cá thu vạch biển khơi',
    scientificName: 'Scomberomorus commerson',
    habitatEn: 'Harbor shipping channels and Fishing Village currents',
    habitatVi: 'Luồng tàu bến cảng và dòng hải lưu làng chài',
    islandZoneIds: ['commons', 'fishing_village', 'tropical_beach', 'green_mountain'],
    rarity: 'common',
    minWeightKg: 1.1,
    maxWeightKg: 4.4,
    minLengthCm: 40,
    maxLengthCm: 82,
    depthMin: 0.4,
    depthMax: 6.5,
    schooling: true,
    resistance: 0.58,
    colorPrimary: '#6495b8',
    colorAccent: '#e2e8f0',
    vocabWords: ['metallic', 'swift', 'migratory', 'silver-flanked', 'synchronized'],
    speakingPromptEn:
      'Mackerel swim in fast synchronized silver schools near the surface. Describe a moment when a group moved in harmony.',
    speakingPromptVi:
      'Cá thu bơi thành đàn ánh bạc đồng điệu sát mặt nước. Hãy kể bằng tiếng Anh về một khoảnh khắc tập thể phối hợp nhịp nhàng.',
  },
  {
    id: 'yellowfin_tuna',
    nameEn: 'Yellowfin Tuna',
    nameVi: 'Cá ngừ vây vàng',
    scientificName: 'Thunnus albacares',
    habitatEn: 'Outer Archipelago deep sapphire channels',
    habitatVi: 'Luồng nước sâu xanh thẫm ngoài khơi quần đảo',
    islandZoneIds: ['outer_archipelago', 'lighthouse', 'karst_bay', 'coral_lagoon'],
    rarity: 'rare',
    minWeightKg: 6.5,
    maxWeightKg: 28.0,
    minLengthCm: 65,
    maxLengthCm: 135,
    depthMin: 2.2,
    depthMax: 18.0,
    schooling: true,
    resistance: 0.86,
    colorPrimary: '#1e3a8a',
    colorAccent: '#facc15',
    vocabWords: ['pelagic', 'endurance', 'hydrodynamic', 'sickle-finned', 'open ocean'],
    speakingPromptEn:
      'Yellowfin tuna cross entire oceans without stopping. Share a long-term goal that requires steady endurance and focus.',
    speakingPromptVi:
      'Cá ngừ vây vàng vượt đại dương không ngừng nghỉ. Hãy chia sẻ một mục tiêu dài hạn đòi hỏi sự bền bỉ và tập trung của bạn.',
  },
  {
    id: 'flying_fish',
    nameEn: 'Tropical Flying Fish',
    nameVi: 'Cá chuồn cánh bạc',
    scientificName: 'Exocoetus volitans',
    habitatEn: 'Open sea boat lanes and sunlit breezy swells',
    habitatVi: 'Hải trình tàu thuyền ngoài khơi và sóng lộng nắng',
    islandZoneIds: ['commons', 'tropical_beach', 'fishing_village', 'outer_archipelago', 'lighthouse'],
    rarity: 'uncommon',
    minWeightKg: 0.18,
    maxWeightKg: 0.52,
    minLengthCm: 18,
    maxLengthCm: 30,
    depthMin: 0.0,
    depthMax: 2.6,
    schooling: true,
    resistance: 0.42,
    colorPrimary: '#2563eb',
    colorAccent: '#bae6fd',
    vocabWords: ['airborne', 'gliding', 'pectoral wings', 'leap', 'sea spray'],
    speakingPromptEn:
      'Have you ever seen flying fish glide beside a boat? Describe how they leap above the waves and skim the breeze.',
    speakingPromptVi:
      'Bạn đã từng thấy cá chuồn lướt cạnh mạn thuyền chưa? Hãy miêu tả cảnh chúng vọt lên khỏi ngọn sóng bằng tiếng Anh.',
  },
  {
    id: 'manta_ray',
    nameEn: 'Giant Reef Manta Ray',
    nameVi: 'Cá đuối ó khổng lồ',
    scientificName: 'Mobula alfredi',
    habitatEn: 'Coral Lagoon Kelp Cathedral and deep outer channels (Protected Wildlife)',
    habitatVi: 'Thung lũng tảo bẹ đầm san hô và luồng biển sâu (Sinh vật được bảo tồn)',
    islandZoneIds: ['coral_lagoon', 'outer_archipelago', 'lighthouse', 'karst_bay'],
    rarity: 'legendary',
    minWeightKg: 180.0,
    maxWeightKg: 420.0,
    minLengthCm: 260,
    maxLengthCm: 420,
    depthMin: 1.0,
    depthMax: 16.0,
    schooling: false,
    resistance: 1.0,
    colorPrimary: '#1e293b',
    colorAccent: '#e2e8f0',
    vocabWords: ['wingspan', 'majestic', 'filter feeder', 'effortless', 'sanctuary'],
    speakingPromptEn:
      'Dive beneath the waves to watch the giant reef manta glide past. Describe what makes marine sanctuaries inspiring to visit.',
    speakingPromptVi:
      'Lặn xuống làn nước trong để ngắm cá đuối ó khổng lồ lướt qua và chia sẻ điều khiến các khu bảo tồn biển trở nên cuốn hút.',
  },
  {
    id: 'eagle_ray',
    nameEn: 'Spotted Eagle Ray',
    nameVi: 'Cá đuối đại bàng đốm trắng',
    scientificName: 'Aetobatus narinari',
    habitatEn: 'Tropical Beach sandbars and turquoise lagoon flats',
    habitatVi: 'Cồn cát bãi biển nhiệt đới và thềm đầm ngọc bích',
    islandZoneIds: ['tropical_beach', 'coral_lagoon', 'commons', 'fishing_village'],
    rarity: 'rare',
    minWeightKg: 8.5,
    maxWeightKg: 26.0,
    minLengthCm: 95,
    maxLengthCm: 165,
    depthMin: 0.9,
    depthMax: 12.0,
    schooling: true,
    resistance: 0.78,
    colorPrimary: '#172554',
    colorAccent: '#f8fafc',
    vocabWords: ['constellation', 'dappled', 'sandbar', 'undulating', 'wings'],
    speakingPromptEn:
      'Spotted eagle rays look like starry night skies gliding over white sand. Use a metaphor or simile in English to describe them.',
    speakingPromptVi:
      'Cá đuối đại bàng đốm trắng tựa bầu trời sao lướt trên nền cát. Hãy dùng một phép so sánh hoặc ẩn dụ tiếng Anh để miêu tả chúng.',
  },
  {
    id: 'sea_turtle',
    nameEn: 'Green Sea Turtle',
    nameVi: 'Rùa biển xanh',
    scientificName: 'Chelonia mydas',
    habitatEn: 'Tropical Beach seagrass beds and calm coves (Protected Wildlife)',
    habitatVi: 'Thảm cỏ biển vịnh êm và bãi cát nhiệt đới (Sinh vật được bảo tồn)',
    islandZoneIds: ['tropical_beach', 'coral_lagoon', 'green_mountain', 'commons'],
    rarity: 'rare',
    minWeightKg: 42.0,
    maxWeightKg: 115.0,
    minLengthCm: 72,
    maxLengthCm: 112,
    depthMin: 0.7,
    depthMax: 12.0,
    schooling: false,
    resistance: 0.9,
    colorPrimary: '#3f6212',
    colorAccent: '#d99b52',
    vocabWords: ['carapace', 'seagrass', 'ancient', 'navigation', 'conservation'],
    speakingPromptEn:
      'Sea turtles return to the exact beach where they hatched decades later. Discuss how we can keep beaches safe for wildlife.',
    speakingPromptVi:
      'Rùa biển quay về đúng bãi cát nơi chúng chào đời sau hàng chục năm. Hãy thảo luận cách giữ bãi biển an toàn cho sinh vật hoang dã.',
  },
  {
    id: 'reef_shark',
    nameEn: 'Blacktip Reef Shark',
    nameVi: 'Cá mập vây đen rạn san hô',
    scientificName: 'Carcharhinus melanopterus',
    habitatEn: 'Remote Outer Islands drop-offs and lighthouse channels',
    habitatVi: 'Rìa vực nước sâu đảo xa và luồng quanh hải đăng',
    islandZoneIds: ['outer_archipelago', 'lighthouse'],
    rarity: 'legendary',
    minWeightKg: 9.5,
    maxWeightKg: 24.0,
    minLengthCm: 95,
    maxLengthCm: 155,
    depthMin: 2.0,
    depthMax: 18.0,
    schooling: false,
    resistance: 0.94,
    colorPrimary: '#64748b',
    colorAccent: '#0f172a',
    vocabWords: ['apex', 'sleek', 'dorsal tip', 'misunderstood', 'balance'],
    speakingPromptEn:
      'Blacktip reef sharks are calm, shy guardians of reef balance. Discuss an animal that people often misunderstand.',
    speakingPromptVi:
      'Cá mập vây đen thực ra rất hiền hòa và giữ cân bằng sinh thái rạn san hô. Hãy nói về một loài vật thường bị con người hiểu lầm.',
  },
] as const;

export const MARINE_SPECIES_BY_ID: Readonly<Record<string, MarineSpeciesSpec>> = Object.freeze(
  Object.fromEntries(MARINE_SPECIES.map(s => [s.id, s])),
);

const PROTECTED_SCENIC_IDS = new Set<string>(['manta_ray', 'sea_turtle']);

export function isProtectedScenicSpecies(speciesId: string): boolean {
  return PROTECTED_SCENIC_IDS.has(speciesId);
}

/** Catch-and-release fish species eligible for rod angling (12 species; manta_ray and sea_turtle stay protected). */
export const CATCHABLE_MARINE_SPECIES: readonly MarineSpeciesSpec[] = Object.freeze(
  MARINE_SPECIES.filter(s => !isProtectedScenicSpecies(s.id)),
);

/**
 * 11 Distinct Closed-Manifold Anatomical 3D Body Plans (`G0..G10`).
 */
export type BodyPlanGroup =
  | 0  // G0: Anemonefish (clownfish)
  | 1  // G1: Laterally-compressed Discoid Reef (butterflyfish, angelfish)
  | 2  // G2: Zanclid Pennant Disc with streaming whip pennant (moorish_idol)
  | 3  // G3: Oval-fusiform Reef Grazer with fused Scaridae beak (surgeonfish, parrotfish)
  | 4  // G4: Heavy-bodied Demersal Serranid (grouper)
  | 5  // G5: Pelagic Thunniform Scombrid with finlets and lunate tail (mackerel, yellowfin_tuna)
  | 6  // G6: Exocoetid Biplane Glider with pectoral + pelvic glide wings and hypocercal tail (flying_fish)
  | 7  // G7: Giant Reef Manta Ray with curling cephalic lobes (manta_ray)
  | 8  // G8: Spotted Eagle Ray with projecting duck-bill snout and domed rostrum (eagle_ray)
  | 9  // G9: Volumetric 3D Green Sea Turtle with 3D head/beak and twisted hydrofoil flippers (sea_turtle)
  | 10; // G10: Carcharhinid Reef Shark with 1st/2nd dorsal, pelvic/anal, and heterocercal tail (reef_shark)

const BODY_GROUP_COUNT = 11;

export const SPECIES_BODY_GROUP: Readonly<Record<string, BodyPlanGroup>> = Object.freeze({
  clownfish: 0,
  butterflyfish: 1,
  angelfish: 1,
  moorish_idol: 2,
  surgeonfish: 3,
  parrotfish: 3,
  grouper: 4,
  mackerel: 5,
  yellowfin_tuna: 5,
  flying_fish: 6,
  manta_ray: 7,
  eagle_ray: 8,
  sea_turtle: 9,
  reef_shark: 10,
});

export const SPECIES_PATTERN_ID: Readonly<Record<string, number>> = Object.freeze({
  clownfish: 1,
  butterflyfish: 2,
  angelfish: 3,
  surgeonfish: 4,
  parrotfish: 5,
  moorish_idol: 6,
  grouper: 7,
  mackerel: 8,
  yellowfin_tuna: 9,
  flying_fish: 10,
  manta_ray: 11,
  eagle_ray: 12,
  sea_turtle: 13,
  reef_shark: 14,
});

/** Exact local +Z snout/mouth coordinate per BodyPlanGroup so hooked 3D fish lock mouth-to-hook at 0.0 mm error. */
const GROUP_MOUTH_LOCAL_Z = new Float32Array([
  0.495, // G0 clownfish
  0.525, // G1 butterflyfish / angelfish
  0.575, // G2 moorish_idol tubular snout
  0.525, // G3 surgeonfish / parrotfish beak
  0.545, // G4 grouper lower jaw
  0.580, // G5 mackerel / yellowfin_tuna
  0.535, // G6 flying_fish
  0.520, // G7 manta_ray
  0.750, // G8 eagle_ray duck-bill snout
  0.680, // G9 sea_turtle beak
  0.620, // G10 reef_shark subterminal mouth/snout
]);

const GROUP_MOUTH_LOCAL_Y = new Float32Array([
  -0.010, // G0
  -0.015, // G1
  -0.025, // G2
  -0.018, // G3
  -0.012, // G4
  -0.008, // G5
  -0.005, // G6
  -0.020, // G7
  -0.032, // G8
  0.010,  // G9
  -0.038, // G10 shark ventral-subterminal mouth
]);

/**
 * Physical Fish-to-Bait-to-Fight AI States (`F06`).
 */
export const FISH_AI_STATE = Object.freeze({
  FREE_BOIDS: 0,
  APPROACHING_BAIT: 1,
  INVESTIGATING_BAIT: 2,
  BITING: 3,
  HOOKED_FIGHTING: 4,
  CAUGHT_HELD: 5,
  ESCAPING_OR_RELEASED: 6,
} as const);

export type FishAiStateCode = (typeof FISH_AI_STATE)[keyof typeof FISH_AI_STATE];

/**
 * 3-Phase Autonomous Ballistic Surface-Leap States (`FREE_BOIDS` ocean breach & splash cycle).
 */
export const FISH_LEAP_PHASE = Object.freeze({
  NONE: 0,
  LAUNCH_ASCENT: 1,
  AIRBORNE: 2,
  RECOVERY_DIVE: 3,
} as const);

export type FishLeapPhaseCode = (typeof FISH_LEAP_PHASE)[keyof typeof FISH_LEAP_PHASE];

/**
 * Emitted whenever a leaping fish breaches upward through `waveY` (`'exit'`) or plunges back
 * into the ocean (`'reentry'`), drained via `consumeLeapSplashes()` so `ArenaScene.tsx` can drive
 * `world.sea.triggerSurfaceSplash(ev.x, ev.z, ev.strength, ev.radius)`.
 */
export interface FishLeapSplashEvent {
  kind: 'exit' | 'reentry';
  x: number;
  y: number;
  z: number;
  strength: number;
  radius: number;
}

const LEAP_ELIGIBLE_SPECIES = new Set<string>([
  'flying_fish',
  'mackerel',
  'mahimahi',
  'yellowfin_tuna',
  'surgeonfish',
  'parrotfish',
]);

function normalizeAngleDelta(rad: number): number {
  let d = rad % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic Mulberry32 PRNG matching Abyssal Garden `math.js`. */
function createSeededRandom(seedInit: number): () => number {
  let s = (20261110 + Math.imul(seedInit, 7919)) | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function superellipseCoord(unitTrig: number, expP: number): number {
  const a = Math.abs(unitTrig);
  if (a < 1e-6) return 0;
  return (unitTrig < 0 ? -1 : 1) * Math.pow(a, 2 / expP);
}

// ============================================================================
// 1. Closed-Manifold 13-Station Superellipse + Hydrofoil Fin + 3D Eye Builders
// Local space convention: +Z = forward nose/mouth, +Y = dorsal up, +X = lateral
// aAux: x = spineU (0..1.35), y = span/eyeU (-1..1), z = dorsal (-1..1),
//       w = partId (0=hull, 1=median fin, 2=pectoral/fore-flipper, 3=pelvic/pennant, 4=3D eye)
// ============================================================================

interface SculptBuffers {
  pos: number[];
  aux: number[];
  idx: number[];
}

function createSculptBuffers(): SculptBuffers {
  return { pos: [], aux: [], idx: [] };
}

function finalizeSculptedGeometry(b: SculptBuffers): T.BufferGeometry {
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute('aAux', new T.Float32BufferAttribute(b.aux, 4));
  geo.setIndex(b.idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Extrudes a closed double-sided symmetric median hydrofoil fin in the YZ plane (`x = ±thick`).
 * Separate left/right faces + closed leading/tip/trailing seam give crisp 3D normals and non-zero edge width.
 */
function appendMedianHydrofoilFin(
  b: SculptBuffers,
  stations: readonly {
    rz: number;
    ry: number;
    tz: number;
    ty: number;
    uRoot: number;
    uTip: number;
    dorsalRoot: number;
    dorsalTip: number;
  }[],
  rootHalfThick: number,
  partId: number,
): void {
  const n = stations.length;
  if (n < 2) return;

  const rightRoot: number[] = [];
  const leftRoot: number[] = [];
  const tipShared: number[] = [];

  for (let i = 0; i < n; i++) {
    const st = stations[i];
    const endTaper = i === 0 || i === n - 1 ? 0.18 : 1.0;
    const th = rootHalfThick * endTaper;

    const vr = b.pos.length / 3;
    b.pos.push(th, st.ry, st.rz);
    b.aux.push(st.uRoot, 0.08, st.dorsalRoot, partId);
    rightRoot.push(vr);

    const vl = b.pos.length / 3;
    b.pos.push(-th, st.ry, st.rz);
    b.aux.push(st.uRoot, -0.08, st.dorsalRoot, partId);
    leftRoot.push(vl);

    const vt = b.pos.length / 3;
    b.pos.push(0, st.ty, st.tz);
    b.aux.push(st.uTip, 0, st.dorsalTip, partId);
    tipShared.push(vt);
  }

  // Ensure outward normals on both +X (right) and -X (left) faces regardless of station ordering
  const s0 = stations[0];
  const s1 = stations[n - 1];
  const dz = s1.rz - s0.rz;
  const dyTip = s0.ty - s0.ry;
  // Vector along stations = (0, ~0, dz); vector root->tip = (0, dyTip, *)
  // Cross((0, dyTip, 0), (0, 0, dz)) = (dyTip * dz, 0, 0). Want +X on right face!
  const flip = dyTip * dz < 0;

  for (let i = 0; i < n - 1; i++) {
    const rr0 = rightRoot[i];
    const rr1 = rightRoot[i + 1];
    const lr0 = leftRoot[i];
    const lr1 = leftRoot[i + 1];
    const t0 = tipShared[i];
    const t1 = tipShared[i + 1];

    if (!flip) {
      b.idx.push(rr0, t0, t1, rr0, t1, rr1);
      b.idx.push(lr0, t1, t0, lr0, lr1, t1);
      b.idx.push(rr0, rr1, lr1, rr0, lr1, lr0);
    } else {
      b.idx.push(rr0, t1, t0, rr0, rr1, t1);
      b.idx.push(lr0, t0, t1, lr0, t1, lr1);
      b.idx.push(rr0, lr1, rr1, rr0, lr0, lr1);
    }
  }

  // Seal leading (i=0) and trailing (i=n-1) root-to-tip triangular end-caps for watertightness
  if (!flip) {
    b.idx.push(rightRoot[0], leftRoot[0], tipShared[0]);
    b.idx.push(leftRoot[n - 1], rightRoot[n - 1], tipShared[n - 1]);
  } else {
    b.idx.push(leftRoot[0], rightRoot[0], tipShared[0]);
    b.idx.push(rightRoot[n - 1], leftRoot[n - 1], tipShared[n - 1]);
  }
}

/**
 * Extrudes bilateral left/right volumetric hydrofoil paired fins (pectorals, pelvics, glide wings, flippers).
 * `stations` run from root (`spanFrac = 0`) to wingtip (`spanFrac = 1`).
 */
function appendPairedHydrofoilFin(
  b: SculptBuffers,
  stations: readonly {
    spanFrac: number;
    xAbs: number;
    y: number;
    zLead: number;
    zTrail: number;
    thick: number;
    uLead: number;
    uTrail: number;
    dorsalVal: number;
  }[],
  partId: number,
): void {
  const n = stations.length;
  if (n < 2) return;

  for (const side of [-1, 1] as const) {
    const topLead: number[] = [];
    const botLead: number[] = [];
    const trailEdge: number[] = [];

    for (let i = 0; i < n; i++) {
      const st = stations[i];
      const x = side * st.xAbs;
      const sp = side * st.spanFrac;
      const zMid = st.zLead * 0.68 + st.zTrail * 0.32;
      const uMid = st.uLead * 0.68 + st.uTrail * 0.32;

      const vLead = b.pos.length / 3;
      b.pos.push(x, st.y, st.zLead);
      b.aux.push(st.uLead, sp, st.dorsalVal, partId);

      const vTop = b.pos.length / 3;
      b.pos.push(x, st.y + st.thick, zMid);
      b.aux.push(uMid, sp, st.dorsalVal + 0.08, partId);

      const vBot = b.pos.length / 3;
      b.pos.push(x, st.y - st.thick * 0.85, zMid);
      b.aux.push(uMid, sp, st.dorsalVal - 0.08, partId);

      const vTrail = b.pos.length / 3;
      b.pos.push(x, st.y, st.zTrail);
      b.aux.push(st.uTrail, sp, st.dorsalVal, partId);

      topLead.push(vLead, vTop);
      botLead.push(vBot);
      trailEdge.push(vTrail);
    }

    for (let i = 0; i < n - 1; i++) {
      const l0 = topLead[i * 2];
      const tp0 = topLead[i * 2 + 1];
      const bt0 = botLead[i];
      const tr0 = trailEdge[i];

      const l1 = topLead[(i + 1) * 2];
      const tp1 = topLead[(i + 1) * 2 + 1];
      const bt1 = botLead[i + 1];
      const tr1 = trailEdge[i + 1];

      if (side > 0) {
        // +X span: (span +X) x (chord -Z) = +Y outward on top!
        b.idx.push(l0, l1, tp1, l0, tp1, tp0);
        b.idx.push(tp0, tp1, tr1, tp0, tr1, tr0);
        b.idx.push(l0, bt0, bt1, l0, bt1, l1);
        b.idx.push(bt0, tr0, tr1, bt0, tr1, bt1);
      } else {
        b.idx.push(l0, tp1, l1, l0, tp0, tp1);
        b.idx.push(tp0, tr1, tp1, tp0, tr0, tr1);
        b.idx.push(l0, bt1, bt0, l0, l1, bt1);
        b.idx.push(bt0, tr1, tr0, bt0, bt1, tr1);
      }
    }

    // Seal root (i=0) and wingtip (i=n-1) airfoil cross-sections
    const sealCap = (i: number, outwardSign: number) => {
      const l = topLead[i * 2];
      const tp = topLead[i * 2 + 1];
      const bt = botLead[i];
      const tr = trailEdge[i];
      if (outwardSign > 0) {
        b.idx.push(l, tp, tr, l, tr, bt);
      } else {
        b.idx.push(l, tr, tp, l, bt, tr);
      }
    };
    sealCap(0, side);
    sealCap(n - 1, -side);
  }
}

/**
 * Adds raised 3D hemispherical corneal eyes (`partId = 4`, `aAux.y = radialEyeU` 0..1) on both sides of the head.
 */
function appendCornealEyes(
  b: SculptBuffers,
  xOffset: number,
  yOffset: number,
  zOffset: number,
  radius: number,
  spineU: number,
  protrusion = 0.62,
): void {
  const segs = 6;
  for (const sx of [-1, 1] as const) {
    const apexIdx = b.pos.length / 3;
    b.pos.push(sx * (xOffset + radius * protrusion), yOffset, zOffset + radius * 0.12);
    b.aux.push(spineU, 0.0, sx, 4);

    const ringStart = b.pos.length / 3;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const dy = Math.cos(a) * radius;
      const dz = Math.sin(a) * radius;
      b.pos.push(sx * (xOffset - radius * 0.18), yOffset + dy, zOffset + dz);
      b.aux.push(spineU, 1.0, sx, 4);
    }

    const baseCapIdx = b.pos.length / 3;
    b.pos.push(sx * (xOffset - radius * 0.24), yOffset, zOffset);
    b.aux.push(spineU, 1.0, sx, 4);

    for (let s = 0; s < segs; s++) {
      const r0 = ringStart + s;
      const r1 = ringStart + ((s + 1) % segs);
      if (sx > 0) {
        b.idx.push(apexIdx, r1, r0);
        b.idx.push(baseCapIdx, r0, r1);
      } else {
        b.idx.push(apexIdx, r0, r1);
        b.idx.push(baseCapIdx, r1, r0);
      }
    }
  }
}

interface SuperellipseHullSpec {
  readonly stationsZ: readonly number[]; // length 13, nose -> peduncle
  readonly halfHeights: readonly number[];
  readonly halfWidths: readonly number[];
  readonly camberY?: readonly number[];
  readonly expX: number;
  readonly expY: number;
  readonly snoutTipExt: number;
  readonly snoutTipY?: number;
  readonly sides: number;
  readonly ventralFlatten?: number;
}

/**
 * Builds a 100% closed watertight 13-station superellipse lofted fish hull.
 */
function appendClosedSuperellipseHull(b: SculptBuffers, cfg: SuperellipseHullSpec): {
  zNose: number;
  zTail: number;
  zSpan: number;
} {
  const { stationsZ, halfHeights, halfWidths, expX, expY, sides } = cfg;
  const ringCount = stationsZ.length;
  const zNose = stationsZ[0] + cfg.snoutTipExt;
  const zTail = stationsZ[ringCount - 1];
  const zSpan = Math.max(0.05, zNose - zTail);
  const vFlat = cfg.ventralFlatten ?? 1.0;

  const baseVert = b.pos.length / 3;

  for (let r = 0; r < ringCount; r++) {
    const z = stationsZ[r];
    const hh = halfHeights[r];
    const hw = halfWidths[r];
    const cy = cfg.camberY ? cfg.camberY[r] : 0;
    const spineU = clamp((zNose - z) / zSpan, 0, 1);

    for (let s = 0; s < sides; s++) {
      const theta = (s / sides) * Math.PI * 2;
      const st = Math.sin(theta);
      const ct = Math.cos(theta);
      const sx = superellipseCoord(st, expX);
      const syRaw = superellipseCoord(ct, expY);
      const sy = syRaw < 0 ? syRaw * vFlat : syRaw;
      b.pos.push(sx * hw, cy + sy * hh, z);
      b.aux.push(spineU, st, clamp(ct, -1, 1), 0);
    }
  }

  for (let r = 0; r < ringCount - 1; r++) {
    for (let s = 0; s < sides; s++) {
      const sNext = (s + 1) % sides;
      const k0 = baseVert + r * sides + s;
      const k1 = baseVert + r * sides + sNext;
      const k2 = baseVert + (r + 1) * sides + sNext;
      const k3 = baseVert + (r + 1) * sides + s;
      b.idx.push(k0, k1, k2, k0, k2, k3);
    }
  }

  // Watertight rounded snout apex cap (+Z outward)
  const noseApex = b.pos.length / 3;
  const noseY = cfg.snoutTipY ?? (cfg.camberY ? cfg.camberY[0] : 0);
  b.pos.push(0, noseY, zNose);
  b.aux.push(0, 0, 0.05, 0);
  for (let s = 0; s < sides; s++) {
    const sNext = (s + 1) % sides;
    b.idx.push(noseApex, baseVert + sNext, baseVert + s);
  }

  // Watertight caudal peduncle cap (-Z outward)
  const tailApex = b.pos.length / 3;
  const tailY = cfg.camberY ? cfg.camberY[ringCount - 1] : 0;
  b.pos.push(0, tailY, zTail - 0.014);
  b.aux.push(1.0, 0, 0, 0);
  const lastRing = baseVert + (ringCount - 1) * sides;
  for (let s = 0; s < sides; s++) {
    const sNext = (s + 1) % sides;
    b.idx.push(tailApex, lastRing + s, lastRing + sNext);
  }

  return { zNose, zTail, zSpan };
}

/**
 * Appends a sculpted multi-station caudal (tail) fin supporting rounded paddle, truncate, forked,
 * high-aspect lunate crescent, hypocercal flying-fish, and heterocercal shark silhouettes.
 */
function appendSculptedCaudalFin(
  b: SculptBuffers,
  zPeduncle: number,
  peduncleHalfH: number,
  cfg: {
    upperLen: number;
    lowerLen: number;
    upperHeight: number;
    lowerHeight: number;
    forkDepth: number; // 0 = rounded convex paddle, >0 = forked/lunate indentation
    halfThick: number;
    subterminalNotch?: boolean;
  },
): void {
  const zCenterTip = zPeduncle - (cfg.upperLen + cfg.lowerLen) * 0.5 * (1 - cfg.forkDepth) - (cfg.forkDepth <= 0.02 ? 0.035 : 0);
  const zUpTip = zPeduncle - cfg.upperLen;
  const zLoTip = zPeduncle - cfg.lowerLen;

  // 7 vertical stations from ventral lobe tip (-1) through center fork (0) to dorsal lobe tip (+1)
  const vFracs = [-1.0, -0.68, -0.32, 0.0, 0.32, 0.68, 1.0];
  const stations = vFracs.map(vf => {
    const av = Math.abs(vf);
    const lobeH = vf >= 0 ? cfg.upperHeight : cfg.lowerHeight;
    const lobeZ = vf >= 0 ? zUpTip : zLoTip;
    const ry = vf * peduncleHalfH * 0.82;
    const rz = zPeduncle + (1 - av) * 0.012;
    const ty = vf * lobeH * (cfg.forkDepth <= 0.02 ? Math.pow(av, 0.78) : av);
    let tz: number;
    if (cfg.forkDepth <= 0.02) {
      // Rounded convex paddle fan (clownfish, grouper)
      tz = zCenterTip + av * av * 0.055;
    } else {
      // Forked / lunate hydrofoil curve
      const curve = Math.pow(av, 1.35);
      tz = zCenterTip + (lobeZ - zCenterTip) * curve;
      if (cfg.subterminalNotch && vf > 0.55 && vf < 0.85) {
        tz += 0.032; // Carcharhinid subterminal notch
      }
    }
    return {
      rz,
      ry,
      tz,
      ty,
      uRoot: 0.96,
      uTip: 1.06 + av * 0.14,
      dorsalRoot: vf * 0.45,
      dorsalTip: vf,
    };
  });

  appendMedianHydrofoilFin(b, stations, cfg.halfThick, 1);
}

/** G0: Plump Anemonefish (`clownfish`) — notched 2-dome dorsal, rounded fan tail, wide rounded pectorals, pelvics & anal. */
function buildG0AnemonefishGeo(low: boolean): T.BufferGeometry {
  const b = createSculptBuffers();
  const sides = low ? 8 : 12;
  appendClosedSuperellipseHull(b, {
    stationsZ: [0.47, 0.42, 0.34, 0.24, 0.12, 0.0, -0.10, -0.18, -0.24, -0.29, -0.33, -0.36, -0.39],
    halfHeights: [0.045, 0.105, 0.155, 0.185, 0.198, 0.192, 0.175, 0.148, 0.118, 0.092, 0.075, 0.068, 0.062],
    halfWidths: [0.032, 0.062, 0.084, 0.096, 0.102, 0.096, 0.084, 0.068, 0.052, 0.038, 0.028, 0.022, 0.018],
    camberY: [-0.008, -0.004, 0.002, 0.006, 0.008, 0.006, 0.004, 0.002, 0, 0, 0, 0, 0],
    expX: 2.25,
    expY: 2.05,
    snoutTipExt: 0.025,
    snoutTipY: -0.01,
    sides,
  });

  // Signature two-lobed notched anemonefish dorsal fin
  appendMedianHydrofoilFin(
    b,
    [
      { rz: 0.25, ry: 0.17, tz: 0.22, ty: 0.22, uRoot: 0.28, uTip: 0.30, dorsalRoot: 0.85, dorsalTip: 1.0 },
      { rz: 0.13, ry: 0.19, tz: 0.10, ty: 0.275, uRoot: 0.41, uTip: 0.44, dorsalRoot: 0.88, dorsalTip: 1.0 },
      { rz: -0.01, ry: 0.185, tz: -0.03, ty: 0.225, uRoot: 0.56, uTip: 0.58, dorsalRoot: 0.86, dorsalTip: 0.96 },
      { rz: -0.14, ry: 0.155, tz: -0.18, ty: 0.285, uRoot: 0.71, uTip: 0.76, dorsalRoot: 0.84, dorsalTip: 1.0 },
      { rz: -0.28, ry: 0.095, tz: -0.34, ty: 0.21, uRoot: 0.86, uTip: 0.92, dorsalRoot: 0.80, dorsalTip: 0.98 },
      { rz: -0.34, ry: 0.072, tz: -0.37, ty: 0.095, uRoot: 0.93, uTip: 0.96, dorsalRoot: 0.75, dorsalTip: 0.85 },
    ],
    0.011,
    1,
  );

  // Rounded anal fin
  appendMedianHydrofoilFin(
    b,
    [
      { rz: -0.08, ry: -0.165, tz: -0.11, ty: -0.215, uRoot: 0.64, uTip: 0.68, dorsalRoot: -0.85, dorsalTip: -1.0 },
      { rz: -0.19, ry: -0.135, tz: -0.25, ty: -0.245, uRoot: 0.76, uTip: 0.83, dorsalRoot: -0.85, dorsalTip: -1.0 },
      { rz: -0.31, ry: -0.082, tz: -0.35, ty: -0.125, uRoot: 0.90, uTip: 0.94, dorsalRoot: -0.80, dorsalTip: -0.92 },
    ],
    0.009,
    1,
  );

  // Rounded paddle caudal fin (forkDepth = 0)
  appendSculptedCaudalFin(b, -0.39, 0.062, {
    upperLen: 0.21,
    lowerLen: 0.21,
    upperHeight: 0.155,
    lowerHeight: 0.155,
    forkDepth: 0.0,
    halfThick: 0.01,
  });

  // Large rounded labriform pectoral paddles
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.086, y: -0.025, zLead: 0.24, zTrail: 0.12, thick: 0.010, uLead: 0.29, uTrail: 0.42, dorsalVal: -0.15 },
      { spanFrac: 0.55, xAbs: 0.195, y: -0.018, zLead: 0.20, zTrail: 0.04, thick: 0.007, uLead: 0.34, uTrail: 0.51, dorsalVal: -0.12 },
      { spanFrac: 1.0, xAbs: 0.255, y: -0.012, zLead: 0.13, zTrail: 0.02, thick: 0.003, uLead: 0.41, uTrail: 0.53, dorsalVal: -0.10 },
    ],
    2,
  );

  // Ventral pelvic fins
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.032, y: -0.175, zLead: 0.16, zTrail: 0.06, thick: 0.007, uLead: 0.38, uTrail: 0.49, dorsalVal: -0.88 },
      { spanFrac: 1.0, xAbs: 0.095, y: -0.255, zLead: 0.08, zTrail: -0.03, thick: 0.003, uLead: 0.47, uTrail: 0.58, dorsalVal: -1.0 },
    ],
    3,
  );

  appendCornealEyes(b, 0.066, 0.042, 0.365, 0.028, 0.14);
  return finalizeSculptedGeometry(b);
}

/** G1: Tall Laterally-Compressed Discoid Reef (`butterflyfish`, `angelfish`). */
function buildG1DiscoidReefGeo(low: boolean): T.BufferGeometry {
  const b = createSculptBuffers();
  const sides = low ? 8 : 12;
  appendClosedSuperellipseHull(b, {
    stationsZ: [0.49, 0.44, 0.36, 0.26, 0.14, 0.01, -0.10, -0.19, -0.26, -0.31, -0.34, -0.37, -0.39],
    halfHeights: [0.026, 0.072, 0.165, 0.248, 0.295, 0.305, 0.278, 0.228, 0.162, 0.105, 0.072, 0.058, 0.052],
    halfWidths: [0.016, 0.032, 0.048, 0.058, 0.064, 0.062, 0.055, 0.045, 0.034, 0.024, 0.018, 0.014, 0.012],
    camberY: [-0.016, -0.01, 0.004, 0.012, 0.016, 0.014, 0.01, 0.005, 0, 0, 0, 0, 0],
    expX: 1.55,
    expY: 1.85,
    snoutTipExt: 0.035,
    snoutTipY: -0.015,
    sides,
  });

  // High swept continuous spiny-to-filamentous dorsal fin
  appendMedianHydrofoilFin(
    b,
    [
      { rz: 0.27, ry: 0.23, tz: 0.23, ty: 0.29, uRoot: 0.28, uTip: 0.32, dorsalRoot: 0.85, dorsalTip: 1.0 },
      { rz: 0.12, ry: 0.29, tz: 0.06, ty: 0.39, uRoot: 0.44, uTip: 0.50, dorsalRoot: 0.90, dorsalTip: 1.0 },
      { rz: -0.06, ry: 0.28, tz: -0.15, ty: 0.41, uRoot: 0.63, uTip: 0.72, dorsalRoot: 0.90, dorsalTip: 1.0 },
      { rz: -0.22, ry: 0.19, tz: -0.42, ty: 0.36, uRoot: 0.80, uTip: 1.02, dorsalRoot: 0.86, dorsalTip: 1.0 },
      { rz: -0.33, ry: 0.075, tz: -0.40, ty: 0.12, uRoot: 0.92, uTip: 1.00, dorsalRoot: 0.78, dorsalTip: 0.90 },
    ],
    0.008,
    1,
  );

  // Swept mirror-symmetric anal fin
  appendMedianHydrofoilFin(
    b,
    [
      { rz: 0.02, ry: -0.27, tz: -0.04, ty: -0.34, uRoot: 0.55, uTip: 0.61, dorsalRoot: -0.88, dorsalTip: -1.0 },
      { rz: -0.16, ry: -0.22, tz: -0.36, ty: -0.35, uRoot: 0.74, uTip: 0.95, dorsalRoot: -0.88, dorsalTip: -1.0 },
      { rz: -0.32, ry: -0.078, tz: -0.39, ty: -0.12, uRoot: 0.91, uTip: 0.98, dorsalRoot: -0.80, dorsalTip: -0.92 },
    ],
    0.008,
    1,
  );

  // Truncate brush caudal fin
  appendSculptedCaudalFin(b, -0.39, 0.052, {
    upperLen: 0.20,
    lowerLen: 0.20,
    upperHeight: 0.15,
    lowerHeight: 0.15,
    forkDepth: 0.08,
    halfThick: 0.008,
  });

  // Delicate agile pectorals + long filamentous pelvics
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.052, y: -0.04, zLead: 0.24, zTrail: 0.14, thick: 0.007, uLead: 0.31, uTrail: 0.42, dorsalVal: -0.18 },
      { spanFrac: 1.0, xAbs: 0.185, y: -0.01, zLead: 0.16, zTrail: 0.05, thick: 0.0025, uLead: 0.40, uTrail: 0.51, dorsalVal: -0.08 },
    ],
    2,
  );
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.024, y: -0.24, zLead: 0.18, zTrail: 0.10, thick: 0.006, uLead: 0.37, uTrail: 0.46, dorsalVal: -0.90 },
      { spanFrac: 1.0, xAbs: 0.068, y: -0.36, zLead: 0.02, zTrail: -0.12, thick: 0.002, uLead: 0.54, uTrail: 0.69, dorsalVal: -1.0 },
    ],
    3,
  );

  appendCornealEyes(b, 0.046, 0.048, 0.365, 0.026, 0.17);
  return finalizeSculptedGeometry(b);
}

/** G2: Zanclid Moorish Idol (`moorish_idol`) — tubular snout + dramatic 6-segment trailing dorsal whip pennant! */
function buildG2MoorishIdolGeo(low: boolean): T.BufferGeometry {
  const b = createSculptBuffers();
  const sides = low ? 8 : 12;
  appendClosedSuperellipseHull(b, {
    stationsZ: [0.54, 0.47, 0.39, 0.29, 0.17, 0.03, -0.09, -0.19, -0.26, -0.31, -0.34, -0.37, -0.39],
    halfHeights: [0.022, 0.035, 0.115, 0.245, 0.325, 0.318, 0.265, 0.198, 0.135, 0.088, 0.062, 0.048, 0.044],
    halfWidths: [0.015, 0.022, 0.038, 0.052, 0.058, 0.056, 0.048, 0.038, 0.028, 0.020, 0.015, 0.012, 0.010],
    camberY: [-0.026, -0.022, 0.005, 0.025, 0.032, 0.022, 0.010, 0, -0.005, 0, 0, 0, 0],
    expX: 1.5,
    expY: 1.8,
    snoutTipExt: 0.035,
    snoutTipY: -0.025,
    sides,
  });

  // Base triangular dorsal fin + 6-station sweeping filamentous whip pennant (`partId = 3` for streamer wave!)
  appendMedianHydrofoilFin(
    b,
    [
      { rz: 0.22, ry: 0.28, tz: 0.16, ty: 0.48, uRoot: 0.36, uTip: 0.44, dorsalRoot: 0.92, dorsalTip: 1.0 },
      { rz: 0.08, ry: 0.32, tz: -0.06, ty: 0.58, uRoot: 0.51, uTip: 0.68, dorsalRoot: 0.94, dorsalTip: 1.0 },
      { rz: -0.08, ry: 0.26, tz: -0.34, ty: 0.54, uRoot: 0.68, uTip: 0.96, dorsalRoot: 0.90, dorsalTip: 1.0 },
      { rz: -0.21, ry: 0.17, tz: -0.62, ty: 0.44, uRoot: 0.81, uTip: 1.18, dorsalRoot: 0.86, dorsalTip: 1.0 },
      { rz: -0.31, ry: 0.08, tz: -0.88, ty: 0.34, uRoot: 0.92, uTip: 1.34, dorsalRoot: 0.82, dorsalTip: 1.0 },
      { rz: -0.35, ry: 0.055, tz: -0.42, ty: 0.10, uRoot: 0.96, uTip: 1.02, dorsalRoot: 0.78, dorsalTip: 0.88 },
    ],
    0.007,
    3,
  );

  // Deep triangular Zanclid anal fin
  appendMedianHydrofoilFin(
    b,
    [
      { rz: 0.04, ry: -0.28, tz: -0.08, ty: -0.42, uRoot: 0.55, uTip: 0.68, dorsalRoot: -0.90, dorsalTip: -1.0 },
      { rz: -0.16, ry: -0.20, tz: -0.34, ty: -0.34, uRoot: 0.76, uTip: 0.95, dorsalRoot: -0.88, dorsalTip: -1.0 },
      { rz: -0.32, ry: -0.07, tz: -0.38, ty: -0.10, uRoot: 0.93, uTip: 0.99, dorsalRoot: -0.80, dorsalTip: -0.90 },
    ],
    0.007,
    1,
  );

  // Emarginate black caudal fin
  appendSculptedCaudalFin(b, -0.39, 0.044, {
    upperLen: 0.21,
    lowerLen: 0.21,
    upperHeight: 0.165,
    lowerHeight: 0.165,
    forkDepth: 0.42,
    halfThick: 0.008,
  });

  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.048, y: -0.05, zLead: 0.24, zTrail: 0.14, thick: 0.006, uLead: 0.34, uTrail: 0.45, dorsalVal: -0.2 },
      { spanFrac: 1.0, xAbs: 0.18, y: -0.015, zLead: 0.15, zTrail: 0.04, thick: 0.0025, uLead: 0.44, uTrail: 0.55, dorsalVal: -0.1 },
    ],
    2,
  );
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.022, y: -0.26, zLead: 0.20, zTrail: 0.11, thick: 0.006, uLead: 0.39, uTrail: 0.48, dorsalVal: -0.92 },
      { spanFrac: 1.0, xAbs: 0.062, y: -0.39, zLead: 0.04, zTrail: -0.10, thick: 0.002, uLead: 0.55, uTrail: 0.70, dorsalVal: -1.0 },
    ],
    3,
  );

  appendCornealEyes(b, 0.044, 0.078, 0.355, 0.027, 0.22);
  return finalizeSculptedGeometry(b);
}

/** G3: Oval-Fusiform Reef Grazer with Scaridae Beak (`surgeonfish`, `parrotfish`). */
function buildG3ReefGrazerGeo(low: boolean): T.BufferGeometry {
  const b = createSculptBuffers();
  const sides = low ? 8 : 12;
  appendClosedSuperellipseHull(b, {
    stationsZ: [0.49, 0.43, 0.35, 0.24, 0.11, -0.02, -0.13, -0.22, -0.29, -0.34, -0.37, -0.40, -0.42],
    halfHeights: [0.052, 0.115, 0.168, 0.205, 0.218, 0.212, 0.192, 0.158, 0.118, 0.084, 0.066, 0.058, 0.054],
    halfWidths: [0.032, 0.055, 0.072, 0.082, 0.086, 0.082, 0.072, 0.058, 0.044, 0.032, 0.024, 0.018, 0.015],
    camberY: [-0.014, -0.006, 0.004, 0.008, 0.010, 0.008, 0.004, 0, 0, 0, 0, 0, 0],
    expX: 1.85,
    expY: 1.95,
    snoutTipExt: 0.035,
    snoutTipY: -0.018,
    sides,
  });

  // Long continuous flat-crested reef grazer dorsal fin
  appendMedianHydrofoilFin(
    b,
    [
      { rz: 0.28, ry: 0.19, tz: 0.25, ty: 0.255, uRoot: 0.26, uTip: 0.29, dorsalRoot: 0.86, dorsalTip: 1.0 },
      { rz: 0.08, ry: 0.21, tz: 0.04, ty: 0.295, uRoot: 0.47, uTip: 0.51, dorsalRoot: 0.88, dorsalTip: 1.0 },
      { rz: -0.15, ry: 0.18, tz: -0.20, ty: 0.285, uRoot: 0.71, uTip: 0.77, dorsalRoot: 0.86, dorsalTip: 1.0 },
      { rz: -0.33, ry: 0.085, tz: -0.40, ty: 0.215, uRoot: 0.90, uTip: 0.98, dorsalRoot: 0.82, dorsalTip: 0.98 },
      { rz: -0.37, ry: 0.064, tz: -0.41, ty: 0.09, uRoot: 0.95, uTip: 0.99, dorsalRoot: 0.76, dorsalTip: 0.85 },
    ],
    0.010,
    1,
  );

  // Continuous long-based anal fin
  appendMedianHydrofoilFin(
    b,
    [
      { rz: 0.0, ry: -0.195, tz: -0.04, ty: -0.265, uRoot: 0.55, uTip: 0.60, dorsalRoot: -0.88, dorsalTip: -1.0 },
      { rz: -0.18, ry: -0.165, tz: -0.24, ty: -0.26, uRoot: 0.74, uTip: 0.81, dorsalRoot: -0.86, dorsalTip: -1.0 },
      { rz: -0.35, ry: -0.075, tz: -0.40, ty: -0.165, uRoot: 0.92, uTip: 0.98, dorsalRoot: -0.80, dorsalTip: -0.96 },
    ],
    0.009,
    1,
  );

  // Emarginate-lunate caudal fin with elongated upper and lower lobe streamers
  appendSculptedCaudalFin(b, -0.42, 0.054, {
    upperLen: 0.24,
    lowerLen: 0.24,
    upperHeight: 0.175,
    lowerHeight: 0.175,
    forkDepth: 0.36,
    halfThick: 0.010,
  });

  // Broad labriform rowing pectoral blades + pelvics
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.074, y: -0.03, zLead: 0.25, zTrail: 0.13, thick: 0.009, uLead: 0.29, uTrail: 0.42, dorsalVal: -0.15 },
      { spanFrac: 0.6, xAbs: 0.19, y: -0.005, zLead: 0.19, zTrail: 0.06, thick: 0.006, uLead: 0.35, uTrail: 0.49, dorsalVal: -0.08 },
      { spanFrac: 1.0, xAbs: 0.26, y: 0.01, zLead: 0.12, zTrail: 0.03, thick: 0.0025, uLead: 0.43, uTrail: 0.52, dorsalVal: -0.02 },
    ],
    2,
  );
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.028, y: -0.19, zLead: 0.17, zTrail: 0.08, thick: 0.007, uLead: 0.37, uTrail: 0.47, dorsalVal: -0.88 },
      { spanFrac: 1.0, xAbs: 0.082, y: -0.27, zLead: 0.06, zTrail: -0.04, thick: 0.0025, uLead: 0.49, uTrail: 0.60, dorsalVal: -1.0 },
    ],
    3,
  );

  appendCornealEyes(b, 0.058, 0.055, 0.37, 0.026, 0.16);
  return finalizeSculptedGeometry(b);
}

/** G4: Heavy-Bodied Demersal Serranid (`grouper` — `Plectropomus leopardus`). */
function buildG4GrouperGeo(low: boolean): T.BufferGeometry {
  const b = createSculptBuffers();
  const sides = low ? 8 : 12;
  appendClosedSuperellipseHull(b, {
    stationsZ: [0.51, 0.45, 0.36, 0.25, 0.12, -0.01, -0.13, -0.23, -0.30, -0.35, -0.38, -0.41, -0.43],
    halfHeights: [0.048, 0.105, 0.152, 0.182, 0.192, 0.186, 0.170, 0.145, 0.115, 0.090, 0.076, 0.070, 0.066],
    halfWidths: [0.038, 0.074, 0.098, 0.112, 0.114, 0.106, 0.092, 0.076, 0.058, 0.044, 0.034, 0.028, 0.024],
    camberY: [-0.012, -0.008, 0, 0.008, 0.012, 0.010, 0.006, 0.002, 0, 0, 0, 0, 0],
    expX: 2.35,
    expY: 2.1,
    snoutTipExt: 0.035,
    snoutTipY: -0.012,
    sides,
  });

  // Spiny anterior dorsal + taller rounded soft posterior dorsal
  appendMedianHydrofoilFin(
    b,
    [
      { rz: 0.24, ry: 0.175, tz: 0.20, ty: 0.235, uRoot: 0.31, uTip: 0.35, dorsalRoot: 0.85, dorsalTip: 0.98 },
      { rz: 0.06, ry: 0.188, tz: 0.01, ty: 0.255, uRoot: 0.50, uTip: 0.55, dorsalRoot: 0.88, dorsalTip: 1.0 },
      { rz: -0.08, ry: 0.175, tz: -0.11, ty: 0.235, uRoot: 0.64, uTip: 0.67, dorsalRoot: 0.86, dorsalTip: 0.96 },
      { rz: -0.20, ry: 0.15, tz: -0.26, ty: 0.285, uRoot: 0.76, uTip: 0.83, dorsalRoot: 0.86, dorsalTip: 1.0 },
      { rz: -0.34, ry: 0.092, tz: -0.40, ty: 0.205, uRoot: 0.91, uTip: 0.97, dorsalRoot: 0.80, dorsalTip: 0.96 },
      { rz: -0.39, ry: 0.072, tz: -0.42, ty: 0.095, uRoot: 0.96, uTip: 0.99, dorsalRoot: 0.75, dorsalTip: 0.85 },
    ],
    0.012,
    1,
  );

  // Rounded Serranid anal fin
  appendMedianHydrofoilFin(
    b,
    [
      { rz: -0.10, ry: -0.16, tz: -0.15, ty: -0.235, uRoot: 0.66, uTip: 0.71, dorsalRoot: -0.86, dorsalTip: -1.0 },
      { rz: -0.23, ry: -0.135, tz: -0.31, ty: -0.255, uRoot: 0.79, uTip: 0.88, dorsalRoot: -0.86, dorsalTip: -1.0 },
      { rz: -0.36, ry: -0.08, tz: -0.40, ty: -0.13, uRoot: 0.93, uTip: 0.97, dorsalRoot: -0.80, dorsalTip: -0.92 },
    ],
    0.011,
    1,
  );

  // Broad truncate-emarginate powerful grouper broom tail
  appendSculptedCaudalFin(b, -0.43, 0.066, {
    upperLen: 0.23,
    lowerLen: 0.23,
    upperHeight: 0.165,
    lowerHeight: 0.165,
    forkDepth: 0.14,
    halfThick: 0.013,
  });

  // Large rounded ambush-stabilizing pectoral paddles + stout pelvics
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.098, y: -0.038, zLead: 0.25, zTrail: 0.11, thick: 0.012, uLead: 0.30, uTrail: 0.45, dorsalVal: -0.20 },
      { spanFrac: 0.6, xAbs: 0.215, y: -0.032, zLead: 0.20, zTrail: 0.03, thick: 0.008, uLead: 0.35, uTrail: 0.53, dorsalVal: -0.18 },
      { spanFrac: 1.0, xAbs: 0.275, y: -0.025, zLead: 0.12, zTrail: 0.01, thick: 0.003, uLead: 0.44, uTrail: 0.55, dorsalVal: -0.15 },
    ],
    2,
  );
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.042, y: -0.168, zLead: 0.19, zTrail: 0.07, thick: 0.009, uLead: 0.36, uTrail: 0.49, dorsalVal: -0.88 },
      { spanFrac: 1.0, xAbs: 0.115, y: -0.245, zLead: 0.08, zTrail: -0.04, thick: 0.003, uLead: 0.48, uTrail: 0.60, dorsalVal: -1.0 },
    ],
    3,
  );

  appendCornealEyes(b, 0.076, 0.056, 0.39, 0.027, 0.16);
  return finalizeSculptedGeometry(b);
}

/** G5: Streamlined Pelagic Thunniform Scombrid (`mackerel`, `yellowfin_tuna`) — 1st/2nd sickle dorsals, anal, 5+5 finlets, lunate tail! */
function buildG5PelagicScombridGeo(low: boolean): T.BufferGeometry {
  const b = createSculptBuffers();
  const sides = low ? 8 : 12;
  appendClosedSuperellipseHull(b, {
    stationsZ: [0.54, 0.47, 0.38, 0.26, 0.12, -0.02, -0.15, -0.26, -0.34, -0.39, -0.43, -0.46, -0.48],
    halfHeights: [0.024, 0.075, 0.128, 0.162, 0.172, 0.158, 0.132, 0.095, 0.058, 0.036, 0.025, 0.021, 0.019],
    halfWidths: [0.020, 0.052, 0.084, 0.104, 0.108, 0.098, 0.078, 0.054, 0.035, 0.026, 0.024, 0.024, 0.020],
    camberY: [-0.006, -0.002, 0.002, 0.005, 0.005, 0.003, 0, 0, 0, 0, 0, 0, 0],
    expX: 2.0,
    expY: 1.95,
    snoutTipExt: 0.04,
    snoutTipY: -0.008,
    sides,
  });

  // Raked spiny 1st dorsal fin
  appendMedianHydrofoilFin(
    b,
    [
      { rz: 0.25, ry: 0.155, tz: 0.17, ty: 0.265, uRoot: 0.31, uTip: 0.39, dorsalRoot: 0.88, dorsalTip: 1.0 },
      { rz: 0.13, ry: 0.168, tz: 0.07, ty: 0.225, uRoot: 0.43, uTip: 0.49, dorsalRoot: 0.90, dorsalTip: 0.98 },
      { rz: 0.02, ry: 0.158, tz: -0.01, ty: 0.182, uRoot: 0.53, uTip: 0.56, dorsalRoot: 0.88, dorsalTip: 0.94 },
    ],
    0.008,
    1,
  );

  // Tall falcate sickle 2nd dorsal fin (colored vivid yellow on yellowfin tuna via spineU > 0.46!)
  appendMedianHydrofoilFin(
    b,
    [
      { rz: -0.05, ry: 0.148, tz: -0.14, ty: 0.325, uRoot: 0.60, uTip: 0.69, dorsalRoot: 0.90, dorsalTip: 1.0 },
      { rz: -0.13, ry: 0.130, tz: -0.24, ty: 0.275, uRoot: 0.67, uTip: 0.78, dorsalRoot: 0.88, dorsalTip: 1.0 },
      { rz: -0.19, ry: 0.112, tz: -0.23, ty: 0.140, uRoot: 0.73, uTip: 0.77, dorsalRoot: 0.84, dorsalTip: 0.92 },
    ],
    0.008,
    1,
  );

  // Mirror sickle anal fin
  appendMedianHydrofoilFin(
    b,
    [
      { rz: -0.08, ry: -0.142, tz: -0.17, ty: -0.315, uRoot: 0.63, uTip: 0.71, dorsalRoot: -0.90, dorsalTip: -1.0 },
      { rz: -0.16, ry: -0.122, tz: -0.26, ty: -0.265, uRoot: 0.70, uTip: 0.80, dorsalRoot: -0.88, dorsalTip: -1.0 },
      { rz: -0.21, ry: -0.104, tz: -0.25, ty: -0.132, uRoot: 0.75, uTip: 0.79, dorsalRoot: -0.84, dorsalTip: -0.92 },
    ],
    0.008,
    1,
  );

  // Characteristic 5 dorsal + 5 ventral scombrid peduncle finlets!
  const finletCount = low ? 3 : 5;
  for (let f = 0; f < finletCount; f++) {
    const t = f / finletCount;
    const fz0 = -0.24 - t * 0.19;
    const fz1 = fz0 - 0.028;
    const bodyH = 0.085 * (1 - t * 0.72);
    const u0 = clamp((0.58 - fz0) / 1.06, 0, 1);
    appendMedianHydrofoilFin(
      b,
      [
        { rz: fz0, ry: bodyH, tz: fz1 - 0.008, ty: bodyH + 0.032, uRoot: u0, uTip: u0 + 0.02, dorsalRoot: 0.88, dorsalTip: 1.0 },
        { rz: fz1, ry: bodyH * 0.92, tz: fz1 - 0.012, ty: bodyH + 0.012, uRoot: u0 + 0.02, uTip: u0 + 0.03, dorsalRoot: 0.86, dorsalTip: 0.95 },
      ],
      0.0035,
      1,
    );
    appendMedianHydrofoilFin(
      b,
      [
        { rz: fz0, ry: -bodyH, tz: fz1 - 0.008, ty: -bodyH - 0.030, uRoot: u0, uTip: u0 + 0.02, dorsalRoot: -0.88, dorsalTip: -1.0 },
        { rz: fz1, ry: -bodyH * 0.92, tz: fz1 - 0.012, ty: -bodyH - 0.012, uRoot: u0 + 0.02, uTip: u0 + 0.03, dorsalRoot: -0.86, dorsalTip: -0.95 },
      ],
      0.0035,
      1,
    );
  }

  // High-aspect-ratio deeply lunate hydrofoil caudal sickle
  appendSculptedCaudalFin(b, -0.48, 0.022, {
    upperLen: 0.25,
    lowerLen: 0.25,
    upperHeight: 0.245,
    lowerHeight: 0.245,
    forkDepth: 0.72,
    halfThick: 0.010,
  });

  // Swept blade pectoral hydrofoils + compact pelvics
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.092, y: -0.015, zLead: 0.26, zTrail: 0.16, thick: 0.009, uLead: 0.30, uTrail: 0.40, dorsalVal: -0.10 },
      { spanFrac: 0.6, xAbs: 0.22, y: -0.01, zLead: 0.16, zTrail: 0.08, thick: 0.006, uLead: 0.40, uTrail: 0.47, dorsalVal: -0.08 },
      { spanFrac: 1.0, xAbs: 0.31, y: -0.005, zLead: 0.06, zTrail: 0.01, thick: 0.0025, uLead: 0.49, uTrail: 0.54, dorsalVal: -0.05 },
    ],
    2,
  );
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.035, y: -0.148, zLead: 0.21, zTrail: 0.13, thick: 0.006, uLead: 0.35, uTrail: 0.42, dorsalVal: -0.90 },
      { spanFrac: 1.0, xAbs: 0.082, y: -0.205, zLead: 0.11, zTrail: 0.05, thick: 0.002, uLead: 0.44, uTrail: 0.50, dorsalVal: -1.0 },
    ],
    3,
  );

  appendCornealEyes(b, 0.066, 0.032, 0.42, 0.023, 0.15);
  return finalizeSculptedGeometry(b);
}

/** G6: Exocoetid Biplane Glider (`flying_fish`) — huge ribbed pectoral wings + pelvic glide wings + hypocercal tail! */
function buildG6FlyingFishGeo(low: boolean): T.BufferGeometry {
  const b = createSculptBuffers();
  const sides = low ? 8 : 12;
  appendClosedSuperellipseHull(b, {
    stationsZ: [0.50, 0.44, 0.35, 0.24, 0.11, -0.02, -0.14, -0.24, -0.32, -0.37, -0.40, -0.43, -0.45],
    halfHeights: [0.022, 0.058, 0.088, 0.104, 0.108, 0.102, 0.092, 0.076, 0.058, 0.042, 0.032, 0.026, 0.024],
    halfWidths: [0.018, 0.044, 0.062, 0.070, 0.072, 0.068, 0.058, 0.046, 0.034, 0.024, 0.018, 0.015, 0.013],
    camberY: [-0.004, 0, 0.004, 0.006, 0.006, 0.004, 0.002, 0, 0, 0, 0, 0, 0],
    expX: 2.15,
    expY: 1.9,
    snoutTipExt: 0.035,
    snoutTipY: -0.005,
    sides,
  });

  // Posteriorly placed Exocoetid dorsal and anal fins
  appendMedianHydrofoilFin(
    b,
    [
      { rz: -0.14, ry: 0.088, tz: -0.19, ty: 0.175, uRoot: 0.69, uTip: 0.74, dorsalRoot: 0.88, dorsalTip: 1.0 },
      { rz: -0.28, ry: 0.064, tz: -0.35, ty: 0.145, uRoot: 0.83, uTip: 0.90, dorsalRoot: 0.86, dorsalTip: 0.98 },
      { rz: -0.36, ry: 0.042, tz: -0.39, ty: 0.065, uRoot: 0.91, uTip: 0.94, dorsalRoot: 0.80, dorsalTip: 0.90 },
    ],
    0.006,
    1,
  );
  appendMedianHydrofoilFin(
    b,
    [
      { rz: -0.18, ry: -0.082, tz: -0.23, ty: -0.155, uRoot: 0.73, uTip: 0.78, dorsalRoot: -0.88, dorsalTip: -1.0 },
      { rz: -0.32, ry: -0.054, tz: -0.37, ty: -0.115, uRoot: 0.87, uTip: 0.92, dorsalRoot: -0.85, dorsalTip: -0.96 },
    ],
    0.006,
    1,
  );

  // Asymmetric HYPOCERCAL forked tail (ventral lobe 1.48x longer to scull across water surface on takeoff!)
  appendSculptedCaudalFin(b, -0.45, 0.024, {
    upperLen: 0.19,
    lowerLen: 0.285,
    upperHeight: 0.145,
    lowerHeight: 0.215,
    forkDepth: 0.64,
    halfThick: 0.007,
  });

  // Huge multi-chord main pectoral glide wings (`partId = 2`)
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.064, y: 0.015, zLead: 0.28, zTrail: 0.12, thick: 0.009, uLead: 0.26, uTrail: 0.42, dorsalVal: 0.15 },
      { spanFrac: 0.35, xAbs: 0.26, y: 0.032, zLead: 0.24, zTrail: -0.02, thick: 0.007, uLead: 0.30, uTrail: 0.56, dorsalVal: 0.22 },
      { spanFrac: 0.72, xAbs: 0.49, y: 0.048, zLead: 0.14, zTrail: -0.14, thick: 0.0045, uLead: 0.40, uTrail: 0.68, dorsalVal: 0.28 },
      { spanFrac: 1.0, xAbs: 0.65, y: 0.055, zLead: 0.02, zTrail: -0.18, thick: 0.002, uLead: 0.52, uTrail: 0.72, dorsalVal: 0.32 },
    ],
    2,
  );

  // Secondary enlarged biplane pelvic glide wings (`partId = 3`)
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.042, y: -0.065, zLead: -0.02, zTrail: -0.14, thick: 0.006, uLead: 0.56, uTrail: 0.68, dorsalVal: -0.65 },
      { spanFrac: 0.6, xAbs: 0.18, y: -0.045, zLead: -0.08, zTrail: -0.24, thick: 0.004, uLead: 0.62, uTrail: 0.78, dorsalVal: -0.55 },
      { spanFrac: 1.0, xAbs: 0.27, y: -0.035, zLead: -0.15, zTrail: -0.28, thick: 0.002, uLead: 0.69, uTrail: 0.82, dorsalVal: -0.50 },
    ],
    3,
  );

  appendCornealEyes(b, 0.052, 0.028, 0.385, 0.026, 0.15);
  return finalizeSculptedGeometry(b);
}

/** G7: Giant Reef Manta Ray (`manta_ray` — `Mobula alfredi`) with paired curling cephalic lobes, dorsal finlet, whip tail, and 3D eyes. */
function buildG7GiantMantaGeo(low: boolean): T.BufferGeometry {
  const NU = low ? 34 : 56;
  const M = low ? 12 : 18;
  const b = createSculptBuffers();

  for (let i = 0; i <= NU; i++) {
    const u = (i / NU) * 2 - 1;
    const a = Math.abs(u);
    const a5 = a * a * a * a * a;
    const zl =
      0.52 -
      0.74 * Math.pow(a, 1.35) +
      0.07 * Math.exp(-Math.pow((a - 0.13) / 0.05, 2)) -
      0.05 * Math.exp(-Math.pow(u / 0.05, 2)) -
      0.08 * a5;
    const zt = -0.5 + 0.3 * Math.pow(a, 0.8) + 0.02 - 0.08 * a5;
    const th = 0.082 * Math.pow(Math.max(0, 1 - a), 1.15) + 0.004 + 0.12 * Math.exp(-Math.pow(u / 0.2, 2));

    for (let j = 0; j < M; j++) {
      const ang = (j / M) * Math.PI * 2;
      const t = 0.5 - 0.5 * Math.cos(ang);
      const y = th * Math.sin(ang) * (1 - 0.55 * t) * (Math.sin(ang) < 0 ? 0.55 : 1.0);
      const z = zl + (zt - zl) * t;
      b.pos.push(u * 1.35, y, z);
      b.aux.push(u, Math.sin(ang), z, 0);
    }
  }

  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < M; j++) {
      const jNext = (j + 1) % M;
      const a0 = i * M + j;
      const a1 = i * M + jNext;
      const b0 = (i + 1) * M + j;
      const b1 = (i + 1) * M + jNext;
      b.idx.push(a0, b0, b1, a0, b1, a1);
    }
  }

  // Seal left (u = -1) and right (u = +1) wingtip cross-sections for closed-manifold integrity
  const leftTipCap = b.pos.length / 3;
  b.pos.push(-1.355, 0, -0.27);
  b.aux.push(-1.0, 0, -0.27, 0);
  const rightTipCap = b.pos.length / 3;
  b.pos.push(1.355, 0, -0.27);
  b.aux.push(1.0, 0, -0.27, 0);
  const rightWingRing = NU * M;
  for (let j = 0; j < M; j++) {
    const jNext = (j + 1) % M;
    b.idx.push(leftTipCap, j, jNext);
    b.idx.push(rightTipCap, rightWingRing + jNext, rightWingRing + j);
  }

  // Sculpted volumetric paired forward-curling cephalic lobes (`partId = 1`)
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.10, xAbs: 0.145, y: 0.008, zLead: 0.49, zTrail: 0.41, thick: 0.024, uLead: 0.11, uTrail: 0.11, dorsalVal: 0.46 },
      { spanFrac: 0.13, xAbs: 0.175, y: -0.022, zLead: 0.65, zTrail: 0.52, thick: 0.018, uLead: 0.13, uTrail: 0.13, dorsalVal: 0.60 },
      { spanFrac: 0.09, xAbs: 0.125, y: -0.052, zLead: 0.77, zTrail: 0.66, thick: 0.009, uLead: 0.09, uTrail: 0.09, dorsalVal: 0.73 },
    ],
    1,
  );

  // Small dorsal finlet at tail root
  appendMedianHydrofoilFin(
    b,
    [
      { rz: -0.38, ry: 0.032, tz: -0.44, ty: 0.088, uRoot: 0, uTip: 0, dorsalRoot: 0.5, dorsalTip: -0.42 },
      { rz: -0.46, ry: 0.020, tz: -0.49, ty: 0.042, uRoot: 0, uTip: 0, dorsalRoot: 0.4, dorsalTip: -0.48 },
    ],
    0.008,
    1,
  );

  // Tapered closed whip tail (`partId = 2`)
  const tailSegs = 7;
  const tailBase = b.pos.length / 3;
  for (let k = 0; k <= tailSegs; k++) {
    const f = k / tailSegs;
    const r = 0.026 * (1 - f * 0.88);
    const tz = -0.44 - f * 1.42;
    const ty = -0.01 - f * f * 0.045;
    for (let s = 0; s < 5; s++) {
      const ang = (s / 5) * Math.PI * 2;
      b.pos.push(Math.cos(ang) * r, ty + Math.sin(ang) * r, tz);
      b.aux.push(0, Math.sin(ang), tz, 2);
    }
  }
  for (let k = 0; k < tailSegs; k++) {
    for (let s = 0; s < 5; s++) {
      const sNext = (s + 1) % 5;
      const p0 = tailBase + k * 5 + s;
      const p1 = tailBase + k * 5 + sNext;
      const p2 = tailBase + (k + 1) * 5 + sNext;
      const p3 = tailBase + (k + 1) * 5 + s;
      b.idx.push(p0, p1, p2, p0, p2, p3);
    }
  }
  const rootCap = b.pos.length / 3;
  b.pos.push(0, -0.01, -0.435);
  b.aux.push(0, 0, -0.435, 2);
  const tipCap = b.pos.length / 3;
  b.pos.push(0, -0.056, -1.88);
  b.aux.push(0, 0, -1.88, 2);
  const lastTail = tailBase + tailSegs * 5;
  for (let s = 0; s < 5; s++) {
    const sNext = (s + 1) % 5;
    b.idx.push(rootCap, tailBase + sNext, tailBase + s);
    b.idx.push(tipCap, lastTail + s, lastTail + sNext);
  }

  // Lateral 3D eyes on cephalic lobe bases (`partId = 4`, `aAux.x = span u`)
  appendCornealEyes(b, 0.195, 0.012, 0.46, 0.022, 0.14);
  return finalizeSculptedGeometry(b);
}

/** G8: Spotted Eagle Ray (`eagle_ray` — `Aetobatus narinari`) — projecting duck-bill snout, domed head, falcate wings, pelvic fins, whip tail! */
function buildG8EagleRayGeo(low: boolean): T.BufferGeometry {
  const NU = low ? 32 : 52;
  const M = low ? 12 : 16;
  const b = createSculptBuffers();

  for (let i = 0; i <= NU; i++) {
    const u = (i / NU) * 2 - 1;
    const a = Math.abs(u);
    // Projecting rounded duck-bill rostrum around u=0 (`+0.27` forward snout lobe, zero cephalic horn notch!)
    const snoutProj = 0.27 * Math.exp(-Math.pow(u / 0.16, 2));
    const zl = 0.48 + snoutProj - 0.78 * Math.pow(a, 1.28) - 0.06 * Math.pow(a, 4);
    const zt = -0.48 + 0.26 * Math.pow(a, 0.85) - 0.14 * Math.pow(a, 2.6);
    // Elevated cranial dome near centerline (`u < 0.18`), flattened spade snout tip
    const cranium = 0.135 * Math.exp(-Math.pow(u / 0.17, 2));
    const th = 0.068 * Math.pow(Math.max(0, 1 - a), 1.2) + 0.004 + cranium;

    for (let j = 0; j < M; j++) {
      const ang = (j / M) * Math.PI * 2;
      const t = 0.5 - 0.5 * Math.cos(ang);
      // Flatten forward duck-bill snout tip (`t < 0.25 && a < 0.18`)
      const snoutFlat = a < 0.22 && t < 0.28 ? 0.52 + 0.48 * (t / 0.28) : 1.0;
      const y = th * snoutFlat * Math.sin(ang) * (1 - 0.52 * t) * (Math.sin(ang) < 0 ? 0.42 : 1.0);
      const z = zl + (zt - zl) * t;
      b.pos.push(u * 1.18, y, z);
      b.aux.push(u, Math.sin(ang), z, 0);
    }
  }

  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < M; j++) {
      const jNext = (j + 1) % M;
      const a0 = i * M + j;
      const a1 = i * M + jNext;
      const b0 = (i + 1) * M + j;
      const b1 = (i + 1) * M + jNext;
      b.idx.push(a0, b0, b1, a0, b1, a1);
    }
  }

  // Seal left (u = -1) and right (u = +1) wingtip cross-sections for closed-manifold integrity
  const leftTipCap = b.pos.length / 3;
  b.pos.push(-1.185, 0, -0.30);
  b.aux.push(-1.0, 0, -0.30, 0);
  const rightTipCap = b.pos.length / 3;
  b.pos.push(1.185, 0, -0.30);
  b.aux.push(1.0, 0, -0.30, 0);
  const rightWingRing = NU * M;
  for (let j = 0; j < M; j++) {
    const jNext = (j + 1) % M;
    b.idx.push(leftTipCap, j, jNext);
    b.idx.push(rightTipCap, rightWingRing + jNext, rightWingRing + j);
  }

  // Paired rounded pelvic lobes flanking tail base
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.04, xAbs: 0.055, y: -0.015, zLead: -0.38, zTrail: -0.52, thick: 0.012, uLead: 0.04, uTrail: 0.04, dorsalVal: -0.44 },
      { spanFrac: 0.14, xAbs: 0.165, y: -0.020, zLead: -0.44, zTrail: -0.60, thick: 0.005, uLead: 0.14, uTrail: 0.14, dorsalVal: -0.54 },
    ],
    1,
  );

  // Distinct Eagle Ray dorsal fin at tail base
  appendMedianHydrofoilFin(
    b,
    [
      { rz: -0.40, ry: 0.032, tz: -0.47, ty: 0.098, uRoot: 0, uTip: 0, dorsalRoot: 0.55, dorsalTip: -0.45 },
      { rz: -0.49, ry: 0.018, tz: -0.53, ty: 0.045, uRoot: 0, uTip: 0, dorsalRoot: 0.45, dorsalTip: -0.51 },
    ],
    0.007,
    1,
  );

  // Long slender whip tail (`1.75x` disc, `partId = 2`)
  const tailSegs = 8;
  const tailBase = b.pos.length / 3;
  for (let k = 0; k <= tailSegs; k++) {
    const f = k / tailSegs;
    const r = 0.022 * (1 - f * 0.90);
    const tz = -0.46 - f * 1.68;
    const ty = -0.008 - f * f * 0.04;
    for (let s = 0; s < 5; s++) {
      const ang = (s / 5) * Math.PI * 2;
      b.pos.push(Math.cos(ang) * r, ty + Math.sin(ang) * r, tz);
      b.aux.push(0, Math.sin(ang), tz, 2);
    }
  }
  for (let k = 0; k < tailSegs; k++) {
    for (let s = 0; s < 5; s++) {
      const sNext = (s + 1) % 5;
      const p0 = tailBase + k * 5 + s;
      const p1 = tailBase + k * 5 + sNext;
      const p2 = tailBase + (k + 1) * 5 + sNext;
      const p3 = tailBase + (k + 1) * 5 + s;
      b.idx.push(p0, p1, p2, p0, p2, p3);
    }
  }
  const rootCap = b.pos.length / 3;
  b.pos.push(0, -0.008, -0.455);
  b.aux.push(0, 0, -0.455, 2);
  const tipCap = b.pos.length / 3;
  b.pos.push(0, -0.05, -2.16);
  b.aux.push(0, 0, -2.16, 2);
  const lastTail = tailBase + tailSegs * 5;
  for (let s = 0; s < 5; s++) {
    const sNext = (s + 1) % 5;
    b.idx.push(rootCap, tailBase + sNext, tailBase + s);
    b.idx.push(tipCap, lastTail + s, lastTail + sNext);
  }

  // Prominent lateral cranial 3D eyes behind duck-bill snout
  appendCornealEyes(b, 0.142, 0.058, 0.44, 0.024, 0.12);
  return finalizeSculptedGeometry(b);
}

/** G9: Volumetric 3D Green Sea Turtle (`sea_turtle` — `Chelonia mydas`) — domed carapace + 3D neck/head/beak + 3D hydrofoil flippers! */
function buildG9SeaTurtleGeo(low: boolean): T.BufferGeometry {
  const b = createSculptBuffers();
  const rings = low ? 8 : 11;
  const segs = low ? 12 : 16;

  // 1. Watertight domed heart-oval carapace + marginal rim + flat plastron
  const shellBase = b.pos.length / 3;
  const topApex = shellBase;
  b.pos.push(0, 0.205, -0.02);
  b.aux.push(0.5, 0, 1.0, 0);

  for (let r = 1; r < rings; r++) {
    const v = r / rings;
    const phi = v * Math.PI;
    const sinP = Math.sin(phi);
    const cosP = Math.cos(phi);
    const rimFlare = Math.exp(-Math.pow((v - 0.52) / 0.11, 2)) * 0.032;
    const y = cosP >= 0 ? cosP * 0.205 : cosP * 0.072;

    for (let s = 0; s < segs; s++) {
      const theta = (s / segs) * Math.PI * 2;
      const st = Math.sin(theta);
      const ct = Math.cos(theta);
      // Slight posterior taper (heart-shaped Chelonia carapace)
      const rearTaper = ct < 0 ? 1.0 + ct * 0.14 : 1.0 - ct * 0.04;
      const x = st * (sinP * 0.37 + rimFlare) * rearTaper;
      const z = ct * (sinP * 0.46 + rimFlare * 0.8);
      b.pos.push(x, y, z);
      b.aux.push(clamp((0.46 - z) / 0.92, 0, 1), st, cosP, 0);
    }
  }

  const botApex = b.pos.length / 3;
  b.pos.push(0, -0.072, -0.02);
  b.aux.push(0.5, 0, -1.0, 0);

  const firstRing = shellBase + 1;
  for (let s = 0; s < segs; s++) {
    const sNext = (s + 1) % segs;
    b.idx.push(topApex, firstRing + s, firstRing + sNext);
  }
  for (let r = 0; r < rings - 2; r++) {
    const r0 = firstRing + r * segs;
    const r1 = firstRing + (r + 1) * segs;
    for (let s = 0; s < segs; s++) {
      const sNext = (s + 1) % segs;
      b.idx.push(r0 + s, r1 + s, r1 + sNext, r0 + s, r1 + sNext, r0 + sNext);
    }
  }
  const lastShellRing = firstRing + (rings - 2) * segs;
  for (let s = 0; s < segs; s++) {
    const sNext = (s + 1) % segs;
    b.idx.push(botApex, lastShellRing + sNext, lastShellRing + s);
  }

  // 2. True Volumetric 3D Sculpted Neck, Cranium & Hooked Beak (replaces flat 2D quad!)
  appendClosedSuperellipseHull(b, {
    stationsZ: [0.66, 0.62, 0.56, 0.49, 0.42, 0.36],
    halfHeights: [0.032, 0.056, 0.068, 0.062, 0.054, 0.058],
    halfWidths: [0.028, 0.050, 0.062, 0.056, 0.052, 0.058],
    camberY: [0.012, 0.028, 0.038, 0.032, 0.022, 0.015],
    expX: 2.1,
    expY: 2.0,
    snoutTipExt: 0.025,
    snoutTipY: 0.006,
    sides: low ? 6 : 8,
  });

  // Short sculpted tail cone at rear of carapace
  appendClosedSuperellipseHull(b, {
    stationsZ: [-0.41, -0.47, -0.53, -0.58],
    halfHeights: [0.034, 0.026, 0.016, 0.008],
    halfWidths: [0.036, 0.026, 0.016, 0.008],
    camberY: [-0.015, -0.022, -0.028, -0.032],
    expX: 2.0,
    expY: 2.0,
    snoutTipExt: 0.01,
    sides: 6,
  });

  // 3. Volumetric 3D Swept Hydrofoil Fore-Flippers (`partId = 2` for figure-8 power stroke!)
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.05, xAbs: 0.27, y: -0.005, zLead: 0.30, zTrail: 0.14, thick: 0.024, uLead: 0.22, uTrail: 0.36, dorsalVal: 0.25 },
      { spanFrac: 0.38, xAbs: 0.48, y: 0.012, zLead: 0.26, zTrail: 0.08, thick: 0.018, uLead: 0.26, uTrail: 0.42, dorsalVal: 0.32 },
      { spanFrac: 0.72, xAbs: 0.69, y: 0.018, zLead: 0.16, zTrail: -0.02, thick: 0.011, uLead: 0.34, uTrail: 0.50, dorsalVal: 0.36 },
      { spanFrac: 1.0, xAbs: 0.84, y: 0.010, zLead: 0.04, zTrail: -0.09, thick: 0.004, uLead: 0.45, uTrail: 0.57, dorsalVal: 0.38 },
    ],
    2,
  );

  // 4. Volumetric 3D Hind Rudder Flippers (`partId = 3`)
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.08, xAbs: 0.19, y: -0.022, zLead: -0.32, zTrail: -0.44, thick: 0.016, uLead: 0.82, uTrail: 0.90, dorsalVal: 0.20 },
      { spanFrac: 0.60, xAbs: 0.33, y: -0.028, zLead: -0.41, zTrail: -0.56, thick: 0.010, uLead: 0.88, uTrail: 0.98, dorsalVal: 0.24 },
      { spanFrac: 1.0, xAbs: 0.42, y: -0.032, zLead: -0.50, zTrail: -0.62, thick: 0.004, uLead: 0.94, uTrail: 1.02, dorsalVal: 0.26 },
    ],
    3,
  );

  appendCornealEyes(b, 0.056, 0.048, 0.585, 0.020, 0.08);
  return finalizeSculptedGeometry(b);
}

/** G10: Sleek Carcharhinid Reef Shark (`reef_shark` — `Carcharhinus melanopterus`) — 1st/2nd dorsal, pelvic/anal, heterocercal notched tail! */
function buildG10ReefSharkGeo(low: boolean): T.BufferGeometry {
  const b = createSculptBuffers();
  const sides = low ? 8 : 12;
  appendClosedSuperellipseHull(b, {
    stationsZ: [0.58, 0.50, 0.40, 0.28, 0.14, -0.01, -0.15, -0.26, -0.35, -0.41, -0.45, -0.48, -0.50],
    halfHeights: [0.020, 0.058, 0.098, 0.128, 0.142, 0.135, 0.114, 0.086, 0.062, 0.046, 0.036, 0.032, 0.028],
    halfWidths: [0.028, 0.068, 0.096, 0.112, 0.116, 0.104, 0.084, 0.062, 0.044, 0.032, 0.024, 0.020, 0.016],
    camberY: [-0.012, -0.006, 0.004, 0.012, 0.016, 0.014, 0.010, 0.006, 0.003, 0, 0, 0, 0],
    expX: 2.15,
    expY: 1.9,
    snoutTipExt: 0.045,
    snoutTipY: -0.012,
    sides,
    ventralFlatten: 0.72,
  });

  // Tall iconic falcate 1st dorsal fin (crisp black-and-white tip at dorsalTip -> 1.0!)
  appendMedianHydrofoilFin(
    b,
    [
      { rz: 0.16, ry: 0.135, tz: 0.02, ty: 0.375, uRoot: 0.40, uTip: 0.52, dorsalRoot: 0.65, dorsalTip: 1.0 },
      { rz: 0.04, ry: 0.138, tz: -0.06, ty: 0.295, uRoot: 0.50, uTip: 0.59, dorsalRoot: 0.65, dorsalTip: 0.90 },
      { rz: -0.05, ry: 0.125, tz: -0.10, ty: 0.155, uRoot: 0.58, uTip: 0.63, dorsalRoot: 0.62, dorsalTip: 0.70 },
    ],
    0.012,
    1,
  );

  // Distinct Carcharhinid 2nd dorsal fin ahead of precaudal pit
  appendMedianHydrofoilFin(
    b,
    [
      { rz: -0.28, ry: 0.075, tz: -0.35, ty: 0.155, uRoot: 0.79, uTip: 0.85, dorsalRoot: 0.65, dorsalTip: 0.96 },
      { rz: -0.36, ry: 0.055, tz: -0.40, ty: 0.082, uRoot: 0.86, uTip: 0.90, dorsalRoot: 0.62, dorsalTip: 0.75 },
    ],
    0.007,
    1,
  );

  // Opposing anal fin beneath 2nd dorsal
  appendMedianHydrofoilFin(
    b,
    [
      { rz: -0.30, ry: -0.058, tz: -0.37, ty: -0.132, uRoot: 0.81, uTip: 0.87, dorsalRoot: -0.65, dorsalTip: -0.95 },
      { rz: -0.37, ry: -0.042, tz: -0.41, ty: -0.065, uRoot: 0.87, uTip: 0.91, dorsalRoot: -0.62, dorsalTip: -0.75 },
    ],
    0.006,
    1,
  );

  // True asymmetric HETEROCERCAL caudal fin with elongated swept upper lobe + subterminal notch!
  appendSculptedCaudalFin(b, -0.50, 0.028, {
    upperLen: 0.34,
    lowerLen: 0.17,
    upperHeight: 0.255,
    lowerHeight: 0.135,
    forkDepth: 0.58,
    halfThick: 0.011,
    subterminalNotch: true,
  });

  // Wide low-slung swept falcate pectoral hydrofoils + pelvic fins
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.095, y: -0.068, zLead: 0.24, zTrail: 0.06, thick: 0.012, uLead: 0.33, uTrail: 0.49, dorsalVal: 0.55 },
      { spanFrac: 0.55, xAbs: 0.255, y: -0.088, zLead: 0.13, zTrail: -0.03, thick: 0.008, uLead: 0.43, uTrail: 0.57, dorsalVal: 0.78 },
      { spanFrac: 1.0, xAbs: 0.385, y: -0.098, zLead: 0.0, zTrail: -0.10, thick: 0.003, uLead: 0.54, uTrail: 0.63, dorsalVal: 0.98 },
    ],
    2,
  );
  appendPairedHydrofoilFin(
    b,
    [
      { spanFrac: 0.0, xAbs: 0.052, y: -0.072, zLead: -0.14, zTrail: -0.23, thick: 0.007, uLead: 0.67, uTrail: 0.75, dorsalVal: 0.55 },
      { spanFrac: 1.0, xAbs: 0.135, y: -0.092, zLead: -0.21, zTrail: -0.28, thick: 0.0025, uLead: 0.73, uTrail: 0.79, dorsalVal: 0.88 },
    ],
    3,
  );

  appendCornealEyes(b, 0.076, 0.024, 0.455, 0.021, 0.15);
  return finalizeSculptedGeometry(b);
}

function buildAllBodyPlanGeometries(low: boolean): T.BufferGeometry[] {
  return [
    buildG0AnemonefishGeo(low),
    buildG1DiscoidReefGeo(low),
    buildG2MoorishIdolGeo(low),
    buildG3ReefGrazerGeo(low),
    buildG4GrouperGeo(low),
    buildG5PelagicScombridGeo(low),
    buildG6FlyingFishGeo(low),
    buildG7GiantMantaGeo(low),
    buildG8EagleRayGeo(low),
    buildG9SeaTurtleGeo(low),
    buildG10ReefSharkGeo(low),
  ];
}

// ============================================================================
// 2. Underwater-Optics-Bound GPU Shaders (Analytical Normals + All 14 Species)
// ============================================================================

export type MarineUnderwaterOpticsUniforms = Pick<
  SharedUnderwaterUniforms,
  | 'uSunDir'
  | 'uSunTint'
  | 'uGrottoBoost'
  | 'tWater'
  | 'tZoneMap'
  | 'tShadow'
  | 'uShadowMatrix'
  | 'uShadowTexel'
  | 'uShadowEnabled'
>;

interface InternalOpticsFallback {
  waterTex: T.DataTexture;
  zoneTex: T.DataTexture;
  shadowDepthTex: T.DepthTexture;
  dispose(): void;
}

function createInternalOpticsFallback(): InternalOpticsFallback {
  const waterTex = new T.DataTexture(new Uint8Array([90, 90, 128, 128]), 1, 1, T.RGBAFormat, T.UnsignedByteType);
  waterTex.wrapS = T.RepeatWrapping;
  waterTex.wrapT = T.RepeatWrapping;
  waterTex.needsUpdate = true;
  waterTex.name = 'MarineFallbackWater';

  const zoneTex = new T.DataTexture(new Uint8Array([0, 32, 16, 180]), 1, 1, T.RGBAFormat, T.UnsignedByteType);
  zoneTex.wrapS = T.ClampToEdgeWrapping;
  zoneTex.wrapT = T.ClampToEdgeWrapping;
  zoneTex.needsUpdate = true;
  zoneTex.name = 'MarineFallbackZone';

  const shadowDepthTex = new T.DepthTexture(2, 2, T.UnsignedIntType);
  shadowDepthTex.format = T.DepthFormat;
  shadowDepthTex.compareFunction = T.LessEqualCompare;
  shadowDepthTex.minFilter = T.LinearFilter;
  shadowDepthTex.magFilter = T.LinearFilter;
  shadowDepthTex.name = 'MarineFallbackShadowDepth';

  return {
    waterTex,
    zoneTex,
    shadowDepthTex,
    dispose() {
      waterTex.dispose();
      zoneTex.dispose();
      shadowDepthTex.dispose();
    },
  };
}

const MARINE_UNDERWATER_SAMPLERS_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunTint;
uniform float uGrottoBoost;
uniform sampler2D tWater;
uniform sampler2D tZoneMap;
uniform highp sampler2DShadow tShadow;
uniform mat4 uShadowMatrix;
uniform float uShadowTexel;
uniform float uShadowEnabled;

float uwFishZone(vec3 p) {
  vec4 zm = texture(tZoneMap, p.xz / 960.0 + 0.5);
  return clamp(mix(uGrottoBoost, zm.b, 0.65), 0.0, 1.0);
}

vec2 uwFishOpenSky(vec3 p) {
  vec4 zm = texture(tZoneMap, p.xz / 960.0 + 0.5);
  float subDepth = max(0.0, WATER_Y - p.y);
  float canopyOcc = zm.g;
  float sky = clamp((1.0 - 0.52 * canopyOcc) * exp(-subDepth * 0.014), 0.14, 1.0);
  float open = clamp(0.88 - 0.36 * canopyOcc, 0.32, 1.0);
  return vec2(open, sky);
}

float uwFishShadow1(vec3 wp) {
  if (uShadowEnabled < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  vec3 s = sc.xyz / max(sc.w, 1e-5);
  if (s.x <= 0.002 || s.x >= 0.998 || s.y <= 0.002 || s.y >= 0.998 || s.z <= 0.0 || s.z >= 0.999) {
    return 1.0;
  }
  float zRef = s.z - 0.0006;
  float tx = uShadowTexel * 1.35;
  float sum = texture(tShadow, vec3(s.xy + vec2(-0.6, -0.2) * tx, zRef))
            + texture(tShadow, vec3(s.xy + vec2( 0.6,  0.2) * tx, zRef))
            + texture(tShadow, vec3(s.xy + vec2(-0.2,  0.6) * tx, zRef))
            + texture(tShadow, vec3(s.xy + vec2( 0.2, -0.6) * tx, zRef));
  return sum * 0.25;
}

vec3 shadeMarineLitAndFog(vec3 baseCol, vec3 N, vec3 V, vec3 wp, float specPow, float specBoost) {
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), specPow) * specBoost;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  float subDepth = WATER_Y - wp.y;
  float viewDist = max(length(cameraPosition - wp), 1e-4);

  // Sunlit wet-scale aerial shading (leaping fish above waves or caught specimen on leader — never tinted dark underwater blue!)
  float skyUp = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 skyFill = mix(vec3(0.34, 0.42, 0.50), vec3(0.54, 0.66, 0.80), skyUp);
  float wetSpec = pow(max(dot(N, H), 0.0), specPow * 1.32) * (specBoost * 1.18 + 0.22);
  vec3 airLit = baseCol * (skyFill + uSunTint * (0.86 * ndl))
              + uSunTint * wetSpec * 0.98
              + vec3(0.36, 0.56, 0.72) * rim * 0.28;
  vec3 safeAir = uwSafeHDR(airLit, 12.0);

  if (subDepth <= -0.05) {
    return safeAir;
  }

  float z = uwFishZone(wp);
  vec2 os = uwFishOpenSky(wp);
  float shad = uwFishShadow1(wp + N * 0.12);
  vec3 E = uwSunE(wp.y, z, uSunDir) * uSunTint * shad;
  vec3 ca = uwCausticsRGB(tWater, wp, viewDist, uSunDir);
  float caMask = uwSS(-0.15, 0.55, N.y) * exp(-max(subDepth, 0.0) * 0.11);

  vec3 amb = uwAmb(wp, N, os.y, z) * 1.28 + uwSide(wp, N, os.x, z) * 0.62;
  vec3 c = baseCol * (E * (0.24 + 0.76 * ndl) * (0.68 + 0.58 * ca * caMask) + amb)
         + E * spec * (0.65 + 0.45 * ca * caMask)
         + vec3(0.22, 0.52, 0.66) * rim * 0.24 * os.y;

  vec3 safeSub;
  if (cameraPosition.y <= WATER_Y + 0.08) {
    safeSub = uwSafeHDR(uwApplyFog(c, wp, cameraPosition, z, uSunDir, os.y), 14.0);
  } else {
    float airBlend = uwSS(WATER_Y + 0.08, WATER_Y + 0.65, cameraPosition.y);
    float subPath = clamp(max(subDepth, 0.0) / max(-V.y, 0.14), 0.0, 52.0);
    vec3 refracted = c * exp(-uwSg(z) * subPath * 0.58)
                   + mix(vec3(0.03, 0.28, 0.38), UW_WCOL * 0.55, z) * (1.0 - exp(-0.045 * subPath)) * 0.42;
    safeSub = uwSafeHDR(mix(uwApplyFog(c, wp, cameraPosition, z, uSunDir, os.y), refracted, airBlend), 14.0);
  }

  // Smooth 14 cm waterline transition across Gerstner wave crests/troughs so breaching fish never band-snap
  float subMix = uwSS(-0.05, 0.09, subDepth);
  return mix(safeAir, safeSub, subMix);
}
`;

function createMarineUniformDict(fb: InternalOpticsFallback): Record<string, T.IUniform> {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new T.Vector3(-0.58, 0.75, 0.40).normalize() },
    uSunTint: { value: new T.Vector3(1, 1, 1) },
    uGrottoBoost: { value: 0.06 },
    tWater: { value: fb.waterTex },
    tZoneMap: { value: fb.zoneTex },
    tShadow: { value: fb.shadowDepthTex },
    uShadowMatrix: { value: new T.Matrix4() },
    uShadowTexel: { value: 1 / 1024 },
    uShadowEnabled: { value: 0 },
  };
}

/**
 * Custom GPU Instanced ShaderMaterial for Body Plans `G0..G6, G9, G10`
 * (Analytical deformed S-wave normals, labriform pectoral rowing, biplane wing spread,
 * chelonian figure-8 flipper stroke, 3D corneal eyes, and explicit markings for patterns 1..10, 13, 14).
 */
function createFishGroupShaderMaterial(fb: InternalOpticsFallback): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'ArchipelagoAnatomicalFish',
    side: T.DoubleSide,
    uniforms: createMarineUniformDict(fb),
    vertexShader: /* glsl */ `
      attribute vec4 aAux;        // x: spineU, y: span/eyeU, z: dorsal, w: partId
      attribute vec4 aInstMeta;   // x: phase, y: swimFreq, z: patternId, w: glideOrThrash
      attribute vec3 aInstAccent;

      uniform float uTime;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec4 vAux;
      varying vec4 vMeta;
      varying vec3 vPrimary;
      varying vec3 vAccent;

      void main() {
        vec3 p = position;
        vec3 n = normal;
        float u = max(0.0, aAux.x);
        float span = aAux.y;
        float partId = aAux.w;
        float phase = aInstMeta.x;
        float freq = aInstMeta.y;
        float pat = aInstMeta.z;
        float extra = aInstMeta.w;

        if (pat > 12.5 && pat < 13.5) {
          // G9: Green Sea Turtle figure-8 Chelonian fore-flipper power stroke + analytical normal rotation
          float cyc = uTime * freq + phase;
          p.y += sin(cyc) * 0.018;
          if (partId > 1.5 && partId < 2.5) {
            float aspan = abs(span);
            float fp = cyc - aspan * 0.95;
            float sf = sin(fp);
            float cf = cos(fp);
            p.y += 0.25 * aspan * sf;
            p.z += 0.08 * aspan * cf;
            float dYdX = 0.25 * (sf - aspan * 0.95 * cf) * sign(span);
            n = normalize(vec3(n.x - dYdX * n.y, n.y + dYdX * n.x, n.z));
          } else if (partId > 2.5 && partId < 3.5) {
            float aspan = abs(span);
            p.y += sin(cyc + 2.4) * 0.07 * aspan;
          }
        } else {
          // Biomechanical body-caudal undulation with analytical slope normal rotation!
          float glide = (pat > 9.5 && pat < 10.5) ? clamp(extra, 0.0, 1.0) : 0.0;
          float thrash = (pat > 9.5 && pat < 10.5) ? 0.0 : clamp(extra, 0.0, 1.2);
          float ampScale = (1.0 - 0.65 * glide) * (1.0 + 0.42 * thrash);

          float A0 = 0.007;
          float A1 = 0.138;
          float expU = 1.85;
          float kU = 5.0;

          if (pat > 7.5 && pat < 9.5) {
            // Thunniform stiff anterior hull + concentrated peduncle/lunate tail drive
            A0 = 0.004;
            A1 = 0.148;
            expU = 2.45;
            kU = 4.6;
          } else if (pat > 13.5) {
            // Carcharhinid sinuous shark wave
            A0 = 0.010;
            A1 = 0.172;
            expU = 1.72;
            kU = 5.35;
          }

          float uClamped = min(u, 1.35);
          float uPow = pow(max(uClamped, 1e-4), expU);
          float snoutPin = 1.0 - clamp(thrash * 1.25, 0.0, 1.0);
          float dAdU = A1 * expU * pow(max(uClamped, 1e-4), expU - 1.0) * ampScale;
          float A = (A0 * snoutPin + A1 * uPow) * ampScale;

          // Moorish Idol flowing filamentous dorsal pennant streamer wave
          if (pat > 5.5 && pat < 6.5 && partId > 2.5 && partId < 3.5 && uClamped > 0.52) {
            float su = uClamped - 0.52;
            A += 0.11 * su * su;
            p.y += sin(uTime * freq * 0.85 + phase - uClamped * 6.2) * 0.045 * su;
          }

          float th = uTime * freq + phase - kU * uClamped;
          float sTh = sin(th);
          float cTh = cos(th);
          p.x += A * sTh;

          // du/dz ~= -1.04 => d(dx)/dz = -1.04 * (dAdU * sin(th) - kU * A * cos(th))
          float slopeXZ = -1.04 * (dAdU * sTh - kU * A * cTh);
          n = normalize(vec3(n.x, n.y, n.z - slopeXZ * n.x));

          // Labriform pectoral fin sculling (reef species) & Flying Fish biplane glide wing deployment
          if (partId > 1.5 && partId < 2.5) {
            float aspan = abs(span);
            if (pat > 9.5 && pat < 10.5) {
              float spread = mix(0.44, 1.18, glide);
              p.x *= spread;
              p.y += aspan * 0.075 * glide + sin(uTime * 26.0 + phase + aspan * 2.0) * 0.016 * glide * aspan;
            } else if (pat < 7.5) {
              float scull = sin(uTime * freq * 1.15 + phase + sign(span) * 0.45) * 0.24 * aspan;
              p.z += scull * 0.18;
              p.y += scull * 0.12;
            }
          } else if (pat > 9.5 && pat < 10.5 && partId > 2.5 && partId < 3.5) {
            p.x *= mix(0.55, 1.15, glide);
          }
        }

        mat4 instM = mat4(1.0);
        #ifdef USE_INSTANCING
          instM = instanceMatrix;
        #endif
        vec4 world = modelMatrix * instM * vec4(p, 1.0);
        vWorldPos = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * mat3(instM) * n);
        vAux = aAux;
        vMeta = aInstMeta;
        vPrimary = vec3(0.25, 0.62, 0.88);
        #ifdef USE_INSTANCING_COLOR
          vPrimary = instanceColor;
        #endif
        vAccent = aInstAccent;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${UNDERWATER_OPTICS_GLSL}
      ${MARINE_UNDERWATER_SAMPLERS_GLSL}

      uniform float uTime;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec4 vAux;
      varying vec4 vMeta;
      varying vec3 vPrimary;
      varying vec3 vAccent;

      void main() {
        vec3 N = normalize(gl_FrontFacing ? vNormalW : -vNormalW);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float pat = vMeta.z;
        float spineU = vAux.x;
        float span = vAux.y;
        float dorsal = vAux.z;
        float partId = vAux.w;

        // 1. 3D Hemispherical Corneal Eye (partId == 4)
        if (partId > 3.5) {
          float er = clamp(span, 0.0, 1.0);
          vec3 irisCol = (pat > 7.5 && pat < 10.5)
            ? vec3(0.78, 0.86, 0.94)
            : (pat > 12.5 && pat < 13.5)
              ? vec3(0.58, 0.46, 0.22)
              : vec3(0.92, 0.68, 0.18);
          vec3 eyeAlb = mix(vec3(0.015, 0.02, 0.03), irisCol, uwSS(0.46, 0.56, er));
          eyeAlb = mix(eyeAlb, vec3(0.06, 0.08, 0.11), uwSS(0.82, 0.96, er));
          vec3 eyeOut = shadeMarineLitAndFog(eyeAlb, N, V, vWorldPos, 96.0, 1.35);
          gl_FragColor = vec4(eyeOut, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          return;
        }

        float isFin = step(0.5, partId);
        float absLat = abs(span);
        float specPow = 32.0;
        float specBoost = 0.44;
        vec3 baseCol = mix(vAccent, vPrimary, uwSS(-0.55, 0.35, dorsal));

        // 2. Explicit Anatomical Markings for All Species Patterns (1..10, 13, 14)
        if (pat > 0.5 && pat < 1.5) {
          // 1: Ocellaris Clownfish — 3 white saddles, each with crisp black border + black fin rims
          float w1 = abs(spineU - 0.23 - 0.02 * dorsal);
          float w2 = abs(spineU - 0.52 + 0.04 * dorsal);
          float w3 = abs(spineU - 0.83);
          float inSaddleZone = 1.0 - isFin * step(0.60, spineU);
          float whiteBand = max(uwSS(0.065, 0.042, w1), max(uwSS(0.072, 0.046, w2), uwSS(0.055, 0.034, w3))) * inSaddleZone;
          float blackRim = max(
            uwSS(0.092, 0.068, w1) - uwSS(0.065, 0.042, w1),
            max(
              uwSS(0.100, 0.074, w2) - uwSS(0.072, 0.046, w2),
              uwSS(0.080, 0.056, w3) - uwSS(0.055, 0.034, w3)
            )
          ) * inSaddleZone;
          float finTipBlack = isFin * max(uwSS(0.84, 0.96, abs(dorsal)), uwSS(1.10, 1.17, spineU));
          baseCol = mix(vPrimary, vec3(0.97, 0.98, 0.99), clamp(whiteBand, 0.0, 1.0));
          baseCol = mix(baseCol, vec3(0.04, 0.04, 0.05), clamp(blackRim * 1.15 + finTipBlack * 0.92, 0.0, 1.0));
        } else if (pat > 1.5 && pat < 2.5) {
          // 2: Threadfin Butterflyfish — pearl front with chevron cross-stripes, gold rear, black eye-mask & dorsal ocellus
          float rearGold = uwSS(0.36, 0.58, spineU + dorsal * 0.26);
          vec3 pearl = vec3(0.95, 0.96, 0.94);
          float chevA = uwSS(0.62, 0.88, sin((spineU * 34.0 + dorsal * 11.0)) * 0.5 + 0.5);
          float chevB = uwSS(0.62, 0.88, sin((spineU * 34.0 - dorsal * 11.0)) * 0.5 + 0.5);
          float chev = mix(chevA, chevB, uwSS(-0.05, 0.15, dorsal)) * (1.0 - isFin) * uwSS(0.20, 0.30, spineU);
          baseCol = mix(pearl, vPrimary, rearGold);
          baseCol = mix(baseCol, vec3(0.28, 0.32, 0.38), chev * 0.42);
          float eyeMask = uwSS(0.052, 0.026, abs(spineU - 0.155 + dorsal * 0.02)) * (1.0 - isFin);
          float ocellus = uwSS(0.11, 0.055, length(vec2((spineU - 0.75) * 1.6, (dorsal - 0.72) * 1.1)));
          baseCol = mix(baseCol, vec3(0.05, 0.07, 0.11), clamp(eyeMask + ocellus, 0.0, 1.0));
        } else if (pat > 2.5 && pat < 3.5) {
          // 3: Regal Angelfish — curved alternating gold, black-rimmed white, and cobalt-sapphire zebra bars
          float bc = spineU * 27.0 - dorsal * 2.4;
          float sBar = sin(bc);
          float goldMask = uwSS(0.15, 0.55, sBar);
          float blueMask = uwSS(-0.15, -0.60, sBar);
          float whiteCore = 1.0 - max(goldMask, blueMask);
          baseCol = vPrimary * goldMask + vec3(0.14, 0.40, 0.92) * blueMask + vec3(0.95, 0.97, 1.0) * whiteCore;
          baseCol = mix(baseCol, vec3(0.07, 0.10, 0.18), (1.0 - abs(sBar)) * 0.32);
          if (isFin > 0.5 && spineU > 0.96) {
            baseCol = vec3(0.98, 0.78, 0.16);
          }
        } else if (pat > 3.5 && pat < 4.5) {
          // 4: Pacific Blue Tang — rich cobalt body, black painter-palette dorsal loop, canary-yellow wedge tail
          vec3 tangBlue = vec3(0.09, 0.42, 0.90);
          vec3 tangYellow = vec3(0.98, 0.82, 0.12);
          float upperArc = uwSS(0.16, 0.05, abs(dorsal - 0.46)) * uwSS(0.16, 0.24, spineU) * uwSS(0.92, 0.82, spineU);
          float lowerLoop = uwSS(0.14, 0.04, abs(dorsal - 0.06)) * uwSS(0.46, 0.56, spineU) * uwSS(0.90, 0.80, spineU);
          float peduncleBlack = uwSS(0.32, 0.15, abs(dorsal - 0.22)) * uwSS(0.74, 0.84, spineU) * uwSS(0.95, 0.88, spineU);
          float paletteMask = clamp(max(upperArc, max(lowerLoop, peduncleBlack)), 0.0, 1.0) * (1.0 - isFin * 0.75);
          float yellowTail = uwSS(0.84, 0.92, spineU) * (1.0 - uwSS(0.76, 0.94, abs(dorsal)));
          float tailRails = isFin * uwSS(0.94, 0.99, spineU) * uwSS(0.75, 0.92, abs(dorsal));
          float pectTip = step(1.5, partId) * step(partId, 2.5) * uwSS(0.45, 0.85, absLat);
          baseCol = mix(tangBlue, vec3(0.04, 0.05, 0.09), clamp(paletteMask + tailRails, 0.0, 1.0));
          baseCol = mix(baseCol, tangYellow, clamp(yellowTail + pectTip * 0.85, 0.0, 1.0));
        } else if (pat > 4.5 && pat < 5.5) {
          // 5: Rainbow Parrotfish — ivory fused beak, coral-mango head/breast -> turquoise diamond-scale flanks
          float rearTurq = uwSS(0.28, 0.58, spineU + dorsal * 0.24);
          vec3 coralHead = vec3(0.96, 0.44, 0.20);
          vec3 turqBody = vec3(0.06, 0.72, 0.64);
          float scales = cos(spineU * 38.0 + dorsal * 12.0) * cos(spineU * 38.0 - dorsal * 12.0);
          float scaleRim = uwSS(0.25, 0.75, scales) * (1.0 - isFin) * uwSS(0.14, 0.24, spineU);
          baseCol = mix(coralHead, turqBody, rearTurq);
          baseCol = mix(baseCol, mix(turqBody, coralHead, rearTurq) * 1.18, scaleRim * 0.34);
          // Ivory Scaridae beak at snout
          float beak = uwSS(0.085, 0.045, spineU) * (1.0 - isFin);
          baseCol = mix(baseCol, vec3(0.94, 0.92, 0.84), beak);
          float cyanTrim = isFin * uwSS(0.78, 0.96, abs(dorsal));
          baseCol = mix(baseCol, vec3(0.18, 0.85, 0.95), cyanTrim * 0.75);
        } else if (pat > 5.5 && pat < 6.5) {
          // 6: Moorish Idol — bold black-white-gold blocks + pure white whip pennant + black tail
          vec3 pureWhite = vec3(0.96, 0.97, 0.98);
          vec3 jetBlack = vec3(0.04, 0.05, 0.07);
          vec3 idolGold = vec3(0.95, 0.74, 0.10);
          float snoutGold = uwSS(0.12, 0.06, spineU) * uwSS(-0.15, 0.15, dorsal);
          float blackBar1 = uwSS(0.10, 0.13, spineU) * uwSS(0.36, 0.32, spineU);
          float rearGold = uwSS(0.55, 0.64, spineU) * uwSS(0.76, 0.70, spineU);
          float blackRear = uwSS(0.73, 0.78, spineU);
          float isPennant = step(2.5, partId) * step(partId, 3.5) * step(0.1, dorsal);
          baseCol = pureWhite;
          baseCol = mix(baseCol, idolGold, clamp(snoutGold + rearGold * 0.85, 0.0, 1.0));
          baseCol = mix(baseCol, jetBlack, clamp(blackBar1 + blackRear, 0.0, 1.0));
          baseCol = mix(baseCol, pureWhite, clamp(isPennant + isFin * uwSS(1.12, 1.18, spineU) * 0.75, 0.0, 1.0));
        } else if (pat > 6.5 && pat < 7.5) {
          // 7: Coral Trout Grouper — vermilion-crimson to rose body peppered with electric-cyan leopard spots
          vec3 crimson = vec3(0.84, 0.24, 0.19);
          vec3 roseBelly = vec3(0.94, 0.56, 0.48);
          baseCol = mix(roseBelly, crimson, uwSS(-0.55, 0.30, dorsal));
          vec2 uvSpot = vec2(spineU * 19.0, dorsal * 9.5 + span * 2.3);
          vec2 cellId = floor(uvSpot);
          vec2 cellF = fract(uvSpot) - 0.5;
          float jx = fract(sin(dot(cellId, vec2(127.1, 311.7))) * 43758.5453) - 0.5;
          float jy = fract(sin(dot(cellId, vec2(269.5, 183.3))) * 43758.5453) - 0.5;
          float dSpot = length(cellF - vec2(jx, jy) * 0.42);
          float spotMask = uwSS(0.24, 0.13, dSpot) * uwSS(0.06, 0.14, spineU) * uwSS(-0.65, -0.20, dorsal);
          baseCol = mix(baseCol, vec3(0.18, 0.80, 0.98), spotMask * 0.92);
        } else if (pat > 7.5 && pat < 8.5) {
          // 8: Spanish Mackerel — metallic blue-teal back, mirror-silver flanks, wavy vertical slate tiger bars
          specPow = 54.0;
          specBoost = 0.82;
          vec3 tealBack = vec3(0.14, 0.36, 0.52);
          vec3 silverFlank = vec3(0.86, 0.91, 0.95);
          baseCol = mix(silverFlank, tealBack, uwSS(0.08, 0.55, dorsal));
          float wavy = sin(spineU * 76.0 + sin(dorsal * 7.5) * 1.9);
          float barMask = uwSS(0.42, 0.78, wavy)
                        * (1.0 - isFin)
                        * uwSS(0.20, 0.28, spineU)
                        * uwSS(0.90, 0.80, spineU)
                        * uwSS(-0.48, -0.10, dorsal)
                        * uwSS(0.68, 0.35, dorsal);
          baseCol = mix(baseCol, vec3(0.16, 0.24, 0.34), barMask * 0.72);
        } else if (pat > 8.5 && pat < 9.5) {
          // 9: Yellowfin Tuna — midnight-sapphire back, silver belly, gold lateral stripe, vivid yellow sickle fins & finlets
          specPow = 58.0;
          specBoost = 0.86;
          vec3 navyBack = vec3(0.07, 0.16, 0.42);
          vec3 silverBelly = vec3(0.85, 0.89, 0.94);
          baseCol = mix(silverBelly, navyBack, uwSS(-0.08, 0.38, dorsal));
          float goldBand = uwSS(0.16, 0.03, abs(dorsal - 0.06)) * (1.0 - isFin) * uwSS(0.16, 0.28, spineU);
          baseCol = mix(baseCol, vec3(0.94, 0.78, 0.24), goldBand * 0.78);
          // Vivid yellow 2nd dorsal, sickle anal, and peduncle finlets
          float yellowSickle = isFin * uwSS(0.54, 0.59, spineU) * uwSS(0.96, 0.92, spineU);
          baseCol = mix(baseCol, vec3(0.99, 0.82, 0.10), yellowSickle * 0.95);
        } else if (pat > 9.5 && pat < 10.5) {
          // 10: Tropical Flying Fish — pelagic ultramarine back, gleaming silver belly, ribbed iridescent wings
          specPow = 48.0;
          specBoost = 0.72;
          baseCol = mix(vec3(0.90, 0.95, 0.99), vec3(0.10, 0.36, 0.84), uwSS(-0.12, 0.35, dorsal));
          if (partId > 1.5 && partId < 3.5) {
            float ribs = 0.5 + 0.5 * sin(absLat * 42.0);
            vec3 wingCol = mix(vec3(0.32, 0.68, 0.96), vec3(0.84, 0.95, 1.0), ribs * 0.55 + uwSS(0.72, 0.98, absLat) * 0.45);
            baseCol = wingCol;
          }
        } else if (pat > 12.5 && pat < 13.5) {
          // 13: Green Sea Turtle — polygonal keratin scute mosaic on carapace, ochre plastron, scaled flippers
          if (isFin < 0.5 && spineU > 0.14 && spineU < 0.88) {
            if (dorsal > -0.06) {
              float scX = cos(spineU * 19.0);
              float scY = cos(span * 11.0);
              float suture = uwSS(0.82, 0.96, max(abs(scX), abs(scY)));
              float sunburst = 0.5 + 0.5 * sin(spineU * 38.0 + absLat * 22.0);
              vec3 oliveShell = mix(vec3(0.22, 0.34, 0.08), vec3(0.56, 0.40, 0.14), sunburst * 0.65);
              baseCol = mix(oliveShell, vec3(0.10, 0.14, 0.05), suture * 0.72);
            } else {
              baseCol = vec3(0.86, 0.74, 0.46);
            }
          } else {
            float leath = 0.5 + 0.5 * cos(spineU * 45.0) * cos(span * 32.0);
            baseCol = mix(vec3(0.24, 0.34, 0.12), vec3(0.76, 0.68, 0.46), uwSS(0.55, 0.88, leath) * 0.55);
          }
        } else if (pat > 13.5) {
          // 14: Blacktip Reef Shark — bronze-slate back, white belly + flank wedge, crisp white-under-black fin tips
          vec3 sharkBelly = vec3(0.91, 0.93, 0.95);
          vec3 sharkBack = vec3(0.36, 0.43, 0.49);
          float flankWedge = uwSS(0.12, 0.02, abs(dorsal + 0.08)) * uwSS(0.35, 0.72, spineU) * (1.0 - isFin);
          baseCol = mix(sharkBelly, sharkBack, uwSS(-0.28, 0.18, dorsal));
          baseCol = mix(baseCol, sharkBelly, flankWedge * 0.55);
          if (isFin > 0.5) {
            float tipMetric = max(abs(dorsal), uwSS(1.06, 1.18, spineU));
            float whiteSub = uwSS(0.68, 0.78, tipMetric) * (1.0 - uwSS(0.82, 0.88, tipMetric));
            float blackTip = uwSS(0.82, 0.90, tipMetric);
            baseCol = mix(baseCol, vec3(0.95, 0.97, 0.99), whiteSub * 0.85);
            baseCol = mix(baseCol, vec3(0.04, 0.06, 0.10), blackTip * 0.96);
          }
        }

        vec3 lit = shadeMarineLitAndFog(baseCol, N, V, vWorldPos, specPow, specBoost);
        gl_FragColor = vec4(lit, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Custom GPU Instanced ShaderMaterial for Mobuliform Rays (`G7 = manta_ray`, `G8 = eagle_ray`)
 * with analytical flexing wing normals, shoulder chevrons / dorsal ring constellations, 5-pair ventral gills,
 * 3D corneal eyes (`partId = 4`), and bound `UNDERWATER_OPTICS_GLSL`.
 */
function createMantaRayShaderMaterial(fb: InternalOpticsFallback): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'ArchipelagoMobuliformRays',
    side: T.DoubleSide,
    uniforms: createMarineUniformDict(fb),
    vertexShader: /* glsl */ `
      attribute vec4 aAux;      // x: span u (-1..1), y: dorsalSign / eyeU, z: localZ / sx, w: partId
      attribute vec4 aInstMeta; // x: phase, y: swimFreq, z: patternId (11=manta, 12=eagle_ray), w: bankAngle
      attribute vec3 aInstAccent;

      uniform float uTime;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec4 vAux;
      varying vec4 vMeta;
      varying vec3 vPrimary;
      varying vec3 vAccent;

      void main() {
        vec3 p = position;
        vec3 n = normal;
        float u = aAux.x;
        float au = abs(u);
        float partId = aAux.w;
        float phase = aInstMeta.x;
        float freq = aInstMeta.y;

        // Travelling mobuliform wing wave + analytical slope normal rotation
        float fp = uTime * freq + phase - 1.25 * au;
        float sf = sin(fp);
        float cf = cos(fp);
        if (partId < 3.5) {
          p.y += 0.36 * pow(au, 1.6) * sf - 0.10 * sin(uTime * freq + phase);
          if (partId > 1.5 && partId < 2.5) {
            p.x += sin(uTime * freq * 0.85 + phase + p.z * 2.1) * 0.045 * max(0.0, -p.z - 0.4);
          }
        } else {
          p.y += -0.10 * sin(uTime * freq + phase);
        }

        float sl = (partId < 1.5 && au > 1e-3)
          ? (0.576 * pow(au, 0.6) * sf - 0.45 * pow(au, 1.6) * cf) * sign(u)
          : 0.0;
        vec3 flexedN = normalize(vec3(n.x - sl * n.y, n.y + sl * n.x, n.z));

        float bank = aInstMeta.w;
        float cb = cos(bank);
        float sb = sin(bank);
        p.xy = vec2(p.x * cb - p.y * sb, p.x * sb + p.y * cb);
        flexedN.xy = vec2(flexedN.x * cb - flexedN.y * sb, flexedN.x * sb + flexedN.y * cb);

        mat4 instM = mat4(1.0);
        #ifdef USE_INSTANCING
          instM = instanceMatrix;
        #endif
        vec4 world = modelMatrix * instM * vec4(p, 1.0);
        vWorldPos = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * mat3(instM) * flexedN);
        vAux = aAux;
        vMeta = aInstMeta;
        vPrimary = vec3(0.12, 0.16, 0.24);
        #ifdef USE_INSTANCING_COLOR
          vPrimary = instanceColor;
        #endif
        vAccent = aInstAccent;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${UNDERWATER_OPTICS_GLSL}
      ${MARINE_UNDERWATER_SAMPLERS_GLSL}

      uniform float uTime;
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec4 vAux;
      varying vec4 vMeta;
      varying vec3 vPrimary;
      varying vec3 vAccent;

      void main() {
        vec3 N = normalize(gl_FrontFacing ? vNormalW : -vNormalW);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float u = vAux.x;
        float au = abs(u);
        float dorsalSign = vAux.y;
        float opZ = vAux.z;
        float partId = vAux.w;

        if (partId > 3.5) {
          float er = clamp(dorsalSign, 0.0, 1.0);
          vec3 eyeAlb = mix(vec3(0.015, 0.02, 0.03), vec3(0.85, 0.68, 0.24), uwSS(0.46, 0.58, er));
          eyeAlb = mix(eyeAlb, vPrimary, uwSS(0.82, 0.96, er));
          vec3 eyeOut = shadeMarineLitAndFog(eyeAlb, N, V, vWorldPos, 92.0, 1.25);
          gl_FragColor = vec4(eyeOut, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          return;
        }

        float isEagle = step(11.5, vMeta.z);
        vec3 belly = vec3(0.92, 0.95, 0.97);
        vec3 dorsalCol = vPrimary;

        if (isEagle < 0.5) {
          // 11: Giant Reef Manta dorsal pale shoulder chevrons + dark wingtips
          float chevron = uwSS(0.36, 0.10, length(vec2((au - 0.24) * 1.8, (opZ - 0.16) * 2.2)));
          dorsalCol = mix(dorsalCol, vec3(0.56, 0.66, 0.72), chevron * 0.78);
        } else {
          // 12: Spotted Eagle Ray white dorsal ocellated ring/spot constellations (clear on duck-bill tip)
          vec2 uvGrid = vec2(u * 10.5, opZ * 9.5);
          vec2 cid = floor(uvGrid);
          vec2 cf = fract(uvGrid) - 0.5;
          float jx = fract(sin(dot(cid, vec2(127.1, 311.7))) * 43758.5453) - 0.5;
          float jy = fract(sin(dot(cid, vec2(269.5, 183.3))) * 43758.5453) - 0.5;
          float rSpot = length(cf - vec2(jx, jy) * 0.36);
          float ring = (uwSS(0.27, 0.18, rSpot) - 0.55 * uwSS(0.11, 0.04, rSpot))
                     * uwSS(0.92, 0.20, au)
                     * uwSS(0.52, 0.36, opZ);
          dorsalCol = mix(dorsalCol, vAccent, clamp(ring, 0.0, 1.0) * 0.92);
        }

        vec3 alb = partId > 1.5
          ? dorsalCol * 0.65
          : mix(belly, dorsalCol, uwSS(-0.10, 0.16, dorsalSign));

        // 5-pair anatomical ventral gill slits
        if (dorsalSign < 0.0 && partId < 0.5) {
          float gill = uwSS(0.25, 0.0, abs(au - 0.14) * 7.5)
                     * uwSS(0.02, 0.10, opZ)
                     * uwSS(0.34, 0.25, opZ)
                     * uwSS(0.25, 0.80, sin(opZ * 108.0));
          alb = mix(alb, vec3(0.16, 0.18, 0.24), gill * 0.84);
        }

        vec3 lit = shadeMarineLitAndFog(alb, N, V, vWorldPos, 28.0, 0.38);
        gl_FragColor = vec4(lit, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

const MAX_SPLASH_PARTICLES = 96;
const MAX_LEAP_SPLASH_EVENTS = 32;
export const ARENA_FISH_SPLASH_CACHE_KEY = 'arena-fish-splash-v1';

/**
 * Watertight 10-vertex / 16-triangle hydro-spindle droplet & foam-crown bead geometry
 * aligned along local `+Y` so airborne spray droplets stretch naturally along their velocity vector.
 */
function buildSplashDropletGeo(): T.BufferGeometry {
  const b = createSculptBuffers();
  const ringR = 0.24;
  const segs = 8;

  // Top leading tip (+Y) and bottom trailing tail (-Y)
  b.pos.push(0, 0.62, 0);
  b.aux.push(1, 0, 1, 0);
  b.pos.push(0, -0.52, 0);
  b.aux.push(0, 0, -1, 0);

  for (let s = 0; s < segs; s++) {
    const a = (s / segs) * Math.PI * 2;
    b.pos.push(Math.cos(a) * ringR, 0.06, Math.sin(a) * ringR);
    b.aux.push(0.55, Math.cos(a), Math.sin(a), 0);
  }

  for (let s = 0; s < segs; s++) {
    const r0 = 2 + s;
    const r1 = 2 + ((s + 1) % segs);
    b.idx.push(0, r1, r0);
    b.idx.push(1, r0, r1);
  }

  return finalizeSculptedGeometry(b);
}

function createSplashParticleShaderMaterial(): T.ShaderMaterial {
  const mat = new T.ShaderMaterial({
    name: 'ArenaFishLeapSplash',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: T.FrontSide,
    uniforms: {
      uSunDir: { value: new T.Vector3(-0.58, 0.75, 0.40).normalize() },
      uSunTint: { value: new T.Vector3(1, 1, 1) },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aSplashFade; // x: alpha (0..1), y: isFoamCrown (0=droplet, 1=crown)
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      varying vec2 vSplashFade;

      void main() {
        mat4 instM = mat4(1.0);
        #ifdef USE_INSTANCING
          instM = instanceMatrix;
        #endif
        vec4 world = modelMatrix * instM * vec4(position, 1.0);
        vWorldPos = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * mat3(instM) * normal);
        vSplashFade = aSplashFade;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uSunDir;
      uniform vec3 uSunTint;
      varying vec3 vNormalW;
      varying vec3 vWorldPos;
      varying vec2 vSplashFade;

      void main() {
        float alpha = clamp(vSplashFade.x, 0.0, 1.0);
        if (alpha <= 0.004) discard;
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 H = normalize(uSunDir + V);
        float ndl = max(dot(N, uSunDir), 0.0);
        float spec = pow(max(dot(N, H), 0.0), 42.0);
        float rim = pow(1.0 - max(dot(N, V), 0.0), 2.4);

        vec3 seaTint = mix(vec3(0.74, 0.91, 0.97), vec3(0.95, 0.98, 1.0), vSplashFade.y);
        vec3 lit = seaTint * (vec3(0.58, 0.68, 0.76) + uSunTint * (0.62 * ndl))
                 + uSunTint * spec * (1.05 - 0.45 * vSplashFade.y)
                 + vec3(0.82, 0.94, 1.0) * rim * 0.35;
        lit = min(max(lit, vec3(0.0)), vec3(10.0));

        gl_FragColor = vec4(lit, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  mat.customProgramCacheKey = () => ARENA_FISH_SPLASH_CACHE_KEY;
  return mat;
}

/**
 * Gently nudges `(x, z)` down the coastal bathymetry slope (`-grad(arenaBathymetry)`) whenever
 * seabed elevation exceeds `ARENA_WATER_Y - minDepthM` so schools and fish never clip beach sand or dry islands.
 */
function nudgeOutOfShallowWater(
  x: number,
  z: number,
  minDepthM: number,
  out: { x: number; z: number },
): void {
  let cx = x;
  let cz = z;
  const targetMaxBathY = ARENA_WATER_Y - minDepthM;
  for (let step = 0; step < 8; step++) {
    const bathY = arenaBathymetry(cx, cz);
    if (bathY <= targetMaxBathY && !arenaDryWalkable(cx, cz)) break;
    const eps = 2.2;
    const gx = arenaBathymetry(cx + eps, cz) - arenaBathymetry(cx - eps, cz);
    const gz = arenaBathymetry(cx, cz + eps) - arenaBathymetry(cx, cz - eps);
    const gLen = Math.hypot(gx, gz);
    if (gLen > 1e-4) {
      // Move opposite upward terrain gradient -> toward deeper ocean water!
      const push = Math.min(6.5, Math.max(2.0, (bathY - targetMaxBathY) * 2.4 + 1.8));
      cx -= (gx / gLen) * push;
      cz -= (gz / gLen) * push;
    } else {
      const r = Math.hypot(cx, cz) || 1;
      cx += (cx / r) * 4.0;
      cz += (cz / r) * 4.0;
    }
  }
  const rad = Math.hypot(cx, cz);
  if (rad > ARENA_BOAT_LIMIT - 8) {
    cx *= (ARENA_BOAT_LIMIT - 8) / rad;
    cz *= (ARENA_BOAT_LIMIT - 8) / rad;
  }
  out.x = cx;
  out.z = cz;
}

/**
 * Verifies that a ballistic leap from `(x0, z0)` along `(dx, dz)` spanning `spanM` metres
 * stays strictly over swimmable open/coastal water (`arenaWaterDepth >= 1.5 m`, `0` dry land/piers/bridges/rocks).
 */
function isLeapTrajectorySafe(
  x0: number,
  z0: number,
  dx: number,
  dz: number,
  spanM: number,
): boolean {
  if (arenaWaterDepth(x0, z0) < 1.8 || arenaDryWalkable(x0, z0)) return false;
  const rocks = arenaLayout.rocks;
  for (let k = 1; k <= 5; k++) {
    const s = k * 0.25; // 0.25, 0.50, 0.75, 1.00 (landing), and 1.25 (+25% post-landing overshoot!)
    const tx = x0 + dx * spanM * s;
    const tz = z0 + dz * spanM * s;
    if (Math.hypot(tx, tz) > ARENA_BOAT_LIMIT - 8) return false;
    if (arenaDryWalkable(tx, tz)) return false;
    const minReq = k <= 4 ? 1.55 : 1.35;
    if (arenaWaterDepth(tx, tz) < minReq) return false;
    for (let rIdx = 0; rIdx < rocks.length; rIdx++) {
      const rk = rocks[rIdx];
      const clearance = rk.r + 0.95;
      if (Math.abs(tx - rk.x) < clearance && Math.abs(tz - rk.z) < clearance) {
        if ((tx - rk.x) * (tx - rk.x) + (tz - rk.z) * (tz - rk.z) < clearance * clearance) {
          return false;
        }
      }
    }
  }
  return true;
}

// ============================================================================
// 3. 36 Ecological School Blueprints + Culling + Physical Fish-Bait-Fight AI
// ============================================================================

export interface MarineUpdateContext {
  dt: number;
  time: number;
  playerX: number;
  playerY: number;
  playerZ: number;
  /** Optional active camera for frustum + distance GPU upload culling (`> 180 m`) */
  camera?: T.Camera | null;
  /** Optional active boat hulls so fish scatter from hulls and flying fish leap beside fast boats */
  boats?: readonly { x: number; z: number; speed: number; yaw: number }[];
  /** Live 3D bait/hook/line coupling descriptor from `ArenaFishingController.getActiveBait()` (`F06`) */
  bait?: ActiveBaitDescriptor | null;
  /** Backwards-compatible legacy bobber position fallback */
  bobber?: { active: boolean; x: number; y?: number; z: number } | null;
  /** Alternate bobber alias matching `ArenaFishingController.getActiveBobber()` */
  activeBobber?: { active: boolean; x: number; y?: number; z: number } | null;
}

interface SchoolBlueprint {
  speciesId: string;
  homeX: number;
  homeZ: number;
  orbitRx: number;
  orbitRz: number;
  orbitSpeed: number;
  targetDepth: number; // positive metres below ARENA_WATER_Y
  maxCount: number;
  baseScale: number;
  shallowSurface: boolean;
}

/**
 * 36 ecologically distributed schools covering:
 * - All 10 designated `fishing_spot` cast zones within `6..14 m`,
 * - 12 shallow surface-shadow schools (`<= 1.6 m` below `ARENA_WATER_Y` for `arenaSea.ts`),
 * - All 4 deep Abyssal Garden biomes (`coral_lagoon`, `harbor_dropoff`, `karst_grotto`, `outer_reef`)
 *   replacing the former duplicate `AbyssalFishSchools` & `AbyssalMantaRays` batches.
 */
const SCHOOL_BLUEPRINTS: readonly SchoolBlueprint[] = [
  // --- A. 12 Shallow Surface-Shadow & Pier Schools (`<= 1.6 m` depth, bathymetry-verified clear water) ---
  { speciesId: 'surgeonfish', homeX: 28, homeZ: 98, orbitRx: 9, orbitRz: 7, orbitSpeed: 0.24, targetDepth: 0.65, maxCount: 28, baseScale: 0.34, shallowSurface: true }, // #0 fish-harbor-pier
  { speciesId: 'parrotfish', homeX: 12, homeZ: 108, orbitRx: 9, orbitRz: 8, orbitSpeed: 0.20, targetDepth: 0.88, maxCount: 22, baseScale: 0.48, shallowSurface: true }, // #1 fish-reef-lagoon
  { speciesId: 'clownfish', homeX: 18, homeZ: 222, orbitRx: 11, orbitRz: 10, orbitSpeed: 0.22, targetDepth: 0.72, maxCount: 26, baseScale: 0.24, shallowSurface: true }, // #2 Coral Lagoon inner atoll
  { speciesId: 'butterflyfish', homeX: 143, homeZ: -14, orbitRx: 9, orbitRz: 8, orbitSpeed: 0.21, targetDepth: 0.76, maxCount: 26, baseScale: 0.29, shallowSurface: true }, // #3 fish-beach-pier
  { speciesId: 'mackerel', homeX: -110, homeZ: 78, orbitRx: 11, orbitRz: 8, orbitSpeed: 0.32, targetDepth: 0.62, maxCount: 30, baseScale: 0.45, shallowSurface: true }, // #4 fish-village-jetty-1
  { speciesId: 'surgeonfish', homeX: -116, homeZ: 181, orbitRx: 9, orbitRz: 7, orbitSpeed: 0.23, targetDepth: 0.74, maxCount: 24, baseScale: 0.34, shallowSurface: true }, // #5 fish-village-shore
  { speciesId: 'mackerel', homeX: -86, homeZ: -75, orbitRx: 13, orbitRz: 9, orbitSpeed: 0.34, targetDepth: 0.58, maxCount: 30, baseScale: 0.46, shallowSurface: true }, // #6 dock-harbor-nw
  { speciesId: 'butterflyfish', homeX: 106, homeZ: -28, orbitRx: 9, orbitRz: 8, orbitSpeed: 0.22, targetDepth: 0.70, maxCount: 24, baseScale: 0.29, shallowSurface: true }, // #7 dock-harbor-east
  { speciesId: 'flying_fish', homeX: 84, homeZ: 54, orbitRx: 20, orbitRz: 15, orbitSpeed: 0.38, targetDepth: 0.42, maxCount: 22, baseScale: 0.34, shallowSurface: true }, // #8 East boat lane
  { speciesId: 'flying_fish', homeX: -82, homeZ: 64, orbitRx: 20, orbitRz: 15, orbitSpeed: 0.36, targetDepth: 0.44, maxCount: 22, baseScale: 0.34, shallowSurface: true }, // #9 West boat lane
  { speciesId: 'eagle_ray', homeX: 258, homeZ: 156, orbitRx: 14, orbitRz: 11, orbitSpeed: 0.18, targetDepth: 1.05, maxCount: 4, baseScale: 1.15, shallowSurface: true }, // #10 Tropical Beach sandbar
  { speciesId: 'sea_turtle', homeX: 92, homeZ: 48, orbitRx: 16, orbitRz: 12, orbitSpeed: 0.10, targetDepth: 1.38, maxCount: 4, baseScale: 0.92, shallowSurface: true }, // #11 Seagrass cove

  // --- B. 12 Coastal Pier, Cove & Mid-Reef Schools (`1.6 m .. 4.4 m` depth) ---
  { speciesId: 'grouper', homeX: -88, homeZ: 159, orbitRx: 8, orbitRz: 7, orbitSpeed: 0.13, targetDepth: 2.6, maxCount: 10, baseScale: 0.58, shallowSurface: false }, // #12 fish-village-jetty-2
  { speciesId: 'parrotfish', homeX: -108, homeZ: 84, orbitRx: 9, orbitRz: 8, orbitSpeed: 0.18, targetDepth: 2.1, maxCount: 16, baseScale: 0.49, shallowSurface: false }, // #13 village main pier reef
  { speciesId: 'moorish_idol', homeX: -116, homeZ: -151, orbitRx: 9, orbitRz: 8, orbitSpeed: 0.20, targetDepth: 2.2, maxCount: 18, baseScale: 0.34, shallowSurface: false }, // #14 fish-karst-pier
  { speciesId: 'angelfish', homeX: -133, homeZ: -121, orbitRx: 9, orbitRz: 8, orbitSpeed: 0.19, targetDepth: 2.5, maxCount: 18, baseScale: 0.35, shallowSurface: false }, // #15 Karst arch cove
  { speciesId: 'butterflyfish', homeX: 70, homeZ: -145, orbitRx: 9, orbitRz: 8, orbitSpeed: 0.21, targetDepth: 1.9, maxCount: 22, baseScale: 0.30, shallowSurface: false }, // #16 fish-mountain-pier
  { speciesId: 'parrotfish', homeX: 66, homeZ: -140, orbitRx: 10, orbitRz: 8, orbitSpeed: 0.17, targetDepth: 2.8, maxCount: 14, baseScale: 0.50, shallowSurface: false }, // #17 Green Mountain pier slope
  { speciesId: 'yellowfin_tuna', homeX: 185, homeZ: -128, orbitRx: 12, orbitRz: 10, orbitSpeed: 0.30, targetDepth: 3.4, maxCount: 16, baseScale: 0.78, shallowSurface: false }, // #18 fish-outer-pier
  { speciesId: 'moorish_idol', homeX: 188, homeZ: -136, orbitRx: 9, orbitRz: 8, orbitSpeed: 0.21, targetDepth: 2.1, maxCount: 14, baseScale: 0.34, shallowSurface: false }, // #19 Outer Archipelago pier
  { speciesId: 'grouper', homeX: -226, homeZ: -8, orbitRx: 9, orbitRz: 8, orbitSpeed: 0.12, targetDepth: 3.2, maxCount: 10, baseScale: 0.62, shallowSurface: false }, // #20 fish-lighthouse-pier
  { speciesId: 'mackerel', homeX: -228, homeZ: -14, orbitRx: 11, orbitRz: 9, orbitSpeed: 0.31, targetDepth: 1.8, maxCount: 22, baseScale: 0.47, shallowSurface: false }, // #21 Lighthouse channel
  { speciesId: 'angelfish', homeX: 24, homeZ: 212, orbitRx: 12, orbitRz: 11, orbitSpeed: 0.18, targetDepth: 2.3, maxCount: 20, baseScale: 0.35, shallowSurface: false }, // #22 Coral Lagoon reef
  { speciesId: 'clownfish', homeX: 145, homeZ: 4, orbitRx: 8, orbitRz: 7, orbitSpeed: 0.22, targetDepth: 1.7, maxCount: 22, baseScale: 0.25, shallowSurface: false }, // #23 Tropical Beach shallows

  // --- C. 12 Deep Abyssal Garden Biomes & Megafauna Patrols (`3.8 m .. 14.8 m` depth) ---
  { speciesId: 'surgeonfish', homeX: 18, homeZ: 332, orbitRx: 18, orbitRz: 16, orbitSpeed: 0.22, targetDepth: 11.2, maxCount: 30, baseScale: 0.35, shallowSurface: false }, // #24 Biome 0: Kelp Cathedral school
  { speciesId: 'angelfish', homeX: 14, homeZ: 326, orbitRx: 15, orbitRz: 14, orbitSpeed: 0.18, targetDepth: 8.6, maxCount: 22, baseScale: 0.36, shallowSurface: false }, // #25 Biome 0: Whale Fluke sanctuary
  { speciesId: 'manta_ray', homeX: 18, homeZ: 330, orbitRx: 24, orbitRz: 18, orbitSpeed: 0.11, targetDepth: 9.2, maxCount: 3, baseScale: 2.75, shallowSurface: false }, // #26 Biome 0: Cathedral Giant Mantas
  { speciesId: 'mackerel', homeX: 108, homeZ: -84, orbitRx: 16, orbitRz: 14, orbitSpeed: 0.29, targetDepth: 9.6, maxCount: 28, baseScale: 0.46, shallowSurface: false }, // #27 Biome 1: Shipwreck Canyon shoal
  { speciesId: 'grouper', homeX: 114, homeZ: -80, orbitRx: 10, orbitRz: 9, orbitSpeed: 0.11, targetDepth: 10.4, maxCount: 8, baseScale: 0.64, shallowSurface: false }, // #28 Biome 1: Sunken Shipwreck groupers
  { speciesId: 'manta_ray', homeX: 106, homeZ: -86, orbitRx: 20, orbitRz: 16, orbitSpeed: 0.12, targetDepth: 8.6, maxCount: 2, baseScale: 2.60, shallowSurface: false }, // #29 Biome 1: Drop-off Mantas
  { speciesId: 'moorish_idol', homeX: -125, homeZ: -62, orbitRx: 13, orbitRz: 11, orbitSpeed: 0.20, targetDepth: 8.2, maxCount: 24, baseScale: 0.35, shallowSurface: false }, // #30 Biome 2: Karst Bioluminescent Grotto
  { speciesId: 'manta_ray', homeX: -125, homeZ: -61, orbitRx: 16, orbitRz: 13, orbitSpeed: 0.11, targetDepth: 7.8, maxCount: 2, baseScale: 2.50, shallowSurface: false }, // #31 Biome 2: Grotto Mantas
  { speciesId: 'yellowfin_tuna', homeX: 156, homeZ: -108, orbitRx: 20, orbitRz: 16, orbitSpeed: 0.31, targetDepth: 10.5, maxCount: 26, baseScale: 0.80, shallowSurface: false }, // #32 Biome 3: Outer Reef Pelagic Archway
  { speciesId: 'eagle_ray', homeX: 152, homeZ: -104, orbitRx: 18, orbitRz: 14, orbitSpeed: 0.16, targetDepth: 8.2, maxCount: 4, baseScale: 1.22, shallowSurface: false }, // #33 Biome 3: Outer Reef Eagle Rays
  { speciesId: 'reef_shark', homeX: 236, homeZ: -108, orbitRx: 18, orbitRz: 15, orbitSpeed: 0.17, targetDepth: 5.4, maxCount: 3, baseScale: 1.36, shallowSurface: false }, // #34 Outer Archipelago drop-off sharks
  { speciesId: 'reef_shark', homeX: -240, homeZ: 9, orbitRx: 18, orbitRz: 15, orbitSpeed: 0.16, targetDepth: 5.2, maxCount: 3, baseScale: 1.40, shallowSurface: false }, // #35 Lighthouse drop-off sharks
];

const TIER_FISH_FRACTION: Record<ArenaQualityTier, number> = {
  ultra: 1.0,
  high: 0.78,
  balanced: 0.54,
  low: 0.30,
};

const HASH_BUCKETS = 512;
const CELL_SIZE = 5.5;
const MAX_ACTIVE_DISTANCE_M = 180.0;
const MAX_ACTIVE_DISTANCE_SQ = MAX_ACTIVE_DISTANCE_M * MAX_ACTIVE_DISTANCE_M;
const BAIT_SENSORY_RADIUS_M = 32.0;

interface AttrUpdateRange {
  start: number;
  count: number;
}

export class ArenaMarineEcosystem {
  private tier: ArenaQualityTier;
  private readonly group = new T.Group();
  private readonly opticsFallback: InternalOpticsFallback;
  private boundOptics: MarineUnderwaterOpticsUniforms | null = null;

  private readonly fishMat: T.ShaderMaterial;
  private readonly mantaMat: T.ShaderMaterial;
  private readonly meshes: T.InstancedMesh[] = [];
  private readonly metaAttrs: T.InstancedBufferAttribute[] = [];
  private readonly accentAttrs: T.InstancedBufferAttribute[] = [];
  private readonly matRanges: AttrUpdateRange[] = [];
  private readonly colRanges: AttrUpdateRange[] = [];
  private readonly metaRanges: AttrUpdateRange[] = [];
  private readonly accRanges: AttrUpdateRange[] = [];

  private readonly groupCapacities = new Int32Array(BODY_GROUP_COUNT);
  private readonly groupWriteCounts = new Int32Array(BODY_GROUP_COUNT);
  private warmedAllGroupsOnce = false;

  // Flat SoA school arrays (36 schools)
  private readonly schoolCount = SCHOOL_BLUEPRINTS.length;
  private readonly scX = new Float32Array(this.schoolCount);
  private readonly scY = new Float32Array(this.schoolCount);
  private readonly scZ = new Float32Array(this.schoolCount);
  private readonly scHeading = new Float32Array(this.schoolCount);
  private readonly scRadius = new Float32Array(this.schoolCount);
  private readonly scPhase = new Float32Array(this.schoolCount);
  private readonly scActiveCount = new Int16Array(this.schoolCount);
  private readonly scVisible = new Uint8Array(this.schoolCount);
  private readonly scStartAgent = new Int32Array(this.schoolCount);

  // Flat SoA individual agent arrays
  private readonly totalAgents: number;
  private readonly agX: Float32Array;
  private readonly agY: Float32Array;
  private readonly agZ: Float32Array;
  private readonly agVx: Float32Array;
  private readonly agVy: Float32Array;
  private readonly agVz: Float32Array;
  private readonly agPhase: Float32Array;
  private readonly agScale: Float32Array;
  private readonly agSwimFreq: Float32Array;
  private readonly agPattern: Float32Array;
  private readonly agSchool: Int16Array;
  private readonly agGroup: Uint8Array;
  private readonly agRankInSchool: Int16Array;
  private readonly agPrimaryRGB: Float32Array;
  private readonly agAccentRGB: Float32Array;

  // Physical Fish-to-Bait-to-Fight AI SoA arrays (`F06`)
  private readonly agBehavior: Uint8Array;
  private readonly agStateTimer: Float32Array;
  private readonly agCooldown: Float32Array;
  private readonly agNibblesDone: Uint8Array;
  private readonly agTargetNibbles: Uint8Array;

  private claimedAgentIdx = -1;
  private baitSettledAge = 0;
  private fightAngle = 0;
  private fightDepthOffset = -0.38;
  private fightLeapPhase = 0;
  private fightLocalSurge = false;
  private fightSurgeTimer = 1.2;
  private activeCuriousCount = 0;
  private pendingHookPose = false;
  private pendingMouthX = 0;
  private pendingMouthY = 0;
  private pendingMouthZ = 0;
  private pendingPulling = false;

  // Autonomous 3-phase ballistic surface-leap & banking SoA arrays (zero GC)
  private readonly agBankAngle: Float32Array;
  private readonly agLeapState: Uint8Array;
  private readonly agLeapTimer: Float32Array;
  private readonly agLeapDx: Float32Array;
  private readonly agLeapDz: Float32Array;
  private readonly agLeapVy0: Float32Array;
  private readonly agLeapVh0: Float32Array;
  private readonly agLeapGravity: Float32Array;
  private readonly agLeapRestCooldown: Float32Array;
  private activeLeapingCount = 0;
  private nextAutonomousLeapTimer = 1.65;
  private leapRngState = 0x51a7f00d;

  // Pooled zero-GC 3D splash crown & spray droplet InstancedMesh (`arena-fish-splash-v1`)
  private readonly splashMat: T.ShaderMaterial;
  private readonly splashMesh: T.InstancedMesh;
  private readonly splashFadeAttr: T.InstancedBufferAttribute;
  private readonly splashMatRange: AttrUpdateRange = { start: 0, count: 0 };
  private readonly splashFadeRange: AttrUpdateRange = { start: 0, count: 0 };
  private readonly spActive = new Uint8Array(MAX_SPLASH_PARTICLES);
  private readonly spKind = new Uint8Array(MAX_SPLASH_PARTICLES); // 0 = spray droplet, 1 = surface foam crown
  private readonly spAge = new Float32Array(MAX_SPLASH_PARTICLES);
  private readonly spLife = new Float32Array(MAX_SPLASH_PARTICLES);
  private readonly spX = new Float32Array(MAX_SPLASH_PARTICLES);
  private readonly spY = new Float32Array(MAX_SPLASH_PARTICLES);
  private readonly spZ = new Float32Array(MAX_SPLASH_PARTICLES);
  private readonly spVx = new Float32Array(MAX_SPLASH_PARTICLES);
  private readonly spVy = new Float32Array(MAX_SPLASH_PARTICLES);
  private readonly spVz = new Float32Array(MAX_SPLASH_PARTICLES);
  private readonly spScale = new Float32Array(MAX_SPLASH_PARTICLES);
  private splashCursor = 0;

  // Pre-allocated zero-GC ring pool for `consumeLeapSplashes()`
  private readonly splashEventPool: FishLeapSplashEvent[] = Array.from(
    { length: MAX_LEAP_SPLASH_EVENTS },
    () => ({ kind: 'exit', x: 0, y: ARENA_WATER_Y, z: 0, strength: 0.5, radius: 1.0 }),
  );
  private readonly drainedSplashEvents: FishLeapSplashEvent[] = [];
  private pendingSplashEventCount = 0;

  // Zero-GC spatial hash tables
  private readonly gridHead = new Int16Array(HASH_BUCKETS);
  private readonly gridNext: Int16Array;

  // Preallocated SurfaceFishSchool pool for 100% synchronized water-surface shadows
  private readonly surfacePool: SurfaceFishSchool[] = Array.from({ length: SCHOOL_BLUEPRINTS.length }, () => ({
    x: 0,
    y: ARENA_WATER_Y - 0.6,
    z: 0,
    radius: 3.5,
    heading: 0,
    count: 0,
    density: 0,
  }));
  private readonly activeSurfaceSchools: SurfaceFishSchool[] = [];

  // Reusable zero-GC math scratch objects
  private readonly tmpMat = new T.Matrix4();
  private readonly tmpPos = new T.Vector3();
  private readonly tmpQuat = new T.Quaternion();
  private readonly tmpScale = new T.Vector3();
  private readonly tmpLookMat = new T.Matrix4();
  private readonly tmpTarget = new T.Vector3();
  private readonly tmpUp = new T.Vector3(0, 1, 0);
  private readonly tmpFwd = new T.Vector3(0, 0, 1);
  private readonly tmpColor = new T.Color();
  private readonly tmpNudge = { x: 0, z: 0 };
  private readonly frustum = new T.Frustum();
  private readonly projScreenMat = new T.Matrix4();
  private readonly cullSphere = new T.Sphere();

  constructor(
    private readonly scene: T.Scene,
    initialTier: ArenaQualityTier = 'high',
    sharedOptics?: MarineUnderwaterOpticsUniforms | null,
  ) {
    this.tier = initialTier;
    this.group.name = 'ArenaMarineEcosystem';
    this.opticsFallback = createInternalOpticsFallback();

    let total = 0;
    for (let s = 0; s < this.schoolCount; s++) {
      const bp = SCHOOL_BLUEPRINTS[s];
      const g = SPECIES_BODY_GROUP[bp.speciesId];
      this.scStartAgent[s] = total;
      this.groupCapacities[g] += bp.maxCount;
      total += bp.maxCount;
    }
    this.totalAgents = total;

    this.agX = new Float32Array(total);
    this.agY = new Float32Array(total);
    this.agZ = new Float32Array(total);
    this.agVx = new Float32Array(total);
    this.agVy = new Float32Array(total);
    this.agVz = new Float32Array(total);
    this.agPhase = new Float32Array(total);
    this.agScale = new Float32Array(total);
    this.agSwimFreq = new Float32Array(total);
    this.agPattern = new Float32Array(total);
    this.agSchool = new Int16Array(total);
    this.agGroup = new Uint8Array(total);
    this.agRankInSchool = new Int16Array(total);
    this.agPrimaryRGB = new Float32Array(total * 3);
    this.agAccentRGB = new Float32Array(total * 3);

    this.agBehavior = new Uint8Array(total);
    this.agStateTimer = new Float32Array(total);
    this.agCooldown = new Float32Array(total);
    this.agNibblesDone = new Uint8Array(total);
    this.agTargetNibbles = new Uint8Array(total);

    this.agBankAngle = new Float32Array(total);
    this.agLeapState = new Uint8Array(total);
    this.agLeapTimer = new Float32Array(total);
    this.agLeapDx = new Float32Array(total);
    this.agLeapDz = new Float32Array(total);
    this.agLeapVy0 = new Float32Array(total);
    this.agLeapVh0 = new Float32Array(total);
    this.agLeapGravity = new Float32Array(total);
    this.agLeapRestCooldown = new Float32Array(total);
    this.gridNext = new Int16Array(total);

    const low = initialTier === 'low';
    const geometries = buildAllBodyPlanGeometries(low);

    this.fishMat = createFishGroupShaderMaterial(this.opticsFallback);
    this.mantaMat = createMantaRayShaderMaterial(this.opticsFallback);

    for (let g = 0; g < BODY_GROUP_COUNT; g++) {
      const cap = Math.max(1, this.groupCapacities[g]);
      const mat = g === 7 || g === 8 ? this.mantaMat : this.fishMat;
      const inst = new T.InstancedMesh(geometries[g], mat, cap);
      inst.name = `ArenaMarineBodyGroup_${g}`;
      inst.instanceMatrix.setUsage(T.DynamicDrawUsage);
      inst.setColorAt(0, this.tmpColor.setRGB(1, 1, 1));
      inst.instanceColor!.setUsage(T.DynamicDrawUsage);

      const metaAttr = new T.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(T.DynamicDrawUsage);
      const accentAttr = new T.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(T.DynamicDrawUsage);
      geometries[g].setAttribute('aInstMeta', metaAttr);
      geometries[g].setAttribute('aInstAccent', accentAttr);

      inst.frustumCulled = false;
      inst.castShadow = false;
      inst.receiveShadow = false;
      inst.renderOrder = 1;

      this.meshes.push(inst);
      this.metaAttrs.push(metaAttr);
      this.accentAttrs.push(accentAttr);
      this.matRanges.push({ start: 0, count: 0 });
      this.colRanges.push({ start: 0, count: 0 });
      this.metaRanges.push({ start: 0, count: 0 });
      this.accRanges.push({ start: 0, count: 0 });
      this.group.add(inst);
    }

    // Pooled 3D splash crown & spray droplet InstancedMesh (`count = 0` when idle, auto-seeded by `arenaStreaming.ts`)
    const splashGeo = buildSplashDropletGeo();
    this.splashFadeAttr = new T.InstancedBufferAttribute(
      new Float32Array(MAX_SPLASH_PARTICLES * 2),
      2,
    ).setUsage(T.DynamicDrawUsage);
    this.splashFadeAttr.setXY(0, 0, 0);
    splashGeo.setAttribute('aSplashFade', this.splashFadeAttr);
    this.splashMat = createSplashParticleShaderMaterial();
    this.splashMesh = new T.InstancedMesh(splashGeo, this.splashMat, MAX_SPLASH_PARTICLES);
    this.splashMesh.name = 'ArenaMarineSplashPool';
    this.splashMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.splashMesh.frustumCulled = false;
    this.splashMesh.castShadow = false;
    this.splashMesh.receiveShadow = false;
    this.splashMesh.renderOrder = 3;
    this.splashMesh.count = 0;
    this.splashMesh.userData.__ecWarmupInstanceCount = 1;
    this.group.add(this.splashMesh);

    this.seedAgents();
    this.setQuality(initialTier);
    if (sharedOptics) {
      this.bindUnderwaterOptics(sharedOptics);
    }
    scene.add(this.group);
  }

  private nextLeapRand(): number {
    let s = (this.leapRngState + 0x6d2b79f5) | 0;
    this.leapRngState = s;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Bind `world.underwater`'s shared `SharedUnderwaterUniforms` (`tWater` caustics, `tZoneMap` grotto map,
   * `tShadow` PCF sunbeams, `uSunDir`, `uSunTint`, `uGrottoBoost`) so every 3D marine species shares exact
   * `UNDERWATER_OPTICS_GLSL` lighting and fog with zero duplicate render targets.
   */
  bindUnderwaterOptics(sharedUniforms: MarineUnderwaterOpticsUniforms | null | undefined): void {
    this.boundOptics = sharedUniforms ?? null;
    this.syncOpticsUniforms();
  }

  private syncOpticsUniforms(): void {
    const src =
      this.boundOptics ??
      ((this.scene.userData as Record<string, unknown> | undefined)?.__ecArenaUnderwaterOptics as
        | MarineUnderwaterOpticsUniforms
        | undefined) ??
      null;
    if (!src) return;

    for (const mat of [this.fishMat, this.mantaMat]) {
      const u = mat.uniforms;
      (u.uSunDir.value as T.Vector3).copy(src.uSunDir.value);
      (u.uSunTint.value as T.Vector3).copy(src.uSunTint.value);
      u.uGrottoBoost.value = src.uGrottoBoost.value;
      u.tWater.value = src.tWater.value;
      u.tZoneMap.value = src.tZoneMap.value;
      u.tShadow.value = src.tShadow.value;
      (u.uShadowMatrix.value as T.Matrix4).copy(src.uShadowMatrix.value);
      if (src.uShadowTexel) {
        u.uShadowTexel.value = src.uShadowTexel.value;
      }
      u.uShadowEnabled.value = src.uShadowEnabled.value;
    }

    (this.splashMat.uniforms.uSunDir.value as T.Vector3).copy(src.uSunDir.value);
    (this.splashMat.uniforms.uSunTint.value as T.Vector3).copy(src.uSunTint.value);
  }

  /**
   * Computes exact world-space fish origin `this.tmpPos` so local mouth `(0, GROUP_MOUTH_LOCAL_Y[g], GROUP_MOUTH_LOCAL_Z[g])`
   * lands on `(mouthX, mouthY, mouthZ)` at `< 0.001 mm` error under `Matrix4.lookAt(pos + fwd, pos, upVec)` (zero GC).
   */
  private computeCenterFromMouth(
    g: number,
    sc: number,
    mouthX: number,
    mouthY: number,
    mouthZ: number,
    fx: number,
    fy: number,
    fz: number,
    upX: number,
    upY: number,
    upZ: number,
  ): void {
    // right = normalize(cross(up, fwd))
    let rx = upY * fz - upZ * fy;
    let ry = upZ * fx - upX * fz;
    let rz = upX * fy - upY * fx;
    const rLen = Math.hypot(rx, ry, rz);
    if (rLen > 1e-6) {
      rx /= rLen;
      ry /= rLen;
      rz /= rLen;
    } else {
      rx = 1;
      ry = 0;
      rz = 0;
    }
    // trueUp = cross(fwd, right)
    const tux = fy * rz - fz * ry;
    const tuy = fz * rx - fx * rz;
    const tuz = fx * ry - fy * rx;
    const mZ = sc * GROUP_MOUTH_LOCAL_Z[g];
    const mY = sc * GROUP_MOUTH_LOCAL_Y[g];
    this.tmpPos.set(
      mouthX - (fx * mZ + tux * mY),
      mouthY - (fy * mZ + tuy * mY),
      mouthZ - (fz * mZ + tuz * mY),
    );
  }

  private seedAgents(): void {
    const rnd = createSeededRandom(14);
    const c1 = new T.Color();
    const c2 = new T.Color();
    let cursor = 0;

    for (let s = 0; s < this.schoolCount; s++) {
      const bp = SCHOOL_BLUEPRINTS[s];
      const spec = MARINE_SPECIES_BY_ID[bp.speciesId];
      const groupIdx = SPECIES_BODY_GROUP[bp.speciesId];
      const patId = SPECIES_PATTERN_ID[bp.speciesId];
      c1.set(spec.colorPrimary);
      c2.set(spec.colorAccent);

      this.scPhase[s] = rnd() * Math.PI * 2;
      const rawScX = bp.homeX + Math.cos(this.scPhase[s]) * bp.orbitRx;
      const rawScZ = bp.homeZ + Math.sin(this.scPhase[s]) * bp.orbitRz;
      const minSchoolDepth = bp.shallowSurface ? 1.65 : Math.min(3.2, bp.targetDepth + 0.65);
      nudgeOutOfShallowWater(rawScX, rawScZ, minSchoolDepth, this.tmpNudge);
      this.scX[s] = this.tmpNudge.x;
      this.scZ[s] = this.tmpNudge.z;
      const scBathY = arenaBathymetry(this.scX[s], this.scZ[s]);
      this.scY[s] = clamp(ARENA_WATER_Y - bp.targetDepth, scBathY + 0.65, ARENA_WATER_Y - 0.35);
      this.scRadius[s] = bp.maxCount <= 5 ? 3.4 : 2.6 + Math.sqrt(bp.maxCount) * 0.55;
      this.scHeading[s] = this.scPhase[s] + Math.PI * 0.5;

      for (let k = 0; k < bp.maxCount; k++) {
        const idx = cursor++;
        const ang = rnd() * Math.PI * 2;
        const rad = Math.sqrt(rnd()) * this.scRadius[s];
        const rawX = this.scX[s] + Math.cos(ang) * rad;
        const rawZ = this.scZ[s] + Math.sin(ang) * rad;
        nudgeOutOfShallowWater(rawX, rawZ, groupIdx === 7 || groupIdx === 8 ? 1.8 : 1.15, this.tmpNudge);
        this.agX[idx] = this.tmpNudge.x;
        this.agZ[idx] = this.tmpNudge.z;
        const bathY = arenaBathymetry(this.agX[idx], this.agZ[idx]);
        const clearance = groupIdx === 7 || groupIdx === 8 ? 0.80 : 0.38;
        this.agY[idx] = clamp(
          this.scY[s] + (rnd() - 0.5) * (bp.shallowSurface ? 0.34 : 0.92),
          bathY + clearance,
          ARENA_WATER_Y - (bp.shallowSurface ? 0.28 : 0.48),
        );
        this.agVx[idx] = Math.sin(this.scHeading[s]) * 1.45;
        this.agVy[idx] = 0;
        this.agVz[idx] = Math.cos(this.scHeading[s]) * 1.45;
        this.agPhase[idx] = rnd() * Math.PI * 2;
        this.agScale[idx] = bp.baseScale * (0.82 + rnd() * 0.36);
        // Stagger initial rest cooldowns organically so fish never leap simultaneously at cold start
        this.agLeapRestCooldown[idx] = rnd() * 7.5;
        this.agSwimFreq[idx] =
          groupIdx === 7 || groupIdx === 8
            ? 1.35 + rnd() * 0.25
            : groupIdx === 9
              ? 2.05 + rnd() * 0.28
              : groupIdx === 10
                ? 3.7 + rnd() * 0.45
                : groupIdx === 5
                  ? 8.8 + rnd() * 2.2
                  : 7.2 + rnd() * 2.2;
        this.agPattern[idx] = patId;
        this.agSchool[idx] = s;
        this.agGroup[idx] = groupIdx;
        this.agRankInSchool[idx] = k;

        const shade = 0.9 + rnd() * 0.2;
        this.agPrimaryRGB[idx * 3] = clamp(c1.r * shade, 0, 1);
        this.agPrimaryRGB[idx * 3 + 1] = clamp(c1.g * shade, 0, 1);
        this.agPrimaryRGB[idx * 3 + 2] = clamp(c1.b * shade, 0, 1);
        this.agAccentRGB[idx * 3] = c2.r;
        this.agAccentRGB[idx * 3 + 1] = c2.g;
        this.agAccentRGB[idx * 3 + 2] = c2.b;
      }
    }
  }

  /** Dynamically adjust active fish/school counts across quality tiers without reallocating GPU or CPU buffers. */
  setQuality(tier: ArenaQualityTier): void {
    this.tier = tier;
    const frac = TIER_FISH_FRACTION[tier];
    for (let s = 0; s < this.schoolCount; s++) {
      const bp = SCHOOL_BLUEPRINTS[s];
      const minKeep = bp.maxCount <= 5 ? Math.max(1, Math.ceil(bp.maxCount * Math.max(0.5, frac))) : 4;
      let count = Math.min(bp.maxCount, Math.max(minKeep, Math.round(bp.maxCount * frac)));
      if (this.claimedAgentIdx >= 0 && this.agSchool[this.claimedAgentIdx] === s) {
        count = Math.max(count, this.agRankInSchool[this.claimedAgentIdx] + 1);
      }
      this.scActiveCount[s] = count;
    }
  }

  get qualityTier(): ArenaQualityTier {
    return this.tier;
  }

  /**
   * Live shallow fish schools (`<= 1.6 m` below `ARENA_WATER_Y`) updated in place every frame
   * so `arenaSea.ts` renders 100% synchronized dark fish silhouettes on the ocean surface and Snell's window.
   */
  getSurfaceSchools(): readonly SurfaceFishSchool[] {
    return this.activeSurfaceSchools;
  }

  /** Alias of `getSurfaceSchools()` for surface-shadow consumers. */
  getSurfaceShadowSchools(): readonly SurfaceFishSchool[] {
    return this.activeSurfaceSchools;
  }

  /**
   * Drains queued `exit` and `reentry` surface-leap splash events (zero allocations) so `ArenaScene.tsx`
   * forwards them into `world.sea.triggerSurfaceSplash(ev.x, ev.z, ev.strength, ev.radius)`.
   */
  consumeLeapSplashes(): readonly FishLeapSplashEvent[] {
    const count = this.pendingSplashEventCount;
    this.drainedSplashEvents.length = count;
    for (let i = 0; i < count; i++) {
      this.drainedSplashEvents[i] = this.splashEventPool[i];
    }
    this.pendingSplashEventCount = 0;
    return this.drainedSplashEvents;
  }

  /** Number of fish currently in `LAUNCH_ASCENT` or `AIRBORNE` surface-leap phases (for QA telemetry). */
  getActiveLeapingFishCount(): number {
    return this.activeLeapingCount;
  }

  /**
   * Deterministic QA / demo trigger: launches the nearest eligible `FREE_BOIDS` fish near `(x, z)`
   * along a pre-validated deep-water arc (`waterDepth >= 1.8 m` launch, `>= 1.55 m` landing).
   */
  triggerDemoLeapNear(x: number, z: number): boolean {
    let bestIdx = -1;
    let bestDistSq = Infinity;

    for (let i = 0; i < this.totalAgents; i++) {
      if (this.agBehavior[i] !== FISH_AI_STATE.FREE_BOIDS) continue;
      if (this.agLeapState[i] !== FISH_LEAP_PHASE.NONE) continue;
      if (i === this.claimedAgentIdx) continue;
      const s = this.agSchool[i];
      if (this.agRankInSchool[i] >= this.scActiveCount[s]) continue;
      const bp = SCHOOL_BLUEPRINTS[s];
      if (!LEAP_ELIGIBLE_SPECIES.has(bp.speciesId)) continue;
      const px = this.agX[i];
      const pz = this.agZ[i];
      if (arenaWaterDepth(px, pz) < 1.8 || arenaDryWalkable(px, pz)) continue;
      const dSq = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) return false;
    return this.tryLaunchFishLeap(bestIdx, 0, true);
  }

  /**
   * Optional explicit boot warmup compiling `'arena-fish-splash-v1'` and body-plan shaders
   * (`arenaStreaming.ts` also auto-seeds `splashMesh` via `count === 0` VAO warmup -> `programDelta === 0`).
   */
  warmup(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera): void {
    const prevCount = this.splashMesh.count;
    const prevMat = new T.Matrix4();
    this.splashMesh.getMatrixAt(0, prevMat);
    this.tmpPos.set(0, -999, 0);
    this.tmpQuat.identity();
    this.tmpScale.setScalar(0.0001);
    this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
    this.splashMesh.setMatrixAt(0, this.tmpMat);
    this.splashMesh.instanceMatrix.needsUpdate = true;
    this.splashFadeAttr.setXY(0, 0.01, 1.0);
    this.splashFadeAttr.needsUpdate = true;
    this.splashMesh.count = 1;
    try {
      renderer.compile(scene, camera);
    } finally {
      this.splashMesh.setMatrixAt(0, prevMat);
      this.splashMesh.instanceMatrix.needsUpdate = true;
      this.splashFadeAttr.setXY(0, 0, 0);
      this.splashFadeAttr.needsUpdate = true;
      this.splashMesh.count = prevCount;
    }
  }

  private emitLeapSplash(
    kind: 'exit' | 'reentry',
    x: number,
    y: number,
    z: number,
    strength: number,
    radius: number,
    dirX: number,
    dirZ: number,
  ): void {
    if (this.pendingSplashEventCount < MAX_LEAP_SPLASH_EVENTS) {
      const ev = this.splashEventPool[this.pendingSplashEventCount++];
      ev.kind = kind;
      ev.x = x;
      ev.y = y;
      ev.z = z;
      ev.strength = strength;
      ev.radius = radius;
    }

    // Spawn pooled 3D surface foam-crown ring + sunlit airborne water droplets (zero GC)
    const crownCount = this.tier === 'low' ? 3 : 5;
    const dropCount = this.tier === 'low' ? 4 : kind === 'reentry' ? 9 : 7;
    const baseStr = clamp(strength, 0.3, 1.25);

    for (let c = 0; c < crownCount; c++) {
      const slot = this.splashCursor;
      this.splashCursor = (this.splashCursor + 1) % MAX_SPLASH_PARTICLES;
      const ang = (c / crownCount) * Math.PI * 2 + this.nextLeapRand() * 0.45;
      const radSpd = (0.75 + this.nextLeapRand() * 0.65) * baseStr;
      this.spActive[slot] = 1;
      this.spKind[slot] = 1; // foam crown
      this.spAge[slot] = 0;
      this.spLife[slot] = 0.36 + this.nextLeapRand() * 0.22;
      this.spX[slot] = x + Math.cos(ang) * 0.08;
      this.spY[slot] = y + 0.03;
      this.spZ[slot] = z + Math.sin(ang) * 0.08;
      this.spVx[slot] = Math.cos(ang) * radSpd;
      this.spVy[slot] = 0.55 + this.nextLeapRand() * 0.45;
      this.spVz[slot] = Math.sin(ang) * radSpd;
      this.spScale[slot] = (0.055 + this.nextLeapRand() * 0.035) * (0.85 + 0.35 * baseStr);
    }

    for (let d = 0; d < dropCount; d++) {
      const slot = this.splashCursor;
      this.splashCursor = (this.splashCursor + 1) % MAX_SPLASH_PARTICLES;
      const coneAng = this.nextLeapRand() * Math.PI * 2;
      const coneSpread = 0.45 + this.nextLeapRand() * 1.15;
      const fwdBias = kind === 'exit' ? 0.85 : 0.45;
      this.spActive[slot] = 1;
      this.spKind[slot] = 0; // spray droplet
      this.spAge[slot] = 0;
      this.spLife[slot] = 0.48 + this.nextLeapRand() * 0.34;
      this.spX[slot] = x + (this.nextLeapRand() - 0.5) * 0.12;
      this.spY[slot] = y + 0.05;
      this.spZ[slot] = z + (this.nextLeapRand() - 0.5) * 0.12;
      this.spVx[slot] = Math.cos(coneAng) * coneSpread * baseStr + dirX * fwdBias;
      this.spVy[slot] = (2.15 + this.nextLeapRand() * 1.95) * (0.78 + 0.38 * baseStr);
      this.spVz[slot] = Math.sin(coneAng) * coneSpread * baseStr + dirZ * fwdBias;
      this.spScale[slot] = 0.028 + this.nextLeapRand() * 0.024;
    }
  }

  private tryLaunchFishLeap(idx: number, delaySec: number, allowDeepOverride = false, preferredYaw?: number): boolean {
    if (this.agBehavior[idx] !== FISH_AI_STATE.FREE_BOIDS) return false;
    if (this.agLeapState[idx] !== FISH_LEAP_PHASE.NONE) return false;
    if (!allowDeepOverride && this.agLeapRestCooldown[idx] > 0) return false;

    const px = this.agX[idx];
    const py = this.agY[idx];
    const pz = this.agZ[idx];
    if (!allowDeepOverride && py < ARENA_WATER_Y - 3.6) return false;
    if (arenaWaterDepth(px, pz) < 1.8 || arenaDryWalkable(px, pz)) return false;

    const s = this.agSchool[idx];
    const bp = SCHOOL_BLUEPRINTS[s];
    const spId = bp.speciesId;
    const isFlying = spId === 'flying_fish';
    const isPelagic = spId === 'mackerel' || spId === 'mahimahi' || spId === 'yellowfin_tuna';

    const gEff = isFlying ? 5.8 : 9.81;
    const r1 = this.nextLeapRand();
    const r2 = this.nextLeapRand();
    const apexH = isFlying
      ? 0.68 + 0.62 * r1
      : spId === 'yellowfin_tuna'
        ? 0.78 + 0.62 * r1
        : isPelagic
          ? 0.60 + 0.52 * r1
          : 0.56 + 0.38 * r1;
    const spanM = isFlying
      ? 3.8 + 2.1 * r2
      : isPelagic
        ? 2.8 + 1.8 * r2
        : 2.4 + 1.2 * r2;

    const curHeading =
      preferredYaw !== undefined
        ? preferredYaw
        : Math.hypot(this.agVx[idx], this.agVz[idx]) > 0.1
          ? Math.atan2(this.agVx[idx], this.agVz[idx])
          : this.scHeading[s];

    // Test forward heading first, then alternate offshore bearings so a coastal fish NEVER leaps toward land or a pier!
    const offsets = [0, 0.72, -0.72, 1.48, -1.48, Math.PI];
    let validDx = 0;
    let validDz = 0;
    let foundSafe = false;
    for (let k = 0; k < offsets.length; k++) {
      const yaw = curHeading + offsets[k];
      const dx = Math.sin(yaw);
      const dz = Math.cos(yaw);
      if (isLeapTrajectorySafe(px, pz, dx, dz, spanM)) {
        validDx = dx;
        validDz = dz;
        foundSafe = true;
        break;
      }
    }
    if (!foundSafe) return false;

    const vy0 = Math.sqrt(2.0 * gEff * apexH);
    const tAir = (2.0 * vy0) / gEff;
    const vh0 = spanM / Math.max(0.25, tAir);

    this.agLeapState[idx] = FISH_LEAP_PHASE.LAUNCH_ASCENT;
    this.agLeapTimer[idx] = -Math.max(0, delaySec);
    this.agLeapDx[idx] = validDx;
    this.agLeapDz[idx] = validDz;
    this.agLeapVy0[idx] = vy0;
    this.agLeapVh0[idx] = vh0;
    this.agLeapGravity[idx] = gEff;
    if (delaySec <= 0) {
      this.activeLeapingCount++;
    }
    return true;
  }

  private stepAutonomousLeapDirector(
    dt: number,
    focusX: number,
    focusZ: number,
    hasBaitPoint: boolean,
    baitX: number,
    baitZ: number,
    boats?: readonly { x: number; z: number; speed: number; yaw: number }[],
  ): void {
    // 1. Playful bow-wake leaps alongside fast moving boats (flying fish & mackerel)
    if (boats && this.activeLeapingCount < 5) {
      for (let b = 0; b < boats.length; b++) {
        const bt = boats[b];
        if (bt.speed <= 1.5 || this.nextLeapRand() > 0.55 * dt) continue;
        for (let s = 0; s < this.schoolCount; s++) {
          const spId = SCHOOL_BLUEPRINTS[s].speciesId;
          if (spId !== 'flying_fish' && spId !== 'mackerel') continue;
          if ((this.scX[s] - bt.x) ** 2 + (this.scZ[s] - bt.z) ** 2 > 36 * 36) continue;
          const start = this.scStartAgent[s];
          const count = this.scActiveCount[s];
          if (count <= 0) continue;
          const pick = start + Math.floor(this.nextLeapRand() * count);
          const yaw = bt.yaw + (pick % 2 === 0 ? 0.24 : -0.24);
          if (this.tryLaunchFishLeap(pick, 0, false, yaw)) break;
        }
      }
    }

    // 2. Natural staggered coastal/pelagic leap cadence every 3.5..8.8 s within 160 m of focus
    this.nextAutonomousLeapTimer -= dt;
    if (this.nextAutonomousLeapTimer > 0) return;
    this.nextAutonomousLeapTimer = 3.5 + this.nextLeapRand() * 5.2;
    if (this.activeLeapingCount >= 4) return;

    let chosenSchool = -1;
    let bestWeight = 0;
    for (let s = 0; s < this.schoolCount; s++) {
      const bp = SCHOOL_BLUEPRINTS[s];
      if (!LEAP_ELIGIBLE_SPECIES.has(bp.speciesId)) continue;
      if (this.scActiveCount[s] <= 0) continue;
      if (bp.targetDepth > 4.2) continue;

      const dFocus = Math.hypot(this.scX[s] - focusX, this.scZ[s] - focusZ);
      if (dFocus > 160.0) continue;
      if (hasBaitPoint && Math.hypot(this.scX[s] - baitX, this.scZ[s] - baitZ) < 15.0) continue;
      if (arenaWaterDepth(this.scX[s], this.scZ[s]) < 1.8) continue;

      const spBonus =
        bp.speciesId === 'flying_fish'
          ? 2.2
          : bp.speciesId === 'mackerel'
            ? 1.85
            : bp.speciesId === 'yellowfin_tuna'
              ? 1.25
              : 1.15;
      const distPref = dFocus < 10 ? 0.45 : dFocus < 95 ? 1.55 : 0.85;
      const w = (0.35 + this.nextLeapRand()) * spBonus * distPref;
      if (w > bestWeight) {
        bestWeight = w;
        chosenSchool = s;
      }
    }

    if (chosenSchool < 0) return;

    const bp = SCHOOL_BLUEPRINTS[chosenSchool];
    const start = this.scStartAgent[chosenSchool];
    const activeN = this.scActiveCount[chosenSchool];
    // Occasional graceful 2..3 fish staggered micro-burst for schooling silver/gliding species
    const maxBurst =
      (bp.speciesId === 'flying_fish' || bp.speciesId === 'mackerel' || bp.speciesId === 'surgeonfish') &&
      this.nextLeapRand() < 0.48
        ? 2 + (this.nextLeapRand() < 0.35 ? 1 : 0)
        : 1;

    let launched = 0;
    const offsetSeed = Math.floor(this.nextLeapRand() * activeN);
    for (let k = 0; k < activeN && launched < maxBurst; k++) {
      const idx = start + ((offsetSeed + k) % activeN);
      if (hasBaitPoint && Math.hypot(this.agX[idx] - baitX, this.agZ[idx] - baitZ) < 14.0) continue;
      const stagger = launched === 0 ? 0 : launched * (0.14 + this.nextLeapRand() * 0.16);
      if (this.tryLaunchFishLeap(idx, stagger)) {
        launched++;
      }
    }
  }

  private stepSplashParticles(dt: number, time: number): void {
    let writeSlot = 0;
    for (let i = 0; i < MAX_SPLASH_PARTICLES; i++) {
      if (this.spActive[i] === 0) continue;
      const age = this.spAge[i] + dt;
      const life = this.spLife[i];
      if (age >= life) {
        this.spActive[i] = 0;
        continue;
      }
      this.spAge[i] = age;
      const u = age / life;
      const isCrown = this.spKind[i] === 1;

      let x = this.spX[i];
      let y = this.spY[i];
      let z = this.spZ[i];
      let vx = this.spVx[i];
      let vy = this.spVy[i];
      let vz = this.spVz[i];

      if (isCrown) {
        const drag = Math.exp(-3.8 * dt);
        vx *= drag;
        vz *= drag;
        x += vx * dt;
        z += vz * dt;
        const surfY = arenaWaveHeight(x, z, time);
        const crownLift = Math.sin(Math.min(1, u * 1.35) * Math.PI) * 0.16;
        y = surfY + 0.02 + crownLift;
      } else {
        x += vx * dt;
        y += vy * dt;
        z += vz * dt;
        vy -= 9.81 * dt;
        const surfY = arenaWaveHeight(x, z, time);
        if (vy < 0 && y <= surfY) {
          this.spActive[i] = 0;
          continue;
        }
      }

      this.spX[i] = x;
      this.spY[i] = y;
      this.spZ[i] = z;
      this.spVx[i] = vx;
      this.spVy[i] = vy;
      this.spVz[i] = vz;

      const baseS = this.spScale[i];
      this.tmpPos.set(x, y, z);
      if (isCrown) {
        const grow = 1.0 + u * 1.45;
        this.tmpQuat.identity();
        this.tmpScale.set(baseS * 1.6 * grow, baseS * (0.85 - 0.45 * u), baseS * 1.6 * grow);
      } else {
        const spd = Math.hypot(vx, vy, vz);
        if (spd > 1e-3) {
          this.tmpFwd.set(vx / spd, vy / spd, vz / spd);
          this.tmpQuat.setFromUnitVectors(this.tmpUp.set(0, 1, 0), this.tmpFwd);
        } else {
          this.tmpQuat.identity();
        }
        const stretch = 1.0 + Math.min(1.6, spd * 0.24);
        const shrink = 1.0 - 0.35 * u;
        this.tmpScale.set(baseS * shrink, baseS * stretch * shrink, baseS * shrink);
      }

      this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      this.splashMesh.setMatrixAt(writeSlot, this.tmpMat);
      const alpha = Math.pow(Math.max(0, 1 - u), isCrown ? 1.5 : 1.15) * (isCrown ? 0.78 : 0.88);
      this.splashFadeAttr.setXY(writeSlot, alpha, isCrown ? 1.0 : 0.0);
      writeSlot++;
    }
    this.tmpUp.set(0, 1, 0);

    this.splashMesh.count = writeSlot;
    if (writeSlot > 0) {
      this.splashMatRange.count = writeSlot * 16;
      this.splashMesh.instanceMatrix.updateRanges[0] = this.splashMatRange;
      this.splashMesh.instanceMatrix.updateRanges.length = 1;
      this.splashMesh.instanceMatrix.needsUpdate = true;

      this.splashFadeRange.count = writeSlot * 2;
      this.splashFadeAttr.updateRanges[0] = this.splashFadeRange;
      this.splashFadeAttr.updateRanges.length = 1;
      this.splashFadeAttr.needsUpdate = true;
    }
  }

  /** True when at least one real underwater fish is actively approaching or nosing the bait (`FishingHudState.fishApproaching`). */
  isFishApproachingBait(): boolean {
    return this.activeCuriousCount > 0;
  }

  /** Inspect currently claimed/hooked agent metadata without allocations. */
  getClaimedAgentInfo(): {
    agentIndex: number;
    species: MarineSpeciesSpec | null;
    behavior: FishAiStateCode;
    scaleRatio: number;
    approaching: boolean;
  } {
    const idx = this.claimedAgentIdx;
    if (idx < 0 || idx >= this.totalAgents) {
      return {
        agentIndex: -1,
        species: null,
        behavior: FISH_AI_STATE.FREE_BOIDS,
        scaleRatio: 1,
        approaching: this.activeCuriousCount > 0,
      };
    }
    const bp = SCHOOL_BLUEPRINTS[this.agSchool[idx]];
    return {
      agentIndex: idx,
      species: MARINE_SPECIES_BY_ID[bp.speciesId] ?? null,
      behavior: this.agBehavior[idx] as FishAiStateCode,
      scaleRatio: this.agScale[idx] / bp.baseScale,
      approaching: this.activeCuriousCount > 0,
    };
  }

  /**
   * Releases any claimed/hooked/curious fish back into the water (`ESCAPING_OR_RELEASED` splash-back into school).
   */
  releaseClaimedFish(awayFromX?: number, awayFromZ?: number): void {
    for (let i = 0; i < this.totalAgents; i++) {
      const beh = this.agBehavior[i];
      if (beh === FISH_AI_STATE.FREE_BOIDS || beh === FISH_AI_STATE.ESCAPING_OR_RELEASED) continue;
      if (
        beh === FISH_AI_STATE.BITING ||
        beh === FISH_AI_STATE.HOOKED_FIGHTING ||
        beh === FISH_AI_STATE.CAUGHT_HELD
      ) {
        const s = this.agSchool[i];
        const refX = awayFromX ?? this.scX[s];
        const refZ = awayFromZ ?? this.scZ[s];
        let dx = awayFromX !== undefined ? this.agX[i] - refX : this.scX[s] - this.agX[i];
        let dz = awayFromZ !== undefined ? this.agZ[i] - refZ : this.scZ[s] - this.agZ[i];
        const d = Math.hypot(dx, dz);
        if (d < 1e-3) {
          dx = Math.sin(this.scHeading[s]);
          dz = Math.cos(this.scHeading[s]);
        } else {
          dx /= d;
          dz /= d;
        }
        if (this.agY[i] > ARENA_WATER_Y - 0.26) {
          this.agY[i] = ARENA_WATER_Y - 0.28;
        }
        this.agVx[i] = dx * 4.8;
        this.agVy[i] = -1.2;
        this.agVz[i] = dz * 4.8;
        this.agBehavior[i] = FISH_AI_STATE.ESCAPING_OR_RELEASED;
        this.agStateTimer[i] = 0;
        this.agCooldown[i] = 9.0;
      } else {
        this.agBehavior[i] = FISH_AI_STATE.FREE_BOIDS;
        this.agStateTimer[i] = 0;
        this.agCooldown[i] = 2.5;
      }
      this.agNibblesDone[i] = 0;
    }
    this.claimedAgentIdx = -1;
    this.activeCuriousCount = 0;
    this.fightLeapPhase = 0;
  }

  /**
   * Backwards-compatible ecological species sampler near `(x, z)` weighting live nearby Boids schools first.
   */
  sampleCatchableSpeciesAt(x: number, z: number, islandId: string): MarineSpeciesSpec {
    if (this.claimedAgentIdx >= 0) {
      const bp = SCHOOL_BLUEPRINTS[this.agSchool[this.claimedAgentIdx]];
      const claimedSpec = MARINE_SPECIES_BY_ID[bp.speciesId];
      if (claimedSpec && !isProtectedScenicSpecies(claimedSpec.id)) {
        return claimedSpec;
      }
    }

    let bestWeight = 0;
    let chosen: MarineSpeciesSpec = CATCHABLE_MARINE_SPECIES[0];

    for (let i = 0; i < CATCHABLE_MARINE_SPECIES.length; i++) {
      const sp = CATCHABLE_MARINE_SPECIES[i];
      const rarityBase =
        sp.rarity === 'common' ? 1.0 : sp.rarity === 'uncommon' ? 0.56 : sp.rarity === 'rare' ? 0.26 : 0.12;
      const habitatBonus = sp.islandZoneIds.includes(islandId) ? 2.15 : 0.55;

      let liveProximityBoost = 1.0;
      for (let s = 0; s < this.schoolCount; s++) {
        if (SCHOOL_BLUEPRINTS[s].speciesId !== sp.id) continue;
        const d = Math.hypot(this.scX[s] - x, this.scZ[s] - z);
        if (d < 34) {
          liveProximityBoost = Math.max(liveProximityBoost, 1.0 + (1 - d / 34) * 3.2);
        }
      }

      const roll = Math.random() * rarityBase * habitatBonus * liveProximityBoost;
      if (roll > bestWeight) {
        bestWeight = roll;
        chosen = sp;
      }
    }
    return chosen;
  }

  /**
   * Selects a real catchable fish agent in `ArenaMarineEcosystem` to approach and inspect the settled bait,
   * plus up to 2 curious schoolmates. In open channels > 32 m from any school, steers a deep-channel patrol
   * fish smoothly into range along an underwater trajectory (zero cone spawn, zero visible pop).
   */
  private acquireBaitClaimantAndCurious(bait: ActiveBaitDescriptor, time: number): void {
    const bx = bait.baitX;
    const by = bait.baitY;
    const bz = bait.baitZ;
    const islandId = arenaIslandAt(bx, bz);

    let bestIdx = -1;
    let bestScore = -1e9;
    let secondIdx = -1;
    let secondScore = -1e9;
    let thirdIdx = -1;
    let thirdScore = -1e9;

    for (let i = 0; i < this.totalAgents; i++) {
      const s = this.agSchool[i];
      if (this.agRankInSchool[i] >= this.scActiveCount[s]) continue;
      if (this.agCooldown[i] > 0 || this.agLeapState[i] !== FISH_LEAP_PHASE.NONE) continue;
      const bp = SCHOOL_BLUEPRINTS[s];
      if (isProtectedScenicSpecies(bp.speciesId)) continue;

      const d = Math.hypot(this.agX[i] - bx, this.agZ[i] - bz);
      if (d > BAIT_SENSORY_RADIUS_M) continue;

      const spec = MARINE_SPECIES_BY_ID[bp.speciesId];
      const habitat = spec.islandZoneIds.includes(islandId) ? 3.5 : 0.0;
      const varietyJitter = Math.sin(time * 1.7 + i * 13.37) * 2.2;
      const score = BAIT_SENSORY_RADIUS_M - d + habitat + varietyJitter;

      if (score > bestScore) {
        thirdScore = secondScore;
        thirdIdx = secondIdx;
        secondScore = bestScore;
        secondIdx = bestIdx;
        bestScore = score;
        bestIdx = i;
      } else if (score > secondScore) {
        thirdScore = secondScore;
        thirdIdx = secondIdx;
        secondScore = score;
        secondIdx = i;
      } else if (score > thirdScore) {
        thirdScore = score;
        thirdIdx = i;
      }
    }

    // Open-channel patrol fallback (> 32 m from all 36 schools): route an eligible pelagic/habitat agent from deep water
    if (bestIdx < 0) {
      let fallbackBestD = Infinity;
      for (let i = 0; i < this.totalAgents; i++) {
        const s = this.agSchool[i];
        if (
          this.agRankInSchool[i] >= this.scActiveCount[s] ||
          this.agCooldown[i] > 0 ||
          this.agLeapState[i] !== FISH_LEAP_PHASE.NONE
        ) {
          continue;
        }
        const bp = SCHOOL_BLUEPRINTS[s];
        if (isProtectedScenicSpecies(bp.speciesId)) continue;
        const spec = MARINE_SPECIES_BY_ID[bp.speciesId];
        const d = Math.hypot(this.agX[i] - bx, this.agZ[i] - bz) * (spec.islandZoneIds.includes(islandId) ? 0.65 : 1.0);
        if (d < fallbackBestD) {
          fallbackBestD = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        const approachAng = Math.atan2(bx - bait.anglerX, bz - bait.anglerZ) + 0.55;
        const startX = bx + Math.sin(approachAng) * 9.2;
        const startZ = bz + Math.cos(approachAng) * 9.2;
        const floorY = arenaSwimGroundY(startX, startZ, by - 1.5);
        this.agX[bestIdx] = startX;
        this.agZ[bestIdx] = startZ;
        this.agY[bestIdx] = clamp(by - 1.4, floorY + 0.38, ARENA_WATER_Y - 0.55);
      }
    }

    if (bestIdx >= 0) {
      this.claimedAgentIdx = bestIdx;
      this.agBehavior[bestIdx] = FISH_AI_STATE.APPROACHING_BAIT;
      this.agStateTimer[bestIdx] = 0;
      this.agNibblesDone[bestIdx] = 0;
      this.agTargetNibbles[bestIdx] = 1 + (bestIdx % 2); // 1..2 nose nibbles before strike

      for (const comp of [secondIdx, thirdIdx]) {
        if (comp >= 0 && comp !== bestIdx) {
          this.agBehavior[comp] = FISH_AI_STATE.APPROACHING_BAIT;
          this.agStateTimer[comp] = 0;
          this.agNibblesDone[comp] = 0;
          this.agTargetNibbles[comp] = 3;
        }
      }
    }
  }

  /** Step high-level bait lifecycle sync with `ArenaFishingController` before stepping individual agents. */
  private stepBaitDirector(bait: ActiveBaitDescriptor | null | undefined, dt: number, time: number): void {
    if (!bait || !bait.active) {
      if (this.claimedAgentIdx >= 0 || this.activeCuriousCount > 0) {
        this.releaseClaimedFish();
      }
      this.baitSettledAge = 0;
      return;
    }

    const phase = bait.phase;
    if (phase === 'idle' || phase === 'equipped' || phase === 'charging' || phase === 'casting') {
      if (this.claimedAgentIdx >= 0 || this.activeCuriousCount > 0) {
        this.releaseClaimedFish(bait.anglerX, bait.anglerZ);
      }
      this.baitSettledAge = 0;
      return;
    }

    if (phase === 'escaped') {
      if (this.claimedAgentIdx >= 0 || this.activeCuriousCount > 0) {
        this.releaseClaimedFish(bait.anglerX, bait.anglerZ);
      }
      this.baitSettledAge = 0;
      return;
    }

    if (phase === 'waiting_bite') {
      if (!bait.settled) return;
      this.baitSettledAge += dt;
      if (this.claimedAgentIdx < 0) {
        this.acquireBaitClaimantAndCurious(bait, time);
      }
      return;
    }

    // Ensure a valid claimant exists if `bite_alert`, `reeling`, or `caught` was entered directly
    if (this.claimedAgentIdx < 0) {
      const hintIdx = bait.claimedAgentIndex;
      if (hintIdx >= 0 && hintIdx < this.totalAgents) {
        this.claimedAgentIdx = hintIdx;
      } else {
        this.acquireBaitClaimantAndCurious(bait, time);
      }
    }

    if (this.claimedAgentIdx >= 0) {
      const cIdx = this.claimedAgentIdx;
      if (phase === 'bite_alert' && this.agBehavior[cIdx] !== FISH_AI_STATE.BITING) {
        this.agBehavior[cIdx] = FISH_AI_STATE.BITING;
        this.agStateTimer[cIdx] = 0;
      } else if (phase === 'reeling' && this.agBehavior[cIdx] !== FISH_AI_STATE.HOOKED_FIGHTING) {
        this.agBehavior[cIdx] = FISH_AI_STATE.HOOKED_FIGHTING;
        this.agStateTimer[cIdx] = 0;
        this.fightAngle = 0;
        this.fightDepthOffset = -0.35;
        this.fightLeapPhase = 0;
        this.fightLocalSurge = false;
        this.fightSurgeTimer = 1.1;
      } else if (phase === 'caught' && this.agBehavior[cIdx] !== FISH_AI_STATE.CAUGHT_HELD) {
        this.agBehavior[cIdx] = FISH_AI_STATE.CAUGHT_HELD;
        this.agStateTimer[cIdx] = 0;
      }
    }
  }

  /** Advance 36-school Boids, frustum/distance culling, physical Fish-Bait-Fight AI, and GPU instance buffers. */
  update(ctx: MarineUpdateContext): readonly SurfaceFishSchool[] {
    const dt = clamp(ctx.dt, 0.001, 0.05);
    const time = ctx.time;

    this.syncOpticsUniforms();
    this.fishMat.uniforms.uTime.value = time;
    this.mantaMat.uniforms.uTime.value = time;

    const bait = ctx.bait ?? null;
    this.stepBaitDirector(bait, dt, time);

    const hasCamera = Boolean(ctx.camera);
    if (ctx.camera) {
      this.projScreenMat.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreenMat);
    }

    const forceWarmAllGroups = !this.warmedAllGroupsOnce;
    if (forceWarmAllGroups) {
      this.warmedAllGroupsOnce = true;
    }

    const rawBobber = ctx.bobber ?? ctx.activeBobber ?? null;
    const legacyBobber = !bait && rawBobber?.active ? rawBobber : null;
    const baitActiveX = bait && bait.active ? bait.baitX : legacyBobber ? legacyBobber.x : 0;
    const baitActiveZ = bait && bait.active ? bait.baitZ : legacyBobber ? legacyBobber.z : 0;
    const hasBaitPoint = Boolean((bait && bait.active) || legacyBobber);

    const focusX = ctx.camera ? ctx.camera.position.x : ctx.playerX;
    const focusZ = ctx.camera ? ctx.camera.position.z : ctx.playerZ;

    // 1. Advance all 36 school centroids + enforce bathymetry clearance + evaluate distance & frustum culling
    for (let s = 0; s < this.schoolCount; s++) {
      const bp = SCHOOL_BLUEPRINTS[s];
      const a = this.scPhase[s] + time * bp.orbitSpeed * (s % 2 === 0 ? 1 : -1);
      let targetX = bp.homeX + Math.cos(a) * bp.orbitRx;
      let targetZ = bp.homeZ + Math.sin(a) * bp.orbitRz;

      if (hasBaitPoint && !isProtectedScenicSpecies(bp.speciesId)) {
        const bdx = baitActiveX - targetX;
        const bdz = baitActiveZ - targetZ;
        const bDist = Math.hypot(bdx, bdz);
        if (bDist < 24 && bDist > 0.4) {
          const pull = (1 - bDist / 24) * 0.42;
          targetX += bdx * pull;
          targetZ += bdz * pull;
        }
      }

      // Keep school centroid in real coastal/ocean water >= 1.65 m deep (never drifting onto beaches or islets)
      const minSchoolDepth = bp.shallowSurface ? 1.65 : Math.min(3.0, bp.targetDepth + 0.6);
      nudgeOutOfShallowWater(targetX, targetZ, minSchoolDepth, this.tmpNudge);
      targetX = this.tmpNudge.x;
      targetZ = this.tmpNudge.z;

      const prevX = this.scX[s];
      const prevZ = this.scZ[s];
      const k = 1 - Math.exp(-2.4 * dt);
      this.scX[s] += (targetX - this.scX[s]) * k;
      this.scZ[s] += (targetZ - this.scZ[s]) * k;

      const bathY = arenaBathymetry(this.scX[s], this.scZ[s]);
      const desiredY =
        ARENA_WATER_Y - bp.targetDepth + Math.sin(time * 0.65 + s * 1.3) * (bp.shallowSurface ? 0.15 : 0.42);
      const maxScY = ARENA_WATER_Y - (bp.shallowSurface ? 0.32 : 0.62);
      const minScY = Math.min(maxScY - 0.05, bathY + 0.58);
      this.scY[s] = clamp(desiredY, minScY, maxScY);

      const moveDx = this.scX[s] - prevX;
      const moveDz = this.scZ[s] - prevZ;
      if (moveDx * moveDx + moveDz * moveDz > 1e-6) {
        const desiredHeading = Math.atan2(moveDx, moveDz);
        const hDelta = normalizeAngleDelta(desiredHeading - this.scHeading[s]);
        this.scHeading[s] += clamp(hDelta, -1.8 * dt, 1.8 * dt);
      }

      // Visibility & simulation culling: never cull school holding claimed/curious/leaping fish or during boot warmup!
      const holdsClaimed = this.claimedAgentIdx >= 0 && this.agSchool[this.claimedAgentIdx] === s;
      const nearActiveBait =
        hasBaitPoint && (this.scX[s] - baitActiveX) ** 2 + (this.scZ[s] - baitActiveZ) ** 2 < 40 * 40;

      let holdsLeaping = false;
      const scStart = this.scStartAgent[s];
      const scEnd = scStart + bp.maxCount;
      for (let m = scStart; m < scEnd; m++) {
        if (this.agLeapState[m] !== FISH_LEAP_PHASE.NONE) {
          holdsLeaping = true;
          break;
        }
      }

      if (forceWarmAllGroups || holdsClaimed || nearActiveBait || holdsLeaping) {
        this.scVisible[s] = 1;
      } else {
        const dxP = this.scX[s] - focusX;
        const dzP = this.scZ[s] - focusZ;
        const distSq = dxP * dxP + dzP * dzP;
        if (distSq > MAX_ACTIVE_DISTANCE_SQ) {
          this.scVisible[s] = 0;
        } else if (hasCamera && distSq > 46 * 46) {
          this.cullSphere.center.set(this.scX[s], this.scY[s], this.scZ[s]);
          this.cullSphere.radius = this.scRadius[s] + Math.max(bp.orbitRx, bp.orbitRz) * 0.55 + 8.0;
          this.scVisible[s] = this.frustum.intersectsSphere(this.cullSphere) ? 1 : 0;
        } else {
          this.scVisible[s] = 1;
        }
      }
    }

    // Step staggered autonomous coastal/pelagic fish leap director
    this.stepAutonomousLeapDirector(
      dt,
      focusX,
      focusZ,
      hasBaitPoint,
      baitActiveX,
      baitActiveZ,
      ctx.boats,
    );

    // 2. Populate fixed-size spatial hash grid for visible non-leaping Free-Boids agents (zero allocations)
    this.gridHead.fill(-1);
    for (let i = 0; i < this.totalAgents; i++) {
      if (this.agCooldown[i] > 0) {
        this.agCooldown[i] = Math.max(0, this.agCooldown[i] - dt);
      }
      if (this.agLeapRestCooldown[i] > 0) {
        this.agLeapRestCooldown[i] = Math.max(0, this.agLeapRestCooldown[i] - dt);
      }
      const s = this.agSchool[i];
      const beh = this.agBehavior[i];
      const leapState = this.agLeapState[i];
      if (
        (this.agRankInSchool[i] >= this.scActiveCount[s] && leapState === FISH_LEAP_PHASE.NONE) ||
        (this.scVisible[s] === 0 && beh === FISH_AI_STATE.FREE_BOIDS && leapState === FISH_LEAP_PHASE.NONE)
      ) {
        this.gridNext[i] = -1;
        continue;
      }
      if (beh !== FISH_AI_STATE.FREE_BOIDS || leapState === FISH_LEAP_PHASE.AIRBORNE) {
        this.gridNext[i] = -1;
        continue;
      }
      const cx = Math.floor(this.agX[i] / CELL_SIZE);
      const cz = Math.floor(this.agZ[i] / CELL_SIZE);
      const h = ((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0) & (HASH_BUCKETS - 1);
      this.gridNext[i] = this.gridHead[h];
      this.gridHead[h] = i;
    }

    // 3. Step Boids + 3-Phase Ballistic Fish Leaps + Physical Fish-Bait-Fight AI + write GPU instance slots
    this.groupWriteCounts.fill(0);
    this.activeCuriousCount = 0;
    this.activeLeapingCount = 0;
    this.pendingHookPose = false;
    const boats = ctx.boats;

    for (let i = 0; i < this.totalAgents; i++) {
      const s = this.agSchool[i];
      const beh = this.agBehavior[i];
      const leapState = this.agLeapState[i];
      if (
        this.agRankInSchool[i] >= this.scActiveCount[s] &&
        i !== this.claimedAgentIdx &&
        leapState === FISH_LEAP_PHASE.NONE
      ) {
        continue;
      }
      if (this.scVisible[s] === 0 && beh === FISH_AI_STATE.FREE_BOIDS && leapState === FISH_LEAP_PHASE.NONE) {
        continue;
      }

      const bp = SCHOOL_BLUEPRINTS[s];
      const g = this.agGroup[i];
      const sc = this.agScale[i];
      let px = this.agX[i];
      let py = this.agY[i];
      let pz = this.agZ[i];
      let vx = this.agVx[i];
      let vy = this.agVy[i];
      let vz = this.agVz[i];
      let freqScale = 1.0;
      let extraMeta = 0.0; // glide for G6, bankAngle for G7/G8, thrashBoost for hooked/airborne fish
      let customQuat = false;
      let useFullVelocityPitch = beh !== FISH_AI_STATE.FREE_BOIDS;

      if (beh !== FISH_AI_STATE.FREE_BOIDS) {
        this.agStateTimer[i] += dt;
      }

      // ======================================================================
      // BRANCH A: PHYSICAL BAIT -> NIBBLE -> BITE -> FIGHT -> CATCH -> ESCAPE AI
      // ======================================================================
      if (beh === FISH_AI_STATE.APPROACHING_BAIT && bait && bait.active) {
        this.activeCuriousCount++;
        const isClaimant = i === this.claimedAgentIdx;
        const standR = isClaimant ? 0.44 : 0.78 + (i % 3) * 0.22;
        const orbitAng = time * 1.35 + i * 2.1;
        const goalX = bait.baitX + Math.cos(orbitAng) * standR;
        const goalZ = bait.baitZ + Math.sin(orbitAng) * standR;
        const goalY = clamp(bait.baitY - 0.04, arenaSwimGroundY(goalX, goalZ, py) + 0.28, ARENA_WATER_Y - 0.28);

        const dx = goalX - px;
        const dy = goalY - py;
        const dz = goalZ - pz;
        const dist = Math.hypot(dx, dy, dz);
        const approachSpd = clamp(dist * 1.15 + 2.5, 2.6, 5.8);
        if (dist > 1e-3) {
          const blend = 1 - Math.exp(-6.5 * dt);
          vx += ((dx / dist) * approachSpd - vx) * blend;
          vy += ((dy / dist) * approachSpd - vy) * blend;
          vz += ((dz / dist) * approachSpd - vz) * blend;
        }
        px += vx * dt;
        py += vy * dt;
        pz += vz * dt;
        freqScale = 1.55;

        const distToBait = Math.hypot(bait.baitX - px, bait.baitY - py, bait.baitZ - pz);
        if (distToBait <= (isClaimant ? 0.72 : 1.05) || this.agStateTimer[i] >= 2.35) {
          this.agBehavior[i] = FISH_AI_STATE.INVESTIGATING_BAIT;
          this.agStateTimer[i] = 0;
        }
      } else if (beh === FISH_AI_STATE.INVESTIGATING_BAIT && bait && bait.active) {
        this.activeCuriousCount++;
        const isClaimant = i === this.claimedAgentIdx;
        const mouthDistFromCenter = sc * GROUP_MOUTH_LOCAL_Z[g];
        const tLocal = this.agStateTimer[i];

        // Periodic curious nose-dart cycles (~0.78 s period): circle -> dart nose to bait -> recoil!
        const nibbleCycle = (tLocal % 0.78) / 0.78;
        const dartPulse = Math.exp(-Math.pow((nibbleCycle - 0.58) / 0.14, 2));
        const baseOrbitR = (isClaimant ? 0.36 : 0.68) + mouthDistFromCenter;
        const curRadius = baseOrbitR * (1 - 0.82 * (isClaimant ? dartPulse : dartPulse * 0.45));
        const ang = time * (isClaimant ? 1.85 : 1.25) + i * 1.9;

        const targetX = bait.baitX + Math.sin(ang) * curRadius;
        const targetZ = bait.baitZ + Math.cos(ang) * curRadius;
        const targetY = clamp(
          bait.baitY - 0.03 + Math.sin(time * 3.2 + i) * 0.04,
          arenaSwimGroundY(targetX, targetZ, py) + 0.25,
          ARENA_WATER_Y - 0.24,
        );

        const kFollow = 1 - Math.exp(-11.0 * dt);
        const nextPx = px + (targetX - px) * kFollow;
        const nextPy = py + (targetY - py) * kFollow;
        const nextPz = pz + (targetZ - pz) * kFollow;
        vx = (bait.baitX - nextPx) * 3.5;
        vy = (bait.baitY - nextPy) * 2.2;
        vz = (bait.baitZ - nextPz) * 3.5;
        px = nextPx;
        py = nextPy;
        pz = nextPz;
        freqScale = 1.35 + dartPulse * 0.65;

        // Compute true 3D mouth world position to detect physical bait contact!
        const toBaitLen = Math.hypot(vx, vy, vz) || 1;
        const fx = vx / toBaitLen;
        const fy = vy / toBaitLen;
        const fz = vz / toBaitLen;
        const mouthX = px + fx * mouthDistFromCenter;
        const mouthY = py + fy * mouthDistFromCenter;
        const mouthZ = pz + fz * mouthDistFromCenter;
        const mouthGap = Math.hypot(mouthX - bait.baitX, mouthY - bait.baitY, mouthZ - bait.baitZ);

        if (isClaimant) {
          const minNibbleTime = 0.48 + this.agNibblesDone[i] * 0.78;
          const forceNibbleTime = 0.72 + this.agNibblesDone[i] * 0.78;
          if (
            this.agNibblesDone[i] < this.agTargetNibbles[i] &&
            tLocal >= minNibbleTime &&
            ((mouthGap <= 0.24 && nibbleCycle > 0.45 && nibbleCycle < 0.72) || tLocal >= forceNibbleTime)
          ) {
            this.agNibblesDone[i]++;
            // Push slightly back so each nibble is a distinct physical nose tap
            px -= fx * 0.22;
            pz -= fz * 0.22;
            bait.onBaitNibble?.(0.42 + 0.24 * this.agNibblesDone[i], i);
          } else if (
            this.agNibblesDone[i] >= this.agTargetNibbles[i] &&
            this.baitSettledAge >= 2.38 &&
            (mouthGap <= 0.22 || tLocal >= 0.78 * this.agTargetNibbles[i] + 0.65 || this.baitSettledAge >= 4.9)
          ) {
            // DECISIVE STRIKE (`BITING`)! Clamp mouth onto hook and scatter curious bystander fish!
            this.agBehavior[i] = FISH_AI_STATE.BITING;
            this.agStateTimer[i] = 0;
            for (let j = 0; j < this.totalAgents; j++) {
              if (
                j !== i &&
                (this.agBehavior[j] === FISH_AI_STATE.APPROACHING_BAIT ||
                  this.agBehavior[j] === FISH_AI_STATE.INVESTIGATING_BAIT)
              ) {
                this.agBehavior[j] = FISH_AI_STATE.ESCAPING_OR_RELEASED;
                this.agStateTimer[j] = 0;
                this.agCooldown[j] = 4.5;
                const sdx = this.agX[j] - bait.baitX;
                const sdz = this.agZ[j] - bait.baitZ;
                const sd = Math.hypot(sdx, sdz) || 1;
                this.agVx[j] = (sdx / sd) * 3.8;
                this.agVz[j] = (sdz / sd) * 3.8;
              }
            }
            const spec = MARINE_SPECIES_BY_ID[bp.speciesId];
            const scaleRatio = sc / bp.baseScale;
            bait.onFishBite?.(i, spec, scaleRatio, bait.bobberX, bait.bobberY - 0.52, bait.bobberZ);
          }
        }
      } else if (beh === FISH_AI_STATE.BITING && bait && bait.active) {
        // Biting fish clamps onto hook beneath the plunged bobber (`bait.bobber*` is feedback-free ground truth!)
        let awayX = bait.bobberX - bait.anglerX;
        let awayZ = bait.bobberZ - bait.anglerZ;
        const awayLen = Math.hypot(awayX, awayZ) || 1;
        awayX /= awayLen;
        awayZ /= awayLen;
        const latX = awayZ;
        const latZ = -awayX;

        const tugOsc = Math.sin(time * 15.0 + i);
        const mouthX = bait.bobberX + awayX * 0.12 + latX * tugOsc * 0.08;
        const mouthZ = bait.bobberZ + awayZ * 0.12 + latZ * tugOsc * 0.08;
        const floorY = arenaSwimGroundY(mouthX, mouthZ, bait.bobberY - 0.55);
        const mouthY = clamp(
          bait.bobberY - 0.44 - Math.abs(Math.sin(time * 9.5)) * 0.08,
          floorY + 0.24,
          ARENA_WATER_Y - 0.22,
        );

        // Orient fish diving away & downward from the bobber, locking its +Z snout directly to `(mouthX, mouthY, mouthZ)`!
        const dirX = awayX * 0.86 + latX * tugOsc * 0.32;
        const dirY = -0.38;
        const dirZ = awayZ * 0.86 + latZ * tugOsc * 0.32;
        const dL = Math.hypot(dirX, dirY, dirZ) || 1;
        const fx = dirX / dL;
        const fy = dirY / dL;
        const fz = dirZ / dL;

        this.computeCenterFromMouth(g, sc, mouthX, mouthY, mouthZ, fx, fy, fz, 0, 1, 0);
        px = this.tmpPos.x;
        py = this.tmpPos.y;
        pz = this.tmpPos.z;
        vx = fx * 3.2;
        vy = fy * 3.2;
        vz = fz * 3.2;
        freqScale = 2.25;
        extraMeta = g === 7 || g === 8 ? tugOsc * 0.22 : 0.85;

        this.pendingHookPose = true;
        this.pendingMouthX = mouthX;
        this.pendingMouthY = mouthY;
        this.pendingMouthZ = mouthZ;
        this.pendingPulling = true;
      } else if (beh === FISH_AI_STATE.HOOKED_FIGHTING && bait && bait.active) {
        // Real 3D Hooked-Fish Line Fight! Anchor around `bait.bait*` (feedback-free nominal reel trajectory)!
        const spec = MARINE_SPECIES_BY_ID[bp.speciesId];
        const res = spec?.resistance ?? 0.45;
        const pullFraction = clamp(1 - bait.progress, 0.05, 1.0);

        this.fightSurgeTimer -= dt;
        if (this.fightSurgeTimer <= 0) {
          this.fightLocalSurge = !this.fightLocalSurge;
          this.fightSurgeTimer = this.fightLocalSurge ? 0.9 + res * 0.9 : 1.1 + (1 - res) * 0.9;
        }
        const pulling = bait.fishPulling || this.fightLocalSurge;

        // Lateral tangential darting + vertical reef dive / pelagic breach
        this.fightAngle += dt * (pulling ? 2.8 + res * 2.4 : 1.15);
        const canBreach = g === 5 || g === 6; // Pelagic scombrids & flying fish leap dramatically!
        if (pulling && canBreach && this.fightLeapPhase <= 0 && Math.sin(time * 11.3 + i) > 0.92 && pullFraction > 0.25) {
          this.fightLeapPhase = 0.001;
        }

        let awayX = bait.baitX - bait.anglerX;
        let awayZ = bait.baitZ - bait.anglerZ;
        const awayLen = Math.hypot(awayX, awayZ) || 1;
        awayX /= awayLen;
        awayZ /= awayLen;
        const latX = awayZ;
        const latZ = -awayX;

        const latSweep = Math.sin(this.fightAngle) * (pulling ? 0.62 : 0.28) * (0.35 + 0.65 * pullFraction);
        const radPull = (pulling ? 0.34 : 0.08) * pullFraction;

        const mouthX = bait.baitX + awayX * radPull + latX * latSweep;
        const mouthZ = bait.baitZ + awayZ * radPull + latZ * latSweep;
        const floorY = arenaSwimGroundY(mouthX, mouthZ, bait.baitY - 0.6);

        const targetDepthOff = pulling ? -(0.22 + res * 0.36) : 0.0;
        this.fightDepthOffset += (targetDepthOff - this.fightDepthOffset) * (1 - Math.exp(-5.5 * dt));

        let mouthY = clamp(bait.baitY + this.fightDepthOffset, floorY + 0.26, ARENA_WATER_Y - 0.16);
        let pitchVy = pulling ? -0.55 : 0.18;

        if (this.fightLeapPhase > 0) {
          this.fightLeapPhase += dt * 1.45;
          if (this.fightLeapPhase >= 1.0) {
            this.fightLeapPhase = 0;
          } else {
            const arc = 4.0 * 0.82 * this.fightLeapPhase * (1.0 - this.fightLeapPhase);
            mouthY = Math.max(bait.baitY, ARENA_WATER_Y - 0.12) + arc;
            pitchVy = (0.5 - this.fightLeapPhase) * 3.4;
          }
        }

        // Heading: surges pull strongly away + tangential; calm reeling turns fish obliquely toward angler
        const headSign = pulling ? 1.0 : -0.45;
        const tangSign = Math.cos(this.fightAngle) * (pulling ? 0.95 : 0.55);
        const dirX = awayX * headSign + latX * tangSign;
        const dirZ = awayZ * headSign + latZ * tangSign;
        const dL = Math.hypot(dirX, pitchVy, dirZ) || 1;
        const fx = dirX / dL;
        const fy = pitchVy / dL;
        const fz = dirZ / dL;

        this.computeCenterFromMouth(g, sc, mouthX, mouthY, mouthZ, fx, fy, fz, 0, 1, 0);
        px = this.tmpPos.x;
        py = this.tmpPos.y;
        pz = this.tmpPos.z;
        vx = fx * 4.5;
        vy = fy * 4.5;
        vz = fz * 4.5;

        freqScale = pulling ? 2.85 : 1.95;
        extraMeta =
          g === 6 && this.fightLeapPhase > 0
            ? smoothstep01((mouthY - ARENA_WATER_Y + 0.05) / 0.3)
            : g === 7 || g === 8
              ? clamp(tangSign * 0.28, -0.35, 0.35)
              : pulling
                ? 1.05
                : 0.55;

        this.pendingHookPose = true;
        this.pendingMouthX = mouthX;
        this.pendingMouthY = mouthY;
        this.pendingMouthZ = mouthZ;
        this.pendingPulling = pulling;
      } else if (beh === FISH_AI_STATE.CAUGHT_HELD && bait && bait.active) {
        // Presented gracefully suspended from the leader in front of the angler (`bait.bait*` = feedback-free `hold*`)
        const mouthX = bait.baitX;
        const mouthY = bait.baitY;
        const mouthZ = bait.baitZ;

        if (g === 8) {
          // Spotted Eagle Ray glides gently pitched so its starry dorsal disc faces the angler
          const toAngX = bait.anglerX - mouthX;
          const toAngZ = bait.anglerZ - mouthZ;
          const lA = Math.hypot(toAngX, toAngZ) || 1;
          const rawFx = (toAngX / lA) * 0.85;
          const rawFy = 0.52;
          const rawFz = (toAngZ / lA) * 0.85;
          const fLen = Math.hypot(rawFx, rawFy, rawFz) || 1;
          const fx = rawFx / fLen;
          const fy = rawFy / fLen;
          const fz = rawFz / fLen;
          this.computeCenterFromMouth(g, sc, mouthX, mouthY, mouthZ, fx, fy, fz, 0, 1, 0);
          px = this.tmpPos.x;
          py = this.tmpPos.y;
          pz = this.tmpPos.z;
          vx = fx;
          vy = fy;
          vz = fz;
          freqScale = 0.85;
        } else {
          // Fusiform/discoid/pelagic/shark hangs nose-up (+Y) from the hook with gentle flank presentation sway
          const swayX = Math.sin(time * 2.2) * 0.12;
          const swayZ = Math.cos(time * 1.9) * 0.12;
          this.tmpFwd.set(swayX, 0.985, swayZ).normalize();
          const spinYaw = time * 0.95;
          const upX = Math.sin(spinYaw);
          const upZ = Math.cos(spinYaw);
          this.computeCenterFromMouth(
            g,
            sc,
            mouthX,
            mouthY,
            mouthZ,
            this.tmpFwd.x,
            this.tmpFwd.y,
            this.tmpFwd.z,
            upX,
            0,
            upZ,
          );
          px = this.tmpPos.x;
          py = this.tmpPos.y;
          pz = this.tmpPos.z;

          this.tmpUp.set(upX, 0, upZ);
          this.tmpTarget.copy(this.tmpPos).add(this.tmpFwd);
          this.tmpLookMat.lookAt(this.tmpTarget, this.tmpPos, this.tmpUp);
          this.tmpQuat.setFromRotationMatrix(this.tmpLookMat);
          this.tmpUp.set(0, 1, 0);
          customQuat = true;
          freqScale = 0.62;
          extraMeta = 0.25;
        }

        this.pendingHookPose = true;
        this.pendingMouthX = mouthX;
        this.pendingMouthY = mouthY;
        this.pendingMouthZ = mouthZ;
        this.pendingPulling = false;
      } else if (beh === FISH_AI_STATE.ESCAPING_OR_RELEASED) {
        // Brisk underwater return sprint back into its home school!
        const toScX = this.scX[s] - px;
        const toScY = this.scY[s] - py;
        const toScZ = this.scZ[s] - pz;
        const distSc = Math.hypot(toScX, toScZ);
        if (distSc > 0.5) {
          const escapeSpd = 4.6;
          const blend = 1 - Math.exp(-4.2 * dt);
          vx += ((toScX / distSc) * escapeSpd - vx) * blend;
          vz += ((toScZ / distSc) * escapeSpd - vz) * blend;
        }
        vy += (clamp(toScY * 2.2, -3.5, 2.5) - vy) * (1 - Math.exp(-5.0 * dt));
        px += vx * dt;
        py += vy * dt;
        pz += vz * dt;

        const floorY = arenaSwimGroundY(px, pz, py);
        py = clamp(py, floorY + 0.32, ARENA_WATER_Y - 0.26);
        freqScale = 2.15;
        extraMeta = g === 7 || g === 8 ? 0 : 0.45;

        if (distSc < this.scRadius[s] * 1.15 || this.agStateTimer[i] >= 2.2) {
          this.agBehavior[i] = FISH_AI_STATE.FREE_BOIDS;
          this.agStateTimer[i] = 0;
        }
      } else {
        // ====================================================================
        // BRANCH B: COHESIVE FREE BOIDS + SMOOTH BANKING + 3-PHASE SURFACE LEAPS
        // ====================================================================
        const curLeap = this.agLeapState[i];
        if (curLeap === FISH_LEAP_PHASE.LAUNCH_ASCENT && this.agLeapTimer[i] >= 0) {
          // Phase 1: 0.35 s underwater launch ascent (+28°..+48° pitch up to Gerstner wave surface)
          this.activeLeapingCount++;
          useFullVelocityPitch = true;
          const tAsc = this.agLeapTimer[i] + dt;
          this.agLeapTimer[i] = tAsc;
          const surfY = arenaWaveHeight(px, pz, time);
          const ldx = this.agLeapDx[i];
          const ldz = this.agLeapDz[i];
          const vh0 = this.agLeapVh0[i];
          const vy0 = this.agLeapVy0[i];

          const ramp = 1 - Math.exp(-10.5 * dt);
          vx += (ldx * vh0 * 0.94 - vx) * ramp;
          vz += (ldz * vh0 * 0.94 - vz) * ramp;
          const remT = Math.max(0.055, 0.35 - tAsc);
          const neededVy = clamp((surfY + 0.03 - py) / remT, 1.9, Math.max(3.2, vy0 * 1.18));
          vy += (neededVy - vy) * (1 - Math.exp(-12.0 * dt));

          px += vx * dt;
          pz += vz * dt;
          py += vy * dt;

          const bathY = arenaBathymetry(px, pz);
          if (py < bathY + 0.30) py = bathY + 0.30;

          freqScale = 2.35;
          extraMeta = g === 6 ? 0.25 : 0.45;
          this.agBankAngle[i] *= Math.exp(-8.0 * dt);

          const liveSurfY = arenaWaveHeight(px, pz, time);
          if (py >= liveSurfY || tAsc >= 0.46) {
            // Abort safely if unexpected shallow obstacle appeared; otherwise breach into AIRBORNE!
            if (!isLeapTrajectorySafe(px, pz, ldx, ldz, vh0 * ((2.0 * vy0) / this.agLeapGravity[i]))) {
              this.agLeapState[i] = FISH_LEAP_PHASE.RECOVERY_DIVE;
              this.agLeapTimer[i] = 0;
              this.agLeapRestCooldown[i] = 8.0 + this.nextLeapRand() * 6.0;
              py = Math.min(py, liveSurfY - 0.14);
              vy = -0.85;
            } else {
              py = liveSurfY + 0.018;
              vx = ldx * vh0;
              vz = ldz * vh0;
              vy = vy0;
              this.agLeapState[i] = FISH_LEAP_PHASE.AIRBORNE;
              this.agLeapTimer[i] = 0;
              const strength = clamp(0.36 + sc * 0.68, 0.36, 0.95);
              const radius = clamp(0.78 + sc * 1.35, 0.82, 2.2);
              this.emitLeapSplash('exit', px, liveSurfY, pz, strength, radius, ldx, ldz);
            }
          }
        } else if (curLeap === FISH_LEAP_PHASE.AIRBORNE) {
          // Phase 2: True ballistic arc above `waveY` (x += vx*dt, z += vz*dt, y += vy*dt, vy -= g_eff*dt)
          this.activeLeapingCount++;
          useFullVelocityPitch = true;
          const tAir = this.agLeapTimer[i] + dt;
          this.agLeapTimer[i] = tAir;
          const gEff = this.agLeapGravity[i];

          px += vx * dt;
          pz += vz * dt;
          py += vy * dt;
          vy -= gEff * dt;

          // Subtle mid-air body roll & brisk tail flutter (pectoral glide wings fully deployed on flying_fish)
          this.agBankAngle[i] = Math.sin(tAir * 8.5 + this.agPhase[i]) * (g === 6 ? 0.11 : 0.16);
          const liveSurfY = arenaWaveHeight(px, pz, time);
          freqScale = g === 6 ? 1.85 : 2.55;
          extraMeta =
            g === 6
              ? smoothstep01((py - liveSurfY + 0.06) / 0.24)
              : 0.72;

          if ((vy < 0 && py <= liveSurfY) || tAir >= 2.8) {
            const reentryY = liveSurfY;
            py = reentryY - 0.025;
            const exitStr = clamp(0.36 + sc * 0.68, 0.36, 0.95);
            const exitRad = clamp(0.78 + sc * 1.35, 0.82, 2.2);
            this.emitLeapSplash(
              'reentry',
              px,
              reentryY,
              pz,
              clamp(exitStr * 1.25, 0.44, 1.18),
              clamp(exitRad * 1.14, 0.92, 2.5),
              this.agLeapDx[i],
              this.agLeapDz[i],
            );
            this.agLeapState[i] = FISH_LEAP_PHASE.RECOVERY_DIVE;
            this.agLeapTimer[i] = 0;
            this.agLeapRestCooldown[i] = 12.0 + this.nextLeapRand() * 16.0;
          }
        } else if (curLeap === FISH_LEAP_PHASE.RECOVERY_DIVE) {
          // Phase 3: Clean underwater plunge deceleration & smooth rejoin into school cruise depth
          useFullVelocityPitch = true;
          const tRec = this.agLeapTimer[i] + dt;
          this.agLeapTimer[i] = tRec;

          const toScX = this.scX[s] - px;
          const toScZ = this.scZ[s] - pz;
          const dSc = Math.hypot(toScX, toScZ) || 1;
          const cruiseSpd = g === 5 ? 2.85 : g === 6 ? 2.35 : 1.85;
          const blendH = 1 - Math.exp(-3.6 * dt);
          vx += (((toScX / dSc) * 0.55 + Math.sin(this.scHeading[s]) * 0.45) * cruiseSpd - vx) * blendH;
          vz += (((toScZ / dSc) * 0.55 + Math.cos(this.scHeading[s]) * 0.45) * cruiseSpd - vz) * blendH;

          const goalDiveY = Math.min(this.scY[s], ARENA_WATER_Y - 0.48);
          vy += ((goalDiveY - py) * 4.4 - vy * 4.8) * dt;

          px += vx * dt;
          pz += vz * dt;
          py += vy * dt;

          const bathY = arenaBathymetry(px, pz);
          const surfCap = arenaWaveHeight(px, pz, time) - 0.14;
          py = clamp(py, bathY + 0.38, surfCap);
          if (py <= bathY + 0.39 && vy < 0) vy = 0;
          this.agBankAngle[i] *= Math.exp(-6.0 * dt);
          freqScale = 1.55;

          if (tRec >= 0.68) {
            this.agLeapState[i] = FISH_LEAP_PHASE.NONE;
            this.agLeapTimer[i] = 0;
          }
        } else {
          // Advance negative micro-burst stagger timer while continuing cohesive schooling until `>= 0`
          if (curLeap === FISH_LEAP_PHASE.LAUNCH_ASCENT && this.agLeapTimer[i] < 0) {
            this.agLeapTimer[i] += dt;
          }

          const spec = MARINE_SPECIES_BY_ID[bp.speciesId];
          const isSchooling = spec?.schooling ?? true;

          let sepX = 0;
          let sepZ = 0;
          let aliX = 0;
          let aliZ = 0;
          let cohX = 0;
          let cohZ = 0;
          let neighbors = 0;

          // Sample 3x3 neighborhood around agent's spatial cell for fluid, gap-free school cohesion
          const baseCx = Math.floor(px / CELL_SIZE);
          const baseCz = Math.floor(pz / CELL_SIZE);
          const sepRadiusSq = Math.max(1.35, (sc * 2.4 + 0.55) ** 2);
          for (let ox = -1; ox <= 1 && neighbors < 10; ox++) {
            for (let oz = -1; oz <= 1 && neighbors < 10; oz++) {
              const h =
                ((Math.imul(baseCx + ox, 73856093) ^ Math.imul(baseCz + oz, 19349663)) >>> 0) &
                (HASH_BUCKETS - 1);
              let nb = this.gridHead[h];
              let guard = 0;
              while (nb !== -1 && neighbors < 10 && guard++ < 20) {
                if (nb !== i && this.agSchool[nb] === s) {
                  const dx = px - this.agX[nb];
                  const dz = pz - this.agZ[nb];
                  const dSq = dx * dx + dz * dz;
                  if (dSq > 1e-4 && dSq < 18.0) {
                    const d = Math.sqrt(dSq);
                    if (dSq < sepRadiusSq) {
                      const push = (1.0 - d / Math.sqrt(sepRadiusSq)) * 2.35;
                      sepX += (dx / d) * push;
                      sepZ += (dz / d) * push;
                    }
                    aliX += this.agVx[nb];
                    aliZ += this.agVz[nb];
                    cohX += this.agX[nb];
                    cohZ += this.agZ[nb];
                    neighbors++;
                  }
                }
                nb = this.gridNext[nb];
              }
            }
          }

          const cohAnchorWeight = isSchooling ? 0.62 : 0.44;
          let desVx = (this.scX[s] - px) * cohAnchorWeight + sepX * 1.65 + Math.sin(this.scHeading[s]) * 1.85;
          let desVz = (this.scZ[s] - pz) * cohAnchorWeight + sepZ * 1.65 + Math.cos(this.scHeading[s]) * 1.85;

          if (neighbors > 0) {
            const invN = 1 / neighbors;
            const aliWeight = isSchooling ? 0.85 : 0.32;
            const cohWeight = isSchooling ? 0.46 : 0.16;
            desVx += (aliX * invN) * aliWeight + (cohX * invN - px) * cohWeight;
            desVz += (aliZ * invN) * aliWeight + (cohZ * invN - pz) * cohWeight;
          }

          // Calm avoidance of swimmers/waders
          const pDx = px - ctx.playerX;
          const pDz = pz - ctx.playerZ;
          const pDistSq = pDx * pDx + pDz * pDz;
          if (pDistSq < 28.0 && pDistSq > 1e-3 && ctx.playerY < ARENA_WATER_Y + 0.8) {
            const pDist = Math.sqrt(pDistSq);
            const repel = ((5.3 - pDist) / 5.3) * (g === 7 || g === 8 ? 1.2 : 4.2);
            if (repel > 0) {
              desVx += (pDx / pDist) * repel;
              desVz += (pDz / pDist) * repel;
            }
          }

          // Boat hull avoidance
          if (boats) {
            for (let b = 0; b < boats.length; b++) {
              const bt = boats[b];
              const bDx = px - bt.x;
              const bDz = pz - bt.z;
              const bDistSq = bDx * bDx + bDz * bDz;
              if (bDistSq < 38.0 && bDistSq > 1e-3) {
                const bDist = Math.sqrt(bDistSq);
                const repel = ((6.2 - bDist) / 6.2) * (2.6 + bt.speed * 0.48);
                desVx += (bDx / bDist) * repel;
                desVz += (bDz / bDist) * repel;
              }
            }
          }

          // Predictive seabed & coastline gradient avoidance (`y >= seabedY + clearance`, never beaching!)
          const minWaterCol = g === 7 || g === 8 ? 1.85 : g === 9 || g === 10 ? 1.55 : 1.05;
          const lookX = px + vx * 1.15;
          const lookZ = pz + vz * 1.15;
          const bathAhead = arenaBathymetry(lookX, lookZ);
          const bathHere = arenaBathymetry(px, pz);
          if (bathAhead > ARENA_WATER_Y - minWaterCol || bathHere > ARENA_WATER_Y - minWaterCol) {
            const eps = 1.8;
            const gx = arenaBathymetry(px + eps, pz) - arenaBathymetry(px - eps, pz);
            const gz = arenaBathymetry(px, pz + eps) - arenaBathymetry(px, pz - eps);
            const gL = Math.hypot(gx, gz);
            if (gL > 1e-4) {
              const urgency = clamp(
                (Math.max(bathAhead, bathHere) - (ARENA_WATER_Y - minWaterCol)) * 3.8 + 2.2,
                1.8,
                8.5,
              );
              desVx -= (gx / gL) * urgency;
              desVz -= (gz / gL) * urgency;
            } else {
              desVx += (this.scX[s] - px) * 2.2;
              desVz += (this.scZ[s] - pz) * 2.2;
            }
          }

          const baseCruise =
            g === 7 || g === 8
              ? 1.65
              : g === 9
                ? 1.15
                : g === 10
                  ? 2.25
                  : g === 5
                    ? 2.85
                    : g === 6
                      ? 2.25
                      : 1.75;
          // Natural phasic tail-kick speed modulation
          const glideMod = 1.0 + 0.13 * Math.sin(time * 1.55 + this.agPhase[i] * 0.8);
          const targetSpd = clamp(
            Math.hypot(desVx, desVz) * 0.55 + baseCruise * 0.55,
            baseCruise * 0.68,
            baseCruise * 1.48,
          ) * glideMod;
          freqScale = 0.88 + 0.22 * (targetSpd / baseCruise);

          // Smooth angular velocity clamping + natural body banking into turns!
          const curSpd = Math.hypot(vx, vz);
          const curYaw = curSpd > 0.05 ? Math.atan2(vx, vz) : this.scHeading[s];
          const desYaw = Math.hypot(desVx, desVz) > 0.05 ? Math.atan2(desVx, desVz) : curYaw;
          const maxTurnRate =
            g === 7 || g === 8
              ? 1.25
              : g === 9
                ? 1.45
                : g === 4 || g === 10
                  ? 1.95
                  : 2.85;
          const rawYawErr = normalizeAngleDelta(desYaw - curYaw);
          const yawStep = clamp(rawYawErr * 3.2 * dt, -maxTurnRate * dt, maxTurnRate * dt);
          const nextYaw = curYaw + yawStep;
          const actualYawRate = yawStep / dt;

          const spdBlend = 1 - Math.exp(-3.8 * dt);
          const nextSpd = curSpd + (targetSpd - curSpd) * spdBlend;
          vx = Math.sin(nextYaw) * nextSpd;
          vz = Math.cos(nextYaw) * nextSpd;

          const maxBank = g === 1 || g === 2 ? 0.22 : g === 7 || g === 8 ? 0.34 : 0.40;
          const bankGain = g === 7 || g === 8 ? 0.22 : 0.16;
          const targetBank = clamp(-actualYawRate * bankGain, -maxBank, maxBank);
          this.agBankAngle[i] += (targetBank - this.agBankAngle[i]) * (1 - Math.exp(-6.5 * dt));

          const targetY =
            this.scY[s] + Math.sin(time * 0.9 + this.agPhase[i]) * (bp.shallowSurface ? 0.14 : 0.42);
          vy += ((targetY - py) * 2.4 - vy * 3.0) * dt;

          px += vx * dt;
          pz += vz * dt;
          py += vy * dt;

          // Hard seabed & dry-land safety envelope (never clips sand/rocks, never buries under maxFishY!)
          let seabedY = arenaBathymetry(px, pz);
          const clearance = g === 7 || g === 8 ? 0.78 : 0.36;
          const surfMargin = bp.shallowSurface ? 0.24 : 0.46;
          const maxFishY = ARENA_WATER_Y - surfMargin;
          if (seabedY + clearance > maxFishY - 0.04 || arenaDryWalkable(px, pz)) {
            nudgeOutOfShallowWater(px, pz, clearance + surfMargin + 0.25, this.tmpNudge);
            px = this.tmpNudge.x;
            pz = this.tmpNudge.z;
            seabedY = arenaBathymetry(px, pz);
          }
          const minFishY = Math.min(maxFishY - 0.02, seabedY + clearance);
          if (py < minFishY) {
            py = minFishY;
            if (vy < 0) vy = 0;
          }
          if (py > maxFishY) {
            py = maxFishY;
            if (vy > 0) vy = 0;
          }

          const radial = Math.hypot(px, pz);
          if (radial > ARENA_BOAT_LIMIT - 6) {
            px *= (ARENA_BOAT_LIMIT - 6) / radial;
            pz *= (ARENA_BOAT_LIMIT - 6) / radial;
          }

          if (g === 7 || g === 8) {
            extraMeta = this.agBankAngle[i];
          }
        }
      }

      this.agX[i] = px;
      this.agY[i] = py;
      this.agZ[i] = pz;
      this.agVx[i] = vx;
      this.agVy[i] = vy;
      this.agVz[i] = vz;

      // Write transform + banked orientation + attributes into body-plan InstancedMesh slot
      const slot = this.groupWriteCounts[g]++;
      const instMesh = this.meshes[g];
      this.tmpPos.set(px, py, pz);
      if (!customQuat) {
        const pitchScale = useFullVelocityPitch ? 1.0 : 0.55;
        this.tmpTarget.set(px + vx, py + vy * pitchScale, pz + vz);
        if (this.tmpPos.distanceToSquared(this.tmpTarget) < 1e-6) {
          this.tmpTarget.set(px, py, pz + 1);
        }
        const bank = g === 7 || g === 8 ? 0 : this.agBankAngle[i];
        if (Math.abs(bank) > 1e-3) {
          // Bank local dorsal +Y smoothly inward along right = normalize(cross(worldUp, fwd))
          const hLen = Math.hypot(vx, vz);
          const rx = hLen > 1e-4 ? vz / hLen : 1;
          const rz = hLen > 1e-4 ? -vx / hLen : 0;
          const sb = Math.sin(-bank);
          const cb = Math.cos(bank);
          this.tmpUp.set(rx * sb, cb, rz * sb).normalize();
        } else {
          this.tmpUp.set(0, 1, 0);
        }
        this.tmpLookMat.lookAt(this.tmpTarget, this.tmpPos, this.tmpUp);
        this.tmpQuat.setFromRotationMatrix(this.tmpLookMat);
        this.tmpUp.set(0, 1, 0);
      }
      this.tmpScale.set(sc, sc, sc);
      this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      instMesh.setMatrixAt(slot, this.tmpMat);

      this.tmpColor.setRGB(
        this.agPrimaryRGB[i * 3],
        this.agPrimaryRGB[i * 3 + 1],
        this.agPrimaryRGB[i * 3 + 2],
      );
      instMesh.setColorAt(slot, this.tmpColor);

      this.metaAttrs[g].setXYZW(
        slot,
        this.agPhase[i],
        this.agSwimFreq[i] * freqScale,
        this.agPattern[i],
        extraMeta,
      );
      this.accentAttrs[g].setXYZ(
        slot,
        this.agAccentRGB[i * 3],
        this.agAccentRGB[i * 3 + 1],
        this.agAccentRGB[i * 3 + 2],
      );
    }

    // 4. Upload ONLY active instance sub-ranges; skip `bufferSubData` completely when `count === 0`!
    for (let g = 0; g < BODY_GROUP_COUNT; g++) {
      const count = this.groupWriteCounts[g];
      const mesh = this.meshes[g];
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) {
        const mr = this.matRanges[g];
        mr.count = count * 16;
        mesh.instanceMatrix.updateRanges[0] = mr;
        mesh.instanceMatrix.updateRanges.length = 1;
        mesh.instanceMatrix.needsUpdate = true;

        if (mesh.instanceColor) {
          const cr = this.colRanges[g];
          cr.count = count * 3;
          mesh.instanceColor.updateRanges[0] = cr;
          mesh.instanceColor.updateRanges.length = 1;
          mesh.instanceColor.needsUpdate = true;
        }

        const metaAttr = this.metaAttrs[g];
        const mtr = this.metaRanges[g];
        mtr.count = count * 4;
        metaAttr.updateRanges[0] = mtr;
        metaAttr.updateRanges.length = 1;
        metaAttr.needsUpdate = true;

        const accAttr = this.accentAttrs[g];
        const ar = this.accRanges[g];
        ar.count = count * 3;
        accAttr.updateRanges[0] = ar;
        accAttr.updateRanges.length = 1;
        accAttr.needsUpdate = true;
      }
    }

    if (this.pendingHookPose && bait && bait.active) {
      bait.onHookedFishPose?.(this.pendingMouthX, this.pendingMouthY, this.pendingMouthZ, this.pendingPulling);
    }

    // 4b. Step pooled 3D splash droplets & surface foam crowns (zero GC)
    this.stepSplashParticles(dt, time);

    // 5. Populate synchronized `SurfaceFishSchool[]` for shallow schools within 1.6 m of `ARENA_WATER_Y`
    let surfaceOutIdx = 0;
    for (let s = 0; s < this.schoolCount; s++) {
      const count = this.scActiveCount[s];
      if (count <= 0) continue;
      const depthBelowSurface = ARENA_WATER_Y - this.scY[s];
      if (depthBelowSurface >= -0.15 && depthBelowSurface <= 1.6) {
        const desc = this.surfacePool[surfaceOutIdx];
        desc.x = this.scX[s];
        desc.y = this.scY[s];
        desc.z = this.scZ[s];
        desc.radius = this.scRadius[s];
        desc.heading = this.scHeading[s];
        desc.count = count;
        const depthFade = 1 - clamp(Math.max(0, depthBelowSurface) / 1.6, 0, 1);
        desc.density = clamp((0.35 + 0.65 * depthFade) * Math.min(1, count / 18), 0.12, 1.0);
        this.activeSurfaceSchools[surfaceOutIdx] = desc;
        surfaceOutIdx++;
      }
    }
    this.activeSurfaceSchools.length = surfaceOutIdx;

    return this.activeSurfaceSchools;
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (let g = 0; g < this.meshes.length; g++) {
      this.meshes[g].geometry.dispose();
    }
    this.splashMesh.geometry.dispose();
    this.splashMat.dispose();
    this.fishMat.dispose();
    this.mantaMat.dispose();
    this.opticsFallback.dispose();
    this.boundOptics = null;
    this.meshes.length = 0;
  }
}

/** Find the nearest Archipelago island ID for any world `(x, z)` coordinate (zero allocations). */
export function resolveNearestIslandId(x: number, z: number): string {
  return arenaIslandAt(x, z);
}
