'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { mutate as globalMutate } from 'swr';
import { AlertTriangle, CalendarClock, CheckCircle2, CloudOff, GraduationCap, HelpCircle, History, Info, RefreshCw, Trophy } from 'lucide-react';
import { LeaderboardModal } from './BoardStates';
import { useActivityMe, usePlacementMe } from '@/hooks/useLeaderboard';
import { leaderboardApi } from '@/services/leaderboardApi';
import { placementQuizStore } from '@/lib/leaderboard/placementQuizStore';
import {
  formatVnDate,
  PLACEMENT_DEFAULT_ITEMS,
  PLACEMENT_TEXT,
  placementCorrectLine,
  placementKeyAnswer,
  placementProgress,
  placementSavedLine,
  placementSkillLine,
  scopeName,
  splitPrompt,
  type Locale,
} from '@/lib/leaderboard/format';
import type { PlacementQuestion, PlacementSubmitResponse } from '@/types/leaderboard';

type Phase = 'intro' | 'resume' | 'confirmRestart' | 'starting' | 'question' | 'submitting' | 'submitPending'
  | 'result' | 'invalid' | 'locked' | 'error';

/** Phases in which leaving would interrupt an attempt (backdrop disabled, X / ESC ask first, page unload warns). */
const ACTIVE_PHASES: Phase[] = ['question', 'submitting', 'submitPending'];
/** Outcome screens: a stray click outside never dismisses them — only an explicit action (Đóng / X / ESC / a link). */
const OUTCOME_PHASES: Phase[] = ['result', 'invalid'];

/** Autosave debounce: one request per short burst of answers, never one per keystroke storm. */
export const PLACEMENT_SAVE_DEBOUNCE_MS = 400;

type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; at: string | null };

function httpStatus(e: unknown): number | null {
  const s = (e as { response?: { status?: number } })?.response?.status;
  return typeof s === 'number' ? s : null;
}

function httpMessage(e: unknown): string {
  const m = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
  return typeof m === 'string' ? m : '';
}

/** After a submit: the placement card, the division level, eligibility and both boards' "me" rows may change. */
function revalidateLevelCaches() {
  void globalMutate(
    (key) => Array.isArray(key) && typeof key[0] === 'string'
      && (key[0].startsWith('/leaderboard') || key[0].startsWith('/proficiency')),
  );
}

/** Start / abandon / autosave change only the resume state (`/placement/me.activeAttempt`). */
function revalidatePlacementMe() {
  void globalMutate((key) => Array.isArray(key) && key[0] === '/proficiency/placement/me');
}

const PRIMARY_BTN =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 disabled:opacity-60';
const SECONDARY_BTN =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 px-5 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400';
const OPTION_LETTERS = ['A', 'B', 'C', 'D'];
/** Optional standardized-exam link: deliberately quieter than the main action (never the way into the ranking). */
const VERIFY_LINK =
  'text-sm font-semibold text-sky-700 underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-sky-300';

/**
 * Division line on the result screen, read from /leaderboard/activity/me (division precedence lives on the server:
 * an exam-based level can outrank the placement). Mounted only on the result screen; the submit revalidation re-reads it.
 */
function ResultDivision({ locale }: { locale: Locale }) {
  const t = PLACEMENT_TEXT[locale];
  const me = useActivityMe('WEEK', null, 'ALL', { live: false });
  if (!me.data?.division) return null;
  return (
    <p className="text-sm font-semibold text-slate-700 dark:text-slate-200" data-testid="placement-result-division">
      {t.resultDivision}: {scopeName(me.data.division, locale)}
    </p>
  );
}

export interface PlacementQuizState {
  /** An attempt is open (leaving needs a confirmation). */
  active: boolean;
  /** The result / invalid screen is shown (no backdrop dismiss). */
  outcome: boolean;
  answered: number;
  total: number;
}

/**
 * "Bài xếp lớp nhanh" (model 2): intro / resume → one multiple-choice question per screen (vocabulary or grammar,
 * A1 → C1, four options + "Tôi chưa biết"; keys 1–4 / 0) → result (initial CEFR estimate + per-skill counts) / INVALID / locked.
 * The server issues the questions and scores the answers; the client never sees a level or an answer key.
 * Reliability (V69): every answer is autosaved on the server (debounced), an unfinished attempt is resumed with the same
 * questions and answers, a second attempt is never started silently, and a failed submit keeps the answers for a retry
 * (the server makes submit idempotent).
 */
