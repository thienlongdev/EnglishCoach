import type { ArenaIslandProfile, ArenaIslandSpec, ArenaWaterMode } from './arenaContracts';
import layout from './arenaLayout.json';

export { layout as arenaLayout };

export const ARENA_WATER_Y = -1.2;
/** Maritime navigation boundary for rowboats, sampans, launches, and cruisers (> 1 km diameter sea). */
export const ARENA_BOAT_LIMIT = 515;
/** Outer swimming and walking boundary for players across the archipelago. */
export const ARENA_PLAYER_LIMIT = 540;
/** Buoyant foot support elevation for surface swimmers (head and shoulders above ARENA_WATER_Y = -1.2 m). */
export const ARENA_SWIM_SUPPORT_Y = ARENA_WATER_Y - 0.95;

/** Wooden rowboat / skiff hull as four overlapping circles, bow first: [metres along keel (+ = bow), radius]. */
export const ARENA_HULL: readonly (readonly [number, number])[] = [
  [1.52, 0.5],
  [0.62, 0.72],
  [-0.36, 0.72],
  [-1.28, 0.55],
];

/** Traditional coastal wooden sampan hull (~5.0 m length, five overlapping circles). */
export const SAMPAN_HULL: typeof ARENA_HULL = [
  [2.1, 0.48],
  [1.05, 0.76],
  [0.0, 0.8],
  [-1.05, 0.74],
  [-1.95, 0.5],
];

/** Twin-seat coastal motor launch hull (pelagic / tern). */
export const MOTOR_HULL: typeof ARENA_HULL = [
  [2.83, 0.65],
  [1.72, 1.04],
  [0.5, 1.18],
  [-0.85, 1.17],
  [-2.05, 1.12],
  [-2.96, 0.58],
];

/** Multi-passenger coastal cabin cruiser hull (~8.5 m length, six overlapping circles). */
export const CRUISER_HULL: typeof ARENA_HULL = [
  [3.65, 0.72],
  [2.35, 1.24],
  [0.95, 1.38],
  [-0.55, 1.38],
  [-2.05, 1.32],
  [-3.45, 0.78],
];

/** Height of the gunwale above the water, where a foot goes when stepping out. */
const GUNWALE_Y = ARENA_WATER_Y + 0.42;

type Island = ArenaIslandSpec & (typeof layout.islands)[number];

export function arenaHullForModel(model?: string | null): typeof ARENA_HULL {
  if (!model || model === 'skiff') return ARENA_HULL;
  if (model === 'sampan') return SAMPAN_HULL;
  if (model === 'cruiser') return CRUISER_HULL;
  return MOTOR_HULL;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 === e0) return x >= e1 ? 1 : 0;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function segmentPoint(ax: number, az: number, bx: number, bz: number, x: number, z: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const length2 = dx * dx + dz * dz;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2)) : 0;
  return { t, distance: Math.hypot(x - ax - t * dx, z - az - t * dz) };
}

function dockElevation(ah: number, bh: number, t: number): number {
  const ramp = t <= 0.12 ? 0 : t >= 0.76 ? 1 : (t - 0.12) / 0.64;
  const s = ramp * ramp * (3 - 2 * ramp);
  return ah + (bh - ah) * s;
}

/**
 * Smooth 0..1 weight indicating whether bearing `angle` lies along `island`'s natural sandy swimming beach arc.
 * Identical formula in ArenaGeometry.java.
 */
export function arenaBeachFactor(island: ArenaIslandSpec, angle: number): number {
  if (island.beachStart == null || island.beachEnd == null) return 0;
  const mid = 0.5 * (island.beachStart + island.beachEnd);
  const half = 0.5 * Math.abs(island.beachEnd - island.beachStart);
  if (half <= 1e-6) return 0;
  const d = Math.abs(angleDiff(angle, mid));
  return 1 - smoothstep(Math.max(0, half - 0.14), half + 0.18, d);
}

/**
 * Multi-lobe organic coastline radius where the island meets ARENA_WATER_Y (-1.2 m).
 * Uses integer harmonics (3, 5, 7, 13) so the shoreline is strictly 2*PI-periodic with zero seam.
 * Shared identically by mesh builders, bathymetry, and boat hull collision on FE and BE.
 */
export function arenaShoreRadius(island: ArenaIslandSpec, angle: number): number {
  const l3 = island.lobe3 ?? 0;
  const l5 = island.lobe5 ?? 0;
  const s = island.seed;
  return (
    island.radius * 0.885 +
    island.shore +
    l3 * island.radius * Math.sin(angle * 3 + s * 1.1) +
    l5 * island.radius * Math.cos(angle * 5 - s * 0.7) +
    Math.sin(angle * 7 + s) * 1.15 +
    Math.sin(angle * 13 + s * 2) * 0.42
  );
}

