import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CATALOG,
  MATERIAL_FINISHES,
  type V3OwnedObject,
} from '@/lib/echo-life/v3/game-core/index.mjs';
import {
  getObjectFootprint,
  orientedBounds,
} from '@/lib/echo-life/v3/progression/placement.mjs';
import { GROUND_Y } from '@/lib/echo-life/plan';
import { ROAD_DROP } from '@/lib/echo-life/city';
import { worldPlacement } from '@/lib/echo-life/game/build';
import type { EchoLifeGame } from '@/lib/echo-life/game/session';
import type { LifeWalk } from '@/lib/echo-life/walk';
import { Automobile, type RoadVehicle } from '@/lib/echo-life/game/automobile';
import { setTrafficDensityMultiplier as setCommuteTrafficDensityMultiplier } from '@/lib/echo-life/game/commute';
import { TwoWheeler } from '@/lib/echo-life/game/twoWheeler';
import type { EnvironmentLightConditions } from '@/lib/echo-life/game/vehicleDynamics';
import { RiderIkController, type RiderKinematicState } from '@/lib/embodiment/riderIk';
import {
  acquireLifeAsset,
  installGltfTextureDedupPlugin,
  releaseLifeAsset,
  instance,
  placeOn,
  LIFE_ASSETS,
  type LifeAsset,
} from './assets';
import {
  CAR_STEERING_WHEEL_RATIO,
  KICKSTAND_FOLD_RAD,
  extractVehicleRig,
  type VehicleRigSockets,
} from './vehicleRigExtractor';
import type { EchoLifeWorld } from './world';
import type { SolidBox } from './house';

/**
 * Content-hashed Cycles-baked AAA v2 vehicle GLBs (WebP PBR + KHR_mesh_quantization, ZERO WASM).
 * Exported so `gameView.ts` can wire `VEHICLE_URL.car_mango_micro` cleanly without circular imports.
 */
export const AAA_VEHICLE_URLS = {
  car_mango_micro: '/echo-life/aaa-v2/vehicles/mango_micro_aaa-9bd136ebad7d.glb',
  parked_sedan_aaa: '/echo-life/aaa-v2/vehicles/parked_sedan_aaa-406a1236dbd2.glb',
  parked_hatch_aaa: '/echo-life/aaa-v2/vehicles/parked_hatch_aaa-9c73b7227eba.glb',
} as const;

export type VehiclePrewarmHook = (obj: T.Object3D) => Promise<void> | void;
let _vehiclePrewarmHook: VehiclePrewarmHook | undefined;

/**
 * Registers an optional async shader prewarm hook (e.g. `engine.ts` `prewarmStreamedObject`)
 * so newly loaded `RoadVehicleView`, `WorkshopView`, and parked curb-car meshes stay
 * `visible = false` until their clearcoat/sheen PBR shaders finish compiling.
 */
export function setVehiclePrewarmHook(hook: VehiclePrewarmHook | undefined): void {
  _vehiclePrewarmHook = hook;
}

export function getVehiclePrewarmHook(): VehiclePrewarmHook | undefined {
  return _vehiclePrewarmHook;
}

const base: Record<string, string> = {
  obj_starter_sofa: 'sofa',
  obj_starter_fridge: 'fridge',
  obj_starter_bed: 'bed-single',
  obj_starter_stove: 'stove',
  obj_starter_wardrobe: 'wardrobe',
};
export const propertyList = (
  CATALOG.properties as {
    properties: { id: string; name: string; price: number; exteriorModel: string }[];
  }
).properties;

type Draw = {
  root: T.Group;
  refs: LifeAsset[];
  resources: Set<T.BufferGeometry | T.Material>;
  key: string;
  original?: T.Object3D;
};
type PcPart = {
  id: string;
  width?: number;
  surfaceY?: number;
  lengthMm?: number;
  visualTier?: number;
  glowColor?: string;
};
const pcParts = CATALOG.pc as Record<string, PcPart[]>;
type Piece = { name: string; x: number; y: number; z: number };
const styles = (
  CATALOG.properties as {
    roomStyleFamilies: Record<string, { wallColor: string; floorColor: string }>;
  }
).roomStyleFamilies;

// ---------------------------------------------------------------------------
// Shared Procedural Automotive Textures (Zero Network Fetches, 1× Cached)
// ---------------------------------------------------------------------------

interface SharedVehicleTextures {
  headlightPool: T.CanvasTexture | null;
  contactShadow: T.CanvasTexture | null;
  tirePuff: T.CanvasTexture | null;
  tireTread: T.Texture | null;
}

let sharedTextures: SharedVehicleTextures | null = null;

function createCanvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
): T.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx, size);
  const tex = new T.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function getSharedVehicleTextures(): SharedVehicleTextures {
  if (sharedTextures) return sharedTextures;

  const headlightPool = createCanvasTexture(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    // Soft forward cone spreading from bottom-center (bumper) outward toward top (road ahead)
    const grad = ctx.createRadialGradient(s * 0.5, s * 0.92, s * 0.04, s * 0.5, s * 0.42, s * 0.54);
    grad.addColorStop(0.0, 'rgba(255, 246, 214, 0.95)');
    grad.addColorStop(0.32, 'rgba(255, 236, 186, 0.52)');
    grad.addColorStop(0.7, 'rgba(255, 224, 158, 0.16)');
    grad.addColorStop(1.0, 'rgba(255, 214, 140, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(s * 0.34, s);
    ctx.lineTo(s * 0.04, 0);
    ctx.lineTo(s * 0.96, 0);
    ctx.lineTo(s * 0.66, s);
    ctx.closePath();
    ctx.fill();
  });

  // High-resolution 256x256 baked undercarriage contact shadow: deep chassis umbra + 4 tire-patch anchors + soft asphalt feather.
  const contactShadow = createCanvasTexture(256, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    // Soft outer ambient occlusion penumbra
    ctx.save();
    ctx.translate(s * 0.5, s * 0.5);
    ctx.scale(0.84, 1.0);
    const outer = ctx.createRadialGradient(0, 0, s * 0.08, 0, 0, s * 0.49);
    outer.addColorStop(0.0, 'rgba(4, 6, 10, 0.94)');
    outer.addColorStop(0.46, 'rgba(5, 7, 11, 0.78)');
    outer.addColorStop(0.74, 'rgba(6, 8, 12, 0.34)');
    outer.addColorStop(0.92, 'rgba(6, 8, 12, 0.08)');
    outer.addColorStop(1.0, 'rgba(6, 8, 12, 0.0)');
    ctx.fillStyle = outer;
    ctx.fillRect(-s * 0.62, -s * 0.62, s * 1.24, s * 1.24);
    ctx.restore();

    // Sculpted underbody silhouette core (rounded chassis rectangle)
    ctx.save();
    ctx.translate(s * 0.5, s * 0.5);
    const rw = s * 0.52;
    const rh = s * 0.68;
    const rad = s * 0.14;
    ctx.beginPath();
    ctx.moveTo(-rw * 0.5 + rad, -rh * 0.5);
    ctx.lineTo(rw * 0.5 - rad, -rh * 0.5);
    ctx.quadraticCurveTo(rw * 0.5, -rh * 0.5, rw * 0.5, -rh * 0.5 + rad);
    ctx.lineTo(rw * 0.5, rh * 0.5 - rad);
    ctx.quadraticCurveTo(rw * 0.5, rh * 0.5, rw * 0.5 - rad, rh * 0.5);
    ctx.lineTo(-rw * 0.5 + rad, rh * 0.5);
    ctx.quadraticCurveTo(-rw * 0.5, rh * 0.5, -rw * 0.5, rh * 0.5 - rad);
    ctx.lineTo(-rw * 0.5, -rh * 0.5 + rad);
    ctx.quadraticCurveTo(-rw * 0.5, -rh * 0.5, -rw * 0.5 + rad, -rh * 0.5);
    ctx.closePath();
    ctx.fillStyle = 'rgba(2, 4, 8, 0.55)';
    ctx.filter = 'blur(8px)';
    ctx.fill();
    ctx.filter = 'none';

    // 4 subtle tire-contact anchor dark spots
    for (const [tx, ty] of [
      [-rw * 0.44, -rh * 0.32],
      [rw * 0.44, -rh * 0.32],
      [-rw * 0.44, rh * 0.32],
      [rw * 0.44, rh * 0.32],
    ]) {
      const wg = ctx.createRadialGradient(tx, ty, 2, tx, ty, s * 0.11);
      wg.addColorStop(0.0, 'rgba(0, 2, 5, 0.72)');
      wg.addColorStop(1.0, 'rgba(0, 2, 5, 0.0)');
      ctx.fillStyle = wg;
      ctx.fillRect(tx - s * 0.12, ty - s * 0.12, s * 0.24, s * 0.24);
    }
    ctx.restore();
  });

  const tirePuff = createCanvasTexture(64, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const grad = ctx.createRadialGradient(s * 0.5, s * 0.5, s * 0.05, s * 0.5, s * 0.5, s * 0.48);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.85)');
    grad.addColorStop(0.45, 'rgba(245, 245, 248, 0.42)');
    grad.addColorStop(1.0, 'rgba(240, 240, 245, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
  });

  let tireTread: T.Texture | null = createCanvasTexture(64, (ctx, s) => {
    ctx.fillStyle = '#707070';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#383838';
    for (let y = 0; y < s; y += 8) {
      ctx.fillRect(0, y, s, 3);
    }
    ctx.fillStyle = '#929292';
    for (let x = 0; x < s; x += 16) {
      ctx.fillRect(x, 0, 3, s);
    }
  });
  if (!tireTread) {
    const data = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const v = y % 8 < 3 ? 56 : x % 16 < 3 ? 146 : 112;
        const idx = (y * 64 + x) * 4;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
    tireTread = new T.DataTexture(data, 64, 64, T.RGBAFormat);
    tireTread.needsUpdate = true;
  }
  if (tireTread) {
    tireTread.wrapS = T.RepeatWrapping;
    tireTread.wrapT = T.RepeatWrapping;
    tireTread.repeat.set(4, 4);
  }

  sharedTextures = { headlightPool, contactShadow, tirePuff, tireTread };
  return sharedTextures;
}

// ---------------------------------------------------------------------------
// Vehicles 2.0 PBR Upgrade, Static Sub-Mesh Merging & Instanced Wheels
// ---------------------------------------------------------------------------

// Only pivots that animate at runtime keep separate sub-meshes; all other pivots (R0/L1/R1/anchor_*)
// remain strictly preserved as scene-graph nodes via PRESERVED_NODE_RE while their static panels merge cleanly.
const ARTICULATED_PIVOT_RE =
  /^(Axle_|pivot_wheel_|pivot_(?:front|rear)_wheel$|pivot_steer_|pivot_door_L0$|pivot_fork|pivot_steering|pivot_crank$|pivot_pedal_|pivot_kickstand$|pivot_seatpost$|Wheel_(FL|FR|RL|RR)|Steer_(FL|FR))/;
const PRESERVED_NODE_RE =
  /^(Axle_|pivot_wheel_|pivot_(?:front|rear)_wheel$|pivot_steer_|pivot_door_|pivot_fork|pivot_steering|pivot_crank$|pivot_pedal_|pivot_kickstand$|pivot_seatpost$|anchor_|Wheel_(FL|FR|RL|RR)|Steer_(FL|FR))/;
