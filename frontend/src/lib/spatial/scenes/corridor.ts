import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_THREE_U, threeSpatial, withUniforms } from './kit';

/**
 * D04 Infinite Camera Corridor. A real box of mirror and light. Warm strips run along its corners and across its ceiling; glass panels hang in the air, each with its real mirror image under the glossy floor.
 * Travel is a function of the page's native scroll plus a slow walk: the panels are a conveyor (each one wraps by `mod` in the fog), so a finite set reads as endless.
 */
const WALL_VS = /* glsl */ `varying vec3 vW; varying vec3 vN; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normal; gl_Position = projectionMatrix * viewMatrix * w; }`;
const WALL_FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform float uWalk;
varying vec3 vW; varying vec3 vN;
const float CW = 3.0;
const float CH = 1.9;
vec3 strips(vec3 p) {
  float ex = abs(abs(p.x) - CW);
  float ey = abs(abs(p.y) - CH);
  float along = exp(-min(ex, 1.0) * 14.0) * exp(-min(ey, 1.0) * 14.0);
  float rung = exp(-abs(fract((p.z + uWalk) * 0.1) - 0.5) * 34.0) * exp(-ey * 7.0);
  return mix(uC3, vec3(1.0, 0.9, 0.78), 0.45) * (along * 2.2 + rung * 1.1);
}
void main() {
  vec3 rd = normalize(vW - cameraPosition);
  vec3 n = -normalize(vN);
  vec3 base = mix(uC0, uC1, 0.24);
  vec3 col = base + strips(vW) * 0.85;
  // one mirror bounce, solved analytically against the walls of the same box
  vec3 r = reflect(rd, n);
  float tx = abs((sign(r.x) * CW - vW.x) / (abs(r.x) + 1e-4));
  float ty = abs((sign(r.y) * CH - vW.y) / (abs(r.y) + 1e-4));
  float t = min(tx, ty);
  vec3 mirrored = (base * 0.9 + strips(vW + r * t)) * exp(-t * 0.06);
  float gloss = n.y > 0.5 ? 0.74 : 0.4;
  col = mix(col, mirrored, gloss * (0.42 + 0.3 * pow(1.0 - abs(dot(rd, n)), 2.0)));
  float dist = length(vW - cameraPosition);
  col = mix(mix(uC0, uC1, 0.4), col, exp(-dist * 0.03));
  gl_FragColor = vec4(col, 1.0);
}`;
const PANEL_VS = /* glsl */ `
attribute vec3 iPos; attribute vec2 iSize; attribute float iSeed; attribute float iMirror;
${SPATIAL_THREE_U}
uniform float uWalk;
uniform vec2 uHand;
uniform float uGust;
varying vec2 vP; varying vec2 vSize; varying float vFog; varying float vMirror;
void main() {
  float span = 60.0;
  float z = mod(iPos.z + uWalk, span) - span + 3.0;
  // The glass hangs free: panels near the line of the hand swing away from it, and a press sends a gust down the corridor.
  vec2 off = iPos.xy - uHand * (1.0 + clamp(-z * 0.04, 0.0, 2.0));
  float swing = exp(-dot(off, off) * 0.9) * sign(off.x + 0.001) * uStrength * (0.55 + uEnergy * 1.2);
  float tilt = sin(uTime * 0.2 + iSeed * 12.0) * 0.16 + swing + uGust * sin(iSeed * 30.0 + z * 0.3) * 0.7;
  vec3 p = position * vec3(iSize, 1.0);
  float c = cos(tilt), s = sin(tilt);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  float rock = sin(uTime * 0.13 + iSeed * 30.0) * 0.1;
  p = vec3(cos(rock) * p.x - sin(rock) * p.y, sin(rock) * p.x + cos(rock) * p.y, p.z);
  vec3 w = vec3(iPos.x, iPos.y + sin(uTime * 0.3 + iSeed * 9.0) * 0.06, z) + p;
  if (iMirror > 0.5) w.y = -3.8 - w.y;
  vP = position.xy * iSize;
  vSize = iSize * 0.5;
  vFog = exp(-max(cameraPosition.z - w.z, 0.0) * 0.045);
  vMirror = iMirror;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const PANEL_FS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec2 vP; varying vec2 vSize; varying float vFog; varying float vMirror;
void main() {
  vec2 q = abs(vP) - vSize + 0.07;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.07;
  float aa = fwidth(d);
  float body = 1.0 - smoothstep(-aa, aa, d);
  if (body < 0.01) discard;
  float rim = 1.0 - smoothstep(0.0, aa * 2.0 + 0.012, abs(d));
  // the screens carry soft, drawn-in blocks of an interface: never readable text
  float head = step(vSize.y * 0.55, vP.y) * step(vP.y, vSize.y * 0.72) * step(abs(vP.x + vSize.x * 0.3), vSize.x * 0.45);
  float block = step(abs(vP.x + vSize.x * 0.22), vSize.x * 0.5) * step(abs(vP.y + vSize.y * 0.14), vSize.y * 0.42);
  vec3 glass = mix(uC2, uC3, 0.5 + 0.5 * vP.y / vSize.y);
  vec3 col = glass * (0.48 + 0.26 * head + 0.16 * block) + mix(uC3, vec3(1.0), 0.4) * rim * 1.1;
  float a = (0.55 + 0.45 * rim) * body * vFog * (vMirror > 0.5 ? 0.28 : 1.0);
  gl_FragColor = vec4(col, a);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      const walk = { value: 0 };
      const hand = new THREE.Vector2();
      const gust = { value: 0 };
      const box = new THREE.BoxGeometry(6, 3.8, 200);
      const walls = new THREE.Mesh(box, new THREE.ShaderMaterial({ vertexShader: WALL_VS, fragmentShader: WALL_FS, uniforms: withUniforms(kit, { uWalk: walk }), side: THREE.BackSide, toneMapped: false }));
      walls.position.z = -90;
      walls.frustumCulled = false;
      kit.scene.add(walls);
      const perSet = env.tier === 'low' ? 10 : 18;
      const total = perSet * 2;
      const plane = new THREE.PlaneGeometry(1, 1);
      const g = new THREE.InstancedBufferGeometry();
      g.index = plane.index;
      g.setAttribute('position', plane.getAttribute('position'));
      const iPos = new Float32Array(total * 3);
      const iSize = new Float32Array(total * 2);
      const iSeed = new Float32Array(total);
      const iMirror = new Float32Array(total);
      for (let i = 0; i < perSet; i++) {
        const seed = Math.random();
        const w = 1.0 + Math.random() * 0.9;
        const pos = [(Math.random() - 0.5) * 3.8, (Math.random() - 0.5) * 1.4 + 0.1, (i / perSet) * 60];
        for (const k of [0, 1]) {
          const at = i * 2 + k;
          iPos.set(pos, at * 3);
          iSize.set([w, w * 0.64], at * 2);
          iSeed[at] = seed;
          iMirror[at] = k;
        }
      }
      g.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
      g.setAttribute('iSize', new THREE.InstancedBufferAttribute(iSize, 2));
      g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iSeed, 1));
      g.setAttribute('iMirror', new THREE.InstancedBufferAttribute(iMirror, 1));
      g.instanceCount = total;
      const panels = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: PANEL_VS, fragmentShader: PANEL_FS, uniforms: withUniforms(kit, { uWalk: walk, uHand: { value: hand }, uGust: gust }), transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
      panels.frustumCulled = false;
      panels.renderOrder = 2;
      kit.scene.add(panels);
      let drift = 0;
      let lookX = 0;
      let lookY = 0;
      return {
        slabs: 0.85,
        update(_t, dt) {
          const p = env.pointer;
          if (p.drainPulses().length) gust.value = 1;
          gust.value *= Math.exp(-dt * 1.3);
          // Pushing the pointer walks you faster for a moment.
          drift += dt * (0.55 + p.energy * 2.2);
          walk.value = drift + bridge.scrollProgress * 60;
          hand.set((p.su - 0.5) * 6.4, (p.sv - 0.5) * 3.2);
          lookX += ((p.su - 0.5) * 1.6 * p.strength - lookX) * Math.min(1, dt * 3);
          lookY += ((p.sv - 0.5) * 0.9 * p.strength - lookY) * Math.min(1, dt * 3);
          kit.camera.position.set(lookX * 0.4, lookY * 0.2 + 0.05, 3);
          kit.camera.lookAt(lookX, lookY * 0.8, -10);
        },
      };
    },
    { fov: 60, z: 3 },
  );
export default make;
