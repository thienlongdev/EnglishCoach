import * as THREE from 'three';
import type { WorldEnv, WorldInstance } from '@/lib/wallpaper/worlds/types';
import { FULLSCREEN_VS, NOISE_GLSL, darkEase, floatTarget, freeTarget, makeProgram, makeSwap, makeTarget, type Program, type Swap, type Target } from '@/lib/wallpaper/worlds/gl';
import { PALETTES } from '../catalog';
import type { PaletteId, SpatialBridge } from '../types';

/**
 * What every Echo Spatial scene shares, so a scene is only its own idea:
 *  - the FIELD: a small texture of the real cards (R coverage with a soft falloff, G the hovered card, B lift), readable from any
 *    vertex or fragment shader. This is how a scene knows the DOM without a uniform array in every shader;
 *  - the SLABS: each card's thickness, contact shadow and rim, drawn in the scene's own light around the real HTML card;
 *  - the palette, eased between the light and the dark appearance;
 *  - one three.js renderer on the runtime's context, and a raw-shader equivalent.
 */

const hexRgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

const MAX_RECTS = 40;

const RECT_VS = /* glsl */ `#version 300 es
uniform vec4 uRects[${MAX_RECTS}];
uniform vec4 uMeta[${MAX_RECTS}];
uniform vec2 uCss;
uniform float uGrow;
out vec2 vP;
flat out vec4 vRect;
flat out vec4 vMeta;
void main() {
  vec2 corner = vec2(float((gl_VertexID >> 0) & 1), float((gl_VertexID >> 1) & 1));
  vec4 r = uRects[gl_InstanceID];
  vec2 p = r.xy - uGrow + corner * (r.zw + 2.0 * uGrow);
  vP = p;
  vRect = r;
  vMeta = uMeta[gl_InstanceID];
  gl_Position = vec4(p.x / uCss.x * 2.0 - 1.0, 1.0 - p.y / uCss.y * 2.0, 0.0, 1.0);
}`;

const SD_ROUND = /* glsl */ `
float sdRound(vec2 p, vec2 c, vec2 h, float r) {
  vec2 q = abs(p - c) - h + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}`;

const FIELD_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vP;
flat in vec4 vRect;
flat in vec4 vMeta;
uniform float uGrow;
out vec4 frag;
${SD_ROUND}
void main() {
  float d = sdRound(vP, vRect.xy + vRect.zw * 0.5, vRect.zw * 0.5, min(vMeta.x, min(vRect.z, vRect.w) * 0.5));
  float c = 1.0 - smoothstep(-2.0, uGrow, d);
  c = c * c * (3.0 - 2.0 * c);
  frag = vec4(c, c * vMeta.y, c * vMeta.z, 1.0);
}`;

const SLAB_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vP;
flat in vec4 vRect;
flat in vec4 vMeta;
uniform vec3 uRim;
uniform vec3 uSide;
uniform vec3 uShadow;
uniform float uStrength;
uniform float uDepth;
uniform vec2 uLight;
uniform float uDark;
out vec4 frag;
${SD_ROUND}
void main() {
  if (vMeta.w > 1.5) discard; // a component with its own motion: its box is not its shape, so it gets no slab
  vec2 c = vRect.xy + vRect.zw * 0.5, h = vRect.zw * 0.5;
  float r = min(vMeta.x, min(h.x, h.y));
  float lift = vMeta.z;
  float hover = vMeta.y;
  // the slab: the same rounded box pushed away from the light, so its far side shows beyond the HTML card
  vec2 away = normalize(c - uLight + vec2(0.001));
  float thick = (3.0 + 9.0 * uDepth) * (1.0 + 1.6 * lift);
  float dFace = sdRound(vP, c, h, r);
  float dSide = sdRound(vP, c + away * thick, h, r);
  float dShadow = sdRound(vP, c + away * thick * 2.6 + vec2(0.0, thick * 1.2), h, r);
  float inFace = step(dFace, 0.0);
  float shadow = (1.0 - smoothstep(-6.0, 22.0 + thick * 2.6, dShadow)) * (1.0 - inFace);
  float side = (1.0 - smoothstep(-0.6, 0.8, dSide)) * (1.0 - inFace);
  float rim = (1.0 - smoothstep(0.0, 1.6 + 2.4 * hover, abs(dFace)));
  float glow = (1.0 - smoothstep(0.0, 42.0, max(dFace, 0.0))) * (1.0 - inFace);
  vec3 col = uShadow;
  float a = shadow * mix(0.26, 0.5, uDark);
  float sideShade = 0.72 + 0.28 * dot(away, normalize(vec2(1.0, 1.0)));
  col = mix(col, uSide * sideShade, side);
  a = max(a, side * 0.9);
  col = mix(col, uRim, glow * (0.18 + 0.5 * hover));
  a = max(a, glow * (0.05 + 0.2 * hover));
  col = mix(col, uRim, rim);
  a = max(a, rim * (0.3 + 0.6 * hover));
  frag = vec4(col * a, a) * uStrength;
}`;

