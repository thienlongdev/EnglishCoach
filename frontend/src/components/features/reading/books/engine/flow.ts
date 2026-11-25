/**
 * Flow renderer for EPUB and TXT books (My Books).
 *
 * The book lives in a shadow root, isolated from the application's CSS and markup. A reflowable chapter is laid
 * out by the browser's own CSS multi-column engine: each column is one page, a spread shows two; the viewport
 * scrolls by whole pages, so text is native, crisp and selectable. Positions are text offsets (see text.ts), so a
 * different font size, theme, margin or window size re-paginates and lands on the same sentence.
 *
 * A page turn first freezes the visible page(s) as light page-sized copies (a Range of that page's blocks only, never
 * the chapter) laid out exactly like the real page, moves the real view underneath, and lets PageFlip fold the copy
 * away. A copy that cannot be proven identical to its page turns the page instantly instead. Fixed-layout EPUB pages
 * are each rendered at their own size and scaled to fit; scroll mode shows a chapter as one continuous column.
 * Whole-book page numbers come from a page index counted in the background under the current layout (pageIndex.ts).
 */
import { Columns } from "./columns";
import { PageFlip, type Pt } from "./pageFlip";
import { PAGE_INDEX_VERSION, PageCounter, PageIndex, countFile, entriesByFile, hashKey, nextSlice, pageCount, type Entry, type PageIndexCache } from "./pageIndex";
import { READER_CSS } from "./readerCss";
import { TextIndex, buildItems, type TextItem } from "./text";
import type { Annotation, FlowRange, FlowSource, LoadedChapter, Locator, ReaderPrefs } from "./types";

/** 1-based page numbers of the page(s) shown. */
export interface PageRange { first: number; last: number; total: number }

export interface PageNumbers {
    /** In the whole book under the current layout; null until every chapter file is counted. */
    book: PageRange | null;
    /** In the current chapter (contents entry); within the chapter file while its chapter is not counted yet. */
    chapter: PageRange | null;
    /** The whole-book count is still running. */
    counting: boolean;
}

export interface RelocateInfo {
    locator: Locator;
    spine: number;
    page: number;
    pages: number;
    progress: number;
    atStart: boolean;
    atEnd: boolean;
    /** Null in scroll mode. */
    numbers: PageNumbers | null;
}

export interface SelectionInfo {
    text: string;
    range: FlowRange;
    rect: DOMRect;
    sentence: string;
    context: string;
    /** The live range itself, so a panel can follow the text (scroll mode, reflow). */
    anchor: Range;
}

export interface FlowCallbacks {
    onRelocate(info: RelocateInfo): void;
    onSelection(sel: SelectionInfo | null): void;
    onTapCenter(): void;
    onHighlightClick(id: string, rect: DOMRect): void;
    onFootnote(text: string, rect: DOMRect, follow: () => void): void;
    onExternalLink(url: string): void;
    onBeforeJump(): void;
    onError(error: unknown): void;
    onEdge(which: "start" | "end"): void;
    onTurnFallback(): void;
}

interface Layout {
    mode: "paged" | "scroll" | "fixed";
    spread: boolean;
    mobile: boolean;
    Sw: number;
    bookW: number;
    bookH: number;
    mx: number;
    my: number;
    Pw: number;
    H: number;
    gap: number;
    stride: number;
}

interface View {
    s: number;
    root: HTMLElement;
    index: TextIndex;
    page?: HTMLElement;
}

type PageStart = { o: number; k: number; item: number };

/** Copy of one page for a turn: item `i0` of the chapter is the copy's first item (its first `shift` chars cut). */
interface PageCopy {
    node: Element;
    i0: number;
    shift: number;
    /** The copy runs on past the page (to the end of its last block) and must be clipped at the page's last line. */
    clip: boolean;
    ps: PageStart;
    pe: PageStart | null;
}

interface TurnScene {
    hingeX: number;
    mirror: boolean;
    front: HTMLElement;
    back: HTMLElement;
    reverse: boolean;
    dark: boolean;
}

const BLOCK = new Set(["p", "li", "blockquote", "dd", "dt", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "figcaption", "caption", "pre", "div", "section", "article", "aside"]);
const WS = /^\s*$/;
/** A page copy re-lays out at most this much text of its first / last block outside the page. */
const COPY_SLACK = 6000;
/** Empty sibling placeholders kept per level of a page copy (for the publisher's sibling selectors). */
const MAX_PLACEHOLDERS = 1500;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Text the body face is loaded and measured with (Latin + Vietnamese subsets). */
const FONT_SAMPLE = "Hamburgefonstiv QWXYZ 0123 ăâđêôơưạếỹ";
/** Input that keeps background work (page counting) away for a while; pointer movement alone does not. */
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function selectionRange(root: ShadowRoot): Range | null {
    const sel = document.getSelection();
    if (sel && "getComposedRanges" in sel) {
        try {
            const fn = (sel as unknown as { getComposedRanges: (o: unknown) => StaticRange[] }).getComposedRanges;
            let ranges: StaticRange[] = [];
            try { ranges = fn.call(sel, { shadowRoots: [root] }); } catch { ranges = fn.call(sel, root); }
            const r = ranges[0];
            if (r && !r.collapsed && root.contains(r.startContainer)) {
                const out = document.createRange();
                out.setStart(r.startContainer, r.startOffset);
                out.setEnd(r.endContainer, r.endOffset);
                return out;
            }
        } catch { /* fall back */ }
    }
    const own = (root as unknown as { getSelection?: () => Selection | null }).getSelection?.();
    if (own && own.rangeCount && !own.isCollapsed) return own.getRangeAt(0);
    if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (!r.collapsed && root.contains(r.startContainer)) return r;
    }
    return null;
}

export class FlowRenderer {
    private shadow: ShadowRoot;
    private stage!: HTMLElement;
    private book!: HTMLElement;
    private viewport!: HTMLElement;
    private flow!: HTMLElement;
    private overlay!: HTMLElement;
    private bookStyle: HTMLStyleElement;
    private running: HTMLElement[] = [];
    private layout!: Layout;
    private views: View[] = [];
    private s = 0;
    private page = 0;
    private pages = 1;
    /** The next chapter, loaded in slices ahead of time; `urgent` once the reader waits for it (no more pauses). */
    private prefetched: { s: number; promise: Promise<LoadedChapter>; urgent: { on: boolean } } | null = null;
    private highlights: Annotation[] = [];
    private seq = 0;
    private destroyed = false;
    private flip: PageFlip | null = null;
    private queue: Array<1 | -1> = [];
    private turning = false;
    private slowTurns = 0;
    private down: { x: number; y: number; t: number; zone: string; id: number; type: string; moved: boolean } | null = null;
    private drag: { dir: 1 | -1; ready: Promise<boolean>; flip: PageFlip | null; last: Pt; corner: "top" | "bottom" } | null = null;
    private resizeObserver: ResizeObserver;
    private resizeTimer = 0;
    private scrollTimer = 0;
    private selectionTimer = 0;
    private lastRelocate: RelocateInfo | null = null;
    /** Reading point kept across re-pagination (font, margins, window size); only navigation moves it. */
    private keep: Locator | null = null;
    private weights: number[];
    private totalWeight: number;
    private chapterLabel = "";
    /** Whole-book page index of the current layout (paged mode only), and those of recent layouts. */
    private index: PageIndex | null = null;
    private indexes = new Map<string, PageIndex>();
    private counter: PageCounter;
    private entries: Map<number, Entry[]>;
    private countTimer = 0;
    private lastInput = 0;
    private numbersKey = "";
    private indexSaveTimer = 0;
    /** Width of FONT_SAMPLE in a loaded face, by face + size: names the face a count was made with. */
    private fontMetrics = new Map<string, string>();
    /** Reader stylesheet, browser, pixel ratio and the book's files / contents: one key for the life of the reader. */
    private readonly envKey: string;
    /** Set while building a turn when a page copy does not match its real page. */
    private inexact = false;
    /** A position change not yet told to the reader UI: held during a turn so its update never delays the fold. */
    private relocatePending = false;

    constructor(private readonly host: HTMLElement, private readonly source: FlowSource, private prefs: ReaderPrefs,
        private readonly fonts: { body: string; ui: string; serif: string; sans: string }, private readonly cb: FlowCallbacks,
        private readonly vi = true, private readonly pageCache: PageIndexCache | null = null) {
        this.shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
        this.shadow.replaceChildren();
        const base = document.createElement("style");
        base.textContent = READER_CSS;
        this.bookStyle = document.createElement("style");
        this.shadow.append(base, this.bookStyle);
        this.weights = source.spine.map((s) => s.weight);
        this.totalWeight = this.weights.reduce((a, b) => a + b, 0) || 1;
        this.entries = entriesByFile(source.toc);
        const toc: string[] = [];
        for (const [s, list] of this.entries) for (const e of list) toc.push(`${s}#${e.frag ?? ""}@${e.o ?? ""}`);
        this.envKey = hashKey([READER_CSS, typeof navigator === "undefined" ? "" : navigator.userAgent, typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
            source.kind, source.spine.map((x) => x.href).join("\n"), toc.join(" ")].join("\u0001"));
        this.counter = new PageCounter(this.shadow, source, this.entries,
            () => this.destroyed || this.turning || Boolean(this.drag) || Boolean(this.down) || performance.now() - this.lastInput < 700,
            () => [this.s - 1, this.s, this.s + 1]);
        // any input anywhere (toolbar, panels, keys, wheel) keeps background work away for a while
        for (const type of INPUT_EVENTS) document.addEventListener(type, this.onAnyInput, { capture: true, passive: true });
        this.resizeObserver = new ResizeObserver(() => {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = window.setTimeout(() => void this.relayout(), 160);
        });
        this.resizeObserver.observe(host);
        document.addEventListener("selectionchange", this.onSelectionChange);
    }

    // ───────────────────────────── layout ─────────────────────────────

