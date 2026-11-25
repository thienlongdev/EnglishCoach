'use client';

import React from 'react';
import Link from 'next/link';
import { AlertCircle, BarChart3, BookOpenCheck, CalendarDays, Clock3, History, ListChecks, RotateCcw, ShieldCheck } from 'lucide-react';
import type { ExamFamily, FamilyAnalyticsDto, ScopeStatsDto } from '@/types/exams';
import { useExamAnalytics } from '@/hooks/useExamCatalog';
import { practiceScopeHint } from '@/lib/exams/practice';
import {
  accuracyLine,
  componentLabel,
  componentValue,
  formatMinutes,
  formatPercent,
  interactionTypeLabel,
  mistakeStateLabel,
  outcomeMark,
  reviewPath,
  sampleLine,
  scopeName,
  shouldShowTrend,
  signalLabel,
  simulationStatusLabel,
  sparklinePoints,
  weekLabel,
} from '@/lib/exams/analytics';
import { ExamPracticeRecommendations } from './ExamPracticeRecommendations';

interface Props {
  family: ExamFamily;
  lang: 'vi' | 'en';
}

const SIGNAL_STYLE: Record<string, string> = {
  ESTABLISHED_SIGNAL: 'border-emerald-600/40 text-emerald-800 dark:text-emerald-200',
  EMERGING_SIGNAL: 'border-sky-600/40 text-sky-800 dark:text-sky-200',
  INSUFFICIENT_DATA: 'border-dashed border-border text-muted-foreground',
  NOT_APPLICABLE: 'border-dashed border-border text-muted-foreground',
};

