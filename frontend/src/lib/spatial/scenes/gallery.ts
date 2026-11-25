import * as THREE from 'three';
import type { WorldEnv, WorldInstance } from '@/lib/wallpaper/worlds/types';
import type { GalleryLayout, PaletteId, SpatialBridge, SpatialSceneFactory } from '../types';
import { ART_POOL, SPATIAL_THREE_U, addSky, makeArtAtlas, threeSpatial, withUniforms } from './kit';

/**
 * Category A: six real 3D arrangements of bent image planes, sharing one instanced draw and one atlas. Used twice with the same code:
 *  - behind every page, as the preset's environment (the product's own art, reacts to the native scroll);
 *  - in the gallery room (`mountGalleryRoom`), with the page's REAL items as planes, where it takes pointer, wheel and keyboard because the learner explicitly entered that room.
 *
 * A layout is a pure function from (index, count, phase) to a transform, in JS: the CPU writes a small attribute buffer, the vertex shader bends each plane.
 *
 * Behind a page the frames are objects that answer, each arrangement in its own way (`answer` below), always on a spring: the curve flows along itself when the pointer sweeps it and frames turn to face it;
 * the orbit keeps the spin you give it; the sphere is a trackball with inertia and frames rise off its skin; the helix climbs with a vertical stroke; the tunnel parts around the pointer; the grid lifts under
 * it. A press sends a ring through the frames that are not under a control of the page.
 */

export interface GalleryState {
  /** Scroll or drag position, in items. */
  phase: number;
  yaw: number;
  pitch: number;
  /** Index of the plane nearest to the viewer (the focused item). */
  focus: number;
}

const VS = /* glsl */ `
attribute vec3 iPos; attribute vec4 iRot; attribute vec2 iSize; attribute vec2 iTile; attribute float iFocus; attribute float iBend;
${SPATIAL_THREE_U}
uniform vec2 uGrid;
varying vec2 vU; varying float vFog; varying float vFocus; varying vec2 vLocal; varying vec2 vSize;
vec3 q(vec4 r, vec3 v) { return v + 2.0 * cross(r.xyz, cross(r.xyz, v) + r.w * v); }
void main() {
  vec3 p = position * vec3(iSize, 1.0);
  // bend the plane around a vertical axis
  if (abs(iBend) > 0.001) {
    float a = p.x * iBend;
    float r = 1.0 / iBend;
    p = vec3(sin(a) * r, p.y, (1.0 - cos(a)) * r * -1.0);
  }
  p *= 1.0 + iFocus * 0.1;
  vec3 w = q(iRot, p) + iPos;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  vU = (iTile + vec2(uv.x, 1.0 - uv.y)) / uGrid;
  vU.y = 1.0 - vU.y;
  vFog = smoothstep(10.0, 46.0, -mv.z);
  vFocus = iFocus;
  vLocal = position.xy * iSize;
  vSize = iSize * 0.5;
  gl_Position = projectionMatrix * mv;
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform sampler2D uArt;
varying vec2 vU; varying float vFog; varying float vFocus; varying vec2 vLocal; varying vec2 vSize;
void main() {
  vec2 d0 = abs(vLocal) - vSize + 0.09;
  float d = length(max(d0, 0.0)) + min(max(d0.x, d0.y), 0.0) - 0.09;
  float aa = fwidth(d);
  float a = 1.0 - smoothstep(-aa, aa, d);
  if (a < 0.02) discard;
  vec3 art = texture2D(uArt, vU).rgb;
  vec3 col = mix(art, uC0, vFog);
  col *= gl_FrontFacing ? 1.0 : 0.42;
  float rim = (1.0 - smoothstep(0.0, aa * 2.2, abs(d + aa))) * (0.25 + vFocus);
  col += uC3 * rim;
  gl_FragColor = vec4(col, a);
}`;

const Q = new THREE.Quaternion();
const E = new THREE.Euler();

