import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mat } from '../materials';
import { GROUND_Y, TV_CONSOLE_TOP_Y } from '@/lib/echo-life/plan';
import type { EnterableBuilding } from '@/lib/echo-life/buildings';
import { acquireLifeAsset, placeOn, releaseLifeAsset, type LifeAsset, type Prepared } from './assets';
import { patchHeightFog } from './atmosphere';
import { getInFlightCompileCount, patchMaterialWithEchoCsm } from './echoCsm';
import {
  Batch,
  batchStaticFurnishings,
  createLifeDoor,
  stepDoorParts,
  subtractAxisBox3D,
  type AxisBoxBounds,
  type DoorPart,
  type LifeDoor,
  type SolidBox,
} from './house';
import { EchoLifeTimeSlicer, getEchoLifeTextureUploadQueue, LoadPriority } from './loadScheduler';
import type { QualityTier } from './renderConfig';
import { estimateObjectGpuBytes, getEchoLifeResidencyManager } from './residencyManager';
import {
  acquireStreetProp,
  instanceStreetProp,
  placeStreetPropOn,
  releaseStreetProp,
  type StreetPropKey,
} from './streetPropsManifest';
import { freezeStaticHierarchy } from './scratch';
import { createSharedWeatherUniforms, type SharedWeatherUniforms } from './weatherSystem';
import { WorldSurfaceLibrary, type ArchitecturalGlassHandle } from './worldSurfaces';

export type InteriorResidencyState = 'UNLOADED' | 'PREFETCHING' | 'RESIDENT_ACTIVE' | 'CACHED_VISITED';

/**
 * Vertex-colored static geometry batcher collapsing multi-color trims or tabletop props
 * into ONE single merged `Mesh` (eliminates per-color draw calls!).
 */
class VertexColorBatch {
  private readonly geos: T.BufferGeometry[] = [];
  private readonly occupied: AxisBoxBounds[] = [];
  private readonly tmpColor = new T.Color();

  private pushGeo(colorHex: string | number, raw: T.BufferGeometry): void {
    const g = raw.index ? raw.toNonIndexed() : raw;
    if (g !== raw) raw.dispose();
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      g.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    this.tmpColor.set(colorHex);
    const count = g.attributes.position.count;
    const cols = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      cols[i * 3] = this.tmpColor.r;
      cols[i * 3 + 1] = this.tmpColor.g;
      cols[i * 3 + 2] = this.tmpColor.b;
    }
    g.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
    this.geos.push(g);
  }

  addBox(
    colorHex: string | number,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rotY = 0,
    rotX = 0,
  ): void {
    if (w <= 1e-4 || h <= 1e-4 || d <= 1e-4) return;
    if (rotY !== 0 || rotX !== 0) {
      const g = new T.BoxGeometry(w, h, d);
      if (rotX) g.rotateX(rotX);
      if (rotY) g.rotateY(rotY);
      g.translate(x, y, z);
      this.pushGeo(colorHex, g);
      return;
    }
    const target: AxisBoxBounds = {
      x0: x - w * 0.5,
      x1: x + w * 0.5,
      y0: y - h * 0.5,
      y1: y + h * 0.5,
      z0: z - d * 0.5,
      z1: z + d * 0.5,
    };
    const subBoxes = subtractAxisBox3D(target, this.occupied);
    for (let i = 0; i < subBoxes.length; i++) {
      const sb = subBoxes[i];
      this.occupied.push(sb);
      const g = new T.BoxGeometry(sb.x1 - sb.x0, sb.y1 - sb.y0, sb.z1 - sb.z0);
      g.translate((sb.x0 + sb.x1) * 0.5, (sb.y0 + sb.y1) * 0.5, (sb.z0 + sb.z1) * 0.5);
      this.pushGeo(colorHex, g);
    }
  }

  addCylinder(
    colorHex: string | number,
    rt: number,
    rb: number,
    h: number,
    segs: number,
    x: number,
    y: number,
    z: number,
  ): void {
    const g = new T.CylinderGeometry(rt, rb, h, segs);
    g.translate(x, y, z);
    this.pushGeo(colorHex, g);
  }

  build(
    material: T.Material,
    parent: T.Group,
    castShadow: boolean,
    name: string,
    owned?: { dispose(): void }[],
  ): T.Mesh | null {
    if (!this.geos.length) return null;
    const merged = mergeGeometries(this.geos, false);
    for (const g of this.geos) g.dispose();
    this.geos.length = 0;
    this.occupied.length = 0;
    if (!merged) return null;
    const mesh = new T.Mesh(merged, material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.name = name;
    parent.add(mesh);
    if (owned) owned.push(merged);
    return mesh;
  }
}

