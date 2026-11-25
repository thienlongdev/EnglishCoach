import { Circle, Container, Rectangle, Sprite, Texture } from "pixi.js";

/**
 * Echo Whale — a real 3D character, pre-rendered in Blender (build_whale.py) as
 * `yaws` headings x `frames` swim-cycle frames through the shared dimetric camera and world light.
 *
 * Motion model (world pixels, zoom 1):
 * - a wide elliptical orbit around the island; the lower arc passes IN FRONT of the floating
 *   mountain, the upper arc BEHIND the island; the layer switches only at the orbit's left/right
 *   extremes, outside the island silhouette;
 * - the heading is the whale's WORLD velocity (screen velocity un-projected through the 2:1
 *   dimetric mapping), eased with momentum; the view is the matching pre-rendered 3D heading,
 *   cross-faded with its neighbour — turning is a true change of viewpoint, never a flipped or
 *   squashed card;
 * - the swim cycle (spine undulation, fluke strokes, paddling flippers) advances with speed;
 *   gentle vertical bob with a small matching pitch; slightly smaller and hazier on the far arc;
 * - an occasional soft spout from the blowhole on the near arc.
 */
export interface WhaleAtlas {
  yaws: number;
  frames: number;
  lengthBU: number;
  scale: number;
  /** [x, y, w, h, anchorX, anchorY] per view, index = yaw * frames + frame */
  rects: number[][];
}

const TILE_HALF_W = 64;
const TILE_HALF_H = 32;
const PX_PER_BU_Z = 78.38;

function angleLerp(a: number, b: number, k: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * k;
}

export class EchoWhale {
  readonly root = new Container();
  private readonly views: Texture[] = [];
  private readonly base: Sprite;
  private readonly blend: Sprite;
  private readonly puffs: Array<{ s: Sprite; age: number }> = [];
  private readonly puffLayer = new Container();
  private phi = 2.1;
  private omega = (Math.PI * 2) / 84;
  private heading = 0;
  private swim = 0;
  private t = 0;
  private spoutClock = 6;
  layer: "front" | "back" = "front";
  private hazeTint = 0xffffff;

  constructor(
    atlasTexture: Texture | null,
    private readonly atlas: WhaleAtlas | null,
    private readonly centre: { x: number; y: number },
    private readonly radii: { a: number; b: number },
    soft: Texture,
    private readonly baseScale = 1,
  ) {
    if (atlasTexture && atlas) {
      for (const r of atlas.rects) {
        this.views.push(new Texture({ source: atlasTexture.source, frame: new Rectangle(r[0], r[1], r[2], r[3]) }));
      }
    }
    this.base = new Sprite(this.views[0] ?? Texture.EMPTY);
    this.blend = new Sprite(this.views[0] ?? Texture.EMPTY);
    this.root.addChild(this.base, this.blend, this.puffLayer);
    for (let i = 0; i < 6; i++) {
      const s = new Sprite(soft);
      s.anchor.set(0.5);
      s.alpha = 0;
      s.tint = 0xf2fbff;
      this.puffLayer.addChild(s);
      this.puffs.push({ s, age: 99 });
    }
    this.root.eventMode = "static";
    this.root.cursor = "pointer";
    this.root.hitArea = new Circle(0, 0, 150);
    const v = this.velocity(1);
    this.heading = this.worldHeading(v.vx, v.vy);
    this.update(0, true);
  }

  /** depth in [0,1]: 1 = nearest point of the orbit */
  get depth(): number {
    return (Math.sin(this.phi) + 1) / 2;
  }

  private velocity(speedMul: number) {
    const { a, b } = this.radii;
    return { vx: -a * Math.sin(this.phi) * this.omega * speedMul, vy: b * Math.cos(this.phi) * this.omega * speedMul };
  }

  /** Screen velocity of horizontal flight -> heading angle in the Blender ground frame (X=gx, Y=-gy). */
  private worldHeading(vx: number, vy: number): number {
    const sum = vy / TILE_HALF_H; // gx + gy
    const diff = vx / TILE_HALF_W; // gx - gy
    const dgx = (sum + diff) / 2;
    const dgy = (sum - diff) / 2;
    return Math.atan2(-dgy, dgx);
  }

  private setView(sprite: Sprite, yaw: number, frame: number) {
    if (!this.atlas || !this.views.length) return;
    const idx = (((yaw % this.atlas.yaws) + this.atlas.yaws) % this.atlas.yaws) * this.atlas.frames + frame;
    const r = this.atlas.rects[idx];
    sprite.texture = this.views[idx];
    sprite.anchor.set(r[4] / r[2], r[5] / r[3]);
  }

