/**
 * Project ECHO ARCHIPELAGO — Phase 2 Natural Terrain-Conforming Waterfall & Hydrology System
 * (`green_mountain`: Summit Basalt Spring -> Upper Carved Stream -> Newtonian Ballistic Waterfall
 * -> Boulder-Dammed Receiving Plunge Pool -> Stepped Rainforest Brook -> Coastal Ocean Outflow).
 *
 * Guarantees:
 * - 100% terrain-conforming via live `sampleGround(x, z)` queries across left/center/right stations.
 * - Zero floating water ribbons or hovering horizontal pool discs from any 360° camera angle.
 * - Zero new external `.glb` files or WASM decoders (`464/464` provenance intact).
 * - Pinned `customProgramCacheKey` across all custom materials (`'arena-waterfall-sheet-v2'`,
 *   `'arena-waterfall-pool-v2'`, `'arena-waterfall-mist-v2'`) + `warmup()` for `programDelta === 0`.
 * - Zero per-frame heap allocations (`0` GC in `update()`).
 */

import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH, acceleratedRaycast, disposeBoundsTree } from 'three-mesh-bvh';
import type { ArenaQualityTier, ArenaTimeOfDay } from './arenaContracts';
import { ARENA_ATMOSPHERE_PRESETS } from './arenaQuality';
import { ARENA_WATER_Y, arenaBathymetry } from './arenaTerrain';

export interface ArenaRiverExclusionPoint {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

export type HydrologyStageKind =
  | 'spring'
  | 'upper_stream'
  | 'waterfall'
  | 'plunge_pool'
  | 'lower_brook'
  | 'ocean_mouth';

export interface HydrologyStationRecord {
  readonly stage: HydrologyStageKind;
  readonly x: number;
  readonly z: number;
  readonly waterY: number;
  readonly minGroundY: number;
  readonly maxGroundY: number;
  readonly leftBankTopY: number;
  readonly rightBankTopY: number;
  readonly bankBottomY: number;
  readonly halfWidth: number;
}

export interface ArenaWaterfallOptions {
  parentGroup: T.Object3D;
  rockGroup?: T.Object3D;
  quality: ArenaQualityTier;
  timeOfDay: ArenaTimeOfDay;
  sampleGround: (x: number, z: number, outNormal?: T.Vector3) => number;
  onOceanOutflowSplash?: (x: number, z: number, strength: number) => void;
}

export interface ArenaWaterfallSystem {
  readonly waterfallPos: T.Vector3;
  readonly oceanOutflowPos: T.Vector3;
  readonly riverExclusionPoints: ReadonlyArray<ArenaRiverExclusionPoint>;
  readonly stations: ReadonlyArray<HydrologyStationRecord>;
  readonly rockMesh: T.Mesh;
  update(time: number, dt: number, camera?: T.Camera): void;
  setQuality(tier: ArenaQualityTier): void;
  setTimeOfDay(tod: ArenaTimeOfDay): void;
  warmup(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera): void;
  dispose(): void;
}

// ============================================================================
// Deterministic PRNG & Procedural Wet-Basalt Normal / Roughness Maps
// ============================================================================

function makeSeededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashPeriodic(x: number, y: number, per: number, seed: number): number {
  const wx = ((x % per) + per) % per;
  const wy = ((y % per) + per) % per;
  const n = Math.sin(wx * 127.1 + wy * 311.7 + seed * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function noisePeriodic(u: number, v: number, per: number, seed: number): number {
  const x = u * per;
  const y = v * per;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hashPeriodic(ix, iy, per, seed);
  const b = hashPeriodic(ix + 1, iy, per, seed);
  const c = hashPeriodic(ix, iy + 1, per, seed);
  const d = hashPeriodic(ix + 1, iy + 1, per, seed);
  return a + (b - a) * fx + (c - a + (a - b - c + d) * fx) * fy;
}

function buildBasaltMaps(): { normalMap: T.DataTexture; roughnessMap: T.DataTexture } {
  const S = 128;
  const heights = new Float32Array(S * S);
  const rghBytes = new Uint8Array(S * S * 4);
  const nrmBytes = new Uint8Array(S * S * 4);

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const n1 = noisePeriodic(u, v, 7, 11);
      const n2 = noisePeriodic(u, v, 19, 23);
      const n3 = noisePeriodic(u, v, 43, 37);
      const crack = Math.abs(n2 - 0.5) * 2;
      const h = n1 * 0.52 + crack * 0.31 + n3 * 0.17;
      heights[y * S + x] = h;

      // Wet basalt / moss roughness variation (0.28 glossy wet stone .. 0.84 mossy crown)
      const rgh = T.MathUtils.clamp(0.32 + h * 0.46, 0.24, 0.88);
      const rv = Math.round(rgh * 255);
      const o = (y * S + x) * 4;
      rghBytes[o] = rv;
      rghBytes[o + 1] = rv;
      rghBytes[o + 2] = rv;
      rghBytes[o + 3] = 255;
    }
  }

  const strength = 2.15;
  for (let y = 0; y < S; y++) {
    const ym = (y - 1 + S) % S;
    const yp = (y + 1) % S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S;
      const xp = (x + 1) % S;
      const dx = (heights[y * S + xp] - heights[y * S + xm]) * strength;
      const dy = (heights[yp * S + x] - heights[ym * S + x]) * strength;
      const invLen = 1 / Math.hypot(dx, dy, 1);
      const o = (y * S + x) * 4;
      nrmBytes[o] = Math.round((-dx * invLen * 0.5 + 0.5) * 255);
      nrmBytes[o + 1] = Math.round((-dy * invLen * 0.5 + 0.5) * 255);
      nrmBytes[o + 2] = Math.round((invLen * 0.5 + 0.5) * 255);
      nrmBytes[o + 3] = 255;
    }
  }

  const normalMap = new T.DataTexture(nrmBytes, S, S, T.RGBAFormat, T.UnsignedByteType);
  normalMap.wrapS = normalMap.wrapT = T.RepeatWrapping;
  normalMap.minFilter = T.LinearMipmapLinearFilter;
  normalMap.magFilter = T.LinearFilter;
  normalMap.generateMipmaps = true;
  normalMap.needsUpdate = true;

  const roughnessMap = new T.DataTexture(rghBytes, S, S, T.RGBAFormat, T.UnsignedByteType);
  roughnessMap.wrapS = roughnessMap.wrapT = T.RepeatWrapping;
  roughnessMap.minFilter = T.LinearMipmapLinearFilter;
  roughnessMap.magFilter = T.LinearFilter;
  roughnessMap.generateMipmaps = true;
  roughnessMap.needsUpdate = true;

  return { normalMap, roughnessMap };
}

// ============================================================================
// Custom WebGL2 Shaders (Pinned Cache Keys, Natural Tropical Sunlit Optics)
// ============================================================================

