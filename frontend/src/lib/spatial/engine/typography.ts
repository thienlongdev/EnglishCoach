import type { TypeEffect } from '../types';

/**
 * Kinetic headings. ONE visible owner of the glyphs at any moment (10 §BI):
 *  - extrude, depth, fluid move and light the REAL heading (transform + filter): same words, same wrapping, same gradient, selectable, no second text anywhere;
 *  - elastic, morph, particle need letters that the DOM cannot move one by one. Only for as long as an effect runs, the real ink is made transparent (every descendant too, gradients included: see
 *    `data-sp-ink` in spatial.css) and an aria-hidden layer draws each glyph exactly where the browser laid it out, measured with Range. At rest the layer does not exist.
 * The heading is never rewritten. Only page headings: never a word of a lesson, an answer, a transcript or a form label.
 */

const MAX_CHARS = 110;
const GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const COPY_CLASS = 'ec-sp-typecopy';
const CANVAS_CLASS = 'ec-sp-typecanvas';

/** The heading's own words, without what this layer put inside it. */
export function plainText(el: Element): string {
  let out = '';
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) out += child.textContent;
      else if (child.nodeType === Node.ELEMENT_NODE && !(child as Element).matches(`.${COPY_CLASS},.${CANVAS_CLASS}`)) walk(child);
    });
  };
  walk(el);
  return out.replace(/\s+/g, ' ').trim();
}

interface Glyph {
  ch: string;
  x: number;
  y: number;
  w: number;
  h: number;
  node?: HTMLElement;
}

interface Binding {
  el: HTMLElement;
  text: string;
  effect: TypeEffect;
  observer: MutationObserver;
  saved: { position: string; transform: string; filter: string; transition: string; willChange: string };
  ownFilter: string;
  /** Spring state of the real heading: rotation or parallax, with velocity. */
  a: number;
  b: number;
  va: number;
  vb: number;
  written: string;
  glyphs?: Glyph[];
  layer?: HTMLElement;
  spring?: Float32Array;
  morphAt?: Float32Array;
  morphing?: boolean;
  wasInside?: boolean;
  lastNear?: number;
  canvas?: HTMLCanvasElement;
}

function segments(text: string): { s: string; i: number }[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ segment: string; index: number }> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text)).map((x) => ({ s: x.segment, i: x.index }));
  const out: { s: string; i: number }[] = [];
  let i = 0;
  for (const s of Array.from(text)) {
    out.push({ s, i });
    i += s.length;
  }
  return out;
}

/** What a run of text is painted with, read from the element or the ancestor that clips a gradient to its text. */
function inkOf(parent: Element, heading: HTMLElement): { color: string; gradient: string | null; box: Element | null } {
  for (let e: Element | null = parent; e; e = e === heading ? null : e.parentElement) {
    const cs = getComputedStyle(e);
    const clip = cs.backgroundClip === 'text' || (cs as CSSStyleDeclaration & { webkitBackgroundClip?: string }).webkitBackgroundClip === 'text';
    if (clip && cs.backgroundImage !== 'none') return { color: 'transparent', gradient: cs.backgroundImage, box: e };
  }
  const cs = getComputedStyle(parent);
  const fill = cs.webkitTextFillColor;
  return { color: fill && fill !== 'rgba(0, 0, 0, 0)' ? fill : cs.color, gradient: null, box: null };
}

