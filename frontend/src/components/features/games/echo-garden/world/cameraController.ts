/**
 * Smooth 2.5D camera for Echo Garden.
 *
 * World coordinates are runtime pixels at zoom 1 (grid origin = 0,0). The camera stores the
 * world point at the viewport centre and an absolute zoom; everything eases toward a target
 * with frame-rate independent exponential damping. Drag panning is direct with inertia on
 * release; wheel and pinch zoom keep the world point under the cursor fixed.
 */
export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface CameraBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class CameraController {
  cur: CameraState = { x: 0, y: 0, zoom: 1 };
  target: CameraState = { x: 0, y: 0, zoom: 1 };
  fitZoom = 1;
  minRel = 0.8;
  maxRel = 3.2;
  viewW = 1;
  viewH = 1;
  bounds: CameraBounds = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  /** offset (screen px) applied to the framing, e.g. to keep a target clear of the inspect card */
  frameOffset = { x: 0, y: 0 };
  private vel = { x: 0, y: 0 };
  private dragging = false;
  snap = false;

  setViewport(w: number, h: number) {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
  }

  get rel(): number {
    return this.target.zoom / this.fitZoom;
  }

  clampZoom(z: number): number {
    return Math.max(this.fitZoom * this.minRel, Math.min(this.fitZoom * this.maxRel, z));
  }

  private clampCenter(s: CameraState) {
    // allow more freedom when zoomed in; at fit the island stays centred
    s.x = Math.max(this.bounds.minX, Math.min(this.bounds.maxX, s.x));
    s.y = Math.max(this.bounds.minY, Math.min(this.bounds.maxY, s.y));
  }

  /** Jump (used on first layout and resize). */
  jump(x: number, y: number, zoom: number) {
    this.target = { x, y, zoom: this.clampZoom(zoom) };
    this.clampCenter(this.target);
    this.cur = { ...this.target };
    this.vel = { x: 0, y: 0 };
  }

  focus(x: number, y: number, zoom?: number) {
    const z = this.clampZoom(zoom ?? this.target.zoom);
    this.target = {
      x: x - this.frameOffset.x / z,
      y: y - this.frameOffset.y / z,
      zoom: z,
    };
    this.clampCenter(this.target);
    this.vel = { x: 0, y: 0 };
  }

  setRelZoom(rel: number, anchorScreen?: { x: number; y: number }) {
    this.zoomTo(this.fitZoom * rel, anchorScreen);
  }

  /** Zoom keeping the world point under `anchorScreen` fixed (defaults to viewport centre). */
  zoomTo(zoom: number, anchorScreen?: { x: number; y: number }) {
    const z = this.clampZoom(zoom);
    if (anchorScreen) {
      const w = this.screenToWorldTarget(anchorScreen.x, anchorScreen.y);
      this.target.zoom = z;
      this.target.x = w.x - (anchorScreen.x - this.viewW / 2) / z;
      this.target.y = w.y - (anchorScreen.y - this.viewH / 2) / z;
    } else {
      this.target.zoom = z;
    }
    this.clampCenter(this.target);
  }

  screenToWorld(sx: number, sy: number) {
    return {
      x: this.cur.x + (sx - this.viewW / 2) / this.cur.zoom,
      y: this.cur.y + (sy - this.viewH / 2) / this.cur.zoom,
    };
  }

  private screenToWorldTarget(sx: number, sy: number) {
    return {
      x: this.target.x + (sx - this.viewW / 2) / this.target.zoom,
      y: this.target.y + (sy - this.viewH / 2) / this.target.zoom,
    };
  }

  beginDrag() {
    this.dragging = true;
    this.vel = { x: 0, y: 0 };
  }

  dragBy(dxScreen: number, dyScreen: number, dtSec: number) {
    const dx = -dxScreen / this.cur.zoom;
    const dy = -dyScreen / this.cur.zoom;
    this.target.x += dx;
    this.target.y += dy;
    this.clampCenter(this.target);
    // dragging follows the finger exactly
    this.cur.x = this.target.x;
    this.cur.y = this.target.y;
    if (dtSec > 0) {
      const k = 0.35;
      this.vel.x = this.vel.x * (1 - k) + (dx / dtSec) * k;
      this.vel.y = this.vel.y * (1 - k) + (dy / dtSec) * k;
    }
  }

  endDrag() {
    this.dragging = false;
    const sp = Math.hypot(this.vel.x, this.vel.y);
    const max = 2600;
    if (sp > max) {
      this.vel.x *= max / sp;
      this.vel.y *= max / sp;
    }
  }

  update(dtSec: number) {
    if (!this.dragging && (Math.abs(this.vel.x) > 1 || Math.abs(this.vel.y) > 1)) {
      this.target.x += this.vel.x * dtSec;
      this.target.y += this.vel.y * dtSec;
      const decay = Math.exp(-dtSec * 5.5);
      this.vel.x *= decay;
      this.vel.y *= decay;
      this.clampCenter(this.target);
    }
    if (this.snap) {
      this.cur = { ...this.target };
      return;
    }
    const k = 1 - Math.exp(-dtSec * 7.0);
    const kz = 1 - Math.exp(-dtSec * 6.0);
    this.cur.x += (this.target.x - this.cur.x) * k;
    this.cur.y += (this.target.y - this.cur.y) * k;
    // ease zoom in log space so zooming feels uniform
    const lz = Math.log(this.cur.zoom) + (Math.log(this.target.zoom) - Math.log(this.cur.zoom)) * kz;
    this.cur.zoom = Math.exp(lz);
  }

  isSettled(): boolean {
    return (
      Math.abs(this.cur.x - this.target.x) < 0.3 &&
      Math.abs(this.cur.y - this.target.y) < 0.3 &&
      Math.abs(this.cur.zoom - this.target.zoom) < 1e-4 &&
      Math.abs(this.vel.x) < 1 &&
      Math.abs(this.vel.y) < 1
    );
  }
}
