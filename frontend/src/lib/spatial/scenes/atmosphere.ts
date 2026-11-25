import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial, makeSurfaceWaves } from './kit';

/**
 * D05 Atmospheric Scroll Scene. An original raymarched courtyard: plaster walls with arches and tall windows standing in still water, one iridescent pearl. Soft sun shadows and a
 * rippled mirror in the water. Native scroll moves the sun across the day. Rendered at a reduced pixel budget, the softness hides it.
 *
 * The water is a real surface: a height field in the pool's own coordinates. The ray from the pointer meets the plane y = 0 with the same camera the shader uses, so a ring starts exactly under the
 * pointer from any view, grows with the pointer's speed, travels, crosses other rings, bounces off the walls and the stone, and dies out. The pearl can be touched: it lights up under the pointer and
 * a press drops it into the water, with the splash where it lands. Now and then a drop falls from the arch, so the pool is alive when nobody touches it.
 */
const POOL = { x0: -11, x1: 12, z0: -3.3, z1: 4.8 };
const PEARL = { x: 1.65, y: 1.35, z: -2.2, r: 0.42 };

const FS = /* glsl */ `${SPATIAL_FS_HEAD}
uniform float uSun;
uniform sampler2D uWater;
uniform vec2 uWaterTexel;
uniform vec4 uPool;
uniform vec3 uCam;
uniform vec3 uPearl;
#ifndef TIER
#define TIER 2
#endif
float sdBox(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }
float sdArch(vec2 p, float w, float h) {
  vec2 q = vec2(abs(p.x), p.y);
  float top = length(q - vec2(0.0, h)) - w;
  float body = max(q.x - w, q.y - h);
  return min(top, body);
}
float map(vec3 p, out float id) {
  // back wall with two arches and two windows
  float wall = sdBox(p - vec3(0.6, 2.6, -3.0), vec3(6.6, 2.9, 0.3));
  float a1 = sdArch(p.xy - vec2(-3.3, -0.3), 0.72, 1.7);
  float a2 = sdArch(p.xy - vec2(-1.2, -0.3), 0.72, 1.7);
  float w1 = max(abs(p.x - 2.6) - 0.46, abs(p.y - 2.5) - 1.15);
  float w2 = max(abs(p.x - 0.75) - 0.32, abs(p.y - 1.7) - 0.72);
  float cut = min(min(a1, a2), min(w1, w2));
  wall = max(wall, -cut);
  // steps
  float steps = 1e5;
  for (int i = 0; i < 5; i++) {
    float k = float(i);
    steps = min(steps, sdBox(p - vec3(0.2, 0.08 + k * 0.2, -2.0 - k * 0.2 + 0.4), vec3(1.0 - k * 0.09, 0.1 + k * 0.1, 0.34)));
  }
  // right wing
  float wing = sdBox(p - vec3(6.8, 1.6, -1.0), vec3(0.3, 1.9, 2.4));
  // stone
  vec3 sp = p - vec3(3.3, 0.05, -1.0);
  sp.y *= 1.4;
  float stone = length(sp) - 0.62 - 0.05 * sin(p.x * 6.0) * sin(p.z * 5.0);
  float pearl = length(p - vec3(1.65, 1.35 + sin(uTime * 0.4) * 0.05 + uPearl.y, -2.2)) - 0.42 - uPearl.x * 0.015;
  float d = min(min(wall, steps), wing);
  id = 1.0;
  if (stone < d) { d = stone; id = 2.0; }
  if (pearl < d) { d = pearl; id = 3.0; }
  return d;
}
float mapD(vec3 p) { float i; return map(p, i); }
vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.002, 0.0);
  return normalize(vec3(mapD(p + e.xyy) - mapD(p - e.xyy), mapD(p + e.yxy) - mapD(p - e.yxy), mapD(p + e.yyx) - mapD(p - e.yyx)));
}
float shadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.03;
  for (int i = 0; i < (TIER > 0 ? 18 : 8); i++) {
    float h = mapD(ro + rd * t);
    res = min(res, 9.0 * h / t);
    t += clamp(h, 0.03, 0.5);
    if (res < 0.01 || t > 9.0) break;
  }
  return clamp(res, 0.0, 1.0);
}
vec3 skyAt(vec3 rd, vec3 sun) {
  float up = clamp(rd.y * 0.8 + 0.3, 0.0, 1.0);
  vec3 col = mix(mix(uC1, uC3, 0.55), mix(uC0, uC3, 0.2), up);
  col = mix(col, vec3(0.94, 0.86, 0.9), smoothstep(-0.05, 0.5, 0.5 - abs(rd.y - 0.14)) * (0.55 - 0.45 * uDark));
  col += vec3(1.0, 0.86, 0.75) * pow(max(dot(rd, sun), 0.0), 40.0) * 0.5;
  return col;
}
vec3 shade(vec3 ro, vec3 rd, vec3 sun, out float hitT) {
  float t = 0.05, id = 0.0;
  hitT = -1.0;
  for (int i = 0; i < (TIER > 1 ? 64 : TIER > 0 ? 44 : 28); i++) {
    vec3 p = ro + rd * t;
    float d = map(p, id);
    if (d < 0.002) { hitT = t; break; }
    t += d;
    if (t > 26.0) break;
  }
  if (hitT < 0.0) return skyAt(rd, sun);
  vec3 p = ro + rd * hitT;
  vec3 n = normalAt(p);
  float sh = shadow(p + n * 0.01, sun);
  float diff = max(dot(n, sun), 0.0) * sh;
  float amb = 0.42 + 0.3 * n.y;
  vec3 plaster = mix(uC2, uC3, 0.45);
  plaster = mix(plaster, vec3(0.96, 0.82, 0.8), 0.55 * (1.0 - uDark));
  vec3 base = plaster;
  if (id > 1.5 && id < 2.5) base = mix(vec3(0.72, 0.62, 0.52), uC1, 0.15) * (0.75 + 0.5 * fbm3(p.xz * 7.0));
  vec3 col = base * (amb * mix(uC1 * 0.9 + 0.32, vec3(1.0), 0.45) + diff * vec3(1.15, 1.0, 0.86) * 1.15);
  col *= 0.94 + 0.1 * fbm3(p.xy * 3.0);
  // The foot of each wall sits in shade, and the water throws moving light up onto it: the same waves the learner just made.
  col *= 0.74 + 0.26 * smoothstep(0.0, 1.5, p.y);
  if (p.y < 3.0) {
    vec2 wu = (vec2(p.x + n.x * 0.5, p.z + n.z * 0.5 + p.y * 0.4) - uPool.xy) / uPool.zw;
    float bounce = texture(uWater, wu + vec2(uWaterTexel.x, 0.0)).r - texture(uWater, wu - vec2(uWaterTexel.x, 0.0)).r + texture(uWater, wu + vec2(0.0, uWaterTexel.y)).r - texture(uWater, wu - vec2(0.0, uWaterTexel.y)).r;
    float shimmer = gnoise(vec2(p.x * 2.2 + uTime * 0.2, p.y * 7.0 - uTime * 0.5));
    col += vec3(1.0, 0.86, 0.74) * smoothstep(3.0, 0.0, p.y) * (clamp(bounce * 2.6, -0.2, 0.5) + 0.05 * shimmer) * mix(0.5, 0.42, uDark);
  }
  if (id > 2.5) {
    // the pearl: thin-film colours at the rim, the sky in the rest
    vec3 v = -rd;
    float f = pow(1.0 - max(dot(n, v), 0.0), 2.0);
    vec3 film = 0.5 + 0.5 * cos(6.283 * (f * 2.3 + n.y * 0.3 + vec3(0.0, 0.33, 0.67)));
    col = mix(skyAt(reflect(rd, n), sun), film, 0.35 + 0.4 * f) * 1.05 + vec3(1.0) * pow(max(dot(reflect(-sun, n), v), 0.0), 60.0);
    col += mix(film, vec3(1.0), 0.3) * uPearl.x * (0.16 + 0.5 * f);
  }
  return col;
}
void main() {
  float a = uCss.x / uCss.y;
  vec2 ndc = (vUv - 0.5) * 2.0 * vec2(a, 1.0);
  vec3 ro = uCam;
  vec3 ta = vec3(0.6, 1.25, -3.0);
  vec3 f = normalize(ta - ro), r = normalize(cross(f, vec3(0, 1, 0))), u = cross(r, f);
  vec3 rd = normalize(f * 1.55 + r * ndc.x + u * ndc.y);
  float s = uSun;
  vec3 sun = normalize(vec3(mix(-0.75, 0.75, s), 0.42 + 0.34 * sin(s * 3.14159), 0.62));
  vec3 col;
  float t;
  if (rd.y < 0.0 && ro.y > 0.0) {
    // still water at y = 0: a rippled mirror
    float tw = -ro.y / rd.y;
    vec3 p = ro + rd * tw;
    vec2 q = p.xz;
    float e = 0.06;
    float amp = 0.0008;
    // the idle surface is a long slow swell; what breaks the mirror sharply is only a real wave
    float w0 = gnoise(q * 1.1 + uTime * vec2(0.16, 0.1)) + 0.35 * gnoise(q * 2.6 - uTime * 0.14);
    float wx = gnoise((q + vec2(e, 0)) * 1.1 + uTime * vec2(0.16, 0.1)) + 0.35 * gnoise((q + vec2(e, 0)) * 2.6 - uTime * 0.14);
    float wz = gnoise((q + vec2(0, e)) * 1.1 + uTime * vec2(0.16, 0.1)) + 0.35 * gnoise((q + vec2(0, e)) * 2.6 - uTime * 0.14);
    // The real waves: the slope of the height field where this ray met the pool.
    vec2 wuv = (q - uPool.xy) / uPool.zw;
    float wh = texture(uWater, wuv).r;
    float sx = texture(uWater, wuv + vec2(uWaterTexel.x, 0.0)).r - texture(uWater, wuv - vec2(uWaterTexel.x, 0.0)).r;
    float sz = texture(uWater, wuv + vec2(0.0, uWaterTexel.y)).r - texture(uWater, wuv - vec2(0.0, uWaterTexel.y)).r;
    vec3 n = normalize(vec3(-(wx - w0) / e * amp * 8.0 - sx * 5.5, 1.0, -(wz - w0) / e * amp * 8.0 - sz * 5.5));
    vec3 refl = reflect(rd, n);
    refl.y = abs(refl.y);
    float tScene;
    vec3 mirrored = shade(p + vec3(0, 0.01, 0), refl, sun, tScene);
    float fres = 0.38 + 0.62 * pow(1.0 - max(-rd.y, 0.0), 3.0);
    vec3 water = mix(uC1, uC2, 0.3);
    col = mix(water, mirrored, fres);
    // a crest catches the sky, a trough goes a little dark: what makes a ring legible on a mirror
    col += mix(vec3(1.0, 0.95, 0.9), uC3, 0.3) * smoothstep(0.012, 0.16, length(vec2(sx, sz))) * (0.1 + 0.2 * smoothstep(0.0, 0.12, wh));
    col *= 1.0 - smoothstep(0.0, 0.14, -wh) * 0.12;
    // something closer in front of the water?
    float tNear;
    vec3 near = shade(ro, rd, sun, tNear);
    if (tNear > 0.0 && tNear < tw) col = near;
  } else {
    col = shade(ro, rd, sun, t);
  }
  col = pow(col, vec3(0.94));
  // Dark appearance: dusk, not a grey wash. The shadows go violet, what the low sun still touches stays warm.
  float lum = dot(col, vec3(0.3, 0.55, 0.15));
  vec3 dusk = mix(col * vec3(0.34, 0.3, 0.52), col * vec3(0.92, 0.66, 0.62), smoothstep(0.28, 0.82, lum));
  col = mix(col, dusk, uDark);
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) => {
  const tier = env.tier === 'high' ? 2 : env.tier === 'balanced' ? 1 : 0;
  const source = FS.replace('#ifndef TIER', `#define TIER ${tier}\n#ifndef TIER`);
  const poolW = POOL.x1 - POOL.x0;
  const poolD = POOL.z1 - POOL.z0;
  const gl = env.gl;
  // Stone, steps and the right wing stand in the water: the pool is held still there, so a ring comes back from them. Painted once, in the pool's coordinates.
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = 512;
  maskCanvas.height = Math.round((512 * poolD) / poolW);
  const m = maskCanvas.getContext('2d') as CanvasRenderingContext2D;
  m.fillStyle = '#000';
  m.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  m.fillStyle = '#fff';
  const px = (x: number) => ((x - POOL.x0) / poolW) * maskCanvas.width;
  const pz = (z: number) => ((z - POOL.z0) / poolD) * maskCanvas.height;
  m.beginPath();
  m.ellipse(px(3.3), pz(-1), (0.62 / poolW) * maskCanvas.width, (0.62 / poolD) * maskCanvas.height, 0, 0, Math.PI * 2);
  m.fill();
  m.fillRect(px(-0.9), pz(-3.3), (2.2 / poolW) * maskCanvas.width, (1.9 / poolD) * maskCanvas.height);
  m.fillRect(px(6.5), pz(-3.3), (0.6 / poolW) * maskCanvas.width, (4.7 / poolD) * maskCanvas.height);
  const mask = gl.createTexture() as WebGLTexture;
  gl.bindTexture(gl.TEXTURE_2D, mask);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const pool = makeSurfaceWaves(env, poolW, poolD, { damp: 0.9945, mask });

  // The same camera as the shader: anything picked here is what the learner sees there.
  const camera = { x: 0.6, y: 1.15, z: 5.2 };
  const fwd = [0, 0, 0];
  const right = [0, 0, 0];
  const up = [0, 0, 0];
  const aim = () => {
    const f = [0.6 - camera.x, 1.25 - camera.y, -3 - camera.z];
    const fl = Math.hypot(f[0], f[1], f[2]);
    fwd[0] = f[0] / fl;
    fwd[1] = f[1] / fl;
    fwd[2] = f[2] / fl;
    const rl = Math.hypot(fwd[2], fwd[0]);
    right[0] = -fwd[2] / rl;
    right[1] = 0;
    right[2] = fwd[0] / rl;
    up[0] = right[1] * fwd[2] - right[2] * fwd[1];
    up[1] = right[2] * fwd[0] - right[0] * fwd[2];
    up[2] = right[0] * fwd[1] - right[1] * fwd[0];
  };
  const ray = (u: number, v: number) => {
    const a = env.cssWidth / Math.max(1, env.cssHeight);
    const nx = (u - 0.5) * 2 * a;
    const ny = (v - 0.5) * 2;
    const d = [fwd[0] * 1.55 + right[0] * nx + up[0] * ny, fwd[1] * 1.55 + right[1] * nx + up[1] * ny, fwd[2] * 1.55 + right[2] * nx + up[2] * ny];
    const l = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / l, d[1] / l, d[2] / l];
  };
  const onWater = (d: number[]) => {
    if (d[1] >= -1e-3) return null;
    const t = -camera.y / d[1];
    return { x: camera.x + d[0] * t, z: camera.z + d[2] * t };
  };
  const toPool = (x: number, z: number): [number, number] => [(x - POOL.x0) / poolW, (z - POOL.z0) / poolD];

  let sun = 0.3;
  let lastU = -1;
  let lastV = -1;
  let glow = 0;
  let lift = 0;
  let liftV = 0;
  let falling = false;
  let dripIn = 2.2;
  const probe = { drops: 0, lastX: 0, lastZ: 0, pearl: 0, pearlLift: 0 };
  bridge.probe = probe;
  return fragmentSpatial(env, bridge, palette, source, {
    before(_gl, p, t, dt) {
      const pt = env.pointer;
      camera.x = 0.6 + (pt.su - 0.5) * pt.strength * 0.5;
      camera.y = 1.15 + (pt.sv - 0.5) * 0.2 * pt.strength;
      aim();
      const d = ray(pt.u, pt.v);
      const hit = onWater(d);
      // Moving: a wake along the path, stronger the faster the pointer goes. Resting: nothing, the rings run out.
      if (hit && pt.strength > 0.01 && lastU >= 0) {
        const moved = Math.hypot(pt.u - lastU, pt.v - lastV);
        if (moved > 0.0006 && dt > 0) {
          // A quick stroke crosses a lot of water in one frame: touch it all along the way, not at the two ends.
          const parts = Math.min(6, Math.ceil(moved / 0.02));
          for (let k = 1; k <= parts; k++) {
            const f = k / parts;
            const at = onWater(ray(lastU + (pt.u - lastU) * f, lastV + (pt.v - lastV) * f));
            if (!at) continue;
            const [u, v] = toPool(at.x, at.z);
            pool.drop(u, v, (Math.min(moved * 3.4, 0.15) * pt.strength) / Math.sqrt(parts), 0.2);
            probe.drops += 1;
            probe.lastX = at.x;
            probe.lastZ = at.z;
          }
        }
      }
      lastU = pt.u;
      lastV = pt.v;
      // The pearl under the pointer.
      const oc = [camera.x - PEARL.x, camera.y - (PEARL.y + lift), camera.z - PEARL.z];
      const b = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2];
      const c = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - PEARL.r * PEARL.r;
      const onPearl = pt.strength > 0.01 && b * b - c > 0 && b < 0;
      glow += ((onPearl ? 1 : 0) - glow) * Math.min(1, dt * 6);
      for (const pulse of pt.drainPulses()) {
        const pd = ray(pulse.u, pulse.v);
        const pb = oc[0] * pd[0] + oc[1] * pd[1] + oc[2] * pd[2];
        if (!falling && pb * pb - c > 0 && pb < 0) {
          falling = true;
          liftV = 1.5;
          probe.pearl += 1;
          continue;
        }
        const at = onWater(pd);
        if (at) {
          const [u, v] = toPool(at.x, at.z);
          pool.drop(u, v, 0.62, 0.3);
          probe.drops += 1;
          probe.lastX = at.x;
          probe.lastZ = at.z;
        }
      }
      // The pearl jumps, falls, splashes and floats back up on a spring.
      if (falling) {
        liftV -= 5.4 * dt;
        lift += liftV * dt;
        if (PEARL.y + lift < 0.1) {
          falling = false;
          liftV = 0;
          const [u, v] = toPool(PEARL.x, PEARL.z + 0.3);
          pool.drop(u, v, 1.1, 0.42);
          probe.drops += 1;
        }
      } else {
        liftV += (-lift * 9 - liftV * 3.2) * dt;
        lift += liftV * dt;
      }
      probe.pearlLift = lift;
      // A drop from the arch now and then: the pool is alive when nobody touches it.
      dripIn -= dt;
      if (dripIn <= 0) {
        dripIn = 3.5 + Math.random() * 5;
        const [u, v] = toPool(-2.2 + Math.random() * 7, -1.8 + Math.random() * 3.2);
        pool.drop(u, v, 0.24, 0.14);
      }
      if (dt > 0) pool.step(dt);
      sun += (0.18 + bridge.scrollProgress * 0.72 - sun) * Math.min(1, dt * 2);
      gl.useProgram(p.prog);
      gl.uniform1f(p.u('uSun'), sun);
      gl.uniform3f(p.u('uCam'), camera.x, camera.y, camera.z);
      gl.uniform3f(p.u('uPearl'), glow, lift, 0);
      gl.uniform4f(p.u('uPool'), POOL.x0, POOL.z0, poolW, poolD);
      gl.uniform2f(p.u('uWaterTexel'), pool.texelX * 1.5, pool.texelY * 1.5);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, pool.texture());
      gl.uniform1i(p.u('uWater'), 2);
      void t;
    },
    dispose() {
      pool.dispose();
      gl.deleteTexture(mask);
    },
    pixels: 0.42,
    fps: 45,
    slabs: 0.8,
  });
};
export default make;
