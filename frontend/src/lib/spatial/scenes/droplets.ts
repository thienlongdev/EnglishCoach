import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * B07 Droplets. Real metaballs, raymarched: signed-distance spheres blended with a smooth minimum, so two drops that meet flow into one and tear apart again with a neck between them. A chain of drops
 * follows the pointer on springs, which stretches and recovers when it moves fast. Free drops wander, bounce off the real cards and are drawn to the pointer when it comes near. A press scatters them.
 * Each drop is a lens: it bends the backdrop behind it. All of it in the visitor's browser.
 */
const MAX_BALLS = 16;
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
uniform vec4 uBalls[${MAX_BALLS}];
uniform int uCount;
#ifndef STEPS
#define STEPS 34
#endif
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * h * k / 6.0;
}
float map(vec3 p) {
  float d = 1e5;
  for (int i = 0; i < uCount; i++) {
    float r = uBalls[i].w;
    if (r <= 0.001) continue;
    d = smin(d, length(p - uBalls[i].xyz) - r, 0.2);
  }
  return d;
}
vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.003, 0.0);
  return normalize(vec3(map(p + e.xyy) - map(p - e.xyy), map(p + e.yxy) - map(p - e.yxy), map(p + e.yyx) - map(p - e.yyx)));
}
vec3 backdrop(vec2 q) {
  // A soft field of light dots: plain enough to read behind cards, structured enough that a lens visibly bends it.
  vec3 col = mix(uC0, uC1, smoothstep(-1.2, 1.3, q.y + 0.25 * q.x + 0.2 * sin(q.x * 1.3 + uTime * 0.05)));
  vec2 g = q * 11.0;
  vec2 f = fract(g) - 0.5;
  float dots = smoothstep(0.12, 0.03, length(f)) * (0.35 + 0.65 * vnoise(floor(g) * 0.37 + uTime * 0.04));
  col += mix(uC2, uC3, 0.4) * dots * mix(0.16, 0.24, uDark);
  return col;
}
void main() {
  float a = uCss.x / uCss.y;
  vec2 q = (vUv - 0.5) * 2.0 * vec2(a, 1.0);
  vec3 col = backdrop(q);
  vec3 ro = vec3(q * 1.02, 1.6);
  vec3 rd = normalize(vec3(q * -0.02, -1.0));
  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < STEPS; i++) {
    float d = map(ro + rd * t);
    if (d < 0.0016) { hit = true; break; }
    t += d;
    if (t > 3.2) break;
  }
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = normalAt(p);
    vec3 refr = refract(rd, n, 0.72);
    vec2 bent = q + refr.xy * 0.62;
    vec3 inside = vec3(backdrop(bent + vec2(0.012, 0.0)).r, backdrop(bent).g, backdrop(bent - vec2(0.012, 0.0)).b);
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    vec3 l = normalize(vec3((uMouse - 0.5) * 2.0 * vec2(a, 1.0) - p.xy, 1.3));
    float spec = pow(max(dot(reflect(rd, n), l), 0.0), 90.0);
    float sky = 0.5 + 0.5 * reflect(rd, n).y;
    col = inside * (0.92 + 0.3 * n.y);
    col = mix(col, mix(uC1, mix(uC3, vec3(1.0), 0.4), sky), fres * 0.72);
    col += vec3(1.0) * spec * 1.2 + uC3 * pow(fres, 2.0) * 0.3;
  } else {
    // contact shadow: the drops stand a little above the page
    float near = map(vec3(q + vec2(-0.02, 0.05), 0.0));
    col *= 1.0 - smoothstep(0.14, 0.0, near) * 0.22;
  }
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => {
  const tier = env.tier === 'high' ? 2 : env.tier === 'balanced' ? 1 : 0;
  const source = FS.replace('#ifndef STEPS', `#define STEPS ${tier === 2 ? 40 : tier === 1 ? 30 : 22}\n#ifndef STEPS`);
  const free = tier === 2 ? 10 : tier === 1 ? 8 : 5;
  const chain = 5;
  const count = free + chain;
  const data = new Float32Array(MAX_BALLS * 4);
  const vel = new Float32Array(count * 2);
  const size = new Float32Array(count);
  const a = () => env.cssWidth / Math.max(1, env.cssHeight);
  for (let i = 0; i < count; i++) {
    const asp = a();
    data[i * 4] = (Math.random() - 0.5) * 2 * asp;
    data[i * 4 + 1] = (Math.random() - 0.5) * 2;
    data[i * 4 + 2] = (Math.random() - 0.5) * 0.3;
    size[i] = i < free ? 0.06 + Math.random() * Math.random() * 0.2 : [0.15, 0.125, 0.1, 0.075, 0.05][i - free];
    data[i * 4 + 3] = i < free ? size[i] : 0;
  }
  const probe = { stretch: 0, scatter: 0, merged: 0, bounced: 0 };
  bridge.probe = probe;
  let seen = 0;
  return fragmentSpatial(env, bridge, palette, source, {
    before(gl, p, t, rawDt) {
      const dt = Math.min(rawDt, 1 / 24);
      const pt = env.pointer;
      const asp = a();
      const hx = (pt.u - 0.5) * 2 * asp;
      const hy = (pt.v - 0.5) * 2;
      seen += ((pt.strength > 0.01 ? 1 : 0) - seen) * Math.min(1, dt * 3);
      // Presses scatter what is near.
      for (const pulse of pt.drainPulses()) {
        const px = (pulse.u - 0.5) * 2 * asp;
        const py = (pulse.v - 0.5) * 2;
        probe.scatter += 1;
        for (let i = 0; i < free; i++) {
          const dx = data[i * 4] - px;
          const dy = data[i * 4 + 1] - py;
          const d = Math.hypot(dx, dy) + 1e-3;
          if (d < 1.1) {
            const f = (1 - d / 1.1) * 3.2;
            vel[i * 2] += (dx / d) * f;
            vel[i * 2 + 1] += (dy / d) * f;
          }
        }
      }
      // Free drops: a slow current, soft walls, the pull of a pointer that comes near, the real cards as solid things.
      let merged = 0;
      for (let i = 0; i < free; i++) {
        let x = data[i * 4];
        let y = data[i * 4 + 1];
        vel[i * 2] += Math.sin(t * 0.21 + i * 1.7 + y * 1.3) * 0.05 * dt;
        vel[i * 2 + 1] += Math.cos(t * 0.17 + i * 2.3 + x * 1.1) * 0.05 * dt;
        const dx = hx - x;
        const dy = hy - y;
        const d = Math.hypot(dx, dy) + 1e-3;
        if (pt.strength > 0.01 && d < 0.85) {
          const f = (1 - d / 0.85) * 1.7 * pt.strength;
          vel[i * 2] += (dx / d) * f * dt;
          vel[i * 2 + 1] += (dy / d) * f * dt;
          if (d < 0.26) merged += 1;
        }
        if (Math.abs(x) > asp) vel[i * 2] -= Math.sign(x) * dt * 1.4;
        if (Math.abs(y) > 1) vel[i * 2 + 1] -= Math.sign(y) * dt * 1.4;
        for (let k = 0; k < bridge.count; k++) {
          if (bridge.meta[k * 4 + 3] > 0.5) continue;
          const rx0 = ((bridge.rects[k * 4] / env.cssWidth) - 0.5) * 2 * asp;
          const rx1 = (((bridge.rects[k * 4] + bridge.rects[k * 4 + 2]) / env.cssWidth) - 0.5) * 2 * asp;
          const ry1 = (0.5 - bridge.rects[k * 4 + 1] / env.cssHeight) * 2;
          const ry0 = (0.5 - (bridge.rects[k * 4 + 1] + bridge.rects[k * 4 + 3]) / env.cssHeight) * 2;
          if (x > rx0 && x < rx1 && y > ry0 && y < ry1) {
            // inside a card's outline: out by the nearest side, with a bounce
            const left = x - rx0;
            const right = rx1 - x;
            const down = y - ry0;
            const up = ry1 - y;
            const min = Math.min(left, right, down, up);
            if (min === left) vel[i * 2] = -Math.abs(vel[i * 2]) * 0.7 - 0.5 * dt * 8;
            else if (min === right) vel[i * 2] = Math.abs(vel[i * 2]) * 0.7 + 0.5 * dt * 8;
            else if (min === down) vel[i * 2 + 1] = -Math.abs(vel[i * 2 + 1]) * 0.7 - 0.5 * dt * 8;
            else vel[i * 2 + 1] = Math.abs(vel[i * 2 + 1]) * 0.7 + 0.5 * dt * 8;
            probe.bounced += 1;
          }
        }
        const drag = Math.exp(-dt * 1.2);
        vel[i * 2] *= drag;
        vel[i * 2 + 1] *= drag;
        x += vel[i * 2] * dt;
        y += vel[i * 2 + 1] * dt;
        data[i * 4] = x;
        data[i * 4 + 1] = y;
        data[i * 4 + 2] = Math.sin(t * 0.3 + i) * 0.12;
        data[i * 4 + 3] = size[i] * (1 + 0.06 * Math.sin(t * 0.9 + i * 2.1));
      }
      probe.merged = merged;
      // The chain on springs: each link follows the one before it, so a fast stroke draws it out and it snaps back.
      let px = hx;
      let py = hy;
      let stretch = 0;
      for (let c = 0; c < chain; c++) {
        const i = free + c;
        const k = 70 - c * 8;
        const damp = 9;
        vel[i * 2] += ((px - data[i * 4]) * k - vel[i * 2] * damp) * dt;
        vel[i * 2 + 1] += ((py - data[i * 4 + 1]) * k - vel[i * 2 + 1] * damp) * dt;
        data[i * 4] += vel[i * 2] * dt;
        data[i * 4 + 1] += vel[i * 2 + 1] * dt;
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = size[i] * seen;
        px = data[i * 4];
        py = data[i * 4 + 1];
        stretch = Math.hypot(hx - px, hy - py);
      }
      probe.stretch = stretch;
      gl.useProgram(p.prog);
      gl.uniform4fv(p.u('uBalls'), data);
      gl.uniform1i(p.u('uCount'), count);
    },
    slabs: 0.9,
    pixels: 0.6,
  });
};
export default make;
