import {zones} from '../v3/game-core/index.mjs';
import type {V3OwnedObject} from '../v3/game-core/index.mjs';
import {getObjectFootprint,orientedBounds,validatePlacement} from '../v3/progression/placement.mjs';
import type {EnterableBuilding} from '../buildings';
import type {Rect} from '../plan';
import type {EchoLifeGame} from './session';
import type {LifeWalk} from '../walk';
import type {WorkshopAction} from './saver';

const UPPER_RESIDENCE_ZONES = new Set(['bedroom', 'bath', 'balcony']);
const GROUND_RESIDENCE_ZONES = new Set(['living', 'kitchen', 'study', 'gaming_room']);

export const DEFAULT_BUILD_GRID_SIZE = 0.25;

export const STARTER_FURNITURE_IDS = [
  'obj_starter_sofa',
  'obj_starter_stove',
  'obj_starter_fridge',
  'obj_starter_bed',
  'obj_starter_wardrobe',
] as const;

export type StarterFurnitureId = (typeof STARTER_FURNITURE_IDS)[number];

export interface StarterFurnitureOverride {
  id: string;
  x: number;
  y?: number;
  z: number;
  rotY: number;
  zone?: string;
}

export interface BuildFootprint {
  width: number;
  depth: number;
}

export interface BuildPlacementBox {
  id?: string;
  x: number;
  z: number;
  halfW: number;
  halfD: number;
}

export interface BuildPlacementValidation {
  ok: boolean;
  reason: string;
  x: number;
  z: number;
}

export interface RoomStyleLayoutPreset {
  readonly id: 'minimalist_studio' | 'warm_oak_library' | 'botanical_loft' | 'midnight_creator';
  readonly name: string;
  readonly tagline: string;
  readonly styleId: 'minimalist' | 'cozy' | 'classic_european' | 'modern';
  readonly finishId: 'nordic_birch' | 'natural_oak' | 'emerald_velvet' | 'matte_graphite';
  readonly accentHex: string;
  readonly recommendedZones: readonly string[];
  readonly starterLayout: Readonly<Record<string, { dx: number; dz: number; rotY: number }>>;
}

/** 4 curated 1-click Room Style and Layout Presets mapped to real V3 room styles and material finishes. */
export type RoomStylePreset = RoomStyleLayoutPreset;

export const ROOM_STYLE_PRESETS: readonly RoomStyleLayoutPreset[] = [
  {
    id: 'minimalist_studio',
    name: 'Minimalist Studio',
    tagline: 'Bright birch surfaces, open circulation, and crisp daylight lines.',
    styleId: 'minimalist',
    finishId: 'nordic_birch',
    accentHex: '#d8d2c7',
    recommendedZones: ['study', 'living', 'bedroom'],
    starterLayout: {
      obj_starter_sofa: { dx: 0, dz: 0.25, rotY: 0 },
      obj_starter_bed: { dx: -0.25, dz: 0, rotY: Math.PI / 2 },
      obj_starter_wardrobe: { dx: 0.25, dz: -0.25, rotY: 0 },
    },
  },
  {
    id: 'warm_oak_library',
    name: 'Warm Oak Library',
    tagline: 'Honey oak warmth, quiet study corners, and inviting amber comfort.',
    styleId: 'cozy',
    finishId: 'natural_oak',
    accentHex: '#b98952',
    recommendedZones: ['study', 'living', 'kitchen'],
    starterLayout: {
      obj_starter_sofa: { dx: -0.25, dz: 0, rotY: 0.25 },
      obj_starter_bed: { dx: 0, dz: 0.25, rotY: 0 },
      obj_starter_wardrobe: { dx: -0.25, dz: 0, rotY: Math.PI },
    },
  },
  {
    id: 'botanical_loft',
    name: 'Botanical Loft',
    tagline: 'Emerald velvet textures paired with sunlit garden tones and calm flow.',
    styleId: 'classic_european',
    finishId: 'emerald_velvet',
    accentHex: '#3f765a',
    recommendedZones: ['living', 'balcony', 'bedroom'],
    starterLayout: {
      obj_starter_sofa: { dx: 0.25, dz: 0, rotY: -0.25 },
      obj_starter_bed: { dx: 0.25, dz: -0.25, rotY: 0 },
      obj_starter_wardrobe: { dx: 0, dz: 0.25, rotY: Math.PI / 2 },
    },
  },
  {
    id: 'midnight_creator',
    name: 'Midnight Creator',
    tagline: 'Matte graphite focus studio built for late-night streams and custom rigs.',
    styleId: 'modern',
    finishId: 'matte_graphite',
    accentHex: '#334155',
    recommendedZones: ['study', 'gaming_room', 'living'],
    starterLayout: {
      obj_starter_sofa: { dx: 0, dz: -0.25, rotY: Math.PI },
      obj_starter_bed: { dx: -0.25, dz: 0.25, rotY: -Math.PI / 2 },
      obj_starter_wardrobe: { dx: 0.25, dz: 0, rotY: Math.PI },
    },
  },
] as const;