/** Every glyph of the heading where the browser really placed it (kerning, wrapping, block children and all). The ink must be visible when this runs. */
function measureGlyphs(el: HTMLElement, host: HTMLElement): Glyph[] {
  const box = el.getBoundingClientRect();
  const out: Glyph[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => ((node.parentElement as Element).closest(`.${COPY_CLASS},.${CANVAS_CLASS}`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const range = document.createRange();
  const inks = new Map<Element, ReturnType<typeof inkOf>>();
  const styles = new Map<Element, CSSStyleDeclaration>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement as Element;
    const text = node.textContent ?? '';
    let ink = inks.get(parent);
    if (!ink) {
      ink = inkOf(parent, el);
      inks.set(parent, ink);
    }
    let cs = styles.get(parent);
    if (!cs) {
      cs = getComputedStyle(parent);
      styles.set(parent, cs);
    }
    for (const { s, i } of segments(text)) {
      if (!s.trim()) continue;
      range.setStart(node, i);
      range.setEnd(node, i + s.length);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width === 0) continue;
      const glyph: Glyph = { ch: s, x: rect.left - box.left - el.clientLeft, y: rect.top - box.top - el.clientTop, w: rect.width, h: rect.height };
      const span = document.createElement('span');
      span.className = 'ec-sp-ch';
      span.textContent = s;
      const st = span.style;
      st.left = `${glyph.x.toFixed(2)}px`;
      st.top = `${glyph.y.toFixed(2)}px`;
      st.width = `${glyph.w.toFixed(2)}px`;
      st.height = `${glyph.h.toFixed(2)}px`;
      st.lineHeight = `${glyph.h.toFixed(2)}px`;
      st.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${glyph.h.toFixed(2)}px ${cs.fontFamily}`;
      st.textTransform = cs.textTransform;
      if (ink.gradient && ink.box) {
        const owner = ink.box.getBoundingClientRect();
        st.color = 'transparent';
        st.setProperty('-webkit-text-fill-color', 'transparent');
        st.backgroundImage = ink.gradient;
        st.backgroundRepeat = 'no-repeat';
        st.backgroundSize = `${owner.width.toFixed(1)}px ${owner.height.toFixed(1)}px`;
        // A little room so a glyph's overhang is not cut by its own box.
        st.padding = '0 2px';
        st.marginLeft = '-2px';
        st.boxSizing = 'content-box';
        st.backgroundPosition = `${(owner.left - rect.left + 2).toFixed(1)}px ${(owner.top - rect.top).toFixed(1)}px`;
        st.setProperty('-webkit-background-clip', 'text');
        st.backgroundClip = 'text';
      } else {
        st.color = ink.color;
        st.setProperty('-webkit-text-fill-color', ink.color);
      }
      glyph.node = span;
      out.push(glyph);
      host.appendChild(span);
    }
  }
  range.detach?.();
  return out;
}

const hasOwnMotion = (el: HTMLElement, cs: CSSStyleDeclaration) => cs.transform !== 'none' || cs.translate !== 'none' || cs.rotate !== 'none' || cs.scale !== 'none' || el.getAnimations().some((a) => a.playState === 'running');

export class TypeLayer {
  private bindings = new Map<HTMLElement, Binding>();
  private raf = 0;
  private last = 0;
  private x = -9999;
  private y = -9999;
  private scanTimer = 0;
  private observer: MutationObserver;
  private filterHost: SVGSVGElement | null = null;
  private filterAmount = 0;
  private filterNode: SVGFEDisplacementMapElement | null = null;
  private filterId = `ec-sp-type-fluid-${Math.random().toString(36).slice(2, 8)}`;
  private moved = false;
  private selecting = false;
  private disposed = false;

  constructor(
    private root: HTMLElement,
    private effect: () => TypeEffect,
    private allowed: () => boolean,
    private reduced: () => boolean,
  ) {
    this.observer = new MutationObserver((records) => {
      // The layer's own nodes are not news.
      if (records.every((r) => Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).every((n) => n instanceof Element && n.matches(`.${COPY_CLASS},.${CANVAS_CLASS},.ec-sp-ch`)))) return;
      this.requestScan();
    });
    this.observer.observe(root, { childList: true, subtree: true });
    window.addEventListener('pointermove', this.onMove, { passive: true });
    document.addEventListener('selectionchange', this.onSelection, { passive: true });
    this.requestScan(30);
  }

  private onMove = (event: PointerEvent) => {
    this.x = event.clientX;
    this.y = event.clientY;
    this.moved = true;
    if (this.bindings.size && !this.raf) this.schedule();
  };

  /** A learner selecting words gets the real heading, at rest. */
  private onSelection = () => {
    const selection = document.getSelection();
    const selecting = !!selection && !selection.isCollapsed && selection.rangeCount > 0 && Array.from(this.bindings.keys()).some((el) => el.contains(selection.anchorNode) || el.contains(selection.focusNode));
    if (selecting === this.selecting) return;
    this.selecting = selecting;
    if (selecting) for (const b of this.bindings.values()) this.releaseLayer(b);
    this.schedule();
  };

  requestScan(delay = 240): void {
    if (this.disposed) return;
    window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => this.scan(), delay);
  }

  /** The effect changed: rebuild everything. */
  refresh(): void {
    this.clear();
    this.requestScan(0);
  }

  private scan(): void {
    if (this.disposed) return;
    const effect = this.effect();
    if (effect === 'none' || !this.allowed() || this.reduced()) {
      this.clear();
      return;
    }
    const wanted = new Set<HTMLElement>();
    const needsGlyphs = effect === 'elastic' || effect === 'morph' || effect === 'particle';
    for (const head of Array.from(this.root.querySelectorAll<HTMLElement>('h1,h2'))) {
      if (wanted.size >= 3) break;
      if (head.closest('[data-spatial-exclude],[data-spatial-owner],[role="dialog"],[contenteditable="true"],form,article [data-reader]')) continue;
      const text = plainText(head);
      if (!text || text.length > MAX_CHARS) continue;
      const cs = getComputedStyle(head);
      if (parseFloat(cs.fontSize) < 22 || head.offsetWidth === 0) continue;
      if (head.getBoundingClientRect().top > window.innerHeight * 1.2) continue;
      if (needsGlyphs && head.querySelector('svg,img,video,canvas')) continue; // a picture in the words has no glyph to draw
      if (!this.bindings.has(head) && hasOwnMotion(head, cs)) continue; // something else already moves this heading
      wanted.add(head);
    }
    for (const [el, binding] of this.bindings) {
      if (!wanted.has(el) || !el.isConnected) this.unbind(binding);
    }
    for (const el of wanted) {
      const existing = this.bindings.get(el);
      const text = plainText(el);
      if (existing && existing.text === text && existing.effect === effect) continue;
      if (existing) this.unbind(existing);
      this.bind(el, text, effect);
    }
    if (this.bindings.size) this.schedule();
  }

  private bind(el: HTMLElement, text: string, effect: TypeEffect): void {
    const cs = getComputedStyle(el);
    const binding: Binding = {
      el,
      text,
      effect,
      observer: new MutationObserver(() => {
        if (plainText(el) !== text) this.requestScan(40);
      }),
      saved: { position: el.style.position, transform: el.style.transform, filter: el.style.filter, transition: el.style.transition, willChange: el.style.willChange },
      ownFilter: cs.filter === 'none' ? '' : cs.filter,
      a: 0,
      b: 0,
      va: 0,
      vb: 0,
      written: '',
    };
    if (cs.position === 'static') el.style.position = 'relative';
    el.dataset.spType = effect;
    binding.observer.observe(el, { characterData: true, subtree: true, childList: true });
    this.bindings.set(el, binding);
    if (effect === 'extrude' || effect === 'depth') {
      if (cs.transitionProperty === 'all' || cs.transitionProperty.includes('transform') || cs.transitionProperty.includes('filter')) el.style.transition = 'color .15s, opacity .15s';
      this.writeReal(binding, true);
    } else if (effect === 'fluid') {
      this.ensureFilter();
      this.filterAmount = Math.max(this.filterAmount, 64);
      el.style.filter = `url(#${this.filterId}) ${binding.ownFilter}`.trim();
    } else if (effect === 'morph') {
      this.startMorph(binding);
    } else if (effect === 'particle') {
      this.startParticles(binding);
    }
  }

  // ─── The real heading moves ────────────────────────────────────────────────────────────────────────────
  private stack(b: Binding, dx: number, dy: number): string {
    if (b.effect === 'extrude') {
      // Thickness: the glyphs' own shape stepped back along the view, darkest at the back. A filter, so it follows any ink (gradients too) and needs no second text.
      const parts: string[] = [];
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        parts.push(`drop-shadow(${(dx * k).toFixed(2)}px ${(dy * k).toFixed(2)}px 0 color-mix(in srgb, rgb(var(--sp-tint, 56 170 248)) ${Math.round(62 - k * 34)}%, #020617))`);
      }
      return parts.join(' ');
    }
    const parts: string[] = [];
    for (let i = 1; i <= 3; i++) parts.push(`drop-shadow(${(dx * i).toFixed(2)}px ${(dy * i).toFixed(2)}px ${(0.4 + i * 0.5).toFixed(1)}px rgb(var(--sp-tint, 56 170 248) / ${(0.42 - i * 0.1).toFixed(2)}))`);
    return parts.join(' ');
  }

  private writeReal(b: Binding, force = false): void {
    const extrude = b.effect === 'extrude';
    const dx = extrude ? 0.9 - b.b * 0.11 : b.b * 0.5;
    const dy = extrude ? 1.1 + b.a * 0.11 : b.a * 0.5;
    const key = `${b.a.toFixed(2)},${b.b.toFixed(2)}`;
    if (!force && key === b.written) return;
    b.written = key;
    const el = b.el;
    const rest = Math.abs(b.a) + Math.abs(b.b) < 0.03;
    el.style.filter = `${this.stack(b, dx, dy)} ${b.ownFilter}`.trim();
    if (rest) {
      el.style.transform = b.saved.transform;
      el.style.willChange = b.saved.willChange;
    } else {
      el.style.willChange = 'transform';
      el.style.transform = extrude ? `perspective(760px) rotateX(${b.a.toFixed(2)}deg) rotateY(${b.b.toFixed(2)}deg)` : `translate3d(${(-b.b * 0.35).toFixed(2)}px,${(-b.a * 0.35).toFixed(2)}px,0)`;
    }
  }

  private ensureFilter(): void {
    if (this.filterHost) return;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    const filter = document.createElementNS(ns, 'filter');
    filter.setAttribute('id', this.filterId);
    filter.setAttribute('x', '-8%');
    filter.setAttribute('y', '-30%');
    filter.setAttribute('width', '116%');
    filter.setAttribute('height', '160%');
    const noise = document.createElementNS(ns, 'feTurbulence');
    noise.setAttribute('type', 'fractalNoise');
    noise.setAttribute('baseFrequency', '0.018 0.05');
    noise.setAttribute('numOctaves', '2');
    const shift = document.createElementNS(ns, 'feDisplacementMap');
    shift.setAttribute('in', 'SourceGraphic');
    shift.setAttribute('scale', '0');
    shift.setAttribute('xChannelSelector', 'R');
    shift.setAttribute('yChannelSelector', 'G');
    filter.append(noise, shift);
    svg.append(filter);
    document.body.appendChild(svg);
    this.filterHost = svg;
    this.filterNode = shift;
  }

  // ─── The letters move: a layer exactly over the laid-out glyphs, only while they do ───────────────────
  private mountLayer(b: Binding): void {
    if (b.layer) return;
    const layer = document.createElement('span');
    layer.setAttribute('aria-hidden', 'true');
    layer.className = COPY_CLASS;
    b.glyphs = measureGlyphs(b.el, layer);
    b.layer = layer;
    // Same task, same paint: the layer appears and the real ink goes away together.
    b.el.appendChild(layer);
    b.el.dataset.spInk = 'hidden';
  }

  private releaseLayer(b: Binding): void {
    b.layer?.remove();
    b.layer = undefined;
    b.glyphs = undefined;
    b.spring = undefined;
    b.morphing = false;
    b.canvas?.remove();
    b.canvas = undefined;
    delete b.el.dataset.spInk;
  }

  private startMorph(b: Binding): void {
    if (this.selecting) return;
    this.mountLayer(b);
    const glyphs = b.glyphs as Glyph[];
    b.morphAt = new Float32Array(glyphs.length);
    b.morphing = true;
    const now = performance.now();
    glyphs.forEach((_g, i) => {
      (b.morphAt as Float32Array)[i] = now + 80 + i * 32 + Math.random() * 180;
    });
    this.schedule();
  }

  /** The heading gathers from particles, then the real heading takes over: each particle starts anywhere and ends on a real glyph's ink. */
  private startParticles(b: Binding): void {
    if (this.selecting) return;
    const box = b.el.getBoundingClientRect();
    if (box.width < 10) return;
    const probe = document.createElement('span');
    const glyphs = measureGlyphs(b.el, probe);
    const inkColor = (glyph: Glyph) => {
      const st = (glyph.node as HTMLElement).style;
      if (st.backgroundImage) return st.backgroundImage.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i)?.[0] ?? 'rgb(var(--sp-tint))';
      return st.color;
    };
    const canvas = document.createElement('canvas');
    canvas.className = CANVAS_CLASS;
    canvas.setAttribute('aria-hidden', 'true');
    const pad = 40;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round((box.width + pad * 2) * ratio);
    canvas.height = Math.round((box.height + pad * 2) * ratio);
    canvas.style.left = `${-pad}px`;
    canvas.style.top = `${-pad}px`;
    canvas.style.width = `${box.width + pad * 2}px`;
    canvas.style.height = `${box.height + pad * 2}px`;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    b.el.appendChild(canvas);
    b.canvas = canvas;
    b.el.dataset.spInk = 'hidden';
    ctx.scale(ratio, ratio);
    ctx.textBaseline = 'alphabetic';
    const groups: Map<string, number[]> = new Map();
    const measure = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
    for (const glyph of glyphs) {
      const st = (glyph.node as HTMLElement).style;
      const font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
      ctx.font = font;
      measure.font = font;
      const m = measure.measureText(glyph.ch);
      const ascent = m.fontBoundingBoxAscent ?? parseFloat(st.fontSize) * 0.82;
      const descent = m.fontBoundingBoxDescent ?? parseFloat(st.fontSize) * 0.2;
      ctx.fillStyle = inkColor(glyph);
      ctx.fillText(glyph.ch, glyph.x + pad, glyph.y + pad + (glyph.h - ascent - descent) / 2 + ascent);
    }
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const step = Math.max(2, Math.round(Math.sqrt((canvas.width * canvas.height) / 26000)));
    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) {
        const k = (y * canvas.width + x) * 4;
        if (data[k + 3] <= 120) continue;
        const key = `rgb(${data[k] & 240} ${data[k + 1] & 240} ${data[k + 2] & 240})`;
        let list = groups.get(key);
        if (!list) {
          list = [];
          groups.set(key, list);
        }
        list.push(x, y, Math.random() * canvas.width, Math.random() * canvas.height, Math.random());
      }
    }
    const start = performance.now();
    const dur = 1150;
    const size = Math.max(1, step * 0.9);
    const draw = (now: number) => {
      if (b.canvas !== canvas || this.disposed) return;
      const t = Math.min(1, (now - start) / dur);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const [color, pts] of groups) {
        ctx.fillStyle = color;
        for (let i = 0; i < pts.length; i += 5) {
          const local = Math.min(1, Math.max(0, (t - pts[i + 4] * 0.35) / 0.65));
          const e = 1 - (1 - local) ** 3;
          ctx.globalAlpha = 0.25 + 0.75 * e;
          ctx.fillRect(pts[i + 2] + (pts[i] - pts[i + 2]) * e, pts[i + 3] + (pts[i + 1] - pts[i + 3]) * e, size, size);
        }
      }
      if (t < 1) window.requestAnimationFrame(draw);
      else this.releaseLayer(b); // the real heading again, nothing left over
    };
    window.requestAnimationFrame(draw);
  }

  private schedule(): void {
    if (!this.raf && !this.disposed) this.raf = window.requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0.016);
    this.last = now;
    let busy = false;
    for (const b of this.bindings.values()) {
      const box = b.el.getBoundingClientRect();
      if (box.bottom < 0 || box.top > window.innerHeight) continue;
      const nx = (this.x - box.left) / Math.max(1, box.width) - 0.5;
      const ny = (this.y - box.top) / Math.max(1, box.height) - 0.5;
      const near = Math.abs(nx) < 1.2 && Math.abs(ny) < 3;
      const inside = Math.abs(nx) < 0.55 && Math.abs(ny) < 0.7;
      if (b.effect === 'extrude' || b.effect === 'depth') {
        const clampX = Math.max(-1, Math.min(1, nx));
        const clampY = Math.max(-2, Math.min(2, ny));
        const free = near && !this.selecting;
        const tb = free ? clampX * (b.effect === 'extrude' ? 16 : 12) : 0;
        const ta = free ? -clampY * (b.effect === 'extrude' ? 5 : 4) : 0;
        b.va += ((ta - b.a) * 70 - b.va * 13) * dt;
        b.vb += ((tb - b.b) * 70 - b.vb * 13) * dt;
        b.a += b.va * dt;
        b.b += b.vb * dt;
        if (Math.abs(b.a - ta) + Math.abs(b.b - tb) + Math.abs(b.va) + Math.abs(b.vb) > 0.04) busy = true;
        else {
          b.a = ta;
          b.b = tb;
        }
        this.writeReal(b);
      } else if (b.effect === 'elastic') {
        if (this.selecting) continue;
        const reach = 110;
        const close = this.x > box.left - reach && this.x < box.right + reach && this.y > box.top - reach && this.y < box.bottom + reach;
        if (close && !b.layer && this.moved) {
          this.mountLayer(b);
          b.spring = new Float32Array((b.glyphs as Glyph[]).length * 4);
        }
        if (!b.layer || !b.spring || !b.glyphs) continue;
        const s = b.spring;
        let moving = false;
        for (let i = 0; i < b.glyphs.length; i++) {
          const g = b.glyphs[i];
          const dx = box.left + g.x + g.w / 2 + s[i * 4] - this.x;
          const dy = box.top + g.y + g.h / 2 + s[i * 4 + 1] - this.y;
          const d = Math.hypot(dx, dy);
          let fx = 0;
          let fy = 0;
          if (d < reach) {
            const f = (1 - d / reach) ** 2 * 1500;
            fx = (dx / Math.max(1, d)) * f;
            fy = (dy / Math.max(1, d)) * f;
          }
          s[i * 4 + 2] += (fx - s[i * 4] * 150 - s[i * 4 + 2] * 12) * dt;
          s[i * 4 + 3] += (fy - s[i * 4 + 1] * 150 - s[i * 4 + 3] * 12) * dt;
          s[i * 4] += s[i * 4 + 2] * dt;
          s[i * 4 + 1] += s[i * 4 + 3] * dt;
          const on = Math.abs(s[i * 4]) + Math.abs(s[i * 4 + 1]) > 0.05 || Math.abs(s[i * 4 + 2]) + Math.abs(s[i * 4 + 3]) > 0.5;
          const node = g.node as HTMLElement;
          if (on) {
            node.style.transform = `translate(${s[i * 4].toFixed(2)}px,${s[i * 4 + 1].toFixed(2)}px) rotate(${(s[i * 4] * 0.5).toFixed(2)}deg)`;
            moving = true;
          } else if (node.style.transform) node.style.transform = '';
        }
        if (moving) busy = true;
        else if (!close) this.releaseLayer(b); // everything rests where the real letters are: back to the real heading
      } else if (b.effect === 'morph') {
        if (inside && !b.wasInside && !b.morphing) this.startMorph(b);
        b.wasInside = inside;
        if (b.morphing && b.morphAt && b.glyphs) {
          let left = false;
          for (let i = 0; i < b.glyphs.length; i++) {
            const g = b.glyphs[i];
            const node = g.node as HTMLElement;
            if (now < b.morphAt[i]) {
              node.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
              node.style.opacity = '0.65';
              left = true;
            } else if (node.textContent !== g.ch) {
              node.textContent = g.ch;
              node.style.opacity = '';
            }
          }
          b.morphing = left;
          if (left) busy = true;
          else this.releaseLayer(b);
        }
      } else if (b.effect === 'fluid') {
        // A ripple needs a moving pointer: a resting one leaves the heading perfectly readable.
        if (this.moved && inside) this.filterAmount = Math.max(this.filterAmount, 14);
      }
    }
    if (this.filterHost) {
      this.filterAmount *= Math.exp(-dt * 2.6);
      if (this.filterAmount < 0.15) this.filterAmount = 0;
      this.filterNode?.setAttribute('scale', this.filterAmount.toFixed(2));
      for (const b of this.bindings.values()) {
        if (b.effect !== 'fluid') continue;
        // At rest there is no filter at all: the heading is exactly itself.
        const wanted = this.filterAmount > 0 ? `url(#${this.filterId}) ${b.ownFilter}`.trim() : b.saved.filter;
        if (b.el.style.filter !== wanted) b.el.style.filter = wanted;
      }
      if (this.filterAmount > 0) busy = true;
    }
    this.moved = false;
    if (busy) this.schedule();
  };

  private unbind(b: Binding): void {
    b.observer.disconnect();
    this.releaseLayer(b);
    b.el.style.position = b.saved.position;
    b.el.style.transform = b.saved.transform;
    b.el.style.filter = b.saved.filter;
    b.el.style.transition = b.saved.transition;
    b.el.style.willChange = b.saved.willChange;
    delete b.el.dataset.spType;
    this.bindings.delete(b.el);
  }

  clear(): void {
    for (const b of Array.from(this.bindings.values())) this.unbind(b);
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.scanTimer);
    window.cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    window.removeEventListener('pointermove', this.onMove);
    document.removeEventListener('selectionchange', this.onSelection);
    this.clear();
    this.filterHost?.remove();
  }
}
