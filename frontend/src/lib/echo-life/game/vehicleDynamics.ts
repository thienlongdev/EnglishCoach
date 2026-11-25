/**
 * Pure TypeScript vehicle physics, 4-corner spring-damper suspension,
 * Ackermann steering, handbrake drift, two-wheeler lean/fork-dive/cadence,
 * and automotive lighting & horn state machine.
 *
 * Zero DOM / Three.js / browser dependencies — runs identically in browser
 * and Node contract tests (`test-echo-life-vehicles.mjs`, `test-echo-life-game.mjs`).
 *
 * Coordinate & Sign Conventions (right-handed Y-up, Euler order 'YXZ'):
 * - Forward heading unit vector: (sin(yaw), 0, cos(yaw))  [local +Z = front, -Z = rear]
 * - Local lateral axis:          (cos(yaw), 0, -sin(yaw)) [local +X = left (side=+1), -X = right (side=-1)]
 * - Steering input `side`:       +1 = steer right (D), -1 = steer left (A)
 *   -> `steer < 0` turns right (yaw decreases as vehicle moves forward),
 *      `steer > 0` turns left  (yaw increases as vehicle moves forward).
 * - Pitch (`rotation.x`):        + = nose-dive (braking), - = squat (acceleration).
 * - Car Roll (`rotation.z`):     outward body roll on lateral G
 *   (turning right -> lateralAccel < 0 -> outside left/+X compresses -> roll < 0).
 * - Two-Wheeler Lean (`rot.z`):  inward counter-lean into turn
 *   (turning right -> steer < 0 -> lean > 0 -> leans right into turn).
 */

export const GRAVITY = 9.81;
export const WORLD_BOUNDARY_PADDING_TWO_WHEELER = 1.15;
export const WORLD_BOUNDARY_PADDING_CAR = 1.65;
export const MAX_VEHICLE_SUBSTEPS = 4;
export const BICYCLE_CRANK_GEAR_RATIO = 2.35;

export interface WorldBoundsRect {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

export interface BoundarySlidePoseResult {
  pose: VehiclePose;
  movedDistance: number;
  alignRatio: number;
  tangentYaw: number;
  speedScale: number;
  clamped: boolean;
}

export type CarClass = 'micro' | 'sedan' | 'spider' | 'hyper';
export type CarModelId =
  | 'car_mango_micro'
  | 'car_river_sedan'
  | 'car_lotus_spider'
  | 'car_halo_vector';

export type TwoWheelerClass = 'bicycle' | 'vesper' | 'cafe_racer' | 'scooter';
export type HornKind = 'car' | 'motorbike' | 'bike';
export type HeadlightMode = 'auto' | 'on' | 'off';
export type BlinkerDirection = -1 | 0 | 1;

export interface Point2D {
  x: number;
  z: number;
}

export interface VehiclePose extends Point2D {
  yaw: number;
}

export interface CarHandlingProfile {
  readonly carClass: CarClass;
  readonly model: CarModelId;
  readonly label: string;
  readonly wheelbase: number;
  readonly track: number;
  readonly length: number;
  readonly wheelRadius: number;
  readonly maxSpeed: number;
  readonly reverseSpeed: number;
  readonly acceleration: number;
  readonly braking: number;
  readonly maxSteerRad: number;
  readonly massKg: number;
  readonly cgHeight: number;
  readonly springStiffness: number;
  readonly dampingRatio: number;
  readonly antiRollStiffness: number;
  readonly maxTravel: number;
  readonly dragCoeff: number;
  readonly rollingResistance: number;
  readonly peakTorqueFactor: number;
  readonly torqueTaper: number;
  readonly baseGripG: number;
  readonly wetGripFactor: number;
  readonly handbrakeSlipRate: number;
  readonly maxSlipRad: number;
  readonly steerSpeedFactor: number;
  readonly steerSpeedQuad: number;
  readonly pitchTransferGain: number;
  readonly rollTransferGain: number;
}

export interface TwoWheelerHandlingProfile {
  readonly bikeClass: TwoWheelerClass;
  readonly label: string;
  readonly powered: boolean;
  readonly hornKind: 'bike' | 'motorbike';
  readonly wheelbase: number;
  readonly width: number;
  readonly length: number;
  readonly wheelRadius: number;
  readonly maxSpeed: number;
  readonly reverseSpeed: number;
  readonly acceleration: number;
  readonly braking: number;
  readonly maxSteerRad: number;
  readonly maxLeanRad: number;
  readonly leanNaturalFreq: number;
  readonly leanDampingRatio: number;
  readonly forkDiveMaxRad: number;
  readonly squatMaxRad: number;
  readonly forkNaturalFreq: number;
  readonly forkDampingRatio: number;
  readonly dragCoeff: number;
  readonly rollingResistance: number;
  readonly baseGripG: number;
  readonly wetGripFactor: number;
  readonly steerSpeedFactor: number;
}

export interface WheelContactState {
  side: -1 | 1;
  axle: -1 | 1;
  ground: number;
  prevGround: number;
  height: number;
  velocity: number;
  travel: number;
  spin: number;
  loadFactor: number;
}

export interface ChassisSuspensionState {
  height: number;
  pitch: number;
  roll: number;
  heaveVel: number;
  slipAngle: number;
  driftIntensity: number;
  initialized: boolean;
}

export interface TwoWheelerDynamicsState {
  lean: number;
  leanVel: number;
  forkDive: number;
  forkVel: number;
  pedalCadence: number;
  crankAngle: number;
  coasting: boolean;
  initialized: boolean;
  prevSteer?: number;
}

export interface VehicleLightState {
  headlightsMode: HeadlightMode;
  headlightsOn: boolean;
  taillightsOn: boolean;
  braking: boolean;
  reversing: boolean;
  blinker: BlinkerDirection;
  blinkerManual: boolean;
  blinkerPhase: number;
  blinkerLit: boolean;
  hornTimer: number;
  hornActive: boolean;
  hornPulseId: number;
  lastHornAt: number;
  hornKind: HornKind;
  privatePrevHornHeld: boolean;
}

export interface EnvironmentLightConditions {
  /** Normalized daylight weight: 1 = bright noon, < 0.52 = sunset/dusk/night. */
  dayWeight: number;
  /** Normalized rain intensity: 0 = dry, > 0.12 = rain/drizzle. */
  rainWeight: number;
  /** Optional normalized snow/slush intensity: 0 = clear, > 0.1 = snow/slush. */
  snowWeight?: number;
  /** Optional explicit override when sun elevation is below sunset threshold. */
  sunsetOrNight?: boolean;
}

export interface TireFrictionEllipseResult {
  fx: number;
  fy: number;
  utilization: number;
  saturated: boolean;
  lateralReserve: number;
}

export interface LongitudinalStepInput {
  speed: number;
  dt: number;
  throttle: number;
  sideInput: number;
  brake: boolean;
  handbrake: boolean;
  stopping?: boolean;
  wetRoad?: boolean;
  snowyRoad?: boolean;
  surfaceGrip?: number;
  slopeRad?: number;
  profile: Pick<
    CarHandlingProfile,
    | 'maxSpeed'
    | 'reverseSpeed'
    | 'acceleration'
    | 'braking'
    | 'dragCoeff'
    | 'rollingResistance'
    | 'peakTorqueFactor'
    | 'torqueTaper'
    | 'wetGripFactor'
  >;
}

export type LongitudinalSpeedInput = LongitudinalStepInput;

export interface LongitudinalStepResult {
  speed: number;
  forwardAccel: number;
  brakingActive: boolean;
  reversingActive: boolean;
  engineLoad: number;
}

export interface HandbrakeSlipInput {
  slipAngle: number;
  speed: number;
  sideInput: number;
  handbrake: boolean;
  driving: boolean;
  wetRoad: boolean;
  snowyRoad?: boolean;
  surfaceGrip?: number;
  throttle?: number;
  lateralAccel?: number;
  baseGripG?: number;
  massKg?: number;
  rearLoadFactor?: number;
  dt: number;
  profile: Pick<CarHandlingProfile, 'handbrakeSlipRate' | 'maxSlipRad'>;
}

export interface HandbrakeSlipResult {
  slipAngle: number;
  driftIntensity: number;
  yawRateMultiplier: number;
}

export interface CurbDeflectionResult {
  pose: VehiclePose;
  movedDistance: number;
  speedScale: number;
  deflected: boolean;
  blocked: boolean;
  bumpImpulse: number;
  contactSide: -1 | 0 | 1;
  collisionImpulse: number;
  glancingSlide: boolean;
}

export interface CarSuspensionStepInput {
  wheels: WheelContactState[];
  chassis: ChassisSuspensionState;
  profile: CarHandlingProfile;
  pose: VehiclePose;
  dt: number;
  forwardAccel: number;
  lateralAccel: number;
  groundAt: (x: number, z: number) => number | null | undefined;
  distance: number;
  turn: number;
  wheelRadius?: number;
  driving: boolean;
}

export interface CarDynamicsStepInput {
  pose: VehiclePose;
  speed: number;
  steer: number;
  spin: number;
  driving: boolean;
  stopping: boolean;
  wetRoad: boolean;
  snowyRoad?: boolean;
  surfaceGrip?: number;
  surface?: string;
  dt: number;
  throttle: number;
  sideInput: number;
  brake: boolean;
  handbrake: boolean;
  profile: CarHandlingProfile;
  specOverride?: {
    maxSpeed?: number;
    reverseSpeed?: number;
    acceleration?: number;
    braking?: number;
    maxSteerRad?: number;
    wheelRadius?: number;
  };
  wheels: WheelContactState[];
  chassis: ChassisSuspensionState;
  fitsPose: (candidate: VehiclePose) => boolean;
  groundAt: (x: number, z: number) => number | null | undefined;
  worldBounds?: WorldBoundsRect;
  boundaryPadding?: number;
}

export type CarDynamicsInput = CarDynamicsStepInput;

export interface CarDynamicsStepResult {
  speed: number;
  steer: number;
  spin: number;
  stopping: boolean;
  forwardAccel: number;
  lateralAccel: number;
  brakingActive: boolean;
  reversingActive: boolean;
  deflected: boolean;
  blocked: boolean;
  collisionImpulse: number;
  glancingSlide: boolean;
  bumpImpulse: number;
}

export type CarDynamicsResult = CarDynamicsStepResult;

export interface TwoWheelerStepInput {
  state: TwoWheelerDynamicsState;
  profile: TwoWheelerHandlingProfile;
  driving: boolean;
  speed: number;
  steer: number;
  throttle: number;
  brake: boolean;
  forwardAccel: number;
  dt: number;
  wetRoad?: boolean;
  snowyRoad?: boolean;
  surfaceGrip?: number;
}

export interface HornReactionQueryResult {
  alert: boolean;
  distance: number;
  lateralSide: -1 | 1;
  yieldOffset: Point2D;
}

// ---------------------------------------------------------------------------
// Per-Class Vehicle Profiles
// ---------------------------------------------------------------------------

export const CAR_HANDLING_PROFILES: Record<CarClass, CarHandlingProfile> = {
  micro: {
    carClass: 'micro',
    model: 'car_mango_micro',
    label: 'Mango Micro City EV',
    wheelbase: 1.744,
    track: 1.264,
    length: 2.95,
    wheelRadius: 0.3,
    maxSpeed: 13.5,
    reverseSpeed: -4.2,
    acceleration: 7.4,
    braking: 18.0,
    maxSteerRad: 0.46,
    massKg: 980,
    cgHeight: 0.56,
    springStiffness: 24500,
    dampingRatio: 0.8,
    antiRollStiffness: 8500,
    maxTravel: 0.16,
    dragCoeff: 0.0085,
    rollingResistance: 0.42,
    peakTorqueFactor: 1.24,
    torqueTaper: 0.46,
    baseGripG: 0.94,
    wetGripFactor: 0.68,
    handbrakeSlipRate: 5.4,
    maxSlipRad: 0.3,
    steerSpeedFactor: 0.032,
    steerSpeedQuad: 0.0022,
    pitchTransferGain: 2.35,
    rollTransferGain: 2.45,
  },
  sedan: {
    carClass: 'sedan',
    model: 'car_river_sedan',
    label: 'River Contemporary Sedan',
    wheelbase: 2.73,
    track: 1.534,
    length: 4.6,
    wheelRadius: 0.33,
    maxSpeed: 15.8,
    reverseSpeed: -4.6,
    acceleration: 8.6,
    braking: 20.0,
    maxSteerRad: 0.42,
    massKg: 1420,
    cgHeight: 0.54,
    springStiffness: 28500,
    dampingRatio: 0.82,
    antiRollStiffness: 12000,
    maxTravel: 0.16,
    dragCoeff: 0.0072,
    rollingResistance: 0.38,
    peakTorqueFactor: 1.26,
    torqueTaper: 0.48,
    baseGripG: 0.98,
    wetGripFactor: 0.68,
    handbrakeSlipRate: 5.8,
    maxSlipRad: 0.32,
    steerSpeedFactor: 0.031,
    steerSpeedQuad: 0.0021,
    pitchTransferGain: 2.45,
    rollTransferGain: 2.4,
  },
  spider: {
    carClass: 'spider',
    model: 'car_lotus_spider',
    label: 'Lotus Spider Roadster',
    wheelbase: 2.4,
    track: 1.534,
    length: 4.15,
    wheelRadius: 0.33,
    maxSpeed: 18.4,
    reverseSpeed: -5.0,
    acceleration: 10.8,
    braking: 22.5,
    maxSteerRad: 0.44,
    massKg: 1180,
    cgHeight: 0.45,
    springStiffness: 34000,
    dampingRatio: 0.84,
    antiRollStiffness: 18500,
    maxTravel: 0.16,
    dragCoeff: 0.0064,
    rollingResistance: 0.34,
    peakTorqueFactor: 1.3,
    torqueTaper: 0.44,
    baseGripG: 1.12,
    wetGripFactor: 0.68,
    handbrakeSlipRate: 6.6,
    maxSlipRad: 0.36,
    steerSpeedFactor: 0.029,
    steerSpeedQuad: 0.0019,
    pitchTransferGain: 2.2,
    rollTransferGain: 2.25,
  },
  hyper: {
    carClass: 'hyper',
    model: 'car_halo_vector',
    label: 'Halo Vector Hypercar',
    wheelbase: 2.932,
    track: 1.772,
    length: 4.95,
    wheelRadius: 0.35,
    maxSpeed: 21.0,
    reverseSpeed: -5.2,
    acceleration: 12.6,
    braking: 24.5,
    maxSteerRad: 0.4,
    massKg: 1340,
    cgHeight: 0.42,
    springStiffness: 40000,
    dampingRatio: 0.86,
    antiRollStiffness: 24000,
    maxTravel: 0.16,
    dragCoeff: 0.0056,
    rollingResistance: 0.32,
    peakTorqueFactor: 1.34,
    torqueTaper: 0.42,
    baseGripG: 1.22,
    wetGripFactor: 0.68,
    handbrakeSlipRate: 7.0,
    maxSlipRad: 0.34,
    steerSpeedFactor: 0.027,
    steerSpeedQuad: 0.0018,
    pitchTransferGain: 2.1,
    rollTransferGain: 2.15,
  },
};

export const CAR_MODEL_TO_CLASS: Record<CarModelId, CarClass> = {
  car_mango_micro: 'micro',
  car_river_sedan: 'sedan',
  car_lotus_spider: 'spider',
  car_halo_vector: 'hyper',
};

export const TWO_WHEELER_PROFILES: Record<TwoWheelerClass, TwoWheelerHandlingProfile> = {
  bicycle: {
    bikeClass: 'bicycle',
    label: 'Campus City Bicycle',
    powered: false,
    hornKind: 'bike',
    wheelbase: 1.09,
    width: 0.54,
    length: 1.76,
    wheelRadius: 0.342,
    maxSpeed: 7.4,
    reverseSpeed: -1.4,
    acceleration: 4.2,
    braking: 11.5,
    maxSteerRad: 0.64,
    maxLeanRad: 0.36,
    leanNaturalFreq: 8.5,
    leanDampingRatio: 0.85,
    forkDiveMaxRad: 0.042,
    squatMaxRad: 0.018,
    forkNaturalFreq: 11.0,
    forkDampingRatio: 0.84,
    dragCoeff: 0.014,
    rollingResistance: 0.32,
    baseGripG: 0.86,
    wetGripFactor: 0.72,
    steerSpeedFactor: 0.045,
  },
  scooter: {
    bikeClass: 'scooter',
    label: 'Electric Commuter Scooter',
    powered: true,
    hornKind: 'motorbike',
    wheelbase: 1.11,
    width: 0.61,
    length: 1.51,
    wheelRadius: 0.201,
    maxSpeed: 10.6,
    reverseSpeed: -1.6,
    acceleration: 6.2,
    braking: 13.5,
    maxSteerRad: 0.58,
    maxLeanRad: 0.4,
    leanNaturalFreq: 9.2,
    leanDampingRatio: 0.84,
    forkDiveMaxRad: 0.052,
    squatMaxRad: 0.028,
    forkNaturalFreq: 12.0,
    forkDampingRatio: 0.84,
    dragCoeff: 0.011,
    rollingResistance: 0.36,
    baseGripG: 0.92,
    wetGripFactor: 0.7,
    steerSpeedFactor: 0.04,
  },
  vesper: {
    bikeClass: 'vesper',
    label: 'Vesper Urban Motorbike',
    powered: true,
    hornKind: 'motorbike',
    wheelbase: 1.3,
    width: 0.66,
    length: 1.78,
    wheelRadius: 0.245,
    maxSpeed: 13.4,
    reverseSpeed: -1.8,
    acceleration: 7.6,
    braking: 16.0,
    maxSteerRad: 0.52,
    maxLeanRad: 0.45,
    leanNaturalFreq: 9.4,
    leanDampingRatio: 0.84,
    forkDiveMaxRad: 0.06,
    squatMaxRad: 0.036,
    forkNaturalFreq: 12.5,
    forkDampingRatio: 0.84,
    dragCoeff: 0.0095,
    rollingResistance: 0.34,
    baseGripG: 0.98,
    wetGripFactor: 0.68,
    steerSpeedFactor: 0.036,
  },
  cafe_racer: {
    bikeClass: 'cafe_racer',
    label: 'Cafe Racer Sport Moto',
    powered: true,
    hornKind: 'motorbike',
    wheelbase: 1.38,
    width: 0.66,
    length: 2.01,
    wheelRadius: 0.32,
    maxSpeed: 16.8,
    reverseSpeed: -2.0,
    acceleration: 9.8,
    braking: 19.0,
    maxSteerRad: 0.48,
    maxLeanRad: 0.5,
    leanNaturalFreq: 10.4,
    leanDampingRatio: 0.85,
    forkDiveMaxRad: 0.066,
    squatMaxRad: 0.042,
    forkNaturalFreq: 13.5,
    forkDampingRatio: 0.85,
    dragCoeff: 0.0082,
    rollingResistance: 0.3,
    baseGripG: 1.08,
    wetGripFactor: 0.68,
    steerSpeedFactor: 0.032,
  },
};

export const TWO_WHEELER_MODEL_TO_CLASS: Record<string, TwoWheelerClass> = {
  bicycle: 'bicycle',
  veh_bike_basket: 'bicycle',
  veh_bike_road: 'bicycle',
  veh_bike_cargo: 'bicycle',
  veh_ebike_commuter: 'bicycle',
  veh_bike_velodrome: 'bicycle',
  veh_bike_touring: 'bicycle',
  veh_scooter_electric: 'scooter',
  veh_moto_vesper: 'vesper',
  veh_moto_cafe_racer: 'cafe_racer',
  veh_moto_apex1000: 'cafe_racer',
};

// ---------------------------------------------------------------------------
// Utility & Profile Lookups
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min <= 0 && max >= 0 ? 0 : min;
  return value < min ? min : value > max ? max : value;
}

function safeFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

export function getCarHandlingProfile(modelOrClass?: string | null): CarHandlingProfile {
  if (!modelOrClass) return CAR_HANDLING_PROFILES.micro;
  if (Object.prototype.hasOwnProperty.call(CAR_HANDLING_PROFILES, modelOrClass)) {
    return CAR_HANDLING_PROFILES[modelOrClass as CarClass];
  }
  if (Object.prototype.hasOwnProperty.call(CAR_MODEL_TO_CLASS, modelOrClass)) {
    return CAR_HANDLING_PROFILES[CAR_MODEL_TO_CLASS[modelOrClass as CarModelId]];
  }
  return CAR_HANDLING_PROFILES.micro;
}

export function getTwoWheelerHandlingProfile(
  modelOrClass?: string | null,
): TwoWheelerHandlingProfile {
  if (!modelOrClass) return TWO_WHEELER_PROFILES.bicycle;
  if (Object.prototype.hasOwnProperty.call(TWO_WHEELER_PROFILES, modelOrClass)) {
    return TWO_WHEELER_PROFILES[modelOrClass as TwoWheelerClass];
  }
  if (Object.prototype.hasOwnProperty.call(TWO_WHEELER_MODEL_TO_CLASS, modelOrClass)) {
    return TWO_WHEELER_PROFILES[TWO_WHEELER_MODEL_TO_CLASS[modelOrClass]];
  }
  return TWO_WHEELER_PROFILES.bicycle;
}

// ---------------------------------------------------------------------------
// Suspension State Constructors & Helpers
// ---------------------------------------------------------------------------

export function createWheelContacts(): WheelContactState[] {
  // Order matches Automobile.wheels: [LR(-1,-1), LF(-1,+1), RR(+1,-1), RF(+1,+1)]
  const sides: readonly (-1 | 1)[] = [-1, 1];
  const axles: readonly (-1 | 1)[] = [-1, 1];
  const wheels: WheelContactState[] = [];
  for (const side of sides) {
    for (const axle of axles) {
      wheels.push({
        side,
        axle,
        ground: 0,
        prevGround: 0,
        height: 0,
        velocity: 0,
        travel: 0,
        spin: 0,
        loadFactor: 1,
      });
    }
  }
  return wheels;
}

export function createChassisState(): ChassisSuspensionState {
  return {
    height: 0,
    pitch: 0,
    roll: 0,
    heaveVel: 0,
    slipAngle: 0,
    driftIntensity: 0,
    initialized: false,
  };
}

export function resetSuspension(
  wheels: WheelContactState[],
  chassis: ChassisSuspensionState,
): void {
  chassis.height = 0;
  chassis.pitch = 0;
  chassis.roll = 0;
  chassis.heaveVel = 0;
  chassis.slipAngle = 0;
  chassis.driftIntensity = 0;
  chassis.initialized = false;
  for (const w of wheels) {
    w.ground = 0;
    w.prevGround = 0;
    w.height = 0;
    w.velocity = 0;
    w.travel = 0;
    w.spin = 0;
    w.loadFactor = 1;
  }
}

