/**
 * Whole-book page index of a reflowable book (My Books, EPUB / TXT).
 *
 * A reflowable book has no fixed pages: how many there are depends on the font, its size, the line height, the
 * margins and the page size. The index counts the pages of every chapter file under ONE layout (its signature) with
 * the same column geometry the visible reader uses, so "page 128 of 426" means the 128th page the reader turns to
 * under that layout. Files are counted one at a time while the reader is idle, in a hidden, size-contained
 * measuring box with its own shadow root (the book's CSS never reaches the visible page), then released. Nothing is
 * claimed for the whole book until every file is counted; the visible chapter always uses its real layout.
 *
 * Counts persist per book and signature (store/pageCache.ts), so reopening a book under the same layout restores them
 * instead of counting again. A restored count is checked against the real layout of every chapter file the reader
 * shows; one disagreement drops all restored counts not yet checked and the book is counted again.
 */
import { Columns } from "./columns";
import { READER_CSS } from "./readerCss";
import { TextIndex } from "./text";
import type { FlowSource, TocItem } from "./types";

/** Pages of one chapter file, and the first page (0-based, in that file) of each contents entry starting there. */
export interface FileCount {
    pages: number;
    starts: number[];
}

export interface Entry { frag?: string; o?: number }

/**
 * Version of the counting rules (column geometry, page count, chapter starts, sanitizer output). Part of every
 * layout signature: bump it with any change that can make the same book count differently under the same settings.
 */
export const PAGE_INDEX_VERSION = 2;

/** Stored page indexes of one book, by layout signature (store/pageCache.ts). */
export interface PageIndexCache {
    get(signature: string): Array<FileCount | null> | undefined;
    put(signature: string, counts: Array<FileCount | null>): void;
    drop(signature: string): void;
}

/** Short stable hash of a signature part (FNV-1a, 32 bit). */
export function hashKey(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
}

function validCount(c: unknown): c is FileCount {
    const v = c as FileCount;
    if (!v || !Number.isInteger(v.pages) || v.pages < 1 || !Array.isArray(v.starts)) return false;
    let prev = -1;
    for (const p of v.starts) { if (!Number.isInteger(p) || p <= prev || p >= v.pages) return false; prev = p; }
    return true;
}

export interface Geometry {
    Pw: number;
    H: number;
    gap: number;
    stride: number;
    /** Custom properties of the reader stage (font, size, line height, alignment, hyphenation). */
    vars: Record<string, string>;
    lang: string;
}

/** Contents entries of each chapter file, in reading order. */
export function entriesByFile(toc: TocItem[]): Map<number, Entry[]> {
    const map = new Map<number, Entry[]>();
    const walk = (items: TocItem[]) => {
        for (const item of items) {
            const list = map.get(item.target.s) ?? [];
            list.push({ frag: item.target.frag, o: item.target.o });
            map.set(item.target.s, list);
            if (item.children.length) walk(item.children);
        }
    };
    walk(toc);
    return map;
}

function findId(root: Element, id: string): Element | null {
    try { return root.querySelector(`#${CSS.escape(id)}`) ?? root.querySelector(`[name="${CSS.escape(id)}"]`); } catch { return null; }
}

/**
 * Pages of a laid-out paged chapter: the columns that hold text or pictures (a trailing column that only exists
 * because of a bottom margin is not a page), never more than the scroll width allows.
 */
export function pageCount(cols: Columns, scrollWidth: number, gap: number, stride: number): number {
    const total = Math.max(1, Math.round((scrollWidth + gap) / stride));
    const content = cols.contentPages();
    return content !== null && content <= total ? Math.max(1, content) : total;
}

/**
 * Counts a laid-out chapter file. A contents entry owns the first page that starts at or after it (the page that the
 * running head names after it), so a chapter that begins halfway down a page starts on the next one.
 */
export function countFile(cols: Columns, root: Element, entries: Entry[], pages: number): FileCount {
    const index = cols.index;
    const starts = new Set<number>();
    for (const e of entries) {
        let o: number | null;
        if (e.frag) {
            const el = findId(root, e.frag);
            o = el ? index.offsetOf(el, 0) : null;
        } else o = e.o ?? 0;
        if (o === null) continue;
        const page = Math.max(0, Math.min(pages - 1, cols.columnOf(o, 0, pages - 1)));
        starts.add(pageHead(cols, page) >= o ? page : page + 1);
    }
    return { pages, starts: [...starts].sort((a, b) => a - b) };
}

