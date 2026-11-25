import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  RiderKinematicState,
  VehicleRiderArchetype,
  VehicleRigSockets,
} from '@/lib/embodiment/riderIk';

export type { VehicleRigSockets };

/**
 * Load-Time Zero-WASM Disjoint Triangle-Island Vehicle Rig Extractor (`vehicleRigExtractor.ts`).
 *
 * Operates once per loaded vehicle GLB prototype without modifying `.glb` files on disk
 * (preserving `verify-asset-provenance.cjs --strict` 464/464) and without cloning materials
 * (`0` extra WebGL shader programs!).
 *
 * Key repairs performed at load time:
 *  1. Splits disjoint connected triangle islands of unrigged bicycle cranksets (`surface_steel`
 *     chainring + `surface_graphite` / `surface_rubber` cranks, pedals, and kickstand) into real
 *     articulated `pivot_crank`, counter-rotating `pivot_pedal_L` (`+X` -> `.L`) and
 *     `pivot_pedal_R` (`-X` -> `.R`) at the exact mesh crank throw (`0.107 m` / `0.110 m`),
 *     and retractable `pivot_kickstand` (`0 -> -1.22 rad`).
 *  2. Extracts the bicycle saddle mesh (`surface_walnut` / `Saddle`) into an articulated
 *     `pivot_seatpost` (`±8 cm` per-rider virtual seat-post adjustment so short/tall CAZ presets
 *     and all 3 rig families reach BDC cleanly with `<= 1 mm` pelvis-to-saddle contact).
 *  3. Synthesizes the missing `pivot_fork` steering hierarchy on `veh_bike_touring` (reparenting
 *     front stem, handlebars, front fork blades, `pivot_front_wheel`, and grip sockets).
 *  4. Computes `wheelGroundY` strictly from tire geometry (never from deployed kickstands,
 *     eliminating the `+24.6 cm` mid-air float on `bicycle-817f32877dda.glb`).
 *  5. Binds handlebar / steering-wheel grip and foot sockets strictly by **vehicle-local X sign**
 *     (`localX > 0` -> rider's anatomical `.L`, `localX < 0` -> rider's anatomical `.R`),
 *     eliminating X-crossed arms/legs from Blender front-view `anchor_grip_left`/`anchor_hand_left` names.
 *  6. Calibrates roof-safe `anchor_driver` (`halo_vector` coupe clearance) and car steering-wheel sockets.
 */

interface ConnectedIsland {
  readonly triIndices: number[];
  readonly min: T.Vector3;
  readonly max: T.Vector3;
  readonly center: T.Vector3;
  readonly vertexCount: number;
}

interface VehicleModelMeta {
  readonly archetype: VehicleRiderArchetype;
  readonly hasPedals: boolean;
  readonly isCar: boolean;
  readonly gearRatio: number;
  readonly fallbackWheelRadius: number;
  readonly fallbackWheelbase: number;
  readonly openTop?: boolean;
  readonly calibratedSeatY?: number;
  readonly calibratedSeatZOffset?: number;
}

const MODEL_META: Record<string, VehicleModelMeta> = {
  veh_bike_basket: {
    archetype: 'cruiser_bike',
    hasPedals: true,
    isCar: false,
    gearRatio: 2.35,
    fallbackWheelRadius: 0.337,
    fallbackWheelbase: 1.09,
  },
  bicycle: {
    archetype: 'cruiser_bike',
    hasPedals: true,
    isCar: false,
    gearRatio: 2.35,
    fallbackWheelRadius: 0.337,
    fallbackWheelbase: 1.09,
  },
  veh_ebike_commuter: {
    archetype: 'cruiser_bike',
    hasPedals: true,
    isCar: false,
    gearRatio: 2.45,
    fallbackWheelRadius: 0.327,
    fallbackWheelbase: 1.13,
  },
  veh_bike_cargo: {
    archetype: 'cruiser_bike',
    hasPedals: true,
    isCar: false,
    gearRatio: 2.20,
    fallbackWheelRadius: 0.300,
    fallbackWheelbase: 1.44,
    calibratedSeatZOffset: 0.09,
  },
  veh_bike_road: {
    archetype: 'road_bike',
    hasPedals: true,
    isCar: false,
    gearRatio: 2.55,
    fallbackWheelRadius: 0.340,
    fallbackWheelbase: 1.02,
  },
  veh_bike_touring: {
    archetype: 'road_bike',
    hasPedals: true,
    isCar: false,
    gearRatio: 2.45,
    fallbackWheelRadius: 0.337,
    fallbackWheelbase: 1.12,
  },
  veh_bike_velodrome: {
    archetype: 'track_bike',
    hasPedals: true,
    isCar: false,
    gearRatio: 2.75,
    fallbackWheelRadius: 0.339,
    fallbackWheelbase: 0.98,
  },
  veh_scooter_electric: {
    archetype: 'step_scooter',
    hasPedals: false,
    isCar: false,
    gearRatio: 0,
    fallbackWheelRadius: 0.201,
    fallbackWheelbase: 1.11,
    calibratedSeatZOffset: 0.11,
  },
  scooter_ev: {
    archetype: 'step_scooter',
    hasPedals: false,
    isCar: false,
    gearRatio: 0,
    fallbackWheelRadius: 0.245,
    fallbackWheelbase: 1.12,
    calibratedSeatZOffset: 0.08,
  },
  veh_moto_vesper: {
    archetype: 'step_scooter',
    hasPedals: false,
    isCar: false,
    gearRatio: 0,
    fallbackWheelRadius: 0.240,
    fallbackWheelbase: 1.30,
    calibratedSeatZOffset: 0.11,
  },
  veh_moto_cafe_racer: {
    archetype: 'sport_moto',
    hasPedals: false,
    isCar: false,
    gearRatio: 0,
    fallbackWheelRadius: 0.315,
    fallbackWheelbase: 1.38,
    calibratedSeatZOffset: 0.12,
  },
  veh_moto_apex1000: {
    archetype: 'sport_moto',
    hasPedals: false,
    isCar: false,
    gearRatio: 0,
    fallbackWheelRadius: 0.322,
    fallbackWheelbase: 1.46,
    calibratedSeatZOffset: 0.14,
  },
  moto_commuter: {
    archetype: 'sport_moto',
    hasPedals: false,
    isCar: false,
    gearRatio: 0,
    fallbackWheelRadius: 0.288,
    fallbackWheelbase: 1.28,
  },
  car_mango_micro: {
    archetype: 'compact_car',
    hasPedals: false,
    isCar: true,
    gearRatio: 0,
    fallbackWheelRadius: 0.263,
    fallbackWheelbase: 1.744,
    calibratedSeatY: 0.435,
  },
  mango_micro_aaa: {
    archetype: 'compact_car',
    hasPedals: false,
    isCar: true,
    gearRatio: 0,
    fallbackWheelRadius: 0.263,
    fallbackWheelbase: 1.744,
    calibratedSeatY: 0.435,
  },
  mango_micro: {
    archetype: 'compact_car',
    hasPedals: false,
    isCar: true,
    gearRatio: 0,
    fallbackWheelRadius: 0.263,
    fallbackWheelbase: 1.744,
    calibratedSeatY: 0.435,
  },
  car_river_sedan: {
    archetype: 'compact_car',
    hasPedals: false,
    isCar: true,
    gearRatio: 0,
    fallbackWheelRadius: 0.320,
    fallbackWheelbase: 2.730,
    calibratedSeatY: 0.455,
  },
  river_sedan: {
    archetype: 'compact_car',
    hasPedals: false,
    isCar: true,
    gearRatio: 0,
    fallbackWheelRadius: 0.320,
    fallbackWheelbase: 2.730,
    calibratedSeatY: 0.455,
  },
  car_lotus_spider: {
    archetype: 'sport_coupe_car',
    hasPedals: false,
    isCar: true,
    gearRatio: 0,
    fallbackWheelRadius: 0.310,
    fallbackWheelbase: 2.399,
    openTop: true,
    calibratedSeatY: 0.390,
  },
  lotus_spider: {
    archetype: 'sport_coupe_car',
    hasPedals: false,
    isCar: true,
    gearRatio: 0,
    fallbackWheelRadius: 0.310,
    fallbackWheelbase: 2.399,
    openTop: true,
    calibratedSeatY: 0.390,
  },
  car_halo_vector: {
    archetype: 'sport_coupe_car',
    hasPedals: false,
    isCar: true,
    gearRatio: 0,
    fallbackWheelRadius: 0.360,
    fallbackWheelbase: 2.931,
    calibratedSeatY: 0.315,
    calibratedSeatZOffset: -0.05,
  },
  halo_vector: {
    archetype: 'sport_coupe_car',
    hasPedals: false,
    isCar: true,
    gearRatio: 0,
    fallbackWheelRadius: 0.360,
    fallbackWheelbase: 2.931,
    calibratedSeatY: 0.315,
    calibratedSeatZOffset: -0.05,
  },
};

export const KICKSTAND_FOLD_RAD = 1.22;
export const CAR_STEERING_WHEEL_RATIO = 3.2;

const _tmpEuler = new T.Euler();

function resolveModelMeta(modelId: string): VehicleModelMeta {
  const clean = modelId.replace(/-[0-9a-f]{8,}\.glb$/i, '').replace(/\.glb$/i, '').replace(/-/g, '_');
  if (MODEL_META[modelId]) return MODEL_META[modelId];
  if (MODEL_META[clean]) return MODEL_META[clean];
  if (/car|sedan|mango|lotus|halo|hatch|spider/i.test(modelId)) {
    return MODEL_META.car_mango_micro;
  }
  if (/scooter|vesper/i.test(modelId)) {
    return MODEL_META.veh_scooter_electric;
  }
  if (/moto|cafe|apex/i.test(modelId)) {
    return MODEL_META.veh_moto_cafe_racer;
  }
  if (/velodrome/i.test(modelId)) {
    return MODEL_META.veh_bike_velodrome;
  }
  if (/road|touring/i.test(modelId)) {
    return MODEL_META.veh_bike_road;
  }
  return MODEL_META.veh_bike_basket;
}

// ── Connected Triangle-Island Geometry Splitter (Load-Time Only, Preserves Shared Material) ─────────────────

