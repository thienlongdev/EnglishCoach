import { Container, Ellipse, Graphics, Polygon, Sprite, Texture, type FederatedPointerEvent } from "pixi.js";
import type { ShadowLayer, ShadowSpec } from "./shadowLayer";
import type { SpriteEntry, WorldManifest } from "./worldData";
import type { FarmEntity } from "./farmLayer";
import { houseSpriteKey } from "./cosmetics";

/**
 * Echo Garden Phase 3C — the estate on the island, driven only by server visuals.
 *
 * * Buildings: the cottage and the storehouse (the tool shed) keep their approved sprite, anchor and place; a level
 *   only swaps the art (`cottage_l1..3`, `shed_l1..3`) together with its shadow and glow, so nothing jumps and no ghost
 *   shadow remains. The market stall replaces the three seed-corner props with one composite sprite
 *   (`market_stall_l1..3`) on the same corner; level 0 keeps the approved props.
 * * Farmland: every regional bed cell of the layout is a whole-cell touch target. A locked cell shows a staked claim
 *   (`land_claim`); the cell the player can buy now breathes a soft ring; an owned cell hands over to the farm layer
 *   (the approved raised bed + live crops) and its claim leaves with its shadow.
 *
 * Textures load on demand; motion is closed-form in the environment clock; nothing here talks to the network.
 */

export type BuildingCode = "COTTAGE" | "WAREHOUSE" | "MARKET";
export interface LandCellVisual { slot: number; state: "owned" | "next" | "locked" }
export interface EstateVisuals { buildings: Record<BuildingCode, number>; land: LandCellVisual[] }

export interface LandCell { slot: number; gx: number; gy: number; x: number; y: number; field: string }

export interface EstateDeps {
  manifest: WorldManifest;
  shadows: ShadowLayer;
  ring: Texture;
  groundFx: Container;
  emissive: Container;
  loadTexture: (file: string) => Promise<Texture | null>;
  /** the approved building entities (re-textured by level); null when the art is missing */
  cottage: FarmEntity | null;
  shed: FarmEntity | null;
  /** the seed-corner props (crates, sacks, barrel) the stall sprite replaces from level 1 */
  stallProps: FarmEntity[];
  stall: { gx: number; gy: number } | null;
  createEntity: (key: string, gx: number, gy: number, opts: { ground?: boolean; footprint?: number }) => FarmEntity | null;
  cells: LandCell[];
  diamond: (gx: number, gy: number) => number[];
  onSelect: (id: string) => void;
  isDragging: () => boolean;
  /** creates the raised bed of an owned cell and registers it with the farm layer (idempotent) */
  ownBed: (slot: number) => void;
  hasBed: (slot: number) => boolean;
  /** called after a building was re-textured (its touch target follows the new silhouette); `key` = the art shown */
  onRetexture?: (e: FarmEntity, entry: SpriteEntry, key: string) => void;
}

interface Cell extends LandCell {
  claim: FarmEntity | null;
  hit: Graphics;
  state: "owned" | "next" | "locked";
  pending: boolean;
}

const BUILDING_ART: Record<"COTTAGE" | "WAREHOUSE", string> = { COTTAGE: "cottage", WAREHOUSE: "shed" };

/** Art key of a building at a level; level 0 (or a level the manifest does not ship) = the approved base sprite. */
export function buildingSpriteKey(manifest: WorldManifest, base: string, level: number): string {
  for (let l = Math.max(0, Math.floor(level)); l >= 1; l--) {
    const key = `${base}_l${l}`;
    if (manifest.sprites[key]) return key;
  }
  return base;
}

export class EstateLayer {
  private readonly cells = new Map<number, Cell>();
  private readonly hints: Sprite[] = [];
  private readonly shown: Record<string, string> = {};
  private gen: Record<string, number> = {};
  private stall: FarmEntity | null = null;
  private stallKey: string | null = null;
  private stallGen = 0;
  private levels: Record<BuildingCode, number> = { COTTAGE: 0, WAREHOUSE: 0, MARKET: 0 };
  /** Phase 3E: the house family the cottage wears (null = the island's own timber cottage); art only */
  private houseTheme: string | null = null;
  reduced = false;

