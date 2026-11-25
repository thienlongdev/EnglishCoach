/* Echo Living Planet — the builder. Runs in a Web Worker (planet.worker.ts); pure CPU work, no network, no DOM.
   Output: typed arrays the scene turns into GPU buffers. Same seed + same quality ⇒ the same world on every device. */
import * as THREE from 'three';
import { createTerrain, newSample, PALETTES, biomeName, type TerrainSample } from './terrain';
import { SITES, PLANET_RADIUS as R, siteDir, frameAt, bearingOffset, type Biome } from './layout';
import { seeded, clamp01, smoothstep } from './noise';
import { Kit, type MeshArrays } from './kit';
import { buildLandmark } from './landmarks';

export type PropKind = 'broad' | 'conifer' | 'palm' | 'cypress' | 'acacia' | 'willow' | 'snowpine' | 'birch' | 'bush' | 'peak' | 'crag' | 'stack' | 'boulder' | 'house' | 'tallhouse' | 'tuft' | 'flower';
export const PROP_KINDS: PropKind[] = ['broad', 'conifer', 'palm', 'cypress', 'acacia', 'willow', 'snowpine', 'birch', 'bush', 'peak', 'crag', 'stack', 'boulder', 'house', 'tallhouse', 'tuft', 'flower'];
/** Kinds a graphics tier may thin out (instances are stored in a random order: the first n are an even sample). */
export const THINNED = new Set<PropKind>(['broad', 'conifer', 'palm', 'cypress', 'acacia', 'willow', 'snowpine', 'birch', 'bush']);
export const GROUND_COVER = new Set<PropKind>(['tuft', 'flower']);
export interface Cluster { center: [number, number, number]; matrices: Float32Array; colors: Float32Array; count: number }
export interface SiteBuild {
  id: string; anchor: [number, number, number]; up: [number, number, number]; east: [number, number, number]; north: [number, number, number];
  beacon: [number, number, number]; sockets: Float32Array; water: [number, number, number]; heading: number;
  mills: { p: [number, number, number]; axis: [number, number, number]; r: number }[]; lights: [number, number, number][];
}
export interface PlanetBuild {
  level: number; radius: number;
  terrain: { position: Float32Array; normal: Float32Array; color: Float32Array; surface: Uint8Array; index: Uint32Array };
  ocean: { position: Float32Array; depth: Float32Array; index: Uint32Array };
  landmarks: MeshArrays;
  props: Record<PropKind, Cluster[]>;
  sites: SiteBuild[];
  boats: { center: [number, number, number]; axis: [number, number, number]; angle: number; speed: number; phase: number }[];
  smoke: [number, number, number] | null;
  stats: { vertices: number; triangles: number; props: number; ms: number };
}
/** level: icosphere subdivision (6 light, 7 balanced, 8 high/ultra); trees: forest density; grass: meadow ground cover (0 = none). */
export interface BuildOptions { level: 6 | 7 | 8; trees: number; grass?: number; seed?: number }

// ── Icosphere with a shared-vertex midpoint cache: level k vertices are a prefix of level k+1. ─────────────────────
// The cache keeps, for every vertex, up to six (neighbour, midpoint) pairs in typed arrays: a level-8 sphere
// (655,362 vertices) builds without a hash map of millions of entries.
export function icosphere(level: number) {
  const t = (1 + Math.sqrt(5)) / 2;
  const base = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  let faces = Uint32Array.from([0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1]);
  const total = 10 * Math.pow(4, level) + 2;
  const pos = new Float64Array(total * 3);
  let count = 12;
  for (let i = 0; i < 12; i++) { const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2], l = Math.hypot(x, y, z); pos[i * 3] = x / l; pos[i * 3 + 1] = y / l; pos[i * 3 + 2] = z / l; }
  const prefix: { vertices: number; faces: Uint32Array }[] = [{ vertices: 12, faces }];
  for (let lv = 0; lv < level; lv++) {
    const old = count, used = new Uint8Array(old), slots = new Int32Array(old * 12);
    const mid = (a: number, b: number) => {
      const lo = a < b ? a : b, hi = a < b ? b : a, n = used[lo], o = lo * 12;
      for (let k = 0; k < n; k++) if (slots[o + k * 2] === hi) return slots[o + k * 2 + 1];
      const x = pos[a * 3] + pos[b * 3], y = pos[a * 3 + 1] + pos[b * 3 + 1], z = pos[a * 3 + 2] + pos[b * 3 + 2], l = Math.hypot(x, y, z);
      const m = count++; pos[m * 3] = x / l; pos[m * 3 + 1] = y / l; pos[m * 3 + 2] = z / l;
      slots[o + n * 2] = hi; slots[o + n * 2 + 1] = m; used[lo] = n + 1; return m;
    };
    const next = new Uint32Array(faces.length * 4);
    for (let f = 0, w = 0; f < faces.length; f += 3) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next[w++] = a; next[w++] = ab; next[w++] = ca; next[w++] = b; next[w++] = bc; next[w++] = ab;
      next[w++] = c; next[w++] = ca; next[w++] = bc; next[w++] = ab; next[w++] = bc; next[w++] = ca;
    }
    faces = next;
    prefix.push({ vertices: count, faces });
  }
  return { pos, count, prefix };
}

