"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { apiClient } from "@/services/api-client";

/** One suggestion of the dictionary corpus (`GET /dictionary/v2/suggest`). */
export interface VocabSuggestion {
  word: string;
  meaning: string | null;
}

interface VocabSearchComboboxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  vi: boolean;
  /** Visual variant: "theater" renders transparent input inside a liquid-glass wrapper. */
  variant?: "default" | "theater";
  /** Test seam: replaces the network request. */
  fetchSuggestions?: (q: string, signal: AbortSignal) => Promise<VocabSuggestion[]>;
}

const MIN_CHARS = 2;
const DEBOUNCE_MS = 160;
const LIMIT = 8;

async function fetchFromServer(q: string, signal: AbortSignal): Promise<VocabSuggestion[]> {
  const res = await apiClient.get<VocabSuggestion[]>("/dictionary/v2/suggest", { params: { q, limit: LIMIT }, signal });
  return Array.isArray(res.data) ? res.data.slice(0, LIMIT) : [];
}

/**
 * The vocabulary search of the Flashcards library with word suggestions from the dictionary corpus (ARIA 1.2
 * combobox + listbox). Typing filters the library as before; suggestions appear from two letters, ↑/↓ move, Enter or a
 * click picks one, Esc closes. Requests are debounced, bounded and cancelled when outdated; nothing is sent while an
 * IME is composing or for an empty field. No AI.
 */
export function VocabSearchCombobox({
  value,
  onChange,
  placeholder,
  inputRef,
  vi,
  variant = "default",
  fetchSuggestions = fetchFromServer,
}: VocabSearchComboboxProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<VocabSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  // the query the shown items answer (an empty answer is told only for the query it belongs to)
  const [settled, setSettled] = useState("");
  const composing = useRef(false);
  // set after a pick, so the picked word does not open the list again
  const suppressNext = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);

  const query = value.trim();
  useEffect(() => {
    if (suppressNext.current) {
      suppressNext.current = false;
      return;
    }
    if (composing.current || query.length < MIN_CHARS) {
      setItems([]);
      setLoading(false);
      setActive(-1);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setActive(-1);
    const timer = setTimeout(() => {
      fetchSuggestions(query, controller.signal)
        .then((rows) => {
          if (controller.signal.aborted) return;
          setItems(rows);
          setSettled(query);
          setActive(-1);
          setOpen(true);
        })
        .catch(() => {
          if (!controller.signal.aborted) setItems([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, fetchSuggestions]);

  // keep the highlighted option in view when the list scrolls
  useEffect(() => {
    if (active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const answered = settled === query && !loading;
  const showList = open && query.length >= MIN_CHARS && (items.length > 0 || answered);

  const pick = (s: VocabSuggestion) => {
    suppressNext.current = s.word !== value;
    onChange(s.word);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      if (!items.length) return;
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      if (showList && active >= 0 && items[active]) {
        e.preventDefault();
        pick(items[active]);
      }
    } else if (e.key === "Escape") {
      if (showList) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setActive(-1);
      }
    }
  };

  return (
    <div className="relative w-full">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-opt-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(e) => {
          composing.current = false;
          onChange((e.target as HTMLInputElement).value);
        }}
        placeholder={placeholder}
        aria-label={vi ? "Tìm từ vựng" : "Search vocabulary"}
        className={
          variant === "theater"
            ? "w-full h-11 pl-11 pr-24 bg-transparent text-indigo-950 dark:text-indigo-50 placeholder:text-indigo-900/45 dark:placeholder:text-indigo-200/45 rounded-2xl outline-none text-sm font-semibold transition"
            : "w-full pl-12 pr-24 py-3 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-400 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-medium transition"
        }
      />
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={vi ? "Gợi ý từ vựng" : "Word suggestions"}
        hidden={!showList}
        className={
          variant === "theater"
            ? "absolute left-0 right-0 top-full z-40 mt-2 max-h-72 overflow-y-auto rounded-2xl border border-indigo-200/70 bg-white/98 p-1.5 shadow-2xl dark:border-indigo-400/30 dark:bg-[#19174a]"
            : "absolute left-0 right-0 top-full z-30 mt-2 max-h-80 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        }
      >
        {items.length === 0 && answered && (
          <li role="presentation" className="px-3 py-2.5 text-sm text-slate-500 dark:text-slate-400">
            {vi ? "Không có gợi ý cho từ này." : "No suggestions for this word."}
          </li>
        )}
        {items.map((s, i) => (
          <li
            key={s.word}
            id={`${listId}-opt-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === active}
            // mousedown, not click: the input keeps focus (no blur closes the list first)
            onMouseDown={(e) => {
              e.preventDefault();
              pick(s);
            }}
            onMouseEnter={() => setActive(i)}
            className={`flex cursor-pointer items-baseline gap-3 rounded-xl px-3 py-2.5 ${
              i === active ? "bg-indigo-600 text-white" : "text-slate-800 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            <span className="shrink-0 text-sm font-bold" lang="en">{s.word}</span>
            {s.meaning && (
              <span className={`min-w-0 truncate text-xs ${i === active ? "text-indigo-100" : "text-slate-500 dark:text-slate-400"}`} lang="vi">
                {s.meaning}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
