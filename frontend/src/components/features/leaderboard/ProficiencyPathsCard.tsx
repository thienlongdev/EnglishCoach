'use client';

import React from 'react';
import Link from 'next/link';
import { BadgeCheck, GraduationCap, Timer } from 'lucide-react';
import { PlacementQuizButton } from './PlacementQuiz';
import { usePlacementMe } from '@/hooks/useLeaderboard';
import {
  formatVnDate,
  levelWithSource,
  PATHS_TEXT,
  PLACEMENT_DEFAULT_ITEMS,
  PLACEMENT_TEXT,
  TEXT,
  type HeaderState,
  type Locale,
  type PathsMode,
} from '@/lib/leaderboard/format';

const QUICK_BTN =
  'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-blue-500/25 hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300';
const STD_BTN =
  'inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-white/[0.06]';

/** Quick-placement action for the caller's state: resume an unfinished attempt, take / retake, or the retake date. */
function QuickAction({ mode, locale, compact = false }: { mode: PathsMode; locale: Locale; compact?: boolean }) {
  const p = PATHS_TEXT[locale];
  const { data } = usePlacementMe();
  const className = compact ? undefined : QUICK_BTN;
  if (data?.activeAttempt) {
    return <PlacementQuizButton locale={locale} label={p.quickResume} className={className} testId="paths-quick-resume" />;
  }
  if (mode === 'PLACEMENT' && data && !data.canRetake) {
    const date = formatVnDate(data.retakeAvailableAt);
    return (
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400" data-testid="paths-quick-locked">
        {date ? PLACEMENT_TEXT[locale].retakeOn(date) : PLACEMENT_TEXT[locale].lockedTitle}
      </p>
    );
  }
  return (
    <PlacementQuizButton
      locale={locale}
      label={mode === 'PLACEMENT' ? p.quickRetake : p.quickCta}
      className={className}
      testId={mode === 'PLACEMENT' ? 'paths-quick-retake' : 'paths-quick-start'}
    />
  );
}

/**
 * Large Năng lực card for learners without an exam-based level: BOTH ways forward, side by side on desktop and stacked
 * on mobile — the quick placement (primary: ~4 min, 30 questions, vocabulary + grammar, opens the leaderboard) and the
 * standardized exam (secondary, "Tùy chọn": in-depth verification in the Exam Center). The quick result is shown as an
 * estimate ("B1 · Theo bài xếp lớp"), never as a verified level.
 */
export function ProficiencyPathsCard({ mode, state, locale, onOpenLevel, skillBoard = false }: {
  mode: PathsMode;
  state: HeaderState;
  locale: Locale;
  onOpenLevel: () => void;
  /** Nghe / Đọc / Viết / Nói board: the placement is a general level, so the headline stays "not verified for this skill". */
  skillBoard?: boolean;
}) {
  const p = PATHS_TEXT[locale];
  const { data } = usePlacementMe();
  const items = data?.itemCount ?? PLACEMENT_DEFAULT_ITEMS;
  const overallPlacement = mode === 'PLACEMENT' && !skillBoard && !!data?.resultCefr;
  const headline = mode === 'NONE' ? p.undetermined
    : overallPlacement ? (levelWithSource(data?.resultCefr ?? null, 'PLACEMENT', locale) ?? state.title)
      : state.title;
  const sub = mode === 'NONE' ? null : overallPlacement ? p.placementEstimate : state.note;

  return (
    <section
      data-testid="proficiency-paths"
      data-mode={mode}
      className="space-y-4 rounded-3xl border border-sky-400/30 bg-gradient-to-br from-sky-500/10 via-blue-500/5 to-violet-500/5 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-black text-slate-900 dark:text-white" data-testid="proficiency-paths-headline">{headline}</p>
          {sub && <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{sub}</p>}
        </div>
        <button
          type="button"
          onClick={onOpenLevel}
          className="shrink-0 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-white/[0.06]"
        >
          {TEXT[locale].viewMyLevel}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="relative flex flex-col gap-2 rounded-2xl border-2 border-cyan-400/60 bg-white p-4 shadow-lg shadow-cyan-500/10 dark:bg-[#0b1730]" data-testid="paths-quick">
          <span className="absolute right-3 top-3 rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
            {p.quickBadge}
          </span>
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-600 dark:text-cyan-300">
              <GraduationCap className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="font-bold text-slate-900 dark:text-white">{p.quickTitle}</p>
          </div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-cyan-700 dark:text-cyan-300">
            <Timer className="h-4 w-4" aria-hidden="true" /> {p.quickMeta(items)}
          </p>
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{p.quickSkills}</p>
          <p className="text-sm text-slate-600 dark:text-slate-300">{p.quickBody}</p>
          <div className="mt-auto pt-1"><QuickAction mode={mode} locale={locale} /></div>
        </div>

        <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-slate-700 dark:bg-white/[0.03]" data-testid="paths-standardized">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300">
              <BadgeCheck className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="font-bold text-slate-900 dark:text-white">{p.stdTitle}</p>
            <span className="ml-auto rounded-full border border-slate-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-600 dark:text-slate-400">
              {p.optional}
            </span>
          </div>
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{p.stdMeta}</p>
          <p className="text-sm text-slate-600 dark:text-slate-300">{p.stdBody}</p>
          <div className="mt-auto pt-1">
            <Link href="/exams" className={STD_BTN} data-testid="paths-standardized-link">
              {mode === 'PLACEMENT' ? p.stdVerifyCta : p.stdCta}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Compact version for the empty Năng lực board: context line (placed learners) + both actions, no second big card. */
export function ProficiencyPathButtons({ mode, locale }: { mode: PathsMode; locale: Locale }) {
  const p = PATHS_TEXT[locale];
  const { data } = usePlacementMe();
  return (
    <div className="flex flex-col items-center gap-3" data-testid="empty-paths">
      {mode === 'PLACEMENT' && data?.resultCefr && (
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200" data-testid="empty-paths-context">{p.emptyPlaced(data.resultCefr)}</p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <QuickAction mode={mode} locale={locale} compact />
        <Link
          href="/exams"
          data-testid="empty-verify-link"
          className="inline-flex items-center rounded-xl border border-sky-400/50 px-4 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-500/10 dark:text-sky-200"
        >
          {mode === 'PLACEMENT' ? p.stdVerifyCta : p.stdShort}
        </Link>
      </div>
    </div>
  );
}
