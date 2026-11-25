'use client';

import React from 'react';
import { ArrowLeft, ArrowRight, Clock, GraduationCap, Infinity as InfinityIcon, Loader2, Send, ShieldCheck } from 'lucide-react';
import { SaveStatusIndicator } from './SaveStatusIndicator';
import { formatClock, modeLabel, timerTone, type RunnerMode, type SaveStatus, type UxLang } from '@/lib/exams/runnerModel';

export interface RunnerHeaderAction {
  kind: 'advance' | 'submit';
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
}

interface ExamRunnerHeaderProps {
  lang: UxLang;
  mode: RunnerMode;
  /** Practice scope label ("TOEIC Part 5 · Hoàn thành câu"); null for simulation / whole-skill practice. */
  scopeLabel?: string | null;
  title: string;
  /** Current section skill label ("Listening") — shown next to the title. */
  sectionLabel?: string | null;
  isUntimed: boolean;
  remainingSeconds: number;
  saveStatus: SaveStatus | string;
  onRetrySave?: () => void;
  onExit: () => void;
  action: RunnerHeaderAction;
  /** Optional section strip (simulation sequence) rendered as a second row. */
  sectionStrip?: React.ReactNode;
}

/**
 * Exams Phase 7 — compact runner chrome. Mode is visible at a glance and never ambiguous:
 *  - simulation: indigo accent line + "Thi đầy đủ" shield chip + server countdown (calm; amber < 10 min, rose < 2 min);
 *  - practice: emerald accent line + "Luyện theo phần" chip + scope + "Không giới hạn thời gian" (no fake countdown).
 */
export function ExamRunnerHeader({
  lang,
  mode,
  scopeLabel,
  title,
  sectionLabel,
  isUntimed,
  remainingSeconds,
  saveStatus,
  onRetrySave,
  onExit,
  action,
  sectionStrip,
}: ExamRunnerHeaderProps) {
  const isSim = mode === 'SIMULATION';
  const tone = timerTone(remainingSeconds);

  return (
    <header
      data-runner-mode={mode}
      className={`shrink-0 z-40 bg-card/95 backdrop-blur border-b border-border border-t-2 ${
        isSim ? 'border-t-indigo-500' : 'border-t-emerald-500'
      }`}
    >
      <div className="h-14 px-2 sm:px-4 flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onExit}
          aria-label={lang === 'vi' ? 'Thoát bài làm' : 'Leave'}
          className="h-9 px-2 sm:px-2.5 inline-flex items-center gap-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden />
          <span className="hidden lg:inline">{lang === 'vi' ? 'Thoát' : 'Leave'}</span>
        </button>

        <span
          data-mode-chip={mode}
          className={`shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-bold tracking-wide ${
            isSim
              ? 'bg-indigo-600 text-white dark:bg-indigo-500'
              : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40'
          }`}
        >
          {isSim ? <ShieldCheck className="w-3.5 h-3.5" aria-hidden /> : <GraduationCap className="w-3.5 h-3.5" aria-hidden />}
          <span className="hidden sm:inline">{modeLabel(mode, lang, !!scopeLabel)}</span>
          <span className="sm:hidden">{isSim ? (lang === 'vi' ? 'Thi' : 'Test') : lang === 'vi' ? 'Luyện' : 'Practice'}</span>
        </span>

        <div className="min-w-0 flex-1 flex flex-col justify-center">
          <span className="text-sm font-semibold text-foreground truncate" title={title}>
            {scopeLabel || title}
          </span>
          <span className="text-[11px] text-muted-foreground truncate hidden sm:block">
            {scopeLabel ? title : sectionLabel || ''}
          </span>
        </div>

        <SaveStatusIndicator status={saveStatus} lang={lang} onRetry={onRetrySave} />

        {isUntimed ? (
          <span
            id="exam-header-untimed"
            className="shrink-0 hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-muted/60 text-xs font-medium text-muted-foreground"
          >
            <InfinityIcon className="w-4 h-4" aria-hidden />
            {lang === 'vi' ? 'Không giới hạn thời gian' : 'No time limit'}
          </span>
        ) : (
          <span
            id="exam-header-timer"
            role="timer"
            aria-label={lang === 'vi' ? 'Thời gian còn lại' : 'Time remaining'}
            data-timer-tone={tone}
            className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border font-mono text-sm font-bold tabular-nums ${
              tone === 'critical'
                ? 'bg-rose-500/10 border-rose-500/40 text-rose-700 dark:text-rose-300'
                : tone === 'warning'
                ? 'bg-amber-500/10 border-amber-500/40 text-amber-800 dark:text-amber-200'
                : 'bg-muted/50 border-border text-foreground'
            }`}
          >
            <Clock className="w-4 h-4" aria-hidden />
            {formatClock(remainingSeconds)}
          </span>
        )}

        {action.kind === 'advance' ? (
          <button
            type="button"
            id="exam-header-advance-btn"
            onClick={action.onClick}
            disabled={action.busy || action.disabled}
            className="shrink-0 h-9 px-3 sm:px-4 inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {action.busy ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            <span>{lang === 'vi' ? 'Phần tiếp theo' : 'Next section'}</span>
            {!action.busy && <ArrowRight className="w-4 h-4" aria-hidden />}
          </button>
        ) : (
          <button
            type="button"
            id="exam-header-submit-btn"
            onClick={action.onClick}
            disabled={action.busy || action.disabled}
            className={`shrink-0 h-9 px-3 sm:px-4 inline-flex items-center gap-1.5 rounded-lg text-white text-xs font-bold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isSim ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-emerald-600 hover:bg-emerald-500'
            }`}
          >
            {action.busy ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Send className="w-4 h-4" aria-hidden />}
            <span>{lang === 'vi' ? 'Nộp bài' : 'Submit'}</span>
          </button>
        )}
      </div>
      {isUntimed && (
        <div className="sm:hidden px-3 pb-1.5 -mt-1 text-[11px] text-muted-foreground flex items-center gap-1">
          <InfinityIcon className="w-3.5 h-3.5" aria-hidden />
          {lang === 'vi' ? 'Không giới hạn thời gian' : 'No time limit'}
        </div>
      )}
      {sectionStrip}
    </header>
  );
}

export default ExamRunnerHeader;
