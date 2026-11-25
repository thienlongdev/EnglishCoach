"use client";

/**
 * My Books — the second Reading tab. A personal, local-first bookshelf: books are opened or imported on this device
 * (IndexedDB, one library per account) and never uploaded. Lazily loaded by ReadingDashboard; the reader engines load
 * only when a book opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useSession } from "next-auth/react";
import {
    AlertTriangle, ArrowRight, BookMarked, BookOpen, Check, CheckCircle2, Download, Ellipsis, FolderPlus, HardDrive,
    Library, Loader2, Orbit, Plus, Search, Trash2, Upload, X,
} from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { usePremiumEntitlement } from "@/hooks/usePremiumEntitlement";
import { dailyAllowance } from "@/services/premiumApi";
import { requestBookImports, settleBookImports } from "@/services/readingBooksApi";
import { BookStore, QuotaError, requestPersistence, storageEstimate } from "./store/bookStore";
import { ACCEPT, formatOf, prepareBook } from "./store/importer";
import type { BookMeta } from "./engine/types";
import styles from "../glass/readingGlass.module.css";
import { READING_ART, SHELF_BACKDROP } from "../glass/ReadingHero";
import { useContentTitle } from '@/lib/brand/tabTitle';
import {
    clearEchoWorkspaceContext,
    dispatchEchoModuleReady,
    publishEchoWorkspaceContext,
    setOverBookReader,
} from "@/lib/echo/contextBridge";

const BookReader = dynamic(() => import("./BookReader"), {
    ssr: false,
    loading: () => (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-[#efe6d4] text-sm font-semibold text-stone-600" role="status">
            <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Đang mở sách…</span>
        </div>
    ),
});

type Job = { id: string; name: string; state: "waiting" | "checking" | "saving" | "done" | "error" | "duplicate"; message?: string; bookId?: string };
type Filter = "all" | "reading" | "new" | "finished";
type Sort = "recent" | "title" | "author" | "added" | "progress";
export interface OpenBook { meta: BookMeta; file: Blob; persistent: boolean; cover?: Blob | null }

const formatBytes = (n: number) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB` : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function hue(text: string) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
    return h;
}

function BookCover({ store, book, className = "" }: { store: BookStore | null; book: BookMeta; className?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        if (!store || !book.hasCover || !ref.current) return;
        let objectUrl: string | null = null;
        let cancelled = false;
        const io = new IntersectionObserver((entries) => {
            if (!entries.some((e) => e.isIntersecting)) return;
            io.disconnect();
            void store.getCover(book.id).then((blob) => {
                if (cancelled || !blob) return;
                objectUrl = URL.createObjectURL(blob);
                setUrl(objectUrl);
            }).catch(() => undefined);
        }, { rootMargin: "200px" });
        io.observe(ref.current);
        return () => { cancelled = true; io.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, [store, book.id, book.hasCover]);
    const h = hue(book.title + book.author);
    return (
        <div ref={ref} className={`relative aspect-[2/3] w-full overflow-hidden rounded-[6px_10px_10px_6px] bg-stone-200 shadow-[0_1px_2px_rgba(0,0,0,0.12),0_14px_28px_-18px_rgba(40,30,10,0.55)] dark:bg-white/[0.06] ${className}`}>
            {url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
            ) : (
                <div className="flex h-full w-full flex-col justify-between p-3 text-left" style={{ background: `linear-gradient(160deg, hsl(${h} 32% 34%), hsl(${(h + 28) % 360} 36% 22%))` }}>
                    <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/60">{book.format}</span>
                    <div>
                        <p className="line-clamp-4 text-[13px] font-bold leading-snug text-white">{book.title}</p>
                        {book.author && <p className="mt-1.5 line-clamp-2 text-[11px] font-medium text-white/70">{book.author}</p>}
                    </div>
                </div>
            )}
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-[6px] bg-gradient-to-r from-black/25 via-black/5 to-transparent" />
        </div>
    );
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div className={styles.scrim} onClick={onClose}>
            <div role="dialog" aria-modal="true" aria-label={title} className={`${styles.panel} ${styles.dialog}`} onClick={(e) => e.stopPropagation()}>
                <div className={styles.dialogHead}>
                    <h3 className={styles.dialogTitle}>{title}</h3>
                    <button type="button" onClick={onClose} aria-label="Đóng" className={styles.iconBtn}><X className="h-4 w-4" /></button>
                </div>
                <div className={styles.dialogBody}>{children}</div>
            </div>
        </div>
    );
}

/** `onSummary` tells the Reading hero the shelf counts (undefined while the library opens, null when it is unavailable). */
export default function MyBooksTab({ onSummary }: { onSummary?: (summary: { all: number; reading: number; finished: number } | null | undefined) => void } = {}) {
    const { locale } = useLanguage();
    const { entitlement, isPremium, mutateEntitlement } = usePremiumEntitlement();
    const bookAllowance = isPremium ? undefined : dailyAllowance(entitlement, "BOOK");
    const vi = locale === "vi";
    const { data: session, status } = useSession();
    const userId = session?.user ? String((session.user as { id?: string | number }).id ?? "") : "";
    const [store, setStore] = useState<BookStore | null>(null);
    const [books, setBooks] = useState<BookMeta[] | null>(null);
    const [fatal, setFatal] = useState<string | null>(null);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [open, setOpen] = useState<OpenBook | null>(null);
    const [prefsRev, setPrefsRev] = useState(0);
    useContentTitle(open?.meta.title);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [sort, setSort] = useState<Sort>("recent");
    const [collection, setCollection] = useState<string>("");
    const [dragging, setDragging] = useState(false);
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [toDelete, setToDelete] = useState<BookMeta | null>(null);
    const [collectionFor, setCollectionFor] = useState<BookMeta | null>(null);
    const [newCollection, setNewCollection] = useState("");
    const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
    const [persisted, setPersisted] = useState<boolean | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const addInput = useRef<HTMLInputElement>(null);
    const readInput = useRef<HTMLInputElement>(null);
    const restoreInput = useRef<HTMLInputElement>(null);
    const queueRef = useRef<Array<{ job: Job; file: File }>>([]);
    const running = useRef(false);
    const dragDepth = useRef(0);

    useEffect(() => {
        if (!userId) return;
        let alive = true;
        let opened: BookStore | null = null;
        BookStore.open(userId).then(async (s) => {
            opened = s;
            if (!alive) { s.close(); return; }
            setStore(s);
            setBooks(await s.listBooks());
            setUsage(await storageEstimate());
            setPersisted(navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => null) : null);
        }).catch(() => alive && setFatal(vi ? "Trình duyệt này không cho phép lưu sách trên thiết bị (có thể đang ở chế độ ẩn danh). Bạn vẫn có thể dùng “Đọc ngay”." : "This browser does not allow storing books on this device (private mode?). You can still use “Read now”."));
        return () => { alive = false; opened?.close(); setStore(null); setBooks(null); setOpen(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId]);

    useEffect(() => {
        if (!menuFor) return;
        const onDown = (e: PointerEvent) => {
            const target = e.target as Element | null;
            if (!target?.closest('[role="menu"], [aria-haspopup="menu"]')) setMenuFor(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuFor(null); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
    }, [menuFor]);

    const refresh = useCallback(async () => {
        if (!store) return;
        setBooks(await store.listBooks());
        setUsage(await storageEstimate());
    }, [store]);

    useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(null), 4200);
        return () => clearTimeout(t);
    }, [notice]);

    const pump = useCallback(async () => {
        if (running.current || !store) return;
        running.current = true;
        try {
            while (queueRef.current.length) {
                const { job, file } = queueRef.current.shift()!;
                const update = (patch: Partial<Job>) => setJobs((list) => list.map((j) => (j.id === job.id ? { ...j, ...patch } : j)));
                update({ state: "checking" });
                try {
                    const prepared = await prepareBook(file);
                    const dup = await store.findByFingerprint(prepared.meta.fingerprint);
                    if (dup) { update({ state: "duplicate", bookId: dup.id, message: vi ? `Đã có trong thư viện: “${dup.title}”` : `Already on your shelf: “${dup.title}”` }); continue; }
                    // the daily import allowance is the server's (free: one new book a day); only the fingerprint is sent
                    const fp = prepared.meta.fingerprint;
                    const grant = await requestBookImports([fp]);
                    if (!grant.granted.includes(fp)) {
                        update({ state: "error", message: vi ? `Tài khoản miễn phí nhập được ${grant.limit} cuốn sách mỗi ngày. Bạn có thể nhập tiếp vào ngày mai.` : `Free accounts can add ${grant.limit} book a day. You can add more tomorrow.` });
                        void mutateEntitlement();
                        continue;
                    }
                    update({ state: "saving" });
                    try {
                        await store.addBook(prepared.meta, prepared.file, prepared.cover);
                    } catch (stored) {
                        void settleBookImports([fp], false).catch(() => undefined); // not stored: the day's import comes back
                        throw stored;
                    }
                    void settleBookImports([fp], true).catch(() => undefined);
                    void mutateEntitlement();
                    update({ state: "done", bookId: prepared.meta.id, message: prepared.meta.title });
                    setBooks(await store.listBooks());
                } catch (error) {
                    const message = error instanceof QuotaError ? error.message : (error as Error)?.message || (vi ? "Không thể nhập tệp này." : "Could not import this file.");
                    update({ state: "error", message });
                }
            }
        } finally {
            running.current = false;
            setUsage(await storageEstimate());
        }
    }, [store, vi, mutateEntitlement]);

    const enqueue = useCallback((files: FileList | File[]) => {
        const list = Array.from(files).slice(0, 50);
        if (!list.length) return;
        void requestPersistence().then((p) => p !== null && setPersisted(p));
        const fresh = list.map((file) => {
            const job: Job = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: file.name, state: "waiting" };
            if (!formatOf(file)) { job.state = "error"; job.message = vi ? "Định dạng chưa được hỗ trợ (EPUB, PDF, TXT)." : "Unsupported format (EPUB, PDF, TXT)."; }
            else queueRef.current.push({ job, file });
            return job;
        });
        setJobs((prev) => [...fresh, ...prev.filter((j) => j.state === "waiting" || j.state === "checking" || j.state === "saving")].slice(0, 30));
        void pump();
    }, [pump, vi]);

    const readNow = useCallback(async (file: File) => {
        setBusy(vi ? "Đang kiểm tra tệp…" : "Checking file…");
        try {
            const prepared = await prepareBook(file);
            setOpen({ meta: prepared.meta, file: prepared.file, persistent: false, cover: prepared.cover });
        } catch (error) {
            setNotice((error as Error)?.message || (vi ? "Không thể mở tệp này." : "Could not open this file."));
        } finally {
            setBusy(null);
        }
    }, [vi]);

    const openBook = useCallback(async (meta: BookMeta) => {
        if (!store) return;
        const file = await store.getFile(meta.id).catch(() => undefined);
        if (!file) { setNotice(vi ? "Tệp sách không còn trên thiết bị này. Hãy xóa và nhập lại sách." : "The book file is no longer on this device. Remove and import it again."); return; }
        setOpen({ meta, file, persistent: true });
    }, [store, vi]);

    useEffect(() => {
        if (!store || !books) return;
        const win = window as unknown as { __ecPendingMyBookOpenId?: string };
        const openByTarget = (bookId?: string) => {
            const sorted = [...books].sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
            const found = bookId ? books.find((b) => b.id === bookId) : sorted[0];
            if (found) void openBook(found);
        };
        if (win.__ecPendingMyBookOpenId) {
            const pendingId = win.__ecPendingMyBookOpenId;
            delete win.__ecPendingMyBookOpenId;
            openByTarget(pendingId);
        }
        const onVoiceOpen = (e: Event) => openByTarget((e as CustomEvent<{ bookId?: string }>).detail?.bookId);
        const onVoicePrefs = (e: Event) => {
            const detail = (e as CustomEvent<{ page?: "next" | "prev"; theme?: string; fontDelta?: number; fontSize?: number }>).detail;
            if (!detail) return;
            if (detail.page === "next" || detail.page === "prev") {
                window.dispatchEvent(new KeyboardEvent("keydown", { key: detail.page === "next" ? "ArrowRight" : "ArrowLeft" }));
                return;
            }
            void (async () => {
                const cur = (await store.getPrefs().catch(() => undefined)) ?? {};
                const next = { ...cur };
                if (detail.theme === "paper" || detail.theme === "white" || detail.theme === "dark" || detail.theme === "oled") {
                    next.theme = detail.theme;
                }
                if (typeof detail.fontSize === "number" || typeof detail.fontDelta === "number") {
                    const base = typeof cur.fontSize === "number" ? cur.fontSize : 18;
                    next.fontSize = Math.max(14, Math.min(28, detail.fontSize ?? (base + (detail.fontDelta ?? 0))));
                }
                await store.savePrefs(next as any).catch(() => undefined);
                setPrefsRev((n) => n + 1);
            })();
        };
        window.addEventListener("ec:mybooks:open", onVoiceOpen);
        window.addEventListener("ec:mybooks:prefs", onVoicePrefs);
        dispatchEchoModuleReady("mybooks", { count: books.length });
        return () => {
            window.removeEventListener("ec:mybooks:open", onVoiceOpen);
            window.removeEventListener("ec:mybooks:prefs", onVoicePrefs);
        };
    }, [store, books, openBook]);

    useEffect(() => {
        if (!open) {
            clearEchoWorkspaceContext("mybooks");
            return;
        }
        let alive = true;
        setOverBookReader(true);
        const baseMeta = {
            title: open.meta.title,
            ...(open.meta.author ? { author: open.meta.author } : {}),
            progressPct: Math.max(0, Math.min(100, Math.round((open.meta.progress ?? 0) * 100))),
        };
        publishEchoWorkspaceContext({
            source: "mybooks",
            kind: "BOOK_ACTIVE",
            overBookReader: true,
            bookMeta: baseMeta,
        });
        if (store && open.persistent) {
            void store.annotations(open.meta.id).then((list) => {
                if (!alive) return;
                const recentHighlights = list
                    .slice(-5)
                    .map((item) => ((item as { quote?: string; text?: string }).quote || (item as { text?: string }).text || "").trim())
                    .filter(Boolean);
                if (recentHighlights.length > 0) {
                    publishEchoWorkspaceContext({
                        source: "mybooks",
                        kind: "BOOK_ACTIVE",
                        overBookReader: true,
                        bookMeta: { ...baseMeta, recentHighlights },
                    });
                }
            }).catch(() => undefined);
        }
        return () => {
            alive = false;
            clearEchoWorkspaceContext("mybooks");
        };
    }, [open, store]);

    const closeReader = useCallback(() => {
        setOpen(null);
        void refresh();
    }, [refresh]);

    const onDrop = (e: DragEvent) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (e.dataTransfer.files?.length) {
            if (store) enqueue(e.dataTransfer.files);
            else void readNow(e.dataTransfer.files[0]);
        }
    };

    const collections = useMemo(() => [...new Set((books ?? []).flatMap((b) => b.collections))].sort((a, b) => a.localeCompare(b)), [books]);
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = (books ?? []).filter((b) => (filter === "all" || b.status === filter) && (!collection || b.collections.includes(collection))
            && (!q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)));
        const by: Record<Sort, (a: BookMeta, b: BookMeta) => number> = {
            recent: (a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt),
            title: (a, b) => a.title.localeCompare(b.title, vi ? "vi" : "en"),
            author: (a, b) => (a.author || "~").localeCompare(b.author || "~", vi ? "vi" : "en"),
            added: (a, b) => b.addedAt - a.addedAt,
            progress: (a, b) => b.progress - a.progress,
        };
        return list.sort(by[sort]);
    }, [books, query, filter, sort, collection, vi]);
    const continueBook = useMemo(() => (books ?? []).filter((b) => b.status === "reading" && b.lastOpenedAt).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0], [books]);
    const counts = useMemo(() => ({
        all: books?.length ?? 0,
        reading: books?.filter((b) => b.status === "reading").length ?? 0,
        new: books?.filter((b) => b.status === "new").length ?? 0,
        finished: books?.filter((b) => b.status === "finished").length ?? 0,
    }), [books]);

    useEffect(() => {
        if (!onSummary) return;
        if (books) onSummary({ all: counts.all, reading: counts.reading, finished: counts.finished });
        else onSummary(fatal || status === "unauthenticated" || (status === "authenticated" && !userId) ? null : undefined);
    }, [onSummary, books, counts, fatal, status, userId]);

    const exportBackup = async () => {
        if (!store) return;
        setBusy(vi ? "Đang tạo bản sao lưu…" : "Preparing backup…");
        try {
            const { exportLibrary } = await import("./store/backup");
            const blob = await exportLibrary(store);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `my-books-${new Date().toISOString().slice(0, 10)}.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            setNotice(vi ? "Đã tạo bản sao lưu thư viện." : "Library backup created.");
        } catch (error) {
            setNotice((error as Error)?.message || (vi ? "Không thể tạo bản sao lưu." : "Could not create the backup."));
        } finally { setBusy(null); }
    };

    const restoreBackup = async (file: File) => {
        if (!store) return;
        setBusy(vi ? "Đang khôi phục…" : "Restoring…");
        try {
            const { importLibrary } = await import("./store/backup");
            let granted: string[] = [];
            const result = await importLibrary(store, file, async (fps) => {
                if (!fps.length) return new Set<string>();
                granted = (await requestBookImports(fps)).granted;
                return new Set(granted);
            });
            const added = new Set(result.addedFingerprints);
            await settleBookImports(granted.filter((f) => added.has(f)), true).catch(() => undefined);
            await settleBookImports(granted.filter((f) => !added.has(f)), false).catch(() => undefined);
            void mutateEntitlement();
            await refresh();
            setNotice(vi ? `Đã khôi phục ${result.added} sách${result.skipped ? `, bỏ qua ${result.skipped} (đã có hoặc không hợp lệ)` : ""}${result.refused ? `, ${result.refused} sách chờ lượt nhập ngày mai` : ""}.` : `Restored ${result.added} books${result.skipped ? `, skipped ${result.skipped}` : ""}${result.refused ? `, ${result.refused} wait for tomorrow's import` : ""}.`);
        } catch (error) {
            setNotice(error instanceof QuotaError ? error.message : (error as Error)?.message || (vi ? "Không thể khôi phục bản sao lưu này." : "Could not restore this backup."));
        } finally { setBusy(null); }
    };

    const setStatus = async (book: BookMeta, statusValue: BookMeta["status"]) => {
        await store?.updateBook(book.id, { status: statusValue, progress: statusValue === "new" ? 0 : statusValue === "finished" ? 1 : book.progress });
        setMenuFor(null);
        await refresh();
    };

    const toggleCollection = async (book: BookMeta, name: string) => {
        const has = book.collections.includes(name);
        const next = has ? book.collections.filter((c) => c !== name) : [...book.collections, name].slice(0, 20);
        const updated = await store?.updateBook(book.id, { collections: next });
        if (updated) setCollectionFor(updated);
        await refresh();
    };

    // The shelf runs the whole row: the empty places of the last row get a plank only (measured from the grid itself).
    const shelfRef = useRef<HTMLUListElement>(null);
    const [shelfCols, setShelfCols] = useState(0);
    const hasShelf = shown.length > 0 && !open;
    useEffect(() => {
        const ul = shelfRef.current;
        if (!hasShelf || !ul) return;
        const read = () => setShelfCols(getComputedStyle(ul).gridTemplateColumns.split(" ").filter(Boolean).length);
        read();
        const ro = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
        ro?.observe(ul);
        return () => ro?.disconnect();
    }, [hasShelf]);
    const shelfFillers = shelfCols ? (shelfCols - (shown.length % shelfCols)) % shelfCols : 0;

    if (open) {
        // The reader is a full-window overlay: it is rendered into <body> so no stacking context of the workspace column
        // (ApplicationFrame's z-10 content column sits under the z-40 sidebar) can cover any part of the book.
        const reader = <BookReader key={`${open.meta.id}-${prefsRev}`} book={open} store={store} onClose={closeReader} onSaved={(meta) => { setOpen((o) => (o ? { ...o, meta, persistent: true } : o)); void refresh(); void mutateEntitlement(); }} />;
        return typeof document === "undefined" ? reader : createPortal(reader, document.body);
    }

    const statusLabel = (s: BookMeta["status"]) => (s === "reading" ? (vi ? "Đang đọc" : "Reading") : s === "finished" ? (vi ? "Đã đọc xong" : "Finished") : (vi ? "Chưa đọc" : "Not started"));

    return (
        <section
            aria-label={vi ? "Sách của tôi" : "My Books"}
            className="relative flex flex-col gap-5"
            onDragEnter={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); dragDepth.current++; setDragging(true); } }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
            onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
            onDrop={onDrop}
        >
            <input ref={addInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { if (e.target.files) enqueue(e.target.files); e.target.value = ""; }} />
            <input ref={readInput} type="file" accept={ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void readNow(f); e.target.value = ""; }} />
            <input ref={restoreInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void restoreBackup(f); e.target.value = ""; }} />

            {/* Shelf bar: the library's own actions (the room itself is the hero above) */}
            <div className={`${styles.panel} ${styles.shelfBar}`}>
                <div className={styles.shelfBarText}>
                    <h2>{vi ? "Kệ sách trên thiết bị này" : "Your shelf on this device"}</h2>
                    <p>{vi ? "Thêm sách EPUB, PDF hoặc TXT — hoặc kéo thả tệp vào trang. English Coach không nhận và không lưu tệp của bạn." : "Add EPUB, PDF or TXT books — or drop files on the page. English Coach never receives your files."}</p>
                    {bookAllowance && (
                        <p className="font-semibold" data-book-allowance>
                            {vi ? `${bookAllowance.limit} lượt nhập sách miễn phí mỗi ngày · hôm nay còn ${bookAllowance.remaining}` : `${bookAllowance.limit} free book import a day · ${bookAllowance.remaining} left today`}
                        </p>
                    )}
                </div>
                <div className={styles.shelfActions}>
                    <button type="button" onClick={() => addInput.current?.click()} disabled={!store} className={styles.primaryBtn} data-guide="mb-add">
                        <Plus className="h-4 w-4" aria-hidden="true" />{vi ? "Thêm sách" : "Add books"}
                    </button>
                    <button type="button" onClick={() => readInput.current?.click()} className={styles.softBtn} data-guide="mb-read">
                        <BookOpen className="h-4 w-4" aria-hidden="true" />{vi ? "Đọc ngay một tệp" : "Read a file now"}
                    </button>
                    <div className="relative">
                        <button type="button" aria-haspopup="menu" aria-expanded={menuFor === "__lib"} onClick={() => setMenuFor(menuFor === "__lib" ? null : "__lib")} aria-label={vi ? "Tùy chọn thư viện" : "Library options"} className={styles.softBtn} style={{ width: "2.75rem", padding: 0 }}>
                            <Ellipsis className="h-4 w-4" />
                        </button>
                        {menuFor === "__lib" && (
                            <div role="menu" className={`${styles.panel} ${styles.menu}`}>
                                <button role="menuitem" type="button" disabled={!store || !books?.length} onClick={() => { setMenuFor(null); void exportBackup(); }} className={styles.menuItem}><Download />{vi ? "Sao lưu thư viện (.zip)" : "Back up library (.zip)"}</button>
                                <button role="menuitem" type="button" disabled={!store} onClick={() => { setMenuFor(null); restoreInput.current?.click(); }} className={styles.menuItem}><Upload />{vi ? "Khôi phục từ bản sao lưu" : "Restore from backup"}</button>
                                <div className={styles.menuNote}>
                                    <p className="flex items-center gap-1.5 font-semibold"><HardDrive className="h-3.5 w-3.5" />{usage ? `${formatBytes(usage.usage)} / ${formatBytes(usage.quota)}` : "—"}</p>
                                    <p className="mt-1">{persisted ? (vi ? "Trình duyệt đã đồng ý giữ dữ liệu lâu dài." : "The browser agreed to keep this data.") : (vi ? "Trình duyệt có thể xóa dữ liệu khi thiếu dung lượng — hãy sao lưu định kỳ." : "The browser may clear this data when space runs low — back up regularly.")}</p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {fatal && <p role="alert" className={styles.alert}>{fatal}</p>}
            {status === "unauthenticated" && <p className={`${styles.panel} px-4 py-3 text-sm`} style={{ color: "var(--ink-2)" }}>{vi ? "Đăng nhập để lưu sách vào thư viện riêng. Bạn vẫn có thể “Đọc ngay một tệp”." : "Sign in to keep books in your library. You can still “Read a file now”."}</p>}

            {jobs.length > 0 && (
                <ul aria-live="polite" className={`${styles.panel} ${styles.jobs}`}>
                    {jobs.map((job) => (
                        <li key={job.id} className={styles.job}>
                            {job.state === "done" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : job.state === "error" ? <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" /> : job.state === "duplicate" ? <BookMarked className="h-4 w-4 shrink-0 text-amber-600" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: "var(--ink-3)" }} />}
                            <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--ink)" }}>{job.name}</span>
                            <span className={`shrink-0 text-xs ${job.state === "error" ? "text-rose-700 dark:text-rose-300" : ""}`} style={job.state === "error" ? undefined : { color: "var(--ink-3)" }}>
                                {job.state === "waiting" ? (vi ? "Đang chờ" : "Waiting") : job.state === "checking" ? (vi ? "Đang kiểm tra" : "Checking") : job.state === "saving" ? (vi ? "Đang lưu" : "Saving") : job.state === "done" ? (vi ? "Đã thêm" : "Added") : job.message}
                            </span>
                            {(job.state === "done" || job.state === "duplicate") && job.bookId && (
                                <button type="button" onClick={() => { const b = books?.find((x) => x.id === job.bookId); if (b) void openBook(b); }} className={styles.ghostBtn}>{vi ? "Mở" : "Open"}</button>
                            )}
                        </li>
                    ))}
                    {!jobs.some((j) => j.state === "waiting" || j.state === "checking" || j.state === "saving") && (
                        <li><button type="button" onClick={() => setJobs([])} className={styles.ghostBtn}>{vi ? "Ẩn danh sách" : "Dismiss"}</button></li>
                    )}
                </ul>
            )}

            {continueBook && filter === "all" && !query && !collection && (
                <div className={`${styles.panel} ${styles.bookResume}`} data-tone="mybooks">
                    <div className={styles.bookResumeArt} aria-hidden="true">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={READING_ART.mybooks.small} alt="" decoding="async" loading="lazy" />
                    </div>
                    <div className={styles.bookResumeCover}><BookCover store={store} book={continueBook} /></div>
                    <div className="min-w-0">
                        <span className={styles.resumeTag}><BookMarked className="h-3 w-3" aria-hidden="true" />{vi ? "Đọc tiếp" : "Continue reading"}</span>
                        <h3 className={styles.bookTitle}>{continueBook.title}</h3>
                        {continueBook.author && <p className={styles.bookAuthor}>{continueBook.author}</p>}
                        <div className="mt-3 flex items-center gap-3">
                            <div className={styles.meter} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(continueBook.progress * 100)} aria-label={vi ? "Tiến độ" : "Progress"}>
                                <span style={{ width: `${Math.round(continueBook.progress * 100)}%` }} />
                            </div>
                            <span className="text-xs font-bold tabular-nums" style={{ color: "var(--ink-2)" }}>{Math.round(continueBook.progress * 100)}%</span>
                        </div>
                    </div>
                    <button type="button" onClick={() => void openBook(continueBook)} className={`${styles.primaryBtn} ${styles.bookResumeBtn}`}>
                        <span>{vi ? "Đọc tiếp" : "Continue"}</span><ArrowRight className="h-4 w-4" />
                    </button>
                </div>
            )}

            {(books?.length ?? 0) > 0 && (
                <div className={`${styles.panel} ${styles.filters}`}>
                    <div className={styles.filterRow}>
                        <div role="group" aria-label={vi ? "Trạng thái" : "Status"} className={`${styles.well} ${styles.segment} overflow-x-auto`}>
                            {([["all", vi ? "Tất cả" : "All"], ["reading", vi ? "Đang đọc" : "Reading"], ["new", vi ? "Chưa đọc" : "Not started"], ["finished", vi ? "Đã đọc xong" : "Finished"]] as Array<[Filter, string]>).map(([id, label]) => (
                                <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={styles.segBtn}>
                                    {label}<span className={styles.segCount}>{counts[id]}</span>
                                </button>
                            ))}
                        </div>
                        <div className={styles.search}>
                            <Search className={styles.searchIcon} aria-hidden="true" />
                            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label={vi ? "Tìm sách" : "Search books"} placeholder={vi ? "Tìm theo tên sách hoặc tác giả…" : "Search title or author…"} className={styles.field} />
                            {query && <button type="button" onClick={() => setQuery("")} aria-label={vi ? "Xóa tìm kiếm" : "Clear search"} className={styles.clearBtn}><X className="h-4 w-4" /></button>}
                        </div>
                        <select aria-label={vi ? "Sắp xếp" : "Sort"} value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={styles.select}>
                            <option value="recent">{vi ? "Mở gần đây" : "Recently opened"}</option>
                            <option value="added">{vi ? "Mới thêm" : "Recently added"}</option>
                            <option value="title">{vi ? "Tên sách" : "Title"}</option>
                            <option value="author">{vi ? "Tác giả" : "Author"}</option>
                            <option value="progress">{vi ? "Tiến độ" : "Progress"}</option>
                        </select>
                    </div>
                    {collections.length > 0 && (
                        <div role="group" aria-label={vi ? "Bộ sưu tập" : "Collections"} className={styles.chips}>
                            {["", ...collections].map((c) => (
                                <button key={c || "all"} type="button" aria-pressed={collection === c} onClick={() => setCollection(c)} className={styles.chip}>
                                    {c || (vi ? "Mọi bộ sưu tập" : "All collections")}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {books === null && store === null && !fatal && userId && (
                <div role="status" className={styles.shelfRoom} aria-label={vi ? "Đang tải thư viện" : "Loading library"}>
                    <div className={styles.shelf}>
                        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="aspect-[2/3] w-[78%] mx-auto rounded-lg bg-white/40 motion-safe:animate-pulse dark:bg-white/[0.06]" />)}
                    </div>
                </div>
            )}

            {books && books.length === 0 && (
                <button type="button" onClick={() => addInput.current?.click()} className={styles.dropZone}>
                    <span className={styles.emptyIcon}><BookOpen className="h-7 w-7" /></span>
                    <span className="text-base font-bold" style={{ color: "var(--ink)" }}>{vi ? "Kéo thả sách vào đây hoặc chọn tệp" : "Drop books here or choose files"}</span>
                    <span className="max-w-md text-sm leading-relaxed" style={{ color: "var(--ink-3)" }}>{vi ? "EPUB, PDF hoặc TXT. Sách được lưu trên thiết bị này để đọc cả khi ngoại tuyến; English Coach không nhận và không lưu tệp của bạn." : "EPUB, PDF or TXT. Books are stored on this device for offline reading; English Coach never receives your files."}</span>
                </button>
            )}

            {books && books.length > 0 && shown.length === 0 && (
                <p className={`${styles.panel} px-5 py-8 text-center text-sm`} style={{ color: "var(--ink-3)" }}>{vi ? "Không có sách nào khớp bộ lọc." : "No books match these filters."}</p>
            )}

            {shown.length > 0 && (
                <div className={styles.shelfRoom} data-guide="mb-shelf">
                    <div className={styles.shelfBackdrop} aria-hidden="true">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={SHELF_BACKDROP} alt="" decoding="async" loading="lazy" />
                    </div>
                    <ul ref={shelfRef} className={styles.shelf}>
                        {shown.map((book) => (
                            <li key={book.id} className={styles.shelfItem}>
                                <button type="button" onClick={() => void openBook(book)} className={styles.shelfBook} aria-label={`${vi ? "Mở" : "Open"} ${book.title}`}>
                                    <span><BookCover store={store} book={book} /></span>
                                    <span className={styles.statusTag} data-status={book.status} aria-hidden="true">{statusLabel(book.status)}</span>
                                </button>
                                <div className={styles.plank} aria-hidden="true" />
                                <div className={styles.shelfMeta}>
                                    <div className="min-w-0 flex-1">
                                        <p className={styles.shelfName}>{book.title}</p>
                                        <p className={styles.shelfBy}>{book.author || book.format.toUpperCase()}</p>
                                        {book.status === "reading" && (
                                            <div className={styles.shelfProgress} aria-hidden="true">
                                                <span style={{ width: `${Math.max(2, Math.round(book.progress * 100))}%` }} />
                                            </div>
                                        )}
                                    </div>
                                    <div className="relative">
                                        <button type="button" aria-haspopup="menu" aria-expanded={menuFor === book.id} aria-label={vi ? `Tùy chọn cho ${book.title}` : `Options for ${book.title}`} onClick={() => setMenuFor(menuFor === book.id ? null : book.id)} className={styles.iconBtn}><Ellipsis className="h-4 w-4" /></button>
                                        {menuFor === book.id && (
                                            <div role="menu" className={`${styles.panel} ${styles.menu}`}>
                                                <button role="menuitem" type="button" onClick={() => { setMenuFor(null); void openBook(book); }} className={styles.menuItem}><BookOpen />{vi ? "Mở sách" : "Open"}</button>
                                                {book.status !== "finished" && <button role="menuitem" type="button" onClick={() => void setStatus(book, "finished")} className={styles.menuItem}><CheckCircle2 />{vi ? "Đánh dấu đã đọc xong" : "Mark as finished"}</button>}
                                                {book.status !== "new" && <button role="menuitem" type="button" onClick={() => void setStatus(book, "new")} className={styles.menuItem}><BookMarked />{vi ? "Đánh dấu chưa đọc" : "Mark as not started"}</button>}
                                                <button role="menuitem" type="button" onClick={() => { setMenuFor(null); setCollectionFor(book); }} className={styles.menuItem}><FolderPlus />{vi ? "Bộ sưu tập…" : "Collections…"}</button>
                                                {/* the book's highlights as a source star (read on this device by the universe; the reader itself is frozen, 10 §AO) */}
                                                <Link role="menuitem" href={`/knowledge-universe?source=${encodeURIComponent(`MY_BOOKS:${book.id}`)}`} onClick={() => setMenuFor(null)} className={styles.menuItem}><Orbit />{vi ? "Xem trong vũ trụ" : "See in the universe"}</Link>
                                                <button role="menuitem" type="button" onClick={() => { setMenuFor(null); setToDelete(book); }} className={`${styles.menuItem} ${styles.menuDanger}`}><Trash2 />{vi ? "Xóa khỏi thiết bị" : "Remove from device"}</button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </li>
                        ))}
                        {Array.from({ length: shelfFillers }).map((_, i) => (
                            <li key={`shelf-${i}`} aria-hidden="true" className={styles.shelfItem}><div className={styles.shelfSpacer} /><div className={styles.plank} /></li>
                        ))}
                    </ul>
                </div>
            )}

            {dragging && (
                <div className="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-stone-900/30">
                    <div className="rounded-2xl border-2 border-dashed border-amber-200 bg-[#fbf7ef] px-10 py-8 text-center shadow-2xl dark:bg-[#1b1a17]">
                        <Upload className="mx-auto h-8 w-8 text-amber-800 dark:text-amber-200" />
                        <p className="mt-2 text-base font-bold text-stone-900 dark:text-stone-100">{store ? (vi ? "Thả để thêm vào Sách của tôi" : "Drop to add to My Books") : (vi ? "Thả để đọc ngay" : "Drop to read now")}</p>
                    </div>
                </div>
            )}

            {busy && <div role="status" className={styles.toast}><span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{busy}</span></div>}
            {notice && !busy && <div role="status" className={styles.toast}>{notice}</div>}

            {toDelete && (
                <Dialog title={vi ? "Xóa sách khỏi thiết bị?" : "Remove book from this device?"} onClose={() => setToDelete(null)}>
                    <p className="text-sm leading-relaxed" style={{ color: "var(--ink-2)" }}>
                        {vi ? <>Tệp <strong style={{ color: "var(--ink)" }}>“{toDelete.title}”</strong>, vị trí đọc, dấu trang, đánh dấu và ghi chú của sách này sẽ bị xóa khỏi thiết bị. Không thể hoàn tác.</> : <>The file <strong style={{ color: "var(--ink)" }}>“{toDelete.title}”</strong> and its position, bookmarks, highlights and notes will be removed from this device. This cannot be undone.</>}
                    </p>
                    <div className="mt-5 flex justify-end gap-2">
                        <button type="button" onClick={() => setToDelete(null)} className={styles.softBtn}>{vi ? "Hủy" : "Cancel"}</button>
                        <button type="button" onClick={async () => { const b = toDelete; setToDelete(null); await store?.deleteBook(b.id); await refresh(); setNotice(vi ? `Đã xóa “${b.title}”.` : `Removed “${b.title}”.`); }} className="inline-flex h-11 items-center rounded-[0.95rem] bg-rose-600 px-4 text-sm font-bold text-white hover:bg-rose-700 cursor-pointer">{vi ? "Xóa" : "Remove"}</button>
                    </div>
                </Dialog>
            )}

            {collectionFor && (
                <Dialog title={vi ? "Bộ sưu tập" : "Collections"} onClose={() => setCollectionFor(null)}>
                    <p className="mb-3 truncate text-sm" style={{ color: "var(--ink-3)" }}>{collectionFor.title}</p>
                    <div className="max-h-56 space-y-1 overflow-y-auto">
                        {collections.map((c) => (
                            <label key={c} className={`${styles.menuItem} cursor-pointer`}>
                                <input type="checkbox" checked={collectionFor.collections.includes(c)} onChange={() => void toggleCollection(collectionFor, c)} className="h-4 w-4 accent-amber-700" />{c}
                            </label>
                        ))}
                    </div>
                    <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); const name = newCollection.trim().slice(0, 60); if (name) { void toggleCollection(collectionFor, name); setNewCollection(""); } }}>
                        <input value={newCollection} onChange={(e) => setNewCollection(e.target.value)} placeholder={vi ? "Tên bộ sưu tập mới" : "New collection name"} aria-label={vi ? "Tên bộ sưu tập mới" : "New collection name"} className={styles.field} style={{ padding: "0 0.9rem" }} />
                        <button type="submit" className={styles.primaryBtn}>{vi ? "Thêm" : "Add"}</button>
                    </form>
                </Dialog>
            )}
        </section>
    );
}
