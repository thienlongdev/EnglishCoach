'use client';

import React, { useEffect, useState } from 'react';
import { BookOpen, Eye, GraduationCap, Headphones, Languages, MessageCircle, PenLine } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { usePlacementMe, useProficiencyMe } from '@/hooks/useLeaderboard';
import { leaderboardApi } from '@/services/leaderboardApi';
import { BoardError } from './BoardStates';
import { PlacementQuizButton } from './PlacementQuiz';
import {
  CEFR_TICKS,
  currentPeakLine,
  formatVnDate,
  levelSourceLabel,
  PLACEMENT_TEXT,
  ratingPercent,
  skillStatusLabel,
  TEXT,
  type Locale,
} from '@/lib/leaderboard/format';
import type { ProficiencyMeResponse, ProficiencySkill } from '@/types/leaderboard';
import glass from '@/components/features/learning-path/progressGlass.module.css';

/** 'card' = the leaderboard / placement dialogs; 'observatory' = Tiến trình học tập (same data, glass instruments). */
export type ProficiencyVariant = 'card' | 'observatory';

const SKILL_ROWS: { skill: string; vi: string; en: string }[] = [
  { skill: 'LISTENING', vi: 'Nghe', en: 'Listening' },
  { skill: 'READING', vi: 'Đọc', en: 'Reading' },
  { skill: 'WRITING', vi: 'Viết', en: 'Writing' },
  { skill: 'SPEAKING', vi: 'Nói', en: 'Speaking' },
];

const FILL: Record<string, string> = {
  VERIFIED: 'from-emerald-400 to-teal-500',
  PROVISIONAL: 'from-sky-400 to-blue-500',
  STALE: 'from-amber-400 to-orange-500',
};

