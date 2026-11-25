'use client';

import React from 'react';
import { BoardAvatar } from '../BoardAvatar';
import type { BoardAvatarFrame } from '@/types/leaderboard';
import styles from './hall.module.css';

/**
 * One line of the roll of honour (ranks from #4) or of an unranked group (rank = null, muted). Static LOD avatar, CSS-only
 * hover lift (off for touch and reduced motion); the learner's own line is outlined in cyan.
 */
export function HallRow({
  rank,
  userId,
  displayName,
  avatarUrl,
  avatarFrame,
  value,
  subValue,
  isMe = false,
  muted = false,
  youLabel,
  extra,
}: {
  rank: number | null;
  userId: number;
  displayName: string;
  avatarUrl: string | null;
  avatarFrame: BoardAvatarFrame | null;
  value?: string;
  subValue?: string;
  isMe?: boolean;
  muted?: boolean;
  youLabel?: string;
  extra?: React.ReactNode;
}) {
  return (
    <li className={styles.row} data-me={isMe ? 'true' : undefined} data-muted={muted ? 'true' : undefined}>
      <span className={styles.rankBadge} data-top={rank != null && rank <= 10 ? 'true' : undefined}>
        {rank != null ? `#${rank}` : '–'}
      </span>
      <span className={styles.who}>
        <BoardAvatar userId={userId} name={displayName} avatarUrl={avatarUrl} frame={avatarFrame} muted={muted} />
        <span className={styles.whoText}>
          <span className={styles.whoName} title={displayName}>
            {displayName}
            {isMe && youLabel && <span className={styles.youTag}>({youLabel})</span>}
          </span>
          {subValue && <span className={styles.whoSub}>{subValue}</span>}
        </span>
      </span>
      {value ? <span className={styles.value}>{value}</span> : <span />}
      {extra && <span className={styles.extraRow}>{extra}</span>}
    </li>
  );
}
