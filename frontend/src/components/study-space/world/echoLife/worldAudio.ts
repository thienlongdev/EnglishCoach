/**
 * Echo Life AAA Spatial Environmental, Room Acoustics & Foley Audio Engine.
 *
 * 100% browser-native Web Audio API synthesis (zero external audio files, zero network calls, zero AI).
 * Unlocks cleanly on the first user gesture, auto-rearms gesture unlock if the browser suspends the
 * shared AudioContext, routes Study Space contactAudio through the unified foley/reverb bus, degrades
 * silently in headless CI or minimal AudioContext mocks, and exposes 4 persisted mixer channels plus
 * instant mute with smooth exponential parameter ramps (zero zipper noise or buffer-swap clicks).
 *
 * Subsystems:
 *  1. True 3D AudioListener orientation/position sync + pooled HRTF PannerNode allocator (hard cap 8:
 *     4 persistent spatial emitters [river_bank, fountain_water, venue_feature/commuter Doppler,
 *     doorway_bleed] + 4 priority-evicted one-shot spatial slots), with StereoPannerNode fallback.
 *  2. Dual-ConvolverNode 450 ms click-free crossfade across 5 deterministic procedural stereo IR
 *     acoustics presets (outdoor_open, library_hall, cafe_intimate, bath_tile, home_cozy), skipped
 *     automatically on low quality tier or when createConvolver is unavailable.
 *  3. Continuous indoor/outdoor occlusion LPF + directional doorway/window bleed coupling.
 *  4. 8-surface heel-to-toe footsteps (grass, asphalt, paver, brick, wood, tile, carpet, snow) +
 *     wet puddle spray + jump landing compression.
 *  5. Gust-modulated wind & foliage, daytime canopy birdsong (4 motifs), summer cicadas, night
 *     crickets, fountain trickle, occupancy-scaled Cafe/Bistro murmur, and commuter Doppler pass-by.
 *  6. Vehicles 2.0 full telemetry audio: per-class propulsion (micro/sedan/spider/hyper/motorbike),
 *     wet-road spray, dual-band drift tire screech, quadratic aerodynamic wind rush (-6 dB cockpit),
 *     automatic blinker relay clicks, suspension bump thuds, and car door latch/slam.
 *  7. Deterministic non-verbal resident speech prosody (<= 0.018 peak), spatial doors, basketball
 *     court foley, seating, shop register, and 7 interactive career/hobby activity foley triggers.
 */
import {
  contactAudioContext,
  getContactAudioSink,
  setContactAudioSink,
} from '@/lib/embodiment/contactAudio';

export type FootSurface = 'grass' | 'asphalt' | 'paver' | 'brick' | 'wood' | 'tile' | 'carpet' | 'snow';
export type BasketballSfx = 'bounce' | 'rim' | 'backboard' | 'swish' | 'shoot' | 'catch';
export type UiClickKind = 'tap' | 'open' | 'close' | 'confirm';
export type VehicleAudioKind = 'none' | 'car' | 'bike' | 'motorbike';
export type VehicleCarClass = 'micro' | 'sedan' | 'spider' | 'hyper';
export type VehicleCameraMode = 'chase' | 'hood' | 'cockpit';
export type AudioQualityTier = 'low' | 'balanced' | 'high' | 'ultra';
export type RoomAcousticPreset = 'outdoor_open' | 'library_hall' | 'cafe_intimate' | 'bath_tile' | 'home_cozy';
export type ActivityFoleyKind =
  | 'espresso'
  | 'tea_pour'
  | 'book_page'
  | 'garden_water'
  | 'guitar_chord'
  | 'shutter'
  | 'shift_complete';

export interface WorldVec3 {
  x: number;
  y?: number;
  z: number;
}

export interface WorldAudioMixer {
  muted: boolean;
  /** Master output gain 0..1 */
  master: number;
  /** Environment, room acoustics & ambience (wind, birds, cicadas, crickets, river, fountain, rain, cafe) 0..1 */
  ambience: number;
  /** Footsteps, landings, wooden doors, basketball, seating, speech prosody, activity & contact foley 0..1 */
  foley: number;
  /** EV/moto motor, tire/drift, aero wind, bicycle whirr/clicks, horn/bell, blinker, UI glass clicks 0..1 */
  vehiclesUi: number;
}

export interface RiverRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface WorldAudioFrameState {
  dt: number;
  /** True while actively exploring Echo Life; false pauses continuous ambient & vehicle beds. */
  active: boolean;
  /** Stage-local body position in metres. */
  pos: WorldVec3 | null;
  /** Camera look yaw in radians (Exploration.lookYaw: forward = (-sin yaw, -cos yaw)). */
  cameraYaw: number;
  /** Optional camera look pitch in radians for 3D AudioListener elevation orientation. */
  cameraPitch?: number;
  /** Optional explicit normalized 3D listener forward vector (overrides yaw/pitch derivation). */
  listenerForward?: WorldVec3 | null;
  /** Optional explicit normalized 3D listener up vector (defaults to (0, 1, 0)). */
  listenerUp?: WorldVec3 | null;
  /** LifeWalk surface region ('park', 'road', 'sidewalk', 'brick', 'study', 'cafe', ...). */
  region: string | null;
  /** Canonical V3 zone id ('park', 'botanical', 'cafe', 'bistro', 'street', 'fountain_plaza', ...). */
  zone: string | null;
  /** True inside study room, house, or any enterable city building. */
  indoor: boolean;
  /** True when study room casement window is open (partial acoustic coupling outdoors). */
  windowOpen?: boolean;
  /** True when a nearby exterior doorway is open. */
  doorOpen?: boolean;
  /** Continuous exterior doorway acoustic coupling factor in [0, 1] (0 = closed/far, 1 = standing in open doorway). */
  openDoorCoupling?: number;
  /** World coordinate of the nearest open exterior door or window for directional outdoor bleed. */
  openPortalPos?: WorldVec3 | null;
  /** Explicit room acoustic preset override (otherwise resolved from indoor, zone, region). */
  roomAcousticType?: RoomAcousticPreset;
  /** Game clock hour 0..24. */
  hour: number;
  /** Season index: 0 = spring, 1 = summer, 2 = autumn, 3 = winter. */
  season?: number;
  /** Precipitation intensity 0..1. */
  rain: number;
  /** Snow intensity 0..1. */
  snow?: number;
  /** Cloud cover / gust intensity proxy 0..1. */
  cloud?: number;
  /** Optional explicit wind override 0..1; defaults from rain/snow/cloud. */
  wind?: number;
  /** Active resident count in the current indoor venue (scales cafe/bistro murmur). */
  residentsInZone?: number;
  /** River water bounds for HRTF / stereo spatial attenuation. */
  riverRect: RiverRect | null;
  /** Optional fountain world position (fountain_plaza) for 3D cascading trickle. */
  fountainPos?: WorldVec3 | null;
  /** Optional nearest passing commuter vehicle position for Doppler pass-by synthesis. */
  commuterPos?: WorldVec3 | null;
  /** Active graphics/CPU quality tier; 'low' skips wet ConvolverNode processing. */
  qualityTier?: AudioQualityTier;
  /** Driven vehicle telemetry for continuous propulsion, tire/drift, aero wind, blinker & bump synthesis. */
  vehicle?: {
    kind: VehicleAudioKind;
    carClass?: VehicleCarClass;
    speed: number;
    throttle?: number;
    braking?: boolean;
    driftIntensity?: number;
    heaveVel?: number;
    coasting?: boolean;
    blinkerLit?: boolean;
    cameraMode?: VehicleCameraMode;
    doorOpen?: boolean;
  } | null;
}

export const AUDIO_STORAGE_KEY = 'ec_echo_life_audio:v1';

export const DEFAULT_WORLD_AUDIO_MIXER: Readonly<WorldAudioMixer> = Object.freeze({
  muted: false,
  master: 0.72,
  ambience: 0.75,
  foley: 0.80,
  vehiclesUi: 0.75,
});

const GREEN_ZONES = new Set(['park', 'botanical', 'greenway', 'yard', 'campus', 'teahouse', 'fountain_plaza', 'lantern_garden']);
const BIRD_ZONES = new Set(['park', 'botanical', 'greenway', 'yard', 'campus', 'teahouse', 'street', 'fountain_plaza', 'lantern_garden']);
const URBAN_ZONES = new Set(['street', 'market', 'electronics_shop', 'furniture_shop', 'clothing_shop', 'vehicle_dealer', 'home_center', 'repair_shop', 'fair']);
const CAFE_ZONES = new Set(['cafe', 'bistro', 'teahouse']);
const TILE_REGIONS = new Set(['kitchen', 'bath', 'lobby', 'lobbyFoot', 'garage', 'market', 'cafe', 'bistro', 'electronics_shop', 'clothing_shop', 'home_center', 'repair_shop', 'vehicle_dealer']);
const WOOD_REGIONS = new Set(['study', 'hall', 'living', 'bedroom', 'gaming_room', 'stair', 'arch', 'library', 'furniture_shop', 'teahouse', 'atelier', 'linh', 'minh']);
const OUTDOOR_REGIONS = new Set(['park', 'garden', 'road', 'crossing', 'sidewalk', 'plaza', 'balcony', 'brick', 'cobble', 'yard', 'street', 'campus', 'fair', 'greenway', 'botanical', 'lantern_garden', 'fountain_plaza']);
const OUTDOOR_ZONES = new Set(['park', 'botanical', 'greenway', 'yard', 'street', 'campus', 'fair', 'fountain_plaza', 'lantern_garden']);
const BATH_TILE_ZONES = new Set(['bath', 'kitchen', 'garage', 'repair_shop', 'vehicle_dealer', 'electronics_shop', 'home_center', 'lobby', 'lobbyFoot']);
const CAFE_INTIMATE_ZONES = new Set(['bistro', 'cafe', 'teahouse', 'atelier', 'furniture_shop', 'clothing_shop', 'market']);

type WetAcousticPreset = Exclude<RoomAcousticPreset, 'outdoor_open'>;

interface IrPresetSpec {
  rt60: number;
  lpfHz: number;
  hpfHz: number;
  wet: number;
  seed: number;
  taps: ReadonlyArray<readonly [ms: number, gainL: number, gainR: number]>;
}

const IR_PRESETS: Readonly<Record<WetAcousticPreset, IrPresetSpec>> = {
  library_hall: {
    rt60: 1.45,
    lpfHz: 2800,
    hpfHz: 0,
    wet: 0.28,
    seed: 0x1a7b3c91,
    taps: [
      [16, 0.58, 0.34],
      [24, 0.30, 0.54],
      [33, 0.44, 0.28],
      [41, 0.25, 0.42],
      [49, 0.34, 0.22],
      [58, 0.20, 0.30],
    ],
  },
  cafe_intimate: {
    rt60: 0.72,
    lpfHz: 3600,
    hpfHz: 0,
    wet: 0.18,
    seed: 0x2c4e8a15,
    taps: [
      [9, 0.56, 0.36],
      [15, 0.32, 0.52],
      [21, 0.42, 0.26],
      [27, 0.24, 0.38],
      [34, 0.28, 0.20],
    ],
  },
  bath_tile: {
    rt60: 0.95,
    lpfHz: 6800,
    hpfHz: 260,
    wet: 0.30,
    seed: 0x3f91b42d,
    taps: [
      [5, 0.68, 0.44],
      [8, 0.42, 0.66],
      [11, 0.58, 0.36],
      [14, 0.36, 0.56],
      [17, 0.48, 0.30],
      [20, 0.30, 0.46],
      [23, 0.38, 0.26],
      [26, 0.24, 0.34],
    ],
  },
  home_cozy: {
    rt60: 0.42,
    lpfHz: 2100,
    hpfHz: 0,
    wet: 0.12,
    seed: 0x4d17e5c3,
    taps: [
      [7, 0.48, 0.32],
      [12, 0.28, 0.44],
      [17, 0.34, 0.22],
      [22, 0.20, 0.28],
    ],
  },
};

const VALID_ACOUSTIC_PRESETS = new Set<RoomAcousticPreset>([
  'outdoor_open',
  'library_hall',
  'cafe_intimate',
  'bath_tile',
  'home_cozy',
]);

const MAX_FOLEY_VOICES = 8;
const ONE_SHOT_HRTF_SLOTS = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function normalizeMixer(
  raw: Partial<WorldAudioMixer> | null | undefined,
  base: WorldAudioMixer = DEFAULT_WORLD_AUDIO_MIXER,
): WorldAudioMixer {
  if (!raw || typeof raw !== 'object') return { ...base };
  return {
    muted: typeof raw.muted === 'boolean' ? raw.muted : base.muted,
    master: typeof raw.master === 'number' ? clamp(raw.master, 0, 1) : base.master,
    ambience: typeof raw.ambience === 'number' ? clamp(raw.ambience, 0, 1) : base.ambience,
    foley: typeof raw.foley === 'number' ? clamp(raw.foley, 0, 1) : base.foley,
    vehiclesUi: typeof raw.vehiclesUi === 'number' ? clamp(raw.vehiclesUi, 0, 1) : base.vehiclesUi,
  };
}

/** Perceptual quadratic-blended mixer gains; instant 0 across all buses when muted. */
export function computeChannelGains(mixer: WorldAudioMixer): {
  master: number;
  ambience: number;
  foley: number;
  vehiclesUi: number;
} {
  if (mixer.muted) return { master: 0, ambience: 0, foley: 0, vehiclesUi: 0 };
  const curve = (v: number) => {
    const c = clamp(v, 0, 1);
    return c * (0.35 + 0.65 * c);
  };
  return {
    master: curve(mixer.master),
    ambience: curve(mixer.ambience),
    foley: curve(mixer.foley),
    vehiclesUi: curve(mixer.vehiclesUi),
  };
}

/**
 * Continuous acoustic indoor/outdoor low-pass cutoff and gain attenuation curve.
 * Two-argument calls preserve exact closed/open-window values (20000/1.0, 2400/0.44, 480/0.22);
 * optional `openDoorCoupling` in (0, 1] smoothly interpolates logarithmically toward 7200 Hz / 0.76.
 */
export function computeOutdoorOcclusion(
  indoor: boolean,
  windowOpen: boolean,
  openDoorCoupling = 0,
): { cutoffHz: number; gain: number } {
  if (!indoor) return { cutoffHz: 20000, gain: 1.0 };
  const baseCutoff = windowOpen ? 2400 : 480;
  const baseGain = windowOpen ? 0.44 : 0.22;
  const c = clamp(openDoorCoupling, 0, 1);
  if (c <= 0.001) return { cutoffHz: baseCutoff, gain: baseGain };
  const cutoffHz = Math.round(baseCutoff * Math.pow(7200 / baseCutoff, c));
  const gain = baseGain + (0.76 - baseGain) * c;
  return { cutoffHz, gain };
}

/** Resolves the room acoustic convolution preset from indoor state, canonical zone, surface region, or explicit override. */
export function resolveAcousticPreset(
  indoor: boolean,
  zone: string | null | undefined,
  region: string | null | undefined,
  override?: RoomAcousticPreset,
): RoomAcousticPreset {
  if (override && VALID_ACOUSTIC_PRESETS.has(override)) return override;
  if (!indoor) return 'outdoor_open';
  const z = zone ?? '';
  const r = region ?? '';
  if (z === 'library' || r === 'library') return 'library_hall';
  if (BATH_TILE_ZONES.has(r) || BATH_TILE_ZONES.has(z)) return 'bath_tile';
  if (CAFE_INTIMATE_ZONES.has(z) || CAFE_INTIMATE_ZONES.has(r)) return 'cafe_intimate';
  return 'home_cozy';
}

/**
 * Maps LifeWalk surface region, zone, study rug, study floor finish, and outdoor snow cover
 * onto the 8 footstep acoustics profiles.
 */