function analyzeConnectedIslands(mesh: T.Mesh, rootInvM: T.Matrix4): ConnectedIsland[] {
  const geom = mesh.geometry;
  const posAttr = geom.getAttribute('position');
  if (!posAttr || posAttr.count === 0) return [];

  mesh.updateWorldMatrix(true, false);
  const toRootM = new T.Matrix4().multiplyMatrices(rootInvM, mesh.matrixWorld);
  const vCount = posAttr.count;
  const rootPos = new Float32Array(vCount * 3);
  const p = new T.Vector3();

  const posKeyToCanonical = new Map<string, number>();
  const canonical = new Int32Array(vCount);
  for (let i = 0; i < vCount; i++) {
    p.fromBufferAttribute(posAttr, i).applyMatrix4(toRootM);
    rootPos[i * 3] = p.x;
    rootPos[i * 3 + 1] = p.y;
    rootPos[i * 3 + 2] = p.z;
    const key = `${Math.round(p.x * 10000)},${Math.round(p.y * 10000)},${Math.round(p.z * 10000)}`;
    let c = posKeyToCanonical.get(key);
    if (c === undefined) {
      c = i;
      posKeyToCanonical.set(key, i);
    }
    canonical[i] = c;
  }

  const parent = Int32Array.from({ length: vCount }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let cur = x;
    while (cur !== r) {
      const nxt = parent[cur];
      parent[cur] = r;
      cur = nxt;
    }
    return r;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < vCount; i++) unite(i, canonical[i]);

  const idxAttr = geom.getIndex();
  const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(vCount / 3);
  for (let t = 0; t < triCount; t++) {
    const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
    const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;
    unite(i0, i1);
    unite(i1, i2);
  }

  const byRoot = new Map<
    number,
    { tris: number[]; min: T.Vector3; max: T.Vector3; verts: Set<number> }
  >();
  for (let t = 0; t < triCount; t++) {
    const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
    const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;
    const r = find(i0);
    let bucket = byRoot.get(r);
    if (!bucket) {
      bucket = {
        tris: [],
        min: new T.Vector3(Infinity, Infinity, Infinity),
        max: new T.Vector3(-Infinity, -Infinity, -Infinity),
        verts: new Set<number>(),
      };
      byRoot.set(r, bucket);
    }
    bucket.tris.push(i0, i1, i2);
    for (const vi of [i0, i1, i2]) {
      bucket.verts.add(vi);
      const vx = rootPos[vi * 3];
      const vy = rootPos[vi * 3 + 1];
      const vz = rootPos[vi * 3 + 2];
      if (vx < bucket.min.x) bucket.min.x = vx;
      if (vy < bucket.min.y) bucket.min.y = vy;
      if (vz < bucket.min.z) bucket.min.z = vz;
      if (vx > bucket.max.x) bucket.max.x = vx;
      if (vy > bucket.max.y) bucket.max.y = vy;
      if (vz > bucket.max.z) bucket.max.z = vz;
    }
  }

  const islands: ConnectedIsland[] = [];
  for (const b of byRoot.values()) {
    const center = new T.Vector3().addVectors(b.min, b.max).multiplyScalar(0.5);
    islands.push({
      triIndices: b.tris,
      min: b.min,
      max: b.max,
      center,
      vertexCount: b.verts.size,
    });
  }
  return islands;
}

function buildSubMeshFromTriangles(
  sourceMesh: T.Mesh,
  triIndices: readonly number[],
  rootInvM: T.Matrix4,
  pivotInRoot: T.Vector3,
  name: string,
): T.Mesh {
  const srcGeom = sourceMesh.geometry;
  sourceMesh.updateWorldMatrix(true, false);
  const toRootM = new T.Matrix4().multiplyMatrices(rootInvM, sourceMesh.matrixWorld);
  const normalM = new T.Matrix3().getNormalMatrix(toRootM);

  const oldToNew = new Map<number, number>();
  const orderedOldVerts: number[] = [];
  const compactIndices: number[] = [];

  for (let i = 0; i < triIndices.length; i++) {
    const oldVi = triIndices[i];
    let newVi = oldToNew.get(oldVi);
    if (newVi === undefined) {
      newVi = orderedOldVerts.length;
      oldToNew.set(oldVi, newVi);
      orderedOldVerts.push(oldVi);
    }
    compactIndices.push(newVi);
  }

  const outCount = orderedOldVerts.length;
  const subGeom = new T.BufferGeometry();
  const tmpV3 = new T.Vector3();
  const tmpV4 = new T.Vector4();

  for (const attrName of Object.keys(srcGeom.attributes)) {
    const attr = srcGeom.getAttribute(attrName) as T.BufferAttribute;
    if (!attr) continue;
    const itemSize = attr.itemSize;
    const outArr = new Float32Array(outCount * itemSize);

    for (let ni = 0; ni < outCount; ni++) {
      const oi = orderedOldVerts[ni];
      if (attrName === 'position') {
        tmpV3.fromBufferAttribute(attr, oi).applyMatrix4(toRootM).sub(pivotInRoot);
        outArr[ni * 3] = tmpV3.x;
        outArr[ni * 3 + 1] = tmpV3.y;
        outArr[ni * 3 + 2] = tmpV3.z;
      } else if (attrName === 'normal') {
        tmpV3.fromBufferAttribute(attr, oi).applyMatrix3(normalM).normalize();
        outArr[ni * 3] = tmpV3.x;
        outArr[ni * 3 + 1] = tmpV3.y;
        outArr[ni * 3 + 2] = tmpV3.z;
      } else if (attrName === 'tangent' && itemSize === 4) {
        tmpV4.fromBufferAttribute(attr, oi);
        tmpV3.set(tmpV4.x, tmpV4.y, tmpV4.z).applyMatrix3(normalM).normalize();
        outArr[ni * 4] = tmpV3.x;
        outArr[ni * 4 + 1] = tmpV3.y;
        outArr[ni * 4 + 2] = tmpV3.z;
        outArr[ni * 4 + 3] = tmpV4.w;
      } else {
        for (let k = 0; k < itemSize; k++) {
          outArr[ni * itemSize + k] = attr.getComponent(oi, k);
        }
      }
    }
    subGeom.setAttribute(attrName, new T.BufferAttribute(outArr, itemSize, attr.normalized));
  }

  subGeom.setIndex(
    outCount <= 65535
      ? new T.Uint16BufferAttribute(compactIndices, 1)
      : new T.Uint32BufferAttribute(compactIndices, 1),
  );
  subGeom.computeBoundingBox();
  subGeom.computeBoundingSphere();

  const subMesh = new T.Mesh(subGeom, sourceMesh.material);
  subMesh.name = name;
  subMesh.castShadow = sourceMesh.castShadow;
  subMesh.receiveShadow = sourceMesh.receiveShadow;
  return subMesh;
}

// ── Main Extraction & Socket Binding Entry Point ───────────────────────────────────────────────────────────

export function extractVehicleRig(root: T.Object3D, modelId: string): VehicleRigSockets {
  const cached = root.userData.__ecVehicleRigSockets as VehicleRigSockets | undefined;
  if (cached && cached.saddleOrSeat.parent) return cached;

  const meta = resolveModelMeta(modelId);

  const savedPos = root.position.clone();
  const savedQuat = root.quaternion.clone();
  const savedScale = root.scale.clone();
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.updateWorldMatrix(true, true);
  const rootInvM = root.matrixWorld.clone().invert();

  const alreadyExtracted = Boolean(root.getObjectByName('anchor_grip_L_calibrated'));
  if (!alreadyExtracted) {
    performLoadTimeGeometryRigging(root, meta, rootInvM);
    root.updateWorldMatrix(true, true);
  }

  const sockets = bindSocketsFromHierarchy(root, modelId, meta, rootInvM);

  root.position.copy(savedPos);
  root.quaternion.copy(savedQuat);
  root.scale.copy(savedScale);
  root.updateWorldMatrix(true, true);

  root.userData.__ecVehicleRigSockets = sockets;
  return sockets;
}

function findPrimaryContainer(root: T.Object3D): T.Object3D {
  let cur = root;
  while (
    cur.children.length === 1 &&
    !(cur.children[0] as T.Mesh).isMesh &&
    !/^(?:pivot_|anchor_|Axle_|Wheel_|Steer_)/i.test(cur.children[0].name) &&
    cur.children[0].children.length >= 1
  ) {
    cur = cur.children[0];
  }
  return cur;
}

function collectSubtreeMeshes(parent: T.Object3D): T.Mesh[] {
  const out: T.Mesh[] = [];
  parent.traverse((o) => {
    const m = o as T.Mesh;
    if (m.isMesh && m.geometry) out.push(m);
  });
  return out;
}

/**
 * Full root-space island decomposition for material-merged bicycles lacking wheel/fork pivots
 * (such as `bicycle-817f32877dda.glb` and `bicycleModel()`), baking out node rotations/translations
 * (`Grip_-0.26` 90° Z, `Stand_Rod` quaternion, `Pedal_L` offset) and routing every connected island
 * into exact `pivot_fork -> pivot_front_wheel`, `pivot_rear_wheel`, `pivot_seatpost`,
 * `pivot_crank -> pivot_pedal_L / pivot_pedal_R`, and `pivot_kickstand` assemblies.
 */