/** Writes one plane. Returns its distance along the view for focus. */
function layoutPlane(layout: GalleryLayout, i: number, n: number, s: GalleryState, pos: THREE.Vector3, rot: THREE.Quaternion, room: boolean, out: { w: number; h: number; bend: number }): void {
  const f = (i + s.phase) / Math.max(1, n);
  const wrapped = ((f % 1) + 1) % 1;
  const scale = room ? 1 : 0.9;
  out.w = 3.3 * scale;
  out.h = 2.1 * scale;
  out.bend = 0;
  switch (layout) {
    case 'curve': {
      // a long S through space: the camera stands near the front of it
      const t = wrapped;
      const u = t * 2 - 1;
      pos.set(u * 17 + Math.sin(t * 9) * 1.8, Math.sin(t * 6.2 + 0.6) * 3.8, Math.cos(t * 4.4) * 7 - 9 * Math.abs(u) + 5);
      E.set(Math.sin(t * 6.2) * 0.12, Math.cos(t * 4.4) * 0.5 - u * 0.5, Math.sin(t * 9) * 0.06);
      rot.setFromEuler(E);
      out.w *= 1.25;
      out.h *= 1.25;
      out.bend = 0.12;
      break;
    }
    case 'orbit': {
      const a = wrapped * Math.PI * 2 + s.yaw;
      const r = room ? 8.6 : 11;
      pos.set(Math.sin(a) * r, Math.sin(a * 2 + s.pitch) * 0.9 + (i % 2 ? 1.1 : -1.1), Math.cos(a) * r - (room ? 3 : 6));
      E.set(0, a, 0);
      rot.setFromEuler(E);
      out.bend = -0.14;
      break;
    }
    case 'sphere': {
      // Fibonacci sphere, turned by yaw and pitch
      const y = 1 - ((i + 0.5) / n) * 2;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * 2.39996 + s.yaw + s.phase * 0.6;
      const R = room ? 7.6 : 9.5;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;
      const cp = Math.cos(s.pitch);
      const sp = Math.sin(s.pitch);
      const yy = y * cp - z * sp;
      const zz = y * sp + z * cp;
      pos.set(x * R, yy * R, zz * R - (room ? 2 : 5));
      Q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(x, yy, zz).normalize());
      rot.copy(Q);
      out.w *= 0.95;
      out.h *= 0.95;
      out.bend = 0.1;
      break;
    }
    case 'spiral': {
      const t = i / n;
      const turns = 3.2;
      const a = t * Math.PI * 2 * turns + s.phase * 0.7 + s.yaw;
      const r = room ? 7.4 : 9.2;
      const y = (((t + s.phase * 0.035) % 1 + 1) % 1 - 0.5) * 22;
      pos.set(Math.sin(a) * r, y, Math.cos(a) * r - (room ? 3 : 5));
      E.set(0, a, 0.08);
      rot.setFromEuler(E);
      out.bend = -0.2;
      break;
    }
    case 'perspective': {
      const t = wrapped;
      const z = -t * 44 + 8;
      const side = i % 3;
      const lane = side === 0 ? -6.4 : side === 1 ? 6.4 : 0;
      pos.set(lane + Math.sin(i * 1.7) * 1.6, Math.cos(i * 2.3) * 3 + (side === 2 ? 3.4 : 0), z);
      E.set(0, -lane * 0.024, 0);
      rot.setFromEuler(E);
      break;
    }
    case 'grid':
    default: {
      const cols = Math.max(3, Math.ceil(Math.sqrt(n * 1.6)));
      const rows = Math.ceil(n / cols);
      const cx = (i % cols) - (cols - 1) / 2;
      const cy = Math.floor(i / cols) - (rows - 1) / 2;
      const sx = (cx + ((s.yaw * 1.4) % cols)) * 4.1;
      const sy = -(cy + ((s.phase * 0.35) % rows)) * 2.9;
      const wrapX = ((sx + (cols * 4.1) / 2) % (cols * 4.1) + cols * 4.1) % (cols * 4.1) - (cols * 4.1) / 2;
      const wrapY = ((sy + (rows * 2.9) / 2) % (rows * 2.9) + rows * 2.9) % (rows * 2.9) - (rows * 2.9) / 2;
      const wave = Math.sin(wrapX * 0.34 + s.pitch * 3) * Math.cos(wrapY * 0.42) * 1.5;
      pos.set(wrapX, wrapY, wave - 2);
      E.set(Math.cos(wrapY * 0.42) * 0.1, Math.cos(wrapX * 0.34) * 0.12, 0);
      rot.setFromEuler(E);
      out.w = 3.6;
      out.h = 2.4;
      break;
    }
  }
}

