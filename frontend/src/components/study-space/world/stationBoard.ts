import * as T from 'three';
import { PART_NAME, STATION_PARTS, type Station, type StationPart } from '@/lib/study-space/station';

/**
 * The checklist over a computer being put together: which of its parts are in place, drawn in the room above it. It tells; it places nothing. A
 * sprite of one small canvas, repainted only when the answer changes, always readable, never in the way of a raycast.
 */
const W = 640, H = 168;

function glyph(c: CanvasRenderingContext2D, part: StationPart, x: number, y: number) {
  c.save(); c.translate(x, y); c.fillStyle = '#eaf6ff'; c.strokeStyle = '#eaf6ff'; c.lineWidth = 3.4; c.lineJoin = 'round'; c.lineCap = 'round';
  if (part === 'tower') { c.beginPath(); c.roundRect(-13, -22, 26, 44, 4); c.stroke(); c.beginPath(); c.arc(0, -10, 3.4, 0, Math.PI * 2); c.fill(); c.fillRect(-7, 2, 14, 2.6); c.fillRect(-7, 9, 14, 2.6); }
  if (part === 'monitor') { c.beginPath(); c.roundRect(-24, -20, 48, 31, 4); c.stroke(); c.beginPath(); c.moveTo(0, 11); c.lineTo(0, 19); c.moveTo(-11, 21); c.lineTo(11, 21); c.stroke(); }
  if (part === 'keyboard') { c.beginPath(); c.roundRect(-26, -12, 52, 26, 5); c.stroke(); for (let r = 0; r < 2; r++) for (let i = 0; i < 6; i++) c.fillRect(-20 + i * 7.2, -6 + r * 7, 4.4, 3.6); c.fillRect(-12, 7.4, 24, 2.8); }
  if (part === 'mouse') { c.beginPath(); c.roundRect(-12, -20, 24, 40, 12); c.stroke(); c.beginPath(); c.moveTo(0, -20); c.lineTo(0, -6); c.stroke(); }
  c.restore();
}
function badge(c: CanvasRenderingContext2D, x: number, y: number, ok: boolean) {
  c.fillStyle = ok ? '#39c98d' : '#e8604e'; c.beginPath(); c.arc(x, y, 15, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#fff'; c.lineWidth = 3.6; c.lineCap = 'round'; c.beginPath();
  if (ok) { c.moveTo(x - 6.5, y + .5); c.lineTo(x - 1.5, y + 5.5); c.lineTo(x + 7, y - 5); }
  else { c.moveTo(x - 5, y - 5); c.lineTo(x + 5, y + 5); c.moveTo(x + 5, y - 5); c.lineTo(x - 5, y + 5); }
  c.stroke();
}

export class StationBoard {
  readonly group = new T.Group();
  private canvas = document.createElement('canvas');
  private texture: T.CanvasTexture;
  private sprite: T.Sprite;
  private key = '';
  private level = 0;
  private wanted = false;

  constructor() {
    this.canvas.width = W; this.canvas.height = H;
    this.texture = new T.CanvasTexture(this.canvas);
    this.texture.colorSpace = T.SRGBColorSpace;
    this.sprite = new T.Sprite(new T.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
    this.sprite.scale.set(.62, .62 * H / W, 1);
    this.sprite.renderOrder = 8;
    this.sprite.userData.noCollision = true;
    this.group.add(this.sprite);
    this.group.visible = false;
    this.group.userData.noCollision = true;
  }
  show(st: Station, at: T.Vector3, vi: boolean) {
    this.wanted = true; this.group.visible = true;
    this.group.position.set(at.x, at.y + .86, at.z);
    const key = STATION_PARTS.map(p => (st.parts[p] ? 1 : 0)).join('') + vi;
    if (key === this.key) return;
    this.key = key;
    const c = this.canvas.getContext('2d')!;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(11,26,38,.86)'; c.beginPath(); c.roundRect(2, 2, W - 4, H - 4, 26); c.fill();
    c.strokeStyle = 'rgba(190,225,235,.3)'; c.lineWidth = 2; c.stroke();
    STATION_PARTS.forEach((part, i) => {
      const x = W * (i + .5) / 4, ok = !!st.parts[part];
      c.globalAlpha = ok ? 1 : .68;
      glyph(c, part, x - 12, 62);
      c.globalAlpha = 1;
      badge(c, x + 34, 40, ok);
      c.fillStyle = '#dff1f6'; c.font = '600 21px Quicksand, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(vi ? PART_NAME[part].vi : PART_NAME[part].en, x, 128);
    });
    this.texture.needsUpdate = true;
  }
  hide() { this.wanted = false; }
  update(dt: number, reduced: boolean) {
    this.level = reduced ? (this.wanted ? 1 : 0) : T.MathUtils.clamp(this.level + (this.wanted ? dt * 6 : -dt * 5), 0, 1);
    this.sprite.material.opacity = this.level;
    if (!this.wanted && this.level <= 0) this.group.visible = false;
  }
  dispose() { this.group.removeFromParent(); this.texture.dispose(); this.sprite.material.dispose(); }
}
