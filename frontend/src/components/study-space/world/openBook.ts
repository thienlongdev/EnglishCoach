import * as T from 'three';
import type { BookSession, Mark, Para } from '@/lib/study-space/bookSession';
import { patchMaterialWithEchoCsm } from './echoLife/echoCsm';

const SEGMENTS = 14;
const PAGE_W = 800, PAGE_H = 1100, MARGIN = 72, LINE = 48, FONT = 32, VI_FONT = 28;

let sharedWhitePageTex: T.DataTexture | null = null;
function getSharedWhitePageTex(): T.DataTexture {
  if (!sharedWhitePageTex) {
    sharedWhitePageTex = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    sharedWhitePageTex.colorSpace = T.SRGBColorSpace;
    sharedWhitePageTex.needsUpdate = true;
  }
  return sharedWhitePageTex;
}

/** One line on a page: what it says, and where it is in the chapter's own text (the same offsets the readers use). */
export interface PageLine { text: string; offset: number; tone?: 'vi' | 'head' }
export interface BookPage { lines: PageLine[]; chapter: number; fixed?: number }
/** What the eyes picked on a page: a whole word, its sentence, where it is. */
export interface PickedWord { word: string; sentence: string; chapter: number; start: number; end: number; x: number; y: number }

const FACE = `500 ${FONT}px Quicksand, sans-serif`, FACE_VI = `500 ${VI_FONT}px Quicksand, sans-serif`;

/** Breaks paragraphs into page-long lists of lines with the page's own font: a word is never cut, a line remembers where in the text it starts. */
export function layoutParagraphs(paras: Para[], chapter: number, measure: (s: string, vi: boolean) => number, width: number, linesPerPage: number, bilingual: boolean, title?: string): BookPage[] {
  const pages: BookPage[] = [];
  let page: PageLine[] = [];
  const push = (line: PageLine) => { page.push(line); if (page.length >= linesPerPage) { pages.push({ lines: page, chapter }); page = []; } };
  if (title) { push({ text: title, offset: 0, tone: 'head' }); push({ text: '', offset: 0 }); }
  const flow = (text: string, offset: number, vi: boolean, indent: boolean, out: PageLine[]) => {
    const re = /\S+/g;
    let m: RegExpExecArray | null, line = indent ? '    ' : '', start = -1;
    while ((m = re.exec(text))) {
      const w = m[0], next = line.trim().length ? `${line} ${w}` : `${line}${w}`;
      if (measure(next, vi) > width && line.trim().length) { out.push({ text: line, offset: vi ? -1 : offset + start, ...(vi ? { tone: 'vi' as const } : {}) }); line = w; start = m.index; }
      else { if (start < 0) start = m.index; line = next; }
    }
    if (line.trim().length) out.push({ text: line, offset: vi ? -1 : offset + Math.max(0, start), ...(vi ? { tone: 'vi' as const } : {}) });
  };
  for (const para of paras) {
    const lines: PageLine[] = [];
    flow(para.text, para.offset, false, !bilingual, lines);
    if (bilingual && para.vi) flow(para.vi, 0, true, false, lines);
    // A line and its Vietnamese stay on one page when they can: a reader never turns the page in the middle of a pair.
    if (bilingual && page.length && lines.length <= linesPerPage && page.length + lines.length > linesPerPage) { pages.push({ lines: page, chapter }); page = []; }
    lines.forEach(push);
    if (bilingual && page.length) push({ text: '', offset: -1 });
  }
  if (page.length) pages.push({ lines: page, chapter });
  return pages;
}

