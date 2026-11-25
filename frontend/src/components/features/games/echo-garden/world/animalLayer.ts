import { Container, Ellipse, Graphics, Sprite, Texture, type FederatedPointerEvent } from "pixi.js";
import type { SpriteEntry, WorldManifest } from "./worldData";
import type { FarmEntity } from "./farmLayer";

/**
 * Echo Garden Phase 3H — the living farm on the island, driven only by server visuals.
 *
 * * Houses: each species has one fixed lot in the animal quarter (`layout.animalQuarter`). An empty lot shows the
 *   island's staked claim; a built house is an ordinary depth-sorted entity with its own ground shadow.
 * * Animals: one sprite each, strolling around its house yard (livestock) or its post (guardians). Motion is decorative
 *   and closed-form in the environment clock — a pure function of time and a per-animal seed, so it is deterministic,
 *   costs no state and freezes under reduced motion. Four rendered directions (`_a`…`_d`): a sprite is never mirrored.
 *   What an animal IS (species, growth stage, whether it is cared for, whether a product waits) comes from the server.
 * * A bounded scene: the server caps a garden at four houses of three animals plus three guardians (15 sprites). Only
 *   the art of animals that exist is loaded, on demand; each animal carries one soft contact blob instead of a
 *   composed shadow, so nothing re-composes while they walk.
 *
 * Nothing here talks to the network or decides an outcome.
 */

export type AnimalStage = "BABY" | "YOUNG" | "ADULT";
/** ok = cared for; rest = waiting for food or water; ready = a product waits; alert = the dog is on watch. */
export type AnimalMood = "ok" | "rest" | "ready" | "alert";

export interface AnimalVisual {
  id: string;
  species: string;
  kind: "LIVESTOCK" | "GUARDIAN";
  stage: AnimalStage;
  house: string | null;
  place: number | null;
  woolly: boolean;
  mood: AnimalMood;
}

export interface AnimalHouseVisual { code: string; state: "built" | "lot"; badge: "ready" | "care" | null }
export interface AnimalVisuals { houses: AnimalHouseVisual[]; animals: AnimalVisual[] }

export interface AnimalQuarter {
  houses: Record<string, { art: string; gx: number; gy: number; yard: [number, number] }>;
  guardians: Record<string, { gx: number; gy: number }>;
}

export interface AnimalDeps {
  manifest: WorldManifest;
  quarter: AnimalQuarter;
  /** depth-sorted world entities (zIndex = screen y) */
  entities: Container;
  groundFx: Container;
  /** ungraded world layer for the small status bubbles */
  marks: Container;
  loadTexture: (file: string) => Promise<Texture | null>;
  toScreen: (gx: number, gy: number) => { x: number; y: number };
  createEntity: (key: string, gx: number, gy: number, opts: { footprint?: number; targetId?: string }) => FarmEntity | null;
  setEntityVisible: (e: FarmEntity, visible: boolean) => void;
  /** null on a visited island: nothing there can be opened */
  onSelect: ((id: string) => void) | null;
  isDragging: () => boolean;
}

type Facing = "a" | "b" | "c" | "d";
/** Grid step of each rendered direction: b = +gx (down-right), a = +gy (down-left), d = -gx (up-left), c = -gy (up-right). */
const LEGS: Array<{ facing: Facing; dx: number; dy: number }> = [
  { facing: "b", dx: 1, dy: 0 }, { facing: "a", dx: 0, dy: 1 }, { facing: "d", dx: -1, dy: 0 }, { facing: "c", dx: 0, dy: -1 },
];

/** How each species moves: stroll rectangle half-extents (tiles), speed (tiles / s), rest at a corner (s), hop (px). */
const GAIT: Record<string, { w: number; h: number; speed: number; rest: number; hop: number; waddle: number }> = {
  CHICKEN: { w: 0.3, h: 0.22, speed: 0.11, rest: 5, hop: 1.6, waddle: 0.05 },
  DUCK: { w: 0.32, h: 0.22, speed: 0.08, rest: 6, hop: 1.2, waddle: 0.09 },
  PIG: { w: 0.3, h: 0.2, speed: 0.06, rest: 8, hop: 0.9, waddle: 0.03 },
  SHEEP: { w: 0.34, h: 0.22, speed: 0.06, rest: 8, hop: 1.0, waddle: 0.025 },
  DOG: { w: 0.55, h: 0.22, speed: 0.16, rest: 6, hop: 1.8, waddle: 0.03 },
  GOOSE: { w: 0.16, h: 0.7, speed: 0.1, rest: 5, hop: 1.3, waddle: 0.08 },
  // the cat sits and watches: it turns its head now and then but does not stroll
  CAT: { w: 0, h: 0, speed: 0, rest: 9, hop: 0, waddle: 0 },
};

