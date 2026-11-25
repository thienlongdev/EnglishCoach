import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * I01 Echo Spatial Glass. Looking down into a sunlit sea: an iterated caustic network on the sea floor, with the water's colour, and bending under the pointer. The panels on top are real glass, so the
 * caustics are visible moving through them, and they are the same material the landing page's water uses in spirit, in the product's own ocean colours.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
float caustic(vec2 p, float t) {
  vec2 q = mod(p * 6.28318, 6.28318) - 250.0;
  vec2 i = q;
  float c = 1.0;
  for (int n = 0; n < 5; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = q + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(q.x / (sin(i.x + tt) / 0.005), q.y / (cos(i.y + tt) / 0.005)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
void main() {
  float a = uCss.x / uCss.y;
  vec2 p = vec2(vUv.x * a, vUv.y + uScroll * 0.6);
  vec2 m = vec2(uMouse.x * a, uMouse.y + uScroll * 0.6);
  vec2 d = p - m;
  float bend = exp(-dot(d, d) * 16.0) * uStrength * (0.04 + uEnergy * 0.12);
  float wave = pressWave(vUv);
  p += normalize(d + 1e-4) * (bend + wave * 0.05);
  float t = uTime * 0.32;
  float big = caustic(p * 0.72, t);
  float small = caustic(p * 1.6 + 0.3, t * 1.3);
  vec3 sea = mix(uC0, uC1, 0.5 + 0.35 * fbm3(p * 1.2 + uTime * 0.02));
  vec3 col = sea + mix(uC2, uC3, 0.6) * (big * 0.95 + small * 0.35) * mix(0.72, 1.0, uDark);
  // the sun's shafts, and depth toward the corners
  float shaft = fbm2(vec2(p.x * 3.0 + p.y * 1.2, uTime * 0.06));
  col += uC3 * smoothstep(0.5, 0.95, shaft) * 0.09 * smoothstep(0.0, 1.0, vUv.y);
  col += mix(uC3, vec3(1.0), 0.4) * max(wave, 0.0) * 0.3;
  float vig = smoothstep(1.2, 0.3, length((vUv - 0.5) * vec2(1.2, 1.1)));
  col = mix(mix(col, uC0, 0.42), col, vig);
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => fragmentSpatial(env, bridge, palette, FS, { slabs: 0.85, pixels: 0.8, rings: true });
export default make;
