import { holeOf, liquidPath, type Box } from '@/lib/guide/placement.mjs';
import { ECHO_SCHOLAR_SPRITE } from '@/lib/guide/guideArt';

/**
 * The choreography of Echo Guide (10 §BL): one loop moves the hole, the card and Echo as one object. The hole's four edges are four springs: the edges leading the movement are
 * stiffer than the trailing ones, so the opening stretches toward the next target and closes up behind itself, and each straight edge bows with its own speed. That is the liquid. Nothing
 * here runs at rest: a frame exists only while something still moves, and the whole object is gone when the guide closes. No WebGL and no second renderer: it adds nothing to Spatial or a Living World.
 */
interface Spring { x: number; v: number; to: number; k: number }
const spring = (x: number, k = 170): Spring => ({ x, v: 0, to: x, k });
const stepSpring = (s: Spring, dt: number, damping = 0.84) => {
  const c = 2 * Math.sqrt(s.k) * damping;
  s.v += (-s.k * (s.x - s.to) - c * s.v) * dt;
  s.x += s.v * dt;
};
const rests = (s: Spring, eps = 0.3) => Math.abs(s.x - s.to) < eps && Math.abs(s.v) < eps * 12;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export interface StageParts {
  root: HTMLElement;
  dim: SVGPathElement;
  rim: SVGPathElement;
  glow: SVGPathElement;
  blocker: SVGPathElement;
  card: HTMLElement;
  echo: HTMLElement;
  tilt: HTMLElement;
}

export interface GuideStage {
  /** Go to a new target: the hole and everything with it travel. */
  moveTo(hole: (Box & { r: number }) | null): void;
  /** The same target moved (scroll, resize, layout): the hole stays exactly on it, no lag. */
  follow(hole: (Box & { r: number }) | null): void;
  placeCard(x: number, y: number): void;
  placeEcho(x: number, y: number, facesLeft: boolean): void;
  /** Appear at once at the current destination (reduced motion, first frame). */
  snap(): void;
  /** The opening widens to the whole window and the dim fades: the closing of a guide. */
  open(ms: number): Promise<void>;
  /** Is anything still travelling? (Echo's tail beats faster while it swims.) */
  moving(): boolean;
  dispose(): void;
}

