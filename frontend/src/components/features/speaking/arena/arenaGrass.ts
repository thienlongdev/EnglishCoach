/**
 * Project ECHO ARCHIPELAGO — Terrain-Conforming Procedural Slope Grass System (`arenaGrass.ts`).
 *
 * Solves floating / unevenly buried foliage clumps on 15°–33° island hillsides by:
 * 1. Sampling exact terrain height & surface normal at every candidate `(x, z)` plus 4 perimeter
 *    probes at `tuftRadius = 0.28 * scale` (`0` external `.glb` dependencies).
 * 2. Enforcing strict dry-land (`y >= ARENA_WATER_Y + 0.52`), slope (`<= 33°`), summit-rock
 *    (`y <= 12.8 m`), Pearl Harbor marble plaza, pavilion plinth, wood bridge/dock, furniture,
 *    interactable, obstacle/boulder, and waterfall/stream exclusions across all 15 islands.
 * 3. Aligning each tuft smoothly to the hillside normal (`lerp(WORLD_UP, normal, 0.82)`) with
 *    phototropic upward blade curvature and sinking `instanceY` below `minPerimeterY` so 100% of
 *    blade roots remain grounded (`0.0 mm` floating gap) even during peak wind gusts (`uv.y^2`).
 * 4. Partitioning one `InstancedMesh` per island into `IslandDetail_<id>` with zero-rebuild
 *    `setQuality` prefix scaling (`ultra: 100%`, `high: 75%`, `balanced: 45%`, `low: 20%`).
 */

import * as T from 'three';
import type { ArenaIslandProfile, ArenaIslandSpec, ArenaQualityTier, ArenaTimeOfDay } from './arenaContracts';
import { ARENA_ATMOSPHERE_PRESETS } from './arenaQuality';
import {
  ARENA_PAVILIONS,
  ARENA_WATER_Y,
  arenaBeachFactor,
  arenaLayout,
  arenaOnWood,
  arenaShoreRadius,
} from './arenaTerrain';

export interface ArenaGrassExclusion {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

export interface ArenaGrassBuildOptions {
  getIslandGroup: (islandId: string, ring: 'detail' | 'mid' | 'hlod') => T.Object3D;
  sampleGround: (x: number, z: number, outNormal?: T.Vector3) => number;
  quality: ArenaQualityTier;
  timeOfDay: ArenaTimeOfDay;
  exclusions?: ReadonlyArray<ArenaGrassExclusion>;
}

export interface ArenaGrassTuftDiagnostic {
  readonly islandId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly groundY: number;
  readonly minPerimeterY: number;
  readonly scale: number;
  readonly normalY: number;
}

export interface ArenaGrassSystem {
  readonly meshes: T.InstancedMesh[];
  readonly totalTufts: number;
  readonly placementsByIsland: ReadonlyMap<string, ReadonlyArray<ArenaGrassTuftDiagnostic>>;
  update(time: number, camera?: T.Camera): void;
  setQuality(tier: ArenaQualityTier): void;
  setTimeOfDay(tod: ArenaTimeOfDay): void;
  warmup(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera): void;
  dispose(): void;
}

/** Strict slope ceiling: 33 degrees from horizontal (`cos(33°)`). */
export const ARENA_GRASS_MAX_SLOPE_DEG = 33;
export const ARENA_GRASS_MIN_NORMAL_Y = Math.cos((ARENA_GRASS_MAX_SLOPE_DEG * Math.PI) / 180);

/** Minimum dry-land elevation for grass center (`ARENA_WATER_Y + 0.52 = -0.68 m`). */
export const ARENA_GRASS_MIN_GROUND_Y = ARENA_WATER_Y + 0.52;

/** Minimum sunk instance root elevation (`> ARENA_WATER_Y + 0.45 = -0.75 m` with safety margin). */
const MIN_INSTANCE_ROOT_Y = ARENA_WATER_Y + 0.48;

/** Bare alpine summit rock threshold on `green_mountain`. */
const MAX_MOUNTAIN_GRASS_Y = 12.8;

/** Pearl Harbor (`commons`) marble courtyard exclusion radius (`> 31.4 m` + blade margin). */
const COMMONS_PLAZA_EXCLUSION_R = 32.0;

/** Reference tuft perimeter probe radius at unit scale (`0.28 m`). */
export const ARENA_GRASS_TUFT_RADIUS = 0.28;

export const ARENA_GRASS_QUALITY_RATIOS: Record<ArenaQualityTier, number> = {
  ultra: 1.0,
  high: 0.75,
  balanced: 0.45,
  low: 0.2,
};

/** Built-in Green Mountain cascading waterfall channel and plunge-pool exclusions (`arenaWorld.ts:996-1029`). */
const DEFAULT_WATERFALL_EXCLUSIONS: ReadonlyArray<ArenaGrassExclusion> = [
  { x: 6.2, z: -186.8, r: 7.4 },
  { x: 6.0, z: -189.2, r: 4.8 },
  { x: 5.5, z: -193.2, r: 4.2 },
  { x: 4.5, z: -197.4, r: 4.0 },
];

const WORLD_UP = new T.Vector3(0, 1, 0);
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointToSegmentDistSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-8 ? T.MathUtils.clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1) : 0;
  const qx = ax + t * dx;
  const qz = az + t * dz;
  const ex = px - qx;
  const ez = pz - qz;
  return ex * ex + ez * ez;
}

