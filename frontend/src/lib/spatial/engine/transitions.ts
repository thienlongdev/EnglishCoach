import type { SpatialBridge, TransitionKind } from '../types';

/**
 * Route change. The new page is on screen at once (the router never waits for an animation): what plays is an entry on the content column, plus
 * a real clone of the card that was pressed when the kind uses one. Web Animations only: nothing is left behind when it ends or is interrupted,
 * and without JavaScript or with reduced motion the page is simply there.
 */

interface Press {
  rect: DOMRect;
  ghost: HTMLElement | null;
  at: number;
  x: number;
  y: number;
}

const GHOST_LIMIT = 280;
const WANTS_GHOST: TransitionKind[] = ['morph', 'zoom'];

export class TransitionLayer {
  private press: Press | null = null;
  private running: Animation[] = [];
  private floating: HTMLElement[] = [];
  private filterHost: SVGSVGElement | null = null;

  constructor(
    private content: () => HTMLElement | null,
    private bridge: SpatialBridge,
    private kind: () => TransitionKind,
    private level: () => 'full' | 'fade' | 'off',
    private reduced: () => boolean,
    private container: HTMLElement,
  ) {
    document.addEventListener('pointerdown', this.onPress, { passive: true, capture: true });
    document.addEventListener('keydown', this.onKey, { capture: true });
  }

