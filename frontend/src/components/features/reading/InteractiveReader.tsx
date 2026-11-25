"use client";

import Link from "next/link";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import {
    ChevronLeft,
    Languages,
    Highlighter,
    BookOpen,
    Trash2,
    Mic,
    Volume2,
    VolumeX,
    Maximize2,
    Minimize2,
    PanelRightOpen,
    PanelRightClose,
    CheckCircle2,
    X,
    BookmarkCheck,
    Loader2,
    AlertCircle,
    Type,
} from "lucide-react";
import { CanonicalDocument, ReadingMaterial } from "./ReadingCard";
import { apiClient } from "@/services/api-client";
import { useLanguage } from "@/context/LanguageContext";
import {
    isLexicalDictionaryTarget,
    getNormalizedLexicalLookupTarget,
    lookupDictionary,
    DictionaryLookupResult,
} from "@/services/dictionaryService";
import { ReadingDictionaryCard } from "./ReadingDictionaryCard";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { savedReaderMarkup } from "@/lib/reading/saved-reader-markup";
import { completeReading, openReadingSession } from "@/services/readingApi";
import { mutate as mutateCache } from "swr";
import { LEARNING_PATH_TODAY_KEY } from "@/hooks/useLearningPath";
import { rangeRect, useAnchoredFloating, visibleBox } from "@/lib/ui/anchoredFloating";
import glass from "./glass/readingGlass.module.css";
import { ReadingCover, topicFamily } from "./glass/ReadingCover";
import { echoSrc } from '@/lib/brand/echoCharacters';
import {
    clearEchoWorkspaceContext,
    dispatchEchoModuleReady,
    publishEchoWorkspaceContext,
} from '@/lib/echo/contextBridge';
import dynamic from "next/dynamic";

// Echo AI Card Studio (Echo Memory Tides 2.0): loaded only when the learner opens it from a selection.
const CardStudio = dynamic(() => import("@/components/features/flashcard/tides/CardStudio"), { ssr: false });

export interface CollocationItem {
    phrase: string;
    meaning: string;
}

export interface SynonymItem {
    word: string;
    nuance: string;
}

export interface ContextualVocabularyItem {
    id?: number;
    userId?: number;
    readingMaterialId: number;
    selectedText: string;
    text?: string;
    lemma?: string;
    pos?: string;
    ipa?: string;
    cefr?: string;
    frequency?: string;
    meaningInContext: string;
    nativeExplanation?: string;
    sentence: string;
    collocations?: CollocationItem[];
    synonyms?: SynonymItem[];
    grammarNote?: string;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Normalizes API response so both `selectedText` and `text` are reliably populated strings.
 * Ensures arrays and nested objects are defined to avoid any runtime undefined errors.
 */
export function normalizeContextualItem(raw: any, fallbackText: string = ""): ContextualVocabularyItem {
    if (!raw) {
        return {
            readingMaterialId: 0,
            selectedText: fallbackText || "",
            text: fallbackText || "",
            meaningInContext: "",
            sentence: "",
            collocations: [],
            synonyms: [],
        };
    }
    const resolvedText = (raw.selectedText || raw.text || fallbackText || "").toString().trim();
    return {
        ...raw,
        id: raw.id,
        readingMaterialId: raw.readingMaterialId,
        selectedText: resolvedText,
        text: resolvedText,
        lemma: raw.lemma || "",
        pos: raw.pos || "",
        ipa: raw.ipa || "",
        cefr: raw.cefr || "B2",
        frequency: raw.frequency || "",
        meaningInContext: raw.meaningInContext || "",
        nativeExplanation: raw.nativeExplanation || "",
        sentence: raw.sentence || "",
        collocations: Array.isArray(raw.collocations) ? raw.collocations : [],
        synonyms: Array.isArray(raw.synonyms) ? raw.synonyms : [],
        grammarNote: raw.grammarNote || "",
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
    };
}

interface InteractiveReaderProps {
    material: ReadingMaterial;
    onBack: () => void;
}

function DocumentRepresentation({ document, locale }: { document: CanonicalDocument; locale: string }) {
    return (
        <div className="space-y-6" aria-label="Document representation">
            {document.pages.map((page) => (
                <section key={page.pageNumber} aria-label={`${locale === "vi" ? "Trang" : "Page"} ${page.pageNumber}`} className="relative mx-auto w-full max-w-3xl overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm dark:border-slate-700" style={{ aspectRatio: `${page.width} / ${page.height}`, containerType: "inline-size" }}>
                    {page.sourceImage?.startsWith("data:image/jpeg;base64,") && <img src={page.sourceImage} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-fill" draggable={false} />}
                    {page.blocks.flatMap((block) => block.rows?.flatMap(row => row.cells) ?? (block.children?.length ? block.children : [block])).map((line, index) => (
                        <div key={index} className={`absolute overflow-hidden whitespace-pre-wrap select-text selection:bg-indigo-300/60 ${page.sourceImage ? "text-transparent" : "text-slate-900"}`} style={{ left: `${line.bbox.xNorm * 100}%`, top: `${line.bbox.yNorm * 100}%`, width: `${line.bbox.widthNorm * 100}%`, height: `${line.bbox.heightNorm * 100}%`, fontSize: `${line.bbox.height / page.width * 80}cqw`, lineHeight: 1 }}>
                            {line.text}
                        </div>
                    ))}
                </section>
            ))}
        </div>
    );
}

const HIGHLIGHT_COLORS = [
    { name: "Vàng", colorClass: "bg-yellow-200 dark:bg-yellow-500/40", textClass: "text-yellow-400" },
    { name: "Xanh lá", colorClass: "bg-green-200 dark:bg-emerald-500/40", textClass: "text-emerald-400" },
    { name: "Xanh dương", colorClass: "bg-blue-200 dark:bg-sky-500/40", textClass: "text-sky-400" },
    { name: "Hồng", colorClass: "bg-pink-200 dark:bg-rose-500/40", textClass: "text-pink-400" },
];

/**
 * Extracts the real enclosing sentence from the actual Reading DOM content around a range.
 * Supports single words, phrasal verbs, idioms, and multi-word phrases.
 */
export function extractSurroundingSentence(range: Range, container: HTMLElement): string {
    const selectedText = range.toString().trim();
    if (!selectedText || !container || !container.contains(range.commonAncestorContainer)) {
        return selectedText;
    }

    try {
        // Find closest block-level parent or use container
        let blockEl: Node | null = range.commonAncestorContainer;
        while (blockEl && blockEl !== container && blockEl.parentNode !== container) {
            const parentNode: Node | null = blockEl.parentNode;
            if (!parentNode) break;
            const tag = (parentNode as HTMLElement).tagName;
            if (tag === "P" || tag === "DIV" || tag === "ARTICLE" || tag === "SECTION" || tag === "LI" || tag === "BLOCKQUOTE") {
                blockEl = parentNode;
                break;
            }
            blockEl = parentNode;
        }
        const rootBlock = (blockEl && blockEl.nodeType === Node.ELEMENT_NODE ? blockEl : container) as HTMLElement;

        // Build pre and post ranges
        const preRange = document.createRange();
        preRange.selectNodeContents(rootBlock);
        preRange.setEnd(range.startContainer, range.startOffset);
        const preText = preRange.toString();

        const postRange = document.createRange();
        postRange.selectNodeContents(rootBlock);
        postRange.setStart(range.endContainer, range.endOffset);
        const postText = postRange.toString();

        const fullBlockText = preText + range.toString() + postText;
        const startIndex = preText.length;
        const endIndex = startIndex + range.toString().length;

        // Find boundary before
        let sentenceStart = 0;
        for (let i = startIndex - 1; i >= 0; i--) {
            const ch = fullBlockText[i];
            if (ch === '\n') {
                sentenceStart = i + 1;
                break;
            }
            if (ch === '.' || ch === '!' || ch === '?' || ch === ';' || ch === ':') {
                const nextChar = i + 1 < fullBlockText.length ? fullBlockText[i + 1] : '';
                if (nextChar === ' ' || nextChar === '\n' || nextChar === '\t' || nextChar === '"' || nextChar === '”') {
                    sentenceStart = i + 1;
                    break;
                }
            }
        }

        // Find boundary after
        let sentenceEnd = fullBlockText.length;
        for (let i = endIndex; i < fullBlockText.length; i++) {
            const ch = fullBlockText[i];
            if (ch === '\n') {
                sentenceEnd = i;
                break;
            }
            if (ch === '.' || ch === '!' || ch === '?' || ch === ';' || ch === ':') {
                const nextChar = i + 1 < fullBlockText.length ? fullBlockText[i + 1] : '';
                if (nextChar === '' || nextChar === ' ' || nextChar === '\n' || nextChar === '\t' || nextChar === '"' || nextChar === '”') {
                    sentenceEnd = i + 1;
                    if (nextChar === '"' || nextChar === '”') {
                        sentenceEnd = i + 2;
                    }
                    break;
                }
            }
        }

        const extracted = fullBlockText.slice(sentenceStart, sentenceEnd).trim().replace(/\s+/g, " ");
        if (extracted && extracted.length >= selectedText.length) {
            return extracted;
        }
    } catch (e) {
        console.warn("Error extracting surrounding sentence:", e);
    }

    return selectedText;
}

/**
 * Mode detector: Differentiates single word/phrase selection (Mode A)
 * from sentence/paragraph selection (Mode B).
 */
export function isPassageSelection(text: string): boolean {
    if (!text) return false;
    const trimmed = text.trim();
    // 1. Explicit line breaks signify multi-line or paragraph selection
    if (trimmed.includes("\n")) return true;

    // 2. Contains internal sentence terminator followed by a capitalized word or quote
    const sentenceBoundaryMatches = trimmed.match(/[.!?]["'”’]?\s+[A-Z0-9"“‘]/g);
    if (sentenceBoundaryMatches && sentenceBoundaryMatches.length >= 1) {
        return true;
    }

    // 3. Length threshold: > 14 words indicates a full passage or long clause
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length > 14) {
        return true;
    }

    return false;
}

export function InteractiveReader({ material, onBack }: InteractiveReaderProps) {
    const { locale } = useLanguage();
    const router = useRouter();
    const contentRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    // Reading display state
    const [fontSize, setFontSize] = useState<number>(18);
    const [fontFamily, setFontFamily] = useState("Georgia");
    const [lineHeight, setLineHeight] = useState(1.75);
    const [letterSpacing, setLetterSpacing] = useState(0);
    const [readingWidth, setReadingWidth] = useState("comfortable");
    const [isAppearanceOpen, setIsAppearanceOpen] = useState(false);
    const [viewMode, setViewMode] = useState<"reading" | "document">("reading");
    const [appearanceLoaded, setAppearanceLoaded] = useState(false);
    const appearanceRef = useRef<HTMLDivElement>(null);
    const [isDistractionFree, setIsDistractionFree] = useState<boolean>(false);
    const [isContextPanelOpen, setIsContextPanelOpen] = useState<boolean>(false);
    const [scrollProgress, setScrollProgress] = useState<number>(0);
    const [isCompleted, setIsCompleted] = useState<boolean>(false);
    const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);

    // Contextual Explanation state
    const [activeExplanation, setActiveExplanation] = useState<ContextualVocabularyItem | null>(null);
    const [isExplaining, setIsExplaining] = useState<boolean>(false);
    const [explainError, setExplainError] = useState<string | null>(null);

    // Persistent Vocabulary History state (scoped to material.id)
    const [historyList, setHistoryList] = useState<ContextualVocabularyItem[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);