function paintPage(c: CanvasRenderingContext2D, page: BookPage | null, number: number, marks: Mark[], total: string) {
  c.fillStyle = '#f7f2e4'; c.fillRect(0, 0, PAGE_W, PAGE_H);
  const left = number % 2 === 0, g = c.createLinearGradient(left ? PAGE_W : 0, 0, left ? PAGE_W - 110 : 110, 0);
  g.addColorStop(0, 'rgba(70,50,25,.2)'); g.addColorStop(1, 'rgba(70,50,25,0)');
  c.textBaseline = 'alphabetic'; c.textAlign = 'left';
  if (page) {
    let y = MARGIN + LINE;
    for (const line of page.lines) {
      const head = line.tone === 'head', vi = line.tone === 'vi';
      c.font = head ? `700 ${FONT + 6}px Quicksand, sans-serif` : vi ? FACE_VI : FACE;
      if (!head && !vi) for (const m of marks) {
        if (m.kind !== 'highlight' || m.chapter !== page.chapter) continue;
        const from = Math.max(m.start, line.offset), to = Math.min(m.end, line.offset + line.text.length);
        if (to <= from) continue;
        const x0 = c.measureText(line.text.slice(0, from - line.offset)).width, x1 = c.measureText(line.text.slice(0, to - line.offset)).width;
        c.fillStyle = 'rgba(250,204,21,.55)'; c.fillRect(MARGIN + x0, y - FONT * .86, x1 - x0, FONT * 1.14);
      }
      c.fillStyle = vi ? '#33506c' : '#2b2520';
      c.fillText(line.text, MARGIN, y);
      y += vi ? LINE - 6 : LINE;
    }
    if (marks.some(m => m.kind === 'bookmark' && m.chapter === page.chapter && page.lines.some(l => l.offset >= 0 && Math.abs(l.offset - m.start) < 300))) {
      c.fillStyle = '#c0392b'; c.beginPath(); c.moveTo(PAGE_W - 92, 0); c.lineTo(PAGE_W - 56, 0); c.lineTo(PAGE_W - 56, 76); c.lineTo(PAGE_W - 74, 60); c.lineTo(PAGE_W - 92, 76); c.closePath(); c.fill();
    }
    c.fillStyle = '#8b8172'; c.font = `500 ${FONT - 8}px Quicksand, sans-serif`; c.textAlign = 'center'; c.fillText(total, PAGE_W / 2, PAGE_H - 28);
  }
  c.fillStyle = g; c.fillRect(0, 0, PAGE_W, PAGE_H);
}

/**
 * The book in the hand, open: a real spine, two blocks of pages, and one sheet that turns with a bend in it. Its pages are the book's own text, laid out here chapter by chapter, or a PDF's
 * own pages. The position it reports is the same one the normal readers use.
 */
export class OpenBook {
  readonly group = new T.Group();
  private sheet: T.Mesh;
  private turn = 0;
  private turning = 0;
  private width: number;
  private owned: { dispose(): void }[] = [];
  private faces: { canvas: HTMLCanvasElement; texture: T.CanvasTexture; mesh: T.Mesh }[] = [];
  private sheetMat: T.MeshStandardMaterial;
  private pages: BookPage[] = [];
  private session: BookSession | null = null;
  private marks: Mark[] = [];
  /** The chapters laid out now: a window that grows as the reader goes. */
  private first = 0;
  private last = -1;
  private loading = false;
  private bilingualOn = false;
  private fixedCache = new Map<number, HTMLCanvasElement>();
  /** The left page of the spread. */
  private at = 0;
  private flipped = false;
  private ready = false;
  private disposed = false;
  onMoved: (() => void) | null = null;

