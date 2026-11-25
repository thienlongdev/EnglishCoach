'use client';

import React from 'react';
import { Check } from 'lucide-react';
import { formatOptionCleanText } from '../QuestionRenderers';
import type { ChoiceOption, UxLang } from '@/lib/exams/runnerModel';

interface ChoiceOptionsProps {
  /** Radio group name — the placement id keeps groups independent. */
  name: string;
  options: ChoiceOption[];
  value: string;
  onChange: (optionId: string) => void;
  /** id of the element that names the question (prompt / number). */
  labelledBy?: string;
  lang: UxLang;
  /** 'compact' = dense two-column grid for short options (TOEIC Part 5); 'roomy' = large tap targets (Part 1 / 2). */
  density?: 'compact' | 'regular' | 'roomy';
  /** Listening Parts 1–2 print no option text: only the letter is shown, never invented text. */
  lettersOnly?: boolean;
  disabled?: boolean;
}

/**
 * Exams Phase 7 — accessible single-choice list: native radio inputs (arrow keys, screen readers), a visible focus
 * ring, and a selected state shown by fill + check mark (not colour alone). Stores the canonical option id only.
 */
export function ChoiceOptions({
  name,
  options,
  value,
  onChange,
  labelledBy,
  lang,
  density = 'regular',
  lettersOnly = false,
  disabled = false,
}: ChoiceOptionsProps) {
  if (options.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {lang === 'vi' ? 'Câu hỏi này chưa có lựa chọn để hiển thị.' : 'No options are available for this question.'}
      </p>
    );
  }
  const shortOptions = options.every((o) => (o.text || '').length <= 36);
  const grid =
    density === 'compact' && shortOptions && !lettersOnly ? 'grid grid-cols-1 sm:grid-cols-2 gap-2' : lettersOnly ? 'grid grid-cols-1 gap-2.5' : 'grid grid-cols-1 gap-2';
  const pad = density === 'roomy' ? 'min-h-14 px-4 py-3' : density === 'compact' ? 'min-h-11 px-3 py-2' : 'min-h-12 px-3.5 py-2.5';

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className={grid}>
      {options.map((opt) => {
        const selected = value === opt.id;
        const text = lettersOnly ? '' : formatOptionCleanText(opt.id, opt.text);
        return (
          <label
            key={opt.id}
            className={`group relative flex items-center gap-3 rounded-xl border text-left transition-colors ${pad} ${
              selected
                ? 'bg-primary/10 border-primary text-foreground'
                : 'bg-card border-border text-foreground/90 hover:bg-muted/60 hover:border-foreground/25'
            } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'} has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring`}
          >
            <input
              type="radio"
              name={`choice-${name}`}
              value={opt.id}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(opt.id)}
              className="sr-only"
            />
            <span
              aria-hidden
              className={`shrink-0 inline-flex items-center justify-center rounded-full border font-bold ${
                density === 'roomy' ? 'w-9 h-9 text-sm' : 'w-7 h-7 text-xs'
              } ${selected ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted/60 border-border text-muted-foreground'}`}
            >
              {opt.id}
            </span>
            <span className={`flex-1 leading-snug ${density === 'compact' ? 'text-sm' : 'text-sm sm:text-[15px]'}`}>
              {lettersOnly ? (
                <span className="font-semibold">({opt.id})</span>
              ) : (
                <>
                  <span className="sr-only">{opt.id}. </span>
                  {text || <span className="font-semibold">({opt.id})</span>}
                </>
              )}
            </span>
            {selected && <Check className="w-4 h-4 shrink-0 text-primary" aria-hidden />}
          </label>
        );
      })}
    </div>
  );
}

export default ChoiceOptions;
