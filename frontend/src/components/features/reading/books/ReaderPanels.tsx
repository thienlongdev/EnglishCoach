"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bookmark, Loader2, Minus, Plus, Search, StickyNote, Trash2, X } from "lucide-react";
import type { Annotation, BookFormat, HighlightColor, ReaderPrefs, TocItem } from "./engine/types";
import type { SearchHit } from "./engine/search";

export type PanelId = "toc" | "search" | "notes" | "appearance";

export function Panel({ title, onClose, mobile, children, dark }: { title: string; onClose: () => void; mobile: boolean; children: ReactNode; dark: boolean }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onClose]);
    const surface = dark ? "bg-[#1b1c20] text-stone-100 border-white/10" : "bg-[#fbf8f1] text-stone-900 border-stone-200";
    return (
        <>
            <div className="fixed inset-0 z-[88] bg-black/20" onClick={onClose} aria-hidden="true" />
            <aside role="dialog" aria-modal="true" aria-label={title}
                className={`fixed z-[90] flex flex-col border shadow-2xl ${surface} ${mobile ? "inset-x-0 bottom-0 max-h-[82vh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]" : "bottom-3 right-3 top-3 w-[380px] rounded-2xl"}`}>
                <header className={`flex items-center justify-between gap-3 border-b px-5 py-3.5 ${dark ? "border-white/10" : "border-stone-200/80"}`}>
                    <h2 className="text-[15px] font-bold">{title}</h2>
                    <button type="button" onClick={onClose} aria-label="Đóng" className={`grid h-8 w-8 place-items-center rounded-lg ${dark ? "hover:bg-white/10" : "hover:bg-stone-200/60"}`}><X className="h-4 w-4" /></button>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
            </aside>
        </>
    );
}

