import {
  Container,
  Filter,
  GlProgram,
  Rectangle,
  RenderTexture,
  Sprite,
  Texture,
  UniformGroup,
  type Renderer,
} from "pixi.js";
import { celestial, hazeCentre, mixByTime, skyDomeAlphas, type Look, type TimeOfDay, type Weights } from "./lightRig";

/* ------------------------------------------------------------------------------------------------
 * Canvas-generated textures (no download)
 * ---------------------------------------------------------------------------------------------- */

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Texture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (ctx) draw(ctx);
  return Texture.from(c);
}

const SKY_STOPS: Record<TimeOfDay, string[]> = {
  day: ["#3a7fd4", "#5c9fe3", "#8fc3ee", "#c6e2f2", "#e6f1ee"],
  sunset: ["#2a326f", "#584a8f", "#a8668f", "#e58a74", "#ffc894"],
  night: ["#040a1d", "#0b1634", "#162755", "#25386c", "#33467a"],
};

function radial(size: number, stops: Array<[number, number]>) {
  return canvasTexture(size, size, (ctx) => {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach(([o, a]) => g.addColorStop(o, `rgba(255,255,255,${a})`));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  });
}

type RGBA = [number, number, number, number];

/**
 * Smooth coloured radial falloff painted per pixel (no gradient stops, so no visible rings) with a
 * ±½-step dither: large, faint sun glows magnified on screen never show 8-bit banding.
 * `at(r)` returns straight (non-premultiplied) RGBA for the normalised radius r ∈ [0, 1].
 */
