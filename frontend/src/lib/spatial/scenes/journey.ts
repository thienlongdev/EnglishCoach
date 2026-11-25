import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { ART_POOL, SPATIAL_THREE_U, addSky, makeArtAtlas, threeSpatial, withUniforms } from './kit';

/**
 * D06 Perspective Journey. A grid floor to the horizon, a lens built from concentric rings, and a reel of frames flying a curved path into it. The native scroll pulls the reel; every route
 * change gives the path a new shape, which the frames follow with inertia (a pure function of a per-route seed, so nothing is simulated per frame).
 */
const FRAME_VS = /* glsl */ `
attribute float iAt; attribute vec2 iTile;
${SPATIAL_THREE_U}
uniform float uPull;
uniform float uBend;
varying vec2 vU; varying float vFade;
vec3 path(float t) {
  float x = mix(-17.0, 7.5, t);
  float y = 0.5 + sin(t * 3.0 + uBend) * (1.2 + 0.9 * sin(uBend * 1.7)) + (t - 0.5) * 1.0;
  float z = -6.0 + sin(t * 2.2 + uBend * 0.7) * 6.0 * (1.0 - t);
  return vec3(x, y, z);
}
void main() {
  float t = fract(iAt + uPull);
  vec3 c = path(t);
  vec3 ahead = path(min(t + 0.01, 1.0));
  vec3 f = normalize(ahead - c + 1e-4);
  vec3 r = normalize(cross(vec3(0, 1, 0), f));
  vec3 u = cross(f, r);
  float size = mix(1.3, 2.3, smoothstep(0.1, 0.85, t)) * smoothstep(1.0, 0.93, t);
  vec3 p = c + (f * position.x * 0.9 + u * position.y * 1.15 + r * sin(position.x * 3.0) * 0.08) * size;
  vU = (iTile + vec2(uv.x, 1.0 - uv.y)) / vec2(4.0, 3.0);
  vU.y = 1.0 - vU.y;
  vFade = smoothstep(0.0, 0.12, t);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const FRAME_FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform sampler2D uArt;
varying vec2 vU; varying float vFade;
void main() {
  vec3 art = texture2D(uArt, vU).rgb;
  gl_FragColor = vec4(mix(uC0, art, vFade), 1.0);
}`;
const FLOOR_FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform float uPull;
varying vec3 vW;
void main() {
  vec2 q = vW.xz + vec2(uPull * 40.0, 0.0);
  vec2 g = abs(fract(q * 0.5) - 0.5) / fwidth(q * 0.5);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float far = smoothstep(6.0, 58.0, length(vW - cameraPosition));
  vec3 col = mix(uC0, uC2, line * 0.62);
  gl_FragColor = vec4(mix(col, uC0, far), 1.0);
}`;
const FLOOR_VS = /* glsl */ `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const RING_VS = /* glsl */ `varying vec3 vN; varying vec3 vW; varying float vI; attribute float iZ; attribute float iR;
void main() { vec3 p = position * iR; p.z += iZ; vec4 w = modelMatrix * vec4(p, 1.0); vW = w.xyz; vN = mat3(modelMatrix) * normal; vI = iZ; gl_Position = projectionMatrix * viewMatrix * w; }`;
const RING_FS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec3 vN; varying vec3 vW; varying float vI;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  vec3 l = normalize(vec3(-0.5, 0.8, 0.5));
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 24.0);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 2.0);
  vec3 body = mix(uC1 * 0.55, uC0 * 1.15, 0.5);
  gl_FragColor = vec4(body * (0.55 + 0.7 * max(dot(n, l), 0.0)) + vec3(1.0) * spec * 0.8 + uC3 * fres * 0.4, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const atlas = makeArtAtlas(ART_POOL, 4, 3, 320, 200);
      const own = { uPull: { value: 0 }, uBend: { value: 0.4 }, uArt: { value: atlas.texture } };
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 200), new THREE.ShaderMaterial({ vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS, uniforms: withUniforms(kit, own), toneMapped: false }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -2.4;
      kit.scene.add(floor);
      const count = env.tier === 'low' ? 30 : 52;
      const plane = new THREE.PlaneGeometry(1, 1, 6, 1);
      const g = new THREE.InstancedBufferGeometry();
      g.index = plane.index;
      g.setAttribute('position', plane.getAttribute('position'));
      g.setAttribute('uv', plane.getAttribute('uv'));
      const at = new Float32Array(count);
      const tile = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        at[i] = i / count;
        const pick = (i * 5) % 12;
        tile[i * 2] = pick % 4;
        tile[i * 2 + 1] = Math.floor(pick / 4);
      }
      g.setAttribute('iAt', new THREE.InstancedBufferAttribute(at, 1));
      g.setAttribute('iTile', new THREE.InstancedBufferAttribute(tile, 2));
      g.instanceCount = count;
      const frames = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: FRAME_VS, fragmentShader: FRAME_FS, uniforms: withUniforms(kit, own), toneMapped: false, side: THREE.DoubleSide }));
      frames.frustumCulled = false;
      kit.scene.add(frames);
      // The lens: concentric machined rings, facing along the reel.
      const torus = new THREE.TorusGeometry(1, 0.1, 14, 72);
      const lens = new THREE.InstancedBufferGeometry();
      lens.index = torus.index;
      lens.setAttribute('position', torus.getAttribute('position'));
      lens.setAttribute('normal', torus.getAttribute('normal'));
      const rings = [3.3, 3.05, 2.72, 2.4, 2.12, 1.8, 1.5];
      lens.setAttribute('iR', new THREE.InstancedBufferAttribute(new Float32Array(rings), 1));
      lens.setAttribute('iZ', new THREE.InstancedBufferAttribute(new Float32Array(rings.map((_r, i) => i * 0.34)), 1));
      lens.instanceCount = rings.length;
      const body = new THREE.Mesh(lens, new THREE.ShaderMaterial({ vertexShader: RING_VS, fragmentShader: RING_FS, uniforms: withUniforms(kit), toneMapped: false }));
      body.frustumCulled = false;
      body.position.set(9, 0.8, -1.2);
      body.rotation.y = -1.28;
      kit.scene.add(body);
      let drift = 0;
      let seq = bridge.routeSeq;
      let bendTarget = 0.4;
      let flick = 0;
      return {
        update(_t, dt) {
          const pt = env.pointer;
          // Grab the film: a stroke pulls it through the reel, a press kinks its whole length.
          flick += pt.vx * pt.strength * dt * 0.16;
          flick *= Math.exp(-dt * 1.4);
          drift += dt * 0.012 + flick * dt;
          if (pt.drainPulses().length) bendTarget += 1.1;
          own.uPull.value = drift + bridge.scrollProgress * 0.9;
          if (bridge.routeSeq !== seq) {
            seq = bridge.routeSeq;
            bendTarget += 1.9;
          }
          own.uBend.value += (bendTarget - own.uBend.value) * Math.min(1, dt * 2);
          const p = env.pointer;
          kit.camera.position.set(-1.5 + (p.su - 0.5) * 2 * p.strength, 2.4 + (p.sv - 0.5) * 1.2 * p.strength, 13);
          kit.camera.lookAt(0, 0.4, -2);
        },
        dispose: () => atlas.dispose(),
      };
    },
    { fov: 44, z: 16 },
  );
export default make;