function islandInteriorCrown(
  island: ArenaIslandSpec,
  dx: number,
  dz: number,
  r: number,
  angle: number,
  bf: number,
): number {
  const profile: ArenaIslandProfile = (island.profile as ArenaIslandProfile | undefined) ?? 'outer';
  const s = island.seed;
  const radial = smoothstep(4, 22, r);
  const bfR = bf * radial;

  if (profile === 'harbor') {
    // Keep central Pearl Harbor arrival plaza (r <= 31 m) strictly at y = 0.0 m for spawns, tables, and benches.
    if (r <= 31) return 0;
    const prom = 0.78 * smoothstep(31, 50, r) * (1 - 0.58 * bfR);
    const northTerrace =
      2.82 * smoothstep(-26, -55, dz) * (1 - smoothstep(18, 46, Math.abs(dx + 4)));
    return prom + northTerrace;
  }

  if (profile === 'beach') {
    const ridgeDist = Math.hypot(dx + 16, dz + 18);
    const undul = 0.22 * Math.sin(dx * 0.055 + s) * Math.cos(dz * 0.055 - s);
    return (
      0.92 +
      1.78 * (1 - smoothstep(18, 74, r)) +
      1.42 * (1 - smoothstep(8, 38, ridgeDist)) +
      undul
    );
  }

  if (profile === 'karst') {
    const lookoutDist = Math.hypot(dx + 20, dz + 18);
    const lookoutTerrace = 5.65 * (1 - smoothstep(15, 52, lookoutDist));
    const micro = 0.2 * Math.sin(dx * 0.07 + s) * Math.cos(dz * 0.07 - s);
    return 1.85 * (1 - 0.45 * bfR) + lookoutTerrace + micro;
  }

  if (profile === 'village') {
    const hillside =
      2.15 * smoothstep(-8, -48, dx) * (1 - smoothstep(25, 62, Math.abs(dz)));
    const micro = 0.1 * Math.sin(dx * 0.06 + dz * 0.05 + s);
    return 1.45 * (1 - 0.35 * bfR) + hillside + micro;
  }

  if (profile === 'mountain') {
    const sumDist = Math.hypot(dx + 6, dz + 10);
    const climb = 1 - smoothstep(12, 74, sumDist);
    const terraces = 0.22 * Math.sin(climb * Math.PI * 3) * climb * (1 - climb);
    const baseMtn = 1.4 + (island.height - 1.4) * (climb + terraces);
    // Carved cascading waterfall plunge-basin terrace on the southern rainforest slope (+6, -189 world)
    const basinDist = Math.hypot(dx - 16, dz - 26);
    const basinWeight = 1 - smoothstep(8, 19, basinDist);
    return baseMtn + (4.2 - baseMtn) * basinWeight * 0.82;
  }

  if (profile === 'islet') {
    return (
      0.85 * (1 - 0.35 * bfR) +
      Math.max(0, island.height - 0.85) * (1 - smoothstep(3.5, island.radius * 0.82, r)) +
      0.12 * radial * Math.sin(angle * 4 + s)
    );
  }

  // 'outer' (outer_archipelago, lighthouse)
  return (
    1.25 * (1 - 0.35 * bfR) +
    Math.max(0, island.height - 1.25) * (1 - smoothstep(10, island.radius * 0.78, r)) +
    0.16 * Math.sin(dx * 0.075 + s)
  );
}

function islandLandElevation(
  island: ArenaIslandSpec,
  dx: number,
  dz: number,
  r: number,
  shoreR: number,
  angle: number,
  bf: number,
): number {
  const profile: ArenaIslandProfile = (island.profile as ArenaIslandProfile | undefined) ?? 'outer';

  if (profile === 'atoll') {
    // Ring-shaped coral-sand atoll cradling a shallow -2.4 m to -6.2 m central turquoise snorkeling lagoon
    const ldx = dx;
    const ldz = dz - 2;
    const lr = Math.hypot(ldx, ldz);
    const lAngle = Math.atan2(ldz, ldx);
    const lagoonR =
      35 + 3.0 * Math.sin(lAngle * 3 + island.seed) + 1.6 * Math.cos(lAngle * 5 - island.seed);
    if (lr < lagoonR) {
      const innerDist = lagoonR - lr;
      const shallow = ARENA_WATER_Y - innerDist * 0.135;
      const basin = -6.1 + 0.45 * Math.sin(dx * 0.09) * Math.cos(dz * 0.09);
      const blend = smoothstep(7, 24, innerDist);
      return shallow + (basin - shallow) * blend;
    }
    const innerRise = smoothstep(0, 11, lr - lagoonR);
    const cliffW = island.shore;
    const beachW = 15.5;
    const margin = cliffW + (beachW - cliffW) * bf;
    const rimT = clamp01((shoreR - r) / Math.max(0.5, margin));
    const beachRise = rimT * (1.18 - 0.18 * rimT);
    const cliffRise = rimT * rimT * (3 - 2 * rimT);
    const outerRise = cliffRise + (beachRise - cliffRise) * bf;
    const cayCrown =
      island.height +
      0.34 * Math.sin(angle * 2 + island.seed) +
      0.14 * Math.sin(dx * 0.07 + dz * 0.06);
    return ARENA_WATER_Y + (cayCrown - ARENA_WATER_Y) * innerRise * outerRise;
  }

  const cliffW = island.shore;
  const beachW = Math.min(19, Math.max(8.5, 0.22 * island.radius));
  const margin = cliffW + (beachW - cliffW) * bf;
  const rimT = clamp01((shoreR - r) / Math.max(0.5, margin));
  const beachRise = rimT * (1.18 - 0.18 * rimT);
  const cliffRise = rimT * rimT * (3 - 2 * rimT);
  const coastalRise = cliffRise + (beachRise - cliffRise) * bf;
  const crownY = islandInteriorCrown(island, dx, dz, r, angle, bf);
  return ARENA_WATER_Y + (crownY - ARENA_WATER_Y) * coastalRise;
}

/**
 * Continuous natural terrain and seabed elevation across the entire archipelago:
 * +16.5 m mountain summit -> 0 m harbor plaza -> gentle -1.2 m beaches -> -4.5 m coral lagoons
 * -> -16 m navigable channels -> -28 m outer reef wall -> -34 m deep ocean.
 */
