import * as T from 'three';
import { GrimeField } from '@/lib/study-space/grime';
import { chainMaterialShader, patchMaterialWithEchoCsm } from './echoLife/echoCsm';

/**
 * How what lies on a surface looks: the same small grid the rules work on, sent to the GPU only when it changed, with the fine edge made in the shader. A floor is
 * its own material with dust, stains and water worked into its colour and its roughness, so wet boards really shine and dust really dulls them. A desk top or a pane of
 * glass gets a thin film on top. One texture upload per changed surface, nothing per frame.
 */
const NOISE = /* glsl */ `
float grH(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float grN(vec2 p){ vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f); return mix(mix(grH(i),grH(i+vec2(1,0)),u.x),mix(grH(i+vec2(0,1)),grH(i+vec2(1,1)),u.x),u.y); }
float grF(vec2 p){ return grN(p)*.5+grN(p*2.03+7.1)*.3+grN(p*4.1+3.3)*.2; }
`;

const WET_UPLOAD_MIN_INTERVAL_MS = 50; // <= 20 Hz GPU upload cadence when ONLY wetness changes

export class GrimeTexture {
  readonly texture: T.DataTexture;
  private data: Uint8Array;
  private rev = -1;
  private solidRev = -1;
  private lastUploadMs = -1e9;
  constructor(readonly field: GrimeField) {
    this.data = new Uint8Array(field.nx * field.nz * 4);
    this.texture = new T.DataTexture(this.data, field.nx, field.nz, T.RGBAFormat, T.UnsignedByteType);
    this.texture.magFilter = T.LinearFilter; this.texture.minFilter = T.LinearFilter; this.texture.generateMipmaps = false;
    this.texture.wrapS = this.texture.wrapT = T.ClampToEdgeWrapping;
    this.refresh(0, true);
  }
  /** Sends the grid to the GPU immediately on dust/stain edits and at <= 20 Hz on wetness-only streams/drying. */
  refresh(nowMs = typeof performance !== 'undefined' ? performance.now() : 0, force = false) {
    const f = this.field;
    if (f.rev === this.rev) return false;
    const solidChanged = f.solidRev !== this.solidRev;
    if (!force && !solidChanged && this.rev >= 0 && nowMs - this.lastUploadMs < WET_UPLOAD_MIN_INTERVAL_MS) {
      return false;
    }
    this.rev = f.rev;
    this.solidRev = f.solidRev;
    this.lastUploadMs = nowMs;
    const n = f.dust.length, d = this.data;
    for (let i = 0; i < n; i++) {
      const dust = f.dust[i];
      d[i * 4] = Math.min(255, dust * 255);
      d[i * 4 + 1] = Math.min(255, f.stain[i] * 255);
      d[i * 4 + 2] = Math.min(255, f.wet[i] * 255);
      d[i * 4 + 3] = Math.min(255, Math.max(0, dust - 1) / 5 * 255);
    }
    this.texture.needsUpdate = true;
    return true;
  }
  dispose() { this.texture.dispose(); }
}

