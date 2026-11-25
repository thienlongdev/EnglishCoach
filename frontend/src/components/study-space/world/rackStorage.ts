import * as T from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

export interface RackStorage {
  frame: T.Matrix4;
  inverse: T.Matrix4;
  scale: number;
  rotation: T.Quaternion;
  collar: { center: [number, number, number]; size: [number, number, number] };
  guide: { innerHalfX: number; innerHalfZ: number; height: number; wall: number; frontHalfGap: number };
  slots: { kind: string; position: [number, number, number]; bearingY: number; guideTopY: number }[];
  parts: { descriptor: RAPIER.ColliderDesc; slot: number; role: 'bearing' | 'guide' | 'mount' }[];
  handles: Map<number, Set<number>>;
}

const KINDS = ['tool.broom', 'tool.webbrush', 'tool.mop'];
const triple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x));

/** Only the generated, geometrically checked visible cuboids qualify. Unknown
 * art falls back to the complete existing collision path, never missing parts. */
export function rackStorageSurface(R: typeof RAPIER, root: T.Object3D, toStage: T.Matrix4): RackStorage | null {
  let source: T.Object3D | null = null;
  root.traverse(o => { if (o.userData.rackStorage) source = o; });
  if (!source) return null;
  const art = source as T.Object3D, data = art.userData.rackStorage;
  try {
    if (data.version !== 1 || !triple(data.collar?.center) || !triple(data.collar?.size) || data.collar.size.some((x: number) => x <= 0)
      || data.slots?.length !== 3 || data.guidePhysics?.motors !== false || data.guidePhysics?.verticalLimits !== null
      || JSON.stringify(data.guidePhysics?.translationAxis) !== '[0,1,0]') return null;
    const guide = data.guide;
    if (!guide || ![guide.innerHalfX, guide.innerHalfZ, guide.height, guide.wall, guide.frontHalfGap].every(x => Number.isFinite(x) && x > 0)
      || guide.frontHalfGap >= guide.innerHalfX
      || guide.innerHalfX <= data.collar.size[0] / 2 || guide.innerHalfZ <= data.collar.size[2] / 2
      || guide.innerHalfX - data.collar.size[0] / 2 > .002 || guide.innerHalfZ - data.collar.size[2] / 2 > .002) return null;
    const slots: RackStorage['slots'] = data.slots;
    if (slots.some((s, i) => s.kind !== KINDS[i] || !triple(s.position) || !Number.isFinite(s.bearingY) || !Number.isFinite(s.guideTopY)
      || Math.abs(s.guideTopY - s.bearingY - guide.height) > 1e-8)) return null;
    art.updateWorldMatrix(true, true);
    const frame = toStage.clone().multiply(art.matrixWorld), at = new T.Vector3(), rotation = new T.Quaternion(), scale = new T.Vector3();
    frame.decompose(at, rotation, scale);
    if (scale.x <= 0 || Math.abs(scale.x - scale.y) + Math.abs(scale.x - scale.z) > 1e-8
      || frame.elements.some((v, i) => Math.abs(v - new T.Matrix4().compose(at, rotation, scale).elements[i]) > 1e-8)) return null;
    const result: RackStorage = { frame, inverse: frame.clone().invert(), scale: scale.x, rotation, collar: data.collar, guide, slots, parts: [], handles: new Map() };
    const matchedGuides = new Set<string>();
    root.traverse(o => {
      if (o.userData.rackStoragePart !== 1) return;
      const mesh = o as T.Mesh, role = o.userData.rackStorageRole, slot = o.userData.rackStorageSlot, dimensions = o.userData.rackStorageSize;
      if (!mesh.isMesh || !['bearing', 'guide', 'mount'].includes(role) || !Number.isInteger(slot) || slot < 0 || slot >= 3 || !triple(dimensions)) throw Error('Invalid support part');
      const pos = mesh.geometry.getAttribute('position');
      if (!pos || pos.count !== 24 || mesh.geometry.index?.count !== 36) throw Error('Support must retain its authored cuboid');
      const box = new T.Box3().setFromBufferAttribute(pos as T.BufferAttribute), size = box.getSize(new T.Vector3());
      if (size.toArray().some((v, i) => Math.abs(v - dimensions[i]) > 1e-7)) throw Error('Support dimensions changed');
      for (let i = 0; i < pos.count; i++) for (let d = 0; d < 3; d++) {
        const v = pos.getComponent(i, d), lo = box.min.getComponent(d), hi = box.max.getComponent(d);
        if (Math.min(Math.abs(v - lo), Math.abs(v - hi)) > 1e-8) throw Error('Non-cuboid support');
      }
      const matrix = toStage.clone().multiply(mesh.matrixWorld), p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3();
      matrix.decompose(p, q, s);
      if (Math.min(s.x, s.y, s.z) <= 0 || matrix.elements.some((v, i) => Math.abs(v - new T.Matrix4().compose(p, q, s).elements[i]) > 1e-8)) throw Error('Invalid support transform');
      if (role === 'guide') {
        const local = box.clone().applyMatrix4(result.inverse.clone().multiply(matrix)), at = local.getCenter(new T.Vector3()), dimensions = local.getSize(new T.Vector3());
        const { innerHalfX: gx, innerHalfZ: gz, height, wall, frontHalfGap: gap } = guide, [x, , z] = slots[slot].position;
        const candidates = [[-gx-wall/2, 0, wall, (gz+wall)*2], [gx+wall/2, 0, wall, (gz+wall)*2], [0, -gz-wall/2, gx*2, wall], [-(gx+gap)/2, gz+wall/2, gx-gap, wall], [(gx+gap)/2, gz+wall/2, gx-gap, wall]];
        const index = candidates.findIndex(([dx, dz, w, d]) => at.distanceTo(new T.Vector3(x+dx, slots[slot].bearingY+height/2, z+dz)) < 1e-7 && dimensions.distanceTo(new T.Vector3(w,height,d)) < 1e-7);
        const key = `${slot}|${index}`;
        if (index < 0 || matchedGuides.has(key)) throw Error('Visible guide does not match its mechanical frame');
        matchedGuides.add(key);
      }
      p.copy(box.getCenter(new T.Vector3()).applyMatrix4(matrix));
      const half = size.multiply(s).multiplyScalar(.5);
      result.parts.push({ descriptor: R.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(p.x, p.y, p.z).setRotation(q), slot, role });
    });
    for (let slot = 0; slot < 3; slot++) for (const [role, count] of [['bearing', 2], ['guide', 5], ['mount', 1]] as const)
      if (result.parts.filter(p => p.slot === slot && p.role === role).length !== count) return null;
    return result;
  } catch { return null; }
}

/** Key point in the object's own frame; scale is applied by the physics owner. */
export function storageKey(root: T.Object3D): { center: T.Vector3; size: T.Vector3 } | null {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  let key: { center: T.Vector3; size: T.Vector3 } | null = null;
  root.traverse(o => {
    if (o.userData.rackStoragePart !== 1 || o.userData.rackStorageRole !== 'key' || !(o as T.Mesh).isMesh) return;
    const mesh = o as T.Mesh;
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!.clone().applyMatrix4(inverse.clone().multiply(mesh.matrixWorld));
    key = { center: box.getCenter(new T.Vector3()), size: box.getSize(new T.Vector3()) };
  });
  return key;
}
