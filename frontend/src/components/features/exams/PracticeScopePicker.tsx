'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession, signIn } from 'next-auth/react';
import { AlertCircle, BookOpen, Headphones, Hourglass, Loader2, Lock, Mic, PenLine, Play, RotateCcw, RotateCw } from 'lucide-react';
import { examsApi } from '@/services/examsApi';
import type { ExamFamily, PracticeCatalogDto, PracticeScopeDto } from '@/types/exams';
import { useLanguage } from '@/context/LanguageContext';
import { BackButton } from './BackButton';
import { canStartPractice, practiceAvailabilityLabel, practiceScopeHint } from '@/lib/exams/practice';
import { toeicPartName, toeicPartTerm } from '@/lib/exams/runnerModel';
import { startErrorMessage } from './SimulationStartDialog';

interface PracticeScopePickerProps {
  family: ExamFamily;
  formId: string;
  /** Rendered inside the test detail page (no page chrome). */
  embedded?: boolean;
  /** scopeCode → attemptId of the learner's unfinished practice of that scope ("Tiếp tục"). */
  resumeByScope?: Record<string, string>;
}

const SKILL_ORDER = ['LISTENING', 'READING', 'WRITING', 'SPEAKING'];

function skillIcon(skill: string) {
  if (skill === 'LISTENING') return <Headphones className="w-4 h-4" aria-hidden />;
  if (skill === 'WRITING') return <PenLine className="w-4 h-4" aria-hidden />;
  if (skill === 'SPEAKING') return <Mic className="w-4 h-4" aria-hidden />;
  return <BookOpen className="w-4 h-4" aria-hidden />;
}

function groupTitle(family: ExamFamily, skill: string, lang: 'vi' | 'en'): string {
  if (family === 'TOEIC') {
    if (skill === 'LISTENING') return lang === 'vi' ? 'Nghe · Part 1–4' : 'Listening · Parts 1–4';
    if (skill === 'READING') return lang === 'vi' ? 'Đọc · Part 5–7' : 'Reading · Parts 5–7';
  }
  if (skill === 'LISTENING') return lang === 'vi' ? 'Nghe · Listening' : 'Listening';
  if (skill === 'WRITING') return lang === 'vi' ? 'Viết · Writing' : 'Writing';
  if (skill === 'SPEAKING') return lang === 'vi' ? 'Nói · Speaking' : 'Speaking';
  return lang === 'vi' ? 'Đọc · Reading' : 'Reading';
}

function scopeTitle(scope: PracticeScopeDto): string {
  switch (scope.scopeType) {
    case 'TOEIC_PART':
      return `Part ${scope.number}`;
    case 'IELTS_LISTENING_SECTION':
      return `Section ${scope.number}`;
    case 'IELTS_READING_PASSAGE':
      return `Passage ${scope.number}`;
    case 'IELTS_WRITING_TASK':
      return `Task ${scope.number}`;
    case 'IELTS_SPEAKING_PART':
      return `Part ${scope.number}`;
    default:
      return '';
  }
}

/**
 * Exams Phase 6 / 7 — choose ONE Part / Section / Passage / Task of a test and start an untimed practice attempt.
 * Availability is the server's scope readiness (learner states only, never reason codes). Only AVAILABLE scopes are
 * interactive; "Đang hoàn thiện nội dung" / "Chưa khả dụng" rows are plain text, never a dead button.
 */
