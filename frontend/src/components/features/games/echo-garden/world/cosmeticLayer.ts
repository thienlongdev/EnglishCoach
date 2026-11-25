import { Container, Graphics, Polygon, Sprite, Texture, type FederatedPointerEvent } from "pixi.js";
import type { WorldManifest } from "./worldData";
import {
  bedSpriteKey, fenceSpriteKey, pathStamps, placementCheck, snapTo, vegetationSpriteKey,
  type CosmeticVisuals, type DecorRegion, type DecorVisual,
} from "./cosmetics";

/**
 * Echo Garden Phase 3E — what the island wears, driven only by server visuals.
 *
 * * Vegetation: the orchard / round trees, the green bushes and the flowering bushes each take the equipped appearance
 *   of their family (two forms per appearance); an appearance keeps its own look through the seasons, and taking it off
 *   returns every plant to the island's seasonal art.
 * * Fence, bed frames: the same sprites in another style (same cells, same touch targets, shadows follow).
 * * Paths: paving stamps laid along the baked paths (ground objects, no touch target).
 * * Monument set: a ring of decorations at the Knowledge Tree's roots and hanging charms on four cosmetic sockets —
 *   never on the sockets of the earned ornaments, never changing the tree's era art.
 * * Decorations: one sprite per placement the server reports, each a touch target (move / store).
 * * Placement preview: the decoration regions and a ghost at the point the player chose (green = may stand, red = may
 *   not, by the same rule the server applies). Confirming is a server command; nothing here writes anything.
 *
 * Art loads on demand: only what is worn or previewed is ever downloaded. Motion is closed-form in the environment
 * clock (charm sway); reduced motion keeps every state and drops the motion. Nothing here talks to the network.
 */

export interface CosmeticEntity {
  key: string;
  sprite: Sprite;
  glow?: Sprite;
  shadow?: Sprite;
  instanceScale: number;
  baseX: number;
  baseY: number;
  art: string;
}

export interface PlacementPreview { art: string; footprint: number; movingId: number | null }
export interface PlacementCandidate { gx: number; gy: number; ok: boolean; reason: "OUT_OF_BOUNDS" | "OVERLAP" | null; region: string | null }

export interface CosmeticLayerDeps {
  manifest: WorldManifest;
  groundFx: Container;
  entities: Container;
  emissive: Container;
  loadTexture: (file: string) => Promise<Texture | null>;
  createEntity: (key: string, gx: number, gy: number, opts: { ground?: boolean; scale?: number; footprint?: number; targetId?: string; z?: number })
    => CosmeticEntity | null;
  removeEntity: (e: CosmeticEntity) => void;
  /** swaps an entity's art (texture, anchor, shadow, glow) in place; false when the art is not shipped */
  retexture: (e: CosmeticEntity, art: string) => Promise<boolean>;
  /** the island's own art of a layout vegetation key right now (its seasonal variant) */
  ownArt: (baseKey: string) => string;
  vegetation: CosmeticEntity[];
  fences: CosmeticEntity[];
  beds: () => CosmeticEntity[];
  paths: Array<{ id: string; width: number; points: Array<[number, number]> }>;
  tree: CosmeticEntity | null;
  treeGrid: { gx: number; gy: number } | null;
  groundToScreen: (gx: number, gy: number) => { x: number; y: number };
  /** world point (zoom-1 px) → grid cell on the rendered ground */
  toGrid: (x: number, y: number) => { gx: number; gy: number };
  worldPoint: (ev: FederatedPointerEvent) => { x: number; y: number };
  isDragging: () => boolean;
  setHouseTheme: (theme: string | null) => void;
  onCandidate: (c: PlacementCandidate | null) => void;
  /** entities were added or re-dressed: the canvas refreshes night-glow weights and tints */
  onChanged: () => void;
  trackTint: (s: Sprite) => void;
}

interface Charm { sprite: Sprite; glow: Sprite | null; k: number; phase: number }

const CHARM_SCALE = 1.35;

export class CosmeticLayer {
  private want: CosmeticVisuals = { equipped: {}, decor: [], regions: [], snap: 0.25 };
  private readonly decor = new Map<number, { e: CosmeticEntity; v: DecorVisual }>();
  private stamps: CosmeticEntity[] = [];
  private pathStyle: string | null = null;
  private monumentSet: string | null = null;
  private monumentBase: CosmeticEntity | null = null;
  private charms: Charm[] = [];
  private gen = 0;
  private preview: PlacementPreview | null = null;
  private ghost: Sprite | null = null;
  private ghostArt: string | null = null;
  private readonly regionLayer = new Container();
  private candidate: PlacementCandidate | null = null;
  reduced = false;

