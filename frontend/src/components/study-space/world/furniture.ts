import * as T from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mat, paintedTexture, type MatKind } from './materials';
import { studyAsset } from './assets';

/**
 * Builders for every catalogue id (`lib/study-space/catalog.ts`). Each returns a group whose origin is the centre of
 * its footprint at its base (y = 0), front facing +z, in metres. Geometry is real mesh (rounded boxes, lathes, tubes,
 * extruded shapes), shared through a small cache; lamps declare their light in `userData.lights`, clocks expose their
 * hands in `userData.clock` so the scene can show the real time.
 */

export interface LightSpec { pos: [number, number, number]; color: string; intensity: number; distance: number }
export interface BuildOpts { color?: string }

const geo = new Map<string, T.BufferGeometry>();
const g = <G extends T.BufferGeometry>(key: string, make: () => G): G => {
  const hit = geo.get(key) as G | undefined;
  if (hit) return hit;
  const made = make();
  geo.set(key, made);
  return made;
};

function mesh(geometry: T.BufferGeometry, material: T.Material, x = 0, y = 0, z = 0, cast = true): T.Mesh {
  const m = new T.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}
/** Rounded box centred at (x, y, z). */
const rb = (w: number, h: number, d: number, r: number, m: T.Material, x = 0, y = 0, z = 0) =>
  mesh(g(`rb${w},${h},${d},${r}`, () => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2) * 0.999)), m, x, y, z);
const cyl = (rt: number, rbt: number, h: number, m: T.Material, x = 0, y = 0, z = 0, seg = 32) =>
  mesh(g(`cy${rt},${rbt},${h},${seg}`, () => new T.CylinderGeometry(rt, rbt, h, seg)), m, x, y, z);
const sph = (r: number, m: T.Material, x = 0, y = 0, z = 0, ws = 24, hs = 16) => mesh(g(`sp${r},${ws}`, () => new T.SphereGeometry(r, ws, hs)), m, x, y, z);
const lathe = (key: string, pts: [number, number][], m: T.Material, x = 0, y = 0, z = 0, seg = 40) =>
  mesh(g(`la${key}`, () => new T.LatheGeometry(pts.map(([a, b]) => new T.Vector2(a, b)), seg)), m, x, y, z);
const torus = (r: number, t: number, m: T.Material, arc = Math.PI * 2, x = 0, y = 0, z = 0) =>
  mesh(g(`to${r},${t},${arc}`, () => new T.TorusGeometry(r, t, 12, 40, arc)), m, x, y, z);
const tube = (key: string, pts: [number, number, number][], r: number, m: T.Material) =>
  mesh(g(`tu${key}`, () => new T.TubeGeometry(new T.CatmullRomCurve3(pts.map((p) => new T.Vector3(...p))), 24, r, 8)), m);
const plane = (key: string, w: number, h: number, m: T.Material, x = 0, y = 0, z = 0) => mesh(g(`pl${key}${w},${h}`, () => new T.PlaneGeometry(w, h)), m, x, y, z, false);

const grp = (...children: T.Object3D[]) => { const gr = new T.Group(); children.forEach((c) => gr.add(c)); return gr; };
const at = (o: T.Object3D, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) => { o.position.set(x, y, z); o.rotation.set(rx, ry, rz); return o; };

const tint = (o: BuildOpts, d: string) => o.color ?? d;
const M = (k: MatKind, c: string, e = '') => mat(k, c, e);

// ── Painted surfaces ─────────────────────────────────────────────────────────────────────────────────────
function whaleShape(gr: CanvasRenderingContext2D, cx: number, cy: number, s: number, fill: string) {
  gr.fillStyle = fill;
  gr.beginPath();
  gr.ellipse(cx, cy, s, s * 0.42, -0.08, 0, Math.PI * 2);
  gr.fill();
  gr.beginPath();
  gr.moveTo(cx + s * 0.85, cy - s * 0.05);
  gr.quadraticCurveTo(cx + s * 1.35, cy - s * 0.15, cx + s * 1.55, cy - s * 0.55);
  gr.quadraticCurveTo(cx + s * 1.4, cy - s * 0.1, cx + s * 1.62, cy + s * 0.05);
  gr.quadraticCurveTo(cx + s * 1.3, cy + s * 0.05, cx + s * 0.85, cy + s * 0.18);
  gr.fill();
  gr.fillStyle = 'rgba(255,255,255,0.85)';
  gr.beginPath(); gr.ellipse(cx - s * 0.15, cy + s * 0.2, s * 0.7, s * 0.16, -0.05, 0, Math.PI); gr.fill();
  gr.fillStyle = '#1d2a55'; gr.beginPath(); gr.arc(cx - s * 0.6, cy - s * 0.06, s * 0.05, 0, Math.PI * 2); gr.fill();
}

const artTexture = (kind: string) => paintedTexture(`art:${kind}`, 512, 640, (c, w, h) => {
  const sky = c.createLinearGradient(0, 0, 0, h);
  if (kind === 'whale') { sky.addColorStop(0, '#eef1ff'); sky.addColorStop(1, '#c9d6ff'); }
  else if (kind === 'sky') { sky.addColorStop(0, '#6f86e8'); sky.addColorStop(0.6, '#c9b6f0'); sky.addColorStop(1, '#ffd5c2'); }
  else if (kind === 'coral') { sky.addColorStop(0, '#5b7be0'); sky.addColorStop(1, '#2c3f8f'); }
  else { sky.addColorStop(0, '#f8f4ea'); sky.addColorStop(1, '#efe6d2'); }
  c.fillStyle = sky; c.fillRect(0, 0, w, h);
  if (kind === 'whale') {
    for (let i = 0; i < 4; i++) { c.strokeStyle = `rgba(90,120,220,${0.35 - i * 0.06})`; c.lineWidth = 10; c.beginPath(); for (let x = 0; x <= w; x += 8) c.lineTo(x, h * 0.72 + i * 34 + Math.sin(x / 40 + i) * 10); c.stroke(); }
    whaleShape(c, w * 0.42, h * 0.42, w * 0.25, '#4f73e0');
  } else if (kind === 'sky') {
    c.fillStyle = 'rgba(255,240,200,0.95)'; c.beginPath(); c.arc(w * 0.5, h * 0.55, 70, 0, Math.PI * 2); c.fill();
    for (let i = 0; i < 5; i++) { c.fillStyle = 'rgba(255,255,255,0.7)'; c.beginPath(); c.ellipse(80 + i * 90, h * (0.7 + (i % 2) * 0.05), 70, 26, 0, 0, Math.PI * 2); c.fill(); }
  } else if (kind === 'coral') {
    c.strokeStyle = '#ff9fc3'; c.lineCap = 'round';
    const branch = (x: number, y: number, a: number, len: number, d: number) => {
      if (d === 0) return; const x2 = x + Math.cos(a) * len, y2 = y - Math.sin(a) * len;
      c.lineWidth = d * 5; c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke();
      branch(x2, y2, a + 0.45, len * 0.75, d - 1); branch(x2, y2, a - 0.4, len * 0.72, d - 1);
    };
    branch(w / 2, h * 0.92, Math.PI / 2, 140, 6);
    for (let i = 0; i < 30; i++) { c.fillStyle = 'rgba(255,255,255,0.5)'; c.beginPath(); c.arc((i * 73) % w, (i * 151) % (h * 0.6), 3 + (i % 4), 0, Math.PI * 2); c.fill(); }
  } else {
    c.fillStyle = '#4f8a5b';
    for (let i = 0; i < 9; i++) { c.save(); c.translate(w / 2, h * 0.85 - i * 52); c.rotate((i % 2 ? 1 : -1) * 0.7); c.beginPath(); c.ellipse(60, 0, 70, 24, 0, 0, Math.PI * 2); c.fill(); c.restore(); }
    c.strokeStyle = '#3c6d47'; c.lineWidth = 5; c.beginPath(); c.moveTo(w / 2, h * 0.95); c.lineTo(w / 2, h * 0.3); c.stroke();
  }
});

