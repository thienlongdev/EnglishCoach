'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { PublicPartDto, PublicGroupDto, PublicItemDto } from '@/types/exams';
import { BookOpen, ChevronRight, ChevronLeft, FileText, ListChecks } from 'lucide-react';
import { StimulusRenderer } from './StimulusRenderer';
import { partNumberFromCode } from '@/lib/exams/media';
import { itemOptions, numberRange, selectedChoice, toeicPartName, toeicPartTerm } from '@/lib/exams/runnerModel';
import { ChoiceOptions } from './runner/ChoiceOptions';
import { FlagToggle } from './runner/FlagToggle';

interface ToeicReadingWorkspaceProps {
  parts?: PublicPartDto[];
  groups?: PublicGroupDto[];
  responses: Record<string, any>;
  onAnswerChange: (placementId: string, value: any) => void;
  flaggedPlacements: string[];
  onToggleFlag: (placementId: string) => void;
  activePlacementId?: string;
  onSelectPlacement: (placementId: string) => void;
  /** Resolves image assets through playback grants (Exams Phase 4B.6). */
  attemptId?: string;
  /** Exams Phase 7: printed question numbers computed once by the shell. */
  questionNumbers?: Map<string, number>;
  lang?: 'vi' | 'en';
}

interface FlattenedReadingItem {
  item: PublicItemDto;
  group: PublicGroupDto;
  part: PublicPartDto;
  partNumber: number; // 5, 6, 7
  questionNumber: number;
  globalIndex: number;
}

/**
 * TOEIC Reading workspace (Exams Phase 7).
 *  - Part 5: one compact, scannable column of sentence cards (no empty passage pane).
 *  - Part 6 / 7: the set stays intact — document(s) on the left (multi-document sets keep their boundaries via
 *    StimulusRenderer), the set's questions on the right, independent scrolling; phones switch Văn bản / Câu hỏi.
 * Only the parts present in the attempt are shown (a Part 6 practice never shows Part 5 / 7 tabs).
 */