    private computeLayout(): Layout {
        const W = Math.max(280, this.host.clientWidth), Hh = Math.max(320, this.host.clientHeight);
        const mobile = W < 640;
        const S = this.prefs.fontSize;
        const mode: Layout["mode"] = this.source.fixedLayout ? "fixed" : this.prefs.turn === "scroll" ? "scroll" : "paged";
        const mx = (mobile ? { narrow: 16, normal: 24, wide: 34 } : { narrow: 40, normal: 62, wide: 92 })[this.prefs.margin];
        const my = mobile ? 42 : 56;
        const outerX = mobile ? 0 : 28, outerY = mobile ? 0 : 20;
        const bookH = Math.floor(Hh - 2 * outerY);
        const availW = W - 2 * outerX;
        const maxText = Math.round(S * 34);
        const minSpreadText = Math.round(S * 19);
        let spread = false;
        if (!mobile && mode !== "scroll") {
            const each = Math.floor(availW / 2);
            const canSpread = mode === "fixed" ? each >= 280 : each - 2 * mx >= minSpreadText;
            spread = this.prefs.layout === "spread" ? canSpread : this.prefs.layout === "single" ? false : canSpread && availW > bookH * 1.15;
        }
        let Sw: number;
        if (mode === "fixed") Sw = spread ? Math.floor(availW / 2) : availW;
        else if (mobile) Sw = W;
        else {
            Sw = spread ? Math.floor(availW / 2) : availW;
            // printed-page proportions (about 1 : 1.4) unless that would squeeze the text under ~25 em (≈ 55 characters a line)
            Sw = Math.min(Sw, maxText + 2 * mx, Math.max(Math.floor(bookH * (spread ? 0.7 : 0.72)), Math.round(S * 25) + 2 * mx));
            Sw = Math.max(Sw, Math.min(availW, Math.round(S * 16) + 2 * mx));
        }
        const Pw = Math.max(120, Math.floor(Sw - 2 * mx));
        const H = Math.max(160, Math.floor(bookH - 2 * my));
        const gap = 2 * mx;
        return { mode, spread, mobile, Sw, bookW: spread ? 2 * Sw : Sw, bookH, mx, my, Pw, H, gap, stride: Pw + gap };
    }

    private applyVars() {
        const p = this.prefs, L = this.layout;
        const font = p.font === "literata" ? this.fonts.body : p.font === "sans" ? this.fonts.sans : this.fonts.serif;
        const st = this.stage.style;
        this.stage.dataset.theme = p.theme;
        st.setProperty("--ec-font", font);
        st.setProperty("--ec-ui-font", this.fonts.ui);
        st.setProperty("--ec-size", `${p.fontSize}px`);
        st.setProperty("--ec-lh", String(p.lineHeight));
        st.setProperty("--ec-align", p.justify ? "justify" : "start");
        st.setProperty("--ec-hyph", p.hyphenate ? "auto" : "manual");
        st.setProperty("--ec-cols", L.spread ? "2" : "1");
        st.setProperty("--ec-gap", `${L.gap}px`);
        st.setProperty("--ec-h", `${L.H}px`);
    }

    private buildChrome() {
        const L = this.layout;
        this.stage?.remove();
        this.stage = document.createElement("div");
        this.stage.className = "ec-stage";
        this.book = document.createElement("div");
        this.book.className = `ec-book${L.mobile ? "" : " ec-raised"}`;
        this.book.style.width = `${L.bookW}px`;
        this.book.style.height = `${L.bookH}px`;
        const sheets = L.spread ? ["ec-left", "ec-right"] : ["ec-solo"];
        this.running = [];
        sheets.forEach((cls, i) => {
            const sheet = document.createElement("div");
            sheet.className = `ec-sheet ${cls}`;
            sheet.style.left = `${i * L.Sw}px`;
            sheet.style.width = `${L.Sw}px`;
            if (L.mode !== "fixed") {
                const head = document.createElement("div");
                head.className = "ec-running";
                head.style.cssText = `left:${L.mx}px;right:${L.mx}px;top:${Math.round(L.my * 0.42) - 6}px;text-align:${L.spread ? (i ? "right" : "left") : "center"}`;
                const foot = document.createElement("div");
                foot.className = "ec-running";
                foot.style.cssText = `left:${L.mx}px;right:${L.mx}px;bottom:${Math.round(L.my * 0.42) - 6}px;text-align:${L.spread ? (i ? "right" : "left") : "center"}`;
                sheet.append(head, foot);
                this.running.push(head, foot);
            } else {
                sheet.style.background = "transparent";
            }
            this.book.appendChild(sheet);
        });
        if (L.spread && L.mode !== "fixed") {
            const spine = document.createElement("div");
            spine.className = "ec-spine";
            spine.style.left = `${L.Sw}px`;
            this.book.appendChild(spine);
        }
        this.viewport = document.createElement("div");
        this.flow = document.createElement("div");
        if (L.mode === "fixed") {
            this.viewport.className = "ec-fxl";
        } else if (L.mode === "scroll") {
            this.viewport.className = "ec-viewport ec-scroll";
            this.viewport.style.cssText = `left:0;top:${Math.round(L.my * 0.6)}px;width:${L.Sw}px;height:${L.bookH - Math.round(L.my * 1.2)}px`;
            this.flow.className = "ec-flow";
            this.flow.style.cssText = `padding:0 ${L.mx}px`;
            this.viewport.appendChild(this.flow);
            this.viewport.addEventListener("scroll", this.onScroll, { passive: true });
        } else {
            this.viewport.className = "ec-viewport";
            const vw = L.spread ? 2 * L.Pw + L.gap : L.Pw;
            this.viewport.style.cssText = `left:${L.mx}px;top:${L.my}px;width:${vw}px;height:${L.H}px`;
            this.flow.className = "ec-flow ec-paged";
            this.flow.style.cssText = `width:${vw}px`;
            this.viewport.appendChild(this.flow);
        }
        // the book's language lets the browser hyphenate (`hyphens: auto` needs one); a chapter's own `lang` still wins
        const lang = this.source.language?.trim();
        if (lang && /^[a-z]{2,3}(-[\w]{1,8})*$/i.test(lang)) this.flow.lang = lang;
        this.overlay = document.createElement("div");
        this.overlay.className = "ec-overlay";
        this.book.append(this.viewport, this.overlay);
        this.stage.appendChild(this.book);
        this.shadow.appendChild(this.stage);
        this.book.addEventListener("pointerdown", this.onPointerDown);
        this.book.addEventListener("pointermove", this.onPointerMove);
        this.book.addEventListener("pointerup", this.onPointerUp);
        this.book.addEventListener("pointercancel", this.onPointerCancel);
        this.book.addEventListener("click", this.onClick);
        this.applyVars();
    }

    // ───────────────────────────── chapters ─────────────────────────────

    private load(s: number): Promise<LoadedChapter> {
        if (this.prefetched?.s === s) {
            const { promise, urgent } = this.prefetched;
            urgent.on = true;
            this.prefetched = null;
            return promise;
        }
        return this.source.loadChapter(s);
    }

    private prefetch(s: number) {
        if (s < 0 || s >= this.source.spine.length || this.prefetched?.s === s) return;
        const run = () => {
            if (this.destroyed) return;
            // loaded in slices that let input and drawing go first, until the reader needs it
            const urgent = { on: false };
            const promise = this.source.loadChapter(s, () => (urgent.on ? Promise.resolve() : nextSlice("user-visible")));
            promise.catch(() => undefined);
            this.prefetched = { s, promise, urgent };
        };
        const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        if (idle) idle(run, { timeout: 1500 }); else setTimeout(run, 400);
    }

    private async settle(root: HTMLElement) {
        const images = Array.from(root.querySelectorAll("img"));
        await Promise.race([Promise.all(images.map((img) => (img.complete ? null : img.decode().catch(() => null)))), delay(2500)]);
        if (document.fonts?.ready) await Promise.race([document.fonts.ready, delay(1500)]);
    }

    private async renderChapter(s: number): Promise<boolean> {
        const seq = ++this.seq;
        const L = this.layout;
        if (L.mode === "fixed") return this.renderFixed(s, seq);
        const chapter = await this.load(s);
        if (seq !== this.seq || this.destroyed) return false;
        this.bookStyle.textContent = `@layer book {\n${chapter.css}\n}`;
        this.flow.replaceChildren(chapter.root);
        if (L.mode === "scroll" && s + 1 < this.source.spine.length) {
            const next = document.createElement("div");
            next.className = "ec-scroll-next";
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Chương tiếp theo →";
            button.addEventListener("click", () => void this.goTo({ s: s + 1, o: 0 }));
            next.appendChild(button);
            this.flow.appendChild(next);
        }
        this.s = s;
        await this.settle(chapter.root);
        if (seq !== this.seq || this.destroyed) return false;
        this.views = [{ s, root: chapter.root, index: new TextIndex(chapter.root) }];
        this.applyHighlights();
        for (const img of Array.from(chapter.root.querySelectorAll("img"))) {
            if (!img.complete) img.addEventListener("load", () => void this.reanchor(), { once: true });
        }
        this.measure();
        this.chapterLabel = this.tocLabel(s);
        this.source.retain([s - 1, s, s + 1]);
        this.prefetch(s + 1);
        return true;
    }

    private async renderFixed(s: number, seq: number): Promise<boolean> {
        const L = this.layout;
        const count = this.source.spine.length;
        const first = L.spread ? s - (s % 2) : s;
        const indices = L.spread ? [first, first + 1].filter((i) => i < count) : [first];
        const chapters = await Promise.all(indices.map((i) => this.load(i)));
        if (seq !== this.seq || this.destroyed) return false;
        this.bookStyle.textContent = `@layer book {\n${[...new Set(chapters.map((c) => c.css))].join("\n")}\n}`;
        this.viewport.replaceChildren();
        this.views = [];
        indices.forEach((i, n) => {
            const ch = chapters[n];
            const size = ch.fixed ?? { width: 1200, height: 1600 };
            const slotW = L.Sw, slotH = L.bookH;
            const scale = Math.min(slotW / size.width, slotH / size.height);
            const page = document.createElement("div");
            page.className = "ec-fxl-page";
            const w = Math.floor(size.width * scale), h = Math.floor(size.height * scale);
            const left = L.spread ? (n === 0 ? L.Sw - w : L.Sw) : Math.floor((L.Sw - w) / 2);
            page.style.cssText = `position:absolute;left:${left}px;top:${Math.floor((slotH - h) / 2)}px;width:${w}px;height:${h}px`;
            const box = document.createElement("div");
            box.className = "ec-fxl-box";
            box.style.cssText = `width:${size.width}px;height:${size.height}px;transform:scale(${scale})`;
            box.appendChild(ch.root);
            page.appendChild(box);
            this.viewport.appendChild(page);
            this.views.push({ s: i, root: ch.root, index: new TextIndex(ch.root), page });
        });
        this.viewport.style.cssText = `position:absolute;inset:0`;
        this.s = first;
        await Promise.all(this.views.map((v) => this.settle(v.root)));
        if (seq !== this.seq) return false;
        for (const v of this.views) v.index.rebuild();
        this.applyHighlights();
        this.page = 0;
        this.pages = 1;
        this.chapterLabel = this.tocLabel(first);
        this.source.retain([first - 2, first - 1, first, first + 1, first + 2, first + 3]);
        this.prefetch(first + indices.length);
        return true;
    }