/**
 * Injects a vertical velocity impulse into selected wheel corners (e.g., curb strike,
 * speed bump, or subtle driver-side weight dip when entering/exiting the cabin).
 */
export function injectBumpHeave(
  wheels: WheelContactState[],
  impulseVel: number,
  sideFilter: -1 | 0 | 1 = 0,
  axleFilter: -1 | 0 | 1 = 0,
): void {
  const safeImpulse = clamp(impulseVel, -1.2, 1.2);
  if (Math.abs(safeImpulse) < 1e-6) return;
  for (const w of wheels) {
    if (sideFilter !== 0 && w.side !== sideFilter) continue;
    if (axleFilter !== 0 && w.axle !== axleFilter) continue;
    w.velocity = clamp(w.velocity + safeImpulse, -2.4, 2.4);
  }
}

/**
 * Injects a subtle driver-side suspension weight dip on cabin entry or upward rebound on exit.
 * Driver seat sits on the left side (`side = +1` in vehicle-local +X).
 */
export function injectDriverWeightDip(
  wheels: WheelContactState[],
  entering: boolean,
): void {
  injectBumpHeave(wheels, entering ? -0.22 : 0.18, 1, 0);
}

// ---------------------------------------------------------------------------
// Pacejka-Lite Tire Friction Ellipse & Surface Grip
// ---------------------------------------------------------------------------

export const SURFACE_GRIP_DRY_ASPHALT = 1.0;
export const SURFACE_GRIP_WET_RAIN = 0.68;
export const SURFACE_GRIP_SNOW_SLUSH = 0.46;
export const SURFACE_GRIP_COBBLESTONE = 0.86;
export const SURFACE_GRIP_GRASS = 0.62;

const PACEJKA_B = 8.5;
const PACEJKA_C = 1.45;
const PACEJKA_D = 1.0;

/**
 * Computes effective tire-road surface friction multiplier:
 * - Dry asphalt: 1.00
 * - Wet rain: 0.68
 * - Snow / slush: 0.46
 * - Cobblestone / brick / plaza: 0.86
 * - Park grass / turf: 0.62
 */
export function computeTireSurfaceGrip(
  wetRoad: boolean,
  snowyRoad = false,
  surface?: string,
): number {
  const norm = typeof surface === 'string' ? surface.trim().toLowerCase() : '';
  let isSnow = Boolean(snowyRoad);
  let isWet = Boolean(wetRoad);
  let baseGrip = SURFACE_GRIP_DRY_ASPHALT;

  if (norm) {
    if (norm.includes('snow') || norm.includes('slush') || norm.includes('ice')) {
      isSnow = true;
    } else if (norm.includes('wet') || norm.includes('rain') || norm.includes('puddle')) {
      isWet = true;
    }

    if (
      norm.includes('grass') ||
      norm.includes('park') ||
      norm.includes('lawn') ||
      norm.includes('botanical') ||
      norm.includes('turf') ||
      norm.includes('soil') ||
      norm.includes('dirt')
    ) {
      baseGrip = SURFACE_GRIP_GRASS;
    } else if (
      norm.includes('cobble') ||
      norm.includes('brick') ||
      norm.includes('plaza') ||
      norm.includes('paver') ||
      norm.includes('stone')
    ) {
      baseGrip = SURFACE_GRIP_COBBLESTONE;
    }
  }

  const weatherGrip = isSnow
    ? SURFACE_GRIP_SNOW_SLUSH
    : isWet
      ? SURFACE_GRIP_WET_RAIN
      : SURFACE_GRIP_DRY_ASPHALT;

  return clamp(baseGrip * weatherGrip, 0.28, 1.05);
}

/**
 * Pacejka-lite Magic Formula lateral tire force:
 *   Fy = -mu * Fz * D * sin(C * atan(B * alpha))
 * Opposes positive slip angle `slipAngleRad`, grows linearly at small slip angles,
 * peaks at `mu * normalLoad` near ~0.22 rad (~12.6 deg), and saturates smoothly past peak.
 */
export function computePacejkaLateralForce(
  slipAngleRad: number,
  normalLoad: number,
  mu: number,
): number {
  const alpha = clamp(safeFinite(slipAngleRad, 0), -Math.PI * 0.5, Math.PI * 0.5);
  const fz = Math.max(0, safeFinite(normalLoad, 0));
  const grip = clamp(safeFinite(mu, 0), 0, 2.5);
  if (Math.abs(alpha) < 1e-7 || fz <= 0 || grip <= 0) return 0;
  const force = -grip * fz * PACEJKA_D * Math.sin(PACEJKA_C * Math.atan(PACEJKA_B * alpha));
  return safeFinite(force, 0);
}

/**
 * Clamps combined longitudinal (`fx`) and lateral (`fy`) tire forces onto the
 * friction ellipse `sqrt((Fx / maxForce)^2 + (Fy / maxForce)^2) <= 1`.
 */
export function clampTireFrictionEllipse(
  fx: number,
  fy: number,
  maxForce: number,
): TireFrictionEllipseResult {
  const safeMax = Math.max(1e-4, safeFinite(maxForce, 0));
  const safeFx = safeFinite(fx, 0);
  const safeFy = safeFinite(fy, 0);
  const ux = safeFx / safeMax;
  const uy = safeFy / safeMax;
  const utilization = Math.hypot(ux, uy);
  const lateralReserve = Math.sqrt(Math.max(0, 1 - Math.min(1, Math.abs(ux)) ** 2));
  if (utilization <= 1) {
    return {
      fx: safeFx,
      fy: safeFy,
      utilization,
      saturated: false,
      lateralReserve,
    };
  }
  const inv = 1 / utilization;
  return {
    fx: safeFx * inv,
    fy: safeFy * inv,
    utilization,
    saturated: true,
    lateralReserve,
  };
}

// ---------------------------------------------------------------------------
// Steering, Drivetrain, Drift & Curb Deflection
// ---------------------------------------------------------------------------

/**
 * Exact Ackermann front-wheel steer angle for `side` (-1 right, +1 left).
 * Inner wheel steers tighter than outer wheel so both wheel axes meet at the turning center.
 */
export function ackermannWheelSteer(
  steerRad: number,
  wheelbase: number,
  track: number,
  side: -1 | 1,
): number {
  const safeSteer = safeFinite(steerRad, 0);
  if (Math.abs(safeSteer) < 0.0001) return 0;
  const safeBase = Math.max(0.4, safeFinite(wheelbase, 2.0));
  const safeTrack = Math.max(0.2, safeFinite(track, 1.2));
  const tanSteer = Math.tan(clamp(safeSteer, -1.25, 1.25));
  if (Math.abs(tanSteer) < 1e-6) return 0;
  const turnRadius = safeBase / tanSteer;
  let denom = turnRadius - side * safeTrack * 0.5;
  if (Math.abs(denom) < 0.08) {
    denom = (turnRadius >= 0 ? 1 : -1) * 0.08;
  }
  return Math.atan(safeBase / denom);
}

/**
 * Computes maximum safe steering angle at the current speed, combining
 * progressive speed-sensitivity curve and tire lateral grip limit.
 */
export function computeSpeedSensitiveSteerLimit(
  speed: number,
  profile: CarHandlingProfile,
  wetRoad: boolean,
  maxSteerOverride?: number,
  snowyRoad = false,
  surfaceGrip?: number,
): number {
  const absV = Math.abs(safeFinite(speed, 0));
  const baseMax = clamp(
    safeFinite(maxSteerOverride ?? profile.maxSteerRad, profile.maxSteerRad),
    0.05,
    1.1,
  );
  const speedSensitive =
    baseMax / (1 + profile.steerSpeedFactor * absV + profile.steerSpeedQuad * absV * absV);
  const muSurf =
    surfaceGrip !== undefined && Number.isFinite(surfaceGrip)
      ? clamp(surfaceGrip, 0.25, 1.25)
      : snowyRoad
        ? computeTireSurfaceGrip(wetRoad, true)
        : wetRoad
          ? profile.wetGripFactor
          : 1;
  const gripAccel = profile.baseGripG * muSurf * GRAVITY;
  const gripLimited = Math.atan((profile.wheelbase * gripAccel) / Math.max(1, absV * absV));
  return Math.min(speedSensitive, gripLimited);
}

/**
 * Integrates longitudinal velocity with progressive torque curve, reverse gear,
 * aerodynamic drag (c_d * v^2), rolling resistance, hill grade resistance,
 * service braking, handbrake behavior, and Pacejka friction-ellipse grip coupling.
 */
/**
 * Computes longitudinal road pitch `atan2(gFront - gRear, wheelbase)` while filtering out
 * discrete `0.12 m` `ROAD_DROP` curb steps (`|dh| <= 0.145 m` or single-axle terrace steps)
 * so parked or curb-straddling bicycles, scooters, and cars never drift or roll backwards on their own.
 */
export function computeFilteredRoadSlopeRad(
  gFront: number,
  gRear: number,
  wheelbase: number,
  gCenter?: number,
): number {
  const f = safeFinite(gFront, 0);
  const r = safeFinite(gRear, 0);
  const dh = f - r;
  if (Math.abs(dh) <= 0.145) return 0;
  if (gCenter !== undefined && Number.isFinite(gCenter)) {
    const dFront = f - gCenter;
    const dRear = gCenter - r;
    if ((Math.abs(dFront) < 0.015 || Math.abs(dRear) < 0.015) && Math.abs(dh) <= 0.24) {
      return 0;
    }
  }
  return Math.atan2(dh, Math.max(0.5, safeFinite(wheelbase, 1.8)));
}