export interface FloorGrime { material: T.MeshStandardMaterial; sense: { value: number }; dispose: () => void }
/** The floor's own material, changed to read the grid. `size` is the room's width in metres. */
export function floorGrime(base: T.MeshStandardMaterial, tex: GrimeTexture, size: number): FloorGrime {
  const material = base.clone(), sense = { value: 0 };
  // Guard against `Material.copy()` JSON-cloning a `Set` into a plain `{}` when `base` already carries shader tags.
  if (material.userData.__ecShaderTags && !(material.userData.__ecShaderTags instanceof Set)) {
    const srcTags = base.userData.__ecShaderTags;
    material.userData.__ecShaderTags = srcTags instanceof Set ? new Set(srcTags) : new Set<string>();
  }
  chainMaterialShader(material, 'floor-grime-1', (s) => {
    s.uniforms.uGrime = { value: tex.texture }; s.uniforms.uGrimeSize = { value: size }; s.uniforms.uSense = sense;
    s.vertexShader = 'varying vec2 vGrimeUv; uniform float uGrimeSize;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vGrimeUv = position.xz / uGrimeSize + .5;');
    s.fragmentShader = `varying vec2 vGrimeUv; uniform sampler2D uGrime; uniform float uGrimeSize; uniform float uSense;\n${NOISE}\n` + s.fragmentShader
      .replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
        vec4 grS = texture2D(uGrime, vGrimeUv);
        vec2 grP = vGrimeUv * uGrimeSize;
        float grF1 = grF(grP * 5.), grF2 = grN(grP * 58.), grF3 = grN(grP * 170.);
        // Dust: a dull grey film, thicker in patches, with a grain you can see from standing height.
        float grDust = clamp(grS.r * 1.3 * (1.05 + (grF1 - .5) * .75) * (.72 + .55 * grF2) + grS.a * .9, 0., 1.);
        grDust *= smoothstep(.02, .09, grS.r + (grF3 - .5) * .05);
        // Grey against whatever is under it: duller than a pale floor, lighter than a dark one.
        float grLum = dot(diffuseColor.rgb, vec3(.3, .59, .11));
        vec3 grTone = vec3(1., .965, .9) * max(grLum * .66, .3) * (.8 + .4 * grF3);
        diffuseColor.rgb = mix(diffuseColor.rgb, grTone, grDust * .92);
        // A stain: darker, its edge eaten by the grain of the boards.
        float grStain = smoothstep(.05, .34, grS.g + (grF1 - .5) * .22);
        diffuseColor.rgb *= mix(vec3(1.), vec3(.5, .41, .33), grStain * min(1., grS.g * 1.6 + .25));
        // Water: the boards go dark and the surface goes to glass.
        float grWet = smoothstep(.05, .2, grS.b + (grF1 - .5) * .17 + (grF2 - .5) * .03);
        diffuseColor.rgb *= mix(1., .6, grWet);`)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, .97, grDust * .85);
        roughnessFactor = mix(roughnessFactor, .055 + (1. - grS.b) * .1, grWet);`)
      .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
        // What wet boards show: the bright window and ceiling, more the flatter they are seen.
        if (grWet > .002) { vec3 grV = normalize(vViewPosition); float grFr = pow(1. - clamp(dot(normal, grV), 0., 1.), 2.6); float grEdge = grWet * (1. - grWet) * 4.; totalEmissiveRadiance += vec3(.74, .82, .95) * (.022 + grFr * .46 + grEdge * .035) * grWet; }
        if (uSense > .001) { float grLeft = clamp(max(max(smoothstep(.07, .24, grS.r), smoothstep(.04, .2, grS.g)), smoothstep(.1, .3, grS.b) * .7), 0., 1.); totalEmissiveRadiance += vec3(1., .64, .16) * grLeft * uSense * (.3 + .5 * grF1); }`);
  });
  patchMaterialWithEchoCsm(material);
  return { material, sense, dispose: () => material.dispose() };
}

/** A thin film on a desk top, a shelf board or a window pane, reading its own grid. One program for all of them. */
export function filmMaterial(tex: GrimeTexture, sense: { value: number }, metres: [number, number]) {
  const m = new T.MeshStandardMaterial({ transparent: true, depthWrite: false, roughness: .96, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: T.DoubleSide });
  chainMaterialShader(m, 'film-grime-2', (s) => {
    s.uniforms.uGrime = { value: tex.texture }; s.uniforms.uSense = sense; s.uniforms.uMetres = { value: new T.Vector2(...metres) };
    s.vertexShader = 'varying vec2 vGrimeUv;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vGrimeUv = vec2(uv.x, 1. - uv.y);');
    s.fragmentShader = `varying vec2 vGrimeUv; uniform sampler2D uGrime; uniform float uSense; uniform vec2 uMetres;\n${NOISE}\n` + s.fragmentShader
      .replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
        vec4 grS = texture2D(uGrime, vGrimeUv);
        vec2 grP = vGrimeUv * uMetres;
        float grF1 = grF(grP * 9.), grF3 = grN(grP * 190.);
        float grDust = clamp(grS.r * (1.05 + (grF1 - .5) * .6) * (.78 + .44 * grF3), 0., 1.) * smoothstep(.015, .07, grS.r);
        float grStain = smoothstep(.05, .3, grS.g + (grF1 - .5) * .2) * min(1., grS.g * 1.4 + .2);
        float grWet = smoothstep(.07, .26, grS.b + (grF1 - .5) * .22 + (grF(grP * 37.) - .5) * .08);
        diffuseColor.rgb = mix(vec3(.72, .7, .65) * (.88 + .24 * grF3), vec3(.2, .15, .11), grStain * (1. - grDust * .5));
        diffuseColor.a = clamp(max(grDust * .78, grStain * .62), 0., .9);
        if (grWet > .01) { diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.04, .05, .06), grWet * .7); diffuseColor.a = max(diffuseColor.a, grWet * (.12 + .1 * smoothstep(.3, .8, grS.b))); }`)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, .06, grWet);`)
      .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
        if (uSense > .001) { float grLeft = clamp(max(smoothstep(.05, .2, grS.r), smoothstep(.04, .2, grS.g)), 0., 1.); totalEmissiveRadiance += vec3(1., .64, .16) * grLeft * uSense * .55; diffuseColor.a = max(diffuseColor.a, grLeft * uSense * .5); }`);
  });
  patchMaterialWithEchoCsm(m);
  return m;
}