export function ToeicReadingWorkspace({
  parts = [],
  groups = [],
  responses,
  onAnswerChange,
  flaggedPlacements,
  onToggleFlag,
  activePlacementId,
  onSelectPlacement,
  attemptId,
  questionNumbers,
  lang = 'vi',
}: ToeicReadingWorkspaceProps) {
  const activeParts: PublicPartDto[] = useMemo(() => {
    if (parts && parts.length > 0) return parts;
    if (groups && groups.length > 0) {
      return [{ id: 'part-reading', partCode: 'READING', ordinal: 1, instructions: '', groups }];
    }
    return [];
  }, [parts, groups]);

  const allItems: FlattenedReadingItem[] = useMemo(() => {
    let fallback = 101;
    const list: FlattenedReadingItem[] = [];
    activeParts.forEach((part, pIdx) => {
      // EXAM-AUD-037: the printed part comes from partCode ("READING_PART_6"); array position is only a legacy fallback.
      const codeNum = partNumberFromCode(part.partCode);
      const partNumber = codeNum && codeNum >= 5 && codeNum <= 7 ? codeNum : Math.min(7, 5 + pIdx);
      (part.groups || []).forEach((group) => {
        (group.items || []).forEach((item) => {
          const n = questionNumbers?.get(item.placementId) ?? fallback;
          fallback = n + 1;
          list.push({ item, group, part, partNumber, questionNumber: n, globalIndex: list.length });
        });
      });
    });
    return list;
  }, [activeParts, questionNumbers]);

  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [mobilePane, setMobilePane] = useState<'DOC' | 'QUESTIONS'>('DOC');

  useEffect(() => {
    if (!activePlacementId) return;
    const idx = allItems.findIndex((it) => it.item.placementId === activePlacementId);
    if (idx >= 0) setCurrentIndex(idx);
  }, [activePlacementId, allItems]);

  const current = allItems[currentIndex] || allItems[0];
  const currentPartNum = current?.partNumber || 5;
  const currentGroup = current?.group;

  const groupItems = useMemo(
    () => (currentGroup ? allItems.filter((it) => it.group.id === currentGroup.id) : []),
    [allItems, currentGroup]
  );

  // Sets of the current part (Part 6 / 7 navigation by set)
  const partSets = useMemo(() => {
    const part = current?.part;
    return (part?.groups || []).filter((g) => (g.items || []).length > 0);
  }, [current]);
  const setIndex = currentGroup ? partSets.findIndex((g) => g.id === currentGroup.id) : -1;

  const presentParts = useMemo(() => {
    const seen = new Map<number, FlattenedReadingItem>();
    allItems.forEach((it) => {
      if (!seen.has(it.partNumber)) seen.set(it.partNumber, it);
    });
    return Array.from(seen.entries()).sort(([a], [b]) => a - b);
  }, [allItems]);

  const select = (idx: number) => {
    const target = allItems[idx];
    if (!target) return;
    setCurrentIndex(idx);
    onSelectPlacement(target.item.placementId);
  };

  const choose = (pid: string, optionId: string) => onAnswerChange(pid, { value: optionId });

  const goToSet = (offset: number) => {
    const target = partSets[setIndex + offset];
    if (!target) return;
    const idx = allItems.findIndex((it) => it.group.id === target.id);
    if (idx >= 0) {
      select(idx);
      setMobilePane('DOC');
    }
  };

  if (allItems.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-sm text-muted-foreground">
        {lang === 'vi' ? 'Phần này chưa có câu hỏi để hiển thị.' : 'This part has no questions to show.'}
      </div>
    );
  }

  const renderQuestionCard = (entry: FlattenedReadingItem, compact: boolean) => {
    const pid = entry.item.placementId;
    const promptId = `prompt-${pid}`;
    const isCurrent = entry.globalIndex === currentIndex;
    return (
      <article
        key={pid}
        id={`item-${pid}`}
        onClick={() => !isCurrent && select(entry.globalIndex)}
        onFocusCapture={() => !isCurrent && select(entry.globalIndex)}
        className={`rounded-2xl border bg-card transition-colors ${compact ? 'p-4' : 'p-4 sm:p-5'} ${
          isCurrent ? 'border-primary/60 ring-1 ring-primary/30' : 'border-border'
        }`}
      >
        <div className="flex items-start gap-3 mb-3">
          <span className="shrink-0 min-w-9 h-8 px-2 rounded-lg bg-primary/10 text-primary font-bold text-sm inline-flex items-center justify-center tabular-nums">
            {entry.questionNumber}
          </span>
          <p id={promptId} className="flex-1 text-[15px] leading-relaxed text-foreground pt-1 notranslate" translate="no">
            {entry.item.prompt || (
              <span className="text-muted-foreground">
                {lang === 'vi' ? `Câu ${entry.questionNumber}` : `Question ${entry.questionNumber}`}
              </span>
            )}
          </p>
          <FlagToggle
            flagged={flaggedPlacements.includes(pid)}
            onToggle={() => onToggleFlag(pid)}
            lang={lang}
            number={entry.questionNumber}
          />
        </div>
        <div className="sm:pl-12 notranslate" translate="no">
          <ChoiceOptions
            name={pid}
            options={itemOptions(entry.item)}
            value={selectedChoice(responses[pid])}
            onChange={(id) => choose(pid, id)}
            labelledBy={promptId}
            lang={lang}
            density={compact ? 'compact' : 'regular'}
          />
        </div>
      </article>
    );
  };

  const partHeader = (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-xs font-bold uppercase tracking-wider text-primary shrink-0">Part {currentPartNum}</span>
      <span className="text-sm font-semibold text-foreground truncate">{toeicPartName(currentPartNum, lang)}</span>
      {lang === 'vi' && <span className="text-[11px] text-muted-foreground truncate hidden sm:inline">{toeicPartTerm(currentPartNum)}</span>}
    </div>
  );

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {presentParts.length > 1 && (
        <div className="shrink-0 border-b border-border bg-card/60 px-3 sm:px-4 py-2 flex items-center gap-1.5 overflow-x-auto" role="tablist" aria-label={lang === 'vi' ? 'Các Part' : 'Parts'}>
          {presentParts.map(([pNum, first]) => {
            const active = currentPartNum === pNum;
            return (
              <button
                key={`reading-part-tab-${pNum}`}
                id={`toeic-reading-part-tab-${pNum}`}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => select(first.globalIndex)}
                className={`shrink-0 h-8 px-3 rounded-lg text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                Part {pNum}
                <span className="hidden md:inline font-normal opacity-80"> · {toeicPartName(pNum, lang)}</span>
              </button>
            );
          })}
        </div>
      )}

      {currentPartNum === 5 ? (
        /* PART 5 — compact scannable list, no empty passage pane */
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-3 sm:px-6 py-5 space-y-3">
            <div className="flex items-center justify-between gap-3 pb-1">
              {partHeader}
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                {lang === 'vi' ? 'Câu' : 'Questions'} {numberRange(allItems.filter((i) => i.partNumber === 5).map((i) => i.questionNumber))}
              </span>
            </div>
            {current?.part?.instructions && (
              <p className="text-xs text-muted-foreground leading-relaxed">{current.part.instructions}</p>
            )}
            {allItems.filter((it) => it.partNumber === 5).map((entry) => renderQuestionCard(entry, true))}
          </div>
        </div>
      ) : (
        /* PART 6 / 7 — set intact: documents + their questions */
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="md:hidden shrink-0 flex border-b border-border bg-card" role="tablist" aria-label={lang === 'vi' ? 'Chế độ xem' : 'View'}>
            {(['DOC', 'QUESTIONS'] as const).map((pane) => (
              <button
                key={pane}
                type="button"
                role="tab"
                aria-selected={mobilePane === pane}
                onClick={() => setMobilePane(pane)}
                className={`flex-1 h-11 inline-flex items-center justify-center gap-1.5 text-xs font-semibold border-b-2 ${
                  mobilePane === pane ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'
                }`}
              >
                {pane === 'DOC' ? <FileText className="w-4 h-4" aria-hidden /> : <ListChecks className="w-4 h-4" aria-hidden />}
                {pane === 'DOC'
                  ? lang === 'vi' ? 'Văn bản' : 'Text'
                  : lang === 'vi' ? `Câu hỏi (${groupItems.length})` : `Questions (${groupItems.length})`}
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-0 flex flex-col md:flex-row notranslate" translate="no">
            <section
              aria-label={lang === 'vi' ? 'Văn bản' : 'Text'}
              className={`md:w-1/2 min-h-0 overflow-y-auto border-r border-border bg-card/40 ${mobilePane === 'DOC' ? 'flex-1 md:flex-none' : 'hidden md:block'}`}
            >
              <div className="max-w-prose mx-auto px-4 sm:px-6 py-5 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  {partHeader}
                  {setIndex >= 0 && partSets.length > 1 && (
                    <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                      {lang === 'vi' ? 'Bộ' : 'Set'} {setIndex + 1}/{partSets.length}
                    </span>
                  )}
                </div>
                {currentGroup?.presentation?.instructions && currentGroup.presentation.instructions.length > 0 && (
                  <div className="space-y-1">
                    {currentGroup.presentation.instructions.map((line, i) => (
                      <p key={i} className="text-xs text-muted-foreground leading-relaxed">{line}</p>
                    ))}
                  </div>
                )}
                {currentGroup?.stimuli && currentGroup.stimuli.length > 0 ? (
                  <StimulusRenderer stimuli={currentGroup.stimuli} attemptId={attemptId} />
                ) : (
                  <div className="p-6 rounded-xl border border-dashed border-border text-center text-sm text-muted-foreground">
                    <BookOpen className="w-6 h-6 mx-auto mb-2 opacity-60" aria-hidden />
                    {lang === 'vi' ? 'Văn bản của bộ câu hỏi này chưa sẵn sàng.' : 'The text for this set is not available.'}
                  </div>
                )}
              </div>
            </section>

            <section
              aria-label={lang === 'vi' ? 'Câu hỏi' : 'Questions'}
              className={`md:w-1/2 min-h-0 overflow-y-auto ${mobilePane === 'QUESTIONS' ? 'flex-1 md:flex-none' : 'hidden md:block'}`}
            >
              <div className="px-3 sm:px-6 py-5 space-y-3">
                <h3 className="text-sm font-bold text-foreground">
                  {lang === 'vi' ? 'Câu' : 'Questions'} {numberRange(groupItems.map((g) => g.questionNumber))}
                </h3>
                {groupItems.map((entry) => renderQuestionCard(entry, false))}
                <div className="flex items-center justify-between gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => goToSet(-1)}
                    disabled={setIndex <= 0}
                    className="h-10 px-3 inline-flex items-center gap-1.5 rounded-lg border border-border text-xs font-semibold hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronLeft className="w-4 h-4" aria-hidden />
                    {lang === 'vi' ? 'Bộ trước' : 'Previous set'}
                  </button>
                  <button
                    type="button"
                    onClick={() => goToSet(1)}
                    disabled={setIndex < 0 || setIndex >= partSets.length - 1}
                    className="h-10 px-3 inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {lang === 'vi' ? 'Bộ tiếp theo' : 'Next set'}
                    <ChevronRight className="w-4 h-4" aria-hidden />
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
