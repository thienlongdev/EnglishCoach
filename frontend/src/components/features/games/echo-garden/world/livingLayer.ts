import { Container, Ellipse, Graphics, Sprite, Texture, type FederatedPointerEvent } from "pixi.js";
import type { ShadowLayer } from "./shadowLayer";
import type { WorldManifest } from "./worldData";
import type { FarmEntity } from "./farmLayer";
import type { GardenSpecies } from "../../../../../types/garden";
import { treeSpriteKey } from "../game/gardenModel";

/**
 * Echo Garden Phase 2 — the living memory on the island, driven only by server visuals.
 *
 * * Sacred grove: three spots (mossy stone rings) around the monumental Knowledge Tree. A spot shows the player's
 *   memory tree (species = the season it was planted in, stage 1–4). Health is shown, never hidden: a tree that needs
 *   care loses a little colour and droops slightly; its highest stage is never taken away. Essence ready to collect
 *   rises as a few teal motes from the roots; an open spot glows faintly as an invitation.
 * * Memory Forest: graduated trees appear at fixed forest-edge anchors (bounded by the anchor count; the collection
 *   panel lists every one).
 * * Forgotten Pests: a small lavender caterpillar on the bed or at the tree's roots, wrapped in a soft lavender haze
 *   while its word is unreviewed; after a genuine review it pales, waiting to be sent away.
 *
 * One entity per (place, art key): showing another stage hides the previous entity together with its shadow and glow
 * (no ghost). Motion is closed-form in the environment clock; textures load on demand; no network access.
 */

export interface GroveTreeVisual {
  id: number;
  species: GardenSpecies;
  stage: number;
  health: "HEALTHY" | "THIRSTY" | "WILTING";
  essenceReady: boolean;
}

export interface GroveVisual { slot: number; unlocked: boolean; tree: GroveTreeVisual | null }
export interface PestVisual {
  id: number; host: "CROP" | "TREE"; plotSlot: number | null; treeSlot: number | null; reviewed: boolean;
  /** Phase 3C: damage stage of a crop pest (1 warning, 2 nibbling, 3 the crop wilts, 0 resolved); 1 for tree pests. */
  stage?: number;
}
export interface LivingVisuals { grove: GroveVisual[]; forest: Array<{ id: number; species: GardenSpecies }>; pests: PestVisual[] }

type Place = { x: number; y: number; gx: number; gy: number };

export interface LivingDeps {
  manifest: WorldManifest;
  shadows: ShadowLayer;
  soft: Texture;
  ring: Texture;
  groundFx: Container;
  fxLayer: Container;
  hitLayer: Container;
  loadTexture: (file: string) => Promise<Texture | null>;
  createEntity: (key: string, gx: number, gy: number, opts: { ground?: boolean; scale?: number; footprint?: number }) => FarmEntity | null;
  /** releases an entity for good (sprite, glow, shadow): a pest that left never comes back as the same object */
  removeEntity: (e: FarmEntity) => void;
  onSelect: (id: string) => void;
  isDragging: () => boolean;
  spots: Array<Place & { slot: number }>;
  forest: Array<Place & { s: number }>;
  beds: Map<number, Place>;
}

/** A place that shows one of several art keys (grove spot, forest anchor). */
class Shown {
  readonly byKey = new Map<string, FarmEntity>();
  key: string | null = null;
  pending = 0;

  current(): FarmEntity | null {
    return this.key ? this.byKey.get(this.key) ?? null : null;
  }
}

interface Spot extends Place {
  slot: number;
  ring: FarmEntity | null;
  tree: Shown;
  visual: GroveVisual | null;
  halo: Sprite;
  motes: Sprite[];
  /** the grown tree's crown (null while the spot is empty): part of the touch target with the ring */
  crown: Ellipse | null;
}

interface PestEntity {
  id: number;
  e: FarmEntity | null;
  mist: Sprite;
  hit: Graphics;
  reviewed: boolean;
  /** Phase 3C: 1 crawling, 2 nibbling (quick small bites), 3 well fed on a wilting crop */
  stage: number;
  phase: number;
  alive: boolean;
  /** scene-clock second at which the pest began to leave (set on the first frame after the server cleared it) */
  leftAt: number | null;
}

/** Seconds a cured pest takes to lift off the crop and fade (it is released afterwards). */
const PEST_LEAVE_S = 0.7;