export function arenaBathymetry(x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return -34;
  const worldR = Math.hypot(x, z);
  const oceanTrend = -14.5 - 19.5 * smoothstep(140, 480, worldR);
  const seabedWaves =
    1.55 * Math.sin(x * 0.017 + z * 0.013) +
    1.05 * Math.cos(x * 0.029 - z * 0.023) +
    0.5 * Math.sin(x * 0.061 + z * 0.047);
  // Outer southern abyssal reef trench drop-off (-28 m .. -34 m) south of Coral Lagoon
  const reefDropOff = -8.5 * smoothstep(265, 335, z) * (1 - smoothstep(95, 220, Math.abs(x - 18)));
  const base = Math.max(-35.5, oceanTrend + seabedWaves + reefDropOff);

  let best = base;
  for (const i of layout.islands as readonly Island[]) {
    const dx = x - i.x;
    const dz = z - i.z;
    const maxReach = i.radius * 1.25 + i.shore + 56;
    if (Math.abs(dx) > maxReach || Math.abs(dz) > maxReach) continue;
    const r = Math.hypot(dx, dz);
    if (r > maxReach) continue;

    const angle = Math.atan2(dz, dx);
    const shoreR = arenaShoreRadius(i, angle);
    const bf = arenaBeachFactor(i, angle);

    if (r <= shoreR) {
      return islandLandElevation(i, dx, dz, r, shoreR, angle, bf);
    }

    const seaDist = r - shoreR;
    const profile: ArenaIslandProfile = (i.profile as ArenaIslandProfile | undefined) ?? 'outer';
    const shallowSlope = 0.65 + (0.122 - 0.65) * bf;
    const shelfDepth = profile === 'atoll' ? -4.5 : profile === 'beach' ? -3.8 : -6.2;
    const nearY = ARENA_WATER_Y - seaDist * shallowSlope;
    const shelfBlend = smoothstep(5 + 9 * bf, 18 + 12 * bf, seaDist);
    const midY = nearY + (shelfDepth - nearY) * shelfBlend;
    const deepSpan = profile === 'atoll' ? 28 : 34;
    const deepBlend = smoothstep(10 + 6 * bf, deepSpan, seaDist);
    const islandSeaY = midY + (base - midY) * deepBlend;
    if (islandSeaY > best) best = islandSeaY;
  }
  return best;
}

/**
 * Authoritative structural + terrain elevation:
 * returns bridge deck, pier deck, or arenaBathymetry(x, z) (> -1.2 on dry land/decks, < -1.2 in water).
 */
export function arenaHeight(x: number, z: number): number {
  for (const b of layout.bridges) {
    const p = segmentPoint(b.ax, b.az, b.bx, b.bz, x, z);
    if (p.distance <= b.width / 2) {
      return b.ah + (b.bh - b.ah) * p.t + Math.sin(p.t * Math.PI) * 0.25;
    }
  }
  for (const d of layout.docks) {
    const p = segmentPoint(d.ax, d.az, d.bx, d.bz, x, z);
    if (p.distance <= d.width / 2) return dockElevation(d.ah, d.bh, p.t);
  }
  return arenaBathymetry(x, z);
}

export function arenaOnWood(x: number, z: number): boolean {
  for (const b of layout.bridges) {
    if (segmentPoint(b.ax, b.az, b.bx, b.bz, x, z).distance <= b.width / 2) return true;
  }
  for (const d of layout.docks) {
    if (segmentPoint(d.ax, d.az, d.bx, d.bz, x, z).distance <= d.width / 2) return true;
  }
  return false;
}

const surfaces = layout.furniture.map(f => ({
  ...f,
  c: Math.cos(f.yaw),
  s: Math.sin(f.yaw),
  base: arenaHeight(f.x, f.z),
}));

/** Tropical speaking pavilion stone plinths (`+0.245 * scale` octagonal slab with smooth perimeter step ramp). */
export const ARENA_PAVILIONS = [
  { x: 206, z: 98, scale: 1.0, base: arenaBathymetry(206, 98) },
  { x: 8, z: 278, scale: 0.95, base: arenaBathymetry(8, 278) },
  { x: -16, z: -228, scale: 1.0, base: arenaBathymetry(-16, -228) },
  { x: 256, z: -196, scale: 0.95, base: arenaBathymetry(256, -196) },
] as const;

export const arenaSeats = surfaces.flatMap(f =>
  Array.from({ length: f.seats }, (_, i) => {
    const along = ((i + 0.5) / f.seats - 0.5) * f.width;
    return {
      id: f.id + '-' + i,
      x: f.x + f.c * along,
      z: f.z - f.s * along,
      y: f.base + f.top,
      yaw: f.yaw + Math.PI,
    };
  }),
);

export function arenaFloor(x: number, z: number): number {
  const baseH = arenaHeight(x, z);
  let top = baseH;
  for (const pav of ARENA_PAVILIONS) {
    const outerR = 4.2 * pav.scale;
    const dx = x - pav.x;
    const dz = z - pav.z;
    if (Math.abs(dx) > outerR || Math.abs(dz) > outerR) continue;
    const d = Math.hypot(dx, dz);
    if (d >= outerR) continue;
    const slabY = pav.base + 0.245 * pav.scale;
    const t = clamp01((outerR - d) / (0.85 * pav.scale));
    const smoothT = t * t * (3 - 2 * t);
    top = Math.max(top, baseH + Math.max(0, slabY - baseH) * smoothT);
  }
  for (const f of surfaces) {
    const dx = x - f.x;
    const dz = z - f.z;
    if (Math.abs(dx) > 5 || Math.abs(dz) > 5) continue;
    const u = dx * f.c - dz * f.s;
    const v = dx * f.s + dz * f.c;
    if (
      f.kind === 'table'
        ? Math.hypot(dx, dz) > f.width / 2 + 0.12
        : Math.abs(u) > f.width / 2 + 0.12 || Math.abs(v) > f.depth / 2 + 0.12
    ) {
      continue;
    }
    top = Math.max(top, f.base + (f.back && v > 0.28 ? 1.2 : f.top));
  }
  return top;
}

/** Buoyant vertical support height: equals arenaFloor on dry/wading ground and ARENA_WATER_Y - 0.95 (-2.15 m) when swimming. */
export function arenaSupportY(x: number, z: number): number {
  return Math.max(arenaFloor(x, z), ARENA_SWIM_SUPPORT_Y);
}

/** Water column depth above arenaFloor (0 on dry land, bridges, and piers). */
export function arenaWaterDepth(x: number, z: number): number {
  return Math.max(0, ARENA_WATER_Y - arenaFloor(x, z));
}

