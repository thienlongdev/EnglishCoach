'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, RotateCw } from 'lucide-react';
import { saveStatusView, type SaveStatus, type UxLang } from '@/lib/exams/runnerModel';

interface SaveStatusIndicatorProps {
  status: SaveStatus | string;
  lang: UxLang;
  onRetry?: () => void;
  /** Hide the text on very narrow headers (icon + accessible label stay). */
  compact?: boolean;
}

/**
 * Exams Phase 7 — quiet, truthful autosave state. The label follows the autosave hook: "Đã lưu" only after the server
 * acknowledged the batch; a failure offers "Thử lại" and explains that answers are still kept on the device. No toast,
 * no flashing — the icon swaps without animation except the busy spinner.
 */
export function SaveStatusIndicator({ status, lang, onRetry, compact = false }: SaveStatusIndicatorProps) {
  const view = saveStatusView(status, lang);
  const tone =
    view.tone === 'ok'
      ? 'text-emerald-600 dark:text-emerald-400'
      : view.tone === 'error'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-muted-foreground';

  const icon =
    view.tone === 'ok' ? (
      <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
    ) : view.tone === 'busy' ? (
      <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
    ) : view.tone === 'error' ? (
      <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
    ) : (
      <CircleDashed className="w-3.5 h-3.5" aria-hidden />
    );

  return (
    <div className="flex items-center gap-1.5 min-w-0" data-save-status={status}>
      <span
        role="status"
        aria-live="polite"
        title={view.hint || undefined}
        className={`inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap ${tone}`}
      >
        {icon}
        <span className={compact ? 'sr-only' : 'hidden sm:inline'}>{view.label}</span>
      </span>
      {view.retryable && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-rose-700 dark:text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCw className="w-3 h-3" aria-hidden />
          {lang === 'vi' ? 'Thử lại' : 'Retry'}
        </button>
      )}
    </div>
  );
}

export default SaveStatusIndicator;
