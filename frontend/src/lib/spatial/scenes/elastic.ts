import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { NOISE_3, SPATIAL_THREE_U, addSky, threeSpatial, withUniforms } from './kit';

/**
 * C02 Elastic Geometry. Soft forms. A touch adds an impulse: a damped wave travels over the skin from that point, computed in the vertex shader, with
 * normals rebuilt from neighbouring points so the highlight really rolls over the dent. Each form keeps its last six impulses.
 */
const VS = /* glsl */ `
${SPATIAL_THREE_U}
${NOISE_3}
uniform vec4 uHits[6];
uniform float uHitAge[6];
uniform float uForm;
varying vec3 vN; varying vec3 vW;
vec3 skin(vec3 unit) {
  float t = uTime * 0.25;
  float lump = (n3(unit * 1.15 + t + uForm * 9.0) - 0.5) * 0.5;
  vec3 p = unit * (1.0 + lump);
  if (uForm > 0.5 && uForm < 1.5) p *= vec3(1.25, 0.78, 1.0);
  if (uForm > 1.5) p *= vec3(0.86, 1.28, 0.9);
  float dent = 0.0;
  for (int i = 0; i < 6; i++) {
    float age = uHitAge[i];
    if (age < 0.0 || age > 3.2) continue;
    float d = distance(unit, uHits[i].xyz);
    float ring = sin(d * 13.0 - age * 15.0) * exp(-d * 2.3);
    dent += ring * uHits[i].w * exp(-age * 2.1) * smoothstep(0.0, 0.06, age + 0.03);
  }
  return p + unit * dent * 0.42;
}
void main() {
  vec3 u = normalize(position);
  vec3 t = normalize(cross(u, vec3(0.31, 0.87, 0.38)));
  vec3 b = cross(u, t);
  float e = 0.035;
  vec3 p = skin(u);
  vec3 pa = skin(normalize(u + t * e));
  vec3 pb = skin(normalize(u + b * e));
  vec3 n = normalize(cross(pa - p, pb - p));
  if (dot(n, u) < 0.0) n = -n;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vN = mat3(modelMatrix) * n;
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform vec3 uLight;
uniform float uTone;
varying vec3 vN; varying vec3 vW;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  vec3 l = normalize(uLight - vW);
  float wrap = dot(n, l) * 0.5 + 0.5;
  vec3 base = mix(uC2, uC3, uTone);
  vec3 col = base * (0.22 + 0.95 * wrap * wrap);
  // light passing through the jelly near the silhouette
  float fres = pow(1.0 - max(dot(n, v), 0.0), 2.5);
  col += mix(uC3, vec3(1.0), 0.3) * fres * 0.5;
  col += vec3(1.0) * pow(max(dot(reflect(-l, n), v), 0.0), 110.0) * 1.1;
  col += mix(uC3, vec3(1.0), 0.4) * pow(max(dot(reflect(-l, n), v), 0.0), 14.0) * 0.18;
  gl_FragColor = vec4(col, 1.0);
}`;

interface Blob {
  mesh: THREE.Mesh;
  hits: THREE.Vector4[];
  ages: number[];
  next: number;
  radius: number;
  home: THREE.Vector3;
  seed: number;
  cool: number;
}

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const detail = env.tier === 'low' ? 24 : 48;
      const geo = new THREE.IcosahedronGeometry(1, detail);
      const light = new THREE.Vector3(3, 5, 8);
      const blobs: Blob[] = [];
      const defs: [number, number, number, number, number, number][] = [
        [-5.6, 1.6, -1, 2.3, 0, 0],
        [5.2, -1.1, -1.5, 2.8, 1, 0.65],
        [0.4, 3.9, -4, 1.9, 2, 1],
        [-1.8, -3.8, -3, 1.5, 0, 0.35],
      ];
      for (const [x, y, z, r, form, tone] of defs) {
        const hits = Array.from({ length: 6 }, () => new THREE.Vector4(0, 1, 0, 0));
        const ages = [-1, -1, -1, -1, -1, -1];
        const material = new THREE.ShaderMaterial({
          vertexShader: VS,
          fragmentShader: FS,
          toneMapped: false,
          uniforms: withUniforms(kit, { uHits: { value: hits }, uHitAge: { value: ages }, uForm: { value: form }, uLight: { value: light }, uTone: { value: tone } }),
        });
        const mesh = new THREE.Mesh(geo, material);
        mesh.position.set(x, y, z);
        mesh.scale.setScalar(r);
        mesh.frustumCulled = false;
        kit.scene.add(mesh);
        blobs.push({ mesh, hits, ages, next: 0, radius: r, home: new THREE.Vector3(x, y, z), seed: Math.random() * 10, cool: 0 });
      }
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const sphere = new THREE.Sphere();
      const hit = new THREE.Vector3();
      const strike = (b: Blob, point: THREE.Vector3, amount: number) => {
        const local = point.clone().sub(b.mesh.position).normalize();
        b.hits[b.next].set(local.x, local.y, local.z, amount);
        b.ages[b.next] = 0;
        b.next = (b.next + 1) % 6;
      };
      return {
        update(t, dt) {
          const p = env.pointer;
          kit.camera.position.x = (p.su - 0.5) * 0.9 * p.strength;
          kit.camera.position.y = (p.sv - 0.5) * 0.6 * p.strength - bridge.scrollProgress * 1.4;
          kit.camera.lookAt(0, -bridge.scrollProgress * 1.4, -1);
          kit.camera.updateMatrixWorld();
          light.set((p.su - 0.5) * 18, (p.sv - 0.5) * 12 + 2, 8);
          ndc.set(p.u * 2 - 1, p.v * 2 - 1);
          ray.setFromCamera(ndc, kit.camera);
          const pulses = p.drainPulses();
          const moving = p.energy > 0.04 && p.strength > 0.01;
          for (const b of blobs) {
            b.cool -= dt;
            b.mesh.position.y = b.home.y + Math.sin(t * 0.3 + b.seed) * 0.24;
            b.mesh.rotation.y = t * 0.05 + b.seed;
            b.mesh.updateMatrixWorld();
            for (let i = 0; i < 6; i++) if (b.ages[i] >= 0) b.ages[i] += dt;
            sphere.set(b.mesh.position, b.radius * 1.05);
            if ((moving && b.cool <= 0) || pulses.length) {
              if (ray.ray.intersectSphere(sphere, hit)) {
                strike(b, hit, pulses.length ? 1.6 : 0.55 + p.energy * 0.9);
                b.cool = 0.16;
              }
            }
          }
        },
      };
    },
    { fov: 42, z: 14 },
  );
export default make;
