import { FULLSCREEN_VS, makeProgram, type Program } from '@/lib/wallpaper/worlds/gl';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * G03 Gravity Trail. Tens of thousands of particles under real gravity (transform feedback: positions live on the GPU). The pointer is a star; the particles keep their momentum, so a
 * still pointer collects a slowly turning disc and a quick sweep flings it apart. A short feedback of the previous frame draws their trails.
 */
const SIM_VS = /* glsl */ `#version 300 es
in vec2 aPos; in vec2 aVel; in float aSeed;
out vec2 vPos; out vec2 vVel; out float vSeed;
uniform vec2 uStar; uniform vec2 uStar2; uniform float uDt; uniform float uAspect; uniform float uPull; uniform float uKick; uniform vec2 uKickAt;
void main() {
  vec2 p = aPos, v = aVel;
  vec2 d = (uStar - p) * vec2(uAspect, 1.0);
  float r2 = dot(d, d) + 0.02;
  v += d / (r2 * sqrt(r2)) * 0.0011 * uPull * uDt * 60.0 * (0.6 + aSeed * 0.8);
  vec2 d2 = (uStar2 - p) * vec2(uAspect, 1.0);
  float r22 = dot(d2, d2) + 0.02;
  v += d2 / (r22 * sqrt(r22)) * 0.00018 * uDt * 60.0;
  if (uKick > 0.0) { vec2 k = (p - uKickAt) * vec2(uAspect, 1.0); float kr = dot(k, k) + 0.01; v += k / kr * 0.0009 * uKick; }
  v *= exp(-uDt * 0.16);
  p += v * uDt * vec2(1.0 / uAspect, 1.0);
  if (p.x < -0.25 || p.x > 1.25 || p.y < -0.25 || p.y > 1.25) { p = vec2(fract(aSeed * 91.7 + p.y), fract(aSeed * 37.3 + p.x)); v = (p.yx - 0.5) * vec2(-0.1, 0.1); }
  vPos = p; vVel = v; vSeed = aSeed;
  gl_Position = vec4(0.0);
}`;
const SIM_FS = /* glsl */ `#version 300 es
precision highp float; out vec4 o; void main() { o = vec4(0.0); }`;
const DRAW_VS = /* glsl */ `#version 300 es
in vec2 aPos; in vec2 aVel; in float aSeed;
out float vSpeed; out float vSeed;
uniform float uPx;
void main() {
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
  vSpeed = clamp(length(aVel) * 2.4, 0.0, 1.0);
  vSeed = aSeed;
  gl_PointSize = uPx * (0.9 + aSeed * 0.9);
}`;
const DRAW_FS = /* glsl */ `#version 300 es
precision highp float; in float vSpeed; in float vSeed; out vec4 o;
uniform vec3 uA; uniform vec3 uB; uniform float uGain;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.05, length(c));
  vec3 col = mix(uA, uB, vSpeed * 0.8 + vSeed * 0.2);
  o = vec4(col * a * uGain, a * uGain);
}`;
const FADE_FS = /* glsl */ `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uPrev; uniform float uKeep;
void main() { o = texture(uPrev, vUv) * uKeep; }`;
const SHOW_FS = /* glsl */ `${SPATIAL_FS_HEAD}
uniform sampler2D uTrail;
void main() {
  vec3 col = mix(uC0, uC1, smoothstep(-0.2, 1.3, vUv.y) * 0.5);
  vec4 t = texture(uTrail, vUv);
  col = mix(col, t.rgb / max(t.a, 0.001), clamp(t.a, 0.0, 1.0));
  vec2 m = (vUv - uMouse) * vec2(uCss.x / uCss.y, 1.0);
  col += uC3 * exp(-dot(m, m) * 620.0) * (0.25 + 0.9 * uStrength);
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => {
  const gl = env.gl;
  const count = env.tier === 'low' ? 14000 : env.tier === 'balanced' ? 36000 : 70000;
  const data = new Float32Array(count * 5);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.42;
    const x = 0.5 + Math.cos(a) * r;
    const y = 0.5 + Math.sin(a) * r;
    data.set([x, y, -Math.sin(a) * 0.14, Math.cos(a) * 0.14, Math.random()], i * 5);
  }
  const buffers = [gl.createBuffer(), gl.createBuffer()];
  const vaos = [gl.createVertexArray(), gl.createVertexArray()];
  const sim = makeProgram(gl, SIM_VS, SIM_FS, ['vPos', 'vVel', 'vSeed']);
  const draw = makeProgram(gl, DRAW_VS, DRAW_FS);
  const fade = makeProgram(gl, FULLSCREEN_VS, FADE_FS);
  const bindLayout = (p: Program) => {
    for (const [name, size, offset] of [['aPos', 2, 0], ['aVel', 2, 8], ['aSeed', 1, 16]] as [string, number, number][]) {
      const loc = gl.getAttribLocation(p.prog, name);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 20, offset);
    }
  };
  for (let i = 0; i < 2; i++) {
    gl.bindVertexArray(vaos[i]);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers[i]);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY);
    // Both programs read the same locations (bound by name order at link).
    bindLayout(sim);
  }
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  const tf = gl.createTransformFeedback();
  let current = 0;
  const w = Math.round(env.width * 0.6);
  const h = Math.round(env.height * 0.6);
  const makeRT = () => {
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer() as WebGLFramebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo };
  };
  let rtA = makeRT();
  let rtB = makeRT();
  const quad = gl.createVertexArray();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const aspect = env.cssWidth / Math.max(1, env.cssHeight);
  let kick = 0;
  let kickU = 0.5;
  let kickV = 0.5;

  const step = (dt: number, t: number, a: number[], b: number[]) => {
    gl.useProgram(sim.prog);
    const p = env.pointer;
    const live = p.strength > 0.01;
    gl.uniform2f(sim.u('uStar'), live ? p.su : 0.5 + 0.2 * Math.sin(t * 0.11), live ? p.sv : 0.5 + 0.18 * Math.cos(t * 0.13));
    gl.uniform2f(sim.u('uStar2'), 0.5 + 0.34 * Math.cos(t * 0.05), 0.5 + 0.3 * Math.sin(t * 0.07));
    gl.uniform1f(sim.u('uDt'), Math.min(dt, 1 / 30));
    gl.uniform1f(sim.u('uAspect'), aspect);
    gl.uniform1f(sim.u('uPull'), live ? 0.5 + 0.9 * p.strength : 0.5);
    for (const pulse of p.drainPulses()) {
      kick = 1;
      kickU = pulse.u;
      kickV = pulse.v;
    }
    gl.uniform1f(sim.u('uKick'), kick);
    gl.uniform2f(sim.u('uKickAt'), kickU, kickV);
    kick *= 0.85;
    if (kick < 0.02) kick = 0;
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.bindVertexArray(vaos[current]);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[1 - current]);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.disable(gl.RASTERIZER_DISCARD);
    current = 1 - current;

    // Trails: the previous picture, a little fainter, then the particles on top.
    gl.bindFramebuffer(gl.FRAMEBUFFER, rtB.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(fade.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rtA.tex);
    gl.uniform1i(fade.u('uPrev'), 0);
    gl.uniform1f(fade.u('uKeep'), 0.84);
    gl.bindVertexArray(quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(draw.prog);
    gl.uniform1f(draw.u('uPx'), 1.6 * (env.pixelRatio || 1));
    gl.uniform3f(draw.u('uA'), a[0], a[1], a[2]);
    gl.uniform3f(draw.u('uB'), b[0], b[1], b[2]);
    gl.uniform1f(draw.u('uGain'), 0.2);
    gl.bindVertexArray(vaos[current]);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.disable(gl.BLEND);
    const swap = rtA;
    rtA = rtB;
    rtB = swap;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, env.width, env.height);
  };

  const instance = fragmentSpatial(env, bridge, palette, SHOW_FS, {
    before(_g, p, t, dt) {
      step(dt, t, instance.palette.c2, instance.palette.c3);
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, rtA.tex);
      gl.uniform1i(p.u('uTrail'), 1);
    },
    dispose() {
      buffers.forEach((b) => gl.deleteBuffer(b));
      vaos.forEach((v) => gl.deleteVertexArray(v));
      gl.deleteVertexArray(quad);
      gl.deleteTransformFeedback(tf);
      [sim, draw, fade].forEach((x) => gl.deleteProgram(x.prog));
      [rtA, rtB].forEach((r) => {
        gl.deleteFramebuffer(r.fbo);
        gl.deleteTexture(r.tex);
      });
    },
    slabs: 0.9,
  });
  instance.warm = () => {
    for (let i = 0; i < 40; i++) step(1 / 30, i * 0.03, instance.palette.c2, instance.palette.c3);
  };
  return instance;
};
export default make;
