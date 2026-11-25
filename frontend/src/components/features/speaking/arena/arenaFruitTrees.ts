/**
 * ECHO ARCHIPELAGO — Tropical Fruit Trees (`coconut`, `mango`, `banana`, `papaya`),
 * Exact GLB Crown Attachment, Shader-Synchronized Sway, Gravity-Bounce-Roll Physics,
 * and Account-Scoped Harvest Log (`E01`).
 *
 * - Loads textured zero-WASM PBR fruit meshes from `prop-fruits-fd8867545e51.glb` (`readyPromise`)
 *   with automatic sculpted procedural fallback in headless Node test environments.
 * - Attaches hanging fruits to exact measured local-to-world GLB crown/bough sockets
 *   (`coconut` `+7.94 m` curved crown, `papaya` `0.56x` `+4.17 m` crownshaft, `banana` `+2.08 m` stalk,
 *   `mango` `+2.65..3.05 m` fruiting boughs) synchronized with `arenaMaterials.ts` GPU wind sway.
 * - Shaking detaches individual crown sockets outward with gravity, terrain-normal sandy bounce,
 *   downhill slope rolling + sand damping, and a persistent `180 s` ground lifecycle (`48`-slot zero-GC pool).
 */

import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { FruitHarvestLog, FruitKind, FruitSpec } from './arenaContracts';
import { arenaV7Assets } from './arenaAssets';
import { ARENA_WATER_Y, arenaDryWalkable, arenaFloor, arenaHeight, arenaLayout, arenaOnWood } from './arenaTerrain';
import type { ArenaAmbience } from './arenaAmbience';

const FRUIT_LOG_KEY_PREFIX = 'ec_arena_fruit_log:v1:';
const FRUIT_KINDS: readonly FruitKind[] = ['coconut', 'mango', 'banana', 'papaya'] as const;
export const MAX_DROPPED_FRUITS = 48;
const REGROW_SECONDS = 34.0;
const PERSIST_SECONDS = 180.0;
const GRAVITY = 9.81;
const MAX_PHYSICS_SUBSTEP = 1 / 60;

export const FRUIT_SPECS: Readonly<Record<FruitKind, FruitSpec>> = Object.freeze({
  coconut: {
    kind: 'coconut',
    nameEn: 'Fresh Island Coconut',
    nameVi: 'Dừa xiêm biển tươi',
    color: '#6e4b2a',
    vocabPhraseEn: 'refreshing coconut water chilled by the sea breeze',
    vocabPhraseVi: 'nước dừa tươi mát lành giữa làn gió biển',
  },
  mango: {
    kind: 'mango',
    nameEn: 'Sun-Ripened Golden Mango',
    nameVi: 'Xoài cát chín vàng',
    color: '#f59e0b',
    vocabPhraseEn: 'fragrant, honey-sweet mango pulp picked straight from the orchard',
    vocabPhraseVi: 'thịt xoài thơm dịu và ngọt thanh vừa hái từ vườn đảo',
  },
  banana: {
    kind: 'banana',
    nameEn: 'Sweet Tropical Banana',
    nameVi: 'Chuối chín thơm lừng',
    color: '#facc15',
    vocabPhraseEn: 'a ripe golden bunch of island bananas rich in natural energy',
    vocabPhraseVi: 'nải chuối chín vàng ươm tràn đầy năng lượng tự nhiên',
  },
  papaya: {
    kind: 'papaya',
    nameEn: 'Coral-Blush Island Papaya',
    nameVi: 'Đu đủ chín mọng',
    color: '#ea6a2a',
    vocabPhraseEn: 'velvety amber papaya with a gentle tropical aroma',
    vocabPhraseVi: 'đu đủ chín màu hổ phách mềm mịn mang hương thơm nhiệt đới',
  },
});

export interface FruitTreeSpec {
  id: string;
  kind: FruitKind;
  islandId: string;
  x: number;
  z: number;
  yaw?: number;
  scale?: number;
  crownHeight: number;
  crownRadius: number;
  clusterCount: number;
}

interface RawFruitInteractable {
  id: string;
  kind: string;
  subkind?: string;
  island: string;
  x: number;
  z: number;
  yaw?: number;
}

/**
 * Exact unscaled GLB local-space crown/bough sockets `(lx, ly, lz)` measured from:
 * - `palm-coconut-curved-ccb95a8b7089.glb` (`Node[1] Coconut_0` centroid `[0.017, 7.5653, -0.0573]`, `scale = 1.05` -> `+7.94 m`)
 * - `palm-royal-tall-f05a4c869c6d.glb` (`Crownshaft` upper rosette `[0.002, 7.45, 0.004]`, `scale = 0.56` -> `+4.17 m`)
 * - `tree-banana-fruiting-a5570554e535.glb` (`BananaStemAndBunch` stalk `[+0.52, 1.98, -0.17]`, `scale = 1.05` -> `+2.08 m`)
 * - `tree-mango-fruiting-892538f42789.glb` (`MangoTrunkAndFruits` lower boughs, `scale = 1.05` -> `+2.65..3.05 m`)
 */
const LOCAL_CROWN_SOCKETS: Readonly<Record<FruitKind, readonly (readonly [number, number, number])[]>> = Object.freeze({
  coconut: [
    [0.217, 7.56, -0.057],
    [-0.083, 7.53, 0.116],
    [-0.083, 7.58, -0.23],
  ],
  papaya: [
    [0.292, 7.46, 0.004],
    [-0.143, 7.42, 0.255],
    [-0.143, 7.48, -0.247],
  ],
  banana: [
    [0.47, 2.11, -0.16],
    [0.52, 1.98, -0.18],
    [0.56, 1.84, -0.15],
  ],
  mango: [
    [1.14, 2.86, 0.72],
    [-1.06, 2.9, -0.34],
    [0.18, 2.52, 1.25],
    [-0.78, 2.58, -0.94],
  ],
});