export function classifyFootSurface(
  region: string | null | undefined,
  zone: string | null | undefined,
  onRug = false,
  studyFloorStyle?: string | null,
  snow = 0,
): FootSurface {
  if (onRug) return 'carpet';
  const r = region ?? '';
  const z = zone ?? '';

  if (snow > 0.15) {
    const isOutdoor = r
      ? OUTDOOR_REGIONS.has(r) && !TILE_REGIONS.has(r) && !WOOD_REGIONS.has(r) && !r.startsWith('door:') && !r.startsWith('prop_')
      : OUTDOOR_ZONES.has(z);
    if (isOutdoor) return 'snow';
  }

  if (r === 'park' || r === 'garden') return 'grass';
  if (r === 'road' || r === 'crossing') return 'asphalt';
  if (r === 'brick' || r === 'cobble') return 'brick';
  if (r === 'sidewalk' || r === 'plaza' || r === 'balcony') return 'paver';
  if (r === 'study') {
    if (studyFloorStyle === 'carpet') return 'carpet';
    if (studyFloorStyle === 'tile' || studyFloorStyle === 'marble' || studyFloorStyle === 'metal') return 'tile';
    return 'wood';
  }
  if (r.startsWith('door:')) return z === 'street' ? 'paver' : 'wood';
  if (TILE_REGIONS.has(r) || TILE_REGIONS.has(z)) return 'tile';
  if (WOOD_REGIONS.has(r) || WOOD_REGIONS.has(z) || r.startsWith('prop_')) return 'wood';
  if (z === 'park' || z === 'botanical' || z === 'greenway' || z === 'yard') return 'grass';
  if (z === 'street' || z === 'campus' || z === 'fair' || z === 'fountain_plaza') return 'paver';
  return 'wood';
}

/**
 * Computes birdsong activity density in [0, 1].
 * Active strictly during daytime (05:30-17:30, dawn peak 06:00-10:30), clear/cloudy weather (rain < 0.25, snow < 0.25),
 * and outdoors (or open window) in/near green zones. Strictly 0 at night and during heavy rain.
 */
export function birdsongDensity(
  hour: number,
  rain: number,
  snow: number,
  indoor: boolean,
  windowOpen: boolean,
  zone: string | null | undefined,
): number {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5.5 || h > 17.5) return 0;
  if (rain >= 0.25 || snow >= 0.25) return 0;
  if (indoor && !windowOpen) return 0;
  const z = zone ?? '';
  if (z && !BIRD_ZONES.has(z)) return 0;
  const dawnPeak = h <= 10.5 ? 0.55 + 0.45 * Math.sin(((h - 5.5) / 5.0) * Math.PI) : 0.55 * (1 - (h - 10.5) / 7.5);
  const weatherAtten = (1 - rain / 0.25) * (1 - snow / 0.25);
  const greenBoost = GREEN_ZONES.has(z) ? 1.0 : 0.45;
  const indoorScale = indoor ? 0.35 : 1.0;
  return clamp(dawnPeak * weatherAtten * greenBoost * indoorScale, 0, 1);
}

/**
 * Computes summer cicada chorus density in [0, 1].
 * Active during summer (season === 1), warm midday/afternoon (11:00-18:30), dry weather, green zones.
 */
export function cicadaDensity(
  hour: number,
  season: number | undefined,
  rain: number,
  snow: number,
  indoor: boolean,
  windowOpen: boolean,
  zone: string | null | undefined,
): number {
  if (season !== 1) return 0;
  const h = ((hour % 24) + 24) % 24;
  if (h < 11.0 || h > 18.5) return 0;
  if (rain >= 0.18 || snow >= 0.1) return 0;
  if (indoor && !windowOpen) return 0;
  const z = zone ?? '';
  if (!GREEN_ZONES.has(z)) return 0;
  const heatArc = Math.sin(((h - 11.0) / 7.5) * Math.PI);
  const weatherAtten = 1 - rain / 0.18;
  const indoorScale = indoor ? 0.35 : 1.0;
  return clamp(heatArc * weatherAtten * indoorScale, 0, 1);
}

/**
 * Computes evening/night cricket chorus density in [0, 1].
 * Active from 19:30 to 04:30 outside winter (season !== 3), dry weather, green zones.
 */
export function cricketDensity(
  hour: number,
  season: number | undefined,
  rain: number,
  snow: number,
  indoor: boolean,
  windowOpen: boolean,
  zone: string | null | undefined,
): number {
  if (season === 3) return 0;
  const h = ((hour % 24) + 24) % 24;
  const isNight = h >= 19.5 || h <= 4.5;
  if (!isNight) return 0;
  if (rain >= 0.18 || snow >= 0.1) return 0;
  if (indoor && !windowOpen) return 0;
  const z = zone ?? '';
  if (!GREEN_ZONES.has(z)) return 0;
  const edgeFade = h >= 19.5 && h < 20.5 ? h - 19.5 : h > 3.5 && h <= 4.5 ? 4.5 - h : 1.0;
  const weatherAtten = 1 - rain / 0.18;
  const indoorScale = indoor ? 0.32 : 1.0;
  return clamp(edgeFade * weatherAtten * indoorScale, 0, 1);
}

/**
 * Distance-attenuated, head-relative stereo panning toward the nearest point on the Riverside river bank.
 * Uses Exploration's right vector R = (cos yaw, -sin yaw), matching forward = (-sin yaw, -cos yaw).
 */
export function computeRiverSpatial(
  pos: { x: number; z: number } | null | undefined,
  cameraYaw: number,
  riverRect: RiverRect | null | undefined,
): { distance: number; gain: number; pan: number } {
  if (!pos || !riverRect) return { distance: Infinity, gain: 0, pan: 0 };
  const nearestX = clamp(pos.x, riverRect.x0, riverRect.x1);
  const nearestZ = clamp(pos.z, riverRect.z0, riverRect.z1);
  const dx = nearestX - pos.x;
  const dz = nearestZ - pos.z;
  const distance = Math.hypot(dx, dz);
  if (distance > 55) return { distance, gain: 0, pan: 0 };
  const gain = clamp(1 / (1 + Math.pow(distance / 10, 1.8)), 0, 1);
  if (distance < 0.05) return { distance, gain, pan: 0 };
  const dirX = dx / distance;
  const dirZ = dz / distance;
  const rightX = Math.cos(cameraYaw);
  const rightZ = -Math.sin(cameraYaw);
  const pan = clamp((rightX * dirX + rightZ * dirZ) * 0.85, -0.85, 0.85);
  return { distance, gain, pan };
}

function readPersistedMixer(): WorldAudioMixer {
  if (typeof window === 'undefined') return { ...DEFAULT_WORLD_AUDIO_MIXER };
  try {
    const raw = window.localStorage.getItem(AUDIO_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WORLD_AUDIO_MIXER };
    return normalizeMixer(JSON.parse(raw) as Partial<WorldAudioMixer>);
  } catch {
    return { ...DEFAULT_WORLD_AUDIO_MIXER };
  }
}

function writePersistedMixer(mixer: WorldAudioMixer) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(mixer));
  } catch {
    /* private mode or storage denied */
  }
}

/** Creates a seamless loopable AudioBuffer by equal-power crossfading tail into head over `fadeSec`. */
function crossfadeSeamless(samples: Float32Array, sampleRate: number, fadeSec = 0.15) {
  const fade = Math.min(Math.floor(sampleRate * fadeSec), Math.floor(samples.length / 4));
  if (fade <= 1) return;
  const tailStart = samples.length - fade;
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const wHead = Math.sin(t * Math.PI * 0.5);
    const wTail = Math.cos(t * Math.PI * 0.5);
    samples[i] = samples[i] * wHead + samples[tailStart + i] * wTail;
  }
}

function createNoiseBuffers(ctx: AudioContext): { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer } {
  const sr = ctx.sampleRate;
  const len = Math.max(sr * 4, 4096);
  const white = ctx.createBuffer(1, len, sr);
  const pink = ctx.createBuffer(1, len, sr);
  const brown = ctx.createBuffer(1, len, sr);
  const wd = white.getChannelData(0);
  const pd = pink.getChannelData(0);
  const bd = brown.getChannelData(0);

  // Deterministic LCG seed so noise spectrum is consistent and glitch-free across sessions
  let seed = 0x51a7c3d1;
  const nextRand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };

  // Paul Kellet 7-pole pink noise filter + leaky brown integrator
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let lastBrown = 0;
  for (let i = 0; i < len; i++) {
    const w = nextRand();
    wd[i] = w;

    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const p = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    pd[i] = clamp(p, -1, 1);

    lastBrown = (lastBrown + 0.02 * w) / 1.02;
    bd[i] = clamp(lastBrown * 3.4, -1, 1);
  }

  crossfadeSeamless(wd, sr);
  crossfadeSeamless(pd, sr);
  crossfadeSeamless(bd, sr);
  return { white, pink, brown };
}

/** Synthesizes one deterministic stereo room impulse response AudioBuffer (early reflections + damped RT60 tail). */
function synthesizeImpulseResponse(ctx: AudioContext, spec: IrPresetSpec): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(64, Math.floor(sr * spec.rt60));
  const buf = ctx.createBuffer(2, len, sr);
  const chL = buf.getChannelData(0);
  const chR = buf.getChannelData(1);

  let seed = spec.seed >>> 0;
  const nextRand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };

  // Early reflections with gentle 3-sample anti-ringing window
  for (const [ms, gL, gR] of spec.taps) {
    const idx = Math.floor((ms / 1000) * sr);
    if (idx > 0 && idx + 1 < len) {
      chL[idx - 1] += gL * 0.25;
      chL[idx] += gL * 0.55;
      chL[idx + 1] += gL * 0.20;
      chR[idx - 1] += gR * 0.25;
      chR[idx] += gR * 0.55;
      chR[idx + 1] += gR * 0.20;
    }
  }

  // Diffuse exponentially decaying stereo tail with one-pole LPF (+ optional HPF for bright tile rooms)
  const lpAlpha = clamp(1 - Math.exp((-2 * Math.PI * spec.lpfHz) / sr), 0.01, 1.0);
  const hasHpf = spec.hpfHz > 0;
  const hpAlpha = hasHpf ? Math.exp((-2 * Math.PI * spec.hpfHz) / sr) : 0;
  const decayPerSample = Math.pow(0.001, 1 / len);
  const onsetSamples = Math.max(1, Math.floor(sr * 0.008));

  let env = 1.0;
  let lpL = 0, lpR = 0;
  let hpPrevInL = 0, hpPrevOutL = 0;
  let hpPrevInR = 0, hpPrevOutR = 0;
  let energySum = 0;

  for (let i = 0; i < len; i++) {
    const onset = i < onsetSamples ? i / onsetSamples : 1.0;
    const rawL = nextRand();
    const rawR = nextRand();
    lpL += lpAlpha * (rawL - lpL);
    lpR += lpAlpha * (rawR - lpR);

    let sL = lpL;
    let sR = lpR;
    if (hasHpf) {
      const outL = hpAlpha * (hpPrevOutL + sL - hpPrevInL);
      hpPrevInL = sL;
      hpPrevOutL = outL;
      sL = outL;

      const outR = hpAlpha * (hpPrevOutR + sR - hpPrevInR);
      hpPrevInR = sR;
      hpPrevOutR = outR;
      sR = outR;
    }

    const tailScale = 0.28 * onset * env;
    chL[i] += sL * tailScale;
    chR[i] += sR * tailScale;
    energySum += chL[i] * chL[i] + chR[i] * chR[i];
    env *= decayPerSample;
  }

  // Energy-normalize so ConvolverNode output stays consistent across RT60 lengths
  const rms = Math.sqrt(energySum / (2 * len));
  const targetRms = 0.095;
  const norm = rms > 1e-6 ? Math.min(2.4, targetRms / rms) : 1.0;
  for (let i = 0; i < len; i++) {
    chL[i] = clamp(chL[i] * norm, -1, 1);
    chR[i] = clamp(chR[i] * norm, -1, 1);
  }
  return buf;
}

function createAllImpulseResponses(ctx: AudioContext): Record<WetAcousticPreset, AudioBuffer> {
  return {
    library_hall: synthesizeImpulseResponse(ctx, IR_PRESETS.library_hall),
    cafe_intimate: synthesizeImpulseResponse(ctx, IR_PRESETS.cafe_intimate),
    bath_tile: synthesizeImpulseResponse(ctx, IR_PRESETS.bath_tile),
    home_cozy: synthesizeImpulseResponse(ctx, IR_PRESETS.home_cozy),
  };
}

function setPannerPosition(
  panner: PannerNode,
  x: number,
  y: number,
  z: number,
  now: number,
  smoothTau = 0,
) {
  if (panner.positionX && typeof panner.positionX.setTargetAtTime === 'function') {
    if (smoothTau > 0) {
      panner.positionX.setTargetAtTime(x, now, smoothTau);
      panner.positionY.setTargetAtTime(y, now, smoothTau);
      panner.positionZ.setTargetAtTime(z, now, smoothTau);
    } else {
      panner.positionX.setValueAtTime(x, now);
      panner.positionY.setValueAtTime(y, now);
      panner.positionZ.setValueAtTime(z, now);
    }
  } else if (typeof panner.setPosition === 'function') {
    panner.setPosition(x, y, z);
  }
}

function configureHrtfPanner(
  ctx: AudioContext,
  refDistance: number,
  maxDistance: number,
  rolloffFactor: number,
): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  p.refDistance = refDistance;
  p.maxDistance = maxDistance;
  p.rolloffFactor = rolloffFactor;
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  p.coneOuterGain = 0;
  return p;
}

interface LoopVoice {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner?: StereoPannerNode;
}

interface OneShotHrtfSlot {
  panner: PannerNode;
  connectedBus: AudioNode | null;
  busyUntil: number;
  distance: number;
  priority: number;
}

interface SpatialRoute {
  dest: AudioNode;
  atten: number;
  transientPanner?: StereoPannerNode;
}

interface VehicleGraph {
  motorOscA: OscillatorNode;
  motorOscB: OscillatorNode;
  motorSubGain: GainNode;
  motorFilter: BiquadFilterNode;
  motorGain: GainNode;
  tireSrc: AudioBufferSourceNode;
  tireFilter: BiquadFilterNode;
  tireGain: GainNode;
  brakeSrc: AudioBufferSourceNode;
  brakeFilter: BiquadFilterNode;
  brakeGain: GainNode;
  driftSrcA: AudioBufferSourceNode;
  driftFilterA: BiquadFilterNode;
  driftSrcB: AudioBufferSourceNode;
  driftFilterB: BiquadFilterNode;
  driftGain: GainNode;
  aeroSrc: AudioBufferSourceNode;
  aeroFilter: BiquadFilterNode;
  aeroGain: GainNode;
}

/**
 * Spatial Environmental, Room Acoustics & Foley Soundscape Engine for Echo Life.
 * Safe to instantiate in Node/SSR/headless browsers -- zero Web Audio calls occur before a real user gesture.
 */
