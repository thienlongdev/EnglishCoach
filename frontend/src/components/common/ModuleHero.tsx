'use client';

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Reusable module hero: dark rounded card with a vivid, slowly moving colour gradient
 * (gold/amber → rose → violet → cyan, ~14 s loop; static under prefers-reduced-motion), gradient title,
 * subtitle and an optional right-side slot (icon / chips). Works in light and dark themes (the card is
 * always dark) and wraps at 360 px.
 */
export function ModuleHero({
  title,
  subtitle,
  aside,
  loopSeconds = 14,
}: {
  title: string;
  subtitle?: string;
  aside?: React.ReactNode;
  loopSeconds?: number;
}) {
  const reduceMotion = useReducedMotion();
  const gradient =
    'linear-gradient(120deg, rgba(245,158,11,0.55), rgba(244,63,94,0.5), rgba(139,92,246,0.5), rgba(6,182,212,0.55), rgba(245,158,11,0.55))';
  return (
    <section
      data-testid="module-hero"
      className="relative overflow-hidden rounded-3xl border border-white/10 bg-slate-950 px-5 py-6 text-white shadow-xl shadow-black/30 sm:px-8 sm:py-8"
    >
      <motion.div
        aria-hidden="true"
        data-reduced-motion={reduceMotion ? 'true' : 'false'}
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ backgroundImage: gradient, backgroundSize: '300% 300%', backgroundPosition: '0% 50%' }}
        animate={reduceMotion ? undefined : { backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'] }}
        transition={reduceMotion ? undefined : { duration: loopSeconds, ease: 'linear', repeat: Infinity }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-slate-950/55" />
      <div className="relative z-10 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            <span className="bg-gradient-to-r from-amber-200 via-rose-200 to-cyan-200 bg-clip-text text-transparent">{title}</span>
          </h1>
          {subtitle && <p className="max-w-2xl text-sm leading-relaxed text-slate-200 sm:text-base">{subtitle}</p>}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
    </section>
  );
}