function solidBlocked(x: number, z: number): boolean {
  for (const o of layout.obstacles) {
    const reach = o.radius + 0.3;
    if (Math.abs(x - o.x) < reach && Math.abs(z - o.z) < reach && Math.hypot(x - o.x, z - o.z) < reach) {
      return true;
    }
  }
  if (!arenaOnWood(x, z) && arenaHeight(x, z) < ARENA_WATER_Y + 0.25) {
    for (const k of layout.rocks) {
      if (k.h < 0.45) continue;
      const reach = k.r * 0.72 + 0.2;
      if (Math.abs(x - k.x) < reach && Math.abs(z - k.z) < reach && Math.hypot(x - k.x, z - k.z) < reach) {
        return true;
      }
    }
  }
  return false;
}

/** True in open or coastal water deeper than 0.85 m within ARENA_PLAYER_LIMIT, outside solid obstacles and pier decks. */
export function arenaSwimmable(x: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  if (Math.hypot(x, z) > ARENA_PLAYER_LIMIT) return false;
  if (arenaOnWood(x, z)) return false;
  if (arenaFloor(x, z) >= ARENA_WATER_Y - 0.85) return false;
  return !solidBlocked(x, z);
}

export function arenaIsSwimming(x: number, z: number): boolean {
  return arenaSwimmable(x, z);
}

export function arenaWaterMode(x: number, z: number, diveDepth = 0): ArenaWaterMode {
  if (arenaSwimmable(x, z)) {
    return diveDepth > 0.35 ? 'underwater_dive' : 'surface_swim';
  }
  const depth = arenaWaterDepth(x, z);
  return depth > 0.05 ? 'wading' : 'land';
}

/**
 * True strictly on dry walkable island terrain, bridges, and piers (above ARENA_WATER_Y).
 * Used for exact walkable land area integration and dry-pier landing verification.
 */
export function arenaDryWalkable(x: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  if (Math.hypot(x, z) > ARENA_PLAYER_LIMIT) return false;
  if (solidBlocked(x, z)) return false;
  for (const b of layout.bridges) {
    const p = segmentPoint(b.ax, b.az, b.bx, b.bz, x, z);
    if (p.distance <= b.width / 2 - 0.35) return true;
    if (p.distance <= b.width / 2 && p.t > 0.08 && p.t < 0.92 && arenaBathymetry(x, z) <= ARENA_WATER_Y) {
      return false;
    }
  }
  for (const d of layout.docks) {
    const p = segmentPoint(d.ax, d.az, d.bx, d.bz, x, z);
    if (p.distance <= d.width / 2 - 0.28) return true;
    if (p.distance <= d.width / 2 && p.t > 0.14 && arenaBathymetry(x, z) <= ARENA_WATER_Y) {
      return false;
    }
  }
  const h = arenaBathymetry(x, z);
  if (h <= ARENA_WATER_Y) return false;
  // Exclude steep rocky coastal cliff faces (> ~38 deg gradient) from dry walkable land
  const eps = 0.25;
  const gx = (arenaBathymetry(x + eps, z) - arenaBathymetry(x - eps, z)) / (2 * eps);
  const gz = (arenaBathymetry(x, z + eps) - arenaBathymetry(x, z - eps)) / (2 * eps);
  return Math.hypot(gx, gz) <= 0.78;
}

/**
 * Authoritative player passability across dry islands, bridges, piers, beach wading, and swimmable ocean waters.
 * Enforces obstacle clearances, bridge/pier edge rails, step-up height (`feet + 0.105`), and outer world limit.
 */
export function arenaWalkable(x: number, z: number, feet = arenaSupportY(x, z)): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(feet)) return false;
  if (Math.hypot(x, z) > ARENA_PLAYER_LIMIT) return false;
  const fl = arenaFloor(x, z);
  if (fl > feet + 0.105) return false;
  if (solidBlocked(x, z)) return false;

  for (const b of layout.bridges) {
    const p = segmentPoint(b.ax, b.az, b.bx, b.bz, x, z);
    if (p.distance <= b.width / 2 - 0.35) return true;
    if (p.distance <= b.width / 2 && p.t > 0.08 && p.t < 0.92 && arenaBathymetry(x, z) <= ARENA_WATER_Y) {
      return false;
    }
  }
  for (const d of layout.docks) {
    const p = segmentPoint(d.ax, d.az, d.bx, d.bz, x, z);
    if (p.distance <= d.width / 2 - 0.28 || (p.distance <= d.width / 2 && p.t >= 0.9)) return true;
    if (p.distance <= d.width / 2 && p.t > 0.14 && arenaBathymetry(x, z) <= ARENA_WATER_Y) {
      return false;
    }
  }

  if (fl < ARENA_WATER_Y - 0.85) return true;

  // On dry land or shallow wading: block standing on vertical cliff walls unless airborne
  const eps = 0.25;
  const gx = (arenaBathymetry(x + eps, z) - arenaBathymetry(x - eps, z)) / (2 * eps);
  const gz = (arenaBathymetry(x, z + eps) - arenaBathymetry(x, z - eps)) / (2 * eps);
  if (Math.hypot(gx, gz) > 0.78 && feet <= fl + 0.08) return false;
  return true;
}

export const arenaPassable = arenaWalkable;

function canStepSub(
  x: number,
  z: number,
  tx: number,
  tz: number,
  initialFeet: number,
  airborne: boolean,
): boolean {
  const curSupport = arenaSupportY(x, z);
  const stepFeet = airborne ? Math.max(initialFeet, curSupport) : curSupport;
  if (!arenaWalkable(tx, tz, stepFeet)) return false;
  // Prevent accidentally walking off high coastal cliffs (> 1.6 m above water / steep cliff face) unless jumping!
  if (!airborne && !arenaOnWood(x, z) && !arenaOnWood(tx, tz)) {
    const h0 = arenaBathymetry(x, z);
    const h1 = arenaBathymetry(tx, tz);
    const stepDist = Math.max(1e-4, Math.hypot(tx - x, tz - z));
    if (h1 > ARENA_WATER_Y - 0.85) {
      const eps = 0.25;
      const gx = (arenaBathymetry(tx + eps, tz) - arenaBathymetry(tx - eps, tz)) / (2 * eps);
      const gz = (arenaBathymetry(tx, tz + eps) - arenaBathymetry(tx, tz - eps)) / (2 * eps);
      if (Math.hypot(gx, gz) > 0.78) return false;
    }
    if (h0 > ARENA_WATER_Y + 0.25 && (h0 - h1) / stepDist > 0.72) {
      return false;
    }
  }
  return true;
}

