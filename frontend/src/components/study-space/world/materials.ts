import * as T from 'three';
import { reactiveGlass } from '@/lib/vfx/glass';

/**
 * One material system for every room: physically based (roughness / metalness), with small procedural textures drawn
 * once on a canvas (wood grain, woven fabric, tiles, marble, brushed metal, paper). Materials are cached per key and
 * shared by every object that uses them; `disposeMaterials` releases them all when the space closes.
 */

const cache = new Map<string, T.Material>();
const textures = new Map<string, T.Texture>();
let currentAnisotropy = 4;

/** Always returns a valid Three.js r186 `Vector2` normalScale (prevents undefined normalScale warnings). */
export function safeNormalScale(scale: number | T.Vector2 = 1): T.Vector2 {
  if (scale instanceof T.Vector2) return scale.clone();
  const s = Number.isFinite(scale) ? scale : 1;
  return new T.Vector2(s, s);
}

/** Updates anisotropic filtering across all cached study-space procedural textures to match the active quality tier. */
export function setMaterialsQuality(
  tier: 'low' | 'balanced' | 'high' | 'ultra',
  maxAnisotropy?: number,
): void {
  const desired = tier === 'ultra' ? 16 : tier === 'high' ? 8 : tier === 'balanced' ? 4 : 1;
  const cap = maxAnisotropy !== undefined && Number.isFinite(maxAnisotropy) && maxAnisotropy > 0
    ? Math.floor(maxAnisotropy)
    : 16;
  const next = Math.max(1, Math.min(desired, cap));
  if (next === currentAnisotropy) return;
  currentAnisotropy = next;
  textures.forEach((t) => {
    if (!t) return;
    t.anisotropy = next;
    if (t.image) t.needsUpdate = true;
  });
}

function canvasTexture(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat = 1, color = true): T.Texture {
  const k = `${key}:${repeat}`;
  const hit = textures.get(k);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = currentAnisotropy;
  if (color) t.colorSpace = T.SRGBColorSpace;
  textures.set(k, t);
  return t;
}

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** Light grey-scale wood grain, tinted by the material colour. */
const woodTex = (repeat = 1) => canvasTexture('wood', 512, (g, s) => {
  g.fillStyle = '#e6e6e6'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 180; i++) {
    const y = rand() * s, w = 0.6 + rand() * 2.2, a = 0.05 + rand() * 0.12;
    g.strokeStyle = `rgba(90,70,60,${a})`; g.lineWidth = w;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= s; x += 16) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 3 + Math.sin(x * 0.005 + i * 2) * 6);
    g.stroke();
  }
  for (let i = 0; i < 6; i++) {
    const x = rand() * s, y = rand() * s;
    const grd = g.createRadialGradient(x, y, 1, x, y, 10 + rand() * 12);
    grd.addColorStop(0, 'rgba(80,55,40,0.25)'); grd.addColorStop(1, 'rgba(80,55,40,0)');
    g.fillStyle = grd; g.fillRect(x - 30, y - 30, 60, 60);
  }
}, repeat);

/**
 * Floor planks, each its own board: its own tone, grain that runs its length and stops at its ends, a bevelled seam. Fine enough to look at from a standing person's
 * eyes, and it wraps (a board cut by the edge of the tile comes back on the other side), so the floor has no line where one tile meets the next.
 */
const PLANK_SIZE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 1024 : 2048;
const plankTex = (repeat = 1) => canvasTexture('planks', PLANK_SIZE, (g, s) => {
  g.fillStyle = '#dcdcdc'; g.fillRect(0, 0, s, s);
  const rows = 6, h = s / rows, u = s / 2048;
  const board = (x: number, y: number, w: number) => {
    const tone = 214 + rand() * 34, warm = rand() * 7, grain = 26 + Math.floor(rand() * 18), phase = rand() * 40, wave = .004 + rand() * .006;
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.fillStyle = `rgb(${tone},${tone - warm * .5},${tone - warm})`; g.fillRect(x, y, w, h);
    for (let i = 0; i < grain; i++) {
      const y0 = y + rand() * h, a = .035 + rand() * .085, amp = (2 + rand() * 7) * u;
      g.strokeStyle = `rgba(92,70,52,${a})`; g.lineWidth = (.6 + rand() * 2) * u;
      g.beginPath();
      for (let dx = 0; dx <= w; dx += 26 * u) { const py = y0 + Math.sin((dx + phase * 40 * u) * wave / u + i * .7) * amp + Math.sin(dx * wave * .31 / u + i) * amp * 1.6; if (dx === 0) g.moveTo(x + dx, py); else g.lineTo(x + dx, py); }
      g.stroke();
    }
    if (rand() < .42) {
      const kx = x + rand() * w, ky = y + h * (.25 + rand() * .5), r = (9 + rand() * 12) * u;
      const knot = g.createRadialGradient(kx, ky, r * .1, kx, ky, r * 2.4);
      knot.addColorStop(0, 'rgba(70,50,36,.42)'); knot.addColorStop(.35, 'rgba(90,66,48,.16)'); knot.addColorStop(1, 'rgba(90,66,48,0)');
      g.fillStyle = knot; g.save(); g.translate(kx, ky); g.scale(2.2, 1); g.translate(-kx, -ky); g.fillRect(kx - r * 3, ky - r * 3, r * 6, r * 6); g.restore();
    }
    // The bevel: a dark line, and light on the edge of the next board.
    g.fillStyle = 'rgba(48,32,24,.46)'; g.fillRect(x, y, w, 2.2 * u); g.fillRect(x, y, 2.2 * u, h);
    g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(x, y + 2.2 * u, w, 1.6 * u); g.fillRect(x + 2.2 * u, y, 1.6 * u, h);
    g.restore();
  };
  for (let r = 0; r < rows; r++) {
    const off = rand() * s, y = r * h;
    for (let k = 0; k < 2; k++) {
      const x = off + k * s / 2, keep = seed;
      board(x, y, s / 2);
      if (x + s / 2 > s) { const after = seed; seed = keep; board(x - s, y, s / 2); seed = after; }
    }
  }
}, repeat);

