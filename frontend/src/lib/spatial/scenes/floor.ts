import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * H01 Spatial Cards. The cards stand over a real ground: a lit floor in perspective with a tile grid and a soft bounce. Each card's slab (its thickness, its shadow, drawn around the HTML by the kit)
 * lands on it, and the floor brightens beneath the hovered card. The picture's point is to make the eye read the cards as objects. The tile under the pointer lights up with its neighbours, and a press
 * shakes the floor in a ring that travels through the grid.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
void main() {
  float a = uCss.x / uCss.y;
  vec2 uv = vUv;
  float horizon = 0.84 + (uMouse.y - 0.5) * 0.02 * uStrength;
  vec3 col;
  if (uv.y < horizon) {
    float y = (horizon - uv.y);
    float z = 2.6 / max(y, 0.02);
    vec2 g = vec2((uv.x - 0.5 + (uMouse.x - 0.5) * 0.015 * uStrength) * a * z, z + uScroll * 3.5);
    float shake = pressWave(uv);
    g += g * shake * 0.018;
    vec2 w = fwidth(g);
    vec2 d = abs(fract(g * 0.5) - 0.5) / max(w * 0.5, 1e-4);
    float line = (1.0 - min(min(d.x, d.y) * 0.9, 1.0)) * smoothstep(0.015, 0.12, y);
    vec3 ground = mix(uC1, uC0, smoothstep(0.0, 0.9, y));
    ground = mix(ground, uC0, smoothstep(0.1, 0.0, y) * 0.0);
    col = mix(ground, uC2, line * (0.5 * smoothstep(0.0, 0.5, y) + 0.1));
    // the tile the pointer stands on, in the floor's own coordinates
    float hy = max(horizon - uMouseNow.y, 0.02);
    vec2 hg = vec2((uMouseNow.x - 0.5 + (uMouse.x - 0.5) * 0.015 * uStrength) * a * (2.6 / hy), 2.6 / hy + uScroll * 3.5);
    vec2 cell = floor(g * 0.5), hcell = floor(hg * 0.5);
    float reach = length(cell - hcell);
    float lift = exp(-reach * reach * 0.34) * uStrength * step(uMouseNow.y, horizon);
    col = mix(col, mix(uC2, uC3, 0.35), lift * (0.16 + uEnergy * 0.32));
    col += uC3 * max(shake, 0.0) * 0.26;
    // the ground catches the light of the card above it
    float over = texture(uField, uv + vec2(0.0, 0.04)).r;
    col *= 1.0 - over * 0.16;
    float hot = texture(uField, uv + vec2(0.0, 0.04)).g;
    col += uC3 * hot * 0.34;
    col = mix(col, mix(uC1, uC0, 0.3), smoothstep(0.1, 0.0, y));
  } else {
    float t = (uv.y - horizon) / (1.0 - horizon);
    col = mix(mix(uC1, uC3, 0.14), uC0, smoothstep(0.0, 1.0, t));
  }
  // a soft top light
  vec2 l = (uv - vec2(0.5, 1.15)) * vec2(a * 0.7, 1.0);
  col += uC2 * exp(-dot(l, l) * 1.4) * 0.14;
  vec2 m = (uv - uMouse) * vec2(a, 1.0);
  col += uC3 * exp(-dot(m, m) * 7.0) * 0.1 * uStrength;
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => fragmentSpatial(env, bridge, palette, FS, { slabs: 1.3, rings: true });
export default make;
