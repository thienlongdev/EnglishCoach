/**
 * 12-state choreography (9 core living states + 3 operational states),
 * closed-form analytical second-order spring bank, soft-duck backchannel modulation,
 * and zero-DOM-per-frame Pearl x Abyss theme observer for EchoLivingEntity.
 */

export const ECHO_ENTITY_STATES = [
  'disabled',
  'dormant',
  'awakening',
  'listening',
  'understanding',
  'thinking',
  'speaking',
  'executing',
  'interrupted',
  'reconnecting',
  'sleeping',
  'error',
] as const;

export type EchoEntityState = (typeof ECHO_ENTITY_STATES)[number];
export type EchoEntitySlot = 'launcher' | 'compact' | 'ambient' | 'welcome' | 'rail' | 'voice' | 'immersive';
export type EchoEntityStateInput = EchoEntityState | 'idle' | 'streaming' | 'responding' | 'unread' | 'starting' | 'calm' | (string & {});

export type RgbTuple = readonly [number, number, number];

export interface EchoStatePreset {
  readonly activeLoop: boolean;
  readonly fpsCap: number;
  readonly coreScale: number;
  readonly plasmaSpeed: number;
  readonly dispersion: number;
  readonly sheetMix: number;
  readonly plasmaMix: number;
  readonly listenWaveMix: number;
  readonly speakFieldMix: number;
  readonly constellation: number;
  readonly prismMix: number;
  readonly ringSpeed: number;
  readonly ringAlign: number;
  readonly dashSpeed: number;
  readonly curlAmp: number;
  readonly trailStretch: number;
  readonly harmonicGain: number;
  readonly audioSource: number;
  readonly attention: number;
  /** (wAwake, wListen, wThink, wSpeak) */
  readonly stateGroupA: readonly [number, number, number, number];
  readonly coreColorA: readonly [RgbTuple, RgbTuple];
  readonly coreColorB: readonly [RgbTuple, RgbTuple];
  readonly rimColor: readonly [RgbTuple, RgbTuple];
}

function hexRgb(hex: number): RgbTuple {
  return [
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255,
  ];
}

