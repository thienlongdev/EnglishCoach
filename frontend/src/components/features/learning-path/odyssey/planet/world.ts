/* Echo Living Planet — scene assembly. Turns a PlanetBuild into GPU objects and keeps the per-frame work small:
   clustered instancing with level of detail and far-side culling, shader-driven motion, a handful of matrix updates.
   Everything a graphics tier changes is a runtime knob (setTier): instance counts, clouds, particles, shader detail,
   shadow map — so switching tiers that share a build never rebuilds or recompiles the world.
   One sun, fixed in the world: the land, the sea, the sky, the clouds, the moon's phase and the shadows all agree
   with it. A flight to a region brings its morning (anchorSun); free rotation shows the real night side, the
   terminator and the sun rising over the limb. */
import * as THREE from 'three';
import type { PlanetBuild, PropKind } from '@/lib/odyssey/planet/build';
import { PROP_KINDS, THINNED, GROUND_COVER } from '@/lib/odyssey/planet/build';
import { propGeometry, boatGeometry } from '@/lib/odyssey/planet/props';
import { seeded } from '@/lib/odyssey/planet/noise';
import type { RouteState, LearningRoute } from '@/lib/odyssey/progression';
import type { TierSpec } from '@/lib/odyssey/graphics';
import { terrainMaterial, propMaterial, landmarkMaterial, oceanMaterial, atmosphereMaterial, moonMaterial, shared } from './materials';

export type RegionKind = 'next' | 'here' | 'review' | 'done' | 'challenge' | 'evidence' | 'open';
export type PinState = 'done' | 'review' | 'locked' | 'next' | 'open' | 'workflow';

const TREES = new Set<PropKind>(['broad', 'conifer', 'palm', 'cypress', 'acacia', 'willow', 'snowpine', 'birch', 'bush', 'tuft', 'flower']);
const ROCKS = new Set<PropKind>(['peak', 'crag', 'stack', 'boulder']);
export const KIND_COLOR: Record<RegionKind, string> = { next: '#ffd463', here: '#6ff0ff', review: '#ffae4a', done: '#6ee7b7', challenge: '#b9a3ff', evidence: '#9ef2d3', open: '#f2fbff' };
const PIN_COLOR: Record<PinState, string> = { done: '#5fe0a8', review: '#ffae4a', locked: '#a99be6', next: '#ffd463', open: '#f4fbff', workflow: '#8ad8ff' };
const ROUTE_STATES: RouteState[] = ['recommended', 'completed', 'available', 'locked', 'review'];
const MAX = { clouds: 60, smoke: 110, embers: 170 }, PUFFS = 4;
const MOON_DIR = new THREE.Vector3(0.62, 0.36, -0.7).normalize();
const GALAXY = new THREE.Vector3(0.3, 0.86, 0.41).normalize();

function geometryFrom(a: Record<string, ArrayLike<number> | undefined>, attrs: [string, number][], index: Uint32Array) {
  const g = new THREE.BufferGeometry();
  for (const [name, size] of attrs) {
    const arr = a[name]; if (!arr) continue;
    g.setAttribute(name, arr instanceof Uint8Array ? new THREE.BufferAttribute(arr, size, true) : new THREE.BufferAttribute(arr as Float32Array, size));
  }
  g.setIndex(new THREE.BufferAttribute(index, 1)); g.computeBoundingSphere(); return g;
}

