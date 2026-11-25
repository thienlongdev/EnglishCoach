'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { ECHO_SCHOLAR_SPRITE } from '@/lib/guide/guideArt';
import { placeCard, placeEcho, type Box } from '@/lib/guide/placement.mjs';
import { findTarget, guideForbiddenHere } from '@/lib/guide/quiet';
import { markGuide, stopGuide } from '@/lib/guide/store';
import type { GuideDef, GuideStep } from '@/lib/guide/types';
import { createEchoLife, createGuideStage, holeFor, puff, type GuideStage } from './guideStage';
import styles from './guide.module.css';

const ECHO_SIZE = () => (window.innerWidth < 640 ? 66 : 84);
const SEEK_MS = 2600;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** One tour: the real page under a dim layer with a hole in it, a card and Echo. It owns its own elements only; it never writes on the page's. */
export function GuideTour({ def, startAt, vi, pathname }: { def: GuideDef; startAt: number; vi: boolean; pathname: string }) {
  const [index, setIndex] = useState(() => Math.min(startAt, def.steps.length - 1));
  const [shown, setShown] = useState<number | null>(null);
  const [lost, setLost] = useState(false);
  const steps = def.steps;
  const step: GuideStep | null = shown === null ? null : steps[shown];
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const rootRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<SVGPathElement>(null);
  const rimRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<SVGPathElement>(null);
  const blockerRef = useRef<SVGPathElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const echoRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const spriteRef = useRef<HTMLImageElement>(null);
  const bubblesRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<GuideStage | null>(null);
  const lifeRef = useRef<ReturnType<typeof createEchoLife> | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const directionRef = useRef<1 | -1>(1);
  const closingRef = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;
  const indexRef = useRef(index);
  indexRef.current = index;
  const firstRef = useRef(true);
  const returnFocus = useRef<HTMLElement | null>(null);

  // ── Open and close ──
  const close = useCallback((outcome: 'done' | 'skipped') => {
    if (closingRef.current) return;
    closingRef.current = true;
    markGuide(def.id, outcome, def.version, indexRef.current);
    const stage = stageRef.current;
    const still = reducedMotion();
    const whale = document.querySelector<HTMLElement>('.echo-launcher')?.getBoundingClientRect();
    if (outcome === 'done') lifeRef.current?.spout();
    if (bubblesRef.current && echoRef.current && !still) {
      const box = echoRef.current.getBoundingClientRect();
      puff(bubblesRef.current, box.left + box.width / 2, box.top, outcome === 'done' ? 5 : 2);
    }
    // Echo swims back to its own place; the companion's picture fades up as it arrives.
    if (stage && whale && whale.width > 0) {
      const size = ECHO_SIZE();
      stage.placeEcho(whale.left + whale.width / 2 - size / 2, whale.top + whale.height / 2 - size / 2, whale.left < window.innerWidth / 2 ? false : true);
    }
    if (rootRef.current) rootRef.current.dataset.closing = '';
    const leave = () => {
      stopGuide();
      returnFocus.current?.focus?.({ preventScroll: true });
    };
    if (!stage) {
      leave();
      return;
    }
    void stage.open(still ? 0 : outcome === 'done' ? 620 : 420).then(leave);
  }, [def.id, def.version]);

  useLayoutEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    const still = reducedMotion();
    const stage = createGuideStage(
      { root: rootRef.current!, dim: dimRef.current!, rim: rimRef.current!, glow: glowRef.current!, blocker: blockerRef.current!, card: cardRef.current!, echo: echoRef.current!, tilt: tiltRef.current! },
      still,
    );
    stageRef.current = stage;
    lifeRef.current = createEchoLife(spriteRef.current!, stage.moving, still);
    // Echo starts where the companion is.
    const whale = document.querySelector<HTMLElement>('.echo-launcher')?.getBoundingClientRect();
    const size = ECHO_SIZE();
    if (whale && whale.width > 0) {
      stage.placeEcho(whale.left + whale.width / 2 - size / 2, whale.top + whale.height / 2 - size / 2, true);
    } else {
      stage.placeEcho(window.innerWidth - size - 24, window.innerHeight - size - 24, true);
    }
    stage.snap();
    markGuide(def.id, 'started', def.version, indexRef.current);
    return () => {
      stage.dispose();
      lifeRef.current?.dispose();
      stageRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Where everything goes for the current step ──
  const layout = useCallback((travel: boolean) => {
    const stage = stageRef.current;
    const card = cardRef.current;
    const current = stepRef.current;
    if (!stage || !card || !current) return;
    const view = { w: window.innerWidth, h: window.innerHeight };
    const el = targetRef.current;
    const hole = el ? holeFor(el, current.pad ?? 6) : null;
    if (travel) stage.moveTo(hole);
    else stage.follow(hole);
    const size = { w: card.offsetWidth, h: card.offsetHeight };
    const where = placeCard(hole, size, view, current.place ?? 'auto');
    const cardBox: Box = { x: where.x, y: where.y, w: size.w, h: size.h };
    stage.placeCard(where.x, where.y);
    card.dataset.side = where.side;
    const echoSize = ECHO_SIZE();
    if (current.echoAt === 'target' && hole) {
      stage.placeEcho(hole.x + hole.w / 2 - echoSize / 2, hole.y + hole.h / 2 - echoSize / 2, where.x < hole.x);
    } else {
      const echo = placeEcho(cardBox, hole, echoSize, view);
      stage.placeEcho(echo.x, echo.y, echo.facesLeft);
    }
  }, []);

  // ── Finding the step's real element ──
  useEffect(() => {
    let cancelled = false;
    const go = (next: number) => {
      if (next < 0) {
        directionRef.current = 1;
        setIndex(0);
        return;
      }
      if (next >= steps.length) {
        // Nothing left to show on this screen. Never a spotlight on an empty place, never a trap.
        close(shownRef.current === null ? 'skipped' : 'done');
        return;
      }
      setIndex(next);
    };
    const current = steps[index];
    if (current.skipIf && findTarget(current.skipIf)) {
      go(index + directionRef.current);
      return;
    }
    if (!current.target) {
      targetRef.current = null;
      setShown(index);
      return;
    }
    const began = performance.now();
    const seek = () => {
      if (cancelled) return;
      // A page still settling (Echo Morph, 10 §BN): measure where it lands, not where it is passing through. Bounded by the attribute's own timer.
      if (document.documentElement.hasAttribute('data-morph-busy') && performance.now() - began < 900) {
        window.setTimeout(seek, 90);
        return;
      }
      const el = findTarget(current.target!);
      if (el) {
        targetRef.current = el;
        // Scroll only when the learner could not see it. A tall thing (an article, a list) that is already partly on screen stays where it is: their place in a text is theirs, and reading progress counts it.
        const rect = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const visible = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
        const offscreen = rect.height > vh * 0.6 ? visible < 180 : rect.top < 72 || rect.bottom > vh - 24 || rect.left < 0 || rect.right > window.innerWidth;
        if (offscreen && !el.closest('[aria-modal="true"]')) el.scrollIntoView({ block: rect.height > vh * 0.6 ? 'start' : 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
        setShown(index);
        return;
      }
      if (performance.now() - began > (current.waitMs ?? SEEK_MS)) {
        go(index + directionRef.current);
        return;
      }
      window.setTimeout(seek, 120);
    };
    seek();
    return () => {
      cancelled = true;
    };
  }, [index, steps, close]);

  // The words change first, then everything travels to the size of the new words.
  useLayoutEffect(() => {
    if (shown === null) return;
    layout(true);
    const stage = stageRef.current;
    if (firstRef.current) {
      firstRef.current = false;
      if (reducedMotion()) stage?.snap();
    }
    const puffTimer = window.setTimeout(() => {
      if (!bubblesRef.current || !echoRef.current || reducedMotion()) return;
      const box = echoRef.current.getBoundingClientRect();
      puff(bubblesRef.current, box.left + box.width * 0.2, box.top + box.height * 0.2, 1);
    }, 380);
    return () => window.clearTimeout(puffTimer);
  }, [shown, vi, layout]);

  // A press on the card is the guide's own: it must not clear the reader's text selection or close a menu the step is showing.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const keep = (event: Event) => {
      event.stopPropagation();
      if (event.type === 'mousedown') event.preventDefault();
    };
    card.addEventListener('mousedown', keep);
    card.addEventListener('pointerdown', keep);
    return () => {
      card.removeEventListener('mousedown', keep);
      card.removeEventListener('pointerdown', keep);
    };
  }, []);

  // A step's button takes the keyboard; a step where the learner acts leaves the page's focus alone.
  useEffect(() => {
    if (shown === null) return;
    const acting = steps[shown].advance && steps[shown].advance!.on !== 'next';
    if (!acting) primaryRef.current?.focus({ preventScroll: true });
  }, [shown, steps]);

  // ── Staying on the element ──
  useEffect(() => {
    if (shown === null) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const current = stepRef.current;
        if (!current || closingRef.current) return;
        const gone = !targetRef.current || !targetRef.current.isConnected || targetRef.current.getBoundingClientRect().width < 2;
        if (current.target && gone) {
          // React replaced the element: the same control, a new node. Or it really went away.
          targetRef.current = findTarget(current.target);
          if (!targetRef.current) {
            setLost(true);
            return;
          }
        }
        setLost(false);
        layout(false);
      });
    };
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule, { passive: true });
    window.visualViewport?.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (targetRef.current) observer?.observe(targetRef.current);
    if (cardRef.current) observer?.observe(cardRef.current);
    // Layout can also move without any of those (a list above the target finishes loading). Light, and only while a guide is open.
    const interval = window.setInterval(schedule, 400);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      observer?.disconnect();
      window.clearInterval(interval);
    };
  }, [shown, layout]);

  // A control that really went away (a mode changed, a dialog closed): the step gives way to the next one rather than pointing at nothing.
  useEffect(() => {
    if (!lost) return;
    const timer = window.setTimeout(() => {
      setLost(false);
      directionRef.current = 1;
      setShown(null);
      setIndex((i) => {
        if (i + 1 >= steps.length) {
          close('skipped');
          return i;
        }
        return i + 1;
      });
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [lost, steps.length, close]);

  // A screen where no guide may run: the learner went there on their own.
  useEffect(() => {
    if (guideForbiddenHere(pathname)) close('skipped');
  }, [pathname, close]);

  // ── The learner does the real thing ──
  const next = useCallback(() => {
    const at = indexRef.current;
    directionRef.current = 1;
    if (at + 1 >= steps.length) {
      close('done');
      return;
    }
    lifeRef.current?.happy();
    if (rimRef.current && !reducedMotion()) rimRef.current.dataset.pulse = String(at);
    setIndex(at + 1);
  }, [steps.length, close]);
  const back = useCallback(() => {
    directionRef.current = -1;
    setIndex(Math.max(0, indexRef.current - 1));
  }, []);

  useEffect(() => {
    if (shown === null) return;
    const advance = steps[shown].advance;
    if (!advance || advance.on === 'next') return;
    if (advance.on === 'click') {
      const onClick = (event: MouseEvent) => {
        const el = targetRef.current;
        if (el && event.target instanceof Node && el.contains(event.target)) window.setTimeout(next, 200);
      };
      document.addEventListener('click', onClick, true);
      return () => document.removeEventListener('click', onClick, true);
    }
    const timer = window.setInterval(() => {
      const there = !!findTarget(advance.selector);
      if (advance.on === 'present' ? there : !there) {
        window.clearInterval(timer);
        next();
      }
    }, 160);
    return () => window.clearInterval(timer);
  }, [shown, steps, next]);

  // ── Keys ──
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close('skipped');
        return;
      }
      const field = document.activeElement as HTMLElement | null;
      if (field && (field.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName))) return;
      if (event.key === 'ArrowRight' && stepRef.current && (stepRef.current.advance?.on ?? 'next') === 'next') {
        event.preventDefault();
        event.stopPropagation();
        next();
      } else if (event.key === 'ArrowLeft' && indexRef.current > 0) {
        event.preventDefault();
        event.stopPropagation();
        back();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close, next, back]);

  const title = step ? (vi ? step.title.vi : step.title.en) : '';
  const body = step ? (vi ? step.body.vi : step.body.en) : '';
  const acting = !!step?.advance && step.advance.on !== 'next';
  const last = shown !== null && shown === steps.length - 1;
  const position = shown === null ? 0 : shown;

  return (
    <div ref={rootRef} className={`${styles.tokens} ${styles.layer}`} data-guide-layer="" data-testid="guide-tour" data-guide-id={def.id} data-step={step?.id ?? ''} data-acting={acting || undefined}>
      <svg className={styles.veil} aria-hidden="true">
        <defs>
          <linearGradient id="ec-guide-rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#bdf3ff" />
            <stop offset="0.5" stopColor="#ffffff" />
            <stop offset="1" stopColor="#7fd4ff" />
          </linearGradient>
        </defs>
        <path ref={dimRef} className={styles.dim} fillRule="evenodd" d="" />
        {/* Over the hole, the page's control is not pressed by accident during an explanation; on a step that asks for it, this is gone. */}
        <path ref={blockerRef} className={styles.blocker} d="" />
        <path ref={glowRef} className={styles.glow} d="" />
        <path ref={rimRef} className={styles.rim} d="" stroke="url(#ec-guide-rim)" />
      </svg>

      <div ref={bubblesRef} className={styles.bubbles} aria-hidden="true" />

      <div ref={cardRef} className={styles.card} role="dialog" aria-modal="false" aria-labelledby="ec-guide-title" aria-describedby="ec-guide-body" tabIndex={-1} data-testid="guide-card">
        <div className={styles.cardTop}>
          <span className={styles.dots} role="img" aria-label={vi ? `Bước ${position + 1} trên ${steps.length}` : `Step ${position + 1} of ${steps.length}`}>
            {steps.map((item, i) => (
              <i key={item.id} data-on={i === position || undefined} data-past={i < position || undefined} />
            ))}
          </span>
          <button type="button" className={styles.iconButton} onClick={() => close('skipped')} aria-label={vi ? 'Đóng hướng dẫn' : 'Close guide'} data-testid="guide-close">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div key={shown ?? 'none'} className={styles.words} aria-live="polite">
          <p id="ec-guide-title" className={styles.title}>{title}</p>
          <p id="ec-guide-body" className={styles.body}>{body}</p>
        </div>
        <div className={styles.actions}>
          {position > 0 ? (
            <button type="button" className={styles.ghost} onClick={back} data-testid="guide-back">
              <ChevronLeft size={15} aria-hidden="true" />{vi ? 'Quay lại' : 'Back'}
            </button>
          ) : (
            <button type="button" className={styles.ghost} onClick={() => close('skipped')} data-testid="guide-skip">{vi ? 'Bỏ qua' : 'Skip'}</button>
          )}
          {acting ? (
            <button type="button" ref={primaryRef} className={styles.quiet} onClick={next} data-testid="guide-pass">{vi ? 'Để sau, tiếp' : 'Skip this step'}</button>
          ) : (
            <button type="button" ref={primaryRef} className={styles.primary} onClick={next} data-testid="guide-next">
              {last ? (vi ? 'Xong' : 'Done') : (vi ? 'Tiếp' : 'Next')}
            </button>
          )}
        </div>
      </div>

      <div ref={echoRef} className={styles.echo} data-face="left" data-testid="guide-echo" aria-hidden="true">
        <div ref={tiltRef} className={styles.echoTilt}>
          <div className={styles.echoFace}>
            <div className={styles.echoFloat}>
              {/* eslint-disable-next-line @next/next/no-img-element -- one content-hashed sheet of rendered poses, moved by transform */}
              <img
                ref={spriteRef}
                src={ECHO_SCHOLAR_SPRITE.src}
                alt=""
                draggable={false}
                className={styles.echoSprite}
                style={{ width: `${ECHO_SCHOLAR_SPRITE.cols * 100}%`, height: `${ECHO_SCHOLAR_SPRITE.rows * 100}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
