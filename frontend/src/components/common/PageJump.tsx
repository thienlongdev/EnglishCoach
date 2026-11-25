"use client";

import React, { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import s from "./pageJump.module.css";

/**
 * One pager for content-heavy lists (2026-11-20): previous · a page-number field · "/ total" · next, all on one optically
 * centred row of equal heights. The field accepts a number and jumps on Enter (or when it loses focus); anything that is not
 * a page of this list puts the current page back and says the valid range. Pages are 1-based here. Colours come from the
 * host's tokens (`--pager-ink`, `--pager-ink-2`, `--pager-line`, `--pager-fill`, `--pager-accent`) with neutral fallbacks.
 */
export function PageJump({ page, pages, onPage, vi = true, label, summary, className }: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
  vi?: boolean;
  /** accessible name of the navigation landmark */
  label?: string;
  /** optional text before the controls, e.g. "257 kết quả" */
  summary?: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  const total = Math.max(1, Math.floor(pages));
  const current = Math.min(total, Math.max(1, Math.floor(page)));
  const [draft, setDraft] = useState(String(current));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(String(current)); setInvalid(false); }, [current]);

  const commit = () => {
    const text = draft.trim();
    if (text === "" || text === String(current)) { setDraft(String(current)); setInvalid(false); return; }
    const n = /^\d{1,6}$/.test(text) ? Number(text) : NaN;
    if (!Number.isFinite(n) || n < 1 || n > total) { setDraft(String(current)); setInvalid(true); return; }
    setInvalid(false);
    if (n !== current) onPage(n);
  };

  return (
    <nav className={`${s.pager} ${className ?? ""}`} aria-label={label ?? (vi ? "Phân trang" : "Pagination")}>
      {summary != null && <span className={s.summary}>{summary}</span>}
      <button type="button" className={s.step} disabled={current <= 1} onClick={() => onPage(current - 1)} aria-label={vi ? "Trang trước" : "Previous page"}>
        <ChevronLeft className={s.icon} aria-hidden="true" />
        <span className={s.stepText}>{vi ? "Trước" : "Previous"}</span>
      </button>
      <form className={s.jump} onSubmit={(e) => { e.preventDefault(); commit(); }}>
        <label htmlFor={`${id}-page`} className={s.srOnly}>{vi ? `Đến trang (1–${total})` : `Go to page (1–${total})`}</label>
        <input
          id={`${id}-page`}
          className={s.field}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="go"
          value={draft}
          size={Math.max(1, String(total).length)}
          style={{ ["--digits" as string]: String(Math.max(2, String(total).length)) }}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => { setDraft(e.target.value.replace(/[^\d]/g, "").slice(0, 6)); setInvalid(false); }}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Escape") { setDraft(String(current)); setInvalid(false); } }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <span className={s.total} aria-hidden="true">/ {total}</span>
        <span id={`${id}-hint`} className={invalid ? s.hint : s.srOnly} role={invalid ? "status" : undefined}>
          {invalid ? (vi ? `Chọn trang từ 1 đến ${total}` : `Choose a page from 1 to ${total}`) : (vi ? `Trang ${current} trên ${total}` : `Page ${current} of ${total}`)}
        </span>
      </form>
      <button type="button" className={s.step} disabled={current >= total} onClick={() => onPage(current + 1)} aria-label={vi ? "Trang sau" : "Next page"}>
        <span className={s.stepText}>{vi ? "Sau" : "Next"}</span>
        <ChevronRight className={s.icon} aria-hidden="true" />
      </button>
    </nav>
  );
}