export function PlacementQuiz({ locale, onClose, onViewLevel, onStateChange, flushRef, paused = false }: {
  locale: Locale;
  onClose: () => void;
  /** Result screen "Xem trình độ của bạn" (the host swaps the modal to the level card). */
  onViewLevel?: () => void;
  onStateChange?: (s: PlacementQuizState) => void;
  /** Filled with a function that saves pending answers immediately (used by "Thoát bài"). */
  flushRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  /** Keyboard answering is off while a confirmation dialog is shown over the quiz. */
  paused?: boolean;
}) {
  const t = PLACEMENT_TEXT[locale];
  const me = usePlacementMe();
  const [phase, setPhase] = useState<Phase>('intro');
  const [issue, setIssue] = useState<{ attemptId: string; items: PlacementQuestion[] } | null>(null);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [result, setResult] = useState<PlacementSubmitResponse | null>(null);
  const [errorText, setErrorText] = useState<string>(t.error);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [save, setSave] = useState<SaveState>({ status: 'idle', at: null });
  const busy = useRef(false);
  const pending = useRef<{ attemptId: string; answers: (number | null)[] } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const itemCount = issue?.items.length ?? me.data?.itemCount ?? PLACEMENT_DEFAULT_ITEMS;
  const active = me.data?.activeAttempt ?? null;
  const locked = me.data != null && !me.data.canRetake && !active;
  const showLocked = phase === 'locked' || (phase === 'intro' && locked);
  const lockedDate = formatVnDate(lockedUntil ?? me.data?.retakeAvailableAt);

  // An unfinished attempt is offered first (never a silent second attempt).
  useEffect(() => {
    if (phase === 'intro' && active) setPhase('resume');
  }, [phase, active]);

  useEffect(() => {
    onStateChange?.({
      active: ACTIVE_PHASES.includes(phase),
      outcome: OUTCOME_PHASES.includes(phase),
      answered: answers.length,
      total: issue?.items.length ?? itemCount,
    });
  }, [phase, answers.length, issue, itemCount, onStateChange]);

  // ---- autosave ------------------------------------------------------------------------------------------------
  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const job = pending.current;
    if (!job) return;
    pending.current = null;
    setSave((s) => ({ ...s, status: 'saving' }));
    try {
      const res = await leaderboardApi.savePlacementProgress(job.attemptId, job.answers);
      setSave({ status: 'saved', at: res.savedAt });
    } catch {
      // keep the newest answers queued and retry shortly; the answers on screen are never dropped
      if (!pending.current) pending.current = job;
      setSave((s) => ({ ...s, status: 'error' }));
      saveTimer.current = setTimeout(() => { void flush(); }, 3_000);
    }
  }, []);

  useEffect(() => {
    if (flushRef) flushRef.current = flush;
    return () => {
      if (flushRef) flushRef.current = null;
    };
  }, [flush, flushRef]);

  // flush on unmount (modal closed after "Thoát bài" / navigation inside the app)
  useEffect(() => () => {
    if (pending.current) void leaderboardApi.savePlacementProgress(pending.current.attemptId, pending.current.answers).catch(() => {});
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const queueSave = useCallback((attemptId: string, next: (number | null)[]) => {
    pending.current = { attemptId, answers: next };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flush(); }, PLACEMENT_SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Page unload (F5 / closing the tab / leaving the site) during an attempt: the browser's own "leave site?" prompt.
  useEffect(() => {
    if (!ACTIVE_PHASES.includes(phase)) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current) void flush();
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [phase, flush]);

  // ---- start / resume / restart ---------------------------------------------------------------------------------
  const start = async (replace = false) => {
    if (busy.current) return;
    busy.current = true;
    setPhase('starting');
    try {
      const res = await leaderboardApi.startPlacement(replace);
      setIssue({ attemptId: res.attemptId, items: res.items });
      setAnswers([]);
      setResult(null);
      setSave({ status: 'idle', at: null });
      setPhase('question');
      revalidatePlacementMe();
    } catch (e) {
      if (httpStatus(e) === 409) {
        const fresh = await me.mutate();
        if (httpMessage(e).startsWith('ACTIVE_ATTEMPT') || fresh?.activeAttempt) {
          setPhase('resume');
        } else {
          setLockedUntil(fresh?.retakeAvailableAt ?? null);
          setPhase('locked');
        }
      } else {
        setErrorText(t.error);
        setPhase('error');
      }
    } finally {
      busy.current = false;
    }
  };

  const resume = async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase('starting');
    try {
      const res = await leaderboardApi.getPlacementActive();
      if (!res) { // expired or finished meanwhile
        await me.mutate();
        setPhase('intro');
        return;
      }
      setIssue({ attemptId: res.attemptId, items: res.items });
      setAnswers(res.answers ?? []);
      setResult(null);
      setSave({ status: 'saved', at: res.updatedAt });
      setSubmitFailed(false);
      setPhase((res.answers?.length ?? 0) >= res.items.length ? 'submitPending' : 'question');
    } catch {
      setErrorText(t.error);
      setPhase('error');
    } finally {
      busy.current = false;
    }
  };

  // ---- submit (idempotent on the server; answers are kept on failure) ------------------------------------------
  const submit = useCallback(async (all: (number | null)[], attemptId: string) => {
    setPhase('submitting');
    try {
      const res = await leaderboardApi.submitPlacement(attemptId, all);
      pending.current = null;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setResult(res);
      setPhase(res.status === 'VALID' ? 'result' : 'invalid');
      revalidateLevelCaches();
    } catch (e) {
      if (httpStatus(e) === 410) {
        setErrorText(t.expired);
        setPhase('error');
        revalidatePlacementMe();
        return;
      }
      // network / server error: keep every answer, save them, offer "Gửi bài" again
      queueSave(attemptId, all);
      setSubmitFailed(true);
      setPhase('submitPending');
    }
  }, [t.expired, queueSave]);

  const answer = useCallback((choice: number | null) => {
    if (phase !== 'question' || !issue || busy.current) return;
    const next = [...answers, choice];
    setAnswers(next);
    if (next.length >= issue.items.length) {
      busy.current = true;
      void submit(next, issue.attemptId).finally(() => { busy.current = false; });
    } else {
      queueSave(issue.attemptId, next);
    }
  }, [phase, issue, answers, submit, queueSave]);

  useEffect(() => {
    if (phase !== 'question' || paused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const v = placementKeyAnswer(e.key);
      if (v == null) return;
      e.preventDefault();
      answer(v === 'skip' ? null : v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, answer, paused]);

  // ---- screens -------------------------------------------------------------------------------------------------
  if (phase === 'resume' && active) {
    return (
      <div className="space-y-4" data-testid="placement-resume">
        <div className="flex items-center gap-3">
          <History className="h-8 w-8 shrink-0 text-sky-500" aria-hidden="true" />
          <div>
            <p className="text-base font-bold text-slate-900 dark:text-white">{t.resumeTitle}</p>
            <p className="text-sm text-slate-600 dark:text-slate-300" data-testid="placement-resume-progress">{t.resumeProgress(active.answered, active.total)}</p>
          </div>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]">
          <div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-600" style={{ width: `${placementProgress(active.answered, active.total)}%` }} />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={() => setPhase('confirmRestart')} className={SECONDARY_BTN} data-testid="placement-restart">{t.restart}</button>
          <button type="button" onClick={resume} className={PRIMARY_BTN} data-testid="placement-resume-continue" autoFocus>{t.resume}</button>
        </div>
      </div>
    );
  }

  if (phase === 'confirmRestart') {
    return (
      <div className="space-y-4" role="alertdialog" aria-label={t.restartConfirmTitle} data-testid="placement-restart-confirm">
        <AlertTriangle className="h-8 w-8 text-amber-500" aria-hidden="true" />
        <p className="text-base font-bold text-slate-900 dark:text-white">{t.restartConfirmTitle}</p>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t.restartConfirmBody}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => setPhase(active ? 'resume' : 'intro')} className={PRIMARY_BTN} autoFocus>{t.back}</button>
          <button type="button" onClick={() => start(true)} className={SECONDARY_BTN} data-testid="placement-restart-confirm-button">{t.restartConfirm}</button>
        </div>
      </div>
    );
  }

  if (showLocked) {
    return (
      <div className="space-y-4 text-center" data-testid="placement-locked">
        <CalendarClock className="mx-auto h-10 w-10 text-sky-500" aria-hidden="true" />
        <p className="text-base font-bold text-slate-900 dark:text-white">{t.lockedTitle}</p>
        {me.data?.resultCefr && (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <span className="mr-1.5 text-lg font-black text-slate-900 dark:text-white">{me.data.resultCefr}</span>
            {t.resultSource}
          </p>
        )}
        {lockedDate && <p className="text-sm text-slate-600 dark:text-slate-300">{t.lockedBody(lockedDate)}</p>}
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" onClick={onClose} className={PRIMARY_BTN}>{t.close}</button>
        </div>
        <Link href="/exams" className={VERIFY_LINK}>{t.verifyLink}</Link>
      </div>
    );
  }

  if (phase === 'intro' || phase === 'starting') {
    return (
      <div className="space-y-4" data-testid="placement-intro">
        <div className="flex items-center gap-3">
          <GraduationCap className="h-8 w-8 shrink-0 text-sky-500" aria-hidden="true" />
          <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{t.introLead(itemCount)}</p>
        </div>
        {me.data?.outdated && (
          <p className="flex items-start gap-2 rounded-2xl border border-sky-400/40 bg-sky-500/10 px-3 py-2.5 text-sm text-sky-800 dark:text-sky-200" data-testid="placement-outdated">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t.outdatedNotice}
          </p>
        )}
        <p className="text-sm text-slate-600 dark:text-slate-300">{t.introHow}</p>
        <p className="flex items-start gap-2 rounded-2xl border border-amber-400/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
          <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t.introWarning}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t.introNote}</p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={SECONDARY_BTN}>{t.close}</button>
          <button type="button" onClick={() => start(false)} disabled={phase === 'starting' || me.isLoading} className={PRIMARY_BTN} data-testid="placement-start">
            {phase === 'starting' ? '…' : t.start}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'question' && issue) {
    const i = Math.min(answers.length, issue.items.length - 1);
    const q = issue.items[i];
    const [before, after] = splitPrompt(q?.prompt ?? '');
    const pct = placementProgress(answers.length, issue.items.length);
    const savedLine = save.status === 'saved' ? placementSavedLine(save.at, locale) : null;
    return (
      <div className="space-y-5" data-testid="placement-question">
        <div>
          <div className="mb-1.5 flex justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span aria-live="polite">{t.progress(answers.length + 1, issue.items.length)}</span>
            <span>{pct}%</span>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={issue.items.length}
            aria-valuenow={answers.length}
            aria-label={t.title}
          >
            <div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <span
          className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${q?.skill === 'GRAMMAR' ? 'bg-violet-500/15 text-violet-700 dark:text-violet-200' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'}`}
          data-testid="placement-skill"
        >
          {q?.skill === 'GRAMMAR' ? t.skillGrammar : t.skillVocabulary}
        </span>
        <p className="break-words py-2 text-lg font-semibold leading-relaxed text-slate-900 dark:text-white sm:text-xl" lang="en" data-testid="placement-prompt">
          {before}
          <span className="mx-1 inline-block min-w-[4.5rem] border-b-2 border-sky-500 text-center align-baseline" aria-label="___">&nbsp;</span>
          {after}
        </p>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" role="group" aria-label={t.title}>
          {(q?.options ?? []).map((opt, k) => (
            <button
              key={`${i}-${k}`}
              type="button"
              onClick={() => answer(k)}
              lang="en"
              className="flex min-h-[3.25rem] items-center gap-3 rounded-2xl border-2 border-slate-200 bg-white px-4 text-left text-base font-semibold text-slate-800 hover:border-sky-400 hover:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:border-slate-700 dark:bg-white/[0.03] dark:text-slate-100 dark:hover:bg-white/[0.07]"
              data-testid="placement-option"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-black text-slate-500 dark:bg-white/10 dark:text-slate-300" aria-hidden="true">
                {OPTION_LETTERS[k]}
              </span>
              {opt}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => answer(null)}
            className="rounded-xl px-3 py-2 text-sm font-semibold text-slate-500 underline-offset-4 hover:text-slate-800 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:text-slate-400 dark:hover:text-white"
            data-testid="placement-skip"
          >
            {t.skip}
          </button>
          <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400" aria-live="polite" data-testid="placement-save-status">
            {save.status === 'saving' && t.saving}
            {savedLine && <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />{savedLine}</>}
            {save.status === 'error' && <><CloudOff className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />{t.saveRetry}</>}
          </span>
          <p className="hidden w-full text-right text-xs text-slate-500 dark:text-slate-400 sm:block">{t.keyboardHint}</p>
        </div>
      </div>
    );
  }

  if (phase === 'submitting') {
    return (
      <div role="status" className="flex flex-col items-center gap-3 py-10 text-sm text-slate-600 dark:text-slate-300">
        <RefreshCw className="h-6 w-6 animate-spin text-sky-500 motion-reduce:animate-none" aria-hidden="true" />
        {t.submitting}
      </div>
    );
  }

  if (phase === 'submitPending' && issue) {
    return (
      <div className="space-y-4 text-center" data-testid="placement-submit-pending">
        {submitFailed
          ? <CloudOff className="mx-auto h-10 w-10 text-amber-500" aria-hidden="true" />
          : <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" aria-hidden="true" />}
        <p className="text-base font-bold text-slate-900 dark:text-white">{submitFailed ? t.submitFailedTitle : t.readyTitle}</p>
        <p className="text-sm text-slate-600 dark:text-slate-300">{submitFailed ? t.submitFailedBody : t.readyBody}</p>
        <p className="text-xs text-slate-500">{t.resumeProgress(answers.length, issue.items.length)}</p>
        <button
          type="button"
          onClick={() => { if (!busy.current) { busy.current = true; void submit(answers, issue.attemptId).finally(() => { busy.current = false; }); } }}
          className={PRIMARY_BTN}
          data-testid="placement-resubmit"
          autoFocus
        >
          {t.resubmit}
        </button>
      </div>
    );
  }

  if (phase === 'result' && result) {
    const retake = formatVnDate(result.retakeAvailableAt);
    const skills = placementSkillLine(result, locale);
    const correct = placementCorrectLine(result, locale);
    return (
      <div className="space-y-4 text-center" data-testid="placement-result">
        <p className="text-xs font-bold uppercase tracking-wider text-sky-600 dark:text-sky-300">{t.resultTitle}</p>
        <p className="text-5xl font-black text-slate-900 dark:text-white" data-testid="placement-result-cefr">{result.resultCefr}</p>
        <span className="inline-flex rounded-full border border-sky-400/40 bg-sky-500/10 px-3 py-1 text-xs font-semibold text-sky-700 dark:text-sky-200">
          {t.resultSource}
        </span>
        {correct && <p className="text-base font-bold text-slate-900 dark:text-white" data-testid="placement-result-correct">{correct}</p>}
        {skills && <p className="text-sm font-semibold text-slate-700 dark:text-slate-200" data-testid="placement-skill-line">{skills}</p>}
        <ResultDivision locale={locale} />
        <p className="flex items-center justify-center gap-2 rounded-2xl border border-emerald-400/40 bg-emerald-500/10 px-3 py-2.5 text-sm font-semibold text-emerald-800 dark:text-emerald-200" data-testid="placement-result-joined">
          <Trophy className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t.resultJoined}
        </p>
        {result.lowConfidence && <p className="text-sm text-amber-700 dark:text-amber-300">{t.lowConfidence}</p>}
        <p className="text-xs text-slate-500 dark:text-slate-400" data-testid="placement-result-disclaimer">{t.resultDisclaimer}</p>
        {retake && <p className="text-xs text-slate-500 dark:text-slate-400">{t.retakeOn(retake)}</p>}
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          <Link href="/leaderboard" onClick={onClose} className={PRIMARY_BTN} data-testid="placement-view-board">{t.viewBoard}</Link>
          {onViewLevel && (
            <button type="button" onClick={onViewLevel} className={SECONDARY_BTN} data-testid="placement-view-level">{t.viewLevel}</button>
          )}
          <button type="button" onClick={onClose} className={SECONDARY_BTN} data-testid="placement-result-close">{t.close}</button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t.optionalVerify}{' '}
          <Link href="/exams" className={VERIFY_LINK} data-testid="placement-verify-link">{t.verifyLink}</Link>
        </p>
      </div>
    );
  }

  if (phase === 'invalid') {
    return (
      <div className="space-y-4 text-center" data-testid="placement-invalid">
        <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" aria-hidden="true" />
        <p className="text-base font-bold text-slate-900 dark:text-white">{t.invalidTitle}</p>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t.invalidBody}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => { setPhase('intro'); setIssue(null); setAnswers([]); }} className={PRIMARY_BTN}>{t.retry}</button>
          <button type="button" onClick={onClose} className={SECONDARY_BTN}>{t.close}</button>
        </div>
      </div>
    );
  }

  return (
    <div role="alert" className="space-y-4 text-center">
      <p className="text-sm font-medium text-rose-700 dark:text-rose-300">{errorText}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" onClick={() => { setPhase('intro'); setIssue(null); setAnswers([]); void me.mutate(); }} className={PRIMARY_BTN}>{t.retry}</button>
        <button type="button" onClick={onClose} className={SECONDARY_BTN}>{t.close}</button>
      </div>
    </div>
  );
}

