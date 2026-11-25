import type { ObjectState } from './types';
import { mugLoopAtScale } from './mugLoop';

/**
 * Cleaning tools as what they physically are: how long, how wide at the working end, where hands go on them, what they work on. Pure data, so the
 * world and the tests read the same numbers. Their state (how wet, how dirty, how full) is on the thing itself and is drawn on it: a dark, heavy mop head,
 * murky water in the bucket, a heap in the pan. There is no bar anywhere for any of this.
 */
export type ToolWork = 'sweep' | 'scoop' | 'mop' | 'wipe' | 'dust' | 'web';

/** Canonical ergonomic two-hand / single-hand socket layout and carry/work shaft angles. */
export interface ToolGripSockets {
  /** Lower support/guide hand distance from working end along shaft (metres). */
  lower: number;
  /** Upper dominant hand distance from working end along shaft (metres). */
  upper: number;
  /** Nominal handle radius (metres) when surface raycast is unavailable. */
  shaftRadius: number;
  /** Canonical diagonal carry pitch from vertical +Y (radians; ~42 deg = 0.733 rad for long tools). */
  carryPitch: number;
  /** Canonical across-body yaw offset toward support shoulder during carry (radians). */
  carryCrossYaw: number;
  /** Canonical body-local upper-grip carry socket [lateral*side, heightAboveRoot, forward] (metres). */
  carryUpperOffset: [number, number, number];
  /** Canonical active work shaft pitch from vertical +Y (radians; ~52 deg = 0.908 rad for floor tools). */
  workPitch: number;
  /** Snappy unobstructed equip blend duration (seconds). */
  expressEquipSec: number;
  /** Snappy unobstructed unequip/hang-back blend duration (seconds). */
  expressUnequipSec: number;
}

/** Continuous damped stroke kinematics for active sweeping, mopping, and surface care. */
export interface ToolStrokeSpec {
  pattern: 'pendulum' | 'figure8' | 'scoop' | 'wipe' | 'dust' | 'reach';
  /** Natural rhythmic stroke frequency while holding work input (Hz). */
  frequencyHz: number;
  /** Lateral half-amplitude across body forward (metres). */
  lateralAmp: number;
  /** Fore-aft half-amplitude along body forward (metres). */
  forwardAmp: number;
}

export const CANONICAL_CARRY_PITCH_RAD = -(20 * Math.PI) / 180;
export const CANONICAL_WORK_PITCH_RAD = -(22 * Math.PI) / 180;