  constructor(private readonly deps: EstateDeps) {
    for (const c of deps.cells) {
      const poly = deps.diamond(c.gx, c.gy);
      const hit = new Graphics();
      hit.poly(poly).fill({ color: 0xffffff, alpha: 0.001 });
      hit.hitArea = new Polygon(poly);
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.label = `land-hit-${c.slot}`;
      hit.on("pointertap", (ev: FederatedPointerEvent) => {
        ev.stopPropagation();
        if (deps.isDragging()) return;
        // an owned cell is an ordinary bed; a locked one opens its land card
        deps.onSelect(deps.hasBed(c.slot) ? `plot_${c.slot}` : `land_${c.slot}`);
      });
      deps.groundFx.addChild(hit);
      this.cells.set(c.slot, { ...c, claim: null, hit, state: "locked", pending: false });
    }
  }

  /** Bring buildings and farmland in line with the server visuals (idempotent; only differences do work). */
  apply(v: EstateVisuals) {
    this.levels = { ...v.buildings };
    if (this.deps.cottage) void this.retexture("COTTAGE", this.deps.cottage, v.buildings.COTTAGE);
    if (this.deps.shed) void this.retexture("WAREHOUSE", this.deps.shed, v.buildings.WAREHOUSE);
    void this.showStall(v.buildings.MARKET);
    const next: Cell[] = [];
    for (const lv of v.land) {
      const cell = this.cells.get(lv.slot);
      if (!cell) continue;
      cell.state = lv.state;
      if (lv.state === "owned") {
        this.deps.ownBed(cell.slot);
        if (cell.claim) this.setVisible(cell.claim, false);
      } else {
        void this.ensureClaim(cell);
        if (lv.state === "next") next.push(cell);
      }
    }
    // one breathing ring per cell that can be bought now (at most one per region)
    while (this.hints.length < next.length) {
      const r = new Sprite(this.deps.ring);
      r.anchor.set(0.5);
      r.tint = 0xffe2a0;
      r.alpha = 0;
      r.eventMode = "none";
      r.label = "land-hint";
      this.deps.groundFx.addChild(r);
      this.hints.push(r);
    }
    this.hints.forEach((r, i) => {
      const c = next[i];
      r.visible = !!c;
      if (!c) return;
      r.position.set(c.x, c.y);
      r.scale.set(122 / this.deps.ring.width, 61 / this.deps.ring.height);
    });
  }

  /**
   * Phase 3E: the cottage's appearance family. The building LEVEL stays the server's (and keeps its perks): only the
   * sprite of that level changes, on the same anchor.
   */
  setHouseTheme(theme: string | null) {
    if (theme === this.houseTheme) return;
    this.houseTheme = theme;
    if (this.deps.cottage) void this.retexture("COTTAGE", this.deps.cottage, this.levels.COTTAGE);
  }

  private setVisible(e: FarmEntity, visible: boolean) {
    e.sprite.visible = visible;
    if (e.shadow) this.deps.shadows.setVisible(e.shadow, visible);
    if (e.glow) e.glow.visible = visible;
  }

  private async load(key: string): Promise<{ entry: SpriteEntry; tex: Texture; glow: Texture | null; shadow: Texture | null } | null> {
    const entry = this.deps.manifest.sprites[key];
    if (!entry) return null;
    const tex = await this.deps.loadTexture(entry.file);
    const glow = entry.glow ? await this.deps.loadTexture(entry.glow) : null;
    const shadow = entry.shadow ? await this.deps.loadTexture(entry.shadow.file) : null;
    return tex ? { entry, tex, glow, shadow } : null;
  }

  private async ensureClaim(cell: Cell) {
    if (cell.claim) {
      this.setVisible(cell.claim, true);
      return;
    }
    if (cell.pending) return;
    cell.pending = true;
    const art = await this.load("land_claim");
    cell.pending = false;
    if (!art || cell.claim) return;
    cell.claim = this.deps.createEntity("land_claim", cell.gx, cell.gy, { ground: true, footprint: 0.9 });
    // the purchase may have arrived while the art was loading
    if (cell.claim && cell.state === "owned") this.setVisible(cell.claim, false);
  }

