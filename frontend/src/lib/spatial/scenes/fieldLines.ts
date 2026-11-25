import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * G01 Magnetic Cursor Field. Field lines of a dipole between the pointer and a fixed pole, drawn as iso-lines of the stream function, which is why they stay whole and never break. The
 * DOM cards add their own charge through the card texture, so the lines bend around the real interface. Moving dust shows the direction of the flow.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
void main() {
  float a = uCss.x / uCss.y;
  vec2 p = vec2(vUv.x * a, vUv.y);
  vec2 m = vec2(uMouse.x * a, uMouse.y);
  if (uStrength < 0.01) m = vec2(a * (0.5 + 0.3 * sin(uTime * 0.11)), 0.55 + 0.25 * cos(uTime * 0.13));
  vec2 other = vec2(a * (0.5 + 0.34 * cos(uTime * 0.07)), 0.5 + 0.34 * sin(uTime * 0.09));
  float psi = atan(p.y - m.y, p.x - m.x) - atan(p.y - other.y, p.x - other.x);
  float pot = log(length(p - m) + 0.02) - log(length(p - other) + 0.02);
  float card = cardField(vUv);
  float pulse = pressWave(vUv);
  psi += card * 1.6 + fbm2(p * 2.0 + uTime * 0.03) * 0.3 + pulse * 0.5;
  float dens = 18.0;
  float v = psi * dens / 6.28318;
  float line = 1.0 - smoothstep(0.0, 1.5, abs(fract(v) - 0.5) / max(fwidth(v), 1e-4));
  float major = 1.0 - smoothstep(0.0, 1.8, abs(fract(v * 0.25) - 0.5) / max(fwidth(v * 0.25), 1e-4));
  float near = exp(-length(p - m) * 3.2);
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 1.3, vUv.y) * 0.5);
  vec3 ink = mix(uC2, uC3, clamp(near * 1.6 + 0.2 * sin(pot * 2.0), 0.0, 1.0));
  col = mix(col, ink, line * (0.2 + 0.6 * near + 0.12 * uDark));
  col = mix(col, ink, major * (0.26 + 0.5 * near));
  // beads of light travelling along the lines
  float beads = smoothstep(0.86, 1.0, sin(pot * 16.0 - uTime * 1.6 + floor(v) * 2.0)) * line;
  col += uC3 * beads * (0.5 + 0.8 * near);
  col += uC3 * exp(-length(p - m) * 15.0) * (0.3 + 0.7 * uStrength);
  col += uC2 * exp(-length(p - other) * 18.0) * 0.5;
  col += uC3 * max(pulse, 0.0) * line * 0.7;
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => fragmentSpatial(env, bridge, palette, FS, { slabs: 0.9, rings: true });
export default make;
