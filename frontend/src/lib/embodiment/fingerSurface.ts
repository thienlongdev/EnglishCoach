import * as T from 'three';
import type { FingerPose } from './fingers';
import type { GraspShape } from './human';
import { HandSkin, type HandSkinData, type SkinProbe, type SurfaceJoint } from './handSkin';

export type { SurfaceJoint } from './handSkin';
export interface SurfaceFit { pose: FingerPose; clearance: number[]; gap: number[]; valid: boolean[]; evaluations: number }
type Probe = SkinProbe;
/**
 * Experimental; not connected to HumanRig until latency and visual gates pass.
 * Incremental contact search in the established hand frame. The object may move
 * anywhere in the room while this runs: only the retained hand/object relation
 * is used. Each candidate is bounded by anatomical joint ranges and checked
 * against actual skin vertices and the object's signed triangle distance.
 */
export class FingerSurfaceFit {
  private readonly skin: HandSkin;
  private readonly iterator: Generator<void, SurfaceFit>;
  private readonly handToObject: T.Matrix4;
  private readonly bounds: T.Box3;
  private readonly samples: Probe[][];
  private readonly active: Probe[][];
  private readonly p = new T.Vector3();
  private readonly local = new T.Vector3();
  private done = false;
  constructor(mesh: T.SkinnedMesh | HandSkinData, hand: T.Bone | T.Matrix4, joints: SurfaceJoint[],
    side: number, private shape: GraspShape, private seed: FingerPose) {
    if ('isBone' in hand) hand.updateWorldMatrix(true, true);
    this.handToObject = shape.toLocal.clone().multiply('isBone' in hand ? hand.matrixWorld : hand);
    this.bounds = shape.bounds!.clone().applyMatrix4(this.handToObject.clone().invert());
    this.skin = 'isSkinnedMesh' in mesh ? new HandSkin(mesh, hand as T.Bone, joints, side) : new HandSkin(mesh);
    this.samples = this.skin.groups;
    // Broad search, followed by full-skin verification and active constraints.
    // Omitted vertices can never make a result valid; they are checked below.
    this.active = this.samples.map(points => points.filter((_, i) => i % Math.max(1, Math.floor(points.length / 72)) === 0));
    this.iterator = this.solve();
  }
  /** Discard an obsolete contact without ever publishing its candidate pose. */
  cancel() { this.done = true; }
  /** Bounded cooperative work; candidates never mutate the drawn skeleton. */
  step(milliseconds = 1.5): SurfaceFit | null {
    if (this.done) return null;
    const until = performance.now() + milliseconds;
    do {
      const next = this.iterator.next();
      if (next.done) { this.done = true; return next.value; }
    } while (performance.now() < until);
    return null;
  }
  private evaluate(finger: number, angles: number[], full = false) {
    this.skin.setFinger(finger, angles);
    let penalty = 0, minimum = Infinity, gap = .15;
    const violations: Probe[] = [];
    for (const sample of full ? this.samples[finger] : this.active[finger]) {
      this.skin.point(sample.index, this.p);
      this.local.copy(this.p).applyMatrix4(this.handToObject);
      const distance = this.shape.signedDistance!(this.local);
      minimum = Math.min(minimum, distance);
      if (distance < .0006) penalty += (distance - .0006) ** 2;
      if (full && distance < .001) violations.push(sample);
      if (sample.pad) {
        // Opposed pads: thumb over the cover, the four fingers underneath.
        const wrongSide = finger === 0 ? Math.max(0, this.bounds.max.z - .004 - this.p.z) : Math.max(0, this.p.z - this.bounds.min.z - .004);
        gap = Math.min(gap, Math.abs(distance - .0008) + wrongSide * 2);
      }
    }
    const regular = angles.reduce((sum, v, i) => sum + v * v * (i === 4 ? .00001 : .000003), 0);
    return { score: penalty * 5000 + gap * gap + regular, minimum, gap, violations };
  }
  private *solve(): Generator<void, SurfaceFit> {
    const result: SurfaceFit = { pose: this.seed.map(v => [...v, 0].slice(0, 5)), clearance: [], gap: [], valid: [], evaluations: 0 };
    for (let finger = 0; finger < 5; finger++) {
      let best = result.pose[finger].slice(), score = this.evaluate(finger, best);
      result.evaluations++; yield;
      let bestFull = this.evaluate(finger, best, true); result.evaluations++; yield;
      const limits = finger === 0 ? [[-.45, 1.1], [0, 1.2], [0, 1.2], [-.7, .7], [-1.1, 1.1]] : [[-.2, 1.4], [0, 1.6], [0, 1.1], [-.15, .15], [0, 0]];
      const starts = finger === 0 ? [best, [0, .3, .7, .1, -.4], [0, .3, .7, .1, .4]] : [best];
      if (finger === 0) {
        // Opposition is a coupled three-axis motion at the thumb base. Search
        // distinct basins before refining; mirroring one right-hand optimum
        // does not qualify a left-hand grasp on a different edge/thickness.
        const seeds: { angles: number[]; score: number }[] = [];
        for (const flex of [-.3, .2, .7]) for (const spread of [-.45, 0, .45]) for (const opposition of [-.75, 0, .75]) {
          const angles = [flex, .4, .4, spread, opposition];
          seeds.push({ angles, score: this.evaluate(finger, angles).score }); result.evaluations++; yield;
        }
        seeds.sort((a, b) => a.score - b.score);
        starts.push(...seeds.slice(0, 5).map(s => s.angles));
      }
      for (const start of starts) {
        let angles = start.slice(), current = this.evaluate(finger, angles); result.evaluations++; yield;
        for (const step of [.24, .12, .06, .03, .015]) for (let repeat = 0; repeat < 2; repeat++) {
          for (let axis = 0; axis < 5; axis++) {
            if (limits[axis][0] === limits[axis][1]) continue;
            for (const direction of [-1, 1]) {
              const candidate = angles.slice(); candidate[axis] = T.MathUtils.clamp(candidate[axis] + step * direction, ...limits[axis] as [number, number]);
              const value = this.evaluate(finger, candidate); result.evaluations++; yield;
              if (value.score < current.score) { angles = candidate; current = value; }
            }
          }
        }
        const verified = this.evaluate(finger, angles, true); result.evaluations++; yield;
        if (verified.score < bestFull.score) { best = angles; bestFull = verified; score = current; }
      }
      // Recheck every distinct vertex; missed collisions become constraints
      // during local refinement. No sparse-only result is accepted.
      for (let round = 0; round < 6; round++) {
        const full = this.evaluate(finger, best, true); result.evaluations++; yield;
        if (full.minimum >= .0003 && full.gap < .0012) { score = full; break; }
        for (const point of full.violations) if (!this.active[finger].includes(point)) this.active[finger].push(point);
        score = this.evaluate(finger, best); result.evaluations++; yield;
        for (const step of [.06, .03, .015, .0075, .00375]) for (let repeat = 0; repeat < 2; repeat++) {
          for (let axis = 0; axis < 5; axis++) {
            if (limits[axis][0] === limits[axis][1]) continue;
            for (const direction of [-1, 1]) {
              const candidate = best.slice(); candidate[axis] = T.MathUtils.clamp(candidate[axis] + step * direction, ...limits[axis] as [number, number]);
              const value = this.evaluate(finger, candidate); result.evaluations++; yield;
              if (value.score < score.score) { best = candidate; score = value; }
            }
          }
        }
      }
      score = this.evaluate(finger, best, true); result.evaluations++; yield;
      // The last trial may not be the winner. Other fingers share webbing
      // weights, so the next search must see the accepted pose of this one.
      this.skin.setFinger(finger, best);
      result.pose[finger] = best;
      result.clearance.push(score.minimum); result.gap.push(score.gap);
      result.valid.push(score.minimum >= .0003 && score.gap < .0012);
    }
    return result;
  }
}
