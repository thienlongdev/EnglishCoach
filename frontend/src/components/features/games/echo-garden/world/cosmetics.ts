/**
 * Echo Garden Phase 3E — pure cosmetic helpers (no PixiJS, no network): which sprite an equipped appearance shows, where
 * path stamps lie and whether a decoration may stand at a point. The server owns ownership, prices and every position;
 * these functions only draw what it reports and pre-check a placement so the player sees the answer before asking.
 */

export type CosmeticSlot = "HOUSE" | "TREE" | "SHRUB" | "FLOWER" | "MONUMENT" | "FENCE" | "PATH" | "BED";
export const COSMETIC_SLOTS: CosmeticSlot[] = ["HOUSE", "TREE", "SHRUB", "FLOWER", "MONUMENT", "FENCE", "PATH", "BED"];

export interface DecorVisual { id: number; art: string; gx: number; gy: number; footprint: number }
export interface DecorRegion { code: string; nameVi: string; x0: number; y0: number; x1: number; y1: number }

/** What the island wears, from the server state only. `equipped`: slot → art key (absent = the island's own look). */
export interface CosmeticVisuals {
  equipped: Partial<Record<CosmeticSlot, string>>;
  decor: DecorVisual[];
  regions: DecorRegion[];
  snap: number;
}

type SpriteTable = Record<string, unknown>;

/**
 * The cottage sprite of a house family at a building level. `theme` null = the island's own timber cottage: the
 * approved `cottage` sprite at level 0 and the Phase 3E classic architecture above it. A level the manifest does not
 * ship falls back to the nearest lower one, then to the Phase 3C level art, then to the approved cottage — never empty.
 */
export function houseSpriteKey(sprites: SpriteTable, theme: string | null | undefined, level: number): string {
  const lv = Math.max(0, Math.min(3, Math.floor(level)));
  const family = theme && /^[a-z0-9_]+$/.test(theme) ? theme : "classic";
  for (let l = lv; l >= 0; l--) {
    const key = `house_${family}_l${l}`;
    if (sprites[key]) return key;
  }
  if (family !== "classic") return houseSpriteKey(sprites, null, level);
  for (let l = lv; l >= 1; l--) if (sprites[`cottage_l${l}`]) return `cottage_l${l}`;
  return "cottage";
}

/** Vegetation families: the layout sprites each one re-dresses and the art form (`a` / `b`) every sprite takes. */
export const VEGETATION: Record<"TREE" | "SHRUB" | "FLOWER", Record<string, "a" | "b">> = {
  TREE: { orchard: "a", oak_round: "b" },
  SHRUB: { bush_a: "a", bush_b: "b" },
  FLOWER: { bush_flower_pink: "a", bush_flower_white: "b" },
};

/** The family a layout vegetation key belongs to (null = never re-dressed: forest oaks, pines, ferns). */
export function vegetationFamily(baseKey: string): "TREE" | "SHRUB" | "FLOWER" | null {
  for (const family of ["TREE", "SHRUB", "FLOWER"] as const) if (VEGETATION[family][baseKey]) return family;
  return null;
}

/** Sprite of a vegetation appearance for one layout sprite, or null when the manifest lacks it (keep the island's own). */
export function vegetationSpriteKey(sprites: SpriteTable, baseKey: string, art: string | null | undefined): string | null {
  const family = vegetationFamily(baseKey);
  if (!family || !art || !/^[a-z0-9_]+$/.test(art)) return null;
  const key = `veg_${family.toLowerCase()}_${art}_${VEGETATION[family][baseKey]}`;
  return sprites[key] ? key : null;
}

/** `fence_x_a` → `fence_<style>_x_a` (the same seven bay sprites in another style), or null when it is not shipped. */
export function fenceSpriteKey(sprites: SpriteTable, baseKey: string, style: string | null | undefined): string | null {
  if (!style || !baseKey.startsWith("fence_") || !/^[a-z0-9_]+$/.test(style)) return null;
  const key = `fence_${style}_${baseKey.slice(6)}`;
  return sprites[key] ? key : null;
}

export function bedSpriteKey(sprites: SpriteTable, style: string | null | undefined): string {
  const key = style && /^[a-z0-9_]+$/.test(style) ? `bedframe_${style}` : "plot_bed";
  return sprites[key] ? key : "plot_bed";
}

/** Sprites the scene must NOT download at entry (they load only when an appearance is worn or previewed). */
export function isLazyCosmeticSprite(key: string): boolean {
  return /^(house_|veg_|kt_cos_|decor_|path_|bedframe_)/.test(key) || /^fence_(?!x_|y_|post$|gate$)/.test(key);
}

function catmull(points: Array<[number, number]>, n = 20): Array<[number, number]> {
  const pts = [points[0], ...points, points[points.length - 1]];
  const out: Array<[number, number]> = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

export interface PathStamp { gx: number; gy: number; form: "a" | "b" | "c"; scale: number }

/**
 * Paving stamps along the island's baked paths: evenly spaced by arc length on the same Catmull-Rom curve the terrain
 * painter used, alternating three forms, scaled to the path's width. Deterministic (the layout decides everything).
 */
export function pathStamps(paths: Array<{ id: string; width: number; points: Array<[number, number]> }>, spacing = 0.46): PathStamp[] {
  const out: PathStamp[] = [];
  const forms = ["a", "b", "c"] as const;
  paths.forEach((path, pi) => {
    const line = catmull(path.points);
    let carried = spacing * 0.5;
    let n = 0;
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1];
      const [x1, y1] = line[i];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      let at = spacing - carried;
      while (at <= seg) {
        const t = seg > 0 ? at / seg : 0;
        out.push({ gx: x0 + (x1 - x0) * t, gy: y0 + (y1 - y0) * t, form: forms[(n + pi) % 3], scale: Math.max(0.6, Math.min(1.15, path.width / 0.54)) });
        n++;
        at += spacing;
      }
      carried = (carried + seg) % spacing;
    }
  });
  return out;
}

export function snapTo(v: number, snap: number): number {
  return Math.round(Math.round(v / snap) * snap * 100) / 100;
}

export function regionAt(regions: DecorRegion[], gx: number, gy: number): DecorRegion | null {
  return regions.find((r) => gx >= r.x0 - 1e-9 && gx <= r.x1 + 1e-9 && gy >= r.y0 - 1e-9 && gy <= r.y1 + 1e-9) ?? null;
}

/**
 * The server's placement rule, mirrored for the preview: inside a region and clear of every other decoration by the
 * sum of the two footprints. (`movingId`: the decoration being moved never blocks itself.) The server still decides.
 */
export function placementCheck(v: Pick<CosmeticVisuals, "decor" | "regions">, footprint: number, gx: number, gy: number,
  movingId: number | null = null): { ok: boolean; reason: "OUT_OF_BOUNDS" | "OVERLAP" | null; region: DecorRegion | null } {
  const region = regionAt(v.regions, gx, gy);
  if (!region) return { ok: false, reason: "OUT_OF_BOUNDS", region: null };
  for (const d of v.decor) {
    if (d.id === movingId) continue;
    if (Math.hypot(d.gx - gx, d.gy - gy) < footprint + d.footprint - 1e-9) return { ok: false, reason: "OVERLAP", region };
  }
  return { ok: true, reason: null, region };
}