    // Selection & Floating Toolbar state
    const toolbarRef = useRef<HTMLDivElement>(null);
    const contextPanelRef = useRef<HTMLElement>(null);
    type ReadingToolbarTool = null | "dictionary" | "translation" | "context_ai";
    const [activeTool, setActiveTool] = useState<ReadingToolbarTool>(null);
    const [selection, setSelection] = useState({ text: "", top: 0, left: 0, show: false });
    // The live range of the current selection: the floating toolbar / dictionary card is placed from it every frame,
    // so it stays tied to the selected words while the reading column scrolls (it is not a window-fixed position).
    const selectionRangeRef = useRef<Range | null>(null);
    const [lastExtractedContext, setLastExtractedContext] = useState<{ text: string; sentence: string }>({
        text: "",
        sentence: "",
    });
    const [translation, setTranslation] = useState<{
        loading: boolean;
        type: "dict" | "text" | null;
        state: "idle" | "loading" | "success" | "not_found" | "error";
        data: any;
        targetWord?: string;
    }>({
        loading: false,
        type: null,
        state: "idle",
        data: null,
    });
    const [toast, setToast] = useState<string | null>(null);
    // the passage handed to Echo AI Card Studio (an explicit click; the reading position and selection tools are untouched)
    const [studioText, setStudioText] = useState<string | null>(null);
    const [flashcardDraft, setFlashcardDraft] = useState<{
        isOpen: boolean;
        front: string;
        back: string;
        example?: string;
        isLoadingBack: boolean;
        saving?: boolean;
        error?: string;
    }>({
        isOpen: false,
        front: "",
        back: "",
        example: "",
        isLoadingBack: false,
    });
    const flashcardSavingRef = useRef(false);
    const flashcardBackdropDown = useRef(false);
    const [activeHighlightColor, setActiveHighlightColor] = useState("bg-yellow-200 dark:bg-yellow-500/40");
    const [highlightCount, setHighlightCount] = useState<number>(0);