/**
 * Swept sub-stepped player motion (<= 0.16 m per sub-step):
 * climbs gentle < 32 deg mountain trails, transitions seamlessly across sandy beaches into swimming and back,
 * slides smoothly along planters/rails/cliffs, and prevents walking off high cliffs unless jumping.
 */
export function arenaStep(
  x: number,
  z: number,
  nx: number,
  nz: number,
  feet = arenaSupportY(x, z),
): { x: number; z: number } {
  const airborne = feet > arenaSupportY(x, z) + 0.08;
  const n = Math.max(1, Math.ceil(Math.hypot(nx - x, nz - z) / 0.16));
  const dx = (nx - x) / n;
  const dz = (nz - z) / n;
  for (let j = 0; j < n; j++) {
    if (canStepSub(x, z, x + dx, z + dz, feet, airborne)) {
      x += dx;
      z += dz;
    } else if (canStepSub(x, z, x + dx, z, feet, airborne)) {
      x += dx;
    } else if (canStepSub(x, z, x, z + dz, feet, airborne)) {
      z += dz;
    }
  }
  return { x, z };
}

/**
 * Safe pier deck climb-out point for a swimmer within 2.2 m of any dock's outer/step section (t in [0.55, 1.0]).
 * Identical logic in ArenaGeometry.climbOutPoint.
 */
export function arenaClimbOutPoint(x: number, z: number): { x: number; z: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  if (arenaOnWood(x, z) || arenaFloor(x, z) >= ARENA_WATER_Y - 0.25) return null;
  let best: { x: number; z: number; y: number; dist: number } | null = null;
  for (const d of layout.docks) {
    const p = segmentPoint(d.ax, d.az, d.bx, d.bz, x, z);
    if (p.t < 0.55) continue;
    const edgeDist = Math.max(0, p.distance - d.width / 2);
    if (edgeDist > 2.2 || (best && edgeDist >= best.dist)) continue;
    const dx = d.bx - d.ax;
    const dz = d.bz - d.az;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const nx = -uz;
    const nz = ux;
    const along = (x - d.ax) * ux + (z - d.az) * uz;
    const across = (x - d.ax) * nx + (z - d.az) * nz;
    const landAlong = Math.max(0.58 * len, Math.min(len - 0.35, along));
    const inset = Math.max(0.2, d.width / 2 - 0.42);
    const landAcross = Math.max(-inset, Math.min(inset, across));
    const lx = d.ax + ux * landAlong + nx * landAcross;
    const lz = d.az + uz * landAlong + nz * landAcross;
    if (!arenaDryWalkable(lx, lz)) continue;
    best = { x: lx, z: lz, y: arenaFloor(lx, lz), dist: edgeDist };
  }
  return best ? { x: best.x, z: best.z, y: best.y } : null;
}

/** Containing island ID when on/near an island, or the nearest island ID by shoreline distance across the archipelago. */
export function arenaIslandAt(x: number, z: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 'commons';
  let bestId = 'commons';
  let bestShoreGap = Infinity;
  for (const i of layout.islands as readonly Island[]) {
    const dx = x - i.x;
    const dz = z - i.z;
    const d = Math.hypot(dx, dz);
    const shoreGap = d - arenaShoreRadius(i, Math.atan2(dz, dx));
    if (shoreGap < bestShoreGap) {
      bestShoreGap = shoreGap;
      bestId = i.id;
    }
  }
  return bestId;
}

/** Returns the island ID only if `(x, z)` lies within the island's shoreline or 18 m coastal littoral band, else null. */
export function arenaContainingIsland(x: number, z: number): string | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  let bestId: string | null = null;
  let bestGap = 18;
  for (const i of layout.islands as readonly Island[]) {
    const dx = x - i.x;
    const dz = z - i.z;
    const gap = Math.hypot(dx, dz) - arenaShoreRadius(i, Math.atan2(dz, dx));
    if (gap <= bestGap) {
      bestGap = gap;
      bestId = i.id;
    }
  }
  return bestId;
}

/**
 * Whether the whole hull fits at this pose: every hull circle clear of coastline, shore rocks, dock decks,
 * bridge spans, and ARENA_BOAT_LIMIT. Identical check on the Java server.
 */
export function arenaBoatClear(x: number, z: number, yaw: number, hull = ARENA_HULL): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return false;
  if (Math.hypot(x, z) > ARENA_BOAT_LIMIT) return false;
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  for (const [along, r] of hull) {
    const cx = x + s * along;
    const cz = z + c * along;
    for (const i of layout.islands as readonly Island[]) {
      const dx = cx - i.x;
      const dz = cz - i.z;
      const maxCoast = i.radius * (1 + (i.lobe3 ?? 0) + (i.lobe5 ?? 0)) + i.shore + 2 + r;
      if (Math.abs(dx) > maxCoast || Math.abs(dz) > maxCoast) continue;
      const d = Math.hypot(dx, dz);
      if (d > maxCoast) continue;
      if (d < arenaShoreRadius(i, Math.atan2(dz, dx)) + r + 0.08) return false;
    }
    for (const k of layout.rocks) {
      const dx = cx - k.x;
      const dz = cz - k.z;
      const reach = k.r + r;
      if (Math.abs(dx) < reach && Math.abs(dz) < reach && dx * dx + dz * dz < reach * reach) return false;
    }
    for (const d of layout.docks) {
      if (segmentPoint(d.ax, d.az, d.bx, d.bz, cx, cz).distance < d.width / 2 + r + 0.06) return false;
    }
    for (const b of layout.bridges) {
      if (segmentPoint(b.ax, b.az, b.bx, b.bz, cx, cz).distance < b.width / 2 + r + 0.25) return false;
    }
  }
  return true;
}

