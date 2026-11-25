/* Echo Living Planet — what is under the learner's pointer. The same deterministic terrain function that shaped the
   planet (terrain.ts) and the props the builder placed (build.ts) say what a point of the surface IS: ocean, shallows,
   beach, forest (and its trees), hill, mountain, snow, the volcano and its lava, a village, a sea stack, or a region's
   landmark. Nothing here is a learning claim: a feature only names what is drawn; the only learning link is the region
   the land belongs to (a real Odyssey region with real stations). Pure functions (no three.js), testable in Node. */
import type { Terrain, TerrainSample } from './terrain';
import { biomeName } from './terrain';
import type { PlanetBuild, PropKind } from './build';
import { SITES, type Biome, type Landmark } from './layout';

export type FeatureKind = 'ocean' | 'shallows' | 'stack' | 'beach' | 'volcano' | 'lava' | 'ice' | 'peak' | 'mountain' | 'hill' | 'forest' | 'village' | 'landmark' | 'land';
export type V3 = [number, number, number];
export interface Feature {
  kind: FeatureKind;
  /** The Odyssey region the point belongs to (its land), or null for open ocean and wild islands. */
  site: string | null;
  biome: Biome | null;
  landmark: Landmark | null;
  /** The nearest tree drawn there (forests), when one stands within reach. */
  tree: PropKind | null;
  /** Surface point (world units) and its outward direction. */
  point: V3; dir: V3;
  /** Elevation relative to sea level. */
  h: number;
}

const RAD = Math.PI / 180;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const angle = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b)))));

/**
 * Where a ray first meets the drawn surface (land at R + h, water at sea level R). Marches from the outer shell inwards
 * with steps no longer than the remaining clearance, then refines by bisection. null when the ray misses the planet.
 */
export function surfaceHit(terrain: Terrain, s: TerrainSample, origin: V3, direction: V3, R: number, maxH = 14): { point: V3; dir: V3; h: number } | null {
  const d = norm(direction);
  const shell = (r: number) => {
    const b = dot(origin, d), c = dot(origin, origin) - r * r, disc = b * b - c;
    if (disc < 0) return null;
    const q = Math.sqrt(disc);
    return [-b - q, -b + q] as const;
  };
  const outer = shell(R + maxH);
  if (!outer || outer[1] < 0) return null;
  const inner = shell(R);
  let t = Math.max(0, outer[0]);
  const end = inner && inner[0] > 0 ? inner[0] : outer[1];
  const at = (u: number): V3 => [origin[0] + d[0] * u, origin[1] + d[1] * u, origin[2] + d[2] * u];
  const clearance = (p: V3) => {
    const r = Math.hypot(p[0], p[1], p[2]);
    terrain.sample(p[0] / r, p[1] / r, p[2] / r, s);
    return r - (R + Math.max(0, s.h));
  };
  let prev = t, prevC = clearance(at(t));
  for (let i = 0; i < 160 && t < end; i++) {
    const step = Math.max(0.12, Math.min(4, prevC * 0.6));
    t = Math.min(end, t + step);
    const c = clearance(at(t));
    if (c <= 0) {
      let lo = prev, hi = t;
      for (let k = 0; k < 6; k++) { const mid = (lo + hi) / 2; if (clearance(at(mid)) <= 0) hi = mid; else lo = mid; }
      t = hi; break;
    }
    prev = t; prevC = c;
  }
  const p = at(t), dir = norm(p);
  terrain.sample(dir[0], dir[1], dir[2], s);
  const h = s.h, r = R + Math.max(0, h);
  return { point: [dir[0] * r, dir[1] * r, dir[2] * r], dir, h };
}

/** The nearest prop of some kinds to a point, looking in the two clusters whose centres are closest (a point near a border may be either side). */
export function nearestProp(build: PlanetBuild, kinds: PropKind[], dir: V3, point: V3, within: number): { kind: PropKind; dist: number } | null {
  let best: { kind: PropKind; dist: number } | null = null;
  for (const kind of kinds) {
    const clusters = build.props[kind];
    if (!clusters?.length) continue;
    const order = clusters.map((c, i) => [dot(norm(c.center), dir), i] as const).sort((a, b) => b[0] - a[0]).slice(0, 2);
    for (const [, ci] of order) {
      const c = clusters[ci], m = c.matrices;
      for (let k = 0; k < c.count; k++) {
        const o = k * 16, dx = m[o + 12] - point[0], dy = m[o + 13] - point[1], dz = m[o + 14] - point[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist < within && (!best || dist < best.dist)) best = { kind, dist };
      }
    }
  }
  return best;
}

