'use client';

import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Flag, LayoutGrid, Lock } from 'lucide-react';
import { ExamDialog } from './ExamDialog';
import type { NavigatorEntry, NavigatorPart, UxLang } from '@/lib/exams/runnerModel';
import { summarizeNavigator } from '@/lib/exams/runnerModel';

interface ExamNavigatorProps {
  parts: NavigatorPart[];
  lang: UxLang;
  onSelect: (placementId: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
  /** Entries the learner may not jump to right now (TOEIC Listening simulation follows the recording). */
  isLocked?: (entry: NavigatorEntry) => boolean;
}

type Filter = 'ALL' | 'UNANSWERED' | 'FLAGGED';

function entryAriaLabel(e: NavigatorEntry, lang: UxLang, locked: boolean): string {
  const parts = [lang === 'vi' ? `Câu ${e.number}` : `Question ${e.number}`];
  parts.push(e.answered ? (lang === 'vi' ? 'đã trả lời' : 'answered') : lang === 'vi' ? 'chưa trả lời' : 'unanswered');
  if (e.flagged) parts.push(lang === 'vi' ? 'đã đánh dấu xem lại' : 'marked for review');
  if (e.current) parts.push(lang === 'vi' ? 'đang xem' : 'current');
  if (locked) parts.push(lang === 'vi' ? 'đang khóa' : 'locked');
  return parts.join(', ');
}

/**
 * One question chip. State is never colour-only: answered = filled tile, unanswered = dashed outline, current = thick
 * ring + bold, flagged = flag glyph in the corner, locked = lock glyph.
 */
function QuestionChip({
  entry,
  lang,
  locked,
  onSelect,
  size = 'sm',
}: {
  entry: NavigatorEntry;
  lang: UxLang;
  locked: boolean;
  onSelect: (pid: string) => void;
  size?: 'sm' | 'md';
}) {
  const dims = size === 'md' ? 'min-w-10 h-10 text-sm' : 'min-w-8 h-8 text-xs';
  const state = entry.current
    ? 'bg-primary text-primary-foreground border-primary ring-2 ring-primary/40 ring-offset-1 ring-offset-background font-extrabold'
    : entry.answered
    ? 'bg-sky-500/15 dark:bg-sky-400/15 text-sky-800 dark:text-sky-200 border-sky-500/50 font-bold'
    : 'bg-background text-muted-foreground border-dashed border-border hover:border-foreground/40 hover:text-foreground font-semibold';
  return (
    <button
      type="button"
      onClick={() => !locked && onSelect(entry.placementId)}
      disabled={locked}
      aria-label={entryAriaLabel(entry, lang, locked)}
      aria-current={entry.current ? 'true' : undefined}
      data-nav-state={entry.current ? 'current' : entry.answered ? 'answered' : 'unanswered'}
      data-nav-flagged={entry.flagged ? 'true' : 'false'}
      className={`relative px-1.5 rounded-md border tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${dims} ${state} ${
        locked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      {entry.number}
      {entry.flagged && (
        <Flag
          className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 p-[1px] rounded-full bg-amber-400 text-amber-950 fill-current"
          aria-hidden
        />
      )}
      {locked && <Lock className="absolute -bottom-1 -right-1 w-3 h-3 text-muted-foreground" aria-hidden />}
    </button>
  );
}

/**
 * Exams Phase 7 — question navigator: a compact bottom bar (progress, prev / next, inline chips on desktop) plus a full
 * "Bảng câu hỏi" sheet grouped by part and printed group. Sets keep their group context (one framed block per set).
 */
export function ExamNavigator({ parts, lang, onSelect, onPrev, onNext, canPrev = true, canNext = true, isLocked }: ExamNavigatorProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('ALL');
  const summary = useMemo(() => summarizeNavigator(parts), [parts]);
  const locked = (e: NavigatorEntry) => (isLocked ? isLocked(e) : false);

  const select = (pid: string) => {
    onSelect(pid);
    setOpen(false);
  };

  const visible = (e: NavigatorEntry) =>
    filter === 'ALL' ? true : filter === 'UNANSWERED' ? !e.answered : e.flagged;

  const legend = (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground" aria-label={lang === 'vi' ? 'Chú thích' : 'Legend'}>
      <li className="flex items-center gap-1.5">
        <span className="w-4 h-4 rounded border bg-sky-500/15 border-sky-500/50" aria-hidden />
        {lang === 'vi' ? 'Đã trả lời' : 'Answered'}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="w-4 h-4 rounded border border-dashed border-border" aria-hidden />
        {lang === 'vi' ? 'Chưa trả lời' : 'Unanswered'}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="w-4 h-4 rounded bg-primary ring-2 ring-primary/40" aria-hidden />
        {lang === 'vi' ? 'Đang xem' : 'Current'}
      </li>
      <li className="flex items-center gap-1.5">
        <Flag className="w-3.5 h-3.5 p-[1px] rounded-full bg-amber-400 text-amber-950 fill-current" aria-hidden />
        {lang === 'vi' ? 'Đánh dấu xem lại' : 'Marked for review'}
      </li>
    </ul>
  );

  const progressText = (
    <span className="text-xs text-muted-foreground whitespace-nowrap">
      <span className="font-bold text-foreground tabular-nums">{summary.answered}</span>/{summary.total}
      <span className="hidden sm:inline"> {lang === 'vi' ? 'đã trả lời' : 'answered'}</span>
      {summary.flagged > 0 && (
        <span className="ml-2 inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
          <Flag className="w-3 h-3 fill-current" aria-hidden />
          <span className="tabular-nums">{summary.flagged}</span>
        </span>
      )}
    </span>
  );

  return (
    <>
      <nav
        id="question-palette-bar"
        aria-label={lang === 'vi' ? 'Điều hướng câu hỏi' : 'Question navigation'}
        className="shrink-0 border-t border-border bg-card/95 backdrop-blur px-3 sm:px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] z-30"
      >
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="shrink-0 flex items-center gap-2">
            <div className="w-16 sm:w-20 h-1.5 rounded-full bg-muted overflow-hidden" aria-hidden>
              <div
                className="h-full bg-sky-500 dark:bg-sky-400 transition-[width] duration-300"
                style={{ width: `${summary.total ? (summary.answered / summary.total) * 100 : 0}%` }}
              />
            </div>
            {progressText}
          </div>

          {/* Desktop inline chips: one strip per part, sets framed together */}
          <div className="hidden md:flex flex-1 min-w-0 items-center gap-3 overflow-x-auto py-1.5 [scrollbar-width:thin]">
            {parts.map((part) => (
              <div key={part.key} className="flex items-center gap-1.5 shrink-0">
                {parts.length > 1 && (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                    {part.label}
                  </span>
                )}
                {part.groups.map((g) => (
                  <div
                    key={g.groupId}
                    className={`flex items-center gap-1 ${g.entries.length > 1 ? 'p-0.5 rounded-lg bg-muted/50 border border-border/60' : ''}`}
                  >
                    {g.entries.map((e) => (
                      <QuestionChip key={e.placementId} entry={e} lang={lang} locked={locked(e)} onSelect={onSelect} />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="flex-1 md:hidden" />

          <div className="shrink-0 flex items-center gap-1.5">
            {onPrev && (
              <button
                type="button"
                onClick={onPrev}
                disabled={!canPrev}
                aria-label={lang === 'vi' ? 'Câu trước' : 'Previous question'}
                className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-border text-foreground hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeft className="w-4 h-4" aria-hidden />
              </button>
            )}
            {onNext && (
              <button
                type="button"
                onClick={onNext}
                disabled={!canNext}
                aria-label={lang === 'vi' ? 'Câu tiếp theo' : 'Next question'}
                className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-border text-foreground hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight className="w-4 h-4" aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-haspopup="dialog"
              className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-muted hover:bg-muted/80 text-foreground text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LayoutGrid className="w-4 h-4" aria-hidden />
              <span>{lang === 'vi' ? 'Bảng câu hỏi' : 'All questions'}</span>
            </button>
          </div>
        </div>
      </nav>

      <ExamDialog
        open={open}
        onClose={() => setOpen(false)}
        placement="sheet"
        size="lg"
        title={lang === 'vi' ? 'Bảng câu hỏi' : 'All questions'}
        description={
          lang === 'vi'
            ? `Đã trả lời ${summary.answered}/${summary.total} · Chưa trả lời ${summary.unanswered} · Đánh dấu ${summary.flagged}`
            : `Answered ${summary.answered}/${summary.total} · Unanswered ${summary.unanswered} · Marked ${summary.flagged}`
        }
        closeLabel={lang === 'vi' ? 'Đóng' : 'Close'}
      >
        <div className="space-y-4">
          <div role="radiogroup" aria-label={lang === 'vi' ? 'Lọc câu hỏi' : 'Filter questions'} className="flex flex-wrap gap-1.5">
            {(['ALL', 'UNANSWERED', 'FLAGGED'] as Filter[]).map((f) => {
              const label =
                f === 'ALL'
                  ? lang === 'vi' ? 'Tất cả' : 'All'
                  : f === 'UNANSWERED'
                  ? lang === 'vi' ? `Chưa trả lời (${summary.unanswered})` : `Unanswered (${summary.unanswered})`
                  : lang === 'vi' ? `Đánh dấu (${summary.flagged})` : `Marked (${summary.flagged})`;
              return (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={filter === f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    filter === f ? 'bg-foreground text-background border-foreground' : 'bg-background text-muted-foreground border-border hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {legend}
          {parts.map((part) => {
            const groups = part.groups
              .map((g) => ({ ...g, entries: g.entries.filter(visible) }))
              .filter((g) => g.entries.length > 0);
            if (groups.length === 0) return null;
            return (
              <section key={part.key} aria-label={part.label} className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                  <span>{part.label}</span>
                  <span className="normal-case tracking-normal font-medium tabular-nums">
                    {part.answered}/{part.total}
                  </span>
                </h3>
                <div className="flex flex-wrap gap-2">
                  {groups.map((g) => (
                    <div
                      key={g.groupId}
                      className={`flex flex-wrap gap-1.5 ${g.entries.length > 1 ? 'p-1 rounded-lg bg-muted/50 border border-border/60' : ''}`}
                    >
                      {g.entries.map((e) => (
                        <QuestionChip key={e.placementId} entry={e} lang={lang} locked={locked(e)} onSelect={select} size="md" />
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          {filter !== 'ALL' && parts.every((p) => p.groups.every((g) => g.entries.filter(visible).length === 0)) && (
            <p className="text-xs text-muted-foreground py-4 text-center">
              {filter === 'UNANSWERED'
                ? lang === 'vi' ? 'Bạn đã trả lời tất cả câu hỏi.' : 'Every question has an answer.'
                : lang === 'vi' ? 'Chưa có câu nào được đánh dấu.' : 'No question is marked.'}
            </p>
          )}
        </div>
      </ExamDialog>
    </>
  );
}

export default ExamNavigator;
