import * as T from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { GraspShape } from './human';

/**
 * The real surface of a thing in the hand: a bounding volume hierarchy (three-mesh-bvh) over the triangles that are drawn, in the
 * thing's own frame. The fingers close until they meet these triangles, not a box round them: a mug's handle, a book's spine and a
 * bucket's bail are felt as they are. Built once per kind/geometry signature on the first grasp, kept for the visit.
 */
const cache = new Map<string, MeshBVH | null>();
const signatureCache = new Map<string, MeshBVH | null>();
const meshDataCache = new WeakMap<MeshBVH, { positions: Float32Array; indices: Uint32Array }>();

const inv = new T.Matrix4();
const rel = new T.Matrix4();
const v = new T.Vector3();
const scaleV = new T.Vector3();

/** More triangles than this is furniture, not something a hand closes round: the primitive shape is used instead. */
const MAX_TRIANGLES = 60000;
/** Dense decorative/foliage submeshes above this triangle count are stride-sampled so one-time BVH build stays < 0.5 ms. */
const DENSE_SUBMESH_TRIS = 2500;
const DENSE_SUBMESH_TARGET_TRIS = 1500;

const FOLIAGE_NAME_RE = /(?:^|[:_\-\s])(leaf|leaves|foliage|frond|petal|blossom)(?:$|[:_\-\s#0-9])/i;

interface SubmeshCollect {
  pos: T.BufferAttribute | T.InterleavedBufferAttribute;
  index: T.BufferAttribute | null;
  triCount: number;
  triStride: number;
  sampledTris: number;
  e0: number; e1: number; e2: number;
  e4: number; e5: number; e6: number;
  e8: number; e9: number; e10: number;
  e12: number; e13: number; e14: number;
}

const _submeshes: SubmeshCollect[] = [];

function quantize4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export function surfaceOf(root: T.Object3D, key: string, skip?: (o: T.Object3D) => boolean): MeshBVH | null {
  const known = cache.get(key);
  if (known !== undefined) return known;

  root.updateWorldMatrix(true, true);
  inv.copy(root.matrixWorld).invert();

  _submeshes.length = 0;
  let totalRawTris = 0;
  let totalSampledTris = 0;
  const sigParts: string[] = [];
  const assetKey = typeof root.userData?.asset === 'string' ? root.userData.asset : '';
  if (assetKey) sigParts.push(assetKey);

  root.traverse(o => {
    const m = o as T.Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean };
    if (!m.isMesh || m.isSkinnedMesh || m.isInstancedMesh || !m.visible || skip?.(o)) return;
    const g = m.geometry as T.BufferGeometry | undefined;
    const pos = g?.getAttribute('position');
    if (!g || !pos) return;
    const index = g.index;
    const vertCount = index ? index.count : pos.count;
    const triCount = Math.floor(vertCount / 3);
    if (triCount <= 0) return;

    totalRawTris += triCount;
    rel.multiplyMatrices(inv, m.matrixWorld);
    const e = rel.elements;
    sigParts.push(
      `${g.uuid}:${vertCount}:${quantize4(e[0])},${quantize4(e[5])},${quantize4(e[10])},${quantize4(e[12])},${quantize4(e[13])},${quantize4(e[14])}`,
    );

    const triStride = triCount > DENSE_SUBMESH_TRIS ? Math.max(1, Math.ceil(triCount / DENSE_SUBMESH_TARGET_TRIS)) : 1;
    const sampledTris = Math.ceil(triCount / triStride);
    totalSampledTris += sampledTris;

    _submeshes.push({
      pos,
      index,
      triCount,
      triStride,
      sampledTris,
      e0: e[0], e1: e[1], e2: e[2],
      e4: e[4], e5: e[5], e6: e[6],
      e8: e[8], e9: e[9], e10: e[10],
      e12: e[12], e13: e[13], e14: e[14],
    });
  });

  if (!totalSampledTris || totalRawTris > MAX_TRIANGLES) {
    _submeshes.length = 0;
    cache.set(key, null);
    return null;
  }

  const sig = sigParts.join('|');
  if (sig) {
    const bySig = signatureCache.get(sig);
    if (bySig !== undefined) {
      _submeshes.length = 0;
      cache.set(key, bySig);
      return bySig;
    }
  }

  const all = new Float32Array(totalSampledTris * 9);
  let outAt = 0;

  for (let s = 0; s < _submeshes.length; s++) {
    const sub = _submeshes[s];
    const {
      pos, index, triCount, triStride,
      e0, e1, e2, e4, e5, e6, e8, e9, e10, e12, e13, e14,
    } = sub;
    const rawPos = pos instanceof T.BufferAttribute && pos.itemSize === 3 && !pos.normalized
      ? (pos.array as ArrayLike<number>)
      : null;
    const rawIdx = index && !index.normalized ? (index.array as ArrayLike<number>) : null;

    for (let t = 0; t < triCount; t += triStride) {
      const base = t * 3;
      for (let k = 0; k < 3; k++) {
        const vi = rawIdx ? rawIdx[base + k] : index ? index.getX(base + k) : base + k;
        let px: number, py: number, pz: number;
        if (rawPos) {
          const pi = vi * 3;
          px = rawPos[pi];
          py = rawPos[pi + 1];
          pz = rawPos[pi + 2];
        } else {
          v.fromBufferAttribute(pos as T.BufferAttribute, vi);
          px = v.x;
          py = v.y;
          pz = v.z;
        }
        all[outAt++] = e0 * px + e4 * py + e8 * pz + e12;
        all[outAt++] = e1 * px + e5 * py + e9 * pz + e13;
        all[outAt++] = e2 * px + e6 * py + e10 * pz + e14;
      }
    }
  }
  _submeshes.length = 0;

  const trimmed = outAt === all.length ? all : all.subarray(0, outAt);
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(trimmed, 3));
  geometry.computeBoundingBox();
  const bvh = new MeshBVH(geometry, { maxLeafTris: 10 });
  if (sig) signatureCache.set(sig, bvh);
  cache.set(key, bvh);
  return bvh;
}

