'use client';

import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

interface ExamDialogProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Blocks ESC / backdrop close while an irreversible request runs (e.g. submit in flight). */
  busy?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** 'sheet' docks to the bottom on phones (navigator); 'center' is a classic dialog. */
  placement?: 'center' | 'sheet';
  closeLabel?: string;
}

/**
 * Exams Phase 7 — minimal accessible dialog for the exam runner and library (role="dialog", aria-modal, labelled,
 * ESC closes, focus moves into the dialog and returns to the opener, Tab stays inside). No animation beyond a short
 * fade so the exam surface stays calm.
 */
export function ExamDialog({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  busy = false,
  size = 'md',
  placement = 'center',
  closeLabel = 'Đóng',
}: ExamDialogProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) || []
      );
    const first = focusables()[0];
    (first || panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const list = focusables();
        if (list.length === 0) return;
        const firstEl = list[0];
        const lastEl = list[list.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const opener = openerRef.current as HTMLElement | null;
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, [open, busy, onClose]);

  if (!open) return null;

  const width = size === 'sm' ? 'sm:max-w-sm' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md';
  const sheet = placement === 'sheet';

  return (
    <div
      className={`fixed inset-0 z-[60] flex bg-slate-950/60 backdrop-blur-[2px] animate-in fade-in duration-150 ${
        sheet ? 'items-end sm:items-center justify-center sm:p-4' : 'items-center justify-center p-4'
      }`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`w-full ${width} bg-card text-card-foreground border border-border shadow-2xl outline-none flex flex-col ${
          sheet ? 'rounded-t-2xl sm:rounded-2xl max-h-[85dvh]' : 'rounded-2xl max-h-[90dvh]'
        }`}
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          {icon && <div className="shrink-0 mt-0.5">{icon}</div>}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-bold text-foreground leading-snug">
              {title}
            </h2>
            {description && (
              <p id={descId} className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={closeLabel}
            className="shrink-0 p-1.5 -m-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>
        {children && <div className="px-5 pb-4 overflow-y-auto min-h-0">{children}</div>}
        {footer && (
          <div className="px-5 py-4 border-t border-border flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export default ExamDialog;
