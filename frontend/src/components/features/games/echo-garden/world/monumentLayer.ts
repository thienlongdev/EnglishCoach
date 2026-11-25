import { Container, Sprite, Texture } from "pixi.js";
import { GardenCinematicBurst } from "./cinematicBurst";
import type { ShadowLayer, ShadowSpec } from "./shadowLayer";
import type { SpriteEntry, WorldManifest } from "./worldData";

/**
 * The monumental Knowledge Tree as a living landmark (Phase 3B, gameplay only; the preview keeps the approved tree).
 *
 * The SAME tree entity shows the era the server reports: its sprite, night glow and shadow are swapped for the era art
 * (`manifest.monument.eras[era]`, same camera / anchor / instance scale, so the roots never move) with a slow crossfade.
 * Up to SIX ornaments hang on fixed sockets under the crown — one per verified skill family plus the memory lanterns of
 * graduated trees — each in one of three tiers. The scene budget is therefore constant whatever the learner's history:
 * one tree sprite, at most six ornament sprites and a pooled burst of motes for a milestone.
 *
 * Presentation only: every value comes from the server state; nothing here talks to the network. All motion is a
 * closed-form function of time (ornament sway of the environment clock, one-shots of real time since their start), with
 * seeded offsets and no per-frame accumulation; reduced motion keeps every state change and drops the motion. Ornaments
 * are decoration (`eventMode = "none"`): the tree keeps its own touch target. Only the art actually shown is loaded (at
 * entry: the one era the server reports); a missing sprite leaves the previous look in place (never an empty tree).
 */

export const ORNAMENT_FAMILIES = ["vocabulary", "listening", "speaking", "writing", "exam", "memory"] as const;
export type OrnamentFamily = (typeof ORNAMENT_FAMILIES)[number];

/** What the tree shows: era index and ornament tier (0 = none) per family. */
export interface MonumentVisuals {
  era: number;
  ornaments: Partial<Record<OrnamentFamily, number>>;
}

export interface MonumentEntity {
  sprite: Sprite;
  glow?: Sprite;
  shadow?: Sprite;
  instanceScale: number;
  baseX: number;
  baseY: number;
  art: string;
}

export interface MonumentLayerDeps {
  manifest: WorldManifest;
  shadows: ShadowLayer;
  soft: Texture;
  entities: Container;
  emissive: Container;
  tree: MonumentEntity;
  loadTexture: (file: string) => Promise<Texture | null>;
  /** the tree's art changed: the canvas refreshes its hit area */
  onRetexture: (entry: SpriteEntry) => void;
  /** sprites inside the graded scene that follow the fallback tint */
  trackTint: (s: Sprite) => void;
}

/** Ornaments are drawn a little larger than modelled so they still read at the tree's focus zoom. */
const ORNAMENT_SCALE = 1.45;
const ERA_FADE_S = 1.4;
const MAX_MOTES = 36;

/** The era art key the manifest offers for an era (the nearest lower era when one is missing; the base tree otherwise). */
export function eraSpriteKey(manifest: WorldManifest, era: number): string {
  const eras = manifest.monument?.eras ?? ["knowledge_tree"];
  for (let e = Math.min(Math.max(0, Math.round(era)), eras.length - 1); e > 0; e--) {
    if (manifest.sprites[eras[e]]) return eras[e];
  }
  return "knowledge_tree";
}

