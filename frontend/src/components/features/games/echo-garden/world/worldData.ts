import layoutJson from "./echoGardenLayout.json";
import type { CloudLayerConfig } from "./atmosphere";
import type { SatelliteConfig } from "./satellites";

/** Runtime half-tile size: screen = ((gx - gy) * 64, (gx + gy) * 32) at zoom 1. */
export const TILE_HALF_W = 64;
export const TILE_HALF_H = 32;

export const WORLD_BASE = "/garden/world/";

export interface SpriteEntry {
  file: string;
  w: number;
  h: number;
  /** anchor pixel (ground contact of the object's grid origin) */
  ax: number;
  ay: number;
  /** runtime scale = 1 / texel density */
  scale: number;
  glow?: string;
  /** separate shadow-factor sprite (composed at runtime, never baked into the terrain) */
  shadow?: { file: string; w: number; h: number; ax: number; ay: number; scale: number } | null;
}

export interface WhaleAtlasEntry {
  file: string;
  w: number;
  h: number;
  scale: number;
  rects: number[][];
}

export interface TerrainEntry {
  file: string;
  w: number;
  h: number;
  originPx: [number, number];
  scale: number;
  mobile: { file: string; w: number; h: number; originPx: [number, number]; scale: number };
  /** grass-cap mask for runtime shadow composition (black = cap) */
  shadowMask?: { file: string; w: number; h: number; scale: number };
}

export interface HeightMap {
  originGrid: [number, number];
  step: number;
  cols: number;
  rows: number;
  pxPerUnitZ: number;
  z: number[][];
}

export interface WorldManifest {
  version: number;
  pxPerUnitZ: number;
  terrain: TerrainEntry;
  /** Phase 2: per-season ground (same geometry / origin as `terrain`, which is the approved summer ground) */
  terrainSeasons?: Partial<Record<"spring" | "autumn" | "winter", Omit<TerrainEntry, "shadowMask">>>;
  sprites: Record<string, SpriteEntry>;
  /**
   * Phase 3B: the monument's era art keys (index = era; 0 = the approved `knowledge_tree`) and the ornament sockets
   * (zoom-1 px from the tree anchor at instance scale 1; ornament sprites `kt_orn_<family>_t<1..ornamentTiers>`).
   */
  monument?: {
    eras: string[]; sockets: Record<string, { dx: number; dy: number }>; ornamentTiers: number;
    /** Phase 3E: hanging points of the cosmetic charms (never a socket of an earned ornament) */
    cosmeticSockets?: Array<{ dx: number; dy: number }>;
  } | null;
  /** Phase 3E: per house sprite, where the chimney smoke rises (zoom-1 px from the sprite anchor at instance scale 1) */
  houses?: Record<string, { chimney: { dx: number; dy: number } }>;
  fish: Record<string, { file: string; w: number; h: number; pxPerBU: number }>;
  clouds: Array<{ file: string; w: number; h: number }>;
  whale?: { yaws: number; frames: number; lengthBU: number; atlas: WhaleAtlasEntry; atlasMobile: WhaleAtlasEntry } | null;
  heightmap: HeightMap;
}

export interface LayoutPlacement {
  key: string;
  gx: number;
  gy: number;
  s?: number;
  id?: string;
}

export interface EchoGardenLayout {
  grid: { width: number; height: number; center: [number, number] };
  /** stage: visual growth stage 1-4 (seedling, young, mature, harvest-ready) */
  starterPlots: Array<{ id: string; gx: number; gy: number; crop: string; stage?: number }>;
  farmProps: LayoutPlacement[];
  farmWalkways: Array<[number, number]>;
  futureFields: Array<{ id: string; rect: [number, number, number, number]; furrow: string; state: string }>;
  paths: Array<{ id: string; width: number; points: Array<[number, number]> }>;
  pond: { center: [number, number] };
  sanctuary: { center: [number, number]; radius: number };
  sprites: Array<LayoutPlacement & { id: string }>;
  trees: LayoutPlacement[];
  bushes: LayoutPlacement[];
  /** exactly two satellite islands (independent transforms, see world/satellites.ts) */
  satellites: SatelliteConfig[];
  /** atmospheric cloud layers (see world/atmosphere.ts) */
  atmosphere: { layers: CloudLayerConfig[] };
  /** growth along the farm fence foot (decorative sprites, never on plot / walkway / field cells) */
  farmEdges?: LayoutPlacement[];
  /** Phase 2: the three sacred spots for memory trees around the monumental Knowledge Tree (slot 1–3) */
  memoryGrove?: Array<{ slot: number; gx: number; gy: number }>;
  /** Phase 2: forest-edge anchors where graduated memory trees stand (newest first, bounded) */
  memoryForest?: Array<{ gx: number; gy: number; s: number }>;
  /**
   * Phase 3A: the four purchasable beds (slots 7–10, owner-approved cells inside marked future fields; mirrored by the
   * server configuration). A bed appears only once the server says the player owns it. `dy` is an art-only offset
   * inside the cell: the bed, its crops, the hint ring and the touch area move together (fence clearance).
   */
  expansionPlots?: Array<{ slot: number; gx: number; gy: number; dy?: number; field: string }>;
  /** Phase 3C farmland regions (slots 11+): reserved future-field cells, mirrored by V83 `garden_config.land`. */
  landRegions?: Array<{ code: string; field: string; plots: Array<{ slot: number; gx: number; gy: number }> }>;
  /** Phase 3C buildings: which approved sprite / corner each one is and how many level sprites it ships. */
  buildings?: Record<string, { sprite?: string; art: string; levels: number; gx?: number; gy?: number; replaces?: string[] }>;
  /** Phase 3A: touch area of the market stall at the seed-storage corner by the farm gate (gameplay only). */
  marketStall?: { gx: number; gy: number; radius: number };
  /**
   * Phase 3E: where decorations may stand (drawing aid only — the server's `garden_config.cosmetics.regions` decides;
   * the two are checked equal by the contracts).
   */
  decorRegions?: Array<{ code: string; rect: [number, number, number, number] }>;
  /**
   * Phase 3H: the animal quarter. One fixed lot per species house (`yard` = centre of the patch its animals stroll on)
   * and one post per guardian pet. Art only: capacity, ownership and every outcome are the server's.
   */
  animalQuarter?: {
    houses: Record<string, { art: string; gx: number; gy: number; yard: [number, number] }>;
    guardians: Record<string, { gx: number; gy: number }>;
  };
}

