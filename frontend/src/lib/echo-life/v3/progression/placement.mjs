import { zones, spawnAt } from '../world-data/world.mjs';
import { getModelFootprint, getProperty, MATERIAL_FINISHES } from './catalog.mjs';
import { awardSkillXp, unlockAchievement } from './skills.mjs';

export const BUILDABLE_ZONES = new Set(['study', 'living', 'kitchen', 'bedroom', 'bath', 'yard', 'gaming_room', 'garage', 'balcony']);
const DOOR_CLEARANCE = 1.35;

export function getObjectFootprint(obj) {
  if (!obj) return { width: 0.8, depth: 0.8 };
  if (obj.category === 'electronics_pc') {
    const deskId = obj.installedComponents?.desk || 'desk_trestle_student';
    return getModelFootprint(deskId, 1.2, 0.72);
  }
  return getModelFootprint(obj.selectedVariantId, 0.9, 0.7);
}

export function orientedBounds(width, depth, yaw = 0) {
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
  return { halfW: (width * c + depth * s) * 0.5, halfD: (width * s + depth * c) * 0.5 };
}

export function getPlacedObjectsInZone(state, zoneId) {
  const list = state.progression?.ownedObjects || [];
  return list.filter(o => !o.location.inStorage && o.location.zoneId === zoneId && o.ownershipStatus !== 'retired');
}

function isZoneUnlocked(state, zoneId) {
  const activePropId = state.progression?.properties?.activePropertyId || 'prop_student_flat';
  const prop = getProperty(activePropId);
  return prop ? prop.unlockedRooms.includes(zoneId) : true;
}

function pointBlocked(zoneId, x, z, r, staticProps, extraBoxes) {
  const area = zones[zoneId];
  if (!area) return true;
  const maxX = area.size * 0.5 - r, maxZ = (area.depth || area.size) * 0.5 - r;
  if (Math.abs(x) > maxX || Math.abs(z) > maxZ) return true;
  for (const p of staticProps) {
    if (p.width > 0 && p.depth > 0 && Math.abs(x - p.x) < p.width * 0.5 + r && Math.abs(z - p.z) < p.depth * 0.5 + r) return true;
  }
  for (const b of extraBoxes) {
    if (Math.abs(x - b.x) < b.halfW + r && Math.abs(z - b.z) < b.halfD + r) return true;
  }
  return false;
}

function doorsStayConnected(zoneId, staticProps, extraBoxes) {
  const area = zones[zoneId];
  if (!area || area.doors.length < 1) return true;
  const spawns = area.doors.map(d => spawnAt(d));
  for (const sp of spawns) {
    if (pointBlocked(zoneId, sp.x, sp.z, 0.28, staticProps, extraBoxes)) return false;
  }
  if (spawns.length < 2) return true;
  const step = 0.5;
  const key = (a, b) => a + ',' + b;
  const start = [Math.round(spawns[0].x / step), Math.round(spawns[0].z / step)];
  const visited = new Set([key(...start)]);
  const queue = [start];
  while (queue.length) {
    const [gx, gz] = queue.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = gx + dx, nz = gz + dz, k = key(nx, nz);
      if (visited.has(k)) continue;
      if (!pointBlocked(zoneId, nx * step, nz * step, 0.24, staticProps, extraBoxes)) {
        visited.add(k);
        queue.push([nx, nz]);
      }
    }
  }
  for (let i = 1; i < spawns.length; i++) {
    const tx = Math.round(spawns[i].x / step), tz = Math.round(spawns[i].z / step);
    const reachable = [...visited].some(k => {
      const [gx, gz] = k.split(',').map(Number);
      return Math.hypot(gx * step - spawns[i].x, gz * step - spawns[i].z) < 0.75;
    });
    if (!reachable && !visited.has(key(tx, tz))) return false;
  }
  return true;
}

