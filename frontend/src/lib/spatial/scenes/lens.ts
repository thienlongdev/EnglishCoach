import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * B04 Interactive Lens. An engineer's blueprint, and a thick glass lens floating over it with real inertia. Inside the lens the drawing is
 * magnified with chromatic aberration by a sphere's refraction; the rim catches the light and throws a soft shadow onto the sheet.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
uniform vec3 uLens;
uniform vec3 uLens2;
float line(float v, float w) { float d = abs(fract(v - 0.5) - 0.5); return 1.0 - smoothstep(w * 0.5, w * 0.5 + fwidth(v) * 1.2, d); }
vec3 sheet(vec2 q) {
  vec3 col = mix(uC0, uC1, 0.18 + 0.22 * fbm2(q * 0.8));
  float minor = max(line(q.x * 22.0, 0.04), line(q.y * 22.0, 0.04));
  float major = max(line(q.x * 4.4, 0.03), line(q.y * 4.4, 0.03));
  col = mix(col, uC2, minor * 0.13 + major * 0.32);
  // drafted forms: circles and arcs that slowly rotate
  vec2 c = fract(q * 1.1) - 0.5;
  vec2 id = floor(q * 1.1);
  float rnd = hash21(id);
  float r = length(c);
  float ring = 1.0 - smoothstep(0.0, fwidth(r) * 1.5, abs(r - (0.14 + rnd * 0.28)));
  float ang = atan(c.y, c.x) + uTime * (0.05 + rnd * 0.1) * (rnd > 0.5 ? 1.0 : -1.0);
  float ticks = step(0.7, fract(ang * 6.0 / 6.2832 * (3.0 + floor(rnd * 8.0))));
  col = mix(col, uC3, ring * ticks * 0.75);
  float contour = fbm3(q * 1.4 + uTime * 0.012);
  float iso = 1.0 - smoothstep(0.0, fwidth(contour) * 1.6, abs(fract(contour * 9.0) - 0.5) / 9.0);
  col = mix(col, uC2, iso * 0.2);
  return col;
}
bool lensAt(vec2 p, vec2 c, float radius, float power, inout vec3 col) {
  vec2 d = p - c;
  float r = length(d) / radius;
  if (r >= 1.0) return false;
  float h = sqrt(1.0 - r * r);
  vec3 n = normalize(vec3(d / radius, h));
  // refraction through a sphere: the deeper, the stronger the magnification
  float m = mix(1.0 - power, 1.0, smoothstep(0.0, 1.0, r * r * r));
  vec2 ofs = d * m;
  vec3 inside = vec3(sheet(c + ofs * 0.985).r, sheet(c + ofs).g, sheet(c + ofs * 1.015).b);
  float fres = pow(1.0 - h, 2.6);
  vec3 l = normalize(vec3(-0.5, 0.7, 0.75));
  float spec = pow(max(dot(n, l), 0.0), 90.0) * 1.2 + pow(max(dot(n, normalize(vec3(0.6, -0.5, 0.5))), 0.0), 22.0) * 0.18;
  col = inside * (0.92 + 0.2 * h) + uC3 * fres * 0.9 + vec3(spec);
  return true;
}
void main() {
  float a = uCss.x / uCss.y;
  vec2 p = vec2(vUv.x * a, vUv.y);
  p.y += uScroll * 0.7;
  vec3 col = sheet(p);
  vec2 l1 = vec2(uLens.x * a, uLens.y + uScroll * 0.7);
  vec2 l2 = vec2(uLens2.x * a, uLens2.y + uScroll * 0.7);
  float R1 = 0.24 + 0.05 * uDepth, R2 = 0.11;
  // shadows on the sheet
  col *= 1.0 - 0.34 * smoothstep(R1 * 1.4, R1 * 0.7, length(p - l1 - vec2(0.03, -0.05)));
  col *= 1.0 - 0.28 * smoothstep(R2 * 1.5, R2 * 0.7, length(p - l2 - vec2(0.018, -0.03)));
  lensAt(p, l2, R2, 0.42, col);
  lensAt(p, l1, R1, uLens.z, col);
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => {
  const pos = { x: 0.62, y: 0.55, vx: 0, vy: 0 };
  const pos2 = { x: 0.22, y: 0.3, vx: 0, vy: 0 };
  let power = 0.5;
  let targetPower = 0.5;
  return fragmentSpatial(env, bridge, palette, FS, {
    before(gl, p, t, dt) {
      const pt = env.pointer;
      if (pt.drainPulses().length) targetPower = targetPower > 0.6 ? 0.42 : 0.74;
      power += (targetPower - power) * Math.min(1, dt * 5);
      const live = pt.strength > 0.01;
      const tx = live ? pt.u : 0.62 + 0.2 * Math.sin(t * 0.19);
      const ty = live ? pt.v : 0.55 + 0.2 * Math.cos(t * 0.23);
      const k = 11;
      const c = 5.2;
      pos.vx += ((tx - pos.x) * k - pos.vx * c) * dt;
      pos.vy += ((ty - pos.y) * k - pos.vy * c) * dt;
      pos.x += pos.vx * dt;
      pos.y += pos.vy * dt;
      const tx2 = 0.5 + 0.42 * Math.sin(t * 0.13 + 2.0) - (pos.x - 0.5) * 0.3;
      const ty2 = 0.5 + 0.4 * Math.cos(t * 0.17 + 0.5) - (pos.y - 0.5) * 0.3;
      pos2.vx += ((tx2 - pos2.x) * 2.5 - pos2.vx * 2.2) * dt;
      pos2.vy += ((ty2 - pos2.y) * 2.5 - pos2.vy * 2.2) * dt;
      pos2.x += pos2.vx * dt;
      pos2.y += pos2.vy * dt;
      gl.uniform3f(p.u('uLens'), pos.x, pos.y, power);
      gl.uniform3f(p.u('uLens2'), pos2.x, pos2.y, 0.4);
    },
    slabs: 0.9,
  });
};
export default make;
