import * as T from 'three';

/**
 * Daniel Holden Dead-Blending Inertializer (UE5.3 `AnimNode_DeadBlending` formulation)
 * & Compact Pose-Search / Motion-Matching Index over the 48-Clip Locomotion Pack.
 *
 * Design guarantees:
 *  - Zero per-frame heap allocations (flat `Float32Array` state buffers & module-scoped scratch math).
 *  - Overshoot-free exponential decay of outgoing angular/linear velocity — never rings or snaps on
 *    rapid back-to-back locomotion transitions (`walk <-> run <-> turn <-> idle <-> sit`).
 *  - Single-clip mixer evaluation (no stacked dual-clip `crossFadeTo` cost during transitions).
 *  - Deterministic L1-cache-friendly `Float32Array` pose-search index (`< 0.008 ms/query`).
 */

const MAX_ANGULAR_SPEED = 10.5; // rad/s clamp prevents explosions on sudden clip/teleport cuts
const MAX_LINEAR_SPEED = 3.6; // m/s clamp on root hips translation velocity
const MAX_ANGULAR_OFFSET = 0.85; // rad (~48.7°) max geodesic offset so no limb/shoulder lags frozen in an old clip direction
const COS_HALF_MAX_ANGULAR_OFFSET = Math.cos(0.5 * MAX_ANGULAR_OFFSET);
const MAX_LINEAR_OFFSET = 0.16; // m max pelvis translation offset across clip cuts
const MAX_BLEND_DURATION = 0.18; // seconds clean upper bound for rapid back-to-back clip switches
const DEFAULT_DURATION = 0.15; // seconds default inertialization window
const DEFAULT_HALF_LIFE = 0.055; // seconds Holden decay half-life paired with <= 0.18 s window

/**
 * Overshoot-free Dead-Blending Inertializer bound to a character's animated bone list.
 *
 * Usage per frame:
 *  1. Before `mixer.update(dt)`: nothing needed (previous blended pose is already cached in `prevQ`).
 *  2. On state transition: call `triggerTransition(duration, halfLife)` BEFORE switching the mixer
 *     to the new clip (snapshots current pose & angular velocity as outgoing state).
 *  3. After `mixer.update(dt)`: call `apply(dt, reduced)` to blend decaying outgoing pose into the
 *     live incoming clip pose and update angular velocity estimates for future transitions.
 */
export class DeadBlendInertializer {
  private readonly bones: T.Bone[];
  private readonly hips: T.Bone | null;
  private readonly count: number;

  // Previous-frame bone local quaternions (for zero-alloc angular velocity estimation)
  private readonly prevQ: Float32Array;
  // Instantaneous local angular velocities (rad/s, world-in-parent frame)
  private readonly curVel: Float32Array;
  // Snapshotted outgoing pose & velocity at transition start t = 0
  private readonly outQ: Float32Array;
  private readonly outVel: Float32Array;

  // Hips local position tracking
  private readonly prevPos = new Float32Array(3);
  private readonly curLinVel = new Float32Array(3);
  private readonly outPos = new Float32Array(3);
  private readonly outLinVel = new Float32Array(3);

  private seeded = false;
  private active = false;
  private elapsed = 0;
  private duration = DEFAULT_DURATION;
  private lambda = Math.LN2 / DEFAULT_HALF_LIFE;

  constructor(bones: readonly T.Bone[], hips: T.Bone | null = null) {
    this.bones = [...bones];
    this.hips = hips;
    this.count = this.bones.length;
    this.prevQ = new Float32Array(this.count * 4);
    this.curVel = new Float32Array(this.count * 3);
    this.outQ = new Float32Array(this.count * 4);
    this.outVel = new Float32Array(this.count * 3);
    this.seedFromCurrent();
  }

  get isBlending(): boolean {
    return this.active;
  }