export const ECHO_STATE_PRESETS: Readonly<Record<EchoEntityState, EchoStatePreset>> = {
  disabled: {
    activeLoop: false,
    fpsCap: 0,
    coreScale: 0.84,
    plasmaSpeed: 0.0,
    dispersion: 0.24,
    sheetMix: 0.0,
    plasmaMix: 0.0,
    listenWaveMix: 0.0,
    speakFieldMix: 0.0,
    constellation: 0.0,
    prismMix: 0.0,
    ringSpeed: 0.0,
    ringAlign: 0.0,
    dashSpeed: 0.0,
    curlAmp: 0.0,
    trailStretch: 0.0,
    harmonicGain: 0.0,
    audioSource: 0.0,
    attention: 0.0,
    stateGroupA: [0, 0, 0, 0],
    coreColorA: [hexRgb(0x22d3ee), hexRgb(0x67e8f9)],
    coreColorB: [hexRgb(0x8b5cf6), hexRgb(0xa78bfa)],
    rimColor: [hexRgb(0xa5f3fc), hexRgb(0xf5d0fe)],
  },
  dormant: {
    activeLoop: false,
    fpsCap: 0,
    coreScale: 0.89,
    plasmaSpeed: 0.0,
    dispersion: 0.42,
    sheetMix: 0.50,
    plasmaMix: 0.22,
    listenWaveMix: 0.0,
    speakFieldMix: 0.0,
    constellation: 0.04,
    prismMix: 0.54,
    ringSpeed: 0.0,
    ringAlign: 0.0,
    dashSpeed: 0.0,
    curlAmp: 0.0,
    trailStretch: 0.0,
    harmonicGain: 0.0,
    audioSource: 0.0,
    attention: 0.0,
    stateGroupA: [0, 0, 0, 0],
    coreColorA: [hexRgb(0x22d3ee), hexRgb(0x67e8f9)],
    coreColorB: [hexRgb(0x8b5cf6), hexRgb(0xa78bfa)],
    rimColor: [hexRgb(0xbae6fd), hexRgb(0xf5d0fe)],
  },
  awakening: {
    activeLoop: true,
    fpsCap: 60,
    coreScale: 1.0,
    plasmaSpeed: 1.42,
    dispersion: 0.82,
    sheetMix: 0.78,
    plasmaMix: 0.48,
    listenWaveMix: 0.0,
    speakFieldMix: 0.22,
    constellation: 0.24,
    prismMix: 0.86,
    ringSpeed: 1.48,
    ringAlign: 0.68,
    dashSpeed: 1.85,
    curlAmp: 0.72,
    trailStretch: 0.62,
    harmonicGain: 0.34,
    audioSource: 0.0,
    attention: 0.92,
    stateGroupA: [1, 0.25, 0, 0],
    coreColorA: [hexRgb(0x22d3ee), hexRgb(0x67e8f9)],
    coreColorB: [hexRgb(0xa855f7), hexRgb(0xe879f9)],
    rimColor: [hexRgb(0xe0f2fe), hexRgb(0xfbcfe8)],
  },
  listening: {
    activeLoop: true,
    fpsCap: 60,
    coreScale: 1.02,
    plasmaSpeed: 0.64,
    dispersion: 0.56,
    sheetMix: 0.52,
    plasmaMix: 0.28,
    listenWaveMix: 1.0,
    speakFieldMix: 0.0,
    constellation: 0.08,
    prismMix: 0.62,
    ringSpeed: 0.44,
    ringAlign: 0.90,
    dashSpeed: 0.82,
    curlAmp: 0.36,
    trailStretch: 0.24,
    harmonicGain: 0.28,
    audioSource: -1.0,
    attention: 1.0,
    stateGroupA: [0, 1, 0, 0],
    coreColorA: [hexRgb(0x06b6d4), hexRgb(0x38bdf8)],
    coreColorB: [hexRgb(0x6366f1), hexRgb(0xa78bfa)],
    rimColor: [hexRgb(0x67e8f9), hexRgb(0xe0f2fe)],
  },
  understanding: {
    activeLoop: true,
    fpsCap: 60,
    coreScale: 0.96,
    plasmaSpeed: 1.36,
    dispersion: 0.68,
    sheetMix: 0.62,
    plasmaMix: 0.52,
    listenWaveMix: 0.0,
    speakFieldMix: 0.0,
    constellation: 0.64,
    prismMix: 0.68,
    ringSpeed: 1.28,
    ringAlign: 0.78,
    dashSpeed: 2.35,
    curlAmp: 0.64,
    trailStretch: 0.52,
    harmonicGain: 0.28,
    audioSource: -0.4,
    attention: 0.95,
    stateGroupA: [0, 0.65, 0.55, 0],
    coreColorA: [hexRgb(0x0ea5e9), hexRgb(0x67e8f9)],
    coreColorB: [hexRgb(0x7c3aed), hexRgb(0xc084fc)],
    rimColor: [hexRgb(0xa5f3fc), hexRgb(0xf5d0fe)],
  },
  thinking: {
    activeLoop: true,
    fpsCap: 60,
    coreScale: 0.98,
    plasmaSpeed: 2.42,
    dispersion: 0.86,
    sheetMix: 0.58,
    plasmaMix: 0.64,
    listenWaveMix: 0.0,
    speakFieldMix: 0.0,
    constellation: 1.0,
    prismMix: 0.74,
    ringSpeed: 2.62,
    ringAlign: 0.24,
    dashSpeed: 4.2,
    curlAmp: 0.94,
    trailStretch: 0.74,
    harmonicGain: 0.24,
    audioSource: 0.0,
    attention: 0.88,
    stateGroupA: [0, 0, 1, 0],
    coreColorA: [hexRgb(0x0ea5e9), hexRgb(0x38bdf8)],
    coreColorB: [hexRgb(0x8b5cf6), hexRgb(0xd946ef)],
    rimColor: [hexRgb(0x7dd3fc), hexRgb(0xf5d0fe)],
  },
  speaking: {
    activeLoop: true,
    fpsCap: 60,
    coreScale: 1.03,
    plasmaSpeed: 1.16,
    dispersion: 0.74,
    sheetMix: 0.70,
    plasmaMix: 0.42,
    listenWaveMix: 0.0,
    speakFieldMix: 1.0,
    constellation: 0.16,
    prismMix: 0.82,
    ringSpeed: 0.68,
    ringAlign: 0.62,
    dashSpeed: 1.25,
    curlAmp: 0.54,
    trailStretch: 0.42,
    harmonicGain: 1.14,
    audioSource: 1.0,
    attention: 0.94,
    stateGroupA: [0, 0, 0, 1],
    coreColorA: [hexRgb(0x14b8a6), hexRgb(0x2dd4bf)],
    coreColorB: [hexRgb(0x8b5cf6), hexRgb(0xe879f9)],
    rimColor: [hexRgb(0x99f6e4), hexRgb(0xfbcfe8)],
  },
  executing: {
    activeLoop: true,
    fpsCap: 60,
    coreScale: 1.05,
    plasmaSpeed: 1.88,
    dispersion: 0.86,
    sheetMix: 0.84,
    plasmaMix: 0.68,
    listenWaveMix: 0.0,
    speakFieldMix: 0.38,
    constellation: 0.58,
    prismMix: 0.78,
    ringSpeed: 2.05,
    ringAlign: 0.82,
    dashSpeed: 3.4,
    curlAmp: 0.96,
    trailStretch: 0.94,
    harmonicGain: 0.52,
    audioSource: 0.5,
    attention: 0.90,
    stateGroupA: [0, 0.2, 0.65, 0.4],
    coreColorA: [hexRgb(0x06b6d4), hexRgb(0x2dd4bf)],
    coreColorB: [hexRgb(0x6366f1), hexRgb(0xa78bfa)],
    rimColor: [hexRgb(0x67e8f9), hexRgb(0xc4b5fd)],
  },
  interrupted: {
    activeLoop: true,
    fpsCap: 60,
    coreScale: 1.0,
    plasmaSpeed: 0.48,
    dispersion: 0.94,
    sheetMix: 0.68,
    plasmaMix: 0.58,
    listenWaveMix: 0.0,
    speakFieldMix: 0.18,
    constellation: 0.16,
    prismMix: 0.90,
    ringSpeed: -0.52,
    ringAlign: 0.84,
    dashSpeed: 0.34,
    curlAmp: 0.92,
    trailStretch: 0.72,
    harmonicGain: 0.68,
    audioSource: 0.0,
    attention: 1.0,
    stateGroupA: [0, 0.8, 0, 0],
    coreColorA: [hexRgb(0x22d3ee), hexRgb(0x67e8f9)],
    coreColorB: [hexRgb(0xa855f7), hexRgb(0xf472b6)],
    rimColor: [hexRgb(0xf9a8d4), hexRgb(0xfbcfe8)],
  },
  reconnecting: {
    activeLoop: true,
    fpsCap: 30,
    coreScale: 0.94,
    plasmaSpeed: 0.44,
    dispersion: 0.48,
    sheetMix: 0.54,
    plasmaMix: 0.28,
    listenWaveMix: 0.0,
    speakFieldMix: 0.0,
    constellation: 0.24,
    prismMix: 0.58,
    ringSpeed: 0.38,
    ringAlign: 0.32,
    dashSpeed: 0.55,
    curlAmp: 0.32,
    trailStretch: 0.25,
    harmonicGain: 0.22,
    audioSource: 0.0,
    attention: 0.52,
    stateGroupA: [0, 0, 0.35, 0],
    coreColorA: [hexRgb(0x38bdf8), hexRgb(0x67e8f9)],
    coreColorB: [hexRgb(0x818cf8), hexRgb(0xc084fc)],
    rimColor: [hexRgb(0xbae6fd), hexRgb(0xfde68a)],
  },
  sleeping: {
    activeLoop: true,
    fpsCap: 45,
    coreScale: 0.89,
    plasmaSpeed: 0.14,
    dispersion: 0.42,
    sheetMix: 0.50,
    plasmaMix: 0.22,
    listenWaveMix: 0.0,
    speakFieldMix: 0.0,
    constellation: 0.04,
    prismMix: 0.54,
    ringSpeed: 0.08,
    ringAlign: 0.15,
    dashSpeed: 0.0,
    curlAmp: 0.10,
    trailStretch: 0.05,
    harmonicGain: 0.08,
    audioSource: 0.0,
    attention: 0.15,
    stateGroupA: [0, 0, 0, 0],
    coreColorA: [hexRgb(0x22d3ee), hexRgb(0x67e8f9)],
    coreColorB: [hexRgb(0x8b5cf6), hexRgb(0xa78bfa)],
    rimColor: [hexRgb(0xbae6fd), hexRgb(0xf5d0fe)],
  },
  error: {
    activeLoop: true,
    fpsCap: 30,
    coreScale: 0.94,
    plasmaSpeed: 0.26,
    dispersion: 0.44,
    sheetMix: 0.52,
    plasmaMix: 0.26,
    listenWaveMix: 0.0,
    speakFieldMix: 0.0,
    constellation: 0.06,
    prismMix: 0.72,
    ringSpeed: 0.16,
    ringAlign: 0.36,
    dashSpeed: 0.18,
    curlAmp: 0.20,
    trailStretch: 0.12,
    harmonicGain: 0.14,
    audioSource: 0.0,
    attention: 0.40,
    stateGroupA: [0, 0, 0, 0],
    coreColorA: [hexRgb(0xf472b6), hexRgb(0xf9a8d4)],
    coreColorB: [hexRgb(0x7c3aed), hexRgb(0xa78bfa)],
    rimColor: [hexRgb(0xfda4af), hexRgb(0xfecdd3)],
  },
};