function reconstructUnriggedBicycleHierarchy(
  root: T.Object3D,
  container: T.Object3D,
  rootInvM: T.Matrix4,
): void {
  const meshes = collectSubtreeMeshes(container);
  if (meshes.length === 0) return;

  const allIslands: ConnectedIsland[] = [];
  let minZAll = Infinity;
  let maxZAll = -Infinity;
  for (const m of meshes) {
    const list = analyzeConnectedIslands(m, rootInvM);
    for (const isl of list) {
      allIslands.push(isl);
      if (isl.min.z < minZAll) minZAll = isl.min.z;
      if (isl.max.z > maxZAll) maxZAll = isl.max.z;
    }
  }
  if (allIslands.length === 0) return;

  const spanZ = maxZAll - minZAll;
  const s = Number.isFinite(spanZ) && spanZ > 0.8 ? spanZ / 1.762 : 1.0;

  let frontAxle: T.Vector3 | null = null;
  let frontBestD = 0;
  let rearAxle: T.Vector3 | null = null;
  let rearBestD = 0;
  let saddleOrigin: T.Vector3 | null = null;
  let bbCenter: T.Vector3 | null = null;
  let pedalPosL: T.Vector3 | null = null;
  let pedalPosR: T.Vector3 | null = null;
  let gripPosL: T.Vector3 | null = null;
  let gripPosR: T.Vector3 | null = null;
  let ksOrigin: T.Vector3 | null = null;

  for (const isl of allIslands) {
    const sx = isl.max.x - isl.min.x;
    const sy = isl.max.y - isl.min.y;
    const sz = isl.max.z - isl.min.z;

    // Circular wheel rims / tires (`sy ≈ sz >= 0.48 m`, narrow in X)
    if (sy > 0.48 * s && sz > 0.48 * s && Math.abs(sy - sz) < 0.08 * s && sx < 0.12 * s) {
      if (isl.center.z > 0.20 * s && sy > frontBestD) {
        frontBestD = sy;
        frontAxle = new T.Vector3(0, isl.center.y, isl.center.z);
      } else if (isl.center.z < -0.20 * s && sy > rearBestD) {
        rearBestD = sy;
        rearAxle = new T.Vector3(0, isl.center.y, isl.center.z);
      }
      continue;
    }

    // Saddle cushion (`y > 0.80s, centered X, rear Z`)
    if (
      isl.min.y > 0.80 * s &&
      Math.abs(isl.center.x) < 0.045 * s &&
      isl.center.z < -0.04 * s &&
      sy < 0.12 * s &&
      sx > 0.08 * s
    ) {
      saddleOrigin = new T.Vector3(0, isl.center.y, isl.center.z);
      continue;
    }

    // Circular chainring (`Stand_Rod isl[1]`: `sx < 0.03s, sy ≈ sz ≈ 0.17s`)
    if (
      sx < 0.035 * s &&
      Math.abs(sy - sz) < 0.035 * s &&
      sy > 0.11 * s &&
      sy < 0.26 * s &&
      isl.min.y > 0.14 * s &&
      Math.abs(isl.center.z) < 0.25 * s
    ) {
      bbCenter = new T.Vector3(0, isl.center.y, isl.center.z);
      continue;
    }

    // Pedal platforms (`|center.x| ∈ [0.08s, 0.19s], thin Y`)
    if (
      Math.abs(isl.center.x) > 0.08 * s &&
      Math.abs(isl.center.x) < 0.19 * s &&
      sy < 0.05 * s &&
      sz < 0.12 * s &&
      isl.min.y > 0.12 * s &&
      isl.max.y < 0.54 * s &&
      Math.abs(isl.center.z) < 0.30 * s
    ) {
      if (isl.center.x > 0) pedalPosL = isl.center.clone();
      else pedalPosR = isl.center.clone();
      continue;
    }

    // Handlebar grips (`y > 0.78s, z > 0.22s, |center.x| > 0.14s`)
    if (
      isl.center.y > 0.78 * s &&
      isl.min.z > 0.22 * s &&
      Math.abs(isl.center.x) > 0.14 * s &&
      sy < 0.08 * s &&
      sz < 0.12 * s
    ) {
      if (isl.center.x > 0) gripPosL = isl.center.clone();
      else gripPosR = isl.center.clone();
      continue;
    }

    // Kickstand rod (`touches near y ≈ 0, max.y < 0.38s, narrow Z`)
    if (
      isl.min.y < 0.04 * s &&
      isl.max.y < 0.38 * s &&
      sz < 0.25 * s &&
      Math.abs(isl.center.z) < 0.32 * s &&
      (isl.max.x > 0.08 * s || isl.min.x < -0.10 * s)
    ) {
      const hingeX =
        isl.center.x >= 0
          ? Math.max(0.035 * s, isl.min.x + 0.01 * s)
          : Math.min(-0.035 * s, isl.max.x - 0.01 * s);
      ksOrigin = new T.Vector3(hingeX, isl.max.y - 0.006 * s, isl.max.z - 0.008 * s);
    }
  }

  if (!frontAxle) frontAxle = new T.Vector3(0, 0.34 * s, 0.54 * s);
  if (!rearAxle) rearAxle = new T.Vector3(0, 0.34 * s, -0.54 * s);
  if (!saddleOrigin) saddleOrigin = new T.Vector3(0, 0.91 * s, -0.22 * s);
  if (!bbCenter) {
    if (pedalPosL && pedalPosR) {
      bbCenter = new T.Vector3(
        0,
        0.5 * (pedalPosL.y + pedalPosR.y),
        0.5 * (pedalPosL.z + pedalPosR.z),
      );
    } else {
      bbCenter = new T.Vector3(0, 0.32 * s, -0.08 * s);
    }
  }
  if (!pedalPosL) pedalPosL = new T.Vector3(0.11 * s, bbCenter.y + 0.12 * s, bbCenter.z - 0.10 * s);
  if (!pedalPosR) pedalPosR = new T.Vector3(-0.11 * s, bbCenter.y - 0.12 * s, bbCenter.z + 0.10 * s);

  const forkOrigin = new T.Vector3(0, 0.78 * s, 0.36 * s);
  container.updateWorldMatrix(true, false);
  const containerInRoot = container.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);

  const forkPivot = new T.Object3D();
  forkPivot.name = 'pivot_fork';
  forkPivot.position.copy(forkOrigin).sub(containerInRoot);
  container.add(forkPivot);

  const frontWheelPivot = new T.Object3D();
  frontWheelPivot.name = 'pivot_front_wheel';
  frontWheelPivot.position.copy(frontAxle).sub(forkOrigin);
  forkPivot.add(frontWheelPivot);

  if (gripPosL) {
    const gL = new T.Object3D();
    gL.name = 'anchor_grip_right';
    gL.position.copy(gripPosL).sub(forkOrigin);
    forkPivot.add(gL);
  }
  if (gripPosR) {
    const gR = new T.Object3D();
    gR.name = 'anchor_grip_left';
    gR.position.copy(gripPosR).sub(forkOrigin);
    forkPivot.add(gR);
  }

  const rearWheelPivot = new T.Object3D();
  rearWheelPivot.name = 'pivot_rear_wheel';
  rearWheelPivot.position.copy(rearAxle).sub(containerInRoot);
  container.add(rearWheelPivot);

  const seatPostPivot = new T.Object3D();
  seatPostPivot.name = 'pivot_seatpost';
  seatPostPivot.position.copy(saddleOrigin).sub(containerInRoot);
  seatPostPivot.userData.baseSeatPostY = seatPostPivot.position.y;
  container.add(seatPostPivot);

  const crankPivot = new T.Object3D();
  crankPivot.name = 'pivot_crank';
  crankPivot.position.copy(bbCenter).sub(containerInRoot);
  container.add(crankPivot);

  const pedalPivotL = new T.Object3D();
  pedalPivotL.name = 'pivot_pedal_L';
  pedalPivotL.position.copy(pedalPosL).sub(bbCenter);
  crankPivot.add(pedalPivotL);

  const pedalPivotR = new T.Object3D();
  pedalPivotR.name = 'pivot_pedal_R';
  pedalPivotR.position.copy(pedalPosR).sub(bbCenter);
  crankPivot.add(pedalPivotR);

  let kickstandPivot: T.Object3D | null = null;
  if (ksOrigin) {
    kickstandPivot = new T.Object3D();
    kickstandPivot.name = 'pivot_kickstand';
    kickstandPivot.position.copy(ksOrigin).sub(containerInRoot);
    container.add(kickstandPivot);
  }

  root.updateWorldMatrix(true, true);

  for (const m of meshes) {
    if (!m.parent) continue;
    splitMeshByClassifier(m, container, rootInvM, (isl) => {
      const sx = isl.max.x - isl.min.x;
      const sy = isl.max.y - isl.min.y;
      const sz = isl.max.z - isl.min.z;

      // 1. Front Wheel Assembly (tire + chrome rim + hub + spokes centered on front axle)
      if (
        Math.abs(isl.center.z - frontAxle!.z) < 0.14 * s &&
        Math.abs(isl.center.y - frontAxle!.y) < 0.14 * s &&
        sx < 0.12 * s
      ) {
        return {
          targetParent: frontWheelPivot,
          pivotInRoot: frontAxle!,
          subName: sy > 0.62 * s ? 'wheel_front_tire' : 'wheel_front_rim_spoke',
        };
      }

      // 2. Rear Wheel Assembly (tire + chrome rim + hub + spokes + rear cog centered on rear axle)
      if (
        Math.abs(isl.center.z - rearAxle!.z) < 0.14 * s &&
        Math.abs(isl.center.y - rearAxle!.y) < 0.14 * s &&
        sx < 0.12 * s
      ) {
        return {
          targetParent: rearWheelPivot,
          pivotInRoot: rearAxle!,
          subName: sy > 0.62 * s ? 'wheel_rear_tire' : 'wheel_rear_rim_spoke',
        };
      }

      // 3. Saddle & Telescopic Seatpost (`pivot_seatpost`)
      if (
        isl.min.y > 0.72 * s &&
        Math.abs(isl.center.x) < 0.045 * s &&
        isl.center.z < -0.04 * s &&
        isl.center.z > -0.46 * s
      ) {
        return {
          targetParent: seatPostPivot,
          pivotInRoot: saddleOrigin!,
          subName: 'bicycle_saddle_mesh',
        };
      }

      // 4. Steered Front Fork Blades, Stem, Handlebar & Rubber Grips (`pivot_fork`)
      if (isl.min.z > 0.24 * s && isl.max.y > 0.32 * s) {
        const isGrip = isl.center.y > 0.78 * s && Math.abs(isl.center.x) > 0.14 * s && sy < 0.08 * s;
        return {
          targetParent: forkPivot,
          pivotInRoot: forkOrigin,
          subName: isGrip ? 'fork_grip_rubber' : 'fork_bar_blade',
        };
      }

      // 5. Retractable Kickstand ONLY (never wheel spokes or chainring!)
      if (
        kickstandPivot &&
        ksOrigin &&
        isl.min.y < 0.04 * s &&
        isl.max.y < 0.38 * s &&
        sz < 0.25 * s &&
        Math.abs(isl.center.z) < 0.32 * s &&
        (isl.max.x > 0.08 * s || isl.min.x < -0.10 * s)
      ) {
        return {
          targetParent: kickstandPivot,
          pivotInRoot: ksOrigin,
          subName: 'kickstand_arm',
        };
      }

      // 6. Pedals & Crankset around Bottom Bracket (`pivot_crank` + counter-rotating `pivot_pedal_L/R`)
      const rBb = Math.hypot(isl.center.y - bbCenter!.y, isl.center.z - bbCenter!.z);
      if (
        Math.abs(isl.center.x) > 0.08 * s &&
        Math.abs(isl.center.x) < 0.19 * s &&
        sy < 0.05 * s &&
        sz < 0.12 * s &&
        rBb > 0.07 * s &&
        rBb < 0.21 * s
      ) {
        if (isl.center.x > 0) {
          return {
            targetParent: pedalPivotL,
            pivotInRoot: pedalPosL!,
            subName: 'pedal_platform_L',
          };
        }
        return {
          targetParent: pedalPivotR,
          pivotInRoot: pedalPosR!,
          subName: 'pedal_platform_R',
        };
      }

      // Chainring or synthesized crank arms + BB spindle (`sz < 0.30s` excludes frame tubes & static chain loop)
      const isChainring =
        sx < 0.035 * s && Math.abs(sy - sz) < 0.035 * s && sy > 0.11 * s && sy < 0.26 * s && rBb < 0.035 * s;
      const isCrankAssembly =
        sx < 0.15 * s &&
        sy < 0.30 * s &&
        sz < 0.30 * s &&
        isl.min.y > 0.14 * s &&
        isl.max.y < 0.50 * s &&
        rBb < 0.13 * s &&
        (Math.abs(isl.center.x) > 0.035 * s || sx > 0.08 * s);
      if (isChainring || isCrankAssembly) {
        return {
          targetParent: crankPivot,
          pivotInRoot: bbCenter!,
          subName: isChainring ? 'crank_chainring' : 'crank_arm',
        };
      }

      return null;
    });
  }
}