const ANIMAL_SIZE = 1.2;

interface Actor {
  v: AnimalVisual;
  sprite: Sprite;
  blob: Graphics;
  mark: Graphics;
  home: { gx: number; gy: number };
  seed: number;
  art: string;
  facing: Facing;
  shown: string | null;
  textures: Map<string, { tex: Texture; entry: SpriteEntry } | null>;
}

interface House {
  code: string;
  at: { art: string; gx: number; gy: number; yard: [number, number] };
  built: FarmEntity | null;
  lot: FarmEntity | null;
  pending: boolean;
  state: "built" | "lot" | null;
  badge: Graphics;
  badgeKind: "ready" | "care" | null;
  top: number;
  hit: Graphics | null;
}

/** Base art key (without the direction) of an animal as the server describes it. */
export function animalArt(v: Pick<AnimalVisual, "species" | "kind" | "stage" | "woolly">): string {
  const sp = v.species.toLowerCase();
  if (v.kind === "GUARDIAN") return `anim_${sp}`;
  if (v.stage !== "ADULT") return `anim_${sp}_baby`;
  if (sp === "sheep") return v.woolly ? "anim_sheep_adult" : "anim_sheep_shorn";
  return `anim_${sp}_adult`;
}

/** Deterministic 0–1 value of a string (stable per animal across sessions). */
function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Where an animal is on its stroll at clock time `t`: a closed rectangle walked leg by leg with a rest at each corner.
 * Pure: the same (gait, seed, t) always gives the same point.
 */
export function strollAt(gait: { w: number; h: number; speed: number; rest: number }, seed: number, t: number): { dx: number; dy: number; facing: Facing; moving: boolean } {
  if (gait.speed <= 0 || (gait.w <= 0 && gait.h <= 0)) {
    // a sitter: looks down-right, then down-left, in long calm turns
    return { dx: 0, dy: 0, facing: Math.floor(t / (gait.rest * 2.4) + seed * 2) % 2 === 0 ? "b" : "a", moving: false };
  }
  const lens = [2 * gait.w, 2 * gait.h, 2 * gait.w, 2 * gait.h];
  const rest = gait.rest * (0.7 + 0.6 * seed);
  const total = lens.reduce((a, l) => a + l / gait.speed + rest, 0);
  let tt = (((t + seed * total) % total) + total) % total;
  let x = -gait.w;
  let y = -gait.h;
  for (let i = 0; i < 4; i++) {
    const leg = LEGS[i];
    const walk = lens[i] / gait.speed;
    if (tt < walk) {
      const d = tt * gait.speed;
      return { dx: x + leg.dx * d, dy: y + leg.dy * d, facing: leg.facing, moving: true };
    }
    tt -= walk;
    x += leg.dx * lens[i];
    y += leg.dy * lens[i];
    if (tt < rest) {
      // at a corner the animal already looks where it will go next
      return { dx: x, dy: y, facing: tt > rest * 0.6 ? LEGS[(i + 1) % 4].facing : leg.facing, moving: false };
    }
    tt -= rest;
  }
  return { dx: -gait.w, dy: -gait.h, facing: "b", moving: false };
}

export class AnimalLayer {
  private readonly houses = new Map<string, House>();
  private readonly actors = new Map<string, Actor>();
  private readonly guardHits = new Map<string, Graphics>();
  private cheer = new Map<string, number>();
  private lastT = 0;
  private gen = 0;
  reduced = false;

  constructor(private readonly deps: AnimalDeps) {
    for (const [code, at] of Object.entries(deps.quarter.houses)) {
      const badge = new Graphics();
      badge.eventMode = "none";
      badge.visible = false;
      badge.label = `animal-badge-${code}`;
      deps.marks.addChild(badge);
      this.houses.set(code, { code, at, built: null, lot: null, pending: false, state: null, badge, badgeKind: null, top: 70, hit: null });
    }
  }