  constructor(private readonly deps: CosmeticLayerDeps) {
    this.regionLayer.label = "decor-regions";
    this.regionLayer.visible = false;
    deps.groundFx.addChild(this.regionLayer);
  }

  /** Bring the island in line with the server visuals (idempotent; only differences do work). */
  apply(v: CosmeticVisuals) {
    const gen = ++this.gen;
    this.want = v;
    this.deps.setHouseTheme(v.equipped.HOUSE ?? null);
    void this.dressVegetation();
    void this.dressFence();
    void this.dressBeds();
    void this.dressPaths(gen);
    void this.dressMonument(gen);
    void this.syncDecor(gen);
    if (this.preview) this.drawRegions();
  }

  /** The art a layout vegetation sprite must show now: its family's equipped appearance, else the island's own. */
  vegetationArt(baseKey: string): string {
    const family = baseKey === "orchard" || baseKey === "oak_round" ? "TREE"
      : baseKey === "bush_a" || baseKey === "bush_b" ? "SHRUB"
        : baseKey === "bush_flower_pink" || baseKey === "bush_flower_white" ? "FLOWER" : null;
    const worn = family ? vegetationSpriteKey(this.deps.manifest.sprites, baseKey, this.want.equipped[family]) : null;
    return worn ?? this.deps.ownArt(baseKey);
  }

  private async dressVegetation() {
    let changed = false;
    for (const e of this.deps.vegetation) {
      const art = this.vegetationArt(e.key);
      if (art !== e.art) changed = (await this.deps.retexture(e, art)) || changed;
    }
    if (changed) this.deps.onChanged();
  }

  private async dressFence() {
    let changed = false;
    for (const e of this.deps.fences) {
      const art = fenceSpriteKey(this.deps.manifest.sprites, e.key, this.want.equipped.FENCE) ?? e.key;
      if (art !== e.art) changed = (await this.deps.retexture(e, art)) || changed;
    }
    if (changed) this.deps.onChanged();
  }

  /** Also called by the canvas when a bed is bought during play, so a new bed is born in the equipped frame. */
  async dressBeds() {
    const art = bedSpriteKey(this.deps.manifest.sprites, this.want.equipped.BED);
    let changed = false;
    for (const e of this.deps.beds()) if (e.art !== art) changed = (await this.deps.retexture(e, art)) || changed;
    if (changed) this.deps.onChanged();
  }

  private async dressPaths(gen: number) {
    const style = this.want.equipped.PATH ?? null;
    if (style === this.pathStyle) return;
    const { manifest } = this.deps;
    const forms = ["a", "b", "c"] as const;
    if (style) {
      // the three stamp textures of the style, loaded before any stamp is created
      for (const f of forms) {
        const entry = manifest.sprites[`path_${style}_${f}`];
        if (!entry || !(await this.deps.loadTexture(entry.file))) return;
        if (entry.glow) await this.deps.loadTexture(entry.glow);
      }
      if (gen !== this.gen) return;
    }
    this.stamps.forEach((s) => this.deps.removeEntity(s));
    this.stamps = [];
    this.pathStyle = style;
    if (style) {
      for (const p of pathStamps(this.deps.paths)) {
        const e = this.deps.createEntity(`path_${style}_${p.form}`, p.gx, p.gy, { ground: true, scale: p.scale, footprint: 0.3 });
        if (e) this.stamps.push(e);
      }
    }
    this.deps.onChanged();
  }

  private clearMonument() {
    if (this.monumentBase) this.deps.removeEntity(this.monumentBase);
    this.monumentBase = null;
    for (const c of this.charms) {
      c.sprite.destroy();
      c.glow?.destroy();
    }
    this.charms = [];
  }

