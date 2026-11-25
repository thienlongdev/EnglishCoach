/* Echo Living Planet — where each learning region lives on the planet.
   Geography is presentation only: a site's place, biome and landmark NEVER imply proficiency, completion or order.
   The relative arrangement follows the authored catalog coordinates (OdysseyCatalog x/z: west→east, north→south) so
   that catalog neighbours stay neighbours; the spacing is art-directed so every region has room for its own landscape. */

export const PLANET_RADIUS = 100;
export const PLANET_SEED = 20261114;

export type Biome =
  | 'meadow' | 'blossom' | 'forest' | 'cliffs' | 'tropical' | 'coastal' | 'autumn' | 'ink'
  | 'archipelago' | 'port' | 'savanna' | 'alpine' | 'polar' | 'sanctuary' | 'volcanic';

export type Landmark =
  | 'lighthouse' | 'pavilion' | 'worldtree' | 'tidetower' | 'atoll' | 'amphitheatre' | 'library' | 'scriptorium'
  | 'bridges' | 'port' | 'windmills' | 'citadel' | 'observatory' | 'stonecircle' | 'gateway';

export interface Site {
  id: string;
  lat: number; lon: number;          // degrees
  biome: Biome;
  landmark: Landmark;
  radius: number;                    // land radius, degrees
  pad: number;                       // plateau height above sea level (world units)
  heading: number;                   // preferred camera heading in degrees (0 = looking north)
  islands?: boolean;                 // made of islets instead of one land mass
  bay?: { bearing: number; dist: number; radius: number }; // a water body next to the landmark (degrees)
  roof?: string[];                   // village roof colours (sRGB)
  village?: number;                  // houses around the landmark
}

/** Fifteen authored sites (ids = OdysseyCatalog.REGIONS). */
export const SITES: Site[] = [
  { id: 'harbor', lat: -22, lon: -30, biome: 'meadow', landmark: 'lighthouse', radius: 13, pad: 1.1, heading: 20,
    bay: { bearing: 160, dist: 6.4, radius: 3.0 }, roof: ['#2f7f9a', '#3c93a8', '#d9734a', '#f2efe6'], village: 34 },
  { id: 'memory', lat: -8, lon: -88, biome: 'blossom', landmark: 'pavilion', radius: 13, pad: 2.6, heading: -10, roof: ['#c44d6b', '#e0899f', '#7b4a7a'], village: 10 },
  { id: 'grove', lat: -6, lon: -56, biome: 'forest', landmark: 'worldtree', radius: 15, pad: 3.0, heading: 0 },
  { id: 'tides', lat: 21, lon: -40, biome: 'cliffs', landmark: 'tidetower', radius: 11, pad: 5.2, heading: 30,
    bay: { bearing: 200, dist: 6.2, radius: 2.6 } },
  { id: 'reef', lat: 8, lon: 12, biome: 'tropical', landmark: 'atoll', radius: 10, pad: 0.9, heading: -20, islands: true },
  { id: 'voices', lat: -30, lon: 5, biome: 'coastal', landmark: 'amphitheatre', radius: 11, pad: 1.2, heading: 0,
    bay: { bearing: 180, dist: 6.0, radius: 3.0 }, roof: ['#d68b5c', '#efe1c7'], village: 12 },
  { id: 'archive', lat: 16, lon: -80, biome: 'autumn', landmark: 'library', radius: 13, pad: 2.4, heading: 15 },
  { id: 'lagoon', lat: -45, lon: 33, biome: 'ink', landmark: 'scriptorium', radius: 10, pad: 1.4, heading: -25,
    bay: { bearing: 90, dist: 6.0, radius: 3.2 } },
  { id: 'bridges', lat: 43, lon: -18, biome: 'archipelago', landmark: 'bridges', radius: 11, pad: 1.6, heading: 10, islands: true },
  { id: 'communication', lat: -17, lon: 44, biome: 'port', landmark: 'port', radius: 12, pad: 1.4, heading: 10,
    bay: { bearing: 230, dist: 6.2, radius: 3.0 }, roof: ['#c8613e', '#d97a4a', '#b5512f', '#e9a15f'], village: 46 },
  { id: 'trade', lat: 12, lon: 66, biome: 'savanna', landmark: 'windmills', radius: 13, pad: 2.0, heading: -15,
    roof: ['#c99a3b', '#a8692e', '#e1b860'], village: 26 },
  { id: 'summit', lat: 45, lon: 30, biome: 'alpine', landmark: 'citadel', radius: 13, pad: 7.4, heading: 0, roof: ['#3d5d8f', '#4a6ea6'], village: 8 },
  { id: 'aurora', lat: 72, lon: -24, biome: 'polar', landmark: 'observatory', radius: 14, pad: 4.0, heading: 0 },
  { id: 'review', lat: 40, lon: -92, biome: 'sanctuary', landmark: 'stonecircle', radius: 11, pad: 1.8, heading: 0,
    bay: { bearing: 140, dist: 6.0, radius: 2.8 } },
  { id: 'trial', lat: 33, lon: 82, biome: 'volcanic', landmark: 'gateway', radius: 12, pad: 2.6, heading: -20 },
];

