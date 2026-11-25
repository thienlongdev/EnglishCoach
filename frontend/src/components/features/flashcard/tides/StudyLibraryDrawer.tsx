"use client";

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Library } from "lucide-react";
import { MORPH_EASE, MORPH_ID, MORPH_MS, morphReduced } from "@/lib/morph/tokens";
import styles from "./memoryPulse.module.css";

/**
 * The vocabulary library during a study session (owner brief 2026-11-12): ONE horizontal bar, collapsed whenever a study
 * session starts (`open` lives in FlashcardUI and is reset on deck entry only — never by a rating or a card change). Expanded,
 * it shows the existing management UI (search, filters, table, audio, actions). The panel is mounted only while open or
 * closing, so a collapsed library has no controls in the page at all. Motion: Echo Morph tokens through Web Animations
 * (no fill, nothing left behind); reduced motion = instant. Escape inside the panel closes it and returns focus to the bar.
 */
export function StudyLibraryDrawer({ open, onOpenChange, count, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** words in the scope being studied, or null while unknown */
  count: number | null;
  children: React.ReactNode;
}) {
  const id = useId();
  const panelId = `${id}-panel`;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(open);
  const animation = useRef<Animation | null>(null);

  // open: mount first, then grow from 0 to the panel's own height
  useEffect(() => { if (open) setPresent(true); }, [open]);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || !present) return;
    animation.current?.cancel();
    if (open) el.style.height = ""; // reopened during a close: forget the held closed height
    if (morphReduced() || typeof el.animate !== "function") {
      if (!open) setPresent(false);
      return;
    }
    const h = el.scrollHeight;
    const frames: Keyframe[] = open
      ? [{ height: "0px", opacity: 0 }, { height: `${h}px`, opacity: 1 }]
      : [{ height: `${h}px`, opacity: 1 }, { height: "0px", opacity: 0 }];
    const a = el.animate(frames, { duration: open ? MORPH_MS.surface : MORPH_MS.base, easing: open ? MORPH_EASE.current : MORPH_EASE.exit, fill: "none", id: MORPH_ID });
    animation.current = a;
    if (!open) {
      el.style.height = "0px"; // stays closed between the end of the animation and the unmount
      a.onfinish = () => setPresent(false);
    }
    return () => { a.onfinish = null; };
  }, [open, present]);

  useEffect(() => () => animation.current?.cancel(), []);

  const close = () => {
    if (panelRef.current?.contains(document.activeElement)) toggleRef.current?.focus({ preventScroll: true });
    onOpenChange(false);
  };

  return (
    <section className={styles.libraryBar} aria-label="Thư viện từ vựng" data-guide="fc-library-bar">
      <button
        ref={toggleRef}
        type="button"
        className={styles.libraryToggle}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : onOpenChange(true))}
      >
        <span className={styles.libraryIcon} aria-hidden="true"><Library className="h-5 w-5" /></span>
        <span className="flex min-w-0 flex-col">
          <span className={styles.libraryTitle}>Thư viện từ vựng</span>
          <span className={styles.libraryCount}>{count === null ? "Đang tải…" : `${count.toLocaleString("vi-VN")} từ`}</span>
        </span>
        <span className={styles.libraryAction}>
          <span className={styles.libraryActionText}>{open ? "Thu gọn" : "Mở thư viện"}</span>
          <ChevronDown className={styles.chevron} aria-hidden="true" />
        </span>
      </button>
      {present && (
        <div
          ref={panelRef}
          id={panelId}
          role="region"
          aria-label="Quản lý thư viện từ vựng"
          className={styles.libraryPanel}
          inert={!open}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || e.defaultPrevented) return;
            const t = e.target as HTMLElement;
            if (t.getAttribute("aria-expanded") === "true" && t.getAttribute("role") === "combobox") return; // the search's own list closes first
            e.stopPropagation();
            close();
          }}
        >
          <div className={styles.libraryPanelHead}>
            <div className={styles.libraryPanelTitleWrap}>
              <span className={styles.libraryPanelOrb} aria-hidden="true">
                <Library className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h3 className={styles.libraryPanelTitle}>Thư viện từ vựng</h3>
                <p className={styles.libraryPanelSub}>
                  {count === null ? "Đang tải…" : `${count.toLocaleString("vi-VN")} từ trong phạm vi hiện tại · chọn thẻ bất kỳ để ôn ngay`}
                </p>
              </div>
            </div>
            <button
              type="button"
              className={styles.libraryPanelClose}
              onClick={close}
              aria-label="Đóng thư viện từ vựng"
              title="Đóng (Esc)"
            >
              ×
            </button>
          </div>
          <div className={styles.libraryInner}>{children}</div>
        </div>
      )}
    </section>
  );
}