  private async dressMonument(gen: number) {
    const set = this.want.equipped.MONUMENT ?? null;
    const { manifest, tree, treeGrid } = this.deps;
    if (set === this.monumentSet || !tree || !treeGrid) return;
    const keys = set ? [`kt_cos_${set}_base`, `kt_cos_${set}_a`, `kt_cos_${set}_b`] : [];
    const loaded: Record<string, { tex: Texture; glow: Texture | null }> = {};
    for (const k of keys) {
      const entry = manifest.sprites[k];
      const tex = entry ? await this.deps.loadTexture(entry.file) : null;
      if (!entry || !tex) return;   // a set the manifest does not ship leaves the tree as it is
      if (entry.shadow) await this.deps.loadTexture(entry.shadow.file);
      loaded[k] = { tex, glow: entry.glow ? await this.deps.loadTexture(entry.glow) : null };
    }
    if (gen !== this.gen || tree.sprite.destroyed) return;
    this.clearMonument();
    this.monumentSet = set;
    if (!set) {
      this.deps.onChanged();
      return;
    }
    // the root ring stands in front of the trunk: same anchor and instance scale as the tree, drawn just above it
    this.monumentBase = this.deps.createEntity(keys[0], treeGrid.gx, treeGrid.gy, { scale: tree.instanceScale, footprint: 3, z: tree.sprite.zIndex + 0.4 });
    const sockets = manifest.monument?.cosmeticSockets ?? [];
    sockets.forEach((socket, i) => {
      const key = keys[1 + (i % 2)];
      const entry = manifest.sprites[key];
      const art = loaded[key];
      const k = entry.scale * tree.instanceScale * CHARM_SCALE;
      const x = tree.baseX + socket.dx * tree.instanceScale;
      const y = tree.baseY + socket.dy * tree.instanceScale;
      const sprite = new Sprite(art.tex);
      sprite.eventMode = "none";
      sprite.label = `monument-charm-${i}`;
      sprite.zIndex = tree.sprite.zIndex + 1.2 + i * 0.001;
      sprite.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
      sprite.position.set(x, y);
      sprite.scale.set(k);
      this.deps.entities.addChild(sprite);
      this.deps.trackTint(sprite);
      let glow: Sprite | null = null;
      if (art.glow) {
        glow = new Sprite(art.glow);
        glow.blendMode = "add";
        glow.alpha = 0;
        glow.eventMode = "none";
        glow.anchor.copyFrom(sprite.anchor);
        glow.position.set(x, y);
        glow.scale.set(k);
        this.deps.emissive.addChild(glow);
      }
      this.charms.push({ sprite, glow, k, phase: 0.9 + i * 1.9 });
    });
    this.deps.onChanged();
  }

  private async syncDecor(gen: number) {
    const { manifest } = this.deps;
    const wanted = new Map(this.want.decor.map((d) => [d.id, d]));
    let changed = false;
    for (const [id, have] of this.decor) {
      const w = wanted.get(id);
      if (!w || w.gx !== have.v.gx || w.gy !== have.v.gy || w.art !== have.v.art) {
        this.deps.removeEntity(have.e);
        this.decor.delete(id);
        changed = true;
      }
    }
    for (const d of this.want.decor) {
      if (this.decor.has(d.id)) continue;
      const key = `decor_${d.art}`;
      const entry = manifest.sprites[key];
      if (!entry || !(await this.deps.loadTexture(entry.file))) continue;
      if (entry.glow) await this.deps.loadTexture(entry.glow);
      if (entry.shadow) await this.deps.loadTexture(entry.shadow.file);
      if (gen !== this.gen || this.decor.has(d.id)) return;
      const e = this.deps.createEntity(key, d.gx, d.gy, { footprint: Math.max(0.5, d.footprint * 1.6), targetId: `decor_${d.id}` });
      if (e) {
        this.decor.set(d.id, { e, v: d });
        changed = true;
      }
    }
    if (changed) this.deps.onChanged();
    if (this.preview) this.refreshGhostVisibility();
  }

  // ------------------------------------------------------------------ placement preview

  /** Enters (or leaves, with null) placement mode: regions drawn, a ghost of the decoration at the chosen point. */
  setPreview(p: PlacementPreview | null) {
    // the same request again (a re-render of the page) must not forget the point the player already chose
    const cur = this.preview;
    if (p && cur && p.art === cur.art && p.footprint === cur.footprint && (p.movingId ?? null) === (cur.movingId ?? null)) return;
    if (!p && !cur) return;
    this.preview = p;
    this.candidate = null;
    this.regionLayer.visible = !!p;
    if (!p) {
      if (this.ghost) this.ghost.visible = false;
      this.refreshGhostVisibility();
      this.deps.onCandidate(null);
      return;
    }
    this.drawRegions();
    this.refreshGhostVisibility();
    void this.loadGhost(p.art);
    this.deps.onCandidate(null);
  }

  /** While a standing decoration is being moved its own sprite is dimmed (the ghost shows where it would go). */
  private refreshGhostVisibility() {
    for (const [id, d] of this.decor) d.e.sprite.alpha = this.preview?.movingId === id ? 0.35 : 1;
  }

  private async loadGhost(art: string) {
    const entry = this.deps.manifest.sprites[`decor_${art}`];
    const tex = entry ? await this.deps.loadTexture(entry.file) : null;
    if (!entry || !tex || this.preview?.art !== art) return;
    if (!this.ghost) {
      this.ghost = new Sprite(tex);
      this.ghost.eventMode = "none";
      this.ghost.label = "decor-ghost";
      this.ghost.alpha = 0.78;
      this.deps.entities.addChild(this.ghost);
    }
    this.ghost.texture = tex;
    this.ghost.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
    this.ghost.scale.set(entry.scale);
    this.ghostArt = art;
    this.ghost.visible = !!this.candidate;
    if (this.candidate) this.placeGhost(this.candidate);
  }

