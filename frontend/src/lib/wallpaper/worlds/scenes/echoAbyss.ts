import * as THREE from 'three';
import { musicBands } from '@/lib/vfx/audio';
import { vfxReduced } from '@/lib/vfx/quality';
import { ECHO_MODEL_URL } from '@/components/landing/ocean/echoAssets';
import { loadWhaleRig, type WhaleRig } from '@/components/landing/ocean/whaleRig';
import type { WorldFactory } from '../types';
import { darkEase } from '../gl';
import { NOISE_3D, disposeScene, glowTexture, makeRenderer, mergeSimple, pointerOnPlane, rand } from './three-kit';

/**
 * Echo Abyss. A real 3D ocean: Echo (the product's own rigged whale model) swims a long path through it, with living
 * freckles of light in the skin; jellyfish pulse in the mid-water, a school of instanced fish steers around the pointer,
 * marine snow drifts through volumetric-looking shafts of light, and a glowing reef closes the bottom of the frame.
 * Midnight water in dark appearance, bright turquoise in light.
 */

const DOME_VS = /* glsl */ `
varying vec3 vDir;
void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const DOME_FS = /* glsl */ `
varying vec3 vDir;
uniform float uTime;
uniform float uDark;
${NOISE_3D}
void main() {
  vec3 d = normalize(vDir);
  float up = d.y * 0.5 + 0.5;
  vec3 midnight = mix(vec3(0.004, 0.012, 0.05), vec3(0.015, 0.14, 0.32), smoothstep(0.18, 0.95, up));
  vec3 lagoon = mix(vec3(0.03, 0.26, 0.42), vec3(0.34, 0.86, 0.92), smoothstep(0.1, 0.92, up));
  vec3 col = mix(lagoon, midnight, uDark);
  // shafts of light from the surface, moving with the swell
  vec2 sun = d.xz / (0.35 + max(d.y, 0.0));
  float angle = atan(d.x, d.y + 1.1);
  float rays = n3(vec3(angle * 11.0, uTime * 0.09, 1.0)) * n3(vec3(angle * 27.0, uTime * 0.06, 4.0));
  float beam = smoothstep(0.12, 0.42, rays) * smoothstep(-0.2, 0.9, d.y);
  col += mix(vec3(0.75, 1.0, 0.95), vec3(0.14, 0.52, 0.72), uDark) * beam * mix(0.42, 0.62, uDark);
  // the moving surface, far above
  float surface = fbm3d(vec3(sun * 2.4, uTime * 0.08));
  col += mix(vec3(0.5, 0.65, 0.6), vec3(0.08, 0.3, 0.42), uDark) * smoothstep(0.42, 0.72, surface) * smoothstep(0.62, 1.0, up);
  gl_FragColor = vec4(col, 1.0);
}`;

const SNOW_VS = /* glsl */ `
attribute float aSeed;
varying float vAlpha;
uniform float uTime;
uniform vec3 uMouse;
uniform float uStrength;
uniform float uEnergy;
uniform float uPixel;
void main() {
  vec3 p = position;
  p.y = mod(p.y - uTime * (0.05 + aSeed * 0.08) + 20.0, 40.0) - 20.0;
  p.x += sin(uTime * 0.2 + aSeed * 40.0) * 0.5;
  p.z += cos(uTime * 0.17 + aSeed * 30.0) * 0.5;
  vec3 d = p - uMouse;
  float r2 = dot(d.xy, d.xy);
  float push = exp(-r2 * 0.5) * uStrength * (0.3 + uEnergy * 2.0);
  p.xy += normalize(d.xy + 0.001) * push * 1.8;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (2.0 + aSeed * 5.0) * uPixel * (14.0 / -mv.z);
  vAlpha = (0.2 + aSeed * 0.7) * smoothstep(50.0, 12.0, -mv.z);
}`;
const SNOW_FS = /* glsl */ `
varying float vAlpha;
uniform vec3 uColor;
void main() {
  float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(uColor * a * vAlpha, a * vAlpha);
}`;

/** One jellyfish: bell + tentacle ribbons, deformed entirely in the vertex shader. */
function makeJellyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const bell = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const colorOf = (g: THREE.BufferGeometry, r: number) => {
    const count = g.getAttribute('position').count;
    const a = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      a[i * 3] = r;
      a[i * 3 + 1] = g.getAttribute('position').getY(i);
      a[i * 3 + 2] = 0;
    }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  };
  colorOf(bell, 0);
  parts.push(bell);
  const n = 14;
  for (let k = 0; k < n; k++) {
    const ang = (k / n) * Math.PI * 2;
    const r = 0.72 + (k % 2) * 0.16;
    const length = 2.4 + (k % 3) * 1.1;
    const tube = new THREE.CylinderGeometry(0.02, 0.008, length, 4, 16, true);
    tube.translate(0, -length / 2, 0);
    tube.rotateY(ang);
    tube.translate(Math.cos(ang) * r, 0.08, Math.sin(ang) * r);
    colorOf(tube, 1);
    parts.push(tube);
  }
  return mergeSimple(parts);
}

const JELLY_VS = /* glsl */ `
attribute vec4 aInst;
attribute vec3 aTint;
varying float vKind;
varying float vFres;
varying vec3 vTint;
varying float vY;
uniform float uTime;
void main() {
  vKind = color.r;
  vTint = aTint;
  vec3 p = position;
  float t = uTime * 0.72 + aInst.w * 6.28;
  float cycle = fract(t);
  float squeeze = cycle < 0.3 ? sin(cycle / 0.3 * 1.57) : 1.0 - smoothstep(0.3, 1.0, cycle);
  if (color.r < 0.5) {
    float ring = 1.0 - position.y;
    p.xz *= 1.0 - squeeze * 0.26 * ring;
    p.y *= 1.0 + squeeze * 0.2;
    p.xz *= 1.0 + 0.04 * sin(atan(position.z, position.x) * 7.0 + uTime * 1.8);
  } else {
    float u = clamp(-position.y / 4.0, 0.0, 1.0);
    p.xz *= 1.0 - squeeze * 0.2 * (1.0 - u);
    p.x += sin(uTime * 0.9 + u * 7.0 + aInst.w * 20.0 + position.z * 2.0) * u * 0.46;
    p.z += cos(uTime * 0.76 + u * 6.0 + aInst.w * 13.0 + position.x * 2.0) * u * 0.46;
    p.y *= 1.0 - squeeze * 0.18;
  }
  float scale = aInst.y;
  vec3 world = p * scale + vec3(aInst.x, 0.0, aInst.z);
  world.y += sin(t * 6.28318 / 3.0) * 0.4 + aInst.w * 0.0;
  vY = position.y;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFres = pow(1.0 - abs(dot(n, normalize(-mv.xyz))), 2.2);
  gl_Position = projectionMatrix * mv;
}`;
const JELLY_FS = /* glsl */ `
varying float vKind;
varying float vFres;
varying vec3 vTint;
varying float vY;
void main() {
  float a;
  vec3 c;
  if (vKind < 0.5) {
    a = 0.1 + vFres * 0.85;
    c = mix(vTint, vec3(1.0), vFres * 0.5) * (1.1 + vFres * 2.0);
  } else {
    float u = clamp(-vY / 4.0, 0.0, 1.0);
    a = 0.62 * (1.0 - u);
    c = vTint * 1.4;
  }
  gl_FragColor = vec4(c * a, a);
}`;

function makeFishGeometry(): THREE.BufferGeometry {
  // A small diamond body with a tail: head toward +Z.
  const v = [0, 0, 0.5, 0.11, 0, 0, 0, 0.16, 0, -0.11, 0, 0, 0, 0, -0.34, 0, -0.14, 0, 0, 0.22, -0.56, 0, -0.22, -0.56];
  const idx = [0, 1, 2, 0, 2, 3, 2, 1, 4, 3, 2, 4, 1, 0, 5, 0, 3, 5, 1, 5, 4, 5, 3, 4, 4, 6, 7, 4, 7, 6];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Rocks with coral and sponge, merged: they close the bottom of the frame and hold the glow. */
function makeReef(): THREE.Group {
  const group = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [];
  const paint = (g: THREE.BufferGeometry, r: number, gg: number, b: number) => {
    const c = new Float32Array(g.getAttribute('position').count * 3);
    for (let i = 0; i < c.length; i += 3) {
      c[i] = r;
      c[i + 1] = gg;
      c[i + 2] = b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  };
  for (let i = 0; i < 46; i++) {
    const rock = new THREE.IcosahedronGeometry(rand(1.5, 5.2), 1);
    const p = rock.getAttribute('position');
    for (let k = 0; k < p.count; k++) p.setXYZ(k, p.getX(k) * rand(0.9, 1.15), p.getY(k) * rand(0.5, 0.9), p.getZ(k) * rand(0.9, 1.15));
    const side = i % 2 ? -1 : 1;
    rock.translate(rand(0, 1) < 0.6 ? side * rand(10, 32) : rand(-30, 30), -11.4 + rand(-1.2, 1), rand(-16, 8));
    paint(rock, 0.02, 0.05, 0.1);
    parts.push(rock);
  }
  const rocks = new THREE.Mesh(mergeSimple(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  group.add(rocks);
  // Coral fans: thin glowing branches, each its own colour.
  const glow: THREE.BufferGeometry[] = [];
  const colors: [number, number, number][] = [[1, 0.28, 0.5], [1, 0.54, 0.2], [0.46, 0.5, 1], [0.2, 0.92, 0.84], [0.86, 0.3, 1]];
  const grow = (x: number, y: number, z: number, a: number, b: number, len: number, depth: number, col: [number, number, number]) => {
    const dir = new THREE.Vector3(Math.sin(a) * Math.cos(b), Math.cos(a), Math.sin(a) * Math.sin(b));
    const end = new THREE.Vector3(x, y, z).addScaledVector(dir, len);
    const tube = new THREE.CylinderGeometry(0.03 * (6 - depth) * 0.26, 0.05 * (6 - depth) * 0.26, len, 5);
    tube.translate(0, len / 2, 0);
    tube.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    tube.translate(x, y, z);
    paint(tube, col[0], col[1], col[2]);
    glow.push(tube);
    if (depth < 4) {
      const kids = depth < 2 ? 3 : 2;
      for (let k = 0; k < kids; k++) grow(end.x, end.y, end.z, a + rand(-0.75, 0.75), b + rand(-1.2, 1.2), len * rand(0.62, 0.8), depth + 1, col);
    }
  };
  for (let i = 0; i < 26; i++) {
    const side = i % 2 ? -1 : 1;
    const x = i % 5 === 0 ? rand(-14, 14) : side * rand(11, 30);
    grow(x, -10, rand(-12, 7), rand(-0.3, 0.3), rand(0, 6.28), rand(1.1, 2.1), 0, colors[i % colors.length]);
  }
  const coral = new THREE.Mesh(mergeSimple(glow), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  group.add(coral);
  return group;
}

const factory: WorldFactory = async (env) => {
  const renderer = makeRenderer(env);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, env.width / env.height, 0.1, 200);
  camera.position.set(0, 0, 24);

  const uniforms = { uTime: { value: 0 }, uDark: { value: env.params.dark ? 1 : 0 } };
  const dome = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 20), new THREE.ShaderMaterial({ vertexShader: DOME_VS, fragmentShader: DOME_FS, uniforms, side: THREE.BackSide, depthWrite: false }));
  dome.renderOrder = -10;
  scene.add(dome);

  const fog = new THREE.FogExp2(0x03152f, 0.021);
  scene.fog = fog;

  const key = new THREE.DirectionalLight(0xbfe9ff, 1.8);
  key.position.set(-6, 22, 12);
  scene.add(key);
  const under = new THREE.HemisphereLight(0x7fd6ff, 0x081026, 1.2);
  scene.add(under);
  const rim = new THREE.PointLight(0x62e0ff, 40, 40, 1.6);
  scene.add(rim);

  const reef = makeReef();
  reef.position.y = -0.4;
  scene.add(reef);

  // Marine snow.
  const snowCount = env.tier === 'high' ? 2800 : env.tier === 'balanced' ? 1500 : 600;
  const snowPos = new Float32Array(snowCount * 3);
  const snowSeed = new Float32Array(snowCount);
  for (let i = 0; i < snowCount; i++) {
    snowPos[i * 3] = rand(-44, 44);
    snowPos[i * 3 + 1] = rand(-20, 20);
    snowPos[i * 3 + 2] = rand(-40, 18);
    snowSeed[i] = Math.random();
  }
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  snowGeo.setAttribute('aSeed', new THREE.BufferAttribute(snowSeed, 1));
  const snowUniforms = {
    uTime: uniforms.uTime,
    uMouse: { value: new THREE.Vector3() },
    uStrength: { value: 0 },
    uEnergy: { value: 0 },
    uPixel: { value: 1 },
    uColor: { value: new THREE.Color(0.7, 0.95, 1.0) },
  };
  const snow = new THREE.Points(snowGeo, new THREE.ShaderMaterial({ vertexShader: SNOW_VS, fragmentShader: SNOW_FS, uniforms: snowUniforms, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }));
  snow.frustumCulled = false;
  scene.add(snow);

  // Jellyfish.
  const jellyCount = env.tier === 'low' ? 4 : 8;
  const jellyGeo = new THREE.InstancedBufferGeometry();
  const base = makeJellyGeometry();
  jellyGeo.setAttribute('position', base.getAttribute('position'));
  jellyGeo.setAttribute('normal', base.getAttribute('normal'));
  jellyGeo.setAttribute('color', base.getAttribute('color'));
  jellyGeo.instanceCount = jellyCount;
  const jellyInst = new Float32Array(jellyCount * 4);
  const jellyTint = new Float32Array(jellyCount * 3);
  const jellyY = new Float32Array(jellyCount);
  const jellySpots: [number, number, number, number][] = [[-15, 4, -6, 1.5], [13, 6, -4, 1.9], [-7, 8, -14, 1.2], [20, -1, -12, 1.4], [-24, -2, -14, 1.5], [6, -3, -18, 1.1], [28, 8, -20, 1.5], [-30, 8, -22, 1.5]];
  const tints: [number, number, number][] = [[0.9, 0.42, 1], [0.42, 0.72, 1], [1, 0.46, 0.76], [0.36, 0.94, 0.94]];
  for (let i = 0; i < jellyCount; i++) {
    const [x, y, z, s] = jellySpots[i];
    jellyInst.set([x, s, z, Math.random()], i * 4);
    jellyTint.set(tints[i % tints.length], i * 3);
    jellyY[i] = y;
  }
  const jellyInstAttr = new THREE.InstancedBufferAttribute(jellyInst, 4);
  jellyGeo.setAttribute('aInst', jellyInstAttr);
  jellyGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(jellyTint, 3));
  const jellyGroup = new THREE.Group();
  // Each jelly shares the shader: y lives in a per-group offset so the instancing stays one draw call.
  const jellyMat = new THREE.ShaderMaterial({
    vertexShader: JELLY_VS.replace('world.y += sin(t * 6.28318 / 3.0) * 0.4 + aInst.w * 0.0;', 'world.y += aY + sin(uTime * 0.24 + aInst.w * 6.28) * 1.2;').replace('attribute vec4 aInst;', 'attribute vec4 aInst;\nattribute float aY;'),
    fragmentShader: JELLY_FS,
    uniforms: { uTime: uniforms.uTime },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexColors: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  jellyGeo.setAttribute('aY', new THREE.InstancedBufferAttribute(jellyY, 1));
  const jellies = new THREE.Mesh(jellyGeo, jellyMat);
  jellies.frustumCulled = false;
  jellyGroup.add(jellies);
  scene.add(jellyGroup);

  // A school of fish: a small boids rule on the CPU, one instanced draw.
  const fishCount = env.tier === 'high' ? 170 : env.tier === 'balanced' ? 100 : 44;
  const fishGeo = makeFishGeometry();
  const fishMat = new THREE.MeshStandardMaterial({ color: 0xbfeaff, emissive: 0x2b6d94, emissiveIntensity: 0.8, roughness: 0.3, metalness: 0.2, flatShading: true });
  const fish = new THREE.InstancedMesh(fishGeo, fishMat, fishCount);
  fish.frustumCulled = false;
  const fp = new Float32Array(fishCount * 3);
  const fv = new Float32Array(fishCount * 3);
  for (let i = 0; i < fishCount; i++) {
    fp.set([rand(-8, 12), rand(-4, 7), rand(-8, 4)], i * 3);
    fv.set([rand(-1, 1), rand(-0.3, 0.3), rand(-1, 1)], i * 3);
  }
  scene.add(fish);

  const dummy = new THREE.Object3D();
  const leader = new THREE.Vector3();
  const mouseWorld = new THREE.Vector3();
  const look = new THREE.Vector3();
  let glow: THREE.CanvasTexture | null = glowTexture();
  const echoGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0x66ccff, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending }));
  echoGlow.scale.setScalar(26);
  scene.add(echoGlow);

  // Echo: the real rigged model, with freckles of bioluminescence travelling in its skin.
  const abort = new AbortController();
  let rig: WhaleRig | null = null;
  const freckle = { uFreckle: { value: 0 } };
  loadWhaleRig(ECHO_MODEL_URL, abort.signal)
    .then((loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      rig = loaded;
      rig.root.scale.setScalar(19);
      rig.root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as THREE.MeshStandardMaterial;
        material.color = new THREE.Color(0x2f62a8);
        material.emissive = new THREE.Color(0x0a2a60);
        material.emissiveIntensity = 0.9;
        const previous = material.onBeforeCompile;
        material.onBeforeCompile = (shader, gl) => {
          previous.call(material, shader, gl);
          shader.uniforms.uFreckle = freckle.uFreckle;
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vBody;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBody = position;');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\nvarying vec3 vBody;\nuniform float uFreckle;\n${NOISE_3D}`)
            .replace(
              '#include <emissivemap_fragment>',
              `#include <emissivemap_fragment>
vec3 bp = vBody * 34.0;
vec3 cell = floor(bp);
vec3 fr = fract(bp) - 0.5;
float pick = step(0.86, n3hash(cell));
float dotLight = pick * smoothstep(0.42, 0.06, length(fr));
float pulse = 0.5 + 0.5 * sin(uFreckle * 1.4 + n3hash(cell + 3.0) * 30.0 + vBody.z * 8.0);
totalEmissiveRadiance += vec3(0.54, 0.95, 1.0) * dotLight * (0.6 + pulse * 1.5);
float belly = smoothstep(0.0, -0.3, vCausticN.y);
totalEmissiveRadiance += vec3(0.04, 0.2, 0.4) * belly;`,
            );
        };
        material.customProgramCacheKey = () => 'echo-abyss-skin';
        material.needsUpdate = true;
      });
      scene.add(rig.root);
    })
    .catch(() => {
      // Without the model the ocean keeps swimming: fish, jellies, light. Nothing is shown as broken.
    });
  let disposed = false;

  let dark = uniforms.uDark.value;
  const nightFog = new THREE.Color(0x031530);
  const dayFog = new THREE.Color(0x2c8fa8);

  const stepFish = (dt: number, t: number) => {
    leader.set(Math.sin(t * 0.13) * 22, Math.sin(t * 0.21) * 4 + 1, Math.cos(t * 0.11) * 8 - 4);
    const p = env.pointer;
    for (let i = 0; i < fishCount; i++) {
      const j = i * 3;
      const dx = leader.x - fp[j] + Math.sin(i * 12.9) * 4;
      const dy = leader.y - fp[j + 1] + Math.cos(i * 7.3) * 2.2;
      const dz = leader.z - fp[j + 2] + Math.sin(i * 4.1) * 4;
      let ax = dx * 0.34;
      let ay = dy * 0.34;
      let az = dz * 0.34;
      ax += Math.sin(t * 0.8 + i) * 0.7;
      ay += Math.cos(t * 0.6 + i * 0.7) * 0.4;
      if (p.strength > 0.01) {
        const mx = fp[j] - mouseWorld.x;
        const my = fp[j + 1] - mouseWorld.y;
        const d2 = mx * mx + my * my + 0.2;
        if (d2 < 44) {
          const k = (1 - d2 / 44) * (12 + p.energy * 34) * p.strength;
          const d = Math.sqrt(d2);
          ax += (mx / d) * k;
          ay += (my / d) * k;
        }
      }
      fv[j] += ax * dt;
      fv[j + 1] += ay * dt;
      fv[j + 2] += az * dt;
      const sp = Math.hypot(fv[j], fv[j + 1], fv[j + 2]) + 1e-3;
      const lim = 4.2;
      if (sp > lim) {
        fv[j] *= lim / sp;
        fv[j + 1] *= lim / sp;
        fv[j + 2] *= lim / sp;
      }
      fp[j] += fv[j] * dt;
      fp[j + 1] += fv[j + 1] * dt;
      fp[j + 2] += fv[j + 2] * dt;
    }
  };

  const heading = new THREE.Vector3(1, 0, 0);
  const pos = new THREE.Vector3();
  const nextPos = new THREE.Vector3();
  const echoPath = (t: number, out: THREE.Vector3) => out.set(Math.sin(t * 0.075) * 15 + 3, Math.sin(t * 0.13 + 1) * 2.3 + 2.2, Math.cos(t * 0.075) * 7 - 6);

  return {
    warm(seconds) {
      const steps = Math.round(seconds * 12);
      for (let i = 0; i < steps; i++) stepFish(1 / 12, i / 12);
    },
    frame(t, dt) {
      const audio = musicBands();
      const response = dt > 0 && !vfxReduced() ? Math.max(0, env.params.motion) * (1 - env.params.calm * .85) : 0;
      dark = darkEase(dark, env.params.dark, dt);
      uniforms.uDark.value = dark;
      uniforms.uTime.value = t;
      fog.color.copy(dayFog).lerp(nightFog, dark);
      fog.density = 0.012 + dark * 0.002;
      snowUniforms.uColor.value.setRGB(0.94 - dark * 0.2, 1, 1);
      key.intensity = (2.6 - dark * 1.1) * (1 + audio.bass * response * .055);
      under.intensity = 1.8 - dark * 0.7;
      freckle.uFreckle.value = t;
      const p = env.pointer;
      // The camera drifts a little with the pointer: a real change of view, not a slide.
      const camTx = (p.su - 0.5) * 3.2 * p.strength + Math.sin(t * 0.07) * 0.8;
      const camTy = (p.sv - 0.5) * 1.8 * p.strength + Math.sin(t * 0.11) * (0.4 + audio.mid * response * .08);
      camera.position.x += (camTx - camera.position.x) * Math.min(1, dt * 1.6);
      camera.position.y += (camTy - camera.position.y) * Math.min(1, dt * 1.6);
      camera.lookAt(0, 0.6, -4);
      camera.updateMatrixWorld();
      pointerOnPlane(env, camera, -2, mouseWorld);
      snowUniforms.uMouse.value.copy(mouseWorld);
      snowUniforms.uStrength.value = p.strength;
      snowUniforms.uEnergy.value = Math.min(1, p.energy + audio.treble * response * .12);
      snowUniforms.uPixel.value = env.pixelRatio;
      if (dt > 0) stepFish(Math.min(dt, 1 / 20), t);
      for (let i = 0; i < fishCount; i++) {
        const j = i * 3;
        dummy.position.set(fp[j], fp[j + 1], fp[j + 2]);
        look.set(fp[j] + fv[j], fp[j + 1] + fv[j + 1], fp[j + 2] + fv[j + 2]);
        dummy.lookAt(look);
        dummy.rotateY(Math.sin(t * 7 + i) * 0.22);
        dummy.scale.setScalar(0.56 + (i % 5) * 0.09);
        dummy.updateMatrix();
        fish.setMatrixAt(i, dummy.matrix);
      }
      fish.instanceMatrix.needsUpdate = true;
      echoPath(t, pos);
      echoPath(t + 0.6, nextPos);
      if (rig) {
        rig.root.position.copy(pos);
        heading.lerp(nextPos.sub(pos).normalize(), Math.min(1, dt * 1.4)).normalize();
        look.copy(pos).add(heading);
        rig.root.lookAt(look);
        rig.setWaterLight(t, 0.42 * (1 - dark * 0.4));
        rig.update(dt, 0.34, p.energy * 0.3);
      }
      echoGlow.position.copy(pos);
      (echoGlow.material as THREE.SpriteMaterial).opacity = 0.14 + dark * 0.14;
      rim.position.copy(pos).add(new THREE.Vector3(-4, 3, 6));
      renderer.render(scene, camera);
    },
    resize() {
      renderer.setSize(env.width, env.height, false);
      camera.aspect = env.width / env.height;
      camera.fov = camera.aspect < 1 ? 66 : 46;
      camera.updateProjectionMatrix();
    },
    dispose() {
      disposed = true;
      abort.abort();
      rig?.dispose();
      if (rig) scene.remove(rig.root);
      disposeScene(scene);
      glow?.dispose();
      glow = null;
      renderer.dispose();
    },
    pixels: 0.9,
  };
};

export default factory;