export const LAYOUT = layoutJson as unknown as EchoGardenLayout;

/**
 * Farm fence bays derived from the layout fence lines: each bay is a separate sprite (with its own
 * shadow) centred on its span, carrying the post at its low-gx / low-gy end; the gate is a sprite at
 * `farmGate`; an end post closes any line end that no bay or gate post already marks.
 */
export function fenceBays(layout: EchoGardenLayout): Array<{ key: string; gx: number; gy: number }> {
  const raw = layout as unknown as {
    fences: Array<{ from: [number, number]; to: [number, number] }>;
    farmGate?: [number, number];
  };
  const out: Array<{ key: string; gx: number; gy: number }> = [];
  const posts: Array<[number, number]> = [];
  if (raw.farmGate) {
    out.push({ key: "fence_gate", gx: raw.farmGate[0], gy: raw.farmGate[1] });
    posts.push([raw.farmGate[0] - 0.55, raw.farmGate[1]], [raw.farmGate[0] + 0.55, raw.farmGate[1]]);
  }
  const ends: Array<[number, number]> = [];
  raw.fences.forEach((f, li) => {
    // bays run from the low end to the high end of the line
    const alongX = Math.abs(f.to[0] - f.from[0]) >= Math.abs(f.to[1] - f.from[1]);
    const a = alongX ? (f.from[0] <= f.to[0] ? f.from : f.to) : (f.from[1] <= f.to[1] ? f.from : f.to);
    const b = a === f.from ? f.to : f.from;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(L / 1.0));
    const bay = L / n;
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const t1 = (k + 1) / n;
      const gx = a[0] + (b[0] - a[0]) * ((t0 + t1) / 2);
      const gy = a[1] + (b[1] - a[1]) * ((t0 + t1) / 2);
      const variant = (li + k) % 2 === 0 ? "a" : "b";
      const key = alongX ? (bay > 1.12 ? "fence_x_long" : `fence_x_${variant}`) : `fence_y_${variant}`;
      out.push({ key, gx, gy });
      posts.push([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0]);
    }
    ends.push([b[0], b[1]]);
  });
  ends.forEach(([gx, gy]) => {
    if (!posts.some(([px, py]) => Math.hypot(px - gx, py - gy) < 0.08)) {
      out.push({ key: "fence_post", gx, gy });
      posts.push([gx, gy]);
    }
  });
  return out;
}

export function gridToScreen(gx: number, gy: number): { x: number; y: number } {
  return { x: (gx - gy) * TILE_HALF_W, y: (gx + gy) * TILE_HALF_H };
}

/** Bilinear ground height (Blender units) from the baked terrain heightmap. */
export function groundHeight(hm: HeightMap | null, gx: number, gy: number): number {
  if (!hm) return 0;
  const fx = (gx - hm.originGrid[0]) / hm.step;
  const fy = (gy - hm.originGrid[1]) / hm.step;
  const x0 = Math.max(0, Math.min(hm.cols - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(hm.rows - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const z00 = hm.z[y0][x0];
  const z10 = hm.z[y0][x0 + 1];
  const z01 = hm.z[y0 + 1][x0];
  const z11 = hm.z[y0 + 1][x0 + 1];
  return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
}

/** Screen position of a grid point standing on the rendered ground. */
export function groundToScreen(hm: HeightMap | null, gx: number, gy: number): { x: number; y: number } {
  const p = gridToScreen(gx, gy);
  const z = groundHeight(hm, gx, gy);
  return { x: p.x, y: p.y - z * (hm?.pxPerUnitZ ?? 78.38) };
}

/** Catmull-Rom sampling identical to the Blender path painter (used by tests and debug overlay). */
export function sampleCatmull(points: Array<[number, number]>, n = 24): Array<[number, number]> {
  const pts = [points[0], ...points, points[points.length - 1]];
  const out: Array<[number, number]> = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
