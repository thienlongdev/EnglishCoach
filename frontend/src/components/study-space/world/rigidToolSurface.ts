import * as T from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type RAPIER from '@dimforge/rapier3d-compat';

/** These open source meshes are boundaries, not material volumes. Their hulls
 * bridge visible empty space. Keep their actual triangles on the existing body;
 * the body's separately declared mass/inertia remains owned exactly once. */
export function rigidToolSurface(R: typeof RAPIER, kind: string, mesh: T.Object3D, toStage: T.Matrix4, center: T.Vector3): RAPIER.ColliderDesc[] | null {
  const name = mesh.userData.name ?? mesh.name;
  const expected = kind === 'tool.broom' && name === 'Twine' ? 840 : kind === 'tool.webbrush' && name === 'Collar' ? 316 : 0;
  if (!expected) return null;
  const geometry = (mesh as T.Mesh).geometry, position = geometry?.getAttribute('position'), index = geometry?.index;
  if (!position || (index?.count ?? position.count) !== expected * 3) throw new Error('Unsupported authored tool boundary');
  const transform = toStage.clone().multiply(mesh.matrixWorld);
  const vertices = new Float32Array(position.count * 3), point = new T.Vector3();
  for (let i = 0; i < position.count; i++) point.fromBufferAttribute(position, i).applyMatrix4(transform).sub(center).toArray(vertices, i * 3);
  const points = Array.from({ length: position.count }, (_, i) => new T.Vector3().fromArray(vertices, i * 3));
  const local = Array.from({ length: position.count }, (_, i) => new T.Vector3().fromBufferAttribute(position, i));
  const faces = Array.from({ length: expected }, (_, i) => [0, 1, 2].map(j => index ? index.getX(i * 3 + j) : i * 3 + j));
  const triangles = faces.map(face => new T.Triangle(...face.map(i => local[i]) as [T.Vector3, T.Vector3, T.Vector3]));
  const retained = triangles.map((t, i) => ({ t, i })).filter(({ t }) => t.getArea() > 0);
  // A zero-area face may only be omitted when its whole segment/point is
  // contained in one retained original triangle. No caps or thickness added.
  for (const triangle of triangles) if (triangle.getArea() === 0) {
    const covered = retained.some(({ t }) => [triangle.a, triangle.b, triangle.c].every(p => t.closestPointToPoint(p, point).distanceTo(p) < 1e-12));
    if (!covered) throw new Error('Unrepresented degenerate tool boundary');
  }
  // Prove redundancy before rotation/Float32 storage: quantisation must not
  // turn a source zero-area face into a spurious sliver at another room pose.
  return retained.map(({ i }) => R.ColliderDesc.triangle(...faces[i].map(j => points[j]) as [T.Vector3, T.Vector3, T.Vector3]));
}

/** Conservative query pruning for exact boundary colliders. Survivors still
 * take the existing native casts/overlap tests; this never changes a body's
 * physical colliders, contact groups, clearance or solver. Unknown obstacle
 * shapes are retained. Bounds are queried from the current scene each time. */
type SurfaceBounds = { box: T.Box3; radius: number };
type SurfaceLeaf = SurfaceBounds & { part: RAPIER.Collider };
type SurfaceGroup = SurfaceBounds & { leaves: SurfaceLeaf[] };
type ToolBounds = SurfaceBounds & {
  parts: Set<RAPIER.Collider>;
  shapes: Map<RAPIER.Collider, RAPIER.Shape>;
  regular: RAPIER.Collider[];
  regularBounds: Map<RAPIER.Collider, SurfaceBounds>;
  hasUnknown: boolean;
  allKnown: SurfaceBounds;
  groups: SurfaceGroup[];
};

type SceneCandidate =
  | { kind: 'bvh'; bvh: MeshBVH; inverse: T.Matrix4 }
  | { kind: 'box'; world: T.Box3 }
  | { kind: 'all' };

const UNIT_SCALE = new T.Vector3(1, 1, 1);

export class RigidToolQueryBounds {
  private tools = new WeakMap<RAPIER.Collider[], ToolBounds>();
  private meshes = new WeakMap<RAPIER.Collider, { shape: RAPIER.Shape; bvh: MeshBVH }>();
  private scratchStart = new T.Matrix4();
  private scratchEnd = new T.Matrix4();
  private scratchDelta = new T.Vector3();
  private scratchWhole = new T.Box3();
  private scratchBoxA = new T.Box3();
  private scratchBoxB = new T.Box3();
  private scratchLocal = new T.Box3();
  private scratchCenter = new T.Vector3();
  private scratchHalf = new T.Vector3();
  private scratchExpand = new T.Vector3();
  private scratchPos = new T.Vector3();
  private scratchQuat = new T.Quaternion();
  private retained = new Set<RAPIER.Collider>();