export function createGuideStage(parts: StageParts, still: boolean): GuideStage {
  let vw = window.innerWidth;
  let vh = window.innerHeight;
  const l = spring(0);
  const t = spring(0);
  const r = spring(vw);
  const b = spring(vh);
  const radius = spring(28, 150);
  const cardX = spring(vw / 2, 150);
  const cardY = spring(vh / 2, 150);
  const echoX = spring(vw - 96, 56);
  const echoY = spring(vh - 96, 56);
  const dimming = spring(0, 90);
  let none = true;
  let raf = 0;
  let last = 0;
  let disposed = false;
  let facesLeft = true;
  let wrote = '';
  const all = [l, t, r, b, radius, cardX, cardY, echoX, echoY, dimming];

  const paint = () => {
    const bow = { top: clamp(t.v * 0.007, -12, 12), right: clamp(r.v * 0.007, -12, 12), bottom: clamp(b.v * 0.007, -12, 12), left: clamp(l.v * 0.007, -12, 12) };
    const hole = none ? '' : liquidPath(l.x, t.x, Math.max(l.x + 1, r.x), Math.max(t.x + 1, b.x), Math.max(0, radius.x), bow);
    const d = `M0 0H${vw}V${vh}H0Z${hole}`;
    if (d !== wrote) {
      wrote = d;
      parts.dim.setAttribute('d', d);
      parts.rim.setAttribute('d', hole);
      parts.glow.setAttribute('d', hole);
      parts.blocker.setAttribute('d', hole);
    }
    parts.root.style.setProperty('--guide-dim', clamp(dimming.x, 0, 1).toFixed(3));
    parts.card.style.transform = `translate3d(${cardX.x.toFixed(1)}px, ${cardY.x.toFixed(1)}px, 0)`;
    parts.echo.style.transform = `translate3d(${echoX.x.toFixed(1)}px, ${echoY.x.toFixed(1)}px, 0)`;
    // The body leans into its own movement and stretches a little along it; it is the water that does this, not a rotating sticker.
    const speed = Math.hypot(echoX.v, echoY.v);
    const lean = clamp(echoY.v * 0.028, -14, 14) * (facesLeft ? 1 : -1);
    const stretch = clamp(speed / 1600, 0, 0.09);
    parts.tilt.style.transform = `rotate(${lean.toFixed(2)}deg) scale(${(1 + stretch).toFixed(3)}, ${(1 - stretch * 0.7).toFixed(3)})`;
  };

  const frame = (now: number) => {
    raf = 0;
    if (disposed) return;
    const dt = Math.min(1 / 30, (now - last) / 1000 || 1 / 60);
    last = now;
    let busy = false;
    for (const s of all) {
      if (rests(s)) {
        s.x = s.to;
        s.v = 0;
      } else {
        stepSpring(s, dt);
        busy = true;
      }
    }
    paint();
    if (busy) raf = requestAnimationFrame(frame);
  };
  const wake = () => {
    if (still) {
      for (const s of all) {
        s.x = s.to;
        s.v = 0;
      }
      paint();
      return;
    }
    if (raf || disposed) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const onResize = () => {
    vw = window.innerWidth;
    vh = window.innerHeight;
    wrote = '';
    paint();
  };
  window.addEventListener('resize', onResize, { passive: true });
  paint();

  return {
    moveTo(hole) {
      dimming.to = 1;
      if (!hole) {
        none = true;
      } else {
        // First target: the hole closes in from the whole window.
        if (none) {
          none = false;
          l.x = 0;
          t.x = 0;
          r.x = vw;
          b.x = vh;
          radius.x = 28;
        }
        const dx = hole.x + hole.w / 2 - (l.to + r.to) / 2;
        const dy = hole.y + hole.h / 2 - (t.to + b.to) / 2;
        const LEAD = 250;
        const TRAIL = 118;
        r.k = dx >= 0 ? LEAD : TRAIL;
        l.k = dx >= 0 ? TRAIL : LEAD;
        b.k = dy >= 0 ? LEAD : TRAIL;
        t.k = dy >= 0 ? TRAIL : LEAD;
        l.to = hole.x;
        t.to = hole.y;
        r.to = hole.x + hole.w;
        b.to = hole.y + hole.h;
        radius.to = hole.r;
      }
      wake();
    },
    follow(hole) {
      if (!hole || none) {
        this.moveTo(hole);
        return;
      }
      // Travelling already: only the destination changes. At rest: the hole is glued to the element (a scrolling list must not leave it behind).
      const travelling = !rests(l) || !rests(t) || !rests(r) || !rests(b);
      l.to = hole.x;
      t.to = hole.y;
      r.to = hole.x + hole.w;
      b.to = hole.y + hole.h;
      radius.to = hole.r;
      if (!travelling) {
        for (const s of [l, t, r, b, radius]) {
          s.x = s.to;
          s.v = 0;
        }
        paint();
      } else wake();
    },
    placeCard(x, y) {
      cardX.to = x;
      cardY.to = y;
      wake();
    },
    placeEcho(x, y, left) {
      echoX.to = x;
      echoY.to = y;
      facesLeft = left;
      parts.echo.dataset.face = left ? 'left' : 'right';
      wake();
    },
    snap() {
      for (const s of all) {
        s.x = s.to;
        s.v = 0;
      }
      wrote = '';
      paint();
    },
    open(ms) {
      dimming.to = 0;
      l.to = -40;
      t.to = -40;
      r.to = vw + 40;
      b.to = vh + 40;
      radius.to = 40;
      l.k = t.k = r.k = b.k = 90;
      wake();
      return new Promise((resolve) => window.setTimeout(resolve, still ? 0 : ms));
    },
    moving: () => !rests(echoX, 2) || !rests(echoY, 2),
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    },
  };
}