  constructor(width: number, height: number, thickness: number, cover: T.ColorRepresentation) {
    this.width = width;
    const coverM = patchMaterialWithEchoCsm(new T.MeshStandardMaterial({ color: cover, roughness: .72 }));
    const edgeM = patchMaterialWithEchoCsm(new T.MeshStandardMaterial({ color: '#efe6d3', roughness: .9 }));
    this.owned.push(coverM, edgeM);
    const box = (w: number, h: number, d: number, m: T.Material, x: number, y: number, z: number) => {
      const geometry = new T.BoxGeometry(w, h, d);
      this.owned.push(geometry);
      const mesh = new T.Mesh(geometry, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.userData.noCollision = true;
      this.group.add(mesh);
      return mesh;
    };
    for (const side of [-1, 1]) {
      box(width + .006, .004, height + .008, coverM, side * (width / 2 + .001), 0, 0);
      box(width, thickness, height, edgeM, side * width / 2, thickness / 2 + .002, 0);
      const canvas = document.createElement('canvas');
      canvas.width = PAGE_W; canvas.height = PAGE_H;
      paintPage(canvas.getContext('2d')!, null, side < 0 ? 0 : 1, [], '');
      const texture = new T.CanvasTexture(canvas);
      texture.colorSpace = T.SRGBColorSpace; texture.anisotropy = 8;
      const top = new T.PlaneGeometry(width, height);
      // Paper catches whatever light there is: a page held up to read is never a dull grey.
      const material = patchMaterialWithEchoCsm(new T.MeshStandardMaterial({ map: texture, emissive: '#ffffff', emissiveMap: texture, emissiveIntensity: .42, roughness: .9, side: T.DoubleSide }));
      this.owned.push(top, material, texture);
      const face = new T.Mesh(top, material);
      face.rotation.x = -Math.PI / 2;
      face.position.set(side * width / 2, thickness + .0025, 0);
      face.userData.noCollision = true;
      this.group.add(face);
      this.faces.push({ canvas, texture, mesh: face });
    }
    box(.012, .006, height + .008, coverM, 0, -.001, 0);
    const geometry = new T.PlaneGeometry(width, height, SEGMENTS, 1);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(width / 2, 0, 0);
    this.owned.push(geometry);
    // Pre-bind a shared 1x1 white SRGB DataTexture so USE_MAP & USE_EMISSIVEMAP stay constant forever
    // and page turns swap CanvasTextures with zero `sheetMat.needsUpdate = true` shader recompiles!
    const initTex = getSharedWhitePageTex();
    this.sheetMat = patchMaterialWithEchoCsm(new T.MeshStandardMaterial({ map: initTex, emissive: '#ffffff', emissiveMap: initTex, emissiveIntensity: .36, roughness: .86, side: T.DoubleSide }));
    this.owned.push(this.sheetMat);
    this.sheet = new T.Mesh(geometry, this.sheetMat);
    this.sheet.position.y = thickness + .004;
    this.sheet.visible = false;
    this.sheet.userData.noCollision = true;
    this.group.add(this.sheet);
  }

  private measure = (s: string, vi: boolean) => { const c = this.faces[0].canvas.getContext('2d')!; c.font = vi ? FACE_VI : FACE; return c.measureText(s).width; };
  private lay(paras: Para[], chapter: number) {
    const session = this.session!, per = Math.floor((PAGE_H - MARGIN * 2 - 44) / LINE);
    return layoutParagraphs(paras, chapter, this.measure, PAGE_W - MARGIN * 2, per, this.bilingualOn, chapter === 0 ? session.title : session.label(chapter) || undefined);
  }

  /** Opens at the session's own position. */
  async open(session: BookSession) {
    this.session = session;
    try { this.marks = await session.marks(); } catch { this.marks = []; }
    this.bilingualOn = session.bilingual;
    if (session.fixedPages != null) {
      this.pages = Array.from({ length: session.fixedPages }, (_, i) => ({ lines: [], chapter: i, fixed: i }));
      this.first = 0; this.last = session.fixedPages - 1;
      this.ready = true;
      this.goTo(Math.min(session.fixedPages - 1, session.start.chapter));
      return;
    }
    const chapter = Math.max(0, Math.min(session.chapters - 1, session.start.chapter));
    let paras = await session.paragraphs(chapter).catch(() => []), at = chapter;
    // Some chapters of a book (a cover file) hold no text: go on to the first that has.
    while (!paras.length && at + 1 < session.chapters) { at++; paras = await session.paragraphs(at).catch(() => []); }
    if (this.disposed) return;
    this.first = this.last = at;
    this.pages = this.lay(paras, at);
    this.ready = true;
    this.goToOffset(at === chapter ? session.start.offset : 0);
  }
  private goToOffset(offset: number) {
    let n = 0;
    for (let i = 0; i < this.pages.length; i++) { const first = this.pages[i].lines.find(l => l.offset >= 0); if (first && first.offset <= offset) n = i; }
    this.goTo(n);
  }
  private goTo(n: number) {
    this.at = Math.max(0, Math.min(this.lastSpread, n - n % 2));
    this.paint(0, this.at); this.paint(1, this.at + 1);
    this.onMoved?.();
  }
  /** English alone, or English with its Vietnamese. The reader stays on the same words. */
  async setBilingual(on: boolean) {
    const s = this.session;
    if (!s?.bilingual || this.bilingualOn === on) return;
    const offset = this.position.offset;
    this.bilingualOn = on;
    const paras = await s.paragraphs(this.first).catch(() => []);
    this.pages = this.lay(paras, this.first);
    this.goToOffset(offset);
  }
  get bilingual() { return this.bilingualOn; }
  get canBilingual() { return !!this.session?.bilingual; }
  /** Where the eyes are, as the readers count it. */
  get position() {
    const page = this.pages[this.at], line = page?.lines.find(l => l.offset >= 0), snippet = page?.lines.filter(l => l.offset >= 0).map(l => l.text.trim()).join(' ').slice(0, 90) ?? '';
    return { chapter: page?.chapter ?? 0, offset: line?.offset ?? 0, snippet };
  }
  private get chapterProgress() {
    if (this.session?.fixedPages) return (this.at + 1) / Math.max(1, this.session.fixedPages);
    const chapter = this.pages[this.at]?.chapter ?? 0;
    const all = this.pages.filter(p => p.chapter === chapter), mine = all.indexOf(this.pages[this.at]);
    return all.length ? (mine + 1) / all.length : 0;
  }
  saveNow() {
    const s = this.session;
    if (!s || !this.ready || !this.pages.length) return;
    const p = this.position;
    if (s.fixedPages != null) s.save(this.pages[this.at]?.chapter ?? 0, 0, '', this.chapterProgress);
    else s.save(p.chapter, p.offset, p.snippet, this.chapterProgress);
  }
  get label() { const s = this.session; return s && this.pages[this.at] ? s.label(this.pages[this.at].chapter) : ''; }
  get marked() {
    const page = this.pages[this.at];
    if (!page) return false;
    const inPage = (p: BookPage, m: Mark) => m.kind === 'bookmark' && m.chapter === p.chapter && (p.fixed != null || p.lines.some(l => l.offset >= 0 && Math.abs(l.offset - m.start) < 300));
    return this.marks.some(m => inPage(page, m) || (this.pages[this.at + 1] ? inPage(this.pages[this.at + 1], m) : false));
  }
  async toggleBookmark() {
    const s = this.session;
    if (!s) return false;
    const p = this.position, on = await s.bookmark(p.chapter, p.offset, p.snippet);
    this.marks = await s.marks();
    this.paint(0, this.at); this.paint(1, this.at + 1);
    return on;
  }
  async highlight(word: PickedWord) {
    const m = await this.session?.highlight(word.chapter, word.start, word.end, word.word);
    if (!m) return false;
    this.marks = [...this.marks, m];
    this.paint(0, this.at); this.paint(1, this.at + 1);
    return true;
  }
  get supportsWords() { return this.session?.fixedPages == null; }
  get pageNote() {
    const s = this.session;
    if (!s || !this.pages.length) return '';
    if (s.fixedPages != null) return `${this.at + 1} / ${s.fixedPages}`;
    const p = this.pages[this.at], ch = this.pages.filter(x => x.chapter === p.chapter), i = ch.indexOf(p);
    return s.chapters > 1 ? `${p.chapter + 1}/${s.chapters} · ${i + 1}/${ch.length}` : `${i + 1} / ${ch.length}`;
  }

  private get lastSpread() { const n = Math.max(0, this.pages.length - 1); return n - n % 2; }
  private paint(face: number, number: number) { this.drawTo(this.faces[face].canvas, this.faces[face].texture, number); }
  private drawTo(canvas: HTMLCanvasElement, texture: T.CanvasTexture, number: number) {
    const page = this.pages[number] ?? null, c = canvas.getContext('2d')!;
    if (page?.fixed != null) {
      const ready = this.fixedCache.get(page.fixed);
      if (ready) { c.drawImage(ready, 0, 0); texture.needsUpdate = true; return; }
      paintPage(c, null, number, [], '');
      texture.needsUpdate = true;
      void this.loadFixed(page.fixed).then(() => { if (!this.disposed && (this.pages[number] === page)) this.drawTo(canvas, texture, number); });
      return;
    }
    const chapterPages = page ? this.pages.filter(p => p.chapter === page.chapter) : [], index = page ? chapterPages.indexOf(page) + 1 : 0;
    paintPage(c, page, number, this.marks, page ? String(index) : '');
    texture.needsUpdate = true;
  }
  private fixedAsked = new Set<number>();
  private async loadFixed(index: number) {
    if (this.fixedAsked.has(index) || !this.session?.drawPage) return;
    this.fixedAsked.add(index);
    const off = document.createElement('canvas'); off.width = PAGE_W; off.height = PAGE_H;
    try { await this.session.drawPage(index, off); this.fixedCache.set(index, off); if (this.fixedCache.size > 12) { const first = this.fixedCache.keys().next().value as number; this.fixedCache.delete(first); this.fixedAsked.delete(first); } } catch { this.fixedAsked.delete(index); }
  }
  /** Which page it lies open at, for the next time it is opened. */
  get page() { return this.at; }
  get pageCount() { return this.pages.length; }
  get canNext() { return !this.ready || this.at < this.lastSpread || this.last + 1 < (this.session?.chapters ?? 0); }
  get canBack() { return this.at > 0 || this.first > 0; }

  /** The next chapter joins the end of what is laid out; the one before joins the front and the place stays. */
  private async more(dir: number) {
    const s = this.session;
    if (!s || this.loading || s.fixedPages != null) return false;
    this.loading = true;
    try {
      if (dir > 0) {
        let next = this.last + 1;
        while (next < s.chapters) {
          const paras = await s.paragraphs(next).catch(() => []);
          if (this.disposed) return false;
          this.last = next;
          if (paras.length) { this.pages = [...this.pages, ...this.lay(paras, next)]; return true; }
          next++;
        }
        return false;
      }
      let before = this.first - 1;
      while (before >= 0) {
        const paras = await s.paragraphs(before).catch(() => []);
        if (this.disposed) return false;
        this.first = before;
        if (paras.length) { const added = this.lay(paras, before); this.pages = [...added, ...this.pages]; this.at += added.length + (added.length % 2 ? 1 : 0); if (added.length % 2) this.pages.splice(added.length, 0, { lines: [], chapter: before }); return true; }
        before--;
      }
      return false;
    } finally { this.loading = false; }
  }

  /** Turns one leaf: forward right to left, back left to right. Refused at the covers. */
  turnPage(dir = 1) {
    if (this.turning || !this.ready) return false;
    if (dir > 0 ? this.at >= this.lastSpread : this.at <= 0) {
      if (dir > 0 && this.last + 1 >= (this.session?.chapters ?? 0)) { this.session?.reachedEnd(); return false; }
      if (dir < 0 && this.first <= 0) return false;
      void this.more(dir).then(ok => { if (ok) this.turnPage(dir); else if (dir > 0) this.session?.reachedEnd(); });
      return true;
    }
    this.turning = dir; this.turn = 0; this.flipped = false; this.sheet.visible = true;
    // Under the turning leaf the next page is already there. The leaf carries the page it is leaving on the way up, the one it brings on the way down.
    if (dir > 0) this.paint(1, this.at + 3); else this.paint(0, this.at - 2);
    this.sheetMat.map = this.leaf(dir > 0 ? this.at + 1 : this.at);
    this.sheetMat.emissiveMap = this.sheetMat.map;
    return true;
  }
  private leafTexture: T.CanvasTexture | null = null;
  private leafCanvas: HTMLCanvasElement | null = null;
  private leaf(number: number) {
    if (!this.leafCanvas) { this.leafCanvas = document.createElement('canvas'); this.leafCanvas.width = PAGE_W; this.leafCanvas.height = PAGE_H; }
    if (!this.leafTexture) { this.leafTexture = new T.CanvasTexture(this.leafCanvas); this.leafTexture.colorSpace = T.SRGBColorSpace; this.leafTexture.anisotropy = 8; this.owned.push(this.leafTexture); }
    this.drawTo(this.leafCanvas, this.leafTexture, number);
    return this.leafTexture;
  }

  /** The word under a ray, on whichever page it lands. */
  pick(ray: T.Raycaster): PickedWord | null {
    const hit = ray.intersectObjects(this.faces.map(f => f.mesh), false)[0];
    if (!hit?.uv) return null;
    const face = this.faces.findIndex(f => f.mesh === hit.object), page = this.pages[this.at + face];
    if (!page || page.fixed != null) return null;
    const px = hit.uv.x * PAGE_W, py = (1 - hit.uv.y) * PAGE_H;
    let y = MARGIN + LINE;
    for (const line of page.lines) {
      const vi = line.tone === 'vi', step = vi ? LINE - 6 : LINE;
      if (py <= y + 8 && py > y - FONT) {
        if (line.offset < 0 && !vi) return null;
        const c = this.faces[0].canvas.getContext('2d')!;
        c.font = vi ? FACE_VI : FACE;
        const re = /[\p{L}\p{M}\p{N}'’-]+/gu;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line.text))) {
          const x0 = MARGIN + c.measureText(line.text.slice(0, m.index)).width, x1 = MARGIN + c.measureText(line.text.slice(0, m.index + m[0].length)).width;
          if (px >= x0 - 3 && px <= x1 + 3) {
            const whole = page.lines.filter(l => l.tone === line.tone).map(l => l.text.trim()).join(' ');
            const here = whole.indexOf(m[0]), from = Math.max(0, whole.lastIndexOf('.', here) + 1), to = whole.indexOf('.', here);
            return { word: m[0], sentence: whole.slice(from, to < 0 ? undefined : to + 1).trim().slice(0, 400), chapter: page.chapter, start: vi ? -1 : line.offset + m.index, end: vi ? -1 : line.offset + m.index + m[0].length, x: hit.point.x, y: hit.point.y };
          }
        }
        return null;
      }
      y += step;
    }
    return null;
  }
  /** A place on a page counts as its outer edge: a click there turns the leaf. */
  edgeAt(ray: T.Raycaster): number {
    const hit = ray.intersectObjects(this.faces.map(f => f.mesh), false)[0];
    if (!hit?.uv) return 0;
    const face = this.faces.findIndex(f => f.mesh === hit.object);
    return face === 1 && hit.uv.x > .86 ? 1 : face === 0 && hit.uv.x < .14 ? -1 : 0;
  }

  update(dt: number, reduced: boolean) {
    if (!this.turning) return;
    this.turn = Math.min(1, this.turn + dt / (reduced ? .05 : .52));
    const t = this.turn, sweep = (t * t * (3 - 2 * t)) * Math.PI, angle = this.turning > 0 ? sweep : Math.PI - sweep;
    // The free edge lags the spine, most in the middle of the turn: paper, not a board.
    const bend = Math.sin(t * Math.PI) * .9 * this.turning;
    const p = this.sheet.geometry.getAttribute('position') as T.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const u = Math.round(i % (SEGMENTS + 1)) / SEGMENTS;
      let x = 0, y = 0;
      const step = this.width / SEGMENTS, n = Math.round(u * SEGMENTS);
      for (let k = 0; k < n; k++) { const a = angle - bend * (k + .5) / SEGMENTS; x += Math.cos(a) * step; y += Math.sin(a) * step; }
      p.setX(i, x); p.setY(i, y);
    }
    p.needsUpdate = true;
    this.sheet.geometry.computeVertexNormals();
    // Edge-on: the other side of the leaf comes round.
    if (!this.flipped && t > .5) {
      this.flipped = true;
      this.sheetMat.map = this.leaf(this.turning > 0 ? this.at + 2 : this.at - 1);
      this.sheetMat.emissiveMap = this.sheetMat.map;
    }
    if (this.turn >= 1) {
      this.at += this.turning * 2;
      this.paint(0, this.at); this.paint(1, this.at + 1);
      this.turning = 0; this.sheet.visible = false;
      this.saveNow();
      this.onMoved?.();
    }
  }

  dispose() {
    this.disposed = true;
    this.saveNow();
    this.session?.close();
    this.group.removeFromParent();
    this.owned.forEach(o => o.dispose());
    this.fixedCache.clear();
  }
}
