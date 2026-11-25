import { Container, Sprite, Texture } from "pixi.js";
import { GardenCinematicBurst } from "./cinematicBurst";
import type { ShadowLayer, ShadowSpec } from "./shadowLayer";
import type { SpriteEntry, WorldManifest } from "./worldData";
import { baseCropKey, cropSpriteKey, type PlotVisual } from "../game/gardenModel";

/**
 * Live farm presentation: the six starter beds (and, Phase 3A, every expansion bed the player bought) show exactly what
 * the SERVER says grows in them (crop species, visual
 * stage, ready, watered). Crop art is the existing World v2 stage sprites with their own shadow sprites; textures load
 * on demand and a swapped stage never leaves a ghost shadow. Feedback is restrained and pooled (GDD 04 §8, Art Bible
 * §8): a soil puff + sprout pop on planting, a short shower of droplets and damp soil on watering, a soft green ring
 * on fertilizing, a gentle growth swell on a stage change, a breathing honey halo + 3 px bob when ready and a
 * pop-and-fade with a few golden motes on harvest.
 *
 * Every motion is a closed-form function of time (one-shots of real time since their start, ambient bob / halo of the
 * environment clock, so reduced motion and hidden tabs freeze them) and every "random" offset comes from a seeded
 * generator (never the global RNG), with no per-frame accumulation. Reduced motion keeps every state change but drops the
 * motion. Nothing here talks to the network; the canvas feeds it plain visuals.
 */

export type FarmFxKind = "plant" | "water" | "fertilize" | "harvest" | "recover" | "treat" | "spray";

/** Overlay art drawn over ANY crop on its bed (Phase 3C): one sprite per damage look, no per-crop damage sprites. */
const DAMAGE_ART = { leaf: "pest_leaf_damage", wilt: "pest_wilt" } as const;
/** Crop tint per pest stage: 2 = nibbled (slightly yellowed), 3 = wilting (dry ochre). Stages 0 / 1 keep the art. */
const DAMAGE_TINT: Record<number, number> = { 2: 0xf1e9c2, 3: 0xcdbb8c };
/** Phase 3D: crop tint while stressed soil slows it — thirsty (dry straw) / waterlogged (dull, heavy green). */
const SOIL_TINT = { DRY: 0xe6d8a6, WET: 0xb7c9b6 } as const;
/**
 * Phase 3D bed extras and where they sit relative to the crop sprite of the same bed (negative = on the soil, under the
 * crop; positive = standing over it). Reusable art for every crop: no per-crop sprites.
 */
const EXTRA_Z: Record<string, number> = {
  soil_dry: -0.3, soil_wet: -0.3, sup_mulch: -0.25, sup_drainage: -0.35,
  sup_rain_cover: 0.5, sup_insect_net: 0.52, sup_shade_net: 0.54, sup_tag_spray: 0.6, sup_tag_tonic: 0.62,
};

export interface FarmEntity {
  key: string;
  sprite: Sprite;
  shadow?: Sprite;
  /** emissive night-glow sprite (outside the grade), when the art has one */
  glow?: Sprite;
  sway: number;
  instanceScale: number;
  baseX: number;
  baseY: number;
}

interface Bed {
  slot: number;
  bed: FarmEntity | null;
  crop: FarmEntity | null;
  x: number;
  y: number;
  shown: { key: string | null; stage: number };
  damp: Sprite;
  dampSince: number | null;
  halo: Sprite;
  ready: boolean;
  /** the base crop sprite to show when a skin sprite cannot be loaded */
  fallback: string | null;
  pending: number;
  pop: { start: number; dur: number; from: number; kind: "grow" | "sprout" | "harvest" } | null;
  impulse: { start: number; amp: number } | null;
  phase: number;
  /** Phase 3C: pest damage stage shown on this bed (0 = none / resolved, 2 = nibbled leaves, 3 = wilting) */
  damage: number;
  /** when the current damage look began (eases the tint / droop in) */
  damageSince: number;
  overlays: { leaf: FarmEntity | null; wilt: FarmEntity | null };
  overlayPending: { leaf: boolean; wilt: boolean };
  /** Phase 3D: soil condition / supplies drawn on this bed (sprite key → entity + when it appeared) */
  extras: Map<string, { e: FarmEntity; since: number; on: boolean }>;
  extraPending: Set<string>;
  wantExtras: string[];
  /** stressed soil that is slowing the crop now (drives a gentle tint and sag, fully reversible) */
  soil: "DRY" | "WET" | null;
  soilSince: number;
}

