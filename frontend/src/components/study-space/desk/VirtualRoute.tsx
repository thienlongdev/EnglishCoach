'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathParamsContext, PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

/**
 * A real page of the product, running inside a window of the room. The page is the page: same component, same data, same rules. Only its idea of "where am I" is local to the
 * window, so opening a lesson or a tab moves the window and leaves the room, its address and its running scene exactly where they are. An address that has no page here goes out
 * to the real router, which is the plain way to that page.
 */
const loading = () => <div style={{ display: 'grid', placeItems: 'center', height: '100%', minHeight: 200, opacity: .7 }} role="status" aria-live="polite">…</div>;
const page = (load: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>) => dynamic(load, { ssr: false, loading });
/** A page with the route's own layout around it, the way the real router composes them. */
type Layout = React.ComponentType<{ children: React.ReactNode }>;
const inLayout = (layout: () => Promise<{ default: Layout }>, content: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>) => page(async () => {
  const [L, P] = await Promise.all([layout(), content()]);
  const Frame = L.default, Inner = P.default;
  return { default: (props: Record<string, unknown>) => <Frame><React.Suspense fallback={loading()}><Inner {...props} /></React.Suspense></Frame> };
});
const listeningLayout = () => import('@/app/listening/layout') as Promise<{ default: Layout }>;
const Listening = inLayout(listeningLayout, () => import('@/app/listening/page') as never);
const ListeningStats = inLayout(listeningLayout, () => import('@/app/listening/dashboard/page') as never);
const Lesson = inLayout(listeningLayout, () => import('@/components/features/listening/workspace/LessonWorkspace') as never);
const Writing = page(async () => ({ default: (await import('@/components/features/writing/WritingModule')).WritingModule as unknown as React.ComponentType<Record<string, unknown>> }));
const Path = page(() => import('@/app/learning-path/page') as never);
const Progress = page(() => import('@/app/progress/page') as never);
const Speaking = inLayout(() => import('@/app/speaking/layout') as Promise<{ default: Layout }>, () => import('@/app/speaking/page') as never);
const Grammar = inLayout(() => import('@/app/grammar/layout') as Promise<{ default: Layout }>, () => import('@/app/grammar/page') as never);
const Reading = page(async () => ({ default: (await import('@/components/features/reading/ReadingDashboard')).ReadingDashboard as unknown as React.ComponentType<Record<string, unknown>> }));
const Flashcards = page(async () => ({ default: (await import('@/components/features/flashcard/FlashcardUI')).FlashcardUI as unknown as React.ComponentType<Record<string, unknown>> }));
const Community = page(() => import('@/app/community/page') as never);

interface Match { Page: React.ComponentType<Record<string, unknown>>; params?: Record<string, string> }
export function matchPage(path: string): Match | null {
  const clean = path.replace(/\/+$/, '') || '/';
  if (clean === '/listening') return { Page: Listening };
  if (clean === '/listening/dashboard') return { Page: ListeningStats };
  const lesson = /^\/listening\/([^/]+)(?:\/practice)?$/.exec(clean);
  if (lesson) return { Page: Lesson, params: { id: lesson[1] } };
  if (clean === '/writing') return { Page: Writing };
  if (clean === '/learning-path') return { Page: Path };
  if (clean === '/progress') return { Page: Progress };
  if (clean === '/speaking') return { Page: Speaking };
  if (clean === '/grammar') return { Page: Grammar };
  if (clean === '/reading') return { Page: Reading };
  if (clean === '/flashcards') return { Page: Flashcards };
  if (clean === '/community') return { Page: Community };
  return null;
}

/**
 * The one window the native history calls of a page belong to. Some modules switch their views with history.pushState on purpose (10 §Z, §BN); in a window that must move the
 * window and not the room's address, which the real router would otherwise follow out of the room.
 */