const PAINT_NAME_RE =
  /^(#[a-f\d]{6}|teal|terracotta|sage|Bike_Teal|Car_Silver|Car_Midnight_Blue|Scooter_Coral|.*_paint)$/i;
const GLASS_NAME_RE = /^(Optical_smoke|Clear_Glass|.*_glass)$/i;
const RUBBER_NAME_RE = /^(rubber|Tire_Rubber|.*_tire)$/i;
const ALLOY_NAME_RE = /^(steel|Galv_Steel|.*_rim|.*_alloy)$/i;
const CHROME_NAME_RE = /^(chrome|Mirror_Chrome)$/i;
const TAILLIGHT_NAME_RE = /^(red|Signal_Red|.*_taillight)$/i;
const HEADLIGHT_NAME_RE = /^(lit|LED_Street_Warm|.*_headlight)$/i;
const MATTE_TRIM_NAME_RE = /^(graphite|black|Powder_Iron|linen|ivory|.*_wheel_trim)$/i;

type MaterialSlot =
  | 'paint'
  | 'glass'
  | 'headlight'
  | 'taillight'
  | 'rubber'
  | 'alloy'
  | 'chrome'
  | 'matte_trim'
  | 'other';

export interface WheelInstanceBinding {
  mesh: T.InstancedMesh;
  pivots: Array<{ pivot: T.Object3D; localMatrix: T.Matrix4 }>;
}

export interface VehicleVisualRig {
  root: T.Object3D;
  modelId: string;
  twoWheels: boolean;
  sockets: VehicleRigSockets | null;
  riderController: RiderIkController;
  lastRiderState: RiderKinematicState | null;
  wheels: T.Object3D[];
  steer: T.Object3D[];
  doors: T.Object3D[];
  driverDoor?: T.Object3D;
  driverAnchor: T.Object3D | null;
  paint: T.MeshPhysicalMaterial[];
  headlightMats: T.MeshStandardMaterial[];
  taillightMats: T.MeshStandardMaterial[];
  headlightPoolMesh: T.Mesh | null;
  headlightPoolMat: T.MeshBasicMaterial | null;
  reverseLightMesh: T.Mesh | null;
  blinkerLeftMesh: T.Mesh | null;
  blinkerRightMesh: T.Mesh | null;
  contactShadowMesh: T.Mesh | null;
  contactShadowMat: T.MeshBasicMaterial | null;
  wheelInstances: WheelInstanceBinding[];
  ownedGeometries: Set<T.BufferGeometry>;
  ownedMaterials: Set<T.Material>;
  lastPaintHex: string | null | undefined;
  /** Exact count of Mesh/InstancedMesh drawables inside the optimized vehicle rig. */
  drawCallEstimate: number;
  /** Cached local rear tire offsets for tire dust / rain spray emission. */
  rearTireOffsets: Array<{ x: number; z: number }>;
}

function classifyMaterialSlot(name: string, twoWheels: boolean, hasMap: boolean): MaterialSlot {
  if (PAINT_NAME_RE.test(name)) return 'paint';
  if (GLASS_NAME_RE.test(name)) return 'glass';
  if (HEADLIGHT_NAME_RE.test(name)) return 'headlight';
  if (twoWheels && /^ivory$/i.test(name)) return 'headlight';
  if (TAILLIGHT_NAME_RE.test(name)) return 'taillight';
  if (RUBBER_NAME_RE.test(name)) return 'rubber';
  if (ALLOY_NAME_RE.test(name)) return 'alloy';
  if (CHROME_NAME_RE.test(name)) return 'chrome';
  if (!hasMap && MATTE_TRIM_NAME_RE.test(name)) return 'matte_trim';
  return 'other';
}

function upgradeMaterial(
  orig: T.Material,
  slot: MaterialSlot,
  ownedMaterials: Set<T.Material>,
  shared: {
    paint?: T.MeshPhysicalMaterial;
    glass?: T.MeshPhysicalMaterial;
    headlight?: T.MeshStandardMaterial;
    taillight?: T.MeshStandardMaterial;
    rubber?: T.MeshStandardMaterial;
    alloy?: T.MeshStandardMaterial;
    chrome?: T.MeshStandardMaterial;
  },
): T.Material {
  const src = orig as T.MeshStandardMaterial;
  const baseColor = src.color ? src.color.clone() : new T.Color('#8899a6');
  const side = src.side ?? T.FrontSide;
  const textures = getSharedVehicleTextures();

  if (slot === 'paint') {
    if (shared.paint) return shared.paint;
    const sheenColor = baseColor.clone().lerp(new T.Color('#ffffff'), 0.34);
    const mat = new T.MeshPhysicalMaterial({
      name: orig.name || 'vehicle_paint_pbr',
      color: baseColor,
      map: src.map ?? null,
      normalMap: src.normalMap ?? null,
      normalScale: src.normalScale ? src.normalScale.clone() : new T.Vector2(1, 1),
      roughnessMap: src.roughnessMap ?? null,
      metalnessMap: src.metalnessMap ?? null,
      aoMap: src.aoMap ?? null,
      aoMapIntensity: src.aoMap ? 0.92 : 1.0,
      metalness: src.metalnessMap ? 1.0 : 0.50,
      roughness: src.roughnessMap ? 0.86 : 0.14,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      reflectivity: 0.96,
      envMapIntensity: 1.4,
      transmission: 0,
      sheen: 0.18,
      sheenRoughness: 0.32,
      sheenColor,
      side,
    });
    mat.userData.factoryColor = baseColor.clone();
    ownedMaterials.add(mat);
    shared.paint = mat;
    return mat;
  }

  if (slot === 'glass') {
    if (shared.glass) return shared.glass;
    const mat = new T.MeshPhysicalMaterial({
      name: orig.name || 'vehicle_glass_pbr',
      color: new T.Color('#192833'),
      metalness: 0.14,
      roughness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      reflectivity: 0.96,
      transmission: 0,
      transparent: true,
      opacity: 0.56,
      envMapIntensity: 1.65,
      depthWrite: false,
      side,
    });
    ownedMaterials.add(mat);
    shared.glass = mat;
    return mat;
  }

  if (slot === 'headlight') {
    if (shared.headlight) return shared.headlight;
    const mat = new T.MeshStandardMaterial({
      name: orig.name || 'vehicle_headlight_pbr',
      color: new T.Color('#fff6e0'),
      roughness: 0.12,
      metalness: 0.1,
      emissive: new T.Color('#ffe9b8'),
      emissiveIntensity: 0.35,
      side,
    });
    ownedMaterials.add(mat);
    shared.headlight = mat;
    return mat;
  }

  if (slot === 'taillight') {
    if (shared.taillight) return shared.taillight;
    const mat = new T.MeshPhysicalMaterial({
      name: orig.name || 'vehicle_taillight_pbr',
      color: new T.Color('#b81414'),
      roughness: 0.06,
      metalness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      envMapIntensity: 1.6,
      emissive: new T.Color('#ff1818'),
      emissiveIntensity: 0.55,
      side,
    });
    ownedMaterials.add(mat);
    shared.taillight = mat;
    return mat;
  }

  if (slot === 'rubber') {
    if (shared.rubber) return shared.rubber;
    // Preserve Cycles-baked 1K WebP tire tread normal & ORM maps when provided (mango_micro_aaa),
    // falling back to our procedural `tireTread` bump map (paired with synthesized cylindrical/triplanar UVs).
    const hasBakedNormal = Boolean(src.normalMap);
    const mat = new T.MeshStandardMaterial({
      name: orig.name || 'vehicle_rubber_pbr',
      color: src.map ? new T.Color('#ffffff') : new T.Color('#15181d'),
      map: src.map ?? null,
      normalMap: src.normalMap ?? null,
      normalScale: src.normalScale ? src.normalScale.clone() : new T.Vector2(1, 1),
      roughnessMap: src.roughnessMap ?? null,
      metalnessMap: src.metalnessMap ?? null,
      aoMap: src.aoMap ?? null,
      aoMapIntensity: src.aoMap ? 0.95 : 1.0,
      roughness: src.roughnessMap ? 1.0 : 0.88,
      metalness: src.metalnessMap ? 1.0 : 0.02,
      bumpMap: hasBakedNormal ? null : textures.tireTread,
      bumpScale: !hasBakedNormal && textures.tireTread ? 0.014 : 0,
      side,
    });
    ownedMaterials.add(mat);
    shared.rubber = mat;
    return mat;
  }

  if (slot === 'alloy') {
    if (shared.alloy) return shared.alloy;
    const mat = new T.MeshStandardMaterial({
      name: orig.name || 'vehicle_alloy_pbr',
      color: baseColor.clone().lerp(new T.Color('#d8e0e8'), 0.35),
      map: src.map ?? null,
      normalMap: src.normalMap ?? null,
      roughnessMap: src.roughnessMap ?? null,
      metalnessMap: src.metalnessMap ?? null,
      aoMap: src.aoMap ?? null,
      metalness: src.metalnessMap ? 1.0 : 0.88,
      roughness: src.roughnessMap ? 1.0 : 0.22,
      envMapIntensity: 1.35,
      side,
    });
    ownedMaterials.add(mat);
    shared.alloy = mat;
    return mat;
  }

  if (slot === 'chrome') {
    if (shared.chrome) return shared.chrome;
    const mat = new T.MeshStandardMaterial({
      name: orig.name || 'vehicle_chrome_pbr',
      color: new T.Color('#eef2f6'),
      aoMap: src.aoMap ?? null,
      metalness: 0.96,
      roughness: 0.08,
      envMapIntensity: 1.5,
      side,
    });
    ownedMaterials.add(mat);
    shared.chrome = mat;
    return mat;
  }

  // Keep textured upholstery / wood / custom materials cleanly tuned (strip any transmission).
  if (orig instanceof T.MeshStandardMaterial) {
    const cloned = orig.clone();
    if ('transmission' in cloned) (cloned as T.MeshPhysicalMaterial).transmission = 0;
    if (/walnut|bamboo/i.test(orig.name)) {
      cloned.roughness = 0.52;
      cloned.metalness = 0.04;
    } else if (/linen/i.test(orig.name)) {
      cloned.roughness = 0.82;
      cloned.metalness = 0.02;
    } else if (/graphite|black|Powder_Iron/i.test(orig.name)) {
      cloned.roughness = 0.44;
      cloned.metalness = 0.14;
    }
    ownedMaterials.add(cloned);
    return cloned;
  }

  return orig;
}

/**
 * Unpacks KHR_mesh_quantization (`Int16Array`/`Uint16Array`/`Int8Array` normalized or unnormalized)
 * into plain `Float32BufferAttribute` so `applyMatrix4()` and `mergeGeometries()` never overflow or fail.
 */
function unpackQuantizedAttribute(
  g: T.BufferGeometry,
  name: string,
  itemSize: number,
): void {
  const attr = g.getAttribute(name);
  if (!attr) return;
  const isInterleaved = (attr as T.InterleavedBufferAttribute).isInterleavedBufferAttribute;
  if (!isInterleaved && attr.array instanceof Float32Array && !attr.normalized) return;
  const out = new Float32Array(attr.count * itemSize);
  for (let i = 0; i < attr.count; i++) {
    out[i * itemSize] = attr.getX(i);
    if (itemSize > 1) out[i * itemSize + 1] = attr.getY(i);
    if (itemSize > 2) out[i * itemSize + 2] = attr.getZ(i);
    if (itemSize > 3) out[i * itemSize + 3] = attr.getW(i);
  }
  g.setAttribute(name, new T.Float32BufferAttribute(out, itemSize));
}

/**
 * Synthesizes real box/cylindrical triplanar UVs from vertex positions & normals whenever a
 * legacy vehicle sub-mesh (such as untextured rubber tires) has no `uv` attribute, fixing
 * zeroed UVs so the `tireTread` bump map wraps cleanly around tire treads!
 */
function synthesizeTriplanarUvs(g: T.BufferGeometry, scale = 2.6): void {
  const pos = g.getAttribute('position');
  if (!pos) return;
  const norm = g.getAttribute('normal');
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = norm ? Math.abs(norm.getX(i)) : 0;
    const ny = norm ? Math.abs(norm.getY(i)) : 1;
    const nz = norm ? Math.abs(norm.getZ(i)) : 0;
    if (nx >= ny && nx >= nz) {
      // Wheel sidewall / side panel: planar YZ projection
      uvs[i * 2] = z * scale;
      uvs[i * 2 + 1] = y * scale;
    } else if (ny >= nz) {
      // Top/bottom tread crown: continuous planar XZ projection (zero +-PI seam)
      uvs[i * 2] = x * scale;
      uvs[i * 2 + 1] = z * scale * 2.2;
    } else {
      // Front/rear tread face: continuous planar XY projection (zero +-PI seam)
      uvs[i * 2] = x * scale;
      uvs[i * 2 + 1] = y * scale * 2.2;
    }
  }
  g.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
}

function materialUsesUv(m: T.Material): boolean {
  const s = m as T.MeshStandardMaterial;
  return Boolean(s.map || s.normalMap || s.roughnessMap || s.metalnessMap || s.aoMap || s.bumpMap);
}

/**
 * Prepares a cloned non-indexed Float32 geometry baked by `bakeMatrix` with uniform attributes
 * (`position`, `normal`, and optional `color`, `uv`, `uv1`) so `mergeGeometries` never fails
 * on `KHR_mesh_quantization` GLBs or missing tire UVs.
 */
function prepareMergeGeometry(
  source: T.BufferGeometry,
  bakeMatrix: T.Matrix4,
  vertexColor?: T.Color,
  keepUv = false,
  keepUv1 = false,
): T.BufferGeometry | null {
  if (!source.getAttribute('position')) return null;
  const g = source.index ? source.toNonIndexed() : source.clone();
  unpackQuantizedAttribute(g, 'position', 3);
  unpackQuantizedAttribute(g, 'normal', 3);
  if (keepUv) unpackQuantizedAttribute(g, 'uv', 2);
  if (keepUv1) unpackQuantizedAttribute(g, 'uv1', 2);

  g.applyMatrix4(bakeMatrix);
  if (!g.getAttribute('normal')) g.computeVertexNormals();

  // Strip inconsistent attributes so every chunk in a merge bucket matches strictly
  for (const attr of Object.keys(g.attributes)) {
    if (attr === 'position' || attr === 'normal') continue;
    if (keepUv && attr === 'uv') continue;
    if (keepUv1 && attr === 'uv1') continue;
    g.deleteAttribute(attr);
  }

  const posCount = g.getAttribute('position').count;
  if (keepUv && !g.getAttribute('uv')) {
    synthesizeTriplanarUvs(g, 2.6);
  }
  if (keepUv1 && !g.getAttribute('uv1')) {
    const uvAttr = g.getAttribute('uv');
    if (uvAttr) {
      g.setAttribute('uv1', uvAttr.clone());
    } else {
      synthesizeTriplanarUvs(g, 2.6);
      g.setAttribute('uv1', g.getAttribute('uv').clone());
    }
  }
  if (vertexColor) {
    const colors = new Float32Array(posCount * 3);
    for (let i = 0; i < posCount; i++) {
      colors[i * 3] = vertexColor.r;
      colors[i * 3 + 1] = vertexColor.g;
      colors[i * 3 + 2] = vertexColor.b;
    }
    g.setAttribute('color', new T.BufferAttribute(colors, 3));
  }
  return g;
}

function ancestorArticulatedPivot(node: T.Object3D, stopAt: T.Object3D): T.Object3D | null {
  let cur: T.Object3D | null = node;
  while (cur && cur !== stopAt) {
    if (ARTICULATED_PIVOT_RE.test(cur.name)) return cur;
    cur = cur.parent;
  }
  return null;
}

function pruneOrphanNodes(root: T.Object3D): void {
  const hasPayload = new Set<T.Object3D>([root]);
  root.traverse((o) => {
    const mesh = o as T.Mesh;
    if (mesh.isMesh || PRESERVED_NODE_RE.test(o.name)) {
      let cur: T.Object3D | null = o;
      while (cur) {
        hasPayload.add(cur);
        if (cur === root) break;
        cur = cur.parent;
      }
    }
  });
  const toRemove: T.Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && !hasPayload.has(o)) toRemove.push(o);
  });
  for (const node of toRemove) node.removeFromParent();
}