    /**
     * Contents entry the reading point `o` of chapter file `s` belongs to: the last entry that starts at or before it.
     * Several chapters often share one file, so an entry's own fragment (or TXT offset) is resolved in the loaded view;
     * in a file that is not loaded, its first entry stands for the whole file.
     */
    private tocLabel(s: number, o = 0): string {
        let label = "";
        let firstOfFile = true;
        const view = this.views.find((v) => v.s === s);
        const walk = (items: typeof this.source.toc) => {
            for (const item of items) {
                const t = item.target;
                let starts = t.s < s;
                if (t.s === s) {
                    let at: number | null = t.frag ? (view ? this.fragOffset(view, t.frag) : null) : t.o ?? 0;
                    if (at === null) at = firstOfFile ? 0 : Number.POSITIVE_INFINITY;
                    firstOfFile = false;
                    starts = at <= o;
                }
                if (starts) label = item.label;
                if (item.children.length) walk(item.children);
            }
        };
        walk(this.source.toc);
        return label || this.source.title;
    }

    private fragOffsets = new WeakMap<HTMLElement, Map<string, number | null>>();
    private fragOffset(view: View, frag: string): number | null {
        let map = this.fragOffsets.get(view.root);
        if (!map) { map = new Map(); this.fragOffsets.set(view.root, map); }
        if (!map.has(frag)) {
            const el = this.findId(view.root, frag);
            map.set(frag, el ? view.index.offsetOf(el, 0) : null);
        }
        return map.get(frag) ?? null;
    }

    /** Reading point the running head names: the right-hand page of a spread (as in a printed book), else the page. */
    private labelOffset(): number {
        const L = this.layout;
        if (!this.view || L.mode === "fixed") return 0;
        if (L.mode === "scroll") return this.scrollStart();
        const p = L.spread && this.page + 1 < this.pages ? this.page + 1 : this.page;
        return this.pageStart(p).o;
    }

    private measure() {
        const L = this.layout;
        if (L.mode !== "paged") { this.pages = 1; return; }
        const cols = this.cols();
        this.pages = cols ? pageCount(cols, this.viewport.scrollWidth, L.gap, L.stride) : Math.max(1, Math.round((this.viewport.scrollWidth + L.gap) / L.stride));
        // A spread shows pages two by two. When a chapter ends on a left-hand page the browser cannot scroll that far
        // (it would show the page before again): an empty last column lets the view reach it.
        const pad = this.flow.querySelector(":scope > .ec-pad");
        pad?.remove();
        const lastSpread = L.spread ? this.pages - 1 - ((this.pages - 1) % 2) : 0;
        if (L.spread && lastSpread * L.stride > this.viewport.scrollWidth - this.viewport.clientWidth + 1) {
            const spacer = document.createElement("div");
            spacer.className = "ec-pad";
            spacer.setAttribute("aria-hidden", "true");
            this.flow.appendChild(spacer);
        }
        // the visible chapter's real layout is the reference count of its file: read in the next idle moment, so a
        // turn into a new chapter shows its page without waiting for the check
        if (this.index && this.view) this.scheduleReference();
    }

    private referenceTimer = 0;
    private scheduleReference() {
        clearTimeout(this.referenceTimer);
        const view = this.view, layout = this.layout, index = this.index;
        const run = () => {
            if (this.destroyed || this.view !== view || this.layout !== layout || this.index !== index || !view || !index) return;
            if (this.turning || this.drag) { this.referenceTimer = window.setTimeout(run, 300); return; }
            const cols = this.cols();
            if (!cols) return;
            index.record(this.s, countFile(cols, view.root, this.entries.get(this.s) ?? [], this.pages), true);
            if (index.invalidated) {
                // restored counts that do not match this layout: forget the stored index and count the book again
                index.invalidated = false;
                this.pageCache?.drop(index.signature);
                this.scheduleCounting(900);
            }
            this.scheduleIndexSave();
            if (JSON.stringify(this.numbers()) !== this.numbersKey) { this.updateRunning(); this.emitRelocate(); }
        };
        const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        this.referenceTimer = window.setTimeout(() => { if (ric) ric(run, { timeout: 1000 }); else run(); }, 0);
    }

    private get view(): View | undefined {
        return this.views[0];
    }

    // ───────────────────────────── geometry ─────────────────────────────

    /** Column geometry of the visible chapter (positions read now). */
    private cols(): Columns | null {
        const view = this.view;
        return view ? new Columns(this.viewport, view.index, this.layout.stride) : null;
    }

    /** First text position of a page (column) of the current reflowable chapter. */
    private pageStart(p: number): { o: number; k: number; item: number } {
        if (p <= 0) return { o: 0, k: 0, item: 0 };
        return this.cols()?.pageStart(p) ?? { o: 0, k: 0, item: 0 };
    }

    private columnOf(o: number, k = 0): number {
        return this.cols()?.columnOf(o, k, Math.max(0, this.pages - 1)) ?? 0;
    }

    private pageFor(loc: Locator): number {
        const view = this.view;
        if (!view) return 0;
        let o = loc.o;
        if (loc.t && view.index.text(o, o + loc.t.length) !== loc.t) {
            const text = view.index.text(Math.max(0, o - 4000), o + 4000);
            const at = text.indexOf(loc.t);
            if (at >= 0) o = Math.max(0, o - 4000) + at;
        }
        if (this.layout.mode === "scroll") return 0;
        const col = Math.max(0, Math.min(this.pages - 1, this.columnOf(o, loc.k ?? 0)));
        return this.layout.spread ? col - (col % 2) : col;
    }

    // ───────────────────────────── display ─────────────────────────────

    private show(page: number) {
        const L = this.layout;
        this.page = Math.max(0, Math.min(page, this.pages - 1));
        if (L.spread) this.page -= this.page % 2;
        if (L.mode === "paged") this.viewport.scrollLeft = this.page * L.stride;
        this.updateRunning();
        this.emitRelocate();
    }

    private updateRunning() {
        const L = this.layout;
        this.chapterLabel = this.tocLabel(this.s, this.labelOffset());
        if (L.mode === "fixed" || !this.running.length) return;
        const pct = Math.round(this.progressAt(this.page) * 100);
        const title = this.chapterLabel;
        if (L.mode === "scroll") {
            this.running.forEach((el) => (el.textContent = ""));
            return;
        }
        const n = this.numbers();
        const vi = this.vi;
        const span = (r: PageRange) => (r.first === r.last ? `${r.first}` : `${r.first}–${r.last}`);
        const chapter = n?.chapter ? `${span(n.chapter)}/${n.chapter.total} ${vi ? "trong chương" : "in chapter"}` : "";
        const book = n?.book ? `${span(n.book)}/${n.book.total}` : "";
        if (L.spread) {
            this.running[0].textContent = this.source.title;
            this.running[1].textContent = chapter;
            this.running[2].textContent = title;
            this.running[3].textContent = [book && `${vi ? "Trang" : n!.book!.first === n!.book!.last ? "Page" : "Pages"} ${book}`, `${pct}%`].filter(Boolean).join(" · ");
        } else {
            this.running[0].textContent = title;
            this.running[1].textContent = [chapter, book && `${vi ? "trang" : "page"} ${book}`, `${pct}%`].filter(Boolean).join(" · ");
        }
    }

    /**
     * Page numbers of the page(s) shown. A reflowable book's pages are those of the current layout (font, size, line
     * height, margins, page size): the count changes with them and is never a printed edition's page number.
     */
    private numbers(): PageNumbers | null {
        const L = this.layout;
        if (L.mode === "scroll") return null;
        if (L.mode === "fixed") {
            const total = this.source.spine.length;
            const last = (this.views[this.views.length - 1]?.s ?? this.s) + 1;
            return { book: { first: this.s + 1, last, total }, chapter: null, counting: false };
        }
        const shown = L.spread && this.page + 1 < this.pages ? [this.page, this.page + 1] : [this.page];
        const labelled = shown[shown.length - 1];
        const index = this.index;
        const span = index?.chapterSpan(this.s, labelled) ?? null;
        let chapter: PageRange;
        if (span) {
            const inside = shown.filter((p) => p >= span.start && p < span.end);
            chapter = { first: inside[0] - span.start + 1, last: inside[inside.length - 1] - span.start + 1, total: span.end - span.start };
        } else chapter = { first: shown[0] + 1, last: shown[shown.length - 1] + 1, total: this.pages };
        const base = index?.complete ? index.base(this.s) : null;
        const total = index?.total ?? null;
        const book = base !== null && total !== null ? { first: base + shown[0] + 1, last: base + shown[shown.length - 1] + 1, total } : null;
        return { book, chapter, counting: Boolean(index && !index.complete && !index.failed) };
    }

    private progressAt(page: number): number {
        const L = this.layout;
        const total = L.mode === "paged" ? this.index?.total : null;
        const base = total ? this.index!.base(this.s) : null;
        if (total && base !== null) return Math.max(0, Math.min(1, (base + Math.min(this.pages, page + (L.spread ? 2 : 1))) / total));
        const before = this.weights.slice(0, this.s).reduce((a, b) => a + b, 0);
        const within = L.mode === "fixed" ? 1 : L.mode === "scroll" ? this.scrollFraction() : Math.min(1, (page + (L.spread ? 2 : 1)) / this.pages);
        return Math.max(0, Math.min(1, (before + (this.weights[this.s] ?? 0) * within) / this.totalWeight));
    }

    // ───────────────────────────── whole-book page index ─────────────────────────────

