/**
 * Echo Life — the residential house around the study room, and the shared geometry primitives used by enterable city
 * buildings (`buildings.ts`).
 *
 * Pure data and geometry in the study stage's own metres (origin = study-room centre, its floor y = 0, −z = the window side).
 * The study room is the north-west corner of the upper floor of a two-storey house: its third door (east wall) opens on a
 * hallway; the hallway leads to an open living room + kitchen, a bathroom, an upper east wing (bedroom, terrace balcony,
 * gaming and tech studio), and a 17-step straight staircase down to the lobby and personal garage; the front door and garage
 * street door open onto Lantern Street, and the back garden (`yard`) stretches behind the house to Riverside Road.
 *
 * Every walkable area is disjoint from every other in plan view, so any point (x, z) names one unambiguous floor height.
 */

export const STOREY = 3.2;
/** The street, the lobby, the garage, the sidewalks and ground-floor city interiors. */
export const GROUND_Y = -STOREY;
export const WALL = 0.16;
/** Upper-floor walls stop under the ceiling slab at the study room's own height. */
export const UPPER_WALL_TOP = 3.06;
/** Body radius used to keep NPC/room navigation centres off walls and low furniture (`R_low = 0.20 m`). */
export const BODY_RADIUS = 0.2;
/** Height-banded player capsule radii: `0.20 m` against low furniture (`< 0.95 m`), `0.26 m` against walls/jambs/tall props (`>= 0.95 m`). */
export const PLAYER_R_LOW = 0.2;
export const PLAYER_R_HIGH = 0.26;
export const PLAYER_HEIGHT_BAND_SPLIT = 0.95;
/** The authored study door (`connected-door` GLB): every house and enterable city door uses this standard opening. */
export const DOOR_W = 1.02, DOOR_H = 2.32;

export interface Rect { x0: number; x1: number; z0: number; z1: number }
export type ZoneId =
  | 'hall' | 'living' | 'kitchen' | 'bath' | 'bedroom' | 'balcony' | 'gaming_room'
  | 'stair' | 'lobby' | 'lobbyFoot' | 'garage' | 'street';
export interface Text { vi: string; en: string }

export interface Zone {
  id: ZoneId;
  rect: Rect;
  /** Floor height; for a stair, the height at z0 going to `y1` at z1 (or x0 -> x1 when `along === 'x'`). */
  y: number;
  y1?: number;
  along?: 'z' | 'x';
  name: Text;
  /** Interior ceiling height above the floor (outdoors / open sky: null). */
  ceiling: number | null;
}

export type HouseDoorId = 'hall' | 'bath' | 'entrance' | 'bedroom' | 'balcony' | 'gaming' | 'garage' | 'garage_out';
export type DoorId = HouseDoorId | `city:${string}` | (string & {});
export type DoorPhase = 'closed' | 'opening' | 'open' | 'occupied' | 'closing';

export type EchoFurnitureAsset =
  | 'tv' | 'tv-console' | 'sofa' | 'floorlamp' | 'plant'
  | 'sink' | 'stove' | 'hood' | 'fridge' | 'table' | 'chair' | 'pendant'
  | 'shower' | 'toilet' | 'basin' | 'mirror'
  | 'bed-single' | 'wardrobe' | 'balcony-table' | 'planter-trough'
  | 'gaming-desk' | 'gaming-monitor' | 'gaming-pc' | 'gaming-chair' | 'arcade-lamp'
  | 'mailbox' | 'bench' | 'workbench' | 'bicycle' | 'car-hatch'
  | 'art-easel' | 'bench-cushion' | 'guitar-electric' | 'guitar-acoustic'
  | 'cafe-booth' | 'espresso' | 'crepe-kiosk' | 'tea-service'
  | 'market-shelf' | 'market-checkout' | 'patisserie-case' | 'display-cabinet'
  | 'canopy-bed' | 'garment-rack' | 'moto-commuter' | 'scooter-ev' | 'car-spider'
  | 'soaking-tub' | 'kitchen-island' | 'photocopier'
  | 'library-desk' | 'library-table' | 'library-trolley' | 'library-stack'
  | (string & {});

/** Standard media console top surface height (`0.55 m`) placing 55" TV centers at seated eye level (`~1.00-1.08 m`). */
export const TV_CONSOLE_TOP_Y = 0.55;

export interface Door {
  id: DoorId;
  /** The wall the door is in runs along this axis ('z': a wall of constant x). */
  wallAlong: 'x' | 'z';
  /** Centre of the opening at the wall's middle plane. */
  x: number; z: number;
  /** Floor of the door. */
  y: number;
  width: number;
  height: number;
  /** The frame's turn: its local +z is the side the leaf swings into (the authored study door's own convention). */
  yaw: number;
  /** The clear opening, carried through the wall and a little past both faces: open, it joins the two sides. */
  corridor: Rect;
  name: Text;
}

export interface WallSpan {
  /** Axis-aligned wall box: [x0,x1] × [y0,y1] × [z0,z1], with openings cut along its long axis. */
  x0: number; x1: number; z0: number; z1: number; y0: number; y1: number;
  /** `bottom` set: a window (sill height); unset: a doorway or arch. `shop`: dark display glass. */
  openings: { from: number; to: number; top: number; bottom?: number; shop?: boolean }[];
  face: 'interior' | 'exterior';
  finish: 'plaster' | 'tile' | 'stone';
}