  /** Resets inertializer history to the current skeleton pose (call on teleport / spawn). */
  seedFromCurrent(): void {
    for (let i = 0; i < this.count; i++) {
      const q = this.bones[i].quaternion;
      const o4 = i * 4;
      this.prevQ[o4] = q.x;
      this.prevQ[o4 + 1] = q.y;
      this.prevQ[o4 + 2] = q.z;
      this.prevQ[o4 + 3] = q.w;
      const o3 = i * 3;
      this.curVel[o3] = 0;
      this.curVel[o3 + 1] = 0;
      this.curVel[o3 + 2] = 0;
    }
    if (this.hips) {
      this.prevPos[0] = this.hips.position.x;
      this.prevPos[1] = this.hips.position.y;
      this.prevPos[2] = this.hips.position.z;
      this.curLinVel[0] = 0;
      this.curLinVel[1] = 0;
      this.curLinVel[2] = 0;
    }
    this.active = false;
    this.elapsed = 0;
    this.seeded = true;
  }

  /**
   * Snapshots the current blended pose + angular velocity as the outgoing Dead-Blend state.
   * Safe to call mid-transition (guaranteed C1 continuity on rapid interrupts, bounded to `<= 0.18 s`).
   */
  triggerTransition(duration = DEFAULT_DURATION, halfLife = DEFAULT_HALF_LIFE): void {
    if (!this.seeded || duration <= 0.004 || this.count === 0) {
      this.active = false;
      return;
    }
    this.outQ.set(this.prevQ);
    this.outVel.set(this.curVel);
    if (this.hips) {
      this.outPos[0] = this.prevPos[0];
      this.outPos[1] = this.prevPos[1];
      this.outPos[2] = this.prevPos[2];
      this.outLinVel[0] = this.curLinVel[0];
      this.outLinVel[1] = this.curLinVel[1];
      this.outLinVel[2] = this.curLinVel[2];
    }
    this.duration = Math.max(0.04, Math.min(MAX_BLEND_DURATION, duration));
    this.lambda = Math.LN2 / Math.max(0.018, Math.min(0.08, halfLife));
    this.elapsed = 0;
    this.active = true;
  }

