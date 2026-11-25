import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Skybound world: a causeway above a sea of clouds. The palette travels with the run — dawn meadows, the crystal
 * temple, sunset ruins and, for the final sprint, a starfall night — as a continuous blend (no switch, no pop).
 */
export interface Palette {
  skyTop: THREE.Color; skyHorizon: THREE.Color; skyLow: THREE.Color; fog: THREE.Color; sun: THREE.Color;
  hemiSky: THREE.Color; hemiGround: THREE.Color; cloud: THREE.Color; cloudShade: THREE.Color; grass: THREE.Color; night: number;
  sunElevation: number; sunAzimuth: number;
}
const C = (hex: number) => new THREE.Color(hex);
const STOPS: { at: number; p: Omit<Palette, never> }[] = [
  { at: 0, p: { skyTop: C(0x155b9a), skyHorizon: C(0x8bc8d0), skyLow: C(0x7ab4c8), fog: C(0x96bbc8), sun: C(0xffe7bd), hemiSky: C(0xbedcfa), hemiGround: C(0x739465), cloud: C(0xf1f8fa), cloudShade: C(0x8cacc5), grass: C(0x73ba60), night: 0, sunElevation: .32, sunAzimuth: -.6 } },
  { at: .36, p: { skyTop: C(0x244d9e), skyHorizon: C(0x85ccd5), skyLow: C(0x74b5c5), fog: C(0x8db8ca), sun: C(0xe2f5ff), hemiSky: C(0xb9deed), hemiGround: C(0x5c9e90), cloud: C(0xeef7fc), cloudShade: C(0x8dadd3), grass: C(0x63cfb3), night: 0, sunElevation: .5, sunAzimuth: -.25 } },
  { at: .72, p: { skyTop: C(0x6a4ab8), skyHorizon: C(0xffb36b), skyLow: C(0xffd2a1), fog: C(0xf6c9a6), sun: C(0xffc78a), hemiSky: C(0xffd9b5), hemiGround: C(0xb0805a), cloud: C(0xffe3cf), cloudShade: C(0xc98f9e), grass: C(0xb8c25d), night: .1, sunElevation: .1, sunAzimuth: .35 } },
  { at: 1, p: { skyTop: C(0x101544), skyHorizon: C(0x6f4fc4), skyLow: C(0x2d3478), fog: C(0x3b3f86), sun: C(0xc9d6ff), hemiSky: C(0x8e9cff), hemiGround: C(0x3b3170), cloud: C(0x8b8fd8), cloudShade: C(0x3d3a86), grass: C(0x4f7fa0), night: 1, sunElevation: .55, sunAzimuth: .8 } },
];
export function palette(t: number, out: Palette): Palette {
  const v = Math.max(0, Math.min(1, t));
  let i = 0; while (i < STOPS.length - 2 && v > STOPS[i + 1].at) i++;
  const a = STOPS[i], b = STOPS[i + 1], k = (v - a.at) / (b.at - a.at), e = k * k * (3 - 2 * k);
  for (const key of ['skyTop', 'skyHorizon', 'skyLow', 'fog', 'sun', 'hemiSky', 'hemiGround', 'cloud', 'cloudShade', 'grass'] as const) out[key].copy(a.p[key]).lerp(b.p[key], e);
  out.night = a.p.night + (b.p.night - a.p.night) * e;
  out.sunElevation = a.p.sunElevation + (b.p.sunElevation - a.p.sunElevation) * e;
  out.sunAzimuth = a.p.sunAzimuth + (b.p.sunAzimuth - a.p.sunAzimuth) * e;
  return out;
}
export const createPalette = (): Palette => palette(0, { skyTop: C(0), skyHorizon: C(0), skyLow: C(0), fog: C(0), sun: C(0), hemiSky: C(0), hemiGround: C(0), cloud: C(0), cloudShade: C(0), grass: C(0), night: 0, sunElevation: 0, sunAzimuth: 0 });