function formatDate(iso: string | undefined, lang: 'vi' | 'en'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{icon}{label}</p>
      <p className="mt-1 text-2xl font-black text-foreground tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Raw accuracy over the attempts of one scope, oldest → newest (only drawn with ≥ 2 attempts). */
function Sparkline({ scope, lang }: { scope: ScopeStatsDto; lang: 'vi' | 'en' }) {
  if (!shouldShowTrend(scope.trend)) return null;
  const pts = scope.trend!;
  const w = 120, h = 36;
  const label = lang === 'vi'
    ? `Tỷ lệ đúng qua ${pts.length} lượt: ${pts.map((p) => formatPercent(p.rawAccuracyPercent)).join(', ')}`
    : `Correct rate over ${pts.length} sessions: ${pts.map((p) => formatPercent(p.rawAccuracyPercent)).join(', ')}`;
  // 0–100 % axis on purpose (no exaggerated slope); first → last values are labelled directly
  return (
    <figure className="shrink-0 flex flex-col items-end gap-0.5">
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={label} className="text-emerald-600">
        <title>{label}</title>
        <line x1="3" x2={w - 3} y1={h / 2} y2={h / 2} className="stroke-border" strokeWidth="1" strokeDasharray="2 3" />
        <polyline points={sparklinePoints(pts.map((p) => p.rawAccuracyPercent), w, h)} fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <figcaption className="text-[10px] text-muted-foreground tabular-nums">
        {formatPercent(pts[0].rawAccuracyPercent)} → {formatPercent(pts[pts.length - 1].rawAccuracyPercent)} · {pts.length} {lang === 'vi' ? 'lượt' : 'sessions'}
      </figcaption>
    </figure>
  );
}

function ScopeRow({ scope, lang }: { scope: ScopeStatsDto; lang: 'vi' | 'en' }) {
  const ref = { scopeType: scope.scopeType, scopeNumber: scope.scopeNumber };
  return (
    <li className="rounded-2xl border border-border bg-card p-4 space-y-2" data-scope={scope.scopeCode}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground">{scopeName(ref, lang)}</p>
          <p className="text-xs text-muted-foreground">{practiceScopeHint({ scopeType: scope.scopeType, number: scope.scopeNumber }, lang)}</p>
        </div>
        <span className={`inline-flex items-center h-6 px-2 rounded-full border text-[11px] font-semibold ${SIGNAL_STYLE[scope.signal] || SIGNAL_STYLE.INSUFFICIENT_DATA}`}>
          {signalLabel(scope.signal, lang)}
        </span>
      </div>
      {scope.objective ? (
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[180px] space-y-1">
            <p className="text-sm text-foreground">
              <strong className="text-lg font-black tabular-nums">{formatPercent(scope.rawAccuracyPercent)}</strong>{' '}
              <span className="text-muted-foreground">{lang === 'vi' ? 'đúng' : 'correct'}</span>
            </p>
            <div className="h-2 rounded bg-muted overflow-hidden" aria-hidden>
              <div className="h-full rounded bg-emerald-600" style={{ width: `${Math.max(0, Math.min(100, scope.rawAccuracyPercent ?? 0))}%` }} />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {sampleLine(scope.questions, scope.attempts, lang)} ·{' '}
              {lang === 'vi'
                ? `${scope.correct} đúng · ${scope.incorrect} sai · ${scope.unanswered} bỏ trống`
                : `${scope.correct} correct · ${scope.incorrect} wrong · ${scope.unanswered} blank`}
            </p>
            {typeof scope.earlierAccuracyPercent === 'number' && typeof scope.recentAccuracyPercent === 'number' && (
              <p className="text-[11px] text-muted-foreground">
                {lang === 'vi'
                  ? `Gần đây ${formatPercent(scope.recentAccuracyPercent)} · trước đó ${formatPercent(scope.earlierAccuracyPercent)}`
                  : `Recently ${formatPercent(scope.recentAccuracyPercent)} · earlier ${formatPercent(scope.earlierAccuracyPercent)}`}
              </p>
            )}
          </div>
          <Sparkline scope={scope} lang={lang} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground leading-relaxed">
          {lang === 'vi'
            ? `${scope.writing?.submitted ?? scope.attempts} bài đã nộp`
            : `${scope.writing?.submitted ?? scope.attempts} submitted`}
          {typeof scope.writing?.lastWordCount === 'number' && (lang === 'vi' ? ` · lần gần nhất ${scope.writing.lastWordCount} từ` : ` · last ${scope.writing.lastWordCount} words`)}
          {typeof scope.writing?.minimumWords === 'number' && (lang === 'vi'
            ? ` · ${scope.writing.metMinimumCount} bài đạt tối thiểu ${scope.writing.minimumWords} từ`
            : ` · ${scope.writing.metMinimumCount} reached the ${scope.writing.minimumWords}-word minimum`)}
          {' · '}
          {lang === 'vi' ? 'Bài viết luyện tập chưa được chấm điểm.' : 'Writing practice is not scored.'}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        {lang === 'vi' ? 'Lần luyện gần nhất: ' : 'Last practised: '}{formatDate(scope.lastPracticedAt, lang)}
        {typeof scope.timeSpentSeconds === 'number' && ` · ${lang === 'vi' ? 'thời gian' : 'time'} ${formatMinutes(scope.timeSpentSeconds, lang)}`}
      </p>
    </li>
  );
}

function ActivityChart({ data, lang }: { data: FamilyAnalyticsDto; lang: 'vi' | 'en' }) {
  const weeks = data.activity || [];
  const total = weeks.reduce((n, w) => n + w.practiceAttempts + w.simulationAttempts, 0);
  if (total === 0) {
    return <p className="text-sm text-muted-foreground">{lang === 'vi' ? 'Chưa có hoạt động trong 8 tuần gần đây.' : 'No activity in the last 8 weeks.'}</p>;
  }
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.practiceAttempts, w.simulationAttempts)));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-emerald-600" aria-hidden />{lang === 'vi' ? 'Luyện theo phần' : 'Practice'}</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-indigo-600 dark:bg-indigo-500" aria-hidden />{lang === 'vi' ? 'Thi đầy đủ' : 'Full test'}</span>
      </div>
      <div className="flex items-end gap-2 h-28" role="img" aria-label={lang === 'vi' ? 'Số lượt mỗi tuần, 8 tuần gần đây' : 'Sessions per week, last 8 weeks'}>
        {weeks.map((w) => {
          const label = lang === 'vi'
            ? `Tuần ${weekLabel(w.weekStart)}: ${w.practiceAttempts} lượt luyện, ${w.simulationAttempts} bài thi đầy đủ, ${w.questions} câu`
            : `Week of ${weekLabel(w.weekStart)}: ${w.practiceAttempts} practice, ${w.simulationAttempts} full tests, ${w.questions} questions`;
          return (
            <div key={w.weekStart} className="flex-1 min-w-0 flex flex-col items-center gap-1 h-full justify-end" title={label}>
              <div className="flex items-end gap-0.5 w-full justify-center h-full">
                <div className="w-1/3 max-w-[14px] rounded-t bg-emerald-600" style={{ height: `${(w.practiceAttempts / max) * 100}%` }} />
                <div className="w-1/3 max-w-[14px] rounded-t bg-indigo-600 dark:bg-indigo-500" style={{ height: `${(w.simulationAttempts / max) * 100}%` }} />
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums">{weekLabel(w.weekStart)}</span>
            </div>
          );
        })}
      </div>
      <table className="sr-only">
        <caption>{lang === 'vi' ? 'Hoạt động theo tuần' : 'Weekly activity'}</caption>
        <thead><tr><th>{lang === 'vi' ? 'Tuần' : 'Week'}</th><th>{lang === 'vi' ? 'Luyện theo phần' : 'Practice'}</th><th>{lang === 'vi' ? 'Thi đầy đủ' : 'Full tests'}</th></tr></thead>
        <tbody>{weeks.map((w) => <tr key={w.weekStart}><td>{w.weekStart}</td><td>{w.practiceAttempts}</td><td>{w.simulationAttempts}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

/**
 * Exams Phase 8 — the learner's own progress for one family: practice (raw counts per canonical scope, sample sizes,
 * mistakes with links to the attempt-scoped Review), suggested practice, and full simulations kept apart (scorer
 * components only). Nothing here is an official score, a band estimate or a level.
 */
export function ExamLearnerProgress({ family, lang }: Props) {
  const { analytics, error, isLoading, reload } = useExamAnalytics(family);
  const data = analytics?.families.find((f) => f.family === family) || null;

  if (isLoading) {
    return <div className="h-64 rounded-2xl bg-muted/40 animate-pulse motion-reduce:animate-none" role="status" aria-label={lang === 'vi' ? 'Đang tải tiến độ…' : 'Loading progress…'} />;
  }
  if (error || !data) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-3">
        <AlertCircle className="w-6 h-6 mx-auto text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{lang === 'vi' ? 'Chưa tải được tiến độ luyện tập.' : 'Your progress could not be loaded.'}</p>
        <button type="button" onClick={reload} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl border border-border text-xs font-semibold hover:bg-muted">
          <RotateCcw className="w-3.5 h-3.5" aria-hidden />{lang === 'vi' ? 'Thử lại' : 'Retry'}
        </button>
      </div>
    );
  }

  const p = data.practice;
  const objectiveScopes = data.scopes.filter((s) => s.objective);
  const writingScopes = data.scopes.filter((s) => !s.objective);
  const familySlug = family.toLowerCase();

  return (
    <div className="space-y-8">
      {/* Tổng quan */}
      <section aria-labelledby="progress-overview" className="space-y-3">
        <h2 id="progress-overview" className="text-base font-bold text-foreground">{lang === 'vi' ? 'Tổng quan luyện tập' : 'Practice overview'}</h2>
        {p.attempts === 0 ? (
          <p className="rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">
            {lang === 'vi'
              ? `Bạn chưa có lượt luyện ${family} nào trong ${analytics?.windowDays ?? 180} ngày qua. Kết quả sẽ hiện ở đây sau khi bạn nộp bài luyện đầu tiên.`
              : `No ${family} practice in the last ${analytics?.windowDays ?? 180} days. Results appear here after your first submitted practice.`}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Stat icon={<ListChecks className="w-3.5 h-3.5" aria-hidden />} label={lang === 'vi' ? 'Lượt luyện' : 'Sessions'} value={String(p.attempts)}
                hint={lang === 'vi' ? `${p.scopesPracticed} phần · ${p.practiceDays} ngày luyện` : `${p.scopesPracticed} parts · ${p.practiceDays} days`} />
              <Stat icon={<BookOpenCheck className="w-3.5 h-3.5" aria-hidden />} label={lang === 'vi' ? 'Câu đã làm' : 'Questions'} value={String(p.questions)}
                hint={lang === 'vi' ? `${p.unanswered} câu bỏ trống` : `${p.unanswered} left blank`} />
              <Stat icon={<BarChart3 className="w-3.5 h-3.5" aria-hidden />} label={lang === 'vi' ? 'Tỷ lệ đúng' : 'Correct rate'} value={formatPercent(p.rawAccuracyPercent)}
                hint={lang === 'vi' ? `${p.correct} / ${p.questions} câu đúng` : `${p.correct} / ${p.questions} correct`} />
              <Stat icon={<Clock3 className="w-3.5 h-3.5" aria-hidden />} label={lang === 'vi' ? 'Thời gian (bắt đầu → nộp)' : 'Elapsed (start → submit)'} value={formatMinutes(p.timeSpentSeconds, lang)}
                hint={lang === 'vi' ? `Gần nhất: ${formatDate(p.lastPracticedAt, lang)}` : `Last: ${formatDate(p.lastPracticedAt, lang)}`} />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {lang === 'vi'
                ? `Số liệu luyện tập là số câu đúng thô trong ${analytics?.windowDays ?? 180} ngày qua — không phải điểm TOEIC / band IELTS và không tính vào hồ sơ năng lực. Một phần cần ít nhất 10 câu gần đây mới có tín hiệu, và từ 30 câu qua 2 lượt luyện mới được xem là đủ dữ liệu.`
                : `Practice numbers are raw correct counts over the last ${analytics?.windowDays ?? 180} days — not a TOEIC score / IELTS band and never part of the competency profile. A part needs at least 10 recent questions for an early signal and 30 over 2 sessions for enough data.`}
            </p>
          </>
        )}
      </section>

      <ExamPracticeRecommendations families={[data]} lang={lang} headingId={`progress-recommendations-${familySlug}`} />

      {/* Theo phần */}
      {data.scopes.length > 0 && (
        <section aria-labelledby="progress-scopes" className="space-y-3">
          <h2 id="progress-scopes" className="text-base font-bold text-foreground">{lang === 'vi' ? 'Theo từng phần' : 'By part'}</h2>
          <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {objectiveScopes.map((s) => <ScopeRow key={s.scopeCode} scope={s} lang={lang} />)}
            {writingScopes.map((s) => <ScopeRow key={s.scopeCode} scope={s} lang={lang} />)}
          </ul>
          {data.questionTypes.length > 0 && (
            <div className="rounded-2xl border border-border bg-card p-4 space-y-2">
              <h3 className="text-sm font-bold text-foreground">{lang === 'vi' ? `Theo dạng câu hỏi (${analytics?.recentDays ?? 60} ngày gần đây)` : `By question type (last ${analytics?.recentDays ?? 60} days)`}</h3>
              <ul className="space-y-2">
                {data.questionTypes.map((t) => (
                  <li key={t.interactionType} className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-3 sm:items-center text-xs">
                    <span className="text-foreground sm:truncate">{interactionTypeLabel(t.interactionType, lang)}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {accuracyLine(t.rawAccuracyPercent, lang)} · {t.questions} {lang === 'vi' ? 'câu' : 'questions'} · {signalLabel(t.signal, lang)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Câu hay sai */}
      {data.mistakes.totalTracked > 0 && (
        <section aria-labelledby="progress-mistakes" className="space-y-3">
          <h2 id="progress-mistakes" className="text-base font-bold text-foreground">{lang === 'vi' ? 'Câu hay sai' : 'Frequently missed'}</h2>
          <p className="text-xs text-muted-foreground">
            {lang === 'vi'
              ? `${data.mistakes.repeated} câu sai nhiều lần · ${data.mistakes.single} câu sai một lần · ${data.mistakes.improved} câu đã làm đúng ở lần sau. Đáp án nằm trong trang xem lại của lần luyện đó.`
              : `${data.mistakes.repeated} missed repeatedly · ${data.mistakes.single} missed once · ${data.mistakes.improved} correct on a later try. Answers are on the review page of that session.`}
          </p>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
            {data.mistakes.items.map((m) => {
              const ref = data.scopes.find((s) => s.scopeCode === m.scopeCode);
              const label = ref ? scopeName({ scopeType: ref.scopeType, scopeNumber: ref.scopeNumber }, lang) : '';
              return (
                <li key={`${m.logicalItemKey}-${m.itemVersion}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-xs" data-mistake-state={m.state}>
                  <span className="font-bold text-foreground tabular-nums">{lang === 'vi' ? 'Câu' : 'Q'} {m.questionNumber ?? '—'}</span>
                  <span className="text-muted-foreground">{label}{m.interactionType ? ` · ${interactionTypeLabel(m.interactionType, lang)}` : ''}</span>
                  <span className="inline-flex items-center gap-1" aria-label={m.outcomes.map((o) => outcomeMark(o, lang).label).join(', ')}>
                    {m.outcomes.map((o, i) => (
                      <span key={i} aria-hidden className={`inline-flex items-center justify-center w-5 h-5 rounded border text-[11px] ${o === 'CORRECT' ? 'border-emerald-600/50' : 'border-border'}`}>{outcomeMark(o, lang).glyph}</span>
                    ))}
                  </span>
                  <span className={`inline-flex items-center h-6 px-2 rounded-full border text-[11px] font-semibold ${m.state === 'IMPROVED' ? 'border-emerald-600/40' : 'border-amber-600/40'}`}>
                    {mistakeStateLabel(m.state, lang)}
                  </span>
                  {m.reviewAttemptId && (
                    <Link href={reviewPath(family, m.reviewAttemptId)} className="ml-auto inline-flex items-center gap-1 font-semibold text-foreground hover:underline">
                      {lang === 'vi' ? 'Xem lại' : 'Review'}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Hoạt động gần đây */}
      <section aria-labelledby="progress-activity" className="space-y-3">
        <h2 id="progress-activity" className="inline-flex items-center gap-2 text-base font-bold text-foreground">
          <CalendarDays className="w-4 h-4 text-muted-foreground" aria-hidden />
          {lang === 'vi' ? 'Hoạt động gần đây' : 'Recent activity'}
        </h2>
        <div className="rounded-2xl border border-border bg-card p-4"><ActivityChart data={data} lang={lang} /></div>
      </section>

      {/* Thi đầy đủ — kept apart from practice */}
      <section aria-labelledby="progress-simulations" className="space-y-3">
        <h2 id="progress-simulations" className="inline-flex items-center gap-2 text-base font-bold text-foreground">
          <ShieldCheck className="w-4 h-4 text-indigo-600 dark:text-indigo-400" aria-hidden />
          {lang === 'vi' ? 'Bài thi đầy đủ' : 'Full tests'}
        </h2>
        {data.simulation.attempts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{lang === 'vi' ? 'Bạn chưa nộp bài thi đầy đủ nào gần đây.' : 'No full test submitted recently.'}</p>
        ) : (
          <ul className="space-y-2">
            {data.simulation.attempts.map((s) => (
              <li key={s.attemptId} className="rounded-2xl border border-border bg-card p-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-foreground truncate">{s.formTitle || family}</p>
                  <p className="text-muted-foreground">{formatDate(s.submittedAt, lang)} · {simulationStatusLabel(s.resultStatus, lang)}
                    {typeof s.timeSpentSeconds === 'number' && ` · ${formatMinutes(s.timeSpentSeconds, lang)}`}</p>
                </div>
                {s.components.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {s.components.map((c) => (
                      <span key={c.metric} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full bg-indigo-500/10 text-indigo-900 dark:text-indigo-100">
                        {componentLabel(c.metric, lang)} <strong className="tabular-nums">{componentValue(c.scaledScore, c.scaleName)}</strong>
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">{lang === 'vi' ? 'Không có điểm chuẩn hóa cho bài này.' : 'No standardized score for this test.'}</span>
                )}
                <Link href={`/exams/${familySlug}/results/${s.attemptId}`} className="inline-flex items-center gap-1 font-semibold text-foreground hover:underline">
                  <History className="w-3.5 h-3.5" aria-hidden />{lang === 'vi' ? 'Xem kết quả' : 'View result'}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default ExamLearnerProgress;
