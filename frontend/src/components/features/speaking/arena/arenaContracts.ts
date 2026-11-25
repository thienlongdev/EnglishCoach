/**
 * Project ECHO ARCHIPELAGO — Shared Stage B Architectural Contracts.
 * Single source of truth for cross-department TypeScript interfaces across
 * World/Terrain, Ocean/Underwater, Character/Camera, Marine/Fishing/Fruit,
 * UI/Minimap/Speaking Stations, and Predictive Streaming.
 */

export type ArenaQualityTier = 'ultra' | 'high' | 'balanced' | 'low';
export type ArenaTimeOfDay = 'daylight' | 'sunset';

export type ArenaIslandProfile =
  | 'harbor'
  | 'beach'
  | 'karst'
  | 'atoll'
  | 'village'
  | 'mountain'
  | 'outer'
  | 'islet';

export interface ArenaIslandSpec {
  id: string;
  x: number;
  z: number;
  radius: number;
  height: number;
  seed: number;
  shore: number;
  profile?: ArenaIslandProfile | (string & {});
  lobe3?: number;
  lobe5?: number;
  beachStart?: number;
  beachEnd?: number;
}

export type ArenaWaterMode = 'land' | 'wading' | 'surface_swim' | 'underwater_dive';

export interface ArenaSwimFrame {
  mode: ArenaWaterMode;
  waterDepth: number;
  /** 0 on dry land .. 1 fully submerged */
  submersion: number;
  /** Metres below ARENA_WATER_Y (0 at surface, positive when diving deeper) */
  diveDepth: number;
  strokeSpeed: number;
  pitch: number;
  /** Signed vertical velocity in m/s (+up, -down) for buoyancy/hover/ascent/descent blending. */
  verticalSpeed?: number;
  /** True when treading water / neutrally hovering underwater with minimal horizontal/vertical thrust. */
  isTreading?: boolean;
  /** Normalized [0, 1) swimming stroke cycle phase synchronized between propulsion physics and skeletal animation. */
  strokePhase?: number;
  /** Subtle axial body roll (radians) during alternating freestyle strokes. */
  bodyRoll?: number;
}

/** Live shallow fish school descriptor passed from arenaMarineLife -> arenaSea for synchronized surface silhouettes. */
export interface SurfaceFishSchool {
  x: number;
  y: number;
  z: number;
  radius: number;
  heading: number;
  count: number;
  density: number;
}

export type FishRarity = 'common' | 'uncommon' | 'rare' | 'legendary';

export interface MarineSpeciesSpec {
  id: string;
  nameEn: string;
  nameVi: string;
  scientificName: string;
  habitatEn: string;
  habitatVi: string;
  islandZoneIds: readonly string[];
  rarity: FishRarity;
  minWeightKg: number;
  maxWeightKg: number;
  minLengthCm: number;
  maxLengthCm: number;
  depthMin: number;
  depthMax: number;
  schooling: boolean;
  /** 0.2 (gentle reef fish) .. 1.0 (powerful pelagic/shark) */
  resistance: number;
  colorPrimary: string;
  colorAccent: string;
  vocabWords: readonly string[];
  speakingPromptEn: string;
  speakingPromptVi: string;
}

export type FishingPhase =
  | 'idle'
  | 'equipped'
  | 'charging'
  | 'casting'
  | 'waiting_bite'
  | 'bite_alert'
  | 'reeling'
  | 'caught'
  | 'escaped';

export interface CaughtFishRecord {
  speciesId: string;
  weightKg: number;
  lengthCm: number;
  rarity: FishRarity;
  islandId: string;
  caughtAt: number;
  isNewRecord?: boolean;
}

export interface MarineCollectionState {
  catchesBySpecies: Record<
    string,
    {
      count: number;
      bestWeightKg: number;
      bestLengthCm: number;
      firstCaughtAt: number;
      lastIslandId: string;
    }
  >;
  totalCaught: number;
}

export interface FishingHudState {
  phase: FishingPhase;
  /** 0 .. 1 mouse/key hold cast power while charging */
  chargePower?: number;
  /** 0 .. 1 line tension (> 0.85 danger zone) */
  tension: number;
  /** 0 .. 1 reel-in completion */
  progress: number;
  fishPulling: boolean;
  /** True when a real underwater fish is actively approaching or nibbling the bait */
  fishApproaching?: boolean;
  distanceM: number;
  bobberX: number;
  bobberZ: number;
  activeSpecies: MarineSpeciesSpec | null;
  lastCatch: CaughtFishRecord | null;
}