  /** Bring houses and animals in line with the server visuals (idempotent; only differences do work). */
  apply(v: AnimalVisuals) {
    const gen = ++this.gen;
    for (const hv of v.houses) {
      const h = this.houses.get(hv.code);
      if (!h) continue;
      h.state = hv.state;
      this.setBadge(h, hv.state === "built" ? hv.badge : null);
      void this.showHouse(h, gen);
    }
    for (const h of this.houses.values()) {
      if (!v.houses.some((x) => x.code === h.code)) {
        h.state = null;
        this.setBadge(h, null);
        if (h.built) this.deps.setEntityVisible(h.built, false);
        if (h.lot) this.deps.setEntityVisible(h.lot, false);
        if (h.hit) h.hit.visible = false;
      }
    }
    const seen = new Set<string>();
    for (const av of v.animals) {
      seen.add(av.id);
      const a = this.actors.get(av.id) ?? this.createActor(av);
      if (!a) continue;
      a.v = av;
      const art = animalArt(av);
      if (art !== a.art) {
        a.art = art;
        a.shown = null;
      }
    }
    for (const [id, a] of this.actors) {
      if (seen.has(id)) continue;
      a.sprite.destroy();
      a.blob.destroy();
      a.mark.destroy();
      this.actors.delete(id);
    }
    // an owned guardian's post is a touch target (the owner's island only)
    if (this.deps.onSelect) {
      for (const [species, at] of Object.entries(this.deps.quarter.guardians)) {
        const owned = v.animals.some((x) => x.kind === "GUARDIAN" && x.species === species);
        let hit = this.guardHits.get(species);
        if (owned && !hit) {
          hit = this.touch(at.gx, at.gy, 0.5, `guardian-hit-${species}`, `guardian_${species}`);
          this.guardHits.set(species, hit);
        }
        if (hit) hit.visible = owned;
      }
    }
  }

  private touch(gx: number, gy: number, radius: number, label: string, id: string): Graphics {
    const p = this.deps.toScreen(gx, gy);
    const hit = new Graphics();
    hit.ellipse(p.x, p.y - 10, radius * 128, radius * 64 + 16).fill({ color: 0xffffff, alpha: 0.001 });
    hit.hitArea = new Ellipse(p.x, p.y - 10, radius * 128, radius * 64 + 16);
    hit.eventMode = "static";
    hit.cursor = "pointer";
    hit.label = label;
    hit.on("pointertap", (ev: FederatedPointerEvent) => {
      ev.stopPropagation();
      if (!this.deps.isDragging()) this.deps.onSelect?.(id);
    });
    this.deps.groundFx.addChild(hit);
    return hit;
  }

  private async showHouse(h: House, gen: number) {
    const want = h.state;
    if (h.built) this.deps.setEntityVisible(h.built, want === "built");
    if (h.lot) this.deps.setEntityVisible(h.lot, want === "lot");
    if (h.hit) h.hit.visible = want === "built";
    if (!want || h.pending || (want === "built" ? h.built : h.lot)) return;
    const key = want === "built" ? h.at.art : "land_claim";
    const entry = this.deps.manifest.sprites[key];
    if (!entry) return;
    h.pending = true;
    await this.deps.loadTexture(entry.file);
    if (entry.shadow) await this.deps.loadTexture(entry.shadow.file);
    h.pending = false;
    const targetId = this.deps.onSelect ? `ahouse_${h.code}` : undefined;
    const e = this.deps.createEntity(key, h.at.gx, h.at.gy, { footprint: want === "built" ? 1 : 0.9, targetId });
    if (!e) return;
    if (want === "built") {
      h.built = e;
      h.top = entry.ay * entry.scale;
      if (this.deps.onSelect && !h.hit) h.hit = this.touch(h.at.yard[0], h.at.yard[1], 0.55, `ahouse-hit-${h.code}`, `ahouse_${h.code}`);
    } else {
      h.lot = e;
    }
    // the state may have changed while the art was loading (or the layer was re-applied)
    if (gen !== this.gen || h.state !== want) {
      this.deps.setEntityVisible(e, h.state === want);
      void this.showHouse(h, this.gen);
    }
    this.drawBadge(h);
  }

