'use client';

import React, { useState, useMemo } from 'react';
import { PublicGroupDto, PublicPartDto } from '@/types/exams';
import { StimulusRenderer } from './StimulusRenderer';
import { partNumberFromCode } from '@/lib/exams/media';
import { CheckCircle2, ChevronDown, FileText, Info, PenTool } from 'lucide-react';

interface WritingEditorProps {
  groups: PublicGroupDto[];
  /** Parts of the section — used for the printed task number (Task 1 / Task 2). */
  parts?: PublicPartDto[];
  responses: Record<string, any>;
  onAnswerChange: (placementId: string, text: string) => void;
  saveStatus: string;
  /** Resolves the Task 1 visual through its playback grant (Exams Phase 4B.6). */
  attemptId?: string;
  lang?: 'vi' | 'en';
  /** Practice: the response is kept but not scored (no band, no AI evaluation). */
  isPractice?: boolean;
}

/** Words = whitespace tokens that contain a letter or a digit (punctuation-only tokens do not count). */
export function countEssayWords(text: string): number {
  if (!text || !text.trim()) return 0;
  return text.trim().split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

function numberField(defs: any, field: string): number | null {
  const v = defs && !Array.isArray(defs) ? Number(defs[field]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function textOf(raw: any): string {
  if (typeof raw === 'string') return raw;
  const v = raw?.textResponse ?? raw?.answerPayload?.value ?? raw?.text ?? raw?.value ?? '';
  return typeof v === 'string' ? v : '';
}

/**
 * IELTS Writing workspace (Exams Phase 7): task prompt + visual on the left, a plain distraction-free editor on the
 * right. Minimum words and recommended minutes come from the canonical item; when the item carries none they are
 * omitted (never invented). On phones the prompt collapses above the editor and is one tap away.
 */
export function WritingEditor({
  groups,
  parts,
  responses,
  onAnswerChange,
  attemptId,
  lang = 'vi',
  isPractice = false,
}: WritingEditorProps) {
  const [activeTaskIndex, setActiveTaskIndex] = useState<number>(0);
  const [promptOpen, setPromptOpen] = useState<boolean>(true);

  const taskNumberOf = (group: PublicGroupDto | undefined, idx: number): number => {
    const part = (parts || []).find((p) => (p.groups || []).some((g) => g.id === group?.id));
    const printed = group?.displayNumbering?.trim().match(/^Task ([12])$/i);
    return printed ? Number(printed[1]) : partNumberFromCode(part?.partCode) ?? idx + 1;
  };

  const currentGroup = groups[activeTaskIndex] || groups[0] || null;
  const stimulus = currentGroup?.stimuli?.[0] || null;
  // Exams Phase 4B.6: canonical packages carry the printed task prompt on the item and the Task 1 visual as its own
  // IMAGE / CHART / MAP stimulus — render the prompt AND every visual, never only stimuli[0].
  const visualStimuli = (currentGroup?.stimuli || []).filter((s) =>
    (s.assets || []).some((a) => (a.mimeType || '').startsWith('image/') && a.delivery === 'PLAYBACK_GRANT'));
  const usesCanonicalVisuals = visualStimuli.length > 0 || !!currentGroup?.presentation;
  const item = currentGroup?.items?.[0] || null;
  const defs: any = item?.optionDefinitions || item?.options || null;
  const minimumWords = numberField(defs, 'minimumWords');
  const recommendedMinutes = numberField(defs, 'recommendedMinutes');
  const taskNumber = taskNumberOf(currentGroup || undefined, activeTaskIndex);

  const placementId = item?.placementId || `task-${taskNumber}`;
  const textValue = textOf(responses[placementId]);
  const wordCount = useMemo(() => countEssayWords(textValue), [textValue]);
  const reached = minimumWords !== null && wordCount >= minimumWords;
  const editorId = `writing-editor-${placementId}`;

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-background text-foreground overflow-hidden">
      {groups.length > 1 && (
        <div className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-card border-b border-border shrink-0 overflow-x-auto" role="tablist">
          {groups.map((grp, idx) => {
            const isSelected = idx === activeTaskIndex;
            const hasResponse = textOf(responses[grp.items[0]?.placementId || '']).trim().length > 0;
            return (
              <button
                key={grp.id || idx}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => setActiveTaskIndex(idx)}
                className={`shrink-0 inline-flex items-center gap-2 h-9 px-3.5 rounded-lg text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-muted-foreground hover:text-foreground'
                }`}
              >
                <PenTool className="w-3.5 h-3.5" aria-hidden />
                Task {taskNumberOf(grp, idx)}
                {hasResponse && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-medium opacity-90">
                    <CheckCircle2 className="w-3 h-3" aria-hidden />
                    <span className="sr-only">{lang === 'vi' ? 'đã có bài viết' : 'has a response'}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        {/* Task prompt & visual */}
        <section
          aria-label={lang === 'vi' ? 'Đề bài' : 'Task'}
          className={`md:w-[45%] w-full md:h-full border-b md:border-b-0 md:border-r border-border bg-card/60 flex flex-col min-h-0 ${
            promptOpen ? 'max-h-[45dvh] md:max-h-none' : ''
          }`}
        >
          <button
            type="button"
            onClick={() => setPromptOpen((v) => !v)}
            aria-expanded={promptOpen}
            className="md:cursor-default w-full shrink-0 flex items-center gap-2 px-4 sm:px-6 py-3 text-left border-b border-border/70"
          >
            <FileText className="w-4 h-4 text-primary" aria-hidden />
            <span className="text-sm font-bold text-foreground">Writing Task {taskNumber}</span>
            <span className="text-[11px] text-muted-foreground truncate">
              {[
                minimumWords !== null ? (lang === 'vi' ? `Tối thiểu ${minimumWords} từ` : `At least ${minimumWords} words`) : null,
                recommendedMinutes !== null ? (lang === 'vi' ? `Gợi ý ${recommendedMinutes} phút` : `Suggested ${recommendedMinutes} min`) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <ChevronDown className={`ml-auto w-4 h-4 text-muted-foreground md:hidden transition-transform ${promptOpen ? 'rotate-180' : ''}`} aria-hidden />
          </button>
          <div
            id="writing-stimulus-container"
            className={`flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4 space-y-5 select-text ${promptOpen ? '' : 'hidden md:block'}`}
          >
            {usesCanonicalVisuals ? (
              <div className="space-y-4">
                <div className="text-[15px] text-foreground leading-relaxed whitespace-pre-line">{item?.prompt || ''}</div>
                {stimulus?.bodyPayload?.prompt && stimulus.bodyPayload.prompt !== item?.prompt && (
                  <StimulusRenderer stimulus={stimulus} attemptId={attemptId} />
                )}
                <StimulusRenderer stimuli={visualStimuli} attemptId={attemptId} />
              </div>
            ) : stimulus ? (
              <>
                <div className="text-[15px] text-foreground leading-relaxed whitespace-pre-line">{item?.prompt || ''}</div>
                <StimulusRenderer stimulus={stimulus} attemptId={attemptId} />
              </>
            ) : (
              <div className="text-[15px] text-foreground leading-relaxed whitespace-pre-line">
                {item?.prompt || (lang === 'vi' ? 'Đề bài của task này chưa sẵn sàng.' : 'The prompt for this task is not available.')}
              </div>
            )}
          </div>
        </section>

        {/* Plain editor */}
        <section aria-label={lang === 'vi' ? 'Bài viết của bạn' : 'Your response'} className="md:w-[55%] w-full flex-1 md:h-full flex flex-col min-h-0 p-3 sm:p-6">
          <label htmlFor={editorId} className="sr-only">
            {lang === 'vi' ? `Bài viết cho Task ${taskNumber}` : `Response for Task ${taskNumber}`}
          </label>
          <textarea
            id={editorId}
            data-testid="writing-editor-textarea"
            value={textValue}
            onChange={(e) => onAnswerChange(placementId, e.target.value)}
            onFocus={() => {
              if (typeof window !== 'undefined' && window.innerWidth < 768) setPromptOpen(false);
            }}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={lang === 'vi' ? `Viết bài cho Task ${taskNumber} tại đây…` : `Write your Task ${taskNumber} response here…`}
            className="flex-1 min-h-[12rem] w-full p-4 sm:p-5 bg-card border border-border rounded-xl text-foreground placeholder:text-muted-foreground text-[15px] sm:text-base leading-relaxed resize-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring select-text"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 pt-3 text-xs">
            <span className="text-muted-foreground" aria-live="polite">
              {lang === 'vi' ? 'Số từ: ' : 'Words: '}
              <strong id="writing-word-count" className={`font-bold text-sm tabular-nums ${reached ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}`}>
                {wordCount}
              </strong>
              {minimumWords !== null && <span className="tabular-nums"> / {minimumWords}</span>}
              {reached && (
                <span className="ml-2 inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
                  {lang === 'vi' ? 'Đủ số từ tối thiểu' : 'Minimum reached'}
                </span>
              )}
            </span>
            {isPractice && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Info className="w-3.5 h-3.5" aria-hidden />
                {lang === 'vi' ? 'Bài luyện viết được lưu lại, không chấm điểm.' : 'Practice writing is saved, not scored.'}
              </span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