export function getRoomStylePreset(presetId: string): RoomStyleLayoutPreset | null {
  return ROOM_STYLE_PRESETS.find(p => p.id === presetId) ?? null;
}

/** Snaps world or room-local coordinates cleanly to the build placement grid (default 0.25 m). */
export function snapToBuildGrid(x: number, z: number, gridSize = DEFAULT_BUILD_GRID_SIZE): { x: number; z: number } {
  const safeX = Number.isFinite(x) ? x : 0;
  const safeZ = Number.isFinite(z) ? z : 0;
  const g = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : DEFAULT_BUILD_GRID_SIZE;
  const rx = Math.round(safeX / g) * g;
  const rz = Math.round(safeZ / g) * g;
  return {
    x: Math.round(rx * 10000) / 10000,
    z: Math.round(rz * 10000) / 10000,
  };
}

/**
 * Validates snapped furniture placement against room wall bounds, doorways, walkable floor (when `walk` is supplied),
 * and existing furniture footprints. Works in both world space (with `walk`) and zone-local space (without `walk`).
 */
export function validateBuildPlacement(
  zoneId: string,
  x: number,
  z: number,
  rotY: number,
  footprint: BuildFootprint,
  opts: {
    walk?: LifeWalk | null;
    propertyId?: string | null;
    gridSize?: number;
    wallMargin?: number;
    ignoreId?: string;
    existingBoxes?: readonly BuildPlacementBox[];
  } = {},
): BuildPlacementValidation {
  const grid = opts.gridSize ?? DEFAULT_BUILD_GRID_SIZE;
  const snapped = grid > 0 ? snapToBuildGrid(x, z, grid) : { x, z };
  const safeRotY = Number.isFinite(rotY) ? rotY : 0;
  const w = Math.max(0.15, Number.isFinite(footprint.width) ? footprint.width : 0.6);
  const d = Math.max(0.15, Number.isFinite(footprint.depth) ? footprint.depth : 0.6);
  const { halfW, halfD } = orientedBounds(w, d, safeRotY);
  const margin = Math.max(0, Number.isFinite(opts.wallMargin ?? 0.08) ? (opts.wallMargin ?? 0.08) : 0.08);

  if (!zoneId || !Object.hasOwn(zones, zoneId)) {
    return { ok: false, reason: 'Choose a valid room inside your home.', x: snapped.x, z: snapped.z };
  }

  if (opts.walk) {
    const walk = opts.walk;
    const rect = roomRect(walk, zoneId, opts.propertyId ?? undefined);
    if (!rect) {
      return { ok: false, reason: 'This room is not available for placement.', x: snapped.x, z: snapped.z };
    }
    if (
      snapped.x - halfW < rect.x0 + margin ||
      snapped.x + halfW > rect.x1 - margin ||
      snapped.z - halfD < rect.z0 + margin ||
      snapped.z + halfD > rect.z1 - margin
    ) {
      return { ok: false, reason: 'Placement clips into a wall or outside room bounds.', x: snapped.x, z: snapped.z };
    }
    const propId = opts.propertyId && opts.propertyId !== 'prop_student_flat' ? opts.propertyId : undefined;
    const res = residenceRoom(walk, propId, zoneId);
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const pt = { x: snapped.x + ix * halfW, z: snapped.z + iz * halfD };
        if (res) {
          const ps = walk.surface(pt);
          if (!ps || ps.region !== propId || Math.abs(ps.y - res.y) > 0.35 || !walk.free(pt)) {
            return { ok: false, reason: 'Blocked by stairs, fixtures, or floor boundaries.', x: snapped.x, z: snapped.z };
          }
          if (Math.hypot(res.home.door.x - pt.x, res.home.door.z - pt.z) < 0.9) {
            return { ok: false, reason: 'Leave clearance in front of the entrance door.', x: snapped.x, z: snapped.z };
          }
        } else {
          if (walk.zone(pt) !== zoneId || !walk.free(pt)) {
            return { ok: false, reason: 'Leave clear floor space inside the room.', x: snapped.x, z: snapped.z };
          }
          if (walk.house.doors.some(door => Math.hypot(door.x - pt.x, door.z - pt.z) < 0.85)) {
            return { ok: false, reason: 'Leave clearance around doorways.', x: snapped.x, z: snapped.z };
          }
        }
      }
    }
  } else {
    const area = zones[zoneId];
    const halfRoomW = (area.size || 6) * 0.5;
    const halfRoomD = (area.depth || area.size || 6) * 0.5;
    if (
      Math.abs(snapped.x) + halfW > halfRoomW - margin ||
      Math.abs(snapped.z) + halfD > halfRoomD - margin
    ) {
      return { ok: false, reason: 'Placement extends past the room walls.', x: snapped.x, z: snapped.z };
    }
  }

  for (const box of opts.existingBoxes ?? []) {
    if (opts.ignoreId && box.id === opts.ignoreId) continue;
    const overlapX = Math.abs(snapped.x - box.x) < halfW + box.halfW - 0.02;
    const overlapZ = Math.abs(snapped.z - box.z) < halfD + box.halfD - 0.02;
    if (overlapX && overlapZ) {
      return { ok: false, reason: 'Overlaps another piece of furniture.', x: snapped.x, z: snapped.z };
    }
  }

  return { ok: true, reason: 'Placement ready.', x: snapped.x, z: snapped.z };
}