/** Painted warm 2x2 illustrated café poster atlas (pure Canvas2D, zero external assets, English-only). */
function createCafePosterAtlas(): T.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  const drawPanel = (ox: number, oy: number, bg: string, accent: string, title: string, sub: string, motif: number) => {
    g.fillStyle = bg;
    g.fillRect(ox, oy, 256, 256);
    g.strokeStyle = accent;
    g.lineWidth = 4;
    g.strokeRect(ox + 14, oy + 14, 228, 228);
    g.fillStyle = accent;
    if (motif === 0) {
      // Warm steamed espresso cup silhouette
      g.beginPath();
      g.arc(ox + 128, oy + 116, 42, 0, Math.PI, false);
      g.fill();
      g.fillRect(ox + 78, oy + 158, 100, 10);
      g.strokeStyle = '#d9a46c';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(ox + 112, oy + 94); g.quadraticCurveTo(ox + 104, oy + 72, ox + 116, oy + 58);
      g.moveTo(ox + 138, oy + 94); g.quadraticCurveTo(ox + 146, oy + 72, ox + 134, oy + 58);
      g.stroke();
    } else if (motif === 1) {
      // Botanical coffee branch emblem
      g.strokeStyle = accent;
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(ox + 92, oy + 166); g.quadraticCurveTo(ox + 128, oy + 110, ox + 164, oy + 62);
      g.stroke();
      for (const [lx, ly, r] of [[108, 136, -0.5], [142, 114, 0.55], [122, 92, -0.45], [154, 78, 0.45]]) {
        g.save();
        g.translate(ox + lx, oy + ly);
        g.rotate(r);
        g.beginPath();
        g.ellipse(0, 0, 22, 10, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    } else if (motif === 2) {
      // Golden sunrise over riverside bridge arch
      g.fillStyle = '#e09a52';
      g.beginPath();
      g.arc(ox + 128, oy + 122, 34, Math.PI, 0);
      g.fill();
      g.fillStyle = accent;
      g.fillRect(ox + 56, oy + 126, 144, 14);
      g.fillStyle = bg;
      g.beginPath();
      g.arc(ox + 94, oy + 146, 22, Math.PI, 0);
      g.arc(ox + 162, oy + 146, 22, Math.PI, 0);
      g.fill();
    } else {
      // Roastery emblem ring
      g.strokeStyle = accent;
      g.lineWidth = 5;
      g.beginPath();
      g.arc(ox + 128, oy + 114, 44, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#c97b42';
      g.beginPath();
      g.ellipse(ox + 128, oy + 114, 18, 28, 0.35, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#2d241e';
    g.textAlign = 'center';
    g.font = '700 21px Quicksand, sans-serif';
    g.fillText(title, ox + 128, oy + 202, 210);
    g.fillStyle = '#6c5a4b';
    g.font = '600 13px Quicksand, sans-serif';
    g.fillText(sub, ox + 128, oy + 225, 210);
  };
  drawPanel(0, 0, '#f4ead8', '#6b4226', 'SINGLE ORIGIN', 'MORNING ESPRESSO', 0);
  drawPanel(256, 0, '#ece7d8', '#3c6148', 'BOTANICAL ROAST', 'ARABICA LEAF', 1);
  drawPanel(0, 256, '#f2e4cf', '#344b66', 'RIVERSIDE BREW', 'GOLDEN HOUR', 2);
  drawPanel(256, 256, '#ede2d4', '#7a3f2d', 'ARTISAN PASTRY', 'BAKED DAILY', 3);
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Painted warm backlit English café menu board texture (ZERO Vietnamese, ZERO '&', ZERO emoji). */
function createCafeMenuBoardTexture(): T.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#201a17';
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#d2a86e';
  g.lineWidth = 5;
  g.strokeRect(10, 10, 492, 236);

  g.fillStyle = '#f5dfb8';
  g.textAlign = 'center';
  g.font = '700 28px Quicksand, sans-serif';
  g.fillText('PIXEL CAFE MENU', 256, 46);
  g.fillStyle = '#cba16a';
  g.font = '600 13px Quicksand, sans-serif';
  g.fillText('FRESH ROAST COFFEE AND DAILY PASTRIES', 256, 68);
  g.fillRect(40, 80, 432, 2);

  const leftItems: [string, string][] = [
    ['ESPRESSO', '3.50'],
    ['OAT LATTE', '4.80'],
    ['MATCHA CREAM', '5.20'],
    ['COLD BREW', '4.40'],
  ];
  const rightItems: [string, string][] = [
    ['BUTTER CROISSANT', '3.80'],
    ['ALMOND TART', '4.50'],
    ['VANILLA CAKE', '4.90'],
    ['JASMINE TEA', '3.60'],
  ];
  g.font = '600 17px Quicksand, sans-serif';
  leftItems.forEach(([name, price], i) => {
    const y = 114 + i * 34;
    g.textAlign = 'left';
    g.fillStyle = '#f3eadc';
    g.fillText(name, 34, y);
    g.textAlign = 'right';
    g.fillStyle = '#e4be82';
    g.fillText(price, 238, y);
  });
  rightItems.forEach(([name, price], i) => {
    const y = 114 + i * 34;
    g.textAlign = 'left';
    g.fillStyle = '#f3eadc';
    g.fillText(name, 270, y);
    g.textAlign = 'right';
    g.fillStyle = '#e4be82';
    g.fillText(price, 478, y);
  });

  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Painted bilingual architectural signboard texture (disposed by its owner on chunk unload). */
export function textBoard(lines: string[], w: number, h: number, bg = '#22323f', fg = '#f6ead2') {
  const c = document.createElement('canvas'); c.width = 512; c.height = Math.max(64, Math.round(512 * h / w));
  const g = c.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#c3a67b'; g.lineWidth = 6; g.strokeRect(8, 8, c.width - 16, c.height - 16);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  const size = Math.min(c.height / (lines.length + .6), 68);
  lines.forEach((line, i) => {
    g.font = `600 ${Math.round(size * (i ? .62 : 1))}px Quicksand, sans-serif`;
    g.fillText(line, c.width / 2, c.height * (i + .5 + (lines.length === 1 ? 0 : .06)) / lines.length, c.width - 32);
  });
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export interface BuildingMirrorDescriptor {
  readonly id: string;
  readonly buildingId: EnterableBuilding['id'];
  readonly kind: string;
  readonly geometry: T.BufferGeometry;
  readonly worldMatrix: T.Matrix4;
  readonly center: T.Vector3;
  readonly normal: T.Vector3;
  readonly width: number;
  readonly height: number;
  readonly size: T.Vector2;
}

export type TvConsolePartRole = 'walnut' | 'walnut-dark' | 'slate' | 'brass' | 'led';

export interface TvConsolePartSpec {
  role: TvConsolePartRole;
  colorHex: string;
  w: number;
  h: number;
  d: number;
  x: number;
  y: number;
  z: number;
  rotY: number;
}

export interface BuildTvConsoleOptions {
  x?: number;
  y?: number;
  z?: number;
  /** Facing yaw in radians (`0` faces `+Z`, `-Math.PI / 2` faces `-X`, matching `placeOn`). */
  rotY?: number;
  /** Console width along the wall (default `1.56 m`). */
  width?: number;
  /** Console depth front-to-back (default `0.44 m`). */
  depth?: number;
  /** Console top surface height above `y` (default `TV_CONSOLE_TOP_Y = 0.55 m`). */
  height?: number;
}

/**
 * Generates deterministic mid-century walnut + matte-slate TV media console box primitives (`H = 0.55 m` default):
 * splayed plinth legs with brass ferrules, fluted left/right cabinet doors with brass edge pulls, recessed center
 * AV bay with receiver + slim soundbar, and beveled walnut top slab. Zero external GLBs, reusable across `house.ts`,
 * `buildingsView.ts`, and `workshopView.ts`.
 */
export function buildTvConsoleParts(opts: BuildTvConsoleOptions = {}): TvConsolePartSpec[] {
  const ox = opts.x ?? 0;
  const oy = opts.y ?? 0;
  const oz = opts.z ?? 0;
  const rotY = opts.rotY ?? 0;
  const W = Math.max(0.96, opts.width ?? 1.56);
  const D = Math.max(0.32, opts.depth ?? 0.44);
  const H = Math.max(0.42, opts.height ?? TV_CONSOLE_TOP_Y);

  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const parts: TvConsolePartSpec[] = [];
  const add = (role: TvConsolePartRole, colorHex: string, w: number, h: number, d: number, lx: number, ly: number, lz: number) => {
    if (w <= 1e-4 || h <= 1e-4 || d <= 1e-4) return;
    parts.push({
      role,
      colorHex,
      w,
      h,
      d,
      x: ox + lx * cosY + lz * sinY,
      y: oy + ly,
      z: oz - lx * sinY + lz * cosY,
      rotY,
    });
  };

  const legH = Math.min(0.14, H * 0.255);
  const topThick = 0.03;
  const bodyH = Math.max(0.2, H - legH - topThick);
  const bodyY0 = legH;
  const bodyMidY = bodyY0 + bodyH * 0.5;
  const legOffX = W * 0.5 - 0.085;
  const legOffZ = D * 0.5 - 0.06;

  // 1. Plinth base: 4 corner legs + brass ferrules + center support foot + front/rear stretcher rails.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add('walnut-dark', '#4a3120', 0.042, legH - 0.022, 0.042, sx * legOffX, 0.022 + (legH - 0.022) * 0.5, sz * legOffZ);
      add('brass', '#c49e59', 0.045, 0.022, 0.045, sx * legOffX, 0.011, sz * legOffZ);
    }
  }
  add('walnut-dark', '#4a3120', 0.038, legH, 0.038, 0, legH * 0.5, 0);
  add('walnut-dark', '#533723', W - 0.18, 0.03, 0.032, 0, legH - 0.018, legOffZ);
  add('walnut-dark', '#533723', W - 0.18, 0.03, 0.032, 0, legH - 0.018, -legOffZ);

  // 2. Main lowboard carcass: bottom deck, matte-slate rear backer, outer walnut cheeks, and AV bay dividers.
  const deckThick = 0.024;
  const innerH = bodyH - deckThick;
  const innerMidY = bodyY0 + deckThick + innerH * 0.5;
  const bayW = Math.max(0.42, W * 0.37);
  add('walnut', '#6b482f', W, deckThick, D, 0, bodyY0 + deckThick * 0.5, 0);
  add('slate', '#252a32', W - 0.04, innerH, 0.022, 0, innerMidY, -D * 0.5 + 0.02);
  add('walnut', '#6b482f', 0.026, innerH, D, -W * 0.5 + 0.013, innerMidY, 0);
  add('walnut', '#6b482f', 0.026, innerH, D, W * 0.5 - 0.013, innerMidY, 0);
  add('walnut-dark', '#563924', 0.024, innerH, D - 0.03, -bayW * 0.5, innerMidY, -0.006);
  add('walnut-dark', '#563924', 0.024, innerH, D - 0.03, bayW * 0.5, innerMidY, -0.006);

  // 3. Left & right fluted walnut cabinet doors + brushed brass edge pulls.
  const sideSpan = (W - bayW) * 0.5 - 0.038;
  if (sideSpan > 0.16) {
    const doorZ = D * 0.5 - 0.016;
    const ribCount = Math.max(3, Math.min(6, Math.round(sideSpan / 0.075)));
    for (const side of [-1, 1]) {
      const doorCx = side * (bayW * 0.5 + 0.012 + sideSpan * 0.5);
      add('walnut', '#765138', sideSpan - 0.008, innerH - 0.014, 0.02, doorCx, innerMidY, doorZ);
      for (let rIdx = 0; rIdx < ribCount; rIdx++) {
        const u = ribCount === 1 ? 0 : rIdx / (ribCount - 1) - 0.5;
        const rx = doorCx + u * (sideSpan - 0.055);
        add('walnut-dark', '#583b25', 0.015, innerH - 0.034, 0.01, rx, innerMidY, doorZ + 0.011);
      }
      const pullX = side * (bayW * 0.5 + 0.042);
      add('brass', '#c8a25c', 0.014, Math.min(0.11, innerH * 0.34), 0.018, pullX, innerMidY + 0.02, doorZ + 0.014);
    }
  }

  // 4. Center open matte-slate AV bay: mid-shelf, media receiver + indicator LED + brass dial, and upper slim soundbar.
  const shelfY = bodyMidY + 0.01;
  add('slate', '#2c323b', bayW - 0.024, 0.018, D - 0.048, 0, shelfY, 0.004);
  const recW = Math.min(bayW - 0.08, 0.42);
  const recH = Math.min(0.078, (shelfY - (bodyY0 + deckThick)) * 0.68);
  const recD = Math.min(D - 0.1, 0.29);
  const recY = bodyY0 + deckThick + recH * 0.5 + 0.006;
  add('slate', '#1f242c', recW, recH, recD, 0, recY, 0.018);
  add('led', '#6fd6e8', 0.038, 0.008, 0.008, -recW * 0.26, recY + 0.006, 0.018 + recD * 0.5 + 0.003);
  add('brass', '#b8944f', 0.02, 0.02, 0.014, recW * 0.34, recY, 0.018 + recD * 0.5 + 0.005);

  const barW = Math.min(bayW - 0.05, 0.5);
  const barH = 0.052;
  const barD = 0.084;
  add('slate', '#1b1f26', barW, barH, barD, 0, shelfY + 0.009 + barH * 0.5, D * 0.5 - 0.072);

  // 5. Overhanging beveled walnut top slab (`top = oy + H`) + flush rear cable grommet.
  add('walnut', '#734e34', W + 0.016, topThick, D + 0.012, 0, H - topThick * 0.5, 0);
  add('slate', '#2b3038', Math.min(0.18, W * 0.14), 0.004, 0.046, 0, H - 0.001, -D * 0.5 + 0.065);

  return parts;
}

/** Builds a standalone 1-draw-call vertex-colored `THREE.Group` for `tv-console` (for workshop / standalone callers). */
export function buildTvConsoleGroup(opts: BuildTvConsoleOptions = {}): { group: T.Group; dispose(): void } {
  const group = new T.Group();
  group.name = 'tv-media-console';
  const vc = new VertexColorBatch();
  for (const p of buildTvConsoleParts(opts)) {
    vc.addBox(p.colorHex, p.w, p.h, p.d, p.x, p.y, p.z, p.rotY);
  }
  const owned: { dispose(): void }[] = [];
  const material = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.12 });
  patchMaterialWithEchoCsm(material);
  patchHeightFog(material);
  owned.push(material);
  vc.build(material, group, false, 'tv-media-console-mesh', owned);
  return {
    group,
    dispose() {
      for (const o of owned) o.dispose();
      group.removeFromParent();
    },
  };
}

export interface BuildingBuild {
  readonly id: EnterableBuilding['id'];
  readonly building: EnterableBuilding;
  readonly group: T.Group;
  readonly door: LifeDoor;
  readonly blockers: T.Object3D[];
  readonly solids: SolidBox[];
  readonly fixtures: { at: T.Vector3; room: string; warm: boolean }[];
  readonly mirrors: readonly BuildingMirrorDescriptor[];
  readonly exteriorReady: Promise<void>;
  setNight(night: number): void;
  setQuality?(tier: QualityTier): void;
  setCameraPos?(pos: T.Vector3): void;
  getInteriorState?(): InteriorResidencyState;
  update(dt: number, reduced: boolean, body: { x: number; z: number }): void;
  dispose(): void;
}

export interface BuildEnterableBuildingOptions {
  surfaces?: WorldSurfaceLibrary;
  tier?: QualityTier;
  weather?: SharedWeatherUniforms;
  /** Optional async off-stage GPU texture/shader prewarm hook invoked before revealing `contents` or exterior props. */
  prewarmObject?: (obj: T.Object3D) => Promise<void> | void;
  /** Optional callback fired for each reflective mirror pane skipped during static interior batching (`PlanarMirrorSystem`). */
  onMirrorFound?: (info: BuildingMirrorDescriptor) => (() => void) | void;
}

/** Shared world-level prewarm callback registered by `EchoLifeWorld.setPrewarmObject()` for lazy interior mounts. */
let activeBuildingPrewarmHook: ((obj: T.Object3D) => Promise<void> | void) | undefined;
let activeBuildingMirrorHook: ((info: BuildingMirrorDescriptor) => (() => void) | void) | undefined;

/** Global serialization queue (`max 1` concurrent building interior merge/prewarm at a time). */
let interiorFurnishMutexTail: Promise<void> = Promise.resolve();

function runSerializedInteriorFurnish(task: () => Promise<void>): Promise<void> {
  const next = interiorFurnishMutexTail.then(task, task);
  interiorFurnishMutexTail = next.catch(() => undefined);
  return next;
}

const ON_FOOT_PREFETCH_DIST = 36;
const PREDICTED_PREFETCH_DIST = 40;
const ACTIVE_RETENTION_DIST = 42;
const FAST_TRANSIT_SPEED_M_S = 4.2;

export function setBuildingInteriorPrewarmHook(
  fn: ((obj: T.Object3D) => Promise<void> | void) | undefined,
): void {
  activeBuildingPrewarmHook = fn;
}

export function setBuildingMirrorHook(
  fn: ((info: BuildingMirrorDescriptor) => (() => void) | void) | undefined,
): void {
  activeBuildingMirrorHook = fn;
}

function isMirrorGlassPart(kind: string, part: Prepared['parts'][number]): boolean {
  const role = (part as { role?: string }).role;
  const partName = (part as { name?: string }).name ?? '';
  const matName = part.material?.name ?? '';
  const geomName = part.geometry?.name ?? '';
  if (role === 'mirror-glass') return true;
  if (/mirror[_\s-]*glass/i.test(partName) || /mirror[_\s-]*glass/i.test(matName) || /mirror[_\s-]*glass/i.test(geomName)) {
    return true;
  }
  if (kind === 'mirror' && (/bath[_\s-]*mirror/i.test(matName) || role !== 'emissive')) {
    return true;
  }
  return false;
}

const BRICK_BUILDINGS = new Set<string>(['atelier', 'bistro', 'linh', 'clothing_shop']);
const BEIGE_BUILDINGS = new Set<string>(['library', 'furniture_shop', 'home_center', 'minh']);
const TERRACOTTA_ROOF_BUILDINGS = new Set<string>(['library', 'linh', 'minh', 'bistro', 'atelier', 'furniture_shop', 'clothing_shop', 'living']);
const AWNING_SHOP_BUILDINGS = new Set<string>(['cafe', 'bistro', 'market', 'clothing_shop', 'furniture_shop', 'atelier', 'electronics_shop', 'home_center']);
const CAFE_PATIO_BUILDINGS = new Set<string>(['cafe', 'bistro', 'atelier']);
const CHALKBOARD_BUILDINGS = new Set<string>(['cafe', 'bistro', 'market', 'clothing_shop', 'furniture_shop', 'atelier']);
const AIRCON_BUILDINGS = new Set<string>(['cafe', 'bistro', 'market', 'electronics_shop', 'repair_shop', 'clothing_shop', 'home_center', 'vehicle_dealer']);

interface AaaPropPlacement {
  id: StreetPropKey;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale?: number | readonly [number, number, number];
  castShadow?: boolean;
}

async function mountAaaPropPlacements(
  placements: readonly AaaPropPlacement[],
  parent: T.Group,
  owned: { dispose(): void }[],
  acquiredStreetProps: StreetPropKey[],
  isDisposed: () => boolean,
  allowShadows: () => boolean,
  shadowTargets?: T.Object3D[],
): Promise<void> {
  if (!placements.length || isDisposed()) return;
  const byId = new Map<StreetPropKey, AaaPropPlacement[]>();
  for (const p of placements) {
    const arr = byId.get(p.id);
    if (arr) arr.push(p);
    else byId.set(p.id, [p]);
  }
  const ids = [...byId.keys()];
  // Track every acquired ref BEFORE awaiting so dispose() releases symmetrically even mid-fetch.
  for (const id of ids) acquiredStreetProps.push(id);
  const loaded = await Promise.all(ids.map((id) => acquireStreetProp(id)));
  if (isDisposed()) return;

  const slicer = new EchoLifeTimeSlicer(3.5);
  for (let i = 0; i < ids.length; i++) {
    if (isDisposed()) return;
    const prop = loaded[i];
    if (!prop) continue;
    const list = byId.get(ids[i])!;
    const matrices = list.map((p) => placeStreetPropOn(p.x, p.y, p.z, p.rotY, p.scale ?? 1, undefined, ids[i]));
    const wantShadow = list.some((p) => p.castShadow) && allowShadows();
    const inst = instanceStreetProp(prop, matrices, wantShadow);
    inst.name = `aaa-bld-prop:${ids[i]}`;
    if (ids[i] === 'libRugWoven') {
      inst.traverse((o) => {
        const m = o as T.Mesh;
        if (!m.isMesh || !m.material) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (let mi = 0; mi < mats.length; mi++) {
          const matItem = mats[mi];
          if (!matItem) continue;
          matItem.polygonOffset = true;
          matItem.polygonOffsetFactor = -1;
          matItem.polygonOffsetUnits = -2;
        }
      });
    }
    parent.add(inst);
    freezeStaticHierarchy(inst);
    owned.push({
      dispose() {
        inst.traverse((o) => {
          if (o instanceof T.InstancedMesh) o.dispose();
        });
        inst.removeFromParent();
      },
    });
    if (shadowTargets && list.some((p) => p.castShadow)) {
      inst.traverse((o) => {
        if (o instanceof T.InstancedMesh) shadowTargets.push(o);
      });
    }
    if (i + 1 < ids.length) await slicer.yieldIfNeeded();
  }
}

/**
 * Builds one enterable city building (Poly Haven PBR walls/roofs/interiors, 3-depth architectural window & parapet
 * trim, reflective parallax storefront windows, modular aaa-v2 awnings/bistro tables/HVAC, optional 2-storey staircase
 * + elevated warm ceiling fixtures, signboard, physical swinging `LifeDoor`, AAA University Library interior,
 * cross-asset batched static interior furnishings, and strict enclosure culling) for a `HOT` streaming chunk.
 */
export function buildEnterableBuilding(b: EnterableBuilding, opts: BuildEnterableBuildingOptions = {}): BuildingBuild {
  const group = new T.Group();
  group.name = `life-building:${b.property?.id ?? b.id}`;
  const interiorGroup = new T.Group();
  interiorGroup.name = 'building-interior';
  group.add(interiorGroup);
  const owned: { dispose(): void }[] = [];
  let currentTier: QualityTier = opts.tier ?? 'high';
  let extShadows = currentTier === 'high' || currentTier === 'ultra';

  const localSurfaces = !opts.surfaces
    ? new WorldSurfaceLibrary(opts.weather ?? createSharedWeatherUniforms(), currentTier)
    : null;
  const surfaces = opts.surfaces ?? localSurfaces!;
  if (localSurfaces) owned.push(localSurfaces);

  const solids: SolidBox[] = [];
  const solid = (w: number, h: number, d: number, x: number, y: number, z: number) =>
    solids.push({ hx: w / 2, hy: h / 2, hz: d / 2, x, y, z });

  const extWalls = new Batch(), intWalls = new Batch();
  const extFloors = new Batch(), intFloors = new Batch();
  const extTrimVc = new VertexColorBatch();
  const intTrims = new Batch();
  const acquiredStreetProps: StreetPropKey[] = [];

  // Select authentic architectural Poly Haven PBR wall & roof styles per building identity.
  const wallStyle = b.property?.id === 'prop_cozy_townhouse' || BRICK_BUILDINGS.has(b.id)
    ? 'brick'
    : BEIGE_BUILDINGS.has(b.id)
      ? 'beige'
      : 'stucco';
  const exteriorM = surfaces.exteriorWall(b.wallColor, wallStyle);
  const interiorM = surfaces.interiorWall(b.interiorColor);
  const accentHex = b.accentColor;
  const frameHex = '#38414c';
  const stoneTrimHex = b.id === 'repair_shop' || b.id === 'electronics_shop' ? '#9fa5ad' : '#ddd4c5';
  const frameM = surfaces.exteriorTrim(frameHex, true);
  const trimM = mat('trim', '#fbf7f0');
  patchMaterialWithEchoCsm(trimM);
  patchHeightFog(trimM);
  const libraryWalnutM = surfaces.timber('#5d3f28', true, false);
  const libraryBrassM = mat('metal', '#b8944f');
  patchMaterialWithEchoCsm(libraryBrassM);
  patchHeightFog(libraryBrassM);
  const extTrimSharedM = surfaces.vertexColoredTrim(true);

  const glassHandle: ArchitecturalGlassHandle = surfaces.createGlass({
    shop: AWNING_SHOP_BUILDINGS.has(b.id),
    enterable: true,
    preset: b.id === 'library' ? 'library' : AWNING_SHOP_BUILDINGS.has(b.id) ? 'shop' : 'residential',
  });
  const glass = glassHandle.material;

  const bw = b.rect.x1 - b.rect.x0, bd = b.rect.z1 - b.rect.z0;
  const bcx = (b.rect.x0 + b.rect.x1) / 2, bcz = (b.rect.z0 + b.rect.z1) / 2;
  const isGrand = b.id === 'library' || b.storeys >= 2 || BRICK_BUILDINGS.has(b.id) || BEIGE_BUILDINGS.has(b.id);

  const paneGeos: T.BufferGeometry[] = [];
  const pane = (w: number, h: number, x: number, y: number, z: number, rotY: number) => {
    const g = new T.PlaneGeometry(w, h);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y, z);
    paneGeos.push(g);
  };

  // Perimeter and interior walls, cut cleanly around doors and display windows with 3-depth architectural reveals.
  for (const w of b.walls) {
    const alongX = w.x1 - w.x0 >= w.z1 - w.z0;
    const a0 = alongX ? w.x0 : w.z0, a1 = alongX ? w.x1 : w.z1;
    const t0 = alongX ? w.z0 : w.x0, t1 = alongX ? w.z1 : w.x1;
    const thick = t1 - t0, mid = (t0 + t1) / 2, height = w.y1 - w.y0;
    const isInt = w.face === 'interior';
    const wBatch = isInt ? intWalls : extWalls;
    const extCutters = isInt ? extWalls.occupiedBounds : undefined;
    const material = isInt ? interiorM : exteriorM;

    // Outward normal sign for projecting stone sills, lintels, and recessed glazing planes.
    const outSign = isInt
      ? 0
      : alongX
        ? (mid < bcz ? -1 : 1)
        : (mid < bcx ? -1 : 1);

    const piece = (from: number, to: number, y0: number, y1: number) => {
      const len = to - from, c = (from + to) / 2, cy = (y0 + y1) / 2;
      if (len <= 1e-4 || y1 - y0 <= 1e-4) return;
      if (alongX) { wBatch.add(material, len, y1 - y0, thick, c, cy, mid, 0, extCutters); solid(len, y1 - y0, thick, c, cy, mid); }
      else { wBatch.add(material, thick, y1 - y0, len, mid, cy, c, 0, extCutters); solid(thick, y1 - y0, len, mid, cy, c); }
    };
    const openings = [...w.openings].sort((p, q) => p.from - q.from);
    let at = a0;
    for (const o of openings) {
      const from = Math.max(a0, o.from), to = Math.min(a1, o.to);
      if (to <= from) continue;
      piece(at, from, w.y0, w.y1);
      const top = Math.min(height, o.top), bottom = o.bottom ?? 0;
      piece(from, to, w.y0 + top, w.y1);
      if (bottom > 0) piece(from, to, w.y0, w.y0 + bottom);
      const len = to - from, c = (from + to) / 2;
      // Orient every exterior window pane so its PlaneGeometry +Z normal deterministically points OUTDOORS.
      const paneRot = alongX ? (outSign < 0 ? Math.PI : 0) : (outSign < 0 ? -Math.PI / 2 : Math.PI / 2);
      const putTrim = (colorHex: string, intMat: T.Material, lw: number, lh: number, ld: number, along: number, y: number, offsetOut = 0) => {
        const perp = mid + outSign * offsetOut;
        if (isInt) {
          if (alongX) intTrims.add(intMat, lw, lh, ld, along, y, perp, 0, extCutters);
          else intTrims.add(intMat, ld, lh, lw, perp, y, along, 0, extCutters);
        } else {
          if (alongX) extTrimVc.addBox(colorHex, lw, lh, ld, along, y, perp);
          else extTrimVc.addBox(colorHex, ld, lh, lw, perp, y, along);
        }
      };

      if (o.bottom !== undefined) {
        const y0 = w.y0 + bottom, y1 = w.y0 + top, cy = (y0 + y1) / 2, wh = y1 - y0;
        // Layer 1 (outer): projecting stone lintel head + deep projecting window sill + under-sill apron.
        if (!isInt) {
          putTrim(stoneTrimHex, frameM, len + .24, .11, thick + .14, c, y1 + .055, .045);
          putTrim(stoneTrimHex, frameM, len + .26, .075, thick + .17, c, y0 - .032, .055);
          putTrim(accentHex, frameM, len + .12, .045, .06, c, y0 - .09, thick / 2 + .03);
        }
        // Layer 2 (mid): dark aluminum/timber outer jambs, head, and inner reveal casing.
        putTrim(frameHex, frameM, len + .08, .065, thick + .05, c, y1 - .015);
        putTrim(frameHex, frameM, len + .08, .055, thick + .05, c, y0 + .015);
        putTrim(frameHex, frameM, .065, wh, thick + .05, from + .02, cy);
        putTrim(frameHex, frameM, .065, wh, thick + .05, to - .02, cy);
        // Layer 3 (recessed): architectural vertical mullions & upper transom bar.
        if (len > 2.4) {
          putTrim(frameHex, frameM, .042, wh, thick * .55, from + len / 3, cy, -0.015);
          putTrim(frameHex, frameM, .042, wh, thick * .55, from + (2 * len) / 3, cy, -0.015);
        } else if (len > 1.2) {
          putTrim(frameHex, frameM, .042, wh, thick * .55, c, cy, -0.015);
        }
        if (wh >= 1.5) {
          putTrim(frameHex, frameM, len - .06, .04, thick * .52, c, y1 - .42, -0.015);
        }
        // Recess glass 2.5 cm inward from facade face for authentic architectural depth.
        const glassPerp = mid - outSign * .025;
        if (alongX) pane(len, wh, c, cy, glassPerp, paneRot);
        else pane(len, wh, glassPerp, cy, c, paneRot);
      } else if (!isInt) {
        // Exterior doorway surround: flanking pilasters + architectural entablature header.
        const y1 = w.y0 + top;
        putTrim(frameHex, frameM, .11, top + .06, thick + .08, from - .04, w.y0 + top / 2, .025);
        putTrim(frameHex, frameM, .11, top + .06, thick + .08, to + .04, w.y0 + top / 2, .025);
        putTrim(stoneTrimHex, frameM, len + .32, .14, thick + .16, c, y1 + .07, .05);
      }
      at = to;
    }
    piece(at, a1, w.y0, w.y1);

    // Base plinth water table along exterior walls (grounds masonry cleanly into sidewalks).
    if (!isInt) {
      const wLen = a1 - a0, wMid = (a0 + a1) / 2;
      const plinthPerp = mid + outSign * (thick / 2 + .025);
      if (openings.some((o) => o.bottom === undefined)) {
        // Skip doorway gap on front facade so the door threshold stays flush.
        let pAt = a0;
        for (const o of openings) {
          if (o.bottom !== undefined) continue;
          const pTo = Math.max(a0, o.from - .08);
          if (pTo - pAt > .15) {
            if (alongX) extTrimVc.addBox(stoneTrimHex, pTo - pAt, .38, .05, (pAt + pTo) / 2, w.y0 + .195, plinthPerp);
            else extTrimVc.addBox(stoneTrimHex, .05, .38, pTo - pAt, plinthPerp, w.y0 + .195, (pAt + pTo) / 2);
          }
          pAt = Math.min(a1, o.to + .08);
        }
        if (a1 - pAt > .15) {
          if (alongX) extTrimVc.addBox(stoneTrimHex, a1 - pAt, .38, .05, (pAt + a1) / 2, w.y0 + .195, plinthPerp);
          else extTrimVc.addBox(stoneTrimHex, .05, .38, a1 - pAt, plinthPerp, w.y0 + .195, (pAt + a1) / 2);
        }
      } else {
        if (alongX) extTrimVc.addBox(stoneTrimHex, wLen + .04, .38, .05, wMid, w.y0 + .195, plinthPerp);
        else extTrimVc.addBox(stoneTrimHex, .05, .38, wLen + .04, plinthPerp, w.y0 + .195, wMid);
      }
    }

    // Skirting along interior faces + rich walnut wainscoting chair rail inside University Library.
    if (isInt) {
      const skirtM = b.id === 'library' ? libraryWalnutM : trimM;
      if (alongX) intTrims.add(skirtM, a1 - a0, .098, thick + .03, (a0 + a1) / 2, w.y0 + .051, mid, 0, extCutters);
      else intTrims.add(skirtM, thick + .03, .098, a1 - a0, mid, w.y0 + .051, (a0 + a1) / 2, 0, extCutters);
    } else if (b.id === 'library') {
      // Interior walnut baseboard & wainscoting chair rail on the inside face of Library perimeter walls.
      const inPerp = mid - outSign * (thick / 2 + .018);
      if (alongX) {
        intTrims.add(libraryWalnutM, a1 - a0 - .32, .118, .035, (a0 + a1) / 2, GROUND_Y + .062, inPerp);
      } else {
        intTrims.add(libraryWalnutM, .035, .118, a1 - a0 - .32, inPerp, GROUND_Y + .062, (a0 + a1) / 2);
      }
    }
  }
  if (paneGeos.length) {
    const mergedPanes = mergeGeometries(paneGeos, false);
    paneGeos.forEach(g => g.dispose());
    if (mergedPanes) {
      owned.push(mergedPanes);
      const pm = new T.Mesh(mergedPanes, glass);
      pm.renderOrder = 2; pm.name = 'building-glass';
      group.add(pm);
    }
  }

  // Floors, mezzanine slabs, Poly Haven terracotta/concrete roof, ceiling, and multi-tier architectural cornice.
  const pitchedRoof = TERRACOTTA_ROOF_BUILDINGS.has(b.id) || !!b.property;
  const FLOOR: Record<string, T.Material> = {
    oak: surfaces.interiorFloor('oak', '#e4d4be'),
    tile: surfaces.interiorFloor('tile', '#eef1f5'),
    terrazzo: surfaces.interiorFloor('terrazzo', '#ece6db'),
    roof: surfaces.exteriorRoof(pitchedRoof ? '#e4d6c8' : '#8a8f98', pitchedRoof),
    concrete: surfaces.interiorFloor('concrete', '#b4aea6'),
  };
  let roofY = GROUND_Y + 3.35;
  let roofSlabTopY = roofY + .26;
  for (const s of b.slabs) {
    const w = s.rect.x1 - s.rect.x0, d = s.rect.z1 - s.rect.z0;
    const cx = (s.rect.x0 + s.rect.x1) / 2, cz = (s.rect.z0 + s.rect.z1) / 2;
    if (s.finish === 'roof') {
      roofY = s.y - s.thick;
      // Lift exterior roof slab +40 mm above roofY ([roofY + 0.04 .. roofY + 0.26]) so interior ceiling [roofY - 0.040 .. roofY - 0.016]
      // stays >= 56 mm clear below the roof slab with 0.0 mm² coplanar overlap!
      const liftedCy = s.y - s.thick / 2 + .04;
      roofSlabTopY = s.y + .04;
      extFloors.add(FLOOR.roof, w, s.thick, d, cx, liftedCy, cz);
      solid(w, s.thick, d, cx, liftedCy, cz);
    } else {
      intFloors.add(FLOOR[s.finish], w, s.thick, d, cx, s.y - s.thick / 2, cz);
      solid(w, s.thick, d, cx, s.y - s.thick / 2, cz);
    }
  }
  // Interior ceiling plane [roofY - 0.040 .. roofY - 0.016]: bottom stays 12 mm above Library skylight coffers & rosettes,
  // while top stays 56 mm below the lifted exterior roof slab!
  const ceilingM = surfaces.interiorWall(b.id === 'library' ? '#f3ead9' : '#f7f5f0');
  intFloors.add(ceilingM, bw - .32, .024, bd - .32, bcx, roofY - .028, bcz);

  // Perimeter-only architectural roof frieze, perimeter parapet walls, and overhanging stone coping (keeps Poly Haven
  // terracotta/concrete roof top 100% uncovered instead of burying it in a solid coplanar slab!).
  const roofTopY = roofSlabTopY;
  const friezeOut = .10, corniceOut = .17;
  // 4-sided perimeter accent frieze [roofY .. roofY + 0.22] strictly outside roof footprint + 40 mm under-eave wall seal
  extTrimVc.addBox(accentHex, bw + friezeOut * 2, .22, friezeOut, bcx, roofY + .11, b.rect.z0 - friezeOut * 0.5);
  extTrimVc.addBox(accentHex, bw + friezeOut * 2, .22, friezeOut, bcx, roofY + .11, b.rect.z1 + friezeOut * 0.5);
  extTrimVc.addBox(accentHex, friezeOut, .22, bd, b.rect.x0 - friezeOut * 0.5, roofY + .11, bcz);
  extTrimVc.addBox(accentHex, friezeOut, .22, bd, b.rect.x1 + friezeOut * 0.5, roofY + .11, bcz);
  extTrimVc.addBox(stoneTrimHex, bw + corniceOut * 2, .08, corniceOut, bcx, roofTopY + .01, b.rect.z0 - corniceOut * 0.5);
  extTrimVc.addBox(stoneTrimHex, bw + corniceOut * 2, .08, corniceOut, bcx, roofTopY + .01, b.rect.z1 + corniceOut * 0.5);
  extTrimVc.addBox(stoneTrimHex, corniceOut, .08, bd, b.rect.x0 - corniceOut * 0.5, roofTopY + .01, bcz);
  extTrimVc.addBox(stoneTrimHex, corniceOut, .08, bd, b.rect.x1 + corniceOut * 0.5, roofTopY + .01, bcz);
  const parapetH = b.id === 'library' ? .52 : .38;
  const parapetT = .22;
  const pMidY = roofTopY + parapetH / 2 + .02;
  extWalls.add(exteriorM, bw + .04, parapetH, parapetT, bcx, pMidY, b.rect.z0 + parapetT / 2);
  extWalls.add(exteriorM, bw + .04, parapetH, parapetT, bcx, pMidY, b.rect.z1 - parapetT / 2);
  extWalls.add(exteriorM, parapetT, parapetH, bd - parapetT * 2, b.rect.x0 + parapetT / 2, pMidY, bcz);
  extWalls.add(exteriorM, parapetT, parapetH, bd - parapetT * 2, b.rect.x1 - parapetT / 2, pMidY, bcz);
  const capY = roofTopY + parapetH + .06;
  extTrimVc.addBox(stoneTrimHex, bw + .18, .08, parapetT + .12, bcx, capY, b.rect.z0 + parapetT / 2);
  extTrimVc.addBox(stoneTrimHex, bw + .18, .08, parapetT + .12, bcx, capY, b.rect.z1 - parapetT / 2);
  extTrimVc.addBox(stoneTrimHex, parapetT + .12, .08, bd - parapetT * 2, b.rect.x0 + parapetT / 2, capY, bcz);
  extTrimVc.addBox(stoneTrimHex, parapetT + .12, .08, bd - parapetT * 2, b.rect.x1 - parapetT / 2, capY, bcz);

  // Corner masonry pilasters on grand/brick/beige/2-storey facades + mid-storey stone stringcourse on 2-storey buildings.
  if (isGrand) {
    const pilH = roofY - GROUND_Y + .14;
    const pilY = GROUND_Y + pilH / 2;
    for (const px of [b.rect.x0 + .06, b.rect.x1 - .06]) {
      for (const pz of [b.rect.z0 + .06, b.rect.z1 - .06]) {
        extTrimVc.addBox(stoneTrimHex, .26, pilH, .26, px, pilY, pz);
      }
    }
  }
  if (b.storeys >= 2) {
    // 4 hollow exterior perimeter stringcourse bands wrapping ONLY the outer walls so double-height
    // interiors (Library reading hall, 2F staircases) remain 100% open to the upper coffered ceiling!
    const bandY = GROUND_Y + 2.68;
    extTrimVc.addBox(stoneTrimHex, bw + .16, .13, .10, bcx, bandY, b.rect.z0 - .03);
    extTrimVc.addBox(stoneTrimHex, bw + .16, .13, .10, bcx, bandY, b.rect.z1 + .03);
    extTrimVc.addBox(stoneTrimHex, .10, .13, bd + .16, b.rect.x0 - .03, bandY, bcz);
    extTrimVc.addBox(stoneTrimHex, .10, .13, bd + .16, b.rect.x1 + .03, bandY, bcz);
  }

  // Subtle wall-mounted transom ledger above shopfronts (backs the sculpted aaa-v2 striped awnings cleanly;
  // non-awning buildings get an architectural entrance canopy hood).
  const frontFaceZ = b.facing === 'north' ? b.rect.z0 : b.rect.z1;
  const frontOut = b.facing === 'north' ? -1 : 1;
  if (AWNING_SHOP_BUILDINGS.has(b.id)) {
    extTrimVc.addBox(accentHex, bw - .4, .11, .16, bcx, GROUND_Y + 2.68, frontFaceZ + frontOut * .06);
  } else {
    extTrimVc.addBox(accentHex, Math.min(bw - .6, 4.6), .14, .58, bcx, GROUND_Y + 2.58, frontFaceZ + frontOut * .28);
    extTrimVc.addBox(stoneTrimHex, Math.min(bw - .5, 4.76), .06, .66, bcx, GROUND_Y + 2.67, frontFaceZ + frontOut * .30);
  }

  // Framed 3D English storefront signboard mounted cleanly above the awning band with dual gooseneck brackets.
  const signW = Math.min(5.2, bw - 1.2), signH = .54;
  const signZ = frontFaceZ + frontOut * .12;
  const signY = GROUND_Y + 3.12;
  extTrimVc.addBox(frameHex, signW + .16, signH + .14, .09, bcx, signY, frontFaceZ + frontOut * .065);
  extTrimVc.addBox(frameHex, .06, .06, .34, bcx - signW * .32, signY + signH / 2 + .09, frontFaceZ + frontOut * .18);
  extTrimVc.addBox(frameHex, .06, .06, .34, bcx + signW * .32, signY + signH / 2 + .09, frontFaceZ + frontOut * .18);

  const cleanSignLabel = b.name.en.replace(/\s*&\s*/g, ' and ');
  const signTex = textBoard([cleanSignLabel], signW, signH, b.accentColor);
  const signMat = new T.MeshStandardMaterial({
    map: signTex,
    roughness: .52,
    emissive: '#ffffff',
    emissiveMap: signTex,
    emissiveIntensity: .16,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  patchMaterialWithEchoCsm(signMat);
  patchHeightFog(signMat);
  const signGeo = new T.PlaneGeometry(signW, signH);
  const signMesh = new T.Mesh(signGeo, signMat);
  signMesh.position.set(bcx, signY, signZ);
  signMesh.rotation.y = b.facing === 'north' ? Math.PI : 0;
  group.add(signMesh);
  owned.push(signTex, signMat, signGeo);

  let librarySkylightMat: T.MeshStandardMaterial | null = null;
  let cafeMenuMat: T.MeshStandardMaterial | null = null;

  // Warm timber ceiling beams, walnut chair-rails, framed wall art, backlit menu board, and tabletop clutter inside Pixel Café (Scene 16!).
  if (b.id === 'cafe') {
    const cIx0 = b.rect.x0 + .16, cIx1 = b.rect.x1 - .16;
    const cIz0 = b.rect.z0 + .16, cIz1 = b.rect.z1 - .16;
    const cSpanW = cIx1 - cIx0;
    for (let i = 0; i < 3; i++) {
      const bz = cIz0 + 2.2 + ((cIz1 - cIz0 - 4.4) * i) / 2;
      intTrims.add(libraryWalnutM, cSpanW - .08, .20, .18, bcx, roofY - .12, bz);
    }
    // Warm horizontal timber chair-rail wrapping east, west, and rear walls at 1.05 m.
    intTrims.add(libraryWalnutM, .04, .14, cIz1 - cIz0 - .2, cIx0 + .02, GROUND_Y + 1.05, bcz);
    intTrims.add(libraryWalnutM, .04, .14, cIz1 - cIz0 - .2, cIx1 - .02, GROUND_Y + 1.05, bcz);
    intTrims.add(libraryWalnutM, cSpanW - .2, .14, .04, bcx, GROUND_Y + 1.05, cIz1 - .02);

    // 1. Dressed tabletops on all 3 interior round bistro tables: ceramic cups, saucers, dark coffee, pastry plates, golden croissants, menu tents (1 single merged mesh!).
    const cafeClutter = new VertexColorBatch();
    const cafeTables: readonly { x: number; y: number; z: number; seed: number }[] = [
      { x: bcx - 1.9, y: GROUND_Y + 0.688, z: cIz0 + 4.5, seed: 0 },
      { x: bcx + 0.55, y: GROUND_Y + 0.688, z: cIz0 + 5.1, seed: 1 },
      { x: cIx1 - 2.25, y: GROUND_Y + 0.673, z: cIz0 + 2.25, seed: 2 },
    ];
    for (const tb of cafeTables) {
      const a = tb.seed * 1.05;
      const ca = Math.cos(a), sa = Math.sin(a);
      const putCup = (lx: number, lz: number, cupHex: string) => {
        const wx = tb.x + lx * ca - lz * sa;
        const wz = tb.z + lx * sa + lz * ca;
        cafeClutter.addCylinder('#ece4d7', 0.068, 0.052, 0.012, 10, wx, tb.y + 0.006, wz);
        cafeClutter.addCylinder(cupHex, 0.042, 0.032, 0.072, 10, wx, tb.y + 0.044, wz);
        cafeClutter.addCylinder('#3a2315', 0.036, 0.036, 0.008, 10, wx, tb.y + 0.078, wz);
      };
      putCup(-0.14, -0.09, '#f6f1e8');
      putCup(0.14, 0.10, '#dfd4c3');
      // Cream pastry plate + warm golden croissant / almond tart
      const px = tb.x + 0.11 * ca + 0.12 * sa;
      const pz = tb.z + 0.11 * sa - 0.12 * ca;
      cafeClutter.addCylinder('#f3ede2', 0.085, 0.070, 0.014, 10, px, tb.y + 0.007, pz);
      cafeClutter.addBox('#d69448', 0.088, 0.038, 0.052, px, tb.y + 0.030, pz, a + 0.35);
      cafeClutter.addBox('#c47d34', 0.054, 0.028, 0.038, px + 0.02, tb.y + 0.034, pz - 0.01, a - 0.4);
      // Small wooden A-frame menu tent + brass napkin holder near table edge
      const mx = tb.x - 0.12 * ca + 0.13 * sa;
      const mz = tb.z - 0.12 * sa - 0.13 * ca;
      cafeClutter.addBox('#6b472b', 0.085, 0.016, 0.042, mx, tb.y + 0.008, mz, a + 0.25);
      cafeClutter.addBox('#f2e6cf', 0.078, 0.115, 0.012, mx, tb.y + 0.068, mz, a + 0.25, 0.12);
    }
    const cafeClutterMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05 });
    patchMaterialWithEchoCsm(cafeClutterMat);
    patchHeightFog(cafeClutterMat);
    owned.push(cafeClutterMat);
    cafeClutter.build(cafeClutterMat, interiorGroup, false, 'cafe-tabletop-clutter', owned);

    // 2. Framed warm illustrated wall art posters on solid west/east wall bays (clear of side windows!) — 1 single merged mesh!
    const posterSpecs: readonly { x: number; y: number; z: number; w: number; h: number; rotY: number; tile: number }[] = [
      { x: cIx0 + 0.035, y: GROUND_Y + 1.88, z: cIz0 + 1.25, w: 0.72, h: 0.88, rotY: Math.PI / 2, tile: 0 },
      { x: cIx0 + 0.035, y: GROUND_Y + 1.88, z: cIz0 + 2.45, w: 0.72, h: 0.88, rotY: Math.PI / 2, tile: 1 },
      { x: cIx0 + 0.035, y: GROUND_Y + 1.90, z: cIz1 - 1.85, w: 0.96, h: 0.88, rotY: Math.PI / 2, tile: 2 },
      { x: cIx1 - 0.035, y: GROUND_Y + 1.88, z: cIz1 - 1.25, w: 0.72, h: 0.88, rotY: -Math.PI / 2, tile: 3 },
      { x: cIx1 - 0.035, y: GROUND_Y + 1.88, z: cIz1 - 2.45, w: 0.72, h: 0.88, rotY: -Math.PI / 2, tile: 0 },
    ];
    const posterGeos: T.BufferGeometry[] = [];
    for (const ps of posterSpecs) {
      // Dark walnut frame folded into `intTrims` (0 extra draw calls)
      intTrims.add(libraryWalnutM, 0.032, ps.h + 0.09, ps.w + 0.09, ps.x - Math.sign(Math.sin(ps.rotY)) * 0.018, ps.y, ps.z);
      const pg = new T.PlaneGeometry(ps.w, ps.h);
      const col = ps.tile % 2;
      const row = 1 - Math.floor(ps.tile / 2);
      const uv = pg.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, col * 0.5 + uv.getX(i) * 0.5, row * 0.5 + uv.getY(i) * 0.5);
      }
      pg.rotateY(ps.rotY);
      pg.translate(ps.x, ps.y, ps.z);
      posterGeos.push(pg);
    }
    const mergedPosters = mergeGeometries(posterGeos, false);
    for (const pg of posterGeos) pg.dispose();
    if (mergedPosters) {
      const posterTex = createCafePosterAtlas();
      const posterMat = new T.MeshStandardMaterial({
        map: posterTex,
        roughness: 0.62,
        emissive: '#fff4df',
        emissiveMap: posterTex,
        emissiveIntensity: 0.14,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      });
      patchMaterialWithEchoCsm(posterMat);
      patchHeightFog(posterMat);
      const posterMesh = new T.Mesh(mergedPosters, posterMat);
      posterMesh.name = 'cafe-wall-posters';
      interiorGroup.add(posterMesh);
      owned.push(posterTex, posterMat, mergedPosters);
    }

    // 3. Warm backlit English Café Menu Board on east front bay + matching rear pier feature sign (1 merged mesh!).
    const menuTex = createCafeMenuBoardTexture();
    cafeMenuMat = new T.MeshStandardMaterial({
      map: menuTex,
      roughness: 0.44,
      emissive: '#ffe9c4',
      emissiveMap: menuTex,
      emissiveIntensity: 0.52,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    patchMaterialWithEchoCsm(cafeMenuMat);
    patchHeightFog(cafeMenuMat);
    const menuBoardGeos: T.BufferGeometry[] = [];
    // East front bay menu board (facing -X right into the café entrance & seating)
    const mbW = 1.84, mbH = 0.90;
    const mbX = cIx1 - 0.038, mbY = GROUND_Y + 1.98, mbZ = cIz0 + 2.05;
    intTrims.add(libraryWalnutM, 0.045, mbH + 0.11, mbW + 0.11, mbX + 0.02, mbY, mbZ);
    const mbG1 = new T.PlaneGeometry(mbW, mbH);
    mbG1.rotateY(-Math.PI / 2);
    mbG1.translate(mbX, mbY, mbZ);
    menuBoardGeos.push(mbG1);
    // Rear central pier high menu banner above bookstack (facing -Z toward front entrance)
    const mb2W = 1.54, mb2H = 0.62;
    const mb2Y = GROUND_Y + 2.52, mb2Z = cIz1 - 0.038;
    intTrims.add(libraryWalnutM, mb2W + 0.10, mb2H + 0.10, 0.045, bcx, mb2Y, mb2Z + 0.02);
    const mbG2 = new T.PlaneGeometry(mb2W, mb2H);
    mbG2.rotateY(Math.PI);
    mbG2.translate(bcx, mb2Y, mb2Z);
    menuBoardGeos.push(mbG2);
    const mergedMenu = mergeGeometries(menuBoardGeos, false);
    for (const mg of menuBoardGeos) mg.dispose();
    if (mergedMenu) {
      const menuMesh = new T.Mesh(mergedMenu, cafeMenuMat);
      menuMesh.name = 'cafe-menu-board';
      interiorGroup.add(menuMesh);
      owned.push(menuTex, cafeMenuMat, mergedMenu);
    }
  }

  // University Library structural timber trusses, longitudinal purlins, recessed skylight coffers, fluted mezzanine pilasters,
  // brass pendant suspension stems, carved walnut balustrade cap, and richly dressed reception counter (Scene 06!).
  if (b.id === 'library') {
    const ix0 = b.rect.x0 + .16, ix1 = b.rect.x1 - .16;
    const iz0 = b.rect.z0 + .16, iz1 = b.rect.z1 - .16;
    const splitZ = iz0 + 4.0;
    const upperY = GROUND_Y + 2.6;
    const upperX0 = ix0 + 1.86;
    const hallSpanW = ix1 - ix0;
    // 6-truss dark-walnut coffered ceiling grid + 3 longitudinal purlins spanning the entire 2-storey hall & gallery.
    const trussCount = 6;
    const trussZs: number[] = [];
    for (let i = 0; i < trussCount; i++) {
      const tz = iz0 + 1.15 + ((iz1 - iz0 - 2.3) * i) / (trussCount - 1);
      trussZs.push(tz);
      intTrims.add(libraryWalnutM, hallSpanW - .08, .32, .22, bcx, roofY - .18, tz);
      // Wall corbel brackets supporting each ceiling beam.
      intTrims.add(libraryWalnutM, .34, .44, .20, ix0 + .17, roofY - .48, tz);
      intTrims.add(libraryWalnutM, .34, .44, .20, ix1 - .17, roofY - .48, tz);
    }
    intTrims.add(libraryWalnutM, .24, .24, iz1 - iz0 - .2, bcx, roofY - .14, bcz);
    const purlinOffX = hallSpanW * 0.27;
    intTrims.add(libraryWalnutM, .20, .22, iz1 - iz0 - .2, bcx - purlinOffX, roofY - .14, bcz);
    intTrims.add(libraryWalnutM, .20, .22, iz1 - iz0 - .2, bcx + purlinOffX, roofY - .14, bcz);

    // Warm recessed skylight / clerestory coffer panels nestled between trusses & longitudinal purlins (1 merged mesh!).
    const cofferGeos: T.BufferGeometry[] = [];
    const cofferW = purlinOffX - 0.62;
    for (let i = 0; i < trussZs.length - 1; i++) {
      const czMid = (trussZs[i] + trussZs[i + 1]) * 0.5;
      const cofferD = Math.max(0.75, (trussZs[i + 1] - trussZs[i]) - 0.50);
      for (const side of [-1, 1]) {
        const cxMid = bcx + side * (purlinOffX * 0.5);
        // Dark walnut recessed coffer rim in `intTrims`
        intTrims.add(libraryWalnutM, cofferW + 0.14, 0.08, 0.08, cxMid, roofY - 0.07, czMid - cofferD * 0.5);
        intTrims.add(libraryWalnutM, cofferW + 0.14, 0.08, 0.08, cxMid, roofY - 0.07, czMid + cofferD * 0.5);
        const panel = new T.PlaneGeometry(cofferW, cofferD);
        panel.rotateX(Math.PI / 2);
        panel.translate(cxMid, roofY - 0.052, czMid);
        cofferGeos.push(panel);
      }
    }
    const mergedCoffers = mergeGeometries(cofferGeos, false);
    for (const cg of cofferGeos) cg.dispose();
    if (mergedCoffers) {
      librarySkylightMat = new T.MeshStandardMaterial({
        color: '#fff8ea',
        roughness: 0.35,
        emissive: '#fff3da',
        emissiveIntensity: 0.55,
      });
      patchMaterialWithEchoCsm(librarySkylightMat);
      patchHeightFog(librarySkylightMat);
      const cofferMesh = new T.Mesh(mergedCoffers, librarySkylightMat);
      cofferMesh.name = 'library-skylight-coffers';
      interiorGroup.add(cofferMesh);
      owned.push(librarySkylightMat, mergedCoffers);
    }

    // Vertical brass suspension stems + ceiling rosettes connecting `roofY` to the 5 lowered `libCeilingPendant`s
    // (`pendantY = roofY - 1.70`, top at `roofY - 0.75`; merged into `intTrims` with 0 extra draw calls!).
    const libPendantAnchors: readonly [number, number][] = [
      [bcx - 3.6, iz1 - 6.6],
      [bcx, iz1 - 6.6],
      [bcx + 3.6, iz1 - 6.6],
      [bcx - 2.6, iz1 - 3.1],
      [bcx + 2.6, iz1 - 3.1],
    ];
    for (const [px, pz] of libPendantAnchors) {
      intTrims.add(libraryBrassM, .025, .78, .025, px, roofY - .39, pz);
      intTrims.add(libraryBrassM, .14, .03, .14, px, roofY - .04, pz);
    }

    // 5 fluted walnut pilasters parametrically centered in the gaps between the 4 gallery bookstacks
    // (fixes Pilaster 2 overlap with Bookcase 2 — centers cleanly at `ix0 + 8.77` ≈ `x = 105.71`!).
    const gallerySpan = ix1 - upperX0 - 1.2;
    const stackXs = [0, 1, 2, 3].map((i) => upperX0 + 1.35 + (gallerySpan - 1.5) * (i / 3));
    const pilasterXs = [
      upperX0 + 0.14,
      (stackXs[0] + stackXs[1]) * 0.5,
      (stackXs[1] + stackXs[2]) * 0.5,
      (stackXs[2] + stackXs[3]) * 0.5,
      ix1 - 0.14,
    ];
    const pilH = upperY + 1.0 - GROUND_Y;
    for (const px of pilasterXs) {
      intTrims.add(libraryWalnutM, .24, pilH, .24, px, GROUND_Y + pilH / 2, splitZ + .08);
      intTrims.add(libraryBrassM, .28, .08, .28, px, GROUND_Y + .18, splitZ + .08);
      intTrims.add(libraryBrassM, .28, .08, .28, px, upperY + .96, splitZ + .08);
    }
    // Carved walnut top cap rail running along the 2F mezzanine parapet overlooking the reading hall.
    const railW = ix1 - (ix0 + 1.7);
    intTrims.add(libraryWalnutM, railW, .09, .26, ix0 + 1.7 + railW / 2, upperY + 1.03, splitZ - .08);
    intTrims.add(libraryWalnutM, .24, .09, 4.2, ix0 + 1.78, upperY + .98, splitZ + 2.1);

    // Library reception counter (`library-desk` at bcx + 1.2, iz1 - 3.6): fluted walnut apron ribs, brass kickplate & countertop trim (0 extra draws!),
    // plus book return tray, hardcover book stacks, catalog terminal & ledger resting flush at GROUND_Y + 1.015 (1 merged mesh!).
    const deskCx = bcx + 1.2;
    const deskCz = iz1 - 3.6;
    const deskFrontZ = deskCz + 0.39;
    const deskTopY = GROUND_Y + 1.015;
    intTrims.add(libraryBrassM, 2.18, 0.09, 0.04, deskCx, GROUND_Y + 0.045, deskFrontZ);
    intTrims.add(libraryBrassM, 2.22, 0.032, 0.035, deskCx, GROUND_Y + 0.985, deskFrontZ + 0.01);
    for (let r = -4; r <= 4; r++) {
      intTrims.add(libraryWalnutM, 0.045, 0.80, 0.035, deskCx + r * 0.23, GROUND_Y + 0.52, deskFrontZ);
    }

    const deskClutter = new VertexColorBatch();
    // Book return tray + 2 angled hardcover returns (left end of counter)
    const trayX = deskCx - 0.78, trayZ = deskCz + 0.04;
    deskClutter.addBox('#5b3b24', 0.36, 0.022, 0.28, trayX, deskTopY + 0.011, trayZ);
    deskClutter.addBox('#4c301c', 0.36, 0.055, 0.018, trayX, deskTopY + 0.032, trayZ - 0.13);
    deskClutter.addBox('#4c301c', 0.018, 0.055, 0.28, trayX - 0.17, deskTopY + 0.032, trayZ);
    deskClutter.addBox('#4c301c', 0.018, 0.055, 0.28, trayX + 0.17, deskTopY + 0.032, trayZ);
    deskClutter.addBox('#2d523d', 0.24, 0.034, 0.17, trayX - 0.01, deskTopY + 0.039, trayZ + 0.01, 0.08);
    deskClutter.addBox('#f2e8d4', 0.22, 0.024, 0.15, trayX - 0.01, deskTopY + 0.039, trayZ + 0.015, 0.08);
    deskClutter.addBox('#7d3238', 0.22, 0.030, 0.16, trayX + 0.02, deskTopY + 0.071, trayZ - 0.01, -0.14);

    // Neat stack of 4 hardcover reference books + brass desk placard (left-center)
    const stackX = deskCx - 0.38, stackZ = deskCz + 0.08;
    const bookColors = ['#26425a', '#6f2e34', '#335942', '#b38b4d'];
    for (let k = 0; k < bookColors.length; k++) {
      const bwBook = 0.25 - k * 0.012;
      const bdBook = 0.18 - k * 0.008;
      const yaw = (k - 1.5) * 0.07;
      const by = deskTopY + 0.016 + k * 0.033;
      deskClutter.addBox(bookColors[k], bwBook, 0.032, bdBook, stackX, by, stackZ, yaw);
      deskClutter.addBox('#f3ead6', bwBook - 0.018, 0.022, bdBook - 0.016, stackX + 0.004, by, stackZ + 0.004, yaw);
    }
    // Small triangular brass counter sign
    deskClutter.addBox('#c59f58', 0.19, 0.055, 0.042, deskCx - 0.36, deskTopY + 0.028, deskCz + 0.26, 0.05);

    // Library catalog terminal (center): dark slate stand, slim display bezel, compact keyboard
    const termX = deskCx + 0.06, termZ = deskCz - 0.06;
    deskClutter.addBox('#2c323b', 0.18, 0.018, 0.15, termX, deskTopY + 0.009, termZ);
    deskClutter.addBox('#39414d', 0.052, 0.14, 0.032, termX, deskTopY + 0.082, termZ - 0.02);
    deskClutter.addBox('#242a33', 0.44, 0.28, 0.026, termX, deskTopY + 0.255, termZ + 0.01, 0, -0.10);
    deskClutter.addBox('#38404b', 0.34, 0.014, 0.12, termX, deskTopY + 0.007, termZ + 0.16);

    // Open checkout ledger + walnut pen cup (right-center beside glowing banker lamp)
    const ledX = deskCx + 0.44, ledZ = deskCz + 0.09;
    deskClutter.addBox('#593b25', 0.30, 0.016, 0.22, ledX, deskTopY + 0.008, ledZ, -0.06);
    deskClutter.addBox('#f7f0df', 0.135, 0.012, 0.195, ledX - 0.072, deskTopY + 0.020, ledZ, -0.06);
    deskClutter.addBox('#f5edd9', 0.135, 0.012, 0.195, ledX + 0.072, deskTopY + 0.020, ledZ, -0.06);
    deskClutter.addCylinder('#5a3b24', 0.036, 0.032, 0.095, 10, deskCx + 0.46, deskTopY + 0.048, deskCz - 0.12);
    deskClutter.addCylinder('#c69f58', 0.037, 0.037, 0.010, 10, deskCx + 0.46, deskTopY + 0.094, deskCz - 0.12);

    const deskClutterMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.14 });
    patchMaterialWithEchoCsm(deskClutterMat);
    patchHeightFog(deskClutterMat);
    owned.push(deskClutterMat);
    deskClutter.build(deskClutterMat, interiorGroup, false, 'library-counter-clutter', owned);

    // Subtle backlit catalog monitor display screen
    const screenGeo = new T.PlaneGeometry(0.40, 0.24);
    const screenMat = new T.MeshStandardMaterial({
      color: '#bfeaf0',
      roughness: 0.24,
      emissive: '#7cd4e0',
      emissiveIntensity: 0.48,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    patchMaterialWithEchoCsm(screenMat);
    patchHeightFog(screenMat);
    const screenMesh = new T.Mesh(screenGeo, screenMat);
    screenMesh.position.set(termX, deskTopY + 0.255, termZ + 0.026);
    screenMesh.rotation.x = -0.10;
    screenMesh.name = 'library-catalog-screen';
    interiorGroup.add(screenMesh);
    owned.push(screenGeo, screenMat);
  }

  // Optional 2-storey interior staircase (`library`, `furniture_shop`, 5 residences) with handrails merged into `intTrims`.
  if (b.stair) {
    const st = b.stair;
    const steps = st.steps;
    const run = (st.rect.z1 - st.rect.z0) / steps;
    const sw = st.rect.x1 - st.rect.x0, scx = (st.rect.x0 + st.rect.x1) / 2;
    const treadM = surfaces.timber('#a67e58', false, false), stringerM = surfaces.interiorWall('#e7ddd0');
    const railM = surfaces.timber('#79563c', true, false), postM = mat('metal', '#3d4148');
    patchMaterialWithEchoCsm(postM);
    patchHeightFog(postM);
    const heightAt = (z: number) => st.y0 + (z - st.rect.z0) / (st.rect.z1 - st.rect.z0) * (st.y1 - st.y0);
    for (let i = 0; i < steps; i++) {
      const z0 = st.rect.z0 + i * run;
      // Align each visual tread top with the exact midpoint of the analytical stair ramp (`walk.ts`).
      const top = st.y0 + ((i + 0.5) / steps) * (st.y1 - st.y0);
      const h = Math.max(.06, top - GROUND_Y);
      intFloors.add(stringerM, sw, Math.max(.02, h - .035), run, scx, GROUND_Y + Math.max(.02, h - .035) / 2, z0 + run / 2);
      intFloors.add(treadM, sw + .02, .035, run + .02, scx, top - .0175, z0 + run / 2);
      solid(sw, h, run, scx, GROUND_Y + h / 2, z0 + run / 2);
    }
    const rail = (x: number) => {
      const y0 = st.y0, y1 = st.y1;
      const dir = new T.Vector3(0, y1 - y0, st.rect.z1 - st.rect.z0);
      const g = new T.CylinderGeometry(.024, .024, dir.length(), 10);
      const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), dir.normalize());
      g.applyMatrix4(new T.Matrix4().compose(new T.Vector3(x, (y0 + y1) / 2 + .9, (st.rect.z0 + st.rect.z1) / 2), q, new T.Vector3(1, 1, 1)));
      intTrims.addGeometry(railM, g);
    };
    rail(st.rect.x0 + .06);
    rail(st.rect.x1 - .06);
    for (let k = 0; k <= 4; k++) {
      const z = st.rect.z0 + (st.rect.z1 - st.rect.z0) * (k / 4), y = heightAt(z);
      intTrims.add(postM, .03, .9, .03, st.rect.x1 - .06, y + .45, z);
    }
  }

  const extWallMeshes = extWalls.build(group, extShadows, 'city-bld-wall');
  const intWallMeshes = intWalls.build(interiorGroup, false, 'city-bld-wall');
  const extFloorMeshes = extFloors.build(group, extShadows, 'city-bld-floor');
  const intFloorMeshes = intFloors.build(interiorGroup, false, 'city-bld-floor');
  const extTrimSingle = extTrimVc.build(extTrimSharedM, group, extShadows, 'city-bld-trim');
  const extTrimMeshes = extTrimSingle ? [extTrimSingle] : [];
  intTrims.build(interiorGroup, false, 'city-bld-trim');
  const wallMeshes = [...extWallMeshes, ...intWallMeshes];
  const floorMeshes = [...extFloorMeshes, ...intFloorMeshes];
  const shadowCasters: T.Object3D[] = [...extWallMeshes, ...extFloorMeshes, ...extTrimMeshes];
  for (const m of [...wallMeshes, ...floorMeshes, ...extTrimMeshes]) m.receiveShadow = true;

  // Real physical swinging entrance door (`city:<id>`). Mark door nodes dynamic so `freezeStaticHierarchy` keeps swings live!
  const doorParts: DoorPart[] = [];
  const door = createLifeDoor(b.door, group, owned, doorParts);
  for (const dp of doorParts) {
    dp.frame.userData.dynamic = true;
    dp.pivot.userData.dynamic = true;
    dp.lever.userData.dynamic = true;
    dp.distantLeaf.userData.dynamic = true;
  }

  // Elevated warm ceiling fixtures (G-08): raised clear of character head height & soft 0.92 warm emissive so ZERO bloom orb appears on hair!
  const fixtures: BuildingBuild['fixtures'] = [];
  const lampSpecs: { x: number; y: number; z: number; discY: number; showDisc: boolean }[] = b.fixtures.map(f => ({
    x: f.x,
    y: Math.max(f.y, GROUND_Y + 3.0),
    z: f.z,
    discY: roofY - .04,
    showDisc: b.id !== 'library',
  }));
  if (b.id === 'library') {
    const iz1 = b.rect.z1 - .16;
    // Match the lowered suspended brass pendant chandeliers at `roofY - 1.70` so warm 3200K pools illuminate tables cleanly.
    const pendantLightY = roofY - 1.45;
    lampSpecs.push(
      { x: bcx - 3.4, y: pendantLightY, z: iz1 - 6.6, discY: roofY - .05, showDisc: false },
      { x: bcx + 3.4, y: pendantLightY, z: iz1 - 6.6, discY: roofY - .05, showDisc: false },
      { x: bcx, y: pendantLightY, z: iz1 - 3.2, discY: roofY - .05, showDisc: false },
    );
  } else if (b.storeys >= 2) {
    const frontZ = b.facing === 'north' ? b.rect.z0 + 2.8 : b.rect.z1 - 2.8;
    const midZ = b.facing === 'north' ? b.rect.z0 + Math.min(bd * 0.56, 6.2) : b.rect.z1 - Math.min(bd * 0.56, 6.2);
    const groundLightY = Math.min(roofY - .35, GROUND_Y + 3.12);
    lampSpecs.push(
      { x: bcx - bw * 0.16, y: groundLightY, z: frontZ, discY: groundLightY + .16, showDisc: true },
      { x: bcx + bw * 0.16, y: groundLightY, z: midZ, discY: groundLightY + .16, showDisc: true },
    );
  }
  const discSpecs = lampSpecs.filter((s) => s.showDisc);
  for (const f of lampSpecs) {
    fixtures.push({ at: new T.Vector3(f.x, f.y, f.z), room: b.id, warm: true });
  }
  if (discSpecs.length) {
    const disc = new T.CylinderGeometry(.16, .16, .025, 16); owned.push(disc);
    const glow = mat('glow', '#ffe8c2', '0.92');
    patchMaterialWithEchoCsm(glow);
    patchHeightFog(glow);
    const inst = new T.InstancedMesh(disc, glow, discSpecs.length);
    const m4 = new T.Matrix4();
    discSpecs.forEach((f, i) => {
      inst.setMatrixAt(i, m4.makeTranslation(f.x, f.discY, f.z));
    });
    inst.instanceMatrix.needsUpdate = true; inst.computeBoundingSphere();
    interiorGroup.add(inst);
    owned.push(inst);
  }

  // Modular street architecture (Batch 3 aaa-v2): scalloped striped awnings, exterior HVAC boxes, café bistro sets & menu chalkboards!
  let disposed = false;
  const exteriorProps: AaaPropPlacement[] = [];
  const ix0 = b.rect.x0 + .16, ix1 = b.rect.x1 - .16;
  const iz0 = b.rect.z0 + .16, iz1 = b.rect.z1 - .16;
  const doorX = b.door.x;
  const awningRotY = b.facing === 'north' ? Math.PI : 0;
  const awningZ = frontFaceZ + frontOut * .45;

  if (AWNING_SHOP_BUILDINGS.has(b.id)) {
    const leftW = (doorX - 1.1) - (ix0 + .5);
    const rightW = (ix1 - .5) - (doorX + 1.1);
    if (leftW >= 1.6) {
      const lx = (ix0 + .5 + doorX - 1.1) / 2;
      const sx = Math.min(1.45, Math.max(.75, (leftW + .35) / 2.66));
      exteriorProps.push({
        id: 'awningStriped',
        x: lx, y: GROUND_Y + 2.18, z: awningZ, rotY: awningRotY,
        scale: [sx, .92, .95], castShadow: true,
      });
    }
    if (rightW >= 1.6) {
      const rx = (doorX + 1.1 + ix1 - .5) / 2;
      const sx = Math.min(1.45, Math.max(.75, (rightW + .35) / 2.66));
      exteriorProps.push({
        id: 'awningStriped',
        x: rx, y: GROUND_Y + 2.18, z: awningZ, rotY: awningRotY,
        scale: [sx, .92, .95], castShadow: true,
      });
    }
    if (CAFE_PATIO_BUILDINGS.has(b.id)) {
      // Narrower matching canopy crowning the entrance door on café/bistro/atelier.
      exteriorProps.push({
        id: 'awningStriped',
        x: doorX, y: GROUND_Y + 2.22, z: awningZ, rotY: awningRotY,
        scale: [.78, .88, .92], castShadow: true,
      });
    }
  }

  if (CAFE_PATIO_BUILDINGS.has(b.id)) {
    // Tucked Parisian sidewalk bistro sets parallel to the storefront (projects <= 0.88 m, leaving > 2.1 m clear promenade).
    const patioZ = frontFaceZ + frontOut * .54;
    const leftPatioX = ix0 + 2.15;
    const rightPatioX = ix1 - 2.15;
    if (doorX - leftPatioX >= 2.4) {
      exteriorProps.push({
        id: 'cafeBistroSet',
        x: leftPatioX, y: GROUND_Y, z: patioZ, rotY: Math.PI / 2,
        scale: .92, castShadow: true,
      });
    }
    if (rightPatioX - doorX >= 2.4) {
      exteriorProps.push({
        id: 'cafeBistroSet',
        x: rightPatioX, y: GROUND_Y, z: patioZ, rotY: Math.PI / 2,
        scale: .92, castShadow: true,
      });
    }
  }

  if (currentTier !== 'low' && CHALKBOARD_BUILDINGS.has(b.id)) {
    const boardZ = frontFaceZ + frontOut * .52;
    const boardX = doorX + 1.38;
    if (boardX < ix1 - .6) {
      exteriorProps.push({
        id: 'chalkboard',
        x: boardX, y: GROUND_Y, z: boardZ,
        rotY: (b.facing === 'north' ? Math.PI : 0) + (b.facing === 'north' ? .26 : -.26),
        scale: .92, castShadow: false,
      });
    }
  }

  if (currentTier !== 'low' && AIRCON_BUILDINGS.has(b.id)) {
    const acZ = b.facing === 'north' ? b.rect.z1 - 1.35 : b.rect.z0 + 1.35;
    exteriorProps.push({
      id: 'airconUnit',
      x: b.rect.x1 + .14, y: GROUND_Y + 2.28, z: acZ, rotY: Math.PI / 2,
      scale: .84, castShadow: false,
    });
  }

  const exteriorPropsGroup = new T.Group();
  exteriorPropsGroup.name = 'building-exterior-props';
  exteriorPropsGroup.visible = false;
  group.add(exteriorPropsGroup);

  const exteriorReady: Promise<void> = exteriorProps.length
    ? (async () => {
        await mountAaaPropPlacements(
          exteriorProps,
          exteriorPropsGroup,
          owned,
          acquiredStreetProps,
          () => disposed,
          () => extShadows,
          shadowCasters,
        );
        if (disposed) return;
        if (exteriorPropsGroup.children.length > 0) {
          freezeStaticHierarchy(exteriorPropsGroup);
          getEchoLifeTextureUploadQueue().enqueueFromObject(exteriorPropsGroup, LoadPriority.P1_PREFETCH);
          const prewarm = opts.prewarmObject ?? activeBuildingPrewarmHook;
          if (prewarm) {
            try {
              await prewarm(exteriorPropsGroup);
            } catch {
              /* isolate prewarm context errors so exterior props still mount safely */
            }
            if (disposed) return;
          }
        }
        exteriorPropsGroup.visible = true;
      })()
    : Promise.resolve();
  group.userData.exteriorReady = exteriorReady;

  // Curated interior furniture loaded with ref-counted tracking & cross-asset material batching (slashes Library draws!).
  const contents = new T.Group();
  interiorGroup.add(contents);
  let furnished = false;
  let furnishGen = 0;
  const acquired: LifeAsset[] = [];
  const interiorStreetProps: StreetPropKey[] = [];
  const interiorOwned: { dispose(): void }[] = [];
  const mirrors: BuildingMirrorDescriptor[] = [];
  const mirrorCleanups: (() => void)[] = [];
  for (const f of b.furniture) if (f.footprint) {
    const w = f.footprint.x1 - f.footprint.x0, d = f.footprint.z1 - f.footprint.z0;
    const h = f.asset === 'tv-console' ? TV_CONSOLE_TOP_Y : .8;
    solid(w, h, d, (f.footprint.x0 + f.footprint.x1) / 2, f.y + h / 2, (f.footprint.z0 + f.footprint.z1) / 2);
  }

  // Build rich AAA interior prop placements (University Library full transformation + warm café/shop accents).
  const interiorAaaProps: AaaPropPlacement[] = [];
  if (b.id === 'library') {
    const splitZ = iz0 + 4.0;
    const upperY = GROUND_Y + 2.6;
    const upperX0 = ix0 + 1.86;
    const upperZ1 = splitZ - .16;
    const upperCx = (upperX0 + ix1) / 2;

    // 1. 11 tall book-filled walnut bookstacks (under-mezzanine grand gallery + east/west alcoves + 2F archive).
    const gallerySpan = ix1 - upperX0 - 1.2;
    const galleryStacks = 4;
    for (let i = 0; i < galleryStacks; i++) {
      const sx = upperX0 + 1.35 + (gallerySpan - 1.5) * (i / (galleryStacks - 1));
      interiorAaaProps.push({
        id: 'libBookstackTall',
        x: sx, y: GROUND_Y, z: splitZ + .38, rotY: 0, scale: [1.0, .95, .95],
      });
    }
    // East wall bookstacks flanking side window ([bcz - 1.6, bcz + 1.6]).
    interiorAaaProps.push(
      { id: 'libBookstackTall', x: ix1 - .38, y: GROUND_Y, z: iz1 - 1.55, rotY: Math.PI / 2, scale: [1.0, .98, .95] },
      { id: 'libBookstackTall', x: ix1 - .38, y: GROUND_Y, z: iz1 - 4.15, rotY: Math.PI / 2, scale: [1.0, .98, .95] },
      { id: 'libBookstackTall', x: ix1 - .38, y: GROUND_Y, z: splitZ + 1.45, rotY: Math.PI / 2, scale: [1.0, .98, .95] },
    );
    // West wall bookstack south of staircase & side window.
    interiorAaaProps.push(
      { id: 'libBookstackTall', x: ix0 + .38, y: GROUND_Y, z: iz1 - 1.65, rotY: Math.PI / 2, scale: [1.0, .98, .95] },
    );
    // 2F Mezzanine archive bookstacks (zero overlap with existing stacks at upperX0+2.0 & ix1-2.2).
    interiorAaaProps.push(
      { id: 'libBookstackTall', x: upperCx, y: upperY, z: iz0 + .38, rotY: 0, scale: [1.04, .98, .95] },
      { id: 'libBookstackTall', x: ix1 - .38, y: upperY, z: (iz0 + upperZ1) / 2, rotY: Math.PI / 2, scale: [1.0, .98, .95] },
      { id: 'libBookstackTall', x: ix0 + .92, y: upperY, z: iz0 + .38, rotY: 0, scale: [.78, .98, .9] },
    );

    // 2. 13 oak reading chairs arranged neatly around Reading Tables A & B, Checkout Desk, and 2F Mezzanine Table.
    const tableAX = ix1 - 2.8, tableBX = ix0 + 5.0, tableZ = iz1 - 6.8;
    for (const tx of [tableAX, tableBX]) {
      for (const ox of [-.52, .52]) {
        interiorAaaProps.push(
          { id: 'libReadingChair', x: tx + ox, y: GROUND_Y, z: tableZ - .76, rotY: 0 },
          { id: 'libReadingChair', x: tx + ox, y: GROUND_Y, z: tableZ + .76, rotY: Math.PI },
        );
      }
    }
    interiorAaaProps.push({ id: 'libReadingChair', x: bcx + 1.2, y: GROUND_Y, z: iz1 - 4.35, rotY: 0 });
    const upTableZ = upperZ1 - 1.2;
    for (const ox of [-.52, .52]) {
      interiorAaaProps.push(
        { id: 'libReadingChair', x: upperCx + ox, y: upperY, z: upTableZ - .72, rotY: 0 },
        { id: 'libReadingChair', x: upperCx + ox, y: upperY, z: upTableZ + .68, rotY: Math.PI },
      );
    }

    // 3. 7 emerald-glass banker lamps illuminating the oak reading tables, catalog desk, and 2F archive desk.
    const deskTopY = GROUND_Y + .76;
    interiorAaaProps.push(
      { id: 'libBankerLamp', x: tableAX - .52, y: deskTopY, z: tableZ, rotY: Math.PI * .25 },
      { id: 'libBankerLamp', x: tableAX + .52, y: deskTopY, z: tableZ, rotY: -Math.PI * .75 },
      { id: 'libBankerLamp', x: tableBX - .52, y: deskTopY, z: tableZ, rotY: Math.PI * .25 },
      { id: 'libBankerLamp', x: tableBX + .52, y: deskTopY, z: tableZ, rotY: -Math.PI * .75 },
      { id: 'libBankerLamp', x: bcx + 1.92, y: GROUND_Y + 1.015, z: iz1 - 3.55, rotY: -Math.PI * .35 },
      { id: 'libBankerLamp', x: upperCx - .52, y: upperY + .76, z: upTableZ, rotY: Math.PI * .2 },
      { id: 'libBankerLamp', x: upperCx + .52, y: upperY + .76, z: upTableZ, rotY: -Math.PI * .8 },
    );

    // 4. 2 warm woven area rugs grounding the Grand Reading Hall & SW Cozy Reading Lounge.
    interiorAaaProps.push(
      { id: 'libRugWoven', x: (tableAX + tableBX) / 2, y: GROUND_Y + .012, z: tableZ, rotY: 0, scale: [3.35, 1, 2.05] },
      { id: 'libRugWoven', x: ix0 + 2.9, y: GROUND_Y + .012, z: iz1 - 2.6, rotY: 0, scale: [1.35, 1, 1.15] },
    );

    // 5. 2 cozy leather/fabric reading armchairs in the SW lounge nook (clear of bench, stair & entrance).
    interiorAaaProps.push(
      { id: 'libArmchair', x: ix0 + 1.55, y: GROUND_Y, z: iz1 - 4.05, rotY: Math.PI * .24 },
      { id: 'libArmchair', x: ix0 + 4.45, y: GROUND_Y, z: iz1 - 1.55, rotY: -Math.PI * .78 },
    );

    // 6. 4 lush indoor potted Ficus plants framing the entrance, stair landing, and 2F gallery.
    interiorAaaProps.push(
      { id: 'libPottedPlant', x: doorX - 1.48, y: GROUND_Y, z: iz1 - .68, rotY: .4 },
      { id: 'libPottedPlant', x: doorX + 1.48, y: GROUND_Y, z: iz1 - .68, rotY: -.5 },
      { id: 'libPottedPlant', x: ix0 + 2.42, y: GROUND_Y, z: splitZ + 3.85, rotY: 1.1 },
      { id: 'libPottedPlant', x: ix1 - .78, y: upperY, z: upperZ1 - .78, rotY: 2.2 },
    );

    // 7. 5 suspended brass & opal ceiling pendants hung from the coffered ceiling via brass stems (`roofY - 1.70`).
    const pendantY = roofY - 1.70;
    interiorAaaProps.push(
      { id: 'libCeilingPendant', x: bcx - 3.6, y: pendantY, z: iz1 - 6.6, rotY: 0 },
      { id: 'libCeilingPendant', x: bcx, y: pendantY, z: iz1 - 6.6, rotY: 0 },
      { id: 'libCeilingPendant', x: bcx + 3.6, y: pendantY, z: iz1 - 6.6, rotY: 0 },
      { id: 'libCeilingPendant', x: bcx - 2.6, y: pendantY, z: iz1 - 3.1, rotY: 0 },
      { id: 'libCeilingPendant', x: bcx + 2.6, y: pendantY, z: iz1 - 3.1, rotY: 0 },
    );
  } else if (b.id === 'cafe') {
    // Warm lived-in Pixel Café lounge interior (P1-VIS-6): central woven rug, 3 bistro table-and-chair groups,
    // cozy reading armchairs, manga/book nook on rear center pier, 4 potted Ficus plants, and 4 ceiling pendants!
    interiorAaaProps.push(
      { id: 'libRugWoven', x: bcx - .2, y: GROUND_Y + .012, z: iz0 + 4.9, rotY: 0, scale: [2.15, 1, 1.75] },
      { id: 'cafeBistroSet', x: bcx - 1.9, y: GROUND_Y, z: iz0 + 4.5, rotY: Math.PI / 2, scale: .94 },
      { id: 'cafeBistroSet', x: bcx + .55, y: GROUND_Y, z: iz0 + 5.1, rotY: 0, scale: .94 },
      { id: 'cafeBistroSet', x: ix1 - 2.25, y: GROUND_Y, z: iz0 + 2.25, rotY: Math.PI / 2, scale: .92 },
      { id: 'libArmchair', x: ix0 + 1.65, y: GROUND_Y, z: iz0 + 1.85, rotY: Math.PI * .22 },
      { id: 'libArmchair', x: ix0 + 3.25, y: GROUND_Y, z: iz0 + 1.65, rotY: -Math.PI * .18 },
      { id: 'libBookstackTall', x: bcx, y: GROUND_Y, z: iz1 - .38, rotY: Math.PI, scale: [.88, .92, .90] },
      { id: 'libPottedPlant', x: ix0 + .75, y: GROUND_Y, z: iz0 + .78, rotY: .5, scale: .90 },
      { id: 'libPottedPlant', x: ix1 - .75, y: GROUND_Y, z: iz0 + .78, rotY: -.8, scale: .90 },
      { id: 'libPottedPlant', x: bcx - 1.35, y: GROUND_Y, z: iz1 - .72, rotY: 1.4, scale: .86 },
      { id: 'libPottedPlant', x: ix1 - .75, y: GROUND_Y, z: iz1 - .78, rotY: -1.2, scale: .88 },
      { id: 'libCeilingPendant', x: bcx - 2.3, y: roofY - .95, z: iz0 + 3.4, rotY: 0, scale: .88 },
      { id: 'libCeilingPendant', x: bcx + 2.3, y: roofY - .95, z: iz0 + 3.4, rotY: 0, scale: .88 },
      { id: 'libCeilingPendant', x: bcx - 2.3, y: roofY - .95, z: iz1 - 3.2, rotY: 0, scale: .88 },
      { id: 'libCeilingPendant', x: bcx + 2.3, y: roofY - .95, z: iz1 - 3.2, rotY: 0, scale: .88 },
    );
  } else if (b.id === 'bistro' || b.id === 'atelier') {
    const backZ = b.facing === 'north' ? iz1 - .78 : iz0 + .78;
    const frontInZ = b.facing === 'north' ? iz0 + .78 : iz1 - .78;
    interiorAaaProps.push(
      { id: 'libPottedPlant', x: ix0 + .75, y: GROUND_Y, z: frontInZ, rotY: .5, scale: .88 },
      { id: 'libPottedPlant', x: ix1 - .75, y: GROUND_Y, z: backZ, rotY: -1.2, scale: .88 },
      { id: 'libCeilingPendant', x: bcx - 2.1, y: roofY - .95, z: bcz, rotY: 0, scale: .88 },
      { id: 'libCeilingPendant', x: bcx + 2.1, y: roofY - .95, z: bcz, rotY: 0, scale: .88 },
    );
    if (b.id === 'bistro') {
      interiorAaaProps.push({ id: 'libRugWoven', x: bcx, y: GROUND_Y + .012, z: iz0 + 4.0, rotY: 0, scale: [1.45, 1, 1.05] });
    }
  } else if (b.id === 'furniture_shop' || b.id === 'clothing_shop') {
    interiorAaaProps.push(
      { id: 'libPottedPlant', x: ix0 + .82, y: GROUND_Y, z: b.facing === 'north' ? iz0 + .82 : iz1 - .82, rotY: .3, scale: .92 },
      { id: 'libRugWoven', x: bcx, y: GROUND_Y + .012, z: b.facing === 'north' ? iz0 + 4.3 : iz0 + 4.6, rotY: 0, scale: [1.6, 1, 1.2] },
    );
  } else if (b.id === 'linh' || b.id === 'minh') {
    interiorAaaProps.push(
      { id: 'libRugWoven', x: bcx, y: GROUND_Y + .012, z: iz0 + 3.4, rotY: 0, scale: [1.25, 1, 1.05] },
    );
  }

  // 4-State Predictive InteriorStreamer:
  //   UNLOADED -> PREFETCHING (<= 36 m on foot or velocity-predicted <= 40 m; suppressed above 4.2 m/s) -> RESIDENT_ACTIVE <-> CACHED_VISITED
  // Eviction back to UNLOADED occurs ONLY through `EchoLifeResidencyManager` after >= 45 s idle under VRAM
  // pressure AND strictly while `getInFlightCompileCount() === 0` (eliminates doorway thrashing & compile races!).
  const residencyKey = `interior:${b.property?.id ?? b.id}`;
  let interiorState: InteriorResidencyState = 'UNLOADED';
  let residencyAcquired = false;
  let deferredEvictPending = false;
  let lastDistSq = Infinity;
  let lastShowInterior = false;

  const clearMirrors = () => {
    while (mirrorCleanups.length > 0) {
      const fn = mirrorCleanups.pop();
      try {
        fn?.();
      } catch {
        /* ignore mirror cleanup errors */
      }
    }
    mirrors.length = 0;
  };

  const unfurnish = (force = false) => {
    if (interiorState === 'UNLOADED') return;
    if (!force && getInFlightCompileCount() > 0) {
      deferredEvictPending = true;
      return;
    }
    deferredEvictPending = false;
    interiorState = 'UNLOADED';
    furnished = false;
    furnishGen++;
    clearMirrors();
    if (residencyAcquired) {
      residencyAcquired = false;
      getEchoLifeResidencyManager().release(residencyKey);
    }
    getEchoLifeResidencyManager().unregister(residencyKey);
    contents.visible = false;
    contents.traverse(o => {
      if (o instanceof T.InstancedMesh || (typeof T.BatchedMesh === 'function' && o instanceof T.BatchedMesh)) {
        o.dispose();
      }
    });
    while (contents.children.length > 0) contents.remove(contents.children[contents.children.length - 1]);
    for (const o of interiorOwned) o.dispose();
    interiorOwned.length = 0;
    for (const k of acquired) releaseLifeAsset(k);
    acquired.length = 0;
    for (const k of interiorStreetProps) releaseStreetProp(k);
    interiorStreetProps.length = 0;
  };

  const furnish = async () => {
    if (interiorState !== 'UNLOADED' || disposed) return;
    interiorState = 'PREFETCHING';
    furnished = true;
    deferredEvictPending = false;
    const gen = ++furnishGen;

    await runSerializedInteriorFurnish(async () => {
      if (disposed || gen !== furnishGen) return;

      const consoleItems = b.furniture.filter(f => f.asset === 'tv-console');
      const kinds = [...new Set(b.furniture.filter(f => f.asset !== 'tv-console').map(f => f.asset))] as LifeAsset[];
      for (const k of kinds) acquired.push(k);
      const [loaded] = await Promise.all([
        Promise.all(kinds.map(k => acquireLifeAsset(k))),
        mountAaaPropPlacements(
          interiorAaaProps,
          contents,
          interiorOwned,
          interiorStreetProps,
          () => disposed || gen !== furnishGen,
          () => false,
        ),
      ]);
      if (disposed || gen !== furnishGen) return;

      // Batch any procedural `tv-console` furnishings into ONE vertex-colored lowboard mesh (`0` GLB fetches, `1` draw).
      if (consoleItems.length > 0) {
        const consoleVc = new VertexColorBatch();
        for (const f of consoleItems) {
          const dSpan = f.footprint
            ? (Math.abs(Math.sin(f.rotY)) > 0.7 ? f.footprint.x1 - f.footprint.x0 : f.footprint.z1 - f.footprint.z0)
            : 0.44;
          for (const part of buildTvConsoleParts({
            x: f.x,
            y: f.y,
            z: f.z,
            rotY: f.rotY,
            width: f.size,
            depth: dSpan,
            height: TV_CONSOLE_TOP_Y,
          })) {
            consoleVc.addBox(part.colorHex, part.w, part.h, part.d, part.x, part.y, part.z, part.rotY);
          }
        }
        const consoleMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.12 });
        patchMaterialWithEchoCsm(consoleMat);
        patchHeightFog(consoleMat);
        interiorOwned.push(consoleMat);
        consoleVc.build(consoleMat, contents, false, 'city-bld-tv-console', interiorOwned);
      }

      const slicer = new EchoLifeTimeSlicer(3.5);
      const entries: { kind: LifeAsset; prepared: Prepared; matrices: T.Matrix4[] }[] = [];
      let mirrorIdx = 0;
      const mirrorHook = opts.onMirrorFound ?? activeBuildingMirrorHook;
      for (let i = 0; i < kinds.length; i++) {
        if (disposed || gen !== furnishGen) return;
        const kind = kinds[i];
        const p = loaded[i];
        if (!p) continue;
        const size = p.box.getSize(new T.Vector3());
        const matrices = b.furniture
          .filter(f => f.asset === kind)
          .map(f => placeOn(p, f.x, f.y, f.z, f.rotY, f.size / Math.max(size.x, size.z, 1e-3)));

        const keptParts = p.parts.filter(part => {
          if (!isMirrorGlassPart(kind, part)) return true;
          if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
          const lBox = part.geometry.boundingBox ?? new T.Box3(new T.Vector3(-0.37, 0, -0.01), new T.Vector3(0.37, 0.9, 0.01));
          const lSize = lBox.getSize(new T.Vector3());
          const lCenter = lBox.getCenter(new T.Vector3());
          const scaleVec = new T.Vector3();
          for (const mtx of matrices) {
            scaleVec.setFromMatrixScale(mtx);
            const width = Math.max(0.05, lSize.x * Math.abs(scaleVec.x));
            const height = Math.max(0.05, lSize.y * Math.abs(scaleVec.y));
            const center = new T.Vector3(lCenter.x, lCenter.y, lBox.max.z).applyMatrix4(mtx);
            const normal = new T.Vector3(0, 0, 1).transformDirection(mtx).normalize();
            const desc: BuildingMirrorDescriptor = {
              id: `mirror:${b.property?.id ?? b.id}:${kind}:${mirrorIdx++}`,
              buildingId: b.id,
              kind,
              geometry: part.geometry,
              worldMatrix: mtx.clone(),
              center,
              normal,
              width,
              height,
              size: new T.Vector2(width, height),
            };
            mirrors.push(desc);
            if (mirrorHook) {
              const cleanup = mirrorHook(desc);
              if (typeof cleanup === 'function') mirrorCleanups.push(cleanup);
            }
          }
          return false;
        });

        if (keptParts.length > 0) {
          entries.push({
            kind,
            prepared: keptParts.length === p.parts.length ? p : { ...p, parts: keptParts },
            matrices,
          });
        }
        if (i + 1 < kinds.length) await slicer.yieldIfNeeded();
      }
      if (disposed || gen !== furnishGen) return;
      batchStaticFurnishings(entries, contents, interiorOwned);
      freezeStaticHierarchy(contents);

      // P5-Perf #1: Enqueue all interior textures via `TextureUploadQueue` and await off-stage
      // RT-matched shader compilation (`prewarmObject`) BEFORE transitioning to `RESIDENT_ACTIVE` / revealing `contents`!
      getEchoLifeTextureUploadQueue().enqueueFromObject(contents, LoadPriority.P1_PREFETCH);
      const prewarm = opts.prewarmObject ?? activeBuildingPrewarmHook;
      if (prewarm) {
        try {
          await prewarm(contents);
        } catch {
          /* isolate prewarm cancellation/context errors so interior still mounts safely */
        }
        if (disposed || gen !== furnishGen) return;
      }

      const residency = getEchoLifeResidencyManager();
      const stillActive = lastShowInterior || lastDistSq <= ACTIVE_RETENTION_DIST * ACTIVE_RETENTION_DIST;
      interiorState = stillActive ? 'RESIDENT_ACTIVE' : 'CACHED_VISITED';
      residency.register({
        key: residencyKey,
        category: 'interior',
        estimatedBytes: Math.max(65_536, estimateObjectGpuBytes(contents)),
        minRetentionSec: 45,
        dispose: () => {
          if (!disposed && interiorState === 'CACHED_VISITED') {
            unfurnish(false);
          }
        },
      });
      if (stillActive) {
        residencyAcquired = true;
        residency.acquire(residencyKey);
      }
      contents.visible = lastShowInterior;
    });
  };

  // Start hidden until player enters, opens entrance door, or walks close to the storefront glass!
  interiorGroup.visible = false;
  contents.visible = false;
  // Freeze all static building exterior & interior matrices while keeping swinging door nodes live!
  freezeStaticHierarchy(group);
  const tmpEye = new T.Vector3();
  let prevBodyX = Number.NaN;
  let prevBodyZ = Number.NaN;
  let velX = 0;
  let velZ = 0;

  return {
    id: b.id,
    building: b,
    group,
    door,
    solids,
    fixtures,
    mirrors,
    exteriorReady,
    blockers: [...wallMeshes, ...floorMeshes],
    getInteriorState() {
      return interiorState;
    },
    setNight(night) {
      glassHandle.setNight(night);
      signMat.emissiveIntensity = .16 + night * .56;
      if (librarySkylightMat) {
        librarySkylightMat.emissiveIntensity = 0.55 - night * 0.17;
        librarySkylightMat.emissive.set(night > 0.5 ? '#ffe3b3' : '#fff3da');
      }
      if (cafeMenuMat) {
        cafeMenuMat.emissiveIntensity = 0.52 + night * 0.26;
      }
    },
    setQuality(nextTier) {
      currentTier = nextTier;
      extShadows = nextTier === 'high' || nextTier === 'ultra';
      for (const m of shadowCasters) m.castShadow = extShadows;
    },
    setCameraPos(pos) {
      if (group.visible) glassHandle.setCameraPos(pos);
    },
    update(dt, reduced, body) {
      stepDoorParts(doorParts, dt, reduced, body);
      if (group.visible) {
        const bodyY = (body as { y?: number }).y ?? GROUND_Y;
        tmpEye.set(body.x, bodyY + 1.6, body.z);
        glassHandle.setCameraPos(tmpEye);
      }

      // Smoothed horizontal velocity for 2.5 s predictive doorway/approach prefetch (ignores > 6 m teleports).
      if (Number.isFinite(prevBodyX) && dt > 1e-4 && dt < 0.5) {
        const stepX = body.x - prevBodyX;
        const stepZ = body.z - prevBodyZ;
        if (stepX * stepX + stepZ * stepZ < 36) {
          const alpha = Math.min(1, dt * 6);
          velX += (stepX / dt - velX) * alpha;
          velZ += (stepZ / dt - velZ) * alpha;
        } else {
          velX = 0;
          velZ = 0;
        }
      }
      prevBodyX = body.x;
      prevBodyZ = body.z;

      const dx = Math.max(b.rect.x0 - body.x, 0, body.x - b.rect.x1);
      const dz = Math.max(b.rect.z0 - body.z, 0, body.z - b.rect.z1);
      const distanceSq = dx * dx + dz * dz;
      lastDistSq = distanceSq;

      const speed = Math.hypot(velX, velZ);
      const fastTransit = speed > FAST_TRANSIT_SPEED_M_S;
      const horizon = !fastTransit && speed > 0.2 ? Math.min(2.5, 14 / speed) : 0;
      const predX = body.x + velX * horizon;
      const predZ = body.z + velZ * horizon;
      const pdx = Math.max(b.rect.x0 - predX, 0, predX - b.rect.x1);
      const pdz = Math.max(b.rect.z0 - predZ, 0, predZ - b.rect.z1);
      const predDistSq = pdx * pdx + pdz * pdz;

      // Strict enclosure culling: show interior when inside, looking through an open doorway (<= 14 m),
      // or peering through storefront windows (extended to 9.5 m on High/Ultra so cafes & library interiors shine through glass!).
      const inside = dx <= 0.25 && dz <= 0.25;
      const doorOpen = door.isOpen || Math.abs(door.angle) > 0.02;
      const openRange = interiorGroup.visible ? 14 * 14 : 12 * 12;
      const peekNear = currentTier === 'high' || currentTier === 'ultra' ? 9.5 : 5.2;
      const peekEnter = currentTier === 'high' || currentTier === 'ultra' ? 8.2 : 4.2;
      const windowPeekRange = interiorGroup.visible ? peekNear * peekNear : peekEnter * peekEnter;
      const showInterior = inside || (doorOpen && distanceSq <= openRange) || distanceSq <= windowPeekRange;
      lastShowInterior = showInterior;

      // Retry deferred residency eviction once in-flight shader compilation completes.
      if (deferredEvictPending && interiorState === 'CACHED_VISITED' && getInFlightCompileCount() === 0) {
        unfurnish(false);
      }

      // 4-state predictive residency transitions:
      // - Widen on-foot approach prefetch to 36 m (and velocity-predicted 40 m).
      // - Suppress predictive/roadside storefront prefetch when cycling/driving past (`speed > 4.2 m/s`) unless entering or door is open.
      const wantResident =
        inside ||
        (doorOpen && distanceSq <= ON_FOOT_PREFETCH_DIST * ON_FOOT_PREFETCH_DIST) ||
        (!fastTransit &&
          (showInterior ||
            distanceSq <= ON_FOOT_PREFETCH_DIST * ON_FOOT_PREFETCH_DIST ||
            predDistSq <= PREDICTED_PREFETCH_DIST * PREDICTED_PREFETCH_DIST));

      if (interiorState === 'UNLOADED' && wantResident) {
        deferredEvictPending = false;
        void furnish();
      } else if (interiorState === 'CACHED_VISITED' && (wantResident || showInterior)) {
        deferredEvictPending = false;
        interiorState = 'RESIDENT_ACTIVE';
        if (!residencyAcquired) {
          residencyAcquired = true;
          getEchoLifeResidencyManager().acquire(residencyKey);
        }
      } else if (
        interiorState === 'RESIDENT_ACTIVE' &&
        !showInterior &&
        distanceSq > ACTIVE_RETENTION_DIST * ACTIVE_RETENTION_DIST &&
        (fastTransit || predDistSq > ACTIVE_RETENTION_DIST * ACTIVE_RETENTION_DIST)
      ) {
        interiorState = 'CACHED_VISITED';
        if (residencyAcquired) {
          residencyAcquired = false;
          getEchoLifeResidencyManager().release(residencyKey);
        }
      }

      interiorGroup.visible = showInterior;
      contents.visible = showInterior && (interiorState === 'RESIDENT_ACTIVE' || interiorState === 'CACHED_VISITED');
    },
    dispose() {
      disposed = true;
      deferredEvictPending = false;
      unfurnish(true);
      for (const k of acquiredStreetProps) releaseStreetProp(k);
      acquiredStreetProps.length = 0;
      owned.forEach(o => o.dispose());
      group.traverse(o => {
        const m = o as T.Mesh;
        if (m.isMesh && (m.name === 'city-bld-wall' || m.name === 'city-bld-floor' || m.name === 'city-bld-trim')) {
          m.geometry.dispose();
        }
      });
      group.removeFromParent();
    },
  };
}