function orientTubeGeometry(
  p0: T.Vector3,
  p1: T.Vector3,
  r0: number,
  r1: number,
  radialSegments = 8,
): T.BufferGeometry | null {
  const dir = new T.Vector3().subVectors(p1, p0);
  const len = dir.length();
  if (len < 1e-4) return null;
  const g = new T.CylinderGeometry(r1, r0, len, radialSegments, 1, false);
  const mid = new T.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
  const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), dir.divideScalar(len));
  const m = new T.Matrix4().compose(mid, q, new T.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

function findTemplateMesh(root: T.Object3D, pattern: RegExp): T.Mesh | null {
  let fallback: T.Mesh | null = null;
  let matched: T.Mesh | null = null;
  root.traverse((o) => {
    if (matched) return;
    const m = o as T.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || !m.material) return;
    if (!fallback) fallback = m;
    const matName = m.material.name ?? '';
    if (pattern.test(matName) || pattern.test(m.name)) {
      matched = m;
    }
  });
  return matched ?? fallback;
}

function buildSynthesizedMesh(
  parts: T.BufferGeometry[],
  templateMesh: T.Mesh,
  name: string,
): T.Mesh | null {
  if (parts.length === 0) return null;
  const normalized: T.BufferGeometry[] = [];
  for (const part of parts) {
    const g = part.index ? part.toNonIndexed() : part.clone();
    part.dispose();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      g.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    normalized.push(g);
  }
  const merged = normalized.length === 1 ? normalized[0] : mergeGeometries(normalized, false);
  if (normalized.length > 1) normalized.forEach((g) => g.dispose());
  if (!merged) return null;

  const vCount = merged.attributes.position.count;
  const idx = vCount <= 65535 ? new Uint16Array(vCount) : new Uint32Array(vCount);
  for (let i = 0; i < vCount; i++) idx[i] = i;
  merged.setIndex(new T.BufferAttribute(idx, 1));

  // Match `palettePaint` (`color` + `uv1`) if `templateMesh` was already batch-painted by `assets.ts`
  const tplColor = templateMesh.geometry.getAttribute('color');
  if (tplColor) {
    const cSize = tplColor.itemSize;
    const cArr = new Float32Array(vCount * cSize);
    const cr = tplColor.count > 0 ? tplColor.getX(0) : 0.45;
    const cg = tplColor.count > 0 ? tplColor.getY(0) : 0.48;
    const cb = tplColor.count > 0 ? tplColor.getZ(0) : 0.52;
    for (let i = 0; i < vCount; i++) {
      cArr[i * cSize] = cr;
      cArr[i * cSize + 1] = cg;
      cArr[i * cSize + 2] = cb;
      if (cSize === 4) cArr[i * 4 + 3] = 1;
    }
    merged.setAttribute('color', new T.BufferAttribute(cArr, cSize));
  }
  const tplUv1 = templateMesh.geometry.getAttribute('uv1');
  if (tplUv1) {
    const uArr = new Float32Array(vCount * 2);
    const u0 = tplUv1.count > 0 ? tplUv1.getX(0) : 0.5;
    const v0 = tplUv1.count > 0 ? tplUv1.getY(0) : 0.5;
    for (let i = 0; i < vCount; i++) {
      uArr[i * 2] = u0;
      uArr[i * 2 + 1] = v0;
    }
    merged.setAttribute('uv1', new T.BufferAttribute(uArr, 2));
  }

  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  const out = new T.Mesh(merged, templateMesh.material);
  out.name = name;
  out.castShadow = templateMesh.castShadow;
  out.receiveShadow = templateMesh.receiveShadow;
  return out;
}

/**
 * Completes missing authentic 3D bicycle structure at load time (reusing existing GLB materials — `0` extra shader programs):
 *  - 3D wheel hubs, flanges, 16 crossed steel spokes, valve stem & rear sprocket cog on unrigged bicycles (`bicycle-817f32877dda.glb`).
 *  - 3D crank arms + bottom-bracket spindle (`bicycle`) and missing steel chainring (`veh_bike_touring`).
 *  - Painted head tube + steered chrome stem/fork crown (`bicycle`, `veh_bike_touring`) & telescopic seatpost (`all bikes`).
 *  - Static drivetrain chain loop (`container`, never orbiting with `pivot_crank`!) across all 7 bicycles.
 */
