'use client';

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Crown } from 'lucide-react';
import { BoardAvatar } from './BoardAvatar';
import { PODIUM_HEIGHTS, podiumSlots, TEXT, type Locale } from '@/lib/leaderboard/format';
import type { BoardAvatarFrame } from '@/types/leaderboard';

export interface PodiumEntry {
  userId: number;
  rank: number;
  displayName: string;
  avatarUrl: string | null;
  avatarFrame: BoardAvatarFrame | null;
  value: string;
  subValue?: string;
  isMe?: boolean;
}

/** #1 Gold / Solar · #2 Silver / Ice · #3 Bronze / Fire. */
const THEME: Record<1 | 2 | 3, {
  pedestal: string; badge: string; number: string; glow: string; ring: string; value: string; shine: string;
}> = {
  1: {
    pedestal: 'from-amber-200 via-amber-400 to-yellow-700',
    badge: 'bg-gradient-to-br from-yellow-100 via-amber-300 to-amber-600 text-amber-950',
    number: 'text-amber-950/80',
    glow: 'rgba(251,191,36,0.55)',
    ring: 'ring-amber-300/80',
    value: 'border-amber-300/40 bg-amber-400/15 text-amber-100',
    shine: 'rgba(255,251,235,0.75)',
  },
  2: {
    pedestal: 'from-slate-50 via-sky-200 to-slate-500',
    badge: 'bg-gradient-to-br from-white via-sky-100 to-slate-400 text-slate-900',
    number: 'text-slate-900/70',
    glow: 'rgba(125,211,252,0.45)',
    ring: 'ring-sky-200/80',
    value: 'border-sky-200/40 bg-sky-300/15 text-sky-100',
    shine: 'rgba(255,255,255,0.8)',
  },
  3: {
    pedestal: 'from-orange-300 via-orange-500 to-red-800',
    badge: 'bg-gradient-to-br from-orange-200 via-orange-400 to-red-600 text-orange-950',
    number: 'text-orange-950/75',
    glow: 'rgba(249,115,22,0.5)',
    ring: 'ring-orange-300/80',
    value: 'border-orange-300/40 bg-orange-400/15 text-orange-100',
    shine: 'rgba(255,237,213,0.7)',
  },
};

/** Compact (dashboard) crystal pedestals: translucent metal glass, lit from inside. */
const CRYSTAL: Record<1 | 2 | 3, string> = {
  1: 'from-amber-100/85 via-amber-300/45 to-amber-500/10',
  2: 'from-sky-50/85 via-sky-200/40 to-slate-400/10',
  3: 'from-orange-100/85 via-orange-400/45 to-red-500/10',
};

/** Rise order #3 → #2 → #1 (delay per place). */
const RISE_DELAY: Record<1 | 2 | 3, number> = { 3: 0.1, 2: 0.25, 1: 0.4 };

/** Avatar sizes: full board #1 96 px, #2/#3 72 px (showcase, frames animated); compact home widget 64 / 40 px (static). */
const AVATAR_PX: Record<1 | 2 | 3, number> = { 1: 96, 2: 72, 3: 72 };

/**
 * Premium podium: deep-navy arena with gold / ice / fire light pools, visual order #2 – #1 – #3, pedestals
 * 60 % / 100 % / 48 % with a big "#N". Large framed avatars (AvatarWithFrame via BoardAvatar), rank medal, name,
 * score pill. Motion (transform / opacity only, top 3 only): the panel springs from scale 0.95, pedestals rise,
 * #1 has a pulsing solar glow and a floating crown, avatars float gently. Everything is static under
 * prefers-reduced-motion. Fewer than three entries ⇒ dashed "Còn trống" placeholders. Semantically an ordered
 * list in rank order.
 */
