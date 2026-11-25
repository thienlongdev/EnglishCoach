/**
 * Echo Life Phase 4 — V3's interactive world props, keepsakes and live-event booths placed in the real Phase 2 world,
 * plus interactive residence furnishings for all 5 purchasable Market Boulevard homes.
 *
 * Every V3 zone (`world-data/world.mjs`) lists its interactive props in zone-local metres (sofa → sit, stove → cook, ring toss
 * → rings, library catalog → archive_research, shop counters → shop_<store>…). The Phase 2 city already furnished the same
 * rooms and buildings from the same studios' libraries, so each prop is anchored to the matching Phase 2 furnishing in that
 * zone (by model alias, nearest to the prop's proportional place); props with no counterpart keep their proportional place.
 * Each hotspot also gets a stand spot: the nearest point a body may stand, inside the same zone. V3's own rules then decide
 * what the prop does (`choices` / `interact`), unchanged.
 */
import { BODY_RADIUS, inRect, type HousePlan, type Rect } from '../plan';
import type { CityPlan } from '../city';
import type { EnterableBuilding } from '../buildings';
import type { V3ZoneId } from '../zones';
import type { LifeNav, P } from './nav';
import type { LifeWalk } from '../walk';
import { COLLECTIBLES, zones as V3_ZONES, type V3Zone } from '../v3/game-core/index.mjs';

export type HotspotKind = 'prop' | 'relic' | 'event';
export interface Hotspot {
  /** `zone/propId` — unique. */
  key: string;
  zone: V3ZoneId;
  /** The id V3 knows the entity by (`interact(s, id, choice)`). */
  id: string;
  action: string;
  model: string;
  kind: HotspotKind;
  /** Where the thing is (marker), and where a body stands to use it. */
  at: P;
  stand: P;
  /** V3 zone-local position: the virtual player stands exactly here when V3's own `interact` runs. */
  local: P;
  /** The Phase 2 furnishing it was anchored to, if any. */
  anchored: string | null;
}

/** Interactive furnishing hotspot inside one of the 5 purchasable Market Boulevard residences. */
export interface ResidenceHotspot extends Hotspot {
  propertyId: string;
  y: number;
  label: string;
}