function synthesizeBicycleMechanicalDetails(
  root: T.Object3D,
  container: T.Object3D,
  rootInvM: T.Matrix4,
  wasUnriggedBicycle: boolean,
): void {
  const metalTpl = findTemplateMesh(root, /Galv_Steel|Mirror_Chrome|chrome|steel/i);
  const darkTpl = findTemplateMesh(root, /Powder_Iron|graphite|black|Galv_Steel|steel/i) ?? metalTpl;
  const paintTpl = findTemplateMesh(root, /Bike_Teal|terracotta|teal|#[0-9a-f]{6}/i) ?? metalTpl;
  if (!metalTpl || !darkTpl) return;

  root.updateWorldMatrix(true, true);
  const containerInRoot = container.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);

  const forkPivot = root.getObjectByName('pivot_fork');
  const frontWheel = root.getObjectByName('pivot_front_wheel');
  const rearWheel = root.getObjectByName('pivot_rear_wheel');
  const crankPivot = root.getObjectByName('pivot_crank');
  const pedalL = root.getObjectByName('pivot_pedal_L');
  const pedalR = root.getObjectByName('pivot_pedal_R');
  const seatPostPivot = root.getObjectByName('pivot_seatpost');

  let spanZ = 1.762;
  if (frontWheel && rearWheel) {
    const fz = frontWheel.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM).z;
    const rz = rearWheel.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM).z;
    if (Math.abs(fz - rz) > 0.6) spanZ = (Math.abs(fz - rz) / 1.08) * 1.762;
  }
  const s = T.MathUtils.clamp(spanZ / 1.762, 0.85, 1.15);

  // 1. Telescopic Seatpost inside `pivot_seatpost` (eliminates saddle air gap across `±8 cm` rider seatpost range)
  if (seatPostPivot) {
    let hasPost = false;
    for (const m of collectSubtreeMeshes(seatPostPivot)) {
      for (const isl of analyzeConnectedIslands(m, rootInvM)) {
        if (isl.max.y - isl.min.y > 0.095 * s && Math.abs(isl.center.x) < 0.03 * s) hasPost = true;
      }
    }
    if (!hasPost) {
      const postParts: T.BufferGeometry[] = [];
      const shaft = orientTubeGeometry(
        new T.Vector3(0, -0.018 * s, -0.002 * s),
        new T.Vector3(0, -0.155 * s, 0.034 * s),
        0.011 * s,
        0.011 * s,
        8,
      );
      const clampCollar = orientTubeGeometry(
        new T.Vector3(-0.016 * s, -0.022 * s, 0),
        new T.Vector3(0.016 * s, -0.022 * s, 0),
        0.012 * s,
        0.012 * s,
        8,
      );
      if (shaft) postParts.push(shaft);
      if (clampCollar) postParts.push(clampCollar);
      const postMesh = buildSynthesizedMesh(postParts, metalTpl, 'bicycle_seatpost_shaft');
      if (postMesh) seatPostPivot.add(postMesh);
    }
  }

  // 2. Unrigged Legacy Bicycle (`bicycle-817f32877dda.glb`): Head Tube, Stem/Crown, Crank Arms & 3D Spoked Hubs
  if (wasUnriggedBicycle) {
    if (paintTpl) {
      let hasHeadTube = false;
      for (const child of container.children) {
        const m = child as T.Mesh;
        if (!m.isMesh) continue;
        for (const isl of analyzeConnectedIslands(m, rootInvM)) {
          if (
            Math.abs(isl.center.x) < 0.01 * s &&
            isl.min.z > 0.15 * s &&
            isl.max.z < 0.39 * s &&
            isl.min.y > 0.72 * s &&
            isl.max.y < 0.88 * s
          ) {
            hasHeadTube = true;
          }
        }
      }
      if (!hasHeadTube) {
        const htParts: T.BufferGeometry[] = [];
        const ht = orientTubeGeometry(
          new T.Vector3(0, 0.748 * s, 0.352 * s).sub(containerInRoot),
          new T.Vector3(0, 0.844 * s, 0.352 * s).sub(containerInRoot),
          0.0185 * s,
          0.0185 * s,
          10,
        );
        const gusset = orientTubeGeometry(
          new T.Vector3(0, 0.800 * s, 0.185 * s).sub(containerInRoot),
          new T.Vector3(0, 0.802 * s, 0.352 * s).sub(containerInRoot),
          0.0145 * s,
          0.0155 * s,
          8,
        );
        if (ht) htParts.push(ht);
        if (gusset) htParts.push(gusset);
        const htMesh = buildSynthesizedMesh(htParts, paintTpl, 'bicycle_frame_headtube');
        if (htMesh) container.add(htMesh);
      }
    }

    if (forkPivot) {
      const forkRoot = forkPivot.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
      let hasStem = false;
      for (const child of forkPivot.children) {
        const m = child as T.Mesh;
        if (!m.isMesh) continue;
        for (const isl of analyzeConnectedIslands(m, rootInvM)) {
          if (Math.abs(isl.center.x) < 0.015 * s && isl.max.y - isl.min.y > 0.15 * s && isl.max.y > 0.90 * s) {
            hasStem = true;
          }
        }
      }
      if (!hasStem) {
        const stemParts: T.BufferGeometry[] = [];
        const crown = orientTubeGeometry(
          new T.Vector3(-0.045 * s, 0.752 * s, 0.362 * s).sub(forkRoot),
          new T.Vector3(0.045 * s, 0.752 * s, 0.362 * s).sub(forkRoot),
          0.013 * s,
          0.013 * s,
          8,
        );
        const steerer = orientTubeGeometry(
          new T.Vector3(0, 0.750 * s, 0.362 * s).sub(forkRoot),
          new T.Vector3(0, 0.986 * s, 0.364 * s).sub(forkRoot),
          0.012 * s,
          0.012 * s,
          10,
        );
        const barClamp = orientTubeGeometry(
          new T.Vector3(-0.024 * s, 0.986 * s, 0.364 * s).sub(forkRoot),
          new T.Vector3(0.024 * s, 0.986 * s, 0.364 * s).sub(forkRoot),
          0.017 * s,
          0.017 * s,
          10,
        );
        if (crown) stemParts.push(crown);
        if (steerer) stemParts.push(steerer);
        if (barClamp) stemParts.push(barClamp);
        const stemMesh = buildSynthesizedMesh(stemParts, metalTpl, 'fork_chrome_stem');
        if (stemMesh) forkPivot.add(stemMesh);
      }
    }

    if (crankPivot && pedalL && pedalR) {
      let hasCrankArms = false;
      for (const child of crankPivot.children) {
        const m = child as T.Mesh;
        if (!m.isMesh) continue;
        for (const isl of analyzeConnectedIslands(m, rootInvM)) {
          if (isl.max.x - isl.min.x > 0.06 * s) hasCrankArms = true;
        }
      }
      if (!hasCrankArms) {
        const pL = pedalL.position;
        const pR = pedalR.position;
        const armXL = Math.max(0.048 * s, Math.min(Math.abs(pL.x) - 0.052 * s, 0.058 * s));
        const armXR = -Math.max(0.048 * s, Math.min(Math.abs(pR.x) - 0.052 * s, 0.058 * s));
        const crankParts: T.BufferGeometry[] = [];
        const bbAxle = orientTubeGeometry(
          new T.Vector3(armXR, 0, 0),
          new T.Vector3(armXL, 0, 0),
          0.0125 * s,
          0.0125 * s,
          8,
        );
        const armL = orientTubeGeometry(
          new T.Vector3(armXL, 0, 0),
          new T.Vector3(armXL, pL.y, pL.z),
          0.0105 * s,
          0.0085 * s,
          8,
        );
        const armR = orientTubeGeometry(
          new T.Vector3(armXR, 0, 0),
          new T.Vector3(armXR, pR.y, pR.z),
          0.0105 * s,
          0.0085 * s,
          8,
        );
        if (bbAxle) crankParts.push(bbAxle);
        if (armL) crankParts.push(armL);
        if (armR) crankParts.push(armR);
        const crankMesh = buildSynthesizedMesh(crankParts, darkTpl, 'crank_arms_spindle');
        if (crankMesh) crankPivot.add(crankMesh);
      }
    }

    for (const [wheelPivot, isRear] of [
      [frontWheel, false],
      [rearWheel, true],
    ] as const) {
      if (!wheelPivot) continue;
      let has3dSpokeHub = false;
      let rimInnerR = 0.295 * s;
      for (const m of collectSubtreeMeshes(wheelPivot)) {
        for (const isl of analyzeConnectedIslands(m, rootInvM)) {
          const sx = isl.max.x - isl.min.x;
          const sy = isl.max.y - isl.min.y;
          if (sx > 0.032 * s && sy < 0.61 * s) has3dSpokeHub = true;
          if (sy > 0.52 * s && sy < 0.63 * s) rimInnerR = 0.5 * sy - 0.008 * s;
        }
      }
      if (!has3dSpokeHub) {
        const wParts: T.BufferGeometry[] = [];
        const hubBarrel = orientTubeGeometry(
          new T.Vector3(-0.022 * s, 0, 0),
          new T.Vector3(0.022 * s, 0, 0),
          0.014 * s,
          0.014 * s,
          10,
        );
        const flangeL = orientTubeGeometry(
          new T.Vector3(0.017 * s, 0, 0),
          new T.Vector3(0.021 * s, 0, 0),
          0.027 * s,
          0.027 * s,
          12,
        );
        const flangeR = orientTubeGeometry(
          new T.Vector3(-0.021 * s, 0, 0),
          new T.Vector3(-0.017 * s, 0, 0),
          0.027 * s,
          0.027 * s,
          12,
        );
        if (hubBarrel) wParts.push(hubBarrel);
        if (flangeL) wParts.push(flangeL);
        if (flangeR) wParts.push(flangeR);

        if (isRear) {
          const cog = orientTubeGeometry(
            new T.Vector3(0.021 * s, 0, 0),
            new T.Vector3(0.025 * s, 0, 0),
            0.036 * s,
            0.036 * s,
            14,
          );
          if (cog) wParts.push(cog);
        }

        // 16 tangential 2-cross 3D steel spokes (8 per hub flange) + inner valve stem & spoke marker
        const spokeCountPerSide = 8;
        const rHub = 0.024 * s;
        const rRim = Math.max(0.24 * s, rimInnerR);
        for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
          const fx = (sideIdx === 0 ? 1 : -1) * 0.019 * s;
          const phase = sideIdx * (Math.PI / spokeCountPerSide);
          for (let k = 0; k < spokeCountPerSide; k++) {
            const a0 = phase + (k / spokeCountPerSide) * Math.PI * 2;
            const crossSign = k % 2 === 0 ? 1 : -1;
            const a1 = a0 + crossSign * 0.36;
            const sp = orientTubeGeometry(
              new T.Vector3(fx, Math.cos(a0) * rHub, Math.sin(a0) * rHub),
              new T.Vector3(0, Math.cos(a1) * rRim, Math.sin(a1) * rRim),
              0.0028 * s,
              0.0024 * s,
              5,
            );
            if (sp) wParts.push(sp);
          }
        }
        const valve = orientTubeGeometry(
          new T.Vector3(0, -rRim, 0),
          new T.Vector3(0, -(rRim - 0.032 * s), 0),
          0.0042 * s,
          0.0032 * s,
          6,
        );
        const reflector = new T.BoxGeometry(0.007 * s, 0.022 * s, 0.044 * s);
        reflector.translate(0, rRim * 0.68, 0);
        if (valve) wParts.push(valve);
        wParts.push(reflector);

        const hubSpokeMesh = buildSynthesizedMesh(
          wParts,
          metalTpl,
          isRear ? 'wheel_rear_hub_spokes' : 'wheel_front_hub_spokes',
        );
        if (hubSpokeMesh) wheelPivot.add(hubSpokeMesh);
      }
    }
  }

  // 3. `veh_bike_touring`: Add missing chainring on `pivot_crank` & fork crown bridge on `pivot_fork`
  if (crankPivot) {
    let hasChainring = false;
    for (const m of collectSubtreeMeshes(crankPivot)) {
      for (const isl of analyzeConnectedIslands(m, rootInvM)) {
        const sy = isl.max.y - isl.min.y;
        const sz = isl.max.z - isl.min.z;
        if (sy > 0.13 * s && sz > 0.13 * s && Math.abs(sy - sz) < 0.04 * s && isl.max.x > 0.03 * s) {
          hasChainring = true;
        }
      }
    }
    if (!hasChainring) {
      const ringParts: T.BufferGeometry[] = [];
      const ringTorus = new T.TorusGeometry(0.082 * s, 0.0055 * s, 6, 20);
      ringTorus.rotateY(Math.PI * 0.5);
      ringTorus.translate(0.046 * s, 0, 0);
      ringParts.push(ringTorus);
      for (let k = 0; k < 5; k++) {
        const ang = (k / 5) * Math.PI * 2;
        const spider = orientTubeGeometry(
          new T.Vector3(0.046 * s, 0, 0),
          new T.Vector3(0.046 * s, Math.cos(ang) * 0.080 * s, Math.sin(ang) * 0.080 * s),
          0.005 * s,
          0.004 * s,
          5,
        );
        if (spider) ringParts.push(spider);
      }
      const bbShaft = orientTubeGeometry(
        new T.Vector3(-0.055 * s, 0, 0),
        new T.Vector3(0.055 * s, 0, 0),
        0.012 * s,
        0.012 * s,
        8,
      );
      if (bbShaft) ringParts.push(bbShaft);
      const ringMesh = buildSynthesizedMesh(ringParts, metalTpl, 'crank_chainring_synth');
      if (ringMesh) crankPivot.add(ringMesh);
    }
  }

  // 4. Static Drivetrain Chain Loop on `container` (NEVER on `pivot_crank` so it never orbits in mid-air!)
  if (crankPivot && rearWheel) {
    let hasStaticChain = false;
    for (const child of container.children) {
      const m = child as T.Mesh;
      if (!m.isMesh) continue;
      for (const isl of analyzeConnectedIslands(m, rootInvM)) {
        const sy = isl.max.y - isl.min.y;
        const sz = isl.max.z - isl.min.z;
        if (isl.min.x > 0.025 * s && sz > 0.34 * s && sy > 0.11 * s && isl.max.y < 0.46 * s) {
          hasStaticChain = true;
        }
      }
    }
    if (!hasStaticChain) {
      const bbRoot = crankPivot.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
      const rearRoot = rearWheel.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
      let chainX = 0.046 * s;
      let rRing = 0.086 * s;
      for (const m of collectSubtreeMeshes(crankPivot)) {
        for (const isl of analyzeConnectedIslands(m, rootInvM)) {
          const sy = isl.max.y - isl.min.y;
          const sz = isl.max.z - isl.min.z;
          if (sy > 0.13 * s && Math.abs(sy - sz) < 0.04 * s && isl.center.x > 0.02 * s) {
            chainX = isl.center.x;
            rRing = 0.5 * sy + 0.004 * s;
          }
        }
      }
      const cogX = Math.min(chainX, 0.036 * s);
      const rCog = 0.038 * s;
      const rChainTube = 0.0042 * s;
      const chainParts: T.BufferGeometry[] = [];

      const topFront = new T.Vector3(chainX, bbRoot.y + rRing, bbRoot.z).sub(containerInRoot);
      const topRear = new T.Vector3(cogX, rearRoot.y + rCog, rearRoot.z).sub(containerInRoot);
      const botFront = new T.Vector3(chainX, bbRoot.y - rRing, bbRoot.z).sub(containerInRoot);
      const botRear = new T.Vector3(cogX, rearRoot.y - rCog, rearRoot.z).sub(containerInRoot);

      const upperRun = orientTubeGeometry(topFront, topRear, rChainTube, rChainTube, 6);
      const lowerRun = orientTubeGeometry(botFront, botRear, rChainTube, rChainTube, 6);
      if (upperRun) chainParts.push(upperRun);
      if (lowerRun) chainParts.push(lowerRun);

      // Front wrap around `+Z` half of chainring (`6` segments, `>= 3 mm` radially clear of chainring vertices)
      const fSegs = 6;
      for (let i = 0; i < fSegs; i++) {
        const a0 = (i / fSegs) * Math.PI;
        const a1 = ((i + 1) / fSegs) * Math.PI;
        const p0 = new T.Vector3(
          chainX,
          bbRoot.y + Math.cos(a0) * rRing,
          bbRoot.z + Math.sin(a0) * rRing,
        ).sub(containerInRoot);
        const p1 = new T.Vector3(
          chainX,
          bbRoot.y + Math.cos(a1) * rRing,
          bbRoot.z + Math.sin(a1) * rRing,
        ).sub(containerInRoot);
        const seg = orientTubeGeometry(p0, p1, rChainTube, rChainTube, 5);
        if (seg) chainParts.push(seg);
      }

      // Rear wrap around `-Z` half of rear cassette cog (`5` segments)
      const rSegs = 5;
      for (let i = 0; i < rSegs; i++) {
        const a0 = (i / rSegs) * Math.PI;
        const a1 = ((i + 1) / rSegs) * Math.PI;
        const p0 = new T.Vector3(
          cogX,
          rearRoot.y + Math.cos(a0) * rCog,
          rearRoot.z - Math.sin(a0) * rCog,
        ).sub(containerInRoot);
        const p1 = new T.Vector3(
          cogX,
          rearRoot.y + Math.cos(a1) * rCog,
          rearRoot.z - Math.sin(a1) * rCog,
        ).sub(containerInRoot);
        const seg = orientTubeGeometry(p0, p1, rChainTube, rChainTube, 5);
        if (seg) chainParts.push(seg);
      }

      const chainMesh = buildSynthesizedMesh(chainParts, darkTpl, 'bicycle_static_chain');
      if (chainMesh) container.add(chainMesh);
    }
  }

  // 5. Chainstay Kickstand (`pivot_kickstand`) for bicycles whose GLB lacks one (`veh_bike_touring`, `veh_bike_velodrome`)
  if (!root.getObjectByName('pivot_kickstand') && crankPivot) {
    const bbRoot = crankPivot.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
    const ksOriginInRoot = new T.Vector3(0.044 * s, Math.max(0.24 * s, bbRoot.y - 0.03 * s), bbRoot.z - 0.095 * s);
    const ksPivot = new T.Object3D();
    ksPivot.name = 'pivot_kickstand';
    ksPivot.position.copy(ksOriginInRoot).sub(containerInRoot);
    container.add(ksPivot);

    const tipLocal = new T.Vector3(0.075 * s, -(ksOriginInRoot.y - 0.010 * s), -0.105 * s);
    const ksParts: T.BufferGeometry[] = [];
    const rod = orientTubeGeometry(new T.Vector3(0, 0, 0), tipLocal, 0.0065 * s, 0.0052 * s, 6);
    const footPad = new T.BoxGeometry(0.018 * s, 0.012 * s, 0.028 * s);
    footPad.translate(tipLocal.x, tipLocal.y, tipLocal.z);
    if (rod) ksParts.push(rod);
    ksParts.push(footPad);
    const ksMesh = buildSynthesizedMesh(ksParts, metalTpl, 'kickstand_synth');
    if (ksMesh) ksPivot.add(ksMesh);
  }
}