export interface SceneField {
  texture: WebGLTexture;
  update(): void;
  /** The cards' thickness, shadow and rim, over whatever the scene drew (default framebuffer). */
  drawSlabs(strength?: number): void;
  dispose(): void;
}

export interface Palette {
  c0: [number, number, number];
  c1: [number, number, number];
  c2: [number, number, number];
  c3: [number, number, number];
  dark: number;
  update(dt: number, dark: boolean): void;
}

export function makePalette(id: PaletteId, darkNow: boolean): Palette {
  const def = PALETTES[id] ?? PALETTES.ocean;
  const dark = def.dark.map(hexRgb);
  const light = def.light.map(hexRgb);
  const pal: Palette = {
    c0: [0, 0, 0],
    c1: [0, 0, 0],
    c2: [0, 0, 0],
    c3: [0, 0, 0],
    dark: darkNow ? 1 : 0,
    update(dt, nowDark) {
      pal.dark = darkEase(pal.dark, nowDark, dt);
      const m = pal.dark;
      for (let i = 0; i < 4; i++) {
        const target = [pal.c0, pal.c1, pal.c2, pal.c3][i];
        for (let k = 0; k < 3; k++) target[k] = light[i][k] + (dark[i][k] - light[i][k]) * m;
      }
    },
  };
  pal.update(0, darkNow);
  return pal;
}

export function makeField(env: WorldEnv, bridge: SpatialBridge, palette: Palette): SceneField {
  const gl = env.gl;
  const fieldW = 320;
  const fieldH = 180;
  const target: Target = makeTarget(gl, fieldW, fieldH);
  const fieldProgram = makeProgram(gl, RECT_VS, FIELD_FS);
  const slabProgram = makeProgram(gl, RECT_VS, SLAB_FS);
  const vao = gl.createVertexArray();
  const rects = new Float32Array(MAX_RECTS * 4);
  const meta = new Float32Array(MAX_RECTS * 4);

  const load = (p: Program, grow: number) => {
    const n = Math.min(bridge.count, MAX_RECTS);
    rects.set(bridge.rects.subarray(0, n * 4));
    meta.set(bridge.meta.subarray(0, n * 4));
    gl.uniform4fv(p.u('uRects'), rects);
    gl.uniform4fv(p.u('uMeta'), meta);
    gl.uniform2f(p.u('uCss'), env.cssWidth, env.cssHeight);
    gl.uniform1f(p.u('uGrow'), grow);
    return n;
  };

  return {
    texture: target.tex,
    update() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, fieldW, fieldH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(fieldProgram.prog);
      const n = load(fieldProgram, 90);
      gl.bindVertexArray(vao);
      if (n > 0) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
    },
    drawSlabs(strength = 1) {
      const n = Math.min(bridge.count, MAX_RECTS);
      if (n === 0 || strength <= 0) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(slabProgram.prog);
      load(slabProgram, 64);
      gl.uniform3f(slabProgram.u('uRim'), palette.c3[0], palette.c3[1], palette.c3[2]);
      const m = palette.dark;
      gl.uniform3f(slabProgram.u('uSide'), palette.c2[0] * (0.5 + 0.2 * (1 - m)), palette.c2[1] * (0.5 + 0.2 * (1 - m)), palette.c2[2] * (0.5 + 0.2 * (1 - m)));
      gl.uniform3f(slabProgram.u('uShadow'), palette.c0[0] * 0.25 * m + palette.c1[0] * 0.28 * (1 - m), palette.c0[1] * 0.25 * m + palette.c1[1] * 0.28 * (1 - m), palette.c0[2] * 0.25 * m + palette.c1[2] * 0.34 * (1 - m));
      gl.uniform1f(slabProgram.u('uStrength'), strength);
      gl.uniform1f(slabProgram.u('uDepth'), bridge.depth);
      gl.uniform1f(slabProgram.u('uDark'), m);
      gl.uniform2f(slabProgram.u('uLight'), env.pointer.su * env.cssWidth, (1 - env.pointer.sv) * env.cssHeight);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.disable(gl.BLEND);
    },
    dispose() {
      freeTarget(gl, target);
      gl.deleteProgram(fieldProgram.prog);
      gl.deleteProgram(slabProgram.prog);
      gl.deleteVertexArray(vao);
    },
  };
}

