import type { OverlayKind } from '../types';

/**
 * A faint pointer layer above the cards: only additive light, never over a field or an excluded panel, off on study screens. A small 2D canvas at
 * half resolution; it draws only while something is alive and clears itself completely, so a resting page costs nothing here.
 */

interface Mote {
  x: number; y: number; vx: number; vy: number; life: number; size: number;
}

export class PointerOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private motes: Mote[] = [];
  private raf = 0;
  private last = 0;
  private x = 0;
  private y = 0;
  private lastX = -1;
  private lastY = -1;
  private ratio = 0.5;
  private clean = true;

  constructor(
    private container: HTMLElement,
    private kind: () => OverlayKind,
    private allowed: () => boolean,
    private tint: () => string,
    private strength: () => number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ec-sp-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    container.appendChild(this.canvas);
    this.fit();
    window.addEventListener('resize', this.fit);
    window.addEventListener('pointermove', this.onMove, { passive: true });
  }

  private fit = () => {
    this.canvas.width = Math.round(window.innerWidth * this.ratio);
    this.canvas.height = Math.round(window.innerHeight * this.ratio);
  };

  private onMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || this.kind() === 'none' || !this.allowed() || this.strength() <= 0.01) return;
    this.x = event.clientX;
    this.y = event.clientY;
    const target = event.target as Element | null;
    if (target?.closest?.('input,textarea,select,[contenteditable="true"],iframe,video,[data-spatial-exclude],[role="dialog"]')) return;
    const dx = this.lastX < 0 ? 0 : this.x - this.lastX;
    const dy = this.lastY < 0 ? 0 : this.y - this.lastY;
    this.lastX = this.x;
    this.lastY = this.y;
    const speed = Math.hypot(dx, dy);
    const count = Math.min(5, Math.ceil(speed / 14));
    for (let i = 0; i < count && this.motes.length < 220; i++) {
      const f = i / Math.max(1, count);
      this.motes.push({ x: this.x - dx * f, y: this.y - dy * f, vx: dx * 0.8 + (Math.random() - 0.5) * 30, vy: dy * 0.8 + (Math.random() - 0.5) * 30, life: 1, size: 8 + Math.random() * 20 });
    }
    if (!this.raf) {
      this.last = 0;
      this.raf = window.requestAnimationFrame(this.tick);
    }
  };

  private tick = (now: number) => {
    this.raf = 0;
    const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0.016);
    this.last = now;
    const ctx = this.ctx;
    const kind = this.kind();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.allowed() || kind === 'none') {
      this.motes = [];
      return;
    }
    ctx.globalCompositeOperation = 'lighter';
    const tint = this.tint();
    const decay = kind === 'liquid' ? 1.5 : kind === 'gravity' ? 1.1 : 0.8;
    const out: Mote[] = [];
    for (const m of this.motes) {
      m.life -= dt * decay;
      if (m.life <= 0) continue;
      if (kind === 'gravity') {
        const dx = this.x - m.x;
        const dy = this.y - m.y;
        const d2 = Math.max(400, dx * dx + dy * dy);
        const f = 1_800_000 / d2;
        m.vx += (dx / Math.sqrt(d2)) * f * dt;
        m.vy += (dy / Math.sqrt(d2)) * f * dt;
      } else if (kind === 'motes') {
        m.vy -= 26 * dt;
        m.vx += Math.sin(now * 0.002 + m.y * 0.02) * 30 * dt;
      }
      const drag = Math.exp(-dt * (kind === 'liquid' ? 5 : 1.6));
      m.vx *= drag;
      m.vy *= drag;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      const r = (kind === 'liquid' ? m.size * (1.4 - m.life * 0.4) : kind === 'gravity' ? 2.2 : 2 + m.size * 0.14) * this.ratio;
      const alpha = m.life * (kind === 'liquid' ? 0.13 : 0.55) * this.strength();
      const g = ctx.createRadialGradient(m.x * this.ratio, m.y * this.ratio, 0, m.x * this.ratio, m.y * this.ratio, r * 2.2);
      g.addColorStop(0, `rgb(${tint} / ${alpha.toFixed(3)})`);
      g.addColorStop(1, `rgb(${tint} / 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(m.x * this.ratio, m.y * this.ratio, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
      out.push(m);
    }
    this.motes = out;
    this.clean = !out.length;
    if (out.length) this.raf = window.requestAnimationFrame(this.tick);
  };

  get resting(): boolean {
    return this.clean && !this.raf;
  }

  dispose(): void {
    window.cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.fit);
    window.removeEventListener('pointermove', this.onMove);
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.canvas.remove();
  }
}