function performLoadTimeGeometryRigging(
  root: T.Object3D,
  meta: VehicleModelMeta,
  rootInvM: T.Matrix4,
): void {
  const container = findPrimaryContainer(root);
  const wasUnriggedBicycle =
    meta.hasPedals &&
    (!root.getObjectByName('pivot_front_wheel') || !root.getObjectByName('pivot_rear_wheel'));

  if (wasUnriggedBicycle) {
    reconstructUnriggedBicycleHierarchy(root, container, rootInvM);
    synthesizeBicycleMechanicalDetails(root, container, rootInvM, true);
    return;
  }

  // 1. Synthesize missing `pivot_fork` on `veh_bike_touring`
  let steerPivot = root.getObjectByName('pivot_fork') ?? root.getObjectByName('pivot_steering') ?? null;
  const frontWheel = root.getObjectByName('pivot_front_wheel') ?? null;

  if (!meta.isCar && !steerPivot && frontWheel) {
    const forkOrigin = new T.Vector3(0, 0.804, 0.335);
    const synthFork = new T.Object3D();
    synthFork.name = 'pivot_fork';
    synthFork.position.copy(forkOrigin);
    container.add(synthFork);

    const fwPos = frontWheel.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
    synthFork.add(frontWheel);
    frontWheel.position.copy(fwPos).sub(forkOrigin);

    const existingGrips: T.Object3D[] = [];
    container.traverse((o) => {
      if (o !== synthFork && /^anchor_(?:grip|hand)_/i.test(o.name)) existingGrips.push(o);
    });
    for (const g of existingGrips) {
      const gp = g.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
      synthFork.add(g);
      g.position.copy(gp).sub(forkOrigin);
    }

    const rootMeshes: T.Mesh[] = [];
    for (const child of [...container.children]) {
      if ((child as T.Mesh).isMesh) rootMeshes.push(child as T.Mesh);
    }
    for (const m of rootMeshes) {
      if (/chrome/i.test(m.name)) {
        splitMeshByClassifier(m, container, rootInvM, (isl) =>
          isl.max.z > 0.12
            ? { targetParent: synthFork, pivotInRoot: forkOrigin, subName: `${m.name}_fork_bar` }
            : null,
        );
      } else if (/steel/i.test(m.name)) {
        splitMeshByClassifier(m, container, rootInvM, (isl) =>
          isl.min.z > 0.30
            ? { targetParent: synthFork, pivotInRoot: forkOrigin, subName: `${m.name}_fork_blade` }
            : null,
        );
      }
    }
    steerPivot = synthFork;
  }

  // 2. Extract Bicycle Saddle & Seatpost Mesh into `pivot_seatpost` (`±8 cm` per-rider virtual seat-post!)
  if (meta.hasPedals && !root.getObjectByName('pivot_seatpost')) {
    const rawSaddle = root.getObjectByName('anchor_saddle') ?? root.getObjectByName('Saddle') ?? null;
    const spOrigin = rawSaddle
      ? rawSaddle.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM)
      : new T.Vector3(0, 0.90, -0.22);

    const seatPostPivot = new T.Object3D();
    seatPostPivot.name = 'pivot_seatpost';
    seatPostPivot.position.copy(spOrigin);
    seatPostPivot.userData.baseSeatPostY = spOrigin.y;
    container.add(seatPostPivot);

    // Move leather/walnut saddle island + chrome seatpost island into `pivot_seatpost`
    for (const child of [...container.children]) {
      const m = child as T.Mesh;
      if (!m.isMesh || !/walnut|saddle|chrome/i.test(m.name)) continue;
      splitMeshByClassifier(m, container, rootInvM, (isl) =>
        isl.max.y > 0.70 &&
        isl.min.y > 0.68 &&
        Math.abs(isl.center.x) < 0.04 &&
        isl.center.z > -0.46 &&
        isl.center.z < -0.04
          ? { targetParent: seatPostPivot, pivotInRoot: spOrigin, subName: 'bicycle_saddle_mesh' }
          : null,
      );
    }
  }

  // 3. Extract `pivot_crank`, `pivot_pedal_L` (`+X`), `pivot_pedal_R` (`-X`), and `pivot_kickstand`
  if (!meta.isCar) {
    let bbCenter: T.Vector3 | null = null;
    let chainringMesh: T.Mesh | null = null;
    for (const child of container.children) {
      const m = child as T.Mesh;
      if (!m.isMesh) continue;
      const islands = analyzeConnectedIslands(m, rootInvM);
      if (
        islands.length === 1 &&
        /steel/i.test(m.name) &&
        islands[0].min.x > 0.03 &&
        islands[0].max.x < 0.09 &&
        islands[0].max.y < 0.42 &&
        islands[0].min.y > 0.12
      ) {
        bbCenter = new T.Vector3(0, islands[0].center.y, islands[0].center.z);
        chainringMesh = m;
        break;
      }
    }

    if (!bbCenter && meta.hasPedals) {
      for (const child of container.children) {
        const m = child as T.Mesh;
        if (!m.isMesh || !/rubber|iron/i.test(m.name)) continue;
        const islands = analyzeConnectedIslands(m, rootInvM);
        if (
          islands.length === 2 &&
          Math.abs(islands[0].center.x + islands[1].center.x) < 0.03 &&
          Math.abs(islands[0].center.x) > 0.07
        ) {
          bbCenter = new T.Vector3(
            0,
            0.5 * (islands[0].center.y + islands[1].center.y),
            0.5 * (islands[0].center.z + islands[1].center.z),
          );
          break;
        }
      }
    }

    let crankPivot: T.Object3D | null = null;
    let pedalPivotL: T.Object3D | null = null;
    let pedalPivotR: T.Object3D | null = null;
    let kickstandPivot = root.getObjectByName('pivot_kickstand') ?? null;

    if (meta.hasPedals && bbCenter) {
      crankPivot = new T.Object3D();
      crankPivot.name = 'pivot_crank';
      crankPivot.position.copy(bbCenter);
      container.add(crankPivot);

      if (chainringMesh) {
        const sub = buildSubMeshFromTriangles(
          chainringMesh,
          analyzeConnectedIslands(chainringMesh, rootInvM)[0].triIndices,
          rootInvM,
          bbCenter,
          'crank_chainring',
        );
        crankPivot.add(sub);
        chainringMesh.removeFromParent();
      }
    }

    for (const child of [...container.children]) {
      const m = child as T.Mesh;
      if (!m.isMesh) continue;
      if (!/graphite|steel|rubber|iron/i.test(m.name)) continue;

      splitMeshByClassifier(m, container, rootInvM, (isl) => {
        const sizeY = isl.max.y - isl.min.y;
        const sizeZ = isl.max.z - isl.min.z;

        if (
          isl.min.y < 0.025 &&
          isl.max.y < 0.40 &&
          (isl.min.x < -0.11 || isl.max.x > 0.08) &&
          sizeZ < 0.24 &&
          Math.abs(isl.center.z) < 0.32
        ) {
          const ksOrigin = new T.Vector3(0, isl.max.y - 0.012, isl.max.z - 0.008);
          if (!kickstandPivot) {
            kickstandPivot = new T.Object3D();
            kickstandPivot.name = 'pivot_kickstand';
            kickstandPivot.position.copy(ksOrigin);
            container.add(kickstandPivot);
          }
          return {
            targetParent: kickstandPivot,
            pivotInRoot: kickstandPivot.position,
            subName: 'kickstand_arm',
          };
        }

        if (!crankPivot || !bbCenter) return null;
        const rBb = Math.hypot(isl.center.y - bbCenter.y, isl.center.z - bbCenter.z);
        if (rBb > 0.21 || isl.max.y > 0.50 || isl.min.y < 0.12) return null;

        // Mesh-exact pedal pivot (`0.107 m` on `w03` bikes, `0.110 m` on `touring`)
        const isPedalPlatform =
          Math.abs(isl.center.x) > 0.085 &&
          Math.abs(isl.center.x) < 0.185 &&
          sizeY < 0.048 &&
          rBb > 0.075;
        if (isPedalPlatform) {
          const pedalOriginInRoot = isl.center.clone();
          if (isl.center.x > 0) {
            if (!pedalPivotL) {
              pedalPivotL = new T.Object3D();
              pedalPivotL.name = 'pivot_pedal_L';
              pedalPivotL.position.copy(pedalOriginInRoot).sub(bbCenter);
              crankPivot.add(pedalPivotL);
            }
            const actualPivotRoot = bbCenter.clone().add(pedalPivotL.position);
            return {
              targetParent: pedalPivotL,
              pivotInRoot: actualPivotRoot,
              subName: 'pedal_platform_L',
            };
          } else {
            if (!pedalPivotR) {
              pedalPivotR = new T.Object3D();
              pedalPivotR.name = 'pivot_pedal_R';
              pedalPivotR.position.copy(pedalOriginInRoot).sub(bbCenter);
              crankPivot.add(pedalPivotR);
            }
            const actualPivotRoot = bbCenter.clone().add(pedalPivotR.position);
            return {
              targetParent: pedalPivotR,
              pivotInRoot: actualPivotRoot,
              subName: 'pedal_platform_R',
            };
          }
        }

        const armSpan = Math.hypot(sizeY, sizeZ);
        const isCrankArm =
          Math.abs(isl.center.x) > 0.040 &&
          Math.abs(isl.center.x) < 0.110 &&
          armSpan >= 0.075 &&
          armSpan <= 0.25 &&
          rBb < 0.13;
        if (isCrankArm) {
          return {
            targetParent: crankPivot,
            pivotInRoot: bbCenter,
            subName: isl.center.x > 0 ? 'crank_arm_L' : 'crank_arm_R',
          };
        }

        return null;
      });
    }

    if (meta.hasPedals && !root.getObjectByName('pivot_crank')) {
      const fallbackBb = new T.Vector3(0, 0.285, -0.085);
      const cp = new T.Object3D();
      cp.name = 'pivot_crank';
      cp.position.copy(fallbackBb);
      container.add(cp);
      const pL = new T.Object3D();
      pL.name = 'pivot_pedal_L';
      pL.position.set(0.105, 0.107, 0);
      cp.add(pL);
      const pR = new T.Object3D();
      pR.name = 'pivot_pedal_R';
      pR.position.set(-0.105, -0.107, 0);
      cp.add(pR);
    }

    if (meta.hasPedals) {
      synthesizeBicycleMechanicalDetails(root, container, rootInvM, false);
    }
  }
}