export function arenaHullsOverlap(
  x: number,
  z: number,
  yaw: number,
  bx: number,
  bz: number,
  byaw: number,
  first = ARENA_HULL,
  second = ARENA_HULL,
): boolean {
  if (Math.abs(x - bx) > 10.5 || Math.abs(z - bz) > 10.5) return false;
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const t = Math.sin(byaw);
  const u = Math.cos(byaw);
  for (const [aAlong, aR] of first) {
    for (const [bAlong, bR] of second) {
      const dx = x + s * aAlong - bx - t * bAlong;
      const dz = z + c * aAlong - bz - u * bAlong;
      const reach = aR + bR;
      if (dx * dx + dz * dz < reach * reach) return true;
    }
  }
  return false;
}

/** @deprecated The hull decides, not a point: kept for callers that only know a position. */
export function arenaBoatNavigable(x: number, z: number): boolean {
  return arenaBoatClear(x, z, 0) || arenaBoatClear(x, z, Math.PI / 2);
}

/** Keep solid planters, tree trunks, and landmark bases between the learner and a nearby action target opaque. */
export function arenaInReach(x: number, z: number, tx: number, tz: number) {
  return !layout.obstacles.some(o => {
    if (Math.hypot(o.x - tx, o.z - tz) < 1e-4) return false;
    if (Math.abs(o.x - x) > 7 || Math.abs(o.z - z) > 7) return false;
    return segmentPoint(x, z, tx, tz, o.x, o.z).distance < o.radius;
  });
}

const SLIDE = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI * 0.45, -Math.PI * 0.45];

/**
 * Swept hull motion: cut into pieces <= 0.12 m so nothing thin is crossed between ticks.
 * A blocked piece slides along the obstacle, never through it.
 */
export function arenaBoatStep(
  x: number,
  z: number,
  yaw: number,
  nx: number,
  nz: number,
  clear: (x: number, z: number, yaw: number) => boolean = arenaBoatClear,
): { x: number; z: number; blocked: boolean } {
  const length = Math.hypot(nx - x, nz - z);
  const n = Math.max(1, Math.ceil(length / 0.12));
  const dx = (nx - x) / n;
  const dz = (nz - z) / n;
  if (!clear(x, z, yaw)) return { x: nx, z: nz, blocked: false };
  let blocked = false;
  for (let j = 0; j < n; j++) {
    let moved = false;
    for (const a of SLIDE) {
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const sx = (dx * cos - dz * sin) * cos;
      const sz = (dx * sin + dz * cos) * cos;
      if (clear(x + sx, z + sz, yaw)) {
        x += sx;
        z += sz;
        moved = true;
        if (a !== 0) blocked = true;
        break;
      }
    }
    if (!moved) {
      blocked = true;
      break;
    }
  }
  return { x, z, blocked };
}

/** Wedged: the hull can neither go ahead, back nor sideways, nor turn a little. */
export function arenaBoatWedged(
  x: number,
  z: number,
  yaw: number,
  clear: (x: number, z: number, yaw: number) => boolean = arenaBoatClear,
): boolean {
  const s = Math.sin(yaw) * 0.15;
  const c = Math.cos(yaw) * 0.15;
  return (
    !clear(x + s, z + c, yaw) &&
    !clear(x - s, z - c, yaw) &&
    !clear(x + c, z - s, yaw) &&
    !clear(x - c, z + s, yaw) &&
    !clear(x, z, yaw + 0.1) &&
    !clear(x, z, yaw - 0.1)
  );
}

/** Nearest clear pose within four metres for a wedged hull, else null. */
export function arenaBoatRescue(
  x: number,
  z: number,
  yaw: number,
  clear: (x: number, z: number, yaw: number) => boolean = arenaBoatClear,
): { x: number; z: number; yaw: number } | null {
  for (let r = 0.25; r <= 4 + 1e-9; r += 0.25) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      for (const turn of [0, 0.3, -0.3, 0.6, -0.6]) {
        if (clear(px, pz, yaw + turn)) return { x: px, z: pz, yaw: yaw + turn };
      }
    }
  }
  return null;
}

/** Maximum hull-edge distance (m) for boarding any vessel from pier, beach, wading surf, or open-water swim. */
export const ARENA_BOARD_HULL_GAP = 3.05;
/** Coarse vessel-centre radius cap (m) paired with `ARENA_BOARD_HULL_GAP` (`8.5 m` cruiser bow + stride). */
export const ARENA_BOARD_MAX_CENTER_DIST = 8.2;

export interface ArenaOverboardLanding {
  x: number;
  z: number;
  y: number;
  gunwaleX: number;
  gunwaleZ: number;
  gunwaleY: number;
  outboardX: number;
  outboardZ: number;
  hullGap: number;
}

/** Distance from the nearest hull circle's edge to `(px, pz)`. */
export function arenaHullGap(
  x: number,
  z: number,
  yaw: number,
  px: number,
  pz: number,
  hull = ARENA_HULL,
): number {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  let gap = Infinity;
  for (const [along, r] of hull) {
    gap = Math.min(gap, Math.hypot(px - x - s * along, pz - z - c * along) - r);
  }
  return gap;
}

/**
 * Unified hull-edge boarding reach check across piers, beaches, shallow wading shores, and open-water swimming.
 * Mirrors `ArenaGeometry.canBoardBoat` on the Java server.
 */
export function arenaCanBoardBoat(
  boatX: number,
  boatZ: number,
  boatYaw: number,
  px: number,
  pz: number,
  hull = ARENA_HULL,
  maxHullGap = ARENA_BOARD_HULL_GAP,
): boolean {
  if (!Number.isFinite(boatX) || !Number.isFinite(boatZ) || !Number.isFinite(boatYaw)) return false;
  if (!Number.isFinite(px) || !Number.isFinite(pz)) return false;
  if (Math.hypot(px - boatX, pz - boatZ) > ARENA_BOARD_MAX_CENTER_DIST) return false;
  if (arenaHullGap(boatX, boatZ, boatYaw, px, pz, hull) > maxHullGap) return false;
  return arenaInReach(px, pz, boatX, boatZ);
}

