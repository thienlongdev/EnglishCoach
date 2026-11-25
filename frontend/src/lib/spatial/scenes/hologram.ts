import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * H05 Holographic Surface. A volume of light: receding grid walls and scanlines, the look of a projected image. From the card under the pointer a beam rises into that volume (the card's real position
 * from the engine), and the grid bends and shines around it. The foil on the cards themselves is the `holo` sheen.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
float grid(vec2 q, float w) {
  vec2 d = abs(fract(q) - 0.5) / max(fwidth(q), 1e-4);
  return 1.0 - min(min(d.x, d.y) / w, 1.0);
}
void main() {
  float a = uCss.x / uCss.y;
  vec2 p = (vUv - 0.5) * vec2(a, 1.0);
  // the projected room is light, so a hand in it bends it; a press sends a ripple through the projection
  vec2 hand = (uMouse - 0.5) * vec2(a, 1.0);
  vec2 off = p - hand;
  p += off * exp(-dot(off, off) * 16.0) * (0.24 + uEnergy * 0.5) * uStrength;
  float ripple = pressWave(vUv);
  p += normalize(off + 1e-4) * ripple * 0.03;
  vec3 col = mix(uC0, uC1, 0.15 + 0.2 * vUv.y);
  // a room in perspective seen from inside: four walls of a square tunnel
  float m = max(abs(p.x) / a * 1.1, abs(p.y));
  float depth = 0.22 / max(m, 0.03);
  vec2 wall = abs(p.x) / a * 1.1 > abs(p.y) ? vec2(p.y / m, depth + uScroll * 3.0 + uTime * 0.03) : vec2(p.x / m, depth + uScroll * 3.0 + uTime * 0.03);
  float fade = smoothstep(0.02, 0.5, m);
  float g = grid(wall * vec2(4.0, 1.4), 1.3);
  float major = grid(wall * vec2(1.0, 0.35), 1.6);
  vec3 tone = uC2;
  col += tone * g * fade * mix(0.3, 0.56, uDark);
  col += uC3 * major * fade * 0.42;
  // the beam from the hovered card up into the room
  vec2 h = vec2(uHover.x, uHover.y);
  vec2 q = (vUv - h) * vec2(a, 1.0);
  float spread = 0.1 + max(q.y, 0.0) * 0.34;
  float beam = exp(-pow(q.x / spread, 2.0)) * smoothstep(-0.02, 0.05, q.y) * exp(-max(q.y, 0.0) * 1.4) * uHover.z;
  col += mix(uC3, vec3(1.0), 0.2) * max(ripple, 0.0) * 0.4;
  col += uC3 * exp(-dot(off, off) * 40.0) * 0.16 * uStrength;
  float scan = 0.72 + 0.28 * sin(vUv.y * uRes.y * 0.45 - uTime * 5.0);
  col += mix(uC3, vec3(1.0), 0.25) * beam * scan * 0.7;
  col += uC3 * (0.5 + 0.5 * sin(vUv.y * uRes.y * 0.9)) * 0.014 * uDark;
  // a slow sweep through the whole volume
  float sweep = exp(-pow(fract(vUv.y - uTime * 0.04) - 0.5, 2.0) * 400.0);
  col += tone * sweep * 0.08;
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => fragmentSpatial(env, bridge, palette, FS, { slabs: 1, rings: true });
export default make;
