import { FULLSCREEN_VS, NOISE_GLSL, makeProgram, bindTexture, darkEase } from '../gl';
import type { WorldEnv, WorldInstance } from '../types';

/**
 * The character engine behind the ASCII worlds. Characters are the actual artistic medium: every scene computes, per
 * grid cell, WHICH glyph and WHAT colour, on the CPU at a calm fixed rate; one data texture goes to the GPU, and a
 * single fragment shader stamps the glyphs from an atlas. No DOM nodes, one draw call, cost independent of the
 * number of lit characters. A blurred read of the same texture gives luminous glyphs a soft halo.
 */

export interface AsciiStyle {
  /** Cell size in CSS pixels. */
  cell: [number, number];
  /** Every character the scene may use. Index 0 of the atlas stays empty, so index = position in this string + 1. */
  chars: string;
  /** GLSL body of `vec3 background(vec2 uv)` (may use uTime, uMouse, uDark, uStrength, uEnergy and the noise helpers). */
  background: string;
  /** Opacity of a tile: cells written with `glyph | TILE` are small tiles with the glyph knocked out of them. */
  tile?: number;
  /** Strength of the luminous halo. */
  glow?: number;
  /** Font weight of the atlas. */
  weight?: number;
  /** Glyph colour inside a tile (multiplies the tile colour). */
  tileInk?: number;
}

export interface AsciiCanvas {
  cols: number;
  rows: number;
  /** cell width / height: multiply x distances by this to measure in cell heights. */
  aspect: number;
  /** Clears glyph, colour. */
  clear(): void;
  /** Writes one cell (glyph index from `index()`; 0 = empty). Out-of-range is ignored. */
  put(x: number, y: number, glyph: number, r: number, g: number, b: number): void;
  /** Writes text on a row, each letter one cell, with optional per-letter brightness jitter off. */
  text(x: number, y: number, s: string, r: number, g: number, b: number): void;
  /** Glyph index for a character of the scene's charset (0 when unknown). */
  index(char: string): number;
  /** Glyph indices of a string, in order: handy as a density ramp. */
  ramp(chars: string): Uint8Array;
  glyphAt(x: number, y: number): number;
  /** Pointer in cell coordinates (y down). */
  pointer(): { x: number; y: number; px: number; py: number; vx: number; vy: number; energy: number; strength: number };
  dark(): boolean;
  env: WorldEnv;
}

export interface AsciiScene {
  /** Advance the simulation (fixed step). */
  step(dt: number, t: number): void;
  /** Fill the grid for this frame. */
  draw(t: number): void;
  /** A press of the pointer (cell coordinates). */
  pulse?(x: number, y: number): void;
  /** The grid changed size: rebuild whatever depends on cols / rows. */
  resize?(): void;
}

/** OR this into a glyph index: the cell is drawn as a small coloured tile with the letter knocked out. */
export const TILE = 128;

const FONT = 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const STEP = 1 / 30;

