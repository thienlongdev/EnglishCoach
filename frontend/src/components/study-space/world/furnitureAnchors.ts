import * as T from 'three';
import type { SpaceObject } from '@/lib/study-space/types';
import { CATALOG_BY_ID, type CatalogAnchor } from '@/lib/study-space/catalog';
import {
  MIN_SEAT_UPRIGHT_DOT,
  computeSeatUpDot,
  extractHorizontalForwardYaw,
} from '@/lib/study-space/seatValidation';

// Asset-local contact surfaces, measured from the Blender generator and fallback
// builders. The duvet is above the mattress; its upper surface supports the body.
const BEDS: Record<string, { mattress: number; cover: number; pillow: [number, number, number]; width: number; depth: number }> = {
  'bed.single': { mattress: 0.52, cover: 0.614, pillow: [0, 0.6475, -0.64], width: 1.15, depth: 2.05 },
  'bed.drawer': { mattress: 0.58, cover: 0.674, pillow: [0, 0.7075, -0.64], width: 1.25, depth: 2.1 },
};

const BACKED_SEAT_APPROACH_RADII = [0.62, 0.74, 0.86] as const;
const BACKED_SEAT_APPROACH_ANGLES = [
  0,
  0.42,
  -0.42,
  0.85,
  -0.85,
  Math.PI * 0.5,
  -Math.PI * 0.5,
] as const;

const OPEN_SEAT_APPROACH_ANGLES = [
  ...BACKED_SEAT_APPROACH_ANGLES,
  2.2,
  -2.2,
  Math.PI,
] as const;

export interface BedContact {
  pillow: T.Vector3;
  surface: number;
  width: number;
  depth: number;
}

export interface ResolvedFurnitureAnchor {
  pos: T.Vector3;
  rotY: number;
  top: number;
  armrest?: number;
  slotIndex: number;
  approaches: T.Vector3[] | undefined;
  bed: BedContact | undefined;
}

const TMP_WORLD_SLOT = new T.Vector3();
const TMP_WORLD_SURFACE = new T.Vector3();

function pickClosestAnchorSlot(
  slots: readonly CatalogAnchor[],
  group: T.Group,
  hitWorldPoint?: { x: number; y?: number; z: number } | null,
  sideHint = 1,
): { slot: CatalogAnchor; slotIndex: number } {
  if (slots.length === 1) return { slot: slots[0], slotIndex: 0 };
  if (hitWorldPoint && Number.isFinite(hitWorldPoint.x + hitWorldPoint.z)) {
    let bestIdx = 0;
    let bestDistSq = Infinity;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      TMP_WORLD_SLOT.set(s.x, 0, s.z).applyMatrix4(group.matrixWorld);
      const dx = hitWorldPoint.x - TMP_WORLD_SLOT.x;
      const dz = hitWorldPoint.z - TMP_WORLD_SLOT.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIdx = i;
      }
    }
    return { slot: slots[bestIdx], slotIndex: bestIdx };
  }
  // Without an explicit hit point on a bedside multi-slot array, honour caller's `side` sign (`+1` right, `-1` left).
  const matchingIdx = slots.findIndex((s) => (sideHint >= 0 ? s.x >= 0 : s.x < 0));
  if (matchingIdx >= 0 && Math.abs(slots[matchingIdx].x) > 0.3 && slots.some((s) => s.x * slots[matchingIdx].x < 0)) {
    // Prefer center slot (`x === 0`) on symmetric 3-cushion sofas when no hitPoint is supplied.
    const centerIdx = slots.findIndex((s) => Math.abs(s.x) < 1e-3);
    if (centerIdx >= 0) return { slot: slots[centerIdx], slotIndex: centerIdx };
    return { slot: slots[matchingIdx], slotIndex: matchingIdx };
  }
  const centerIdx = slots.findIndex((s) => Math.abs(s.x) < 1e-3);
  if (centerIdx >= 0) return { slot: slots[centerIdx], slotIndex: centerIdx };
  return { slot: slots[0], slotIndex: 0 };
}

/**
 * Resolves stage-space seat/bed anchor position, quaternion-accurate horizontal facing `rotY`,
 * live `matrixWorld`/`matrix`-derived cushion `top` & `armrest`, and non-backrest `approaches`.
 * Returns `null` immediately when the furniture piece is tilted/fallen (`seatUp.y < MIN_SEAT_UPRIGHT_DOT`).
 */