export interface ToolSpec {
  kind: string;
  work: ToolWork;
  hands: 1 | 2;
  /** What the head works on. */
  on: ('floor' | 'top' | 'glass' | 'web')[];
  /** From the working end to the far end of the handle, metres. */
  length: number;
  /** Where the hands go along it, as distances from the working end. Second is the upper hand. */
  grips: [number, number];
  /** Head size, across the stroke and along it. */
  width: number;
  depth: number;
  /** From the body's centre to the head, along the floor. */
  reach: [number, number];
  /** How far the head can be from the eyes when it works above the floor. */
  reachAir?: number;
  /** Rubbing, bristles or a wet slap: what it sounds like. */
  sound: 'bristle' | 'wet' | 'rub' | 'scrape' | 'feather';
  /** How fast the head can be moved, m/s: a broom goes faster than a wet mop. */
  speed: number;
  /** Canonical ergonomic hand sockets and carry/work angles. */
  sockets: ToolGripSockets;
  /** Continuous stroke parameters when working a surface. */
  stroke: ToolStrokeSpec;
}
export const TOOLS: Record<string, ToolSpec> = {
  'tool.broom': {
    kind: 'tool.broom',
    work: 'sweep',
    hands: 2,
    on: ['floor'],
    length: 1.36,
    grips: [.82, 1.18],
    width: .3,
    depth: .09,
    reach: [.48, .86],
    sound: 'bristle',
    speed: 2.25,
    sockets: {
      lower: .82,
      upper: 1.18,
      shaftRadius: .0125,
      carryPitch: -.345,
      carryCrossYaw: .48,
      carryUpperOffset: [.14, 1.205, .275],
      workPitch: CANONICAL_WORK_PITCH_RAD,
      expressEquipSec: .14,
      expressUnequipSec: .16,
    },
    stroke: { pattern: 'pendulum', frequencyHz: 2.35, lateralAmp: .22, forwardAmp: .055 },
  },
  'tool.mop': {
    kind: 'tool.mop',
    work: 'mop',
    hands: 2,
    on: ['floor'],
    length: 1.34,
    grips: [.80, 1.16],
    width: .3,
    depth: .16,
    reach: [.48, .88],
    sound: 'wet',
    speed: 1.65,
    sockets: {
      lower: .80,
      upper: 1.16,
      shaftRadius: .0125,
      carryPitch: -.345,
      carryCrossYaw: .48,
      carryUpperOffset: [.14, 1.186, .275],
      workPitch: CANONICAL_WORK_PITCH_RAD,
      expressEquipSec: .14,
      expressUnequipSec: .16,
    },
    stroke: { pattern: 'figure8', frequencyHz: 1.85, lateralAmp: .22, forwardAmp: .085 },
  },
  'tool.dustpan': {
    kind: 'tool.dustpan',
    work: 'scoop',
    hands: 1,
    on: ['floor'],
    length: .88,
    grips: [.79, .79],
    width: .25,
    depth: .2,
    reach: [.5, .86],
    sound: 'scrape',
    speed: 1.1,
    sockets: {
      lower: .79,
      upper: .79,
      shaftRadius: .014,
      carryPitch: -.22,
      carryCrossYaw: 0,
      carryUpperOffset: [.22, .86, .24],
      workPitch: 0,
      expressEquipSec: .14,
      expressUnequipSec: .16,
    },
    stroke: { pattern: 'scoop', frequencyHz: 1.0, lateralAmp: .06, forwardAmp: .12 },
  },
  'tool.cloth': {
    kind: 'tool.cloth',
    work: 'wipe',
    hands: 1,
    on: ['top', 'glass'],
    length: .03,
    grips: [.03, .03],
    width: .17,
    depth: .13,
    reach: [.2, .7],
    reachAir: 1.18,
    sound: 'rub',
    speed: 1.3,
    sockets: {
      lower: .03,
      upper: .03,
      shaftRadius: .012,
      carryPitch: 0,
      carryCrossYaw: 0,
      carryUpperOffset: [.20, .98, .25],
      workPitch: 0,
      expressEquipSec: .12,
      expressUnequipSec: .14,
    },
    stroke: { pattern: 'wipe', frequencyHz: 1.65, lateralAmp: .12, forwardAmp: .08 },
  },
  'cloth.rag': {
    kind: 'cloth.rag',
    work: 'wipe',
    hands: 1,
    on: ['top', 'glass', 'floor'],
    length: .04,
    grips: [.02, .02],
    width: .18,
    depth: .14,
    reach: [.2, .72],
    reachAir: 1.18,
    sound: 'rub',
    speed: 1.35,
    sockets: {
      lower: .02,
      upper: .02,
      shaftRadius: .012,
      carryPitch: 0,
      carryCrossYaw: 0,
      carryUpperOffset: [.20, .98, .25],
      workPitch: 0,
      expressEquipSec: .12,
      expressUnequipSec: .14,
    },
    stroke: { pattern: 'wipe', frequencyHz: 1.65, lateralAmp: .12, forwardAmp: .08 },
  },
  'sponge.block': {
    kind: 'sponge.block',
    work: 'wipe',
    hands: 1,
    on: ['top', 'glass'],
    length: .05,
    grips: [.025, .025],
    width: .12,
    depth: .08,
    reach: [.2, .68],
    reachAir: 1.12,
    sound: 'wet',
    speed: 1.25,
    sockets: {
      lower: .025,
      upper: .025,
      shaftRadius: .014,
      carryPitch: 0,
      carryCrossYaw: 0,
      carryUpperOffset: [.20, .98, .24],
      workPitch: 0,
      expressEquipSec: .12,
      expressUnequipSec: .14,
    },
    stroke: { pattern: 'wipe', frequencyHz: 1.5, lateralAmp: .10, forwardAmp: .07 },
  },
  'tool.duster': {
    kind: 'tool.duster',
    work: 'dust',
    hands: 1,
    on: ['top'],
    length: .62,
    grips: [.46, .46],
    width: .2,
    depth: .14,
    reach: [.25, .85],
    reachAir: 1.32,
    sound: 'feather',
    speed: 2,
    sockets: {
      lower: .46,
      upper: .46,
      shaftRadius: .0125,
      carryPitch: .48,
      carryCrossYaw: -.12,
      carryUpperOffset: [.20, 1.02, .26],
      workPitch: .72,
      expressEquipSec: .13,
      expressUnequipSec: .16,
    },
    stroke: { pattern: 'dust', frequencyHz: 1.85, lateralAmp: .16, forwardAmp: .06 },
  },
  'tool.webbrush': {
    kind: 'tool.webbrush',
    work: 'web',
    hands: 2,
    on: ['web'],
    length: 1.72,
    grips: [.92, 1.3],
    width: .24,
    depth: .24,
    reach: [.3, 1.5],
    reachAir: 1.95,
    sound: 'feather',
    speed: 1.8,
    sockets: {
      lower: .92,
      upper: 1.3,
      shaftRadius: .0125,
      carryPitch: .62,
      carryCrossYaw: -.24,
      carryUpperOffset: [.15, 1.12, .27],
      workPitch: .46,
      expressEquipSec: .16,
      expressUnequipSec: .18,
    },
    stroke: { pattern: 'reach', frequencyHz: 1.25, lateralAmp: .14, forwardAmp: .06 },
  },
};
export const toolOf = (kind: string | undefined | null) => (kind ? TOOLS[kind] ?? null : null);
export const toolSocketsOf = (specOrKind: ToolSpec | string | undefined | null): ToolGripSockets | null => {
  if (!specOrKind) return null;
  const spec = typeof specOrKind === 'string' ? toolOf(specOrKind) : specOrKind;
  return spec?.sockets ?? null;
};

