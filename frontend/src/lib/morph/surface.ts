import { Spring } from './spring';
import { MORPH_SPRING, morphReduced } from './tokens';

export interface SurfaceBox { x: number; y: number; w: number; h: number }
export const boxOf = (el: Element): SurfaceBox => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};
const owners = new WeakMap<HTMLElement, SurfaceMotion>();
const active = new Set<SurfaceMotion>();
const STYLE = ['translate', 'scale', 'transform-origin', 'clip-path', 'will-change'] as const;

/** Owns only these inline properties, only for the lifetime of an active spring. Never clones or paints a second surface. */
export class SurfaceMotion {
  readonly spring: Spring;
  private saved: [string, string, string][];
  private disposed = false;
  private geometry: SurfaceBox;
  private radius: number;
  private resize: ResizeObserver | undefined;
  private onFinish: (() => void) | undefined;
  constructor(readonly el: HTMLElement, from: SurfaceBox | null, private kind: keyof typeof MORPH_SPRING = 'surface') {
    owners.get(el)?.dispose();
    this.saved = STYLE.map(k => [k, el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]);
    this.geometry = boxOf(el);
    this.radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    this.spring = new Spring(from ? this.coordinates(from) : [0, 0, 1, 0, this.radius], MORPH_SPRING[kind], v => this.paint(v));
    el.style.transformOrigin = '0 0';
    el.style.willChange = 'translate, scale';
    el.setAttribute('data-morph-running', '');
    owners.set(el, this); active.add(this);
    this.paint(this.spring.values);
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => {
        if (!el.isConnected) { this.dispose(); return; }
        // Invert our own projection. Geometry remains live when a skeleton resolves or the viewport changes.
        const r = boxOf(el), [x, y, scale] = this.spring.values;
        this.geometry = { x: r.x - x, y: r.y - y, w: r.w / scale, h: r.h / scale };
      });
      this.resize.observe(el);
    }
  }
  private coordinates(box: SurfaceBox): number[] {
    const g = this.geometry;
    const scale = Math.max(0.05, Math.min(4, box.w / Math.max(1, g.w)));
    return [box.x - g.x, box.y - g.y, scale, Math.max(0, g.h - box.h / scale), this.radius];
  }
  private paint([x, y, scale, crop, radius]: number[]): void {
    if (!this.el.isConnected || document.hidden || morphReduced()) { this.finish(); return; }
    this.el.style.translate = `${x}px ${y}px`;
    this.el.style.scale = `${Math.max(0.01, scale)}`; // uniform: text and pictures never stretch independently
    this.el.style.clipPath = crop > 0.1 ? `inset(0 0 ${Math.max(0, crop)}px 0 round ${radius / Math.max(0.01, scale)}px)` : 'none';
  }
  enter(done?: () => void): void { this.onFinish = done; this.spring.retarget([0, 0, 1, 0, this.radius], () => this.finish()); }
  rebase(from: SurfaceBox): void {
    const r = boxOf(this.el), [x, y, scale] = this.spring.values;
    this.geometry = { x: r.x - x, y: r.y - y, w: r.w / scale, h: r.h / scale };
    const next = this.coordinates(from);
    // A layout change can move the resting box. Preserve the visible box and release velocity.
    this.spring.set(next, this.spring.state.map(s => s.velocity));
  }
  leave(to: SurfaceBox | null, done: () => void): void {
    this.onFinish = done;
    const g = this.geometry;
    this.spring.retarget(to ? this.coordinates(to) : [0, Math.min(32, g.h * .08), .96, 0, this.radius], () => this.finish());
  }
  drag(y: number, velocity: number): void { this.spring.set([0, y, 1, 0, this.radius], [0, velocity, 0, 0, 0]); }
  dismissSheet(done: () => void): void { this.onFinish = done; this.spring.retarget([0, window.innerHeight - this.geometry.y + 16, 1, 0, this.radius], () => this.finish()); }
  private finish(): void { const done = this.onFinish; this.onFinish = undefined; this.dispose(); done?.(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.spring.stop(); this.resize?.disconnect();
    for (const [key, value, priority] of this.saved) { if (value) this.el.style.setProperty(key, value, priority); else this.el.style.removeProperty(key); }
    this.el.removeAttribute('data-morph-running');
    if (owners.get(this.el) === this) owners.delete(this.el);
    active.delete(this);
  }
}

export function moveSurface(el: HTMLElement, from: SurfaceBox, kind: keyof typeof MORPH_SPRING = 'surface'): SurfaceMotion | null {
  if (morphReduced() || document.hidden || from.w < 1 || from.h < 1) return null;
  const previous = owners.get(el);
  if (previous) previous.rebase(from);
  const motion = previous ?? new SurfaceMotion(el, from, kind);
  motion.enter();
  return motion;
}
export function cancelSurfaces(): void { for (const motion of active) if (!motion.el.hasAttribute('data-morph-presence')) motion.dispose(); }
export function surfaceOwns(el: Element): boolean { return el instanceof HTMLElement && owners.has(el); }