const skyVertex = /* glsl */`varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const skyFragment = /* glsl */`
uniform vec3 uTop, uHorizon, uLow, uSun; uniform vec3 uSunDir; uniform float uNight, uTime;
varying vec3 vDir;
float hash(vec3 p){ p = fract(p * .3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), .55)) : mix(uHorizon, uLow, pow(clamp(-h * 3.0, 0.0, 1.0), .6));
  float sd = max(0.0, dot(d, normalize(uSunDir)));
  col += uSun * (pow(sd, 900.0) * 3.0 + pow(sd, 18.0) * .45 + pow(sd, 3.0) * .12) * (1.0 - uNight * .4);
  // Stars and an aurora ribbon only as the night arrives.
  if (uNight > .01 && h > 0.0) {
    vec3 cell = floor(d * 260.0); float s = hash(cell);
    float star = step(.9975, s) * (.6 + .4 * sin(uTime * 3.0 + s * 40.0));
    col += vec3(star) * uNight * smoothstep(0.0, .25, h);
    float band = exp(-pow((h - .32 - .06 * sin(d.x * 3.0 + uTime * .15)) * 9.0, 2.0));
    col += mix(vec3(.2, 1.0, .75), vec3(.6, .4, 1.0), .5 + .5 * sin(d.x * 4.0 + uTime * .2)) * band * .38 * uNight;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const cloudVertex = /* glsl */`varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const cloudFragment = /* glsl */`
uniform vec3 uCloud, uShade, uFog; uniform float uTime; uniform vec3 uCamera;
varying vec3 vWorld;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = .5; for (int i = 0; i < 5; i++){ v += a * noise(p); p = p * 2.03 + 11.7; a *= .5; } return v; }
void main(){
  vec2 p = vWorld.xz * .018 + vec2(uTime * .012, uTime * .02);
  float n = fbm(p) * .65 + fbm(p * 2.7 - uTime * .015) * .35;
  float puff = smoothstep(.32, .78, n);
  vec3 col = mix(uShade, uCloud, puff);
  col += vec3(1.0) * pow(puff, 6.0) * .12;
  float dist = length(vWorld.xz - uCamera.xz);
  float fade = smoothstep(80.0, 300.0, dist);
  gl_FragColor = vec4(mix(col, uFog, fade * .85), 1.0);
}`;

const fallVertex = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * p; }`;
const fallFragment = /* glsl */`
uniform float uTime; varying vec2 vUv;
void main(){
  float streak = fract(vUv.y * 3.0 + uTime * 1.3 + sin(vUv.x * 18.0) * .15);
  float lines = smoothstep(.0, .5, streak) * (1.0 - smoothstep(.5, 1.0, streak));
  float edge = smoothstep(0.0, .25, vUv.x) * smoothstep(1.0, .75, vUv.x);
  float fade = smoothstep(0.0, .35, vUv.y);
  gl_FragColor = vec4(mix(vec3(.75, .93, 1.0), vec3(1.0), lines), (.45 + lines * .4) * edge * fade);
}`;