/** Open text-chat welcome, workspace rail, or calm ambient readiness (30 Hz low-energy). */
export const ECHO_CALM_AWAKE_PRESET: EchoStatePreset = {
  activeLoop: true,
  fpsCap: 30,
  coreScale: 0.96,
  plasmaSpeed: 0.34,
  dispersion: 0.58,
  sheetMix: 0.64,
  plasmaMix: 0.32,
  listenWaveMix: 0.0,
  speakFieldMix: 0.08,
  constellation: 0.14,
  prismMix: 0.72,
  ringSpeed: 0.28,
  ringAlign: 0.42,
  dashSpeed: 0.34,
  curlAmp: 0.24,
  trailStretch: 0.18,
  harmonicGain: 0.18,
  audioSource: 0.0,
  attention: 0.64,
  stateGroupA: [0.22, 0.2, 0, 0],
  coreColorA: [hexRgb(0x22d3ee), hexRgb(0x67e8f9)],
  coreColorB: [hexRgb(0x8b5cf6), hexRgb(0xc084fc)],
  rimColor: [hexRgb(0xa5f3fc), hexRgb(0xf5d0fe)],
};

const CANONICAL_SET = new Set<string>(ECHO_ENTITY_STATES);

export interface ResolvedEchoEntityState {
  state: EchoEntityState;
  calmIdle: boolean;
}

export function resolveEchoEntityState(
  raw: EchoEntityStateInput | null | undefined,
  slot: EchoEntitySlot = 'launcher',
): ResolvedEchoEntityState {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (CANONICAL_SET.has(key)) {
    return { state: key as EchoEntityState, calmIdle: false };
  }
  if (key === 'streaming' || key === 'responding') {
    return { state: 'speaking', calmIdle: false };
  }
  if (key === 'starting' || key === 'wake' || key === 'wake_detected') {
    return { state: 'awakening', calmIdle: false };
  }
  if (slot === 'welcome' || slot === 'rail' || slot === 'voice' || slot === 'compact' || slot === 'immersive') {
    return { state: 'awakening', calmIdle: true };
  }
  return { state: 'dormant', calmIdle: false };
}

export function normalizeEchoEntityState(
  raw: EchoEntityStateInput | null | undefined,
  slot: EchoEntitySlot = 'launcher',
): EchoEntityState {
  return resolveEchoEntityState(raw, slot).state;
}

export interface SpringChannel {
  x: number;
  v: number;
}

