import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_THREE_U, addSky, pointerAt, threeSpatial, withUniforms } from './kit';

/**
 * G04 Elastic Field. A real sheet of cloth: Verlet nodes with distance constraints and damping on the CPU, drawn as a shaded surface with stitched lines. The pointer pulls it, a press plucks
 * it, and the DOM cards pin the nodes they cover, so the sheet is visibly held by the interface.
 */
const VS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec3 vW; varying vec2 vU;
void main() { vW = position; vU = uv; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform vec2 uGrid;
varying vec3 vW; varying vec2 vU;
void main() {
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  if (n.z < 0.0) n = -n;
  vec3 v = normalize(cameraPosition - vW);
  vec3 l = normalize(vec3(-0.4, 0.5, 0.75));
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 34.0);
  float lift = smoothstep(-0.4, 1.8, vW.z);
  vec3 col = mix(uC1, uC2, lift) * (0.34 + 0.95 * diff) + mix(uC3, vec3(1.0), 0.4) * spec * 0.6;
  vec2 g = abs(fract(vU * uGrid) - 0.5) / fwidth(vU * uGrid);
  float line = 1.0 - min(min(g.x, g.y) * 0.7, 1.0);
  col = mix(col, uC3, line * (0.2 + 0.6 * lift));
  gl_FragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const cols = env.tier === 'low' ? 44 : 72;
      const rows = Math.round(cols * 0.58);
      const halfH = Math.tan((kit.camera.fov * Math.PI) / 360) * kit.camera.position.z;
      const halfW = halfH * kit.camera.aspect;
      const W = halfW * 2.2;
      const H = halfH * 2.2;
      const geo = new THREE.PlaneGeometry(W, H, cols - 1, rows - 1);
      const attr = geo.getAttribute('position') as THREE.BufferAttribute;
      attr.setUsage(THREE.DynamicDrawUsage);
      const n = cols * rows;
      const pos = new Float32Array(n * 3);
      const prev = new Float32Array(n * 3);
      const rest = new Float32Array(n * 3);
      pos.set(attr.array as Float32Array);
      prev.set(pos);
      rest.set(pos);
      const pinned = new Uint8Array(n);
      const dx = W / (cols - 1);
      const dy = H / (rows - 1);
      const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, { uGrid: { value: new THREE.Vector2(cols - 1, rows - 1) } }), toneMapped: false, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      kit.scene.add(mesh);
      const hit = new THREE.Vector3();
      let last = new THREE.Vector3(99, 99, 0);
      const constrain = (a: number, b: number, length: number) => {
        const ax = a * 3;
        const bx = b * 3;
        const ex = pos[bx] - pos[ax];
        const ey = pos[bx + 1] - pos[ax + 1];
        const ez = pos[bx + 2] - pos[ax + 2];
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-5;
        const f = ((d - length) / d) * 0.5;
        const wa = pinned[a] ? 0 : 1;
        const wb = pinned[b] ? 0 : 1;
        const sum = wa + wb;
        if (!sum) return;
        const ka = (wa / sum) * 2 * f;
        const kb = (wb / sum) * 2 * f;
        pos[ax] += ex * ka;
        pos[ax + 1] += ey * ka;
        pos[ax + 2] += ez * ka;
        pos[bx] -= ex * kb;
        pos[bx + 1] -= ey * kb;
        pos[bx + 2] -= ez * kb;
      };
      return {
        update(t, rawDt) {
          const dt = Math.min(rawDt, 1 / 30);
          const pt = env.pointer;
          pointerAt(kit, 0, hit);
          // Cards pin what they cover, border nodes are always pinned.
          const pxToWorld = (2 * halfH) / Math.max(1, env.cssHeight);
          pinned.fill(0);
          for (let j = 0; j < rows; j++) {
            pinned[j * cols] = 1;
            pinned[j * cols + cols - 1] = 1;
          }
          for (let i = 0; i < cols; i++) {
            pinned[i] = 1;
            pinned[(rows - 1) * cols + i] = 1;
          }
          for (let k = 0; k < bridge.count; k++) {
            if (bridge.meta[k * 4 + 3] > 0.5) continue;
            const left = (bridge.rects[k * 4] - env.cssWidth / 2) * pxToWorld;
            const top = -(bridge.rects[k * 4 + 1] - env.cssHeight / 2) * pxToWorld;
            const w = bridge.rects[k * 4 + 2] * pxToWorld;
            const h = bridge.rects[k * 4 + 3] * pxToWorld;
            const i0 = Math.max(0, Math.ceil((left + W / 2) / dx));
            const i1 = Math.min(cols - 1, Math.floor((left + w + W / 2) / dx));
            const j0 = Math.max(0, Math.ceil((H / 2 - top) / dy));
            const j1 = Math.min(rows - 1, Math.floor((H / 2 - top + h) / dy));
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) pinned[j * cols + i] = 1;
          }
          const damp = 0.965;
          const gust = Math.sin(t * 0.5) * 0.002;
          const moved = hit.distanceTo(last);
          last.copy(hit);
          const pulses = pt.drainPulses();
          for (let i = 0; i < n; i++) {
            const k = i * 3;
            if (pinned[i]) {
              pos[k] = rest[k];
              pos[k + 1] = rest[k + 1];
              pos[k + 2] += (0 - pos[k + 2]) * 0.3;
              prev[k] = pos[k];
              prev[k + 1] = pos[k + 1];
              prev[k + 2] = pos[k + 2];
              continue;
            }
            const vx = (pos[k] - prev[k]) * damp;
            const vy = (pos[k + 1] - prev[k + 1]) * damp;
            const vz = (pos[k + 2] - prev[k + 2]) * damp;
            prev[k] = pos[k];
            prev[k + 1] = pos[k + 1];
            prev[k + 2] = pos[k + 2];
            pos[k] += vx;
            pos[k + 1] += vy;
            pos[k + 2] += vz + (-pos[k + 2] * 0.01 + gust * Math.sin(rest[k] * 0.6 + t)) * (dt * 60);
            if (pt.strength > 0.01) {
              const ex = pos[k] - hit.x;
              const ey = pos[k + 1] - hit.y;
              const d2 = ex * ex + ey * ey;
              if (d2 < 7) {
                const f = (1 - d2 / 7) ** 2 * (0.016 + Math.min(moved, 0.8) * 0.14) * pt.strength * (dt * 60);
                pos[k + 2] += f * 3;
                pos[k] += ex * f * 0.5;
                pos[k + 1] += ey * f * 0.5;
              }
              for (const pulse of pulses) {
                const px = (pulse.u - 0.5) * 2 * halfW;
                const py = (pulse.v - 0.5) * 2 * halfH;
                const qx = pos[k] - px;
                const qy = pos[k + 1] - py;
                const qd = qx * qx + qy * qy;
                if (qd < 12) pos[k + 2] += (1 - qd / 12) * 1.3;
              }
            }
          }
          for (let iter = 0; iter < 2; iter++) {
            for (let j = 0; j < rows; j++) {
              for (let i = 0; i < cols; i++) {
                const a = j * cols + i;
                if (i < cols - 1) constrain(a, a + 1, dx);
                if (j < rows - 1) constrain(a, a + cols, dy);
              }
            }
          }
          (attr.array as Float32Array).set(pos);
          attr.needsUpdate = true;
          kit.camera.position.x = (pt.su - 0.5) * 0.7 * pt.strength;
          kit.camera.position.y = (pt.sv - 0.5) * 0.4 * pt.strength;
          kit.camera.lookAt(0, 0, 0);
        },
      };
    },
    { fov: 40, z: 16 },
  );
export default make;
