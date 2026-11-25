import * as T from 'three';

/**
 * Echo Life AAA — Pooled Zero-Hitch Walk-In Shower VFX (`ShowerWaterVfxSystem`).
 *
 * Contract for Agent A7 (Walk-In Shower Hotspot) and Agent A6 (Bathroom Steam Zone):
 * - Single pre-allocated `Group` holding 3 pooled `InstancedMesh` layers (`streamMesh`, `splashMesh`, `steamMesh`)
 *   with pinned `customProgramCacheKey`, `depthWrite = false`, `userData.skipMirrorPass = true`, and zero per-frame GC.
 * - Analytical GPU animation (`uTime` paused under `reducedMotion`) for nozzle-to-tray water threads, enclosure-clamped
 *   tray droplets, and rising warm steam puffs, plus smooth `0..1` `getSteamLevel(id)` ramp for `setZoneSteamLevel`.
 * - `warmup(renderer, scene, camera)` executes a `1x1`-scissored Stage-6 prewarm (`count = 1`) so turning on any
 *   shower in gameplay incurs `0` shader compiles (`programDelta === 0`) and `0` buffer allocations.
 */

export interface ShowerEnclosureBounds {
  minX: number;
  maxX: number;
  minY?: number;
  maxY?: number;
  minZ: number;
  maxZ: number;
}

export interface ShowerEmitterSpec {
  id: string;
  nozzleStagePos: { x: number; y: number; z: number };
  floorY: number;
  sprayRadius: number;
  enclosureBounds: ShowerEnclosureBounds;
  /** Optional horizontal spray direction offset (defaults to straight down). */
  sprayDir?: { x: number; y?: number; z: number };
}

const MAX_EMITTERS = 4;
const STREAMS_PER_EMITTER = 24;
const SPLASHES_PER_EMITTER = 32;
const STEAM_PER_EMITTER = 12;

const MAX_STREAMS = MAX_EMITTERS * STREAMS_PER_EMITTER;
const MAX_SPLASHES = MAX_EMITTERS * SPLASHES_PER_EMITTER;
const MAX_STEAM = MAX_EMITTERS * STEAM_PER_EMITTER;

const FLOW_RAMP_UP_PER_SEC = 4.8;
const FLOW_RAMP_DOWN_PER_SEC = 3.4;
const STEAM_RAMP_UP_PER_SEC = 1 / 6.5;
const STEAM_RAMP_DOWN_PER_SEC = 1 / 16.0;

interface StreamSample {
  topX: number;
  topY: number;
  topZ: number;
  botX: number;
  botY: number;
  botZ: number;
  seed: number;
  widthScale: number;
}

interface SplashSample {
  x: number;
  y: number;
  z: number;
  seed: number;
  height: number;
  driftX: number;
  driftZ: number;
}

interface SteamSample {
  x: number;
  minY: number;
  maxY: number;
  z: number;
  seed: number;
  radius: number;
}

interface EmitterRuntime {
  spec: ShowerEmitterSpec;
  active: boolean;
  targetIntensity: number;
  flowLevel: number;
  steamLevel: number;
  streams: StreamSample[];
  splashes: SplashSample[];
  steams: SteamSample[];
  dirtyGeometry: boolean;
}

