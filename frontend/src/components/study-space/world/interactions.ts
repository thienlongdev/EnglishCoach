import type * as T from 'three';
import type { HandContact, HumanRig } from '@/lib/embodiment/human';

/**
 * One way of touching anything in the room: go there, reach, take hold, do the thing, let go, come back. A door, a drawer, a
 * lamp and a book differ only in what they ask of this. The hand arrives on the object's own real point and the object moves
 * under the hand; nothing is teleported and nothing plays without a body to play it.
 *
 * A hand that keeps hold of something stays with it while the other hand and the legs do other things: carrying a mug does not stop
 * the free hand from opening a door. A body with two things in its hands has no hand left, and says so.
 */
export interface Sequence {
  /** +1 right, -1 left. */
  side?: number;
  /** Stage-space point to walk up to first, and how close the body has to be. Skipped when already there. */
  approach?: { point: T.Vector3; stop: number };
  /** Read every frame while the hand is on the thing. */
  contact: () => HandContact | null;
  /** The other hand on the same thing: a book held open, a plush in both arms, a chair pulled with both hands. */
  second?: () => HandContact | null;
  reach?: number;
  /** Snappy <= 0.12 s express acquisition for in-range handheld tools. */
  express?: boolean;
  /** A completed reach animation is not evidence of touch. False waits for the
   * body, null refuses the action without transferring ownership. */
  ready?: () => boolean | null;
  reachTimeout?: number;
  /** After a missed grasp, take one measured step to a feasible stance and reach again. */
  reposition?: () => ((dt: number) => boolean | null) | null;
  onUnreachable?: () => void;
  onContact?: () => void;
  /** The action itself, 0..1, with the hand still on. */
  operate?: number;
  onOperate?: (k: number) => void;
  /** Ends the operation when true, however long that takes: the hand stays on while a drawer or a door really moves. */
  until?: () => boolean;
  onOperated?: () => void;
  /** Stays on the thing until `letGo()`: carrying. */
  keep?: boolean;
  release?: number;
  onDone?: () => void;
  onCancel?: () => void;
}

type Phase = 'approach' | 'reposition' | 'reach' | 'operate' | 'release';
interface Kept { seq: Sequence; proxy: HandContact; second: HandContact | null }

// The rig keeps the same proxy for blending. Every optional control belongs
// to the current provider, including the world-space elbow pole of a roll.
const defaults = {
  pole: undefined, limit: undefined, shape: undefined, on: undefined, onAt: undefined,
  bodyGoal: undefined, bodyFingers: undefined, bend: undefined, kg: undefined,
  wrap: undefined, wristPivot: undefined, handleJoints: undefined, secured: undefined,
};
const copy = (to: HandContact, c: HandContact) => { Object.assign(to, defaults, c); };
const clone = (c: HandContact): HandContact => ({ ...defaults, ...c });

export const EXPRESS_REACH_SEC = .12;
export const EXPRESS_RELEASE_SEC = .18;

export class Interactions {
  private seq: Sequence | null = null;
  private phase: Phase = 'reach';
  private t = 0;
  private proxy: HandContact | null = null;
  private proxy2: HandContact | null = null;
  private kept = new Map<number, Kept>();
  /** The last steps, with the arm already on its way: the feet finish while the hand reaches. */
  private walkOn: { point: T.Vector3; stop: number } | null = null;
  private reposition: ((dt: number) => boolean | null) | null = null;
  private expressActive = false;
  private turnMid: T.Vector3 | null = null;
  private wristProbe: T.Vector3 | null = null;

  constructor(private host: {
    rig: () => HumanRig | null;
    /** Moves the body one frame towards a stage point. True when it has arrived, null when it cannot get there. */
    walkToward: (point: T.Vector3, stop: number, dt: number) => boolean | null;
    /** The body turns to what its hand is going to. */
    turnTo: (world: T.Vector3, dt: number) => void;
    reduced: () => boolean;
    /** How far the body still is from a stage point, along the floor. */
    distanceTo: (point: T.Vector3) => number;
  }) {}