/** V3 model → Phase 2 staged asset key (the same object from the same Codex/Gemini libraries). */
export const MODEL_ALIAS: Record<string, string> = {
  home_sofa: 'sofa', sofa_veranda: 'sofa', home_television: 'tv', tv_smart_55: 'tv', home_floor_lamp: 'floorlamp',
  kitchenette_kitchen_stove: 'stove', stove_veranda: 'stove', kitchenette_kitchen_fridge_large: 'fridge', fridge_modern_gem: 'fridge',
  kitchen_sink: 'sink', furniture_desk: 'table', desk_electric_lift: 'table', desk_trestle_student: 'table', club_chair_veranda: 'chair',
  furniture_bed_single: 'bed-single', flat_cabinet_bed: 'wardrobe', wash_bathroom_sink: 'basin', bathroom_shower: 'shower',
  v3_garden_trough: 'planter-trough', v3_garden_planter: 'planter-trough', chair_ergo_gaming: 'gaming-chair', floor_lamp_arcade: 'arcade-lamp',
  balcony_side_table_veranda: 'balcony-table', garage_workbench: 'workbench', street_bus_shelter: 'shelter', street_mailbox: 'mailbox',
  street_wayfinding_sign: 'sign',
  v3_map_kiosk: 'map-kiosk', v3_art_easel: 'art-easel', v3_polaroid_prop: 'table',
  furniture_bench_cushion: 'bench-cushion', shop_bench_entry_fjord: 'bench-cushion',
  v3_electric_guitar: 'guitar-electric', v3_acoustic_guitar: 'guitar-acoustic', market_aisle_shelf: 'market-shelf',
  market_checkout_counter: 'market-checkout', shop_patisserie_case: 'patisserie-case', cafe_gaming_desk: 'gaming-desk',
  desk_gaming_pro: 'gaming-desk', desk_nordic_drawer: 'gaming-desk', desk_walnut_executive: 'gaming-desk', cafe_monitor: 'gaming-monitor',
  mon_triple_coding: 'gaming-monitor', cafe_gaming_chair: 'gaming-chair', pc_case_glass_tower: 'gaming-pc', pc_case_liquid_spine: 'gaming-pc',
  park_basketball_hoop: 'hoop-post', park_badminton_racket: 'badminton-net', park_slatted_bench: 'bench',
  amusement_ring_toss: 'fair-ringtoss', amusement_prize_wheel: 'fair-wheel', v3_crepe_kiosk: 'crepe-kiosk',
  campus_festival_posterboard: 'campus-posterboard', campus_library_cart: 'library-trolley', festival_booth: 'festival-booth-en',
  festival_lectern: 'festival-lectern', v3_guardhouse: 'campus-guardhouse', v3_library_table: 'library-table',
  v3_library_catalog: 'library-desk', v3_library_bookcase: 'library-stack', v3_cafe_booth: 'cafe-booth', espresso_veranda: 'espresso',
  v3_tea_service: 'tea-service', v3_park_gazebo: 'park-gazebo', v3_watering_can: 'watering-can', v3_garden_bench: 'patio-set',
  v3_street_lantern: 'street-lantern', v3_fountain_court: 'fountain-tiered', v3_festival_stage: 'festival-stage',
  v3_statue_obelisk: 'statue-obelisk', shop_display_cabinet_veranda: 'display-cabinet', bed_canopy_palais: 'canopy-bed',
  shop_garment_carousel: 'garment-rack', car_lotus_spider: 'car-spider', veh_moto_cafe_racer: 'moto-commuter',
  veh_ebike_commuter: 'scooter-ev', veh_part_wheel_sport: 'moto-commuter', kitchen_island_veranda: 'kitchen-island',
  bath_tub_veranda: 'soaking-tub', shop_photocopier: 'photocopier',
};

/** Per-hotspot ordered candidate anchors so every signature world prop snaps onto a real 3D physical fixture. */
const HOTSPOT_ALIAS: Record<string, readonly string[]> = {
  'hall/drawer': ['mailbox', 'plant'],
  'street/courier_board': ['parcel-locker'],
  'street/street_kiosk': ['map-kiosk', 'atm-kiosk'],
  'street/mail': ['mailbox', 'parcel-locker', 'sign'],
  'linh/letters': ['table'],
  'minh/ball': ['gaming-desk'],
  'campus/seminar_board': ['campus-posterboard', 'campus-colonnade'],
  'electronics_shop/display_rig_b': ['gaming-pc', 'display-cabinet'],
  'atelier/atelier_photo_desk': ['table'],
  'fountain_plaza/plaza_booth': ['festival-booth-en', 'whale-monument'],
  'lantern_garden/tea_pavilion_table': ['tea-service', 'patio-set'],
};

/** Multi-asset fallbacks when a V3 model maps to a zone-appropriate physical furnishing/prop. */
const FALLBACK_ALIAS: Record<string, readonly string[]> = {
  v3_tea_service: ['tea-service', 'patio-set'],
  v3_garden_bench: ['patio-set', 'bench'],
  v3_camera_prop: [
    'street-lantern',
    'park-gazebo',
    'patio-set',
    'sign',
    'lamp',
    'map-kiosk',
    'whale-monument',
    'fountain-tiered',
    'statue-obelisk',
    'campus-posterboard',
    'shelter',
    'bench',
  ],
};

interface Furn { asset: string; x: number; z: number; zone: V3ZoneId; used: boolean }