    private bodyFont(): string {
        const p = this.prefs;
        return p.font === "literata" ? this.fonts.body : p.font === "sans" ? this.fonts.sans : this.fonts.serif;
    }

    /**
     * Everything the pages of a reflowable book depend on: counting rules, reader stylesheet, browser, pixel ratio,
     * the book's files and contents (envKey), page width / height / gap (margins), the face actually loaded (its
     * measured width; "?" while unknown), size, line height, justification, hyphenation and language. Theme and
     * one- / two-page layout are not in it: they leave the page geometry as it is.
     */
    private signature(): string | null {
        const L = this.layout, p = this.prefs;
        if (!L || L.mode !== "paged") return null;
        const font = this.bodyFont();
        const metric = this.fontMetrics.get(`${font}|${p.fontSize}`) ?? "?";
        return [PAGE_INDEX_VERSION, this.envKey, L.Pw, L.H, L.gap, hashKey(font), metric, p.fontSize, p.lineHeight, p.justify ? 1 : 0, p.hyphenate ? 1 : 0, this.flow?.lang ?? ""].join("|");
    }

    /**
     * Loads the body face at the current size (bounded wait) and measures it, so a stored page index is used only
     * for the face it was counted with. A face that did not load in time leaves the layout unmeasured: its index is
     * counted but neither restored nor stored.
     */
    private async measureFont(): Promise<void> {
        if (this.source.fixedLayout || this.prefs.turn === "scroll" || !this.pageCache || typeof document === "undefined") return;
        const font = this.bodyFont(), size = this.prefs.fontSize, key = `${font}|${size}`;
        if (this.fontMetrics.has(key)) return;
        const spec = `${size}px ${font}`;
        try {
            if (document.fonts?.load) await Promise.race([document.fonts.load(spec, FONT_SAMPLE), delay(1500)]);
            if (document.fonts?.check && !document.fonts.check(spec, FONT_SAMPLE)) return;
            const ctx = document.createElement("canvas").getContext("2d");
            if (!ctx) return;
            ctx.font = spec;
            this.fontMetrics.set(key, ctx.measureText(FONT_SAMPLE).width.toFixed(2));
        } catch { /* unmeasured: this layout is not cached */ }
    }

    /** Selects (or creates) the page index of the current layout; counting starts later, when the reader is idle. */
    private useIndex() {
        this.counter.stop();
        clearTimeout(this.countTimer);
        const sig = this.signature();
        if (this.index && this.index.signature !== sig) this.saveIndex(this.index);
        if (!sig) { this.index = null; return; }
        let index = this.indexes.get(sig);
        if (!index) {
            index = new PageIndex(sig, this.source.spine.length);
            index.persist = Boolean(this.pageCache) && !sig.includes("|?|");
            if (index.persist) {
                const stored = this.pageCache!.get(sig);
                if (stored && !index.restore(stored)) this.pageCache!.drop(sig);
            }
            this.indexes.set(sig, index);
            if (this.indexes.size > 4) this.indexes.delete(this.indexes.keys().next().value as string);
        }
        this.index = index;
    }

    /** Stores the current index once its counts settle (debounced; never during a turn, a drag or recent input). */
    private scheduleIndexSave(ms = 2500) {
        const index = this.index;
        if (!index?.persist || !index.dirty) return;
        clearTimeout(this.indexSaveTimer);
        this.indexSaveTimer = window.setTimeout(() => {
            if (this.destroyed || index !== this.index) return;
            if (this.turning || this.drag || this.down || performance.now() - this.lastInput < 700) { this.scheduleIndexSave(1000); return; }
            this.saveIndex(index);
        }, ms);
    }

    private saveIndex(index: PageIndex) {
        if (!index.persist || !index.dirty || !this.pageCache || !index.counted) return;
        index.dirty = false;
        this.pageCache.put(index.signature, index.snapshot());
    }

    private scheduleCounting(ms: number) {
        clearTimeout(this.countTimer);
        this.countTimer = window.setTimeout(() => {
            const index = this.index, L = this.layout;
            if (this.destroyed || !index || index.complete || index.failed || L.mode !== "paged") return;
            const vars: Record<string, string> = {};
            for (const k of ["--ec-font", "--ec-size", "--ec-lh", "--ec-align", "--ec-hyph", "--ec-gap", "--ec-h"]) vars[k] = this.stage.style.getPropertyValue(k);
            this.counter.run(index, { Pw: L.Pw, H: L.H, gap: L.gap, stride: L.stride, vars, lang: this.flow.lang }, () => {
                if (index !== this.index || this.destroyed) return;
                this.scheduleIndexSave(index.complete ? 600 : 2500);
                if (this.turning || this.drag) return;
                const key = JSON.stringify(this.numbers());
                if (key === this.numbersKey) return;
                this.updateRunning();
                this.emitRelocate();
            });
        }, ms);
    }

    private scrollFraction(): number {
        const vp = this.viewport;
        const max = vp.scrollHeight - vp.clientHeight;
        return max > 0 ? Math.min(1, (vp.scrollTop + vp.clientHeight) / vp.scrollHeight) : 1;
    }

    private currentLocator(): Locator {
        const L = this.layout;
        const view = this.view;
        if (!view) return { s: this.s, o: 0 };
        if (L.mode === "fixed") return { s: this.s, o: 0 };
        let o = 0, k = 0;
        if (L.mode === "scroll") {
            o = this.scrollStart();
        } else {
            const start = this.pageStart(this.page);
            o = start.o;
            k = start.k;
        }
        return { s: this.s, o, k: k || undefined, t: view.index.text(o, o + 32) || undefined };
    }

