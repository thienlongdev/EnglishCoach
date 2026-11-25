'use client';

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { preload } from 'react-dom';
import { MotionConfig } from 'framer-motion';
import { LandingHero } from './LandingHero';
import { DiveJourney } from './dive/DiveJourney';
import { FinalCTA } from './FinalCTA';
import { LandingFooter } from './LandingFooter';
import { OceanAtmosphere } from './ocean/OceanAtmosphere';
import { WordRipple } from './ocean/WordRipple';
import { ECHO_MODEL_URL, ECHO_STILL } from './ocean/echoAssets';
import type { OceanFailure } from './ocean/oceanEngine';
import type { EchoProgress } from './ocean/OceanStage';

// three.js and the whale engine are their own chunk (never part of the landing chunk). The server renders the empty
// stage layer, so the HTML preloads that chunk (low priority) and it downloads alongside the app, instead of being
// requested only after hydration. Its own Suspense boundary (`loading`) keeps the rest of the page hydrating without it.
const OceanStage = dynamic(() => import('./ocean/OceanStage'), { loading: () => null });

const ROOT_ID = 'landing-ocean';

/**
 * How Echo is presented. One value, so the still and the 3D whale can never be in an impossible combination:
 * - `pending`: water only — Echo is on time and will swim in (no placeholder on a healthy connection);
 * - `standby`: Echo is late (model stalled, or not drawn by the deadline): the still of the real model is shown;
 * - `handoff`: the 3D Echo is drawn exactly under the still, which fades out above it;
 * - `live`: the 3D Echo alone;
 * - `still`: the 3D Echo is unavailable (model failed twice, no WebGL, lost context, chunk error): the still stays.
 */
export type EchoView = 'pending' | 'standby' | 'handoff' | 'live' | 'still';
type EchoEvent = 'late' | 'shown' | 'faded' | 'failed';

function nextEchoView(view: EchoView, event: EchoEvent): EchoView {
  switch (event) {
    case 'late':
      return view === 'pending' ? 'standby' : view;
    case 'shown':
      return view === 'pending' ? 'live' : view === 'standby' ? 'handoff' : view;
    case 'faded':
      return view === 'handoff' ? 'live' : view;
    case 'failed':
      return 'still';
  }
}

// When Echo counts as late. Measured on the deployed build (cold visits, `features/landing.md`): the 3D Echo is drawn
// by ~1.7 s on desktop and by ~5.4 s on a throttled phone (150 ms / 1.6 Mbps / 4× CPU), so the deadline sits just
// above the slowest healthy case — no still flashes on a healthy connection. A model request that stops making
// progress (the engine's stall signal) shows the still at once, without waiting for the deadline.
const STANDBY_AFTER_NAVIGATION_MS = 6000;
// After a client-side navigation back to `/` (the model is usually cached by then).
const STANDBY_AFTER_MOUNT_MS = 2500;
// The still's fade-out over the 3D Echo (`duration-700` in EchoStandby) plus a margin; Echo holds still until then.
const HANDOFF_MS = 900;

/** A chunk that fails to load (lossy network) must never take the landing page down: Echo falls back to the still. */
class OceanBoundary extends React.Component<{ onError: () => void; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * "Echo's Ocean": the landing page is one continuous body of water. Layers, back to front:
 * atmosphere (CSS) → WebGL ocean with Echo the whale (click-through) → page content → tap-ripple words (click-through).
 */
export function LandingPage() {
  // Start the whale download with the HTML so Echo is ready by the time three.js is. Low priority: the app's own
  // scripts (hydration, the call-to-action) go first on a slow link; the model still downloads in parallel. The still
  // (6.8 KB) comes along so a late Echo never waits on another request.
  preload(ECHO_MODEL_URL, { as: 'fetch', crossOrigin: 'anonymous', fetchPriority: 'low' });
  preload(ECHO_STILL.src, { as: 'image', fetchPriority: 'low' });

  const [view, dispatch] = useReducer(nextEchoView, 'pending');
  // The model is in the scene and will be drawn on the next frame: too late to put a still up first.
  const echoReady = useRef(false);
  // `stageFailed`: the WebGL layer itself is gone (no WebGL, lost context, chunk error); a model failure alone keeps
  // the living water.
  const [stageFailed, setStageFailed] = useState(false);
  const onOceanFail = useCallback((reason: OceanFailure | 'chunk') => {
    dispatch('failed');
    if (reason !== 'model') setStageFailed(true);
  }, []);
  const onChunkError = useCallback(() => onOceanFail('chunk'), [onOceanFail]);
  const onEcho = useCallback((event: EchoProgress) => {
    if (event === 'ready') echoReady.current = true;
    else if (event === 'shown') dispatch('shown');
    else if (!echoReady.current) dispatch('late');
  }, []);

  useEffect(() => {
    // The deadline only runs while the page is shown: a landing opened in a background tab starts its ocean when it
    // is first shown (requestAnimationFrame), so Echo is not late before that.
    let timer = 0;
    const arm = () => {
      if (document.hidden || timer) return;
      const wait = Math.max(STANDBY_AFTER_MOUNT_MS, STANDBY_AFTER_NAVIGATION_MS - performance.now());
      timer = window.setTimeout(() => {
        if (!echoReady.current) dispatch('late');
      }, wait);
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      document.removeEventListener('visibilitychange', arm);
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (view !== 'handoff') return;
    const timer = window.setTimeout(() => dispatch('faded'), HANDOFF_MS);
    return () => window.clearTimeout(timer);
  }, [view]);

  return (
    <div
      id={ROOT_ID}
      data-discover-document=""
      data-echo-view={view}
      className="relative isolate min-h-screen overflow-x-clip bg-[#04143a] font-sans text-slate-100 antialiased selection:bg-indigo-500 selection:text-white"
    >
      <OceanAtmosphere />
      {!stageFailed && (
        <OceanBoundary onError={onChunkError}>
          <OceanStage laneRootId={ROOT_ID} onEcho={onEcho} onFail={onOceanFail} />
        </OceanBoundary>
      )}

      <MotionConfig reducedMotion="user">
        <div className="relative z-[2]">
          <div>
            <LandingHero echoStill={view === 'standby' || view === 'handoff' || view === 'still' ? view : null} />
            <DiveJourney />
            <FinalCTA />
          </div>
          <LandingFooter />
        </div>
      </MotionConfig>

      <WordRipple rootId={ROOT_ID} />
    </div>
  );
}