const TREES: PropKind[] = ['broad', 'conifer', 'palm', 'cypress', 'acacia', 'willow', 'snowpine', 'birch'];

/** What the drawn planet has at this surface point (see the file note: a name of what is drawn, never a learning claim). */
export function classify(terrain: Terrain & { volcano: { x: number; y: number; z: number } | null }, s: TerrainSample, build: PlanetBuild, hit: { point: V3; dir: V3; h: number }): Feature {
  const { point, dir } = hit;
  terrain.sample(dir[0], dir[1], dir[2], s);
  const h = s.h, siteIndex = s.site, site = siteIndex >= 0 ? SITES[siteIndex] : null;
  const biome = biomeName(s.biome);
  const base = { site: site?.id ?? null, biome, landmark: null as Landmark | null, tree: null as PropKind | null, point, dir, h };
  if (h < 0) {
    if (nearestProp(build, ['stack'], dir, point, 1.6)) return { ...base, kind: 'stack' };
    return { ...base, kind: h < -2.2 ? 'ocean' : 'shallows' };
  }
  // A region's landmark: its plateau around the anchor.
  if (site) {
    const built = build.sites.find(x => x.id === site.id);
    if (built && s.pad > 0.45 && angle(dir, built.up) < 3.4 * RAD) return { ...base, kind: 'landmark', landmark: site.landmark };
  }
  const v = terrain.volcano;
  if (v && angle(dir, [v.x, v.y, v.z]) < 4.4 * RAD) return { ...base, kind: s.special > 0.35 ? 'lava' : 'volcano' };
  if (biome === 'volcanic' && s.special > 0.4) return { ...base, kind: 'lava' };
  if (nearestProp(build, ['house', 'tallhouse'], dir, point, 1.5)) return { ...base, kind: 'village' };
  if (s.snow > 0.55) return { ...base, kind: biome === 'polar' && h < 6 ? 'ice' : 'peak' };
  const rock = nearestProp(build, ['peak', 'crag'], dir, point, 2.6);
  if ((rock && h > 2) || (h > 5.5 && s.pad < 0.3)) return { ...base, kind: 'mountain' };
  if (s.forest > 0.38) return { ...base, kind: 'forest', tree: nearestProp(build, TREES, dir, point, 2.4)?.kind ?? null };
  if (s.sand > 0.5 && h < 0.85) return { ...base, kind: 'beach' };
  if (h > 2.6 && s.pad < 0.3) return { ...base, kind: 'hill' };
  return { ...base, kind: 'land' };
}

/* The names a feature is told by: Vietnamese first, the English word the learner may look up (the real dictionary opens
   on an explicit click; no definition, IPA or example is authored here). */
