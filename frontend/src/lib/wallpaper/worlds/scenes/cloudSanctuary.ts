import type { WorldFactory } from '../types';
import { COMMON_UNIFORMS, NOISE_GLSL, fragmentWorld, tierDefines } from '../gl';

/**
 * Cloud Sanctuary. Layers of volumetric-looking cloud: each sheet is noise shaped into a bank, shaded by comparing its
 * density toward the sun. Between them float small islands with blossom trees. Far layers move little and near layers a
 * lot, so moving the pointer feels like moving your head. The pointer's speed is a wind that tears the near banks aside.
 * Dawn in light appearance; a cool evening with a moon and stars in dark.
 */

const FRAGMENT = (defines: string) => /* glsl */ `#version 300 es
${defines}
precision highp float;
in vec2 vUv;
out vec4 outColor;
${COMMON_UNIFORMS}
${NOISE_GLSL}
uniform vec2 uWind;

#if TIER == 2
#define LAYERS 5
#define OCT 5
#elif TIER == 1
#define LAYERS 4
#define OCT 4
#else
#define LAYERS 3
#define OCT 3
#endif

float fbmN(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < OCT; i++) { s += a * vnoise(p); p = ROT2 * p * 2.03 + 3.1; a *= 0.5; } return s; }

float bank(vec2 p, float base, float thick, float seed, float t, vec2 windPush) {
  vec2 q = p * vec2(1.9, 3.4) + vec2(t + seed * 7.0, seed * 3.0) + windPush;
  float big = fbmN(q);
  float detail = fbmN(q * 2.4 + big * 1.6 + 5.0);
  float billow = 1.0 - abs(2.0 * vnoise(q * 3.1 + big) - 1.0);
  float n = big * 0.68 + detail * 0.26 + billow * 0.12;
  float shape = smoothstep(base + thick, base - thick * 0.4, p.y + (big - 0.5) * thick * 1.6);
  return clamp((n - 0.54 + shape * 0.3) * 6.2, 0.0, 1.0) * smoothstep(0.0, 0.6, shape);
}

// A floating island: rock, turf, and a blossom tree. Returns colour in rgb, coverage in a.
vec4 island(vec2 p, vec2 c, float r, vec3 rock, vec3 turf, vec3 bloom, float seed) {
  vec2 d = p - c;
  vec4 out_ = vec4(0.0);
  float nx = d.x / r;
  if (abs(nx) < 1.2) {
    float wob = vnoise(vec2(d.x / r * 7.0 + seed, seed));
    float top = 0.022 * r / 0.09 * (1.0 - nx * nx * 0.4) + 0.01 * (wob - 0.5) * r / 0.09;
    float bottom = -r * (0.72 + 0.5 * vnoise(vec2(nx * 5.0 + seed, 2.0))) * pow(max(0.0, 1.0 - nx * nx), 0.72);
    float inside = smoothstep(top + 0.001, top - 0.001, d.y) * smoothstep(bottom - 0.001, bottom + 0.001, d.y) * step(abs(nx), 1.0);
    float strata = vnoise(vec2(d.x * 26.0 / r, d.y * 90.0 / r));
    vec3 body = mix(rock * 0.58, rock, smoothstep(bottom, top, d.y) * (0.6 + 0.4 * strata));
    body = mix(body, turf, smoothstep(top - 0.012 * r / 0.09, top - 0.002, d.y));
    out_ = vec4(body, inside);
  }
  // the tree
  vec2 t = d - vec2(r * 0.12, 0.018 + r * 0.45);
  float trunk = smoothstep(0.0035, 0.002, abs(d.x - r * 0.12 + sin(d.y * 60.0) * 0.002)) * step(0.0, d.y) * step(d.y, r * 0.42);
  out_ = mix(out_, vec4(rock * 0.45, 1.0), trunk);
  float crown = vnoise(t * 62.0 / (r / 0.09) + seed) * 0.5 + vnoise(t * 140.0 / (r / 0.09) + seed) * 0.25;
  float blob = length(t * vec2(1.0, 1.32)) - r * (0.46 + crown * 0.36);
  float crownMask = smoothstep(0.0025, -0.0025, blob);
  vec3 crownCol = mix(bloom * 0.76, bloom * 1.06, clamp((t.y / r + 0.3) * 1.5 + crown - 0.3, 0.0, 1.0));
  out_ = mix(out_, vec4(crownCol, 1.0), crownMask);
  return out_;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 uv = vUv;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 par = (uMouse - 0.5) * uStrength;
  vec2 m = vec2(uMouse.x * aspect, uMouse.y);

  // ── sky ──
  vec3 dawnHi = vec3(0.33, 0.56, 0.90), dawnMid = vec3(0.70, 0.78, 0.93), dawnLo = vec3(1.0, 0.84, 0.74);
  vec3 duskHi = vec3(0.025, 0.05, 0.15), duskMid = vec3(0.12, 0.13, 0.30), duskLo = vec3(0.42, 0.25, 0.38);
  vec3 hi = mix(dawnHi, duskHi, uDark), mid = mix(dawnMid, duskMid, uDark), lo = mix(dawnLo, duskLo, uDark);
  vec3 sky = mix(lo, mid, smoothstep(0.0, 0.5, uv.y));
  sky = mix(sky, hi, smoothstep(0.42, 1.0, uv.y));

  vec2 sun = vec2(aspect * 0.76 - par.x * 0.03, 0.76 - par.y * 0.02);
  float ds = length(p - sun);
  vec3 sunCol = mix(vec3(1.0, 0.86, 0.64), vec3(0.76, 0.82, 1.0), uDark);
  sky += sunCol * exp(-ds * mix(4.2, 4.6, uDark)) * mix(0.42, 0.32, uDark);
  sky += sunCol * smoothstep(mix(0.06, 0.05, uDark), mix(0.048, 0.046, uDark), ds) * mix(0.9, 0.86, uDark);
  float ang = atan(p.y - sun.y, p.x - sun.x);
  float rays = 0.5 + 0.5 * sin(ang * 11.0 + vnoise(vec2(ang * 3.0, uTime * 0.03)) * 3.0);
  sky += sunCol * pow(rays, 2.5) * exp(-ds * 3.1) * mix(0.07, 0.02, uDark);
  // stars for the evening
  vec2 g = p * 95.0;
  vec2 id = floor(g);
  float star = step(0.986, hash21(id)) * smoothstep(0.26, 0.0, length(fract(g) - 0.5));
  sky += vec3(0.8, 0.86, 1.0) * star * uDark * smoothstep(0.34, 0.8, uv.y) * (0.6 + 0.4 * sin(uTime + hash21(id) * 30.0));
  vec3 col = sky;

  vec3 sunDir = normalize(vec3(sun - p, 0.0) + vec3(0.0, 0.0001, 0.0));
  vec3 lit = mix(vec3(1.0, 0.975, 0.94), vec3(0.64, 0.70, 0.90), uDark);
  vec3 warm = mix(vec3(1.0, 0.82, 0.70), vec3(0.74, 0.54, 0.66), uDark);
  vec3 shade = mix(vec3(0.56, 0.62, 0.84), vec3(0.06, 0.075, 0.18), uDark);

  vec3 rock = mix(vec3(0.60, 0.58, 0.63), vec3(0.11, 0.12, 0.2), uDark);
  vec3 turf = mix(vec3(0.54, 0.72, 0.46), vec3(0.12, 0.2, 0.22), uDark);
  vec3 bloom = mix(vec3(0.98, 0.70, 0.78), vec3(0.42, 0.3, 0.46), uDark);

  // ── layers, far to near ──
  for (int i = 0; i < LAYERS; i++) {
    float f = float(i) / float(LAYERS - 1);
    float depth = 0.3 + f * 1.05;
    vec2 q = p / depth * 0.9;
    q += par * vec2(0.14, 0.05) * (0.2 + f * 1.4);

    float speed = uTime * (0.005 + f * 0.016);
    // The wind pushes near layers more; it is strongest around the pointer.
    float near = exp(-dot(p - m, p - m) * 2.4);
    vec2 push = uWind * (0.1 + f * 1.1) * near * 0.7;

    float base = 0.5 - f * 0.42;
    float d = bank(q, base / depth * 0.9, 0.13 + f * 0.06, float(i) * 3.3, speed, push);

    // Light: how much cloud lies toward the sun.
    float toward = bank(q + sunDir.xy * 0.045, base / depth * 0.9, 0.13 + f * 0.06, float(i) * 3.3, speed, push);
    float light = clamp(0.5 + (d - toward) * 3.6, 0.0, 1.0);
    vec3 cloud = mix(shade, lit, light);
    cloud = mix(cloud, warm, clamp((1.0 - uv.y) * 0.5 + (1.0 - f) * 0.2, 0.0, 0.5) * light);
    // Far layers sink into the sky's own colour.
    cloud = mix(mix(sky, mid, 0.5), cloud, 0.45 + f * 0.55);

    // Islands float between the layers.
    col = mix(col, cloud, d * (0.72 + f * 0.26));
    if (i == 1) {
      float bob = sin(uTime * 0.16) * 0.006;
      vec2 ip = p + par * vec2(0.05, 0.02);
      vec4 a = island(ip, vec2(aspect * 0.6, 0.64 + bob), 0.05, mix(rock, sky, 0.34), mix(turf, sky, 0.3), mix(bloom, sky, 0.2), 2.0);
      col = mix(col, a.rgb, a.a);
      vec4 b = island(ip, vec2(aspect * 0.92, 0.56 - bob * 0.7), 0.036, mix(rock, sky, 0.46), mix(turf, sky, 0.4), mix(bloom, sky, 0.32), 5.0);
      col = mix(col, b.rgb, b.a);
    }
    if (i == min(2, LAYERS - 2)) {
      float bob = sin(uTime * 0.13 + 2.0) * 0.008;
      vec2 ip = p + par * vec2(0.08, 0.03);
      vec4 c = island(ip, vec2(aspect * 0.36, 0.5 + bob), 0.09, rock, turf, bloom, 9.0);
      col = mix(col, c.rgb, c.a);
    }
  }
  col += (hash21(uv * uRes + uTime) - 0.5) / 160.0;
  outColor = vec4(col, 1.0);
}`;

const factory: WorldFactory = (env) => {
  let wx = 0;
  let wy = 0;
  const world = fragmentWorld(env, FRAGMENT(tierDefines(env)), {
    beforeDraw(gl, program, _t, dt) {
      // The wind builds from the pointer's speed and dies away slowly.
      const p = env.pointer;
      const k = Math.min(1, dt * 1.6);
      wx += (-p.vx * 0.9 * p.strength - wx) * k;
      wy += (-p.vy * 0.5 * p.strength - wy) * k;
      gl.uniform2f(program.u('uWind'), wx, wy);
    },
  });
  world.pixels = 0.5;
  return world;
};

export default factory;
