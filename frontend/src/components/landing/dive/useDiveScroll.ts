'use client';

import { RefObject, useEffect } from 'react';

/**
 * Scroll progress for the dive journey, written as CSS custom properties so every transition is a pure function of
 * the scroll position: slow, fast, reversed, dragged or jumped, the page always shows the state for where it is.
 *
 * Any element with `data-dive-track` gets two numbers:
 *   --e  "entered": 0 as its top edge comes in at the bottom of the screen, 1 once it has risen 70 % of the screen;
 *   --s  "through": 0 with its top at 85 % of the screen, 1 with its bottom at 35 %.
 * The stylesheet's defaults are the finished state (--e: 1, --s: 1): without this script (no JavaScript, a crawler,
 * a failed chunk) every scene is simply there, fully readable.
 *
 * Boxes are measured in document coordinates when the layout changes; a scroll only does arithmetic and writes the
 * few properties that changed, once per frame. No scroll smoothing, no pinning, no listener that can hold the page.
 * Elements with `data-dive-scene` also drive the depth gauge (`data-dive-mark` links get `data-active`).
 */
export function useDiveScroll(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const tracked = Array.from(root.querySelectorAll<HTMLElement>('[data-dive-track]'));
    const scenes = tracked.filter((el) => el.hasAttribute('data-dive-scene'));
    const marks = Array.from(root.querySelectorAll<HTMLElement>('[data-dive-mark]'));
    const gauge = root.querySelector<HTMLElement>('[data-dive-gauge]');
    const boxes = tracked.map((el) => ({ el, top: 0, height: 0, e: -1, s: -1 }));
    let raf = 0;
    let active = '';
    let shown = '';
    let dive = -1;

    const measure = () => {
      const sy = window.scrollY;
      for (const box of boxes) {
        const rect = box.el.getBoundingClientRect();
        box.top = rect.top + sy;
        box.height = rect.height;
      }
    };

    const update = () => {
      raf = 0;
      const vh = window.innerHeight;
      const sy = window.scrollY;
      for (const box of boxes) {
        const top = box.top - sy;
        const e = Math.min(1, Math.max(0, (vh - top) / (vh * 0.7)));
        const s = Math.min(1, Math.max(0, (vh * 0.85 - top) / (box.height + vh * 0.5)));
        if (Math.abs(e - box.e) > 0.002) {
          box.e = e;
          box.el.style.setProperty('--e', e.toFixed(3));
        }
        if (Math.abs(s - box.s) > 0.002) {
          box.s = s;
          box.el.style.setProperty('--s', s.toFixed(3));
        }
      }
      // The gauge: which depth holds the reading line, and how far down the whole dive the visitor is.
      const line = sy + vh * 0.45;
      let current = '';
      for (const scene of scenes) {
        const box = boxes[tracked.indexOf(scene)];
        if (line >= box.top) current = scene.id;
      }
      if (current !== active) {
        active = current;
        for (const mark of marks) {
          if (mark.dataset.diveMark === current) mark.dataset.active = '1';
          else delete mark.dataset.active;
        }
      }
      if (gauge && scenes.length) {
        const first = boxes[tracked.indexOf(scenes[0])];
        const last = boxes[tracked.indexOf(scenes[scenes.length - 1])];
        const end = last.top + last.height;
        const inside = line >= first.top - vh * 0.2 && line <= end ? '1' : '0';
        if (inside !== shown) {
          shown = inside;
          gauge.dataset.shown = inside;
        }
        const progress = Math.min(1, Math.max(0, (line - first.top) / Math.max(1, end - first.top)));
        if (Math.abs(progress - dive) > 0.004) {
          dive = progress;
          gauge.style.setProperty('--dive', progress.toFixed(3));
        }
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onResize = () => {
      measure();
      schedule();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(root);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    measure();
    update();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', onResize);
      for (const box of boxes) {
        box.el.style.removeProperty('--e');
        box.el.style.removeProperty('--s');
      }
    };
  }, [rootRef]);
}
