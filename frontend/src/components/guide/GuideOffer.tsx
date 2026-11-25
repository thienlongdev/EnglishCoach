'use client';

import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import styles from './guide.module.css';

const OFFER_LASTS_MS = 30_000;

/**
 * Echo's question: a small card beside the companion, never a tour by itself. Nothing dims, nothing takes the focus, the page stays usable; ignoring it is an answer too.
 * It says who is asking by sitting next to the whale, so it needs no whale of its own.
 */
export function GuideOffer({ title, text, primary, later, onPrimary, onLater, vi }: {
  title: string;
  text: string;
  primary: string;
  later: string;
  onPrimary: () => void;
  onLater: () => void;
  vi: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const shownAt = useRef(performance.now());
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  // Not answering is an answer too: it does not stay on the screen waiting. Never while the learner is reading it (pointer on it, focus in it).
  const later_ = useRef(onLater);
  later_.current = onLater;
  useEffect(() => {
    const timer = window.setInterval(() => {
      const card = ref.current;
      if (!card || card.matches(':hover') || card.contains(document.activeElement)) return;
      if (performance.now() - shownAt.current > OFFER_LASTS_MS) later_.current();
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const place = () => {
      const card = ref.current?.getBoundingClientRect();
      if (!card) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const whale = document.querySelector<HTMLElement>('.echo-launcher')?.getBoundingClientRect();
      if (!whale || whale.width === 0) {
        setStyle({ right: 16, bottom: 16 });
        return;
      }
      const left = Math.max(12, Math.min(vw - card.width - 12, whale.left + whale.width / 2 > vw / 2 ? whale.right - card.width : whale.left));
      const above = whale.top - card.height - 12;
      const top = above >= 12 ? above : Math.min(vh - card.height - 12, whale.bottom + 12);
      setStyle({ left, top });
    };
    place();
    window.addEventListener('resize', place, { passive: true });
    return () => window.removeEventListener('resize', place);
  }, [text]);

  return (
    <aside ref={ref} className={`${styles.tokens} ${styles.offer}`} style={style} aria-label={title} data-guide-layer="" data-testid="guide-offer">
      <button type="button" className={styles.iconButton} onClick={onLater} aria-label={vi ? 'Đóng' : 'Close'}>
        <X size={15} aria-hidden="true" />
      </button>
      <p className={styles.title}>{title}</p>
      <p className={styles.body}>{text}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={onLater}>{later}</button>
        <button type="button" className={styles.primary} onClick={onPrimary} data-testid="guide-offer-start">{primary}</button>
      </div>
    </aside>
  );
}