/** Relocates a starter home furnishing with grid snapping and bounds validation, stored inside `lifeMeta`. */
export function setStarterFurnitureOverride(
  game: EchoLifeGame,
  id: string,
  pos: { x: number; y?: number; z: number },
  rotY: number,
  opts: { zone?: string; walk?: LifeWalk | null; footprint?: BuildFootprint } = {},
): { ok: boolean; reason: string; override: StarterFurnitureOverride | null } {
  if (!STARTER_FURNITURE_IDS.includes(id as StarterFurnitureId)) {
    return { ok: false, reason: 'Only starter home furnishings can use starter relocation.', override: null };
  }
  const snapped = snapToBuildGrid(pos.x, pos.z, DEFAULT_BUILD_GRID_SIZE);
  const safeRotY = Number.isFinite(rotY) ? Math.round(rotY * 1000) / 1000 : 0;
  const obj = game.s.progression.ownedObjects.find(o => o.instanceId === id);
  const zone = opts.zone ?? obj?.location.zoneId ?? undefined;
  const fp = opts.footprint ?? (obj ? getObjectFootprint(obj) : { width: 1.0, depth: 0.7 });

  if (zone && Object.hasOwn(zones, zone)) {
    const check = validateBuildPlacement(zone, snapped.x, snapped.z, safeRotY, fp, {
      walk: opts.walk ?? null,
      propertyId: game.s.progression.properties.activePropertyId,
      ignoreId: id,
    });
    if (!check.ok) {
      return { ok: false, reason: check.reason, override: null };
    }
  }

  const entry: StarterFurnitureOverride = {
    id,
    x: snapped.x,
    ...(typeof pos.y === 'number' && Number.isFinite(pos.y) ? { y: Math.round(pos.y * 1000) / 1000 } : {}),
    z: snapped.z,
    rotY: safeRotY,
    ...(zone ? { zone } : {}),
  };
  game.setStarterFurnitureOverride(id, entry);
  return { ok: true, reason: 'Starter furnishing position saved.', override: entry };
}