// ─── Wave field: a real discrete wave equation; the cards are walls, so waves reflect off them ─────────────
const WAVE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform sampler2D uField;
uniform vec2 uTexel;
uniform vec3 uDrop;
uniform vec3 uDrop2;
uniform float uDamp;
uniform float uAspect;
uniform float uWalls;
out vec4 frag;
void main() {
  vec4 s = texture(uPrev, vUv);
  float h = s.r, v = s.g;
  float n = texture(uPrev, vUv + vec2(0, uTexel.y)).r + texture(uPrev, vUv - vec2(0, uTexel.y)).r
          + texture(uPrev, vUv + vec2(uTexel.x, 0)).r + texture(uPrev, vUv - vec2(uTexel.x, 0)).r;
  v += (n * 0.25 - h) * 1.9;
  v *= uDamp;
  h += v;
  h *= 0.9975;
  vec2 d = (vUv - uDrop.xy) * vec2(uAspect, 1.0);
  h += uDrop.z * exp(-dot(d, d) * 2600.0);
  vec2 d2 = (vUv - uDrop2.xy) * vec2(uAspect, 1.0);
  h += uDrop2.z * exp(-dot(d2, d2) * 900.0);
  // a card is a wall: the surface under it is held still, so what arrives comes back
  float wall = smoothstep(0.82, 0.98, texture(uField, vec2(vUv.x, vUv.y)).r) * uWalls;
  h *= 1.0 - wall;
  v *= 1.0 - wall;
  frag = vec4(h, v, 0.0, 1.0);
}`;

export interface WaveField {
  texture(): WebGLTexture;
  step(dt: number, fieldTex: WebGLTexture): void;
  dispose(): void;
}

export function makeWave(env: WorldEnv, opts: { width?: number; damp?: number; walls?: number; force?: number } = {}): WaveField {
  const gl = env.gl;
  const format = floatTarget(gl);
  const w = opts.width ?? (env.tier === 'low' ? 128 : env.tier === 'balanced' ? 180 : 256);
  const h = Math.max(2, Math.round((w * env.cssHeight) / Math.max(1, env.cssWidth)));
  const swap: Swap = makeSwap(gl, w, h, format);
  const program = makeProgram(gl, FULLSCREEN_VS, WAVE_FS);
  const vao = gl.createVertexArray();
  let lastU = -1;
  let lastV = -1;
  let accumulator = 0;
  const force = opts.force ?? 1;
  return {
    texture: () => swap.read.tex,
    step(dt, fieldTex) {
      const p = env.pointer;
      gl.useProgram(program.prog);
      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.uniform2f(program.u('uTexel'), 1 / w, 1 / h);
      gl.uniform1f(program.u('uDamp'), opts.damp ?? 0.992);
      gl.uniform1f(program.u('uAspect'), env.cssWidth / Math.max(1, env.cssHeight));
      gl.uniform1f(program.u('uWalls'), opts.walls ?? 1);
      accumulator = Math.min(accumulator + dt * 60, 3);
      const pulses = p.drainPulses();
      while (accumulator >= 1 || pulses.length) {
        accumulator = Math.max(0, accumulator - 1);
        const moved = Math.hypot(p.u - lastU, p.v - lastV);
        const drop = lastU < 0 ? 0 : Math.min(moved * 4.5, 0.11) * p.strength * force;
        lastU = p.u;
        lastV = p.v;
        const pulse = pulses.shift();
        gl.bindFramebuffer(gl.FRAMEBUFFER, swap.write.fbo);
        gl.viewport(0, 0, w, h);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, swap.read.tex);
        gl.uniform1i(program.u('uPrev'), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, fieldTex);
        gl.uniform1i(program.u('uField'), 1);
        gl.uniform3f(program.u('uDrop'), p.u, p.v, drop);
        if (pulse) gl.uniform3f(program.u('uDrop2'), pulse.u, pulse.v, 0.55 * force);
        else gl.uniform3f(program.u('uDrop2'), 0, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        swap.swap();
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
    },
    dispose() {
      freeTarget(gl, swap.read);
      freeTarget(gl, swap.write);
      gl.deleteProgram(program.prog);
      gl.deleteVertexArray(vao);
    },
  };
}

// ─── A surface that really carries waves: a height field in the surface's OWN coordinates ──────────────────
const SURFACE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform vec4 uDrop;
uniform float uDamp;
uniform vec2 uScale;
uniform sampler2D uMask;
uniform float uHasMask;
out vec4 frag;
void main() {
  vec4 s = texture(uPrev, vUv);
  float h = s.r, v = s.g;
  float n = texture(uPrev, vUv + vec2(0, uTexel.y)).r + texture(uPrev, vUv - vec2(0, uTexel.y)).r + texture(uPrev, vUv + vec2(uTexel.x, 0)).r + texture(uPrev, vUv - vec2(uTexel.x, 0)).r;
  v += (n * 0.25 - h) * 1.86;
  v *= uDamp;
  h += v;
  h *= 0.9985;
  vec2 d = (vUv - uDrop.xy) * uScale;
  h += uDrop.z * exp(-dot(d, d) / max(uDrop.w * uDrop.w, 1e-5));
  if (uHasMask > 0.5) {
    float wall = texture(uMask, vUv).r;
    h *= 1.0 - wall;
    v *= 1.0 - wall;
  }
  // the edges of the texture do not reflect: they swallow what reaches them
  vec2 e = min(vUv, 1.0 - vUv);
  float absorb = smoothstep(0.0, 0.05, min(e.x, e.y));
  h *= mix(0.9, 1.0, absorb);
  v *= mix(0.9, 1.0, absorb);
  frag = vec4(h, v, 0.0, 1.0);
}`;