/** How a frame of this arrangement answers: `near` is its spring 0…1, (sx, sy) points from the pointer to the frame on the screen. */
function answer(layout: GalleryLayout, near: number, sx: number, sy: number, pos: THREE.Vector3, rot: THREE.Quaternion, out: { w: number; h: number; bend: number }): void {
  const abs = Math.abs(near);
  if (abs < 0.002) return;
  const d = Math.hypot(sx, sy) + 1e-4;
  switch (layout) {
    case 'curve':
      pos.z += near * 3.4;
      E.set(sy / d * near * 0.5, -sx / d * near * 0.6, 0);
      rot.multiply(Q.setFromEuler(E));
      break;
    case 'orbit':
      pos.z += near * 2.2;
      pos.y += near * 0.7;
      out.bend *= 1 + near * 1.8;
      break;
    case 'sphere': {
      const k = near * 3;
      const len = Math.hypot(pos.x, pos.y, pos.z + 5) + 1e-3;
      pos.set(pos.x + (pos.x / len) * k, pos.y + (pos.y / len) * k, pos.z + ((pos.z + 5) / len) * k);
      break;
    }
    case 'spiral':
      pos.x *= 1 + near * 0.22;
      pos.z += near * 1.8;
      pos.y += near * 1.1;
      out.bend *= 1 - near * 0.8;
      break;
    case 'perspective':
      pos.x += (sx / d) * abs * 4.2;
      pos.y += (sy / d) * abs * 3;
      E.set(-(sy / d) * abs * 0.5, (sx / d) * abs * 0.7, 0);
      rot.multiply(Q.setFromEuler(E));
      break;
    default:
      pos.z += near * 4.2;
      E.set(sy / d * near * 0.4, -sx / d * near * 0.4, 0);
      rot.multiply(Q.setFromEuler(E));
      out.w *= 1 + near * 0.06;
      out.h *= 1 + near * 0.06;
  }
}

export interface GalleryScene {
  instance: WorldInstance;
  state: GalleryState;
  /** Plane index under a screen position, or -1. */
  pick(u: number, v: number): number;
  count: number;
}

interface BuildOptions {
  layout: GalleryLayout;
  urls: string[];
  /** Pre-drawn textures for the room's real items (canvas with a grid of tiles). */
  atlasCanvas?: { canvas: HTMLCanvasElement; cols: number; rows: number; tileOf: (i: number) => [number, number] };
  count: number;
  room: boolean;
  onReady?: (scene: GalleryScene) => void;
}