/**
 * Unconditionally stable closed-form critically damped harmonic oscillator (zeta = 1.0).
 * Immune to Euler overshoot for any dt >= 0 (including multi-second tab resume gaps).
 */
export function stepCriticallyDamped(
  channel: SpringChannel,
  target: number,
  omega0: number,
  dt: number,
): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const safeDt = Math.min(dt, 10.0);
  const e = Math.exp(-omega0 * safeDt);
  const d = channel.x - target;
  const c = channel.v + omega0 * d;
  channel.x = target + (d + c * safeDt) * e;
  channel.v = (channel.v - omega0 * c * safeDt) * e;
}

/**
 * Unconditionally stable closed-form under-damped harmonic oscillator (0 < zeta < 1).
 * Exact analytical solution to x'' + 2*zeta*omega0*x' + omega0^2*(x - target) = 0.
 */
export function stepUnderDamped(
  channel: SpringChannel,
  target: number,
  omega0: number,
  zeta: number,
  dt: number,
): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const safeZeta = Math.min(0.995, Math.max(0.05, zeta));
  const safeDt = Math.min(dt, 10.0);
  const alpha = safeZeta * omega0;
  const omegaD = omega0 * Math.sqrt(1.0 - safeZeta * safeZeta);
  const e = Math.exp(-alpha * safeDt);
  const d = channel.x - target;
  const c1 = d;
  const c2 = (channel.v + alpha * d) / omegaD;
  const cosWt = Math.cos(omegaD * safeDt);
  const sinWt = Math.sin(omegaD * safeDt);
  channel.x = target + e * (c1 * cosWt + c2 * sinWt);
  channel.v = e * ((c2 * omegaD - alpha * c1) * cosWt - (c1 * omegaD + alpha * c2) * sinWt);
}

export interface EchoUniformSnapshot {
  readonly state: EchoEntityState;
  readonly calmIdle: boolean;
  readonly fpsCap: number;
  readonly uDark: number;
  readonly uCoreScale: number;
  readonly uPlasmaSpeed: number;
  readonly uDispersion: number;
  readonly uSheetMix: number;
  readonly uPlasmaMix: number;
  readonly uListenWaveMix: number;
  readonly uSpeakFieldMix: number;
  readonly uConstellation: number;
  readonly uPrismMix: number;
  readonly uRingSpeed: number;
  readonly uRingAlign: number;
  readonly uRingAperture: number;
  readonly uRingPhaseClick: number;
  readonly uDashSpeed: number;
  readonly uCurlAmp: number;
  readonly uTrailStretch: number;
  readonly uHarmonicGain: number;
  readonly uAudioSource: number;
  readonly uAttention: number;
  readonly uShockwave: number;
  readonly uExecWave: number;
  readonly canvasOpacity: number;
  readonly uStateGroupA: Float32Array;
  readonly uGazeDir: Float32Array;
  readonly uCoreColorA: Float32Array;
  readonly uCoreColorB: Float32Array;
  readonly uRimColor: Float32Array;
  readonly uAmbientTint: Float32Array;
}

const CRIT_OMEGA = 10.5;
const ELASTIC_OMEGA = 17.5;
const ELASTIC_ZETA = 0.62;
const SLEEP_DURATION_SEC = 0.65;
const ERROR_SETTLE_SEC = 4.0;

export class EchoSpringBank {
  private currentState: EchoEntityState = 'dormant';
  private calmIdle = false;
  private softDucked = false;
  private stateElapsedSec = 0;
  private execCycleSec = 0;

  private readonly coreScale: SpringChannel = { x: 0.88, v: 0 };
  private readonly plasmaSpeed: SpringChannel = { x: 0, v: 0 };
  private readonly dispersion: SpringChannel = { x: 0.18, v: 0 };
  private readonly sheetMix: SpringChannel = { x: 0.22, v: 0 };
  private readonly plasmaMix: SpringChannel = { x: 0, v: 0 };
  private readonly listenWaveMix: SpringChannel = { x: 0, v: 0 };
  private readonly speakFieldMix: SpringChannel = { x: 0, v: 0 };
  private readonly constellation: SpringChannel = { x: 0, v: 0 };
  private readonly prismMix: SpringChannel = { x: 0.15, v: 0 };
  private readonly ringSpeed: SpringChannel = { x: 0, v: 0 };
  private readonly ringAlign: SpringChannel = { x: 0, v: 0 };
  private readonly ringAperture: SpringChannel = { x: 0, v: 0 };
  private readonly ringPhaseClick: SpringChannel = { x: 0, v: 0 };
  private ringPhaseTarget = 0;
  private readonly dashSpeed: SpringChannel = { x: 0, v: 0 };
  private readonly curlAmp: SpringChannel = { x: 0, v: 0 };
  private readonly trailStretch: SpringChannel = { x: 0, v: 0 };
  private readonly harmonicGain: SpringChannel = { x: 0, v: 0 };
  private readonly audioSource: SpringChannel = { x: 0, v: 0 };
  private readonly attention: SpringChannel = { x: 0, v: 0 };
  private readonly shockwave: SpringChannel = { x: 0, v: 0 };
  private readonly execWave: SpringChannel = { x: 0, v: 0 };
  private readonly darkBlend: SpringChannel = { x: 0, v: 0 };

  private readonly stateGroupA: [SpringChannel, SpringChannel, SpringChannel, SpringChannel] = [
    { x: 0, v: 0 },
    { x: 0, v: 0 },
    { x: 0, v: 0 },
    { x: 0, v: 0 },
  ];

