import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * D02 Parallax Depth, I02 Cinematic Workspace. Five ranges of hills in mist, drawn analytically from far to near. Each layer shifts by its own depth with the pointer
 * and the native scroll, so the separation is real parallax. The far ranges take the colour of the air and the near ones become silhouettes (atmospheric perspective, not bands of one hue). The mist parts
 * around the pointer and closes behind it; a press sends a ring through it. The sun follows the pointer a little and rims what stands against it. The cinematic variant adds a low sun, anamorphic streak and
 * film grain, stars in the dark appearance, and pushes the camera in on a route change.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
uniform float uCinema;
float ridge(float x, float seed) {
  return fbm5(vec2(x * (0.9 + seed * 0.4) + seed * 11.0, seed * 3.7)) ;
}
void main() {
  float a = uCss.x / uCss.y;
  vec2 m = (uMouse - 0.5) * uStrength;
  float zoom = 1.0 - uRoute * 0.12 * uCinema;
  vec2 uv = (vUv - 0.5) * zoom + 0.5;
  vec3 sky = mix(mix(uC1, uC2, 0.22), uC0, smoothstep(0.18, 1.0, uv.y));
  vec2 sunAt = vec2(0.68 + m.x * 0.1, 0.6 + uScroll * 0.28 + m.y * 0.08);
  vec2 star = uv * vec2(a, 1.0) * 90.0;
  float tw = step(0.985, hash21(floor(star))) * smoothstep(0.3, 0.0, length(fract(star) - 0.5)) * (0.6 + 0.4 * sin(uTime * 1.3 + hash21(floor(star)) * 40.0));
  sky += vec3(1.0, 0.96, 0.9) * tw * uDark * smoothstep(0.4, 0.9, uv.y) * 0.5;
  float sd = length((uv - sunAt) * vec2(a, 1.0));
  sky += uC3 * (exp(-sd * 11.0) * 0.8 + exp(-sd * 2.8) * 0.3);
  vec3 col = sky;
  // Where the hand passes the air clears, and a press rings through it.
  vec2 handD = (uv - uMouse) * vec2(a, 1.0);
  float clear = exp(-dot(handD, handD) * 9.0) * uStrength;
  float pulse = pressWave(uv);
  for (int i = 0; i < 5; i++) {
    float d = float(i) / 4.0;              // 0 far, 1 near
    float shift = (0.015 + d * d * 0.14) * uDepth * 1.6;
    float x = (uv.x + m.x * shift) * a + uTime * 0.002 * (1.0 + d * 2.0);
    float base = 0.62 - d * 0.56 + (uScroll - 0.5) * shift * 2.6 + m.y * shift * 0.4;
    float h = base + (ridge(x * (1.4 + d * 1.2), float(i)) - 0.5) * (0.26 + d * 0.28);
    float edge = fwidth(uv.y) * (1.2 + d * 6.0);
    float mask = 1.0 - smoothstep(h - edge, h + edge, uv.y);
    // Far ranges are nearly the colour of the air; each nearer one is darker, down to a silhouette.
    vec3 air = mix(sky, uC3, 0.12);
    vec3 near = mix(mix(uC1, uC0, 0.55), uC0 * 0.32, uDark);
    vec3 tone = mix(air, near, pow(d, 0.72));
    tone *= 0.94 + 0.12 * fbm3(vec2(x * 7.0, uv.y * 30.0 * (0.4 + d)));
    // mist gathers at the foot of each range, drifts, and gives way to the pointer
    float drift = fbm3(vec2(x * 2.4 + uTime * 0.02 * (1.0 + d), uv.y * 7.0 + float(i) * 3.0));
    float mist = (1.0 - smoothstep(h - 0.3, h - 0.02, uv.y)) * (0.45 + 0.75 * drift);
    mist *= 1.0 - clear * (0.45 + d * 0.5);
    mist = clamp(mist + abs(pulse) * 0.18 * (1.0 - d * 0.6), 0.0, 1.0);
    tone = mix(tone, mix(sky, uC3, 0.14), (1.0 - d * 0.62) * 0.74 * mist);
    // the sun rims the near ridges
    tone += uC3 * smoothstep(h - 0.012, h, uv.y) * exp(-sd * 2.4) * 0.5 * d;
    col = mix(col, tone, mask);
  }
  if (uCinema > 0.5) {
    float streak = exp(-abs(uv.y - sunAt.y) * 90.0) * exp(-abs(uv.x - sunAt.x) * 2.0);
    col += uC3 * streak * 0.55;
    float grain = (hash21(vUv * uRes + fract(uTime) * 311.0) - 0.5) * 0.028;
    col += grain;
    float vig = smoothstep(1.25, 0.35, length((vUv - 0.5) * vec2(1.25, 1.1)));
    col *= mix(0.86, 1.0, vig);
  }
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, opts, palette) =>
  fragmentSpatial(env, bridge, palette, FS, {
    before(gl, p) {
      gl.uniform1f(p.u('uCinema'), Number(opts.cinema ?? 0));
    },
    slabs: 0.85,
    rings: true,
  });
export default make;