export function buildGallery(env: WorldEnv, bridge: SpatialBridge, palette: PaletteId, options: BuildOptions): Promise<WorldInstance> {
  const state: GalleryState = { phase: 0, yaw: 0, pitch: 0, focus: 0 };
  return threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const n = options.count;
      const plane = new THREE.PlaneGeometry(1, 1, 18, 1);
      const g = new THREE.InstancedBufferGeometry();
      g.index = plane.index;
      g.setAttribute('position', plane.getAttribute('position'));
      g.setAttribute('uv', plane.getAttribute('uv'));
      const iPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      const iRot = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      const iSize = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
      const iTile = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
      const iFocus = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
      const iBend = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
      [iPos, iRot, iSize, iFocus, iBend].forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('iPos', iPos);
      g.setAttribute('iRot', iRot);
      g.setAttribute('iSize', iSize);
      g.setAttribute('iTile', iTile);
      g.setAttribute('iFocus', iFocus);
      g.setAttribute('iBend', iBend);
      g.instanceCount = n;
      let atlasTexture: THREE.Texture;
      let disposeAtlas: () => void;
      let grid: [number, number];
      if (options.atlasCanvas) {
        const tex = new THREE.CanvasTexture(options.atlasCanvas.canvas);
        tex.colorSpace = THREE.NoColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        atlasTexture = tex;
        disposeAtlas = () => tex.dispose();
        grid = [options.atlasCanvas.cols, options.atlasCanvas.rows];
        for (let i = 0; i < n; i++) {
          const [c, r] = options.atlasCanvas.tileOf(i);
          iTile.setXY(i, c, r);
        }
        (options.atlasCanvas.canvas as HTMLCanvasElement & { __tex?: THREE.Texture }).__tex = tex;
      } else {
        const atlas = makeArtAtlas(options.urls, 4, 3, 320, 200);
        atlasTexture = atlas.texture;
        disposeAtlas = () => atlas.dispose();
        grid = [4, 3];
        for (let i = 0; i < n; i++) {
          const pick = (i * 5 + (i >> 2)) % 12;
          iTile.setXY(i, pick % 4, Math.floor(pick / 4));
        }
      }
      const material = new THREE.ShaderMaterial({
        vertexShader: VS,
        fragmentShader: FS,
        uniforms: withUniforms(kit, { uArt: { value: atlasTexture }, uGrid: { value: new THREE.Vector2(grid[0], grid[1]) } }),
        side: THREE.DoubleSide,
        transparent: true,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(g, material);
      mesh.frustumCulled = false;
      kit.scene.add(mesh);
      const pos = new THREE.Vector3();
      const rot = new THREE.Quaternion();
      const size = { w: 1, h: 1, bend: 0 };
      const view = new THREE.Vector3();
      const focusValues = new Float32Array(n);
      const screen = new Float32Array(n * 3);
      const near = new Float32Array(n);
      const nearV = new Float32Array(n);
      const probe = { lifted: 0, spin: 0, presses: 0 };
      if (!options.room) bridge.probe = probe;
      let spinX = 0;
      let spinY = 0;
      let flowX = 0;
      let flowY = 0;
      const presses: { u: number; v: number; age: number }[] = [];
      kit.camera.position.set(0, 0, options.room ? 13 : 15);
      const api: GalleryScene = {
        instance: null as unknown as WorldInstance,
        state,
        count: n,
        pick(u, v) {
          let best = -1;
          let bestZ = 1e9;
          for (let i = 0; i < n; i++) {
            const dx = Math.abs(u - screen[i * 3]);
            const dy = Math.abs(v - screen[i * 3 + 1]);
            const extent = 0.16 / Math.max(0.3, screen[i * 3 + 2] / 16);
            if (dx < extent * 0.72 && dy < extent * 0.72 * kit.camera.aspect * 0.62 && screen[i * 3 + 2] < bestZ) {
              bestZ = screen[i * 3 + 2];
              best = i;
            }
          }
          return best;
        },
      };
      options.onReady?.(api);
      return {
        slabs: options.room ? 0 : 0.9,
        update(t, dt) {
          const p = env.pointer;
          if (!options.room) {
            // What a stroke gives a frame arrangement it keeps for a while, and loses slowly.
            spinX += p.vx * p.strength * dt * 1.6;
            spinY += p.vy * p.strength * dt * 1.6;
            const drag = Math.exp(-dt * 1.1);
            spinX *= drag;
            spinY *= drag;
            flowX += spinX * dt;
            flowY += spinY * dt;
            probe.spin = spinX;
            const l = options.layout;
            state.phase = bridge.scrollProgress * n * 0.5 + t * 0.03 + (l === 'curve' ? flowX * 5 : l === 'perspective' ? flowY * 7 : l === 'spiral' ? flowY * 9 : l === 'grid' ? flowY * 2.5 : 0);
            state.yaw = t * 0.012 + (p.su - 0.5) * 0.4 * p.strength + (l === 'orbit' || l === 'sphere' ? flowX * 1.5 : l === 'grid' ? flowX * 1.2 : 0);
            state.pitch = (p.sv - 0.5) * 0.3 * p.strength + (l === 'sphere' ? flowY : 0);
            for (const pulse of p.drainPulses()) {
              presses.push({ u: pulse.u, v: pulse.v, age: 0 });
              probe.presses += 1;
              if (presses.length > 3) presses.shift();
            }
            for (const press of presses) press.age += dt;
            while (presses.length && presses[0].age > 1.6) presses.shift();
          }
          kit.camera.position.x += ((p.su - 0.5) * 1.2 * p.strength - kit.camera.position.x) * Math.min(1, dt * 2);
          kit.camera.position.y += ((p.sv - 0.5) * 0.8 * p.strength - kit.camera.position.y) * Math.min(1, dt * 2);
          kit.camera.lookAt(0, 0, -2);
          kit.camera.updateMatrixWorld();
          let nearest = 1e9;
          let focus = 0;
          const aspect = kit.camera.aspect;
          let lifted = 0;
          for (let i = 0; i < n; i++) {
            layoutPlane(options.layout, i, n, state, pos, rot, options.room, size);
            if (!options.room) {
              view.copy(pos).project(kit.camera);
              const u = view.x * 0.5 + 0.5;
              const v = view.y * 0.5 + 0.5;
              const sx = (u - p.u) * aspect;
              const sy = v - p.v;
              let want = view.z < 1 ? Math.exp(-(sx * sx + sy * sy) / 0.045) * p.strength : 0;
              for (const press of presses) {
                const dist = Math.hypot((u - press.u) * aspect, v - press.v);
                const x = (dist - press.age * 0.9) / 0.11;
                want += Math.exp(-x * x) * Math.max(0, 1 - press.age / 1.6) * 1.1;
              }
              nearV[i] += ((want - near[i]) * 34 - nearV[i] * 7.5) * dt;
              near[i] += nearV[i] * dt;
              lifted = Math.max(lifted, near[i]);
              answer(options.layout, near[i], sx, sy, pos, rot, size);
            }
            iPos.setXYZ(i, pos.x, pos.y, pos.z);
            iRot.setXYZW(i, rot.x, rot.y, rot.z, rot.w);
            iSize.setXY(i, size.w, size.h);
            iBend.setX(i, size.bend);
            view.copy(pos).project(kit.camera);
            const depth = pos.distanceTo(kit.camera.position);
            screen[i * 3] = view.x * 0.5 + 0.5;
            screen[i * 3 + 1] = view.y * 0.5 + 0.5;
            screen[i * 3 + 2] = depth;
            const central = Math.hypot(view.x * 1.2, view.y) + depth * 0.05;
            if (central < nearest) {
              nearest = central;
              focus = i;
            }
          }
          state.focus = focus;
          probe.lifted = lifted;
          for (let i = 0; i < n; i++) {
            focusValues[i] += ((options.room ? (i === focus ? 1 : 0) : Math.min(1, Math.max(0, near[i]))) - focusValues[i]) * Math.min(1, dt * 8);
            iFocus.setX(i, focusValues[i]);
          }
          iPos.needsUpdate = true;
          iRot.needsUpdate = true;
          iSize.needsUpdate = true;
          iBend.needsUpdate = true;
          iFocus.needsUpdate = true;
        },
        dispose: () => disposeAtlas(),
      };
    },
    { fov: 44, z: 15 },
  );
}

const make: SpatialSceneFactory = (env, bridge, opts, palette) =>
  buildGallery(env, bridge, palette, {
    layout: (opts.layout as GalleryLayout) ?? 'curve',
    urls: ART_POOL,
    count: opts.dense ? 56 : opts.layout === 'perspective' ? 36 : 42,
    room: false,
  });
export default make;
