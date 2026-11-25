'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { PublicPartDto, PublicGroupDto, PublicItemDto } from '@/types/exams';
import { StimulusRenderer } from './StimulusRenderer';
import { QuestionRenderer } from './QuestionRenderers';
import { GroupQuestionBlock } from './GroupQuestionBlock';
import { Flag, BookOpen, Layers } from 'lucide-react';
import { partNumberFromCode } from '@/lib/exams/media';

interface ReadingWorkspaceProps {
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

type QuestionClusterType =
  | 'COMPLETION'
  | 'TRUE_FALSE'
  | 'YES_NO'
  | 'HEADING_MATCHING'
  | 'MATCHING'
  | 'MULTIPLE_CHOICE_MULTI'
  | 'MCQ';

interface QuestionCluster {
  id: string;
  minNum: number;
  maxNum: number;
  type: QuestionClusterType;
  title: string;
  instruction: string;
  subInstructions?: string[];
  referenceBox?: {
    title: string;
    items: Array<{ key: string; label: string }>;
  };
  items: PublicItemDto[];
}

/**
 * Visually emphasizes constraint phrases in canonical instructions.
 * e.g. "ONE WORD ONLY", "NO MORE THAN TWO WORDS", etc.
 */
export function renderInstructionWithEmphasis(instruction: string): React.ReactNode {
  if (!instruction) return null;

  const constraintRegex = /\b(ONE WORD ONLY|NO MORE THAN (?:ONE|TWO|THREE|[1-3]) WORDS?(?: AND\/OR A NUMBER)?|ONE WORD AND\/OR A NUMBER|TWO WORDS AND\/OR A NUMBER|A NUMBER ONLY|ONE WORD|TWO WORDS|THREE WORDS)\b/gi;

  const parts = instruction.split(constraintRegex);
  if (parts.length === 1) {
    return instruction;
  }

  return parts.map((part, i) => {
    if (constraintRegex.test(part)) {
      return (
        <strong
          key={i}
          className="font-extrabold text-foreground underline decoration-primary/50 decoration-2 underline-offset-2"
        >
          {part}
        </strong>
      );
    }
    return part;
  });
}

export function ReadingWorkspace({
  parts,
  groups,
  responses,
  onAnswerChange,
  flaggedPlacements,
  onToggleFlag,
  activePlacementId,
  onSelectPlacement,
  attemptId,
  questionNumbers,
  lang = 'vi',
}: ReadingWorkspaceProps) {
  // Normalize parts structure
  const activeParts: PublicPartDto[] = useMemo(() => {
    if (parts && parts.length > 0) return parts;
    if (groups && groups.length > 0) {
      return [
        {
          id: 'part-1',
          partCode: 'PART_1',
          ordinal: 1,
          groups: groups,
        },
      ];
    }
    return [];
  }, [parts, groups]);

  // Printed question numbers from the shell (Exams Phase 7); sequential 1..40 only for legacy payloads.
  const itemNumberMap = useMemo(() => {
    if (questionNumbers && questionNumbers.size > 0) return questionNumbers;
    const map = new Map<string, number>();
    let count = 1;
    activeParts.forEach((part) => {
      part.groups.forEach((group) => {
        group.items.forEach((item) => {
          map.set(item.placementId, count++);
        });
      });
    });
    return map;
  }, [activeParts, questionNumbers]);

  const passageLabel = (part: PublicPartDto | undefined, idx: number) =>
    `Passage ${partNumberFromCode(part?.partCode) ?? idx + 1}`;

  const [activePartIndex, setActivePartIndex] = useState<number>(0);
  const [mobileTab, setMobileTab] = useState<'PASSAGE' | 'QUESTIONS'>('PASSAGE');

  // Synchronize active passage with currently selected placement ID and scroll into view
  useEffect(() => {
    if (!activePlacementId) return;
    const partIdx = activeParts.findIndex((part) =>
      part.groups.some((g) => g.items.some((item) => item.placementId === activePlacementId))
    );
    if (partIdx >= 0 && partIdx !== activePartIndex) {
      setActivePartIndex(partIdx);
    }

    // Scroll corresponding question element into view
    setTimeout(() => {
      const el = document.getElementById(`item-${activePlacementId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }, [activePlacementId, activeParts]);

  const currentPart = activeParts[activePartIndex] || activeParts[0];

  // Primary stimulus for the active passage
  const currentStimuli = useMemo(() => {
    const list = currentPart?.groups.flatMap((g) => g.stimuli || []).filter(Boolean) || [];
    const unique: typeof list = [];
    const seen = new Set<string>();
    for (const s of list) {
      const key = s.id || s.title || (s.bodyPayload ? JSON.stringify(s.bodyPayload).slice(0, 50) : '');
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(s);
      }
    }
    return unique;
  }, [currentPart]);

  const currentStimulus = currentStimuli[0] || null;

  // All groups in the active passage part
  const currentGroups = currentPart?.groups || [];

  // Exams Phase 4B.3: canonical packages carry the printed group presentation (instructions, template, selection);
  // then each group renders exactly as printed. Legacy payloads keep the derived clusters below.
  const usePrintedGroups = currentGroups.length > 0 && currentGroups.every((g) => !!g.presentation);

  // Group items into canonical, source-faithful question clusters
  const questionClusters: QuestionCluster[] = useMemo(() => {
    const clusters: QuestionCluster[] = [];
    const allPartItems: PublicItemDto[] = currentGroups.flatMap((g) => g.items);

    let currentItems: PublicItemDto[] = [];
    let currentType: QuestionClusterType | null = null;

    const determineClusterType = (item: PublicItemDto): QuestionClusterType => {
      const iType = (item.interactionType || '').toUpperCase();

      if (iType.includes('GAP') || iType.includes('ENTRY') || iType.includes('BLANK') || iType === 'SHORT_ANSWER') {
        return 'COMPLETION';
      }

      if (iType === 'HEADING_MATCHING') {
        return 'HEADING_MATCHING';
      }

      const rawOpts = item.options || item.optionDefinitions;
      const options = Array.isArray(rawOpts)
        ? rawOpts
        : rawOpts?.options || rawOpts?.choices || rawOpts?.values || rawOpts?.items || [];

      const optTexts = options.map((o: any) => String(o.label || o.text || o.id || o).toUpperCase());

      if (iType === 'TRUTH_CLASSIFICATION' || optTexts.includes('TRUE') || optTexts.includes('YES')) {
        if (optTexts.includes('YES')) {
          return 'YES_NO';
        }
        return 'TRUE_FALSE';
      }

      if (iType === 'MATCHING') {
        return 'MATCHING';
      }

      if (iType === 'MULTIPLE_CHOICE_MULTI') {
        return 'MULTIPLE_CHOICE_MULTI';
      }

      return 'MCQ';
    };

    const flushCluster = () => {
      if (currentItems.length === 0 || !currentType) return;
      const minNum = itemNumberMap.get(currentItems[0].placementId) || 1;
      const maxNum = itemNumberMap.get(currentItems[currentItems.length - 1].placementId) || minNum;
      const passageNum = activePartIndex + 1;

      let title = minNum === maxNum ? `Question ${minNum}` : `Questions ${minNum}–${maxNum}`;
      let instruction = '';
      let subInstructions: string[] | undefined = undefined;
      let referenceBox: QuestionCluster['referenceBox'] | undefined = undefined;

      switch (currentType) {
        case 'COMPLETION': {
          // Determine word limit from item definitions
          const firstOpt = currentItems[0].options || currentItems[0].optionDefinitions;
          const wordLimit = currentItems[0].wordLimit || (!Array.isArray(firstOpt) && (firstOpt as any)?.wordLimit) || 1;
          const isSummary = currentItems.some(
            (it) =>
              (it.prompt || '').toLowerCase().includes('summary') ||
              (it.prompt || '').toLowerCase().includes('fun at work')
          );
          title = isSummary ? 'Complete the summary below.' : 'Complete the notes below.';
          if (wordLimit === 1) {
            instruction = 'Choose ONE WORD ONLY from the passage for each answer.';
          } else {
            instruction = `Choose NO MORE THAN ${wordLimit} WORDS from the passage for each answer.`;
          }
          break;
        }
        case 'TRUE_FALSE': {
          title = `Do the following statements agree with the information given in Reading Passage ${passageNum}?`;
          instruction = `In boxes ${minNum}–${maxNum} on your answer sheet, choose:`;
          subInstructions = [
            'TRUE: if the statement agrees with the information',
            'FALSE: if the statement contradicts the information',
            'NOT GIVEN: if there is no information on this',
          ];
          break;
        }
        case 'YES_NO': {
          title = `Do the following statements agree with the claims of the writer in Reading Passage ${passageNum}?`;
          instruction = `In boxes ${minNum}–${maxNum} on your answer sheet, choose:`;
          subInstructions = [
            'YES: if the statement agrees with the claims of the writer',
            'NO: if the statement contradicts the claims of the writer',
            'NOT GIVEN: if it is impossible to say what the writer thinks about this',
          ];
          break;
        }
        case 'HEADING_MATCHING': {
          title = `Questions ${minNum}–${maxNum}`;
          instruction = `Reading Passage ${passageNum} has several paragraphs. Choose the correct heading for each paragraph from the list of headings below.`;

          // Dynamically extract reference box from the options of the heading items
          const rawOpts = currentItems[0].options || currentItems[0].optionDefinitions;
          const options = Array.isArray(rawOpts)
            ? rawOpts
            : rawOpts?.options || rawOpts?.choices || [];

          if (options.length > 0) {
            referenceBox = {
              title: 'List of Headings',
              items: options.map((opt: any) => ({
                key: String(opt.id || opt.key || opt.label || ''),
                label: String(opt.text || opt.label || opt),
              })),
            };
          }
          break;
        }
        case 'MATCHING': {
          title = `Questions ${minNum}–${maxNum}`;
          instruction = 'Match each item with the correct option below.';

          // Dynamically extract reference box if options have descriptive text
          const rawOpts = currentItems[0].options || currentItems[0].optionDefinitions;
          const options = Array.isArray(rawOpts)
            ? rawOpts
            : rawOpts?.options || rawOpts?.choices || rawOpts?.targetChoices || [];

          if (options.length > 0 && options.some((o: any) => o.text && o.text !== o.id)) {
            referenceBox = {
              title: 'Options',
              items: options.map((opt: any) => ({
                key: String(opt.id || opt.key || opt.label || ''),
                label: String(opt.text || opt.label || opt),
              })),
            };
          }
          break;
        }
        case 'MULTIPLE_CHOICE_MULTI': {
          const card = currentItems[0].cardinality || 2;
          title = `Questions ${minNum}–${maxNum}`;
          instruction = `Choose ${card} correct letters.`;
          break;
        }
        case 'MCQ':
        default: {
          title = `Questions ${minNum}–${maxNum}`;

          // Check option range across items in cluster
          const rawOpts = currentItems[0]?.options || currentItems[0]?.optionDefinitions;
          const options = Array.isArray(rawOpts)
            ? rawOpts
            : rawOpts?.options || rawOpts?.choices || rawOpts?.values || rawOpts?.items || [];

          if (options.length > 0) {
            const firstOpt = options[0];
            const lastOpt = options[options.length - 1];
            const firstKey = String(firstOpt.id || firstOpt.key || firstOpt.label || 'A').toUpperCase();
            const lastKey = String(lastOpt.id || lastOpt.key || lastOpt.label || 'D').toUpperCase();

            if (/^[A-Z]$/.test(firstKey) && /^[A-Z]$/.test(lastKey) && options.length > 4) {
              instruction = `Choose the correct letter, ${firstKey}–${lastKey}.`;
            } else if (options.length === 4 && firstKey === 'A' && lastKey === 'D') {
              instruction = 'Choose the correct letter, A, B, C or D.';
            } else if (options.length === 3 && firstKey === 'A' && lastKey === 'C') {
              instruction = 'Choose the correct letter, A, B or C.';
            } else {
              instruction = `Choose the correct letter, ${firstKey}–${lastKey}.`;
            }
          } else {
            instruction = 'Choose the correct letter, A, B, C or D.';
          }
          break;
        }
      }

      clusters.push({
        id: `cluster-${clusters.length}-${minNum}`,
        minNum,
        maxNum,
        type: currentType,
        title,
        instruction,
        subInstructions,
        referenceBox,
        items: [...currentItems],
      });

      currentItems = [];
      currentType = null;
    };

    allPartItems.forEach((item) => {
      const type = determineClusterType(item);
      if (currentType === null) {
        currentType = type;
        currentItems.push(item);
      } else if (currentType === type) {
        currentItems.push(item);
      } else {
        flushCluster();
        currentType = type;
        currentItems.push(item);
      }
    });

    flushCluster();
    return clusters;
  }, [currentGroups, itemNumberMap, activePartIndex]);

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-background text-foreground overflow-hidden">
      {/* Mobile Tab Switcher */}
      <div className="md:hidden flex border-b border-border bg-card">
        <button
          onClick={() => setMobileTab('PASSAGE')}
          className={`flex-1 py-3 text-center text-xs font-semibold border-b-2 transition-colors ${
            mobileTab === 'PASSAGE'
              ? 'border-primary text-primary font-bold'
              : 'border-transparent text-muted-foreground'
          }`}
        >
          {passageLabel(currentPart, activePartIndex)}
        </button>
        <button
          onClick={() => setMobileTab('QUESTIONS')}
          className={`flex-1 py-3 text-center text-xs font-semibold border-b-2 transition-colors ${
            mobileTab === 'QUESTIONS'
              ? 'border-primary text-primary font-bold'
              : 'border-transparent text-muted-foreground'
          }`}
        >
          {lang === 'vi' ? 'Câu hỏi' : 'Questions'}
        </button>
      </div>

      {/* Main Two-Pane Exam Canvas */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        {/* Left Pane: Authentic Reading Passage ONLY (50% desktop) */}
        <div
          className={`md:w-1/2 w-full h-full flex flex-col border-r border-border bg-card/60 ${
            mobileTab === 'QUESTIONS' ? 'hidden md:flex' : 'flex'
          }`}
        >
          {/* Passage Switcher Tabs */}
          {activeParts.length > 1 && (
            <div className="flex items-center gap-1.5 px-4 py-2 bg-muted/30 border-b border-border shrink-0 overflow-x-auto">
              {activeParts.map((part, idx) => {
                const isSelected = idx === activePartIndex;
                const totalItems = part.groups.flatMap((g) => g.items).length;
                return (
                  <button
                    key={part.id || idx}
                    id={`reading-passage-tab-${idx + 1}`}
                    onClick={() => {
                      const firstItem = part.groups.flatMap((g) => g.items)[0];
                      if (firstItem) {
                        onSelectPlacement(firstItem.placementId);
                      }
                      setActivePartIndex(idx);
                    }}
                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-background text-primary shadow-xs border border-border font-bold'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                    }`}
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>{passageLabel(part, idx)}</span>
                    <span className="text-[11px] text-muted-foreground">({totalItems} {lang === 'vi' ? 'câu' : 'Qs'})</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Passage Content - Independent Scrollable Surface */}
          <div
            id="reading-passage-container"
            className="flex-1 overflow-y-auto p-6 md:p-8 space-y-6 select-text text-foreground leading-relaxed notranslate"
            translate="no"
          >
            {currentStimuli.length > 1 ? (
              <StimulusRenderer stimuli={currentStimuli} attemptId={attemptId} />
            ) : currentStimulus ? (
              <StimulusRenderer stimulus={currentStimulus} attemptId={attemptId} />
            ) : (
              <div className="text-muted-foreground italic p-8 text-center">
                {lang === 'vi' ? 'Bài đọc của phần này chưa sẵn sàng.' : 'The passage for this part is not available.'}
              </div>
            )}
          </div>
        </div>

        {/* Right Pane: Question Interaction Pane (50% desktop) */}
        <div
          className={`md:w-1/2 w-full h-full flex flex-col bg-background ${
            mobileTab === 'PASSAGE' ? 'hidden md:flex' : 'flex'
          }`}
        >
          {/* Passage Section Header */}
          <div className="px-6 py-2.5 bg-muted/20 border-b border-border flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" />
              <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                {lang === 'vi' ? 'Câu hỏi' : 'Questions'} · {passageLabel(currentPart, activePartIndex)}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {currentGroups.flatMap((g) => g.items).length} {lang === 'vi' ? 'câu' : 'questions'}
            </span>
          </div>

          {/* Question Clusters */}
          <div
            id="reading-questions-container"
            className="flex-1 overflow-y-auto p-6 md:p-8 space-y-8 notranslate"
            translate="no"
          >
            {usePrintedGroups &&
              currentGroups.map((group) => (
                <GroupQuestionBlock
                  key={group.id}
                  group={group}
                  numberOf={(it) => itemNumberMap.get(it.placementId) || 1}
                  responses={responses}
                  onAnswerChange={onAnswerChange}
                  flaggedPlacements={flaggedPlacements}
                  onToggleFlag={onToggleFlag}
                  activePlacementId={activePlacementId}
                  onSelectPlacement={onSelectPlacement}
                  attemptId={attemptId}
                  lang={lang}
                />
              ))}
            {!usePrintedGroups && questionClusters.map((cluster) => {
              const rangeText =
                cluster.minNum === cluster.maxNum
                  ? `Question ${cluster.minNum}`
                  : `Questions ${cluster.minNum}–${cluster.maxNum}`;

              return (
                <div
                  key={cluster.id}
                  className="bg-card border border-border rounded-2xl p-6 shadow-xs space-y-5"
                >
                  {/* Group Header & Source-Derived Instructions */}
                  <div className="space-y-3 border-b border-border/80 pb-4">
                    <div className="flex items-center justify-between">
                      <span className="px-3 py-1 rounded-md bg-primary text-primary-foreground font-bold text-xs">
                        {rangeText}
                      </span>
                      <span className="text-xs font-semibold px-2.5 py-0.5 rounded-md bg-muted text-muted-foreground">
                        {cluster.items.length} {cluster.items.length === 1 ? 'question' : 'questions'}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <h3 className="text-sm font-bold text-foreground">
                        {cluster.title}
                      </h3>
                      {cluster.instruction && (
                        <p className="text-xs font-medium text-foreground/90 leading-relaxed">
                          {renderInstructionWithEmphasis(cluster.instruction)}
                        </p>
                      )}
                      {cluster.subInstructions && (
                        <div className="p-3 rounded-lg bg-muted/40 border border-border/60 space-y-1 text-xs text-muted-foreground">
                          {cluster.subInstructions.map((si, idx) => (
                            <div key={idx} className="font-mono text-[11px] text-foreground/80">
                              • {si}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Dynamically Sourced Reference Box (e.g. List of Headings or Options) */}
                    {cluster.referenceBox && (
                      <div className="p-4 rounded-xl bg-primary/5 border border-primary/20 space-y-2">
                        <span className="text-xs font-bold text-primary uppercase tracking-wider block">
                          {cluster.referenceBox.title}
                        </span>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                          {cluster.referenceBox.items.map((refItem) => (
                            <div key={refItem.key} className="flex items-baseline gap-2">
                              <span className="font-bold text-primary font-mono">{refItem.key}.</span>
                              <span className="text-foreground/90">{refItem.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Compact Question Items */}
                  <div className="space-y-4 divide-y divide-border/60">
                    {cluster.items.map((item) => {
                      const isFlagged = flaggedPlacements.includes(item.placementId);
                      const userVal = responses[item.placementId];
                      const isCurrent = activePlacementId === item.placementId;
                      const itemNumber = itemNumberMap.get(item.placementId) || 1;

                      return (
                        <div
                          key={item.id}
                          id={`item-${item.placementId}`}
                          onClick={() => onSelectPlacement(item.placementId)}
                          className={`pt-4 first:pt-0 transition-all rounded-xl p-3 -mx-3 cursor-pointer ${
                            isCurrent
                              ? 'bg-primary/5 ring-1 ring-primary/30'
                              : 'hover:bg-muted/30'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3 mb-2.5">
                            <span className="w-7 h-7 rounded-lg bg-primary/10 text-primary border border-primary/20 flex items-center justify-center font-bold text-xs shrink-0 shadow-xs">
                              {itemNumber}
                            </span>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleFlag(item.placementId);
                              }}
                              className={`p-1.5 rounded-lg border transition-colors cursor-pointer shrink-0 ${
                                isFlagged
                                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                                  : 'text-muted-foreground hover:text-foreground border-border bg-card hover:bg-muted'
                              }`}
                              title={isFlagged ? 'Đã đánh dấu' : 'Đánh dấu câu hỏi'}
                            >
                              <Flag className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <div className="pl-1">
                            <QuestionRenderer
                              item={item}
                              value={userVal}
                              onChange={(val) => onAnswerChange(item.placementId, val)}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