  /** Swaps a building's art for its level: same anchor point, same instance scale, shadow and glow follow. */
  private async retexture(code: "COTTAGE" | "WAREHOUSE", e: FarmEntity, level: number) {
    const key = code === "COTTAGE" ? houseSpriteKey(this.deps.manifest.sprites, this.houseTheme, level)
      : buildingSpriteKey(this.deps.manifest, BUILDING_ART[code], level);
    if (this.shown[code] === key || (this.shown[code] === undefined && key === BUILDING_ART[code])) {
      this.shown[code] = key;
      return;
    }
    const gen = (this.gen[code] = (this.gen[code] ?? 0) + 1);
    const art = await this.load(key);
    if (!art || gen !== this.gen[code] || e.sprite.destroyed) return;
    const { entry, tex, glow, shadow } = art;
    const k = entry.scale * e.instanceScale;
    e.sprite.texture = tex;
    e.sprite.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
    e.sprite.scale.set(k);
    if (glow) {
      if (!e.glow) {
        // emissive light lives outside the graded scene (the canvas drives its alpha with the time of day)
        const g = new Sprite(glow);
        g.position.copyFrom(e.sprite.position);
        g.blendMode = "add";
        g.alpha = 0;
        g.eventMode = "none";
        this.deps.emissive.addChild(g);
        e.glow = g;
      }
      e.glow.texture = glow;
      e.glow.anchor.copyFrom(e.sprite.anchor);
      e.glow.scale.set(k);
      e.glow.visible = true;
    } else if (e.glow) {
      e.glow.visible = false;
    }
    if (entry.shadow && shadow) {
      const spec: ShadowSpec = { texture: shadow, ax: entry.shadow.ax, ay: entry.shadow.ay, scale: entry.shadow.scale };
      if (e.shadow) this.deps.shadows.replace(e.shadow, spec, e.instanceScale);
      else e.shadow = this.deps.shadows.add(spec, e.baseX, e.baseY, e.instanceScale);
    }
    this.shown[code] = key;
    this.deps.onRetexture?.(e, entry, key);
  }

  /** The market stall: level 0 keeps the approved props; from level 1 one composite sprite stands on their corner. */
  private async showStall(level: number) {
    const at = this.deps.stall;
    if (!at) return;
    const key = level > 0 ? buildingSpriteKey(this.deps.manifest, "market_stall", level) : null;
    const want = key && key !== "market_stall" ? key : null;
    if (want === this.stallKey) return;
    const gen = ++this.stallGen;
    if (!want) {
      if (this.stall) this.setVisible(this.stall, false);
      this.deps.stallProps.forEach((p) => this.setVisible(p, true));
      this.stallKey = null;
      return;
    }
    const art = await this.load(want);
    if (!art || gen !== this.stallGen) return;
    if (!this.stall) {
      this.stall = this.deps.createEntity(want, at.gx, at.gy, { footprint: 1 });
      if (!this.stall) return;
    } else {
      const { entry, tex, glow, shadow } = art;
      const e = this.stall;
      const k = entry.scale * e.instanceScale;
      e.sprite.texture = tex;
      e.sprite.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
      e.sprite.scale.set(k);
      if (e.glow && glow) {
        e.glow.texture = glow;
        e.glow.anchor.copyFrom(e.sprite.anchor);
        e.glow.scale.set(k);
      }
      if (entry.shadow && shadow) {
        const spec: ShadowSpec = { texture: shadow, ax: entry.shadow.ax, ay: entry.shadow.ay, scale: entry.shadow.scale };
        if (e.shadow) this.deps.shadows.replace(e.shadow, spec, e.instanceScale);
        else e.shadow = this.deps.shadows.add(spec, e.baseX, e.baseY, e.instanceScale);
      }
      this.setVisible(e, true);
    }
    this.deps.stallProps.forEach((p) => this.setVisible(p, false));
    this.stallKey = want;
  }

  /** Touch ellipse hugging a building sprite's visible mass (the canvas uses it after a re-texture). */
  static bodyHit(entry: SpriteEntry): Ellipse {
    return new Ellipse(-entry.ax + entry.w * 0.5, -entry.ay + entry.h * 0.55, entry.w * 0.46, entry.h * 0.45);
  }

  /** Called every frame: the cells that can be bought now breathe on the environment clock (frozen when reduced). */
  update(envT: number) {
    const a = this.reduced ? 0.5 : 0.4 + 0.16 * Math.sin(envT * 1.6);
    for (const r of this.hints) if (r.visible) r.alpha = a;
  }

  stats() {
    const cells = [...this.cells.values()];
    return {
      buildings: { ...this.levels },
      houseTheme: this.houseTheme,
      art: { cottage: this.shown.COTTAGE ?? "cottage", shed: this.shown.WAREHOUSE ?? "shed", stall: this.stallKey },
      land: {
        cells: cells.length,
        owned: cells.filter((c) => c.state === "owned").map((c) => c.slot),
        next: cells.filter((c) => c.state === "next").map((c) => c.slot),
        claims: cells.filter((c) => c.claim?.sprite.visible).map((c) => c.slot),
      },
    };
  }
}