export interface Slab { rect: Rect; y: number; thick: number; finish: 'oak' | 'tile' | 'terrazzo' | 'roof' | 'concrete' }
export interface Stair { rect: Rect; y0: number; y1: number; steps: number; along?: 'z' | 'x' }
export interface Furnishing { asset: EchoFurnitureAsset; x: number; z: number; y: number; rotY: number; size: number; footprint: Rect | null; label: Text }
export interface Block {
  rect: Rect;
  zone: string;
  label: string;
  /** Optional floor elevation for multi-storey or sidewalk disambiguation. */
  y?: number;
  /** Optional height above floor in metres (`< 0.95` -> `PLAYER_R_LOW = 0.20`, `>= 0.95` -> `PLAYER_R_HIGH = 0.26`). */
  topRel?: number;
  /** True when placed on the exterior sidewalk outside a building's interior walls. */
  exterior?: boolean;
  /** True for tall opaque interior volumes (e.g. 2.55 m bookstacks) that occlude 3P camera rays. */
  cameraOccluder?: boolean;
}

export interface HousePlan {
  h: number;
  zones: Zone[];
  doors: Door[];
  walls: WallSpan[];
  slabs: Slab[];
  stair: Stair;
  blocks: Block[];
  furniture: Furnishing[];
  passages: { rect: Rect; y: number }[];
  footprint: Rect;
  front: number;
  rooms: { id: ZoneId; rect: Rect; y: number }[];
}

export const rect = (x0: number, x1: number, z0: number, z1: number): Rect =>
  ({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) });
const r = rect;
export const inRect = (p: { x: number; z: number }, a: Rect, pad = 0) =>
  p.x >= a.x0 + pad && p.x <= a.x1 - pad && p.z >= a.z0 + pad && p.z <= a.z1 - pad;

