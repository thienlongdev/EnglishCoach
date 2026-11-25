'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import {
  ArrowRight, ArrowUpCircle, BookOpen, CalendarDays, ChevronDown, Clock, Crown, GraduationCap, Headphones, LayoutGrid,
  Mic, PenLine, ScrollText, Trophy, Users, X, Zap,
} from 'lucide-react';
import { ChipGroup } from './ChipGroup';
import { HallPodium } from './hall/HallPodium';
import { HallRow } from './hall/HallRow';
import { BoardError, BoardSkeleton } from './BoardStates';
import { MyActivityBar } from './MyActivityBar';
import { BreakdownModal } from './BreakdownModal';
import type { HallSlots } from './LeaderboardHero';
import { useActivityBoard, useActivityMe, usePreparedDefaultScope } from '@/hooks/useLeaderboard';
import { leaderboardApi } from '@/services/leaderboardApi';
import {
  ACTIVITY_GROUPS,
  ACTIVITY_PERIODS,
  ACTIVITY_SCOPES,
  EMPTY_CTA_HREF,
  formatCountdown,
  formatUpdatedAt,
  formatXp,
  HALL_TEXT,
  optionLabel,
  periodRangeLabel,
  PLACEMENT_TEXT,
  promotionNotice,
  TEXT,
  UX_TEXT,
  type Locale,
} from '@/lib/leaderboard/format';
import type { ActivityGroup, ActivityPeriod, ActivityScope, UnrankedItem } from '@/types/leaderboard';
import styles from './hall/hall.module.css';

const ICON = 'h-3.5 w-3.5 sm:h-4 sm:w-4';
/** Period chips: Tuần (trophy), Tháng (bolt), Tổng (crown). */
const PERIOD_ICONS: Record<ActivityPeriod, React.ReactNode> = {
  WEEK: <Trophy className={ICON} aria-hidden="true" />,
  MONTH: <Zap className={ICON} aria-hidden="true" />,
  ALL_TIME: <Crown className={ICON} aria-hidden="true" />,
};
const GROUP_ICONS: Partial<Record<ActivityGroup, React.ReactNode>> = {
  ALL: <LayoutGrid className={ICON} aria-hidden="true" />,
  VOCAB: <BookOpen className={ICON} aria-hidden="true" />,
  LISTENING: <Headphones className={ICON} aria-hidden="true" />,
  SPEAKING: <Mic className={ICON} aria-hidden="true" />,
  WRITING: <PenLine className={ICON} aria-hidden="true" />,
  EXAMS: <GraduationCap className={ICON} aria-hidden="true" />,
};

/** Rows per "Xem thêm" page of the ranked list (podium 1–3, then #4 …); the API serves up to 100. */
const PAGE = 20;
const MAX_ROWS = 100;

/** Local clock for the period-end countdown only (not a data refresh: boards re-read live); ticks once a minute. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * "Chưa ghi điểm kỳ này": collapsed by default (a long list of unnamed "Người học" rows read like broken data);
 * the first page loads only when the learner expands it. 30 per page, "Xem thêm" loads the next cursor page;
 * resets (and collapses) with the partition.
 */
