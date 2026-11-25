'use client';

import React from 'react';
import {
  ParagraphFeedback,
  ParagraphIssue
} from '@/types/paragraphTranslation';
import {
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  ArrowRight,
  RotateCcw,
  BookOpen,
  Info
} from 'lucide-react';
import { echoSrc } from '@/lib/brand/echoCharacters';

interface ParagraphFeedbackPanelProps {
  feedback: ParagraphFeedback;
  onRevise: () => void;
  onContinue: () => void;
  isLastItem?: boolean;
}

export const ParagraphFeedbackPanel: React.FC<ParagraphFeedbackPanelProps> = ({
  feedback,
  onRevise,
  onContinue,
  isLastItem = false
}) => {
  const isAccepted = feedback.accepted === true;
  const isUncertain = feedback.evaluationStatus === 'UNCERTAIN';

  const dimensionBadges = [
    { label: 'Ngữ nghĩa', verdict: feedback.meaningVerdict, score: feedback.meaningScore },
    { label: 'Ngữ pháp', verdict: feedback.grammarVerdict, score: feedback.grammarScore },
    { label: 'Tự nhiên', verdict: feedback.naturalnessVerdict, score: feedback.naturalnessScore },
    { label: 'Từ vựng', verdict: feedback.vocabularyVerdict, score: feedback.vocabularyScore },
    { label: 'Mạch lạc', verdict: feedback.cohesionVerdict, score: feedback.cohesionScore }
  ];

  const getVerdictStyle = (v?: string) => {
    if (!v) return 'bg-surface-container-high text-outline border-transparent';
    const val = v.toUpperCase();
    if (['PASS', 'ACCURATE', 'NATURAL', 'COHESIVE'].includes(val)) {
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20';
    }
    if (['ACCEPTABLE', 'MINOR_ISSUES', 'PARTIAL'].includes(val)) {
      return 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20';
    }
    if (['NEEDS_ATTENTION', 'INACCURATE', 'INCORRECT', 'UNNATURAL', 'DISJOINTED', 'AWKWARD'].includes(val)) {
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20';
    }
    return 'bg-surface-container-high text-outline border-transparent';
  };

  const getVerdictText = (v?: string) => {
    if (!v) return 'Chưa rõ';
    const val = v.toUpperCase();
    if (['PASS', 'ACCURATE', 'NATURAL', 'COHESIVE'].includes(val)) return 'Đạt';
    if (['ACCEPTABLE'].includes(val)) return 'Chấp nhận';
    if (['MINOR_ISSUES', 'PARTIAL'].includes(val)) return 'Lỗi nhỏ';
    if (['INACCURATE'].includes(val)) return 'Sai nghĩa';
    if (['INCORRECT'].includes(val)) return 'Chưa đúng';
    if (['UNNATURAL', 'AWKWARD'].includes(val)) return 'Chưa tự nhiên';
    if (['DISJOINTED'].includes(val)) return 'Thiếu mạch lạc';
    if (['NEEDS_ATTENTION'].includes(val)) return 'Cần sửa';
    if (['UNCERTAIN', 'UNAVAILABLE'].includes(val)) return 'Chưa rõ';
    return v;
  };

  return (
    <div className="w-full space-y-5 animate-in fade-in duration-200">
      {/* Overall Header Card */}
      <div
        className={`p-5 rounded-2xl border transition-all ${
          isAccepted
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-950 dark:text-emerald-50'
            : isUncertain
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-950 dark:text-amber-50'
            : 'bg-amber-500/10 border-amber-500/30 text-amber-950 dark:text-amber-50'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            {isAccepted ? (
              <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-400 shrink-0" />
            ) : isUncertain ? (
              <HelpCircle className="w-6 h-6 text-amber-600 dark:text-amber-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-400 shrink-0" />
            )}
            <div>
              <h3 className="font-bold text-base">
                {isAccepted
                  ? 'Bản dịch được chấp nhận!'
                  : isUncertain
                  ? 'Phản hồi kỹ thuật tạm thời'
                  : 'Cần hoàn thiện thêm một số điểm'}
              </h3>
              <p className="text-xs mt-1 leading-relaxed opacity-90">
                {feedback.overallSummary}
              </p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onRevise}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-surface-container-high bg-surface-container-lowest text-xs font-semibold hover:bg-surface-container cursor-pointer transition-colors shadow-2xs"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Chỉnh sửa</span>
            </button>
            {isAccepted && (
              <button
                type="button"
                onClick={onContinue}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-primary text-white text-xs font-bold hover:opacity-95 cursor-pointer transition-all shadow-xs"
              >
                <span>{isLastItem ? 'Hoàn thành' : 'Đoạn kế tiếp'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* 5 Dimensions Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-5 gap-2 mt-4 pt-3 border-t border-black/5 dark:border-white/5">
          {dimensionBadges.map((dim, idx) => (
            <div
              key={idx}
              className={`p-2 rounded-xl border text-center ${getVerdictStyle(dim.verdict)}`}
            >
              <div className="text-[10px] uppercase font-bold tracking-wider opacity-75">
                {dim.label}
              </div>
              <div className="text-xs font-bold mt-0.5">
                {getVerdictText(dim.verdict)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Issues Breakdown */}
      {feedback.issues && feedback.issues.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">
              Các điểm cần lưu ý ({feedback.issues.length})
            </span>
          </div>

          <div className="space-y-2">
            {feedback.issues.map((issue: ParagraphIssue, idx: number) => {
              const isError = issue.issueType === 'ERROR';
              const isStyle = issue.issueType === 'STYLE';

              return (
                <div
                  key={idx}
                  className={`p-3.5 rounded-xl border text-xs leading-relaxed space-y-1.5 ${
                    isError
                      ? 'border-error/30 bg-error/5'
                      : isStyle
                      ? 'border-surface-container-high bg-surface-container-lowest'
                      : 'border-amber-500/20 bg-amber-500/5'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                          isError
                            ? 'bg-error text-white'
                            : isStyle
                            ? 'bg-secondary/15 text-secondary'
                            : 'bg-amber-500/20 text-amber-800 dark:text-amber-300'
                        }`}
                      >
                        {issue.dimension} • {isError ? 'Lỗi sai' : isStyle ? 'Văn phong' : 'Gợi ý cải thiện'}
                      </span>
                    </div>

                    {issue.learnerSpan && (
                      <span className="text-[11px] font-mono text-outline italic truncate max-w-[200px]">
                        &quot;{issue.learnerSpan}&quot;
                      </span>
                    )}
                  </div>

                  <p className="text-on-surface">{issue.message}</p>

                  {issue.suggestion && (
                    <div className="p-2 rounded-lg bg-surface-container-low text-primary font-medium border border-primary/10">
                      <span className="text-[11px] font-bold text-outline mr-1">Gợi ý sửa:</span>
                      {issue.suggestion}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Suggested Natural Version & Reference Translation */}
      <div className="space-y-3 pt-2">
        {feedback.naturalAlternative && (
          <div className="p-4 rounded-2xl bg-surface-container-low border border-surface-container-high space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-bold text-secondary uppercase tracking-wider">
              <img
                src={echoSrc('scholar', 24)}
                alt="EnglishCoach AI"
                width={14}
                height={14}
                className="w-3.5 h-3.5 object-contain shrink-0 select-none pointer-events-none"
              />
              <span>Phương án diễn đạt tự nhiên hơn</span>
            </div>
            <p className="text-xs text-on-surface leading-relaxed font-serif">
              {feedback.naturalAlternative}
            </p>
          </div>
        )}

        {feedback.referenceEn && (
          <div className="p-4 rounded-2xl bg-surface-container-lowest border border-surface-container-high space-y-1.5 shadow-2xs">
            <div className="flex items-center gap-1.5 text-xs font-bold text-outline uppercase tracking-wider">
              <BookOpen className="w-3.5 h-3.5" />
              <span>Bản dịch mẫu chuẩn</span>
            </div>
            <p className="text-xs text-on-surface leading-relaxed font-serif">
              {feedback.referenceEn}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
