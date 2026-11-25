'use client';

import Link from 'next/link';
import { ArrowRight, CalendarDays, CalendarRange, ChartNoAxesColumn, ListChecks, Route, Telescope, Target } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { LearningHeatmapCard } from '@/components/features/profile/LearningHeatmapCard';
import { ProficiencyCard } from '@/components/features/leaderboard/ProficiencyCard';
import { useLearningPathSummary } from '@/hooks/useLearningPath';
import { bandLabel, goalLabel, skillLabel, stageLabel, type Locale } from '@/lib/learning-path/model';
import styles from './progressGlass.module.css';

/**
 * Tiến trình học tập — what the learner has achieved: streaks and activity (heatmap), assessed ability (Proficiency
 * Engine, placement) and the Learning Path's practice summary. Each block keeps its own meaning: activity is not ability,
 * practice results are not a CEFR level. "Echo Glass · Observatory": the instruments only show server values.
 */
export function LearningProgressPage() {
  const { locale: rawLocale } = useLanguage();
  const locale: Locale = rawLocale === 'en' ? 'en' : 'vi';
  const vi = locale === 'vi';
  return (
    <div className={styles.page}>
      <div className={styles.layout}>
        <header className={`${styles.intro} ${styles.enter}`}>
          <span className={styles.introMark} aria-hidden="true"><Telescope className="h-6 w-6" /></span>
          <div className="min-w-0">
            <h1 className={styles.introTitle}>{vi ? 'Tiến trình học tập' : 'Learning progress'}</h1>
            <p className={styles.introLead}>
              {vi
                ? 'Hoạt động hằng ngày, trình độ đã được đo và kết quả luyện tập — mỗi phần một ý nghĩa riêng.'
                : 'Daily activity, measured level and practice results — each one means something different.'}
            </p>
          </div>
        </header>
        <div className={styles.column}>
          <div data-guide="pg-heatmap"><LearningHeatmapCard /></div>
          <div data-guide="pg-level"><ProficiencyCard /></div>
          <PracticeSummary locale={locale} />
        </div>
      </div>
    </div>
  );
}

const TALLY_ICON = [CalendarDays, CalendarRange, ChartNoAxesColumn];

function PracticeSummary({ locale }: { locale: Locale }) {
  const vi = locale === 'vi';
  const { data, error, isLoading, mutate } = useLearningPathSummary();
  return (
    <section aria-labelledby="progress-practice" className={`${styles.panel} ${styles.enter3}`}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true"><ListChecks className="h-5 w-5" /></span>
        <div className={styles.headText}>
          <h2 id="progress-practice" className={styles.title}>{vi ? 'Kết quả luyện tập' : 'Practice results'}</h2>
          <p className={styles.lead}>{vi ? 'Nhiệm vụ đã hoàn thành trong Lộ trình học và nhịp luyện từng kỹ năng.' : 'Learning Path tasks completed and how each skill is practised.'}</p>
        </div>
        <Link href="/learning-path" prefetch={false} className={styles.link}>
          <Route className="h-4 w-4" aria-hidden="true" />
          {vi ? 'Lộ trình học' : 'Learning path'}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
      {isLoading && !data && (
        <div className="flex flex-col gap-3" aria-busy="true">
          <p className="sr-only">{vi ? 'Đang tải…' : 'Loading…'}</p>
          <div className={styles.tallies}>{[0, 1, 2].map((i) => <div key={i} className={styles.skeleton} style={{ height: '4.6rem' }} />)}</div>
          {[0, 1, 2].map((i) => <div key={i} className={styles.skeleton} />)}
        </div>
      )}
      {error && !data && (
        <p role="alert" className={styles.alert}>
          <span>{vi ? 'Chưa tải được.' : 'Could not load.'}</span>
          <button type="button" className={styles.retry} onClick={() => void mutate()}>{vi ? 'Thử lại' : 'Try again'}</button>
        </p>
      )}
      {data && (
        <>
          {data.plan && data.stage && (
            <p className={styles.goalLine}>
              <span className={styles.goalChip}><Target className="h-3.5 w-3.5" aria-hidden="true" />{goalLabel(data.plan.goal, data.plan.target, locale)}</span>
              <span>{vi ? 'Giai đoạn' : 'Stage'} {data.stage.current}: {stageLabel(data.stage.current, locale)}</span>
            </p>
          )}
          <dl className={styles.tallies}>
            {[
              [vi ? '7 ngày' : '7 days', data.tasksDone7d],
              [vi ? '30 ngày' : '30 days', data.tasksDone30d],
              [vi ? 'Tất cả' : 'All time', data.tasksDone],
            ].map(([label, value], i) => {
              const Icon = TALLY_ICON[i];
              return (
                <div key={String(label)} className={styles.tally}>
                  <Icon className={styles.tallyIcon} aria-hidden="true" />
                  <dt>{vi ? `Nhiệm vụ · ${label}` : `Tasks · ${label}`}</dt>
                  <dd>{value}</dd>
                </div>
              );
            })}
          </dl>
          {data.skills.length > 0 ? (
            <ul className={styles.bands}>
              {data.skills.map((s) => (
                <li key={s.skill} className={styles.band} data-band={s.band}>
                  <span className={styles.bandName}><span className={styles.bandDot} aria-hidden="true" />{skillLabel(s.skill, locale)}</span>
                  <span className={styles.bandValue}>
                    <span className={styles.bandChip}>{bandLabel(s.band, locale)}</span>
                    {s.observations > 0 && s.band !== 'NOT_MEASURED' ? `${s.observations} ${vi ? 'bài gần đây' : 'recent items'}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : !data.plan && (
            <p className={`${styles.empty} mt-4`}>
              {vi ? 'Chưa có lộ trình. ' : 'No learning path yet. '}
              <Link href="/learning-path" prefetch={false} className={styles.link}>{vi ? 'Đặt mục tiêu học' : 'Set a learning goal'}</Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}