/** Phase 2 furnishings and physical outdoor props (assets, benches, bus shelters, signs, lamps), by V3 zone. */
function furnishings(house: HousePlan, city: CityPlan, nav: LifeNav): Furn[] {
  const out: Furn[] = [];
  const zoneOf = (p: P) => nav.walk.surface(p)?.zone ?? null;
  for (const f of house.furniture) { const z = zoneOf(f); if (z) out.push({ asset: f.asset, x: f.x, z: f.z, zone: z, used: false }); }
  for (const b of city.buildings) for (const f of b.furniture) out.push({ asset: f.asset, x: f.x, z: f.z, zone: b.id, used: false });
  for (const p of city.props) {
    const asset = p.kind === 'asset'
      ? p.asset
      : (p.kind === 'bench' || p.kind === 'shelter' || p.kind === 'sign' || p.kind === 'lamp' ? p.kind : null);
    if (!asset) continue;
    const z = zoneOf(p);
    if (z) out.push({ asset, x: p.x, z: p.z, zone: z, used: false });
  }
  return out;
}

/** A V3 zone-local point placed proportionally inside the Phase 2 zone. */
export function proportional(zone: V3Zone, rect: { x0: number; x1: number; z0: number; z1: number }, local: P): P {
  const hx = zone.size / 2, hz = (zone.depth || zone.size) / 2;
  const u = Math.max(-1, Math.min(1, local.x / hx)), v = Math.max(-1, Math.min(1, local.z / hz));
  return { x: (rect.x0 + rect.x1) / 2 + u * (rect.x1 - rect.x0) / 2 * .78, z: (rect.z0 + rect.z1) / 2 + v * (rect.z1 - rect.z0) / 2 * .78 };
}

/** The nearest point a body may stand at, in the same zone, within `reach` metres (rings of 0.25 m). */
export function standNear(nav: {walk: LifeWalk}, zone: V3ZoneId, at: P, reach = 4): P | null {
  const ok = (p: P) => nav.walk.free(p) && nav.walk.zone(p) === zone;
  if (ok(at)) return at;
  for (let r = .5; r <= reach; r += .25) {
    const n = Math.max(8, Math.round(r * 10));
    for (let i = 0; i < n; i++) {
      const t = i / n * Math.PI * 2, p = { x: at.x + Math.cos(t) * r, z: at.z + Math.sin(t) * r };
      if (ok(p)) return p;
    }
  }
  return null;
}