export function Podium({
  entries,
  locale,
  ariaLabel,
  maxPedestal = 132,
  compact = false,
}: {
  entries: PodiumEntry[];
  locale: Locale;
  ariaLabel: string;
  maxPedestal?: number;
  compact?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const slots = podiumSlots(entries);
  const t = TEXT[locale];
  return (
    <motion.div
      data-testid="podium"
      data-reduced-motion={reduceMotion ? 'true' : 'false'}
      initial={reduceMotion ? false : { scale: 0.95, opacity: 0 }}
      animate={reduceMotion ? undefined : { scale: 1, opacity: 1 }}
      transition={reduceMotion ? undefined : { type: 'spring', stiffness: 260, damping: 20 }}
      className={`relative isolate overflow-hidden border border-white/10 bg-[#070d24] ${compact ? 'rounded-[1.4rem] px-2 pt-10 pb-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_30px_50px_-30px_rgba(30,20,90,0.85)] sm:px-4' : 'rounded-3xl px-2 pt-14 pb-0 shadow-[0_20px_60px_-20px_rgba(37,99,235,0.55)] sm:px-6'}`}
    >
      {/* Arena lighting: static radial pools (no animation) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            'radial-gradient(60% 55% at 50% 18%, rgba(251,191,36,0.22), transparent 70%),' +
            'radial-gradient(45% 50% at 12% 45%, rgba(56,189,248,0.18), transparent 70%),' +
            'radial-gradient(45% 50% at 88% 50%, rgba(249,115,22,0.18), transparent 70%),' +
            'linear-gradient(180deg, #0b1440 0%, #0a0f2e 55%, #050817 100%)',
        }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-amber-200/60 to-transparent" />
      {compact && (
        <>
          {/* Crystal stage: a soft spotlight on #1 and a lit floor (static light, no animation) */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-0 -z-10 h-full w-1/2 -translate-x-1/2"
            style={{ background: 'linear-gradient(180deg, rgba(253,230,138,0.26), rgba(253,230,138,0) 78%)', clipPath: 'polygon(40% 0, 60% 0, 100% 100%, 0 100%)' }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-[4%] bottom-0 -z-10 h-12 rounded-[50%]"
            style={{ background: 'radial-gradient(closest-side, rgba(129,140,248,0.5), transparent)' }}
          />
        </>
      )}

      <ol aria-label={ariaLabel} className="grid grid-cols-3 items-end gap-2 sm:gap-5">
        {slots.map(({ place, item }) => {
          const height = Math.round((maxPedestal * PODIUM_HEIGHTS[place]) / 100);
          const theme = THEME[place];
          const order = place === 2 ? 'order-1' : place === 1 ? 'order-2' : 'order-3';
          const px = compact ? (place === 1 ? 64 : 40) : AVATAR_PX[place];
          return (
            <li key={place} className={`${order} group flex min-w-0 flex-col items-center text-center`} data-place={place}>
              {item ? (
                <>
                  <motion.div
                    className="relative mb-2"
                    animate={reduceMotion || compact ? undefined : { y: [0, -5, 0] }}
                    transition={reduceMotion || compact ? undefined : { duration: 4 + place * 0.4, repeat: Infinity, ease: 'easeInOut', delay: place * 0.3 }}
                  >
                    <div className="relative transition-transform duration-300 ease-out group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100">
                      {/* Theme glow behind the avatar; #1 pulses (opacity only) */}
                      <motion.span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 rounded-full blur-2xl"
                        style={{ width: px * 1.6, height: px * 1.6, marginLeft: -px * 0.8, marginTop: -px * 0.8, background: theme.glow }}
                        animate={reduceMotion || place !== 1 ? undefined : { opacity: [0.55, 1, 0.55] }}
                        transition={reduceMotion || place !== 1 ? undefined : { duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
                      />
                      {place === 1 && (
                        <motion.span
                          aria-hidden="true"
                          className={`absolute left-1/2 z-40 -translate-x-1/2 ${compact ? '-top-7' : '-top-10'}`}
                          animate={reduceMotion ? undefined : { y: [0, -4, 0], rotate: [-4, 4, -4] }}
                          transition={reduceMotion ? undefined : { duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                        >
                          <Crown
                            className={`${compact ? 'h-6 w-6' : 'h-8 w-8'} fill-amber-300/90 text-amber-200 drop-shadow-[0_0_12px_rgba(251,191,36,0.95)]`}
                            aria-hidden="true"
                          />
                        </motion.span>
                      )}
                      <div className={`rounded-full ring-2 ring-offset-2 ring-offset-[#0a0f2e] ${item.isMe ? 'ring-cyan-300' : theme.ring}`}>
                        <BoardAvatar
                          userId={item.userId}
                          name={item.displayName}
                          avatarUrl={item.avatarUrl}
                          frame={item.avatarFrame}
                          size={compact ? (place === 1 ? 'md' : 'sm') : 'md'}
                          showcasePx={compact ? undefined : px}
                        />
                      </div>
                      <span
                        className={`absolute -bottom-1 -right-1 z-40 flex items-center justify-center rounded-full border border-white/60 font-black shadow-lg ${theme.badge} ${compact ? 'h-6 w-6 text-[11px]' : 'h-7 w-7 text-xs'}`}
                        aria-hidden="true"
                      >
                        {item.rank}
                      </span>
                    </div>
                  </motion.div>
                  <p className={`mt-1 w-full truncate px-1 font-bold ${compact ? 'text-xs' : 'text-xs sm:text-base'} ${item.isMe ? 'text-cyan-300' : 'text-white'}`}>
                    <span className="sr-only">#{item.rank} </span>
                    {item.displayName}
                    {item.isMe && <span className="ml-1 text-[10px] font-bold text-cyan-300">({t.you})</span>}
                  </p>
                  <p className={`mt-1 inline-flex max-w-full items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-extrabold tabular-nums ${compact ? 'text-[11px]' : 'text-[11px] sm:text-sm'} ${theme.value}`}>
                    {item.value}
                  </p>
                  {item.subValue && <p className="mt-0.5 w-full truncate text-[10px] text-slate-400">{item.subValue}</p>}
                </>
              ) : (
                <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-slate-600 text-slate-500" aria-hidden="true">?</div>
              )}
              {item && compact ? (
                <motion.div
                  className="relative mt-4 w-full"
                  style={{ height, transformOrigin: 'bottom' }}
                  initial={reduceMotion ? false : { scaleY: 0, opacity: 0.4 }}
                  animate={reduceMotion ? undefined : { scaleY: 1, opacity: 1 }}
                  transition={reduceMotion ? undefined : { type: 'spring', stiffness: 170, damping: 18, delay: RISE_DELAY[place] }}
                  aria-hidden="true"
                >
                  <span
                    className={`absolute inset-0 rounded-t-xl border border-b-0 border-white/35 bg-gradient-to-b ${CRYSTAL[place]}`}
                    style={{ boxShadow: `inset 0 1px 0 rgba(255,255,255,0.65), inset 0 -24px 30px -22px ${theme.glow}, 0 -14px 34px -16px ${theme.glow}` }}
                  />
                  <span
                    className="absolute inset-x-0 -top-[7px] h-[14px] rounded-[50%] border border-white/60"
                    style={{ background: `radial-gradient(closest-side, ${theme.shine}, ${theme.glow})` }}
                  />
                  <span
                    className="pointer-events-none absolute inset-y-0 left-[16%] w-[22%] -skew-x-12 opacity-30"
                    style={{ background: `linear-gradient(90deg, transparent, ${theme.shine}, transparent)` }}
                  />
                  <span className="relative flex justify-center pt-3 text-2xl font-black text-white" style={{ textShadow: `0 0 14px ${theme.glow}` }}>#{place}</span>
                </motion.div>
              ) : item ? (
                <motion.div
                  className={`relative mt-3 flex w-full items-start justify-center overflow-hidden rounded-t-2xl bg-gradient-to-b ${theme.pedestal}`}
                  style={{ height, transformOrigin: 'bottom', boxShadow: `inset 0 2px 0 rgba(255,255,255,0.55), 0 -10px 30px -12px ${theme.glow}` }}
                  initial={reduceMotion ? false : { scaleY: 0, opacity: 0.4 }}
                  animate={reduceMotion ? undefined : { scaleY: 1, opacity: 1 }}
                  transition={reduceMotion ? undefined : { type: 'spring', stiffness: 170, damping: 18, delay: RISE_DELAY[place] }}
                  aria-hidden="true"
                >
                  {/* Metallic shine band (static) */}
                  <span
                    className="pointer-events-none absolute inset-y-0 left-[18%] w-1/4 -skew-x-12 opacity-40"
                    style={{ background: `linear-gradient(90deg, transparent, ${theme.shine}, transparent)` }}
                  />
                  <span className={`relative mt-2 font-black ${compact ? 'text-2xl' : 'text-3xl sm:text-5xl'} ${theme.number}`}>#{place}</span>
                </motion.div>
              ) : (
                <div
                  className="mt-3 flex w-full items-start justify-center rounded-t-2xl border-2 border-b-0 border-dashed border-slate-600 bg-slate-800/40"
                  style={{ height }}
                  data-testid="podium-placeholder"
                >
                  <span className="mt-2 text-xs font-semibold text-slate-400">{t.emptySlot}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </motion.div>
  );
}