type Words = { vi: string; en: string; word: string };
const KIND: Record<Exclude<FeatureKind, 'landmark' | 'land' | 'forest'>, Words> = {
  ocean: { vi: 'Đại dương', en: 'Ocean', word: 'ocean' },
  shallows: { vi: 'Vùng nước nông', en: 'Shallow water', word: 'shallows' },
  stack: { vi: 'Cột đá biển', en: 'Sea stack', word: 'sea stack' },
  beach: { vi: 'Bãi biển', en: 'Beach', word: 'beach' },
  volcano: { vi: 'Núi lửa', en: 'Volcano', word: 'volcano' },
  lava: { vi: 'Dung nham', en: 'Lava', word: 'lava' },
  ice: { vi: 'Băng tuyết', en: 'Ice', word: 'ice' },
  peak: { vi: 'Đỉnh núi tuyết', en: 'Snowy peak', word: 'peak' },
  mountain: { vi: 'Núi', en: 'Mountain', word: 'mountain' },
  hill: { vi: 'Đồi', en: 'Hill', word: 'hill' },
  village: { vi: 'Ngôi làng', en: 'Village', word: 'village' },
};
const LAND: Record<Biome, Words> = {
  meadow: { vi: 'Đồng cỏ', en: 'Meadow', word: 'meadow' }, blossom: { vi: 'Đồng cỏ hoa', en: 'Meadow', word: 'meadow' },
  forest: { vi: 'Rừng thưa', en: 'Woodland', word: 'woodland' }, cliffs: { vi: 'Vách đá', en: 'Cliffs', word: 'cliff' },
  tropical: { vi: 'Hòn đảo', en: 'Island', word: 'island' }, coastal: { vi: 'Miền duyên hải', en: 'Coast', word: 'coast' },
  autumn: { vi: 'Rừng thưa', en: 'Woodland', word: 'woodland' }, ink: { vi: 'Đồng cỏ', en: 'Meadow', word: 'meadow' },
  archipelago: { vi: 'Hòn đảo', en: 'Island', word: 'island' }, port: { vi: 'Cánh đồng', en: 'Fields', word: 'field' },
  savanna: { vi: 'Xavan', en: 'Savanna', word: 'savanna' }, alpine: { vi: 'Thung lũng', en: 'Valley', word: 'valley' },
  polar: { vi: 'Lãnh nguyên', en: 'Tundra', word: 'tundra' }, sanctuary: { vi: 'Đồng cỏ', en: 'Meadow', word: 'meadow' },
  volcanic: { vi: 'Cánh đồng dung nham', en: 'Lava field', word: 'lava field' },
};
const WILD: Words = { vi: 'Hòn đảo hoang', en: 'Wild island', word: 'island' };
const LANDMARK: Record<Landmark, Words> = {
  lighthouse: { vi: 'Ngọn hải đăng', en: 'Lighthouse', word: 'lighthouse' }, pavilion: { vi: 'Vọng lâu', en: 'Pavilion', word: 'pavilion' },
  worldtree: { vi: 'Cây cổ thụ', en: 'Great tree', word: 'tree' }, tidetower: { vi: 'Tháp thủy triều', en: 'Tide tower', word: 'tower' },
  atoll: { vi: 'Đảo san hô vòng', en: 'Atoll', word: 'atoll' }, amphitheatre: { vi: 'Nhà hát ngoài trời', en: 'Amphitheatre', word: 'amphitheatre' },
  library: { vi: 'Thư viện', en: 'Library', word: 'library' }, scriptorium: { vi: 'Phòng chép sách', en: 'Scriptorium', word: 'scriptorium' },
  bridges: { vi: 'Những cây cầu', en: 'Bridges', word: 'bridge' }, port: { vi: 'Bến cảng', en: 'Harbour', word: 'harbour' },
  windmills: { vi: 'Cối xay gió', en: 'Windmills', word: 'windmill' }, citadel: { vi: 'Thành lũy', en: 'Citadel', word: 'citadel' },
  observatory: { vi: 'Đài thiên văn', en: 'Observatory', word: 'observatory' }, stonecircle: { vi: 'Vòng đá cổ', en: 'Stone circle', word: 'stone circle' },
  gateway: { vi: 'Cổng đá', en: 'Gateway', word: 'gateway' },
};
const TREE: Partial<Record<PropKind, Words>> = {
  conifer: { vi: 'Rừng thông', en: 'Pine forest', word: 'pine' }, snowpine: { vi: 'Rừng thông tuyết', en: 'Snowy pine forest', word: 'pine' },
  palm: { vi: 'Rừng cọ', en: 'Palm grove', word: 'palm' }, birch: { vi: 'Rừng bạch dương', en: 'Birch wood', word: 'birch' },
  willow: { vi: 'Hàng liễu', en: 'Willows', word: 'willow' }, cypress: { vi: 'Rừng bách', en: 'Cypress grove', word: 'cypress' },
  acacia: { vi: 'Rừng keo', en: 'Acacia trees', word: 'acacia' }, broad: { vi: 'Rừng lá rộng', en: 'Broadleaf forest', word: 'forest' },
};
const FOREST: Words = { vi: 'Khu rừng', en: 'Forest', word: 'forest' };

export function featureWords(f: Pick<Feature, 'kind' | 'biome' | 'landmark' | 'tree' | 'site'>): Words {
  if (f.kind === 'landmark' && f.landmark) return LANDMARK[f.landmark];
  if (f.kind === 'forest') return (f.tree && TREE[f.tree]) || FOREST;
  if (f.kind === 'land') return f.biome ? LAND[f.biome] : WILD;
  return KIND[f.kind as keyof typeof KIND];
}

/** The visual answer of the planet to a touch (surfaceFx.ts): which particles, if any, and whether the sea ripples. */
export type Response = 'ripple' | 'birds' | 'dust' | 'petals' | 'sparkle' | 'smoke' | 'erupt' | 'pulse';
export function responseOf(f: Pick<Feature, 'kind' | 'biome'>): Response {
  switch (f.kind) {
    case 'ocean': case 'shallows': case 'beach': case 'stack': return 'ripple';
    case 'forest': return 'birds';
    case 'volcano': case 'lava': return 'erupt';
    case 'ice': case 'peak': return 'sparkle';
    case 'mountain': case 'hill': return 'dust';
    case 'village': return 'smoke';
    case 'landmark': return 'pulse';
    default: return f.biome === 'blossom' || f.biome === 'meadow' || f.biome === 'sanctuary' || f.biome === 'ink' ? 'petals' : f.biome === 'polar' ? 'sparkle' : 'dust';
  }
}