function defaultScaleForFruitKind(kind: FruitKind): number {
  return kind === 'papaya' ? 0.56 : 1.05;
}

function defaultWindAmpForFruitKind(kind: FruitKind): number {
  if (kind === 'coconut') return 0.068;
  if (kind === 'papaya') return 0.058;
  if (kind === 'banana') return 0.052;
  return 0.048;
}

function buildFruitTreesFromLayout(): readonly FruitTreeSpec[] {
  const raw = (arenaLayout.interactables as readonly RawFruitInteractable[]).filter(
    i => i.kind === 'fruit_tree',
  );
  if (raw.length > 0) {
    return raw.map((i, idx) => {
      const fk: FruitKind =
        i.subkind === 'mango' || i.subkind === 'banana' || i.subkind === 'papaya'
          ? i.subkind
          : 'coconut';
      const scale = defaultScaleForFruitKind(fk);
      return {
        id: i.id,
        kind: fk,
        islandId: i.island,
        x: i.x,
        z: i.z,
        yaw: i.yaw ?? idx * 1.3,
        scale,
        crownHeight: fk === 'coconut' ? 7.94 : fk === 'papaya' ? 4.17 : fk === 'banana' ? 2.08 : 2.85,
        crownRadius: fk === 'mango' ? 1.28 : fk === 'banana' ? 0.56 : 0.22,
        clusterCount: LOCAL_CROWN_SOCKETS[fk].length,
      };
    });
  }
  return [
    { id: 'fruit-beach-coconut-1', kind: 'coconut', islandId: 'tropical_beach', x: 218, z: 98, yaw: 0.4, scale: 1.05, crownHeight: 7.94, crownRadius: 0.22, clusterCount: 3 },
    { id: 'fruit-beach-mango-1', kind: 'mango', islandId: 'tropical_beach', x: 172, z: 58, yaw: 0.8, scale: 1.05, crownHeight: 2.85, crownRadius: 1.28, clusterCount: 4 },
    { id: 'fruit-beach-banana-1', kind: 'banana', islandId: 'tropical_beach', x: 162, z: 82, yaw: 2.1, scale: 1.05, crownHeight: 2.08, crownRadius: 0.56, clusterCount: 3 },
    { id: 'fruit-beach-papaya-1', kind: 'papaya', islandId: 'tropical_beach', x: 198, z: 82, yaw: -0.4, scale: 0.56, crownHeight: 4.17, crownRadius: 0.18, clusterCount: 3 },
  ];
}

/** Fruit-bearing trees synchronized 1:1 with `arenaLayout.interactables` (`kind === 'fruit_tree'`). */
export const DEFAULT_FRUIT_TREES: readonly FruitTreeSpec[] = Object.freeze(buildFruitTreesFromLayout());

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function normalizeAccountScope(account: string | number | null | undefined): string {
  if (account === null || account === undefined || account === '') return 'guest';
  return String(account).trim() || 'guest';
}

export function fruitLogStorageKey(account: string | number | null | undefined): string {
  return `${FRUIT_LOG_KEY_PREFIX}${normalizeAccountScope(account)}`;
}

export function createEmptyFruitHarvestLog(): FruitHarvestLog {
  return {
    coconut: 0,
    mango: 0,
    banana: 0,
    papaya: 0,
  };
}

/** Load account-scoped `FruitHarvestLog` safely from `localStorage`. */
export function loadFruitHarvestLog(account: string | number | null | undefined): FruitHarvestLog {
  const base = createEmptyFruitHarvestLog();
  if (typeof window === 'undefined') return base;
  try {
    const raw = window.localStorage.getItem(fruitLogStorageKey(account));
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<FruitHarvestLog> | null;
    if (!parsed || typeof parsed !== 'object') return base;
    for (const k of FRUIT_KINDS) {
      if (typeof parsed[k] === 'number' && Number.isFinite(parsed[k])) {
        base[k] = Math.max(0, Math.floor(parsed[k]!));
      }
    }
    return base;
  } catch {
    return base;
  }
}

/** Increment collected fruit count in the learner's account-scoped `FruitHarvestLog`. */
export function recordFruitCollected(
  account: string | number | null | undefined,
  kind: FruitKind,
  amount = 1,
): FruitHarvestLog {
  const current = loadFruitHarvestLog(account);
  current[kind] = (current[kind] ?? 0) + Math.max(1, Math.floor(amount));
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(fruitLogStorageKey(account), JSON.stringify(current));
    } catch {
      /* storage quota full — keep session count */
    }
  }
  return current;
}

export interface FruitCollectEvent {
  kind: FruitKind;
  spec: FruitSpec;
  countOfKind: number;
  totalHarvested: number;
  toastEn: string;
  toastVi: string;
}

export interface FruitPromptAction {
  kind: 'shake_tree' | 'collect_fruit';
  targetId: string;
  fruitKind: FruitKind;
  x: number;
  z: number;
  labelEn: string;
  labelVi: string;
}

// ============================================================================
// Sculpted Fallback 3D Fruit Geometries (used before/without GLB fetch)
// ============================================================================

