import { Container, Sprite, Texture } from "pixi.js";
import { Wind } from "./environment";
import type { SeasonName } from "./lightRig";

/**
 * Echo Garden Phase 2 — seasonal and weather particles + the rainbow.
 *
 * Spring petals, summer seed fluff, autumn leaves, winter flurries (heavier while it snows), rain streaks while it rains.
 * Every particle position is a CLOSED-FORM function of the environment clock and a per-particle seed (no global RNG,
 * no per-frame accumulation): reduced motion freezes them, a hidden tab pauses them, the same time always looks the
 * same. Counts are bounded (pooled sprites created once) and halved on narrow screens. Particles live in world space
 * over the island so they belong to the scene; they fade near the edges of their band so a wrap is never visible.
 */

export type FxKind = "petal" | "fluff" | "leaf" | "snow" | "rain";

interface P {
  s: Sprite;
  kind: FxKind;
  x0: number;
  y0: number;
  speed: number;
  sway: number;
  swayHz: number;
  phase: number;
  spin: number;
  drift: number;
  size: number;
}

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

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): Texture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (ctx) draw(ctx);
  return Texture.from(c);
}

/** Small painted particle textures (no download). */
function textures(): Record<FxKind, Texture> {
  return {
    petal: canvasTex(32, 32, (c) => {
      const g = c.createRadialGradient(14, 14, 1, 16, 16, 14);
      g.addColorStop(0, "#fff3f7");
      g.addColorStop(0.55, "#f6c3d6");
      g.addColorStop(1, "rgba(236,160,190,0)");
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(16, 16, 13, 8, 0.5, 0, Math.PI * 2);
      c.fill();
    }),
    fluff: canvasTex(32, 32, (c) => {
      const g = c.createRadialGradient(16, 16, 0, 16, 16, 15);
      g.addColorStop(0, "rgba(255,255,250,0.95)");
      g.addColorStop(0.35, "rgba(255,255,245,0.45)");
      g.addColorStop(1, "rgba(255,255,240,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 32, 32);
    }),
    leaf: canvasTex(32, 32, (c) => {
      c.translate(16, 16);
      c.rotate(0.6);
      const g = c.createLinearGradient(-12, 0, 12, 0);
      g.addColorStop(0, "#b4521e");
      g.addColorStop(0.5, "#e08a2c");
      g.addColorStop(1, "#f1c35a");
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(-13, 0);
      c.quadraticCurveTo(0, -9, 13, 0);
      c.quadraticCurveTo(0, 9, -13, 0);
      c.fill();
      c.strokeStyle = "rgba(110,50,20,0.55)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(-12, 0);
      c.lineTo(12, 0);
      c.stroke();
    }),
    snow: canvasTex(32, 32, (c) => {
      const g = c.createRadialGradient(16, 16, 0, 16, 16, 15);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.45, "rgba(244,248,255,0.75)");
      g.addColorStop(1, "rgba(235,242,255,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 32, 32);
    }),
    rain: canvasTex(8, 64, (c) => {
      const g = c.createLinearGradient(0, 0, 0, 64);
      g.addColorStop(0, "rgba(220,232,245,0)");
      g.addColorStop(0.7, "rgba(220,232,245,0.75)");
      g.addColorStop(1, "rgba(235,242,250,0.95)");
      c.fillStyle = g;
      c.fillRect(3, 0, 2, 64);
    }),
  };
}

/** The rainbow: spectral bands painted per pixel with soft edges (sky art, like the sun disc). */
function rainbowTexture(): Texture {
  const W = 1024;
  const H = 520;
  return canvasTex(W, H, (c) => {
    const img = c.createImageData(W, H);
    const d = img.data;
    const cx = W / 2;
    const cy = H;
    const r0 = H * 0.78;
    const r1 = H * 0.98;
    const bands: Array<[number, number, number]> = [
      [148, 104, 214], [92, 120, 228], [86, 178, 222], [118, 204, 120], [246, 222, 104], [248, 168, 88], [232, 102, 96],
    ];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const r = Math.hypot(x - cx, y - cy);
        if (r < r0 || r > r1) continue;
        const u = (r - r0) / (r1 - r0);
        const f = u * (bands.length - 1);
        const i = Math.floor(f);
        const k = f - i;
        const a = bands[i];
        const b = bands[Math.min(bands.length - 1, i + 1)];
        const edge = Math.sin(u * Math.PI);
        // the arc fades toward its feet: it rises out of the cloud sea instead of ending in hard corners
        const feet = Math.min(1, Math.max(0, (cy - y) / (H * 0.35)));
        const o = (y * W + x) * 4;
        d[o] = a[0] + (b[0] - a[0]) * k;
        d[o + 1] = a[1] + (b[1] - a[1]) * k;
        d[o + 2] = a[2] + (b[2] - a[2]) * k;
        d[o + 3] = Math.round(255 * 0.55 * Math.pow(edge, 1.4) * feet);
      }
    }
    c.putImageData(img, 0, 0);
  });
}

