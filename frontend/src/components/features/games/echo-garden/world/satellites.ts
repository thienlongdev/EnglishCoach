import { Container, Sprite, type Texture } from "pixi.js";
import { applyDepth, type DepthView } from "./atmosphere";
import { hash01, satelliteOffset } from "./environment";

/**
 * The two satellite islands (with the main island: exactly THREE floating islands).
 *
 * Each satellite owns an independent transform: its own container (never a child of the main island),
 * its own parallax depth, and a bounded, deterministic floating motion — a slow Lissajous drift with
 * incommensurate periods (smooth acceleration, no reversal jerk, no teleport, stays inside its bounds),
 * a gentle vertical bob and a very small tilt. All parameters come from `echoGardenLayout.json`
 * (`satellites`), so designers adjust positions without touching code. Nothing is persisted.
 */
export interface SatelliteConfig {
  id: string;
  /** runtime sprite key (manifest) */
  key: string;
  /** base position relative to the home framing centre (world px at zoom 1) */
  base: [number, number];
  /** parallax depth (main island = 1; < 1 = farther away, drawn behind the main island) */
  depth: number;
  scale: number;
  /** drift amplitude (px) and periods (s) of the bounded Lissajous path */
  drift: { x: number; y: number; periodX: number; periodY: number };
  bob: { amp: number; period: number };
  /** maximum tilt (degrees) and its period (s) */
  tilt: { deg: number; period: number };
  /** phase offset (radians) so the two islands never move in sync */
  phase: number;
}

export interface SatelliteRuntime {
  cfg: SatelliteConfig;
  root: Container;
  body: Container;
  /** the island art; `art` = the manifest key it shows (`<key>__<season>` in a non-summer season) */
  sprite: Sprite;
  art: string;
  wisps: Array<{ s: Sprite; r: number; a0: number; period: number; y: number; baseScale: number }>;
}

export class SatelliteController {
  readonly items: SatelliteRuntime[] = [];

  constructor(
    configs: SatelliteConfig[],
    textures: Record<string, Texture | null>,
    meta: Record<string, { ax: number; ay: number; w: number; h: number; scale: number } | undefined>,
    private readonly home: { x: number; y: number },
    billows: Texture[],
    arts: Record<string, string> = {},
  ) {
    configs.forEach((cfg, i) => {
      const tex = textures[cfg.key];
      const m = meta[cfg.key];
      if (!tex || !m) return;
      const root = new Container();
      root.label = `satellite-${cfg.id}`;
      root.eventMode = "none";
      const body = new Container();
      const s = new Sprite(tex);
      s.anchor.set(m.ax / m.w, m.ay / m.h);
      s.scale.set(m.scale * cfg.scale);
      body.addChild(s);
      // local wisps: one billow drifting behind the keel, one in front of it (bounded orbits)
      const wisps: SatelliteRuntime["wisps"] = [];
      [0, 1].forEach((j) => {
        if (!billows.length) return;
        const b = new Sprite(billows[(i * 2 + j + 1) % billows.length]);
        b.anchor.set(0.5, 0.8);
        b.alpha = j === 0 ? 0.72 : 0.6;
        const baseScale = (j === 0 ? 0.55 : 0.4) * cfg.scale;
        b.scale.set(baseScale);
        const w = { s: b, r: 70 + 50 * hash01(i * 3 + j), a0: hash01(i * 5 + j * 2) * Math.PI * 2,
          period: 70 + 40 * hash01(i * 7 + j), y: (j === 0 ? 120 : 175) * cfg.scale, baseScale };
        wisps.push(w);
        if (j === 0) body.addChildAt(b, 0);
        else body.addChild(b);
      });
      root.addChild(body);
      this.items.push({ cfg, root, body, wisps, sprite: s, art: arts[cfg.key] ?? cfg.key });
    });
  }

  update(t: number, v: DepthView) {
    for (const it of this.items) {
      applyDepth(it.root, v, it.cfg.depth);
      const m = satelliteOffset(it.cfg, t);
      it.body.position.set(this.home.x + m.x, this.home.y + m.y);
      it.body.rotation = m.rot;
      for (const w of it.wisps) {
        const a = w.a0 + (t / w.period) * Math.PI * 2;
        w.s.position.set(Math.cos(a) * w.r, w.y + Math.sin(a * 2) * 10);
        w.s.scale.set(w.baseScale * (1 + 0.04 * Math.sin(a * 1.3)), w.baseScale);
      }
    }
  }

  setTint(tint: number) {
    for (const it of this.items) {
      it.body.children.forEach((c) => ((c as Sprite).tint = tint));
    }
  }

  /** QA: layer-space and screen-space position of each satellite */
  debugState() {
    return this.items.map((it) => {
      const g = it.body.getGlobalPosition();
      return {
        id: it.cfg.id,
        depth: it.cfg.depth,
        world: { x: Math.round(it.body.x * 10) / 10, y: Math.round(it.body.y * 10) / 10 },
        screen: { x: Math.round(g.x * 10) / 10, y: Math.round(g.y * 10) / 10 },
        rotationDeg: Math.round(((it.body.rotation * 180) / Math.PI) * 100) / 100,
        parentLabel: it.root.parent?.label ?? null,
      };
    });
  }

  destroy() {
    this.items.forEach((it) => it.root.destroy({ children: true }));
  }
}
