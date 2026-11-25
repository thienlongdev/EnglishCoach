import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { NOISE_3, SPATIAL_THREE_U, addSky, pointerAt, threeSpatial, withUniforms } from './kit';

/**
 * G06 Spatial Particle Interaction. A 3D cloud that streams along a curl field, computed per vertex in the shader from the particle's seed and the time (stateless, so a very large cloud costs no
 * CPU). The pointer opens a real vortex in it: particles near it turn around the view axis, with depth-of-field in their size. A press pushes the cloud away.
 */
const VS = /* glsl */ `
attribute float aSeed; attribute vec3 aDrift;
${SPATIAL_THREE_U}
${NOISE_3}
uniform vec3 uEye;
uniform float uPush;
uniform float uPx;
varying float vA; varying float vTone; varying float vBlur;
vec3 curl(vec3 p) {
  float e = 0.1;
  float a = n3(p + vec3(0.0, e, 0.0)) - n3(p - vec3(0.0, e, 0.0));
  float b = n3(p + vec3(0.0, 0.0, e)) - n3(p - vec3(0.0, 0.0, e));
  float c = n3(p + vec3(e, 0.0, 0.0)) - n3(p - vec3(e, 0.0, 0.0));
  float d = n3(p.yzx + vec3(e, 0.0, 0.0)) - n3(p.yzx - vec3(e, 0.0, 0.0));
  return normalize(vec3(a - b, b - c, c - d) + 1e-4);
}
void main() {
  float t = uTime * (0.04 + aSeed * 0.06);
  vec3 p = position;
  float spin = uTime * 0.05 / (0.4 + length(p.xy) * 0.08);
  float cp = cos(spin), sp = sin(spin);
  p.xy = vec2(cp * p.x - sp * p.y, sp * p.x + cp * p.y);
  p += curl(p * 0.14 + t) * (0.5 + aSeed * 0.9);
  p += aDrift * sin(uTime * 0.2 + aSeed * 30.0) * 0.5;
  vec3 d = p - uEye;
  float r2 = dot(d.xy, d.xy);
  float swirl = exp(-r2 * 0.05) * (0.3 + uEnergy * 1.6) * uStrength;
  float ang = swirl * (2.0 + uTime * 0.3 * (0.5 + aSeed));
  float cs = cos(ang), sn = sin(ang);
  d.xy = vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
  d.xy *= 1.0 - 0.3 * exp(-r2 * 0.1) * uStrength;
  d.xy += normalize(d.xy + 1e-3) * uPush * exp(-r2 * 0.02) * 6.0;
  p = d + uEye;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  float focus = abs(dist - 14.0);
  vBlur = clamp(focus * 0.12, 0.0, 1.0);
  gl_PointSize = uPx * (1.5 + aSeed * 1.6 + vBlur * 9.0) * (14.0 / max(dist, 1.0));
  vA = mix(0.95, 0.14, vBlur) * smoothstep(40.0, 18.0, dist);
  vTone = aSeed + swirl * 0.6;
  gl_Position = projectionMatrix * mv;
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
varying float vA; varying float vTone; varying float vBlur;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, mix(0.2, 0.0, vBlur), length(c)) * vA;
  vec3 col = mix(uC2, uC3, clamp(vTone, 0.0, 1.0));
  gl_FragColor = vec4(col, a * mix(0.7, 0.85, uDark));
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const count = env.tier === 'low' ? 12000 : env.tier === 'balanced' ? 28000 : 52000;
      const pos = new Float32Array(count * 3);
      const seed = new Float32Array(count);
      const drift = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        // Three arms of a slow spiral, thin in depth, thicker toward the middle.
        const arm = i % 3;
        const r = 1 + Math.pow(Math.random(), 0.7) * 17;
        const a = (arm / 3) * Math.PI * 2 + r * 0.46 + (Math.random() - 0.5) * (0.2 + 1.5 / r);
        const lift = (Math.random() - 0.5) * (5 / (1 + r * 0.25));
        pos.set([Math.cos(a) * r * 1.3, Math.sin(a) * r * 0.82, lift - 1], i * 3);
        seed[i] = Math.random();
        drift.set([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aDrift', new THREE.BufferAttribute(drift, 3));
      const eye = new THREE.Vector3();
      const own = { uEye: { value: eye }, uPush: { value: 0 }, uPx: { value: env.pixelRatio || 1 } };
      const points = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, own), transparent: true, depthWrite: false, blending: env.params.dark ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false }));
      points.frustumCulled = false;
      kit.scene.add(points);
      return {
        update(_t, dt) {
          const p = env.pointer;
          pointerAt(kit, 0, eye);
          if (p.drainPulses().length) own.uPush.value = 1;
          own.uPush.value *= Math.exp(-dt * 2.2);
          own.uPx.value = env.pixelRatio || 1;
          (points.material as THREE.ShaderMaterial).blending = kit.palette.dark > 0.5 ? THREE.AdditiveBlending : THREE.NormalBlending;
          kit.camera.position.y = -bridge.scrollProgress * 3;
          kit.camera.position.x = (p.su - 0.5) * 1.4 * p.strength;
          kit.camera.lookAt(0, -bridge.scrollProgress * 3, 0);
        },
      };
    },
    { fov: 44, z: 15 },
  );
export default make;