/**
 * Safe outboard water entry point (`hullGap >= 0.55 m`) for jumping off a stationary or moving boat anywhere (`B01`).
 * Evaluates port/starboard beam and quarter rays around the occupant's longitudinal station, preferring `swimmable`
 * water first and gentle waist-deep coastal water (`>= 0.42 m`) second while strictly avoiding piers, rocks, and cliffs.
 * Mirrors `ArenaGeometry.overboardPoint` 1:1 on the Java server.
 */
export function arenaOverboardPoint(
  boatX: number,
  boatZ: number,
  boatYaw: number,
  hull = ARENA_HULL,
  role: string | null = 'ROWER',
  preferSide = 0,
): ArenaOverboardLanding | null {
  if (!Number.isFinite(boatX) || !Number.isFinite(boatZ) || !Number.isFinite(boatYaw)) return null;
  let minAlong = 0;
  let maxAlong = 0;
  for (const [along] of hull) {
    if (along < minAlong) minAlong = along;
    if (along > maxAlong) maxAlong = along;
  }
  const baseStation = role === 'PASSENGER' ? 0.9 : -0.25;
  const stationZ = Math.max(minAlong * 0.72, Math.min(maxAlong * 0.72, baseStation));
  const fx = Math.sin(boatYaw);
  const fz = Math.cos(boatYaw);
  const rx = -Math.cos(boatYaw);
  const rz = Math.sin(boatYaw);
  const sides = preferSide < -0.05 ? [-1, 1] : [1, -1];
  const angleOffsets = [0, -0.28, 0.28, -0.58, 0.58];
  const alongShifts = [0, -0.6, 0.6];
  const clearances = [0.68, 1.05, 1.48];

  for (const strictSwim of [true, false]) {
    for (const targetClear of clearances) {
      for (const dAlong of alongShifts) {
        const along = Math.max(minAlong * 0.85, Math.min(maxAlong * 0.85, stationZ + dAlong));
        const sx = boatX + fx * along;
        const sz = boatZ + fz * along;
        for (const side of sides) {
          for (const aOff of angleOffsets) {
            const ca = Math.cos(aOff);
            const sa = Math.sin(aOff);
            const bx = side * rx;
            const bz = side * rz;
            const ux = bx * ca + fx * sa;
            const uz = bz * ca + fz * sa;
            const hit = traceOverboardRay(boatX, boatZ, boatYaw, hull, sx, sz, ux, uz, targetClear, strictSwim);
            if (hit) return hit;
          }
        }
      }
      // Stern and bow escape fallback when both beams are flanked by pier pilings or rocks
      for (const endSign of [-1, 1]) {
        const along = endSign < 0 ? minAlong : maxAlong;
        const sx = boatX + fx * along;
        const sz = boatZ + fz * along;
        const hit = traceOverboardRay(
          boatX,
          boatZ,
          boatYaw,
          hull,
          sx,
          sz,
          endSign * fx,
          endSign * fz,
          targetClear,
          strictSwim,
        );
        if (hit) return hit;
      }
    }
  }
  return null;
}

function traceOverboardRay(
  boatX: number,
  boatZ: number,
  boatYaw: number,
  hull: typeof ARENA_HULL,
  sx: number,
  sz: number,
  ux: number,
  uz: number,
  targetClear: number,
  strictSwim: boolean,
): ArenaOverboardLanding | null {
  let gx = sx;
  let gz = sz;
  for (let d = 0.25; d <= 6.4; d += 0.15) {
    const px = sx + ux * d;
    const pz = sz + uz * d;
    const gap = arenaHullGap(boatX, boatZ, boatYaw, px, pz, hull);
    if (gap <= 0.06) {
      gx = px;
      gz = pz;
      continue;
    }
    if (gap < targetClear) continue;
    if (Math.hypot(px, pz) > ARENA_PLAYER_LIMIT - 0.5) return null;
    if (arenaOnWood(px, pz) || solidBlocked(px, pz)) return null;
    const validWater = strictSwim
      ? arenaSwimmable(px, pz)
      : arenaWalkable(px, pz) && arenaWaterDepth(px, pz) >= 0.42;
    if (!validWater) return null;
    return {
      x: px,
      z: pz,
      y: arenaSupportY(px, pz),
      gunwaleX: gx,
      gunwaleZ: gz,
      gunwaleY: GUNWALE_Y,
      outboardX: ux,
      outboardZ: uz,
      hullGap: gap,
    };
  }
  return null;
}

/**
 * Two-pass authoritative boat disembarkation point (`B02`, `B04`) — strictly identical to `ArenaGeometry.disembarkPoint`:
 * - Pass 1 (Piers): Walkable pier plank within a stride (`1.6 m`) of the hull and `<= 0.9 m` above the gunwale.
 * - Pass 2 (Beaches and Dockless Islands): Accessible dry sandy beach / gentle cove rim (`<= 2.25 m` hull gap) or
 *   gentle knee-deep wading shoreline (`<= 0.62 m` water depth with verified `arenaStep` walk-in onto dry island land),
 *   while strictly returning `null` on steep cliffs, shore rocks, and open ocean.
 */