export function PracticeScopePicker({ family, formId, embedded = false, resumeByScope = {} }: PracticeScopePickerProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const { language } = useLanguage();
  const lang: 'vi' | 'en' = language === 'en' ? 'en' : 'vi';
  const familySlug = family.toLowerCase();

  const [catalog, setCatalog] = useState<PracticeCatalogDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startingScope, setStartingScope] = useState<string | null>(null);
  // `?part=` (Lộ trình học): the part the learner was sent to practise is marked and scrolled into view
  const assignedPart = useSearchParams()?.get('part') ?? null;

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    examsApi
      .getPracticeScopes(formId)
      .then((c) => !cancelled && setCatalog(c))
      .catch(() => !cancelled && setLoadError(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [formId]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (!assignedPart || !catalog) return;
    const el = document.querySelector(`[data-scope-code="${CSS.escape(assignedPart)}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [assignedPart, catalog]);

  const start = async (scope: PracticeScopeDto) => {
    if (!canStartPractice(scope.availability) || startingScope) return;
    const resumeId = resumeByScope[scope.scopeCode];
    if (resumeId) {
      router.push(`/exams/${familySlug}/attempts/${resumeId}`);
      return;
    }
    setStartingScope(scope.scopeCode);
    setError(null);
    try {
      const attempt = await examsApi.createPracticeAttempt(formId, scope.scopeCode);
      router.push(`/exams/${familySlug}/attempts/${attempt.attemptId}`);
    } catch (err: any) {
      setError(startErrorMessage(err, lang));
      setStartingScope(null);
    }
  };

  const grouped = SKILL_ORDER.map((skill) => ({
    skill,
    scopes: (catalog?.scopes || []).filter((s) => s.skill === skill && (family === 'IELTS' || ['LISTENING', 'READING'].includes(s.skill))).sort((a, b) => a.number - b.number),
  })).filter((g) => g.scopes.length > 0);

  const body = (
    <div className="space-y-5">
      {!session && (
        <div className="p-3 bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-200 text-sm rounded-xl flex items-center justify-between gap-2">
          <span>{lang === 'vi' ? 'Đăng nhập để bắt đầu luyện tập.' : 'Sign in to start practising.'}</span>
          <button type="button" onClick={() => signIn()} className="h-9 px-3 bg-amber-600 text-white text-xs font-bold rounded-lg">
            {lang === 'vi' ? 'Đăng nhập' : 'Sign in'}
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="p-3 bg-rose-500/10 border border-rose-500/30 text-rose-700 dark:text-rose-300 text-sm rounded-xl flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="space-y-3" role="status" aria-live="polite">
          <span className="sr-only">{lang === 'vi' ? 'Đang tải các phần luyện tập…' : 'Loading practice parts…'}</span>
          {[0, 1].map((g) => (
            <div key={g} className="space-y-2">
              <div className="h-4 w-32 rounded bg-muted animate-pulse motion-reduce:animate-none" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-[88px] rounded-xl bg-muted/50 animate-pulse motion-reduce:animate-none" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : loadError ? (
        <div className="p-5 rounded-xl border border-border bg-card text-center space-y-3">
          <p className="text-sm text-muted-foreground">{lang === 'vi' ? 'Không tải được danh sách phần luyện tập.' : 'Could not load the practice parts.'}</p>
          <button type="button" onClick={load} className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg border border-border text-xs font-semibold hover:bg-muted">
            <RotateCw className="w-3.5 h-3.5" aria-hidden />
            {lang === 'vi' ? 'Thử lại' : 'Try again'}
          </button>
        </div>
      ) : grouped.length === 0 ? (
        <div className="p-5 rounded-xl border border-dashed border-border text-center text-sm text-muted-foreground">
          {lang === 'vi' ? 'Đề này chưa có phần luyện tập.' : 'This test has no practice parts yet.'}
        </div>
      ) : (
        grouped.map((g) => (
          <section key={g.skill} className="space-y-2.5" aria-labelledby={`scope-group-${g.skill}`}>
            <h3 id={`scope-group-${g.skill}`} className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              {skillIcon(g.skill)}
              {groupTitle(family, g.skill, lang)}
            </h3>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {g.scopes.map((scope) => {
                const available = canStartPractice(scope.availability);
                const inProgress = scope.availability === 'CONTENT_IN_PROGRESS';
                const resumeId = resumeByScope[scope.scopeCode];
                const name = scope.scopeType === 'TOEIC_PART' ? toeicPartName(scope.number, lang) : practiceScopeHint(scope, lang);
                const term = scope.scopeType === 'TOEIC_PART' && lang === 'vi' ? toeicPartTerm(scope.number) : '';
                const count = scope.objectiveScoring
                  ? lang === 'vi' ? `${scope.questionCount} câu` : `${scope.questionCount} questions`
                  : scope.skill === 'SPEAKING'
                  ? lang === 'vi' ? `${scope.questionCount} câu hỏi nói` : `${scope.questionCount} speaking questions`
                  : lang === 'vi' ? '1 bài viết' : '1 writing task';
                const badge = (
                  <span
                    className={`self-start inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                      available
                        ? resumeId
                          ? 'bg-sky-500/15 text-sky-800 dark:text-sky-200'
                          : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {available ? (
                      startingScope === scope.scopeCode ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                      ) : resumeId ? (
                        <RotateCcw className="w-3.5 h-3.5" aria-hidden />
                      ) : (
                        <Play className="w-3.5 h-3.5 fill-current" aria-hidden />
                      )
                    ) : inProgress ? (
                      <Hourglass className="w-3.5 h-3.5" aria-hidden />
                    ) : (
                      <Lock className="w-3.5 h-3.5" aria-hidden />
                    )}
                    {available && resumeId ? (lang === 'vi' ? 'Tiếp tục' : 'Continue') : practiceAvailabilityLabel(scope.availability, lang)}
                  </span>
                );
                const content = (
                  <span className="flex-1 min-w-0 flex flex-col gap-1.5">
                    <span className="flex items-baseline gap-2 min-w-0">
                      <span className="text-sm font-bold text-foreground whitespace-nowrap">{scopeTitle(scope)}</span>
                      <span className="text-sm text-foreground/90 truncate">{name}</span>
                    </span>
                    <span className="text-[11px] text-muted-foreground truncate">{[term, count].filter(Boolean).join(' · ')}</span>
                    {badge}
                  </span>
                );
                return (
                  <li key={scope.scopeCode} data-scope-code={scope.scopeCode} data-availability={scope.availability}
                    className={assignedPart === scope.scopeCode ? 'rounded-xl ring-2 ring-sky-500 ring-offset-2 ring-offset-background' : undefined}>
                    {available && session && (
                      <button
                        type="button"
                        onClick={() => start(scope)}
                        disabled={startingScope !== null}
                        aria-label={`${scopeTitle(scope)} ${name} – ${resumeId ? (lang === 'vi' ? 'tiếp tục' : 'continue') : lang === 'vi' ? 'bắt đầu luyện' : 'start practice'}`}
                        className="w-full min-h-[88px] flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {content}
                      </button>
                    )}
                    {(!available || !session) && (
                      <div
                        aria-disabled="true"
                        className={`w-full min-h-[88px] flex items-start gap-3 rounded-xl border px-4 py-3 ${
                          available ? 'border-border bg-card' : 'border-dashed border-border bg-muted/20 opacity-80'
                        }`}
                      >
                        {content}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <BackButton href={`/exams/${familySlug}`} label={lang === 'vi' ? 'Về kho đề' : 'Back to library'} />
      <header className="space-y-1">
        <h1 className="text-2xl font-extrabold text-foreground">{lang === 'vi' ? 'Luyện theo phần' : 'Practice by part'}</h1>
        {catalog?.title && <p className="text-sm text-muted-foreground">{catalog.title}</p>}
      </header>
      {body}
    </div>
  );
}

export default PracticeScopePicker;
