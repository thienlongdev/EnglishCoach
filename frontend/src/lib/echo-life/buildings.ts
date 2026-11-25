/**
 * Echo Life — all 13 enterable city buildings across the 31-zone open world.
 *
 * Pure geometry and furnishing plans in the same stage metres as `plan.ts` and `city.ts`: every enterable building
 * owns its exterior walls, windows, roof, interior floor(s), optional staircase to an upper mezzanine gallery
 * (`library`, `furniture_shop`), ceiling light anchors, curated multi-library furniture footprints, and one real
 * physical swinging `LifeDoor` (`city:<zoneId>`).
 *
 * All walkable interior zones (including two-storey stairs and upper galleries) remain disjoint in plan view so
 * `LifeWalk` resolves floor height unambiguously at every (x, z) with zero teleports.
 */
import {
  DOOR_H, DOOR_W, GROUND_Y, TV_CONSOLE_TOP_Y, WALL,
  type Block, type Door, type EchoFurnitureAsset, type Furnishing, type Rect, type Slab, type Stair, type Text, type WallSpan,
  inRect, rect as r,
} from './plan';
import {
  buildBuildingAaaLayout,
  type AaaSeatSpec,
  type BuildingAaaLayout,
} from './aaaBuildingLayout';

export type BuildingZoneId =
  | 'linh' | 'minh' | 'cafe' | 'bistro'
  | 'market' | 'electronics_shop' | 'furniture_shop' | 'clothing_shop'
  | 'vehicle_dealer' | 'home_center' | 'repair_shop'
  | 'library' | 'atelier' | 'living';

export type DistrictName = 'Home' | 'Neighborhood' | 'Shopping Row' | 'Campus' | 'Parks & River' | 'Hidden Gems';

export interface BuildingZone {
  id: string;
  /** Canonical V3 zone ID (all rooms/stairs/mezzanines inside a building map to its V3 zone ID). */
  zoneId: BuildingZoneId;
  rect: Rect;
  y: number;
  y1?: number;
  along?: 'z' | 'x';
  ceiling: number | null;
  name: Text;
}

export interface EnterableBuilding {
  property?: {id:string; model:string; lot:string};
  id: BuildingZoneId;
  district: DistrictName;
  chunkId: string;
  name: Text;
  rect: Rect;
  facing: 'north' | 'south';
  storeys: number;
  wallColor: string;
  interiorColor: string;
  accentColor: string;
  floorFinish: Slab['finish'];
  /** Optional distant architectural LOD asset used while chunk is WARM. */
  lodAsset?: string;
  door: Door;
  zones: BuildingZone[];
  passages: { rect: Rect; y: number }[];
  stair?: Stair;
  blocks: Block[];
  walls: WallSpan[];
  slabs: Slab[];
  furniture: Furnishing[];
  fixtures: { x: number; y: number; z: number }[];
  /** Shared deterministic AAA interior/exterior visual placements, 67 height-banded blocks, and 35 usable seats. */
  aaaLayout: BuildingAaaLayout;
  aaaSeats: AaaSeatSpec[];
  /** Guaranteed clear interior point just inside the door (for reachability verification). */
  entryPoint: { x: number; z: number };
  /** Guaranteed clear outdoor approach point on the sidewalk outside the door. */
  outsidePoint: { x: number; z: number };
}

interface Spec {
  id: BuildingZoneId;
  district: DistrictName;
  chunkId: string;
  name: Text;
  rect: Rect;
  facing: 'north' | 'south';
  twoStorey?: boolean;
  wallColor: string;
  interiorColor: string;
  accentColor: string;
  floorFinish: Slab['finish'];
  lodAsset?: string;
  furnish: (ctx: {
    ix0: number; ix1: number; iz0: number; iz1: number;
    cx: number; cz: number; doorX: number; doorZ: number;
    y0: number; upper?: { rect: Rect; y: number };
  }) => Furnishing[];
}

const F = (asset: EchoFurnitureAsset, x: number, z: number, y: number, rotY: number, size: number, w: number, d: number, vi: string, en: string): Furnishing =>
  ({ asset, x, z, y, rotY, size, footprint: w > 0 ? r(x - w / 2, x + w / 2, z - d / 2, z + d / 2) : null, label: { vi, en } });

