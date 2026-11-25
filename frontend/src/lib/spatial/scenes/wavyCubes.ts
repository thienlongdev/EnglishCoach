import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_THREE_U, addSky, makeWave, threeSpatial, withUniforms } from './kit';

/**
 * C01 Wavy Cubes. Thousands of real cubes in one draw. Their height is read in the vertex shader from a real wave equation running in screen space,
 * with the DOM cards as walls: a wave started by the pointer travels under the page and comes back from the cards.
 */
const VS = /* glsl */ `
attribute vec2 iGrid; attribute float iSeed;
${SPATIAL_THREE_U}
uniform sampler2D uWave;
varying vec3 vN; varying vec3 vW; varying float vH; varying vec2 vG; varying float vTop;
void main() {
  vec3 rest = vec3(iGrid.x, 0.0, iGrid.y);
  vec4 clip = projectionMatrix * viewMatrix * vec4(rest, 1.0);
  vec2 s = clamp(clip.xy / clip.w * 0.5 + 0.5, 0.0, 1.0);
  float wave = texture2D(uWave, s).r;
  float swell = sin(iGrid.x * 0.42 + uTime * 0.55) * cos(iGrid.y * 0.36 - uTime * 0.42) * 0.42 + sin((iGrid.x + iGrid.y) * 0.16 + uTime * 0.3) * 0.5;
  float cards = texture2D(uField, s).r;
  float h = swell * (0.4 + 0.6 * uDepth) + wave * 9.0 - cards * 0.55;
  vec3 p = position;
  float tall = 1.0 + max(h, -0.6) * 0.0;
  p.y = p.y * tall;
  vec3 w = rest + p + vec3(0.0, h, 0.0);
  vN = normal;
  vW = w;
  vH = h;
  vG = iGrid;
  vTop = step(0.5, normal.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec3 vN; varying vec3 vW; varying float vH; varying vec2 vG; varying float vTop;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float across = smoothstep(-18.0, 18.0, vG.x * 0.7 + vG.y * 0.7);
  vec3 base = mix(uC2, uC3, across);
  base = mix(uC1, base, 0.55 + 0.45 * smoothstep(-0.8, 1.4, vH));
  vec3 l = normalize(vec3(0.35, 0.82, 0.44));
  float diff = max(dot(n, l), 0.0);
  vec3 col = base * (0.28 + 0.86 * diff);
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 26.0);
  col += mix(uC3, vec3(1.0), 0.5) * spec * 0.35 * vTop;
  float far = smoothstep(10.0, 42.0, length(vW - cameraPosition));
  col = mix(col, uC0, far);
  gl_FragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const cols = env.tier === 'low' ? 56 : env.tier === 'balanced' ? 84 : 118;
      const rows = Math.round(cols * 0.72);
      const spacing = 0.62;
      const box = new THREE.BoxGeometry(0.54, 0.54, 0.54);
      const g = new THREE.InstancedBufferGeometry();
      g.index = box.index;
      g.setAttribute('position', box.getAttribute('position'));
      g.setAttribute('normal', box.getAttribute('normal'));
      const n = cols * rows;
      const grid = new Float32Array(n * 2);
      const seed = new Float32Array(n);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i;
          grid[k * 2] = (i - cols / 2) * spacing;
          grid[k * 2 + 1] = (j - rows / 2) * spacing;
          seed[k] = Math.random();
        }
      }
      g.setAttribute('iGrid', new THREE.InstancedBufferAttribute(grid, 2));
      g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 1));
      g.instanceCount = n;
      const wave = makeWave(env, { damp: 0.994, walls: 1, force: 1 });
      const waveTex = new THREE.ExternalTexture(wave.texture());
      const material = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, { uWave: { value: waveTex } }), toneMapped: false });
      const mesh = new THREE.Mesh(g, material);
      mesh.frustumCulled = false;
      kit.scene.add(mesh);
      kit.camera.position.set(-5, 15, 19);
      kit.camera.lookAt(0, 0, 0);
      return {
        slabs: 0.9,
        update(_t, dt) {
          kit.renderer.resetState();
          wave.step(dt, kit.field.texture);
          kit.renderer.resetState();
          waveTex.sourceTexture = wave.texture();
          const p = env.pointer;
          kit.camera.position.x = -5 + (p.su - 0.5) * 2.2 * p.strength;
          kit.camera.position.y = 15 - bridge.scrollProgress * 4 + (p.sv - 0.5) * 1.2 * p.strength;
          kit.camera.lookAt(0, 0, -bridge.scrollProgress * 2);
        },
        dispose() {
          wave.dispose();
          waveTex.dispose();
        },
      };
    },
    { fov: 42, z: 20 },
  );
export default make;
