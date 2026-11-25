'use client';

import React, { useMemo, useState } from 'react';
import { Flag } from 'lucide-react';
import type { PublicGroupDto, PublicItemDto } from '@/types/exams';
import { QuestionRenderer, formatOptionCleanText } from './QuestionRenderers';
import { StimulusRenderer } from './StimulusRenderer';
import {
  distributeSelection,
  extractChoice,
  itemQuestionNumber,
  optionIds,
  parseCompletionTemplate,
  selectedFromResponses,
  toggleChooseN,
  wordLimitLabel,
} from '@/lib/exams/groupPresentation';

interface GroupQuestionBlockProps {
  group: PublicGroupDto;
  numberOf: (item: PublicItemDto) => number;
  responses: Record<string, any>;
  onAnswerChange: (placementId: string, value: any) => void;
  flaggedPlacements: string[];
  onToggleFlag: (placementId: string) => void;
  activePlacementId?: string;
  onSelectPlacement: (placementId: string) => void;
  lang?: 'vi' | 'en';
  /** Needed to resolve a label-assignment figure through a playback grant. */
  attemptId?: string;
  /**
   * Exams Phase 7: the workspace already shows this group's figure in its own pane (IELTS Listening question paper),
   * so it is not repeated here. Reading contexts keep the figure beside the targets.
   */
  figureShownElsewhere?: boolean;
}

const VISUAL_KINDS = new Set(['IMAGE', 'CHART', 'MAP', 'TABLE', 'DIAGRAM', 'GRAPH', 'PROCESS', 'PHOTO']);

const isTextEntry = (item: PublicItemDto) => {
  const t = (item.interactionType || '').toUpperCase();
  return t.includes('GAP') || t.includes('ENTRY') || t.includes('BLANK') || t === 'SHORT_ANSWER';
};

/**
 * Exams Phase 4B.3–4B.7 — one canonical question group exactly as printed: server instructions once, the shared
 * completion template with numbered inline blanks, "Choose TWO" as one bounded multi-select, the word-limit rule,
 * and per-item renderers for everything else. Used when the manifest carries `group.presentation`.
 */
