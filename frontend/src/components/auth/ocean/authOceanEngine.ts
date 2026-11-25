import * as THREE from 'three';
import { loadWhaleRig, type WhaleRig } from '@/components/landing/ocean/whaleRig';
import { ECHO_MODEL_URL } from '@/components/landing/ocean/echoAssets';
import type { EchoCarry, JourneyStage } from '@/lib/journey/journey';
import {
  GLOW_FRAGMENT,
  GLOW_VERTEX,
  LAND_FRAGMENT,
  LAND_VERTEX,
  OCEAN_FRAGMENT,
  OCEAN_VERTEX,
  PARTICLE_FRAGMENT,
  PARTICLE_VERTEX,
  RIPPLE_SLOTS,
  SKY_FRAGMENT,
  SKY_VERTEX,
} from './authOceanShaders';

/**
 * The sign-in world as one 3D scene: a sky dome with sun / moon, drifting clouds and stars, Gerstner-wave water that
 * reflects that same sky and melts into its horizon, hazy islands with a lighthouse and their wavering reflections, and
 * Echo — the rigged model of the landing page — swimming through the water: cruising under the surface, rising to blow,
 * diving, sometimes leaping, its body cutting rings and foam into the sea it touches.
 *
 * Decoration only: no request except the model file, nothing read from the page but its size, pointer and theme.
 * Everything runs in this module's own requestAnimationFrame loop (no React state per frame) and sleeps when the tab is
 * hidden; reduced motion draws still frames only.
 */

export type AuthSky = 'day' | 'dawn';
export type AuthMood = 'idle' | 'email-focus' | 'password-focus' | 'password-visible' | 'submitting' | 'success' | 'error';

export interface AuthOceanOptions {
  canvas: HTMLCanvasElement;
  sky: AuthSky;
  night: boolean;
  reducedMotion: boolean;
  /** The first frame of the living scene is on screen. */
  onLive: () => void;
  /** The scene cannot run here (no WebGL, lost context); the CSS world stays. */
  onFail: (reason: string) => void;
  /** Lifecycle markers for QA (no console output): engine starting → live; echo loading → swimming | missing;
   *  motion = Echo's current swim phase. */
  onState?: (key: 'engine' | 'echo' | 'motion', state: string) => void;
}

export interface AuthOceanEngine {
  setSky(sky: AuthSky, night: boolean): void;
  setMood(mood: AuthMood): void;
  /** While a form field has focus the camera holds still (no parallax while typing). */
  setCalm(calm: boolean): void;
  /** A tap on open water: a ripple where it lands, and Echo grows curious. Returns false when it missed the sea. */
  tap(clientX: number, clientY: number): boolean;
  /** How the journey (lib/journey) sends Echo away and brings it back. */
  stage: JourneyStage;
  dispose(): void;
}

/** A journey's path across the sea, in world x / z: a cubic Hermite in time, continuous in position and velocity at both ends. */
interface SeaFlight {
  start: number; ms: number;
  x0: number; z0: number; vx0: number; vz0: number;
  x1: number; z1: number; vx1: number; vz1: number;
  onEnd: (() => void) | null;
  blowAt: number;
  /** Fraction of the path at which Echo launches out of the water (the arrival's breach); negative = never. */
  leapAt: number;
}

// ── Palettes ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface Palette {
  zenith: string; horizon: string; haze: string; sun: string; sunIntensity: number;
  sunAz: number; sunEl: number; sunDisc: number; moon: number; stars: number;
  cloudLit: string; cloudShade: string; cloudCover: number;
  deep: string; scatter: string; foam: string; sunVisible: number;
  land: string; landLit: string; hemiSky: string; hemiGround: string; lamp: number;
  exposure: number;
}

const PALETTES: Record<'day' | 'dawn' | 'nightDay' | 'nightDawn', Palette> = {
  day: {
    zenith: '#1450d2', horizon: '#76b6f5', haze: '#cfe8ff', sun: '#fff1d6', sunIntensity: 1,
    sunAz: -0.02, sunEl: 0.105, sunDisc: 0.99965, moon: 0, stars: 0,
    cloudLit: '#ffffff', cloudShade: '#9db8e2', cloudCover: 0.58,
    deep: '#05358d', scatter: '#12a9d6', foam: '#f4fbff', sunVisible: 1,
    land: '#6d93cf', landLit: '#a9c8ee', hemiSky: '#cfe6ff', hemiGround: '#1d5fb0', lamp: 0.15,
    exposure: 1.0,
  },
  dawn: {
    zenith: '#3f47c4', horizon: '#f7a6c0', haze: '#ffd6cc', sun: '#ffc796', sunIntensity: 1,
    sunAz: -0.34, sunEl: 0.032, sunDisc: 0.99955, moon: 0, stars: 0,
    cloudLit: '#ffe5ee', cloudShade: '#9a82cc', cloudCover: 0.6,
    deep: '#24267e', scatter: '#8b77de', foam: '#fff1f6', sunVisible: 1,
    land: '#7c68c4', landLit: '#e0a5cf', hemiSky: '#ffd6e2', hemiGround: '#3a3696', lamp: 0.6,
    exposure: 1.0,
  },
  nightDay: {
    zenith: '#02061a', horizon: '#1b2c66', haze: '#2b3c80', sun: '#a9bcff', sunIntensity: 0.35,
    sunAz: 0.36, sunEl: 0.30, sunDisc: 0.99975, moon: 1, stars: 1,
    cloudLit: '#3a4a88', cloudShade: '#121a42', cloudCover: 0.36,
    deep: '#020a24', scatter: '#123366', foam: '#7c90c6', sunVisible: 0.45,
    land: '#101a46', landLit: '#26346f', hemiSky: '#3e55a8', hemiGround: '#050c2a', lamp: 1,
    exposure: 1.0,
  },
  nightDawn: {
    zenith: '#06031a', horizon: '#38216c', haze: '#4a2e80', sun: '#c7b2ff', sunIntensity: 0.35,
    sunAz: 0.36, sunEl: 0.30, sunDisc: 0.99975, moon: 1, stars: 1,
    cloudLit: '#4a3a88', cloudShade: '#1a1242', cloudCover: 0.36,
    deep: '#0a0626', scatter: '#2e1d66', foam: '#9a8cc8', sunVisible: 0.45,
    land: '#170f46', landLit: '#352770', hemiSky: '#5a42a8', hemiGround: '#0a0626', lamp: 1,
    exposure: 1.0,
  },
};

const paletteFor = (sky: AuthSky, night: boolean) =>
  night ? (sky === 'dawn' ? PALETTES.nightDawn : PALETTES.nightDay) : sky === 'dawn' ? PALETTES.dawn : PALETTES.day;

