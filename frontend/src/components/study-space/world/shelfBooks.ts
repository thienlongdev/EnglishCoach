import * as T from 'three';
import { coverOf, type LibraryBook } from '@/lib/study-space/library';
import type { SpaceObject } from '@/lib/study-space/types';

/**
 * The learner's own books on the shelves of the room: one spine for each real book, with its own title, merged into one mesh per shelf (one draw call, one small atlas). Which spine the eyes rest
 * on comes from the triangle they hit. A book taken down leaves a gap, because it is now a thing in the room.
 */
const ATLAS_W = 1024, ATLAS_H = 512, CELLS = 26;
/** Only used when the shelf has no geometry to measure yet (a placeholder): its own metres above its base. */
const BOARDS: Record<string, { y: number[]; width: number; depth: number; backZ: number }> = {
  'shelf.tall': { y: [.02, .42, .84, 1.26, 1.68], width: .78, depth: .24, backZ: -.15 },
  'shelf.wall': { y: [.02], width: .9, depth: .18, backZ: -.11 },
};
export const shelfHoldsBooks = (kind: string) => kind in BOARDS;
/** One board a book can stand on, in the shelf's own coordinates: its top, the free space left and right, from the back panel to the front, and the height above it. */
interface Board { y: number; x0: number; x1: number; back: number; front: number; clear: number }

/**
 * The boards of this very shelf, read from its own model: rays straight down find the surfaces that face up (a board, the base), rays along a board find
 * the sides and the back panel. A model the room was given later, or a shelf scaled by the learner, is measured as it is, so the books stand on its boards
 * and not on a table of guesses.
 */
function measureBoards(group: T.Object3D, kind: string): Board[] {
  const meshes: T.Mesh[] = [];
  group.updateMatrixWorld(true);
  group.traverse(o => { const m = o as T.Mesh; if (m.isMesh && m.visible && m.name !== 'library-spines' && m.name !== 'book-face' && !m.userData.noCollision) meshes.push(m); });
  const fallback = () => { const b = BOARDS[kind]; return b.y.map((y, i) => ({ y, x0: -b.width / 2, x1: b.width / 2, back: b.backZ, front: b.backZ + b.depth, clear: (b.y[i + 1] ?? y + .4) - y - .03 })); };
  if (!meshes.length) return fallback();
  const inv = group.matrixWorld.clone().invert(), box = new T.Box3();
  for (const m of meshes) { if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!.clone().applyMatrix4(new T.Matrix4().multiplyMatrices(inv, m.matrixWorld))); }
  if (box.isEmpty()) return fallback();
  const ray = new T.Raycaster(), up = new T.Vector3(0, 1, 0).transformDirection(group.matrixWorld);
  const cast = (from: T.Vector3, dir: T.Vector3) => { ray.set(from.clone().applyMatrix4(group.matrixWorld), dir.clone().transformDirection(group.matrixWorld)); ray.far = 10; return ray.intersectObjects(meshes, false); };
  const local = (p: T.Vector3) => p.clone().applyMatrix4(inv);
  const w = box.max.x - box.min.x, xc = (box.min.x + box.max.x) / 2, zc = (box.min.z + box.max.z) / 2 + (box.max.z - box.min.z) * .12;
  const facing = (h: T.Intersection, sign: number) => !!h.face && h.face.normal.clone().transformDirection(h.object.matrixWorld).dot(up) * sign > .7;
  // Surfaces facing up, seen from above in three columns.
  const tops: number[] = [], downs: number[] = [];
  for (const f of [-.3, 0, .3]) {
    const hits = cast(new T.Vector3(xc + f * w, box.max.y + .05, zc), new T.Vector3(0, -1, 0));
    for (const h of hits) { const y = local(h.point).y; if (facing(h, 1)) tops.push(y); else if (facing(h, -1)) downs.push(y); }
  }
  // Board tops seen in at least two columns (one column can land on a trim or a knob).
  tops.sort((a, b) => a - b);
  const boards: number[] = [];
  for (let i = 0; i < tops.length;) {
    let j = i; while (j + 1 < tops.length && tops[j + 1] - tops[i] < .02) j++;
    if (j - i + 1 >= 2) boards.push((tops[i] + tops[j]) / 2);
    i = j + 1;
  }
  const out: Board[] = [];
  for (const y of boards) {
    // The underside of whatever is above (the next board, the roof): the room a book has.
    const ceiling = downs.filter(d => d > y + .05).sort((a, b) => a - b)[0] ?? box.max.y;
    const clear = ceiling - y;
    if (clear < .14) continue;
    const mid = new T.Vector3(xc, y + Math.min(.1, clear / 2), zc);
    const side = (dir: number) => { const h = cast(mid, new T.Vector3(dir, 0, 0))[0]; return h ? local(h.point).x : xc + dir * w / 2; };
    const back = cast(new T.Vector3(xc, mid.y, box.max.z + .05), new T.Vector3(0, 0, -1)).find(h => local(h.point).z < zc);
    const backZ = back ? local(back.point).z : box.min.z;
    const x0 = side(-1) + .012, x1 = side(1) - .012;
    if (x1 - x0 < .12) continue;
    out.push({ y: y + .001, x0, x1, back: backZ + .006, front: Math.min(box.max.z - .015, backZ + .34), clear });
  }
  return out.length ? out : fallback();
}
export interface Spine { book: LibraryBook; center: T.Vector3 }

