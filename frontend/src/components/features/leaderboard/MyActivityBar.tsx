'use client';

import React from 'react';
import { BarChart3, Crown, Medal, Rocket, Zap } from 'lucide-react';
import { PlacementQuizButton } from './PlacementQuiz';
import { BoardAvatar } from './BoardAvatar';
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile';
import { useCurrentUserAvatar } from '@/hooks/useCurrentUserAvatar';
import {
  divisionLine,
  eligibilityNote,
  eligibilityOf,
  formatXp,
  HALL_TEXT,
  motivationLine,
  myRankText,
  nextRankProgress,
  publicSelfName,
  TEXT,
  UX_TEXT,
  type Locale,
  type MotivationTone,
} from '@/lib/leaderboard/format';
import type { ActivityItem, ActivityMeResponse } from '@/types/leaderboard';
import styles from './hall/hall.module.css';

const TONE_ICON: Record<MotivationTone, React.ReactNode> = {
  lead: <Crown className="h-4 w-4 shrink-0" aria-hidden="true" />,
  top: <Crown className="h-4 w-4 shrink-0" aria-hidden="true" />,
  chase: <Zap className="h-4 w-4 shrink-0" aria-hidden="true" />,
  start: <Rocket className="h-4 w-4 shrink-0" aria-hidden="true" />,
};

/**
 * "Thành tích của bạn" (the hall's right column on wide screens, under the podium otherwise): the learner's own identity,
 * rank (or the honest status from `eligibility`), XP of the selected period, all-time XP, a progress bar to the next rank and
 * one competitive line ("Còn 12 XP để vượt Nguyễn A") — all from /activity/me (+ its all-time read) and the loaded top
 * list; nothing is invented. Placement button when PLACEMENT_REQUIRED; "Điểm của bạn đến từ đâu" opens the breakdown.
 */
export function MyActivityBar({
  me,
  items = [],
  lifetimePoints,
  context,
  locale,
  onOpenBreakdown,
}: {
  me: ActivityMeResponse | undefined;
  /** Loaded top rows (rival name for the next rank when it is in the list; the learner's own frame when listed). */
  items?: ActivityItem[];
  /** All-time XP (Bảng chung, every skill) — undefined while unknown. */
  lifetimePoints?: number;
  /** "Tuần · Bảng chung": the partition these numbers belong to. */
  context?: string;
  locale: Locale;
  onOpenBreakdown: () => void;
}) {
  const t = TEXT[locale];
  const ux = UX_TEXT[locale];
  const h = HALL_TEXT[locale];
  const { effectiveDisplayName } = useCurrentUserProfile();
  const { avatarUrl } = useCurrentUserAvatar();
  const text = myRankText(me, locale);
  const division = divisionLine(me, locale);
  const motivation = motivationLine(me, items, locale);
  const progress = nextRankProgress(me);
  const ranked = me?.rank != null;
  const status = eligibilityOf(me);
  const note = eligibilityNote(me, locale);
  const own = me ? items.find((i) => i.userId === me.userId) : undefined;
  const name = own?.displayName ?? publicSelfName(effectiveDisplayName) ?? t.you;
  return (
    <section className={styles.achieve} data-testid="my-activity-bar" aria-label={h.achievementTitle}>
      <h2 className={styles.achieveHead}>
        <Medal className="h-5 w-5" aria-hidden="true" />
        {h.achievementTitle}
      </h2>
      <div className={styles.identity}>
        {me ? (
          <BoardAvatar userId={me.userId} name={name} avatarUrl={own?.avatarUrl ?? avatarUrl} frame={own?.avatarFrame ?? null} size="md" />
        ) : (
          <span className="h-16 w-16 shrink-0 rounded-full bg-white/10" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className={styles.identityName}>{me ? name : '…'}</p>
          <p className={styles.identityStatus}>{ranked ? context : text.rank}</p>
        </div>
      </div>
      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{h.rank}</span>
          <span className={styles.statValue} data-rank={ranked ? 'true' : undefined} data-muted={!ranked ? 'true' : undefined}>
            {me ? (ranked ? text.rank : '—') : '…'}
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{h.periodXp}</span>
          <span className={styles.statValue}>{me ? (me.points).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US') : '…'}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{h.lifetimeXp}</span>
          <span className={styles.statValue}>{lifetimePoints != null ? lifetimePoints.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US') : '…'}</span>
        </div>
      </div>
      {me && (
        <>
          {ranked && (
            <div
              role="progressbar"
              aria-label={ux.progressLabel}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              className={styles.bar}
            >
              {/* scaleX transition once per data change (GPU transform; no looping animation). */}
              <div className={styles.barFill} style={{ transform: `scaleX(${progress / 100})` }} />
            </div>
          )}
          {motivation && (
            <p className={styles.motive} data-tone={motivation.tone} data-testid="motivation-line">
              {TONE_ICON[motivation.tone]}
              <span className="min-w-0">{motivation.text}</span>
            </p>
          )}
          {note && <p className={styles.note} data-testid="my-eligibility-note">{note}</p>}
          {division && <p className={styles.note} data-testid="my-division-line">{division}</p>}
          {status === 'PLACEMENT_REQUIRED' && (
            <PlacementQuizButton locale={locale} testId="my-placement-button" className={styles.cyanBtn} />
          )}
          <button type="button" onClick={onOpenBreakdown} className={styles.ghostBtn}>
            <BarChart3 className="h-4 w-4" aria-hidden="true" />
            {t.breakdownButton}
            <span className="sr-only"> · {formatXp(me.points, locale)}</span>
          </button>
        </>
      )}
    </section>
  );
}