export function getStarterFurnitureOverrides(game: EchoLifeGame): Readonly<Record<string, StarterFurnitureOverride>> {
  return game.getStarterFurnitureOverrides();
}

export function clearStarterFurnitureOverride(game: EchoLifeGame, id: string): boolean {
  return game.clearStarterFurnitureOverride(id);
}

/** Builds server-valid `apply_room_style` and `customize_material` workshop actions for a 1-click preset. */
export function buildPresetWorkshopActions(game: EchoLifeGame, presetId: string): WorkshopAction[] {
  const preset = getRoomStylePreset(presetId);
  if (!preset) return [];
  const actions: WorkshopAction[] = [];
  const roomStyles = game.s.progression.roomStyles as Record<string, string>;
  for (const zone of preset.recommendedZones) {
    if (roomStyles[zone] !== preset.styleId) {
      actions.push({ type: 'apply_room_style', zoneId: zone, styleId: preset.styleId });
    }
  }
  for (const obj of game.s.progression.ownedObjects) {
    if (obj.category.startsWith('vehicle') || obj.location.inStorage) continue;
    const currentFinish = (obj.customAppearance as { finishId?: string } | undefined)?.finishId;
    if (currentFinish !== preset.finishId) {
      actions.push({ type: 'customize_material', instanceId: obj.instanceId, finishId: preset.finishId });
      if (actions.length >= 6) break;
    }
  }
  return actions;
}

function residenceRoom(walk: LifeWalk, propertyId: string | undefined, zone: string): { rect: Rect; y: number; home: EnterableBuilding } | null {
  if (!propertyId || propertyId === 'prop_student_flat') return null;
  const home = walk.city.residences.find(b => b.property?.id === propertyId);
  if (!home) return null;
  if (UPPER_RESIDENCE_ZONES.has(zone)) {
    const upper = home.zones.find(z => z.id.endsWith(':upper'));
    return upper ? { rect: upper.rect, y: upper.y, home } : null;
  }
  if (GROUND_RESIDENCE_ZONES.has(zone)) {
    const main = home.zones.find(z => z.id.endsWith(':main'));
    if (!main) return null;
    const hall = home.zones.find(z => z.id.endsWith(':hall'));
    const rect: Rect = hall
      ? {
          x0: Math.min(main.rect.x0, hall.rect.x0),
          x1: Math.max(main.rect.x1, hall.rect.x1),
          z0: Math.min(main.rect.z0, hall.rect.z0),
          z1: Math.max(main.rect.z1, hall.rect.z1),
        }
      : main.rect;
    return { rect, y: main.y, home };
  }
  return null;
}

export function roomRect(walk: LifeWalk, zone: string, propertyId?: string | null) {
  const res = residenceRoom(walk, propertyId ?? undefined, zone);
  if (res) return res.rect;
  if (zone === 'study') { const h = walk.house.h; return { x0: -h, x1: h, z0: -h, z1: h }; }
  if (zone === 'yard') return walk.city.ground.find(g => g.zone === 'yard')?.rect;
  return walk.house.zones.find(r => r.id === zone)?.rect;
}