const fib = (n: number) => Array.from({ length: n }, (_, i) => {
  const y = 1 - (i + 0.5) * 2 / n, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(a) * r, y, Math.sin(a) * r] as [number, number, number];
});

// Tree species and colours by biome (sRGB hex; converted to linear by THREE.Color).
type Pick = [PropKind, number][];
const SPECIES: Record<Biome | 'wild', Pick> = {
  meadow: [['broad', 0.72], ['conifer', 0.14], ['cypress', 0.08], ['bush', 0.06]],
  blossom: [['broad', 0.9], ['bush', 0.1]],
  forest: [['broad', 0.68], ['conifer', 0.28], ['bush', 0.04]],
  cliffs: [['conifer', 0.66], ['broad', 0.28], ['bush', 0.06]],
  tropical: [['palm', 0.82], ['broad', 0.1], ['bush', 0.08]],
  coastal: [['cypress', 0.42], ['broad', 0.3], ['palm', 0.16], ['bush', 0.12]],
  autumn: [['broad', 0.8], ['conifer', 0.16], ['bush', 0.04]],
  ink: [['willow', 0.62], ['broad', 0.3], ['bush', 0.08]],
  archipelago: [['conifer', 0.58], ['broad', 0.38], ['bush', 0.04]],
  port: [['cypress', 0.45], ['broad', 0.4], ['bush', 0.15]],
  savanna: [['acacia', 0.8], ['palm', 0.08], ['bush', 0.12]],
  alpine: [['conifer', 0.8], ['snowpine', 0.12], ['broad', 0.08]],
  polar: [['snowpine', 1]],
  sanctuary: [['broad', 0.48], ['willow', 0.24], ['conifer', 0.22], ['bush', 0.06]],
  volcanic: [['conifer', 0.9], ['bush', 0.1]],
  wild: [['broad', 0.6], ['palm', 0.2], ['conifer', 0.2]],
};
const GREENS = ['#2f7d32', '#3b8f2f', '#4e9a2e', '#2a6b2c', '#58a63a', '#3f8530'];
const LEAVES: Partial<Record<Biome | 'wild', string[]>> = {
  meadow: ['#4f9c33', '#67ad3b', '#3f8a2d', '#7fb83f', '#5aa23a'],
  blossom: ['#f5b6cf', '#f29bbf', '#fbd3e2', '#e886ad', '#f7c4d8', '#5fa847', '#78b54a'],
  forest: GREENS,
  autumn: ['#e0662a', '#f08a24', '#d94a25', '#f2b33b', '#c7362b', '#e8c14a', '#f59e3a', '#7a8f2f'],
  ink: ['#5f8f78', '#7aa58f', '#8f7cc9', '#6f6aa8', '#5d9a86'],
  sanctuary: ['#4f9a62', '#6db383', '#3f7f55', '#5fa57a'],
  tropical: ['#4f9f3a', '#6db043', '#3e8c35'],
  savanna: ['#7f9a3a', '#91a845', '#6d8b33', '#a3ad4c'],
  port: ['#6f8f3c', '#7f9a45', '#5d7d36'],
  coastal: ['#4c7f3c', '#5f8f45', '#6fa04a'],
};
const CONIFERS = ['#2b6a45', '#22573a', '#357a4c', '#1f4f35', '#2f6f43'];
const BIRCH = ['#8fbf4a', '#a3c955', '#d9c24a', '#7fb043'];
const MEADOW = new THREE.Color('#9fbf4a');
const FLOWERS: Partial<Record<Biome | 'wild', string[]>> = {
  meadow: ['#f4e27a', '#ffffff', '#f7b6c2', '#c9a7f2'], blossom: ['#f6b8d0', '#fbd3e2', '#ffffff', '#f29bbf'], coastal: ['#f1c56a', '#ffffff', '#9ad3f0'],
  forest: ['#ffffff', '#f4e27a'], autumn: ['#e8c14a', '#d94a25', '#f59e3a'], ink: ['#a989e2', '#cbb7f5', '#ffffff'], sanctuary: ['#9fd8cf', '#ffffff', '#c9a7f2'],
  alpine: ['#8fa9ff', '#c9a7f2', '#ffffff'], archipelago: ['#ffffff', '#f4e27a'], port: ['#d98f5d', '#f1c56a'], tropical: ['#ff7a8a', '#ffb347', '#ff6fb5'], cliffs: ['#ffffff', '#f4e27a'],
};
const ROCK_TINT = (b: Biome | 'wild') => b === 'wild' ? '#8d877a' : ({ volcanic: '#4a4240', polar: '#77808e', alpine: '#8e939c', cliffs: '#a39d8e', savanna: '#b8805c', archipelago: '#8c877c', sanctuary: '#8aa39c' } as Partial<Record<Biome, string>>)[b] ?? '#958d80';

