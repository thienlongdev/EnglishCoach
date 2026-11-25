'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useLanguage } from '@/context/LanguageContext';
import { resolvePageTitle, type TabLiving } from '@/lib/brand/pageTitle';
import { holdTitle, setRouteTitle, setSwim } from '@/lib/brand/tabTitle';
import { runLivingFavicon } from '@/lib/brand/livingFavicon';

/**
 * The browser tab itself is Echo's little ocean: renders nothing. A page cannot draw on the tab's frame, so the two real things a page owns there do the
 * work: the favicon (lib/brand/livingFavicon) and the title. The title idea comes from Bruno Simon's folio-2025 (a text strip rewritten as a car moves past
 * trees); this is its own: after the page's name, which never moves, a small whale swims through waves and bubbles, slowly, then the name stands alone for a while.
 * Only in a visible tab, never on the landing page, never where someone concentrates, never while typing.
 */
const WATER = ['～', '˚', '～', '～', '∘', '～'];
const WHALE = '🐳';
const TRACK = WATER.length;
const STEP_MS = 620;

function swimFrame(position: number): string {
  let out = '';
  for (let i = 0; i < TRACK; i++) out += i === position ? WHALE : WATER[i];
  return out;
}

function isField(node: Element | null): boolean {
  const el = node as HTMLElement | null;
  if (!el?.tagName) return false;
  return el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT';
}

function runTitleSwim(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const quiet = () => document.hidden || motion.matches || isField(document.activeElement);
  const wait = () => { timer = setTimeout(swim, 16000 + Math.random() * 22000); };
  const step = (position: number) => {
    if (position < 0 || quiet()) { setSwim(''); wait(); return; }
    setSwim(swimFrame(position));
    timer = setTimeout(() => step(position - 1), STEP_MS);
  };
  const swim = () => { if (quiet()) wait(); else step(TRACK - 1); };
  timer = setTimeout(swim, 5000 + Math.random() * 5000);
  return () => { if (timer) clearTimeout(timer); setSwim(''); };
}

function Identity() {
  const pathname = usePathname() || '/';
  const tab = useSearchParams().get('tab');
  const { locale } = useLanguage();
  const page = resolvePageTitle(pathname, tab, locale === 'en' ? 'en' : 'vi');
  const living: TabLiving = page.living;
  const landing = page.landing;

  useEffect(() => { setRouteTitle(page); }, [page.title, page.living, page.landing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => holdTitle(), []);
  useEffect(() => (living === 'still' ? undefined : runLivingFavicon()), [living]);
  useEffect(() => (living !== 'still' && !landing ? runTitleSwim() : undefined), [living, landing]);
  return null;
}

export default function EchoTabIdentity() {
  return <Suspense fallback={null}><Identity /></Suspense>;
}
