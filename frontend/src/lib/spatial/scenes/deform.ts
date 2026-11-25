import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { NOISE_3, SPATIAL_THREE_U, addSky, makeWave, threeSpatial, withUniforms } from './kit';

/**
 * C06 Deformation Field. A dense terrain whose vertices move with a screen-space history of the pointer (a strongly damped wave field, so marks heal) and with
 * the scroll. The relief is drawn with contour lines computed from the real height, so a mark is visible as lines bending, not a flat stain.
 */
const VS = /* glsl */ `
${SPATIAL_THREE_U}
${NOISE_3}
uniform sampler2D uWave;
varying float vH; varying vec3 vW; varying vec2 vS;
float terrain(vec2 q) {
  return (fbm3(vec3(q * 0.09, uTime * 0.012)) - 0.5) * 9.0 + sin(q.x * 0.07 + uScroll * 3.0) * 1.2;
}
void main() {
  vec3 p = position;
  vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vec2 s = clamp(clip.xy / clip.w * 0.5 + 0.5, 0.0, 1.0);
  float mark = texture2D(uWave, s).r;
  float h = terrain(p.xz + vec2(0.0, uScroll * 24.0)) - mark * 14.0;
  p.y += h;
  vH = h;
  vW = p;
  vS = s;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
varying float vH; varying vec3 vW; varying vec2 vS;
void main() {
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  if (n.y < 0.0) n = -n;
  vec3 l = normalize(vec3(-0.5, 0.65, 0.4));
  float diff = max(dot(n, l), 0.0);
  float t = smoothstep(-5.0, 5.0, vH);
  vec3 col = mix(uC1 * 0.9, uC2, t * t);
  col *= 0.3 + 0.9 * diff;
  float h = vH * 1.6;
  float iso = abs(fract(h) - 0.5) / max(fwidth(h), 0.001);
  float line = 1.0 - smoothstep(0.5, 1.4, iso);
  float major = abs(fract(h * 0.2) - 0.5) / max(fwidth(h * 0.2), 0.001);
  col = mix(col, uC3, line * 0.42 + (1.0 - smoothstep(0.6, 1.6, major)) * 0.5);
  float far = smoothstep(16.0, 62.0, length(vW - cameraPosition));
  col = mix(col, uC0, far);
  col += uC3 * 0.08 * exp(-dot(vS - uMouse, vS - uMouse) * 22.0) * uStrength;
  gl_FragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const seg = env.tier === 'low' ? 110 : env.tier === 'balanced' ? 190 : 280;
      const geo = new THREE.PlaneGeometry(120, 90, seg, Math.round(seg * 0.72));
      geo.rotateX(-Math.PI / 2);
      const wave = makeWave(env, { damp: 0.965, walls: 0, force: 1.4 });
      const waveTex = new THREE.ExternalTexture(wave.texture());
      const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, { uWave: { value: waveTex } }), toneMapped: false, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      kit.scene.add(mesh);
      kit.camera.position.set(0, 15, 25);
      kit.camera.lookAt(0, -1, -8);
      return {
        update(_t, dt) {
          kit.renderer.resetState();
          wave.step(dt, kit.field.texture);
          kit.renderer.resetState();
          waveTex.sourceTexture = wave.texture();
          const p = env.pointer;
          kit.camera.position.x = (p.su - 0.5) * 3 * p.strength;
          kit.camera.lookAt(0, -1, -8);
        },
        dispose() {
          wave.dispose();
          waveTex.dispose();
        },
      };
    },
    { fov: 46, z: 25 },
  );
export default make;
