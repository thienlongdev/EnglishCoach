import { Container, Sprite, Text, TextStyle, Texture } from "pixi.js";

/**
 * Pooled ambient life (no per-frame allocation):
 * - chimney smoke: soft puffs that rise, widen, drift with the breeze and fade;
 * - pollen / light motes drifting over the meadows (day + sunset);
 * - rune letters rising slowly from the Knowledge Tree's heartwood (subtle, cyan-gold);
 * - fireflies over pond, forest edge and meadows (night only).
 */
interface Particle {
  s: Sprite | Text;
  age: number;
  life: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  seed: number;
}

/** Letters drift up like pollen, taken from English words (GDD 04 §1: letters are the garden's motif). */
const RUNE_WORDS = ["ECHO", "MEMORY", "WORDS", "LEARN", "GARDEN", "VOICE", "STORY"];
const RUNE_LETTERS = RUNE_WORDS.join("");

/** The app's own loaded UI font (no system serif); falls back to a rounded sans stack. */
function uiFontFamily(): string {
  try {
    const f = getComputedStyle(document.body).fontFamily;
    if (f) return f;
  } catch {
    /* SSR / detached */
  }
  return "Quicksand, system-ui, sans-serif";
}

export class AmbientFx {
  readonly back = new Container(); // under entities (smoke behind roof? no: drawn above)
  readonly front = new Container();
  readonly glowLayer = new Container();
  /** rune letters: normal blending (additive text washes out on bright grass) */
  readonly runeLayer = new Container();
  private smoke: Particle[] = [];
  private motes: Particle[] = [];
  private runes: Particle[] = [];
  private flies: Particle[] = [];
  private heartMotes: Particle[] = [];
  private t = 0;
  nightMix = 0; // 0 day .. 1 night

  /** QA: show / hide the Knowledge Tree's own magic (heartwood motes + rising letters) */
  setHeartVisible(visible: boolean) {
    this.heartMotes.forEach((p) => (p.s.visible = visible));
    this.runeLayer.visible = visible;
  }
  dayMix = 1;

  constructor(
    private readonly soft: Texture,
    private readonly chimney: { x: number; y: number },
    private readonly runeOrigin: { x: number; y: number },
    private readonly moteArea: { x0: number; y0: number; x1: number; y1: number },
    flySpots: Array<{ x: number; y: number }>,
  ) {
    this.glowLayer.blendMode = "add";
    for (let i = 0; i < 9; i++) {
      const s = new Sprite(soft);
      s.anchor.set(0.5);
      s.tint = 0xe9edf2;
      s.alpha = 0;
      this.front.addChild(s);
      this.smoke.push({ s, age: (i / 9) * 6, life: 6, x: 0, y: 0, vx: 0, vy: 0, seed: i * 1.37 });
    }
    for (let i = 0; i < 22; i++) {
      const s = new Sprite(soft);
      s.anchor.set(0.5);
      s.tint = 0xfff1b8;
      s.scale.set(0.09);
      this.glowLayer.addChild(s);
      const p = this.randomIn(moteArea);
      this.motes.push({ s, age: Math.random() * 10, life: 8 + Math.random() * 6, x: p.x, y: p.y, vx: 0, vy: 0, seed: i * 2.17 });
    }
    const style = new TextStyle({
      fontFamily: uiFontFamily(),
      fontSize: 22,
      fontWeight: "600",
      fill: 0xc6f3ea,
      dropShadow: { color: 0x3fcfc0, blur: 8, distance: 0, alpha: 0.9 },
    });
    // a few memory motes drifting up out of the heartwood hollow (soft round light, never sparkles)
    for (let i = 0; i < 7; i++) {
      const s = new Sprite(soft);
      s.anchor.set(0.5);
      // the heartwood's own teal / pale-aqua light (no gold: the core is not a lamp)
      s.tint = i % 3 === 0 ? 0xc8f7ec : 0x7fe3d2;
      s.alpha = 0;
      this.glowLayer.addChild(s);
      this.heartMotes.push({ s, age: (i / 7) * 5.5, life: 5.5, x: 0, y: 0, vx: 0, vy: 0, seed: i * 2.71 });
    }
    for (let i = 0; i < 4; i++) {
      const tx = new Text({ text: RUNE_LETTERS[(i * 7) % RUNE_LETTERS.length], style });
      tx.anchor.set(0.5);
      tx.alpha = 0;
      this.runeLayer.addChild(tx);
      this.runes.push({ s: tx, age: (i / 4) * 9, life: 9, x: 0, y: 0, vx: 0, vy: 0, seed: i * 1.91 });
    }
    flySpots.forEach((spot, k) => {
      for (let i = 0; i < 6; i++) {
        const s = new Sprite(soft);
        s.anchor.set(0.5);
        s.tint = 0xd9ff8a;
        s.scale.set(0.07);
        s.alpha = 0;
        this.glowLayer.addChild(s);
        this.flies.push({
          s, age: 0, life: 1, x: spot.x + (Math.random() - 0.5) * 220, y: spot.y + (Math.random() - 0.5) * 110,
          vx: 0, vy: 0, seed: k * 10 + i * 1.3,
        });
      }
    });
  }

