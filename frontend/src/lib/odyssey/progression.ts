import type { RegionDetail, Station, World } from './types';

export type RouteState = 'recommended' | 'completed' | 'available' | 'locked' | 'review';
export type LearningRoute = { from: string; to: string; state: RouteState; kind: 'prerequisite' | 'parallel'; count: number };
export const passed = (s: Station) => s.status === 'CHECK_PASSED' || s.status === 'DONE';
export const ready = (s: Station) => s.gate.state === 'READY' || s.gate.state === 'NOT_REQUIRED';
export function recommendation(world: World) {
  return world.recommendations.find(s => !passed(s) && s.kind !== 'WORKFLOW') ?? null;
}
/** All academic states come from the existing owner-scoped Odyssey projection. */
export function learningRoutes(world: World, details: RegionDetail[]): LearningRoute[] {
  const topics = new Map(details.flatMap(d => d.stations.filter(s => s.kind === 'GRAMMAR').map(s => [s.id.slice(8), s] as const)));
  const recommended = recommendation(world)?.regionId;
  const edges = new Map<string, LearningRoute>();
  for (const dest of topics.values()) for (const slug of dest.prerequisites) {
    const from = topics.get(slug);
    if (!from || from.regionId === dest.regionId) continue;
    const key = `${from.regionId}:${dest.regionId}`;
    const state: RouteState = dest.status === 'REVIEW_DUE' || dest.status === 'REMEDIATION' ? 'review'
      : passed(dest) ? 'completed' : !ready(dest) ? 'locked' : dest.regionId === recommended ? 'recommended' : 'available';
    const previous = edges.get(key);
    // A regional edge is traversable if at least one destination branch is ready.
    const priority: RouteState[] = ['recommended', 'review', 'available', 'locked', 'completed'];
    const mixed = previous && (previous.state === 'completed' && state === 'locked' || previous.state === 'locked' && state === 'completed');
    edges.set(key, { from: from.regionId, to: dest.regionId, kind: 'prerequisite', count: (previous?.count ?? 0) + 1,
      state: mixed ? 'available' : previous && priority.indexOf(previous.state) < priority.indexOf(state) ? previous.state : state });
  }
  // Catalog neighbors explicitly describe parallel exploration, never prerequisites.
  for (const { region } of world.regions) for (const to of region.neighbors) {
    if (edges.has(`${region.id}:${to}`) || edges.has(`${to}:${region.id}`) || region.id > to) continue;
    edges.set(`${region.id}:${to}`, { from: region.id, to, count: 0, kind: 'parallel',
      state: to === recommended || region.id === recommended ? 'recommended' : 'available' });
  }
  return [...edges.values()];
}
export function chapters(stations: Station[]) {
  const groups = new Map<string, Station[]>();
  for (const s of stations) {
    const key = s.kind === 'GRAMMAR' ? s.domain || s.skill : s.kind === 'WORKFLOW' ? 'explore' : 'today';
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups].map(([id, items]) => {
    const bySlug = new Map(items.map(s => [s.id.replace('grammar:', ''), s]));
    const depths = new Map<string, number>();
    const depth = (s: Station, stack = new Set<string>()): number => {
      if (depths.has(s.id)) return depths.get(s.id)!;
      if (stack.has(s.id)) return 0;
      const next = new Set(stack).add(s.id);
      const parents = s.prerequisites.map(p => bySlug.get(p)).filter((v): v is Station => !!v);
      const n = parents.length ? 1 + Math.max(...parents.map(p => depth(p, next))) : 0;
      depths.set(s.id, n); return n;
    };
    items.forEach(s => depth(s));
    return { id, stations: items, depths, completed: items.filter(passed).length };
  });
}
