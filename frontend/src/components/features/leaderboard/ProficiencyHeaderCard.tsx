'use client';

import React from 'react';
import Link from 'next/link';
import { Award, EyeOff, GraduationCap } from 'lucide-react';
import { PlacementQuizButton } from './PlacementQuiz';
import { ProficiencyPathsCard } from './ProficiencyPathsCard';
import { proficiencyHeaderState, proficiencyPathsMode, TEXT, type Locale } from '@/lib/leaderboard/format';
import type { ProficiencyBoardMeResponse } from '@/types/leaderboard';

/** Current user's standing on the selected Năng lực board. Hidden entirely for EXCLUDED accounts. */
export function ProficiencyHeaderCard({
  me,
  placementCta,
  placementCefr = null,
  skillBoard = false,
  locale,
  onOpenLevel,
}: {
  me: ProficiencyBoardMeResponse | undefined;
  placementCta: string | null | undefined;
  /** Latest VALID placement result (no exam-based level yet). */
  placementCefr?: string | null;
  /** Nghe / Đọc / Viết / Nói board (placement gives a general level only). */
  skillBoard?: boolean;
  locale: Locale;
  onOpenLevel: () => void;
}) {
  const state = proficiencyHeaderState(me, placementCta, locale, placementCefr, skillBoard);
  if (!state) return null;
  // No level / quick-placement level only: show BOTH paths (quick placement first, standardized exam optional).
  const pathsMode = proficiencyPathsMode(state);
  if (pathsMode) {
    return <ProficiencyPathsCard mode={pathsMode} state={state} locale={locale} onOpenLevel={onOpenLevel} skillBoard={skillBoard} />;
  }
  const t = TEXT[locale];
  const ranked = state.kind === 'RANKED' || state.kind === 'HIDDEN';
  return (
    <div
      data-testid="proficiency-header"
      data-kind={state.kind}
      className="flex flex-col gap-3 rounded-3xl border border-sky-400/30 bg-gradient-to-r from-sky-500/10 via-blue-500/5 to-transparent p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
      <div className="flex min-w-0 items-start gap-3">
        {ranked ? (
          <Award className="mt-0.5 h-6 w-6 shrink-0 text-amber-400" aria-hidden="true" />
        ) : (
          <GraduationCap className="mt-0.5 h-6 w-6 shrink-0 text-sky-400" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className={ranked ? 'text-xl font-black text-slate-900 dark:text-white' : 'text-sm font-semibold text-slate-800 dark:text-slate-100'}>
            {state.title}
          </p>
          {state.note && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              {state.kind === 'HIDDEN' && <EyeOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              {state.note}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {state.placementQuiz && <PlacementQuizButton locale={locale} testId="header-placement-button" />}
        {state.cta && (
          <Link
            href={state.cta.href}
            data-testid="header-verify-link"
            className={state.ctaSecondary
              ? 'inline-flex items-center rounded-xl border border-sky-400/50 px-4 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-sky-200'
              : 'inline-flex items-center rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300'}
          >
            {state.cta.label}
          </Link>
        )}
        <button
          type="button"
          onClick={onOpenLevel}
          className="inline-flex items-center rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {t.viewMyLevel}
        </button>
      </div>
    </div>
  );
}
