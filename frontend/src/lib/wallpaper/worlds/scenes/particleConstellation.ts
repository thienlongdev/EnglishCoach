import type { WorldFactory } from '../types';
import { FULLSCREEN_VS, NOISE_GLSL, bindTexture, floatTarget, freeTarget, makeProgram, makeSwap, makeTarget, type Target } from '../gl';

/**
 * Particle Constellation. Tens of thousands of particles live entirely on the GPU (transform feedback): each follows a
 * curl-noise flow and a home on a slow spiral, so the sky keeps its shape and never clutters. The pointer is a force:
 * it attracts while it rests, twists into a vortex as it moves, and pushes outward on a press. Particles are drawn
 * into a fading buffer, so they leave trails, with a soft bloom. A few hundred bright stars are linked by thin lines
 * near the pointer: temporary constellations.
 */

const UPDATE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aVel;
layout(location = 2) in vec2 aHome;
out vec2 vPos;
out vec2 vVel;
uniform float uDt;
uniform float uTime;
uniform vec2 uMouse;
uniform vec2 uMouseVel;
uniform float uStrength;
uniform float uEnergy;
uniform float uBurst;
uniform vec2 uBurstAt;
uniform float uAspect;
${NOISE_GLSL}
vec2 curl(vec2 p, float t) {
  float e = 0.06;
  float n1 = gnoise(p + vec2(0.0, e) + t);
  float n2 = gnoise(p - vec2(0.0, e) + t);
  float n3 = gnoise(p + vec2(e, 0.0) + t);
  float n4 = gnoise(p - vec2(e, 0.0) + t);
  return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}
void main() {
  vec2 p = aPos;
  vec2 v = aVel;
  // the home rotates slowly: a galaxy that turns over minutes
  float ang = uTime * 0.012;
  vec2 home = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * aHome;
  vec2 force = (home - p) * 0.7;
  force += curl(p * 1.3 + aHome * 0.6, uTime * 0.05) * 0.2;
  force += curl(p * 3.2, -uTime * 0.07) * 0.06;
  if (uStrength > 0.001) {
    vec2 d = uMouse - p;
    float r2 = dot(d, d);
    float near = exp(-r2 * 9.0);
    // attraction while resting, a vortex with movement
    force += d * near * (1.1 + 0.8 * uEnergy) * uStrength;
    force += vec2(-d.y, d.x) * near * (0.5 + 5.0 * uEnergy) * uStrength;
    force += uMouseVel * near * 0.9 * uStrength;
  }
  if (uBurst > 0.001) {
    vec2 d = p - uBurstAt;
    force += normalize(d + 1e-4) * exp(-dot(d, d) * 7.0) * uBurst * 24.0;
  }
  v += force * uDt;
  v *= exp(-uDt * 1.6);
  p += v * uDt;
  vPos = p;
  vVel = v;
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}`;
const UPDATE_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 c;
void main() { c = vec4(0.0); }`;

const DRAW_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aVel;
layout(location = 2) in vec2 aHome;
out vec3 vColor;
uniform float uAspect;
uniform float uScale;
void main() {
  vec2 p = aPos;
  gl_Position = vec4(p.x / uAspect, p.y, 0.0, 1.0);
  float seed = fract(aHome.x * 17.3 + aHome.y * 31.7);
  float sp = length(aVel);
  float big = step(0.985, seed);
  gl_PointSize = (mix(1.1, 1.8, seed) + big * 2.2 + min(1.2, sp * 1.6)) * uScale;
  float r = length(aHome);
  vec3 cold = vec3(0.34, 0.5, 1.0);
  vec3 warm = vec3(1.0, 0.42, 0.72);
  vec3 gold = vec3(1.0, 0.82, 0.54);
  vec3 base = mix(mix(warm, cold, smoothstep(0.1, 0.9, r + (seed - 0.5) * 0.5)), gold, step(0.93, seed));
  vec3 hot = mix(base, vec3(1.0), min(1.0, sp * 1.1));
  vColor = hot * (0.05 + 0.09 * seed + min(0.16, sp * 0.26) + big * 0.3);
}`;
const DRAW_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.05, length(q));
  outColor = vec4(vColor * a, 1.0);
}`;

const FADE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uFade;
void main() { outColor = vec4(texture(uTex, vUv).rgb * uFade, 1.0); }`;

const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.227;
  c += (texture(uTex, vUv + uDir * 1.385).rgb + texture(uTex, vUv - uDir * 1.385).rgb) * 0.316;
  c += (texture(uTex, vUv + uDir * 3.231).rgb + texture(uTex, vUv - uDir * 3.231).rgb) * 0.07;
  outColor = vec4(c, 1.0);
}`;