export function buildHotspots(house: HousePlan, city: CityPlan, nav: LifeNav, playerWalk?: LifeWalk): Hotspot[] {
  const furn = furnishings(house, city, nav);
  const out: Hotspot[] = [];
  const bathZoneDef = house.zones.find(z => z.id === 'bath');
  const bathRect = bathZoneDef?.rect ?? null;
  const walkForPlayer = playerWalk ?? nav.walk;

  const pickAnchor = (zoneId: V3ZoneId, target: P, candidates: readonly string[], allowShared: boolean): Furn | null => {
    for (const asset of candidates) {
      let best: Furn | null = null;
      for (const f of furn) {
        if (f.zone !== zoneId || f.asset !== asset || (!allowShared && f.used)) continue;
        if (!best || Math.hypot(f.x - target.x, f.z - target.z) < Math.hypot(best.x - target.x, best.z - target.z)) best = f;
      }
      if (best) return best;
    }
    return null;
  };
  const place = (zoneId: V3ZoneId, id: string, action: string, model: string, kind: HotspotKind, local: P) => {
    const zone = V3_ZONES[zoneId], def = city.zones.find(z => z.id === zoneId);
    if (!zone || !def) return;
    const target = proportional(zone, def.rect, local);
    const key = `${zoneId}/${id}`;
    let anchor: Furn | null = null;
    if (kind === 'prop') {
      const candidates: string[] = [];
      const addList = (list?: readonly string[] | string) => {
        if (!list) return;
        if (typeof list === 'string') { if (!candidates.includes(list)) candidates.push(list); return; }
        for (const a of list) if (!candidates.includes(a)) candidates.push(a);
      };
      addList(HOTSPOT_ALIAS[key]);
      addList(FALLBACK_ALIAS[model]);
      addList(MODEL_ALIAS[model]);

      // A2 Bench Anti-Hijack Contract: keep Park and House Lobby benches pure sittable benches whenever any non-bench prop/fallback exists.
      if (key === 'hall/drawer' || model === 'v3_camera_prop' || action === 'photo_snap') {
        const nonBench = candidates.filter(c => c !== 'bench');
        anchor = pickAnchor(zoneId, target, nonBench, false);
        if (!anchor && (action === 'photo_snap' || key === 'hall/drawer')) {
          anchor = pickAnchor(zoneId, target, nonBench, true);
        }
        if (!anchor && candidates.includes('bench')) {
          anchor = pickAnchor(zoneId, target, ['bench'], false);
        }
      } else {
        anchor = pickAnchor(zoneId, target, candidates, false);
        if (!anchor && key === 'campus/seminar_board') {
          anchor = pickAnchor(zoneId, target, candidates, true);
        }
      }
    }
    if (anchor) anchor.used = true;

    // Walk-in SE bathroom shower (`bath/shower`) and vanity basin (`bath/basin`) derived from `plan.zones` `bath` rect for all room sizes 4..9 m.
    if (zoneId === 'bath' && bathRect && kind === 'prop') {
      if (id === 'shower') {
        const mixerAt: P = { x: bathRect.x1 - 0.56, z: bathRect.z1 - 0.58 };
        const sprayCenter: P = { x: bathRect.x1 - 0.56, z: bathRect.z1 - 0.58 };
        const sprayWalkable = walkForPlayer.free(sprayCenter) && walkForPlayer.zone(sprayCenter) === 'bath';
        const stand = sprayWalkable
          ? sprayCenter
          : standNear({ walk: walkForPlayer }, 'bath', sprayCenter) ??
            standNear(nav, 'bath', anchor ? { x: anchor.x, z: anchor.z } : mixerAt) ??
            def.waypoint;
        out.push({
          key,
          zone: zoneId,
          id,
          action,
          model,
          kind,
          at: anchor ? { x: anchor.x, z: bathRect.z1 - 0.58 } : mixerAt,
          stand,
          local,
          anchored: anchor?.asset ?? 'shower',
        });
        return;
      }
      if (id === 'basin') {
        const basinAt: P = anchor ? { x: anchor.x, z: anchor.z } : { x: bathRect.x0 + 2.72, z: bathRect.z1 - 0.30 };
        const basinDesiredStand: P = { x: basinAt.x - 0.16, z: bathRect.z1 - 0.84 };
        const stand =
          standNear({ walk: walkForPlayer }, 'bath', basinDesiredStand) ??
          standNear(nav, 'bath', basinAt) ??
          def.waypoint;
        out.push({
          key,
          zone: zoneId,
          id,
          action,
          model,
          kind,
          at: basinAt,
          stand,
          local,
          anchored: anchor?.asset ?? 'basin',
        });
        return;
      }
    }

    const at = anchor ? { x: anchor.x, z: anchor.z } : target;
    // Residents cannot enter the learner's room. Its collectible follows the player's furniture collision map.
    const stand = zoneId === 'study'
      ? playerWalk ? standNear({walk: playerWalk}, zoneId, at, house.h * 2) : at
      : standNear(nav, zoneId, at) ?? standNear(nav, zoneId, def.waypoint) ?? def.waypoint;
    if (!stand) return;
    out.push({ key, zone: zoneId, id, action, model, kind, at: anchor ? at : stand, stand, local, anchored: anchor?.asset ?? null });
  };
  for (const [zoneId, zone] of Object.entries(V3_ZONES)) {
    // The study room is the learner's own room: its desk, lamp and door are the Study Space's own (see `session.ts`).
    if (zoneId === 'study') continue;
    for (const p of zone.props) {
      // The bicycle is a vehicle (see `session.ts`); the broom's hotspot is its rack (V3 shows `broom` or `rack` there).
      if (!p.action || p.action === 'ride') continue;
      place(zoneId as V3ZoneId, p.id, p.action, p.model, 'prop', { x: p.x, z: p.z });
    }
  }

  // Dedicated bathroom mirror and toilet hotspots derived from `plan.zones` `bath` rect and house furnishings.
  if (bathRect) {
    const mirrorFurn = furn.find(f => f.zone === 'bath' && f.asset === 'mirror');
    const houseMirror = house.furniture.find(f => f.asset === 'mirror');
    if (mirrorFurn) mirrorFurn.used = true;
    const mirrorX = mirrorFurn?.x ?? houseMirror?.x ?? (bathRect.x0 + 2.72);
    const mirrorAt: P = { x: mirrorX, z: mirrorFurn?.z ?? houseMirror?.z ?? (bathRect.z1 - 0.03) };
    const mirrorStand =
      standNear({ walk: walkForPlayer }, 'bath', { x: mirrorX, z: bathRect.z1 - 0.78 }) ??
      standNear(nav, 'bath', mirrorAt);
    if (mirrorStand) {
      out.push({
        key: 'bath/mirror',
        zone: 'bath',
        id: 'mirror',
        action: 'mirror',
        model: 'mirror',
        kind: 'prop',
        at: mirrorAt,
        stand: mirrorStand,
        local: { x: -1.7, z: -1.9 },
        anchored: mirrorFurn || houseMirror ? 'mirror' : null,
      });
    }

    const toiletFurn = furn.find(f => f.zone === 'bath' && f.asset === 'toilet');
    const houseToilet = house.furniture.find(f => f.asset === 'toilet');
    if (toiletFurn) toiletFurn.used = true;
    const toiletX = toiletFurn?.x ?? houseToilet?.x ?? (bathRect.x0 + 1.88);
    const toiletAt: P = { x: toiletX, z: toiletFurn?.z ?? houseToilet?.z ?? (bathRect.z1 - 0.32) };
    const toiletStand =
      standNear({ walk: walkForPlayer }, 'bath', { x: toiletX, z: bathRect.z1 - 0.86 }) ??
      standNear(nav, 'bath', toiletAt);
    if (toiletStand) {
      out.push({
        key: 'bath/toilet',
        zone: 'bath',
        id: 'toilet',
        action: 'toilet',
        model: 'toilet',
        kind: 'prop',
        at: toiletAt,
        stand: toiletStand,
        local: { x: 0, z: -1.9 },
        anchored: toiletFurn || houseToilet ? 'toilet' : null,
      });
    }
  }

  for (const c of COLLECTIBLES) {
    place(c.zone as V3ZoneId, c.id, 'collect_relic', c.model, 'relic', { x: c.x, z: c.z });
  }
  // One live-event booth spot per zone (V3: `event-<id>` at zone-local (0, 0.6)); shown only while an event is live there.
  for (const zoneId of Object.keys(V3_ZONES)) if (zoneId !== 'study') place(zoneId as V3ZoneId, 'event', 'event_participate', '', 'event', { x: 0, z: .6 });
  return out;
}