function buildFallbackFruitGeometry(kind: FruitKind): T.BufferGeometry {
  if (kind === 'coconut') {
    const geo = new T.SphereGeometry(0.118, 12, 10);
    geo.scale(0.92, 1.08, 0.92);
    return geo;
  }
  if (kind === 'mango') {
    const geo = new T.SphereGeometry(0.095, 12, 10);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const taper = y < 0 ? 1 + y * 2.2 : 1;
      const curve = y < 0 ? Math.pow(-y * 6, 1.4) * 0.022 : 0;
      pos.setXYZ(i, pos.getX(i) * Math.max(0.45, taper) + curve, y * 1.28, pos.getZ(i) * 0.8);
    }
    geo.computeVertexNormals();
    return geo;
  }
  if (kind === 'banana') {
    const curve = new T.CatmullRomCurve3([
      new T.Vector3(0, 0.11, 0),
      new T.Vector3(0.048, 0.035, 0.012),
      new T.Vector3(0.052, -0.045, 0.012),
      new T.Vector3(0.008, -0.11, 0),
    ]);
    const geo = new T.TubeGeometry(curve, 8, 0.034, 6, true);
    geo.center();
    return geo;
  }
  const geo = new T.SphereGeometry(0.115, 12, 10);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ang = Math.atan2(z, x);
    const rib = 1 + 0.06 * Math.cos(ang * 5);
    const pear = y > 0 ? 0.72 + (1 - y / 0.115) * 0.28 : 1.06;
    pos.setXYZ(i, x * rib * pear, y * 1.32, z * rib * pear);
  }
  geo.computeVertexNormals();
  return geo;
}

function shakeLabels(kind: FruitKind): { en: string; vi: string } {
  switch (kind) {
    case 'coconut':
      return { en: 'Shake coconut palm', vi: 'Rung cây dừa' };
    case 'mango':
      return { en: 'Shake mango tree', vi: 'Rung cây xoài' };
    case 'banana':
      return { en: 'Harvest ripe bananas', vi: 'Rung buồng chuối chín' };
    case 'papaya':
      return { en: 'Shake papaya tree', vi: 'Rung cây đu đủ' };
  }
}

interface CrownSocketState {
  restX: number;
  restY: number;
  restZ: number;
  yaw: number;
  attached: boolean;
}

interface TreeRuntimeState {
  spec: FruitTreeSpec;
  groundY: number;
  trunkBaseX: number;
  trunkBaseZ: number;
  windAmp: number;
  sockets: CrownSocketState[];
  availableCount: number;
  regrowTimer: number;
  shakeAge: number;
  shakeDirX: number;
  shakeDirZ: number;
}

export interface DroppedFruitSlot {
  active: boolean;
  settled: boolean;
  id: string;
  kind: FruitKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  shakerX: number;
  shakerZ: number;
  sandy: boolean;
  bounces: number;
  spinPitch: number;
  spinYaw: number;
  spinRoll: number;
  angVelX: number;
  angVelZ: number;
  age: number;
  landedAge: number;
}

export interface FruitStepContext {
  dt: number;
  time: number;
  playerX: number;
  playerY: number;
  playerZ: number;
  lookYaw: number;
  listenerX: number;
  listenerZ: number;
  listenerYaw: number;
  ambience?: ArenaAmbience;
}

/**
 * Exact CPU counterpart of `arenaMaterials.ts` GPU vegetation wind sway (`applyWindSway`),
 * keeping hanging crown fruits locked 1:1 to swaying fronds and leaves.
 */
function sampleCrownWindSway(
  wx: number,
  wy: number,
  wz: number,
  time: number,
  windAmp: number,
  out: { dx: number; dy: number; dz: number },
): void {
  const hMask = clamp((wy + 0.45) * 0.26, 0, 1.45);
  const branchPh = time * 1.55 + wx * 0.36 + wz * 0.29;
  const branchX = (Math.sin(branchPh) + 0.42 * Math.sin(time * 2.75 - wz * 0.68)) * windAmp * hMask;
  const branchZ = Math.cos(time * 1.32 + wz * 0.35 + wx * 0.24) * (windAmp * 0.74) * hMask;
  out.dx = branchX;
  out.dz = branchZ;
  out.dy = -0.18 * (branchX * branchX + branchZ * branchZ);
}

const GLB_FRUIT_NODE_NAMES: Readonly<Record<FruitKind, string>> = Object.freeze({
  coconut: 'Fruit_Coconut',
  mango: 'Fruit_Mango',
  banana: 'Fruit_Banana',
  papaya: 'Fruit_Papaya',
});

export class ArenaFruitTrees {
  private accountScope: string;
  private harvestLog: FruitHarvestLog;
  private disposed = false;
  private lowMode: boolean;
  private lastTime = 0;
  private readonly group = new T.Group();
  private readonly trees: TreeRuntimeState[];
  private readonly meshes = new Map<FruitKind, T.InstancedMesh>();
  private readonly geometries = new Map<FruitKind, T.BufferGeometry>();
  private readonly ownedMaterials = new Set<T.Material>();
  private readonly ownedTextures = new Set<T.Texture>();
  private readonly radii: Record<FruitKind, number> = {
    coconut: 0.118,
    mango: 0.092,
    banana: 0.082,
    papaya: 0.122,
  };
  private readonly writeCounts: Record<FruitKind, number> = {
    coconut: 0,
    mango: 0,
    banana: 0,
    papaya: 0,
  };

  private readonly droppedPool: DroppedFruitSlot[] = Array.from({ length: MAX_DROPPED_FRUITS }, (_, idx) => ({
    active: false,
    settled: false,
    id: `dropped-fruit-${idx}`,
    kind: 'coconut',
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    shakerX: 0,
    shakerZ: 0,
    sandy: true,
    bounces: 0,
    spinPitch: 0,
    spinYaw: 0,
    spinRoll: 0,
    angVelX: 0,
    angVelZ: 0,
    age: 0,
    landedAge: 0,
  }));
  private dropCursor = 0;

  private readonly dummyMat = new T.Matrix4();
  private readonly dummyPos = new T.Vector3();
  private readonly dummyEuler = new T.Euler();
  private readonly dummyQuat = new T.Quaternion();
  private readonly dummyScale = new T.Vector3();
  private readonly swayScratch = { dx: 0, dy: 0, dz: 0 };

