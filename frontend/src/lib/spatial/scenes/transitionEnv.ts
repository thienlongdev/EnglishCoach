import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * Category E. Each transition preset has its own small world behind the content that takes part in the route change (uRoute rises to 1 and decays, uRouteAt is where it started). Between
 * changes it is a slow picture that answers the hand in its own way:
 *  0 morph: drops of liquid that merge, part around the pointer and gather where the press happened · 1 panel: a wall of panels that open toward the pointer, a press unfolds them in a ring
 *  2 portal: a ring tunnel whose mouth follows and leans to the pointer, faster with its speed · 3 fluid: a liquid horizon that swells under the pointer and carries a press as a wave
 *  4 flip: slats that turn over as the pointer passes · 5 zoom: a star tunnel steered by the pointer, accelerated by its speed
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
uniform float uKind;
vec3 sky(vec2 uv) { return mix(uC0, uC1, smoothstep(-0.1, 1.2, uv.y) * 0.62); }

vec3 orbs(vec2 uv, float a) {
  vec3 col = sky(uv);
  vec2 focus = uRouteAt;
  vec2 q = uv * vec2(a, 1.0);
  vec2 hand = uMouse * vec2(a, 1.0);
  // a metaball field: where two drops come close they flow into one
  float field = 0.0;
  vec2 grad = vec2(0.0);
  float tint = 0.0;
  for (int i = 0; i < 9; i++) {
    float k = float(i);
    vec2 c = vec2(0.5 + 0.46 * sin(uTime * 0.09 * (1.0 + k * 0.13) + k * 2.4), 0.5 + 0.42 * cos(uTime * 0.07 * (1.0 + k * 0.17) + k * 1.3));
    c = mix(c, focus, uRoute * 0.7) * vec2(a, 1.0);
    vec2 away = c - hand;
    c += normalize(away + 1e-4) * exp(-dot(away, away) * 11.0) * 0.17 * uStrength;
    float r = 0.1 + 0.05 * sin(k * 3.7) + uRoute * 0.05;
    vec2 v = q - c;
    float f = r * r / (dot(v, v) + 1e-4);
    field += f;
    grad += -v * f;
    tint += f * fract(k * 0.37);
  }
  // the pointer itself is a small drop that the others flow toward when they touch it
  vec2 h = q - hand;
  float hf = 0.0028 * uStrength / (dot(h, h) + 1e-4);
  field += hf;
  grad += -h * hf;
  float wave = pressWave(uv);
  field += wave * 0.5;
  float body = smoothstep(0.92, 1.08, field);
  vec3 n = normalize(vec3(grad * 0.5 / max(field, 0.2), 1.0));
  vec3 tone = mix(uC2, uC3, clamp(tint / max(field, 0.01), 0.0, 1.0));
  vec3 lit = tone * (0.5 + 0.5 * n.z) * 0.62 + uC0 * 0.3;
  vec3 l = normalize(vec3((uMouse - uv) * vec2(a, 1.0), 0.6));
  lit += vec3(1.0) * pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 40.0) * 0.5;
  col = mix(col, lit, body * 0.82);
  col += tone * smoothstep(0.86, 1.0, field) * (1.0 - smoothstep(1.0, 1.2, field)) * 0.5;
  return col;
}
vec3 panels(vec2 uv, float a) {
  vec2 q = vec2(uv.x * a, uv.y) * 6.0;
  vec2 id = floor(q), f = fract(q) - 0.5;
  float rnd = hash21(id);
  float d = length((id + 0.5) / 6.0 - vec2(uRouteAt.x * a, uRouteAt.y));
  float wave = exp(-pow(d - (1.0 - uRoute) * 1.6, 2.0) * 22.0) * uRoute;
  float tilt = sin(uTime * 0.18 + rnd * 7.0) * 0.5 + 0.5;
  // Panels open toward the pointer, and a press unfolds them in a travelling ring.
  float reach = length((id + 0.5) / 6.0 - vec2(uMouse.x * a, uMouse.y));
  wave += exp(-reach * reach * 22.0) * uStrength * 0.9 + max(pressWave((id + 0.5) / 6.0 / vec2(a, 1.0)), 0.0) * 1.2;
  float open = 0.2 + 0.3 * tilt + wave * 0.9;
  vec2 sf = f * vec2(1.0 / clamp(1.0 - open * 0.5, 0.2, 1.0), 1.0);
  float box = step(max(abs(sf.x), abs(sf.y)), 0.46);
  float shade = 0.55 + 0.45 * (sf.x * (rnd - 0.5) * 2.0 + 0.5);
  vec3 col = sky(uv);
  col = mix(col, mix(uC1, uC2, 0.2 + wave * 0.7 + tilt * 0.2) * shade, box);
  col += uC3 * box * wave * 0.5;
  return col;
}
vec3 portal(vec2 uv, float a) {
  // The mouth of the tunnel follows the pointer on a lag, and the far end leans the other way: you look down a bent throat.
  vec2 mouth = mix(mix(vec2(0.5), uRouteAt, uRoute), uMouse, 0.75 * uStrength * (1.0 - uRoute));
  vec2 p = (uv - mouth) * vec2(a, 1.0);
  p += uVel * 0.02 * uStrength / max(length(p) + 0.25, 0.1);
  float r = length(p);
  float ang = atan(p.y, p.x);
  float z = 0.35 / max(r, 0.02) + uTime * 0.14 + uRoute * 1.2 + uEnergy * uTime * 0.05;
  float rings = smoothstep(0.84, 1.0, sin(z * 8.0));
  float rays = 0.5 + 0.5 * sin(ang * 12.0 + z * 2.0);
  vec3 col = sky(uv);
  col = mix(col, uC1, smoothstep(1.2, 0.0, r) * 0.7);
  col += mix(uC2, uC3, rays) * rings * smoothstep(0.02, 0.4, r) * exp(-r * 1.4) * (0.55 + 1.2 * uRoute);
  col += uC3 * exp(-r * 8.0) * 0.5;
  col += mix(uC2, uC3, 0.5) * max(pressWave(uv), 0.0) * 0.5;
  return col;
}
vec3 liquid(vec2 uv, float a) {
  vec2 q = vec2(uv.x * a, uv.y);
  vec3 col = sky(uv);
  for (int i = 0; i < 4; i++) {
    float k = float(i);
    float level = 0.15 + k * 0.17 + uRoute * 0.62 * (1.0 - k * 0.15);
    float wob = (fbm3(vec2(q.x * (1.4 + k * 0.5), uTime * 0.11 + k * 3.0)) - 0.5) * (0.22 + uRoute * 0.3);
    // the surface swells under the pointer and a press runs along it as a wave, nearest layer most
    float dx = (uv.x - uMouse.x) * a;
    float depth = 1.0 - k * 0.2;
    wob += exp(-dx * dx * 26.0) * exp(-pow(uv.y - uMouse.y, 2.0) * 8.0) * (0.03 + uEnergy * 0.16) * uStrength * depth;
    wob += pressWave(vec2(uv.x, level + wob)) * 0.05 * depth;
    float m = smoothstep(level + wob + 0.004, level + wob - 0.004, uv.y);
    vec3 tone = mix(mix(uC1, uC2, 0.25 + k * 0.15), uC0, 0.34 - k * 0.08);
    col = mix(col, tone, m * 0.9);
    col += uC3 * smoothstep(0.012, 0.0, abs(uv.y - level - wob)) * 0.42;
  }
  return col;
}
vec3 slats(vec2 uv, float a) {
  float q = uv.x * a * 16.0;
  float id = floor(q), f = fract(q) - 0.5;
  float rnd = hash11(id);
  float angle = sin(uTime * 0.13 + id * 0.26) * 0.9 + uRoute * 3.14159 * (1.0 + sin(id * 0.4) * 0.2);
  // Slats turn over as the pointer passes: the soft position lags the sharp one, so a sweep leaves a wake of turned slats.
  float at = (id + 0.5) / 16.0 / a;
  angle += exp(-pow((at - uMouse.x) * a, 2.0) * 90.0) * (0.8 + uEnergy * 3.0) * uStrength;
  angle += exp(-pow((at - uMouseNow.x) * a, 2.0) * 120.0) * 1.2 * uEnergy;
  angle += pressWave(vec2(at, uv.y)) * 2.4;
  float c = cos(angle), w = abs(c);
  float body = step(abs(f), 0.5 * w * 0.94);
  float light = (c > 0.0 ? 0.6 : 0.34) + 0.5 * sin(angle + 0.8) * 0.5;
  vec3 tone = mix(uC1, uC2, rnd * 0.35 + light * 0.4);
  vec3 col = sky(uv);
  col = mix(col, tone, body * (0.5 + 0.08 * sin(uv.y * 8.0)));
  col += uC3 * body * pow(light, 4.0) * 0.14;
  return col;
}
vec3 stars(vec2 uv, float a) {
  // You steer: the vanishing point follows the pointer. Speed is what the pointer's own speed gives.
  vec2 aim = mix(mix(vec2(0.5), uRouteAt, uRoute), uMouse, 0.8 * uStrength * (1.0 - uRoute));
  vec2 p = (uv - aim) * vec2(a, 1.0);
  vec3 col = sky(uv) * 0.9;
  float speed = 0.05 + uRoute * 1.1 + uEnergy * 0.55;
  for (int i = 0; i < 4; i++) {
    float layer = fract(float(i) / 4.0 + uTime * 0.04 + uRoute * 0.5 + uEnergy * uTime * 0.012);
    float s = mix(14.0, 2.0, layer);
    float fade = smoothstep(0.0, 0.3, layer) * smoothstep(1.0, 0.8, layer);
    vec2 q = p * s + float(i) * 7.3;
    vec2 id = floor(q), f = fract(q) - 0.5;
    vec2 o = (hash22(id) - 0.5) * 0.7;
    vec2 d = f - o;
    vec2 radial = normalize(p + 1e-4);
    float along = dot(d, radial);
    float across = dot(d, vec2(-radial.y, radial.x));
    float streak = exp(-across * across * 2200.0) * exp(-along * along / (0.0006 + speed * speed * 0.05));
    col += mix(uC3, vec3(1.0), 0.4) * streak * fade * step(0.62, hash21(id + 3.0)) * (0.8 + uRoute);
  }
  col += uC2 * exp(-length(p) * 3.6) * (0.16 + uRoute * 0.5);
  return col;
}
void main() {
  float a = uCss.x / uCss.y;
  vec3 col;
  int k = int(uKind + 0.5);
  if (k == 0) col = orbs(vUv, a);
  else if (k == 1) col = panels(vUv, a);
  else if (k == 2) col = portal(vUv, a);
  else if (k == 3) col = liquid(vUv, a);
  else if (k == 4) col = slats(vUv, a);
  else col = stars(vUv, a);
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, opts, palette) =>
  fragmentSpatial(env, bridge, palette, FS, {
    before(gl, p) {
      gl.uniform1f(p.u('uKind'), Number(opts.kind ?? 0));
    },
    slabs: 1,
    rings: true,
  });
export default make;
