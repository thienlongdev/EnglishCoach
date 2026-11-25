"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Quote, RefreshCw } from "lucide-react";
import { lookupDictionary, DictionaryLookupResult } from "@/services/dictionaryService";
import {
  sanitizeSelection,
  buildLemmaCandidates,
  extractContextSentence,
} from "@/lib/readingSelection";
import { apiClient } from "@/services/api-client";
import { MiniHeader, MiniLoading, MiniSave, miniStyles as s } from "@/components/features/dictionary/lexicon/LexiconMini";

// Session cache for dictionary lookups
const sessionLookupCache = new Map<string, DictionaryLookupResult>();

export interface PopoverPosition {
  top: number;
  left: number;
  placement: "top" | "bottom";
}

export interface WordLookupPopoverProps {
  isOpen: boolean;
  anchorRect: DOMRect | null;
  targetWord: string;
  contextSentence?: string;
  articleTitle?: string;
  token?: string | null;
  curatedItem?: {
    word: string;
    meaning: string;
    phonetic?: string | null;
    exampleSentence?: string | null;
  } | null;
  onClose: () => void;
  onSelectWord?: (word: string) => void;
  onFlashcardSaved?: (word: string) => void;
  containerRef?: React.RefObject<HTMLElement | null>;
}

export function WordLookupPopover({
  isOpen,
  anchorRect,
  targetWord,
  contextSentence,
  articleTitle,
  token,
  curatedItem,
  onClose,
  onSelectWord,
  onFlashcardSaved,
  containerRef,
}: WordLookupPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  // Lookup state
  const [status, setStatus] = useState<"loading" | "success" | "not_found" | "error">("loading");
  const [data, setData] = useState<DictionaryLookupResult | null>(null);
  const [activeWord, setActiveWord] = useState<string>(targetWord);

  // Flashcard save state
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState<string>("Lưu Flashcard");

  // Position state
  const [position, setPosition] = useState<PopoverPosition>({ top: 0, left: 0, placement: "bottom" });

  useEffect(() => {
    setMounted(true);
  }, []);

  // Update active word when targetWord changes
  useEffect(() => {
    setActiveWord(targetWord);
    setSaveStatus("idle");
    setSaveMessage("Lưu Flashcard");
  }, [targetWord]);

  // Compute popover position anchored to anchorRect
  const updatePosition = useCallback(() => {
    if (!anchorRect) return;

    // the popover's real size once drawn (it grows from the loading state to the meaning)
    const popoverWidth = popoverRef.current?.offsetWidth || 320;
    const popoverHeight = popoverRef.current?.offsetHeight || 240;
    const padding = 12;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Horizontal centering clamped to viewport
    let left = anchorRect.left + anchorRect.width / 2 - popoverWidth / 2;
    left = Math.max(padding, Math.min(left, viewportWidth - popoverWidth - padding));

    // Vertical placement: prefer above, flip below if not enough room
    let top: number;
    let placement: "top" | "bottom" = "top";

    if (anchorRect.top - popoverHeight - 8 >= padding) {
      // Place above
      top = anchorRect.top - popoverHeight - 8;
      placement = "top";
    } else if (anchorRect.bottom + popoverHeight + 8 <= viewportHeight - padding) {
      // Place below
      top = anchorRect.bottom + 8;
      placement = "bottom";
    } else {
      // Fallback: clamp in viewport
      top = Math.max(padding, Math.min(anchorRect.bottom + 8, viewportHeight - popoverHeight - padding));
      placement = "bottom";
    }

    setPosition({ top, left, placement });
  }, [anchorRect]);

  useEffect(() => {
    if (!isOpen || !anchorRect) return;
    updatePosition();

    // Recompute on window scroll & resize
    const handleScrollOrResize = () => {
      updatePosition();
    };

    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    const ro = typeof ResizeObserver !== "undefined" && popoverRef.current ? new ResizeObserver(handleScrollOrResize) : null;
    if (ro && popoverRef.current) ro.observe(popoverRef.current);

    const container = containerRef?.current;
    if (container) {
      container.addEventListener("scroll", handleScrollOrResize);
    }

    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
      ro?.disconnect();
      if (container) {
        container.removeEventListener("scroll", handleScrollOrResize);
      }
    };
  }, [isOpen, anchorRect, updatePosition, containerRef]);

  // Lookup word with lemma fallback and session cache
  useEffect(() => {
    if (!isOpen || !activeWord) return;

    // If curated item is provided, prioritize it
    if (curatedItem && curatedItem.word.toLowerCase() === activeWord.toLowerCase()) {
      setStatus("success");
      setData({
        word: curatedItem.word,
        vietnameseMeaning: curatedItem.meaning,
        ipa: curatedItem.phonetic || undefined,
        example: curatedItem.exampleSentence || undefined,
      });
      return;
    }

    const cacheKey = activeWord.toLowerCase().trim();
    if (sessionLookupCache.has(cacheKey)) {
      setStatus("success");
      setData(sessionLookupCache.get(cacheKey)!);
      return;
    }

    const abortController = new AbortController();
    let isCancelled = false;

    const performLookup = async () => {
      setStatus("loading");
      setData(null);

      try {
        // 1. Direct lookup
        const result = await lookupDictionary(activeWord, {
          signal: abortController.signal,
          contextSentence,
        });

        if (isCancelled) return;

        if (result && result.vietnameseMeaning) {
          sessionLookupCache.set(cacheKey, result);
          setData(result);
          setStatus("success");
          return;
        }

        // 2. Multi-word phrase miss
        if (result?.isPhraseNotFound) {
          setData(result);
          setStatus("not_found");
          return;
        }

        // 3. Retry with lemma candidates (for inflected words: -s, -ed, -ing, 's, etc.)
        const lemmaCandidates = buildLemmaCandidates(activeWord);
        for (const cand of lemmaCandidates) {
          if (isCancelled) return;
          const candCacheKey = cand.toLowerCase().trim();
          if (sessionLookupCache.has(candCacheKey)) {
            const cachedResult = sessionLookupCache.get(candCacheKey)!;
            setData(cachedResult);
            setStatus("success");
            return;
          }

          const candResult = await lookupDictionary(cand, {
            signal: abortController.signal,
            contextSentence,
          });

          if (isCancelled) return;

          if (candResult && candResult.vietnameseMeaning) {
            sessionLookupCache.set(cacheKey, candResult);
            sessionLookupCache.set(candCacheKey, candResult);
            setData(candResult);
            setStatus("success");
            return;
          }
        }

        // 4. Not found
        setStatus("not_found");
      } catch (err: any) {
        if (err?.name === "AbortError" || isCancelled) return;
        setStatus("error");
      }
    };

    performLookup();

    return () => {
      isCancelled = true;
      abortController.abort();
    };
  }, [isOpen, activeWord, curatedItem, contextSentence]);

  // Dismiss on outside pointerdown or Escape
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Pronunciation handler via speechSynthesis
  const handleSpeak = (textToSpeak: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    // explicit pronunciation pauses Echo Music (10 §AG), like every other dictionary card
    window.dispatchEvent(new Event("ec:music-pause"));
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(textToSpeak);
      utterance.lang = "en-US";
      utterance.rate = 0.85;
      window.speechSynthesis.speak(utterance);
    } catch {
      // safe fallback
    }
  };

  // Save to flashcard API
  const handleSaveFlashcard = async () => {
    if (saveStatus === "saving" || saveStatus === "saved") return;

    const wordToSave = data?.word || activeWord;
    const meaningToSave = data?.vietnameseMeaning || curatedItem?.meaning || "";
    if (!wordToSave || !meaningToSave) return;

    const exampleToSave = data?.example || curatedItem?.exampleSentence || contextSentence || "";
    const ipaToSave = data?.ipa || curatedItem?.phonetic || undefined;

    setSaveStatus("saving");
    try {
      const payload: Record<string, any> = {
        front: wordToSave,
        back: meaningToSave,
        example: exampleToSave ? exampleToSave.slice(0, 300) : "Reading example",
      };
      if (ipaToSave) {
        payload.ipa = ipaToSave;
      }

      const res = await apiClient.post("/flashcards", payload);

      setSaveStatus("saved");
      setSaveMessage("Đã lưu vào bộ thẻ");
      onFlashcardSaved?.(wordToSave);
    } catch (err: any) {
      // Check for duplicate response (409 or already existing card message)
      if (
        err?.response?.status === 409 ||
        err?.response?.data?.message?.includes("already exists") ||
        err?.response?.data?.error?.includes("already exists")
      ) {
        setSaveStatus("saved");
        setSaveMessage("Đã có trong thẻ");
        onFlashcardSaved?.(wordToSave);
      } else {
        setSaveStatus("error");
        setSaveMessage("Lỗi, thử lại");
      }
    }
  };

  if (!mounted || !isOpen || !anchorRect) return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Tra cứu từ vựng"
      style={{
        position: "fixed",
        top: `${position.top}px`,
        left: `${position.left}px`,
        zIndex: 70,
      }}
      className={s.mini}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <MiniHeader
        word={data?.word || activeWord}
        pos={data?.partOfSpeech}
        ipa={data?.ipa || curatedItem?.phonetic || undefined}
        onSpeak={() => handleSpeak(data?.word || activeWord)}
        speakLabel="Phát âm"
        onClose={onClose}
      />

      {/* Body */}
      <div className={s.body} aria-live="polite">
        {status === "loading" && <MiniLoading text="Đang tra từ điển..." />}

        {status === "error" && (
          <div className={s.state}>
            <p className={`${s.stateText} ${s.stateError}`}>Lỗi kết nối từ điển.</p>
            <button
              type="button"
              onClick={() => {
                setStatus("loading");
                setActiveWord(activeWord + " ");
                setTimeout(() => setActiveWord(activeWord.trim()), 10);
              }}
              className={s.retry}
            >
              <RefreshCw aria-hidden="true" />
              <span>Thử lại</span>
            </button>
          </div>
        )}

        {status === "not_found" && (
          <div className={s.state}>
            {data?.isPhraseNotFound ? (
              <>
                <p className={s.stateText}>Không tìm thấy - hãy chọn từng từ</p>
                {data.candidateTokens && data.candidateTokens.length > 0 && (
                  <div className={s.tokens}>
                    {data.candidateTokens.map((tok, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          if (onSelectWord) {
                            onSelectWord(tok);
                          } else {
                            setActiveWord(tok);
                          }
                        }}
                        className={s.token}
                      >
                        {tok}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className={s.stateText}>
                Không tìm thấy từ <b>"{activeWord}"</b> trong từ điển.
              </p>
            )}
          </div>
        )}

        {status === "success" && data && (
          <>
            <p className={s.meaning}>{data.vietnameseMeaning}</p>

            {data.additionalMeanings && data.additionalMeanings.length > 1 && (
              <div className={s.alts}>
                {data.additionalMeanings.slice(1, 4).map((alt, idx) => (
                  <span key={idx}>{alt}</span>
                ))}
              </div>
            )}

            {data.example && (
              <p className={s.example}>
                <Quote className={s.exampleMark} aria-hidden="true" />
                <span>&ldquo;{data.example}&rdquo;</span>
              </p>
            )}
          </>
        )}
      </div>

      {/* Footer: [Lưu Flashcard] button */}
      {status === "success" && (
        <div className={s.actions}>
          <MiniSave
            full
            state={saveStatus}
            idle={saveMessage}
            saved={saveMessage}
            error={saveMessage}
            onClick={handleSaveFlashcard}
          />
        </div>
      )}
    </div>,
    document.body
  );
}
