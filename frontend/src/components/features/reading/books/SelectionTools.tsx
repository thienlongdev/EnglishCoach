"use client";

/**
 * Compact, secondary learning tools for a My Books selection. Selecting text only shows this toolbar (no request).
 * Each action runs on an explicit click: dictionary lookup (existing Reading dictionary), Google translation
 * (existing flow), AI contextual explanation (new shared contextual-translation path; sends the selection, its
 * sentence and a bounded context only), local highlight / note, Flashcard (existing authenticated endpoint).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookA, Check, Copy, Languages, Layers, Loader2, StickyNote, X } from "lucide-react";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { ReadingDictionaryCard } from "@/components/features/reading/ReadingDictionaryCard";
import { getNormalizedLexicalLookupTarget, isLexicalDictionaryTarget, lookupDictionary, type DictionaryLookupResult } from "@/services/dictionaryService";
import { createFlashcard, explainBookSelection, googleTranslate } from "@/services/readingBooksApi";
import { rangeRect, useAnchoredFloating } from "@/lib/ui/anchoredFloating";
import type { ContextTranslation } from "@/types/readingBooks";
import type { HighlightColor } from "./engine/types";

export interface ReaderSelection {
    text: string;
    /** Where the selection ended when it was made. */
    rect: DOMRect;
    sentence: string;
    context: string;
    /** The live range of the selected text: panels follow it through scrolling, reflow and page turns. */
    anchor?: Range;
}

const COLORS: Array<{ id: HighlightColor; bg: string; label: string }> = [
    { id: "yellow", bg: "#f3cf55", label: "Vàng" },
    { id: "green", bg: "#86c98a", label: "Xanh lá" },
    { id: "blue", bg: "#7fb0f2", label: "Xanh dương" },
    { id: "pink", bg: "#f09ab8", label: "Hồng" },
    { id: "orange", bg: "#f3a866", label: "Cam" },
];

const TYPE_LABEL: Record<string, [string, string]> = {
    IDIOM: ["Thành ngữ", "Idiom"],
    PHRASAL_VERB: ["Cụm động từ", "Phrasal verb"],
    COLLOCATION: ["Cụm từ cố định", "Collocation"],
    FIGURATIVE: ["Nghĩa bóng", "Figurative"],
    PHRASE: ["Cụm từ", "Phrase"],
    WORD: ["Từ", "Word"],
    SENTENCE: ["Câu", "Sentence"],
};

type Tool =
    | { kind: "dict"; word: string; status: "loading" | "success" | "not_found" | "error"; data: DictionaryLookupResult | null }
    | { kind: "translate"; status: "loading" | "success" | "error"; text?: string }
    | { kind: "ai"; status: "loading" | "success" | "error"; data?: ContextTranslation; error?: string }
    | { kind: "flashcard"; front: string; back: string; example: string; saving: boolean; filling: boolean; error?: string }
    | { kind: "note"; text: string };

/** The selection's position now (its live range), or where it was when no live range is known. */
function liveRect(sel: ReaderSelection): DOMRect | null {
    return sel.anchor ? rangeRect(sel.anchor) : sel.rect;
}

/** The engines report a selection again on every selection change (a focus move, a button press): same words, same sentence. */
function sameSelection(a: ReaderSelection, b: ReaderSelection) {
    return a.text === b.text && a.sentence === b.sentence;
}

/** Tools the learner types into: they stay open until their own buttons or Escape close them. */
const EDITORS = new Set<Tool["kind"]>(["flashcard", "note"]);

/**
 * A tool card. On desktop it is anchored to the live selection (below, else above; shifted inside the screen; its height
 * bounded by the room it has, content scrolling inside). A result card closes on a press outside it, on Escape or when
 * its text leaves the screen (scroll, page turn); an editor keeps its place and closes only on its buttons or Escape.
 */
