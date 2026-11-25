/**
 * PDF renderer for My Books, on Mozilla PDF.js. Original page geometry, fonts and images are kept: each page is a
 * canvas at device resolution plus PDF.js's transparent text layer for selection and search (when the PDF has text).
 * The file is read by byte ranges straight from the local Blob, pages render lazily and a small LRU keeps memory
 * bounded. Scanned pages are shown as images; no OCR runs. Page turns reuse PageFlip with bitmap copies of the
 * rendered page(s).
 */
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { PageFlip, type Pt } from "./pageFlip";
import type { Annotation, PdfRect, ReaderPrefs, TocItem } from "./types";

type PdfJs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJs> | null = null;
let workerRef: Worker | null = null;

/**
 * Loads PDF.js on demand (never part of the initial bundle). Parsing runs in a module worker; the worker must answer
 * PDF.js's handshake within a few seconds, otherwise (old browser, a policy that refuses the worker) PDF.js runs its
 * worker code on the main thread instead of hanging.
 */
export function loadPdfJs(): Promise<PdfJs> {
    pdfjsPromise ??= import("pdfjs-dist").then(async (pdfjs) => {
        let ready = false;
        try {
            workerRef = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
            const handshake = new pdfjs.PDFWorker({ port: workerRef as never });
            ready = await Promise.race([handshake.promise.then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 6000))]);
            if (ready) pdfjs.GlobalWorkerOptions.workerPort = workerRef;
            else { handshake.destroy(); workerRef.terminate(); workerRef = null; }
        } catch {
            workerRef = null;
        }
        if (!ready) {
            const mainThread = await import("pdfjs-dist/build/pdf.worker.min.mjs");
            (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = mainThread;
        }
        return pdfjs;
    });
    return pdfjsPromise;
}

export async function openPdfDocument(blob: Blob): Promise<PDFDocumentProxy> {
    const pdfjs = await loadPdfJs();
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer());
    class BlobTransport extends pdfjs.PDFDataRangeTransport {
        requestDataRange(begin: number, end: number) {
            blob.slice(begin, end).arrayBuffer().then((buf) => this.onDataRange(begin, new Uint8Array(buf)), () => this.onDataRange(begin, null));
        }
    }
    const transport = new BlobTransport(blob.size, head);
    const task = pdfjs.getDocument({
        range: transport,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: 262144,
        enableXfa: false,
        useWasm: false,
        stopAtErrors: false,
        maxImageSize: 64 * 1024 * 1024,
    });
    return task.promise;
}

const PDF_CSS = String.raw`
:host { all: initial; display: block; position: absolute; inset: 0; contain: strict; }
.ec-stage { --ec-desk: #e7dcc6; --ec-sel: rgba(214,170,79,.36); --hl-yellow: rgba(255,210,70,.45); --hl-green: rgba(120,200,120,.4); --hl-blue: rgba(110,170,255,.38);
  --hl-pink: rgba(255,130,170,.38); --hl-orange: rgba(255,160,80,.42); --ec-filter: none;
  position: absolute; inset: 0; overflow: auto; background: var(--ec-desk); -webkit-tap-highlight-color: transparent; overscroll-behavior: contain; }
.ec-stage[data-theme="white"] { --ec-desk: #ebeae6; }
.ec-stage[data-theme="dark"] { --ec-desk: #131416; --ec-filter: brightness(.88); }
.ec-stage[data-theme="oled"] { --ec-desk: #000; --ec-filter: brightness(.8); }
.ec-center { position: relative; min-width: 100%; min-height: 100%; display: flex; align-items: center; justify-content: center; }
.ec-book { position: relative; flex: none; margin: auto; }
.ec-scrolllist { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 18px 0 40px; }
.ec-pdf-page { position: absolute; top: 0; overflow: hidden; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.18), 0 14px 32px -22px rgba(0,0,0,.45);
  --user-unit: 1; --total-scale-factor: calc(var(--scale-factor) * var(--user-unit)); --scale-round-x: 1px; --scale-round-y: 1px; }
.ec-scrolllist .ec-pdf-page { position: relative; top: auto; }
.ec-pdf-page canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; filter: var(--ec-filter); }
.ec-pdf-hl { position: absolute; inset: 0; pointer-events: none; z-index: 2; mix-blend-mode: multiply; }
.ec-stage[data-theme="dark"] .ec-pdf-hl, .ec-stage[data-theme="oled"] .ec-pdf-hl { mix-blend-mode: screen; }
.ec-pdf-hl div { position: absolute; border-radius: 2px; background: var(--hl-yellow); pointer-events: auto; cursor: pointer; }
.ec-pdf-hl div[data-c="green"] { background: var(--hl-green); } .ec-pdf-hl div[data-c="blue"] { background: var(--hl-blue); }
.ec-pdf-hl div[data-c="pink"] { background: var(--hl-pink); } .ec-pdf-hl div[data-c="orange"] { background: var(--hl-orange); }
.ec-pdf-hl div.ec-search { background: rgba(255,140,0,.55); pointer-events: none; }
.ec-pdf-msg { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); font: 600 11px/1.3 system-ui, sans-serif; color: #6b6b6b;
  background: rgba(255,255,255,.85); border-radius: 999px; padding: 4px 10px; z-index: 3; pointer-events: none; white-space: nowrap; }
.ec-overlay { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 5; }
.ec-overlay > .ec-leaf { position: absolute; top: 0; height: 100%; background: transparent; overflow: hidden; }
.textLayer { position: absolute; text-align: initial; inset: 0; overflow: clip; opacity: 1; line-height: 1; letter-spacing: normal; word-spacing: normal;
  text-size-adjust: none; -webkit-text-size-adjust: none; forced-color-adjust: none; transform-origin: 0 0; caret-color: CanvasText; z-index: 1;
  --min-font-size: 1; --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size)); --min-font-size-inv: calc(1 / var(--min-font-size)); }
.textLayer :is(span, br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; user-select: text; -webkit-user-select: text; }
.textLayer > :not(.markedContent), .textLayer .markedContent span:not(.markedContent) { z-index: 1; --font-height: 0; font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1; --rotate: 0deg; transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); }
.textLayer .markedContent { display: contents; }
.textLayer span[role="img"] { user-select: none; -webkit-user-select: none; cursor: default; }
.textLayer ::selection { background: var(--ec-sel); color: transparent; }
.textLayer br::selection { background: transparent; }
.textLayer .endOfContent { display: block; position: absolute; inset: 100% 0 0; z-index: 0; cursor: default; user-select: none; -webkit-user-select: none; }
.textLayer.selecting .endOfContent { top: 0; }
`;