const _distHit = { point: new T.Vector3(), distance: 0, faceIndex: 0 };
const _signedHit = { point: new T.Vector3(), distance: 0, faceIndex: 0 };
const _qsA = new T.Vector3();
const _qsB = new T.Vector3();
const _qsC = new T.Vector3();
const _qsNormal = new T.Vector3();
const _ray = new T.Ray();

/** A grasp shape from the thing's own triangles; null when it has none worth feeling (the caller keeps its primitive). */
export function meshShape(root: T.Object3D, key: string, skip?: (o: T.Object3D) => boolean): GraspShape | null {
  const bvh = surfaceOf(root, key, skip);
  if (!bvh) return null;
  root.updateWorldMatrix(true, false);
  const toLocal = root.matrixWorld.clone().invert();
  const scale = root.getWorldScale(scaleV).x || 1;
  return querySurface(bvh, toLocal, scale);
}

/** Shared by the live contact queries and the isolated numerical search. */
export function querySurface(bvh: MeshBVH, toLocal: T.Matrix4, scale: number): GraspShape {
  // Beyond a few centimetres nothing is touching: the search stops there, which keeps each question cheap.
  const far = .06 / scale;
  const geometry = bvh.geometry;
  const positions = geometry.attributes.position;
  const indices = geometry.index!;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return {
    kind: 'mesh',
    toLocal,
    half: [0, 0, 0],
    bounds: geometry.boundingBox!.clone(),
    meshData: () => {
      let cached = meshDataCache.get(bvh);
      if (!cached) {
        cached = {
          positions: new Float32Array(positions.array),
          indices: new Uint32Array(indices.array),
        };
        meshDataCache.set(bvh, cached);
      }
      return {
        positions: new Float32Array(cached.positions),
        indices: new Uint32Array(cached.indices),
        scale,
      };
    },
    // `limit` (metres): nothing nearer than this is the answer `limit`; a finger fit only asks about the last few centimetres.
    signedDistance: (local: T.Vector3, limit = .15) => {
      const near = bvh.closestPointToPoint(local, _signedHit, 0, limit / scale);
      if (!near) return limit;
      const at = near.faceIndex * 3;
      _qsA.fromBufferAttribute(positions as T.BufferAttribute, indices.getX(at));
      _qsB.fromBufferAttribute(positions as T.BufferAttribute, indices.getX(at + 1)).sub(_qsA);
      _qsC.fromBufferAttribute(positions as T.BufferAttribute, indices.getX(at + 2)).sub(_qsA);
      _qsNormal.crossVectors(_qsB, _qsC);
      return near.distance * scale * (_qsA.copy(local).sub(near.point).dot(_qsNormal) < 0 ? -1 : 1);
    },
    distance: (local: T.Vector3) => {
      const r = bvh.closestPointToPoint(local, _distHit, 0, far);
      return r ? r.distance * scale : far * scale;
    },
    // QA only: inside a closed surface a ray crosses it an odd number of times.
    inside: (local: T.Vector3) => {
      _ray.origin.copy(local);
      _ray.direction.set(.4471, .6123, .6522);
      return bvh.raycast(_ray, T.DoubleSide).length % 2 === 1;
    },
  };
}

