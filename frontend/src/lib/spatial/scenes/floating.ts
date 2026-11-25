import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_THREE_U, addSky, pointerAt, threeSpatial, withUniforms } from './kit';

/**
 * C05 / I05 Floating Geometry. Rigid forms with real inertia on the CPU: sphere-sphere collisions, spin picked up from each hit, and the DOM cards as solid
 * obstacles (their rects are taken into the world plane), so a form drifting toward a card bounces off it. No physics library: 40 bodies do not need one.
 */
const VS = /* glsl */ `
attribute float aTone;
${SPATIAL_THREE_U}
varying vec3 vN; varying vec3 vW; varying float vTone;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 w = m * vec4(position, 1.0);
  vN = mat3(m) * normal;
  vW = w.xyz;
  vTone = aTone;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform vec3 uLight;
varying vec3 vN; varying vec3 vW; varying float vTone;
void main() {
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 sm = normalize(vN);
  if (dot(n, sm) < 0.0) n = -n;
  n = normalize(mix(n, sm, 0.5));
  vec3 v = normalize(cameraPosition - vW);
  vec3 l = normalize(uLight - vW);
  float wrap = dot(n, l) * 0.5 + 0.5;
  vec3 base = mix(uC2, uC3, vTone);
  vec3 col = base * (0.2 + 0.92 * wrap * wrap);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  col += uC3 * fres * 0.6;
  col += vec3(1.0) * pow(max(dot(reflect(-l, n), v), 0.0), 50.0) * 0.8;
  gl_FragColor = vec4(col, 1.0);
}`;
const STAR_FS = /* glsl */ `varying vec2 vUv; ${SPATIAL_THREE_U}
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 1.5, vUv.y) * 0.7);
  float a = uCss.x / uCss.y;
  for (int i = 0; i < 3; i++) {
    float s = 28.0 + float(i) * 34.0;
    vec2 p = vec2(vUv.x * a, vUv.y + uScroll * (0.05 + float(i) * 0.05)) * s;
    vec2 c = floor(p), f = fract(p) - 0.5;
    float r = h(c);
    float star = smoothstep(0.08, 0.0, length(f - (vec2(h(c + 1.3), h(c + 7.1)) - 0.5) * 0.7)) * step(0.86, r);
    col += mix(uC3, vec3(1.0), 0.5) * star * (0.4 + 0.6 * sin(uTime * (0.5 + r) + r * 40.0) * 0.5 + 0.3);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

interface Body {
  mesh: THREE.InstancedMesh;
  index: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
  r: number;
}

const make: SpatialSceneFactory = (env, bridge, opts, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit, opts.stars ? STAR_FS : undefined);
      const light = new THREE.Vector3(3, 6, 8);
      const material = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, { uLight: { value: light } }), toneMapped: false });
      const shapes = [new THREE.IcosahedronGeometry(1, 0), new THREE.TorusGeometry(0.72, 0.28, 12, 32), new THREE.BoxGeometry(1.25, 1.25, 1.25), new THREE.OctahedronGeometry(1.1, 0), new THREE.TorusKnotGeometry(0.58, 0.2, 80, 10), new THREE.ConeGeometry(0.85, 1.5, 6)];
      const perShape = env.tier === 'low' ? 3 : 6;
      const bodies: Body[] = [];
      const m4 = new THREE.Matrix4();
      const unit = new THREE.Vector3(1, 1, 1);
      for (const shape of shapes) {
        const tones = new Float32Array(perShape);
        for (let i = 0; i < perShape; i++) tones[i] = Math.random();
        shape.setAttribute('aTone', new THREE.InstancedBufferAttribute(tones, 1));
        const mesh = new THREE.InstancedMesh(shape, material, perShape);
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        kit.scene.add(mesh);
        for (let i = 0; i < perShape; i++) {
          const r = 0.5 + Math.random() * 0.75;
          bodies.push({
            mesh,
            index: i,
            r,
            p: new THREE.Vector3((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 12, -Math.random() * 3),
            v: new THREE.Vector3((Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4, 0),
            q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)),
            w: new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8),
          });
        }
      }
      const hit = new THREE.Vector3();
      const tmp = new THREE.Vector3();
      const dq = new THREE.Quaternion();
      return {
        update(_t, rawDt) {
          const dt = Math.min(rawDt, 1 / 30);
          const pt = env.pointer;
          pointerAt(kit, -1, hit);
          light.set(hit.x, hit.y + 2, 7);
          const halfH = Math.tan((kit.camera.fov * Math.PI) / 360) * (kit.camera.position.z + 1);
          const halfW = halfH * kit.camera.aspect;
          const pxToWorld = (2 * halfH) / Math.max(1, env.cssHeight);
          const pulses = pt.drainPulses();
          for (const b of bodies) {
            // gentle drift toward the middle plane and a soft speed limit
            b.v.z += (-1 - b.p.z) * 0.6 * dt;
            b.v.multiplyScalar(Math.exp(-dt * 0.18));
            if (pt.strength > 0.01) {
              tmp.copy(b.p).sub(hit);
              const d2 = tmp.lengthSq() + 0.6;
              const f = (9 * pt.strength * (0.25 + pt.energy * 2.4)) / d2;
              b.v.addScaledVector(tmp.normalize(), f * dt * 8);
            }
            for (const pulse of pulses) {
              const px = (pulse.u - 0.5) * 2 * halfW;
              const py = (pulse.v - 0.5) * 2 * halfH;
              tmp.set(b.p.x - px, b.p.y - py, 0);
              const d = tmp.length() + 0.5;
              b.v.addScaledVector(tmp.normalize(), 22 / (d * d + 2));
            }
            b.v.y -= bridge.scrollVelocity * dt * 3;
            b.p.addScaledVector(b.v, dt);
            // walls of the view
            const lim = 1.15;
            if (b.p.x > halfW * lim) b.v.x -= (b.p.x - halfW * lim) * 3 * dt + 0.02;
            if (b.p.x < -halfW * lim) b.v.x += (-halfW * lim - b.p.x) * 3 * dt + 0.02;
            if (b.p.y > halfH * lim) b.v.y -= (b.p.y - halfH * lim) * 3 * dt + 0.02;
            if (b.p.y < -halfH * lim) b.v.y += (-halfH * lim - b.p.y) * 3 * dt + 0.02;
            // the real cards are solid
            for (let i = 0; i < bridge.count; i++) {
              const rx = bridge.rects[i * 4];
              const ry = bridge.rects[i * 4 + 1];
              const rw = bridge.rects[i * 4 + 2];
              const rh = bridge.rects[i * 4 + 3];
              const cx = (rx + rw / 2 - env.cssWidth / 2) * pxToWorld;
              const cy = -(ry + rh / 2 - env.cssHeight / 2) * pxToWorld;
              const hx = (rw / 2) * pxToWorld + b.r * 0.8;
              const hy = (rh / 2) * pxToWorld + b.r * 0.8;
              const dx = b.p.x - cx;
              const dy = b.p.y - cy;
              if (Math.abs(dx) < hx && Math.abs(dy) < hy) {
                const ox = hx - Math.abs(dx);
                const oy = hy - Math.abs(dy);
                if (ox < oy) {
                  b.p.x += Math.sign(dx || 1) * ox;
                  if (b.v.x * dx < 0) {
                    b.v.x *= -0.7;
                    b.w.y += b.v.y * 0.3;
                  }
                } else {
                  b.p.y += Math.sign(dy || 1) * oy;
                  if (b.v.y * dy < 0) {
                    b.v.y *= -0.7;
                    b.w.x += b.v.x * 0.3;
                  }
                }
              }
            }
          }
          for (let i = 0; i < bodies.length; i++) {
            const a = bodies[i];
            for (let j = i + 1; j < bodies.length; j++) {
              const c = bodies[j];
              tmp.copy(a.p).sub(c.p);
              const dist = tmp.length();
              const sum = a.r + c.r;
              if (dist > 0.001 && dist < sum) {
                tmp.multiplyScalar(1 / dist);
                const push = (sum - dist) * 0.5;
                a.p.addScaledVector(tmp, push);
                c.p.addScaledVector(tmp, -push);
                const rel = a.v.dot(tmp) - c.v.dot(tmp);
                if (rel < 0) {
                  a.v.addScaledVector(tmp, -rel * 0.85);
                  c.v.addScaledVector(tmp, rel * 0.85);
                  a.w.x += rel * 0.15;
                  c.w.y -= rel * 0.15;
                }
              }
            }
          }
          for (const b of bodies) {
            b.w.multiplyScalar(Math.exp(-dt * 0.3));
            dq.setFromEuler(new THREE.Euler(b.w.x * dt, b.w.y * dt, b.w.z * dt));
            b.q.multiply(dq);
            m4.compose(b.p, b.q, tmp.copy(unit).multiplyScalar(b.r));
            b.mesh.setMatrixAt(b.index, m4);
            b.mesh.instanceMatrix.needsUpdate = true;
          }
        },
      };
    },
    { fov: 38, z: 18 },
  );
export default make;
