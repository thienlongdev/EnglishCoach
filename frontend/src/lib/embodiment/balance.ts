import * as T from 'three';

/**
 * A body with weight. The skeleton is still posed by clips and inverse kinematics, but what those are asked to do now comes from a small model of
 * how a person stays up: the centre of mass as a linear inverted pendulum over the feet (Kajita), kept in check by moving the centre of pressure
 * under the soles, and by a step once the capture point (Pratt) has left what the feet can hold.
 *
 * It is a reduced model on purpose: a browser has one frame for everything, and a character that must always put its hand on a real handle cannot
 * be handed to a solver that may let it go. What it answers is the visible part: where the hips go, how the trunk leans against a load or a push,
 * when a foot has to move, and how a bump travels up the body. The numbers are the real ones: kilograms, newtons, metres, gravity.
 */
export const GRAVITY = 9.81;
/** Between the ankles and the hips: where the weight of a standing body sits, metres. */
const COM_HEIGHT = .92;
const W = Math.sqrt(GRAVITY / COM_HEIGHT);
/** How firmly the feet bring the capture point back. Above 1: quicker than falling. */
const RECOVER = .8;
/** What the hips add, m/s² per metre of capture point, and at most. */
const HIP = 4, HIP_MOST = 2.6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface Load {
  /** Body frame, from the middle of the feet: x right, z forward. Metres. */
  x: number; z: number;
  kg: number;
}
export interface BalanceInput {
  dt: number;
  /** Kilograms of the body itself. */
  mass: number;
  loads: Load[];
  /** A force on the hands, newtons, body frame, and how high it acts. A push forward is the furniture pushing back: fz < 0. */
  force?: { x: number; z: number; height: number } | null;
  /** How the root itself is accelerating, body frame, m/s². The body's weight lags behind it. */
  ax: number; az: number;
  /** The clip's legs are stepping: they take most of the correction themselves. */
  stepping: boolean;
  /** What the feet hold, from the middle of the feet. */
  support: { left: number; right: number; front: number; back: number };
  /** The middle of the feet relative to the root, body frame. */
  cx: number; cz: number;
}
export interface BalanceOutput {
  /** Where the hips go, metres, body frame. */
  hipX: number; hipZ: number;
  /** The trunk's lean against the load or into a push: forward +, right +. Radians. */
  pitch: number; roll: number;
  /** A little down at the knees while strained or caught off balance, metres. */
  sink: number;
  /** 0 steady, 1 about to fall: the arms go out, the face changes. */
  unstable: number;
  /** The capture point, from the middle of the feet, and how far it is past what they can hold: a step is needed when `over` > 0. */
  captureX: number; captureZ: number; over: number;
}

const STEPPING_SUPPORT = { left: .6, right: .6, back: .6, front: .6 } as const;
const _starOut = { x: 0, z: 0, bodyFraction: 1, offsetX: 0, offsetZ: 0 };

export class Balance {
  /** The centre of mass relative to the middle of the feet, body frame: x right, z forward. */
  x = 0; z = 0; vx = 0; vz = 0;
  /** What the chest and head do on their own, on top of the hips: they arrive late and overshoot a little. */
  private chestP = 0; private chestR = 0; private chestVP = 0; private chestVR = 0;
  private sinkNow = 0;
  /** Set for the rig: the chest's own lag behind the hips, radians. */
  lagPitch = 0; lagRoll = 0;
  readonly out: BalanceOutput = { hipX: 0, hipZ: 0, pitch: 0, roll: 0, sink: 0, unstable: 0, captureX: 0, captureZ: 0, over: 0 };