const WATER_SHEET_VERT = /* glsl */ `
  attribute vec4 aFlowMeta;
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec4 vFlowMeta;

  uniform float uTime;

  void main() {
    vUv = uv;
    vFlowMeta = aFlowMeta;

    vec3 pos = position;
    float stageKind = aFlowMeta.x;
    float flowSpeed = aFlowMeta.y;
    float turb = aFlowMeta.z;
    float edgeMask = sin(clamp(uv.x, 0.0, 1.0) * 3.14159265);

    if (stageKind > 0.5 && stageKind < 2.5) {
      // Stage 3 ballistic waterfall curtain subtle micro-flutter (zero lip detachment at uv.y == 0!)
      float fallProgress = clamp(uv.y, 0.0, 1.0);
      float env = smoothstep(0.0, 0.16, fallProgress) * (0.45 + 0.55 * fallProgress);
      float waveA = sin(uv.y * 15.0 - uTime * (6.2 + flowSpeed) + uv.x * 5.0);
      float waveB = cos(uv.y * 23.0 - uTime * (8.4 + flowSpeed * 1.2) - uv.x * 7.5);
      float amp = (stageKind > 1.5 ? 0.065 : 0.036) * env * (0.35 + 0.65 * edgeMask);
      pos += normal * (waveA * 0.65 + waveB * 0.35) * amp;
    } else if (stageKind < 0.5) {
      // Stage 2 & 5 stream/brook riffle surface micro-undulation (pinned to 0 at bank edges!)
      float ripple = sin(uv.y * 26.0 - uTime * (4.5 + flowSpeed * 1.4) + uv.x * 6.2) * 0.014 * (0.4 + turb) * edgeMask;
      pos.y += ripple;
    }

    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const WATER_SHEET_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec4 vFlowMeta;

  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uSunsetMix;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbmFlow(vec2 p) {
    float s = 0.0;
    float amp = 0.52;
    for (int i = 0; i < 3; i++) {
      s += amp * vnoise(p);
      p = p * 2.07 + vec2(13.7, -7.3);
      amp *= 0.5;
    }
    return s;
  }

  void main() {
    float stageKind = vFlowMeta.x;
    float speed = vFlowMeta.y;
    float turb = vFlowMeta.z;
    float edgeSoft = vFlowMeta.w;

    float edgeSin = sin(clamp(vUv.x, 0.0, 1.0) * 3.14159265);
    float edgeFade = pow(clamp(edgeSin, 0.0, 1.0), edgeSoft);

    // Downhill flow coordinates: vUv.y increases downstream, so subtracting uTime scrolls downstream (+vUv.y)
    float stretchY = stageKind > 0.5 && stageKind < 2.5 ? 2.4 : 5.2;
    vec2 uvA = vec2(vUv.x * 5.2, vUv.y * stretchY - uTime * speed);
    vec2 uvB = vec2(vUv.x * 10.6 + 1.9, vUv.y * (stretchY * 1.85) - uTime * (speed * 1.42));

    float f1 = fbmFlow(uvA * 2.4);
    float f2 = fbmFlow(uvB * 3.1);
    float filaments = smoothstep(0.42, 0.84, f1 * 0.60 + f2 * 0.52);

    // Perturb surface normal from flow gradients for crisp sunlit specular glints
    vec3 N = normalize(vWorldNormal);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 perturb = normalize(vec3((f1 - 0.5) * 0.42, 1.0, (f2 - 0.5) * 0.42));
    N = normalize(mix(N, perturb, 0.32));

    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.4);
    float ndl = max(dot(N, uSunDir), 0.0);
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 72.0) * (0.45 + 0.55 * (1.0 - turb * 0.4));

    // Physically grounded tropical rainforest stream & waterfall palette (deep mossy jade -> sunlit teal -> aerated foam)
    vec3 deepMossTeal = mix(vec3(0.055, 0.235, 0.245), vec3(0.075, 0.195, 0.225), uSunsetMix);
    vec3 sunlitTurquoise = mix(vec3(0.115, 0.445, 0.485), vec3(0.205, 0.395, 0.435), uSunsetMix);
    vec3 foamWhite = mix(vec3(0.91, 0.965, 0.975), vec3(0.985, 0.865, 0.755), uSunsetMix * 0.58);

    float foamWeight = clamp(filaments * (0.42 + 0.58 * turb), 0.0, 1.0);
    float alpha = 0.82;

    if (stageKind > 0.5 && stageKind < 1.5) {
      // Stage 3 Inner Aerated Waterfall Core
      float lipAccel = smoothstep(0.0, 0.22, vUv.y);
      float plungeBoil = smoothstep(0.76, 1.0, vUv.y) * 0.58;
      foamWeight = clamp(0.28 + filaments * 0.56 + lipAccel * 0.16 + plungeBoil, 0.0, 1.0);
      alpha = clamp((0.76 + foamWeight * 0.20) * pow(edgeSin, 0.42), 0.0, 0.95);
    } else if (stageKind >= 1.5 && stageKind < 2.5) {
      // Stage 3 Outer Whitewater Spray Curtain
      float sprayRibbons = smoothstep(0.36, 0.86, f1 * 0.55 + f2 * 0.62);
      float bottomMist = smoothstep(0.70, 1.0, vUv.y) * 0.35;
      foamWeight = clamp(0.55 + sprayRibbons * 0.45, 0.0, 1.0);
      alpha = clamp((0.22 + sprayRibbons * 0.54 + bottomMist) * pow(edgeSin, 0.78), 0.0, 0.80);
    } else if (stageKind >= 2.5) {
      // Stage 5 Coastal River-Mouth Foam Fan blending seamlessly into the ocean
      float seaFade = 1.0 - smoothstep(0.18, 1.0, vUv.y);
      float lace = smoothstep(0.46, 0.82, f1 * 0.58 + f2 * 0.54);
      foamWeight = clamp(lace * (0.55 + 0.35 * seaFade), 0.0, 1.0);
      alpha = clamp((0.18 + lace * 0.56) * seaFade * edgeFade, 0.0, 0.78);
    } else {
      // Stage 2 Upper Stream & Stage 5 Lower Cascading Brook
      float bankFoam = (1.0 - smoothstep(0.0, 0.28, edgeSin)) * 0.28 * (0.4 + turb);
      foamWeight = clamp(filaments * (0.24 + 0.62 * turb) + bankFoam, 0.0, 0.96);
      alpha = clamp((0.78 + foamWeight * 0.16) * edgeFade, 0.0, 0.94);
    }

    vec3 bodyCol = mix(deepMossTeal, sunlitTurquoise, 0.35 + 0.55 * ndl);
    bodyCol = mix(bodyCol, uSkyColor * 0.72, fresnel * 0.44);
    vec3 litFoam = foamWhite * (0.68 + 0.38 * ndl) + uSunColor * (0.12 * foamWeight);
    vec3 col = mix(bodyCol, litFoam, foamWeight) + uSunColor * spec * 0.68;

    // Scene-matched exponential-squared atmospheric fog
    float dist = length(vWorldPos - cameraPosition);
    float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

    gl_FragColor = vec4(col, alpha);
  }
`;

const POOL_BASIN_VERT = /* glsl */ `
  attribute vec4 aPoolMeta;
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec4 vPoolMeta;

  uniform float uTime;

  void main() {
    vUv = uv;
    vPoolMeta = aPoolMeta;

    vec3 pos = position;
    float radialNorm = aPoolMeta.x;
    float impactProx = aPoolMeta.y;
    float rimPin = 1.0 - smoothstep(0.68, 0.98, radialNorm);

    // Subtle concentric impact wave height inside plunge pool / bubbling spring
    float wave = sin(radialNorm * 18.0 - uTime * 4.2) * 0.018 * rimPin * (0.35 + 0.65 * impactProx);
    pos.y += wave;

    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const POOL_BASIN_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec4 vPoolMeta;

  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uSunsetMix;
  uniform vec2 uImpactXZ;

  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    float radialNorm = clamp(vPoolMeta.x, 0.0, 1.0);
    float impactProx = clamp(vPoolMeta.y, 0.0, 1.0);
    float waterDepth = max(0.05, vPoolMeta.z);
    float isPlunge = vPoolMeta.w;

    vec2 worldXZ = vWorldPos.xz;
    float impDist = length(worldXZ - uImpactXZ);

    // Concentric ripples radiating from waterfall impact (Stage 4) or spring upwell (Stage 1)
    float ripplePhase = isPlunge > 0.5
      ? sin(impDist * 7.5 - uTime * 5.6) * exp(-impDist * 0.34)
      : sin(radialNorm * 16.0 - uTime * 3.8) * (1.0 - radialNorm);

    float n1 = vnoise(worldXZ * 2.1 + vec2(0.0, uTime * 0.65));
    float n2 = vnoise(worldXZ * 4.7 - vec2(uTime * 0.45, uTime * 0.85));
    float swirl = n1 * 0.58 + n2 * 0.42;

    vec3 N = normalize(vec3(
      (n1 - 0.5) * 0.24 + ripplePhase * 0.18,
      1.0,
      (n2 - 0.5) * 0.24 + ripplePhase * 0.18
    ));
    vec3 V = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.6);
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 96.0);
    float ndl = max(dot(N, uSunDir), 0.0);

    // Beer-Lambert natural depth gradient: mossy shallow stone rim -> deep emerald-jade basin center
    float depthFactor = 1.0 - exp(-waterDepth * 1.45);
    vec3 shallowMoss = mix(vec3(0.085, 0.255, 0.225), vec3(0.125, 0.225, 0.205), uSunsetMix);
    vec3 deepJade = mix(vec3(0.038, 0.215, 0.255), vec3(0.055, 0.175, 0.225), uSunsetMix);
    vec3 sunlitEmerald = mix(vec3(0.095, 0.405, 0.435), vec3(0.185, 0.355, 0.395), uSunsetMix);

    vec3 waterCol = mix(shallowMoss, mix(deepJade, sunlitEmerald, 0.38 + 0.45 * ndl), depthFactor);
    waterCol = mix(waterCol, uSkyColor * 0.76, fresnel * 0.52);

    // Aerated whitewater plunge boil ring & drifting foam lace
    float boilRing = 0.0;
    if (isPlunge > 0.5) {
      float coreBoil = smoothstep(2.35, 0.35, impDist) * (0.52 + 0.48 * swirl);
      float ringCrest = exp(-pow((impDist - 1.35) / 0.62, 2.0)) * smoothstep(0.35, 0.78, swirl);
      float rimLace = smoothstep(0.78, 0.96, radialNorm) * smoothstep(0.55, 0.85, swirl) * 0.24;
      boilRing = clamp(coreBoil + ringCrest * 0.68 + rimLace, 0.0, 0.95);
    } else {
      // Gentle bubbling mountain spring center upwell
      float upwell = (1.0 - smoothstep(0.0, 0.48, radialNorm)) * smoothstep(0.48, 0.84, swirl) * 0.45;
      boilRing = upwell;
    }

    vec3 foamCol = mix(vec3(0.90, 0.96, 0.97), vec3(0.98, 0.85, 0.73), uSunsetMix * 0.58) * (0.72 + 0.32 * ndl);
    vec3 col = mix(waterCol, foamCol, boilRing) + uSunColor * spec * (0.75 - boilRing * 0.45);

    float rimFeather = 1.0 - smoothstep(0.90, 1.0, radialNorm);
    float alpha = clamp((0.80 + depthFactor * 0.14 + boilRing * 0.12) * (0.65 + 0.35 * rimFeather), 0.0, 0.96);

    float dist = length(vWorldPos - cameraPosition);
    float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

    gl_FragColor = vec4(col, alpha);
  }
`;

const MIST_DROPLET_VERT = /* glsl */ `
  attribute vec3 aOrigin;
  attribute vec4 aSeed;
  attribute vec4 aParams;

  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  varying vec3 vWorldPos;

  uniform float uTime;
  uniform float uDistFade;

  void main() {
    vUv = uv;
    float kind = aParams.w;
    vKind = kind;

    float rate = aParams.y;
    float cycle = fract(uTime * rate + aSeed.x);
    vec3 center = aOrigin;
    float scale = aParams.x;

    if (kind < 0.5) {
      // Soft rising plunge mist puff
      float rise = cycle * aParams.z;
      float driftAngle = aSeed.y * 6.2831853 + uTime * 0.35;
      float radialSpread = (0.35 + cycle * 1.35) * aSeed.z;
      center.x += cos(driftAngle) * radialSpread;
      center.z += sin(driftAngle) * radialSpread + cycle * 0.45;
      center.y += rise;
      scale *= (0.65 + cycle * 1.15);
      vAlpha = sin(cycle * 3.14159265) * 0.30 * uDistFade;
    } else {
      // Ballistic splash droplet arc: y(t) = v0y * t - 0.5 * g * t^2
      float tArc = cycle * 0.78;
      float angle = aSeed.y * 6.2831853;
      float vHoriz = 0.85 + aSeed.z * 1.75;
      float vUp = 2.35 + aSeed.w * 1.85;
      center.x += cos(angle) * vHoriz * tArc;
      center.z += sin(angle) * vHoriz * tArc;
      center.y += max(-0.15, vUp * tArc - 4.905 * tArc * tArc);
      scale *= (1.0 - cycle * 0.35);
      vAlpha = (1.0 - cycle * cycle) * 0.68 * uDistFade;
    }

    // Camera-facing billboard quad
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec2 quad = (uv - 0.5) * 2.0 * scale;
    vec3 wp = center + camRight * quad.x + camUp * quad.y;
    vWorldPos = wp;

    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const MIST_DROPLET_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  varying vec3 vWorldPos;

  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uSunsetMix;

  void main() {
    vec2 d = (vUv - 0.5) * 2.0;
    float r2 = dot(d, d);
    if (r2 > 1.0 || vAlpha <= 0.002) discard;

    float radial = 1.0 - r2;
    float shape = vKind < 0.5 ? pow(radial, 2.2) : pow(radial, 1.35);
    float alpha = vAlpha * shape;

    vec3 baseMist = mix(vec3(0.88, 0.95, 0.97), vec3(0.98, 0.84, 0.72), uSunsetMix * 0.62);
    vec3 col = mix(uSkyColor * 0.85, baseMist, 0.72) + uSunColor * 0.08;

    float dist = length(vWorldPos - cameraPosition);
    float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

    gl_FragColor = vec4(col, alpha);
  }
`;