export const isBucket = (kind: string) => kind === 'tool.bucket';
export const isBin = (kind: string) => kind === 'bin.trash';
export const isSink = (kind: string) => kind === 'sink.utility';
export const isRack = (kind: string) => kind === 'rack.cleaning';
export const isTrash = (kind: string) => kind === 'trash.paper' || kind === 'trash.bag';

/** A full bucket weighs what water weighs. */
export function massNow(kind: string, st: ObjectState | undefined, base: number) {
  const held = VESSELS[kind];
  if (held) return base + levelOf(kind, st) * held.litres;
  if (kind === 'tool.mop') return base + (st?.wet ?? 0) * .9;
  return base;
}

/** Into the bucket: the head comes out soaked, what it carried goes into the water, and the water pays for it. */
export function dip(tool: ObjectState, bucket: ObjectState): { tool: ObjectState; bucket: ObjectState } | null {
  const water = bucket.fill ?? 0;
  if (water < .06) return null;
  const load = tool.load ?? 0, dirt = bucket.dirt ?? 0;
  return {
    tool: { ...tool, wet: 1, load: Math.max(0, load * .18 + dirt * .22) },
    bucket: { ...bucket, fill: Math.max(0, water - .028), dirt: Math.min(1, dirt + load * .16 / Math.max(.25, water)) },
  };
}
/** Squeezed out: wet enough to clean, no longer a puddle. Once is enough; it never comes out dry. */
export function wring(tool: ObjectState): ObjectState { return { ...tool, wet: Math.min(tool.wet ?? 0, .55) }; }
/** Running water: as clean as the tap. */
export function rinse(tool: ObjectState): ObjectState { return { ...tool, wet: 1, load: 0 }; }
export function fillBucket(bucket: ObjectState): ObjectState { return { ...bucket, fill: 1, dirt: 0 }; }
export function pourOut(bucket: ObjectState): ObjectState { return { ...bucket, fill: 0, dirt: 0 }; }
/**
 * Things that hold a liquid: how much, where its lip is (in its own space, the way it is held upright), how wide the open top is and how far down it goes. `level` is how full it is, 0..1.
 * The world pours from the lip when the thing is tilted past where the water reaches it, and whatever falls in from above stays in it.
 */
export interface Vessel { litres: number; lip: [number, number, number]; r: number; top: number; bottom: number; lipWidth: number; speed: number; spray?: number }
export const VESSELS: Record<string, Vessel> = {
  'tool.bucket': { litres: 10, lip: [0, .3, .158], r: .135, top: .285, bottom: .02, lipWidth: .05, speed: .55 },
  mug: { litres: .24, lip: [0, .092, .04], r: .034, top: .088, bottom: .012, lipWidth: .014, speed: .28 },
  'kettle.vintage': { litres: 1, lip: [0, .165, .205], r: .05, top: .205, bottom: .03, lipWidth: .013, speed: .55 },
  'can.watering': { litres: 2.2, lip: [0, .151, .3], r: .06, top: .185, bottom: .01, lipWidth: .06, speed: 1.1, spray: .3 },
  teapot: { litres: .75, lip: [0, .115, .139], r: .052, top: .125, bottom: .02, lipWidth: .011, speed: .42 },
  teacup: { litres: .16, lip: [0, .066, .052], r: .044, top: .056, bottom: .01, lipWidth: .011, speed: .24 },
};
/**
 * The bar of each thing's handle, measured on its model, never guessed (`docs/study-space/echo-life-5-20261107/art/handle_measure.py`): where the middle of the
 * grip is, which way the bar runs, how thick it is. The hand closes round this bar from wherever the arm comes.
 * `pinch`: a loop too small for a fist, one finger through it and the thumb on top. `carry`: how it is turned once it is in the hand: `ahead` with its spout the way the eyes
 * go, `side` with its handle towards the hand that has it. `pours: 'across'`: the bar runs along the spout, so the forearm lies across it and pouring is a roll of the forearm.
 */
