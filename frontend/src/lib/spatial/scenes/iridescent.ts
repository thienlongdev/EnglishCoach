import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { NOISE_3, SPATIAL_THREE_U, addSky, pointerAt, threeSpatial, withUniforms } from './kit';

/**
 * B05 Iridescent Material. Ribbons of thin film. The colour is computed from the optical path through the film (angle of view and local
 * thickness), so it changes as the ribbon turns and as the light moves: no texture and no colour ramp fixed to the surface.
 */
const VS = /* glsl */ `
${SPATIAL_THREE_U}
${NOISE_3}
uniform vec3 uTouch;
uniform float uOffset;
varying vec3 vWorld; varying vec3 vN; varying float vThick; varying vec2 vU;
vec3 ribbon(vec2 q) {
  float x = (q.x - 0.5) * 26.0;
  float s = q.y - 0.5;
  float t = uTime * 0.14 + uOffset * 7.0;
  float twist = sin(x * 0.22 + t * 1.3) * 1.5 + uOffset * 2.0;
  vec3 c = vec3(x, sin(x * 0.28 + t) * 1.8 + sin(x * 0.11 - t * 0.7) * 1.3 + uOffset * 3.0 - 1.5, cos(x * 0.2 + t * 0.8) * 2.2 - 2.0);
  vec3 w = vec3(0.0, cos(twist), sin(twist)) * s * (4.6 + 1.2 * sin(x * 0.17 + t));
  vec3 p = c + w;
  p.z += (n3(vec3(x * 0.3, s * 2.0, t)) - 0.5) * 1.1;
  vec3 d = p - uTouch;
  float f = exp(-dot(d.xy, d.xy) * 0.22) * uStrength;
  p.z += f * 1.3;
  p.xy += normalize(d.xy + 0.001) * f * 0.7;
  return p;
}
void main() {
  vec2 e = vec2(0.002, 0.012);
  vec3 p = ribbon(uv);
  vec3 dx = ribbon(uv + vec2(e.x, 0.0)) - p;
  vec3 dy = ribbon(uv + vec2(0.0, e.y)) - p;
  vN = normalize(cross(dx, dy));
  vWorld = p;
  vU = uv;
  vThick = n3(vec3(uv.x * 9.0, uv.y * 3.0, uTime * 0.07)) * 0.5 + 0.5 * uv.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform vec3 uLight;
varying vec3 vWorld; varying vec3 vN; varying float vThick; varying vec2 vU;
vec3 thinFilm(float cosT, float thick) {
  // optical path through a film of index 1.33, colour per wavelength
  float d = (240.0 + thick * 340.0) * 2.0 * 1.33 * sqrt(1.0 - (1.0 - cosT * cosT) / (1.33 * 1.33));
  return 0.5 + 0.5 * cos(6.28318 * d / vec3(650.0, 532.0, 450.0));
}
void main() {
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vN);
  if (dot(n, v) < 0.0) n = -n;
  float cosV = max(dot(n, v), 0.0);
  vec3 film = thinFilm(cosV, vThick + 0.25 * uMaterial);
  vec3 l = normalize(uLight - vWorld);
  float diff = dot(n, l) * 0.5 + 0.5;
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 64.0);
  float fres = pow(1.0 - cosV, 3.0);
  vec3 col = mix(uC1 * 1.2 + 0.08, film * film, 0.38 + 0.5 * fres);
  col = mix(col * (0.5 + 0.7 * diff), col, fres);
  col = mix(col, mix(col, vec3(1.0), 0.32), 1.0 - uDark);
  col += vec3(1.0) * spec * 1.1;
  float edge = smoothstep(0.0, 0.03, vU.y) * smoothstep(1.0, 0.97, vU.y);
  gl_FragColor = vec4(col, edge);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const seg = env.tier === 'low' ? [90, 18] : [220, 40];
      const touch = new THREE.Vector3(99, 99, 0);
      const light = new THREE.Vector3(3, 3, 7);
      const geo = new THREE.PlaneGeometry(1, 1, seg[0], seg[1]);
      const add = (offset: number) => {
        const m = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, side: THREE.DoubleSide, transparent: true, toneMapped: false, uniforms: withUniforms(kit, { uTouch: { value: touch }, uLight: { value: light }, uOffset: { value: offset } }) });
        const mesh = new THREE.Mesh(geo, m);
        mesh.frustumCulled = false;
        kit.scene.add(mesh);
      };
      add(0);
      add(0.62);
      return {
        update() {
          pointerAt(kit, -1, touch);
          light.set(touch.x, touch.y + 1.5, 5);
          kit.camera.position.y = -bridge.scrollProgress * 1.6 + (env.pointer.sv - 0.5) * 0.5 * env.pointer.strength;
          kit.camera.position.x = (env.pointer.su - 0.5) * 0.7 * env.pointer.strength;
          kit.camera.lookAt(0, -bridge.scrollProgress * 1.6, -1);
        },
      };
    },
    { fov: 42, z: 12 },
  );
export default make;