  private readonly onCollect?: (event: FruitCollectEvent) => void;
  private readonly onTreeShake?: (tree: FruitTreeSpec) => void;
  readonly readyPromise: Promise<void>;

  constructor(
    private readonly scene: T.Scene,
    account: string | number | null | undefined = 'guest',
    options?: {
      trees?: readonly FruitTreeSpec[];
      low?: boolean;
      onCollect?: (event: FruitCollectEvent) => void;
      onTreeShake?: (tree: FruitTreeSpec) => void;
    },
  ) {
    this.accountScope = normalizeAccountScope(account);
    this.harvestLog = loadFruitHarvestLog(this.accountScope);
    this.lowMode = Boolean(options?.low);
    this.onCollect = options?.onCollect;
    this.onTreeShake = options?.onTreeShake;
    this.group.name = 'ArenaFruitTrees';

    const specs = options?.trees ?? DEFAULT_FRUIT_TREES;
    const tmpLocal = new T.Vector3();
    const tmpRot = new T.Euler();

    this.trees = specs.map((spec, idx) => {
      const groundY = arenaHeight(spec.x, spec.z);
      const yaw = spec.yaw ?? idx * 1.3;
      const scale = spec.scale ?? defaultScaleForFruitKind(spec.kind);
      tmpRot.set(0, yaw, 0);

      // Curved coconut palm trunk meets sand at local (-0.541, 0, -0.086); straight stems meet near (0, 0, 0).
      if (spec.kind === 'coconut') {
        tmpLocal.set(-0.541 * scale, 0, -0.086 * scale).applyEuler(tmpRot);
      } else {
        tmpLocal.set(0, 0, 0);
      }
      const trunkBaseX = spec.x + tmpLocal.x;
      const trunkBaseZ = spec.z + tmpLocal.z;

      const templateSockets = LOCAL_CROWN_SOCKETS[spec.kind];
      const count = Math.max(1, spec.clusterCount || templateSockets.length);
      const sockets: CrownSocketState[] = [];
      for (let c = 0; c < count; c++) {
        if (spec.yaw !== undefined || specs === DEFAULT_FRUIT_TREES) {
          const [lx, ly, lz] = templateSockets[c % templateSockets.length];
          tmpLocal.set(lx * scale, ly * scale, lz * scale).applyEuler(tmpRot);
          sockets.push({
            restX: spec.x + tmpLocal.x,
            restY: groundY + tmpLocal.y,
            restZ: spec.z + tmpLocal.z,
            yaw: yaw + (c / count) * Math.PI * 2,
            attached: true,
          });
        } else {
          // Custom synthetic test tree spec without GLB yaw: honour explicit `crownHeight` & `crownRadius`
          const ang = (c / count) * Math.PI * 2 + idx * 0.7;
          sockets.push({
            restX: spec.x + Math.cos(ang) * spec.crownRadius,
            restY: groundY + spec.crownHeight,
            restZ: spec.z + Math.sin(ang) * spec.crownRadius,
            yaw: ang,
            attached: true,
          });
        }
      }

      return {
        spec,
        groundY,
        trunkBaseX,
        trunkBaseZ,
        windAmp: defaultWindAmpForFruitKind(spec.kind),
        sockets,
        availableCount: sockets.length,
        regrowTimer: 0,
        shakeAge: 99,
        shakeDirX: 1,
        shakeDirZ: 0,
      };
    });

    for (const kind of FRUIT_KINDS) {
      let canopySlots = 0;
      for (const t of this.trees) {
        if (t.spec.kind === kind) canopySlots += t.sockets.length;
      }
      const capacity = Math.max(8, canopySlots + MAX_DROPPED_FRUITS);
      const geo = buildFallbackFruitGeometry(kind);
      const fSpec = FRUIT_SPECS[kind];
      const mat = new T.MeshStandardMaterial({
        color: fSpec.color,
        roughness: kind === 'coconut' ? 0.84 : 0.42,
        metalness: 0.04,
      });
      const inst = new T.InstancedMesh(geo, mat, capacity);
      inst.name = `ArenaFruits_${kind}`;
      inst.instanceMatrix.setUsage(T.DynamicDrawUsage);
      inst.castShadow = !this.lowMode;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      inst.count = 0;

      this.geometries.set(kind, geo);
      this.ownedMaterials.add(mat);
      this.meshes.set(kind, inst);
      this.group.add(inst);
    }

    scene.add(this.group);
    this.syncCrownAndDroppedInstances(0);

    if (typeof window !== 'undefined') {
      const loader = new GLTFLoader();
      this.readyPromise = loader
        .loadAsync(arenaV7Assets.props.fruits.lod0)
        .then(gltf => {
          if (this.disposed) {
            this.disposeLoadedScene(gltf.scene);
            return;
          }
          gltf.scene.updateMatrixWorld(true);
          const rotOnly = new T.Matrix4();
          const scaleVec = new T.Vector3();
          const quatTmp = new T.Quaternion();
          const posTmp = new T.Vector3();

          for (const kind of FRUIT_KINDS) {
            const rootNode = gltf.scene.getObjectByName(GLB_FRUIT_NODE_NAMES[kind]);
            let srcMesh: T.Mesh | null = null;
            rootNode?.traverse(o => {
              if (!srcMesh && (o as T.Mesh).isMesh) srcMesh = o as T.Mesh;
            });
            if (!srcMesh) continue;

            const m = srcMesh as T.Mesh;
            const clonedGeo = m.geometry.clone();
            m.matrixWorld.decompose(posTmp, quatTmp, scaleVec);
            rotOnly.compose(posTmp.set(0, 0, 0), quatTmp, scaleVec);
            clonedGeo.applyMatrix4(rotOnly);
            clonedGeo.computeBoundingBox();
            if (clonedGeo.boundingBox) {
              const sizeY = clonedGeo.boundingBox.max.y - clonedGeo.boundingBox.min.y;
              const sizeXZ = Math.max(
                clonedGeo.boundingBox.max.x - clonedGeo.boundingBox.min.x,
                clonedGeo.boundingBox.max.z - clonedGeo.boundingBox.min.z,
              );
              this.radii[kind] = clamp(Math.max(sizeY, sizeXZ) * 0.48, 0.065, 0.16);
              clonedGeo.center();
            }

            const inst = this.meshes.get(kind);
            if (!inst) {
              clonedGeo.dispose();
              continue;
            }
            const prevGeo = this.geometries.get(kind);
            inst.geometry = clonedGeo;
            this.geometries.set(kind, clonedGeo);
            prevGeo?.dispose();

            const mats = Array.isArray(m.material) ? m.material : [m.material];
            if (mats[0]) {
              inst.material = m.material;
              for (const mat of mats) {
                this.ownedMaterials.add(mat);
                for (const v of Object.values(mat)) {
                  if (v instanceof T.Texture) this.ownedTextures.add(v);
                }
              }
            }
          }
          // Dispose unused geometry buffers inside the raw template scene
          gltf.scene.traverse(o => {
            if ((o as T.Mesh).isMesh) (o as T.Mesh).geometry.dispose();
          });
        })
        .catch(() => {});
    } else {
      this.readyPromise = Promise.resolve();
    }
  }

