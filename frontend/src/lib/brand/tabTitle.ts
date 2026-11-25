import { useEffect } from 'react';
import { BRAND_TITLE, shortTitle, type PageTitle } from './pageTitle';

/**
 * The ONE writer of document.title on the client. Its parts: the route's name (EchoTabIdentity), what a page says it shows (`useContentTitle`), an open
 * full-window tool (`useOverlayTitle`), the unread count, and the short swim of the living title. Next.js also writes the <title> element on a route
 * change; `holdTitle` puts the composed value back whenever anything else changed it, so a tab never keeps a previous page's name.
 */
let route: PageTitle = { title: BRAND_TITLE, living: 'calm', landing: true };
let section: string | null = null;
let content: string | null = null;
let overlay: string | null = null;
let unread = 0;
let swim = '';

export function composedTitle(): string {
  if (route.landing) return BRAND_TITLE;
  const base = overlay ?? content ?? section ?? route.title;
  // A count pulls the eye: it stays off the screens where someone is concentrating.
  const count = unread > 0 && route.living !== 'still' ? `(${unread > 99 ? '99+' : unread}) ` : '';
  return `${count}${base}${swim ? ` ${swim}` : ''}`;
}

function apply() {
  if (typeof document === 'undefined') return;
  const next = composedTitle();
  if (document.title !== next) document.title = next;
}

export function setRouteTitle(next: PageTitle) { route = next; swim = ''; apply(); }
export function setSwim(frame: string) { swim = frame; apply(); }
export function setUnreadTitle(count: number) { unread = count; apply(); }

/** Puts the title back when something else rewrites it. Only runs when <head> changes. */
export function holdTitle(): () => void {
  const observer = new MutationObserver(apply);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

/** A page names what is open: a lesson, an article, a book, a deck, an exam (`section` = a named part of a page, under any open item). Never private text. */
export function useContentTitle(title: string | null | undefined, level: 'item' | 'section' = 'item') {
  useEffect(() => {
    const text = title ? shortTitle(title) : null;
    if (!text) return;
    if (level === 'section') section = text; else content = text;
    apply();
    return () => {
      if (level === 'section') { if (section === text) section = null; }
      else if (content === text) content = null;
      apply();
    };
  }, [title, level]);
}

/** A full-window tool (dictionary, appearance studio) names itself while it is open. */
export function useOverlayTitle(label: string | null) {
  useEffect(() => {
    if (!label) return;
    overlay = label;
    apply();
    return () => {
      if (overlay === label) { overlay = null; apply(); }
    };
  }, [label]);
}
