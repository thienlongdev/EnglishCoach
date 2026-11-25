import type { ArenaBoatState, ArenaPlayer, ArenaPose, MotionPose } from '@/types/speakingArena';
import { ARENA_SWIM_SUPPORT_Y, arenaBoatStep, arenaFloor, arenaStep, arenaSupportY } from './arenaTerrain';

export const STEP = 1 / 60;
const GRAVITY = 12, TAKEOFF = 5;
const SLOPE_STEP_DOWN_BASE = 0.14;
const SLOPE_STEP_DOWN_SPEED_GAIN = 0.95;
const HANDOFF_REGROUND_TOL = 0.085;
const HANDOFF_MAX_SLEW_PER_STEP = 0.032;
const yawDelta = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

// Precomputed tangential deflection fan (14 deg .. 82 deg) for zero-GC gliding past cylindrical trunks/rocks.
const SLIDE_ANGLES = [0.244346, 0.488692, 0.733038, 0.977384, 1.22173, 1.43117] as const;
const SLIDE_COS = SLIDE_ANGLES.map(a => Math.cos(a));
const SLIDE_SIN = SLIDE_ANGLES.map(a => Math.sin(a));
const _slideOut = { x: 0, z: 0, sign: 0 as -1 | 0 | 1 };

function stepWithTangentialSlide(
  surface: ArenaSurface,
  x: number,
  z: number,
  dx: number,
  dz: number,
  stepFeet: number,
  preferredSign: -1 | 0 | 1,
): { x: number; z: number; sign: -1 | 0 | 1 } {
  const stepLen = Math.hypot(dx, dz);
  const direct = surface.step(x, z, x + dx, z + dz, stepFeet);
  if (stepLen <= 1e-6) {
    _slideOut.x = direct.x;
    _slideOut.z = direct.z;
    _slideOut.sign = 0;
    return _slideOut;
  }

  const directDx = direct.x - x;
  const directDz = direct.z - z;
  const directMoved = Math.hypot(directDx, directDz);
  // Unobstructed path: preserve bit-exact surface.step result with zero perturbation.
  if (directMoved >= stepLen * 0.985) {
    _slideOut.x = direct.x;
    _slideOut.z = direct.z;
    _slideOut.sign = 0;
    return _slideOut;
  }

  const invLen = 1 / stepLen;
  const ux = dx * invLen;
  const uz = dz * invLen;
  let bestX = direct.x;
  let bestZ = direct.z;
  let bestSign: -1 | 0 | 1 = 0;
  // Score combines forward progress along desired heading + smooth tangential glide around cylindrical bark.
  let bestScore = (directDx * ux + directDz * uz) + directMoved * 0.25;

  for (let i = 0; i < SLIDE_ANGLES.length; i++) {
    const c = SLIDE_COS[i];
    const s = SLIDE_SIN[i];
    const scale = Math.max(0.32, c);

    // Evaluate both +theta and -theta deflections, slightly favoring `preferredSign` on near-symmetric head-on hits
    // so the player never oscillates left/right between frames.
    for (let dirIdx = 0; dirIdx < 2; dirIdx++) {
      const sign: -1 | 1 = dirIdx === 0 ? (preferredSign === -1 ? -1 : 1) : (preferredSign === -1 ? 1 : -1);
      const rs = s * sign;
      const sx = (dx * c - dz * rs) * scale;
      const sz = (dx * rs + dz * c) * scale;
      const cand = surface.step(x, z, x + sx, z + sz, stepFeet);
      const mx = cand.x - x;
      const mz = cand.z - z;
      const moved = Math.hypot(mx, mz);
      if (moved <= 1e-5) continue;
      const fwdProj = mx * ux + mz * uz;
      if (fwdProj < -1e-4) continue;
      const hysteresisBonus = sign === preferredSign ? stepLen * 0.035 : 0;
      const score = fwdProj + moved * 0.28 + hysteresisBonus;
      if (score > bestScore + 1e-6) {
        bestScore = score;
        bestX = cand.x;
        bestZ = cand.z;
        bestSign = sign;
      }
    }
    // Early-out once a shallow deflection achieves clean tangential glide (>= 55% of desired step).
    if (bestSign !== 0 && Math.hypot(bestX - x, bestZ - z) >= stepLen * 0.55) {
      break;
    }
  }

  _slideOut.x = bestX;
  _slideOut.z = bestZ;
  _slideOut.sign = bestSign;
  return _slideOut;
}