    // Outside-click & Escape handler: 1 pointerdown outside immediately dismisses the floating toolbar
    useEffect(() => {
        if (!selection.show) return;

        const handlePointerDown = (e: PointerEvent) => {
            const target = e.target as Node | null;
            const path = typeof e.composedPath === "function" ? e.composedPath() : [];

            // 1. If interaction is inside the floating toolbar or its popup/card, do not dismiss
            if (
                toolbarRef.current &&
                (toolbarRef.current.contains(target) || (target && path.includes(toolbarRef.current)))
            ) {
                return;
            }

            // 2. If interaction is inside the AI contextual slide-over panel, do not dismiss
            if (
                contextPanelRef.current &&
                (contextPanelRef.current.contains(target) || (target && path.includes(contextPanelRef.current)))
            ) {
                return;
            }

            // 3. Single click/pointerdown outside immediately closes the floating toolbar
            setSelection({ text: "", top: 0, left: 0, show: false });
            setTranslation({ loading: false, type: null, state: "idle", data: null });
            setActiveTool(null);

            // 4. Immediately collapse native selection to guarantee 1-click dismissal on text
            window.getSelection()?.removeAllRanges();
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setSelection({ text: "", top: 0, left: 0, show: false });
                setTranslation({ loading: false, type: null, state: "idle", data: null });
                setActiveTool(null);
                window.getSelection()?.removeAllRanges();
            }
        };

        document.addEventListener("pointerdown", handlePointerDown, true);
        document.addEventListener("keydown", handleKeyDown, true);

        return () => {
            document.removeEventListener("pointerdown", handlePointerDown, true);
            document.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [selection.show]);

    const dismissSelectionTools = useCallback(() => {
        setSelection({ text: "", top: 0, left: 0, show: false });
        setTranslation({ loading: false, type: null, state: "idle", data: null });
        setActiveTool(null);
        selectionRangeRef.current = null;
    }, []);

    // Below the selection when it fits, else above; shifted inside the reading column; height bounded by the room on
    // that side (the card scrolls inside). Scrolling the selection out of the column dismisses the toolbar.
    useAnchoredFloating({
        open: selection.show,
        floating: toolbarRef,
        anchor: () => rangeRect(selectionRangeRef.current),
        bounds: () => visibleBox(scrollContainerRef.current),
        measure: (el) => Array.from(el.children).reduce((sum, child) => sum + (child as HTMLElement).scrollHeight, 0),
        onLost: dismissSelectionTools,
    });

    // Flashcard dialog: Escape closes it (it never depends on the selection or the toolbar that opened it).
    useEffect(() => {
        if (!flashcardDraft.isOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !flashcardSavingRef.current) setFlashcardDraft((prev) => ({ ...prev, isOpen: false })); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [flashcardDraft.isOpen]);

    // Concurrency & session cache refs
    const activeAbortControllerRef = useRef<AbortController | null>(null);
    const activeRequestIdRef = useRef<number>(0);
    const sessionCacheRef = useRef<Map<string, ContextualVocabularyItem>>(new Map());

    const storageKey = `ec_highlights_${material.id}`;
    const progressKey = `ec_reading_progress_${material.id}`;
    const [completing, setCompleting] = useState(false);
    const appearanceKey = "reading.appearance.v1";

    useEffect(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(appearanceKey) || "null");
            if (saved && typeof saved === "object") {
                if (Number.isFinite(saved.fontSize)) setFontSize(Math.max(15, Math.min(28, saved.fontSize)));
                if (["Georgia", "Arial", "Verdana", "Times New Roman"].includes(saved.fontFamily)) setFontFamily(saved.fontFamily);
                if (Number.isFinite(saved.lineHeight)) setLineHeight(Math.max(1.4, Math.min(2.2, saved.lineHeight)));
                if (Number.isFinite(saved.letterSpacing)) setLetterSpacing(Math.max(-0.02, Math.min(0.12, saved.letterSpacing)));
                if (["narrow", "comfortable", "wide"].includes(saved.readingWidth)) setReadingWidth(saved.readingWidth);
            }
        } catch { /* malformed preferences use defaults */ }
        setAppearanceLoaded(true);
    }, []);

    useEffect(() => {
        if (appearanceLoaded) {
            try { localStorage.setItem(appearanceKey, JSON.stringify({ fontSize, fontFamily, lineHeight, letterSpacing, readingWidth })); }
            catch { /* preferences still work when browser storage is unavailable */ }
        }
    }, [appearanceLoaded, fontSize, fontFamily, lineHeight, letterSpacing, readingWidth]);

    useEffect(() => {
        const onReadingIntent = (event: Event) => {
            const d = (event as CustomEvent<{ fontSize?: number; fontDelta?: number; width?: "narrow" | "comfortable" | "wide" }>).detail;
            if (!d) return;
            if (typeof d.fontSize === "number" && Number.isFinite(d.fontSize)) {
                setFontSize(Math.max(15, Math.min(28, Math.round(d.fontSize))));
            } else if (typeof d.fontDelta === "number" && Number.isFinite(d.fontDelta)) {
                setFontSize((prev) => Math.max(15, Math.min(28, prev + Math.round(d.fontDelta!))));
            }
            if (d.width === "narrow" || d.width === "comfortable" || d.width === "wide") {
                setReadingWidth(d.width);
            }
        };
        window.addEventListener("ec:reading:intent", onReadingIntent);
        dispatchEchoModuleReady("reading", { materialId: material.id });
        return () => window.removeEventListener("ec:reading:intent", onReadingIntent);
    }, [material.id]);

    useEffect(() => {
        const textBody = material.contentText || material.canonicalDocument?.plainText || "";
        const contentLen = textBody.length;
        const anchorChar = Math.max(0, Math.round((scrollProgress / 100) * contentLen));
        const timer = setTimeout(() => {
            publishEchoWorkspaceContext({
                source: "interactive-reader",
                kind: "READING_MATERIAL",
                id: material.id,
                viewportAnchorChar: anchorChar,
            });
        }, 300);
        return () => clearTimeout(timer);
    }, [material.id, material.contentText, material.canonicalDocument, scrollProgress]);

    useEffect(() => {
        publishEchoWorkspaceContext({
            source: "interactive-reader",
            kind: "READING_MATERIAL",
            id: material.id,
            viewportAnchorChar: 0,
        });
        return () => clearEchoWorkspaceContext("interactive-reader");
    }, [material.id]);

    useEffect(() => {
        if (!isAppearanceOpen) return;
        const close = (event: PointerEvent) => { if (!appearanceRef.current?.contains(event.target as Node)) setIsAppearanceOpen(false); };
        const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setIsAppearanceOpen(false); };
        document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
        return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
    }, [isAppearanceOpen]);

    const resetAppearance = () => {
        setFontSize(18); setFontFamily("Georgia"); setLineHeight(1.75); setLetterSpacing(0); setReadingWidth("comfortable");
    };

    // Update highlight counter
    const updateHighlightCount = useCallback(() => {
        if (!contentRef.current) return;
        const spans = contentRef.current.querySelectorAll("span.selection-highlight");
        setHighlightCount(spans.length);
    }, []);

    const saveToLocalStorage = useCallback(() => {
        if (contentRef.current) {
            localStorage.setItem(storageKey, contentRef.current.innerHTML);
            updateHighlightCount();
        }
    }, [storageKey, updateHighlightCount]);

    // Restore saved highlights and progress on mount
    useEffect(() => {
        if (!contentRef.current) return;
        const savedHtml = localStorage.getItem(storageKey);
        if (savedHtml) {
            contentRef.current.replaceChildren(savedReaderMarkup(savedHtml));
        } else if (material.canonicalDocument?.pages?.length) {
            const fragment = document.createDocumentFragment();
            for (const page of material.canonicalDocument.pages) {
                for (const block of page.blocks) {
                    if (block.type === "table" && block.rows?.length) {
                        const wrapper = document.createElement("div");
                        wrapper.className = "overflow-x-auto";
                        const table = document.createElement("table");
                        table.className = "w-full border-collapse text-left";
                        const body = document.createElement("tbody");
                        for (const row of block.rows) {
                            const tr = document.createElement("tr");
                            for (const cell of row.cells) {
                                const td = document.createElement("td");
                                td.textContent = cell.text;
                                td.className = "border border-stone-300 p-2 dark:border-slate-600 align-top";
                                tr.append(td);
                            }
                            body.append(tr);
                        }
                        table.append(body); wrapper.append(table); fragment.append(wrapper);
                    } else {
                        const paragraph = document.createElement(block.type === "heading" ? "h2" : "p");
                        paragraph.textContent = block.text;
                        if (block.type === "heading") paragraph.className = "font-bold";
                        fragment.append(paragraph);
                    }
                }
            }
            contentRef.current.replaceChildren(fragment);
        } else {
            contentRef.current.textContent = material.contentText || "Không tìm thấy nội dung cho tài liệu này.";
        }
        updateHighlightCount();

        const savedProgress = localStorage.getItem(progressKey);
        if (savedProgress) {
            setScrollProgress(Number(savedProgress));
        }
    }, [material.id, material.contentText, material.canonicalDocument, storageKey, progressKey, updateHighlightCount]);

    // Completion is a server fact: opening the reader records the start of this reading (server time) and returns
    // whether the material is already read. A browser flag never marks a reading as completed.
    useEffect(() => {
        let live = true;
        setIsCompleted(false);
        openReadingSession(material.id)
            .then((state) => { if (live && state.completed) { setIsCompleted(true); setScrollProgress(100); } })
            .catch(() => undefined);
        return () => { live = false; };
    }, [material.id]);

    // Fetch persistent contextual vocabulary history for this Reading material
    useEffect(() => {
        let isSubscribed = true;
        setIsLoadingHistory(true);
        apiClient
            .get<any[]>(`/reading/materials/${material.id}/vocabulary-history`)
            .then((res) => {
                if (isSubscribed) {
                    const rawList = Array.isArray(res.data) ? res.data : [];
                    setHistoryList(rawList.map((item) => normalizeContextualItem(item)));
                }
            })
            .catch((err) => {
                console.error("Failed to fetch vocabulary history for reading:", err);
            })
            .finally(() => {
                if (isSubscribed) {
                    setIsLoadingHistory(false);
                }
            });

        return () => {
            isSubscribed = false;
        };
    }, [material.id]);

    // Track scroll progress
    const handleScroll = () => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const totalHeight = el.scrollHeight - el.clientHeight;
        if (totalHeight <= 0) {
            setScrollProgress(100);
            return;
        }
        const currentProgress = Math.min(100, Math.max(0, Math.round((el.scrollTop / totalHeight) * 100)));
        setScrollProgress(currentProgress);
        localStorage.setItem(progressKey, currentProgress.toString());
    };

    // Text-to-speech audio reader
    const toggleSpeechSynthesis = () => {
        if (!("speechSynthesis" in window)) {
            setToast(locale === 'vi' ? "Trình duyệt không hỗ trợ phát âm thanh." : "Browser does not support audio speech synthesis.");
            setTimeout(() => setToast(null), 3000);
            return;
        }

        if (isPlayingAudio) {
            window.speechSynthesis.cancel();
            setIsPlayingAudio(false);
        } else {
            window.speechSynthesis.cancel();
            const textToRead = material.contentText || material.title;
            const utterance = new SpeechSynthesisUtterance(textToRead);
            utterance.lang = "en-US";
            utterance.rate = 0.95;
            utterance.onend = () => setIsPlayingAudio(false);
            utterance.onerror = () => setIsPlayingAudio(false);
            window.speechSynthesis.speak(utterance);
            setIsPlayingAudio(true);
        }
    };

    // Pronounce single word in Context Panel
    const speakWord = (word: string) => {
        if (!("speechSynthesis" in window)) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(word);
        utterance.lang = "en-US";
        utterance.rate = 0.85;
        window.speechSynthesis.speak(utterance);
    };

    // Cleanup audio on unmount
    useEffect(() => {
        return () => {
            if ("speechSynthesis" in window) {
                window.speechSynthesis.cancel();
            }
        };
    }, []);

    const getPenIconColor = (colorClass: string) => {
        const found = HIGHLIGHT_COLORS.find((c) => c.colorClass === colorClass);
        return found ? found.textClass : "text-yellow-400";
    };

    const applyHighlight = (colorClass: string) => {
        const currentSelection = window.getSelection();
        if (!currentSelection || currentSelection.rangeCount === 0) return;

        const range = currentSelection.getRangeAt(0);
        if (range.collapsed) return;

        if (contentRef.current && !contentRef.current.contains(range.commonAncestorContainer)) return;

        try {
            const span = document.createElement("span");
            span.className = `${colorClass} text-slate-900 dark:text-slate-100 rounded px-1 selection-highlight font-medium cursor-pointer transition-colors`;
            const fragment = range.extractContents();
            span.appendChild(fragment);
            range.insertNode(span);

            currentSelection.removeAllRanges();
            setSelection({ text: "", top: 0, left: 0, show: false });
            saveToLocalStorage();
        } catch (err) {
            console.error("Failed to apply highlight:", err);
        }
    };

    const handleColorSelect = (e: React.MouseEvent, colorClass: string) => {
        e.stopPropagation();
        setActiveHighlightColor(colorClass);
        applyHighlight(colorClass);
    };

    const handleRemoveHighlight = (e: React.MouseEvent) => {
        e.stopPropagation();
        const currentSelection = window.getSelection();
        if (!currentSelection || currentSelection.rangeCount === 0) return;

        const range = currentSelection.getRangeAt(0);

        const unwrapNode = (node: HTMLElement) => {
            const parent = node.parentNode;
            if (!parent) return;
            while (node.firstChild) {
                parent.insertBefore(node.firstChild, node);
            }
            parent.removeChild(node);
            parent.normalize();
        };

        const isHighlightSpan = (el: HTMLElement | null): boolean => {
            if (!el || el.tagName !== "SPAN") return false;
            return (
                el.classList.contains("selection-highlight") ||
                el.className.includes("bg-yellow-") ||
                el.className.includes("bg-green-") ||
                el.className.includes("bg-blue-") ||
                el.className.includes("bg-pink-") ||
                el.className.includes("bg-emerald-")
            );
        };

        let startContainer: Node | null = range.startContainer;
        if (startContainer.nodeType === Node.TEXT_NODE) {
            startContainer = startContainer.parentNode;
        }

        let currentEl = startContainer as HTMLElement | null;
        let foundDirectParent = false;
        while (currentEl && currentEl !== document.body) {
            if (isHighlightSpan(currentEl)) {
                unwrapNode(currentEl);
                foundDirectParent = true;
                break;
            }
            currentEl = currentEl.parentElement;
        }

        if (!foundDirectParent) {
            const ancestor = (
                range.commonAncestorContainer.nodeType === Node.TEXT_NODE
                    ? range.commonAncestorContainer.parentNode
                    : range.commonAncestorContainer
            ) as HTMLElement | null;

            if (ancestor) {
                if (isHighlightSpan(ancestor)) {
                    unwrapNode(ancestor);
                } else if (ancestor.querySelectorAll) {
                    const candidateSpans = ancestor.querySelectorAll("span");
                    candidateSpans.forEach((span) => {
                        if (isHighlightSpan(span) && currentSelection.containsNode(span, true)) {
                            unwrapNode(span);
                        }
                    });
                }
            }
        }

        currentSelection.removeAllRanges();
        setSelection({ text: "", top: 0, left: 0, show: false });
        saveToLocalStorage();
    };

    const handleClearAllHighlights = () => {
        if (!contentRef.current) return;

        const isHighlightSpan = (el: HTMLElement): boolean => {
            return (
                el.classList.contains("selection-highlight") ||
                el.className.includes("bg-yellow-") ||
                el.className.includes("bg-green-") ||
                el.className.includes("bg-blue-") ||
                el.className.includes("bg-pink-") ||
                el.className.includes("bg-emerald-")
            );
        };

        const spans = contentRef.current.querySelectorAll("span");
        let removedCount = 0;
        spans.forEach((span) => {
            if (isHighlightSpan(span)) {
                const parent = span.parentNode;
                if (parent) {
                    while (span.firstChild) {
                        parent.insertBefore(span.firstChild, span);
                    }
                    parent.removeChild(span);
                    removedCount++;
                }
            }
        });

        contentRef.current.normalize();
        localStorage.removeItem(storageKey);
        setHighlightCount(0);
        setToast(removedCount > 0 ? "Đã xóa toàn bộ highlights!" : "Không có highlight nào để xóa.");
        setTimeout(() => setToast(null), 3000);
    };

    /**
     * Trigger Contextual Explanation via AI endpoint POST /api/v1/reading/explain-context
     * Automatically saves result to persistent history upon success.
     */
    const triggerContextualExplain = async (cleanText: string, rawSentence: string) => {
        if (!cleanText || !cleanText.trim()) return;

        const trimmedText = cleanText.trim();
        const trimmedSentence = (rawSentence && rawSentence.trim()) || trimmedText;

        // Always ensure right panel is opened
        setIsContextPanelOpen(true);
        setExplainError(null);

        // 1. Check in-memory session cache
        const cacheKey = `${material.id}::${trimmedText.toLowerCase()}::${trimmedSentence.toLowerCase()}`;
        if (sessionCacheRef.current.has(cacheKey)) {
            setActiveExplanation(sessionCacheRef.current.get(cacheKey)!);
            setIsExplaining(false);
            return;
        }

        // 2. Check if already in history list for this material
        const existing = historyList.find((h) => {
            const hText = (h.selectedText || h.text || "").toLowerCase();
            return hText === trimmedText.toLowerCase() && (h.sentence === trimmedSentence || !trimmedSentence);
        });
        if (existing) {
            setActiveExplanation(existing);
            sessionCacheRef.current.set(cacheKey, existing);
            setIsExplaining(false);
            return;
        }

        // 3. Abort prior in-flight request to avoid race condition / stale response overwrite
        if (activeAbortControllerRef.current) {
            activeAbortControllerRef.current.abort();
        }
        const controller = new AbortController();
        activeAbortControllerRef.current = controller;
        const currentReqId = ++activeRequestIdRef.current;

        setIsExplaining(true);

        try {
            const res = await apiClient.post<any>(
                "/reading/explain-context",
                {
                    text: trimmedText,
                    sentence: trimmedSentence,
                    passageTitle: material.title,
                    readingMaterialId: material.id,
                },
                { signal: controller.signal }
            );

            // Stale response protection
            if (currentReqId !== activeRequestIdRef.current) {
                return;
            }

            const item = normalizeContextualItem(res.data, trimmedText);
            setActiveExplanation(item);
            sessionCacheRef.current.set(cacheKey, item);

            // Auto-save: prepend or update in history list
            setHistoryList((prev) => {
                const itemText = (item.selectedText || item.text || "").toLowerCase();
                const filtered = prev.filter((h) => {
                    const hText = (h.selectedText || h.text || "").toLowerCase();
                    return h.id !== item.id && !(hText === itemText && h.sentence === item.sentence);
                });
                return [item, ...filtered];
            });
        } catch (err: any) {
            if (axios.isCancel(err) || err.name === "CanceledError" || err.name === "AbortError") {
                return;
            }
            if (currentReqId === activeRequestIdRef.current) {
                console.error("Contextual explain request failed:", err);
                setExplainError(
                    err.response?.data?.message ||
                        "Không thể phân tích ngữ cảnh lúc này. Vui lòng thử lại."
                );
            }
        } finally {
            if (currentReqId === activeRequestIdRef.current) {
                setIsExplaining(false);
            }
        }
    };

    /**
     * Trigger Batch Contextual Vocabulary Extraction for sentence/paragraph selection (Mode B).
     * Single AI call -> multiple extracted learner vocabulary items -> saved to shared cache and history.
     */
    const triggerParagraphExtraction = async (passage: string) => {
        if (!passage || !passage.trim()) return;
        const cleanPassage = passage.trim();

        setIsContextPanelOpen(true);
        setExplainError(null);
        setIsExplaining(true);

        if (activeAbortControllerRef.current) {
            activeAbortControllerRef.current.abort();
        }
        const controller = new AbortController();
        activeAbortControllerRef.current = controller;
        const currentReqId = ++activeRequestIdRef.current;

        try {
            const res = await apiClient.post<ContextualVocabularyItem[]>(
                "/reading/extract-contextual-vocabulary",
                {
                    passage: cleanPassage,
                    readingMaterialId: material.id,
                    passageTitle: material.title,
                    maxItems: 10,
                },
                { signal: controller.signal }
            );

            if (currentReqId !== activeRequestIdRef.current) return;

            const rawItems = Array.isArray(res.data) ? res.data : [];
            const items = rawItems.map((raw) => normalizeContextualItem(raw));
            if (items.length > 0) {
                // Prepend to history list & update session cache
                setHistoryList((prev) => {
                    const existingIds = new Set(prev.map((p) => p.id));
                    const newItems = items.filter((it) => !existingIds.has(it.id));
                    return [...newItems, ...prev];
                });

                // Cache all extracted items in session
                items.forEach((it) => {
                    const itText = (it.selectedText || it.text || "").toLowerCase();
                    const itemKey = `${material.id}::${itText}::${(it.sentence || "").toLowerCase()}`;
                    sessionCacheRef.current.set(itemKey, it);
                });

                // Set first item as active
                setActiveExplanation(items[0]);
                setToast(`Đã trích xuất ${items.length} từ vựng từ đoạn được chọn!`);
                setTimeout(() => setToast(null), 3500);
            } else {
                setToast("Không tìm thấy từ vựng học thuật hoặc thành ngữ cần chú ý trong đoạn này.");
                setTimeout(() => setToast(null), 3000);
            }
        } catch (err: any) {
            if (axios.isCancel(err) || err.name === "CanceledError" || err.name === "AbortError") {
                return;
            }
            if (currentReqId === activeRequestIdRef.current) {
                console.error("Batch paragraph extraction failed:", err);
                setExplainError(
                    err.response?.data?.message ||
                        "Không thể trích xuất từ vựng trong đoạn này. Vui lòng thử lại."
                );
            }
        } finally {
            if (currentReqId === activeRequestIdRef.current) {
                setIsExplaining(false);
            }
        }
    };

    const handleSelectHistoryItem = (item: ContextualVocabularyItem) => {
        setActiveExplanation(item);
        setExplainError(null);
        setIsExplaining(false);
    };

    const handleDeleteHistoryItem = async (e: React.MouseEvent, id?: number) => {
        e.stopPropagation();
        if (!id) return;
        try {
            await apiClient.delete(`/reading/vocabulary-history/${id}`);
            setHistoryList((prev) => prev.filter((item) => item.id !== id));
            if (activeExplanation?.id === id) {
                setActiveExplanation(null);
            }
            setToast("Đã xóa từ vựng khỏi bài đọc này.");
            setTimeout(() => setToast(null), 3000);
        } catch (err: any) {
            console.error("Failed to delete vocabulary history item:", err);
            setToast("Không thể xóa từ vựng. Vui lòng thử lại.");
            setTimeout(() => setToast(null), 3000);
        }
    };

    const handleAddActiveToFlashcard = () => {
        if (!activeExplanation) return;
        const ipaStr = activeExplanation.ipa ? ` [${activeExplanation.ipa}]` : "";
        const cefrStr = activeExplanation.cefr ? ` (${activeExplanation.cefr})` : "";
        const meaning = activeExplanation.meaningInContext || "";
        const backContent = `${meaning}${ipaStr}${cefrStr}${
            activeExplanation.nativeExplanation ? `\n\n${activeExplanation.nativeExplanation}` : ""
        }`;

        setFlashcardDraft({
            isOpen: true,
            front: activeExplanation.selectedText || activeExplanation.text || "",
            back: backContent,
            example: activeExplanation.sentence || "",
            isLoadingBack: false,
        });
    };

    const handleLookupDictionary = async (text: string) => {
        const cleanWord = getNormalizedLexicalLookupTarget(text);
        if (!cleanWord) return;

        setActiveTool("dictionary");
        setIsExplaining(false);
        setTranslation({
            loading: true,
            type: "dict",
            state: "loading",
            data: null,
            targetWord: cleanWord,
        });

        try {
            const res = await lookupDictionary(cleanWord, {
                contextSentence: lastExtractedContext.sentence,
                onSecondaryData: (updated) => {
                    setTranslation((prev) =>
                        prev.type === "dict" && prev.targetWord === cleanWord
                            ? { ...prev, data: updated }
                            : prev
                    );
                },
            });
            if (res) {
                setTranslation({
                    loading: false,
                    type: "dict",
                    state: "success",
                    data: res,
                    targetWord: cleanWord,
                });
            } else {
                setTranslation({
                    loading: false,
                    type: "dict",
                    state: "not_found",
                    data: null,
                    targetWord: cleanWord,
                });
            }
        } catch (error) {
            console.error("Dictionary lookup error:", error);
            setTranslation({
                loading: false,
                type: "dict",
                state: "error",
                data: null,
                targetWord: cleanWord,
            });
        }
    };

    const handleTranslate = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const rawText = selection.text.trim();
        if (!rawText) return;

        // 1. Check if selection is 1 or 2 lexical words -> DICTIONARY FLOW (NO AI)
        if (isLexicalDictionaryTarget(rawText)) {
            await handleLookupDictionary(rawText);
            return;
        }

        // 2. Otherwise (>= 3 words) -> EXISTING GOOGLE TRANSLATE FLOW (Unchanged)
        setActiveTool("translation");
        setIsExplaining(false);
        setTranslation({
            loading: true,
            type: "text",
            state: "loading",
            data: null,
        });

        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${encodeURIComponent(
                rawText
            )}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error("GG Translate failed");
            const data = await res.json();
            const translatedText = data[0].map((item: any) => item[0]).join("");

            setTranslation({
                loading: false,
                type: "text",
                state: "success",
                data: { meaning: translatedText },
            });
        } catch (error) {
            setTranslation({
                loading: false,
                type: "text",
                state: "error",
                data: { meaning: "Không thể dịch. Vui lòng thử lại." },
            });
        }
    };

    /** Opens Echo AI Card Studio with the selection (a short selection brings its sentence as the passage). No request here. */
    const handleOpenStudio = (e: React.MouseEvent) => {
        e.stopPropagation();
        const raw = selection.text.trim();
        const passage = raw.length >= 60 ? raw : (lastExtractedContext.sentence || raw);
        setSelection({ text: "", top: 0, left: 0, show: false });
        setStudioText(passage.slice(0, 6000));
    };

    const handleOpenFlashcard = async (e: React.MouseEvent) => {
        e.stopPropagation();
        const rawText = selection.text.trim();
        const cleanText = rawText.replace(/^["'“”‘’.,!?;:()\[\]{}]+|["'“”‘’.,!?;:()\[\]{}]+$/g, "");

        setSelection({ text: "", top: 0, left: 0, show: false });
        setFlashcardDraft({
            isOpen: true,
            front: cleanText,
            back: "",
            example: lastExtractedContext.sentence || "",
            isLoadingBack: true,
            saving: false,
            error: undefined,
        });

        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${encodeURIComponent(
                cleanText
            )}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error();
            const data = await res.json();
            const translatedText = data[0].map((item: any) => item[0]).join("");

            setFlashcardDraft((prev) => ({ ...prev, back: translatedText, isLoadingBack: false }));
        } catch (error) {
            setFlashcardDraft((prev) => ({ ...prev, back: "", isLoadingBack: false }));
        }
    };

    const handleSaveFlashcard = async () => {
        // one request at a time; a failed save keeps the dialog and everything typed in it
        if (flashcardSavingRef.current || !flashcardDraft.front.trim()) return;
        flashcardSavingRef.current = true;
        setFlashcardDraft((prev) => ({ ...prev, saving: true, error: undefined }));
        try {
            const res = await apiClient.post("/flashcards", {
                front: flashcardDraft.front,
                back: flashcardDraft.back,
                example: flashcardDraft.example || "",
            });

            setFlashcardDraft({ isOpen: false, front: "", back: "", example: "", isLoadingBack: false });
            // 201 = a new card; 200 = the word was already in the learner's Flashcards (their meaning is kept)
            setToast(res.status === 201 ? "Đã lưu Flashcard thành công!" : "Từ này đã có trong Flashcards của bạn.");
            setTimeout(() => setToast(null), 3500);
        } catch (error: any) {
            console.error("FLASHCARD SAVE ERROR:", error?.response?.status ?? error?.message);
            const reason = error?.response?.status < 500 ? error?.response?.data?.message : "";
            setFlashcardDraft((prev) => ({ ...prev, saving: false, error: reason || "Chưa lưu được Flashcard. Hãy thử lại." }));
        } finally {
            flashcardSavingRef.current = false;
        }
    };

    const handleMouseUp = () => {
        const sel = window.getSelection();
        const rawText = sel?.toString().trim() || "";

        if (rawText.length > 0 && sel && sel.rangeCount > 0 && contentRef.current) {
            const range = sel.getRangeAt(0);
            if (!contentRef.current.contains(range.commonAncestorContainer)) {
                setSelection({ text: "", top: 0, left: 0, show: false });
                return;
            }

            const rects = range.getClientRects();
            if (rects.length > 0) {
                const rect = rects[rects.length - 1];
                const top = rect.bottom + window.scrollY + 10;
                const left = rect.left + window.scrollX + rect.width / 2;

                const cleanText = rawText.replace(/^["'“”‘’.,!?;:()\[\]{}]+|["'“”‘’.,!?;:()\[\]{}]+$/g, "");
                const surroundingSentence = extractSurroundingSentence(range, contentRef.current);
                const isPassage = isPassageSelection(cleanText);

                selectionRangeRef.current = range.cloneRange();
                setSelection({ text: rawText, top, left, show: true });
                setLastExtractedContext({ text: cleanText, sentence: surroundingSentence });
                setTranslation({ loading: false, type: null, state: "idle", data: null });
                setActiveTool(null);
            }
        } else {
            setSelection({ text: "", top: 0, left: 0, show: false });
            setActiveTool(null);
        }
    };

    const handleMarkCompleted = async () => {
        if (isCompleted || completing) return;
        setCompleting(true);
        try {
            await completeReading(material.id);
            setIsCompleted(true);
            setScrollProgress(100);
            localStorage.setItem(progressKey, "100");
            setToast(locale === "vi" ? "Đã lưu: bạn đã đọc xong bài này." : "Saved: you finished this reading.");
            // the Learning Path shows the finished task as soon as the learner goes back to it
            void mutateCache((key) => Array.isArray(key) && key[0] === LEARNING_PATH_TODAY_KEY);
        } catch (err: unknown) {
            const code = (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
            setToast(code === "READING_TOO_FAST"
                ? (locale === "vi" ? "Hãy đọc hết bài rồi bấm lại nhé." : "Read the whole text first, then try again.")
                : (locale === "vi" ? "Chưa lưu được. Thử lại nhé." : "Could not save. Please try again."));
        } finally {
            setCompleting(false);
            setTimeout(() => setToast(null), 4000);
        }
    };

    const wordsCount = useMemo(() => {
        return material.wordCount || (material.contentText ? material.contentText.trim().split(/\s+/).length : 0);
    }, [material.wordCount, material.contentText]);

    const estimatedMinsRemaining = useMemo(() => {
        const remainingWords = Math.max(0, Math.round(wordsCount * (1 - scrollProgress / 100)));
        return Math.max(1, Math.round(remainingWords / 200));
    }, [wordsCount, scrollProgress]);

    const getCefrBadgeStyle = (cefr?: string) => {
        const level = (cefr || "B2").toUpperCase();
        if (level === "A1" || level === "A2") {
            return "bg-emerald-600 text-white";
        }
        if (level === "B1" || level === "B2") {
            return "bg-indigo-600 text-white";
        }
        if (level === "C1" || level === "C2") {
            return "bg-purple-600 text-white";
        }
        return "bg-slate-600 text-white";
    };

    const renderSentenceWithHighlight = (sentence: string, targetText: string) => {
        if (!sentence || !targetText) return sentence;
        const escaped = targetText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(${escaped})`, "gi");
        const parts = sentence.split(regex);
        return (
            <span>
                {parts.map((part, i) =>
                    part.toLowerCase() === targetText.toLowerCase() ? (
                        <mark
                            key={i}
                            className="bg-amber-200 dark:bg-amber-500/40 text-amber-950 dark:text-amber-100 font-semibold px-1 rounded mx-0.5 not-italic"
                        >
                            {part}
                        </mark>
                    ) : (
                        part
                    )
                )}
            </span>
        );
    };

    return (
        // The frame fills exactly the workspace viewport (100vh − 4 rem top bar) and cancels the tab's py-8 / px-4, so the
        // reader has ONE scroll area: the former -mt-4 left the outer page 64 px taller than its viewport (two scrollbars).
        <div className={`${glass.readerFrame} flex flex-col h-[calc(100vh-4rem)] overflow-hidden text-slate-800 dark:text-slate-100 antialiased selection:bg-sky-100 dark:selection:bg-sky-900/70 selection:text-sky-950 dark:selection:text-sky-50`}>
            {/* BEGIN: Top Reader Bar */}
            <header className={`${glass.readerBar} h-14 sm:h-16 px-2 sm:px-4 relative flex items-center justify-between gap-2 z-30 shrink-0 select-none`}>
                {/* Left Navigation & Article Meta Breadcrumb */}
                <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                    <button
                        type="button"
                        onClick={onBack}
                        className="inline-flex shrink-0 items-center gap-1.5 text-stone-600 dark:text-slate-300 hover:text-[#0d2a5e] dark:hover:text-white px-2.5 h-9 rounded-xl hover:bg-white dark:hover:bg-white/[0.06] border border-transparent hover:border-stone-200 dark:hover:border-white/10 transition text-xs font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                        title={locale === "vi" ? "Quay lại danh sách bài đọc" : "Back to the reading library"}
                    >
                        <ChevronLeft className="w-4 h-4" />
                        <span className="hidden sm:inline">{locale === "vi" ? "Kho tài liệu" : "Library"}</span>
                    </button>
                    <span className="hidden sm:block h-5 w-px bg-stone-300/80 dark:bg-white/10" aria-hidden="true" />
                    <div className="flex items-center gap-2 min-w-0">
                        {material.difficultyLevel && (
                            <span className="hidden sm:inline-flex shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-sky-50 dark:bg-sky-400/10 ring-1 ring-inset ring-sky-200/80 dark:ring-sky-300/20 text-sky-800 dark:text-sky-200 font-bold font-mono uppercase tracking-wider">
                                CEFR {material.difficultyLevel}
                            </span>
                        )}
                        <h1
                            className="text-xs sm:text-sm font-semibold text-stone-800 dark:text-slate-100 truncate max-w-[9rem] sm:max-w-xs md:max-w-md"
                            title={material.title}
                        >
                            {material.title}
                        </h1>
                    </div>
                </div>

                {/* Center: Quiet Reading Progress Bar */}
                <div className="hidden lg:flex flex-col items-center justify-center max-w-xs w-64 px-4">
                    <div className="flex items-center justify-between w-full text-[11px] font-medium text-stone-500 dark:text-slate-400 mb-1">
                        <span>{locale === "vi" ? "Tiến độ đọc" : "Progress"}: {scrollProgress}%</span>
                        <span className="text-stone-400 dark:text-slate-500">{locale === "vi" ? `~${estimatedMinsRemaining} phút còn lại` : `~${estimatedMinsRemaining} min left`}</span>
                    </div>
                    <div className="w-full h-1.5 bg-stone-200/70 dark:bg-white/10 rounded-full overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={scrollProgress} aria-label={locale === "vi" ? "Tiến độ đọc" : "Reading progress"}>
                        <div
                            className="h-full bg-gradient-to-r from-[#1656b8] to-cyan-400 rounded-full transition-[width] duration-200"
                            style={{ width: `${scrollProgress}%` }}
                        />
                    </div>
                </div>

                {/* Small screens: the same progress as a hairline under the bar */}
                <div className="lg:hidden pointer-events-none absolute inset-x-0 bottom-0 h-0.5" aria-hidden="true">
                    <div className="h-full bg-gradient-to-r from-[#1656b8] to-cyan-400 transition-[width] duration-200" style={{ width: `${scrollProgress}%` }} />
                </div>

                {/* Right: Editorial Reading Controls */}
                <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                    {/* Reading-only appearance control. */}
                    <div className="relative" ref={appearanceRef}>
                        <button type="button" data-guide="reader-settings" onClick={() => setIsAppearanceOpen((open) => !open)} aria-expanded={isAppearanceOpen} className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-bold transition ${isAppearanceOpen ? "border-indigo-500 bg-indigo-600 text-white" : "border-stone-200/80 bg-white/80 text-stone-700 hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-200"}`} title={locale === "vi" ? "Tùy chỉnh giao diện đọc" : "Reading appearance"}>
                            <Type className="h-4 w-4" /> Aa
                        </button>
                        {isAppearanceOpen && (
                            <div className="absolute right-0 top-11 z-50 w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-stone-200 bg-white p-4 text-xs shadow-2xl dark:border-slate-700 dark:bg-slate-900" role="dialog" aria-label="Reading appearance">
                                <div className="mb-3 flex items-center justify-between"><strong>{locale === "vi" ? "Giao diện đọc" : "Reading appearance"}</strong><button type="button" onClick={resetAppearance} className="text-indigo-600 hover:underline dark:text-indigo-400">{locale === "vi" ? "Đặt lại" : "Reset"}</button></div>
                                <label className="mb-3 block">{locale === "vi" ? "Phông chữ" : "Font family"}<select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900"><option>Georgia</option><option>Arial</option><option>Verdana</option><option>Times New Roman</option></select></label>
                                <label className="mb-3 block">{locale === "vi" ? "Cỡ chữ" : "Font size"}<input type="range" min="15" max="28" step="1" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} className="mt-2 w-full" /><span className="text-stone-500">{fontSize}px</span></label>
                                <label className="mb-3 block">{locale === "vi" ? "Khoảng dòng" : "Line height"}<input type="range" min="1.4" max="2.2" step="0.05" value={lineHeight} onChange={(e) => setLineHeight(Number(e.target.value))} className="mt-2 w-full" /><span className="text-stone-500">{lineHeight.toFixed(2)}</span></label>
                                <label className="mb-3 block">{locale === "vi" ? "Khoảng chữ" : "Letter spacing"}<input type="range" min="-0.02" max="0.12" step="0.01" value={letterSpacing} onChange={(e) => setLetterSpacing(Number(e.target.value))} className="mt-2 w-full" /><span className="text-stone-500">{letterSpacing.toFixed(2)}em</span></label>
                                <label className="block">{locale === "vi" ? "Độ rộng nội dung" : "Reading width"}<select value={readingWidth} onChange={(e) => setReadingWidth(e.target.value)} className="mt-1 w-full rounded-lg border border-stone-200 bg-transparent px-2 py-1.5 dark:border-slate-700"><option value="narrow">{locale === "vi" ? "Hẹp" : "Narrow"}</option><option value="comfortable">{locale === "vi" ? "Thoải mái" : "Comfortable"}</option><option value="wide">{locale === "vi" ? "Rộng" : "Wide"}</option></select></label>
                            </div>
                        )}
                    </div>

                    {material.hasDocumentRepresentation && material.canonicalDocument && (
                        <div className="flex items-center gap-1 rounded-xl border border-stone-200/80 bg-white/80 p-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-800/80">
                            <button type="button" aria-pressed={viewMode === "reading"} onClick={() => setViewMode("reading")} className={`rounded-lg px-2 py-1.5 ${viewMode === "reading" ? "bg-indigo-600 text-white" : "text-stone-600 dark:text-slate-300"}`}>{locale === "vi" ? "Chế độ đọc" : "Reading"}</button>
                            <button type="button" aria-pressed={viewMode === "document"} onClick={() => setViewMode("document")} className={`rounded-lg px-2 py-1.5 ${viewMode === "document" ? "bg-indigo-600 text-white" : "text-stone-600 dark:text-slate-300"}`}>{locale === "vi" ? "Bản tài liệu" : "Document"}</button>
                        </div>
                    )}

                    {/* TTS Audio Read Button */}
                    <button
                        type="button"
                        onClick={toggleSpeechSynthesis}
                        className={`p-2 rounded-xl border transition-all cursor-pointer ${
                            isPlayingAudio
                                ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                                : "bg-white/80 dark:bg-slate-800/80 border-stone-200/80 dark:border-slate-700 text-stone-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400"
                        }`}
                        title={isPlayingAudio ? (locale === 'vi' ? "Dừng đọc âm thanh" : "Stop audio") : (locale === 'vi' ? "Nghe toàn bộ bài đọc" : "Listen to full article")}
                    >
                        {isPlayingAudio ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                    </button>

                    {/* Distraction Free Full Width Toggle */}
                    <button
                        type="button"
                        onClick={() => setIsDistractionFree((d) => !d)}
                        className={`p-2 rounded-xl border transition-all cursor-pointer ${
                            isDistractionFree
                                ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                                : "bg-white/80 dark:bg-slate-800/80 border-stone-200/80 dark:border-slate-700 text-stone-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400"
                        }`}
                        title={isDistractionFree ? (locale === 'vi' ? "Thoát chế độ tập trung" : "Exit focus mode") : (locale === 'vi' ? "Chế độ đọc tập trung" : "Distraction-free mode")}
                    >
                        {isDistractionFree ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                    </button>

                    {/* Context Panel Toggle */}
                    <button
                        type="button"
                        onClick={() => setIsContextPanelOpen((open) => !open)}
                        className={`relative p-2 rounded-xl border transition-all cursor-pointer ${
                            isContextPanelOpen
                                ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                                : "bg-white/80 dark:bg-slate-800/80 border-stone-200/80 dark:border-slate-700 text-stone-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400"
                        }`}
                        title="Mở bảng giải nghĩa ngữ cảnh và từ vựng bài đọc"
                    >
                        {isContextPanelOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
                        {historyList.length > 0 && (
                            <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-slate-900 text-[10px] font-bold flex items-center justify-center shadow-xs">
                                {historyList.length}
                            </span>
                        )}
                    </button>
                </div>
            </header>
            {/* END: Top Reader Bar */}

            {/* BEGIN: Reader Main Body & Side Drawer Layout */}
            <div className="flex-1 flex overflow-hidden relative">
                {/* Center Reading Chamber */}
                <main
                    ref={scrollContainerRef}
                    onScroll={handleScroll}
                    className="flex-1 overflow-y-auto px-0 sm:px-6 md:px-8 py-0 sm:py-8 flex justify-center custom-scrollbar"
                >
                    {/*
                      Measure: "comfortable" keeps a text column of ~670 px (≈ 75–80 characters at the default 18 px), the
                      editorial range for sustained reading; narrow ≈ 65, wide ≈ 90. The document view keeps its page width.
                    */}
                    <div
                        className={`w-full transition-[max-width] duration-300 ${
                            viewMode === "document" ? "max-w-4xl" : readingWidth === "narrow" ? "max-w-2xl" : readingWidth === "wide" ? "max-w-4xl" : "max-w-3xl"
                        }`}
                    >
                        {/* Article Sheet Container (phones: full-bleed paper, no card frame eating the column) */}
                        <article className="bg-white dark:bg-[#0f182c] sm:rounded-2xl shadow-[0_1px_2px_rgba(15,23,42,0.04),0_34px_70px_-44px_rgba(20,40,110,0.45)] border-b sm:border border-stone-200/80 dark:border-white/[0.07] px-5 sm:px-12 pb-8 sm:pb-14 text-slate-800 dark:text-slate-100 overflow-hidden">
                            {/* Masthead: typographic art of the reading's topic family (the corpus has no pictures of its own) */}
                            <div className={`${glass.mast} -mx-5 sm:-mx-12 mb-8 sm:mb-10`}>
                                <ReadingCover family={material.isSystem ? topicFamily(material.topic) : "personal"} seed={material.id} size="lg" />
                                <div className={glass.mastMeta} aria-hidden="true">
                                    {material.isSystem && material.topic && material.topic !== "Other" && <span className={glass.mastChip}>{material.topic}</span>}
                                    {material.isSystem && material.sourceName && <span className={glass.mastChip}>{material.sourceName}</span>}
                                    {!material.isSystem && <span className={glass.mastChip}>{locale === "vi" ? "Tài liệu của bạn" : "Your document"}</span>}
                                </div>
                            </div>
                            {/* Article Header Metadata */}
                            <header className="mb-9 pb-7 border-b border-stone-100 dark:border-white/[0.07]">
                                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 mb-4 text-xs font-semibold text-stone-500 dark:text-slate-400">
                                    {material.difficultyLevel && (
                                        <span
                                            className="inline-flex items-center rounded-full bg-sky-50 dark:bg-sky-400/10 px-2.5 py-0.5 font-mono font-bold text-sky-800 dark:text-sky-200 ring-1 ring-inset ring-sky-200/80 dark:ring-sky-300/20"
                                            title={material.isSystem ? (locale === "vi" ? "Trình độ ước tính" : "Estimated level") : undefined}
                                        >
                                            CEFR {material.difficultyLevel}{material.isSystem ? (locale === "vi" ? " · ước tính" : " · est.") : ""}
                                        </span>
                                    )}
                                    {material.materialType && (
                                        <span className="uppercase tracking-wider text-stone-600 dark:text-slate-300">{material.materialType}</span>
                                    )}
                                    <span className="tabular-nums">{wordsCount.toLocaleString(locale === "vi" ? "vi-VN" : "en-US")} {locale === "vi" ? "từ" : "words"}</span>
                                    {wordsCount > 0 && (
                                        <span className="tabular-nums">· {locale === "vi" ? `~${Math.max(1, Math.round(wordsCount / 200))} phút đọc` : `~${Math.max(1, Math.round(wordsCount / 200))} min read`}</span>
                                    )}
                                    {isCompleted && (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-400/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300 font-semibold">
                                            <BookmarkCheck className="w-3.5 h-3.5" />
                                            {locale === "vi" ? "Đã đọc xong" : "Finished"}
                                        </span>
                                    )}
                                    {isCompleted && (
                                        <Link href={`/knowledge-universe?source=READING:${encodeURIComponent(String(material.id))}`} className="font-semibold text-sky-700 dark:text-sky-300 hover:underline">
                                            {locale === "vi" ? "Xem trong vũ trụ" : "See in the universe"}
                                        </Link>
                                    )}
                                </div>

                                <h1 className="text-[2rem] sm:text-[2.6rem] md:text-5xl font-bold text-slate-900 dark:text-slate-50 tracking-[-0.02em] leading-[1.1] mb-6 notranslate" translate="no">
                                    {material.title}
                                </h1>

                                {material.isSystem && material.attribution && (
                                    <aside className="mb-6 border-l-2 border-sky-200 dark:border-sky-400/30 pl-3.5 text-xs leading-relaxed text-stone-500 dark:text-slate-400">
                                        {material.sourceName && <p className="mb-0.5 font-semibold text-stone-700 dark:text-slate-200">{material.sourceName}</p>}
                                        <p>{material.attribution}</p>
                                        <p className="mt-1 flex flex-wrap items-center gap-x-2">
                                            {material.licenseCode && <span className="font-mono">{material.licenseCode}</span>}
                                            {material.sourceUrl?.startsWith('https://') && <a href={material.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#1656b8] underline-offset-2 hover:underline dark:text-sky-300">{locale === 'vi' ? 'Đọc tại nguồn ↗' : 'Read original source ↗'}</a>}
                                        </p>
                                    </aside>
                                )}

                                {/* Fast Actions Bar */}
                                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={toggleSpeechSynthesis}
                                            aria-pressed={isPlayingAudio}
                                            data-guide="reader-listen"
                                            className="inline-flex h-9 items-center gap-1.5 text-xs font-semibold bg-white dark:bg-white/[0.04] border border-stone-200 dark:border-white/10 text-stone-700 dark:text-slate-200 px-3 rounded-xl hover:border-sky-300 hover:bg-sky-50 dark:hover:bg-white/[0.08] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 cursor-pointer"
                                        >
                                            <Volume2 className="w-3.5 h-3.5 text-[#1656b8] dark:text-sky-300" />
                                            <span>{isPlayingAudio ? (locale === "vi" ? "Đang phát audio..." : "Playing audio...") : (locale === "vi" ? "Nghe bài đọc" : "Listen")}</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => router.push(`/speaking?sourceType=READING&sourceId=${material.id}`)}
                                            className="inline-flex h-9 items-center gap-1.5 text-xs font-semibold bg-gradient-to-br from-[#0d2a5e] to-[#1656b8] text-white px-3.5 rounded-xl shadow-sm hover:brightness-110 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 cursor-pointer"
                                            title={locale === "vi" ? "Luyện nói với bài đọc này" : "Practice speaking with this reading"}
                                        >
                                            <Mic className="w-3.5 h-3.5" />
                                            <span>{locale === "vi" ? "Luyện nói" : "Practice speaking"}</span>
                                        </button>
                                    </div>

                                    <button
                                        type="button"
                                        onClick={handleClearAllHighlights}
                                        className="inline-flex h-9 items-center gap-1.5 px-3 rounded-xl border border-transparent text-xs font-semibold text-stone-500 dark:text-slate-400 hover:bg-stone-100 dark:hover:bg-white/[0.06] hover:text-stone-900 dark:hover:text-white hover:border-stone-200 dark:hover:border-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 transition-all cursor-pointer"
                                        title={locale === "vi" ? "Xóa tất cả highlights trong bài" : "Remove all highlights in this reading"}
                                    >
                                        <Trash2 className="w-3.5 h-3.5 shrink-0" />
                                        <span>{locale === "vi" ? "Xóa highlights" : "Clear highlights"}</span>
                                    </button>
                                </div>
                            </header>

                            {/* Editorial Article Body */}
                            {viewMode === "document" && material.canonicalDocument && (
                                <DocumentRepresentation document={material.canonicalDocument} locale={locale} />
                            )}
                            <div
                                data-echo-excerpt="" ref={contentRef}
                                data-guide="reader-body"
                                onMouseUp={handleMouseUp}
                                style={{ fontSize: `${fontSize}px`, fontFamily, lineHeight, letterSpacing: `${letterSpacing}em` }}
                                hidden={viewMode === "document"}
                                className="font-reading drop-cap whitespace-pre-wrap text-slate-800 dark:text-slate-200 space-y-6 select-text cursor-text notranslate"
                                translate="no"
                                suppressHydrationWarning
                            />

                            {/* BEGIN: Reader Completion Footer */}
                            <footer className="mt-12 pt-8 border-t border-stone-200 dark:border-white/[0.07] flex flex-col gap-5 text-xs font-medium text-stone-500 dark:text-slate-400">
                                <div className="flex flex-wrap items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={() => void handleMarkCompleted()}
                                        aria-pressed={isCompleted}
                                        disabled={completing}
                                        className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs transition shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 cursor-pointer ${
                                            isCompleted
                                                ? "bg-emerald-600 text-white shadow-emerald-600/20 focus-visible:ring-emerald-500"
                                                : "bg-gradient-to-br from-[#0d2a5e] to-[#1656b8] hover:brightness-110 text-white shadow-[#0d2a5e]/25 focus-visible:ring-sky-500"
                                        }`}
                                    >
                                        <CheckCircle2 className="w-4 h-4" />
                                        <span>{isCompleted ? (locale === "vi" ? "Đã hoàn thành bài đọc" : "Reading completed") : (locale === "vi" ? "Hoàn thành bài đọc" : "Mark as completed")}</span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => router.push(`/speaking?sourceType=READING&sourceId=${material.id}`)}
                                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white dark:bg-white/[0.04] hover:bg-sky-50 dark:hover:bg-white/[0.08] text-stone-700 dark:text-slate-200 font-semibold text-xs transition border border-stone-200 dark:border-white/10 hover:border-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 cursor-pointer"
                                    >
                                        <Mic className="w-4 h-4 text-[#1656b8] dark:text-sky-300" />
                                        <span>{locale === "vi" ? "Luyện nói bài này" : "Speak this reading"}</span>
                                    </button>
                                </div>

                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-stone-500 dark:text-slate-400">
                                    <span className="tabular-nums">{wordsCount} {locale === "vi" ? "từ" : "words"}</span>
                                    <span aria-hidden="true">•</span>
                                    <span>{locale === "vi" ? `Đã lưu ${highlightCount} highlight` : `${highlightCount} highlights saved`}</span>
                                    <span aria-hidden="true">•</span>
                                    <span>{locale === "vi" ? `${historyList.length} từ đã giải nghĩa` : `${historyList.length} words explained`}</span>
                                </div>
                            </footer>
                            {/* END: Reader Completion Footer */}
                        </article>
                    </div>
                </main>

                {/* BEGIN: Contextual Slide-Over Panel */}
                {isContextPanelOpen && (
                    <aside
                        ref={contextPanelRef}
                        className="absolute inset-x-0 bottom-0 h-[min(75vh,42rem)] rounded-t-2xl lg:static lg:h-auto lg:w-80 lg:my-3 lg:mr-3 lg:rounded-2xl bg-white/95 dark:bg-[#0d1529]/95 ring-1 ring-stone-200/80 dark:ring-white/[0.08] shrink-0 flex flex-col justify-between overflow-hidden shadow-[0_30px_60px_-36px_rgba(20,40,110,0.55)] z-20 animate-in slide-in-from-right duration-200"
                    >
                        {/* Panel Header */}
                        <div className="p-4 border-b border-stone-100 dark:border-slate-800 flex items-center justify-between bg-stone-50/70 dark:bg-slate-900/40 shrink-0">
                            <div className="flex items-center gap-2">
                                <span className="p-1 rounded-lg bg-indigo-500/10 dark:bg-indigo-950/60 flex items-center justify-center shrink-0">
                                    <img
                                        src={echoSrc('scholar', 24)}
                                        alt="Echo"
                                        aria-hidden="true"
                                        width={18}
                                        height={18}
                                        className="w-[18px] h-[18px] object-contain shrink-0 select-none pointer-events-none"
                                    />
                                </span>
                                <div>
                                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                                        Bảng giải nghĩa ngữ cảnh
                                    </h2>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsContextPanelOpen(false)}
                                className="text-stone-400 hover:text-stone-600 dark:hover:text-slate-300 p-1 rounded-lg cursor-pointer"
                                title="Đóng bảng ngữ cảnh"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Panel Scrollable Body */}
                        <div className="p-4 sm:p-5 space-y-5 flex-1 overflow-y-auto custom-scrollbar">
                            {/* 1. Loading Skeleton */}
                            {isExplaining && (
                                <div className="space-y-4 animate-pulse">
                                    <div className="bg-indigo-50/70 dark:bg-indigo-950/40 rounded-2xl p-4 border border-indigo-100 dark:border-indigo-900/60 space-y-3">
                                        <div className="h-6 bg-indigo-200 dark:bg-indigo-900/60 rounded w-2/3" />
                                        <div className="h-3 bg-indigo-100 dark:bg-indigo-900/40 rounded w-1/3" />
                                        <div className="h-4 bg-indigo-100 dark:bg-indigo-900/40 rounded w-1/2" />
                                    </div>
                                    <div className="space-y-2">
                                        <div className="h-3 bg-stone-200 dark:bg-slate-800 rounded w-1/4" />
                                        <div className="h-16 bg-stone-100 dark:bg-slate-800/60 rounded-xl" />
                                    </div>
                                    <div className="space-y-2">
                                        <div className="h-3 bg-stone-200 dark:bg-slate-800 rounded w-1/3" />
                                        <div className="h-12 bg-stone-100 dark:bg-slate-800/60 rounded-xl" />
                                    </div>
                                    <div className="flex items-center justify-center gap-2 py-2 text-xs text-indigo-600 dark:text-indigo-400 font-medium">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        <span>AI đang phân tích ngữ cảnh trong câu...</span>
                                    </div>
                                </div>
                            )}

                            {/* 2. Error State */}
                            {!isExplaining && explainError && (
                                <div className="p-4 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 rounded-2xl text-xs text-rose-700 dark:text-rose-300 space-y-2">
                                    <div className="flex items-center gap-1.5 font-bold">
                                        <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
                                        <span>Không thể giải nghĩa</span>
                                    </div>
                                    <p className="leading-relaxed">{explainError}</p>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            triggerContextualExplain(
                                                lastExtractedContext.text,
                                                lastExtractedContext.sentence
                                            )
                                        }
                                        className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-semibold text-xs transition inline-flex items-center gap-1 cursor-pointer"
                                    >
                                        Thử lại
                                    </button>
                                </div>
                            )}

                            {/* 3. Active Explanation Card */}
                            {!isExplaining && activeExplanation && (
                                <div className="space-y-4">
                                    {/* Word Head & Pronunciation */}
                                    <div className="bg-indigo-50/60 dark:bg-indigo-950/40 rounded-2xl p-4 border border-indigo-100/90 dark:border-indigo-900/60">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-baseline gap-2">
                                                    <h3 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight font-serif break-words">
                                                        {activeExplanation.selectedText || activeExplanation.text || ""}
                                                    </h3>
                                                    {activeExplanation.pos && (
                                                        <span className="text-xs italic text-slate-500 dark:text-slate-400 font-medium">
                                                            ({activeExplanation.pos})
                                                        </span>
                                                    )}
                                                </div>
                                                {activeExplanation.lemma && (activeExplanation.selectedText || activeExplanation.text) && activeExplanation.lemma.toLowerCase() !== (activeExplanation.selectedText || activeExplanation.text || "").toLowerCase() && (
                                                    <p className="text-[11px] text-stone-500 dark:text-slate-400 mt-0.5">
                                                        Từ gốc: <span className="font-semibold">{activeExplanation.lemma}</span>
                                                    </p>
                                                )}
                                                {activeExplanation.ipa && (
                                                    <p className="text-xs text-indigo-600 dark:text-indigo-400 font-mono mt-1">
                                                        {activeExplanation.ipa}
                                                    </p>
                                                )}
                                            </div>

                                            <button
                                                type="button"
                                                onClick={() => speakWord(activeExplanation.selectedText || activeExplanation.text || "")}
                                                className="w-9 h-9 shrink-0 rounded-full bg-white dark:bg-slate-800 shadow-xs border border-stone-200 dark:border-slate-700 flex items-center justify-center text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/60 transition cursor-pointer"
                                                title="Nghe phát âm"
                                            >
                                                <Volume2 className="w-4 h-4" />
                                            </button>
                                        </div>

                                        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-indigo-100/70 dark:border-indigo-900/50 text-[11px]">
                                            <span className={`px-2 py-0.5 font-bold rounded font-mono ${getCefrBadgeStyle(activeExplanation.cefr)}`}>
                                                CEFR {activeExplanation.cefr || "B2"}
                                            </span>
                                            {activeExplanation.frequency && (
                                                <span className="text-stone-500 dark:text-slate-400 truncate">
                                                    • Tần suất: {activeExplanation.frequency}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Meaning in context */}
                                    <div>
                                        <h4 className="text-xs font-bold text-stone-500 dark:text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                            <BrandWhaleIcon size="xs" clean />
                                            <span>Nghĩa trong ngữ cảnh</span>
                                        </h4>
                                        <div className="p-3.5 bg-amber-50/70 dark:bg-amber-950/30 border-l-4 border-amber-400 rounded-r-xl text-xs leading-relaxed text-amber-950 dark:text-amber-100 font-medium">
                                            <p className="font-semibold text-amber-900 dark:text-amber-200 mb-1">
                                                {activeExplanation.meaningInContext}
                                            </p>
                                            {activeExplanation.nativeExplanation && (
                                                <p className="text-[11px] text-stone-600 dark:text-slate-300 font-normal mt-1.5 pt-1.5 border-t border-amber-200/50 dark:border-amber-900/40">
                                                    {activeExplanation.nativeExplanation}
                                                </p>
                                            )}
                                        </div>
                                    </div>

                                    {/* Sentence in text with highlight */}
                                    {activeExplanation.sentence && (
                                        <div>
                                            <h4 className="text-xs font-bold text-stone-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                                                Câu trong bài
                                            </h4>
                                            <div className="p-3 bg-stone-50 dark:bg-slate-800/60 rounded-xl border border-stone-200/80 dark:border-slate-700 text-xs text-stone-700 dark:text-slate-300 font-reading leading-relaxed italic">
                                                "{renderSentenceWithHighlight(activeExplanation.sentence, activeExplanation.selectedText || activeExplanation.text || "")}"
                                            </div>
                                        </div>
                                    )}

                                    {/* Collocations */}
                                    {activeExplanation.collocations && activeExplanation.collocations.length > 0 && (
                                        <div>
                                            <h4 className="text-xs font-bold text-stone-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                                                Collocations
                                            </h4>
                                            <div className="space-y-1.5">
                                                {activeExplanation.collocations.map((col, idx) => (
                                                    <div
                                                        key={idx}
                                                        className="p-2.5 rounded-xl bg-stone-50 dark:bg-slate-800/50 border border-stone-200/70 dark:border-slate-700/70 text-xs flex flex-col gap-0.5"
                                                    >
                                                        <span className="font-semibold text-slate-800 dark:text-slate-100 font-serif">
                                                            {col.phrase}
                                                        </span>
                                                        <span className="text-[11px] text-stone-500 dark:text-slate-400">
                                                            {col.meaning}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Synonyms */}
                                    {activeExplanation.synonyms && activeExplanation.synonyms.length > 0 && (
                                        <div>
                                            <h4 className="text-xs font-bold text-stone-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                                                Từ đồng nghĩa phù hợp ngữ cảnh
                                            </h4>
                                            <div className="space-y-1.5">
                                                {activeExplanation.synonyms.map((syn, idx) => (
                                                    <div
                                                        key={idx}
                                                        className="p-2.5 rounded-xl bg-stone-50 dark:bg-slate-800/50 border border-stone-200/70 dark:border-slate-700/70 text-xs flex flex-col gap-0.5"
                                                    >
                                                        <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                                                            {syn.word}
                                                        </span>
                                                        <span className="text-[11px] text-stone-500 dark:text-slate-400">
                                                            {syn.nuance}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Grammar Note */}
                                    {activeExplanation.grammarNote && activeExplanation.grammarNote.trim().length > 0 && (
                                        <div>
                                            <h4 className="text-xs font-bold text-stone-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                                                Ghi chú ngữ pháp
                                            </h4>
                                            <div className="p-3 bg-sky-50/70 dark:bg-sky-950/30 border-l-4 border-sky-400 rounded-r-xl text-xs leading-relaxed text-sky-950 dark:text-sky-200">
                                                {activeExplanation.grammarNote}
                                            </div>
                                        </div>
                                    )}

                                    {/* Actions on Active Word */}
                                    <div className="pt-2 flex flex-col gap-2">
                                        <button
                                            type="button"
                                            onClick={handleAddActiveToFlashcard}
                                            className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-xs transition flex items-center justify-center gap-2 shadow-sm shadow-indigo-600/25 cursor-pointer"
                                        >
                                            <BookOpen className="w-4 h-4" />
                                            <span>Thêm vào Flashcard</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => router.push(`/speaking?sourceType=READING&sourceId=${material.id}`)}
                                            className="w-full py-2 px-4 bg-stone-100 dark:bg-slate-800 hover:bg-stone-200 dark:hover:bg-slate-700 text-stone-700 dark:text-slate-200 rounded-xl font-semibold text-xs transition flex items-center justify-center gap-1.5 border border-stone-200 dark:border-slate-700 cursor-pointer"
                                        >
                                            <Mic className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                                            <span>Luyện phát âm với AI</span>
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* 4. Empty State if no active explanation and not loading */}
                            {!isExplaining && !activeExplanation && !explainError && (
                                <div className="text-center py-10 text-stone-400 dark:text-slate-500 space-y-3">
                                    <img
                                        src={echoSrc('scholar', 24)}
                                        alt="Echo"
                                        aria-hidden="true"
                                        width={32}
                                        height={32}
                                        className="w-8 h-8 mx-auto opacity-70 object-contain select-none pointer-events-none"
                                    />
                                    <p className="text-xs leading-relaxed">
                                        Bôi đen bất kỳ từ hoặc cụm từ nào trong bài đọc để xem giải nghĩa ngữ cảnh chi tiết trong câu.
                                    </p>
                                </div>
                            )}

                            {/* 5. Persistent Vocabulary History for Current Reading */}
                            <div className="pt-4 border-t border-stone-200 dark:border-slate-800">
                                <div className="flex items-center justify-between mb-3">
                                    <h4 className="text-xs font-bold text-stone-600 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                                        <span>Từ đã tra trong bài này</span>
                                        <span className="text-stone-400 dark:text-slate-500 font-mono">
                                            • {historyList.length}
                                        </span>
                                    </h4>
                                    {isLoadingHistory && (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-400" />
                                    )}
                                </div>

                                {historyList.length > 0 ? (
                                    <div className="space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar pr-1">
                                        {historyList.map((item, idx) => {
                                            const activeWord = (activeExplanation?.selectedText || activeExplanation?.text || "").toLowerCase();
                                            const itemWord = (item.selectedText || item.text || "").toLowerCase();
                                            const isActive =
                                                activeExplanation?.id === item.id ||
                                                (Boolean(activeWord) && activeWord === itemWord &&
                                                    activeExplanation?.sentence === item.sentence);
                                            return (
                                                <div
                                                    key={item.id || itemWord || idx}
                                                    onClick={() => handleSelectHistoryItem(item)}
                                                    className={`p-2.5 rounded-xl border transition flex items-center justify-between gap-2 cursor-pointer group ${
                                                        isActive
                                                            ? "bg-indigo-50 dark:bg-indigo-950/50 border-indigo-300 dark:border-indigo-800"
                                                            : "bg-stone-50/70 dark:bg-slate-800/40 border-stone-200/70 dark:border-slate-700/60 hover:bg-stone-100 dark:hover:bg-slate-800"
                                                    }`}
                                                >
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate font-serif">
                                                            {item.selectedText || item.text || ""}
                                                        </span>
                                                        {item.cefr && (
                                                            <span
                                                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded font-mono shrink-0 ${getCefrBadgeStyle(
                                                                    item.cefr
                                                                )}`}
                                                            >
                                                                {item.cefr}
                                                            </span>
                                                        )}
                                                    </div>

                                                    <button
                                                        type="button"
                                                        onClick={(e) => handleDeleteHistoryItem(e, item.id)}
                                                        title="Xóa khỏi danh sách từ vựng bài đọc"
                                                        className="opacity-0 group-hover:opacity-100 text-stone-400 hover:text-rose-500 dark:hover:text-rose-400 p-1 rounded transition cursor-pointer"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <p className="text-[11px] text-stone-400 dark:text-slate-500 italic py-2">
                                        Chưa có từ vựng nào được tra trong bài này. Các từ bạn tra sẽ tự động được lưu tại đây.
                                    </p>
                                )}
                            </div>
                        </div>
                    </aside>
                )}
                {/* END: Contextual Slide-Over Panel */}
            </div>
            {/* END: Reader Main Body */}

            {/* Floating Selection Tooltip */}
            {selection.show && (
                <div
                    ref={toolbarRef}
                    data-guide="reader-tools"
                    className="fixed z-[9999] max-w-[calc(100vw-16px)] shadow-[0_24px_50px_-20px_rgba(2,8,30,0.8)] bg-[#0a1531]/95 text-white rounded-2xl flex flex-col ring-1 ring-white/10 animate-in fade-in duration-150"
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    <div className="flex shrink-0 items-center p-1.5 gap-1">
                        {/* Primary Contextual Explanation / Paragraph Extraction Action */}
                        {isPassageSelection(selection.text) ? (
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveTool("context_ai");
                                    setSelection({ text: "", top: 0, left: 0, show: false });
                                    setTranslation({ loading: false, type: null, state: "idle", data: null });
                                    triggerParagraphExtraction(lastExtractedContext.text);
                                }}
                                title="Trích xuất từ vựng hữu ích trong đoạn này"
                                className="px-2.5 py-1.5 bg-gradient-to-r from-amber-500/20 to-indigo-500/20 hover:from-amber-500/30 hover:to-indigo-500/30 text-amber-300 hover:text-amber-200 border border-amber-500/30 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer text-xs font-semibold"
                            >
                                <img
                                    src={echoSrc('scholar', 24)}
                                    alt="Echo"
                                    aria-hidden="true"
                                    width={18}
                                    height={18}
                                    className="w-[18px] h-[18px] object-contain shrink-0 select-none pointer-events-none"
                                />
                                <span>Trích xuất từ vựng đoạn này</span>
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveTool("context_ai");
                                    setSelection({ text: "", top: 0, left: 0, show: false });
                                    setTranslation({ loading: false, type: null, state: "idle", data: null });
                                    triggerContextualExplain(
                                        lastExtractedContext.text,
                                        lastExtractedContext.sentence
                                    );
                                }}
                                title="Giải nghĩa ngữ cảnh trong câu"
                                className="px-2.5 py-1.5 bg-gradient-to-r from-amber-500/20 to-indigo-500/20 hover:from-amber-500/30 hover:to-indigo-500/30 text-amber-300 hover:text-amber-200 border border-amber-500/30 rounded-xl transition-all flex items-center gap-1.5 cursor-pointer text-xs font-semibold"
                            >
                                <img
                                    src={echoSrc('scholar', 24)}
                                    alt="Echo"
                                    aria-hidden="true"
                                    width={18}
                                    height={18}
                                    className="w-[18px] h-[18px] object-contain shrink-0 select-none pointer-events-none"
                                />
                                <span>Giải nghĩa ngữ cảnh</span>
                            </button>
                        )}

                        <span className="w-[1px] h-4 bg-slate-700 mx-0.5" />

                        {/* Translation / Dictionary Action */}
                        <button
                            type="button"
                            onClick={handleTranslate}
                            title={isLexicalDictionaryTarget(selection.text) ? "Tra từ điển" : "Dịch nhanh"}
                            className="p-2 hover:bg-slate-800 rounded-xl transition-colors cursor-pointer text-indigo-300 hover:text-white"
                        >
                            <Languages size={18} />
                        </button>

                        {/* Fast Highlighter Tool */}
                        <div className="relative group flex items-center justify-center">
                            <div className="absolute bottom-full mb-0 pb-2.5 hidden group-hover:flex items-center justify-center z-50">
                                <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-full shadow-2xl animate-in fade-in zoom-in-90 duration-150">
                                    {HIGHLIGHT_COLORS.map((c) => (
                                        <button
                                            key={c.colorClass}
                                            type="button"
                                            title={c.name}
                                            onClick={(e) => handleColorSelect(e, c.colorClass)}
                                            className={`w-5 h-5 rounded-full ${c.colorClass} border transition-all hover:scale-125 cursor-pointer ${
                                                activeHighlightColor === c.colorClass
                                                    ? "border-white ring-2 ring-indigo-400 scale-110 shadow-xs"
                                                    : "border-transparent opacity-85 hover:opacity-100"
                                            }`}
                                        />
                                    ))}
                                    <button
                                        type="button"
                                        title="Xóa highlight"
                                        onClick={handleRemoveHighlight}
                                        className="w-5 h-5 rounded-full bg-white hover:bg-stone-100 flex items-center justify-center border border-stone-300 hover:border-red-400 transition-all hover:scale-125 cursor-pointer ml-0.5 shadow-xs"
                                    >
                                        <span className="text-red-500 text-xs font-bold leading-none select-none">✕</span>
                                    </button>
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    applyHighlight(activeHighlightColor);
                                }}
                                title="Highlight (Bấm để tô màu, Rê chuột để đổi màu)"
                                className="p-2 hover:bg-slate-800 rounded-xl transition-colors relative flex flex-col items-center justify-center cursor-pointer"
                            >
                                <Highlighter className={`${getPenIconColor(activeHighlightColor)} transition-colors`} size={18} />
                                <span className={`w-3.5 h-1 rounded-full ${activeHighlightColor} mt-0.5`} />
                            </button>
                        </div>

                        {/* Flashcard Action */}
                        <button
                            type="button"
                            onClick={handleOpenFlashcard}
                            title="Tạo Flashcard"
                            className="p-2 hover:bg-slate-800 rounded-xl transition-colors cursor-pointer text-indigo-400 hover:text-white"
                        >
                            <BookOpen size={18} />
                        </button>

                        {/* Echo AI Card Studio: drafts from the selected passage, reviewed before anything is saved */}
                        <button
                            type="button"
                            onClick={handleOpenStudio}
                            title="Tạo Flashcard với Echo AI"
                            aria-label="Tạo Flashcard với Echo AI"
                            className="p-2 hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
                        >
                            <BrandWhaleIcon size="xs" clean />
                        </button>
                    </div>

                    {/* Dictionary Popup Card (1-2 Words) — scrolls inside the toolbar's room; the action row stays visible */}
                    {activeTool === "dictionary" && translation.type === "dict" && (
                        <div className="min-h-0 overflow-y-auto overscroll-contain rounded-b-2xl custom-scrollbar">
                        <ReadingDictionaryCard
                            status={translation.state as any}
                            data={translation.data}
                            word={translation.targetWord || getNormalizedLexicalLookupTarget(selection.text)}
                            onRetry={() => handleLookupDictionary(selection.text)}
                            onSpeak={speakWord}
                            onAddFlashcard={(w, m, ex) => {
                                setSelection({ text: "", top: 0, left: 0, show: false });
                                setFlashcardDraft({
                                    isOpen: true,
                                    front: w,
                                    back: m,
                                    example: ex || lastExtractedContext.sentence || "",
                                    isLoadingBack: false,
                                    saving: false,
                                    error: undefined,
                                });
                            }}
                        />
                        </div>
                    )}

                    {/* Translation Loading (>= 3 Words) - Clean, Neutral Copy (No AI Wording) */}
                    {activeTool === "translation" && translation.type === "text" && translation.loading && (
                        <div className="text-xs text-slate-300 px-4 py-3 border-t border-slate-800 bg-slate-900 rounded-b-2xl flex items-center justify-center gap-2">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                            <span>Đang dịch...</span>
                        </div>
                    )}

                    {/* Translation Result (>= 3 Words) */}
                    {activeTool === "translation" && translation.type === "text" && translation.data && !translation.loading && (
                        <div
                            className="min-h-0 px-4 py-3 border-t border-slate-800 bg-slate-900 rounded-b-2xl w-80 max-w-full overflow-y-auto overscroll-contain cursor-default custom-scrollbar"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="text-xs text-slate-200 whitespace-pre-wrap leading-relaxed">
                                {translation.data.meaning}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {studioText !== null && (
                <CardStudio
                    open
                    initialText={studioText}
                    sourceLabel={material.title}
                    onClose={() => setStudioText(null)}
                    onSaved={(n) => setToast(`Đã lưu ${n} thẻ mới vào Flashcards.`)}
                />
            )}

            {/* Flashcard Creation Modal */}
            {flashcardDraft.isOpen && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Tạo Flashcard"
                    className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150"
                    onPointerDown={(e) => { flashcardBackdropDown.current = e.target === e.currentTarget; }}
                    onClick={(e) => {
                        if (e.target === e.currentTarget && flashcardBackdropDown.current && !flashcardSavingRef.current) setFlashcardDraft((prev) => ({ ...prev, isOpen: false }));
                    }}
                >
                    <div
                        className="bg-white dark:bg-[#131826] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden border border-stone-200 dark:border-slate-800"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-6 py-4 border-b border-stone-200 dark:border-slate-800 bg-stone-50 dark:bg-slate-900/40 flex justify-between items-center">
                            <h3 className="text-base font-bold text-slate-900 dark:text-white">Tạo Flashcard</h3>
                            <button
                                type="button"
                                onClick={() => setFlashcardDraft((prev) => ({ ...prev, isOpen: false }))}
                                className="text-stone-400 hover:text-stone-600 dark:hover:text-slate-300 cursor-pointer"
                            >
                                &times;
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 dark:text-slate-300 mb-1">
                                    Mặt trước (Từ/Cụm từ)
                                </label>
                                <input
                                    type="text"
                                    value={flashcardDraft.front}
                                    onChange={(e) => setFlashcardDraft((prev) => ({ ...prev, front: e.target.value }))}
                                    className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-white border border-stone-300 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-sans"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 dark:text-slate-300 mb-1">
                                    Mặt sau (Nghĩa)
                                    {flashcardDraft.isLoadingBack && (
                                        <span className="text-indigo-500 text-xs animate-pulse ml-2 font-normal">
                                            Đang dịch tự động...
                                        </span>
                                    )}
                                </label>
                                <textarea
                                    rows={4}
                                    value={flashcardDraft.back}
                                    onChange={(e) => setFlashcardDraft((prev) => ({ ...prev, back: e.target.value }))}
                                    className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-white border border-stone-300 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-sans leading-relaxed"
                                    placeholder="Nhập nghĩa hoặc ghi chú..."
                                />
                            </div>
                            {flashcardDraft.example && (
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 dark:text-slate-300 mb-1">
                                        Ví dụ / Câu trong bài
                                    </label>
                                    <p className="p-3 bg-stone-50 dark:bg-slate-800/60 rounded-xl border border-stone-200 dark:border-slate-700 text-xs text-stone-700 dark:text-slate-300 font-reading italic leading-relaxed">
                                        "{flashcardDraft.example}"
                                    </p>
                                </div>
                            )}
                            {flashcardDraft.error && (
                                <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{flashcardDraft.error}</p>
                            )}
                        </div>
                        <div className="px-6 py-4 bg-stone-50 dark:bg-slate-900/40 border-t border-stone-200 dark:border-slate-800 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setFlashcardDraft((prev) => ({ ...prev, isOpen: false }))}
                                className="px-4 py-2 text-stone-600 dark:text-slate-300 hover:bg-stone-200 dark:hover:bg-slate-800 rounded-xl font-semibold text-xs transition cursor-pointer"
                            >
                                Hủy
                            </button>
                            <button
                                type="button"
                                onClick={handleSaveFlashcard}
                                disabled={flashcardDraft.saving || !flashcardDraft.front.trim()}
                                className="inline-flex items-center gap-1.5 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl font-bold text-xs transition shadow-sm cursor-pointer"
                            >
                                {flashcardDraft.saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                Lưu Flashcard
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Feedback Toast */}
            {toast && (
                <div data-echo-clear="" className="fixed bottom-6 right-6 bg-slate-900 text-white border border-slate-700 px-5 py-3 rounded-2xl shadow-2xl z-[100000] flex items-center gap-2.5 text-xs font-medium animate-in fade-in slide-in-from-bottom-2">
                    <img
                        src={echoSrc('scholar', 24)}
                        alt="Echo"
                        aria-hidden="true"
                        width={18}
                        height={18}
                        className="w-[18px] h-[18px] object-contain shrink-0 select-none pointer-events-none"
                    />
                    <span>{toast}</span>
                </div>
            )}
        </div>
    );
}
