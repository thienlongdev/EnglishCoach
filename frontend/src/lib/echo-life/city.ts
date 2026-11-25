/**
 * Echo Life — Complete 31-Zone Connected City Masterplan & Spatial Streaming Chunks.
 *
 * Pure plan data in the study stage's metres (10 §CH). Anchored around `house.footprint` and `house.front` so the
 * original 17-step physical journey (study → hallway → stair → lobby → Lantern St → West side st → Riverside Rd → Park)
 * stays geometry-compatible across every study room size (4–9 m), while extending continuously across all 31 V3 zones:
 *
 *                     far bank + downtown skyline (drawn only, z < riverFar)
 *   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ river (not walkable) ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 *   [Botanical Garden] | [Riverside Park]      | [Boardwalk Fair]   | [Riverside Greenway ->]
 *   ====== Riverside Road (continuous west-to-east promenade & crossings) =================
 *   [Atelier] [Minh][Linh] | [Yard / HOUSE 10z] | [University Green] | [Library] [Fountain] | [Lantern Tea Garden]
 *   ====== Lantern Street / Riverside Lane (`street`) → Campus Avenue =====================
 *   [Electronics][Furniture 2F] | [Pixel Café][Willow Bistro] | [Sunrise Market] [Plaza]
 *   [Clothing]   [Motors]       | [Homeworks] [Repair Shop]   | [South Campus Residences]
 *   ====== Market Boulevard (south commercial avenue) =====================================
 */
import { GROUND_Y, type HousePlan, type Rect, inRect, rect as r } from './plan';
import { buildCityBuildings, buildResidences, type DistrictName, type EnterableBuilding } from './buildings';
import type { AaaSeatSpec } from './aaaBuildingLayout';
import { V3_ZONE_META, type CityZoneDef, type V3ZoneId } from './zones';

export const ROAD_DROP = 0.12;
export type Surface = 'sidewalk' | 'road' | 'crossing' | 'park' | 'garden' | 'plaza';
export interface GroundRect { rect: Rect; surface: Surface; y: number; zone?: V3ZoneId; chunkId?: string }
export type LotUse = 'shophouse' | 'cafe' | 'market' | 'gaming' | 'home' | 'tower' | 'neighbour' | 'minka' | 'teacourt' | 'courtyard';
export interface Lot { id: string; rect: Rect; facing: 'north' | 'south' | 'east' | 'west'; use: LotUse; storeys: number; chunkId: string; name?: { vi: string; en: string } }

/** Outdoor street, park, campus, fair and garden props — placed on walkable ground with real collision radii. */
export interface Prop {
  kind:
    | 'tree' | 'lamp' | 'bench' | 'bin' | 'bollard' | 'sign' | 'shelter' | 'hydrant'
    | 'asset';
  /** Explicit staged `LifeAsset` key when `kind === 'asset'`. */
  asset?: string;
  /** Target height ('h') or horizontal span ('w') in metres when `kind === 'asset'`. */
  scaleBy?: 'h' | 'w';
  scaleVal?: number;
  x: number; z: number; rotY: number; radius: number;
  variant?: 'banyan' | 'flame' | 'palm';
  chunkId: string;
}

export interface CityChunk {
  id: string;
  name: { vi: string; en: string };
  district: DistrictName;
  rect: Rect;
  center: { x: number; z: number };
  /** Always-resident core chunk around the player's home. */
  core?: boolean;
}

export interface CityPlan {
  ground: GroundRect[];
  lots: Lot[];
  buildings: EnterableBuilding[];
  residences: EnterableBuilding[];
  props: Prop[];
  /** All 35 verified AAA interior and sidewalk bistro/reading/armchair seats across city buildings. */
  aaaSeats: AaaSeatSpec[];
  chunks: CityChunk[];
  zones: CityZoneDef[];
  river: Rect;
  bounds: Rect;
  skyline: { x: number; z: number; w: number; d: number; h: number }[];
  streets: { id: string; name: { vi: string; en: string }; rect: Rect }[];
}

/** Deterministic pseudo-random in [0, 1) from integers: the same city every visit. */
export function hash01(a: number, b = 0) {
  let t = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35)) >>> 0;
  t ^= t >>> 15; t = Math.imul(t, 0x2c1b3c6d) >>> 0; t ^= t >>> 12;
  return (t >>> 0) / 4294967296;
}