export interface PdfRelocate { page: number; last: number; pages: number; progress: number; atStart: boolean; atEnd: boolean }
export interface PdfSelection { text: string; page: number; rects: PdfRect[]; rect: DOMRect; sentence: string; context: string; anchor: Range }

export interface PdfCallbacks {
    onRelocate(info: PdfRelocate): void;
    onSelection(sel: PdfSelection | null): void;
    onTapCenter(): void;
    onHighlightClick(id: string, rect: DOMRect): void;
    onError(error: unknown): void;
    onEdge(which: "start" | "end"): void;
    onTurnFallback(): void;
}

interface Rendered { key: string; box: HTMLElement; canvas: HTMLCanvasElement; task: RenderTask | null; done: Promise<void>; hasText: boolean }

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

export class PdfRenderer {
    private shadow: ShadowRoot;
    private stage!: HTMLElement;
    private center!: HTMLElement;
    private book!: HTMLElement;
    private overlay!: HTMLElement;
    private list: HTMLElement | null = null;
    private page = 0;
    private readonly count: number;
    private base = { w: 612, h: 792 };
    private scale = 1;
    private spread = false;
    private cache = new Map<string, Rendered>();
    private pageSizes = new Map<number, { w: number; h: number }>();
    private texts = new Map<number, string>();
    private highlights: Annotation[] = [];
    private destroyed = false;
    private turning = false;
    private queue: Array<1 | -1> = [];
    private flip: PageFlip | null = null;
    private seq = 0;
    private down: { x: number; y: number; t: number; id: number; type: string; moved: boolean; zone: string } | null = null;
    private drag: { dir: 1 | -1; ready: Promise<boolean>; flip: PageFlip | null; last: Pt } | null = null;
    private tap: string | null = null;
    private io: IntersectionObserver | null = null;
    private resizeObserver: ResizeObserver;
    private resizeTimer = 0;
    private selectionTimer = 0;
    private scrollTimer = 0;
    private slowTurns = 0;

    constructor(private readonly host: HTMLElement, private readonly doc: PDFDocumentProxy, private prefs: ReaderPrefs, private readonly cb: PdfCallbacks) {
        this.shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
        this.shadow.replaceChildren();
        const style = document.createElement("style");
        style.textContent = PDF_CSS;
        this.shadow.appendChild(style);
        this.count = doc.numPages;
        this.resizeObserver = new ResizeObserver(() => {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = window.setTimeout(() => void this.relayout(), 180);
        });
        this.resizeObserver.observe(host);
        document.addEventListener("selectionchange", this.onSelectionChange);
    }

    get pages() { return this.count; }

    async outline(): Promise<TocItem[]> {
        const raw = await this.doc.getOutline().catch(() => null);
        if (!raw) return [];
        const walk = async (items: NonNullable<typeof raw>, depth: number): Promise<TocItem[]> => {
            const out: TocItem[] = [];
            for (const item of items.slice(0, 500)) {
                let pageIndex = -1;
                try {
                    const dest = typeof item.dest === "string" ? await this.doc.getDestination(item.dest) : item.dest;
                    const ref = Array.isArray(dest) ? dest[0] : null;
                    if (typeof ref === "number") pageIndex = ref;
                    else if (ref && typeof ref === "object") pageIndex = await this.doc.getPageIndex(ref as never);
                } catch { /* unresolved destination */ }
                const children = depth < 6 && item.items?.length ? await walk(item.items as NonNullable<typeof raw>, depth + 1) : [];
                if (pageIndex >= 0 || children.length) out.push({ label: (item.title || "").trim().slice(0, 200) || "—", target: { s: Math.max(0, pageIndex >= 0 ? pageIndex : children[0].target.s) }, children });
            }
            return out;
        };
        return walk(raw, 0);
    }