let webTexture: T.CanvasTexture | null = null;
/** A web, drawn thread by thread: the spokes from its anchor, the spiral laid across them, every thread a little slack. */
export function cobwebTexture() {
  if (webTexture) return webTexture;
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 512, 512); g.lineCap = 'round';
  let seed = 11; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cx = 256, cy = 34, spokes = 19;
  // Old web is not a drawing of a web: a grey mat where it started, sagging threads from there, broken rings, what it has caught. It has to read on a pale wall and on a dark one.
  const mat = g.createRadialGradient(cx, cy, 6, cx, cy, 300);
  mat.addColorStop(0, 'rgba(112,110,112,.42)'); mat.addColorStop(.34, 'rgba(118,116,118,.15)'); mat.addColorStop(1, 'rgba(120,118,120,0)');
  g.fillStyle = mat; g.fillRect(0, 0, 512, 512);
  const spoke = Array.from({ length: spokes }, (_, i) => ({ a: Math.PI * (.05 + .9 * (i + (r() - .5) * .55) / (spokes - 1)), l: 250 + r() * 215, sag: (r() - .5) * 26 }));
  const point = (s: { a: number; l: number; sag: number }, k: number) => { const side = Math.sin(k * Math.PI) * s.sag; return [cx + Math.cos(s.a) * s.l * k - Math.sin(s.a) * side, cy + Math.sin(s.a) * s.l * k + Math.cos(s.a) * side + 18 * k * k]; };
  for (const s of spoke) {
    g.strokeStyle = `rgba(96,95,100,${.5 + r() * .3})`; g.lineWidth = 1.2 + r() * .9;
    g.beginPath(); for (let t = 0; t <= 10; t++) { const [x, y] = point(s, t / 10); if (!t) g.moveTo(x, y); else g.lineTo(x, y); } g.stroke();
  }
  for (let ring = 1; ring < 17; ring++) {
    const k = Math.pow(ring / 17, .85) + r() * .02;
    for (let i = 1; i < spokes; i++) {
      // Torn in places, and more so towards the outside.
      if (r() < .12 + k * .34) continue;
      const a = spoke[i - 1], b = spoke[i];
      if (a.l * k > a.l || k > .97) continue;
      const [x1, y1] = point(a, k), [x2, y2] = point(b, k), sag = 5 + 18 * k;
      g.strokeStyle = `rgba(92,91,96,${.28 + r() * .42})`; g.lineWidth = .8 + r() * .8;
      g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo((x1 + x2) / 2, (y1 + y2) / 2 + sag, x2, y2); g.stroke();
    }
  }
  // Loose strands that hang, and the dust they have caught.
  for (let i = 0; i < 46; i++) {
    const s = spoke[Math.floor(r() * spokes)], k = .25 + r() * .75, [x, y] = point(s, k), drop = 16 + r() * 70;
    g.strokeStyle = `rgba(96,95,100,${.16 + r() * .36})`; g.lineWidth = .7 + r() * .7;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + (r() - .5) * 26, y + drop * .6, x + (r() - .5) * 34, y + drop); g.stroke();
  }
  for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(104,101,97,${r() * .55})`; const s = spoke[Math.floor(r() * spokes)], [x, y] = point(s, r()); g.fillRect(x + (r() - .5) * 18, y + (r() - .5) * 18, .8 + r() * 1.8, .8 + r() * 1.8); }
  webTexture = new T.CanvasTexture(c); webTexture.colorSpace = T.SRGBColorSpace; webTexture.anisotropy = 4;
  return webTexture;
}
export function forgetCobwebTexture() { webTexture?.dispose(); webTexture = null; }

/** Small things in flight: dust from a broom, drops off a mop, a puff from a shelf. One pool, one draw, nothing when there is nothing in the air. */
export class Puffs {
  readonly points: T.Points;
  private pos: Float32Array; private col: Float32Array; private vel: Float32Array; private life: Float32Array; private size: Float32Array;
  private next = 0; private live = 0; private active = false;
  constructor(private cap = 140) {
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 4); this.vel = new Float32Array(cap * 3); this.life = new Float32Array(cap); this.size = new Float32Array(cap);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(this.pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aColor', new T.BufferAttribute(this.col, 4).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aSize', new T.BufferAttribute(this.size, 1).setUsage(T.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const m = new T.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uScale: { value: 1 } },
      vertexShader: `attribute vec4 aColor; attribute float aSize; varying vec4 vC; uniform float uScale; void main(){ vC=aColor; vec4 mv=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mv; gl_PointSize=aSize*uScale/max(.08,-mv.z); }`,
      fragmentShader: `varying vec4 vC;\nvoid main(){ float r=length(gl_PointCoord-.5)*2.; if(r>1.) discard; gl_FragColor=vec4(vC.rgb, vC.a*(1.-r*r));\n#include <colorspace_fragment>\n}`,
    });
    m.customProgramCacheKey = () => 'ec-grime-puffs-v1';
    this.points = new T.Points(g, m);
    // Keep `visible = true` with `drawRange(0, 0)` when idle so Stage-6 scene warmup compiles the shader upfront.
    this.points.frustumCulled = false; this.points.visible = true; this.points.renderOrder = 6;
    this.points.userData.skipMirrorPass = true;
    this.points.raycast = () => undefined;
  }
  emit(x: number, y: number, z: number, count: number, kind: 'dust' | 'drop' | 'fleck' | 'steam', vx = 0, vz = 0) {
    for (let n = 0; n < count; n++) {
      const i = this.next; this.next = (this.next + 1) % this.cap;
      const r = () => Math.random() - .5;
      const heavy = kind !== 'dust' && kind !== 'steam';
      this.pos[i * 3] = x + r() * .05; this.pos[i * 3 + 1] = y + Math.random() * .03; this.pos[i * 3 + 2] = z + r() * .05;
      this.vel[i * 3] = vx * .35 + r() * (heavy ? .4 : .24); this.vel[i * 3 + 1] = heavy ? .25 + Math.random() * .5 : .03 + Math.random() * .22; this.vel[i * 3 + 2] = vz * .35 + r() * (heavy ? .4 : .24);
      this.life[i] = heavy ? .45 + Math.random() * .25 : .9 + Math.random() * 1.1;
      if (kind === 'steam') { this.vel[i * 3] = r() * .05; this.vel[i * 3 + 1] = .2 + Math.random() * .12; this.vel[i * 3 + 2] = r() * .05; this.pos[i * 3] = x + r() * .012; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z + r() * .012; }
      this.size[i] = kind === 'dust' || kind === 'steam' ? 9 + Math.random() * 15 : kind === 'drop' ? 1.1 + Math.random() * 1.2 : 2 + Math.random() * 2;
      const c = kind === 'dust' ? [.78, .75, .7, .1] : kind === 'steam' ? [.96, .97, 1, .13] : kind === 'drop' ? [.72, .82, .9, .85] : [.5, .44, .36, .9];
      this.col.set(c, i * 4);
      if (heavy) this.col[i * 4 + 3] = c[3];
    }
    this.live = Math.max(this.live, count);
    this.active = true;
    this.points.geometry.setDrawRange(0, this.cap);
  }
  update(dt: number, pixels: number) {
    if (!this.active) return;
    let any = 0;
    (this.points.material as T.ShaderMaterial).uniforms.uScale.value = pixels;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) { this.size[i] = 0; continue; }
      any++;
      this.life[i] -= dt;
      const heavy = this.size[i] < 8;
      if (heavy) this.vel[i * 3 + 1] -= 3.6 * dt; else { this.vel[i * 3 + 1] *= 1 - .5 * dt; this.size[i] += dt * 5; this.col[i * 4 + 3] = Math.max(0, this.col[i * 4 + 3] - dt * .06); }
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < .004) this.life[i] = 0;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true; g.attributes.aColor.needsUpdate = true; g.attributes.aSize.needsUpdate = true;
    if (!any) {
      this.active = false;
      g.setDrawRange(0, 0);
    }
  }
  dispose() { this.points.geometry.dispose(); (this.points.material as T.Material).dispose(); }
}