  private readonly gazeChannels: [SpringChannel, SpringChannel, SpringChannel] = [
    { x: 0, v: 0 },
    { x: 0, v: 0 },
    { x: 1, v: 0 },
  ];

  private readonly colorAChannels: [SpringChannel, SpringChannel, SpringChannel] = [
    { x: 0.055, v: 0 },
    { x: 0.647, v: 0 },
    { x: 0.784, v: 0 },
  ];
  private readonly colorBChannels: [SpringChannel, SpringChannel, SpringChannel] = [
    { x: 0.145, v: 0 },
    { x: 0.388, v: 0 },
    { x: 0.922, v: 0 },
  ];
  private readonly rimChannels: [SpringChannel, SpringChannel, SpringChannel] = [
    { x: 0.133, v: 0 },
    { x: 0.827, v: 0 },
    { x: 0.933, v: 0 },
  ];
  private readonly ambientChannels: [SpringChannel, SpringChannel, SpringChannel] = [
    { x: 112 / 255, v: 0 },
    { x: 150 / 255, v: 0 },
    { x: 240 / 255, v: 0 },
  ];

  private targetDark = false;
  private targetAmbient: [number, number, number] = [112 / 255, 150 / 255, 240 / 255];
  private targetAttentionAngle = 0;

  private readonly outStateGroupA = new Float32Array(4);
  private readonly outGazeDir = new Float32Array([0, 0, 1]);
  private readonly outColorA = new Float32Array(3);
  private readonly outColorB = new Float32Array(3);
  private readonly outRim = new Float32Array(3);
  private readonly outAmbient = new Float32Array([112 / 255, 150 / 255, 240 / 255]);

  private snapshotObj: EchoUniformSnapshot = {
    state: 'dormant',
    calmIdle: false,
    fpsCap: 0,
    uDark: 0,
    uCoreScale: 0.88,
    uPlasmaSpeed: 0,
    uDispersion: 0.18,
    uSheetMix: 0.22,
    uPlasmaMix: 0,
    uListenWaveMix: 0,
    uSpeakFieldMix: 0,
    uConstellation: 0,
    uPrismMix: 0.15,
    uRingSpeed: 0,
    uRingAlign: 0,
    uRingAperture: 0,
    uRingPhaseClick: 0,
    uDashSpeed: 0,
    uCurlAmp: 0,
    uTrailStretch: 0,
    uHarmonicGain: 0,
    uAudioSource: 0,
    uAttention: 0,
    uShockwave: 0,
    uExecWave: 0,
    canvasOpacity: 0,
    uStateGroupA: this.outStateGroupA,
    uGazeDir: this.outGazeDir,
    uCoreColorA: this.outColorA,
    uCoreColorB: this.outColorB,
    uRimColor: this.outRim,
    uAmbientTint: this.outAmbient,
  };

  setTheme(isDark: boolean, ambientRgb?: RgbTuple, immediate = false): void {
    this.targetDark = isDark;
    if (ambientRgb) {
      this.targetAmbient[0] = ambientRgb[0];
      this.targetAmbient[1] = ambientRgb[1];
      this.targetAmbient[2] = ambientRgb[2];
    }
    if (immediate) {
      this.darkBlend.x = isDark ? 1 : 0;
      this.darkBlend.v = 0;
      for (let i = 0; i < 3; i++) {
        this.ambientChannels[i].x = this.targetAmbient[i];
        this.ambientChannels[i].v = 0;
      }
    }
  }

  setAttentionAngle(angleRad: number | undefined): void {
    this.targetAttentionAngle = typeof angleRad === 'number' && Number.isFinite(angleRad) ? angleRad : 0;
  }

  setSoftDuck(ducked: boolean): void {
    this.softDucked = Boolean(ducked);
  }

  setState(next: EchoEntityState, calmIdle = false): void {
    const prev = this.currentState;
    const changed = prev !== next || this.calmIdle !== calmIdle;
    this.currentState = next;
    this.calmIdle = calmIdle;
    if (!changed) return;

    this.stateElapsedSec = 0;
    if (next !== 'speaking') {
      this.softDucked = false;
    }

    if (next === 'awakening' && !calmIdle && (prev === 'dormant' || prev === 'disabled' || prev === 'sleeping')) {
      // Under-damped ignition bloom: 0.44 -> ~1.06 -> 1.00
      this.coreScale.x = 0.44;
      this.coreScale.v = 4.30;
    } else if (next === 'understanding') {
      // Crisp 60-degree ring phase click
      this.ringPhaseTarget += Math.PI / 3;
    } else if (next === 'interrupted') {
      // Phase-recoil shockwave impulse and inward dip
      this.shockwave.x = Math.max(this.shockwave.x, 0.14);
      this.shockwave.v = 14.5;
      this.coreScale.x = 0.85;
      this.coreScale.v = -1.65;
    } else if (next === 'executing') {
      this.execCycleSec = 0;
      this.execWave.x = 0.04;
      this.execWave.v = 2.85;
    }
  }

  getState(): EchoEntityState {
    return this.currentState;
  }

  isSleepSettled(): boolean {
    return this.currentState === 'sleeping' && this.stateElapsedSec >= SLEEP_DURATION_SEC;
  }

  isErrorSettled(): boolean {
    return this.currentState === 'error' && this.stateElapsedSec >= ERROR_SETTLE_SEC;
  }

