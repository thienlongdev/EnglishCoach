'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Compass, Loader2, PlayCircle, Target } from 'lucide-react';
import { examsApi } from '@/services/examsApi';
import { useExamHistory } from '@/hooks/useExamCatalog';
import type { ExamFamily, FamilyAnalyticsDto, PracticeRecommendationDto } from '@/types/exams';
import { practiceScopeHint } from '@/lib/exams/practice';
import {
  reasonText,
  recommendationCta,
  recommendationKindLabel,
  recommendationSampleText,
  recommendationStatusText,
  scopeName,
} from '@/lib/exams/analytics';

interface Props {
  families: FamilyAnalyticsDto[];
  lang: 'vi' | 'en';
  /** Show the family name on each card (Exams home lists both families). */
  showFamily?: boolean;
  headingId?: string;
}

const KIND_STYLE: Record<string, string> = {
  FOCUS: 'bg-amber-500/15 text-amber-900 dark:text-amber-200',
  COVERAGE: 'bg-sky-500/15 text-sky-900 dark:text-sky-200',
  START: 'bg-emerald-500/15 text-emerald-900 dark:text-emerald-200',
};

/**
 * Exams Phase 8 — "Gợi ý luyện tập": a few deterministic suggestions of canonical practice scopes, each with the
 * server's data-backed reason and its sample size. Suggestions only: nothing starts until the learner clicks, and every
 * other AVAILABLE scope stays one link away ("Chọn phần khác"). No AI, no fetch on hover.
 */
export function ExamPracticeRecommendations({ families, lang, showFamily = false, headingId = 'exams-recommendations' }: Props) {
  const router = useRouter();
  const { items: history } = useExamHistory(showFamily ? 'ALL' : families[0]?.family ?? null, 50);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blocks = families.filter((f) => f.recommendations);
  if (blocks.length === 0) return null;

  async function open(family: ExamFamily, rec: PracticeRecommendationDto) {
    const key = `${rec.formId}:${rec.scopeCode}`;
    if (busy) return;
    setBusy(key);
    setError(null);
    const familySlug = family.toLowerCase();
    try {
      const cta = recommendationCta(rec, history);
      if (cta.kind === 'resume') {
        router.push(`/exams/${familySlug}/attempts/${cta.attemptId}`);
        return;
      }
      const attempt = await examsApi.createPracticeAttempt(rec.formId, rec.scopeCode);
      router.push(`/exams/${familySlug}/attempts/${attempt.attemptId}`);
    } catch {
      setError(lang === 'vi'
        ? 'Chưa mở được phần luyện tập này. Bạn có thể thử lại hoặc chọn phần khác trong kho đề.'
        : 'Could not open this practice part. Try again or pick another part from the library.');
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="ec-wp-plate inline-flex items-center gap-2 text-base font-bold text-foreground">
          <Compass className="w-4 h-4 text-muted-foreground" aria-hidden />
          {lang === 'vi' ? 'Gợi ý luyện tập' : 'Suggested practice'}
        </h2>
        <p className="ec-wp-plate text-[11px] text-muted-foreground">
          {lang === 'vi'
            ? 'Dựa trên các lần luyện tập gần đây của bạn. Bạn luôn có thể chọn phần khác.'
            : 'Based on your recent practice. You can always choose another part.'}
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-800 dark:text-rose-200">
          {error}
        </p>
      )}

      {blocks.map((f) => {
        const status = recommendationStatusText(f.recommendations.status, lang);
        const familySlug = f.family.toLowerCase();
        return (
          <div key={f.family} className="space-y-2" data-recommendation-status={f.recommendations.status}>
            {showFamily && <p className="ec-wp-plate w-fit text-xs font-bold uppercase tracking-wide text-muted-foreground">{f.family}</p>}
            {status && <p className="ec-wp-plate w-fit text-sm text-muted-foreground leading-relaxed">{status}</p>}
            {f.recommendations.items.length > 0 && (
              <ul className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {f.recommendations.items.map((rec) => {
                  const ref = { scopeType: rec.scopeType, scopeNumber: rec.scopeNumber };
                  const reasons = rec.reasons.map((r) => reasonText(r.code, r.facts, ref, lang)).filter(Boolean);
                  const sample = recommendationSampleText(rec.sampleQuestions, rec.sampleAttempts, lang);
                  const key = `${rec.formId}:${rec.scopeCode}`;
                  const cta = recommendationCta(rec, history);
                  return (
                    <li key={key} className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-foreground">{scopeName(ref, lang)}</p>
                          <p className="text-xs text-muted-foreground">{practiceScopeHint({ scopeType: rec.scopeType, number: rec.scopeNumber }, lang)}</p>
                        </div>
                        <span className={`shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-semibold ${KIND_STYLE[rec.kind] || KIND_STYLE.START}`}>
                          {rec.kind === 'FOCUS' && <Target className="w-3 h-3" aria-hidden />}
                          {recommendationKindLabel(rec.kind, lang)}
                        </span>
                      </div>
                      <ul className="space-y-1 text-xs text-foreground/90 leading-relaxed list-disc pl-4">
                        {reasons.map((r) => <li key={r}>{r}</li>)}
                      </ul>
                      <div className="mt-auto space-y-2">
                        {sample && <p className="text-[11px] text-muted-foreground">{sample}</p>}
                        {rec.formTitle && <p className="text-[11px] text-muted-foreground truncate" title={rec.formTitle}>{rec.formTitle}</p>}
                        <button
                          type="button"
                          onClick={() => open(f.family, rec)}
                          disabled={busy !== null}
                          className="w-full inline-flex items-center justify-center gap-1.5 h-10 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {busy === key ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <PlayCircle className="w-4 h-4" aria-hidden />}
                          {cta.kind === 'resume'
                            ? (lang === 'vi' ? 'Tiếp tục phần này' : 'Continue this part')
                            : (lang === 'vi' ? 'Luyện phần này' : 'Practise this part')}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <Link
              href={`/exams/${familySlug}?view=library`}
              className="ec-wp-plate inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              {lang === 'vi' ? `Chọn phần khác trong kho đề ${f.family}` : `Choose another part in the ${f.family} library`}
              <ArrowRight className="w-3.5 h-3.5" aria-hidden />
            </Link>
          </div>
        );
      })}
    </section>
  );
}

export default ExamPracticeRecommendations;