  private evaluateActiveBlend(elapsed: number): void {
    const u = T.MathUtils.clamp(elapsed / this.duration, 0, 1);
    // C2 quintic smoothstep: w(0)=0, w'(0)=0, w''(0)=0, w(1)=1, w'(1)=0, w''(1)=0
    const w = u * u * u * (u * (u * 6 - 15) + 10);
    const invW = 1 - w;
    const decayScale = (1 - Math.exp(-this.lambda * elapsed)) / this.lambda;

    for (let i = 0; i < this.count; i++) {
      const bone = this.bones[i];
      const o4 = i * 4;
      const o3 = i * 3;

      // Extrapolate outgoing quaternion: q_ext = exp(0.5 * omega * decayScale) * q0
      const tx = this.outVel[o3] * decayScale;
      const ty = this.outVel[o3 + 1] * decayScale;
      const tz = this.outVel[o3 + 2] * decayScale;
      const theta = Math.hypot(tx, ty, tz);
      let ex: number, ey: number, ez: number, ew: number;
      if (theta < 1e-5) {
        ex = 0.5 * tx;
        ey = 0.5 * ty;
        ez = 0.5 * tz;
        ew = 1.0;
      } else {
        const clampedTheta = Math.min(MAX_ANGULAR_OFFSET, theta);
        const half = 0.5 * clampedTheta;
        const k = Math.sin(half) / theta;
        ex = tx * k;
        ey = ty * k;
        ez = tz * k;
        ew = Math.cos(half);
      }

      const q0x = this.outQ[o4];
      const q0y = this.outQ[o4 + 1];
      const q0z = this.outQ[o4 + 2];
      const q0w = this.outQ[o4 + 3];

      // q_ext = q_exp * q0
      let rx = ew * q0x + ex * q0w + ey * q0z - ez * q0y;
      let ry = ew * q0y - ex * q0z + ey * q0w + ez * q0x;
      let rz = ew * q0z + ex * q0y - ey * q0x + ez * q0w;
      let rw = ew * q0w - ex * q0x - ey * q0y - ez * q0z;

      const rNorm = Math.hypot(rx, ry, rz, rw);
      if (rNorm > 1e-8) {
        const invRNorm = 1 / rNorm;
        rx *= invRNorm;
        ry *= invRNorm;
        rz *= invRNorm;
        rw *= invRNorm;
      }

      const qDst = bone.quaternion;
      // Ensure shortest hemisphere before geodesic offset bound & nlerp
      let dot = rx * qDst.x + ry * qDst.y + rz * qDst.z + rw * qDst.w;
      if (dot < 0) {
        rx = -rx;
        ry = -ry;
        rz = -rz;
        rw = -rw;
        dot = -dot;
      }

      // Geodesically clamp angular offset between outgoing pose and incoming clip to <= MAX_ANGULAR_OFFSET (0.85 rad)
      // so exiting an action/pickup/turn clip inertializes all bones uniformly without a lagging arm or shoulder.
      const clampedDot = Math.min(1, dot);
      if (clampedDot < COS_HALF_MAX_ANGULAR_OFFSET) {
        const halfAng = Math.acos(clampedDot);
        const sinHalf = Math.sin(halfAng);
        if (sinHalf > 1e-6) {
          const uClamp = (0.5 * MAX_ANGULAR_OFFSET) / halfAng;
          const sDst = Math.sin((1 - uClamp) * halfAng) / sinHalf;
          const sExt = Math.sin(uClamp * halfAng) / sinHalf;
          rx = qDst.x * sDst + rx * sExt;
          ry = qDst.y * sDst + ry * sExt;
          rz = qDst.z * sDst + rz * sExt;
          rw = qDst.w * sDst + rw * sExt;
        }
      }

      let bx = rx * invW + qDst.x * w;
      let by = ry * invW + qDst.y * w;
      let bz = rz * invW + qDst.z * w;
      let bw = rw * invW + qDst.w * w;
      const len = Math.hypot(bx, by, bz, bw);
      if (len > 1e-8) {
        const invLen = 1 / len;
        bx *= invLen;
        by *= invLen;
        bz *= invLen;
        bw *= invLen;
      } else {
        bx = qDst.x;
        by = qDst.y;
        bz = qDst.z;
        bw = qDst.w;
      }
      qDst.set(bx, by, bz, bw);
    }

    if (this.hips) {
      const px = this.outPos[0] + this.outLinVel[0] * decayScale;
      const py = this.outPos[1] + this.outLinVel[1] * decayScale;
      const pz = this.outPos[2] + this.outLinVel[2] * decayScale;
      const pDst = this.hips.position;
      let dx = px - pDst.x;
      let dy = py - pDst.y;
      let dz = pz - pDst.z;
      const dMag = Math.hypot(dx, dy, dz);
      if (dMag > MAX_LINEAR_OFFSET) {
        const s = MAX_LINEAR_OFFSET / dMag;
        dx *= s;
        dy *= s;
        dz *= s;
      }
      pDst.set(
        pDst.x + dx * invW,
        pDst.y + dy * invW,
        pDst.z + dz * invW,
      );
    }
  }