  constructor(private R: typeof RAPIER) {}

  private shapeBox(shape: RAPIER.Shape) {
    if (shape instanceof this.R.Cuboid || shape instanceof this.R.RoundCuboid) {
      const h = shape.halfExtents;
      const box = new T.Box3(new T.Vector3(-h.x, -h.y, -h.z), new T.Vector3(h.x, h.y, h.z));
      return shape instanceof this.R.RoundCuboid ? box.expandByScalar(shape.borderRadius) : box;
    }
    if (shape instanceof this.R.Ball) return new T.Box3(new T.Vector3().setScalar(-shape.radius), new T.Vector3().setScalar(shape.radius));
    if (shape instanceof this.R.ConvexPolyhedron || shape instanceof this.R.RoundConvexPolyhedron) {
      const box = new T.Box3(), vertex = new T.Vector3();
      for (let i = 0; i < shape.vertices.length; i += 3) box.expandByPoint(vertex.fromArray(shape.vertices, i));
      return shape instanceof this.R.RoundConvexPolyhedron ? box.expandByScalar(shape.borderRadius) : box;
    }
    if (shape instanceof this.R.Triangle || shape instanceof this.R.RoundTriangle) {
      const box = new T.Box3().setFromPoints([shape.a, shape.b, shape.c].map(v => new T.Vector3(v.x, v.y, v.z)));
      return shape instanceof this.R.RoundTriangle ? box.expandByScalar(shape.borderRadius) : box;
    }
    return null;
  }

  private toolBounds(parts: RAPIER.Collider[]) {
    const cached = this.tools.get(parts);
    if (cached && cached.parts.size === parts.length && parts.every(part => cached.shapes.get(part) === part.shape)) return cached;
    const result: ToolBounds = {
      box: new T.Box3(),
      radius: 0,
      parts: new Set(parts),
      shapes: new Map(),
      regular: [],
      groups: [],
      regularBounds: new Map(),
      hasUnknown: false,
      allKnown: { box: new T.Box3(), radius: 0 },
    };
    for (const part of parts) {
      const shape = part.shape;
      result.shapes.set(part, shape);
      if (!(shape instanceof this.R.Triangle)) {
        result.regular.push(part);
        const box = this.shapeBox(shape);
        if (box) {
          const radius = Math.hypot(
            Math.max(Math.abs(box.min.x), Math.abs(box.max.x)),
            Math.max(Math.abs(box.min.y), Math.abs(box.max.y)),
            Math.max(Math.abs(box.min.z), Math.abs(box.max.z)),
          );
          result.regularBounds.set(part, { box, radius });
          result.allKnown.box.union(box);
          result.allKnown.radius = Math.max(result.allKnown.radius, radius);
        } else {
          result.hasUnknown = true;
        }
        continue;
      }
      const points = [shape.a, shape.b, shape.c].map(p => new T.Vector3(p.x, p.y, p.z));
      const leaf = { part, box: new T.Box3().setFromPoints(points), radius: Math.max(...points.map(p => p.length())) };
      let group = result.groups.at(-1);
      if (!group || group.leaves.length === 32) {
        group = { box: new T.Box3(), radius: 0, leaves: [] };
        result.groups.push(group);
      }
      group.leaves.push(leaf);
      group.box.union(leaf.box); group.radius = Math.max(group.radius, leaf.radius);
      result.box.union(leaf.box); result.radius = Math.max(result.radius, leaf.radius);
    }
    result.allKnown.box.union(result.box);
    result.allKnown.radius = Math.max(result.allKnown.radius, result.radius);
    this.tools.set(parts, result);
    return result;
  }

  private testCandidate(cand: SceneCandidate, query: T.Box3): boolean {
    if (cand.kind === 'all') return true;
    if (cand.kind === 'box') return cand.world.intersectsBox(query);
    const local = this.scratchLocal.copy(query).applyMatrix4(cand.inverse);
    return cand.bvh.shapecast({
      intersectsBounds: bounds => bounds.intersectsBox(local),
      intersectsTriangle: triangle => local.intersectsTriangle(triangle),
    });
  }