  /**
   * Returns true ONLY when the GPU animation loop is permitted to hold a requestAnimationFrame handle.
   * Strictly false in 'disabled' and 'dormant' (raf === 0, 0% GPU, 0% CPU).
   */
  shouldAnimate(): boolean {
    if (this.currentState === 'disabled' || this.currentState === 'dormant') return false;
    if (this.isSleepSettled() || this.isErrorSettled()) return false;
    return true;
  }

  private activePreset(): EchoStatePreset {
    if (this.currentState === 'awakening' && this.calmIdle) {
      return ECHO_CALM_AWAKE_PRESET;
    }
    return ECHO_STATE_PRESETS[this.currentState];
  }

  /** Snaps all springs directly to target (used for prefers-reduced-motion single-still rendering). */
  snapToTarget(voiceRms = 0): EchoUniformSnapshot {
    const preset = this.activePreset();
    const darkVal = this.targetDark ? 1 : 0;
    this.darkBlend.x = darkVal;
    this.darkBlend.v = 0;

    this.coreScale.x = preset.coreScale;
    this.coreScale.v = 0;
    this.plasmaSpeed.x = 0;
    this.plasmaSpeed.v = 0;
    this.dispersion.x = preset.dispersion;
    this.dispersion.v = 0;
    this.sheetMix.x = preset.sheetMix;
    this.sheetMix.v = 0;
    this.plasmaMix.x = preset.plasmaMix;
    this.plasmaMix.v = 0;
    this.listenWaveMix.x = preset.listenWaveMix;
    this.listenWaveMix.v = 0;
    this.speakFieldMix.x = preset.speakFieldMix;
    this.speakFieldMix.v = 0;
    this.constellation.x = preset.constellation;
    this.constellation.v = 0;
    this.prismMix.x = preset.prismMix;
    this.prismMix.v = 0;
    this.ringSpeed.x = 0;
    this.ringSpeed.v = 0;
    this.ringAlign.x = preset.ringAlign;
    this.ringAlign.v = 0;
    this.ringAperture.x = voiceRms;
    this.ringAperture.v = 0;
    this.ringPhaseClick.x = this.ringPhaseTarget;
    this.ringPhaseClick.v = 0;
    this.dashSpeed.x = 0;
    this.dashSpeed.v = 0;
    this.curlAmp.x = preset.curlAmp * 0.5;
    this.curlAmp.v = 0;
    this.trailStretch.x = 0;
    this.trailStretch.v = 0;
    this.harmonicGain.x = preset.harmonicGain;
    this.harmonicGain.v = 0;
    this.audioSource.x = preset.audioSource;
    this.audioSource.v = 0;
    this.attention.x = preset.attention;
    this.attention.v = 0;
    this.shockwave.x = 0;
    this.shockwave.v = 0;
    this.execWave.x = this.currentState === 'executing' ? 0.55 : 0;
    this.execWave.v = 0;

    for (let i = 0; i < 4; i++) {
      this.stateGroupA[i].x = preset.stateGroupA[i];
      this.stateGroupA[i].v = 0;
    }

    const gx = Math.sin(this.targetAttentionAngle) * 0.44;
    const gy = 0.05;
    const gz = Math.cos(this.targetAttentionAngle) * 0.896;
    this.gazeChannels[0].x = gx;
    this.gazeChannels[1].x = gy;
    this.gazeChannels[2].x = gz;
    this.gazeChannels[0].v = 0;
    this.gazeChannels[1].v = 0;
    this.gazeChannels[2].v = 0;

    for (let i = 0; i < 3; i++) {
      this.colorAChannels[i].x = preset.coreColorA[0][i] + (preset.coreColorA[1][i] - preset.coreColorA[0][i]) * darkVal;
      this.colorBChannels[i].x = preset.coreColorB[0][i] + (preset.coreColorB[1][i] - preset.coreColorB[0][i]) * darkVal;
      this.rimChannels[i].x = preset.rimColor[0][i] + (preset.rimColor[1][i] - preset.rimColor[0][i]) * darkVal;
      this.ambientChannels[i].x = this.targetAmbient[i];
      this.colorAChannels[i].v = 0;
      this.colorBChannels[i].v = 0;
      this.rimChannels[i].v = 0;
      this.ambientChannels[i].v = 0;
    }

    return this.writeSnapshot(preset);
  }

