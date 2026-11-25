'use client';

import React from 'react';
import Link from 'next/link';
import { ChevronRight, Trophy } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useActivityMe, useProficiencyMe } from '@/hooks/useLeaderboard';
import { TEXT, widgetLines, type Locale } from '@/lib/leaderboard/format';

/**
 * Slim dashboard row inside the hero "Chỉ số học tập" panel: weekly Thi đua rank (default scope) +
 * current CEFR. Fixed height in every state; does not touch the Content Hub layout.
 */
export function LeaderboardWidget() {
  const { locale } = useLanguage();
  const l: Locale = locale === 'en' ? 'en' : 'vi';
  const activity = useActivityMe('WEEK', null, 'ALL', { live: false });
  const profile = useProficiencyMe();
  const loading = (activity.isLoading && !activity.data) || (profile.isLoading && !profile.data);
  const lines = widgetLines(activity.data, profile.data?.overall, l);

  return (
    <Link
      href="/leaderboard"
      data-testid="leaderboard-widget"
      className="flex h-14 items-center gap-3 rounded-2xl border border-indigo-900/10 bg-white/60 px-4 text-slate-800 shadow-[inset_0_1px_0_#fff] transition-colors hover:border-indigo-500/30 hover:bg-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 dark:border-white/10 dark:bg-[rgba(3,12,32,0.42)] dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] dark:hover:border-white/20 dark:hover:bg-[rgba(3,12,32,0.58)] dark:focus-visible:ring-cyan-200"
      aria-label={`${TEXT[l].title}: ${lines.rank}, ${lines.level}`}
    >
      <Trophy className="h-5 w-5 shrink-0 text-amber-500 dark:text-amber-300" aria-hidden="true" />
      {loading ? (
        <span className="h-3 flex-1 rounded bg-indigo-900/10 animate-pulse motion-reduce:animate-none dark:bg-white/20" />
      ) : (
        <span className="min-w-0 flex-1 line-clamp-2 text-xs font-semibold leading-snug sm:text-[13px]">
          {lines.rank}
          <span className="mx-1.5 text-slate-400 dark:text-white/50" aria-hidden="true">·</span>
          <span className="text-indigo-600 dark:text-cyan-200">{lines.level}</span>
        </span>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 dark:text-white/70" aria-hidden="true" />
    </Link>
  );
}
