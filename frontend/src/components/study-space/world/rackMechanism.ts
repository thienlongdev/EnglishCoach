import * as T from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

type MeshData = { vertices: number[]; indices: number[] };
export type RackClipCache = {
  format: number; sourceSha256: string; originalTriangles: number; surfaceGap: number;
  fingers: { pivot: number[]; sourceVertices: number[][]; sourceFaces: number[][]; parts: MeshData[] }[];
};
const definitions = new Map<string, RackClipCache>();
const V = () => new T.Vector3();
const UP = new T.Vector3(0, 1, 0);

/** Split the eight authored fingers, keeping their actual triangles, normals
 * and UVs. This runs once on the source asset, before any scene clones exist.
 * The hash-bound offline decomposition supplies collision faces, not motion. */
export function prepareRackAsset(root: T.Object3D, cache: RackClipCache, sourceHash: string) {
  if (cache.format !== 1 || cache.sourceSha256 !== sourceHash || cache.originalTriangles !== 1396
    || cache.fingers.length !== 8 || !(cache.surfaceGap >= 0 && cache.surfaceGap < .00001)) throw new Error('Invalid rack cache');
  let clips: T.Mesh | null = null;
  root.traverse(o => { if ((o as T.Mesh).isMesh && (o.userData.name ?? o.name) === 'Clips') clips = o as T.Mesh; });
  if (!clips) throw new Error('Rack has no authored clips');
  const mesh = clips as T.Mesh, geometry = mesh.geometry, position = geometry.getAttribute('position'), index = geometry.index;
  root.updateWorldMatrix(true, true);
  const toRoot = root.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
  const points = Array.from({ length: position.count }, (_, i) => V().fromBufferAttribute(position, i).applyMatrix4(toRoot));
  const faces = Array.from({ length: (index?.count ?? position.count) / 3 }, (_, i) => [0, 1, 2].map(j => index ? index.getX(i * 3 + j) : i * 3 + j));
  const ownership = new Map<number, number>(), prepared: T.Mesh[] = [];
  const subset = (selected: number[]) => {
    const next = new T.BufferGeometry();
    for (const [name, attr] of Object.entries(geometry.attributes)) {
      const values: number[] = [];
      for (const face of selected) for (const i of faces[face]) for (let j = 0; j < attr.itemSize; j++) values.push(attr.getComponent(i, j));
      next.setAttribute(name, new T.Float32BufferAttribute(values, attr.itemSize));
    }
    return next;
  };
  try {
    cache.fingers.forEach((finger, f) => {
      if (finger.pivot.length !== 3 || !finger.pivot.every(Number.isFinite) || finger.sourceFaces.length !== 44 || !finger.parts.length) throw new Error('Invalid rack finger');
      const pivot = new T.Vector3(...finger.pivot as [number, number, number]);
      const source = finger.sourceVertices.map(p => new T.Vector3(...p as [number, number, number]).add(pivot));
      const selected: number[] = [];
      for (const face of finger.sourceFaces) {
        const found = faces.findIndex((actual, i) => !ownership.has(i) && actual.every((v, j) => points[v].distanceTo(source[face[j]]) < 1e-7));
        if (found < 0) throw new Error('Rack drawing/cache mismatch');
        ownership.set(found, f); selected.push(found);
      }
      for (const part of finger.parts) if (!part.vertices.length || part.vertices.length % 3 || !part.vertices.every(Number.isFinite)
        || !part.indices.length || part.indices.length % 3 || !part.indices.every(i => Number.isInteger(i) && i >= 0 && i < part.vertices.length / 3)) throw new Error('Invalid rack convex faces');
      const moving = new T.Mesh(subset(selected).applyMatrix4(toRoot).translate(-pivot.x, -pivot.y, -pivot.z), mesh.material);
      moving.name = `RackFinger.${f}`; moving.userData.rackFinger = f; moving.position.copy(pivot);
      moving.castShadow = mesh.castShadow; moving.receiveShadow = mesh.receiveShadow; prepared.push(moving);
    });
    const hook = faces.map((_, i) => i).filter(i => !ownership.has(i));
    if (hook.length !== 108 || ownership.size !== 352) throw new Error('Incomplete rack triangle ownership');
    mesh.geometry = subset(hook);
    for (const moving of prepared) root.add(moving);
    root.userData.rackClipSource = sourceHash; definitions.set(sourceHash, cache);
    geometry.dispose();
  } catch (error) { for (const moving of prepared) moving.geometry.dispose(); throw error; }
}

export function clearRackAssets() { definitions.clear(); }

export interface RackMechanism {
  colliders: RAPIER.Collider[];
  fingers: { body: RAPIER.RigidBody; joint: RAPIER.RevoluteImpulseJoint; colliders: RAPIER.Collider[] }[];
  awake(): boolean;
  beforeStep(): void;
  draw(alpha: number): void;
  dispose(): void;
}

/** The same Rapier world owns fixed surfaces, eight spring hinges and tools.
 * Material coefficients retain the measured offline candidate; they are an
 * explicit approximation, not a claim of calibrated elastomer mechanics. */
