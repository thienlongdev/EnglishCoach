'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { NavigationVisibility } from './preferences';
import { getActiveNavMorph, subscribeNavMorph } from './morphCoordinator';

export type NavAutoHideSurface = 'sidebar' | 'dock' | 'topbar';
interface AutoHideOptions {
  surface: NavAutoHideSurface;
  visibility: NavigationVisibility;
  lockedOpen?: boolean;
}

const surfaceSelector = '[data-nav-surface], [data-nav-hit]';
const edgeSelector = '[data-nav-edge]';
type Region = 'surface' | 'edge' | null;
const listeners = new Set<() => void>();
const overlays = new Set<symbol>();
let pointer: { x: number; y: number } | null = null;
let region: Region = null;
let keyboardNavigation = false;
let touchRevealed = false;
let revealed = false;
let hideTimer: number | undefined;
let stopListening: (() => void) | undefined;

function publish(next: boolean) {
  if (next === revealed) return;
  revealed = next;
  listeners.forEach(listener => listener());
}

function shouldReveal() {
  const keyboardFocus = keyboardNavigation && document.activeElement?.closest(surfaceSelector);
  return Boolean(region || overlays.size || touchRevealed || keyboardFocus);
}

function scheduleSharedHide() {
  if (shouldReveal()) {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
    publish(true);
  } else if (revealed && hideTimer === undefined) {
    hideTimer = window.setTimeout(() => {
      hideTimer = undefined;
      publish(shouldReveal());
    }, 110);
  }
}

function regionOf(target: EventTarget | null): Region {
  if (!(target instanceof Element) || document.fullscreenElement) return null;
  if (target.closest(surfaceSelector)) return 'surface';
  if (!target.closest(edgeSelector)) return null;
  return document.querySelector('[role="dialog"][aria-modal="true"]') ? null : 'edge';
}

// An overlay or layout change can replace the hit target without a pointerleave.
function reconcile() {
  region = pointer ? regionOf(document.elementFromPoint(pointer.x, pointer.y)) : null;
  scheduleSharedHide();
}

function listen() {
  const controller = new AbortController();
  const options = { capture: true, passive: true, signal: controller.signal };
  function track(event: PointerEvent) {
    if (!event.isPrimary) return;
    const down = event.type === 'pointerdown';
    const moved = event.type === 'pointermove' &&
      (event.clientX !== pointer?.x || event.clientY !== pointer?.y);
    if (down || moved) keyboardNavigation = false;
    if (event.pointerType === 'touch') {
      pointer = null;
      region = null;
    } else {
      pointer ??= { x: 0, y: 0 };
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      region = regionOf(event.target);
    }
    if (down && !(event.target instanceof Element && event.target.closest(
      surfaceSelector + ', ' + edgeSelector + ', [data-autohide-owner] button[data-testid$="touch-handle"]'
    ))) touchRevealed = false;
    scheduleSharedHide();
  }
  document.addEventListener('pointermove', track, options);
  document.addEventListener('pointerover', track, options);
  document.addEventListener('pointerdown', track, options);
  document.addEventListener('pointerout', event => {
    if (!event.relatedTarget) {
      pointer = null;
      region = null;
      scheduleSharedHide();
    }
  }, options);
  document.addEventListener('keydown', event => {
    const active = document.activeElement;
    const tabbingIntoNavigation = event.key === 'Tab' && !active?.closest('[role="dialog"], [role="menu"]');
    if (tabbingIntoNavigation || (event.key.startsWith('Arrow') && active?.closest(surfaceSelector))) {
      keyboardNavigation = true;
    }
    if (event.key === 'Escape') touchRevealed = false;
    scheduleSharedHide();
  }, options);
  document.addEventListener('focusin', scheduleSharedHide, options);
  document.addEventListener('focusout', () => queueMicrotask(scheduleSharedHide), options);
  window.addEventListener('blur', () => {
    pointer = null;
    keyboardNavigation = false;
    touchRevealed = false;
    reconcile();
  }, { signal: controller.signal });
  return () => controller.abort();
}

function subscribeCoordinator(listener: () => void) {
  listeners.add(listener);
  stopListening ??= listen();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    stopListening?.();
    stopListening = undefined;
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
    revealed = touchRevealed = keyboardNavigation = false;
    pointer = region = null;
  };
}

const getSnapshot = () => revealed;
const serverSnapshot = () => false;

// Each mounted owner releases only its own hold, including during replacement or unmount.
export function useNavigationOverlay(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const owner = Symbol();
    overlays.add(owner);
    touchRevealed = false;
    reconcile();
    return () => {
      overlays.delete(owner);
      reconcile();
    };
  }, [active]);
}

function toggleRevealTouch() {
  if (document.fullscreenElement || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  touchRevealed = !touchRevealed;
  scheduleSharedHide();
}

export function useAutoHideSurface({ visibility, lockedOpen = false }: AutoHideOptions) {
  const isAutoHide = visibility === 'autohide';
  const visible = useSyncExternalStore(subscribeCoordinator, getSnapshot, serverSnapshot);
  const morph = useSyncExternalStore(subscribeNavMorph, getActiveNavMorph, () => null);
  useNavigationOverlay(isAutoHide && lockedOpen);
  useEffect(() => {
    touchRevealed = false;
    reconcile();
  }, [isAutoHide, morph]);
  return { isAutoHide, isRevealed: !isAutoHide || visible || Boolean(morph), toggleRevealTouch };
}