let grimeWarmupRig: {
  scene: T.Scene;
  tex: GrimeTexture;
  geom: T.PlaneGeometry;
  film: T.MeshStandardMaterial;
  baseFloor: T.MeshStandardMaterial;
  floor: FloorGrime;
} | null = null;

/**
 * Compiles and pins `filmMaterial` (`film-grime-2`) and `floorGrime` (`floor-grime-1`) in Three.js's
 * `WebGLPrograms` cache (`program.usedTimes >= 1`) during Stage-6 pre-entry warmup so the first droplet
 * splashing onto a clean desk never triggers a mid-stream shader compilation stall (`programDelta === 0`).
 */
export function prewarmGrimeMaterials(
  renderer: T.WebGLRenderer,
  camera: T.Camera,
  target?: T.WebGLRenderTarget | null,
  referenceScene?: T.Scene | null,
): void {
  if (!grimeWarmupRig) {
    const scene = new T.Scene();
    const tex = new GrimeTexture(new GrimeField(2, 2, 1, 1));
    const sense = { value: 0 };
    const geom = new T.PlaneGeometry(0.01, 0.01);
    const film = filmMaterial(tex, sense, [1, 1]);
    const baseFloor = new T.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    const floor = floorGrime(baseFloor, tex, 6);
    const filmMesh = new T.Mesh(geom, film);
    const floorMesh = new T.Mesh(geom, floor.material);
    filmMesh.frustumCulled = false;
    floorMesh.frustumCulled = false;
    filmMesh.receiveShadow = true;
    floorMesh.receiveShadow = true;
    filmMesh.position.set(0, -1000, 0);
    floorMesh.position.set(0, -1000, 0);
    scene.add(filmMesh, floorMesh);
    grimeWarmupRig = { scene, tex, geom, film, baseFloor, floor };
  }

  const rig = grimeWarmupRig;
  if (referenceScene) {
    rig.scene.environment = referenceScene.environment;
    rig.scene.fog = referenceScene.fog;
  }

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevShadowAuto = renderer.shadowMap.autoUpdate;
  const prevScissorTest = renderer.getScissorTest();
  const prevViewport = new T.Vector4();
  const prevScissor = new T.Vector4();
  renderer.getViewport(prevViewport);
  renderer.getScissor(prevScissor);

  const dst = target !== undefined ? target : prevTarget;
  const savedRtScissor = dst ? dst.scissor.clone() : null;
  const savedRtScissorTest = dst ? dst.scissorTest : false;

  try {
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    if (dst) {
      dst.scissor.set(0, 0, 1, 1);
      dst.scissorTest = true;
      renderer.setRenderTarget(dst);
    } else {
      renderer.setRenderTarget(null);
      renderer.setScissor(0, 0, 1, 1);
      renderer.setScissorTest(true);
    }
    renderer.compile(rig.scene, camera);
    renderer.render(rig.scene, camera);
  } finally {
    if (dst && savedRtScissor) {
      dst.scissor.copy(savedRtScissor);
      dst.scissorTest = savedRtScissorTest;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.setViewport(prevViewport);
    renderer.setScissor(prevScissor);
    renderer.setScissorTest(prevScissorTest);
  }
}

export function disposePrewarmedGrimeMaterials(): void {
  if (!grimeWarmupRig) return;
  grimeWarmupRig.geom.dispose();
  grimeWarmupRig.film.dispose();
  grimeWarmupRig.floor.dispose();
  grimeWarmupRig.baseFloor.dispose();
  grimeWarmupRig.tex.dispose();
  grimeWarmupRig = null;
}