// ============================================================================
// Geometry Builders (Zero-WASM Procedural Basalt Boulders, Channels & Basins)
// ============================================================================

const QUALITY_MIST_COUNTS: Record<ArenaQualityTier, number> = {
  ultra: 64,
  high: 48,
  balanced: 28,
  low: 12,
};

interface ChannelStationInternal {
  readonly x: number;
  readonly z: number;
  readonly tx: number;
  readonly tz: number;
  readonly nx: number;
  readonly nz: number;
  readonly hw: number;
  readonly waterY: number;
  readonly minGroundY: number;
  readonly maxGroundY: number;
  readonly leftBankTopY: number;
  readonly rightBankTopY: number;
  readonly bankBottomY: number;
  readonly distAlong: number;
  readonly slope: number;
}

function createRockBoulderGeometry(
  detail: number,
  cx: number,
  bottomY: number,
  topY: number,
  cz: number,
  rx: number,
  rz: number,
  yaw: number,
  seed: number,
  waterRefY: number,
  mossBoost: number,
): T.BufferGeometry {
  const raw = new T.IcosahedronGeometry(1, detail);
  const g = raw.index ? raw.toNonIndexed() : raw;
  if (raw.index) raw.dispose();

  const height = Math.max(0.28, topY - bottomY);
  const midY = bottomY + height * 0.5;
  const halfH = height * 0.5;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);

  const pos = g.getAttribute('position') as T.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i);
    const ly = pos.getY(i);
    const lz = pos.getZ(i);

    // Organic faceted basalt crags with flatter mossy top crown and flared embedded base
    const nA = Math.sin(lx * 3.4 + seed * 1.7) * Math.cos(lz * 2.9 - seed * 1.3);
    const nB = Math.sin(ly * 4.8 + lx * 2.3 + seed * 2.9);
    const flare = ly < 0 ? 1.0 + (-ly) * 0.24 : 1.0 - ly * 0.08;
    const bump = (1.0 + 0.16 * nA + 0.08 * nB) * flare;

    const sx = lx * rx * bump;
    const sz = lz * rz * bump;
    // Clamp crown slightly so topY matches our exact engineered containment crest
    const clampedLy = ly > 0 ? Math.pow(ly, 0.82) : ly;
    const wy = midY + clampedLy * halfH;
    const wx = cx + sx * cosY - sz * sinY;
    const wz = cz + sx * sinY + sz * cosY;
    pos.setXYZ(i, wx, wy, wz);
  }

  g.computeVertexNormals();
  const nrm = g.getAttribute('normal') as T.BufferAttribute;
  const uvs = new Float32Array(pos.count * 2);
  const cols = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const wx = pos.getX(i);
    const wy = pos.getY(i);
    const wz = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));

    uvs[i * 2] = (ax > ay && ax > az ? wz : wx) * 0.42;
    uvs[i * 2 + 1] = (ay > ax && ay > az ? wz : wy) * 0.42;

    // Wetness darkening near/below water + lush emerald-olive moss on upward-facing dry crowns
    const aboveWater = wy - waterRefY;
    const wetness = 1.0 - T.MathUtils.smoothstep(aboveWater, -0.05, 0.58);
    const upFacing = T.MathUtils.clamp(nrm.getY(i), 0, 1);
    const moss = T.MathUtils.clamp(
      upFacing * T.MathUtils.smoothstep(aboveWater, 0.12, 0.72) * mossBoost,
      0,
      1,
    );
    const grain = 0.92 + 0.08 * Math.sin(wx * 1.9 + wz * 2.3 + seed);

    // Dry charcoal-grey basalt -> dark wet slate -> lush rainforest moss
    let r = T.MathUtils.lerp(0.36, 0.15, wetness);
    let gr = T.MathUtils.lerp(0.38, 0.17, wetness);
    let b = T.MathUtils.lerp(0.39, 0.19, wetness);

    r = T.MathUtils.lerp(r, 0.24, moss * 0.78);
    gr = T.MathUtils.lerp(gr, 0.44, moss * 0.82);
    b = T.MathUtils.lerp(b, 0.22, moss * 0.78);

    cols[i * 3] = r * grain;
    cols[i * 3 + 1] = gr * grain;
    cols[i * 3 + 2] = b * grain;
  }

  g.setAttribute('uv', new T.BufferAttribute(uvs, 2));
  g.setAttribute('color', new T.BufferAttribute(cols, 3));
  return g;
}

function buildStreambedTroughGeometry(stations: readonly ChannelStationInternal[]): T.BufferGeometry {
  const cols = 4;
  const rows = stations.length;
  const positions: number[] = [];
  const pushVert = (s: ChannelStationInternal, uIdx: number): [number, number, number] => {
    const offs = [-1.22, -0.52, 0.52, 1.22][uIdx] * s.hw;
    const depthDip = uIdx === 1 || uIdx === 2 ? -0.24 : 0.10;
    return [s.x + s.nx * offs, s.waterY + depthDip, s.z + s.nz * offs];
  };

  for (let j = 0; j < rows - 1; j++) {
    const s0 = stations[j];
    const s1 = stations[j + 1];
    for (let i = 0; i < cols - 1; i++) {
      const a = pushVert(s0, i);
      const b = pushVert(s0, i + 1);
      const c = pushVert(s1, i);
      const d = pushVert(s1, i + 1);
      positions.push(...a, ...c, ...b, ...b, ...c, ...d);
    }
  }

  const g = new T.BufferGeometry();
  const posArr = new Float32Array(positions);
  g.setAttribute('position', new T.BufferAttribute(posArr, 3));
  g.computeVertexNormals();

  const count = posArr.length / 3;
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const wx = posArr[i * 3];
    const wz = posArr[i * 3 + 2];
    uvs[i * 2] = wx * 0.5;
    uvs[i * 2 + 1] = wz * 0.5;
    // Submerged wet dark basalt/cobble streambed
    colors[i * 3] = 0.13;
    colors[i * 3 + 1] = 0.16;
    colors[i * 3 + 2] = 0.16;
  }
  g.setAttribute('uv', new T.BufferAttribute(uvs, 2));
  g.setAttribute('color', new T.BufferAttribute(colors, 3));
  return g;
}