  private setBadge(h: House, kind: "ready" | "care" | null) {
    h.badgeKind = kind;
    this.drawBadge(h);
  }

  private drawBadge(h: House) {
    const g = h.badge;
    g.clear();
    g.visible = h.badgeKind !== null && h.built !== null && h.state === "built";
    if (!g.visible) return;
    const p = this.deps.toScreen(h.at.gx, h.at.gy);
    g.position.set(p.x, p.y - h.top - 14);
    // a small speech bubble: gold with a pale egg = something to collect, amber with a bowl = the animals need care
    g.moveTo(-4, 9).lineTo(0, 16).lineTo(4, 9).fill({ color: 0xfffaf0 });
    g.circle(0, 0, 11).fill({ color: 0xfffaf0 }).stroke({ color: h.badgeKind === "ready" ? 0xf4b63f : 0xf2a36b, width: 2 });
    if (h.badgeKind === "ready") {
      g.ellipse(0, 0.5, 4.6, 6).fill({ color: 0xf4b63f });
      g.ellipse(-1.4, -1.6, 1.3, 1.9).fill({ color: 0xfff3c4 });
    } else {
      g.moveTo(-6, -1).lineTo(6, -1).lineTo(4, 5).lineTo(-4, 5).closePath().fill({ color: 0xf2a36b });
      g.circle(-2, -3, 1.4).circle(1.5, -4, 1.4).circle(3.5, -2.5, 1.2).fill({ color: 0xe0902a });
    }
  }

  private createActor(v: AnimalVisual): Actor | null {
    const quarter = this.deps.quarter;
    let home: { gx: number; gy: number } | null = null;
    if (v.kind === "GUARDIAN") {
      home = quarter.guardians[v.species] ?? null;
    } else if (v.house && quarter.houses[v.house]) {
      // each place of a house has its own patch of the yard, so three animals never walk through each other
      const [yx, yy] = quarter.houses[v.house].yard;
      const place = (v.place ?? 1) - 1;
      home = { gx: yx + (place - 1) * 0.42, gy: yy + (place % 2 === 0 ? 0.0 : 0.26) };
    }
    if (!home) return null;
    const sprite = new Sprite(Texture.EMPTY);
    sprite.eventMode = "none";
    sprite.visible = false;
    sprite.label = `animal-${v.id}`;
    sprite.cullable = true;
    this.deps.entities.addChild(sprite);
    const blob = new Graphics();
    blob.ellipse(0, 0, 10, 4.4).fill({ color: 0x1b2440, alpha: 0.22 });
    blob.eventMode = "none";
    blob.visible = false;
    this.deps.groundFx.addChild(blob);
    const mark = new Graphics();
    mark.eventMode = "none";
    mark.visible = false;
    this.deps.marks.addChild(mark);
    const a: Actor = {
      v, sprite, blob, mark, home, seed: hash01(v.id), art: animalArt(v), facing: "b", shown: null, textures: new Map(),
    };
    this.actors.set(v.id, a);
    return a;
  }

  /** Loads one direction of an animal's art (once); the sprite keeps what it shows until the new texture is there. */
  private want(a: Actor, key: string) {
    if (a.textures.has(key)) return a.textures.get(key) ?? null;
    a.textures.set(key, null);
    const entry = this.deps.manifest.sprites[key];
    if (!entry) return null;
    void this.deps.loadTexture(entry.file).then((tex) => {
      if (tex && !a.sprite.destroyed) a.textures.set(key, { tex, entry });
    });
    return null;
  }

  /** The animals of a house (or one guardian) hop once: the owner just fed, watered or collected. */
  celebrate(target: string) {
    this.cheer.set(target, this.lastT + 1.4);
  }