  private regionPolygon(r: DecorRegion): number[] {
    const pts: number[] = [];
    const steps = 6;
    const edge = (x0: number, y0: number, x1: number, y1: number) => {
      for (let i = 0; i < steps; i++) {
        const p = this.deps.groundToScreen(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
        pts.push(p.x, p.y);
      }
    };
    // half a tile of margin so a decoration on the region's edge still stands inside the outline
    const m = 0.35;
    edge(r.x0 - m, r.y0 - m, r.x1 + m, r.y0 - m);
    edge(r.x1 + m, r.y0 - m, r.x1 + m, r.y1 + m);
    edge(r.x1 + m, r.y1 + m, r.x0 - m, r.y1 + m);
    edge(r.x0 - m, r.y1 + m, r.x0 - m, r.y0 - m);
    return pts;
  }

  private drawRegions() {
    this.regionLayer.removeChildren().forEach((c) => c.destroy());
    for (const r of this.want.regions) {
      const poly = this.regionPolygon(r);
      const g = new Graphics();
      g.poly(poly).fill({ color: 0xffe2a0, alpha: 0.13 }).stroke({ color: 0xffe2a0, alpha: 0.7, width: 2 });
      g.hitArea = new Polygon(poly);
      g.eventMode = "static";
      g.cursor = "pointer";
      g.label = `decor-region-${r.code}`;
      g.on("pointertap", (ev: FederatedPointerEvent) => {
        ev.stopPropagation();
        if (this.deps.isDragging() || !this.preview) return;
        const w = this.deps.worldPoint(ev);
        this.choose(w.x, w.y);
      });
      this.regionLayer.addChild(g);
    }
  }

  /** The player pointed at a world point: snap it to the placement grid and judge it by the server's rule. */
  choose(worldX: number, worldY: number) {
    if (!this.preview) return;
    const raw = this.deps.toGrid(worldX, worldY);
    const snap = this.want.snap || 0.25;
    this.chooseGrid(snapTo(raw.gx, snap), snapTo(raw.gy, snap));
  }

  chooseGrid(gx: number, gy: number) {
    if (!this.preview) return;
    const check = placementCheck(this.want, this.preview.footprint, gx, gy, this.preview.movingId);
    this.candidate = { gx, gy, ok: check.ok, reason: check.reason, region: check.region?.code ?? null };
    this.placeGhost(this.candidate);
    this.deps.onCandidate(this.candidate);
  }

  private placeGhost(c: PlacementCandidate) {
    if (!this.ghost || this.ghostArt !== this.preview?.art) return;
    const p = this.deps.groundToScreen(c.gx, c.gy);
    this.ghost.position.set(p.x, p.y);
    this.ghost.zIndex = p.y + 0.5;
    this.ghost.tint = c.ok ? 0xc9ffd6 : 0xff9a9a;
    this.ghost.visible = true;
  }

  /** Called every frame: charm sway on the environment clock (frozen when reduced), charm light by night. */
  update(envT: number, glow: number) {
    for (const c of this.charms) {
      const sway = this.reduced ? 0 : 0.05 * Math.sin(envT * 1.15 + c.phase) + 0.02 * Math.sin(envT * 0.55 + c.phase * 2.1);
      c.sprite.rotation = sway;
      if (c.glow) {
        c.glow.rotation = sway;
        c.glow.alpha = Math.min(0.8, 0.04 + glow * 0.66);
      }
    }
    if (this.regionLayer.visible) this.regionLayer.alpha = this.reduced ? 0.9 : 0.78 + 0.16 * Math.sin(envT * 1.8);
  }

  /** QA: what the island wears on screen. */
  stats() {
    return {
      equipped: { ...this.want.equipped },
      vegetation: this.deps.vegetation.filter((e) => e.art.startsWith("veg_")).map((e) => e.art),
      fences: [...new Set(this.deps.fences.map((e) => e.art))],
      beds: [...new Set(this.deps.beds().map((e) => e.art))],
      pathStyle: this.pathStyle,
      stamps: this.stamps.length,
      monumentSet: this.monumentSet,
      charms: this.charms.length,
      decor: [...this.decor.values()].map((d) => ({ id: d.v.id, art: d.v.art, gx: d.v.gx, gy: d.v.gy })),
      preview: this.preview,
      candidate: this.candidate,
      regions: this.regionLayer.visible ? this.regionLayer.children.length : 0,
    };
  }

  /** Run after the renderer is destroyed: stage children are already gone. */
  destroy() {
    this.charms = [];
    this.decor.clear();
    this.stamps = [];
    this.ghost = null;
  }
}
