import { Container, Sprite, type Texture } from "pixi.js";
import { Wind, hash01, windowFade, wrapWindow } from "./environment";

/**
 * Depth-layered atmosphere for Echo Garden.
 *
 * Every atmospheric layer (and each satellite island) has its OWN transform derived from the shared
 * camera and its depth `k` (1 = the main island's plane, < 1 farther, > 1 nearer):
 *   zoom_k   = fitZoom · rel^k             (far layers barely zoom)
 *   camera_k = home + (camera - home) · k   (far layers barely pan)
 * At the home framing every layer lines up with the authored composition; when the camera pans or
 * zooms, layers separate by parallax. No layer is a child of the main island's container.
 */
export interface DepthView {
  /** camera centre (world px) and zoom */
  cx: number;
  cy: number;
  zoom: number;
  fitZoom: number;
  minRel: number;
  W: number;
  H: number;
  /** the home framing centre (world px): every layer coincides there */
  home: { x: number; y: number };
}

export function depthTransform(v: DepthView, k: number) {
  const rel = Math.max(1e-4, v.zoom / v.fitZoom);
  const z = v.fitZoom * Math.pow(rel, k);
  const camX = v.home.x + (v.cx - v.home.x) * k;
  const camY = v.home.y + (v.cy - v.home.y) * k;
  return { z, camX, camY, x: v.W / 2 - camX * z, y: v.H / 2 - camY * z };
}

export function applyDepth(c: Container, v: DepthView, k: number) {
  const d = depthTransform(v, k);
  c.scale.set(d.z);
  c.position.set(d.x, d.y);
  return d;
}

export interface CloudLayerConfig {
  id: string;
  /** parallax depth (1 = main island) */
  depth: number;
  count: number;
  /** vertical band (world px relative to the home centre) */
  band: [number, number];
  /** cloud scale range (1 = billow rendered size) */
  scale: [number, number];
  /** drift speed along the wind (layer px / s at wind speed 1) */
  speed: number;
  alpha: number;
  /** billows per cloud */
  puffs: [number, number];
  /** use the flat-based sea billows */
  sea?: boolean;
  /** aerial haze toward the sky colour (0..1), far layers are paler */
  haze?: number;
  /** minimum horizontal wrap window (layer px) */
  spanMin?: number;
}

interface Puff {
  s: Sprite;
  bx: number;
  by: number;
  bs: number;
  ax: number;
  ay: number;
  as: number;
  px: number;
  py: number;
  ps: number;
  ph: number;
}

interface Cloud {
  c: Container;
  x0: number;
  y0: number;
  speedK: number;
  bobA: number;
  bobP: number;
  ph: number;
  puffs: Puff[];
  alpha: number;
}

/**
 * One atmospheric layer of living clouds. Each cloud is a cluster of Blender-rendered cumulus billows
 * whose relative offsets and sizes breathe on slow, incommensurate periods (the shape evolves; no
 * jelly wobble), and which drifts with the shared wind at its own speed (clouds overtake each other).
 * Wrapping happens in a window centred on the layer camera and far wider than the view, and clouds
 * fade out near the window edges, so a cloud never pops, respawns or teleports inside the view.
 */
export class CloudLayer {
  readonly root = new Container();
  private clouds: Cloud[] = [];
  private span = 4000;