/** One-shot particle: position, scale and alpha are closed-form in its age. */
interface Particle {
  s: Sprite;
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  g: number;
  start: number;
  life: number;
  alpha: number;
  /** droplets stop (and fade) when they reach the soil */
  landY?: number;
}

export interface FarmLayerDeps {
  manifest: WorldManifest;
  shadows: ShadowLayer;
  soft: Texture;
  ring: Texture;
  groundObjects: Container;
  groundFx: Container;
  fxLayer: Container;
  loadTexture: (file: string) => Promise<Texture | null>;
  createCrop: (key: string, slot: number) => FarmEntity | null;
  swayFor: (key: string) => number;
}

const MAX_PARTICLES = 72;
const DAMP_ALPHA = 0.3;

/** Linear blend of two RGB tints (0xRRGGBB). */
function mixTint(a: number, b: number, t: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
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

export class FarmLayer {
  private cinematic: GardenCinematicBurst | null = null;
  private readonly beds = new Map<number, Bed>();
  private readonly particles: Particle[] = [];
  private readonly pool: Sprite[] = [];
  private readonly rings: Array<{ s: Sprite; start: number; life: number; w: number }> = [];
  private readonly dampTex: Texture;
  private generation = 0;
  /** skin sprites that failed to load once: their crops show the base art from then on (no retry storm) */
  private readonly broken = new Set<string>();
  private fxCount = 0;
  private now = 0;
  reduced = false;

  constructor(private readonly deps: FarmLayerDeps, slots: Array<{ slot: number; bed: FarmEntity | null; crop: FarmEntity | null; x: number; y: number }>) {
    this.dampTex = FarmLayer.dampTexture();
    for (const s of slots) this.addBed(s);
  }

  /** Phase 3A: register a bed bought during play (or present at entry); a slot already known is left unchanged. */
  addBed(s: { slot: number; bed: FarmEntity | null; crop: FarmEntity | null; x: number; y: number }) {
    if (this.beds.has(s.slot)) return;
    const deps = this.deps;
    const damp = new Sprite(this.dampTex);
    damp.anchor.set(0.5);
    damp.position.set(s.x, s.y - 7);
    damp.width = 104;
    damp.height = 52;
    damp.alpha = 0;
    damp.eventMode = "none";
    damp.zIndex = (s.bed?.sprite.zIndex ?? s.y) + 0.5;
    deps.groundObjects.addChild(damp);
    const halo = new Sprite(deps.ring);
    halo.anchor.set(0.5);
    halo.position.set(s.x, s.y - 4);
    halo.scale.set(118 / deps.ring.width, 59 / deps.ring.height);
    halo.tint = 0xf4b63f;
    halo.blendMode = "add";
    halo.alpha = 0;
    halo.eventMode = "none";
    deps.groundFx.addChild(halo);
    this.beds.set(s.slot, {
      ...s, damp, dampSince: null, halo, ready: false, fallback: null, pending: 0, pop: null, impulse: null, phase: s.slot * 1.7,
      damage: 0, damageSince: 0, overlays: { leaf: null, wilt: null }, overlayPending: { leaf: false, wilt: false },
      extras: new Map(), extraPending: new Set(), wantExtras: [], soil: null, soilSince: 0,
      shown: { key: s.crop?.key ?? null, stage: s.crop ? Number(s.crop.key.slice(-1)) : 0 },
    });
  }

  hasBed(slot: number): boolean {
    return this.beds.has(slot);
  }

  /** A soft-edged dark diamond that reads as moist soil over the bed interior (normal blend, inside the grade). */
  private static dampTexture(): Texture {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 64;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.filter = "blur(5px)";
      ctx.fillStyle = "rgba(34,20,10,1)";
      ctx.beginPath();
      ctx.moveTo(64, 10);
      ctx.lineTo(116, 32);
      ctx.lineTo(64, 54);
      ctx.lineTo(12, 32);
      ctx.closePath();
      ctx.fill();
    }
    return Texture.from(c);
  }

  /** Bring every bed in line with the server's visuals (idempotent; only differences do work). */
  apply(visuals: PlotVisual[]) {
    const gen = ++this.generation;
    for (const v of visuals) {
      const bed = this.beds.get(v.slot);
      if (!bed) continue;
      // Phase 3B: a planting's skin is art only; a skin sprite missing from the manifest shows the base crop
      const want = v.cropCode ? cropSpriteKey(v.cropCode, v.stage, v.skinArt) : null;
      const key = want && v.cropCode && (!this.deps.manifest.sprites[want] || this.broken.has(want))
        ? cropSpriteKey(v.cropCode, v.stage) : want;
      bed.fallback = v.cropCode && key ? baseCropKey(v.cropCode, key) : null;
      bed.ready = !!v.cropCode && v.ready;
      const damp = !!v.cropCode && v.watered;
      if (!damp) bed.dampSince = null;
      else if (bed.dampSince === null) bed.dampSince = this.reduced ? -1e9 : this.now;
      // Phase 3C: the damage a Forgotten Pest has done so far (a warning or a resolved pest shows no damage)
      this.setDamage(bed, v.cropCode && (v.pestStage ?? 0) >= 2 ? Math.min(3, v.pestStage as number) : 0);
      // Phase 3D: the soil's condition and the supplies working on this crop
      this.setExtras(bed, v.cropCode ? v.extras ?? [] : []);
      this.setSoil(bed, v.cropCode ? v.soilStress ?? null : null);
      if (key === bed.shown.key) continue;
      bed.pending = gen;
      void this.showKey(bed, key, v.stage, gen);
    }
  }

  private async showKey(bed: Bed, key: string | null, stage: number, gen: number) {
    const prev = bed.shown;
    if (!key) {
      bed.shown = { key: null, stage: 0 };
      if (bed.crop && bed.pop?.kind !== "harvest") this.hideCrop(bed);
      return;
    }
    let entry: SpriteEntry | undefined = this.deps.manifest.sprites[key];
    if (!entry) return;
    let tex = await this.deps.loadTexture(entry.file);
    if (!tex && bed.fallback && bed.fallback !== key && this.deps.manifest.sprites[bed.fallback]) {
      // the skin file failed to load: the crop still shows (base art) — a cosmetic never breaks the farm
      this.broken.add(key);
      key = bed.fallback;
      entry = this.deps.manifest.sprites[key];
      tex = await this.deps.loadTexture(entry.file);
    }
    const shadowTex = entry.shadow ? await this.deps.loadTexture(entry.shadow.file) : null;
    if (!tex || bed.pending !== gen) return;
    if (!bed.crop) {
      bed.crop = this.deps.createCrop(key, bed.slot);
      if (!bed.crop) return;
    } else {
      const e = bed.crop;
      e.key = key;
      e.sway = this.deps.swayFor(key);
      e.sprite.texture = tex;
      e.sprite.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
      e.sprite.scale.set(entry.scale * e.instanceScale);
      if (entry.shadow && shadowTex) {
        const spec: ShadowSpec = { texture: shadowTex, ax: entry.shadow.ax, ay: entry.shadow.ay, scale: entry.shadow.scale };
        if (e.shadow) this.deps.shadows.replace(e.shadow, spec, e.instanceScale);
        else e.shadow = this.deps.shadows.add(spec, e.baseX, e.baseY, e.instanceScale);
      }
    }
    const e = bed.crop;
    e.sprite.visible = true;
    e.sprite.alpha = 1;
    if (e.shadow) this.deps.shadows.setVisible(e.shadow, true);
    bed.shown = { key, stage };
    this.syncOverlays(bed);
    // a crop that grew one stage swells gently into its new shape (never a hard pop)
    if (!this.reduced && prev.key && stage > prev.stage && bed.pop?.kind !== "sprout") {
      bed.pop = { start: this.now, dur: 0.7, from: 0.86, kind: "grow" };
      if(stage===4&&prev.stage<4){
        if(!this.cinematic){this.cinematic=new GardenCinematicBurst();this.deps.fxLayer.addChild(this.cinematic.mesh);}
        this.cinematic.start(this.now,e.baseX,e.baseY-40*e.instanceScale,100*e.instanceScale);
      }
    }
  }

  /** Shows the damage look of a stage: overlays (lazy art), then tint and droop in `update`. */
  private setDamage(bed: Bed, stage: number) {
    if (stage === bed.damage) return;
    bed.damage = stage;
    bed.damageSince = this.reduced ? -1e9 : this.now;
    if (stage >= 2) void this.ensureOverlay(bed, "leaf");
    if (stage >= 3) void this.ensureOverlay(bed, "wilt");
    this.syncOverlays(bed);
    if (stage === 0 && bed.crop) {
      bed.crop.sprite.tint = 0xffffff;
      bed.crop.sprite.scale.y = Math.abs(bed.crop.sprite.scale.x);
    }
  }

  /** Phase 3D: shows exactly the wanted extras on a bed (art loads on demand; a missing sprite simply shows nothing). */
  private setExtras(bed: Bed, wanted: string[]) {
    bed.wantExtras = wanted;
    for (const key of wanted) {
      const x = bed.extras.get(key);
      if (x) {
        if (!x.on) {
          x.on = true;
          x.since = this.reduced ? -1e9 : this.now;
        }
      } else {
        void this.ensureExtra(bed, key);
      }
    }
    for (const [key, x] of bed.extras) {
      if (!wanted.includes(key) && x.on) {
        x.on = false;
        x.since = this.reduced ? -1e9 : this.now;
      }
    }
  }

  private async ensureExtra(bed: Bed, key: string) {
    if (bed.extras.has(key) || bed.extraPending.has(key)) return;
    const entry = this.deps.manifest.sprites[key];
    if (!entry) return;
    bed.extraPending.add(key);
    const tex = await this.deps.loadTexture(entry.file);
    bed.extraPending.delete(key);
    if (!tex || bed.extras.has(key)) return;
    const e = this.deps.createCrop(key, bed.slot);
    if (!e) return;
    e.sway = 0;
    e.sprite.zIndex += EXTRA_Z[key] ?? 0.5;
    e.sprite.alpha = 0;
    e.sprite.eventMode = "none";
    const on = bed.wantExtras.includes(key);
    bed.extras.set(key, { e, since: this.reduced ? -1e9 : this.now, on });
  }

  private setSoil(bed: Bed, soil: "DRY" | "WET" | null) {
    if (soil === bed.soil) return;
    bed.soil = soil;
    bed.soilSince = this.reduced ? -1e9 : this.now;
    if (!soil && bed.damage < 2 && bed.crop) {
      bed.crop.sprite.tint = 0xffffff;
      bed.crop.sprite.scale.y = Math.abs(bed.crop.sprite.scale.x);
    }
  }

  private syncOverlays(bed: Bed) {
    const on = !!bed.crop?.sprite.visible;
    if (bed.overlays.leaf) bed.overlays.leaf.sprite.visible = on && bed.damage >= 2;
    if (bed.overlays.wilt) bed.overlays.wilt.sprite.visible = on && bed.damage >= 3;
  }

  private async ensureOverlay(bed: Bed, kind: "leaf" | "wilt") {
    if (bed.overlays[kind] || bed.overlayPending[kind]) return;
    const key = DAMAGE_ART[kind];
    const entry = this.deps.manifest.sprites[key];
    if (!entry) return; // the damage still shows through the crop's tint and droop
    bed.overlayPending[kind] = true;
    const tex = await this.deps.loadTexture(entry.file);
    bed.overlayPending[kind] = false;
    if (!tex || bed.overlays[kind]) return;
    const e = this.deps.createCrop(key, bed.slot);
    if (!e) return;
    e.sway = 0;
    e.sprite.zIndex += kind === "wilt" ? 0.4 : 0.3; // over the crop on the same bed, under the next row
    e.sprite.alpha = 0;
    bed.overlays[kind] = e;
    this.syncOverlays(bed);
  }

  private hideCrop(bed: Bed) {
    if (bed.overlays.leaf) bed.overlays.leaf.sprite.visible = false;
    if (bed.overlays.wilt) bed.overlays.wilt.sprite.visible = false;
    if (!bed.crop) return;
    bed.crop.sprite.visible = false;
    bed.crop.sprite.alpha = 1;
    bed.crop.sprite.y = bed.crop.baseY;
    if (bed.crop.shadow) this.deps.shadows.setVisible(bed.crop.shadow, false);
    bed.pop = null;
  }

  /** One-shot feedback for an action on a bed (plays at once: the action is optimistic, the server confirms). */
  fx(kind: FarmFxKind, slot: number) {
    const bed = this.beds.get(slot);
    if (!bed) return;
    const rnd = seeded(slot * 7919 + ++this.fxCount * 104729);
    const now = this.now;
    if (kind === "plant") {
      if (this.reduced) return;
      bed.pop = { start: now, dur: 0.34, from: 0.35, kind: "sprout" };
      this.burst(rnd, bed.x, bed.y - 8, 12, 0x8a6544, { speed: 55, up: 40, g: 160, life: 0.55, size: 7, alpha: 0.75 });
    } else if (kind === "water") {
      if (bed.dampSince === null) bed.dampSince = this.reduced ? -1e9 : now;
      if (this.reduced) return;
      for (let i = 0; i < 16; i++) {
        const p = this.particle(0x9fdcff, 0.85);
        if (!p) break;
        p.x0 = bed.x + (rnd() - 0.5) * 70;
        p.y0 = bed.y - 70 - rnd() * 35;
        p.s.scale.set(2.2 / 64, 7 / 64);
        p.vy = 120 + rnd() * 60;
        p.g = 520;
        p.start = now + i * 0.018;
        p.life = 0.6;
        p.landY = bed.y - 6 + (rnd() - 0.5) * 18;
      }
      // Contact ripples follow the confirmed shower, flattening onto the same soil plane.
      for (let i = 0; i < 3; i++) {
        const ring = new Sprite(this.deps.ring); ring.anchor.set(.5); ring.position.set(bed.x + (i - 1) * 19, bed.y - 5 + (i % 2) * 6);
        ring.tint = 0xa6eaff; ring.blendMode = 'add'; ring.alpha = 0; ring.eventMode = 'none';
        this.deps.groundFx.addChild(ring); this.rings.push({ s: ring, start: now + .25 + i * .12, life: .75, w: 50 + i * 15 });
      }
      bed.impulse = { start: now + 0.2, amp: 0.07 };
    } else if (kind === "fertilize") {
      if (this.reduced) return;
      const r = new Sprite(this.deps.ring);
      r.anchor.set(0.5);
      r.position.set(bed.x, bed.y - 6);
      r.tint = 0x74c98b;
      r.blendMode = "add";
      r.alpha = 0;
      r.eventMode = "none";
      this.deps.groundFx.addChild(r);
      this.rings.push({ s: r, start: now, life: 0.6, w: 118 });
      this.burst(rnd, bed.x, bed.y - 18, 6, 0x9fe0a6, { speed: 18, up: 46, g: -10, life: 0.8, size: 5, alpha: 0.8 });
      bed.impulse = { start: now, amp: 0.04 };
    } else if (kind === "treat" || kind === "spray") {
      // Phase 3D: a supply settles on the bed — one soft ring and a few motes (teal for care, leaf green for the spray)
      if (this.reduced) return;
      const r = new Sprite(this.deps.ring);
      r.anchor.set(0.5);
      r.position.set(bed.x, bed.y - 6);
      r.tint = kind === "spray" ? 0x9fe0a6 : 0x9fe8e0;
      r.blendMode = "add";
      r.alpha = 0;
      r.eventMode = "none";
      this.deps.groundFx.addChild(r);
      this.rings.push({ s: r, start: now, life: 0.7, w: 124 });
      this.burst(rnd, bed.x, bed.y - 26, kind === "spray" ? 14 : 8, kind === "spray" ? 0xb8f0c0 : 0xc8f4ee,
        { speed: kind === "spray" ? 30 : 16, up: 34, g: 30, life: 0.9, size: kind === "spray" ? 5 : 6, alpha: 0.8 });
      bed.impulse = { start: now, amp: 0.03 };
    } else if (kind === "recover") {
      // Phase 3C: the word was genuinely reviewed — the crop straightens, a soft ring and a few leaves rise
      if (this.reduced) return;
      const r = new Sprite(this.deps.ring);
      r.anchor.set(0.5);
      r.position.set(bed.x, bed.y - 6);
      r.tint = 0x9ff0c0;
      r.blendMode = "add";
      r.alpha = 0;
      r.eventMode = "none";
      this.deps.groundFx.addChild(r);
      this.rings.push({ s: r, start: now, life: 0.9, w: 132 });
      this.burst(rnd, bed.x, bed.y - 22, 12, 0xa8f0b4, { speed: 16, up: 62, g: -14, life: 1.25, size: 6, alpha: 0.9 });
      this.burst(rnd, bed.x, bed.y - 30, 5, 0xfff2b0, { speed: 10, up: 46, g: -8, life: 1.4, size: 4, alpha: 0.8 });
      if (bed.crop?.sprite.visible) bed.pop = { start: now, dur: 0.6, from: 0.9, kind: "grow" };
    } else if (kind === "harvest") {
      if (bed.crop && bed.crop.sprite.visible) {
        if (this.reduced) this.hideCrop(bed);
        else bed.pop = { start: now, dur: 0.42, from: 1, kind: "harvest" };
      }
      if (!this.reduced) this.burst(rnd, bed.x, bed.y - 34, 9, 0xf4c35a, { speed: 26, up: 70, g: -6, life: 0.9, size: 6, alpha: 0.9 });
    }
  }

  private particle(tint: number, alpha: number): Particle | null {
    if (this.particles.length >= MAX_PARTICLES) return null;
    const s = this.pool.pop() ?? new Sprite(this.deps.soft);
    s.anchor.set(0.5);
    s.tint = tint;
    s.alpha = 0;
    s.visible = true;
    s.eventMode = "none";
    this.deps.fxLayer.addChild(s);
    const p: Particle = { s, x0: 0, y0: 0, vx: 0, vy: 0, g: 0, start: this.now, life: 0.5, alpha };
    this.particles.push(p);
    return p;
  }

  private burst(rnd: () => number, x: number, y: number, n: number, tint: number,
                o: { speed: number; up: number; g: number; life: number; size: number; alpha: number }) {
    for (let i = 0; i < n; i++) {
      const p = this.particle(tint, o.alpha);
      if (!p) return;
      const a = (i / n) * Math.PI * 2 + rnd() * 0.4;
      p.x0 = x + Math.cos(a) * 8;
      p.y0 = y + Math.sin(a) * 4;
      p.s.scale.set((o.size * (0.7 + rnd() * 0.5)) / 64);
      p.vx = Math.cos(a) * o.speed * (0.6 + rnd() * 0.6);
      p.vy = -o.up * (0.6 + rnd() * 0.6);
      p.g = o.g;
      p.life = o.life * (0.8 + rnd() * 0.4);
    }
  }

  /**
   * Called every frame after the canvas applied wind sway. {@code now}: real seconds (one-shot reactions);
   * {@code envT}: the environment clock (ambient bob / halo; frozen by reduced motion, paused in a hidden tab).
   */
  update(now: number, envT: number) {
    this.cinematic?.update(now,this.reduced);
    this.now = now;
    for (const bed of this.beds.values()) {
      const e = bed.crop;
      const breathe = this.reduced ? 0 : 0.14 * Math.sin(envT * Math.PI);
      bed.halo.alpha = bed.ready && e?.sprite.visible ? 0.5 + breathe : 0;
      bed.damp.alpha = bed.dampSince === null ? 0 : DAMP_ALPHA * Math.min(1, (now - bed.dampSince) / 0.6);
      // Phase 3D: extras fade in and out (they stay while a crop is on the bed, growing or ripe)
      for (const x of bed.extras.values()) {
        const u = Math.min(1, Math.max(0, (now - x.since) / 0.5));
        const visible = !!e?.sprite.visible || x.on;
        x.e.sprite.alpha = !e?.sprite.visible ? 0 : x.on ? u : 1 - u;
        x.e.sprite.visible = visible && x.e.sprite.alpha > 0.01;
        x.e.sprite.y = x.e.baseY;
      }
      if (!e || !e.sprite.visible) continue;
      const k = (this.deps.manifest.sprites[e.key]?.scale ?? 1) * e.instanceScale;
      let scale = 1;
      if (bed.pop) {
        const u = Math.min(1, Math.max(0, (now - bed.pop.start) / bed.pop.dur));
        if (bed.pop.kind === "harvest") {
          scale = 1 + 0.15 * Math.sin(Math.min(1, u * 1.6) * Math.PI * 0.5);
          e.sprite.alpha = 1 - Math.max(0, (u - 0.35) / 0.65);
          if (u >= 1) {
            this.hideCrop(bed);
            continue;
          }
        } else {
          const back = 1 + 2.2 * Math.pow(u - 1, 3) + 1.2 * Math.pow(u - 1, 2); // easeOutBack, restrained overshoot
          scale = bed.pop.from + (1 - bed.pop.from) * back;
          if (u >= 1) bed.pop = null;
        }
      }
      e.sprite.scale.set(k * scale);
      e.sprite.y = e.baseY - (bed.ready && !this.reduced ? 1.5 + 1.5 * Math.sin(envT * Math.PI + bed.phase) : 0);
      // Phase 3C: nibbled leaves yellow a little; a wilting crop dries, sags and leans (eased in, fully reversible)
      if (bed.damage >= 2) {
        const u = Math.min(1, Math.max(0, (now - bed.damageSince) / 0.9));
        const ease = u * u * (3 - 2 * u);
        e.sprite.tint = mixTint(0xffffff, DAMAGE_TINT[bed.damage] ?? 0xffffff, ease);
        if (bed.damage >= 3) {
          e.sprite.scale.y = k * scale * (1 - 0.08 * ease);
          e.sprite.skew.x += 0.07 * ease;
        }
        for (const o of [bed.overlays.leaf, bed.overlays.wilt]) {
          if (o?.sprite.visible) {
            o.sprite.alpha = ease;
            o.sprite.y = o.baseY;
          }
        }
      }
      // Phase 3D: thirsty / waterlogged soil — the crop loses a little colour and sags (never when a pest look is on)
      if (bed.soil && bed.damage < 2) {
        const u = Math.min(1, Math.max(0, (now - bed.soilSince) / 0.9));
        const ease = u * u * (3 - 2 * u);
        e.sprite.tint = mixTint(0xffffff, SOIL_TINT[bed.soil], ease);
        e.sprite.scale.y = k * scale * (1 - 0.06 * ease);
        e.sprite.skew.x += (bed.soil === "DRY" ? 0.05 : -0.03) * ease;
      }
      if (bed.impulse) {
        const a = now - bed.impulse.start;
        if (a >= 0) e.sprite.skew.x += bed.impulse.amp * Math.exp(-a * 5) * Math.sin(a * 18);
        if (a > 1) bed.impulse = null;
      }
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const age = now - p.start;
      if (age < 0) continue;
      let y = p.y0 + p.vy * age + 0.5 * p.g * age * age;
      let fadeStart = p.life * 0.4;
      if (p.landY !== undefined && y >= p.landY) {
        y = p.landY;
        fadeStart = Math.min(fadeStart, age);
      }
      p.s.position.set(p.x0 + p.vx * age, y);
      p.s.alpha = p.alpha * (age <= fadeStart ? 1 : Math.max(0, 1 - (age - fadeStart) / Math.max(0.05, p.life - fadeStart)));
      if (age >= p.life) {
        p.s.visible = false;
        p.s.parent?.removeChild(p.s);
        this.pool.push(p.s);
        this.particles.splice(i, 1);
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      if (now < r.start) { r.s.alpha = 0; continue; }
      const u = Math.min(1, Math.max(0, (now - r.start) / r.life));
      const w = r.w * (0.3 + 0.8 * (1 - Math.pow(1 - u, 3)));
      r.s.scale.set(w / r.s.texture.width, (w * 0.5) / r.s.texture.height);
      r.s.alpha = 0.7 * (1 - u);
      if (u >= 1) {
        r.s.destroy();
        this.rings.splice(i, 1);
      }
    }
  }

  /** World point (zoom-1 px) above a bed, for fly-to-HUD animations. */
  bedPoint(slot: number): { x: number; y: number } | null {
    const b = this.beds.get(slot);
    return b ? { x: b.x, y: b.y - 30 } : null;
  }

  activeParticles(): number {
    return this.particles.length + this.rings.length;
  }

  /** QA: the Phase 3D extras and soil look of every bed that shows any. */
  extraStats(): Array<{ slot: number; extras: string[]; soil: string | null }> {
    return [...this.beds.values()].filter((b) => b.soil || [...b.extras.values()].some((x) => x.on)).map((b) => ({
      slot: b.slot, extras: [...b.extras.entries()].filter(([, x]) => x.on && x.e.sprite.visible).map(([k]) => k), soil: b.soil,
    }));
  }

  /** QA: the damage look of every bed that shows one (slot → stage, overlays on screen). */
  damageStats(): Array<{ slot: number; stage: number; leaf: boolean; wilt: boolean }> {
    return [...this.beds.values()].filter((b) => b.damage > 0).map((b) => ({
      slot: b.slot, stage: b.damage, leaf: !!b.overlays.leaf?.sprite.visible, wilt: !!b.overlays.wilt?.sprite.visible,
    }));
  }

  /** Run after the renderer is destroyed: stage children are already gone, pooled (detached) sprites are not. */
  destroy() {
    this.cinematic?.destroy();this.cinematic=null;
    const kill = (s: Sprite) => {
      if (!s.destroyed) s.destroy();
    };
    this.particles.forEach((p) => kill(p.s));
    this.pool.forEach(kill);
    this.rings.forEach((r) => kill(r.s));
    this.particles.length = 0;
    this.pool.length = 0;
    this.rings.length = 0;
    this.dampTex.destroy(true);
  }
}
