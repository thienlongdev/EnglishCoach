import type { RoomNavigation, NavPoint } from './navigation';

/** Swept, axis-sliding capsule footprint. Short substeps cannot tunnel across thin furniture. */
export function walkSlide(nav: Pick<RoomNavigation, 'free'>, start: NavPoint, dx: number, dz: number): NavPoint {
  const p = { ...start }, steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / .035));
  for (let i = 0; i < steps; i++) {
    const x = dx / steps, z = dz / steps;
    if (nav.free({ x: p.x + x, z: p.z + z })) { p.x += x; p.z += z; }
    else {
      if (nav.free({ x: p.x + x, z: p.z })) p.x += x;
      if (nav.free({ x: p.x, z: p.z + z })) p.z += z;
    }
  }
  return p;
}

export const WORLD_DESTINATIONS = { arena: '/speaking/arena', games: '/games' } as const;
export type WorldDestination = keyof typeof WORLD_DESTINATIONS;
/** An allowlisted deep link, without a second world or an arbitrary return redirect. */
export function worldDestination(to: WorldDestination, spaceId: string): string {
  return `${WORLD_DESTINATIONS[to]}?studyRoom=${encodeURIComponent(spaceId)}`;
}
export function studyReturn(search: URLSearchParams): string | null {
  const id = search.get('studyRoom');
  return id && /^[a-zA-Z0-9-]{1,64}$/.test(id) ? `/study-space?space=${encodeURIComponent(id)}` : null;
}

const ARRIVAL = 'ec_study_arrival:v1';
/** Tab-local, and only the door: coming back, the body comes in through the door it left by. */
export function markArrival(from: WorldDestination) { try { sessionStorage.setItem(ARRIVAL, JSON.stringify({ from, at: Date.now() })); } catch { /* it just arrives as before */ } }
export function takeArrival(): WorldDestination | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(ARRIVAL) || 'null') as { from?: string; at?: number } | null;
    sessionStorage.removeItem(ARRIVAL);
    return raw && (raw.from === 'arena' || raw.from === 'games') && typeof raw.at === 'number' && Date.now() - raw.at < 86400000 ? raw.from : null;
  } catch { return null; }
}