function mergeStaticSubtreeMeshes(
  container: T.Object3D,
  twoWheels: boolean,
  ownedGeometries: Set<T.BufferGeometry>,
  ownedMaterials: Set<T.Material>,
  sharedMats: {
    paint?: T.MeshPhysicalMaterial;
    glass?: T.MeshPhysicalMaterial;
    headlight?: T.MeshStandardMaterial;
    taillight?: T.MeshStandardMaterial;
    rubber?: T.MeshStandardMaterial;
    alloy?: T.MeshStandardMaterial;
    chrome?: T.MeshStandardMaterial;
  },
  allowCastShadow: boolean,
): void {
  container.updateMatrixWorld(true);
  const invContainer = container.matrixWorld.clone().invert();
  const relMatrix = new T.Matrix4();

  const buckets = new Map<
    string,
    {
      material: T.Material;
      slot: MaterialSlot;
      geoms: T.BufferGeometry[];
      castShadow: boolean;
      useVertexColors: boolean;
    }
  >();

  let matteTrimMat: T.MeshStandardMaterial | null = null;
  const sourceMeshes: T.Mesh[] = [];

  container.traverse((o) => {
    const mesh = o as T.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    // Never swallow meshes belonging to nested articulated child pivots (e.g. `pivot_pedal_L/R`
    // inside `pivot_crank`, or `pivot_front_wheel` inside `pivot_fork`)!
    if (ancestorArticulatedPivot(mesh, container)) return;
    if (Array.isArray(mesh.material)) return;
    sourceMeshes.push(mesh);
  });

  for (const mesh of sourceMeshes) {
    const origMat = mesh.material as T.Material;
    const hasMap = Boolean((origMat as T.MeshStandardMaterial).map);
    const slot = classifyMaterialSlot(origMat.name || '', twoWheels, hasMap);
    relMatrix.multiplyMatrices(invContainer, mesh.matrixWorld);

    if (slot === 'matte_trim') {
      if (!matteTrimMat) {
        matteTrimMat = new T.MeshStandardMaterial({
          name: 'vehicle_matte_trim_merged',
          color: new T.Color('#ffffff'),
          vertexColors: true,
          roughness: 0.56,
          metalness: 0.1,
        });
        ownedMaterials.add(matteTrimMat);
      }
      const srcColor = (origMat as T.MeshStandardMaterial).color?.clone() ?? new T.Color('#22262c');
      const prepared = prepareMergeGeometry(mesh.geometry, relMatrix, srcColor, false);
      if (!prepared) continue;
      const bucket = buckets.get('matte_trim') ?? {
        material: matteTrimMat,
        slot: 'matte_trim',
        geoms: [],
        castShadow: allowCastShadow,
        useVertexColors: true,
      };
      bucket.geoms.push(prepared);
      buckets.set('matte_trim', bucket);
    } else {
      const upgraded = upgradeMaterial(origMat, slot, ownedMaterials, sharedMats);
      const keepUv = materialUsesUv(upgraded);
      const keepUv1 = Boolean((upgraded as T.MeshStandardMaterial).aoMap?.channel === 1);
      const prepared = prepareMergeGeometry(mesh.geometry, relMatrix, undefined, keepUv, keepUv1);
      if (!prepared) continue;
      const key = slot === 'other' ? `other:${upgraded.uuid}` : slot;
      const castShadow =
        allowCastShadow && (slot === 'paint' || slot === 'rubber');
      const bucket = buckets.get(key) ?? {
        material: upgraded,
        slot,
        geoms: [],
        castShadow,
        useVertexColors: false,
      };
      bucket.geoms.push(prepared);
      buckets.set(key, bucket);
    }
  }

  for (const mesh of sourceMeshes) mesh.removeFromParent();

  for (const [key, bucket] of buckets) {
    if (!bucket.geoms.length) continue;
    const merged =
      bucket.geoms.length === 1
        ? bucket.geoms[0]
        : mergeGeometries(bucket.geoms, false);
    if (!merged) {
      bucket.geoms.forEach((g) => g.dispose());
      continue;
    }
    if (bucket.geoms.length > 1) {
      bucket.geoms.forEach((g) => g.dispose());
    }
    merged.computeBoundingSphere();
    ownedGeometries.add(merged);
    const mergedMesh = new T.Mesh(merged, bucket.material);
    mergedMesh.name = `veh_merged_${key}`;
    mergedMesh.castShadow = bucket.castShadow;
    mergedMesh.receiveShadow = bucket.slot !== 'glass';
    mergedMesh.frustumCulled = false;
    container.add(mergedMesh);
  }
}

/**
 * Replaces identical 4-wheel sub-meshes (`4 × 3 = 12` draw calls) with 3 `InstancedMesh`
 * batches while strictly keeping all `Axle_*`, `pivot_steer_*`, and `pivot_wheel_*` pivots intact!
 */
function buildInstancedWheels(
  root: T.Object3D,
  wheelPivots: T.Object3D[],
  ownedGeometries: Set<T.BufferGeometry>,
  ownedMaterials: Set<T.Material>,
  sharedMats: {
    paint?: T.MeshPhysicalMaterial;
    glass?: T.MeshPhysicalMaterial;
    headlight?: T.MeshStandardMaterial;
    taillight?: T.MeshStandardMaterial;
    rubber?: T.MeshStandardMaterial;
    alloy?: T.MeshStandardMaterial;
    chrome?: T.MeshStandardMaterial;
  },
): WheelInstanceBinding[] {
  if (wheelPivots.length !== 4) return [];
  const slotsPerWheel = wheelPivots.map((pivot) => {
    const entries: Array<{
      mesh: T.Mesh;
      slot: MaterialSlot;
      matName: string;
      vertCount: number;
      localMatrix: T.Matrix4;
    }> = [];
    pivot.updateMatrixWorld(true);
    const invPivot = pivot.matrixWorld.clone().invert();
    pivot.traverse((o) => {
      const mesh = o as T.Mesh;
      if (!mesh.isMesh || !mesh.geometry || Array.isArray(mesh.material)) return;
      const orig = mesh.material as T.Material;
      const slot = classifyMaterialSlot(
        orig.name || '',
        false,
        Boolean((orig as T.MeshStandardMaterial).map),
      );
      const posAttr = mesh.geometry.getAttribute('position');
      if (!posAttr) return;
      const localMatrix = new T.Matrix4().multiplyMatrices(invPivot, mesh.matrixWorld);
      entries.push({
        mesh,
        slot,
        matName: orig.name || slot,
        vertCount: posAttr.count,
        localMatrix,
      });
    });
    return entries;
  });

  const first = slotsPerWheel[0];
  if (!first.length) return [];
  // Verify all 4 wheels share identical sub-mesh counts & vertex counts per slot
  const compatible = slotsPerWheel.every(
    (list) =>
      list.length === first.length &&
      list.every(
        (entry, idx) =>
          entry.slot === first[idx].slot &&
          entry.vertCount === first[idx].vertCount &&
          entry.matName === first[idx].matName,
      ),
  );
  if (!compatible) return [];

  const bindings: WheelInstanceBinding[] = [];
  root.updateMatrixWorld(true);
  const invRoot = root.matrixWorld.clone().invert();
  const tmpM = new T.Matrix4();

  for (let subIdx = 0; subIdx < first.length; subIdx++) {
    const template = first[subIdx];
    const upgradedMat = upgradeMaterial(
      template.mesh.material as T.Material,
      template.slot,
      ownedMaterials,
      sharedMats,
    );
    const clonedGeom = template.mesh.geometry.clone();
    unpackQuantizedAttribute(clonedGeom, 'position', 3);
    unpackQuantizedAttribute(clonedGeom, 'normal', 3);
    if (materialUsesUv(upgradedMat)) {
      unpackQuantizedAttribute(clonedGeom, 'uv', 2);
      if (!clonedGeom.getAttribute('uv')) synthesizeTriplanarUvs(clonedGeom, 2.8);
    }
    ownedGeometries.add(clonedGeom);
    const inst = new T.InstancedMesh(clonedGeom, upgradedMat, 4);
    inst.name = `veh_wheels_inst_${template.slot}_${subIdx}`;
    inst.castShadow = template.slot === 'rubber';
    inst.receiveShadow = true;
    inst.frustumCulled = false;

    const pivots: Array<{ pivot: T.Object3D; localMatrix: T.Matrix4 }> = [];
    for (let wIdx = 0; wIdx < 4; wIdx++) {
      const entry = slotsPerWheel[wIdx][subIdx];
      tmpM.multiplyMatrices(invRoot, wheelPivots[wIdx].matrixWorld).multiply(entry.localMatrix);
      inst.setMatrixAt(wIdx, tmpM);
      pivots.push({ pivot: wheelPivots[wIdx], localMatrix: entry.localMatrix });
      entry.mesh.removeFromParent();
    }
    inst.instanceMatrix.needsUpdate = true;
    root.add(inst);
    bindings.push({ mesh: inst, pivots });
  }

  return bindings;
}

