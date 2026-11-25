"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
    Languages,
    BookOpen,
    Volume2,
    Loader2,
    RotateCcw,
} from "lucide-react";
import { DictionaryPopup } from "@/components/features/dictionary/DictionaryPopup";
import { useLanguage } from "@/context/LanguageContext";
import { getOrGenerateUnitIpa, getOrGenerateUnitTranslation } from "@/services/speakingApi";

interface ShadowingActiveSentenceProps {
    unitId?: number;
    sentenceText: string;
    segmentIndex: number;
    ipa?: string | null;
    wordIpaJson?: string | null;
    translation?: string | null;
    className?: string;
    onTranslationLoaded?: (unitId: number, translation: string) => void;
}

interface ParsedWordToken {
    raw: string;
    prefix: string;
    coreWord: string;
    suffix: string;
    cleanWord: string;
}

interface PrecomputedWordIpaItem {
    surface: string;
    normalized: string;
    ipa: string;
    source?: string;
    alternatives?: string[];
    prefix?: string;
    suffix?: string;
}

export function ShadowingActiveSentence({
    unitId,
    sentenceText,
    segmentIndex,
    ipa,
    wordIpaJson,
    translation,
    className = "",
    onTranslationLoaded,
}: ShadowingActiveSentenceProps) {
    const { locale } = useLanguage();
    const [selectedWord, setSelectedWord] = useState<string | null>(null);
    const [showIpa, setShowIpa] = useState(false);
    const [showTranslation, setShowTranslation] = useState(false);

    // Dynamic metadata state with lazy load support
    const [currentIpa, setCurrentIpa] = useState<string | null>(ipa || null);
    const [currentWordIpaJson, setCurrentWordIpaJson] = useState<string | null>(wordIpaJson || null);
    const [currentTranslation, setCurrentTranslation] = useState<string | null>(translation || null);

    const [loadingIpa, setLoadingIpa] = useState(false);
    const [loadingTranslation, setLoadingTranslation] = useState(false);
    const [ipaError, setIpaError] = useState(false);
    const [translationError, setTranslationError] = useState(false);

    // Metadata is reference-unit state. Every request is bound to the exact
    // sentence identity that started it so a slow response cannot repaint a
    // newly selected sentence.
    const metadataGenerationRef = useRef(0);
    const ipaAbortRef = useRef<AbortController | null>(null);
    const translationAbortRef = useRef<AbortController | null>(null);

    const prevUnitIdRef = useRef<number | undefined>(unitId);

    useEffect(() => {
        const isNewUnit = prevUnitIdRef.current !== unitId;
        prevUnitIdRef.current = unitId;

        if (isNewUnit) {
            const generation = ++metadataGenerationRef.current;
            ipaAbortRef.current?.abort();
            translationAbortRef.current?.abort();
            ipaAbortRef.current = null;
            translationAbortRef.current = null;

            // Reset all presentation state, including negative/error state. A
            // missing value for the new unit must not retain the old unit's data.
            setCurrentIpa(ipa || null);
            setCurrentWordIpaJson(wordIpaJson || null);
            setCurrentTranslation(translation || null);
            setShowIpa(false);
            setShowTranslation(false);
            setLoadingIpa(false);
            setLoadingTranslation(false);
            setIpaError(false);
            setTranslationError(false);
        } else {
            // Same unit: update values when props change, but do NOT close open panels or reset loading
            if (translation != null && translation !== currentTranslation) {
                setCurrentTranslation(translation);
            }
            if (ipa != null && ipa !== currentIpa) {
                setCurrentIpa(ipa);
            }
            if (wordIpaJson != null && wordIpaJson !== currentWordIpaJson) {
                setCurrentWordIpaJson(wordIpaJson);
            }
        }
    }, [unitId, segmentIndex, sentenceText, ipa, wordIpaJson, translation, currentTranslation, currentIpa, currentWordIpaJson]);

    // SSR mounted safety for portal
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);

    // Parse sentence into natural whitespace-delimited tokens with attached punctuation
    const tokens: ParsedWordToken[] = useMemo(() => {
        if (!sentenceText || !sentenceText.trim()) return [];
        const rawTokens = sentenceText.trim().split(/\s+/);
        return rawTokens.map((raw) => {
            const match = raw.match(/^([^a-zA-Z0-9']*)([a-zA-Z0-9'-]+)?([^a-zA-Z0-9']*)$/);
            if (match) {
                const prefix = match[1] || "";
                const coreWord = match[2] || "";
                const suffix = match[3] || "";
                const cleanWord = coreWord.replace(/[^a-zA-Z0-9']/g, "").toLowerCase();
                return { raw, prefix, coreWord, suffix, cleanWord };
            }
            const clean = raw.replace(/[^a-zA-Z0-9']/g, "").toLowerCase();
            return { raw, prefix: "", coreWord: raw, suffix: "", cleanWord: clean };
        });
    }, [sentenceText]);

    // Parse precomputed word-level IPA JSON keyed by token index (prevents heteronym collisions)
    const { wordIpaByIndex, wordIpaMap } = useMemo<{
        wordIpaByIndex: Record<number, string>;
        wordIpaMap: Record<string, string>;
    }>(() => {
        const byIndex: Record<number, string> = {};
        const map: Record<string, string> = {};
        const sourceJson = currentWordIpaJson || wordIpaJson;
        if (!sourceJson) return { wordIpaByIndex: byIndex, wordIpaMap: map };
        try {
            const parsed: PrecomputedWordIpaItem[] = JSON.parse(sourceJson);
            if (Array.isArray(parsed)) {
                let tokenCursor = 0;
                parsed.forEach((item) => {
                    if (!item.ipa) return;
                    const norm = item.normalized ? item.normalized.toLowerCase() : "";
                    const cleanSurface = item.surface
                        ? item.surface.replace(/[^a-zA-Z0-9']/g, "").toLowerCase()
                        : "";
                    if (norm && !(norm in map)) {
                        map[norm] = item.ipa;
                    }
                    if (cleanSurface && !(cleanSurface in map)) {
                        map[cleanSurface] = item.ipa;
                    }
                    for (let i = tokenCursor; i < tokens.length; i++) {
                        const tk = tokens[i].cleanWord;
                        if (tk && (tk === norm || tk === cleanSurface)) {
                            byIndex[i] = item.ipa;
                            tokenCursor = i + 1;
                            break;
                        }
                    }
                });
            }
        } catch (e) {
            console.error("Failed to parse precomputed wordIpaJson:", e);
        }
        return { wordIpaByIndex: byIndex, wordIpaMap: map };
    }, [currentWordIpaJson, wordIpaJson, tokens]);

    const isCurrentMetadataRequest = useCallback((generation: number, requestedUnitId: number) => (
        metadataGenerationRef.current === generation && unitId === requestedUnitId
    ), [unitId]);

    // Lazy-load Translation with DB persistence. The caller controls whether
    // the panel is toggled; retries must invoke this loader directly.
    const loadTranslation = useCallback(async () => {
        if (!unitId || loadingTranslation) return;

        const generation = metadataGenerationRef.current;
        const requestedUnitId = unitId;
        const controller = new AbortController();
        translationAbortRef.current?.abort();
        translationAbortRef.current = controller;
        setLoadingTranslation(true);
        setTranslationError(false);
        setShowTranslation(true);

        try {
            const res = await getOrGenerateUnitTranslation(requestedUnitId, controller.signal);
            if (!isCurrentMetadataRequest(generation, requestedUnitId)) return;
            if (res?.unitId !== requestedUnitId || !res.translation?.trim()) {
                setTranslationError(true);
                return;
            }
            setCurrentTranslation(res.translation);
            onTranslationLoaded?.(requestedUnitId, res.translation);
        } catch (err) {
            if (controller.signal.aborted || !isCurrentMetadataRequest(generation, requestedUnitId)) return;
            console.error("Failed to load translation:", err);
            setTranslationError(true);
        } finally {
            if (isCurrentMetadataRequest(generation, requestedUnitId)) {
                setLoadingTranslation(false);
            }
        }
    }, [isCurrentMetadataRequest, loadingTranslation, onTranslationLoaded, unitId]);

    // Toggle or lazy-load Translation with DB persistence
    const handleToggleTranslation = () => {
        if (showTranslation) {
            setShowTranslation(false);
            return;
        }
        if (currentTranslation) {
            setShowTranslation(true);
            return;
        }
        if (!unitId) {
            setShowTranslation(true);
            setTranslationError(true);
            return;
        }

        void loadTranslation();
    };

    // Lazy-load IPA with DB persistence. Response identity is checked against
    // both the request generation and the requested unit ID.
    const loadIpa = useCallback(async () => {
        if (!unitId || loadingIpa) return;

        const generation = metadataGenerationRef.current;
        const requestedUnitId = unitId;
        const controller = new AbortController();
        ipaAbortRef.current?.abort();
        ipaAbortRef.current = controller;
        setLoadingIpa(true);
        setIpaError(false);
        setShowIpa(true);

        try {
            const res = await getOrGenerateUnitIpa(requestedUnitId, controller.signal);
            if (!isCurrentMetadataRequest(generation, requestedUnitId)) return;
            if (res?.unitId !== requestedUnitId || !res.ipa?.trim()) {
                setIpaError(true);
                return;
            }
            setCurrentIpa(res.ipa);
            setCurrentWordIpaJson(res.wordIpaJson || null);
        } catch (err) {
            if (controller.signal.aborted || !isCurrentMetadataRequest(generation, requestedUnitId)) return;
            console.error("Failed to load IPA:", err);
            setIpaError(true);
        } finally {
            if (isCurrentMetadataRequest(generation, requestedUnitId)) {
                setLoadingIpa(false);
            }
        }
    }, [isCurrentMetadataRequest, loadingIpa, unitId]);

    // Toggle or lazy-load IPA with DB persistence
    const handleToggleIpa = () => {
        if (showIpa) {
            setShowIpa(false);
            return;
        }
        if (currentIpa) {
            setShowIpa(true);
            return;
        }
        if (!unitId) {
            setShowIpa(true);
            setIpaError(true);
            return;
        }

        void loadIpa();
    };

    // Dictionary Modal Portal
    const dictionaryOverlay = selectedWord && mounted
        ? createPortal(
            <>
                <div
                    className="fixed inset-0 bg-black/40 backdrop-blur-xs z-[9998]"
                    onClick={() => setSelectedWord(null)}
                />
                <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999]">
                    <DictionaryPopup word={selectedWord} onClose={() => setSelectedWord(null)} />
                </div>
            </>,
            document.body
        )
        : null;

    return (
        <div
            className={`w-full rounded-3xl bg-white dark:bg-gray-800/90 border border-gray-200/80 dark:border-gray-700/80 shadow-md p-5 sm:p-7 space-y-4 ${className}`}
        >
            {/* ── Top Meta & Tools Bar ── */}
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-gray-100 dark:border-gray-700/60 text-xs">
                <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-blue-700 dark:text-blue-300">
                    <Volume2 size={15} />
                    <span>{locale === 'vi' ? 'Câu mẫu Shadowing' : 'Reference Sentence'}</span>
                </div>

                {/* Instant Local Tool Buttons */}
                <div className="flex items-center gap-2">
                    {/* IPA Toggle */}
                    <button
                        type="button"
                        id="shadowing-ipa-toggle-btn"
                        onClick={handleToggleIpa}
                        disabled={loadingIpa}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition-all cursor-pointer border ${
                            showIpa
                                ? "bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-700 shadow-xs"
                                : "bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-750"
                        }`}
                        aria-pressed={showIpa}
                        title="Bật/Tắt phiên âm IPA từng từ"
                    >
                        {loadingIpa ? <Loader2 size={13} className="animate-spin" /> : <Languages size={13} />}
                        <span>IPA</span>
                    </button>

                    {/* Translation Toggle */}
                    <button
                        type="button"
                        id="shadowing-translation-toggle-btn"
                        onClick={handleToggleTranslation}
                        disabled={loadingTranslation}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition-all cursor-pointer border ${
                            showTranslation
                                ? "bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-700 shadow-xs"
                                : "bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-750"
                        }`}
                        aria-pressed={showTranslation}
                        title="Xem bản dịch nghĩa tiếng Việt"
                    >
                        {loadingTranslation ? <Loader2 size={13} className="animate-spin" /> : <BookOpen size={13} />}
                        <span>Dịch nghĩa</span>
                    </button>
                </div>
            </div>

            {/* ── Interactive Sentence Display with Natural Spacing ── */}
            <div className="py-2 notranslate" translate="no">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-3 leading-relaxed text-lg sm:text-2xl font-bold text-gray-900 dark:text-gray-100 notranslate" translate="no">
                    {tokens.map((token, idx) => {
                        const isClickable = token.cleanWord.length > 0;
                        const wordIpa = showIpa && isClickable ? (wordIpaByIndex[idx] ?? wordIpaMap[token.cleanWord] ?? null) : null;

                        return (
                            <span key={idx} className="inline-flex flex-col items-center group relative">
                                <span className="inline-flex items-baseline">
                                    {token.prefix && <span className="text-gray-500 select-none">{token.prefix}</span>}
                                    {isClickable ? (
                                        <button
                                            type="button"
                                            onClick={() => setSelectedWord(token.cleanWord)}
                                            className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline decoration-blue-400 underline-offset-4 rounded transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                            title={`Nhấn để tra từ điển: "${token.cleanWord}"`}
                                        >
                                            {token.coreWord}
                                        </button>
                                    ) : (
                                        <span>{token.coreWord}</span>
                                    )}
                                    {token.suffix && <span className="text-gray-500 select-none">{token.suffix}</span>}
                                </span>
                                {showIpa && (
                                    <span className="text-[11px] font-mono font-normal text-indigo-600 dark:text-indigo-400 min-h-[14px]">
                                        {wordIpa ? `/${wordIpa.replace(/^\/|\/$/g, "")}/` : ""}
                                    </span>
                                )}
                            </span>
                        );
                    })}
                </div>

                {/* Optional Sentence-level IPA line when IPA is active */}
                {showIpa && (currentIpa || ipa) && (
                    <div className="mt-2.5 pt-2 border-t border-dashed border-indigo-100 dark:border-indigo-900/50 flex items-center gap-2 text-xs font-mono text-indigo-700 dark:text-indigo-300 notranslate" translate="no">
                        <span className="font-bold text-[10px] uppercase bg-indigo-50 dark:bg-indigo-950 px-1.5 py-0.5 rounded text-indigo-600 dark:text-indigo-400">Câu</span>
                        <span>/{(currentIpa || ipa || "").replace(/^\/|\/$/g, "")}/</span>
                    </div>
                )}
                {showIpa && ipaError && !currentIpa && (
                    <div className="mt-2.5 pt-2 border-t border-dashed border-red-200 dark:border-red-900/50 flex items-center justify-between text-xs text-red-600 dark:text-red-400">
                        <span>Chưa thể tải phiên âm IPA cho câu này.</span>
                        <button type="button" onClick={() => void loadIpa()} className="font-bold hover:underline cursor-pointer flex items-center gap-1">
                            <RotateCcw size={12} /> Thử lại
                        </button>
                    </div>
                )}

                <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2 italic">
                    * Nhấn vào bất kỳ từ tiếng Anh nào ở trên để tra nghĩa, phát âm và ví dụ trong từ điển.
                </p>
            </div>

            {/* ── Instant Vietnamese Translation Banner ── */}
            {showTranslation && (
                <div
                    id="shadowing-translation-banner"
                    className="p-4 rounded-2xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-800/40 text-left animate-in fade-in duration-200 notranslate"
                    translate="no"
                >
                    <div className="flex items-center justify-between text-xs font-bold text-amber-800 dark:text-amber-300 uppercase tracking-wider mb-1">
                        <div className="flex items-center gap-1.5">
                            <BookOpen size={13} />
                            <span>Bản dịch tiếng Việt</span>
                        </div>
                        {loadingTranslation && (
                            <span className="flex items-center gap-1 text-[11px] font-normal lowercase text-amber-600">
                                <Loader2 size={12} className="animate-spin" /> Đang tải...
                            </span>
                        )}
                    </div>
                    {translationError && !currentTranslation ? (
                        <div className="flex items-center justify-between text-sm text-red-600 dark:text-red-400">
                            <span>Chưa thể tải bản dịch cho câu này.</span>
                            <button
                                type="button"
                                onClick={() => void loadTranslation()}
                                className="font-bold text-xs hover:underline cursor-pointer flex items-center gap-1 px-2 py-1 rounded bg-red-100 dark:bg-red-950/60"
                            >
                                <RotateCcw size={12} /> Thử lại
                            </button>
                        </div>
                    ) : (
                        <p className="text-sm font-medium text-amber-900 dark:text-amber-100 leading-relaxed">
                            {currentTranslation && currentTranslation.trim()
                                ? currentTranslation
                                : loadingTranslation
                                ? "Đang tạo bản dịch..."
                                : "Chưa có bản dịch cho câu này."}
                        </p>
                    )}
                </div>
            )}

            {/* Render Dictionary Modal Portal */}
            {dictionaryOverlay}
        </div>
    );
}
