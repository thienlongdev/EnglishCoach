import './morph.css';
import { MORPH_EASE, MORPH_ID, MORPH_MS, morphReduced } from './tokens';
import { MorphLevel, morphLevel, routeDepth, routeKey, sameWorkspace } from './rules';
import { spatialProfile } from '@/lib/spatial/context';
import { boxOf, cancelSurfaces, moveSurface, surfaceOwns } from './surface';
// Opt-in camera adapter; native scenes import the small adapter directly, keeping
// the DOM walker away from their owned canvases and the router free of delays.
export { ScenePassage, markWorldPassage, takeWorldPassage } from './scene';

/**
 * Echo Morph: one motion language for the whole workspace, on the pages as they are (10 §BN). Rules, all enforced here:
 *  - the router never waits, nothing is held, and nothing is hidden if this file never runs;
 *  - Web Animations with no fill: an interrupted or finished motion leaves no style behind. `translate` / `scale` individual properties only, never `transform`,
 *    and never on an element that already has its own (Tailwind's translate utilities use the same property);
 *  - one owner per motion: `data-spatial-owner`, `data-morph="off"`, a running animation or a 3D subtree are left alone (10 §BI);
 *  - Echo Cinematic Journey owns its passages; a Spatial preset with a full route transition owns the route entry; a running guide keeps the page still;
 *  - a press is read in the capture phase, before any handler: one layout read, then the page's own code runs untouched. Input, media and microphones are never touched.
 * What a future module gets without registering anything: card to destination, route passage, overlay entry and exit, tab glide, neighbours gliding, content settling in.
 * `data-morph-hero` names a destination, `data-morph-source` names a card, `data-morph="off"` opts a subtree out.
 */

interface Press {
  target: Element;
  card: HTMLElement | null;
  rect: DOMRect | null;
  radius: number;
  fill: string;
  picture: string | null;
  x: number;
  y: number;
  at: number;
  zone: 'shell' | 'content' | 'overlay';
  href: string | null;
  match: SourceMatch | null;
  snapshot: Map<HTMLElement, Box> | null;
  scrollTop: number;
  active: { el: Element; box: DOMRect; radius: string } | null;
  back: boolean;
  routeAtPress: string;
  viewChecked?: boolean;
}
interface Box { x: number; y: number; w: number; h: number }
interface SourceMatch { href: string | null; id: string | null; text: string }
interface StackEntry { from: string; to: string; kind: 'route' | 'view'; match: SourceMatch; picture: string | null; radius: number; fill: string; dest: Box | null }

const ACTION = 'a[href],button,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[role="checkbox"],[role="radio"],[data-morph-source]';
const FIELD = 'input,textarea,select,[contenteditable="true"]';
const OVERLAY = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[aria-modal="true"],[data-morph-overlay]';
const NO_PRESS = '[data-morph="off"],[data-journey-host],[data-guide-layer],[data-morph-ghost],canvas,iframe,video,.ec-morph-layer';
/** Never written on. A press inside `data-spatial-owner` may still launch a flight: the flight writes only on its own layers. */
const NOT_MINE = `${NO_PRESS},[data-spatial-owner],[data-morph-presence]`;
const HEAVY = 'iframe,video,canvas,audio';
const PANEL_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'LI', 'A', 'BUTTON', 'FORM', 'UL', 'OL', 'TABLE', 'TR', 'ASIDE', 'HEADER', 'NAV', 'FIGURE', 'DETAILS', 'MAIN']);
const BACK_WORDS = /^(←\s*)?(quay lại|trở lại|về|back|return|close|đóng)\b/i;
const WINDOW_MS = 900;
const ARRIVAL_WINDOW_MS = 1400;
const MAX_REVEALS = 6;
const MAX_SNAPSHOT = 170;

function workspaceColumn(): HTMLElement | null {
  return document.querySelector<HTMLElement>('main[data-app-scroll]');
}