function makeBuilding(s: Spec): EnterableBuilding {
  const { x0, x1, z0, z1 } = s.rect;
  const ix0 = x0 + WALL, ix1 = x1 - WALL, iz0 = z0 + WALL, iz1 = z1 - WALL;
  const cx = (ix0 + ix1) / 2;
  const cz = (iz0 + iz1) / 2;
  const y0 = GROUND_Y;
  const ceilH = 3.35;
  const two = !!s.twoStorey;
  const upperRise = 2.6;
  const upperY = y0 + upperRise;
  const roofY = two ? upperY + 3.0 : y0 + ceilH;

  // Door centred on the street-facing wall (north wall = z0, south wall = z1).
  const doorX = cx;
  const doorZ = s.facing === 'north' ? z0 + WALL / 2 : z1 - WALL / 2;
  // yaw = 0 swings into +z (south); yaw = PI swings into -z (north).
  const doorYaw = s.facing === 'north' ? 0 : Math.PI;
  const door: Door = {
    id: `city:${s.id}`,
    wallAlong: 'x',
    x: doorX, z: doorZ, y: y0,
    width: DOOR_W, height: DOOR_H,
    yaw: doorYaw,
    corridor: s.facing === 'north'
      ? r(doorX - DOOR_W / 2 + .02, doorX + DOOR_W / 2 - .02, z0 - .35, iz0 + .35)
      : r(doorX - DOOR_W / 2 + .02, doorX + DOOR_W / 2 - .02, iz1 - .35, z1 + .35),
    name: { vi: `Cửa ${s.name.vi}`, en: `${s.name.en} door` },
  };
  const doorOpen = { from: doorX - DOOR_W / 2, to: doorX + DOOR_W / 2, top: DOOR_H };

  // Display windows flanking the door on the street façade (guaranteed >= 0.4 m jamb from door and corners).
  const frontOpenings: WallSpan['openings'] = [doorOpen];
  const leftSpan = (doorX - DOOR_W / 2) - ix0;
  if (leftSpan >= 2.2) frontOpenings.push({ from: ix0 + .5, to: doorX - DOOR_W / 2 - .5, top: 2.55, bottom: .75 });
  const rightSpan = ix1 - (doorX + DOOR_W / 2);
  if (rightSpan >= 2.2) frontOpenings.push({ from: doorX + DOOR_W / 2 + .5, to: ix1 - .5, top: 2.55, bottom: .75 });

  // Back wall & side windows.
  const backOpenings: WallSpan['openings'] = [];
  if (ix1 - ix0 >= 7) {
    backOpenings.push({ from: ix0 + 1.0, to: cx - 1.0, top: 2.5, bottom: 1.0 });
    backOpenings.push({ from: cx + 1.0, to: ix1 - 1.0, top: 2.5, bottom: 1.0 });
  }
  const sideOpenings: WallSpan['openings'] = [];
  if (iz1 - iz0 >= 7) sideOpenings.push({ from: cz - 1.6, to: cz + 1.6, top: 2.5, bottom: 1.0 });

  const walls: WallSpan[] = [];
  const slabs: Slab[] = [];
  const zones: BuildingZone[] = [];
  const blocks: Block[] = [];
  const passages: { rect: Rect; y: number }[] = [];
  let stair: Stair | undefined;
  let upperInfo: { rect: Rect; y: number } | undefined;

  // Four perimeter walls.
  walls.push(
    { x0, x1, z0, z1: iz0, y0, y1: roofY, openings: s.facing === 'north' ? frontOpenings : backOpenings, face: 'exterior', finish: 'plaster' },
    { x0, x1, z0: iz1, z1, y0, y1: roofY, openings: s.facing === 'south' ? frontOpenings : backOpenings, face: 'exterior', finish: 'plaster' },
    { x0, x1: ix0, z0, z1, y0, y1: roofY, openings: sideOpenings, face: 'exterior', finish: 'plaster' },
    { x0: ix1, x1, z0, z1, y0, y1: roofY, openings: sideOpenings, face: 'exterior', finish: 'plaster' },
  );

  // Threshold slab under door so Rapier has zero crack between sidewalk and interior floor.
  slabs.push({
    rect: s.facing === 'north' ? r(doorX - DOOR_W / 2, doorX + DOOR_W / 2, z0, iz0) : r(doorX - DOOR_W / 2, doorX + DOOR_W / 2, iz1, z1),
    y: y0, thick: .12, finish: s.floorFinish,
  });

  if (two) {
    // Multi-floor layout (100% disjoint in plan view!):
    // Front 60% = main ground hall; Rear 40% = elevated mezzanine gallery (y = upperY) over a walled rear service core;
    // West/East side strip along the rear edge = 14-step straight staircase climbing from main hall to upper gallery!
    const stairW = 1.7;
    const stairLen = 4.2; // 14 steps x 0.30 m run, 0.186 m rise
    const splitZ = s.facing === 'north' ? iz1 - 4.0 : iz0 + 4.0;
    const mainRect = s.facing === 'north' ? r(ix0, ix1, iz0, splitZ) : r(ix0, ix1, splitZ, iz1);
    const upperRect = s.facing === 'north' ? r(ix0 + stairW + WALL, ix1, splitZ + WALL, iz1) : r(ix0 + stairW + WALL, ix1, iz0, splitZ - WALL);
    // Stair runs along Z from main hall up to the landing beside upperRect!
    const stairRect = s.facing === 'north'
      ? r(ix0, ix0 + stairW, splitZ - stairLen, splitZ)
      : r(ix0, ix0 + stairW, splitZ, splitZ + stairLen);
    const landingRect = s.facing === 'north'
      ? r(ix0, ix0 + stairW + WALL, splitZ, iz1)
      : r(ix0, ix0 + stairW + WALL, iz0, splitZ);
    // Carve the stair strip out of mainRect so ground & stair zones stay 100% disjoint!
    const mainFront = s.facing === 'north'
      ? r(ix0, ix1, iz0, splitZ - stairLen)
      : r(ix0, ix1, splitZ + stairLen, iz1);
    const mainSide = s.facing === 'north'
      ? r(ix0 + stairW + WALL, ix1, splitZ - stairLen, splitZ)
      : r(ix0 + stairW + WALL, ix1, splitZ, splitZ + stairLen);

    zones.push(
      { id: `${s.id}:main`, zoneId: s.id, rect: mainFront, y: y0, ceiling: roofY - y0, name: s.name },
      { id: `${s.id}:hall`, zoneId: s.id, rect: mainSide, y: y0, ceiling: roofY - y0, name: s.name },
      {
        id: `${s.id}:stair`, zoneId: s.id, rect: stairRect,
        y: s.facing === 'north' ? y0 : upperY,
        y1: s.facing === 'north' ? upperY : y0,
        ceiling: null,
        name: { vi: `Cầu thang ${s.name.vi}`, en: `${s.name.en} staircase` },
      },
      { id: `${s.id}:landing`, zoneId: s.id, rect: landingRect, y: upperY, ceiling: roofY - upperY, name: { vi: `Tầng 2 ${s.name.vi}`, en: `${s.name.en} upper floor` } },
      { id: `${s.id}:upper`, zoneId: s.id, rect: upperRect, y: upperY, ceiling: roofY - upperY, name: { vi: `Tầng 2 ${s.name.vi}`, en: `${s.name.en} upper gallery` } },
    );
    stair = {
      rect: stairRect,
      y0: s.facing === 'north' ? y0 : upperY,
      y1: s.facing === 'north' ? upperY : y0,
      steps: 14,
    };
    // Seamless floor bridges between disjoint rects of the same height.
    passages.push(
      { rect: r(ix0 + stairW + WALL + .02, ix1 - .02, (s.facing === 'north' ? splitZ - stairLen : splitZ + stairLen) - .35, (s.facing === 'north' ? splitZ - stairLen : splitZ + stairLen) + .35), y: y0 },
      { rect: r(ix0 + stairW - .35, ix0 + stairW + WALL + .35, upperRect.z0 + .1, upperRect.z1 - .1), y: upperY },
    );
    // Walled balustrade separating stair from adjacent ground hall + low railing at mezzanine edge overlooking main hall!
    walls.push(
      { x0: ix0 + stairW, x1: ix0 + stairW + WALL, z0: stairRect.z0, z1: stairRect.z1, y0, y1: upperY + 0.95, openings: [], face: 'interior', finish: 'plaster' },
      // Solid lower wall under the mezzanine front face + 1.0 m safety railing on the upper gallery edge!
      { x0: ix0 + stairW, x1: ix1, z0: s.facing === 'north' ? splitZ : splitZ - WALL, z1: s.facing === 'north' ? splitZ + WALL : splitZ, y0, y1: upperY + 1.0, openings: [], face: 'interior', finish: 'plaster' },
    );
    slabs.push(
      { rect: mainFront, y: y0, thick: .12, finish: s.floorFinish },
      { rect: mainSide, y: y0, thick: .12, finish: s.floorFinish },
      { rect: landingRect, y: upperY, thick: .14, finish: 'oak' },
      { rect: upperRect, y: upperY, thick: .14, finish: 'oak' },
      { rect: s.rect, y: roofY + .18, thick: .22, finish: 'roof' },
    );
    upperInfo = { rect: upperRect, y: upperY };
  } else {
    zones.push({ id: `${s.id}:main`, zoneId: s.id, rect: r(ix0, ix1, iz0, iz1), y: y0, ceiling: ceilH, name: s.name });
    slabs.push(
      { rect: r(ix0, ix1, iz0, iz1), y: y0, thick: .12, finish: s.floorFinish },
      { rect: s.rect, y: roofY + .18, thick: .22, finish: 'roof' },
    );
  }

  const furniture = s.furnish({ ix0, ix1, iz0, iz1, cx, cz, doorX, doorZ, y0, upper: upperInfo });
  const aaaLayout = buildBuildingAaaLayout({
    id: s.id,
    rect: s.rect,
    facing: s.facing,
    twoStorey: two,
  });
  blocks.push(...aaaLayout.blocks);
  const fixtures: { x: number; y: number; z: number }[] = [
    { x: cx, y: (two ? roofY : y0 + ceilH) - .25, z: s.facing === 'north' ? iz0 + 2.4 : iz1 - 2.4 },
    { x: cx, y: (two ? roofY : y0 + ceilH) - .25, z: s.facing === 'north' ? iz1 - 2.4 : iz0 + 2.4 },
  ];
  const entryPoint = { x: doorX, z: s.facing === 'north' ? iz0 + 1.35 : iz1 - 1.35 };
  const outsidePoint = { x: doorX, z: s.facing === 'north' ? z0 - 1.25 : z1 + 1.25 };

  return {
    id: s.id,
    district: s.district,
    chunkId: s.chunkId,
    name: s.name,
    rect: s.rect,
    facing: s.facing,
    storeys: two ? 2 : 1,
    wallColor: s.wallColor,
    interiorColor: s.interiorColor,
    accentColor: s.accentColor,
    floorFinish: s.floorFinish,
    lodAsset: s.lodAsset,
    door, zones, passages, stair, blocks, walls, slabs, furniture, fixtures,
    aaaLayout,
    aaaSeats: aaaLayout.seats,
    entryPoint, outsidePoint,
  };
}

