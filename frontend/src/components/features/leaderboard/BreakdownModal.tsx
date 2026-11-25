'use client';

import React from 'react';
import { LeaderboardModal } from './BoardStates';
import { formatXp, sourceName, TEXT, type Locale } from '@/lib/leaderboard/format';
import type { SourceBreakdown } from '@/types/leaderboard';

/** "Điểm của bạn đến từ đâu": per-source points of the selected period (display-rounded per source). */
export function BreakdownModal({
  open,
  onClose,
  breakdown,
  total,
  periodLabel,
  locale,
}: {
  open: boolean;
  onClose: () => void;
  breakdown: SourceBreakdown[];
  total: number;
  periodLabel: string;
  locale: Locale;
}) {
  const t = TEXT[locale];
  const max = Math.max(1, ...breakdown.map((b) => b.points));
  return (
    <LeaderboardModal open={open} title={t.breakdownButton} closeLabel={t.close} onClose={onClose}>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        {periodLabel} · <span className="font-bold text-slate-800 dark:text-slate-100">{formatXp(total, locale)}</span>
      </p>
      {breakdown.length === 0 ? (
        <p className="rounded-2xl bg-slate-50 dark:bg-white/[0.03] p-4 text-sm text-slate-500 dark:text-slate-400">{t.breakdownEmpty}</p>
      ) : (
        <ul className="space-y-3" data-testid="breakdown-list">
          {breakdown.map((b) => (
            <li key={b.sourceModule}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium text-slate-700 dark:text-slate-200">{sourceName(b.sourceModule, locale)}</span>
                <span className="shrink-0 font-bold text-slate-900 dark:text-white">{formatXp(b.points, locale)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]" aria-hidden="true">
                <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-blue-500" style={{ width: `${(b.points / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-5 border-t border-slate-100 dark:border-slate-800 pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        {t.breakdownFootnote}
      </p>
    </LeaderboardModal>
  );
}