    // ───────────────────────────── layout ─────────────────────────────

    private scrollMode() { return this.prefs.turn === "scroll"; }

    private computeScale() {
        const W = Math.max(280, this.host.clientWidth), H = Math.max(300, this.host.clientHeight);
        const mobile = W < 640;
        const pad = mobile ? 6 : 24;
        const availW = W - 2 * pad, availH = H - 2 * pad;
        const { w, h } = this.base;
        const fitPage = Math.min(availW / w, availH / h);
        const zoom = this.prefs.pdfZoom;
        this.spread = false;
        if (!mobile && !this.scrollMode() && zoom === "page" && this.prefs.layout !== "single" && this.count > 1) {
            const spreadScale = Math.min(availW / 2 / w, availH / h);
            this.spread = this.prefs.layout === "spread" ? spreadScale > 0.3 : spreadScale >= fitPage * 0.9;
            if (this.spread) { this.scale = spreadScale; return; }
        }
        if (this.scrollMode()) this.scale = zoom === "page" ? Math.min(availW / w, availH / h) : zoom === "width" ? Math.min(availW / w, 3) : fitPage * zoom;
        else this.scale = zoom === "page" ? fitPage : zoom === "width" ? Math.min(availW / w, 3) : fitPage * zoom;
    }

    private fits(): boolean {
        return this.prefs.pdfZoom === "page" && !this.scrollMode();
    }

    private buildChrome() {
        this.io?.disconnect();
        this.io = null;
        this.stage?.remove();
        this.stage = document.createElement("div");
        this.stage.className = "ec-stage";
        this.stage.dataset.theme = this.prefs.theme;
        this.center = document.createElement("div");
        this.center.className = "ec-center";
        this.stage.appendChild(this.center);
        this.shadow.appendChild(this.stage);
        this.list = null;
        if (this.scrollMode()) {
            this.list = document.createElement("div");
            this.list.className = "ec-scrolllist";
            this.center.style.display = "block";
            this.center.appendChild(this.list);
            this.stage.addEventListener("scroll", this.onScroll, { passive: true });
            this.io = new IntersectionObserver((entries) => {
                for (const entry of entries) if (entry.isIntersecting) void this.fillSlot(Number((entry.target as HTMLElement).dataset.page));
            }, { root: this.stage, rootMargin: "120% 0px" });
            const w = Math.floor(this.base.w * this.scale), h = Math.floor(this.base.h * this.scale);
            for (let i = 0; i < this.count; i++) {
                const slot = document.createElement("div");
                slot.className = "ec-pdf-page";
                slot.dataset.page = String(i);
                const size = this.pageSizes.get(i);
                slot.style.width = `${size ? Math.floor(size.w * this.scale) : w}px`;
                slot.style.height = `${size ? Math.floor(size.h * this.scale) : h}px`;
                this.list.appendChild(slot);
                this.io.observe(slot);
            }
        } else {
            this.book = document.createElement("div");
            this.book.className = "ec-book";
            this.overlay = document.createElement("div");
            this.overlay.className = "ec-overlay";
            this.center.appendChild(this.book);
            this.book.addEventListener("pointerdown", this.onPointerDown);
            this.book.addEventListener("pointermove", this.onPointerMove);
            this.book.addEventListener("pointerup", this.onPointerUp);
            this.book.addEventListener("pointercancel", this.onPointerCancel);
            this.book.addEventListener("click", this.onClick);
        }
    }

    async open(page = 0) {
        const first = await this.doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        this.base = { w: vp.width, h: vp.height };
        this.pageSizes.set(0, this.base);
        this.computeScale();
        this.buildChrome();
        await this.goToPage(page, false);
    }

    setPrefs(prefs: ReaderPrefs) {
        const before = this.prefs;
        this.prefs = prefs;
        if (!this.stage) return;
        this.stage.dataset.theme = prefs.theme;
        if (before.pdfZoom !== prefs.pdfZoom || before.layout !== prefs.layout || (before.turn === "scroll") !== (prefs.turn === "scroll")) void this.relayout(true);
    }

    private async relayout(force = false) {
        if (this.destroyed || !this.stage) return;
        const old = { scale: this.scale, spread: this.spread };
        this.computeScale();
        if (!force && Math.abs(old.scale - this.scale) < 0.004 && old.spread === this.spread) return;
        this.cancelTurns();
        this.buildChrome();
        await this.goToPage(this.page, false);
    }

    // ───────────────────────────── rendering ─────────────────────────────

    private async size(i: number): Promise<{ w: number; h: number; page: PDFPageProxy }> {
        const page = await this.doc.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        const size = { w: vp.width, h: vp.height };
        this.pageSizes.set(i, size);
        return { ...size, page };
    }