export interface ArenaSurface {
  floor: (x: number, z: number) => number;
  step: (x: number, z: number, nextX: number, nextZ: number, y: number) => { x: number; z: number };
  boatStep?: (x: number, z: number, yaw: number, nextX: number, nextZ: number) => { x: number; z: number };
}

const tidegardenSurface: ArenaSurface = { floor: arenaSupportY, step: arenaStep, boatStep: arenaBoatStep };

/** Single-owner kinematic capsule on the swept Arena height field. */
export class ArenaMotor {
  y: number;
  previous: { x: number; y: number; z: number };
  vy = 0;
  grounded = true;
  private buffer = 0;
  private grace = .08;
  private slideSign: -1 | 0 | 1 = 0;
  jumped = false;
  constructor(public x: number, public z: number, y = arenaFloor(x, z), private surface: ArenaSurface = tidegardenSurface) {
    this.y = y;
    this.previous = { x, y: this.y, z };
  }
  requestJump() { this.buffer = .13; }
  step(vx: number, vz: number) {
    this.previous.x = this.x; this.previous.y = this.y; this.previous.z = this.z;
    const speed = Math.hypot(vx, vz);
    const wasGrounded = this.grounded;
    const groundAtStart = this.surface.floor(this.x, this.z);

    if (wasGrounded && this.vy <= 0 && this.y - groundAtStart <= SLOPE_STEP_DOWN_BASE) {
      this.grace = .08;
    }

    let jumpingNow = false;
    if (this.buffer > 0 && this.grace > 0) {
      this.vy = TAKEOFF;
      this.grounded = false;
      this.grace = 0;
      this.buffer = 0;
      this.jumped = true;
      jumpingNow = true;
    }
    this.buffer = Math.max(0, this.buffer - STEP);

    // Stationary grounded stance on any walkable slope: lock (x, z) bit-exact (zero downhill creep) and pin sole to ground (zero sink).
    if (speed <= 1e-6 && wasGrounded && !jumpingNow && this.vy <= 0 && this.y - groundAtStart <= SLOPE_STEP_DOWN_BASE) {
      this.slideSign = 0;
      this.y = groundAtStart;
      this.vy = 0;
      this.grounded = true;
      this.grace = .08;
      return;
    }

    if (speed > 1e-6) {
      const stepFeet = wasGrounded && !jumpingNow ? Math.max(this.y, groundAtStart) : this.y;
      const moved = stepWithTangentialSlide(
        this.surface,
        this.x,
        this.z,
        vx * STEP,
        vz * STEP,
        stepFeet,
        this.slideSign,
      );
      this.x = moved.x;
      this.z = moved.z;
      this.slideSign = moved.sign;
    } else {
      this.slideSign = 0;
    }

    const horizMoved = Math.hypot(this.x - this.previous.x, this.z - this.previous.z);
    const effectiveSpeed = Math.max(speed, horizMoved / STEP);
    const ground = this.surface.floor(this.x, this.z);
    const stepDownTol = effectiveSpeed * STEP * SLOPE_STEP_DOWN_SPEED_GAIN + SLOPE_STEP_DOWN_BASE;

    // Continuous grounded slope contact (10-32 deg mountain/coastal trails): follow both uphill rise and downhill drop
    // within `speed * dt * 0.95 + 0.14 m` with zero micro-airborne hopping, while still detaching cleanly off real ledges/tables.
    if (wasGrounded && !jumpingNow && this.vy <= 0 && this.y - ground <= stepDownTol) {
      this.y = ground;
      this.vy = 0;
      this.grounded = true;
      this.grace = .08;
      return;
    }

    // Seamless shoreline / swim-to-wade controller handoff (`motor.grounded === false && vy === 0` near floor):
    // smoothly slew any residual sub-centimetre / wave-meniscus offset without a freefall frame or > 4 cm snap.
    if (!wasGrounded && !jumpingNow && this.vy === 0 && Math.abs(this.y - ground) <= HANDOFF_REGROUND_TOL) {
      const delta = ground - this.y;
      if (Math.abs(delta) <= HANDOFF_MAX_SLEW_PER_STEP) {
        this.y = ground;
        this.grounded = true;
        this.grace = .08;
      } else {
        this.y += Math.sign(delta) * HANDOFF_MAX_SLEW_PER_STEP;
        this.grounded = false;
      }
      return;
    }

    this.grace = Math.max(0, this.grace - STEP);
    this.y += this.vy * STEP - .5 * GRAVITY * STEP * STEP;
    this.vy -= GRAVITY * STEP;
    if (this.y <= ground) {
      this.y = ground;
      this.vy = 0;
      this.grounded = true;
      this.grace = .08;
    } else {
      this.grounded = false;
    }
  }
}

