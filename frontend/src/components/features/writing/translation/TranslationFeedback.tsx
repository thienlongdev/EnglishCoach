'use client';

import React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  ArrowRight,
  RotateCcw,
  Eye
} from 'lucide-react';
import { TranslationFeedback as ITranslationFeedback } from '@/types/writing';
import { TranslationIssueInspector } from './TranslationIssueInspector';
import { glass } from '../glass/WritingGlass';
import { echoSrc } from '@/lib/brand/echoCharacters';

interface TranslationFeedbackProps {
  feedback: ITranslationFeedback;
  referenceEn?: string | null;
  onRevise: () => void;
  onContinue: () => void;
  onRevealReference?: () => void;
  canContinue: boolean;
  isLastUnit?: boolean;
}

type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export const TranslationFeedback: React.FC<TranslationFeedbackProps> = ({
  feedback,
  referenceEn,
  onRevise,
  onContinue,
  onRevealReference,
  canContinue,
  isLastUnit = false
}) => {
  const isAccepted = feedback.overallStatus === 'ACCEPTED';
  const isNeedsRevision = feedback.overallStatus === 'NEEDS_REVISION';
  const isIncorrect = feedback.overallStatus === 'INCORRECT';

  // The server's overall verdict, worded for the learner (no score is invented here).
  const status: { tone: Tone; icon: React.ReactNode; text: string } = isAccepted
    ? { tone: 'ok', icon: <CheckCircle2 />, text: 'Chính xác' }
    : isNeedsRevision
    ? { tone: 'warn', icon: <AlertTriangle />, text: 'Đúng nghĩa nhưng cần chỉnh' }
    : isIncorrect
    ? { tone: 'bad', icon: <XCircle />, text: 'Cần sửa' }
    : { tone: 'neutral', icon: <HelpCircle />, text: 'Cần kiểm tra thêm' };

  const getVerdictLabel = (value: string): { text: string; tone: Tone } => {
    switch (value) {
      case 'ACCURATE':
        return { text: 'Chuẩn xác', tone: 'ok' };
      case 'PARTIAL':
        return { text: 'Một phần', tone: 'warn' };
      case 'INACCURATE':
        return { text: 'Sai nghĩa', tone: 'bad' };
      case 'MINOR_ISSUES':
        return { text: 'Lỗi nhỏ', tone: 'warn' };
      case 'INCORRECT':
        return { text: 'Chưa đúng', tone: 'bad' };
      case 'NATURAL':
        return { text: 'Tự nhiên', tone: 'ok' };
      case 'ACCEPTABLE':
        return { text: 'Chấp nhận được', tone: 'ok' };
      case 'AWKWARD':
        return { text: 'Hơi gượng', tone: 'warn' };
      default:
        return { text: value, tone: 'neutral' };
    }
  };
  const chipClass = (tone: Tone) =>
    `${glass.chip} ${tone === 'ok' ? glass.chipOk : tone === 'warn' ? glass.chipWarn : tone === 'bad' ? glass.chipBad : ''}`;

  const dims = [
    { label: 'Ý nghĩa', verdict: getVerdictLabel(feedback.meaningVerdict) },
    { label: 'Ngữ pháp', verdict: getVerdictLabel(feedback.grammarVerdict) },
    { label: 'Độ tự nhiên', verdict: getVerdictLabel(feedback.naturalnessVerdict) },
  ];

  return (
    <section
      className={`${glass.panel} w-full flex flex-col gap-4 p-5 sm:p-6 animate-in fade-in slide-in-from-bottom-2 duration-200`}
      aria-label="Phản hồi bản dịch"
    >
      {/* Verdict + three dimensions */}
      <div className={glass.verdict} data-v={status.tone} role="status">
        <span className={glass.verdictIcon} aria-hidden="true">{status.icon}</span>
        <div className="flex flex-col">
          <span className="text-base font-bold">{status.text}</span>
          {feedback.headlineSummary && (
            <span className="text-sm font-medium text-on-surface leading-relaxed">{feedback.headlineSummary}</span>
          )}
        </div>
      </div>

      <div className={glass.dims}>
        {dims.map((d) => (
          <div key={d.label} className={glass.dim}>
            <span className={glass.label}>{d.label}</span>
            <span className={chipClass(d.verdict.tone)} style={{ width: 'fit-content' }}>{d.verdict.text}</span>
          </div>
        ))}
      </div>

      {(feedback.naturalSuggestion || referenceEn) && (
        <div className={glass.compare}>
          {/* Natural Suggestion (Echo AI) */}
          {feedback.naturalSuggestion && (
            <div className={glass.compareRow} data-kind="natural">
              <img
                src={echoSrc('scholar', 24)}
                alt="Echo AI"
                className="w-5 h-5 shrink-0 mt-0.5 object-contain"
              />
              <div className="flex flex-col gap-0.5">
                <span className={glass.label}>Gợi ý diễn đạt tự nhiên hơn</span>
                <span className="text-[0.95rem] font-semibold text-on-surface leading-relaxed" lang="en">
                  &ldquo;{feedback.naturalSuggestion}&rdquo;
                </span>
              </div>
            </div>
          )}

          {/* Reference Answer if present */}
          {referenceEn && (
            <div className={glass.compareRow} data-kind="model">
              <Eye className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="flex flex-col gap-0.5">
                <span className={glass.label}>Đáp án mẫu tham khảo</span>
                <span className="text-[0.95rem] font-semibold text-on-surface leading-relaxed" lang="en">
                  {referenceEn}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Detailed Issues */}
      {feedback.issues && feedback.issues.length > 0 && (
        <TranslationIssueInspector issues={feedback.issues} />
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-outline-variant/40">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRevise}
            className={`${glass.btn} ${glass.btnSoft}`}
          >
            <RotateCcw className="w-4 h-4" />
            <span>Sửa lại câu này</span>
          </button>

          {!referenceEn && onRevealReference && (
            <button
              type="button"
              onClick={onRevealReference}
              className={`${glass.btn} ${glass.btnGhost} ${glass.btnSm}`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Xem đáp án mẫu</span>
            </button>
          )}
        </div>

        {canContinue && (
          <button
            type="button"
            onClick={onContinue}
            className={`${glass.btn} ${glass.btnPrimary}`}
          >
            <span>{isLastUnit ? 'Hoàn thành bài tập' : 'Câu tiếp theo'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </section>
  );
};