/** The house for a study room of side `size` (4…9 m). Deterministic: the same size always gives the same house. */
export function housePlan(size: number): HousePlan {
  const h = size / 2;
  // Upper floor, west to east: study | hallway | living+kitchen | bedroom+gaming_room | balcony.
  const hx0 = h + WALL, hx1 = hx0 + 2.0;
  const lx0 = hx1 + WALL, lx1 = lx0 + 4.6;
  const wx0 = lx1 + WALL, wx1 = wx0 + 4.0;
  const bx0 = wx1 + WALL, bx1 = bx0 + 2.3;
  // Split living (north) and kitchen (south) smoothly with an open floor passage.
  const kitchenZ = Math.min(h - 1.1, Math.max(0.45, h - 1.55));
  const bedSplit = 1.1;
  // South of the hallway's end: the 17-step stair down to the lobby and ground-floor personal garage.
  const hallEnd = h + 2.4;
  const runPerStep = 0.3, steps = 17;
  const s0 = hallEnd, s1 = s0 + steps * runPerStep;
  const front = s1 + 2.8 + WALL;
  const doorZ = Math.max(-h + .7, Math.min(h - .7, h * .63));
  const entranceX = (hx1 + lx1) / 2 - .3;
  const bedDoorZ = 0.38;
  const balDoorZ = -0.35;
  const gamDoorX = wx0 + 1.2;
  const garDoorZ = s1 + 1.4;
  const garOutX = wx0 + 2.1;

  const zones: Zone[] = [
    { id: 'hall', rect: r(hx0, hx1, -h, hallEnd), y: 0, ceiling: UPPER_WALL_TOP, name: { vi: 'Hành lang', en: 'Hallway' } },
    { id: 'living', rect: r(lx0, lx1, -h, kitchenZ), y: 0, ceiling: UPPER_WALL_TOP, name: { vi: 'Phòng khách', en: 'Living room' } },
    { id: 'kitchen', rect: r(lx0, lx1, kitchenZ, h), y: 0, ceiling: UPPER_WALL_TOP, name: { vi: 'Nhà bếp', en: 'Kitchen' } },
    { id: 'bath', rect: r(lx0, lx1, h + WALL, hallEnd), y: 0, ceiling: UPPER_WALL_TOP, name: { vi: 'Phòng tắm', en: 'Bathroom' } },
    { id: 'bedroom', rect: r(wx0, wx1, -h, bedSplit), y: 0, ceiling: UPPER_WALL_TOP, name: { vi: 'Phòng ngủ', en: 'Bedroom' } },
    { id: 'balcony', rect: r(bx0, bx1, -h, bedSplit), y: 0, ceiling: null, name: { vi: 'Ban công sân thượng', en: 'Terrace Balcony' } },
    { id: 'gaming_room', rect: r(wx0, wx1, bedSplit + WALL, hallEnd), y: 0, ceiling: UPPER_WALL_TOP, name: { vi: 'Phòng Gaming và Công nghệ', en: 'Gaming and Tech Studio' } },
    { id: 'stair', rect: r(hx0, hx1, s0, s1), y: 0, y1: GROUND_Y, ceiling: null, name: { vi: 'Cầu thang', en: 'Staircase' } },
    { id: 'lobby', rect: r(hx1 + WALL, lx1, hallEnd + WALL, front - WALL), y: GROUND_Y, ceiling: STOREY - .12, name: { vi: 'Sảnh tòa nhà', en: 'Building lobby' } },
    { id: 'lobbyFoot', rect: r(hx0, hx1 + WALL, s1, front - WALL), y: GROUND_Y, ceiling: STOREY - .12, name: { vi: 'Sảnh tòa nhà', en: 'Building lobby' } },
    { id: 'garage', rect: r(wx0, bx1, hallEnd + WALL, front - WALL), y: GROUND_Y, ceiling: STOREY - .12, name: { vi: 'Ga-ra cá nhân', en: 'Personal Garage' } },
  ];

  const doors: Door[] = [
    { id: 'hall', wallAlong: 'z', x: h + WALL / 2, z: doorZ, y: 0, width: DOOR_W, height: DOOR_H, yaw: Math.PI / 2,
      corridor: r(h - .32, hx0 + .32, doorZ - DOOR_W / 2 + .02, doorZ + DOOR_W / 2 - .02), name: { vi: 'Cửa ra hành lang', en: 'Door to the hallway' } },
    { id: 'bath', wallAlong: 'x', x: lx0 + .95, z: h + WALL / 2, y: 0, width: DOOR_W, height: DOOR_H, yaw: 0,
      corridor: r(lx0 + .95 - DOOR_W / 2 + .02, lx0 + .95 + DOOR_W / 2 - .02, h - .32, h + WALL + .32), name: { vi: 'Cửa phòng tắm', en: 'Bathroom door' } },
    { id: 'bedroom', wallAlong: 'z', x: lx1 + WALL / 2, z: bedDoorZ, y: 0, width: DOOR_W, height: DOOR_H, yaw: Math.PI / 2,
      corridor: r(lx1 - .32, wx0 + .32, bedDoorZ - DOOR_W / 2 + .02, bedDoorZ + DOOR_W / 2 - .02), name: { vi: 'Cửa phòng ngủ', en: 'Bedroom door' } },
    { id: 'balcony', wallAlong: 'z', x: wx1 + WALL / 2, z: balDoorZ, y: 0, width: DOOR_W, height: DOOR_H, yaw: Math.PI / 2,
      corridor: r(wx1 - .32, bx0 + .32, balDoorZ - DOOR_W / 2 + .02, balDoorZ + DOOR_W / 2 - .02), name: { vi: 'Cửa ban công', en: 'Balcony door' } },
    { id: 'gaming', wallAlong: 'x', x: gamDoorX, z: bedSplit + WALL / 2, y: 0, width: DOOR_W, height: DOOR_H, yaw: 0,
      corridor: r(gamDoorX - DOOR_W / 2 + .02, gamDoorX + DOOR_W / 2 - .02, bedSplit - .32, bedSplit + WALL + .32), name: { vi: 'Cửa phòng Gaming', en: 'Gaming studio door' } },
    { id: 'entrance', wallAlong: 'x', x: entranceX, z: front - WALL / 2, y: GROUND_Y, width: DOOR_W, height: DOOR_H, yaw: Math.PI,
      corridor: r(entranceX - DOOR_W / 2 + .02, entranceX + DOOR_W / 2 - .02, front - WALL - .32, front + .32), name: { vi: 'Cửa chính', en: 'Front door' } },
    { id: 'garage', wallAlong: 'z', x: lx1 + WALL / 2, z: garDoorZ, y: GROUND_Y, width: DOOR_W, height: DOOR_H, yaw: Math.PI / 2,
      corridor: r(lx1 - .32, wx0 + .32, garDoorZ - DOOR_W / 2 + .02, garDoorZ + DOOR_W / 2 - .02), name: { vi: 'Cửa vào ga-ra', en: 'Garage door' } },
    { id: 'garage_out', wallAlong: 'x', x: garOutX, z: front - WALL / 2, y: GROUND_Y, width: DOOR_W, height: DOOR_H, yaw: Math.PI,
      corridor: r(garOutX - DOOR_W / 2 + .02, garOutX + DOOR_W / 2 - .02, front - WALL - .32, front + .32), name: { vi: 'Cửa ga-ra ra phố', en: 'Garage street door' } },
  ];

  const openingAlong = (d: Door) => ({ from: (d.wallAlong === 'z' ? d.z : d.x) - d.width / 2, to: (d.wallAlong === 'z' ? d.z : d.x) + d.width / 2, top: d.height });
  const hallDoor = doors[0], bathDoor = doors[1], bedDoor = doors[2], balDoor = doors[3], gamDoor = doors[4], entrance = doors[5], garDoor = doors[6], garOutDoor = doors[7];
  const arch = { from: -h + .7, to: -h + 2.3, top: 2.35 };

  const walls: WallSpan[] = [
    // Study ↔ hallway.
    { x0: h, x1: hx0, z0: -h, z1: h, y0: 0, y1: UPPER_WALL_TOP, openings: [openingAlong(hallDoor)], face: 'interior', finish: 'plaster' },
    { x0: h, x1: hx0, z0: h, z1: hallEnd, y0: 0, y1: UPPER_WALL_TOP, openings: [], face: 'exterior', finish: 'plaster' },
    // Hallway ↔ living/kitchen (arch) and hallway ↔ bathroom.
    { x0: hx1, x1: lx0, z0: -h, z1: h + WALL, y0: 0, y1: UPPER_WALL_TOP, openings: [arch], face: 'interior', finish: 'plaster' },
    { x0: hx1, x1: lx0, z0: h + WALL, z1: hallEnd, y0: 0, y1: UPPER_WALL_TOP, openings: [], face: 'interior', finish: 'plaster' },
    // Kitchen ↔ bathroom.
    { x0: lx0, x1: lx1, z0: h, z1: h + WALL, y0: 0, y1: UPPER_WALL_TOP, openings: [openingAlong(bathDoor)], face: 'interior', finish: 'plaster' },
    // Living/kitchen/bath ↔ east wing (bedroom + gaming_room): interior partition with bedroom door.
    { x0: lx1, x1: wx0, z0: -h, z1: hallEnd, y0: 0, y1: UPPER_WALL_TOP, openings: [openingAlong(bedDoor)], face: 'interior', finish: 'plaster' },
    // Bedroom ↔ gaming_room partition with gaming door.
    { x0: wx0, x1: wx1, z0: bedSplit, z1: bedSplit + WALL, y0: 0, y1: UPPER_WALL_TOP, openings: [openingAlong(gamDoor)], face: 'interior', finish: 'plaster' },
    // Bedroom ↔ balcony wall with balcony door.
    { x0: wx1, x1: bx0, z0: -h, z1: bedSplit + WALL, y0: 0, y1: UPPER_WALL_TOP, openings: [openingAlong(balDoor)], face: 'exterior', finish: 'plaster' },
    // Gaming room east exterior wall (with window).
    { x0: wx1, x1: bx0, z0: bedSplit + WALL, z1: hallEnd + WALL, y0: 0, y1: UPPER_WALL_TOP, openings: [
      { from: bedSplit + 1.0, to: Math.min(hallEnd - .4, bedSplit + 2.6), top: 2.4, bottom: 1.0 },
    ], face: 'exterior', finish: 'plaster' },
    // Balcony open-sky balustrade parapets (north, east, south).
    { x0: bx0, x1: bx1 + WALL, z0: -h - WALL, z1: -h, y0: 0, y1: 1.05, openings: [], face: 'exterior', finish: 'plaster' },
    { x0: bx1, x1: bx1 + WALL, z0: -h - WALL, z1: bedSplit + WALL, y0: 0, y1: 1.05, openings: [], face: 'exterior', finish: 'plaster' },
    { x0: bx0, x1: bx1 + WALL, z0: bedSplit, z1: bedSplit + WALL, y0: 0, y1: 1.05, openings: [], face: 'exterior', finish: 'plaster' },
    // North façade east of the study room (hallway + living + bedroom windows).
    { x0: h, x1: wx1 + WALL, z0: -h - WALL, z1: -h, y0: 0, y1: UPPER_WALL_TOP, openings: [
      { from: hx0 + .35, to: hx1 - .35, top: 2.4, bottom: 1.0 },
      { from: lx0 + .7, to: lx0 + 2.1, top: 2.5, bottom: .9 },
      { from: lx1 - 2.1, to: lx1 - .7, top: 2.5, bottom: .9 },
      { from: wx0 + .8, to: wx1 - .8, top: 2.5, bottom: .9 },
    ], face: 'exterior', finish: 'plaster' },
    // South wall of upper bath + gaming room (above lobby & garage).
    { x0: lx0, x1: wx1 + WALL, z0: hallEnd, z1: hallEnd + WALL, y0: 0, y1: UPPER_WALL_TOP, openings: [
      { from: wx0 + 1.0, to: wx1 - 1.0, top: 2.4, bottom: 1.1 },
    ], face: 'exterior', finish: 'plaster' },
    // Stair well west & east walls.
    { x0: h, x1: hx0, z0: hallEnd, z1: front, y0: GROUND_Y, y1: UPPER_WALL_TOP, openings: [], face: 'exterior', finish: 'plaster' },
    { x0: hx1, x1: hx1 + WALL, z0: hallEnd, z1: s1 - 1.4, y0: GROUND_Y, y1: UPPER_WALL_TOP, openings: [], face: 'interior', finish: 'plaster' },
    // Ground floor façades: south street façade (lobby + garage), lobby ↔ garage wall, garage east & north walls.
    { x0: h, x1: bx1 + WALL, z0: front - WALL, z1: front, y0: GROUND_Y, y1: 0, openings: [
      { from: hx0 + .1, to: hx1 + .1, top: 2.6, bottom: .7 },
      openingAlong(entrance),
      { from: lx1 - 1.6, to: lx1 - .4, top: 2.6, bottom: .7 },
      openingAlong(garOutDoor),
      { from: garOutX + 1.2, to: bx1 - .5, top: 2.6, bottom: .8 },
    ], face: 'exterior', finish: 'stone' },
    // Lobby ↔ garage interior wall with garage door (stops cleanly at ground-floor ceiling underside y = -0.15).
    { x0: lx1, x1: wx0, z0: hallEnd, z1: front, y0: GROUND_Y, y1: -.15, openings: [openingAlong(garDoor)], face: 'interior', finish: 'plaster' },
    // Garage east exterior wall.
    { x0: bx1, x1: bx1 + WALL, z0: hallEnd, z1: front, y0: GROUND_Y, y1: 0, openings: [
      { from: hallEnd + 1.5, to: hallEnd + 3.5, top: 2.5, bottom: 1.1 },
    ], face: 'exterior', finish: 'stone' },
    // Lobby + garage north interior wall (30 mm clear below -0.12 upper floor slab undersides).
    { x0: hx1 + WALL, x1: bx1, z0: hallEnd, z1: hallEnd + WALL, y0: GROUND_Y, y1: -.15, openings: [], face: 'interior', finish: 'plaster' },
    // Stair tower above lobby ceiling (18 mm clear below -0.12 upper floor slab undersides).
    { x0: hx1, x1: hx1 + WALL, z0: s1 - 1.4, z1: front, y0: -.138, y1: UPPER_WALL_TOP, openings: [], face: 'exterior', finish: 'plaster' },
    { x0: h, x1: hx1 + WALL, z0: front - WALL, z1: front, y0: 0, y1: UPPER_WALL_TOP, openings: [{ from: hx0 + .3, to: hx1 - .3, top: 2.4, bottom: .9 }], face: 'exterior', finish: 'plaster' },
    // Roof parapets over shop & lobby/garage terrace.
    { x0: -h - WALL, x1: h, z0: front - WALL, z1: front, y0: 0, y1: .9, openings: [], face: 'exterior', finish: 'plaster' },
    { x0: -h - WALL, x1: -h, z0: h, z1: front, y0: 0, y1: .9, openings: [], face: 'exterior', finish: 'plaster' },
    { x0: hx1, x1: bx1 + WALL, z0: front - WALL, z1: front, y0: 0, y1: 1.05, openings: [], face: 'exterior', finish: 'plaster' },
    { x0: bx1, x1: bx1 + WALL, z0: hallEnd, z1: front, y0: 0, y1: 1.05, openings: [], face: 'exterior', finish: 'plaster' },
  ];
  // Ground storey under study, hallway, living, bedroom & balcony: closed bookshop ground shell.
  walls.push(
    { x0: -h - WALL, x1: bx1 + WALL, z0: -h - WALL, z1: -h, y0: GROUND_Y, y1: 0, openings: [
      { from: -h + .6, to: h - .6, top: 2.7, bottom: .5, shop: true },
      { from: lx0 + .6, to: lx1 - .6, top: 2.7, bottom: .5, shop: true },
      { from: wx0 + .6, to: wx1 - .6, top: 2.7, bottom: .5, shop: true },
    ], face: 'exterior', finish: 'stone' },
    { x0: -h - WALL, x1: -h, z0: -h - WALL, z1: front, y0: GROUND_Y, y1: 0, openings: [], face: 'exterior', finish: 'stone' },
    { x0: -h - WALL, x1: h, z0: front - WALL, z1: front, y0: GROUND_Y, y1: 0, openings: [{ from: -h + .5, to: h - .5, top: 2.6, bottom: .45, shop: true }], face: 'exterior', finish: 'stone' },
    { x0: bx1, x1: bx1 + WALL, z0: -h - WALL, z1: hallEnd, y0: GROUND_Y, y1: 0, openings: [], face: 'exterior', finish: 'stone' },
  );

  const slabs: Slab[] = [
    { rect: r(hx0, hx1, -h, hallEnd), y: 0, thick: .12, finish: 'oak' },
    { rect: r(lx0, lx1, -h, h), y: 0, thick: .12, finish: 'oak' },
    { rect: r(lx0, lx1, h + WALL, hallEnd), y: 0, thick: .12, finish: 'tile' },
    { rect: r(wx0, wx1, -h, bedSplit), y: 0, thick: .12, finish: 'oak' },
    { rect: r(bx0, bx1, -h, bedSplit), y: 0, thick: .12, finish: 'terrazzo' },
    { rect: r(wx0, wx1, bedSplit + WALL, hallEnd), y: 0, thick: .12, finish: 'tile' },
    // Threshold slabs under every doorway and arch so carried/dropped items never hit a wall-thickness crack.
    { rect: r(h, hx0, doorZ - DOOR_W / 2, doorZ + DOOR_W / 2), y: 0, thick: .12, finish: 'oak' },
    { rect: r(hx1, lx0, arch.from, arch.to), y: 0, thick: .12, finish: 'oak' },
    { rect: r(lx0 + .95 - DOOR_W / 2, lx0 + .95 + DOOR_W / 2, h, h + WALL), y: 0, thick: .12, finish: 'tile' },
    { rect: r(lx1, wx0, bedDoorZ - DOOR_W / 2, bedDoorZ + DOOR_W / 2), y: 0, thick: .12, finish: 'oak' },
    { rect: r(wx1, bx0, balDoorZ - DOOR_W / 2, balDoorZ + DOOR_W / 2), y: 0, thick: .12, finish: 'terrazzo' },
    { rect: r(gamDoorX - DOOR_W / 2, gamDoorX + DOOR_W / 2, bedSplit, bedSplit + WALL), y: 0, thick: .12, finish: 'tile' },
    { rect: r(entranceX - DOOR_W / 2, entranceX + DOOR_W / 2, front - WALL, front), y: GROUND_Y, thick: .12, finish: 'terrazzo' },
    { rect: r(lx1, wx0, garDoorZ - DOOR_W / 2, garDoorZ + DOOR_W / 2), y: GROUND_Y, thick: .12, finish: 'concrete' },
    { rect: r(garOutX - DOOR_W / 2, garOutX + DOOR_W / 2, front - WALL, front), y: GROUND_Y, thick: .12, finish: 'concrete' },
    // Sub-floor & lower flat terrace roofs (strictly separated >= 16-30 mm from Study Room floor [-0.08..0] & ground ceilings [-0.174..-0.150]).
    { rect: r(-h - WALL + .04, h - .02, -h - WALL + .04, h - .02), y: -.096, thick: .09, finish: 'concrete' },
    { rect: r(-h, h, h + WALL, front - WALL), y: -.02, thick: .10, finish: 'roof' },
    { rect: r(hx1 + WALL, bx1, hallEnd + WALL, front - WALL), y: -.02, thick: .10, finish: 'roof' },
    { rect: r(hx1 + WALL, lx1, hallEnd + WALL, front - WALL), y: GROUND_Y, thick: .12, finish: 'terrazzo' },
    { rect: r(hx0, hx1 + WALL, s1, front - WALL), y: GROUND_Y, thick: .12, finish: 'terrazzo' },
    { rect: r(wx0, bx1, hallEnd + WALL, front - WALL), y: GROUND_Y, thick: .12, finish: 'concrete' },
    // Roofs over upper rooms ([3.14 .. 3.34], >= 35-40 mm clear above 3.10 interior ceilings & Study ceiling; balcony stays open to sky).
    { rect: r(-h - WALL, wx1 + WALL, -h - WALL, hallEnd + WALL), y: UPPER_WALL_TOP + .28, thick: .2, finish: 'roof' },
    { rect: r(h, hx1 + WALL, hallEnd + WALL, front), y: UPPER_WALL_TOP + .28, thick: .2, finish: 'roof' },
  ];

  const liv = { x0: lx0, x1: lx1 };
  const roomy = 2 * h >= 5.4;
  const bathR = { x0: lx0, x1: lx1, z0: h + WALL, z1: hallEnd };
  const lob = { x0: hx1 + WALL, x1: lx1, z0: hallEnd + WALL, z1: front - WALL };
  const zMedia = roomy ? Math.min(-1.32, -h + 1.55) : -h + 0.98;

  const blocks: Block[] = [
    { rect: r(hx1, hx1 + WALL, s1 - 1.4, s1), zone: 'stair', label: 'balustrade' },
    // Tempered-glass west partition framing the 1.08 m x 1.12 m open north walk-in shower bay in SE bathroom.
    {
      rect: r(bathR.x1 - 1.16, bathR.x1 - 1.12, bathR.z1 - 1.16, bathR.z1),
      zone: 'bath',
      label: 'shower_glass',
      y: 0,
      topRel: 2.1,
      cameraOccluder: false,
    },
  ];

  const F = (asset: EchoFurnitureAsset, x: number, z: number, y: number, rotY: number, size: number, w: number, d: number, vi: string, en: string): Furnishing =>
    ({ asset, x, z, y, rotY, size, footprint: w > 0 ? r(x - w / 2, x + w / 2, z - d / 2, z + d / 2) : null, label: { vi, en } });
  const furniture: Furnishing[] = [
    // Living room: coaxial sofa + walnut media console (`y = 0..0.55 m`) + eye-level flat-screen TV (`y = 0.55 m`, center `~1.08 m`),
    // keeping >= 0.97..1.10 m behind sofa, >= 2.13 m central lane, and full clearance around bedroom door (`z = 0.38`).
    F('tv-console', liv.x1 - .24, zMedia, 0, -Math.PI / 2, roomy ? 1.56 : 1.28, .44, roomy ? 1.56 : 1.28, 'Kệ tivi gỗ óc chó', 'Walnut media console'),
    F('tv', liv.x1 - .24, zMedia, TV_CONSOLE_TOP_Y, -Math.PI / 2, roomy ? 1.38 : 1.18, .28, roomy ? 1.38 : 1.18, 'Ti vi', 'Television'),
    F('sofa', liv.x0 + (roomy ? 1.55 : 1.42), zMedia, 0, Math.PI / 2, roomy ? 2.05 : 1.5, .9, roomy ? 2.05 : 1.5, 'Ghế sofa', 'Sofa'),
    F('floorlamp', liv.x0 + .42, -h + .36, 0, 0, .5, .4, .4, 'Đèn cây', 'Floor lamp'),
    F('plant', liv.x1 - 1.3, -h + .35, 0, 0, .55, .48, .48, 'Chậu cây', 'Plant'),
    // Kitchen along south wall.
    F('sink', liv.x1 - 2.3, h - .35, 0, Math.PI, 1.2, 1.2, .62, 'Bồn rửa', 'Kitchen sink'),
    F('stove', liv.x1 - 1.35, h - .35, 0, Math.PI, .75, .75, .62, 'Bếp', 'Stove'),
    F('hood', liv.x1 - 1.35, h - .3, 1.75, Math.PI, .76, 0, 0, 'Máy hút mùi', 'Range hood'),
    F('fridge', liv.x1 - .45, h - .4, 0, Math.PI, .8, .8, .72, 'Tủ lạnh', 'Fridge'),
    ...(roomy ? [
      F('table', liv.x0 + 3.0, h - 1.8, 0, 0, 1.1, 1.15, 1.15, 'Bàn ăn', 'Dining table'),
      F('chair', liv.x0 + 2.15, h - 1.8, 0, Math.PI / 2, .5, .5, .5, 'Ghế', 'Chair'),
      F('chair', liv.x0 + 3.85, h - 1.8, 0, -Math.PI / 2, .5, .5, .5, 'Ghế', 'Chair'),
      F('pendant', liv.x0 + 3.0, h - 1.8, 2.05, 0, .9, 0, 0, 'Đèn thả', 'Pendant light'),
    ] : []),
    // Bathroom: SE walk-in shower enclosure (`footprint: null` so porcelain tray is walkable inside) + aligned vanity & toilet.
    F('shower', bathR.x1 - .6, bathR.z1 - .58, 0, -Math.PI / 2, 1.16, 0, 0, 'Vòi sen', 'Shower'),
    F('toilet', bathR.x0 + 1.88, bathR.z1 - .32, 0, Math.PI, .55, .45, .6, 'Bồn cầu', 'Toilet'),
    F('basin', bathR.x0 + 2.72, bathR.z1 - .3, 0, Math.PI, .6, .6, .5, 'Bồn rửa mặt', 'Basin'),
    F('mirror', bathR.x0 + 2.72, bathR.z1 - .03, 1.25, Math.PI, .78, 0, 0, 'Gương', 'Mirror'),
    // Bedroom (V3 home zone).
    F('bed-single', wx0 + 1.15, -h + 1.15, 0, 0, 2.0, 1.15, 2.0, 'Giường ngủ', 'Single bed'),
    F('wardrobe', wx1 - .55, -h + .55, 0, Math.PI, .95, .95, .62, 'Tủ quần áo', 'Wardrobe'),
    F('floorlamp', wx1 - .45, bedSplit - .4, 0, 0, .48, .4, .4, 'Đèn ngủ', 'Bedside lamp'),
    // Terrace Balcony (V3 home zone): veranda table + sittable balcony chair overlooking north river view.
    F('balcony-table', bx0 + 1.65, -h + .72, 0, 0, .72, .72, .72, 'Bàn ban công', 'Veranda table'),
    F('chair', bx0 + 1.65, -h + 1.38, 0, Math.PI, .52, .5, .5, 'Ghế ban công', 'Balcony chair'),
    F('planter-trough', bx1 - .45, bedSplit - .55, 0, -Math.PI / 2, 1.1, .55, 1.05, 'Chậu cây ban công', 'Balcony planter'),
    // Gaming & Tech Studio (V3 home zone).
    F('gaming-desk', wx1 - 1.2, hallEnd - .6, 0, Math.PI, 1.5, 1.5, .78, 'Bàn Gaming Pro', 'Gaming desk'),
    F('gaming-monitor', wx1 - 1.2, hallEnd - .58, .76, Math.PI, .85, 0, 0, 'Màn hình cong 34"', 'Curved monitor'),
    F('gaming-pc', wx1 - .45, hallEnd - .55, .76, Math.PI, .48, 0, 0, 'PC vỏ kính', 'Glass tower PC'),
    F('gaming-chair', wx1 - 1.2, hallEnd - 1.55, 0, 0, .72, .72, .72, 'Ghế Gaming', 'Gaming chair'),
    F('arcade-lamp', wx0 + .5, hallEnd - .5, 0, 0, .5, .45, .45, 'Đèn phòng game', 'Arcade lamp'),
    // Lobby (bench placed along north wall clear of garage door).
    F('mailbox', lob.x0 + 1.1, lob.z0 + .25, GROUND_Y, 0, .55, .5, .4, 'Hộp thư', 'Mailbox'),
    F('mailbox', lob.x0 + 1.75, lob.z0 + .25, GROUND_Y, 0, .55, .5, .4, 'Hộp thư', 'Mailbox'),
    F('bench', lob.x0 + 3.2, lob.z0 + .4, GROUND_Y, 0, 1.45, 1.45, .55, 'Ghế băng', 'Bench'),
    F('plant', entranceX - 1.2, lob.z1 - .35, GROUND_Y, 0, .55, .45, .45, 'Chậu cây', 'Plant'),
    F('plant', hx1 - .35, -h + .35, 0, 0, .5, .4, .4, 'Chậu cây', 'Plant'),
    // Personal Garage (V3 home zone).
    F('workbench', wx0 + 1.4, hallEnd + WALL + .6, GROUND_Y, 0, 1.75, 1.75, .8, 'Bàn sửa chữa', 'Garage workbench'),
    F('bicycle', bx1 - .85, hallEnd + WALL + 1.3, GROUND_Y, -Math.PI / 2, 1.7, .7, 1.7, 'Xe đạp', 'Student bicycle'),
    F('car-hatch', bx1 - 1.6, front - WALL - 2.35, GROUND_Y, Math.PI, 3.6, 1.9, 3.6, 'Ô tô gia đình', 'Compact hatchback'),
  ];

  return {
    h, zones, doors, walls, slabs, blocks, furniture,
    passages: [
      { rect: r(hx1 - .32, lx0 + .32, arch.from + .02, arch.to - .02), y: 0 },
      // Seamless open passage between living room and kitchen.
      { rect: r(lx0 + .02, lx1 - .02, kitchenZ - .35, kitchenZ + .35), y: 0 },
    ],
    stair: { rect: r(hx0, hx1, s0, s1), y0: 0, y1: GROUND_Y, steps },
    footprint: r(-h - WALL, bx1 + WALL, -h - WALL, front),
    front,
    rooms: [
      { id: 'hall', rect: zones[0].rect, y: 0 },
      { id: 'living', rect: zones[1].rect, y: 0 },
      { id: 'kitchen', rect: zones[2].rect, y: 0 },
      { id: 'bath', rect: zones[3].rect, y: 0 },
      { id: 'bedroom', rect: zones[4].rect, y: 0 },
      { id: 'gaming_room', rect: zones[6].rect, y: 0 },
      { id: 'lobby', rect: zones[8].rect, y: GROUND_Y },
      { id: 'garage', rect: zones[10].rect, y: GROUND_Y },
      { id: 'stair', rect: r(hx0, hx1, hallEnd + WALL, front - WALL), y: 0 },
    ],
  };
}