/** Land bridges that make one continuous world (art-directed, never a prerequisite claim). */
export const CONNECTIONS: [string, string, number][] = [
  ['harbor', 'grove', 6], ['grove', 'memory', 6], ['grove', 'tides', 5], ['tides', 'archive', 5], ['memory', 'archive', 5],
  ['harbor', 'voices', 4.5], ['voices', 'lagoon', 3.5], ['lagoon', 'communication', 4], ['communication', 'trade', 4.5],
  ['trade', 'summit', 4.5], ['summit', 'trial', 4.5], ['archive', 'review', 4],
];

export const BY_ID = new Map(SITES.map(s => [s.id, s]));
const RAD = Math.PI / 180;

export function dirFromLatLon(lat: number, lon: number): [number, number, number] {
  const la = lat * RAD, lo = lon * RAD;
  return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
}

/** Local tangent frame: up = radial, east, north (north = towards +Y projected; world Z near the poles). */
export function frameAt(d: [number, number, number]) {
  const [x, y, z] = d;
  let ex = z, ey = 0, ez = -x; // cross((0,1,0), d)
  let len = Math.hypot(ex, ey, ez);
  if (len < 1e-4) { ex = 1; ey = 0; ez = 0; len = 1; }
  ex /= len; ey /= len; ez /= len;
  const nx = y * ez - z * ey, ny = z * ex - x * ez, nz = x * ey - y * ex; // cross(up, east)
  return { up: d, east: [ex, ey, ez] as [number, number, number], north: [nx, ny, nz] as [number, number, number] };
}

/** A point at an angular offset (degrees east / north) from a site, on the unit sphere. */
export function offsetDir(d: [number, number, number], east: number, north: number): [number, number, number] {
  const f = frameAt(d), a = east * RAD, b = north * RAD;
  const x = d[0] + f.east[0] * a + f.north[0] * b, y = d[1] + f.east[1] * a + f.north[1] * b, z = d[2] + f.east[2] * a + f.north[2] * b;
  const l = Math.hypot(x, y, z); return [x / l, y / l, z / l];
}

export function bearingOffset(d: [number, number, number], bearing: number, dist: number) {
  const b = bearing * RAD; return offsetDir(d, Math.sin(b) * dist, Math.cos(b) * dist);
}

/** Any region the catalog may add later still gets a place, derived from its catalog coordinates. */
export function siteFor(region: { id: string; x: number; z: number }): Site {
  const known = BY_ID.get(region.id);
  if (known) return known;
  return { id: region.id, lat: Math.max(-60, Math.min(60, -(region.z + 14) * 1.15)), lon: (region.x + 5) * 2, biome: 'meadow',
    landmark: 'stonecircle', radius: 9, pad: 1.4, heading: 0 };
}

export const siteDir = (s: Site) => dirFromLatLon(s.lat, s.lon);
export const angleBetween = (a: [number, number, number], b: [number, number, number]) =>
  Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