  /** Something hit the body or it caught itself: a change of velocity, m/s, body frame. */
  impulse(vx: number, vz: number) { this.vx += vx; this.vz += vz; }
  /** Where the weight goes when nothing moves: over the feet, counting what is carried and what the hands push on. */
  static target(i: Pick<BalanceInput, 'mass' | 'loads' | 'force' | 'support'>, out?: typeof _starOut) {
    let momentX = 0, momentZ = 0, total = i.mass;
    for (const l of i.loads) { momentX += l.kg * l.x; momentZ += l.kg * l.z; total += l.kg; }
    if (i.force) {
      momentX += i.force.x * i.force.height / GRAVITY;
      momentZ += i.force.z * i.force.height / GRAVITY;
    }
    const res = out ?? { x: 0, z: 0, bodyFraction: 1, offsetX: 0, offsetZ: 0 };
    res.x = clamp(-momentX / i.mass, -i.support.left * 1.6, i.support.right * 1.6);
    res.z = clamp(-momentZ / i.mass, -i.support.back - .12, i.support.front + .14);
    res.bodyFraction = i.mass / total;
    res.offsetX = momentX / total;
    res.offsetZ = momentZ / total;
    return res;
  }
  update(i: BalanceInput): BalanceOutput {
    // Walking, the stepping itself is the balance: the feet go wherever the weight goes, so the soles are never what limits it.
    const s = i.stepping ? STEPPING_SUPPORT : i.support;
    const star = Balance.target({ mass: i.mass, loads: i.loads, force: i.force, support: s }, _starOut);
    const steps = Math.max(1, Math.min(4, Math.ceil(i.dt * 120))), h = i.dt / steps;
    // The root's own acceleration: standing still there is hardly any, walking the trunk answers a part of it.
    const shove = i.stepping ? .14 : .1;
    // x/z describe the body alone. Pressure limits and recovery steps act
    // on body plus load. Express the support polygon in the body's coordinates
    // for integration, then report the combined capture point in foot space.
    const minX = (-s.left - star.offsetX) / star.bodyFraction, maxX = (s.right - star.offsetX) / star.bodyFraction;
    const minZ = (-s.back - star.offsetZ) / star.bodyFraction, maxZ = (s.front - star.offsetZ) / star.bodyFraction;
    for (let n = 0; n < steps; n++) {
      const cpx = this.x + this.vx / W, cpz = this.z + this.vz / W;
      // Where the pressure under the soles should be for the capture point to come back to where the weight belongs; no further than the soles go.
      const px = clamp(cpx + RECOVER * (cpx - star.x), minX, maxX), pz = clamp(cpz + RECOVER * (cpz - star.z), minZ, maxZ);
      // Past what the soles do, the hips and the trunk throw their own weight the other way (the hip strategy): strong, and short of a step only for so long.
      const hx = clamp(-HIP * (cpx - star.x), -HIP_MOST, HIP_MOST), hz = clamp(-HIP * (cpz - star.z), -HIP_MOST, HIP_MOST);
      this.vx += (W * W * (this.x - px) + hx - i.ax * shove) * h;
      this.vz += (W * W * (this.z - pz) + hz - i.az * shove) * h;
      this.x += this.vx * h; this.z += this.vz * h;
      // Nobody falls in this model: past this the stagger takes over, and it comes from the steps.
      const room = .34;
      if (Math.abs(this.x) > room) { this.x = Math.sign(this.x) * room; this.vx *= .4; }
      if (Math.abs(this.z) > room) { this.z = Math.sign(this.z) * room; this.vz *= .4; }
    }
    const cpx = (this.x + this.vx / W) * star.bodyFraction + star.offsetX;
    const cpz = (this.z + this.vz / W) * star.bodyFraction + star.offsetZ;
    const overX = cpx > 0 ? cpx - s.right : -cpx - s.left, overZ = cpz > 0 ? cpz - s.front : -cpz - s.back;
    const over = Math.max(0, overX, overZ);
    const out = this.out;
    out.captureX = cpx; out.captureZ = cpz; out.over = over;
    out.unstable = clamp(Math.max(overX, overZ) / .1 + .25, 0, 1) * (over > 0 ? 1 : T.MathUtils.smoothstep(Math.max(overX, overZ), -.05, 0));
    // A shift of the weight is mostly the hips going over the feet, and the rest the trunk.
    out.hipX = i.cx + this.x * .72; out.hipZ = i.cz + this.z * .62;
    const rest = (i.stepping ? .5 : 1);
    out.pitch = Math.atan2((this.z) * .95, .62) * rest;
    out.roll = Math.atan2((this.x) * .7, .62) * rest;
    // The chest and head are a spring on top of that.
    const ka = 60, kd = 10;
    const wantP = clamp(-i.az * .012 * shove + this.vz * .1, -.2, .2), wantR = clamp(-i.ax * .012 * shove + this.vx * .1, -.16, .16);
    this.chestVP += (ka * (wantP - this.chestP) - kd * this.chestVP) * i.dt; this.chestP += this.chestVP * i.dt;
    this.chestVR += (ka * (wantR - this.chestR) - kd * this.chestVR) * i.dt; this.chestR += this.chestVR * i.dt;
    this.lagPitch = this.chestP; this.lagRoll = this.chestR;
    const strain = clamp(Math.hypot(star.x, star.z) / .2, 0, 1) * .022 + out.unstable * .05;
    this.sinkNow += (strain - this.sinkNow) * (1 - Math.exp(-6 * i.dt));
    out.sink = this.sinkNow;
    return out;
  }
  reset() { this.x = this.z = this.vx = this.vz = 0; this.chestP = this.chestR = this.chestVP = this.chestVR = 0; this.sinkNow = 0; this.lagPitch = this.lagRoll = 0; }
}