/** Text offset of the first thing laid out on the first page. */
function firstShown(cols: Columns): number {
    const items = cols.index.items;
    for (let i = 0; i < items.length && i < 4000; i++) if (cols.itemCol(i) !== null) return items[i].start;
    return 0;
}

/**
 * Text offset of the first character or picture shown on a page. Blank text between blocks is not: a chapter heading at
 * the top of a page starts on that page even though the blank text before it is counted from the page before.
 */
function pageHead(cols: Columns, page: number): number {
    if (page === 0) return firstShown(cols);
    const ps = cols.pageStart(page);
    const items = cols.index.items;
    let i = ps.item;
    if (i >= items.length || ps.o !== items[i].start) return ps.o;
    while (i < items.length - 1 && !items[i].atom && /^\s*$/.test((items[i].node as Text).data)) i++;
    return items[i].start;
}

export class PageIndex {
    readonly counts: Array<FileCount | undefined>;
    /** A chapter file could not be read: the whole-book count is unknown. */
    failed = false;
    /** How often the visible chapter disagreed with its counted value (and replaced it). */
    corrections = 0;
    /** Stored in the book's page cache (only when the layout signature names the face actually loaded). */
    persist = false;
    /** Counts changed since they were last stored. */
    dirty = false;
    /** Restored counts disagreed with the real layout and were dropped: the stored index must go too. */
    invalidated = false;
    /** Restored counts not yet confirmed by the real layout of their file. */
    private unverified = new Set<number>();

    constructor(readonly signature: string, files: number) {
        this.counts = new Array(files).fill(undefined);
    }

    /** Takes stored counts (all of them, or none when the stored index does not fit this book's files). */
    restore(stored: Array<FileCount | null>): boolean {
        if (!Array.isArray(stored) || stored.length !== this.counts.length || !stored.every((c) => c === null || validCount(c))) return false;
        stored.forEach((c, s) => {
            if (!c || this.counts[s]) return;
            this.counts[s] = { pages: c.pages, starts: [...c.starts] };
            this.unverified.add(s);
        });
        return true;
    }

    /** Counts as stored (null = not counted yet). */
    snapshot(): Array<FileCount | null> {
        return this.counts.map((c) => (c ? { pages: c.pages, starts: [...c.starts] } : null));
    }

    get complete(): boolean {
        return !this.failed && this.counts.every(Boolean);
    }

    get counted(): number {
        return this.counts.filter(Boolean).length;
    }

    /** Pages before chapter file `s` (null until all of them are counted). */
    base(s: number): number | null {
        let n = 0;
        for (let i = 0; i < s; i++) {
            const c = this.counts[i];
            if (!c) return null;
            n += c.pages;
        }
        return n;
    }

    get total(): number | null {
        return this.complete ? this.base(this.counts.length) : null;
    }

    record(s: number, count: FileCount, real: boolean) {
        const old = this.counts[s];
        const differs = Boolean(old) && (old!.pages !== count.pages || old!.starts.join() !== count.starts.join());
        if (real && this.unverified.delete(s) && differs) {
            // the stored index does not describe this layout: trust none of its unchecked counts
            for (const i of this.unverified) this.counts[i] = undefined;
            this.unverified.clear();
            this.invalidated = true;
        } else if (real && differs) this.corrections++;
        if ((real && differs) || !old) {
            this.counts[s] = count;
            this.dirty = true;
        }
    }

    /**
     * Chapter (contents entry) around page `rel` of file `s`, as [start, end) in pages relative to the start of file
     * `s`; null while a file it spans is not counted yet.
     */
    chapterSpan(s: number, rel: number): { start: number; end: number } | null {
        const here = this.counts[s];
        if (!here) return null;
        let start: number | null = null;
        for (const p of here.starts) if (p <= rel) start = p;
        if (start === null) {
            let off = 0;
            for (let k = s - 1; k >= 0 && start === null; k--) {
                const c = this.counts[k];
                if (!c) return null;
                off -= c.pages;
                if (c.starts.length) start = off + c.starts[c.starts.length - 1];
            }
            if (start === null) start = off;
        }
        let end: number | null = null;
        for (const p of here.starts) if (p > rel) { end = p; break; }
        if (end === null) {
            let off = here.pages;
            for (let k = s + 1; k < this.counts.length && end === null; k++) {
                const c = this.counts[k];
                if (!c) return null;
                const next = c.starts.find((p) => off + p > rel);
                if (next !== undefined) end = off + next;
                off += c.pages;
            }
            if (end === null) end = off;
        }
        return { start, end: Math.max(end, start + 1) };
    }
}