/**
 * Builds a single crisp 7-blade curved tropical grass tuft `BufferGeometry` (`35` triangles,
 * `49` vertices, `uv.y === 0` strictly pinned at `y === 0` root vertices, `uv.y === 1` at tips).
 */
export function buildTropicalGrassTuftGeometry(): T.BufferGeometry {
  const bladeCount = 7;
  const vertsPerBlade = 7; // 3 width pairs (v = 0, 0.36, 0.72) + 1 sharp tip apex (v = 1)
  const trisPerBlade = 5;

  const positions = new Float32Array(bladeCount * vertsPerBlade * 3);
  const normals = new Float32Array(bladeCount * vertsPerBlade * 3);
  const uvs = new Float32Array(bladeCount * vertsPerBlade * 2);
  const indices = new Uint16Array(bladeCount * trisPerBlade * 3);

  const rand = createMulberry32(0x51a7e903);
  const radialDir = new T.Vector3();
  const sideDir = new T.Vector3();
  const tangent = new T.Vector3();
  const bladeNormal = new T.Vector3();

  const rowFracs = [0.0, 0.36, 0.72] as const;
  const rowWidthFactors = [1.0, 0.78, 0.44] as const;

  let vCursor = 0;
  let iCursor = 0;

  for (let b = 0; b < bladeCount; b++) {
    const baseVertex = vCursor;
    const azim = (b / bladeCount) * Math.PI * 2 + (rand() - 0.5) * 0.34;
    const twist = (rand() - 0.5) * 0.36;
    const crownR = b === 0 ? 0.015 : 0.038 + rand() * 0.044; // <= 0.082 m root radius
    const height = (b === 0 ? 0.49 : 0.36) + rand() * 0.16; // 0.36 .. 0.65 m
    const archReach = (b === 0 ? 0.065 : 0.105) + rand() * 0.085; // graceful outward tropical arch <= 0.27 m total
    const halfW0 = 0.019 + rand() * 0.008;

    const cosA = Math.cos(azim);
    const sinA = Math.sin(azim);
    radialDir.set(cosA, 0, sinA);
    sideDir.set(-Math.sin(azim + twist), 0, Math.cos(azim + twist));

    const bx = cosA * crownR;
    const bz = sinA * crownR;

    const evalSpine = (v: number, out: T.Vector3): T.Vector3 => {
      const arch = archReach * (v * v * 0.82 + v * 0.18);
      const y = height * (v - 0.14 * v * v * v);
      return out.set(bx + radialDir.x * arch, v === 0 ? 0 : y, bz + radialDir.z * arch);
    };

    const pCur = new T.Vector3();
    const pEps = new T.Vector3();

    for (let r = 0; r < rowFracs.length; r++) {
      const v = rowFracs[r];
      evalSpine(v, pCur);
      evalSpine(Math.min(1, v + 0.04), pEps);
      tangent.subVectors(pEps, pCur).normalize();
      bladeNormal.crossVectors(sideDir, tangent).addScaledVector(WORLD_UP, 0.32).normalize();
      if (bladeNormal.y < 0) bladeNormal.negate();

      const hw = halfW0 * rowWidthFactors[r];

      // Left edge vertex (uv.x = 0)
      positions[vCursor * 3] = pCur.x - sideDir.x * hw;
      positions[vCursor * 3 + 1] = v === 0 ? 0 : pCur.y;
      positions[vCursor * 3 + 2] = pCur.z - sideDir.z * hw;
      normals[vCursor * 3] = bladeNormal.x - sideDir.x * 0.18;
      normals[vCursor * 3 + 1] = bladeNormal.y;
      normals[vCursor * 3 + 2] = bladeNormal.z - sideDir.z * 0.18;
      uvs[vCursor * 2] = 0;
      uvs[vCursor * 2 + 1] = v;
      vCursor++;

      // Right edge vertex (uv.x = 1)
      positions[vCursor * 3] = pCur.x + sideDir.x * hw;
      positions[vCursor * 3 + 1] = v === 0 ? 0 : pCur.y;
      positions[vCursor * 3 + 2] = pCur.z + sideDir.z * hw;
      normals[vCursor * 3] = bladeNormal.x + sideDir.x * 0.18;
      normals[vCursor * 3 + 1] = bladeNormal.y;
      normals[vCursor * 3 + 2] = bladeNormal.z + sideDir.z * 0.18;
      uvs[vCursor * 2] = 1;
      uvs[vCursor * 2 + 1] = v;
      vCursor++;
    }

    // Tip apex vertex (v = 1.0, uv = [0.5, 1.0])
    evalSpine(1.0, pCur);
    evalSpine(0.96, pEps);
    tangent.subVectors(pCur, pEps).normalize();
    bladeNormal.crossVectors(sideDir, tangent).addScaledVector(WORLD_UP, 0.42).normalize();
    if (bladeNormal.y < 0) bladeNormal.negate();

    positions[vCursor * 3] = pCur.x;
    positions[vCursor * 3 + 1] = pCur.y;
    positions[vCursor * 3 + 2] = pCur.z;
    normals[vCursor * 3] = bladeNormal.x;
    normals[vCursor * 3 + 1] = bladeNormal.y;
    normals[vCursor * 3 + 2] = bladeNormal.z;
    uvs[vCursor * 2] = 0.5;
    uvs[vCursor * 2 + 1] = 1.0;
    vCursor++;

    // Normalize per-vertex normals cleanly
    for (let k = baseVertex; k < vCursor; k++) {
      const nx = normals[k * 3];
      const ny = normals[k * 3 + 1];
      const nz = normals[k * 3 + 2];
      const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
      normals[k * 3] = nx * inv;
      normals[k * 3 + 1] = ny * inv;
      normals[k * 3 + 2] = nz * inv;
    }

    // Quad 0..1 -> (0, 1, 2), (1, 3, 2)
    indices[iCursor++] = baseVertex + 0;
    indices[iCursor++] = baseVertex + 1;
    indices[iCursor++] = baseVertex + 2;
    indices[iCursor++] = baseVertex + 1;
    indices[iCursor++] = baseVertex + 3;
    indices[iCursor++] = baseVertex + 2;

    // Quad 1..2 -> (2, 3, 4), (3, 5, 4)
    indices[iCursor++] = baseVertex + 2;
    indices[iCursor++] = baseVertex + 3;
    indices[iCursor++] = baseVertex + 4;
    indices[iCursor++] = baseVertex + 3;
    indices[iCursor++] = baseVertex + 5;
    indices[iCursor++] = baseVertex + 4;

    // Tip triangle -> (4, 5, 6)
    indices[iCursor++] = baseVertex + 4;
    indices[iCursor++] = baseVertex + 5;
    indices[iCursor++] = baseVertex + 6;
  }

  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new T.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new T.BufferAttribute(uvs, 2));
  geo.setIndex(new T.BufferAttribute(indices, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function targetCandBudgetForIsland(island: ArenaIslandSpec): number {
  const profile: ArenaIslandProfile = (island.profile as ArenaIslandProfile | undefined) ?? 'outer';
  if (profile === 'islet') return 260;
  if (profile === 'harbor') return 980;
  if (profile === 'mountain') return 1450;
  if (profile === 'beach') return 1200;
  if (profile === 'atoll') return 1100;
  if (profile === 'karst' || profile === 'village') return 1150;
  return 950;
}

function maxAcceptedTuftsForIsland(island: ArenaIslandSpec): number {
  const profile: ArenaIslandProfile = (island.profile as ArenaIslandProfile | undefined) ?? 'outer';
  if (profile === 'islet') return 95;
  if (profile === 'harbor') return 360;
  if (profile === 'mountain') return 620;
  if (profile === 'beach' || profile === 'karst' || profile === 'village') return 500;
  if (profile === 'atoll') return 420;
  return 400;
}

export function buildArenaGrassSystem(options: ArenaGrassBuildOptions): ArenaGrassSystem {
  const { getIslandGroup, sampleGround } = options;
  let currentTier: ArenaQualityTier = options.quality;
  let currentTod: ArenaTimeOfDay = options.timeOfDay;
  let disposed = false;

  const allExclusions: ArenaGrassExclusion[] = [
    ...DEFAULT_WATERFALL_EXCLUSIONS,
    ...(options.exclusions ?? []),
  ];

  const preparedFurniture = arenaLayout.furniture.map(f => ({
    x: f.x,
    z: f.z,
    c: Math.cos(f.yaw),
    s: Math.sin(f.yaw),
    halfW: f.width * 0.5 + 0.95,
    halfD: ((f as { depth?: number }).depth ?? f.width) * 0.5 + 0.95,
  }));

  // Uniforms shared by the single instanced slope-grass PBR material (`arena-slope-grass-v1`)
  const uGrassTime = { value: 0 };
  const uGrassSunDir = { value: ARENA_ATMOSPHERE_PRESETS[currentTod].sunDirection.clone().normalize() };
  const uGrassSunTint = { value: new T.Vector3(1, 1, 1) };
  const uGrassWarmth = { value: currentTod === 'sunset' ? 1.0 : 0.0 };
  const uGrassWindStrength = { value: currentTier === 'low' ? 0.65 : 1.0 };

  const applyTodUniforms = (tod: ArenaTimeOfDay) => {
    const preset = ARENA_ATMOSPHERE_PRESETS[tod];
    uGrassSunDir.value.copy(preset.sunDirection).normalize();
    if (tod === 'sunset') {
      uGrassSunTint.value.set(1.16, 0.84, 0.62);
      uGrassWarmth.value = 1.0;
    } else {
      uGrassSunTint.value.set(1.0, 0.98, 0.92);
      uGrassWarmth.value = 0.0;
    }
  };
  applyTodUniforms(currentTod);

  const tuftGeometry = buildTropicalGrassTuftGeometry();

  const grassMaterial = new T.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.68,
    metalness: 0.02,
    side: T.DoubleSide,
  });

  grassMaterial.onBeforeCompile = shader => {
    shader.uniforms.uGrassTime = uGrassTime;
    shader.uniforms.uGrassSunDir = uGrassSunDir;
    shader.uniforms.uGrassSunTint = uGrassSunTint;
    shader.uniforms.uGrassWarmth = uGrassWarmth;
    shader.uniforms.uGrassWindStrength = uGrassWindStrength;

    let vs =
      `uniform float uGrassTime;\n` +
      `uniform float uGrassWindStrength;\n` +
      `varying vec2 vGrassUv;\n` +
      `varying vec3 vGrassWorldPos;\n` +
      `varying vec3 vGrassWorldNrm;\n` +
      shader.vertexShader;

    vs = vs.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vGrassUv = uv;
      vec4 grassBaseWP = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        grassBaseWP = instanceMatrix * grassBaseWP;
      #endif
      grassBaseWP = modelMatrix * grassBaseWP;

      // Strictly zero displacement at uv.y == 0 so blade roots NEVER detach from sloped ground
      float grassTipWeight = uv.y * uv.y;
      float grassGustPhase = uGrassTime * 1.85 + grassBaseWP.x * 0.24 + grassBaseWP.z * 0.19;
      float grassGust = sin(grassGustPhase) * 0.68 + sin(grassGustPhase * 2.15 - uGrassTime * 0.9) * 0.32;
      float grassFlutter = sin(uGrassTime * 5.4 + grassBaseWP.x * 1.9 - grassBaseWP.z * 1.6 + uv.x * 6.283185) * 0.022;
      float swayX = (grassGust * 0.095 + grassFlutter) * grassTipWeight * uGrassWindStrength;
      float swayZ = (cos(uGrassTime * 1.52 + grassBaseWP.z * 0.22 + grassBaseWP.x * 0.16) * 0.072 + grassFlutter * 0.7) * grassTipWeight * uGrassWindStrength;
      transformed.x += swayX;
      transformed.z += swayZ;
      transformed.y -= 0.32 * (swayX * swayX + swayZ * swayZ);`,
    );

    vs = vs.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vec4 grassWP4 = vec4(transformed, 1.0);
      vec3 grassWN3 = objectNormal;
      #ifdef USE_INSTANCING
        grassWP4 = instanceMatrix * grassWP4;
        grassWN3 = mat3(instanceMatrix) * grassWN3;
      #endif
      grassWP4 = modelMatrix * grassWP4;
      vGrassWorldPos = grassWP4.xyz;
      vGrassWorldNrm = normalize(mat3(modelMatrix) * grassWN3);`,
    );
    shader.vertexShader = vs;

    let fs =
      `uniform vec3 uGrassSunDir;\n` +
      `uniform vec3 uGrassSunTint;\n` +
      `uniform float uGrassWarmth;\n` +
      `varying vec2 vGrassUv;\n` +
      `varying vec3 vGrassWorldPos;\n` +
      `varying vec3 vGrassWorldNrm;\n` +
      shader.fragmentShader;

    fs = fs.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      float rootAo = mix(0.44, 1.0, smoothstep(0.0, 0.64, vGrassUv.y));
      float midrib = 1.0 - abs(vGrassUv.x * 2.0 - 1.0);
      vec3 baseBlade = mix(vec3(0.15, 0.38, 0.16), vec3(0.46, 0.74, 0.27), smoothstep(0.06, 0.94, vGrassUv.y));
      vec3 sunsetTip = mix(baseBlade, vec3(0.68, 0.66, 0.26), uGrassWarmth * smoothstep(0.42, 1.0, vGrassUv.y) * 0.45);
      diffuseColor.rgb *= sunsetTip * rootAo * (0.92 + 0.12 * midrib);`,
    );

    fs = fs.replace(
      '#include <opaque_fragment>',
      `float backSun = pow(clamp(dot(normalize(vGrassWorldPos - cameraPosition), uGrassSunDir), 0.0, 1.0), 2.8);
      float tipTrans = smoothstep(0.18, 0.96, vGrassUv.y);
      float skyWrap = clamp(0.36 + 0.64 * abs(vGrassWorldNrm.y), 0.0, 1.0);
      vec3 sssCol = mix(vec3(0.44, 0.80, 0.22), vec3(0.94, 0.64, 0.24), uGrassWarmth * 0.62);
      outgoingLight += diffuseColor.rgb * sssCol * uGrassSunTint * (0.18 + 0.52 * backSun) * tipTrans * skyWrap;
      #include <opaque_fragment>`,
    );

    shader.fragmentShader = fs;
  };
  grassMaterial.customProgramCacheKey = () => 'arena-slope-grass-v1';

  // Reusable scratch objects for zero-churn deterministic generation
  const nrmCenter = new T.Vector3();
  const nrmProbe = new T.Vector3();
  const upTarget = new T.Vector3();
  const alignQuat = new T.Quaternion();
  const yawQuat = new T.Quaternion();
  const finalQuat = new T.Quaternion();
  const posVec = new T.Vector3();
  const scaleVec = new T.Vector3();
  const mat4 = new T.Matrix4();
  const tintColor = new T.Color();

  const evalHeightAndNormal = (x: number, z: number, outNrm: T.Vector3): number => {
    outNrm.set(0, 0, 0);
    const y = sampleGround(x, z, outNrm);
    if (outNrm.lengthSq() < 0.5) {
      const eps = 0.22;
      const dhdx = (sampleGround(x + eps, z) - sampleGround(x - eps, z)) / (2 * eps);
      const dhdz = (sampleGround(x, z + eps) - sampleGround(x, z - eps)) / (2 * eps);
      outNrm.set(-dhdx, 1, -dhdz).normalize();
    } else {
      if (outNrm.y < 0) outNrm.negate();
      outNrm.normalize();
    }
    return y;
  };

  const isExcludedXZ = (islandId: string, x: number, z: number, padR: number): boolean => {
    // 1. Pearl Harbor (`commons`) marble courtyard exclusion
    if (islandId === 'commons' && x * x + z * z < (COMMONS_PLAZA_EXCLUSION_R + padR) ** 2) {
      return true;
    }

    // 2. Pavilion stone plinths (`r < 4.8 * scale`)
    for (let i = 0; i < ARENA_PAVILIONS.length; i++) {
      const pav = ARENA_PAVILIONS[i];
      const lim = 4.8 * pav.scale + padR;
      const dx = x - pav.x;
      const dz = z - pav.z;
      if (dx * dx + dz * dz < lim * lim) return true;
    }

    // 3. Timber bridges & coastal piers (`arenaOnWood` + plank/abutment clearance)
    if (arenaOnWood(x, z)) return true;
    for (let i = 0; i < arenaLayout.bridges.length; i++) {
      const b = arenaLayout.bridges[i];
      const lim = b.width * 0.5 + 0.85 + padR;
      if (pointToSegmentDistSq(x, z, b.ax, b.az, b.bx, b.bz) < lim * lim) return true;
    }
    for (let i = 0; i < arenaLayout.docks.length; i++) {
      const d = arenaLayout.docks[i];
      const lim = d.width * 0.5 + 0.85 + padR;
      if (pointToSegmentDistSq(x, z, d.ax, d.az, d.bx, d.bz) < lim * lim) return true;
    }

    // 4. Waterfall stream/plunge-pool & caller exclusions
    for (let i = 0; i < allExclusions.length; i++) {
      const ex = allExclusions[i];
      const lim = ex.r + padR;
      const dx = x - ex.x;
      const dz = z - ex.z;
      if (dx * dx + dz * dz < lim * lim) return true;
    }

    // 5. Furniture footprints
    for (let i = 0; i < preparedFurniture.length; i++) {
      const f = preparedFurniture[i];
      const dx = x - f.x;
      const dz = z - f.z;
      if (Math.abs(dx) > 6 || Math.abs(dz) > 6) continue;
      const u = dx * f.c - dz * f.s;
      const v = dx * f.s + dz * f.c;
      if (Math.abs(u) <= f.halfW + padR && Math.abs(v) <= f.halfD + padR) return true;
    }

    // 6. Speaking kiosks, beacons, telescopes & interactables (`r < 2.2 m`)
    for (let i = 0; i < arenaLayout.interactables.length; i++) {
      const it = arenaLayout.interactables[i];
      const lim = 2.25 + padR;
      const dx = x - it.x;
      const dz = z - it.z;
      if (dx * dx + dz * dz < lim * lim) return true;
    }

    // 7. Solid planters, huts, spires & obstacles (`r < o.radius + 0.6 m`)
    for (let i = 0; i < arenaLayout.obstacles.length; i++) {
      const o = arenaLayout.obstacles[i];
      const lim = o.radius + 0.62 + padR;
      const dx = x - o.x;
      const dz = z - o.z;
      if (dx * dx + dz * dz < lim * lim) return true;
    }

    // 8. Coastal & inland rock boulders
    for (let i = 0; i < arenaLayout.rocks.length; i++) {
      const rk = arenaLayout.rocks[i];
      const lim = rk.r * 0.85 + 0.35 + padR;
      const dx = x - rk.x;
      const dz = z - rk.z;
      if (dx * dx + dz * dz < lim * lim) return true;
    }

    return false;
  };

  interface InternalPlacement extends ArenaGrassTuftDiagnostic {
    readonly qx: number;
    readonly qy: number;
    readonly qz: number;
    readonly qw: number;
    readonly rCol: number;
    readonly gCol: number;
    readonly bCol: number;
  }

  const meshes: T.InstancedMesh[] = [];
  const maxCounts: number[] = [];
  const placementsByIsland = new Map<string, ReadonlyArray<ArenaGrassTuftDiagnostic>>();
  let totalTufts = 0;

  for (const rawIsl of arenaLayout.islands) {
    const island = rawIsl as unknown as ArenaIslandSpec;
    const profile: ArenaIslandProfile = (island.profile as ArenaIslandProfile | undefined) ?? 'outer';
    const rand = createMulberry32((island.seed * 2654435761 + 0x9e3779b9) >>> 0);
    const candBudget = targetCandBudgetForIsland(island);
    const maxAccept = maxAcceptedTuftsForIsland(island);

    const maxScanR = island.radius * (1 + (island.lobe3 ?? 0) + (island.lobe5 ?? 0)) + island.shore;
    const minScanR = island.id === 'commons' ? COMMONS_PLAZA_EXCLUSION_R + 0.5 : profile === 'atoll' ? 36.0 : 0.4;

    const accepted: InternalPlacement[] = [];

    for (let cIdx = 0; cIdx < candBudget && accepted.length < maxAccept; cIdx++) {
      // Stratified golden-angle phyllotaxis with organic clumping jitter across [minScanR .. maxScanR]
      const u = (cIdx + 0.5) / candBudget;
      const areaFrac = minScanR * minScanR + u * Math.max(1, maxScanR * maxScanR - minScanR * minScanR);
      const baseR = Math.sqrt(areaFrac);
      const theta = cIdx * GOLDEN_ANGLE + (rand() - 0.5) * 0.22;
      const jitterR = baseR + (rand() - 0.5) * 1.35;
      if (jitterR < minScanR) continue;

      const dx = Math.cos(theta) * jitterR;
      const dz = Math.sin(theta) * jitterR;
      const x = island.x + dx;
      const z = island.z + dz;

      const angle = Math.atan2(dz, dx);
      const shoreR = arenaShoreRadius(island, angle);
      if (jitterR > shoreR - 1.45) continue;

      // Scale in [0.84 .. 1.30] so `0.02 - 0.025 * scale <= -0.001 m` (always strictly <= minPerimeterY!)
      const scale = 0.84 + rand() * 0.46;
      const tuftRadius = ARENA_GRASS_TUFT_RADIUS * scale;

      if (isExcludedXZ(island.id, x, z, tuftRadius)) continue;

      const groundY = evalHeightAndNormal(x, z, nrmCenter);
      if (!Number.isFinite(groundY)) continue;

      // Strictly dry inland turf/dunes (`>= ARENA_WATER_Y + 0.52`) & below bare mountain rock (`<= 12.8 m`)
      if (groundY < ARENA_GRASS_MIN_GROUND_Y || groundY > MAX_MOUNTAIN_GRASS_Y) continue;

      // Keep pure low swimming beaches sandy near the waterline while clothing upper dune crests
      const bf = arenaBeachFactor(island, angle);
      if (bf > 0.48 && groundY < ARENA_WATER_Y + 1.18) continue;

      // Strict 33-degree slope cap on surface normal
      if (nrmCenter.y < ARENA_GRASS_MIN_NORMAL_Y) continue;

      // 4-cardinal perimeter probes at `tuftRadius = 0.28 * scale`
      const yPx = evalHeightAndNormal(x + tuftRadius, z, nrmProbe);
      if (nrmProbe.y < ARENA_GRASS_MIN_NORMAL_Y) continue;
      const yMx = evalHeightAndNormal(x - tuftRadius, z, nrmProbe);
      if (nrmProbe.y < ARENA_GRASS_MIN_NORMAL_Y) continue;
      const yPz = evalHeightAndNormal(x, z + tuftRadius, nrmProbe);
      if (nrmProbe.y < ARENA_GRASS_MIN_NORMAL_Y) continue;
      const yMz = evalHeightAndNormal(x, z - tuftRadius, nrmProbe);
      if (nrmProbe.y < ARENA_GRASS_MIN_NORMAL_Y) continue;

      const minPerimeterY = Math.min(yPx, yMx, yPz, yMz);
      const maxPerimeterY = Math.max(yPx, yMx, yPz, yMz);
      if (minPerimeterY < ARENA_WATER_Y + 0.48 || maxPerimeterY > MAX_MOUNTAIN_GRASS_Y) continue;

      // Also verify finite-difference secant slope across the tuft footprint <= 33°
      const secantGrad = Math.hypot(yPx - yMx, yPz - yMz) / (2 * tuftRadius);
      const secantNormalY = 1 / Math.hypot(secantGrad, 1);
      if (secantNormalY < ARENA_GRASS_MIN_NORMAL_Y) continue;

      // Exact slope root sink: guarantees 0.0 mm floating perimeter gap on every hillside!
      const instanceY = Math.min(groundY, minPerimeterY + 0.02) - 0.025 * scale;
      if (instanceY < MIN_INSTANCE_ROOT_Y) continue;

      // Smooth hillside normal alignment + random local yaw (`0.82` blend keeps phototropic upward arch)
      upTarget.copy(WORLD_UP).lerp(nrmCenter, 0.82).normalize();
      alignQuat.setFromUnitVectors(WORLD_UP, upTarget);
      yawQuat.setFromAxisAngle(WORLD_UP, rand() * Math.PI * 2);
      finalQuat.multiplyQuaternions(alignQuat, yawQuat).normalize();

      // Subtle per-instance warm/emerald tropical tint
      const warmDune = T.MathUtils.clamp(bf * 0.45 + (1 - T.MathUtils.smoothstep(groundY, -0.4, 2.6)) * 0.25, 0, 0.65);
      const lushShade = 0.86 + rand() * 0.28;
      tintColor.setRGB(
        T.MathUtils.lerp(0.84, 1.06, warmDune) * lushShade,
        T.MathUtils.lerp(1.02, 0.96, warmDune) * lushShade,
        T.MathUtils.lerp(0.80, 0.72, warmDune) * lushShade,
      );

      accepted.push({
        islandId: island.id,
        x,
        y: instanceY,
        z,
        groundY,
        minPerimeterY,
        scale,
        normalY: Math.min(nrmCenter.y, secantNormalY),
        qx: finalQuat.x,
        qy: finalQuat.y,
        qz: finalQuat.z,
        qw: finalQuat.w,
        rCol: tintColor.r,
        gCol: tintColor.g,
        bCol: tintColor.b,
      });
    }

    if (accepted.length === 0) {
      placementsByIsland.set(island.id, []);
      continue;
    }

    // Deterministic Fisher-Yates shuffle so `inst.count = floor(max * ratio)` stays uniformly
    // distributed across the entire island at every ArenaQualityTier without rebuilding buffers!
    for (let i = accepted.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = accepted[i];
      accepted[i] = accepted[j];
      accepted[j] = tmp;
    }

    const inst = new T.InstancedMesh(tuftGeometry, grassMaterial, accepted.length);
    inst.name = `ArenaSlopeGrass_${island.id}`;
    inst.castShadow = false;
    inst.receiveShadow = true;

    const minB = new T.Vector3(Infinity, Infinity, Infinity);
    const maxB = new T.Vector3(-Infinity, -Infinity, -Infinity);

    for (let i = 0; i < accepted.length; i++) {
      const item = accepted[i];
      posVec.set(item.x, item.y, item.z);
      finalQuat.set(item.qx, item.qy, item.qz, item.qw);
      scaleVec.setScalar(item.scale);
      mat4.compose(posVec, finalQuat, scaleVec);
      inst.setMatrixAt(i, mat4);

      tintColor.setRGB(item.rCol, item.gCol, item.bCol);
      inst.setColorAt(i, tintColor);

      const pad = 0.75 * item.scale;
      if (item.x - pad < minB.x) minB.x = item.x - pad;
      if (item.y - 0.1 < minB.y) minB.y = item.y - 0.1;
      if (item.z - pad < minB.z) minB.z = item.z - pad;
      if (item.x + pad > maxB.x) maxB.x = item.x + pad;
      if (item.y + pad > maxB.y) maxB.y = item.y + pad;
      if (item.z + pad > maxB.z) maxB.z = item.z + pad;
    }

    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

    // Tight world-space bounding box & sphere per island for accurate Three.js frustum culling
    inst.boundingBox = new T.Box3(minB, maxB);
    inst.boundingSphere = inst.boundingBox.getBoundingSphere(new T.Sphere());
    inst.frustumCulled = true;

    const ratio = ARENA_GRASS_QUALITY_RATIOS[currentTier];
    inst.count = Math.max(1, Math.floor(accepted.length * ratio));

    getIslandGroup(island.id, 'detail').add(inst);
    meshes.push(inst);
    maxCounts.push(accepted.length);
    placementsByIsland.set(island.id, accepted);
    totalTufts += accepted.length;
  }

  const applyTierCounts = (tier: ArenaQualityTier) => {
    currentTier = tier;
    uGrassWindStrength.value = tier === 'low' ? 0.65 : 1.0;
    const ratio = ARENA_GRASS_QUALITY_RATIOS[tier];
    for (let i = 0; i < meshes.length; i++) {
      const maxC = maxCounts[i];
      meshes[i].count = maxC > 0 ? Math.max(1, Math.floor(maxC * ratio)) : 0;
    }
  };

  return {
    meshes,
    totalTufts,
    placementsByIsland,

    update(time: number, _camera?: T.Camera) {
      if (disposed) return;
      uGrassTime.value = time;
    },

    setQuality(tier: ArenaQualityTier) {
      if (disposed) return;
      applyTierCounts(tier);
    },

    setTimeOfDay(tod: ArenaTimeOfDay) {
      if (disposed) return;
      currentTod = tod;
      applyTodUniforms(tod);
    },

    warmup(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera) {
      if (disposed || meshes.length === 0) return;

      // Temporarily place a 1-instance carrier at the camera focus inside `scene` so WebGL2
      // compiles the exact `USE_INSTANCING + USE_INSTANCING_COLOR` variant (`programDelta === 0`).
      const warmMesh = new T.InstancedMesh(tuftGeometry, grassMaterial, 1);
      warmMesh.castShadow = false;
      warmMesh.receiveShadow = true;
      warmMesh.frustumCulled = false;

      const camDir = new T.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      posVec.copy(camera.position).addScaledVector(camDir, 2.5);
      finalQuat.identity();
      scaleVec.setScalar(0.001);
      mat4.compose(posVec, finalQuat, scaleVec);
      warmMesh.setMatrixAt(0, mat4);
      warmMesh.setColorAt(0, tintColor.setRGB(1, 1, 1));
      warmMesh.instanceMatrix.needsUpdate = true;
      if (warmMesh.instanceColor) warmMesh.instanceColor.needsUpdate = true;

      scene.add(warmMesh);

      const vp = new T.Vector4();
      const sc = new T.Vector4();
      const hasViewportApi =
        typeof renderer.getViewport === 'function' &&
        typeof renderer.getScissor === 'function' &&
        typeof renderer.getScissorTest === 'function';
      const prevScissorTest = hasViewportApi ? renderer.getScissorTest() : false;
      const prevAutoReset = renderer.info ? renderer.info.autoReset : true;
      if (hasViewportApi) {
        renderer.getViewport(vp);
        renderer.getScissor(sc);
      }

      try {
        renderer.compile?.(scene, camera);
        if (hasViewportApi && typeof renderer.render === 'function') {
          if (renderer.info) renderer.info.autoReset = false;
          renderer.setViewport(0, 0, 1, 1);
          renderer.setScissor(0, 0, 1, 1);
          renderer.setScissorTest(true);
          renderer.render(scene, camera);
        }
      } finally {
        if (hasViewportApi) {
          renderer.setViewport(vp);
          renderer.setScissor(sc);
          renderer.setScissorTest(prevScissorTest);
        }
        if (renderer.info) renderer.info.autoReset = prevAutoReset;
        scene.remove(warmMesh);
        warmMesh.dispose();
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i];
        m.parent?.remove(m);
        m.dispose();
      }
      meshes.length = 0;
      tuftGeometry.dispose();
      grassMaterial.dispose();
    },
  };
}
