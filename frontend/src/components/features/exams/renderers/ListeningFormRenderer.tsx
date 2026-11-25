'use client';

import React from 'react';
import { PublicGroupDto, PublicItemDto } from '@/types/exams';
import {
  deriveCanonicalGroupTitle,
  parseGenericCompletionStem,
} from './ExamRendererRegistry';

interface ListeningFormRendererProps {
  group: PublicGroupDto;
  partIndex: number;
  partInstructions?: string;
  itemNumberMap: Map<string, number>;
  activePlacementId?: string;
  responses: Record<string, any>;
  onSelectPlacement: (placementId: string) => void;
}

export const ListeningFormRenderer: React.FC<ListeningFormRendererProps> = ({
  group,
  partIndex,
  partInstructions,
  itemNumberMap,
  activePlacementId,
  responses,
  onSelectPlacement,
}) => {
  const groupItemNumbers = group.items
    .map((it) => itemNumberMap.get(it.placementId) || 0)
    .filter(Boolean);
  const minNum = groupItemNumbers.length > 0 ? Math.min(...groupItemNumbers) : 1;
  const maxNum = groupItemNumbers.length > 0 ? Math.max(...groupItemNumbers) : 10;
  const rangeText = minNum === maxNum ? `Question ${minNum}` : `Questions ${minNum}–${maxNum}`;

  const formTitle = deriveCanonicalGroupTitle(group, partIndex);

  // Derive word limit instruction from first item if available
  const sampleWordLimit = group.items.find((it) => it.wordLimit)?.wordLimit;
  const limitInstruction = sampleWordLimit
    ? `Write NO MORE THAN ${sampleWordLimit === 1 ? 'ONE WORD' : sampleWordLimit === 2 ? 'TWO WORDS' : `${sampleWordLimit} WORDS`} AND/OR A NUMBER for each answer.`
    : null;

  return (
    <div className="space-y-5">
      {/* Canonical Source Group Instructions */}
      <div className="p-4 rounded-xl border border-primary/25 bg-primary/5 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold px-2 py-0.5 rounded bg-primary text-primary-foreground">
            {rangeText}
          </span>
          <span className="text-xs font-bold text-foreground">
            {partInstructions || 'Complete the notes below.'}
          </span>
        </div>
        {limitInstruction && (
          <p className="text-xs font-semibold text-primary dark:text-primary-foreground/90">
            {limitInstruction}
          </p>
        )}
      </div>

      {/* Question Paper Content with Numbered Interactive Blanks */}
      <div className="p-6 rounded-2xl border border-border bg-card shadow-xs space-y-4">
        <div className="text-center border-b border-border/80 pb-3">
          <h3 className="text-sm font-extrabold uppercase tracking-wider text-foreground">
            {formTitle}
          </h3>
        </div>

        <div className="space-y-3">
          {group.items.map((item) => {
            const itemNumber = itemNumberMap.get(item.placementId) || 1;
            const parsed = parseGenericCompletionStem(item.prompt, itemNumber);
            const isCurrent = activePlacementId === item.placementId;
            const userVal = responses[item.placementId];
            const valText =
              typeof userVal === 'string'
                ? userVal
                : userVal?.textResponse || userVal?.value || userVal?.answerPayload?.value || '';

            return (
              <div
                key={item.id}
                onClick={() => {
                  onSelectPlacement(item.placementId);
                  const inputEl = document.getElementById(`listening-input-${item.placementId}`);
                  if (inputEl) inputEl.focus();
                }}
                className={`p-2.5 rounded-lg border transition-all cursor-pointer flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-2 ${
                  isCurrent
                    ? 'bg-primary/10 border-primary shadow-xs ring-1 ring-primary/40'
                    : 'border-transparent hover:bg-muted/40 hover:border-border/60'
                }`}
              >
                {parsed.label && (
                  <span className="text-xs font-bold text-foreground/90 shrink-0 min-w-[130px]">
                    {parsed.label}:
                  </span>
                )}
                <div className="text-xs text-foreground leading-relaxed flex-1">
                  {parsed.prefix && <span>{parsed.prefix} </span>}
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 mx-1 rounded text-xs font-bold transition-all ${
                      isCurrent
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : valText
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
                        : 'bg-muted border border-border text-foreground/80 hover:border-primary/60'
                    }`}
                  >
                    <span>({itemNumber})</span>
                    <span className="font-mono underline decoration-dotted">
                      {valText || '________'}
                    </span>
                  </span>
                  {parsed.suffix && <span> {parsed.suffix}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
