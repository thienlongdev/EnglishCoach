import * as THREE from 'three';
import type { WorldFactory } from '../types';
import { NOISE_3D, disposeScene, makeRenderer, mergeSimple, pointerOnPlane, rand } from './three-kit';

/**
 * Luminous Garden. A night forest in real 3D: procedural trees fading into glowing fog, thousands of instanced grass
 * blades that sway in the vertex shader, luminous mushrooms and moss, a slow stream of light. Fireflies live on the GPU
 * and steer around the pointer; a touch sends a ring of light travelling through the grass. The camera drifts forward
 * and back like someone walking slowly.
 */

const SKY_VS = /* glsl */ `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FS = /* glsl */ `
varying vec3 vDir;
uniform float uTime;
${NOISE_3D}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(vec3(0.016, 0.12, 0.14), vec3(0.003, 0.016, 0.034), smoothstep(-0.05, 0.42, h));
  // the bright clearing far ahead, where the fog holds the light
  float glow = exp(-length(vec2(d.x * 1.4 - 0.1, (h - 0.04) * 2.4)) * 4.2);
  col += vec3(0.14, 0.86, 0.78) * glow;
  float rays = n3(vec3(atan(d.x, h + 0.7) * 16.0, uTime * 0.05, 0.0));
  col += vec3(0.05, 0.3, 0.28) * smoothstep(0.45, 0.8, rays) * smoothstep(0.65, 0.05, h) * glow * 1.6;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const GRASS_VS = /* glsl */ `
attribute vec3 aOffset;
attribute float aSeed;
varying float vHeight;
varying float vGlow;
varying float vSeed;
varying float vFog;
uniform float uTime;
uniform vec3 uMouse;
uniform float uStrength;
uniform vec4 uRing;
void main() {
  float h = position.y;
  vHeight = h;
  vSeed = aSeed;
  vec3 p = position;
  float bladeScale = 0.6 + aSeed * 1.1;
  p.y *= bladeScale;
  // wind: a travelling wave across the meadow, stronger at the tip
  float wind = sin(aOffset.x * 0.34 + uTime * 1.1 + aSeed * 2.0) * 0.3 + sin(aOffset.z * 0.7 - uTime * 0.7) * 0.2;
  vec3 world = aOffset + vec3(p.x * cos(aSeed * 40.0) - p.z * sin(aSeed * 40.0), p.y, p.x * sin(aSeed * 40.0) + p.z * cos(aSeed * 40.0));
  world.x += wind * h * h * bladeScale * 0.8;
  // pushed gently aside by the pointer, and lit by a passing ring
  vec2 d = world.xz - uMouse.xz;
  float dist = length(d);
  float near = exp(-dist * dist * 0.14) * uStrength;
  world.xz += normalize(d + 0.001) * near * h * h * 1.8;
  float ring = 0.0;
  if (uRing.w > 0.0) {
    float rd = length(aOffset.xz - uRing.xz);
    ring = exp(-pow((rd - uRing.y) * 1.1, 2.0)) * uRing.w;
  }
  float breath = 0.5 + 0.5 * sin(uTime * 0.4 + aOffset.x * 0.2 + aOffset.z * 0.3);
  vGlow = near * 0.7 + ring * 1.8 + 0.12 * breath * smoothstep(0.86, 1.0, aSeed);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vFog = 1.0 - exp(-pow(-mv.z * 0.052, 1.6));
  gl_Position = projectionMatrix * mv;
}`;
const GRASS_FS = /* glsl */ `
varying float vHeight;
varying float vGlow;
varying float vSeed;
varying float vFog;
void main() {
  vec3 base = mix(vec3(0.002, 0.016, 0.018), vec3(0.008, 0.085, 0.07), vHeight);
  base = mix(base, vec3(0.03, 0.34, 0.26), step(0.82, vSeed) * vHeight * vHeight);
  vec3 glow = mix(vec3(0.1, 0.95, 0.76), vec3(0.42, 1.0, 0.6), vSeed);
  vec3 col = base + glow * vGlow * (0.3 + vHeight);
  col = mix(col, vec3(0.022, 0.17, 0.18), vFog);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const FIREFLY_VS = /* glsl */ `