export interface SurfaceWaves {
  texture(): WebGLTexture;
  readonly texelX: number;
  readonly texelY: number;
  /** A touch at (u, v) of the surface. amount in height units, radius in the surface's world units. */
  drop(u: number, v: number, amount: number, radius?: number): void;
  step(dt: number): void;
  dispose(): void;
}

/** Waves on a real surface: `worldW` × `worldH` units across. A drop lands where the ray from the pointer met the surface, so the ring starts under the pointer from any camera. */
export function makeSurfaceWaves(env: WorldEnv, worldW: number, worldH: number, opts: { width?: number; damp?: number; mask?: WebGLTexture } = {}): SurfaceWaves {
  const gl = env.gl;
  const w = opts.width ?? (env.tier === 'low' ? 160 : env.tier === 'balanced' ? 256 : 360);
  const h = Math.max(4, Math.round((w * worldH) / worldW));
  const swap: Swap = makeSwap(gl, w, h, floatTarget(gl) ?? undefined);
  const program = makeProgram(gl, FULLSCREEN_VS, SURFACE_FS);
  const vao = gl.createVertexArray();
  const queue: number[] = [];
  let accumulator = 0;
  return {
    texture: () => swap.read.tex,
    texelX: 1 / w,
    texelY: 1 / h,
    drop(u, v, amount, radius = 0.16) {
      if (u < 0 || u > 1 || v < 0 || v > 1 || queue.length > 48) return;
      queue.push(u, v, amount, radius);
    },
    step(dt) {
      accumulator = Math.min(accumulator + dt * 60, 3);
      if (accumulator < 1 && !queue.length) return;
      gl.useProgram(program.prog);
      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.uniform2f(program.u('uTexel'), 1 / w, 1 / h);
      gl.uniform1f(program.u('uDamp'), opts.damp ?? 0.994);
      gl.uniform2f(program.u('uScale'), worldW, worldH);
      gl.uniform1f(program.u('uHasMask'), opts.mask ? 1 : 0);
      gl.viewport(0, 0, w, h);
      while (accumulator >= 1 || queue.length) {
        accumulator = Math.max(0, accumulator - 1);
        gl.bindFramebuffer(gl.FRAMEBUFFER, swap.write.fbo);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, swap.read.tex);
        gl.uniform1i(program.u('uPrev'), 0);
        if (opts.mask) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, opts.mask);
          gl.uniform1i(program.u('uMask'), 1);
        }
        if (queue.length) {
          const [a, b, c, d] = queue.splice(0, 4);
          gl.uniform4f(program.u('uDrop'), a, b, c, d);
        } else gl.uniform4f(program.u('uDrop'), 0, 0, 0, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        swap.swap();
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
    },
    dispose() {
      freeTarget(gl, swap.read);
      freeTarget(gl, swap.write);
      gl.deleteProgram(program.prog);
      gl.deleteVertexArray(vao);
    },
  };
}