export function stepLongitudinalSpeed(
  input: LongitudinalStepInput,
): LongitudinalStepResult {
  const dt = clamp(safeFinite(input.dt, 0), 0, 0.25);
  const v0 = safeFinite(input.speed, 0);
  if (dt <= 0) {
    return {
      speed: v0,
      forwardAccel: 0,
      brakingActive: false,
      reversingActive: v0 < -0.08,
      engineLoad: 0,
    };
  }

  const profile = input.profile;
  const throttle = clamp(safeFinite(input.throttle, 0), -1, 1);
  const sideAbs = Math.abs(clamp(safeFinite(input.sideInput, 0), -1, 1));
  const muSurf =
    input.surfaceGrip !== undefined && Number.isFinite(input.surfaceGrip)
      ? clamp(input.surfaceGrip, 0.25, 1.25)
      : computeTireSurfaceGrip(Boolean(input.wetRoad), Boolean(input.snowyRoad));
  const maxSpeed = Math.max(1, safeFinite(profile.maxSpeed, 15));
  const rawReverseSpeed = safeFinite(profile.reverseSpeed, -4);
  const reverseSpeed = Math.min(-0.5, -Math.abs(rawReverseSpeed || 4));
  const baseAccel = Math.max(0.5, safeFinite(profile.acceleration, 8));
  const baseBrake = Math.max(1, safeFinite(profile.braking, 18));

  const hardBrake = Boolean(input.brake || input.stopping);
  const handbrake = Boolean(input.handbrake);
  const driftHandbrake = handbrake && Math.abs(v0) > 3.5 && sideAbs > 0.2 && !hardBrake;
  const opposingThrottle =
    (v0 > 0.18 && throttle < -0.05) || (v0 < -0.18 && throttle > 0.05);

  // Slope resistance: positive slopeRad = uphill, opposes forward motion
  const slopeRad = clamp(safeFinite(input.slopeRad ?? 0, 0), -0.45, 0.45);
  const gradeAccel = -GRAVITY * Math.sin(slopeRad);

  // Aerodynamic + rolling drag always opposes current velocity direction
  const absV = Math.abs(v0);
  const dragDecel = profile.rollingResistance + profile.dragCoeff * absV * absV;

  // Friction ellipse longitudinal reserve while cornering laterally at speed
  const latDemandRatio = clamp((absV * absV * sideAbs * 0.0085) / Math.max(0.28, muSurf), 0, 0.78);
  const ellipseLongFactor = Math.sqrt(Math.max(0.38, 1 - latDemandRatio * latDemandRatio));

  let v = v0;
  let brakingActive = false;
  let engineLoad = 0;

  if (hardBrake || (handbrake && !driftHandbrake) || opposingThrottle) {
    brakingActive = true;
    const brakeScale = handbrake && !hardBrake ? 1.18 : 1.0;
    const totalDecel = (baseBrake * brakeScale * muSurf + dragDecel) * dt;
    const nextMag = Math.max(0, absV - totalDecel);
    v = absV > 1e-6 ? Math.sign(v0) * nextMag : 0;
    // Allow subtle slope creep only when not actively holding brake at rest
    if (v !== 0) {
      const graded = v + gradeAccel * dt;
      if (Math.sign(graded) !== Math.sign(v0)) v = 0;
      else v = graded;
    }
  } else {
    // Apply drag & grade first
    const coastMag = Math.max(0, absV - dragDecel * dt);
    let nextV = absV > 1e-6 ? Math.sign(v0) * coastMag : 0;

    if (driftHandbrake) {
      brakingActive = true;
      // Rear-axle drag slows vehicle moderately while sustaining controlled drift slide
      const driftDecel = baseBrake * 0.36 * muSurf * dt;
      nextV = Math.sign(nextV) * Math.max(0, Math.abs(nextV) - driftDecel);
    }

    if (throttle > 0.01 && nextV >= -0.1) {
      const speedRatio = clamp(Math.max(0, nextV) / maxSpeed, 0, 1);
      const torqueCurve =
        profile.peakTorqueFactor - profile.torqueTaper * Math.pow(speedRatio, 1.4);
      const driveAccel =
        baseAccel * throttle * Math.max(0.28, torqueCurve) * muSurf * ellipseLongFactor;
      nextV += (driveAccel + gradeAccel) * dt;
      engineLoad = throttle;
    } else if (throttle < -0.01 && nextV <= 0.1) {
      const revRatio = clamp(Math.max(0, -nextV) / Math.abs(reverseSpeed), 0, 1);
      const revCurve = 0.62 * (1.12 - 0.35 * revRatio);
      const revAccel = baseAccel * throttle * revCurve * muSurf * ellipseLongFactor;
      nextV += (revAccel + gradeAccel) * dt;
      engineLoad = Math.abs(throttle) * 0.65;
    } else if (Math.abs(nextV) > 0.05) {
      // Natural coasting engine braking + grade (ignore shallow < 0.14 rad curb/camber drift)
      const engineBrake = 1.65 * dt;
      nextV = Math.sign(nextV) * Math.max(0, Math.abs(nextV) - engineBrake);
      if (Math.abs(slopeRad) >= 0.14) {
        nextV += gradeAccel * dt;
      }
      if (
        Math.abs(nextV) < 0.05 &&
        (Math.abs(slopeRad) < 0.14 || Math.abs(gradeAccel) < profile.rollingResistance * 1.4)
      ) {
        nextV = 0;
      }
    } else {
      // Stationary rolling-friction hold: never roll or drift on shallow grades (|slopeRad| < 0.14 rad)
      if (Math.abs(slopeRad) >= 0.14 && Math.abs(gradeAccel) > profile.rollingResistance * 1.4) {
        nextV += (gradeAccel - Math.sign(gradeAccel) * profile.rollingResistance) * dt;
      } else {
        nextV = 0;
      }
    }

    v = clamp(nextV, reverseSpeed, maxSpeed);
  }

  if (Math.abs(v) < 1e-4 && Math.abs(throttle) < 0.02) {
    v = 0;
  }

  const forwardAccel = clamp((v - v0) / dt, -baseBrake * 1.35, baseAccel * 1.45);
  const reversingActive =
    v < -0.08 || (Math.abs(v) <= 0.12 && throttle < -0.1 && !hardBrake && !handbrake);

  return {
    speed: v,
    forwardAccel,
    brakingActive,
    reversingActive,
    engineLoad,
  };
}

/**
 * Updates controlled rear slip/drift angle coupled through the Pacejka-lite tire
 * friction ellipse (`sqrt((Fx/muFz)^2 + (Fy/muFz)^2) <= 1`). Heavy throttle or
 * handbrake saturates rear lateral grip, with speed-sensitive counter-steer stability
 * and smooth restoring decay back to 0 when grip recovers.
 */
export function stepHandbrakeSlip(input: HandbrakeSlipInput): HandbrakeSlipResult {
  const dt = clamp(safeFinite(input.dt, 0), 0, 0.25);
  const prevSlip = clamp(safeFinite(input.slipAngle, 0), -0.6, 0.6);
  const absV = Math.abs(safeFinite(input.speed, 0));
  const side = clamp(safeFinite(input.sideInput, 0), -1, 1);
  const maxSlip = clamp(safeFinite(input.profile.maxSlipRad, 0.34), 0.1, 0.5);
  const muSurf =
    input.surfaceGrip !== undefined && Number.isFinite(input.surfaceGrip)
      ? clamp(input.surfaceGrip, 0.25, 1.25)
      : computeTireSurfaceGrip(Boolean(input.wetRoad), Boolean(input.snowyRoad));
  const throttle = clamp(safeFinite(input.throttle ?? 0, 0), -1, 1);
  const baseGripG = clamp(safeFinite(input.baseGripG ?? 1.0, 1.0), 0.5, 1.8);
  const massKg = clamp(safeFinite(input.massKg ?? 1350, 1350), 400, 3500);
  const rearLoadFactor = clamp(safeFinite(input.rearLoadFactor ?? 1.0, 1.0), 0.35, 1.8);

  const rearMass = massKg * 0.5;
  const rearFz = rearMass * GRAVITY * rearLoadFactor;
  const muRear = baseGripG * muSurf;
  const rearMaxForce = Math.max(100, muRear * rearFz);

  const handbrakeDrifting =
    input.driving && input.handbrake && absV > 3.5 && Math.abs(side) > 0.2;

  const fxDemand = handbrakeDrifting
    ? rearMaxForce * 0.92
    : input.driving && throttle > 0.45 && absV > 2.5
      ? throttle * 0.78 * baseGripG * rearFz
      : 0;

  const estLatAccel =
    input.lateralAccel !== undefined && Number.isFinite(input.lateralAccel)
      ? Math.abs(input.lateralAccel)
      : absV * absV * Math.abs(side) * 0.0115;
  const fyDemand = rearMass * estLatAccel;
  const fyPacejka = Math.abs(
    computePacejkaLateralForce(prevSlip || side * 0.12, rearFz, muRear),
  );
  const ellipse = clampTireFrictionEllipse(
    fxDemand,
    Math.max(fyDemand, fyPacejka * 0.5),
    rearMaxForce,
  );

  // Turning right (side > 0) while moving forward yields negative slip (tail swings left, nose tucks right)
  const dirSign = input.speed >= 0 ? -1 : 1;
  const desiredSlipSign = side === 0 ? 0 : Math.sign(dirSign * side);
  const isCounterSteering =
    Math.abs(prevSlip) > 0.03 &&
    desiredSlipSign !== 0 &&
    desiredSlipSign === -Math.sign(prevSlip);

  const powerOversteer =
    !handbrakeDrifting &&
    input.driving &&
    !input.handbrake &&
    absV > 4.2 &&
    Math.abs(side) > 0.35 &&
    (throttle > 0.5 || muSurf < 0.72) &&
    ellipse.utilization > 1.02 &&
    !isCounterSteering;

  let slipAngle = prevSlip;
  if (handbrakeDrifting) {
    const gripBoost = clamp(1 + (1 - muSurf) * 0.65, 1.0, 1.48);
    const speedWeight = clamp((absV - 3.0) / 7.5, 0.2, 1.0);
    if (isCounterSteering && Math.abs(prevSlip) > 0.08) {
      const counterRate = 6.0 + 4.0 * Math.abs(side) * clamp(absV / 12, 0.3, 1.15);
      slipAngle = prevSlip * Math.exp(-counterRate * dt);
    } else {
      const targetSlip = clamp(
        dirSign * side * maxSlip * speedWeight * gripBoost,
        -maxSlip,
        maxSlip,
      );
      const rate = Math.max(1, input.profile.handbrakeSlipRate) * (1 + 0.25 * (1 - muSurf));
      const blend = 1 - Math.exp(-rate * dt);
      slipAngle = prevSlip + (targetSlip - prevSlip) * blend;
    }
  } else if (powerOversteer) {
    const excess = clamp((ellipse.utilization - 1.02) / 0.85, 0, 1);
    const reserveLoss = clamp(1 - ellipse.lateralReserve, 0.2, 1.0);
    const targetSlip = clamp(
      dirSign * side * maxSlip * clamp(excess * (0.55 + 0.45 * reserveLoss), 0.08, 0.88),
      -maxSlip,
      maxSlip,
    );
    const rate = (3.4 + 2.6 * excess) * (1 + 0.3 * (1 - muSurf));
    const blend = 1 - Math.exp(-rate * dt);
    slipAngle = prevSlip + (targetSlip - prevSlip) * blend;
  } else {
    const gripDecayScale = muSurf >= 0.99 ? 1.0 : 0.68 + 0.32 * muSurf;
    const counterAssist = isCounterSteering
      ? 4.2 * Math.abs(side) * clamp(absV / 12, 0.25, 1.1)
      : 0;
    const decayRate = 6.5 * gripDecayScale + counterAssist;
    slipAngle = prevSlip * Math.exp(-decayRate * dt);
    if (Math.abs(slipAngle) < 0.0005) slipAngle = 0;
  }

  const driftIntensity = clamp(Math.abs(slipAngle) / Math.max(0.05, maxSlip), 0, 1);
  const yawRateMultiplier = 1 + 0.35 * driftIntensity;
  return { slipAngle, driftIntensity, yawRateMultiplier };
}

const DEFLECTION_TIERS = [
  { yawOffset: 0.025, distScale: 0.86, speedScale: 0.92, bump: 0.12, impulse: 0.14 },
  { yawOffset: 0.055, distScale: 0.76, speedScale: 0.85, bump: 0.18, impulse: 0.24 },
  { yawOffset: 0.095, distScale: 0.64, speedScale: 0.76, bump: 0.25, impulse: 0.36 },
  { yawOffset: 0.145, distScale: 0.52, speedScale: 0.66, bump: 0.32, impulse: 0.48 },
] as const;
const PREF_POS_FIRST: readonly (-1 | 1)[] = [1, -1];
const PREF_NEG_FIRST: readonly (-1 | 1)[] = [-1, 1];
const AXIS_SCALES = [0.78, 0.52] as const;
const LAT_SHIFTS = [0.04, -0.04, 0.08, -0.08] as const;
const _curbCandScratch: VehiclePose = { x: 0, z: 0, yaw: 0 };
const _boundsSlidePoseScratch: VehiclePose = { x: 0, z: 0, yaw: 0 };
const _boundsSlideResScratch: BoundarySlidePoseResult = {
  pose: _boundsSlidePoseScratch,
  movedDistance: 0,
  alignRatio: 1,
  tangentYaw: 0,
  speedScale: 1,
  clamped: false,
};

/**
 * Euclidean excursion outside the `pad`-inset `bounds` safe interior (`0` inside, `> 0` outside).
 * Zero heap allocations.
 */