/** How the feet should stand for what the body is doing, on top of how the clip has them. Metres, body frame. */
export interface Stance {
  /** This foot goes forward by `front`, the other back by `back`. +1 right, -1 left. */
  lead?: number;
  front?: number; back?: number;
  wide?: number;
}
export interface FootClip { at: T.Vector3; q: T.Quaternion }
interface Swing { fromX: number; fromZ: number; toX: number; toZ: number; fromQ: T.Quaternion; toQ: T.Quaternion; t: number; seconds: number; lift: number; recover: boolean }
export interface PlantedFoot {
  side: number;
  /** Where the ankle stands, world. */
  at: T.Vector3;
  q: T.Quaternion;
  swing: Swing | null;
  /** 0..1 through a step, for the hips. */
  phase: number;
}
export interface FeetFrame {
  dt: number;
  /** The clip's legs are stepping: the feet are the clip's. */
  stepping: boolean;
  rootAt: T.Vector3;
  rootQ: T.Quaternion;
  forward: T.Vector3;
  right: T.Vector3;
  stance: Stance | null;
  clip: FootClip[];
  k: number;
  /** A step is needed to get under this point, world. */
  catchAt: T.Vector3 | null;
  /** A foot came down: how hard. */
  land?: (side: number, hard: number) => void;
}

const up = new T.Vector3(0, 1, 0);
const q1 = new T.Quaternion(), q2 = new T.Quaternion(), v1 = new T.Vector3(), v2 = new T.Vector3();

