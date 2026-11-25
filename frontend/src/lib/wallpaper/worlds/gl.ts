import type { WorldEnv, WorldInstance } from './types';

/** Small WebGL 2 toolbox shared by the shader and character worlds (three.js worlds use the same context). */

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Noise shared by the fragment scenes. All of it is original, plain gradient / value noise. */
export const NOISE_GLSL = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 hash22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 a = hash22(i) * 2.0 - 1.0, b = hash22(i + vec2(1, 0)) * 2.0 - 1.0;
  vec2 c = hash22(i + vec2(0, 1)) * 2.0 - 1.0, d = hash22(i + vec2(1, 1)) * 2.0 - 1.0;
  return mix(mix(dot(a, f), dot(b, f - vec2(1, 0)), u.x), mix(dot(c, f - vec2(0, 1)), dot(d, f - vec2(1, 1)), u.x), u.y);
}
const mat2 ROT2 = mat2(0.8, -0.6, 0.6, 0.8);
float fbm2(vec2 p) { return 0.5 * vnoise(p) + 0.25 * vnoise(ROT2 * p * 2.03 + 3.1); }
float fbm3(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = ROT2 * p * 2.03 + 3.1; a *= 0.5; } return s; }
float fbm5(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = ROT2 * p * 2.03 + 3.1; a *= 0.5; } return s; }
`;

export interface Program {
  prog: WebGLProgram;
  u(name: string): WebGLUniformLocation | null;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader: ${log}`);
  }
  return shader;
}

export function makeProgram(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
  feedback?: string[],
): Program {
  const prog = gl.createProgram();
  if (!prog) throw new Error('program');
  const v = compileShader(gl, gl.VERTEX_SHADER, vs);
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  if (feedback) gl.transformFeedbackVaryings(prog, feedback, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    prog,
    u(name) {
      let loc = cache.get(name);
      if (loc === undefined) {
        loc = gl.getUniformLocation(prog, name);
        cache.set(name, loc);
      }
      return loc;
    },
  };
}

/** The renderable floating-point format of this device, or null (then a scene must fall back or refuse). */
export function floatTarget(gl: WebGL2RenderingContext): { internal: number; type: number } | null {
  if (gl.getExtension('EXT_color_buffer_float')) {
    gl.getExtension('OES_texture_float_linear');
    return { internal: gl.RGBA16F, type: gl.HALF_FLOAT };
  }
  if (gl.getExtension('EXT_color_buffer_half_float')) return { internal: gl.RGBA16F, type: gl.HALF_FLOAT };
  return null;
}

export interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export function makeTarget(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  format?: { internal: number; type: number } | null,
  filter: number = gl.LINEAR,
): Target {
  const tex = gl.createTexture() as WebGLTexture;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, format?.internal ?? gl.RGBA8, w, h, 0, gl.RGBA, format?.type ?? gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer() as WebGLFramebuffer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, w, h };
}

export function freeTarget(gl: WebGL2RenderingContext, t: Target | null | undefined): void {
  if (!t) return;
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.tex);
}

export interface Swap {
  read: Target;
  write: Target;
  swap(): void;
}

export function makeSwap(gl: WebGL2RenderingContext, w: number, h: number, format?: { internal: number; type: number } | null): Swap {
  const pair: Swap = {
    read: makeTarget(gl, w, h, format),
    write: makeTarget(gl, w, h, format),
    swap() {
      const t = pair.read;
      pair.read = pair.write;
      pair.write = t;
    },
  };
  return pair;
}

export function bindTexture(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(loc, unit);
}

/** Uniforms every fragment scene gets, so scenes share one vocabulary for time, pointer and appearance. */
export const COMMON_UNIFORMS = /* glsl */ `
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform vec2 uVel;
uniform float uEnergy;
uniform float uStrength;
uniform float uDark;
uniform float uCalm;
`;

export function setCommon(gl: WebGL2RenderingContext, p: Program, env: WorldEnv, t: number, dark: number): void {
  gl.uniform2f(p.u('uRes'), env.width, env.height);
  gl.uniform1f(p.u('uTime'), t);
  gl.uniform2f(p.u('uMouse'), env.pointer.su, env.pointer.sv);
  gl.uniform2f(p.u('uVel'), env.pointer.vx, env.pointer.vy);
  gl.uniform1f(p.u('uEnergy'), env.pointer.energy);
  gl.uniform1f(p.u('uStrength'), env.pointer.strength);
  gl.uniform1f(p.u('uDark'), dark);
  gl.uniform1f(p.u('uCalm'), env.params.calm);
}

/** Eases a value toward the app's appearance, so a theme change melts instead of snapping. */
export function darkEase(current: number, dark: boolean, dt: number): number {
  // A still frame has no time to melt in: it simply shows the current appearance.
  if (dt <= 0) return dark ? 1 : 0;
  return current + ((dark ? 1 : 0) - current) * Math.min(1, dt * 2.4);
}

/** One fragment shader over the whole screen: the simplest kind of world. */
export function fragmentWorld(
  env: WorldEnv,
  fragment: string,
  options: { beforeDraw?: (gl: WebGL2RenderingContext, p: Program, t: number, dt: number) => void; dispose?: () => void } = {},
): WorldInstance {
  const gl = env.gl;
  const program = makeProgram(gl, FULLSCREEN_VS, fragment);
  const vao = gl.createVertexArray();
  let dark = env.params.dark ? 1 : 0;
  return {
    frame(t, dt) {
      dark = darkEase(dark, env.params.dark, dt);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
      gl.disable(gl.BLEND);
      gl.useProgram(program.prog);
      setCommon(gl, program, env, t, dark);
      options.beforeDraw?.(gl, program, t, dt);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    resize() {},
    dispose() {
      options.dispose?.();
      gl.deleteProgram(program.prog);
      gl.deleteVertexArray(vao);
    },
  };
}

/** Tier-dependent #defines for a shader (put right after the #version line). */
export function tierDefines(env: WorldEnv): string {
  return `#define TIER ${env.tier === 'high' ? 2 : env.tier === 'balanced' ? 1 : 0}\n`;
}