function Card({ anchor, mobile, editor, children, onClose, label }: { anchor: ReaderSelection; mobile: boolean; editor: boolean; children: ReactNode; onClose: () => void; label: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useAnchoredFloating({ open: !mobile, floating: ref, anchor: () => liveRect(anchor), onLost: editor ? undefined : () => closeRef.current() });
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            closeRef.current();
        };
        const onDown = (e: PointerEvent) => {
            if (editor || !ref.current || e.composedPath().includes(ref.current)) return;
            closeRef.current();
        };
        window.addEventListener("keydown", onKey, true);
        document.addEventListener("pointerdown", onDown, true);
        return () => { window.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDown, true); };
    }, [editor]);
    if (mobile) {
        return (
            <div ref={ref} role="dialog" aria-label={label} className="fixed inset-x-0 bottom-0 z-[95] max-h-[72vh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-stone-200 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.35)] dark:border-white/10 dark:bg-[#17181c]">
                <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-stone-300 dark:bg-white/20" aria-hidden="true" />
                <button type="button" onClick={onClose} aria-label="Đóng" className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg text-stone-500 hover:bg-stone-100 dark:hover:bg-white/10"><X className="h-4 w-4" /></button>
                {children}
            </div>
        );
    }
    return (
        <div ref={ref} role="dialog" aria-label={label} style={{ width: "min(380px, calc(100vw - 16px))" }}
            className="fixed z-[95] overflow-y-auto overscroll-contain rounded-2xl border border-stone-200 bg-white p-4 text-left shadow-[0_18px_50px_-18px_rgba(0,0,0,0.45)] dark:border-white/10 dark:bg-[#17181c]">
            <button type="button" onClick={onClose} aria-label="Đóng" className="absolute right-2.5 top-2.5 grid h-7 w-7 place-items-center rounded-lg text-stone-500 hover:bg-stone-100 dark:hover:bg-white/10"><X className="h-4 w-4" /></button>
            {children}
        </div>
    );
}