  private onKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && document.activeElement instanceof HTMLElement) this.capture(document.activeElement, null);
  };

  private onPress = (event: PointerEvent) => {
    const target = event.target as Element | null;
    const link = target?.closest?.('a[href],button,[role="link"],[role="button"]') as HTMLElement | null;
    if (!link) {
      this.press = null;
      return;
    }
    this.capture(link, event);
  };

  private capture(link: HTMLElement, event: PointerEvent | null) {
    const card = (link.closest('[data-sp-surface]') as HTMLElement | null) ?? link;
    const rect = card.getBoundingClientRect();
    let ghost: HTMLElement | null = null;
    if (WANTS_GHOST.includes(this.kind()) && this.level() === 'full' && !this.reduced() && card.getElementsByTagName('*').length <= GHOST_LIMIT) {
      ghost = card.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('id');
      ghost.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('inert', '');
      ghost.removeAttribute('data-sp-surface');
      ghost.removeAttribute('data-sp-sheen');
      ghost.style.cssText += ';margin:0;transform:none;position:absolute;left:0;top:0;';
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
    }
    this.press = { rect, ghost, at: performance.now(), x: event ? event.clientX : rect.left + rect.width / 2, y: event ? event.clientY : rect.top + rect.height / 2 };
  }

  /** Called once for each real route change. */
  play(): void {
    this.cancel();
    const level = this.level();
    const press = this.press && performance.now() - this.press.at < 1600 ? this.press : null;
    this.press = null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const originX = press ? press.x : w * 0.5;
    const originY = press ? press.y : h * 0.42;
    this.bridge.routeSeq += 1;
    this.bridge.routePulse = 1;
    this.bridge.routeU = originX / Math.max(1, w);
    this.bridge.routeV = 1 - originY / Math.max(1, h);
    if (level === 'off') return;
    const el = this.content();
    if (!el) return;
    if (this.reduced() || level === 'fade') {
      this.animate(el, [{ opacity: 0.55 }, { opacity: 1 }], { duration: this.reduced() ? 1 : 200, easing: 'ease-out' });
      return;
    }
    const box = el.getBoundingClientRect();
    const easing = 'cubic-bezier(.16,.84,.24,1)';
    switch (this.kind()) {
      case 'morph': {
        if (press) this.flyGhost(press, box, 540, 0, false);
        this.animate(el, [{ opacity: 0.25, transform: 'translateY(14px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing, delay: 60 });
        break;
      }
      case 'panel': {
        const r = press?.rect;
        const top = r ? Math.max(0, r.top - box.top) : box.height * 0.3;
        const left = r ? Math.max(0, r.left - box.left) : box.width * 0.3;
        const right = r ? Math.max(0, box.right - r.right) : box.width * 0.3;
        const bottom = r ? Math.max(0, box.bottom - r.bottom) : box.height * 0.3;
        this.animate(
          el,
          [
            { clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px round 22px)`, transform: 'perspective(1400px) translateZ(-80px)', opacity: 0.7 },
            { clipPath: 'inset(0px 0px 0px 0px round 0px)', transform: 'none', opacity: 1 },
          ],
          { duration: 560, easing },
        );
        break;
      }
      case 'portal': {
        const cx = originX - box.left;
        const cy = originY - box.top;
        const radius = Math.hypot(Math.max(cx, box.width - cx), Math.max(cy, box.height - cy)) + 40;
        this.animate(el, [{ clipPath: `circle(0px at ${cx}px ${cy}px)` }, { clipPath: `circle(${radius}px at ${cx}px ${cy}px)` }], { duration: 620, easing: 'cubic-bezier(.45,.05,.2,1)' });
        this.ring(originX, originY, radius);
        break;
      }
      case 'fluid': {
        this.fluidSheet(box);
        break;
      }
      case 'flip': {
        const fromLeft = press ? originX > w / 2 : true;
        el.style.transformOrigin = fromLeft ? 'left center' : 'right center';
        const anim = this.animate(
          el,
          [
            { transform: `perspective(1500px) rotateY(${fromLeft ? 26 : -26}deg) translateZ(-60px)`, opacity: 0.2 },
            { transform: 'none', opacity: 1 },
          ],
          { duration: 560, easing },
        );
        anim.finished.catch(() => undefined).finally(() => {
          el.style.transformOrigin = '';
        });
        break;
      }
      case 'zoom': {
        if (press) this.flyGhost(press, box, 460, 0, true);
        this.animate(el, [{ transform: 'perspective(1400px) translateZ(-180px)', opacity: 0.1 }, { transform: 'none', opacity: 1 }], { duration: 560, easing, delay: 40 });
        break;
      }
      default:
        this.animate(el, [{ opacity: 0.4 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
    }
  }

  private animate(el: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): Animation {
    const anim = el.animate(frames, { fill: 'none', ...options });
    this.running.push(anim);
    return anim;
  }

  /** The pressed card travels to where the page opens (FLIP on a real clone), and dissolves. */
  private flyGhost(press: Press, box: DOMRect, duration: number, delay: number, through: boolean): void {
    const ghost = press.ghost;
    if (!ghost) return;
    this.container.appendChild(ghost);
    this.floating.push(ghost);
    const r = press.rect;
    const start = `translate(${r.left}px,${r.top}px) scale(1,1)`;
    const end = through
      ? `translate(${r.left + r.width / 2 - (r.width * 3) / 2}px,${r.top + r.height / 2 - (r.height * 3) / 2}px) scale(3,3)`
      : `translate(${box.left}px,${box.top}px) scale(${box.width / Math.max(1, r.width)},${Math.min(box.height, window.innerHeight) / Math.max(1, r.height)})`;
    ghost.style.transformOrigin = '0 0';
    const anim = ghost.animate(
      [
        { transform: start, opacity: 1, borderRadius: getComputedStyle(ghost).borderRadius || '16px' },
        { transform: end, opacity: 0, borderRadius: '0px' },
      ],
      { duration, delay, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' },
    );
    this.running.push(anim);
    anim.finished.catch(() => undefined).finally(() => ghost.remove());
  }

  private ring(x: number, y: number, radius: number): void {
    const ring = document.createElement('div');
    ring.setAttribute('aria-hidden', 'true');
    ring.className = 'ec-sp-ring';
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    this.container.appendChild(ring);
    this.floating.push(ring);
    const anim = ring.animate(
      [
        { transform: 'translate(-50%,-50%) scale(0)', opacity: 1 },
        { transform: `translate(-50%,-50%) scale(${(radius * 2) / 100})`, opacity: 0.1 },
      ],
      { duration: 640, easing: 'cubic-bezier(.45,.05,.2,1)', fill: 'both' },
    );
    this.running.push(anim);
    anim.finished.catch(() => undefined).finally(() => ring.remove());
  }

  /** A sheet of the preset's colour with a rippling edge (SVG displacement of its own rectangle) passes over the column once. */
  private fluidSheet(box: DOMRect): void {
    if (!this.filterHost) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'absolute';
      const filter = document.createElementNS(ns, 'filter');
      filter.setAttribute('id', 'ec-sp-fluid-edge');
      filter.setAttribute('x', '-10%');
      filter.setAttribute('y', '-20%');
      filter.setAttribute('width', '120%');
      filter.setAttribute('height', '140%');
      const noise = document.createElementNS(ns, 'feTurbulence');
      noise.setAttribute('type', 'fractalNoise');
      noise.setAttribute('baseFrequency', '0.008 0.018');
      noise.setAttribute('numOctaves', '2');
      noise.setAttribute('seed', '4');
      const shift = document.createElementNS(ns, 'feDisplacementMap');
      shift.setAttribute('in', 'SourceGraphic');
      shift.setAttribute('scale', '120');
      filter.append(noise, shift);
      svg.append(filter);
      this.container.appendChild(svg);
      this.filterHost = svg;
    }
    const sheet = document.createElement('div');
    sheet.setAttribute('aria-hidden', 'true');
    sheet.className = 'ec-sp-sheet';
    sheet.style.left = `${box.left - 60}px`;
    sheet.style.width = `${box.width + 120}px`;
    this.container.appendChild(sheet);
    this.floating.push(sheet);
    const h = window.innerHeight;
    const anim = sheet.animate(
      [
        { transform: `translateY(${h * 0.15}px)`, opacity: 0.96 },
        { transform: `translateY(${-h * 1.35}px)`, opacity: 0.96 },
      ],
      { duration: 620, easing: 'cubic-bezier(.5,.05,.2,1)', fill: 'both' },
    );
    this.running.push(anim);
    anim.finished.catch(() => undefined).finally(() => sheet.remove());
  }

  /** A preview without a route change (the studio's sample page). */
  rehearse(): void {
    this.play();
  }

  private cancel(): void {
    this.running.forEach((anim) => anim.cancel());
    this.running = [];
    this.floating.forEach((node) => node.remove());
    this.floating = [];
  }

  dispose(): void {
    document.removeEventListener('pointerdown', this.onPress, { capture: true } as EventListenerOptions);
    document.removeEventListener('keydown', this.onKey, { capture: true } as EventListenerOptions);
    this.cancel();
    this.filterHost?.remove();
    this.filterHost = null;
  }
}