export function computeBoundsPenetration(
  x: number,
  z: number,
  bounds: WorldBoundsRect,
  pad: number,
): number {
  const cx = (bounds.x0 + bounds.x1) * 0.5;
  const cz = (bounds.z0 + bounds.z1) * 0.5;
  const minX = Math.min(cx, bounds.x0 + pad);
  const maxX = Math.max(cx, bounds.x1 - pad);
  const minZ = Math.min(cz, bounds.z0 + pad);
  const maxZ = Math.max(cz, bounds.z1 - pad);
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0;
  return Math.hypot(dx, dz);
}

/**
 * Smoothly clamps outward normal velocity (`v_outward -> 0`) at the `pad`-inset `bounds` perimeter
 * while preserving tangential velocity (`slidePoseAlongBounds`), and NEVER blocking inward recovery
 * when `currentPose` already lies within the soft perimeter margin.
 */
export function slidePoseAlongBounds(
  currentPose: VehiclePose,
  nextPose: VehiclePose,
  bounds: WorldBoundsRect,
  pad: number,
  outPose?: VehiclePose,
): BoundarySlidePoseResult {
  const cx = (bounds.x0 + bounds.x1) * 0.5;
  const cz = (bounds.z0 + bounds.z1) * 0.5;
  const minX = Math.min(cx, bounds.x0 + pad);
  const maxX = Math.max(cx, bounds.x1 - pad);
  const minZ = Math.min(cz, bounds.z0 + pad);
  const maxZ = Math.max(cz, bounds.z1 - pad);

  const dx = nextPose.x - currentPose.x;
  const dz = nextPose.z - currentPose.z;
  let nx = nextPose.x;
  let nz = nextPose.z;
  let clampedX = false;
  let clampedZ = false;

  if (nx < minX && dx < 0) {
    nx = currentPose.x >= minX ? minX : currentPose.x;
    clampedX = true;
  } else if (nx > maxX && dx > 0) {
    nx = currentPose.x <= maxX ? maxX : currentPose.x;
    clampedX = true;
  }
  if (nz < minZ && dz < 0) {
    nz = currentPose.z >= minZ ? minZ : currentPose.z;
    clampedZ = true;
  } else if (nz > maxZ && dz > 0) {
    nz = currentPose.z <= maxZ ? maxZ : currentPose.z;
    clampedZ = true;
  }

  const target = outPose ?? _boundsSlidePoseScratch;
  target.x = nx;
  target.z = nz;
  target.yaw = nextPose.yaw;

  const origDist = Math.hypot(dx, dz);
  const sdx = nx - currentPose.x;
  const sdz = nz - currentPose.z;
  const slidDist = Math.hypot(sdx, sdz);
  const dirSign = Math.sin(currentPose.yaw) * dx + Math.cos(currentPose.yaw) * dz >= 0 ? 1 : -1;
  const alignRatio = origDist > 1e-6 ? clamp(slidDist / origDist, 0, 1) : 1;
  const tangentYaw =
    slidDist > 1e-6 ? Math.atan2(dirSign * sdx, dirSign * sdz) : nextPose.yaw;

  _boundsSlideResScratch.pose = target;
  _boundsSlideResScratch.movedDistance = dirSign * slidDist;
  _boundsSlideResScratch.alignRatio = alignRatio;
  _boundsSlideResScratch.tangentYaw = tangentYaw;
  _boundsSlideResScratch.speedScale = clampedX || clampedZ ? clamp(0.88 + 0.12 * alignRatio, 0.65, 1) : 1;
  _boundsSlideResScratch.clamped = clampedX || clampedZ;
  return _boundsSlideResScratch;
}

/**
 * Progressive tangent-projected curb and wall deflection: when a forward step clips
 * a curb or boundary, tests progressive smaller-to-larger yaw deflections, axis-aligned
 * road-tangent wall slides, and vehicle-local lateral peel-offs before declaring a hard
 * head-on block (returning exact currentPose with proportional collisionImpulse).
 * Uses reusable scratch poses in candidate loops for zero steady-state GC churn.
 */
export function resolveCurbDeflection(
  currentPose: VehiclePose,
  nextPose: VehiclePose,
  stepDistance: number,
  fitsPose: (candidate: VehiclePose) => boolean,
): CurbDeflectionResult {
  if (fitsPose(nextPose)) {
    return {
      pose: { x: nextPose.x, z: nextPose.z, yaw: nextPose.yaw },
      movedDistance: stepDistance,
      speedScale: 1,
      deflected: false,
      blocked: false,
      bumpImpulse: 0,
      contactSide: 0,
      collisionImpulse: 0,
      glancingSlide: false,
    };
  }

  const dx = nextPose.x - currentPose.x;
  const dz = nextPose.z - currentPose.z;
  const moveMag = Math.hypot(dx, dz);
  const absStep = Math.abs(safeFinite(stepDistance, 0));
  const moveSign = stepDistance >= 0 ? 1 : -1;
  const approachDist = Math.max(absStep, moveMag);
  const approachFactor = clamp(approachDist / 0.09, 0.35, 1.25);

  // 1. Progressive tangent yaw deflection angles (smallest yaw recovery first)
  if (absStep > 1e-4) {
    const yawDelta = nextPose.yaw - currentPose.yaw;
    const preferredOrder = yawDelta <= 0 ? PREF_POS_FIRST : PREF_NEG_FIRST;

    for (let tIdx = 0; tIdx < DEFLECTION_TIERS.length; tIdx++) {
      const tier = DEFLECTION_TIERS[tIdx];
      const tanDist = stepDistance * tier.distScale;
      for (let dIdx = 0; dIdx < preferredOrder.length; dIdx++) {
        const yawDir = preferredOrder[dIdx];
        const candYaw = currentPose.yaw + yawDir * tier.yawOffset;
        const mid = (currentPose.yaw + candYaw) * 0.5;
        _curbCandScratch.x = currentPose.x + tanDist * Math.sin(mid);
        _curbCandScratch.z = currentPose.z + tanDist * Math.cos(mid);
        _curbCandScratch.yaw = candYaw;
        if (fitsPose(_curbCandScratch)) {
          return {
            pose: { x: _curbCandScratch.x, z: _curbCandScratch.z, yaw: _curbCandScratch.yaw },
            movedDistance: tanDist,
            speedScale: tier.speedScale,
            deflected: true,
            blocked: false,
            bumpImpulse: clamp(tier.bump * approachFactor, 0.06, 0.55),
            contactSide: (yawDir === 1 ? -1 : 1) as -1 | 1,
            collisionImpulse: clamp(tier.impulse * approachFactor, 0.05, 0.85),
            glancingSlide: true,
          };
        }
      }
    }
  }

  // 2. Axis-aligned road-tangent wall slide (sorted by larger displacement component)
  const tryXFirst = Math.abs(dx) >= Math.abs(dz);
  for (let sIdx = 0; sIdx < AXIS_SCALES.length; sIdx++) {
    const scale = AXIS_SCALES[sIdx];
    for (let pass = 0; pass < 2; pass++) {
      const isX = pass === 0 ? tryXFirst : !tryXFirst;
      const comp = isX ? dx : dz;
      if (Math.abs(comp) <= 1e-4) continue;
      _curbCandScratch.x = isX ? currentPose.x + dx * scale : currentPose.x;
      _curbCandScratch.z = isX ? currentPose.z : currentPose.z + dz * scale;
      _curbCandScratch.yaw = currentPose.yaw;
      if (fitsPose(_curbCandScratch)) {
        const alignCos = moveMag > 1e-5 ? clamp(Math.abs(comp) / moveMag, 0, 1) : 0.5;
        const speedScale = clamp(
          (0.58 + 0.34 * alignCos) * (scale === 0.78 ? 1 : 0.88),
          0.5,
          0.92,
        );
        const glanceImpact = clamp((1 - alignCos * 0.65) * 0.52 * approachFactor, 0.08, 0.8);
        return {
          pose: { x: _curbCandScratch.x, z: _curbCandScratch.z, yaw: _curbCandScratch.yaw },
          movedDistance: moveSign * Math.abs(comp) * scale,
          speedScale,
          deflected: true,
          blocked: false,
          bumpImpulse: clamp((0.14 + (1 - alignCos) * 0.18) * approachFactor, 0.08, 0.45),
          contactSide: 0,
          collisionImpulse: glanceImpact,
          glancingSlide: true,
        };
      }
    }
  }

  // 3. Lateral wall-slide peel-off along vehicle-local tangent (handles angled curbs/walls)
  if (absStep > 1e-4) {
    const sinY = Math.sin(currentPose.yaw);
    const cosY = Math.cos(currentPose.yaw);
    const fwdDist = stepDistance * 0.62;
    for (let lIdx = 0; lIdx < LAT_SHIFTS.length; lIdx++) {
      const latShift = LAT_SHIFTS[lIdx];
      _curbCandScratch.x = currentPose.x + fwdDist * sinY + latShift * cosY;
      _curbCandScratch.z = currentPose.z + fwdDist * cosY - latShift * sinY;
      _curbCandScratch.yaw = currentPose.yaw;
      if (fitsPose(_curbCandScratch)) {
        const sideSign: -1 | 1 = latShift > 0 ? -1 : 1;
        return {
          pose: { x: _curbCandScratch.x, z: _curbCandScratch.z, yaw: _curbCandScratch.yaw },
          movedDistance: fwdDist,
          speedScale: 0.74,
          deflected: true,
          blocked: false,
          bumpImpulse: clamp(0.2 * approachFactor, 0.08, 0.45),
          contactSide: sideSign,
          collisionImpulse: clamp(0.34 * approachFactor, 0.1, 0.75),
          glancingSlide: true,
        };
      }
    }
  }

  // 4. Fully blocked head-on
  const blockedImpulse =
    approachDist > 1e-5 ? clamp(0.18 + (approachDist / 0.09) * 0.62, 0.18, 1.0) : 0;
  return {
    pose: { x: currentPose.x, z: currentPose.z, yaw: currentPose.yaw },
    movedDistance: 0,
    speedScale: 0,
    deflected: false,
    blocked: true,
    bumpImpulse: blockedImpulse > 0 ? clamp(blockedImpulse * 0.45, 0.08, 0.5) : 0,
    contactSide: 0,
    collisionImpulse: blockedImpulse,
    glancingSlide: false,
  };
}

const SUSP_PARTNER_IDX = [2, 3, 0, 1] as const;
const _suspDisp = [0, 0, 0, 0];
const _suspVels = [0, 0, 0, 0];
const _carNextPoseScratch: VehiclePose = { x: 0, z: 0, yaw: 0 };
const _carPivotPoseScratch: VehiclePose = { x: 0, z: 0, yaw: 0 };

/**
 * Steps the 4-corner spring-damper suspension with CG height moment-arm weight transfer,
 * left-right anti-roll bar coupling (`K_arb`), vertical curb/bump heave impulses,
 * and continuous settling even when parked (`driving === false`).
 */
