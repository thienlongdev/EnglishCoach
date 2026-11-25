/**
 * Echo Life — Canonical 31-Zone V3 Open World Registry.
 *
 * Every single one of the 31 actual V3 zones (`world-data/world.mjs`) is mapped here to its physical walkable region
 * inside the continuous Study Space world (10 Home zones, 5 Neighborhood zones, 7 Shopping Row commercial zones,
 * 2 Campus zones, 4 Parks & River zones, and 3 Hidden Gems & public plaza zones). Zero teleports.
 */
import type { Rect, Text } from './plan';
import type { DistrictName } from './buildings';

export const V3_ZONE_IDS = [
  // Home (10)
  'study', 'hall', 'living', 'kitchen', 'bedroom', 'bath', 'yard', 'gaming_room', 'balcony', 'garage',
  // Neighborhood (5)
  'street', 'linh', 'minh', 'cafe', 'bistro',
  // Shopping Row / Commercial (7)
  'market', 'electronics_shop', 'furniture_shop', 'clothing_shop', 'vehicle_dealer', 'home_center', 'repair_shop',
  // Campus (2)
  'campus', 'library',
  // Parks & River (4)
  'park', 'fair', 'greenway', 'atelier',
  // Hidden Gems / Public Plazas (3)
  'botanical', 'lantern_garden', 'fountain_plaza',
] as const;

export type V3ZoneId = typeof V3_ZONE_IDS[number];

export interface CityZoneDef {
  id: V3ZoneId;
  name: Text;
  district: DistrictName;
  kind: 'home' | 'building' | 'outdoor';
  chunkId: string;
  rect: Rect;
  /** Guaranteed reachable walkable point inside this zone (verified by on-foot pathing tests). */
  waypoint: { x: number; z: number };
  /** Door ID that must be open to walk into this zone directly (null for outdoor zones / open arch). */
  doorId?: string;
}

export const V3_ZONE_META: Record<V3ZoneId, { name: Text; district: DistrictName; kind: CityZoneDef['kind'] }> = {
  study: { name: { vi: 'Phòng học', en: 'Study room' }, district: 'Home', kind: 'home' },
  hall: { name: { vi: 'Hành lang', en: 'Hallway' }, district: 'Home', kind: 'home' },
  living: { name: { vi: 'Phòng khách', en: 'Living room' }, district: 'Home', kind: 'home' },
  kitchen: { name: { vi: 'Nhà bếp', en: 'Kitchen' }, district: 'Home', kind: 'home' },
  bedroom: { name: { vi: 'Phòng ngủ', en: 'Bedroom' }, district: 'Home', kind: 'home' },
  bath: { name: { vi: 'Phòng tắm', en: 'Bathroom' }, district: 'Home', kind: 'home' },
  yard: { name: { vi: 'Vườn nhà', en: 'Home garden' }, district: 'Home', kind: 'outdoor' },
  gaming_room: { name: { vi: 'Phòng Gaming và Công nghệ', en: 'Gaming and Tech Studio' }, district: 'Home', kind: 'home' },
  balcony: { name: { vi: 'Ban công sân thượng', en: 'Terrace Balcony' }, district: 'Home', kind: 'home' },
  garage: { name: { vi: 'Ga-ra cá nhân', en: 'Personal Garage' }, district: 'Home', kind: 'home' },
  street: { name: { vi: 'Phố Đèn Lồng (Riverside Lane)', en: 'Lantern Street' }, district: 'Neighborhood', kind: 'outdoor' },
  linh: { name: { vi: 'Nhà của Linh', en: 'Linh’s House' }, district: 'Neighborhood', kind: 'building' },
  minh: { name: { vi: 'Nhà của Minh', en: 'Minh’s House' }, district: 'Neighborhood', kind: 'building' },
  cafe: { name: { vi: 'Pixel Café', en: 'Pixel Café' }, district: 'Neighborhood', kind: 'building' },
  bistro: { name: { vi: 'Willow Corner Bistro', en: 'Willow Corner Bistro' }, district: 'Neighborhood', kind: 'building' },
  market: { name: { vi: 'Siêu thị Sunrise Market', en: 'Sunrise Market' }, district: 'Shopping Row', kind: 'building' },
  electronics_shop: { name: { vi: 'Volt and Silicon Electronics', en: 'Volt and Silicon Electronics' }, district: 'Shopping Row', kind: 'building' },
  furniture_shop: { name: { vi: 'Riverside Living and Atelier', en: 'Riverside Living and Atelier' }, district: 'Shopping Row', kind: 'building' },
  clothing_shop: { name: { vi: 'Thread and Campus Apparel', en: 'Thread and Campus Apparel' }, district: 'Shopping Row', kind: 'building' },
  vehicle_dealer: { name: { vi: 'Greenway Motors and Cycles', en: 'Greenway Motors and Cycles' }, district: 'Shopping Row', kind: 'building' },
  home_center: { name: { vi: 'Timber and Stone Homeworks', en: 'Timber and Stone Homeworks' }, district: 'Shopping Row', kind: 'building' },
  repair_shop: { name: { vi: 'Tech and Fix Repair Workshop', en: 'Tech and Fix Repair Workshop' }, district: 'Shopping Row', kind: 'building' },
  campus: { name: { vi: 'Quảng trường Đại học', en: 'University Green' }, district: 'Campus', kind: 'outdoor' },
  library: { name: { vi: 'Thư viện Đại học', en: 'University Library' }, district: 'Campus', kind: 'building' },
  park: { name: { vi: 'Công viên Ven Sông', en: 'Riverside Park' }, district: 'Parks & River', kind: 'outdoor' },
  fair: { name: { vi: 'Hội chợ Bến sông', en: 'Boardwalk Fair' }, district: 'Parks & River', kind: 'outdoor' },
  greenway: { name: { vi: 'Đường dạo Ven Sông', en: 'Riverside Greenway' }, district: 'Parks & River', kind: 'outdoor' },
  atelier: { name: { vi: 'Xưởng Nghệ thuật và Âm nhạc', en: 'Riverside Art and Music Atelier' }, district: 'Parks & River', kind: 'building' },
  botanical: { name: { vi: 'Vườn Thực vật Cộng đồng', en: 'Community Botanical Garden' }, district: 'Hidden Gems', kind: 'outdoor' },
  lantern_garden: { name: { vi: 'Trà viên Đèn lồng Ẩn mình', en: 'Hidden Lantern Tea Garden' }, district: 'Hidden Gems', kind: 'outdoor' },
  fountain_plaza: { name: { vi: 'Quảng trường Đài phun nước Cổ', en: 'Old Campus Fountain Court' }, district: 'Hidden Gems', kind: 'outdoor' },
};