export interface FxBounds { x0: number; y0: number; x1: number; y1: number }

const COUNTS: Record<FxKind, number> = { petal: 46, fluff: 26, leaf: 42, snow: 70, rain: 150 };
const SEASON_KIND: Record<SeasonName, FxKind> = { spring: "petal", summer: "fluff", autumn: "leaf", winter: "snow" };

export class SeasonFx {
  readonly root = new Container();
  readonly rainbow: Sprite;
  private readonly tex: Record<FxKind, Texture>;
  private readonly rainbowTex: Texture;
  private readonly items: P[] = [];
  /** visibility weight per kind (driven by the canvas fades) */
  weights: Record<FxKind, number> = { petal: 0, fluff: 0, leaf: 0, snow: 0, rain: 0 };

  constructor(private readonly bounds: FxBounds, narrow: boolean) {
    this.root.eventMode = "none";
    this.tex = textures();
    this.rainbowTex = rainbowTexture();
    this.rainbow = new Sprite(this.rainbowTex);
    this.rainbow.anchor.set(0.5, 1);
    this.rainbow.alpha = 0;
    this.rainbow.eventMode = "none";
    const rnd = seeded(20261009);
    const W = bounds.x1 - bounds.x0;
    const H = bounds.y1 - bounds.y0;
    (Object.keys(COUNTS) as FxKind[]).forEach((kind) => {
      const n = Math.round(COUNTS[kind] * (narrow ? 0.5 : 1));
      for (let i = 0; i < n; i++) {
        const s = new Sprite(this.tex[kind]);
        s.anchor.set(0.5);
        s.alpha = 0;
        s.visible = false;
        s.eventMode = "none";
        if (kind === "rain") s.tint = 0xdfe9f5;
        this.root.addChild(s);
        // world-space sizes: readable at the whole-island framing (zoom ≈ 0.45), never larger than a leaf up close
        const size = kind === "rain" ? 1.5 + rnd() * 0.7 : kind === "snow" ? 0.6 + rnd() * 0.6 : kind === "fluff" ? 0.5 + rnd() * 0.4 : 0.8 + rnd() * 0.5;
        this.items.push({
          s, kind,
          x0: rnd() * W, y0: rnd() * H,
          speed: kind === "rain" ? 760 + rnd() * 260 : kind === "snow" ? 26 + rnd() * 26 : kind === "fluff" ? 6 + rnd() * 8 : 22 + rnd() * 24,
          sway: kind === "rain" ? 0 : 14 + rnd() * 34,
          swayHz: 0.12 + rnd() * 0.25,
          phase: rnd() * Math.PI * 2,
          spin: (rnd() - 0.5) * (kind === "leaf" ? 2.4 : 1.4),
          drift: kind === "rain" ? 160 : kind === "fluff" ? 22 : 38 + rnd() * 20,
          size,
        });
      }
    });
  }

  /** Season → its ambient particle kind. */
  static kindFor(season: SeasonName): FxKind {
    return SEASON_KIND[season];
  }

  update(t: number) {
    const { x0, y0, x1, y1 } = this.bounds;
    const W = x1 - x0;
    const H = y1 - y0;
    const wind = Wind.distance(t);
    for (const p of this.items) {
      const w = this.weights[p.kind];
      if (w <= 0.001) {
        p.s.visible = false;
        continue;
      }
      p.s.visible = true;
      const fall = (p.y0 + p.speed * t) % H;
      let x = p.x0 + wind * (p.drift / 30) + p.sway * Math.sin(t * p.swayHz * Math.PI * 2 + p.phase);
      x = ((x % W) + W) % W;
      const ey = Math.min(fall / (H * 0.12), (H - fall) / (H * 0.12), 1);
      const ex = Math.min(x / (W * 0.08), (W - x) / (W * 0.08), 1);
      const fade = Math.max(0, Math.min(ey, ex));
      p.s.position.set(x0 + x, y0 + fall);
      if (p.kind === "rain") {
        p.s.rotation = 0.22;
        p.s.scale.set(p.size, p.size * 0.9);
        p.s.alpha = 0.5 * w * fade;
      } else {
        p.s.rotation = p.phase + p.spin * t;
        // petals and leaves flutter: their visible width breathes as they turn
        const flutter = p.kind === "petal" || p.kind === "leaf" ? 0.45 + 0.55 * Math.abs(Math.cos(t * (0.8 + p.swayHz) + p.phase)) : 1;
        p.s.scale.set(p.size * flutter, p.size);
        p.s.alpha = (p.kind === "fluff" ? 0.55 : 0.9) * w * fade;
      }
    }
  }

  visibleCount(): number {
    return this.items.filter((p) => p.s.visible && p.s.alpha > 0.01).length;
  }

  destroy() {
    Object.values(this.tex).forEach((t) => t.destroy(true));
    this.rainbowTex.destroy(true);
  }
}
