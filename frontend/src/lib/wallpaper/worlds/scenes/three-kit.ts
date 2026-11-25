import * as THREE from 'three';
import type { WorldEnv } from '../types';

/** What the three.js worlds share: one renderer bound to the runtime's context, sizing, and a clean release. */

export function makeRenderer(env: WorldEnv): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas: env.canvas, context: env.gl, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(env.width, env.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  return renderer;
}

export function disposeScene(scene: THREE.Object3D): void {
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose?.();
  });
}

/** A soft round sprite for point clouds and glows. */
export function glowTexture(size = 64): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Merges a list of plain indexed-or-not geometries into one (position + normal only, plus optional colour). */
export function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertices = 0;
  const flat = parts.map((part) => (part.index ? part.toNonIndexed() : part));
  for (const part of flat) vertices += part.getAttribute('position').count;
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const color = new Float32Array(vertices * 3);
  let offset = 0;
  for (const part of flat) {
    const p = part.getAttribute('position');
    part.computeVertexNormals();
    const n = part.getAttribute('normal');
    const c = part.getAttribute('color');
    for (let i = 0; i < p.count; i++) {
      position[(offset + i) * 3] = p.getX(i);
      position[(offset + i) * 3 + 1] = p.getY(i);
      position[(offset + i) * 3 + 2] = p.getZ(i);
      normal[(offset + i) * 3] = n.getX(i);
      normal[(offset + i) * 3 + 1] = n.getY(i);
      normal[(offset + i) * 3 + 2] = n.getZ(i);
      color[(offset + i) * 3] = c ? c.getX(i) : 1;
      color[(offset + i) * 3 + 1] = c ? c.getY(i) : 1;
      color[(offset + i) * 3 + 2] = c ? c.getZ(i) : 1;
    }
    offset += p.count;
    part.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return merged;
}

export const NOISE_3D = /* glsl */ `
float n3hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(n3hash(i), n3hash(i + vec3(1,0,0)), f.x), mix(n3hash(i + vec3(0,1,0)), n3hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(n3hash(i + vec3(0,0,1)), n3hash(i + vec3(1,0,1)), f.x), mix(n3hash(i + vec3(0,1,1)), n3hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3d(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * n3(p); p = p * 2.03 + 1.7; a *= 0.5; } return s; }
`;

/** Pointer position on a horizontal or facing plane at a depth, in world units (for scene forces). */
export function pointerOnPlane(env: WorldEnv, camera: THREE.PerspectiveCamera, planeZ: number, out: THREE.Vector3): THREE.Vector3 {
  const p = env.pointer;
  const ndc = new THREE.Vector3(p.su * 2 - 1, p.sv * 2 - 1, 0.5).unproject(camera);
  const dir = ndc.sub(camera.position).normalize();
  const t = (planeZ - camera.position.z) / dir.z;
  return out.copy(camera.position).addScaledVector(dir, t);
}
