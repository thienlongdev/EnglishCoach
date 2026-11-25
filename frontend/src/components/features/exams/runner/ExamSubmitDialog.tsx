'use client';

import React from 'react';
import { AlertTriangle, Flag, Loader2, Send } from 'lucide-react';
import { ExamDialog } from './ExamDialog';
import { compactNumberList, type AnswerSummary, type RunnerMode, type UxLang } from '@/lib/exams/runnerModel';

interface ExamSubmitDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  mode: RunnerMode;
  lang: UxLang;
  summary: AnswerSummary | null;
  submitting: boolean;
  error?: string | null;
  /** Extra block (IELTS Speaking turn progress); `blocked` disables submission until it is complete. */
  extra?: React.ReactNode;
  blocked?: boolean;
  /** Simulation with more sections after this one submits the whole attempt — say so. */
  wholeAttemptNote?: string | null;
}

/**
 * Exams Phase 7 — concise submit confirmation: answered / unanswered (with the printed numbers) / marked counts.
 * Simulation warns clearly; practice is softer. While the request runs the confirm control is disabled and the dialog
 * cannot be dismissed (the backend stays authoritative and idempotent).
 */
export function ExamSubmitDialog({
  open,
  onClose,
  onConfirm,
  mode,
  lang,
  summary,
  submitting,
  error,
  extra,
  blocked = false,
  wholeAttemptNote,
}: ExamSubmitDialogProps) {
  const isSim = mode === 'SIMULATION';
  const unanswered = summary?.unanswered ?? 0;

  const title = isSim
    ? lang === 'vi' ? 'Nộp bài thi?' : 'Submit your test?'
    : lang === 'vi' ? 'Nộp bài luyện tập?' : 'Submit this practice?';
  const description = isSim
    ? lang === 'vi'
      ? 'Sau khi nộp, bạn không thể sửa câu trả lời. Kết quả sẽ được tính từ bài làm đã lưu trên máy chủ.'
      : 'After submitting you cannot change your answers. Scoring uses the answers saved on the server.'
    : lang === 'vi'
    ? 'Bạn sẽ xem được kết quả và đáp án ngay sau khi nộp.'
    : 'You will see your result and the answers right after submitting.';

  return (
    <ExamDialog
      open={open}
      onClose={onClose}
      busy={submitting}
      title={title}
      description={description}
      closeLabel={lang === 'vi' ? 'Đóng' : 'Close'}
      icon={
        <span className={`inline-flex w-9 h-9 rounded-xl items-center justify-center ${isSim ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300' : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'}`}>
          <Send className="w-4 h-4" aria-hidden />
        </span>
      }
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-10 px-4 rounded-xl border border-border text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {lang === 'vi' ? 'Làm tiếp' : 'Keep working'}
          </button>
          <button
            type="button"
            id="modal-confirm-submit-btn"
            onClick={onConfirm}
            disabled={submitting || blocked}
            aria-busy={submitting}
            className={`h-10 px-5 rounded-xl text-sm font-bold text-white inline-flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isSim ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-emerald-600 hover:bg-emerald-500'
            }`}
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden />
                {lang === 'vi' ? 'Đang nộp…' : 'Submitting…'}
              </>
            ) : (
              <>
                <Send className="w-4 h-4" aria-hidden />
                {lang === 'vi' ? 'Nộp bài' : 'Submit'}
              </>
            )}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {summary && (
          <dl className="grid grid-cols-3 gap-2 text-center" data-submit-summary>
            <div className="rounded-xl bg-muted/50 p-3">
              <dt className="text-[11px] text-muted-foreground">{lang === 'vi' ? 'Đã trả lời' : 'Answered'}</dt>
              <dd className="text-lg font-extrabold text-foreground tabular-nums">
                {summary.answered}
                <span className="text-xs font-semibold text-muted-foreground">/{summary.total}</span>
              </dd>
            </div>
            <div className={`rounded-xl p-3 ${unanswered > 0 ? 'bg-amber-500/10' : 'bg-muted/50'}`}>
              <dt className="text-[11px] text-muted-foreground">{lang === 'vi' ? 'Bỏ trống' : 'Unanswered'}</dt>
              <dd className={`text-lg font-extrabold tabular-nums ${unanswered > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-foreground'}`}>
                {unanswered}
              </dd>
            </div>
            <div className="rounded-xl bg-muted/50 p-3">
              <dt className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                <Flag className="w-3 h-3" aria-hidden />
                {lang === 'vi' ? 'Đánh dấu' : 'Marked'}
              </dt>
              <dd className="text-lg font-extrabold text-foreground tabular-nums">{summary.flagged}</dd>
            </div>
          </dl>
        )}
        {summary && unanswered > 0 && (
          <p className={`text-xs leading-relaxed flex items-start gap-2 ${isSim ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground'}`}>
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
            <span>
              {lang === 'vi' ? 'Câu chưa trả lời: ' : 'Unanswered: '}
              <span className="font-semibold tabular-nums">{compactNumberList(summary.unansweredNumbers)}</span>
              {isSim
                ? lang === 'vi' ? '. Câu bỏ trống không được tính điểm.' : '. Blank answers earn no credit.'
                : lang === 'vi' ? '. Bạn vẫn có thể nộp và xem lại sau.' : '. You can still submit and review them.'}
            </span>
          </p>
        )}
        {wholeAttemptNote && <p className="text-xs text-muted-foreground leading-relaxed">{wholeAttemptNote}</p>}
        {extra}
        {error && (
          <p role="alert" className="text-xs font-medium text-rose-700 dark:text-rose-300 bg-rose-500/10 rounded-lg p-2.5">
            {error}
          </p>
        )}
      </div>
    </ExamDialog>
  );
}

export default ExamSubmitDialog;