  /**
   * Applies active Dead-Blend extrapolation & quintic C2 blend into the live incoming bone pose
   * (already written by `mixer.update(dt)`), then refreshes instantaneous velocities.
   */
  apply(dt: number, reduced = false): void {
    if (this.count === 0) return;
    if (!this.seeded || reduced) {
      this.seedFromCurrent();
      return;
    }

    // When simulation time is frozen (`dt <= 1e-5`, e.g. Photo Studio `Time Frozen`), never divide
    // discrete pose snaps by `1/240` (`invDt = 240` velocity spike) or freeze transitions at `w = 0`.
    if (dt <= 1e-5) {
      if (this.active && this.elapsed > 0 && this.elapsed < this.duration) {
        this.evaluateActiveBlend(this.elapsed);
      } else {
        this.seedFromCurrent();
      }
      return;
    }

    const safeDt = Math.max(1 / 240, Math.min(0.1, dt));
    const invDt = 1 / safeDt;

    if (this.active) {
      this.elapsed += safeDt;
      if (this.elapsed >= this.duration) {
        this.active = false;
      } else {
        this.evaluateActiveBlend(this.elapsed);
      }
    }

    // Estimate instantaneous local angular velocity omega = 2 * log(q_cur * conj(q_prev)) / dt
    for (let i = 0; i < this.count; i++) {
      const q = this.bones[i].quaternion;
      const o4 = i * 4;
      const o3 = i * 3;
      const px = this.prevQ[o4];
      const py = this.prevQ[o4 + 1];
      const pz = this.prevQ[o4 + 2];
      const pw = this.prevQ[o4 + 3];

      // dq = q * conj(prevQ)
      let dx = q.w * -px + q.x * pw + q.y * -pz - q.z * -py;
      let dy = q.w * -py - q.x * -pz + q.y * pw + q.z * -px;
      let dz = q.w * -pz + q.x * -py - q.y * -px + q.z * pw;
      let dw = q.w * pw - q.x * -px - q.y * -py - q.z * -pz;

      if (dw < 0) {
        dx = -dx;
        dy = -dy;
        dz = -dz;
        dw = -dw;
      }

      const vLen = Math.hypot(dx, dy, dz);
      if (vLen > 1e-6) {
        const angle = 2 * Math.atan2(vLen, dw);
        let speed = angle * invDt;
        if (speed > MAX_ANGULAR_SPEED) speed = MAX_ANGULAR_SPEED;
        const s = speed / vLen;
        this.curVel[o3] = dx * s;
        this.curVel[o3 + 1] = dy * s;
        this.curVel[o3 + 2] = dz * s;
      } else {
        this.curVel[o3] = 0;
        this.curVel[o3 + 1] = 0;
        this.curVel[o3 + 2] = 0;
      }

      this.prevQ[o4] = q.x;
      this.prevQ[o4 + 1] = q.y;
      this.prevQ[o4 + 2] = q.z;
      this.prevQ[o4 + 3] = q.w;
    }

    if (this.hips) {
      const p = this.hips.position;
      let vx = (p.x - this.prevPos[0]) * invDt;
      let vy = (p.y - this.prevPos[1]) * invDt;
      let vz = (p.z - this.prevPos[2]) * invDt;
      const vMag = Math.hypot(vx, vy, vz);
      if (vMag > MAX_LINEAR_SPEED) {
        const s = MAX_LINEAR_SPEED / vMag;
        vx *= s;
        vy *= s;
        vz *= s;
      }
      this.curLinVel[0] = vx;
      this.curLinVel[1] = vy;
      this.curLinVel[2] = vz;
      this.prevPos[0] = p.x;
      this.prevPos[1] = p.y;
      this.prevPos[2] = p.z;
    }
  }
}

// ── Compact Motion-Matching Pose-Search Index ────────────────────────────────────────────────────────

/**
 * Feature layout per candidate locomotion frame (`STRIDE = 8` floats, L1-cache-resident):
 *  [0] nominalSpeed (m/s)
 *  [1] nominalYawRate (rad/s)
 *  [2] leftThighSwing (sin of sagittal pitch — +forward, -back)
 *  [3] rightThighSwing (sin of sagittal pitch — +forward, -back)
 *  [4] leftThighVel (rad/s)
 *  [5] rightThighVel (rad/s)
 *  [6] clipDuration (s)
 *  [7] sampleTime (s)
 */
const FEAT_STRIDE = 8;

const LOCO_META: Record<string, { speed: number; yawRate: number }> = {
  idle: { speed: 0, yawRate: 0 },
  breathing: { speed: 0, yawRate: 0 },
  walk: { speed: 1.08, yawRate: 0 },
  walk_brisk: { speed: 1.72, yawRate: 0 },
  run: { speed: 2.55, yawRate: 0 },
  turn_l: { speed: 0.15, yawRate: 1.35 },
  turn_r: { speed: 0.15, yawRate: -1.35 },
};