const HEALTH_TINT = { HEALTHY: 0xffffff, THIRSTY: 0xe9dfc4, WILTING: 0xd2c6a4 } as const;

export function setEntityVisible(e: FarmEntity, shadows: ShadowLayer, visible: boolean) {
  e.sprite.visible = visible;
  if (e.shadow) shadows.setVisible(e.shadow, visible);
  if (e.glow) e.glow.visible = visible;
}

export class LivingLayer {
  private readonly spots = new Map<number, Spot>();
  private readonly forest: Shown[] = [];
  private readonly pests = new Map<number, PestEntity>();
  /** pests the server cleared, playing their short farewell before they are released */
  private readonly leaving: PestEntity[] = [];
  private generation = 0;
  reduced = false;

  constructor(private readonly deps: LivingDeps) {
    // nearer spots (larger y) are added last so their touch targets win where the art overlaps
    for (const s of [...deps.spots].sort((a, b) => a.y - b.y)) {
      const halo = new Sprite(deps.ring);
      halo.anchor.set(0.5);
      halo.position.set(s.x, s.y - 2);
      halo.scale.set(120 / deps.ring.width, 60 / deps.ring.height);
      halo.tint = 0x5fe0cf;
      halo.blendMode = "add";
      halo.alpha = 0;
      halo.eventMode = "none";
      deps.groundFx.addChild(halo);
      const motes: Sprite[] = [];
      for (let i = 0; i < 4; i++) {
        const m = new Sprite(deps.soft);
        m.anchor.set(0.5);
        m.tint = 0x8ff0e0;
        m.blendMode = "add";
        m.scale.set(7 / 64);
        m.alpha = 0;
        m.eventMode = "none";
        deps.fxLayer.addChild(m);
        motes.push(m);
      }
      // touch target = what is drawn there: the ring on the ground, plus the crown once a tree grows (an empty
      // spot never steals taps from the ring of the spot behind it)
      const ring = new Ellipse(s.x, s.y - 4, 50, 28);
      const spot: Spot = { ...s, ring: null, tree: new Shown(), visual: null, halo, motes, crown: null };
      const hit = new Graphics();
      hit.ellipse(s.x, s.y - 4, 50, 28).fill({ color: 0xffffff, alpha: 0.001 });
      hit.hitArea = { contains: (x: number, y: number) => ring.contains(x, y) || (spot.crown?.contains(x, y) ?? false) };
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.label = `grove-hit-${s.slot}`;
      hit.on("pointertap", (ev: FederatedPointerEvent) => {
        ev.stopPropagation();
        if (!deps.isDragging()) deps.onSelect(`grove_${s.slot}`);
      });
      deps.hitLayer.addChild(hit);
      this.spots.set(s.slot, spot);
    }
    deps.forest.forEach(() => this.forest.push(new Shown()));
  }

  /** Bring the grove, the forest and the pests in line with the server visuals (idempotent). */
  apply(v: LivingVisuals) {
    const gen = ++this.generation;
    for (const g of v.grove) {
      const spot = this.spots.get(g.slot);
      if (!spot) continue;
      spot.visual = g;
      void this.ensureRing(spot);
      void this.show(spot.tree, g.tree ? treeSpriteKey(g.tree.species, g.tree.stage) : null, spot, 1, gen).then(() => {
        const e = spot.tree.current();
        spot.crown = e ? new Ellipse(e.baseX, e.baseY - e.sprite.height * 0.55, e.sprite.width * 0.36, e.sprite.height * 0.42) : null;
      });
    }
    this.forest.forEach((shown, i) => {
      const t = v.forest[i];
      void this.show(shown, t ? treeSpriteKey(t.species, 4) : null, this.deps.forest[i], this.deps.forest[i].s, gen);
    });
    const live = new Set(v.pests.map((p) => p.id));
    for (const p of [...this.pests.values()]) if (!live.has(p.id)) this.removePest(p);
    for (const p of v.pests) {
      const existing = this.pests.get(p.id);
      if (existing) {
        existing.reviewed = p.reviewed;
        existing.stage = p.stage ?? 1;
        continue;
      }
      const at = p.host === "CROP"
        ? (p.plotSlot != null ? this.deps.beds.get(p.plotSlot) : undefined)
        : (p.treeSlot != null ? this.spots.get(p.treeSlot) : undefined);
      if (at) void this.addPest(p, at, p.host === "CROP" ? { dx: 0.24, dy: 0.1 } : { dx: 0.38, dy: 0.3 });
    }
  }

