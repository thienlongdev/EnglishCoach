import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ArenaBoatRole, ArenaBoatState } from '@/types/speakingArena';
import type { HandContact, HumanRig } from '@/lib/embodiment/human';
import { handleGrip, handleShape } from '@/lib/embodiment/handle';
import type { ArenaBoatRigPose } from './ArenaCharacter';
import type { ArenaAmbience } from './arenaAmbience';
import type { ArenaQualityTier, ArenaVesselKind, MinimapBoatMarker } from './arenaContracts';
import { arenaArchipelagoAssets, arenaV7Assets } from './arenaAssets';
import { STEP, type ArenaMotion } from './arenaMotion';
import { arenaWaveHeight, type SeaWakeSource } from './arenaSea';
import {
  ARENA_HULL,
  ARENA_WATER_Y,
  arenaBoatClear,
  arenaBoatRescue,
  arenaBoatStep,
  arenaDisembarkPoint,
  arenaHullForModel,
  arenaLayout,
  arenaOverboardPoint,
  type ArenaOverboardLanding,
} from './arenaTerrain';

const TAU = Math.PI * 2;
const normAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Exact measured GLB cockpit deck (`floorY`) and bench/thwart heights (`seatH = benchTopY - floorY`)
 * across all 5 playable vessel classes (`B03`):
 * - `skiff`: keel floor `+0.041 m`, benches `+0.394/+0.395 m` at `z = -0.18 / +0.90 m`
 * - `sampan`: flat deck `+0.055 m`, benches `+0.363 m` at `z = -0.18 / +0.90 m`
 * - `pelagic` / `tern`: deck `+0.310 m`, standing helm `z = -0.54 m` (wheel `(0, 1.19, -0.20)`, `0.415 m` canopy clearance), bow bench `+0.805 m` at `z = +1.64 m`
 * - `cruiser`: deck `+0.310 m`, standing helm `z = -0.54 m`, forward bench A `+0.805 m` at `z = +1.48 m` (clear of `+2.09 m` bench B)
 */
export const VESSEL_SEAT_SPECS = Object.freeze({
  skiff: { floorY: 0.041, rowerZ: -0.18, rowerSeatH: 0.353, paxZ: 0.9, paxSeatH: 0.354, paxFacesAft: true },
  sampan: { floorY: 0.055, rowerZ: -0.18, rowerSeatH: 0.308, paxZ: 0.9, paxSeatH: 0.308, paxFacesAft: true },
  pelagic: { floorY: 0.31, rowerZ: -0.54, rowerSeatH: 0, paxZ: 1.64, paxSeatH: 0.495, paxFacesAft: false },
  tern: { floorY: 0.31, rowerZ: -0.54, rowerSeatH: 0, paxZ: 1.64, paxSeatH: 0.495, paxFacesAft: false },
  cruiser: { floorY: 0.31, rowerZ: -0.54, rowerSeatH: 0, paxZ: 1.48, paxSeatH: 0.495, paxFacesAft: false },
} as const);

export interface ArenaBoatAttachmentPose extends ArenaBoatRigPose {
  /** Bench cushion height above hull `floorY` (metres), or `undefined` when standing at the helm. */
  seatHeightAboveDeck?: number;
  /** Live hull pitch in radians (+bow down / -bow up in hull frame) for spinal wave counter-balance. */
  hullPitch: number;
  /** Live hull roll in radians (+starboard / -port heel) for spinal wave counter-balance. */
  hullRoll: number;
  /** World-space steering wheel centre on motor launches/cruisers. */
  wheelWorld?: T.Vector3;
  /** World-space oar grip centres on rowboats/sampans. */
  oarsWorld?: { left: T.Vector3; right: T.Vector3 };
}

export interface ArenaOverboardLaunch extends ArenaOverboardLanding {
  exitVx: number;
  exitVz: number;
}

const GRIP_RADIUS = 0.024;
const GRIP_HALF = 0.05;
const OAR = (side: 1 | -1) => ({
  centre: new T.Vector3(-side * 0.44 * Math.cos(Math.PI / 12), 0.44 * Math.sin(Math.PI / 12), 0),
  inboard: new T.Vector3(-side * Math.cos(Math.PI / 12), Math.sin(Math.PI / 12), 0),
});
const OAR_L = OAR(1);
const OAR_R = OAR(-1);
const DRIVE = 0.48;

export function arenaStroke(phase: number, out = { sweep: 0, dip: 0, lean: 0, power: 0 }) {
  const u = (((phase / TAU) % 1) + 1) % 1;
  if (u < DRIVE) {
    const t = u / DRIVE;
    const e = t * t * (3 - 2 * t);
    out.sweep = -1 + 2 * e;
    out.dip = smooth(0, 0.14, t) * (1 - smooth(0.86, 1, t));
    out.lean = -0.35 + e;
    out.power = 4 * t * (1 - t);
  } else {
    const t = (u - DRIVE) / (1 - DRIVE);
    const e = t * t * (3 - 2 * t);
    out.sweep = 1 - 2 * e;
    out.dip = -0.4 * Math.sin(Math.PI * t);
    out.lean = 0.65 - e;
    out.power = 0;
  }
  return out;
}

export interface BoatRuntime {
  id: string;
  dock: string;
  kind: ArenaVesselKind;
  motor: boolean;
  footprint: typeof ARENA_HULL;
  engine: boolean;
  throttle: number;
  steering: number;
  surge: number;
  loadModel?: () => void;
  wheel?: T.Object3D;
  engineNode?: T.Object3D;
  propeller?: T.Object3D;
  homeX: number;
  homeZ: number;
  homeYaw: number;
  x: number;
  z: number;
  yaw: number;
  prevX: number;
  prevZ: number;
  prevYaw: number;
  vx: number;
  vz: number;
  yawVel: number;
  speed: number;
  rowPhase: number;
  prevRowPhase: number;
  effort: number;
  turn: number;
  bump: number;
  stuckFor: number;
  seenSeq: number;
  rower: string | null;
  passenger: string | null;
  bladeSubmerged: boolean;
  hullPitch: number;
  hullRoll: number;
  matrixSynced: boolean;
  shadowSleeping: boolean;
  rowPose: ArenaBoatAttachmentPose;
  paxPose: ArenaBoatAttachmentPose;
  wheelWorld: T.Vector3;
  oarsWorld: { left: T.Vector3; right: T.Vector3 };
  group: T.Group;
  hull: T.Object3D;
  oarL: T.Object3D;
  oarR: T.Object3D;
}

interface SplashRing {
  x: number;
  z: number;
  age: number;
  life: number;
}

interface AmbientCruiser {
  kind: 'trawler' | 'sailboat';
  radiusX: number;
  radiusZ: number;
  centerX: number;
  centerZ: number;
  angularSpeed: number;
  phase0: number;
  direction: 1 | -1;
  group: T.Group;
  x: number;
  z: number;
  yaw: number;
  speed: number;
}