  /** The body is on its way to something, or its hand is at work: not while it is merely carrying. */
  get busy() { return !!this.seq; }
  /** The legs belong to this sequence. A hand that is only reaching leaves them to the player. */
  get walking() { return !!this.seq && (this.phase === 'approach' || this.phase === 'reposition' || !!this.walkOn); }
  /** What the eyes should be on: a person looks at what their hand is about to do. World space. */
  attention(out: T.Vector3): T.Vector3 | null {
    if (!this.seq || this.phase === 'release') return null;
    const c = this.seq.contact();
    return c ? out.copy(c.wrist).addScaledVector(c.fingers, .06) : null;
  }
  get holding() { return this.kept.size > 0; }
  holdingOn(side: number) {
    if (this.kept.has(side)) return true;
    return Boolean(this.seq && this.seq.keep && (this.seq.side ?? 1) === side && this.phase === 'operate');
  }
  get current() { return this.seq; }

  /** True when acquiring an in-range handheld shaft/tool on a live anatomical rig or explicit `seq.express`. */
  private isExpressSequence(seq: Sequence, sample?: HandContact | null): boolean {
    if (seq.express) return true;
    if (!seq.keep) return false;
    const rig = this.host.rig();
    if (!rig || typeof rig.armReach !== 'function') return false;
    const c = sample ?? seq.contact();
    return Boolean(c && c.grip === 'handle' && c.wrap);
  }

  /** Effective reach ramp duration: 0.12 s for express/in-range tools, preserving authored timing elsewhere. */
  private reachSeconds(seq: Sequence): number {
    if (this.host.reduced()) return .01;
    if (this.expressActive || seq.express) return Math.min(seq.reach ?? EXPRESS_REACH_SEC, EXPRESS_REACH_SEC);
    return seq.reach ?? .52;
  }

  /**
   * True when the requested wrist(s) are already inside the live character's anatomical
   * shoulder-to-wrist envelope (avoiding redundant approach walks and 1.2 s reposition stalls).
   */
  private withinAnatomicalEnvelope(seq: Sequence, checkSolvedWrist: boolean): boolean {
    const rig = this.host.rig();
    if (!rig || typeof rig.armReach !== 'function') return false;
    const side = seq.side ?? 1;
    const c = seq.contact();
    if (!c) return false;
    const arm = rig.armReach(side);
    if (!arm) return false;
    const scale = Math.max(.5, arm.length / .464);
    if (arm.shoulder.distanceTo(c.wrist) > arm.length * 1.07) return false;
    if (checkSolvedWrist) {
      if (typeof rig.contactProgress === 'function' && rig.contactProgress(side) < .95) return false;
      if (typeof rig.wristWorld === 'function') {
        const solved = rig.wristWorld(side, (this.wristProbe ??= c.wrist.clone()));
        if (solved.distanceTo(c.wrist) > .042 * scale) return false;
      }
    }
    if (seq.second) {
      const s = seq.second();
      if (!s) return false;
      const arm2 = rig.armReach(-side);
      if (arm2 && arm2.shoulder.distanceTo(s.wrist) > arm2.length * 1.07) return false;
      if (checkSolvedWrist) {
        if (typeof rig.contactProgress === 'function' && rig.contactProgress(-side) < .95) return false;
        if (typeof rig.wristWorld === 'function') {
          const solved2 = rig.wristWorld(-side, (this.wristProbe ??= s.wrist.clone()));
          if (solved2.distanceTo(s.wrist) > .042 * scale) return false;
        }
      }
    }
    return true;
  }

  /** Transfer an already secured hold between tool work and rigid carrying.
   * This changes its contact provider without replaying pickup or ownership
   * effects. A second hand is adopted only when the caller already secured it. */
  rebindHeld(side: number, contact: () => HandContact | null, second?: () => HandContact | null) {
    let kept = this.kept.get(side);
    if (!kept && this.seq && this.seq.keep && (this.seq.side ?? 1) === side && this.phase === 'operate' && this.proxy) {
      kept = { seq: this.seq, proxy: this.proxy, second: this.proxy2 };
      this.kept.set(side, kept);
      this.seq = null;
      this.proxy = this.proxy2 = null;
      this.expressActive = false;
    }
    const first = contact(), other = second?.();
    if (!kept || !first || (second && !other)) return false;
    const rig = this.host.rig();
    kept.seq = { ...kept.seq, contact, second };
    copy(kept.proxy, first);
    rig?.setContact(side, kept.proxy);
    if (other) {
      if (kept.second) copy(kept.second, other); else kept.second = clone(other);
      rig?.setContact(-side, kept.second);
    } else {
      if (kept.second && (!rig?.contactOn || rig.contactOn(-side) === kept.second)) {
        rig?.setContact(-side, null, undefined, .20);
      }
      kept.second = null;
    }
    return true;
  }

