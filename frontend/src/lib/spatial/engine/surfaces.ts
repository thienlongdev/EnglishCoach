import type { SpatialBridge, SurfaceMotion, SurfaceSheen } from '../types';
import { plainText } from './typography';

/**
 * The DOM half of Echo Spatial. It finds the real panels of whatever page is on screen (no page is rewritten for this), hands their rects to
 * the scene, and gives compatible cards depth, light and motion. Rules, all enforced here:
 *  - nothing in the document flow changes: no margin, size or order; a moved card is a transform that returns to `none` at rest;
 *  - a panel with a field, a video, a canvas, a 3D face or a fixed child is never moved or lit (it still counts as a rect);
 *  - ONE owner per transform: an element something else already animates (a carousel, a drag, a flip, an entrance, a motion library) is never written to. `data-spatial-owner` declares it for a whole
 *    component; a transform at rest, a running animation or a foreign write to our own inline transform are detected. Such an element stays a rect for the scene, nothing else;
 *  - rects come from a cache plus one scroll read per frame, never a layout read per frame;
 *  - a press drops the transform at once, so a dialog opened by the click is positioned by the viewport.
 */

export interface SurfaceConfig {
  motion: SurfaceMotion;
  sheen: SurfaceSheen;
  glass: boolean;
  spotlight: boolean;
  /** play = depth, light and motion; still = rim only; off = untouched. */
  level: 'play' | 'still' | 'off';
  reduced: boolean;
  pointer: number;
  depth: number;
  material: number;
}

interface Surface {
  el: HTMLElement;
  /** In the scroller's content coordinates (`fixed`: in viewport coordinates). */
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  fixed: boolean;
  movable: boolean;
  lit: boolean;
  /** Spring state: rotation, translation, depth, each with its velocity. */
  rx: number; ry: number; tx: number; ty: number; tz: number;
  vrx: number; vry: number; vtx: number; vty: number; vtz: number;
  hover: number;
  pressed: boolean;
  dirty: boolean;
  seed: number;
  savedTransition: string | null;
  glassed: boolean;
  savedBg: string | null;
  savedBlur: string | null;
  /** Last inline transform written here: anything else found there means another system owns this element. */
  wrote: string;
  foreign: boolean;
  /** Counts for the scene's knowledge of the page but draws no slab: its box is not its shape (a turned carousel card). */
  ghost: boolean;
  /** Lives inside a small nested scroller (a transcript list): its rect is not what is on screen, so the scene never hears of it. */
  clipped: boolean;
}

const HAZARD = 'iframe,video,audio,canvas,textarea,select,input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]),[contenteditable="true"],[data-spatial-exclude],[draggable="true"],[role="dialog"],[aria-modal="true"],.fixed';
const NEVER_ENTER = 'iframe,video,audio,canvas,svg,textarea,select,input,button:empty,[data-spatial-exclude],[role="dialog"],[aria-modal="true"]';
const PANEL_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'LI', 'A', 'BUTTON', 'ASIDE', 'FIGURE', 'HEADER', 'FOOTER', 'FORM', 'NAV', 'UL', 'OL', 'MAIN', 'LABEL', 'DETAILS']);
const MAX_VISITS = 2600;
const MAX_MOVING = 18;
const RECT_CAPACITY = 40;

/** Something other than this engine moves this element right now, or holds it away from its layout position. */
function ownsItsTransform(el: HTMLElement, cs: CSSStyleDeclaration): boolean {
  if (cs.transform !== 'none' || cs.translate !== 'none' || cs.rotate !== 'none' || cs.scale !== 'none') return true;
  return el.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== 0);
}

function parseAlpha(color: string): number {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return color === 'transparent' ? 0 : 1;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length >= 4 ? parseFloat(parts[3]) : 1;
}

export class SurfaceField {
  private surfaces: Surface[] = [];
  private byEl = new WeakMap<Element, Surface>();
  private hovered: Surface | null = null;
  private observer: MutationObserver;
  private resize: ResizeObserver;
  private scanTimer = 0;
  private idle = 0;
  private refreshClock = 0;
  private scrollTop = 0;
  private lastScrollTop = 0;
  private scrollPeak = 0;
  private viewportW = 1;
  private viewportH = 1;
  private scrollerTop = 0;
  private scrollerLeft = 0;
  private pointerX = -9999;
  private pointerY = -9999;
  private pointerMoved = false;
  private dialogOpen = false;
  private time = 0;
  private disposed = false;