export function furnitureAnchor(
  obj: SpaceObject,
  group: T.Group,
  lie: boolean,
  side = 1,
  hitWorldPoint?: { x: number; y?: number; z: number } | null,
): ResolvedFurnitureAnchor | null {
  const item = CATALOG_BY_ID[obj.kind];
  if (!item?.anchor) return null;

  group.updateMatrix();
  group.updateMatrixWorld(true);

  // Reject sitting/lying on fallen or tipped chairs/furniture (`worldUp · seatUp < cos(15 deg)`).
  const uprightDot = computeSeatUpDot(group.quaternion);
  if (uprightDot < MIN_SEAT_UPRIGHT_DOT) return null;

  const local = (x: number, y: number, z: number) => new T.Vector3(x, y, z).applyMatrix4(group.matrix);
  const stageScaleY = group.parent ? Math.hypot(group.parent.matrixWorld.elements[4], group.parent.matrixWorld.elements[5], group.parent.matrixWorld.elements[6]) || 1 : 1;
  const stageOriginWorldY = group.parent ? group.parent.matrixWorld.elements[13] : 0;
  const surfaceStageYFromWorld = (localY: number): number => {
    TMP_WORLD_SURFACE.set(0, localY, 0).applyMatrix4(group.matrixWorld);
    return (TMP_WORLD_SURFACE.y - stageOriginWorldY) / stageScaleY;
  };

  const bed = BEDS[obj.kind];
  if (bed) {
    const authored = group.userData.asset === 'blender';
    const localSurfaceY = authored ? bed.cover : bed.mattress + 0.065;
    const surface = surfaceStageYFromWorld(localSurfaceY);
    const pillow = authored
      ? local(...bed.pillow)
      : local(0, bed.mattress + 0.125, obj.kind === 'bed.single' ? -0.72 : -0.74);

    if (lie) {
      const lieRotY = extractHorizontalForwardYaw(group.quaternion, obj.rotY, 0);
      return {
        pos: local(0, 0, 0),
        rotY: lieRotY,
        top: surface,
        slotIndex: 0,
        approaches: [local(bed.width / 2 + 0.35, 0, 0.1), local(-bed.width / 2 - 0.35, 0, 0.1)],
        bed: { pillow, surface, width: bed.width * obj.scale, depth: bed.depth * obj.scale },
      };
    }

    const bedSitSlots = item.anchors && item.anchors.length > 0
      ? item.anchors
      : [
          { x: side * (bed.width / 2 - 0.10), z: 0.1, rotY: side * (Math.PI / 2), y: localSurfaceY, activity: 'sit' as const, hasBackrest: false },
        ];
    const { slot, slotIndex } = hitWorldPoint
      ? pickClosestAnchorSlot(bedSitSlots, group, hitWorldPoint, side)
      : (() => {
          const sideSlots = bedSitSlots.filter((s) => (side >= 0 ? s.x >= 0 : s.x < 0));
          const chosen = sideSlots[0] ?? bedSitSlots[0];
          return { slot: chosen, slotIndex: Math.max(0, bedSitSlots.indexOf(chosen)) };
        })();
    const sitRotY = extractHorizontalForwardYaw(group.quaternion, obj.rotY, slot.rotY);
    const slotSideSign = slot.x >= 0 ? 1 : -1;
    return {
      pos: local(slot.x, 0, slot.z),
      rotY: sitRotY,
      top: surface,
      slotIndex,
      approaches: [
        local(slotSideSign * (bed.width / 2 + 0.35), 0, slot.z),
        local(-slotSideSign * (bed.width / 2 + 0.35), 0, slot.z),
      ],
      bed: { pillow, surface, width: bed.width * obj.scale, depth: bed.depth * obj.scale },
    };
  }

  const slotPool = !lie && item.anchors && item.anchors.length > 0 ? item.anchors : [item.anchor];
  const { slot, slotIndex } = pickClosestAnchorSlot(slotPool, group, hitWorldPoint, side);
  const pos = local(slot.x, 0, slot.z);
  const rotY = extractHorizontalForwardYaw(group.quaternion, obj.rotY, slot.rotY);
  const seatHeightLocal = typeof group.userData.seatHeight === 'number' ? group.userData.seatHeight : 0.5;
  const top = surfaceStageYFromWorld(seatHeightLocal);
  const armrest =
    typeof group.userData.armrest === 'number'
      ? surfaceStageYFromWorld(group.userData.armrest)
      : undefined;

  // Build front/side-hemisphere approaches strictly excluding `PI` behind-the-backrest when `hasBackrest` is true!
  const hasBackrest = slot.hasBackrest ?? item.anchor.hasBackrest ?? true;
  const angles = hasBackrest ? BACKED_SEAT_APPROACH_ANGLES : OPEN_SEAT_APPROACH_ANGLES;
  const approaches: T.Vector3[] = [];
  for (let ri = 0; ri < BACKED_SEAT_APPROACH_RADII.length; ri++) {
    const rad = BACKED_SEAT_APPROACH_RADII[ri];
    for (let ai = 0; ai < angles.length; ai++) {
      const ang = rotY + angles[ai];
      approaches.push(new T.Vector3(pos.x + Math.sin(ang) * rad, pos.y, pos.z + Math.cos(ang) * rad));
    }
  }

  return {
    pos,
    rotY,
    top,
    armrest,
    slotIndex,
    approaches,
    bed: undefined,
  };
}