export function stepCarSuspension(input: CarSuspensionStepInput): void {
  const { wheels, chassis, profile, pose, groundAt, driving } = input;
  const dt = clamp(safeFinite(input.dt, 0), 0, 0.1);
  if (wheels.length !== 4 || dt <= 0) return;

  const base = Math.max(0.8, profile.wheelbase);
  const track = Math.max(0.6, profile.track);
  const wheelRadius = Math.max(0.15, safeFinite(input.wheelRadius ?? profile.wheelRadius, 0.32));
  const sin = Math.sin(pose.yaw);
  const cos = Math.cos(pose.yaw);
  const centerGround = safeFinite(groundAt(pose.x, pose.z) ?? 0, 0);

  const forwardAccel = driving ? clamp(safeFinite(input.forwardAccel, 0), -35, 35) : 0;
  const lateralAccel = driving ? clamp(safeFinite(input.lateralAccel, 0), -25, 25) : 0;
  const distance = driving ? safeFinite(input.distance, 0) : 0;
  const turn = driving ? safeFinite(input.turn, 0) : 0;

  const wasInitialized = chassis.initialized;

  // Sample ground contact patch under each corner & inject curb/bump heave impulse
  for (const wheel of wheels) {
    const lx = wheel.side * track * 0.5;
    const lz = wheel.axle * base * 0.5;
    const wx = pose.x + lx * cos + lz * sin;
    const wz = pose.z - lx * sin + lz * cos;
    const g = safeFinite(groundAt(wx, wz) ?? centerGround, centerGround);

    if (!wasInitialized) {
      wheel.ground = g;
      wheel.prevGround = g;
      wheel.height = g;
      wheel.velocity = 0;
      wheel.travel = 0;
      wheel.loadFactor = 1;
    } else {
      const deltaG = g - wheel.ground;
      wheel.prevGround = wheel.ground;
      wheel.ground = g;
      // Realistic curb/bump heave impulse (ignore huge >0.45 m teleports, snap instead)
      if (Math.abs(deltaG) > 0.45) {
        wheel.height = g;
        wheel.velocity = 0;
      } else if (Math.abs(deltaG) > 0.015) {
        const heaveImpulse = clamp(deltaG * 4.2, -0.65, 0.65);
        wheel.velocity = clamp(wheel.velocity + heaveImpulse, -2.4, 2.4);
      }
    }
  }

  const quarterMass = Math.max(80, profile.massKg * 0.25);
  const k = Math.max(5000, profile.springStiffness);
  const kArb = Math.max(0, profile.antiRollStiffness);
  const zeta = clamp(profile.dampingRatio, 0.55, 1.15);
  const c = 2 * zeta * Math.sqrt(k * quarterMass);
  // Anti-roll damper keeps roll mode critically-adjacent damped alongside heave mode
  const cArb = kArb > 0 ? 0.55 * zeta * Math.sqrt(kArb * quarterMass) : 0;

  // Compute CG moment-arm load transfer acceleration per corner
  const longTransferBase =
    ((forwardAccel * profile.cgHeight) / base) * profile.pitchTransferGain;
  const latTransferBase =
    ((lateralAccel * profile.cgHeight) / track) * profile.rollTransferGain;

  const substeps = Math.min(6, Math.max(1, Math.ceil(dt * 120)));
  const step = dt / substeps;

  // Wheels array layout: 0=LR(-1,-1), 1=LF(-1,+1), 2=RR(+1,-1), 3=RF(+1,+1)
  // Opposite-side partner map: 0<->2 (rear axle), 1<->3 (front axle)
  for (let s = 0; s < substeps; s++) {
    // Capture displacements and velocities symmetrically before updating all 4 corners
    _suspDisp[0] = wheels[0].height - wheels[0].ground;
    _suspDisp[1] = wheels[1].height - wheels[1].ground;
    _suspDisp[2] = wheels[2].height - wheels[2].ground;
    _suspDisp[3] = wheels[3].height - wheels[3].ground;
    _suspVels[0] = wheels[0].velocity;
    _suspVels[1] = wheels[1].velocity;
    _suspVels[2] = wheels[2].velocity;
    _suspVels[3] = wheels[3].velocity;

    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const pIdx = SUSP_PARTNER_IDX[i];
      const springForce = -k * _suspDisp[i] - c * _suspVels[i];
      const arbForce = kArb * (_suspDisp[pIdx] - _suspDisp[i]) + cArb * (_suspVels[pIdx] - _suspVels[i]);
      const transfer = w.axle * longTransferBase + w.side * latTransferBase;
      const accel = (springForce + arbForce) / quarterMass + transfer;

      const nextVel = clamp(w.velocity + accel * step, -4.0, 4.0);
      const nextHeight = w.height + nextVel * step;
      // Clamp extreme compression/rebound around ground to maintain numeric stability
      const maxExcursion = profile.maxTravel * 1.45;
      if (nextHeight - w.ground > maxExcursion) {
        w.height = w.ground + maxExcursion;
        w.velocity = Math.min(0, nextVel * 0.4);
      } else if (nextHeight - w.ground < -maxExcursion) {
        w.height = w.ground - maxExcursion;
        w.velocity = Math.max(0, nextVel * 0.4);
      } else {
        w.height = nextHeight;
        w.velocity = nextVel;
      }
    }
  }

  // Update per-wheel differential spin and normalized vertical contact load
  for (const w of wheels) {
    if (Math.abs(distance) > 1e-7 || Math.abs(turn) > 1e-7) {
      const lx = w.side * track * 0.5;
      const longitudinal = distance - lx * turn;
      const lateralSlip = w.axle > 0 ? base * turn : 0;
      const dirSign = distance === 0 ? 0 : Math.sign(distance);
      w.spin = safeFinite(
        w.spin + (dirSign * Math.hypot(longitudinal, lateralSlip)) / wheelRadius,
        w.spin,
      );
    }
    const cornerForce = k * (w.ground - w.height) - c * w.velocity;
    w.loadFactor = clamp(1 + cornerForce / (quarterMass * GRAVITY), 0, 2.2);
  }

  const [lr, lf, rr, rf] = wheels;
  chassis.initialized = true;
  chassis.height = safeFinite((lr.height + lf.height + rr.height + rf.height) * 0.25, centerGround);
  chassis.pitch = clamp(
    Math.atan2(lr.height + rr.height - lf.height - rf.height, 2 * base),
    -0.28,
    0.28,
  );
  chassis.roll = clamp(
    Math.atan2(rr.height + rf.height - lr.height - lf.height, 2 * track),
    -0.28,
    0.28,
  );
  chassis.heaveVel = safeFinite(
    (lr.velocity + lf.velocity + rr.velocity + rf.velocity) * 0.25,
    0,
  );

  const sinPitch = Math.sin(chassis.pitch);
  const sinRoll = Math.sin(chassis.roll);
  const maxTravel = profile.maxTravel;
  for (const w of wheels) {
    const mount =
      chassis.height +
      w.side * (track * 0.5) * sinRoll -
      w.axle * (base * 0.5) * sinPitch;
    w.travel = clamp(w.ground - mount, -maxTravel, maxTravel);
  }
}

/**
 * Convenience helper for settling suspension smoothly while parked (`driving === false`).
 */
export function stepIdleCarSuspension(
  wheels: WheelContactState[],
  chassis: ChassisSuspensionState,
  profile: CarHandlingProfile,
  pose: VehiclePose,
  dt: number,
  groundAt: (x: number, z: number) => number | null | undefined,
): void {
  if (!chassis.initialized) return;
  // Also decay any residual drift slip angle while parked
  chassis.slipAngle *= Math.exp(-6.5 * clamp(safeFinite(dt, 0), 0, 0.25));
  if (Math.abs(chassis.slipAngle) < 0.0005) chassis.slipAngle = 0;
  chassis.driftIntensity = 0;
  stepCarSuspension({
    wheels,
    chassis,
    profile,
    pose,
    dt,
    forwardAccel: 0,
    lateralAccel: 0,
    groundAt,
    distance: 0,
    turn: 0,
    driving: false,
  });
}

// ---------------------------------------------------------------------------
// Complete Car Dynamics Step (Speed + Steering + Drift + Curb + Suspension)
// ---------------------------------------------------------------------------

