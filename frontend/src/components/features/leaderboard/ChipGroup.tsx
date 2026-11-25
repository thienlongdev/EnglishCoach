'use client';

import React, { useId } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import styles from './hall/hall.module.css';

export interface ChipOption<T extends string> {
  id: T;
  label: string;
  /** Optional leading icon (lucide, aria-hidden). */
  icon?: React.ReactNode;
}

interface ChipGroupProps<T extends string> {
  options: ChipOption<T>[];
  value: T | null;
  onChange: (id: T) => void;
  ariaLabel: string;
  /** "tabs" = the period control (gold pill); "chips" = scope / skill / board filters (sapphire pill). */
  variant?: 'tabs' | 'chips';
  className?: string;
}

/**
 * Segmented control of the Hall's control deck: every option is a <button role="tab" aria-selected>. Wraps on narrow
 * screens (no horizontal page scroll at ≤ 380 px). The active option's pill slides between options (one shared layoutId
 * per group; a plain pill under reduced motion). Only transform / opacity / colour transitions.
 */
export function ChipGroup<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  variant = 'chips',
  className = '',
}: ChipGroupProps<T>) {
  const reduceMotion = useReducedMotion();
  const groupId = useId();
  return (
    <div role="tablist" aria-label={ariaLabel} className={`${styles.chips} ${className}`} data-variant={variant === 'tabs' ? 'gold' : undefined}>
      {options.map((o) => {
        const selected = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(o.id)}
            className={styles.chip}
          >
            {selected && (
              reduceMotion ? (
                <span aria-hidden="true" className={styles.chipPill} />
              ) : (
                <motion.span
                  aria-hidden="true"
                  layoutId={`lb-chip-${groupId}`}
                  className={styles.chipPill}
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )
            )}
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
