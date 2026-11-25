'use client';

import React from 'react';
import { BoardAvatar } from '../BoardAvatar';
import { HALL_ART } from './hallArt';
import { HALL_TEXT, podiumSlots, TEXT, type Locale } from '@/lib/leaderboard/format';
import type { PodiumEntry } from '../Podium';
import styles from './hall.module.css';

/** Avatar sizes on the hall podium: champion larger; phones smaller (CSS keeps the plates readable). */
const AVATAR_PX: Record<1 | 2 | 3, number> = { 1: 88, 2: 68, 3: 68 };

/** The gold crown over the champion's seat (inline SVG, aria-hidden). */
function CrownMark() {
  return (
    <svg className={styles.crown} viewBox="0 0 64 44" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="hallCrownG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff4c8" />
          <stop offset="0.5" stopColor="#f8c34c" />
          <stop offset="1" stopColor="#c47f0c" />
        </linearGradient>
      </defs>
      <path d="M6 14 L18 26 L32 6 L46 26 L58 14 L54 38 H10 Z" fill="url(#hallCrownG)" stroke="#7a4a00" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="9" y="36" width="46" height="6" rx="2.5" fill="url(#hallCrownG)" stroke="#7a4a00" strokeWidth="1.2" />
      <circle cx="32" cy="6" r="3.4" fill="#fff6dc" />
      <circle cx="6" cy="14" r="3" fill="#fff6dc" />
      <circle cx="58" cy="14" r="3" fill="#fff6dc" />
      <path d="M32 22 L35.5 28 L32 34 L28.5 28 Z" fill="#4f8bff" stroke="#1d3fb8" strokeWidth="0.8" />
    </svg>
  );
}

/**
 * The hall podium: three Blender pedestals (#2 – #1 – #3) on the rune circle, the REAL top three standing on them (avatar
 * with frame, public name, the board's value). Missing places stay unoccupied seats ("Còn trống") — never a placeholder
 * learner. With nobody at all, `empty` (title, message, call to action) is shown under the waiting podium.
 * Semantically an ordered list in rank order (visual order by CSS only).
 */
export function HallPodium({
  entries,
  locale,
  ariaLabel,
  empty,
  loading = false,
}: {
  entries: PodiumEntry[];
  locale: Locale;
  ariaLabel: string;
  empty?: React.ReactNode;
  /** First load: the seats wait without the "Còn trống" words (they would flash before the real winners arrive). */
  loading?: boolean;
}) {
  const slots = podiumSlots(entries);
  const t = TEXT[locale];
  const h = HALL_TEXT[locale];
  const ordered = [...slots].sort((a, b) => a.place - b.place);
  return (
    <div className={styles.podium} data-testid="hall-podium" data-count={entries.length} aria-busy={loading || undefined}>
      <span className={styles.ring} aria-hidden="true" />
      <ol aria-label={ariaLabel} className={styles.places}>
        {ordered.map(({ place, item }) => {
          const px = AVATAR_PX[place];
          return (
            <li key={place} className={styles.place} data-place={place} data-empty={item ? undefined : 'true'}>
              <div className={styles.figure}>
                {place === 1 && <CrownMark />}
                {item ? (
                  <span className={styles.avatarRing} data-me={item.isMe ? 'true' : undefined}>
                    <span className={styles.halo} aria-hidden="true" />
                    <span className={styles.avatarInner}>
                      <BoardAvatar userId={item.userId} name={item.displayName} avatarUrl={item.avatarUrl} frame={item.avatarFrame} size="md" showcasePx={px} />
                    </span>
                  </span>
                ) : (
                  <span className={styles.emptySeat} style={{ width: px * 0.82, height: px * 0.82, fontSize: px * 0.3 }} aria-hidden="true">
                    {place}
                  </span>
                )}
              </div>
              <div className={`${styles.pedestal} ${styles.rise}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- static, content-hashed pedestal render */}
                <img src={HALL_ART.pedestal[place]} alt="" width={336} height={place === 1 ? 394 : place === 2 ? 332 : 293} decoding="async" />
                <div className={styles.plate}>
                  {item ? (
                    <>
                      <span className={styles.plateName} data-me={item.isMe ? 'true' : undefined} title={item.displayName}>
                        <span className="sr-only">#{item.rank} {place === 1 ? `${h.champion} ` : ''}</span>
                        {item.displayName}
                        {item.isMe && <span className="sr-only"> ({t.you})</span>}
                      </span>
                      <span className={styles.plateValue}>{item.value}</span>
                      {item.subValue && <span className={styles.plateSub}>{item.subValue}</span>}
                    </>
                  ) : loading ? (
                    <span className={styles.plateEmpty} aria-hidden="true">…</span>
                  ) : (
                    <span className={styles.plateEmpty} data-testid="podium-placeholder">
                      <span className="sr-only">#{place} </span>
                      {t.emptySlot}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {entries.length === 0 && !loading && empty}
    </div>
  );
}