/** Bounded per-member and per-boat histories. All clocks below are monotonic or explicit server milliseconds. */
export class ArenaMotion {
  constructor(private surface: ArenaSurface = tidegardenSurface) {}
  roomId = '';
  binding = 0;
  readonly history = new Map<string, MotionPose[]>();
  readonly sent = new Map<number, ArenaPose>();
  readonly boatHistory = new Map<string, ArenaBoatState[]>();
  readonly boatSent = new Map<number, ArenaPose>();
  private offset = 0;
  private clockReady = false;
  private renderTime = -Infinity;
  private lastRender = -Infinity;
  private lastArrival = 0;
  private lastServer = 0;
  jitter = 0;

  reset(roomId: string) {
    this.roomId = roomId;
    this.binding++;
    this.history.clear();
    this.sent.clear();
    this.boatHistory.clear();
    this.boatSent.clear();
    this.renderTime = this.lastRender = -Infinity;
    this.clockReady = false;
    this.lastServer = 0;
    this.jitter = 0;
  }

  worldSeconds(now: number) {
    return (this.clockReady ? now + this.offset : Date.now()) / 1000;
  }

  private advanceClock(now: number) {
    if (now !== this.lastRender && this.clockReady) {
      const target = now + this.offset - Math.min(300, 145 + this.jitter * 2);
      const dt = now - this.lastRender;
      this.renderTime = dt > 500 ? target : Math.max(this.renderTime, Math.min(this.renderTime + dt * 1.08, Math.max(this.renderTime + dt * .92, target)));
      this.lastRender = now;
    }
  }

  ingest(roomId: string, server: number, poses: (ArenaPlayer | MotionPose)[], now: number, boats?: ArenaBoatState[]) {
    if (roomId !== this.roomId) this.reset(roomId);
    if (server > this.lastServer) {
      if (this.lastServer) this.jitter += (Math.abs((now - this.lastArrival) - (server - this.lastServer)) - this.jitter) * .15;
      const observed = server - now;
      this.offset = this.clockReady ? Math.max(this.offset - 1, observed) : observed;
      this.clockReady = true;
      this.lastServer = server;
      this.lastArrival = now;
    }
    for (const pose of poses) {
      if (pose.sequence == null || !pose.sampledAt) continue;
      const q = this.history.get(pose.id) ?? [], previous = q.at(-1);
      if (previous && previous.sampledAt >= pose.sampledAt) continue;
      if (previous && (previous.boat !== pose.boat || previous.seat !== pose.seat)) q.length = 0;
      q.push({ ...pose, sequence: pose.sequence, sampledAt: pose.sampledAt, jumpAt: pose.jumpAt ?? 0, jumpFloor: pose.jumpFloor ?? 0 });
      if (q.length > 12) q.shift();
      this.history.set(pose.id, q);
    }
    if (boats) {
      for (const boat of boats) {
        if (boat.sequence == null || !boat.sampledAt) continue;
        const q = this.boatHistory.get(boat.id) ?? [], previous = q.at(-1);
        if (previous && (previous.sampledAt ?? 0) >= boat.sampledAt) continue;
        if (previous && (previous.rower !== boat.rower || (boat.sequence ?? 0) < 0)) q.length = 0;
        q.push({ ...boat });
        if (q.length > 12) q.shift();
        this.boatHistory.set(boat.id, q);
      }
    }
  }