/** Height of a zone's floor at (x, z). */
export function zoneY(zone: Pick<Zone, 'rect' | 'y' | 'y1' | 'along'>, z: number, x?: number) {
  if (zone.y1 === undefined) return zone.y;
  const k = zone.along === 'x' && x !== undefined
    ? Math.min(1, Math.max(0, (x - zone.rect.x0) / (zone.rect.x1 - zone.rect.x0)))
    : Math.min(1, Math.max(0, (z - zone.rect.z0) / (zone.rect.z1 - zone.rect.z0)));
  return zone.y + (zone.y1 - zone.y) * k;
}

/** The house zone whose floor holds (x, z). */
export function houseZoneAt(plan: HousePlan, p: { x: number; z: number }, pad = BODY_RADIUS): Zone | null {
  for (const zone of plan.zones) if (inRect(p, zone.rect, pad)) return zone;
  return null;
}

/** Door strips that let the body through: only while the leaf is open. */
export function doorAt(plan: HousePlan, p: { x: number; z: number }, open: () => ReadonlySet<string>): Door | null {
  for (const d of plan.doors) if (inRect(p, d.corridor) && open().has(d.id)) return d;
  return null;
}

/** `rHigh`-padded center corridor (`DOOR_W / 2 - rHigh` half-width) keeping shoulders clear of doorway jambs. */
export function doorCenterCorridor(door: Door, rHigh = PLAYER_R_HIGH): Rect {
  const half = Math.max(0.14, door.width * 0.5 - rHigh);
  const reach = WALL * 0.5 + 0.34;
  return door.wallAlong === 'z'
    ? r(door.x - reach, door.x + reach, door.z - half, door.z + half)
    : r(door.x - half, door.x + half, door.z - reach, door.z + reach);
}