/**
 * Modal wrapper; the quiz state is reset every time it opens (mounted only while open) — but nothing is lost: the
 * attempt lives on the server and is offered for resume. While an attempt is open, a click outside does nothing and
 * X / ESC ask "Thoát bài xếp lớp?" ("Tiếp tục làm" is the default and ESC keeps the learner in the quiz).
 * Rendered once by `PlacementQuizHost` (app providers), never inside a conditionally rendered entry button.
 */
export function PlacementQuizModal({ open, onClose, onViewLevel, locale }: {
  open: boolean; onClose: () => void; onViewLevel?: () => void; locale: Locale;
}) {
  const t = PLACEMENT_TEXT[locale];
  const [state, setState] = useState<PlacementQuizState>({ active: false, outcome: false, answered: 0, total: PLACEMENT_DEFAULT_ITEMS });
  const [confirmExit, setConfirmExit] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const flushRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!open) {
      setConfirmExit(false);
      setState({ active: false, outcome: false, answered: 0, total: PLACEMENT_DEFAULT_ITEMS });
    }
  }, [open]);

  const requestClose = useCallback(() => {
    if (confirmExit) {
      setConfirmExit(false); // ESC / X on the dialog = stay in the quiz (safe default)
      return;
    }
    if (state.active) {
      setConfirmExit(true);
      return;
    }
    onClose();
  }, [confirmExit, state.active, onClose]);

  const leave = async () => {
    setLeaving(true);
    try {
      await Promise.race([flushRef.current?.() ?? Promise.resolve(), new Promise((r) => setTimeout(r, 4_000))]);
    } finally {
      setLeaving(false);
      setConfirmExit(false);
      revalidatePlacementMe();
      onClose();
    }
  };

  return (
    <LeaderboardModal open={open} title={t.title} closeLabel={t.close} onClose={requestClose} dismissOnBackdrop={!state.active && !state.outcome}>
      {open && (
        <div className="relative">
          <PlacementQuiz locale={locale} onClose={onClose} onViewLevel={onViewLevel} onStateChange={setState} flushRef={flushRef} paused={confirmExit} />
          {confirmExit && (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-white/95 p-2 dark:bg-[#0E131F]/95"
              role="alertdialog"
              aria-modal="true"
              aria-label={t.exitTitle}
              data-testid="placement-exit-confirm"
            >
              <div className="w-full max-w-sm space-y-4 text-center">
                <AlertTriangle className="mx-auto h-9 w-9 text-amber-500" aria-hidden="true" />
                <p className="text-base font-bold text-slate-900 dark:text-white">{t.exitTitle}</p>
                <p className="text-sm text-slate-600 dark:text-slate-300">{t.exitBody(state.answered, state.total)}</p>
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
                  <button type="button" onClick={leave} disabled={leaving} className={SECONDARY_BTN} data-testid="placement-exit-leave">
                    {leaving ? '…' : t.exitQuiz}
                  </button>
                  <button type="button" onClick={() => setConfirmExit(false)} className={PRIMARY_BTN} data-testid="placement-exit-stay" autoFocus>
                    {t.keepGoing}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </LeaderboardModal>
  );
}

/**
 * Button that opens the quiz (used in "Trình độ của bạn", the division CTA, the leaderboard banner and "Hạng của bạn").
 * It owns no modal: these buttons disappear once the learner is placed, so the modal lives in the app-wide host.
 */
export function PlacementQuizButton({ locale, label, className, testId }: {
  locale: Locale; label?: string; className?: string; testId?: string;
}) {
  return (
    <button type="button" onClick={() => placementQuizStore.open(locale)} className={className ?? PRIMARY_BTN} data-testid={testId}>
      <GraduationCap className="h-4 w-4" aria-hidden="true" />
      {label ?? PLACEMENT_TEXT[locale].takeQuiz}
    </button>
  );
}
