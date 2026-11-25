import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { NOISE_3, SPATIAL_THREE_U, addSky, pointerAt, rayFrom, raySphere, threeSpatial, withUniforms } from './kit';

/**
 * B02 / I03 Crystal Refraction. Faceted crystals with real dispersion: the view ray is refracted three times with three indices of refraction
 * and each colour channel reads a different place of a procedural studio. Crystals lean on springs toward the pointer. Each one is also an object: the one under the pointer brightens and its facets
 * catch more light, and a press rings the crystals around it, which shiver and flare and settle. The composition I03 stands them in a tighter, slowly turning cluster that a stroke can spin.
 */
const VS = /* glsl */ `
attribute vec3 iPos; attribute vec4 iRot; attribute vec3 iScale; attribute float iSeed; attribute float iRing;
${SPATIAL_THREE_U}
uniform vec3 uLean;
uniform float uTurn;
varying vec3 vPos; varying vec3 vView; varying float vSeed; varying float vRing;
vec3 q(vec4 r, vec3 v) { return v + 2.0 * cross(r.xyz, cross(r.xyz, v) + r.w * v); }
void main() {
  vec3 p = position * iScale * (1.0 + iRing * 0.1 * sin(uTime * 26.0 + iSeed * 30.0));
  float spin = uTime * (0.05 + iSeed * 0.1) + iRing * 0.35;
  float cs = cos(spin), sn = sin(spin);
  p = vec3(cs * p.x - sn * p.z, p.y, sn * p.x + cs * p.z);
  p = q(iRot, p);
  vec3 lean = uLean * (0.4 + iSeed);
  p.xy += lean.xy * p.z * 0.35;
  p.z += dot(lean.xy, p.xy) * 0.25;
  float ct = cos(uTurn), st = sin(uTurn);
  vec3 home = vec3(ct * iPos.x + st * (iPos.z + 4.0), iPos.y, -st * iPos.x + ct * (iPos.z + 4.0) - 4.0);
  vec3 world = p + home + vec3(0.0, sin(uTime * 0.3 + iSeed * 20.0) * 0.18, 0.0);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vPos = world; vView = cameraPosition - world; vSeed = iSeed; vRing = iRing;
  gl_Position = projectionMatrix * mv;
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
${NOISE_3}
uniform vec3 uLight;
varying vec3 vPos; varying vec3 vView; varying float vSeed; varying float vRing;
vec3 studio(vec3 d) {
  float up = d.y * 0.5 + 0.5;
  vec3 col = mix(uC0 * 1.4, uC1 * 1.5, up);
  float bars = sin(d.x * 7.0 + d.y * 3.0 + uTime * 0.12);
  col += uC2 * smoothstep(0.7, 1.0, bars) * 0.9;
  col += uC3 * smoothstep(0.92, 1.0, sin(d.y * 11.0 - d.x * 5.0 - uTime * 0.09)) * 1.2;
  return col;
}
void main() {
  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
  vec3 v = normalize(vView);
  if (dot(n, v) < 0.0) n = -n;
  float spread = 0.03 + 0.05 * uMaterial;
  vec3 col = vec3(
    studio(refract(-v, n, 1.0 / (1.42 - spread))).r,
    studio(refract(-v, n, 1.0 / 1.42)).g,
    studio(refract(-v, n, 1.0 / (1.42 + spread))).b
  );
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  col = mix(col, studio(reflect(-v, n)), fres * 0.75);
  vec3 l = normalize(uLight - vPos);
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 120.0);
  col += vec3(1.0) * spec * 1.6;
  col += uC3 * pow(max(dot(n, l), 0.0), 8.0) * 0.26;
  col = mix(col, col * vec3(0.92, 0.96, 1.05), vSeed);
  col *= 1.0 + vRing * 0.65;
  col += uC3 * vRing * 0.14;
  gl_FragColor = vec4(col, 1.0);
}`;

function randomQuat(): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28));
}