function UnrankedSection({ period, scope, group, locale, meId }: {
  period: ActivityPeriod; scope: ActivityScope; group: ActivityGroup; locale: Locale; meId: number | null;
}) {
  const t = TEXT[locale];
  const [items, setItems] = useState<UnrankedItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async (from: number | null, reset: boolean) => {
    setLoading(true);
    setError(false);
    try {
      const page = await leaderboardApi.getActivityUnranked(period, scope, group, from, 30);
      setItems((prev) => (reset ? page.items : [...prev, ...page.items]));
      setCursor(page.nextCursor);
      setDone(page.nextCursor == null);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setDone(false);
    setOpen(false);
  }, [period, scope, group]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && items.length === 0 && !loading) load(null, true);
  };

  const ux = UX_TEXT[locale];
  return (
    <section aria-label={t.unrankedTitle} className="space-y-2" data-testid="unranked-section">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`${styles.moreBtn} w-full justify-between`}
      >
        <span>{t.unrankedTitle}</span>
        <span className="inline-flex items-center gap-1 text-xs font-semibold">
          {open ? ux.hideUnranked : ux.showUnranked}
          <ChevronDown className={`h-4 w-4 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <ul className={styles.rows}>
          {items.map((u) => (
            <HallRow key={u.userId} rank={null} userId={u.userId} displayName={u.displayName} avatarUrl={u.avatarUrl}
              avatarFrame={u.avatarFrame} muted isMe={u.userId === meId} youLabel={t.you} />
          ))}
        </ul>
      )}
      {open && loading && items.length === 0 && <BoardSkeleton rows={2} label={t.unrankedTitle} />}
      {open && error && <p className="px-1 text-xs text-rose-500">{t.loadError}</p>}
      {open && !done && items.length > 0 && (
        <div className="flex justify-center pt-1">
          <button type="button" disabled={loading} onClick={() => load(cursor, false)} className={styles.moreBtn}>
            {loading ? '…' : t.loadMore}
          </button>
        </div>
      )}
    </section>
  );
}

const PROMOTION_SEEN_KEY = 'lb_promotion_seen_v1';

/** Anti-sandbagging notice: shown until dismissed, once per promotion (keyed by user + promotedAt). */
function PromotionNotice({ me, locale }: {
  me: { userId: number; promotedTo: string | null; promotedAt: string | null; division: string | null } | undefined;
  locale: Locale;
}) {
  const key = me?.promotedTo && me.promotedAt ? `${PROMOTION_SEEN_KEY}:${me.userId}:${me.promotedAt}` : null;
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    if (!key) return;
    try {
      setHidden(window.localStorage.getItem(key) === '1');
    } catch {
      setHidden(false);
    }
  }, [key]);
  if (!key || hidden) return null;
  const text = promotionNotice(me?.promotedTo, me?.division, locale);
  return (
    <div role="status" data-testid="promotion-notice" className="relative flex items-start gap-3 rounded-2xl border border-emerald-400/40 bg-emerald-50 px-4 py-3 pr-10 dark:bg-emerald-950/60">
      <ArrowUpCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-bold text-emerald-800 dark:text-emerald-200">{PLACEMENT_TEXT[locale].promotionTitle}</p>
        <p className="text-sm text-emerald-800/90 dark:text-emerald-100/90">{text}</p>
      </div>
      <button
        type="button"
        aria-label={TEXT[locale].close}
        onClick={() => {
          try { window.localStorage.setItem(key, '1'); } catch { /* storage blocked */ }
          setHidden(true);
        }}
        className="absolute right-2 top-2 rounded-lg p-1.5 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-200"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function ActivityBoardTab({ locale, initialPeriod = 'WEEK', initialScope = null, divisionCta, slots }: {
  locale: Locale;
  initialPeriod?: ActivityPeriod;
  initialScope?: ActivityScope | null;
  /** Shown when a learner without a division level opens a division chip (Stage 3 placement CTA). */
  divisionCta?: React.ReactNode;
  /** The hall's slots (meta chips, podium, "Thành tích của bạn"); null slots ⇒ nothing is portalled there. */
  slots: HallSlots;
}) {
  const t = TEXT[locale];
  const h = HALL_TEXT[locale];
  const [period, setPeriod] = useState<ActivityPeriod>(initialPeriod);
  const [group, setGroup] = useState<ActivityGroup>('ALL');
  const preparedScope = usePreparedDefaultScope(initialPeriod);
  // The server's defaultScope is GLOBAL; explicit deep-link filters still take precedence.
  const [scope, setScope] = useState<ActivityScope | null>(() => initialScope ?? preparedScope ?? 'GLOBAL');
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const now = useMinuteClock();
  useEffect(() => { setLimit(PAGE); }, [period, scope, group]);

  const me = useActivityMe(period, scope, group);
  // all-time XP for "Thành tích của bạn" (Bảng chung, every skill): calm cadence, never the 5 s live poll
  const lifetime = useActivityMe('ALL_TIME', 'GLOBAL', 'ALL', { live: false });
  useEffect(() => {
    if (scope == null && me.data?.defaultScope) setScope(me.data.defaultScope);
  }, [scope, me.data?.defaultScope]);
  useEffect(() => {
    if (scope == null && me.error) setScope('GLOBAL');
  }, [scope, me.error]);

  const board = useActivityBoard(period, scope, group, { limit });
  // "Xem thêm" changes only the row count: keep showing the same partition's rows while the longer page loads
  // (never rows of another period / scope / group)
  const partition = `${period}|${scope}|${group}`;
  const last = useRef<{ partition: string; data: NonNullable<typeof board.data> } | null>(null);
  if (board.data) last.current = { partition, data: board.data };
  const boardData = board.data ?? (last.current?.partition === partition ? last.current.data : undefined);
  const items = boardData?.items ?? [];
  const meId = me.data?.userId ?? null;
  // end of the competition period (weekly / monthly reset) — scores themselves update live
  const countdown = period === 'ALL_TIME' ? null
    : formatCountdown(boardData?.periodEndsAt ?? me.data?.periodEndsAt, now, locale, period);
  const canLoadMore = items.length >= limit && limit < MAX_ROWS && items.length < (boardData?.participants ?? 0);
  const loading = scope == null || (board.isLoading && !boardData);
  const noLevelOnDivision = scope != null && scope !== 'GLOBAL' && me.data != null && me.data.division == null;
  const range = periodRangeLabel(boardData?.periodStartsAt ?? me.data?.periodStartsAt, boardData?.periodEndsAt ?? me.data?.periodEndsAt);
  const failed = board.error && !boardData;

  const opt = <T extends string>(list: { id: T; vi: string; en: string }[]) => list.map((o) => ({ id: o.id, label: o[locale] }));

  const podium = failed ? (
    <BoardError message={t.loadError} retryLabel={t.retry} onRetry={() => { board.mutate(); me.mutate(); }} />
  ) : (
    <HallPodium
      locale={locale}
      ariaLabel={t.podium}
      loading={loading}
      entries={loading ? [] : items.slice(0, 3).map((i) => ({ ...i, value: formatXp(i.points, locale), isMe: i.userId === meId }))}
      empty={
        <div className={styles.emptyCall} data-testid="board-empty">
          <h3>{h.emptyHall}</h3>
          <p><strong>{UX_TEXT[locale].emptyTitle}.</strong> {UX_TEXT[locale].emptyBody}</p>
          <Link href={EMPTY_CTA_HREF} className={styles.goldBtn}>
            {UX_TEXT[locale].emptyCta}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      }
    />
  );

  const meta = (
    <>
      {countdown && (
        <span className={styles.metaChip} data-tone="gold" aria-live="polite" data-testid="hall-countdown">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          {countdown}
        </span>
      )}
      <span className={styles.metaChip} data-testid="hero-participants">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        {h.participants}: {boardData ? boardData.participants : '–'}
      </span>
    </>
  );

  return (
    <div className="space-y-5">
      {slots.meta && createPortal(meta, slots.meta)}
      {slots.podium && createPortal(podium, slots.podium)}
      {slots.aside && !me.error && createPortal(
        <MyActivityBar me={me.data} items={items} lifetimePoints={lifetime.data?.points} locale={locale}
          context={`${optionLabel(ACTIVITY_PERIODS, period, locale)} · ${optionLabel(ACTIVITY_SCOPES, scope, locale)}`}
          onOpenBreakdown={() => setBreakdownOpen(true)} />,
        slots.aside,
      )}

      <div data-testid="activity-filters" className={styles.deck} role="group" aria-label={h.filters}>
        <div className={styles.deckGroup}>
          <ChipGroup
            variant="tabs"
            ariaLabel={locale === 'vi' ? 'Kỳ' : 'Period'}
            options={ACTIVITY_PERIODS.map((o) => ({ id: o.id, label: o[locale], icon: PERIOD_ICONS[o.id] }))}
            value={period}
            onChange={setPeriod}
          />
        </div>
        <span className={styles.deckSep} aria-hidden="true" />
        <div className={styles.deckGroup}>
          <ChipGroup ariaLabel={locale === 'vi' ? 'Phạm vi' : 'Scope'} options={opt(ACTIVITY_SCOPES)} value={scope} onChange={setScope} />
        </div>
        <span className={styles.deckSep} aria-hidden="true" />
        <div className={styles.deckGroup}>
          <ChipGroup
            ariaLabel={locale === 'vi' ? 'Nhóm kỹ năng' : 'Skill group'}
            options={ACTIVITY_GROUPS.map((o) => ({ id: o.id, label: o[locale], icon: GROUP_ICONS[o.id] }))}
            value={group}
            onChange={setGroup}
          />
        </div>
      </div>
      <PromotionNotice me={me.data} locale={locale} />
      {noLevelOnDivision && divisionCta}

      <div className={styles.lower}>
        <section className={styles.roll} aria-labelledby="roll-title">
          <div className={styles.rollHead}>
            <h2 id="roll-title" className={styles.rollTitle}><ScrollText className="h-5 w-5" aria-hidden="true" />{h.rollTitle}</h2>
          </div>
          {failed ? (
            <p className="px-2 text-sm text-rose-600 dark:text-rose-300">{t.loadError}</p>
          ) : loading ? (
            <BoardSkeleton rows={5} label={locale === 'vi' ? 'Đang tải bảng xếp hạng' : 'Loading leaderboard'} />
          ) : items.length > 3 ? (
            <>
              <div className={styles.cols} aria-hidden="true"><span>{h.colRank}</span><span>{h.colLearner}</span><span>{h.colPoints}</span></div>
              <ol className={styles.rows} aria-label={t.title} start={4} data-testid="ranked-list">
                {items.slice(3).map((i) => (
                  <HallRow key={i.userId} rank={i.rank} userId={i.userId} displayName={i.displayName} avatarUrl={i.avatarUrl}
                    avatarFrame={i.avatarFrame} value={formatXp(i.points, locale)} isMe={i.userId === meId} youLabel={t.you} />
                ))}
              </ol>
              {canLoadMore && (
                <div className="mt-3 flex justify-center">
                  <button
                    type="button"
                    disabled={board.isValidating}
                    onClick={() => setLimit((l) => Math.min(MAX_ROWS, l + PAGE))}
                    className={styles.moreBtn}
                    data-testid="ranked-load-more"
                  >
                    {t.loadMore}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="px-2 pb-1 text-sm text-slate-500 dark:text-slate-400">{items.length === 0 ? UX_TEXT[locale].emptyBody : h.rollEmpty}</p>
          )}
          <div className="mt-4">
            {scope != null && !board.error && <UnrankedSection period={period} scope={scope} group={group} locale={locale} meId={meId} />}
          </div>
        </section>

        <aside className={styles.side}>
          <section className={styles.card} aria-labelledby="season-info">
            <h2 id="season-info" className={styles.cardTitle}><CalendarDays className="h-5 w-5 text-indigo-500" aria-hidden="true" />{h.seasonInfo}</h2>
            <dl className={styles.facts}>
              <div className={styles.fact}><dt>{UX_TEXT[locale].filterPeriod}</dt><dd>{optionLabel(ACTIVITY_PERIODS, period, locale)}</dd></div>
              {range && <div className={styles.fact}><dt>{h.periodRange}</dt><dd>{range}</dd></div>}
              <div className={styles.fact}><dt>{UX_TEXT[locale].filterScope}</dt><dd>{optionLabel(ACTIVITY_SCOPES, scope, locale)}</dd></div>
              <div className={styles.fact}><dt>{h.participants}</dt><dd>{boardData ? boardData.participants : '–'}</dd></div>
              {countdown && <div className={styles.fact}><dt><Clock className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" /></dt><dd>{countdown}</dd></div>}
            </dl>
            <p className={styles.small}>{t.activityHint}</p>
            <p className={styles.small} data-testid="board-updated-at">
              {formatUpdatedAt(boardData?.updatedAt ?? me.data?.updatedAt, locale)} · {t.liveHint}
            </p>
          </section>
        </aside>
      </div>

      <BreakdownModal
        open={breakdownOpen}
        onClose={() => setBreakdownOpen(false)}
        breakdown={me.data?.breakdown ?? []}
        total={me.data?.points ?? 0}
        periodLabel={optionLabel(ACTIVITY_PERIODS, period, locale)}
        locale={locale}
      />
    </div>
  );
}