function splitMeshByClassifier(
  mesh: T.Mesh,
  container: T.Object3D,
  rootInvM: T.Matrix4,
  classify: (
    isl: ConnectedIsland,
  ) => { targetParent: T.Object3D; pivotInRoot: T.Vector3; subName: string } | null,
): void {
  const islands = analyzeConnectedIslands(mesh, rootInvM);
  if (islands.length === 0) return;

  const keptTris: number[] = [];
  let extractedAny = false;

  for (let i = 0; i < islands.length; i++) {
    const isl = islands[i];
    const dest = classify(isl);
    if (dest) {
      extractedAny = true;
      const sub = buildSubMeshFromTriangles(
        mesh,
        isl.triIndices,
        rootInvM,
        dest.pivotInRoot,
        dest.subName,
      );
      dest.targetParent.add(sub);
    } else {
      for (let k = 0; k < isl.triIndices.length; k++) keptTris.push(isl.triIndices[k]);
    }
  }

  if (!extractedAny) return;

  if (keptTris.length === 0) {
    mesh.removeFromParent();
  } else {
    container.updateWorldMatrix(true, false);
    const containerInRoot = container.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
    const remainder = buildSubMeshFromTriangles(
      mesh,
      keptTris,
      rootInvM,
      containerInRoot,
      mesh.name,
    );
    container.add(remainder);
    mesh.removeFromParent();
  }
}

// ── Hierarchy Socket Binding (`+X` -> `.L`, `-X` -> `.R`, Tire-Only `wheelGroundY`) ─────────────────────────