function glowTexture(inner: string, outer: string, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d')!, h = size / 2, g = x.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, inner); g.addColorStop(0.25, outer); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
/** A soft, billowy puff for smoke and clouds (several offset discs: no two particles look the same once rotated). */
function puffTexture(seed = 5, lobes = 9) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d')!, rand = seeded(seed);
  for (let i = 0; i < lobes; i++) {
    const cx = 64 + (rand() - 0.5) * 50, cy = 64 + (rand() - 0.5) * 50, r = 22 + rand() * 26, g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

interface ClusterMesh { center: THREE.Vector3; hi: THREE.InstancedMesh; lo: THREE.InstancedMesh | null; total: number; kind: PropKind }

export class PlanetWorld {
  readonly root = new THREE.Group();
  readonly R: number;
  readonly build: PlanetBuild;
  private disposables: { dispose(): void }[] = [];
  private clusters: ClusterMesh[] = [];
  private boats: THREE.InstancedMesh | null = null;
  private blades: THREE.InstancedMesh | null = null;
  private smoke: THREE.Points | null = null;
  private embers: THREE.Points | null = null;
  private clouds: THREE.Mesh | null = null;
  private cloudMat: THREE.ShaderMaterial | null = null;
  private routes: THREE.Mesh | null = null;
  private routeMat: THREE.ShaderMaterial;
  private beacons = new Map<string, { group: THREE.Group; core: THREE.Mesh; halo: THREE.Sprite; beam: THREE.Mesh; kind: RegionKind }>();
  private pins: THREE.InstancedMesh; private rings: THREE.InstancedMesh; private pinBeam: THREE.Mesh;
  pinIds: string[] = [];
  private pinSel = -1;
  readonly sun = new THREE.DirectionalLight('#fff0d8', 3.1);
  readonly moonLight = new THREE.DirectionalLight('#9db8ff', 0.16);
  private glare: THREE.Sprite; private ghosts: THREE.Sprite[] = [];
  private stars: THREE.Points;
  private sky: THREE.Mesh;
  private moon: THREE.Mesh;
  private lights: THREE.Points | null = null;
  readonly siteIndex = new Map<string, number>();
  private tier: TierSpec | null = null;
  private tmp = new THREE.Matrix4();
  // One sun, fixed in the world; anchorSun eases it to a region's morning.
  readonly sunDir = new THREE.Vector3(-0.5, 0.6, 0.6).normalize();
  private sunFrom = new THREE.Vector3(); private sunTo = new THREE.Vector3(); private sunT = 1; private sunDur = 1;
  /** 0..1: how much of the sun is visible right now (planet occlusion), for the page's own checks. */
  sunVisible = 0;
  // Throttled shadows (REA Claybound: the shadow map is redrawn only when the light or the place changes).
  private shadowAt = new THREE.Vector3(1e9, 0, 0); private shadowSun = new THREE.Vector3(); private shadowWait = 0;
  shadowDirty = false;
  // Ocean inertia and the volcano's life.
  private drift = new THREE.Vector3(); private driftV = new THREE.Vector3();
  private eruptAt = 0; private eruptRand = seeded(404); private eruption = -1; private lastEruption = -1e9; private visitingVolcano = false;
  private smokeMat: THREE.ShaderMaterial | null = null; private emberMat: THREE.ShaderMaterial | null = null;
  private lightMat: THREE.ShaderMaterial | null = null;

  constructor(build: PlanetBuild, opts: { phone?: boolean } = {}) {
    this.build = build; this.R = build.radius;
    this.eruptAt = shared.uTime.value + 40 + this.eruptRand() * 30;
    shared.uRadius.value = this.R;
    build.sites.forEach((s, i) => this.siteIndex.set(s.id, i));
    const own = <T extends { dispose(): void }>(x: T) => { this.disposables.push(x); return x; };

    // Terrain, ocean, landmarks.
    const t = build.terrain;
    const terrain = new THREE.Mesh(own(geometryFrom({ position: t.position, normal: t.normal, color: t.color, surface: t.surface }, [['position', 3], ['normal', 3], ['color', 3], ['surface', 4]], t.index)), own(terrainMaterial()));
    terrain.name = 'terrain';
    const oceanMat = own(oceanMaterial());
    oceanMat.uniforms.uMoonDir.value.copy(MOON_DIR);
    const ocean = new THREE.Mesh(own(geometryFrom({ position: build.ocean.position, depth: build.ocean.depth }, [['position', 3], ['depth', 1]], build.ocean.index)), oceanMat);
    ocean.renderOrder = 2; ocean.name = 'ocean';
    const l = build.landmarks;
    const landmarks = new THREE.Mesh(own(geometryFrom({ position: l.position, normal: l.normal, color: l.color, aGlow: l.glow }, [['position', 3], ['normal', 3], ['color', 3], ['aGlow', 1]], l.index)), own(landmarkMaterial()));
    landmarks.name = 'landmarks';
    this.root.add(terrain, ocean, landmarks);
    const innerAtmo = new THREE.Mesh(own(new THREE.SphereGeometry(this.R * 1.012, 96, 48)), own(atmosphereMaterial(true)));
    const outerAtmo = new THREE.Mesh(own(new THREE.SphereGeometry(this.R * 1.15, 96, 48)), own(atmosphereMaterial(false)));
    innerAtmo.renderOrder = 3; outerAtmo.renderOrder = -1;
    this.root.add(innerAtmo, outerAtmo);

    // Props: one instanced mesh per (kind, cluster), hi and lo detail sharing instance data; ground cover only hi.
    const treeMat = own(propMaterial({ wind: 1 })), rockMat = own(propMaterial({ wind: 0, detail: true, rough: 0.95 })), houseMat = own(propMaterial({ wind: 0, rough: 0.78, smooth: true }));
    for (const kind of PROP_KINDS) {
      const mat = TREES.has(kind) ? treeMat : ROCKS.has(kind) ? rockMat : houseMat;
      for (const c of build.props[kind] ?? []) {
        const matrices = new THREE.InstancedBufferAttribute(c.matrices, 16), colors = new THREE.InstancedBufferAttribute(c.colors, 3);
        const make = (hi: boolean) => {
          const m = new THREE.InstancedMesh(propGeometry(kind, hi), mat, c.count);
          m.instanceMatrix = matrices; m.instanceColor = colors; m.computeBoundingSphere(); m.matrixAutoUpdate = false; m.userData.prop = kind; return m;
        };
        const hi = make(true), lo = GROUND_COVER.has(kind) ? null : make(false); hi.visible = false;
        this.root.add(hi); if (lo) this.root.add(lo);
        this.clusters.push({ center: new THREE.Vector3(...c.center).multiplyScalar(this.R), hi, lo, total: c.count, kind });
      }
    }
    // Boats.
    if (!opts.phone && build.boats.length) {
      this.boats = new THREE.InstancedMesh(own(boatGeometry()), houseMat, build.boats.length);
      const sails = ['#ffffff', '#ffe9c2', '#ffd1d1', '#d9f0ff'];
      build.boats.forEach((_, i) => this.boats!.setColorAt(i, new THREE.Color(sails[i % sails.length])));
      this.boats.frustumCulled = false; this.root.add(this.boats);
    }
    // Windmill sails.
    const mills = build.sites.flatMap(s => s.mills);
    if (mills.length) {
      const g = new THREE.BufferGeometry();
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) { const b = new THREE.BoxGeometry(0.22, 1, 0.03).translate(0, 0.55, 0); b.rotateZ(i * Math.PI / 2); parts.push(b); }
      const pos: number[] = [], nor: number[] = [], idx: number[] = []; let base = 0;
      for (const p of parts) { const pa = p.getAttribute('position'), na = p.getAttribute('normal'), ia = p.getIndex()!; for (let i = 0; i < pa.count; i++) { pos.push(pa.getX(i), pa.getY(i), pa.getZ(i)); nor.push(na.getX(i), na.getY(i), na.getZ(i)); } for (let i = 0; i < ia.count; i++) idx.push(base + ia.getX(i)); base += pa.count; p.dispose(); }
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setIndex(idx);
      this.blades = new THREE.InstancedMesh(own(g), own(new THREE.MeshStandardMaterial({ color: '#efe3cc', roughness: 0.9 })), mills.length);
      this.blades.frustumCulled = false; this.root.add(this.blades);
    }
    // The volcano: a smoke column (steam and ash), embers and lava bombs of an eruption, a glow on the land around.
    if (build.smoke) {
      const origin = new THREE.Vector3(...build.smoke); shared.uLavaPos.value.copy(origin).addScaledVector(origin.clone().normalize(), 1.2);
      const n = MAX.smoke, geo = new THREE.BufferGeometry(), seeds = new Float32Array(n);
      for (let i = 0; i < n; i++) seeds[i] = (i * 0.618034) % 1;
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
      const tex = own(puffTexture());
      this.smokeMat = own(new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uTime: shared.uTime, uMap: { value: tex }, uOrigin: { value: origin }, uErupt: { value: 0 }, uSunDir: shared.uSunDir, uScale: { value: 1 } },
        vertexShader: `attribute float seed; uniform float uTime; uniform vec3 uOrigin; uniform float uErupt; uniform float uScale; uniform vec3 uSunDir; varying float vA; varying float vAsh; varying float vLit; varying float vRot;
          void main(){ float t = fract(seed + uTime * (0.04 + uErupt * 0.05)); vec3 up = normalize(uOrigin); vec3 side = normalize(cross(up, vec3(0.0,1.0,0.0))); vec3 fw = cross(up, side);
            float rise = t * (26.0 + uErupt * 22.0);
            vec3 p = uOrigin + up * rise + side * (sin(seed * 40.0) * (1.0 + t * 6.0) + t * t * 16.0) + fw * cos(seed * 31.0) * (1.0 + t * 4.0 + uErupt * 3.0);
            vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
            gl_PointSize = uScale * (7.0 + t * (32.0 + uErupt * 26.0)) * 300.0 / -mv.z;
            vA = (1.0 - t) * smoothstep(0.0, 0.08, t); vAsh = clamp(uErupt * 1.4 * (1.0 - t) + (1.0 - t) * 0.25, 0.0, 1.0);
            vLit = clamp(dot(up, uSunDir) * 0.8 + 0.4, 0.15, 1.0); vRot = seed * 6.28; }`,
        fragmentShader: `uniform sampler2D uMap; varying float vA; varying float vAsh; varying float vLit; varying float vRot;
          void main(){ vec2 c = gl_PointCoord - 0.5; float s = sin(vRot), k = cos(vRot); c = vec2(c.x * k - c.y * s, c.x * s + c.y * k) + 0.5;
            vec4 t = texture2D(uMap, c); vec3 col = mix(vec3(0.93, 0.92, 0.9), vec3(0.28, 0.25, 0.24), vAsh) * vLit;
            gl_FragColor = vec4(col, t.a * vA * 0.95); }` }));
      this.smoke = new THREE.Points(own(geo), this.smokeMat); this.smoke.frustumCulled = false; this.smoke.renderOrder = 4; this.root.add(this.smoke);
      // Embers: a slow upward drift of sparks, and ballistic lava bombs while an eruption lasts.
      const m = MAX.embers, eg = new THREE.BufferGeometry(), es = new Float32Array(m * 2);
      for (let i = 0; i < m; i++) { es[i * 2] = (i * 0.754877) % 1; es[i * 2 + 1] = (i * 0.569840) % 1; }
      eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m * 3), 3)); eg.setAttribute('seed', new THREE.BufferAttribute(es, 2));
      this.emberMat = own(new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uTime: shared.uTime, uOrigin: { value: origin }, uErupt: { value: 0 }, uEruptT: { value: -1 }, uScale: { value: 1 } },
        vertexShader: `attribute vec2 seed; uniform float uTime; uniform vec3 uOrigin; uniform float uErupt; uniform float uEruptT; uniform float uScale; varying float vA; varying float vHot;
          void main(){ vec3 up = normalize(uOrigin); vec3 side = normalize(cross(up, vec3(0.0,1.0,0.0))); vec3 fw = cross(up, side);
            float a = seed.y * 6.2831853; vec3 dir = side * cos(a) + fw * sin(a);
            vec3 p; float alpha;
            if (uEruptT >= 0.0 && seed.x < 0.7) {
              // Ballistic bomb: launched within the first two seconds, arcs out and falls back on the slopes.
              float tt = uEruptT - seed.x * 2.4; float v = 11.0 + seed.y * 9.0, h = 3.0 + fract(seed.x * 7.0) * 7.0;
              p = uOrigin + up * (v * tt - 4.9 * tt * tt * 0.9) + dir * h * tt; alpha = step(0.0, tt) * (1.0 - smoothstep(2.6, 3.4, tt));
              vHot = 1.0;
            } else {
              float t = fract(seed.x + uTime * 0.06); p = uOrigin + up * (t * 16.0) + dir * (t * 3.0 + sin(uTime + seed.y * 30.0) * 0.6);
              alpha = (1.0 - t) * smoothstep(0.0, 0.1, t) * 0.75; vHot = 1.0 - t;
            }
            vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
            gl_PointSize = uScale * (vHot > 0.99 ? 3.6 : 2.2) * 300.0 / -mv.z; vA = alpha; }`,
        fragmentShader: `varying float vA; varying float vHot; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d) * vA;
          gl_FragColor = vec4(mix(vec3(1.0, 0.32, 0.05), vec3(1.0, 0.85, 0.45), vHot * smoothstep(0.3, 0.0, d)) * a * 1.6, a); }` }));
      this.embers = new THREE.Points(own(eg), this.emberMat); this.embers.frustumCulled = false; this.embers.renderOrder = 5; this.root.add(this.embers);
    }
    // Aurora curtains over the polar observatory.
    const aurora = build.sites.find(s => s.id === 'aurora');
    if (aurora) {
      const mat = own(new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { uTime: shared.uTime, uDay: shared.uDay, uSunDir: shared.uSunDir },
        vertexShader: `varying vec2 vUv; varying float vNight; uniform vec3 uSunDir; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vNight = smoothstep(0.3, -0.25, dot(normalize(w.xyz), uSunDir)); gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `uniform float uTime; uniform float uDay; varying vec2 vUv; varying float vNight; void main(){ float w = sin(vUv.x * 18.0 + uTime * 0.7) * 0.5 + 0.5; float band = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.35, 1.0, vUv.y));
          float ray = 0.55 + 0.45 * sin(vUv.x * 70.0 - uTime * 1.3 + sin(vUv.x * 9.0) * 3.0);
          vec3 c = mix(vec3(0.15, 1.0, 0.6), vec3(0.55, 0.35, 1.0), vUv.y * 0.9 + w * 0.2); gl_FragColor = vec4(c * band * ray * (0.16 + 0.32 * vNight) * (1.0 - uDay * 0.6), 1.0); }` }));
      const up = new THREE.Vector3(...aurora.up), e = new THREE.Vector3(...aurora.east), n = new THREE.Vector3(...aurora.north);
      for (let k = 0; k < 3; k++) {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 40; i++) { const a = (i / 40 - 0.5) * 1.6 + k * 0.3; const d = up.clone().multiplyScalar(Math.cos(0.17)).addScaledVector(e, Math.sin(a) * 0.17).addScaledVector(n, Math.cos(a) * 0.17 * (0.7 + k * 0.25)).normalize(); pts.push(d.multiplyScalar(this.R + 14 + k * 3)); }
        const pos: number[] = [], uv: number[] = [], idx: number[] = [];
        pts.forEach((p, i) => { const r = p.clone().normalize(); pos.push(p.x, p.y, p.z, p.x + r.x * 16, p.y + r.y * 16, p.z + r.z * 16); uv.push(i / 40, 0, i / 40, 1); if (i < 40) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2); });
        const g = own(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
        const curtain = new THREE.Mesh(g, mat); curtain.renderOrder = 5; this.root.add(curtain);
      }
    }
    // Clouds: weather systems of soft puffs that always face the camera (never a flat shard seen edge-on at the limb),
    // lit by the one sun, dim and thin on the night side, gone in close views.
    if (!opts.phone) {
      const rand = seeded(77), n = MAX.clouds;
      const systems = Array.from({ length: 9 }, () => { const y = rand() * 1.6 - 0.8, a = rand() * Math.PI * 2, r = Math.sqrt(1 - y * y); return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r); });
      const plane = own(new THREE.PlaneGeometry(1, 1)), g = own(new THREE.InstancedBufferGeometry());
      g.index = plane.index; g.setAttribute('position', plane.getAttribute('position')); g.setAttribute('uv', plane.getAttribute('uv'));
      const offset = new Float32Array(n * PUFFS * 3), size = new Float32Array(n * PUFFS * 2), seed = new Float32Array(n * PUFFS);
      for (let i = 0; i < n; i++) {
        const sys = systems[i % systems.length];
        const d = sys.clone().add(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.42)).normalize();
        const east = new THREE.Vector3().crossVectors(Math.abs(d.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0), d).normalize(), north = new THREE.Vector3().crossVectors(d, east);
        const s0 = 2.4 + rand() * 3.2, alt = this.R + 8 + rand() * 2.5;
        for (let k = 0; k < PUFFS; k++) {
          const j = i * PUFFS + k, a = rand() * Math.PI * 2, r = k === 0 ? 0 : s0 * (0.35 + rand() * 0.4);
          const p = d.clone().multiplyScalar(alt + (k === 0 ? 0.4 : 0)).addScaledVector(east, Math.cos(a) * r).addScaledVector(north, Math.sin(a) * r);
          offset[j * 3] = p.x; offset[j * 3 + 1] = p.y; offset[j * 3 + 2] = p.z;
          const w = s0 * (k === 0 ? 1.35 : 0.8 + rand() * 0.4); size[j * 2] = w; size[j * 2 + 1] = w * (0.62 + rand() * 0.18); seed[j] = rand();
        }
      }
      g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offset, 3)); g.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 2)); g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
      g.instanceCount = n * PUFFS;
      this.cloudMat = own(new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
        uniforms: { uMap: { value: own(puffTexture(23, 11)) }, uSunDir: shared.uSunDir, uSpin: { value: 0 }, uFade: { value: 1 } },
        vertexShader: `attribute vec3 aOffset; attribute vec2 aSize; attribute float aSeed; uniform vec3 uSunDir; uniform float uSpin; varying vec2 vUv; varying float vDay; varying float vTw; varying float vSeed; varying vec2 vSun;
          void main(){ float c = cos(uSpin), s = sin(uSpin); vec3 o = vec3(c * aOffset.x + s * aOffset.z, aOffset.y, -s * aOffset.x + c * aOffset.z);
            vec4 mv = viewMatrix * vec4(o, 1.0); mv.xy += position.xy * aSize; gl_Position = projectionMatrix * mv;
            float sd = dot(normalize(o), uSunDir); vDay = smoothstep(-0.2, 0.25, sd); vTw = exp(-sd * sd * 26.0) * smoothstep(-0.32, 0.02, sd);
            vec3 sv = mat3(viewMatrix) * uSunDir; vSun = normalize(sv.xy + vec2(1e-4)); vUv = uv; vSeed = aSeed; }`,
        fragmentShader: `uniform sampler2D uMap; uniform float uFade; varying vec2 vUv; varying float vDay; varying float vTw; varying float vSeed; varying vec2 vSun;
          void main(){ vec2 q = vUv - 0.5; float a = vSeed * 6.2831853, cs = cos(a), sn = sin(a); vec4 t = texture2D(uMap, vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs) + 0.5);
            float lit = clamp(0.62 + 0.55 * dot(q * 2.0, vSun), 0.0, 1.0);
            vec3 col = mix(vec3(0.58, 0.63, 0.72), vec3(1.0, 0.99, 0.97), lit) * mix(0.16, 1.0, vDay) + vec3(0.9, 0.45, 0.2) * vTw * 0.35;
            gl_FragColor = vec4(col, t.a * uFade * mix(0.3, 0.92, vDay)); }` }));
      this.clouds = new THREE.Mesh(g, this.cloudMat); this.clouds.frustumCulled = false; this.clouds.renderOrder = 4; this.root.add(this.clouds);
    }
    // Night lights: every landmark lantern and window glows warmer as its place turns away from the sun.
    const lightPos = build.sites.flatMap(s => s.lights);
    if (lightPos.length) {
      const g = own(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.Float32BufferAttribute(lightPos.flat(), 3));
      this.lightMat = own(new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uSunDir: shared.uSunDir, uTime: shared.uTime, uMap: { value: own(glowTexture('rgba(255,230,170,1)', 'rgba(255,170,70,0.45)', 64)) }, uScale: { value: 1 } },
        vertexShader: `uniform vec3 uSunDir; uniform float uTime; uniform float uScale; varying float vA; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          float night = smoothstep(0.22, -0.18, dot(normalize(position), uSunDir)); vA = 0.12 + 0.88 * night; vA *= 0.85 + 0.15 * sin(uTime * 3.0 + position.x * 7.0);
          gl_PointSize = uScale * (1.4 + night * 2.6) * 300.0 / -mv.z; }`,
        fragmentShader: `uniform sampler2D uMap; varying float vA; void main(){ vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(t.rgb * t.a * vA, t.a * vA); }` }));
      this.lights = new THREE.Points(g, this.lightMat); this.lights.frustumCulled = false; this.lights.renderOrder = 6; this.root.add(this.lights);
    }
    // Space: a gradient dome with the sun's disc and corona, a faint galaxy band, stars, the glare and the moon.
    // Space far away, a day sky near the ground: the dome blends by uDay around the camera's own up.
    this.sky = new THREE.Mesh(own(new THREE.SphereGeometry(1450, 48, 24)), own(new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false,
      uniforms: { uDay: shared.uDay, uUp: { value: new THREE.Vector3(0, 1, 0) }, uSunDir: shared.uSunDir, uDetail: shared.uDetail, uGalaxy: { value: GALAXY } },
      vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uDay; uniform vec3 uUp; uniform vec3 uSunDir; uniform float uDetail; uniform vec3 uGalaxy; varying vec3 vD;
        float sh(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float sn(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(sh(i), sh(i + vec3(1,0,0)), f.x), mix(sh(i + vec3(0,1,0)), sh(i + vec3(1,1,0)), f.x), f.y), mix(mix(sh(i + vec3(0,0,1)), sh(i + vec3(1,0,1)), f.x), mix(sh(i + vec3(0,1,1)), sh(i + vec3(1,1,1)), f.x), f.y), f.z); }
        void main(){
          vec3 d = normalize(vD);
          float t = d.y * 0.5 + 0.5; vec3 space = mix(vec3(0.006, 0.01, 0.026), vec3(0.018, 0.03, 0.068), t);
          // The galaxy band and a little nebula colour inside it.
          float gb = dot(d, uGalaxy); float band = exp(-gb * gb * 22.0);
          float cloud = sn(d * 5.0) * 0.6 + sn(d * 11.0) * 0.4; if (uDetail > 1.5) cloud = cloud * 0.8 + sn(d * 23.0) * 0.2;
          space += vec3(0.42, 0.48, 0.72) * band * (0.025 + 0.06 * cloud);
          space += mix(vec3(0.35, 0.12, 0.42), vec3(0.08, 0.3, 0.45), sn(d * 2.3 + 4.0)) * smoothstep(0.55, 0.85, cloud) * band * 0.05;
          // The sun: a white-hot disc, a corona and a wide warm glow.
          float sd = dot(d, uSunDir);
          float disc = smoothstep(0.99962, 0.99978, sd);
          vec3 sun = vec3(1.0, 0.97, 0.9) * disc * 9.0 + vec3(1.0, 0.82, 0.55) * (pow(max(sd, 0.0), 1400.0) * 2.4 + pow(max(sd, 0.0), 160.0) * 0.55 + pow(max(sd, 0.0), 14.0) * 0.07);
          space += sun;
          float h = dot(d, uUp); vec3 day = mix(vec3(0.74, 0.86, 0.95), vec3(0.28, 0.56, 0.9), smoothstep(0.0, 0.55, h));
          day = mix(day, vec3(0.62, 0.76, 0.9), smoothstep(0.05, -0.25, h));
          day += vec3(1.0, 0.86, 0.62) * pow(max(sd, 0.0), 12.0) * 0.35 + vec3(1.0, 0.97, 0.9) * disc * 4.0;
          vec3 c = mix(space, day, uDay); gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }` })));
    this.sky.renderOrder = -10; this.sky.frustumCulled = false;
    const starRand = seeded(11), starCount = 3200, sp = new Float32Array(starCount * 3), ss = new Float32Array(starCount), sc = new Float32Array(starCount * 3);
    const tint = [new THREE.Color('#cfe0ff'), new THREE.Color('#ffffff'), new THREE.Color('#fff2d6'), new THREE.Color('#ffd2a8')];
    for (let i = 0; i < starCount; i++) {
      // A little denser along the galaxy band.
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 3; k++) { const yy = starRand() * 2 - 1, a = starRand() * Math.PI * 2, r = Math.sqrt(1 - yy * yy); x = Math.cos(a) * r; y = yy; z = Math.sin(a) * r; if (Math.abs(x * GALAXY.x + y * GALAXY.y + z * GALAXY.z) < 0.25 || starRand() < 0.45) break; }
      sp[i * 3] = x * 1250; sp[i * 3 + 1] = y * 1250; sp[i * 3 + 2] = z * 1250; ss[i] = Math.pow(starRand(), 6) * 3.4 + 0.6;
      const c = tint[Math.floor(starRand() * tint.length)]; sc[i * 3] = c.r; sc[i * 3 + 1] = c.g; sc[i * 3 + 2] = c.b;
    }
    const sg = own(new THREE.BufferGeometry()); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('size', new THREE.BufferAttribute(ss, 1)); sg.setAttribute('tint', new THREE.BufferAttribute(sc, 3));
    this.stars = new THREE.Points(sg, own(new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uTime: shared.uTime, uPx: { value: 1 }, uDay: shared.uDay },
      vertexShader: `attribute float size; attribute vec3 tint; uniform float uTime; uniform float uPx; varying float vB; varying vec3 vTint; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vB = 0.6 + 0.4 * sin(uTime * (0.6 + size) + position.x); vTint = tint; gl_PointSize = size * uPx; }`,
      fragmentShader: `uniform float uDay; varying float vB; varying vec3 vTint; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d) * (1.0 - uDay); gl_FragColor = vec4(vTint * vB, a * vB); }` })));
    this.stars.frustumCulled = false; this.stars.renderOrder = -9;
    const glareTex = own(glowTexture('rgba(255,244,222,1)', 'rgba(255,190,110,0.32)'));
    this.glare = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: glareTex, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, opacity: 0 })));
    this.glare.renderOrder = 20;
    const ghostTex = own(glowTexture('rgba(150,200,255,0.5)', 'rgba(120,170,255,0.18)', 64));
    for (let i = 0; i < 3; i++) { const g = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: ghostTex, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, opacity: 0, color: ['#9fd0ff', '#ffd59a', '#c5a8ff'][i] }))); g.renderOrder = 20; this.ghosts.push(g); }
    this.moon = new THREE.Mesh(own(new THREE.IcosahedronGeometry(13, 6)), own(moonMaterial()));
    this.moon.position.copy(MOON_DIR).multiplyScalar(820);
    this.moonLight.position.copy(MOON_DIR).multiplyScalar(400);
    this.root.add(this.sky, this.stars, this.glare, ...this.ghosts, this.moon, this.sun, this.sun.target, this.moonLight, this.moonLight.target, new THREE.AmbientLight('#b8c8e0', 0.05));

    // Learning layer: routes, beacons, pins.
    this.routeMat = own(new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uTime: shared.uTime, uFade: { value: 1 },
      uColors: { value: ROUTE_STATES.map(s => new THREE.Color(s === 'recommended' ? '#ffd463' : s === 'completed' ? '#6ee7b7' : s === 'review' ? '#ffae4a' : s === 'locked' ? '#b9a3ff' : '#e9fbff')) } },
      vertexShader: `attribute float aT; attribute float aState; attribute float aKind; varying float vT; varying float vS; varying float vK; void main(){ vT = aT; vS = aState; vK = aKind; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime; uniform float uFade; uniform vec3 uColors[5]; varying float vT; varying float vS; varying float vK;
        void main(){ int s = int(vS + 0.5); vec3 c = uColors[0]; if (s == 1) c = uColors[1]; else if (s == 2) c = uColors[2]; else if (s == 3) c = uColors[3]; else if (s == 4) c = uColors[4];
          float speed = s == 0 ? 0.55 : 0.18; float dash = smoothstep(0.35, 0.5, fract(vT * (vK > 0.5 ? 9.0 : 14.0) - uTime * speed));
          float a = (s == 0 ? 0.95 : s == 3 ? 0.4 : 0.65) * (vK > 0.5 ? 1.0 : 0.35) * mix(1.0, dash, vK > 0.5 ? 0.85 : 0.45) * smoothstep(0.0, 0.06, vT) * smoothstep(1.0, 0.94, vT);
          gl_FragColor = vec4(c * (s == 0 ? 1.6 : 1.1), a * uFade); }` }));
    const pinGeo = own(new THREE.IcosahedronGeometry(0.4, 3)), ringGeo = own(new THREE.RingGeometry(0.56, 0.68, 40).rotateX(-Math.PI / 2));
    this.pins = new THREE.InstancedMesh(pinGeo, own(this.pearlMaterial()), 72);
    this.rings = new THREE.InstancedMesh(ringGeo, own(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide })), 72);
    // Colour buffers exist from the start, so the pearl shader always compiles with its per-instance colour.
    this.pins.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(72 * 3).fill(1), 3);
    this.rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(72 * 3).fill(1), 3);
    this.pins.count = 0; this.rings.count = 0; this.pins.frustumCulled = this.rings.frustumCulled = false; this.rings.renderOrder = 6;
    this.pinBeam = new THREE.Mesh(own(new THREE.CylinderGeometry(0.16, 0.5, 9, 16, 1, true).translate(0, 4.5, 0)), own(this.beamMaterial('#ffe7a3')));
    this.pinBeam.visible = false; this.pinBeam.renderOrder = 7;
    this.root.add(this.pins, this.rings, this.pinBeam);
    const halo = own(glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0.3)'));
    for (const s of build.sites) {
      const group = new THREE.Group(); group.position.set(...s.beacon);
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...s.up));
      const core = new THREE.Mesh(own(new THREE.OctahedronGeometry(0.9, 0).scale(0.75, 1.25, 0.75)), new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.9, roughness: 0.15, metalness: 0.2 }));
      this.disposables.push(core.material as THREE.Material);
      const hs = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6 }));
      this.disposables.push(hs.material);
      hs.scale.setScalar(5.5);
      const beam = new THREE.Mesh(own(new THREE.CylinderGeometry(0.12, 0.55, 18, 18, 1, true).translate(0, 9, 0)), own(this.beamMaterial('#ffc94a')));
      beam.visible = false; beam.renderOrder = 7;
      group.add(core, hs, beam); this.root.add(group);
      this.beacons.set(s.id, { group, core, halo: hs, beam, kind: 'open' });
    }
  }

  /** Apply a graphics tier: what is drawn, how detailed the shaders are, the shadow map. No rebuild, no new program
      (except the one-time recompile when shadows are switched on or off). */
  setTier(spec: TierSpec) {
    const before = this.tier; this.tier = spec;
    shared.uDetail.value = spec.detail;
    for (const c of this.clusters) {
      const fraction = THINNED.has(c.kind) ? spec.trees : GROUND_COVER.has(c.kind) ? spec.grass : 1;
      const n = Math.min(c.total, Math.ceil(c.total * fraction));
      c.hi.count = n; if (c.lo) c.lo.count = n;
    }
    if (this.clouds) (this.clouds.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.min(MAX.clouds, spec.clouds) * PUFFS;
    if (this.smoke) this.smoke.geometry.setDrawRange(0, Math.min(MAX.smoke, spec.smoke));
    if (this.embers) { this.embers.geometry.setDrawRange(0, Math.min(MAX.embers, spec.embers)); this.embers.visible = spec.embers > 0; }
    this.ghosts.forEach(g => { g.visible = spec.detail >= 2; });
    const shadows = spec.shadows > 0;
    if (shadows) {
      const s = this.sun.shadow;
      if (!before || before.shadows !== spec.shadows) { s.map?.dispose(); s.map = null; s.mapSize.set(spec.shadows, spec.shadows); }
      s.bias = -0.0004; s.normalBias = 0.06; s.radius = 3;
      const ext = spec.shadows >= 4096 ? 86 : spec.shadows >= 2048 ? 64 : 50;
      const cam = s.camera as THREE.OrthographicCamera; cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext; cam.near = 20; cam.far = 340; cam.updateProjectionMatrix();
      if (!this.sun.castShadow) {
        this.sun.castShadow = true;
        this.root.traverse(o => {
          if (!(o instanceof THREE.Mesh)) return;
          if (o.name === 'terrain' || o.name === 'landmarks') { o.receiveShadow = true; o.castShadow = true; }
          else if (o instanceof THREE.InstancedMesh && o.userData.prop) { const k = o.userData.prop as PropKind; o.castShadow = !GROUND_COVER.has(k); o.receiveShadow = k === 'house' || k === 'tallhouse' || GROUND_COVER.has(k); }
        });
      }
    } else if (this.sun.castShadow) {
      this.sun.castShadow = false; this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
    }
    this.shadowDirty = true; this.shadowWait = 3;
  }

  /** Bring the morning to a place: the sun eases to the front-left of the view over `seconds` (0 = at once).
      elevation: low for the whole-planet view (a visible terminator), higher over the ground (readable shade). */
  anchorSun(focus: THREE.Vector3, heading: number, elevationDeg: number, seconds: number) {
    const up = focus.clone().normalize(), east = new THREE.Vector3().crossVectors(Math.abs(up.y) > 0.999 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0), up).normalize();
    const north = new THREE.Vector3().crossVectors(up, east), fwd = north.multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading)).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize(), el = THREE.MathUtils.degToRad(elevationDeg);
    const horizontal = right.multiplyScalar(-0.86).addScaledVector(fwd, 0.5).normalize();
    const target = up.multiplyScalar(Math.sin(el)).addScaledVector(horizontal, Math.cos(el)).normalize();
    if (seconds <= 0) { this.sunDir.copy(target); this.sunT = 1; this.shadowDirty = true; return; }
    this.sunFrom.copy(this.sunDir); this.sunTo.copy(target); this.sunT = 0; this.sunDur = seconds;
  }
  /** A touch on the volcano wakes it: an eruption now, unless one happened in the last 12 s (never under reduced motion; the caller checks). */
  erupt(time: number): boolean {
    if (!this.smokeMat || this.eruption >= 0 || time - this.lastEruption < 12) return false;
    this.eruptAt = time; return true;
  }
  /** 0 calm … 1 at the height of an eruption. */
  get eruptLevel() { return (this.smokeMat?.uniforms.uErupt.value as number | undefined) ?? 0; }
  /** Sun elevation (sine) over a place: < 0 is night. */
  sunAt(dir: THREE.Vector3) { return dir.clone().normalize().dot(this.sunDir); }

  /** Station pearls: a lacquered pearl with a coloured inner glow and a bright rim (state colour per instance). */
  private pearlMaterial() {
    const m = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, sheen: 0.6, sheenColor: new THREE.Color('#ffffff') });
    m.onBeforeCompile = sh => {
      sh.uniforms.uTime = shared.uTime;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float rim = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 2.4);
          totalEmissiveRadiance += vColor.rgb * (0.42 + 0.18 * sin(uTime * 2.0)) + vec3(1.0) * rim * 0.35;`);
    };
    m.customProgramCacheKey = () => 'od-planet-pearl-1';
    return m;
  }

  private beamMaterial(color: string) {
    return new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { uTime: shared.uTime, uColor: { value: new THREE.Color(color) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec2 vUv; void main(){ float a = pow(1.0 - vUv.y, 1.6) * (0.6 + 0.4 * sin(vUv.y * 14.0 - uTime * 3.0)) * 0.2; gl_FragColor = vec4(uColor * a, a); }` });
  }

  setRegionKinds(kinds: Record<string, RegionKind>) {
    for (const [id, b] of this.beacons) {
      const kind = kinds[id] ?? 'open'; b.kind = kind;
      const color = new THREE.Color(KIND_COLOR[kind]);
      const m = b.core.material as THREE.MeshStandardMaterial; m.color.copy(color); m.emissive.copy(color); m.emissiveIntensity = kind === 'next' ? 1.5 : kind === 'open' ? 0.55 : 1.0;
      (b.halo.material as THREE.SpriteMaterial).color.copy(color);
      b.beam.visible = kind === 'next';
    }
  }

  setRoutes(routes: LearningRoute[]) {
    if (this.routes) { this.routes.geometry.dispose(); this.root.remove(this.routes); this.routes = null; }
    const pos: number[] = [], t: number[] = [], st: number[] = [], kd: number[] = [], idx: number[] = [];
    const radial = 6;
    for (const r of routes) {
      const a = this.build.sites[this.siteIndex.get(r.from) ?? -1], b = this.build.sites[this.siteIndex.get(r.to) ?? -1];
      if (!a || !b) continue;
      const A = new THREE.Vector3(...a.up), B = new THREE.Vector3(...b.up), angle = A.angleTo(B), steps = Math.max(16, Math.round(angle * 60));
      const lift = 2 + angle * this.R * 0.055, width = r.state === 'recommended' ? 0.36 : r.kind === 'parallel' ? 0.14 : 0.22;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= steps; i++) { const u = i / steps; const d = new THREE.Vector3().copy(A).multiplyScalar(Math.sin((1 - u) * angle)).addScaledVector(B, Math.sin(u * angle)).divideScalar(Math.sin(angle) || 1).normalize(); pts.push(d.multiplyScalar(this.R + 4 + lift * Math.sin(Math.PI * u))); }
      const base = pos.length / 3, state = ROUTE_STATES.indexOf(r.state);
      for (let i = 0; i <= steps; i++) {
        const p = pts[i], tangent = (pts[Math.min(steps, i + 1)].clone().sub(pts[Math.max(0, i - 1)])).normalize(), n1 = p.clone().normalize().cross(tangent).normalize(), n2 = tangent.clone().cross(n1).normalize();
        for (let k = 0; k < radial; k++) { const ang = k / radial * Math.PI * 2; const o = n1.clone().multiplyScalar(Math.cos(ang) * width).addScaledVector(n2, Math.sin(ang) * width); pos.push(p.x + o.x, p.y + o.y, p.z + o.z); t.push(i / steps); st.push(state); kd.push(r.kind === 'prerequisite' ? 1 : 0); }
        if (i < steps) for (let k = 0; k < radial; k++) { const a0 = base + i * radial + k, a1 = base + i * radial + (k + 1) % radial, b0 = a0 + radial, b1 = a1 + radial; idx.push(a0, b0, a1, a1, b0, b1); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
    g.setAttribute('aState', new THREE.Float32BufferAttribute(st, 1)); g.setAttribute('aKind', new THREE.Float32BufferAttribute(kd, 1)); g.setIndex(idx);
    this.routes = new THREE.Mesh(g, this.routeMat); this.routes.renderOrder = 8; this.routes.frustumCulled = false; this.root.add(this.routes);
  }

  /** Station pins around a region's landmark (every station, not a page of them). */
  setPins(regionId: string | null, pins: { id: string; state: PinState }[], selected: string | null) {
    const site = regionId ? this.build.sites[this.siteIndex.get(regionId) ?? -1] : null;
    this.pinIds = []; this.pinSel = -1;
    if (!site) { this.pins.count = 0; this.rings.count = 0; this.pinBeam.visible = false; return; }
    const sockets = site.sockets, n = Math.min(pins.length, sockets.length / 3, 72);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color(), Y = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const p = new THREE.Vector3(sockets[i * 3], sockets[i * 3 + 1], sockets[i * 3 + 2]), up = p.clone().normalize();
      q.setFromUnitVectors(Y, up);
      const chosen = pins[i].id === selected, s = chosen ? 1.45 : 1;
      m.compose(p.clone().addScaledVector(up, 0.85 * s), q, new THREE.Vector3(s, s, s)); this.pins.setMatrixAt(i, m);
      m.compose(p.clone().addScaledVector(up, 0.06), q, new THREE.Vector3(s, 1, s)); this.rings.setMatrixAt(i, m);
      c.set(PIN_COLOR[pins[i].state]); this.pins.setColorAt(i, c); this.rings.setColorAt(i, c);
      this.pinIds.push(pins[i].id);
      if (chosen) { this.pinSel = i; this.pinBeam.position.copy(p); this.pinBeam.quaternion.copy(q); }
    }
    this.pins.count = n; this.rings.count = n;
    this.pins.instanceMatrix.needsUpdate = this.rings.instanceMatrix.needsUpdate = true;
    if (this.pins.instanceColor) this.pins.instanceColor.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    this.pinBeam.visible = this.pinSel >= 0;
  }
  pinWorld(id: string) {
    const i = this.pinIds.indexOf(id); if (i < 0) return null;
    const m = new THREE.Matrix4(); this.pins.getMatrixAt(i, m); return new THREE.Vector3().setFromMatrixPosition(m);
  }
  pickPin(ray: THREE.Raycaster) {
    if (!this.pins.count) return null;
    const hits = ray.intersectObject(this.pins, false);
    return hits.length && hits[0].instanceId !== undefined ? this.pinIds[hits[0].instanceId] : null;
  }
  beaconWorld(id: string) { const b = this.beacons.get(id); return b ? b.group.position : null; }
  sitePlace(id: string) { const s = this.build.sites[this.siteIndex.get(id) ?? -1]; return s ?? null; }

  /** Per-frame work. `spin` is the view's angular velocity around the planet (for the ocean's inertia). */
  update(camera: THREE.PerspectiveCamera, time: number, dt: number, closeness: number, region: string | null, pixelRatio: number, spin: THREE.Vector3, reduced: boolean, ground?: { focus: THREE.Vector3 }) {
    // The sun: eased towards its anchor (a flight's morning), otherwise fixed in the world.
    if (this.sunT < 1) {
      this.sunT = Math.min(1, this.sunT + dt / this.sunDur);
      const e = this.sunT < 0.5 ? 2 * this.sunT * this.sunT : 1 - Math.pow(-2 * this.sunT + 2, 2) / 2;
      this.sunDir.copy(this.sunFrom).lerp(this.sunTo, e).normalize();
    }
    const S = this.sunDir;
    shared.uSunDir.value.copy(S);
    if (this.sun.castShadow) (this.sun.shadow as THREE.LightShadow & { intensity?: number }).intensity = 0.74 * THREE.MathUtils.smoothstep(closeness, 0.55, 0.85);
    const focus = ground && closeness > 0.5 ? ground.focus : null;
    if (focus) {
      this.sun.position.copy(focus).addScaledVector(S, 160); this.sun.target.position.copy(focus);
      if (this.sun.castShadow && (this.shadowAt.distanceToSquared(focus) > 0.25 || this.shadowSun.dot(S) < 0.99985) && ++this.shadowWait >= 3) {
        this.shadowAt.copy(focus); this.shadowSun.copy(S); this.shadowWait = 0; this.shadowDirty = true;
      }
    } else { this.sun.position.copy(S).multiplyScalar(400); this.sun.target.position.set(0, 0, 0); }
    this.sun.target.updateMatrixWorld();
    // Daylight intensity of the key light: the sun sets for the place under the camera when it is on the night side.
    const below = focus ? focus.clone().normalize().dot(S) : 1;
    this.sun.intensity = 3.1 * THREE.MathUtils.smoothstep(below, -0.12, 0.1);
    shared.uHazeK.value = 1 - closeness * 0.55;
    shared.uDay.value = THREE.MathUtils.smoothstep(closeness, 0.35, 0.9) * THREE.MathUtils.smoothstep(below, -0.15, 0.12);
    // Glare: only when the sun is in front of the camera and not hidden by the planet; brightest as it rises over the limb.
    const toCenter = camera.position.clone().negate(), dist = toCenter.length(); toCenter.divideScalar(dist);
    const planetAng = Math.asin(Math.min(1, (this.R * 1.03) / dist)), sep = S.angleTo(toCenter);
    const vis = THREE.MathUtils.smoothstep(sep, planetAng * 0.985, planetAng * 1.045) * (1 - shared.uDay.value);
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), facing = THREE.MathUtils.smoothstep(S.dot(camFwd), 0.82, 0.96);
    this.sunVisible = vis * facing;
    const rim = 4 * vis * (1 - vis);
    this.glare.position.copy(camera.position).addScaledVector(S, 1150);
    this.glare.scale.setScalar(260 + rim * 520);
    (this.glare.material as THREE.SpriteMaterial).opacity = Math.min(1, this.sunVisible * (0.55 + rim * 0.9));
    if (this.ghosts[0]?.visible) {
      const ndc = camera.position.clone().addScaledVector(S, 1000).project(camera);
      this.ghosts.forEach((g, i) => {
        const k = [-0.45, -0.95, -1.5][i], p = new THREE.Vector3(ndc.x * k, ndc.y * k, 0.5).unproject(camera).sub(camera.position).normalize();
        g.position.copy(camera.position).addScaledVector(p, 1000); g.scale.setScalar([90, 46, 140][i]);
        (g.material as THREE.SpriteMaterial).opacity = this.sunVisible * [0.22, 0.32, 0.12][i] * (ndc.z < 1 ? 1 : 0);
      });
    }
    (this.sky.material as THREE.ShaderMaterial).uniforms.uUp.value.copy(camera.position).normalize();
    (this.stars.material as THREE.ShaderMaterial).uniforms.uPx.value = pixelRatio;
    this.sky.position.copy(camera.position);
    this.moon.rotation.y = time * 0.01;
    // Ocean inertia: the wave field lags behind the view's rotation and settles back on a soft spring.
    const speed = spin.length();
    const agTarget = THREE.MathUtils.clamp(speed * 0.55, 0, 1);
    const ag = shared.uAgitation.value; shared.uAgitation.value = ag + (agTarget - ag) * Math.min(1, dt * (agTarget > ag ? 6 : 0.9));
    const target = spin.clone().multiplyScalar(-0.12).clampLength(0, 0.045);
    if (reduced) { this.drift.set(0, 0, 0); this.driftV.set(0, 0, 0); }
    else {
      this.driftV.addScaledVector(target.sub(this.drift).multiplyScalar(30).addScaledVector(this.driftV, -5.2), Math.min(dt, 0.05));
      this.drift.addScaledVector(this.driftV, Math.min(dt, 0.05));
    }
    shared.uDrift.value.copy(this.drift);
    // The volcano: calm glow and smoke; every 40–75 s an eruption of about 7 s (never under reduced motion).
    if (this.smokeMat && this.emberMat) {
      // Arriving at the volcano's region brings an eruption a few seconds later (unless one just happened).
      const atVolcano = region === 'trial' && closeness > 0.6;
      if (atVolcano && !this.visitingVolcano && time - this.lastEruption > 30) this.eruptAt = Math.min(this.eruptAt, time + 5);
      this.visitingVolcano = atVolcano;
      if (!reduced && this.eruption < 0 && time > this.eruptAt) { this.eruption = time; this.lastEruption = time; }
      let erupt = 0, et = -1;
      if (this.eruption >= 0) {
        et = time - this.eruption;
        erupt = THREE.MathUtils.smoothstep(et, 0, 0.6) * (1 - THREE.MathUtils.smoothstep(et, 4.5, 7.5));
        if (et > 8) { this.eruption = -1; this.eruptAt = time + 40 + this.eruptRand() * 35; et = -1; }
      }
      this.smokeMat.uniforms.uErupt.value = erupt; this.emberMat.uniforms.uErupt.value = erupt; this.emberMat.uniforms.uEruptT.value = et;
      this.smokeMat.uniforms.uScale.value = pixelRatio; this.emberMat.uniforms.uScale.value = pixelRatio;
      shared.uLavaGlow.value = 0.55 + 0.12 * Math.sin(time * 1.3) + erupt * 2.2;
    }
    if (this.lightMat) this.lightMat.uniforms.uScale.value = pixelRatio;
    // Props: detail near the camera, nothing on the far side of the planet; ground cover only in close views.
    const camDir = camera.position.clone().normalize(), camDist = camera.position.length(), lod = this.tier?.lodDistance ?? 120;
    for (const c of this.clusters) {
      const facing = c.center.clone().normalize().dot(camDir);
      const horizon = this.R / camDist;
      const hidden = facing < horizon - 0.45;
      const d = c.center.distanceTo(camera.position);
      const near = !hidden && d < lod + this.R * 0.25;
      if (!c.lo) { c.hi.visible = near && closeness > 0.45 && d < 150 && c.hi.count > 0; continue; }
      c.hi.visible = near; c.lo.visible = !hidden && !near;
    }
    // Boats sail their circles; windmills turn.
    if (this.boats) {
      const m = this.tmp, up = new THREE.Vector3(), fwd = new THREE.Vector3(), side = new THREE.Vector3();
      this.build.boats.forEach((b, i) => {
        const c = new THREE.Vector3(...b.center), e = new THREE.Vector3().crossVectors(Math.abs(c.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0), c).normalize(), n = new THREE.Vector3().crossVectors(c, e);
        const th = b.phase + time * b.speed;
        up.copy(c).multiplyScalar(Math.cos(b.angle)).addScaledVector(e, Math.sin(b.angle) * Math.cos(th)).addScaledVector(n, Math.sin(b.angle) * Math.sin(th)).normalize();
        fwd.copy(e).multiplyScalar(-Math.sin(th)).addScaledVector(n, Math.cos(th)).multiplyScalar(Math.sign(b.speed)).normalize();
        fwd.addScaledVector(up, -fwd.dot(up)).normalize(); side.crossVectors(fwd, up);
        const roll = Math.sin(time * 1.3 + i) * 0.06 * (1 + shared.uAgitation.value * 2);
        m.makeBasis(fwd, up.clone().applyAxisAngle(fwd, roll), side).scale(new THREE.Vector3(0.9, 0.9, 0.9)).setPosition(up.clone().multiplyScalar(this.R + 0.05 + Math.sin(time * 1.7 + i) * 0.06));
        this.boats!.setMatrixAt(i, m);
      });
      this.boats.instanceMatrix.needsUpdate = true;
    }
    if (this.blades) {
      let i = 0; const m = this.tmp;
      for (const s of this.build.sites) for (const mill of s.mills) {
        const axis = new THREE.Vector3(...mill.axis), upv = new THREE.Vector3(...s.up), x = new THREE.Vector3().crossVectors(upv, axis).normalize(), y = new THREE.Vector3().crossVectors(axis, x);
        m.makeBasis(x, y, axis).multiply(new THREE.Matrix4().makeRotationZ(time * 0.9 + i)).scale(new THREE.Vector3(mill.r, mill.r, mill.r)).setPosition(...mill.p);
        this.blades.setMatrixAt(i++, m);
      }
      this.blades.instanceMatrix.needsUpdate = true;
    }
    if (this.cloudMat && this.clouds) {
      this.cloudMat.uniforms.uSpin.value = time * 0.004;
      const fade = 1 - THREE.MathUtils.smoothstep(closeness, 0.15, 0.6);
      this.cloudMat.uniforms.uFade.value = fade;
      this.clouds.visible = fade > 0.02 && (this.clouds.geometry as THREE.InstancedBufferGeometry).instanceCount > 0;
    }
    if (this.routes) (this.routes.material as THREE.ShaderMaterial).uniforms.uFade.value = 1 - THREE.MathUtils.smoothstep(closeness, 0.25, 0.65);
    for (const [id, b] of this.beacons) {
      const focusHere = region === id;
      b.core.rotation.y = time * 0.6; b.core.position.y = Math.sin(time * 1.4 + b.group.position.x) * 0.35;
      const s = (b.kind === 'next' ? 1.25 : 1) * (focusHere ? 0.8 : 1) * (1 + closeness * -0.25);
      b.core.scale.setScalar(s);
      b.halo.scale.setScalar((b.kind === 'next' ? 7 + Math.sin(time * 2.4) * 1.2 : 5) * (1 - closeness * 0.35));
      b.group.visible = !region || focusHere || closeness < 0.6;
    }
    if (this.pinSel >= 0) this.pinBeam.scale.set(1, 0.85 + Math.sin(time * 2.2) * 0.15, 1);
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
    this.routes?.geometry.dispose();
    this.sun.shadow.map?.dispose();
    this.root.clear();
  }
}