/** What a screen shows when nobody is using it: the same desktop the player gets up close, with the clock it really has. */
let deskCanvas: HTMLCanvasElement | null = null, deskTexture: T.CanvasTexture | null = null, deskMinute = '';
function paintDesk(c: CanvasRenderingContext2D, w: number, h: number, now: Date) {
  const bg = c.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#0d2747'); bg.addColorStop(0.55, '#1c4f86'); bg.addColorStop(1, '#3c7fb3');
  c.fillStyle = bg; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 4; i++) { c.strokeStyle = `rgba(160,220,255,${0.13 - i * 0.02})`; c.lineWidth = 18; c.beginPath(); for (let x = 0; x <= w; x += 12) c.lineTo(x, h * 0.62 + i * 44 + Math.sin(x / 90 + i) * 16); c.stroke(); }
  whaleShape(c, w * 0.42, h * 0.4, w * 0.11, 'rgba(255,255,255,0.92)');
  c.fillStyle = 'rgba(255,255,255,0.96)'; c.textAlign = 'left'; c.font = '700 64px Quicksand, sans-serif';
  c.fillText(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, w * 0.045, h * 0.17);
  // The dock, as it is up close.
  const dw = w * 0.56, dx = (w - dw) / 2, dy = h * 0.86, dh = h * 0.1;
  c.fillStyle = 'rgba(8,24,40,0.55)'; c.beginPath(); c.roundRect(dx, dy, dw, dh, 16); c.fill();
  ['#7cc8ff', '#b79cff', '#ffd27c', '#7ce7c4', '#ff9fb6', '#9fd3ff', '#ffe08a'].forEach((color, i) => { c.fillStyle = color; c.beginPath(); c.roundRect(dx + 14 + i * (dw - 28) / 7, dy + 10, dh - 20, dh - 20, 10); c.fill(); });
}
export function deskScreen(): T.Texture {
  if (deskTexture) return deskTexture;
  deskCanvas = document.createElement('canvas'); deskCanvas.width = 1024; deskCanvas.height = 640;
  paintDesk(deskCanvas.getContext('2d')!, 1024, 640, new Date());
  deskTexture = new T.CanvasTexture(deskCanvas);
  deskTexture.colorSpace = T.SRGBColorSpace; deskTexture.anisotropy = 4;
  return deskTexture;
}
/** The clock on every idle screen in the room, once a minute. */
export function tickDeskScreen(now: Date) {
  const key = `${now.getHours()}:${now.getMinutes()}`;
  if (!deskCanvas || !deskTexture || key === deskMinute) return;
  deskMinute = key;
  paintDesk(deskCanvas.getContext('2d')!, 1024, 640, now);
  deskTexture.needsUpdate = true;
}
const noSignalScreen = () => paintedTexture('screen:nosignal', 512, 288, (c, w, h) => {
  c.fillStyle = '#0a0d18'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(255,255,255,0.28)'; c.lineWidth = 3; c.strokeRect(w * 0.3, h * 0.36, w * 0.4, h * 0.28);
  c.fillStyle = 'rgba(255,255,255,0.72)'; c.font = '600 22px Quicksand, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('No signal', w / 2, h / 2);
});
const towerFace = () => paintedTexture('pc:face', 176, 396, (c, w, h) => {
  c.fillStyle = '#2d3148'; c.fillRect(0, 0, w, h);
  c.fillStyle = 'rgba(255,255,255,0.05)'; c.fillRect(0, 0, w, h * 0.24);
  c.fillStyle = '#0d0f18';
  for (let y = h * 0.36; y < h * 0.96; y += 13) for (let x = 14; x < w - 14; x += 13) { c.beginPath(); c.arc(x, y, 3.2, 0, Math.PI * 2); c.fill(); }
});
/** Rows of real key caps on one merged geometry, with their letters painted on top: what a hand comes down on. */
function keysOn(width: number, depth: number, y: number, z: number) {
  const key = `keys${width},${depth}`, cap = M('plastic', '#eceef6');
  const caps = mesh(g(key, () => {
    const rows = [14, 14, 13, 12, 8], gap = 0.0016, parts: T.BufferGeometry[] = [];
    const h = (depth - gap * 4) / 5;
    rows.forEach((count, r) => {
      let n = count;
      const unit = (width - gap * (n - 1)) / n;
      let x = -width / 2;
      // The bottom row: three keys, the long space bar, three keys.
      const space = width * .42, side = (width - space - gap * 6) / 6;
      if (r === 4) n = 7;
      for (let i = 0; i < n; i++) {
        const w = r === 4 ? (i === 3 ? space : side) : unit;
        const b = new T.BoxGeometry(w, 0.004, h);
        b.translate(x + w / 2, 0.002, -depth / 2 + r * (h + gap) + h / 2);
        parts.push(b);
        x += w + gap;
      }
    });
    const merged = mergeGeometries(parts, false);
    parts.forEach(p => p.dispose());
    return merged ?? new T.BoxGeometry(width, 0.004, depth);
  }), cap, 0, y, z);
  const legend = plane(`legend${width}`, width, depth, new T.MeshStandardMaterial({ map: keyLegend(), transparent: true, depthWrite: false, roughness: 0.6 }), 0, y + 0.0043, z);
  legend.rotation.x = -Math.PI / 2;
  legend.userData.noCollision = true;
  return grp(caps, legend);
}
const keyLegend = () => paintedTexture('keys:legend', 1024, 310, (c, w, h) => {
  c.clearRect(0, 0, w, h);
  c.fillStyle = 'rgba(40,44,70,0.85)'; c.font = '600 26px Quicksand, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  const rows = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
  rows.forEach((row, r) => { const n = [14, 14, 13, 12][r], unit = w / n; [...row].forEach((ch, i) => c.fillText(ch, (i + 1.5) * unit, (r + .5) * h / 5)); });
});

const coverTexture = () => paintedTexture('notebook', 256, 320, (c, w, h) => {
  const bg = c.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#a7b6f6'); bg.addColorStop(1, '#6f7fe0');
  c.fillStyle = bg; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 3; i++) { c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 6; c.beginPath(); for (let x = 0; x <= w; x += 6) c.lineTo(x, h * 0.7 + i * 22 + Math.sin(x / 26 + i) * 6); c.stroke(); }
  whaleShape(c, w * 0.42, h * 0.35, w * 0.18, '#ffffff');
});

/** The cover of the desk dictionary: cloth, a gilt frame and its name, the way a real reference book is bound. */
const dictionaryTexture = () => paintedTexture('dictionary', 256, 340, (c, w, h) => {
  const bg = c.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#24365f'); bg.addColorStop(1, '#16223f');
  c.fillStyle = bg; c.fillRect(0, 0, w, h);
  c.strokeStyle = '#d8b765'; c.lineWidth = 4; c.strokeRect(16, 16, w - 32, h - 32);
  c.lineWidth = 1.5; c.strokeRect(24, 24, w - 48, h - 48);
  c.fillStyle = '#e6c878'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = '700 30px Quicksand, sans-serif'; c.fillText('DICTIONARY', w / 2, h * .36);
  c.font = '600 20px Quicksand, sans-serif'; c.fillText('English Edition', w / 2, h * .48);
  c.fillRect(w * .3, h * .58, w * .4, 2);
  c.font = '600 18px Quicksand, sans-serif'; c.fillText('Echo Lexicon', w / 2, h * .66);
});

const globeTexture = () => paintedTexture('globe', 512, 256, (c, w, h) => {
  c.fillStyle = '#5b8fe0'; c.fillRect(0, 0, w, h);
  c.fillStyle = '#9ed38a';
  const blobs = [[0.18, 0.35, 0.09, 0.14], [0.25, 0.65, 0.05, 0.13], [0.5, 0.32, 0.06, 0.08], [0.53, 0.58, 0.06, 0.14], [0.72, 0.35, 0.13, 0.12], [0.83, 0.7, 0.05, 0.06]];
  for (const [x, y, rx, ry] of blobs) { c.beginPath(); c.ellipse(x * w, y * h, rx * w, ry * h, 0.3, 0, Math.PI * 2); c.fill(); }
  c.fillStyle = 'rgba(255,255,255,0.8)'; c.fillRect(0, 0, w, 10); c.fillRect(0, h - 10, w, 10);
});

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const calendarTexture = () => paintedTexture('calendar', 256, 200, (c, w, h) => {
  c.fillStyle = '#fbfaff'; c.fillRect(0, 0, w, h);
  c.fillStyle = '#7c6cf0'; c.fillRect(0, 0, w, 44);
  const now = new Date();
  c.fillStyle = '#fff'; c.font = 'bold 24px Quicksand, sans-serif'; c.textAlign = 'center';
  c.fillText(MONTHS_EN[now.getMonth()] ?? 'Calendar', w / 2, 31);
  c.fillStyle = '#3b3f6b'; c.font = 'bold 80px Quicksand, sans-serif'; c.fillText(String(now.getDate()), w / 2, 150);
});

/** Clock face; the hands are separate meshes the scene turns to the real time. */
const faceTexture = () => paintedTexture('clockface', 256, 256, (c, w) => {
  c.fillStyle = '#fbfaff'; c.beginPath(); c.arc(w / 2, w / 2, w / 2, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#4b4f7a';
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; c.beginPath(); c.arc(w / 2 + Math.sin(a) * w * 0.4, w / 2 - Math.cos(a) * w * 0.4, i % 3 === 0 ? 7 : 4, 0, Math.PI * 2); c.fill(); }
  whaleShape(c, w * 0.46, w * 0.68, w * 0.07, '#8ea2f0');
});

function clockHands(radius: number, z: number) {
  const hand = (len: number, wd: number, color: string) => {
    const pivot = new T.Group();
    const h = new T.Mesh(g(`hand${len}${wd}`, () => new T.BoxGeometry(wd, len, 0.006)), M('plastic', color));
    h.position.y = len / 2 - 0.004;
    pivot.add(h);
    pivot.position.z = z;
    return pivot;
  };
  const hour = hand(radius * 0.5, radius * 0.09, '#3b3f6b');
  const minute = hand(radius * 0.75, radius * 0.06, '#3b3f6b');
  const second = hand(radius * 0.82, radius * 0.025, '#e26a8b');
  return { hour, minute, second };
}

// ── Builders ─────────────────────────────────────────────────────────────────────────────────────────────
type Builder = (o: BuildOpts) => T.Group;

function glow(color: string, r: number, x: number, y: number, z: number, intensity = '2.2') {
  return sph(r, M('glow', color, intensity), x, y, z, 16, 12);
}

function withLights(gr: T.Group, lights: LightSpec[]) { gr.userData.lights = lights; return gr; }

function book(w: number, h: number, d: number, color: string) {
  const gr = new T.Group();
  gr.add(rb(w, h, d, 0.006, M('paper', '#f7f3ea'), 0, h / 2, 0));
  const cover = M('plastic', color);
  gr.add(rb(w + 0.006, h + 0.008, 0.008, 0.003, cover, 0, h / 2, d / 2));
  gr.add(rb(w + 0.006, h + 0.008, 0.008, 0.003, cover, 0, h / 2, -d / 2));
  gr.add(rb(0.012, h + 0.008, d + 0.01, 0.004, cover, -w / 2, h / 2, 0));
  return gr;
}

const BOOK_COLORS = ['#7c8cf0', '#f09bb8', '#9fd8c8', '#f5c46a', '#b7a6f0', '#6c7bd8', '#e8e3f6', '#8fc9f0', '#d9879c'];

function pot(key: string, r: number, h: number, color: string) {
  return grp(
    lathe(`pot${key}`, [[0, 0], [r * 0.72, 0], [r * 0.82, h * 0.2], [r, h * 0.92], [r * 1.04, h], [r * 0.94, h], [r * 0.9, h * 0.9], [0, h * 0.9]], M('ceramic', color)),
    cyl(r * 0.88, r * 0.88, 0.01, M('soil', '#5a4636'), 0, h * 0.89, 0),
  );
}

function heartLeaf(size: number) {
  return g(`heart${size}`, () => {
    const s = new T.Shape();
    s.moveTo(0, 0);
    s.bezierCurveTo(size * 0.55, size * 0.25, size * 0.6, size * 0.85, 0, size * 1.1);
    s.bezierCurveTo(-size * 0.6, size * 0.85, -size * 0.55, size * 0.25, 0, 0);
    const geom = new T.ShapeGeometry(s, 8);
    const p = geom.attributes.position as T.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setZ(i, -Math.pow(p.getX(i) / size, 2) * size * 0.35); // cupped leaf
    geom.computeVertexNormals();
    return geom;
  });
}