function radialPaint(size: number, at: (r: number) => RGBA) {
  return canvasTexture(size, size, (ctx) => {
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.min(1, Math.hypot(x - c, y - c) / (size / 2));
        const [cr, cg, cb, a] = at(r);
        const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        const n = h - Math.floor(h) - 0.5;
        const i = (y * size + x) * 4;
        d[i] = cr;
        d[i + 1] = cg;
        d[i + 2] = cb;
        d[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255 + n)));
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

/**
 * Falloff of a local light (light-map pools, lamp halos), baked once and shared: a windowed inverse-square profile
 * `(1 - r²)² / (1 + 2r²)`. It has no plateau and no kink, and reaches zero with zero slope at the rim — the former
 * two-stop linear gradient read as a lit disc with an edge once it was magnified over the ground. Dithered below one
 * 8-bit step (see {@link radialPaint}) so a wide, dim pool never bands.
 */
export function lightFalloffTexture(size = 128): Texture {
  return radialPaint(size, (r) => {
    const q = 1 - r * r;
    return [255, 255, 255, (q * q) / (1 + 2 * r * r)];
  });
}

const smooth01 = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** ivory core -> cream -> pale gold, as straight RGB (the sun's own colour; tinted warmer at sunset) */
const sunColour = (r: number): [number, number, number] => {
  const k = smooth01(0, 1, r);
  return [255, Math.round(252 - 18 * k), Math.round(244 - 58 * k)];
};

/**
 * Screen-space sky: three gradient domes (crossfaded by weight), the sun (soft ivory disc + warm bloom +
 * broad atmospheric scattering, all alpha-composited — additive white over a saturated blue sky clips
 * green and blue first and reads as a cyan ring), a warm horizon band at sunset, the moon (soft maria)
 * with its halo, and twinkling stars. Placement follows `celestial()` so the sun really travels down the sky.
 */
export class SkyDome {
  readonly root = new Container();
  readonly textures: Texture[] = [];
  private readonly domes: Record<TimeOfDay, Sprite>;
  private readonly sunGlow: Sprite;
  private readonly sunHalo: Sprite;
  private readonly sunDisc: Sprite;
  /** sunset only: additive warm scattering (safe over a warm sky: red clips first) + an additive core that
   *  keeps the disc the brightest point inside it (no dark "eclipse" ring) */
  private readonly sunWarm: Sprite;
  private readonly sunCore: Sprite;
  private readonly horizon: Sprite;
  private readonly moonGlow: Sprite;
  private readonly moonDisc: Sprite;
  private readonly stars = new Container();
  private readonly starList: Array<{ s: Sprite; fx: number; fy: number; seed: number }> = [];
  private W = 1;
  private H = 1;
  /** current sun / moon screen position (px), read by the grade filter */
  sunPx = { x: 0, y: 0 };

  constructor(soft: Texture) {
    this.root.eventMode = "none";
    const dome = (k: TimeOfDay) => {
      const t = canvasTexture(4, 512, (ctx) => {
        const g = ctx.createLinearGradient(0, 0, 0, 512);
        SKY_STOPS[k].forEach((s, i, a) => g.addColorStop(i / (a.length - 1), s));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 4, 512);
      });
      this.textures.push(t);
      const s = new Sprite(t);
      this.root.addChild(s);
      return s;
    };
    this.domes = { day: dome("day"), sunset: dome("sunset"), night: dome("night") };
    // stars
    for (let i = 0; i < 110; i++) {
      const s = new Sprite(soft);
      s.anchor.set(0.5);
      const h = (k: number) => {
        const v = Math.sin((i + 1) * 91.7 + k * 13.3) * 43758.5453;
        return v - Math.floor(v);
      };
      s.scale.set(h(1) > 0.88 ? 0.11 : 0.055);
      s.tint = h(2) > 0.3 ? 0xffffff : 0xfff2c4;
      this.stars.addChild(s);
      this.starList.push({ s, fx: h(3), fy: h(4) * 0.72, seed: h(5) * 10 });
    }
    this.root.addChild(this.stars);
    // the moon keeps its additive halo (night look unchanged); the sun uses its own warm, normal-blended set
    const glowTex = radial(256, [[0, 1], [0.18, 0.55], [0.45, 0.16], [1, 0]]);
    const tail = (r: number) => 1 - smooth01(0.72, 1, r);
    // readable ivory disc with a soft limb (no hard coin edge)
    const discTex = radialPaint(128, (r) => [...sunColour(r * 0.5), 1 - 0.7 * smooth01(0.3, 0.62, r) - 0.3 * smooth01(0.62, 1, r)]);
    // warm bloom hugging the disc: pale yellow, falling smoothly into the sky colour
    const haloTex = radialPaint(256, (r) => {
      const [cr, cg, cb] = sunColour(0.45 + 0.55 * r);
      return [cr, cg, cb, (0.72 * Math.exp(-((r / 0.16) ** 2)) + 0.3 * Math.exp(-((r / 0.42) ** 2))) * tail(r)];
    });
    // broad scattering through the atmosphere (screen-composited: it lifts the sky toward warm light and
    // can never clip into a coloured ring)
    const sunGlowTex = radialPaint(256, (r) => [255, 238, 208, Math.pow(1 - r, 3.1)]);
    const moonTex = canvasTexture(128, 128, (ctx) => {
      const g = ctx.createRadialGradient(56, 54, 4, 64, 64, 62);
      g.addColorStop(0, "rgba(250,251,255,1)");
      g.addColorStop(0.72, "rgba(226,232,248,1)");
      g.addColorStop(0.84, "rgba(214,222,242,0.9)");
      g.addColorStop(0.95, "rgba(200,210,236,0.25)");
      g.addColorStop(1, "rgba(200,210,236,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      // soft maria
      ctx.fillStyle = "rgba(150,162,196,0.28)";
      [[50, 48, 13], [74, 60, 10], [60, 78, 9], [80, 42, 6]].forEach(([x, y, r]) => {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      });
    });
    const bandTex = canvasTexture(4, 256, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.55, "rgba(255,255,255,0.55)");
      g.addColorStop(0.78, "rgba(255,255,255,0.85)");
      g.addColorStop(1, "rgba(255,255,255,0.2)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 4, 256);
    });
    this.textures.push(glowTex, haloTex, discTex, sunGlowTex, moonTex, bandTex);
    const mk = (t: Texture, blend: "add" | "normal" | "screen" = "add") => {
      const s = new Sprite(t);
      s.anchor.set(0.5);
      s.blendMode = blend;
      this.root.addChild(s);
      return s;
    };
    this.horizon = new Sprite(bandTex);
    this.horizon.blendMode = "add";
    this.root.addChild(this.horizon);
    this.sunGlow = mk(sunGlowTex, "screen");
    this.sunWarm = mk(sunGlowTex, "add");
    this.moonGlow = mk(glowTex);
    this.sunHalo = mk(haloTex, "normal");
    this.sunDisc = mk(discTex, "normal");
    this.sunCore = mk(discTex, "add");
    this.moonDisc = mk(moonTex, "normal");
  }

  layout(W: number, H: number) {
    this.W = W;
    this.H = H;
    (Object.values(this.domes) as Sprite[]).forEach((s) => {
      s.width = W;
      s.height = H;
    });
    this.starList.forEach((st) => st.s.position.set(st.fx * W, st.fy * H));
    this.horizon.position.set(0, H * 0.38);
    this.horizon.width = W;
    this.horizon.height = H * 0.62;
  }

  update(w: Weights, look: Look, t: number) {
    const { W, H } = this;
    // painter's order day < sunset < night: alphas that reproduce the weighted blend for ANY weights (lightRig)
    const domes = skyDomeAlphas(w);
    this.domes.day.alpha = 1;
    this.domes.sunset.alpha = domes.sunset;
    this.domes.night.alpha = domes.night;
    const c = celestial(w);
    const m = Math.max(W, H);
    // a distant sun: a modest ivory disc (≈ 4 % of the short side) whose light is carried by the bloom
    const sd = Math.max(22, Math.min(W, H) * 0.042);
    this.sunPx = { x: c.sun.x * W, y: c.sun.y * H };
    const warm = c.warm;
    const grow = 1 + 0.3 * warm; // a low sun looks larger
    this.sunDisc.position.set(this.sunPx.x, this.sunPx.y);
    this.sunDisc.scale.set((sd * 1.5 * grow) / 128);
    // the disc stays the brightest point of the sky (a low sun is pale gold, not a flat orange coin)
    this.sunDisc.tint = mix(0xffffff, 0xfff0d2, warm);
    this.sunDisc.alpha = c.sun.alpha;
    this.sunHalo.position.copyFrom(this.sunDisc.position);
    this.sunHalo.scale.set((sd * (6.6 + 3.4 * warm)) / 256);
    this.sunHalo.tint = mix(0xffffff, 0xffbd72, warm);
    this.sunHalo.alpha = c.sun.alpha;
    this.sunGlow.position.copyFrom(this.sunDisc.position);
    this.sunGlow.scale.set((m * (1.05 + 0.6 * warm)) / 256);
    this.sunGlow.tint = mix(0xfff6e6, 0xff9a5a, warm);
    this.sunGlow.alpha = c.sun.alpha * look.sunGlow * 0.5 * (1 - 0.45 * warm);
    this.sunWarm.position.copyFrom(this.sunDisc.position);
    this.sunWarm.scale.set((m * 1.55) / 256);
    this.sunWarm.tint = 0xff8f52;
    this.sunWarm.alpha = c.sun.alpha * warm * 0.42;
    this.sunCore.position.copyFrom(this.sunDisc.position);
    this.sunCore.scale.copyFrom(this.sunDisc.scale);
    this.sunCore.tint = 0xfff2d8;
    this.sunCore.alpha = c.sun.alpha * warm * 0.55;
    // one colour for every mix of the three times (it used to switch palette when the night weight passed one half)
    this.horizon.tint = mixByTime(0xdfeeff, 0xff9d62, 0x3c4f8c, w);
    this.horizon.alpha = look.horizon * 0.55;
    // the moon keeps its own size (night look unchanged by the sun's redesign)
    const md = Math.max(26, Math.min(W, H) * 0.052) * 1.05;
    // the grade's scattering veil follows the sun by day and the moon at night, travelling between them
    const veil = hazeCentre(w);
    this.sunPx = { x: veil.x * W, y: veil.y * H };
    this.moonDisc.position.set(c.moon.x * W, c.moon.y * H);
    this.moonDisc.scale.set(md / 128);
    this.moonDisc.alpha = c.moon.alpha * 0.95;
    this.moonGlow.position.copyFrom(this.moonDisc.position);
    this.moonGlow.scale.set((m * 0.55) / 256);
    this.moonGlow.tint = 0x9fb4ff;
    this.moonGlow.alpha = c.moon.alpha * 0.32;
    this.stars.alpha = look.stars;
    if (look.stars > 0.01) this.starList.forEach((st) => (st.s.alpha = 0.55 + 0.45 * Math.sin(t * 1.7 + st.seed)));
  }

  /** QA: what the three domes really show right now (their sprite alphas, top to bottom of the stack). */
  debugDomes() {
    return { sunset: this.domes.sunset.alpha, night: this.domes.night.alpha, stars: this.stars.alpha, horizon: this.horizon.tint };
  }

  destroy() {
    this.root.destroy({ children: true });
    this.textures.forEach((t) => t.destroy(true));
  }
}

function mix(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (Math.round(ar + (br - ar) * k) << 16) | (Math.round(ag + (bg - ag) * k) << 8) | Math.round(ab + (bb - ab) * k);
}

/* ------------------------------------------------------------------------------------------------
 * Scene grade (WebGL): split-tone light, sun-side scattering, local lights
 * ---------------------------------------------------------------------------------------------- */

const GRADE_VERTEX = `in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
vec2 filterTextureCoord(void) { return aPosition * (uOutputFrame.zw * uInputSize.zw); }
void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}`;

// The pre-rendered world carries a neutral daylight key. The grade re-lights it per time of day:
// luminance-split tint (warm gold highlights / violet shade at sunset, silver-blue moonlight at night),
// exposure and saturation, local light sources (albedo × light, so a lantern warms the ground and walls
// around it), and the sun's (or moon's) atmospheric scattering veil on the side of the sky it is in.
const GRADE_FRAGMENT = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uLightMap;
uniform highp vec4 uInputSize;
uniform float uExposure;
uniform float uSaturation;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform vec3 uHazeColor;
uniform float uHaze;
uniform highp vec2 uSun;
uniform highp float uHazeRadius;
uniform highp vec2 uScreen;
uniform float uLights;
void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  if (src.a < 0.002) { finalColor = vec4(0.0); return; }
  vec3 c = src.rgb / src.a;
  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(L), c, uSaturation);
  vec3 tone = mix(uShadowTint, uHighTint, smoothstep(0.06, 0.82, L));
  vec3 g = c * tone * uExposure;
  highp vec2 px = vTextureCoord * uInputSize.xy;
  vec3 lm = texture(uLightMap, clamp(px / uScreen, 0.0, 1.0)).rgb;
  // albedo x light through a soft shoulder: a plain gain (x1.7) pushed the middle of a pool past white, so the
  // ground under a lamp clipped into a flat bright disc with an edge. The dim outer pool keeps its strength (e ~ 2 lm).
  vec3 e = 1.0 - exp(-lm * uLights * 2.0);
  g += c * e * 1.3;
  float d = length(px - uSun) / max(1.0, uHazeRadius);
  float h = exp(-d * d) * uHaze;
  g = g * (1.0 - h * 0.3) + uHazeColor * h * 0.42;
  finalColor = vec4(g * src.a, src.a);
}`;

export class GradeFilter {
  readonly filter: Filter;
  private readonly u: UniformGroup;

  constructor(lightMap: Texture) {
    this.u = new UniformGroup({
      uExposure: { value: 1, type: "f32" },
      uSaturation: { value: 1, type: "f32" },
      uShadowTint: { value: new Float32Array([1, 1, 1]), type: "vec3<f32>" },
      uHighTint: { value: new Float32Array([1, 1, 1]), type: "vec3<f32>" },
      uHazeColor: { value: new Float32Array([1, 1, 1]), type: "vec3<f32>" },
      uHaze: { value: 0, type: "f32" },
      uSun: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
      uHazeRadius: { value: 600, type: "f32" },
      uScreen: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
      uLights: { value: 0, type: "f32" },
    });
    this.filter = new Filter({
      glProgram: GlProgram.from({ vertex: GRADE_VERTEX, fragment: GRADE_FRAGMENT, name: "echo-garden-grade" }),
      resources: { gradeUniforms: this.u, uLightMap: lightMap.source, uLightMapSampler: lightMap.source.style },
      antialias: "inherit",
      resolution: "inherit",
    });
  }

  apply(look: Look, sun: { x: number; y: number }, W: number, H: number) {
    const u = this.u.uniforms as Record<string, number | Float32Array>;
    u.uExposure = look.exposure;
    u.uSaturation = look.saturation;
    (u.uShadowTint as Float32Array).set(look.shadowTint);
    (u.uHighTint as Float32Array).set(look.highTint);
    (u.uHazeColor as Float32Array).set(look.hazeColor);
    u.uHaze = look.haze;
    (u.uSun as Float32Array).set([sun.x, sun.y]);
    u.uHazeRadius = Math.max(W, H) * look.hazeRadius;
    (u.uScreen as Float32Array).set([W, H]);
    u.uLights = look.lights;
  }

  /** the filter covers exactly the viewport (screen px == filter px) */
  static area(W: number, H: number) {
    return new Rectangle(0, 0, W, H);
  }

  destroy() {
    // unbind the light map before anything releases it (no dangling texture in the bind group)
    const r = this.filter.resources as Record<string, unknown>;
    r.uLightMap = Texture.EMPTY.source;
    r.uLightMapSampler = Texture.EMPTY.source.style;
    this.filter.destroy();
  }
}

/* ------------------------------------------------------------------------------------------------
 * Local light map: lanterns, windows and the heartwood hollow, rendered at 1/4 resolution
 * ---------------------------------------------------------------------------------------------- */

export interface LocalLight {
  /** world position (px, zoom 1) of the light's centre on the ground or object */
  x: number;
  y: number;
  /** radius (world px); the pool is flattened to the 2:1 ground plane unless `round` */
  r: number;
  color: number;
  intensity: number;
  round?: boolean;
  /** extra modulation (e.g. the Knowledge Tree's breathing light) */
  key?: string;
}

export class LightMap {
  readonly root = new Container();
  private rt: RenderTexture;
  private sprites: Array<{ s: Sprite; l: LocalLight }> = [];
  private readonly scale = 0.25;

  /** {@code falloff}: the shared {@link lightFalloffTexture} (owned and released by the caller). */
  constructor(private readonly renderer: Renderer, falloff: Texture, lights: LocalLight[]) {
    this.rt = RenderTexture.create({ width: 8, height: 8, resolution: 1 });
    lights.forEach((l) => {
      const s = new Sprite(falloff);
      s.anchor.set(0.5);
      s.position.set(l.x, l.y);
      s.scale.set((l.r * 2) / falloff.width, ((l.round ? 2 : 1) * l.r) / falloff.height);
      s.tint = l.color;
      s.blendMode = "add";
      s.alpha = l.intensity;
      this.root.addChild(s);
      this.sprites.push({ s, l });
    });
  }

  get texture(): Texture {
    return this.rt;
  }

  resize(W: number, H: number) {
    this.rt.resize(Math.max(8, Math.ceil(W * this.scale)), Math.max(8, Math.ceil(H * this.scale)));
  }

  /** per-light modulation by key (e.g. heartwood breathing) */
  setModulation(key: string, k: number) {
    this.sprites.forEach(({ s, l }) => {
      if (l.key === key) s.alpha = l.intensity * k;
    });
  }

  render(world: Container) {
    this.root.scale.set(world.scale.x * this.scale);
    this.root.position.set(world.position.x * this.scale, world.position.y * this.scale);
    this.renderer.render({ container: this.root, target: this.rt, clear: true, clearColor: [0, 0, 0, 0] });
  }

  destroy() {
    this.root.destroy({ children: true });
    this.rt.destroy(true);
  }
}