  /**
   * Snappy direct hold registration for Wave 1B-2 express tool equip:
   * binds one or both hands onto `HumanRig` with a crisp 0.12 s blend and records `kept` immediately.
   */
  acquireImmediate(seq: Sequence): boolean {
    const first = seq.contact();
    const other = seq.second?.() ?? null;
    if (!first || (seq.second && !other)) return false;
    this.cancel();
    const side = seq.side ?? 1;
    const rig = this.host.rig();
    const seconds = this.host.reduced() ? .01 : Math.min(seq.reach ?? EXPRESS_REACH_SEC, EXPRESS_REACH_SEC);
    const release = seq.release ?? EXPRESS_RELEASE_SEC;
    const proxy = clone(first);
    const proxy2 = other ? clone(other) : null;
    rig?.setContact(side, proxy, seconds, release);
    if (proxy2) rig?.setContact(-side, proxy2, seconds, release);
    seq.onContact?.();
    seq.onOperated?.();
    if (seq.keep !== false) {
      this.kept.set(side, { seq: { ...seq, keep: true }, proxy, second: proxy2 });
    }
    return true;
  }

  start(seq: Sequence) {
    this.cancel();
    this.seq = seq;
    this.reposition = null;
    this.walkOn = null;
    this.t = 0;
    const initialContact = seq.contact();
    this.expressActive = this.isExpressSequence(seq, initialContact);
    const skipApproach = Boolean(
      seq.approach &&
      this.expressActive &&
      this.host.distanceTo(seq.approach.point) <= seq.approach.stop + .48 &&
      this.withinAnatomicalEnvelope(seq, false),
    );
    this.phase = seq.approach && !skipApproach ? 'approach' : 'reach';
    if (this.phase === 'reach') this.begin(initialContact);
  }

  private begin(precomputed?: HandContact | null) {
    const seq = this.seq!, rig = this.host.rig(), side = seq.side ?? 1;
    const c = precomputed !== undefined ? precomputed : seq.contact();
    this.expressActive = this.isExpressSequence(seq, c);
    this.proxy = c ? clone(c) : null;
    const seconds = this.reachSeconds(seq);
    const release = seq.release ?? (this.expressActive ? EXPRESS_RELEASE_SEC : .42);
    if (rig && this.proxy) rig.setContact(side, this.proxy, seconds, release);
    const s = seq.second?.();
    this.proxy2 = s ? clone(s) : null;
    if (rig && this.proxy2) rig.setContact(-side, this.proxy2, seconds, release);
    this.t = 0;
    this.phase = 'reach';
  }

  /** Lets go of what `keep` was holding on this side (both sides when the thing took both hands). */
  letGo(side: number, then?: () => void) {
    const rig = this.host.rig();
    if (this.seq && this.seq.keep && (this.seq.side ?? 1) === side) {
      const release = this.seq.release ?? .20;
      rig?.setContact(side, null, undefined, release);
      if (this.proxy2 && (!rig?.contactOn || rig.contactOn(-side) === this.proxy2)) {
        rig?.setContact(-side, null, undefined, release);
      }
      this.seq = null;
      this.proxy = this.proxy2 = null;
      this.walkOn = null;
      this.reposition = null;
      this.expressActive = false;
      if (!this.kept.has(side)) {
        then?.();
        return;
      }
    }
    const kept = this.kept.get(side);
    if (!kept) return;
    const release = kept.seq.release ?? .24;
    rig?.setContact(side, null, undefined, release);
    if (kept.second && (!rig?.contactOn || rig.contactOn(-side) === kept.second)) {
      rig?.setContact(-side, null, undefined, release);
    }
    this.kept.delete(side);
    then?.();
  }

  letGoAll() {
    if (this.seq?.keep) this.letGo(this.seq.side ?? 1);
    for (const side of [...this.kept.keys()]) this.letGo(side);
  }

