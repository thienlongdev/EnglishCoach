'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { morphLevel } from '@/lib/morph/rules';
import type { MorphEngine } from '@/lib/morph/engine';

/**
 * Echo Morph (10 §BN). Above the account key, so a route change is seen whatever remounts below it. The Landing and sign-in pages load nothing:
 * the engine chunk arrives with the first workspace screen and stays for the visit. It renders nothing.
 */
export default function MorphHost() {
  const pathname = usePathname() || '/';
  const search = useSearchParams();
  const engine = useRef<MorphEngine | null>(null);
  const latest = useRef({ pathname, search });
  latest.current = { pathname, search };

  // In the commit that changed the address: a flight starts before the new page's first paint.
  useLayoutEffect(() => {
    engine.current?.route(pathname, search);
  }, [pathname, search]);

  useEffect(() => {
    if (engine.current || morphLevel(pathname, search) === 'off') return;
    let live = true;
    void import('@/lib/morph/engine').then(({ startMorph }) => {
      if (!live || engine.current) return;
      engine.current = startMorph();
      engine.current.route(latest.current.pathname, latest.current.search, true);
    }).catch(() => undefined); // no chunk: pages behave exactly as without it
    return () => { live = false; };
  }, [pathname, search]);

  return null;
}