function insideFlatRect(p: P, rect: Rect, margin: number): boolean {
  return p.x >= rect.x0 + margin && p.x <= rect.x1 - margin && p.z >= rect.z0 + margin && p.z <= rect.z1 - margin;
}

function residenceStandNear(home: EnterableBuilding, at: P, y: number): P | null {
  const flatZones = home.zones.filter(z => z.y1 === undefined && Math.abs(z.y - y) < 0.35);
  if (!flatZones.length) return null;
  const ok = (p: P) => {
    if (!flatZones.some(z => insideFlatRect(p, z.rect, BODY_RADIUS))) return false;
    for (const bl of home.blocks) {
      if (inRect(p, { x0: bl.rect.x0 - BODY_RADIUS, x1: bl.rect.x1 + BODY_RADIUS, z0: bl.rect.z0 - BODY_RADIUS, z1: bl.rect.z1 + BODY_RADIUS })) return false;
    }
    for (const f of home.furniture) {
      if (f.footprint && Math.abs(f.y - y) < 1.2 &&
          inRect(p, { x0: f.footprint.x0 - BODY_RADIUS, x1: f.footprint.x1 + BODY_RADIUS, z0: f.footprint.z0 - BODY_RADIUS, z1: f.footprint.z1 + BODY_RADIUS })) return false;
    }
    return true;
  };
  if (ok(at)) return at;
  for (let r = 0.45; r <= 3.5; r += 0.25) {
    const n = Math.max(8, Math.round(r * 10));
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const p = { x: at.x + Math.cos(t) * r, z: at.z + Math.sin(t) * r };
      if (ok(p)) return p;
    }
  }
  return null;
}