  /** Stops what the body is on its way to do. What the hands are carrying stays in them. */
  cancel() {
    const seq = this.seq;
    if (!seq) return;
    const rig = this.host.rig(), side = seq.side ?? 1;
    const release = seq.release ?? .20;
    const carriedPrimary = this.kept.get(side);
    if (carriedPrimary) {
      rig?.setContact(side, carriedPrimary.proxy);
    } else {
      rig?.setContact(side, null, undefined, release);
    }
    if (this.proxy2) {
      const carriedSecondary = this.kept.get(-side);
      if (carriedSecondary) {
        rig?.setContact(-side, carriedSecondary.proxy);
      } else if (!rig?.contactOn || rig.contactOn(-side) === this.proxy2) {
        rig?.setContact(-side, null, undefined, release);
      }
    }
    this.seq = null; this.proxy = this.proxy2 = null; this.walkOn = null; this.reposition = null; this.expressActive = false;
    seq.onCancel?.();
  }

  /** Everything: leaving the room, a panel taking over, or full room reset. */
  cancelAll() {
    this.cancel();
    this.letGoAll();
  }

  /** Force-clears every active and kept contact across both hands so arms return cleanly to neutral. */
  resetAll(releaseSeconds = .20) {
    const seq = this.seq;
    this.seq = null;
    this.proxy = this.proxy2 = null;
    this.walkOn = null;
    this.reposition = null;
    this.expressActive = false;
    this.kept.clear();
    const rig = this.host.rig();
    rig?.setContact(1, null, undefined, releaseSeconds);
    rig?.setContact(-1, null, undefined, releaseSeconds);
    seq?.onCancel?.();
  }

  /** Refresh geometry after physics without advancing time, repeating effects or turning the body twice. */
  refreshContacts() {
    for (const [, k] of this.kept) {
      const c = k.seq.contact();
      if (c) copy(k.proxy, c);
      const s = k.seq.second?.();
      if (s && k.second) copy(k.second, s);
    }
    if (this.seq && this.phase !== 'approach' && this.phase !== 'reposition') {
      const c = this.seq.contact(), s = this.seq.second?.();
      if (c && this.proxy) copy(this.proxy, c);
      if (s && this.proxy2) copy(this.proxy2, s);
    }
  }
  /** Called after the rig solved this frame, before any visual prop correction. */
  resolveReach() {
    const seq = this.seq;
    if (!seq?.ready || this.phase !== 'reach') return;
    const seconds = this.reachSeconds(seq);
    if (this.t < seconds) return;
    let ready = seq.ready();
    // Avoid stalling on sub-centimetre wrist-cone slack or triggering multi-pass `reposition()`
    // walks when an express tool target is already inside the anatomical shoulder-to-wrist envelope.
    if (ready === false && this.expressActive && this.t >= seconds + .03 && this.withinAnatomicalEnvelope(seq, true)) {
      ready = true;
    }
    const timeout = this.expressActive ? Math.min(seq.reachTimeout ?? .18, .18) : (seq.reachTimeout ?? 4);
    if (ready === false && this.t < seconds + timeout) return;
    if (ready !== true) {
      const step = ready === false && !this.reposition ? seq.reposition?.() : null;
      if (!step) { this.cancel(); seq.onUnreachable?.(); return; }
      this.reposition = step;
      const rig = this.host.rig(), side = seq.side ?? 1;
      rig?.setContact(side, null);
      if (this.proxy2) rig?.setContact(-side, null);
      this.proxy = this.proxy2 = null; this.walkOn = null;
      this.t = 0; this.phase = 'reposition';
      return;
    }
    this.t = 0; this.phase = 'operate'; this.reposition = null; seq.onContact?.();
  }
  update(dt: number) {
    this.refreshContacts();
    const seq = this.seq;
    if (!seq) return;
    this.t += dt;
    if (this.phase === 'reposition') {
      const arrived = this.reposition!(dt);
      if (arrived === true) this.begin();
      else if (arrived === null || this.t > 5) { this.cancel(); seq.onUnreachable?.(); }
      return;
    }
    if (this.phase === 'approach') {
      if (seq.keep && seq.ready && this.t > 12) { this.cancel(); seq.onUnreachable?.(); return; }
      const a = seq.approach!;
      if (this.expressActive && this.host.distanceTo(a.point) <= a.stop + .48 && this.withinAnatomicalEnvelope(seq, false)) {
        this.begin();
        return;
      }
      const arrived = this.host.walkToward(a.point, a.stop, dt);
      if (arrived === null) { this.begin(); return; }   // Blocked: reach from here as far as an arm goes.
      if (arrived) { this.begin(); return; }
      // Nearly there: the arm is already going while the feet take the last steps.
      const leadMargin = this.expressActive ? .56 : .42;
      if (seq.keep && this.host.distanceTo(a.point) < a.stop + leadMargin) { this.walkOn = a; this.begin(); }
      return;
    }
    if (this.walkOn) { const on = this.host.walkToward(this.walkOn.point, this.walkOn.stop, dt); if (on !== false) this.walkOn = null; }
    const c = seq.contact();
    if (c && this.proxy) copy(this.proxy, c);
    const s = seq.second?.();
    if (s && this.proxy2) copy(this.proxy2, s);
    if (c && this.phase === 'reach' && !this.reposition) {
      const target = s
        ? (this.turnMid ??= c.wrist.clone()).set(
            (c.wrist.x + s.wrist.x) * .5,
            (c.wrist.y + s.wrist.y) * .5,
            (c.wrist.z + s.wrist.z) * .5,
          )
        : c.wrist;
      this.host.turnTo(target, dt);
    }
    if (this.phase === 'reach') {
      const seconds = this.reachSeconds(seq);
      if (this.t >= seconds) {
        if (seq.ready) return; // The mixer may have restored the pose; test after IK.
        this.t = 0; this.phase = 'operate'; seq.onContact?.();
      }
      return;
    }
    if (this.phase === 'operate') {
      const seconds = this.host.reduced() ? .01 : seq.operate ?? 0;
      const k = seq.until ? (seq.until() ? 1 : Math.min(.99, this.t / Math.max(.01, seconds || 1))) : seconds > 0 ? Math.min(1, this.t / seconds) : 1;
      seq.onOperate?.(k);
      if (k >= 1) {
        seq.onOperated?.();
        if (this.seq !== seq) return;
        const side = seq.side ?? 1;
        if (seq.keep) {
          if (this.proxy) this.kept.set(side, { seq, proxy: this.proxy, second: this.proxy2 });
          this.seq = null; this.proxy = this.proxy2 = null; this.expressActive = false;
          seq.onDone?.();
          return;
        }
        const rig = this.host.rig(), release = seq.release ?? .42;
        rig?.setContact(side, null, undefined, release);
        if (this.proxy2) rig?.setContact(-side, null, undefined, release);
        this.t = 0;
        this.phase = 'release';
      }
      return;
    }
    if (this.phase === 'release' && this.t >= (seq.release ?? .42)) {
      this.seq = null; this.proxy = this.proxy2 = null; this.expressActive = false;
      seq.onDone?.();
    }
  }
}