  step(dtSec: number, voiceRms = 0, speechIntensityTier = 0): EchoUniformSnapshot {
    const preset = this.activePreset();
    const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
    this.stateElapsedSec += dt;

    // Smooth Light <-> Dark transition
    const darkTarget = this.targetDark ? 1 : 0;
    if (dt > 0) {
      const kDark = 1 - Math.exp(-Math.min(dt, 1.0) * 5.2);
      this.darkBlend.x += (darkTarget - this.darkBlend.x) * kDark;
    }
    const uDark = Math.min(1, Math.max(0, this.darkBlend.x));

    const errorSettleFactor = this.currentState === 'error'
      ? Math.max(0, 1 - this.stateElapsedSec / ERROR_SETTLE_SEC)
      : 1;

    // Subtle vocal scale breathing on energetic speech
    const dynamicScale = preset.coreScale + (this.currentState === 'speaking' || this.currentState === 'listening' ? speechIntensityTier * 0.055 : 0);
    stepUnderDamped(this.coreScale, dynamicScale, ELASTIC_OMEGA, ELASTIC_ZETA, dt);
    stepUnderDamped(this.ringAperture, Math.min(1, Math.max(0, voiceRms)), ELASTIC_OMEGA, 0.68, dt);
    stepUnderDamped(this.shockwave, 0, 19.5, 0.54, dt);
    this.shockwave.x = Math.min(1.25, Math.max(0, this.shockwave.x));

    if (this.currentState === 'executing') {
      this.execCycleSec += dt;
      const cyclePos = this.execCycleSec % 1.15;
      const rawWave = Math.min(1, cyclePos / 0.62);
      stepCriticallyDamped(this.execWave, rawWave, 16.0, dt);
    } else {
      stepCriticallyDamped(this.execWave, 0, 12.0, dt);
    }
    this.execWave.x = Math.min(1, Math.max(0, this.execWave.x));

    const duckSpeakScale = this.softDucked && this.currentState === 'speaking' ? 0.52 : 1.0;
    const duckListenHint = this.softDucked && this.currentState === 'speaking' ? 0.25 : 0.0;

    const listenOmega = preset.listenWaveMix < 0.05 ? 22.0 : CRIT_OMEGA;
    stepCriticallyDamped(this.plasmaSpeed, preset.plasmaSpeed * errorSettleFactor, CRIT_OMEGA, dt);
    stepCriticallyDamped(this.dispersion, preset.dispersion, CRIT_OMEGA, dt);
    stepCriticallyDamped(this.sheetMix, preset.sheetMix, CRIT_OMEGA, dt);
    stepCriticallyDamped(this.plasmaMix, Math.min(1, preset.plasmaMix + speechIntensityTier * 0.22), CRIT_OMEGA, dt);
    stepCriticallyDamped(this.listenWaveMix, Math.min(1, preset.listenWaveMix + duckListenHint), listenOmega, dt);
    stepCriticallyDamped(this.speakFieldMix, preset.speakFieldMix * duckSpeakScale, CRIT_OMEGA, dt);
    stepCriticallyDamped(this.constellation, preset.constellation, CRIT_OMEGA, dt);
    stepCriticallyDamped(this.prismMix, Math.min(1, preset.prismMix + speechIntensityTier * 0.18), CRIT_OMEGA, dt);
    stepCriticallyDamped(this.ringSpeed, preset.ringSpeed * errorSettleFactor, CRIT_OMEGA, dt);
    stepCriticallyDamped(this.ringAlign, preset.ringAlign, CRIT_OMEGA, dt);
    stepCriticallyDamped(this.ringPhaseClick, this.ringPhaseTarget, 15.0, dt);
    stepCriticallyDamped(this.dashSpeed, preset.dashSpeed * errorSettleFactor, CRIT_OMEGA, dt);
    stepCriticallyDamped(this.curlAmp, preset.curlAmp * (0.35 + 0.65 * errorSettleFactor), CRIT_OMEGA, dt);
    stepCriticallyDamped(this.trailStretch, preset.trailStretch * errorSettleFactor, CRIT_OMEGA, dt);
    stepCriticallyDamped(this.harmonicGain, preset.harmonicGain * duckSpeakScale, CRIT_OMEGA, dt);
    stepCriticallyDamped(this.audioSource, preset.audioSource, 13.5, dt);
    stepCriticallyDamped(this.attention, preset.attention, CRIT_OMEGA, dt);

    for (let i = 0; i < 4; i++) {
      stepCriticallyDamped(this.stateGroupA[i], preset.stateGroupA[i], CRIT_OMEGA, dt);
    }

    const targetGx = Math.sin(this.targetAttentionAngle) * 0.46;
    const targetGy = 0.05;
    const targetGz = Math.cos(this.targetAttentionAngle) * 0.886;
    stepCriticallyDamped(this.gazeChannels[0], targetGx, 10.0, dt);
    stepCriticallyDamped(this.gazeChannels[1], targetGy, 10.0, dt);
    stepCriticallyDamped(this.gazeChannels[2], targetGz, 10.0, dt);

    for (let i = 0; i < 3; i++) {
      const targetA = preset.coreColorA[0][i] + (preset.coreColorA[1][i] - preset.coreColorA[0][i]) * uDark;
      const targetB = preset.coreColorB[0][i] + (preset.coreColorB[1][i] - preset.coreColorB[0][i]) * uDark;
      const targetR = preset.rimColor[0][i] + (preset.rimColor[1][i] - preset.rimColor[0][i]) * uDark;
      stepCriticallyDamped(this.colorAChannels[i], targetA, CRIT_OMEGA, dt);
      stepCriticallyDamped(this.colorBChannels[i], targetB, CRIT_OMEGA, dt);
      stepCriticallyDamped(this.rimChannels[i], targetR, CRIT_OMEGA, dt);
      stepCriticallyDamped(this.ambientChannels[i], this.targetAmbient[i], 8.0, dt);
    }

    return this.writeSnapshot(preset);
  }