    private scrollStart(): number {
        const view = this.view;
        if (!view) return 0;
        const top = this.viewport.getBoundingClientRect().top;
        const items = view.index.items;
        let lo = 0, hi = items.length;
        const yOf = (i: number): number | null => {
            const item = items[i];
            let rect: DOMRect | null = null;
            if (item.atom) rect = (item.node as Element).getBoundingClientRect();
            else if (!WS.test((item.node as Text).data)) {
                const r = document.createRange();
                r.selectNodeContents(item.node);
                const rects = r.getClientRects();
                rect = rects.length ? rects[rects.length - 1] : null;
            }
            return rect && (rect.width || rect.height) ? rect.bottom : null;
        };
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            let y: number | null = null;
            for (let j = mid; j < items.length && y === null && j < mid + 200; j++) y = yOf(j);
            if (y === null || y > top + 2) hi = mid; else lo = mid + 1;
        }
        return lo < items.length ? items[lo].start : view.index.total;
    }

    private emitRelocate() {
        const L = this.layout;
        const last = this.source.spine.length - 1;
        const lastView = this.views[this.views.length - 1]?.s ?? this.s;
        const numbers = this.numbers();
        this.numbersKey = JSON.stringify(numbers);
        const info: RelocateInfo = {
            numbers,
            locator: this.keep && this.keep.s === this.s && this.layout.mode === "paged" ? this.keep : this.currentLocator(),
            spine: this.s,
            page: this.page,
            pages: this.pages,
            progress: this.progressAt(this.page),
            atStart: this.s === 0 && this.page === 0 && (L.mode !== "scroll" || this.viewport.scrollTop < 4),
            atEnd: L.mode === "fixed" ? lastView >= last
                : this.s === last && (L.mode === "scroll" ? this.scrollFraction() >= 0.995 : this.page + (L.spread ? 2 : 1) >= this.pages),
        };
        this.lastRelocate = info;
        if (this.turning) { this.relocatePending = true; return; }
        this.relocatePending = false;
        this.cb.onRelocate(info);
    }

    /** Tells the reader UI the position a turn arrived at (held while the page was turning). */
    private flushRelocate() {
        if (!this.relocatePending || this.destroyed || this.turning || !this.lastRelocate) return;
        this.relocatePending = false;
        this.cb.onRelocate(this.lastRelocate);
    }

    // ───────────────────────────── public API ─────────────────────────────

    async open(loc: Locator | null) {
        this.layout = this.computeLayout();
        this.buildChrome();
        if (this.layout.mode === "paged") {
            // parse the first chapter while the body face loads (a stored page index is looked up by that face)
            const first = Math.max(0, Math.min(this.source.spine.length - 1, loc?.s ?? 0));
            const promise = this.source.loadChapter(first);
            promise.catch(() => undefined);
            this.prefetched = { s: first, promise, urgent: { on: true } };
            await this.measureFont();
            if (this.destroyed) return;
        }
        this.useIndex();
        await this.goTo(loc ?? { s: 0, o: 0 }, false);
        this.scheduleCounting(1500);
    }

    getLocator(): Locator | null {
        return this.lastRelocate?.locator ?? null;
    }

    /** Text range shown now (both pages of a spread), for "is this page bookmarked". */
    currentPageRange(): { s: number; start: number; end: number } | null {
        const L = this.layout, view = this.view;
        if (!view || !L) return null;
        if (L.mode === "fixed") return { s: this.s, start: 0, end: Number.MAX_SAFE_INTEGER };
        if (L.mode === "scroll") { const start = this.scrollStart(); return { s: this.s, start, end: start + 1200 }; }
        const step = L.spread ? 2 : 1;
        const start = this.pageStart(this.page).o;
        const end = this.page + step >= this.pages ? view.index.total + 1 : this.pageStart(this.page + step).o;
        return { s: this.s, start, end: Math.max(end, start + 1) };
    }

    /** Contents entry of a position (`o` = text offset in chapter file `s`). */
    tocLabelFor(s: number, o = 0): string {
        return this.tocLabel(s, o);
    }

    /** Contents entry of the page(s) shown now. */
    currentLabel(): string {
        return this.chapterLabel;
    }

    get chapterCount(): number {
        return this.source.spine.length;
    }

    async goTo(loc: Locator, jump = true) {
        if (this.destroyed) return;
        this.lastInput = performance.now();
        if (jump) this.keep = null;
        if (jump) this.cb.onBeforeJump();
        this.cancelTurns();
        const s = Math.max(0, Math.min(this.source.spine.length - 1, loc.s));
        try {
            const L = this.layout;
            const visible = this.views.some((v) => v.s === s);
            if (!visible || L.mode !== "fixed" && s !== this.s) {
                if (!(await this.renderChapter(s))) return;
            }
            if (L.mode === "scroll") {
                const point = this.view?.index.point(loc.o);
                this.viewport.scrollTop = 0;
                if (point && loc.o > 0) {
                    const r = document.createRange();
                    r.setStart(point.node, point.offset);
                    r.setEnd(point.node, Math.min((point.node as Text).length ?? 0, point.offset + 1));
                    const rect = r.getBoundingClientRect();
                    this.viewport.scrollTop += rect.top - this.viewport.getBoundingClientRect().top - 8;
                }
                this.updateRunning();
                this.emitRelocate();
                return;
            }
            this.show(L.mode === "fixed" ? 0 : this.pageFor(loc));
        } catch (error) {
            this.cb.onError(error);
        }
    }

    async goToTarget(target: { s: number; frag?: string; o?: number }) {
        if (target.frag) {
            this.cb.onBeforeJump();
            if (this.s !== target.s || !this.views.some((v) => v.s === target.s)) {
                if (!(await this.renderChapter(target.s))) return;
            }
            const view = this.views.find((v) => v.s === target.s) ?? this.view;
            const el = view ? this.findId(view.root, target.frag) : null;
            const o = el && view ? view.index.offsetOf(el, 0) ?? 0 : 0;
            await this.goTo({ s: target.s, o }, false);
            return;
        }
        await this.goTo({ s: target.s, o: target.o ?? 0 });
    }

    private findId(root: HTMLElement, id: string): Element | null {
        try { return root.querySelector(`#${CSS.escape(id)}`) ?? root.querySelector(`[name="${CSS.escape(id)}"]`); } catch { return null; }
    }

    async goToFraction(f: number) {
        this.keep = null;
        const total = this.layout.mode === "paged" ? this.index?.total : null;
        if (total) {
            // counted book: the fraction is a page of the whole book
            const g = Math.max(0, Math.min(total - 1, Math.floor(Math.max(0, Math.min(1, f)) * total)));
            let first = 0;
            for (let s = 0; s < this.source.spine.length; s++) {
                const pages = this.index!.counts[s]!.pages;
                if (g < first + pages || s === this.source.spine.length - 1) {
                    this.cb.onBeforeJump();
                    if (s !== this.s || !this.views.some((v) => v.s === s)) {
                        if (!(await this.renderChapter(s))) return;
                    }
                    this.show(g - first);
                    return;
                }
                first += pages;
            }
        }
        let acc = 0;
        const target = Math.max(0, Math.min(1, f)) * this.totalWeight;
        for (let s = 0; s < this.weights.length; s++) {
            if (acc + this.weights[s] >= target || s === this.weights.length - 1) {
                const within = this.weights[s] ? (target - acc) / this.weights[s] : 0;
                this.cb.onBeforeJump();
                if (s !== this.s || !this.views.some((v) => v.s === s)) {
                    if (!(await this.renderChapter(s))) return;
                }
                if (this.layout.mode === "paged") this.show(Math.floor(within * this.pages));
                else if (this.layout.mode === "scroll") {
                    this.viewport.scrollTop = within * (this.viewport.scrollHeight - this.viewport.clientHeight);
                    this.emitRelocate();
                } else this.show(0);
                return;
            }
            acc += this.weights[s];
        }
    }

    setPrefs(prefs: ReaderPrefs) {
        const before = this.prefs;
        this.prefs = prefs;
        if (!this.stage) return;
        const relayout = before.fontSize !== prefs.fontSize || before.lineHeight !== prefs.lineHeight || before.margin !== prefs.margin
            || before.font !== prefs.font || before.justify !== prefs.justify || before.hyphenate !== prefs.hyphenate
            || before.layout !== prefs.layout || (before.turn === "scroll") !== (prefs.turn === "scroll");
        if (relayout) void this.relayout(true);
        else this.applyVars();
    }

    private async relayout(force = false) {
        if (this.destroyed || !this.stage) return;
        if (force) {
            await this.measureFont();
            if (this.destroyed) return;
        }
        const next = this.computeLayout();
        const L = this.layout;
        if (!force && L && next.bookW === L.bookW && next.bookH === L.bookH && next.spread === L.spread && next.mode === L.mode && next.Pw === L.Pw) return;
        const loc = this.lastRelocate?.locator ?? { s: this.s, o: 0 };
        this.cancelTurns();
        this.layout = next;
        this.keep = loc;
        const views = this.views;
        this.buildChrome();
        // another layout has other pages: switch to its index (counted again unless a recent layout already was)
        this.useIndex();
        this.scheduleCounting(900);
        if (views.length && next.mode !== "fixed" && L?.mode !== "fixed" && views[0].s === loc.s) {
            // reuse the chapter DOM: re-paginate in place
            this.flow.replaceChildren(views[0].root);
            this.views = [{ ...views[0] }];
            await delay(0);
            if (next.mode === "scroll" && loc.s + 1 < this.source.spine.length) {
                const holder = document.createElement("div");
                holder.className = "ec-scroll-next";
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = "Chương tiếp theo →";
                button.addEventListener("click", () => void this.goTo({ s: loc.s + 1, o: 0 }));
                holder.appendChild(button);
                this.flow.appendChild(holder);
            }
            this.measure();
            await this.goTo(loc, false);
        } else {
            this.views = [];
            await this.goTo(loc, false);
        }
    }

    private async reanchor() {
        if (this.turning || this.layout.mode !== "paged") return;
        const loc = this.lastRelocate?.locator;
        this.measure();
        if (loc && loc.s === this.s) { this.keep = loc; this.show(this.pageFor(loc)); }
    }

    // ───────────────────────────── highlights ─────────────────────────────

    setHighlights(list: Annotation[]) {
        this.highlights = list.filter((a) => a.kind === "highlight" && a.range);
        if (this.drag) return;
        this.applyHighlights();
    }

    private applyHighlights() {
        for (const view of this.views) {
            const marks = view.root.querySelectorAll("mark.ec-hl");
            if (marks.length) {
                marks.forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
                view.root.normalize();
                view.index.rebuild();
            }
            const mine = this.highlights.filter((h) => h.range!.s === view.s).sort((a, b) => a.range!.start - b.range!.start);
            for (const h of mine) {
                const segments = view.index.segments(h.range!.start, h.range!.end);
                for (const seg of segments) {
                    let node = seg.node;
                    if (seg.to < node.length) node.splitText(seg.to);
                    if (seg.from > 0) node = node.splitText(seg.from);
                    const mark = document.createElement("mark");
                    mark.className = h.note ? "ec-hl ec-has-note" : "ec-hl";
                    mark.dataset.hl = h.id;
                    mark.dataset.c = h.color ?? "yellow";
                    node.replaceWith(mark);
                    mark.appendChild(node);
                }
                if (segments.length) view.index.rebuild();
            }
        }
    }

    /** Briefly marks a search hit (removed on the next navigation). */
    async showSearchHit(range: FlowRange) {
        await this.goTo({ s: range.s, o: range.start });
        const view = this.views.find((v) => v.s === range.s);
        if (!view) return;
        for (const seg of view.index.segments(range.start, range.end)) {
            let node = seg.node;
            if (seg.to < node.length) node.splitText(seg.to);
            if (seg.from > 0) node = node.splitText(seg.from);
            const mark = document.createElement("mark");
            mark.className = "ec-search";
            node.replaceWith(mark);
            mark.appendChild(node);
        }
        view.index.rebuild();
        window.setTimeout(() => {
            if (this.destroyed) return;
            const marks = view.root.querySelectorAll("mark.ec-search");
            if (!marks.length) return;
            marks.forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
            view.root.normalize();
            view.index.rebuild();
            this.applyHighlights();
        }, 2600);
    }

    rectOfHighlight(id: string): DOMRect | null {
        const mark = this.shadow.querySelector(`mark.ec-hl[data-hl="${CSS.escape(id)}"]`);
        return mark ? mark.getBoundingClientRect() : null;
    }

    // ───────────────────────────── selection ─────────────────────────────

    private onAnyInput = () => {
        this.lastInput = performance.now();
    };

    private onSelectionChange = () => {
        this.lastInput = performance.now();
        clearTimeout(this.selectionTimer);
        this.selectionTimer = window.setTimeout(() => this.readSelection(), 280);
    };

    private readSelection() {
        if (this.destroyed || this.drag || this.turning) return;
        const range = selectionRange(this.shadow);
        if (!range) { this.cb.onSelection(null); return; }
        const view = this.views.find((v) => v.root.contains(range.startContainer));
        if (!view) { this.cb.onSelection(null); return; }
        const a = view.index.offsetOf(range.startContainer, range.startOffset);
        const b = view.root.contains(range.endContainer) ? view.index.offsetOf(range.endContainer, range.endOffset) : view.index.total;
        if (a === null || b === null || b <= a) { this.cb.onSelection(null); return; }
        const start = a, end = Math.min(b, a + 4000);
        const text = view.index.text(start, end).replace(/\s+/g, " ").trim();
        if (!text) { this.cb.onSelection(null); return; }
        const rects = range.getClientRects();
        const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
        const { sentence, context } = this.contextOf(range.startContainer, text);
        this.cb.onSelection({ text, range: { s: view.s, start, end }, rect, sentence, context, anchor: range.cloneRange() });
    }

    clearSelection() {
        const sel = document.getSelection();
        try { sel?.removeAllRanges(); } catch { /* ignore */ }
        (this.shadow as unknown as { getSelection?: () => Selection | null }).getSelection?.()?.removeAllRanges();
    }

    private contextOf(node: Node, selected: string): { sentence: string; context: string } {
        let el: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
        while (el && !el.classList.contains("ec-body") && !BLOCK.has(el.localName)) el = el.parentElement;
        const block = el && !el.classList.contains("ec-body") ? el : null;
        const text = (block?.textContent ?? selected).replace(/\s+/g, " ").trim();
        const at = Math.max(0, text.indexOf(selected.slice(0, 60)));
        const before = text.slice(0, at);
        const startMatch = /[\s\S]*[.!?…][”"'’)\]]*\s+/.exec(before);
        const sStart = startMatch ? startMatch[0].length : 0;
        const after = text.slice(at + selected.length);
        const endMatch = /[.!?…][”"'’)\]]*(\s|$)/.exec(after);
        const sEnd = at + selected.length + (endMatch ? endMatch.index + endMatch[0].trimEnd().length : after.length);
        let sentence = text.slice(sStart, sEnd).trim();
        if (sentence.length > 700) sentence = text.slice(Math.max(0, at - 300), Math.min(text.length, at + selected.length + 300)).trim();
        const prev = block?.previousElementSibling?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const next = block?.nextElementSibling?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const context = [prev.slice(-350), text.length > 900 ? sentence : text, next.slice(0, 350)].filter(Boolean).join("\n").slice(0, 1600);
        return { sentence: sentence || selected, context };
    }

    // ───────────────────────────── turning ─────────────────────────────

    private useCurl(): boolean {
        return this.prefs.turn === "curl" && this.layout.mode !== "scroll" && !reducedMotion();
    }

    private neighbor(dir: 1 | -1): { s: number; page: number | "last" } | null {
        const L = this.layout;
        const step = L.spread ? 2 : 1;
        if (L.mode === "fixed") {
            const last = this.views[this.views.length - 1]?.s ?? this.s;
            const s = dir > 0 ? last + 1 : this.s - step;
            if (s < 0 && dir < 0) return this.s > 0 ? { s: 0, page: 0 } : null;
            return s >= 0 && s < this.source.spine.length ? { s, page: 0 } : null;
        }
        if (dir > 0) {
            if (this.page + step < this.pages) return { s: this.s, page: this.page + step };
            return this.s + 1 < this.source.spine.length ? { s: this.s + 1, page: 0 } : null;
        }
        if (this.page > 0) return { s: this.s, page: this.page - step };
        return this.s > 0 ? { s: this.s - 1, page: "last" } : null;
    }

    private async navigate(target: { s: number; page: number | "last" }): Promise<boolean> {
        this.keep = null;
        if (this.layout.mode === "fixed") {
            if (!(await this.renderChapter(target.s))) return false;
            this.show(0);
            return true;
        }
        if (target.s !== this.s) {
            if (!(await this.renderChapter(target.s))) return false;
        }
        this.show(target.page === "last" ? this.pages - 1 : target.page);
        return true;
    }

    next() { this.enqueue(1); }
    prev() { this.enqueue(-1); }

    private enqueue(dir: 1 | -1) {
        this.lastInput = performance.now();
        if (this.drag) return;
        if (this.layout.mode === "scroll") { this.scrollBy(dir); return; }
        this.queue.push(dir);
        if (this.queue.length > 3) this.queue.splice(0, this.queue.length - 3);
        this.flip?.rush();
        if (!this.turning) void this.runQueue();
    }

    private async runQueue() {
        this.turning = true;
        try {
            while (this.queue.length && !this.destroyed) {
                const dir = this.queue.shift()!;
                const target = this.neighbor(dir);
                if (!target) { this.cb.onEdge(dir > 0 ? "end" : "start"); continue; }
                if (this.useCurl() && this.queue.length === 0) await this.curl(dir, target);
                else await this.navigate(target);
            }
        } catch (error) {
            this.cb.onError(error);
        } finally {
            this.turning = false;
            this.overlay?.replaceChildren();
            this.flip = null;
            this.flushRelocate();
        }
    }

    private cancelTurns() {
        this.queue = [];
        this.flip?.destroy();
        this.flip = null;
        this.overlay?.replaceChildren();
        // a drag ended this way never reaches its pointer-up: the reader must not stay "turning"
        if (this.drag) { this.drag.flip?.destroy(); this.drag = null; this.turning = false; }
    }

    private scrollBy(dir: 1 | -1) {
        const vp = this.viewport;
        const atBottom = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 4;
        if (dir > 0 && atBottom) {
            if (this.s + 1 < this.source.spine.length) void this.goTo({ s: this.s + 1, o: 0 }, false);
            else this.cb.onEdge("end");
            return;
        }
        if (dir < 0 && vp.scrollTop <= 2) {
            if (this.s > 0) void this.renderChapter(this.s - 1).then((ok) => { if (ok) { vp.scrollTop = vp.scrollHeight; this.emitRelocate(); } });
            else this.cb.onEdge("start");
            return;
        }
        vp.scrollBy({ top: dir * (vp.clientHeight - 48), behavior: reducedMotion() ? "auto" : "smooth" });
    }

    private onScroll = () => {
        clearTimeout(this.scrollTimer);
        this.scrollTimer = window.setTimeout(() => { this.updateRunning(); this.emitRelocate(); }, 180);
    };

    /** A page-sized leaf for page `p` — its sheet, running heads and an exact copy of that page — placed at `left`. */
    private sheetClone(p: number | null, side: "solo" | "left" | "right", left: number): HTMLElement {
        const L = this.layout;
        const leaf = document.createElement("div");
        leaf.className = "ec-leaf";
        leaf.style.width = `${L.Sw}px`;
        leaf.style.left = `${left}px`;
        if (L.mode === "fixed") {
            const view = side === "right" ? this.views[1] : this.views[0];
            if (view?.page) {
                const copy = view.page.cloneNode(true) as HTMLElement;
                copy.style.left = `${parseFloat(view.page.style.left) - (side === "right" ? L.Sw : 0)}px`;
                leaf.appendChild(copy);
            }
            leaf.style.background = "transparent";
            this.overlay.appendChild(leaf);
            return leaf;
        }
        // the leaf looks like its sheet: same corners, and its half of the gutter shading (which turns with it)
        if (!L.mobile) leaf.style.borderRadius = side === "left" ? "5px 1px 1px 5px" : side === "right" ? "1px 5px 5px 1px" : "3px 6px 6px 3px";
        if (L.spread && side !== "solo") {
            const gutter = document.createElement("div");
            gutter.className = "ec-leaf-spine";
            gutter.style.cssText = side === "left" ? `left:${L.Sw - 32}px;background-position:0 0` : "left:0;background-position:-32px 0";
            leaf.appendChild(gutter);
        }
        const runningIndex = side === "right" ? 2 : 0;
        for (const i of [runningIndex, runningIndex + 1]) {
            const src = this.running[i];
            if (src) {
                const copy = src.cloneNode(true) as HTMLElement;
                if (p === null) copy.textContent = "";
                leaf.appendChild(copy);
            }
        }
        this.overlay.appendChild(leaf);
        if (p === null || p >= this.pages || !this.view) return leaf;
        const copy = this.pageCopy(p);
        if (!copy) { this.inexact = true; return leaf; }
        const content = document.createElement("div");
        content.className = "ec-leaf-content";
        content.style.cssText = `left:${L.mx}px;top:${L.my}px;width:${L.Pw}px;height:${L.H}px`;
        // clipped like the real viewport: at the page's top and bottom, and sideways only where the viewport ends
        // (text that overflows a left-hand column into the gutter stays visible, as it does on the real page)
        content.style.clipPath = side === "solo" ? "inset(0)" : side === "left" ? `inset(0 ${-(L.gap + L.Pw)}px 0 0)` : `inset(0 0 0 ${-L.gap}px)`;
        const flow = document.createElement("div");
        flow.className = "ec-flow ec-clone";
        flow.style.width = `${L.Pw}px`;
        if (this.flow.lang) flow.lang = this.flow.lang;
        flow.appendChild(copy.node);
        content.appendChild(flow);
        leaf.appendChild(content);
        if (!this.fitCopy(copy, p, content, flow)) this.inexact = true;
        return leaf;
    }

    /** Innermost block-level element of the chapter holding `node` (a table for a table part); null at the root. */
    private blockOf(node: Node): Element | null {
        const root = this.view?.root;
        if (!root) return null;
        for (let el = (node.nodeType === 1 ? node : node.parentNode) as Element | null; el && el !== root && root.contains(el); el = el.parentElement) {
            const d = getComputedStyle(el).display;
            if (d === "none" || d === "contents" || d.startsWith("inline") || d.startsWith("ruby")) continue;
            if (d.startsWith("table-")) {
                const table = el.closest("table");
                return table && root.contains(table) ? table : el;
            }
            return el;
        }
        return null;
    }

    /** Index of the first text item or picture inside `el` (which starts at text offset `o`). */
    private firstItemOf(index: TextIndex, el: Element, o: number): number {
        const items = index.items;
        let i = Math.max(0, index.itemAt(o));
        while (i > 0 && items[i - 1].start >= o) i--;
        while (i < items.length && !el.contains(items[i].node)) i++;
        return i;
    }

    private offsetAfter(index: TextIndex, el: Element): number | null {
        const parent = el.parentNode;
        if (!parent) return null;
        return index.offsetOf(parent, Array.prototype.indexOf.call(parent.childNodes, el) + 1);
    }

    /**
     * Copy of page `p` that lays out exactly like the real page. In the real chapter a page is a CSS column: a block
     * cut by the column break loses its top margin there, and the publisher's CSS sees the whole chapter (first-line,
     * drop-cap, indent and sibling rules). So the copy takes the block the page starts in from its own start, keeps
     * every ancestor among empty, hidden placeholders of its siblings, runs on to the end of the block the page ends
     * in, and is then shifted and clipped (fitCopy) so that only the page's own lines show, where they are on the page.
     */
    private pageCopy(p: number): PageCopy | null {
        const view = this.view;
        if (!view) return null;
        const index = view.index;
        const ps = this.pageStart(p);
        const pe = p + 1 < this.pages ? this.pageStart(p + 1) : null;
        if (ps.item >= index.items.length) return null;
        const startItem = index.items[ps.item];
        const range = document.createRange();
        const block = this.blockOf(startItem.node);
        const blockO = block ? index.offsetOf(block, 0) : null;
        let i0 = ps.item, shift = 0, whole = false;
        if (block && blockO !== null && ps.o - blockO <= COPY_SLACK) {
            range.setStartBefore(block);
            i0 = Math.min(ps.item, this.firstItemOf(index, block, blockO));
            whole = true;
        } else if (startItem.atom) range.setStartBefore(startItem.node);
        else { shift = ps.o - startItem.start; range.setStart(startItem.node, shift); }
        let clip = false;
        let endBlock: Element | null = null;
        if (!pe) range.setEnd(view.root, view.root.childNodes.length);
        else {
            const endItem = index.items[pe.item];
            endBlock = endItem ? this.blockOf(endItem.node) : null;
            const ebStart = endBlock ? index.offsetOf(endBlock, 0) : null;
            const ebEnd = endBlock ? this.offsetAfter(index, endBlock) : null;
            // by item order, not offset: a picture has no length and shares its offset with the text after it
            const ebFirst = endBlock && ebStart !== null ? this.firstItemOf(index, endBlock, ebStart) : null;
            const begunHere = ebFirst !== null && (ebFirst < pe.item || (ebFirst === pe.item && pe.o > index.items[pe.item].start));
            const holdsStart = Boolean(endBlock && (endBlock.contains(startItem.node) || (block && endBlock.contains(block))));
            if (endBlock && begunHere && ebEnd !== null && ebEnd - pe.o <= COPY_SLACK) {
                range.setEndAfter(endBlock);
                clip = true;
            } else if (endBlock && ebFirst !== null && !begunHere && !holdsStart) range.setEndBefore(endBlock);
            else if (endItem && endItem.atom && endItem.start === pe.o) range.setEndBefore(endItem.node);
            else {
                const point = index.point(pe.o);
                if (!point) return null;
                range.setEnd(point.node, point.offset);
            }
            if (!clip) endBlock = null;
        }
        if (range.collapsed) return null;
        const fragment = range.cloneContents();
        // ancestor shells from the range's common ancestor up to (and including) .ec-body
        let node: Node = fragment;
        for (let el: Node | null = range.commonAncestorContainer; el; el = el.parentNode) {
            if (el.nodeType !== 1) continue;
            const shell = (el as Element).cloneNode(false) as Element;
            shell.appendChild(node);
            node = shell;
            if ((el as Element).classList.contains("ec-body")) break;
        }
        const top = node as Element;
        this.placehold(top, whole ? block! : startItem.node, view.root, true);
        if (endBlock) this.placehold(top, endBlock, view.root, false);
        if (!whole) this.markContinued(top, startItem.node, ps.o);
        return { node: top, i0, shift, clip, ps, pe };
    }

    /**
     * Gives every ancestor of `real` in the copy its siblings back as empty, hidden placeholders (preceding ones for
     * the first copied node, a few following ones for the last), so `p + p`, `:first-child`, `:last-child`, `:nth-*`
     * rules of the book match as in the chapter. A list keeps its numbering.
     */
    private placehold(top: Element, real: Node, root: Element, before: boolean) {
        const chain: Element[] = [];
        for (let el = (real.nodeType === 1 ? real : real.parentElement) as Element | null; el && el !== root; el = el.parentElement) chain.unshift(el);
        const ph = (s: Element) => {
            const copy = s.cloneNode(false) as Element;
            copy.setAttribute("data-ec-ph", "");
            copy.removeAttribute("src");
            copy.removeAttribute("srcset");
            (copy as HTMLElement).style?.setProperty("display", "none", "important");
            return copy;
        };
        let parent = top;
        for (const el of chain) {
            const copy = before ? parent.firstElementChild : parent.lastElementChild;
            if (!copy || copy.localName !== el.localName) return;
            if (before) {
                const list: Element[] = [];
                for (let s = el.previousElementSibling; s && list.length < MAX_PLACEHOLDERS; s = s.previousElementSibling) list.push(ph(s));
                for (const item of list) parent.insertBefore(item, parent.firstChild);
                const ol = el.parentElement;
                if (el.localName === "li" && ol?.localName === "ol" && !ol.hasAttribute("reversed")) {
                    let n = 0;
                    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === "li") n++;
                    if (n > 0) parent.setAttribute("start", String(Number(ol.getAttribute("start") || 1) + n));
                }
            } else {
                for (let s = el.nextElementSibling, n = 0; s && n < 3; s = s.nextElementSibling, n++) parent.appendChild(ph(s));
            }
            parent = copy;
        }
    }

    /** Fallback copy that starts mid-block (very long block): its continued blocks lose top spacing and indent. */
    private markContinued(top: Element, startNode: Node, startO: number) {
        const view = this.view!;
        const originals: Element[] = [];
        for (let el = (startNode.nodeType === 1 ? startNode : startNode.parentNode) as Element | null; el && !el.classList.contains("ec-body"); el = el.parentElement) originals.unshift(el);
        let clone: Element | null = top;
        for (const original of originals) {
            clone = clone?.firstElementChild ?? null;
            while (clone && clone.hasAttribute("data-ec-ph")) clone = clone.nextElementSibling;
            if (!clone) break;
            if ((view.index.offsetOf(original, 0) ?? 0) < startO) {
                const style = (clone as HTMLElement).style;
                style?.setProperty("margin-top", "0", "important");
                style?.setProperty("padding-top", "0", "important");
                style?.setProperty("border-top-width", "0", "important");
                style?.setProperty("text-indent", "0", "important");
                if (original.localName === "li") style?.setProperty("list-style-type", "none", "important");
            }
        }
    }

    /**
     * Places the copy so the page's first character (or picture) is exactly where it is on the real page, clips it to
     * the page's own lines, and proves the copy identical by comparing the first, a middle and the last character of
     * the page with the real page. False = not identical (the caller turns the page without the fold).
     */
    private fitCopy(copy: PageCopy, p: number, content: HTMLElement, flow: HTMLElement): boolean {
        const view = this.view, cols = this.cols();
        if (!view || !cols) return false;
        const index = view.index, L = this.layout, items = index.items;
        const colLeft = cols.columnLeft(p);
        const vpTop = this.viewport.getBoundingClientRect().top;
        const box = content.getBoundingClientRect();
        const copied = buildItems(copy.node).filter((it) => !(it.node as Element).hasAttribute?.("data-ec-ph"));
        const inColumn = (r: DOMRect) => r.left >= colLeft - 1 && r.left < colLeft + L.Pw + 1;
        const rectOf = (item: TextItem, c: number): DOMRect | null => {
            if (item.atom) {
                const r = (item.node as Element).getBoundingClientRect();
                return r.width || r.height ? r : null;
            }
            return c >= 0 && c < item.len ? cols.charRect(item.node as Text, c) : null;
        };
        // a laid-out character or picture of the real page, from item i / character c, walking in `dir`
        const anchor = (i: number, c: number, dir: 1 | -1): { i: number; c: number; r: DOMRect } | null => {
            for (let n = 0; i >= 0 && i < items.length && n < 300; n++, i += dir, c = dir > 0 ? 0 : Number.MAX_SAFE_INTEGER) {
                const item = items[i];
                if (item.atom) {
                    const r = rectOf(item, 0);
                    if (r && inColumn(r)) return { i, c: 0, r };
                    continue;
                }
                const data = (item.node as Text).data;
                for (let j = Math.max(0, Math.min(item.len - 1, c)), m = 0; j >= 0 && j < item.len && m < 80; j += dir, m++) {
                    if (/\s/.test(data[j])) continue;
                    const r = rectOf(item, j);
                    if (r && inColumn(r)) return { i, c: j, r };
                }
            }
            return null;
        };
        const inCopy = (a: { i: number; c: number }): DOMRect | null => {
            const j = a.i - copy.i0;
            const item = copied[j];
            if (!item || item.atom !== items[a.i].atom) return null;
            return rectOf(item, j === 0 ? a.c - copy.shift : a.c);
        };
        const endItem = copy.pe ? copy.pe.item : items.length - 1;
        // The page must hold exactly its own items: a float pushed into another column (a drop cap at a page foot)
        // puts text of one page on another, and no copy of a text range can show that.
        const range = document.createRange();
        const columnsOf = (i: number): number[] => {
            const item = items[i];
            let rects: DOMRectList | DOMRect[];
            if (item.atom) rects = [(item.node as Element).getBoundingClientRect()];
            else { if (WS.test((item.node as Text).data)) return []; range.selectNodeContents(item.node); rects = range.getClientRects(); }
            const out: number[] = [];
            for (const rect of Array.from(rects)) { const c = cols.colOf(rect); if (c !== null) out.push(c); }
            return out;
        };
        for (let i = copy.ps.item + 1; i < endItem; i++) if (columnsOf(i).some((c) => c !== p)) return false;
        for (let i = endItem + 1, n = 0; i < items.length && n < 60; i++, n++) if (columnsOf(i).includes(p)) return false;
        for (let i = copy.ps.item - 1, n = 0; i >= 0 && n < 60; i--, n++) if (columnsOf(i).includes(p)) return false;
        const first = anchor(copy.ps.item, copy.ps.o - (items[copy.ps.item]?.start ?? 0), 1);
        if (!first) return true; // nothing laid out on this page
        const endChar = copy.pe ? copy.pe.o - (items[endItem]?.start ?? 0) - 1 : Number.MAX_SAFE_INTEGER;
        const last = endChar < 0 ? anchor(endItem - 1, Number.MAX_SAFE_INTEGER, -1) : anchor(endItem, endChar, -1);
        const fc = inCopy(first);
        if (!fc) return false;
        const dy = (first.r.top - vpTop) - (fc.top - box.top);
        if (Math.abs((first.r.left - colLeft) - (fc.left - box.left)) > 0.6) return false;
        const middle = last && last.i > first.i + 1 ? anchor((first.i + last.i) >> 1, 0, 1) : null;
        // all copy positions are read before the shift is applied
        for (const a of [last, middle]) {
            if (!a) continue;
            const got = inCopy(a);
            if (!got) return false;
            if (Math.abs((a.r.left - colLeft) - (got.left - box.left)) > 0.6 || Math.abs((a.r.top - vpTop) - (got.top - box.top + dy)) > 0.6) return false;
        }
        flow.style.top = `${dy}px`;
        if (copy.clip) {
            // the copy runs on into the next page: show only down to the lowest text or picture of this page
            let bottom = 0;
            for (let i = copy.ps.item; i <= Math.min(endItem, items.length - 1); i++) {
                const item = items[i];
                let rects: DOMRectList | DOMRect[];
                if (item.atom) rects = [(item.node as Element).getBoundingClientRect()];
                else { range.selectNodeContents(item.node); rects = range.getClientRects(); }
                for (const rect of Array.from(rects)) if ((rect.width || rect.height) && inColumn(rect)) bottom = Math.max(bottom, rect.bottom - vpTop);
            }
            if (bottom > 0) content.style.height = `${Math.min(L.H, Math.ceil(bottom) + 1)}px`;
        }
        return true;
    }

    private placeLeaf(leaf: HTMLElement, left: number) {
        leaf.style.left = `${left}px`;
        this.overlay.appendChild(leaf);
        return leaf;
    }

    private blankLeaf(): HTMLElement {
        const leaf = document.createElement("div");
        leaf.className = "ec-leaf";
        leaf.style.width = `${this.layout.Sw}px`;
        return leaf;
    }

    /**
     * Freezes the visible page(s) and moves the real view to the target; returns the scene parts. Null when the turn
     * is done without the fold: the view did not move, or a page copy was not identical to its page (the view has
     * moved — an instant turn, so no line ever jumps).
     */
    private async prepareTurn(dir: 1 | -1, target: { s: number; page: number | "last" }): Promise<TurnScene | null> {
        const L = this.layout;
        const spread = L.spread;
        const fixed = L.mode === "fixed";
        this.inexact = false;
        const oldA = this.sheetClone(fixed ? 0 : this.page, spread ? "left" : "solo", 0);
        const oldB = spread ? this.sheetClone(fixed ? 1 : this.page + 1 < this.pages ? this.page + 1 : null, "right", L.Sw) : null;
        if (this.inexact) {
            this.overlay.replaceChildren();
            await this.navigate(target);
            return null;
        }
        const ok = await this.navigate(target);
        if (!ok) { this.overlay.replaceChildren(); return null; }
        const dark = this.prefs.theme === "dark" || this.prefs.theme === "oled";
        let scene: TurnScene;
        if (!spread) {
            if (dir > 0) scene = { hingeX: 0, mirror: false, front: oldA, back: this.placeLeaf(this.blankLeaf(), -L.Sw), reverse: false, dark };
            else {
                const front = this.sheetClone(fixed ? 0 : this.page, "solo", 0);
                scene = { hingeX: 0, mirror: false, front, back: this.placeLeaf(this.blankLeaf(), -L.Sw), reverse: true, dark };
            }
        } else if (dir > 0) {
            scene = { hingeX: L.Sw, mirror: false, front: oldB!, back: this.sheetClone(fixed ? 0 : this.page, "left", 0), reverse: false, dark };
        } else {
            const back = this.sheetClone(fixed ? 1 : this.page + 1 < this.pages ? this.page + 1 : null, "right", L.Sw);
            scene = { hingeX: L.Sw, mirror: true, front: oldA, back, reverse: false, dark };
        }
        if (this.inexact) { this.overlay.replaceChildren(); return null; }
        return scene;
    }

    private makeFlip(scene: TurnScene, corner: "top" | "bottom"): PageFlip {
        // z-order inside the overlay: statics first, then the leaf front, then its back
        this.overlay.appendChild(scene.front);
        this.overlay.appendChild(scene.back);
        return new PageFlip({ overlay: this.overlay, hingeX: scene.hingeX, mirror: scene.mirror, leafW: this.layout.Sw,
            height: this.layout.bookH, front: scene.front, back: scene.back, reverse: scene.reverse, corner, dark: scene.dark });
    }

    private async curl(dir: 1 | -1, target: { s: number; page: number | "last" }) {
        const scene = await this.prepareTurn(dir, target);
        if (!scene) return;
        const flip = this.makeFlip(scene, "bottom");
        this.flip = flip;
        let frames = 0;
        const counter = () => { frames++; if (this.flip === flip) requestAnimationFrame(counter); };
        requestAnimationFrame(counter);
        const started = performance.now();
        await flip.play(this.layout.mobile ? 460 : 560);
        const elapsed = performance.now() - started;
        flip.destroy();
        this.flip = null;
        this.overlay.replaceChildren();
        if (elapsed > 300 && frames / (elapsed / 1000) < 24) {
            if (++this.slowTurns >= 2) this.cb.onTurnFallback();
        } else this.slowTurns = 0;
    }

    // ───────────────────────────── pointer ─────────────────────────────

    private bookPoint(e: PointerEvent | MouseEvent): Pt {
        const r = this.book.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    private zoneOf(pt: Pt, touch: boolean): "prev" | "next" | "center" {
        const L = this.layout;
        const w = L.bookW;
        const edge = touch ? 0.28 : L.spread ? 0.1 : 0.16;
        const marginEdge = L.mode === "fixed" ? 0 : L.mx * 0.9;
        if (pt.x < Math.max(w * edge, marginEdge)) return "prev";
        if (pt.x > w - Math.max(w * edge, marginEdge)) return "next";
        return "center";
    }

    private hasSelection(): boolean {
        return Boolean(selectionRange(this.shadow));
    }

    private onPointerDown = (e: PointerEvent) => {
        this.lastInput = performance.now();
        if (e.button !== 0 || this.layout.mode === "scroll") return;
        const pt = this.bookPoint(e);
        this.down = { x: pt.x, y: pt.y, t: performance.now(), zone: this.zoneOf(pt, e.pointerType !== "mouse"), id: e.pointerId, type: e.pointerType, moved: false };
    };

    private onPointerMove = (e: PointerEvent) => {
        const d = this.down;
        if (!d || e.pointerId !== d.id) return;
        const pt = this.bookPoint(e);
        const dx = pt.x - d.x, dy = pt.y - d.y;
        if (!d.moved && Math.hypot(dx, dy) > 8) d.moved = true;
        if (this.drag) {
            this.drag.last = pt;
            this.drag.flip?.drag(pt);
            e.preventDefault();
            return;
        }
        const canDrag = this.useCurl() && !this.turning && d.zone !== "center" && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2;
        const towards = d.zone === "next" ? dx < 0 : dx > 0;
        if (canDrag && towards && !this.hasSelection()) {
            const dir: 1 | -1 = d.zone === "next" ? 1 : -1;
            const target = this.neighbor(dir);
            if (!target) return;
            try { this.book.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            this.clearSelection();
            const corner: "top" | "bottom" = d.y < this.layout.bookH / 2 ? "top" : "bottom";
            const drag = { dir, ready: Promise.resolve(false), flip: null as PageFlip | null, last: pt, corner };
            this.drag = drag;
            this.turning = true;
            drag.ready = (async () => {
                const scene = await this.prepareTurn(dir, target);
                if (!scene || this.drag !== drag) return false;
                const flip = this.makeFlip(scene, corner);
                drag.flip = flip;
                flip.beginDrag({ x: d.x, y: d.y });
                flip.drag(drag.last);
                return true;
            })();
        }
    };

    private onPointerUp = async (e: PointerEvent) => {
        const d = this.down;
        this.down = null;
        if (!d || e.pointerId !== d.id) return;
        const drag = this.drag;
        if (drag) {
            const ready = await drag.ready;
            const flip = drag.flip;
            let completed = false;
            if (ready && flip) completed = await flip.release();
            flip?.destroy();
            if (!completed && ready) {
                const back = this.neighbor(drag.dir > 0 ? -1 : 1);
                if (back) await this.navigate(back);
            }
            this.overlay.replaceChildren();
            this.drag = null;
            this.turning = false;
            this.flushRelocate();
            return;
        }
        const pt = this.bookPoint(e);
        const dx = pt.x - d.x, dy = pt.y - d.y;
        const quick = performance.now() - d.t < 650;
        if (d.type !== "mouse" && d.moved && quick && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4 && !this.hasSelection()) {
            if (dx < 0) this.next(); else this.prev();
            return;
        }
        this.tap = !d.moved ? d.zone : null;
    };

    private tap: string | null = null;

    private onPointerCancel = () => {
        this.down = null;
        if (this.drag) {
            const drag = this.drag;
            void drag.ready.then(async (ready) => {
                drag.flip?.destroy();
                if (ready) {
                    const back = this.neighbor(drag.dir > 0 ? -1 : 1);
                    if (back) await this.navigate(back);
                }
                this.overlay.replaceChildren();
                this.drag = null;
                this.turning = false;
                this.flushRelocate();
            });
        }
    };

    private onClick = (e: MouseEvent) => {
        const zone = this.tap;
        this.tap = null;
        const path = e.composedPath();
        const link = path.find((n) => n instanceof Element && n.localName === "a" && (n.hasAttribute("data-ec-href") || n.hasAttribute("data-ec-ext"))) as Element | undefined;
        if (link) {
            e.preventDefault();
            const ext = link.getAttribute("data-ec-ext");
            if (ext) { this.cb.onExternalLink(ext); return; }
            const target = this.source.resolveInternal(link.getAttribute("data-ec-href") || "");
            if (!target) return;
            const isNote = /noteref/.test(link.getAttribute("data-epub-type") || "") || /^\s*[\[(]?\d{1,3}[\])]?\s*$/.test(link.textContent || "") || /^[*†‡§]+$/.test((link.textContent || "").trim());
            const view = this.views.find((v) => v.s === target.s);
            const el = target.frag && view ? this.findId(view.root, target.frag) : null;
            if (isNote && el) {
                let text = (el.textContent || "").replace(/\s+/g, " ").trim();
                if (text.length < 4 && el.parentElement) text = (el.parentElement.textContent || "").replace(/\s+/g, " ").trim();
                this.cb.onFootnote(text.slice(0, 2000), link.getBoundingClientRect(), () => void this.goToTarget(target));
                return;
            }
            void this.goToTarget(target);
            return;
        }
        const mark = path.find((n) => n instanceof Element && n.localName === "mark" && n.classList.contains("ec-hl")) as HTMLElement | undefined;
        if (mark && !this.hasSelection()) {
            this.cb.onHighlightClick(mark.dataset.hl || "", mark.getBoundingClientRect());
            return;
        }
        if (!zone || this.hasSelection()) return;
        if (zone === "next") this.next();
        else if (zone === "prev") this.prev();
        else this.cb.onTapCenter();
    };

    destroy() {
        this.destroyed = true;
        this.seq++;
        this.cancelTurns();
        this.counter.stop();
        clearTimeout(this.countTimer);
        clearTimeout(this.indexSaveTimer);
        clearTimeout(this.referenceTimer);
        if (this.index) this.saveIndex(this.index);
        clearTimeout(this.resizeTimer);
        clearTimeout(this.scrollTimer);
        clearTimeout(this.selectionTimer);
        this.resizeObserver.disconnect();
        document.removeEventListener("selectionchange", this.onSelectionChange);
        for (const type of INPUT_EVENTS) document.removeEventListener(type, this.onAnyInput, { capture: true });
        this.prefetched = null;
        this.views = [];
        this.shadow.replaceChildren();
    }
}