export interface CityAnchors {
  xW2: number; xW1: number; xE1: number; xE2: number; xE3: number;
  n3: number; front: number; s3: number; m0: number;
}

// The original student flat uses the house plan. Each purchased home has a permanent address on Market Boulevard.
// The furnished entrance wing adjoins the original workshop model on the same plot.
const homeDesigns = [
  ['cozy_townhouse','Cozy Townhouse','#e7c9ae','#785344','sofa_tufted_warm','bed_single_engawa','bookcase_engawa'],
  ['japandi_retreat','Japandi Courtyard','#e0d8c7','#526148','sofa_fjord','bed_single_fjord','bookcase_fjord'],
  ['tropical_villa','Palm Atrium Villa','#ebdfbf','#36706a','sofa_veranda','bed_king_veranda','bookcase_veranda'],
  ['riviera_mansion','Riviera Art Deco Mansion','#dad7ce','#375579','sofa_arcade','bed_king_arcade','bookcase_arcade'],
  ['grand_palais','Grand Pavillon Royal Estate','#eee3d4','#a78753','sofa_palais','bed_canopy_palais','bookcase_palais'],
] as const;

export function buildResidences(lots: readonly {id:string;rect:Rect;chunkId:string}[]):EnterableBuilding[] {
  return homeDesigns.map(([slug,name,wall,accent,sofa,bed,shelf],index)=>{
    const lot=lots.find(l=>l.id==='south-fringe-'+index)!;
    const rect=r(lot.rect.x0,lot.rect.x0+8.5+index*.75,lot.rect.z0-1,lot.rect.z1);
    const home=makeBuilding({id:'living',district:'Home',chunkId:lot.chunkId,name:{vi:name,en:name},rect,
      facing:'north',twoStorey:true,wallColor:wall,interiorColor:wall,accentColor:accent,
      floorFinish:index>1?'terrazzo':'oak',
      furnish:({ix0,ix1,iz0,cz,y0,upper})=>[
        F(sofa,ix0+1.2,iz0+2.1,y0,Math.PI/2,1.9,.85,1.9,'Sofa','Sofa'),
        F('table',ix1-1.5,iz0+2.5,y0,0,1.3,1.3,.8,'Bàn ăn','Dining table'),
        F('chair',ix1-1.5,iz0+1.75,y0,0,.52,.5,.5,'Ghế ăn','Dining chair'),
        F('chair',ix1-1.5,iz0+3.25,y0,Math.PI,.52,.5,.5,'Ghế ăn','Dining chair'),
        F('stove',ix1-.7,cz,y0,-Math.PI/2,1,.8,1,'Bếp','Stove'),
        F(bed,upper!.rect.x1-1.3,upper!.rect.z1-1.2,upper!.y,Math.PI,2.1,1.6,2.1,'Giường','Bed'),
        F(shelf,upper!.rect.x0+1.15,upper!.rect.z1-.45,upper!.y,Math.PI,1.35,1.35,.55,'Kệ sách','Bookcase'),
      ]});
    home.property={id:'prop_'+slug,model:'res_'+slug,lot:lot.id};
    home.door.id='city:'+home.property.id;
    return home;
  });
}