  constructor(
    readonly cfg: CloudLayerConfig,
    billows: Texture[],
    private readonly home: { x: number; y: number },
    seed: number,
  ) {
    this.root.eventMode = "none";
    this.root.label = `clouds-${cfg.id}`;
    const n = cfg.count;
    for (let i = 0; i < n; i++) {
      const h = (k: number) => hash01(seed * 31.7 + i * 7.13 + k * 1.91);
      const c = new Container();
      const sc = cfg.scale[0] + (cfg.scale[1] - cfg.scale[0]) * h(1);
      const np = cfg.puffs[0] + Math.floor(h(2) * (cfg.puffs[1] - cfg.puffs[0] + 1));
      const puffs: Puff[] = [];
      // order the cluster so the tallest billow sits near the middle (cumulus towers, not a row)
      for (let j = 0; j < np; j++) {
        const u = np === 1 ? 0 : j / (np - 1) - 0.5;
        const tex = billows[Math.floor(h(10 + j) * billows.length) % billows.length];
        const s = new Sprite(tex);
        s.anchor.set(0.5, 0.8);
        s.eventMode = "none";
        const centre = 1 - Math.abs(u) * 1.2;
        const bs = sc * (0.62 + 0.42 * Math.max(0, centre)) * (0.9 + 0.2 * h(20 + j));
        const bx = u * tex.width * sc * 0.78 + (h(30 + j) - 0.5) * tex.width * sc * 0.12;
        const by = -Math.max(0, centre) * tex.height * sc * 0.16 + (h(40 + j) - 0.5) * tex.height * sc * 0.08;
        // cloud morphing amplitudes: a few % of the billow, periods of 35 - 80 s
        puffs.push({
          s, bx, by, bs,
          ax: tex.width * sc * (0.05 + 0.04 * h(50 + j)),
          ay: tex.height * sc * (0.025 + 0.02 * h(60 + j)),
          as: 0.035 + 0.025 * h(70 + j),
          px: 35 + 45 * h(80 + j),
          py: 28 + 40 * h(90 + j),
          ps: 40 + 40 * h(100 + j),
          ph: h(110 + j) * Math.PI * 2,
        });
        // the largest (centre) billow draws last, in front of its neighbours
        s.zIndex = bs;
        c.addChild(s);
      }
      c.sortableChildren = true;
      this.root.addChild(c);
      this.clouds.push({
        c,
        x0: (i + 0.15 + 0.7 * h(3)) / n,
        y0: cfg.band[0] + (cfg.band[1] - cfg.band[0]) * h(4),
        speedK: 0.8 + 0.4 * h(5),
        bobA: 6 + 10 * h(6),
        bobP: 40 + 50 * h(7),
        ph: h(8) * Math.PI * 2,
        puffs,
        alpha: cfg.alpha * (0.82 + 0.18 * h(9)),
      });
    }
  }

  /** Recompute the wrap window for a viewport (wide enough for the farthest zoom-out and any pan). */
  layout(v: DepthView) {
    const zMin = v.fitZoom * Math.pow(Math.max(0.5, v.minRel), this.cfg.depth);
    const visW = v.W / zMin;
    this.span = Math.max(this.cfg.spanMin ?? 0, visW * 1.7 + 1600);
  }

  update(t: number, v: DepthView) {
    const d = applyDepth(this.root, v, this.cfg.depth);
    const span = this.span;
    const drift = Wind.distance(t) * this.cfg.speed;
    const lift = Wind.lift(t) * 14;
    for (const cl of this.clouds) {
      const xw = this.home.x - span / 2 + cl.x0 * span + drift * cl.speedK;
      // wrap relative to the layer camera: the seam is always far outside the view
      const dx = wrapWindow(xw - d.camX, span);
      const edge = windowFade(dx, span);
      cl.c.position.set(d.camX + dx, this.home.y + cl.y0 + lift + Math.sin((t / cl.bobP) * Math.PI * 2 + cl.ph) * cl.bobA);
      cl.c.alpha = cl.alpha * edge;
      cl.c.visible = cl.c.alpha > 0.004;
      if (!cl.c.visible) continue;
      for (const p of cl.puffs) {
        const w = (t / p.px) * Math.PI * 2 + p.ph;
        p.s.position.set(p.bx + Math.sin(w) * p.ax, p.by + Math.sin((t / p.py) * Math.PI * 2 + p.ph * 1.3) * p.ay);
        const k = p.bs * (1 + Math.sin((t / p.ps) * Math.PI * 2 + p.ph * 0.7) * p.as);
        p.s.scale.set(k * (1 + 0.02 * Math.sin(w * 0.5)), k);
      }
    }
    return d;
  }

  setTint(tint: number) {
    for (const cl of this.clouds) for (const p of cl.puffs) p.s.tint = tint;
  }

  /** QA: screen-space positions of every cloud (to prove independent drift / no teleport) */
  debugClouds() {
    return this.clouds.map((cl) => {
      const g = cl.c.getGlobalPosition();
      return { x: Math.round(g.x), y: Math.round(g.y), alpha: Math.round(cl.c.alpha * 100) / 100 };
    });
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}