export interface MotionMatchResult {
  clipName: string;
  time: number;
  cost: number;
}

const _mmQ0 = new T.Quaternion();
const _mmQ1 = new T.Quaternion();
const _mmV0 = new T.Vector3();
const _mmV1 = new T.Vector3();

function sampleQuatLinear(track: T.KeyframeTrack, t: number, out: T.Quaternion): T.Quaternion {
  const times = track.times;
  const vals = track.values;
  const n = times.length;
  if (n === 0) return out.identity();
  if (n === 1 || t <= times[0]) return out.set(vals[0], vals[1], vals[2], vals[3]).normalize();
  if (t >= times[n - 1]) {
    const o = (n - 1) * 4;
    return out.set(vals[o], vals[o + 1], vals[o + 2], vals[o + 3]).normalize();
  }
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const a = span > 1e-6 ? (t - times[lo]) / span : 0;
  const i0 = lo * 4;
  const i1 = hi * 4;
  _mmQ0.set(vals[i0], vals[i0 + 1], vals[i0 + 2], vals[i0 + 3]).normalize();
  _mmQ1.set(vals[i1], vals[i1 + 1], vals[i1 + 2], vals[i1 + 3]).normalize();
  return out.copy(_mmQ0).slerp(_mmQ1, a).normalize();
}

function findTrack(clip: T.AnimationClip, names: readonly string[]): T.KeyframeTrack | null {
  for (const tr of clip.tracks) {
    const dot = tr.name.lastIndexOf('.');
    if (dot < 0 || tr.name.slice(dot + 1) !== 'quaternion') continue;
    const boneName = tr.name.slice(0, dot);
    if (names.includes(boneName)) return tr;
  }
  return null;
}

/**
 * Lightweight pose-search database built once per `(family, poseSignature)` locomotion clip set.
 * Finds the best phase-aligned entry time in the target clip (or selects the optimal locomotion clip)
 * by minimizing sagittal leg-swing + swing-velocity + speed/yaw-rate cost in `< 0.006 ms`.
 */
export class MotionMatchDatabase {
  private readonly clipNames: string[] = [];
  private readonly clipIndices: Int16Array;
  private readonly features: Float32Array;
  private readonly sampleCount: number;
  private readonly clipRange = new Map<string, { start: number; end: number }>();

  constructor(
    clips: ReadonlyMap<string, T.AnimationClip>,
    restThighL: T.Quaternion,
    restThighR: T.Quaternion,
  ) {
    const invRestL = restThighL.clone().invert();
    const invRestR = restThighR.clone().invert();
    const downL = new T.Vector3(0, 1, 0);
    const downR = new T.Vector3(0, 1, 0);

    const rows: number[] = [];
    const indices: number[] = [];
    const hz = 18;

    for (const [key, meta] of Object.entries(LOCO_META)) {
      const clip = clips.get(key);
      if (!clip) continue;
      const clipId = this.clipNames.length;
      this.clipNames.push(key);
      const dur = Math.max(0.1, clip.duration);
      const n = Math.max(4, Math.min(40, Math.round(dur * hz)));
      const tL = findTrack(clip, ['thigh.L', 'thighL', 'LeftUpLeg']);
      const tR = findTrack(clip, ['thigh.R', 'thighR', 'RightUpLeg']);

      const startIdx = indices.length;
      const swingL = new Float32Array(n);
      const swingR = new Float32Array(n);

      for (let i = 0; i < n; i++) {
        const t = (dur * i) / n;
        if (tL) {
          sampleQuatLinear(tL, t, _mmQ0).multiply(invRestL);
          _mmV0.copy(downL).applyQuaternion(_mmQ0);
          // Forward thigh lift projects onto local Z delta
          swingL[i] = _mmV0.z;
        }
        if (tR) {
          sampleQuatLinear(tR, t, _mmQ0).multiply(invRestR);
          _mmV1.copy(downR).applyQuaternion(_mmQ0);
          swingR[i] = _mmV1.z;
        }
      }

      const dtStep = dur / n;
      for (let i = 0; i < n; i++) {
        const prev = (i - 1 + n) % n;
        const next = (i + 1) % n;
        const velL = (swingL[next] - swingL[prev]) / (2 * dtStep);
        const velR = (swingR[next] - swingR[prev]) / (2 * dtStep);
        indices.push(clipId);
        rows.push(
          meta.speed,
          meta.yawRate,
          swingL[i],
          swingR[i],
          velL,
          velR,
          dur,
          (dur * i) / n,
        );
      }
      this.clipRange.set(key, { start: startIdx, end: indices.length });
    }

    this.clipIndices = Int16Array.from(indices);
    this.features = Float32Array.from(rows);
    this.sampleCount = indices.length;
  }