/** Builds all 13 enterable city buildings positioned cleanly against the city's streets and sidewalks. */
export function buildCityBuildings(a: CityAnchors): EnterableBuilding[] {
  const { xW2, xW1, xE1, xE2, n3, front, s3, m0 } = a;
  const specs: Spec[] = [
    // ── NEIGHBORHOOD (4 enterable buildings) ──
    {
      id: 'linh', district: 'Neighborhood', chunkId: 'neighborhood-west',
      name: { vi: 'Nhà của Linh', en: 'Linh’s House' },
      rect: r(xW1 - 12, xW1 - 2, front - 8.5, front),
      facing: 'south', wallColor: '#e8d7be', interiorColor: '#f5ede0', accentColor: '#7a5230', floorFinish: 'oak', lodAsset: 'bld-sub-a',
      furnish: ({ ix0, ix1, iz0, y0 }) => [
        F('sofa', ix1 - 2.1, iz0 + 1.5, y0, 0, 2.0, 2.0, .95, 'Ghế sofa', 'Sofa'),
        F('art-easel', ix0 + 1.5, iz0 + 1.8, y0, Math.PI * .2, 1.05, .95, .8, 'Giá vẽ của Linh', 'Linh’s easel'),
        F('table', ix0 + 1.8, iz0 + 4.0, y0, 0, 1.15, 1.15, 1.15, 'Bàn trà', 'Study table'),
        F('plant', ix1 - .7, iz0 + 4.1, y0, 0, .6, .5, .5, 'Chậu cây', 'Plant'),
      ],
    },
    {
      id: 'minh', district: 'Neighborhood', chunkId: 'neighborhood-west',
      name: { vi: 'Nhà của Minh', en: 'Minh’s House' },
      rect: r(xW1 - 25, xW1 - 15, front - 8.5, front),
      facing: 'south', wallColor: '#d7ddd4', interiorColor: '#edf0ea', accentColor: '#3d5a45', floorFinish: 'oak', lodAsset: 'bld-sub-c',
      furnish: ({ ix0, ix1, iz0, y0 }) => [
        F('bench-cushion', ix1 - 1.9, iz0 + 1.5, y0, 0, 1.3, 1.3, .55, 'Ghế đệm', 'Cushion bench'),
        F('guitar-electric', ix0 + 1.3, iz0 + 1.5, y0, Math.PI * .25, .9, .7, .7, 'Guitar điện', 'Electric guitar'),
        F('gaming-desk', ix0 + 2.0, iz0 + 4.1, y0, Math.PI / 2, 1.45, .8, 1.45, 'Bàn học của Minh', 'Minh’s desk'),
        F('gaming-monitor', ix0 + 1.9, iz0 + 4.1, y0 + .76, Math.PI / 2, .8, 0, 0, 'Màn hình', 'Monitor'),
      ],
    },
    {
      id: 'cafe', district: 'Neighborhood', chunkId: 'neighborhood-south',
      name: { vi: 'Pixel Café', en: 'Pixel Café' },
      rect: r(xW1 + 14, xW1 + 26, s3, s3 + 10.5),
      facing: 'north', wallColor: '#344158', interiorColor: '#dde3ee', accentColor: '#3b2156', floorFinish: 'tile', lodAsset: 'bld-shophouse-lod',
      furnish: ({ ix0, ix1, iz0, iz1, y0 }) => [
        F('gaming-desk', ix0 + 2.0, iz1 - 1.6, y0, 0, 1.5, 1.5, .8, 'Máy Gaming A', 'Gaming station A'),
        F('gaming-monitor', ix0 + 2.0, iz1 - 1.6, y0 + .76, 0, .85, 0, 0, 'Màn hình cong', 'Curved monitor'),
        F('gaming-chair', ix0 + 2.0, iz1 - 2.6, y0, Math.PI, .72, .72, .72, 'Ghế Gaming', 'Gaming chair'),
        F('gaming-desk', ix1 - 2.0, iz1 - 1.6, y0, 0, 1.5, 1.5, .8, 'Máy Gaming B', 'Gaming station B'),
        F('gaming-monitor', ix1 - 2.0, iz1 - 1.6, y0 + .76, 0, .85, 0, 0, 'Màn hình cong', 'Curved monitor'),
        F('gaming-chair', ix1 - 2.0, iz1 - 2.6, y0, Math.PI, .72, .72, .72, 'Ghế Gaming', 'Gaming chair'),
        F('cafe-booth', ix0 + 1.5, iz0 + 4.2, y0, Math.PI / 2, 1.6, .8, 1.6, 'Ghế booth', 'Café lounge booth'),
        F('arcade-lamp', ix1 - .9, iz0 + 3.5, y0, 0, .5, .45, .45, 'Đèn neon', 'Arcade lamp'),
      ],
    },
    {
      id: 'bistro', district: 'Neighborhood', chunkId: 'neighborhood-south',
      name: { vi: 'Willow Corner Bistro', en: 'Willow Corner Bistro' },
      rect: r(xW1 + 28, xW1 + 40, s3, s3 + 10.5),
      facing: 'north', wallColor: '#d9bfa0', interiorColor: '#f5eadb', accentColor: '#5a3a26', floorFinish: 'oak', lodAsset: 'bld-sub-h',
      furnish: ({ ix0, ix1, iz0, iz1, cx, y0 }) => [
        F('crepe-kiosk', cx, iz1 - 1.6, y0, Math.PI, 2.2, 2.2, 1.1, 'Quầy bánh và trà', 'Bistro counter'),
        F('espresso', ix0 + 1.5, iz1 - 1.5, y0, Math.PI, .95, .9, .7, 'Máy pha espresso', 'Espresso bar'),
        F('patisserie-case', ix1 - 1.6, iz1 - 1.5, y0, Math.PI, 1.25, 1.2, .75, 'Tủ bánh ngọt', 'Patisserie case'),
        F('cafe-booth', ix0 + 1.5, iz0 + 4.0, y0, Math.PI / 2, 1.6, .8, 1.6, 'Bàn đôi', 'Bistro booth'),
        F('cafe-booth', ix1 - 1.5, iz0 + 4.0, y0, -Math.PI / 2, 1.6, .8, 1.6, 'Bàn đôi', 'Bistro booth'),
        F('tea-service', ix1 - 3.35, iz0 + 4.0, y0, 0, .85, .8, .65, 'Bộ ấm trà', 'Tea table'),
      ],
    },

    // ── SHOPPING ROW / COMMERCIAL (7 enterable stores, incl. 2-storey Furniture Showroom) ──
    {
      id: 'market', district: 'Shopping Row', chunkId: 'shopping-south',
      name: { vi: 'Siêu thị Sunrise Market', en: 'Sunrise Market' },
      rect: r(xE1 + 14, xE1 + 28, s3, s3 + 12),
      facing: 'north', wallColor: '#dce6d8', interiorColor: '#f3f5f0', accentColor: '#1f5135', floorFinish: 'terrazzo', lodAsset: 'bld-dorm-lod',
      furnish: ({ ix0, ix1, iz0, iz1, y0 }) => [
        F('market-shelf', ix0 + 2.4, iz0 + 4.2, y0, 0, 2.4, 2.4, .95, 'Kệ hàng A', 'Market aisle shelf'),
        F('market-shelf', ix0 + 2.4, iz1 - 2.6, y0, 0, 2.4, 2.4, .95, 'Kệ hàng B', 'Market aisle shelf'),
        F('market-checkout', ix1 - 2.4, iz0 + 4.2, y0, -Math.PI / 2, 1.7, 1.0, 1.7, 'Quầy thu ngân', 'Checkout counter'),
        F('patisserie-case', ix1 - 2.4, iz1 - 2.4, y0, Math.PI, 1.35, 1.3, .75, 'Quầy bánh tươi', 'Bakery case'),
      ],
    },
    {
      id: 'electronics_shop', district: 'Shopping Row', chunkId: 'shopping-west',
      name: { vi: 'Volt and Silicon Electronics', en: 'Volt and Silicon Electronics' },
      rect: r(xW2 + 14, xW2 + 26, s3, s3 + 11),
      facing: 'north', wallColor: '#b7c7d8', interiorColor: '#eaedf2', accentColor: '#1d3b5c', floorFinish: 'tile', lodAsset: 'bld-shophouse-lod',
      furnish: ({ ix0, ix1, iz0, iz1, cx, y0 }) => [
        F('gaming-desk', cx, iz1 - 1.6, y0, Math.PI, 1.8, 1.8, .85, 'Quầy tư vấn', 'Electronics counter'),
        F('gaming-pc', ix0 + 1.8, iz1 - 2.0, y0, 0, .75, .75, .75, 'Dàn PC trưng bày', 'Display glass PC'),
        F('gaming-desk', ix0 + 1.8, iz0 + 4.2, y0, Math.PI / 2, 1.45, .8, 1.45, 'Bàn trưng bày màn hình', 'Display desk'),
        F('gaming-monitor', ix0 + 1.8, iz0 + 4.2, y0 + .76, Math.PI / 2, 1.15, 0, 0, 'Màn hình lập trình', 'Coding display'),
        F('tv-console', ix1 - 1.55, iz0 + 4.4, y0, -Math.PI / 2, 1.6, .46, 1.6, 'Kệ trưng bày tivi', 'TV display console'),
        F('tv', ix1 - 1.55, iz0 + 4.4, y0 + TV_CONSOLE_TOP_Y, -Math.PI / 2, 1.42, 0, 0, 'Smart TV 55"', 'Smart TV 55"'),
        F('display-cabinet', ix1 - 1.8, iz1 - 1.8, y0, Math.PI, 1.3, 1.3, .65, 'Tủ linh kiện', 'Parts showcase'),
      ],
    },
    {
      id: 'furniture_shop', district: 'Shopping Row', chunkId: 'shopping-west',
      name: { vi: 'Riverside Living and Atelier', en: 'Riverside Living and Atelier' },
      rect: r(xW2 + 28, xW2 + 41, s3, s3 + 13),
      facing: 'north', twoStorey: true, wallColor: '#e2d4c2', interiorColor: '#f6f0e6', accentColor: '#6d4c33', floorFinish: 'oak', lodAsset: 'bld-teacourt-lod',
      furnish: ({ ix0, ix1, iz0, y0, upper }) => [
        // Ground-floor living showroom.
        F('sofa', ix1 - 2.6, iz0 + 3.6, y0, -Math.PI / 2, 2.2, 1.05, 2.2, 'Sofa Veranda', 'Veranda sofa'),
        F('table', ix0 + 4.4, iz0 + 4.2, y0, 0, 1.25, 1.25, 1.25, 'Bàn phòng khách', 'Showroom table'),
        F('chair', ix0 + 4.4, iz0 + 5.7, y0, Math.PI, .6, .55, .55, 'Ghế gỗ', 'Showroom chair'),
        F('display-cabinet', ix1 - 2.2, iz0 + 6.8, y0, Math.PI, 1.4, 1.4, .7, 'Tủ trưng bày', 'Display cabinet'),
        // Second-floor bedroom gallery reached via the interior staircase!
        ...(upper ? [
          F('canopy-bed', upper.rect.x1 - 2.2, (upper.rect.z0 + upper.rect.z1) / 2, upper.y, -Math.PI / 2, 2.1, 1.75, 2.0, 'Giường màn Palais', 'Canopy bed'),
          F('floorlamp', upper.rect.x0 + 1.2, upper.rect.z1 - .8, upper.y, 0, .5, .45, .45, 'Đèn sàn', 'Floor lamp'),
        ] : []),
      ],
    },
    {
      id: 'clothing_shop', district: 'Shopping Row', chunkId: 'shopping-west',
      name: { vi: 'Thread and Campus Apparel', en: 'Thread and Campus Apparel' },
      rect: r(xW2 + 14, xW2 + 25, m0 - 11, m0),
      facing: 'south', wallColor: '#e7d6cc', interiorColor: '#faf2ec', accentColor: '#7a4253', floorFinish: 'oak', lodAsset: 'bld-sub-e',
      furnish: ({ ix0, ix1, iz0, cx, y0 }) => [
        F('bench-cushion', cx, iz0 + 1.8, y0, 0, 1.3, 1.3, .55, 'Quầy thử đồ', 'Entry bench'),
        F('garment-rack', ix0 + 2.2, iz0 + 4.6, y0, 0, 1.15, 1.05, 1.05, 'Giá treo đồ trái', 'Garment carousel'),
        F('garment-rack', ix1 - 2.2, iz0 + 4.6, y0, 0, 1.15, 1.05, 1.05, 'Giá treo đồ phải', 'Garment carousel'),
        F('mirror', cx, iz0 + .15, y0 + 1.2, 0, 1.0, 0, 0, 'Gương thử đồ', 'Fitting mirror'),
      ],
    },
    {
      id: 'vehicle_dealer', district: 'Shopping Row', chunkId: 'shopping-west',
      name: { vi: 'Greenway Motors and Cycles', en: 'Greenway Motors and Cycles' },
      rect: r(xW2 + 27, xW2 + 42, m0 - 12, m0),
      facing: 'south', wallColor: '#c3ccd0', interiorColor: '#edf1f3', accentColor: '#264653', floorFinish: 'terrazzo', lodAsset: 'bld-dorm-lod',
      furnish: ({ ix0, ix1, iz0, cx, y0 }) => [
        F('gaming-desk', cx, iz0 + 1.4, y0, 0, 1.5, 1.5, .75, 'Bàn tư vấn xe', 'Dealer desk'),
        F('car-spider', cx, iz0 + 5.2, y0, Math.PI / 2, 3.8, 3.8, 1.95, 'Xe thể thao Lotus Spider', 'Lotus Spider'),
        F('moto-commuter', ix1 - 2.1, iz0 + 3.2, y0, -Math.PI / 4, 1.85, 1.1, 1.7, 'Xe máy đường phố', 'Commuter motorbike'),
        F('scooter-ev', ix0 + 2.1, iz0 + 3.2, y0, Math.PI / 4, 1.65, 1.0, 1.5, 'Xe điện đô thị', 'Electric scooter'),
      ],
    },
    {
      id: 'home_center', district: 'Shopping Row', chunkId: 'shopping-south',
      name: { vi: 'Timber and Stone Homeworks', en: 'Timber and Stone Homeworks' },
      rect: r(xW1 + 14, xW1 + 26, m0 - 11.5, m0),
      facing: 'south', wallColor: '#d9cbb6', interiorColor: '#f3ede3', accentColor: '#7c5832', floorFinish: 'terrazzo', lodAsset: 'bld-tube-lod',
      furnish: ({ ix0, ix1, iz0, cx, y0 }) => [
        F('kitchen-island', cx, iz0 + 2.2, y0, 0, 1.8, 1.8, .9, 'Đảo bếp Veranda', 'Kitchen island'),
        F('stove', ix0 + 1.8, iz0 + 2.2, y0, 0, .95, .95, .75, 'Bếp mẫu', 'Showroom stove'),
        F('fridge', ix1 - 1.8, iz0 + 2.2, y0, 0, .95, .95, .8, 'Tủ lạnh mẫu', 'Modern fridge'),
        F('soaking-tub', ix0 + 2.4, iz0 + 5.8, y0, Math.PI / 2, 1.7, .95, 1.7, 'Bồn tắm Veranda', 'Soaking tub'),
        F('photocopier', ix1 - 1.8, iz0 + 5.8, y0, -Math.PI / 2, .9, .85, .85, 'Bảng bất động sản', 'Realty station'),
      ],
    },
    {
      id: 'repair_shop', district: 'Shopping Row', chunkId: 'shopping-south',
      name: { vi: 'Tech and Fix Repair Workshop', en: 'Tech and Fix Repair Workshop' },
      rect: r(xW1 + 28, xW1 + 40, m0 - 11.5, m0),
      facing: 'south', wallColor: '#bcc2bc', interiorColor: '#eaedea', accentColor: '#3f4f45', floorFinish: 'concrete', lodAsset: 'bld-sub-k',
      furnish: ({ ix0, ix1, iz0, cx, y0 }) => [
        F('workbench', ix0 + 2.2, iz0 + 2.0, y0, 0, 1.8, 1.8, .85, 'Bàn kỹ thuật', 'Repair workbench'),
        F('table', ix1 - 2.2, iz0 + 2.0, y0, 0, 1.2, 1.2, 1.0, 'Bàn chế tác', 'Craft station'),
        F('moto-commuter', cx, iz0 + 5.4, y0, Math.PI / 2, 1.85, 1.85, .95, 'Xe đang bảo dưỡng', 'Service motorbike'),
        F('bicycle', ix0 + 1.6, iz0 + 5.6, y0, 0, 1.65, .75, 1.65, 'Xe đạp sửa chữa', 'Service bicycle'),
      ],
    },

    // ── CAMPUS (1 grand 2-storey University Library) ──
    {
      id: 'library', district: 'Campus', chunkId: 'campus-core',
      name: { vi: 'Thư viện Đại học', en: 'University Library' },
      rect: r(xE2 + 14, xE2 + 30, n3 + 2, front - 2),
      facing: 'south', twoStorey: true, wallColor: '#dfd3be', interiorColor: '#f6efe2', accentColor: '#24405a', floorFinish: 'oak', lodAsset: 'bld-courtyard-lod',
      furnish: ({ ix0, ix1, iz1, cx, y0, upper }) => [
        // Ground-floor Grand Reading Hall.
        F('library-desk', cx + 1.2, iz1 - 3.6, y0, 0, 2.2, 2.2, .9, 'Quầy thủ thư và tra cứu', 'Library checkout and catalog'),
        F('library-table', ix1 - 2.8, iz1 - 6.8, y0, 0, 2.0, 2.0, 1.1, 'Bàn đọc sách A', 'Reading table A'),
        F('library-table', ix0 + 5.0, iz1 - 6.8, y0, 0, 2.0, 2.0, 1.1, 'Bàn đọc sách B', 'Reading table B'),
        F('library-trolley', ix1 - 1.5, iz1 - 3.2, y0, -Math.PI / 2, .95, .8, .55, 'Xe đẩy sách', 'Book trolley'),
        F('bench-cushion', ix0 + 3.0, iz1 - 2.6, y0, 0, 1.3, 1.3, .55, 'Ghế chờ thư viện', 'Reading bench'),
        // Second-floor Archive and Mezzanine Bookstacks reached via the interior staircase!
        ...(upper ? [
          F('library-stack', upper.rect.x0 + 2.0, upper.rect.z0 + 1.1, upper.y, 0, 1.9, 1.9, .7, 'Kệ sách tầng 2 (Tây)', 'Upper bookstacks west'),
          F('library-stack', upper.rect.x1 - 2.2, upper.rect.z0 + 1.1, upper.y, 0, 1.9, 1.9, .7, 'Kệ sách tầng 2 (Đông)', 'Upper bookstacks east'),
          F('library-table', (upper.rect.x0 + upper.rect.x1) / 2, upper.rect.z1 - 1.2, upper.y, 0, 2.0, 2.0, 1.05, 'Bàn nghiên cứu tầng 2', 'Mezzanine study table'),
        ] : []),
      ],
    },

    // ── PARKS AND RIVER (1 enterable Riverside Art and Music Atelier) ──
    {
      id: 'atelier', district: 'Parks & River', chunkId: 'river-west',
      name: { vi: 'Xưởng Nghệ thuật và Âm nhạc Ven sông', en: 'Riverside Art and Music Atelier' },
      rect: r(xW2 + 14, xW2 + 27, n3, n3 + 9.5),
      facing: 'north', wallColor: '#e2d2c7', interiorColor: '#f8f0ea', accentColor: '#7b3e4f', floorFinish: 'oak', lodAsset: 'bld-lanternhouse-lod',
      furnish: ({ ix0, ix1, iz0, iz1, cx, y0 }) => [
        F('art-easel', ix0 + 2.2, iz1 - 2.0, y0, Math.PI * .15, 1.1, 1.0, .85, 'Giá vẽ tranh A', 'Art easel A'),
        F('art-easel', ix0 + 4.4, iz1 - 1.9, y0, -Math.PI * .1, 1.1, 1.0, .85, 'Giá vẽ tranh B', 'Art easel B'),
        F('guitar-acoustic', ix1 - 2.0, iz1 - 2.0, y0, -Math.PI * .2, .95, .8, .8, 'Guitar Acoustic', 'Acoustic guitar'),
        F('guitar-electric', ix1 - 1.8, iz0 + 4.0, y0, -Math.PI * .3, .95, .8, .8, 'Guitar Điện', 'Electric guitar'),
        F('table', cx - 1.4, iz0 + 4.0, y0, 0, 1.2, 1.2, 1.0, 'Bàn trưng bày ảnh', 'Photo album table'),
        F('plant', ix1 - .9, iz1 - .9, y0, 0, .6, .5, .5, 'Chậu cây xanh', 'Atelier plant'),
      ],
    },
  ];

  return specs.map(makeBuilding);
}

/** Finds the interior zone (if any) of an enterable building containing (x, z). */
export function buildingZoneAt(buildings: readonly EnterableBuilding[], p: { x: number; z: number }, pad = 0): { building: EnterableBuilding; zone: BuildingZone } | null {
  for (const b of buildings) {
    if (!inRect(p, b.rect)) continue;
    for (const z of b.zones) if (inRect(p, z.rect, pad)) return { building: b, zone: z };
  }
  return null;
}

/** Finds an open enterable-building door corridor containing (x, z). */
export function buildingDoorAt(buildings: readonly EnterableBuilding[], p: { x: number; z: number }, open: () => ReadonlySet<string>): { building: EnterableBuilding; door: Door } | null {
  for (const b of buildings) {
    if (inRect(p, b.door.corridor) && open().has(b.door.id)) return { building: b, door: b.door };
  }
  return null;
}
