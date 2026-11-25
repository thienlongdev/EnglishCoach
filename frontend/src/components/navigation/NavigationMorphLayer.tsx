'use client';

import React, { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { stepSpring, type SpringSpec, type SpringValue } from '@/lib/morph/spring';
import { OceanGlyphDefs, type GlyphTone } from '@/components/layout/OceanCurrent';
import { findNavDestination, NAV_REGISTRY, resolveActiveNavId } from '@/lib/navigation/registry';
import { registerBeforeLayoutSwitch } from '@/lib/navigation/preferences';
import {
  captureNavMorphBeforeSwitch,
  completeNavMorph,
  getActiveNavMorph,
  measureNavigationSurface,
  registerLiveFlightReader,
  subscribeNavMorph,
  type InFlightState,
  type MorphBox,
} from '@/lib/navigation/morphCoordinator';
import styles from './NavigationMorphLayer.module.css';

const SHELL_SPRING: SpringSpec = { stiffness: 255, damping: 26, mass: 1, precision: 0.45 };
const ICON_SPRING: SpringSpec = { stiffness: 295, damping: 27, mass: 1, precision: 0.4 };

function tonePaint(tone: GlyphTone): string {
  return `url(#ec-og-${tone})`;
}

interface IconFlight {
  id: string;
  el: HTMLElement;
  x: SpringValue;
  y: SpringValue;
  w: SpringValue;
  h: SpringValue;
  opacity: SpringValue;
  tx: number;
  ty: number;
  tw: number;
  th: number;
  toOpacity: number;
  arcSign: number;
  delayMs: number;
}

export default function NavigationMorphLayer() {
  const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const activeId = resolveActiveNavId(pathname, searchParams.get('tab'));

  // Register synchronous pre-switch capture hook once so every setNavigationLayout call triggers FLIP
  useEffect(() => {
    registerBeforeLayoutSwitch(captureNavMorphBeforeSwitch);
    return () => registerBeforeLayoutSwitch(null);
  }, []);

  const snap = useSyncExternalStore(subscribeNavMorph, getActiveNavMorph, () => null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const iconRefs = useRef<Map<string, HTMLSpanElement>>(new Map());

  useLayoutEffect(() => {
    if (!snap) {
      registerLiveFlightReader(null);
      return;
    }

    const shellEl = shellRef.current;
    if (!shellEl) {
      completeNavMorph(snap.seq);
      return;
    }

    // Measure LAST geometry from the newly mounted destination surface
    const dest = measureNavigationSurface(snap.to);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fallbackDestSurface: MorphBox =
      snap.to === 'dock'
        ? { x: Math.max(16, (vw - 680) / 2), y: vh - 76, w: Math.min(680, vw - 32), h: 62, rx: 25 }
        : { x: 6, y: 8, w: 252, h: Math.max(320, vh - 16), rx: 25.6 };

    const targetSurface = dest.surface ?? fallbackDestSurface;
    const startSurface = snap.surface ?? fallbackDestSurface;
    const sv = snap.surfaceVelocity ?? { x: 0, y: 0, w: 0, h: 0, rx: 0 };

    const sx: SpringValue = { position: startSurface.x, velocity: sv.x };
    const sy: SpringValue = { position: startSurface.y, velocity: sv.y };
    const sw: SpringValue = { position: startSurface.w, velocity: sv.w };
    const sh: SpringValue = { position: startSurface.h, velocity: sv.h };
    const srx: SpringValue = { position: startSurface.rx ?? 25, velocity: sv.rx };

    // Union of icons present in source or destination
    const unionIds: string[] = [];
    for (const item of NAV_REGISTRY) {
      if (snap.icons.has(item.id) || dest.icons.has(item.id)) {
        unionIds.push(item.id);
      }
    }

    const sourceFallbackAnchor: MorphBox =
      snap.libraryAnchor ?? {
        x: startSurface.x + startSurface.w * 0.85 - 16,
        y: startSurface.y + startSurface.h * 0.5 - 16,
        w: 32,
        h: 32,
      };
    const destFallbackAnchor: MorphBox =
      dest.libraryAnchor ?? {
        x: targetSurface.x + targetSurface.w * 0.88 - 16,
        y: targetSurface.y + targetSurface.h * 0.5 - 16,
        w: 32,
        h: 32,
      };

    const flights: IconFlight[] = [];
    unionIds.forEach((id, index) => {
      const el = iconRefs.current.get(id);
      if (!el) return;
      const fromBox = snap.icons.get(id);
      const toBox = dest.icons.get(id);
      const iv = snap.iconVelocities?.get(id);

      const initial = fromBox ?? {
        x: sourceFallbackAnchor.x + 4,
        y: sourceFallbackAnchor.y + 4,
        w: sourceFallbackAnchor.w * 0.65,
        h: sourceFallbackAnchor.h * 0.65,
      };
      const goal = toBox ?? {
        x: destFallbackAnchor.x + 4,
        y: destFallbackAnchor.y + 4,
        w: destFallbackAnchor.w * 0.62,
        h: destFallbackAnchor.h * 0.62,
      };

      flights.push({
        id,
        el,
        x: { position: initial.x, velocity: iv?.vx ?? 0 },
        y: { position: initial.y, velocity: iv?.vy ?? 0 },
        w: { position: initial.w, velocity: iv?.vw ?? 0 },
        h: { position: initial.h, velocity: iv?.vh ?? 0 },
        opacity: { position: fromBox ? 1 : 0.15, velocity: 0 },
        tx: goal.x,
        ty: goal.y,
        tw: goal.w,
        th: goal.h,
        toOpacity: toBox ? 1 : 0,
        arcSign: snap.to === 'dock' ? -1 : 1,
        delayMs: Math.min(index * 11, 72),
      });
    });

    const paint = (elapsedMs: number) => {
      shellEl.style.transform = `translate3d(${sx.position.toFixed(2)}px, ${sy.position.toFixed(2)}px, 0)`;
      shellEl.style.width = `${Math.max(40, sw.position).toFixed(2)}px`;
      shellEl.style.height = `${Math.max(40, sh.position).toFixed(2)}px`;
      shellEl.style.borderRadius = `${Math.max(12, srx.position).toFixed(1)}px`;

      for (const fl of flights) {
        // Subtle parabolic spatial lift mid-flight so icons travel in a fluid arc rather than rigid straight lines
        const distRemain = Math.hypot(fl.tx - fl.x.position, fl.ty - fl.y.position);
        const arcLift = elapsedMs < 460 ? Math.min(10, distRemain * 0.045) * fl.arcSign : 0;
        fl.el.style.transform = `translate3d(${fl.x.position.toFixed(2)}px, ${(fl.y.position + arcLift).toFixed(2)}px, 0)`;
        fl.el.style.width = `${Math.max(16, fl.w.position).toFixed(2)}px`;
        fl.el.style.height = `${Math.max(16, fl.h.position).toFixed(2)}px`;
        fl.el.style.opacity = Math.max(0, Math.min(1, fl.opacity.position)).toFixed(3);
      }
    };

    // Paint initial frame synchronously inside useLayoutEffect before browser paints
    paint(0);

    registerLiveFlightReader((): InFlightState => {
      const iconMap = new Map<
        string,
        { box: MorphBox; vx: number; vy: number; vw: number; vh: number; opacity: number }
      >();
      for (const fl of flights) {
        iconMap.set(fl.id, {
          box: { x: fl.x.position, y: fl.y.position, w: fl.w.position, h: fl.h.position },
          vx: fl.x.velocity,
          vy: fl.y.velocity,
          vw: fl.w.velocity,
          vh: fl.h.velocity,
          opacity: fl.opacity.position,
        });
      }
      return {
        surface: {
          x: sx.position,
          y: sy.position,
          w: sw.position,
          h: sh.position,
          rx: srx.position,
        },
        surfaceVelocity: {
          x: sx.velocity,
          y: sy.velocity,
          w: sw.velocity,
          h: sh.velocity,
          rx: srx.velocity,
        },
        icons: iconMap,
      };
    });

    let raf = 0;
    let last = performance.now();
    const originTime = last;

    const tick = (now: number) => {
      raf = 0;
      const dt = Math.min(0.034, Math.max(0.001, (now - last) / 1000));
      const elapsed = now - originTime;
      last = now;

      const nextX = stepSpring(sx, targetSurface.x, dt, SHELL_SPRING);
      const nextY = stepSpring(sy, targetSurface.y, dt, SHELL_SPRING);
      const nextW = stepSpring(sw, targetSurface.w, dt, SHELL_SPRING);
      const nextH = stepSpring(sh, targetSurface.h, dt, SHELL_SPRING);
      const nextRx = stepSpring(srx, targetSurface.rx ?? 25, dt, SHELL_SPRING);
      sx.position = nextX.position; sx.velocity = nextX.velocity;
      sy.position = nextY.position; sy.velocity = nextY.velocity;
      sw.position = nextW.position; sw.velocity = nextW.velocity;
      sh.position = nextH.position; sh.velocity = nextH.velocity;
      srx.position = nextRx.position; srx.velocity = nextRx.velocity;

      let iconsSettled = true;
      for (const fl of flights) {
        if (elapsed >= fl.delayMs) {
          const nx = stepSpring(fl.x, fl.tx, dt, ICON_SPRING);
          const ny = stepSpring(fl.y, fl.ty, dt, ICON_SPRING);
          const nw = stepSpring(fl.w, fl.tw, dt, ICON_SPRING);
          const nh = stepSpring(fl.h, fl.th, dt, ICON_SPRING);
          const no = stepSpring(fl.opacity, fl.toOpacity, dt, { stiffness: 320, damping: 32, mass: 1, precision: 0.01 });
          fl.x = nx; fl.y = ny; fl.w = nw; fl.h = nh; fl.opacity = no;
        }
        const doneIcon =
          elapsed >= fl.delayMs &&
          Math.abs(fl.x.position - fl.tx) <= ICON_SPRING.precision &&
          Math.abs(fl.y.position - fl.ty) <= ICON_SPRING.precision &&
          Math.abs(fl.x.velocity) <= ICON_SPRING.precision * 10 &&
          Math.abs(fl.y.velocity) <= ICON_SPRING.precision * 10;
        if (!doneIcon) iconsSettled = false;
      }

      const shellSettled =
        Math.abs(sx.position - targetSurface.x) <= SHELL_SPRING.precision &&
        Math.abs(sy.position - targetSurface.y) <= SHELL_SPRING.precision &&
        Math.abs(sw.position - targetSurface.w) <= SHELL_SPRING.precision &&
        Math.abs(sh.position - targetSurface.h) <= SHELL_SPRING.precision &&
        Math.abs(sx.velocity) <= SHELL_SPRING.precision * 10 &&
        Math.abs(sy.velocity) <= SHELL_SPRING.precision * 10;

      paint(elapsed);

      if ((shellSettled && iconsSettled) || elapsed > 950) {
        registerLiveFlightReader(null);
        completeNavMorph(snap.seq);
        return;
      }
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      registerLiveFlightReader(null);
    };
  }, [snap]);

  if (!snap) return null;

  return (
    <div className={styles.layer} aria-hidden="true" data-testid="navigation-morph-layer" data-morph-to={snap.to}>
      <OceanGlyphDefs />
      <div ref={shellRef} className={styles.morphShell} />
      {NAV_REGISTRY.map((item) => {
        const dest = findNavDestination(item.id)!;
        const Icon = dest.icon;
        const isCurrent = activeId === item.id && item.href !== null;
        return (
          <span
            key={item.id}
            ref={(node) => {
              if (node) iconRefs.current.set(item.id, node);
              else iconRefs.current.delete(item.id);
            }}
            className={`${styles.flyingGlyph} ${isCurrent ? styles.flyingGlyphActive : ''}`}
            data-tone={dest.tone}
            data-flying-id={item.id}
            style={{ opacity: 0 }}
          >
            <Icon className={`${styles.flyingIcon} ${isCurrent ? '' : dest.iconColor}`} stroke={tonePaint(dest.tone)} />
          </span>
        );
      })}
    </div>
  );
}
