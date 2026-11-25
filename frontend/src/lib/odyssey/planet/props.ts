/* Instanced prop geometry for the Echo Living Planet. Each geometry carries:
   color (linear, fixed parts), aTint (1 = takes the instance colour: canopy, roof, rock), aGlow (emissive weight).
   Two levels of detail: 'hi' for close views, 'lo' (a fraction of the triangles) for the globe. */
import * as THREE from 'three';
import { Kit, T, blob, gableRoof } from './kit';
import type { PropKind } from './build';

const TRUNK = '#6b4a2e', TRUNK_DARK = '#4f3622', WHITE = '#ffffff', SNOW = '#f3f7fb', WALL = '#f3ead8', GRASS = '#5f9a45';

function finish(k: Kit) {
  const a = k.arrays(), g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(a.color, 3));
  g.setAttribute('aTint', new THREE.BufferAttribute(a.tint, 1));
  g.setAttribute('aGlow', new THREE.BufferAttribute(a.glow, 1));
  g.setIndex(new THREE.BufferAttribute(a.index, 1));
  g.computeBoundingSphere();
  return g;
}

function jaggedCone(radius: number, height: number, seg: number, rings: number, seed: number, jag: number) {
  const g = new THREE.ConeGeometry(radius, height, seg, rings);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y > height / 2 - 1e-3) continue;
    const h = Math.sin(x * 9.1 + y * 5.3 + z * 7.7 + seed) * 43758.5453, r = 1 + (h - Math.floor(h) - 0.5) * jag;
    p.setXYZ(i, x * r, y, z * r);
  }
  g.computeVertexNormals(); return g;
}

