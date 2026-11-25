/* A tiny mesh kit: merges transformed three.js primitives into flat arrays with per-vertex colour, a tint mask and an
   emissive weight. Works in a worker and on the main thread. */
import * as THREE from 'three';

export interface MeshArrays { position: Float32Array; normal: Float32Array; color: Float32Array; tint: Float32Array; glow: Float32Array; index: Uint32Array }

const tmpN = new THREE.Matrix3(), v = new THREE.Vector3(), n = new THREE.Vector3(), c = new THREE.Color();

export class Kit {
  pos: number[] = []; nor: number[] = []; col: number[] = []; tint: number[] = []; glow: number[] = []; idx: number[] = [];
  /** colour: sRGB hex; tint 1 = takes the instance colour (canopy, roof); glow 0..1 = emissive weight. */
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, color: string | [number, number, number], tint = 0, glow = 0, shadeY?: [number, number]) {
    const p = geometry.getAttribute('position'), nn = geometry.getAttribute('normal');
    if (Array.isArray(color)) c.setRGB(color[0], color[1], color[2]); else c.set(color); // set() converts sRGB → linear
    tmpN.getNormalMatrix(matrix);
    const base = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const y = v.y;
      v.applyMatrix4(matrix);
      n.fromBufferAttribute(nn, i).applyMatrix3(tmpN).normalize();
      this.pos.push(v.x, v.y, v.z); this.nor.push(n.x, n.y, n.z);
      // Optional vertical shading (canopy self-occlusion): darker underneath.
      const s = shadeY ? THREE.MathUtils.lerp(shadeY[0], 1, THREE.MathUtils.clamp((y - shadeY[1]) / Math.max(1e-3, -shadeY[1] * 2), 0, 1)) : 1;
      this.col.push(c.r * s, c.g * s, c.b * s); this.tint.push(tint); this.glow.push(glow);
    }
    const index = geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    geometry.dispose();
    return this;
  }
  get vertexCount() { return this.pos.length / 3; }
  arrays(): MeshArrays {
    return { position: new Float32Array(this.pos), normal: new Float32Array(this.nor), color: new Float32Array(this.col),
      tint: new Float32Array(this.tint), glow: new Float32Array(this.glow), index: new Uint32Array(this.idx) };
  }
}

export const M = () => new THREE.Matrix4();
const q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), t = new THREE.Vector3();
/** Compose a matrix: position, Euler rotation (radians), scale. */
export function T(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(t.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s.set(sx, sy, sz));
}
export const mul = (a: THREE.Matrix4, b: THREE.Matrix4) => new THREE.Matrix4().multiplyMatrices(a, b);

/** Lumpy blob (a canopy, a cloud, a boulder): an icosphere with its vertices pushed by a small hash noise. */
export function blob(detail: number, amount: number, seed: number) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position');
  const key = (x: number, y: number, z: number) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
  const offsets = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = key(x, y, z);
    let o = offsets.get(k);
    if (o === undefined) { const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453; o = 1 + (h - Math.floor(h) - 0.5) * amount; offsets.set(k, o); }
    p.setXYZ(i, x * o, y * o, z * o);
  }
  const merged = mergeByPosition(g); merged.computeVertexNormals(); return merged;
}

/** Weld vertices that share a position, so a displaced icosphere shades smoothly. */
export function mergeByPosition(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position'), map = new Map<string, number>(), pos: number[] = [], idx: number[] = [];
  const src = g.getIndex();
  const get = (i: number) => {
    const k = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    let id = map.get(k); if (id === undefined) { id = pos.length / 3; pos.push(p.getX(i), p.getY(i), p.getZ(i)); map.set(k, id); }
    return id;
  };
  const count = src ? src.count : p.count;
  for (let i = 0; i < count; i++) idx.push(get(src ? src.getX(i) : i));
  g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setIndex(idx);
  return out;
}

/** A gable roof prism (ridge along X), base centred at the origin, width w (x), depth d (z), height h. */
export function gableRoof(w: number, d: number, h: number, overhang = 0.12) {
  const x = w / 2 + overhang, z = d / 2 + overhang;
  const verts = [
    // two slopes
    -x, 0, z,  x, 0, z,  x, h, 0,  -x, 0, z,  x, h, 0,  -x, h, 0,
    x, 0, -z,  -x, 0, -z,  -x, h, 0,  x, 0, -z,  -x, h, 0,  x, h, 0,
    // gables
    x, 0, z,  x, 0, -z,  x, h, 0,
    -x, 0, -z,  -x, 0, z,  -x, h, 0,
    // underside
    -x, 0, z,  -x, 0, -z,  x, 0, -z,  -x, 0, z,  x, 0, -z,  x, 0, z,
  ];
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); g.computeVertexNormals();
  return g;
}

/** A pagoda-style curved roof: a flattened pyramid whose corners lift. */
export function curvedRoof(w: number, h: number, lift = 0.35) {
  const g = new THREE.CylinderGeometry(0.06, w * 0.75, h, 4, 3, false); g.rotateY(Math.PI / 4);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), r = Math.hypot(x, z);
    const corner = Math.pow(Math.abs(Math.cos(2 * Math.atan2(z, x))), 6);
    p.setY(i, y + corner * lift * Math.pow(r / (w * 0.75), 2) - (1 - y / h - 0.5) * 0.0);
  }
  g.computeVertexNormals(); return g;
}
