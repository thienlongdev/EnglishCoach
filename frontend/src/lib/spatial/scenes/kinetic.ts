import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_THREE_U, addSky, threeSpatial, withUniforms } from './kit';

/**
 * C04 / I06 Kinetic Sculpture. An original wind sculpture: concentric rings of curved blades turning against each other on one axis, the way a kinetic
 * artwork turns wind into a moving moire. Each ring has real angular momentum: the pointer's speed is wind, bearing friction slows it.
 */
const RINGS = 7;
const VS = /* glsl */ `
attribute float iRing; attribute float iAngle; attribute float iTwist;
${SPATIAL_THREE_U}
uniform float uSpin[${RINGS}];
varying vec3 vN; varying vec3 vW; varying float vRing;
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0., -s, c, 0., 0., 0., 1.); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0., -s, 0., 1., 0., s, 0., c); }
void main() {
  float radius = 1.3 + iRing * 1.05;
  vec3 p = position;
  // the blade curves along its length
  p.z += sin(p.y * 1.6) * 0.26;
  mat3 twist = rotY(iTwist + sin(uSpin[int(iRing)] * 2.0 + iAngle * 3.0) * 0.35);
  mat3 around = rotZ(iAngle + uSpin[int(iRing)]);
  vec3 w = around * (twist * p + vec3(0.0, radius, 0.0));
  w.z += sin(iRing * 1.3 + uTime * 0.2) * 0.5 - iRing * 0.42;
  vN = around * (twist * normal);
  vW = w;
  vRing = iRing;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec3 vN; varying vec3 vW; varying float vRing;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  if (dot(n, v) < 0.0) n = -n;
  vec3 l = normalize(vec3(-0.3, 0.7, 0.65));
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 48.0);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 base = mix(uC2, uC3, fract(vRing * 0.37));
  vec3 col = base * (0.2 + 0.85 * diff) + vec3(1.0) * spec * 0.9 + uC3 * fres * 0.5;
  gl_FragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, opts, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const blade = new THREE.BoxGeometry(0.62, 0.98, 0.05, 1, 8, 1);
      const per = opts.dense ? 34 : 26;
      const total = per * RINGS;
      const g = new THREE.InstancedBufferGeometry();
      g.index = blade.index;
      g.setAttribute('position', blade.getAttribute('position'));
      g.setAttribute('normal', blade.getAttribute('normal'));
      const ring = new Float32Array(total);
      const angle = new Float32Array(total);
      const twist = new Float32Array(total);
      for (let r = 0; r < RINGS; r++) {
        for (let i = 0; i < per; i++) {
          const k = r * per + i;
          ring[k] = r;
          angle[k] = (i / per) * Math.PI * 2;
          twist[k] = 0.85 * (r % 2 ? -1 : 1);
        }
      }
      g.setAttribute('iRing', new THREE.InstancedBufferAttribute(ring, 1));
      g.setAttribute('iAngle', new THREE.InstancedBufferAttribute(angle, 1));
      g.setAttribute('iTwist', new THREE.InstancedBufferAttribute(twist, 1));
      g.instanceCount = total;
      const spins = new Array(RINGS).fill(0).map((_v, i) => i * 0.4);
      const speeds = new Array(RINGS).fill(0);
      const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, { uSpin: { value: spins } }), toneMapped: false, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      const group = new THREE.Group();
      group.add(mesh);
      kit.scene.add(group);
      return {
        update(_t, dt) {
          const p = env.pointer;
          const wind = p.energy * 3.4;
          for (let r = 0; r < RINGS; r++) {
            const dir = r % 2 ? -1 : 1;
            const breeze = 0.09 + 0.03 * r;
            speeds[r] += (dir * (breeze + wind / (1 + r * 0.35)) - speeds[r]) * Math.min(1, dt * (wind > 0.1 ? 3 : 0.5));
            spins[r] += speeds[r] * dt;
          }
          const scroll = bridge.scrollVelocity * 1.2;
          for (let r = 0; r < RINGS; r++) spins[r] += scroll * dt * (r % 2 ? -1 : 1);
          group.rotation.y += ((p.su - 0.5) * 0.8 * p.strength - 0.26 - group.rotation.y) * Math.min(1, dt * 2);
          group.rotation.x += (-(p.sv - 0.5) * 0.5 * p.strength + 0.12 - group.rotation.x) * Math.min(1, dt * 2);
          group.position.x = env.cssWidth > 900 ? 2.2 : 0;
          group.position.y = -bridge.scrollProgress * 2;
        },
      };
    },
    { fov: 40, z: 15 },
  );
export default make;