/** Small deterministic generator (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ornament {
  sprite: Sprite;
  glow: Sprite | null;
  tier: number;
  key: string;
  k: number;
  popAt: number | null;
  phase: number;
}

interface Mote {
  s: Sprite;
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  start: number;
  life: number;
}

export class MonumentLayer {
  private readonly ornaments = new Map<OrnamentFamily, Ornament>();
  private readonly motes: Mote[] = [];
  private readonly pool: Sprite[] = [];
  private fade: { over: Sprite; start: number } | null = null;
  private eraGen = 0;
  private ornamentGen = 0;
  private bursts = 0;
  private now = 0;
  private want: MonumentVisuals = { era: 0, ornaments: {} };
  reduced = false;

  private cinematic: GardenCinematicBurst | null = null;
  constructor(private readonly deps: MonumentLayerDeps) {}

  /** Bring the tree in line with the server's facts (idempotent; only differences do work). */
  apply(v: MonumentVisuals) {
    this.want = v;
    void this.showEra(v.era);
    void this.showOrnaments(v.ornaments);
  }

  private async showEra(era: number) {
    const { manifest, tree, shadows } = this.deps;
    const key = eraSpriteKey(manifest, era);
    if (key === tree.art) return;
    const gen = ++this.eraGen;
    const entry = manifest.sprites[key];
    if (!entry) return;
    const tex = await this.deps.loadTexture(entry.file);
    const glowTex = entry.glow ? await this.deps.loadTexture(entry.glow) : null;
    const shadowTex = entry.shadow ? await this.deps.loadTexture(entry.shadow.file) : null;
    if (!tex || gen !== this.eraGen || tree.sprite.destroyed) return;
    const k = entry.scale * tree.instanceScale;
    if (!this.reduced && tree.sprite.parent) {
      // the previous look fades out above the new one (same anchor point: the roots never jump)
      this.dropFade();
      const over = new Sprite(tree.sprite.texture);
      over.anchor.copyFrom(tree.sprite.anchor);
      over.position.copyFrom(tree.sprite.position);
      over.scale.copyFrom(tree.sprite.scale);
      over.zIndex = tree.sprite.zIndex + 0.01;
      over.eventMode = "none";
      over.tint = tree.sprite.tint;
      tree.sprite.parent.addChild(over);
      this.fade = { over, start: this.now };
    }
    tree.sprite.texture = tex;
    tree.sprite.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
    tree.sprite.scale.set(k);
    tree.art = key;
    if (tree.glow && glowTex) {
      tree.glow.texture = glowTex;
      tree.glow.anchor.copyFrom(tree.sprite.anchor);
      tree.glow.scale.set(k);
    }
    if (entry.shadow && shadowTex) {
      const spec: ShadowSpec = { texture: shadowTex, ax: entry.shadow.ax, ay: entry.shadow.ay, scale: entry.shadow.scale };
      if (tree.shadow) shadows.replace(tree.shadow, spec, tree.instanceScale);
      else tree.shadow = shadows.add(spec, tree.baseX, tree.baseY, tree.instanceScale);
    }
    this.deps.onRetexture(entry);
    // The era the tree grew out of stays cached until the scene is torn down: an era changes at most once in months,
    // and unloading a texture a batch may still reference is not worth a few megabytes (only the era the server
    // reports is ever loaded at entry).
  }

  private dropFade() {
    if (!this.fade) return;
    if (!this.fade.over.destroyed) this.fade.over.destroy();
    this.fade = null;
  }

  private async showOrnaments(tiers: MonumentVisuals["ornaments"]) {
    const { manifest, tree } = this.deps;
    const sockets = manifest.monument?.sockets;
    if (!sockets) return;
    const gen = ++this.ornamentGen;
    for (let i = 0; i < ORNAMENT_FAMILIES.length; i++) {
      const family = ORNAMENT_FAMILIES[i];
      const tier = Math.max(0, Math.min(manifest.monument?.ornamentTiers ?? 3, Math.round(tiers[family] ?? 0)));
      const have = this.ornaments.get(family);
      if ((have?.tier ?? 0) === tier) continue;
      if (tier === 0) {
        // the server never lowers a tier; a QA override may: remove cleanly
        if (have) {
          have.sprite.destroy();
          have.glow?.destroy();
          this.ornaments.delete(family);
        }
        continue;
      }
      const socket = sockets[family];
      const key = `kt_orn_${family}_t${tier}`;
      const entry = manifest.sprites[key];
      if (!socket || !entry) continue;
      const tex = await this.deps.loadTexture(entry.file);
      const glowTex = entry.glow ? await this.deps.loadTexture(entry.glow) : null;
      if (!tex || gen !== this.ornamentGen || tree.sprite.destroyed) return;
      const k = entry.scale * tree.instanceScale * ORNAMENT_SCALE;
      const x = tree.baseX + socket.dx * tree.instanceScale;
      const y = tree.baseY + socket.dy * tree.instanceScale;
      let o = this.ornaments.get(family);
      if (!o) {
        const sprite = new Sprite(tex);
        sprite.eventMode = "none";
        sprite.zIndex = tree.sprite.zIndex + 1 + i * 0.001;
        sprite.label = `monument-ornament-${family}`;
        this.deps.entities.addChild(sprite);
        this.deps.trackTint(sprite);
        let glow: Sprite | null = null;
        if (glowTex) {
          glow = new Sprite(glowTex);
          glow.blendMode = "add";
          glow.alpha = 0;
          glow.eventMode = "none";
          this.deps.emissive.addChild(glow);
        }
        o = { sprite, glow, tier, key, k, popAt: this.reduced ? null : this.now, phase: i * 1.7 };
        this.ornaments.set(family, o);
      } else {
        o.sprite.texture = tex;
        if (o.glow && glowTex) o.glow.texture = glowTex;
        o.tier = tier;
        o.key = key;
        o.k = k;
        o.popAt = this.reduced ? null : this.now;
      }
      for (const s of [o.sprite, o.glow]) {
        if (!s) continue;
        s.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
        s.position.set(x, y);
        s.scale.set(k);
      }
      o.k = k;
    }
  }

  /** A milestone: a short rise of teal and honey motes through the crown (pooled, skipped under reduced motion). */
  celebrate() {
    if (this.reduced) return;
    const { tree } = this.deps;
    if (!this.cinematic) { this.cinematic = new GardenCinematicBurst(); this.deps.emissive.addChild(this.cinematic.mesh); }
    this.cinematic.start(this.now, tree.baseX, tree.baseY - 170 * tree.instanceScale, 270 * tree.instanceScale);
    const rnd = seeded(7919 + ++this.bursts * 104729);
    const ks = tree.instanceScale;
    for (let i = 0; i < 28 && this.motes.length < MAX_MOTES; i++) {
      const s = this.pool.pop() ?? new Sprite(this.deps.soft);
      s.anchor.set(0.5);
      s.blendMode = "add";
      s.tint = i % 3 === 0 ? 0xffe2a0 : 0x7fe8d8;
      s.alpha = 0;
      s.visible = true;
      s.eventMode = "none";
      s.scale.set((8 + rnd() * 10) / 64);
      this.deps.emissive.addChild(s);
      this.motes.push({
        s, x0: tree.baseX + (rnd() - 0.5) * 520 * ks, y0: tree.baseY - (60 + rnd() * 240) * ks, vx: (rnd() - 0.5) * 26,
        vy: -(34 + rnd() * 46), start: this.now + i * 0.03, life: 1.5 + rnd() * 0.9,
      });
    }
    this.ornaments.forEach((o) => (o.popAt = this.now));
  }

  /**
   * Called every frame. {@code now}: real seconds (one-shots); {@code envT}: the environment clock (sway; frozen by
   * reduced motion, paused in a hidden tab); {@code glow}: the scene's night-glow weight (ornament lights at night).
   */
  update(now: number, envT: number, glow: number) {
    this.now = now;
    this.cinematic?.update(now, this.reduced);
    if (this.fade) {
      const u = Math.min(1, Math.max(0, (now - this.fade.start) / ERA_FADE_S));
      this.fade.over.alpha = 1 - u * u * (3 - 2 * u);
      this.fade.over.skew.x = this.deps.tree.sprite.skew.x;
      if (u >= 1) this.dropFade();
    }
    for (const o of this.ornaments.values()) {
      let scale = 1;
      if (o.popAt !== null) {
        const u = Math.min(1, Math.max(0, (now - o.popAt) / 0.5));
        scale = 0.6 + 0.4 * (1 + 2.2 * Math.pow(u - 1, 3) + 1.2 * Math.pow(u - 1, 2)); // easeOutBack, restrained
        if (u >= 1) o.popAt = null;
      }
      const sway = this.reduced ? 0 : 0.045 * Math.sin(envT * 1.25 + o.phase) + 0.02 * Math.sin(envT * 0.6 + o.phase * 2.3);
      o.sprite.rotation = sway;
      o.sprite.scale.set(o.k * scale);
      if (o.glow) {
        o.glow.rotation = sway;
        o.glow.scale.set(o.k * scale);
        // a faint light by day, a soft lantern glow at night (never a white blob over the crown)
        o.glow.alpha = Math.min(0.75, 0.03 + glow * 0.62);
      }
    }
    for (let i = this.motes.length - 1; i >= 0; i--) {
      const m = this.motes[i];
      const age = now - m.start;
      if (age < 0) continue;
      const q = age / m.life;
      m.s.position.set(m.x0 + m.vx * age + Math.sin(age * 2.4 + i) * 6, m.y0 + m.vy * age);
      m.s.alpha = q >= 1 ? 0 : 0.85 * Math.sin(Math.min(1, q * 4) * Math.PI * 0.5) * (1 - q);
      if (q >= 1) {
        m.s.visible = false;
        m.s.parent?.removeChild(m.s);
        this.pool.push(m.s);
        this.motes.splice(i, 1);
      }
    }
  }

  /** QA: what is on screen (era art, ornament tiers, motes in flight). */
  stats() {
    const ornaments: Record<string, number> = {};
    this.ornaments.forEach((o, family) => (ornaments[family] = o.tier));
    return { art: this.deps.tree.art, wantEra: this.want.era, ornaments, sprites: this.ornaments.size, motes: this.motes.length, fading: !!this.fade };
  }

  /** Run after the renderer is destroyed: stage children are already gone, pooled (detached) sprites are not. */
  destroy() {
    this.cinematic?.destroy(); this.cinematic = null;
    const kill = (s: Sprite | null) => {
      if (s && !s.destroyed) s.destroy();
    };
    this.motes.forEach((m) => kill(m.s));
    this.pool.forEach(kill);
    this.motes.length = 0;
    this.pool.length = 0;
    this.fade = null;
    this.ornaments.clear();
  }
}