    private renderBox(i: number): Rendered {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const key = `${i}@${this.scale.toFixed(4)}@${dpr}`;
        const hit = this.cache.get(key);
        if (hit) {
            this.cache.delete(key);
            this.cache.set(key, hit);
            return hit;
        }
        const box = document.createElement("div");
        box.className = "ec-pdf-page";
        box.dataset.page = String(i);
        const canvas = document.createElement("canvas");
        box.appendChild(canvas);
        const entry: Rendered = { key, box, canvas, task: null, done: Promise.resolve(), hasText: true };
        entry.done = (async () => {
            const { w, h, page } = await this.size(i);
            const cssW = Math.floor(w * this.scale), cssH = Math.floor(h * this.scale);
            box.style.width = `${cssW}px`;
            box.style.height = `${cssH}px`;
            box.style.setProperty("--scale-factor", String(this.scale));
            let ratio = dpr;
            if (cssW * cssH * ratio * ratio > 14_000_000) ratio = Math.sqrt(14_000_000 / (cssW * cssH));
            canvas.width = Math.max(1, Math.floor(cssW * ratio));
            canvas.height = Math.max(1, Math.floor(cssH * ratio));
            const viewport = page.getViewport({ scale: this.scale * ratio });
            const task = page.render({ canvas, viewport } as Parameters<PDFPageProxy["render"]>[0]);
            entry.task = task;
            await task.promise.catch((e: unknown) => { if ((e as { name?: string })?.name !== "RenderingCancelledException") throw e; });
            entry.task = null;
            if (this.destroyed) return;
            const pdfjs = await loadPdfJs();
            const textDiv = document.createElement("div");
            textDiv.className = "textLayer";
            box.appendChild(textDiv);
            try {
                const content = await page.getTextContent();
                if (!this.texts.has(i)) this.texts.set(i, content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join(""));
                entry.hasText = content.items.some((it) => "str" in it && it.str.trim());
                const layer = new pdfjs.TextLayer({ textContentSource: content, container: textDiv, viewport: page.getViewport({ scale: this.scale }) });
                await layer.render();
            } catch { entry.hasText = false; }
            if (!entry.hasText) {
                const msg = document.createElement("div");
                msg.className = "ec-pdf-msg";
                msg.textContent = "Trang ảnh quét — không có lớp chữ để chọn";
                box.appendChild(msg);
            }
            const hl = document.createElement("div");
            hl.className = "ec-pdf-hl";
            box.appendChild(hl);
            this.paintHighlights(box, i);
            page.cleanup();
        })();
        entry.done.catch((e) => this.cb.onError(e));
        this.cache.set(key, entry);
        this.evict();
        return entry;
    }

    private evict() {
        const keep = 8;
        while (this.cache.size > keep) {
            const [key, entry] = this.cache.entries().next().value as [string, Rendered];
            if (entry.box.isConnected) {
                this.cache.delete(key);
                this.cache.set(key, entry);
                if ([...this.cache.values()].every((e) => e.box.isConnected)) break;
                continue;
            }
            entry.task?.cancel();
            entry.canvas.width = 0;
            entry.canvas.height = 0;
            this.cache.delete(key);
        }
    }

    private async fillSlot(i: number) {
        if (!this.list || Number.isNaN(i)) return;
        const slot = this.list.children[i] as HTMLElement | undefined;
        if (!slot || slot.dataset.filled) return;
        slot.dataset.filled = "1";
        const entry = this.renderBox(i);
        await entry.done.catch(() => undefined);
        if (!slot.isConnected) return;
        entry.box.style.position = "relative";
        slot.replaceWith(entry.box);
        entry.box.dataset.filled = "1";
        this.io?.observe(entry.box);
        // release far pages
        const rendered = Array.from(this.list.children).filter((c) => (c as HTMLElement).querySelector("canvas")) as HTMLElement[];
        if (rendered.length > 10) {
            for (const el of rendered) {
                const p = Number(el.dataset.page);
                if (Math.abs(p - this.page) > 5) {
                    const placeholder = document.createElement("div");
                    placeholder.className = "ec-pdf-page";
                    placeholder.dataset.page = String(p);
                    placeholder.style.width = el.style.width;
                    placeholder.style.height = el.style.height;
                    this.io?.unobserve(el);
                    el.replaceWith(placeholder);
                    this.io?.observe(placeholder);
                }
            }
        }
    }

    private visible(): number[] {
        if (!this.spread) return [this.page];
        const first = this.page === 0 ? 0 : this.page - ((this.page - 1) % 2);
        return first === 0 ? [0] : [first, first + 1].filter((i) => i < this.count);
    }

    /** Spread layout: page 0 alone (a cover), then 1-2, 3-4 … like a printed book. */
    private normalize(page: number): number {
        const p = Math.max(0, Math.min(this.count - 1, page));
        if (!this.spread || p === 0) return p;
        return p - ((p - 1) % 2);
    }

