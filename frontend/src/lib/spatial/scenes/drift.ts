import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_THREE_U, addSky, pointerAt, threeSpatial, withUniforms } from './kit';

/**
 * H04 Floating Panels. Behind the real panels, more panels: small rounded sheets hung at several depths, with inertia of their own against the native scroll, so the page itself reads as the nearest
 * layer of a deep stack. Drawn in one instanced call; the rounded corners and the thin lit edge are computed in the fragment shader.
 */
const VS = /* glsl */ `
attribute vec3 iPos; attribute vec2 iSize; attribute float iSeed;
${SPATIAL_THREE_U}
uniform float uLag;
uniform vec3 uHand;
uniform float uPush;
varying vec2 vP; varying vec2 vSize; varying float vDepth; varying float vSeed;
void main() {
  float depth = clamp(-iPos.z / 16.0, 0.0, 1.0);
  vec3 c = iPos;
  c.y += uLag * (1.0 - depth) * 4.0 + uScroll * (2.0 + (1.0 - depth) * 12.0);
  c.y = mod(c.y + 13.0, 26.0) - 13.0;
  c.x += (uMouse.x - 0.5) * (1.0 - depth) * 2.0 * uStrength;
  c.y += sin(uTime * 0.3 + iSeed * 30.0) * 0.2;
  // Sheets hang in air: the pointer moves them aside and turns them, the near ones most; a press pushes the whole stack away.
  vec2 off = c.xy - uHand.xy;
  float fall = exp(-dot(off, off) * 0.09) * (1.0 - depth * 0.7);
  c.xy += normalize(off + 1e-3) * fall * uStrength * (1.3 + uEnergy * 2.6);
  c.z -= fall * uStrength * 1.2 + uPush * (1.0 - depth) * 3.0 * exp(-dot(off, off) * 0.02);
  float tilt = sin(uTime * 0.15 + iSeed * 20.0) * 0.14 + uScrollVel * 0.5 + fall * uStrength * 0.6 * sign(off.y + 0.001);
  vec3 p = position * vec3(iSize, 1.0);
  float ct = cos(tilt), st = sin(tilt);
  p = vec3(p.x, ct * p.y, st * p.y);
  vP = position.xy * iSize;
  vSize = iSize * 0.5;
  vDepth = depth;
  vSeed = iSeed;
  gl_Position = projectionMatrix * viewMatrix * vec4(c + p, 1.0);
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec2 vP; varying vec2 vSize; varying float vDepth; varying float vSeed;
void main() {
  vec2 q = abs(vP) - vSize + 0.12;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.12;
  float aa = fwidth(d);
  float body = 1.0 - smoothstep(-aa, aa, d);
  if (body < 0.01) discard;
  float rim = 1.0 - smoothstep(0.0, aa * 1.6, abs(d + aa));
  vec3 tone = mix(uC1, uC2, 0.3 + vSeed * 0.4);
  vec3 col = mix(tone, uC0, vDepth * 0.72);
  float lines = step(0.5, fract(vP.y * 3.0 + vSeed * 4.0)) * step(abs(vP.x + vSize.x * 0.2), vSize.x * 0.62) * step(abs(vP.y), vSize.y * 0.66);
  col = mix(col, mix(col, uC3, 0.3), lines * (1.0 - vDepth) * 0.6);
  col += uC3 * rim * (1.0 - vDepth) * 0.6;
  gl_FragColor = vec4(col, body * mix(0.92, 0.5, vDepth));
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const count = env.tier === 'low' ? 30 : 64;
      const plane = new THREE.PlaneGeometry(1, 1);
      const g = new THREE.InstancedBufferGeometry();
      g.index = plane.index;
      g.setAttribute('position', plane.getAttribute('position'));
      const iPos = new Float32Array(count * 3);
      const iSize = new Float32Array(count * 2);
      const iSeed = new Float32Array(count);
      const order = Array.from({ length: count }, (_v, i) => i).sort((a, b) => a - b);
      for (const i of order) {
        const depth = (1 - i / count) * 16;
        iPos.set([(Math.random() - 0.5) * 30, (Math.random() - 0.5) * 26, -depth], i * 3);
        const w = 1.4 + Math.random() * 3.2;
        iSize.set([w, w * (0.45 + Math.random() * 0.5)], i * 2);
        iSeed[i] = Math.random();
      }
      g.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
      g.setAttribute('iSize', new THREE.InstancedBufferAttribute(iSize, 2));
      g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iSeed, 1));
      g.instanceCount = count;
      const hand = new THREE.Vector3();
      const own = { uLag: { value: 0 }, uHand: { value: hand }, uPush: { value: 0 } };
      const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, own), transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      kit.scene.add(mesh);
      return {
        slabs: 1.1,
        update(_t, dt) {
          own.uLag.value += (Math.max(-1, Math.min(1, bridge.scrollVelocity)) - own.uLag.value) * Math.min(1, dt * 2.2);
          pointerAt(kit, -6, hand);
          if (env.pointer.drainPulses().length) own.uPush.value = 1;
          own.uPush.value *= Math.exp(-dt * 1.6);
        },
      };
    },
    { fov: 42, z: 15 },
  );
export default make;
