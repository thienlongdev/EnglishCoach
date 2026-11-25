import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_THREE_U, addSky, threeSpatial, withUniforms } from './kit';

/**
 * B06 Frosted Glass Physics. A helix of frosted bars drawn in one call. Each bar has its own spring (CPU), struck when the pointer sweeps across
 * it: picking projects each bar's centre to the screen and tests the pointer's path, so no triangle work. Scrolling is a conveyor around the helix.
 * Frost: the backdrop is smooth by construction and looked up through the bar's normal, with fresnel and thin film at the edges. No sound.
 */
const VS = /* glsl */ `
attribute vec3 iPos; attribute float iAngle; attribute float iSwing; attribute float iSeed;
${SPATIAL_THREE_U}
varying vec3 vN; varying vec3 vWorld; varying vec4 vClip; varying float vSwing; varying float vSeed;
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0., -s, 0., 1., 0., s, 0., c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0., -s, c, 0., 0., 0., 1.); }
void main() {
  mat3 r = rotY(iAngle) * rotZ(0.32 + iSwing);
  vec3 p = r * position + iPos;
  vN = r * normal;
  vWorld = p;
  vSwing = iSwing; vSeed = iSeed;
  vClip = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_Position = vClip;
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform vec3 uLight;
varying vec3 vN; varying vec3 vWorld; varying vec4 vClip; varying float vSwing; varying float vSeed;
vec3 behind(vec2 s) {
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 1.0, s.y));
  vec2 a = vec2(0.3 + 0.2 * sin(uTime * 0.13), 0.65 + 0.2 * cos(uTime * 0.11));
  vec2 b = vec2(0.75 + 0.15 * cos(uTime * 0.09), 0.3 + 0.2 * sin(uTime * 0.17));
  col = mix(col, uC2, exp(-dot(s - a, s - a) * 5.0) * 0.85);
  col = mix(col, uC3, exp(-dot(s - b, s - b) * 7.0) * 0.8);
  col = mix(col, uC3, exp(-dot(s - uMouse, s - uMouse) * 16.0) * 0.6 * uStrength);
  return col;
}
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vWorld);
  float cosV = max(dot(n, v), 0.0);
  vec2 s = vClip.xy / vClip.w * 0.5 + 0.5;
  vec3 col = behind(s + n.xy * (0.05 + 0.08 * uMaterial));
  float fres = pow(1.0 - cosV, 2.4);
  vec3 film = 0.5 + 0.5 * cos(6.283 * (fres * 1.6 + vSeed * 0.6 + vec3(0.0, 0.33, 0.67)));
  col = mix(col, film, fres * 0.3);
  col += mix(vec3(1.0), uC3, 0.3) * fres * 0.5;
  vec3 l = normalize(uLight - vWorld);
  col *= 0.82 + 0.3 * max(dot(n, l), 0.0);
  col += vec3(1.0) * pow(max(dot(reflect(-l, n), v), 0.0), 40.0) * 0.55;
  col += uC3 * abs(vSwing) * 1.1;
  gl_FragColor = vec4(col, 0.72 + 0.28 * fres);
}`;
const SKY = /* glsl */ `varying vec2 vUv; ${SPATIAL_THREE_U}
void main() {
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 1.0, vUv.y));
  vec2 a = vec2(0.3 + 0.2 * sin(uTime * 0.13), 0.65 + 0.2 * cos(uTime * 0.11));
  vec2 b = vec2(0.75 + 0.15 * cos(uTime * 0.09), 0.3 + 0.2 * sin(uTime * 0.17));
  col = mix(col, uC2, exp(-dot(vUv - a, vUv - a) * 5.0) * 0.4);
  col = mix(col, uC3, exp(-dot(vUv - b, vUv - b) * 7.0) * 0.32);
  gl_FragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit, SKY);
      const count = env.tier === 'low' ? 44 : 72;
      const base = new THREE.BoxGeometry(3.6, 0.3, 0.7, 1, 1, 1);
      const g = new THREE.InstancedBufferGeometry();
      g.index = base.index;
      g.setAttribute('position', base.getAttribute('position'));
      g.setAttribute('normal', base.getAttribute('normal'));
      const iPos = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
      const iAngle = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      const iSwing = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      const iSeed = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      for (let i = 0; i < count; i++) iSeed.array[i] = Math.random();
      iPos.setUsage(THREE.DynamicDrawUsage);
      iAngle.setUsage(THREE.DynamicDrawUsage);
      iSwing.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('iPos', iPos);
      g.setAttribute('iAngle', iAngle);
      g.setAttribute('iSwing', iSwing);
      g.setAttribute('iSeed', iSeed);
      g.instanceCount = count;
      const light = new THREE.Vector3(3, 4, 7);
      const material = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: true, toneMapped: false, uniforms: withUniforms(kit, { uLight: { value: light } }) });
      const mesh = new THREE.Mesh(g, material);
      mesh.frustumCulled = false;
      kit.scene.add(mesh);
      const swing = new Float32Array(count);
      const velocity = new Float32Array(count);
      const pos = new THREE.Vector3();
      let phase = 0;
      let lastU = 0.5;
      let lastV = 0.5;
      return {
        update(t, dt) {
          phase += dt * 0.05 + bridge.scrollVelocity * dt * 0.8;
          const pt = env.pointer;
          const span = 22;
          const radius = 3.1;
          kit.camera.position.set(Math.sin(t * 0.05) * 0.8, 0, 11);
          kit.camera.lookAt(0, 0, 0);
          kit.camera.updateMatrixWorld();
          const moved = Math.hypot(pt.u - lastU, pt.v - lastV);
          for (let i = 0; i < count; i++) {
            const f = (i / count + phase + 1000) % 1;
            const y = (f - 0.5) * span;
            const a = (i / count) * Math.PI * 14 + phase * 6;
            const x = Math.cos(a) * radius;
            const z = Math.sin(a) * radius;
            iPos.setXYZ(i, x, y, z);
            iAngle.setX(i, -a);
            // Picking: one distance test per bar along the pointer's path.
            if (moved > 0.0006 && pt.strength > 0.01) {
              pos.set(x, y, z).project(kit.camera);
              const dx = pos.x * 0.5 + 0.5 - pt.u;
              const dy = (pos.y * 0.5 + 0.5 - pt.v) * 1.2;
              if (dx * dx + dy * dy < 0.012) velocity[i] += Math.min(moved * 150, 3.4) * pt.strength * (z > 0 ? 1 : 0.4) * (pt.vy > 0 ? 1 : -1);
            }
            velocity[i] += (-swing[i] * 64 - velocity[i] * 3.2) * dt;
            swing[i] += velocity[i] * dt;
            iSwing.setX(i, swing[i]);
          }
          lastU = pt.u;
          lastV = pt.v;
          iPos.needsUpdate = true;
          iAngle.needsUpdate = true;
          iSwing.needsUpdate = true;
          light.set((pt.su - 0.5) * 12, (pt.sv - 0.5) * 8, 6);
        },
      };
    },
    { fov: 38, z: 11 },
  );
export default make;