export function buildPlanet(opts: BuildOptions): PlanetBuild {
  const started = performance.now();
  const seed = opts.seed ?? 20261114;
  // Fine relief grows with the mesh that can show it (props stand on the same function, so they never float).
  const terrain = createTerrain(seed, opts.level === 8 ? 1 : opts.level === 7 ? 0.6 : 0.3);
  const rand = seeded(seed + 99);
  const sphere = icosphere(opts.level);
  const N = sphere.count, faces = sphere.prefix[opts.level].faces;
  const samples = new Float32Array(N * 12);
  const s: TerrainSample = newSample();
  const position = new Float32Array(N * 3), color = new Float32Array(N * 3), surface = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const x = sphere.pos[i * 3], y = sphere.pos[i * 3 + 1], z = sphere.pos[i * 3 + 2];
    terrain.sample(x, y, z, s);
    const r = R + s.h;
    position[i * 3] = x * r; position[i * 3 + 1] = y * r; position[i * 3 + 2] = z * r;
    const o = i * 12;
    samples[o] = s.h; samples[o + 1] = s.forest; samples[o + 2] = s.site; samples[o + 3] = s.biome; samples[o + 4] = s.pad;
    samples[o + 5] = s.rr; samples[o + 6] = s.rg; samples[o + 7] = s.rb; samples[o + 8] = s.snow; samples[o + 9] = s.sand; samples[o + 10] = s.special;
    color[i * 3] = s.r; color[i * 3 + 1] = s.g; color[i * 3 + 2] = s.b;
  }
  // Area-weighted vertex normals.
  const normal = new Float32Array(N * 3);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const ux = position[b] - position[a], uy = position[b + 1] - position[a + 1], uz = position[b + 2] - position[a + 2];
    const vx = position[c] - position[a], vy = position[c + 1] - position[a + 1], vz = position[c + 2] - position[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { normal[k] += nx; normal[k + 1] += ny; normal[k + 2] += nz; }
  }
  for (let i = 0; i < N; i++) {
    const k = i * 3, l = Math.hypot(normal[k], normal[k + 1], normal[k + 2]) || 1;
    normal[k] /= l; normal[k + 1] /= l; normal[k + 2] /= l;
    // Slope → rock; snow keeps to gentle ground; vertex colour carries the final albedo.
    const dot = normal[k] * sphere.pos[k] + normal[k + 1] * sphere.pos[k + 1] + normal[k + 2] * sphere.pos[k + 2];
    const o = i * 12, h = samples[o];
    const slope = 1 - dot;
    const rock = h > 0.2 ? smoothstep(0.1, 0.3, slope) : 0;
    const snow = samples[o + 8] * (1 - smoothstep(0.24, 0.42, slope));
    let r = color[k], g = color[k + 1], b = color[k + 2];
    r += (samples[o + 5] - r) * rock; g += (samples[o + 6] - g) * rock; b += (samples[o + 7] - b) * rock;
    r += (0.86 - r) * snow; g += (0.9 - g) * snow; b += (0.96 - b) * snow;
    color[k] = r; color[k + 1] = g; color[k + 2] = b;
    surface[i * 4] = Math.round(rock * 255); surface[i * 4 + 1] = Math.round(snow * 255); surface[i * 4 + 2] = Math.round(clamp01(samples[o + 9]) * 255); surface[i * 4 + 3] = Math.round(clamp01(samples[o + 10]) * 255);
  }

  // Ocean: the level-6 prefix of the same sphere, at sea level, with the seabed depth per vertex.
  const oceanLevel = Math.min(6, opts.level), ON = sphere.prefix[oceanLevel].vertices, oceanFaces = sphere.prefix[oceanLevel].faces;
  const oceanPos = new Float32Array(ON * 3), depth = new Float32Array(ON);
  for (let i = 0; i < ON; i++) { oceanPos[i * 3] = sphere.pos[i * 3] * R; oceanPos[i * 3 + 1] = sphere.pos[i * 3 + 1] * R; oceanPos[i * 3 + 2] = sphere.pos[i * 3 + 2] * R; depth[i] = -samples[i * 12]; }

  // Sites: anchors, landmarks, villages, sockets.
  const kit = new Kit();
  const sites: SiteBuild[] = [];
  const houses: { kind: PropKind; m: THREE.Matrix4; color: THREE.Color; dir: [number, number, number] }[] = [];
  const occupied = new Map<string, [number, number, number][]>();
  const cell = (p: [number, number, number]) => `${Math.round(p[0] / 2.5)},${Math.round(p[1] / 2.5)},${Math.round(p[2] / 2.5)}`;
  const occupy = (p: [number, number, number]) => { const k = cell(p); occupied.set(k, [...(occupied.get(k) ?? []), p]); };
  const near = (p: [number, number, number], d: number) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = occupied.get(`${Math.round(p[0] / 2.5) + dx},${Math.round(p[1] / 2.5) + dy},${Math.round(p[2] / 2.5) + dz}`);
      if (list) for (const q of list) if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < d) return true;
    }
    return false;
  };
  const surfaceAt = (d: [number, number, number]) => { terrain.sample(d[0], d[1], d[2], s); return s.h; };
  const slopeAt = (d: [number, number, number]) => {
    const h0 = surfaceAt(d), f = frameAt(d), e = 0.004;
    const dE = [d[0] + f.east[0] * e, d[1] + f.east[1] * e, d[2] + f.east[2] * e] as [number, number, number];
    const dN = [d[0] + f.north[0] * e, d[1] + f.north[1] * e, d[2] + f.north[2] * e] as [number, number, number];
    const gx = (surfaceAt(dE) - h0) / (e * R), gy = (surfaceAt(dN) - h0) / (e * R);
    return { h: h0, slope: Math.hypot(gx, gy) };
  };
  const frameMatrix = (d: [number, number, number], h: number, yaw: number, scale: number, sy = scale) => {
    const f = frameAt(d), ex = new THREE.Vector3(...f.east), up = new THREE.Vector3(...d), so = new THREE.Vector3(...f.north).negate();
    const basis = new THREE.Matrix4().makeBasis(ex, up, so).multiply(new THREE.Matrix4().makeRotationY(yaw));
    basis.scale(new THREE.Vector3(scale, sy, scale));
    basis.setPosition(d[0] * (R + h), d[1] * (R + h), d[2] * (R + h));
    return basis;
  };
  const toWorld = (m: THREE.Matrix4, p: [number, number, number]) => new THREE.Vector3(...p).applyMatrix4(m).toArray() as [number, number, number];
  for (const site of SITES) {
    const d = siteDir(site), f = frameAt(d), heading = site.heading * Math.PI / 180;
    const ground = surfaceAt(d);
    const m = frameMatrix(d, ground - 0.05, -heading, 1);
    const before = kit.vertexCount;
    const res = buildLandmark(site.landmark, kit);
    // Landmark vertices were added in local space: move them to the world.
    const nm = new THREE.Matrix3().getNormalMatrix(m), v = new THREE.Vector3();
    for (let i = before; i < kit.vertexCount; i++) {
      v.set(kit.pos[i * 3], kit.pos[i * 3 + 1], kit.pos[i * 3 + 2]).applyMatrix4(m); kit.pos[i * 3] = v.x; kit.pos[i * 3 + 1] = v.y; kit.pos[i * 3 + 2] = v.z;
      v.set(kit.nor[i * 3], kit.nor[i * 3 + 1], kit.nor[i * 3 + 2]).applyMatrix3(nm).normalize(); kit.nor[i * 3] = v.x; kit.nor[i * 3 + 1] = v.y; kit.nor[i * 3 + 2] = v.z;
    }
    const anchor = d.map(c => c * (R + ground)) as [number, number, number];
    occupy(anchor);
    // Villages: houses on gentle ground around the landmark, facing it.
    const village = site.village ?? 0;
    for (let tries = 0, placed = 0; placed < village && tries < village * 14; tries++) {
      const dist = 2.5 + rand() * 5.2, bearing = rand() * 360;
      const p = bearingOffset(d, bearing, dist);
      const { h, slope } = slopeAt(p);
      if (h < 0.55 || slope > 0.5) continue;
      const w = p.map(c => c * (R + h)) as [number, number, number];
      if (near(w, 1.25)) continue;
      const tall = rand() < 0.18, scale = 0.75 + rand() * 0.4;
      const yaw = -bearing * Math.PI / 180 + Math.PI + (rand() - 0.5) * 0.5;
      houses.push({ kind: tall ? 'tallhouse' : 'house', m: frameMatrix(p, h - 0.06, yaw, scale), color: new THREE.Color(site.roof?.[Math.floor(rand() * (site.roof?.length ?? 1))] ?? '#c9463a'), dir: p });
      occupy(w); placed++;
    }
    // Station sockets: a golden spiral of flat, dry places around the landmark.
    const sockets: number[] = [];
    for (let i = 0; sockets.length < 64 * 3 && i < 520; i++) {
      const dist = 2.5 + Math.sqrt(i / 520) * 5.4, bearing = i * 137.508 + site.heading;
      const p = bearingOffset(d, bearing, dist);
      const { h, slope } = slopeAt(p);
      if (h < 0.4 || slope > 0.7) continue;
      const w = p.map(c => c * (R + h + 0.08)) as [number, number, number];
      if (near(w, 1.05)) continue;
      sockets.push(...w); occupy(w);
    }
    // Lanterns along the approach to the landmark (after the station sockets, which keep priority): warm points at dusk and at night (their glow uses `lights`).
    const lanterns: [number, number, number][] = [];
    for (let i = 0; i < 7; i++) {
      const p = bearingOffset(d, site.heading + 180 + (i - 3) * 34 + (rand() - 0.5) * 8, 2.15 + rand() * 0.5);
      const { h, slope } = slopeAt(p); if (h < 0.5 || slope > 0.6) continue;
      const w = p.map(c => c * (R + h)) as [number, number, number]; if (near(w, 0.9)) continue;
      const lm = frameMatrix(p, h - 0.05, 0, 1);
      kit.add(new THREE.CylinderGeometry(0.05, 0.07, 1.1, 6).translate(0, 0.55, 0), lm, '#4a3a2c');
      kit.add(new THREE.BoxGeometry(0.2, 0.24, 0.2).translate(0, 1.2, 0), lm, '#ffd27a', 0, 1);
      lanterns.push(toWorld(lm, [0, 1.2, 0])); occupy(w);
    }
    // Echo's water: the nearest open water with some depth.
    let water: [number, number, number] = bearingOffset(d, 180, site.radius + 2);
    for (let dist = 7; dist <= 24; dist += 1.5) {
      let found = false;
      for (let b = 0; b < 360; b += 30) {
        const p = bearingOffset(d, b + site.heading + 180, dist);
        if (surfaceAt(p) < -3.4 && surfaceAt(bearingOffset(p, 0, 2.6)) < -2 && surfaceAt(bearingOffset(p, 180, 2.6)) < -2) { water = p; found = true; break; }
      }
      if (found) break;
    }
    const mills = res.mills.map(mm => {
      const p = toWorld(m, mm.p);
      const ax = new THREE.Vector3(Math.sin(mm.ry), 0, Math.cos(mm.ry)).transformDirection(m).toArray() as [number, number, number];
      return { p, axis: ax, r: mm.r };
    });
    sites.push({ id: site.id, anchor, up: d, east: f.east, north: f.north, beacon: toWorld(m, res.beacon), sockets: new Float32Array(sockets), water,
      heading: site.heading, mills, lights: [...res.lights.map(l => toWorld(m, l)), ...lanterns] });
  }
  buildBridges(kit, terrain, surfaceAt);

  // Props: trees, rocks, mountains, sea stacks, houses — clustered for culling.
  const centers = fib(28);
  const props = Object.fromEntries(PROP_KINDS.map(k => [k, centers.map(c => ({ center: c, list: [] as number[], colors: [] as number[], ranks: [] as number[] }))])) as Record<PropKind, { center: [number, number, number]; list: number[]; colors: number[]; ranks: number[] }[]>;
  const clusterOf = (d: [number, number, number]) => { let best = 0, bd = -2; for (let i = 0; i < centers.length; i++) { const c = centers[i], dt = c[0] * d[0] + c[1] * d[1] + c[2] * d[2]; if (dt > bd) { bd = dt; best = i; } } return best; };
  const col = new THREE.Color();
  let propCount = 0;
  const push = (kind: PropKind, d: [number, number, number], m: THREE.Matrix4, c: THREE.Color) => {
    const cl = props[kind][clusterOf(d)]; cl.list.push(...m.elements); cl.colors.push(c.r, c.g, c.b); cl.ranks.push(THINNED.has(kind) || GROUND_COVER.has(kind) ? rand() : 0); propCount++;
  };
  for (const h of houses) push(h.kind, h.dir, h.m, h.color);
  const vArea = 4 * Math.PI * R * R / N, edge = Math.sqrt(vArea), perVertex = 163842 / N; // per-vertex chances are tuned at level 7
  const grass = opts.grass ?? 0;
  const tmpUp = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const o = i * 12, h = samples[o], forest = samples[o + 1], siteIdx = samples[o + 2], biomeIdx = samples[o + 3];
    const biome = (biomeName(biomeIdx) ?? 'wild') as Biome | 'wild';
    const d: [number, number, number] = [sphere.pos[i * 3], sphere.pos[i * 3 + 1], sphere.pos[i * 3 + 2]];
    // Trees
    const expected = forest * opts.trees * vArea / 1.6;
    let n = Math.floor(expected) + (rand() < expected % 1 ? 1 : 0);
    while (n-- > 0) {
      const f = frameAt(d), ja = (rand() - 0.5) * edge * 1.15 / R, jb = (rand() - 0.5) * edge * 1.15 / R;
      const p: [number, number, number] = [d[0] + f.east[0] * ja + f.north[0] * jb, d[1] + f.east[1] * ja + f.north[1] * jb, d[2] + f.east[2] * ja + f.north[2] * jb];
      const l = Math.hypot(...p); p[0] /= l; p[1] /= l; p[2] /= l;
      const th = surfaceAt(p);
      if (th < 0.6) continue;
      const w = p.map(c => c * (R + th)) as [number, number, number];
      if (near(w, 0.9)) continue;
      const kind = pick(SPECIES[biome], rand());
      if (kind === 'conifer' && (biome === 'forest' || biome === 'alpine' || biome === 'sanctuary') && rand() < 0.16) { col.set(BIRCH[Math.floor(rand() * BIRCH.length)]).multiplyScalar(0.85 + rand() * 0.25); push('birch', p, frameMatrix(p, th - 0.08, rand() * Math.PI * 2, 0.75 + rand() * 0.45), col); continue; }
      const big = biome === 'forest' || biome === 'autumn' ? 1.15 : biome === 'savanna' ? 1.2 : 1;
      const alt = biome === 'alpine' || biome === 'polar' ? 1 - clamp01((th - 3) / 10) * 0.45 : 1;
      const scale = (0.72 + rand() * 0.6) * big * alt;
      const palette = kind === 'conifer' || kind === 'snowpine' ? CONIFERS : (LEAVES[biome] ?? GREENS);
      col.set(palette[Math.floor(rand() * palette.length)]);
      const shade = 0.85 + rand() * 0.25; col.multiplyScalar(shade);
      const m = frameMatrix(p, th - 0.1 * scale, rand() * Math.PI * 2, scale, scale * (0.85 + rand() * 0.35));
      tmpUp.set(normalFrom(normal, i)[0], normalFrom(normal, i)[1], normalFrom(normal, i)[2]);
      push(kind, p, m, col);
    }
    // The volcano's cone and crater stay clear of crags, boulders and grass (its lava and smoke are the landmark).
    const nearVolcano = !!terrain.volcano && (d[0] * terrain.volcano.x + d[1] * terrain.volcano.y + d[2] * terrain.volcano.z) > Math.cos(7.5 * Math.PI / 180);
    // Mountains: snow-capped spires in high ranges, bare crags elsewhere.
    if (!nearVolcano && h > 5.2 && (biome === 'alpine' || biome === 'polar' || biome === 'cliffs' || biome === 'volcanic' || biome === 'wild') && rand() < 0.018 * perVertex * smoothstep(5.5, 10, h)) {
      const snowy = biome === 'alpine' || biome === 'polar';
      col.set(ROCK_TINT(biome)).multiplyScalar(0.85 + rand() * 0.3);
      const sc = 0.7 + rand() * 0.6 + (h - 5) * 0.05;
      push(snowy ? 'peak' : 'crag', d, frameMatrix(d, h - 0.8, rand() * 6.28, sc, sc * (0.85 + rand() * 0.5)), col);
    }
    // Sea stacks along wild coasts.
    if (h > -2.6 && h < 0.2 && siteIdx >= 0 && ['cliffs', 'archipelago', 'savanna', 'sanctuary', 'meadow', 'forest'].includes(biome) && rand() < 0.007 * perVertex) {
      if (!near(d.map(c => c * R) as [number, number, number], 3)) {
        col.set(ROCK_TINT(biome)).multiplyScalar(0.9 + rand() * 0.25);
        const sc = 0.8 + rand() * 0.7;
        push('stack', d, frameMatrix(d, h - 0.5, rand() * 6.28, sc, sc * (2.6 + rand() * 3.4)), col);
        occupy(d.map(c => c * R) as [number, number, number]);
      }
    }
    // Boulders on rugged ground.
    if (!nearVolcano && h > 0.6 && ['cliffs', 'archipelago', 'sanctuary', 'volcanic', 'alpine', 'polar', 'savanna'].includes(biome) && rand() < 0.012 * perVertex) {
      col.set(ROCK_TINT(biome)).multiplyScalar(0.9 + rand() * 0.3);
      const sc = 0.25 + rand() * 0.45;
      push('boulder', d, frameMatrix(d, h - 0.08, rand() * 6.28, sc, sc * (0.6 + rand() * 0.5)), col);
    }
    // Meadow ground cover (high tiers): grass tufts and flowers on gentle, open ground near the learning regions.
    if (grass > 0 && !nearVolcano && biome !== 'volcanic' && h > 0.7 && siteIdx >= 0 && forest < 0.55 && samples[o + 8] < 0.3 && samples[o + 9] < 0.3 && samples[o + 4] < 0.5) {
      const tufts = grass * vArea * 1.15 * (biome === 'savanna' || biome === 'polar' ? 0.25 : 1);
      let k = Math.floor(tufts) + (rand() < tufts % 1 ? 1 : 0);
      const f = frameAt(d);
      while (k-- > 0) {
        const ja = (rand() - 0.5) * edge * 1.1 / R, jb = (rand() - 0.5) * edge * 1.1 / R;
        const p: [number, number, number] = [d[0] + f.east[0] * ja + f.north[0] * jb, d[1] + f.east[1] * ja + f.north[1] * jb, d[2] + f.east[2] * ja + f.north[2] * jb];
        const l = Math.hypot(...p); p[0] /= l; p[1] /= l; p[2] /= l;
        const th = surfaceAt(p); if (th < 0.65) continue;
        const palette = FLOWERS[biome], flower = !!palette && rand() < 0.2;
        if (flower) col.set(palette![Math.floor(rand() * palette!.length)]);
        else { const g = LEAVES[biome] ?? GREENS; col.set(g[Math.floor(rand() * g.length)]).lerp(MEADOW, 0.25); }
        col.multiplyScalar(0.85 + rand() * 0.3);
        const sc = flower ? 0.45 + rand() * 0.35 : 0.55 + rand() * 0.5;
        push(flower ? 'flower' : 'tuft', p, frameMatrix(p, th - 0.03, rand() * Math.PI * 2, sc, sc * (0.8 + rand() * 0.5)), col);
      }
    }
  }
  // Instances in rank order: a tier that draws the first n of a cluster draws an even sample of it.
  const outProps = Object.fromEntries(PROP_KINDS.map(k => [k, props[k].filter(c => c.colors.length).map(c => {
    const n = c.colors.length / 3, order = Array.from({ length: n }, (_, i) => i).sort((a, b) => c.ranks[a] - c.ranks[b]);
    const matrices = new Float32Array(n * 16), colors = new Float32Array(n * 3);
    order.forEach((src, dst) => { for (let j = 0; j < 16; j++) matrices[dst * 16 + j] = c.list[src * 16 + j]; colors[dst * 3] = c.colors[src * 3]; colors[dst * 3 + 1] = c.colors[src * 3 + 1]; colors[dst * 3 + 2] = c.colors[src * 3 + 2]; });
    return { center: c.center, matrices, colors, count: n };
  })])) as Record<PropKind, Cluster[]>;

  // Boats on circles that stay on open water.
  const boats: PlanetBuild['boats'] = [];
  for (let tries = 0; boats.length < 9 && tries < 400; tries++) {
    const i = Math.floor(rand() * ON); if (samples[i * 12] > -3) continue;
    const c: [number, number, number] = [sphere.pos[i * 3], sphere.pos[i * 3 + 1], sphere.pos[i * 3 + 2]];
    const angle = (2.5 + rand() * 5) * Math.PI / 180;
    let ok = true;
    const f = frameAt(c);
    for (let k = 0; k < 24 && ok; k++) {
      const a = k / 24 * Math.PI * 2, p = new THREE.Vector3(...c).multiplyScalar(Math.cos(angle)).addScaledVector(new THREE.Vector3(...f.east), Math.sin(angle) * Math.cos(a)).addScaledVector(new THREE.Vector3(...f.north), Math.sin(angle) * Math.sin(a)).normalize();
      if (surfaceAt(p.toArray() as [number, number, number]) > -1.4) ok = false;
    }
    if (ok) boats.push({ center: c, axis: c, angle, speed: (0.012 + rand() * 0.02) * (rand() < 0.5 ? -1 : 1), phase: rand() * 6.28 });
  }
  const smoke = terrain.volcano ? (() => { const v = terrain.volcano!; const h = surfaceAt([v.x, v.y, v.z]); return [v.x * (R + h), v.y * (R + h), v.z * (R + h)] as [number, number, number]; })() : null;

  return {
    level: opts.level, radius: R,
    terrain: { position, normal, color, surface, index: faces },
    ocean: { position: oceanPos, depth, index: oceanFaces },
    landmarks: kit.arrays(), props: outProps, sites, boats, smoke,
    stats: { vertices: N, triangles: faces.length / 3, props: propCount, ms: Math.round(performance.now() - started) },
  };
}