  private disposeLoadedScene(root: T.Object3D): void {
    root.traverse(o => {
      const m = o as T.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        for (const v of Object.values(mat)) {
          if (v instanceof T.Texture) v.dispose();
        }
        mat.dispose();
      }
    });
  }

  /** Switch quality tier in place without context churn. */
  setQuality(low: boolean): void {
    this.lowMode = low;
    for (const inst of this.meshes.values()) {
      inst.castShadow = !low;
    }
  }

  /** Switch learner account scope cleanly (`AGENTS.md §21` P0 isolation). */
  setAccount(account: string | number | null | undefined): void {
    const next = normalizeAccountScope(account);
    if (next === this.accountScope) return;
    this.accountScope = next;
    this.harvestLog = loadFruitHarvestLog(this.accountScope);
  }

  getHarvestLog(): Readonly<FruitHarvestLog> {
    return this.harvestLog;
  }

  getDroppedPool(): readonly DroppedFruitSlot[] {
    return this.droppedPool;
  }

  getTreesSnapshot(): readonly {
    id: string;
    kind: FruitKind;
    availableCount: number;
    sockets: readonly Readonly<CrownSocketState>[];
  }[] {
    return this.trees.map(t => ({
      id: t.spec.id,
      kind: t.spec.kind,
      availableCount: t.availableCount,
      sockets: t.sockets,
    }));
  }

  /**
   * Evaluate the highest-priority fruit interaction within reach of `(px, py, pz)`:
   * 1. Dropped ripe fruit on the ground within `2.25 m` (once it has made ground contact)
   * 2. Ripe fruit tree trunk within `3.25 m` (`Shake coconut palm` / `Rung cây dừa`)
   */
  getContextualAction(px: number, py: number, pz: number, lookYaw: number): FruitPromptAction | null {
    const fwdX = Math.sin(lookYaw);
    const fwdZ = Math.cos(lookYaw);

    // 1. Nearby dropped fruit ready to pick up
    let bestDrop: DroppedFruitSlot | null = null;
    let bestDropDist = 2.25;
    for (let i = 0; i < MAX_DROPPED_FRUITS; i++) {
      const d = this.droppedPool[i];
      if (!d.active || (d.bounces < 1 && !d.settled) || d.landedAge < 0.12) continue;
      const dist = Math.hypot(d.x - px, d.z - pz);
      if (dist < bestDropDist && Math.abs(d.y - py) < 1.5) {
        bestDropDist = dist;
        bestDrop = d;
      }
    }
    if (bestDrop) {
      const fSpec = FRUIT_SPECS[bestDrop.kind];
      return {
        kind: 'collect_fruit',
        targetId: bestDrop.id,
        fruitKind: bestDrop.kind,
        x: bestDrop.x,
        z: bestDrop.z,
        labelEn: `Collect ${fSpec.nameEn.toLowerCase()}`,
        labelVi: `Nhặt ${fSpec.nameVi.toLowerCase()}`,
      };
    }

    // 2. Nearby fruit-bearing tree with ripe fruit on its crown
    let bestTree: TreeRuntimeState | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < this.trees.length; i++) {
      const tr = this.trees[i];
      if (tr.availableCount <= 0) continue;
      const dxSpec = tr.spec.x - px;
      const dzSpec = tr.spec.z - pz;
      const distSpec = Math.hypot(dxSpec, dzSpec);
      const distTrunk = Math.hypot(tr.trunkBaseX - px, tr.trunkBaseZ - pz);
      const dist = Math.min(distSpec, distTrunk);
      if (dist > 3.25 || Math.abs(tr.groundY - py) > 1.75) continue;
      const dx = distTrunk < distSpec ? tr.trunkBaseX - px : dxSpec;
      const dz = distTrunk < distSpec ? tr.trunkBaseZ - pz : dzSpec;
      const normD = Math.max(0.001, Math.hypot(dx, dz));
      const dot = dist < 0.7 ? 1 : (dx / normD) * fwdX + (dz / normD) * fwdZ;
      if (dot < -0.35 && dist > 1.45) continue;
      const score = (1 - dist / 3.25) * 1.4 + Math.max(0, dot) * 0.8;
      if (score > bestScore) {
        bestScore = score;
        bestTree = tr;
      }
    }

    if (bestTree) {
      const lbl = shakeLabels(bestTree.spec.kind);
      return {
        kind: 'shake_tree',
        targetId: bestTree.spec.id,
        fruitKind: bestTree.spec.kind,
        x: bestTree.trunkBaseX,
        z: bestTree.trunkBaseZ,
        labelEn: lbl.en,
        labelVi: lbl.vi,
      };
    }

    return null;
  }

  /** Trigger `KeyE` / tap interaction on the nearest eligible fruit tree or dropped ground fruit. */
  triggerInteraction(
    px: number,
    py: number,
    pz: number,
    lookYaw: number,
    ambience?: ArenaAmbience,
  ): boolean {
    const act = this.getContextualAction(px, py, pz, lookYaw);
    if (!act) return false;

    if (act.kind === 'collect_fruit') {
      for (let i = 0; i < MAX_DROPPED_FRUITS; i++) {
        const d = this.droppedPool[i];
        if (d.active && d.id === act.targetId) {
          this.collectSlot(d, ambience);
          return true;
        }
      }
      return false;
    }

    const treeState = this.trees.find(t => t.spec.id === act.targetId);
    if (!treeState || treeState.availableCount <= 0) return false;

    const pushDx = treeState.trunkBaseX - px;
    const pushDz = treeState.trunkBaseZ - pz;
    const pushLen = Math.hypot(pushDx, pushDz) || 1;
    treeState.shakeDirX = pushDx / pushLen;
    treeState.shakeDirZ = pushDz / pushLen;
    treeState.shakeAge = 0;

    // Detach 1..2 ripe crown sockets directly from their live world crown coordinates
    const attachedIndices: number[] = [];
    for (let s = 0; s < treeState.sockets.length; s++) {
      if (treeState.sockets[s].attached) attachedIndices.push(s);
    }
    const dropCount = Math.min(attachedIndices.length, 1 + Math.floor(Math.random() * 2));
    const playerBearing = Math.atan2(px - treeState.spec.x, pz - treeState.spec.z);

    for (let k = 0; k < dropCount; k++) {
      const sockIdx = attachedIndices[k];
      const sock = treeState.sockets[sockIdx];
      sock.attached = false;
      treeState.availableCount = Math.max(0, treeState.availableCount - 1);

      sampleCrownWindSway(sock.restX, sock.restY, sock.restZ, this.lastTime, treeState.windAmp, this.swayScratch);
      const startX = sock.restX + this.swayScratch.dx;
      const startY = sock.restY + this.swayScratch.dy;
      const startZ = sock.restZ + this.swayScratch.dz;

      // Choose an outward walkable landing arc clear of direct drop onto the shaker's head
      const sideSign = k % 2 === 0 ? 1 : -1;
      let chosenAngle = playerBearing + sideSign * (1.05 + Math.random() * 0.65);
      let landX = startX + Math.sin(chosenAngle) * 1.65;
      let landZ = startZ + Math.cos(chosenAngle) * 1.65;
      for (const tryStep of [0, 0.75, -0.75, 1.5, -1.5, Math.PI]) {
        const candAngle = chosenAngle + tryStep;
        const candDist = 1.45 + Math.random() * 0.65;
        const tx = startX + Math.sin(candAngle) * candDist;
        const tz = startZ + Math.cos(candAngle) * candDist;
        if (arenaDryWalkable(tx, tz) && Math.hypot(tx - px, tz - pz) > 0.95) {
          chosenAngle = candAngle;
          landX = tx;
          landZ = tz;
          break;
        }
      }

      const targetGroundY = arenaFloor(landX, landZ);
      const fallTime = Math.sqrt(Math.max(0.25, (2 * Math.max(0.5, startY - targetGroundY)) / GRAVITY));
      const slot = this.findAvailableDropSlot();

      slot.active = true;
      slot.settled = false;
      slot.kind = treeState.spec.kind;
      slot.x = startX;
      slot.y = startY;
      slot.z = startZ;
      slot.vx = clamp((landX - startX) / fallTime, -2.4, 2.4);
      slot.vz = clamp((landZ - startZ) / fallTime, -2.4, 2.4);
      slot.vy = 0.25 + Math.random() * 0.35;
      slot.shakerX = px;
      slot.shakerZ = pz;
      slot.sandy =
        treeState.spec.islandId === 'tropical_beach' ||
        treeState.spec.islandId === 'coral_lagoon' ||
        !arenaOnWood(landX, landZ);
      slot.bounces = 0;
      slot.spinPitch = (Math.random() - 0.5) * 0.5;
      slot.spinYaw = sock.yaw;
      slot.spinRoll = (Math.random() - 0.5) * 0.5;
      slot.angVelX = (Math.random() - 0.5) * 5.2;
      slot.angVelZ = (Math.random() - 0.5) * 5.2;
      slot.age = 0;
      slot.landedAge = 0;
    }

    if (treeState.availableCount < treeState.sockets.length && treeState.regrowTimer <= 0) {
      treeState.regrowTimer = REGROW_SECONDS;
    }

    ambience?.treeShake(treeState.trunkBaseX, treeState.trunkBaseZ, px, pz, lookYaw);
    this.onTreeShake?.(treeState.spec);
    return true;
  }

  private findAvailableDropSlot(): DroppedFruitSlot {
    for (let n = 0; n < MAX_DROPPED_FRUITS; n++) {
      const idx = (this.dropCursor + n) % MAX_DROPPED_FRUITS;
      if (!this.droppedPool[idx].active) {
        this.dropCursor = (idx + 1) % MAX_DROPPED_FRUITS;
        return this.droppedPool[idx];
      }
    }
    // Recycle oldest settled fruit if all 48 slots are active
    let oldestIdx = 0;
    let oldestAge = -1;
    for (let i = 0; i < MAX_DROPPED_FRUITS; i++) {
      if (this.droppedPool[i].age > oldestAge) {
        oldestAge = this.droppedPool[i].age;
        oldestIdx = i;
      }
    }
    this.dropCursor = (oldestIdx + 1) % MAX_DROPPED_FRUITS;
    return this.droppedPool[oldestIdx];
  }

  private collectSlot(slot: DroppedFruitSlot, ambience?: ArenaAmbience): void {
    slot.active = false;
    slot.settled = false;
    this.harvestLog = recordFruitCollected(this.accountScope, slot.kind, 1);
    ambience?.interactCue(true);

    if (this.onCollect) {
      const spec = FRUIT_SPECS[slot.kind];
      const totalHarvested =
        this.harvestLog.coconut +
        this.harvestLog.mango +
        this.harvestLog.banana +
        this.harvestLog.papaya;
      this.onCollect({
        kind: slot.kind,
        spec,
        countOfKind: this.harvestLog[slot.kind],
        totalHarvested,
        toastEn: `Collected ${spec.nameEn} (${this.harvestLog[slot.kind]}) — ${spec.vocabPhraseEn}`,
        toastVi: `Đã thu hoạch ${spec.nameVi} (${this.harvestLog[slot.kind]}) · "${spec.vocabPhraseEn}"`,
      });
    }
  }

  private stepDroppedFruitPhysics(d: DroppedFruitSlot, dt: number, ctx: FruitStepContext): void {
    const radius = this.radii[d.kind];
    const subSteps = Math.max(1, Math.ceil(dt / MAX_PHYSICS_SUBSTEP));
    const subDt = dt / subSteps;
    const eps = 0.2;

    for (let s = 0; s < subSteps; s++) {
      if (d.settled) break;

      const prevX = d.x;
      const prevZ = d.z;
      d.vy -= GRAVITY * subDt;
      d.x += d.vx * subDt;
      d.y += d.vy * subDt;
      d.z += d.vz * subDt;

      const floorHere = arenaFloor(d.x, d.z);
      // Soft shallow-water float & drag if a coconut rolls onto the shoreline surf
      if (!arenaOnWood(d.x, d.z) && floorHere < ARENA_WATER_Y - 0.14 && d.y <= ARENA_WATER_Y) {
        d.y = ARENA_WATER_Y - radius * 0.2;
        const waterDrag = Math.exp(-5.5 * subDt);
        d.vx *= waterDrag;
        d.vz *= waterDrag;
        d.vy = 0;
        d.bounces = Math.max(1, d.bounces);
        if (Math.hypot(d.vx, d.vz) < 0.04) {
          d.vx = d.vz = 0;
          d.settled = true;
        }
        continue;
      }

      const contactY = floorHere + radius * 0.92;
      if (d.y > contactY) {
        d.spinPitch += d.angVelX * subDt;
        d.spinRoll += d.angVelZ * subDt;
        continue;
      }

      // Prevent rolling through solid trunks, planters, or boulders
      if (!arenaDryWalkable(d.x, d.z) && floorHere > ARENA_WATER_Y - 0.05) {
        d.x = prevX;
        d.z = prevZ;
        d.vx *= -0.35;
        d.vz *= -0.35;
      }

      const settledFloor = arenaFloor(d.x, d.z);
      d.y = settledFloor + radius * 0.92;
      const gx = (arenaFloor(d.x + eps, d.z) - arenaFloor(d.x - eps, d.z)) / (2 * eps);
      const gz = (arenaFloor(d.x, d.z + eps) - arenaFloor(d.x, d.z - eps)) / (2 * eps);
      const invN = 1 / Math.hypot(gx, 1, gz);
      const nx = -gx * invN;
      const ny = invN;
      const nz = -gz * invN;

      const vn = d.vx * nx + d.vy * ny + d.vz * nz;
      if (vn < -0.48 && d.bounces < 4) {
        const restitution = d.sandy ? 0.26 : 0.44;
        const friction = d.sandy ? 0.36 : 0.18;
        const tx = d.vx - vn * nx;
        const ty = d.vy - vn * ny;
        const tz = d.vz - vn * nz;
        d.vx = tx * (1 - friction) - restitution * vn * nx;
        d.vy = ty * (1 - friction) - restitution * vn * ny;
        d.vz = tz * (1 - friction) - restitution * vn * nz;
        d.angVelX = d.vz / radius;
        d.angVelZ = -d.vx / radius;
        d.bounces++;
        ctx.ambience?.fruitDrop(
          d.x,
          d.z,
          ctx.listenerX,
          ctx.listenerZ,
          ctx.listenerYaw,
          clamp(Math.abs(vn) / 7.5, 0.2, 0.85),
          d.sandy,
        );
      } else {
        // Slope rolling (`a = (5/7) g sin(theta)`) + viscous & Coulomb sandy rolling resistance
        d.bounces = Math.max(1, d.bounces);
        d.vy = 0;
        const slopeAccel = (5 / 7) * GRAVITY;
        d.vx += -gx * ny * slopeAccel * subDt;
        d.vz += -gz * ny * slopeAccel * subDt;
        const rollDamp = Math.exp(-(d.sandy ? 3.2 : 1.6) * subDt);
        d.vx *= rollDamp;
        d.vz *= rollDamp;

        const speedBeforeCoulomb = Math.hypot(d.vx, d.vz);
        const coulombDecel = (d.sandy ? 0.145 : 0.065) * GRAVITY * subDt;
        if (speedBeforeCoulomb <= coulombDecel) {
          d.vx = 0;
          d.vz = 0;
        } else {
          const scaleV = (speedBeforeCoulomb - coulombDecel) / speedBeforeCoulomb;
          d.vx *= scaleV;
          d.vz *= scaleV;
        }

        d.spinPitch += (d.vz * subDt) / radius;
        d.spinRoll -= (d.vx * subDt) / radius;

        const speedH = Math.hypot(d.vx, d.vz);
        if ((speedH < 0.035 && Math.hypot(gx, gz) < 0.24) || d.landedAge > 2.6) {
          d.vx = 0;
          d.vz = 0;
          d.vy = 0;
          d.settled = true;
        }
      }
    }
  }

  private syncCrownAndDroppedInstances(time: number): void {
    this.writeCounts.coconut = 0;
    this.writeCounts.mango = 0;
    this.writeCounts.banana = 0;
    this.writeCounts.papaya = 0;

    for (let i = 0; i < this.trees.length; i++) {
      const tr = this.trees[i];
      if (tr.availableCount <= 0) continue;

      const shakeWave =
        tr.shakeAge < 1.05 ? Math.exp(-3.8 * tr.shakeAge) * Math.sin(tr.shakeAge * 26.0) * 0.16 : 0;
      const mesh = this.meshes.get(tr.spec.kind)!;

      for (let s = 0; s < tr.sockets.length; s++) {
        const sock = tr.sockets[s];
        if (!sock.attached) continue;
        sampleCrownWindSway(sock.restX, sock.restY, sock.restZ, time, tr.windAmp, this.swayScratch);
        const fx = sock.restX + this.swayScratch.dx + tr.shakeDirX * shakeWave;
        const fy = sock.restY + this.swayScratch.dy;
        const fz = sock.restZ + this.swayScratch.dz + tr.shakeDirZ * shakeWave;

        this.dummyPos.set(fx, fy, fz);
        this.dummyEuler.set(
          tr.shakeDirZ * shakeWave * 1.8,
          sock.yaw,
          -tr.shakeDirX * shakeWave * 1.8 + this.swayScratch.dx * 1.6,
        );
        this.dummyQuat.setFromEuler(this.dummyEuler);
        this.dummyScale.setScalar(1.04);
        this.dummyMat.compose(this.dummyPos, this.dummyQuat, this.dummyScale);
        const slotIdx = this.writeCounts[tr.spec.kind]++;
        mesh.setMatrixAt(slotIdx, this.dummyMat);
      }
    }

    for (let i = 0; i < MAX_DROPPED_FRUITS; i++) {
      const d = this.droppedPool[i];
      if (!d.active) continue;
      const mesh = this.meshes.get(d.kind)!;
      const fadeOut = d.age > PERSIST_SECONDS - 1.5 ? clamp((PERSIST_SECONDS - d.age) / 1.5, 0.01, 1) : 1;
      this.dummyPos.set(d.x, d.y, d.z);
      this.dummyEuler.set(d.spinPitch, d.spinYaw, d.spinRoll);
      this.dummyQuat.setFromEuler(this.dummyEuler);
      this.dummyScale.setScalar(1.06 * fadeOut);
      this.dummyMat.compose(this.dummyPos, this.dummyQuat, this.dummyScale);
      const slotIdx = this.writeCounts[d.kind]++;
      mesh.setMatrixAt(slotIdx, this.dummyMat);
    }

    for (const kind of FRUIT_KINDS) {
      const mesh = this.meshes.get(kind)!;
      const cnt = this.writeCounts[kind];
      mesh.count = cnt;
      if (cnt > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Step crown sway, regrow timers, gravity + terrain-normal bounce + slope rolling, pickup, and GPU matrices. */
  update(ctx: FruitStepContext): void {
    const dt = clamp(ctx.dt, 0.001, 0.05);
    this.lastTime = ctx.time;

    for (let i = 0; i < this.trees.length; i++) {
      const tr = this.trees[i];
      if (tr.shakeAge < 1.05) {
        tr.shakeAge += dt;
      }
      if (tr.availableCount < tr.sockets.length) {
        tr.regrowTimer -= dt;
        if (tr.regrowTimer <= 0) {
          for (let s = 0; s < tr.sockets.length; s++) tr.sockets[s].attached = true;
          tr.availableCount = tr.sockets.length;
          tr.regrowTimer = 0;
        }
      }
    }

    for (let i = 0; i < MAX_DROPPED_FRUITS; i++) {
      const d = this.droppedPool[i];
      if (!d.active) continue;
      d.age += dt;

      if (d.age >= PERSIST_SECONDS) {
        d.active = false;
        d.settled = false;
        continue;
      }

      this.stepDroppedFruitPhysics(d, dt, ctx);
      if (d.bounces >= 1 || d.settled) {
        d.landedAge += dt;
      }

      // Walk-over auto-pickup ONLY after fruit has physically settled on ground for >= 1.20 s (`E01` persistent lifecycle)
      if (
        d.settled &&
        d.landedAge >= 1.2 &&
        Math.hypot(d.x - ctx.playerX, d.z - ctx.playerZ) < 0.88 &&
        Math.abs(d.y - ctx.playerY) < 1.25 &&
        (Math.hypot(ctx.playerX - d.shakerX, ctx.playerZ - d.shakerZ) >= 0.28 || d.landedAge >= 4.5)
      ) {
        this.collectSlot(d, ctx.ambience);
      }
    }

    this.syncCrownAndDroppedInstances(ctx.time);
  }

  dispose(): void {
    this.disposed = true;
    this.scene.remove(this.group);
    for (const inst of this.meshes.values()) inst.dispose();
    for (const g of this.geometries.values()) g.dispose();
    for (const m of this.ownedMaterials) m.dispose();
    for (const t of this.ownedTextures) t.dispose();
    this.geometries.clear();
    this.ownedMaterials.clear();
    this.ownedTextures.clear();
    this.meshes.clear();
  }
}
