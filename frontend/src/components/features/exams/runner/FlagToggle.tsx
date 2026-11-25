'use client';

import React from 'react';
import { Flag } from 'lucide-react';
import type { UxLang } from '@/lib/exams/runnerModel';

interface FlagToggleProps {
  flagged: boolean;
  onToggle: () => void;
  lang: UxLang;
  number?: number;
  /** Show the text label next to the icon (roomy layouts). */
  withLabel?: boolean;
}

/** Exams Phase 7 — "Đánh dấu xem lại" toggle (aria-pressed, icon fill + text, not colour alone). */
export function FlagToggle({ flagged, onToggle, lang, number, withLabel = false }: FlagToggleProps) {
  const label = flagged
    ? lang === 'vi' ? 'Bỏ đánh dấu' : 'Unmark'
    : lang === 'vi' ? 'Đánh dấu xem lại' : 'Mark for review';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={flagged}
      aria-label={number !== undefined ? `${label} – ${lang === 'vi' ? 'câu' : 'question'} ${number}` : label}
      title={label}
      className={`shrink-0 inline-flex items-center gap-1.5 h-8 rounded-lg border text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        withLabel ? 'px-2.5' : 'w-8 justify-center'
      } ${
        flagged
          ? 'bg-amber-400/20 border-amber-500/50 text-amber-800 dark:text-amber-200'
          : 'bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-muted'
      }`}
    >
      <Flag className={`w-3.5 h-3.5 ${flagged ? 'fill-current' : ''}`} aria-hidden />
      {withLabel && <span className="hidden sm:inline">{flagged ? (lang === 'vi' ? 'Đã đánh dấu' : 'Marked') : label}</span>}
    </button>
  );
}

export default FlagToggle;
