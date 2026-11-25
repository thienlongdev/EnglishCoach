'use client';

import React from 'react';
import { BoardAvatar } from './BoardAvatar';
import type { BoardAvatarFrame } from '@/types/leaderboard';

/** Rank badge colours: #4–#10 electric blue → violet, the rest slate. */
function rankBadgeClass(rank: number, onDark: boolean): string {
  if (rank <= 10) return 'bg-gradient-to-br from-blue-500 to-violet-600 text-white shadow-[0_0_12px_rgba(99,102,241,0.45)]';
  return onDark
    ? 'bg-white/10 text-slate-200'
    : 'bg-slate-100 text-slate-600 dark:bg-white/[0.08] dark:text-slate-300';
}

/**
 * Rounded row card for ranks #4–#20 (both tabs) and the unranked list (rank = null, muted). Motion is CSS only
 * and runs only on the hovered / pressed row (lift + shadow + gradient sheen + avatar glow on hover, small press
 * feedback on tap); all of it is off under prefers-reduced-motion. Rows never animate on their own.
 */
export function BoardRowCard({
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
  onDark = false,
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
  /** Always-dark container (home widget): light text regardless of theme. */
  onDark?: boolean;
}) {
  const interactive = !muted;
  return (
    <li
      data-me={isMe ? 'true' : undefined}
      className={[
        'group relative isolate flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 overflow-hidden rounded-2xl border px-3 py-2',
        interactive
          ? 'transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.98] motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:hover:scale-100 motion-reduce:active:scale-100'
          : '',
        isMe
          ? 'border-cyan-400/70 bg-gradient-to-r from-cyan-500/15 via-blue-500/10 to-violet-500/15 shadow-[0_0_0_1px_rgba(34,211,238,0.3),0_8px_24px_-12px_rgba(34,211,238,0.6)]'
          : onDark
            ? 'border-white/10 bg-white/5 hover:border-blue-400/40 hover:shadow-[0_10px_30px_-12px_rgba(59,130,246,0.6)]'
            : muted
            ? 'border-slate-200/60 bg-slate-50/50 dark:border-slate-800/60 dark:bg-white/[0.015]'
            : 'border-slate-200 bg-white shadow-sm hover:border-blue-300 hover:shadow-[0_12px_30px_-14px_rgba(37,99,235,0.45)] dark:border-slate-800 dark:bg-[#0c1530]/80 dark:hover:border-blue-500/50 dark:hover:shadow-[0_12px_30px_-12px_rgba(59,130,246,0.55)]',
      ].join(' ')}
    >
      {interactive && (
        // Gradient sheen: opacity-only fade on hover (no per-row animation loop).
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r from-blue-500/0 via-violet-500/10 to-amber-400/10 opacity-0 transition-opacity duration-300 group-hover:opacity-100 motion-reduce:transition-none"
        />
      )}
      {rank != null && (
        <span className={`flex h-8 min-w-8 shrink-0 items-center justify-center rounded-xl px-1.5 text-sm font-black tabular-nums ${rankBadgeClass(rank, onDark)}`}>
          #{rank}
        </span>
      )}
      <span
        className={`shrink-0 rounded-full transition-shadow duration-200 motion-reduce:transition-none ${interactive ? 'group-hover:shadow-[0_0_16px_rgba(99,102,241,0.65)]' : ''}`}
      >
        <BoardAvatar userId={userId} name={displayName} avatarUrl={avatarUrl} frame={avatarFrame} muted={muted} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-semibold ${onDark ? 'text-white' : muted ? 'text-slate-500 dark:text-slate-400' : 'text-slate-800 dark:text-slate-100'}`}>
          {displayName}
          {isMe && youLabel && <span className="ml-1.5 text-xs font-bold text-cyan-600 dark:text-cyan-300">({youLabel})</span>}
        </p>
        {subValue && <p className="truncate text-xs text-slate-500 dark:text-slate-400">{subValue}</p>}
      </div>
      {value && (
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-sm font-extrabold tabular-nums ${
            onDark
              ? 'bg-amber-400/15 text-amber-100'
              : 'bg-gradient-to-r from-blue-500/10 to-violet-500/10 text-blue-700 dark:from-blue-400/15 dark:to-violet-400/15 dark:text-blue-100'
          }`}
        >
          {value}
        </span>
      )}
      {extra}
    </li>
  );
}