    private async display(page: number): Promise<boolean> {
        const seq = ++this.seq;
        this.page = this.normalize(page);
        const pages = this.visible();
        const entries = pages.map((i) => this.renderBox(i));
        await Promise.all(entries.map((e) => e.done.catch(() => undefined)));
        if (seq !== this.seq || this.destroyed) return false;
        const sizes = entries.map((e) => ({ w: parseFloat(e.box.style.width) || 1, h: parseFloat(e.box.style.height) || 1 }));
        const leafW = Math.max(...sizes.map((s) => s.w));
        const H = Math.max(...sizes.map((s) => s.h));
        const single = entries.length === 1;
        const width = this.spread ? 2 * leafW : leafW;
        this.book.style.width = `${width}px`;
        this.book.style.height = `${H}px`;
        this.book.replaceChildren();
        entries.forEach((e, n) => {
            e.box.style.position = "absolute";
            const left = this.spread ? (single ? (this.page === 0 ? leafW : 0) : n * leafW) : 0;
            e.box.style.left = `${left + (this.spread ? (n === 0 && !single ? leafW - sizes[n].w : 0) : 0)}px`;
            e.box.style.top = `${Math.floor((H - sizes[n].h) / 2)}px`;
            this.book.appendChild(e.box);
        });
        this.overlay.replaceChildren();
        this.book.appendChild(this.overlay);
        if (!this.fits()) this.stage.scrollTop = 0;
        this.emitRelocate();
        this.prefetch();
        return true;
    }

    private prefetch() {
        const next = this.spread ? this.visible().map((i) => i + 2) : [this.page + 1];
        for (const i of next) if (i < this.count) this.renderBox(i);
    }

    private emitRelocate() {
        const vis = this.visible();
        const last = vis[vis.length - 1];
        this.cb.onRelocate({ page: this.page, last, pages: this.count, progress: (last + 1) / this.count, atStart: this.page === 0, atEnd: last >= this.count - 1 });
    }

    async goToPage(page: number, jump = true) {
        void jump;
        this.cancelTurns();
        if (this.scrollMode()) {
            this.page = Math.max(0, Math.min(this.count - 1, page));
            const slot = this.list?.children[this.page] as HTMLElement | undefined;
            if (slot) this.stage.scrollTop = slot.offsetTop - 12;
            this.emitRelocate();
            return;
        }
        await this.display(page).catch((e) => this.cb.onError(e));
    }

    // ───────────────────────────── highlights & search ─────────────────────────────

    setHighlights(list: Annotation[]) {
        this.highlights = list.filter((a) => a.kind === "highlight" && a.page !== undefined && a.rects?.length);
        for (const box of Array.from(this.shadow.querySelectorAll<HTMLElement>(".ec-pdf-page"))) this.paintHighlights(box, Number(box.dataset.page));
    }

    private paintHighlights(box: HTMLElement, page: number) {
        const layer = box.querySelector(".ec-pdf-hl");
        if (!layer) return;
        layer.querySelectorAll("div:not(.ec-search)").forEach((d) => d.remove());
        for (const h of this.highlights) {
            if (h.page !== page) continue;
            for (const r of h.rects!) {
                const d = document.createElement("div");
                d.dataset.hl = h.id;
                d.dataset.c = h.color ?? "yellow";
                d.style.cssText = `left:${(r.x * 100).toFixed(3)}%;top:${(r.y * 100).toFixed(3)}%;width:${(r.w * 100).toFixed(3)}%;height:${(r.h * 100).toFixed(3)}%`;
                if (h.note) d.style.boxShadow = "inset 0 -2px 0 rgba(120,80,0,.55)";
                layer.appendChild(d);
            }
        }
    }

    async pageText(i: number): Promise<string> {
        const cached = this.texts.get(i);
        if (cached !== undefined) return cached;
        const page = await this.doc.getPage(i + 1);
        const content = await page.getTextContent();
        const text = content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
        if (this.texts.size < 4000) this.texts.set(i, text);
        page.cleanup();
        return text;
    }

    async showSearchHit(page: number, query: string) {
        await this.goToPage(page);
        const q = query.trim().toLowerCase();
        if (!q) return;
        const boxes = Array.from(this.shadow.querySelectorAll<HTMLElement>(`.ec-pdf-page[data-page="${page}"]`));
        for (const box of boxes) {
            const layer = box.querySelector(".ec-pdf-hl");
            const boxRect = box.getBoundingClientRect();
            for (const span of Array.from(box.querySelectorAll<HTMLElement>(".textLayer span"))) {
                const t = (span.textContent || "").toLowerCase();
                const at = t.indexOf(q.slice(0, Math.min(q.length, 40)));
                if (at < 0 || !span.firstChild) continue;
                const r = document.createRange();
                r.setStart(span.firstChild, at);
                r.setEnd(span.firstChild, Math.min((span.firstChild as Text).length, at + q.length));
                for (const rect of Array.from(r.getClientRects())) {
                    const d = document.createElement("div");
                    d.className = "ec-search";
                    d.style.cssText = `left:${rect.left - boxRect.left}px;top:${rect.top - boxRect.top}px;width:${rect.width}px;height:${rect.height}px`;
                    layer?.appendChild(d);
                }
            }
            window.setTimeout(() => layer?.querySelectorAll(".ec-search").forEach((d) => d.remove()), 2600);
        }
    }

    // ───────────────────────────── selection ─────────────────────────────

    private onSelectionChange = () => {
        clearTimeout(this.selectionTimer);
        this.selectionTimer = window.setTimeout(() => void this.readSelection(), 280);
    };

