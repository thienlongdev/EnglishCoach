import * as T from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { HandSkin, type HandSkinData } from './handSkin';
import { FingerSurfaceFit, type SurfaceFit } from './fingerSurface';
import type { FingerPose } from './fingers';
import type { GraspMeshData } from './human';
import { querySurface } from './grasp';

export interface FingerFitJob {
  skin: HandSkinData; surface: GraspMeshData; handToObject: number[]; seed: FingerPose;
  /** Metres available to withdraw along the approach BEFORE securing a grasp.
   * Omitted/zero for an established grasp: its local transform cannot change. */
  pregraspRetreat?: number;
}
export interface FingerFitResult extends SurfaceFit {
  trianglesIntersect: boolean; fullHandClearance: number; milliseconds: number;
  /** In the captured hand frame. A planner must validate reach/obstacles and
   * approach this wrist before attachment; never apply it to a secured grasp. */
  wristOffset: [number, number, number]; attempts: number;
}
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Runs only on an isolated numerical snapshot. Cancellation is observed between
 * search slices and verification batches; no stale result is applied to a hand. */
export async function runFingerFit(job: FingerFitJob, cancelled: () => boolean): Promise<FingerFitResult | null> {
  const started = performance.now(), geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(job.surface.positions, 3));
  geometry.setIndex(new T.BufferAttribute(job.surface.indices, 1));
  const tree = new MeshBVH(geometry), relation = new T.Matrix4().fromArray(job.handToObject);
  const handScale = new T.Vector3().setFromMatrixScale(relation).x * job.surface.scale;
  let attempts = 0;
  const evaluate = async (retreat: number): Promise<FingerFitResult | null> => {
    const wristOffset: [number, number, number] = [0, -retreat / handScale, 0];
    const candidate = relation.clone().multiply(new T.Matrix4().makeTranslation(...wristOffset));
    const shape = querySurface(tree, candidate, job.surface.scale);
    const fit = new FingerSurfaceFit(job.skin, new T.Matrix4(), [], job.skin.side, shape, job.seed);
    attempts++;
    let result: SurfaceFit | null = null;
    while (!result && !cancelled()) { result = fit.step(6); if (!result) await yieldTask(); }
    if (!result || cancelled()) { fit.cancel(); return null; }
    const skin = new HandSkin(job.skin); result.pose.forEach((pose, finger) => skin.setFinger(finger, pose));
    const surface = skin.geometry() as T.BufferGeometry & { boundsTree?: MeshBVH };
    surface.boundsTree = new MeshBVH(surface);
    const trianglesIntersect = tree.intersectsGeometry(surface, candidate); surface.dispose();
    let fullHandClearance = Infinity;
    const point = new T.Vector3();
    for (let k = 0; k < skin.handVertices.length; k++) {
      fullHandClearance = Math.min(fullHandClearance, shape.signedDistance!(skin.point(skin.handVertices[k], point).applyMatrix4(candidate)));
      if (k % 256 === 0) { if (cancelled()) return null; await yieldTask(); }
    }
    if (trianglesIntersect || fullHandClearance < 0) result.valid.fill(false);
    return { ...result, trianglesIntersect, fullHandClearance, wristOffset, attempts, milliseconds: performance.now() - started };
  };
  try {
    if (cancelled() || !(handScale > 0)) return null;
    const initial = await evaluate(0);
    if (!initial || initial.valid.every(Boolean)) return initial;
    // Search an approach interval only when actual geometry rejects the first
    // pose. No per-hero/book-size offset and no movement of a secured grasp.
    const limit = Math.max(0, Math.min(.024, job.pregraspRetreat ?? 0));
    let previous = 0;
    for (let retreat = Math.min(.003, limit); retreat > previous; retreat = Math.min(limit, retreat * 2)) {
      if (cancelled()) return null;
      const candidate = await evaluate(retreat);
      if (!candidate) return null;
      if (candidate.valid.every(Boolean)) {
        // Keep the smallest geometrically verified candidate to within 1.5 mm.
        let low = previous, high = retreat, best = candidate;
        while (high - low > .0015) {
          const mid = (low + high) / 2, refined = await evaluate(mid);
          if (!refined) return null;
          if (refined.valid.every(Boolean)) { best = refined; high = mid; } else low = mid;
        }
        return { ...best, attempts, milliseconds: performance.now() - started };
      }
      previous = retreat;
    }
    return { ...initial, attempts, milliseconds: performance.now() - started };
  } finally { geometry.dispose(); }
}