export function asciiWorld(env: WorldEnv, style: AsciiStyle, build: (canvas: AsciiCanvas) => AsciiScene): WorldInstance {
  const gl = env.gl;
  const chars = Array.from(style.chars);
  const atlasCols = Math.ceil(Math.sqrt(chars.length + 1));
  const atlasRows = Math.ceil((chars.length + 1) / atlasCols);
  const lookup = new Map<string, number>();
  chars.forEach((c, i) => {
    if (!lookup.has(c)) lookup.set(c, i + 1);
  });

  const narrow = env.cssWidth < 640;
  const cellW = style.cell[0] * (narrow ? 1.18 : 1);
  const cellH = style.cell[1] * (narrow ? 1.18 : 1);

  const fragment = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uData;
uniform sampler2D uAtlas;
uniform vec2 uGrid;
uniform vec2 uAtlasGrid;
uniform float uTile;
uniform float uTileInk;
uniform float uGlow;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uEnergy;
uniform float uStrength;
uniform float uDark;
${NOISE_GLSL}
vec3 background(vec2 uv) {
${style.background}
}
void main() {
  vec2 uv = vUv;
  vec3 col = background(uv);
  vec2 g = vec2(uv.x, 1.0 - uv.y) * uGrid;
  ivec2 c = ivec2(floor(g));
  vec2 f = fract(g);
  vec4 d = texelFetch(uData, c, 0);
  int raw = int(d.a * 255.0 + 0.5);
  bool tiled = raw >= 128;
  int gi = raw % 128;
  if (uGlow > 0.0) {
    vec2 tuv = vec2(uv.x, 1.0 - uv.y) * uGrid / vec2(textureSize(uData, 0));
    vec3 halo = textureLod(uData, tuv, 1.6).rgb * 0.6 + textureLod(uData, tuv, 3.2).rgb * 0.9;
    col += halo * uGlow;
  }
  if (gi > 0) {
    int ac = int(uAtlasGrid.x);
    vec2 at = (vec2(float(gi % ac), float(gi / ac)) + f) / uAtlasGrid;
    float a = texture(uAtlas, at).r;
    if (tiled) {
      vec2 q = abs(f - 0.5) - vec2(0.42, 0.44);
      float box = 1.0 - smoothstep(-0.02, 0.05, length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.05);
      vec3 tile = mix(col, d.rgb, box * uTile);
      vec3 ink = mix(d.rgb, d.rgb * uTileInk, uTile);
      col = mix(tile, ink, a);
    } else {
      col = mix(col, d.rgb, a);
    }
  }
  outColor = vec4(col, 1.0);
}`;
  const program = makeProgram(gl, FULLSCREEN_VS, fragment);
  const vao = gl.createVertexArray();

  // ─── Atlas: every glyph is drawn once, at the device's real cell size, so it stays crisp ───────────────────
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const glyphW = Math.max(4, Math.round(cellW * ratio));
  const glyphH = Math.max(6, Math.round(cellH * ratio));
  const atlas = document.createElement('canvas');
  atlas.width = glyphW * atlasCols;
  atlas.height = glyphH * atlasRows;
  const ctx = atlas.getContext('2d', { willReadFrequently: false }) as CanvasRenderingContext2D;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, atlas.width, atlas.height);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${style.weight ?? 500} ${Math.round(glyphH * 0.86)}px ${FONT}`;
  chars.forEach((c, i) => {
    const index = i + 1;
    ctx.fillText(c, (index % atlasCols + 0.5) * glyphW, (Math.floor(index / atlasCols) + 0.54) * glyphH);
  });
  const atlasTex = gl.createTexture() as WebGLTexture;
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, atlas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // ─── Grid ──────────────────────────────────────────────────────────────────────────────────────────────────
  let cols = 1;
  let rows = 1;
  let data = new Uint8Array(4);
  const dataTex = gl.createTexture() as WebGLTexture;
  const sizeGrid = () => {
    cols = Math.max(8, Math.ceil(env.cssWidth / cellW));
    rows = Math.max(6, Math.ceil(env.cssHeight / cellH));
    data = new Uint8Array(cols * rows * 4);
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const levels = Math.floor(Math.log2(Math.max(cols, rows))) + 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, cols, rows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  let tex = dataTex;
  sizeGrid();

  const surface: AsciiCanvas = {
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    aspect: cellW / cellH,
    clear() {
      data.fill(0);
    },
    put(x, y, glyph, r, g, b) {
      const ix = x | 0;
      const iy = y | 0;
      if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) return;
      const i = (ix + iy * cols) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = glyph;
    },
    text(x, y, s, r, g, b) {
      let cx = x | 0;
      for (const c of s) {
        const glyph = lookup.get(c) ?? 0;
        if (glyph) surface.put(cx, y, glyph, r, g, b);
        cx += 1;
      }
    },
    index(c) {
      return lookup.get(c) ?? 0;
    },
    ramp(s) {
      return Uint8Array.from(Array.from(s), (c) => lookup.get(c) ?? 0);
    },
    glyphAt(x, y) {
      const ix = x | 0;
      const iy = y | 0;
      if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) return 0;
      return data[(ix + iy * cols) * 4 + 3];
    },
    pointer() {
      const p = env.pointer;
      return {
        x: p.su * cols,
        y: (1 - p.sv) * rows,
        px: p.u * cols,
        py: (1 - p.v) * rows,
        // cells per second
        vx: p.vx * rows * (cellH / cellW),
        vy: -p.vy * rows,
        energy: p.energy,
        strength: p.strength,
      };
    },
    dark() {
      return env.params.dark;
    },
    env,
  } as AsciiCanvas;

  const scene = build(surface);

  let carry = 0;
  let dark = env.params.dark ? 1 : 0;
  let needsUpload = true;

  const simulate = (dt: number, t: number) => {
    for (const pulse of env.pointer.drainPulses()) scene.pulse?.(pulse.u * cols, (1 - pulse.v) * rows);
    carry += dt;
    let steps = 0;
    while (carry >= STEP && steps < 3) {
      scene.step(STEP, t);
      carry -= STEP;
      steps += 1;
      needsUpload = true;
    }
    if (steps === 3) carry = 0;
  };

  return {
    fps: 30,
    crisp: true,
    warm(seconds) {
      // Opens already alive, within a budget: the page's first paint matters more than a few more seconds of history.
      const started = performance.now();
      const count = Math.round(seconds / STEP);
      for (let i = 0; i < count && performance.now() - started < 120; i++) scene.step(STEP, i * STEP);
      needsUpload = true;
    },
    frame(t, dt) {
      simulate(dt, t);
      if (dt === 0) needsUpload = true;
      dark = darkEase(dark, env.params.dark, dt);
      if (needsUpload) {
        surface.clear();
        scene.draw(t);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.generateMipmap(gl.TEXTURE_2D);
        needsUpload = false;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
      gl.disable(gl.BLEND);
      gl.useProgram(program.prog);
      bindTexture(gl, 0, tex, program.u('uData'));
      bindTexture(gl, 1, atlasTex, program.u('uAtlas'));
      gl.uniform2f(program.u('uGrid'), env.cssWidth / cellW, env.cssHeight / cellH);
      gl.uniform2f(program.u('uAtlasGrid'), atlasCols, atlasRows);
      gl.uniform1f(program.u('uTile'), style.tile ?? 1);
      gl.uniform1f(program.u('uTileInk'), style.tileInk ?? 0.55);
      gl.uniform1f(program.u('uGlow'), style.glow ?? 0);
      gl.uniform2f(program.u('uRes'), env.width, env.height);
      gl.uniform1f(program.u('uTime'), t);
      gl.uniform2f(program.u('uMouse'), env.pointer.su, env.pointer.sv);
      gl.uniform1f(program.u('uEnergy'), env.pointer.energy);
      gl.uniform1f(program.u('uStrength'), env.pointer.strength);
      gl.uniform1f(program.u('uDark'), dark);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    resize() {
      const nextCols = Math.max(8, Math.ceil(env.cssWidth / cellW));
      const nextRows = Math.max(6, Math.ceil(env.cssHeight / cellH));
      if (nextCols === cols && nextRows === rows) return;
      // An immutable-storage texture cannot change size: a fresh one is made for the new grid.
      gl.deleteTexture(tex);
      tex = gl.createTexture() as WebGLTexture;
      cols = nextCols;
      rows = nextRows;
      data = new Uint8Array(cols * rows * 4);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const levels = Math.floor(Math.log2(Math.max(cols, rows))) + 1;
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, cols, rows);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      scene.resize?.();
      needsUpload = true;
    },
    dispose() {
      gl.deleteTexture(tex);
      gl.deleteTexture(atlasTex);
      gl.deleteProgram(program.prog);
      gl.deleteVertexArray(vao);
      atlas.width = 1;
      atlas.height = 1;
    },
  };
}