export function TocPanel({ toc, current, onPick, vi, dark }: { toc: TocItem[]; current: number; onPick: (item: TocItem) => void; vi: boolean; dark: boolean }) {
    const activeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => { activeRef.current?.scrollIntoView({ block: "center" }); }, []);
    let activeAssigned = false;
    const flat: Array<{ item: TocItem; depth: number }> = [];
    const walk = (items: TocItem[], depth: number) => { for (const item of items) { flat.push({ item, depth }); walk(item.children, depth + 1); } };
    walk(toc, 0);
    let activeIndex = -1;
    flat.forEach((f, i) => { if (f.item.target.s <= current) activeIndex = i; });
    if (!flat.length) return <p className="px-5 py-6 text-sm opacity-70">{vi ? "Sách không có mục lục." : "This book has no table of contents."}</p>;
    return (
        <nav aria-label={vi ? "Mục lục" : "Contents"} className="py-2">
            <ol>
                {flat.map(({ item, depth }, i) => {
                    const active = i === activeIndex && !activeAssigned;
                    if (active) activeAssigned = true;
                    return (
                        <li key={i}>
                            <button ref={active ? activeRef : undefined} type="button" onClick={() => onPick(item)} aria-current={active ? "location" : undefined}
                                style={{ paddingLeft: 20 + Math.min(depth, 4) * 16 }}
                                className={`block w-full py-2.5 pr-5 text-left text-[14px] leading-snug transition-colors ${active ? (dark ? "bg-white/10 font-bold" : "bg-amber-100/70 font-bold text-stone-900") : dark ? "hover:bg-white/5" : "hover:bg-stone-200/50"} ${depth ? "opacity-85" : "font-semibold"}`}>
                                {item.label}
                            </button>
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

export function SearchPanel({ vi, dark, run, chapterLabel, onPick, initial }: {
    vi: boolean; dark: boolean; initial: string;
    run: (query: string, signal: AbortSignal, update: (hits: SearchHit[], scanned: number, total: number) => void) => Promise<void>;
    chapterLabel: (s: number, o?: number) => string; onPick: (hit: SearchHit, query: string) => void;
}) {
    const [query, setQuery] = useState(initial);
    const [hits, setHits] = useState<SearchHit[]>([]);
    const [progress, setProgress] = useState<{ scanned: number; total: number } | null>(null);
    const ctrl = useRef<AbortController | null>(null);
    useEffect(() => {
        ctrl.current?.abort();
        const q = query.trim();
        if (q.length < 2) { setHits([]); setProgress(null); return; }
        const controller = new AbortController();
        ctrl.current = controller;
        const t = setTimeout(() => {
            setProgress({ scanned: 0, total: 1 });
            void run(q, controller.signal, (h, scanned, total) => { if (!controller.signal.aborted) { setHits(h); setProgress({ scanned, total }); } });
        }, 300);
        return () => { clearTimeout(t); controller.abort(); };
    }, [query, run]);
    const scanning = progress && progress.scanned < progress.total;
    return (
        <div className="flex h-full flex-col">
            <div className="px-5 pb-3 pt-4">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" aria-hidden="true" />
                    <input autoFocus type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label={vi ? "Tìm trong sách" : "Search in book"} placeholder={vi ? "Tìm trong sách…" : "Search in book…"}
                        className={`h-10 w-full rounded-xl border pl-9 pr-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 ${dark ? "border-white/10 bg-white/5 text-white" : "border-stone-300 bg-white text-stone-900"}`} />
                </div>
                <p className="mt-2 text-xs opacity-60" aria-live="polite">
                    {scanning ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />{vi ? `Đang tìm… ${progress!.scanned}/${progress!.total}` : `Searching… ${progress!.scanned}/${progress!.total}`}</span>
                        : progress ? (vi ? `${hits.length >= 300 ? "300+" : hits.length} kết quả` : `${hits.length >= 300 ? "300+" : hits.length} results`) : vi ? "Nhập ít nhất 2 ký tự." : "Type at least 2 characters."}
                </p>
            </div>
            <ul className="pb-3">
                {hits.map((hit, i) => (
                    <li key={`${hit.s}-${hit.start}-${i}`}>
                        <button type="button" onClick={() => onPick(hit, query.trim())} className={`block w-full px-5 py-2.5 text-left ${dark ? "hover:bg-white/5" : "hover:bg-stone-200/50"}`}>
                            <span className="block truncate text-[11px] font-bold uppercase tracking-[0.08em] opacity-55">{chapterLabel(hit.s, hit.start)}</span>
                            <span className="mt-0.5 block text-[13px] leading-relaxed">…{hit.before}<mark className="rounded bg-amber-300/70 px-0.5 text-inherit">{hit.match}</mark>{hit.after}…</span>
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

const SWATCH: Record<HighlightColor, string> = { yellow: "#f3cf55", green: "#86c98a", blue: "#7fb0f2", pink: "#f09ab8", orange: "#f3a866" };

export function NotesPanel({ vi, dark, items, label, onPick, onDelete }: {
    vi: boolean; dark: boolean; items: Annotation[]; label: (a: Annotation) => string;
    onPick: (a: Annotation) => void; onDelete: (a: Annotation) => void;
}) {
    const [tab, setTab] = useState<"highlight" | "bookmark">("highlight");
    const list = items.filter((a) => a.kind === tab).sort((a, b) => (a.range?.s ?? a.page ?? a.loc?.s ?? 0) - (b.range?.s ?? b.page ?? b.loc?.s ?? 0) || (a.range?.start ?? a.loc?.o ?? 0) - (b.range?.start ?? b.loc?.o ?? 0));
    const tabClass = (on: boolean) => `flex-1 rounded-lg px-3 py-1.5 text-[13px] font-semibold ${on ? (dark ? "bg-white/15" : "bg-white shadow-sm") : "opacity-70"}`;
    return (
        <div>
            <div className={`mx-5 mt-4 flex gap-1 rounded-xl p-1 ${dark ? "bg-white/5" : "bg-stone-200/60"}`}>
                <button type="button" className={tabClass(tab === "highlight")} aria-pressed={tab === "highlight"} onClick={() => setTab("highlight")}>{vi ? "Đánh dấu và ghi chú" : "Highlights and notes"}</button>
                <button type="button" className={tabClass(tab === "bookmark")} aria-pressed={tab === "bookmark"} onClick={() => setTab("bookmark")}>{vi ? "Dấu trang" : "Bookmarks"}</button>
            </div>
            {!list.length && <p className="px-5 py-8 text-center text-sm opacity-60">{tab === "highlight" ? (vi ? "Chọn một đoạn văn và tô sáng để lưu lại tại đây." : "Select text and highlight it to keep it here.") : (vi ? "Nhấn biểu tượng dấu trang ở thanh trên để đánh dấu trang đang đọc." : "Use the bookmark button in the top bar to mark a page.")}</p>}
            <ul className="py-2">
                {list.map((a) => (
                    <li key={a.id} className={`group flex items-start gap-3 px-5 py-3 ${dark ? "hover:bg-white/5" : "hover:bg-stone-200/40"}`}>
                        {a.kind === "highlight" ? <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ background: SWATCH[a.color ?? "yellow"] }} /> : <Bookmark className="mt-0.5 h-4 w-4 shrink-0 opacity-60" />}
                        <button type="button" onClick={() => onPick(a)} className="min-w-0 flex-1 text-left">
                            <span className="block truncate text-[11px] font-bold uppercase tracking-[0.08em] opacity-55">{label(a)}</span>
                            <span className="mt-0.5 line-clamp-3 block text-[13px] leading-relaxed">{a.kind === "highlight" ? `“${a.text}”` : a.label || a.text || (vi ? "Dấu trang" : "Bookmark")}</span>
                            {a.note && <span className={`mt-1.5 flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] leading-relaxed ${dark ? "bg-white/5" : "bg-amber-50"}`}><StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />{a.note}</span>}
                        </button>
                        <button type="button" onClick={() => onDelete(a)} aria-label={vi ? "Xóa" : "Delete"} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg opacity-50 hover:opacity-100 focus-visible:opacity-100"><Trash2 className="h-4 w-4" /></button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function AppearancePanel({ vi, dark, prefs, format, setPrefs, curlAvailable }: { vi: boolean; dark: boolean; prefs: ReaderPrefs; format: BookFormat; setPrefs: (p: ReaderPrefs) => void; curlAvailable: boolean }) {
    const set = <K extends keyof ReaderPrefs>(key: K, value: ReaderPrefs[K]) => setPrefs({ ...prefs, [key]: value });
    const flow = format !== "pdf";
    const group = (label: string, children: ReactNode) => (
        <div className={`border-b px-5 py-4 ${dark ? "border-white/10" : "border-stone-200/70"}`}>
            <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.12em] opacity-60">{label}</p>
            {children}
        </div>
    );
    const seg = (on: boolean) => `flex-1 rounded-lg px-2 py-2 text-[13px] font-semibold transition-colors ${on ? (dark ? "bg-white/15 text-white" : "bg-white text-stone-900 shadow-sm") : "opacity-75 hover:opacity-100"}`;
    const segWrap = `flex gap-1 rounded-xl p-1 ${dark ? "bg-white/5" : "bg-stone-200/60"}`;
    const themes: Array<[ReaderPrefs["theme"], string, string, string]> = [
        ["paper", vi ? "Giấy" : "Paper", "#f6efe1", "#2c261d"], ["white", vi ? "Trắng" : "White", "#fdfdfb", "#1c1c1a"],
        ["dark", vi ? "Tối" : "Dark", "#1e1f22", "#d9d5cc"], ["oled", "OLED", "#000000", "#bdb9b0"],
    ];
    return (
        <div>
            {group(vi ? "Nền trang" : "Page", (
                <div className="grid grid-cols-4 gap-2">
                    {themes.map(([id, label, bg, ink]) => (
                        <button key={id} type="button" aria-pressed={prefs.theme === id} onClick={() => set("theme", id)} className={`flex flex-col items-center gap-1.5 rounded-xl p-1.5 text-[12px] font-semibold ${prefs.theme === id ? "ring-2 ring-amber-600" : ""}`}>
                            <span className="grid h-11 w-full place-items-center rounded-lg border text-base font-bold" style={{ background: bg, color: ink, borderColor: "rgba(127,127,127,.3)" }}>Aa</span>{label}
                        </button>
                    ))}
                </div>
            ))}
            {flow && group(vi ? "Phông chữ" : "Typeface", (
                <div className={segWrap}>
                    {([["literata", "Literata"], ["publisher-serif", vi ? "Có chân" : "Serif"], ["sans", vi ? "Không chân" : "Sans"]] as Array<[ReaderPrefs["font"], string]>).map(([id, label]) => (
                        <button key={id} type="button" aria-pressed={prefs.font === id} className={seg(prefs.font === id)} onClick={() => set("font", id)}>{label}</button>
                    ))}
                </div>
            ))}
            {flow && group(vi ? "Cỡ chữ" : "Text size", (
                <div className="flex items-center gap-3">
                    <button type="button" aria-label={vi ? "Giảm cỡ chữ" : "Smaller"} onClick={() => set("fontSize", Math.max(13, prefs.fontSize - 1))} className={`grid h-10 w-10 place-items-center rounded-xl border ${dark ? "border-white/15" : "border-stone-300"}`}><Minus className="h-4 w-4" /></button>
                    <input type="range" min={13} max={34} step={1} value={prefs.fontSize} onChange={(e) => set("fontSize", Number(e.target.value))} aria-label={vi ? "Cỡ chữ" : "Text size"} className="flex-1 accent-amber-700" />
                    <button type="button" aria-label={vi ? "Tăng cỡ chữ" : "Larger"} onClick={() => set("fontSize", Math.min(34, prefs.fontSize + 1))} className={`grid h-10 w-10 place-items-center rounded-xl border ${dark ? "border-white/15" : "border-stone-300"}`}><Plus className="h-4 w-4" /></button>
                    <span className="w-8 text-right text-sm font-semibold tabular-nums">{prefs.fontSize}</span>
                </div>
            ))}
            {flow && group(vi ? "Giãn dòng" : "Line spacing", (
                <div className={segWrap}>
                    {([[1.35, vi ? "Hẹp" : "Tight"], [1.55, vi ? "Vừa" : "Normal"], [1.75, vi ? "Rộng" : "Relaxed"], [1.95, vi ? "Thoáng" : "Loose"]] as Array<[number, string]>).map(([v, label]) => (
                        <button key={v} type="button" aria-pressed={prefs.lineHeight === v} className={seg(prefs.lineHeight === v)} onClick={() => set("lineHeight", v)}>{label}</button>
                    ))}
                </div>
            ))}
            {flow && group(vi ? "Lề trang" : "Margins", (
                <div className={segWrap}>
                    {([["narrow", vi ? "Hẹp" : "Narrow"], ["normal", vi ? "Vừa" : "Normal"], ["wide", vi ? "Rộng" : "Wide"]] as Array<[ReaderPrefs["margin"], string]>).map(([id, label]) => (
                        <button key={id} type="button" aria-pressed={prefs.margin === id} className={seg(prefs.margin === id)} onClick={() => set("margin", id)}>{label}</button>
                    ))}
                </div>
            ))}
            {flow && group(vi ? "Căn chữ" : "Alignment", (
                <div className="space-y-2.5 text-[13px] font-medium">
                    <label className="flex items-center justify-between gap-3"><span>{vi ? "Căn đều hai bên" : "Justify text"}</span><input type="checkbox" checked={prefs.justify} onChange={(e) => set("justify", e.target.checked)} className="h-4 w-4 accent-amber-700" /></label>
                    <label className="flex items-center justify-between gap-3"><span>{vi ? "Ngắt từ bằng gạch nối" : "Hyphenation"}</span><input type="checkbox" checked={prefs.hyphenate} onChange={(e) => set("hyphenate", e.target.checked)} className="h-4 w-4 accent-amber-700" /></label>
                </div>
            ))}
            {!flow && group(vi ? "Thu phóng" : "Zoom", (
                <div className="space-y-2.5">
                    <div className={segWrap}>
                        <button type="button" aria-pressed={prefs.pdfZoom === "page"} className={seg(prefs.pdfZoom === "page")} onClick={() => set("pdfZoom", "page")}>{vi ? "Vừa trang" : "Fit page"}</button>
                        <button type="button" aria-pressed={prefs.pdfZoom === "width"} className={seg(prefs.pdfZoom === "width")} onClick={() => set("pdfZoom", "width")}>{vi ? "Vừa chiều ngang" : "Fit width"}</button>
                    </div>
                    <div className="flex items-center gap-3">
                        <button type="button" aria-label={vi ? "Thu nhỏ" : "Zoom out"} onClick={() => set("pdfZoom", Math.max(0.5, Math.round(((typeof prefs.pdfZoom === "number" ? prefs.pdfZoom : 1) - 0.1) * 10) / 10))} className={`grid h-10 w-10 place-items-center rounded-xl border ${dark ? "border-white/15" : "border-stone-300"}`}><Minus className="h-4 w-4" /></button>
                        <span className="flex-1 text-center text-sm font-semibold tabular-nums">{typeof prefs.pdfZoom === "number" ? `${Math.round(prefs.pdfZoom * 100)}%` : vi ? "Tự động" : "Auto"}</span>
                        <button type="button" aria-label={vi ? "Phóng to" : "Zoom in"} onClick={() => set("pdfZoom", Math.min(4, Math.round(((typeof prefs.pdfZoom === "number" ? prefs.pdfZoom : 1) + 0.1) * 10) / 10))} className={`grid h-10 w-10 place-items-center rounded-xl border ${dark ? "border-white/15" : "border-stone-300"}`}><Plus className="h-4 w-4" /></button>
                    </div>
                </div>
            ))}
            {group(vi ? "Bố cục" : "Layout", (
                <div className={segWrap}>
                    {([["auto", vi ? "Tự động" : "Auto"], ["single", vi ? "Một trang" : "One page"], ["spread", vi ? "Hai trang" : "Two pages"]] as Array<[ReaderPrefs["layout"], string]>).map(([id, label]) => (
                        <button key={id} type="button" aria-pressed={prefs.layout === id} className={seg(prefs.layout === id)} onClick={() => set("layout", id)}>{label}</button>
                    ))}
                </div>
            ))}
            {group(vi ? "Lật trang" : "Page turn", (
                <div className="space-y-2">
                    <div className={segWrap}>
                        {([["curl", vi ? "Như sách thật" : "Realistic"], ["instant", vi ? "Chuyển ngay" : "Instant"], ["scroll", vi ? "Cuộn dọc" : "Scroll"]] as Array<[ReaderPrefs["turn"], string]>).map(([id, label]) => (
                            <button key={id} type="button" aria-pressed={prefs.turn === id} className={seg(prefs.turn === id)} onClick={() => set("turn", id)}>{label}</button>
                        ))}
                    </div>
                    {!curlAvailable && prefs.turn === "curl" && <p className="text-xs opacity-60">{vi ? "Thiết bị đang bật giảm chuyển động hoặc tốc độ khung hình thấp — trang sẽ chuyển ngay." : "Reduced motion or a slow device — pages turn instantly."}</p>}
                </div>
            ))}
            <p className="px-5 py-4 text-xs leading-relaxed opacity-60">{vi ? "Màn hình LCD/OLED không thể trở thành giấy điện tử; các nền Giấy và OLED giúp giảm chói khi đọc lâu, hãy nghỉ mắt định kỳ." : "An LCD/OLED screen cannot become e-ink; Paper and OLED themes reduce glare for long sessions — rest your eyes regularly."}</p>
        </div>
    );
}