export function worldPlacement(walk: LifeWalk, obj: V3OwnedObject) {
  const zone = obj.location.zoneId;
  if (!zone || obj.location.inStorage) return null;
  const propId = typeof obj.location.propertyId === 'string' ? obj.location.propertyId : undefined;
  const res = residenceRoom(walk, propId, zone);
  const rect = res?.rect ?? roomRect(walk, zone), area = zones[zone];
  if (!rect || !area) return null;
  const x = (rect.x0 + rect.x1) / 2 + obj.placement.x * (rect.x1 - rect.x0) / area.size;
  const z = (rect.z0 + rect.z1) / 2 + obj.placement.z * (rect.z1 - rect.z0) / (area.depth || area.size);
  return { x, z, y: walk.groundAt(x, z) ?? res?.y ?? 0, yaw: obj.placement.yaw };
}

export function aimPlacement(
  game: EchoLifeGame,
  walk: LifeWalk,
  id: string,
  player: { x: number; z: number },
  heading: number,
  yaw: number,
  gridSize = DEFAULT_BUILD_GRID_SIZE,
) {
  const rawX = player.x - Math.sin(heading) * 1.55;
  const rawZ = player.z - Math.cos(heading) * 1.55;
  const { x, z } = gridSize > 0 ? snapToBuildGrid(rawX, rawZ, gridSize) : { x: rawX, z: rawZ };
  const surf = walk.surface({ x, z });
  const at = { x, z, y: surf?.y ?? walk.groundAt(x, z) ?? 0, yaw };
  const obj = game.s.progression.ownedObjects.find(o => o.instanceId === id);
  if (!obj || !surf) return { at, reason: 'Choose a room in your home.', action: null };

  // Market Boulevard purchasable residence placement (ground floor -> living, upper gallery -> bedroom)
  if (surf.region.startsWith('prop_')) {
    const activeProp = game.s.progression.properties.activePropertyId;
    if (activeProp !== surf.region) {
      return { at, reason: 'Set this residence as your active home in Build Properties first.', action: null };
    }
    const zone = surf.y >= 1.2 ? 'bedroom' : 'living';
    const res = residenceRoom(walk, surf.region, zone);
    const area = zones[zone];
    if (!res || !area) return { at, reason: 'Move onto the main floor or upper gallery to place.', action: null };
    const footprint = getObjectFootprint(obj);
    const boundsCheck = validateBuildPlacement(zone, x, z, yaw, footprint, {
      walk,
      propertyId: surf.region,
      gridSize: 0,
      ignoreId: id,
    });
    if (!boundsCheck.ok) {
      return { at, reason: boundsCheck.reason, action: null };
    }
    const localX = (x - (res.rect.x0 + res.rect.x1) / 2) * area.size / (res.rect.x1 - res.rect.x0);
    const localZ = (z - (res.rect.z0 + res.rect.z1) / 2) * (area.depth || area.size) / (res.rect.z1 - res.rect.z0);
    const fit = validatePlacement(game.s, id, zone, localX, localZ, yaw);
    const action: WorkshopAction = { type: 'place_object', instanceId: id, zoneId: zone, x: localX, z: localZ, yaw };
    return { at, reason: fit.reason ?? '', action: fit.ok ? action : null };
  }

  const zone = walk.zone({ x, z }) ?? '', rect = roomRect(walk, zone), area = zones[zone];
  if (!rect || !area) return { at, reason: 'Choose a room in your home.', action: null };
  const footprint = getObjectFootprint(obj);
  const boundsCheck = validateBuildPlacement(zone, x, z, yaw, footprint, {
    walk,
    gridSize: 0,
    ignoreId: id,
  });
  if (!boundsCheck.ok) {
    return { at, reason: boundsCheck.reason, action: null };
  }
  const localX = (x - (rect.x0 + rect.x1) / 2) * area.size / (rect.x1 - rect.x0);
  const localZ = (z - (rect.z0 + rect.z1) / 2) * (area.depth || area.size) / (rect.z1 - rect.z0);
  const fit = validatePlacement(game.s, id, zone, localX, localZ, yaw);
  const action: WorkshopAction = { type: 'place_object', instanceId: id, zoneId: zone, x: localX, z: localZ, yaw };
  return { at, reason: fit.reason ?? '', action: fit.ok ? action : null };
}