export function stepCarDynamics(input: CarDynamicsStepInput): CarDynamicsStepResult {
  const dt = clamp(safeFinite(input.dt, 0), 0, 0.1);
  if (dt <= 0) {
    return {
      speed: input.speed,
      steer: input.steer,
      spin: input.spin,
      stopping: input.stopping,
      forwardAccel: 0,
      lateralAccel: 0,
      brakingActive: false,
      reversingActive: input.speed < -0.08,
      deflected: false,
      blocked: false,
      collisionImpulse: 0,
      glancingSlide: false,
      bumpImpulse: 0,
    };
  }

  const { profile, pose, wheels, chassis, groundAt, fitsPose } = input;

  if (!input.driving) {
    stepIdleCarSuspension(wheels, chassis, profile, pose, dt, groundAt);
    return {
      speed: 0,
      steer: input.steer * Math.exp(-6 * dt),
      spin: input.spin,
      stopping: false,
      forwardAccel: 0,
      lateralAccel: 0,
      brakingActive: false,
      reversingActive: false,
      deflected: false,
      blocked: false,
      collisionImpulse: 0,
      glancingSlide: false,
      bumpImpulse: 0,
    };
  }

  const effProfile: CarHandlingProfile = input.specOverride
    ? {
        ...profile,
        maxSpeed: input.specOverride.maxSpeed ?? profile.maxSpeed,
        reverseSpeed: input.specOverride.reverseSpeed ?? profile.reverseSpeed,
        acceleration: input.specOverride.acceleration ?? profile.acceleration,
        braking: input.specOverride.braking ?? profile.braking,
        maxSteerRad: input.specOverride.maxSteerRad ?? profile.maxSteerRad,
        wheelRadius: input.specOverride.wheelRadius ?? profile.wheelRadius,
      }
    : profile;

  const prevSpeed = safeFinite(input.speed, 0);
  const prevSpin = safeFinite(input.spin, 0);
  const prevYaw = pose.yaw;
  const wasInitialized = chassis.initialized;

  const muSurf =
    input.surfaceGrip !== undefined && Number.isFinite(input.surfaceGrip)
      ? clamp(input.surfaceGrip, 0.25, 1.25)
      : computeTireSurfaceGrip(Boolean(input.wetRoad), Boolean(input.snowyRoad), input.surface);

  const rearLoadFactor =
    wasInitialized && wheels.length === 4
      ? clamp((wheels[0].loadFactor + wheels[2].loadFactor) * 0.5, 0.4, 1.8)
      : 1.0;
  const frontLoadFactor =
    wasInitialized && wheels.length === 4
      ? clamp((wheels[1].loadFactor + wheels[3].loadFactor) * 0.5, 0.4, 1.8)
      : 1.0;

  // Sample front/rear road elevation for slope resistance (filtering discrete 0.12 m curb steps)
  const sin0 = Math.sin(pose.yaw);
  const cos0 = Math.cos(pose.yaw);
  const halfBase = effProfile.wheelbase * 0.5;
  const gCenter = safeFinite(groundAt(pose.x, pose.z) ?? 0, 0);
  const gFront = safeFinite(
    groundAt(pose.x + halfBase * sin0, pose.z + halfBase * cos0) ?? gCenter,
    gCenter,
  );
  const gRear = safeFinite(
    groundAt(pose.x - halfBase * sin0, pose.z - halfBase * cos0) ?? gCenter,
    gCenter,
  );
  const slopeRad = computeFilteredRoadSlopeRad(gFront, gRear, effProfile.wheelbase, gCenter);

  const longRes = stepLongitudinalSpeed({
    speed: prevSpeed,
    dt,
    throttle: input.throttle,
    sideInput: input.sideInput,
    brake: input.brake,
    handbrake: input.handbrake,
    stopping: input.stopping,
    wetRoad: input.wetRoad,
    snowyRoad: input.snowyRoad,
    surfaceGrip: muSurf,
    slopeRad,
    profile: effProfile,
  });

  let speed = longRes.speed;
  let stopping = input.stopping && Math.abs(speed) > 1e-4;

  // Speed-sensitive + grip-limited steering angle
  const maxSteerNow = computeSpeedSensitiveSteerLimit(
    speed,
    effProfile,
    input.wetRoad,
    effProfile.maxSteerRad,
    input.snowyRoad,
    muSurf,
  );
  const clampedSide = clamp(safeFinite(input.sideInput, 0), -1, 1);
  const targetSteer = -clampedSide * maxSteerNow;
  const steer =
    safeFinite(input.steer, 0) + (targetSteer - safeFinite(input.steer, 0)) * (1 - Math.exp(-7.5 * dt));

  // Front-axle Pacejka-lite lateral grip coupling on the friction ellipse
  const nominalYawRate = (speed * Math.tan(steer)) / effProfile.wheelbase;
  const nominalLatAccel = speed * nominalYawRate;
  const frontMass = effProfile.massKg * 0.5;
  const frontFz = frontMass * GRAVITY * frontLoadFactor;
  const muFront = effProfile.baseGripG * muSurf;
  const frontFx = Math.abs(longRes.forwardAccel) * frontMass * (longRes.brakingActive ? 0.65 : 0.35);
  const frontFyReq = Math.abs(nominalLatAccel) * frontMass;
  const frontSlipEst = clamp(Math.abs(steer) * 0.38, 0, 0.35);
  const frontFyCap = Math.abs(
    computePacejkaLateralForce(Math.max(frontSlipEst, 0.16), frontFz, muFront),
  );
  const frontEllipse = clampTireFrictionEllipse(frontFx, frontFyReq, Math.max(100, frontFyCap));
  const cornerGripScale =
    frontFyReq > 50 && frontEllipse.saturated
      ? clamp(Math.abs(frontEllipse.fy) / frontFyReq, 0.48, 1.0)
      : 1.0;

  // Handbrake & throttle friction-ellipse rear slip/drift angle
  const slipRes = stepHandbrakeSlip({
    slipAngle: chassis.slipAngle,
    speed,
    sideInput: clampedSide,
    handbrake: input.handbrake,
    driving: true,
    wetRoad: input.wetRoad,
    snowyRoad: input.snowyRoad,
    surfaceGrip: muSurf,
    throttle: input.throttle,
    lateralAccel: nominalLatAccel * cornerGripScale,
    baseGripG: effProfile.baseGripG,
    massKg: effProfile.massKg,
    rearLoadFactor,
    dt,
    profile: effProfile,
  });
  chassis.slipAngle = slipRes.slipAngle;
  chassis.driftIntensity = slipRes.driftIntensity;

  // Substepped kinematic motion + smooth boundary sliding + progressive curb/wall deflection (`<= 4` zero-GC substeps)
  let spin = prevSpin;
  let deflected = false;
  let blocked = false;
  let glancingSlide = false;
  let maxCollisionImpulse = 0;
  let maxBumpImpulse = 0;
  const travel = speed * dt;
  const moveSteps = Math.min(MAX_VEHICLE_SUBSTEPS, Math.max(1, Math.ceil(Math.abs(travel) / 0.09)));
  const worldBounds = input.worldBounds;
  const boundPad =
    input.boundaryPadding ??
    Math.max(
      WORLD_BOUNDARY_PADDING_CAR,
      Math.hypot(effProfile.track * 0.5 + 0.12, effProfile.length * 0.5) + 0.08,
    );

  for (let i = 0; i < moveSteps; i++) {
    const d = travel / moveSteps;
    const dYaw =
      (d * Math.tan(steer) * cornerGripScale * slipRes.yawRateMultiplier) / effProfile.wheelbase;
    const nextYaw = pose.yaw + dYaw;
    const mid = (pose.yaw + nextYaw) * 0.5;
    _carNextPoseScratch.x = pose.x + d * Math.sin(mid);
    _carNextPoseScratch.z = pose.z + d * Math.cos(mid);
    _carNextPoseScratch.yaw = nextYaw;

    if (worldBounds) {
      const penCurr = computeBoundsPenetration(pose.x, pose.z, worldBounds, boundPad);
      const penNext = computeBoundsPenetration(_carNextPoseScratch.x, _carNextPoseScratch.z, worldBounds, boundPad);
      if (penNext > penCurr + 1e-6) {
        const bSlide = slidePoseAlongBounds(pose, _carNextPoseScratch, worldBounds, boundPad);
        if (bSlide.clamped && Math.abs(bSlide.movedDistance) > 1e-5) {
          const subDt = dt / moveSteps;
          if (Math.abs(clampedSide) < 0.08 && bSlide.alignRatio > 0.18) {
            let dy = (bSlide.tangentYaw - bSlide.pose.yaw) % (Math.PI * 2);
            if (dy > Math.PI) dy -= Math.PI * 2;
            if (dy < -Math.PI) dy += Math.PI * 2;
            bSlide.pose.yaw += dy * (1 - Math.exp(-3.2 * subDt));
          }
          if (fitsPose(bSlide.pose)) {
            pose.x = bSlide.pose.x;
            pose.z = bSlide.pose.z;
            pose.yaw = bSlide.pose.yaw;
            spin += bSlide.movedDistance / effProfile.wheelRadius;
            speed *= 1 - (1 - bSlide.alignRatio) * Math.min(0.25, 2.0 * subDt);
            deflected = true;
            glancingSlide = true;
            continue;
          }
        }
      }
    }

    const col = resolveCurbDeflection(pose, _carNextPoseScratch, d, fitsPose);
    if (col.blocked) {
      const impactSpeedFactor = clamp(
        Math.abs(speed) / Math.max(4, effProfile.maxSpeed * 0.6),
        0.2,
        1.0,
      );
      const impactImpulse = clamp(col.collisionImpulse * (0.4 + 0.6 * impactSpeedFactor), 0, 1);
      maxCollisionImpulse = Math.max(maxCollisionImpulse, impactImpulse);
      maxBumpImpulse = Math.max(maxBumpImpulse, Math.max(col.bumpImpulse, impactImpulse * 0.45));
      if (impactImpulse > 0.05) {
        const hitAxle: -1 | 1 = speed >= 0 ? 1 : -1;
        const oppAxle: -1 | 1 = hitAxle === 1 ? -1 : 1;
        injectBumpHeave(wheels, -0.52 * impactImpulse, 0, hitAxle);
        injectBumpHeave(wheels, 0.24 * impactImpulse, 0, oppAxle);
      }
      speed = 0;
      stopping = false;
      blocked = true;
      break;
    }
    pose.x = col.pose.x;
    pose.z = col.pose.z;
    pose.yaw = col.pose.yaw;
    spin += col.movedDistance / effProfile.wheelRadius;
    if (col.deflected) {
      deflected = true;
      glancingSlide ||= col.glancingSlide;
      speed *= col.speedScale;
      maxCollisionImpulse = Math.max(maxCollisionImpulse, col.collisionImpulse);
      maxBumpImpulse = Math.max(maxBumpImpulse, col.bumpImpulse);
      if (col.bumpImpulse > 0) {
        injectBumpHeave(wheels, col.bumpImpulse, col.contactSide, 0);
      }
    }
  }

  // Escape-Gradient Steering Assist: when blocked or stationary at a boundary/wall while holding A/D,
  // allow low-speed wheel-scrubbing yaw recovery so the driver can always turn away cleanly.
  if (Math.abs(speed) < 0.25 && Math.abs(clampedSide) > 0.05 && (blocked || Math.abs(input.throttle) > 0.05)) {
    const scrubDir = input.throttle < -0.05 ? 1 : -1;
    _carPivotPoseScratch.x = pose.x;
    _carPivotPoseScratch.z = pose.z;
    _carPivotPoseScratch.yaw = pose.yaw + scrubDir * clampedSide * 0.95 * dt;
    if (fitsPose(_carPivotPoseScratch)) {
      pose.yaw = _carPivotPoseScratch.yaw;
    }
  }

  const actualDistance = (spin - prevSpin) * effProfile.wheelRadius;
  const turn = pose.yaw - prevYaw;
  const forwardAccel = clamp(
    (speed - prevSpeed) / dt,
    -effProfile.braking * 1.35,
    effProfile.acceleration * 1.45,
  );
  const lateralAccel = clamp((speed * turn) / dt, -22, 22);

  stepCarSuspension({
    wheels,
    chassis,
    profile: effProfile,
    pose,
    dt,
    forwardAccel,
    lateralAccel,
    groundAt,
    distance: actualDistance,
    turn,
    wheelRadius: effProfile.wheelRadius,
    driving: true,
  });

  if (wasInitialized) {
    for (const w of wheels) {
      const dg = Math.abs(w.ground - w.prevGround);
      if (dg > 0.015 && dg <= 0.45) {
        maxBumpImpulse = Math.max(maxBumpImpulse, clamp(dg * 4.2, 0, 1));
      }
    }
  }

  return {
    speed,
    steer,
    spin,
    stopping,
    forwardAccel,
    lateralAccel,
    brakingActive: longRes.brakingActive,
    reversingActive: longRes.reversingActive,
    deflected,
    blocked,
    collisionImpulse: maxCollisionImpulse,
    glancingSlide,
    bumpImpulse: maxBumpImpulse,
  };
}

// ---------------------------------------------------------------------------
// Two-Wheeler Lean, Fork Dive & Pedal Cadence vs Coasting
// ---------------------------------------------------------------------------

export function createTwoWheelerState(): TwoWheelerDynamicsState {
  return {
    lean: 0,
    leanVel: 0,
    forkDive: 0,
    forkVel: 0,
    pedalCadence: 0,
    crankAngle: 0,
    coasting: true,
    initialized: false,
    prevSteer: 0,
  };
}

export function resetTwoWheelerState(state: TwoWheelerDynamicsState): void {
  state.lean = 0;
  state.leanVel = 0;
  state.forkDive = 0;
  state.forkVel = 0;
  state.pedalCadence = 0;
  state.crankAngle = 0;
  state.coasting = true;
  state.initialized = false;
  state.prevSteer = 0;
}

/**
 * Computes physics-based inward lean `atan(v^2 * tan(delta) / (g * L))` with
 * wet/snow surface grip caps and smooth gyroscopic counter-steer lean response,
 * front-fork braking dive / acceleration squat, and bicycle pedal-cadence vs coasting.
 * Smoothly settles lean and fork dive back to upright even after dismounting (`driving === false`).
 */
