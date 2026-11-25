'use client';

import React, { useEffect, useRef } from 'react';
import { RefreshCw, X } from 'lucide-react';

/** Skeleton rows with the same height as real rows (no layout shift). */
export function BoardSkeleton({ rows = 8, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-14 rounded-2xl bg-slate-100 dark:bg-white/[0.04] border border-slate-200/70 dark:border-slate-800/70 animate-pulse motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

export function BoardError({ message, retryLabel, onRetry }: { message: string; retryLabel: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-rose-300/40 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/20 px-4 py-10 text-center">
      <p className="text-sm font-medium text-rose-700 dark:text-rose-300">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        {retryLabel}
      </button>
    </div>
  );
}

/**
 * Empty board: deep-navy gradient card with a glowing icon medallion, optional title, message and CTA.
 * Never renders placeholder learners (no fake rows).
 */
export function BoardEmpty({
  message,
  action,
  title,
  icon,
}: {
  message: string;
  action?: React.ReactNode;
  title?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div
      data-testid="board-empty"
      className="relative isolate flex flex-col items-center justify-center gap-4 overflow-hidden rounded-3xl border border-white/10 bg-[#0a1033] px-5 py-12 text-center shadow-[0_20px_50px_-24px_rgba(79,70,229,0.7)]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            'radial-gradient(55% 60% at 50% 0%, rgba(99,102,241,0.35), transparent 70%),' +
            'radial-gradient(40% 50% at 85% 100%, rgba(251,191,36,0.18), transparent 70%),' +
            'radial-gradient(40% 50% at 10% 90%, rgba(56,189,248,0.18), transparent 70%)',
        }}
      />
      {icon && (
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/15 bg-gradient-to-br from-blue-500/30 to-violet-600/30 text-amber-200 shadow-[0_0_30px_rgba(129,140,248,0.55)]">
          {icon}
        </span>
      )}
      {title && <h3 className="text-lg font-extrabold text-white sm:text-xl">{title}</h3>}
      <p className="max-w-md text-sm text-slate-300">{message}</p>
      {action}
    </div>
  );
}

/** Minimal accessible modal: Esc / backdrop / close button, focus moved inside, body scroll kept. */
export function LeaderboardModal({
  open,
  title,
  closeLabel,
  onClose,
  children,
  wide = false,
  dismissOnBackdrop = true,
}: {
  open: boolean;
  title: string;
  closeLabel: string;
  /** X button and ESC; a caller with unsaved work passes a guarded handler (confirmation instead of closing). */
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  /** false while work is in progress (placement quiz): a click outside the panel never closes it. */
  dismissOnBackdrop?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      onClick={dismissOnBackdrop ? onClose : undefined}
      data-testid="leaderboard-modal-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`relative max-h-[90vh] w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] p-5 sm:p-6 shadow-2xl focus:outline-none`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