function isOnScreen(r: { top: number; bottom: number; left: number; right: number }): boolean {
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

/** Moving this element with `translate` would fight something already there. */
function ownMotion(el: Element, cs: CSSStyleDeclaration): boolean {
  if (cs.translate !== 'none' || cs.scale !== 'none' || cs.rotate !== 'none') return true;
  if (cs.transform !== 'none' || cs.transformStyle === 'preserve-3d' || cs.position === 'fixed' || cs.position === 'sticky') return true;
  return el.getAnimations().some((a) => a.playState === 'running');
}

export class MorphEngine {
  private press: Press | null = null;
  private level: MorphLevel = 'off';
  private key = '';
  private pathname = '';
  private search: URLSearchParams | null = null;
  private traversal = 0;
  private stack: StackEntry[] = [];
  private running = new Set<Animation>();
  private revealedAt = 0;
  private revealCount = 0;
  private revealed = new WeakSet<Element>();
  private windowUntil = 0;
  private lastRouteAt = 0;
  private overlayFrom = new WeakMap<Element, { x: number; y: number }>();
  private observer: MutationObserver;
  private lastFilter = 0;
  private addedPanels: HTMLElement[] = [];
  private weak: boolean;
  private busyTimer = 0;
  private generation = 0;
  log: { k: string; at: number; to?: string }[] = [];

  constructor() {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
    this.weak = !!nav.connection?.saveData || (nav.hardwareConcurrency || 8) <= 2 || (nav.deviceMemory || 8) <= 2;
    document.addEventListener('click', this.onClick, { capture: true, passive: true });
    document.addEventListener('change', this.onChange, { capture: true, passive: true });
    document.addEventListener('input', this.onInput, { capture: true, passive: true });
    window.addEventListener('popstate', this.onPop, { capture: true, passive: true });
    this.observer = new MutationObserver(this.onMutations);
    this.observer.observe(document.body, { childList: true, subtree: true });
    document.documentElement.setAttribute('data-morph-ready', '');
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.clearFloating(); });
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => this.clearFloating());
    (window as Window & { __ecMorph?: { log: MorphEngine['log'] } }).__ecMorph = { log: this.log };
  }

  private note(k: string, to?: string): void {
    this.log.push({ k, at: Math.round(performance.now()), to });
    if (this.log.length > 80) this.log.shift();
  }

  private journeying(): boolean {
    return !!document.documentElement.dataset.journey;
  }

  private guiding(): boolean {
    return !!document.documentElement.dataset.guideActive;
  }

  /** While something settles a guide or a test can wait for the page: a bounded attribute, never left behind. */
  private busy(ms: number): void {
    document.documentElement.setAttribute('data-morph-busy', '');
    window.clearTimeout(this.busyTimer);
    this.busyTimer = window.setTimeout(() => document.documentElement.removeAttribute('data-morph-busy'), ms);
  }

  private animate(el: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Animation {
    const anim = el.animate(frames, { fill: 'none', id: MORPH_ID, ...options });
    this.running.add(anim);
    const done = () => this.running.delete(anim);
    anim.finished.then(done, done);
    return anim;
  }

  private spatialOwnsRoute(): boolean {
    if (!document.documentElement.hasAttribute('data-spatial')) return false;
    return spatialProfile(this.pathname, this.search).transition === 'full';
  }

  // ─── Press ───────────────────────────────────────────────────────────────────────────

  private onPop = () => {
    this.traversal = performance.now();
  };

  private findCard(target: Element): HTMLElement | null {
    const named = target.closest<HTMLElement>('[data-morph-source]');
    if (named) return named;
    const area = window.innerWidth * window.innerHeight;
    let el: HTMLElement | null = target as HTMLElement;
    for (let i = 0; el && i < 7; i++, el = el.parentElement) {
      if (el.tagName === 'MAIN' || el.tagName === 'BODY') return null;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > area * 0.45) return null;
      if (r.width < 110 || r.height < 56) continue;
      const cs = getComputedStyle(el);
      const painted = cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' || parseFloat(cs.borderTopWidth) > 0 || !/rgba?\(\s*\d+[, ]+\d+[, ]+\d+[, /]+0\s*\)|transparent/.test(cs.backgroundColor);
      if (painted && parseFloat(cs.borderTopLeftRadius) >= 6) return el;
    }
    return null;
  }

  private pictureOf(card: HTMLElement): string | null {
    const cardBox = card.getBoundingClientRect();
    let best: string | null = null;
    let bestArea = cardBox.width * cardBox.height * 0.16;
    card.querySelectorAll('img').forEach((img) => {
      const r = img.getBoundingClientRect();
      if (r.width * r.height > bestArea && img.currentSrc) {
        bestArea = r.width * r.height;
        best = img.currentSrc;
      }
    });
    return best;
  }

  private matchOf(card: HTMLElement | null, target: Element): SourceMatch | null {
    const holder = card ?? (target as HTMLElement);
    const anchor = (target.closest('a[href]') ?? holder.querySelector('a[href]')) as HTMLAnchorElement | null;
    const text = (holder.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return { href: anchor?.getAttribute('href') ?? null, id: holder.getAttribute('data-morph-source') || null, text };
  }

  private onClick = (event: Event) => {
    if (this.level === 'off') return;
    const e = event as MouseEvent;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const raw = e.target as Element | null;
    if (!raw?.closest || this.journeying()) return;
    const target = raw.closest(ACTION);
    if (!target || target.closest(NO_PRESS) || target.matches(FIELD)) {
      this.press = null;
      return;
    }
    const zone: Press['zone'] = target.closest('[data-sp-shell]') ? 'shell' : target.closest(OVERLAY) ? 'overlay' : 'content';
    const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
    const href = anchor && anchor.origin === location.origin && !anchor.target && !anchor.hasAttribute('download') ? anchor.getAttribute('href') : null;
    const card = zone === 'content' ? this.findCard(target) : null;
    const box = (card ?? target).getBoundingClientRect();
    const cs = card ? getComputedStyle(card) : null;
    const fill = cs ? (cs.backgroundColor && !/, 0\)$/.test(cs.backgroundColor) ? cs.backgroundColor : '') : '';
    const scroller = workspaceColumn();
    const label = (target.getAttribute('aria-label') || target.textContent || '').trim();
    const press: Press = {
      target, card, rect: box, radius: cs ? parseFloat(cs.borderTopLeftRadius) || 16 : 12, fill,
      picture: null,
      x: e.clientX || box.left + box.width / 2, y: e.clientY || box.top + box.height / 2, at: performance.now(),
      zone, href, match: this.matchOf(card, target), snapshot: null, scrollTop: scroller?.scrollTop ?? 0,
      active: null, back: BACK_WORDS.test(label), routeAtPress: this.key,
    };
    if (!morphReduced() && !this.weak && !this.guiding() && this.level !== 'still') {
      if (this.level === 'full' && zone === 'content') press.snapshot = this.takeSnapshot();
      if (zone === 'content') press.active = this.activeSibling(target);
    }
    this.press = press;
    this.addedPanels = [];
    this.windowUntil = performance.now() + WINDOW_MS;
    this.revealCount = 0;
    this.revealedAt = 0;
    requestAnimationFrame(() => this.afterPress(press));
  };

  /** A `<select>` or a checkbox reports here, before React's own listener: same as a press with no card. */
  private onChange = (event: Event) => {
    const el = event.target as HTMLElement | null;
    if (!el?.closest || this.level !== 'full' || this.journeying() || el.closest(NOT_MINE) || !el.closest('main')) return;
    if (!el.matches('select,input[type="checkbox"],input[type="radio"]') || morphReduced() || this.weak || this.guiding()) return;
    this.beginSilentPress(el);
  };

  /** A search box that filters a list on screen. At most every 300 ms: typing itself is never touched. */
  private onInput = (event: Event) => {
    const el = event.target as HTMLInputElement | null;
    if (!el?.matches?.('input') || this.level !== 'full' || morphReduced() || this.weak || this.guiding()) return;
    if (!(el.type === 'search' || /tìm|search|lọc|filter/i.test(el.placeholder || ''))) return;
    const now = performance.now();
    if (now - this.lastFilter < 300 || !el.closest('main')) return;
    this.lastFilter = now;
    this.beginSilentPress(el);
  };

  private beginSilentPress(el: Element): void {
    const box = el.getBoundingClientRect();
    const press: Press = {
      target: el, card: null, rect: box, radius: 0, fill: '', picture: null,
      x: box.x, y: box.y, at: performance.now(), zone: 'content',
      href: null, match: null, snapshot: this.takeSnapshot(), scrollTop: workspaceColumn()?.scrollTop ?? 0, active: null, back: false, routeAtPress: this.key,
    };
    this.press = press;
    this.windowUntil = performance.now() + WINDOW_MS;
    this.revealCount = 0;
    this.revealedAt = 0;
    requestAnimationFrame(() => this.afterPress(press));
    window.setTimeout(() => this.afterPress(press), 140);
  }

  /** Rects of what is on screen in the content column, before the page's handler runs. Bounded. */
  private takeSnapshot(): Map<HTMLElement, Box> | null {
    const root = workspaceColumn();
    if (!root) return null;
    const out = new Map<HTMLElement, Box>();
    let visits = 0;
    const visit = (el: HTMLElement, depth: number) => {
      if (visits++ > 700 || out.size >= MAX_SNAPSHOT || depth > 11) return;
      if (!PANEL_TAGS.has(el.tagName) || el.matches(NOT_MINE) || el.offsetParent === null) return;
      const r = el.getBoundingClientRect();
      if (r.bottom < -80 || r.top > window.innerHeight + 80) return;
      if (r.width >= 44 && r.height >= 22 && el !== root) out.set(el, { x: r.left, y: r.top, w: r.width, h: r.height });
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) visit(c as HTMLElement, depth + 1);
    };
    visit(root, 0);
    return out;
  }

  /** The tab currently selected in the group of the pressed control. */
  private activeSibling(target: Element): Press['active'] {
    const group = target.closest('[role="tablist"],[aria-label],nav,ul');
    const isTab = target.matches('[role="tab"]') || target.hasAttribute('aria-selected') || target.hasAttribute('aria-pressed') || !!target.closest('[role="tablist"]');
    if (!group || !isTab) return null;
    const el = group.querySelector('[aria-selected="true"],[aria-current="page"],[aria-current="true"],[aria-pressed="true"]');
    if (!el || el === target) return null;
    return { el, box: el.getBoundingClientRect(), radius: getComputedStyle(el).borderRadius };
  }

  /** The frame after a press: the page's handler has run. What moved glides, the chosen tab receives the light, a card that left means a view opened. */
  private afterPress(press: Press): void {
    if (press !== this.press) return;
    if (press.active) {
      const to = press.target.getBoundingClientRect();
      if (press.target.getAttribute('aria-selected') === 'true' || press.target.getAttribute('aria-pressed') === 'true' || press.target.getAttribute('aria-current')) this.glide(press.active, { el: press.target, box: to, radius: press.active.radius });
      press.active = null;
    }
    if (press.snapshot) {
      this.flip(press);
      press.snapshot = null;
    }
    if (press.card) {
      window.setTimeout(() => this.checkViewChange(press), 60);
      window.setTimeout(() => this.checkViewChange(press), 220); // a view may arrive a little later than the press
    }
    if (press.back && this.stack.length && this.stack[this.stack.length - 1].kind === 'view') window.setTimeout(() => this.checkViewReturn(press), 60);
  }

  private flip(press: Press): void {
    const before = press.snapshot;
    if (!before) return;
    const scrolled = (workspaceColumn()?.scrollTop ?? 0) - press.scrollTop;
    const applied = new Map<Element, { dx: number; dy: number }>();
    const plans: { el: HTMLElement; from: Box }[] = [];
    let moved = 0;
    for (const [el, a] of before) {
      if (!el.isConnected || moved > 60) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      let dx = a.x - b.left;
      let dy = a.y - b.top - scrolled;
      for (let p = el.parentElement, i = 0; p && i < 12; p = p.parentElement, i++) {
        const up = applied.get(p);
        if (up) {
          dx -= up.dx;
          dy -= up.dy;
          break;
        }
      }
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) continue;
      if (Math.abs(dx) > window.innerWidth || Math.abs(dy) > window.innerHeight) continue;
      const cs = getComputedStyle(el);
      if ((!surfaceOwns(el) && ownMotion(el, cs)) || el.querySelector(HEAVY) || el.closest('[data-morph-presence]')) continue;
      applied.set(el, { dx, dy });
      plans.push({ el, from: { x: b.x + dx, y: b.y + dy, w: b.width, h: b.height } });
      moved += 1;
    }
    for (const { el, from } of plans) moveSurface(el, from, 'control');
    if (moved) this.note('flip');
  }

  private glide(old: { box: DOMRect; radius: string }, active: { el: Element; box: DOMRect; radius: string }): void {
    if (morphReduced() || !(active.el instanceof HTMLElement)) return;
    const el = active.el;
    if (el.closest(NOT_MINE) || ownMotion(el, getComputedStyle(el))) return;
    // The selected control is the moving surface; no viewport-sized decorative highlight.
    const r = active.box;
    moveSurface(el, { x: r.x + Math.max(-16, Math.min(16, old.box.x - r.x)), y: r.y, w: r.width * .97, h: r.height }, 'control');
  }

  // ─── Route ───────────────────────────────────────────────────────────────────────────

  /** Called from the host in the commit that changed the address (or the first time). */
  route(pathname: string, search: URLSearchParams | null, first = false): void {
    const key = routeKey(pathname, search);
    const prev = this.key;
    const prevLevel = this.level;
    this.pathname = pathname;
    this.search = search;
    this.level = morphLevel(pathname, search);
    this.key = key;
    if (first || prev === key) return;
    this.generation += 1;
    cancelSurfaces();
    // A page that only redirects (/?tab=flashcards → /flashcards) is one trip: the passage already plays, what arrives simply settles in.
    const redirect = performance.now() - this.lastRouteAt < 350 && !(this.press && this.press.at > this.lastRouteAt);
    this.lastRouteAt = performance.now();
    if (redirect && prevLevel !== 'off' && this.level !== 'off') {
      const last = this.stack[this.stack.length - 1];
      if (last && last.to === prev) last.to = key;
      this.note('redirect', key);
      this.settleIn(true, morphReduced());
      return;
    }
    const press = this.press && performance.now() - this.press.at < 1600 ? this.press : null;
    const traversal = performance.now() - this.traversal < 500;
    this.press = null;
    if (this.level === 'off' || prevLevel === 'off' || this.journeying()) {
      this.stack = [];
      this.clearFloating();
      return;
    }
    if (sameWorkspace(prev, key)) return; // the workspace animates its own views
    this.revealCount = 0;
    this.revealedAt = 0;
    this.revealed = new WeakSet();
    this.windowUntil = performance.now() + ARRIVAL_WINDOW_MS;
    const reduced = morphReduced();
    if (this.spatialOwnsRoute()) {
      this.note('spatial', key);
      this.windowUntil = 0;
      return;
    }
    const down = routeDepth(key) >= routeDepth(prev);
    const top = this.stack[this.stack.length - 1];
    const going = !!top && top.from === key && (traversal || !!press?.back || top.to === prev);
    this.busy(reduced ? 200 : MORPH_MS.flight + 160);
    if (reduced) {
      this.note('quiet', key);
      if (going) this.stack.pop();
      this.settleIn(true, true);
      return;
    }
    if (going && top) {
      this.stack.pop();
      this.flyBack(top, press);
      return;
    }
    if (traversal) this.stack = [];
    if (press && press.zone === 'content' && press.rect && press.card) {
      this.flyForward(press, prev, key, 'route');
      return;
    }
    this.note('passage', key);

    this.settleIn(down, false);
  }

  // ─── Card to destination ─────────────────────────────────────────────────────────────

  /** A destination must really be in sight: a panel mostly scrolled away is not where the eye can land. */
  private wellInView(r: DOMRect): boolean {
    const seen = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return r.width > 40 && r.height > 24 && r.left < window.innerWidth && r.right > 0 && seen >= Math.min(r.height * 0.6, 200);
  }

  /** What a view that opened in place added: the first new panel the learner can see. */
  private firstAdded(): HTMLElement | null {
    for (const el of this.addedPanels) {
      if (el.isConnected && el.offsetParent !== null && this.wellInView(el.getBoundingClientRect())) return el;
    }
    return null;
  }

  private heroOf(wantsPicture: boolean): HTMLElement | null {
    const heroes = Array.from(document.querySelectorAll<HTMLElement>('[data-morph-hero]')).filter((el) => {
      if (el.closest('[data-morph-ghost]')) return false;
      return this.wellInView(el.getBoundingClientRect());
    });
    if (heroes.length) return (wantsPicture && heroes.find((h) => h.dataset.morphHero === 'media')) || heroes[0];
    const col = workspaceColumn();
    if (!col) return null;
    const h1 = col.querySelector<HTMLElement>('h1');
    if (h1 && !h1.closest('[hidden]') && h1.offsetParent !== null) {
      const colBox = col.getBoundingClientRect();
      for (let el: HTMLElement | null = h1, i = 0; el && el !== col && i < 6; el = el.parentElement, i++) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width >= colBox.width * 0.45 && r.height >= 60 && parseFloat(cs.borderTopLeftRadius) >= 6 && this.wellInView(r)) return el;
      }
      return this.wellInView(h1.getBoundingClientRect()) ? h1 : null;
    }
    return null;
  }

  /** The live destination carries its own material and text. No clone, fallback fill, or second layer. */
  private flyForward(press: Press, from: string, to: string, kind: StackEntry['kind']): void {
    const rect = press.rect!;
    const src: Box = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    const entry: StackEntry = { from, to, kind, match: press.match ?? { href: null, id: null, text: '' }, picture: null, radius: press.radius, fill: '', dest: null };
    this.stack.push(entry);
    if (this.stack.length > 12) this.stack.shift();
    const generation = this.generation;
    const started = performance.now();
    const launch = () => {
      if (generation !== this.generation || this.key !== to || this.guiding() || this.journeying()) return;
      const hero = kind === 'view' ? this.firstAdded() : this.heroOf(false);
      const root = workspaceColumn()?.querySelector<HTMLElement>('[data-morph-stage]');
      const target = root ?? hero;
      if (!target) {
        // Observe only a bounded arrival window; a delayed response remains its normal accessible loading UI.
        if (performance.now() - started < ARRIVAL_WINDOW_MS) requestAnimationFrame(launch);
        return;
      }
      if (!this.canProject(target)) { this.note('owned-surface', to); return; }
      entry.dest = boxOf(target);
      this.revealed.add(target);
      this.note(kind === 'route' ? 'morph' : 'view-morph', to);
      moveSurface(target, src);
    };
    launch();
  }

  private canProject(el: HTMLElement): boolean {
    if (el.closest(NOT_MINE) || el.querySelector(`${HEAVY},[data-spatial-owner],[data-morph="off"],[data-morph-presence]`)) return false;
    if (surfaceOwns(el)) return true;
    const cs = getComputedStyle(el);
    if (ownMotion(el, cs)) return false;
    // Transforming an ancestor would change fixed descendants' containing block.
    return !Array.from(el.querySelectorAll<HTMLElement>('*')).slice(0, 220).some(c => {
      const style = getComputedStyle(c);
      return style.position === 'fixed' || style.position === 'sticky' || style.transformStyle === 'preserve-3d';
    });
  }

  private findSource(match: SourceMatch): HTMLElement | null {
    const col = workspaceColumn();
    if (!col) return null;
    if (match.id) {
      const named = col.querySelector<HTMLElement>(`[data-morph-source="${CSS.escape(match.id)}"]`);
      if (named) return named;
    }
    if (match.href) {
      const anchors = col.querySelectorAll<HTMLAnchorElement>('a[href]');
      for (let i = 0; i < anchors.length && i < 500; i++) {
        if (anchors[i].getAttribute('href') === match.href) return this.findCard(anchors[i]) ?? anchors[i];
      }
    }
    if (match.text.length >= 8) {
      const items = col.querySelectorAll<HTMLElement>('a,button,[role="button"],article,li');
      for (let i = 0; i < items.length && i < 500; i++) {
        if ((items[i].textContent || '').replace(/\s+/g, ' ').trim().startsWith(match.text)) return this.findCard(items[i]) ?? items[i];
      }
    }
    return null;
  }

  /** Return to the current source geometry, never stale coordinates or a scrolled-away card. */
  private flyBack(entry: StackEntry, _press: Press | null): void {
    const generation = this.generation;
    const started = performance.now();
    const look = () => {
      if (generation !== this.generation) return;
      const card = this.findSource(entry.match);
      if (!card && performance.now() - started < 620) { requestAnimationFrame(look); return; }
      const box = card?.getBoundingClientRect();
      if (!card || !box || !this.wellInView(box) || !entry.dest || !this.canProject(card)) { this.note('back-fallback', this.key); return; }
      this.revealed.add(card);
      this.note('morph-back', this.key);
      moveSurface(card, entry.dest);
    };
    look();
  }

  /** A card that left the page with no change of address: a view opened in place (a deck into its study). The same flight. */
  private checkViewChange(press: Press): void {
    if (this.key !== press.routeAtPress || !press.rect || !press.card || this.level === 'off' || morphReduced() || this.guiding()) return;
    if (press.card.isConnected && press.card.offsetParent !== null) return;
    if (press.back && this.stack.length) return;
    if (press.viewChecked) return;
    press.viewChecked = true;
    this.busy(MORPH_MS.flight + 160);
    this.windowUntil = performance.now() + ARRIVAL_WINDOW_MS;
    this.flyForward(press, press.routeAtPress, press.routeAtPress, 'view');
  }

  private checkViewReturn(press: Press): void {
    const top = this.stack[this.stack.length - 1];
    if (!top || top.kind !== 'view' || top.from !== this.key || morphReduced()) return;
    const started = performance.now();
    const look = () => {
      const card = this.findSource(top.match);
      if (!card && performance.now() - started < 300) {
        requestAnimationFrame(look);
        return;
      }
      if (!card) return;
      this.stack.pop();
      this.flyBack(top, press);
    };
    look();
  }

  // ─── Content settling in ─────────────────────────────────────────────────────────────

  /** The first panels of the page that just arrived rise into place. Later content (a skeleton resolving) reaches the same path through the observer. */
  private settleIn(down: boolean, quiet: boolean): void {
    if (this.level === 'still' || this.guiding()) return;
    const key = this.key;
    requestAnimationFrame(() => {
      if (key !== this.key) return;
      const col = workspaceColumn();
      if (!col) return;
      let root: Element = col;
      for (let i = 0; i < 8 && root.childElementCount === 1 && root.firstElementChild; i++) root = root.firstElementChild;
      if (root.childElementCount <= 3) {
        const big = Array.from(root.children).find((c) => (c as HTMLElement).offsetHeight > window.innerHeight * 0.5 && c.childElementCount >= 2);
        if (big) root = big;
      }
      let index = 0;
      for (let c = root.firstElementChild; c && index < 12; c = c.nextElementSibling) {
        if (this.reveal(c as HTMLElement, index, down ? 14 : -10, quiet)) index += 1;
      }
      if (index) this.note(quiet ? 'settle-quiet' : 'settle', key);
    });
  }

  private reveal(el: HTMLElement, index: number, dy: number, quiet: boolean): boolean {
    if (el.closest('[data-morph-running]') || el.querySelector('[data-morph-running]')) return false;
    if (this.revealCount >= MAX_REVEALS || this.revealed.has(el) || el.matches(NOT_MINE) || !PANEL_TAGS.has(el.tagName) || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 90 || r.height < 28 || !isOnScreen(r)) return false;
    if (el.contains(document.activeElement) && document.activeElement?.matches(FIELD)) return false;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') return false;
    this.revealed.add(el);
    this.revealCount += 1;
    const moves = !quiet && !this.weak && this.canProject(el);
    if (moves) moveSurface(el, { x: r.x, y: r.y + dy, w: r.width, h: r.height });
    return true;
  }

  // ─── Overlays and content that arrives after a press ─────────────────────────────────

  private onMutations = (records: MutationRecord[]) => {
    if (this.level === 'off') return;
    const now = performance.now();
    // A view may open only when the server answered (a deck enrolled, then its study): the press stays valid for as long as its window.
    const waiting = this.press;
    if (waiting?.card && !waiting.viewChecked && now - waiting.at < 1600 && !waiting.card.isConnected) this.checkViewChange(waiting);
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === 1) this.onAdded(node as HTMLElement, now);
      });
      record.removedNodes.forEach((node) => {
        if (node.nodeType === 1) this.onRemoved(node as HTMLElement, record.target as HTMLElement, record.nextSibling, now);
      });
    }
  };

  private overlayIn(node: HTMLElement): HTMLElement | null {
    if (node.matches(OVERLAY)) return node;
    return node.querySelector<HTMLElement>(`:scope > ${OVERLAY.split(',').join(', :scope > ')}, :scope > * > [role="dialog"], :scope > * > [aria-modal="true"]`);
  }

  private onAdded(node: HTMLElement, now: number): void {
    if (node.closest(NOT_MINE) || node.classList.contains('ec-morph-layer') || node.classList.contains('ec-morph-bloom') || node.classList.contains('ec-morph-glide')) return;
    const overlay = this.overlayIn(node);
    if (overlay) {
      this.enterOverlay(node, overlay, now);
      return;
    }
    if (now > this.windowUntil || this.guiding() || this.level === 'still' || this.level === 'off') return;
    const col = workspaceColumn();
    if (!col || !col.contains(node)) {
      // A popup without a role, positioned by itself, opened by this press.
      if (now - (this.press?.at ?? -1e9) < 320) this.maybePopup(node);
      return;
    }
    if (this.level === 'calm' && now - this.lastRouteAt > ARRIVAL_WINDOW_MS) return; // inside a learning surface a press changes nothing around the work
    if (node.parentElement?.closest('[role="status"],[aria-live]') && node.getBoundingClientRect().height < 60) return;
    if (this.addedPanels.length < 12 && node.offsetWidth >= 200 && node.offsetHeight >= 60) this.addedPanels.push(node);
    const reduced = morphReduced();
    this.revealedAt += 1;
    this.reveal(node, this.revealedAt - 1, 10, reduced);
  }

  private maybePopup(node: HTMLElement): void {
    if (morphReduced() || node.tagName !== 'DIV') return;
    const cs = getComputedStyle(node);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') return;
    const r = node.getBoundingClientRect();
    if (r.width < 80 || r.height < 36 || parseInt(cs.zIndex || '0', 10) < 10) return;
    // A window-sized stage is a place, not a popup. Scaling it would turn it into the containing block of its own fixed layers.
    if (r.width >= window.innerWidth * .9 && r.height >= window.innerHeight * .9) return;
    this.overlayFrom.set(node, { x: this.press?.x ?? r.left, y: this.press?.y ?? r.top });
    this.animatePanelIn(node, r);
    this.note('popup');
  }

  private enterOverlay(wrapper: HTMLElement, dialog: HTMLElement, now: number): void {
    const origin = this.press && now - this.press.at < 500 ? { x: this.press.x, y: this.press.y } : null;
    const box = dialog.getBoundingClientRect();
    if (box.width < 2 || box.height < 2 || dialog.closest('[inert]')) return; // a closed dialog kept in the tree
    const fullWindow = box.width >= window.innerWidth * 0.9 && box.height >= window.innerHeight * 0.9;
    if (dialog.closest(NOT_MINE)) return;
    this.overlayFrom.set(wrapper, origin ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 });
    this.overlayFrom.set(dialog, this.overlayFrom.get(wrapper)!);
    let panel: HTMLElement | null = dialog;
    if (fullWindow) {
      this.animateIfFree(dialog, [{ opacity: 0 }, { opacity: 1 }], MORPH_MS.quick);
      panel = null;
      const queue: Element[] = Array.from(dialog.children);
      for (let depth = 0; queue.length && depth < 24; depth++) {
        const c = queue.shift() as HTMLElement;
        const r = c.getBoundingClientRect();
        if (r.width >= 90 && r.height >= 50 && (r.width < window.innerWidth * 0.9 || r.height < window.innerHeight * 0.9) && parseFloat(getComputedStyle(c).borderTopLeftRadius) >= 4) {
          panel = c;
          break;
        }
        queue.push(...Array.from(c.children));
      }
    } else if (wrapper !== dialog && wrapper.getBoundingClientRect().width >= window.innerWidth * 0.9) {
      this.animateIfFree(wrapper, [{ opacity: 0 }, { opacity: 1 }], MORPH_MS.quick);
    }
    if (panel) this.animatePanelIn(panel, panel.getBoundingClientRect());
    this.note('overlay-in');
  }

  private animateIfFree(el: HTMLElement, frames: Keyframe[], duration: number): void {
    if (el.getAnimations().some((a) => a.playState === 'running')) return;
    this.animate(el, frames, { duration, easing: MORPH_EASE.current });
  }

  private animatePanelIn(panel: HTMLElement, box: DOMRect): void {
    if (morphReduced() || this.level === 'still' || panel.closest('[data-morph-presence]')) return;
    const cs = getComputedStyle(panel);
    if (cs.transform !== 'none' || cs.translate !== 'none' || cs.scale !== 'none' || panel.getAnimations().some(a => a.playState === 'running')) return;
    if (panel.querySelector(`${HEAVY},[data-spatial-owner]`)) return;
    const from = this.overlayFrom.get(panel) ?? (this.press ? { x: this.press.x, y: this.press.y } : null);
    const dx = from ? Math.max(-24, Math.min(24, (from.x - box.x - box.width / 2) * .12)) : 0;
    const dy = from ? Math.max(-24, Math.min(24, (from.y - box.y - box.height / 2) * .12)) : 12;
    moveSurface(panel, { x: box.x + dx, y: box.y + dy, w: box.width * .96, h: box.height * .96 });
  }

  private onRemoved(_node: HTMLElement, _parent: HTMLElement, _next: Node | null, _now: number): void {
    // Retained React surfaces own their reverse motion through useMorphPresence.
    // Legacy conditionals unmount normally. Never clone/reinsert a dialog, input or live region.
  }

  private clearFloating(): void {
    this.generation += 1;
    this.running.forEach(a => a.cancel());
    this.running.clear();
    cancelSurfaces();
    window.clearTimeout(this.busyTimer);
    document.documentElement.removeAttribute('data-morph-busy');
  }

}

let instance: MorphEngine | null = null;

/** One engine for the life of the page, whatever remounts above it (an error boundary at the root remounts the host). */
export function startMorph(): MorphEngine {
  if (!instance) instance = new MorphEngine();
  return instance;
}
