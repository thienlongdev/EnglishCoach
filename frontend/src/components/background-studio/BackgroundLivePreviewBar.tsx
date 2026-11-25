'use client';

import React, { useEffect } from 'react';
import { ArrowLeft, Bookmark, Check, X } from 'lucide-react';
import styles from './BackgroundStudio.module.css';

export interface BackgroundLivePreviewBarProps {
  /** Active draft theme or preset display name. */
  themeName: string;
  /** Whether the draft differs from the last applied or saved state. */
  hasUnsavedChanges?: boolean;
  /** Accent hex color used for the floating dock rim lighting. */
  accentHex?: string;
  /** Disables commit actions while persistence is in flight. */
  saving?: boolean;
  /** Vietnamese UI copy when true; English copy when false. */
  vi?: boolean;
  /** Minimizes live preview mode and re-opens the full Background Studio dialog. */
  onReturnToStudio: () => void;
  /** Applies the previewed background directly to the workspace. */
  onApply: () => void;
  /** Saves the current composition to My Themes (optional). */
  onSave?: () => void;
  /** Cancels preview and cleanly restores the exact prior background configuration. */
  onCancel: () => void;
  /** Optional Escape key handler; defaults to returning to Studio without losing edits. */
  onEscape?: () => void;
}

/**
 * Compact floating bottom dock shown ONLY when the user activates
 * "Xem trên giao diện thực tế" (Live Workspace Preview) so they can inspect and interact
 * with the real English Coach workspace underneath with their custom background live.
 */
export default function BackgroundLivePreviewBar({
  themeName,
  hasUnsavedChanges = false,
  accentHex,
  saving = false,
  vi = true,
  onReturnToStudio,
  onApply,
  onSave,
  onCancel,
  onEscape,
}: BackgroundLivePreviewBarProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || saving) return;
      event.preventDefault();
      if (onEscape) {
        onEscape();
      } else {
        onReturnToStudio();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onEscape, onReturnToStudio, saving]);

  const dockStyle = accentHex
    ? ({ '--accent': accentHex } as React.CSSProperties)
    : undefined;

  return (
    <div
      role="region"
      aria-label={vi ? 'Thanh xem trước nền trên giao diện thực tế' : 'Live workspace background preview controls'}
      className={styles.liveDock}
      style={dockStyle}
      data-testid="background-live-preview-bar"
    >
      <div className={styles.liveDockInfo}>
        <span className={styles.liveDockPulse} aria-hidden="true" />
        <div className={styles.liveDockText}>
          <span className={styles.liveDockEyebrow}>
            {vi ? 'Đang xem trực tiếp' : 'Live preview'}
          </span>
          <div className={styles.liveDockTitleRow}>
            <span className={styles.liveDockTitle} title={themeName}>
              {themeName}
            </span>
            {hasUnsavedChanges && (
              <span className={styles.liveDockBadge} data-testid="live-bar-unsaved">
                {vi ? 'Chưa lưu' : 'Unsaved'}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className={styles.liveDockActions}>
        <button
          type="button"
          className={`${styles.btnSecondary} ${styles.liveDockBtn}`}
          onClick={onReturnToStudio}
          disabled={saving}
          data-testid="live-bar-return"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          <span>{vi ? 'Quay lại Studio' : 'Back to Studio'}</span>
        </button>

        {onSave && (
          <button
            type="button"
            className={`${styles.btnAccent} ${styles.liveDockBtn}`}
            onClick={onSave}
            disabled={saving}
            data-testid="live-bar-save"
          >
            <Bookmark size={14} aria-hidden="true" />
            <span>{vi ? 'Lưu' : 'Save'}</span>
          </button>
        )}

        <button
          type="button"
          className={`${styles.btnPrimary} ${styles.liveDockBtn}`}
          onClick={onApply}
          disabled={saving}
          data-testid="live-bar-apply"
        >
          <Check size={14} aria-hidden="true" />
          <span>{vi ? 'Áp dụng' : 'Apply'}</span>
        </button>

        <button
          type="button"
          className={`${styles.btnGhost} ${styles.liveDockBtn}`}
          onClick={onCancel}
          disabled={saving}
          aria-label={vi ? 'Hủy và khôi phục nền trước đó' : 'Cancel and restore previous background'}
          data-testid="live-bar-cancel"
        >
          <X size={14} aria-hidden="true" />
          <span>{vi ? 'Hủy' : 'Cancel'}</span>
        </button>
      </div>
    </div>
  );
}