function hullHalfBeam(u: number) {
  if (u < 0.52) return 0.72 * Math.pow(Math.sin(((u / 0.52) * Math.PI) * 0.5), 0.72);
  return 0.72 * (1 - 0.39 * Math.pow((u - 0.52) / 0.48, 1.55));
}

function hullSheer(u: number) {
  return (
    0.45 +
    0.2 * Math.pow(1 - Math.min(1, u / 0.42), 1.8) +
    0.09 * Math.pow(Math.max(0, (u - 0.62) / 0.38), 1.6)
  );
}

function dryMaskGeometry(lengthScale = 1, beamScale = 1) {
  const stations = 30;
  const positions: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= stations; i++) {
    const u = 0.015 + (i / stations) * 0.97;
    const w = Math.max(0, (Math.max(0.018, hullHalfBeam(u) * beamScale) - 0.031) * 0.94 - 0.012);
    const y = hullSheer(u) - 0.035;
    const z = (2.02 - u * 3.84) * lengthScale;
    positions.push(-w, y, z, w, y, z);
    if (i < stations) {
      const k = i * 2;
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  return g;
}

function resolvePlayableVesselKind(model?: string | null): ArenaVesselKind {
  if (model === 'sampan') return 'sampan';
  if (model === 'pelagic') return 'pelagic';
  if (model === 'tern') return 'tern';
  if (model === 'cruiser') return 'cruiser';
  return 'skiff';
}

function isMotorVessel(kind: ArenaVesselKind): boolean {
  return kind === 'pelagic' || kind === 'tern' || kind === 'cruiser';
}

export class ArenaBoatFleet {
  readonly boats = new Map<string, BoatRuntime>();
  private readonly ambient: AmbientCruiser[] = [];
  private readonly splashes: SplashRing[] = [];
  private splashCursor = 0;
  private readonly splashGeo = new T.RingGeometry(0.14, 0.28, 20);
  private readonly splashMat = new T.MeshBasicMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 0.52,
    blending: T.AdditiveBlending,
    depthWrite: false,
    side: T.DoubleSide,
  });
  private readonly splashInst: T.InstancedMesh<T.RingGeometry, T.MeshBasicMaterial>;
  private readonly splashDummyMat = new T.Matrix4();
  private readonly splashDummyPos = new T.Vector3();
  private readonly splashDummyQuat = new T.Quaternion();
  private readonly splashDummyScale = new T.Vector3();
  private readonly splashColor = new T.Color();
  private readonly skiffMaskGeo = dryMaskGeometry(1, 1);
  private readonly sampanMaskGeo = dryMaskGeometry(1.18, 1.06);
  private readonly maskMat = new T.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    side: T.DoubleSide,
  });
  private readonly wakes: SeaWakeSource[] = [];
  private readonly minimapMarkers: MinimapBoatMarker[] = [];
  private disposed = false;
  private lowMode: boolean;
  private ambientEnabled: boolean;
  private soloBoatId: string | null = null;
  private lastAckSeq = -1;
  private correction = { x: 0, z: 0 };
  private yawCorrection = 0;
  private readonly stroke = { sweep: 0, dip: 0, lean: 0, power: 0 };
  private readonly shoulder = new T.Vector3();
  private readonly gripAt = new T.Vector3();
  private readonly gripAxis = new T.Vector3();
  private readonly tmpV1 = new T.Vector3();
  private readonly wheelFallbackOffset = new T.Vector3(0, 1.19, -0.2);
  readonly readyPromise: Promise<void>;

  constructor(private readonly scene: T.Scene, low: boolean) {
    this.lowMode = low;
    this.ambientEnabled = !low;
    const pendingLoads: Promise<unknown>[] = [];
    this.splashGeo.rotateX(-Math.PI / 2);
    const ringCount = low ? 10 : 20;
    this.splashInst = new T.InstancedMesh(this.splashGeo, this.splashMat, ringCount);
    this.splashInst.name = 'ArenaBoatSplashRings';
    this.splashInst.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.splashInst.frustumCulled = false;
    this.splashInst.renderOrder = 3;
    this.splashDummyMat.makeScale(0, 0, 0);
    this.splashColor.setRGB(0, 0, 0);
    for (let i = 0; i < ringCount; i++) {
      this.splashInst.setMatrixAt(i, this.splashDummyMat);
      this.splashInst.setColorAt(i, this.splashColor);
      this.splashes.push({ x: 0, z: 0, age: 1, life: 1 });
    }
    this.splashInst.count = ringCount;
    this.splashInst.instanceMatrix.needsUpdate = true;
    if (this.splashInst.instanceColor) this.splashInst.instanceColor.needsUpdate = true;
    scene.add(this.splashInst);

    const loader = new GLTFLoader();

    for (const spec of arenaLayout.boats) {
      const kind = resolvePlayableVesselKind((spec as { model?: string }).model);
      const motor = isMotorVessel(kind);
      const footprint = arenaHullForModel((spec as { model?: string }).model);

      const group = new T.Group();
      const hull = new T.Group();
      const oarL = new T.Group();
      const oarR = new T.Group();
      const oarX = kind === 'sampan' ? 0.74 : 0.68;
      const oarY = kind === 'sampan' ? 0.56 : 0.53;
      const oarZ = kind === 'sampan' ? 0.22 : 0.24;
      oarL.position.set(oarX, oarY, oarZ);
      oarR.position.set(-oarX, oarY, oarZ);
      hull.add(oarL, oarR);

      if (!motor) {
        const mask = new T.Mesh(kind === 'sampan' ? this.sampanMaskGeo : this.skiffMaskGeo, this.maskMat);
        mask.name = 'Rowboat_DryMask';
        mask.renderOrder = 1;
        mask.frustumCulled = false;
        hull.add(mask);
      }

      group.add(hull);
      group.position.set(spec.x, ARENA_WATER_Y, spec.z);
      group.name = spec.id;
      group.rotation.y = spec.yaw;
      scene.add(group);

      const contact = (side: 1 | -1, oar: T.Object3D): HandContact => {
        const o = side > 0 ? OAR_L : OAR_R;
        return {
          wrist: new T.Vector3(),
          fingers: new T.Vector3(),
          palm: new T.Vector3(),
          grip: 'handle',
          wrap: true,
          shape: handleShape(oar, o.centre, o.inboard, GRIP_RADIUS, GRIP_HALF),
        };
      };

      const seatSpec = VESSEL_SEAT_SPECS[kind as keyof typeof VESSEL_SEAT_SPECS] ?? VESSEL_SEAT_SPECS.skiff;
      const wheelWorld = new T.Vector3();
      const oarsWorld = { left: new T.Vector3(), right: new T.Vector3() };

      const runtime: BoatRuntime = {
        id: spec.id,
        dock: spec.dock,
        kind,
        motor,
        footprint,
        engine: false,
        throttle: 0,
        steering: 0,
        surge: 0,
        homeX: spec.x,
        homeZ: spec.z,
        homeYaw: spec.yaw,
        x: spec.x,
        z: spec.z,
        yaw: spec.yaw,
        prevX: spec.x,
        prevZ: spec.z,
        prevYaw: spec.yaw,
        vx: 0,
        vz: 0,
        yawVel: 0,
        speed: 0,
        rowPhase: 0,
        prevRowPhase: 0,
        effort: 0,
        turn: 0,
        bump: 0,
        stuckFor: 0,
        seenSeq: 0,
        rower: null,
        passenger: null,
        bladeSubmerged: false,
        hullPitch: 0,
        hullRoll: 0,
        matrixSynced: false,
        shadowSleeping: false,
        wheelWorld,
        oarsWorld,
        rowPose: {
          role: motor ? 'HELM' : 'ROWER',
          left: contact(1, oarL),
          right: contact(-1, oarR),
          torsoLean: 0,
          steering: 0,
          seatHeightAboveDeck: motor ? undefined : seatSpec.rowerSeatH,
          hullPitch: 0,
          hullRoll: 0,
          wheelWorld: motor ? wheelWorld : undefined,
          oarsWorld: motor ? undefined : oarsWorld,
        },
        paxPose: {
          role: 'PASSENGER',
          seatHeightAboveDeck: seatSpec.paxSeatH,
          hullPitch: 0,
          hullRoll: 0,
        },
        group,
        hull,
        oarL,
        oarR,
      };

      this.boats.set(spec.id, runtime);
      this.minimapMarkers.push({
        id: spec.id,
        kind,
        x: spec.x,
        z: spec.z,
        yaw: spec.yaw,
        occupied: false,
        usable: true,
      });
    }

    // Preload unique high-detail v7 motor launches (`pelagic`, `tern`, `cruiser`) once per class so 360° camera warmup compiles all boat shaders upfront
    for (const motorKind of ['pelagic', 'tern', 'cruiser'] as const) {
      const targets = [...this.boats.values()].filter(b => b.motor && b.kind === motorKind);
      if (!targets.length) continue;
      const v7Url =
        motorKind === 'cruiser'
          ? arenaV7Assets.vessels.cruiser.lod0
          : motorKind === 'tern'
            ? arenaV7Assets.vessels.tern.lod0
            : arenaV7Assets.vessels.pelagic.lod0;
      const fallbackUrl =
        motorKind === 'tern'
          ? arenaArchipelagoAssets.MOTORBOATS.tern
          : arenaArchipelagoAssets.MOTORBOATS.pelagic;

      pendingLoads.push(
        loader
          .loadAsync(v7Url)
          .catch(() => loader.loadAsync(fallbackUrl))
          .then(({ scene: template }) => {
            if (this.disposed) {
              this.disposeHierarchyOnly(template);
              return;
            }
            template.traverse(o => {
              if (o instanceof T.Mesh) {
                o.castShadow = !this.lowMode;
                o.receiveShadow = true;
              }
            });
            for (const b of targets) {
              const asset = template.clone(true);
              b.hull.add(asset);
              b.wheel = asset.getObjectByName('SteeringWheel');
              b.engineNode = asset.getObjectByName('Outboard');
              b.propeller = asset.getObjectByName('Propeller');
              b.matrixSynced = false;
            }
          })
          .catch(() => {
            for (const b of targets) b.group.visible = false;
          }),
      );
    }

    // Load v7 wooden skiffs & bamboo-canopy sampans (preserving `Rowboat_Hull`, `Oar_L`, `Oar_R`)
    const mountRowVesselGroup = (targetKind: 'skiff' | 'sampan', primaryUrl: string, fallbackUrl: string) => {
      pendingLoads.push(
        loader
          .loadAsync(primaryUrl)
          .catch(() => loader.loadAsync(fallbackUrl))
          .then(gltf => {
            if (this.disposed) {
              this.disposeHierarchyOnly(gltf.scene);
              return;
            }
            const srcHull = gltf.scene.getObjectByName('Rowboat_Hull') ?? gltf.scene;
            const srcOarL = gltf.scene.getObjectByName('Oar_L');
            const srcOarR = gltf.scene.getObjectByName('Oar_R');
            srcHull.traverse(o => {
              if ((o as T.Mesh).isMesh) {
                o.castShadow = !this.lowMode;
                o.receiveShadow = true;
              }
            });
            for (const oar of [srcOarL, srcOarR]) {
              oar?.traverse(o => {
                if ((o as T.Mesh).isMesh) o.castShadow = !this.lowMode;
              });
            }
            for (const b of this.boats.values()) {
              if (b.kind !== targetKind) continue;
              const hullClone = srcHull.clone(true);
              hullClone.position.set(0, 0, 0);
              b.hull.add(hullClone);
              if (srcOarL) {
                const lClone = srcOarL.clone(true);
                lClone.position.set(0, 0, 0);
                b.oarL.add(lClone);
              }
              if (srcOarR) {
                const rClone = srcOarR.clone(true);
                rClone.position.set(0, 0, 0);
                b.oarR.add(rClone);
              }
              b.matrixSynced = false;
            }
          })
          .catch(() => {}),
      );
    };

    mountRowVesselGroup('skiff', arenaV7Assets.vessels.skiff.lod0, arenaArchipelagoAssets.ROWBOAT);
    mountRowVesselGroup('sampan', arenaV7Assets.vessels.sampan.lod0, arenaArchipelagoAssets.ROWBOAT);

    // 5 outer-channel ambient maritime vessels (`trawler` + `sailboat`) outside pier corridors
    const ambientLoops: Omit<AmbientCruiser, 'group' | 'x' | 'z' | 'yaw' | 'speed'>[] = [
      { kind: 'trawler', centerX: -295, centerZ: 125, radiusX: 34, radiusZ: 22, angularSpeed: 0.085, phase0: 0.4, direction: 1 },
      { kind: 'trawler', centerX: 335, centerZ: -145, radiusX: 38, radiusZ: 24, angularSpeed: 0.078, phase0: 3.1, direction: -1 },
      { kind: 'sailboat', centerX: 118, centerZ: 332, radiusX: 42, radiusZ: 26, angularSpeed: 0.095, phase0: 1.5, direction: 1 },
      { kind: 'sailboat', centerX: -120, centerZ: -298, radiusX: 36, radiusZ: 22, angularSpeed: 0.092, phase0: 4.4, direction: -1 },
      { kind: 'sailboat', centerX: 338, centerZ: 165, radiusX: 34, radiusZ: 24, angularSpeed: 0.088, phase0: 2.3, direction: 1 },
    ];
    for (const cfg of ambientLoops) {
      const group = new T.Group();
      group.visible = this.ambientEnabled;
      scene.add(group);
      this.ambient.push({ ...cfg, group, x: cfg.centerX + cfg.radiusX, z: cfg.centerZ, yaw: 0, speed: 2.8 });
    }

    for (const ambKind of ['trawler', 'sailboat'] as const) {
      const url =
        ambKind === 'trawler' ? arenaV7Assets.vessels.trawler.lod1 : arenaV7Assets.vessels.sailboat.lod1;
      pendingLoads.push(
        loader
          .loadAsync(url)
          .then(gltf => {
            if (this.disposed) {
              this.disposeHierarchyOnly(gltf.scene);
              return;
            }
            gltf.scene.traverse(o => {
              if ((o as T.Mesh).isMesh) {
                o.castShadow = false;
                o.receiveShadow = true;
              }
            });
            for (const amb of this.ambient) {
              if (amb.kind !== ambKind) continue;
              const clone = gltf.scene.clone(true);
              clone.position.set(0, 0, 0);
              amb.group.add(clone);
            }
          })
          .catch(() => {}),
      );
    }

    this.readyPromise = Promise.all(pendingLoads).then(() => {});
  }

  private disposeHierarchyOnly(root: T.Object3D): void {
    root.traverse(o => {
      const m = o as T.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        mat.dispose();
      }
    });
  }

  /** Live in-place quality tier switch (zero WebGL context churn). */
  setQuality(tier: ArenaQualityTier): void {
    this.lowMode = tier === 'low';
    this.ambientEnabled = tier !== 'low';
    for (const b of this.boats.values()) {
      b.shadowSleeping = false;
      b.hull.traverse(o => {
        const m = o as T.Mesh;
        if (m.isMesh && m.name !== 'Rowboat_DryMask') {
          m.castShadow = !this.lowMode;
        }
      });
    }
    for (const amb of this.ambient) {
      if (!this.ambientEnabled) amb.group.visible = false;
    }
  }

  /** Zero-allocation snapshot of all 14 playable archipelago boats for `ArenaMinimap`. */
  getMinimapMarkers(): readonly MinimapBoatMarker[] {
    let idx = 0;
    for (const b of this.boats.values()) {
      const slot = this.minimapMarkers[idx++];
      if (!slot) break;
      slot.id = b.id;
      slot.kind = b.kind;
      slot.x = b.x;
      slot.z = b.z;
      slot.yaw = b.yaw;
      slot.occupied = Boolean(b.rower || b.passenger);
      slot.usable = !b.rower || !b.passenger;
    }
    return this.minimapMarkers;
  }

  get soloActiveBoatId(): string | null {
    return this.soloBoatId;
  }

  boardSolo(boatId: string, selfId: string): boolean {
    const b = this.boats.get(boatId);
    if (!b) return false;
    this.soloBoatId = boatId;
    b.rower = selfId;
    b.passenger = null;
    b.vx = 0;
    b.vz = 0;
    b.yawVel = 0;
    b.stuckFor = 0;
    return true;
  }

  disembarkSolo(): { x: number; z: number; y: number } | null {
    if (!this.soloBoatId) return null;
    const b = this.boats.get(this.soloBoatId);
    if (!b) {
      this.soloBoatId = null;
      return null;
    }
    if (b.motor && b.speed >= 1.1) return null;
    const land = arenaDisembarkPoint(b.x, b.z, b.yaw, b.footprint);
    if (!land) return null;
    b.rower = null;
    b.engine = false;
    b.surge = b.speed = 0;
    b.vx = 0;
    b.vz = 0;
    b.yawVel = 0;
    b.matrixSynced = false;
    this.soloBoatId = null;
    return land;
  }

  /**
   * Compute ballistic overboard launch target and exit velocity (`~0.55 * boatVel + 2.1 m/s * outboard`, clamped `<= 2.55 m/s`)
   * for either multiplayer or solo boats (`B01`).
   */
  computeOverboardLaunch(
    boatId: string,
    role: ArenaBoatRole | string | null = 'ROWER',
    preferSide = 0,
  ): ArenaOverboardLaunch | null {
    const b = this.boats.get(boatId);
    if (!b) return null;
    const land = arenaOverboardPoint(b.x, b.z, b.yaw, b.footprint, role, preferSide);
    if (!land) return null;
    const boatVx = b.motor ? Math.sin(b.yaw) * b.surge : b.vx;
    const boatVz = b.motor ? Math.cos(b.yaw) * b.surge : b.vz;
    let exitVx = boatVx * 0.55 + land.outboardX * 2.1;
    let exitVz = boatVz * 0.55 + land.outboardZ * 2.1;
    const mag = Math.hypot(exitVx, exitVz);
    if (mag > 2.55) {
      exitVx = (exitVx / mag) * 2.55;
      exitVz = (exitVz / mag) * 2.55;
    }
    return {
      ...land,
      gunwaleY: b.group.position.y + (b.motor ? 0.88 : 0.48),
      exitVx,
      exitVz,
    };
  }

  /** Jump into swimmable/coastal water anywhere from the active solo boat (`B01`). */
  jumpOverboardSolo(preferSide = 0): ArenaOverboardLaunch | null {
    if (!this.soloBoatId) return null;
    const b = this.boats.get(this.soloBoatId);
    if (!b) {
      this.soloBoatId = null;
      return null;
    }
    const launch = this.computeOverboardLaunch(b.id, 'ROWER', preferSide);
    if (!launch) return null;
    this.spawnWaterSplash(launch.x, launch.z);
    b.rower = null;
    b.engine = false;
    b.throttle = 0;
    b.steering = 0;
    b.surge = b.speed = 0;
    b.vx = 0;
    b.vz = 0;
    b.yawVel = 0;
    b.matrixSynced = false;
    this.soloBoatId = null;
    return launch;
  }

  rescueSolo(): boolean {
    const b = this.soloBoatId ? this.boats.get(this.soloBoatId) : undefined;
    if (!b) return false;
    const free = arenaBoatRescue(
      b.x,
      b.z,
      b.yaw,
      (x, z, yaw) => arenaBoatClear(x, z, yaw, b.footprint) && this.clearOfBoats(b, x, z, yaw),
    );
    if (!free) return false;
    b.x = b.prevX = free.x;
    b.z = b.prevZ = free.z;
    b.yaw = b.prevYaw = free.yaw;
    b.vx = b.vz = b.yawVel = 0;
    b.stuckFor = 0;
    b.matrixSynced = false;
    return true;
  }

  clearSolo() {
    this.soloBoatId = null;
    for (const b of this.boats.values()) {
      b.rower = b.passenger = null;
      b.engine = false;
      b.surge = b.throttle = b.steering = 0;
      b.prevX = b.x = b.homeX;
      b.prevZ = b.z = b.homeZ;
      b.prevYaw = b.yaw = b.homeYaw;
      b.speed = b.vx = b.vz = b.yawVel = b.rowPhase = b.prevRowPhase = b.effort = b.turn = b.bump = b.stuckFor = 0;
      b.matrixSynced = false;
    }
  }

  resetReconciliation() {
    this.lastAckSeq = -1;
    this.yawCorrection = 0;
    this.correction = { x: 0, z: 0 };
  }

  spawnWaterSplash(x: number, z: number): void {
    this.spawnSplash(x, z);
  }

  private spawnSplash(x: number, z: number) {
    const idx = this.splashCursor;
    const ring = this.splashes[idx];
    this.splashCursor = (idx + 1) % this.splashes.length;
    ring.x = x;
    ring.z = z;
    ring.age = 0;
    ring.life = 0.85;
    this.splashDummyPos.set(x, ARENA_WATER_Y + 0.04, z);
    this.splashDummyScale.setScalar(0.55);
    this.splashDummyMat.compose(this.splashDummyPos, this.splashDummyQuat, this.splashDummyScale);
    this.splashInst.setMatrixAt(idx, this.splashDummyMat);
    this.splashColor.setHex(0xe8f7f5);
    this.splashInst.setColorAt(idx, this.splashColor);
    this.splashInst.instanceMatrix.needsUpdate = true;
    if (this.splashInst.instanceColor) this.splashInst.instanceColor.needsUpdate = true;
  }

  clearOfBoats(self: BoatRuntime, x: number, z: number, yaw: number) {
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    for (const b of this.boats.values()) {
      if (b === self || Math.abs(x - b.x) > 9.4 || Math.abs(z - b.z) > 9.4) continue;
      const t = Math.sin(b.yaw);
      const u = Math.cos(b.yaw);
      for (const [pa, ra] of self.footprint) {
        for (const [pb, rb] of b.footprint) {
          const dx = x + s * pa - b.x - t * pb;
          const dz = z + c * pa - b.z - u * pb;
          const reach = ra + rb;
          if (dx * dx + dz * dz < reach * reach) return false;
        }
      }
    }
    return true;
  }

  stepDriverBoat(boat: BoatRuntime, forwardInput: number, turnInput: number) {
    boat.prevX = boat.x;
    boat.prevZ = boat.z;
    boat.prevYaw = boat.yaw;
    boat.prevRowPhase = boat.rowPhase;

    const fwd = T.MathUtils.clamp(forwardInput, -1, 1);
    const turn = T.MathUtils.clamp(turnInput, -1, 1);
    const clear = (x: number, z: number, yaw: number) =>
      arenaBoatClear(x, z, yaw, boat.footprint) && this.clearOfBoats(boat, x, z, yaw);

    if (boat.motor) {
      boat.throttle = boat.engine ? fwd : 0;
      boat.steering = turn;
      const maxAccel = boat.kind === 'cruiser' ? 9.8 : 11.3;
      const revAccel = boat.kind === 'cruiser' ? 4.9 : 5.6;
      const dragLin = boat.kind === 'cruiser' ? 0.31 : 0.28;
      boat.surge +=
        ((boat.throttle < 0 ? revAccel : maxAccel) * boat.throttle -
          (dragLin + 0.012 * Math.abs(boat.surge)) * boat.surge) *
        STEP;
      const authority = Math.tanh(boat.surge / 3) / (1 + 0.018 * Math.abs(boat.surge));
      const yawScale = boat.kind === 'cruiser' ? 0.84 : 1.0;
      boat.yawVel += (-turn * authority * yawScale - boat.yawVel) * (1 - Math.exp(-3.5 * STEP));
      const deltaYaw = this.yawCorrection * 0.12;
      this.yawCorrection -= deltaYaw;
      const angle = normAngle(boat.yaw + boat.yawVel * STEP + deltaYaw);
      if (clear(boat.x, boat.z, angle)) boat.yaw = angle;
      const sx = Math.sin(boat.yaw);
      const sz = Math.cos(boat.yaw);
      const cx = this.correction.x * 0.12;
      const cz = this.correction.z * 0.12;
      this.correction.x -= cx;
      this.correction.z -= cz;
      const next = arenaBoatStep(
        boat.x,
        boat.z,
        boat.yaw,
        boat.x + sx * boat.surge * STEP + cx,
        boat.z + sz * boat.surge * STEP + cz,
        clear,
      );
      if (next.blocked) {
        boat.surge = ((next.x - boat.x - cx) * sx + (next.z - boat.z - cz) * sz) / STEP;
      }
      boat.x = next.x;
      boat.z = next.z;
      boat.speed = Math.abs(boat.surge);
      boat.turn = turn;
      boat.stuckFor = boat.speed < 0.06 && Math.abs(boat.throttle) > 0.3 ? boat.stuckFor + STEP : 0;
      return;
    }

    const activeStroke = Math.abs(fwd) > 0.05 || Math.abs(turn) > 0.05;
    const want = activeStroke ? Math.max(Math.abs(fwd), Math.abs(turn) * 0.75) : 0;
    boat.effort += (want - boat.effort) * (1 - Math.exp(-(activeStroke ? 3.2 : 2.2) * STEP));
    if (activeStroke) {
      const dir = fwd < -0.05 ? -1 : 1;
      const cadence = 3.9 * (0.6 + 0.4 * want);
      boat.rowPhase += dir * cadence * STEP;
    } else {
      const rem = normAngle(boat.rowPhase);
      boat.rowPhase -= rem * (1 - Math.exp(-4.5 * STEP));
    }
    arenaStroke(boat.rowPhase, this.stroke);

    const speedMag = Math.hypot(boat.vx, boat.vz);
    const turnAuthority = (boat.kind === 'sampan' ? 1.26 : 1.38) * (0.72 + 0.28 * Math.min(1, speedMag / 2.2));
    boat.yawVel += (-turn * turnAuthority - boat.yawVel) * (1 - Math.exp(-5.2 * STEP));
    const yaw = normAngle(boat.yaw + boat.yawVel * STEP);
    if (clear(boat.x, boat.z, yaw)) boat.yaw = yaw;
    else {
      boat.bump = Math.max(boat.bump, Math.min(1, Math.abs(boat.yawVel) * 0.6));
      boat.yawVel = 0;
    }
    boat.turn += (T.MathUtils.clamp(-boat.yawVel / 1.38, -1, 1) - boat.turn) * (1 - Math.exp(-6 * STEP));

    const sinY = Math.sin(boat.yaw);
    const cosY = Math.cos(boat.yaw);
    const thrustScale = boat.kind === 'sampan' ? 5.65 : 5.35;
    const thrust = fwd >= 0 ? fwd * thrustScale * (0.55 + 0.9 * this.stroke.power) : fwd * 2.65;

    boat.vx += sinY * thrust * STEP;
    boat.vz += cosY * thrust * STEP;

    const along = boat.vx * sinY + boat.vz * cosY;
    const lateral = boat.vx * cosY - boat.vz * sinY;
    const dampedAlong = along * Math.exp(-(Math.abs(fwd) > 0.05 ? 1.12 : 1.35) * STEP);
    const dampedLateral = lateral * Math.exp(-6.5 * STEP);
    const clampedAlong = T.MathUtils.clamp(dampedAlong, -2.2, boat.kind === 'sampan' ? 5.15 : 4.85);

    boat.vx = sinY * clampedAlong + cosY * dampedLateral;
    boat.vz = cosY * clampedAlong - sinY * dampedLateral;

    const cx = this.correction.x * 0.16;
    const cz = this.correction.z * 0.16;
    this.correction.x -= cx;
    this.correction.z -= cz;

    const targetX = boat.x + boat.vx * STEP + cx;
    const targetZ = boat.z + boat.vz * STEP + cz;
    const stepped = arenaBoatStep(boat.x, boat.z, boat.yaw, targetX, targetZ, clear);

    if (stepped.blocked) {
      const mvx = (stepped.x - boat.x) / STEP;
      const mvz = (stepped.z - boat.z) / STEP;
      const lost = Math.hypot(boat.vx - mvx, boat.vz - mvz);
      boat.bump = Math.max(boat.bump, Math.min(1, lost * 0.35));
      boat.vx = mvx * 0.9;
      boat.vz = mvz * 0.9;
    }
    boat.x = stepped.x;
    boat.z = stepped.z;
    boat.speed = Math.hypot(boat.vx, boat.vz);
    boat.stuckFor = activeStroke && Math.abs(fwd) > 0.3 && boat.speed < 0.06 ? boat.stuckFor + STEP : 0;
  }

  syncOwnership(serverBoats: readonly ArenaBoatState[] | undefined, selfId: string, motion: ArenaMotion) {
    if (serverBoats) {
      this.soloBoatId = null;
      for (const sb of serverBoats) {
        const b = this.boats.get(sb.id);
        if (!b) continue;
        const wasDriver = b.rower === selfId;
        const placed = (sb.sequence ?? 0) < 0 && b.seenSeq >= 0;
        b.seenSeq = sb.sequence ?? 0;
        b.rower = sb.rower ?? null;
        b.passenger = sb.passenger ?? null;
        if (b.motor) {
          b.engine = !!sb.engine;
          if (!b.engine && !b.rower) b.surge = 0;
        }
        const ack = motion.boatHistory.get(sb.id)?.at(-1);
        if (b.rower === selfId) {
          if (!wasDriver || placed) {
            b.x = b.prevX = sb.x;
            b.z = b.prevZ = sb.z;
            b.yaw = b.prevYaw = sb.yaw;
            b.prevRowPhase = b.rowPhase = sb.rowPhase;
            b.vx = b.vz = b.yawVel = b.speed = 0;
            b.stuckFor = 0;
            this.resetReconciliation();
          } else if (ack?.rower === selfId && ack.sequence != null && ack.sequence !== this.lastAckSeq) {
            this.lastAckSeq = ack.sequence;
            const predicted = motion.boatSent.get(ack.sequence);
            if (predicted) {
              const ex = ack.x - predicted.x;
              const ez = ack.z - predicted.z;
              if (b.motor) this.yawCorrection = normAngle(ack.yaw - predicted.yaw);
              this.correction = Math.hypot(ex, ez) > 0.08 ? { x: ex, z: ez } : { x: 0, z: 0 };
              for (const k of motion.boatSent.keys()) {
                if (k <= ack.sequence) motion.boatSent.delete(k);
              }
            }
          }
        }
      }
    }
  }

  private poseOars(oarL: T.Object3D, oarR: T.Object3D, phase: number, effort: number, turn: number) {
    const s = arenaStroke(phase, this.stroke);
    const reach = 0.4 * effort;
    const lift = (1 - effort) * 0.1;
    const left = reach * (1 + 0.45 * turn);
    const right = reach * (1 - 0.45 * turn);
    const dip = (s.dip >= 0 ? 0.2 * s.dip : 0.16 * s.dip) * effort - lift;
    oarL.rotation.set(0, left * s.sweep, -dip);
    oarR.rotation.set(0, -right * s.sweep, dip);
    return s;
  }

  update(
    dt: number,
    time: number,
    nowMs: number,
    alpha: number,
    selfId: string,
    serverBoats: readonly ArenaBoatState[] | undefined,
    motion: ArenaMotion,
    focus: T.Vector3,
    listenerYaw: number,
    ambience: ArenaAmbience,
    envVolume: number,
    reduced: boolean,
  ): readonly SeaWakeSource[] {
    this.wakes.length = 0;

    for (const b of this.boats.values()) {
      if (b.loadModel && (b.rower || Math.hypot(b.x - focus.x, b.z - focus.z) < 220)) {
        const start = b.loadModel;
        b.loadModel = undefined;
        start();
      }
      let renderX = b.x;
      let renderZ = b.z;
      let renderYaw = b.yaw;
      let renderPhase = b.rowPhase;
      const isLocalDriver = b.rower === selfId;

      if (isLocalDriver) {
        renderX = T.MathUtils.lerp(b.prevX, b.x, alpha);
        renderZ = T.MathUtils.lerp(b.prevZ, b.z, alpha);
        renderYaw = b.prevYaw + normAngle(b.yaw - b.prevYaw) * alpha;
        renderPhase = T.MathUtils.lerp(b.prevRowPhase, b.rowPhase, alpha);
      } else if (serverBoats) {
        const sb = serverBoats.find(s => s.id === b.id);
        const sampled = motion.sampleBoat(b.id, nowMs);
        if (b.motor) {
          const latest = motion.boatHistory.get(b.id)?.at(-1);
          b.steering = latest?.steering ?? sb?.steering ?? 0;
          b.throttle = latest?.throttle ?? sb?.throttle ?? 0;
        }
        const tx = sampled?.x ?? sb?.x ?? b.homeX;
        const tz = sampled?.z ?? sb?.z ?? b.homeZ;
        const tyaw = sampled?.yaw ?? sb?.yaw ?? b.homeYaw;
        const tphase = sampled?.rowPhase ?? sb?.rowPhase ?? 0;
        const k = 1 - Math.exp(-14 * dt);
        const prevX = b.x;
        const prevZ = b.z;
        const prevYaw = b.yaw;
        const prevPhase = b.rowPhase;
        b.x += (tx - b.x) * k;
        b.z += (tz - b.z) * k;
        b.yaw = normAngle(b.yaw + normAngle(tyaw - b.yaw) * k);
        b.prevRowPhase = b.rowPhase;
        b.rowPhase += (tphase - b.rowPhase) * k;
        b.speed = Math.hypot(b.x - prevX, b.z - prevZ) / Math.max(dt, 1e-3);
        const rate = Math.abs(b.rowPhase - prevPhase) / Math.max(dt, 1e-3);
        b.effort += (Math.min(1, b.rower ? rate / 3.9 : 0) - b.effort) * (1 - Math.exp(-4 * dt));
        b.yawVel = normAngle(b.yaw - prevYaw) / Math.max(dt, 1e-3);
        b.turn += (T.MathUtils.clamp(-b.yawVel / 1.38, -1, 1) - b.turn) * (1 - Math.exp(-6 * dt));
        renderX = b.x;
        renderZ = b.z;
        renderYaw = b.yaw;
        renderPhase = b.rowPhase;
      } else if (!b.rower) {
        b.speed = 0;
        b.effort += (0 - b.effort) * (1 - Math.exp(-3 * dt));
      }

      const distSqToFocus = (renderX - focus.x) * (renderX - focus.x) + (renderZ - focus.z) * (renderZ - focus.z);
      const isOccupiedOrMoving =
        Boolean(b.rower || b.passenger || b.engine) || b.speed > 0.02 || b.effort > 0.01 || b.bump > 0.01;

      if (!this.lowMode) {
        if (!b.shadowSleeping && !isOccupiedOrMoving && distSqToFocus > 115 * 115) {
          b.shadowSleeping = true;
          b.hull.traverse(o => {
            const m = o as T.Mesh;
            if (m.isMesh && m.name !== 'Rowboat_DryMask') m.castShadow = false;
          });
        } else if (b.shadowSleeping && (isOccupiedOrMoving || distSqToFocus < 105 * 105)) {
          b.shadowSleeping = false;
          b.hull.traverse(o => {
            const m = o as T.Mesh;
            if (m.isMesh && m.name !== 'Rowboat_DryMask') m.castShadow = true;
          });
        }
      }

      if (!isOccupiedOrMoving && b.matrixSynced && distSqToFocus > 110 * 110) {
        b.bladeSubmerged = false;
        continue;
      }

      // 6-point wave hull buoyancy & dynamic speed/turn trim matching GPU Gerstner sea
      const sinY = Math.sin(renderYaw);
      const cosY = Math.cos(renderYaw);
      const halfL = b.kind === 'cruiser' ? 2.6 : b.motor ? 2.1 : b.kind === 'sampan' ? 1.7 : 1.4;
      const halfB = b.kind === 'cruiser' ? 1.05 : b.motor ? 0.9 : 0.65;
      const wBow = reduced ? ARENA_WATER_Y : arenaWaveHeight(renderX + sinY * halfL, renderZ + cosY * halfL, time);
      const wStern = reduced ? ARENA_WATER_Y : arenaWaveHeight(renderX - sinY * halfL, renderZ - cosY * halfL, time);
      const wPortFwd = reduced
        ? ARENA_WATER_Y
        : arenaWaveHeight(renderX + sinY * halfL * 0.45 + cosY * halfB, renderZ + cosY * halfL * 0.45 - sinY * halfB, time);
      const wStarFwd = reduced
        ? ARENA_WATER_Y
        : arenaWaveHeight(renderX + sinY * halfL * 0.45 - cosY * halfB, renderZ + cosY * halfL * 0.45 + sinY * halfB, time);
      const wPortAft = reduced
        ? ARENA_WATER_Y
        : arenaWaveHeight(renderX - sinY * halfL * 0.45 + cosY * halfB, renderZ - cosY * halfL * 0.45 - sinY * halfB, time);
      const wStarAft = reduced
        ? ARENA_WATER_Y
        : arenaWaveHeight(renderX - sinY * halfL * 0.45 - cosY * halfB, renderZ - cosY * halfL * 0.45 + sinY * halfB, time);

      const wavePitch = Math.atan2(wBow - wStern, halfL * 2) * 0.58;
      const waveRoll = Math.atan2((wStarFwd + wStarAft) * 0.5 - (wPortFwd + wPortAft) * 0.5, halfB * 2) * 0.58;
      const speedTrim = Math.min(b.motor ? 0.068 : 0.045, b.speed * 0.0085);
      const turnHeel = T.MathUtils.clamp(-b.yawVel * 0.045, -0.065, 0.065);
      b.bump *= Math.exp(-3.5 * dt);
      const knock = reduced ? 0 : Math.sin(time * 19) * 0.035 * b.bump;
      const pitchNow = -(wavePitch + speedTrim) + knock;
      const rollNow = waveRoll + turnHeel + knock * 0.6;
      b.hullPitch = pitchNow;
      b.hullRoll = rollNow;

      b.group.position.set(
        renderX,
        (wBow + wStern + wPortFwd + wStarFwd + wPortAft + wStarAft) / 6,
        renderZ,
      );
      b.group.rotation.set(0, renderYaw, 0);
      b.hull.rotation.set(pitchNow, 0, rollNow);

      if (b.motor) {
        ambience.engine(
          b.id,
          b.engine && envVolume > 0,
          b.throttle,
          b.speed,
          renderX - focus.x,
          renderZ - focus.z,
          listenerYaw,
        );
        if (b.wheel) b.wheel.rotation.z = -b.steering * 0.9;
        if (b.engineNode) b.engineNode.rotation.y = b.steering * 0.43;
        if (b.propeller && b.engine) b.propeller.rotation.z += dt * (9 + 40 * Math.abs(b.throttle));
        b.rowPose.role = 'HELM';
        b.rowPose.torsoLean = 0;
        b.rowPose.steering = b.steering;
        b.rowPose.hullPitch = pitchNow;
        b.rowPose.hullRoll = rollNow;
      } else {
        const stroke = this.poseOars(b.oarL, b.oarR, renderPhase, b.rower ? b.effort : 0, b.turn);
        b.rowPose.role = 'ROWER';
        b.rowPose.torsoLean = b.rower ? b.effort * (0.04 + 0.14 * stroke.lean) : 0;
        b.rowPose.steering = 0;
        b.rowPose.hullPitch = pitchNow;
        b.rowPose.hullRoll = rollNow;
      }
      b.paxPose.hullPitch = pitchNow;
      b.paxPose.hullRoll = rollNow;
      b.group.updateMatrixWorld(true);
      b.matrixSynced = true;

      if (!b.motor && b.rower && b.effort > 0.08) {
        const tip = this.tmpV1.set(1.43, -0.383, 0).applyMatrix4(b.oarL.matrixWorld);
        const under = tip.y < arenaWaveHeight(tip.x, tip.z, reduced ? 0 : time);
        if (under && !b.bladeSubmerged && Math.abs(b.rowPhase - b.prevRowPhase) > 0.001) {
          this.spawnSplash(tip.x, tip.z);
          tip.set(-1.43, -0.383, 0).applyMatrix4(b.oarR.matrixWorld);
          this.spawnSplash(tip.x, tip.z);
          if (envVolume > 0) {
            ambience.oarSplash(
              renderX,
              renderZ,
              focus.x,
              focus.z,
              listenerYaw,
              Math.min(1, 0.45 + b.speed * 0.14),
            );
          }
        }
        b.bladeSubmerged = under;
      } else {
        b.bladeSubmerged = false;
      }
      this.wakes.push({ id: b.id, motor: b.motor, x: renderX, z: renderZ, speed: b.speed, yaw: renderYaw });
    }

    // Update ambient sea-lane trawlers & sailboats
    if (this.ambientEnabled) {
      for (const amb of this.ambient) {
        const a = amb.phase0 + motion.worldSeconds(nowMs) * amb.angularSpeed * amb.direction;
        const x = amb.centerX + Math.cos(a) * amb.radiusX;
        const z = amb.centerZ + Math.sin(a) * amb.radiusZ;
        const distSq = (x - focus.x) ** 2 + (z - focus.z) ** 2;
        amb.group.visible = distSq < 340 * 340;
        if (!amb.group.visible) continue;
        const dx = -Math.sin(a) * amb.radiusX * amb.direction;
        const dz = Math.cos(a) * amb.radiusZ * amb.direction;
        const yaw = Math.atan2(dx, dz);
        const wy = reduced || distSq > 190 * 190 ? ARENA_WATER_Y : arenaWaveHeight(x, z, time);
        amb.group.position.set(x, wy, z);
        const heel = amb.kind === 'sailboat' ? 0.075 * amb.direction : 0;
        amb.group.rotation.set(0, yaw, heel + Math.sin(time * 0.95 + amb.phase0) * 0.03);
        amb.x = x;
        amb.z = z;
        amb.yaw = yaw;
        if (distSq < 195 * 195) {
          this.wakes.push({
            id: `amb-${amb.phase0}`,
            motor: amb.kind === 'trawler',
            x,
            z,
            speed: amb.angularSpeed * Math.hypot(dx, dz),
            yaw,
          });
        }
      }
    }

    let splashDirty = false;
    for (let i = 0; i < this.splashes.length; i++) {
      const s = this.splashes[i];
      if (s.age >= s.life) continue;
      s.age += dt;
      splashDirty = true;
      if (s.age >= s.life) {
        this.splashDummyMat.makeScale(0, 0, 0);
        this.splashInst.setMatrixAt(i, this.splashDummyMat);
        this.splashColor.setRGB(0, 0, 0);
        this.splashInst.setColorAt(i, this.splashColor);
        continue;
      }
      const u = s.age / s.life;
      const fade = (1 - u) * (1 - u);
      this.splashDummyPos.set(s.x, ARENA_WATER_Y + 0.04, s.z);
      this.splashDummyScale.setScalar(0.55 + u * 2.45);
      this.splashDummyMat.compose(this.splashDummyPos, this.splashDummyQuat, this.splashDummyScale);
      this.splashInst.setMatrixAt(i, this.splashDummyMat);
      this.splashColor.setRGB(0.91 * fade, 0.969 * fade, 0.961 * fade);
      this.splashInst.setColorAt(i, this.splashColor);
    }
    if (splashDirty) {
      this.splashInst.instanceMatrix.needsUpdate = true;
      if (this.splashInst.instanceColor) this.splashInst.instanceColor.needsUpdate = true;
    }

    return this.wakes;
  }

  attachAvatar(
    boatId: string,
    role: ArenaBoatRole,
    character: { root: T.Group; rig: HumanRig },
  ): ArenaBoatAttachmentPose | undefined {
    const b = this.boats.get(boatId);
    if (!b) return undefined;
    const root = character.root;
    const seatSpec = VESSEL_SEAT_SPECS[b.kind as keyof typeof VESSEL_SEAT_SPECS] ?? VESSEL_SEAT_SPECS.skiff;
    const localZ = role === 'ROWER' ? seatSpec.rowerZ : seatSpec.paxZ;
    const faceAft = role === 'PASSENGER' && seatSpec.paxFacesAft;

    this.tmpV1.set(0, seatSpec.floorY, localZ).applyMatrix4(b.hull.matrixWorld);
    root.position.copy(this.tmpV1);
    root.rotation.set(0, faceAft ? normAngle(b.group.rotation.y + Math.PI) : b.group.rotation.y, 0);
    root.updateMatrixWorld(true);

    if (role === 'PASSENGER') {
      b.paxPose.seatHeightAboveDeck = seatSpec.paxSeatH;
      b.paxPose.hullPitch = faceAft ? -b.hullPitch : b.hullPitch;
      b.paxPose.hullRoll = faceAft ? -b.hullRoll : b.hullRoll;
      return b.paxPose;
    }

    const pose = b.rowPose;
    pose.seatHeightAboveDeck = b.motor ? undefined : seatSpec.rowerSeatH;
    pose.hullPitch = b.hullPitch;
    pose.hullRoll = b.hullRoll;

    if (b.motor) {
      if (b.wheel) {
        b.wheelWorld.setFromMatrixPosition(b.wheel.matrixWorld);
      } else {
        b.wheelWorld.copy(this.wheelFallbackOffset).applyMatrix4(b.hull.matrixWorld);
      }
      pose.wheelWorld = b.wheelWorld;
      pose.oarsWorld = undefined;
    } else {
      b.oarsWorld.left.copy(OAR_L.centre).applyMatrix4(b.oarL.matrixWorld);
      b.oarsWorld.right.copy(OAR_R.centre).applyMatrix4(b.oarR.matrixWorld);
      pose.oarsWorld = b.oarsWorld;
      pose.wheelWorld = undefined;
    }

    for (const side of [-1, 1] as const) {
      const oar = side < 0 ? b.oarL : b.oarR;
      const spec = side < 0 ? OAR_L : OAR_R;
      const contact = side < 0 ? pose.left! : pose.right!;
      this.gripAt.copy(spec.centre).applyMatrix4(oar.matrixWorld);
      this.gripAxis.copy(spec.inboard).transformDirection(oar.matrixWorld).normalize();
      if (b.motor) {
        this.gripAt.set(-side * 0.185, 0.075, 0);
        if (b.wheel) {
          this.gripAt.applyMatrix4(b.wheel.matrixWorld);
        } else {
          this.gripAt.add(this.wheelFallbackOffset).applyMatrix4(b.hull.matrixWorld);
        }
        this.gripAxis.set(0, 1, 0).transformDirection(b.hull.matrixWorld);
        contact.shape = undefined;
      }
      const shoulder =
        character.rig.armReach(side, this.shoulder)?.shoulder ??
        this.shoulder.copy(root.position).setY(root.position.y + (b.motor ? 1.38 : 0.88));
      handleGrip(character.rig, side, this.gripAt, this.gripAxis, shoulder, GRIP_RADIUS, contact);
    }
    return pose;
  }

  dispose() {
    this.disposed = true;
    this.scene.remove(this.splashInst);
    this.splashInst.dispose();
    this.splashMat.dispose();
    this.splashGeo.dispose();
    this.skiffMaskGeo.dispose();
    this.sampanMaskGeo.dispose();
    this.maskMat.dispose();
    const cleanGroup = (g: T.Object3D) => {
      this.scene.remove(g);
      g.traverse(o => {
        const m = o as T.Mesh;
        if (!m.isMesh || m.geometry === this.skiffMaskGeo || m.geometry === this.sampanMaskGeo) return;
        m.geometry.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
      });
    };
    for (const b of this.boats.values()) cleanGroup(b.group);
    for (const a of this.ambient) cleanGroup(a.group);
    this.boats.clear();
  }
}