function leaves(count: number, size: number, color: string, spread: number, height: number, droop = 0, seed = 1) {
  const gr = new T.Group();
  const m = M('leaf', color);
  let s = seed;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + r() * 0.6;
    const l = new T.Mesh(heartLeaf(size * (0.7 + r() * 0.5)), m);
    l.castShadow = true;
    const rad = spread * (0.3 + r() * 0.7);
    const y = height * (0.4 + r() * 0.6) - droop * r();
    l.position.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
    l.rotation.set(-0.9 + r() * 0.6 + droop * 0.8, -a + Math.PI / 2, (r() - 0.5) * 0.6);
    gr.add(l);
  }
  return gr;
}

function cloudShape(w: number, d: number) {
  const s = new T.Shape();
  const bumps = 9;
  for (let i = 0; i <= bumps; i++) {
    const a = (i / bumps) * Math.PI * 2;
    const x = Math.cos(a) * w * 0.5, z = Math.sin(a) * d * 0.5;
    if (i === 0) s.moveTo(x, z);
    else {
      const am = ((i - 0.5) / bumps) * Math.PI * 2;
      s.quadraticCurveTo(Math.cos(am) * w * 0.62, Math.sin(am) * d * 0.62, x, z);
    }
  }
  return s;
}

const B: Record<string, Builder> = {
  'desk.corner': (o) => {
    const top = M('paint', tint(o, '#f4efe9'));
    const wood = M('wood', '#e3c39b');
    const gr = grp(
      rb(1.9, 0.05, 0.8, 0.02, wood, 0, 0.735, 0),
      rb(0.5, 0.7, 0.74, 0.02, top, -0.68, 0.36, 0),
      rb(0.04, 0.7, 0.74, 0.01, top, 0.92, 0.36, 0),
      rb(1.3, 0.3, 0.02, 0.01, top, 0.25, 0.55, -0.36),
      // hutch
      rb(0.03, 0.62, 0.3, 0.01, top, -0.93, 1.07, -0.25), rb(0.03, 0.62, 0.3, 0.01, top, 0.93, 1.07, -0.25),
      rb(0.03, 0.62, 0.3, 0.01, top, -0.25, 1.07, -0.25),
      rb(1.9, 0.03, 0.32, 0.01, top, 0, 1.385, -0.24),
      rb(0.66, 0.03, 0.3, 0.01, top, -0.59, 1.07, -0.25),
      rb(1.86, 0.012, 0.012, 0.004, M('glow', '#ffe2b0', '1.8'), 0, 1.36, -0.12),
    );
    for (let i = 0; i < 3; i++) {
      gr.add(rb(0.46, 0.2, 0.02, 0.01, top, -0.68, 0.14 + i * 0.22, 0.375));
      gr.add(rb(0.12, 0.018, 0.02, 0.008, M('brass', '#c9a46a'), -0.68, 0.19 + i * 0.22, 0.392));
    }
    return withLights(gr, [{ pos: [0, 1.32, -0.12], color: '#ffd9a0', intensity: 0.6, distance: 2.2 }]);
  },
  'desk.basic': (o) => {
    const wood = M('wood', tint(o, '#e9dccb'));
    const leg = M('paint', '#f4f2f8');
    const gr = grp(rb(1.4, 0.045, 0.7, 0.015, wood, 0, 0.738, 0));
    for (const [x, z] of [[-0.64, -0.3], [0.64, -0.3], [-0.64, 0.3], [0.64, 0.3]]) gr.add(cyl(0.022, 0.018, 0.72, leg, x, 0.36, z, 16));
    gr.add(rb(0.5, 0.12, 0.6, 0.01, wood, 0.35, 0.64, 0));
    return gr;
  },
  'desk.wood': (o) => {
    const wood = M('woodDark', tint(o, '#8a5a3b'));
    const gr = grp(rb(1.6, 0.06, 0.8, 0.02, wood, 0, 0.75, 0));
    for (const x of [-0.58, 0.58]) {
      gr.add(rb(0.42, 0.66, 0.74, 0.02, wood, x, 0.36, 0));
      for (let i = 0; i < 3; i++) gr.add(rb(0.38, 0.19, 0.015, 0.01, wood, x, 0.14 + i * 0.21, 0.375), cyl(0.012, 0.012, 0.03, M('brass', '#d8b06a'), x, 0.14 + i * 0.21, 0.395, 12));
    }
    gr.add(rb(0.72, 0.1, 0.7, 0.01, wood, 0, 0.67, 0));
    gr.add(rb(1.5, 0.004, 0.55, 0.002, M('fabric', '#3f6a55'), 0, 0.781, 0.02));
    return gr;
  },
  'chair.office': (o) => {
    const fab = M('fabric', tint(o, '#c9c3f0'));
    const frame = M('plastic', '#f4f3fb');
    const gr = new T.Group();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const leg = rb(0.3, 0.035, 0.05, 0.015, frame, Math.cos(a) * 0.14, 0.07, Math.sin(a) * 0.14);
      leg.rotation.y = -a;
      gr.add(leg, sph(0.03, M('rubber', '#4a4d63'), Math.cos(a) * 0.28, 0.03, Math.sin(a) * 0.28, 12, 8));
    }
    gr.add(cyl(0.025, 0.03, 0.36, M('chrome', '#cfd3e2'), 0, 0.26, 0, 16));
    gr.add(rb(0.52, 0.09, 0.5, 0.04, fab, 0, 0.47, 0.02));
    const back = rb(0.48, 0.56, 0.08, 0.05, fab, 0, 0.82, -0.23);
    back.rotation.x = -0.12;
    gr.add(back, rb(0.06, 0.22, 0.04, 0.02, frame, 0, 0.6, -0.24));
    for (const x of [-0.27, 0.27]) gr.add(rb(0.05, 0.03, 0.32, 0.015, frame, x, 0.68, 0.02), rb(0.03, 0.17, 0.03, 0.01, frame, x, 0.58, -0.05));
    gr.add(at(new T.Mesh(heartLeaf(0.05), M('paint', '#8f9cf0')), 0, 0.88, -0.18, Math.PI, 0, Math.PI));
    return gr;
  },
  'chair.simple': (o) => {
    const seat = M('paint', tint(o, '#f6f3ee'));
    const leg = M('wood', '#d9b48a');
    const gr = grp(rb(0.46, 0.05, 0.44, 0.02, seat, 0, 0.46, 0));
    for (const [x, z] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]]) {
      const l = cyl(0.018, 0.014, 0.46, leg, x, 0.23, z, 12);
      l.rotation.set(z > 0 ? 0.06 : -0.06, 0, x > 0 ? -0.06 : 0.06);
      gr.add(l);
    }
    const back = rb(0.44, 0.34, 0.04, 0.03, seat, 0, 0.78, -0.21);
    back.rotation.x = -0.1;
    gr.add(back, cyl(0.014, 0.014, 0.32, leg, -0.18, 0.62, -0.2, 10), cyl(0.014, 0.014, 0.32, leg, 0.18, 0.62, -0.2, 10));
    return gr;
  },
  'bed.single': (o) => {
    const frame = M('paint', '#f3eef6');
    const gr = grp(
      rb(1.15, 0.3, 2.05, 0.04, frame, 0, 0.17, 0),
      rb(1.05, 0.2, 1.95, 0.08, M('fabric', '#f7f6fb'), 0, 0.42, 0.01),
      rb(1.1, 0.07, 1.28, 0.035, M('knit', tint(o, '#9fb4ee')), 0, 0.53, 0.35),
      rb(1.12, 0.06, 0.22, 0.03, M('fabric', '#ffffff'), 0, 0.55, -0.28),
      rb(0.82, 0.13, 0.36, 0.06, M('fabric', '#ffffff'), 0, 0.58, -0.72),
      rb(0.5, 0.11, 0.3, 0.05, M('fabric', '#c8d4ff'), 0.22, 0.66, -0.6),
      rb(1.15, 0.72, 0.08, 0.04, frame, 0, 0.5, -1.0),
      rb(1.1, 0.012, 0.012, 0.004, M('glow', '#ffd9a8', '1.6'), 0, 0.035, 1.02),
    );
    const throwBlanket = rb(1.12, 0.03, 0.5, 0.015, M('knit', '#7f93e0'), 0, 0.57, 0.75);
    gr.add(throwBlanket);
    return gr;
  },
  'bed.drawer': (o) => {
    const frame = M('wood', '#e8d2b6');
    const gr = grp(
      rb(1.25, 0.36, 2.1, 0.03, frame, 0, 0.18, 0),
      rb(1.15, 0.22, 2.0, 0.08, M('fabric', '#f8f5f0'), 0, 0.47, 0.01),
      rb(1.2, 0.08, 1.35, 0.035, M('knit', tint(o, '#b6a6ec')), 0, 0.59, 0.33),
      rb(0.88, 0.14, 0.38, 0.06, M('fabric', '#ffffff'), 0, 0.63, -0.74),
      rb(1.25, 0.9, 0.09, 0.03, frame, 0, 0.55, -1.04),
    );
    for (const z of [-0.45, 0.45]) gr.add(rb(0.02, 0.24, 0.8, 0.01, frame, 0.63, 0.17, z), cyl(0.012, 0.012, 0.06, M('brass', '#c9a46a'), 0.645, 0.18, z, 10));
    return gr;
  },
  'shelf.tall': (o) => {
    const wood = M('paint', tint(o, '#f1ece5'));
    const gr = grp(
      rb(0.03, 1.8, 0.36, 0.01, wood, -0.435, 0.9, 0), rb(0.03, 1.8, 0.36, 0.01, wood, 0.435, 0.9, 0),
      rb(0.9, 1.8, 0.02, 0.005, wood, 0, 0.9, -0.17),
    );
    for (const y of [0.02, 0.42, 0.84, 1.26, 1.68, 1.79]) gr.add(rb(0.9, 0.03, 0.36, 0.01, wood, 0, y - 0.015, 0));
    return gr;
  },
  'shelf.wall': (o) => {
    const wood = M('paint', tint(o, '#f3eee8'));
    return grp(
      rb(1.0, 0.03, 0.26, 0.01, wood, 0, 0.005, 0),
      rb(0.03, 0.14, 0.2, 0.01, M('brass', '#cfa86c'), -0.38, -0.07, -0.02),
      rb(0.03, 0.14, 0.2, 0.01, M('brass', '#cfa86c'), 0.38, -0.07, -0.02),
      rb(0.96, 0.008, 0.008, 0.003, M('glow', '#ffe0b3', '1.4'), 0, -0.012, 0.11),
    );
  },
  nightstand: (o) => {
    const m = M('paint', tint(o, '#f4efe9'));
    const gr = grp(rb(0.46, 0.46, 0.42, 0.02, m, 0, 0.32, 0), rb(0.48, 0.03, 0.44, 0.01, M('wood', '#e3c39b'), 0, 0.555, 0));
    for (const [x, z] of [[-0.19, -0.16], [0.19, -0.16], [-0.19, 0.16], [0.19, 0.16]]) gr.add(cyl(0.015, 0.012, 0.1, M('wood', '#d9b48a'), x, 0.05, z, 10));
    gr.add(rb(0.42, 0.18, 0.015, 0.008, m, 0, 0.42, 0.21), sph(0.018, M('brass', '#c9a46a'), 0, 0.42, 0.225, 12, 8));
    return gr;
  },
  drawers: (o) => {
    const m = M('paint', tint(o, '#f0c27a'));
    const gr = grp(rb(0.85, 0.76, 0.46, 0.02, m, 0, 0.42, 0), rb(0.87, 0.03, 0.48, 0.01, M('wood', '#e8d4b8'), 0, 0.805, 0));
    const sliders: { node: T.Object3D; axis: T.Vector3; travel: number; handle: T.Vector3; open: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const y = 0.17 + i * 0.24, drawer = new T.Group();
      drawer.add(rb(0.78, 0.2, 0.015, 0.01, M('paint', '#f6d394'), 0, y, 0.23), rb(0.16, 0.02, 0.02, 0.008, M('wood', '#9a6a46'), 0, 0.22 + i * 0.24, 0.245));
      // The tray behind the face shows when the drawer is pulled.
      drawer.add(rb(0.7, 0.012, 0.32, 0.002, M('wood', '#9a6a46'), 0, y - .07, .06), rb(0.012, 0.13, 0.32, 0.002, m, -.345, y, .06), rb(0.012, 0.13, 0.32, 0.002, m, .345, y, .06));
      gr.add(drawer);
      sliders.push({ node: drawer, axis: new T.Vector3(0, 0, 1), travel: .26, handle: new T.Vector3(0, 0.22 + i * 0.24, 0.255), open: 0 });
    }
    gr.userData.sliders = sliders;
    for (const [x, z] of [[-0.36, -0.18], [0.36, -0.18], [-0.36, 0.18], [0.36, 0.18]]) gr.add(cyl(0.02, 0.015, 0.06, M('wood', '#c49a6c'), x, 0.03, z, 10));
    return gr;
  },
  'table.side': (o) => {
    const m = M('wood', tint(o, '#d9b48a'));
    return grp(cyl(0.28, 0.28, 0.035, m, 0, 0.545, 0, 40), cyl(0.03, 0.04, 0.52, m, 0, 0.27, 0, 16), cyl(0.16, 0.18, 0.025, m, 0, 0.012, 0, 32));
  },
  armchair: (o) => {
    const f = M('fabric', tint(o, '#a99be8'));
    const gr = grp(
      rb(0.86, 0.3, 0.78, 0.08, f, 0, 0.27, 0),
      rb(0.62, 0.14, 0.62, 0.06, M('fabric', '#ffffff'), 0, 0.47, 0.07),
      rb(0.86, 0.62, 0.18, 0.08, f, 0, 0.68, -0.32),
      rb(0.14, 0.42, 0.74, 0.07, f, -0.38, 0.5, 0.02), rb(0.14, 0.42, 0.74, 0.07, f, 0.38, 0.5, 0.02),
      rb(0.4, 0.3, 0.12, 0.06, M('knit', '#f6f2ea'), 0.12, 0.66, -0.17),
    );
    for (const [x, z] of [[-0.35, -0.3], [0.35, -0.3], [-0.35, 0.3], [0.35, 0.3]]) gr.add(cyl(0.025, 0.018, 0.12, M('wood', '#b98b5f'), x, 0.06, z, 10));
    return gr;
  },
  sofa: (o) => {
    const f = M('fabric', tint(o, '#8fa3e8'));
    const gr = grp(rb(1.8, 0.3, 0.82, 0.08, f, 0, 0.27, 0), rb(1.8, 0.55, 0.2, 0.08, f, 0, 0.65, -0.32), rb(0.16, 0.42, 0.8, 0.07, f, -0.82, 0.48, 0), rb(0.16, 0.42, 0.8, 0.07, f, 0.82, 0.48, 0));
    for (const x of [-0.37, 0.37]) gr.add(rb(0.72, 0.13, 0.6, 0.06, M('fabric', '#eef1ff'), x, 0.47, 0.06));
    gr.add(rb(0.38, 0.3, 0.12, 0.06, M('knit', '#f5d6e3'), -0.5, 0.66, -0.17), rb(0.38, 0.3, 0.12, 0.06, M('knit', '#fef3d8'), 0.48, 0.66, -0.17));
    for (const [x, z] of [[-0.8, -0.32], [0.8, -0.32], [-0.8, 0.32], [0.8, 0.32]]) gr.add(cyl(0.025, 0.018, 0.12, M('wood', '#b98b5f'), x, 0.06, z, 10));
    return gr;
  },
  beanbag: (o) => {
    const s = sph(0.42, M('fabric', tint(o, '#b7a8f1')), 0, 0.28, 0, 32, 20);
    s.scale.set(1, 0.68, 1);
    const dent = sph(0.3, M('fabric', tint(o, '#b7a8f1')), 0, 0.5, -0.12, 24, 16);
    dent.scale.set(1, 0.55, 0.7);
    return grp(s, dent);
  },
  pouf: (o) => grp(lathe('pouf', [[0, 0], [0.26, 0], [0.3, 0.05], [0.31, 0.25], [0.29, 0.38], [0.2, 0.42], [0, 0.425]], M('knit', tint(o, '#f4f1ee')))),
  'rug.round': (o) => {
    const ring = mesh(g('rugR2', () => new T.TorusGeometry(1.06, 0.02, 8, 64)), M('plush', '#ffffff'), 0, 0.016, 0, false);
    ring.rotation.x = Math.PI / 2;
    return grp(mesh(g('rugR', () => new T.CylinderGeometry(1.1, 1.1, 0.018, 64)), M('plush', tint(o, '#c7cdf6')), 0, 0.009, 0, false), ring);
  },
  'rug.rect': (o) => grp(rb(2.4, 0.016, 1.6, 0.008, M('plush', tint(o, '#d8d2f4')), 0, 0.008, 0), rb(2.2, 0.018, 1.4, 0.008, M('plush', '#f2f0fb'), 0, 0.01, 0)),
  'rug.cloud': (o) => {
    const geom = g('rugCloud', () => {
      const e = new T.ExtrudeGeometry(cloudShape(2.0, 1.4), { depth: 0.03, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.03, bevelSegments: 2, curveSegments: 10 });
      e.rotateX(Math.PI / 2);
      e.translate(0, 0.03, 0);
      return e;
    });
    return grp(mesh(geom, M('plush', tint(o, '#f1f0fb')), 0, 0, 0, false));
  },
  whiteboard: () => grp(
    rb(1.3, 0.85, 0.03, 0.015, M('metal', '#c9cede'), 0, 0, 0),
    plane('wb', 1.24, 0.79, M('paint', '#fdfdff'), 0, 0, 0.0155),
    rb(0.6, 0.03, 0.06, 0.01, M('metal', '#c9cede'), 0, -0.44, 0.03),
    ...['#e26a8b', '#5b7be0', '#3fb38a'].map((c, i) => rb(0.12, 0.018, 0.018, 0.008, M('plastic', c), -0.15 + i * 0.15, -0.415, 0.04)),
    rb(0.4, 0.008, 0.002, 0.001, M('paint', '#5b7be0'), -0.3, 0.2, 0.017), rb(0.55, 0.008, 0.002, 0.001, M('paint', '#e26a8b'), -0.2, 0.1, 0.017),
    rb(0.3, 0.008, 0.002, 0.001, M('paint', '#3fb38a'), -0.35, 0.0, 0.017),
  ),
  pinboard: (o) => {
    const gr = grp(rb(0.9, 0.65, 0.03, 0.01, M('wood', '#e3c39b'), 0, 0, 0), rb(0.84, 0.59, 0.01, 0.005, M('plush', tint(o, '#d6a46b')), 0, 0, 0.016));
    const papers = [['#fff6a8', -0.25, 0.12, 0.1], ['#ffc9d9', 0.08, 0.15, -0.08], ['#c9e8ff', 0.27, -0.08, 0.06], ['#d8f5d0', -0.12, -0.15, -0.05], ['#ffffff', 0.25, 0.16, 0.04]] as const;
    for (const [c, x, y, r] of papers) {
      const p = rb(0.18, 0.16, 0.004, 0.002, M('paper', c), x, y, 0.024);
      p.rotation.z = r;
      gr.add(p, sph(0.012, M('plastic', '#e26a8b'), x, y + 0.06, 0.03, 8, 6));
    }
    return gr;
  },

  // Lighting
  'lamp.desk': (o) => {
    const m = M('paint', tint(o, '#f2d9a7'));
    const joint = new T.Vector3(-.06, .31, 0), head = new T.Vector3(.2, .5, .15);
    const segment = (a: T.Vector3, b: T.Vector3) => {
      const delta = b.clone().sub(a), middle = a.clone().add(b).multiplyScalar(.5);
      const arm = cyl(.012, .012, delta.length(), M('chrome', '#d9dce8'), middle.x, middle.y, middle.z, 10);
      arm.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), delta.normalize());
      return arm;
    };
    const arm1 = segment(new T.Vector3(0, .03, 0), joint), arm2 = segment(joint, head);
    const shade = lathe('lampshade', [[0.02, 0], [0.05, 0.02], [0.11, 0.11], [0.115, 0.12], [0.02, 0.01]], m);
    shade.position.set(0.2, 0.5, 0.15); shade.rotation.set(Math.PI + 0.5, 0, 0.5);
    const gr = grp(cyl(0.09, 0.1, 0.03, m, 0, 0.015, 0, 32), arm1, arm2, sph(.018, m, joint.x, joint.y, joint.z, 12, 8), shade, glow('#fff1cf', 0.035, 0.22, 0.46, 0.18));
    return withLights(gr, [{ pos: [0.22, 0.42, 0.2], color: '#ffd8a0', intensity: 1.4, distance: 2.4 }]);
  },
  'lamp.floor': (o) => {
    const shade = lathe('floorshade', [[0.2, 0], [0.22, 0], [0.16, 0.3], [0.14, 0.3]], M('fabric', tint(o, '#efe6f9')));
    shade.position.y = 1.32;
    const gr = grp(cyl(0.16, 0.18, 0.03, M('brass', '#c9a46a'), 0, 0.015, 0), cyl(0.012, 0.012, 1.4, M('brass', '#c9a46a'), 0, 0.72, 0, 12), shade, glow('#ffe8c4', 0.06, 0, 1.42, 0, '2.6'));
    return withLights(gr, [{ pos: [0, 1.4, 0], color: '#ffd8a8', intensity: 1.6, distance: 3.2 }]);
  },
  'lamp.moon': () => withLights(grp(rb(0.16, 0.03, 0.16, 0.012, M('wood', '#c49a6c'), 0, 0.015, 0), sph(0.11, M('glow', '#fff1d0', '1.4'), 0, 0.14, 0, 32, 24)),
    [{ pos: [0, 0.16, 0], color: '#ffe2b0', intensity: 1, distance: 2 }]),
  'lamp.shell': () => {
    const shell = new T.Group();
    for (let i = 0; i < 9; i++) {
      const rib = sph(0.13, M('glow', '#ffe9d6', '1.2'), 0, 0, 0, 16, 10);
      rib.scale.set(0.24, 1, 0.5);
      rib.rotation.z = (i - 4) * 0.28;
      rib.position.set(Math.sin((i - 4) * 0.28) * 0.06, 0.12 - Math.abs(i - 4) * 0.004, 0);
      shell.add(rib);
    }
    return withLights(grp(rb(0.18, 0.04, 0.12, 0.015, M('ceramic', '#f6eef0'), 0, 0.02, 0), shell), [{ pos: [0, 0.14, 0.05], color: '#ffd7b8', intensity: 1, distance: 2 }]);
  },
  'lamp.jelly': () => {
    const bell = sph(0.06, M('glow', '#e8b4ff', '1.8'), 0, 0.17, 0, 20, 12);
    bell.scale.y = 0.75;
    const gr = grp(cyl(0.1, 0.11, 0.04, M('wood', '#c49a6c'), 0, 0.02, 0), sph(0.1, M('glass', '#e9f2ff'), 0, 0.14, 0, 32, 20), bell);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      gr.add(tube(`jt${i}`, [[Math.cos(a) * 0.03, 0.15, Math.sin(a) * 0.03], [Math.cos(a) * 0.035, 0.1, Math.sin(a) * 0.035], [Math.cos(a + 0.4) * 0.03, 0.06, Math.sin(a + 0.4) * 0.03]], 0.004, M('glow', '#d9a0ff', '1.2')));
    }
    return withLights(gr, [{ pos: [0, 0.16, 0], color: '#d9a8ff', intensity: 0.8, distance: 1.6 }]);
  },
  'lamp.lantern': () => {
    const brass = M('brass', '#c9a046');
    const gr = grp(cyl(0.08, 0.09, 0.03, brass, 0, 0.015, 0), cyl(0.07, 0.07, 0.2, M('glass', '#fff2d0'), 0, 0.13, 0), cyl(0.05, 0.08, 0.05, brass, 0, 0.255, 0), torus(0.03, 0.006, brass, Math.PI, 0, 0.29, 0), glow('#ffd28a', 0.035, 0, 0.13, 0, '2.4'));
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.78; gr.add(cyl(0.006, 0.006, 0.2, brass, Math.cos(a) * 0.07, 0.13, Math.sin(a) * 0.07, 6)); }
    return withLights(gr, [{ pos: [0, 0.15, 0], color: '#ffc879', intensity: 1.2, distance: 2.4 }]);
  },

  // Plants
  'plant.pothos': () => {
    const foliage = at(leaves(16, 0.06, '#4f9a5e', 0.14, 0.22, 0.25, 3), 0, 0.12, 0);
    // The trailing leaves can touch the shelf. The pot rests on its ceramic base.
    foliage.position.y -= Math.min(0, new T.Box3().setFromObject(foliage, true).min.y);
    return grp(pot('pothos', 0.1, 0.16, '#f6f1ff'), foliage);
  },
  'plant.monstera': () => {
    const gr = grp(pot('monstera', 0.2, 0.36, '#f3efe8'));
    const leafM = M('leaf', '#3f8a52');
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const h = 0.6 + (i % 3) * 0.18;
      gr.add(tube(`mst${i}`, [[0, 0.32, 0], [Math.cos(a) * 0.08, 0.32 + h * 0.6, Math.sin(a) * 0.08], [Math.cos(a) * 0.22, 0.32 + h, Math.sin(a) * 0.22]], 0.008, M('leaf', '#4f8a3f')));
      const l = new T.Mesh(heartLeaf(0.24), leafM);
      l.castShadow = true;
      l.position.set(Math.cos(a) * 0.22, 0.32 + h, Math.sin(a) * 0.22);
      l.rotation.set(-1.0, -a + Math.PI / 2, 0);
      gr.add(l);
    }
    return gr;
  },
  'plant.snake': () => {
    const gr = grp(pot('snake', 0.15, 0.3, '#f7f4ef'));
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2, h = 0.45 + (i % 4) * 0.12;
      const blade = mesh(g(`blade${i % 4}`, () => { const c = new T.ConeGeometry(0.035, h, 4); c.scale(1, 1, 0.3); c.translate(0, h / 2, 0); return c; }), M('leaf', i % 2 ? '#3f7d4a' : '#5c9a52'), Math.cos(a) * 0.05, 0.27, Math.sin(a) * 0.05);
      blade.rotation.set(Math.sin(a) * 0.18, a, -Math.cos(a) * 0.18);
      gr.add(blade);
    }
    return gr;
  },
  'plant.succulent': () => {
    const gr = grp(pot('succ', 0.06, 0.07, '#ffd6e3'));
    for (let i = 0; i < 12; i++) {
      const a = i * 2.4, r = 0.012 + (i / 12) * 0.035;
      const p = sph(0.018, M('leaf', '#8ac7a0'), Math.cos(a) * r, 0.085, Math.sin(a) * r, 10, 8);
      p.scale.set(0.6, 0.5, 1.4);
      p.rotation.set(0.4, -a, 0);
      gr.add(p);
    }
    return gr;
  },
  'plant.hanging': () => {
    const gr = grp(lathe('hang', [[0.04, -0.08], [0.12, -0.04], [0.14, 0.06], [0.13, 0.08], [0.04, 0]], M('ceramic', '#f6f1ff'), 0, 0, 0.02));
    for (let i = 0; i < 4; i++) {
      const x = -0.1 + i * 0.07;
      gr.add(tube(`vine${i}`, [[x, 0.06, 0.05], [x + 0.03, -0.15, 0.1], [x - 0.02, -0.4 - i * 0.08, 0.08]], 0.004, M('leaf', '#4f8a3f')));
      for (let k = 0; k < 5; k++) { const l = new T.Mesh(heartLeaf(0.04), M('leaf', '#5aa25f')); l.position.set(x + (k % 2 ? 0.02 : -0.02), 0.02 - k * 0.09 - i * 0.02, 0.1); l.rotation.set(-0.3, k, Math.PI); gr.add(l); }
    }
    gr.add(leaves(8, 0.05, '#4f9a5e', 0.1, 0.12, 0.1, 9));
    return gr;
  },

  // Decor
  'art.whale': () => {
    const banner = plane('artwhale', 0.66, 0.82, new T.MeshStandardMaterial({ map: artTexture('whale'), roughness: 0.9, side: T.DoubleSide }), 0, 0, 0.012);
    const gr = grp(banner, cyl(0.012, 0.012, 0.8, M('wood', '#c49a6c'), 0, 0.43, 0.012, 10));
    gr.children[1].rotation.z = Math.PI / 2;
    for (const x of [-0.25, 0, 0.25]) gr.add(cyl(0.01, 0.025, 0.08, M('fabric', '#ffffff'), x, -0.45, 0.012, 8));
    gr.add(tube('artstring', [[-0.38, 0.43, 0.012], [0, 0.6, 0.008], [0.38, 0.43, 0.012]], 0.003, M('paint', '#8f7a63')));
    return gr;
  },
  'art.sky': () => grp(rb(0.6, 0.76, 0.03, 0.01, M('wood', '#f0e2cc'), 0, 0, 0), plane('artsky', 0.52, 0.68, new T.MeshStandardMaterial({ map: artTexture('sky'), roughness: 0.8 }), 0, 0, 0.016)),
  'art.coral': () => grp(rb(0.6, 0.76, 0.03, 0.01, M('paint', '#ffffff'), 0, 0, 0), plane('artcoral', 0.52, 0.68, new T.MeshStandardMaterial({ map: artTexture('coral'), roughness: 0.8 }), 0, 0, 0.016)),
  'art.leaf': () => grp(rb(0.5, 0.64, 0.03, 0.01, M('wood', '#c49a6c'), 0, 0, 0), plane('artleaf', 0.42, 0.56, new T.MeshStandardMaterial({ map: artTexture('leaf'), roughness: 0.8 }), 0, 0, 0.016)),
  'art.photos': () => {
    const gr = grp(tube('photostring', [[-0.36, 0.1, 0.01], [0, 0.02, 0.012], [0.36, 0.1, 0.01]], 0.003, M('paint', '#8f7a63')));
    const tex = ['sky', 'coral', 'whale', 'leaf'];
    tex.forEach((k, i) => {
      const x = -0.27 + i * 0.18, y = 0.04 - Math.sin((i / 3) * Math.PI) * 0.06;
      const p = grp(rb(0.13, 0.16, 0.004, 0.002, M('paper', '#ffffff'), 0, 0, 0), plane(`ph${k}`, 0.11, 0.11, new T.MeshStandardMaterial({ map: artTexture(k) }), 0, 0.012, 0.003));
      at(p, x, y - 0.09, 0.012, 0, 0, (i - 1.5) * 0.08);
      gr.add(p);
    });
    return gr;
  },
  'whale.plush': () => {
    const blue = M('plush', '#8fa3ee');
    const body = sph(0.3, blue, 0, 0.2, 0, 32, 20);
    body.scale.set(1.35, 0.7, 0.82);
    const belly = sph(0.28, M('plush', '#eef1ff'), -0.02, 0.15, 0, 32, 20);
    belly.scale.set(1.25, 0.5, 0.74);
    const tail = mesh(g('whtail', () => { const s = new T.Shape(); s.moveTo(0, 0); s.quadraticCurveTo(0.12, 0.1, 0.22, 0.04); s.quadraticCurveTo(0.12, 0, 0.22, -0.04); s.quadraticCurveTo(0.12, -0.1, 0, 0); const e = new T.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 3 }); e.rotateX(Math.PI / 2); return e; }), blue, 0.36, 0.25, 0);
    tail.rotation.z = 0.35;
    const fin = sph(0.08, blue, -0.05, 0.12, 0.24, 12, 8); fin.scale.set(1.2, 0.3, 0.8);
    const eyeL = sph(0.022, M('plastic', '#22264a'), -0.3, 0.27, 0.15, 10, 8);
    const eyeR = sph(0.022, M('plastic', '#22264a'), -0.3, 0.27, -0.15, 10, 8);
    const cheek = sph(0.03, M('plush', '#ffb6c8'), -0.32, 0.2, 0.17, 10, 8);
    return grp(body, belly, tail, fin, eyeL, eyeR, cheek);
  },
  lighthouse: () => {
    const gr = grp(cyl(0.07, 0.08, 0.03, M('paint', '#7c8cf0'), 0, 0.015, 0));
    for (let i = 0; i < 4; i++) gr.add(cyl(0.055 - i * 0.006, 0.06 - i * 0.006, 0.07, M('paint', i % 2 ? '#e26a8b' : '#ffffff'), 0, 0.065 + i * 0.07, 0));
    gr.add(cyl(0.04, 0.04, 0.05, M('glass', '#fff4c8'), 0, 0.35, 0), glow('#fff1b0', 0.025, 0, 0.35, 0, '2.6'), mesh(g('lhroof', () => new T.ConeGeometry(0.05, 0.06, 16)), M('paint', '#e26a8b'), 0, 0.4, 0));
    return withLights(gr, [{ pos: [0, 0.35, 0], color: '#fff0c0', intensity: 0.5, distance: 1.2 }]);
  },
  coral: () => {
    const gr = grp(rb(0.18, 0.03, 0.12, 0.01, M('ceramic', '#f6eef0'), 0, 0.015, 0));
    const pink = M('ceramic', '#ff9fc3');
    const branch = (x: number, y: number, a: number, len: number, d: number, key: string): void => {
      if (d === 0) return;
      const x2 = x + Math.sin(a) * len, y2 = y + Math.cos(a) * len;
      gr.add(tube(`cor${key}`, [[x, y, 0], [(x + x2) / 2, (y + y2) / 2, 0.005], [x2, y2, 0]], 0.008 * d * 0.6, pink));
      branch(x2, y2, a + 0.5, len * 0.72, d - 1, key + 'a');
      branch(x2, y2, a - 0.45, len * 0.7, d - 1, key + 'b');
    };
    branch(0, 0.03, 0, 0.08, 4, 'c');
    return gr;
  },
  globe: () => {
    const ball = sph(0.11, new T.MeshStandardMaterial({ map: globeTexture(), roughness: 0.45 }), 0, 0.2, 0, 40, 24);
    ball.rotation.z = 0.41;
    const ring = torus(0.125, 0.006, M('brass', '#c9a046'), Math.PI * 1.4, 0, 0.2, 0);
    ring.rotation.set(0, Math.PI / 2, 0.41 + Math.PI * 0.2);
    const gr = grp(cyl(0.08, 0.09, 0.025, M('woodDark', '#7a4b2f'), 0, 0.012, 0), cyl(0.012, 0.016, 0.07, M('brass', '#c9a046'), 0, 0.06, 0, 12), ball, ring);
    gr.userData.spin = ball;
    return gr;
  },
  telescope: () => {
    const brass = M('brass', '#c9a046');
    const gr = new T.Group();
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; const leg = cyl(0.012, 0.012, 0.9, M('woodDark', '#7a4b2f'), Math.cos(a) * 0.15, 0.42, Math.sin(a) * 0.15, 8); leg.rotation.set(Math.sin(a) * 0.32, 0, -Math.cos(a) * 0.32); gr.add(leg); }
    const t = cyl(0.04, 0.055, 0.7, M('paint', '#3d4a8a'), 0, 0.92, 0.05, 24);
    t.rotation.x = -1.0;
    gr.add(t, cyl(0.06, 0.06, 0.03, brass, 0, 0.86, 0.0), sph(0.05, brass, 0, 0.84, 0, 12, 8));
    return gr;
  },
  rocket: () => {
    const body = lathe('rocket', [[0, 0], [0.04, 0.02], [0.05, 0.12], [0.045, 0.22], [0.02, 0.3], [0, 0.32]], M('ceramic', '#f6f7ff'), 0, 0.03, 0);
    const gr = grp(body, sph(0.018, M('glass', '#8fd3ff'), 0, 0.2, 0.045, 12, 8));
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; const fin = rb(0.006, 0.08, 0.05, 0.003, M('plastic', '#e26a8b'), Math.cos(a) * 0.05, 0.07, Math.sin(a) * 0.05); fin.rotation.y = -a; gr.add(fin); }
    gr.add(glow('#ffb36b', 0.025, 0, 0.02, 0, '2'));
    return gr;
  },
  crystal: () => {
    const c = mesh(g('crystal', () => new T.OctahedronGeometry(0.07, 0)), M('glow', '#b48cff', '1.4'), 0, 0.12, 0);
    c.scale.set(0.7, 1.4, 0.7);
    const c2 = mesh(g('crystal2', () => new T.OctahedronGeometry(0.04, 0)), M('glow', '#d8b4ff', '1.2'), 0.05, 0.07, 0.02);
    c2.scale.set(0.6, 1.3, 0.6); c2.rotation.z = -0.4;
    const gr = grp(cyl(0.07, 0.08, 0.03, M('woodDark', '#5a3c2a'), 0, 0.015, 0), c, c2);
    gr.userData.float = c;
    return withLights(gr, [{ pos: [0, 0.14, 0], color: '#c49bff', intensity: 0.8, distance: 1.6 }]);
  },

  // Study
  laptop: () => {
    const shell = M('metal', '#d6d9e6');
    const shot = deskScreen();
    const glass = new T.MeshStandardMaterial({ map: shot, emissive: '#ffffff', emissiveMap: shot, emissiveIntensity: 0.82, roughness: 0.3 });
    const face = plane('lapscr', 0.33, 0.21, glass, 0, 0.12, 0.007);
    const screen = grp(rb(0.36, 0.24, 0.012, 0.008, shell, 0, 0.12, 0), face);
    at(screen, 0, 0.012, -0.12, 0, -0.28);
    const gr = grp(rb(0.36, 0.014, 0.25, 0.008, shell, 0, 0.007, 0), keysOn(0.3, 0.1, 0.0142, -0.03), rb(0.1, 0.0015, 0.065, 0.001, M('plastic', '#b9bdd0'), 0, 0.0143, 0.08), screen);
    // The lid turns on its hinge; the screen goes dark as it shuts.
    gr.userData.lid = screen; gr.userData.lidOpen = -0.28; gr.userData.lidShut = 1.5;
    gr.userData.screen = glass; gr.userData.screenGlow = 0.82;
    gr.userData.screenMesh = face; gr.userData.screenSize = [0.33, 0.21];
    return gr;
  },
  monitor: () => {
    const shot = deskScreen();
    const glass = new T.MeshStandardMaterial({ map: shot, emissive: '#ffffff', emissiveMap: shot, emissiveIntensity: 0.86, roughness: 0.28 });
    const face = plane('monscr', 0.58, 0.32, glass, 0, 0, 0.013);
    const screen = grp(rb(0.62, 0.36, 0.025, 0.01, M('plastic', '#25283d'), 0, 0, 0), face);
    at(screen, 0, 0.36, 0);
    const gr = grp(rb(0.22, 0.012, 0.16, 0.006, M('metal', '#cfd3e2'), 0, 0.006, 0), rb(0.04, 0.2, 0.03, 0.01, M('metal', '#cfd3e2'), 0, 0.11, -0.03), screen);
    gr.userData.screen = glass; gr.userData.screenGlow = 0.86;
    gr.userData.screenMesh = face; gr.userData.screenSize = [0.58, 0.32];
    gr.userData.noSignal = noSignalScreen();
    gr.userData.desktop = shot;
    return gr;
  },
  'pc.tower': () => {
    const led = new T.MeshStandardMaterial({ color: '#7ce7ff', emissive: '#7ce7ff', emissiveIntensity: 1.6 });
    const body = rb(0.2, 0.42, 0.42, 0.012, M('plastic', '#23263a'), 0, 0.21, 0);
    const face = plane('towerface', 0.176, 0.396, new T.MeshStandardMaterial({ map: towerFace(), roughness: 0.55, metalness: 0.2 }), 0, 0.21, 0.2105);
    const button = cyl(0.011, 0.011, 0.004, M('metal', '#cfd3e2'), 0, 0.36, 0.2125);
    button.rotation.x = Math.PI / 2;
    const light = cyl(0.0035, 0.0035, 0.003, led, 0.03, 0.36, 0.2125);
    light.rotation.x = Math.PI / 2;
    const gr = grp(body, face, button, light);
    gr.userData.led = led;
    return gr;
  },
  keyboard: () => {
    const base = rb(0.44, 0.016, 0.15, 0.006, M('plastic', '#2a2e44'), 0, 0.008, 0);
    return grp(base, keysOn(0.42, 0.13, 0.0165, 0));
  },
  'mouse.pc': () => {
    const shell = mesh(g('mouseshell', () => new T.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)), M('plastic', '#e4e6f1'));
    shell.scale.set(0.034, 0.03, 0.056);
    const foot = cyl(0.0325, 0.0325, 0.002, M('plastic', '#3a3e55'), 0, 0.001, 0);
    foot.scale.z = 1.68;
    const wheel = cyl(0.007, 0.007, 0.007, M('plastic', '#3a3e55'), 0, 0.0265, -0.022);
    wheel.rotation.z = Math.PI / 2;
    return grp(shell, foot, wheel);
  },
  'book.single': (o) => {
    // Lying on its back cover, spine to the left: the size a hand takes from a shelf.
    const b = book(0.15, 0.22, 0.032, tint(o, BOOK_COLORS[0]));
    b.rotation.set(Math.PI / 2, 0, 0);
    b.position.set(0, 0.021, -0.11);
    return grp(b);
  },
  'books.stack': () => {
    const gr = new T.Group();
    const books: T.Object3D[] = [];
    let y = 0;
    [[0.24, 0.045, 0.18, 0], [0.22, 0.035, 0.17, 3], [0.2, 0.05, 0.16, 1], [0.21, 0.03, 0.15, 4]].forEach(([w, h, d, c], i) => {
      const b = book(w, h, d, BOOK_COLORS[c]);
      b.rotation.set(0, (i - 1.5) * 0.18, Math.PI / 2);
      b.position.set(0, y + h / 2, 0);
      b.rotation.set(Math.PI / 2, 0, (i - 1.5) * 0.18);
      b.position.y = y + 0.005;
      y += h;
      b.userData.color = BOOK_COLORS[c];
      gr.add(b);
      books.push(b);
    });
    gr.userData.books = books;
    return gr;
  },
  'books.row': () => {
    const gr = new T.Group();
    const books: T.Object3D[] = [];
    let x = -0.22;
    for (let i = 0; i < 9; i++) {
      const w = 0.03 + ((i * 7) % 3) * 0.008, h = 0.2 + ((i * 5) % 4) * 0.025;
      const b = book(0.15, h, w, BOOK_COLORS[(i * 4) % BOOK_COLORS.length]);
      b.rotation.y = Math.PI / 2;
      b.position.set(x + w / 2, 0, 0);
      if (i === 8) { b.rotation.z = -0.25; b.position.x += 0.02; }
      // Each cover rests on the same shelf, including the tilted end volume.
      // Otherwise its protruding corner becomes the entire row's only support.
      b.position.y -= new T.Box3().setFromObject(b, true).min.y;
      x += w + 0.004;
      b.userData.color = BOOK_COLORS[(i * 4) % BOOK_COLORS.length];
      gr.add(b);
      books.push(b);
    }
    gr.userData.books = books;
    return gr;
  },
  dictionary: () => {
    // A thick reference book lying on its back cover: cloth binding, thin paper block, gilt title, thumb-index tabs on the fore-edge.
    const w = 0.17, d = 0.245, h = 0.066, cloth = M('fabric', '#1d2c50');
    const gr = grp(rb(w - 0.006, h - 0.012, d - 0.008, 0.004, M('paper', '#f4efe2'), 0.003, h / 2, 0));
    gr.add(rb(w + 0.004, 0.006, d + 0.006, 0.002, cloth, 0, 0.003, 0));
    const top = new T.MeshStandardMaterial({ map: dictionaryTexture(), roughness: 0.8 });
    gr.add(rb(w + 0.004, 0.006, d + 0.006, 0.002, cloth, 0, h - 0.003, 0));
    const face = plane('dictcover', w, d, top, 0, h + 0.0002, 0); face.rotation.x = -Math.PI / 2; gr.add(face);
    gr.add(rb(0.012, h, d + 0.006, 0.005, cloth, -w / 2 - 0.002, h / 2, 0));
    for (let i = 0; i < 6; i++) gr.add(rb(0.004, 0.008, 0.016, 0.001, M('plastic', i % 2 ? '#c9a95a' : '#e1e4ee'), w / 2 + 0.0005, h * (0.25 + i * 0.1), -d / 2 + 0.03 + i * 0.035));
    return gr;
  },
  notebook: () => {
    const cover = new T.MeshStandardMaterial({ map: coverTexture(), roughness: 0.7 });
    const gr = grp(rb(0.22, 0.02, 0.28, 0.004, M('paper', '#faf8f2'), 0, 0.01, 0), plane('nbcover', 0.22, 0.28, cover, 0, 0.0205, 0));
    gr.children[1].rotation.x = -Math.PI / 2;
    for (let i = 0; i < 8; i++) gr.add(torus(0.008, 0.002, M('chrome', '#cfd3e2'), Math.PI * 2, -0.11, 0.012, -0.12 + i * 0.034));
    return gr;
  },
  pencup: () => {
    const gr = grp(cyl(0.045, 0.04, 0.1, M('ceramic', '#b7a8f1'), 0, 0.05, 0, 24));
    ['#f5c46a', '#5b7be0', '#e26a8b', '#3fb38a'].forEach((c, i) => { const p = cyl(0.006, 0.006, 0.16, M('plastic', c), Math.cos(i * 1.6) * 0.018, 0.12, Math.sin(i * 1.6) * 0.018, 6); p.rotation.set(Math.sin(i) * 0.15, 0, Math.cos(i) * 0.15); gr.add(p); });
    return gr;
  },
  flashbox: () => {
    const gr = grp(rb(0.24, 0.09, 0.18, 0.01, M('plastic', '#a7b6f6'), 0, 0.045, 0));
    for (let i = 0; i < 7; i++) { const c = rb(0.2, 0.12, 0.003, 0.002, M('paper', i % 2 ? '#ffffff' : '#fff6e0'), 0, 0.1, -0.06 + i * 0.018); c.rotation.x = -0.12; gr.add(c); }
    return gr;
  },
  'docs.stack': () => {
    const gr = new T.Group();
    for (let i = 0; i < 6; i++) { const p = rb(0.21, 0.006, 0.28, 0.002, M('paper', i % 3 ? '#fdfcf8' : '#eef3ff'), 0, 0.003 + i * 0.006, 0); p.rotation.y = (i - 3) * 0.04; gr.add(p); }
    gr.add(rb(0.04, 0.012, 0.03, 0.004, M('chrome', '#cfd3e2'), -0.06, 0.04, -0.13));
    return gr;
  },
  'calendar.desk': () => {
    const page = plane('calpage', 0.16, 0.125, new T.MeshStandardMaterial({ map: calendarTexture(), roughness: 0.8 }), 0, 0.075, 0.02);
    page.rotation.x = -0.2;
    return grp(rb(0.18, 0.012, 0.11, 0.004, M('wood', '#d9b48a'), 0, 0.006, 0), page, torus(0.006, 0.0015, M('chrome', '#cfd3e2'), Math.PI * 2, -0.04, 0.14, 0.03), torus(0.006, 0.0015, M('chrome', '#cfd3e2'), Math.PI * 2, 0.04, 0.14, 0.03));
  },
  mug: (o) => {
    const handle = torus(0.028, 0.008, M('ceramic', tint(o, '#ffffff')), Math.PI, 0.045, 0.055, 0);
    handle.rotation.z = -Math.PI / 2;
    return grp(lathe('mug', [[0, 0], [0.042, 0], [0.045, 0.1], [0.04, 0.1], [0.038, 0.012], [0, 0.012]], M('ceramic', tint(o, '#ffffff'))), cyl(0.038, 0.038, 0.004, M('paint', '#7a5236'), 0, 0.085, 0, 20), handle);
  },
  'clock.desk': () => {
    const face = plane('clkdesk', 0.12, 0.12, new T.MeshStandardMaterial({ map: faceTexture(), roughness: 0.6, transparent: true }), 0, 0.1, 0.031);
    const hands = clockHands(0.055, 0.034);
    const handGroup = at(grp(hands.hour, hands.minute, hands.second), 0, 0.1, 0);
    const gr = grp(cyl(0.075, 0.075, 0.06, M('plastic', '#b7a8f1'), 0, 0.1, 0, 32), face, handGroup, rb(0.12, 0.02, 0.06, 0.008, M('plastic', '#b7a8f1'), 0, 0.01, 0));
    gr.children[0].rotation.x = Math.PI / 2;
    gr.userData.clock = hands;
    return gr;
  },
  'clock.wall': () => {
    const face = plane('clkwall', 0.36, 0.36, new T.MeshStandardMaterial({ map: faceTexture(), roughness: 0.6, transparent: true }), 0, 0, 0.022);
    const hands = clockHands(0.16, 0.026);
    const rim = torus(0.19, 0.018, M('woodDark', '#7a5236'));
    const gr = grp(cyl(0.19, 0.19, 0.03, M('paint', '#fbfaff'), 0, 0, 0, 40), rim, face, grp(hands.hour, hands.minute, hands.second));
    gr.children[0].rotation.x = Math.PI / 2;
    gr.userData.clock = hands;
    return gr;
  },
  'clock.digital': () => {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 96;
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    const screen = plane(`dig${Math.random()}`, 0.2, 0.075, new T.MeshStandardMaterial({ map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.9 }), 0, 0.05, 0.041);
    const gr = grp(rb(0.24, 0.1, 0.08, 0.02, M('plastic', '#3a3f6b'), 0, 0.05, 0), screen);
    gr.userData.digital = { canvas: c, tex, last: '' };
    gr.userData.ownTextures = [tex];
    return gr;
  },
  hourglass: () => {
    const wood = M('woodDark', '#7a4b2f');
    const body = grp(cyl(0.055, 0.055, 0.015, wood, 0, 0.0075 - 0.104, 0), cyl(0.055, 0.055, 0.015, wood, 0, 0.2 - 0.104, 0),
      mesh(g('hgl', () => new T.LatheGeometry([[0.001, 0], [0.04, 0.01], [0.045, 0.05], [0.006, 0.09], [0.045, 0.13], [0.04, 0.17], [0.001, 0.18]].map(([a, b]) => new T.Vector2(a, b)), 24)), M('glass', '#f5f0ff'), 0, 0.012 - 0.104, 0),
      cyl(0.001, 0.03, 0.04, M('paint', '#e8c27a'), 0, 0.035 - 0.104, 0, 16), cyl(0.025, 0.004, 0.03, M('paint', '#e8c27a'), 0, 0.13 - 0.104, 0, 16));
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; body.add(cyl(0.005, 0.005, 0.19, wood, Math.cos(a) * 0.047, 0.1 - 0.104, Math.sin(a) * 0.047, 6)); }
    // The whole glass turns over round its middle.
    body.position.y = 0.104;
    const gr = grp(body);
    gr.userData.flipper = body;
    return gr;
  },
  speaker: () => {
    const gr = grp(rb(0.28, 0.16, 0.16, 0.06, M('fabric', '#cfd6f6'), 0, 0.08, 0), torus(0.05, 0.006, M('glow', '#b4c0ff', '1.6'), Math.PI * 2, 0, 0.08, 0.081));
    gr.add(at(new T.Mesh(heartLeaf(0.03), M('paint', '#7c8cf0')), 0.08, 0.12, 0.082));
    gr.userData.pulse = gr.children[1];
    return gr;
  },
  mic: () => {
    const gr = grp(cyl(0.06, 0.065, 0.015, M('metal', '#4a4d63'), 0, 0.0075, 0, 24), cyl(0.008, 0.008, 0.14, M('chrome', '#cfd3e2'), 0, 0.08, 0, 12));
    const head = grp(cyl(0.03, 0.03, 0.08, M('metal', '#5b5f7e'), 0, 0, 0, 20), sph(0.031, M('metal', '#a8adc6'), 0, 0.04, 0, 20, 12), torus(0.031, 0.004, M('glow', '#9fb4ff', '1.2'), Math.PI * 2, 0, -0.01, 0));
    head.children[2].rotation.x = Math.PI / 2;
    return grp(gr, at(head, 0, 0.18, 0, 0, 0.25));
  },
  headphones: () => {
    const band = torus(0.085, 0.012, M('plastic', '#e9ecfb'), Math.PI, 0, 0.04, 0);
    band.rotation.set(-Math.PI / 2 + 0.2, 0, 0);
    const cupL = cyl(0.045, 0.045, 0.03, M('plastic', '#a7b6f6'), -0.085, 0.04, 0, 24); cupL.rotation.z = Math.PI / 2;
    const cupR = cyl(0.045, 0.045, 0.03, M('plastic', '#a7b6f6'), 0.085, 0.04, 0, 24); cupR.rotation.z = Math.PI / 2;
    const gr = grp(band, cupL, cupR);
    gr.rotation.x = 0;
    return grp(at(gr, 0, 0.0, 0, 0, Math.PI / 2 - 0.3));
  },
  radio: () => {
    const gr = grp(rb(0.28, 0.15, 0.12, 0.025, M('woodDark', '#9a6a46'), 0, 0.075, 0), rb(0.13, 0.1, 0.005, 0.01, M('fabric', '#efe6d2'), -0.05, 0.075, 0.061));
    gr.add(cyl(0.022, 0.022, 0.02, M('brass', '#c9a046'), 0.08, 0.1, 0.065, 20), cyl(0.016, 0.016, 0.02, M('brass', '#c9a046'), 0.08, 0.045, 0.065, 20));
    gr.children[2].rotation.x = Math.PI / 2; gr.children[3].rotation.x = Math.PI / 2;
    gr.add(cyl(0.004, 0.004, 0.2, M('chrome', '#cfd3e2'), 0.1, 0.24, -0.03, 6));
    return gr;
  },
};

