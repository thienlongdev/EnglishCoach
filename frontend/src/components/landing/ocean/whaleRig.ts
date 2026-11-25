import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Echo's body: the licensed Blue Colossus Studio "Low poly animated Cartoon Whale" (CC BY 4.0, credited in the
 * landing footer), 1,664 triangles with a 32-joint rig and `swimming` / `idle` clips.
 *
 * The rig never moves itself through space — the ocean engine does. It only answers "how fast is the whale swimming
 * right now?" by blending the idle and swim cycles continuously, so a slow cruise breathes and a sprint beats its tail.
 */
export interface WhaleRig {
  /** Outer node: the engine sets position + orientation. Local +Z is the direction the head points. */
  root: THREE.Group;
  /** Whale length in world units along local Z (always 1). */
  length: number;
  /** Where bubbles leave the body, in `root` space. */
  blowhole: THREE.Vector3;
  /** The tail fluke, in `root` space (sparkle trail origin). */
  fluke: THREE.Vector3;
  /** Sunlight dappling the body: caustic time (s) and strength 0..1. */
  setWaterLight(time: number, strength: number): void;
  update(dt: number, bodyLengthsPerSecond: number, excitement: number): void;
  /** Hold a pleasant still pose (reduced motion). */
  pose(): void;
  /** Where the tail is in its beat: read when Echo leaves a scene, set when it enters the next, so the same stroke carries on. */
  swimTime(): number;
  setSwimTime(time: number): void;
  dispose(): void;
}

// The source model's head points along its −Z; turn it to +Z so the engine's heading aims the head.
const HEAD_YAW = Math.PI;

// Sun-dapples on Echo's skin: the same iterated-sine caustic as the water, in WORLD space, so the light stays in the
// water and the whale swims through it. Brightest on surfaces facing the surface above.
const CAUSTIC_GLSL = /* glsl */ `
  uniform float uCausticTime;
  uniform float uCausticStrength;
  varying vec3 vCausticPos;
  varying vec3 vCausticN;
  float ecCaustic(vec2 p, float t) {
    p = mod(p, 6.28318) - 250.0;
    vec2 i = p;
    float c = 1.0;
    for (int n = 0; n < 3; n++) {
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
    }
    c /= 3.0;
    c = 1.17 - pow(c, 1.4);
    return min(pow(abs(c), 8.0), 1.5);
  }
`;