const COMPOSE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform float uTime;
${NOISE_GLSL}
void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec3 bg = mix(vec3(0.018, 0.012, 0.055), vec3(0.004, 0.003, 0.016), smoothstep(0.0, 1.0, length(p)));
  float neb = fbm3(p * 1.7 + uTime * 0.006);
  float neb2 = fbm3(p * 2.9 - uTime * 0.008 + neb);
  bg += vec3(0.08, 0.02, 0.11) * smoothstep(0.42, 0.78, neb) + vec3(0.012, 0.03, 0.09) * smoothstep(0.44, 0.8, neb2);
  vec3 col = bg + texture(uTex, uv).rgb + texture(uBloom, uv).rgb * 0.75;
  col = 1.0 - exp(-col * 1.05);
  col += (hash21(uv * uRes + uTime) - 0.5) / 170.0;
  outColor = vec4(col, 1.0);
}`;

const LINE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aAlpha;
out float vA;
uniform float uAspect;
void main() {
  vA = aAlpha;
  gl_Position = vec4(aPos.x / uAspect, aPos.y, 0.0, 1.0);
}`;
const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
in float vA;
out vec4 outColor;
void main() { outColor = vec4(vec3(0.74, 0.72, 1.0) * vA * 0.5, 1.0); }`;

const COUNTS = { high: 110_000, balanced: 42_000, low: 14_000 } as const;
const STARS = { high: 170, balanced: 110, low: 60 } as const;

const factory: WorldFactory = (env) => {
  const gl = env.gl;
  const format = floatTarget(gl);
  const update = makeProgram(gl, UPDATE_VS, UPDATE_FS, ['vPos', 'vVel']);
  const drawP = makeProgram(gl, DRAW_VS, DRAW_FS);
  const fade = makeProgram(gl, FULLSCREEN_VS, FADE_FS);
  const blur = makeProgram(gl, FULLSCREEN_VS, BLUR_FS);
  const compose = makeProgram(gl, FULLSCREEN_VS, COMPOSE_FS);
  const line = makeProgram(gl, LINE_VS, LINE_FS);
  const emptyVao = gl.createVertexArray();

  const count = COUNTS[env.tier];
  const aspect0 = env.cssWidth / env.cssHeight;
  // Homes: a two-armed spiral with a soft halo, stretched to the screen.
  const homes = new Float32Array(count * 2);
  const initial = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const s = Math.random();
    const arm = i % 2 === 0 ? 0 : Math.PI;
    const r = Math.pow(s, 0.68) * 1.2;
    const spread = (0.05 + r * 0.2) * (Math.random() + Math.random() - 1);
    const a = arm + r * 3.4 + spread * 3;
    const halo = Math.random() < 0.28;
    const hx = halo ? (Math.random() - 0.5) * 2 * Math.max(aspect0, 1) * 1.05 : Math.cos(a) * r * 1.15;
    const hy = halo ? (Math.random() - 0.5) * 2.1 : Math.sin(a) * r * 0.72;
    homes[i * 2] = hx;
    homes[i * 2 + 1] = hy;
    initial[i * 4] = hx + (Math.random() - 0.5) * 0.4;
    initial[i * 4 + 1] = hy + (Math.random() - 0.5) * 0.4;
    initial[i * 4 + 2] = 0;
    initial[i * 4 + 3] = 0;
  }
  const homeBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, homeBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, homes, gl.STATIC_DRAW);
  const buffers = [gl.createBuffer(), gl.createBuffer()];
  const vaos = [gl.createVertexArray(), gl.createVertexArray()];
  for (let i = 0; i < 2; i++) {
    gl.bindVertexArray(vaos[i]);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers[i]);
    gl.bufferData(gl.ARRAY_BUFFER, initial, gl.DYNAMIC_COPY);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ARRAY_BUFFER, homeBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  const tf = gl.createTransformFeedback();
  let current = 0;

  // Stars linked into temporary constellations near the pointer.
  const starCount = STARS[env.tier];
  const stars = new Float32Array(starCount * 2);
  for (let i = 0; i < starCount; i++) {
    stars[i * 2] = (Math.random() - 0.5) * 2 * aspect0 * 0.98;
    stars[i * 2 + 1] = (Math.random() - 0.5) * 2 * 0.96;
  }
  const lineData = new Float32Array(starCount * 6 * 3);
  const lineBuffer = gl.createBuffer();
  const lineVao = gl.createVertexArray();
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
  gl.bindVertexArray(null);

  const sizes = () => ({ w: env.width, h: env.height, bw: Math.max(8, env.width >> 2), bh: Math.max(8, env.height >> 2) });
  let s = sizes();
  let trails = makeSwap(gl, s.w, s.h, format);
  let bloomA: Target = makeTarget(gl, s.bw, s.bh, format);
  let bloomB: Target = makeTarget(gl, s.bw, s.bh, format);
  let burst = 0;
  let burstU = 0;
  let burstV = 0;

  const pass = (target: Target | null) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null);
    gl.viewport(0, 0, target?.w ?? env.width, target?.h ?? env.height);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const simulate = (dt: number, t: number) => {
    const p = env.pointer;
    const aspect = env.cssWidth / env.cssHeight;
    gl.useProgram(update.prog);
    gl.uniform1f(update.u('uDt'), dt);
    gl.uniform1f(update.u('uTime'), t);
    gl.uniform2f(update.u('uMouse'), (p.su * 2 - 1) * aspect, p.sv * 2 - 1);
    gl.uniform2f(update.u('uMouseVel'), p.vx * 2, p.vy * 2);
    gl.uniform1f(update.u('uStrength'), p.strength);
    gl.uniform1f(update.u('uEnergy'), p.energy);
    gl.uniform1f(update.u('uBurst'), burst);
    gl.uniform2f(update.u('uBurstAt'), burstU, burstV);
    gl.uniform1f(update.u('uAspect'), aspect);
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
  };

  return {
    warm(seconds) {
      const steps = Math.min(60, Math.round(seconds * 12));
      for (let i = 0; i < steps; i++) simulate(1 / 20, i / 20);
    },
    frame(t, dt) {
      const aspect = env.cssWidth / env.cssHeight;
      const p = env.pointer;
      gl.disable(gl.BLEND);
      for (const pulse of p.drainPulses()) {
        burst = 1;
        burstU = (pulse.u * 2 - 1) * aspect;
        burstV = pulse.v * 2 - 1;
      }
      burst *= Math.exp(-dt * 7);
      if (dt > 0) simulate(Math.min(dt, 1 / 30), t);

      // Trails: yesterday's frame, faded.
      gl.useProgram(fade.prog);
      bindTexture(gl, 0, trails.read.tex, fade.u('uTex'));
      gl.uniform1f(fade.u('uFade'), dt > 0 ? Math.exp(-dt * 7.5) : 0);
      pass(trails.write);

      // Particles, additive, into the same buffer.
      gl.bindFramebuffer(gl.FRAMEBUFFER, trails.write.fbo);
      gl.viewport(0, 0, s.w, s.h);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(drawP.prog);
      gl.uniform1f(drawP.u('uAspect'), aspect);
      gl.uniform1f(drawP.u('uScale'), Math.max(1, env.pixelRatio));
      gl.bindVertexArray(vaos[current]);
      gl.drawArrays(gl.POINTS, 0, count);

      // Temporary constellations.
      if (p.strength > 0.01) {
        const mx = (p.su * 2 - 1) * aspect;
        const my = p.sv * 2 - 1;
        let n = 0;
        const reach = 0.5;
        for (let i = 0; i < starCount; i++) {
          const ax = stars[i * 2];
          const ay = stars[i * 2 + 1];
          const dm = Math.hypot(ax - mx, ay - my);
          if (dm > reach) continue;
          const glow = (1 - dm / reach) * p.strength;
          // to the pointer's nearest stars
          for (let j = i + 1; j < starCount; j++) {
            const bx = stars[j * 2];
            const by = stars[j * 2 + 1];
            const d = Math.hypot(ax - bx, ay - by);
            if (d > 0.24 || Math.hypot(bx - mx, by - my) > reach) continue;
            if (n + 6 > lineData.length) break;
            const alpha = glow * (1 - d / 0.24);
            lineData[n++] = ax; lineData[n++] = ay; lineData[n++] = alpha;
            lineData[n++] = bx; lineData[n++] = by; lineData[n++] = alpha;
          }
        }
        if (n > 0) {
          gl.useProgram(line.prog);
          gl.uniform1f(line.u('uAspect'), aspect);
          gl.bindVertexArray(lineVao);
          gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, lineData.subarray(0, n));
          gl.drawArrays(gl.LINES, 0, n / 3);
        }
      }
      gl.disable(gl.BLEND);
      trails.swap();

      // Bloom: two blur passes on a quarter-size copy.
      gl.useProgram(blur.prog);
      bindTexture(gl, 0, trails.read.tex, blur.u('uTex'));
      gl.uniform2f(blur.u('uDir'), 1.6 / s.bw, 0);
      pass(bloomA);
      bindTexture(gl, 0, bloomA.tex, blur.u('uTex'));
      gl.uniform2f(blur.u('uDir'), 0, 1.6 / s.bh);
      pass(bloomB);

      gl.useProgram(compose.prog);
      bindTexture(gl, 0, trails.read.tex, compose.u('uTex'));
      bindTexture(gl, 1, bloomB.tex, compose.u('uBloom'));
      gl.uniform2f(compose.u('uRes'), env.width, env.height);
      gl.uniform1f(compose.u('uTime'), t);
      pass(null);
    },
    resize() {
      const next = sizes();
      if (next.w === s.w && next.h === s.h) return;
      s = next;
      freeTarget(gl, trails.read);
      freeTarget(gl, trails.write);
      freeTarget(gl, bloomA);
      freeTarget(gl, bloomB);
      trails = makeSwap(gl, s.w, s.h, format);
      bloomA = makeTarget(gl, s.bw, s.bh, format);
      bloomB = makeTarget(gl, s.bw, s.bh, format);
    },
    dispose() {
      freeTarget(gl, trails.read);
      freeTarget(gl, trails.write);
      freeTarget(gl, bloomA);
      freeTarget(gl, bloomB);
      for (const b of [...buffers, homeBuffer, lineBuffer]) gl.deleteBuffer(b);
      for (const v of [...vaos, lineVao, emptyVao]) gl.deleteVertexArray(v);
      gl.deleteTransformFeedback(tf);
      for (const prog of [update, drawP, fade, blur, compose, line]) gl.deleteProgram(prog.prog);
    },
  };
};

export default factory;