  private async load(key: string): Promise<boolean> {
    const entry = this.deps.manifest.sprites[key];
    if (!entry) return false;
    const t = await this.deps.loadTexture(entry.file);
    if (entry.shadow) await this.deps.loadTexture(entry.shadow.file);
    if (entry.glow) await this.deps.loadTexture(entry.glow);
    return !!t;
  }

  private async ensureRing(spot: Spot) {
    if (spot.ring || !(await this.load("mtree_spot")) || spot.ring) return;
    spot.ring = this.deps.createEntity("mtree_spot", spot.gx, spot.gy, { ground: true, footprint: 0.9 });
  }

  private async show(shown: Shown, key: string | null, at: Place, scale: number, gen: number) {
    if (key === shown.key) return;
    shown.pending = gen;
    if (key && !shown.byKey.has(key)) {
      if (!(await this.load(key))) return;
      if (shown.pending !== gen) return;
      const e = this.deps.createEntity(key, at.gx, at.gy, { scale, footprint: 0.8 * scale });
      if (!e) return;
      shown.byKey.set(key, e);
    }
    if (shown.pending !== gen) return;
    for (const [k, e] of shown.byKey) setEntityVisible(e, this.deps.shadows, k === key);
    shown.key = key;
  }

  private async addPest(p: PestVisual, at: Place, off: { dx: number; dy: number }) {
    const pest: PestEntity = {
      id: p.id, e: null, mist: new Sprite(this.deps.soft), hit: new Graphics(), reviewed: p.reviewed, stage: p.stage ?? 1,
      phase: (p.id % 17) * 0.37, alive: true, leftAt: null,
    };
    this.pests.set(p.id, pest);
    if (!(await this.load("forgotten_pest")) || !pest.alive) return;
    pest.e = this.deps.createEntity("forgotten_pest", at.gx + off.dx, at.gy + off.dy, { footprint: 0.35 });
    if (!pest.e) return;
    const x = pest.e.baseX;
    const y = pest.e.baseY;
    pest.mist.anchor.set(0.5);
    pest.mist.tint = 0x9a7fe0;
    pest.mist.position.set(x, y - 12);
    pest.mist.eventMode = "none";
    this.deps.fxLayer.addChild(pest.mist);
    pest.hit.ellipse(x, y - 14, 36, 28).fill({ color: 0xffffff, alpha: 0.001 });
    pest.hit.hitArea = new Ellipse(x, y - 14, 36, 28);
    pest.hit.eventMode = "static";
    pest.hit.cursor = "pointer";
    pest.hit.label = `pest-hit-${p.id}`;
    pest.hit.on("pointertap", (ev: FederatedPointerEvent) => {
      ev.stopPropagation();
      if (!this.deps.isDragging()) this.deps.onSelect(`pest_${p.id}`);
    });
    this.deps.hitLayer.addChild(pest.hit);
  }

  /**
   * The server no longer lists this pest (cured by a review, or its host / card is gone): it stops being a touch target
   * at once and is never drawn as a pest again. Its sprite lifts off and fades for a moment (not under reduced motion),
   * then every display object it owned is released — a later pest is always a new object with its own id.
   */
  private removePest(p: PestEntity) {
    p.alive = false;
    this.pests.delete(p.id);
    if (!p.hit.destroyed) p.hit.destroy();
    if (!p.mist.destroyed) p.mist.destroy();
    if (!p.e) return; // its art was still loading: addPest stops on `alive`
    if (this.reduced) this.release(p);
    else this.leaving.push(p);
  }

  private release(p: PestEntity) {
    if (p.e) this.deps.removeEntity(p.e);
    p.e = null;
  }

  /** World point of a spot (fly-to feedback). */
  spotPoint(slot: number): { x: number; y: number } | null {
    const s = this.spots.get(slot);
    return s ? { x: s.x, y: s.y - 40 } : null;
  }