// ─── Raw fragment scenes ────────────────────────────────────────────────────────────────────────────────────
export const SPATIAL_FS_HEAD = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uRes;
uniform vec2 uCss;
uniform float uTime;
uniform vec2 uMouse;
uniform vec2 uMouseNow;
uniform vec2 uVel;
uniform float uEnergy;
uniform float uStrength;
uniform float uDark;
uniform float uCalm;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform sampler2D uField;
uniform float uScroll;
uniform float uScrollVel;
uniform float uRoute;
uniform vec2 uRouteAt;
uniform vec3 uHover;
uniform float uDepth;
uniform float uMaterial;
uniform vec3 uRings[3];
${NOISE_GLSL}
float cardField(vec2 uv) { return texture(uField, vec2(uv.x, uv.y)).r; }
// Presses travel outwards from where they landed: the crest of the ring through this point, signed, 0 where there is none. Only for scenes built with { rings: true }.
float pressWave(vec2 uv) {
  float a = uCss.x / uCss.y, s = 0.0;
  for (int i = 0; i < 3; i++) {
    float age = uRings[i].z;
    if (age <= 0.0) continue;
    float d = length((uv - uRings[i].xy) * vec2(a, 1.0));
    float x = (d - age * 0.62) / (0.035 + age * 0.05);
    s += exp(-x * x) * cos(x * 3.0) * exp(-age * 1.9);
  }
  return s;
}
`;

export interface FragmentOptions {
  /** Extra per-frame work before the draw (simulation steps, extra uniforms). */
  before?(gl: WebGL2RenderingContext, p: Program, t: number, dt: number): void;
  dispose?(): void;
  slabs?: number;
  pixels?: number;
  fps?: number;
  /** Take the scene's presses as travelling rings (`pressWave`). A scene that reads the presses itself leaves this off. */
  rings?: boolean;
}

export function fragmentSpatial(env: WorldEnv, bridge: SpatialBridge, palette: PaletteId, fragment: string, options: FragmentOptions = {}): WorldInstance & { field: SceneField; palette: Palette } {
  const gl = env.gl;
  const pal = makePalette(palette, env.params.dark);
  const field = makeField(env, bridge, pal);
  const program = makeProgram(gl, FULLSCREEN_VS, fragment);
  const vao = gl.createVertexArray();
  const rings = new Float32Array(9);
  let nextRing = 0;
  return {
    field,
    palette: pal,
    pixels: options.pixels,
    fps: options.fps,
    frame(t, dt) {
      pal.update(dt, env.params.dark);
      field.update();
      gl.useProgram(program.prog);
      options.before?.(gl, program, t, dt);
      gl.useProgram(program.prog);
      if (options.rings) {
        for (const pulse of env.pointer.drainPulses()) {
          rings.set([pulse.u, pulse.v, 0.001], nextRing * 3);
          nextRing = (nextRing + 1) % 3;
        }
        for (let i = 0; i < 3; i++) if (rings[i * 3 + 2] > 0) rings[i * 3 + 2] = rings[i * 3 + 2] > 3 ? 0 : rings[i * 3 + 2] + dt / Math.max(0.1, env.params.motion * 1.67);
        gl.uniform3fv(program.u('uRings'), rings);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      setSpatialUniforms(gl, program, env, bridge, pal, t);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, field.texture);
      gl.uniform1i(program.u('uField'), 0);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      field.drawSlabs(options.slabs ?? 1);
    },
    resize() {},
    dispose() {
      options.dispose?.();
      field.dispose();
      gl.deleteProgram(program.prog);
      gl.deleteVertexArray(vao);
    },
  };
}

function setSpatialUniforms(gl: WebGL2RenderingContext, p: Program, env: WorldEnv, b: SpatialBridge, pal: Palette, t: number) {
  gl.uniform2f(p.u('uRes'), env.width, env.height);
  gl.uniform2f(p.u('uCss'), env.cssWidth, env.cssHeight);
  gl.uniform1f(p.u('uTime'), t);
  gl.uniform2f(p.u('uMouse'), env.pointer.su, env.pointer.sv);
  gl.uniform2f(p.u('uMouseNow'), env.pointer.u, env.pointer.v);
  gl.uniform2f(p.u('uVel'), env.pointer.vx, env.pointer.vy);
  gl.uniform1f(p.u('uEnergy'), env.pointer.energy);
  gl.uniform1f(p.u('uStrength'), env.pointer.strength);
  gl.uniform1f(p.u('uDark'), pal.dark);
  gl.uniform1f(p.u('uCalm'), env.params.calm);
  gl.uniform3fv(p.u('uC0'), pal.c0);
  gl.uniform3fv(p.u('uC1'), pal.c1);
  gl.uniform3fv(p.u('uC2'), pal.c2);
  gl.uniform3fv(p.u('uC3'), pal.c3);
  gl.uniform1f(p.u('uScroll'), b.scrollProgress);
  gl.uniform1f(p.u('uScrollVel'), b.scrollVelocity);
  gl.uniform1f(p.u('uRoute'), b.routePulse);
  gl.uniform2f(p.u('uRouteAt'), b.routeU, b.routeV);
  gl.uniform3f(p.u('uHover'), b.hoverX / Math.max(1, env.cssWidth), 1 - b.hoverY / Math.max(1, env.cssHeight), b.hoverAmount);
  gl.uniform1f(p.u('uDepth'), b.depth);
  gl.uniform1f(p.u('uMaterial'), b.material);
}

// ─── three.js scenes ────────────────────────────────────────────────────────────────────────────────────────
/** Declared by every three.js scene's shaders; `kit.uniforms` holds the shared values. */
export const SPATIAL_THREE_U = /* glsl */ `
uniform float uTime;
uniform float uDark;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec2 uMouse;
uniform float uEnergy;
uniform float uStrength;
uniform float uScroll;
uniform float uScrollVel;
uniform float uRoute;
uniform float uDepth;
uniform float uMaterial;
uniform sampler2D uField;
uniform vec2 uCss;
`;

export interface ThreeKit {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  uniforms: Record<string, THREE.IUniform>;
  palette: Palette;
  field: SceneField;
  env: WorldEnv;
  bridge: SpatialBridge;
}

const SKY_VS = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

/** A full-screen backdrop in the palette; `fragment` may replace its body. */
export function addSky(kit: ThreeKit, fragment?: string): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    vertexShader: SKY_VS,
    fragmentShader:
      fragment ??
      /* glsl */ `varying vec2 vUv; ${SPATIAL_THREE_U}
      void main() {
        vec3 col = mix(uC0, uC1, smoothstep(-0.2, 1.3, vUv.y + 0.25 * (vUv.x - 0.5)));
        col = mix(col, uC1, 0.35 * exp(-dot(vUv - uMouse, vUv - uMouse) * 2.6) * uStrength);
        gl_FragColor = vec4(col, 1.0);
      }`,
    uniforms: kit.uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  kit.scene.add(mesh);
  return mesh;
}

export interface ThreeSceneParts {
  update?(t: number, dt: number): void;
  resize?(): void;
  dispose?(): void;
  slabs?: number;
  pixels?: number;
}

/** A three.js scene on the runtime's context. Custom ShaderMaterials only: colours are written as they are, no tone mapping. */
export async function threeSpatial(env: WorldEnv, bridge: SpatialBridge, paletteId: PaletteId, build: (kit: ThreeKit) => ThreeSceneParts | Promise<ThreeSceneParts>, cameraInit: { fov?: number; z?: number } = {}): Promise<WorldInstance> {
  const renderer = new THREE.WebGLRenderer({ canvas: env.canvas, context: env.gl, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(env.width, env.height, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.autoClear = true;
  const palette = makePalette(paletteId, env.params.dark);
  const field = makeField(env, bridge, palette);
  const fieldTexture = new THREE.ExternalTexture(field.texture);
  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uDark: { value: palette.dark },
    uC0: { value: new THREE.Vector3() },
    uC1: { value: new THREE.Vector3() },
    uC2: { value: new THREE.Vector3() },
    uC3: { value: new THREE.Vector3() },
    uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    uEnergy: { value: 0 },
    uStrength: { value: 0 },
    uScroll: { value: 0 },
    uScrollVel: { value: 0 },
    uRoute: { value: 0 },
    uDepth: { value: bridge.depth },
    uMaterial: { value: bridge.material },
    uField: { value: fieldTexture },
    uCss: { value: new THREE.Vector2(env.cssWidth, env.cssHeight) },
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(cameraInit.fov ?? 40, env.width / env.height, 0.1, 200);
  camera.position.z = cameraInit.z ?? 10;
  const kit: ThreeKit = { renderer, scene, camera, uniforms, palette, field, env, bridge };
  const parts = await build(kit);
  return {
    pixels: parts.pixels,
    frame(t, dt) {
      palette.update(dt, env.params.dark);
      renderer.resetState();
      field.update();
      renderer.resetState();
      uniforms.uTime.value = t;
      uniforms.uDark.value = palette.dark;
      (uniforms.uC0.value as THREE.Vector3).fromArray(palette.c0);
      (uniforms.uC1.value as THREE.Vector3).fromArray(palette.c1);
      (uniforms.uC2.value as THREE.Vector3).fromArray(palette.c2);
      (uniforms.uC3.value as THREE.Vector3).fromArray(palette.c3);
      (uniforms.uMouse.value as THREE.Vector2).set(env.pointer.su, env.pointer.sv);
      uniforms.uEnergy.value = env.pointer.energy;
      uniforms.uStrength.value = env.pointer.strength;
      uniforms.uScroll.value = bridge.scrollProgress;
      uniforms.uScrollVel.value = bridge.scrollVelocity;
      uniforms.uRoute.value = bridge.routePulse;
      uniforms.uDepth.value = bridge.depth;
      uniforms.uMaterial.value = bridge.material;
      parts.update?.(t, dt);
      renderer.render(scene, camera);
      renderer.resetState();
      field.drawSlabs(parts.slabs ?? 1);
      renderer.resetState();
    },
    resize() {
      renderer.setSize(env.width, env.height, false);
      camera.aspect = env.width / env.height;
      camera.updateProjectionMatrix();
      (uniforms.uCss.value as THREE.Vector2).set(env.cssWidth, env.cssHeight);
      parts.resize?.();
    },
    dispose() {
      parts.dispose?.();
      disposeTree(scene);
      field.dispose();
      fieldTexture.dispose();
      renderer.dispose();
    },
  };
}

export function disposeTree(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose?.();
  });
}

/** A scene's copy of the shared uniforms plus its own values (same objects: updated once per frame by the kit). */
export function withUniforms(kit: ThreeKit, own: Record<string, THREE.IUniform> = {}): Record<string, THREE.IUniform> {
  return { ...kit.uniforms, ...own };
}

export const NOISE_3 = /* glsl */ `
float n3hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(n3hash(i), n3hash(i + vec3(1,0,0)), f.x), mix(n3hash(i + vec3(0,1,0)), n3hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(n3hash(i + vec3(0,0,1)), n3hash(i + vec3(1,0,1)), f.x), mix(n3hash(i + vec3(0,1,1)), n3hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * n3(p); p = p * 2.03 + 1.7; a *= 0.5; } return s; }
`;

/** Pointer on a plane facing the camera at z = planeZ, in world units. */
export function pointerAt(kit: ThreeKit, planeZ: number, out: THREE.Vector3, soft = true): THREE.Vector3 {
  const p = kit.env.pointer;
  const ndc = new THREE.Vector3((soft ? p.su : p.u) * 2 - 1, (soft ? p.sv : p.v) * 2 - 1, 0.5).unproject(kit.camera);
  const dir = ndc.sub(kit.camera.position).normalize();
  const t = (planeZ - kit.camera.position.z) / dir.z;
  return out.copy(kit.camera.position).addScaledVector(dir, t);
}

/** The view ray through a point of the screen (v up), for picking real objects and surfaces of a scene. */
export function rayFrom(kit: ThreeKit, u: number, v: number, origin: THREE.Vector3, dir: THREE.Vector3): void {
  origin.copy(kit.camera.position);
  dir.set(u * 2 - 1, v * 2 - 1, 0.5).unproject(kit.camera).sub(origin).normalize();
}

/** Distance along a ray to a sphere, or -1. */
export function raySphere(origin: THREE.Vector3, dir: THREE.Vector3, cx: number, cy: number, cz: number, r: number): number {
  const ox = origin.x - cx;
  const oy = origin.y - cy;
  const oz = origin.z - cz;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - c;
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t > 0 ? t : -1;
}

/** Shader-side lighting used by the matte three.js scenes: a soft key from the pointer side plus a fresnel rim. */
export const SOFT_LIGHT = /* glsl */ `
vec3 softLit(vec3 base, vec3 n, vec3 v, vec3 lightDir, vec3 rim, float rimAmount) {
  float diff = dot(n, lightDir) * 0.5 + 0.5;
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  float spec = pow(max(dot(reflect(-lightDir, n), v), 0.0), 40.0);
  return base * (0.32 + 0.82 * diff * diff) + rim * fres * rimAmount + vec3(1.0) * spec * 0.35;
}`;

/** Same-origin art used by the image scenes when the page itself offers none. */
export const ART_POOL = [
  '/assets/flashcards/deck-animals-640-203c2221.webp',
  '/assets/flashcards/deck-culture-640-7e0cae2b.webp',
  '/assets/flashcards/deck-environment-640-a15da6b6.webp',
  '/assets/flashcards/deck-business-640-1f0d2263.webp',
  '/assets/flashcards/deck-city-places-640-34c66b47.webp',
  '/assets/flashcards/deck-emotions-feelings-640-e7b9a409.webp',
  '/assets/flashcards/deck-education-640-ed77828f.webp',
  '/assets/flashcards/deck-body-health-640-e360122e.webp',
  '/assets/flashcards/deck-clothing-fashion-640-f8fe587e.webp',
  '/assets/flashcards/deck-communication-640-a6143c88.webp',
  '/assets/flashcards/deck-book1-640-7599f067.webp',
  '/assets/flashcards/deck-book3-640-b1b875d0.webp',
];

/** A texture atlas of `cols` × `rows` tiles from images (missing ones stay empty). Loads progressively, never blocks the first frame. */
export function makeArtAtlas(urls: string[], cols: number, rows: number, tile = 256, tileH = 160): { texture: THREE.CanvasTexture; dispose(): void } {
  const canvas = document.createElement('canvas');
  canvas.width = cols * tile;
  canvas.height = rows * tileH;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#2a3350';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  let disposed = false;
  urls.slice(0, cols * rows).forEach((url, index) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (disposed) return;
      const x = (index % cols) * tile;
      const y = Math.floor(index / cols) * tileH;
      const scale = Math.max(tile / image.naturalWidth, tileH / image.naturalHeight);
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, tile, tileH);
      ctx.clip();
      ctx.drawImage(image, x + (tile - w) / 2, y + (tileH - h) / 2, w, h);
      ctx.restore();
      texture.needsUpdate = true;
    };
    image.src = url;
  });
  return {
    texture,
    dispose() {
      disposed = true;
      texture.dispose();
    },
  };
}