export function arenaDisembarkPoint(
  boatX: number,
  boatZ: number,
  boatYaw: number,
  hull = ARENA_HULL,
): { x: number; z: number; y: number } | null {
  if (!Number.isFinite(boatX) || !Number.isFinite(boatZ) || !Number.isFinite(boatYaw)) return null;
  let best: { x: number; z: number; y: number; gap: number } | null = null;
  for (const d of layout.docks) {
    const dx = d.bx - d.ax;
    const dz = d.bz - d.az;
    const len = Math.hypot(dx, dz) || 1;
    if (segmentPoint(d.ax, d.az, d.bx, d.bz, boatX, boatZ).distance > d.width / 2 + 5.2) continue;
    const nx = -dz / len;
    const nz = dx / len;
    for (let s = 4; s <= 24; s++) {
      const t = s / 24;
      const edge = d.width / 2 - 0.32;
      for (const side of [0, -0.6, 0.6, -edge, edge]) {
        const px = d.ax + dx * t + nx * side;
        const pz = d.az + dz * t + nz * side;
        const gap = arenaHullGap(boatX, boatZ, boatYaw, px, pz, hull);
        if (gap > 1.6 || (best && gap >= best.gap)) continue;
        const y = arenaFloor(px, pz);
        if (y - GUNWALE_Y > 0.9 || !arenaDryWalkable(px, pz)) continue;
        best = { x: px, z: pz, y, gap };
      }
    }
  }
  if (best) return { x: best.x, z: best.z, y: best.y };

  let maxHullExtent = 2.02;
  for (const [along, r] of hull) {
    maxHullExtent = Math.max(maxHullExtent, Math.abs(along) + r);
  }

  let bestDry = null as { x: number; z: number; y: number; gap: number } | null;
  let bestWade = null as { x: number; z: number; y: number; gap: number } | null;
  const dryRadialOffsets = [-0.15, -0.45, -0.8, -1.15, -1.5, -1.85, -2.2, -2.55];
  const wadeRadialOffsets = [0.35, 0.05, -0.25];

  for (const isl of layout.islands as readonly Island[]) {
    const dxB = boatX - isl.x;
    const dzB = boatZ - isl.z;
    const distB = Math.hypot(dxB, dzB);
    if (distB > isl.radius * 1.25 + isl.shore + maxHullExtent + 4.0) continue;
    const boatBearing = Math.atan2(dzB, dxB);
    const shoreAtBoat = arenaShoreRadius(isl, boatBearing);
    if (distB - shoreAtBoat > maxHullExtent + 2.85) continue;

    const isIslet = isl.profile === 'islet';
    const maxStepUp = isIslet ? 1.75 : 1.18;
    const maxDryGap = isIslet ? 2.95 : 2.25;
    for (let k = -7; k <= 7; k++) {
      const a = boatBearing + k * 0.055;
      const sr = arenaShoreRadius(isl, a);
      const ux = Math.cos(a);
      const uz = Math.sin(a);
      const wx = isl.x + ux * (sr + 0.35);
      const wz = isl.z + uz * (sr + 0.35);
      const inR = Math.max(1.5, sr - 2.6);
      const inX = isl.x + ux * inR;
      const inZ = isl.z + uz * inR;
      for (const rOff of dryRadialOffsets) {
        const px = isl.x + ux * (sr + rOff);
        const pz = isl.z + uz * (sr + rOff);
        const gap = arenaHullGap(boatX, boatZ, boatYaw, px, pz, hull);
        if (gap < -0.05 || gap > maxDryGap || (bestDry && gap >= bestDry.gap)) continue;
        if (!arenaDryWalkable(px, pz)) continue;
        const y = arenaFloor(px, pz);
        if (y - GUNWALE_Y > maxStepUp) continue;
        if (isIslet) {
          if (!arenaDryWalkable(inX, inZ)) continue;
          const stIn = arenaStep(px, pz, inX, inZ);
          if (Math.hypot(stIn.x - inX, stIn.z - inZ) > 0.22 || !arenaInReach(boatX, boatZ, px, pz)) continue;
        } else {
          const st = arenaStep(wx, wz, px, pz);
          if (Math.hypot(st.x - px, st.z - pz) > 0.22 || !arenaInReach(wx, wz, px, pz)) continue;
        }
        bestDry = { x: px, z: pz, y, gap };
      }
    }

    if (!bestDry) {
      for (let k = -6; k <= 6; k++) {
        const a = boatBearing + k * 0.06;
        const sr = arenaShoreRadius(isl, a);
        const ux = Math.cos(a);
        const uz = Math.sin(a);
        const inR = Math.max(2.0, sr - 2.4);
        const ix = isl.x + ux * inR;
        const iz = isl.z + uz * inR;
        if (!arenaDryWalkable(ix, iz)) continue;
        for (const rOff of wadeRadialOffsets) {
          const px = isl.x + ux * (sr + rOff);
          const pz = isl.z + uz * (sr + rOff);
          const gap = arenaHullGap(boatX, boatZ, boatYaw, px, pz, hull);
          if (gap < 0.25 || gap > 1.85 || (bestWade && gap >= bestWade.gap)) continue;
          if (arenaOnWood(px, pz) || arenaWaterDepth(px, pz) > 0.62 || !arenaWalkable(px, pz)) continue;
          const st = arenaStep(px, pz, ix, iz);
          if (Math.hypot(st.x - ix, st.z - iz) > 0.25 || !arenaInReach(px, pz, ix, iz)) continue;
          bestWade = { x: px, z: pz, y: arenaSupportY(px, pz), gap };
        }
      }
    }
  }

  if (bestDry) return { x: bestDry.x, z: bestDry.z, y: bestDry.y };
  return bestWade ? { x: bestWade.x, z: bestWade.z, y: bestWade.y } : null;
}

/** The nearest dock to a boat, for telling a rower where to land. */
export function arenaNearestDock(
  x: number,
  z: number,
): { id: string; island: string; distance: number; x: number; z: number } | null {
  let best: { id: string; island: string; distance: number; x: number; z: number } | null = null;
  for (const d of layout.docks) {
    const p = segmentPoint(d.ax, d.az, d.bx, d.bz, x, z);
    const tx = d.ax + (d.bx - d.ax) * Math.max(0.6, p.t);
    const tz = d.az + (d.bz - d.az) * Math.max(0.6, p.t);
    const distance = Math.hypot(tx - x, tz - z);
    if (!best || distance < best.distance) {
      best = { id: d.id, island: d.island, distance, x: tx, z: tz };
    }
  }
  return best;
}