/**
 * Pure geometric guard-zone test (`paddedCorridor ∪ leafSweepSector`) for non-clipping physical doors.
 * Returns `true` when a capsule of `radius` at `(x, z)` overlaps either the padded doorway threshold corridor
 * or the arc swept by the swinging door leaf from its hinge (preventing premature auto-close onto a player/NPC).
 */
export function isPointInDoorGuardZone(
  door: Door,
  x: number,
  z: number,
  radius = PLAYER_R_HIGH,
  currentAngle = 0,
): boolean {
  const rPad = Math.max(0, radius);
  if (
    x >= door.corridor.x0 - rPad &&
    x <= door.corridor.x1 + rPad &&
    z >= door.corridor.z0 - rPad &&
    z <= door.corridor.z1 + rPad
  ) {
    return true;
  }

  const sinY = Math.sin(door.yaw);
  const cosY = Math.cos(door.yaw);
  const rightX = cosY;
  const rightZ = -sinY;
  const frameX = door.x - sinY * 0.08;
  const frameZ = door.z - cosY * 0.08;
  const hingeX = frameX + rightX * (-door.width * 0.5 + 0.02) + sinY * 0.03;
  const hingeZ = frameZ + rightZ * (-door.width * 0.5 + 0.02) + cosY * 0.03;

  const dx = x - hingeX;
  const dz = z - hingeZ;
  const leafLen = door.width + 0.04;
  const maxR = leafLen + rPad;
  if (dx * dx + dz * dz > maxR * maxR) return false;

  const u = dx * rightX + dz * rightZ;
  const v = dx * sinY + dz * cosY;
  if (u < -rPad) return false;

  if (Math.abs(currentAngle) > 0.02) {
    return currentAngle < 0 ? v >= -rPad : v <= rPad;
  }
  return Math.abs(v) <= leafLen + rPad;
}

/** Canonical world-space screen-center look target (`y ≈ 1.00-1.08 m`) for Watch TV in the starter house living room. */
export function livingTvLookTarget(plan: Pick<HousePlan, 'h' | 'furniture' | 'zones'>): { x: number; y: number; z: number } {
  const tv = plan.furniture.find((f) => f.asset === 'tv');
  if (tv) {
    const scale = tv.size / 1.3;
    return {
      x: tv.x - 0.05,
      y: tv.y + 0.5 * scale,
      z: tv.z,
    };
  }
  const roomy = 2 * plan.h >= 5.4;
  const liv = plan.zones.find((z) => z.id === 'living')?.rect;
  const lx1 = liv ? liv.x1 : plan.h + WALL + 2.0 + WALL + 4.6;
  const zMedia = roomy ? Math.min(-1.32, -plan.h + 1.55) : -plan.h + 0.98;
  return {
    x: lx1 - 0.29,
    y: roomy ? 1.081 : 1.004,
    z: zMedia,
  };
}
