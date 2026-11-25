import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * H02 Glass Workspace. Big fields of saturated colour moving slowly behind the content, with no fine detail on purpose: what you see through a panel of frosted glass is meant to be colour, and the
 * panels (real backdrop blur on the solid surfaces, see surfaces.ts) really do show it moving through them. The fields are drawn to the pointer and to the hovered card.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
vec3 field(vec2 p, vec2 c, float r, vec3 tone, vec3 col) {
  float d = length(p - c) / r;
  return mix(col, tone, exp(-d * d * 1.6));
}
void main() {
  float a = uCss.x / uCss.y;
  vec2 p = vec2(vUv.x * a, vUv.y + uScroll * 0.5);
  vec3 col = mix(uC0, uC1, 0.25 + 0.2 * vUv.y);
  float t = uTime * 0.11;
  vec2 pull = vec2(uMouse.x * a, uMouse.y + uScroll * 0.5);
  vec2 hover = vec2(uHover.x * a, uHover.y + uScroll * 0.5);
  float k = uStrength * (0.34 + uEnergy * 0.3);
  // a press stirs the colour outwards
  p += normalize(p - pull + 1e-4) * pressWave(vUv) * 0.1;
  col = field(p, mix(vec2(a * (0.28 + 0.2 * sin(t)), 0.3 + 0.24 * cos(t * 1.3)), pull, k), 0.58, uC2, col);
  col = field(p, mix(vec2(a * (0.74 + 0.18 * cos(t * 0.8)), 0.68 + 0.2 * sin(t * 1.1)), pull, k * 0.6), 0.5, uC3, col);
  col = field(p, vec2(a * (0.52 + 0.3 * sin(t * 0.6 + 2.0)), 0.5 + 0.34 * sin(t * 0.9 + 1.0)), 0.42, mix(uC2, uC1, 0.45), col);
  col = field(p, hover, 0.3 + 0.1 * uHover.z, mix(col, uC3, uHover.z * 0.65), col);
  col += (hash21(vUv * uRes + fract(uTime)) - 0.5) * 0.012;
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => fragmentSpatial(env, bridge, palette, FS, { slabs: 0.7, pixels: 0.5, rings: true });
export default make;
