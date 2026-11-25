import { FULLSCREEN_VS, floatTarget, freeTarget, makeProgram, makeSwap } from '@/lib/wallpaper/worlds/gl';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * C07 Raked Sand. A dry garden: the pointer is a rake with five teeth. Its stroke presses real grooves into a height field, oriented across the direction it moves, and the grooves stay long after, wearing
 * away slowly until the sand is smooth again. A press draws circles of raked rings around where it landed. Three stones stand in the sand with rings already combed around them. Nothing rushes, which is why
 * it suits a page of reading: the only thing that moves is what the learner just did.
 */
const RAKE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform vec4 uStroke;
uniform float uWidth;
uniform float uAspect;
uniform float uHeal;
uniform vec3 uRing;
out vec4 frag;
void main() {
  float h = texture(uPrev, vUv).r * uHeal;
  vec2 p = vUv * vec2(uAspect, 1.0);
  vec2 a = uStroke.xy * vec2(uAspect, 1.0);
  vec2 b = uStroke.zw * vec2(uAspect, 1.0);
  vec2 ab = b - a;
  float len2 = dot(ab, ab);
  if (len2 > 1e-7) {
    float along = clamp(dot(p - a, ab) / len2, 0.0, 1.0);
    vec2 foot = a + ab * along;
    vec2 n = vec2(-ab.y, ab.x) / sqrt(len2);
    float across = dot(p - foot, n);
    float cover = smoothstep(uWidth, uWidth * 0.82, abs(across)) * step(length(p - foot), uWidth * 1.15);
    // five teeth across the width: the groove pattern replaces what was under the rake
    float teeth = cos(across / uWidth * 3.14159 * 5.0);
    h = mix(h, teeth, cover * 0.9);
  }
  if (uRing.z > 0.0) {
    float d = length(p - uRing.xy * vec2(uAspect, 1.0));
    float cover = smoothstep(uRing.z, uRing.z * 0.9, d) * smoothstep(0.012, 0.024, d);
    h = mix(h, cos(d * 150.0), cover * 0.9);
  }
  frag = vec4(h, 0.0, 0.0, 1.0);
}`;

const FS = /* glsl */ `${SPATIAL_FS_HEAD}
uniform sampler2D uSand;
uniform vec2 uTexel;
const vec3 STONES[3] = vec3[3](vec3(0.26, 0.28, 0.07), vec3(0.72, 0.68, 0.1), vec3(0.86, 0.22, 0.05));
float stoneH(vec2 p, vec3 s) {
  vec2 q = (p - s.xy) / s.z;
  q.x += 0.12 * sin(q.y * 3.0 + s.x * 20.0);
  return 1.0 - dot(q, q);
}
float height(vec2 uv, float a) {
  vec2 p = vec2(uv.x * a, uv.y);
  float h = texture(uSand, uv).r * 0.012;
  // combed rings around each stone, part of the garden from the start; fine grain everywhere
  for (int i = 0; i < 3; i++) {
    vec2 c = vec2(STONES[i].x * a, STONES[i].y);
    float d = length(p - c);
    float r = STONES[i].z;
    float ring = cos((d - r) * 150.0) * smoothstep(r * 3.2, r * 2.6, d) * smoothstep(r * 0.9, r * 1.05, d);
    float raked = abs(texture(uSand, uv).r);
    h += ring * 0.009 * (1.0 - smoothstep(0.1, 0.4, raked));
  }
  return h;
}
void main() {
  float a = uCss.x / uCss.y;
  vec2 uv = vUv;
  float e = 1.4;
  float h0 = height(uv, a);
  float hx = height(uv + vec2(uTexel.x * e, 0.0), a);
  float hy = height(uv + vec2(0.0, uTexel.y * e), a);
  vec3 n = normalize(vec3(-(hx - h0) / (uTexel.x * e * a), -(hy - h0) / (uTexel.y * e), 1.0) * vec3(1.0, 1.0, 1.0));
  // The light stays low to rake the grooves, and leans with the pointer.
  vec2 lp = (uMouse - 0.5) * uStrength * 0.8;
  vec3 l = normalize(vec3(-0.55 + lp.x, 0.62 + lp.y, 0.5));
  float diff = max(dot(n, l), 0.0);
  vec3 sand = mix(uC1, mix(uC2, uC3, 0.35), 0.28 + 0.34 * uDark);
  sand = mix(sand, uC0, mix(0.0, 0.42, uDark));
  sand *= 0.97 + 0.06 * vnoise(uv * uRes * 0.4);
  vec3 col = sand * (0.46 + 0.86 * diff);
  col += vec3(1.0, 0.96, 0.9) * pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 26.0) * 0.1;
  // Stones and their soft shadows.
  vec2 p = vec2(uv.x * a, uv.y);
  for (int i = 0; i < 3; i++) {
    vec3 s = vec3(STONES[i].x * a, STONES[i].y, STONES[i].z);
    float shade = stoneH(p - vec2(-0.025, 0.018) * s.z * 10.0, s);
    col *= 1.0 - smoothstep(-0.7, 0.4, shade) * 0.36;
    float top = stoneH(p, s);
    if (top > 0.0) {
      vec2 grad = -2.0 * (p - s.xy) / (s.z * s.z);
      vec3 ns = normalize(vec3(-grad * 0.06, sqrt(max(top, 0.01))));
      float lit = 0.34 + 0.8 * max(dot(ns, l), 0.0);
      vec3 rock = mix(uC0, uC1, 0.45) * (0.76 + 0.4 * fbm3(p * 28.0)) + 0.05;
      col = mix(col, rock * lit, smoothstep(0.0, 0.05, top));
    }
  }
  // The real cards rest on the sand.
  col *= 1.0 - smoothstep(0.1, 0.9, cardField(uv + vec2(0.006, 0.012))) * 0.14;
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => {
  const gl = env.gl;
  const w = env.tier === 'high' ? 1024 : env.tier === 'balanced' ? 768 : 512;
  const h = Math.max(4, Math.round((w * env.cssHeight) / Math.max(1, env.cssWidth)));
  const swap = makeSwap(gl, w, h, floatTarget(gl) ?? undefined);
  const rake = makeProgram(gl, FULLSCREEN_VS, RAKE_FS);
  const vao = gl.createVertexArray();
  let lastU = -1;
  let lastV = -1;
  const rings: { u: number; v: number; r: number }[] = [];
  const probe = { strokes: 0, circles: 0 };
  bridge.probe = probe;
  return fragmentSpatial(env, bridge, palette, FS, {
    before(_g, p, _t, rawDt) {
      const pt = env.pointer;
      const dt = Math.min(rawDt, 1 / 20);
      for (const pulse of pt.drainPulses()) {
        rings.push({ u: pulse.u, v: pulse.v, r: 0.03 });
        probe.circles += 1;
        if (rings.length > 3) rings.shift();
      }
      const moved = lastU >= 0 ? Math.hypot((pt.u - lastU) * (env.cssWidth / Math.max(1, env.cssHeight)), pt.v - lastV) : 0;
      const stroke = pt.strength > 0.05 && moved > 0.0012;
      if (stroke) probe.strokes += 1;
      gl.useProgram(rake.prog);
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.viewport(0, 0, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, swap.write.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, swap.read.tex);
      gl.uniform1i(rake.u('uPrev'), 0);
      gl.uniform1f(rake.u('uAspect'), env.cssWidth / Math.max(1, env.cssHeight));
      gl.uniform1f(rake.u('uWidth'), 0.042);
      gl.uniform1f(rake.u('uHeal'), Math.exp(-dt * 0.035));
      if (stroke) gl.uniform4f(rake.u('uStroke'), lastU, lastV, pt.u, pt.v);
      else gl.uniform4f(rake.u('uStroke'), 0, 0, 0, 0);
      const ring = rings[0];
      if (ring) {
        // Circles are combed outward, a little every frame.
        ring.r += dt * 0.11;
        gl.uniform3f(rake.u('uRing'), ring.u, ring.v, Math.min(ring.r, 0.17));
        if (ring.r > 0.17) rings.shift();
      } else gl.uniform3f(rake.u('uRing'), 0, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      swap.swap();
      lastU = pt.u;
      lastV = pt.v;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, swap.read.tex);
      gl.uniform1i(p.u('uSand'), 1);
      gl.uniform2f(p.u('uTexel'), 1 / w, 1 / h);
    },
    dispose() {
      freeTarget(gl, swap.read);
      freeTarget(gl, swap.write);
      gl.deleteProgram(rake.prog);
      gl.deleteVertexArray(vao);
    },
    slabs: 0.8,
    pixels: 0.85,
  });
};
export default make;
