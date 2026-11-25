import * as T from 'three';

const _invFootM = new T.Matrix4();
const _tmpP = new T.Vector3();

/** Indexed shoe vertices rigidly owned by this foot, in its actual bone frame.
 * Stored as a packed Float32Array for zero-allocation per-frame sole queries,
 * with `rebuild()` to refresh sole bounds after wardrobe footwear changes. */
export class FootSurface {
  private coords = new Float32Array(0);
  private up = new T.Vector3();
  private inverse = new T.Quaternion();

  constructor(model: T.Object3D, foot: T.Bone) {
    this.rebuild(model, foot);
  }

  /** Re-measures drawn shoe/foot vertices bound rigidly to `foot` (e.g. after Wardrobe equips boots/sneakers). */
  rebuild(model: T.Object3D, foot: T.Bone): void {
    const seen = new Set<string>();
    const packed: number[] = [];
    model.traverse((object) => {
      const mesh = object as T.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !mesh.visible) return;
      const index = mesh.skeleton.bones.indexOf(foot);
      const boneInverse = index >= 0 ? mesh.skeleton.boneInverses[index] : undefined;
      const geometry = mesh.geometry;
      if (index < 0 || !boneInverse || !geometry.attributes.skinIndex || !geometry.attributes.skinWeight) return;
      const posAttr = geometry.attributes.position;
      const idxAttr = geometry.index;
      const visit = (vi: number) => {
        let weight = 0;
        for (let k = 0; k < 4; k++) {
          if (geometry.attributes.skinIndex.getComponent(vi, k) === index) {
            weight += geometry.attributes.skinWeight.getComponent(vi, k);
          }
        }
        if (Math.abs(weight - 1) > 1e-6) return;
        // Exact pose- and world-translation-invariant bone-local coordinates: p_foot = boneInverse * bindMatrix * p_attr.
        // Avoids SkinnedMesh.getVertexPosition() stale bindMatrixInverse bugs when root.position != (0,0,0).
        _tmpP.fromBufferAttribute(posAttr, vi).applyMatrix4(mesh.bindMatrix).applyMatrix4(boneInverse);
        const key = `${Math.round(_tmpP.x * 1e5)},${Math.round(_tmpP.y * 1e5)},${Math.round(_tmpP.z * 1e5)}`;
        if (!seen.has(key)) {
          seen.add(key);
          packed.push(_tmpP.x, _tmpP.y, _tmpP.z);
        }
      };
      if (idxAttr) {
        const arr = idxAttr.array;
        for (let j = 0; j < arr.length; j++) visit(arr[j]);
      } else {
        for (let vi = 0; vi < posAttr.count; vi++) visit(vi);
      }
    });
    this.coords = new Float32Array(packed);
  }

  get vertices(): number {
    return this.coords.length / 3;
  }

  /** Centroid of the lowest drawn sole patch, in the foot's bone frame. Zero allocations. */
  supportPoint(rotation: T.Quaternion, scale: T.Vector3, out: T.Vector3): T.Vector3 {
    const low = this.offsetY(rotation, scale);
    out.set(0, 0, 0);
    const c = this.coords;
    const n = c.length;
    if (n === 0) return out;
    const ux = this.up.x;
    const uy = this.up.y;
    const uz = this.up.z;
    const tol = low + 0.0005 * scale.y;
    let count = 0;
    for (let i = 0; i < n; i += 3) {
      const px = c[i];
      const py = c[i + 1];
      const pz = c[i + 2];
      if (px * ux + py * uy + pz * uz <= tol) {
        out.x += px;
        out.y += py;
        out.z += pz;
        count++;
      }
    }
    return count > 0 ? out.divideScalar(count) : out;
  }

  /** Lowest drawn point relative to the ankle for this world rotation/scale. Zero allocations. */
  offsetY(rotation: T.Quaternion, scale: T.Vector3): number {
    const c = this.coords;
    const n = c.length;
    if (n === 0) return 0;
    this.up.set(0, 1, 0).applyQuaternion(this.inverse.copy(rotation).invert()).multiply(scale);
    const ux = this.up.x;
    const uy = this.up.y;
    const uz = this.up.z;
    let low = Infinity;
    for (let i = 0; i < n; i += 3) {
      const d = c[i] * ux + c[i + 1] * uy + c[i + 2] * uz;
      if (d < low) low = d;
    }
    return low;
  }
}
