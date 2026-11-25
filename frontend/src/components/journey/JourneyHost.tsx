'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ECHO_MODEL_URL, ECHO_STILL } from '@/components/landing/ocean/echoAssets';
import { endLogout } from '@/lib/auth-lifecycle';
import { sanitizeLocalPath } from '@/lib/sanitize-local-path';
import { resolvePageTitle } from '@/lib/brand/pageTitle';
import {
  crossingOf, directionOf, journeyActive, journeyHeapDirty, journeyStage, markJourneyHeapDirty, registerJourneyCancel, registerJourneyStarter, registerJourneyWarm, sceneOf, sceneOfUrl, setJourneyCarry,
  setJourneyHoldsAccount, setJourneyHoldsGuest, setJourneyPendingDest, setJourneyPhase, takeJourneyToken, writeJourneyToken, type EchoCarry, type JourneyRequest, type JourneyScene,
} from '@/lib/journey/journey';
import type { Bridge, BridgePalette, createBridge as CreateBridge, PALETTES as BridgePalettes } from './bridgeEngine';
import { AUTH_STILLS, isTallSea } from '@/lib/journey/stills';
import styles from './journey.module.css';

// Timings. The first press in a visit gets the full passage; later ones in the same visit are shorter: this is a door, not a film.
const DEPART_MS = 1000;
const COVER_MS = 760;
const REVEAL_MS = 900;
const CARRY_MS = 1500;
const FAST = 0.72;
const SEEN_KEY = 'ec_journey_seen';
// How long a destination may take before the visitor is told; before a real link is offered; and when the journey lets go in any case.
const SAY_AFTER_MS = 2500;
const LINK_AFTER_MS = 6000;
const GIVE_UP_MS = 12000;
// Sign-out: revocation and session termination are themselves bounded (22 s at worst); past this the page is reloaded on the destination, whatever happened.
const SIGN_OUT_LIMIT_MS = 36000;
// A slow sign-out: how soon Echo appears in the current, and how long it takes to swim out of it.
const SIGN_OUT_HOLD_MS = 320;
const RELEASE_MS = 640;
// A scene that has not drawn by then is shown through its first frame, which is a real frame of the same scene.
const SCENE_GRACE_MS = 1400;

interface JourneyView { active: boolean; curtain: 'off' | 'on' | 'out'; instant: boolean; whale: 'off' | 'swim'; dir: 1 | -1; say: boolean; link: string | null; blocking: boolean }
const REST: JourneyView = { active: false, curtain: 'off', instant: false, whale: 'off', dir: 1, say: false, link: null, blocking: false };

type BridgeModule = { createBridge: typeof CreateBridge; PALETTES: typeof BridgePalettes };
let bridgeModule: Promise<BridgeModule> | null = null;
export const loadBridge = () => (bridgeModule ??= import('./bridgeEngine'));

const media = (query: string) => typeof window !== 'undefined' && window.matchMedia(query).matches;
/** Save-Data, no WebGL 2, a software renderer: the CSS passage (the bridge refuses a major performance caveat itself). */
function canFly() {
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  try {
    return !!document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
  } catch {
    return false;
  }
}

function paletteOf(scene: JourneyScene, url: string, palettes: typeof BridgePalettes): BridgePalette {
  const night = document.documentElement.classList.contains('dark');
  if (scene === 'landing') return palettes.landing;
  if (scene === 'auth') return night ? palettes.authNight : url.includes('mode=register') || url.startsWith('/register') ? palettes.authDawn : palettes.authDay;
  return night ? palettes.workspaceNight : palettes.workspace;
}