/**
 * A chain of things to do, each waiting for the one before: stand up, walk round the desk, open the door, go through. Anything the player
 * does with the keys interrupts it, and an interrupted chain cleans up after itself.
 */
export interface PlanStep {
  name: string;
  start?: () => void;
  /** True: done, on to the next. Null: it cannot be done. */
  tick?: (dt: number) => boolean | null;
  cancel?: () => void;
}
export class ActionPlan {
  private steps: PlanStep[] = [];
  private index = -1;
  label: string | null = null;
  failed: string | null = null;
  private onFail: ((step: string) => void) | null = null;
  get active() { return this.index >= 0; }
  get step() { return this.index >= 0 ? this.steps[this.index]?.name ?? null : null; }
  run(label: string, steps: PlanStep[], onFail?: (step: string) => void) {
    this.cancel();
    this.steps = steps; this.index = 0; this.label = label; this.failed = null; this.onFail = onFail ?? null;
    this.steps[0]?.start?.();
  }
  cancel() {
    if (this.index >= 0) this.steps[this.index]?.cancel?.();
    this.index = -1; this.steps = []; this.label = null;
  }
  update(dt: number) {
    if (this.index < 0) return;
    const step = this.steps[this.index];
    if (!step) { this.index = -1; this.label = null; return; }
    const r = step.tick ? step.tick(dt) : true;
    if (r === null) {
      const name = step.name, fail = this.onFail;
      step.cancel?.();
      this.failed = name; this.index = -1; this.steps = []; this.label = null;
      fail?.(name);
      return;
    }
    if (r) {
      this.index++;
      if (this.index >= this.steps.length) { this.index = -1; this.steps = []; this.label = null; return; }
      this.steps[this.index].start?.();
    }
  }
}
