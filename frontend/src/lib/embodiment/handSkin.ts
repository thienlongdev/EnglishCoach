import * as T from 'three';

export interface SurfaceJoint { bone: T.Bone; rest: T.Quaternion; finger: number; joint: number }
export interface SkinProbe { index: number; pad: boolean }
interface JointFrame {
  index: number; parent: number; base: T.Matrix4; position: T.Vector3;
  scale: T.Vector3; rest: T.Quaternion; finger: number; joint: number;
}
export interface HandSkinData {
  side: number; groups: SkinProbe[][]; vertices: number[]; handVertices: number[]; triangles: Uint32Array;
  frames: { index: number; parent: number; base: number[]; position: number[]; scale: number[]; rest: number[]; finger: number; joint: number }[];
  relative: number[][]; bindPoints: Float64Array; indices: Uint16Array; weights: Float64Array; bridge: number[]; finalTranslation: number[];
}
type SkinAttributes = Pick<HandSkinData, 'groups' | 'vertices' | 'handVertices' | 'triangles' | 'bindPoints' | 'indices' | 'weights'>;
const attributes = new WeakMap<T.Skeleton, WeakMap<T.BufferGeometry, Map<number, SkinAttributes>>>();

/** A numerical snapshot of the existing skinned hand, not another rendered rig.
 * Candidate search never writes the live skeleton. Inverse-bind terms are
 * factored once; each candidate updates just three joint matrices. */
export class HandSkin {
  readonly groups: SkinProbe[][] = Array.from({ length: 5 }, () => []);
  readonly vertices: number[] = [];
  readonly handVertices: number[] = [];
  readonly triangles: Uint32Array;
  private readonly side: number;
  private readonly frames: JointFrame[];
  private readonly relative: T.Matrix4[];
  private readonly deformed: T.Matrix4[];
  private readonly bindPoints: Float64Array;
  private readonly indices: Uint16Array;
  private readonly weights: Float64Array;
  private readonly bridge: T.Matrix4;
  private readonly finalTranslation: T.Vector3;
  private readonly local = new T.Matrix4();
  private readonly q = new T.Quaternion();
  private readonly rotation = new T.Quaternion();
  private readonly euler = new T.Euler();

  constructor(data: HandSkinData);
  constructor(mesh: T.SkinnedMesh, hand: T.Bone, joints: SurfaceJoint[], side: number);
  constructor(source: T.SkinnedMesh | HandSkinData, hand?: T.Bone, joints: SurfaceJoint[] = [], side = 1) {
    if (!('isSkinnedMesh' in source)) {
      this.side = source.side;
      source.groups.forEach((g, i) => this.groups[i].push(...g));
      this.vertices.push(...source.vertices); this.handVertices.push(...source.handVertices); this.triangles = source.triangles;
      this.frames = source.frames.map(f => ({ ...f, base: new T.Matrix4().fromArray(f.base), position: new T.Vector3().fromArray(f.position), scale: new T.Vector3().fromArray(f.scale), rest: new T.Quaternion().fromArray(f.rest) }));
      this.relative = source.relative.map(m => new T.Matrix4().fromArray(m));
      this.bridge = new T.Matrix4().fromArray(source.bridge);
      this.finalTranslation = new T.Vector3().fromArray(source.finalTranslation);
      this.deformed = this.relative.map(m => this.bridge.clone().multiply(m));
      this.bindPoints = source.bindPoints; this.indices = source.indices; this.weights = source.weights;
      return;
    }
    const mesh = source; if (!hand) throw new Error('Hand required for a skin snapshot');
    this.side = side;
    hand.updateWorldMatrix(true, true);
    mesh.updateWorldMatrix(true, false);
    const inverse = hand.matrixWorld.clone().invert();
    this.relative = mesh.skeleton.bones.map(b => inverse.clone().multiply(b.matrixWorld));
    // Preserve Three's bind-mode semantics, including model scale and parents.
    const afterSkin = inverse.clone().multiply(mesh.matrixWorld).multiply(mesh.bindMatrixInverse);
    this.finalTranslation = new T.Vector3().setFromMatrixPosition(afterSkin);
    this.bridge = afterSkin.multiply(hand.matrixWorld);
    this.deformed = this.relative.map(m => this.bridge.clone().multiply(m));
    this.frames = joints.map(j => {
      const index = mesh.skeleton.bones.indexOf(j.bone);
      const parent = mesh.skeleton.bones.indexOf(j.bone.parent as T.Bone);
      return { index, parent, base: j.bone.parent ? inverse.clone().multiply(j.bone.parent.matrixWorld) : inverse.clone(),
        position: j.bone.position.clone(), scale: j.bone.scale.clone(), rest: j.rest.clone(), finger: j.finger, joint: j.joint };
    }).sort((a, b) => a.joint - b.joint);
    if (this.frames.some(f => f.index < 0)) throw new Error('Finger joint is outside the skin skeleton');
    let byGeometry = attributes.get(mesh.skeleton);
    if (!byGeometry) { byGeometry = new WeakMap(); attributes.set(mesh.skeleton, byGeometry); }
    let bySide = byGeometry.get(mesh.geometry);
    if (!bySide) { bySide = new Map(); byGeometry.set(mesh.geometry, bySide); }
    const cached = bySide.get(side);
    if (cached) {
      cached.groups.forEach((g, i) => this.groups[i].push(...g));
      this.vertices.push(...cached.vertices); this.handVertices.push(...cached.handVertices);
      this.triangles = cached.triangles; this.bindPoints = cached.bindPoints; this.indices = cached.indices; this.weights = cached.weights;
      return;
    }
    const ps = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    this.bindPoints = new Float64Array(ps.count * 12);
    this.indices = new Uint16Array(ps.count * 4);
    this.weights = new Float64Array(ps.count * 4);
    const p = new T.Vector3(), bound = new T.Vector3(), seen = new Set<string>();
    for (let i = 0; i < ps.count; i++) {
      const total = [0, 0, 0, 0, 0], pads = [0, 0, 0, 0, 0]; let belongs = false;
      bound.fromBufferAttribute(ps as T.BufferAttribute, i).applyMatrix4(mesh.bindMatrix);
      for (let k = 0; k < 4; k++) {
        const bone = si.getComponent(i, k), weight = sw.getComponent(i, k), at = i * 4 + k;
        this.indices[at] = bone; this.weights[at] = weight;
        if (!weight) continue;
        const skinBone = mesh.skeleton.bones[bone];
        if (String(skinBone.userData.name ?? skinBone.name).endsWith(side > 0 ? '.R' : '.L')) belongs = true;
        p.copy(bound).applyMatrix4(mesh.skeleton.boneInverses[bone]);
        this.bindPoints.set(p.toArray(), at * 3);
        const f = this.frames.find(f => f.index === bone);
        if (f) { total[f.finger] += weight; if (f.joint === 2) pads[f.finger] += weight; }
      }
      if (belongs) this.handVertices.push(i);
      const key = [ps.getX(i), ps.getY(i), ps.getZ(i), ...Array.from(this.indices.subarray(i * 4, i * 4 + 4)), ...Array.from(this.weights.subarray(i * 4, i * 4 + 4))].join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      if (total.some(v => v > 0)) this.vertices.push(i);
      // Include every affected vertex, even low-weight webbing at a knuckle.
      total.forEach((v, finger) => { if (v > 0) this.groups[finger].push({ index: i, pad: pads[finger] > .5 }); });
    }
    const members = new Set(this.handVertices), triangles: number[] = [], index = mesh.geometry.index;
    for (let i = 0; i < (index?.count ?? ps.count); i += 3) {
      const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
      if (members.has(a) || members.has(b) || members.has(c)) triangles.push(a, b, c);
    }
    this.triangles = new Uint32Array(triangles);
    bySide.set(side, { groups: this.groups, vertices: this.vertices, handVertices: this.handVertices, triangles: this.triangles,
      bindPoints: this.bindPoints, indices: this.indices, weights: this.weights });
  }

