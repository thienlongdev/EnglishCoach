"use client";

import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import styles from "./memoryTides.module.css";

/**
 * A native modal dialog (browser top layer: above the workspace chrome and the full-window My Books reader, with the
 * browser's own focus containment). Escape and a press that starts and ends on the backdrop close it — never while
 * `busy` (a save in progress). Nothing is rendered while closed.
 */
export function TidesDialog({ open, onClose, title, subtitle, busy = false, wide = false, children, footer }: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  busy?: boolean;
  wide?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const d = ref.current;
    if (!d || !open) return;
    if (!d.open) {
      try { d.showModal(); } catch { d.setAttribute("open", ""); }
    }
    return () => { if (d.open) d.close(); };
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      data-wide={wide ? "true" : "false"}
      aria-labelledby="tides-dialog-title"
      onCancel={(e) => { e.preventDefault(); if (!busyRef.current) onClose(); }}
      onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnBackdrop.current && !busyRef.current) onClose(); }}
    >
      <div className={styles.dialogBody}>
        <header className={styles.dialogHead}>
          <div className="min-w-0">
            <h2 id="tides-dialog-title" className={styles.dialogTitle}>{title}</h2>
            {subtitle && <p className={styles.dialogSub}>{subtitle}</p>}
          </div>
          <button type="button" className={styles.dialogClose} onClick={onClose} disabled={busy} aria-label="Đóng">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>
        <div className={styles.dialogContent}>{children}</div>
        {footer && <footer className={styles.dialogFoot}>{footer}</footer>}
      </div>
    </dialog>
  );
}
