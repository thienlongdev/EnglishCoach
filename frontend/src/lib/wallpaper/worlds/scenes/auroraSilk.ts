import type { WorldFactory } from '../types';
import { COMMON_UNIFORMS, NOISE_GLSL, fragmentWorld, tierDefines } from '../gl';

/**
 * Aurora Silk. Curtains of light are folded sheets: each has a wandering lower hem, a fold coordinate with sharp silky
 * highlights where the sheet turns, and fine rays rising from the hem. The pointer is a soft field that bends the sheets
 * and pushes the hem; a mirror lake and dark ridges ground the sky. In light appearance the same silk hangs in a pale dawn.
 */

const FRAGMENT = (defines: string) => /* glsl */ `#version 300 es
${defines}
precision highp float;
in vec2 vUv;
out vec4 outColor;
${COMMON_UNIFORMS}
${NOISE_GLSL}

#if TIER == 2
#define SHEETS 5
#elif TIER == 1
#define SHEETS 4
#else
#define SHEETS 3
#endif

// One silk sheet: returns light in rgb (night palette), intensity in a.
vec4 sheet(vec2 p, float seed, vec2 mouse, float t) {
  vec2 d = p - mouse;
  float near = exp(-dot(d, d) * 5.5) * uStrength;
  float bend = near * (0.2 + 0.8 * uEnergy) * (d.x / (abs(d.x) + 0.22)) + near * uVel.x * 0.5;
  float x = p.x + bend;

  // the sheet's fold coordinate: large lazy waves carrying finer folds
  float wide = gnoise(vec2(x * 0.75 + seed * 3.1, t * 0.07 + seed)) * 2.2;
  float fold = x * (1.6 + seed * 0.6) + wide + 0.36 * sin(x * 3.1 + t * 0.21 + seed * 5.0);

  // the hem: where the sheet hangs down to
  float hem = 0.46 + seed * 0.2 + 0.2 * gnoise(vec2(fold * 0.7 + seed * 7.0, t * 0.05));
  hem -= near * (0.08 + 0.22 * uEnergy);
  float h = p.y - hem;
  float height = 0.34 + 0.3 * vnoise(vec2(fold * 1.3 + seed, t * 0.06));
  float body = smoothstep(-0.012, 0.018, h) * exp(-max(h, 0.0) / height * 2.6);

  // silky highlights: where the sheet turns edge-on, it is brightest
  float turn = abs(sin(fold * 5.3 + 1.7 * sin(fold * 1.9 + t * 0.14)));
  float silk = pow(1.0 - turn, 3.2) * 1.3 + 0.32;
  // fine rays rising from the hem
  float rays = vnoise(vec2(fold * 34.0, t * 0.3 + seed * 11.0));
  rays = mix(0.72, 1.18, rays);
  float light = body * silk * rays;

  // colour climbs from green through teal to violet and rose
  float v = clamp(max(h, 0.0) / (height * 1.2), 0.0, 1.0);
  vec3 low = mix(vec3(0.16, 1.0, 0.56), vec3(0.2, 0.86, 0.95), seed);
  vec3 mid = mix(vec3(0.16, 0.74, 0.92), vec3(0.42, 0.42, 1.0), seed);
  vec3 top = mix(vec3(0.62, 0.3, 1.0), vec3(1.0, 0.36, 0.72), seed);
  vec3 c = v < 0.45 ? mix(low, mid, v / 0.45) : mix(mid, top, (v - 0.45) / 0.55);
  return vec4(c * light, light);
}

vec4 aurora(vec2 p, vec2 mouse, float t) {
  vec4 sum = vec4(0.0);
  for (int i = 0; i < SHEETS; i++) {
    float s = float(i) / float(max(SHEETS - 1, 1));
    vec2 q = p * vec2(1.0 - s * 0.25, 1.0);
    q.x += s * 2.3;
    vec2 m = mouse * vec2(1.0 - s * 0.25, 1.0);
    m.x += s * 2.3;
    sum += sheet(q, s, m, t + s * 40.0) * (1.0 - s * 0.32);
  }
  return sum;
}

float ridge(float x, float seed) {
  return 0.5 * vnoise(vec2(x * 1.3 + seed, seed)) + 0.28 * vnoise(vec2(x * 3.1 + seed, seed * 2.0)) + 0.12 * vnoise(vec2(x * 8.0, seed * 3.0));
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 uv = vUv;
  float horizon = 0.235;

  // A soft view shift with the pointer: the sky is far, the ridges near.
  vec2 par = (uMouse - 0.5) * uStrength;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 mouse = vec2(uMouse.x * aspect, uMouse.y);

  // Reflection: below the horizon we look up at the same sky, shaken by small waves.
  float isWater = step(uv.y, horizon);
  float depth = (horizon - uv.y) / horizon;
  vec2 wob = vec2(
    gnoise(vec2(p.x * 7.0, uv.y * 70.0 / (0.25 + depth) - uTime * 0.5)),
    gnoise(vec2(p.x * 3.0, uv.y * 48.0 / (0.25 + depth) + uTime * 0.4))
  ) * (0.014 + depth * 0.03);
  vec2 sky = isWater > 0.5 ? vec2(p.x + wob.x, horizon + (horizon - uv.y) * 1.25 + wob.y) : p;

  vec4 light = aurora(sky + vec2(par.x * 0.03, par.y * 0.012), mouse, uTime);

  // ── night ──
  vec3 night = mix(vec3(0.01, 0.022, 0.07), vec3(0.003, 0.006, 0.03), smoothstep(0.1, 1.0, sky.y));
  vec2 g = sky * 130.0;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float star = step(0.986, hash21(id)) * smoothstep(0.22, 0.0, length(f));
  star *= 0.55 + 0.45 * sin(uTime * (0.6 + hash21(id + 3.0) * 1.3) + hash21(id) * 40.0);
  night += vec3(0.82, 0.88, 1.0) * star * smoothstep(horizon, 0.5, sky.y);
  night += light.rgb * 0.92;
  night += vec3(0.02, 0.11, 0.12) * exp(-(sky.y - horizon) * 5.0);

  // ── dawn: the same silk, as a pale wash ──
  vec3 dawn = mix(vec3(0.97, 0.87, 0.86), vec3(0.72, 0.84, 0.98), smoothstep(0.2, 1.0, sky.y));
  float wash = 1.0 - exp(-light.a * 1.15);
  vec3 tint = mix(vec3(0.62, 0.95, 0.82), vec3(0.76, 0.66, 0.99), smoothstep(0.34, 0.86, sky.y));
  dawn = mix(dawn, tint, wash * 0.85);
  dawn += light.rgb * 0.09;

  vec3 col = mix(dawn, night, uDark);

  // Lake: darker water, the sky's light on it.
  if (isWater > 0.5) {
    float fres = mix(0.72, 0.34, depth);
    vec3 waterTone = mix(vec3(0.56, 0.68, 0.78), vec3(0.003, 0.012, 0.03), uDark);
    col = mix(waterTone, col, fres);
    float sparkle = pow(max(0.0, gnoise(vec2(p.x * 26.0, uv.y * 190.0 + uTime * 0.7))), 3.0) * 4.0;
    col += mix(vec3(0.12), light.rgb * 0.5, uDark) * sparkle * (1.0 - depth * 0.6);
  }

  // Ridges in front of the sky: two layers, the near one moves more with the pointer.
  float rx = p.x + par.x * 0.05;
  float r1 = horizon + ridge(rx * 0.9, 1.7) * 0.13;
  float r2 = horizon + ridge(rx * 1.5 + par.x * 0.05, 9.3) * 0.075;
  vec3 far = mix(vec3(0.60, 0.65, 0.74), vec3(0.018, 0.04, 0.085), uDark);
  vec3 near = mix(vec3(0.40, 0.46, 0.56), vec3(0.006, 0.014, 0.034), uDark);
  if (uv.y > horizon) {
    col = mix(col, far, smoothstep(r1 + 0.0016, r1 - 0.0016, uv.y));
    col = mix(col, near, smoothstep(r2 + 0.0014, r2 - 0.0014, uv.y));
  } else {
    float my = horizon + (horizon - uv.y) * 1.25;
    float wr1 = horizon + ridge((rx + wob.x) * 0.9, 1.7) * 0.13;
    float wr2 = horizon + ridge((rx + wob.x) * 1.5, 9.3) * 0.075;
    col = mix(col, far * 0.9, 0.82 * smoothstep(wr1 + 0.002, wr1 - 0.002, my));
    col = mix(col, near * 0.8, 0.86 * smoothstep(wr2 + 0.002, wr2 - 0.002, my));
  }

  // Soft dither against banding in the long gradients.
  col += (hash21(uv * uRes + uTime) - 0.5) / 180.0;
  outColor = vec4(col, 1.0);
}`;

const factory: WorldFactory = (env) => {
  const world = fragmentWorld(env, FRAGMENT(tierDefines(env)));
  world.pixels = 0.62;
  return world;
};

export default factory;