function fitText(c: CanvasRenderingContext2D, text: string, width: number, size: number) {
  let s = size;
  c.font = `700 ${s}px Quicksand, sans-serif`;
  while (s > 9 && c.measureText(text).width > width) { s -= 1; c.font = `700 ${s}px Quicksand, sans-serif`; }
  if (c.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 3 && c.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t}…`;
}

function spineAtlas(books: LibraryBook[]) {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W; canvas.height = ATLAS_H;
  const c = canvas.getContext('2d')!, cell = ATLAS_W / CELLS;
  books.forEach((b, i) => {
    const x = i * cell;
    c.fillStyle = b.color; c.fillRect(x, 0, cell, ATLAS_H);
    c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(x + 1, 0, 2, ATLAS_H);
    c.fillStyle = 'rgba(0,0,0,.22)'; c.fillRect(x + cell - 3, 0, 3, ATLAS_H);
    c.fillStyle = 'rgba(255,255,255,.55)'; c.fillRect(x + 4, 22, cell - 8, 2); c.fillRect(x + 4, ATLAS_H - 24, cell - 8, 2);
    c.save();
    c.translate(x + cell / 2, ATLAS_H / 2); c.rotate(Math.PI / 2);
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fbf6e9';
    c.fillText(fitText(c, b.title, ATLAS_H - 70, 24), 0, 0);
    c.restore();
  });
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace; texture.anisotropy = 8;
  return texture;
}

/** One shelf's spines. Replaces whatever spines the shelf had. */
export function dressShelf(group: T.Object3D, kind: string, books: LibraryBook[], blocked: T.Box3[] = []) {
  undressShelf(group);
  if (!(kind in BOARDS) || !books.length) return;
  // Boards with something of the room already standing on them are left to it; the rest fill from the one nearest the hands and the eyes.
  const inv = group.matrixWorld.clone().invert(), taken = blocked.map(b => b.clone().applyMatrix4(inv));
  const boards = measureBoards(group, kind)
    .filter(b => !taken.some(o => o.max.y > b.y + .02 && o.min.y < b.y + b.clear - .02 && o.max.x > b.x0 && o.min.x < b.x1 && o.max.z > b.back && o.min.z < b.front))
    .sort((a, b) => Math.abs(a.y - 1.0) - Math.abs(b.y - 1.0));
  const shown = books.slice(0, CELLS);
  const pos: number[] = [], uv: number[] = [], normal: number[] = [], idx: number[] = [];
  const spines: Spine[] = [];
  const cell = 1 / CELLS;
  let board = 0, x = boards[0]?.x0 ?? 0;
  for (let i = 0; i < shown.length; i++) {
    const book = shown[i];
    let h = 7; for (let k = 0; k < book.key.length; k++) h = (h * 33 + book.key.charCodeAt(k)) >>> 0;
    const thick = .026 + (h % 5) * .004;
    if (board < boards.length && x + thick > boards[board].x1) { board++; x = boards[board]?.x0 ?? 0; }
    if (board >= boards.length) break;
    const b = boards[board];
    const tall = Math.min(.33, .235 + (h % 7) * .011, b.clear - .03), deep = Math.max(.1, Math.min(.24, b.front - b.back) - (h % 3) * .012);
    const y0 = b.y, z0 = b.back, u0 = i * cell, u1 = (i + 1) * cell;
    const add = (a: number[], n: number[], uvs: number[]) => {
      const base = pos.length / 3;
      pos.push(...a); for (let k = 0; k < 4; k++) normal.push(...n); uv.push(...uvs); idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const x0 = x, x1 = x + thick, y1 = y0 + tall, z1 = z0 + deep, mid = (u0 + u1) / 2;
    // Front (the spine with the title), then top, bottom and both sides so a spine stays a solid thing from any angle. Every book has 5 faces: 10 triangles.
    add([x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], [0, 0, 1], [u0, 0, u1, 0, u1, 1, u0, 1]);
    add([x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0], [0, 1, 0], [mid, .98, mid, .98, mid, .98, mid, .98]);
    add([x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1], [1, 0, 0], [mid, .5, mid, .5, mid, .5, mid, .5]);
    add([x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0], [-1, 0, 0], [mid, .5, mid, .5, mid, .5, mid, .5]);
    add([x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1], [0, -1, 0], [mid, .02, mid, .02, mid, .02, mid, .02]);
    spines.push({ book, center: new T.Vector3((x0 + x1) / 2, y0 + tall / 2, z1) });
    x += thick + .002;
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new T.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  geometry.setIndex(idx);
  const texture = spineAtlas(shown);
  const material = new T.MeshStandardMaterial({ map: texture, roughness: .7, metalness: .02 });
  const mesh = new T.Mesh(geometry, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData.spines = spines;
  mesh.userData.objectId = group.userData.objectId;
  // What lands on a board lands on the board: a spine is for the eyes and the hand.
  mesh.userData.noCollision = true;
  // ...but the eyes find each spine, and the hand takes it.
  mesh.userData.pickable = true;
  mesh.name = 'library-spines';
  group.add(mesh);
}
export function undressShelf(group: T.Object3D) {
  const old = group.getObjectByName('library-spines') as T.Mesh | undefined;
  if (!old) return;
  group.remove(old);
  old.geometry.dispose();
  const m = old.material as T.MeshStandardMaterial;
  m.map?.dispose(); m.dispose();
}
/** Which book a triangle of the spines belongs to. */
export function spineOfHit(hit: { object: T.Object3D; faceIndex?: number | null }): Spine | null {
  const list = hit.object.userData.spines as Spine[] | undefined;
  if (!list || hit.faceIndex == null) return null;
  return list[Math.floor(hit.faceIndex / 10)] ?? null;
}

/** A book in the room with its own face: its real cover where the device has one, otherwise its title and author set on its own colour. */
export function dressBookFace(group: T.Object3D, obj: SpaceObject) {
  const info = obj.state?.book;
  const old = group.getObjectByName('book-face') as T.Mesh | undefined;
  if (old) { group.remove(old); old.geometry.dispose(); const m = old.material as T.MeshStandardMaterial; m.map?.dispose(); m.dispose(); }
  if (!info) return;
  const canvas = document.createElement('canvas');
  canvas.width = 300; canvas.height = 440;
  const c = canvas.getContext('2d')!;
  c.fillStyle = info.color; c.fillRect(0, 0, 300, 440);
  c.fillStyle = 'rgba(255,255,255,.16)'; c.fillRect(14, 14, 272, 2); c.fillRect(14, 424, 272, 2);
  c.fillStyle = '#fbf6e9'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  const words = info.title.split(/\s+/), lines: string[] = [];
  c.font = '700 34px Quicksand, sans-serif';
  let line = '';
  for (const w of words) { const next = line ? `${line} ${w}` : w; if (c.measureText(next).width > 250 && line) { lines.push(line); line = w; } else line = next; if (lines.length >= 6) break; }
  if (line && lines.length < 7) lines.push(line);
  lines.forEach((l, i) => c.fillText(fitText(c, l, 262, 34), 150, 110 + i * 42));
  if (info.author) { c.font = '500 22px Quicksand, sans-serif'; c.fillText(fitText(c, info.author, 262, 22), 150, 400); }
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  const key = `${info.source}:${info.id}`, blob = coverOf(key);
  if (blob) void createImageBitmap(blob).then(img => { c.drawImage(img, 0, 0, 300, 440); texture.needsUpdate = true; img.close(); }).catch(() => undefined);
  const material = new T.MeshStandardMaterial({ map: texture, roughness: .62 });
  // The closed book lies on its back cover: the face looks up.
  const mesh = new T.Mesh(new T.PlaneGeometry(.153, .224), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = .0425;
  mesh.name = 'book-face';
  mesh.userData.noCollision = true;
  mesh.userData.objectId = obj.id;
  group.add(mesh);
}