/**
 * Live 3D bait/hook/line coupling contract between `ArenaFishingController` (`arenaFishing.ts`)
 * and `ArenaMarineEcosystem` (`arenaMarineLife.ts`) for cone-free physical fish AI (`F05`/`F06`).
 */
export interface ActiveBaitDescriptor {
  active: boolean;
  phase: FishingPhase;
  /** True once the cast bobber has splashed down and settled in water */
  settled: boolean;
  bobberX: number;
  bobberY: number;
  bobberZ: number;
  baitX: number;
  baitY: number;
  baitZ: number;
  hookX: number;
  hookY: number;
  hookZ: number;
  anglerX: number;
  anglerY: number;
  anglerZ: number;
  tension: number;
  progress: number;
  fishPulling: boolean;
  /** Agent index in `ArenaMarineEcosystem` currently claimed/hooked, or -1 */
  claimedAgentIndex: number;
  /** Called when an investigating fish physically noses/nibbles the bait */
  onBaitNibble?: (strength: number, agentIndex: number) => void;
  /** Called when the claimant fish clamps onto the hook and plunges the bobber (`bite_alert`) */
  onFishBite?: (
    agentIndex: number,
    species: MarineSpeciesSpec,
    scaleRatio: number,
    fishX: number,
    fishY: number,
    fishZ: number,
  ) => void;
  /** Called every frame while hooked/caught so the leader/bobber tracks the real 3D fish mouth */
  onHookedFishPose?: (
    mouthX: number,
    mouthY: number,
    mouthZ: number,
    pulling: boolean,
  ) => void;
}

export type FruitKind = 'coconut' | 'mango' | 'banana' | 'papaya';

export interface FruitSpec {
  kind: FruitKind;
  nameEn: string;
  nameVi: string;
  color: string;
  vocabPhraseEn: string;
  vocabPhraseVi: string;
}

export type FruitHarvestLog = Record<FruitKind, number>;

export type ArenaVesselKind =
  | 'skiff'
  | 'sampan'
  | 'pelagic'
  | 'tern'
  | 'cruiser'
  | 'trawler'
  | 'sailboat';

export interface MinimapBoatMarker {
  id: string;
  kind: ArenaVesselKind;
  x: number;
  z: number;
  yaw: number;
  occupied: boolean;
  usable: boolean;
}

export interface MinimapPeerMarker {
  id: string;
  name: string;
  x: number;
  z: number;
  yaw: number;
  speaking: boolean;
}

export interface MinimapWaypoint {
  x: number;
  z: number;
  labelEn: string;
  labelVi: string;
}

export interface MinimapSnapshot {
  selfX: number;
  selfZ: number;
  selfYaw: number;
  cameraYaw: number;
  swimMode: ArenaWaterMode;
  activeIslandId: string | null;
  waypoint: MinimapWaypoint | null;
  peers: readonly MinimapPeerMarker[];
  boats: readonly MinimapBoatMarker[];
  fishSchools?: readonly SurfaceFishSchool[];
}

export type ArenaPhotoPose = 'stand' | 'wave' | 'cheer' | 'think' | 'peace';
export type ArenaPhotoExpression = 'neutral' | 'smile' | 'joy' | 'focused' | 'surprised';
export type ArenaPhotoFilterId =
  | 'natural'
  | 'golden_film'
  | 'cool_editorial'
  | 'noir'
  | 'soft_pastel'
  | 'cinema';

export interface ArenaPhotoState {
  open: boolean;
  pose: ArenaPhotoPose;
  expression: ArenaPhotoExpression;
  filterId: ArenaPhotoFilterId;
  cssFilter: string;
  fov: number;
  timeFrozen: boolean;
  controlsHidden: boolean;
}

export type ArenaSpeakingCategory =
  | 'scenery'
  | 'travel'
  | 'food_market'
  | 'directions'
  | 'marine'
  | 'weather_nature'
  | 'daily'
  | 'storytelling'
  | 'ielts_part1'
  | 'ielts_part2'
  | 'ielts_part3'
  | 'discussion';

export interface ArenaRuntimeTelemetry {
  tier: ArenaQualityTier;
  fps: number;
  onePercentLowFps: number;
  frameTimeP50Ms: number;
  frameTimeP95Ms: number;
  frameTimeP99Ms: number;
  draws: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  shaderWarmupMs: number;
  longTasksCount: number;
  longTasksTotalMs: number;
  activeIslandChunks: number;
  warmIslandChunks: number;
  spikeCounts: Record<string, number>;
}