export function cityPlan(house: HousePlan): CityPlan {
  const f = house.footprint;
  const front = house.front;
  const north = f.z0 - 6; // Home back garden (`yard`) north edge = Riverside Road south sidewalk edge
  const west = f.x0 - 5;
  const east = f.x1 + 10;

  // East–west avenues: Riverside Road (north), Lantern Street (middle), Market Boulevard (south).
  const [n3, n2, n1, n0] = [north, north - 3, north - 10, north - 13];
  const [s0, s1, s2, s3] = [front, front + 3, front + 10, front + 13];
  const [m0, m1, m2, m3] = [s3 + 30, s3 + 33, s3 + 40, s3 + 43];

  // North–south cross streets (13 m wide each): xW1 = west - 13 preserved EXACT for journey.cjs!
  const blockW = 40;
  const xW1 = west - 13;
  const xW2 = xW1 - 13 - blockW;
  const xE1 = east;
  const xE2 = xE1 + 13 + 42;
  const xE3 = xE2 + 13 + 48;
  const xE4 = xE3 + 72; // Extended eastern Riverside Greenway & Hidden Lantern Tea Garden

  const x0 = xW2 - 24;
  const x1 = xE4 + 14;
  const parkSouth = n0;
  const parkNorth = n0 - 14;
  const riverFar = parkNorth - 36;

  // Spatial streaming chunks covering the entire city (~350 m × 115 m).
  const chunks: CityChunk[] = [
    { id: 'home-core', name: { vi: 'Khu Nhà và Phố Đèn Lồng', en: 'Home and Lantern Street' }, district: 'Home', rect: r(xW1, xE1 + 13, parkNorth, s3 + 2), center: { x: (xW1 + xE1 + 13) / 2, z: (parkNorth + s3) / 2 }, core: true },
    { id: 'neighborhood-west', name: { vi: 'Khu Dân cư Tây', en: 'West Neighborhood' }, district: 'Neighborhood', rect: r(xW2, xW1, n3, s3), center: { x: (xW2 + xW1) / 2, z: (n3 + s3) / 2 } },
    { id: 'neighborhood-south', name: { vi: 'Phố Cà phê và Bistro', en: 'Café and Bistro Row' }, district: 'Neighborhood', rect: r(xW1, xE1 + 13, s3, s3 + 16), center: { x: (xW1 + xE1 + 13) / 2, z: s3 + 8 } },
    { id: 'shopping-west', name: { vi: 'Khu Thương mại Tây', en: 'West Shopping Row' }, district: 'Shopping Row', rect: r(xW2, xW1, s3, m3 + 10), center: { x: (xW2 + xW1) / 2, z: (s3 + m3) / 2 } },
    { id: 'shopping-south', name: { vi: 'Siêu thị và Dịch vụ Nam', en: 'Market and Services Row' }, district: 'Shopping Row', rect: r(xW1, xE2, s3 + 14, m3 + 10), center: { x: (xW1 + xE2) / 2, z: (s3 + 14 + m3) / 2 } },
    { id: 'river-west', name: { vi: 'Vườn Thực vật và Xưởng Nghệ thuật', en: 'Botanical Garden and Atelier' }, district: 'Parks & River', rect: r(x0, xW1, parkNorth, n3 + 12), center: { x: (x0 + xW1) / 2, z: (parkNorth + n3 + 12) / 2 } },
    { id: 'campus-core', name: { vi: 'Đại học và Thư viện', en: 'University Green and Library' }, district: 'Campus', rect: r(xE1 + 13, xE2 + 34, parkNorth, s3 + 16), center: { x: (xE1 + 13 + xE2 + 34) / 2, z: (parkNorth + s3) / 2 } },
    { id: 'campus-east', name: { vi: 'Hội chợ và Đài phun nước Cổ', en: 'Boardwalk Fair and Fountain Court' }, district: 'Hidden Gems', rect: r(xE2 + 20, xE3 + 14, parkNorth, s3 + 22), center: { x: (xE2 + 20 + xE3 + 14) / 2, z: (parkNorth + s3 + 10) / 2 } },
    { id: 'greenway-east', name: { vi: 'Đường dạo Ven sông và Trà viên', en: 'Greenway and Hidden Lantern Garden' }, district: 'Parks & River', rect: r(xE3, x1, parkNorth, s3 + 12), center: { x: (xE3 + x1) / 2, z: (parkNorth + s3) / 2 } },
  ];

  const chunkOf = (x: number, z: number): string => {
    if (x >= xE3) return 'greenway-east';
    if (x >= xE2 + 32) return 'campus-east';
    if (x >= xE1 + 13 && z < s3) return 'campus-core';
    if (x < xW1 && z < n3 + 10) return 'river-west';
    if (x < xW1 && z < s3) return 'neighborhood-west';
    if (x < xW1 && z >= s3) return 'shopping-west';
    if (z >= s3 + 15 || (x >= xE1 + 13 && z >= s3)) return 'shopping-south';
    if (z >= s3) return 'neighborhood-south';
    return 'home-core';
  };

  // All 13 enterable city buildings.
  const buildings = buildCityBuildings({ xW2, xW1, xE1, xE2, xE3, n3, front, s3, m0 });

  const ground: GroundRect[] = [];
  const add = (rect: Rect, surface: Surface, y = GROUND_Y, zone?: V3ZoneId) => {
    if (rect.x1 - rect.x0 <= 1e-4 || rect.z1 - rect.z0 <= 1e-4) return;
    ground.push({ rect, surface, y, zone, chunkId: chunkOf((rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2) });
  };

  // 1. Continuous East–West Avenues.
  // Lantern Street / Riverside Lane (`street`): runs west Shopping Row -> Home -> Campus -> Fountain Court!
  add(r(x0, xE3 + 13, s0, s1), 'sidewalk', GROUND_Y, 'street');
  add(r(x0, xE3 + 13, s1, s2), 'road', GROUND_Y - ROAD_DROP, 'street');
  add(r(x0, xE3 + 13, s2, s3), 'sidewalk', GROUND_Y, 'street');
  // Riverside Road: runs the ENTIRE width from West Botanical to East Greenway!
  add(r(x0, x1, n2, n3), 'sidewalk', GROUND_Y, 'street');
  add(r(x0, x1, n1, n2), 'road', GROUND_Y - ROAD_DROP, 'street');
  add(r(x0, x1, n0, n1), 'sidewalk', GROUND_Y, 'street');
  // Market Boulevard (south commercial avenue linking Clothing Shop, Vehicle Dealer, Home Center, Repair Shop).
  add(r(xW2, xE2 + 13, m0, m1), 'sidewalk', GROUND_Y, 'street');
  add(r(xW2, xE2 + 13, m1, m2), 'road', GROUND_Y - ROAD_DROP, 'street');
  add(r(xW2, xE2 + 13, m2, m3), 'sidewalk', GROUND_Y, 'street');

  // 2. North–South Cross Streets (carriageway extended across `n2..s1` and `s2..m1` so intersections are flush asphalt).
  const xStreets = [xW2, xW1, xE1, xE2, xE3];
  for (const xs of xStreets) {
    add(r(xs, xs + 3, n3, s0), 'sidewalk', GROUND_Y, 'street');
    add(r(xs + 3, xs + 10, n2, s1), 'road', GROUND_Y - ROAD_DROP, 'street');
    add(r(xs + 10, xs + 13, n3, s0), 'sidewalk', GROUND_Y, 'street');
    if (xs <= xE2) {
      add(r(xs, xs + 3, s3, m0), 'sidewalk', GROUND_Y, 'street');
      add(r(xs + 3, xs + 10, s2, m1), 'road', GROUND_Y - ROAD_DROP, 'street');
      add(r(xs + 10, xs + 13, s3, m0), 'sidewalk', GROUND_Y, 'street');
    }
  }
  // Pedestrian breeze-ways between north and south commercial shop rows (connecting shops smoothly!).
  add(r(xW2 + 13, xW1, s3 + 13.5, m0 - 12.5), 'plaza', GROUND_Y, 'street');
  add(r(xW1 + 13, xE1, s3 + 11, m0 - 12), 'plaza', GROUND_Y, 'street');

  // Zebra crossings (front of house, west riverside corner, campus gate, fair entrance, shopping row).
  const door = house.doors.find(d => d.id === 'entrance')!;
  const crossing = (rect: Rect) => ground.push({ rect, surface: 'crossing', y: GROUND_Y - ROAD_DROP, zone: 'street', chunkId: chunkOf((rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2) });
  crossing(r(door.x - 1.6, door.x + 1.6, s1, s2));
  crossing(r(xW1 + 3, xW1 + 10, n1, n2));
  crossing(r(xW2 + 3, xW2 + 10, n1, n2));
  crossing(r(xE1 + 3, xE1 + 10, n1, n2));
  crossing(r(xE2 + 3, xE2 + 10, n1, n2));
  crossing(r(xE3 + 3, xE3 + 10, n1, n2));
  crossing(r(xW2 + 24, xW2 + 27.5, s1, s2));
  crossing(r(xE1 + 20, xE1 + 23.5, s1, s2));

  // 3. Home Back Garden (`yard`) — open to both side streets, north of the house.
  const yardRect = r(west, east, n3, f.z0);
  add(yardRect, 'garden', GROUND_Y, 'yard');
  // Side garden path along east of home to connect yard seamlessly to Lantern Street!
  add(r(f.x1, east, f.z0, front), 'garden', GROUND_Y, 'yard');

  // 4. Riverfront Zones (north of Riverside Road): Botanical | Riverside Park | Boardwalk Fair | Riverside Greenway!
  const botanicalRect = r(x0, xW1, parkNorth, parkSouth);
  const parkRect = r(xW1, xE2, parkNorth, parkSouth);
  const fairRect = r(xE2, xE3, parkNorth, parkSouth);
  const greenwayNorthRect = r(xE3, x1, parkNorth, parkSouth);
  const greenwaySouthRect = r(xE3 + 13, x1, n3, n3 + 16);
  add(botanicalRect, 'garden', GROUND_Y, 'botanical');
  add(parkRect, 'park', GROUND_Y, 'park');
  add(fairRect, 'plaza', GROUND_Y, 'fair');
  add(greenwayNorthRect, 'park', GROUND_Y, 'greenway');
  add(greenwaySouthRect, 'park', GROUND_Y, 'greenway');

  // 5. University Campus District (`campus`), Library Plaza surrounding `library`, and Old Campus Fountain Court (`fountain_plaza`)!
  const campusRect = r(xE1 + 13, xE2, n3, front);
  add(campusRect, 'plaza', GROUND_Y, 'campus');
  // Paved plaza strictly AROUND `library` (never overlapping `library.rect` so interior floor stays clean!).
  const lib = buildings.find(b => b.id === 'library')!;
  add(r(xE2 + 13, lib.rect.x0, n3, front), 'plaza', GROUND_Y, 'campus');
  add(r(lib.rect.x0, lib.rect.x1, n3, lib.rect.z0), 'plaza', GROUND_Y, 'campus');
  add(r(lib.rect.x0, lib.rect.x1, lib.rect.z1, front), 'plaza', GROUND_Y, 'campus');
  // Old Campus Fountain Court (`fountain_plaza`): directly east of University Library, open to Riverside Road & Campus Ave!
  const fountainRect = r(lib.rect.x1, xE3, n3, front);
  add(fountainRect, 'plaza', GROUND_Y, 'fountain_plaza');

  // 6. Hidden Lantern Tea Garden (`lantern_garden`): tranquil lantern-lit garden branching south off Riverside Greenway!
  const lanternGardenRect = r(xE3 + 15, xE4 + 8, n3 + 16, front + 12);
  add(lanternGardenRect, 'garden', GROUND_Y, 'lantern_garden');
  // Paved footpath linking Fountain Court / Campus Ave directly into Lantern Tea Garden too!
  add(r(xE3 + 10, xE3 + 15, n3 + 16, front), 'plaza', GROUND_Y, 'lantern_garden');

  // 7. Decorative architectural backdrop lots (strictly OUTSIDE all walkable ground, house, and enterable buildings).
  const lots: Lot[] = [];
  const lot = (id: string, rect: Rect, facing: Lot['facing'], use: LotUse, storeys: number, name?: Lot['name']) =>
    lots.push({ id, rect, facing, use, storeys, chunkId: chunkOf((rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2), name });

  // Home west neighbour (wall-to-wall with home west wall, untouched!).
  lot('home-west', r(west, f.x0, f.z0, front), 'south', 'neighbour', 3);
  // Northwest residential filler beside Atelier / Linh / Minh (outside enterable building footprints).
  lot('nw-fill-a', r(xW1 - 12, xW1 - 1, n3 + 0.5, n3 + 8.5), 'north', 'home', 2);
  lot('nw-fill-b', r(xW1 - 24, xW1 - 14, n3 + 0.5, n3 + 8.5), 'north', 'home', 2);
  // South of Sunrise Market (commercial/residential backdrop along east Market Blvd).
  lot('se-market-a', r(xE1 + 14, xE1 + 26, m0 - 11, m0), 'south', 'shophouse', 3);
  lot('se-market-b', r(xE1 + 28, xE2 - 1, m0 - 11, m0), 'south', 'home', 2);
  lot('se-campus-a', r(xE1 + 30, xE2 - 1, s3, s3 + 12), 'north', 'courtyard', 3, { vi: 'Ký túc xá Echo', en: 'Echo Campus Residence' });
  // South of Campus Avenue (across from University Library & Fountain Court).
  lot('sc-dorm-a', r(xE2 + 14, xE2 + 28, s3, s3 + 16), 'north', 'shophouse', 3);
  lot('sc-dorm-b', r(xE2 + 30, xE3 - 2, s3, s3 + 16), 'north', 'teacourt', 2, { vi: 'Viện Ngôn ngữ', en: 'Language Institute' });
  // Scenic residential fringe south of Market Boulevard (non-walkable depth).
  for (let i = 0; i < 6; i++) {
    const lx = xW2 + 14 + i * 24;
    if (lx + 18 > xE2) break;
    lot(`south-fringe-${i}`, r(lx, lx + 16, m3 + 1, m3 + 14), 'north', i % 2 === 0 ? 'home' : 'tower', 2 + (i % 3));
  }

  // 8. Curated Multi-Library Outdoor Props, Street Furniture & District Landmarks!
  const props: Prop[] = [];
  const nearBuildingDoor = (px: number, pz: number) =>
    Math.hypot(px - door.x, pz - front) < 3.4 ||
    buildings.some(b => Math.hypot(px - b.outsidePoint.x, pz - b.outsidePoint.z) < 3.4);

  const prop = (kind: Prop['kind'], px: number, pz: number, rotY = 0, radius = .3, variant?: Prop['variant']) =>
    props.push({ kind, x: px, z: pz, rotY, radius, variant, chunkId: chunkOf(px, pz) });
  const assetProp = (asset: string, px: number, pz: number, rotY: number, scaleBy: 'h' | 'w', scaleVal: number, radius: number) =>
    props.push({ kind: 'asset', asset, scaleBy, scaleVal, x: px, z: pz, rotY, radius, chunkId: chunkOf(px, pz) });

  // Street trees and lamps along Lantern Street & Riverside Road (never in roads, never blocking doors, never blocking study window!).
  const inCross = (px: number) => xStreets.some(xs => px > xs - 2.5 && px < xs + 15.5);
  for (let px = x0 + 5; px < xE3 + 10; px += 11) {
    if (inCross(px)) continue;
    if (!nearBuildingDoor(px, s1 - .8)) prop('tree', px, s1 - .8, 0, .45);
    if (!nearBuildingDoor(px + 5, s1 - .45)) prop('lamp', px + 5, s1 - .45, Math.PI, .16);
    if (!nearBuildingDoor(px + 2, s2 + .8)) prop('tree', px + 2, s2 + .8, 0, .45);
    if (!nearBuildingDoor(px - 2.5, s2 + .45)) prop('lamp', px - 2.5, s2 + .45, 0, .16);
  }
  for (let px = x0 + 5; px < x1 - 5; px += 11) {
    if (inCross(px)) continue;
    // Preserve clear northern sight line from the study room window!
    if (Math.abs(px + 1 - house.h * .3) > house.h + 3.1 && !nearBuildingDoor(px + 1, n2 + .8)) prop('tree', px + 1, n2 + .8, 0, .45);
    prop('lamp', px + 5.5, n1 - .45, 0, .16);
    if (!nearBuildingDoor(px + 3.2, n2 + .45)) prop('lamp', px + 3.2, n2 + .45, Math.PI, .16);
  }

  // Home frontage & Lantern Street (`street`) signature props.
  prop('bench', door.x - 3.8, s0 + .68, 0, .44);
  prop('bin', door.x + 2.6, s1 - .5, 0, .28);
  prop('shelter', f.x1 + 5.5, s1 - 1.3, Math.PI, .15);
  prop('hydrant', f.x0 + 1, s1 - .6, 0, .25);
  prop('sign', west - 1.2, s0 + .6, 0, .2);
  assetProp('map-kiosk', xE1 + 15.2, front - 2.2, 0, 'h', 2.2, .5);
  assetProp('atm-kiosk', xW1 + 27.0, s3 - .52, Math.PI, 'h', 2.05, .42);
  assetProp('parcel-locker', xE1 + 11.8, s3 - .52, Math.PI, 'h', 1.95, .45);

  // Home Garden (`yard`): slender palms (clear of study window sight line) + planter trough + bike rack!
  const room = house.h;
  for (const px of [f.x0 + .9, room + 3.2, room + 7.4, f.x1 - 1.2]) prop('tree', px, north + 2.4, 0, .4, 'palm');
  assetProp('planter-trough', f.x1 + 4.5, north + 3.5, 0, 'w', 1.3, .55);
  assetProp('bikerack', f.x1 + 7.2, north + 3.5, Math.PI / 2, 'w', 1.6, .6);

  // Riverside Park (`park`): benches, shade trees, basketball hoop, badminton net court, map kiosk.
  const netX = xE1 + 22;
  for (let px = xW1 + 4; px < xE2 - 4; px += 12) {
    prop('bench', px, parkNorth + 2.45, Math.PI, .44);
    const treeX = px + 6;
    const treeZ = Math.abs(treeX - netX) < 4.5 ? parkSouth - 1.2 : parkNorth + 6.5 + hash01(px | 0, 29) * 2.5;
    prop('tree', treeX, treeZ, 0, .55);
    prop('lamp', px + 3.4, parkNorth + .85, 0, .16);
  }
  assetProp('hoop-post', xE1 + 4, parkNorth + 8.5, Math.PI / 2, 'h', 3.7, .65);
  assetProp('badminton-net', netX, parkNorth + 7.2, 0, 'w', 5.8, .45);
  assetProp('map-kiosk', xW1 + 16, parkSouth - 2.0, Math.PI, 'h', 2.1, .55);

  // Community Botanical Garden (`botanical`): wooden pergola gazebo, planter troughs, watering can, patio set, palms!
  const botCx = (botanicalRect.x0 + botanicalRect.x1) / 2, botCz = (botanicalRect.z0 + botanicalRect.z1) / 2;
  assetProp('park-gazebo', botCx, botCz - 1.5, 0, 'w', 5.2, .45);
  prop('bench', botCx - 6.2, botCz - 1.5, Math.PI / 2, .44);
  prop('bench', botCx - 11.5, botCz - 1.0, 0, .44);
  assetProp('planter-trough', botCx - 7.5, botCz + 2.5, 0, 'w', 1.4, .6);
  assetProp('planter-trough', botCx + 7.5, botCz + 2.5, 0, 'w', 1.4, .6);
  assetProp('patio-set', botCx + 11.5, botCz - 1.0, Math.PI / 4, 'w', 1.8, .42);
  assetProp('watering-can', botCx - 4.5, botCz + 3.5, 0, 'h', .45, .25);
  for (let bx = botanicalRect.x0 + 6; bx < botanicalRect.x1 - 4; bx += 10) {
    prop('tree', bx, parkNorth + 2.5, 0, .45, 'palm');
    prop('lamp', bx + 4, parkNorth + 1.0, 0, .16);
  }

  // University Green (`campus`): monumental Entrance Gate Arch, Academic Hall facade backdrop, Colonnade bay, Guardhouse, Posterboard, Festival Booth, Lectern!
  const camCx = (campusRect.x0 + campusRect.x1) / 2;
  assetProp('campus-gate', camCx, front - 1.8, 0, 'w', 8.6, .6); // Arch straddles wide entry; small post radius so player walks right under!
  assetProp('campus-colonnade', camCx - 11, n3 + 3.0, 0, 'w', 6.0, 1.2);
  assetProp('campus-colonnade', camCx + 11, n3 + 3.0, 0, 'w', 6.0, 1.2);
  assetProp('campus-guardhouse', campusRect.x0 + 4.5, front - 4.5, 0, 'w', 2.8, 1.3);
  assetProp('campus-posterboard', camCx - 6.5, (n3 + front) / 2, Math.PI / 6, 'w', 1.8, .6);
  assetProp('festival-booth-en', camCx + 9.5, (n3 + front) / 2 + 1.5, -Math.PI / 4, 'w', 3.0, 1.4);
  assetProp('festival-lectern', camCx, n3 + 6.0, 0, 'h', 1.25, .45);
  assetProp('library-trolley', camCx + 4.5, n3 + 6.5, 0, 'w', .9, .45);
  prop('tree', campusRect.x0 + 4.0, n3 + 3.2, 0, .5, 'flame');
  prop('tree', campusRect.x1 - 4.0, n3 + 3.2, 0, .5, 'flame');
  prop('bench', camCx - 11.0, n3 + 5.4, 0, .44);
  prop('bench', camCx + 11.0, n3 + 5.4, 0, .44);
  prop('bench', camCx - 5.2, front - 4.6, Math.PI / 2, .44);
  prop('bench', camCx + 5.2, front - 4.6, -Math.PI / 2, .44);

  // Old Campus Fountain Court (`fountain_plaza`): Tiered Fountain centerpiece, Echo Whale bronze monument, Festival Stage + Truss, Founders Obelisk, Benches!
  const fCx = (fountainRect.x0 + fountainRect.x1) / 2, fCz = (fountainRect.z0 + fountainRect.z1) / 2;
  assetProp('fountain-tiered', fCx, fCz + 1.2, 0, 'w', 4.4, 2.0);
  assetProp('whale-monument', fCx + 8.5, fCz + 1.2, -Math.PI / 2, 'h', 2.0, .9);
  assetProp('festival-stage', fCx, n3 + 4.5, 0, 'w', 6.8, 2.6);
  assetProp('festival-truss', fCx, n3 + 4.5, 0, 'w', 7.2, .4);
  assetProp('statue-obelisk', fCx - 9.0, n3 + 5.0, 0, 'h', 3.6, .8);
  prop('bench', fCx - 6.5, front - 3.0, Math.PI, .44);
  prop('bench', fCx + 6.5, front - 3.0, Math.PI, .44);

  // Boardwalk Fair (`fair`): Illuminated Arch, Mini Ferris Wheel, Mini Carousel, Echo Whale Photo Arch, Ring Toss, Prize Wheel, Popcorn Cart, Crepe Kiosk!
  const fairCx = (fairRect.x0 + fairRect.x1) / 2;
  assetProp('fair-arch', fairCx, parkSouth - 1.6, 0, 'w', 5.2, .45);
  assetProp('fair-ferris', fairRect.x0 + 9.5, parkNorth + 5.5, Math.PI / 8, 'h', 7.4, 2.6);
  assetProp('fair-carousel', fairRect.x1 - 9.5, parkNorth + 6.0, 0, 'w', 5.0, 2.3);
  assetProp('fair-whale-arch', fairCx, parkNorth + 4.2, 0, 'w', 3.0, .9);
  assetProp('fair-ringtoss', fairCx - 8.5, parkSouth - 5.2, 0, 'w', 2.6, 1.2);
  assetProp('fair-wheel', fairCx + 8.5, parkSouth - 5.2, Math.PI, 'h', 2.2, .75);
  assetProp('fair-popcorn', fairCx - 4.0, parkSouth - 4.5, Math.PI / 5, 'h', 1.65, .6);
  assetProp('crepe-kiosk', fairCx + 4.5, parkSouth - 4.8, -Math.PI / 6, 'w', 2.2, 1.0);
  prop('bench', fairCx - 6.8, parkNorth + 2.45, Math.PI, .44);
  prop('bench', fairCx + 6.8, parkNorth + 2.45, Math.PI, .44);

  // Riverside Greenway (`greenway`): expansive scenic east promenade with benches, street lanterns, shade trees, basketball hoop, bus shelter, map kiosk!
  for (let gx = xE3 + 8; gx < x1 - 6; gx += 14) {
    prop('bench', gx, parkNorth + 2.45, Math.PI, .44);
    prop('tree', gx + 7, parkNorth + 7.0, 0, .55, gx % 28 === 0 ? 'flame' : 'banyan');
    assetProp('street-lantern', gx + 3.6, parkNorth + .85, 0, 'h', 3.1, .22);
    assetProp('street-lantern', gx + 6, n3 + 3.2, Math.PI, 'h', 3.1, .22);
  }
  assetProp('hoop-post', xE3 + 28, n3 + 8.5, 0, 'h', 3.7, .65);
  prop('shelter', xE3 + 46, n3 + 3.2, Math.PI, .15);
  assetProp('map-kiosk', xE3 + 58, parkNorth + 4.5, Math.PI, 'h', 2.1, .55);

  // Hidden Lantern Tea Garden (`lantern_garden`): serene Minka pavilion backdrop, glowing paper/street lanterns, tea garden patio seating, palms!
  const lgCx = (lanternGardenRect.x0 + lanternGardenRect.x1) / 2, lgCz = (lanternGardenRect.z0 + lanternGardenRect.z1) / 2;
  assetProp('bld-minka', lgCx, lanternGardenRect.z1 - 5.0, Math.PI, 'w', 9.5, 4.0);
  prop('bench', lgCx - 3.8, lanternGardenRect.z0 + 2.8, 0, .44);
  prop('bench', lgCx + 3.8, lanternGardenRect.z0 + 2.8, 0, .44);
  assetProp('patio-set', lgCx, lgCz - 1.5, 0, 'w', 2.0, .42);
  assetProp('patio-set', lgCx - 7.5, lgCz - 1.5, Math.PI / 4, 'w', 1.8, .42);
  assetProp('patio-set', lgCx + 7.5, lgCz - 1.5, -Math.PI / 4, 'w', 1.8, .42);
  for (const [lx, lz] of [[-8, -7], [8, -7], [-12, 1], [12, 1], [-5, -10], [5, -10]]) {
    assetProp('street-lantern', lgCx + lx, lgCz + lz, 0, 'h', 2.9, .24);
  }
  for (const [px, pz] of [[-14, -6], [14, -6], [-16, 4], [16, 4]]) prop('tree', lgCx + px, lgCz + pz, 0, .45, 'palm');

  // 9. Downtown skyline across the river (extended cleanly across the full 350 m riverfront!).
  const skyline: CityPlan['skyline'] = [];
  for (let i = 0; i < 44; i++) {
    const t = i / 43, w = 14 + hash01(i, 41) * 18, d = 14 + hash01(i, 43) * 16;
    const center = Math.max(0, 1 - Math.abs(t - .5) * 1.7);
    skyline.push({
      x: x0 - 120 + t * (x1 - x0 + 240) + (hash01(i, 47) - .5) * 14,
      z: riverFar - 55 - hash01(i, 53) * 150,
      w, d, h: 18 + center * (38 + hash01(i, 59) * 96) + hash01(i, 61) * 14,
    });
  }

  // 10. Canonical 31-Zone Registry (`city.zones` — exact 1-to-1 match with V3_ZONE_IDS!).
  const hz = (id: string) => house.zones.find(z => z.id === id)!;
  const centerOf = (rt: Rect) => ({ x: (rt.x0 + rt.x1) / 2, z: (rt.z0 + rt.z1) / 2 });
  const zones: CityZoneDef[] = [
    // 10 Home zones
    { id: 'study', ...V3_ZONE_META.study, chunkId: 'home-core', rect: r(-house.h, house.h, -house.h, house.h), waypoint: { x: 0, z: 0 } },
    { id: 'hall', ...V3_ZONE_META.hall, chunkId: 'home-core', rect: hz('hall').rect, waypoint: centerOf(hz('hall').rect), doorId: 'hall' },
    { id: 'living', ...V3_ZONE_META.living, chunkId: 'home-core', rect: hz('living').rect, waypoint: { x: hz('living').rect.x0 + .75, z: -house.h + 1.4 } },
    { id: 'kitchen', ...V3_ZONE_META.kitchen, chunkId: 'home-core', rect: hz('kitchen').rect, waypoint: { x: hz('kitchen').rect.x0 + 1.0, z: house.h - 1.0 } },
    { id: 'bedroom', ...V3_ZONE_META.bedroom, chunkId: 'home-core', rect: hz('bedroom').rect, waypoint: { x: hz('bedroom').rect.x0 + 2.4, z: 0.38 }, doorId: 'bedroom' },
    { id: 'bath', ...V3_ZONE_META.bath, chunkId: 'home-core', rect: hz('bath').rect, waypoint: { x: hz('bath').rect.x0 + 1.0, z: house.h + 1.1 }, doorId: 'bath' },
    { id: 'yard', ...V3_ZONE_META.yard, chunkId: 'home-core', rect: yardRect, waypoint: { x: f.x0 + 1.0, z: north + 4.2 } },
    { id: 'gaming_room', ...V3_ZONE_META.gaming_room, chunkId: 'home-core', rect: hz('gaming_room').rect, waypoint: { x: hz('gaming_room').rect.x0 + 1.2, z: hz('gaming_room').rect.z0 + 1.1 }, doorId: 'gaming' },
    { id: 'balcony', ...V3_ZONE_META.balcony, chunkId: 'home-core', rect: hz('balcony').rect, waypoint: { x: hz('balcony').rect.x0 + 1.1, z: -0.35 }, doorId: 'balcony' },
    { id: 'garage', ...V3_ZONE_META.garage, chunkId: 'home-core', rect: hz('garage').rect, waypoint: { x: hz('garage').rect.x0 + 1.3, z: front - 1.5 }, doorId: 'garage' },
    // 13 Enterable City Building zones
    ...buildings.map(b => ({
      id: b.id as V3ZoneId,
      ...V3_ZONE_META[b.id],
      chunkId: b.chunkId,
      rect: b.rect,
      waypoint: b.entryPoint,
      doorId: b.door.id,
    })),
    // 8 Outdoor District zones
    { id: 'street', ...V3_ZONE_META.street, chunkId: 'home-core', rect: r(x0, xE3 + 13, s0, s3), waypoint: { x: door.x, z: front + 1.5 } },
    { id: 'campus', ...V3_ZONE_META.campus, chunkId: 'campus-core', rect: campusRect, waypoint: { x: camCx, z: front - 5.5 } },
    { id: 'park', ...V3_ZONE_META.park, chunkId: 'home-core', rect: parkRect, waypoint: { x: -house.h + .5, z: parkNorth + 3.5 } },
    { id: 'fair', ...V3_ZONE_META.fair, chunkId: 'campus-east', rect: fairRect, waypoint: { x: fairCx, z: parkSouth - 2.6 } },
    { id: 'greenway', ...V3_ZONE_META.greenway, chunkId: 'greenway-east', rect: greenwayNorthRect, waypoint: { x: xE3 + 22, z: parkNorth + 4.5 } },
    { id: 'botanical', ...V3_ZONE_META.botanical, chunkId: 'river-west', rect: botanicalRect, waypoint: { x: botCx, z: parkSouth - 2.5 } },
    { id: 'lantern_garden', ...V3_ZONE_META.lantern_garden, chunkId: 'greenway-east', rect: lanternGardenRect, waypoint: { x: lgCx, z: lanternGardenRect.z0 + 3.0 } },
    { id: 'fountain_plaza', ...V3_ZONE_META.fountain_plaza, chunkId: 'campus-east', rect: fountainRect, waypoint: { x: fCx, z: front - 3.2 } },
  ];

  return {
    ground,
    lots,
    buildings,
    residences: buildResidences(lots),
    props,
    aaaSeats: buildings.flatMap(b => b.aaaSeats),
    chunks,
    zones,
    skyline,
    river: r(x0 - 200, x1 + 200, riverFar, parkNorth),
    bounds: r(x0, x1, parkNorth + .4, m3 + 14),
    streets: [
      { id: 'lantern', name: { vi: 'Phố Đèn Lồng', en: 'Lantern Street' }, rect: r(x0, xE3 + 13, s0, s3) },
      { id: 'riverside', name: { vi: 'Đường Ven Sông', en: 'Riverside Road' }, rect: r(x0, x1, n0, n3) },
      { id: 'market_blvd', name: { vi: 'Đại lộ Thương mại', en: 'Market Boulevard' }, rect: r(xW2, xE2 + 13, m0, m3) },
      { id: 'park', name: { vi: 'Công viên Ven Sông', en: 'Riverside Park' }, rect: parkRect },
      { id: 'campus', name: { vi: 'Quảng trường Đại học', en: 'University Green' }, rect: campusRect },
      { id: 'greenway', name: { vi: 'Đường dạo Ven Sông', en: 'Riverside Greenway' }, rect: greenwayNorthRect },
    ],
  };
}

/** The outdoor surface under (x, z): its height, or null for a building, the water or outside the city. */
export function outdoorAt(city: CityPlan, p: { x: number; z: number }): GroundRect | null {
  if (!inRect(p, city.bounds)) return null;
  let hit: GroundRect | null = null;
  for (const g of city.ground) if (inRect(p, g.rect)) hit = g;
  return hit;
}

export function lotAt(city: CityPlan, p: { x: number; z: number }): Lot | null {
  for (const l of city.lots) if (inRect(p, l.rect)) return l;
  return null;
}
