import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_THREE_U, addSky, pointerAt, threeSpatial, withUniforms } from './kit';

/**
 * C03 Magnetic Objects. A field of metal needles, one instanced draw. Each one orients in the vertex shader to the pointer's field; the DOM cards bend
 * that field (the gradient of the card texture is added to it), so the pattern flows around the real interface. A press flips the polarity.
 */
const VS = /* glsl */ `
attribute vec2 iGrid; attribute float iSeed;
${SPATIAL_THREE_U}
uniform vec3 uPole;
uniform float uPolarity;
varying vec3 vN; varying vec3 vW; varying float vNear; varying float vSeed;
void main() {
  vec3 rest = vec3(iGrid, -1.0 + iSeed * 0.6);
  vec4 clip = projectionMatrix * viewMatrix * vec4(rest, 1.0);
  vec2 s = clamp(clip.xy / clip.w * 0.5 + 0.5, 0.0, 1.0);
  vec2 e = vec2(0.012, 0.02);
  vec2 grad = vec2(texture2D(uField, s + vec2(e.x, 0.0)).r - texture2D(uField, s - vec2(e.x, 0.0)).r,
                   texture2D(uField, s + vec2(0.0, e.y)).r - texture2D(uField, s - vec2(0.0, e.y)).r);
  vec3 toPole = uPole - rest;
  float d = length(toPole);
  float near = exp(-d * d * 0.03) * max(uStrength, 0.0);
  vec3 idle = normalize(vec3(sin(iGrid.y * 0.3 + uTime * 0.2), cos(iGrid.x * 0.26 - uTime * 0.16), 0.5));
  vec3 dir = mix(idle, normalize(toPole) * uPolarity, clamp(near * 3.0 + 0.15, 0.0, 1.0));
  dir.xy += grad * 7.0;
  dir = normalize(dir);
  vec3 up = abs(dir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 side = normalize(cross(up, dir));
  vec3 other = cross(dir, side);
  float grow = 1.0 + near * 1.3;
  vec3 local = position * vec3(1.0, grow, 1.0);
  vec3 w = rest + side * local.x + dir * local.y + other * local.z;
  vN = side * normal.x + dir * normal.y + other * normal.z;
  vW = w;
  vNear = near;
  vSeed = iSeed;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec3 vN; varying vec3 vW; varying float vNear; varying float vSeed;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  vec3 l = normalize(vec3(0.3, 0.75, 0.6));
  float diff = dot(n, l) * 0.5 + 0.5;
  // brushed metal: a broad and a tight highlight
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 30.0);
  vec3 base = mix(uC1, uC2, 0.55 + 0.45 * diff);
  vec3 col = base * (0.35 + 0.8 * diff) + mix(vec3(1.0), uC3, 0.3) * spec * 0.8;
  col = mix(col, uC3, clamp(vNear * 1.2, 0.0, 0.85));
  gl_FragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const cols = env.tier === 'low' ? 50 : env.tier === 'balanced' ? 72 : 96;
      const rows = Math.round(cols * 0.56);
      const needle = new THREE.CapsuleGeometry(0.052, 0.42, 3, 8);
      const g = new THREE.InstancedBufferGeometry();
      g.index = needle.index;
      g.setAttribute('position', needle.getAttribute('position'));
      g.setAttribute('normal', needle.getAttribute('normal'));
      const n = cols * rows;
      const grid = new Float32Array(n * 2);
      const seed = new Float32Array(n);
      const spread = 0.34;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i;
          grid[k * 2] = (i - cols / 2 + (j % 2) * 0.5) * spread;
          grid[k * 2 + 1] = (j - rows / 2) * spread;
          seed[k] = Math.random();
        }
      }
      g.setAttribute('iGrid', new THREE.InstancedBufferAttribute(grid, 2));
      g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 1));
      g.instanceCount = n;
      const pole = new THREE.Vector3(0, 0, 0);
      const own = { uPole: { value: pole }, uPolarity: { value: 1 } };
      const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, own), toneMapped: false }));
      mesh.frustumCulled = false;
      kit.scene.add(mesh);
      let polarity = 1;
      let wanted = 1;
      return {
        update(t, dt) {
          const p = env.pointer;
          if (p.drainPulses().length) wanted = -wanted;
          polarity += (wanted - polarity) * Math.min(1, dt * 6);
          own.uPolarity.value = polarity;
          if (p.strength > 0.01) {
            pointerAt(kit, -0.8, pole);
            pole.z = 0.9;
          } else {
            pole.set(Math.sin(t * 0.21) * 7, Math.cos(t * 0.17) * 4, 1);
          }
          kit.camera.position.y = -bridge.scrollProgress * 1.8;
          kit.camera.lookAt(0, -bridge.scrollProgress * 1.8, 0);
        },
      };
    },
    { fov: 38, z: 15 },
  );
export default make;
