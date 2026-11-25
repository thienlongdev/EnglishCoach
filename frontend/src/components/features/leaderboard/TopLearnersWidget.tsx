'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Trophy } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useActivityBoard, useActivityMe, WIDGET_SETTLE_MS } from '@/hooks/useLeaderboard';
import { Podium } from './Podium';
import { BoardRowCard } from './BoardRowCard';
import styles from './TopLearnersWidget.module.css';
import {
  DEFAULT_COMPETITIVE_PERIOD,
  formatXp,
  periodRangeLabel,
  TEXT,
  topLearnersTitle,
  WIDGET_PERIODS,
  widgetRows,
  widgetSeeAllHref,
  type Locale,
} from '@/lib/leaderboard/format';

type WidgetPeriod = 'WEEK' | 'MONTH';

/**
 * Home card "Top học viên tuần này": Bảng chung, default Tuần (= the full leaderboard's default), small Tuần | Tháng
 * switch — podium (top 3) + rows #4 and #5 + "Xem tất cả". Same SWR keys as the leaderboard (period in the key), so
 * both screens show the same numbers for the same period. On the dashboard it sits beside today's content as an Echo Glass
 * panel (pearl / night) holding a dark crystal stage for the podium; the rows follow the theme.
 */
export function TopLearnersWidget() {
  const { locale } = useLanguage();
  const l: Locale = locale === 'en' ? 'en' : 'vi';
  const t = TEXT[l];
  const [period, setPeriod] = useState<WidgetPeriod>(DEFAULT_COMPETITIVE_PERIOD);
  const board = useActivityBoard(period, 'GLOBAL', 'ALL', { live: false });
  const me = useActivityMe(period, 'GLOBAL', 'ALL', { live: false });
  const items = (board.data?.items ?? []).slice(0, 5);
  const meId = me.data?.userId ?? null;
  const { rows } = widgetRows(items);
  const title = topLearnersTitle(period, l);
  const range = periodRangeLabel(board.data?.periodStartsAt, board.data?.periodEndsAt);

  // One follow-up read after opening the dashboard / switching period: an activity finished seconds ago is ranked by
  // the backend's live refresh within a few seconds, so the card never keeps pre-activity XP until the next minute.
  const { mutate: refreshBoard } = board;
  const { mutate: refreshMe } = me;
  useEffect(() => {
    const id = window.setTimeout(() => {
      void refreshBoard();
      void refreshMe();
    }, WIDGET_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [period, refreshBoard, refreshMe]);

  return (
    <section
      data-testid="top-learners-widget"
      aria-label={title}
      className={styles.panel}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={styles.title}>
            <span className={styles.trophy} aria-hidden="true"><Trophy className="h-[19px] w-[19px]" /></span>
            {title}
          </h2>
          {range && (
            <p data-testid="top-learners-range" className={styles.range}>
              {range}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div role="tablist" aria-label={l === 'vi' ? 'Kỳ' : 'Period'} className={styles.tabs}>
            {WIDGET_PERIODS.map((o) => {
              const selected = o.id === period;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setPeriod(o.id)}
                  className={styles.tab}
                  data-selected={selected || undefined}
                >
                  {o[l]}
                </button>
              );
            })}
          </div>
          <Link
            href={widgetSeeAllHref(period)}
            className={styles.seeAll}
          >
            {t.seeAll}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
      {board.isLoading && !board.data ? (
        <div className={styles.loading} />
      ) : items.length === 0 ? (
        <p className={styles.empty}>{t.activityEmpty}</p>
      ) : (
        <>
          <Podium
            compact
            maxPedestal={96}
            locale={l}
            ariaLabel={t.podium}
            entries={items.slice(0, 3).map((i) => ({ ...i, value: formatXp(i.points, l), isMe: i.userId === meId }))}
          />
          {rows.length > 0 && (
            <ol className={styles.rows}>
              {rows.map((i) => (
                <BoardRowCard key={i.userId} rank={i.rank} userId={i.userId} displayName={i.displayName} avatarUrl={i.avatarUrl}
                  avatarFrame={i.avatarFrame} value={formatXp(i.points, l)} isMe={i.userId === meId} youLabel={t.you} />
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
