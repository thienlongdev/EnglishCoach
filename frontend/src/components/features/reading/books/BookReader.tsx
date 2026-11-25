"use client";

/**
 * Immersive book reader of My Books: a full-screen page with no site navigation, controls that hide while reading,
 * the book engine (EPUB / TXT flow renderer or PDF renderer) in an isolated shadow root, and secondary tools.
 * Positions, bookmarks, highlights and notes are saved locally (IndexedDB) for books on the shelf, and kept in
 * memory only for a book opened with "Đọc ngay" until the learner saves it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowLeft, Bookmark, BookmarkCheck, BookmarkPlus, ChevronLeft, ChevronRight, Copy, List, Loader2, Maximize2,
    Minimize2, NotebookPen, Search, StickyNote, Trash2, Type, Undo2,
} from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { FlowRenderer, type PageNumbers, type RelocateInfo } from "./engine/flow";
import { EpubSource } from "./engine/epub";
import { TxtSource } from "./engine/txt";
import { BookSearch, type SearchHit } from "./engine/search";
import { DEFAULT_PREFS, type Annotation, type BookMeta, type HighlightColor, type Locator, type ReaderPrefs, type TocItem } from "./engine/types";
import type { PdfRelocate, PdfSelection } from "./engine/pdf";
import type { SelectionInfo } from "./engine/flow";
import { BookStore, newId } from "./store/bookStore";
import { openPageCache } from "./store/pageCache";
import { literata } from "./literata";
import { SelectionTools, type ReaderSelection } from "./SelectionTools";
import { AppearancePanel, NotesPanel, Panel, SearchPanel, TocPanel, type PanelId } from "./ReaderPanels";
import type { OpenBook } from "./MyBooksTab";
import { requestBookImports, settleBookImports } from "@/services/readingBooksApi";

interface Engine {
    next(): void;
    prev(): void;
    goToTarget(t: TocItem["target"]): Promise<void>;
    goToFraction(f: number): Promise<void>;
    goToLoc(loc: Locator, jump?: boolean): Promise<void>;
    setPrefs(p: ReaderPrefs): void;
    setHighlights(a: Annotation[]): void;
    clearSelection(): void;
    rectOfHighlight(id: string): DOMRect | null;
    search(query: string, signal: AbortSignal, update: (hits: SearchHit[], scanned: number, total: number) => void): Promise<void>;
    showHit(hit: SearchHit, query: string): Promise<void>;
    pageRange(): { s: number; start: number; end: number } | null;
    label(s: number, o?: number): string;
    currentLabel(): string;
    destroy(): void;
}

interface Where { loc: Locator; page: number; pages: number; progress: number; spine: number; atStart: boolean; atEnd: boolean; numbers?: PageNumbers | null; lastPage?: number; pageLabels?: string[] | null }

type Sel = ReaderSelection & ({ kind: "flow"; range: SelectionInfo["range"] } | { kind: "pdf"; page: number; rects: PdfSelection["rects"] });

const FONTS = {
    ui: "var(--font-quicksand), system-ui, sans-serif",
    serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif",
    sans: "system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
};

const CHROME: Record<ReaderPrefs["theme"], { bar: string; text: string; sub: string; btn: string; dark: boolean; desk: string }> = {
    paper: { bar: "bg-[#f3ead8]/95 border-[#e2d5bc]", text: "text-[#2c261d]", sub: "text-[#2c261d]/60", btn: "hover:bg-[#2c261d]/[0.07]", dark: false, desk: "#e7dcc6" },
    white: { bar: "bg-white/95 border-stone-200", text: "text-stone-900", sub: "text-stone-500", btn: "hover:bg-stone-900/[0.06]", dark: false, desk: "#ebeae6" },
    dark: { bar: "bg-[#1b1c1f]/95 border-white/10", text: "text-[#e2ded5]", sub: "text-[#e2ded5]/55", btn: "hover:bg-white/10", dark: true, desk: "#131416" },
    oled: { bar: "bg-black/95 border-white/10", text: "text-[#c9c5bc]", sub: "text-[#c9c5bc]/50", btn: "hover:bg-white/10", dark: true, desk: "#000000" },
};

export default function BookReader({ book, store, onClose, onSaved }: { book: OpenBook; store: BookStore | null; onClose: () => void; onSaved: (meta: BookMeta) => void }) {
    const { locale } = useLanguage();
    const vi = locale === "vi";
    const meta = book.meta;
    const rootRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const engineRef = useRef<Engine | null>(null);
    const persistent = useRef(book.persistent);
    const [prefs, setPrefsState] = useState<ReaderPrefs>(DEFAULT_PREFS);
    const prefsRef = useRef(prefs);
    const [ready, setReady] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [where, setWhere] = useState<Where | null>(null);
    const whereRef = useRef<Where | null>(null);
    const [toc, setToc] = useState<TocItem[]>([]);
    const [annotations, setAnnotations] = useState<Annotation[]>([]);
    const annRef = useRef<Annotation[]>([]);
    const [selection, setSelection] = useState<Sel | null>(null);
    const [panel, setPanel] = useState<PanelId | null>(null);
    const [chrome, setChrome] = useState(true);
    const [fullscreen, setFullscreen] = useState(false);
    const [history, setHistory] = useState<Locator[]>([]);
    const [toast, setToast] = useState<string | null>(null);
    const [footnote, setFootnote] = useState<{ text: string; rect: DOMRect; follow: () => void } | null>(null);
    const [external, setExternal] = useState<string | null>(null);
    const [hlMenu, setHlMenu] = useState<{ id: string; rect: DOMRect; editing: boolean; draft: string } | null>(null);
    const [mobile, setMobile] = useState(false);
    const [pageRange, setPageRange] = useState<{ s: number; start: number; end: number } | null>(null);
    const [curlOk, setCurlOk] = useState(true);
    const [searchSeed] = useState("");
    const saveTimer = useRef(0);
    const labelsRef = useRef<string[] | null>(null);
    const hideTimer = useRef(0);
    const wheelAt = useRef(0);
    const theme = CHROME[prefs.theme];

    const notify = useCallback((message: string) => setToast(message), []);
    useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3200); return () => clearTimeout(t); }, [toast]);
    useEffect(() => {
        const update = () => setMobile(window.innerWidth < 640);
        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, []);

    // Save position (debounced) and on leave.
    const flushPosition = useCallback(() => {
        clearTimeout(saveTimer.current);
        const w = whereRef.current;
        if (!w || !persistent.current || !store) return;
        void store.savePosition({ bookId: meta.id, loc: w.loc, progress: w.progress, updatedAt: Date.now() });
    }, [store, meta.id]);

    const onRelocate = useCallback((w: Where) => {
        whereRef.current = w;
        setWhere(w);
        setPageRange(engineRef.current?.pageRange() ?? null);
        clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(flushPosition, 700);
    }, [flushPosition]);

    const pushHistory = useCallback(() => {
        const w = whereRef.current;
        if (w) setHistory((h) => [...h.slice(-19), w.loc]);
    }, []);

    // ───────────── open the book ─────────────
    useEffect(() => {
        let cancelled = false;
        let engine: Engine | null = null;
        const host = hostRef.current;
        if (!host) return;
        (async () => {
            // stored page indexes of a library book (reflowable formats); read while the rest opens
            const pageCache = persistent.current && store && meta.format !== "pdf" ? openPageCache(store, meta).catch(() => null) : null;
            const saved = store ? await store.getPrefs().catch(() => undefined) : undefined;
            const initialPrefs = { ...DEFAULT_PREFS, ...(saved ?? {}) };
            if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) setCurlOk(false);
            prefsRef.current = initialPrefs;
            setPrefsState(initialPrefs);
            const position = persistent.current && store ? await store.getPosition(meta.id).catch(() => undefined) : undefined;
            const anns = persistent.current && store ? await store.annotations(meta.id).catch(() => []) : [];
            if (cancelled) return;
            annRef.current = anns;
            setAnnotations(anns);
            const common = {
                onTapCenter: () => setChrome((c) => !c),
                onHighlightClick: (id: string, rect: DOMRect) => { const a = annRef.current.find((x) => x.id === id); setHlMenu({ id, rect, editing: false, draft: a?.note ?? "" }); },
                onError: (error: unknown) => { console.warn("My Books reader:", error); },
                onEdge: (which: "start" | "end") => {
                    if (which === "end") {
                        setToast(vi ? "Bạn đã đọc đến cuối sách." : "You reached the end of the book.");
                        if (persistent.current && store) void store.updateBook(meta.id, { status: "finished", progress: 1 });
                    } else setToast(vi ? "Đây là trang đầu tiên." : "This is the first page.");
                },
                onTurnFallback: () => {
                    setCurlOk(false);
                    const next = { ...prefsRef.current, turn: "instant" as const };
                    prefsRef.current = next;
                    setPrefsState(next);
                    engineRef.current?.setPrefs(next);
                    setToast(vi ? "Thiết bị đang chậm — đã chuyển sang lật trang nhanh." : "This device is slow — switched to instant page turns.");
                },
            };
            try {
                if (meta.format === "pdf") {
                    const mod = await import("./engine/pdf");
                    const doc = await mod.openPdfDocument(book.file);
                    if (cancelled) { void doc.loadingTask.destroy(); return; }
                    const renderer = new mod.PdfRenderer(host, doc, initialPrefs, {
                        ...common,
                        onRelocate: (info: PdfRelocate) => onRelocate({ loc: { s: info.page, o: 0 }, page: info.page, pages: info.pages, progress: info.progress, spine: info.page, atStart: info.atStart, atEnd: info.atEnd, lastPage: info.last, pageLabels: labelsRef.current }),
                        onSelection: (sel) => setSelection(sel ? { kind: "pdf", text: sel.text, rect: sel.rect, sentence: sel.sentence, context: sel.context, anchor: sel.anchor, page: sel.page, rects: sel.rects } : null),
                    });
                    const search = new BookSearch((i) => renderer.pageText(i), doc.numPages);
                    engine = {
                        next: () => renderer.next(), prev: () => renderer.prev(),
                        goToTarget: (t) => { pushHistory(); return renderer.goToPage(t.s); },
                        goToFraction: (f) => { pushHistory(); return renderer.goToPage(Math.round(f * (doc.numPages - 1))); },
                        goToLoc: (loc, jump = true) => { if (jump) pushHistory(); return renderer.goToPage(loc.s); },
                        setPrefs: (p) => renderer.setPrefs(p), setHighlights: (a) => renderer.setHighlights(a),
                        clearSelection: () => renderer.clearSelection(), rectOfHighlight: (id) => renderer.rectOfHighlight(id),
                        search: (q, signal, update) => search.run(q, signal, update, whereRef.current?.page ?? 0),
                        showHit: (hit, q) => { pushHistory(); return renderer.showSearchHit(hit.s, q); },
                        pageRange: () => null,
                        label: (s) => (vi ? `Trang ${s + 1}` : `Page ${s + 1}`),
                        currentLabel: () => "",
                        destroy: () => renderer.destroy(),
                    };
                    engineRef.current = engine;
                    renderer.setHighlights(anns);
                    // printed page labels (e.g. "xii") when the PDF declares them; the index stays the page number
                    labelsRef.current = await doc.getPageLabels().catch(() => null);
                    await renderer.open(position?.loc.s ?? 0);
                    if (!cancelled) setToc(await renderer.outline());
                } else {
                    const source = meta.format === "epub" ? await EpubSource.open(book.file) : await TxtSource.open(book.file, meta.title);
                    const cache = pageCache ? await pageCache : null;
                    if (cancelled) { source.dispose(); return; }
                    const renderer = new FlowRenderer(host, source, initialPrefs, { body: literata.style.fontFamily, ...FONTS }, {
                        ...common,
                        onRelocate: (info: RelocateInfo) => onRelocate({ loc: info.locator, page: info.page, pages: info.pages, progress: info.progress, spine: info.spine, atStart: info.atStart, atEnd: info.atEnd, numbers: info.numbers }),
                        onSelection: (sel) => setSelection(sel ? { kind: "flow", text: sel.text, rect: sel.rect, sentence: sel.sentence, context: sel.context, anchor: sel.anchor, range: sel.range } : null),
                        onFootnote: (text, rect, follow) => setFootnote({ text, rect, follow }),
                        onExternalLink: (url) => setExternal(url),
                        onBeforeJump: () => pushHistory(),
                    }, vi, cache);
                    const search = BookSearch.forFlow(source);
                    engine = {
                        next: () => renderer.next(), prev: () => renderer.prev(),
                        goToTarget: (t) => renderer.goToTarget(t),
                        goToFraction: (f) => renderer.goToFraction(f),
                        goToLoc: (loc, jump = true) => renderer.goTo(loc, jump),
                        setPrefs: (p) => renderer.setPrefs(p), setHighlights: (a) => renderer.setHighlights(a),
                        clearSelection: () => renderer.clearSelection(), rectOfHighlight: (id) => renderer.rectOfHighlight(id),
                        search: (q, signal, update) => search.run(q, signal, update, whereRef.current?.spine ?? 0),
                        showHit: (hit) => renderer.showSearchHit({ s: hit.s, start: hit.start, end: hit.end }),
                        pageRange: () => renderer.currentPageRange(),
                        label: (s, o) => renderer.tocLabelFor(s, o),
                        currentLabel: () => renderer.currentLabel(),
                        destroy: () => { renderer.destroy(); source.dispose(); },
                    };
                    engineRef.current = engine;
                    renderer.setHighlights(anns);
                    setToc(source.toc);
                    await renderer.open(position?.loc ?? null);
                }
                if (cancelled) return;
                setReady(true);
                if (persistent.current && store) void store.updateBook(meta.id, { lastOpenedAt: Date.now(), status: meta.status === "new" ? "reading" : meta.status });
                hideTimer.current = window.setTimeout(() => setChrome(false), 2600);
            } catch (error) {
                console.warn("My Books open failed:", error);
                if (!cancelled) setFailure((error as Error)?.message || (vi ? "Không thể mở sách này." : "Could not open this book."));
            }
        })();
        return () => {
            cancelled = true;
            clearTimeout(hideTimer.current);
            flushPosition();
            engine?.destroy();
            engineRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const setPrefs = useCallback((p: ReaderPrefs) => {
        prefsRef.current = p;
        setPrefsState(p);
        engineRef.current?.setPrefs(p);
        if (store) void store.savePrefs(p);
    }, [store]);

    // ───────────── annotations ─────────────
    const commit = useCallback((next: Annotation[]) => {
        annRef.current = next;
        setAnnotations(next);
        engineRef.current?.setHighlights(next);
    }, []);

    // `captured` = the selection a tool card was opened for: the live selection is usually gone once a card has focus
    const addHighlight = useCallback((color: HighlightColor, note?: string, captured?: Sel) => {
        const sel = captured ?? selection;
        if (!sel) return;
        const now = Date.now();
        const same = annRef.current.find((a) => a.kind === "highlight" && (sel.kind === "flow"
            ? a.range && a.range.s === sel.range.s && a.range.start === sel.range.start && a.range.end === sel.range.end
            : a.page === sel.page && a.text === sel.text));
        const ann: Annotation = same
            ? { ...same, color, note: note ?? same.note, updatedAt: now }
            : { id: newId(), bookId: meta.id, kind: "highlight", createdAt: now, updatedAt: now, text: sel.text.slice(0, 4000), color, note,
                ...(sel.kind === "flow" ? { range: sel.range } : { page: sel.page, rects: sel.rects }) };
        commit(same ? annRef.current.map((a) => (a.id === same.id ? ann : a)) : [...annRef.current, ann]);
        if (persistent.current && store) void store.putAnnotation(ann).catch((e) => setToast((e as Error).message));
        engineRef.current?.clearSelection();
        setSelection(null);
    }, [selection, meta.id, commit, store]);

    const removeAnnotation = useCallback((a: Annotation) => {
        commit(annRef.current.filter((x) => x.id !== a.id));
        if (persistent.current && store) void store.deleteAnnotation(a.id);
    }, [commit, store]);

    const updateAnnotation = useCallback((a: Annotation) => {
        commit(annRef.current.map((x) => (x.id === a.id ? a : x)));
        if (persistent.current && store) void store.putAnnotation(a);
    }, [commit, store]);

    const bookmarksHere = useMemo(() => {
        if (!where) return [];
        return annotations.filter((a) => a.kind === "bookmark" && a.loc && (meta.format === "pdf"
            ? a.loc.s === where.page
            : pageRange && a.loc.s === pageRange.s && a.loc.o >= pageRange.start && a.loc.o < pageRange.end));
    }, [annotations, where, pageRange, meta.format]);

    const toggleBookmark = useCallback(() => {
        const w = whereRef.current;
        if (!w) return;
        if (bookmarksHere.length) {
            for (const b of bookmarksHere) removeAnnotation(b);
            setToast(vi ? "Đã bỏ dấu trang." : "Bookmark removed.");
            return;
        }
        const now = Date.now();
        const label = meta.format === "pdf" ? (vi ? `Trang ${w.page + 1}` : `Page ${w.page + 1}`) : (w.loc.t ? `${w.loc.t.trim()}…` : engineRef.current?.label(w.spine, w.loc.o) ?? "");
        const ann: Annotation = { id: newId(), bookId: meta.id, kind: "bookmark", createdAt: now, updatedAt: now, loc: w.loc, text: "", label };
        commit([...annRef.current, ann]);
        if (persistent.current && store) void store.putAnnotation(ann);
        setToast(vi ? "Đã đánh dấu trang." : "Page bookmarked.");
    }, [bookmarksHere, removeAnnotation, meta.id, meta.format, commit, store, vi]);

    const goToAnnotation = useCallback(async (a: Annotation) => {
        setPanel(null);
        if (a.range) await engineRef.current?.goToLoc({ s: a.range.s, o: a.range.start });
        else if (a.page !== undefined) await engineRef.current?.goToLoc({ s: a.page, o: 0 });
        else if (a.loc) await engineRef.current?.goToLoc(a.loc);
    }, []);

    // ───────────── chrome / keyboard ─────────────
    const anyOverlay = Boolean(panel || selection || hlMenu || footnote || external);
    useEffect(() => {
        if (!chrome || anyOverlay || !ready) return;
        clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => setChrome(false), 4200);
        return () => clearTimeout(hideTimer.current);
    }, [chrome, anyOverlay, ready, where]);

    const toggleFullscreen = useCallback(async () => {
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await rootRef.current?.requestFullscreen?.({ navigationUI: "hide" });
        } catch { setToast(vi ? "Trình duyệt không cho phép toàn màn hình; trình đọc đã chiếm toàn bộ cửa sổ." : "Full screen is not available; the reader already fills the window."); }
    }, [vi]);
    useEffect(() => {
        const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);

    const close = useCallback(() => {
        flushPosition();
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        onClose();
    }, [flushPosition, onClose]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
            if (panel || hlMenu || external) return;
            const engine = engineRef.current;
            if (!engine) return;
            const k = e.key;
            if (k === "ArrowRight" || k === "PageDown" || (k === " " && !e.shiftKey)) { e.preventDefault(); setSelection(null); engine.next(); }
            else if (k === "ArrowLeft" || k === "PageUp" || (k === " " && e.shiftKey)) { e.preventDefault(); setSelection(null); engine.prev(); }
            else if ((k === "f" || k === "F") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void toggleFullscreen(); }
            else if ((k === "t" || k === "T") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setPanel("toc"); }
            else if ((k === "b" || k === "B") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); toggleBookmark(); }
            else if (k === "/" || ((e.ctrlKey || e.metaKey) && (k === "f" || k === "F"))) { e.preventDefault(); setPanel("search"); }
            else if (k === "Escape") { if (selection || footnote) { setSelection(null); setFootnote(null); engine.clearSelection(); } else setChrome((c) => !c); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [panel, hlMenu, external, selection, footnote, toggleFullscreen, toggleBookmark]);

    useEffect(() => {
        const flush = () => { if (document.visibilityState === "hidden") flushPosition(); };
        document.addEventListener("visibilitychange", flush);
        window.addEventListener("pagehide", flushPosition);
        return () => { document.removeEventListener("visibilitychange", flush); window.removeEventListener("pagehide", flushPosition); };
    }, [flushPosition]);

    const onWheel = (e: React.WheelEvent) => {
        if (prefs.turn === "scroll" || panel || !engineRef.current) return;
        if (meta.format === "pdf" && prefs.pdfZoom !== "page") return;
        const now = performance.now();
        if (now - wheelAt.current < 420 || Math.abs(e.deltaY) < 24) return;
        wheelAt.current = now;
        if (e.deltaY > 0) engineRef.current.next(); else engineRef.current.prev();
    };

    const onPointerMoveRoot = (e: React.PointerEvent) => {
        // only the outermost strips reveal the bars, and never during a press (a corner drag must reach the page)
        if (e.pointerType !== "mouse" || !ready || e.buttons !== 0) return;
        const h = window.innerHeight;
        if (e.clientY < 36 || e.clientY > h - 14) setChrome(true);
    };

    const saveToShelf = async () => {
        if (!store) return;
        try {
            const dup = await store.findByFingerprint(meta.fingerprint);
            const target = dup ?? meta;
            if (!dup) {
                // keeping an opened book is an import: the same daily allowance as "Thêm sách" (only the fingerprint is sent)
                const fp = meta.fingerprint;
                const grant = await requestBookImports([fp]);
                if (!grant.granted.includes(fp)) {
                    setToast(vi ? `Tài khoản miễn phí nhập được ${grant.limit} cuốn sách mỗi ngày. Bạn vẫn có thể đọc tiếp và lưu vào ngày mai.` : `Free accounts can add ${grant.limit} book a day. Keep reading and save it tomorrow.`);
                    return;
                }
                try {
                    await store.addBook(meta, book.file, book.cover ?? null);
                } catch (stored) {
                    void settleBookImports([fp], false).catch(() => undefined); // not stored: the day's import comes back
                    throw stored;
                }
                void settleBookImports([fp], true).catch(() => undefined);
            }
            persistent.current = true;
            for (const a of annRef.current) await store.putAnnotation({ ...a, bookId: target.id });
            if (target.id !== meta.id) commit(annRef.current.map((a) => ({ ...a, bookId: target.id })));
            const w = whereRef.current;
            if (w) await store.savePosition({ bookId: target.id, loc: w.loc, progress: w.progress, updatedAt: Date.now() });
            onSaved(target);
            setToast(vi ? "Đã lưu vào Sách của tôi." : "Saved to My Books.");
        } catch (error) {
            setToast((error as Error)?.message || (vi ? "Không lưu được sách." : "Could not save the book."));
        }
    };

    const pct = where ? Math.round(where.progress * 100) : 0;
    const chapter = where && meta.format !== "pdf" ? engineRef.current?.currentLabel() ?? "" : "";
    const span = (a: number, b: number) => (a === b ? `${a}` : `${a}–${b}`);
    const pdfShown = where && meta.format === "pdf" ? span(where.page + 1, (where.lastPage ?? where.page) + 1) : "";
    const pdfPrinted = (() => {
        // the PDF's own page labels, only when they differ from the page numbers
        const labels = where?.pageLabels;
        if (!where || !labels) return "";
        const a = labels[where.page], b = labels[where.lastPage ?? where.page];
        if (!a || (a === String(where.page + 1) && b === String((where.lastPage ?? where.page) + 1))) return "";
        return a === b ? a : `${a}–${b}`;
    })();
    const n = where?.numbers;
    const pageLabel = !where ? "" : meta.format === "pdf"
        ? `${vi ? "Trang" : where.lastPage !== undefined && where.lastPage !== where.page ? "Pages" : "Page"} ${pdfShown} / ${where.pages}${pdfPrinted ? (vi ? ` · số in ${pdfPrinted}` : ` · printed ${pdfPrinted}`) : ""}`
        : !n ? `${pct}%`
            : [
                n.book && `${vi ? "Trang" : n.book.first === n.book.last ? "Page" : "Pages"} ${span(n.book.first, n.book.last)} / ${n.book.total}`,
                n.chapter && `${span(n.chapter.first, n.chapter.last)}/${n.chapter.total} ${vi ? "trong chương" : "in chapter"}`,
                `${pct}%`,
                n.counting && (vi ? "đang đếm số trang cả sách…" : "counting the book's pages…"),
            ].filter(Boolean).join(" · ");
    const pageHint = meta.format === "pdf" ? undefined : (vi
        ? "Số trang theo bố cục hiện tại (cỡ chữ, giãn dòng, lề, khổ trang) — không phải số trang của bản in."
        : "Pages of the current layout (font size, line height, margins, page size) — not a printed edition's page numbers.");
    const iconBtn = `grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 ${theme.btn}`;
    const hlTarget = hlMenu ? annotations.find((a) => a.id === hlMenu.id) : undefined;

    return (
        <div ref={rootRef} className="fixed inset-0 z-[70] select-none overflow-hidden" style={{ background: theme.desk }} onWheel={onWheel} onPointerMove={onPointerMoveRoot}
            role="application" aria-roledescription={vi ? "trình đọc sách" : "book reader"} aria-label={meta.title}>
            <div ref={hostRef} className="absolute inset-0" />

            {!ready && !failure && (
                <div role="status" className={`absolute inset-0 grid place-items-center ${theme.text}`}>
                    <span className="inline-flex items-center gap-2 text-sm font-semibold opacity-70"><Loader2 className="h-4 w-4 animate-spin" />{vi ? "Đang dàn trang…" : "Laying out pages…"}</span>
                </div>
            )}
            {failure && (
                <div className={`absolute inset-0 grid place-items-center p-6 ${theme.text}`}>
                    <div className="max-w-md text-center">
                        <p className="text-lg font-bold">{vi ? "Không mở được sách" : "Could not open the book"}</p>
                        <p className="mt-2 text-sm opacity-75">{failure}</p>
                        <button type="button" onClick={close} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-bold text-white"><ArrowLeft className="h-4 w-4" />{vi ? "Về thư viện" : "Back to library"}</button>
                    </div>
                </div>
            )}

            {/* Top bar */}
            <header className={`absolute inset-x-0 top-0 z-[80] border-b backdrop-blur-sm transition-[transform,opacity] duration-200 motion-reduce:transition-none ${theme.bar} ${theme.text} ${chrome || !ready ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-full opacity-0"}`}>
                <div className="flex h-14 items-center gap-1 px-2 sm:gap-2 sm:px-3">
                    <button type="button" onClick={close} className={`${iconBtn} w-auto gap-1.5 px-2.5 text-sm font-semibold`} aria-label={vi ? "Về thư viện" : "Back to library"}>
                        <ArrowLeft className="h-5 w-5" /><span className="hidden sm:inline">{vi ? "Thư viện" : "Library"}</span>
                    </button>
                    <div className="min-w-0 flex-1 px-1 text-center">
                        <p className="truncate text-[13.5px] font-bold">{meta.title}</p>
                        {chapter && <p className={`truncate text-[11.5px] ${theme.sub}`}>{chapter}</p>}
                    </div>
                    {!persistent.current && store && (
                        <button type="button" onClick={() => void saveToShelf()} className={`${iconBtn} w-auto gap-1.5 px-2.5 text-[13px] font-bold`}><BookmarkPlus className="h-4 w-4" /><span className="hidden md:inline">{vi ? "Lưu vào Sách của tôi" : "Save to My Books"}</span></button>
                    )}
                    <button type="button" onClick={() => setPanel("toc")} className={iconBtn} aria-label={vi ? "Mục lục" : "Contents"} title={vi ? "Mục lục (T)" : "Contents (T)"}><List className="h-5 w-5" /></button>
                    <button type="button" onClick={() => setPanel("search")} className={iconBtn} aria-label={vi ? "Tìm trong sách" : "Search"} title={vi ? "Tìm (/)" : "Search (/)"}><Search className="h-5 w-5" /></button>
                    <button type="button" onClick={() => setPanel("notes")} className={`${iconBtn} hidden sm:grid`} aria-label={vi ? "Dấu trang và ghi chú" : "Bookmarks and notes"}><NotebookPen className="h-5 w-5" /></button>
                    <button type="button" onClick={() => setPanel("appearance")} className={iconBtn} aria-label={vi ? "Hiển thị" : "Appearance"}><Type className="h-5 w-5" /></button>
                    <button type="button" onClick={toggleBookmark} className={iconBtn} aria-pressed={bookmarksHere.length > 0} aria-label={bookmarksHere.length ? (vi ? "Bỏ dấu trang" : "Remove bookmark") : (vi ? "Đánh dấu trang" : "Bookmark page")} title="B">
                        {bookmarksHere.length ? <BookmarkCheck className="h-5 w-5 text-amber-700 dark:text-amber-300" /> : <Bookmark className="h-5 w-5" />}
                    </button>
                    <button type="button" onClick={() => void toggleFullscreen()} className={`${iconBtn} hidden sm:grid`} aria-label={fullscreen ? (vi ? "Thoát toàn màn hình" : "Exit full screen") : (vi ? "Toàn màn hình" : "Full screen")} title="F">
                        {fullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
                    </button>
                </div>
            </header>

            {bookmarksHere.length > 0 && !chrome && <span aria-hidden="true" className="pointer-events-none absolute right-6 top-0 z-[75] h-9 w-5 bg-amber-700/80 [clip-path:polygon(0_0,100%_0,100%_100%,50%_72%,0_100%)] dark:bg-amber-300/80" />}

            {/* Bottom bar */}
            <footer className={`absolute inset-x-0 bottom-0 z-[80] border-t backdrop-blur-sm transition-[transform,opacity] duration-200 motion-reduce:transition-none ${theme.bar} ${theme.text} ${chrome && ready ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0"}`}>
                <div className="flex items-center gap-2 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
                    <button type="button" onClick={() => engineRef.current?.prev()} className={iconBtn} aria-label={vi ? "Trang trước" : "Previous page"}><ChevronLeft className="h-5 w-5" /></button>
                    <div className="min-w-0 flex-1">
                        <input type="range" min={0} max={1000} step={1} value={Math.round((where?.progress ?? 0) * 1000)} aria-label={vi ? "Vị trí trong sách" : "Position in book"}
                            onChange={(e) => setWhere((w) => (w ? { ...w, progress: Number(e.target.value) / 1000 } : w))}
                            onPointerUp={(e) => { void engineRef.current?.goToFraction(Number((e.target as HTMLInputElement).value) / 1000); }}
                            onKeyUp={(e) => { if (e.key.startsWith("Arrow")) void engineRef.current?.goToFraction(Number((e.target as HTMLInputElement).value) / 1000); }}
                            className="h-6 w-full cursor-pointer accent-amber-700" />
                        <div className={`flex items-center justify-between gap-3 text-[11.5px] font-medium ${theme.sub}`}>
                            <span className="truncate" title={pageHint}>{pageLabel}</span>
                            {history.length > 0 && (
                                <button type="button" onClick={() => { const h = history[history.length - 1]; setHistory((x) => x.slice(0, -1)); void engineRef.current?.goToLoc(h, false); }} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold hover:underline">
                                    <Undo2 className="h-3.5 w-3.5" />{vi ? "Quay lại vị trí trước" : "Back to previous spot"}
                                </button>
                            )}
                        </div>
                    </div>
                    <button type="button" onClick={() => engineRef.current?.next()} className={iconBtn} aria-label={vi ? "Trang sau" : "Next page"}><ChevronRight className="h-5 w-5" /></button>
                </div>
            </footer>

            {ready && meta.format === "pdf" && !chrome && where && (
                <span aria-hidden="true" className={`pointer-events-none absolute bottom-2 left-1/2 z-[75] -translate-x-1/2 text-[11px] font-semibold tabular-nums ${theme.sub}`}>{pdfShown} / {where.pages}</span>
            )}

            <SelectionTools vi={vi} selection={selection} mobile={mobile} bookTitle={meta.title} bookAuthor={meta.author}
                onHighlight={(color, note, sel) => addHighlight(color, note, sel as Sel)} onDismiss={() => { setSelection(null); engineRef.current?.clearSelection(); }} notify={notify} />

            {hlMenu && hlTarget && (
                <div className="fixed inset-0 z-[92]" onClick={() => setHlMenu(null)}>
                    <div role="dialog" aria-label={vi ? "Đánh dấu" : "Highlight"} onClick={(e) => e.stopPropagation()}
                        style={mobile ? undefined : { left: Math.max(8, Math.min(window.innerWidth - 328, hlMenu.rect.left + hlMenu.rect.width / 2 - 160)), top: hlMenu.rect.top > 240 ? hlMenu.rect.top - 12 : hlMenu.rect.bottom + 12, transform: hlMenu.rect.top > 240 ? "translateY(-100%)" : undefined }}
                        className={`${mobile ? "fixed inset-x-0 bottom-0 rounded-t-2xl" : "fixed w-80 rounded-2xl"} border border-stone-200 bg-white p-3.5 shadow-2xl dark:border-white/10 dark:bg-[#17181c] dark:text-stone-100`}>
                        <div className="flex items-center gap-1.5">
                            {(["yellow", "green", "blue", "pink", "orange"] as HighlightColor[]).map((c) => (
                                <button key={c} type="button" aria-label={c} aria-pressed={hlTarget.color === c} onClick={() => updateAnnotation({ ...hlTarget, color: c, updatedAt: Date.now() })}
                                    className={`h-7 w-7 rounded-full ring-offset-2 ${hlTarget.color === c ? "ring-2 ring-stone-800 dark:ring-white" : ""}`} style={{ background: { yellow: "#f3cf55", green: "#86c98a", blue: "#7fb0f2", pink: "#f09ab8", orange: "#f3a866" }[c] }} />
                            ))}
                            <span className="flex-1" />
                            <button type="button" aria-label={vi ? "Sao chép" : "Copy"} onClick={() => { void navigator.clipboard?.writeText(hlTarget.text); setToast(vi ? "Đã sao chép." : "Copied."); }} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-stone-100 dark:hover:bg-white/10"><Copy className="h-4 w-4" /></button>
                            <button type="button" aria-label={vi ? "Xóa đánh dấu" : "Delete highlight"} onClick={() => { removeAnnotation(hlTarget); setHlMenu(null); }} className="grid h-8 w-8 place-items-center rounded-lg text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10"><Trash2 className="h-4 w-4" /></button>
                        </div>
                        {hlMenu.editing ? (
                            <div className="mt-3">
                                <textarea autoFocus rows={3} value={hlMenu.draft} onChange={(e) => setHlMenu({ ...hlMenu, draft: e.target.value.slice(0, 8000) })} aria-label={vi ? "Ghi chú" : "Note"}
                                    className="w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:border-white/10 dark:bg-white/[0.04]" />
                                <div className="mt-2 flex justify-end gap-2">
                                    <button type="button" onClick={() => setHlMenu({ ...hlMenu, editing: false })} className="rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-stone-100 dark:hover:bg-white/10">{vi ? "Hủy" : "Cancel"}</button>
                                    <button type="button" onClick={() => { updateAnnotation({ ...hlTarget, note: hlMenu.draft.trim() || undefined, updatedAt: Date.now() }); setHlMenu(null); }} className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-bold text-white dark:bg-amber-100 dark:text-stone-900">{vi ? "Lưu" : "Save"}</button>
                                </div>
                            </div>
                        ) : (
                            <button type="button" onClick={() => setHlMenu({ ...hlMenu, editing: true, draft: hlTarget.note ?? "" })} className="mt-3 flex w-full items-start gap-2 rounded-xl bg-stone-50 px-3 py-2 text-left text-sm hover:bg-stone-100 dark:bg-white/5 dark:hover:bg-white/10">
                                <StickyNote className="mt-0.5 h-4 w-4 shrink-0 opacity-60" /><span className={hlTarget.note ? "" : "opacity-60"}>{hlTarget.note || (vi ? "Thêm ghi chú…" : "Add a note…")}</span>
                            </button>
                        )}
                    </div>
                </div>
            )}

            {footnote && (
                <div className="fixed inset-0 z-[92]" onClick={() => setFootnote(null)}>
                    <div role="dialog" aria-label={vi ? "Chú thích" : "Footnote"} onClick={(e) => e.stopPropagation()}
                        style={mobile ? undefined : { left: Math.max(8, Math.min(window.innerWidth - 408, footnote.rect.left - 40)), top: footnote.rect.top > window.innerHeight / 2 ? undefined : footnote.rect.bottom + 10, bottom: footnote.rect.top > window.innerHeight / 2 ? window.innerHeight - footnote.rect.top + 10 : undefined }}
                        className={`${mobile ? "fixed inset-x-0 bottom-0 rounded-t-2xl" : "fixed w-[400px] rounded-2xl"} max-h-[50vh] overflow-y-auto border border-stone-200 bg-white p-4 text-sm leading-relaxed shadow-2xl dark:border-white/10 dark:bg-[#17181c] dark:text-stone-100`}>
                        <p className="whitespace-pre-line">{footnote.text}</p>
                        <div className="mt-3 flex justify-end gap-2">
                            <button type="button" onClick={() => { const f = footnote.follow; setFootnote(null); f(); }} className="rounded-lg px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-50 dark:text-amber-200 dark:hover:bg-white/10">{vi ? "Đi tới chú thích" : "Go to note"}</button>
                            <button type="button" onClick={() => setFootnote(null)} className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-bold text-white dark:bg-amber-100 dark:text-stone-900">{vi ? "Đóng" : "Close"}</button>
                        </div>
                    </div>
                </div>
            )}

            {external && (
                <div className="fixed inset-0 z-[96] grid place-items-center bg-black/40 p-4" onClick={() => setExternal(null)}>
                    <div role="dialog" aria-modal="true" aria-label={vi ? "Liên kết ngoài" : "External link"} onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl dark:bg-[#17181c] dark:text-stone-100">
                        <p className="text-base font-bold">{vi ? "Mở liên kết bên ngoài sách?" : "Open a link outside the book?"}</p>
                        <p className="mt-2 break-all rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-700 dark:bg-white/5 dark:text-stone-300">{external}</p>
                        <div className="mt-4 flex justify-end gap-2">
                            <button type="button" onClick={() => setExternal(null)} className="rounded-xl px-4 py-2 text-sm font-semibold hover:bg-stone-100 dark:hover:bg-white/10">{vi ? "Hủy" : "Cancel"}</button>
                            <button type="button" onClick={() => { window.open(external, "_blank", "noopener,noreferrer"); setExternal(null); }} className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white dark:bg-amber-100 dark:text-stone-900">{vi ? "Mở trong thẻ mới" : "Open in new tab"}</button>
                        </div>
                    </div>
                </div>
            )}

            {panel === "toc" && (
                <Panel title={vi ? "Mục lục" : "Contents"} onClose={() => setPanel(null)} mobile={mobile} dark={theme.dark}>
                    <TocPanel toc={toc} current={where?.spine ?? 0} vi={vi} dark={theme.dark} onPick={(item) => { setPanel(null); void engineRef.current?.goToTarget(item.target); }} />
                </Panel>
            )}
            {panel === "search" && (
                <Panel title={vi ? "Tìm trong sách" : "Search"} onClose={() => setPanel(null)} mobile={mobile} dark={theme.dark}>
                    <SearchPanel vi={vi} dark={theme.dark} initial={searchSeed} run={(q, s, u) => engineRef.current ? engineRef.current.search(q, s, u) : Promise.resolve()}
                        chapterLabel={(s, o) => engineRef.current?.label(s, o) ?? ""} onPick={(hit, q) => { setPanel(null); void engineRef.current?.showHit(hit, q); }} />
                </Panel>
            )}
            {panel === "notes" && (
                <Panel title={vi ? "Dấu trang và ghi chú" : "Bookmarks and notes"} onClose={() => setPanel(null)} mobile={mobile} dark={theme.dark}>
                    <NotesPanel vi={vi} dark={theme.dark} items={annotations} label={(a) => engineRef.current?.label(a.range?.s ?? a.page ?? a.loc?.s ?? 0, a.range?.start ?? a.loc?.o) ?? ""} onPick={(a) => void goToAnnotation(a)} onDelete={removeAnnotation} />
                </Panel>
            )}
            {panel === "appearance" && (
                <Panel title={vi ? "Hiển thị" : "Appearance"} onClose={() => setPanel(null)} mobile={mobile} dark={theme.dark}>
                    <AppearancePanel vi={vi} dark={theme.dark} prefs={prefs} format={meta.format} setPrefs={setPrefs} curlAvailable={curlOk} />
                </Panel>
            )}

            {mobile && chrome && ready && (
                <button type="button" onClick={() => setPanel("notes")} className={`absolute bottom-20 right-3 z-[81] grid h-11 w-11 place-items-center rounded-full border shadow-lg ${theme.bar} ${theme.text}`} aria-label={vi ? "Dấu trang và ghi chú" : "Bookmarks and notes"}><NotebookPen className="h-5 w-5" /></button>
            )}
            {toast && <div role="status" className="pointer-events-none fixed bottom-24 left-1/2 z-[99] max-w-[90vw] -translate-x-1/2 rounded-xl bg-stone-900/95 px-4 py-2.5 text-sm font-medium text-white shadow-lg">{toast}</div>}
        </div>
    );
}