function bindSocketsFromHierarchy(
  root: T.Object3D,
  modelId: string,
  meta: VehicleModelMeta,
  rootInvM: T.Matrix4,
): VehicleRigSockets {
  const container = findPrimaryContainer(root);
  const wheelPivots: T.Object3D[] = [];
  const steerPivots: T.Object3D[] = [];

  root.traverse((o) => {
    if (/^pivot_wheel_|^pivot_(?:front|rear)_wheel$/i.test(o.name)) {
      wheelPivots.push(o);
    }
    if (/^pivot_steer_|^pivot_fork$|^pivot_steering$/i.test(o.name)) {
      steerPivots.push(o);
    }
  });

  // 1. Measure Tire-Grounded `wheelGroundY`, `wheelRadius`, and `wheelbase` strictly from wheel/tire meshes
  let tireMinY = Infinity;
  let minWheelZ = Infinity;
  let maxWheelZ = -Infinity;
  let measuredRadius = 0;

  const inspectTireSubtree = (sub: T.Object3D) => {
    sub.traverse((node) => {
      const m = node as T.Mesh;
      if (!m.isMesh) return;
      const islands = analyzeConnectedIslands(m, rootInvM);
      for (const isl of islands) {
        if (isl.min.y < tireMinY) tireMinY = isl.min.y;
        const r = 0.5 * (isl.max.y - isl.min.y);
        if (r > measuredRadius && r < 0.55) measuredRadius = r;
      }
    });
  };

  for (const wp of wheelPivots) {
    const wpRoot = wp.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
    if (wpRoot.z < minWheelZ) minWheelZ = wpRoot.z;
    if (wpRoot.z > maxWheelZ) maxWheelZ = wpRoot.z;
    inspectTireSubtree(wp);
  }
  if (!Number.isFinite(tireMinY)) {
    root.traverse((node) => {
      const m = node as T.Mesh;
      if (!m.isMesh) return;
      const mat0 = Array.isArray(m.material) ? m.material[0] : m.material;
      if (/tire|wheel/i.test(m.name) || /tire/i.test(mat0?.name ?? '')) {
        inspectTireSubtree(m);
      }
    });
  }

  const wheelGroundY = Number.isFinite(tireMinY) ? Math.max(-0.04, Math.min(0.35, -tireMinY)) : 0;
  const wheelRadius = measuredRadius > 0.12 ? measuredRadius : meta.fallbackWheelRadius;
  const wheelbase =
    Number.isFinite(minWheelZ) && Number.isFinite(maxWheelZ) && maxWheelZ - minWheelZ > 0.5
      ? maxWheelZ - minWheelZ
      : meta.fallbackWheelbase;

  // 2. Measure Roof Ceiling (`halo_vector` coupe headroom guard)
  let roofCeilingY = Infinity;
  if (meta.isCar && !meta.openTop) {
    let maxBodyY = -Infinity;
    root.traverse((node) => {
      const m = node as T.Mesh;
      if (!m.isMesh) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      if (!bb) return;
      const pMax = bb.max.clone().applyMatrix4(m.matrixWorld).applyMatrix4(rootInvM);
      if (pMax.y > maxBodyY) maxBodyY = pMax.y;
    });
    if (maxBodyY > 0.85 && maxBodyY < 2.2) {
      roofCeilingY = maxBodyY;
    }
  }

  // 3. Bind or Create Articulated `pivot_seatpost` + Child `saddleOrSeat`
  let seatPostPivot = root.getObjectByName('pivot_seatpost') ?? null;
  let saddleOrSeat = root.getObjectByName('anchor_seat_calibrated') ?? null;

  if (!seatPostPivot) {
    const rawSeat =
      root.getObjectByName('anchor_saddle') ??
      root.getObjectByName('anchor_driver') ??
      root.getObjectByName('Saddle') ??
      root.getObjectByName('Dual_Seat') ??
      null;
    const seatPosInRoot = rawSeat
      ? rawSeat.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM)
      : new T.Vector3(0, meta.isCar ? 0.44 : 0.88, meta.isCar ? 0.10 : -0.22);

    if (meta.calibratedSeatY !== undefined) seatPosInRoot.y = meta.calibratedSeatY;
    if (meta.calibratedSeatZOffset !== undefined) seatPosInRoot.z += meta.calibratedSeatZOffset;

    seatPostPivot = new T.Object3D();
    seatPostPivot.name = 'pivot_seatpost';
    seatPostPivot.position.copy(seatPosInRoot);
    seatPostPivot.userData.baseSeatPostY = seatPosInRoot.y;
    container.add(seatPostPivot);
  }

  const baseSeatPostY =
    typeof seatPostPivot.userData.baseSeatPostY === 'number'
      ? (seatPostPivot.userData.baseSeatPostY as number)
      : seatPostPivot.position.y;
  seatPostPivot.userData.baseSeatPostY = baseSeatPostY;

  if (!saddleOrSeat) {
    saddleOrSeat = new T.Object3D();
    saddleOrSeat.name = 'anchor_seat_calibrated';
    saddleOrSeat.position.set(0, 0, meta.hasPedals ? (meta.calibratedSeatZOffset ?? 0) : 0);
    seatPostPivot.add(saddleOrSeat);
  }

  // 4. Bind or Create Steered Handlebar / Car Steering-Wheel Grips (`+X` -> `gripLeft`, `-X` -> `gripRight`!)
  let gripLeft = root.getObjectByName('anchor_grip_L_calibrated') ?? null;
  let gripRight = root.getObjectByName('anchor_grip_R_calibrated') ?? null;
  let steeringWheelPivot = root.getObjectByName('pivot_steering_wheel') ?? null;

  if (!gripLeft || !gripRight) {
    if (meta.isCar) {
      const seatPos = seatPostPivot.position;
      if (!steeringWheelPivot) {
        steeringWheelPivot = new T.Object3D();
        steeringWheelPivot.name = 'pivot_steering_wheel';
        steeringWheelPivot.position.set(seatPos.x, baseSeatPostY + 0.24, seatPos.z + 0.34);
        steeringWheelPivot.rotation.set(-0.36, 0, 0);
        container.add(steeringWheelPivot);
      }
      gripLeft = new T.Object3D();
      gripLeft.name = 'anchor_grip_L_calibrated';
      gripLeft.position.set(0.155, 0.015, 0);
      steeringWheelPivot.add(gripLeft);

      gripRight = new T.Object3D();
      gripRight.name = 'anchor_grip_R_calibrated';
      gripRight.position.set(-0.155, 0.015, 0);
      steeringWheelPivot.add(gripRight);
    } else {
      const steerHost = steerPivots[0] ?? container;
      steerHost.updateWorldMatrix(true, false);
      const steerHostInRoot = steerHost.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);

      let posXRoot: T.Vector3 | null = null;
      let negXRoot: T.Vector3 | null = null;

      root.traverse((o) => {
        if (/^anchor_(?:grip|hand)_/i.test(o.name) && !/_calibrated$/i.test(o.name)) {
          const p = o.getWorldPosition(new T.Vector3()).applyMatrix4(rootInvM);
          if (p.x > 0.05) posXRoot = p;
          else if (p.x < -0.05) negXRoot = p;
        }
      });

      if (!posXRoot || !negXRoot) {
        steerHost.traverse((o) => {
          const m = o as T.Mesh;
          if (!m.isMesh) return;
          if (o.parent?.name === 'pivot_front_wheel') return;
          if (!/rubber|grip|handlebar/i.test(m.name)) return;
          const islands = analyzeConnectedIslands(m, rootInvM);
          for (const isl of islands) {
            if (isl.center.y < 0.65) continue;
            if (isl.center.x > 0.10) posXRoot = isl.center.clone();
            else if (isl.center.x < -0.10) negXRoot = isl.center.clone();
          }
        });
      }

      if (!posXRoot || !negXRoot) {
        posXRoot = new T.Vector3(0.24, baseSeatPostY + 0.08, 0.26);
        negXRoot = new T.Vector3(-0.24, baseSeatPostY + 0.08, 0.26);
      }

      gripLeft = new T.Object3D();
      gripLeft.name = 'anchor_grip_L_calibrated';
      gripLeft.position.copy(posXRoot).sub(steerHostInRoot);
      steerHost.add(gripLeft);

      gripRight = new T.Object3D();
      gripRight.name = 'anchor_grip_R_calibrated';
      gripRight.position.copy(negXRoot).sub(steerHostInRoot);
      steerHost.add(gripRight);
    }
  }

  // 5. Bind Pedals / Scooter Floorboards / Moto Rearsets / Car Footwell Sockets (`+X` -> `.L`, `-X` -> `.R`)
  const crankPivot = root.getObjectByName('pivot_crank') ?? null;
  const pedalPivotLeft = root.getObjectByName('pivot_pedal_L') ?? null;
  const pedalPivotRight = root.getObjectByName('pivot_pedal_R') ?? null;
  const kickstandPivot = root.getObjectByName('pivot_kickstand') ?? null;

  let crankRadius = 0;
  let footLeft = root.getObjectByName('anchor_foot_L_calibrated') ?? null;
  let footRight = root.getObjectByName('anchor_foot_R_calibrated') ?? null;

  if (meta.hasPedals && pedalPivotLeft && pedalPivotRight) {
    crankRadius = Math.hypot(pedalPivotLeft.position.y, pedalPivotLeft.position.z);
    if (!footLeft) {
      footLeft = new T.Object3D();
      footLeft.name = 'anchor_foot_L_calibrated';
      footLeft.position.set(0, 0.008, 0);
      pedalPivotLeft.add(footLeft);
    }
    if (!footRight) {
      footRight = new T.Object3D();
      footRight.name = 'anchor_foot_R_calibrated';
      footRight.position.set(0, 0.008, 0);
      pedalPivotRight.add(footRight);
    }
  } else if (!footLeft || !footRight) {
    const seatPos = seatPostPivot.position;
    let fL: T.Vector3;
    let fR: T.Vector3;
    if (meta.isCar) {
      fL = new T.Vector3(seatPos.x + 0.105, Math.max(0.14, baseSeatPostY - 0.22), seatPos.z + 0.48);
      fR = new T.Vector3(seatPos.x - 0.105, Math.max(0.14, baseSeatPostY - 0.22), seatPos.z + 0.52);
    } else if (meta.archetype === 'step_scooter') {
      fL = new T.Vector3(0.115, 0.326, 0.085);
      fR = new T.Vector3(-0.115, 0.326, 0.085);
    } else {
      fL = new T.Vector3(0.148, 0.305, -0.145);
      fR = new T.Vector3(-0.148, 0.305, -0.145);
    }
    footLeft = new T.Object3D();
    footLeft.name = 'anchor_foot_L_calibrated';
    footLeft.position.copy(fL);
    container.add(footLeft);

    footRight = new T.Object3D();
    footRight.name = 'anchor_foot_R_calibrated';
    footRight.position.copy(fR);
    container.add(footRight);
  }

  // 6. Driver Door Pivot (`pivot_door_L0` is on `-X` alongside `anchor_driver` at `x ≈ -0.35..-0.49`)
  const doorL0 = root.getObjectByName('pivot_door_L0') ?? null;
  const doorR0 = root.getObjectByName('pivot_door_R0') ?? null;
  let driverDoorPivot: T.Object3D | null = null;
  let driverDoorSign: 1 | -1 = 1;
  if (meta.isCar) {
    if (seatPostPivot.position.x <= 0 && doorL0) {
      driverDoorPivot = doorL0;
      driverDoorSign = 1;
    } else if (doorR0) {
      driverDoorPivot = doorR0;
      driverDoorSign = -1;
    } else if (doorL0) {
      driverDoorPivot = doorL0;
      driverDoorSign = 1;
    }
  }

  root.updateWorldMatrix(true, true);

  return {
    modelId,
    archetype: meta.archetype,
    hasPedals: meta.hasPedals,
    isCar: meta.isCar,
    gearRatio: meta.gearRatio,
    wheelRadius,
    wheelbase,
    crankRadius,
    wheelGroundY,
    roofCeilingY,
    seatPostPivot,
    baseSeatPostY,
    saddleOrSeat,
    gripLeft,
    gripRight,
    footLeft,
    footRight,
    steerPivots,
    wheelPivots,
    crankPivot,
    pedalPivotLeft,
    pedalPivotRight,
    kickstandPivot,
    steeringWheelPivot,
    driverDoorPivot,
    driverDoorSign,
  };
}

// ── Zero-Allocation Per-Frame Vehicle Visual Articulation ──────────────────────────────────────────────────

export function applyVehicleRigKinematics(
  vehicleRoot: T.Object3D,
  sockets: VehicleRigSockets,
  state: RiderKinematicState,
  pose: { x: number; z: number; yaw: number },
  wheelSpinRad: number,
  leftAnklePitchRad = 0,
  rightAnklePitchRad = 0,
): void {
  vehicleRoot.position.set(pose.x, state.groundY + sockets.wheelGroundY, pose.z);
  _tmpEuler.set(state.forkDive, pose.yaw, state.lean, 'YXZ');
  vehicleRoot.quaternion.setFromEuler(_tmpEuler);

  if (vehicleRoot.children.length === 1 && !(vehicleRoot.children[0] as T.Mesh).isMesh) {
    vehicleRoot.children[0].rotation.set(0, 0, 0);
  }

  const steer = state.steer;
  for (let i = 0; i < sockets.steerPivots.length; i++) {
    const sp = sockets.steerPivots[i];
    if (sockets.isCar && Math.abs(steer) > 1e-4) {
      const isLeftWheel = sp.position.x > 0;
      const turningLeft = steer > 0;
      const ackFactor = isLeftWheel === turningLeft ? 1.08 : 0.92;
      sp.rotation.y = steer * ackFactor;
    } else {
      sp.rotation.y = steer;
    }
  }

  for (let i = 0; i < sockets.wheelPivots.length; i++) {
    sockets.wheelPivots[i].rotation.x = wheelSpinRad;
  }

  if (sockets.crankPivot) {
    sockets.crankPivot.rotation.x = state.crankAngle;
  }
  if (sockets.pedalPivotLeft) {
    sockets.pedalPivotLeft.rotation.x = -state.crankAngle + leftAnklePitchRad;
  }
  if (sockets.pedalPivotRight) {
    sockets.pedalPivotRight.rotation.x = -state.crankAngle + rightAnklePitchRad;
  }

  if (sockets.kickstandPivot) {
    sockets.kickstandPivot.rotation.x = KICKSTAND_FOLD_RAD * state.kickstandRetract;
  }

  if (sockets.steeringWheelPivot) {
    sockets.steeringWheelPivot.rotation.z = -steer * CAR_STEERING_WHEEL_RATIO;
  }
  if (sockets.driverDoorPivot) {
    sockets.driverDoorPivot.rotation.y = state.doorOpenBlend * 0.88 * sockets.driverDoorSign;
  }

  vehicleRoot.updateWorldMatrix(true, true);
}