export function GroupQuestionBlock({
  group,
  numberOf,
  responses,
  onAnswerChange,
  flaggedPlacements,
  onToggleFlag,
  activePlacementId,
  onSelectPlacement,
  lang = 'vi',
  attemptId,
  figureShownElsewhere = false,
}: GroupQuestionBlockProps) {
  const p = group.presentation || {};
  const items = group.items || [];
  // Label the map / plan / diagram: the canonical figure stays visible next to the targets (Exams Phase 6).
  const isLabelAssignment = items.some((it) => (it.interactionType || '').toUpperCase() === 'LABEL_ASSIGNMENT');
  const figureStimuli = isLabelAssignment
    ? (group.stimuli || []).filter((st) => VISUAL_KINDS.has((st.kind || '').toUpperCase()))
    : [];
  const numbers = items.map((it) => itemQuestionNumber(it) ?? numberOf(it));
  const minNum = numbers.length ? Math.min(...numbers) : null;
  const maxNum = numbers.length ? Math.max(...numbers) : null;
  const range = p.questions || (minNum !== null ? (minNum === maxNum ? `${minNum}` : `${minNum}–${maxNum}`) : '');

  const limitLabel = wordLimitLabel(p.wordLimit ?? items.find((i) => i.wordLimit)?.wordLimit ?? null, p.wordLimitRule, lang);

  const template = useMemo(
    () => (p.stem && items.length > 0 && items.every(isTextEntry) ? parseCompletionTemplate(p.stem, numbers) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.stem, items]
  );

  const selection = p.selection && p.selection.count > 1 ? p.selection : null;
  const selectionMembers = useMemo(() => {
    if (!selection) return [] as PublicItemDto[];
    const wanted = new Set(selection.questions || []);
    return items
      .filter((it) => wanted.has(itemQuestionNumber(it) ?? -1))
      .sort((a, b) => (itemQuestionNumber(a) ?? 0) - (itemQuestionNumber(b) ?? 0));
  }, [selection, items]);
  const chooseN = selection && selectionMembers.length === selection.count ? selection : null;

  const itemByNumber = new Map(items.map((it) => [itemQuestionNumber(it) ?? numberOf(it), it]));

  const renderFlag = (pid: string) => {
    const isFlagged = flaggedPlacements.includes(pid);
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFlag(pid);
        }}
        className={`p-1.5 rounded-lg border transition-colors cursor-pointer shrink-0 ${
          isFlagged
            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
            : 'text-muted-foreground hover:text-foreground border-border bg-card hover:bg-muted'
        }`}
        aria-pressed={isFlagged}
        aria-label={lang === 'vi' ? 'Đánh dấu câu hỏi' : 'Flag question'}
      >
        <Flag className="w-3.5 h-3.5" />
      </button>
    );
  };

  const renderChooseN = () => {
    if (!chooseN) return null;
    const order = optionIds(selectionMembers[0]);
    const defs: any = selectionMembers[0].optionDefinitions || selectionMembers[0].options || {};
    const options: any[] = Array.isArray(defs) ? defs : defs.options || [];
    const selected = selectedFromResponses(selectionMembers.map((m) => responses[m.placementId]), order);
    const setSelected = (next: string[]) => {
      const stored = distributeSelection(next, order, selectionMembers.length);
      selectionMembers.forEach((m, i) => {
        if (extractChoice(responses[m.placementId]) !== stored[i]) onAnswerChange(m.placementId, stored[i]);
      });
    };
    const prompt = selectionMembers[0].prompt || '';
    return (
      <fieldset data-capability="CHOOSE_N_SELECTION" className="space-y-3">
        <legend className="text-sm font-medium text-foreground leading-snug">
          {prompt}
          <span className="block text-xs font-semibold text-amber-600 dark:text-amber-400 mt-1" aria-live="polite">
            {lang === 'vi'
              ? `Chọn đúng ${chooseN.count} đáp án (đã chọn ${selected.length}/${chooseN.count})`
              : `Choose exactly ${chooseN.count} answers (${selected.length}/${chooseN.count} chosen)`}
          </span>
        </legend>
        {options.map((opt: any) => {
          const id = String(opt.id ?? opt.key ?? opt.label);
          const checked = selected.includes(id);
          const atLimit = !checked && selected.length >= chooseN.count;
          return (
            <label
              key={id}
              className={`flex items-start gap-3 p-3 rounded-lg border transition-all ${
                checked ? 'bg-primary/10 border-primary ring-1 ring-primary/40' : 'bg-card border-border hover:bg-muted/60'
              } ${atLimit ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={atLimit}
                onChange={() => {
                  const r = toggleChooseN(selected, id, chooseN.count);
                  if (!r.rejected) setSelected(r.selected);
                }}
                className="mt-0.5 h-4 w-4 rounded text-primary focus:ring-primary border-border bg-background"
              />
              <span className="flex-1 text-sm leading-relaxed">
                <span className="font-bold text-primary mr-2">{id}.</span>
                {formatOptionCleanText(id, opt.text ?? opt.label ?? '')}
              </span>
            </label>
          );
        })}
      </fieldset>
    );
  };

  const renderTemplate = () => {
    if (!template || !template.complete) return null;
    return (
      <div data-capability="COMPLETION_TEMPLATE" className="space-y-1.5 text-sm leading-relaxed text-foreground">
        {template.lines.map((segments, li) => (
          <div key={li} className="min-h-[1.5rem] flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            {segments.map((seg, si) => {
              if (seg.type === 'text') return <span key={si} className="whitespace-pre-wrap">{seg.text}</span>;
              const item = itemByNumber.get(seg.number);
              if (!item) return null;
              const pid = item.placementId;
              const raw = responses[pid];
              const val = typeof raw === 'string' ? raw : raw?.textResponse ?? raw?.value ?? raw?.answerPayload?.value ?? '';
              return (
                <span key={si} id={`item-${pid}`} className="inline-flex items-baseline gap-1">
                  <span className="text-xs font-bold text-primary">({seg.number})</span>
                  <input
                    type="text"
                    value={val}
                    aria-label={`${lang === 'vi' ? 'Câu' : 'Question'} ${seg.number}`}
                    onFocus={() => onSelectPlacement(pid)}
                    onChange={(e) => onAnswerChange(pid, e.target.value)}
                    className={`inline-block min-w-[120px] max-w-[220px] px-2 py-0.5 bg-background border-b-2 rounded-none text-sm font-semibold focus:outline-none ${
                      activePlacementId === pid ? 'border-primary' : 'border-border'
                    }`}
                  />
                  {renderFlag(pid)}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  const individuallyRendered = items.filter(
    (it) => !(template && template.complete) && !(chooseN && selectionMembers.includes(it))
  );

  return (
    <section
      className="bg-card border border-border rounded-2xl p-6 shadow-xs space-y-5"
      aria-label={`${lang === 'vi' ? 'Câu' : 'Questions'} ${range}`}
    >
      <div className="space-y-2 border-b border-border/80 pb-4">
        <span className="inline-block px-3 py-1 rounded-md bg-primary text-primary-foreground font-bold text-xs">
          {lang === 'vi' ? 'Câu' : 'Questions'} {range}
        </span>
        {Array.isArray(p.instructions) && p.instructions.length > 0 && (
          <div data-capability="GROUP_INSTRUCTIONS" className="space-y-1">
            {p.instructions.map((line, i) => (
              <p key={i} className="text-xs font-medium text-foreground/90 leading-relaxed">
                {line}
              </p>
            ))}
          </div>
        )}
        {limitLabel && (
          <p data-capability="WORD_LIMIT_DISPLAY" className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">
            {limitLabel}
          </p>
        )}
      </div>

      {figureStimuli.length > 0 && !figureShownElsewhere && (
        <div data-capability="LABEL_ASSIGNMENT_FIGURE" className="rounded-xl border border-border bg-background p-3">
          <StimulusRenderer stimuli={figureStimuli} attemptId={attemptId} />
        </div>
      )}
      {renderTemplate()}
      {renderChooseN()}

      {individuallyRendered.length > 0 && (
        <div className="space-y-4 divide-y divide-border/60">
          {individuallyRendered.map((item) => {
            const isCurrent = activePlacementId === item.placementId;
            return (
              <div
                key={item.id}
                id={`item-${item.placementId}`}
                onClick={() => onSelectPlacement(item.placementId)}
                className={`pt-4 first:pt-0 rounded-xl p-3 -mx-3 cursor-pointer ${isCurrent ? 'bg-primary/5 ring-1 ring-primary/30' : ''}`}
              >
                <div className="flex items-start justify-between gap-3 mb-2.5">
                  <span className="w-7 h-7 rounded-lg bg-primary/10 text-primary border border-primary/20 flex items-center justify-center font-bold text-xs shrink-0">
                    {itemQuestionNumber(item) ?? numberOf(item)}
                  </span>
                  {renderFlag(item.placementId)}
                </div>
                <QuestionRenderer
                  item={item}
                  value={responses[item.placementId]}
                  onChange={(val) => onAnswerChange(item.placementId, val)}
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
