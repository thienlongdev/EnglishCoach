import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_THREE_U, addSky, threeSpatial, withUniforms } from './kit';

/**
 * D01 Scroll Camera Path. A closed 3D rail through hoops of light. The camera's place on the rail is a pure function of the page's own native scroll (nothing is
 * hijacked) plus a very slow drift, smoothed by a spring; the view leans into the curve ahead and the pointer turns the head.
 */
const TUBE_VS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec3 vW; varying vec3 vN; varying vec2 vU;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = mat3(modelMatrix) * normal; vU = uv; gl_Position = projectionMatrix * viewMatrix * w; }`;
const TUBE_FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform float uHead;
varying vec3 vW; varying vec3 vN; varying vec2 vU;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float d = abs(fract(vU.x - uHead + 0.5) - 0.5);
  float pulse = exp(-d * 60.0);
  vec3 col = mix(uC2, uC3, 0.5 + 0.5 * sin(vU.x * 60.0 + uTime * 0.4));
  col *= 0.55 + 0.6 * pow(1.0 - max(dot(n, v), 0.0), 2.0);
  col += uC3 * pulse * 1.3;
  float far = smoothstep(4.0, 46.0, length(vW - cameraPosition));
  gl_FragColor = vec4(mix(col, uC0, far), 1.0);
}`;
const HOOP_VS = /* glsl */ `
attribute vec3 iPos; attribute vec4 iRot; attribute float iScale; attribute float iSeed;
${SPATIAL_THREE_U}
uniform float uKick;
varying vec3 vW; varying vec3 vN; varying float vSeed;
vec3 q(vec4 r, vec3 v) { return v + 2.0 * cross(r.xyz, cross(r.xyz, v) + r.w * v); }
void main() {
  // Hoops open wider and ring as you pick up speed; a press rings them all.
  float open = 1.0 + (uEnergy * 0.4 + uKick * 0.5) * (0.5 + 0.5 * sin(uTime * 7.0 + iSeed * 40.0));
  vec3 p = q(iRot, position * iScale * open) + iPos;
  vW = p; vN = q(iRot, normal); vSeed = iSeed;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const HOOP_FS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec3 vW; varying vec3 vN; varying float vSeed;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 1.6);
  vec3 col = mix(uC2, uC3, vSeed) * (0.5 + 1.1 * fres);
  float glow = 0.5 + 0.5 * sin(uTime * 0.7 + vSeed * 20.0);
  col += uC3 * glow * 0.25;
  float far = smoothstep(5.0, 48.0, length(vW - cameraPosition));
  gl_FragColor = vec4(mix(col, uC0, far), 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const points: THREE.Vector3[] = [];
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(a) * 34 + Math.sin(a * 3) * 7, Math.sin(a * 2) * 9, Math.sin(a) * 34 + Math.cos(a * 2) * 6));
      }
      const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
      const head = { value: 0 };
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 420, 0.03, 6, true), new THREE.ShaderMaterial({ vertexShader: TUBE_VS, fragmentShader: TUBE_FS, uniforms: withUniforms(kit, { uHead: head }), toneMapped: false }));
      tube.frustumCulled = false;
      kit.scene.add(tube);
      const kick = { value: 0 };
      const count = env.tier === 'low' ? 34 : 60;
      const torus = new THREE.TorusGeometry(1, 0.035, 10, 72);
      const g = new THREE.InstancedBufferGeometry();
      g.index = torus.index;
      g.setAttribute('position', torus.getAttribute('position'));
      g.setAttribute('normal', torus.getAttribute('normal'));
      const iPos = new Float32Array(count * 3);
      const iRot = new Float32Array(count * 4);
      const iScale = new Float32Array(count);
      const iSeed = new Float32Array(count);
      const quat = new THREE.Quaternion();
      const tangent = new THREE.Vector3();
      const z = new THREE.Vector3(0, 0, 1);
      for (let i = 0; i < count; i++) {
        const t = i / count;
        const p = curve.getPointAt(t);
        curve.getTangentAt(t, tangent);
        quat.setFromUnitVectors(z, tangent);
        iPos.set([p.x, p.y, p.z], i * 3);
        iRot.set(quat.toArray(), i * 4);
        iScale[i] = 2.2 + Math.sin(i * 1.7) * 0.8;
        iSeed[i] = Math.random();
      }
      g.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
      g.setAttribute('iRot', new THREE.InstancedBufferAttribute(iRot, 4));
      g.setAttribute('iScale', new THREE.InstancedBufferAttribute(iScale, 1));
      g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iSeed, 1));
      g.instanceCount = count;
      const hoops = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: HOOP_VS, fragmentShader: HOOP_FS, uniforms: withUniforms(kit, { uKick: kick }), toneMapped: false }));
      hoops.frustumCulled = false;
      kit.scene.add(hoops);
      const here = new THREE.Vector3();
      const ahead = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      let along = 0;
      let drift = 0;
      let lookX = 0;
      let lookY = 0;
      return {
        update(_t, dt) {
          // The pointer's speed is the throttle; a press is a burst of it.
          if (env.pointer.drainPulses().length) kick.value = 1;
          kick.value *= Math.exp(-dt * 1.5);
          drift += dt * (0.0035 + env.pointer.energy * 0.012 + kick.value * 0.02);
          const wanted = bridge.scrollProgress * 0.42 + drift;
          along += (wanted - along) * Math.min(1, dt * 3.4);
          const t = ((along % 1) + 1) % 1;
          curve.getPointAt(t, here);
          curve.getPointAt((t + 0.012) % 1, ahead);
          head.value = (t + 0.03) % 1;
          kit.camera.position.copy(here).add(new THREE.Vector3(0, 1.05, 0));
          const p = env.pointer;
          lookX += ((p.su - 0.5) * 7 * p.strength - lookX) * Math.min(1, dt * 3);
          lookY += ((p.sv - 0.5) * 4 * p.strength - lookY) * Math.min(1, dt * 3);
          kit.camera.up.copy(up);
          kit.camera.lookAt(ahead.x + lookX, ahead.y + 0.8 + lookY, ahead.z);
        },
      };
    },
    { fov: 62, z: 2 },
  );
export default make;