attribute vec3 aSeed;
varying float vA;
varying vec3 vC;
uniform float uTime;
uniform vec3 uMouse;
uniform float uStrength;
uniform float uPixel;
void main() {
  vec3 p = position;
  float t = uTime * (0.1 + aSeed.x * 0.16);
  p.x += sin(t * 2.1 + aSeed.y * 40.0) * 2.6 + sin(t * 4.3 + aSeed.z * 20.0) * 0.8;
  p.y += sin(t * 1.7 + aSeed.z * 30.0) * 0.9;
  p.z += cos(t * 1.9 + aSeed.x * 50.0) * 2.4;
  // They find the pointer and orbit it, softly.
  vec3 d = uMouse - p;
  float dist = length(d);
  float pull = exp(-dist * 0.13) * uStrength;
  float ang = uTime * (0.4 + aSeed.y) + aSeed.z * 6.28;
  vec3 orbit = uMouse + vec3(cos(ang), sin(ang * 0.7) * 0.5, sin(ang)) * (1.2 + aSeed.x * 3.2);
  p = mix(p, orbit, smoothstep(0.08, 0.9, pull));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float cycle = fract(uTime * (0.14 + aSeed.y * 0.2) + aSeed.z);
  float flash = cycle < 0.1 ? cycle / 0.1 : cycle < 0.46 ? 1.0 - (cycle - 0.1) / 0.36 : 0.0;
  float lit = max(flash, pull * 1.1);
  gl_PointSize = (10.0 + lit * 34.0 + aSeed.x * 6.0) * uPixel * 12.0 / -mv.z;
  vA = 0.04 + lit;
  vC = mix(vec3(0.76, 1.0, 0.36), vec3(0.28, 1.0, 0.82), step(0.5, aSeed.y));
}`;
const FIREFLY_FS = /* glsl */ `
varying float vA;
varying vec3 vC;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 4.5) + exp(-d * d * 42.0) * 1.8;
  gl_FragColor = vec4(vC * a * vA, 1.0);
}`;

function paint(g: THREE.BufferGeometry, r: number, gg: number, b: number, varyBy = 0) {
  const pos = g.getAttribute('position');
  const c = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = varyBy ? 1 + (Math.sin(pos.getY(i) * 3.1 + pos.getX(i) * 7.3) * varyBy) : 1;
    c[i * 3] = r * v;
    c[i * 3 + 1] = gg * v;
    c[i * 3 + 2] = b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
}

/** A forest tree: a tapering trunk with buttress roots, branches, and a few hanging vines. */
function buildTree(parts: THREE.BufferGeometry[], x: number, z: number, height: number, tone: number) {
  const trunk = (from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number) => {
    const dir = to.clone().sub(from);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(r1, r0, len, 7, 1);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    g.translate(from.x, from.y, from.z);
    paint(g, 0.012 * tone, 0.035 * tone, 0.04 * tone);
    parts.push(g);
  };
  const grow = (from: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
    const bend = new THREE.Vector3(rand(-0.3, 0.3), rand(-0.05, 0.2), rand(-0.3, 0.3));
    const to = from.clone().addScaledVector(dir, len).add(bend.multiplyScalar(len * 0.6));
    trunk(from, to, r, r * 0.68);
    if (depth >= 5) return;
    const next = to.clone().sub(from).normalize();
    const kids = depth < 1 ? 1 : 2;
    for (let i = 0; i < kids; i++) {
      const spread = depth < 1 ? 0.14 : 0.62;
      const d = next.clone().add(new THREE.Vector3(rand(-spread, spread), rand(-spread * 0.4, spread * 0.4), rand(-spread, spread))).normalize();
      if (d.y < 0.1) d.y = 0.1 + Math.random() * 0.2;
      grow(to, d.normalize(), len * rand(0.68, 0.84), r * 0.68, depth + 1);
    }
  };
  const base = new THREE.Vector3(x, -0.6, z);
  for (let i = 0; i < 4; i++) {
    const a = rand(0, 6.28);
    trunk(new THREE.Vector3(x + Math.cos(a) * height * 0.11, -0.6, z + Math.sin(a) * height * 0.11), base.clone().setY(height * 0.11), height * 0.018, height * 0.03);
  }
  grow(base, new THREE.Vector3(rand(-0.06, 0.06), 1, rand(-0.06, 0.06)).normalize(), height * 0.34, height * 0.04, 0);
}

const factory: WorldFactory = (env) => {
  const renderer = makeRenderer(env);
  renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x052a2e, 0.034);
  const camera = new THREE.PerspectiveCamera(48, env.width / env.height, 0.1, 200);
  camera.position.set(0, 2.4, 22);

  const time = { value: 0 };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(140, 24, 16), new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: { uTime: time }, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false }));
  scene.add(sky);
  scene.add(new THREE.HemisphereLight(0x44d8c6, 0x031014, 1.2));
  const cool = new THREE.DirectionalLight(0x6cf0dc, 0.9);
  cool.position.set(2, 8, -20);
  scene.add(cool);

  // Ground: rolling moss, with a glowing stream winding through it.
  const groundGeo = new THREE.PlaneGeometry(120, 120, 120, 120);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.getAttribute('position');
  const height = (x: number, z: number) => Math.sin(x * 0.14) * 0.46 + Math.cos(z * 0.11 + x * 0.05) * 0.5 + Math.sin(x * 0.4 + z * 0.3) * 0.13 - 0.3;
  for (let i = 0; i < gp.count; i++) gp.setY(i, height(gp.getX(i), gp.getZ(i)));
  groundGeo.computeVertexNormals();
  const groundMat = new THREE.ShaderMaterial({
    uniforms: { uTime: time, uMouse: { value: new THREE.Vector3() }, uStrength: { value: 0 }, uRing: { value: new THREE.Vector4(0, 0, 0, 0) } },
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec3 vN; varying float vFog;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vN = normal;
        vec4 mv = viewMatrix * w;
        vFog = 1.0 - exp(-pow(-mv.z * 0.052, 1.6));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec3 vN; varying float vFog;
      uniform float uTime; uniform vec3 uMouse; uniform float uStrength; uniform vec4 uRing;
      ${NOISE_3D}
      void main() {
        vec2 p = vW.xz;
        float moss = fbm3d(vec3(p * 0.5, 2.0));
        float fine = n3(vec3(p * 4.0, 1.0));
        vec3 col = mix(vec3(0.004, 0.02, 0.02), vec3(0.015, 0.09, 0.075), moss) * (0.6 + 0.6 * fine);
        // a stream of light
        float course = p.x - sin(p.y * 0.17) * 6.0 - sin(p.y * 0.41) * 1.8 + 3.0;
        float stream = smoothstep(1.5, 0.0, abs(course));
        float flow = fbm3d(vec3(p.x * 0.8, p.y * 0.24 - uTime * 0.3, uTime * 0.05));
        col = mix(col, vec3(0.08, 0.72, 0.66) * (0.5 + flow * 1.3), stream * 0.86);
        col += vec3(0.08, 0.5, 0.42) * smoothstep(5.0, 0.0, abs(course)) * 0.22;
        // glow spots in the moss
        vec2 g = p * 0.9; vec2 id = floor(g); vec2 f = fract(g) - 0.5;
        float sp = step(0.86, fract(sin(dot(id, vec2(12.9, 78.2))) * 43758.5));
        col += vec3(0.2, 0.9, 0.7) * sp * smoothstep(0.32, 0.0, length(f)) * (0.3 + 0.3 * sin(uTime + id.x));
        float near = exp(-dot(p - uMouse.xz, p - uMouse.xz) * 0.08) * uStrength;
        col += vec3(0.06, 0.42, 0.34) * near;
        if (uRing.w > 0.0) {
          float rd = length(p - uRing.xz);
          col += vec3(0.2, 1.0, 0.8) * exp(-pow((rd - uRing.y) * 0.9, 2.0)) * uRing.w * 0.5;
        }
        col = mix(col, vec3(0.022, 0.17, 0.18), vFog);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  scene.add(ground);

  // Trees: framing the sides at every depth, opening a glade in the middle.
  const treeParts: THREE.BufferGeometry[] = [];
  const treeCount = env.tier === 'high' ? 58 : env.tier === 'balanced' ? 38 : 22;
  for (let i = 0; i < treeCount; i++) {
    const side = i % 2 ? -1 : 1;
    const depth = rand(-54, 15);
    const open = 6.5 + Math.max(0, depth + 30) * 0.2;
    const x = side * (open + Math.pow(Math.random(), 1.4) * 36);
    buildTree(treeParts, x, depth, rand(16, 28), rand(0.8, 1.5));
  }
  const trees = new THREE.Mesh(mergeSimple(treeParts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true }));
  scene.add(trees);

  // Canopy masses and vines close the top of the frame.
  const canopyParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 90; i++) {
    const g = new THREE.IcosahedronGeometry(rand(2, 6.5), 1);
    const side = i % 2 ? -1 : 1;
    g.scale(1.3, 0.6, 1.3);
    g.translate(side * rand(1, 38), rand(11, 19), rand(-56, 16));
    paint(g, 0.002, 0.012, 0.014, 0.4);
    canopyParts.push(g);
  }
  const vineCount = 70;
  for (let i = 0; i < vineCount; i++) {
    const len = rand(3, 9);
    const g = new THREE.CylinderGeometry(0.018, 0.03, len, 3, 1);
    g.translate(0, -len / 2, 0);
    g.translate((i % 2 ? -1 : 1) * rand(4, 30), rand(12, 18), rand(-34, 12));
    paint(g, 0.01, 0.12, 0.1);
    canopyParts.push(g);
  }
  const canopy = new THREE.Mesh(mergeSimple(canopyParts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  scene.add(canopy);

  // Mushrooms: stems and glowing caps, one merged mesh.
  const shroomParts: THREE.BufferGeometry[] = [];
  const shroomColors: [number, number, number][] = [[0.2, 1, 0.82], [0.46, 1, 0.56], [0.2, 0.74, 1], [1, 0.62, 0.3]];
  for (let i = 0; i < 74; i++) {
    const side = i % 2 ? -1 : 1;
    const x = side * rand(2.2, 16);
    const z = rand(-24, 9);
    const y = height(x, z);
    const s = rand(0.16, 0.56);
    const stem = new THREE.CylinderGeometry(s * 0.14, s * 0.2, s * 1.3, 6);
    stem.translate(x, y + s * 0.6, z);
    paint(stem, 0.5, 0.9, 0.8);
    shroomParts.push(stem);
    const cap = new THREE.SphereGeometry(s * 0.72, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
    cap.translate(x, y + s * 1.05, z);
    const col = shroomColors[i % shroomColors.length];
    paint(cap, col[0] * 0.8, col[1] * 0.8, col[2] * 0.8, 0.35);
    shroomParts.push(cap);
  }
  const shrooms = new THREE.Mesh(mergeSimple(shroomParts), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  scene.add(shrooms);

  // Grass: one blade, thousands of instances; every movement happens in the vertex shader.
  const bladeCount = env.tier === 'high' ? 26000 : env.tier === 'balanced' ? 12000 : 4000;
  const blade = new THREE.BufferGeometry();
  const seg = 4;
  const bladePos: number[] = [];
  const bladeIdx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const y = i / seg;
    const w = 0.034 * (1 - y * y);
    bladePos.push(-w, y, 0, w, y, 0);
    if (i < seg) {
      const a = i * 2;
      bladeIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  blade.setAttribute('position', new THREE.Float32BufferAttribute(bladePos, 3));
  blade.setIndex(bladeIdx);
  const grassGeo = new THREE.InstancedBufferGeometry();
  grassGeo.setAttribute('position', blade.getAttribute('position'));
  grassGeo.setIndex(blade.getIndex());
  const offsets = new Float32Array(bladeCount * 3);
  const seeds = new Float32Array(bladeCount);
  for (let i = 0; i < bladeCount; i++) {
    const z = 14 - Math.pow(Math.random(), 0.72) * 52;
    const spread = 8 + (20 - z) * 0.72;
    const x = (Math.random() - 0.5) * spread * 2;
    offsets.set([x, height(x, z) - 0.02, z], i * 3);
    seeds[i] = Math.random();
  }
  grassGeo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  grassGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  grassGeo.instanceCount = bladeCount;
  const grassUniforms = { uTime: time, uMouse: groundMat.uniforms.uMouse, uStrength: groundMat.uniforms.uStrength, uRing: groundMat.uniforms.uRing };
  const grass = new THREE.Mesh(grassGeo, new THREE.ShaderMaterial({ vertexShader: GRASS_VS, fragmentShader: GRASS_FS, uniforms: grassUniforms, side: THREE.DoubleSide }));
  grass.frustumCulled = false;
  scene.add(grass);

  // Fireflies and spores.
  const flyCount = env.tier === 'high' ? 340 : env.tier === 'balanced' ? 200 : 80;
  const flyPos = new Float32Array(flyCount * 3);
  const flySeed = new Float32Array(flyCount * 3);
  for (let i = 0; i < flyCount; i++) {
    flyPos.set([rand(-26, 26), rand(0.4, 7.5), rand(-24, 16)], i * 3);
    flySeed.set([Math.random(), Math.random(), Math.random()], i * 3);
  }
  const flyGeo = new THREE.BufferGeometry();
  flyGeo.setAttribute('position', new THREE.BufferAttribute(flyPos, 3));
  flyGeo.setAttribute('aSeed', new THREE.BufferAttribute(flySeed, 3));
  const flyUniforms = { uTime: time, uMouse: { value: new THREE.Vector3() }, uStrength: groundMat.uniforms.uStrength, uPixel: { value: env.pixelRatio } };
  const flies = new THREE.Points(flyGeo, new THREE.ShaderMaterial({ vertexShader: FIREFLY_VS, fragmentShader: FIREFLY_FS, uniforms: flyUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  flies.frustumCulled = false;
  scene.add(flies);

  const mouse = new THREE.Vector3();
  const mouseAir = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.3);
  let ring = { x: 0, z: 0, r: 0, life: 0 };

  const groundPoint = (u: number, v: number, out: THREE.Vector3) => {
    ndc.set(u * 2 - 1, v * 2 - 1);
    ray.setFromCamera(ndc, camera);
    return ray.ray.intersectPlane(plane, out);
  };

  return {
    frame(t, dt) {
      time.value = t;
      const p = env.pointer;
      flyUniforms.uPixel.value = env.pixelRatio;
      groundMat.uniforms.uStrength.value = p.strength;
      // A slow walk through the glade, with the pointer as a turn of the head.
      const z = 21 + Math.sin(t * 0.03) * 3;
      const tx = (p.su - 0.5) * 2.2 * p.strength + Math.sin(t * 0.05) * 0.7;
      const ty = 2.4 + (p.sv - 0.5) * 0.9 * p.strength + Math.sin(t * 0.09) * 0.12;
      camera.position.x += (tx - camera.position.x) * Math.min(1, dt * 1.4);
      camera.position.y += (ty - camera.position.y) * Math.min(1, dt * 1.4);
      camera.position.z += (z - camera.position.z) * Math.min(1, dt * 1.4);
      camera.lookAt(camera.position.x * 0.3, 3.3, -30);
      camera.updateMatrixWorld();
      if (groundPoint(p.su, Math.min(0.48, p.sv), mouse)) groundMat.uniforms.uMouse.value.copy(mouse);
      pointerOnPlane(env, camera, 6, mouseAir);
      flyUniforms.uMouse.value.copy(mouseAir);
      for (const pulse of p.drainPulses()) {
        if (groundPoint(pulse.u, Math.min(0.46, pulse.v), mouse)) ring = { x: mouse.x, z: mouse.z, r: 0, life: 1 };
      }
      if (ring.life > 0) {
        ring.r += dt * 9;
        ring.life = Math.max(0, ring.life - dt * 0.42);
        groundMat.uniforms.uRing.value.set(ring.x, ring.r, ring.z, ring.life);
      } else {
        groundMat.uniforms.uRing.value.w = 0;
      }
      renderer.render(scene, camera);
    },
    resize() {
      renderer.setSize(env.width, env.height, false);
      camera.aspect = env.width / env.height;
      camera.fov = camera.aspect < 1 ? 70 : 48;
      camera.updateProjectionMatrix();
    },
    dispose() {
      disposeScene(scene);
      blade.dispose();
      renderer.dispose();
    },
    pixels: 0.85,
  };
};

export default factory;
