import * as T from 'three';
import { LiquidPortal, PortalCapture } from '@/lib/vfx/liquidPortal';
import { musicBands } from '@/lib/vfx/audio';
import type { VfxTier } from '@/lib/vfx/quality';
import { stepSpring } from '@/lib/morph/spring';
import { MORPH_SPRING } from '@/lib/morph/tokens';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { RoomConfig } from '@/lib/study-space/types';
import { mat } from './materials';
import { gatewayAsset } from './gatewayAssets';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** A real door has weight: a slower swing, a soft stop, no bounce through the frame. */
const DOOR_OPEN = { stiffness: 26, damping: 8.4, mass: 1, precision: .001 };
const DOOR_CLOSE = { stiffness: 34, damping: 10, mass: 1, precision: .001 };
const PORTAL_OPEN_TARGET = -1.05;
const PORTAL_OPEN_SETTLED_RAD = 0.88;
const PORTAL_CLOSED_EPS_RAD = 0.025;
const PORTAL_OCCUPANCY_HYST = 0.12;
const PORTAL_WALL_THICK = 0.16;

export type GatewayDoorPhase = 'closed' | 'opening' | 'open' | 'occupied' | 'closing';

export interface GatewayDoorOccupant {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

function shortestArcRad(fromRad: number, toRad: number): number {
  let d = (toRad - fromRad) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function sdDoorwayOpening(px: number, pz: number, cx: number, cz: number, doorWidth: number, wallThick: number): number {
  const dx = Math.abs(px - cx) - doorWidth * 0.5;
  const dz = Math.abs(pz - cz) - wallThick * 0.5;
  const ox = dx > 0 ? dx : 0;
  const oz = dz > 0 ? dz : 0;
  return Math.hypot(ox, oz) + Math.min(Math.max(dx, dz), 0);
}

function overlapsPortalSweepSector(
  ox: number,
  oz: number,
  r: number,
  hingeX: number,
  hingeZ: number,
  baseYaw: number,
  swingSpan: number,
  maxRadius: number,
  hyst: number,
): boolean {
  if (Math.abs(swingSpan) <= 1e-4) return false;
  const dx = ox - hingeX;
  const dz = oz - hingeZ;
  const dist = Math.hypot(dx, dz);
  if (dist > maxRadius) return false;
  const effR = r + 0.04 + hyst;
  if (dist <= effR) return true;
  const midWorldYaw = baseYaw - swingSpan * 0.5;
  const halfSpan = Math.abs(swingSpan) * 0.5;
  const angDiff = Math.abs(shortestArcRad(midWorldYaw, Math.atan2(dz, dx)));
  const angPad = Math.asin(Math.min(1, effR / dist));
  return angDiff <= halfSpan + angPad;
}

/** A doorway in the cutaway's solid side wall (x = +half): the Echo Life house's hallway door. */
export interface SideDoor { z: number; width: number; top: number }

/** The reverse side of the existing cutaway room. Disposed with its removable shell. */
export function buildInterior(cfg: RoomConfig, side: SideDoor | null = null) {
  const group = new T.Group(), half = cfg.size / 2, owned: { dispose(): void }[] = [];
  group.name = 'room-interior'; group.visible = false;
  const wall = mat('wall', cfg.wallColor), timber = mat('wood', cfg.theme === 'station' ? '#71879f' : '#806346');
  const brass = mat('brass', '#c3a67b');
  const box = (parent: T.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, material: T.Material, radius = .018) => {
    const geometry = radius ? new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 3, h / 3, d / 3)) : new T.BoxGeometry(w, h, d); owned.push(geometry);
    const mesh = new T.Mesh(geometry, material); mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
  };
  // Side and ceiling close the cutaway only while the learner is inside it.
  // Without a side door this is the one solid wall it always was; with one (Echo Life connected house),
  // build the Study-side half [half .. half + 0.072] so it never Z-fights with the Hallway-side plaster [h + 0.088 .. h + 0.16].
  const sideSpans = (from: number, to: number) => side ? [[from, side.z - side.width / 2 - .06], [side.z + side.width / 2 + .06, to]].filter(([a, b]) => b > a) : [[from, to]];
  const sideWallThick = side ? .072 : .16;
  const sideWallX = half + sideWallThick / 2;
  if (cfg.wallLeft) for (const [a, b] of sideSpans(-half, half)) box(group, sideWallThick, 3, b - a, sideWallX, 1.5, (a + b) / 2, wall, 0);
  if (cfg.wallLeft && side) box(group, sideWallThick, 3 - side.top, side.width + .12, sideWallX, side.top + (3 - side.top) / 2, side.z, wall, 0);
  const ceiling = box(group, cfg.size, .09, cfg.size, 0, 3.06, 0, mat('wall', '#eee6d9'));
  ceiling.castShadow = false;
  const centers = [-cfg.size * .23, cfg.size * .23];
  const width = 1.02, height = 2.32, z = half + .08;
  const intervals = [-half, centers[0] - width / 2, centers[0] + width / 2, centers[1] - width / 2, centers[1] + width / 2, half];
  for (let i = 0; i < intervals.length; i += 2) {
    const a = intervals[i], b = intervals[i + 1];
    if (cfg.wallRight && b > a) box(group, b - a, 3, .16, (a + b) / 2, 1.5, z, wall, 0);
  }
  const capture = new PortalCapture(); owned.push(capture);
  const portals: LiquidPortal[] = [];
  const frustum = new T.Frustum(), projection = new T.Matrix4(), bounds = new T.Box3();
  const doors = centers.map((x, i) => {
    const id = i ? 'games' : 'arena';
    const authored = gatewayAsset();
    if (cfg.wallRight) box(group, width, 3 - height, .16, x, height + (3 - height) / 2, z, wall, 0);
    const frame = new T.Group(); frame.position.set(x, 0, half); group.add(frame);
    const pivot = new T.Group(); pivot.position.set(-width / 2 + .02, 0, .03); frame.add(pivot);
    // The lever turns on its own stem, before the door moves.
    const lever = new T.Group(); pivot.add(lever);
    if (authored) { frame.add(authored.frame); pivot.add(authored.leaf); lever.position.set(.85, 1.09, -.122); authored.handle.position.set(-.85, -1.09, .122); lever.add(authored.handle); }
    else {
    for (const sign of [-1, 1]) {
      box(frame, .11, height + .12, .23, sign * (width / 2 + .02), height / 2, 0, timber, .028);
      box(frame, .016, height, .018, sign * (width / 2 - .045), height / 2, -.13, brass, .006);
    }
    box(frame, width + .16, .13, .23, 0, height + .025, 0, timber, .025);
    box(frame, width + .11, .025, .26, 0, .015, 0, brass, .006);
    const door = box(pivot, width - .04, height - .04, .055, (width - .04) / 2, height / 2, 0, mat('wood', i ? '#40536a' : '#47736e'), .023);
    for (const y of [.56, 1.57]) {
      box(pivot, width - .2, .89, .018, width / 2 - .02, y, -.04, timber, .04);
      box(pivot, width - .25, .84, .021, width / 2 - .02, y, -.052, mat('paint', i ? '#33465c' : '#365f5b'), .035);
    }
    box(pivot, .035, .24, .055, width - .16, 1.03, -.09, brass, .012);
    lever.position.set(width - .16, 1.11, -.1);
    box(lever, .15, .032, .035, -.05, 0, -.03, brass, .012);
    }
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#182c39'; ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = '#c3a67b'; ctx.lineWidth = 3; ctx.strokeRect(6, 6, 500, 116);
    ctx.fillStyle = '#f4e9ce'; ctx.font = '600 35px Quicksand, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(i ? 'GAMES' : 'SPEAKING ARENA', 256, 64);
    const texture = new T.CanvasTexture(c); texture.colorSpace = T.SRGBColorSpace; owned.push(texture);
    const labelMat = new T.MeshStandardMaterial({ map: texture, roughness: .5, metalness: .15, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }); owned.push(labelMat);
    const label = new T.Mesh(new T.PlaneGeometry(.76, .19), labelMat); owned.push(label.geometry);
    label.position.set(0, authored ? 2.65 : 2.57, -.02); label.rotation.y = Math.PI; frame.add(label);
    const liquid = new LiquidPortal(id); frame.add(liquid.group); portals.push(liquid); owned.push(liquid);
    frame.traverse(o => { o.userData.portal = id; });
    pivot.traverse(o => { o.userData.isDoorLeaf = true; });
    // Warm recessed transom: a physical emissive surface, no screen-covering bloom.
    box(frame, width - .1, .025, .025, 0, height - .025, -.13, mat('glow', i ? '#bdd6ff' : '#a5dfcc', '.7'), .006);
    frame.visible = cfg.wallRight;
    return {
      id,
      x,
      hingeX: x - width / 2 + .02,
      hingeZ: half + .03,
      pivot,
      lever,
      liquid,
      spring: { position: 0, velocity: 0 },
      open: false,
      desiredOpen: false,
      pendingClose: false,
      occupiedNow: false,
      explicitOccTick: false,
      phase: 'closed' as GatewayDoorPhase,
      leverNow: 0,
      leverTarget: 0,
      physical: false,
    };
  });
  const singleOccScratch: GatewayDoorOccupant[] = [{ x: 0, y: 0, z: 0, radius: 0.26 }];
  const syncPortalDoorOccupancy = (
    door: (typeof doors)[number],
    occupants: readonly GatewayDoorOccupant[],
  ) => {
    const hyst = door.phase === 'occupied' ? PORTAL_OCCUPANCY_HYST : 0;
    let inGuard = false;
    let inRemaining = false;
    for (let i = 0; i < occupants.length; i++) {
      const occ = occupants[i];
      if (Math.abs(occ.y) > 1.65) continue;
      const r = Math.max(0.18, occ.radius);
      const sdOpen = sdDoorwayOpening(occ.x, occ.z, door.x, half, width, PORTAL_WALL_THICK);
      if (
        sdOpen <= r + 0.12 + hyst ||
        overlapsPortalSweepSector(
          occ.x,
          occ.z,
          r,
          door.hingeX,
          door.hingeZ,
          0,
          PORTAL_OPEN_TARGET,
          width + r + 0.06 + hyst,
          hyst,
        )
      ) {
        inGuard = true;
      }
      if (
        Math.abs(door.spring.position) > PORTAL_CLOSED_EPS_RAD &&
        (sdOpen <= r + 0.08 ||
          overlapsPortalSweepSector(
            occ.x,
            occ.z,
            r,
            door.hingeX,
            door.hingeZ,
            0,
            door.spring.position,
            width + r + 0.06,
            0,
          ))
      ) {
        inRemaining = true;
      }
    }
    door.occupiedNow = inGuard;

    if (door.phase === 'closing' && inRemaining) {
      // Auto-reverse immediately if the player or an NPC steps into the closing sweep or doorway!
      door.desiredOpen = true;
      door.open = true;
      door.pendingClose = true;
      door.physical = false;
      door.phase = Math.abs(door.spring.position) >= PORTAL_OPEN_SETTLED_RAD ? 'occupied' : 'opening';
      return;
    }

    if (door.phase === 'occupied') {
      if (!inGuard) {
        if (door.pendingClose) {
          door.pendingClose = false;
          door.desiredOpen = false;
          door.open = false;
          door.phase = Math.abs(door.spring.position) <= PORTAL_CLOSED_EPS_RAD ? 'closed' : 'closing';
        } else {
          door.phase = Math.abs(door.spring.position) >= PORTAL_OPEN_SETTLED_RAD ? 'open' : 'opening';
        }
      }
      return;
    }

    if (door.desiredOpen || door.open) {
      if (Math.abs(door.spring.position) >= PORTAL_OPEN_SETTLED_RAD) {
        if (inGuard) {
          door.phase = 'occupied';
        } else if (door.pendingClose) {
          door.pendingClose = false;
          door.desiredOpen = false;
          door.open = false;
          door.phase = 'closing';
        } else {
          door.phase = 'open';
        }
      } else {
        door.phase = inGuard && door.pendingClose ? 'occupied' : 'opening';
      }
    } else {
      door.phase = Math.abs(door.spring.position) <= PORTAL_CLOSED_EPS_RAD ? 'closed' : 'closing';
    }
  };
  // The same joinery language continues around the new walls.
  if (cfg.wallLeft) {
  for (const [a, b] of sideSpans(-half, half)) {
    box(group, .04, .13, b - a, half - .02, .065, (a + b) / 2, timber);
    box(group, .045, .065, b - a, half - .02, .79, (a + b) / 2, timber);
  }
  for (let i = 0; i < 8; i++) {
    const z = -half + .24 + i * (cfg.size - .48) / 7;
    if (!side || Math.abs(z - side.z) > side.width / 2 + .1) box(group, .035, .68, .045, half - .025, .41, z, timber);
  }
  }
  const batches = new Map<T.Material, T.Mesh[]>();
  for (const child of group.children) if ((child as T.Mesh).isMesh) {
    const mesh = child as T.Mesh;
    if (mesh === ceiling) continue;
    const material = mesh.material as T.Material;
    const list = batches.get(material) ?? []; list.push(mesh); batches.set(material, list);
  }
  for (const [material, meshes] of batches) {
    if (meshes.length < 2) continue;
    const pieces = meshes.map(m => { m.updateMatrix(); return m.geometry.clone().applyMatrix4(m.matrix); });
    // Rounded and flat geometries share position/normal/uv attributes.
    const merged = mergeGeometries(pieces); pieces.forEach(g => g.dispose());
    if (!merged) continue;
    owned.push(merged); meshes.forEach(m => group.remove(m));
    const mesh = new T.Mesh(merged, material); mesh.castShadow = mesh.receiveShadow = true; group.add(mesh);
  }
  return {
    group,
    prepare(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera, dt: number, tier: VfxTier, reduced: boolean) {
      if (!group.visible) { capture.dispose(); portals.forEach(p => p.suspend()); return; }
      camera.updateMatrixWorld(); group.updateWorldMatrix(true, true);
      frustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      let visible = false;
      for (const door of doors) {
        const inView = cfg.wallRight && Math.abs(door.spring.position) > .08 && frustum.intersectsBox(bounds.setFromObject(door.liquid.group));
        if(inView){door.liquid.prepare(renderer, dt, tier, reduced);visible=true;}else door.liquid.suspend();
      }
      capture.render(renderer, scene, camera, portals, reduced || !visible ? 'low' : tier);
    },
    update(active: boolean, position: T.Vector3 | null, dt: number, reduced: boolean) {
      group.visible = active;
      for (const door of doors) {
        if (!door.explicitOccTick) {
          if (position) {
            singleOccScratch[0] = { x: position.x, y: position.y, z: position.z, radius: 0.26 };
            syncPortalDoorOccupancy(door, singleOccScratch);
          } else {
            syncPortalDoorOccupancy(door, []);
          }
        }
        door.explicitOccTick = false;
        // A door opens because a hand opened it. It swings outward, into the doorway, and holds open while occupied.
        const holdOpen = door.open || door.phase === 'occupied' || door.phase === 'open' || door.phase === 'opening';
        const angle = holdOpen ? PORTAL_OPEN_TARGET : 0;
        // While its hinge is in the physics world, that is what says where the leaf is.
        if (!door.physical) {
          door.spring = reduced
            ? { position: angle, velocity: 0 }
            : stepSpring(door.spring, angle, dt, holdOpen ? DOOR_OPEN : DOOR_CLOSE);
          if (holdOpen && Math.abs(door.spring.position) >= PORTAL_OPEN_SETTLED_RAD) {
            if (door.occupiedNow) {
              door.phase = 'occupied';
            } else if (door.pendingClose) {
              door.pendingClose = false;
              door.desiredOpen = false;
              door.open = false;
              door.phase = 'closing';
            } else {
              door.phase = 'open';
            }
          } else if (!holdOpen && Math.abs(door.spring.position) <= PORTAL_CLOSED_EPS_RAD) {
            door.phase = 'closed';
          }
        }
        door.pivot.rotation.y = door.spring.position;
        door.leverNow += (door.leverTarget - door.leverNow) * (reduced ? 1 : 1 - Math.exp(-22 * dt));
        door.lever.rotation.z = door.leverNow * .62;
        // The surface beyond only wakes once the leaf has swung out of the way.
        door.liquid.update(dt, Math.abs(door.spring.position) > .62, reduced, musicBands());
      }
    },
    door(id: 'arena' | 'games') {
      const door = doors.find(d => d.id === id);
      if (!door) return null;
      return {
        x: door.x,
        /** The middle of the lever, in world space, wherever the leaf has swung to. */
        handleWorld: (out: T.Vector3) => door.lever.localToWorld(out.set(-.065, 0, -.038)),
        setOpen(open: boolean) {
          door.physical = false;
          if (open) {
            door.desiredOpen = true;
            door.open = true;
            door.pendingClose = false;
            door.phase =
              Math.abs(door.spring.position) >= PORTAL_OPEN_SETTLED_RAD
                ? (door.occupiedNow ? 'occupied' : 'open')
                : 'opening';
          } else if (
            door.occupiedNow &&
            (door.desiredOpen || door.open || Math.abs(door.spring.position) > 0.08)
          ) {
            // Defer closing until the occupant clears Guard Zone + 0.12 m hysteresis!
            door.desiredOpen = true;
            door.open = true;
            door.pendingClose = true;
            door.phase = 'occupied';
          } else {
            door.desiredOpen = false;
            door.open = false;
            door.pendingClose = false;
            door.phase = Math.abs(door.spring.position) <= PORTAL_CLOSED_EPS_RAD ? 'closed' : 'closing';
          }
        },
        /** The hinge joint's angle; null hands the leaf back to its spring without snapping shut onto an occupant. */
        setAngle(angle: number | null) {
          door.physical = angle !== null;
          if (angle !== null) {
            door.spring = { position: angle, velocity: 0 };
            if (door.occupiedNow && !door.desiredOpen && Math.abs(angle) > 0.08) {
              door.desiredOpen = true;
              door.open = true;
              door.pendingClose = true;
              door.phase = 'occupied';
            } else if (door.desiredOpen) {
              door.open = true;
            } else {
              door.open = angle < -.3;
            }
          }
        },
        get isOpen() { return door.open && !door.pendingClose; },
        get passable() {
          return door.phase === 'open' || door.phase === 'occupied' || Math.abs(door.spring.position) > .55;
        },
        get phase() { return door.phase; },
        get pendingClose() { return door.pendingClose; },
        updateOccupancy(occupants: readonly GatewayDoorOccupant[]) {
          door.explicitOccTick = true;
          syncPortalDoorOccupancy(door, occupants);
        },
        press(k: number) { door.leverTarget = k; },
        get angle() { return door.spring.position; },
      };
    },
    dispose() { owned.forEach(x => x.dispose()); },
  };
}