let current: ((url: string, replace: boolean) => boolean) | null = null;
let installed = 0;
let realPush: History['pushState'] | null = null, realReplace: History['replaceState'] | null = null;
function installHistory() {
  if (installed++ > 0) return;
  realPush = history.pushState; realReplace = history.replaceState;
  history.pushState = function (state, unused, url) {
    if (url && !(state as { __NA?: boolean; _N?: boolean } | null)?.__NA && !(state as { _N?: boolean } | null)?._N && current?.(String(url), false)) return;
    return realPush!.call(history, state, unused, url);
  };
  history.replaceState = function (state, unused, url) {
    if (url && !(state as { __NA?: boolean; _N?: boolean } | null)?.__NA && !(state as { _N?: boolean } | null)?._N && current?.(String(url), true)) return;
    return realReplace!.call(history, state, unused, url);
  };
}
function removeHistory() {
  if (--installed > 0) return;
  if (realPush) history.pushState = realPush;
  if (realReplace) history.replaceState = realReplace;
  realPush = realReplace = null;
}

export default function VirtualRoute({ start, active, onOutside, onLocation, back }: { start: string; active: boolean; onOutside: (href: string) => void; onLocation?: (href: string, canBack: boolean) => void; back?: React.MutableRefObject<(() => void) | null> }) {
  const [entries, setEntries] = useState<string[]>([start]);
  const [at, setAt] = useState(0);
  const here = entries[at] ?? start;
  const url = useMemo(() => new URL(here, 'https://window.local'), [here]);
  const match = useMemo(() => matchPage(url.pathname), [url.pathname]);
  const outside = useRef(onOutside); outside.current = onOutside;
  useEffect(() => { onLocation?.(here, at > 0); }, [here, at, onLocation]);
  useEffect(() => { if (!back) return; back.current = () => setAt(n => Math.max(0, n - 1)); return () => { back.current = null; }; }, [back]);

  const go = useCallback((href: string, replace = false) => {
    const next = new URL(href, url);
    if (next.origin !== 'https://window.local' && next.origin !== location.origin) { outside.current(href); return false; }
    const local = next.pathname + next.search + next.hash;
    if (!matchPage(next.pathname)) { outside.current(local); return false; }
    setEntries(list => replace ? [...list.slice(0, at), local, ...list.slice(at + 1)] : [...list.slice(0, at + 1), local]);
    if (!replace) setAt(n => n + 1);
    return true;
  }, [url, at]);

  // A new start from outside (a shared link, the desk's icon again) moves the window there.
  useEffect(() => { setEntries(list => list[at] === start ? list : [...list.slice(0, at + 1), start]); setAt(n => entries[n] === start ? n : n + 1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [start]);

  const router = useMemo(() => ({
    push: (href: string) => { go(href); },
    replace: (href: string) => { go(href, true); },
    back: () => setAt(n => Math.max(0, n - 1)),
    forward: () => setAt(n => n + 1 < entries.length ? n + 1 : n),
    refresh: () => setEntries(list => [...list]),
    prefetch: () => {},
    hmrRefresh: () => {},
  }), [go, entries.length]);

  useEffect(() => {
    installHistory();
    return removeHistory;
  }, []);
  useEffect(() => {
    if (!active) return;
    // The room's own address changes nothing here: only what is not the room is a move of this window.
    const self = (href: string, replace: boolean) => {
      const u = new URL(href, location.origin);
      if (u.pathname === '/study-space') return false;
      return go(u.pathname + u.search + u.hash, replace) || true;
    };
    current = self;
    return () => { if (current === self) current = null; };
  }, [active, go]);

  /** A link inside the page: the same click, followed here. */
  const onClick = (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const u = new URL(a.href, location.origin);
    if (u.origin !== location.origin) return;
    e.preventDefault(); e.stopPropagation();
    go(u.pathname + u.search + u.hash);
  };

  const params = useMemo(() => new URLSearchParams(url.search), [url.search]);
  const Page = match?.Page;
  return <AppRouterContext.Provider value={router as unknown as React.ContextType<typeof AppRouterContext>}>
    <PathnameContext.Provider value={url.pathname}>
      <SearchParamsContext.Provider value={params}>
        <PathParamsContext.Provider value={match?.params ?? {}}>
          <div style={{ height: '100%', minHeight: 0, overflow: 'auto', isolation: 'isolate' }} onClickCapture={onClick} data-virtual-route={here}>
            {Page ? <Page /> : null}
          </div>
        </PathParamsContext.Provider>
      </SearchParamsContext.Provider>
    </PathnameContext.Provider>
  </AppRouterContext.Provider>;
}
