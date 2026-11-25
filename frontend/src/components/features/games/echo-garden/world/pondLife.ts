import { Container, Graphics, Matrix, Sprite, Texture } from "pixi.js";
import { TILE_HALF_H, TILE_HALF_W } from "./worldData";

/**
 * Pond life drawn in a container whose local space IS the ground plane (1 unit = 1 grid tile):
 * matrix (64, 32, -64, 32) is the exact 2:1 projection, so anything rotated inside it
 * (fish headings, ripple circles, light streaks) is foreshortened correctly on screen.
 * Everything is masked to the water polygon.
 */
interface Fish {
  sprite: Sprite;
  len: number;
  seed: number;
  speed: number;
  heading: number;
  x: number;
  y: number;
}

interface Ripple {
  g: Sprite;
  age: number;
  life: number;
}

export class PondLife {
  readonly root = new Container();
  private readonly plane = new Container();
  private readonly mask = new Graphics();
  private fish: Fish[] = [];
  private streaks: Array<{ s: Sprite; seed: number; base: { x: number; y: number } }> = [];
  private ripples: Ripple[] = [];
  private rippleClock = 1.5;
  private t = 0;
  private readonly pxPerBU: number;
  private readonly cx: number;
  private readonly cy: number;
  private readonly rx: number;
  private readonly ry: number;

  constructor(
    water: Array<[number, number]>,
    surfaceOffsetPx: number,
    fishTex: Texture[],
    fishPxPerBU: number,
    private readonly soft: Texture,
    private readonly ring: Texture,
  ) {
    this.pxPerBU = fishPxPerBU;
    this.plane.setFromMatrix(new Matrix(TILE_HALF_W, TILE_HALF_H, -TILE_HALF_W, TILE_HALF_H, 0, surfaceOffsetPx));
    this.root.addChild(this.plane);
    // water mask in plane space
    this.mask.poly(water.flat());
    this.mask.fill({ color: 0xffffff });
    this.plane.addChild(this.mask);
    const content = new Container();
    content.mask = this.mask;
    this.plane.addChild(content);

    const xs = water.map((p) => p[0]);
    const ys = water.map((p) => p[1]);
    this.cx = xs.reduce((a, b) => a + b, 0) / xs.length;
    this.cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    this.rx = (Math.max(...xs) - Math.min(...xs)) * 0.32;
    this.ry = (Math.max(...ys) - Math.min(...ys)) * 0.32;

    // drifting sky-light streaks on the surface
    for (let i = 0; i < 7; i++) {
      const s = new Sprite(soft);
      s.anchor.set(0.5);
      s.blendMode = "add";
      s.tint = 0xdff6ff;
      s.alpha = 0.18;
      s.scale.set(1.1 / soft.width, 0.11 / soft.height);
      s.rotation = -0.6;
      const base = { x: this.cx + (Math.random() - 0.5) * this.rx * 2, y: this.cy + (Math.random() - 0.5) * this.ry * 2 };
      s.position.set(base.x, base.y);
      content.addChild(s);
      this.streaks.push({ s, seed: i * 1.7, base });
    }

    // koi: lengths in grid units, sprite rendered top-down (nose +X)
    fishTex.forEach((tex, i) => {
      const sp = new Sprite(tex);
      sp.anchor.set(0.5);
      const len = [0.46, 0.4, 0.38, 0.34][i % 4];
      const modelLenBU = 1.35; // fish model length in its render
      sp.scale.set((len / modelLenBU) / fishPxPerBU);
      sp.alpha = 0.9;
      sp.tint = 0xe9fbff;
      content.addChild(sp);
      this.fish.push({ sprite: sp, len, seed: i * 2.31 + 0.4, speed: 0.09 + i * 0.012, heading: 0, x: this.cx, y: this.cy });
    });
    this.rippleContent = content;
    this.update(0);
  }

  private readonly rippleContent: Container;

  private fishPos(f: Fish, t: number) {
    const s = f.seed;
    const u = t * f.speed;
    return {
      x: this.cx + this.rx * (Math.sin(u * 1.0 + s) * 0.85 + Math.sin(u * 2.3 + s * 2.1) * 0.15),
      y: this.cy + this.ry * (Math.sin(u * 1.37 + s * 0.7) * 0.8 + Math.cos(u * 0.9 + s * 1.3) * 0.2),
    };
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t;
    for (const f of this.fish) {
      const p = this.fishPos(f, t);
      const q = this.fishPos(f, t + 0.25);
      const want = Math.atan2(q.y - p.y, q.x - p.x);
      // continuous heading (no flips): shortest-arc easing
      let d = want - f.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      f.heading += d * Math.min(1, dt * 3 + (dt === 0 ? 1 : 0));
      f.x = p.x;
      f.y = p.y;
      f.sprite.position.set(p.x, p.y);
      // tail beat as a small yaw oscillation around the heading
      f.sprite.rotation = f.heading + Math.sin(t * 5.2 + f.seed) * 0.12;
      const base = (f.len / 1.35) / this.pxPerBU;
      f.sprite.scale.set(base * (1 + Math.sin(t * 5.2 + f.seed) * 0.03), base);
    }
    for (const st of this.streaks) {
      st.s.position.set(
        st.base.x + Math.sin(t * 0.12 + st.seed) * this.rx * 0.5,
        st.base.y + Math.cos(t * 0.09 + st.seed) * this.ry * 0.5,
      );
      st.s.alpha = 0.1 + 0.1 * (0.5 + 0.5 * Math.sin(t * 0.7 + st.seed * 3));
    }
    // ripple rings (circles on the ground plane -> ellipses on screen)
    this.rippleClock -= dt;
    if (this.rippleClock <= 0) {
      this.rippleClock = 2.2 + Math.random() * 2.8;
      const f = this.fish[Math.floor(Math.random() * this.fish.length)];
      const g = new Sprite(this.ring);
      g.anchor.set(0.5);
      g.tint = 0xffffff;
      g.position.set(f ? f.x : this.cx, f ? f.y : this.cy);
      this.rippleContent.addChild(g);
      this.ripples.push({ g, age: 0, life: 2.6 });
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      const q = r.age / r.life;
      const size = 0.15 + q * 0.7;
      r.g.scale.set(size / this.ring.width * 2);
      r.g.alpha = 0.45 * (1 - q);
      if (q >= 1) {
        r.g.destroy();
        this.ripples.splice(i, 1);
      }
    }
  }

  destroy() {
    this.root.destroy({ children: true });
    this.fish = [];
    this.ripples = [];
  }
}