export function SelectionTools({ vi, selection, mobile, bookTitle, bookAuthor, onHighlight, onDismiss, notify }: {
    vi: boolean;
    selection: ReaderSelection | null;
    mobile: boolean;
    bookTitle: string;
    bookAuthor: string;
    /** `sel` = the selection the tool was opened for (the live one may already be gone). */
    onHighlight: (color: HighlightColor, note: string | undefined, sel: ReaderSelection) => void;
    onDismiss: () => void;
    notify: (message: string) => void;
}) {
    const [tool, setTool] = useState<Tool | null>(null);
    const [anchor, setAnchor] = useState<ReaderSelection | null>(null);
    const aiCache = useRef(new Map<string, ContextTranslation>());
    const abort = useRef<AbortController | null>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const savingRef = useRef(false);

    // A NEW selection replaces the tools of the previous one. The same selection reported again (the engines report on
    // every selection change, e.g. when a card button is pressed) only refreshes the anchor: it must never reset an open
    // tool. An open editor (Flashcard, note) is never replaced by another selection. Clearing the selection keeps an
    // open card: the card holds everything it needs.
    useEffect(() => {
        if (selection) {
            if (anchor && sameSelection(selection, anchor)) { setAnchor(selection); return; }
            if (tool && EDITORS.has(tool.kind)) return;
            abort.current?.abort();
            setAnchor(selection);
            setTool(null);
        } else if (!tool) {
            setAnchor(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selection]);
    useEffect(() => () => abort.current?.abort(), []);
    const close = () => { abort.current?.abort(); setTool(null); setAnchor(null); onDismiss(); };
    useAnchoredFloating({ open: Boolean(anchor) && !tool, floating: barRef, anchor: () => (anchor ? liveRect(anchor) : null), onLost: () => close() });

    if (!anchor) return null;
    const text = anchor.text;
    const lexical = isLexicalDictionaryTarget(text);
    const short = text.length <= 300;


    const runDict = async () => {
        const word = getNormalizedLexicalLookupTarget(text);
        if (!word) return;
        setTool({ kind: "dict", word, status: "loading", data: null });
        try {
            const res = await lookupDictionary(word, {
                contextSentence: anchor.sentence,
                onSecondaryData: (updated) => setTool((t) => (t?.kind === "dict" && t.word === word ? { ...t, data: updated } : t)),
            });
            setTool((t) => (t?.kind === "dict" && t.word === word ? { ...t, status: res ? "success" : "not_found", data: res ?? null } : t));
        } catch {
            setTool((t) => (t?.kind === "dict" && t.word === word ? { ...t, status: "error" } : t));
        }
    };

    const runTranslate = async () => {
        abort.current?.abort();
        const controller = new AbortController();
        abort.current = controller;
        setTool({ kind: "translate", status: "loading" });
        try {
            const out = await googleTranslate(text, controller.signal);
            if (!controller.signal.aborted) setTool({ kind: "translate", status: "success", text: out });
        } catch {
            if (!controller.signal.aborted) setTool({ kind: "translate", status: "error" });
        }
    };

    const runAi = async () => {
        if (!short) return;
        const key = `${text.toLowerCase()}|${anchor.sentence.toLowerCase()}`;
        const cached = aiCache.current.get(key);
        if (cached) { setTool({ kind: "ai", status: "success", data: cached }); return; }
        abort.current?.abort();
        const controller = new AbortController();
        abort.current = controller;
        setTool({ kind: "ai", status: "loading" });
        try {
            const data = await explainBookSelection({ text, sentence: anchor.sentence, context: anchor.context, bookTitle, bookAuthor }, controller.signal);
            aiCache.current.set(key, data);
            if (!controller.signal.aborted) setTool({ kind: "ai", status: "success", data });
        } catch (error) {
            if (controller.signal.aborted) return;
            const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
            setTool({ kind: "ai", status: "error", error: message || (vi ? "Chưa giải nghĩa được lúc này. Vui lòng thử lại." : "Could not explain this right now. Please try again.") });
        }
    };

    const openFlashcard = async (back = "") => {
        const front = text.replace(/^["'“”‘’.,!?;:()[\]{}]+|["'“”‘’.,!?;:()[\]{}]+$/g, "").slice(0, 200);
        setTool({ kind: "flashcard", front, back, example: anchor.sentence.slice(0, 600), saving: false, filling: !back });
        if (back) return;
        try {
            const translated = await googleTranslate(front);
            setTool((t) => (t?.kind === "flashcard" && !t.back ? { ...t, back: translated, filling: false } : t));
        } catch {
            setTool((t) => (t?.kind === "flashcard" ? { ...t, filling: false } : t));
        }
    };

    const saveFlashcard = async () => {
        if (savingRef.current || tool?.kind !== "flashcard" || !tool.front.trim() || !tool.back.trim()) return;
        // one request at a time; a failed save keeps the editor and every field as typed
        savingRef.current = true;
        setTool((t) => (t?.kind === "flashcard" ? { ...t, saving: true, error: undefined } : t));
        try {
            await createFlashcard(tool.front.trim(), tool.back.trim(), tool.example.trim());
            notify(vi ? "Đã lưu vào Flashcard." : "Saved to Flashcards.");
            close();
        } catch (error) {
            const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
            setTool((t) => (t?.kind === "flashcard" ? { ...t, saving: false, error: message || (vi ? "Không lưu được Flashcard." : "Could not save the flashcard.") } : t));
        } finally {
            savingRef.current = false;
        }
    };

    const btn = "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold text-stone-100 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-40 cursor-pointer";

    return (
        <>
            {!tool && (
                <div ref={barRef} role="toolbar" aria-label={vi ? "Công cụ cho đoạn đã chọn" : "Selection tools"}
                    className="fixed z-[94] flex max-w-[calc(100vw-16px)] items-center gap-0.5 overflow-x-auto rounded-xl bg-[#26231e] p-1 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.6)] ring-1 ring-black/10 [scrollbar-width:none]"
                    onPointerDown={(e) => e.preventDefault()}>
                    {lexical && <button type="button" className={btn} onClick={() => void runDict()}><BookA className="h-4 w-4" aria-hidden="true" />{vi ? "Tra từ" : "Define"}</button>}
                    <button type="button" className={btn} onClick={() => void runTranslate()}><Languages className="h-4 w-4" aria-hidden="true" />{vi ? "Dịch" : "Translate"}</button>
                    <button type="button" className={btn} disabled={!short} onClick={() => void runAi()} title={short ? undefined : (vi ? "Chọn đoạn ngắn hơn (tối đa 300 ký tự)" : "Select a shorter passage (300 characters max)")}>
                        <BrandWhaleIcon size="xs" clean />{vi ? "Giải nghĩa" : "Explain"}
                    </button>
                    <button type="button" className={btn} onClick={async () => {
                        if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
                        window.dispatchEvent(new CustomEvent('echo:book-excerpt', { detail: anchor.text.slice(0, 600) }));
                        close();
                    }}><BrandWhaleIcon size="xs" clean />{vi ? "Hỏi Echo" : "Ask Echo"}</button>
                    <span className="mx-1 h-5 w-px bg-white/15" aria-hidden="true" />
                    {COLORS.map((c) => (
                        <button key={c.id} type="button" onClick={() => { onHighlight(c.id, undefined, anchor); close(); }} aria-label={`${vi ? "Tô sáng" : "Highlight"} ${c.label}`} className="grid h-9 w-7 shrink-0 place-items-center rounded-lg hover:bg-white/10 cursor-pointer">
                            <span className="h-4 w-4 rounded-full ring-2 ring-black/20" style={{ background: c.bg }} />
                        </button>
                    ))}
                    <span className="mx-1 h-5 w-px bg-white/15" aria-hidden="true" />
                    <button type="button" className={btn} onClick={() => setTool({ kind: "note", text: "" })}><StickyNote className="h-4 w-4" aria-hidden="true" />{vi ? "Ghi chú" : "Note"}</button>
                    <button type="button" className={btn} onClick={() => void openFlashcard()}><Layers className="h-4 w-4" aria-hidden="true" />Flashcard</button>
                    <button type="button" className={btn} aria-label={vi ? "Sao chép" : "Copy"} onClick={() => { void navigator.clipboard?.writeText(text).then(() => notify(vi ? "Đã sao chép." : "Copied.")).catch(() => undefined); close(); }}><Copy className="h-4 w-4" aria-hidden="true" /></button>
                </div>
            )}

            {tool?.kind === "dict" && (
                <Card anchor={anchor} mobile={mobile} editor={false} onClose={close} label={vi ? "Từ điển" : "Dictionary"}>
                    <ReadingDictionaryCard status={tool.status} data={tool.data} word={tool.word} onRetry={() => void runDict()}
                        onSpeak={(w) => { if (!("speechSynthesis" in window)) return; window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(w); u.lang = "en-US"; u.rate = 0.85; window.speechSynthesis.speak(u); }}
                        onAddFlashcard={(word, meaning, example) => setTool({ kind: "flashcard", front: word, back: meaning, example: example || anchor.sentence, saving: false, filling: false })} />
                </Card>
            )}

            {tool?.kind === "translate" && (
                <Card anchor={anchor} mobile={mobile} editor={false} onClose={close} label={vi ? "Bản dịch" : "Translation"}>
                    <p className="pr-8 text-[11px] font-bold uppercase tracking-[0.14em] text-stone-500">Google Translate</p>
                    <p className="mt-2 line-clamp-3 text-sm italic text-stone-500 dark:text-stone-400">“{text}”</p>
                    {tool.status === "loading" && <p className="mt-3 inline-flex items-center gap-2 text-sm text-stone-500"><Loader2 className="h-4 w-4 animate-spin" />{vi ? "Đang dịch…" : "Translating…"}</p>}
                    {tool.status === "success" && <p className="mt-3 text-[15px] leading-relaxed text-stone-900 dark:text-stone-100">{tool.text}</p>}
                    {tool.status === "error" && <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">{vi ? "Không thể dịch. Vui lòng thử lại." : "Could not translate. Please try again."}</p>}
                    <div className="mt-4 flex flex-wrap gap-2">
                        {short && <button type="button" onClick={() => void runAi()} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-bold text-stone-700 hover:bg-stone-50 dark:border-white/10 dark:text-stone-200 dark:hover:bg-white/5 cursor-pointer"><BrandWhaleIcon size="xs" clean />{vi ? "Giải nghĩa theo ngữ cảnh" : "Explain in context"}</button>}
                        {tool.status === "success" && <button type="button" onClick={() => void openFlashcard(tool.text)} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-bold text-stone-700 hover:bg-stone-50 dark:border-white/10 dark:text-stone-200 dark:hover:bg-white/5 cursor-pointer"><Layers className="h-3.5 w-3.5" />Flashcard</button>}
                    </div>
                </Card>
            )}

            {tool?.kind === "ai" && (
                <Card anchor={anchor} mobile={mobile} editor={false} onClose={close} label={vi ? "Giải nghĩa theo ngữ cảnh" : "Contextual explanation"}>
                    <p className="flex items-center gap-1.5 pr-8 text-[11px] font-bold uppercase tracking-[0.14em] text-stone-500"><BrandWhaleIcon size="xs" clean />{vi ? "Nghĩa trong ngữ cảnh" : "Meaning in context"}</p>
                    <p className="mt-2 text-base font-bold leading-snug text-stone-900 dark:text-stone-50">{text}</p>
                    {tool.status === "loading" && <p className="mt-3 inline-flex items-center gap-2 text-sm text-stone-500"><Loader2 className="h-4 w-4 animate-spin" />{vi ? "Đang phân tích ngữ cảnh…" : "Reading the context…"}</p>}
                    {tool.status === "error" && <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">{tool.error}</p>}
                    {tool.status === "success" && tool.data && (() => {
                        const d = tool.data;
                        const type = d.expressionType ? TYPE_LABEL[d.expressionType] : null;
                        return (
                            <div className="mt-2 space-y-3 text-sm">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {type && d.expressionType !== "WORD" && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900 dark:bg-amber-400/15 dark:text-amber-200">{vi ? type[0] : type[1]}</span>}
                                    {d.partOfSpeech && !(type && type.some((label) => label.toLowerCase() === d.partOfSpeech!.trim().toLowerCase())) && <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold text-stone-600 dark:bg-white/10 dark:text-stone-300">{d.partOfSpeech}</span>}
                                    {d.cefr && <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold text-stone-600 dark:bg-white/10 dark:text-stone-300">CEFR {d.cefr}</span>}
                                    {d.register && <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold text-stone-600 dark:bg-white/10 dark:text-stone-300">{d.register}</span>}
                                </div>
                                <p className="rounded-xl border-l-4 border-amber-500 bg-amber-50/80 px-3 py-2.5 text-[15px] font-semibold leading-relaxed text-stone-900 dark:bg-amber-400/10 dark:text-amber-50">{d.meaningInContext}</p>
                                {d.literalMeaning && <p className="text-[13px] text-stone-600 dark:text-stone-300"><span className="font-semibold">{vi ? "Nghĩa đen: " : "Literal: "}</span>{d.literalMeaning}</p>}
                                {d.explanation && <p className="text-[13px] leading-relaxed text-stone-600 dark:text-stone-300">{d.explanation}</p>}
                                {d.sentenceTranslation && (
                                    <div>
                                        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-stone-500">{vi ? "Cả câu" : "Whole sentence"}</p>
                                        <p className="mt-1 text-[13px] leading-relaxed text-stone-800 dark:text-stone-200">{d.sentenceTranslation}</p>
                                    </div>
                                )}
                                {(d.ambiguityNote || d.confidence === "LOW") && <p className="rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-white/5 dark:text-stone-300">{d.ambiguityNote || (vi ? "Ngữ cảnh chưa đủ rõ để chắc chắn — hãy đọc thêm câu xung quanh." : "The context is not clear enough to be certain.")}</p>}
                                <div className="flex flex-wrap gap-2 pt-1">
                                    <button type="button" onClick={() => void openFlashcard(d.meaningInContext)} className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-stone-800 dark:bg-amber-100 dark:text-stone-900 cursor-pointer"><Layers className="h-3.5 w-3.5" />{vi ? "Thêm vào Flashcard" : "Add to Flashcards"}</button>
                                    <button type="button" onClick={() => { onHighlight("yellow", `${d.meaningInContext}${d.explanation ? ` — ${d.explanation}` : ""}`, anchor); notify(vi ? "Đã lưu thành ghi chú." : "Saved as a note."); close(); }} className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-bold text-stone-700 hover:bg-stone-50 dark:border-white/10 dark:text-stone-200 dark:hover:bg-white/5 cursor-pointer"><StickyNote className="h-3.5 w-3.5" />{vi ? "Lưu thành ghi chú" : "Save as note"}</button>
                                </div>
                            </div>
                        );
                    })()}
                </Card>
            )}

            {tool?.kind === "note" && (
                <Card anchor={anchor} mobile={mobile} editor onClose={close} label={vi ? "Ghi chú" : "Note"}>
                    <p className="pr-8 text-[11px] font-bold uppercase tracking-[0.14em] text-stone-500">{vi ? "Ghi chú cho đoạn đã chọn" : "Note on the selection"}</p>
                    <p className="mt-2 line-clamp-3 text-sm italic text-stone-500 dark:text-stone-400">“{text}”</p>
                    <textarea autoFocus value={tool.text} onChange={(e) => setTool({ kind: "note", text: e.target.value.slice(0, 8000) })} rows={4} placeholder={vi ? "Suy nghĩ, câu hỏi, liên hệ…" : "Thoughts, questions, connections…"}
                        className="mt-3 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-100" />
                    <div className="mt-3 flex justify-end">
                        <button type="button" disabled={!tool.text.trim()} onClick={() => { onHighlight("yellow", tool.text.trim(), anchor); notify(vi ? "Đã lưu ghi chú." : "Note saved."); close(); }} className="inline-flex items-center gap-1.5 rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-40 dark:bg-amber-100 dark:text-stone-900 cursor-pointer"><Check className="h-4 w-4" />{vi ? "Lưu" : "Save"}</button>
                    </div>
                </Card>
            )}

            {tool?.kind === "flashcard" && (
                <Card anchor={anchor} mobile={mobile} editor onClose={close} label="Flashcard">
                    <p className="flex items-center gap-1.5 pr-8 text-[11px] font-bold uppercase tracking-[0.14em] text-stone-500"><Layers className="h-3.5 w-3.5" />{vi ? "Tạo Flashcard" : "New flashcard"}</p>
                    <label className="mt-3 block text-xs font-semibold text-stone-600 dark:text-stone-300">{vi ? "Mặt trước" : "Front"}
                        <input value={tool.front} onChange={(e) => { const v = e.target.value.slice(0, 200); setTool((t) => (t?.kind === "flashcard" ? { ...t, front: v } : t)); }} className="mt-1 h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm text-stone-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-100" />
                    </label>
                    <label className="mt-2 block text-xs font-semibold text-stone-600 dark:text-stone-300">{vi ? "Mặt sau" : "Back"}{tool.filling && <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin" />}
                        <textarea value={tool.back} onChange={(e) => { const v = e.target.value.slice(0, 1000); setTool((t) => (t?.kind === "flashcard" ? { ...t, back: v, filling: false } : t)); }} rows={2} className="mt-1 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-100" />
                    </label>
                    <label className="mt-2 block text-xs font-semibold text-stone-600 dark:text-stone-300">{vi ? "Câu ví dụ" : "Example"}
                        <textarea value={tool.example} onChange={(e) => { const v = e.target.value.slice(0, 600); setTool((t) => (t?.kind === "flashcard" ? { ...t, example: v } : t)); }} rows={2} className="mt-1 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-200" />
                    </label>
                    {tool.error && <p role="alert" className="mt-2 text-xs text-rose-700 dark:text-rose-300">{tool.error}</p>}
                    <div className="mt-3 flex justify-end gap-2">
                        <button type="button" onClick={close} disabled={tool.saving} className="rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-40 text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/10 cursor-pointer">{vi ? "Hủy" : "Cancel"}</button>
                        <button type="button" disabled={tool.saving || !tool.front.trim() || !tool.back.trim()} onClick={() => void saveFlashcard()} className="inline-flex items-center gap-1.5 rounded-xl bg-stone-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-40 dark:bg-amber-100 dark:text-stone-900 cursor-pointer">{tool.saving && <Loader2 className="h-4 w-4 animate-spin" />}{vi ? "Lưu Flashcard" : "Save flashcard"}</button>
                    </div>
                </Card>
            )}
        </>
    );
}