export function validatePlacement(state, instanceId, zoneId, x, z, yaw = 0) {
  if (!BUILDABLE_ZONES.has(zoneId) || !zones[zoneId]) {
    return { ok: false, reason: `Cannot place furniture in ${zoneId}.` };
  }
  if (!isZoneUnlocked(state, zoneId)) {
    return { ok: false, reason: `Unlock a larger property to build in ${zones[zoneId].label}.` };
  }
  const obj = state.progression?.ownedObjects?.find(o => o.instanceId === instanceId);
  if (!obj) return { ok: false, reason: 'Owned object not found.' };
  if (obj.category === 'vehicle_display' && zoneId !== 'garage' && zoneId !== 'yard') {
    return { ok: false, reason: 'Automobiles can only be displayed in the Personal Garage or Home Garden.' };
  }

  const area = zones[zoneId];
  const { width, depth } = getObjectFootprint(obj);
  const { halfW, halfD } = orientedBounds(width, depth, yaw);
  const limX = area.size * 0.5 - halfW - 0.16;
  const limZ = (area.depth || area.size) * 0.5 - halfD - 0.16;
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > limX || Math.abs(z) > limZ) {
    return { ok: false, reason: 'Object extends outside room walls.' };
  }

  // Doorway & approach lane clearance protection (never block doors or inward entry corridor)
  for (const d of area.doors) {
    const sp = spawnAt(d);
    const nearDoor = Math.hypot(x - d.x, z - d.z) < DOOR_CLEARANCE + Math.max(halfW, halfD) * 0.5;
    const nearSpawn = Math.abs(x - sp.x) < halfW + 0.65 && Math.abs(z - sp.z) < halfD + 0.65;
    const inLane = (d.side === 'N' || d.side === 'S')
      ? (Math.abs(x - d.x) < halfW + 0.85 && Math.abs(z - d.z) < halfD + 2.15)
      : (Math.abs(z - d.z) < halfD + 0.85 && Math.abs(x - d.x) < halfW + 2.15);
    if (nearDoor || nearSpawn || inLane) {
      return { ok: false, reason: `Too close to doorway (${zones[d.to]?.label || d.to}). Keep doors and entry lanes clear.` };
    }
  }

  // Ignore static props superseded by owned starter core props
  const supersededIds = new Set(
    getPlacedObjectsInZone(state, zoneId)
      .map(o => o.interactionState?.lockedCoreProp)
      .filter(Boolean)
  );
  const staticProps = area.props.filter(p => p.width > 0 && p.depth > 0 && !supersededIds.has(p.id));

  for (const p of staticProps) {
    if (Math.abs(x - p.x) < p.width * 0.5 + halfW + 0.08 && Math.abs(z - p.z) < p.depth * 0.5 + halfD + 0.08) {
      return { ok: false, reason: `Collides with existing room fixture (${p.id}).` };
    }
  }

  const others = getPlacedObjectsInZone(state, zoneId).filter(o => o.instanceId !== instanceId);
  const extraBoxes = [];
  for (const o of others) {
    const f = getObjectFootprint(o);
    const b = orientedBounds(f.width, f.depth, o.placement.yaw || 0);
    if (Math.abs(x - o.placement.x) < b.halfW + halfW + 0.08 && Math.abs(z - o.placement.z) < b.halfD + halfD + 0.08) {
      return { ok: false, reason: `Overlaps with another placed object (${o.selectedVariantId}).` };
    }
    extraBoxes.push({ x: o.placement.x, z: o.placement.z, halfW: b.halfW, halfD: b.halfD });
  }
  extraBoxes.push({ x, z, halfW, halfD });

  if (!doorsStayConnected(zoneId, staticProps, extraBoxes)) {
    return { ok: false, reason: 'Placement would block essential room navigation between doors.' };
  }

  return { ok: true, footprint: { width, depth, halfW, halfD } };
}

export function findOpenPlacementSpot(state, instanceId, zoneId) {
  const area = zones[zoneId];
  if (!area) return null;
  const candidates = [];
  // Prefer tidy wall-aligned interior positions first
  const half = area.size * 0.5 - 1.1;
  for (let z = -half; z <= half; z += 0.6) {
    for (let x = -half; x <= half; x += 0.6) {
      candidates.push([Number(x.toFixed(2)), Number(z.toFixed(2))]);
    }
  }
  // Sort by aesthetic proximity to back/side walls while keeping center open; prefer rotatable spots first
  candidates.sort((a, b) => Math.abs(a[1] + half * 0.7) + Math.abs(a[0]) * 0.3 - (Math.abs(b[1] + half * 0.7) + Math.abs(b[0]) * 0.3));
  for (const [x, z] of candidates) {
    if (validatePlacement(state, instanceId, zoneId, x, z, 0).ok && validatePlacement(state, instanceId, zoneId, x, z, Math.PI / 2).ok) {
      return { x, z, yaw: 0 };
    }
  }
  for (const [x, z] of candidates) {
    if (validatePlacement(state, instanceId, zoneId, x, z, 0).ok) return { x, z, yaw: 0 };
  }
  return null;
}

function pushUndo(state, entry) {
  const prog = state.progression;
  prog.undoStack = [...(prog.undoStack || []).slice(-29), entry];
  prog.redoStack = [];
}

function snapshotObjPlacement(obj) {
  return {
    location: structuredClone(obj.location),
    placement: structuredClone(obj.placement),
    ownershipStatus: obj.ownershipStatus,
    customAppearance: structuredClone(obj.customAppearance),
  };
}

