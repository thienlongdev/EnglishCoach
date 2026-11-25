import type { LaunchView } from './types';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGION = /^[a-z][a-z-]{1,39}$/;
const STATION = /^(?:grammar:[a-z0-9][a-z0-9-]{0,79}|task:[1-9][0-9]{0,17}|workflow:[a-z][a-z-]{1,39})$/;
export function returnHref(region: string, station: string | null): string {
  const q = new URLSearchParams({ view: 'odyssey' });
  if (REGION.test(region)) q.set('region', region);
  if (station && STATION.test(station)) q.set('station', station);
  return `/learning-path?${q}`;
}
/** Only fixed, same-origin module routes. Never accept an arbitrary return URL. */
export function safeDestination(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//') || /[\\\r\n]/.test(href)) return false;
  const url = new URL(href, 'https://odyssey.invalid');
  return url.origin === 'https://odyssey.invalid' && /^\/(grammar|flashcards|listening|reading|speaking|writing|exams|learning-path)(\/|$)/.test(url.pathname);
}
export function launchHref(view: LaunchView): string | null {
  if (!safeDestination(view.href) || !UUID.test(view.launch.requestId)) return null;
  const url = new URL(view.href, 'https://odyssey.invalid');
  url.searchParams.set('odyssey', view.launch.requestId);
  return `${url.pathname}${url.search}${url.hash}`;
}
export const contextKey = (account: string) => `ec_odyssey_return:v1:${account}`;
export function contextId(account: string, path: string): string | null {
  if (!hasContext(account, path)) return null;
  try { return JSON.parse(sessionStorage.getItem(contextKey(account)) || 'null').id; } catch { return null; }
}
export function contextLight(account: string): boolean { try { return JSON.parse(sessionStorage.getItem(contextKey(account)) || 'null')?.light === true; } catch { return false; } }
export function saveContext(account: string, view: LaunchView, lightweight?: boolean, lockedStations?: string[]) {
  if (!account || !launchHref(view)) return;
  try {
    const previous = JSON.parse(sessionStorage.getItem(contextKey(account)) || 'null');
    sessionStorage.setItem(contextKey(account), JSON.stringify({ id: view.launch.requestId, module: view.href.split(/[/?#]/)[1], at: Date.now(), light: lightweight ?? contextLight(account),
      lockedStations: lockedStations ?? (previous?.id === view.launch.requestId ? previous.lockedStations : undefined) }));
  } catch { /* navigation still works from the server record */ }
}
/** A presentation snapshot, never mastery. Compare only with a fresh server graph. */
export function takeGateSnapshot(account: string): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(contextKey(account)) || 'null');
    if (!v || Date.now() - v.at > 7 * 86400000 || !Array.isArray(v.lockedStations)) return [];
    const ids = v.lockedStations.filter((id: unknown): id is string => typeof id === 'string' && STATION.test(id));
    delete v.lockedStations; sessionStorage.setItem(contextKey(account), JSON.stringify(v));
    return ids;
  } catch { return []; }
}
export function hasContext(account: string, path: string): boolean {
  try {
    const v = JSON.parse(sessionStorage.getItem(contextKey(account)) || 'null');
    return !!v && UUID.test(v.id) && Date.now() - v.at < 7 * 86400000 && path.split('/')[1] === v.module;
  } catch { return false; }
}
export function clearContext(account: string) { try { sessionStorage.removeItem(contextKey(account)); } catch { /* no storage */ } }

const draftKey = (account: string) => `ec_odyssey_drafts:v1:${account}`;
/** UI pointers only; the Writing API still checks ownership and all completion evidence stays server-side. */
export function rememberWritingSession(account: string, stationId: string, sessionId: string) {
  if (!account || !/^task:[1-9][0-9]{0,17}$/.test(stationId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) return;
  try {
    const old = JSON.parse(sessionStorage.getItem(draftKey(account)) || '{}');
    const entries = Object.entries({ ...old, [stationId]: { sessionId, at: Date.now() } }) as [string, { sessionId: string; at: number }][];
    sessionStorage.setItem(draftKey(account), JSON.stringify(Object.fromEntries(entries.sort((a,b)=>b[1].at-a[1].at).slice(0,24))));
  } catch { /* saved drafts remain accessible in the Writing module */ }
}
export function withWritingResume(account: string, view: LaunchView): LaunchView {
  if (!view.href.startsWith('/writing?') || !safeDestination(view.href)) return view;
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey(account)) || '{}')[view.launch.stationId];
    if (!saved || !/^[a-zA-Z0-9_-]{1,64}$/.test(saved.sessionId) || Date.now()-saved.at>7*86400000) return view;
    return { ...view, href: `/writing?view=coach&sessionId=${encodeURIComponent(saved.sessionId)}` };
  } catch { return view; }
}