export const holeFor = (el: Element, pad: number) => {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const corner = parseFloat(style.borderTopLeftRadius) || 0;
  // A percentage or a pill: the hole takes the element's own shape.
  const radius = style.borderTopLeftRadius.endsWith('%') ? Math.min(rect.width, rect.height) / 2 : corner;
  return holeOf(rect, pad, Math.min(radius, Math.min(rect.width, rect.height) / 2), { w: window.innerWidth, h: window.innerHeight });
};

// ── Echo's small life ──
const POSE = Object.fromEntries(ECHO_SCHOLAR_SPRITE.poses.map((name, i) => [name, i])) as Record<string, number>;
const TAIL = Array.from({ length: 16 }, (_, i) => POSE[`tail${i}`]);
const SPRAY = Array.from({ length: 10 }, (_, i) => POSE[`spray${i}`]);

/** The sheet of real rendered poses: it blinks, its tail beats faster while it swims, and it is pleased when a step is done. One timer. */
export function createEchoLife(sprite: HTMLElement, isMoving: () => boolean, still: boolean) {
  const { cols, rows } = ECHO_SCHOLAR_SPRITE;
  let timer: number | null = null;
  let alive = true;
  let busy = 0;
  const show = (index: number) => {
    sprite.style.transform = `translate3d(${-(index % cols) * (100 / cols)}%, ${-Math.floor(index / cols) * (100 / rows)}%, 0)`;
  };
  const play = (frames: readonly number[], ms: number, done: () => void, at = 0) => {
    if (!alive) return;
    if (at >= frames.length) {
      show(POSE.neutral);
      done();
      return;
    }
    show(frames[at]);
    timer = window.setTimeout(() => play(frames, ms, done, at + 1), ms);
  };
  const next = () => {
    if (!alive) return;
    if (document.hidden) {
      timer = window.setTimeout(next, 900);
      return;
    }
    if (isMoving()) {
      play(TAIL, 42, next);
      return;
    }
    timer = window.setTimeout(() => {
      if (!alive) return;
      const roll = Math.random();
      if (isMoving() || roll < 0.42) play(TAIL, 78, next);
      else play([POSE.half, POSE.closed, POSE.half], 62, next);
    }, 900 + Math.random() * 1900);
  };
  show(POSE.neutral);
  if (!still) next();
  const interrupt = (frames: readonly number[], ms: number) => {
    if (still) return;
    if (timer !== null) window.clearTimeout(timer);
    const id = ++busy;
    play(frames, ms, () => {
      if (id === busy) next();
    });
  };
  return {
    happy: () => interrupt([POSE.happy, POSE.happy, POSE.happy, POSE.happy, POSE.happy], 110),
    spout: () => interrupt(SPRAY, 90),
    dispose() {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    },
  };
}

/** A few real bubbles (DOM, compositor only), gone when they have risen. Never decoration at rest. */
export function puff(layer: HTMLElement, x: number, y: number, count: number) {
  for (let i = 0; i < count; i++) {
    const bubble = document.createElement('i');
    const size = 4 + Math.random() * 7;
    bubble.style.cssText = `left:${x + (Math.random() - 0.5) * 28}px;top:${y}px;width:${size}px;height:${size}px;`;
    layer.appendChild(bubble);
    const rise = bubble.animate(
      [
        { transform: 'translate3d(0,0,0) scale(.6)', opacity: 0 },
        { transform: `translate3d(${(Math.random() - 0.5) * 16}px,-22px,0) scale(1)`, opacity: 0.85, offset: 0.25 },
        { transform: `translate3d(${(Math.random() - 0.5) * 30}px,-${60 + Math.random() * 40}px,0) scale(1.1)`, opacity: 0 },
      ],
      { duration: 900 + Math.random() * 500, delay: i * 90, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' },
    );
    rise.onfinish = () => bubble.remove();
    rise.oncancel = () => bubble.remove();
  }
}