const hitRay = new T.Ray();
const toLocalM = new T.Matrix4();

/**
 * Where a hand coming from `origin` along `dir` (world) first meets the thing's real surface: the point the palm goes to. Null when it
 * misses or the thing has no mesh worth feeling.
 */
export function surfaceHit(
  root: T.Object3D,
  key: string,
  origin: T.Vector3,
  dir: T.Vector3,
  far: number,
  skip?: (o: T.Object3D) => boolean,
): { point: T.Vector3; normal: T.Vector3 } | null {
  const bvh = surfaceOf(root, key, skip);
  if (!bvh) return null;
  root.updateWorldMatrix(true, false);
  toLocalM.copy(root.matrixWorld).invert();
  hitRay.origin.copy(origin).applyMatrix4(toLocalM);
  hitRay.direction.copy(dir).transformDirection(toLocalM);
  const hit = bvh.raycastFirst(hitRay, T.DoubleSide);
  if (!hit) return null;
  const world = hit.point.clone().applyMatrix4(root.matrixWorld);
  if (world.distanceTo(origin) > far) return null;
  // The face's normal, turned to face the hand that is coming.
  const normal = (hit.face ? hit.face.normal.clone() : new T.Vector3(0, 1, 0)).transformDirection(root.matrixWorld);
  if (normal.dot(dir) > 0) normal.negate();
  return { point: world, normal };
}

const _snInv = new T.Matrix4();
const _snLocal = new T.Vector3();
const _snScale = new T.Vector3();
const _snHit = { point: new T.Vector3(), distance: 0, faceIndex: 0 };
const _snTri = new T.Triangle();
const _snNormalMat = new T.Matrix3();
const _snToOrigin = new T.Vector3();

/** A hollow object may have no triangle along the approach ray (chair backs,
 * frames, stands). Choose a nearby real surface instead of the empty box face.
 * The result is bounded in world metres and its normal faces the approaching
 * palm. This is a pre-grasp query, never a correction to a secured grasp. */
export function surfaceNearest(
  root: T.Object3D,
  key: string,
  origin: T.Vector3,
  far: number,
  skip?: (o: T.Object3D) => boolean,
): { point: T.Vector3; normal: T.Vector3 } | null {
  const bvh = surfaceOf(root, key, skip);
  if (!bvh || !(far > 0)) return null;
  root.updateWorldMatrix(true, false);
  _snInv.copy(root.matrixWorld).invert();
  _snLocal.copy(origin).applyMatrix4(_snInv);
  root.getWorldScale(_snScale);
  const minimumScale = Math.min(Math.abs(_snScale.x), Math.abs(_snScale.y), Math.abs(_snScale.z));
  if (minimumScale < 1e-8) return null;
  const hit = bvh.closestPointToPoint(_snLocal, _snHit, 0, far / minimumScale);
  if (!hit) return null;
  const point = hit.point.clone().applyMatrix4(root.matrixWorld);
  if (point.distanceTo(origin) > far) return null;
  const geometry = bvh.geometry;
  const position = geometry.attributes.position;
  const index = geometry.index!;
  const f3 = hit.faceIndex * 3;
  _snTri.a.fromBufferAttribute(position as T.BufferAttribute, index.getX(f3));
  _snTri.b.fromBufferAttribute(position as T.BufferAttribute, index.getX(f3 + 1));
  _snTri.c.fromBufferAttribute(position as T.BufferAttribute, index.getX(f3 + 2));
  const normal = _snTri.getNormal(new T.Vector3()).applyNormalMatrix(_snNormalMat.getNormalMatrix(root.matrixWorld)).normalize();
  if (normal.dot(_snToOrigin.copy(origin).sub(point)) < 0) normal.negate();
  return { point, normal };
}

/** What a hand can close on: not shadow blobs, not invisible helpers, not leaves (a plant is taken by its pot). */
export function graspable(o: T.Object3D) {
  if (o.userData.blob || (o.userData.noCollision && !o.userData.pickable)) return false;
  if (o.userData.pickable) return true;
  const m = (o as T.Mesh).material as T.Material | T.Material[] | undefined;
  const matName = Array.isArray(m) ? m[0]?.name : m?.name;
  if (matName && (/^leaf[:_]/i.test(matName) || FOLIAGE_NAME_RE.test(matName))) return false;
  if (o.name && FOLIAGE_NAME_RE.test(o.name)) return false;
  return true;
}

/** For tests: how many surfaces were built. */
export function graspCacheSize() { return cache.size; }
