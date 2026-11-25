/**
 * The one table of canonical module addresses (rules: docs/grammar/ROUTING.md). Plain data, no imports: the proxy, the sidebar and every
 * screen rule read it. Five modules are views of one mounted layout (`app/(workspace)`), so switching between them stays a
 * native history change with no server round trip. `/?tab=x` is the old address of those views: it keeps working forever.
 */
export const ROOT_MODULES = ['dashboard', 'flashcards', 'reading', 'writing', 'leaderboard'] as const;
export type RootModule = (typeof ROOT_MODULES)[number];

const ROOT = new Set<string>(ROOT_MODULES);
/** Old `?tab=` values that were never views of the root page. */
const LEGACY_ROUTES: Record<string, string> = { speaking: '/speaking', listening: '/listening', exams: '/exams', grammar: '/grammar' };

export const moduleHref = (id: string): string => (ROOT.has(id) ? `/${id}` : Object.hasOwn(LEGACY_ROUTES, id) ? LEGACY_ROUTES[id] : `/${id}`);

/** Which root module an address shows, by its canonical path. */
export function rootModuleOf(pathname: string): RootModule | null {
  const first = pathname.split('/')[1] ?? '';
  return pathname === `/${first}` && ROOT.has(first) ? (first as RootModule) : null;
}

export const isRootModuleHref = (href: string): boolean => rootModuleOf(href.split(/[?#]/)[0]) !== null;

/**
 * The older description of a screen (`/` + tab) for the rule tables written in those terms. Everything else passes through.
 * A rule table never has to know both addresses.
 */
export function legacyView(pathname: string, tab: string | null): { pathname: string; tab: string | null } {
  const module = rootModuleOf(pathname);
  return module ? { pathname: '/', tab: module } : { pathname, tab };
}

/** `/?tab=reading&materialId=4` becomes `/reading?materialId=4`. Anything that is not a legacy tab address is returned as it is. */
export function canonicalHref(href: string): string {
  if (!href.startsWith('/?')) return href;
  const hash = href.indexOf('#');
  const fragment = hash >= 0 ? href.slice(hash) : '';
  const params = new URLSearchParams(href.slice(2, hash >= 0 ? hash : undefined));
  const tab = params.get('tab');
  if (!tab || tab === 'landing') return href;
  if (!ROOT.has(tab) && !Object.hasOwn(LEGACY_ROUTES, tab)) return href;
  params.delete('tab');
  const query = params.toString();
  return `${moduleHref(tab)}${query ? `?${query}` : ''}${fragment}`;
}