  select(scene: RAPIER.World, parts: RAPIER.Collider[], from: T.Vector3, fromQ: T.Quaternion, to: T.Vector3, toQ: T.Quaternion,
    filter: number, external: (collider: RAPIER.Collider) => boolean,
    yawPath?: { angle: number; chordError: number }): RAPIER.Collider[] {
    const tool = this.toolBounds(parts);
    if (tool.allKnown.box.isEmpty()) return parts;
    const angle = fromQ.angleTo(toQ);
    const transform = this.scratchStart.compose(from, fromQ, UNIT_SCALE);
    const delta = this.scratchDelta.copy(to).sub(from);
    const endTransform = yawPath ? this.scratchEnd.compose(to, toQ, UNIT_SCALE) : null;

    const writeSwept = (out: T.Box3, bounds: SurfaceBounds) => {
      out.copy(bounds.box).applyMatrix4(transform);
      if (yawPath && endTransform) {
        // Enclose both actual endpoints. Between them each vertex follows
        // a yaw arc plus linear translation, with chord error <= r*angle²/8.
        out.union(this.scratchBoxB.copy(bounds.box).applyMatrix4(endTransform));
        const horizontal = .0030001 + bounds.radius * Math.min(2, yawPath.angle ** 2 / 8) + yawPath.chordError;
        return out.expandByVector(this.scratchExpand.set(horizontal, .0030001, horizontal));
      }
      out.union(this.scratchBoxB.copy(out).translate(delta));
      return out.expandByScalar(.0030001 + bounds.radius * angle);
    };

    const whole = writeSwept(this.scratchWhole, tool.allKnown);
    const candidates: SceneCandidate[] = [];
    scene.collidersWithAabbIntersectingAabb(
      whole.getCenter(this.scratchCenter),
      whole.getSize(this.scratchHalf).multiplyScalar(.5),
      collider => {
        if (tool.parts.has(collider)) return true;
        const group = collider.collisionGroups();
        if (!external(collider) || !((filter >>> 16) & (group & 65535)) || !((group >>> 16) & (filter & 65535))) return true;
        const shape = collider.shape, p = collider.translation(), q = collider.rotation();
        const matrix = new T.Matrix4().compose(this.scratchPos.set(p.x, p.y, p.z), this.scratchQuat.set(q.x, q.y, q.z, q.w), UNIT_SCALE);
        if (shape instanceof this.R.TriMesh) {
          let cached = this.meshes.get(collider);
          if (!cached || cached.shape !== shape) {
            const geometry = new T.BufferGeometry();
            // The installed BVH reorders indices while building. Give it owned
            // buffers so native collision/query geometry is never mutated.
            geometry.setAttribute('position', new T.BufferAttribute(shape.vertices.slice(), 3));
            geometry.setIndex(new T.BufferAttribute(shape.indices.slice(), 1));
            cached = { shape, bvh: new MeshBVH(geometry) };
            this.meshes.set(collider, cached);
          }
          const cand: SceneCandidate = { kind: 'bvh', bvh: cached.bvh, inverse: matrix.invert() };
          if (this.testCandidate(cand, whole)) candidates.push(cand);
        } else {
          const box = this.shapeBox(shape);
          candidates.push(box ? { kind: 'box', world: box.applyMatrix4(matrix) } : { kind: 'all' });
        }
        return true;
      },
    );

    if (!candidates.length && !tool.hasUnknown) return parts.slice(0, 0);

    const retained = this.retained;
    retained.clear();
    for (const part of tool.regular) {
      const bounds = tool.regularBounds.get(part);
      if (!bounds) retained.add(part);
      else if (candidates.length) {
        const box = writeSwept(this.scratchBoxA, bounds);
        for (let i = 0; i < candidates.length; i++) {
          if (this.testCandidate(candidates[i], box)) { retained.add(part); break; }
        }
      }
    }
    if (candidates.length && tool.groups.length) {
      const nearby: SceneCandidate[] = [];
      for (const group of tool.groups) {
        nearby.length = 0;
        const gBox = writeSwept(this.scratchBoxA, group);
        for (let i = 0; i < candidates.length; i++) {
          if (this.testCandidate(candidates[i], gBox)) nearby.push(candidates[i]);
        }
        if (!nearby.length) continue;
        for (const leaf of group.leaves) {
          const lBox = writeSwept(this.scratchBoxA, leaf);
          for (let i = 0; i < nearby.length; i++) {
            if (this.testCandidate(nearby[i], lBox)) { retained.add(leaf.part); break; }
          }
        }
      }
    }
    if (!retained.size) return parts.slice(0, 0);
    // Retain source order and realm constructor: native tie-breaking must not change.
    return parts.filter(part => retained.has(part));
  }
}