  update(dt: number, still = false) {
    this.t += dt;
    const speedMul = 1 + 0.28 * Math.sin(this.t * 0.21) + 0.12 * Math.sin(this.t * 0.53 + 1.3);
    if (!still) this.phi += this.omega * speedMul * dt;
    const { a, b } = this.radii;
    const bob = still ? 0 : Math.sin(this.t * 0.9) * 16 + Math.sin(this.t * 0.37 + 0.6) * 10;
    const bobV = still ? 0 : Math.cos(this.t * 0.9) * 0.9 * 16;
    this.root.position.set(this.centre.x + a * Math.cos(this.phi), this.centre.y + b * Math.sin(this.phi) + bob);
    this.layer = Math.sin(this.phi) >= 0 ? "front" : "back";

    // heading with momentum: the body turns toward its travel direction, never snaps
    const v = this.velocity(speedMul);
    const want = this.worldHeading(v.vx, v.vy);
    this.heading = still ? want : angleLerp(this.heading, want, 1 - Math.exp(-dt * 1.6));
    // swim cycle: tail strokes quicken with speed
    if (!still) this.swim += dt * (0.62 + 0.38 * speedMul);
    const frames = this.atlas?.frames ?? 1;
    const frame = Math.floor(((this.swim % 1) + 1) % 1 * frames) % frames;
    const yaws = this.atlas?.yaws ?? 1;
    const yf = ((this.heading / (Math.PI * 2)) * yaws + yaws * 4) % yaws;
    const y0 = Math.floor(yf);
    this.setView(this.base, y0, frame);
    this.setView(this.blend, y0 + 1, frame);
    // Exactly ONE view outside a short window around the switch point. Inside it, one view is always
    // fully opaque (never a see-through body) while the other fades in, then the first fades out.
    const t = Math.min(1, Math.max(0, (yf - y0 - 0.47) / 0.06));
    this.blend.alpha = Math.min(1, t * 2);
    this.base.alpha = Math.min(1, (1 - t) * 2);
    this.blend.visible = this.blend.alpha > 0.001;
    this.base.visible = this.base.alpha > 0.001;

    // perspective: smaller and hazier on the far arc; a small pitch follows the vertical bob
    const persp = 0.8 + 0.2 * this.depth;
    const s = (this.atlas?.scale ?? 1) * this.baseScale * persp;
    this.base.scale.set(s);
    this.blend.scale.set(s);
    const pitch = Math.max(-0.09, Math.min(0.09, -bobV / 260)) * Math.cos(this.heading + Math.PI / 4);
    this.base.rotation = pitch;
    this.blend.rotation = pitch;
    // far arc: a touch of sky haze (opaque body, never see-through)
    const haze = Math.round(255 - 40 * (1 - this.depth));
    this.hazeTint = (haze << 16) | (Math.round(255 - 22 * (1 - this.depth)) << 8) | 255;
    this.base.tint = this.hazeTint;
    this.blend.tint = this.hazeTint;

    // spout: soft puffs from the blowhole (front-top of the head), near arc only
    const L = (this.atlas?.lengthBU ?? 3.6) * persp * this.baseScale;
    const hx = Math.cos(this.heading) * 0.18 * L;
    const hy = -Math.sin(this.heading) * 0.18 * L;
    const blow = { x: (hx - hy) * TILE_HALF_W, y: (hx + hy) * TILE_HALF_H - 0.55 * PX_PER_BU_Z * persp * this.baseScale };
    if (!still) {
      this.spoutClock -= dt;
      if (this.spoutClock <= 0) {
        this.spoutClock = 15 + Math.random() * 7;
        if (this.layer === "front") this.puffs.forEach((p, i) => (p.age = -i * 0.12));
      }
      for (const p of this.puffs) {
        p.age += dt;
        const q = p.age / 1.6;
        if (q < 0 || q > 1) {
          p.s.alpha = 0;
          continue;
        }
        p.s.position.set(blow.x + Math.sin(p.age * 3 + q) * 6, blow.y - q * 70);
        p.s.scale.set(0.35 + q * 0.9, 0.45 + q * 1.1);
        p.s.alpha = 0.7 * Math.sin(Math.min(1, q * 3) * Math.PI * 0.5) * (1 - q);
      }
    }
  }

  /** Phase 3B (non-WebGL fallback): the atlas whale answers a milestone with a spout only and shows no hint halo. */
  attention = false;

  cheer() {
    this.puffs.forEach((p, i) => (p.age = -i * 0.12));
  }

  /** development diagnostics (heading, chosen views, cross-fade) */
  debugState() {
    const idx = (t: Texture) => this.views.indexOf(t);
    return { heading: +this.heading.toFixed(3), baseView: idx(this.base.texture), blendView: idx(this.blend.texture),
      blendAlpha: +this.blend.alpha.toFixed(3), baseAlpha: this.base.alpha, rootAlpha: this.root.alpha, puffs: this.puffs.filter((p) => p.s.alpha > 0).length };
  }

  destroy() {
    this.views.forEach((v) => v.destroy(false));
    this.root.destroy({ children: true });
  }
}