export function stepTwoWheelerDynamics(input: TwoWheelerStepInput): void {
  const { state, profile, driving } = input;
  const dt = clamp(safeFinite(input.dt, 0), 0, 0.1);
  if (dt <= 0) return;

  const speed = safeFinite(input.speed, 0);
  const steer = clamp(safeFinite(input.steer, 0), -1.1, 1.1);
  const throttle = clamp(safeFinite(input.throttle, 0), -1, 1);
  const forwardAccel = clamp(safeFinite(input.forwardAccel, 0), -25, 25);

  const muSurf =
    input.surfaceGrip !== undefined && Number.isFinite(input.surfaceGrip)
      ? clamp(input.surfaceGrip, 0.25, 1.25)
      : computeTireSurfaceGrip(Boolean(input.wetRoad), Boolean(input.snowyRoad));
  const effectiveGrip = profile.baseGripG * muSurf;
  const safeMaxLean = Math.min(
    profile.maxLeanRad,
    profile.maxLeanRad * (0.58 + 0.42 * muSurf),
    Math.atan(Math.max(0.22, effectiveGrip)),
  );

  const prevSteer = state.initialized ? safeFinite(state.prevSteer ?? steer, steer) : steer;
  const steerRate = driving ? clamp((steer - prevSteer) / Math.max(dt, 1 / 120), -4.5, 4.5) : 0;
  state.prevSteer = steer;

  // Target inward corner lean: positive lean = right bank when turning right (steer < 0)
  let targetLean = 0;
  if (driving && speed > 0.25) {
    const rawLean = -Math.atan(
      (speed * speed * Math.tan(steer)) / (GRAVITY * Math.max(0.6, profile.wheelbase)),
    );
    targetLean = clamp(rawLean, -safeMaxLean, safeMaxLean);
  }

  // Target fork dive (+ nose dip on braking) / squat (- nose lift on acceleration)
  let targetFork = 0;
  if (driving) {
    if (forwardAccel < -0.35 || (input.brake && Math.abs(speed) > 0.3)) {
      const brakeRatio = clamp(-forwardAccel / Math.max(2, profile.braking), 0, 1);
      targetFork = brakeRatio * profile.forkDiveMaxRad;
    } else if (forwardAccel > 0.35 && throttle > 0.05) {
      const accelRatio = clamp(forwardAccel / Math.max(1.5, profile.acceleration), 0, 1);
      targetFork = -accelRatio * profile.squatMaxRad;
    }
  }

  // Smooth gyroscopic counter-steer precession & speed-stabilized roll damping
  const gyroGain = profile.powered ? 0.14 : 0.09;
  const gyroAccel =
    driving && speed > 0.8 ? clamp(-gyroGain * speed * steerRate * muSurf, -8, 8) : 0;

  // Second-order spring-damper integration (substepped at <= 1/120 s, capped at <= 6 steps)
  const substeps = Math.min(6, Math.max(1, Math.ceil(dt * 120)));
  const step = dt / substeps;
  const wL = profile.leanNaturalFreq * (0.76 + 0.24 * clamp(muSurf, 0.35, 1.0));
  const zL = clamp(
    profile.leanDampingRatio + 0.04 * clamp(Math.abs(speed) / Math.max(4, profile.maxSpeed), 0, 1),
    0.72,
    1.08,
  );
  const wF = profile.forkNaturalFreq;
  const zF = profile.forkDampingRatio;

  for (let i = 0; i < substeps; i++) {
    const gyroPulse = gyroAccel * Math.exp(-i * step * 18);
    const leanAccel = wL * wL * (targetLean - state.lean) + gyroPulse - 2 * zL * wL * state.leanVel;
    state.leanVel = clamp(state.leanVel + leanAccel * step, -6, 6);
    state.lean = clamp(state.lean + state.leanVel * step, -safeMaxLean * 1.15, safeMaxLean * 1.15);

    const forkAccel = wF * wF * (targetFork - state.forkDive) - 2 * zF * wF * state.forkVel;
    state.forkVel = clamp(state.forkVel + forkAccel * step, -4, 4);
    state.forkDive = clamp(
      state.forkDive + state.forkVel * step,
      -profile.squatMaxRad * 1.3,
      profile.forkDiveMaxRad * 1.3,
    );
  }

  // Snap microscopic residual motion at rest
  if (!driving && Math.abs(state.lean) < 1e-4 && Math.abs(state.leanVel) < 1e-4) {
    state.lean = 0;
    state.leanVel = 0;
  }
  if (!driving && Math.abs(state.forkDive) < 1e-4 && Math.abs(state.forkVel) < 1e-4) {
    state.forkDive = 0;
    state.forkVel = 0;
  }

  // Distance-proportional forward pedal cadence vs freewheel coasting separation
  if (!profile.powered) {
    const activelyPedaling = driving && throttle > 0.02 && speed > 0.03 && !input.brake;
    state.coasting = !activelyPedaling;
    if (activelyPedaling) {
      const safeWheelR = Math.max(0.18, profile.wheelRadius);
      const exactOmega = speed / (safeWheelR * BICYCLE_CRANK_GEAR_RATIO);
      const targetCadence = clamp(exactOmega, 0, 14);
      state.pedalCadence += (targetCadence - state.pedalCadence) * (1 - Math.exp(-12 * dt));
      const deltaCrank = (speed * dt) / (safeWheelR * BICYCLE_CRANK_GEAR_RATIO);
      state.crankAngle = (((state.crankAngle + deltaCrank) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    } else {
      state.pedalCadence *= Math.exp(-8 * dt);
      if (state.pedalCadence < 0.02) state.pedalCadence = 0;
    }
  } else {
    state.coasting = !driving || throttle <= 0.05;
    state.pedalCadence = 0;
  }

  state.initialized = true;
}

// ---------------------------------------------------------------------------
// Automotive Lighting & Horn State Machine
// ---------------------------------------------------------------------------

export function createVehicleLightState(hornKind: HornKind = 'car'): VehicleLightState {
  return {
    headlightsMode: 'auto',
    headlightsOn: false,
    taillightsOn: false,
    braking: false,
    reversing: false,
    blinker: 0,
    blinkerManual: false,
    blinkerPhase: 0,
    blinkerLit: false,
    hornTimer: 0,
    hornActive: false,
    hornPulseId: 0,
    lastHornAt: -999,
    hornKind,
    privatePrevHornHeld: false,
  };
}

export function toggleHeadlightsMode(lights: VehicleLightState): HeadlightMode {
  const order: readonly HeadlightMode[] = ['auto', 'on', 'off'];
  const idx = order.indexOf(lights.headlightsMode);
  const next = order[(idx + 1) % order.length];
  lights.headlightsMode = next;
  return next;
}

export function setManualBlinker(
  lights: VehicleLightState,
  direction: BlinkerDirection,
): BlinkerDirection {
  if (direction === 0 || (lights.blinkerManual && lights.blinker === direction)) {
    lights.blinker = 0;
    lights.blinkerManual = false;
    lights.blinkerPhase = 0;
    lights.blinkerLit = false;
    return 0;
  }
  lights.blinker = direction;
  lights.blinkerManual = true;
  lights.blinkerPhase = 0;
  lights.blinkerLit = true;
  return direction;
}

/**
 * Triggers a horn pulse (or bicycle bell chime) and stamps `lastHornAt`
 * for nearby NPC glance/yield reactions.
 */
export function triggerVehicleHorn(
  lights: VehicleLightState,
  nowSeconds: number,
  minDurationSec = 0.35,
): number {
  const safeNow = safeFinite(nowSeconds, 0);
  const duration = clamp(safeFinite(minDurationSec, 0.35), 0.1, 2.0);
  lights.hornTimer = Math.max(lights.hornTimer, duration);
  lights.hornActive = true;
  lights.hornPulseId += 1;
  lights.lastHornAt = safeNow;
  return lights.hornPulseId;
}

export interface VehicleLightStepInput {
  lights: VehicleLightState;
  dt: number;
  nowSeconds: number;
  driving: boolean;
  speed: number;
  throttle: number;
  sideInput: number;
  steer: number;
  brake: boolean;
  handbrake?: boolean;
  hornHeld?: boolean;
  env: EnvironmentLightConditions;
}

export function stepVehicleLights(input: VehicleLightStepInput): void {
  const { lights, driving, env } = input;
  const dt = clamp(safeFinite(input.dt, 0), 0, 0.25);
  const speed = safeFinite(input.speed, 0);
  const throttle = clamp(safeFinite(input.throttle, 0), -1, 1);
  const sideInput = clamp(safeFinite(input.sideInput, 0), -1, 1);
  const steer = safeFinite(input.steer, 0);
  const nowSeconds = safeFinite(input.nowSeconds, 0);

  // 1. Headlights & running taillights (Auto at Sunset / Night / Rain / Snow, or manual L toggle)
  const autoCondition =
    safeFinite(env.dayWeight, 1) < 0.52 ||
    safeFinite(env.rainWeight, 0) > 0.12 ||
    safeFinite(env.snowWeight ?? 0, 0) > 0.12 ||
    Boolean(env.sunsetOrNight);

  if (lights.headlightsMode === 'on') {
    lights.headlightsOn = true;
  } else if (lights.headlightsMode === 'off') {
    lights.headlightsOn = false;
  } else {
    lights.headlightsOn = autoCondition;
  }
  lights.taillightsOn = lights.headlightsOn;

  // 2. Brake lights & Reverse white lights
  const opposingBrake =
    (speed > 0.25 && throttle < -0.05) || (speed < -0.25 && throttle > 0.05);
  lights.braking =
    driving && Boolean(input.brake || input.handbrake || opposingBrake);
  lights.reversing =
    driving &&
    (speed < -0.08 ||
      (Math.abs(speed) <= 0.12 && throttle < -0.1 && !input.brake && !input.handbrake));

  // 3. Left / Right Blinker Signals
  if (!driving) {
    lights.blinker = 0;
    lights.blinkerManual = false;
    lights.blinkerPhase = 0;
    lights.blinkerLit = false;
  } else if (!lights.blinkerManual) {
    if (Math.abs(sideInput) > 0.35 && Math.abs(speed) < 12.5) {
      lights.blinker = sideInput < 0 ? -1 : 1;
    } else if (Math.abs(sideInput) < 0.12 && Math.abs(steer) < 0.08) {
      lights.blinker = 0;
    }
  }

  if (lights.blinker !== 0) {
    lights.blinkerPhase = (lights.blinkerPhase + dt * 1.8) % 1;
    lights.blinkerLit = lights.blinkerPhase < 0.5;
  } else {
    lights.blinkerPhase = 0;
    lights.blinkerLit = false;
  }

  // 4. Horn pulse & hold
  const hornHeld = Boolean(input.hornHeld && driving);
  if (hornHeld && !lights.privatePrevHornHeld) {
    triggerVehicleHorn(lights, nowSeconds, 0.35);
  } else if (hornHeld) {
    lights.hornTimer = Math.max(lights.hornTimer, 0.08);
    lights.hornActive = true;
  } else {
    lights.hornTimer = Math.max(0, lights.hornTimer - dt);
    lights.hornActive = lights.hornTimer > 0;
  }
  lights.privatePrevHornHeld = hornHeld;
}

/**
 * Evaluates whether a nearby pedestrian / resident should glance toward and step clear
 * of a honking vehicle. Returns world-space yield offset away from vehicle centerline.
 */
export function queryHornNpcReaction(
  vehiclePose: VehiclePose,
  npcPos: Point2D,
  nowSeconds: number,
  lastHornAt: number,
  maxAgeSec = 2.2,
  maxRangeM = 10,
): HornReactionQueryResult {
  const dx = npcPos.x - vehiclePose.x;
  const dz = npcPos.z - vehiclePose.z;
  const distance = Math.hypot(dx, dz);
  const age = nowSeconds - lastHornAt;
  const sin = Math.sin(vehiclePose.yaw);
  const cos = Math.cos(vehiclePose.yaw);

  // Project onto vehicle forward (+Z) and left (+X) axes
  const forwardProj = dx * sin + dz * cos;
  const leftProj = dx * cos - dz * sin;
  const lateralSide: -1 | 1 = leftProj >= 0 ? 1 : -1;

  const inWindow = age >= 0 && age <= maxAgeSec;
  const inCone = distance <= maxRangeM && forwardProj >= -2.5;
  if (!inWindow || !inCone) {
    return {
      alert: false,
      distance,
      lateralSide,
      yieldOffset: { x: 0, z: 0 },
    };
  }

  // Step 0.45 m away from vehicle centerline along vehicle lateral axis
  const stepOut = 0.45 * lateralSide;
  return {
    alert: true,
    distance,
    lateralSide,
    yieldOffset: {
      x: stepOut * cos,
      z: -stepOut * sin,
    },
  };
}