export function placeOrMoveObject(state, obj, zoneId, x, z, yaw = 0, recordUndo = true) {
  const check = validatePlacement(state, obj.instanceId, zoneId, x, z, yaw);
  if (!check.ok) return { ok: false, msg: check.reason };
  const before = snapshotObjPlacement(obj);
  obj.location = {
    propertyId: state.progression.properties.activePropertyId,
    zoneId,
    inStorage: false,
  };
  obj.placement = { x: Number(x.toFixed(3)), y: 0, z: Number(z.toFixed(3)), yaw: Number(yaw.toFixed(4)) };
  obj.ownershipStatus = 'placed';
  obj.revision = (obj.revision || 1) + 1;
  state.saveRevision = (state.saveRevision || 0) + 1;

  if (recordUndo) {
    pushUndo(state, { type: 'placement', instanceId: obj.instanceId, before, after: snapshotObjPlacement(obj) });
  }
  awardSkillXp(state, 'diy_design', 12);
  if (obj.category === 'furniture') unlockAchievement(state, 'interior_stylist');
  return { ok: true, msg: `Placed in ${zones[zoneId].label}.` };
}

export function rotatePlacedObject(state, obj, deltaRadians = Math.PI / 2) {
  if (obj.location.inStorage || !obj.location.zoneId) return { ok: false, msg: 'Place this object before rotating it.' };
  const nextYaw = ((obj.placement.yaw || 0) + deltaRadians) % (Math.PI * 2);
  return placeOrMoveObject(state, obj, obj.location.zoneId, obj.placement.x, obj.placement.z, nextYaw, true);
}

export function storePlacedObject(state, obj, recordUndo = true) {
  if (obj.interactionState?.lockedCoreProp) {
    return { ok: false, msg: 'Core room essentials can be upgraded or restyled, not removed into storage.' };
  }
  const before = snapshotObjPlacement(obj);
  obj.location = { propertyId: state.progression.properties.activePropertyId, zoneId: null, inStorage: true };
  obj.ownershipStatus = 'stored';
  obj.revision = (obj.revision || 1) + 1;
  state.saveRevision = (state.saveRevision || 0) + 1;
  if (recordUndo) {
    pushUndo(state, { type: 'placement', instanceId: obj.instanceId, before, after: snapshotObjPlacement(obj) });
  }
  return { ok: true, msg: 'Object stored in your inventory.' };
}

export function customizeObjectFinish(state, obj, finishId, recordUndo = true) {
  const finish = MATERIAL_FINISHES[finishId];
  if (!finish) return { ok: false, msg: `Unknown material finish: ${finishId}` };
  const before = snapshotObjPlacement(obj);
  obj.customAppearance = {
    ...(obj.customAppearance || {}),
    finishId: finish.id,
    primaryColor: finish.primaryColor,
    accentColor: finish.accentColor,
  };
  obj.revision = (obj.revision || 1) + 1;
  state.saveRevision = (state.saveRevision || 0) + 1;
  if (recordUndo) {
    pushUndo(state, { type: 'appearance', instanceId: obj.instanceId, before, after: snapshotObjPlacement(obj) });
  }
  awardSkillXp(state, 'diy_design', 14);
  return { ok: true, msg: `Applied ${finish.name} finish.` };
}

export function undoBuild(state, actorOwner) {
  const prog = state.progression;
  if (!prog.undoStack?.length) return { ok: false, msg: 'Nothing to undo.' };
  const entry = prog.undoStack.pop();
  const obj = prog.ownedObjects.find(o => o.instanceId === entry.instanceId);
  if (!obj || obj.ownerAccountId !== actorOwner) return { ok: false, msg: 'Cannot undo action.' };
  Object.assign(obj, structuredClone(entry.before));
  obj.revision = (obj.revision || 1) + 1;
  state.saveRevision = (state.saveRevision || 0) + 1;
  prog.redoStack = [...(prog.redoStack || []).slice(-29), entry];
  return { ok: true, msg: 'Undid last build action.' };
}

export function redoBuild(state, actorOwner) {
  const prog = state.progression;
  if (!prog.redoStack?.length) return { ok: false, msg: 'Nothing to redo.' };
  const entry = prog.redoStack.pop();
  const obj = prog.ownedObjects.find(o => o.instanceId === entry.instanceId);
  if (!obj || obj.ownerAccountId !== actorOwner) return { ok: false, msg: 'Cannot redo action.' };
  Object.assign(obj, structuredClone(entry.after));
  obj.revision = (obj.revision || 1) + 1;
  state.saveRevision = (state.saveRevision || 0) + 1;
  prog.undoStack = [...(prog.undoStack || []).slice(-29), entry];
  return { ok: true, msg: 'Redid build action.' };
}