// The kit while its file is on its way, or if it never comes: plain, the right size, the same place for the hands.
const stick = (len: number, r: number, m: T.Material, y0 = 0) => cyl(r, r, len, m, 0, y0 + len / 2, 0, 12);
Object.assign(B, {
  'tool.broom': () => {
    const bristles = rb(.28, .1, .032, .004, M('paint', '#c9a24f'), 0, .05, 0);
    bristles.name = 'Bristles';
    bristles.userData.noCollision = true;
    const g = grp(
      stick(1.225, .0125, M('wood', '#c49a6c'), .135),
      cyl(.019, .019, .036, M('metal', '#8c929a'), 0, 1.13, 0, 14),
      cyl(.015, .018, .045, M('metal', '#8c929a'), 0, .1625, 0, 12),
      rb(.3, .042, .048, .01, M('wood', '#5c3b28'), 0, .121, 0),
      bristles,
    );
    g.userData.care = { Bristles: bristles };
    return g;
  },
  'tool.mop': () => {
    const strands = cyl(.05, .15, .17, M('fabric', '#ece9df'), 0, .085, 0, 18);
    strands.name = 'Strands';
    strands.userData.noCollision = true;
    const g = grp(
      stick(1.14, .0125, M('wood', '#c49a6c'), .2),
      cyl(.019, .019, .036, M('metal', '#8c929a'), 0, 1.13, 0, 14),
      rb(.15, .03, .03, .008, M('plastic', '#1f5a60'), 0, .185, 0),
      strands,
    );
    g.userData.care = { Strands: strands };
    return g;
  },
  'tool.dustpan': () => grp(rb(.25, .012, .2, .004, M('plastic', '#1f5a60'), 0, .006, 0), rb(.24, .09, .012, .004, M('plastic', '#1f5a60'), 0, .05, -.1), stick(.26, .011, M('plastic', '#1b1b1d'), .08)),
  'tool.bucket': () => grp(cyl(.158, .125, .3, M('metal', '#b9bdc2'), 0, .15, 0, 28)),
  'kettle.vintage': () => grp(cyl(.09, .1, .2, M('metal', '#a9a59b'), 0, .1, 0, 22)),
  teapot: () => grp(cyl(.07, .07, .12, M('paint', '#ece9df'), 0, .06, 0, 22)),
  teacup: () => grp(cyl(.042, .03, .06, M('paint', '#ece9df'), 0, .03, 0, 20)),
  saucer: () => grp(cyl(.074, .04, .014, M('paint', '#ece9df'), 0, .007, 0, 24)),
  'can.watering': () => grp(cyl(.075, .09, .17, M('metal', '#a9adb0'), 0, .085, 0, 22)),
  'bulb.spare': () => grp(cyl(.03, .014, .08, M('paint', '#eee8d8'), 0, .04, 0, 14)),
  'plant.terracotta': () => grp(cyl(.13, .09, .15, M('paint', '#b9764f'), 0, .075, 0, 22), cyl(.14, .01, .24, M('fabric', '#4f7a3f'), 0, .28, 0, 14)),
  'tool.cloth': () => grp(rb(.2, .018, .15, .006, M('fabric', '#2c6fb3'), 0, .009, 0)),
  'tool.duster': () => grp(stick(.42, .011, M('wood', '#5c3b28'), .2), cyl(.1, .03, .2, M('fabric', '#8a93a6'), 0, .1, 0, 14)),
  'tool.webbrush': () => grp(stick(1.6, .011, M('metal', '#b9bdc2'), .12), cyl(.12, .04, .12, M('fabric', '#ece9df'), 0, .06, 0, 16)),
  'bin.trash': () => grp(cyl(.178, .145, .38, M('paint', '#4d5f50'), 0, .19, 0, 28)),
  'rack.cleaning': () => grp(
    rb(1.02, .04, .36, .008, M('wood', '#c49a6c'), 0, .02, 0),
    rb(.045, 1.42, .05, .008, M('wood', '#c49a6c'), -.495, .73, -.13),
    rb(.045, 1.42, .05, .008, M('wood', '#c49a6c'), .495, .73, -.13),
    rb(.99, .09, .024, .006, M('wood', '#5c3b28'), 0, 1.12, -.14),
    rb(.012, .04, .064, .004, M('metal', '#6d747d'), -.38, 1.14, -.104),
    rb(.012, .04, .064, .004, M('metal', '#6d747d'), -.34, 1.14, -.104),
    rb(.012, .04, .064, .004, M('metal', '#6d747d'), -.15, 1.14, -.104),
    rb(.012, .04, .064, .004, M('metal', '#6d747d'), -.11, 1.14, -.104),
    rb(.012, .04, .064, .004, M('metal', '#6d747d'), .09, 1.14, -.104),
    rb(.012, .04, .064, .004, M('metal', '#6d747d'), .13, 1.14, -.104),
  ),
  'sink.utility': () => grp(rb(.52, .23, .44, .05, M('paint', '#f1f2f4'), 0, .77, 0), stick(.64, .014, M('metal', '#d7d9dd')), rb(.54, .46, .022, .004, M('paint', '#eef0f2'), 0, 1.08, -.21)),
  'trash.paper': () => grp(sph(.036, M('paper', '#ece9df'), 0, .034, 0, 10, 8)),
  'trash.bag': () => grp(sph(.17, M('plastic', '#17181b'), 0, .165, 0, 18, 12)),
} as Record<string, Builder>);