// Bounded: a hidden tab draws no frames, and a journey must not wait for the visitor to come back to finish what it already knows.
const nextPaint = () => new Promise<void>((resolve) => {
  const timer = window.setTimeout(resolve, 260);
  requestAnimationFrame(() => requestAnimationFrame(() => { window.clearTimeout(timer); resolve(); }));
});
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Is the destination truly on screen? Read from the page itself, so a redirect (an expired session sent to sign-in) is judged by where the visitor actually is. */
function destinationReady(graceOver: boolean) {
  const path = window.location.pathname;
  const scene = sceneOf(path, new URLSearchParams(window.location.search).get('tab'));
  if (scene === 'landing') {
    const root = document.getElementById('landing-ocean');
    return !!root && (graceOver || root.dataset.oceanLive === '1' || (root.dataset.echo ?? '').startsWith('failed'));
  }
  if (scene === 'auth') {
    const shell = document.querySelector<HTMLElement>('[data-purpose="auth-standalone-shell"]');
    if (!shell) return !!document.querySelector('[data-purpose="auth-card"]');
    const ocean = shell.dataset.ocean ?? '';
    return graceOver || ocean === 'live' || ocean.startsWith('off-');
  }
  return !document.querySelector('[data-navigation-loading]') && (!!document.querySelector('[data-app-scroll]') || !!document.querySelector('[data-purpose="standalone-route"]'));
}

/**
 * The one coordinator of the journey (10 §BK). Mounted above the account key so it survives every route and account change. In the main bundle it is this file
 * and its stylesheet only: the bridge chunk (three.js) loads on the Landing and sign-in pages after they are idle, or at the moment of a journey.
 */