const make: SpatialSceneFactory = (env, bridge, opts, palette) =>
  threeSpatial(env, bridge, palette, (kit) => {
    addSky(kit);
    const count = Math.round((opts.dense ? 34 : 22) * (env.tier === 'low' ? 0.6 : 1));
    const base = new THREE.IcosahedronGeometry(1, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', base.getAttribute('position'));
    const iPos = new Float32Array(count * 3);
    const iRot = new Float32Array(count * 4);
    const iScale = new Float32Array(count * 3);
    const iSeed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const ring = 2.6 + Math.random() * 6.2;
      if (opts.dense) iPos.set([Math.cos(angle) * ring * 0.8, Math.sin(angle * 1.3) * (1 + Math.random() * 2.4), Math.sin(angle) * ring * 0.8 - 4], i * 3);
      else iPos.set([Math.cos(angle) * ring * 1.5, Math.sin(angle * 1.3) * (1.5 + Math.random() * 3.2), -Math.random() * 7 - 1], i * 3);
      iRot.set(randomQuat().toArray(), i * 4);
      const s = 0.45 + Math.random() * Math.random() * 1.5;
      iScale.set([s * 0.72, s * (1.2 + Math.random() * 0.9), s * 0.72], i * 3);
      iSeed[i] = Math.random();
    }
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
    g.setAttribute('iRot', new THREE.InstancedBufferAttribute(iRot, 4));
    g.setAttribute('iScale', new THREE.InstancedBufferAttribute(iScale, 3));
    g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iSeed, 1));
    const iRing = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iRing', iRing);
    g.instanceCount = count;
    const own = { uLean: { value: new THREE.Vector3() }, uLight: { value: new THREE.Vector3(4, 5, 7) }, uTurn: { value: 0 } };
    const material = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, own), toneMapped: false });
    const mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    kit.scene.add(mesh);
    const lean = { x: 0, y: 0, vx: 0, vy: 0 };
    const hit = new THREE.Vector3();
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const heat = new Float32Array(count);
    const probe = { touched: -1, rung: 0 };
    bridge.probe = probe;
    let spin = 0;
    let turn = 0;
    return {
      update(t, dt) {
        const p = env.pointer;
        // A stroke turns the cluster of the composition, which keeps its momentum.
        if (opts.dense) {
          spin += p.vx * p.strength * dt * 0.9;
          spin *= Math.exp(-dt * 0.8);
          turn += (spin + 0.03) * dt;
          own.uTurn.value = turn;
        }
        // The crystal under the pointer, by a ray against each one (sphere of its size).
        kit.camera.updateMatrixWorld();
        rayFrom(kit, p.u, p.v, origin, dir);
        let touched = -1;
        let bestT = 1e9;
        const ct = Math.cos(turn);
        const st = Math.sin(turn);
        const place = (i: number) => {
          const x = iPos[i * 3];
          const z = iPos[i * 3 + 2];
          return [ct * x + st * (z + 4), iPos[i * 3 + 1] + Math.sin(t * 0.3 + iSeed[i] * 20) * 0.18, -st * x + ct * (z + 4) - 4];
        };
        if (p.strength > 0.01) {
          for (let i = 0; i < count; i++) {
            const c = place(i);
            const d = raySphere(origin, dir, c[0], c[1], c[2], iScale[i * 3 + 1] * 0.8);
            if (d > 0 && d < bestT) {
              bestT = d;
              touched = i;
            }
          }
        }
        probe.touched = touched;
        const pulses = p.drainPulses();
        for (const pulse of pulses) {
          rayFrom(kit, pulse.u, pulse.v, origin, dir);
          for (let i = 0; i < count; i++) {
            const c = place(i);
            const b = (c[0] - origin.x) * dir.x + (c[1] - origin.y) * dir.y + (c[2] - origin.z) * dir.z;
            const off = Math.hypot(origin.x + dir.x * b - c[0], origin.y + dir.y * b - c[1], origin.z + dir.z * b - c[2]);
            if (off < 4.2) {
              heat[i] = Math.max(heat[i], 1 - off / 4.2);
              probe.rung += 1;
            }
          }
        }
        for (let i = 0; i < count; i++) {
          const floor = i === touched ? 0.34 : 0;
          heat[i] = heat[i] > floor ? floor + (heat[i] - floor) * Math.exp(-dt * 1.8) : heat[i] + (floor - heat[i]) * Math.min(1, dt * 7);
          iRing.setX(i, heat[i]);
        }
        iRing.needsUpdate = true;
        const tx = (p.su - 0.5) * 2 * p.strength;
        const ty = (p.sv - 0.5) * 2 * p.strength;
        lean.vx += ((tx - lean.x) * 16 - lean.vx * 3.4) * dt;
        lean.vy += ((ty - lean.y) * 16 - lean.vy * 3.4) * dt;
        lean.x += lean.vx * dt;
        lean.y += lean.vy * dt;
        own.uLean.value.set(lean.x, lean.y, 0);
        pointerAt(kit, 2, hit);
        own.uLight.value.set(hit.x, hit.y, 5);
        kit.camera.position.x = lean.x * 0.5;
        kit.camera.position.y = lean.y * 0.3 - bridge.scrollProgress * 1.4;
        kit.camera.lookAt(0, -bridge.scrollProgress * 1.4, -3);
      },
    };
  });
export default make;