type HandleVector = [number, number, number];
export interface Handle {
  at: HandleVector; axis: HandleVector; r: number; pinch?: boolean;
  carry?: 'ahead' | 'side'; pours?: 'across';
  pourGrip?: { at: HandleVector; axis: HandleVector };
  /** Authored loop opening, with a cast-sized wrist offset in the same axes.
   * The opposite hand mirrors across the loop's plane. */
  loop?: typeof mugLoopAtScale;
}
export const HANDLES: Record<string, Handle> = {
  'kettle.vintage': { at: [0, .238, .076], axis: [0, 0, 1], r: .012, carry: 'ahead', pours: 'across' },
  'can.watering': { at: [-.0024, .15, -.085], axis: [0, .1, 1], r: .003, carry: 'ahead', pourGrip: { at: [-.0024, .085, -.147], axis: [0, 1, 0] } },
  teapot: { at: [0, .078, -.118], axis: [0, .84, -.54], r: .004, carry: 'side', pours: 'across' },
  teacup: { at: [0, .047, -.06], axis: [0, 1, 0], r: .002, pinch: true, carry: 'side' },
  mug: { at: [.07, .042, 0], axis: [0, 1, 0], r: .008, carry: 'side', loop: mugLoopAtScale },
  'tool.bucket': { at: [0, .49, 0], axis: [1, 0, 0], r: .006 },
};
export const vesselOf = (kind: string | undefined | null) => (kind ? VESSELS[kind] ?? null : null);
/** How full, 0..1. A mug counts sips. */
export function levelOf(kind: string, st: ObjectState | undefined) { return kind === 'mug' ? Math.max(0, Math.min(1, (st?.sips ?? 4) / 4)) : Math.max(0, Math.min(1, st?.fill ?? 0)); }
export function withLevel(kind: string, st: ObjectState | undefined, level: number): ObjectState { const v = Math.max(0, Math.min(1, level)); return kind === 'mug' ? { ...st, sips: v * 4 } : { ...st, fill: v }; }
/**
 * How far it must lean before the water reaches the lip, radians: the level surface against the lip's height and how far out the lip is. A full bucket spills at a touch, a nearly empty one has to go
 * right over, and a long spout pours at a small lean, as a watering can does.
 */
export function spillAngle(v: Vessel, level: number) {
  const water = v.bottom + (v.top - v.bottom) * Math.max(0, Math.min(1, level));
  return Math.max(.02, Math.min(1.5, Math.atan2(Math.max(.001, v.lip[1] - water), Math.max(.01, Math.hypot(v.lip[0], v.lip[2])))));
}
export const PAN_ROOM = 14;
export const BIN_ROOM = 60;

export interface RestingWallLeanPose {
  /** Grounded base position `[x, floorY, z]` with `0.0 mm` vertical hover. */
  pos: [number, number, number];
  /** Yaw facing outward along the supporting wall normal (radians). */
  rotY: number;
  /** Lean angle from vertical toward the wall (`~8-12 deg` in radians). */
  leanRad: number;
  /** Unit shaft axis `[ax, ay, az]` from floor base (`y = floorY`) to top of handle touching the wall. */
  axis: [number, number, number];
}

/**
 * Computes a physically grounded resting pose (`y = floorY`, `0.0 mm` hover) for a long tool
 * leaning at a realistic `~10 deg` (`8-12 deg`) angle against a real wall or cabinet surface
 * when not hung on `rack.cleaning`.
 */
export function restingWallLeanPose(
  kind: string,
  wallPointXZ: [number, number],
  wallOutwardXZ: [number, number],
  floorY = 0,
  leanDeg = 10,
): RestingWallLeanPose {
  const spec = toolOf(kind);
  const length = spec?.length ?? 1.36;
  const shaftRadius = spec?.sockets.shaftRadius ?? .0125;
  const headHalfDepth = (spec?.depth ?? .09) * .5;
  const nxLen = Math.hypot(wallOutwardXZ[0], wallOutwardXZ[1]) || 1;
  const nx = wallOutwardXZ[0] / nxLen;
  const nz = wallOutwardXZ[1] / nxLen;
  const clampedDeg = spec && spec.length > .9 ? Math.min(12, Math.max(8, leanDeg)) : 0;
  const leanRad = (clampedDeg * Math.PI) / 180;
  const sinL = Math.sin(leanRad);
  const cosL = Math.cos(leanRad);
  const baseStandOff = clampedDeg > 0
    ? Math.max(headHalfDepth, length * sinL + shaftRadius)
    : Math.max(headHalfDepth, shaftRadius);
  return {
    pos: [wallPointXZ[0] + nx * baseStandOff, floorY, wallPointXZ[1] + nz * baseStandOff],
    rotY: Math.atan2(nx, nz),
    leanRad,
    axis: [-nx * sinL, cosL, -nz * sinL],
  };
}