  /** Called every frame with the environment clock (frozen under reduced motion by the caller's flag). */
  update(envT: number) {
    const t = this.reduced ? 0 : envT;
    this.lastT = envT;
    for (const h of this.houses.values()) {
      if (h.badge.visible) h.badge.pivot.y = this.reduced ? 0 : Math.sin(envT * 2.2 + h.at.gx) * 2;
    }
    for (const a of this.actors.values()) {
      const gait = GAIT[a.v.species] ?? GAIT.CHICKEN;
      const resting = a.v.mood === "rest";
      // an animal waiting for care stays put by its house; a guard on alert stands its ground
      const still = resting || a.v.mood === "alert" || this.reduced;
      const s = still ? { dx: 0, dy: 0, facing: (a.seed > 0.5 ? "a" : "b") as Facing, moving: false } : strollAt(gait, a.seed, t);
      if (a.v.mood === "alert") s.facing = Math.floor(envT * 0.8) % 2 === 0 ? "a" : "b";
      const p = this.deps.toScreen(a.home.gx + s.dx, a.home.gy + s.dy);
      const key = `${a.art}_${s.facing}`;
      const art = this.want(a, key) ?? (a.shown ? a.textures.get(a.shown) ?? null : null);
      if (art && a.shown !== key && this.want(a, key)) {
        // drawn a little larger than life so a hen still reads from the whole-island view; a half-grown animal is the
        // young sprite scaled up
        const young = (a.v.stage === "YOUNG" ? 1.3 : 1) * ANIMAL_SIZE;
        a.sprite.texture = art.tex;
        a.sprite.anchor.set(art.entry.ax / art.entry.w, art.entry.ay / art.entry.h);
        a.sprite.scale.set(art.entry.scale * young);
        a.blob.scale.set(Math.max(0.5, (art.entry.w * art.entry.scale * young) / 30));
        a.shown = key;
        a.facing = s.facing;
      }
      const visible = a.shown !== null;
      a.sprite.visible = visible;
      a.blob.visible = visible;
      if (!visible) continue;
      const cheering = (this.cheer.get(a.v.house ?? a.v.species) ?? 0) > envT;
      const alert = a.v.mood === "alert";
      let hop = 0;
      if (!this.reduced) {
        if (cheering || alert) hop = Math.abs(Math.sin(envT * (alert ? 9 : 7) + a.seed * 6)) * (alert ? 3 : 4.5);
        else if (s.moving) hop = Math.abs(Math.sin(envT * 8 + a.seed * 6)) * gait.hop;
      }
      a.sprite.position.set(p.x, p.y - hop);
      a.sprite.rotation = !this.reduced && s.moving ? Math.sin(envT * 8 + a.seed * 6) * gait.waddle : 0;
      // a calm breath while standing; a resting animal is a little paler (the panel says why in words)
      const breath = this.reduced || s.moving ? 1 : 1 + 0.018 * Math.sin(envT * 1.7 + a.seed * 9);
      a.sprite.scale.y = Math.abs(a.sprite.scale.x) * breath;
      a.sprite.tint = resting ? 0xd9dde6 : 0xffffff;
      const z = Math.round(p.y);
      if (a.sprite.zIndex !== z) a.sprite.zIndex = z;
      a.blob.position.set(p.x, p.y);
      this.drawMark(a, p.x, p.y - a.sprite.height - 6 - hop);
    }
  }

  /** The dog on watch carries a small "!" so the alert reads without sound. */
  private drawMark(a: Actor, x: number, y: number) {
    const show = a.v.mood === "alert";
    if (a.mark.visible !== show) {
      a.mark.visible = show;
      a.mark.clear();
      if (show) {
        a.mark.circle(0, 0, 8).fill({ color: 0xfffaf0 }).stroke({ color: 0xf2777a, width: 2 });
        a.mark.roundRect(-1.3, -5, 2.6, 6, 1).fill({ color: 0xd9463c });
        a.mark.circle(0, 3.6, 1.4).fill({ color: 0xd9463c });
      }
    }
    if (show) a.mark.position.set(x, y);
  }

  stats() {
    return {
      houses: [...this.houses.values()].map((h) => ({ code: h.code, state: h.state, badge: h.badgeKind, shown: h.state === "built" ? !!h.built?.sprite.visible : !!h.lot?.sprite.visible })),
      animals: [...this.actors.values()].map((a) => ({ id: a.v.id, species: a.v.species, stage: a.v.stage, mood: a.v.mood, art: a.shown, x: Math.round(a.sprite.x), y: Math.round(a.sprite.y) })),
    };
  }

  destroy() {
    for (const a of this.actors.values()) {
      a.sprite.destroy();
      a.blob.destroy();
      a.mark.destroy();
    }
    this.actors.clear();
    for (const h of this.houses.values()) h.badge.destroy();
    for (const g of this.guardHits.values()) g.destroy();
  }
}