/** Thrown inside a background job that a newer job (or the reader closing) replaced. */
const STOPPED = Symbol("stopped");

/** Target length of one piece of background layout (ms); the size of the next piece adapts to it. */
const PIECE_MS = 14;
const MIN_PIECE = 6_000;
const MAX_PIECE = 400_000;
/** Positions within this distance (px) are the same. */
const SAME = 0.6;
const WS_TEXT = /^\s*$/;
const FLOW_BOXES = new Set(["block", "list-item", "flow-root"]);

/** True when the browser has input waiting (Chromium); false where it cannot tell. */
function inputPending(): boolean {
    const s = (navigator as unknown as { scheduling?: { isInputPending?: (o?: { includeContinuous?: boolean }) => boolean } }).scheduling;
    try { return Boolean(s?.isInputPending?.({ includeContinuous: true })); } catch { return false; }
}

/**
 * A layout that needed a face not loaded yet (the book's italic, say: faces load when text first uses them) was made
 * with a stand-in face: waits for the load (bounded) and says so, and the caller lays the piece out again.
 */
async function faceWasMissing(): Promise<boolean> {
    if (typeof document === "undefined" || document.fonts?.status !== "loading") return false;
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
    return true;
}

/** Ends the current task so input and drawing go first (background work: "background"; work the reader may soon need: "user-visible"). */
export function nextSlice(priority: "background" | "user-visible" = "background"): Promise<void> {
    const s = (globalThis as unknown as { scheduler?: { postTask?: (cb: () => void, o: { priority: string }) => Promise<unknown> } }).scheduler;
    if (s?.postTask) return s.postTask(() => undefined, { priority }).then(() => undefined);
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The first character (or picture) of a column of a measured piece: its text offset and where it sits in the column. */
interface ColumnMark { o: number; atom: boolean; dx: number; dy: number }

/** Start of the next piece: a block that begins a page (column `col` of the piece), its first item and offset. */
interface PieceStart { el: Element; col: number; item: number; o: number }

/**
 * Counts the files of a PageIndex in the background, never in the reader's way. Work runs only while the reader is
 * idle (no turn, drag, selection or other input for 700 ms) in the browser's idle time, in pieces of about PIECE_MS,
 * and waits for the next idle moment as soon as input is waiting. A chapter file is loaded in slices (sanitizer) and
 * laid out piece by piece: a piece shows only part of the file (the rest is `display: none`; hidden siblings still
 * count for the book's selectors), and the next piece starts at a block that begins a page, after one empty column so
 * it meets an ordinary column break as on the real page. A start is accepted only when the next piece reproduces the
 * previous piece's following pages exactly (same first character, same position on each); a start that does not is
 * never used again and the previous piece is measured longer for another one. Content with no provable start ends up
 * in one layout of the rest of the file (at worst the whole file, as every file was counted before).
 */
export class PageCounter {
    private gen = 0;
    private host: HTMLElement | null = null;
    private flow: HTMLElement | null = null;
    private viewport: HTMLElement | null = null;
    private bookStyle: HTMLStyleElement | null = null;
    /** Rules of the current piece (hidden parts, the empty first column), in a layer declared before the reader's. */
    private pieceStyle: HTMLStyleElement | null = null;
    private marked: Element[] = [];
    /** Characters per piece (adapts to this device's layout speed). */
    private piece = MIN_PIECE;

    constructor(private readonly parent: ShadowRoot, private readonly source: FlowSource, private readonly entries: Map<number, Entry[]>,
        private readonly busy: () => boolean, private readonly keep: () => number[]) {}

    run(index: PageIndex, geo: Geometry, onUpdate: () => void) {
        const gen = ++this.gen;
        void this.loop(gen, index, geo, onUpdate).catch((error) => {
            if (error !== STOPPED && gen === this.gen) { index.failed = true; onUpdate(); }
        }).finally(() => {
            if (gen === this.gen) this.unmount();
        });
    }

    stop() {
        this.gen++;
        this.unmount();
    }

    private mount(geo: Geometry) {
        this.unmount();
        const host = document.createElement("div");
        host.setAttribute("aria-hidden", "true");
        host.style.cssText = `position:absolute;left:0;top:0;width:${geo.Pw}px;height:${geo.H}px;visibility:hidden;pointer-events:none;overflow:hidden;contain:strict;z-index:-1`;
        const shadow = host.attachShadow({ mode: "open" });
        // first in the shadow root, so its layer comes first and its !important rules win over the reader's and the book's
        this.pieceStyle = document.createElement("style");
        const base = document.createElement("style");
        base.textContent = READER_CSS;
        this.bookStyle = document.createElement("style");
        const box = document.createElement("div");
        box.style.cssText = "position:absolute;inset:0";
        for (const [k, v] of Object.entries(geo.vars)) box.style.setProperty(k, v);
        box.style.setProperty("--ec-cols", "1");
        this.viewport = document.createElement("div");
        this.viewport.style.cssText = `position:absolute;left:0;top:0;width:${geo.Pw}px;height:${geo.H}px;overflow:hidden`;
        this.flow = document.createElement("div");
        this.flow.className = "ec-flow ec-paged";
        this.flow.style.width = `${geo.Pw}px`;
        if (geo.lang) this.flow.lang = geo.lang;
        this.viewport.appendChild(this.flow);
        box.appendChild(this.viewport);
        shadow.append(this.pieceStyle, base, this.bookStyle, box);
        this.setPiece("");
        this.parent.appendChild(host);
        this.host = host;
    }

    private unmount() {
        this.host?.remove();
        this.host = this.flow = this.viewport = this.bookStyle = this.pieceStyle = null;
        this.marked = [];
    }

    /** Resolves when the reader is idle (no turn, drag or recent input) and the browser has a free moment. */
    private idle(gen: number): Promise<void> {
        return new Promise((resolve) => {
            const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
            const tick = () => {
                if (gen !== this.gen) return resolve();
                if (this.busy()) { window.setTimeout(tick, 350); return; }
                const go = () => { if (gen !== this.gen || !this.busy()) resolve(); else window.setTimeout(tick, 350); };
                if (ric) ric(go, { timeout: 1500 }); else window.setTimeout(go, 60);
            };
            tick();
        });
    }

    /** Waits for a moment the reader does not need (idle, no input waiting); the caller then runs in idle time. */
    private async slot(gen: number) {
        for (;;) {
            await this.idle(gen);
            if (gen !== this.gen) throw STOPPED;
            if (!this.busy() && !inputPending()) return;
        }
    }

    /** Pause between slices of a chapter load: the browser goes first, and the reader whenever it is in use. */
    private async pause(gen: number) {
        await nextSlice();
        if (gen !== this.gen) throw STOPPED;
        if (this.busy() || inputPending()) await this.slot(gen);
    }

    private async loop(gen: number, index: PageIndex, geo: Geometry, onUpdate: () => void) {
        this.mount(geo);
        for (let s = 0; s < index.counts.length; s++) {
            if (index.counts[s]) continue;
            await this.slot(gen);
            if (index.counts[s]) continue;
            let chapter;
            try { chapter = await this.source.loadChapter(s, () => this.pause(gen)); } catch (error) {
                if (error === STOPPED || gen !== this.gen) throw STOPPED;
                index.failed = true; onUpdate(); return;
            }
            if (gen !== this.gen || !this.flow || !this.viewport || !this.bookStyle) throw STOPPED;
            // out of layout until its first piece is measured, so no frame lays the chapter out meanwhile
            this.flow.setAttribute("data-ec-wait", "");
            this.bookStyle.textContent = `@layer book {\n${chapter.css}\n}`;
            this.flow.replaceChildren(chapter.root);
            const images = Array.from(chapter.root.querySelectorAll("img"));
            await Promise.race([
                Promise.all(images.map((img) => (img.complete ? null : new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); })))),
                new Promise((r) => setTimeout(r, 2500)),
            ]);
            if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
            if (gen !== this.gen) throw STOPPED;
            const count = await this.countPieces(gen, chapter.root, this.entries.get(s) ?? [], geo);
            if (!index.counts[s]) index.record(s, count, false);
            this.unmark();
            this.setPiece("");
            this.flow?.replaceChildren();
            this.source.retain(this.keep());
            onUpdate();
        }
    }

    private unmark() {
        for (const el of this.marked) { el.removeAttribute("data-ec-a"); el.removeAttribute("data-ec-z"); }
        this.marked = [];
    }

    private setPiece(rules: string) {
        if (this.pieceStyle) this.pieceStyle.textContent = `@layer ec-piece;\n@layer ec-piece {\n.ec-flow[data-ec-wait] { display: none !important; }\n${rules}\n}`;
    }

    /**
     * Shows only `from` (null: the file start) to `to` (null: the file end) and lays it out. Before a later piece's
     * start everything is hidden, its enclosing blocks lose their top padding / border / forced break (they began on
     * an earlier page) and an empty first column puts the start behind an ordinary column break, as on the real page.
     */
    private layoutPiece(root: Element, from: Element | null, to: Element | null) {
        this.unmark();
        const rules: string[] = [];
        const marked: Element[] = [];
        let n = 0;
        const mark = (el: Element, attr: "data-ec-a" | "data-ec-z") => {
            const id = String(++n);
            el.setAttribute(attr, id);
            marked.push(el);
            return `[${attr}="${id}"]`;
        };
        if (from) {
            rules.push(".ec-flow::before { content: \"\"; display: block; height: var(--ec-h); }");
            for (let x: Element = from; x !== root; x = x.parentElement!) {
                const parent = x.parentElement!;
                let before = 0;
                for (let y = x.previousElementSibling; y; y = y.previousElementSibling) before++;
                const sel = mark(parent, "data-ec-a");
                rules.push(`${sel} { padding-top: 0 !important; border-top-width: 0 !important; break-before: auto !important; page-break-before: auto !important; }`);
                if (before) rules.push(`${sel} > :nth-child(-n + ${before}) { display: none !important; }`);
            }
        }
        if (to) {
            for (let x: Element = to; x !== root; x = x.parentElement!) {
                let at = 1;
                for (let y = x.previousElementSibling; y; y = y.previousElementSibling) at++;
                if (x.nextElementSibling) rules.push(`${mark(x.parentElement!, "data-ec-z")} > :nth-child(n + ${at + 1}) { display: none !important; }`);
            }
        }
        this.marked = marked;
        this.setPiece(rules.join("\n"));
        this.flow!.removeAttribute("data-ec-wait");
        // laid out here, inside this piece's time: no frame is left with layout to do
        void this.viewport!.scrollWidth;
    }

    /** Counts one chapter file, piece by piece (see the class comment). */
    private async countPieces(gen: number, root: HTMLElement, entries: Entry[], geo: Geometry): Promise<FileCount> {
        const full = new TextIndex(root);
        const items = full.items;
        const targets: number[] = [];
        for (const e of entries) {
            if (e.frag) {
                const el = findId(root, e.frag);
                const o = el ? full.offsetOf(el, 0) : null;
                if (o !== null) targets.push(o);
            } else targets.push(e.o ?? 0);
        }
        // each entry belongs to the item the whole-file count would place it by (the first item at its offset: a
        // picture and the text after it share one offset), and to the piece holding that item
        const at = targets.map((o) => full.itemAt(o, 0));
        const starts = new Set<number>();
        const addStarts = (cols: Columns, first: number, end: number, pad: number, maxCol: number, base: number) => {
            targets.forEach((o, n) => {
                const j = at[n];
                if (j < first || j >= end) return;
                let tie = j;
                while (tie > first && items[tie - 1].start === items[j].start) tie--;
                const page = Math.max(pad, Math.min(maxCol, cols.columnOf(o, j - tie, maxCol)));
                const head = pageHead(cols, page);
                starts.add(base + (head >= o ? page : page + 1) - pad);
            });
        };
        let from: Element | null = null;
        let first = 0;          // first item of the piece
        let base = 0;           // pages of the file before the piece's first page
        let proof: ColumnMark[] | null = null;
        // the last proven piece start, to go back to when the next start does not prove out
        let prev: { from: Element | null; first: number; base: number; proof: ColumnMark[] | null } | null = null;
        const rejected = new Set<Element>();
        for (;;) {
            await this.slot(gen);
            if (!this.viewport) throw STOPPED;
            const fromO = items[first]?.start ?? 0;
            // the piece ends with the element holding the first item `this.piece` characters on (null: the file end)
            let to: Element | null = null;
            let last = items.length;
            const want = fromO + this.piece;
            if (items.length && items[items.length - 1].start > want) {
                let lo = first, hi = items.length - 1;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid].start >= want) hi = mid; else lo = mid + 1; }
                // blank text between blocks belongs to the enclosing block (often the whole file): end at a real one
                while (lo < items.length - 1 && !items[lo].atom && WS_TEXT.test((items[lo].node as Text).data)) lo++;
                const node = items[lo].node;
                to = node.nodeType === 1 ? node as Element : node.parentElement;
                if (!to || to === root) to = null;
                else {
                    last = lo;
                    while (last < items.length && to.contains(items[last].node)) last++;
                    if (last >= items.length) { to = null; last = items.length; }
                }
            }
            const t0 = performance.now();
            this.layoutPiece(root, from, to);
            const spent = performance.now() - t0;
            if (await faceWasMissing()) continue;
            if (!this.viewport) throw STOPPED;
            const cols = new Columns(this.viewport, TextIndex.slice(full, first, last), geo.stride);
            const chars = Math.max(1, (last > first ? items[last - 1].start + items[last - 1].len : fromO) - fromO);
            // shrinks at once, grows slowly: text laid out before costs less the second time, so one fast piece says
            // little about the next one
            if (spent > 1) this.piece = Math.round(Math.max(MIN_PIECE, Math.min(MAX_PIECE, this.piece * 1.25, chars * PIECE_MS / spent)));
            const pad: number = from ? 1 : 0;
            if (proof && !this.proves(cols, proof, pad)) {
                // this start lays out differently (a float carried over a page break, say): never use it; measure the
                // previous piece again, longer, so a later start is chosen (at worst the rest of the file at once)
                if (!prev || !from) return this.countWhole(gen, root, full, targets, geo);
                rejected.add(from);
                ({ from, first, base, proof } = prev);
                prev = null;
                this.piece = Math.min(MAX_PIECE * 4, Math.round(Math.max(this.piece, chars) * 1.5));
                continue;
            }
            if (!to) {
                const pages = pageCount(cols, this.viewport.scrollWidth, geo.gap, geo.stride);
                addStarts(cols, first, items.length, pad, pages - 1, base);
                const total = Math.max(1, base + pages - pad);
                return { pages: total, starts: [...starts].filter((p) => p < total).sort((a, b) => a - b) };
            }
            const lastCol = cols.contentPages();
            const next: PieceStart | null = lastCol === null ? null : this.pieceStart(cols, full, first, root, pad + 1, lastCol - 3, rejected);
            if (!next) {
                // no provable start in this piece: try a longer one (at worst the rest of the file in one layout)
                this.piece = Math.min(MAX_PIECE * 4, Math.round(Math.max(this.piece, chars) * 1.5));
                continue;
            }
            addStarts(cols, first, next.item, pad, next.col, base);
            const marks = this.marks(cols, next.col, lastCol! - 2);
            if (!marks.length) {
                rejected.add(next.el);
                continue;
            }
            prev = { from, first, base, proof };
            proof = marks;
            base += next.col - pad;
            from = next.el;
            first = next.item;
        }
    }

    /** Content no piece start could be proven in: the whole file in one layout (the way every file was counted before). */
    private async countWhole(gen: number, root: HTMLElement, full: TextIndex, targets: number[], geo: Geometry): Promise<FileCount> {
        do {
            await this.slot(gen);
            if (!this.viewport) throw STOPPED;
            this.layoutPiece(root, null, null);
        } while (await faceWasMissing());
        if (!this.viewport) throw STOPPED;
        const cols = new Columns(this.viewport, full, geo.stride);
        const pages = pageCount(cols, this.viewport.scrollWidth, geo.gap, geo.stride);
        const starts = new Set<number>();
        for (const o of targets) {
            const page = Math.max(0, Math.min(pages - 1, cols.columnOf(o, 0, pages - 1)));
            const head = pageHead(cols, page);
            starts.add(head >= o ? page : page + 1);
        }
        return { pages, starts: [...starts].filter((p) => p < pages).sort((a, b) => a - b) };
    }

    /** The first non-blank character (or picture) of column `col` from text offset `o`; null if it is not there. */
    private anchorIn(cols: Columns, o: number, col: number): { r: DOMRect; o: number; atom: boolean } | null {
        const items = cols.index.items;
        let i = Math.max(0, cols.index.itemAt(o));
        let from = items[i] && !items[i].atom ? Math.max(0, o - items[i].start) : 0;
        for (let n = 0; i < items.length && n < 200; i++, n++, from = 0) {
            const item = items[i];
            if (item.atom) {
                const r = (item.node as Element).getBoundingClientRect();
                if (r.width || r.height) return cols.colOf(r) === col ? { r, o: item.start, atom: true } : null;
                continue;
            }
            const data = (item.node as Text).data;
            for (let j = from; j < item.len && j < from + 80; j++) {
                if (/\s/.test(data[j])) continue;
                const r = cols.charRect(item.node as Text, j);
                if (r && (r.width || r.height)) return cols.colOf(r) === col ? { r, o: item.start + j, atom: false } : null;
            }
        }
        return null;
    }

    /** Where columns `from`.. (at most three, never past `to`) start and where their first characters sit. */
    private marks(cols: Columns, from: number, to: number): ColumnMark[] {
        const top = this.viewport!.getBoundingClientRect().top;
        const out: ColumnMark[] = [];
        for (let c = from; c <= Math.min(to, from + 2); c++) {
            const a = this.anchorIn(cols, cols.pageStart(c).o, c);
            if (!a) break;
            out.push({ o: a.o, atom: a.atom, dx: a.r.left - cols.columnLeft(c), dy: a.r.top - top });
        }
        return out.length >= 2 ? out : [];
    }

    /** The piece reproduces the previous piece's marked columns exactly (same first character, same place), from column `pad`. */
    private proves(cols: Columns, proof: ColumnMark[], pad: number): boolean {
        const top = this.viewport!.getBoundingClientRect().top;
        return proof.every((m, j) => {
            const c = pad + j;
            const a = this.anchorIn(cols, cols.pageStart(c).o, c);
            return Boolean(a) && a!.o === m.o && a!.atom === m.atom
                && Math.abs(a!.r.left - cols.columnLeft(c) - m.dx) <= SAME && Math.abs(a!.r.top - top - m.dy) <= SAME;
        });
    }

    /**
     * The latest block in columns [lo, hi] of the piece that begins exactly at the top of its column: the column's
     * first character is the block's first, it and its enclosing blocks are normal-flow block boxes, and only
     * elements precede each of them (so they can be hidden). Returns the block, its column, first item and offset.
     */
    private pieceStart(cols: Columns, full: TextIndex, first: number, root: Element, lo: number, hi: number, rejected: Set<Element>):
        PieceStart | null {
        const items = full.items;
        const solid = (i: number) => items[i].atom || !WS_TEXT.test((items[i].node as Text).data);
        for (let c = hi; c >= lo; c--) {
            const ps = cols.pageStart(c);
            let i = first + ps.item;
            if (i >= items.length || ps.o !== items[i].start) continue;
            while (i < items.length && !solid(i)) i++;
            if (i >= items.length || cols.itemCol(i - first) !== c) continue;
            let prev = i - 1;
            while (prev >= first && !solid(prev)) prev--;
            const before = prev >= 0 ? items[prev].node : null;
            const node = items[i].node;
            let el: Element | null = node.nodeType === 1 ? node as Element : node.parentElement;
            if (!el || el === root || (before && el.contains(before))) continue;
            while (el.parentElement && el.parentElement !== root && !(before && el.parentElement.contains(before))) el = el.parentElement;
            if (rejected.has(el) || !this.plain(el, root)) continue;
            let item = i;
            while (item > first && el.contains(items[item - 1].node)) item--;
            return { el, col: c, item, o: items[item].start };
        }
        return null;
    }

    /** `el` and the blocks around it are normal-flow block boxes, and only elements (or blank text) precede each. */
    private plain(el: Element, root: Element): boolean {
        for (let x: Element = el; x !== root; x = x.parentElement!) {
            const st = getComputedStyle(x);
            if (!FLOW_BOXES.has(st.display) || st.float !== "none" || (st.position !== "static" && st.position !== "relative")) return false;
            for (let y = x.previousSibling; y; y = y.previousSibling) {
                if (y.nodeType === 3 && !WS_TEXT.test((y as Text).data)) return false;
            }
        }
        return true;
    }
}