function buildChannelWaterGeometry(
  stations: readonly ChannelStationInternal[],
  opts: {
    crossSegs: number;
    widthFactor: number;
    stageKindAt?: (idx: number, s: ChannelStationInternal) => number;
    flowSpeed: number;
    edgeSoftness: number;
  },
): T.BufferGeometry {
  const cols = opts.crossSegs + 1;
  const rows = stations.length;
  const vertCount = rows * cols;
  const posArr = new Float32Array(vertCount * 3);
  const uvArr = new Float32Array(vertCount * 2);
  const metaArr = new Float32Array(vertCount * 4);

  for (let j = 0; j < rows; j++) {
    const s = stations[j];
    const sk = opts.stageKindAt ? opts.stageKindAt(j, s) : 0;
    const turb = T.MathUtils.clamp(0.18 + s.slope * 2.1, 0.15, 1.0);
    for (let i = 0; i < cols; i++) {
      const u = i / opts.crossSegs;
      const lat = (u * 2 - 1) * s.hw * opts.widthFactor;
      const arch = Math.sin(u * Math.PI) * 0.012;
      const idx = j * cols + i;
      posArr[idx * 3] = s.x + s.nx * lat;
      posArr[idx * 3 + 1] = s.waterY + arch;
      posArr[idx * 3 + 2] = s.z + s.nz * lat;

      uvArr[idx * 2] = u;
      uvArr[idx * 2 + 1] = sk >= 2.5
        ? T.MathUtils.clamp((s.distAlong - stations[Math.max(0, rows - 8)].distAlong) / 3.2, 0, 1)
        : s.distAlong * 0.22;

      metaArr[idx * 4] = sk;
      metaArr[idx * 4 + 1] = opts.flowSpeed;
      metaArr[idx * 4 + 2] = turb;
      metaArr[idx * 4 + 3] = opts.edgeSoftness;
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < opts.crossSegs; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(posArr, 3));
  g.setAttribute('uv', new T.BufferAttribute(uvArr, 2));
  g.setAttribute('aFlowMeta', new T.BufferAttribute(metaArr, 4));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function buildBallisticWaterfallGeometry(params: {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  v0y: number;
  topHalfWidth: number;
  bottomHalfWidth: number;
  archDepth: number;
  forwardOffset: number;
  stageKind: number;
  flowSpeed: number;
  cols: number;
  rows: number;
}): T.BufferGeometry {
  const gAcc = 9.81;
  const dy = params.y0 - params.y1;
  // Exact quadratic flight time: 0.5 * g * t^2 - v0y * t - dy = 0
  const disc = Math.max(0.01, params.v0y * params.v0y + 2 * gAcc * dy);
  const tFlight = (params.v0y + Math.sqrt(disc)) / gAcc;

  const dx = params.x1 - params.x0;
  const dz = params.z1 - params.z0;
  const horizLen = Math.hypot(dx, dz) || 1;
  const fx = dx / horizLen;
  const fz = dz / horizLen;
  const rx = -fz;
  const rz = fx;
  const v0x = dx / tFlight;
  const v0z = dz / tFlight;

  const cCount = params.cols + 1;
  const rCount = params.rows + 1;
  const vertCount = rCount * cCount;
  const posArr = new Float32Array(vertCount * 3);
  const uvArr = new Float32Array(vertCount * 2);
  const metaArr = new Float32Array(vertCount * 4);

  for (let j = 0; j <= params.rows; j++) {
    const v = j / params.rows;
    const t = v * tFlight;
    const cx = params.x0 + v0x * t + fx * params.forwardOffset;
    const cy = params.y0 + params.v0y * t - 0.5 * gAcc * t * t;
    const cz = params.z0 + v0z * t + fz * params.forwardOffset;
    const hw = T.MathUtils.lerp(params.topHalfWidth, params.bottomHalfWidth, Math.pow(v, 0.85));

    for (let i = 0; i <= params.cols; i++) {
      const u = i / params.cols;
      const sLat = u * 2 - 1;
      const curveFwd = Math.cos(sLat * Math.PI * 0.5) * params.archDepth;
      const idx = j * cCount + i;

      posArr[idx * 3] = cx + rx * (sLat * hw) + fx * curveFwd;
      posArr[idx * 3 + 1] = cy;
      posArr[idx * 3 + 2] = cz + rz * (sLat * hw) + fz * curveFwd;

      uvArr[idx * 2] = u;
      uvArr[idx * 2 + 1] = v;

      metaArr[idx * 4] = params.stageKind;
      metaArr[idx * 4 + 1] = params.flowSpeed;
      metaArr[idx * 4 + 2] = T.MathUtils.clamp(0.45 + v * 0.55, 0, 1);
      metaArr[idx * 4 + 3] = params.stageKind > 1.5 ? 0.82 : 0.45;
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < params.rows; j++) {
    for (let i = 0; i < params.cols; i++) {
      const a = j * cCount + i;
      const b = a + 1;
      const c = a + cCount;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(posArr, 3));
  g.setAttribute('uv', new T.BufferAttribute(uvArr, 2));
  g.setAttribute('aFlowMeta', new T.BufferAttribute(metaArr, 4));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function buildBasinDiscGeometry(params: {
  cx: number;
  cz: number;
  waterY: number;
  rx: number;
  rz: number;
  maxDepth: number;
  isPlunge: boolean;
  impactX: number;
  impactZ: number;
  radialRings: number;
  angularSegs: number;
  lobeSeed: number;
}): { waterGeo: T.BufferGeometry; bedGeo: T.BufferGeometry } {
  const rings = params.radialRings;
  const segs = params.angularSegs;
  const stride = segs + 1;
  const vertCount = (rings + 1) * stride;

  const wPos = new Float32Array(vertCount * 3);
  const wUv = new Float32Array(vertCount * 2);
  const wMeta = new Float32Array(vertCount * 4);

  const bedVertices: number[] = [];
  const radiusScaleAt = (theta: number) =>
    1.0 +
    0.07 * Math.sin(theta * 3 + params.lobeSeed) +
    0.045 * Math.cos(theta * 5 - params.lobeSeed * 0.7);

  for (let rIdx = 0; rIdx <= rings; rIdx++) {
    const rNorm = rIdx / rings;
    for (let sIdx = 0; sIdx <= segs; sIdx++) {
      const theta = (sIdx / segs) * Math.PI * 2;
      const lobe = radiusScaleAt(theta);
      const wx = params.cx + Math.cos(theta) * params.rx * lobe * rNorm;
      const wz = params.cz + Math.sin(theta) * params.rz * lobe * rNorm;
      const idx = rIdx * stride + sIdx;

      wPos[idx * 3] = wx;
      wPos[idx * 3 + 1] = params.waterY;
      wPos[idx * 3 + 2] = wz;

      wUv[idx * 2] = 0.5 + 0.5 * Math.cos(theta) * rNorm;
      wUv[idx * 2 + 1] = 0.5 + 0.5 * Math.sin(theta) * rNorm;

      const depth = params.maxDepth * (1.0 - Math.pow(rNorm, 1.85)) + 0.14;
      const impDist = Math.hypot(wx - params.impactX, wz - params.impactZ);
      const impProx = 1.0 - T.MathUtils.clamp(impDist / 3.4, 0, 1);

      wMeta[idx * 4] = rNorm;
      wMeta[idx * 4 + 1] = impProx;
      wMeta[idx * 4 + 2] = depth;
      wMeta[idx * 4 + 3] = params.isPlunge ? 1.0 : 0.0;
    }
  }

  const indices: number[] = [];
  const bedPoint = (rNorm: number, theta: number): [number, number, number] => {
    const lobe = radiusScaleAt(theta);
    const rr = rNorm * 1.08;
    const wx = params.cx + Math.cos(theta) * params.rx * lobe * rr;
    const wz = params.cz + Math.sin(theta) * params.rz * lobe * rr;
    const wy =
      rNorm >= 0.99
        ? params.waterY + 0.14
        : params.waterY - params.maxDepth * (1.0 - Math.pow(rNorm, 1.75)) - 0.12;
    return [wx, wy, wz];
  };

  for (let rIdx = 0; rIdx < rings; rIdx++) {
    const r0 = rIdx / rings;
    const r1 = (rIdx + 1) / rings;
    for (let sIdx = 0; sIdx < segs; sIdx++) {
      const a = rIdx * stride + sIdx;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);

      const th0 = (sIdx / segs) * Math.PI * 2;
      const th1 = ((sIdx + 1) / segs) * Math.PI * 2;
      const pA = bedPoint(r0, th0);
      const pB = bedPoint(r0, th1);
      const pC = bedPoint(r1, th0);
      const pD = bedPoint(r1, th1);
      bedVertices.push(...pA, ...pB, ...pC, ...pB, ...pD, ...pC);
    }
  }

  const waterGeo = new T.BufferGeometry();
  waterGeo.setAttribute('position', new T.BufferAttribute(wPos, 3));
  waterGeo.setAttribute('uv', new T.BufferAttribute(wUv, 2));
  waterGeo.setAttribute('aPoolMeta', new T.BufferAttribute(wMeta, 4));
  waterGeo.setIndex(indices);
  waterGeo.computeVertexNormals();

  const bedGeo = new T.BufferGeometry();
  const bedPosArr = new Float32Array(bedVertices);
  bedGeo.setAttribute('position', new T.BufferAttribute(bedPosArr, 3));
  bedGeo.computeVertexNormals();
  const bCount = bedPosArr.length / 3;
  const bUvs = new Float32Array(bCount * 2);
  const bCols = new Float32Array(bCount * 3);
  for (let i = 0; i < bCount; i++) {
    bUvs[i * 2] = bedPosArr[i * 3] * 0.45;
    bUvs[i * 2 + 1] = bedPosArr[i * 3 + 2] * 0.45;
    bCols[i * 3] = 0.12;
    bCols[i * 3 + 1] = 0.15;
    bCols[i * 3 + 2] = 0.15;
  }
  bedGeo.setAttribute('uv', new T.BufferAttribute(bUvs, 2));
  bedGeo.setAttribute('color', new T.BufferAttribute(bCols, 3));

  return { waterGeo, bedGeo };
}

// ============================================================================
// Main 5-Stage Hydrological Builder
// ============================================================================

export function buildArenaWaterfallSystem(options: ArenaWaterfallOptions): ArenaWaterfallSystem {
  const { parentGroup, onOceanOutflowSplash } = options;
  const rockTargetGroup = options.rockGroup ?? parentGroup;
  let currentQuality: ArenaQualityTier = options.quality;
  let currentTod: ArenaTimeOfDay = options.timeOfDay;
  const isLowInit = currentQuality === 'low';
  const rockDetail = isLowInit ? 1 : 2;
  const cobbleDetail = 1;
  const rand = makeSeededRand(70291);

  const safeGround = (x: number, z: number): number => {
    const h = options.sampleGround(x, z);
    return Number.isFinite(h) ? h : arenaBathymetry(x, z);
  };

  const rockGeos: T.BufferGeometry[] = [];
  const exclusions: ArenaRiverExclusionPoint[] = [];
  const stationRecords: HydrologyStationRecord[] = [];
  const curvePt = new T.Vector3();
  const curveTan = new T.Vector3();

  // --------------------------------------------------------------------------
  // STAGE 1: Mountain Spring Source (`(-5.2, -219.2)` near summit of `green_mountain`)
  // Clear of Summit Pavilion `(-16, -228)`, `kiosk-mountain-summit` `(-13.5, -226.5)`,
  // and `bench-summit` `(-19, -222)`.
  // --------------------------------------------------------------------------
  const SPRING_X = -5.2;
  const SPRING_Z = -219.2;
  const SPRING_RX = 1.95;
  const SPRING_RZ = 1.75;
  const SPRING_OUT_ANGLE = Math.atan2(-216.8 - SPRING_Z, -3.4 - SPRING_X);

  let springMinRimG = Infinity;
  let springMaxRimG = -Infinity;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const gx = SPRING_X + Math.cos(a) * SPRING_RX;
    const gz = SPRING_Z + Math.sin(a) * SPRING_RZ;
    const gh = safeGround(gx, gz);
    if (gh < springMinRimG) springMinRimG = gh;
    if (gh > springMaxRimG) springMaxRimG = gh;
  }
  const springWaterY = springMinRimG + 0.12;
  exclusions.push({ x: SPRING_X, z: SPRING_Z, r: 3.5 });

  let springMinRimTop = Infinity;
  let springMinBottom = Infinity;
  const springRimCount = 18;
  for (let i = 0; i < springRimCount; i++) {
    const a = (i / springRimCount) * Math.PI * 2;
    const diffOut = Math.abs(Math.atan2(Math.sin(a - SPRING_OUT_ANGLE), Math.cos(a - SPRING_OUT_ANGLE)));
    const isOutletNotch = diffOut < 0.34;
    const rScale = 1.04 + (rand() - 0.5) * 0.08;
    const bx = SPRING_X + Math.cos(a) * SPRING_RX * rScale;
    const bz = SPRING_Z + Math.sin(a) * SPRING_RZ * rScale;
    const gHere = safeGround(bx, bz);
    const backFactor = T.MathUtils.smoothstep(diffOut, 0.55, 2.65);

    const bottomY = Math.min(gHere, springMinRimG) - 1.05;
    const topY = isOutletNotch
      ? springWaterY - 0.05
      : Math.max(springWaterY + 0.44 + backFactor * 1.15, gHere + 0.36 + backFactor * 0.95);
    const rx = isOutletNotch ? 0.52 : 0.68 + backFactor * 0.52 + rand() * 0.18;
    const rz = isOutletNotch ? 0.48 : 0.64 + backFactor * 0.46 + rand() * 0.16;

    if (!isOutletNotch && topY < springMinRimTop) springMinRimTop = topY;
    if (bottomY < springMinBottom) springMinBottom = bottomY;

    rockGeos.push(
      createRockBoulderGeometry(
        rockDetail,
        bx,
        bottomY,
        topY,
        bz,
        rx,
        rz,
        rand() * Math.PI * 2,
        10 + i * 3.1,
        springWaterY,
        0.95,
      ),
    );
  }

  // Towering mossy basalt headwall boulder crowning the back of the spring grotto
  {
    const hAngle = SPRING_OUT_ANGLE + Math.PI;
    const hx = SPRING_X + Math.cos(hAngle) * (SPRING_RX + 0.65);
    const hz = SPRING_Z + Math.sin(hAngle) * (SPRING_RZ + 0.65);
    const hg = safeGround(hx, hz);
    rockGeos.push(
      createRockBoulderGeometry(
        rockDetail,
        hx,
        hg - 1.25,
        Math.max(springWaterY + 1.95, hg + 1.65),
        hz,
        1.55,
        1.35,
        hAngle,
        99.4,
        springWaterY,
        1.0,
      ),
    );
  }

  const springBasinGeos = buildBasinDiscGeometry({
    cx: SPRING_X,
    cz: SPRING_Z,
    waterY: springWaterY,
    rx: SPRING_RX * 0.98,
    rz: SPRING_RZ * 0.98,
    maxDepth: 0.58,
    isPlunge: false,
    impactX: SPRING_X,
    impactZ: SPRING_Z,
    radialRings: isLowInit ? 5 : 8,
    angularSegs: isLowInit ? 18 : 28,
    lobeSeed: 2.3,
  });
  rockGeos.push(springBasinGeos.bedGeo);

  stationRecords.push({
    stage: 'spring',
    x: SPRING_X,
    z: SPRING_Z,
    waterY: springWaterY,
    minGroundY: springMinRimG,
    maxGroundY: springMaxRimG,
    leftBankTopY: springMinRimTop,
    rightBankTopY: springMinRimTop,
    bankBottomY: springMinBottom,
    halfWidth: SPRING_RX,
  });

  // --------------------------------------------------------------------------
  // STAGE 2: Upper Carved Stream Channel (`Spring Outlet -> Upper Cliff Lip`)
  // --------------------------------------------------------------------------
  const upperCurve = new T.CatmullRomCurve3([
    new T.Vector3(SPRING_X + Math.cos(SPRING_OUT_ANGLE) * (SPRING_RX * 0.88), 0, SPRING_Z + Math.sin(SPRING_OUT_ANGLE) * (SPRING_RZ * 0.88)),
    new T.Vector3(-2.6, 0, -215.8),
    new T.Vector3(0.2, 0, -212.5),
    new T.Vector3(3.1, 0, -209.0),
    new T.Vector3(5.1, 0, -206.1),
    new T.Vector3(6.0, 0, -203.9),
  ]);

  const UPPER_STATIONS_COUNT = isLowInit ? 22 : 34;
  const upperStations: ChannelStationInternal[] = [];
  let upperDist = 0;
  let prevUpperWaterY = springWaterY - 0.01;

  for (let i = 0; i <= UPPER_STATIONS_COUNT; i++) {
    const t = i / UPPER_STATIONS_COUNT;
    upperCurve.getPoint(t, curvePt);
    upperCurve.getTangent(t, curveTan);
    const tLen = Math.hypot(curveTan.x, curveTan.z) || 1;
    const tx = curveTan.x / tLen;
    const tz = curveTan.z / tLen;
    const nx = -tz;
    const nz = tx;

    const hw = T.MathUtils.lerp(0.76, 1.12, T.MathUtils.smoothstep(t, 0.0, 1.0));
    if (i > 0) {
      const prev = upperStations[i - 1];
      upperDist += Math.hypot(curvePt.x - prev.x, curvePt.z - prev.z);
    }

    let minG = Infinity;
    let maxG = -Infinity;
    for (const f of [-1, -0.5, 0, 0.5, 1]) {
      const gh = safeGround(curvePt.x + nx * hw * f, curvePt.z + nz * hw * f);
      if (gh < minG) minG = gh;
      if (gh > maxG) maxG = gh;
    }

    const targetY = i === 0 ? springWaterY - 0.015 : Math.min(prevUpperWaterY - 0.012, minG + 0.065);
    const waterY = Math.max(minG + 0.04, targetY);
    const slope = i > 0 ? Math.max(0, (upperStations[i - 1].waterY - waterY) / Math.max(0.2, upperDist - upperStations[i - 1].distAlong)) : 0.12;
    prevUpperWaterY = waterY;

    const gLeftBank = safeGround(curvePt.x - nx * (hw + 0.34), curvePt.z - nz * (hw + 0.34));
    const gRightBank = safeGround(curvePt.x + nx * (hw + 0.34), curvePt.z + nz * (hw + 0.34));
    const leftTop = Math.max(waterY + 0.34, gLeftBank + 0.28);
    const rightTop = Math.max(waterY + 0.34, gRightBank + 0.28);
    const bankBot = Math.min(minG, gLeftBank, gRightBank) - 0.85;

    const st: ChannelStationInternal = {
      x: curvePt.x,
      z: curvePt.z,
      tx,
      tz,
      nx,
      nz,
      hw,
      waterY,
      minGroundY: minG,
      maxGroundY: maxG,
      leftBankTopY: leftTop,
      rightBankTopY: rightTop,
      bankBottomY: bankBot,
      distAlong: upperDist,
      slope,
    };
    upperStations.push(st);

    stationRecords.push({
      stage: 'upper_stream',
      x: st.x,
      z: st.z,
      waterY: st.waterY,
      minGroundY: minG,
      maxGroundY: maxG,
      leftBankTopY: leftTop,
      rightBankTopY: rightTop,
      bankBottomY: bankBot,
      halfWidth: hw,
    });

    if (i % 3 === 0 || i === UPPER_STATIONS_COUNT) {
      exclusions.push({ x: st.x, z: st.z, r: hw + 1.25 });
    }

    // Continuous overlapping mossy bank boulders cradling both sides of the carved stream
    if (i % 2 === 0 || i === UPPER_STATIONS_COUNT) {
      for (const side of [-1, 1] as const) {
        const off = hw + 0.28 + (rand() - 0.5) * 0.08;
        const bx = st.x + nx * side * off;
        const bz = st.z + nz * side * off;
        const topY = (side < 0 ? leftTop : rightTop) + rand() * 0.16;
        rockGeos.push(
          createRockBoulderGeometry(
            cobbleDetail,
            bx,
            bankBot,
            topY,
            bz,
            0.56 + rand() * 0.22,
            0.68 + rand() * 0.24,
            Math.atan2(tx, tz) + (rand() - 0.5) * 0.5,
            200 + i * 7.3 + side * 2.1,
            waterY,
            0.9,
          ),
        );
      }
    }
  }

  rockGeos.push(buildStreambedTroughGeometry(upperStations));
  const upperStreamWaterGeo = buildChannelWaterGeometry(upperStations, {
    crossSegs: isLowInit ? 4 : 6,
    widthFactor: 1.12,
    flowSpeed: 2.35,
    edgeSoftness: 0.45,
  });

  // --------------------------------------------------------------------------
  // STAGE 4 (Computed before Stage 3 mesh so Stage 3 lands cleanly inside Pool!):
  // Enclosed Natural Receiving Plunge Pool (`center = (6.6, -195.7)`)
  // 100% clear of `table-6` `(3, -191)`, `kiosk-guided` `(11, -191)`, `bench-guided` `(8, -186)`.
  // --------------------------------------------------------------------------
  const POOL_X = 6.6;
  const POOL_Z = -195.7;
  const POOL_RX = 3.15;
  const POOL_RZ = 2.72;
  const IMPACT_X = 6.42;
  const IMPACT_Z = -196.95;
  const SPILLWAY_X = 9.65;
  const SPILLWAY_Z = -195.35;
  const SPILL_ANGLE = Math.atan2(SPILLWAY_Z - POOL_Z, SPILLWAY_X - POOL_X);

  let poolMinG = Infinity;
  let poolMaxG = -Infinity;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const gx = POOL_X + Math.cos(a) * POOL_RX;
    const gz = POOL_Z + Math.sin(a) * POOL_RZ;
    const gh = safeGround(gx, gz);
    if (gh < poolMinG) poolMinG = gh;
    if (gh > poolMaxG) poolMaxG = gh;
  }
  const centerPoolG = safeGround(POOL_X, POOL_Z);
  if (centerPoolG < poolMinG) poolMinG = centerPoolG;

  // Water surface sits naturally inside the rocky dam rim above the eastern spillway sill
  const poolWaterY = Math.max(poolMinG + 0.34, safeGround(SPILLWAY_X, SPILLWAY_Z) + 0.24);
  exclusions.push({ x: POOL_X, z: POOL_Z, r: 4.55 });
  exclusions.push({ x: IMPACT_X, z: IMPACT_Z - 2.2, r: 3.65 });

  // 360-degree mossy boulder dam & gravel berm embedded -1.45 m deep into the downhill slope
  let poolMinRimTop = Infinity;
  let poolMinBottom = Infinity;
  const poolRimCount = 28;
  for (let i = 0; i < poolRimCount; i++) {
    const a = (i / poolRimCount) * Math.PI * 2;
    const diffSpill = Math.abs(Math.atan2(Math.sin(a - SPILL_ANGLE), Math.cos(a - SPILL_ANGLE)));
    const isSpillNotch = diffSpill < 0.24;
    const lobe = 1.0 + 0.07 * Math.sin(a * 3 + 4.1) + 0.045 * Math.cos(a * 5 - 2.87);
    const bx = POOL_X + Math.cos(a) * POOL_RX * lobe * 1.03;
    const bz = POOL_Z + Math.sin(a) * POOL_RZ * lobe * 1.03;
    const gHere = safeGround(bx, bz);
    const cliffSide = T.MathUtils.smoothstep(-Math.sin(a), 0.15, 0.95);

    const bottomY = Math.min(gHere, poolMinG) - 1.45;
    const topY = isSpillNotch
      ? poolWaterY - 0.06
      : Math.max(poolWaterY + 0.38 + cliffSide * 0.95 + rand() * 0.28, gHere + 0.32 + cliffSide * 0.65);

    if (!isSpillNotch && topY < poolMinRimTop) poolMinRimTop = topY;
    if (bottomY < poolMinBottom) poolMinBottom = bottomY;

    rockGeos.push(
      createRockBoulderGeometry(
        rockDetail,
        bx,
        bottomY,
        topY,
        bz,
        isSpillNotch ? 0.56 : 0.78 + cliffSide * 0.38 + rand() * 0.22,
        isSpillNotch ? 0.54 : 0.74 + cliffSide * 0.34 + rand() * 0.20,
        a + (rand() - 0.5) * 0.6,
        500 + i * 5.7,
        poolWaterY,
        0.88,
      ),
    );
  }

  const plungeBasinGeos = buildBasinDiscGeometry({
    cx: POOL_X,
    cz: POOL_Z,
    waterY: poolWaterY,
    rx: POOL_RX,
    rz: POOL_RZ,
    maxDepth: 1.38,
    isPlunge: true,
    impactX: IMPACT_X,
    impactZ: IMPACT_Z,
    radialRings: isLowInit ? 7 : 12,
    angularSegs: isLowInit ? 24 : 40,
    lobeSeed: 4.1,
  });
  rockGeos.push(plungeBasinGeos.bedGeo);

  stationRecords.push({
    stage: 'plunge_pool',
    x: POOL_X,
    z: POOL_Z,
    waterY: poolWaterY,
    minGroundY: poolMinG,
    maxGroundY: poolMaxG,
    leftBankTopY: poolMinRimTop,
    rightBankTopY: poolMinRimTop,
    bankBottomY: poolMinBottom,
    halfWidth: POOL_RX,
  });

  // --------------------------------------------------------------------------
  // STAGE 3: Gravity-Driven Waterfall Sheet (`Cliff Lip -> Plunge Pool`)
  // Sculpted wet cliff-lip sill + cliff-backing basalt buttresses so the sheet
  // emerges directly from solid wet rock and plunges 0.36 m below `poolWaterY`.
  // --------------------------------------------------------------------------
  const lipStation = upperStations[upperStations.length - 1];
  const wfX0 = lipStation.x;
  const wfY0 = lipStation.waterY;
  const wfZ0 = lipStation.z;
  const wfX1 = IMPACT_X;
  const wfY1 = poolWaterY - 0.36;
  const wfZ1 = IMPACT_Z;

  // Wet basalt overhang sill directly beneath upper lip + stepped cliff-backing rock wall
  {
    const sillG = safeGround(wfX0, wfZ0);
    rockGeos.push(
      createRockBoulderGeometry(
        rockDetail,
        wfX0,
        sillG - 2.2,
        wfY0 - 0.03,
        wfZ0 + 0.18,
        1.55,
        1.15,
        0.12,
        811.2,
        wfY0,
        0.35,
      ),
    );

    const cliffSteps = 7;
    for (let k = 0; k <= cliffSteps; k++) {
      const f = k / cliffSteps;
      const cx = T.MathUtils.lerp(wfX0, wfX1, f);
      const cz = T.MathUtils.lerp(wfZ0 - 0.3, wfZ1 - 0.85, f);
      const cg = safeGround(cx, cz);
      const parabolaY = T.MathUtils.lerp(wfY0, poolWaterY, f * f);

      // Central wet cliff-backing basalt face tucked behind the falling water sheet
      if (k < cliffSteps) {
        rockGeos.push(
          createRockBoulderGeometry(
            rockDetail,
            cx + (rand() - 0.5) * 0.35,
            Math.min(cg, poolWaterY) - 2.1,
            Math.min(parabolaY - 0.18, Math.max(cg + 1.45, parabolaY - 0.25)),
            cz - 0.55,
            1.48 + rand() * 0.35,
            1.18 + rand() * 0.28,
            rand() * Math.PI,
            830 + k * 9.1,
            poolWaterY + 2.0,
            0.25,
          ),
        );
      }

      // Massive left & right flanking wet basalt cliff buttresses framing the cataract
      for (const side of [-1, 1] as const) {
        const lat = 1.68 + f * 0.48 + rand() * 0.22;
        const bx = cx + side * lat;
        const bz = cz + (rand() - 0.5) * 0.35;
        const bg = safeGround(bx, bz);
        const crestY = Math.max(parabolaY + 0.45 + (1 - f) * 0.55, bg + 0.55);
        rockGeos.push(
          createRockBoulderGeometry(
            rockDetail,
            bx,
            Math.min(bg, poolWaterY) - 2.0,
            crestY,
            bz,
            1.08 + rand() * 0.34,
            1.14 + rand() * 0.32,
            rand() * Math.PI * 2,
            860 + k * 13.7 + side * 4.3,
            parabolaY,
            0.65,
          ),
        );
      }

      stationRecords.push({
        stage: 'waterfall',
        x: cx,
        z: cz,
        waterY: parabolaY,
        minGroundY: cg,
        maxGroundY: cg,
        leftBankTopY: parabolaY + 0.45,
        rightBankTopY: parabolaY + 0.45,
        bankBottomY: Math.min(cg, poolWaterY) - 2.0,
        halfWidth: 1.35,
      });
    }
  }

  const wfCoreGeo = buildBallisticWaterfallGeometry({
    x0: wfX0,
    y0: wfY0,
    z0: wfZ0,
    x1: wfX1,
    y1: wfY1,
    z1: wfZ1,
    v0y: -0.65,
    topHalfWidth: lipStation.hw * 1.06,
    bottomHalfWidth: 1.48,
    archDepth: 0.24,
    forwardOffset: 0.0,
    stageKind: 1.0,
    flowSpeed: 3.15,
    cols: isLowInit ? 8 : 14,
    rows: isLowInit ? 18 : 30,
  });

  const wfVeilGeo = buildBallisticWaterfallGeometry({
    x0: wfX0,
    y0: wfY0 + 0.03,
    z0: wfZ0 + 0.04,
    x1: wfX1,
    y1: wfY1 + 0.08,
    z1: wfZ1 + 0.14,
    v0y: -0.55,
    topHalfWidth: lipStation.hw * 1.18,
    bottomHalfWidth: 1.78,
    archDepth: 0.34,
    forwardOffset: 0.10,
    stageKind: 2.0,
    flowSpeed: 3.75,
    cols: isLowInit ? 8 : 14,
    rows: isLowInit ? 18 : 30,
  });

  // --------------------------------------------------------------------------
  // STAGE 5: Lower Cascading Brook / River Outflow -> Ocean (`ARENA_WATER_Y = -1.2 m`)
  // Binary-searches exact coastline crossing along `x = 11.6` (cleanly between coastal
  // boulders `(7.73, -140.87)` and `(14.89, -141.08)` and 18 m east of Bridge #2).
  // --------------------------------------------------------------------------
  const MOUTH_X = 11.6;
  let zLo = -146.5; // dry land (> +1.2 m)
  let zHi = -138.0; // submerged seabed (< -2.5 m)
  for (let iter = 0; iter < 28; iter++) {
    const zMid = 0.5 * (zLo + zHi);
    if (safeGround(MOUTH_X, zMid) > ARENA_WATER_Y) {
      zLo = zMid;
    } else {
      zHi = zMid;
    }
  }
  const shorelineZ = 0.5 * (zLo + zHi);
  const fanEndZ = shorelineZ + 2.45;

  const lowerCurve = new T.CatmullRomCurve3([
    new T.Vector3(SPILLWAY_X, 0, SPILLWAY_Z),
    new T.Vector3(13.6, 0, -193.8),
    new T.Vector3(15.6, 0, -190.5),
    new T.Vector3(16.6, 0, -185.0),
    new T.Vector3(17.3, 0, -180.2),
    new T.Vector3(16.6, 0, -176.2),
    new T.Vector3(15.0, 0, -172.0),
    new T.Vector3(13.6, 0, -166.5),
    new T.Vector3(12.6, 0, -160.5),
    new T.Vector3(12.0, 0, -153.0),
    new T.Vector3(11.7, 0, -145.4),
    new T.Vector3(MOUTH_X, 0, shorelineZ - 1.15),
    new T.Vector3(MOUTH_X, 0, shorelineZ),
    new T.Vector3(MOUTH_X, 0, fanEndZ),
  ]);

  const LOWER_STATIONS_COUNT = isLowInit ? 52 : 78;
  const lowerStations: ChannelStationInternal[] = [];
  let lowerDist = 0;
  let prevLowerWaterY = poolWaterY - 0.04;
  const oceanSurfaceTargetY = ARENA_WATER_Y + 0.015;

  for (let i = 0; i <= LOWER_STATIONS_COUNT; i++) {
    const t = i / LOWER_STATIONS_COUNT;
    lowerCurve.getPoint(t, curvePt);
    lowerCurve.getTangent(t, curveTan);
    const tLen = Math.hypot(curveTan.x, curveTan.z) || 1;
    const tx = curveTan.x / tLen;
    const tz = curveTan.z / tLen;
    const nx = -tz;
    const nz = tx;

    const pastShore = curvePt.z >= shorelineZ - 0.05;
    const fanFrac = pastShore ? T.MathUtils.clamp((curvePt.z - shorelineZ) / Math.max(0.4, fanEndZ - shorelineZ), 0, 1) : 0;
    const hw = pastShore
      ? T.MathUtils.lerp(1.75, 3.25, fanFrac)
      : T.MathUtils.lerp(0.88, 1.75, Math.pow(t, 0.78));

    if (i > 0) {
      const prev = lowerStations[i - 1];
      lowerDist += Math.hypot(curvePt.x - prev.x, curvePt.z - prev.z);
    }

    let minG = Infinity;
    let maxG = -Infinity;
    for (const f of [-1, -0.5, 0, 0.5, 1]) {
      const gh = safeGround(curvePt.x + nx * hw * f, curvePt.z + nz * hw * f);
      if (gh < minG) minG = gh;
      if (gh > maxG) maxG = gh;
    }

    let waterY: number;
    if (pastShore) {
      waterY = oceanSurfaceTargetY;
    } else if (i === 0) {
      waterY = poolWaterY - 0.04;
    } else {
      const naturalY = Math.max(oceanSurfaceTargetY, minG + 0.06);
      waterY = Math.max(oceanSurfaceTargetY, Math.min(prevLowerWaterY - 0.002, naturalY));
      // Ensure water never dips beneath center terrain on piecewise-linear mesh facets
      const gCenter = safeGround(curvePt.x, curvePt.z);
      if (gCenter > ARENA_WATER_Y && waterY < gCenter + 0.025) {
        waterY = Math.min(prevLowerWaterY, gCenter + 0.035);
      }
    }
    const slope = i > 0 ? Math.max(0, (lowerStations[i - 1].waterY - waterY) / Math.max(0.2, lowerDist - lowerStations[i - 1].distAlong)) : 0.15;
    prevLowerWaterY = waterY;

    const gLeftBank = safeGround(curvePt.x - nx * (hw + 0.36), curvePt.z - nz * (hw + 0.36));
    const gRightBank = safeGround(curvePt.x + nx * (hw + 0.36), curvePt.z + nz * (hw + 0.36));
    const bankHeightBoost = pastShore ? 0.06 : 0.32;
    const leftTop = pastShore ? waterY + 0.04 : Math.max(waterY + bankHeightBoost, gLeftBank + 0.24);
    const rightTop = pastShore ? waterY + 0.04 : Math.max(waterY + bankHeightBoost, gRightBank + 0.24);
    const bankBot = Math.min(minG, gLeftBank, gRightBank) - 0.85;

    const st: ChannelStationInternal = {
      x: curvePt.x,
      z: curvePt.z,
      tx,
      tz,
      nx,
      nz,
      hw,
      waterY,
      minGroundY: minG,
      maxGroundY: maxG,
      leftBankTopY: leftTop,
      rightBankTopY: rightTop,
      bankBottomY: bankBot,
      distAlong: lowerDist,
      slope,
    };
    lowerStations.push(st);

    stationRecords.push({
      stage: pastShore ? 'ocean_mouth' : 'lower_brook',
      x: st.x,
      z: st.z,
      waterY: st.waterY,
      minGroundY: minG,
      maxGroundY: maxG,
      leftBankTopY: leftTop,
      rightBankTopY: rightTop,
      bankBottomY: bankBot,
      halfWidth: hw,
    });

    if (i % 3 === 0 || pastShore) {
      exclusions.push({ x: st.x, z: st.z, r: hw + 1.3 });
    }

    // Flanking mossy bank rocks & coastal river-mouth cobbles along every dry-land step
    if (!pastShore && (i % 2 === 0 || slope > 0.22)) {
      for (const side of [-1, 1] as const) {
        const coastalTaper = T.MathUtils.clamp((waterY - ARENA_WATER_Y) / 1.4, 0.28, 1.0);
        const off = hw + 0.26 + (rand() - 0.5) * 0.08;
        const bx = st.x + nx * side * off;
        const bz = st.z + nz * side * off;
        const topY = Math.max(
          waterY + 0.30 * coastalTaper + rand() * 0.14,
          (side < 0 ? leftTop : rightTop),
        );
        rockGeos.push(
          createRockBoulderGeometry(
            cobbleDetail,
            bx,
            bankBot,
            topY,
            bz,
            (0.54 + rand() * 0.26) * (0.7 + 0.3 * coastalTaper),
            (0.66 + rand() * 0.26) * (0.7 + 0.3 * coastalTaper),
            Math.atan2(tx, tz) + (rand() - 0.5) * 0.6,
            1200 + i * 6.1 + side * 3.7,
            waterY,
            0.85 * coastalTaper,
          ),
        );
      }

      // Occasional wet mid-stream riffle stepping stones on steeper cascades
      if (slope > 0.26 && i % 6 === 3) {
        const lat = (rand() - 0.5) * hw * 0.65;
        rockGeos.push(
          createRockBoulderGeometry(
            cobbleDetail,
            st.x + nx * lat,
            bankBot,
            waterY + 0.12 + rand() * 0.10,
            st.z + nz * lat,
            0.34 + rand() * 0.12,
            0.30 + rand() * 0.12,
            rand() * Math.PI * 2,
            1600 + i * 4.9,
            waterY,
            0.35,
          ),
        );
      }
    }
  }

  const dryLowerStations = lowerStations.filter((s) => s.z <= shorelineZ + 0.35);
  if (dryLowerStations.length >= 2) {
    rockGeos.push(buildStreambedTroughGeometry(dryLowerStations));
  }

  const lowerBrookWaterGeo = buildChannelWaterGeometry(lowerStations, {
    crossSegs: isLowInit ? 5 : 8,
    widthFactor: 1.10,
    stageKindAt: (_idx, s) => (s.z >= shorelineZ - 0.15 ? 3.0 : 0.0),
    flowSpeed: 2.15,
    edgeSoftness: 0.52,
  });

  // ==========================================================================
  // Assemble Merged Meshes & Pinned-Cache-Key Materials
  // ==========================================================================
  const { normalMap: rockNormalMap, roughnessMap: rockRoughMap } = buildBasaltMaps();
  const rockMat = new T.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    normalMap: rockNormalMap,
    normalScale: new T.Vector2(1.15, 1.15),
    roughnessMap: rockRoughMap,
    roughness: 0.82,
    metalness: 0.04,
  });
  rockMat.customProgramCacheKey = () => 'arena-waterfall-rock-v2';

  const mergedRockGeo = mergeGeometries(rockGeos, false) ?? new T.BufferGeometry();
  for (let i = 0; i < rockGeos.length; i++) rockGeos[i].dispose();
  mergedRockGeo.computeBoundingBox();
  mergedRockGeo.computeBoundingSphere();
  if (mergedRockGeo.attributes.position && mergedRockGeo.attributes.position.count > 0) {
    mergedRockGeo.boundsTree = new MeshBVH(mergedRockGeo);
  }

  const rockMesh = new T.Mesh(mergedRockGeo, rockMat);
  rockMesh.name = 'green-mountain-hydrology-rocks';
  rockMesh.receiveShadow = true;
  rockMesh.castShadow = !isLowInit;
  rockMesh.raycast = acceleratedRaycast;
  rockTargetGroup.add(rockMesh);

  // Shared atmosphere uniforms updated zero-GC on `setTimeOfDay` & `update`
  const sharedUniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new T.Vector3(-0.52, 0.74, 0.42).normalize() },
    uSunColor: { value: new T.Color(0xfff5e0) },
    uSkyColor: { value: new T.Color(0x74bbe6) },
    uFogColor: { value: new T.Color(0xcfe9f5) },
    uFogDensity: { value: 0.00115 },
    uSunsetMix: { value: currentTod === 'sunset' ? 1.0 : 0.0 },
    uImpactXZ: { value: new T.Vector2(IMPACT_X, IMPACT_Z) },
    uDistFade: { value: 1.0 },
  };

  const applyTimeOfDayUniforms = (tod: ArenaTimeOfDay) => {
    currentTod = tod;
    const preset = ARENA_ATMOSPHERE_PRESETS[tod];
    sharedUniforms.uSunDir.value.copy(preset.sunDirection);
    sharedUniforms.uSunColor.value.setHex(preset.sunColor);
    sharedUniforms.uSkyColor.value.setHex(preset.skyMid);
    sharedUniforms.uFogColor.value.setHex(preset.fogColor);
    sharedUniforms.uSunsetMix.value = tod === 'sunset' ? 1.0 : 0.0;
  };
  applyTimeOfDayUniforms(currentTod);

  // 1. Flowing Stream + Ballistic Waterfall + Lower Brook + Coastal Mouth Material
  const sheetMat = new T.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: T.DoubleSide,
    uniforms: {
      uTime: sharedUniforms.uTime,
      uSunDir: sharedUniforms.uSunDir,
      uSunColor: sharedUniforms.uSunColor,
      uSkyColor: sharedUniforms.uSkyColor,
      uFogColor: sharedUniforms.uFogColor,
      uFogDensity: sharedUniforms.uFogDensity,
      uSunsetMix: sharedUniforms.uSunsetMix,
    },
    vertexShader: WATER_SHEET_VERT,
    fragmentShader: WATER_SHEET_FRAG,
  });
  sheetMat.customProgramCacheKey = () => 'arena-waterfall-sheet-v2';

  const mergedFlowCoreGeo =
    mergeGeometries([upperStreamWaterGeo, wfCoreGeo, lowerBrookWaterGeo], false) ?? wfCoreGeo.clone();
  upperStreamWaterGeo.dispose();
  wfCoreGeo.dispose();
  lowerBrookWaterGeo.dispose();
  mergedFlowCoreGeo.computeBoundingSphere();

  const flowCoreMesh = new T.Mesh(mergedFlowCoreGeo, sheetMat);
  flowCoreMesh.name = 'green-mountain-water-core';
  flowCoreMesh.renderOrder = 3;

  wfVeilGeo.computeBoundingSphere();
  const flowVeilMesh = new T.Mesh(wfVeilGeo, sheetMat);
  flowVeilMesh.name = 'green-mountain-waterfall-veil';
  flowVeilMesh.renderOrder = 4;

  // 2. Enclosed Spring + Receiving Plunge Pool Material
  const poolMat = new T.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: T.FrontSide,
    uniforms: {
      uTime: sharedUniforms.uTime,
      uSunDir: sharedUniforms.uSunDir,
      uSunColor: sharedUniforms.uSunColor,
      uSkyColor: sharedUniforms.uSkyColor,
      uFogColor: sharedUniforms.uFogColor,
      uFogDensity: sharedUniforms.uFogDensity,
      uSunsetMix: sharedUniforms.uSunsetMix,
      uImpactXZ: sharedUniforms.uImpactXZ,
    },
    vertexShader: POOL_BASIN_VERT,
    fragmentShader: POOL_BASIN_FRAG,
  });
  poolMat.customProgramCacheKey = () => 'arena-waterfall-pool-v2';

  const mergedPoolsGeo =
    mergeGeometries([springBasinGeos.waterGeo, plungeBasinGeos.waterGeo], false) ??
    plungeBasinGeos.waterGeo.clone();
  springBasinGeos.waterGeo.dispose();
  plungeBasinGeos.waterGeo.dispose();
  mergedPoolsGeo.computeBoundingSphere();

  const poolsMesh = new T.Mesh(mergedPoolsGeo, poolMat);
  poolsMesh.name = 'green-mountain-hydrology-pools';
  poolsMesh.renderOrder = 2;

  // 3. GPU-Driven Plunge Mist Puffs & Ballistic Splash Droplets (`0` CPU particle loops in `update()`)
  const maxInstances = QUALITY_MIST_COUNTS.ultra;
  const baseQuad = new T.PlaneGeometry(1, 1);
  const mistGeo = new T.InstancedBufferGeometry();
  mistGeo.index = baseQuad.index;
  mistGeo.setAttribute('position', baseQuad.getAttribute('position'));
  mistGeo.setAttribute('uv', baseQuad.getAttribute('uv'));

  const instOrigins = new Float32Array(maxInstances * 3);
  const instSeeds = new Float32Array(maxInstances * 4);
  const instParams = new Float32Array(maxInstances * 4);

  for (let i = 0; i < maxInstances; i++) {
    const isDroplet = i % 3 === 2;
    const isCascadePuff = !isDroplet && i >= 44;

    if (isCascadePuff) {
      // Secondary mist puffs along steep lower cascades & cliff mid-drop
      const pick = lowerStations[Math.min(lowerStations.length - 4, 8 + ((i - 44) * 3))];
      instOrigins[i * 3] = pick.x;
      instOrigins[i * 3 + 1] = pick.waterY + 0.18;
      instOrigins[i * 3 + 2] = pick.z;
      instParams[i * 4] = 0.72 + rand() * 0.42; // radius
      instParams[i * 4 + 1] = 0.34 + rand() * 0.22; // cycle rate
      instParams[i * 4 + 2] = 0.95 + rand() * 0.55; // rise height
      instParams[i * 4 + 3] = 0.0; // mist puff
    } else if (!isDroplet) {
      // Main plunge-zone billowing mist puffs
      const a = rand() * Math.PI * 2;
      const r = rand() * 1.15;
      instOrigins[i * 3] = IMPACT_X + Math.cos(a) * r;
      instOrigins[i * 3 + 1] = poolWaterY + 0.16;
      instOrigins[i * 3 + 2] = IMPACT_Z + Math.sin(a) * r;
      instParams[i * 4] = 1.15 + rand() * 0.85;
      instParams[i * 4 + 1] = 0.26 + rand() * 0.18;
      instParams[i * 4 + 2] = 1.85 + rand() * 1.35;
      instParams[i * 4 + 3] = 0.0;
    } else {
      // Crisp parabolic splash droplets leaping from the plunge boil
      const a = rand() * Math.PI * 2;
      const r = 0.25 + rand() * 0.95;
      instOrigins[i * 3] = IMPACT_X + Math.cos(a) * r;
      instOrigins[i * 3 + 1] = poolWaterY + 0.06;
      instOrigins[i * 3 + 2] = IMPACT_Z + Math.sin(a) * r;
      instParams[i * 4] = 0.075 + rand() * 0.055;
      instParams[i * 4 + 1] = 0.85 + rand() * 0.55;
      instParams[i * 4 + 2] = 1.0;
      instParams[i * 4 + 3] = 1.0; // droplet
    }

    instSeeds[i * 4] = rand();
    instSeeds[i * 4 + 1] = rand();
    instSeeds[i * 4 + 2] = 0.45 + rand() * 0.85;
    instSeeds[i * 4 + 3] = rand();
  }

  mistGeo.setAttribute('aOrigin', new T.InstancedBufferAttribute(instOrigins, 3));
  mistGeo.setAttribute('aSeed', new T.InstancedBufferAttribute(instSeeds, 4));
  mistGeo.setAttribute('aParams', new T.InstancedBufferAttribute(instParams, 4));
  mistGeo.instanceCount = QUALITY_MIST_COUNTS[currentQuality];
  mistGeo.boundingSphere = new T.Sphere(new T.Vector3(POOL_X, poolWaterY + 1.5, POOL_Z + 12), 46);
  baseQuad.dispose();

  const mistMat = new T.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: T.DoubleSide,
    uniforms: {
      uTime: sharedUniforms.uTime,
      uDistFade: sharedUniforms.uDistFade,
      uSunColor: sharedUniforms.uSunColor,
      uSkyColor: sharedUniforms.uSkyColor,
      uFogColor: sharedUniforms.uFogColor,
      uFogDensity: sharedUniforms.uFogDensity,
      uSunsetMix: sharedUniforms.uSunsetMix,
    },
    vertexShader: MIST_DROPLET_VERT,
    fragmentShader: MIST_DROPLET_FRAG,
  });
  mistMat.customProgramCacheKey = () => 'arena-waterfall-mist-v2';

  const mistMesh = new T.Mesh(mistGeo, mistMat);
  mistMesh.name = 'green-mountain-waterfall-mist';
  mistMesh.renderOrder = 5;

  const waterRoot = new T.Group();
  waterRoot.name = 'green-mountain-hydrology-water';
  waterRoot.add(poolsMesh, flowCoreMesh, flowVeilMesh, mistMesh);
  parentGroup.add(waterRoot);

  const waterfallPos = new T.Vector3(IMPACT_X, poolWaterY, IMPACT_Z);
  const oceanOutflowPos = new T.Vector3(MOUTH_X, ARENA_WATER_Y, shorelineZ);
  let splashAccumSec = 0;

  return {
    waterfallPos,
    oceanOutflowPos,
    riverExclusionPoints: exclusions,
    stations: stationRecords,
    rockMesh,

    update(time: number, dt: number, camera?: T.Camera): void {
      sharedUniforms.uTime.value = time;

      if (camera) {
        const dx = camera.position.x - IMPACT_X;
        const dy = camera.position.y - poolWaterY;
        const dz = camera.position.z - IMPACT_Z;
        const dist = Math.hypot(dx, dy, dz);
        const maxMistDist = currentQuality === 'low' ? 145 : 255;
        const fade = 1.0 - T.MathUtils.smoothstep(dist, maxMistDist * 0.68, maxMistDist);
        sharedUniforms.uDistFade.value = fade;
        mistMesh.visible = fade > 0.01 && QUALITY_MIST_COUNTS[currentQuality] > 0;
      }

      if (onOceanOutflowSplash) {
        splashAccumSec += Math.max(0, Math.min(0.1, dt));
        if (splashAccumSec >= 0.36) {
          splashAccumSec = 0;
          onOceanOutflowSplash(MOUTH_X, shorelineZ + 0.45, 0.52 + 0.14 * Math.sin(time * 2.3));
        }
      }
    },

    setQuality(tier: ArenaQualityTier): void {
      currentQuality = tier;
      mistGeo.instanceCount = QUALITY_MIST_COUNTS[tier];
      rockMesh.castShadow = tier !== 'low';
    },

    setTimeOfDay(tod: ArenaTimeOfDay): void {
      applyTimeOfDayUniforms(tod);
    },

    warmup(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera): void {
      renderer.initTexture(rockNormalMap);
      renderer.initTexture(rockRoughMap);

      const meshes: T.Mesh[] = [rockMesh, poolsMesh, flowCoreMesh, flowVeilMesh, mistMesh];
      const prevVis = meshes.map((m) => m.visible);
      const prevCull = meshes.map((m) => m.frustumCulled);
      const prevRootVis = waterRoot.visible;
      const prevCount = mistGeo.instanceCount;

      try {
        waterRoot.visible = true;
        if (mistGeo.instanceCount <= 0) mistGeo.instanceCount = 1;
        for (let i = 0; i < meshes.length; i++) {
          meshes[i].visible = true;
          meshes[i].frustumCulled = false;
        }
        if (scene.fog && (scene.fog as T.FogExp2).isFogExp2) {
          sharedUniforms.uFogDensity.value = (scene.fog as T.FogExp2).density;
        }
        renderer.compile(scene, camera);
      } finally {
        waterRoot.visible = prevRootVis;
        mistGeo.instanceCount = prevCount;
        for (let i = 0; i < meshes.length; i++) {
          meshes[i].visible = prevVis[i];
          meshes[i].frustumCulled = prevCull[i];
        }
      }
    },

    dispose(): void {
      waterRoot.parent?.remove(waterRoot);
      rockMesh.parent?.remove(rockMesh);
      if (mergedRockGeo.boundsTree) {
        disposeBoundsTree.call(mergedRockGeo);
      }
      mergedRockGeo.dispose();
      mergedPoolsGeo.dispose();
      mergedFlowCoreGeo.dispose();
      wfVeilGeo.dispose();
      mistGeo.dispose();
      rockNormalMap.dispose();
      rockRoughMap.dispose();
      rockMat.dispose();
      sheetMat.dispose();
      poolMat.dispose();
      mistMat.dispose();
    },
  };
}