function addWaterLight(material: THREE.MeshStandardMaterial, uniforms: { uCausticTime: { value: number }; uCausticStrength: { value: number } }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCausticTime = uniforms.uCausticTime;
    shader.uniforms.uCausticStrength = uniforms.uCausticStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vCausticPos;
varying vec3 vCausticN;`)
      .replace(
        '#include <skinning_vertex>',
        `#include <skinning_vertex>
vCausticPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vCausticN = normalize(mat3(modelMatrix) * objectNormal);`
      );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
${CAUSTIC_GLSL}`).replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
float ecUp = clamp(vCausticN.y * 0.85 + 0.25, 0.0, 1.0);
float ecLight = ecCaustic(vCausticPos.xz * 5.5 + vec2(vCausticPos.y * 2.0, 0.0), uCausticTime);
totalEmissiveRadiance += vec3(0.55, 0.88, 1.0) * ecLight * ecUp * uCausticStrength;`
    );
  };
  material.customProgramCacheKey = () => 'echo-water-light';
}

const smooth = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Read a response body chunk by chunk, telling `onProgress` about every chunk and (with `true`) the end. */
async function readBody(response: Response, onProgress: (done: boolean) => void): Promise<ArrayBuffer> {
  if (!response.body) {
    const whole = await response.arrayBuffer();
    onProgress(true);
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
    onProgress(false);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(true);
  return data.buffer;
}

/**
 * Download (abortable) and parse Echo. A plain same-origin `fetch` — mode `cors`, credentials `same-origin` — is the
 * request the page's `<link rel="preload" as="fetch" crossorigin>` already started, so the browser hands over that
 * response instead of downloading the model twice. Aborting `signal` cancels the network request itself.
 * `onProgress` hears the response headers and every body chunk (`done` once the last byte is in): the engine tells a
 * stalled request from a slow one by it.
 */
export async function loadWhaleRig(url: string, signal: AbortSignal, onProgress: (done: boolean) => void = () => {}): Promise<WhaleRig> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`whale model: HTTP ${response.status}`);
  onProgress(false);
  const data = await readBody(response, onProgress);
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  const gltf = await new GLTFLoader().parseAsync(data, '');
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');

  const model = gltf.scene as THREE.Group;
  const facing = new THREE.Group();
  facing.rotation.y = HEAD_YAW;
  facing.add(model);

  // Normalise: centre the body on the origin and make it exactly one unit long.
  const box = new THREE.Box3().setFromObject(facing);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const scale = 1 / Math.max(size.z, 1e-6);
  model.position.sub(centre.applyAxisAngle(new THREE.Vector3(0, 1, 0), -HEAD_YAW));
  const body = new THREE.Group();
  body.scale.setScalar(scale);
  body.add(facing);

  const root = new THREE.Group();
  root.name = 'EchoWhale';
  root.add(body);

  const materials: THREE.Material[] = [];
  const waterLight = { uCausticTime: { value: 0 }, uCausticStrength: { value: 0.6 } };
  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false; // skinned bounds lag the animation; one small mesh is always cheap to draw
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.roughness = 0.55;
        material.metalness = 0;
        material.emissive = new THREE.Color(0x0b2340);
        material.emissiveIntensity = 0.35;
        if (material.map) {
          material.map.anisotropy = 4;
          material.map.colorSpace = THREE.SRGBColorSpace;
        }
        addWaterLight(material, waterLight);
      }
      materials.push(material);
    }
  });

  const mixer = new THREE.AnimationMixer(model);
  const clip = (pattern: RegExp) => gltf.animations.find((c) => pattern.test(c.name));
  const swimClip = clip(/swim/i);
  const idleClip = clip(/idle/i) ?? swimClip;
  const swim = swimClip ? mixer.clipAction(swimClip) : null;
  const idle = idleClip && idleClip !== swimClip ? mixer.clipAction(idleClip) : null;
  for (const action of [swim, idle]) {
    if (!action) continue;
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
  }
  if (swim) swim.time = 0.4;

  let swimWeight = 0.3;

  return {
    root,
    length: 1,
    // Top of the head, a little behind the snout.
    blowhole: new THREE.Vector3(0, 0.2, 0.18),
    fluke: new THREE.Vector3(0, 0.06, -0.46),
    setWaterLight(time, strength) {
      waterLight.uCausticTime.value = time;
      waterLight.uCausticStrength.value = strength;
    },
    update(dt, bodyLengthsPerSecond, excitement) {
      const target = Math.min(1, smooth(0.08, 0.55, bodyLengthsPerSecond) + excitement * 0.6);
      swimWeight += (target - swimWeight) * Math.min(1, dt * 3);
      if (swim) {
        swim.setEffectiveWeight(idle ? swimWeight : 1);
        swim.setEffectiveTimeScale(0.55 + Math.min(1.6, bodyLengthsPerSecond) * 0.7 + excitement * 0.6);
      }
      if (idle) {
        idle.setEffectiveWeight(1 - swimWeight);
        idle.setEffectiveTimeScale(0.85);
      }
      mixer.update(Math.min(dt, 0.1));
    },
    pose() {
      if (swim) {
        swim.setEffectiveWeight(idle ? 0.35 : 1);
        swim.time = 0.55;
      }
      if (idle) {
        idle.setEffectiveWeight(0.65);
        idle.time = 1.1;
      }
      mixer.update(0);
    },
    swimTime() {
      return swim?.time ?? 0;
    },
    setSwimTime(time) {
      if (swim) swim.time = time;
      swimWeight = 1;
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        standard.map?.dispose();
        material.dispose();
      }
    },
  };
}
