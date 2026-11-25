'use client';

import React from 'react';
import { GraduationCap, History } from 'lucide-react';
import { PlacementQuizButton } from './PlacementQuiz';
import { useActivityMe, usePlacementMe } from '@/hooks/useLeaderboard';
import { PLACEMENT_DEFAULT_ITEMS, PLACEMENT_TEXT, showPlacementBanner, type Locale } from '@/lib/leaderboard/format';

/**
 * Leaderboard banner "Vào giải theo trình độ" for every learner the backend marks PLACEMENT_REQUIRED (no VALID quick
 * placement yet). Not dismissible: the quick placement is the only way into the ranking, and a full IELTS / TOEIC exam
 * is never required for it. Admins / excluded accounts (EXCLUDED) never see it; after a VALID placement the "me"
 * revalidation flips the status and the banner disappears without a reload.
 */
export function PlacementCtaCard({ locale }: { locale: Locale }) {
  const t = PLACEMENT_TEXT[locale];
  const me = useActivityMe('WEEK', 'GLOBAL', 'ALL');
  const placement = usePlacementMe();

  const active = placement.data?.activeAttempt ?? null;
  if (active) {
    // Unfinished, autosaved attempt (also for placed learners who are retaking): resume first, never a silent restart.
    return (
      <div
        data-testid="placement-resume-card"
        className="flex flex-col gap-3 rounded-3xl border border-amber-400/40 bg-gradient-to-r from-amber-500/15 via-orange-500/10 to-transparent p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5"
      >
        <div className="flex min-w-0 items-start gap-3">
          <History className="mt-0.5 h-7 w-7 shrink-0 text-amber-500" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-base font-bold text-slate-900 dark:text-white">{t.resumeTitle}</p>
            <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{t.resumeProgress(active.answered, active.total)}</p>
          </div>
        </div>
        <PlacementQuizButton locale={locale} label={t.resume} testId="resume-card-button" />
      </div>
    );
  }
  if (!showPlacementBanner(me.data)) return null;
  const items = placement.data?.itemCount ?? PLACEMENT_DEFAULT_ITEMS;

  return (
    <div
      data-testid="placement-cta-card"
      className="flex flex-col gap-3 rounded-3xl border border-sky-400/40 bg-gradient-to-r from-sky-500/15 via-blue-500/10 to-transparent p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
      <div className="flex min-w-0 items-start gap-3">
        <GraduationCap className="mt-0.5 h-7 w-7 shrink-0 text-sky-500" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-base font-bold text-slate-900 dark:text-white">{t.ctaCardTitle}</p>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{t.ctaCardBody}</p>
          <p className="mt-1 text-xs font-medium text-slate-500 dark:text-slate-400" data-testid="placement-cta-meta">{t.ctaCardMeta(items)}</p>
        </div>
      </div>
      <PlacementQuizButton locale={locale} testId="cta-card-placement-button" />
    </div>
  );
}

/** Shown above an empty division board for a learner without a level (division chips). */
export function DivisionPlacementCta({ locale }: { locale: Locale }) {
  const t = PLACEMENT_TEXT[locale];
  return (
    <div data-testid="division-placement-cta" className="flex flex-col gap-3 rounded-2xl border border-dashed border-sky-400/50 bg-sky-500/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{t.divisionCta}</p>
      <PlacementQuizButton locale={locale} label={t.takeQuiz} testId="division-placement-button" />
    </div>
  );
}
