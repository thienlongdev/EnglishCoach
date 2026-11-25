"use client";

import React, { useEffect, useLayoutEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { lookupDictionary, DictionaryLookupResult } from "@/services/dictionaryService";
import { QuickDictionaryCard } from "./QuickDictionaryCard";
import { apiClient } from "@/services/api-client";

export interface QuickDictionaryPopoverProps {
    word: string;
    anchor: { x: number; y: number; anchorY?: number };
    contextSentence?: string;
    selectionOffsets?: { start: number; end: number };
    onClose: () => void;
    onOpenFullDictionary?: (word: string) => void;
    onAddFlashcard?: (word: string, meaning: string, example?: string) => Promise<void> | void;
}

export const QuickDictionaryPopover: React.FC<QuickDictionaryPopoverProps> = ({
    word,
    anchor,
    contextSentence,
    selectionOffsets,
    onClose,
    onOpenFullDictionary,
    onAddFlashcard,
}) => {
    const [currentWord, setCurrentWord] = useState<string>(word);
    const [status, setStatus] = useState<"loading" | "success" | "not_found" | "error">("loading");
    const [data, setData] = useState<DictionaryLookupResult | null>(null);
    const [savingFlashcard, setSavingFlashcard] = useState<boolean>(false);
    const [flashcardSaved, setFlashcardSaved] = useState<boolean>(false);
    const [flashcardError, setFlashcardError] = useState<string>("");

    const popoverRef = useRef<HTMLDivElement | null>(null);
    const requestIdRef = useRef<number>(0);
    const abortControllerRef = useRef<AbortController | null>(null);

    // Sync currentWord if prop word changes
    useEffect(() => {
        setCurrentWord(word);
    }, [word]);

    // Close on outside click or Escape
    useEffect(() => {
        const handleOutsideClick = (e: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                onClose();
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };

        document.addEventListener("mousedown", handleOutsideClick);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("mousedown", handleOutsideClick);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [onClose]);

    // Fetch dictionary data with stale response protection
    const performLookup = (targetWord: string) => {
        if (!targetWord || !targetWord.trim()) return;

        // Abort previous in-flight request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        const controller = new AbortController();
        abortControllerRef.current = controller;

        const currentRequestId = ++requestIdRef.current;
        setStatus("loading");
        setData(null);
        setFlashcardSaved(false);
        setFlashcardError("");

        lookupDictionary(targetWord, {
            signal: controller.signal,
            contextSentence,
            selectionStart: selectionOffsets?.start,
            selectionEnd: selectionOffsets?.end,
        })
            .then((res) => {
                if (currentRequestId !== requestIdRef.current) return; // Stale response guard

                if (res && !res.isPhraseNotFound && (res.vietnameseMeaning || res.englishDefinition)) {
                    setData(res);
                    setStatus("success");
                } else if (res && res.isPhraseNotFound) {
                    setData(res);
                    setStatus("not_found");
                } else {
                    setData(null);
                    setStatus("not_found");
                }
            })
            .catch((err) => {
                if (currentRequestId !== requestIdRef.current) return;
                if (err?.name === "AbortError" || err?.name === "CanceledError") return;
                console.warn("[QuickDictionaryPopover] Lookup failed:", err);
                setStatus("error");
            });
    };

    useEffect(() => {
        performLookup(currentWord);

        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, [currentWord, contextSentence]);

    // Audio pronunciation handler
    const handleSpeak = (textToSpeak: string) => {
        if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
        window.dispatchEvent(new Event('ec:music-pause'));
        try {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(textToSpeak || currentWord);
            utterance.lang = "en-US";
            window.speechSynthesis.speak(utterance);
        } catch {
            // ignore audio playback errors
        }
    };

    // Flashcard handler
    const handleFlashcard = async (w: string, meaning: string, example?: string) => {
        if (savingFlashcard || flashcardSaved) return;

        setFlashcardError("");
        if (onAddFlashcard) {
            setSavingFlashcard(true);
            try {
                await onAddFlashcard(w, meaning, example);
                setFlashcardSaved(true);
            } catch (err) {
                console.warn("[QuickDictionaryPopover] onAddFlashcard failed:", err);
                setFlashcardError("Chưa lưu được Flashcard. Hãy thử lại.");
            } finally {
                setSavingFlashcard(false);
            }
            return;
        }

        // Default direct save to flashcards endpoint
        setSavingFlashcard(true);
        try {
            await apiClient.post("/flashcards", {
                front: w,
                back: meaning || data?.englishDefinition || "",
                example: example || "",
            });
            setFlashcardSaved(true);
        } catch (err: any) {
            console.warn("[QuickDictionaryPopover] Failed to save flashcard:", err?.response?.status ?? err?.message);
            const reason = typeof err?.response?.data?.message === "string" && err.response.status < 500 ? err.response.data.message : "";
            setFlashcardError(reason ? `Chưa lưu được Flashcard: ${reason}` : "Chưa lưu được Flashcard. Hãy thử lại.");
        } finally {
            setSavingFlashcard(false);
        }
    };

    // Placed from its real size: below the selection, above it when the bottom of the window is near, always inside
    // the window; placed again when its content (loading → meaning) or the window changes. Rendered into <body> so no
    // transformed or clipping ancestor can hide it.
    const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
    useLayoutEffect(() => {
        const el = popoverRef.current;
        if (!el) return;
        const place = () => {
            const margin = 12;
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const left = Math.max(margin, Math.min(anchor.x - w / 2, vw - w - margin));
            const below = (anchor.anchorY ?? anchor.y) + 8;
            let top = below;
            if (below + h > vh - margin) {
                const above = anchor.y - h - 30;
                top = above >= margin ? above : Math.max(margin, vh - h - margin);
            }
            setPlaced((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
        };
        place();
        const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
        ro?.observe(el);
        window.addEventListener("resize", place);
        return () => {
            ro?.disconnect();
            window.removeEventListener("resize", place);
        };
    }, [anchor.x, anchor.y, anchor.anchorY]);

    const popover = (
        <div
            ref={popoverRef}
            role="dialog"
            aria-label={`Từ điển: ${currentWord}`}
            style={{
                position: "fixed",
                top: `${placed?.top ?? 0}px`,
                left: `${placed?.left ?? 0}px`,
                zIndex: 9999,
                visibility: placed ? "visible" : "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
        >
            <QuickDictionaryCard
                status={status}
                data={data}
                word={currentWord}
                savingFlashcard={savingFlashcard}
                flashcardSaved={flashcardSaved}
                flashcardError={flashcardError}
                onRetry={() => performLookup(currentWord)}
                onSpeak={handleSpeak}
                onAddFlashcard={handleFlashcard}
                onOpenFullDictionary={onOpenFullDictionary}
                onSelectWord={(selectedSubWord) => {
                    setCurrentWord(selectedSubWord);
                }}
            />
        </div>
    );

    return typeof document === "undefined" ? popover : createPortal(popover, document.body);
};