export default function JourneyHost() {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const searchParams = useSearchParams();
  const tab = searchParams.get('tab');
  const layerRef = useRef<HTMLDivElement>(null);
  const runRef = useRef(0);
  const bridgeRef = useRef<Bridge | null>(null);
  const [view, setView] = useState<JourneyView>(REST);
  const routerRef = useRef(router);
  routerRef.current = router;
  const sceneRef = useRef<JourneyScene>(sceneOf(pathname, tab));
  sceneRef.current = sceneOf(pathname, tab);
  const settledRef = useRef({ scene: sceneRef.current, before: sceneRef.current, at: 0 });
  useEffect(() => {
    const scene = sceneOf(pathname, tab);
    if (scene !== settledRef.current.scene) settledRef.current = { scene, before: settledRef.current.scene, at: performance.now() };
  }, [pathname, tab]);

  useEffect(() => {
    const finish = (run: number) => {
      if (run !== runRef.current) return;
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      // A scene still waiting for Echo (a journey that gave up) gets it back: `arrive` does nothing where nothing waits.
      const leftover: EchoCarry = { dir: 1, y: crossingOf(window.innerWidth, window.innerHeight).y, size: crossingOf(window.innerWidth, window.innerHeight).size, speed: window.innerWidth, tail: 0.4 };
      journeyStage('landing')?.arrive(leftover);
      journeyStage('auth')?.arrive(leftover);
      setJourneyCarry(null);
      setJourneyPendingDest(null);
      setJourneyHoldsGuest(false);
      setJourneyPhase('idle');
      delete document.documentElement.dataset.journeyHold;
      setView(REST);
    };

    const run = async (request: JourneyRequest) => {
      const id = ++runRef.current;
      const alive = () => id === runRef.current;
      const { from, dest, dir, arrivalOnly, external, signOut } = request;
      const to = sanitizeLocalPath(request.to, '/');
      const pressedAt = performance.now();
      const reduced = media('(prefers-reduced-motion: reduce)');
      const fly = !reduced && canFly();
      let seen = false;
      try {
        seen = !!sessionStorage.getItem(SEEN_KEY);
        sessionStorage.setItem(SEEN_KEY, '1');
      } catch {
        // first visit timing then
      }
      const tempo = seen ? FAST : 1;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const crossing = crossingOf(vw, vh);
      const living = resolvePageTitle(new URL(to, 'https://ec.local').pathname, new URL(to, 'https://ec.local').searchParams.get('tab'), 'vi').living;
      const carryToCompanion = dest === 'workspace' && living !== 'still';
      // The whole trip is bounded: whatever happens, the page comes back. A sign-out cannot come back to the account's page: it goes on to its destination by a real load.
      const giveUp = window.setTimeout(() => {
        if (!signOut) {
          finish(id);
          return;
        }
        if (!alive()) return;
        writeJourneyToken('signout');
        window.location.replace(to);
      }, signOut ? SIGN_OUT_LIMIT_MS : GIVE_UP_MS + 4000);

      setJourneyPendingDest(dest);
      setJourneyPhase(arrivalOnly ? 'covered' : 'departing');
      // After Back / Forward the next scene may already be mounted: its Echo waits for the opening too.
      if (arrivalOnly) journeyStage(dest)?.awaitArrival();
      if (from === 'auth' && dest !== 'auth') setJourneyHoldsGuest(true);
      setView({ active: true, curtain: arrivalOnly ? 'on' : 'off', instant: arrivalOnly && !!document.documentElement.dataset.journeyBoot, whale: 'off', dir, say: false, link: null, blocking: arrivalOnly });

      // ── Leaving ──
      const stage = arrivalOnly ? null : journeyStage(from);
      let departing = fly && stage
        ? stage.depart({ dir, y: crossing.y, size: crossing.size, ms: DEPART_MS * tempo }).catch(() => null)
        : Promise.resolve<EchoCarry | null>(null);

      let bridge: Bridge | null = null;
      if (fly) {
        try {
          const module = await Promise.race([loadBridge(), wait(arrivalOnly ? 2500 : 900).then(() => null)]);
          if (module && alive()) {
            bridge = module.createBridge({
              host: layerRef.current!,
              from: paletteOf(from, window.location.pathname + window.location.search, module.PALETTES),
              to: paletteOf(dest, to, module.PALETTES),
              dir,
              y: crossing.y,
              startCovered: arrivalOnly,
              onLost: () => {
                if (alive()) setView((v) => ({ ...v, curtain: 'on' }));
              },
            });
            bridgeRef.current = bridge;
            if (carryToCompanion) bridge.loadEcho();
            // The Workspace has no scene of its own: the bridge takes Echo from the companion's place in the frame of the press.
            if (!arrivalOnly && !stage && from === 'workspace') {
              const companion = document.querySelector<HTMLElement>('.echo-launcher')?.getBoundingClientRect();
              const start = companion && companion.width > 0
                ? { x: companion.left + companion.width / 2, y: companion.top + companion.height / 2, size: companion.width * 1.25 }
                : { x: dir > 0 ? vw * 0.3 : vw * 0.7, y: vh * crossing.y, size: crossing.size * 0.6 };
              departing = bridge.departEcho(start, crossing, DEPART_MS * tempo, () => {
                document.documentElement.dataset.journeyHold = '1';
              }).catch(() => null);
            }
          }
        } catch {
          bridge = null;
        }
      }
      if (!alive()) return;

      if (!arrivalOnly) {
        if (bridge) {
          const drawn = await Promise.race([bridge.ready, wait(700).then(() => false)]);
          if (!alive()) return;
          if (!drawn) bridge = null;
        }
        if (bridge) {
          // The opening appears ahead of Echo and fills the window just as Echo reaches it: the rift's lit lip is already on screen while the whale turns.
          const lead = (DEPART_MS - COVER_MS) * tempo + 110 - (performance.now() - pressedAt);
          if (lead > 0) await wait(lead);
          if (!alive()) return;
          const covering = bridge.cover(COVER_MS * tempo);
          // Bounded: a hidden tab draws no frames.
          await Promise.all([Promise.race([covering, wait(COVER_MS * tempo + 900)]), Promise.race([departing, wait(DEPART_MS * tempo + 500)])]);
        } else {
          setView((v) => ({ ...v, curtain: 'on', whale: fly || !reduced ? 'swim' : 'off' }));
          await wait(reduced ? 200 : 360);
        }
      }
      if (!alive()) return;
      let carry: EchoCarry = (await Promise.race([departing, wait(0).then(() => null)])) ?? { dir, y: crossing.y, size: crossing.size, speed: (vw * 1.1) / 0.9, tail: 0.4 };
      setJourneyCarry(carry);

      // ── Covered: the page changes behind the current ──
      setJourneyPhase('covered');
      setJourneyHoldsGuest(false);
      setView((v) => ({ ...v, curtain: 'on', blocking: true }));
      // After a sign-out without a page load, the Workspace is entered only by a real load: this page's module memory is not for the next account.
      if (journeyHeapDirty() && dest === 'workspace' && !arrivalOnly && !external) {
        writeJourneyToken('fresh');
        window.location.assign(to);
        return;
      }
      // From here the companion waits: Echo itself comes to rest in its place.
      if (carryToCompanion) document.documentElement.dataset.journeyHold = '1';
      if (external) {
        // The browser is leaving for the provider's own page; the journey cannot follow it there. If it never leaves, the page comes back.
        await wait(GIVE_UP_MS);
        finish(id);
        return;
      }
      if (arrivalOnly && bridge && !(await Promise.race([bridge.ready, wait(1500).then(() => false)]))) {
        bridge.dispose();
        bridgeRef.current = null;
        bridge = null;
      }
      if (!alive()) return;
      let echoHeld = false;
      if (signOut) {
        // The window is covered: the account's page may go. Echo swims in the current for as long as the session work takes; no words on screen unless it really is slow.
        setJourneyHoldsAccount(false);
        signOut.covered();
        let finished = false;
        void signOut.done.then(() => {
          finished = true;
        });
        const began = performance.now();
        while (!finished) {
          await nextPaint();
          if (!alive()) return;
          const waited = performance.now() - began;
          if (waited > SIGN_OUT_HOLD_MS && !echoHeld && bridge) {
            echoHeld = true;
            bridge.holdEcho(carry);
          }
          if (waited > SAY_AFTER_MS) setView((v) => (v.say ? v : { ...v, say: true }));
        }
        markJourneyHeapDirty();
      }
      if (!arrivalOnly) {
        if (request.replace) routerRef.current.replace(to);
        else routerRef.current.push(to);
      }

      const coveredAt = performance.now();
      let movedAt: number | null = null;
      for (;;) {
        await nextPaint();
        if (!alive()) return;
        const waited = performance.now() - coveredAt;
        // The router commits a moment after the push: the page that is ready must be the next one, not the one being left.
        const here = sceneOf(window.location.pathname, new URLSearchParams(window.location.search).get('tab'));
        const moved = arrivalOnly || here !== from || from === dest;
        if (moved) {
          // Only now may the guest's tree mount: on the destination, never on the protected route that was just left.
          if (signOut && movedAt === null) endLogout();
          movedAt ??= performance.now();
        }
        if (moved && destinationReady(performance.now() - movedAt! > SCENE_GRACE_MS)) break;
        if (waited > (signOut ? SIGN_OUT_HOLD_MS : 700) && !echoHeld && bridge) {
          // A slow destination: Echo keeps the visitor company in the current instead of a frozen screen.
          echoHeld = true;
          bridge.holdEcho(carry);
        }
        if (waited > SAY_AFTER_MS) setView((v) => (v.say ? v : { ...v, say: true }));
        if (waited > LINK_AFTER_MS) setView((v) => (v.link ? v : { ...v, link: to }));
        if (waited > GIVE_UP_MS) {
          // The route never showed. A real navigation is the honest recovery; the next page opens on its own first frame.
          if (window.location.pathname + window.location.search !== to && !arrivalOnly) window.location.assign(to);
          break;
        }
      }
      await nextPaint();
      if (!alive()) return;
      // A whale waiting in the current swims out first: the next scene brings in this body, with this speed and this tail beat, never a second whale beside it.
      if (bridge && echoHeld) {
        carry = await Promise.race([bridge.releaseEcho(carry, RELEASE_MS * tempo), wait(RELEASE_MS * tempo + 400).then(() => carry)]);
        setJourneyCarry(carry);
        if (!alive()) return;
      }

      // ── Arriving ──
      setJourneyPhase('revealing');
      setView((v) => ({ ...v, say: false, link: null, blocking: false, whale: 'off' }));
      const actualScene = sceneOf(window.location.pathname, new URLSearchParams(window.location.search).get('tab'));
      const destStage = journeyStage(actualScene);
      const revealY = carry.y;
      const revealMs = (reduced ? 320 : REVEAL_MS) * tempo;
      if (bridge) {
        setView((v) => ({ ...v, curtain: 'off' }));
        const revealing = bridge.reveal(revealMs, revealY);
        // Echo comes through once the opening has begun: the water parts, then the whale.
        void wait(revealMs * 0.16).then(() => {
          if (alive()) journeyStage(actualScene)?.arrive(carry);
        });
        const carrying = !destStage && carryToCompanion && actualScene === 'workspace' ? carryTo(bridge, carry, CARRY_MS * (seen ? 0.85 : 1)) : Promise.resolve();
        await revealing;
        if (!alive()) return;
        // Only Echo's own flight still draws: the current has gone.
        await carrying;
      } else {
        setView((v) => ({ ...v, curtain: 'out' }));
        destStage?.arrive(carry);
        await wait(revealMs);
      }
      window.clearTimeout(giveUp);
      finish(id);
    };

    const carryTo = async (bridge: Bridge, carry: EchoCarry, ms: number) => {
      const companion = document.querySelector<HTMLElement>('.echo-launcher')?.getBoundingClientRect();
      const target = companion && companion.width > 0 ? { x: companion.left + companion.width / 2, y: companion.top + companion.height / 2, size: companion.width * 1.2 } : null;
      await bridge.carryEcho(carry, target, ms);
      // Echo comes to rest as the companion: its picture fades up where the body landed.
      delete document.documentElement.dataset.journeyHold;
      await wait(320);
    };

    const unregisterCancel = registerJourneyCancel(() => finish(runRef.current));
    const start = (request: Omit<JourneyRequest, 'from' | 'dest' | 'dir'>) => {
      const safeTo = sanitizeLocalPath(request.to, '/');
      const from = sceneRef.current;
      const dest = sceneOfUrl(safeTo);
      void run({ ...request, to: safeTo, from, dest, dir: directionOf(from, dest) }).catch(() => {
        finish(runRef.current);
        const { signOut } = request;
        if (!signOut) return;
        // The passage broke: the page may go at once (`leaving` water), and the destination opens by a real load when the session work is over.
        setJourneyHoldsAccount(false);
        signOut.covered();
        void signOut.done.then(() => {
          writeJourneyToken('signout');
          window.location.replace(safeTo);
        });
      });
      return true;
    };
    const unregisterWarm = registerJourneyWarm(() => {
      void loadBridge().catch(() => {});
      if (!document.querySelector('link[data-journey-model]')) {
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'fetch';
        link.crossOrigin = 'anonymous';
        link.href = ECHO_MODEL_URL;
        link.dataset.journeyModel = '';
        document.head.appendChild(link);
      }
      routerRef.current.prefetch('/');
    });
    const unregister = registerJourneyStarter(start);

    // Back / Forward between places: the browser changes the page at once, so the passage starts covered and only the arrival is played.
    const onPop = () => {
      if (journeyActive()) return;
      const dest = sceneOf(window.location.pathname, new URLSearchParams(window.location.search).get('tab'));
      // The router may already have rendered the new page by the time this event arrives: the place being left is the one the visitor last settled in.
      const from = settledRef.current.scene !== dest ? settledRef.current.scene : performance.now() - settledRef.current.at < 400 ? settledRef.current.before : dest;
      if (from === dest) return;
      // Back into the Workspace after a sign-out on this page: a real load, not a passage over this page's memory.
      if (journeyHeapDirty() && dest === 'workspace') {
        writeJourneyToken('fresh');
        window.location.replace(window.location.pathname + window.location.search);
        return;
      }
      void run({ to: window.location.pathname + window.location.search, from, dest, dir: directionOf(from, dest), arrivalOnly: true, replace: false, external: false }).catch(() => finish(runRef.current));
    };
    window.addEventListener('popstate', onPop, true);

    // A page restored from the browser's back-forward cache must not come back covered.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      runRef.current += 1;
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      setJourneyCarry(null);
      setJourneyPendingDest(null);
      setJourneyHoldsGuest(false);
      setJourneyPhase('idle');
      delete document.documentElement.dataset.journeyBoot;
      delete document.documentElement.dataset.journeyHold;
      setView(REST);
    };
    window.addEventListener('pageshow', onPageShow);

    // Coming back from a full page load (Google sign-in, sign-out): the first paint already shows the current (boot script + `data-journey-boot`).
    const token = takeJourneyToken();
    const booted = document.documentElement.dataset.journeyBoot;
    if (token || booted) {
      const here = sceneRef.current;
      const from: JourneyScene = token === 'signout' ? 'workspace' : token === 'fresh' ? (here === 'workspace' ? 'auth' : 'workspace') : 'auth';
      const url = window.location.pathname + window.location.search;
      void run({ to: url, from, dest: here, dir: directionOf(from, here), arrivalOnly: true, replace: false, external: false }).catch(() => finish(runRef.current));
    }

    return () => {
      unregister();
      unregisterCancel();
      unregisterWarm();
      window.removeEventListener('popstate', onPop, true);
      window.removeEventListener('pageshow', onPageShow);
      finish(runRef.current);
    };
  }, []);

  // After a sign-out without a page load, any way into the Workspace (Back, a plain link, a redirect) is a real page load, under the same water: never a frame of a protected route on this page's memory.
  useLayoutEffect(() => {
    if (!journeyHeapDirty() || sceneOf(pathname, tab) !== 'workspace' || journeyActive()) return;
    setView({ ...REST, active: true, curtain: 'on', instant: true, blocking: true });
    writeJourneyToken('fresh');
    window.location.replace(window.location.pathname + window.location.search);
  }, [pathname, tab]);

  // Warm the way ahead once the page is idle, only on the pages a journey starts from: chunks and pictures, never account data, never every preset. Nothing on a workspace route.
  const scene = sceneOf(pathname, tab);
  useEffect(() => {
    if (scene === 'workspace' || media('(prefers-reduced-motion: reduce)')) return;
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    const idle = (window as Window & { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number }).requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 1200));
    let done = false;
    const warm = () => {
      if (done) return;
      done = true;
      void loadBridge().catch(() => {});
      if (scene === 'landing') {
        void import('@/components/auth/ocean/authOceanEngine').catch(() => {});
        const night = localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && media('(prefers-color-scheme: dark)'));
        const layout = isTallSea(window.innerWidth, window.innerHeight) ? 'tall' : 'wide';
        for (const still of [night ? AUTH_STILLS.nightDawn : AUTH_STILLS.dawn, night ? AUTH_STILLS.nightDay : AUTH_STILLS.day]) new Image().src = still[layout];
        routerRef.current.prefetch('/login');
      } else if (scene === 'auth') {
        routerRef.current.prefetch('/');
      }
      routerRef.current.prefetch('/dashboard');
    };
    const timer = window.setTimeout(() => idle(warm, { timeout: 1500 }), 1800);
    return () => window.clearTimeout(timer);
  }, [scene]);

  // The first paint of a page loaded into a journey shows the same water through the boot attribute; it leaves once the curtain is really up.
  const { active, curtain, instant, whale, dir, say, link, blocking } = view;
  useEffect(() => {
    if (curtain !== 'off') delete document.documentElement.dataset.journeyBoot;
  }, [curtain]);

  return (
    <div className={styles.host} data-journey-host="" data-active={active || undefined} data-blocking={blocking || undefined}>
      {curtain !== 'off' && (
        <div className={styles.curtain} data-state={curtain} data-dir={dir} data-instant={instant || undefined} aria-hidden="true">
          {whale === 'swim' && (
            // eslint-disable-next-line @next/next/no-img-element -- the small real still of Echo, already preloaded on the pages that start a journey
            <img className={styles.curtainWhale} src={ECHO_STILL.src} alt="" width={ECHO_STILL.width} height={ECHO_STILL.height} />
          )}
        </div>
      )}
      <div ref={layerRef} className={styles.layer} />
      {(say || link) && (
        <p className={styles.status} role="status" aria-live="polite">
          <span>Echo đang đưa bạn đến nơi…</span>
          {link && (
            <a href={sanitizeLocalPath(link, '/')} className={styles.statusLink}>
              Mở trang ngay
            </a>
          )}
        </p>
      )}
    </div>
  );
}