function normalFrom(normal: Float32Array, i: number): [number, number, number] { return [normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]]; }
function pick(list: [PropKind, number][], r: number): PropKind { let acc = 0; for (const [k, w] of list) { acc += w; if (r <= acc) return k; } return list[list.length - 1][0]; }

/** Isles of Connection: stone arch bridges from the central islet to its neighbours, over the real water. */
function buildBridges(kit: Kit, terrain: ReturnType<typeof createTerrain>, surfaceAt: (d: [number, number, number]) => number) {
  const site = SITES.find(x => x.id === 'bridges'); if (!site) return;
  const c = siteDir(site);
  const targets = [40, 160, 275].map(b => {
    for (let dist = 5; dist < 10; dist += 0.5) { const p = bearingOffset(c, b, dist); if (surfaceAt(p) > 0.5) return p; }
    return null;
  }).filter((p): p is [number, number, number] => !!p);
  const deck = new THREE.Color('#d9ccb2'), stone = '#bfb19a';
  for (const t of targets) {
    const A = new THREE.Vector3(...bearingOffset(c, 0, 0)), B = new THREE.Vector3(...t);
    const steps = 22, pts: THREE.Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps, d = new THREE.Vector3().copy(A).lerp(B, u).normalize();
      const ground = Math.max(surfaceAt(d.toArray() as [number, number, number]), 0);
      const h = Math.max(ground + 0.5, 1.4 + Math.sin(u * Math.PI) * 1.4);
      pts.push(d.multiplyScalar(R + h));
    }
    for (let i = 0; i < steps; i++) {
      const a = pts[i], b = pts[i + 1], mid = a.clone().add(b).multiplyScalar(0.5), up = mid.clone().normalize();
      const along = b.clone().sub(a), len = along.length(); along.normalize();
      const side = new THREE.Vector3().crossVectors(along, up).normalize(), realUp = new THREE.Vector3().crossVectors(side, along);
      const m = new THREE.Matrix4().makeBasis(along, realUp, side).setPosition(mid);
      kit.add(new THREE.BoxGeometry(len + 0.05, 0.28, 1.0), m, [deck.r, deck.g, deck.b]);
      kit.add(new THREE.BoxGeometry(len + 0.05, 0.22, 0.12).translate(0, 0.25, 0.48), m, stone);
      kit.add(new THREE.BoxGeometry(len + 0.05, 0.22, 0.12).translate(0, 0.25, -0.48), m, stone);
      if (i % 5 === 2) {
        const ground = surfaceAt(mid.clone().normalize().toArray() as [number, number, number]);
        const height = mid.length() - (R + Math.min(ground, 0) - 1.5);
        kit.add(new THREE.CylinderGeometry(0.32, 0.42, height, 8).translate(0, -height / 2, 0), m, stone);
        kit.add(new THREE.BoxGeometry(0.16, 0.5, 0.16).translate(0, 0.55, 0.48), m, '#ffd27a', 0, 0.9);
      }
    }
  }
}