const fabricTex = (repeat = 1) => canvasTexture('fabric', 256, (g, s) => {
  g.fillStyle = '#ececec'; g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y += 2) { g.fillStyle = `rgba(0,0,0,${0.03 + (y % 4 === 0 ? 0.03 : 0)})`; g.fillRect(0, y, s, 1); }
  for (let x = 0; x < s; x += 2) { g.fillStyle = `rgba(255,255,255,${0.04 + (x % 4 === 0 ? 0.04 : 0)})`; g.fillRect(x, 0, 1, s); }
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${rand() * 0.05})`; g.fillRect(rand() * s, rand() * s, 1, 1); }
}, repeat);

const knitTex = (repeat = 1) => canvasTexture('knit', 256, (g, s) => {
  g.fillStyle = '#e9e9e9'; g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y += 8) for (let x = 0; x < s; x += 8) {
    g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + 4, y + 7); g.lineTo(x + 8, y); g.stroke();
  }
}, repeat);

const tileTex = (repeat = 1) => canvasTexture('tile', 256, (g, s) => {
  g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, s, s);
  const n = 4, t = s / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    g.fillStyle = `rgba(0,0,0,${0.02 + rand() * 0.04})`; g.fillRect(x * t + 2, y * t + 2, t - 4, t - 4);
  }
  g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 2;
  for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * t, 0); g.lineTo(i * t, s); g.moveTo(0, i * t); g.lineTo(s, i * t); g.stroke(); }
}, repeat);

const marbleTex = (repeat = 1) => canvasTexture('marble', 512, (g, s) => {
  g.fillStyle = '#f4f2f6'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 40; i++) {
    g.strokeStyle = `rgba(120,110,140,${0.05 + rand() * 0.1})`; g.lineWidth = 0.5 + rand() * 2;
    g.beginPath(); let x = rand() * s, y = rand() * s; g.moveTo(x, y);
    for (let k = 0; k < 12; k++) { x += (rand() - 0.3) * 60; y += (rand() - 0.5) * 60; g.lineTo(x, y); }
    g.stroke();
  }
  g.strokeStyle = 'rgba(160,140,90,0.35)'; g.lineWidth = 3; g.strokeRect(0, 0, s, s); // inlaid border of each slab
}, repeat);

const metalTex = (repeat = 1) => canvasTexture('metal', 256, (g, s) => {
  g.fillStyle = '#dcdfe8'; g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y++) { g.fillStyle = `rgba(255,255,255,${rand() * 0.08})`; g.fillRect(0, y, s, 1); }
  g.strokeStyle = 'rgba(40,50,80,0.25)'; g.lineWidth = 2; g.strokeRect(1, 1, s - 2, s - 2);
  g.fillStyle = 'rgba(40,50,80,0.3)';
  for (const [x, y] of [[10, 10], [s - 10, 10], [10, s - 10], [s - 10, s - 10]]) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
}, repeat);

const carpetTex = (repeat = 1) => canvasTexture('carpet', 256, (g, s) => {
  g.fillStyle = '#e8e8e8'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 6000; i++) { g.fillStyle = `rgba(${rand() > 0.5 ? '255,255,255' : '0,0,0'},${rand() * 0.07})`; g.fillRect(rand() * s, rand() * s, 2, 2); }
}, repeat);

export type MatKind =
  | 'wood' | 'woodDark' | 'paint' | 'fabric' | 'knit' | 'plush' | 'ceramic' | 'plastic' | 'metal' | 'chrome' | 'brass' | 'glass'
  | 'leaf' | 'soil' | 'paper' | 'screen' | 'glow' | 'rubber' | 'floorOak' | 'floorWalnut' | 'floorTile' | 'floorCarpet'
  | 'floorMetal' | 'floorMarble' | 'wall' | 'trim';

export function mat(kind: MatKind, color: string | number = '#ffffff', extra = ''): T.Material {
  const key = `${kind}:${color}:${extra}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = new T.Color(color);
  let m: T.Material;
  switch (kind) {
    case 'wood': m = new T.MeshStandardMaterial({ color: c, map: woodTex(1), roughness: 0.62, metalness: 0, normalScale: safeNormalScale(1) }); break;
    case 'woodDark': m = new T.MeshStandardMaterial({ color: c, map: woodTex(1), roughness: 0.48, metalness: 0.02, normalScale: safeNormalScale(1) }); break;
    case 'paint': m = new T.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0, normalScale: safeNormalScale(1) }); break;
    case 'fabric': m = new T.MeshStandardMaterial({ color: c, map: fabricTex(2), roughness: 0.92, metalness: 0, normalScale: safeNormalScale(1) }); break;
    case 'knit': m = new T.MeshStandardMaterial({ color: c, map: knitTex(3), roughness: 0.95, metalness: 0, normalScale: safeNormalScale(1) }); break;
    case 'plush': m = new T.MeshStandardMaterial({ color: c, map: carpetTex(2), roughness: 1, metalness: 0, normalScale: safeNormalScale(1) }); break;
    case 'ceramic': m = new T.MeshPhysicalMaterial({ color: c, roughness: 0.22, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2, normalScale: safeNormalScale(1) }); break;
    case 'plastic': m = new T.MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0, normalScale: safeNormalScale(1) }); break;
    case 'metal': m = new T.MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0.75, normalScale: safeNormalScale(1) }); break;
    case 'chrome': m = new T.MeshStandardMaterial({ color: c, roughness: 0.12, metalness: 1, normalScale: safeNormalScale(1) }); break;
    case 'brass': m = new T.MeshStandardMaterial({ color: c, roughness: 0.28, metalness: 0.9, normalScale: safeNormalScale(1) }); break;
    case 'glass': m = reactiveGlass(c); break;
    case 'leaf': m = new T.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0, side: T.DoubleSide, normalScale: safeNormalScale(1) }); break;
    case 'soil': m = new T.MeshStandardMaterial({ color: c, roughness: 1, normalScale: safeNormalScale(1) }); break;
    case 'paper': m = new T.MeshStandardMaterial({ color: c, roughness: 0.9, normalScale: safeNormalScale(1) }); break;
    case 'rubber': m = new T.MeshStandardMaterial({ color: c, roughness: 0.85, normalScale: safeNormalScale(1) }); break;
    case 'screen': m = new T.MeshStandardMaterial({ color: '#0b0f1e', emissive: c, emissiveIntensity: 0.9, roughness: 0.2, normalScale: safeNormalScale(1) }); break;
    case 'glow': m = new T.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: Number(extra || 1.6), roughness: 0.4, normalScale: safeNormalScale(1) }); break;
    case 'floorOak': m = new T.MeshStandardMaterial({ color: c, map: plankTex(2.5), roughness: 0.55, normalScale: safeNormalScale(1) }); break;
    case 'floorWalnut': m = new T.MeshStandardMaterial({ color: c, map: plankTex(2.5), roughness: 0.42, normalScale: safeNormalScale(1) }); break;
    case 'floorTile': m = new T.MeshStandardMaterial({ color: c, map: tileTex(3), roughness: 0.36, normalScale: safeNormalScale(1) }); break;
    case 'floorCarpet': m = new T.MeshStandardMaterial({ color: c, map: carpetTex(4), roughness: 1, normalScale: safeNormalScale(1) }); break;
    case 'floorMetal': m = new T.MeshStandardMaterial({ color: c, map: metalTex(4), roughness: 0.35, metalness: 0.55, normalScale: safeNormalScale(1) }); break;
    case 'floorMarble': m = new T.MeshStandardMaterial({ color: c, map: marbleTex(2), roughness: 0.22, metalness: 0.02, normalScale: safeNormalScale(1) }); break;
    case 'wall': m = new T.MeshStandardMaterial({ color: c, roughness: 0.92, normalScale: safeNormalScale(1) }); break;
    case 'trim': m = new T.MeshStandardMaterial({ color: c, roughness: 0.5, normalScale: safeNormalScale(1) }); break;
    default: m = new T.MeshStandardMaterial({ color: c, normalScale: safeNormalScale(1) });
  }
  m.name = key;
  cache.set(key, m);
  return m;
}

/** A soft radial "contact shadow" texture used under furniture (cheap ambient occlusion at the floor). */
export function blobTexture(): T.Texture {
  return canvasTexture('blob', 128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)'); grd.addColorStop(0.55, 'rgba(0,0,0,0.25)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
  }, 1, false);
}

/** Soft glow sprite for lamps (additive halo — works on a transparent canvas, unlike bloom). */
export function haloTexture(): T.Texture {
  return canvasTexture('halo', 128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
  }, 1, false);
}

/** A texture painted by a callback (artwork, screens, calendars). Not cached by colour: callers keep it. */
export function paintedTexture(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): T.Texture {
  const hit = textures.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  t.anisotropy = currentAnisotropy;
  textures.set(key, t);
  return t;
}

export function disposeMaterials() {
  cache.forEach((m) => m.dispose());
  cache.clear();
  textures.forEach((t) => t.dispose());
  textures.clear();
}