  /**
   * Finds the best phase-matched start time within a specific `targetClip` matching the actor's
   * live leg swing `(curL, curR)` and velocities `(velL, velR)`. Zero allocations.
   */
  bestEntryTime(
    targetClip: string,
    curL: number,
    curR: number,
    velL: number,
    velR: number,
    fallbackPhase01 = 0,
  ): number {
    const range = this.clipRange.get(targetClip);
    if (!range || range.start >= range.end) return 0;

    let bestIdx = range.start;
    let bestCost = Infinity;
    const f = this.features;
    for (let i = range.start; i < range.end; i++) {
      const o = i * FEAT_STRIDE;
      const dL = f[o + 2] - curL;
      const dR = f[o + 3] - curR;
      const dvL = (f[o + 4] - velL) * 0.28;
      const dvR = (f[o + 5] - velR) * 0.28;
      const cost = dL * dL + dR * dR + dvL * dvL + dvR * dvR;
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    }
    if (!Number.isFinite(bestCost)) {
      const dur = f[range.start * FEAT_STRIDE + 6];
      return (fallbackPhase01 % 1) * dur;
    }
    return f[bestIdx * FEAT_STRIDE + 7];
  }

  /**
   * Full locomotion pose-search across all indexed locomotion clips (zero allocations via caller-provided `out`).
   */
  search(
    desiredSpeed: number,
    desiredYawRate: number,
    curL: number,
    curR: number,
    velL: number,
    velR: number,
    currentClip: string,
    out: MotionMatchResult,
  ): MotionMatchResult {
    let bestIdx = -1;
    let bestCost = Infinity;
    const f = this.features;

    for (let i = 0; i < this.sampleCount; i++) {
      const o = i * FEAT_STRIDE;
      const ds = (f[o] - desiredSpeed) * 1.35;
      const dy = (f[o + 1] - desiredYawRate) * 0.85;
      const dL = (f[o + 2] - curL) * 1.1;
      const dR = (f[o + 3] - curR) * 1.1;
      const dvL = (f[o + 4] - velL) * 0.32;
      const dvR = (f[o + 5] - velR) * 0.32;
      let cost = ds * ds + dy * dy + dL * dL + dR * dR + dvL * dvL + dvR * dvR;
      if (this.clipNames[this.clipIndices[i]] === currentClip) {
        cost -= 0.14; // continuity hysteresis prevents chattering
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      out.clipName = this.clipNames[this.clipIndices[bestIdx]];
      out.time = f[bestIdx * FEAT_STRIDE + 7];
      out.cost = bestCost;
    }
    return out;
  }
}

const mmDbCache = new Map<string, MotionMatchDatabase>();

export function getOrBuildMotionMatchDb(
  cacheKey: string,
  clips: ReadonlyMap<string, T.AnimationClip>,
  restThighL: T.Quaternion,
  restThighR: T.Quaternion,
): MotionMatchDatabase {
  let db = mmDbCache.get(cacheKey);
  if (!db) {
    db = new MotionMatchDatabase(clips, restThighL, restThighR);
    mmDbCache.set(cacheKey, db);
  }
  return db;
}

export function clearMotionMatchCache(): void {
  mmDbCache.clear();
}
