import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * H06 Spatial Highlights. A theatre: a dark house with dust in the air and one real beam, aimed from above at the card under the pointer, which it follows with the weight of a heavy lamp. Where there is
 * no card under the pointer it rests on the pointer itself. The dust is only visible inside the beam, which is what makes it read as volume.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
uniform vec2 uAim;
uniform float uPower;
float cone(vec2 uv, vec2 from, vec2 to, float spreadNear, float spreadFar) {
  vec2 ab = to - from;
  float h = dot(uv - from, ab) / dot(ab, ab);
  float along = clamp(h, 0.0, 1.35);
  float radius = mix(spreadNear, spreadFar, along);
  float d = length(uv - from - ab * along);
  return exp(-pow(d / radius, 2.0) * 1.6) * smoothstep(0.0, 0.2, h);
}
void main() {
  float a = uCss.x / uCss.y;
  vec2 uv = vec2(vUv.x * a, vUv.y);
  vec2 aim = vec2(uAim.x * a, uAim.y);
  vec2 lamp = vec2(aim.x * 0.5 + a * 0.25, 1.28);
  vec3 col = mix(uC0, uC1, 0.12 + 0.14 * (1.0 - vUv.y));
  float beam = cone(uv, lamp, aim, 0.028, 0.2) * uPower;
  float n = fbm2(uv * 2.2 + vec2(uTime * 0.02, -uTime * 0.03));
  vec2 speck = uv * 70.0 + vec2(uTime * 0.25, uTime * 0.14);
  vec2 cell = fract(speck) - 0.5;
  float dust = smoothstep(0.1, 0.0, length(cell + (hash22(floor(speck)) - 0.5) * 0.7)) * step(0.82, hash21(floor(speck)));
  vec3 warm = mix(uC3, vec3(1.0, 0.94, 0.82), 0.4);
  col += warm * beam * (0.34 + 0.08 * n + dust * 0.9) * mix(0.8, 1.0, uDark);
  // the pool of light where it lands
  vec2 l = (uv - aim) * vec2(0.7, 1.4);
  col += warm * exp(-dot(l, l) * 7.0) * 0.34 * uPower;
  // the second, cold house light, far away
  float back = cone(uv, vec2(a * 0.86, 1.2), vec2(a * 0.62, -0.1), 0.02, 0.26);
  col += uC2 * back * 0.1;
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => {
  const lamp = { x: 0.55, y: 0.5, vx: 0, vy: 0, power: 0.55 };
  return fragmentSpatial(env, bridge, palette, FS, {
    before(gl, p, t, dt) {
      const pt = env.pointer;
      const onCard = bridge.hoverAmount > 0.05;
      const tx = onCard ? bridge.hoverX / Math.max(1, env.cssWidth) : pt.strength > 0.01 ? pt.su : 0.55 + 0.25 * Math.sin(t * 0.1);
      const ty = onCard ? 1 - bridge.hoverY / Math.max(1, env.cssHeight) : pt.strength > 0.01 ? pt.sv : 0.45 + 0.2 * Math.cos(t * 0.14);
      lamp.vx += ((tx - lamp.x) * 16 - lamp.vx * 6.5) * dt;
      lamp.vy += ((ty - lamp.y) * 16 - lamp.vy * 6.5) * dt;
      lamp.x += lamp.vx * dt;
      lamp.y += lamp.vy * dt;
      lamp.power += ((onCard ? 1 : 0.62) - lamp.power) * Math.min(1, dt * 3);
      gl.uniform2f(p.u('uAim'), lamp.x, lamp.y);
      gl.uniform1f(p.u('uPower'), lamp.power);
    },
    slabs: 1,
    pixels: 0.8,
  });
};
export default make;
