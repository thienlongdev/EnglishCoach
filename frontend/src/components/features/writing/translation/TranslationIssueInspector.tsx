'use client';

import React, { useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, CheckCircle2, Lightbulb } from 'lucide-react';
import { TranslationIssue } from '@/types/writing';

interface TranslationIssueInspectorProps {
  issues: TranslationIssue[];
  onSelectIssue?: (issue: TranslationIssue) => void;
  selectedIssueIndex?: number;
}

export const TranslationIssueInspector: React.FC<TranslationIssueInspectorProps> = ({
  issues,
  onSelectIssue,
  selectedIssueIndex: controlledIndex
}) => {
  const [internalIndex, setInternalIndex] = useState(0);
  const currentIndex = controlledIndex !== undefined ? controlledIndex : internalIndex;

  if (!issues || issues.length === 0) {
    return (
      <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-800 dark:text-emerald-300 text-xs">
        <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span>Không phát hiện lỗi ngữ pháp hay từ vựng trọng yếu nào. Bản dịch rất chuẩn xác!</span>
      </div>
    );
  }

  const currentIssue = issues[currentIndex] || issues[0];
  const hasMultiple = issues.length > 1;

  const handlePrev = () => {
    const nextIdx = (currentIndex - 1 + issues.length) % issues.length;
    setInternalIndex(nextIdx);
    onSelectIssue?.(issues[nextIdx]);
  };

  const handleNext = () => {
    const nextIdx = (currentIndex + 1) % issues.length;
    setInternalIndex(nextIdx);
    onSelectIssue?.(issues[nextIdx]);
  };

  const getCategoryColor = (cat: string) => {
    switch (cat.toUpperCase()) {
      case 'GRAMMAR':
        return 'text-rose-600 bg-rose-50 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900';
      case 'MEANING':
        return 'text-amber-700 bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900';
      case 'VOCABULARY':
        return 'text-blue-700 bg-blue-50 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900';
      default:
        return 'text-purple-700 bg-purple-50 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-900';
    }
  };

  return (
    <div className="w-full flex flex-col gap-2.5 p-3.5 bg-surface-container-low border border-surface-container-high rounded-2xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-amber-600" />
          <span className="font-label-md text-label-md font-bold text-on-surface">
            Điểm cần lưu ý ({currentIndex + 1}/{issues.length})
          </span>
        </div>

        {hasMultiple && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handlePrev}
              className="p-1 rounded-lg hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-all cursor-pointer"
              title="Điểm lưu ý trước"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-on-surface-variant px-1">
              {currentIndex + 1}/{issues.length}
            </span>
            <button
              type="button"
              onClick={handleNext}
              className="p-1 rounded-lg hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-all cursor-pointer"
              title="Điểm lưu ý tiếp theo"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      <div className="p-3 bg-surface-container rounded-xl border border-surface-container-high/60 space-y-2">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wider border ${getCategoryColor(currentIssue.category)}`}>
            {currentIssue.category}
          </span>
          {currentIssue.flaggedText && (
            <span className="font-mono text-xs text-rose-600 dark:text-rose-400 font-semibold px-2 py-0.5 rounded bg-rose-500/10">
              "{currentIssue.flaggedText}"
            </span>
          )}
        </div>

        <p className="font-body-sm text-body-sm text-on-surface leading-relaxed">
          {currentIssue.message}
        </p>

        {currentIssue.suggestion && (
          <div className="flex items-start gap-1.5 pt-1 text-xs text-secondary font-medium">
            <Lightbulb className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Gợi ý sửa: <strong className="text-on-surface">{currentIssue.suggestion}</strong></span>
          </div>
        )}
      </div>
    </div>
  );
};