  private writeSnapshot(preset: EchoStatePreset): EchoUniformSnapshot {
    for (let i = 0; i < 4; i++) {
      this.outStateGroupA[i] = Math.min(1, Math.max(0, this.stateGroupA[i].x));
    }
    const gx = this.gazeChannels[0].x;
    const gy = this.gazeChannels[1].x;
    const gz = this.gazeChannels[2].x;
    const gLen = Math.hypot(gx, gy, gz) || 1;
    this.outGazeDir[0] = gx / gLen;
    this.outGazeDir[1] = gy / gLen;
    this.outGazeDir[2] = gz / gLen;

    for (let i = 0; i < 3; i++) {
      this.outColorA[i] = Math.min(1, Math.max(0, this.colorAChannels[i].x));
      this.outColorB[i] = Math.min(1, Math.max(0, this.colorBChannels[i].x));
      this.outRim[i] = Math.min(1, Math.max(0, this.rimChannels[i].x));
      this.outAmbient[i] = Math.min(1, Math.max(0, this.ambientChannels[i].x));
    }

    let canvasOpacity = 1;
    if (this.currentState === 'disabled' || this.currentState === 'dormant') {
      canvasOpacity = 0;
    } else if (this.currentState === 'sleeping') {
      canvasOpacity = Math.max(0, 1 - this.stateElapsedSec / SLEEP_DURATION_SEC);
    }

    this.snapshotObj = {
      state: this.currentState,
      calmIdle: this.calmIdle,
      fpsCap: preset.fpsCap,
      uDark: Math.min(1, Math.max(0, this.darkBlend.x)),
      uCoreScale: Math.min(1.35, Math.max(0.3, this.coreScale.x)),
      uPlasmaSpeed: Math.max(0, this.plasmaSpeed.x),
      uDispersion: Math.min(1.4, Math.max(0, this.dispersion.x)),
      uSheetMix: Math.min(1.2, Math.max(0, this.sheetMix.x)),
      uPlasmaMix: Math.min(1.2, Math.max(0, this.plasmaMix.x)),
      uListenWaveMix: Math.min(1.2, Math.max(0, this.listenWaveMix.x)),
      uSpeakFieldMix: Math.min(1.2, Math.max(0, this.speakFieldMix.x)),
      uConstellation: Math.min(1.2, Math.max(0, this.constellation.x)),
      uPrismMix: Math.min(1.2, Math.max(0, this.prismMix.x)),
      uRingSpeed: this.ringSpeed.x,
      uRingAlign: Math.min(1, Math.max(0, this.ringAlign.x)),
      uRingAperture: Math.min(1, Math.max(0, this.ringAperture.x)),
      uRingPhaseClick: this.ringPhaseClick.x,
      uDashSpeed: Math.max(0, this.dashSpeed.x),
      uCurlAmp: Math.max(0, this.curlAmp.x),
      uTrailStretch: Math.min(1.5, Math.max(0, this.trailStretch.x)),
      uHarmonicGain: Math.max(0, this.harmonicGain.x),
      uAudioSource: Math.min(1, Math.max(-1, this.audioSource.x)),
      uAttention: Math.min(1, Math.max(0, this.attention.x)),
      uShockwave: Math.min(1.25, Math.max(0, this.shockwave.x)),
      uExecWave: Math.min(1, Math.max(0, this.execWave.x)),
      canvasOpacity,
      uStateGroupA: this.outStateGroupA,
      uGazeDir: this.outGazeDir,
      uCoreColorA: this.outColorA,
      uCoreColorB: this.outColorB,
      uRimColor: this.outRim,
      uAmbientTint: this.outAmbient,
    };
    return this.snapshotObj;
  }
}

export function parseCssRgbTriplet(raw: string, fallback: RgbTuple): RgbTuple {
  const cleaned = raw.trim();
  if (!cleaned) return fallback;
  const parts = cleaned.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return fallback;
  const r = Number(parts[0]);
  const g = Number(parts[1]);
  const b = Number(parts[2]);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return fallback;
  const scale = r > 1 || g > 1 || b > 1 ? 1 / 255 : 1;
  return [
    Math.min(1, Math.max(0, r * scale)),
    Math.min(1, Math.max(0, g * scale)),
    Math.min(1, Math.max(0, b * scale)),
  ];
}

export interface EchoThemeState {
  isDark: boolean;
  ambientRgb: RgbTuple;
}

const PEARL_AMBIENT_DEFAULT: RgbTuple = [112 / 255, 150 / 255, 240 / 255];
const ABYSS_AMBIENT_DEFAULT: RgbTuple = [56 / 255, 189 / 255, 248 / 255];

/**
 * Event-driven MutationObserver on <html> ('class', 'data-atmosphere', 'data-wp-accent',
 * 'data-glass-tint', 'data-spatial', 'style') so EchoGpuStage executes 0 DOM reads per frame.
 */
export class EchoThemeObserver {
  private observer: MutationObserver | null = null;
  private state: EchoThemeState = { isDark: false, ambientRgb: PEARL_AMBIENT_DEFAULT };
  private readonly onChange?: (state: EchoThemeState) => void;

  constructor(onChange?: (state: EchoThemeState) => void) {
    this.onChange = onChange;
    this.refresh();
    if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined' && document.documentElement) {
      this.observer = new MutationObserver(() => {
        this.refresh();
        this.onChange?.(this.state);
      });
      this.observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-atmosphere', 'data-wp-accent', 'data-glass-tint', 'data-spatial', 'style'],
      });
    }
  }

  refresh(): EchoThemeState {
    if (typeof document === 'undefined' || !document.documentElement) {
      return this.state;
    }
    const html = document.documentElement;
    const isDark = !!html.classList?.contains('dark');
    const fallback = isDark ? ABYSS_AMBIENT_DEFAULT : PEARL_AMBIENT_DEFAULT;
    let ambientRgb = fallback;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const raw = window.getComputedStyle(html).getPropertyValue('--eo-ambient');
        ambientRgb = parseCssRgbTriplet(raw, fallback);
      } catch {
        ambientRgb = fallback;
      }
    }
    this.state = { isDark, ambientRgb };
    return this.state;
  }

  getSnapshot(): EchoThemeState {
    return this.state;
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}