function hash01(seed: number): number {
  const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function hashString(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 10000;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const STREAM_VERT = /* glsl */`
attribute vec2 aStreamParam;
varying vec2 vUv;
varying float vSeed;
varying float vFlow;
varying vec3 vViewPos;
varying vec3 vViewNormal;

void main() {
  vUv = uv;
  vSeed = aStreamParam.x;
  vFlow = aStreamParam.y;
  vec4 mvPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vViewPos = -mvPos.xyz;
  vViewNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * mvPos;
}
`;

const STREAM_FRAG = /* glsl */`
uniform float uTime;
uniform float uReduced;
varying vec2 vUv;
varying float vSeed;
varying float vFlow;
varying vec3 vViewPos;
varying vec3 vViewNormal;

void main() {
  if (vFlow <= 0.002) discard;
  float along = 1.0 - vUv.y;
  float topMask = smoothstep(0.0, 0.07, along);
  float botMask = smoothstep(1.0, 0.86, along);
  float shutoffMask = smoothstep(1.0 - vFlow, min(1.0, 1.12 - vFlow), 1.0 - along * 0.25);

  float t = uReduced > 0.5 ? 0.0 : uTime;
  float phaseA = fract(along * 6.5 - t * (3.6 + vSeed * 1.4) + vSeed * 7.13);
  float phaseB = fract(along * 13.0 - t * (5.2 + vSeed * 1.9) + vSeed * 3.71);
  float beadA = smoothstep(0.08, 0.45, phaseA) * smoothstep(0.96, 0.55, phaseA);
  float beadB = smoothstep(0.15, 0.5, phaseB) * smoothstep(0.92, 0.55, phaseB);
  float streak = uReduced > 0.5 ? 0.62 : (0.34 + beadA * 0.52 + beadB * 0.34);

  vec3 V = normalize(vViewPos);
  vec3 N = normalize(vViewNormal);
  float rim = 1.0 - abs(dot(N, V));
  float core = 1.0 - rim * 0.55;
  float fresnel = pow(clamp(rim, 0.0, 1.0), 2.4);

  vec3 baseCol = mix(vec3(0.76, 0.88, 0.96), vec3(0.95, 0.98, 1.0), fresnel * 0.75 + beadB * 0.25);
  float alpha = clamp(streak * core * topMask * botMask * shutoffMask * vFlow * 0.36, 0.0, 0.48);
  if (alpha <= 0.004) discard;

  gl_FragColor = vec4(baseCol, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPLASH_VERT = /* glsl */`
attribute vec4 aSplashParam;
attribute vec2 aSplashDrift;
uniform float uTime;
uniform float uReduced;
varying vec2 vUv;
varying float vAlpha;

void main() {
  vUv = uv;
  float seed = aSplashParam.x;
  float maxH = aSplashParam.y;
  float size = aSplashParam.z;
  float flow = aSplashParam.w;

  vec3 basePos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float cycle = uReduced > 0.5 ? fract(seed * 3.17) : fract(uTime * (2.4 + seed * 1.5) + seed * 5.7);
  float arc = 4.0 * cycle * (1.0 - cycle);
  vec3 worldCenter = basePos + vec3(aSplashDrift.x * cycle, arc * maxH, aSplashDrift.y * cycle);

  vec4 mvCenter = modelViewMatrix * vec4(worldCenter, 1.0);
  float liveSize = size * (0.65 + 0.55 * (1.0 - cycle)) * step(0.005, flow);
  mvCenter.xy += position.xy * liveSize;
  vAlpha = flow * (1.0 - cycle * 0.72);
  gl_Position = projectionMatrix * mvCenter;
}
`;

const SPLASH_FRAG = /* glsl */`
varying vec2 vUv;
varying float vAlpha;

void main() {
  if (vAlpha <= 0.004) discard;
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float soft = (1.0 - r2) * (1.0 - r2 * 0.65);
  float spec = smoothstep(0.55, 0.0, length(p - vec2(-0.22, 0.24)));
  vec3 col = mix(vec3(0.78, 0.89, 0.97), vec3(0.98, 0.99, 1.0), spec * 0.7);
  float a = clamp(soft * vAlpha * 0.58, 0.0, 0.62);
  if (a <= 0.004) discard;

  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const STEAM_VERT = /* glsl */`
attribute vec4 aSteamParam;
uniform float uTime;
uniform float uReduced;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;

void main() {
  vUv = uv;
  float seed = aSteamParam.x;
  float riseSpan = aSteamParam.y;
  float baseRadius = aSteamParam.z;
  float steamLevel = aSteamParam.w;
  vSeed = seed;

  vec3 basePos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float t = uReduced > 0.5 ? fract(seed * 1.91) : fract(uTime * (0.11 + seed * 0.06) + seed * 4.3);
  float swayX = uReduced > 0.5 ? 0.0 : sin(uTime * 0.55 + seed * 6.28) * 0.045;
  float swayZ = uReduced > 0.5 ? 0.0 : cos(uTime * 0.48 + seed * 4.91) * 0.045;
  vec3 worldCenter = basePos + vec3(swayX, t * riseSpan, swayZ);

  vec4 mvCenter = modelViewMatrix * vec4(worldCenter, 1.0);
  float radius = baseRadius * (0.72 + t * 0.68) * step(0.003, steamLevel);
  mvCenter.xy += position.xy * radius;

  float env = smoothstep(0.0, 0.22, t) * smoothstep(1.0, 0.38, t);
  vAlpha = steamLevel * env;
  gl_Position = projectionMatrix * mvCenter;
}
`;

const STEAM_FRAG = /* glsl */`
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;

float steamHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float steamNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(steamHash(i), steamHash(i + vec2(1.0, 0.0)), u.x),
    mix(steamHash(i + vec2(0.0, 1.0)), steamHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  if (vAlpha <= 0.002) discard;
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r >= 1.0) discard;
  float radial = pow(1.0 - r, 2.1);
  float n = steamNoise(vUv * 3.4 + vec2(vSeed * 5.1, vSeed * 2.7)) * 0.65
          + steamNoise(vUv * 6.8 - vec2(vSeed * 3.3, vSeed * 7.9)) * 0.35;
  float a = clamp(radial * (0.58 + n * 0.52) * vAlpha * 0.135, 0.0, 0.15);
  if (a <= 0.002) discard;

  gl_FragColor = vec4(vec3(0.95, 0.97, 0.99), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class ShowerWaterVfxSystem {
  readonly group = new T.Group();

  private readonly emitters = new Map<string, EmitterRuntime>();
  private readonly streamMesh: T.InstancedMesh;
  private readonly splashMesh: T.InstancedMesh;
  private readonly steamMesh: T.InstancedMesh;

  private readonly streamMat: T.ShaderMaterial;
  private readonly splashMat: T.ShaderMaterial;
  private readonly steamMat: T.ShaderMaterial;

  private readonly streamParamAttr: T.InstancedBufferAttribute;
  private readonly splashParamAttr: T.InstancedBufferAttribute;
  private readonly splashDriftAttr: T.InstancedBufferAttribute;
  private readonly steamParamAttr: T.InstancedBufferAttribute;

  private readonly tmpPos = new T.Vector3();
  private readonly tmpBot = new T.Vector3();
  private readonly tmpDir = new T.Vector3();
  private readonly tmpUp = new T.Vector3(0, -1, 0);
  private readonly tmpQuat = new T.Quaternion();
  private readonly tmpScale = new T.Vector3(1, 1, 1);
  private readonly tmpMat = new T.Matrix4();
  private readonly savedViewport = new T.Vector4();
  private readonly savedScissor = new T.Vector4();

  private time = 0;
  private wasAnyVisible = false;
  private needsMatrixPack = true;
  private disposed = false;

  constructor(parent?: T.Object3D | null) {
    this.group.name = 'echo-life-shower-vfx';
    this.group.visible = false;
    this.group.userData.skipMirrorPass = true;
    this.group.userData.noCollision = true;

    // 1. Stream threads (`y = 0` at nozzle -> `y = -1` at floor impact).
    const streamGeom = new T.CylinderGeometry(0.0022, 0.0056, 1, 5, 1, true);
    streamGeom.translate(0, -0.5, 0);
    this.streamParamAttr = new T.InstancedBufferAttribute(new Float32Array(MAX_STREAMS * 2), 2);
    this.streamParamAttr.setUsage(T.DynamicDrawUsage);
    streamGeom.setAttribute('aStreamParam', this.streamParamAttr);

    this.streamMat = new T.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uReduced: { value: 0 },
      },
      vertexShader: STREAM_VERT,
      fragmentShader: STREAM_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: T.DoubleSide,
      toneMapped: true,
    });
    this.streamMat.customProgramCacheKey = () => 'ec-shower-stream-v1';

    this.streamMesh = new T.InstancedMesh(streamGeom, this.streamMat, MAX_STREAMS);
    this.streamMesh.count = 0;
    this.configureMeshFlags(this.streamMesh, 7);

    // 2. Tray impact splash droplets (camera-billboarded ballistic arcs clamped inside enclosureBounds).
    const splashGeom = new T.PlaneGeometry(1, 1);
    this.splashParamAttr = new T.InstancedBufferAttribute(new Float32Array(MAX_SPLASHES * 4), 4);
    this.splashParamAttr.setUsage(T.DynamicDrawUsage);
    this.splashDriftAttr = new T.InstancedBufferAttribute(new Float32Array(MAX_SPLASHES * 2), 2);
    this.splashDriftAttr.setUsage(T.DynamicDrawUsage);
    splashGeom.setAttribute('aSplashParam', this.splashParamAttr);
    splashGeom.setAttribute('aSplashDrift', this.splashDriftAttr);

    this.splashMat = new T.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uReduced: { value: 0 },
      },
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: true,
    });
    this.splashMat.customProgramCacheKey = () => 'ec-shower-splash-v1';

    this.splashMesh = new T.InstancedMesh(splashGeom, this.splashMat, MAX_SPLASHES);
    this.splashMesh.count = 0;
    this.configureMeshFlags(this.splashMesh, 8);

    // 3. Soft rising warm steam puffs inside the shower enclosure.
    const steamGeom = new T.PlaneGeometry(1, 1);
    this.steamParamAttr = new T.InstancedBufferAttribute(new Float32Array(MAX_STEAM * 4), 4);
    this.steamParamAttr.setUsage(T.DynamicDrawUsage);
    steamGeom.setAttribute('aSteamParam', this.steamParamAttr);

    this.steamMat = new T.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uReduced: { value: 0 },
      },
      vertexShader: STEAM_VERT,
      fragmentShader: STEAM_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: true,
    });
    this.steamMat.customProgramCacheKey = () => 'ec-shower-steam-v1';

    this.steamMesh = new T.InstancedMesh(steamGeom, this.steamMat, MAX_STEAM);
    this.steamMesh.count = 0;
    this.configureMeshFlags(this.steamMesh, 9);

    this.group.add(this.streamMesh, this.splashMesh, this.steamMesh);
    if (parent) parent.add(this.group);
  }

  private configureMeshFlags(mesh: T.InstancedMesh, renderOrder: number): void {
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.userData.skipMirrorPass = true;
    mesh.userData.noCollision = true;
    mesh.raycast = () => undefined;
  }

  private buildSamples(spec: ShowerEmitterSpec): Pick<EmitterRuntime, 'streams' | 'splashes' | 'steams'> {
    const baseSeed = hashString(spec.id) * 0.137 + 1.0;
    const b = spec.enclosureBounds;
    const wallPad = 0.055;
    const minX = Math.min(b.minX, b.maxX) + wallPad;
    const maxX = Math.max(b.minX, b.maxX) - wallPad;
    const minZ = Math.min(b.minZ, b.maxZ) + wallPad;
    const maxZ = Math.max(b.minZ, b.maxZ) - wallPad;
    const safeMinX = minX <= maxX ? minX : (b.minX + b.maxX) * 0.5;
    const safeMaxX = minX <= maxX ? maxX : safeMinX;
    const safeMinZ = minZ <= maxZ ? minZ : (b.minZ + b.maxZ) * 0.5;
    const safeMaxZ = minZ <= maxZ ? maxZ : safeMinZ;

    const nozzleX = clamp(spec.nozzleStagePos.x, safeMinX, safeMaxX);
    const nozzleY = spec.nozzleStagePos.y;
    const nozzleZ = clamp(spec.nozzleStagePos.z, safeMinZ, safeMaxZ);
    const floorY = Math.min(spec.floorY, nozzleY - 0.25);
    const radius = Math.max(0.06, spec.sprayRadius);
    const dirX = spec.sprayDir?.x ?? 0;
    const dirZ = spec.sprayDir?.z ?? 0;
    const dropH = Math.max(0.25, nozzleY - floorY);

    const streams: StreamSample[] = [];
    for (let i = 0; i < STREAMS_PER_EMITTER; i++) {
      const s1 = hash01(baseSeed + i * 3.11);
      const s2 = hash01(baseSeed + i * 7.37 + 19.1);
      const s3 = hash01(baseSeed + i * 11.73 + 41.7);
      // Golden-angle spiral for uniform showerhead rose distribution.
      const angle = i * 2.39996323 + s1 * 0.35;
      const radial = Math.sqrt((i + 0.5) / STREAMS_PER_EMITTER);
      const headR = radial * Math.min(0.065, radius * 0.28);
      const spreadR = radial * radius * (0.78 + s2 * 0.32);

      const topX = clamp(nozzleX + Math.cos(angle) * headR, safeMinX, safeMaxX);
      const topZ = clamp(nozzleZ + Math.sin(angle) * headR, safeMinZ, safeMaxZ);
      const botX = clamp(nozzleX + dirX * dropH + Math.cos(angle) * spreadR, safeMinX, safeMaxX);
      const botZ = clamp(nozzleZ + dirZ * dropH + Math.sin(angle) * spreadR, safeMinZ, safeMaxZ);

      streams.push({
        topX,
        topY: nozzleY,
        topZ,
        botX,
        botY: floorY,
        botZ,
        seed: s3,
        widthScale: 0.78 + s2 * 0.52,
      });
    }

    const splashes: SplashSample[] = [];
    const impactCenterX = clamp(nozzleX + dirX * dropH, safeMinX, safeMaxX);
    const impactCenterZ = clamp(nozzleZ + dirZ * dropH, safeMinZ, safeMaxZ);
    for (let i = 0; i < SPLASHES_PER_EMITTER; i++) {
      const s1 = hash01(baseSeed + 200 + i * 5.13);
      const s2 = hash01(baseSeed + 200 + i * 9.77);
      const s3 = hash01(baseSeed + 200 + i * 13.31);
      const ang = s1 * Math.PI * 2;
      const rr = Math.sqrt(s2) * radius * 0.95;
      const x = clamp(impactCenterX + Math.cos(ang) * rr, safeMinX, safeMaxX);
      const z = clamp(impactCenterZ + Math.sin(ang) * rr, safeMinZ, safeMaxZ);
      const driftDist = 0.03 + s3 * 0.085;
      const targetX = clamp(x + Math.cos(ang) * driftDist, safeMinX, safeMaxX);
      const targetZ = clamp(z + Math.sin(ang) * driftDist, safeMinZ, safeMaxZ);
      splashes.push({
        x,
        y: floorY + 0.008,
        z,
        seed: s3,
        height: 0.035 + (1 - s2 * 0.4) * 0.11,
        driftX: targetX - x,
        driftZ: targetZ - z,
      });
    }

    const steams: SteamSample[] = [];
    const stallCenterX = (safeMinX + safeMaxX) * 0.5;
    const stallCenterZ = (safeMinZ + safeMaxZ) * 0.5;
    const halfSpanX = Math.max(0.05, (safeMaxX - safeMinX) * 0.36);
    const halfSpanZ = Math.max(0.05, (safeMaxZ - safeMinZ) * 0.36);
    const topSteamY = b.maxY !== undefined ? Math.max(floorY + 0.8, b.maxY - 0.18) : nozzleY + 0.12;
    const minSteamY = (b.minY ?? floorY) + 0.28;
    const steamBaseRadius = clamp(Math.min(safeMaxX - safeMinX, safeMaxZ - safeMinZ) * 0.48, 0.28, 0.62);

    for (let i = 0; i < STEAM_PER_EMITTER; i++) {
      const s1 = hash01(baseSeed + 500 + i * 4.71);
      const s2 = hash01(baseSeed + 500 + i * 8.19);
      const s3 = hash01(baseSeed + 500 + i * 12.61);
      steams.push({
        x: clamp(stallCenterX + (s1 * 2 - 1) * halfSpanX, safeMinX, safeMaxX),
        minY: minSteamY + s2 * 0.18,
        maxY: Math.max(minSteamY + 0.55, topSteamY),
        z: clamp(stallCenterZ + (s2 * 2 - 1) * halfSpanZ, safeMinZ, safeMaxZ),
        seed: s3,
        radius: steamBaseRadius * (0.82 + s1 * 0.36),
      });
    }

    return { streams, splashes, steams };
  }

  /** Registers or updates a walk-in shower emitter specification (up to 4 simultaneous emitters per house/zone). */
  registerEmitter(spec: ShowerEmitterSpec): void {
    if (this.disposed) return;
    const existing = this.emitters.get(spec.id);
    const samples = this.buildSamples(spec);
    if (existing) {
      existing.spec = spec;
      existing.streams = samples.streams;
      existing.splashes = samples.splashes;
      existing.steams = samples.steams;
      existing.dirtyGeometry = true;
    } else {
      if (this.emitters.size >= MAX_EMITTERS) {
        // Evict the oldest inactive emitter if capacity is exceeded.
        for (const [oldId, rt] of this.emitters) {
          if (!rt.active && rt.flowLevel <= 0.001 && rt.steamLevel <= 0.001) {
            this.emitters.delete(oldId);
            break;
          }
        }
        if (this.emitters.size >= MAX_EMITTERS) return;
      }
      this.emitters.set(spec.id, {
        spec,
        active: false,
        targetIntensity: 0,
        flowLevel: 0,
        steamLevel: 0,
        ...samples,
        dirtyGeometry: true,
      });
    }
    this.needsMatrixPack = true;
  }

  unregisterEmitter(id: string): void {
    if (this.emitters.delete(id)) {
      this.needsMatrixPack = true;
    }
  }

  clearEmitters(): void {
    if (!this.emitters.size) return;
    this.emitters.clear();
    this.streamMesh.count = 0;
    this.splashMesh.count = 0;
    this.steamMesh.count = 0;
    this.group.visible = false;
    this.wasAnyVisible = false;
    this.needsMatrixPack = true;
  }

  hasEmitter(id: string): boolean {
    return this.emitters.has(id);
  }

  /** Toggles water flow on a registered shower emitter (`intensity` in `0..1`, default `1`). */
  setActive(id: string, active: boolean, intensity = 1): void {
    const rt = this.emitters.get(id);
    if (!rt) return;
    const clamped = active ? clamp(intensity, 0.05, 1) : 0;
    if (rt.active === active && Math.abs(rt.targetIntensity - clamped) < 1e-4) return;
    rt.active = active;
    rt.targetIntensity = clamped;
    this.needsMatrixPack = true;
  }

  isActive(id: string): boolean {
    return this.emitters.get(id)?.active ?? false;
  }

  /** Smooth `0..1` warm steam accumulation level for Agent A6's `setZoneSteamLevel`. */
  getSteamLevel(id: string): number {
    return this.emitters.get(id)?.steamLevel ?? 0;
  }

  /** Highest active steam level across all registered bathroom shower emitters (`0..1`). */
  getMaxSteamLevel(): number {
    let best = 0;
    for (const rt of this.emitters.values()) {
      if (rt.steamLevel > best) best = rt.steamLevel;
    }
    return best;
  }

  /** Advances flow/steam envelopes and updates GPU uniforms (zero allocations, 0 cost when all showers are idle). */
  update(dt: number, reducedMotion = false): void {
    if (this.disposed || !this.emitters.size) return;
    const safeDt = clamp(dt, 0, 0.1);

    let anyFlowOrSteam = false;
    let levelChanged = false;

    for (const rt of this.emitters.values()) {
      const prevFlow = rt.flowLevel;
      const prevSteam = rt.steamLevel;

      if (rt.active && rt.targetIntensity > 0) {
        rt.flowLevel = Math.min(rt.targetIntensity, rt.flowLevel + safeDt * FLOW_RAMP_UP_PER_SEC);
        rt.steamLevel = Math.min(rt.targetIntensity, rt.steamLevel + safeDt * STEAM_RAMP_UP_PER_SEC * rt.targetIntensity);
      } else {
        rt.flowLevel = Math.max(0, rt.flowLevel - safeDt * FLOW_RAMP_DOWN_PER_SEC);
        rt.steamLevel = Math.max(0, rt.steamLevel - safeDt * STEAM_RAMP_DOWN_PER_SEC);
      }

      if (Math.abs(rt.flowLevel - prevFlow) > 1e-4 || Math.abs(rt.steamLevel - prevSteam) > 1e-4 || rt.dirtyGeometry) {
        levelChanged = true;
      }
      if (rt.flowLevel > 0.002 || rt.steamLevel > 0.002) {
        anyFlowOrSteam = true;
      }
    }

    if (!anyFlowOrSteam) {
      if (this.wasAnyVisible) {
        this.streamMesh.count = 0;
        this.splashMesh.count = 0;
        this.steamMesh.count = 0;
        this.group.visible = false;
        this.wasAnyVisible = false;
      }
      return;
    }

    this.group.visible = true;
    this.wasAnyVisible = true;
    if (!reducedMotion) {
      this.time = (this.time + safeDt) % 3600;
    }
    const reducedVal = reducedMotion ? 1 : 0;
    this.streamMat.uniforms.uTime.value = this.time;
    this.streamMat.uniforms.uReduced.value = reducedVal;
    this.splashMat.uniforms.uTime.value = this.time;
    this.splashMat.uniforms.uReduced.value = reducedVal;
    this.steamMat.uniforms.uTime.value = this.time;
    this.steamMat.uniforms.uReduced.value = reducedVal;

    if (!levelChanged && !this.needsMatrixPack) return;
    this.packInstances();
    this.needsMatrixPack = false;
  }

  private packInstances(): void {
    const streamArr = this.streamParamAttr.array as Float32Array;
    const splashParamArr = this.splashParamAttr.array as Float32Array;
    const splashDriftArr = this.splashDriftAttr.array as Float32Array;
    const steamArr = this.steamParamAttr.array as Float32Array;

    let streamCount = 0;
    let splashCount = 0;
    let steamCount = 0;

    for (const rt of this.emitters.values()) {
      rt.dirtyGeometry = false;

      if (rt.flowLevel > 0.002) {
        const streams = rt.streams;
        for (let i = 0; i < streams.length && streamCount < MAX_STREAMS; i++) {
          const s = streams[i];
          this.tmpPos.set(s.topX, s.topY, s.topZ);
          this.tmpBot.set(s.botX, s.botY, s.botZ);
          this.tmpDir.subVectors(this.tmpBot, this.tmpPos);
          const len = Math.max(0.05, this.tmpDir.length());
          this.tmpDir.multiplyScalar(1 / len);
          this.tmpQuat.setFromUnitVectors(this.tmpUp, this.tmpDir);
          this.tmpScale.set(s.widthScale, len, s.widthScale);
          this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
          this.streamMesh.setMatrixAt(streamCount, this.tmpMat);
          streamArr[streamCount * 2] = s.seed;
          streamArr[streamCount * 2 + 1] = rt.flowLevel;
          streamCount++;
        }

        const splashes = rt.splashes;
        this.tmpQuat.identity();
        this.tmpScale.set(1, 1, 1);
        for (let i = 0; i < splashes.length && splashCount < MAX_SPLASHES; i++) {
          const sp = splashes[i];
          this.tmpPos.set(sp.x, sp.y, sp.z);
          this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
          this.splashMesh.setMatrixAt(splashCount, this.tmpMat);
          const o4 = splashCount * 4;
          splashParamArr[o4] = sp.seed;
          splashParamArr[o4 + 1] = sp.height * rt.flowLevel;
          splashParamArr[o4 + 2] = 0.016 + sp.seed * 0.012;
          splashParamArr[o4 + 3] = rt.flowLevel;
          splashDriftArr[splashCount * 2] = sp.driftX;
          splashDriftArr[splashCount * 2 + 1] = sp.driftZ;
          splashCount++;
        }
      }

      if (rt.steamLevel > 0.002) {
        const steams = rt.steams;
        this.tmpQuat.identity();
        this.tmpScale.set(1, 1, 1);
        for (let i = 0; i < steams.length && steamCount < MAX_STEAM; i++) {
          const st = steams[i];
          this.tmpPos.set(st.x, st.minY, st.z);
          this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
          this.steamMesh.setMatrixAt(steamCount, this.tmpMat);
          const o4 = steamCount * 4;
          steamArr[o4] = st.seed;
          steamArr[o4 + 1] = Math.max(0.25, st.maxY - st.minY);
          steamArr[o4 + 2] = st.radius;
          steamArr[o4 + 3] = rt.steamLevel;
          steamCount++;
        }
      }
    }

    this.streamMesh.count = streamCount;
    this.splashMesh.count = splashCount;
    this.steamMesh.count = steamCount;

    if (streamCount > 0) {
      this.streamMesh.instanceMatrix.clearUpdateRanges();
      this.streamMesh.instanceMatrix.addUpdateRange(0, streamCount * 16);
      this.streamMesh.instanceMatrix.needsUpdate = true;
      this.streamParamAttr.clearUpdateRanges();
      this.streamParamAttr.addUpdateRange(0, streamCount * 2);
      this.streamParamAttr.needsUpdate = true;
    }
    if (splashCount > 0) {
      this.splashMesh.instanceMatrix.clearUpdateRanges();
      this.splashMesh.instanceMatrix.addUpdateRange(0, splashCount * 16);
      this.splashMesh.instanceMatrix.needsUpdate = true;
      this.splashParamAttr.clearUpdateRanges();
      this.splashParamAttr.addUpdateRange(0, splashCount * 4);
      this.splashParamAttr.needsUpdate = true;
      this.splashDriftAttr.clearUpdateRanges();
      this.splashDriftAttr.addUpdateRange(0, splashCount * 2);
      this.splashDriftAttr.needsUpdate = true;
    }
    if (steamCount > 0) {
      this.steamMesh.instanceMatrix.clearUpdateRanges();
      this.steamMesh.instanceMatrix.addUpdateRange(0, steamCount * 16);
      this.steamMesh.instanceMatrix.needsUpdate = true;
      this.steamParamAttr.clearUpdateRanges();
      this.steamParamAttr.addUpdateRange(0, steamCount * 4);
      this.steamParamAttr.needsUpdate = true;
    }
  }

  /**
   * Stage-6 `1x1`-scissored prewarm (`count = 1` across stream, splash, and steam layers)
   * guaranteeing `programDelta === 0` when the player activates a walk-in shower.
   */
  warmup(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    camera: T.Camera,
    target?: T.WebGLRenderTarget | null,
  ): void {
    if (this.disposed) return;

    const savedGroupVis = this.group.visible;
    const savedParent = this.group.parent;
    const savedStreamCount = this.streamMesh.count;
    const savedSplashCount = this.splashMesh.count;
    const savedSteamCount = this.steamMesh.count;

    const streamArr = this.streamParamAttr.array as Float32Array;
    const splashArr = this.splashParamAttr.array as Float32Array;
    const steamArr = this.steamParamAttr.array as Float32Array;

    const s0 = streamArr[0], s1 = streamArr[1];
    const sp0 = splashArr[0], sp1 = splashArr[1], sp2 = splashArr[2], sp3 = splashArr[3];
    const st0 = steamArr[0], st1 = steamArr[1], st2 = steamArr[2], st3 = steamArr[3];

    const savedStreamM = new T.Matrix4();
    const savedSplashM = new T.Matrix4();
    const savedSteamM = new T.Matrix4();
    this.streamMesh.getMatrixAt(0, savedStreamM);
    this.splashMesh.getMatrixAt(0, savedSplashM);
    this.steamMesh.getMatrixAt(0, savedSteamM);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevScissorTest = renderer.getScissorTest();
    renderer.getViewport(this.savedViewport);
    renderer.getScissor(this.savedScissor);

    const dst = target !== undefined ? target : prevTarget;
    const savedRtScissor = dst ? dst.scissor.clone() : null;
    const savedRtScissorTest = dst ? dst.scissorTest : false;

    const warmScene = new T.Scene();
    warmScene.environment = scene.environment;
    warmScene.fog = scene.fog;

    try {
      this.tmpPos.set(0, -1000, 0);
      this.tmpQuat.identity();
      this.tmpScale.set(0.001, 0.001, 0.001);
      this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);

      this.streamMesh.setMatrixAt(0, this.tmpMat);
      this.splashMesh.setMatrixAt(0, this.tmpMat);
      this.steamMesh.setMatrixAt(0, this.tmpMat);
      this.streamMesh.instanceMatrix.needsUpdate = true;
      this.splashMesh.instanceMatrix.needsUpdate = true;
      this.steamMesh.instanceMatrix.needsUpdate = true;

      streamArr[0] = 0.5; streamArr[1] = 1;
      splashArr[0] = 0.5; splashArr[1] = 0.05; splashArr[2] = 0.01; splashArr[3] = 1;
      steamArr[0] = 0.5; steamArr[1] = 1; steamArr[2] = 0.1; steamArr[3] = 1;
      this.streamParamAttr.needsUpdate = true;
      this.splashParamAttr.needsUpdate = true;
      this.steamParamAttr.needsUpdate = true;

      this.streamMesh.count = 1;
      this.splashMesh.count = 1;
      this.steamMesh.count = 1;
      this.group.visible = true;
      warmScene.add(this.group);

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
      renderer.compile(warmScene, camera);
      renderer.render(warmScene, camera);
    } finally {
      warmScene.remove(this.group);
      if (savedParent) savedParent.add(this.group);

      this.streamMesh.setMatrixAt(0, savedStreamM);
      this.splashMesh.setMatrixAt(0, savedSplashM);
      this.steamMesh.setMatrixAt(0, savedSteamM);
      this.streamMesh.instanceMatrix.needsUpdate = true;
      this.splashMesh.instanceMatrix.needsUpdate = true;
      this.steamMesh.instanceMatrix.needsUpdate = true;

      streamArr[0] = s0; streamArr[1] = s1;
      splashArr[0] = sp0; splashArr[1] = sp1; splashArr[2] = sp2; splashArr[3] = sp3;
      steamArr[0] = st0; steamArr[1] = st1; steamArr[2] = st2; steamArr[3] = st3;
      this.streamParamAttr.needsUpdate = true;
      this.splashParamAttr.needsUpdate = true;
      this.steamParamAttr.needsUpdate = true;

      this.streamMesh.count = savedStreamCount;
      this.splashMesh.count = savedSplashCount;
      this.steamMesh.count = savedSteamCount;
      this.group.visible = savedGroupVis;

      if (dst && savedRtScissor) {
        dst.scissor.copy(savedRtScissor);
        dst.scissorTest = savedRtScissorTest;
      }
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.setViewport(this.savedViewport);
      renderer.setScissor(this.savedScissor);
      renderer.setScissorTest(prevScissorTest);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.emitters.clear();
    this.group.parent?.remove(this.group);
    this.streamMesh.geometry.dispose();
    this.streamMat.dispose();
    this.streamMesh.dispose();
    this.splashMesh.geometry.dispose();
    this.splashMat.dispose();
    this.splashMesh.dispose();
    this.steamMesh.geometry.dispose();
    this.steamMat.dispose();
    this.steamMesh.dispose();
  }
}
