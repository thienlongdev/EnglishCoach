/**
 * Shared, allocation-free signals between the landing page DOM and the ocean renderer.
 *
 * The page writes (CTA hover, a tap ripple, the pointer); the whale engine reads on its own frame. Nothing here
 * triggers a React render, so a pointer move never re-renders the page.
 */
export interface OceanSignals {
  /** Pointer position in viewport CSS px, and when it last moved (performance.now ms). */
  pointerX: number;
  pointerY: number;
  pointerAt: number;
  /** A primary call-to-action is hovered / focused; its centre in viewport px. */
  ctaActive: boolean;
  ctaX: number;
  ctaY: number;
  /** performance.now() of the last primary CTA press (0 = never). */
  celebrateAt: number;
  /** The last tap ripple in viewport px, and when it happened (0 = never). */
  rippleX: number;
  rippleY: number;
  rippleAt: number;
}

export const oceanSignals: OceanSignals = {
  pointerX: -1,
  pointerY: -1,
  pointerAt: 0,
  ctaActive: false,
  ctaX: 0,
  ctaY: 0,
  celebrateAt: 0,
  rippleX: 0,
  rippleY: 0,
  rippleAt: 0,
};

/** Point the whale at a call-to-action while it is hovered or focused. */
export function signalCta(element: HTMLElement | null, active: boolean) {
  oceanSignals.ctaActive = active && !!element;
  if (element && active) {
    const rect = element.getBoundingClientRect();
    oceanSignals.ctaX = rect.left + rect.width / 2;
    oceanSignals.ctaY = rect.top + rect.height / 2;
  }
}

export function signalCelebrate() {
  oceanSignals.celebrateAt = performance.now();
}
