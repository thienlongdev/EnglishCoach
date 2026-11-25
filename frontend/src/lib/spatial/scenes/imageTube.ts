import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { ART_POOL, SPATIAL_THREE_U, addSky, makeArtAtlas, threeSpatial, withUniforms } from './kit';

/**
 * D03 Spatial Image Tube. You stand inside a tube lined with the product's own art. Panels are bent onto the wall in the vertex shader; the conveyor and the roll are functions
 * of the native scroll, so the page scrolls as ever and the tube answers. Fog hides where the ring of panels wraps, so a finite set reads as endless.
 */
const VS = /* glsl */ `
attribute float iSlot; attribute float iRow; attribute vec2 iTile;
${SPATIAL_THREE_U}
uniform float uTravel;
uniform float uRoll;
varying vec2 vU; varying float vFog; varying float vFront;
void main() {
  float span = 56.0;
  float z = mod(iRow * 2.8 + uTravel + span * 100.0, span) - span + 2.0;
  float a = iSlot + uRoll + position.x * 0.27;
  float r = 5.4;
  vec3 p = vec3(cos(a) * r, sin(a) * r, z + position.y * 1.5);
  vU = (iTile + vec2(uv.x, 1.0 - uv.y)) / vec2(4.0, 3.0);
  vU.y = 1.0 - vU.y;
  vFog = smoothstep(-44.0, -6.0, z);
  vFront = smoothstep(1.2, -1.6, z);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform sampler2D uArt;
varying vec2 vU; varying float vFog; varying float vFront;
void main() {
  vec3 art = texture2D(uArt, vU).rgb;
  vec3 col = mix(uC0, art * mix(1.06, 1.0, uDark), vFog * vFront);
  gl_FragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const atlas = makeArtAtlas(ART_POOL, 4, 3, 320, 200);
      const perRing = 7;
      const rings = 20;
      const total = perRing * rings;
      const plane = new THREE.PlaneGeometry(2.8, 1.5, 10, 2);
      const g = new THREE.InstancedBufferGeometry();
      g.index = plane.index;
      g.setAttribute('position', plane.getAttribute('position'));
      g.setAttribute('uv', plane.getAttribute('uv'));
      const slot = new Float32Array(total);
      const row = new Float32Array(total);
      const tile = new Float32Array(total * 2);
      for (let r = 0; r < rings; r++) {
        for (let i = 0; i < perRing; i++) {
          const k = r * perRing + i;
          slot[k] = (i / perRing) * Math.PI * 2 + r * 0.4;
          row[k] = r;
          const pick = (k * 7 + r) % 12;
          tile[k * 2] = pick % 4;
          tile[k * 2 + 1] = Math.floor(pick / 4);
        }
      }
      g.setAttribute('iSlot', new THREE.InstancedBufferAttribute(slot, 1));
      g.setAttribute('iRow', new THREE.InstancedBufferAttribute(row, 1));
      g.setAttribute('iTile', new THREE.InstancedBufferAttribute(tile, 2));
      g.instanceCount = total;
      const own = { uTravel: { value: 0 }, uRoll: { value: 0 }, uArt: { value: atlas.texture } };
      const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, own), toneMapped: false, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      kit.scene.add(mesh);
      let drift = 0;
      let look = 0;
      let lookY = 0;
      let spin = 0;
      let roll = 0;
      let surge = 0;
      return {
        update(_t, dt) {
          const p = env.pointer;
          // The tube has mass: a sideways stroke spins it and it keeps turning; an upward stroke or a press carries you along.
          spin += p.vx * p.strength * dt * 1.5;
          spin *= Math.exp(-dt * 0.9);
          roll += spin * dt;
          surge += (p.vy * p.strength * dt * 7 + (p.drainPulses().length ? 3.5 : 0));
          surge *= Math.exp(-dt * 1.2);
          drift += dt * 0.5 + surge * dt;
          own.uTravel.value = drift + bridge.scrollProgress * 60;
          own.uRoll.value = bridge.scrollProgress * 2.4 + drift * 0.02 + roll;
          look += ((p.su - 0.5) * 3.2 * p.strength - look) * Math.min(1, dt * 3);
          lookY += ((p.sv - 0.5) * 2.2 * p.strength - lookY) * Math.min(1, dt * 3);
          kit.camera.position.set(0, 0, 3);
          kit.camera.lookAt(look, lookY, -10);
        },
        dispose: () => atlas.dispose(),
      };
    },
    { fov: 72, z: 3 },
  );
export default make;