export const BUILDERS = B;

export function isRollingChairKind(kind: string | null | undefined): boolean {
  return kind === 'chair.office' || kind === 'gaming-chair';
}

/** Builds an object; unknown ids (an asset that is no longer in the catalogue) become a small labelled placeholder. */
export function build(kind: string, opts: BuildOpts = {}): T.Group {
  const authored=studyAsset(kind,opts.color);
  if(authored){
    authored.userData.kind=kind;
    if(isRollingChairKind(kind))authored.userData.seatMobility='rolling';
    else if(authored.userData.seatHeight!==undefined)authored.userData.seatMobility='stationary';
    return authored;
  }
  const b = B[kind];
  if (!b) {
    const gr = grp(rb(0.3, 0.3, 0.3, 0.05, M('paint', '#f3c4d0'), 0, 0.15, 0));
    gr.userData.missing = true;
    return gr;
  }
  const gr = b(opts);
  const seating:Record<string,number>={'chair.office':.515,'chair.simple':.485,armchair:.54,sofa:.535,beanbag:.49,pouf:.425};
  if(seating[kind]!==undefined){
    gr.userData.seatHeight=seating[kind];
    gr.userData.seatMobility=isRollingChairKind(kind)?'rolling':'stationary';
  }
  if(kind==='chair.office')gr.userData.armrest=.695;
  if(kind==='armchair'||kind==='sofa')gr.userData.armrest=.71;
  gr.userData.kind = kind;
  return gr;
}

export function disposeGeometries() {
  geo.forEach((x) => x.dispose());
  geo.clear();
}