interface LivePalette {
  zenith: THREE.Color; horizon: THREE.Color; haze: THREE.Color; sun: THREE.Color; cloudLit: THREE.Color;
  cloudShade: THREE.Color; deep: THREE.Color; scatter: THREE.Color; foam: THREE.Color; land: THREE.Color;
  landLit: THREE.Color; hemiSky: THREE.Color; hemiGround: THREE.Color;
  sunIntensity: number; sunAz: number; sunEl: number; sunDisc: number; moon: number; stars: number; cloudCover: number;
  sunVisible: number; lamp: number; exposure: number;
}
const COLOR_KEYS = ['zenith', 'horizon', 'haze', 'sun', 'cloudLit', 'cloudShade', 'deep', 'scatter', 'foam', 'land', 'landLit', 'hemiSky', 'hemiGround'] as const;
const NUMBER_KEYS = ['sunIntensity', 'sunAz', 'sunEl', 'sunDisc', 'moon', 'stars', 'cloudCover', 'sunVisible', 'lamp', 'exposure'] as const;

function toLive(p: Palette): LivePalette {
  const live = {} as LivePalette;
  for (const k of COLOR_KEYS) (live as unknown as Record<string, THREE.Color>)[k] = new THREE.Color(p[k]);
  for (const k of NUMBER_KEYS) (live as unknown as Record<string, number>)[k] = p[k];
  return live;
}
function lerpPalette(out: LivePalette, a: LivePalette, b: LivePalette, t: number) {
  for (const k of COLOR_KEYS) out[k].copy(a[k]).lerp(b[k], t);
  for (const k of NUMBER_KEYS) (out as unknown as Record<string, number>)[k] = a[k] + (b[k] - a[k]) * t;
}
function clonePalette(p: LivePalette): LivePalette {
  const c = {} as LivePalette;
  for (const k of COLOR_KEYS) (c as unknown as Record<string, THREE.Color>)[k] = p[k].clone();
  for (const k of NUMBER_KEYS) (c as unknown as Record<string, number>)[k] = p[k];
  return c;
}

// ── Waves (shared by the GPU and Echo's contact test) ────────────────────────────────────────────────────────────
// x, z = direction; z = steepness; w = wavelength (world units)
const WAVES: Array<[number, number, number, number]> = [
  [Math.cos(0.35), Math.sin(0.35), 0.17, 28],
  [Math.cos(-0.55), Math.sin(-0.55), 0.15, 15],
  [Math.cos(1.15), Math.sin(1.15), 0.12, 8.5],
  [Math.cos(-1.05), Math.sin(-1.05), 0.1, 5.2],
  [Math.cos(0.75), Math.sin(0.75), 0.08, 3.1],
  [Math.cos(-0.2), Math.sin(-0.2), 0.06, 1.9],
];
const WAVE_SCALE = 0.5;
const WAVE_SPEED = 0.55;

/** The vertical part of the Gerstner sum at a point (horizontal drift ignored: close enough for contact tests). */
function waveHeight(x: number, z: number, waveTime: number): number {
  let h = 0;
  for (const [dx, dz, steepness, length] of WAVES) {
    const k = (Math.PI * 2) / length;
    const c = Math.sqrt(9.8 / k);
    const s = steepness * WAVE_SCALE;
    h += (s / k) * Math.sin(k * (dx * x + dz * z - c * waveTime));
  }
  return h;
}

// ── Islands (silhouettes at sea level, x / y in world units) ─────────────────────────────────────────────────────
const FAR_RANGE: Array<[number, number]> = [
  [-640, -3], [-640, 6], [-560, 14], [-500, 26], [-450, 22], [-400, 34], [-340, 30], [-300, 18], [-250, 12], [-215, 4],
  [-215, -3],
];
const FAR_RANGE_RIGHT: Array<[number, number]> = [
  [120, -3], [120, 4], [170, 14], [230, 22], [270, 36], [320, 31], [360, 44], [420, 38], [470, 26], [540, 30], [610, 16],
  [680, 8], [680, -3],
];
const HEADLAND: Array<[number, number]> = [
  [-118, -2], [-118, 2], [-100, 6], [-84, 9], [-70, 13], [-58, 12], [-48, 9.5], [-40, 9], [-32, 8.5], [-28, 7.6],
  [-24, 5.4], [-18, 3.4], [-10, 2], [-4, 0.8], [0, -2],
];
const LIGHTHOUSE = { x: -34, y: 8.8, z: -270, height: 6.4 };

function silhouette(points: Array<[number, number]>): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  return new THREE.ShapeGeometry(shape, 1);
}

function lighthouseGeometry(): THREE.BufferGeometry {
  const { x, y, height } = LIGHTHOUSE;
  const w0 = 1.3, w1 = 0.8;
  const pts: Array<[number, number]> = [
    [x - w0, y], [x + w0, y], [x + w1, y + height], [x + w1 + 0.35, y + height], [x + w1 + 0.35, y + height + 0.5],
    [x + 0.6, y + height + 0.5], [x + 0.6, y + height + 1.5], [x + 0.9, y + height + 1.5], [x, y + height + 2.6],
    [x - 0.9, y + height + 1.5], [x - 0.6, y + height + 1.5], [x - 0.6, y + height + 0.5], [x - w1 - 0.35, y + height + 0.5],
    [x - w1 - 0.35, y + height], [x - w1, y + height],
  ];
  return silhouette(pts);
}

// ── Particles ────────────────────────────────────────────────────────────────────────────────────────────────────
interface ParticlePool {
  points: THREE.Points;
  positions: Float32Array;
  velocities: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  sizes: Float32Array;
  baseSizes: Float32Array;
  alphas: Float32Array;
  next: number;
  count: number;
  gravity: number;
  drag: number;
  grow: number;
  material: THREE.ShaderMaterial;
}

function createPool(count: number, color: string, soft: number, gravity: number, drag: number, grow: number, blending: THREE.Blending): ParticlePool {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage));
  const material = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERTEX,
    fragmentShader: PARTICLE_FRAGMENT,
    uniforms: { uColor: { value: new THREE.Color(color) }, uSoft: { value: soft }, uPixelRatio: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 6;
  return {
    points, positions, velocities: new Float32Array(count * 3), life: new Float32Array(count), maxLife: new Float32Array(count),
    sizes, baseSizes: new Float32Array(count), alphas, next: 0, count, gravity, drag, grow, material,
  };
}

function emit(pool: ParticlePool, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number) {
  const i = pool.next;
  pool.next = (pool.next + 1) % pool.count;
  pool.positions[i * 3] = x; pool.positions[i * 3 + 1] = y; pool.positions[i * 3 + 2] = z;
  pool.velocities[i * 3] = vx; pool.velocities[i * 3 + 1] = vy; pool.velocities[i * 3 + 2] = vz;
  pool.life[i] = life; pool.maxLife[i] = life; pool.baseSizes[i] = size;
}