function createMergedBoxPair(
  boxes: Array<{ w: number; h: number; d: number; x: number; y: number; z: number }>,
): T.BufferGeometry | null {
  const parts: T.BufferGeometry[] = [];
  for (const b of boxes) {
    const g = new T.BoxGeometry(b.w, b.h, b.d);
    g.translate(b.x, b.y, b.z);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

function createHeadlightPoolsGeometry(track: number, length: number, twoWheels: boolean): T.BufferGeometry | null {
  const parts: T.BufferGeometry[] = [];
  if (twoWheels) {
    const g = new T.PlaneGeometry(1.35, 4.8);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.04, length * 0.5 + 2.35);
    parts.push(g);
  } else {
    const halfX = Math.max(0.32, track * 0.36);
    for (const sx of [-1, 1]) {
      const g = new T.PlaneGeometry(1.45, 5.8);
      g.rotateX(-Math.PI / 2);
      g.translate(sx * halfX, 0.04, length * 0.5 + 2.85);
      parts.push(g);
    }
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * Upgrades any loaded vehicle GLB scene to Vehicles 2.0 PBR standards:
 * - Physical clearcoat car paint (`clearcoat: 1.0, clearcoatRoughness: 0.08`, metallic sheen)
 * - Tinted reflective `Optical_smoke` glass, textured rubber tires, metallic alloy rims
 * - Merges static chassis sub-meshes & instances 4 identical wheels (`54 -> <= 18` draw calls)
 *   while strictly preserving `Axle_*`, `pivot_wheel_*`, `pivot_steer_*`, `pivot_door_*`,
 *   `pivot_fork`, `pivot_steering`, and `anchor_driver` / `anchor_saddle` pivots!
 * - Attaches volumetric headlight ground glow pools, white reverse lamps, left/right blinkers,
 *   and a soft ground contact shadow blob!
 */
export function upgradeAndOptimizeVehicleRig(
  root: T.Object3D,
  options: { twoWheels: boolean; track?: number; length?: number; modelId?: string },
): VehicleVisualRig {
  const existingRig = root.userData.__ecCachedVisualRig as VehicleVisualRig | undefined;
  if (root.userData.__ecUpgradedVehicleRig === true && existingRig) {
    return existingRig;
  }

  const { twoWheels } = options;
  const modelId = options.modelId ?? '';
  const ownedGeometries = new Set<T.BufferGeometry>();
  const ownedMaterials = new Set<T.Material>();
  const sharedMats: {
    paint?: T.MeshPhysicalMaterial;
    glass?: T.MeshPhysicalMaterial;
    headlight?: T.MeshStandardMaterial;
    taillight?: T.MeshStandardMaterial;
    rubber?: T.MeshStandardMaterial;
    alloy?: T.MeshStandardMaterial;
    chrome?: T.MeshStandardMaterial;
  } = {};

  // Reset `root` to local identity before extracting pivots, measuring `Box3`, or baking static merges
  // so any prior world-space placement (`RoadVehicleView`) never skews `tailY`, `plateY`, or merged bounds!
  const savedPos = root.position.clone();
  const savedQuat = root.quaternion.clone();
  const savedScale = root.scale.clone();
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);

  // Extract disjoint articulated pivots (`pivot_crank`, counter-rotating `pivot_pedal_L/R`,
  // `pivot_kickstand`, `pivot_seatpost`, `pivot_steering_wheel`, `veh_bike_touring` `pivot_fork`,
  // and calibrated `+X/-X` rider sockets) BEFORE static chassis merging!
  let sockets: VehicleRigSockets | null = modelId ? extractVehicleRig(root, modelId) : null;

  const wheels: T.Object3D[] = [];
  const steer: T.Object3D[] = [];
  const doors: T.Object3D[] = [];
  let driverDoor: T.Object3D | undefined;
  let driverAnchor: T.Object3D | null = null;

  // Measure vehicle bounds in canonical unrotated model space before modifying sub-meshes
  root.updateMatrixWorld(true);
  const bounds = new T.Box3().setFromObject(root);
  const size = new T.Vector3();
  bounds.getSize(size);
  const length = options.length ?? (size.z > 0.5 ? size.z : twoWheels ? 1.8 : 3.6);
  const track = options.track ?? (size.x > 0.3 ? size.x * 0.85 : twoWheels ? 0.55 : 1.45);
  const tailY = Math.max(0.42, Math.min(0.88, bounds.min.y + size.y * 0.44));

  root.traverse((o) => {
    if (o.name.startsWith('pivot_wheel_') || /^pivot_(front|rear)_wheel$/.test(o.name)) {
      wheels.push(o);
    }
    if (o.name.startsWith('pivot_steer_') || o.name === 'pivot_fork' || (o.name === 'pivot_steering' && twoWheels)) {
      steer.push(o);
    }
    if (o.name.startsWith('pivot_door_')) {
      doors.push(o);
      if (o.name === 'pivot_door_L0') driverDoor = o;
    }
    if (o.name === 'anchor_driver' || (!driverAnchor && o.name === 'anchor_saddle')) {
      driverAnchor = o;
    }
  });

  // 1. Merge static chassis meshes by material slot (preserves every articulated pivot untouched)
  mergeStaticSubtreeMeshes(root, twoWheels, ownedGeometries, ownedMaterials, sharedMats, true);

  // 2. Merge sub-meshes inside the animated driver door pivot (`pivot_door_L0`), crank/pedal/seatpost pivots,
  //    and two-wheeler steer/wheel pivots (synthesizing tire UVs so spinning `tireTread` bump maps read crisply!)
  if (driverDoor) {
    mergeStaticSubtreeMeshes(driverDoor, twoWheels, ownedGeometries, ownedMaterials, sharedMats, false);
  }
  if (sockets) {
    for (const subPivot of [
      sockets.crankPivot,
      sockets.pedalPivotLeft,
      sockets.pedalPivotRight,
      sockets.kickstandPivot,
      sockets.seatPostPivot,
      sockets.steeringWheelPivot,
    ]) {
      if (subPivot) {
        mergeStaticSubtreeMeshes(subPivot, twoWheels, ownedGeometries, ownedMaterials, sharedMats, false);
      }
    }
  }
  if (twoWheels) {
    for (const sp of steer) {
      mergeStaticSubtreeMeshes(sp, twoWheels, ownedGeometries, ownedMaterials, sharedMats, false);
    }
    for (const wp of wheels) {
      mergeStaticSubtreeMeshes(wp, twoWheels, ownedGeometries, ownedMaterials, sharedMats, true);
    }
  }

  // 3. Instance identical 4-wheel meshes on automobiles (`12 -> 3` draw calls) while keeping pivots intact
  const wheelInstances = twoWheels
    ? []
    : buildInstancedWheels(root, wheels, ownedGeometries, ownedMaterials, sharedMats);

  // 4. Upgrade any remaining articulated meshes (two-wheeler fork/wheels or fallback wheels)
  root.traverse((o) => {
    const mesh = o as T.Mesh;
    if (!mesh.isMesh || mesh.name.startsWith('veh_merged_') || mesh.name.startsWith('veh_wheels_inst_')) {
      return;
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const upgraded = mats.map((m) => {
      if (ownedMaterials.has(m)) return m;
      const slot = classifyMaterialSlot(
        m.name || '',
        twoWheels,
        Boolean((m as T.MeshStandardMaterial).map),
      );
      return upgradeMaterial(m, slot, ownedMaterials, sharedMats);
    });
    mesh.material = Array.isArray(mesh.material) ? upgraded : upgraded[0];
    const firstSlot = classifyMaterialSlot(
      (mats[0]?.name) || '',
      twoWheels,
      Boolean((mats[0] as T.MeshStandardMaterial)?.map),
    );
    mesh.castShadow = firstSlot === 'paint' || firstSlot === 'rubber';
    mesh.receiveShadow = firstSlot !== 'glass';
    mesh.frustumCulled = false;
  });

  // 5. Prune ~600 empty GLB export orphan nodes (keeping every Axle_*/pivot_*/anchor_* node!)
  pruneOrphanNodes(root);
  if (modelId) {
    sockets = extractVehicleRig(root, modelId);
  }

  // 6. Attach dynamic lighting rig & soft ground contact shadow
  const textures = getSharedVehicleTextures();

  // Headlight volumetric ground glow pool (1 draw call when headlights ON, 0 when OFF)
  let headlightPoolMesh: T.Mesh | null = null;
  let headlightPoolMat: T.MeshBasicMaterial | null = null;
  const poolGeom = createHeadlightPoolsGeometry(track, length, twoWheels);
  if (poolGeom) {
    ownedGeometries.add(poolGeom);
    headlightPoolMat = new T.MeshBasicMaterial({
      name: 'veh_headlight_ground_pool',
      color: new T.Color('#ffe9be'),
      map: textures.headlightPool,
      transparent: true,
      opacity: 0,
      blending: T.AdditiveBlending,
      depthWrite: false,
      side: T.DoubleSide,
    });
    ownedMaterials.add(headlightPoolMat);
    headlightPoolMesh = new T.Mesh(poolGeom, headlightPoolMat);
    headlightPoolMesh.name = 'veh_headlight_pool';
    headlightPoolMesh.visible = false;
    headlightPoolMesh.castShadow = false;
    headlightPoolMesh.receiveShadow = false;
    headlightPoolMesh.renderOrder = 2;
    root.add(headlightPoolMesh);
  }

  // White reverse lamps + Left/Right amber turn blinkers (automobiles)
  let reverseLightMesh: T.Mesh | null = null;
  let blinkerLeftMesh: T.Mesh | null = null;
  let blinkerRightMesh: T.Mesh | null = null;
  if (!twoWheels) {
    const revX = Math.max(0.24, track * 0.25);
    const revZ = -length * 0.5 - 0.012;
    const revGeom = createMergedBoxPair([
      { w: 0.11, h: 0.045, d: 0.02, x: -revX, y: tailY - 0.03, z: revZ },
      { w: 0.11, h: 0.045, d: 0.02, x: revX, y: tailY - 0.03, z: revZ },
    ]);
    if (revGeom) {
      ownedGeometries.add(revGeom);
      const revMat = new T.MeshStandardMaterial({
        name: 'veh_reverse_lamp_mat',
        color: new T.Color('#f4f8ff'),
        emissive: new T.Color('#f4f8ff'),
        emissiveIntensity: 3.2,
        roughness: 0.12,
        metalness: 0.05,
      });
      ownedMaterials.add(revMat);
      reverseLightMesh = new T.Mesh(revGeom, revMat);
      reverseLightMesh.name = 'veh_reverse_lights';
      reverseLightMesh.visible = false;
      reverseLightMesh.castShadow = false;
      root.add(reverseLightMesh);
    }

    const blinkX = Math.max(0.45, track * 0.48);
    const blinkZ = length * 0.5 - 0.04;
    const blinkerMat = new T.MeshStandardMaterial({
      name: 'veh_blinker_amber_mat',
      color: new T.Color('#ff9c14'),
      emissive: new T.Color('#ff9c14'),
      emissiveIntensity: 3.5,
      roughness: 0.15,
      metalness: 0.05,
    });
    ownedMaterials.add(blinkerMat);

    // Local +X = left side, -X = right side
    const leftGeom = createMergedBoxPair([
      { w: 0.09, h: 0.05, d: 0.03, x: blinkX, y: tailY, z: blinkZ },
      { w: 0.09, h: 0.05, d: 0.03, x: blinkX, y: tailY, z: -blinkZ },
    ]);
    if (leftGeom) {
      ownedGeometries.add(leftGeom);
      blinkerLeftMesh = new T.Mesh(leftGeom, blinkerMat);
      blinkerLeftMesh.name = 'veh_blinker_left';
      blinkerLeftMesh.visible = false;
      blinkerLeftMesh.castShadow = false;
      root.add(blinkerLeftMesh);
    }

    const rightGeom = createMergedBoxPair([
      { w: 0.09, h: 0.05, d: 0.03, x: -blinkX, y: tailY, z: blinkZ },
      { w: 0.09, h: 0.05, d: 0.03, x: -blinkX, y: tailY, z: -blinkZ },
    ]);
    if (rightGeom) {
      ownedGeometries.add(rightGeom);
      blinkerRightMesh = new T.Mesh(rightGeom, blinkerMat);
      blinkerRightMesh.name = 'veh_blinker_right';
      blinkerRightMesh.visible = false;
      blinkerRightMesh.castShadow = false;
      root.add(blinkerRightMesh);
    }

    // Crisp front and rear `EC-507 EV` license plates (1 shared CanvasTexture + 1 merged plate mesh)
    const plateY = Math.max(0.30, Math.min(0.62, bounds.min.y + size.y * 0.27));
    const frontPlate = new T.PlaneGeometry(0.46, 0.115);
    frontPlate.translate(0, plateY, length * 0.5 + 0.016);
    const rearPlate = new T.PlaneGeometry(0.46, 0.115);
    rearPlate.rotateY(Math.PI);
    rearPlate.translate(0, plateY, -length * 0.5 - 0.016);
    const mergedPlates = mergeGeometries([frontPlate, rearPlate], false);
    frontPlate.dispose();
    rearPlate.dispose();
    if (mergedPlates) {
      ownedGeometries.add(mergedPlates);
      const plateTex = getSharedLicensePlateTexture();
      const plateMat = new T.MeshStandardMaterial({
        name: 'veh_license_plate_mat',
        color: new T.Color('#f8fafc'),
        map: plateTex,
        roughness: 0.28,
        metalness: 0.12,
        envMapIntensity: 0.85,
      });
      ownedMaterials.add(plateMat);
      const plateMesh = new T.Mesh(mergedPlates, plateMat);
      plateMesh.name = 'veh_license_plates';
      plateMesh.castShadow = false;
      plateMesh.receiveShadow = true;
      root.add(plateMesh);
    }
  }

  // Baked radial undercarriage contact shadow plane beneath vehicle (1 draw call, zero shadow map cost).
  const shadowW = twoWheels ? Math.max(0.75, track + 0.34) : track + 0.62;
  const shadowL = twoWheels ? length + 0.30 : length + 0.56;
  const shadowGeom = new T.PlaneGeometry(shadowW, shadowL);
  shadowGeom.rotateX(-Math.PI / 2);
  ownedGeometries.add(shadowGeom);
  const contactShadowMat = new T.MeshBasicMaterial({
    name: 'veh_contact_shadow_mat',
    color: new T.Color('#07090e'),
    map: textures.contactShadow,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  ownedMaterials.add(contactShadowMat);
  const contactShadowMesh = new T.Mesh(shadowGeom, contactShadowMat);
  contactShadowMesh.name = 'veh_contact_shadow';
  contactShadowMesh.position.y = 0.014;
  contactShadowMesh.castShadow = false;
  contactShadowMesh.receiveShadow = false;
  contactShadowMesh.renderOrder = 1;
  root.add(contactShadowMesh);

  // Count active drawables (core vehicle meshes + contact shadow)
  let drawCallEstimate = 0;
  root.traverse((o) => {
    const m = o as T.Mesh;
    if (m.isMesh && m.visible) drawCallEstimate++;
  });

  const rearTireOffsets = twoWheels
    ? [{ x: 0, z: -length * 0.38 }]
    : [
        { x: -track * 0.48, z: -length * 0.34 },
        { x: track * 0.48, z: -length * 0.34 },
      ];

  root.position.copy(savedPos);
  root.quaternion.copy(savedQuat);
  root.scale.copy(savedScale);
  root.updateMatrixWorld(true);

  const builtRig: VehicleVisualRig = {
    root,
    modelId,
    twoWheels,
    sockets,
    riderController: new RiderIkController(),
    lastRiderState: null,
    wheels,
    steer,
    doors,
    driverDoor,
    driverAnchor,
    paint: sharedMats.paint ? [sharedMats.paint] : [],
    headlightMats: sharedMats.headlight ? [sharedMats.headlight] : [],
    taillightMats: sharedMats.taillight ? [sharedMats.taillight] : [],
    headlightPoolMesh,
    headlightPoolMat,
    reverseLightMesh,
    blinkerLeftMesh,
    blinkerRightMesh,
    contactShadowMesh,
    contactShadowMat,
    wheelInstances,
    ownedGeometries,
    ownedMaterials,
    lastPaintHex: undefined,
    drawCallEstimate,
    rearTireOffsets,
  };
  root.userData.__ecUpgradedVehicleRig = true;
  root.userData.__ecCachedVisualRig = builtRig;
  return builtRig;
}

// ---------------------------------------------------------------------------
// Single-Draw-Call Tire Dust / Drift Smoke / Rain Spray Particle Pool
// ---------------------------------------------------------------------------

interface TireParticle {
  alive: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  scale0: number;
  scale1: number;
  color: T.Color;
}

const MAX_TIRE_PARTICLES = 48;

export class TireParticlePool {
  readonly mesh: T.InstancedMesh;
  private readonly particles: TireParticle[] = [];
  private cursor = 0;
  private emitCarry = 0;
  private readonly tmpM = new T.Matrix4();
  private readonly tmpPos = new T.Vector3();
  private readonly tmpQuat = new T.Quaternion();
  private readonly tmpScale = new T.Vector3();

  constructor(parent?: T.Object3D) {
    const textures = getSharedVehicleTextures();
    const geom = new T.PlaneGeometry(0.42, 0.42);
    const mat = new T.MeshBasicMaterial({
      name: 'veh_tire_particle_pool',
      color: new T.Color('#ffffff'),
      map: textures.tirePuff,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: T.DoubleSide,
    });
    this.mesh = new T.InstancedMesh(geom, mat, MAX_TIRE_PARTICLES);
    this.mesh.name = 'echo-life-tire-particles';
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < MAX_TIRE_PARTICLES; i++) {
      this.particles.push({
        alive: false,
        age: 0,
        life: 0.55,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        scale0: 0.4,
        scale1: 1.5,
        color: new T.Color('#c2b69e'),
      });
    }
    parent?.add(this.mesh);
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    mode: 'dust' | 'drift' | 'spray',
  ): void {
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_TIRE_PARTICLES;
    p.alive = true;
    p.age = 0;
    p.life = mode === 'drift' ? 0.68 : mode === 'spray' ? 0.48 : 0.52;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.scale0 = mode === 'drift' ? 0.55 : 0.36;
    p.scale1 = mode === 'drift' ? 2.1 : mode === 'spray' ? 1.55 : 1.35;
    p.color.set(mode === 'drift' ? '#dce0e6' : mode === 'spray' ? '#c8d8e8' : '#c2b69e');
  }

  emitForVehicle(
    vehicle: RoadVehicle,
    groundY: number,
    rearOffsets: ReadonlyArray<{ x: number; z: number }>,
    dt: number,
    rainWeight: number,
    reduced: boolean,
  ): void {
    if (reduced || !vehicle.driving) return;
    const speed = Math.abs(vehicle.speed);
    const drift =
      vehicle instanceof Automobile ? vehicle.chassis.driftIntensity : 0;
    const wet = rainWeight > 0.12 || vehicle.wetRoad;
    if (speed < 3.0 && drift < 0.12) return;

    const rate = drift > 0.15 ? 36 : wet ? 24 : Math.min(18, (speed - 2.6) * 1.9);
    this.emitCarry += rate * dt;
    const count = Math.min(4, Math.floor(this.emitCarry));
    if (count <= 0) return;
    this.emitCarry -= count;

    const sin = Math.sin(vehicle.pose.yaw);
    const cos = Math.cos(vehicle.pose.yaw);
    const mode: 'dust' | 'drift' | 'spray' =
      drift > 0.15 ? 'drift' : wet ? 'spray' : 'dust';

    for (let i = 0; i < count; i++) {
      const off = rearOffsets[(this.cursor + i) % rearOffsets.length];
      const wx = vehicle.pose.x + off.x * cos + off.z * sin;
      const wz = vehicle.pose.z - off.x * sin + off.z * cos;
      const backSpeed = Math.sign(vehicle.speed || 1) * Math.min(2.2, speed * 0.18);
      const jitterX = (Math.sin(this.cursor * 12.9898) * 0.5) * 0.35;
      const jitterZ = (Math.cos(this.cursor * 78.233) * 0.5) * 0.35;
      this.emit(
        wx,
        groundY + 0.12,
        wz,
        -sin * backSpeed + jitterX,
        mode === 'spray' ? 0.65 + (i % 2) * 0.35 : 0.35 + (i % 2) * 0.25,
        -cos * backSpeed + jitterZ,
        mode,
      );
    }
  }

  update(dt: number, camera?: T.Camera | null, reduced = false): void {
    if (reduced) {
      this.mesh.count = 0;
      this.mesh.visible = false;
      return;
    }
    let active = 0;
    if (camera) this.tmpQuat.copy(camera.quaternion);
    else this.tmpQuat.setFromAxisAngle(new T.Vector3(1, 0, 0), -Math.PI * 0.35);

    for (const p of this.particles) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        continue;
      }
      const t = p.age / p.life;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vx *= Math.exp(-3.2 * dt);
      p.vz *= Math.exp(-3.2 * dt);
      p.vy *= Math.exp(-1.8 * dt);

      const fade = Math.sin((1 - t) * Math.PI * 0.5);
      const scale = (p.scale0 + (p.scale1 - p.scale0) * t) * Math.max(0.15, fade);
      this.tmpPos.set(p.x, p.y, p.z);
      this.tmpScale.setScalar(scale);
      this.tmpM.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      this.mesh.setMatrixAt(active, this.tmpM);
      this.mesh.setColorAt(active, p.color);
      active++;
    }

    this.mesh.count = active;
    this.mesh.visible = active > 0;
    if (active > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as T.Material).dispose();
  }
}

// ---------------------------------------------------------------------------
// Live Per-Frame Vehicle Visual Synchronization
// ---------------------------------------------------------------------------

const _invRoot = new T.Matrix4();
const _wheelInstMat = new T.Matrix4();

/**
 * Applies live suspension pitch/roll/heave/drift slip (automobiles), inward corner lean
 * and fork dive (two-wheelers), Ackermann steering, wheel spin/travel, instanced wheel
 * matrices, emissive brake/reverse/blinker/headlight rigs, volumetric ground glow pools,
 * contact shadow blob, and optional tire dust/spray particles.
 */
export function updateVehicleVisualRig(
  rig: VehicleVisualRig,
  vehicle: RoadVehicle,
  walk: LifeWalk,
  dt: number,
  env: EnvironmentLightConditions,
  tirePool?: TireParticlePool | null,
  reduced = false,
): void {
  if (!vehicle.spec) return;
  const pose = vehicle.pose;
  const groundY = walk.groundAt(pose.x, pose.z) ?? 0;
  const wheelGroundY = rig.sockets?.wheelGroundY ?? 0;

  // Keep vehicle lighting synchronized with live time-of-day & rain
  vehicle.updateEnvironmentLights(env, 0);

  // Step coherent rider/vehicle controller (`RiderIkController`) for crank freewheel, counter-pedals & kickstand
  let riderState: RiderKinematicState | null = null;
  if (rig.sockets) {
    const ctrl = rig.riderController;
    if (vehicle.driving && ctrl.phase === 'unmounted') {
      ctrl.mountImmediate(vehicle.speed, 1);
    } else if (!vehicle.driving && (ctrl.phase === 'riding' || ctrl.phase === 'mounting')) {
      ctrl.dismountImmediate();
    }
    riderState = ctrl.step(Math.max(0, dt), rig.sockets, {
      speed: vehicle.driving ? vehicle.speed : 0,
      maxSpeed: vehicle.spec.maxSpeed || 8,
      throttle: vehicle.driving ? vehicle.lastThrottle : 0,
      steer: vehicle.steer,
      brake: vehicle.lights.braking,
      isCoasting: vehicle instanceof TwoWheeler ? vehicle.coasting : undefined,
      externalCrankAngle:
        vehicle instanceof TwoWheeler && !vehicle.powered ? vehicle.dynamics.crankAngle : undefined,
      externalCrankOmega:
        vehicle instanceof TwoWheeler && !vehicle.powered
          ? vehicle.coasting
            ? 0
            : vehicle.pedalCadence
          : undefined,
      externalLean:
        vehicle instanceof TwoWheeler
          ? vehicle.lean
          : vehicle instanceof Automobile && vehicle.chassis.initialized
            ? vehicle.chassis.roll
            : undefined,
      externalForkDive:
        vehicle instanceof TwoWheeler
          ? vehicle.forkDive
          : vehicle instanceof Automobile && vehicle.chassis.initialized
            ? vehicle.chassis.pitch
            : undefined,
      groundY,
    });
    rig.lastRiderState = riderState;
  }

  // 1. Chassis / Frame Transform (suspension pitch/roll/heave or two-wheeler lean/fork-dive + exact tire grounding)
  if (vehicle instanceof Automobile) {
    if (!vehicle.chassis.initialized) {
      vehicle.stepIdle(Math.max(dt, 1 / 60), env);
    }
    const ch = vehicle.chassis;
    const visualYaw = pose.yaw + ch.slipAngle * 0.42;
    rig.root.position.set(pose.x, (ch.initialized ? ch.height : groundY) + wheelGroundY, pose.z);
    rig.root.rotation.set(ch.pitch, visualYaw, ch.roll, 'YXZ');

    for (const pivot of rig.wheels) {
      const wheel = vehicle.wheels.find((w) => pivot.name === `pivot_wheel_${w.side}_${w.axle}`);
      if (wheel) {
        pivot.rotation.x = wheel.spin;
        pivot.position.y = wheel.travel;
      }
    }
  } else if (vehicle instanceof TwoWheeler) {
    rig.root.position.set(pose.x, groundY + wheelGroundY, pose.z);
    rig.root.rotation.set(vehicle.forkDive, pose.yaw, vehicle.lean, 'YXZ');
    for (const w of rig.wheels) w.rotation.x = vehicle.spin;
  } else {
    rig.root.position.set(pose.x, groundY + wheelGroundY, pose.z);
    rig.root.rotation.set(
      0,
      pose.yaw,
      rig.twoWheels && vehicle.driving
        ? -0.14 * vehicle.steer * Math.min(1, Math.abs(vehicle.speed) / 2)
        : 0,
      'YXZ',
    );
    for (const w of rig.wheels) w.rotation.x = vehicle.spin;
  }

  // 2. Ackermann front steering, crank/counter-pedal freewheel, retractable kickstand, steering wheel & driver door
  for (const s of rig.steer) {
    s.rotation.y = rig.twoWheels
      ? vehicle.steer
      : vehicle.wheelSteer(s.name.endsWith('_-1') ? -1 : 1);
  }
  if (rig.sockets) {
    const sk = rig.sockets;
    const crankAngle = riderState?.crankAngle ?? 0;
    if (sk.crankPivot) sk.crankPivot.rotation.x = crankAngle;
    if (sk.pedalPivotLeft) sk.pedalPivotLeft.rotation.x = -crankAngle;
    if (sk.pedalPivotRight) sk.pedalPivotRight.rotation.x = -crankAngle;
    if (sk.kickstandPivot) {
      const retract = vehicle.driving ? (riderState?.kickstandRetract ?? 1) : 0;
      sk.kickstandPivot.rotation.x = KICKSTAND_FOLD_RAD * retract;
    }
    if (sk.steeringWheelPivot) {
      sk.steeringWheelPivot.rotation.z = -vehicle.steer * CAR_STEERING_WHEEL_RATIO;
    }
  }
  if (rig.driverDoor) {
    rig.driverDoor.rotation.y = -0.95 * vehicle.door;
  }
  rig.root.updateWorldMatrix(true, true);

  // 3. Sync instanced 4-wheel meshes from their preserved pivots
  if (rig.wheelInstances.length > 0) {
    rig.root.updateMatrixWorld(true);
    _invRoot.copy(rig.root.matrixWorld).invert();
    for (const binding of rig.wheelInstances) {
      for (let i = 0; i < binding.pivots.length; i++) {
        const p = binding.pivots[i];
        _wheelInstMat
          .multiplyMatrices(_invRoot, p.pivot.matrixWorld)
          .multiply(p.localMatrix);
        binding.mesh.setMatrixAt(i, _wheelInstMat);
      }
      binding.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // 4. Cached paint finish update (avoids redundant color writes every frame)
  const paintHex = vehicle.spec.paintHex ?? null;
  if (rig.lastPaintHex !== paintHex) {
    rig.lastPaintHex = paintHex;
    for (const mat of rig.paint) {
      if (paintHex) mat.color.set(paintHex);
      else if (mat.userData.factoryColor instanceof T.Color) {
        mat.color.copy(mat.userData.factoryColor);
      }
      mat.sheenColor.copy(mat.color).lerp(new T.Color('#ffffff'), 0.32);
    }
  }

  // 5. Live Headlights, Brake Lights, Reverse Lamps, Blinkers & Volumetric Ground Glow Pool
  const lights = vehicle.lights;
  const nightWeight = Math.max(0, Math.min(1, 1 - env.dayWeight));
  const rainWeight = Math.max(0, Math.min(1, env.rainWeight));

  for (const hm of rig.headlightMats) {
    hm.emissiveIntensity = lights.headlightsOn ? 3.4 : vehicle.driving ? 0.55 : 0.25;
  }
  for (const tm of rig.taillightMats) {
    // Daytime driving DRL = 0.55, dusk/night = 1.2, active braking = 4.2
    tm.emissiveIntensity = lights.braking
      ? 4.2
      : lights.taillightsOn || nightWeight > 0.3
        ? 1.2
        : vehicle.driving
          ? 0.55
          : 0.25;
  }

  if (rig.headlightPoolMesh && rig.headlightPoolMat) {
    const showPool = lights.headlightsOn;
    rig.headlightPoolMesh.visible = showPool;
    if (showPool) {
      rig.headlightPoolMat.opacity = Math.min(
        0.92,
        0.26 + 0.54 * nightWeight + 0.2 * rainWeight,
      );
    }
  }

  if (rig.reverseLightMesh) {
    rig.reverseLightMesh.visible = lights.reversing;
  }
  if (rig.blinkerLeftMesh) {
    rig.blinkerLeftMesh.visible = lights.blinkerLit && lights.blinker === -1;
  }
  if (rig.blinkerRightMesh) {
    rig.blinkerRightMesh.visible = lights.blinkerLit && lights.blinker === 1;
  }

  // 6. Keep ground contact shadow flush with road surface even during chassis pitch/roll
  if (rig.contactShadowMesh && rig.contactShadowMat) {
    rig.contactShadowMesh.position.y = groundY - rig.root.position.y + 0.014;
    rig.contactShadowMat.opacity = 0.68 * (0.48 + 0.52 * Math.max(0, Math.min(1, env.dayWeight)));
  }

  // 7. Tire dust / drift smoke / rain spray particles behind rear tires
  if (tirePool) {
    tirePool.emitForVehicle(vehicle, groundY, rig.rearTireOffsets, dt, rainWeight, reduced);
  }
}

export function disposeVehicleVisualRig(rig: VehicleVisualRig): void {
  delete rig.root.userData.__ecUpgradedVehicleRig;
  delete rig.root.userData.__ecCachedVisualRig;
  rig.root.removeFromParent();
  for (const g of rig.ownedGeometries) g.dispose();
  for (const m of rig.ownedMaterials) m.dispose();
  rig.ownedGeometries.clear();
  rig.ownedMaterials.clear();
}

/**
 * Builds a compact Stage-6 shader-prewarm `T.Group` covering every vehicle clearcoat/sheen/instanced PBR
 * permutation (`vehicle_paint_pbr`, `vehicle_paint_inst` + `instanceColor`, textured clearcoat paint,
 * `vehicle_glass_pbr`, `vehicle_taillight_pbr`, `vehicle_rubber_pbr`, `vehicle_matte_trim_merged`, and
 * ground glow/shadow planes) so neither `pan720Warm` nor player vehicle mounting triggers shader compilation!
 * Call `disposeDummyVehicleWarmupGroup(group)` (or `group.userData.dispose?.()`) after `compileAsync`.
 */
let _cachedDummyVehicleWarmupGroup: T.Group | null = null;

export function createDummyVehicleWarmupGroup(): T.Group {
  if (_cachedDummyVehicleWarmupGroup) {
    _cachedDummyVehicleWarmupGroup.removeFromParent();
    return _cachedDummyVehicleWarmupGroup;
  }
  const group = new T.Group();
  group.name = 'echo-life-vehicle-shader-warmup';
  const geos: T.BufferGeometry[] = [];
  const mats: T.Material[] = [];
  const texs: T.Texture[] = [];
  const textures = getSharedVehicleTextures();

  const unitBox = new T.BoxGeometry(0.02, 0.02, 0.02);
  unitBox.setAttribute('uv1', unitBox.getAttribute('uv').clone());
  geos.push(unitBox);

  const vColorBox = unitBox.clone();
  const vcCount = vColorBox.getAttribute('position').count;
  const vcArr = new Float32Array(vcCount * 3).fill(0.5);
  vColorBox.setAttribute('color', new T.BufferAttribute(vcArr, 3));
  geos.push(vColorBox);

  const pxData = new Uint8Array([200, 200, 200, 255]);
  const dummyTex = new T.DataTexture(pxData, 1, 1, T.RGBAFormat);
  dummyTex.needsUpdate = true;
  const normData = new Uint8Array([128, 128, 255, 255]);
  const dummyNormal = new T.DataTexture(normData, 1, 1, T.RGBAFormat);
  dummyNormal.needsUpdate = true;
  texs.push(dummyTex, dummyNormal);

  // 1. Untextured clearcoat + sheen paint (`vehicle_paint_pbr`)
  const paintUntextured = new T.MeshPhysicalMaterial({
    name: 'vehicle_paint_pbr',
    color: new T.Color('#3b6ea5'),
    metalness: 0.5,
    roughness: 0.14,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    reflectivity: 0.96,
    envMapIntensity: 1.4,
    transmission: 0,
    sheen: 0.18,
    sheenRoughness: 0.32,
    sheenColor: new T.Color('#7ca3cc'),
  });
  mats.push(paintUntextured);
  const mPaint = new T.Mesh(unitBox, paintUntextured);
  mPaint.castShadow = true;
  mPaint.receiveShadow = true;
  group.add(mPaint);

  // 2. Textured clearcoat + sheen paint (`mango_micro_aaa` / AAA v2 player vehicles)
  const paintTextured = new T.MeshPhysicalMaterial({
    name: 'vehicle_paint_textured_pbr',
    color: new T.Color('#ffffff'),
    map: dummyTex,
    normalMap: dummyNormal,
    roughnessMap: dummyTex,
    metalnessMap: dummyTex,
    aoMap: dummyTex,
    aoMapIntensity: 0.92,
    metalness: 1.0,
    roughness: 0.86,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    reflectivity: 0.96,
    envMapIntensity: 1.4,
    transmission: 0,
    sheen: 0.18,
    sheenRoughness: 0.32,
    sheenColor: new T.Color('#ffffff'),
  });
  mats.push(paintTextured);
  const mPaintTex = new T.Mesh(unitBox, paintTextured);
  mPaintTex.castShadow = true;
  mPaintTex.receiveShadow = true;
  group.add(mPaintTex);

  // 3. Instanced clearcoat paint with `instanceColor` (`parked_sedan_aaa` / `parked_hatch_aaa`)
  const paintInstMat = new T.MeshPhysicalMaterial({
    name: 'vehicle_paint_inst',
    color: new T.Color('#ffffff'),
    map: dummyTex,
    normalMap: dummyNormal,
    roughnessMap: dummyTex,
    metalnessMap: dummyTex,
    aoMap: dummyTex,
    aoMapIntensity: 0.92,
    metalness: 1.0,
    roughness: 0.86,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    reflectivity: 0.96,
    envMapIntensity: 1.4,
    transmission: 0,
  });
  mats.push(paintInstMat);
  const instPaint = new T.InstancedMesh(unitBox, paintInstMat, 1);
  instPaint.castShadow = true;
  instPaint.receiveShadow = true;
  instPaint.setMatrixAt(0, new T.Matrix4());
  instPaint.setColorAt(0, new T.Color('#c85a3a'));
  instPaint.instanceMatrix.needsUpdate = true;
  if (instPaint.instanceColor) instPaint.instanceColor.needsUpdate = true;
  group.add(instPaint);

  // 4. Clearcoat automotive glass (`vehicle_glass_pbr` — Mesh + InstancedMesh)
  const glassMat = new T.MeshPhysicalMaterial({
    name: 'vehicle_glass_pbr',
    color: new T.Color('#192833'),
    metalness: 0.14,
    roughness: 0.05,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    reflectivity: 0.96,
    transmission: 0,
    transparent: true,
    opacity: 0.56,
    envMapIntensity: 1.65,
    depthWrite: false,
  });
  mats.push(glassMat);
  const mGlass = new T.Mesh(unitBox, glassMat);
  mGlass.receiveShadow = false;
  group.add(mGlass);
  const instGlass = new T.InstancedMesh(unitBox, glassMat, 1);
  instGlass.receiveShadow = true;
  instGlass.setMatrixAt(0, new T.Matrix4());
  instGlass.instanceMatrix.needsUpdate = true;
  group.add(instGlass);

  // 5. Clearcoat emissive taillight (`vehicle_taillight_pbr`)
  const tailMat = new T.MeshPhysicalMaterial({
    name: 'vehicle_taillight_pbr',
    color: new T.Color('#b81414'),
    roughness: 0.06,
    metalness: 0.05,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.6,
    emissive: new T.Color('#ff1818'),
    emissiveIntensity: 0.55,
  });
  mats.push(tailMat);
  const mTail = new T.Mesh(unitBox, tailMat);
  mTail.receiveShadow = true;
  group.add(mTail);

  // 6. Tire rubber (`vehicle_rubber_pbr` — Mesh + InstancedMesh) & vertex-color matte trim
  const rubberMat = new T.MeshStandardMaterial({
    name: 'vehicle_rubber_pbr',
    color: new T.Color('#15181d'),
    roughness: 0.88,
    metalness: 0.02,
    bumpMap: textures.tireTread,
    bumpScale: textures.tireTread ? 0.014 : 0,
  });
  mats.push(rubberMat);
  const mRubber = new T.Mesh(unitBox, rubberMat);
  mRubber.castShadow = true;
  mRubber.receiveShadow = true;
  group.add(mRubber);
  const instRubber = new T.InstancedMesh(unitBox, rubberMat, 1);
  instRubber.castShadow = true;
  instRubber.receiveShadow = true;
  instRubber.setMatrixAt(0, new T.Matrix4());
  instRubber.instanceMatrix.needsUpdate = true;
  group.add(instRubber);

  const trimMat = new T.MeshStandardMaterial({
    name: 'vehicle_matte_trim_merged',
    color: new T.Color('#ffffff'),
    vertexColors: true,
    roughness: 0.56,
    metalness: 0.1,
  });
  mats.push(trimMat);
  const mTrim = new T.Mesh(vColorBox, trimMat);
  mTrim.castShadow = true;
  mTrim.receiveShadow = true;
  group.add(mTrim);

  const detachOnly = () => {
    group.removeFromParent();
  };
  group.userData.dispose = detachOnly;
  group.userData.disposeWarmup = detachOnly;
  group.userData.__ecOwnedGeos = geos;
  group.userData.__ecOwnedMats = mats;
  group.userData.__ecOwnedTexs = texs;
  _cachedDummyVehicleWarmupGroup = group;
  return group;
}

export function disposeDummyVehicleWarmupGroup(group: T.Object3D | null | undefined): void {
  if (!group) return;
  const fn = (group.userData?.disposeWarmup ?? group.userData?.dispose) as (() => void) | undefined;
  if (typeof fn === 'function') fn();
}

// ---------------------------------------------------------------------------
// Workshop Furniture & PC Workstation Renderer (Preserved + Gloss Clearcoat)
// ---------------------------------------------------------------------------

// Physical component mounts from the sealed V3 workstation, scaled to the installed desktop.
function workstation(draw: Draw, obj: V3OwnedObject): Piece[] {
  const installed = obj.installedComponents as Record<string, unknown>;
  const partId = (slot: string) =>
    typeof installed[slot] === 'string' ? (installed[slot] as string) : '';
  const desk = pcParts.desks.find((p) => p.id === partId('desk')) ?? pcParts.desks[0];
  const top = desk.surfaceY ?? 0.76;
  const width = desk.width ?? 1.15;
  const towerX = Math.min(0.85, width * 0.36);
  const pieces: Piece[] = [
    { name: desk.id, x: 0, y: 0, z: 0 },
    { name: obj.selectedVariantId, x: towerX, y: top, z: -0.04 },
    { name: partId('monitors') || 'mon_dorm_single', x: -0.06, y: top, z: -0.14 },
  ];
  for (const [slot, x, z] of [
    ['keyboard', -0.08, 0.17],
    ['mouse', 0.19, 0.17],
    ['speakers', -towerX - 0.02, -0.08],
    ['microphone', -0.34, 0.12],
  ] as const) {
    const name = partId(slot);
    if (name) pieces.push({ name, x, y: top, z });
  }
  const mounts: Record<string, [number, number, number]> = {
    acc_mousepad_xl: [0, 0.002, 0.16],
    acc_headset_stand: [-towerX + 0.08, 0, 0.16],
    acc_webcam_stream: [-0.06, 0.43, -0.14],
    acc_monitor_lightbar: [-0.06, 0.4, -0.17],
    acc_stream_deck: [towerX - 0.12, 0, 0.14],
    acc_audio_interface: [-towerX + 0.12, 0, -0.17],
    acc_ring_light: [towerX - 0.13, 0, -0.25],
  };
  for (const name of Array.isArray(installed.accessories) ? installed.accessories : []) {
    if (typeof name !== 'string' || !mounts[name]) continue;
    const [x, h, z] = mounts[name];
    pieces.push({ name, x, y: top + h, z });
  }
  const mount = (
    name: string,
    geo: T.BufferGeometry,
    mat: T.Material,
    x: number,
    y: number,
    z: number,
  ) => {
    draw.resources.add(geo);
    draw.resources.add(mat);
    const mesh = new T.Mesh(geo, mat);
    mesh.name = name;
    mesh.position.set(x, y, z);
    draw.root.add(mesh);
  };
  const gpu = pcParts.gpus.find((p) => p.id === partId('gpu'));
  if (gpu?.visualTier && gpu.lengthMm) {
    const glow = [0, 0x34d399, 0x38bdf8, 0xc084fc, 0xf59e0b][Math.min(gpu.visualTier, 4)];
    mount(
      gpu.id,
      new T.BoxGeometry(0.03, 0.055, gpu.lengthMm / 1000),
      new T.MeshStandardMaterial({
        color: 0x1e2430,
        emissive: glow,
        emissiveIntensity: 1.4,
        metalness: 0.7,
        roughness: 0.25,
      }),
      towerX - 0.11,
      top + 0.17,
      -0.02,
    );
  }
  if (Array.isArray(installed.ram) && installed.ram.length) {
    const geometry = new T.BoxGeometry(0.012, 0.095, 0.018);
    const material = new T.MeshStandardMaterial({
      color: 0x222836,
      emissive: 0x5eead4,
      emissiveIntensity: 1.6,
      roughness: 0.2,
    });
    installed.ram
      .slice(0, 4)
      .forEach((part, i) =>
        mount(String(part), geometry, material, towerX - 0.105, top + 0.28, -0.06 + i * 0.025),
      );
  }
  const rgb = pcParts.rgb.find((p) => p.id === partId('rgb'));
  if (rgb?.glowColor)
    mount(
      rgb.id,
      new T.BoxGeometry(width * 0.85, 0.016, 0.022),
      new T.MeshBasicMaterial({ color: rgb.glowColor }),
      0,
      top - 0.02,
      -0.26,
    );
  return pieces;
}

interface ParkedCarSpec {
  kind: 'sedan' | 'hatch';
  x: number;
  y: number;
  z: number;
  yaw: number;
  color: string;
}

interface ParkedTemplate {
  parts: Array<{
    geometry: T.BufferGeometry;
    material: T.Material;
    isPaint: boolean;
    castShadow: boolean;
  }>;
  width: number;
  length: number;
}

let parkedLoader: GLTFLoader | null = null;
const parkedTemplateCache = new Map<string, Promise<ParkedTemplate | null>>();

function loadParkedCarTemplate(url: string): Promise<ParkedTemplate | null> {
  const cached = parkedTemplateCache.get(url);
  if (cached) return cached;
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!parkedLoader) {
    parkedLoader = new GLTFLoader();
    installGltfTextureDedupPlugin(parkedLoader, { isHero: false });
  }
  const promise = parkedLoader
    .loadAsync(url)
    .then((gltf): ParkedTemplate | null => {
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const box = new T.Box3().setFromObject(root);
      const size = box.getSize(new T.Vector3());
      const minY = Number.isFinite(box.min.y) ? box.min.y : 0;
      const centerX = Number.isFinite(box.min.x) ? (box.min.x + box.max.x) * 0.5 : 0;
      const centerZ = Number.isFinite(box.min.z) ? (box.min.z + box.max.z) * 0.5 : 0;
      const shift = new T.Matrix4().makeTranslation(-centerX, -minY, -centerZ);
      const bake = new T.Matrix4();
      const parts: ParkedTemplate['parts'] = [];

      root.traverse((o) => {
        const mesh = o as T.Mesh;
        if (!mesh.isMesh || !mesh.geometry || Array.isArray(mesh.material)) return;
        const orig = mesh.material as T.MeshStandardMaterial;
        const matName = orig.name || '';
        const isPaint = /_paint$/i.test(matName) || PAINT_NAME_RE.test(matName);
        const isGlass = /_glass$/i.test(matName) || GLASS_NAME_RE.test(matName);

        let material: T.Material;
        if (isPaint) {
          // Neutral white base color so per-instance `setColorAt` drives metallic clearcoat paint hue cleanly.
          material = new T.MeshPhysicalMaterial({
            name: `${matName}_inst`,
            color: new T.Color('#ffffff'),
            map: orig.map ?? null,
            normalMap: orig.normalMap ?? null,
            roughnessMap: orig.roughnessMap ?? null,
            metalnessMap: orig.metalnessMap ?? null,
            aoMap: orig.aoMap ?? null,
            aoMapIntensity: orig.aoMap ? 0.92 : 1.0,
            metalness: orig.metalnessMap ? 1.0 : 0.48,
            roughness: orig.roughnessMap ? 0.86 : 0.14,
            clearcoat: 1.0,
            clearcoatRoughness: 0.05,
            reflectivity: 0.96,
            envMapIntensity: 1.4,
            transmission: 0,
            side: orig.side ?? T.FrontSide,
          });
        } else if (isGlass) {
          material = new T.MeshPhysicalMaterial({
            name: `${matName}_inst`,
            color: new T.Color('#192833'),
            metalness: 0.14,
            roughness: 0.05,
            clearcoat: 1.0,
            clearcoatRoughness: 0.04,
            reflectivity: 0.96,
            transmission: 0,
            transparent: true,
            opacity: 0.56,
            envMapIntensity: 1.6,
            depthWrite: false,
            side: orig.side ?? T.FrontSide,
          });
        } else {
          const cloned = orig.clone();
          if ('transmission' in cloned) (cloned as T.MeshPhysicalMaterial).transmission = 0;
          cloned.roughness = orig.roughnessMap ? 1.0 : 0.78;
          cloned.metalness = orig.metalnessMap ? 1.0 : 0.12;
          material = cloned;
        }

        bake.multiplyMatrices(shift, mesh.matrixWorld);
        const keepUv = materialUsesUv(material);
        const keepUv1 = Boolean((material as T.MeshStandardMaterial).aoMap?.channel === 1);
        const geom = prepareMergeGeometry(mesh.geometry, bake, undefined, keepUv, keepUv1);
        if (!geom) {
          material.dispose();
          return;
        }
        geom.computeBoundingBox();
        geom.computeBoundingSphere();
        parts.push({
          geometry: geom,
          material,
          isPaint,
          castShadow: isPaint,
        });
      });

      if (!parts.length) return null;
      return {
        parts,
        width: size.x > 0.5 ? size.x : 1.9,
        length: size.z > 1.0 ? size.z : 4.2,
      };
    })
    .catch(() => null);
  parkedTemplateCache.set(url, promise);
  return promise;
}

function setTightInstancedBounds(mesh: T.InstancedMesh, count: number): void {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const baseBox = mesh.geometry.boundingBox;
  if (!baseBox || count <= 0) {
    mesh.computeBoundingSphere();
    return;
  }
  const agg = new T.Box3();
  const m = new T.Matrix4();
  const b = new T.Box3();
  for (let i = 0; i < count; i++) {
    mesh.getMatrixAt(i, m);
    b.copy(baseBox).applyMatrix4(m);
    agg.union(b);
  }
  mesh.boundingBox = agg;
  mesh.boundingSphere = agg.getBoundingSphere(new T.Sphere());
}

let sharedLicensePlateTex: T.CanvasTexture | null = null;
function getSharedLicensePlateTexture(): T.CanvasTexture | null {
  if (sharedLicensePlateTex) return sharedLicensePlateTex;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#f4f7fb';
  ctx.fillRect(0, 0, 256, 64);
  // Crisp EV blue country band on left
  ctx.fillStyle = '#1e40af';
  ctx.fillRect(4, 4, 28, 56);
  ctx.fillStyle = '#93c5fd';
  ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('EV', 18, 34);
  // Dark embossed outer frame
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 252, 60);
  // High-contrast plate lettering
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 34px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('EC-507 EV', 142, 34);
  const tex = new T.CanvasTexture(canvas);
  tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  sharedLicensePlateTex = tex;
  return tex;
}

let activeWorkshopViewCount = 0;
let cityTrafficDensityMult = 1.0;

export function getTrafficDensityMultiplier(): number {
  return cityTrafficDensityMult;
}

function disposeParkedTemplateCache(): void {
  for (const promise of parkedTemplateCache.values()) {
    void promise.then((tpl) => {
      if (!tpl) return;
      for (const part of tpl.parts) {
        part.geometry.dispose();
        const std = part.material as T.MeshStandardMaterial;
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
          std[k]?.dispose();
        }
        part.material.dispose();
      }
    });
  }
  parkedTemplateCache.clear();
}

export interface ParkedCurbBox {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly yaw: number;
}

const BILLBOARD_THEMES: Record<string, { bgTop: string; bgBot: string; accent: string; text: string }> = {
  coastal: { bgTop: '#0c2340', bgBot: '#1b4965', accent: '#38bdf8', text: '#f0f9ff' },
  botanical: { bgTop: '#102a1f', bgBot: '#1f4d36', accent: '#4ade80', text: '#ecfdf5' },
  sunset: { bgTop: '#3b1525', bgBot: '#7c2d12', accent: '#fbbf24', text: '#fffbeb' },
  neon: { bgTop: '#13112b', bgBot: '#2e1065', accent: '#c084fc', text: '#faf5ff' },
  classic: { bgTop: '#1e293b', bgBot: '#334155', accent: '#f59e0b', text: '#f8fafc' },
};

export class WorkshopView {
  private items = new Map<string, Draw>();
  private revision = -2;
  private nearby = false;
  private parkedGroup: T.Group | null = null;
  private parkedOwned: { dispose(): void }[] = [];
  private parkedBoxes: ParkedCurbBox[] = [];
  private ghostGroup: T.Group | null = null;
  private ghostBoxMat: T.MeshBasicMaterial | null = null;
  private ghostRingMat: T.MeshBasicMaterial | null = null;
  private ghostBoxGeo: T.BoxGeometry | null = null;
  private ghostRingGeo: T.RingGeometry | null = null;
  private ghostItemId: string | null = null;
  private billboardGroup: T.Group | null = null;
  private billboardCanvas: HTMLCanvasElement | null = null;
  private billboardTex: T.CanvasTexture | null = null;
  private billboardOwned: { dispose(): void }[] = [];
  private disposed = false;
  constructor(
    private world: EchoLifeWorld,
    private group: T.Group,
  ) {
    activeWorkshopViewCount++;
    this.initParkedCurbCars();
  }

  /** Axis-aligned solid footprints of the 6 instanced parked curb cars so vehicles and NPCs collide cleanly. */
  parkedCurbBoxes(): ReadonlyArray<ParkedCurbBox> {
    return this.parkedBoxes;
  }

  /** Renders a translucent emerald-green (`valid`) or crimson-red (`!valid`) snapped Build Mode placement ghost. */
  setPlacementGhost(
    itemId: string | null,
    pos?: { x: number; y: number; z: number } | null,
    rotY = 0,
    valid = true,
  ): void {
    if (this.disposed) return;
    if (!itemId || !pos) {
      this.ghostItemId = null;
      if (this.ghostGroup) this.ghostGroup.visible = false;
      return;
    }
    if (!this.ghostGroup) {
      const grp = new T.Group();
      grp.name = 'echo-life-build-ghost';
      const boxGeo = new T.BoxGeometry(1, 1, 1);
      const boxMat = new T.MeshBasicMaterial({
        color: '#22c55e',
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
      });
      const boxMesh = new T.Mesh(boxGeo, boxMat);
      boxMesh.name = 'ghost_volume';
      boxMesh.position.y = 0.5;
      boxMesh.renderOrder = 10;

      const ringGeo = new T.RingGeometry(0.52, 0.64, 32);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new T.MeshBasicMaterial({
        color: '#22c55e',
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        side: T.DoubleSide,
      });
      const ringMesh = new T.Mesh(ringGeo, ringMat);
      ringMesh.name = 'ghost_ring';
      ringMesh.position.y = 0.03;
      ringMesh.renderOrder = 11;

      grp.add(boxMesh, ringMesh);
      this.group.add(grp);
      this.ghostGroup = grp;
      this.ghostBoxGeo = boxGeo;
      this.ghostBoxMat = boxMat;
      this.ghostRingGeo = ringGeo;
      this.ghostRingMat = ringMat;
    }

    if (itemId !== this.ghostItemId) {
      this.ghostItemId = itemId;
      const lower = itemId.toLowerCase();
      const w = /sofa|couch|bed|table|desk|bookshelf|piano/.test(lower) ? 1.5 : /lamp|plant|chair|stool/.test(lower) ? 0.68 : 1.05;
      const h = /bookshelf|wardrobe|lamp|tree/.test(lower) ? 1.65 : /bed|sofa|chair|rug/.test(lower) ? 0.78 : 0.92;
      const d = /bed/.test(lower) ? 1.95 : /sofa|desk|table/.test(lower) ? 0.88 : 0.78;
      const vol = this.ghostGroup.getObjectByName('ghost_volume');
      const ring = this.ghostGroup.getObjectByName('ghost_ring');
      if (vol) {
        vol.scale.set(w, h, d);
        vol.position.y = h * 0.5;
      }
      if (ring) {
        const rad = Math.max(w, d) * 0.95;
        ring.scale.set(rad, 1, rad);
      }
    }

    const colorHex = valid ? '#22c55e' : '#ef4444';
    this.ghostBoxMat?.color.set(colorHex);
    this.ghostRingMat?.color.set(colorHex);
    this.ghostGroup.position.set(pos.x, pos.y, pos.z);
    this.ghostGroup.rotation.y = rotY;
    this.ghostGroup.visible = true;
  }

  /** Updates the Manage City digital plaza billboard headline and color theme (zero ampersands, English copy). */
  setBillboardConfig(headline: string, theme: string): void {
    if (this.disposed || typeof document === 'undefined') return;
    const cleanText = (headline || 'Welcome to Echo Harbor')
      .replace(/&/g, ' and ')
      .replace(/[<>]/g, '')
      .trim()
      .slice(0, 48);
    const palette = BILLBOARD_THEMES[theme] ?? BILLBOARD_THEMES.coastal;

    if (!this.billboardGroup) {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 192;
      const tex = new T.CanvasTexture(canvas);
      tex.colorSpace = T.SRGBColorSpace;
      tex.anisotropy = 4;

      const grp = new T.Group();
      grp.name = 'echo-life-city-billboard';
      const postGeo = new T.CylinderGeometry(0.08, 0.10, 3.2, 8);
      const frameGeo = new T.BoxGeometry(3.8, 1.48, 0.16);
      const screenGeo = new T.PlaneGeometry(3.56, 1.30);
      const metalMat = new T.MeshStandardMaterial({ color: '#1e293b', roughness: 0.42, metalness: 0.72 });
      const screenMat = new T.MeshStandardMaterial({
        map: tex,
        emissiveMap: tex,
        emissive: new T.Color('#ffffff'),
        emissiveIntensity: 0.55,
        roughness: 0.24,
        metalness: 0.05,
      });

      const postL = new T.Mesh(postGeo, metalMat);
      postL.position.set(-1.35, 1.6, 0);
      const postR = new T.Mesh(postGeo, metalMat);
      postR.position.set(1.35, 1.6, 0);
      const frame = new T.Mesh(frameGeo, metalMat);
      frame.position.set(0, 3.4, 0);
      const screenFront = new T.Mesh(screenGeo, screenMat);
      screenFront.position.set(0, 3.4, 0.086);
      const screenBack = new T.Mesh(screenGeo, screenMat);
      screenBack.rotation.y = Math.PI;
      screenBack.position.set(0, 3.4, -0.086);

      grp.add(postL, postR, frame, screenFront, screenBack);
      const plaza = this.world.city.zones.find((z) => z.id === 'fountain_plaza');
      const bx = plaza ? (plaza.rect.x0 + plaza.rect.x1) * 0.5 : 14;
      const bz = plaza ? plaza.rect.z0 + 1.4 : this.world.plan.front + 1.6;
      const by = this.world.walk.groundAt(bx, bz) ?? GROUND_Y;
      grp.position.set(bx, by, bz);
      this.group.add(grp);

      this.billboardGroup = grp;
      this.billboardCanvas = canvas;
      this.billboardTex = tex;
      this.billboardOwned.push(postGeo, frameGeo, screenGeo, metalMat, screenMat, tex);
    }

    const ctx = this.billboardCanvas?.getContext('2d');
    if (ctx && this.billboardCanvas && this.billboardTex) {
      const { width, height } = this.billboardCanvas;
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, palette.bgTop);
      grad.addColorStop(1, palette.bgBot);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 6;
      ctx.strokeRect(8, 8, width - 16, height - 16);
      ctx.fillStyle = palette.accent;
      ctx.font = 'bold 18px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ECHO HARBOR CITY BULLETIN', width / 2, 46);
      ctx.fillStyle = palette.text;
      ctx.font = 'bold 30px system-ui, -apple-system, sans-serif';
      ctx.fillText(cleanText, width / 2, 114, width - 56);
      this.billboardTex.needsUpdate = true;
    }
  }

  /** Adjusts city traffic density multiplier (clamped `0.3..1.5`, for Manage City). */
  setTrafficDensity(mult: number): number {
    cityTrafficDensityMult = Number.isFinite(mult) ? Math.max(0.3, Math.min(1.5, mult)) : 1;
    setCommuteTrafficDensityMultiplier(cityTrafficDensityMult);
    return cityTrafficDensityMult;
  }

  /**
   * Stages 6 instanced AAA parked urban cars (`parked_sedan_aaa` & `parked_hatch_aaa`) cleanly in designated
   * road-curb bays along Lantern Street and Market Boulevard (strictly clear of sidewalks, crosswalks,
   * intersections, doors, driving centerlines, and player starter car spawn) with baked radial undercarriage
   * contact shadows (<= 7 total draw calls city-wide).
   */
  private initParkedCurbCars(): void {
    const city = this.world.city;
    const front = this.world.plan.front;
    const s1 = front + 3;
    const s2 = front + 10;
    const s3 = front + 13;
    const m0 = s3 + 30;
    const m1 = m0 + 3;
    const roadY = GROUND_Y - ROAD_DROP;

    const byId = (id: string) => city.buildings.find((b) => b.id === id);
    const bistro = byId('bistro');
    const minh = byId('minh');
    const linh = byId('linh');
    const market = byId('market');
    const library = byId('library');
    const homeCenter = byId('home_center');
    const repairShop = byId('repair_shop');
    const clothingShop = byId('clothing_shop');
    const vehicleDealer = byId('vehicle_dealer');

    const entrance = this.world.plan.doors.find((d) => d.id === 'entrance');
    const crossings = city.ground.filter((g) => g.surface === 'crossing').map((g) => g.rect);
    const isBayClear = (x: number, z: number): boolean => {
      // Strictly keep >= 6.5 m clear of every zebra crosswalk on the same street (P1-VIS-5D!).
      for (const cr of crossings) {
        if (z >= cr.z0 - 1.5 && z <= cr.z1 + 1.5 && x >= cr.x0 - 6.5 && x <= cr.x1 + 6.5) {
          return false;
        }
      }
      // Strictly keep >= 9.0 m clear of the starter home entrance / EV driving spawn corridor on Lantern Street.
      if (entrance && z >= s1 - 1.0 && z <= s2 + 1.0 && Math.abs(x - entrance.x) < 9.0) {
        return false;
      }
      return true;
    };

    const specs: ParkedCarSpec[] = [];
    const tryAddBay = (spec: ParkedCarSpec) => {
      if (isBayClear(spec.x, spec.z)) specs.push(spec);
    };

    if (bistro) {
      // East of Willow Corner Bistro (>= 12.6 m clear of home crosswalk & EV spawn, >= 8.6 m east of Bistro door).
      tryAddBay({
        kind: 'hatch',
        x: bistro.rect.x1 + 2.6,
        y: roadY,
        z: s2 - 1.06,
        yaw: Math.PI / 2,
        color: '#2f5c78',
      });
    }
    if (minh && linh) {
      tryAddBay({
        kind: 'sedan',
        x: (minh.rect.x1 + linh.rect.x0) * 0.5,
        y: roadY,
        z: s1 + 1.06,
        yaw: -Math.PI / 2,
        color: '#c7cfd8',
      });
    }
    if (market) {
      tryAddBay({
        kind: 'sedan',
        x: market.rect.x1 + 7.2,
        y: roadY,
        z: s2 - 1.06,
        yaw: Math.PI / 2,
        color: '#34495a',
      });
    }
    if (library) {
      tryAddBay({
        kind: 'hatch',
        x: library.rect.x1 + 7.5,
        y: roadY,
        z: s1 + 1.06,
        yaw: -Math.PI / 2,
        color: '#a8523d',
      });
    }
    if (homeCenter && repairShop) {
      tryAddBay({
        kind: 'sedan',
        x: (homeCenter.rect.x1 + repairShop.rect.x0) * 0.5,
        y: roadY,
        z: m1 + 1.06,
        yaw: -Math.PI / 2,
        color: '#3b5e50',
      });
    }
    if (clothingShop && vehicleDealer) {
      tryAddBay({
        kind: 'hatch',
        x: (clothingShop.rect.x1 + vehicleDealer.rect.x0) * 0.5,
        y: roadY,
        z: m1 + 1.06,
        yaw: -Math.PI / 2,
        color: '#d8cfc0',
      });
    }
    if (!specs.length) return;

    // Register exact axis-aligned and oriented curb-car footprints so player vehicles and NPCs collide cleanly!
    this.parkedBoxes = specs.map((sp) => {
      const halfLength = sp.kind === 'sedan' ? 2.18 : 1.96;
      const halfWidth = 0.98;
      const halfHeight = 0.72;
      const cosY = Math.abs(Math.cos(sp.yaw));
      const sinY = Math.abs(Math.sin(sp.yaw));
      const halfAlongX = halfWidth * cosY + halfLength * sinY;
      const halfAlongZ = halfWidth * sinY + halfLength * cosY;
      return {
        x0: sp.x - halfAlongX,
        x1: sp.x + halfAlongX,
        z0: sp.z - halfAlongZ,
        z1: sp.z + halfAlongZ,
        x: sp.x,
        y: sp.y + halfHeight,
        z: sp.z,
        hx: halfWidth,
        hy: halfHeight,
        hz: halfLength,
        yaw: sp.yaw,
      };
    });

    const grp = new T.Group();
    grp.name = 'echo-life-parked-curb-cars';
    grp.visible = false;
    this.parkedGroup = grp;
    this.group.add(grp);

    const sedans = specs.filter((s) => s.kind === 'sedan');
    const hatches = specs.filter((s) => s.kind === 'hatch');

    void Promise.all([
      sedans.length ? loadParkedCarTemplate(AAA_VEHICLE_URLS.parked_sedan_aaa) : Promise.resolve(null),
      hatches.length ? loadParkedCarTemplate(AAA_VEHICLE_URLS.parked_hatch_aaa) : Promise.resolve(null),
    ]).then(([sedanTpl, hatchTpl]) => {
      if (this.disposed || this.parkedGroup !== grp) return;
      const tf = new T.Object3D();
      const color = new T.Color();
      const shadowMatrices: T.Matrix4[] = [];

      const mountGroup = (tpl: ParkedTemplate | null, list: ParkedCarSpec[], tag: string) => {
        if (!tpl || !list.length) return;
        for (let pIdx = 0; pIdx < tpl.parts.length; pIdx++) {
          const part = tpl.parts[pIdx];
          const inst = new T.InstancedMesh(part.geometry, part.material, list.length);
          inst.name = `parked_${tag}_${pIdx}`;
          inst.castShadow = part.castShadow;
          inst.receiveShadow = true;
          for (let i = 0; i < list.length; i++) {
            const sp = list[i];
            tf.position.set(sp.x, sp.y, sp.z);
            tf.rotation.set(0, sp.yaw, 0);
            tf.scale.set(1, 1, 1);
            tf.updateMatrix();
            inst.setMatrixAt(i, tf.matrix);
            if (part.isPaint) {
              color.set(sp.color);
              inst.setColorAt(i, color);
            }
          }
          inst.instanceMatrix.needsUpdate = true;
          if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
          setTightInstancedBounds(inst, list.length);
          grp.add(inst);
          this.parkedOwned.push(inst);
        }
        // Record scaled undercarriage contact shadow transform for each parked car
        for (const sp of list) {
          tf.position.set(sp.x, sp.y + 0.014, sp.z);
          tf.rotation.set(0, sp.yaw, 0);
          tf.scale.set(tpl.width + 0.56, 1, tpl.length + 0.52);
          tf.updateMatrix();
          shadowMatrices.push(tf.matrix.clone());
        }
      };

      mountGroup(sedanTpl, sedans, 'sedan');
      mountGroup(hatchTpl, hatches, 'hatch');

      if (shadowMatrices.length) {
        const textures = getSharedVehicleTextures();
        const shadowGeo = new T.PlaneGeometry(1, 1);
        shadowGeo.rotateX(-Math.PI / 2);
        const shadowMat = new T.MeshBasicMaterial({
          name: 'veh_parked_contact_shadow_mat',
          color: new T.Color('#07090e'),
          map: textures.contactShadow,
          transparent: true,
          opacity: 0.66,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        const shadowInst = new T.InstancedMesh(shadowGeo, shadowMat, shadowMatrices.length);
        shadowInst.name = 'veh_parked_contact_shadows';
        shadowInst.renderOrder = 1;
        shadowInst.castShadow = false;
        shadowInst.receiveShadow = false;
        shadowMatrices.forEach((m, i) => shadowInst.setMatrixAt(i, m));
        shadowInst.instanceMatrix.needsUpdate = true;
        setTightInstancedBounds(shadowInst, shadowMatrices.length);
        grp.add(shadowInst);
        this.parkedOwned.push(shadowGeo, shadowMat, shadowInst);
      }

      const hook = _vehiclePrewarmHook;
      if (hook) {
        void Promise.resolve(hook(grp)).finally(() => {
          if (!this.disposed && this.parkedGroup === grp) grp.visible = true;
        });
      } else {
        grp.visible = true;
      }
    });
  }

  private remove(id: string) {
    const d = this.items.get(id);
    if (!d) return;
    d.root.removeFromParent();
    d.refs.forEach(releaseLifeAsset);
    this.items.delete(id);
    d.resources.forEach((r) => r.dispose());
    if (d.original && !Array.from(this.items.values()).some((item) => item.original === d.original)) {
      d.original.visible = true;
    }
  }

  private attachSmartTvMediaConsole(d: Draw): T.Group {
    const consoleGrp = new T.Group();
    consoleGrp.name = 'tv_smart_55_media_console';
    const walnutGeo = createMergedBoxPair([
      // Top slab flush at y = +0.55 m
      { w: 1.44, h: 0.032, d: 0.40, x: 0, y: 0.534, z: 0 },
      // Bottom cabinet deck
      { w: 1.40, h: 0.028, d: 0.38, x: 0, y: 0.174, z: 0 },
      // Outer walnut end panels + 2 interior compartment dividers
      { w: 0.026, h: 0.33, d: 0.38, x: -0.687, y: 0.353, z: 0 },
      { w: 0.026, h: 0.33, d: 0.38, x: 0.687, y: 0.353, z: 0 },
      { w: 0.022, h: 0.33, d: 0.36, x: -0.25, y: 0.353, z: -0.005 },
      { w: 0.022, h: 0.33, d: 0.36, x: 0.25, y: 0.353, z: -0.005 },
      // Center open media shelf + recessed back panel
      { w: 0.48, h: 0.020, d: 0.35, x: 0, y: 0.355, z: -0.008 },
      { w: 1.38, h: 0.33, d: 0.016, x: 0, y: 0.353, z: -0.18 },
    ]);
    if (walnutGeo) {
      d.resources.add(walnutGeo);
      const walnutMat = new T.MeshStandardMaterial({
        name: 'tv_console_walnut_mat',
        color: new T.Color('#5c3f2a'),
        roughness: 0.48,
        metalness: 0.04,
      });
      d.resources.add(walnutMat);
      const walnutMesh = new T.Mesh(walnutGeo, walnutMat);
      walnutMesh.name = 'tv_console_walnut';
      walnutMesh.castShadow = true;
      walnutMesh.receiveShadow = true;
      consoleGrp.add(walnutMesh);
    }

    const slateGeo = createMergedBoxPair([
      // Left and right matte-slate cabinet doors
      { w: 0.41, h: 0.305, d: 0.018, x: -0.468, y: 0.353, z: 0.182 },
      { w: 0.41, h: 0.305, d: 0.018, x: 0.468, y: 0.353, z: 0.182 },
      // 4 plinth legs elevating deck to 0.16 m
      { w: 0.04, h: 0.16, d: 0.04, x: -0.61, y: 0.08, z: -0.14 },
      { w: 0.04, h: 0.16, d: 0.04, x: 0.61, y: 0.08, z: -0.14 },
      { w: 0.04, h: 0.16, d: 0.04, x: -0.61, y: 0.08, z: 0.14 },
      { w: 0.04, h: 0.16, d: 0.04, x: 0.61, y: 0.08, z: 0.14 },
      // Sleek matte-slate media player on center shelf
      { w: 0.34, h: 0.042, d: 0.22, x: 0, y: 0.386, z: 0.02 },
    ]);
    if (slateGeo) {
      d.resources.add(slateGeo);
      const slateMat = new T.MeshStandardMaterial({
        name: 'tv_console_slate_mat',
        color: new T.Color('#272c34'),
        roughness: 0.56,
        metalness: 0.18,
      });
      d.resources.add(slateMat);
      const slateMesh = new T.Mesh(slateGeo, slateMat);
      slateMesh.name = 'tv_console_slate';
      slateMesh.castShadow = true;
      slateMesh.receiveShadow = true;
      consoleGrp.add(slateMesh);
    }

    d.root.add(consoleGrp);
    return consoleGrp;
  }

  private add(id: string, key: string, obj: V3OwnedObject, replaces?: string) {
    const root = new T.Group();
    const d: Draw = { root, refs: [], resources: new Set(), key };
    this.items.set(id, d);
    this.group.add(root);
    const isSmartTv55 = obj.selectedVariantId === 'tv_smart_55';
    let tvConsoleGrp: T.Group | null = null;
    if (isSmartTv55) {
      tvConsoleGrp = this.attachSmartTvMediaConsole(d);
    }
    const pieces =
      obj.category === 'electronics_pc'
        ? workstation(d, obj)
        : [{ name: obj.selectedVariantId, x: 0, y: isSmartTv55 ? 0.55 : 0, z: 0 }];
    for (const piece of pieces) {
      if (!Object.hasOwn(LIFE_ASSETS, piece.name)) continue;
      const asset = piece.name as LifeAsset;
      d.refs.push(asset);
      void acquireLifeAsset(asset).then((p) => {
        if (!p || this.items.get(id) !== d) return;
        const model = instance(p, [placeOn(p, piece.x, piece.y, piece.z, 0)]);
        const appearance = obj.customAppearance as
          | { finishId?: string; primaryColor?: string }
          | undefined;
        const finish =
          appearance?.primaryColor && appearance.finishId
            ? MATERIAL_FINISHES[appearance.finishId]
            : null;
        if (finish && (obj.category !== 'electronics_pc' || piece.name.startsWith('desk_'))) {
          model.traverse((node) => {
            if (
              !(node instanceof T.Mesh) ||
              !(node.material instanceof T.MeshStandardMaterial) ||
              node.material.transparent
            )
              return;
            // Upgrade glossy/lacquer workshop finishes to physical clearcoat for crisp reflections
            if (finish.roughness < 0.25) {
              const tinted = node.material.color.clone().lerp(new T.Color(finish.primaryColor), 0.65);
              const phys = new T.MeshPhysicalMaterial({
                color: tinted,
                roughness: finish.roughness,
                metalness: finish.metalness,
                clearcoat: 0.9,
                clearcoatRoughness: 0.1,
                map: node.material.map,
                normalMap: node.material.normalMap,
                roughnessMap: node.material.roughnessMap,
              });
              node.material = phys;
              d.resources.add(phys);
            } else {
              const material = node.material.clone();
              material.color.lerp(new T.Color(finish.primaryColor), 0.65);
              material.roughness = finish.roughness;
              material.metalness = finish.metalness;
              node.material = material;
              d.resources.add(material);
            }
          });
        }
        const hook = _vehiclePrewarmHook;
        if (hook) {
          model.visible = false;
          if (tvConsoleGrp) tvConsoleGrp.visible = false;
        }
        root.add(model);
        const reveal = () => {
          if (this.disposed || this.items.get(id) !== d) return;
          model.visible = true;
          if (tvConsoleGrp) tvConsoleGrp.visible = true;
          if (replaces) {
            const original = this.world.group
              .getObjectByName('echo-life-house')
              ?.getObjectByName('life:' + replaces);
            if (original) {
              d.original = original;
              original.visible = false;
            }
          }
        };
        if (hook) {
          void Promise.resolve(hook(root)).finally(reveal);
        } else {
          reveal();
        }
      });
    }
    return d;
  }

  update(
    game: EchoLifeGame,
    player: { x: number; z: number },
    held: string | null,
    preview: { x: number; y: number; z: number; yaw: number } | undefined,
  ) {
    const near = Math.hypot(player.x, player.z) < 48;
    if (
      this.revision !== game.workshopRevision ||
      near !== this.nearby ||
      held ||
      this.items.has('preview')
    ) {
      const changed = this.revision !== game.workshopRevision;
      this.nearby = near;
      this.revision = game.workshopRevision;
      const solids: SolidBox[] = [];
      const wanted = new Set<string>();
      for (const obj of game.s.progression.ownedObjects) {
        const replaces = base[obj.instanceId];
        const appearance = obj.customAppearance as
          | { styleFamily?: string; primaryColor?: string }
          | undefined;
        const restyled =
          !!appearance?.primaryColor ||
          (!!appearance?.styleFamily && appearance.styleFamily !== 'budget_student');
        if (obj.category.startsWith('vehicle') || (replaces && !obj.upgradeLevel && !restyled))
          continue;
        const core = replaces ? this.world.plan.furniture.find((f) => f.asset === replaces) : null;
        const placed = core ? { ...core, yaw: core.rotY } : worldPlacement(this.world.walk, obj);
        if (placed && !core) {
          const f = getObjectFootprint(obj);
          const b = orientedBounds(f.width, f.depth, placed.yaw);
          solids.push({
            x: placed.x,
            z: placed.z,
            y: placed.y + 0.36,
            hx: b.halfW,
            hy: 0.36,
            hz: b.halfD,
          });
        }
        const moving = obj.instanceId === held;
        const at = moving ? preview : placed;
        if (!at || !near) continue;
        const id = moving ? 'preview' : obj.instanceId;
        const key = obj.instanceId + '/' + obj.selectedVariantId + '/' + obj.revision;
        wanted.add(id);
        if (this.items.get(id)?.key !== key) this.remove(id);
        const draw = this.items.get(id) ?? this.add(id, key, obj, replaces);
        draw.root.position.set(at.x, at.y + (moving ? 0.14 : 0), at.z);
        draw.root.rotation.y = at.yaw;
      }
      for (const id of this.items.keys()) if (!wanted.has(id)) this.remove(id);
      if (changed) {
        const finishes: Record<string, { wallColor: string; floorColor: string }> = {};
        for (const [zone, style] of Object.entries(
          game.s.progression.roomStyles as Record<string, string>,
        )) {
          if (style !== 'budget_student' && Object.hasOwn(styles, style)) {
            const { wallColor, floorColor } = styles[style];
            finishes[zone] = { wallColor, floorColor };
          }
        }
        this.world.setRoomFinishes(finishes);
        const owned = game.s.progression.properties.ownedIds;
        game.nav.setFurniture(solids);
        this.world.setWorkshop(solids, Array.isArray(owned) ? owned : []);
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    activeWorkshopViewCount = Math.max(0, activeWorkshopViewCount - 1);
    for (const id of this.items.keys()) this.remove(id);
    for (const r of this.parkedOwned) r.dispose();
    this.parkedOwned.length = 0;
    this.parkedBoxes = [];
    this.parkedGroup?.removeFromParent();
    this.parkedGroup = null;
    if (this.ghostGroup) {
      this.ghostGroup.removeFromParent();
      this.ghostBoxGeo?.dispose();
      this.ghostBoxMat?.dispose();
      this.ghostRingGeo?.dispose();
      this.ghostRingMat?.dispose();
      this.ghostGroup = null;
      this.ghostBoxGeo = null;
      this.ghostBoxMat = null;
      this.ghostRingGeo = null;
      this.ghostRingMat = null;
    }
    if (this.billboardGroup) {
      this.billboardGroup.removeFromParent();
      for (const r of this.billboardOwned) r.dispose();
      this.billboardOwned.length = 0;
      this.billboardGroup = null;
      this.billboardCanvas = null;
      this.billboardTex = null;
    }
    if (activeWorkshopViewCount === 0) {
      disposeParkedTemplateCache();
    }
    this.world.setRoomFinishes({});
    this.world.setWorkshop([], []);
  }
}