  /** Called every frame AFTER the canvas applied wind sway (it adds the droop on top of the sway). */
  update(envT: number) {
    for (const s of this.spots.values()) {
      const t = s.visual?.tree ?? null;
      const locked = s.visual ? !s.visual.unlocked : true;
      if (s.ring) s.ring.sprite.alpha = locked ? 0.55 : 1;
      const e = s.tree.current();
      if (e && t) {
        e.sprite.tint = HEALTH_TINT[t.health];
        // the canvas wrote this frame's wind sway (memory trees sway like every tree); the droop adds to it.
        // Seedlings (stage 1) have no sway, so their lean is set absolutely and never accumulates.
        const droop = t.health === "WILTING" ? 0.05 : t.health === "THIRSTY" ? 0.025 : 0;
        if (e.sway) e.sprite.skew.x += droop;
        else e.sprite.skew.x = droop;
      }
      const ready = !!t?.essenceReady && t.health === "HEALTHY";
      const invite = !locked && !t;
      s.halo.alpha = ready ? 0.35 + (this.reduced ? 0 : 0.12 * Math.sin(envT * 1.6 + s.slot))
        : invite ? 0.14 + (this.reduced ? 0 : 0.06 * Math.sin(envT * 0.9 + s.slot)) : 0;
      s.motes.forEach((m, i) => {
        if (!ready || this.reduced) {
          m.alpha = 0;
          return;
        }
        const u = (envT * 0.35 + i / s.motes.length) % 1;
        m.position.set(s.x + Math.sin(i * 2.1 + envT * 0.7) * 22, s.y - 10 - u * 110);
        m.alpha = 0.8 * Math.sin(u * Math.PI);
      });
    }
    for (const p of this.pests.values()) {
      if (!p.e) continue;
      // crawling (stage 1): the calm hop; nibbling (2, 3): quick small bites with a side-to-side munch
      const biting = !p.reviewed && p.stage >= 2;
      const hop = this.reduced ? 0 : biting
        ? Math.abs(Math.sin(envT * 5.4 + p.phase)) * 1.6
        : Math.max(0, Math.sin(envT * 2.2 + p.phase)) * 3;
      p.e.sprite.y = p.e.baseY - hop;
      p.e.sprite.x = p.e.baseX + (biting && !this.reduced ? Math.sin(envT * 2.7 + p.phase) * 2.2 : 0);
      p.e.sprite.alpha = p.reviewed ? 0.6 : 1;
      // a caterpillar that has been eating for a while is visibly plumper (bounded: +16 %)
      const grown = p.reviewed ? 1 : 1 + 0.08 * Math.max(0, Math.min(3, p.stage) - 1);
      const k = (this.deps.manifest.sprites.forgotten_pest?.scale ?? 1) * p.e.instanceScale * grown;
      p.e.sprite.scale.set(k);
      p.mist.visible = !p.reviewed;
      const breathe = this.reduced ? 0 : 0.08 * Math.sin(envT * 1.3 + p.phase);
      p.mist.scale.set((70 / 64) * (1 + breathe), (44 / 64) * (1 + breathe));
      p.mist.alpha = 0.32 + 0.06 * Math.max(0, p.stage - 1) + breathe;
    }
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const p = this.leaving[i];
      if (p.leftAt === null) p.leftAt = envT;
      const u = (envT - p.leftAt) / PEST_LEAVE_S;
      if (!p.e || this.reduced || u >= 1 || u < 0) {
        this.release(p);
        this.leaving.splice(i, 1);
        continue;
      }
      const ease = u * (2 - u);
      p.e.sprite.y = p.e.baseY - 26 * ease;
      p.e.sprite.alpha = 1 - u;
      const k = (this.deps.manifest.sprites.forgotten_pest?.scale ?? 1) * p.e.instanceScale * (1 - 0.3 * ease);
      p.e.sprite.scale.set(k);
    }
  }

  stats() {
    return {
      trees: [...this.spots.values()].filter((s) => s.tree.current()?.sprite.visible).length,
      forest: this.forest.filter((f) => f.current()?.sprite.visible).length,
      pests: [...this.pests.values()].filter((p) => p.e?.sprite.visible).length,
      pestsLeaving: this.leaving.length,
    };
  }

  /** Run after the renderer is destroyed (stage children are gone with it). */
  destroy() {
    for (const s of this.spots.values()) s.motes.forEach((m) => !m.destroyed && m.destroy());
  }
}