    private async readSelection() {
        if (this.destroyed || this.drag || this.turning) return;
        const range = selectionRange(this.shadow);
        const startEl = range ? (range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement) : null;
        const box = startEl?.closest<HTMLElement>(".ec-pdf-page");
        if (!range || !box) { this.cb.onSelection(null); return; }
        const text = range.toString().replace(/\s+/g, " ").trim().slice(0, 4000);
        if (!text) { this.cb.onSelection(null); return; }
        const page = Number(box.dataset.page);
        const b = box.getBoundingClientRect();
        const rects: PdfRect[] = [];
        for (const r of Array.from(range.getClientRects())) {
            if (r.width < 1 || r.height < 1) continue;
            const x = Math.max(0, (r.left - b.left) / b.width), y = Math.max(0, (r.top - b.top) / b.height);
            const w = Math.min(1 - x, r.width / b.width), h = Math.min(1 - y, r.height / b.height);
            if (w > 0 && h > 0) rects.push({ x, y, w, h });
            if (rects.length > 400) break;
        }
        const all = range.getClientRects();
        const rect = all.length ? all[all.length - 1] : range.getBoundingClientRect();
        const pageText = (await this.pageText(page).catch(() => "")).replace(/\s+/g, " ");
        const at = pageText.indexOf(text.slice(0, 60));
        let sentence = text, context = text;
        if (at >= 0) {
            const before = pageText.slice(0, at);
            const m = /[\s\S]*[.!?…][”"'’)\]]*\s+/.exec(before);
            const s0 = m ? m[0].length : Math.max(0, at - 200);
            const after = pageText.slice(at + text.length);
            const e = /[.!?…][”"'’)\]]*(\s|$)/.exec(after);
            const s1 = at + text.length + (e ? e.index + e[0].trimEnd().length : Math.min(after.length, 200));
            sentence = pageText.slice(s0, s1).trim().slice(0, 700);
            context = pageText.slice(Math.max(0, at - 600), Math.min(pageText.length, at + text.length + 600)).trim();
        }
        this.cb.onSelection({ text, page, rects: rects.slice(0, 200), rect, sentence, context, anchor: range.cloneRange() });
    }

    clearSelection() {
        try { document.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
        (this.shadow as unknown as { getSelection?: () => Selection | null }).getSelection?.()?.removeAllRanges();
    }

    rectOfHighlight(id: string): DOMRect | null {
        const el = this.shadow.querySelector(`.ec-pdf-hl div[data-hl="${CSS.escape(id)}"]`);
        return el ? el.getBoundingClientRect() : null;
    }

    // ───────────────────────────── turning ─────────────────────────────

    private useCurl() {
        return this.prefs.turn === "curl" && this.fits() && !reducedMotion();
    }

    private target(dir: 1 | -1): number | null {
        if (this.spread) {
            const vis = this.visible();
            const t = dir > 0 ? vis[vis.length - 1] + 1 : vis[0] - 1;
            return t >= 0 && t < this.count ? this.normalize(t) : null;
        }
        const t = this.page + dir;
        return t >= 0 && t < this.count ? t : null;
    }

    next() { this.enqueue(1); }
    prev() { this.enqueue(-1); }

    private enqueue(dir: 1 | -1) {
        if (this.drag) return;
        if (this.scrollMode()) {
            this.stage.scrollBy({ top: dir * (this.stage.clientHeight - 60), behavior: reducedMotion() ? "auto" : "smooth" });
            return;
        }
        if (!this.fits()) {
            const st = this.stage;
            const canScroll = dir > 0 ? st.scrollTop + st.clientHeight < st.scrollHeight - 4 : st.scrollTop > 2;
            if (canScroll) { st.scrollBy({ top: dir * (st.clientHeight - 60), behavior: reducedMotion() ? "auto" : "smooth" }); return; }
        }
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
                const t = this.target(dir);
                if (t === null) { this.cb.onEdge(dir > 0 ? "end" : "start"); continue; }
                if (this.useCurl() && this.queue.length === 0) await this.curl(dir, t);
                else {
                    await this.display(t);
                    if (dir < 0 && !this.fits()) this.stage.scrollTop = this.stage.scrollHeight;
                }
            }
        } catch (e) {
            this.cb.onError(e);
        } finally {
            this.turning = false;
            this.overlay?.replaceChildren();
            this.flip = null;
        }
    }

    private cancelTurns() {
        this.queue = [];
        this.flip?.destroy();
        this.flip = null;
        this.overlay?.replaceChildren();
        if (this.drag) { this.drag.flip?.destroy(); this.drag = null; }
    }

    private leafOf(boxes: HTMLElement[], side: "solo" | "left" | "right", leafW: number, H: number): HTMLElement {
        const leaf = document.createElement("div");
        leaf.className = "ec-leaf";
        leaf.style.width = `${leafW}px`;
        const box = side === "right" ? boxes.find((b) => parseFloat(b.style.left) >= leafW - 1) : side === "left" ? boxes.find((b) => parseFloat(b.style.left) < leafW - 1) : boxes[0];
        if (!box) return leaf;
        const src = box.querySelector("canvas");
        const copy = document.createElement("div");
        copy.style.cssText = `position:absolute;left:${parseFloat(box.style.left) - (side === "right" ? leafW : 0)}px;top:${box.style.top};width:${box.style.width};height:${box.style.height};background:#fff;overflow:hidden`;
        if (src && src.width) {
            const c = document.createElement("canvas");
            c.width = src.width;
            c.height = src.height;
            c.style.cssText = "width:100%;height:100%;display:block;filter:var(--ec-filter)";
            c.getContext("2d")?.drawImage(src, 0, 0);
            copy.appendChild(c);
        }
        leaf.appendChild(copy);
        void H;
        return leaf;
    }

    private async prepareTurn(dir: 1 | -1, t: number) {
        const oldBoxes = Array.from(this.book.querySelectorAll<HTMLElement>(":scope > .ec-pdf-page"));
        const width = parseFloat(this.book.style.width), H = parseFloat(this.book.style.height);
        const spread = this.spread;
        const leafW = spread ? width / 2 : width;
        const oldA = this.leafOf(oldBoxes, spread ? "left" : "solo", leafW, H);
        const oldB = spread ? this.leafOf(oldBoxes, "right", leafW, H) : null;
        const ok = await this.display(t);
        if (!ok) return null;
        const newBoxes = Array.from(this.book.querySelectorAll<HTMLElement>(":scope > .ec-pdf-page"));
        const place = (leaf: HTMLElement, left: number) => { leaf.style.left = `${left}px`; this.overlay.appendChild(leaf); return leaf; };
        const blank = () => { const l = document.createElement("div"); l.className = "ec-leaf"; l.style.width = `${leafW}px`; return l; };
        place(oldA, 0);
        if (oldB) place(oldB, leafW);
        if (!spread) {
            if (dir > 0) return { hingeX: 0, mirror: false, front: oldA, back: place(blank(), -leafW), reverse: false, leafW, H };
            const front = place(this.leafOf(newBoxes, "solo", leafW, H), 0);
            return { hingeX: 0, mirror: false, front, back: place(blank(), -leafW), reverse: true, leafW, H };
        }
        if (dir > 0) return { hingeX: leafW, mirror: false, front: oldB!, back: place(this.leafOf(newBoxes, "left", leafW, H), 0), reverse: false, leafW, H };
        return { hingeX: leafW, mirror: true, front: oldA, back: place(this.leafOf(newBoxes, "right", leafW, H), leafW), reverse: false, leafW, H };
    }

    private makeFlip(scene: NonNullable<Awaited<ReturnType<PdfRenderer["prepareTurn"]>>>, corner: "top" | "bottom") {
        this.overlay.appendChild(scene.front);
        this.overlay.appendChild(scene.back);
        return new PageFlip({ overlay: this.overlay, hingeX: scene.hingeX, mirror: scene.mirror, leafW: scene.leafW, height: scene.H,
            front: scene.front, back: scene.back, reverse: scene.reverse, corner, dark: this.prefs.theme === "dark" || this.prefs.theme === "oled" });
    }

    private async curl(dir: 1 | -1, t: number) {
        const scene = await this.prepareTurn(dir, t);
        if (!scene) return;
        const flip = this.makeFlip(scene, "bottom");
        this.flip = flip;
        let frames = 0;
        const counter = () => { frames++; if (this.flip === flip) requestAnimationFrame(counter); };
        requestAnimationFrame(counter);
        const started = performance.now();
        await flip.play(520);
        const elapsed = performance.now() - started;
        flip.destroy();
        this.flip = null;
        this.overlay.replaceChildren();
        if (elapsed > 300 && frames / (elapsed / 1000) < 24) { if (++this.slowTurns >= 2) this.cb.onTurnFallback(); } else this.slowTurns = 0;
    }

    // ───────────────────────────── pointer ─────────────────────────────

    private point(e: PointerEvent | MouseEvent): Pt {
        const r = this.book.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    private zone(pt: Pt, touch: boolean): string {
        const w = parseFloat(this.book.style.width) || 1;
        const edge = touch ? 0.28 : 0.14;
        if (pt.x < w * edge) return "prev";
        if (pt.x > w * (1 - edge)) return "next";
        return "center";
    }

    private onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        const pt = this.point(e);
        this.down = { x: pt.x, y: pt.y, t: performance.now(), id: e.pointerId, type: e.pointerType, moved: false, zone: this.zone(pt, e.pointerType !== "mouse") };
    };

    private onPointerMove = (e: PointerEvent) => {
        const d = this.down;
        if (!d || d.id !== e.pointerId) return;
        const pt = this.point(e);
        const dx = pt.x - d.x, dy = pt.y - d.y;
        if (!d.moved && Math.hypot(dx, dy) > 8) d.moved = true;
        if (this.drag) { this.drag.last = pt; this.drag.flip?.drag(pt); e.preventDefault(); return; }
        if (!this.useCurl() || this.turning || d.zone === "center" || Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        if (!(d.zone === "next" ? dx < 0 : dx > 0) || selectionRange(this.shadow)) return;
        const dir: 1 | -1 = d.zone === "next" ? 1 : -1;
        const t = this.target(dir);
        if (t === null) return;
        try { this.book.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        const corner: "top" | "bottom" = d.y < (parseFloat(this.book.style.height) || 0) / 2 ? "top" : "bottom";
        const drag = { dir, ready: Promise.resolve(false), flip: null as PageFlip | null, last: pt };
        this.drag = drag;
        this.turning = true;
        drag.ready = (async () => {
            const scene = await this.prepareTurn(dir, t);
            if (!scene || this.drag !== drag) return false;
            const flip = this.makeFlip(scene, corner);
            drag.flip = flip;
            flip.beginDrag({ x: d.x, y: d.y });
            flip.drag(drag.last);
            return true;
        })();
    };

    private finishDrag = async () => {
        const drag = this.drag;
        if (!drag) return;
        const from = this.page;
        const ready = await drag.ready;
        let completed = false;
        if (ready && drag.flip) completed = await drag.flip.release();
        drag.flip?.destroy();
        if (!completed && ready) {
            const back = this.spread ? this.normalize(drag.dir > 0 ? this.visible()[0] - 1 : this.visible()[this.visible().length - 1] + 1) : from - drag.dir;
            await this.display(Math.max(0, Math.min(this.count - 1, back)));
        }
        this.overlay.replaceChildren();
        this.drag = null;
        this.turning = false;
    };

    private onPointerUp = (e: PointerEvent) => {
        const d = this.down;
        this.down = null;
        if (!d || d.id !== e.pointerId) return;
        if (this.drag) { void this.finishDrag(); return; }
        const pt = this.point(e);
        const dx = pt.x - d.x, dy = pt.y - d.y;
        if (d.type !== "mouse" && d.moved && performance.now() - d.t < 650 && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4 && !selectionRange(this.shadow)) {
            if (dx < 0) this.next(); else this.prev();
            return;
        }
        this.tap = d.moved ? null : d.zone;
    };

    private onPointerCancel = () => {
        this.down = null;
        if (this.drag) void this.finishDrag();
    };

    private onClick = (e: MouseEvent) => {
        const zone = this.tap;
        this.tap = null;
        const hl = e.composedPath().find((n) => n instanceof HTMLElement && n.dataset.hl) as HTMLElement | undefined;
        if (hl && !selectionRange(this.shadow)) { this.cb.onHighlightClick(hl.dataset.hl!, hl.getBoundingClientRect()); return; }
        if (!zone || selectionRange(this.shadow)) return;
        if (zone === "next") this.next();
        else if (zone === "prev") this.prev();
        else this.cb.onTapCenter();
    };

    private onScroll = () => {
        clearTimeout(this.scrollTimer);
        this.scrollTimer = window.setTimeout(() => {
            if (!this.list) return;
            const top = this.stage.getBoundingClientRect().top;
            const children = Array.from(this.list.children) as HTMLElement[];
            let current = 0;
            for (const child of children) {
                const r = child.getBoundingClientRect();
                if (r.bottom > top + 40) { current = Number(child.dataset.page); break; }
            }
            this.page = current;
            this.emitRelocate();
        }, 160);
    };

    destroy() {
        this.destroyed = true;
        this.seq++;
        this.cancelTurns();
        clearTimeout(this.resizeTimer);
        clearTimeout(this.selectionTimer);
        clearTimeout(this.scrollTimer);
        this.resizeObserver.disconnect();
        this.io?.disconnect();
        document.removeEventListener("selectionchange", this.onSelectionChange);
        for (const entry of this.cache.values()) {
            entry.task?.cancel();
            entry.canvas.width = 0;
            entry.canvas.height = 0;
        }
        this.cache.clear();
        this.shadow.replaceChildren();
        void this.doc.loadingTask.destroy();
    }
}

/** First-page thumbnail (JPEG) and metadata for the bookshelf. */
export async function pdfImportInfo(blob: Blob): Promise<{ title: string; author: string; pages: number; cover: Blob | null }> {
    const doc = await openPdfDocument(blob);
    try {
        const meta = await doc.getMetadata().catch(() => null);
        const info = (meta?.info ?? {}) as Record<string, unknown>;
        let cover: Blob | null = null;
        try {
            const page = await doc.getPage(1);
            const vp1 = page.getViewport({ scale: 1 });
            const scale = 320 / vp1.width;
            const vp = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.floor(vp.width);
            canvas.height = Math.floor(vp.height);
            const ctx = canvas.getContext("2d");
            if (ctx) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
            await page.render({ canvas, viewport: vp } as Parameters<PDFPageProxy["render"]>[0]).promise;
            cover = await new Promise<Blob | null>((r) => canvas.toBlob((b) => r(b), "image/jpeg", 0.82));
            canvas.width = 0;
            page.cleanup();
        } catch { cover = null; }
        return {
            title: typeof info.Title === "string" ? info.Title.trim() : "",
            author: typeof info.Author === "string" ? info.Author.trim() : "",
            pages: doc.numPages,
            cover,
        };
    } finally {
        void doc.loadingTask.destroy();
    }
}