type Builder = (k: Kit, hi: boolean) => void;
const B: Record<PropKind, Builder> = {
  broad(k, hi) {
    k.add(new THREE.CylinderGeometry(0.07, 0.12, 0.75, hi ? 6 : 4), T(0, 0.37, 0), TRUNK);
    k.add(blob(hi ? 1 : 0, hi ? 0.32 : 0.18, 1.3), T(0, 1.08, 0, 0, 0, 0, 0.72, 0.62, 0.72), WHITE, 1, 0, [0.62, -0.6]);
    if (hi) {
      // A lobed crown: three smaller masses around the main one break the round silhouette.
      k.add(blob(1, 0.3, 4.1), T(0.28, 1.35, 0.12, 0, 0, 0, 0.42, 0.38, 0.42), WHITE, 1, 0, [0.72, -0.6]);
      k.add(blob(0, 0.26, 6.7), T(-0.3, 1.22, -0.16, 0, 0, 0, 0.38, 0.34, 0.38), WHITE, 1, 0, [0.7, -0.6]);
      k.add(blob(0, 0.24, 8.2), T(0.02, 1.5, -0.26, 0, 0, 0, 0.34, 0.3, 0.34), WHITE, 1, 0, [0.78, -0.6]);
      k.add(new THREE.CylinderGeometry(0.025, 0.04, 0.45, 4), T(0.14, 0.8, 0, 0, 0, -0.7), TRUNK);
    }
  },
  birch(k, hi) {
    // Pale trunk with dark marks and a light, airy crown.
    k.add(new THREE.CylinderGeometry(0.045, 0.06, 1.25, hi ? 6 : 4), T(0, 0.62, 0), '#ece6da');
    if (hi) for (const y of [0.35, 0.62, 0.9]) k.add(new THREE.CylinderGeometry(0.048, 0.05, 0.05, 6), T(0, y, 0), '#3a3530');
    k.add(blob(hi ? 1 : 0, 0.3, 2.9), T(0, 1.42, 0, 0, 0, 0, 0.42, 0.62, 0.42), WHITE, 1, 0, [0.7, -0.6]);
    if (hi) k.add(blob(0, 0.26, 5.5), T(0.12, 1.2, 0.1, 0, 0, 0, 0.3, 0.38, 0.3), WHITE, 1, 0, [0.72, -0.6]);
  },
  conifer(k, hi) {
    k.add(new THREE.CylinderGeometry(0.05, 0.08, 0.5, 4), T(0, 0.25, 0), TRUNK_DARK);
    const tiers = hi ? 4 : 1;
    for (let i = 0; i < tiers; i++) {
      const s = hi ? 1 - i * 0.2 : 1, y = hi ? 0.42 + i * 0.34 : 0.45;
      const g = hi ? jaggedCone(0.54 * s, 0.78 * s, 8, 1, i * 3.1, 0.22) : new THREE.ConeGeometry(0.52, 1.7, 5, 1);
      k.add(g, T(0, y + (hi ? 0.39 * s : 0.85), 0, 0, i * 0.7, 0), WHITE, 1, 0, [0.7, -0.4]);
    }
  },
  snowpine(k, hi) {
    k.add(new THREE.CylinderGeometry(0.05, 0.08, 0.45, 4), T(0, 0.22, 0), TRUNK_DARK);
    const tiers = hi ? 3 : 1;
    for (let i = 0; i < tiers; i++) {
      const s = hi ? 1 - i * 0.24 : 1, y = hi ? 0.4 + i * 0.4 : 0.4, h = hi ? 0.82 * s : 1.6;
      k.add(new THREE.ConeGeometry(0.5 * s, h, hi ? 7 : 5, 1), T(0, y + h / 2, 0), WHITE, 1, 0, [0.7, -0.4]);
      k.add(new THREE.ConeGeometry(0.3 * s, h * 0.45, hi ? 7 : 5, 1), T(0, y + h * 0.78, 0), SNOW);
    }
  },
  palm(k, hi) {
    const seg = hi ? 3 : 1;
    for (let i = 0; i < seg; i++) k.add(new THREE.CylinderGeometry(0.05, 0.065, 1.6 / seg, 5), T(0.06 * i * i, 0.8 / seg + i * 1.6 / seg, 0, 0, 0, -0.08 * i), '#8a6a45');
    const fronds = hi ? 7 : 4;
    for (let i = 0; i < fronds; i++) {
      const a = i / fronds * Math.PI * 2;
      k.add(new THREE.ConeGeometry(0.16, 1.15, 3, 1).scale(1, 1, 0.25), T(0.15 + Math.cos(a) * 0.45, 1.62, Math.sin(a) * 0.45, Math.sin(a) * 1.75, 0, -Math.cos(a) * 1.75), WHITE, 1);
    }
  },
  cypress(k, hi) {
    k.add(new THREE.CylinderGeometry(0.05, 0.07, 0.4, 4), T(0, 0.2, 0), TRUNK);
    k.add(blob(hi ? 1 : 0, 0.2, 2.7), T(0, 1.15, 0, 0, 0, 0, 0.32, 1.0, 0.32), WHITE, 1, 0, [0.7, -0.8]);
  },
  acacia(k, hi) {
    k.add(new THREE.CylinderGeometry(0.06, 0.1, 1.1, 5), T(0, 0.55, 0, 0, 0, 0.12), TRUNK);
    if (hi) { k.add(new THREE.CylinderGeometry(0.03, 0.05, 0.6, 4), T(-0.18, 1.0, 0, 0, 0, 0.7), TRUNK); k.add(new THREE.CylinderGeometry(0.03, 0.05, 0.6, 4), T(0.2, 1.05, 0.05, 0, 0, -0.6), TRUNK); }
    k.add(blob(hi ? 1 : 0, 0.25, 5.3), T(0.05, 1.32, 0, 0, 0, 0, 0.95, 0.22, 0.9), WHITE, 1, 0, [0.75, -0.25]);
  },
  willow(k, hi) {
    k.add(new THREE.CylinderGeometry(0.08, 0.13, 0.7, 5), T(0, 0.35, 0), TRUNK);
    k.add(blob(hi ? 1 : 0, 0.22, 6.4), T(0, 1.05, 0, 0, 0, 0, 0.8, 0.55, 0.8), WHITE, 1, 0, [0.7, -0.5]);
    k.add(new THREE.CylinderGeometry(0.72, 0.9, 0.75, hi ? 12 : 7, 1, true), T(0, 0.75, 0), WHITE, 1, 0, [0.55, -0.4]);
  },
  tuft(k) {
    // A clump of grass: a few narrow blades leaning out (tinted per instance).
    for (let i = 0; i < 5; i++) { const a = i * 1.26; k.add(new THREE.ConeGeometry(0.035, 0.34 + (i % 3) * 0.06, 3, 1, true), T(Math.cos(a) * 0.05, 0.17, Math.sin(a) * 0.05, Math.sin(a) * 0.28, 0, -Math.cos(a) * 0.28), WHITE, 1, 0, [0.55, 0]); }
  },
  flower(k) {
    // Stems and small blossoms: the tint colours the petals, the stems stay green.
    for (let i = 0; i < 2; i++) { const a = i * 2.6, x = Math.cos(a) * 0.06, z = Math.sin(a) * 0.06;
      k.add(new THREE.CylinderGeometry(0.008, 0.012, 0.28, 3, 1, true), T(x, 0.14, z), '#4f8a34');
      k.add(new THREE.OctahedronGeometry(0.05, 0), T(x, 0.3, z, 0, a, 0, 1, 0.55, 1), WHITE, 1, 0.12); }
    k.add(new THREE.ConeGeometry(0.06, 0.18, 4, 1, true), T(0, 0.09, 0), '#5f9a45');
  },
  bush(k, hi) {
    k.add(blob(hi ? 1 : 0, 0.3, 8.8), T(0, 0.22, 0, 0, 0, 0, 0.42, 0.3, 0.42), WHITE, 1, 0, [0.7, -0.5]);
  },
  peak(k, hi) {
    k.add(jaggedCone(1.35, 2.7, hi ? 8 : 5, hi ? 4 : 2, 3.1, 0.42), T(0, 1.35, 0), WHITE, 1);
    k.add(jaggedCone(0.62, 1.1, hi ? 8 : 5, 1, 7.7, 0.32), T(0, 2.16, 0), SNOW);
  },
  crag(k, hi) {
    k.add(jaggedCone(1.3, 2.3, hi ? 7 : 5, hi ? 4 : 2, 9.4, 0.45), T(0, 1.15, 0), WHITE, 1);
  },
  stack(k, hi) {
    const g = new THREE.CylinderGeometry(0.82, 1.05, 1, hi ? 9 : 6, hi ? 6 : 2);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) { const y = p.getY(i), band = 1 + Math.sin(y * 26 + 0.7) * 0.05 + Math.sin(p.getX(i) * 7 + p.getZ(i) * 5) * 0.06; p.setXYZ(i, p.getX(i) * band, y, p.getZ(i) * band); }
    g.computeVertexNormals();
    k.add(g, T(0, 0.5, 0), WHITE, 1);
    k.add(blob(hi ? 1 : 0, 0.25, 3.3), T(0, 1.0, 0, 0, 0, 0, 0.92, 0.08, 0.92), GRASS);
    if (hi) for (let i = 0; i < 3; i++) k.add(blob(1, 0.25, i), T(Math.cos(i * 2.1) * 0.45, 1.1, Math.sin(i * 2.1) * 0.45, 0, 0, 0, 0.26, 0.06, 0.26), '#3d8a35');
  },
  boulder(k, hi) { k.add(blob(hi ? 1 : 0, 0.45, 2.2), T(0, 0.35, 0, 0, 0, 0, 1, 0.75, 1), WHITE, 1); },
  house(k, hi) {
    k.add(new THREE.BoxGeometry(1, 0.78, 0.8).translate(0, 0.39, 0), T(0, 0, 0), WALL);
    k.add(gableRoof(1, 0.8, 0.5, 0.1).translate(0, 0.78, 0), T(0, 0, 0), WHITE, 1);
    if (hi) {
      k.add(new THREE.BoxGeometry(0.14, 0.32, 0.14), T(0.28, 1.26, -0.1), '#a8836a');
      for (const x of [-0.24, 0.24]) k.add(new THREE.BoxGeometry(0.18, 0.2, 0.02), T(x, 0.45, 0.41), '#ffd88a', 0, 0.75);
      k.add(new THREE.BoxGeometry(0.2, 0.36, 0.02), T(0, 0.18, 0.41), '#7a5236');
    }
  },
  tallhouse(k, hi) {
    k.add(new THREE.BoxGeometry(0.9, 1.5, 0.85).translate(0, 0.75, 0), T(0, 0, 0), WALL);
    k.add(gableRoof(0.9, 0.85, 0.55, 0.08).translate(0, 1.5, 0), T(0, 0, 0), WHITE, 1);
    if (hi) for (const y of [0.45, 1.05]) for (const x of [-0.22, 0.22]) k.add(new THREE.BoxGeometry(0.16, 0.22, 0.02), T(x, y, 0.435), '#ffd88a', 0, 0.75);
  },
};