  constructor(
    private root: HTMLElement,
    private scroller: HTMLElement,
    private bridge: SpatialBridge,
    private config: SurfaceConfig,
    private shell: () => HTMLElement[] = () => [],
  ) {
    this.observer = new MutationObserver(() => this.requestScan());
    this.observer.observe(root, { childList: true, subtree: true });
    this.resize = new ResizeObserver(() => this.requestScan());
    this.resize.observe(scroller);
    if (scroller.firstElementChild) this.resize.observe(scroller.firstElementChild);
    document.addEventListener('pointerover', this.onOver, { passive: true, capture: true });
    document.addEventListener('pointerdown', this.onDown, { passive: true, capture: true });
    document.addEventListener('pointerup', this.onUp, { passive: true, capture: true });
    window.addEventListener('pointermove', this.onMove, { passive: true, capture: true });
    this.requestScan(0);
  }

  setConfig(next: SurfaceConfig): void {
    const changed = next.level !== this.config.level || next.sheen !== this.config.sheen || next.motion !== this.config.motion || next.glass !== this.config.glass || next.spotlight !== this.config.spotlight || next.reduced !== this.config.reduced;
    this.config = next;
    if (changed) {
      this.releaseAll();
      this.requestScan(0);
    }
  }

  requestScan(delay = 260): void {
    if (this.disposed) return;
    window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => {
      const run = () => {
        if (!this.disposed) this.scan();
      };
      const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) this.idle = ric(run, { timeout: 400 });
      else run();
    }, delay);
  }

  /** The theme changed: every saved computed colour is stale. */
  resetColours(): void {
    for (const s of this.surfaces) this.unglass(s);
    this.requestScan(30);
  }

  private onOver = (event: Event) => {
    const target = event.target as Element | null;
    const el = target?.closest?.('[data-sp-surface],[data-sp-owned]');
    const next = el ? this.byEl.get(el) ?? null : null;
    if (next === this.hovered) return;
    if (this.hovered) this.hovered.pressed = false;
    this.hovered = next;
    if (next) this.prepareMotion(next);
  };

  private onMove = (event: PointerEvent) => {
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.pointerMoved = true;
  };

  private onDown = (event: Event) => {
    const target = event.target as Element | null;
    const el = target?.closest?.('[data-sp-surface]');
    const s = el ? this.byEl.get(el) : null;
    if (!s) return;
    s.pressed = true;
    // Clear now, not at the next frame: what this press opens must not be positioned by a transformed ancestor.
    this.write(s, true);
  };

  private onUp = () => {
    if (this.hovered) this.hovered.pressed = this.hovered.pressed && false;
  };

  private prepareMotion(s: Surface): void {
    if (!s.movable) return;
    if (s.el.querySelector('[role="dialog"],[aria-modal="true"],.fixed')) s.movable = false;
  }

  private isHazard(el: HTMLElement): boolean {
    if (el.querySelector(HAZARD)) return true;
    const all = el.getElementsByTagName('*');
    if (all.length > 260) return true;
    for (let i = 0; i < all.length; i++) {
      const cs = getComputedStyle(all[i]);
      if (cs.position === 'fixed' || cs.transformStyle === 'preserve-3d') return true;
    }
    return false;
  }

  /** Walks the page once (idle time), bounded. Keeps the springs of surfaces it finds again. */
  private scan(): void {
    const seen = new Set<Surface>();
    const rootBox = this.scroller.getBoundingClientRect();
    this.scrollerTop = rootBox.top;
    this.scrollerLeft = rootBox.left;
    this.viewportW = window.innerWidth;
    this.viewportH = window.innerHeight;
    const scrollTop = this.scroller.scrollTop;
    this.dialogOpen = this.foreignDialog();
    const area = this.viewportW * this.viewportH;
    let visits = 0;

    const register = (el: HTMLElement, box: DOMRect, cs: CSSStyleDeclaration, movable: boolean, lit: boolean, fixed: boolean, ghost = false, clipped = false) => {
      let s = this.byEl.get(el);
      if (!s) {
        s = {
          el, x: 0, y: 0, w: 0, h: 0, radius: 12, fixed, movable: false, lit: false,
          rx: 0, ry: 0, tx: 0, ty: 0, tz: 0, vrx: 0, vry: 0, vtx: 0, vty: 0, vtz: 0,
          hover: 0, pressed: false, dirty: false, seed: Math.random() * 100,
          savedTransition: null, glassed: false, savedBg: null, savedBlur: null, wrote: '', foreign: false, ghost, clipped,
        };
        this.byEl.set(el, s);
        this.surfaces.push(s);
      }
      s.fixed = fixed;
      s.ghost = ghost;
      s.clipped = clipped;
      if (ghost) el.setAttribute('data-sp-owned', '');
      else el.removeAttribute('data-sp-owned');
      s.x = box.left - (fixed ? 0 : rootBox.left);
      s.y = box.top - (fixed ? 0 : rootBox.top) + (fixed ? 0 : scrollTop);
      s.w = box.width;
      s.h = box.height;
      s.radius = parseFloat(cs.borderTopLeftRadius) || 0;
      const level = this.config.level;
      s.movable = movable && !s.foreign && level === 'play' && !this.config.reduced && this.config.motion !== 'none';
      s.lit = lit && level !== 'off';
      if (!s.lit) el.removeAttribute('data-sp-surface');
      else {
        el.setAttribute('data-sp-surface', level === 'play' ? 'play' : 'still');
        const afterFree = getComputedStyle(el, '::after').content === 'none';
        if (level === 'play' && this.config.sheen !== 'none' && afterFree && !this.config.reduced) {
          el.setAttribute('data-sp-sheen', this.config.sheen);
          if (cs.position === 'static') el.setAttribute('data-sp-rel', '');
        } else {
          el.removeAttribute('data-sp-sheen');
        }
      }
      if (this.config.glass && level === 'play' && lit && !this.config.reduced) this.glass(s, cs);
      else this.unglass(s);
      seen.add(s);
    };

    const visit = (el: HTMLElement, owned: boolean, clipped = false) => {
      if (visits++ > MAX_VISITS) return;
      if (!PANEL_TAGS.has(el.tagName)) return;
      if (el.matches(NEVER_ENTER)) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w < 40 || h < 28) return;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return;
      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      const fill = parseAlpha(cs.backgroundColor) > 0.2 || cs.backgroundImage !== 'none';
      const edged = parseFloat(cs.borderTopWidth) > 0 || cs.boxShadow !== 'none';
      const isPanel = radius >= 6 && (fill || edged) && w >= 110 && h >= 52 && el !== this.scroller;
      const ownedHere = owned || el.hasAttribute('data-spatial-owner');
      if (isPanel && ownedHere) {
        // A component with its own motion: known to the scene, untouched by anything here.
        register(el, el.getBoundingClientRect(), cs, false, false, false, true, clipped);
        return;
      }
      if (isPanel) {
        const fits = w <= 880 && h <= 640 && w * h < area * 0.5;
        const known = this.byEl.get(el);
        const ours = !!known?.dirty; // the transform found on a card this engine is moving is its own
        const safe = fits && cs.position !== 'sticky' && cs.transformStyle !== 'preserve-3d' && !this.isHazard(el);
        const hasOwnTransform = !ours && ownsItsTransform(el, cs);
        if (fits) {
          const box = el.getBoundingClientRect();
          register(el, box, cs, safe && !hasOwnTransform, safe, false, false, clipped);
          return; // a card is one object: what is inside it is part of it
        }
        // Too big to be an object (a whole panel): counts for the scene; its children may be objects.
        const box = el.getBoundingClientRect();
        register(el, box, cs, false, !this.isBigHazard(el), false, false, clipped);
      }
      // A small scroller clips its rows: a row scrolled out of it would otherwise be drawn as an empty slab under or over the panel. A page-sized scroller (a module's own main) clips nothing that matters.
      const scrollsRows = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.clientHeight < this.scroller.clientHeight * 0.9 && el.scrollHeight > el.clientHeight + 4;
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) visit(c as HTMLElement, ownedHere, clipped || scrollsRows);
    };
    for (let c = this.root.firstElementChild; c; c = c.nextElementSibling) visit(c as HTMLElement, false);

    for (const el of this.shell()) {
      const box = el.getBoundingClientRect();
      if (box.width > 0) register(el, box, getComputedStyle(el), false, false, true);
    }

    this.surfaces = this.surfaces.filter((s) => {
      if (seen.has(s) && s.el.isConnected) return true;
      this.release(s);
      if (this.hovered === s) this.hovered = null;
      this.byEl.delete(s.el);
      return false;
    });
    this.bridge.words = this.collectWords();
  }

  /** A modal over this root (the studio's own dialog contains its sample page, so it does not count). */
  private foreignDialog(): boolean {
    for (const dialog of Array.from(document.querySelectorAll('[aria-modal="true"]'))) {
      if (!dialog.contains(this.root)) return true;
    }
    return false;
  }

  private isBigHazard(el: HTMLElement): boolean {
    // A big panel may hold a reader or an editor: it keeps its rim only when it has nothing to protect.
    return !!el.querySelector('iframe,video,textarea,[contenteditable="true"]');
  }

  private collectWords(): string[] {
    const out: string[] = [];
    this.root.querySelectorAll('h1,h2').forEach((h) => {
      if (out.length >= 14) return;
      plainText(h).split(/\s+/).forEach((word) => {
        const clean = word.replace(/[^\p{L}\p{N}]/gu, '');
        if (clean.length >= 3 && clean.length <= 14 && out.length < 14) out.push(clean);
      });
    });
    return out;
  }

  private glass(s: Surface, cs: CSSStyleDeclaration): void {
    if (s.glassed) return;
    if (cs.backgroundImage !== 'none') return; // a painted panel keeps its painting
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) return;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    if ((parts[3] ?? 1) < 0.5) return;
    s.savedBg = s.el.style.backgroundColor;
    s.savedBlur = s.el.style.backdropFilter;
    const alpha = 0.86 - 0.16 * this.config.material;
    s.el.style.backgroundColor = `rgb(${parts[0]} ${parts[1]} ${parts[2]} / ${alpha.toFixed(3)})`;
    s.el.style.backdropFilter = `blur(${Math.round(10 + 10 * this.config.material)}px) saturate(1.25)`;
    s.glassed = true;
  }

  private unglass(s: Surface): void {
    if (!s.glassed) return;
    s.el.style.backgroundColor = s.savedBg ?? '';
    s.el.style.backdropFilter = s.savedBlur ?? '';
    s.glassed = false;
  }

  private write(s: Surface, clear = false): void {
    const el = s.el;
    if (clear) {
      s.rx = s.ry = s.tx = s.ty = s.tz = 0;
      s.vrx = s.vry = s.vtx = s.vty = s.vtz = 0;
    }
    // Someone else wrote to this element's transform since we last did: it is theirs from now on.
    if (s.dirty && el.style.transform !== s.wrote) {
      s.foreign = true;
      s.movable = false;
      s.dirty = false;
      s.rx = s.ry = s.tx = s.ty = s.tz = 0;
      s.vrx = s.vry = s.vtx = s.vty = s.vtz = 0;
      el.style.willChange = '';
      el.style.transition = s.savedTransition ?? '';
      s.savedTransition = null;
      return;
    }
    const rest = Math.abs(s.rx) + Math.abs(s.ry) + Math.abs(s.tx) + Math.abs(s.ty) + Math.abs(s.tz) < 0.02;
    if (rest) {
      if (s.dirty) {
        el.style.transform = '';
        el.style.willChange = '';
        el.style.transition = s.savedTransition ?? '';
        s.savedTransition = null;
        s.dirty = false;
      }
      return;
    }
    if (!s.dirty) {
      // The first write takes the element over: only from an empty inline transform.
      if (el.style.transform && el.style.transform !== 'none') {
        s.foreign = true;
        s.movable = false;
        return;
      }
      s.dirty = true;
      s.savedTransition = el.style.transition;
      // The page's own transition on `transform` would smooth every frame into a lag; colours keep theirs.
      const own = getComputedStyle(el);
      if (own.transitionProperty === 'all' || own.transitionProperty.includes('transform')) {
        el.style.transition = 'background-color .15s, border-color .15s, color .15s, opacity .15s, box-shadow .15s';
      }
      el.style.willChange = 'transform';
    }
    el.style.transform = `perspective(1000px) translate3d(${s.tx.toFixed(2)}px,${s.ty.toFixed(2)}px,${s.tz.toFixed(2)}px) rotateX(${s.rx.toFixed(3)}deg) rotateY(${s.ry.toFixed(3)}deg)`;
    s.wrote = el.style.transform;
  }

  private release(s: Surface): void {
    this.write(s, true);
    this.unglass(s);
    s.el.removeAttribute('data-sp-surface');
    s.el.removeAttribute('data-sp-sheen');
    s.el.removeAttribute('data-sp-rel');
    s.el.removeAttribute('data-sp-owned');
    s.el.removeAttribute('data-sp-dim');
    s.el.style.removeProperty('--sx');
    s.el.style.removeProperty('--sy');
    s.el.style.removeProperty('--sa');
  }

  private releaseAll(): void {
    for (const s of this.surfaces) {
      this.write(s, true);
    }
  }

  /** Once per display frame while the engine is on. Cached rects + one scroll read; DOM writes only for what moves. */
  update(dt: number): boolean {
    const b = this.bridge;
    const c = this.config;
    this.time += dt;
    const scrollTop = this.scroller.scrollTop;
    this.scrollTop = scrollTop;
    const delta = scrollTop - this.lastScrollTop;
    this.lastScrollTop = scrollTop;
    const velocity = dt > 0 ? delta / dt / Math.max(1, this.viewportH) : 0;
    b.scrollVelocity += (velocity - b.scrollVelocity) * Math.min(1, dt * 7);
    this.scrollPeak = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
    b.scrollTop = scrollTop;
    const target = this.scrollPeak > 4 ? scrollTop / this.scrollPeak : 0;
    b.scrollProgress += (target - b.scrollProgress) * Math.min(1, dt * 5);
    // Fast-moving nested scrollers and late layout: refresh the visible rects now and then.
    this.refreshClock += dt;
    if (this.refreshClock > 0.5) {
      this.refreshClock = 0;
      this.refreshVisible();
      this.dialogOpen = this.foreignDialog();
    }

    // Rects for the scene: on-screen, biggest first are the ones that matter when there are too many.
    let n = 0;
    const rects = b.rects;
    const meta = b.meta;
    const px = this.pointerX;
    const py = this.pointerY;
    let hoverAmount = 0;
    let hoverX = b.hoverX;
    let hoverY = b.hoverY;
    let moving = 0;
    const active = c.level === 'play' && !c.reduced && c.motion !== 'none' && !this.dialogOpen;
    let any = false;

    for (const s of this.surfaces) {
      const y = s.fixed ? s.y : s.y - scrollTop + this.scrollerTop;
      const x = s.fixed ? s.x : s.x + this.scrollerLeft;
      const onScreen = y < this.viewportH + 40 && y + s.h > -40;
      const isHover = s === this.hovered;
      s.hover += ((isHover ? 1 : 0) - s.hover) * Math.min(1, dt * (isHover ? 9 : 5));
      if (s.hover < 0.002) s.hover = 0;
      if (onScreen && !s.clipped && n < RECT_CAPACITY) {
        rects[n * 4] = x + s.tx;
        rects[n * 4 + 1] = y + s.ty;
        rects[n * 4 + 2] = s.w;
        rects[n * 4 + 3] = s.h;
        meta[n * 4] = s.radius;
        meta[n * 4 + 1] = s.hover;
        meta[n * 4 + 2] = Math.min(1, Math.abs(s.tz) / 40 + s.hover * 0.4);
        meta[n * 4 + 3] = s.ghost ? 2 : s.fixed ? 1 : 0;
        n += 1;
      }
      if (s.hover > hoverAmount) {
        hoverAmount = s.hover;
        hoverX = x + s.w / 2;
        hoverY = y + s.h / 2;
      }
      // Pointer light on the card's surface (a CSS custom property, no layout).
      if (s.lit && onScreen && c.level === 'play' && !c.reduced && c.sheen !== 'none' && this.pointerMoved) {
        const near = px > x - 160 && px < x + s.w + 160 && py > y - 160 && py < y + s.h + 160;
        if (near) {
          s.el.style.setProperty('--sx', `${(((px - x) / s.w) * 100).toFixed(1)}%`);
          s.el.style.setProperty('--sy', `${(((py - y) / s.h) * 100).toFixed(1)}%`);
          const dx = Math.max(x - px, 0, px - x - s.w);
          const dy = Math.max(y - py, 0, py - y - s.h);
          const a = Math.max(0, 1 - Math.hypot(dx, dy) / 160);
          s.el.style.setProperty('--sa', a.toFixed(3));
        } else if (s.el.style.getPropertyValue('--sa')) {
          s.el.style.setProperty('--sa', '0');
        }
      }
      if (!s.movable) {
        if (s.dirty) this.write(s, true);
        continue;
      }
      if (!active || !onScreen || s.pressed) {
        if (s.dirty) this.settle(s, dt);
        continue;
      }
      any = this.drive(s, x, y, dt, isHover, moving) || any;
      if (s.dirty) moving += 1;
    }
    b.count = n;
    b.hoverX = hoverX;
    b.hoverY = hoverY;
    b.hoverAmount = hoverAmount;
    this.pointerMoved = false;

    // Spotlight: everything but the card under the pointer steps back.
    if (c.spotlight && c.level === 'play') {
      const someone = !!this.hovered;
      for (const s of this.surfaces) {
        if (!s.lit) continue;
        const dim = someone && s !== this.hovered;
        if (dim) {
          if (!s.el.hasAttribute('data-sp-dim')) s.el.setAttribute('data-sp-dim', '');
        } else if (s.el.hasAttribute('data-sp-dim')) s.el.removeAttribute('data-sp-dim');
      }
    }
    return any || Math.abs(b.scrollVelocity) > 0.001;
  }

  private settle(s: Surface, dt: number): void {
    this.spring(s, 0, 0, 0, 0, 0, dt, 90, 16);
    this.write(s);
  }

  private spring(s: Surface, rx: number, ry: number, tx: number, ty: number, tz: number, dt: number, k: number, damp: number): void {
    s.vrx += ((rx - s.rx) * k - s.vrx * damp) * dt;
    s.vry += ((ry - s.ry) * k - s.vry * damp) * dt;
    s.vtx += ((tx - s.tx) * k - s.vtx * damp) * dt;
    s.vty += ((ty - s.ty) * k - s.vty * damp) * dt;
    s.vtz += ((tz - s.tz) * k - s.vtz * damp) * dt;
    s.rx += s.vrx * dt;
    s.ry += s.vry * dt;
    s.tx += s.vtx * dt;
    s.ty += s.vty * dt;
    s.tz += s.vtz * dt;
  }

  /** Returns true while something still moves. Each motion is a target for the same damped spring: frame-rate independent. */
  private drive(s: Surface, x: number, y: number, dt: number, isHover: boolean, moving: number): boolean {
    const c = this.config;
    const depth = c.depth;
    const pointer = c.pointer;
    let rx = 0;
    let ry = 0;
    let tx = 0;
    let ty = 0;
    let tz = 0;
    let k = 150;
    let damp = 18;
    switch (c.motion) {
      case 'tilt':
      case 'press': {
        if (isHover) {
          const nx = (this.pointerX - x) / s.w - 0.5;
          const ny = (this.pointerY - y) / s.h - 0.5;
          const amount = c.motion === 'tilt' ? 7 : 2.4;
          // Big cards lean less: the far edge must not travel further than a small card's.
          const scale = Math.min(1, 320 / Math.max(s.w, s.h)) * (0.4 + depth * 0.9) * (0.3 + pointer * 0.8);
          ry = nx * amount * 2 * scale;
          rx = -ny * amount * 2 * scale;
          tz = (c.motion === 'tilt' ? 26 : 8) * (0.4 + depth);
        }
        break;
      }
      case 'float': {
        if (moving >= MAX_MOVING) break;
        const t = this.time;
        const v = this.bridge.scrollVelocity;
        ty = Math.sin(t * 0.7 + s.seed) * 4 * depth - Math.max(-1, Math.min(1, v)) * (18 + (s.seed % 10) * 2) * depth;
        rx = Math.sin(t * 0.5 + s.seed * 2) * 0.5 * depth + v * 3 * depth;
        ry = Math.cos(t * 0.4 + s.seed) * 0.7 * depth;
        tz = isHover ? 22 * (0.4 + depth) : 0;
        k = 34;
        damp = 8;
        break;
      }
      case 'magnet': {
        const cx = x + s.w / 2;
        const cy = y + s.h / 2;
        const dx = this.pointerX - cx;
        const dy = this.pointerY - cy;
        const reach = Math.max(s.w, s.h) * 0.5 + 170;
        const d = Math.hypot(dx, dy);
        if (d < reach) {
          const f = (1 - d / reach) ** 2 * (0.3 + pointer) * (0.4 + depth);
          tx = (dx / Math.max(1, d)) * 26 * f;
          ty = (dy / Math.max(1, d)) * 26 * f;
          tz = 18 * f;
          ry = (dx / Math.max(1, reach)) * 7 * f;
          rx = -(dy / Math.max(1, reach)) * 7 * f;
        }
        k = 90;
        damp = 13;
        break;
      }
      case 'skew': {
        const v = Math.max(-1.4, Math.min(1.4, this.bridge.scrollVelocity));
        const side = (x + s.w / 2) / Math.max(1, this.viewportW) - 0.5;
        rx = v * 7 * (0.4 + depth);
        ry = v * side * -10 * depth;
        tz = -Math.abs(v) * 30 * depth + (isHover ? 16 * (0.4 + depth) : 0);
        k = 110;
        damp = 15;
        break;
      }
      default:
        break;
    }
    this.spring(s, rx, ry, tx, ty, tz, dt, k, damp);
    this.write(s);
    return s.dirty;
  }

  private refreshVisible(): void {
    const rootBox = this.scroller.getBoundingClientRect();
    this.scrollerTop = rootBox.top;
    this.scrollerLeft = rootBox.left;
    this.viewportW = window.innerWidth;
    this.viewportH = window.innerHeight;
    const scrollTop = this.scroller.scrollTop;
    for (const s of this.surfaces) {
      if (s.dirty) continue; // a moved card reports its transform: it is measured again when it rests
      const y = s.fixed ? s.y : s.y - scrollTop + this.scrollerTop;
      if (y > this.viewportH + 200 || y + s.h < -200) continue;
      const box = s.el.getBoundingClientRect();
      if (box.width === 0) continue;
      s.x = box.left - (s.fixed ? 0 : rootBox.left);
      s.y = box.top - (s.fixed ? 0 : rootBox.top) + (s.fixed ? 0 : scrollTop);
      s.w = box.width;
      s.h = box.height;
    }
  }

  /** Candidates for the gallery room: the page's own linked / clickable cards. */
  galleryItems(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const s of this.surfaces) {
      if (s.fixed || (!s.lit && !s.ghost)) continue;
      if (s.w > 700 || s.h > 560) continue;
      const clickable = s.el.matches('a[href],button,[role="button"],[role="link"]') ? s.el : (s.el.querySelector('a[href],button:not([aria-haspopup]),[role="button"]') as HTMLElement | null);
      if (!clickable) continue;
      out.push(s.el);
    }
    return out;
  }

  get stats() {
    return {
      total: this.surfaces.length,
      moving: this.surfaces.filter((s) => s.dirty).length,
      lit: this.surfaces.filter((s) => s.lit).length,
      movable: this.surfaces.filter((s) => s.movable).length,
    };
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.scanTimer);
    const cic = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
    if (this.idle && cic) cic(this.idle);
    this.observer.disconnect();
    this.resize.disconnect();
    document.removeEventListener('pointerover', this.onOver, { capture: true } as EventListenerOptions);
    document.removeEventListener('pointerdown', this.onDown, { capture: true } as EventListenerOptions);
    document.removeEventListener('pointerup', this.onUp, { capture: true } as EventListenerOptions);
    window.removeEventListener('pointermove', this.onMove, { capture: true } as EventListenerOptions);
    for (const s of this.surfaces) this.release(s);
    this.surfaces = [];
    this.bridge.count = 0;
    this.bridge.hoverAmount = 0;
  }
}
