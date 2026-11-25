'use client';

import React, { useState, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { useSession } from 'next-auth/react';
import { Flame, Trophy, CalendarCheck2, Activity, Loader2, Check, AudioLines } from 'lucide-react';
import { progressApi, HeatmapResponseDto, HeatmapDayDto } from '@/services/progressApi';
import { userProfileApi } from '@/services/userProfileApi';
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile';
import { useLanguage } from '@/context/LanguageContext';
import {
  HEATMAP_THEMES,
  HeatmapThemeKey,
  DEFAULT_HEATMAP_THEME,
} from '@/lib/heatmap-themes';
import styles from '@/components/features/learning-path/progressGlass.module.css';

/** Cell light of each saved heatmap colour (the preference itself is unchanged: same keys, same PATCH). */
const THEME_RGB: Record<HeatmapThemeKey, string> = {
  purple: '129 140 248',
  green: '16 185 129',
  blue: '59 130 246',
  orange: '249 115 22',
  pink: '236 72 153',
  cyan: '6 182 212',
};

/** Monday-first weekday index of a YYYY-MM-DD date (calendar arithmetic only, no time zone shift). */
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

export function LearningHeatmapCard() {
  const { data: session, status } = useSession();
  const userEmail = session?.user?.email;
  const { locale } = useLanguage();
  const t = (vi: string, en: string) => (locale === 'vi' ? vi : en);

  const { profile, mutateProfile } = useCurrentUserProfile();

  // Local theme state for immediate responsive UI feedback
  const [selectedTheme, setSelectedTheme] = useState<HeatmapThemeKey>(DEFAULT_HEATMAP_THEME);
  const [isUpdatingTheme, setIsUpdatingTheme] = useState(false);
  const [pointed, setPointed] = useState<HeatmapDayDto | null>(null);

  // Sync theme with profile preference when loaded
  useEffect(() => {
    if (profile?.heatmapTheme) {
      setSelectedTheme(profile.heatmapTheme.toLowerCase() as HeatmapThemeKey);
    }
  }, [profile?.heatmapTheme]);

  // User-scoped cache key for heatmap data
  const swrKey = status === 'authenticated' && userEmail
    ? ['/progress/heatmap', userEmail]
    : null;

  const { data, error, isLoading, mutate } = useSWR<HeatmapResponseDto>(
    swrKey,
    async () => {
      return await progressApi.getHeatmap(365);
    },
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
      keepPreviousData: true,
    }
  );

  // If server returns a theme and local state hasn't been set by profile
  useEffect(() => {
    if (data?.theme && !profile?.heatmapTheme) {
      setSelectedTheme(data.theme.toLowerCase() as HeatmapThemeKey);
    }
  }, [data?.theme, profile?.heatmapTheme]);

  // Handle theme switch
  const handleSelectTheme = async (themeKey: HeatmapThemeKey) => {
    if (themeKey === selectedTheme || isUpdatingTheme) return;

    setSelectedTheme(themeKey);
    try {
      setIsUpdatingTheme(true);
      const updated = await userProfileApi.updateHeatmapTheme(themeKey);
      if (mutateProfile) {
        await mutateProfile(updated, { revalidate: false });
      }
    } catch (err) {
      console.error('Failed to persist heatmap theme', err);
    } finally {
      setIsUpdatingTheme(false);
    }
  };

  // Helper to generate 365 empty placeholder days ending today
  const defaultEmptyDays = useMemo(() => {
    const list: HeatmapDayDto[] = [];
    const today = new Date();
    for (let i = 364; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      list.push({
        date: `${yyyy}-${mm}-${dd}`,
        activityCount: 0,
        intensity: 0,
      });
    }
    return list;
  }, []);

  // Calendar layout: one row per weekday (Monday first), one column per week. The first column is padded so every day
  // sits on its own weekday row; a month label sits above the column that holds the 1st of that month.
  const { days, pad, monthLabels } = useMemo(() => {
    const rawDays = data?.days;
    const list = rawDays && rawDays.length > 0 ? rawDays : defaultEmptyDays;
    const lead = list.length ? weekdayIndex(list[0].date) : 0;
    const columns = Math.ceil((lead + list.length) / 7);
    const labels: string[] = Array.from({ length: columns }, () => '');
    let lastMonth = '';
    let lastCol = -99;
    list.forEach((day, i) => {
      const month = day.date.slice(0, 7);
      if (month !== lastMonth) {
        const col = Math.floor((lead + i) / 7);
        const m = Number(month.slice(5, 7));
        labels[col] = locale === 'vi' ? `Th${m}` : new Date(2000, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
        // a label needs three week columns: the partial month before a newer label gives way to it
        if (col - lastCol < 3 && lastCol >= 0) labels[lastCol] = '';
        lastCol = col;
        lastMonth = month;
      }
    });
    return { days: list, pad: lead, monthLabels: labels };
  }, [data?.days, defaultEmptyDays, locale]);

  const formatDateTooltip = (dateStr: string) => {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
  };

  const formatActivityTooltip = (count: number) => {
    if (count === 0) {
      return t('Không có hoạt động học', 'No learning activities');
    }
    return count === 1
      ? t('1 hoạt động học', '1 learning activity')
      : t(`${count} hoạt động học`, `${count} learning activities`);
  };

  // Roving focus over the calendar: one tab stop, arrows move a day (↑ ↓) or a week (← →).
  const handleGridKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7, Home: -days.length, End: days.length }[event.key];
    const current = Number((event.target as HTMLElement).dataset.i);
    if (step === undefined || Number.isNaN(current)) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(days.length - 1, current + step));
    (event.currentTarget.querySelector(`[data-i="${next}"]`) as HTMLElement | null)?.focus();
  };

  const weekdays = locale === 'vi' ? ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const metrics: { tone: string; Icon: typeof Flame; label: string; value: number | undefined; unit: string }[] = [
    { tone: 'flame', Icon: Flame, label: t('Chuỗi hiện tại', 'Current Streak'), value: data?.currentStreakDays, unit: t('ngày', 'days') },
    { tone: 'trophy', Icon: Trophy, label: t('Chuỗi dài nhất', 'Longest Streak'), value: data?.longestStreakDays, unit: t('ngày', 'days') },
    { tone: 'days', Icon: CalendarCheck2, label: t('Ngày hoạt động năm nay', 'Active This Year'), value: data?.activeDaysThisYear, unit: t('ngày', 'days') },
    { tone: 'month', Icon: Activity, label: t('Hoạt động tháng này', 'This Month'), value: data?.activitiesThisMonth, unit: t('hoạt động', 'activities') },
  ];

  return (
    <section className={`${styles.panel} ${styles.enter}`} data-tone="violet" aria-labelledby="learning-activity-title">
      {/* ── Section Header with Theme Selector ── */}
      <div className={styles.head}>
        <span className={styles.icon} data-tone="violet" aria-hidden="true"><AudioLines className="h-5 w-5" /></span>
        <div className={styles.headText}>
          <h2 id="learning-activity-title" className={styles.title}>{t('Hoạt động học tập', 'Learning Activity')}</h2>
          <p className={styles.lead}>
            {t(
              'Biểu đồ 365 ngày ghi nhận tiến độ học tập trên toàn bộ ứng dụng',
              '365-day heatmap tracking learning activities across the entire platform'
            )}
          </p>
        </div>

        {/* Theme Swatches */}
        <div className={styles.swatches} role="group" aria-label={t('Màu biểu đồ', 'Heatmap colour')}>
          <span className={`${styles.swatchLabel} hidden sm:inline`}>{t('Màu sắc:', 'Color:')}</span>
          {(Object.keys(HEATMAP_THEMES) as HeatmapThemeKey[]).map((key) => {
            const cfg = HEATMAP_THEMES[key];
            const isSelected = selectedTheme === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => handleSelectTheme(key)}
                disabled={isUpdatingTheme}
                title={locale === 'vi' ? cfg.labelVi : cfg.labelEn}
                aria-label={`Select ${cfg.labelEn} heatmap theme`}
                aria-pressed={isSelected}
                className={styles.swatch}
                style={{ '--sw': THEME_RGB[key] } as React.CSSProperties}
              >
                {isSelected && <Check className="w-3.5 h-3.5 text-white stroke-[3]" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Summary Stats Cards ── (no number is shown before the server answered) */}
      <dl className={styles.metrics}>
        {metrics.map(({ tone, Icon, label, value, unit }) => (
          <div key={tone} className={styles.metric} data-tone={tone}>
            <dt className={styles.metricTop}>
              <span className={styles.metricIcon} aria-hidden="true"><Icon className="h-4 w-4" /></span>
              <span className={styles.metricLabel}>{label}</span>
            </dt>
            <dd className={styles.metricValue} data-pending={value === undefined || undefined}>
              <strong>{value ?? '—'}</strong>
              {value !== undefined && <span>{unit}</span>}
            </dd>
          </div>
        ))}
      </dl>

      {/* ── Error Notification (graceful fallback still displays grid) ── */}
      {error && (
        <div className={`${styles.alert} mb-3`} role="alert">
          <span>
            {t(
              'Không thể tải dữ liệu tiến độ trực tuyến. Đang hiển thị lưới mặc định.',
              'Could not load online progress data. Displaying default grid.'
            )}
          </span>
          <button type="button" onClick={() => mutate()} className={styles.retry}>
            {t('Thử lại', 'Retry')}
          </button>
        </div>
      )}

      {/* ── Heatmap Grid Container ── */}
      <div className={styles.calendar} style={{ '--hm': THEME_RGB[selectedTheme] ?? THEME_RGB.purple } as React.CSSProperties}>
        {isLoading && !data && (
          <div className={styles.calLoading} role="status" aria-label={t('Đang tải', 'Loading')}>
            <Loader2 className="w-6 h-6 animate-spin motion-reduce:animate-none text-indigo-500" aria-hidden="true" />
          </div>
        )}

        {/* Scrolls sideways on narrow screens only; it opens on the most recent weeks */}
        <div className={styles.calScroll} ref={(el) => { if (el && !el.dataset.placed) { el.dataset.placed = '1'; el.scrollLeft = el.scrollWidth; } }}>
          <div className={styles.calInner}>
            <div className={styles.months} aria-hidden="true">
              {monthLabels.map((label, col) => <span key={col}>{label}</span>)}
            </div>
            <div className={styles.weekdays} aria-hidden="true">
              {weekdays.map((d) => <span key={d}>{d}</span>)}
            </div>
            <div
              className={styles.cells}
              role="group"
              aria-label={t('Lịch hoạt động 365 ngày', '365-day activity calendar')}
              onKeyDown={handleGridKey}
              onMouseLeave={() => setPointed(null)}
            >
              {Array.from({ length: pad }).map((_, i) => <span key={`pad-${i}`} className={styles.cell} data-pad="" aria-hidden="true" />)}
              {days.map((day, i) => {
                const tooltipText = `${formatDateTooltip(day.date)}: ${formatActivityTooltip(day.activityCount)}`;
                const last = i === days.length - 1;
                return (
                  <span
                    key={day.date}
                    data-i={i}
                    data-l={Math.max(0, Math.min(4, day.intensity))}
                    data-today={last || undefined}
                    tabIndex={last ? 0 : -1}
                    role="img"
                    aria-label={tooltipText}
                    title={tooltipText}
                    className={styles.cell}
                    onMouseEnter={() => setPointed(day)}
                    onFocus={() => setPointed(day)}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Readout + Legend ── */}
        <div className={styles.calFoot}>
          <span className={styles.readout} aria-live="polite">
            {pointed
              ? `${formatDateTooltip(pointed.date)} · ${formatActivityTooltip(pointed.activityCount)}`
              : t('Chọn một ngày để xem số hoạt động', 'Point at a day to see its activities')}
          </span>
          <span className={styles.legend} aria-hidden="true">
            <span>{t('Ít', 'Less')}</span>
            {[0, 1, 2, 3, 4].map((level) => <span key={level} className={styles.cell} data-l={level} />)}
            <span>{t('Nhiều', 'More')}</span>
          </span>
        </div>
      </div>
    </section>
  );
}