const cache = new Map<string, THREE.BufferGeometry>();
/** Ground cover exists only in its detailed form (it is never drawn from far away). */
export function propGeometry(kind: PropKind, hi: boolean) {
  const key = `${kind}:${hi}`;
  let g = cache.get(key);
  if (!g) { const k = new Kit(); B[kind](k, hi); g = finish(k); cache.set(key, g); }
  return g;
}
export function disposePropGeometries() { cache.forEach(g => g.dispose()); cache.clear(); }

/** A small sailboat: hull, mast, a white sail (tinted for variety). */
export function boatGeometry() {
  const k = new Kit();
  k.add(new THREE.CylinderGeometry(0.5, 0.28, 2.2, 6, 1).rotateZ(Math.PI / 2).scale(1, 0.55, 0.9), T(0, 0.1, 0), '#7a4b2c');
  k.add(new THREE.BoxGeometry(1.7, 0.08, 0.7), T(0, 0.32, 0), '#c49a6c');
  k.add(new THREE.CylinderGeometry(0.035, 0.035, 2.0, 4), T(0.1, 1.3, 0), '#5a3a24');
  const sail = new THREE.BufferGeometry();
  sail.setAttribute('position', new THREE.Float32BufferAttribute([0.15, 0.45, 0, 0.15, 2.2, 0, 1.1, 0.5, 0, 0.15, 0.45, 0, 1.1, 0.5, 0, 0.15, 2.2, 0], 3)); sail.computeVertexNormals();
  k.add(sail, T(0, 0, 0), WHITE, 1);
  k.add(new THREE.ConeGeometry(0.12, 0.3, 3).rotateZ(-Math.PI / 2), T(0.25, 2.2, 0), '#d9534f');
  return finish(k);
}

/** A cumulus puff: four welded blobs, flat underside. */
export function cloudGeometry(seed: number) {
  const k = new Kit();
  const parts: [number, number, number, number][] = [[0, 0.3, 0, 1.4], [1.3, 0.1, 0.2, 1.0], [-1.25, 0.05, -0.15, 1.05], [0.4, 0.7, -0.3, 0.95], [-0.5, 0.55, 0.45, 0.8]];
  parts.forEach(([x, y, z, s], i) => k.add(blob(1, 0.18, seed + i), T(x, y, z, 0, 0, 0, s, s * 0.72, s), WHITE, 0, 0, [0.78, -0.3]));
  return finish(k);
}