  sample(id: string, now: number): { x: number; y: number; z: number; yaw: number; airborne: boolean; diveDepth?: number } | undefined {
    const q = this.history.get(id);
    if (!q?.length) return;
    this.advanceClock(now);
    const t = this.renderTime;
    let i = q.findIndex(p => p.sampledAt >= t);
    if (i < 0) i = q.length;
    const a = q[Math.max(0, i - 1)], b = q[Math.min(i, q.length - 1)];
    let x = a.x, z = a.z, yaw = a.yaw;
    if (b !== a) {
      const start = Math.max(a.sampledAt, b.sampledAt - 250);
      const alpha = Math.max(0, (t - start) / (b.sampledAt - start));
      x += (b.x - x) * alpha;
      z += (b.z - z) * alpha;
      yaw += yawDelta(yaw, b.yaw) * alpha;
    } else if (i === q.length && q.length > 1) {
      const prev = q[q.length - 2], dt = a.sampledAt - prev.sampledAt;
      if (dt > 0 && dt < 350) {
        const extra = Math.min(90, t - a.sampledAt) / dt;
        const step = this.surface.step(x, z, x + (x - prev.x) * extra, z + (z - prev.z) * extra, Math.max(a.supportY ?? 0, this.surface.floor(x, z)));
        x = step.x; z = step.z;
      }
    }
    const diveA = a.diveDepth ?? 0, diveB = b.diveDepth ?? 0;
    const diveDepth = b !== a ? diveA + (diveB - diveA) * Math.max(0, Math.min(1, (t - Math.max(a.sampledAt, b.sampledAt - 250)) / Math.max(1, b.sampledAt - Math.max(a.sampledAt, b.sampledAt - 250)))) : diveA;
    const jump = b.jumpAt <= t ? b : a;
    const age = (t - jump.jumpAt) / 1000, ground = this.surface.floor(x, z);
    const baseGround = diveDepth > 0.02 ? Math.max(arenaFloor(x, z) + 0.65, ARENA_SWIM_SUPPORT_Y - diveDepth) : ground;
    const y = jump.jumpAt && age >= 0 ? Math.max(baseGround, jump.jumpFloor + (jump.jumpSpeed ?? TAKEOFF) * age - .5 * GRAVITY * age * age) : baseGround;
    return { x, z, yaw, y, diveDepth, airborne: diveDepth <= 0.02 && y > ground + .01 };
  }

  sampleBoat(id: string, now: number) {
    const q = this.boatHistory.get(id);
    if (!q?.length) return;
    this.advanceClock(now);
    const t = this.renderTime;
    let i = q.findIndex(p => (p.sampledAt ?? 0) >= t);
    if (i < 0) i = q.length;
    const a = q[Math.max(0, i - 1)], b = q[Math.min(i, q.length - 1)];
    let x = a.x, z = a.z, yaw = a.yaw, rowPhase = a.rowPhase;
    if (b !== a && b.sampledAt && a.sampledAt) {
      const start = Math.max(a.sampledAt, b.sampledAt - 250);
      const alpha = Math.max(0, Math.min(1, (t - start) / Math.max(1, b.sampledAt - start)));
      x += (b.x - x) * alpha;
      z += (b.z - z) * alpha;
      yaw += yawDelta(yaw, b.yaw) * alpha;
      rowPhase += (b.rowPhase - rowPhase) * alpha;
    } else if (i === q.length && q.length > 1) {
      const prev = q[q.length - 2], dt = (a.sampledAt ?? 0) - (prev.sampledAt ?? 0);
      if (dt > 0 && dt < 350 && a.sampledAt) {
        const extra = Math.min(90, Math.max(0, t - a.sampledAt)) / dt;
        const step = (this.surface.boatStep ?? arenaBoatStep)(x, z, yaw, x + (x - prev.x) * extra, z + (z - prev.z) * extra);
        x = step.x; z = step.z;
        rowPhase += (a.rowPhase - prev.rowPhase) * extra;
      }
    }
    return { x, z, yaw, rowPhase };
  }
}