export function createRackMechanism(R: typeof RAPIER, world: RAPIER.World, root: T.Object3D, toStage: T.Matrix4): RackMechanism | null {
  let source: T.Object3D | null = null;
  root.traverse(o => { if (o.userData.rackClipSource) source = o; });
  if (!source) return null;
  const art = source as T.Object3D, cache = definitions.get(art.userData.rackClipSource);
  if (!cache) return null;
  art.updateWorldMatrix(true, true);
  const matrix = toStage.clone().multiply(art.matrixWorld), origin = V(), rotation = new T.Quaternion(), scale = V();
  matrix.decompose(origin, rotation, scale);
  const rebuilt = new T.Matrix4().compose(origin, rotation, scale);
  if (!(scale.x > 0) || Math.abs(scale.x - scale.y) + Math.abs(scale.x - scale.z) > 1e-8
    || matrix.elements.some((v, i) => Math.abs(v - rebuilt.elements[i]) > 1e-8)) return null;
  const nodes = new Map<number, T.Object3D>();
  art.traverse(o => { if (Number.isInteger(o.userData.rackFinger)) nodes.set(o.userData.rackFinger, o); });
  if (nodes.size !== 8) return null;
  const base = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(origin.x, origin.y, origin.z).setRotation(rotation));
  const fingers: RackMechanism['fingers'] = [], drawing: { node: T.Object3D; body: RAPIER.RigidBody; prevP: T.Vector3; prevQ: T.Quaternion }[] = [];
  const colliders: RAPIER.Collider[] = [], bodies: RAPIER.RigidBody[] = [];
  const s = scale.x;
  try {
    cache.fingers.forEach((finger, f) => {
      const pivot = new T.Vector3(...finger.pivot as [number, number, number]).multiplyScalar(s);
      const at = pivot.clone().applyQuaternion(rotation).add(origin);
      const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z).setRotation(rotation)
        .setLinearDamping(.2).setAngularDamping(.2).setCcdEnabled(true)); bodies.push(body);
      const points = finger.sourceVertices.map(p => new T.Vector3(...p as [number, number, number]).multiplyScalar(s));
      const com = points.reduce((v, p) => v.add(p), V()).multiplyScalar(1 / points.length), size = new T.Box3().setFromPoints(points).getSize(V()), kg = .012 * s ** 3;
      const inertia = new T.Vector3(kg * (size.y ** 2 + size.z ** 2) / 12, kg * (size.x ** 2 + size.z ** 2) / 12, kg * (size.x ** 2 + size.y ** 2) / 12);
      const owned = finger.parts.map((part, i) => {
        const desc = R.ColliderDesc.convexMesh(new Float32Array(part.vertices.map(v => v * s)), new Uint32Array(part.indices));
        if (!desc) throw new Error('Rack convex faces rejected');
        if (i === 0) desc.setMassProperties(kg, com, inertia, { x: 0, y: 0, z: 0, w: 1 }); else desc.setDensity(0);
        const c = world.createCollider(desc.setFriction(.4).setRestitution(0).setCollisionGroups((8 << 16) | 1 | 2 | 8), body);
        colliders.push(c); return c;
      });
      const joint = world.createImpulseJoint(R.JointData.revolute(pivot, V(), UP), base, body, true) as RAPIER.RevoluteImpulseJoint;
      const side = f % 2 ? 1 : -1;
      joint.setLimits(side < 0 ? -.35 : 0, side < 0 ? 0 : .35); joint.setContactsEnabled(true);
      joint.configureMotorModel(R.MotorModel.ForceBased); joint.configureMotorPosition(0, .15 * s ** 3, .003 * s ** 3);
      fingers.push({ body, joint, colliders: owned }); drawing.push({ node: nodes.get(f)!, body, prevP: at.clone(), prevQ: rotation.clone() });
    });
  } catch (error) { for (const body of bodies) world.removeRigidBody(body); world.removeRigidBody(base); throw error; }
  let disposed = false;
  return {
    colliders, fingers,
    awake: () => !disposed && fingers.some(f => !f.body.isSleeping()),
    beforeStep() { for (const d of drawing) { const p = d.body.translation(), q = d.body.rotation(); d.prevP.set(p.x, p.y, p.z); d.prevQ.set(q.x, q.y, q.z, q.w).normalize(); } },
    draw(alpha) {
      if (disposed) return;
      const inverse = matrix.clone().invert();
      for (const d of drawing) {
        const p = d.body.translation(), q = d.body.rotation();
        d.node.position.copy(d.prevP).lerp(new T.Vector3(p.x, p.y, p.z), alpha).applyMatrix4(inverse);
        d.node.quaternion.copy(rotation).invert().multiply(d.prevQ.clone().slerp(new T.Quaternion(q.x, q.y, q.z, q.w).normalize(), alpha)).normalize();
      }
      art.updateWorldMatrix(true, true);
    },
    dispose() {
      if (disposed) return; disposed = true;
      for (const f of fingers) { world.removeImpulseJoint(f.joint, false); world.removeRigidBody(f.body); }
      world.removeRigidBody(base);
      for (let i = 0; i < drawing.length; i++) { drawing[i].node.position.fromArray(cache.fingers[i].pivot); drawing[i].node.quaternion.identity(); }
      art.updateWorldMatrix(true, true);
    },
  };
}