/**
 * Interactive furnishings for all 5 purchasable Market Boulevard residences (`city.residences`):
 * sofas, dining tables, kitchen stoves, upper-floor beds, walk-in showers, soaking tubs, and bookcases.
 */
export function buildResidenceHotspots(city: CityPlan): ResidenceHotspot[] {
  const out: ResidenceHotspot[] = [];
  for (const home of city.residences) {
    const propertyId = home.property?.id;
    if (!propertyId) continue;
    home.furniture.forEach((f, idx) => {
      let zone: V3ZoneId;
      let id: string;
      let action: string;
      let label: string;
      let local: P = { x: 0, z: 0 };
      if (f.asset === 'sofa' || f.asset.startsWith('sofa_')) {
        zone = 'living'; id = 'sofa'; action = 'sit'; label = 'Rest on the sofa'; local = { x: -2, z: -2.6 };
      } else if (f.asset === 'chair' || f.asset.startsWith('club_chair') || f.asset === 'gaming-chair' || f.asset === 'bench-cushion') {
        zone = 'living'; id = 'chair'; action = 'sit'; label = 'Rest in the lounge chair'; local = { x: -1.2, z: -1.8 };
      } else if (f.asset === 'stove' || f.asset === 'kitchen-island' || f.asset.startsWith('stove_')) {
        zone = 'kitchen'; id = 'stove'; action = 'cook'; label = 'Cook or brew tea'; local = { x: -2.7, z: -2.1 };
      } else if (f.asset === 'espresso' || f.asset.startsWith('espresso_')) {
        zone = 'kitchen'; id = 'residence_espresso'; action = 'use_appliance'; label = 'Brew home espresso'; local = { x: -2.2, z: -1.5 };
      } else if (f.asset === 'table') {
        zone = 'kitchen'; id = 'table'; action = 'eat'; label = 'Eat at the dining table'; local = { x: 2.6, z: 1 };
      } else if (f.asset.startsWith('bed_') || f.asset === 'bed-single' || f.asset === 'canopy-bed') {
        zone = 'bedroom'; id = 'bed'; action = 'sleep'; label = 'Go to sleep'; local = { x: -2, z: -1.8 };
      } else if (f.asset === 'shower' || f.asset.startsWith('shower_')) {
        zone = 'bath'; id = 'residence_shower'; action = 'shower'; label = 'Take a shower'; local = { x: 0, z: 0 };
      } else if (f.asset === 'soaking-tub' || f.asset.startsWith('bath_tub')) {
        zone = 'bath'; id = 'residence_bath'; action = 'bath_soak'; label = 'Take a warm soak'; local = { x: 0, z: 0 };
      } else if (f.asset.startsWith('bookcase_') || f.asset === 'gaming-desk' || f.asset.startsWith('desk_')) {
        zone = 'living'; id = 'residence_bookcase'; action = 'residence_study'; label = 'Read and study at your residence desk'; local = { x: 0, z: 0 };
      } else {
        return;
      }
      const at = { x: f.x, z: f.z };
      const stand = residenceStandNear(home, at, f.y);
      if (!stand) return;
      out.push({
        key: `${propertyId}/${id}:${idx}`,
        propertyId,
        zone,
        id,
        action,
        model: f.asset,
        kind: 'prop',
        at,
        stand,
        local,
        anchored: f.asset,
        y: f.y,
        label,
      });
    });
  }
  return out;
}
