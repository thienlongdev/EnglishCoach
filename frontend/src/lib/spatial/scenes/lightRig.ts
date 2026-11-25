import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * G05 Interactive Light Rig. A relief wall lit by three coloured spots. Normals come from the height of a procedural panel relief, so light rakes across its grooves. The key light follows the
 * pointer with weight, the two others orbit; the wall around each real card picks up the light. Light is a little grainy, as a real wall would be.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
float relief(vec2 q) {
  vec2 g = fract(q * vec2(3.2, 5.0)) - 0.5;
  float id = hash21(floor(q * vec2(3.2, 5.0)));
  float panel = smoothstep(0.5, 0.42, max(abs(g.x), abs(g.y)));
  float flute = sin(q.x * 44.0 + id * 9.0) * 0.5 + 0.5;
  float swirl = fbm3(q * 2.2 + id * 3.0);
  return panel * (0.5 + 0.16 * id + mix(0.0, flute * 0.05, step(0.55, id)) + swirl * 0.1);
}
vec3 spot(vec3 p, vec3 n, vec3 v, vec3 light, vec3 color, float range) {
  vec3 l = light - p;
  float d2 = dot(l, l);
  l /= sqrt(d2);
  float att = range / (d2 + range);
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 26.0);
  return color * att * (diff + spec * 0.7);
}
void main() {
  float a = uCss.x / uCss.y;
  vec2 q = vec2(vUv.x * a, vUv.y + uScroll * 0.9);
  float e = 0.0016;
  float h0 = relief(q);
  float hx = relief(q + vec2(e, 0.0));
  float hy = relief(q + vec2(0.0, e));
  vec3 n = normalize(vec3(-(hx - h0) / e * 0.09, -(hy - h0) / e * 0.09, 1.0));
  // a press knocks the wall: the ring is relief for a moment, so the lights rake it
  float ek = 0.004;
  n = normalize(n + vec3(-(pressWave(vUv + vec2(ek, 0.0)) - pressWave(vUv - vec2(ek, 0.0))), -(pressWave(vUv + vec2(0.0, ek)) - pressWave(vUv - vec2(0.0, ek))), 0.0) * 1.6);
  vec3 p = vec3(q, h0 * 0.08);
  vec3 v = normalize(vec3(a * 0.5, 0.5 + uScroll * 0.9, 1.6) - p);
  vec2 key = vec2(uMouse.x * a, uMouse.y + uScroll * 0.9);
  if (uStrength < 0.01) key = vec2(a * (0.5 + 0.34 * sin(uTime * 0.2)), 0.5 + uScroll * 0.9 + 0.3 * cos(uTime * 0.16));
  vec2 k2 = vec2(a * (0.5 + 0.45 * cos(uTime * 0.13)), 0.5 + uScroll * 0.9 + 0.42 * sin(uTime * 0.11));
  vec2 k3 = vec2(a * (0.5 - 0.42 * sin(uTime * 0.09 + 1.0)), 0.5 + uScroll * 0.9 + 0.4 * cos(uTime * 0.14 + 2.0));
  vec3 albedo = mix(mix(uC0, uC1, 0.6), uC1, h0 * 0.8);
  vec3 col = albedo * mix(0.42, 0.14, uDark);
  float gain = mix(0.9, 1.25, uDark);
  col += (albedo + 0.2) * 1.9 * spot(p, n, v, vec3(key, 0.26), mix(uC3, vec3(1.0), 0.3), 0.1) * gain;
  col += (albedo + 0.16) * 1.5 * spot(p, n, v, vec3(k2, 0.3), uC2, 0.12) * gain;
  col += (albedo + 0.16) * 1.4 * spot(p, n, v, vec3(k3, 0.32), mix(uC2, uC3, 0.5), 0.1) * gain;
  col += (hash21(vUv * uRes) - 0.5) * 0.018;
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => fragmentSpatial(env, bridge, palette, FS, { slabs: 0.9, pixels: 0.8, rings: true });
export default make;