  private randomIn(a: { x0: number; y0: number; x1: number; y1: number }) {
    return { x: a.x0 + Math.random() * (a.x1 - a.x0), y: a.y0 + Math.random() * (a.y1 - a.y0) };
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t;
    // smoke
    for (const p of this.smoke) {
      p.age += dt;
      if (p.age >= p.life) p.age -= p.life;
      const q = p.age / p.life;
      const s = p.s as Sprite;
      s.position.set(
        this.chimney.x + q * 70 + Math.sin(t * 0.8 + p.seed) * 8 * q,
        this.chimney.y - q * 150 - Math.sin(q * 3) * 6,
      );
      const size = 0.25 + q * 0.75;
      s.scale.set(size * 0.9, size * 0.75);
      s.alpha = 0.55 * Math.sin(Math.min(1, q * 1.4) * Math.PI) * (1 - q * 0.4);
    }
    // motes (day / sunset)
    const moteVis = Math.max(0, 1 - this.nightMix * 1.2);
    for (const p of this.motes) {
      p.age += dt;
      if (p.age >= p.life) {
        p.age = 0;
        const np = this.randomIn(this.moteArea);
        p.x = np.x;
        p.y = np.y;
      }
      const q = p.age / p.life;
      const s = p.s as Sprite;
      s.position.set(p.x + q * 60 + Math.sin(t * 0.6 + p.seed) * 14, p.y - q * 40 + Math.cos(t * 0.5 + p.seed) * 8);
      s.alpha = 0.35 * Math.sin(q * Math.PI) * moteVis;
    }
    // runes: always subtle, a little stronger at night
    for (const p of this.runes) {
      p.age += dt;
      if (p.age >= p.life) {
        p.age -= p.life;
        (p.s as Text).text = RUNE_LETTERS[Math.floor(Math.random() * RUNE_LETTERS.length)];
      }
      const q = p.age / p.life;
      const ang = p.seed * 2.4;
      // rise from the heartwood through the canopy tiers, drifting with a slow spiral
      p.s.position.set(
        this.runeOrigin.x + Math.cos(ang + q * 1.6) * (40 + q * 90) + Math.sin(t * 0.7 + p.seed) * 14,
        this.runeOrigin.y - q * 420,
      );
      p.s.scale.set(0.42 + q * 0.28);
      // letters are light themselves (drawn outside the night grade): faint, never label-bright
      p.s.alpha = (0.18 + 0.22 * this.nightMix) * Math.sin(q * Math.PI) ** 1.6;
    }
    // memory motes: rise from the hollow, slow spiral, fade high in the crown
    for (const p of this.heartMotes) {
      p.age += dt;
      if (p.age >= p.life) p.age -= p.life;
      const q = p.age / p.life;
      const s = p.s as Sprite;
      const ang = p.seed + q * 2.2;
      s.position.set(
        this.runeOrigin.x + Math.cos(ang) * (16 + q * 70) + Math.sin(t * 0.9 + p.seed) * 6,
        this.runeOrigin.y + 10 - q * 300,
      );
      s.scale.set(0.05 + 0.05 * Math.sin(q * Math.PI));
      s.alpha = (0.25 + 0.65 * this.nightMix) * Math.sin(q * Math.PI);
    }
    // fireflies
    for (const p of this.flies) {
      const s = p.s as Sprite;
      s.position.set(p.x + Math.sin(t * 0.9 + p.seed) * 40, p.y + Math.cos(t * 0.7 + p.seed * 1.3) * 22);
      const blink = Math.max(0, Math.sin(t * 2.1 + p.seed * 3.1));
      s.alpha = this.nightMix * (0.25 + 0.75 * blink * blink);
    }
  }

  destroy() {
    this.back.destroy({ children: true });
    this.front.destroy({ children: true });
    this.glowLayer.destroy({ children: true });
    this.runeLayer.destroy({ children: true });
  }
}