// ─── Fields every character scene shares ─────────────────────────────────────────────────────────────────────

export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Stable pseudo-random per integer. */
export const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
export const hash2 = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Fast value noise from a lookup table (the character worlds evaluate it for thousands of cells per step). */
const TABLE = new Float32Array(512);
for (let i = 0; i < 512; i++) TABLE[i] = hash(i * 0.731);
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const at = (a: number, b: number) => TABLE[(a + b * 57) & 511];
  const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * u;
  const bottom = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * u;
  return top + (bottom - top) * v;
}
export function fbm(x: number, y: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x, y);
    norm += amp;
    x = x * 2.03 + 11.7;
    y = y * 2.03 + 4.3;
    amp *= 0.5;
  }
  return sum / norm;
}

/** A real 2-D wave equation on the grid: ripples travel, reflect and fade by themselves. */
export class WaveField {
  w: number;
  h: number;
  a: Float32Array;
  b: Float32Array;
  constructor(
    w: number,
    h: number,
    private damping = 0.985,
  ) {
    this.w = w;
    this.h = h;
    this.a = new Float32Array(w * h);
    this.b = new Float32Array(w * h);
  }
  step() {
    const { w, h, a, b, damping } = this;
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        b[i] = ((a[i - 1] + a[i + 1] + a[i - w] + a[i + w]) * 0.5 - b[i]) * damping;
      }
    }
    this.a = b;
    this.b = a;
  }
  splash(cx: number, cy: number, radius: number, amount: number, aspect: number) {
    const { w, h, a } = this;
    const rx = Math.ceil(radius / Math.max(aspect, 0.2));
    const ry = Math.ceil(radius);
    for (let y = Math.max(1, (cy | 0) - ry); y < Math.min(h - 1, (cy | 0) + ry + 1); y++) {
      for (let x = Math.max(1, (cx | 0) - rx); x < Math.min(w - 1, (cx | 0) + rx + 1); x++) {
        const dx = (x - cx) * aspect;
        const dy = y - cy;
        const d = dx * dx + dy * dy;
        if (d < radius * radius) a[x + y * w] += amount * (1 - d / (radius * radius));
      }
    }
  }
  at(x: number, y: number) {
    const ix = x | 0;
    const iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return 0;
    return this.a[ix + iy * this.w];
  }
}