function stepPool(pool: ParticlePool, dt: number, waterLevel: (x: number, z: number) => number) {
  let any = false;
  for (let i = 0; i < pool.count; i++) {
    if (pool.life[i] <= 0) {
      pool.alphas[i] = 0;
      continue;
    }
    any = true;
    pool.life[i] -= dt;
    const j = i * 3;
    pool.velocities[j + 1] -= pool.gravity * dt;
    const damp = Math.exp(-pool.drag * dt);
    pool.velocities[j] *= damp; pool.velocities[j + 1] *= pool.gravity > 0 ? 1 : damp; pool.velocities[j + 2] *= damp;
    pool.positions[j] += pool.velocities[j] * dt;
    pool.positions[j + 1] += pool.velocities[j + 1] * dt;
    pool.positions[j + 2] += pool.velocities[j + 2] * dt;
    const k = Math.max(0, pool.life[i] / pool.maxLife[i]);
    if (pool.gravity > 0 && pool.positions[j + 1] < waterLevel(pool.positions[j], pool.positions[j + 2]) - 0.05) pool.life[i] = 0;
    pool.sizes[i] = pool.baseSizes[i] * (1 + (1 - k) * pool.grow);
    pool.alphas[i] = Math.min(1, k * 2.2) * (pool.gravity > 0 ? 0.95 : 0.42);
  }
  const geometry = pool.points.geometry;
  (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  (geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  (geometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  return any;
}

// ── Engine ───────────────────────────────────────────────────────────────────────────────────────────────────────
const ECHO_LENGTH = 5.6; // world units on wide screens: a young whale next to waves of a few metres
const ECHO_LENGTH_PORTRAIT = 3.2;
const CRUISE_SPEED = 2.5;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const damp = (current: number, target: number, rate: number, dt: number) => current + (target - current) * (1 - Math.exp(-rate * dt));
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

type DivePhase = 'cruise' | 'rise' | 'surface' | 'dive' | 'charge' | 'air';

export function createAuthOceanEngine(options: AuthOceanOptions): AuthOceanEngine {
  const { canvas, reducedMotion } = options;
  const abort = new AbortController();
  let disposed = false;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false });
  } catch {
    queueMicrotask(() => options.onFail('webgl'));
    return {
      setSky() {}, setMood() {}, setCalm() {}, tap: () => false, dispose() {},
      stage: { depart: () => Promise.resolve(null), arrive() {}, awaitArrival() {}, isLive: () => false },
    };
  }
  const state = (s: string) => options.onState?.('engine', s);
  const echoState = (s: string) => options.onState?.('echo', s);
  state('starting');
  echoState('loading');

  const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 600;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  const maxRatio = Math.min(window.devicePixelRatio || 1, coarse || smallScreen ? 1.5 : 1.75);
  let pixelRatio = maxRatio;
  renderer.setPixelRatio(pixelRatio);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 4000);

  // palette (current, transition from, transition to)
  let target = toLive(paletteFor(options.sky, options.night));
  let from = clonePalette(target);
  const live = clonePalette(target);
  let paletteT = 1;

  // shared sky uniforms (one object per uniform, referenced by every material)
  const skyU = {
    uZenith: { value: live.zenith }, uHorizon: { value: live.horizon }, uHaze: { value: live.haze },
    uSunColor: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 0.1, -1) },
    uCloudLit: { value: live.cloudLit }, uCloudShade: { value: live.cloudShade }, uCloudCover: { value: live.cloudCover },
    uTime: { value: 0 },
  };

  // sky dome
  const skyMaterial = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    uniforms: { ...skyU, uSunDisc: { value: live.sunDisc }, uStars: { value: live.stars }, uMoon: { value: live.moon } },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
  skyMaterial.depthFunc = THREE.LessEqualDepth;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), skyMaterial);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);

  // islands + reflections
  const landMeshes: THREE.Mesh[] = [];
  const landMaterials: THREE.ShaderMaterial[] = [];
  const addLand = (geometry: THREE.BufferGeometry, z: number, haze: number, top: number) => {
    for (const mirror of [0, 1]) {
      const material = new THREE.ShaderMaterial({
        vertexShader: LAND_VERTEX,
        fragmentShader: LAND_FRAGMENT,
        uniforms: {
          ...skyU, uLand: { value: live.land }, uLandLit: { value: live.landLit }, uHazeAmount: { value: haze },
          uMirror: { value: mirror }, uTop: { value: top },
        },
        transparent: mirror === 1,
        depthWrite: mirror === 0,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = z;
      mesh.renderOrder = mirror ? 3 : -5;
      scene.add(mesh);
      landMeshes.push(mesh);
      landMaterials.push(material);
    }
  };
  const farGeometry = silhouette(FAR_RANGE);
  const farRightGeometry = silhouette(FAR_RANGE_RIGHT);
  const headlandGeometry = silhouette(HEADLAND);
  const towerGeometry = lighthouseGeometry();
  addLand(farGeometry, -560, 0.62, 34);
  addLand(farRightGeometry, -600, 0.66, 44);
  addLand(headlandGeometry, LIGHTHOUSE.z, 0.38, 13);
  addLand(towerGeometry, LIGHTHOUSE.z + 0.5, 0.3, LIGHTHOUSE.y + LIGHTHOUSE.height + 2.6);

  // the lighthouse lamp: a glow that sweeps past the viewer every few seconds
  const lampMaterial = new THREE.ShaderMaterial({
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    uniforms: { uColor: { value: new THREE.Color('#fff2c4') }, uIntensity: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const lamp = new THREE.Mesh(new THREE.PlaneGeometry(26, 10), lampMaterial);
  lamp.position.set(LIGHTHOUSE.x, LIGHTHOUSE.y + LIGHTHOUSE.height + 0.95, LIGHTHOUSE.z + 1);
  lamp.renderOrder = 4;
  scene.add(lamp);

  // ocean: a trapezoid grid, dense near the camera, reaching far past the haze
  const buildOcean = (cols: number, rows: number) => {
    const positions: number[] = [];
    const indices: number[] = [];
    const near = 6, far = 1700;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const z = near - (far + near) * Math.pow(t, 2.4);
      const dist = Math.max(1, near - z + 8);
      const half = 14 + dist * 1.45;
      for (let c = 0; c <= cols; c++) {
        const u = (c / cols) * 2 - 1;
        positions.push(u * half, 0, z);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        const b = a + cols + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b); // counter-clockwise seen from above (front face up)
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    return geometry;
  };
  const oceanGeometry = coarse || smallScreen ? buildOcean(150, 210) : buildOcean(240, 330);
  const ripples = Array.from({ length: RIPPLE_SLOTS }, () => new THREE.Vector4(0, 0, -100, 0));
  let rippleNext = 0;
  const oceanMaterial = new THREE.ShaderMaterial({
    vertexShader: OCEAN_VERTEX,
    fragmentShader: OCEAN_FRAGMENT,
    uniforms: {
      ...skyU,
      uWaveTime: { value: 0 },
      uWaveScale: { value: WAVE_SCALE },
      uWaves: { value: WAVES.map(([x, z, s, l]) => new THREE.Vector4(x, z, s, l)) },
      uRipples: { value: ripples },
      uDeep: { value: live.deep },
      uScatter: { value: live.scatter },
      uFoamColor: { value: live.foam },
      uSunVisible: { value: live.sunVisible },
      uFogDensity: { value: 0.0042 },
      uNearAlpha: { value: 0.66 },
      uDetail: { value: coarse || smallScreen ? 0.6 : 1 },
      uEcho: { value: new THREE.Vector4(0, 0, 1, 0) },
    },
    transparent: true,
    depthWrite: false,
  });
  const ocean = new THREE.Mesh(oceanGeometry, oceanMaterial);
  ocean.frustumCulled = false;
  ocean.renderOrder = 2;
  scene.add(ocean);
  // the water column under the semi-clear near sea (what Echo swims in front of)
  const abyssMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color() });
  const abyss = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), abyssMaterial);
  abyss.rotation.x = -Math.PI / 2;
  abyss.renderOrder = 1;
  scene.add(abyss);

  // splashes and Echo's blow
  const drops = createPool(coarse ? 260 : 420, '#f4fbff', 0.32, 9.8, 0.35, 0.2, THREE.NormalBlending);
  const mist = createPool(coarse ? 90 : 140, '#ffffff', 0.5, 0, 1.1, 2.6, THREE.NormalBlending);
  scene.add(drops.points, mist.points);

  // lights for Echo
  const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x224488, 1.15);
  // The same pale, luminous Echo as under the water on the Landing: light on the side the viewer sees, a cool rim from behind.
  const echoFill = new THREE.DirectionalLight(0xbfe6ff, 1.5);
  echoFill.position.set(-0.4, 0.3, 1);
  const echoRim = new THREE.DirectionalLight(0xa5f3fc, 1.4);
  echoRim.position.set(-0.7, 0.6, -1);
  scene.add(sunLight, hemi, sunLight.target, echoFill, echoRim);

  const ripple = (x: number, z: number, strength: number, when = clock) => {
    ripples[rippleNext].set(x, z, when, strength);
    rippleNext = (rippleNext + 1) % RIPPLE_SLOTS;
  };

  // ── layout: where the horizon sits and where Echo swims, per screen shape ──
  const layout = {
    lane: new THREE.Vector3(-6, 0, -20),
    radiusX: 5,
    radiusZ: 5,
    basePos: new THREE.Vector3(0, 2.5, 9),
    lookAt: new THREE.Vector3(0, 1.8, -60),
  };
  const raycaster = new THREE.Raycaster();
  const seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const pointOnSea = (ndcX: number, ndcY: number) => {
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    return raycaster.ray.intersectPlane(seaPlane, hit) ? hit.clone() : null;
  };

  let width = 1, height = 1;
  const applyLayout = () => {
    width = Math.max(1, canvas.clientWidth);
    height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    const aspect = width / height;
    const portrait = aspect < 0.95 || width < 900;
    camera.aspect = aspect;
    camera.fov = portrait ? 56 : aspect > 2.1 ? 34 : 38;
    // horizon height on screen (NDC): low on wide screens (the sky carries the story), high on phones (the sea fills it)
    const horizonNdc = portrait ? 0.78 : -0.14;
    const camHeight = portrait ? 2.1 : 2.5;
    layout.basePos.set(0, camHeight, 9);
    const pitch = Math.atan(horizonNdc * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    layout.lookAt.set(0, camHeight - Math.tan(pitch) * 100, 9 - 100);
    camera.position.copy(layout.basePos);
    camera.lookAt(layout.lookAt);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // Echo's lane: under the story on wide screens (left of the form), beside the headline on phones
    const anchor = portrait ? pointOnSea(0.6, 0.56) : pointOnSea(-0.44, -0.5);
    if (anchor) {
      const dist = anchor.distanceTo(camera.position);
      layout.radiusX = THREE.MathUtils.clamp(dist * (portrait ? 0.055 : 0.2), 1.1, 7);
      layout.radiusZ = THREE.MathUtils.clamp(dist * (portrait ? 0.12 : 0.16), 2, 6);
      // the lane's near edge stays at the anchor: Echo never swims up to the lens
      layout.lane.copy(anchor).add(new THREE.Vector3(0, 0, -layout.radiusZ * 1.1));
    }
    const projection = pixelRatio * (height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))));
    drops.material.uniforms.uPixelRatio.value = projection;
    mist.material.uniforms.uPixelRatio.value = projection;
    abyss.position.set(layout.lane.x, -6, layout.lane.z);
    echoLength = portrait ? ECHO_LENGTH_PORTRAIT : ECHO_LENGTH;
    echo?.root.scale.setScalar(echoLength);
    if (reducedMotion) frame(performance.now(), true);
  };

  // ── Echo ──
  let echo: WhaleRig | null = null;
  let echoLength = ECHO_LENGTH;
  const echoU = { uWaterLevel: { value: 0 }, uWaterTint: { value: new THREE.Color() }, uWet: { value: 0 } };
  const echoMaterials: THREE.MeshStandardMaterial[] = [];
  const swim = {
    pos: new THREE.Vector3(-6, -2.6, -32),
    yaw: 0.6,
    pitch: 0,
    roll: 0,
    vy: 0,
    speed: CRUISE_SPEED,
    turn: 0,
    waypoint: new THREE.Vector3(),
    phase: 'cruise' as DivePhase,
    phaseTime: 0,
    phaseLength: 4,
    surfacings: 0,
    leapQueued: false,
    blew: false,
    excitement: 0,
    contactClock: 0,
    wasAbove: false,
    curiosity: null as THREE.Vector3 | null,
    curiosityUntil: 0,
    arrived: false,
  };

  // The journey (10 §BK): `awaiting` keeps Echo out of sight until it swims in; `seaFlight` is a scripted exit or entrance.
  let awaiting = false;
  let seaFlight: SeaFlight | null = null;
  let pendingCarry: EchoCarry | null = null;
  const edgeOf = (z: number, dir: number) => {
    const distance = camera.position.z - z;
    return dir * (distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect * 1.04 + echoLength * 0.62);
  };
  const pixelsPerUnit = (z: number) => height / (2 * (camera.position.z - z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));

  const swimIn = (carry: EchoCarry) => {
    pendingCarry = null;
    if (!echo) return;
    awaiting = false;
    echo.root.visible = true;
    echo.setSwimTime(carry.tail);
    const z = layout.lane.z;
    const speed = THREE.MathUtils.clamp(carry.speed / pixelsPerUnit(z), 7, 42);
    const k = echoLength / ECHO_LENGTH;
    swim.arrived = true;
    swim.pos.set(edgeOf(z, -carry.dir), -0.3 * k, z);
    swim.vy = 0;
    swim.pitch = 0;
    swim.yaw = (carry.dir * Math.PI) / 2;
    swim.speed = speed;
    swim.turn = 0;
    swim.excitement = 0.8;
    setPhase('surface', 9);
    swim.wasAbove = false;
    pickWaypoint();
    seaFlight = {
      start: performance.now(),
      ms: 1500,
      x0: swim.pos.x, z0: z, vx0: carry.dir * speed, vz0: 0,
      x1: layout.lane.x + carry.dir * layout.radiusX * 0.7, z1: layout.lane.z, vx1: carry.dir * CRUISE_SPEED * 1.6, vz1: 0,
      blowAt: -1,
      leapAt: 0.3,
      onEnd: () => {
        // Still in the air: the ordinary arc finishes the leap and its splash.
        setPhase(swim.pos.y > waveHeight(swim.pos.x, swim.pos.z, waveClock()) ? 'air' : 'surface', 2.4);
        swim.blew = true;
      },
    };
  };

  const pickWaypoint = () => {
    const a = Math.random() * Math.PI * 2;
    const r = 0.25 + Math.random() * 0.55;
    swim.waypoint.set(layout.lane.x + Math.cos(a) * layout.radiusX * r, 0, layout.lane.z + Math.sin(a) * layout.radiusZ * r);
  };

  const prepareEcho = (rig: WhaleRig) => {
    rig.root.scale.setScalar(echoLength);
    rig.root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of list) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        echoMaterials.push(material);
        const previous = material.onBeforeCompile;
        // Under the surface the body takes the colour of the water above it (the sea is semi-clear near the viewer).
        material.onBeforeCompile = (shader, r) => {
          previous.call(material, shader, r);
          shader.uniforms.uWaterLevel = echoU.uWaterLevel;
          shader.uniforms.uWaterTint = echoU.uWaterTint;
          shader.uniforms.uWet = echoU.uWet;
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
uniform float uWaterLevel;
uniform vec3 uWaterTint;
uniform float uWet;`)
            .replace('#include <opaque_fragment>', `#include <opaque_fragment>
float ecUnder = clamp((uWaterLevel - vCausticPos.y) / 3.2, 0.0, 1.0);
float ecWaterline = exp(-pow((vCausticPos.y - uWaterLevel) * 7.0, 2.0)) * 0.35;
gl_FragColor.rgb = mix(gl_FragColor.rgb, uWaterTint, ecUnder * 0.55);
gl_FragColor.rgb += vec3(0.9, 0.97, 1.0) * ecWaterline * (1.0 - ecUnder);
gl_FragColor.rgb += vec3(1.0) * uWet * 0.06 * (1.0 - ecUnder);`);
        };
        material.customProgramCacheKey = () => 'auth-echo-water';
        material.needsUpdate = true;
      }
    });
    scene.add(rig.root);
    pickWaypoint();
  };

  const loadEcho = async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const attemptAbort = new AbortController();
      const cancel = () => attemptAbort.abort();
      abort.signal.addEventListener('abort', cancel);
      const ceiling = window.setTimeout(cancel, 25_000);
      try {
        const rig = await loadWhaleRig(ECHO_MODEL_URL, attemptAbort.signal);
        if (disposed) {
          rig.dispose();
          return;
        }
        prepareEcho(rig);
        try {
          await renderer.compileAsync(rig.root, camera, scene);
        } catch {
          // compiled on first draw instead
        }
        if (disposed) return;
        echo = rig;
        if (awaiting) rig.root.visible = false;
        if (pendingCarry) swimIn(pendingCarry);
        if (reducedMotion) {
          rig.pose();
          swim.pos.set(layout.lane.x, -0.35, layout.lane.z);
          swim.pitch = 0.08;
          swim.arrived = true;
          frame(performance.now(), true);
        }
        echoState('swimming');
        return;
      } catch {
        if (disposed) return;
      } finally {
        window.clearTimeout(ceiling);
        abort.signal.removeEventListener('abort', cancel);
      }
    }
    echoState('missing');
  };

  // ── behaviour ──
  const setPhase = (phase: DivePhase, length: number) => {
    swim.phase = phase;
    options.onState?.('motion', phase);
    swim.phaseTime = 0;
    swim.phaseLength = length;
    if (phase === 'surface') swim.blew = false;
  };

  const splash = (x: number, y: number, z: number, power: number) => {
    const n = Math.round(18 + power * 46);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = (0.6 + Math.random() * 1.8) * (0.6 + power * 0.6);
      emit(drops, x + Math.cos(a) * 0.4, y + 0.05, z + Math.sin(a) * 0.4, Math.cos(a) * out, 2 + Math.random() * 3.2 * (0.5 + power), Math.sin(a) * out, 1.4, 0.05 + Math.random() * 0.09);
    }
    for (let i = 0; i < 6 + power * 6; i++) {
      emit(mist, x + (Math.random() - 0.5) * 1.6, y + 0.2, z + (Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6, 1.6 + Math.random(), 0.4 + Math.random() * 0.4);
    }
    ripple(x, z, 0.8 + power * 0.9);
  };

  const blow = (x: number, y: number, z: number) => {
    for (let i = 0; i < 36; i++) {
      emit(mist, x + (Math.random() - 0.5) * 0.18, y, z + (Math.random() - 0.5) * 0.18, (Math.random() - 0.5) * 0.35 + 0.25, 3.2 + Math.random() * 2.4, (Math.random() - 0.5) * 0.35, 1.8 + Math.random() * 1.2, 0.18 + Math.random() * 0.22);
    }
    for (let i = 0; i < 14; i++) {
      emit(drops, x, y + 0.1, z, (Math.random() - 0.5) * 0.9, 3.5 + Math.random() * 2, (Math.random() - 0.5) * 0.9, 1.2, 0.04 + Math.random() * 0.04);
    }
  };

  const tmp = new THREE.Vector3();
  const spine = [new THREE.Vector3(0, 0.02, 0.42), new THREE.Vector3(0, 0.12, 0.05), new THREE.Vector3(0, 0.05, -0.42)];

  const updateEcho = (dt: number, waveTime: number) => {
    if (!echo) return;
    if (awaiting) {
      oceanMaterial.uniforms.uEcho.value.w = 0;
      return;
    }
    // arrival: Echo swims in from the deep, far side
    if (!swim.arrived) {
      swim.arrived = true;
      swim.pos.set(layout.lane.x + layout.radiusX * 1.6, -2.8, layout.lane.z - layout.radiusZ * 1.4);
      swim.yaw = Math.atan2(layout.lane.x - swim.pos.x, layout.lane.z - swim.pos.z);
      setPhase('rise', 3.2);
    }
    swim.phaseTime += dt;
    swim.excitement = damp(swim.excitement, 0, 0.6, dt);
    const level = waveHeight(swim.pos.x, swim.pos.z, waveTime);

    if (seaFlight) {
      // The journey's path replaces the lap: exact in time; the body stays where the sea can show it, its back breaking the water.
      const f = seaFlight;
      const seconds = f.ms / 1000;
      const t = Math.min(1, (performance.now() - f.start) / f.ms);
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const d00 = (6 * t2 - 6 * t) / seconds;
      const d10 = 3 * t2 - 4 * t + 1;
      const d01 = (-6 * t2 + 6 * t) / seconds;
      const d11 = 3 * t2 - 2 * t;
      swim.pos.x = h00 * f.x0 + h10 * seconds * f.vx0 + h01 * f.x1 + h11 * seconds * f.vx1;
      swim.pos.z = h00 * f.z0 + h10 * seconds * f.vz0 + h01 * f.z1 + h11 * seconds * f.vz1;
      const vx = d00 * f.x0 + d10 * f.vx0 + d01 * f.x1 + d11 * f.vx1;
      const vz = d00 * f.z0 + d10 * f.vz0 + d01 * f.z1 + d11 * f.vz1;
      swim.speed = Math.max(0.5, Math.hypot(vx, vz));
      const yaw = Math.atan2(vx, vz);
      const turnRate = wrapAngle(yaw - swim.yaw) / Math.max(dt, 0.001);
      swim.yaw = yaw;
      swim.turn = THREE.MathUtils.clamp(damp(swim.turn, turnRate, 6, dt), -0.9, 0.9);
      const lift = echoLength / ECHO_LENGTH;
      if (f.leapAt >= 0 && t > f.leapAt) {
        f.leapAt = -1;
        swim.vy = 5.6 * Math.sqrt(lift);
        splash(swim.pos.x, level, swim.pos.z, 0.9);
      }
      if (swim.vy > 0.4 || swim.pos.y > level + 0.05) {
        // the ballistic arc of a leap
        swim.vy -= 9.8 * 0.62 * dt;
      } else {
        const surfaceY = level + (-0.2 + Math.sin(t * 9) * 0.05) * lift;
        swim.vy += ((surfaceY - swim.pos.y) * 9 - swim.vy * 5) * dt;
      }
      swim.pos.y += swim.vy * dt;
      if (f.blowAt >= 0 && t > f.blowAt) {
        f.blowAt = -1;
        swim.blew = true;
        echo.root.localToWorld(tmp.copy(echo.blowhole));
        blow(tmp.x, Math.max(tmp.y, level) + 0.15, tmp.z);
      }
      if (t >= 1) {
        seaFlight = null;
        f.onEnd?.();
      }
    } else {
    // steering on the surface plane
    const goal = swim.curiosity && clock < swim.curiosityUntil ? swim.curiosity : swim.waypoint;
    if (swim.curiosity && clock >= swim.curiosityUntil) swim.curiosity = null;
    const dx = goal.x - swim.pos.x, dz = goal.z - swim.pos.z;
    if (!swim.curiosity && dx * dx + dz * dz < 2.2) pickWaypoint();
    // keep inside the lane, looking ahead (a whale turns wide): Echo never swims under the form or up to the lens
    const ahead = 2.4 * swim.speed;
    const fx = swim.pos.x + Math.sin(swim.yaw) * ahead, fz = swim.pos.z + Math.cos(swim.yaw) * ahead;
    const ox = (fx - layout.lane.x) / layout.radiusX, oz = (fz - layout.lane.z) / layout.radiusZ;
    const outside = ox * ox + oz * oz > 1;
    if (outside && !swim.curiosity) pickWaypoint();
    const desiredYaw = outside ? Math.atan2(layout.lane.x - swim.pos.x, layout.lane.z - swim.pos.z) : Math.atan2(dx, dz);
    const yawError = wrapAngle(desiredYaw - swim.yaw);
    const maxTurn = swim.phase === 'air' ? 0.05 : outside ? 0.9 : 0.5;
    const turn = THREE.MathUtils.clamp(yawError * 1.1, -maxTurn, maxTurn);
    swim.turn = damp(swim.turn, turn, 2.5, dt);
    swim.yaw += swim.turn * dt;

    // depth programme
    const k = echoLength / ECHO_LENGTH; // depths are in proportion to Echo's size
    let targetY = -1.6 * k;
    let speedTarget = CRUISE_SPEED * (1 + swim.excitement * 0.6);
    switch (swim.phase) {
      case 'cruise':
        targetY = (-1.15 + Math.sin(clock * 0.5) * 0.2) * k;
        if (swim.phaseTime > swim.phaseLength) {
          swim.surfacings++;
          if (swim.leapQueued || swim.surfacings % 5 === 0) setPhase('charge', 2.4);
          else setPhase('rise', 1.8);
        }
        break;
      case 'rise':
        targetY = level - 0.7 * k;
        if (swim.phaseTime > swim.phaseLength || swim.pos.y > level - 0.7 * k) setPhase('surface', 4.6);
        break;
      case 'surface':
        targetY = level + (-0.36 + Math.sin(swim.phaseTime * 1.6) * 0.07) * k; // back breaks the water
        speedTarget *= 0.75;
        if (!swim.blew && swim.phaseTime > 0.7) {
          swim.blew = true;
          echo.root.localToWorld(tmp.copy(echo.blowhole));
          blow(tmp.x, Math.max(tmp.y, level) + 0.15, tmp.z);
        }
        if (swim.phaseTime > swim.phaseLength) setPhase('dive', 1.6);
        break;
      case 'dive':
        targetY = -1.9 * k;
        if (swim.phaseTime > swim.phaseLength) setPhase('cruise', 2 + Math.random() * 2.5);
        break;
      case 'charge':
        targetY = -2.6 * k;
        speedTarget *= 1.35;
        if (swim.phaseTime > swim.phaseLength * 0.55 && swim.pos.y < -2.0 * k && swim.vy < 3) {
          swim.vy = 6.8 * Math.sqrt(k); // launch from below
        }
        if (swim.vy > 3.4 * Math.sqrt(k) && swim.pos.y > level - 0.2 * k) {
          swim.leapQueued = false;
          setPhase('air', 3);
        } else if (swim.phaseTime > swim.phaseLength + 2.5) {
          setPhase('rise', 2.4); // never stuck in a charge
        }
        break;
      case 'air':
        speedTarget *= 1.25;
        break;
    }
    swim.speed = damp(swim.speed, speedTarget, 1.2, dt);

    // vertical motion: a spring toward the programme under water, a ballistic arc above it
    const above = swim.pos.y > level;
    if (swim.phase === 'air' || (above && swim.vy > 0.5)) {
      swim.vy -= 9.8 * 0.62 * dt;
      if (swim.phase === 'air' && swim.vy < 0 && swim.pos.y < level - 0.4) setPhase('dive', 2.4);
    } else if (swim.phase === 'charge' && swim.vy > 3) {
      swim.vy -= 1.5 * dt; // keep the launch going up through the water
    } else {
      const accel = (targetY - swim.pos.y) * 2.4 - swim.vy * 2.2;
      swim.vy += accel * dt;
    }
    swim.pos.y += swim.vy * dt;
    swim.pos.x += Math.sin(swim.yaw) * Math.cos(swim.pitch) * swim.speed * dt;
    swim.pos.z += Math.cos(swim.yaw) * Math.cos(swim.pitch) * swim.speed * dt;
    }

    // body attitude follows the path: nose along the velocity, banking into turns, a slow breathing roll
    const desiredPitch = THREE.MathUtils.clamp(Math.atan2(swim.vy, swim.speed), -0.75, 0.95);
    swim.pitch = damp(swim.pitch, desiredPitch, swim.phase === 'air' ? 6 : 3, dt);
    swim.roll = damp(swim.roll, -swim.turn * 0.9 + Math.sin(clock * 0.7) * 0.05, 2.2, dt);
    echo.root.position.copy(swim.pos);
    echo.root.rotation.set(-swim.pitch, swim.yaw, swim.roll, 'YXZ');
    const bodyLengthsPerSecond = swim.speed / echoLength + Math.abs(swim.vy) * 0.08;
    echo.update(dt, bodyLengthsPerSecond, Math.min(1, swim.excitement + (swim.phase === 'charge' ? 0.7 : 0)));
    echo.root.updateMatrixWorld();

    // where Echo meets the water: rings and foam along the body, splashes when it crosses the surface fast
    swim.contactClock -= dt;
    let touching = false;
    for (const local of spine) {
      echo.root.localToWorld(tmp.copy(local));
      const surface = waveHeight(tmp.x, tmp.z, waveTime);
      const gap = tmp.y - surface;
      if (gap > -0.35 && gap < 0.45) {
        touching = true;
        if (swim.contactClock <= 0) ripple(tmp.x, tmp.z, 0.22 + Math.min(0.3, swim.speed * 0.08));
      }
    }
    if (touching && swim.contactClock <= 0) swim.contactClock = 0.32;
    const centreAbove = swim.pos.y > level;
    if (centreAbove !== swim.wasAbove) {
      const speed = Math.abs(swim.vy);
      if (speed > 2.2) splash(swim.pos.x, level, swim.pos.z, Math.min(1.6, speed / 5));
      swim.wasAbove = centreAbove;
    }
    // light and colour of the water on the skin
    echoU.uWaterLevel.value = level;
    echoU.uWet.value = centreAbove ? 1 : damp(echoU.uWet.value, 0, 0.8, dt);
    const depth = Math.max(0, level - swim.pos.y);
    echo.setWaterLight(clock, THREE.MathUtils.clamp(0.15 + depth * 0.25, 0, 0.6) * (1 - live.stars * 0.7));
    // clear water above a submerged Echo: its shape shows through instead of the grazing-angle reflection
    const clarity = depth > 0.05 ? THREE.MathUtils.clamp(1.4 - depth * 0.35, 0, 1) : 0;
    oceanMaterial.uniforms.uEcho.value.set(swim.pos.x, swim.pos.z, echoLength * 0.55, clarity);
  };

  // ── per-frame palette and uniforms ──
  const sunDir = new THREE.Vector3();
  const applyPalette = () => {
    sunDir.set(Math.sin(live.sunAz) * Math.cos(live.sunEl), Math.sin(live.sunEl), -Math.cos(live.sunAz) * Math.cos(live.sunEl)).normalize();
    skyU.uSunDir.value.copy(sunDir);
    skyU.uSunColor.value.copy(live.sun).multiplyScalar(live.sunIntensity);
    skyU.uCloudCover.value = live.cloudCover;
    skyMaterial.uniforms.uSunDisc.value = live.sunDisc;
    skyMaterial.uniforms.uStars.value = live.stars;
    skyMaterial.uniforms.uMoon.value = live.moon;
    oceanMaterial.uniforms.uSunVisible.value = live.sunVisible;
    renderer.toneMappingExposure = live.exposure;
    sunLight.position.copy(sunDir).multiplyScalar(50).add(layout.lane);
    sunLight.target.position.copy(layout.lane);
    sunLight.color.copy(live.sun);
    sunLight.intensity = 2.4 * live.sunIntensity;
    echoFill.intensity = 1.5 * (1 - live.stars * 0.55);
    echoRim.intensity = 1.4 * (1 - live.stars * 0.4);
    hemi.color.copy(live.hemiSky);
    hemi.groundColor.copy(live.hemiGround);
    echoU.uWaterTint.value.copy(live.deep).lerp(live.scatter, 0.35);
    abyssMaterial.color.copy(live.deep).multiplyScalar(0.55);
    drops.material.uniforms.uColor.value.copy(live.foam);
    mist.material.uniforms.uColor.value.copy(live.foam).lerp(live.haze, 0.3);
  };
  applyPalette();

  // ── camera: a slow breathing drift, a gentle pointer parallax (never while typing) ──
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  let calm = false;
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
  };

  // ── loop ──
  let clock = 0;
  let waveTime = 0;
  const waveClock = () => waveTime;
  let last = 0;
  let raf = 0;
  let isLive = false;
  let slowFrames = 0;
  let sampleFrames = 0;

  function frame(now: number, still = false) {
    if (disposed) return;
    const dt = still || !last ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!still) {
      clock += dt;
      waveTime += dt * WAVE_SPEED;
      // adaptive quality: a slow device draws fewer pixels rather than stuttering
      sampleFrames++;
      if (dt > 0.026) slowFrames++;
      if (sampleFrames >= 90) {
        if (slowFrames > 45 && pixelRatio > 1) {
          pixelRatio = Math.max(1, pixelRatio - 0.25);
          renderer.setPixelRatio(pixelRatio);
          applyLayout();
        }
        sampleFrames = 0;
        slowFrames = 0;
      }
    }
    if (paletteT < 1) {
      paletteT = Math.min(1, paletteT + dt / 1.8);
      lerpPalette(live, from, target, smoothstep(0, 1, paletteT));
      applyPalette();
    }
    skyU.uTime.value = clock;
    oceanMaterial.uniforms.uWaveTime.value = waveTime;
    for (const m of landMaterials) m.uniforms.uTime.value = clock;
    // lamp: a rotating light seen from afar = a soft flash every 5 s, brighter at dusk and night
    const sweep = Math.pow(Math.max(0, Math.cos(clock * 1.25)), 18);
    lampMaterial.uniforms.uIntensity.value = live.lamp * (0.25 + sweep * 1.1);

    if (!still && !reducedMotion) {
      updateEcho(dt, waveTime);
      stepPool(drops, dt, (x, z) => waveHeight(x, z, waveTime));
      stepPool(mist, dt, () => -100);
      const follow = calm ? 0 : 1;
      pointer.sx = damp(pointer.sx, pointer.x * follow, 1.6, dt);
      pointer.sy = damp(pointer.sy, pointer.y * follow, 1.6, dt);
      camera.position.set(
        layout.basePos.x + pointer.sx * 0.45 + Math.sin(clock * 0.11) * 0.18,
        layout.basePos.y - pointer.sy * 0.12 + Math.sin(clock * 0.23) * 0.06,
        layout.basePos.z,
      );
      camera.lookAt(layout.lookAt);
    } else if (echo) {
      echo.root.position.copy(swim.pos);
      echo.root.rotation.set(-swim.pitch, swim.yaw + 0.9, 0.04, 'YXZ');
      echoU.uWaterLevel.value = 0;
    }
    sky.position.copy(camera.position);
    renderer.render(scene, camera);
    if (!isLive) {
      isLive = true;
      options.onLive();
      state('live');
    }
    if (!still && !reducedMotion) raf = requestAnimationFrame((t) => frame(t));
  }

  const start = () => {
    if (disposed || reducedMotion || raf) return;
    last = 0;
    raf = requestAnimationFrame((t) => frame(t));
  };
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisibility = () => (document.hidden ? stop() : start());
  const onResize = () => applyLayout();
  const onContextLost = (event: Event) => {
    event.preventDefault();
    stop();
    options.onFail('context-lost');
  };

  applyLayout();
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onContextLost);

  // compile the world off the main thread where the driver allows, then come alive
  const compiled = (() => {
    try {
      return renderer.compileAsync(scene, camera).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  })();
  const echoLoad = loadEcho();
  // Wait briefly for Echo so the world appears with its whale; never longer than 2.5 s.
  Promise.all([compiled, Promise.race([echoLoad, new Promise((r) => window.setTimeout(r, 2500))])]).then(() => {
    if (disposed) return;
    if (reducedMotion) frame(performance.now(), true);
    else start();
  });

  return {
    setSky(sky, night) {
      const next = toLive(paletteFor(sky, night));
      from = clonePalette(live);
      target = next;
      paletteT = reducedMotion ? 1 : 0;
      if (reducedMotion) {
        lerpPalette(live, from, target, 1);
        applyPalette();
        frame(performance.now(), true);
      }
    },
    setMood(mood) {
      if (reducedMotion || seaFlight || awaiting) return;
      if (mood === 'success') {
        swim.leapQueued = true;
        swim.excitement = 1;
        if (swim.phase === 'cruise' || swim.phase === 'dive') setPhase('charge', 2.2);
      } else if (mood === 'error') {
        // a flick of the tail: a sharp splash where the fluke meets the water
        if (echo) {
          echo.root.localToWorld(tmp.copy(echo.fluke));
          splash(tmp.x, waveHeight(tmp.x, tmp.z, waveTime), tmp.z, 0.6);
        }
        swim.excitement = 0.8;
      } else if (mood === 'submitting') {
        swim.excitement = Math.max(swim.excitement, 0.6);
      } else if (mood === 'password-visible') {
        if (swim.phase === 'cruise') setPhase('rise', 2);
      }
    },
    setCalm(value) {
      calm = value;
    },
    tap(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const point = pointOnSea(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
      if (!point || point.distanceTo(camera.position) > 90) return false;
      ripple(point.x, point.z, 0.9);
      if (reducedMotion) return true;
      const ox = (point.x - layout.lane.x) / (layout.radiusX * 1.3), oz = (point.z - layout.lane.z) / (layout.radiusZ * 1.3);
      if (ox * ox + oz * oz < 1.4) {
        swim.curiosity = point;
        swim.curiosityUntil = clock + 4;
        if (swim.phase === 'cruise') setPhase('rise', 2);
      }
      return true;
    },
    stage: {
      depart({ dir }) {
        if (!echo || reducedMotion || awaiting || !isLive) return Promise.resolve(null);
        const body = echo;
        const seconds = 1.05;
        const z1 = swim.pos.z;
        const x1 = edgeOf(z1, dir);
        const speed = Math.max(14, (Math.abs(x1 - swim.pos.x) / seconds) * 1.5);
        return new Promise<EchoCarry | null>((resolve) => {
          swim.excitement = 1;
          seaFlight = {
            start: performance.now(),
            ms: seconds * 1000,
            x0: swim.pos.x, z0: swim.pos.z,
            vx0: Math.sin(swim.yaw) * swim.speed, vz0: Math.cos(swim.yaw) * swim.speed,
            x1, z1, vx1: dir * speed, vz1: 0,
            blowAt: -1,
            leapAt: -1,
            onEnd: () => {
              const scale = pixelsPerUnit(z1);
              awaiting = true;
              body.root.visible = false;
              tmp.copy(swim.pos).project(camera);
              resolve({ dir, y: Math.min(0.92, Math.max(0.08, (1 - tmp.y) * 0.5)), size: echoLength * scale, speed: speed * scale, tail: body.swimTime() });
            },
          };
        });
      },
      arrive(carry) {
        if (reducedMotion || !awaiting) return;
        if (echo) swimIn(carry);
        else pendingCarry = carry;
      },
      awaitArrival() {
        if (reducedMotion) return;
        awaiting = true;
        if (echo) echo.root.visible = false;
      },
      isLive: () => isLive,
    },
    dispose() {
      disposed = true;
      seaFlight?.onEnd?.();
      seaFlight = null;
      stop();
      abort.abort();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      echo?.dispose();
      for (const mesh of landMeshes) mesh.removeFromParent();
      [farGeometry, farRightGeometry, headlandGeometry, towerGeometry, oceanGeometry, sky.geometry, lamp.geometry,
        abyss.geometry, drops.points.geometry, mist.points.geometry].forEach((g) => g.dispose());
      [skyMaterial, oceanMaterial, lampMaterial, abyssMaterial, drops.material, mist.material, ...landMaterials].forEach((m) => m.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