export class EchoLifeWorldAudio {
  private mixer: WorldAudioMixer;
  private readonly listeners = new Set<() => void>();
  private ctx: AudioContext | null = null;
  private buffers: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer } | null = null;
  private irBuffers: Record<WetAcousticPreset, AudioBuffer> | null = null;

  // Core mixer buses (masterGain MUST remain the first GainNode created in ensureGraph)
  private masterGain: GainNode | null = null;
  private ambienceGain: GainNode | null = null;
  private foleyGain: GainNode | null = null;
  private vehiclesUiGain: GainNode | null = null;
  private outdoorLpf: BiquadFilterNode | null = null;
  private outdoorGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;

  // Dual-ConvolverNode 450 ms click-free crossfade room acoustics
  private reverbSend: GainNode | null = null;
  private convA: ConvolverNode | null = null;
  private wetA: GainNode | null = null;
  private convB: ConvolverNode | null = null;
  private wetB: GainNode | null = null;
  private activeConvolver: 'A' | 'B' = 'A';
  private activePreset: RoomAcousticPreset = 'outdoor_open';
  private wetSuspended = false;

  // Pooled HRTF PannerNodes (hard cap 8 total: 4 persistent + 4 one-shot)
  private hrtfSupported = false;
  private riverPanner: PannerNode | null = null;
  private fountainPanner: PannerNode | null = null;
  private venueFeaturePanner: PannerNode | null = null;
  private doorwayBleedPanner: PannerNode | null = null;
  private oneShotPool: OneShotHrtfSlot[] = [];

  // Continuous environmental bed voices
  private windAir: LoopVoice | null = null;
  private windFoliage: LoopVoice | null = null;
  private riverLow: LoopVoice | null = null;
  private riverHigh: LoopVoice | null = null;
  private rainBody: LoopVoice | null = null;
  private rainHiss: LoopVoice | null = null;
  private urbanHum: LoopVoice | null = null;
  private cicadaChorus: LoopVoice | null = null;
  private fountainLow: LoopVoice | null = null;
  private fountainMist: LoopVoice | null = null;
  private commuterVoice: LoopVoice | null = null;
  private doorwayBleed: LoopVoice | null = null;
  private roomTone: LoopVoice | null = null;
  private cafeFormantA: LoopVoice | null = null;
  private cafeFormantB: LoopVoice | null = null;
  private vehicleGraph: VehicleGraph | null = null;

  // Runtime state & tracking
  private graphReady = false;
  private disposed = false;
  private suspended = false;
  private gestureBound = false;
  private elapsed = 0;
  private foleyVoices = 0;
  private readonly foleyTimers = new Set<ReturnType<typeof setTimeout>>();
  private footSide = 1;
  private birdCooldown = 1.6;
  private cricketCooldown = 2.2;
  private dropletAccum = 0;
  private clinkCooldown = 7.5;
  private freewheelAccum = 0;
  private listenerPos: { x: number; y: number; z: number } | null = null;
  private listenerYaw = 0;
  private prevBlinkerLit = false;
  private bumpCooldown = 0;
  private prevCommuterDist: number | null = null;
  private lastMotorOscAType: OscillatorType = 'sine';
  private lastMotorOscBType: OscillatorType = 'triangle';
  // 15 Hz AudioParam scheduler + per-slot epsilon guard (plain null-proto object for zero-dep VM parity).
  private paramSchedAccum = 1 / 15;
  private paramForceFlush = true;
  private lastDiscreteSig = '';
  private paramCache: Record<string, number> = Object.create(null);

  private resetParamCache() {
    this.paramCache = Object.create(null);
    this.paramForceFlush = true;
    this.paramSchedAccum = 1 / 15;
  }

  private setParamGuarded(
    slot: string,
    param: AudioParam | undefined | null,
    target: number,
    now: number,
    tau: number,
    eps: number,
  ): void {
    if (!param || typeof param.setTargetAtTime !== 'function') return;
    const prev = this.paramCache[slot];
    if (prev !== undefined) {
      if (target === 0 && prev === 0) return;
      if (target !== 0 && Math.abs(target - prev) <= eps) return;
    }
    this.paramCache[slot] = target;
    param.setTargetAtTime(target, now, tau);
  }

  private setPannerGuarded(
    slot: string,
    panner: PannerNode | null,
    x: number,
    y: number,
    z: number,
    now: number,
    tau: number,
    eps = 0.02,
  ): void {
    if (!panner) return;
    const kx = slot + ':x';
    const ky = slot + ':y';
    const kz = slot + ':z';
    const px = this.paramCache[kx];
    const py = this.paramCache[ky];
    const pz = this.paramCache[kz];
    if (
      px !== undefined &&
      py !== undefined &&
      pz !== undefined &&
      Math.abs(x - px) <= eps &&
      Math.abs(y - py) <= eps &&
      Math.abs(z - pz) <= eps
    ) {
      return;
    }
    this.paramCache[kx] = x;
    this.paramCache[ky] = y;
    this.paramCache[kz] = z;
    setPannerPosition(panner, x, y, z, now, tau);
  }

  constructor(initialMixer?: Partial<WorldAudioMixer>) {
    this.mixer = initialMixer ? normalizeMixer(initialMixer, readPersistedMixer()) : readPersistedMixer();
    this.bindGestureUnlock();
  }

  /** Stable snapshot reference for React `useSyncExternalStore`. */
  getMixer = (): WorldAudioMixer => this.mixer;

  /** Active room convolution preset for diagnostics and testing. */
  getActiveAcousticPreset(): RoomAcousticPreset {
    return this.activePreset;
  }

  /** Number of allocated HRTF PannerNodes (always <= 8; 0 when stereo fallback is active). */
  getActiveHrtfPannerCount(): number {
    if (!this.hrtfSupported) return 0;
    let count = this.oneShotPool.length;
    if (this.riverPanner) count++;
    if (this.fountainPanner) count++;
    if (this.venueFeaturePanner) count++;
    if (this.doorwayBleedPanner) count++;
    return count;
  }

  setMixer(patch: Partial<WorldAudioMixer>): WorldAudioMixer {
    const next = normalizeMixer(patch, this.mixer);
    if (
      next.muted === this.mixer.muted &&
      next.master === this.mixer.master &&
      next.ambience === this.mixer.ambience &&
      next.foley === this.mixer.foley &&
      next.vehiclesUi === this.mixer.vehiclesUi
    ) {
      return this.mixer;
    }
    this.mixer = Object.freeze(next);
    writePersistedMixer(this.mixer);
    this.applyMixerGains();
    this.listeners.forEach(fn => fn());
    return this.mixer;
  }

  toggleMute(): boolean {
    const next = this.setMixer({ muted: !this.mixer.muted });
    return next.muted;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private bindGestureUnlock() {
    if (this.gestureBound || this.disposed || typeof window === 'undefined') return;
    this.gestureBound = true;
    window.addEventListener('pointerdown', this.onGesture, { passive: true });
    window.addEventListener('keydown', this.onGesture, { passive: true });
  }

  private unbindGestureUnlock() {
    if (!this.gestureBound || typeof window === 'undefined') return;
    this.gestureBound = false;
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
  }

  private onGesture = () => {
    this.unlock();
  };

  /** Idempotent unlock called on first pointer/keyboard interaction or after tab auto-suspend. */
  unlock(): boolean {
    if (this.disposed || typeof window === 'undefined' || typeof document === 'undefined' || document.hidden) return false;
    try {
      if (!this.ctx) {
        const shared = contactAudioContext();
        if (shared) this.ctx = shared;
        else {
          const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!Ctx) return false;
          this.ctx = new Ctx();
        }
      }
      if (this.ctx.state === 'suspended') {
        this.bindGestureUnlock();
        const res = this.ctx.resume();
        if (res && typeof res.then === 'function') {
          void res.then(() => {
            if (!this.disposed && this.ctx?.state === 'running') {
              this.ensureGraph();
              this.unbindGestureUnlock();
            }
          }).catch(() => { /* autoplay blocked */ });
        }
        return false;
      }
      if (this.ctx.state === 'running') {
        this.ensureGraph();
        this.unbindGestureUnlock();
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private runningContext(): AudioContext | null {
    if (this.disposed || this.suspended || this.mixer.muted) return null;
    if (typeof document !== 'undefined' && document.hidden) return null;
    if (!this.ctx) {
      this.bindGestureUnlock();
      return null;
    }
    if (this.ctx.state !== 'running') {
      // Auto-rearm one-shot user gesture listeners if browser suspended the AudioContext
      if (this.ctx.state === 'suspended') {
        this.bindGestureUnlock();
      }
      return null;
    }
    if (!this.graphReady) this.ensureGraph();
    return this.graphReady ? this.ctx : null;
  }

  private makeLoopVoice(
    ctx: AudioContext,
    buffer: AudioBuffer,
    type: BiquadFilterType,
    freq: number,
    q: number,
    dest: AudioNode,
    withStereoPanner = false,
  ): LoopVoice {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;

    let panner: StereoPannerNode | undefined;
    if (withStereoPanner && typeof ctx.createStereoPanner === 'function') {
      panner = ctx.createStereoPanner();
      panner.pan.value = 0;
      src.connect(filter).connect(gain).connect(panner).connect(dest);
    } else {
      src.connect(filter).connect(gain).connect(dest);
    }
    src.start(0, Math.random() * Math.max(0.1, buffer.duration - 0.2));
    return { src, filter, gain, panner };
  }

  private ensureGraph() {
    if (this.graphReady || !this.ctx || this.disposed) return;
    const ctx = this.ctx;
    try {
      this.buffers = createNoiseBuffers(ctx);

      // masterGain MUST remain the very first GainNode created in ensureGraph()
      this.masterGain = ctx.createGain();
      this.ambienceGain = ctx.createGain();
      this.foleyGain = ctx.createGain();
      this.vehiclesUiGain = ctx.createGain();

      // Route Study Space / embodiment contactAudio cleanly through Echo Life's foley/mute/reverb bus
      if (typeof setContactAudioSink === 'function') {
        setContactAudioSink(this.foleyGain);
      }

      // Gentle master dynamics limiter prevents clipping when rain, vehicle, reverb, and foley stack.
      if (typeof ctx.createDynamicsCompressor === 'function') {
        this.limiter = ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -10;
        this.limiter.knee.value = 12;
        this.limiter.ratio.value = 6;
        this.limiter.attack.value = 0.005;
        this.limiter.release.value = 0.14;
        this.masterGain.connect(this.limiter);
        this.limiter.connect(ctx.destination);
      } else {
        this.masterGain.connect(ctx.destination);
      }

      this.ambienceGain.connect(this.masterGain);
      this.foleyGain.connect(this.masterGain);
      this.vehiclesUiGain.connect(this.masterGain);

      // Shared indoor/outdoor acoustic occlusion filter bus (first lowpass at 20000 Hz)
      this.outdoorLpf = ctx.createBiquadFilter();
      this.outdoorLpf.type = 'lowpass';
      this.outdoorLpf.frequency.value = 20000;
      this.outdoorLpf.Q.value = 0.7;
      this.outdoorGain = ctx.createGain();
      this.outdoorGain.gain.value = 1.0;
      this.outdoorLpf.connect(this.outdoorGain).connect(this.ambienceGain);

      // Dual-ConvolverNode procedural room acoustics (ONLY synthesized when createConvolver exists)
      if (typeof ctx.createConvolver === 'function') {
        this.irBuffers = createAllImpulseResponses(ctx);
        this.reverbSend = ctx.createGain();
        this.reverbSend.gain.value = 1.0;
        this.convA = ctx.createConvolver();
        this.convA.normalize = false;
        this.convA.buffer = this.irBuffers.home_cozy;
        this.wetA = ctx.createGain();
        this.wetA.gain.value = 0;

        this.convB = ctx.createConvolver();
        this.convB.normalize = false;
        this.convB.buffer = this.irBuffers.cafe_intimate;
        this.wetB = ctx.createGain();
        this.wetB.gain.value = 0;

        this.foleyGain.connect(this.reverbSend);
        this.reverbSend.connect(this.convA).connect(this.wetA).connect(this.ambienceGain);
        this.reverbSend.connect(this.convB).connect(this.wetB).connect(this.ambienceGain);
        this.activeConvolver = 'A';
        this.activePreset = 'outdoor_open';
      }

      // Pooled 3D HRTF PannerNodes (hard cap 8: 4 persistent + 4 one-shot; stereo fallback otherwise)
      if (typeof ctx.createPanner === 'function') {
        this.hrtfSupported = true;
        this.riverPanner = configureHrtfPanner(ctx, 4.5, 58, 1.35);
        this.riverPanner.connect(this.outdoorLpf);

        this.fountainPanner = configureHrtfPanner(ctx, 2.0, 28, 1.8);
        this.fountainPanner.connect(this.outdoorLpf);

        this.venueFeaturePanner = configureHrtfPanner(ctx, 2.5, 32, 1.45);
        this.venueFeaturePanner.connect(this.outdoorLpf);

        this.doorwayBleedPanner = configureHrtfPanner(ctx, 1.8, 14, 1.35);
        this.doorwayBleedPanner.connect(this.ambienceGain);

        this.oneShotPool = [];
        for (let i = 0; i < ONE_SHOT_HRTF_SLOTS; i++) {
          const p = configureHrtfPanner(ctx, 1.6, 42, 1.35);
          p.connect(this.foleyGain);
          this.oneShotPool.push({
            panner: p,
            connectedBus: this.foleyGain,
            busyUntil: 0,
            distance: 0,
            priority: 0,
          });
        }
      } else {
        this.hrtfSupported = false;
      }

      const { white, pink, brown } = this.buffers;
      this.windAir = this.makeLoopVoice(ctx, pink, 'bandpass', 360, 1.1, this.outdoorLpf);
      this.windFoliage = this.makeLoopVoice(ctx, pink, 'bandpass', 2900, 0.9, this.outdoorLpf);

      // River: HRTF panner when supported, or first 2 StereoPannerNodes in fallback mode
      if (this.hrtfSupported && this.riverPanner) {
        this.riverLow = this.makeLoopVoice(ctx, brown, 'bandpass', 340, 0.65, this.riverPanner);
        this.riverHigh = this.makeLoopVoice(ctx, pink, 'bandpass', 1650, 0.9, this.riverPanner);
      } else {
        this.riverLow = this.makeLoopVoice(ctx, brown, 'bandpass', 340, 0.65, this.outdoorLpf, true);
        this.riverHigh = this.makeLoopVoice(ctx, pink, 'bandpass', 1650, 0.9, this.outdoorLpf, true);
      }

      this.rainBody = this.makeLoopVoice(ctx, pink, 'bandpass', 1400, 0.55, this.outdoorLpf);
      this.rainHiss = this.makeLoopVoice(ctx, white, 'highpass', 4200, 0.6, this.outdoorLpf);
      this.urbanHum = this.makeLoopVoice(ctx, brown, 'lowpass', 165, 0.6, this.outdoorLpf);
      this.cicadaChorus = this.makeLoopVoice(ctx, white, 'bandpass', 4450, 5.5, this.outdoorLpf);

      // Fountain water trickle & commuter Doppler beds
      const fountainDest = this.fountainPanner ?? this.outdoorLpf;
      this.fountainLow = this.makeLoopVoice(ctx, pink, 'bandpass', 1100, 1.1, fountainDest);
      this.fountainMist = this.makeLoopVoice(ctx, white, 'bandpass', 3800, 1.4, fountainDest);

      const commuterDest = this.venueFeaturePanner ?? this.outdoorLpf;
      this.commuterVoice = this.makeLoopVoice(ctx, brown, 'bandpass', 220, 1.0, commuterDest);

      // Directional indoor doorway/window outdoor bleed (bypasses outdoorLpf)
      const bleedDest = this.doorwayBleedPanner ?? this.ambienceGain;
      this.doorwayBleed = this.makeLoopVoice(ctx, pink, 'bandpass', 1200, 0.65, bleedDest);

      // Interior layers bypass the outdoor occlusion LPF
      this.roomTone = this.makeLoopVoice(ctx, brown, 'lowpass', 190, 0.5, this.ambienceGain);
      this.cafeFormantA = this.makeLoopVoice(ctx, pink, 'bandpass', 480, 1.6, this.ambienceGain);
      this.cafeFormantB = this.makeLoopVoice(ctx, pink, 'bandpass', 1150, 1.8, this.ambienceGain);

      // Continuous vehicle propulsion, road tire, braking, dual-band drift screech & aero wind rush
      const motorOscA = ctx.createOscillator();
      motorOscA.type = 'sine';
      motorOscA.frequency.value = 90;
      const motorOscB = ctx.createOscillator();
      motorOscB.type = 'triangle';
      motorOscB.frequency.value = 180;
      this.lastMotorOscAType = 'sine';
      this.lastMotorOscBType = 'triangle';

      const motorSubGain = ctx.createGain();
      motorSubGain.gain.value = 0.28;
      const motorFilter = ctx.createBiquadFilter();
      motorFilter.type = 'lowpass';
      motorFilter.frequency.value = 650;
      const motorGain = ctx.createGain();
      motorGain.gain.value = 0;
      motorOscA.connect(motorFilter);
      motorOscB.connect(motorSubGain).connect(motorFilter);
      motorFilter.connect(motorGain).connect(this.vehiclesUiGain);
      motorOscA.start();
      motorOscB.start();

      const tireVoice = this.makeLoopVoice(ctx, brown, 'bandpass', 180, 0.85, this.vehiclesUiGain);
      const brakeVoice = this.makeLoopVoice(ctx, pink, 'bandpass', 2400, 3.2, this.vehiclesUiGain);

      // Dual resonant bandpass drift screech (1850 Hz + 2420 Hz, Q = 6.5)
      const driftGain = ctx.createGain();
      driftGain.gain.value = 0;
      driftGain.connect(this.vehiclesUiGain);

      const driftSrcA = ctx.createBufferSource();
      driftSrcA.buffer = pink;
      driftSrcA.loop = true;
      const driftFilterA = ctx.createBiquadFilter();
      driftFilterA.type = 'bandpass';
      driftFilterA.frequency.value = 1850;
      driftFilterA.Q.value = 6.5;
      driftSrcA.connect(driftFilterA).connect(driftGain);
      driftSrcA.start(0, 0.4);

      const driftSrcB = ctx.createBufferSource();
      driftSrcB.buffer = white;
      driftSrcB.loop = true;
      const driftFilterB = ctx.createBiquadFilter();
      driftFilterB.type = 'bandpass';
      driftFilterB.frequency.value = 2420;
      driftFilterB.Q.value = 6.5;
      driftSrcB.connect(driftFilterB).connect(driftGain);
      driftSrcB.start(0, 1.1);

      // Quadratic aerodynamic wind rush bed
      const aeroVoice = this.makeLoopVoice(ctx, pink, 'bandpass', 520, 0.85, this.vehiclesUiGain);

      this.vehicleGraph = {
        motorOscA, motorOscB, motorSubGain, motorFilter, motorGain,
        tireSrc: tireVoice.src, tireFilter: tireVoice.filter, tireGain: tireVoice.gain,
        brakeSrc: brakeVoice.src, brakeFilter: brakeVoice.filter, brakeGain: brakeVoice.gain,
        driftSrcA, driftFilterA, driftSrcB, driftFilterB, driftGain,
        aeroSrc: aeroVoice.src, aeroFilter: aeroVoice.filter, aeroGain: aeroVoice.gain,
      };

      this.graphReady = true;
      this.applyMixerGains(true);
    } catch {
      this.graphReady = false;
    }
  }

  private applyMixerGains(immediate = false) {
    if (!this.graphReady || !this.ctx || !this.masterGain || !this.ambienceGain || !this.foleyGain || !this.vehiclesUiGain) return;
    const g = computeChannelGains(this.mixer);
    const now = this.ctx.currentTime;
    const tau = immediate ? 0.005 : 0.04;
    this.masterGain.gain.setTargetAtTime(g.master, now, tau);
    this.ambienceGain.gain.setTargetAtTime(g.ambience, now, tau);
    this.foleyGain.gain.setTargetAtTime(g.foley, now, tau);
    this.vehiclesUiGain.gain.setTargetAtTime(g.vehiclesUi, now, tau);
  }

  private updateListener(ctx: AudioContext, state: WorldAudioFrameState, now: number) {
    if (!state.pos) return;
    const lx = state.pos.x;
    const ly = (state.pos.y ?? 0) + 1.56;
    const lz = state.pos.z;
    this.listenerPos = { x: lx, y: ly, z: lz };
    this.listenerYaw = state.cameraYaw;

    const listener = ctx.listener;
    if (!listener) return;

    let fx: number;
    let fy: number;
    let fz: number;
    if (state.listenerForward && Number.isFinite(state.listenerForward.x) && Number.isFinite(state.listenerForward.z)) {
      const rawY = state.listenerForward.y ?? 0;
      const mag = Math.hypot(state.listenerForward.x, rawY, state.listenerForward.z) || 1;
      fx = state.listenerForward.x / mag;
      fy = rawY / mag;
      fz = state.listenerForward.z / mag;
    } else {
      const pitch = clamp(state.cameraPitch ?? 0, -1.48, 1.48);
      const cosP = Math.cos(pitch);
      fx = -Math.sin(state.cameraYaw) * cosP;
      fy = Math.sin(pitch);
      fz = -Math.cos(state.cameraYaw) * cosP;
    }

    let ux = 0;
    let uy = 1;
    let uz = 0;
    if (state.listenerUp && Number.isFinite(state.listenerUp.x) && Number.isFinite(state.listenerUp.z)) {
      const rawUy = state.listenerUp.y ?? 1;
      const uMag = Math.hypot(state.listenerUp.x, rawUy, state.listenerUp.z) || 1;
      ux = state.listenerUp.x / uMag;
      uy = rawUy / uMag;
      uz = state.listenerUp.z / uMag;
    }

    if (listener.positionX && typeof listener.positionX.setTargetAtTime === 'function') {
      this.setParamGuarded('lst:px', listener.positionX, lx, now, 0.02, 0.02);
      this.setParamGuarded('lst:py', listener.positionY, ly, now, 0.02, 0.02);
      this.setParamGuarded('lst:pz', listener.positionZ, lz, now, 0.02, 0.02);
    } else if (typeof listener.setPosition === 'function') {
      const prevPx = this.paramCache['lst:px'];
      const prevPy = this.paramCache['lst:py'];
      const prevPz = this.paramCache['lst:pz'];
      if (
        prevPx === undefined ||
        Math.abs(lx - prevPx) > 0.02 ||
        Math.abs(ly - prevPy) > 0.02 ||
        Math.abs(lz - prevPz) > 0.02
      ) {
        this.paramCache['lst:px'] = lx;
        this.paramCache['lst:py'] = ly;
        this.paramCache['lst:pz'] = lz;
        listener.setPosition(lx, ly, lz);
      }
    }

    if (listener.forwardX && typeof listener.forwardX.setTargetAtTime === 'function') {
      this.setParamGuarded('lst:fx', listener.forwardX, fx, now, 0.02, 0.005);
      this.setParamGuarded('lst:fy', listener.forwardY, fy, now, 0.02, 0.005);
      this.setParamGuarded('lst:fz', listener.forwardZ, fz, now, 0.02, 0.005);
      this.setParamGuarded('lst:ux', listener.upX, ux, now, 0.02, 0.005);
      this.setParamGuarded('lst:uy', listener.upY, uy, now, 0.02, 0.005);
      this.setParamGuarded('lst:uz', listener.upZ, uz, now, 0.02, 0.005);
    } else if (typeof listener.setOrientation === 'function') {
      const prevFx = this.paramCache['lst:fx'];
      const prevFy = this.paramCache['lst:fy'];
      const prevFz = this.paramCache['lst:fz'];
      if (
        prevFx === undefined ||
        Math.abs(fx - prevFx) > 0.005 ||
        Math.abs(fy - prevFy) > 0.005 ||
        Math.abs(fz - prevFz) > 0.005
      ) {
        this.paramCache['lst:fx'] = fx;
        this.paramCache['lst:fy'] = fy;
        this.paramCache['lst:fz'] = fz;
        listener.setOrientation(fx, fy, fz, ux, uy, uz);
      }
    }
  }

  private updateRoomAcoustics(state: WorldAudioFrameState, now: number) {
    if (!this.convA || !this.convB || !this.wetA || !this.wetB || !this.irBuffers) return;
    const lowTier = state.qualityTier === 'low';
    const targetPreset: RoomAcousticPreset = lowTier
      ? 'outdoor_open'
      : resolveAcousticPreset(!!state.indoor, state.zone, state.region, state.roomAcousticType);

    if (this.reverbSend) {
      this.setParamGuarded('rev:send', this.reverbSend.gain, lowTier ? 0 : 1, now, 0.12, 0.001);
    }

    if (targetPreset === this.activePreset && !this.wetSuspended) return;

    if (targetPreset === 'outdoor_open') {
      this.wetA.gain.setTargetAtTime(0, now, 0.15);
      this.wetB.gain.setTargetAtTime(0, now, 0.15);
      this.activePreset = 'outdoor_open';
      this.wetSuspended = false;
      return;
    }

    const wetLevel = IR_PRESETS[targetPreset].wet;
    if (targetPreset === this.activePreset && this.wetSuspended) {
      // Restore previously active convolver cleanly after suspend()
      const activeWet = this.activeConvolver === 'A' ? this.wetA : this.wetB;
      const idleWet = this.activeConvolver === 'A' ? this.wetB : this.wetA;
      activeWet.gain.setTargetAtTime(wetLevel, now, 0.15);
      idleWet.gain.setTargetAtTime(0, now, 0.15);
      this.wetSuspended = false;
      return;
    }

    // Swap IR buffer into the currently silent convolver, then crossfade over 450 ms (tau = 0.15)
    const nextSlot: 'A' | 'B' = this.activeConvolver === 'A' ? 'B' : 'A';
    const nextConv = nextSlot === 'A' ? this.convA : this.convB;
    const nextWet = nextSlot === 'A' ? this.wetA : this.wetB;
    const prevWet = nextSlot === 'A' ? this.wetB : this.wetA;

    nextConv.buffer = this.irBuffers[targetPreset];
    nextWet.gain.setTargetAtTime(wetLevel, now, 0.15);
    prevWet.gain.setTargetAtTime(0, now, 0.15);
    this.activeConvolver = nextSlot;
    this.activePreset = targetPreset;
    this.wetSuspended = false;
  }

  /**
   * Acquires a spatial output route for a one-shot emitter.
   * Uses a pooled HRTF PannerNode (priority-evicted by distance across the 4 one-shot slots) when supported,
   * or computes a head-relative StereoPannerNode fallback when createPanner is unavailable.
   */
  private routeOneShot(
    ctx: AudioContext,
    targetBus: AudioNode,
    worldPos: WorldVec3 | undefined,
    durationSec: number,
    priority = 1,
    refDistance = 1.6,
    rolloff = 1.35,
  ): SpatialRoute | null {
    if (!worldPos) return { dest: targetBus, atten: 1 };

    const wx = worldPos.x;
    const wy = worldPos.y ?? 1.2;
    const wz = worldPos.z;
    const now = ctx.currentTime;
    const dist = this.listenerPos
      ? Math.hypot(wx - this.listenerPos.x, wy - this.listenerPos.y, wz - this.listenerPos.z)
      : 0;

    if (dist > 42) return null;

    if (this.hrtfSupported && this.oneShotPool.length > 0) {
      let chosen: OneShotHrtfSlot | null = null;
      for (const slot of this.oneShotPool) {
        if (slot.busyUntil <= now) {
          chosen = slot;
          break;
        }
      }
      if (!chosen) {
        // Priority-evict lowest priority, then farthest emitter, then soonest expiring
        chosen = this.oneShotPool[0];
        for (let i = 1; i < this.oneShotPool.length; i++) {
          const cand = this.oneShotPool[i];
          if (
            cand.priority < chosen.priority ||
            (cand.priority === chosen.priority && cand.distance > chosen.distance) ||
            (cand.priority === chosen.priority && cand.distance === chosen.distance && cand.busyUntil < chosen.busyUntil)
          ) {
            chosen = cand;
          }
        }
      }

      chosen.panner.refDistance = refDistance;
      chosen.panner.rolloffFactor = rolloff;
      setPannerPosition(chosen.panner, wx, wy, wz, now, 0);
      if (chosen.connectedBus !== targetBus) {
        try { chosen.panner.disconnect(); } catch { /* noop */ }
        chosen.panner.connect(targetBus);
        chosen.connectedBus = targetBus;
      }
      chosen.busyUntil = now + durationSec;
      chosen.distance = dist;
      chosen.priority = priority;
      return { dest: chosen.panner, atten: 1 };
    }

    // Stereo fallback when createPanner is unavailable
    const atten = 1 / (1 + dist * dist * 0.14);
    if (this.listenerPos && typeof ctx.createStereoPanner === 'function' && dist > 0.05) {
      const dx = wx - this.listenerPos.x;
      const dz = wz - this.listenerPos.z;
      const horiz = Math.hypot(dx, dz) || 1;
      const rightX = Math.cos(this.listenerYaw);
      const rightZ = -Math.sin(this.listenerYaw);
      const panVal = clamp((rightX * (dx / horiz) + rightZ * (dz / horiz)) * 0.85, -0.85, 0.85);
      const sp = ctx.createStereoPanner();
      sp.pan.value = panVal;
      sp.connect(targetBus);
      return { dest: sp, atten, transientPanner: sp };
    }
    return { dest: targetBus, atten };
  }

  /** Silences continuous ambient, acoustics & vehicle beds (called on tab hidden or StudyWorld.stop()). */
  suspend() {
    this.suspended = true;
    this.resetParamCache();
    if (!this.graphReady || !this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of [
      this.windAir, this.windFoliage, this.riverLow, this.riverHigh,
      this.rainBody, this.rainHiss, this.urbanHum, this.cicadaChorus,
      this.fountainLow, this.fountainMist, this.commuterVoice, this.doorwayBleed,
      this.roomTone, this.cafeFormantA, this.cafeFormantB,
    ]) {
      v?.gain.gain.setTargetAtTime(0, now, 0.08);
    }
    if (this.vehicleGraph) {
      this.vehicleGraph.motorGain.gain.setTargetAtTime(0, now, 0.06);
      this.vehicleGraph.tireGain.gain.setTargetAtTime(0, now, 0.06);
      this.vehicleGraph.brakeGain.gain.setTargetAtTime(0, now, 0.05);
      this.vehicleGraph.driftGain.gain.setTargetAtTime(0, now, 0.05);
      this.vehicleGraph.aeroGain.gain.setTargetAtTime(0, now, 0.06);
    }
    if (this.wetA && this.wetB) {
      this.wetA.gain.setTargetAtTime(0, now, 0.08);
      this.wetB.gain.setTargetAtTime(0, now, 0.08);
      this.wetSuspended = true;
    }
  }

  /** Per-frame update driving 3D listener, room acoustics, occlusion, wildlife, river/fountain/Doppler, and vehicles. */
  update(state: WorldAudioFrameState) {
    if (this.disposed) return;
    if (!state.active || this.mixer.muted || (typeof document !== 'undefined' && document.hidden)) {
      if (!this.suspended) this.suspend();
      return;
    }
    if (this.suspended) {
      this.suspended = false;
      this.resetParamCache();
    }
    const ctx = this.runningContext();
    if (!ctx || !this.buffers) return;

    const dt = clamp(state.dt, 0.001, 0.1);
    this.elapsed += dt;
    if (this.bumpCooldown > 0) this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);

    const now = ctx.currentTime;
    const rain = clamp(state.rain, 0, 1);
    const snow = clamp(state.snow ?? 0, 0, 1);
    const cloud = clamp(state.cloud ?? rain, 0, 1);
    const windowOpen = !!state.windowOpen;
    const indoor = !!state.indoor;
    const zone = state.zone ?? '';
    const region = state.region ?? '';
    const doorCoupling = typeof state.openDoorCoupling === 'number'
      ? clamp(state.openDoorCoupling, 0, 1)
      : (state.doorOpen ? 0.65 : 0);

    // Always step frame-accurate discrete one-shot timers (droplets, birds, crickets, cafe clinks, vehicle clicks/bumps).
    if (rain > 0.08 && (!indoor || windowOpen || doorCoupling > 0.2)) {
      const rate = 4 + rain * 10; // 4..14 droplets/sec
      this.dropletAccum += dt * rate;
      while (this.dropletAccum >= 1) {
        this.dropletAccum -= 1;
        this.spawnRainDroplet(ctx, rain * (indoor ? 0.4 : 1.0));
      }
    } else {
      this.dropletAccum = 0;
    }

    const birdAmt = birdsongDensity(state.hour, rain, snow, indoor, windowOpen, zone);
    if (birdAmt > 0.05) {
      this.birdCooldown -= dt * (0.65 + birdAmt * 0.7);
      if (this.birdCooldown <= 0) {
        this.spawnBirdChirp(ctx, birdAmt);
        this.birdCooldown = 2.4 + Math.random() * 4.2;
      }
    } else {
      this.birdCooldown = Math.max(this.birdCooldown, 1.2);
    }

    const cricketAmt = cricketDensity(state.hour, state.season, rain, snow, indoor, windowOpen, zone);
    if (cricketAmt > 0.05) {
      this.cricketCooldown -= dt * (0.7 + cricketAmt * 0.6);
      if (this.cricketCooldown <= 0) {
        this.spawnCricketChirp(ctx, cricketAmt);
        this.cricketCooldown = 1.9 + Math.random() * 2.8;
      }
    } else {
      this.cricketCooldown = Math.max(this.cricketCooldown, 1.0);
    }

    const inCafe = indoor && CAFE_ZONES.has(zone);
    const occScale = typeof state.residentsInZone === 'number'
      ? clamp(0.35 + 0.15 * Math.max(0, state.residentsInZone), 0.35, 1.0)
      : 0.85;
    if (inCafe) {
      this.clinkCooldown -= dt * (0.65 + 0.65 * occScale);
      if (this.clinkCooldown <= 0) {
        this.spawnCafeClink(ctx);
        this.clinkCooldown = 8.5 + Math.random() * 8.5;
      }
    }

    // Frame-accurate vehicle discrete cues (blinker relay edges, suspension bump thud, bicycle freewheel clicks).
    const veh = state.vehicle ?? null;
    if (veh && veh.kind !== 'none') {
      const cameraMode = veh.cameraMode ?? 'chase';
      if (typeof veh.blinkerLit === 'boolean') {
        if (veh.blinkerLit !== this.prevBlinkerLit) {
          this.spawnBlinkerTick(ctx, veh.blinkerLit, cameraMode);
        }
        this.prevBlinkerLit = veh.blinkerLit;
      } else {
        this.prevBlinkerLit = false;
      }
      if (typeof veh.heaveVel === 'number' && Math.abs(veh.heaveVel) > 0.55 && this.bumpCooldown <= 0) {
        const impulse = clamp((Math.abs(veh.heaveVel) - 0.45) / 1.8, 0.2, 1.0);
        this.triggerVehicleBump(impulse);
        this.bumpCooldown = 0.22;
      }
      if (veh.kind === 'bike') {
        const speed = Math.abs(veh.speed ?? 0);
        const throttle = veh.throttle ?? 0;
        const isCoasting = veh.coasting !== undefined ? veh.coasting : throttle <= 0.05;
        if (isCoasting && speed > 1.2) {
          const clicksPerSec = clamp(speed * 3.8, 5, 22);
          this.freewheelAccum += dt * clicksPerSec;
          if (this.freewheelAccum >= 1) {
            this.freewheelAccum = this.freewheelAccum % 1;
            this.spawnFreewheelClick(ctx);
          }
        } else {
          this.freewheelAccum = 0;
        }
      } else {
        this.freewheelAccum = 0;
      }
    } else {
      this.freewheelAccum = 0;
      this.prevBlinkerLit = false;
    }

    // Throttle continuous ambient/spatial AudioParam automation to 15 Hz (flushing immediately on discrete changes).
    const vehKind = veh?.kind ?? 'none';
    const discreteSig = `${indoor ? 1 : 0}|${windowOpen ? 1 : 0}|${state.doorOpen ? 1 : 0}|${zone}|${region}|${state.qualityTier ?? ''}|${vehKind}|${veh?.cameraMode ?? ''}|${veh?.braking ? 1 : 0}`;
    const discreteChanged = discreteSig !== this.lastDiscreteSig;
    this.paramSchedAccum += dt;
    if (!this.paramForceFlush && !discreteChanged && this.paramSchedAccum < 1 / 15) {
      return;
    }
    const schedDt = Math.max(dt, this.paramSchedAccum);
    this.paramSchedAccum = 0;
    this.paramForceFlush = false;
    this.lastDiscreteSig = discreteSig;

    // 0. Sync 3D AudioListener & Dual-Convolver Room Acoustics
    this.updateListener(ctx, state, now);
    this.updateRoomAcoustics(state, now);

    // 1. Continuous acoustic indoor/outdoor occlusion LPF + directional doorway/window bleed
    const occ = computeOutdoorOcclusion(indoor, windowOpen, doorCoupling);
    this.setParamGuarded('occ:lpf', this.outdoorLpf!.frequency, occ.cutoffHz, now, 0.22, 1.0);
    this.setParamGuarded('occ:gain', this.outdoorGain!.gain, occ.gain, now, 0.22, 0.0005);

    const portalCoupling = indoor ? Math.max(doorCoupling, windowOpen ? 0.42 : 0) : 0;
    if (portalCoupling > 0.04 && state.openPortalPos && this.doorwayBleed) {
      if (this.doorwayBleedPanner) {
        this.setPannerGuarded(
          'portal',
          this.doorwayBleedPanner,
          state.openPortalPos.x,
          state.openPortalPos.y ?? 1.4,
          state.openPortalPos.z,
          now,
          0.04,
        );
      }
      this.setParamGuarded('portal:lpf', this.doorwayBleed.filter.frequency, 900 + rain * 1500 + portalCoupling * 900, now, 0.2, 2.0);
      this.setParamGuarded('portal:gain', this.doorwayBleed.gain.gain, portalCoupling * (0.012 + rain * 0.028), now, 0.2, 0.0004);
    } else if (this.doorwayBleed) {
      this.setParamGuarded('portal:gain', this.doorwayBleed.gain.gain, 0, now, 0.18, 0.0004);
    }

    // 2. Dynamic gust-modulated wind & foliage rustle
    const baseWind = state.wind !== undefined
      ? clamp(state.wind, 0, 1)
      : clamp(0.18 + cloud * 0.24 + rain * 0.46 + snow * 0.30, 0.14, 1.0);
    const gust = 0.5 + 0.32 * Math.sin(this.elapsed * 0.19) + 0.18 * Math.sin(this.elapsed * 0.47 + 1.3);
    const windLevel = baseWind * (0.65 + 0.55 * gust);
    this.setParamGuarded('windA:f', this.windAir!.filter.frequency, 260 + windLevel * 420, now, 0.4, 2.0);
    this.setParamGuarded('windA:g', this.windAir!.gain.gain, 0.012 + windLevel * 0.044, now, 0.35, 0.0004);

    const greenBoost = GREEN_ZONES.has(zone) || region === 'park' || region === 'garden' ? 1.0 : 0.28;
    this.setParamGuarded('windF:f', this.windFoliage!.filter.frequency, 2450 + gust * 1150, now, 0.35, 4.0);
    this.setParamGuarded('windF:g', this.windFoliage!.gain.gain, windLevel * greenBoost * (1 - snow * 0.55) * 0.022, now, 0.35, 0.0004);

    // 3. Spatial HRTF / stereo-panned river water flow
    const river = computeRiverSpatial(state.pos, state.cameraYaw, state.riverRect);
    const riverWave = 0.92 + 0.08 * Math.sin(this.elapsed * 0.7);
    if (this.hrtfSupported && this.riverPanner && state.pos && state.riverRect && river.distance <= 58) {
      const nearestX = clamp(state.pos.x, state.riverRect.x0, state.riverRect.x1);
      const nearestZ = clamp(state.pos.z, state.riverRect.z0, state.riverRect.z1);
      const riverY = (state.pos.y ?? 0) - 0.6;
      this.setPannerGuarded('river', this.riverPanner, nearestX, riverY, nearestZ, now, 0.04);
      const rangeFade = clamp(1 - Math.max(0, river.distance - 38) / 20, 0, 1);
      this.setParamGuarded('riverL:g', this.riverLow!.gain.gain, rangeFade * riverWave * 0.078, now, 0.16, 0.0004);
      this.setParamGuarded('riverH:g', this.riverHigh!.gain.gain, rangeFade * riverWave * 0.026, now, 0.16, 0.0004);
    } else if (this.hrtfSupported && this.riverPanner) {
      this.setParamGuarded('riverL:g', this.riverLow!.gain.gain, 0, now, 0.18, 0.0004);
      this.setParamGuarded('riverH:g', this.riverHigh!.gain.gain, 0, now, 0.18, 0.0004);
    } else {
      this.setParamGuarded('riverL:g', this.riverLow!.gain.gain, river.gain * riverWave * 0.078, now, 0.16, 0.0004);
      this.setParamGuarded('riverH:g', this.riverHigh!.gain.gain, river.gain * riverWave * 0.026, now, 0.16, 0.0004);
      this.setParamGuarded('riverL:p', this.riverLow!.panner?.pan, river.pan, now, 0.08, 0.005);
      this.setParamGuarded('riverH:p', this.riverHigh!.panner?.pan, river.pan, now, 0.08, 0.005);
    }

    // 3b. Fountain water trickle (fountain_plaza / explicit fountainPos)
    this.updateFountainAudio(state, now, indoor, zone);

    // 3c. Passing commuter Doppler voice
    this.updateCommuterDoppler(state, schedDt, now, indoor);

    // 4. Rain sheet + snowy wind hush
    this.setParamGuarded('rainB:g', this.rainBody!.gain.gain, rain * 0.092 + snow * 0.018, now, 0.32, 0.0004);
    this.setParamGuarded('rainB:f', this.rainBody!.filter.frequency, snow > 0.1 && rain < 0.1 ? 820 : 1200 + rain * 520, now, 0.35, 2.0);
    this.setParamGuarded('rainH:g', this.rainHiss!.gain.gain, rain * 0.036, now, 0.28, 0.0004);

    // 5. Summer cicadas continuous chorus
    const cicadaAmt = cicadaDensity(state.hour, state.season, rain, snow, indoor, windowOpen, zone);
    if (this.cicadaChorus) {
      if (cicadaAmt > 0.001) {
        const swell = 0.52 + 0.48 * Math.sin(this.elapsed * 1.13) * Math.cos(this.elapsed * 0.37);
        this.setParamGuarded('cic:f', this.cicadaChorus.filter.frequency, 4250 + 520 * (0.5 + 0.5 * Math.sin(this.elapsed * 0.72)), now, 0.3, 4.0);
        this.setParamGuarded('cic:g', this.cicadaChorus.gain.gain, cicadaAmt * swell * 0.015, now, 0.45, 0.0004);
      } else {
        this.setParamGuarded('cic:g', this.cicadaChorus.gain.gain, 0, now, 0.45, 0.0004);
      }
    }

    // 6. Urban street hum, quiet interior room tone & occupancy-scaled Cafe / Bistro murmur
    const h = ((state.hour % 24) + 24) % 24;
    const nightQuiet = h >= 22 || h < 5.5 ? 0.35 : 1.0;
    const urbanTarget = (!indoor && (URBAN_ZONES.has(zone) || region === 'road' || region === 'sidewalk' || region === 'brick'))
      ? 0.038 * nightQuiet
      : (!indoor ? 0.014 * nightQuiet : 0.012 * nightQuiet);
    this.setParamGuarded('urb:g', this.urbanHum!.gain.gain, urbanTarget, now, 0.45, 0.0004);

    this.setParamGuarded('room:g', this.roomTone!.gain.gain, indoor ? 0.015 : 0, now, 0.3, 0.0004);

    if (inCafe) {
      const murmurMod = (0.78 + 0.22 * Math.sin(this.elapsed * 0.85) * Math.cos(this.elapsed * 0.33)) * occScale;
      this.setParamGuarded('cafeA:g', this.cafeFormantA!.gain.gain, 0.025 * murmurMod, now, 0.35, 0.0004);
      this.setParamGuarded('cafeB:g', this.cafeFormantB!.gain.gain, 0.014 * murmurMod, now, 0.35, 0.0004);
    } else {
      this.setParamGuarded('cafeA:g', this.cafeFormantA!.gain.gain, 0, now, 0.35, 0.0004);
      this.setParamGuarded('cafeB:g', this.cafeFormantB!.gain.gain, 0, now, 0.35, 0.0004);
    }

    // 7. Continuous Vehicles 2.0 propulsion, tire/drift, and aero wind rush
    this.updateVehicleAudio(ctx, schedDt, veh, rain);
  }

  private updateFountainAudio(state: WorldAudioFrameState, now: number, indoor: boolean, zone: string) {
    if (!this.fountainLow || !this.fountainMist) return;
    const shimmer = 0.88 + 0.12 * Math.sin(this.elapsed * 2.1 + 0.4);
    if (state.fountainPos && state.pos) {
      const fx = state.fountainPos.x;
      const fy = state.fountainPos.y ?? 1.1;
      const fz = state.fountainPos.z;
      const d = Math.hypot(fx - state.pos.x, fz - state.pos.z);
      if (d < 28) {
        if (this.fountainPanner) {
          this.setPannerGuarded('fnt', this.fountainPanner, fx, fy, fz, now, 0.04);
          const edgeFade = clamp(1 - Math.max(0, d - 18) / 10, 0, 1);
          this.setParamGuarded('fntL:g', this.fountainLow.gain.gain, edgeFade * shimmer * 0.044, now, 0.18, 0.0004);
          this.setParamGuarded('fntM:g', this.fountainMist.gain.gain, edgeFade * shimmer * 0.018, now, 0.18, 0.0004);
        } else {
          const atten = clamp(1 / (1 + Math.pow(d / 6, 1.8)), 0, 1);
          this.setParamGuarded('fntL:g', this.fountainLow.gain.gain, atten * shimmer * 0.044, now, 0.18, 0.0004);
          this.setParamGuarded('fntM:g', this.fountainMist.gain.gain, atten * shimmer * 0.018, now, 0.18, 0.0004);
        }
        return;
      }
    } else if (!indoor && zone === 'fountain_plaza') {
      if (this.fountainPanner && state.pos) {
        this.setPannerGuarded('fnt', this.fountainPanner, state.pos.x, (state.pos.y ?? 0) + 1.0, state.pos.z - 4.0, now, 0.08);
      }
      this.setParamGuarded('fntL:g', this.fountainLow.gain.gain, 0.026 * shimmer, now, 0.25, 0.0004);
      this.setParamGuarded('fntM:g', this.fountainMist.gain.gain, 0.011 * shimmer, now, 0.25, 0.0004);
      return;
    }
    this.setParamGuarded('fntL:g', this.fountainLow.gain.gain, 0, now, 0.2, 0.0004);
    this.setParamGuarded('fntM:g', this.fountainMist.gain.gain, 0, now, 0.2, 0.0004);
  }

  private updateCommuterDoppler(state: WorldAudioFrameState, dt: number, now: number, indoor: boolean) {
    if (!this.commuterVoice) return;
    if (!state.commuterPos || !state.pos || indoor) {
      this.setParamGuarded('com:g', this.commuterVoice.gain.gain, 0, now, 0.16, 0.0004);
      this.prevCommuterDist = null;
      return;
    }
    const cx = state.commuterPos.x;
    const cy = state.commuterPos.y ?? 0.8;
    const cz = state.commuterPos.z;
    const d = Math.hypot(cx - state.pos.x, cz - state.pos.z);
    if (d >= 30) {
      this.setParamGuarded('com:g', this.commuterVoice.gain.gain, 0, now, 0.16, 0.0004);
      this.prevCommuterDist = d;
      return;
    }

    const vRadial = this.prevCommuterDist !== null ? clamp((d - this.prevCommuterDist) / dt, -25, 25) : 0;
    this.prevCommuterDist = d;
    const doppler = clamp(343 / (343 + vRadial), 0.85, 1.18);
    const motionFactor = Math.abs(vRadial) > 0.35 ? 1.0 : 0.45;
    const prox = this.venueFeaturePanner ? clamp(1 - Math.max(0, d - 20) / 10, 0, 1) : clamp(1 - d / 30, 0, 1);

    if (this.venueFeaturePanner) {
      this.setPannerGuarded('com', this.venueFeaturePanner, cx, cy, cz, now, 0.03);
    }
    this.setParamGuarded('com:r', this.commuterVoice.src.playbackRate, doppler, now, 0.06, 0.002);
    this.setParamGuarded('com:f', this.commuterVoice.filter.frequency, 220 * doppler, now, 0.06, 1.0);
    this.setParamGuarded('com:g', this.commuterVoice.gain.gain, prox * motionFactor * 0.028, now, 0.1, 0.0004);
  }

  private updateVehicleAudio(
    ctx: AudioContext,
    _dt: number,
    vehicle: NonNullable<WorldAudioFrameState['vehicle']> | null,
    rain: number,
  ) {
    const vg = this.vehicleGraph;
    if (!vg) return;
    const now = ctx.currentTime;
    const kind = vehicle?.kind ?? 'none';
    if (kind === 'none') {
      this.setParamGuarded('vm:g', vg.motorGain.gain, 0, now, 0.08, 0.0004);
      this.setParamGuarded('vt:g', vg.tireGain.gain, 0, now, 0.08, 0.0004);
      this.setParamGuarded('vb:g', vg.brakeGain.gain, 0, now, 0.05, 0.0004);
      this.setParamGuarded('vd:g', vg.driftGain.gain, 0, now, 0.05, 0.0004);
      this.setParamGuarded('va:g', vg.aeroGain.gain, 0, now, 0.08, 0.0004);
      return;
    }

    const speed = Math.abs(vehicle?.speed ?? 0);
    const throttle = vehicle?.throttle ?? 0;
    const braking = !!vehicle?.braking;
    const driftIntensity = clamp(vehicle?.driftIntensity ?? 0, 0, 1);
    const cameraMode = vehicle?.cameraMode ?? 'chase';
    const doorOpen = !!vehicle?.doorOpen;
    const speedNorm = clamp(speed / 14, 0, 1.35);

    // Cockpit cabin attenuation (-6 dB for aero wind, softened when vehicle door is ajar)
    const cabinWindAtten = cameraMode === 'cockpit' ? (doorOpen ? 0.82 : 0.5) : 1.0;
    const cabinTireAtten = cameraMode === 'cockpit' ? (doorOpen ? 0.92 : 0.78) : 1.0;

    // Quadratic aerodynamic wind rush (520 -> 1400 Hz, -6 dB in cockpit)
    const aeroNorm = clamp(speed / 15, 0, 1.25);
    const aeroLevel = Math.min(1, aeroNorm * aeroNorm) * 0.048 * cabinWindAtten;
    this.setParamGuarded('va:f', vg.aeroFilter.frequency, 520 + Math.min(1, aeroNorm) * 880, now, 0.08, 2.0);
    this.setParamGuarded('va:g', vg.aeroGain.gain, kind === 'bike' ? aeroLevel * 0.55 : aeroLevel, now, 0.08, 0.0004);

    // Dual-band drift tire screech (active when driftIntensity > 0.18)
    if (kind !== 'bike' && driftIntensity > 0.18 && speed > 2.0) {
      const driftNorm = clamp((driftIntensity - 0.18) / 0.82, 0, 1) * clamp(speed / 9, 0.25, 1);
      this.setParamGuarded('vd:fA', vg.driftFilterA.frequency, 1780 + driftNorm * 260, now, 0.05, 2.0);
      this.setParamGuarded('vd:fB', vg.driftFilterB.frequency, 2320 + driftNorm * 320, now, 0.05, 2.0);
      const wetFactor = rain > 0.2 ? 0.55 : 1.0;
      this.setParamGuarded('vd:g', vg.driftGain.gain, driftNorm * 0.042 * wetFactor * cabinTireAtten, now, 0.04, 0.0004);
    } else {
      this.setParamGuarded('vd:g', vg.driftGain.gain, 0, now, 0.05, 0.0004);
    }

    const setMotorShapes = (a: OscillatorType, b: OscillatorType) => {
      if (this.lastMotorOscAType !== a) {
        vg.motorOscA.type = a;
        this.lastMotorOscAType = a;
      }
      if (this.lastMotorOscBType !== b) {
        vg.motorOscB.type = b;
        this.lastMotorOscBType = b;
      }
    };

    if (kind === 'car') {
      const carClass = vehicle?.carClass ?? 'micro';
      const throttleOffset = throttle > 0.05 ? 24 : throttle < -0.05 ? -10 : 0;
      let baseHz: number;
      let multB: number;
      let filterHz: number;
      let subGain: number;

      if (carClass === 'sedan') {
        setMotorShapes('sine', 'sine');
        baseHz = 72 + speedNorm * 258 + throttleOffset * 0.8;
        multB = 1.5;
        filterHz = 300 + speedNorm * 680;
        subGain = 0.34;
      } else if (carClass === 'spider') {
        setMotorShapes('sawtooth', 'triangle');
        baseHz = 105 + speedNorm * 435 + throttleOffset * 1.25;
        multB = 2.0;
        filterHz = 420 + speedNorm * 1230;
        subGain = 0.36;
      } else if (carClass === 'hyper') {
        setMotorShapes('sawtooth', 'sine');
        baseHz = 130 + speedNorm * 550 + throttleOffset * 1.5;
        multB = 2.5;
        filterHz = 560 + speedNorm * 1840;
        subGain = 0.42;
      } else {
        // micro EV (default)
        setMotorShapes('sine', 'triangle');
        baseHz = 84 + speedNorm * 306 + throttleOffset;
        multB = 2.01;
        filterHz = 340 + speedNorm * 950;
        subGain = 0.28;
      }

      this.setParamGuarded('vm:fA', vg.motorOscA.frequency, Math.max(40, baseHz), now, 0.06, 0.5);
      this.setParamGuarded('vm:fB', vg.motorOscB.frequency, Math.max(60, baseHz * multB), now, 0.06, 0.5);
      this.setParamGuarded('vm:sg', vg.motorSubGain.gain, subGain, now, 0.08, 0.001);
      this.setParamGuarded('vm:ff', vg.motorFilter.frequency, filterHz, now, 0.08, 2.0);
      this.setParamGuarded(
        'vm:g',
        vg.motorGain.gain,
        (0.014 + Math.min(1.1, speedNorm) * 0.036 + Math.abs(throttle) * 0.012) * cabinTireAtten,
        now,
        0.08,
        0.0004,
      );

      // Asphalt tire hum + wet-road spray widening
      this.setParamGuarded('vt:f', vg.tireFilter.frequency, 125 + speed * 28 + rain * 420, now, 0.08, 2.0);
      this.setParamGuarded('vt:q', vg.tireFilter.Q, rain > 0.1 ? 0.5 : 0.9, now, 0.1, 0.01);
      this.setParamGuarded('vt:g', vg.tireGain.gain, Math.min(1.2, speedNorm) * (0.048 + rain * 0.032) * cabinTireAtten, now, 0.08, 0.0004);

      const brakeScrub = braking && speed > 3.2 ? clamp((speed - 3.0) / 8, 0.15, 1) * 0.018 * cabinTireAtten : 0;
      this.setParamGuarded('vb:g', vg.brakeGain.gain, brakeScrub, now, 0.04, 0.0004);
    } else if (kind === 'motorbike') {
      setMotorShapes('sawtooth', 'triangle');
      const baseHz = 62 + Math.min(1.2, speedNorm) * 148 + (throttle > 0.05 ? 18 : 0);
      this.setParamGuarded('vm:fA', vg.motorOscA.frequency, baseHz, now, 0.06, 0.5);
      this.setParamGuarded('vm:fB', vg.motorOscB.frequency, baseHz * 1.5, now, 0.06, 0.5);
      this.setParamGuarded('vm:sg', vg.motorSubGain.gain, 0.45, now, 0.08, 0.001);
      this.setParamGuarded('vm:ff', vg.motorFilter.frequency, 280 + Math.min(1.2, speedNorm) * 580, now, 0.08, 2.0);
      this.setParamGuarded('vm:g', vg.motorGain.gain, 0.014 + Math.min(1.1, speedNorm) * 0.034 + Math.abs(throttle) * 0.014, now, 0.07, 0.0004);
      this.setParamGuarded('vt:f', vg.tireFilter.frequency, 200 + speed * 32 + rain * 280, now, 0.08, 2.0);
      this.setParamGuarded('vt:g', vg.tireGain.gain, Math.min(1.1, speedNorm) * (0.032 + rain * 0.02), now, 0.08, 0.0004);
      this.setParamGuarded('vb:g', vg.brakeGain.gain, braking && speed > 3.0 ? 0.014 : 0, now, 0.04, 0.0004);
    } else {
      // Bicycle: silent motor, crisp tire whirr
      this.setParamGuarded('vm:g', vg.motorGain.gain, 0, now, 0.05, 0.0004);
      this.setParamGuarded('vt:f', vg.tireFilter.frequency, 740 + speed * 52 + rain * 240, now, 0.08, 2.0);
      this.setParamGuarded('vt:g', vg.tireGain.gain, clamp(speed / 8, 0, 1) * (0.022 + rain * 0.012), now, 0.08, 0.0004);
      this.setParamGuarded('vb:g', vg.brakeGain.gain, braking && speed > 2.5 ? 0.01 : 0, now, 0.04, 0.0004);
    }
  }

  // ── Procedural One-Shot Synthesis Helpers ────────────────────────────────────────────────────────────────

  private spawnBlinkerTick(ctx: AudioContext, lit: boolean, cameraMode: VehicleCameraMode) {
    if (!this.vehiclesUiGain) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = lit ? 1950 : 1520;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = lit ? 2100 : 1600;
    bp.Q.value = 3.2;
    const g = ctx.createGain();
    const peak = cameraMode === 'chase' ? 0.008 : 0.018;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.005);
    osc.connect(bp).connect(g).connect(this.vehiclesUiGain);
    osc.start(now);
    osc.stop(now + 0.008);
  }

  private spawnRainDroplet(ctx: AudioContext, intensity: number) {
    if (!this.buffers || !this.outdoorLpf) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200 + Math.random() * 2900;
    bp.Q.value = 3.2;
    const g = ctx.createGain();
    const peak = (0.008 + Math.random() * 0.012) * clamp(intensity, 0.2, 1);
    const dur = 0.014 + Math.random() * 0.012;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner();
      pan.pan.value = (Math.random() * 2 - 1) * 0.85;
      src.connect(bp).connect(g).connect(pan).connect(this.outdoorLpf);
    } else {
      src.connect(bp).connect(g).connect(this.outdoorLpf);
    }
    src.start(now, Math.random() * 3.5, dur + 0.01);
  }

  private spawnBirdChirp(ctx: AudioContext, density: number) {
    if (!this.outdoorLpf) return;
    const now = ctx.currentTime;
    const motif = Math.floor(Math.random() * 4);

    let out: AudioNode = this.outdoorLpf;
    if (this.hrtfSupported && this.listenerPos) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 6 + Math.random() * 9;
      const canopyPos: WorldVec3 = {
        x: this.listenerPos.x + Math.cos(angle) * radius,
        y: this.listenerPos.y + 4.0 + Math.random() * 2.5,
        z: this.listenerPos.z + Math.sin(angle) * radius,
      };
      const route = this.routeOneShot(ctx, this.outdoorLpf, canopyPos, 0.45, 0, 3.0, 1.0);
      if (route) out = route.dest;
    } else if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = (Math.random() * 2 - 1) * 0.82;
      p.connect(this.outdoorLpf);
      out = p;
    }

    const note = (delay: number, f0: number, f1: number, dur: number, amp: number, vibrato = false) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const g = ctx.createGain();
      const t0 = now + delay;
      osc.frequency.setValueAtTime(f0, t0);
      osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.72);
      if (vibrato) {
        const lfo = ctx.createOscillator();
        const lfoG = ctx.createGain();
        lfo.frequency.value = 26 + Math.random() * 8;
        lfoG.gain.value = 95;
        lfo.connect(lfoG).connect(osc.frequency);
        lfo.start(t0);
        lfo.stop(t0 + dur + 0.02);
      }
      const peak = amp * (0.65 + 0.35 * density);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.016);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    };

    const pitchShift = 0.92 + Math.random() * 0.18;
    if (motif === 0) {
      // Songbird upward trill
      note(0, 2650 * pitchShift, 3850 * pitchShift, 0.15, 0.026, true);
      note(0.18, 3100 * pitchShift, 4150 * pitchShift, 0.18, 0.022, true);
    } else if (motif === 1) {
      // Two-note park call
      note(0, 3250 * pitchShift, 2500 * pitchShift, 0.13, 0.024);
      note(0.16, 2850 * pitchShift, 3150 * pitchShift, 0.14, 0.020);
    } else if (motif === 2) {
      // Soft sparrow double-chirp
      note(0, 3500 * pitchShift, 4350 * pitchShift, 0.075, 0.022);
      note(0.095, 3600 * pitchShift, 3100 * pitchShift, 0.09, 0.020);
    } else {
      // Mellow robin three-note warble
      note(0, 2200 * pitchShift, 2750 * pitchShift, 0.11, 0.020);
      note(0.13, 2800 * pitchShift, 2300 * pitchShift, 0.12, 0.018);
      note(0.27, 2500 * pitchShift, 3200 * pitchShift, 0.13, 0.019, true);
    }
  }

  private spawnCricketChirp(ctx: AudioContext, density: number) {
    if (!this.outdoorLpf) return;
    const now = ctx.currentTime;
    let out: AudioNode = this.outdoorLpf;
    if (this.hrtfSupported && this.listenerPos) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 4 + Math.random() * 7;
      const grassPos: WorldVec3 = {
        x: this.listenerPos.x + Math.cos(angle) * radius,
        y: Math.max(0.2, this.listenerPos.y - 1.3),
        z: this.listenerPos.z + Math.sin(angle) * radius,
      };
      const route = this.routeOneShot(ctx, this.outdoorLpf, grassPos, 0.25, 0, 2.5, 1.1);
      if (route) out = route.dest;
    } else if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = (Math.random() * 2 - 1) * 0.85;
      p.connect(this.outdoorLpf);
      out = p;
    }

    const baseFreq = 4480 + Math.random() * 180;
    const peak = 0.013 * (0.55 + 0.45 * density);
    for (let i = 0; i < 3; i++) {
      const t0 = now + i * 0.042;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = baseFreq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.024);
      osc.connect(g).connect(out);
      osc.start(t0);
      osc.stop(t0 + 0.028);
    }
  }

  private spawnCafeClink(ctx: AudioContext) {
    if (!this.ambienceGain) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 2150 + Math.random() * 520;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.011, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    osc.connect(g).connect(this.ambienceGain);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  private spawnFreewheelClick(ctx: AudioContext) {
    if (!this.buffers || !this.vehiclesUiGain) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3400 + Math.random() * 450;
    bp.Q.value = 4.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.016, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.008);
    src.connect(bp).connect(g).connect(this.vehiclesUiGain);
    src.start(now, Math.random() * 3.5, 0.012);
  }

  // ── Public Trigger Methods (Footsteps, Doors, Basketball, Speech, Vehicles, Interactive Foley) ───────────

  /**
   * Plays a surface-aware heel-to-toe footstep or landing thud synced to the character's foot plant.
   * `intensity` 0..1 (crouch ~0.25, walk ~0.5, sprint ~1.0); `wet` 0..1 adds puddle spray outdoors;
   * `snow` > 0.15 synthesizes granular ice crunch on outdoor surfaces; optional `worldPos` spatializes via HRTF.
   */
  triggerFootstep(
    surface: FootSurface,
    intensity = 0.55,
    wet = 0,
    isLanding = false,
    snow = 0,
    worldPos?: WorldVec3,
  ) {
    const ctx = this.runningContext();
    if (!ctx || !this.buffers || !this.foleyGain || this.foleyVoices >= MAX_FOLEY_VOICES) return;

    const effSurface: FootSurface =
      snow > 0.15 && (surface === 'grass' || surface === 'asphalt' || surface === 'paver' || surface === 'brick')
        ? 'snow'
        : surface;

    let spatial: SpatialRoute | null = null;
    if (worldPos) {
      spatial = this.routeOneShot(ctx, this.foleyGain, worldPos, 0.24, 1, 1.4, 1.4);
      if (!spatial) return;
    }

    this.foleyVoices++;
    const now = ctx.currentTime;
    const vel = clamp(intensity, 0.15, 1.25) * (isLanding ? 1.22 : 1.0) * (spatial?.atten ?? 1);
    const pitch = 0.90 + Math.random() * 0.20;
    this.footSide = -this.footSide;

    const out = ctx.createGain();
    out.gain.value = 1;
    let localPan: StereoPannerNode | undefined;
    if (spatial) {
      out.connect(spatial.dest);
    } else if (typeof ctx.createStereoPanner === 'function') {
      localPan = ctx.createStereoPanner();
      localPan.pan.value = isLanding ? 0 : this.footSide * 0.08;
      out.connect(localPan).connect(this.foleyGain);
    } else {
      out.connect(this.foleyGain);
    }

    const noiseBurst = (buf: AudioBuffer, type: BiquadFilterType, freq: number, q: number, amp: number, dur: number, delay = 0) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = pitch;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq * pitch;
      f.Q.value = q;
      const g = ctx.createGain();
      const t = now + delay;
      g.gain.setValueAtTime(Math.max(0.0001, amp * vel), t);
      g.gain.exponentialRampToValueAtTime(0.0002, t + dur);
      src.connect(f).connect(g).connect(out);
      src.start(t, Math.random() * 3.2, dur + 0.02);
    };

    const toeDelay = isLanding ? 0.022 : 0.038;
    let releaseMs = 155;

    if (effSurface === 'snow') {
      // Dual-stage granular ice crunch: 3 staggered high micro-bursts across 0-48 ms + muffled 140 Hz compression
      noiseBurst(this.buffers.white, 'bandpass', 2600, 1.8, 0.046, 0.034, 0.0);
      noiseBurst(this.buffers.pink, 'bandpass', 3900, 2.2, 0.042, 0.036, 0.018);
      noiseBurst(this.buffers.white, 'bandpass', 5000, 2.0, 0.032, 0.030, 0.038);
      noiseBurst(this.buffers.brown, 'lowpass', 140, 0.7, 0.056, 0.088, 0.004);
      releaseMs = 175;
    } else if (effSurface === 'brick') {
      // Warm hollow ceramic clack (1.6 kHz transient + 380 Hz stone resonance + toe scuff)
      noiseBurst(this.buffers.white, 'bandpass', 1620, 2.4, 0.056, 0.044);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(380 * pitch, now);
      osc.frequency.exponentialRampToValueAtTime(210, now + 0.055);
      g.gain.setValueAtTime(0.034 * vel, now);
      g.gain.exponentialRampToValueAtTime(0.0002, now + 0.062);
      osc.connect(g).connect(out);
      osc.start(now);
      osc.stop(now + 0.07);
      noiseBurst(this.buffers.pink, 'bandpass', 1280, 1.6, 0.024, 0.038, toeDelay);
    } else if (effSurface === 'grass') {
      noiseBurst(this.buffers.pink, 'bandpass', 1100, 0.8, 0.055, 0.085);
      noiseBurst(this.buffers.white, 'highpass', 2800, 0.6, 0.022, 0.065, 0.008);
      noiseBurst(this.buffers.brown, 'lowpass', 190, 0.7, 0.048, 0.075);
      noiseBurst(this.buffers.pink, 'bandpass', 1600, 0.9, 0.018, 0.055, toeDelay);
    } else if (effSurface === 'asphalt') {
      noiseBurst(this.buffers.pink, 'bandpass', 1450, 1.3, 0.062, 0.055);
      noiseBurst(this.buffers.brown, 'lowpass', 380, 0.9, 0.058, 0.060);
      noiseBurst(this.buffers.pink, 'bandpass', 1850, 1.2, 0.022, 0.042, toeDelay);
    } else if (effSurface === 'paver') {
      noiseBurst(this.buffers.white, 'bandpass', 2350, 2.0, 0.054, 0.048);
      noiseBurst(this.buffers.pink, 'bandpass', 720, 1.1, 0.052, 0.052);
      noiseBurst(this.buffers.white, 'bandpass', 2600, 1.8, 0.020, 0.038, toeDelay);
    } else if (effSurface === 'wood') {
      noiseBurst(this.buffers.pink, 'lowpass', 580, 1.2, 0.058, 0.085);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(118 * pitch, now);
      osc.frequency.exponentialRampToValueAtTime(62, now + 0.072);
      g.gain.setValueAtTime(0.048 * vel, now);
      g.gain.exponentialRampToValueAtTime(0.0002, now + 0.082);
      osc.connect(g).connect(out);
      osc.start(now);
      osc.stop(now + 0.09);
      noiseBurst(this.buffers.pink, 'lowpass', 740, 1.0, 0.020, 0.052, toeDelay);
    } else if (effSurface === 'tile') {
      noiseBurst(this.buffers.white, 'bandpass', 3100, 2.4, 0.048, 0.042);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 950 * pitch;
      g.gain.setValueAtTime(0.022 * vel, now);
      g.gain.exponentialRampToValueAtTime(0.0002, now + 0.042);
      osc.connect(g).connect(out);
      osc.start(now);
      osc.stop(now + 0.05);
      noiseBurst(this.buffers.white, 'bandpass', 3400, 2.0, 0.018, 0.032, toeDelay);
    } else {
      // carpet
      noiseBurst(this.buffers.brown, 'lowpass', 320, 0.6, 0.036, 0.095);
      noiseBurst(this.buffers.brown, 'lowpass', 420, 0.6, 0.014, 0.062, toeDelay);
    }

    if (isLanding) {
      noiseBurst(this.buffers.brown, 'lowpass', 210, 0.8, 0.075, 0.11, 0.015);
      releaseMs = 200;
    }

    if (wet > 0.15 && effSurface !== 'snow' && (effSurface === 'asphalt' || effSurface === 'paver' || effSurface === 'grass' || effSurface === 'brick')) {
      const src = ctx.createBufferSource();
      src.buffer = this.buffers.white;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(3200, now + 0.01);
      bp.frequency.exponentialRampToValueAtTime(1400, now + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.038 * clamp(wet, 0.15, 1) * vel, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0002, now + 0.13);
      src.connect(bp).connect(g).connect(out);
      src.start(now + 0.01, Math.random() * 3.0, 0.14);
      releaseMs = 210;
    }

    this.scheduleFoleyRelease(releaseMs, () => {
      try { out.disconnect(); } catch { /* already disconnected */ }
      try { localPan?.disconnect(); } catch { /* noop */ }
      try { spatial?.transientPanner?.disconnect(); } catch { /* noop */ }
    });
  }

  private scheduleFoleyRelease(delayMs: number, onDone?: () => void) {
    const handle = setTimeout(() => {
      this.foleyTimers.delete(handle);
      this.foleyVoices = Math.max(0, this.foleyVoices - 1);
      onDone?.();
    }, delayMs);
    this.foleyTimers.add(handle);
  }

  /** Wooden door latch click + low hinge/swing motion (optionally HRTF-positioned at `worldPos`). */
  triggerDoor(open: boolean, distance = 1.0, worldPos?: WorldVec3) {
    const ctx = this.runningContext();
    if (!ctx || !this.buffers || !this.foleyGain || this.foleyVoices >= MAX_FOLEY_VOICES) return;

    const spatial = this.routeOneShot(ctx, this.foleyGain, worldPos, 0.34, 2, 1.8, 1.35);
    if (!spatial) return;

    this.foleyVoices++;
    const now = ctx.currentTime;
    const atten = worldPos && this.hrtfSupported
      ? 1.0
      : (worldPos ? spatial.atten : 1 / (1 + Math.max(0, distance) * Math.max(0, distance) * 0.25));

    // Metallic brass latch click
    const latch = ctx.createOscillator();
    const lg = ctx.createGain();
    latch.type = 'triangle';
    latch.frequency.setValueAtTime(open ? 1750 : 1280, now);
    latch.frequency.exponentialRampToValueAtTime(open ? 920 : 620, now + 0.035);
    lg.gain.setValueAtTime(Math.max(0.0001, 0.032 * atten), now);
    lg.gain.exponentialRampToValueAtTime(0.0002, now + 0.045);
    latch.connect(lg).connect(spatial.dest);
    latch.start(now);
    latch.stop(now + 0.05);

    // Wooden leaf swing / soft frame thud
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.pink;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = open ? 340 : 250;
    bp.Q.value = 2.0;
    const g = ctx.createGain();
    const dur = open ? 0.28 : 0.18;
    g.gain.setValueAtTime(0.0001, now + 0.02);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.038 * atten), now + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0002, now + dur);
    src.connect(bp).connect(g).connect(spatial.dest);
    src.start(now + 0.02, Math.random() * 3.0, dur + 0.02);

    this.scheduleFoleyRelease(340, () => {
      try { spatial.transientPanner?.disconnect(); } catch { /* noop */ }
    });
  }

  /** Authentic basketball court foley: bounce, rim clank, backboard thud, net swish, shoot, catch (3D HRTF at `worldPos`). */
  triggerBasketball(kind: BasketballSfx, strength = 0.7, worldPos?: WorldVec3) {
    const ctx = this.runningContext();
    if (!ctx || !this.buffers || !this.foleyGain || this.foleyVoices >= MAX_FOLEY_VOICES) return;

    const spatial = this.routeOneShot(ctx, this.foleyGain, worldPos, 0.24, 3, 2.2, 1.3);
    if (!spatial) return;

    this.foleyVoices++;
    const now = ctx.currentTime;
    const s = clamp(strength, 0.2, 1.2) * spatial.atten;
    const dest = spatial.dest;

    if (kind === 'bounce') {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(165, now);
      osc.frequency.exponentialRampToValueAtTime(78, now + 0.11);
      g.gain.setValueAtTime(Math.max(0.0001, 0.095 * s), now);
      g.gain.exponentialRampToValueAtTime(0.0002, now + 0.13);
      osc.connect(g).connect(dest);
      osc.start(now);
      osc.stop(now + 0.14);

      const ring = ctx.createOscillator();
      const rg = ctx.createGain();
      ring.type = 'triangle';
      ring.frequency.value = 420;
      rg.gain.setValueAtTime(Math.max(0.0001, 0.024 * s), now);
      rg.gain.exponentialRampToValueAtTime(0.0002, now + 0.065);
      ring.connect(rg).connect(dest);
      ring.start(now);
      ring.stop(now + 0.075);
    } else if (kind === 'rim') {
      for (const [freq, amp, dec] of [[880, 0.045, 0.16], [1420, 0.032, 0.14], [2190, 0.022, 0.11]] as const) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq * (0.97 + Math.random() * 0.06);
        g.gain.setValueAtTime(Math.max(0.0001, amp * s), now);
        g.gain.exponentialRampToValueAtTime(0.0002, now + dec);
        osc.connect(g).connect(dest);
        osc.start(now);
        osc.stop(now + dec + 0.02);
      }
    } else if (kind === 'backboard') {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.exponentialRampToValueAtTime(120, now + 0.08);
      g.gain.setValueAtTime(Math.max(0.0001, 0.07 * s), now);
      g.gain.exponentialRampToValueAtTime(0.0002, now + 0.09);
      osc.connect(g).connect(dest);
      osc.start(now);
      osc.stop(now + 0.1);
    } else if (kind === 'swish') {
      const src = ctx.createBufferSource();
      src.buffer = this.buffers.pink;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(2800, now);
      bp.frequency.exponentialRampToValueAtTime(1550, now + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.072 * s), now + 0.035);
      g.gain.exponentialRampToValueAtTime(0.0002, now + 0.18);
      src.connect(bp).connect(g).connect(dest);
      src.start(now, Math.random() * 3.0, 0.2);
    } else {
      // shoot / catch soft leather pat
      const src = ctx.createBufferSource();
      src.buffer = this.buffers.pink;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = kind === 'shoot' ? 900 : 620;
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0001, 0.045 * s), now);
      g.gain.exponentialRampToValueAtTime(0.0002, now + 0.075);
      src.connect(lp).connect(g).connect(dest);
      src.start(now, Math.random() * 3.0, 0.09);
    }

    this.scheduleFoleyRelease(220, () => {
      try { spatial.transientPanner?.disconnect(); } catch { /* noop */ }
    });
  }

  /**
   * Subtle deterministic non-verbal emotional speech prosody syllable for a resident (peak <= 0.018 on foleyGain).
   * Zero audio files, zero LLM/network calls, automatically respects mute and voice limits.
   */
  triggerSpeechSyllable(
    residentId: string,
    mood = 'neutral',
    char = 'a',
    worldPos?: WorldVec3,
  ) {
    if (!residentId) return;
    if (char && /^\s+$/.test(char)) return;
    const ctx = this.runningContext();
    if (!ctx || !this.foleyGain || this.foleyVoices >= MAX_FOLEY_VOICES) return;

    const spatial = this.routeOneShot(ctx, this.foleyGain, worldPos, 0.12, 2, 1.8, 1.35);
    if (!spatial) return;

    this.foleyVoices++;
    const now = ctx.currentTime;
    const h = hashString(residentId);
    const baseF0 = 135 + (h % 131); // 135..265 Hz deterministic per resident
    const baseF1 = 440 + ((h >>> 8) % 260); // 440..699 Hz
    const baseF2 = 1320 + ((h >>> 16) % 780); // 1320..2099 Hz

    const ch = (char || 'a').toLowerCase();
    const charCode = ch.charCodeAt(0) || 97;
    const vowelShift = ch === 'i' || ch === 'e' ? 1.14 : ch === 'o' || ch === 'u' ? 0.88 : 1.0;
    const charJitter = 0.96 + ((charCode % 9) / 8) * 0.08;

    const m = mood.toLowerCase();
    let glide = 1.02;
    let f2Boost = 1.0;
    let gainScale = 1.0;
    if (m === 'cheerful' || m === 'excited' || m === 'happy' || m === 'joyful') {
      glide = 1.12;
      f2Boost = 1.12;
      gainScale = 1.05;
    } else if (m === 'tired' || m === 'sad' || m === 'sleepy' || m === 'anxious') {
      glide = 0.90;
      f2Boost = 0.92;
      gainScale = 0.72;
    }

    if (ch === '?') glide *= 1.16;
    else if (ch === '!') gainScale *= 1.10;
    else if (ch === '.' || ch === ',') glide *= 0.94;

    const dur = 0.058 + ((charCode % 5) * 0.006);
    const fStart = clamp(baseF0 * charJitter, 110, 320);
    const fEnd = clamp(fStart * glide, 100, 380);
    const peak = Math.min(0.018, 0.015 * gainScale * spatial.atten);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(fStart, now);
    osc.frequency.exponentialRampToValueAtTime(fEnd, now + dur * 0.85);

    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = baseF1 * vowelShift;
    f1.Q.value = 3.2;

    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = baseF2 * vowelShift * f2Boost;
    f2.Q.value = 4.0;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(f1).connect(env);
    osc.connect(f2).connect(env);
    env.connect(spatial.dest);
    osc.start(now);
    osc.stop(now + dur + 0.015);

    this.scheduleFoleyRelease(Math.ceil((dur + 0.04) * 1000), () => {
      try { spatial.transientPanner?.disconnect(); } catch { /* noop */ }
    });
  }

  /** Suspension curb/pothole damped sub-thump + chassis creak. */
  triggerVehicleBump(impulse: number, worldPos?: WorldVec3) {
    const ctx = this.runningContext();
    if (!ctx || !this.buffers || !this.vehiclesUiGain || this.foleyVoices >= MAX_FOLEY_VOICES) return;

    const spatial = this.routeOneShot(ctx, this.vehiclesUiGain, worldPos, 0.16, 2, 2.2, 1.3);
    if (!spatial) return;

    this.foleyVoices++;
    const now = ctx.currentTime;
    const s = clamp(impulse, 0.15, 1.2) * spatial.atten;
    const dest = spatial.dest;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(68, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.095);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, 0.075 * s), now);
    g.gain.exponentialRampToValueAtTime(0.0002, now + 0.11);
    osc.connect(g).connect(dest);
    osc.start(now);
    osc.stop(now + 0.12);

    // Subtle chassis spring creak
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.brown;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 260;
    bp.Q.value = 2.0;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(Math.max(0.0001, 0.032 * s), now + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0002, now + 0.09);
    src.connect(bp).connect(ng).connect(dest);
    src.start(now + 0.005, Math.random() * 3.0, 0.1);

    this.scheduleFoleyRelease(150, () => {
      try { spatial.transientPanner?.disconnect(); } catch { /* noop */ }
    });
  }

  /** Car door metallic latch release (open) or solid damped cabin slam (close). */
  triggerVehicleDoor(open: boolean, worldPos?: WorldVec3) {
    const ctx = this.runningContext();
    if (!ctx || !this.buffers || !this.vehiclesUiGain || this.foleyVoices >= MAX_FOLEY_VOICES) return;

    const spatial = this.routeOneShot(ctx, this.vehiclesUiGain, worldPos, 0.22, 2, 2.0, 1.35);
    if (!spatial) return;

    this.foleyVoices++;
    const now = ctx.currentTime;
    const a = spatial.atten;
    const dest = spatial.dest;

    if (open) {
      const latch = ctx.createOscillator();
      latch.type = 'triangle';
      latch.frequency.setValueAtTime(1850, now);
      latch.frequency.exponentialRampToValueAtTime(1100, now + 0.028);
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(Math.max(0.0001, 0.035 * a), now);
      lg.gain.exponentialRampToValueAtTime(0.0002, now + 0.035);
      latch.connect(lg).connect(dest);
      latch.start(now);
      latch.stop(now + 0.04);

      const seal = ctx.createBufferSource();
      seal.buffer = this.buffers.pink;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 620;
      bp.Q.value = 1.4;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.0001, now + 0.02);
      sg.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.024 * a), now + 0.045);
      sg.gain.exponentialRampToValueAtTime(0.0002, now + 0.095);
      seal.connect(bp).connect(sg).connect(dest);
      seal.start(now + 0.02, Math.random() * 3.0, 0.1);
    } else {
      const thud = ctx.createOscillator();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(115, now);
      thud.frequency.exponentialRampToValueAtTime(42, now + 0.1);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(Math.max(0.0001, 0.088 * a), now);
      tg.gain.exponentialRampToValueAtTime(0.0002, now + 0.12);
      thud.connect(tg).connect(dest);
      thud.start(now);
      thud.stop(now + 0.13);

      const lock = ctx.createOscillator();
      lock.type = 'triangle';
      lock.frequency.setValueAtTime(1420, now + 0.008);
      lock.frequency.exponentialRampToValueAtTime(780, now + 0.032);
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(Math.max(0.0001, 0.028 * a), now + 0.008);
      lg.gain.exponentialRampToValueAtTime(0.0002, now + 0.036);
      lock.connect(lg).connect(dest);
      lock.start(now + 0.008);
      lock.stop(now + 0.042);

      const air = ctx.createBufferSource();
      air.buffer = this.buffers.brown;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 220;
      const ag = ctx.createGain();
      ag.gain.setValueAtTime(Math.max(0.0001, 0.042 * a), now);
      ag.gain.exponentialRampToValueAtTime(0.0002, now + 0.09);
      air.connect(lp).connect(ag).connect(dest);
      air.start(now, Math.random() * 3.0, 0.1);
    }

    this.scheduleFoleyRelease(180, () => {
      try { spatial.transientPanner?.disconnect(); } catch { /* noop */ }
    });
  }

  /** Soft upholstery rustle or wooden chair creak when sitting down or standing up. */
  triggerSeat(sitDown: boolean, material: 'fabric' | 'wood' = 'fabric', worldPos?: WorldVec3) {
    const ctx = this.runningContext();
    if (!ctx || !this.buffers || !this.foleyGain || this.foleyVoices >= MAX_FOLEY_VOICES) return;

    const spatial = this.routeOneShot(ctx, this.foleyGain, worldPos, 0.22, 1, 1.5, 1.4);
    if (!spatial) return;

    this.foleyVoices++;
    const now = ctx.currentTime;
    const a = spatial.atten;
    const dest = spatial.dest;

    if (material === 'wood') {
      const creak = ctx.createOscillator();
      creak.type = 'triangle';
      creak.frequency.setValueAtTime(sitDown ? 290 : 240, now);
      creak.frequency.exponentialRampToValueAtTime(sitDown ? 210 : 310, now + 0.12);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 680;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, now);
      cg.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.028 * a), now + 0.025);
      cg.gain.exponentialRampToValueAtTime(0.0002, now + 0.14);
      creak.connect(lp).connect(cg).connect(dest);
      creak.start(now);
      creak.stop(now + 0.15);
    } else {
      const rustle = ctx.createBufferSource();
      rustle.buffer = this.buffers.pink;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = sitDown ? 560 : 820;
      bp.Q.value = 0.9;
      const rg = ctx.createGain();
      const dur = sitDown ? 0.16 : 0.12;
      rg.gain.setValueAtTime(0.0001, now);
      rg.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.032 * a), now + 0.035);
      rg.gain.exponentialRampToValueAtTime(0.0002, now + dur);
      rustle.connect(bp).connect(rg).connect(dest);
      rustle.start(now, Math.random() * 3.0, dur + 0.02);

      if (sitDown) {
        const puff = ctx.createOscillator();
        puff.type = 'sine';
        puff.frequency.setValueAtTime(110, now);
        puff.frequency.exponentialRampToValueAtTime(68, now + 0.09);
        const pg = ctx.createGain();
        pg.gain.setValueAtTime(Math.max(0.0001, 0.028 * a), now);
        pg.gain.exponentialRampToValueAtTime(0.0002, now + 0.1);
        puff.connect(pg).connect(dest);
        puff.start(now);
        puff.stop(now + 0.11);
      }
    }

    this.scheduleFoleyRelease(200, () => {
      try { spatial.transientPanner?.disconnect(); } catch { /* noop */ }
    });
  }

  /** Crisp mechanical till drawer slide + metallic register bell chime on shop checkout/purchase. */
  triggerShopRegister(sale = true, worldPos?: WorldVec3) {
    const ctx = this.runningContext();
    if (!ctx || !this.buffers || !this.foleyGain || this.foleyVoices >= MAX_FOLEY_VOICES) return;

    const spatial = this.routeOneShot(ctx, this.foleyGain, worldPos, 0.45, 2, 1.8, 1.35);
    if (!spatial) return;

    this.foleyVoices++;
    const now = ctx.currentTime;
    const a = spatial.atten;
    const dest = spatial.dest;

    // Till drawer mechanical slide
    const drawer = ctx.createBufferSource();
    drawer.buffer = this.buffers.pink;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1150;
    bp.Q.value = 1.6;
    const dg = ctx.createGain();
    dg.gain.setValueAtTime(0.0001, now);
    dg.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.028 * a), now + 0.018);
    dg.gain.exponentialRampToValueAtTime(0.0002, now + 0.085);
    drawer.connect(bp).connect(dg).connect(dest);
    drawer.start(now, Math.random() * 3.0, 0.095);

    // Bright dual-harmonic register bell chime
    const freqs = sale ? [1567.98, 3135.96] : [1174.66, 2349.32];
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const bg = ctx.createGain();
      const t0 = now + 0.045;
      bg.gain.setValueAtTime(0.0001, t0);
      bg.gain.exponentialRampToValueAtTime(Math.max(0.0002, (idx === 0 ? 0.042 : 0.018) * a), t0 + 0.005);
      bg.gain.exponentialRampToValueAtTime(0.0002, t0 + (idx === 0 ? 0.36 : 0.22));
      osc.connect(bg).connect(dest);
      osc.start(t0);
      osc.stop(t0 + 0.38);
    });

    this.scheduleFoleyRelease(450, () => {
      try { spatial.transientPanner?.disconnect(); } catch { /* noop */ }
    });
  }

  /** Dedicated tactile foley for Echo Life careers, hobbies, photography, and daily activities. */
  triggerActivityFoley(kind: ActivityFoleyKind, worldPos?: WorldVec3) {
    const ctx = this.runningContext();
    if (!ctx || !this.buffers || !this.foleyGain || this.foleyVoices >= MAX_FOLEY_VOICES) return;

    const spatial = this.routeOneShot(ctx, this.foleyGain, worldPos, 0.6, 2, 1.8, 1.35);
    if (!spatial) return;

    this.foleyVoices++;
    const now = ctx.currentTime;
    const a = spatial.atten;
    const dest = spatial.dest;
    let releaseMs = 460;

    if (kind === 'espresso') {
      // Pressurized steam wand hiss + warm pump hum
      const steam = ctx.createBufferSource();
      steam.buffer = this.buffers.white;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(3600, now);
      bp.frequency.exponentialRampToValueAtTime(2200, now + 0.36);
      bp.Q.value = 1.4;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.0001, now);
      sg.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.045 * a), now + 0.04);
      sg.gain.exponentialRampToValueAtTime(0.0002, now + 0.38);
      steam.connect(bp).connect(sg).connect(dest);
      steam.start(now, Math.random() * 3.0, 0.4);

      const pump = ctx.createOscillator();
      pump.type = 'triangle';
      pump.frequency.value = 115;
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.0001, now);
      pg.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.018 * a), now + 0.04);
      pg.gain.exponentialRampToValueAtTime(0.0002, now + 0.28);
      pump.connect(pg).connect(dest);
      pump.start(now);
      pump.stop(now + 0.3);
    } else if (kind === 'tea_pour') {
      // Rising resonant liquid stream + soft porcelain ring
      const pour = ctx.createBufferSource();
      pour.buffer = this.buffers.pink;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.8;
      bp.frequency.setValueAtTime(650, now);
      bp.frequency.exponentialRampToValueAtTime(1450, now + 0.4);
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.0001, now);
      pg.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.038 * a), now + 0.05);
      pg.gain.exponentialRampToValueAtTime(0.0002, now + 0.42);
      pour.connect(bp).connect(pg).connect(dest);
      pour.start(now, Math.random() * 3.0, 0.44);

      const cup = ctx.createOscillator();
      cup.type = 'sine';
      cup.frequency.value = 2480;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, now + 0.32);
      cg.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.012 * a), now + 0.33);
      cg.gain.exponentialRampToValueAtTime(0.0002, now + 0.44);
      cup.connect(cg).connect(dest);
      cup.start(now + 0.32);
      cup.stop(now + 0.45);
    } else if (kind === 'book_page') {
      // Crisp two-stage paper page turn
      for (const [delay, f0, f1, dur] of [[0, 2800, 4200, 0.055], [0.04, 3400, 2400, 0.065]] as const) {
        const src = ctx.createBufferSource();
        src.buffer = this.buffers.white;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(f0, now + delay);
        bp.frequency.exponentialRampToValueAtTime(f1, now + delay + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now + delay);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.026 * a), now + delay + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0002, now + delay + dur);
        src.connect(bp).connect(g).connect(dest);
        src.start(now + delay, Math.random() * 3.0, dur + 0.02);
      }
      releaseMs = 180;
    } else if (kind === 'garden_water') {
      // Gentle watering-can shower spray
      const body = ctx.createBufferSource();
      body.buffer = this.buffers.pink;
      const bpA = ctx.createBiquadFilter();
      bpA.type = 'bandpass';
      bpA.frequency.value = 1500;
      bpA.Q.value = 0.8;
      const gA = ctx.createGain();
      gA.gain.setValueAtTime(0.0001, now);
      gA.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.036 * a), now + 0.06);
      gA.gain.exponentialRampToValueAtTime(0.0002, now + 0.38);
      body.connect(bpA).connect(gA).connect(dest);
      body.start(now, Math.random() * 3.0, 0.4);

      const spray = ctx.createBufferSource();
      spray.buffer = this.buffers.white;
      const bpB = ctx.createBiquadFilter();
      bpB.type = 'bandpass';
      bpB.frequency.value = 3400;
      bpB.Q.value = 1.2;
      const gB = ctx.createGain();
      gB.gain.setValueAtTime(0.0001, now + 0.02);
      gB.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.022 * a), now + 0.08);
      gB.gain.exponentialRampToValueAtTime(0.0002, now + 0.36);
      spray.connect(bpB).connect(gB).connect(dest);
      spray.start(now + 0.02, Math.random() * 3.0, 0.38);
    } else if (kind === 'guitar_chord') {
      // Warm arpeggiated acoustic guitar Cmaj7 strum
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      lp.connect(dest);
      const notes = [261.63, 329.63, 392.0, 493.88];
      notes.forEach((f, idx) => {
        const t0 = now + idx * 0.022;
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.026 * a), t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0002, t0 + 0.52);
        osc.connect(g).connect(lp);
        osc.start(t0);
        osc.stop(t0 + 0.54);
      });
      releaseMs = 640;
    } else if (kind === 'shutter') {
      // Dual-curtain mechanical camera shutter click
      for (const [delay, freq, amp] of [[0, 3800, 0.048], [0.045, 1450, 0.036]] as const) {
        const src = ctx.createBufferSource();
        src.buffer = this.buffers.white;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = freq;
        bp.Q.value = 2.6;
        const g = ctx.createGain();
        g.gain.setValueAtTime(Math.max(0.0001, amp * a), now + delay);
        g.gain.exponentialRampToValueAtTime(0.0002, now + delay + 0.022);
        src.connect(bp).connect(g).connect(dest);
        src.start(now + delay, Math.random() * 3.0, 0.028);
      }
      releaseMs = 150;
    } else {
      // shift_complete: uplifting 3-note glass marimba cadence
      const triad = [523.25, 659.25, 783.99];
      triad.forEach((f, idx) => {
        const t0 = now + idx * 0.075;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.034 * a), t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0002, t0 + 0.34);
        osc.connect(g).connect(dest);
        osc.start(t0);
        osc.stop(t0 + 0.36);
      });
      releaseMs = 560;
    }

    this.scheduleFoleyRelease(releaseMs, () => {
      try { spatial.transientPanner?.disconnect(); } catch { /* noop */ }
    });
  }

  /** Dual-tone compact EV car horn (`car`/`motorbike`) or crisp metallic bicycle bell (`bike`). */
  triggerHorn(kind: 'car' | 'bike' | 'motorbike' = 'car') {
    const ctx = this.runningContext();
    if (!ctx || !this.vehiclesUiGain) return;
    const now = ctx.currentTime;

    if (kind === 'bike') {
      // Classic bright metallic bicycle bell chime (2093 Hz + 4186 Hz)
      for (const [f, amp, dur] of [[2093, 0.055, 0.52], [4186, 0.028, 0.34]] as const) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(amp, now + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
        osc.connect(g).connect(this.vehiclesUiGain);
        osc.start(now);
        osc.stop(now + dur + 0.02);
      }
      return;
    }

    // Pleasant major-third compact EV horn (A4 440 Hz + C#5 554.37 Hz)
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.052, now + 0.018);
    g.gain.setValueAtTime(0.052, now + 0.19);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.27);
    lp.connect(g).connect(this.vehiclesUiGain);

    for (const f of kind === 'motorbike' ? [493.88, 622.25] : [440, 554.37]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.connect(lp);
      osc.start(now);
      osc.stop(now + 0.29);
    }
  }

  /** Ultra-subtle liquid-glass tactile UI click. */
  triggerUiClick(kind: UiClickKind = 'tap') {
    const ctx = this.runningContext();
    if (!ctx || !this.vehiclesUiGain) return;
    const now = ctx.currentTime;
    const freq = kind === 'confirm' ? 1480 : kind === 'open' ? 1320 : kind === 'close' ? 980 : 1180;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * (kind === 'close' ? 0.82 : 1.12), now + 0.018);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.022, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.022);
    osc.connect(g).connect(this.vehiclesUiGain);
    osc.start(now);
    osc.stop(now + 0.028);
  }

  /** Releases all Web Audio nodes and gesture listeners cleanly (never closes the shared AudioContext). */
  dispose() {
    this.disposed = true;
    this.unbindGestureUnlock();
    this.listeners.clear();
    for (const t of this.foleyTimers) clearTimeout(t);
    this.foleyTimers.clear();
    this.foleyVoices = 0;

    if (typeof setContactAudioSink === 'function') {
      if (typeof getContactAudioSink !== 'function' || getContactAudioSink() === this.foleyGain) {
        setContactAudioSink(null);
      }
    }

    const stopLoop = (v: LoopVoice | null) => {
      if (!v) return;
      try { v.src.stop(); } catch { /* already stopped */ }
      try { v.src.disconnect(); v.filter.disconnect(); v.gain.disconnect(); v.panner?.disconnect(); } catch { /* noop */ }
    };
    for (const v of [
      this.windAir, this.windFoliage, this.riverLow, this.riverHigh,
      this.rainBody, this.rainHiss, this.urbanHum, this.cicadaChorus,
      this.fountainLow, this.fountainMist, this.commuterVoice, this.doorwayBleed,
      this.roomTone, this.cafeFormantA, this.cafeFormantB,
    ]) {
      stopLoop(v);
    }
    if (this.vehicleGraph) {
      const vg = this.vehicleGraph;
      for (const n of [vg.motorOscA, vg.motorOscB, vg.tireSrc, vg.brakeSrc, vg.driftSrcA, vg.driftSrcB, vg.aeroSrc]) {
        try { n.stop(); } catch { /* already stopped */ }
        try { n.disconnect(); } catch { /* noop */ }
      }
      for (const n of [
        vg.motorSubGain, vg.motorFilter, vg.motorGain,
        vg.tireFilter, vg.tireGain, vg.brakeFilter, vg.brakeGain,
        vg.driftFilterA, vg.driftFilterB, vg.driftGain,
        vg.aeroFilter, vg.aeroGain,
      ]) {
        try { n.disconnect(); } catch { /* noop */ }
      }
      this.vehicleGraph = null;
    }

    for (const slot of this.oneShotPool) {
      try { slot.panner.disconnect(); } catch { /* noop */ }
    }
    this.oneShotPool = [];

    for (const n of [
      this.riverPanner, this.fountainPanner, this.venueFeaturePanner, this.doorwayBleedPanner,
      this.reverbSend, this.convA, this.wetA, this.convB, this.wetB,
      this.outdoorLpf, this.outdoorGain, this.ambienceGain, this.foleyGain,
      this.vehiclesUiGain, this.masterGain, this.limiter,
    ]) {
      try { n?.disconnect(); } catch { /* noop */ }
    }

    this.windAir = this.windFoliage = this.riverLow = this.riverHigh = null;
    this.rainBody = this.rainHiss = this.urbanHum = this.cicadaChorus = null;
    this.fountainLow = this.fountainMist = this.commuterVoice = this.doorwayBleed = null;
    this.roomTone = this.cafeFormantA = this.cafeFormantB = null;
    this.riverPanner = this.fountainPanner = this.venueFeaturePanner = this.doorwayBleedPanner = null;
    this.reverbSend = this.convA = this.wetA = this.convB = this.wetB = null;
    this.outdoorLpf = this.outdoorGain = this.ambienceGain = this.foleyGain = null;
    this.vehiclesUiGain = this.masterGain = this.limiter = null;
    this.buffers = null;
    this.irBuffers = null;
    this.hrtfSupported = false;
    this.activePreset = 'outdoor_open';
    this.wetSuspended = false;
    this.listenerPos = null;
    this.prevBlinkerLit = false;
    this.prevCommuterDist = null;
    this.graphReady = false;
  }
}
