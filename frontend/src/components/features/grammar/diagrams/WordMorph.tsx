'use client';

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { plainRoles, wordKey } from '@/lib/grammar/inline';
import { cx } from '@/lib/grammar/format';
import styles from '../grammar.module.css';
import { measureFlip, playFlip, type Box } from './flip';
import { usePrefersReducedMotion } from './shared';

interface Token { key: string; text: string; norm: string }

/** Words of a sentence with an identity: the word without punctuation, lower case, plus which occurrence of it this is. */
export function tokensOf(sentence: string): Token[] {
  const seen = new Map<string, number>();
  return plainRoles(sentence)
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => {
      const norm = wordKey(text) || text;
      const n = seen.get(norm) ?? 0;
      seen.set(norm, n + 1);
      return { key: `${norm}#${n}`, text, norm };
    });
}

/**
 * A sentence as word chips. When `sentence` changes, every word that is still there glides from its old place to its new one
 * (matched by identity, occurrence by occurrence), new words fade in and words that are gone fade out where they stood. Under
 * reduced motion the sentence simply changes. The full sentence is also in a visually hidden line (a polite live region when
 * `live` is set), because the chips are only the picture.
 */
export function WordMorph({ sentence, changed, className, live = false }: { sentence: string; changed?: string[]; className?: string; live?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const before = useRef<Map<string, Box> | null>(null);
  const [ghosts, setGhosts] = useState<Box[]>([]);
  const tokens = useMemo(() => tokensOf(sentence), [sentence]);
  const lit = useMemo(() => new Set((changed ?? []).flatMap((c) => c.split(/\s+/)).map((w) => wordKey(w)).filter(Boolean)), [changed]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const after = measureFlip(el);
    const was = before.current;
    before.current = after;
    if (!was || reduced) { setGhosts((g) => (g.length ? [] : g)); return; }
    const { left } = playFlip(el, was, after);
    if (!left.length) return;
    setGhosts(left);
    const timer = window.setTimeout(() => setGhosts([]), 420);
    return () => window.clearTimeout(timer);
  }, [sentence, reduced]);

  // keep the remembered places true when the box is resized (a wrap changes every place)
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { before.current = measureFlip(el); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={cx(styles.wm, className)} data-spatial-owner="">
      <span className={styles.srOnly} aria-live={live ? 'polite' : undefined}>{tokens.map((t) => t.text).join(' ')}</span>
      <div ref={boxRef} className={styles.wmBox} aria-hidden="true" lang="en">
        {tokens.map((t) => (
          <span key={t.key} data-flip={t.key} className={styles.wmWord} data-changed={lit.has(t.norm) ? 'true' : 'false'}>{t.text}</span>
        ))}
        {ghosts.map((g, i) => (
          <span key={`g${i}${g.text}`} className={styles.wmGhost} style={{ left: g.x, top: g.y, width: g.w, height: g.h }}>{g.text}</span>
        ))}
      </div>
    </div>
  );
}