/**
 * A coarse elastic sheet: pushes displace it and springs bring it back, with a little overshoot. Scenes sample their
 * shapes at (x − dx, y − dy), so anything drawn through it is really blown aside and really reassembles.
 */
export class Sheet {
  cw: number;
  ch: number;
  ox: Float32Array;
  oy: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  constructor(
    public cols: number,
    public rows: number,
    private cell = 4,
    private spring = 7,
    private damp = 3.1,
  ) {
    this.cw = Math.ceil(cols / cell) + 2;
    this.ch = Math.ceil(rows / cell) + 2;
    const n = this.cw * this.ch;
    this.ox = new Float32Array(n);
    this.oy = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
  }
  push(x: number, y: number, fx: number, fy: number, radius: number, aspect: number) {
    const { cw, ch, cell, vx, vy } = this;
    const r = radius / cell;
    const gx = x / cell;
    const gy = y / cell;
    const rx = r / Math.max(aspect, 0.2);
    for (let j = Math.max(0, Math.floor(gy - r)); j <= Math.min(ch - 1, Math.ceil(gy + r)); j++) {
      for (let i = Math.max(0, Math.floor(gx - rx)); i <= Math.min(cw - 1, Math.ceil(gx + rx)); i++) {
        const dx = (i - gx) * aspect;
        const dy = j - gy;
        const d = (dx * dx + dy * dy) / (r * r);
        if (d >= 1) continue;
        const k = (1 - d) * (1 - d);
        const n = i + j * cw;
        vx[n] += fx * k;
        vy[n] += fy * k;
      }
    }
  }
  /** A radial push (a burst) around a point. */
  burst(x: number, y: number, force: number, radius: number, aspect: number) {
    const { cw, ch, cell, vx, vy } = this;
    const r = radius / cell;
    const gx = x / cell;
    const gy = y / cell;
    const rx = r / Math.max(aspect, 0.2);
    for (let j = Math.max(0, Math.floor(gy - r)); j <= Math.min(ch - 1, Math.ceil(gy + r)); j++) {
      for (let i = Math.max(0, Math.floor(gx - rx)); i <= Math.min(cw - 1, Math.ceil(gx + rx)); i++) {
        const dx = (i - gx) * aspect;
        const dy = j - gy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= r || dist < 0.001) continue;
        const k = (1 - dist / r) * force;
        const n = i + j * cw;
        vx[n] += ((dx / dist) * k) / Math.max(aspect, 0.2);
        vy[n] += (dy / dist) * k;
      }
    }
  }
  step(dt: number) {
    const { ox, oy, vx, vy, spring, damp } = this;
    for (let n = 0; n < ox.length; n++) {
      vx[n] += (-spring * ox[n] - damp * vx[n]) * dt;
      vy[n] += (-spring * oy[n] - damp * vy[n]) * dt;
      ox[n] += vx[n] * dt;
      oy[n] += vy[n] * dt;
    }
  }
  /** Bilinear read: writes the displacement into `out`. */
  sample(x: number, y: number, out: { x: number; y: number }) {
    const { cw, ch, cell, ox, oy } = this;
    const gx = clamp(x / cell, 0, cw - 1.001);
    const gy = clamp(y / cell, 0, ch - 1.001);
    const i = gx | 0;
    const j = gy | 0;
    const fx = gx - i;
    const fy = gy - j;
    const a = i + j * cw;
    const b = a + 1;
    const c = a + cw;
    const d = c + 1;
    out.x = (ox[a] * (1 - fx) + ox[b] * fx) * (1 - fy) + (ox[c] * (1 - fx) + ox[d] * fx) * fy;
    out.y = (oy[a] * (1 - fx) + oy[b] * fx) * (1 - fy) + (oy[c] * (1 - fx) + oy[d] * fx) * fy;
  }
}