  serialize(): HandSkinData {
    return { side: this.side, groups: this.groups, vertices: this.vertices, handVertices: this.handVertices, triangles: this.triangles,
      frames: this.frames.map(f => ({ ...f, base: f.base.toArray(), position: f.position.toArray(), scale: f.scale.toArray(), rest: f.rest.toArray() })),
      relative: this.relative.map(m => m.toArray()), bindPoints: this.bindPoints, indices: this.indices, weights: this.weights,
      bridge: this.bridge.toArray(), finalTranslation: this.finalTranslation.toArray() };
  }

  geometry() {
    const geometry = new T.BufferGeometry(), positions = new Float32Array(this.triangles.length * 3), p = new T.Vector3();
    this.triangles.forEach((v, i) => { this.point(v, p).toArray(positions, i * 3); });
    geometry.setAttribute('position', new T.BufferAttribute(positions, 3));
    geometry.setIndex(Array.from({ length: this.triangles.length }, (_, i) => i));
    return geometry;
  }

  setFinger(finger: number, angles: number[]) {
    for (const f of this.frames) {
      if (f.finger !== finger) continue;
      this.euler.set(angles[f.joint], f.joint === 0 ? (angles[4] ?? 0) * this.side : 0, f.joint === 0 ? -angles[3] * this.side : 0);
      this.q.copy(f.rest).multiply(this.rotation.setFromEuler(this.euler));
      this.local.compose(f.position, this.q, f.scale);
      this.relative[f.index].multiplyMatrices(f.parent >= 0 ? this.relative[f.parent] : f.base, this.local);
      this.deformed[f.index].multiplyMatrices(this.bridge, this.relative[f.index]);
    }
  }

  /** Exact linear blend skinning, expressed in the captured hand frame. */
  point(index: number, out: T.Vector3) {
    let x = 0, y = 0, z = 0, weight = 0;
    for (let k = 0; k < 4; k++) {
      const at = index * 4 + k, w = this.weights[at]; if (!w) continue;
      weight += w;
      const m = this.deformed[this.indices[at]].elements, j = at * 3;
      const px = this.bindPoints[j], py = this.bindPoints[j + 1], pz = this.bindPoints[j + 2];
      x += (m[0] * px + m[4] * py + m[8] * pz + m[12]) * w;
      y += (m[1] * px + m[5] * py + m[9] * pz + m[13]) * w;
      z += (m[2] * px + m[6] * py + m[10] * pz + m[14]) * w;
    }
    // Three applies bindMatrixInverse to Vector3 (homogeneous w=1), even if
    // exported Float32 weights sum to 1 +/- a rounding error.
    return out.set(x, y, z).addScaledVector(this.finalTranslation, 1 - weight);
  }
}