/** Feet that stay where they were put. A standing body's foot does not slide: when the body has turned or moved too far from it, it steps. */
export class PlantedFeet {
  feet: PlantedFoot[] = [];
  /** 0: the clip has the feet. 1: they stand where they stand. */
  plant = 0;
  private started = false;
  private wait = 0;
  /** A steps' count, for tests. */
  steps = 0;
  /** The next step should come from this foot: they take turns when a body turns on the spot. */
  private last = 0;
  constructor(sides: number[]) { this.feet = sides.map(side => ({ side, at: new T.Vector3(), q: new T.Quaternion(), swing: null, phase: 0 })); }
  reset() { this.started = false; this.plant = 0; for (const f of this.feet) { f.swing = null; f.phase = 0; } }
  /** A foot in the air, and which: the hips go over the other. */
  get swinging() { return this.feet.find(f => f.swing) ?? null; }
  private desired(f: PlantedFoot, c: FootClip, frame: FeetFrame, out: T.Vector3) {
    const s = frame.stance, k = frame.k;
    out.copy(c.at);
    if (s) {
      const lead = s.lead ?? 0, along = lead ? (f.side === lead ? s.front ?? 0 : -(s.back ?? 0)) : 0;
      out.addScaledVector(frame.forward, along * k).addScaledVector(frame.right, f.side * (s.wide ?? 0) * k);
    }
    return out;
  }
  update(frame: FeetFrame) {
    const { dt, stepping, clip, k } = frame;
    const clampSeedFoot = (f: PlantedFoot, c: FootClip) => {
      f.at.copy(c.at);
      f.q.copy(c.q);
      // Guard against seeding world-space footprints from an un-relaxed cycle/jump/dismount pose (#38 T6):
      // clamp initial horizontal excursion <= 0.45 * k and vertical lift <= 0.22 * k above root.
      const dx = f.at.x - frame.rootAt.x;
      const dz = f.at.z - frame.rootAt.z;
      const hd = Math.hypot(dx, dz);
      const maxHd = 0.45 * k;
      if (hd > maxHd && hd > 1e-6) {
        f.at.x = frame.rootAt.x + (dx / hd) * maxHd;
        f.at.z = frame.rootAt.z + (dz / hd) * maxHd;
      }
      f.at.y = Math.min(f.at.y, frame.rootAt.y + 0.22 * k);
    };
    if (!this.started) {
      this.started = true;
      this.feet.forEach((f, i) => clampSeedFoot(f, clip[i]));
    }
    this.plant = clamp(this.plant + (stepping ? -dt / .14 : dt / .22), 0, 1);
    if (stepping) {
      // The clip has them: the planted places follow, so that when it stops they are where the clip left them.
      this.feet.forEach((f, i) => { f.swing = null; f.phase = 0; clampSeedFoot(f, clip[i]); });
      this.wait = .04;
      return;
    }
    this.wait = Math.max(0, this.wait - dt);
    // Nothing floats: whichever way the clip left a foot, its height is the clip's height at rest now.
    this.feet.forEach((f, i) => { if (!f.swing) f.at.y = clip[i].at.y; });
    const inAir = this.feet.find(f => f.swing);
    if (!inAir && this.wait <= 0) {
      let chosen: PlantedFoot | null = null, score = 0, to: T.Vector3 | null = null, recover = false;
      if (frame.catchAt) {
        // Off balance: the foot on that side goes out under the weight.
        const across = v1.copy(frame.catchAt).sub(frame.rootAt).dot(frame.right);
        chosen = this.feet.find(f => Math.sign(across || f.side) === f.side && this.last !== f.side) ?? this.feet.find(f => this.last !== f.side) ?? this.feet[0];
        to = v2.copy(frame.catchAt); recover = true;
      } else {
        this.feet.forEach((f, i) => {
          const d = this.desired(f, clip[i], frame, v1);
          const dist = Math.hypot(d.x - f.at.x, d.z - f.at.z);
          // The way the foot points against the way the clip would have it.
          const turned = q1.copy(f.q).invert().multiply(clip[i].q);
          const angle = 2 * Math.acos(Math.min(1, Math.abs(turned.w)));
          const need = Math.max(dist / (.08 * k), angle / .55) + (this.last === f.side ? -.15 : 0);
          if (need > 1 && need > score) { score = need; chosen = f; to = v2.copy(d); }
        });
      }
      if (chosen && to) {
        const f = chosen as PlantedFoot, c = clip[this.feet.indexOf(f)], dist = Math.hypot(to.x - f.at.x, to.z - f.at.z);
        f.swing = { fromX: f.at.x, fromZ: f.at.z, toX: to.x, toZ: to.z, fromQ: f.q.clone(), toQ: c.q.clone(), t: 0, seconds: recover ? clamp(.14 + dist * .55, .16, .32) : clamp(.2 + dist * .85, .24, .5), lift: clamp(.022 + dist * .16, .03, .085) * k, recover };
        this.last = f.side;
        this.steps++;
      }
    }
    for (let i = 0; i < this.feet.length; i++) {
      const f = this.feet[i], s = f.swing;
      if (!s) { f.phase = 0; continue; }
      // Where it is going can still change while it is in the air: it is going where the body now wants it.
      if (!s.recover) { const d = this.desired(f, clip[i], frame, v1); s.toX = d.x; s.toZ = d.z; }
      s.toQ.copy(clip[i].q);
      s.t = Math.min(1, s.t + dt / s.seconds);
      const e = s.t * s.t * s.t * (10 + s.t * (-15 + 6 * s.t));
      f.at.x = s.fromX + (s.toX - s.fromX) * e;
      f.at.z = s.fromZ + (s.toZ - s.fromZ) * e;
      f.at.y = clip[i].at.y + Math.sin(Math.PI * s.t) * s.lift;
      f.q.slerpQuaternions(s.fromQ, s.toQ, e);
      // Heel first off the floor, toes last; heel first back on it.
      // Each lobe reaches zero with zero velocity before reversing. A sign
      // switch on a nonzero sine caused a half-radian ankle snap at phase .55.
      const toePhase = s.t < .55 ? s.t / .55 : (s.t - .55) / .45;
      const toe = Math.sin(Math.PI * toePhase) ** 2 * .34 * (s.t < .55 ? 1 : -.55);
      q2.setFromAxisAngle(frame.right, toe);
      f.q.premultiply(q2);
      f.phase = s.t;
      if (s.t >= 1) {
        f.q.copy(s.toQ);
        f.at.y = clip[i].at.y;
        const hard = s.recover ? .9 : .35;
        f.swing = null; f.phase = 0;
        this.wait = s.recover ? 0 : .06;
        frame.land?.(f.side, hard);
      }
    }
  }
  /** The middle of the feet and what they hold, in the body's frame, relative to the root. */
  support(rootAt: T.Vector3, forward: T.Vector3, right: T.Vector3, k: number) {
    // A foot on its way to a better place is not being fallen on: only a step that catches the body stands on one foot for real.
    const inAir = this.swinging?.swing?.recover ? this.swinging : null;
    const nFeet = this.feet.length || 1;
    let sumX = 0, sumZ = 0;
    let left = Infinity, rightEdge = -Infinity, back = Infinity, front = -Infinity;
    for (let i = 0; i < this.feet.length; i++) {
      const f = this.feet[i];
      const dx = f.at.x - rootAt.x, dz = f.at.z - rootAt.z;
      const x = dx * right.x + dz * right.z;
      const z = dx * forward.x + dz * forward.z;
      sumX += x;
      sumZ += z;
      if (f === inAir) continue;
      left = Math.min(left, x - .045 * k); rightEdge = Math.max(rightEdge, x + .045 * k);
      back = Math.min(back, z - .055 * k); front = Math.max(front, z + .15 * k);
    }
    const cx = sumX / nFeet, cz = sumZ / nFeet;
    return { cx, cz, support: { left: Math.max(.03, cx - left), right: Math.max(.03, rightEdge - cx), back: Math.max(.03, cz - back), front: Math.max(.04, front - cz) } };
  }
}

/** The lower body's stance, from the root's own axes. */
export function rootAxes(rootQ: T.Quaternion, forward: T.Vector3, right: T.Vector3) {
  forward.set(0, 0, 1).applyQuaternion(rootQ).setY(0);
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1);
  forward.normalize();
  right.crossVectors(forward, up).normalize();
}