/** One skill bar on the 0–1000 scale with six CEFR ticks. Never shows confidence numbers or weights. */
export function SkillBar({ label, skill, locale }: { label: string; skill: ProficiencySkill | undefined; locale: Locale }) {
  const status = skill?.status ?? 'UNDETERMINED';
  const determined = status !== 'UNDETERMINED' && status !== 'UNSUPPORTED' && skill?.rating != null;
  return (
    <div data-testid={`skill-row-${skill?.skill ?? label}`}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-semibold text-slate-800 dark:text-slate-100">{label}</span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {determined && skill?.cefr && <span className="mr-1.5 font-bold text-slate-800 dark:text-slate-100">{skill.cefr}</span>}
          {skillStatusLabel(status, locale)}
        </span>
      </div>
      <div className="relative h-2.5 w-full rounded-full bg-slate-100 dark:bg-white/[0.06]" aria-hidden="true">
        {determined && (
          <div
            className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${FILL[status] ?? FILL.PROVISIONAL}`}
            style={{ width: `${ratingPercent(skill?.rating)}%` }}
          />
        )}
        {CEFR_TICKS.slice(1).map((tick) => (
          <span key={tick.cefr} className="absolute inset-y-0 w-px bg-white/70 dark:bg-slate-900/80" style={{ left: `${tick.at / 10}%` }} />
        ))}
      </div>
      <div className="relative mt-0.5 h-3 text-[9px] font-medium text-slate-400 dark:text-slate-500" aria-hidden="true">
        {CEFR_TICKS.map((tick) => (
          <span key={tick.cefr} className="absolute" style={{ left: `calc(${tick.at / 10}% + 2px)` }}>
            {tick.cefr}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Pure view (used by the profile card, the Năng lực modal and the VERIFIED fixture). */
export function ProficiencyCardView({
  data,
  locale,
  onToggleVisibility,
  saving = false,
  variant = 'card',
}: {
  data: ProficiencyMeResponse;
  locale: Locale;
  onToggleVisibility?: (next: boolean) => void;
  saving?: boolean;
  variant?: ProficiencyVariant;
}) {
  if (variant === 'observatory') return <ObservatoryView data={data} locale={locale} onToggleVisibility={onToggleVisibility} saving={saving} />;
  const t = TEXT[locale];
  const o = data.overall;
  const undetermined = o.status === 'UNDETERMINED' || !o.currentCefr;
  const line = currentPeakLine(o, locale);
  const bySkill = new Map(data.skills.map((s) => [s.skill, s]));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-3xl font-black text-slate-900 dark:text-white">{undetermined ? t.undetermined : o.currentCefr}</span>
        {!undetermined && o.rating != null && <span className="text-lg font-bold text-slate-600 dark:text-slate-300">{o.rating}</span>}
        {!undetermined && levelSourceLabel(o.status, locale) && (
          <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-200" data-testid="overall-source-label">
            {levelSourceLabel(o.status, locale)}
          </span>
        )}
        <span className="rounded-full border border-sky-400/40 bg-sky-500/10 px-2.5 py-0.5 text-xs font-semibold text-sky-700 dark:text-sky-200">
          {o.confidenceLabel}
        </span>
      </div>
      {line && <p className="text-sm text-slate-600 dark:text-slate-300">{line}</p>}

      <div className="space-y-4">
        {SKILL_ROWS.map((r) => (
          <SkillBar key={r.skill} label={r[locale]} skill={bySkill.get(r.skill)} locale={locale} />
        ))}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-slate-100 dark:border-slate-800 pt-3 text-sm" data-testid="skill-row-VOCABULARY">
          <span className="font-semibold text-slate-800 dark:text-slate-100">{t.vocabulary}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">{skillStatusLabel('UNSUPPORTED', locale)}</span>
        </div>
      </div>

      {onToggleVisibility && (
        <div className="flex items-center justify-between gap-4 rounded-2xl bg-slate-50 dark:bg-white/[0.03] px-4 py-3">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{t.showOnBoard}</span>
          <button
            type="button"
            role="switch"
            aria-checked={data.showOnProficiencyBoard}
            aria-label={t.showOnBoard}
            disabled={saving}
            onClick={() => onToggleVisibility(!data.showOnProficiencyBoard)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-60 ${
              data.showOnProficiencyBoard ? 'bg-sky-500' : 'bg-slate-300 dark:bg-slate-700'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${
                data.showOnProficiencyBoard ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * "Bài xếp lớp nhanh" block for learners without an exam-based level: latest VALID result with "Theo bài xếp lớp",
 * retake date while locked, otherwise the quiz button. Never shown once an exam-based level exists.
 */
export function PlacementSection({ locale, variant = 'card' }: { locale: Locale; variant?: ProficiencyVariant }) {
  const t = PLACEMENT_TEXT[locale];
  const { data } = usePlacementMe();
  if (!data) return null;
  const retake = formatVnDate(data.retakeAvailableAt);
  if (variant === 'observatory') {
    return (
      <div className={glass.placement} data-testid="placement-section">
        <div className={glass.placementText}>
          <span className={glass.icon} data-tone="cyan" aria-hidden="true"><GraduationCap className="h-5 w-5" /></span>
          <div className="min-w-0">
            <p className={glass.placementTitle}>{t.yourPlacement}</p>
            {data.resultCefr ? (
              <p className={glass.placementBody}><b>{data.resultCefr}</b>{t.resultSource}</p>
            ) : (
              <p className={glass.placementBody}>{t.ctaCardBody}</p>
            )}
            {!data.canRetake && retake && <p className={glass.retakeNote}>{t.retakeOn(retake)}</p>}
          </div>
        </div>
        {data.canRetake && (
          <PlacementQuizButton locale={locale} label={data.resultCefr ? t.retakeQuiz : t.takeQuiz} testId="card-placement-button" className={glass.placementBtn} />
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid="placement-section">
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-slate-800 dark:text-slate-100">{t.yourPlacement}</p>
        {data.resultCefr ? (
          <p className="text-slate-600 dark:text-slate-300">
            <span className="mr-1.5 font-black text-slate-900 dark:text-white">{data.resultCefr}</span>
            {t.resultSource}
          </p>
        ) : (
          <p className="text-slate-600 dark:text-slate-300">{t.ctaCardBody}</p>
        )}
        {!data.canRetake && retake && <p className="text-xs text-slate-500 dark:text-slate-400">{t.retakeOn(retake)}</p>}
      </div>
      {data.canRetake && (
        <PlacementQuizButton locale={locale} label={data.resultCefr ? t.retakeQuiz : t.takeQuiz} testId="card-placement-button" />
      )}
    </div>
  );
}

/** Data + optimistic visibility toggle (rollback + toast on error). */
export function ProficiencyCardContent({ locale, variant = 'card' }: { locale: Locale; variant?: ProficiencyVariant }) {
  const t = TEXT[locale];
  const { data, error, isLoading, mutate } = useProficiencyMe();
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const toggle = async (next: boolean) => {
    if (!data) return;
    const previous = data;
    setSaving(true);
    await mutate({ ...data, showOnProficiencyBoard: next }, { revalidate: false });
    try {
      const res = await leaderboardApi.setProficiencyVisibility(next);
      await mutate({ ...previous, showOnProficiencyBoard: res.showOnProficiencyBoard }, { revalidate: false });
    } catch {
      await mutate(previous, { revalidate: false });
      setToast(t.visibilityError);
    } finally {
      setSaving(false);
    }
  };

  if (error && !data) return <BoardError message={t.loadError} retryLabel={t.retry} onRetry={() => mutate()} />;
  if (isLoading || !data) {
    if (variant === 'observatory') {
      return (
        <div role="status" aria-label={t.yourLevel} className="flex flex-col gap-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className={glass.skeleton} />)}
        </div>
      );
    }
    return (
      <div role="status" aria-label={t.yourLevel} className="space-y-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-8 rounded-xl bg-slate-100 dark:bg-white/[0.04] animate-pulse motion-reduce:animate-none" />
        ))}
      </div>
    );
  }
  return (
    <>
      <ProficiencyCardView data={data} locale={locale} onToggleVisibility={toggle} saving={saving} variant={variant} />
      {(data.overall.status === 'UNDETERMINED' || !data.overall.currentCefr) && (
        variant === 'observatory'
          ? <PlacementSection locale={locale} variant="observatory" />
          : <div className="mt-5"><PlacementSection locale={locale} /></div>
      )}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={variant === 'observatory' ? glass.toast : "fixed bottom-6 left-1/2 z-[300] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-2xl border border-rose-400/40 bg-rose-600 px-4 py-3 text-sm font-medium text-white shadow-2xl"}
        >
          {toast}
        </div>
      )}
    </>
  );
}

/** "Trình độ của bạn" on Tiến trình học tập (/progress): the observatory panel. */
export function ProficiencyCard() {
  const { locale } = useLanguage();
  const l: Locale = locale === 'en' ? 'en' : 'vi';
  return (
    <section aria-labelledby="proficiency-card-title" className={`${glass.panel} ${glass.enter2}`} data-tone="cyan">
      <div className={glass.head}>
        <span className={glass.icon} data-tone="cyan" aria-hidden="true"><GraduationCap className="h-5 w-5" /></span>
        <div className={glass.headText}>
          <h2 id="proficiency-card-title" className={glass.title}>{TEXT[l].yourLevel}</h2>
          <p className={glass.lead}>
            {l === 'vi' ? 'Đo từ bài thi và bài xếp lớp — không suy ra từ số hoạt động.' : 'Measured by exams and the placement quiz — never inferred from activity counts.'}
          </p>
        </div>
      </div>
      <ProficiencyCardContent locale={l} variant="observatory" />
    </section>
  );
}

const SKILL_GLYPH: Record<string, typeof Headphones> = { LISTENING: Headphones, READING: BookOpen, WRITING: PenLine, SPEAKING: MessageCircle };

/**
 * The observatory instruments: one track per skill on the same 0–1000 scale and CEFR ticks as SkillBar. A track fills
 * only for a determined rating (server status); an undetermined skill keeps an empty track and its status words.
 */
function ObservatoryView({ data, locale, onToggleVisibility, saving }: {
  data: ProficiencyMeResponse; locale: Locale; onToggleVisibility?: (next: boolean) => void; saving: boolean;
}) {
  const t = TEXT[locale];
  const o = data.overall;
  const undetermined = o.status === 'UNDETERMINED' || !o.currentCefr;
  const line = currentPeakLine(o, locale);
  const bySkill = new Map(data.skills.map((s) => [s.skill, s]));
  return (
    <div>
      <div className={glass.levelHead}>
        <span className={glass.levelValue}>{undetermined ? t.undetermined : o.currentCefr}</span>
        {!undetermined && o.rating != null && <span className={glass.levelRating}>{o.rating}</span>}
        {!undetermined && levelSourceLabel(o.status, locale) && (
          <span className={`${glass.pill} ${glass.pillMint}`} data-testid="overall-source-label">{levelSourceLabel(o.status, locale)}</span>
        )}
        <span className={`${glass.pill} ${glass.pillSky}`}>{o.confidenceLabel}</span>
        <span className={glass.orb} aria-hidden="true">
          <span className={glass.orbRing} />
          <span className={glass.orbPlanet} />
          <span className={glass.orbMoon} />
        </span>
      </div>
      {line && <p className={glass.levelLine}>{line}</p>}

      <div className={glass.tracks}>
        <div className={glass.trackRow} aria-hidden="true">
          <span />
          <div className={glass.trackScale}>
            {CEFR_TICKS.map((tick) => <span key={tick.cefr} style={{ left: `calc(${tick.at / 10}% + 2px)` }}>{tick.cefr}</span>)}
          </div>
        </div>
        {SKILL_ROWS.map((r) => {
          const skill = bySkill.get(r.skill);
          const status = skill?.status ?? 'UNDETERMINED';
          const determined = status !== 'UNDETERMINED' && status !== 'UNSUPPORTED' && skill?.rating != null;
          const Glyph = SKILL_GLYPH[r.skill] ?? BookOpen;
          return (
            <div key={r.skill} className={glass.trackRow} data-skill={r.skill} data-testid={`observatory-row-${r.skill}`}>
              <span className={glass.trackName}><span className={glass.trackGlyph} aria-hidden="true"><Glyph className="h-4 w-4" /></span>{r[locale]}</span>
              <div aria-hidden="true">
                <div className={glass.trackRail}>
                  {determined && <span className={glass.trackFill} data-status={status} style={{ width: `${ratingPercent(skill?.rating)}%` }} />}
                  {CEFR_TICKS.slice(1).map((tick) => <span key={tick.cefr} className={glass.trackTick} style={{ left: `${tick.at / 10}%` }} />)}
                </div>
              </div>
              <span className={glass.trackStatus}>
                {determined && skill?.cefr && <b>{skill.cefr}</b>}
                {skillStatusLabel(status, locale)}
              </span>
            </div>
          );
        })}
        <div className={glass.vocabRow}>
          <span className={glass.trackName}><span className={glass.trackGlyph} aria-hidden="true"><Languages className="h-4 w-4" /></span>{t.vocabulary}</span>
          <span className={glass.muted}>{skillStatusLabel('UNSUPPORTED', locale)}</span>
        </div>
      </div>

      {onToggleVisibility && (
        <div className={glass.switchRow}>
          <span className={glass.switchLabel}><Eye className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />{t.showOnBoard}</span>
          <button
            type="button"
            role="switch"
            aria-checked={data.showOnProficiencyBoard}
            aria-label={t.showOnBoard}
            disabled={saving}
            onClick={() => onToggleVisibility(!data.showOnProficiencyBoard)}
            className={glass.switch}
          >
            <span className={glass.knob} />
          </button>
        </div>
      )}
    </div>
  );
}