/** Bake a flat-shaded, vertex-coloured low-poly geometry. */
function colored(g: THREE.BufferGeometry, color: number, jitter = 0, seed = 1) {
  const geometry = g.index ? g.toNonIndexed() : g;
  const count = geometry.attributes.position.count, colors = new Float32Array(count * 3), base = new THREE.Color(color);
  let s = seed;
  for (let i = 0; i < count; i += 3) {
    s = (s * 16807) % 2147483647; const v = 1 + ((s / 2147483647) - .5) * jitter;
    for (let k = 0; k < 3; k++) { colors[(i + k) * 3] = base.r * v; colors[(i + k) * 3 + 1] = base.g * v; colors[(i + k) * 3 + 2] = base.b * v; }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.deleteAttribute('uv');
  geometry.computeVertexNormals();
  return geometry;
}

/** One floating island: rock keel, grass cap, trees, sometimes ruins or crystals. */
function islandGeometry(variant: number) {
  const parts: THREE.BufferGeometry[] = [];
  const rock = new THREE.ConeGeometry(4, 7.5, 7, 3); rock.rotateX(Math.PI); rock.translate(0, -3.9, 0);
  const pos = rock.attributes.position;
  for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); const wobble = Math.sin(i * 12.9898) * .45; pos.setX(i, pos.getX(i) * (1 + wobble * .2)); pos.setZ(i, pos.getZ(i) * (1 - wobble * .15)); pos.setY(i, y + Math.cos(i * 7.1) * .25); }
  parts.push(colored(rock, 0x9a8f86, .35, 11 + variant));
  const soil = new THREE.CylinderGeometry(4.1, 3.9, .8, 7); soil.translate(0, -.35, 0); parts.push(colored(soil, 0x8a6a4a, .2, 3 + variant));
  const grass = new THREE.CylinderGeometry(4.25, 4.1, .35, 7); grass.translate(0, .1, 0); parts.push(colored(grass, variant % 2 ? 0x84d36f : 0x6cc98a, .12, 7 + variant));
  const trees = variant % 3 === 0 ? 4 : variant % 3 === 1 ? 2 : 1;
  for (let t = 0; t < trees; t++) {
    const a = t * 2.4 + variant, r = 1.2 + (t % 2) * 1.5, x = Math.cos(a) * r, z = Math.sin(a) * r, h = 1.6 + (t % 3) * .5;
    const trunk = new THREE.CylinderGeometry(.14, .2, h * .5, 5); trunk.translate(x, .3 + h * .25, z); parts.push(colored(trunk, 0x7a5236, .1, t + 5));
    const crown = variant % 2 ? new THREE.IcosahedronGeometry(h * .45, 0) : new THREE.ConeGeometry(h * .45, h * 1.1, 6);
    crown.translate(x, .3 + h * .5 + h * .35, z); parts.push(colored(crown, variant % 2 ? 0x5fbf6a : 0x3e9e72, .25, t + 9));
  }
  if (variant % 4 === 1) { // ruined arch
    for (const side of [-1, 1]) { const pillar = new THREE.BoxGeometry(.5, 2.4, .5); pillar.translate(side * 1.1, 1.4, -1.6); parts.push(colored(pillar, 0xeadfc8, .15, side + 20)); }
    const lintel = new THREE.BoxGeometry(2.9, .45, .6); lintel.translate(0, 2.8, -1.6); parts.push(colored(lintel, 0xeadfc8, .15, 22));
  }
  if (variant % 4 === 3) { // crystal cluster
    for (let k = 0; k < 3; k++) { const crystal = new THREE.OctahedronGeometry(.45 + k * .15, 0); crystal.scale(1, 2.2, 1); crystal.translate(-1.5 + k * .9, 1.1 + k * .2, 1.4); parts.push(colored(crystal, 0x8fe8ff, .1, k + 30)); }
  }
  const merged = mergeGeometries(parts, false)!;
  parts.forEach(p => p.dispose());
  return merged;
}

function puffTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  for (const [x, y, r] of [[64, 74, 44], [38, 80, 30], [92, 82, 32], [56, 52, 30], [80, 58, 26]]) {
    const grad = g.createRadialGradient(x, y, 2, x, y, r); grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(.6, 'rgba(255,255,255,.75)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

interface Placed { mesh: THREE.InstancedMesh; items: { x: number; y: number; z: number; s: number; r: number; phase: number }[] }

export class SkyEnvironment {
  readonly group = new THREE.Group();
  readonly sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private cloudSea: THREE.Mesh;
  private cloudMat: THREE.ShaderMaterial;
  private islands: Placed[] = [];
  private falls: Placed;
  private fallMat: THREE.ShaderMaterial;
  private puffs: THREE.InstancedMesh;
  private puffItems: { x: number; y: number; z: number; s: number; drift: number }[] = [];
  private puffMat: THREE.MeshBasicMaterial;
  private birds: THREE.InstancedMesh;
  private birdItems: { r: number; a: number; y: number; speed: number; z: number }[] = [];
  private islandMat: THREE.MeshStandardMaterial;
  private disposables: { dispose(): void }[] = [];
  /** Authored (Blender) islands, their waterfalls and the distant academy citadel, once loaded. */
  private authored = false;
  private authoredFalls: { variant: number; mesh: THREE.InstancedMesh }[] = [];
  private citadel: THREE.Mesh | null = null;
  private haze = { value: new THREE.Color() };
  private span = 260;
  private matrix = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();

  constructor(private quality: 'high' | 'medium' | 'low') {
    this.skyMat = new THREE.ShaderMaterial({ vertexShader: skyVertex, fragmentShader: skyFragment, side: THREE.BackSide, depthWrite: false,
      uniforms: { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uLow: { value: new THREE.Color() }, uSun: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, .3, -1) }, uNight: { value: 0 }, uTime: { value: 0 } } });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), this.skyMat);
    this.sky.frustumCulled = false; this.sky.renderOrder = -10;
    this.group.add(this.sky);

    this.cloudMat = new THREE.ShaderMaterial({ vertexShader: cloudVertex, fragmentShader: cloudFragment,
      uniforms: { uCloud: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uFog: { value: new THREE.Color() }, uTime: { value: 0 }, uCamera: { value: new THREE.Vector3() } } });
    this.cloudSea = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2), this.cloudMat);
    this.cloudSea.position.y = -16; this.group.add(this.cloudSea);

    this.islandMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: .9, metalness: 0 });
    const islandCount = quality === 'low' ? 3 : 5;
    for (let variant = 0; variant < 4; variant++) {
      const geometry = islandGeometry(variant);
      const mesh = new THREE.InstancedMesh(geometry, this.islandMat, islandCount);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false;
      const items = Array.from({ length: islandCount }, (_, i) => this.islandSlot(variant * 7 + i, i));
      this.islands.push({ mesh, items }); this.group.add(mesh); this.disposables.push(geometry);
    }
    this.fallMat = new THREE.ShaderMaterial({ vertexShader: fallVertex, fragmentShader: fallFragment, transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: { uTime: { value: 0 } } });
    const fallGeo = new THREE.PlaneGeometry(1.6, 16).translate(0, -8, 0);
    const fallCount = quality === 'low' ? 2 : 5;
    this.falls = { mesh: new THREE.InstancedMesh(fallGeo, this.fallMat, fallCount), items: [] };
    this.falls.mesh.frustumCulled = false; this.group.add(this.falls.mesh); this.disposables.push(fallGeo);

    const puffMap = puffTexture(); this.disposables.push(puffMap);
    this.puffMat = new THREE.MeshBasicMaterial({ map: puffMap, transparent: true, opacity: .72, depthWrite: false, fog: true, color: 0xffffff });
    const puffCount = quality === 'low' ? 18 : quality === 'medium' ? 30 : 44;
    const puffGeo = new THREE.PlaneGeometry(1, .62); this.disposables.push(puffGeo);
    this.puffs = new THREE.InstancedMesh(puffGeo, this.puffMat, puffCount); this.puffs.frustumCulled = false;
    for (let i = 0; i < puffCount; i++) this.puffItems.push(this.puffSlot(i));
    this.group.add(this.puffs);

    const birdGeo = new THREE.BufferGeometry();
    birdGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, -.2, -.6, .12, .15, 0, .02, .1, 0, 0, -.2, .6, .12, .15, 0, .02, .1]), 3));
    birdGeo.computeVertexNormals(); this.disposables.push(birdGeo);
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x2d3550, side: THREE.DoubleSide, fog: true });
    this.disposables.push(birdMat);
    const birdCount = quality === 'low' ? 6 : 14;
    this.birds = new THREE.InstancedMesh(birdGeo, birdMat, birdCount); this.birds.frustumCulled = false;
    for (let i = 0; i < birdCount; i++) this.birdItems.push({ r: 14 + (i % 5) * 4, a: i * .9, y: 5 + (i % 4) * 1.6, speed: .18 + (i % 3) * .05, z: -30 - i * 9 });
    this.group.add(this.birds);
    this.disposables.push(this.skyMat, this.cloudMat, this.fallMat, this.puffMat, this.islandMat, this.sky.geometry, this.cloudSea.geometry);
  }

  private islandSlot(seed: number, index: number) {
    const side = seed % 2 ? 1 : -1, rand = (n: number) => { const x = Math.sin(seed * 91.7 + n * 13.1) * 43758.5; return x - Math.floor(x); };
    return { x: side * (16 + rand(1) * 44), y: -7 + rand(2) * 11, z: -index * (this.span / 5) - rand(3) * 40, s: .7 + rand(4) * 1.3, r: rand(5) * Math.PI * 2, phase: rand(6) * 10 };
  }
  private puffSlot(seed: number) {
    const rand = (n: number) => { const x = Math.sin(seed * 51.3 + n * 7.7) * 43758.5; return x - Math.floor(x); };
    const side = rand(1) > .5 ? 1 : -1;
    return { x: side * (40 + rand(2) * 80), y: -24 + rand(3) * 10, z: -rand(4) * this.span, s: 10 + rand(5) * 18, drift: .2 + rand(6) * .4 };
  }

  /** Swap the procedural islands for the Blender-authored set (same slots, same recycling). */
  setArt(world: GLTF | null) {
    if (!world || this.authored) return;
    const meshes: Record<string, THREE.Mesh> = {};
    world.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes[o.name] = o as THREE.Mesh; });
    if (!meshes.island_0) return;
    this.authored = true;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .88, metalness: 0 });
    this.disposables.push(mat);
    this.islands.forEach((placed, v) => {
      const source = meshes[`island_${v}`]; if (!source) return;
      const mesh = new THREE.InstancedMesh(source.geometry, mat, placed.items.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.receiveShadow = false;
      this.group.remove(placed.mesh); placed.mesh.dispose(); placed.mesh = mesh; this.group.add(mesh);
      const falls = meshes[`falls_${v}`];
      if (falls) { const f = new THREE.InstancedMesh(falls.geometry, this.fallMat, placed.items.length); f.frustumCulled = false; this.authoredFalls.push({ variant: v, mesh: f }); this.group.add(f); }
    });
    this.falls.mesh.visible = false;
    if (meshes.citadel) {
      // The academy on the horizon: drawn without fog, blended toward the sky so it reads as far away.
      const far = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9, fog: false });
      far.onBeforeCompile = shader => {
        shader.uniforms.uHaze = this.haze;
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uHaze;')
          .replace('#include <dithering_fragment>', 'gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, .5);\n#include <dithering_fragment>');
      };
      far.customProgramCacheKey = () => 'sky-citadel';
      this.citadel = new THREE.Mesh(meshes.citadel.geometry, far); this.citadel.frustumCulled = false; this.group.add(this.citadel); this.disposables.push(far);
    }
  }

  update(camera: THREE.PerspectiveCamera, p: Palette, time: number, reduced: boolean, sunDir: THREE.Vector3) {
    const camZ = camera.position.z;
    this.sky.position.copy(camera.position);
    const u = this.skyMat.uniforms;
    u.uTop.value.copy(p.skyTop); u.uHorizon.value.copy(p.skyHorizon); u.uLow.value.copy(p.skyLow); u.uSun.value.copy(p.sun);
    u.uSunDir.value.copy(sunDir); u.uNight.value = p.night; u.uTime.value = time;
    this.cloudSea.position.set(camera.position.x, -16, camZ - 120);
    const c = this.cloudMat.uniforms; c.uCloud.value.copy(p.cloud); c.uShade.value.copy(p.cloudShade); c.uFog.value.copy(p.fog); c.uTime.value = reduced ? 0 : time; c.uCamera.value.copy(camera.position);
    this.fallMat.uniforms.uTime.value = reduced ? 0 : time;

    // Islands recycle into the window ahead of the camera; they drift a little (bob) like moored ships.
    let fallIndex = 0;
    for (const [variant, placed] of this.islands.entries()) {
      placed.items.forEach((it, i) => {
        while (it.z > camZ + 40) it.z -= this.span;
        while (it.z < camZ - this.span + 40) it.z += this.span;
        const bob = reduced ? 0 : Math.sin(time * .35 + it.phase) * .6;
        this.v.set(it.x, it.y + bob, it.z); this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, it.r + (reduced ? 0 : time * .01)); this.sc.setScalar(this.authored ? it.s * .78 : it.s);
        this.matrix.compose(this.v, this.q, this.sc); placed.mesh.setMatrixAt(i, this.matrix);
        for (const f of this.authoredFalls) if (f.variant === variant) f.mesh.setMatrixAt(i, this.matrix);
        if (!this.authored && (variant === 0 || variant === 2) && fallIndex < this.falls.mesh.count) {
          this.v.set(it.x + Math.cos(it.r) * 3.6 * it.s, it.y + bob, it.z - Math.sin(it.r) * 3.6 * it.s);
          this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(camera.position.x - it.x, camera.position.z - it.z));
          this.sc.set(it.s, it.s, it.s); this.matrix.compose(this.v, this.q, this.sc); this.falls.mesh.setMatrixAt(fallIndex++, this.matrix);
        }
      });
      placed.mesh.instanceMatrix.needsUpdate = true;
    }
    for (const f of this.authoredFalls) f.mesh.instanceMatrix.needsUpdate = true;
    if (this.citadel) {
      this.haze.value.copy(p.skyHorizon).lerp(p.fog, .4);
      this.citadel.position.set(camera.position.x * .2 + 70, -26, camZ - 330); this.citadel.rotation.y = .6;
    }
    this.falls.mesh.count = fallIndex; this.falls.mesh.instanceMatrix.needsUpdate = true;

    this.puffMat.color.copy(p.cloud);
    this.puffItems.forEach((it, i) => {
      if (!reduced) it.x += it.drift * .01 * Math.sign(it.x);
      while (it.z > camZ + 30) it.z -= this.span;
      while (it.z < camZ - this.span + 30) it.z += this.span;
      this.v.set(it.x, it.y, it.z); this.q.copy(camera.quaternion); this.sc.set(it.s, it.s, 1);
      this.matrix.compose(this.v, this.q, this.sc); this.puffs.setMatrixAt(i, this.matrix);
    });
    this.puffs.instanceMatrix.needsUpdate = true;

    this.birdItems.forEach((b, i) => {
      const a = b.a + (reduced ? 0 : time * b.speed), flap = reduced ? .2 : Math.sin(time * 9 + i) * .55;
      while (b.z > camZ + 10) b.z -= 160;
      this.v.set(Math.cos(a) * b.r, b.y + Math.sin(a * 2) * .6, b.z + Math.sin(a) * b.r * .4);
      this.q.setFromEuler(new THREE.Euler(0, -a + Math.PI / 2, 0)); this.sc.set(1 + flap * .2, 1 - Math.abs(flap) * .5, 1);
      this.matrix.compose(this.v, this.q, this.sc); this.birds.setMatrixAt(i, this.matrix);
    });
    this.birds.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    for (const placed of this.islands) placed.mesh.dispose();
    this.falls.mesh.dispose(); this.puffs.dispose(); this.birds.dispose();
  }
}
