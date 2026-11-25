import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * H03 Layered Navigation. Sheets of light standing parallel to the sidebar, one behind the other into the page: a real sense that the navigation is the front layer of a stack. Each sheet is lit by its
 * distance to the pointer's height, so moving along the rail runs a soft beam through the whole stack.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
void main() {
  float a = uCss.x / uCss.y;
  vec3 col = mix(uC0, uC1, 0.18 + 0.2 * vUv.y);
  float x = vUv.x;
  for (int i = 0; i < 9; i++) {
    float k = float(i) / 8.0;
    // perspective spacing: sheets crowd toward the far side
    float at = 0.03 + pow(k, 1.6) * 1.0 + sin(uTime * 0.1 + k * 7.0) * 0.006 + (uMouse.x - 0.5) * 0.02 * uStrength * (1.0 - k);
    // the sheets give way to the pointer like pages of a book, and a press knocks through the stack
    float side = at - uMouse.x;
    at += sign(side) * exp(-side * side * 90.0) * 0.024 * uStrength * (1.0 + uEnergy * 2.0);
    at += pressWave(vec2(at, vUv.y)) * 0.018;
    float width = mix(0.035, 0.008, k);
    float d = (x - at) / width;
    float sheet = exp(-d * d) + (d > 0.0 ? exp(-d * 0.28) * 0.18 : 0.0);
    float y = vUv.y;
    float beam = exp(-pow((y - uMouse.y) * (2.2 + k * 2.0), 2.0)) * uStrength;
    float flow = 0.5 + 0.5 * sin(y * (10.0 + k * 6.0) - uTime * (0.3 + k * 0.1) + k * 13.0);
    vec3 tone = mix(uC2, uC3, k);
    col += tone * sheet * (1.0 - k * 0.55) * (0.08 + 0.06 * flow + 0.5 * beam);
  }
  float vig = smoothstep(1.3, 0.2, length((vUv - vec2(0.2, 0.5)) * vec2(a * 0.6, 1.0)));
  col = mix(col, uC0, (1.0 - vig) * 0.4);
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => fragmentSpatial(env, bridge, palette, FS, { slabs: 0.9, rings: true });
export default make;
