'use client';

import React from 'react';
import { PublicItemDto } from '@/types/exams';

/**
 * Normalizes option display text by stripping duplicate leading keys/letters.
 * e.g. key='A', text='A. security' -> 'security'
 * e.g. key='A', text='A: security' -> 'security'
 * e.g. key='A', text='A - security' -> 'security'
 * e.g. key='A', text='(A) security' -> 'security'
 * e.g. key='iii', text='iii. heading title' -> 'heading title'
 */
export function formatOptionCleanText(key: string | number, rawText: any): string {
  const textStr = String(rawText ?? '').trim();
  const keyStr = String(key ?? '').trim();
  if (!textStr) return '';
  if (!keyStr) return textStr;

  // Escape special regex characters in keyStr
  const escapedKey = keyStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match leading forms: "A.", "A:", "A -", "(A)", "A)", "A\t", "A " followed by separator
  const prefixRegex = new RegExp(`^(\\(?${escapedKey}\\)?[:.\\-\\s]+)\\s*`, 'i');
  const cleaned = textStr.replace(prefixRegex, '').trim();
  return cleaned || textStr;
}

/**
 * Returns a standardized display label: "{Key}. {CleanText}" or just "{CleanText}" if key is empty/already present.
 * e.g. for dropdowns: formatOptionDisplayLabel('A', 'A. security') -> 'A. security'
 * e.g. for dropdowns: formatOptionDisplayLabel('A', 'security') -> 'A. security'
 * e.g. for dropdowns: formatOptionDisplayLabel('iii', 'iii. Title') -> 'iii. Title'
 */
export function formatOptionDisplayLabel(key: string | number, rawText: any): string {
  const keyStr = String(key ?? '').trim();
  const cleanText = formatOptionCleanText(keyStr, rawText);
  if (!keyStr) return cleanText;
  if (!cleanText) return keyStr;
  return `${keyStr}. ${cleanText}`;
}

interface QuestionRendererProps {
  item: PublicItemDto;
  value: any;
  onChange: (val: any) => void;
  disabled?: boolean;
}

export function QuestionRenderer({ item, value, onChange, disabled }: QuestionRendererProps) {
  const type = (item.interactionType || '').toUpperCase();

  if (type === 'TRUTH_CLASSIFICATION') {
    return <TruthClassificationRenderer item={item} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (type === 'HEADING_MATCHING') {
    return <HeadingMatchingRenderer item={item} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (type === 'MATCHING') {
    return <MatchingRenderer item={item} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (type === 'LABEL_ASSIGNMENT') {
    return <LabelAssignmentRenderer item={item} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (type === 'MULTIPLE_CHOICE_MULTI') {
    return <MultiChoiceRenderer item={item} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (type.includes('GAP') || type.includes('ENTRY') || type.includes('BLANK') || type.includes('SHORT')) {
    return <TextEntryRenderer item={item} value={value} onChange={onChange} disabled={disabled} />;
  }

  // Check if options indicate TRUTH_CLASSIFICATION (TRUE/FALSE/NOT GIVEN or YES/NO/NOT GIVEN)
  const rawOpts = item.options || item.optionDefinitions;
  const options = Array.isArray(rawOpts)
    ? rawOpts
    : rawOpts?.options || rawOpts?.choices || rawOpts?.values || rawOpts?.items || [];
  const optTexts = options.map((o: any) => String(o.label || o.text || o.id || o).toUpperCase());

  if (optTexts.includes('TRUE') || optTexts.includes('YES')) {
    return <TruthClassificationRenderer item={item} value={value} onChange={onChange} disabled={disabled} />;
  }

  // Check if options indicate paragraph/letter matching (e.g. A..G where every option is a letter or "Paragraph X")
  const isLetterMatching =
    options.length >= 5 &&
    options.every((o: any) => /^(Paragraph\s+)?[A-H]$/i.test(String(o.id || o.label || o.text || '')));

  if (isLetterMatching) {
    return <MatchingRenderer item={item} value={value} onChange={onChange} disabled={disabled} />;
  }

  return <SingleChoiceRenderer item={item} value={value} onChange={onChange} disabled={disabled} />;
}

export const QuestionRendererRegistry = QuestionRenderer;

// ─── Truth Classification (TRUE/FALSE/NOT GIVEN or YES/NO/NOT GIVEN) ─────────

export function TruthClassificationRenderer({ item, value, onChange, disabled }: QuestionRendererProps) {
  const rawOpts = item.options || item.optionDefinitions;
  let options: any[] = Array.isArray(rawOpts)
    ? rawOpts
    : rawOpts?.options || rawOpts?.choices || rawOpts?.values || rawOpts?.items || [];

  let currentVal = value;
  if (typeof value === 'object' && value !== null) {
    currentVal =
      value.choiceId ||
      value.answerPayload?.choiceId ||
      value.answerPayload?.value ||
      value.textResponse ||
      value.value;
  }

  // Fallback if options array is empty: determine if YES/NO or TRUE/FALSE
  if (options.length === 0) {
    const pUpper = (item.prompt || '').toUpperCase();
    const isYesNo = pUpper.includes('YES') || pUpper.includes('CLAIMS OF THE WRITER');
    if (isYesNo) {
      options = [
        { id: 'YES', label: 'YES', text: 'YES' },
        { id: 'NO', label: 'NO', text: 'NO' },
        { id: 'NOT GIVEN', label: 'NOT GIVEN', text: 'NOT GIVEN' },
      ];
    } else {
      options = [
        { id: 'TRUE', label: 'TRUE', text: 'TRUE' },
        { id: 'FALSE', label: 'FALSE', text: 'FALSE' },
        { id: 'NOT GIVEN', label: 'NOT GIVEN', text: 'NOT GIVEN' },
      ];
    }
  }

  // Clean prompt: strip leading question numbering or bracketed markers
  const cleanPrompt = item.prompt
    ? item.prompt
        .replace(/^Question\s*\d+:\s*/i, '')
        .replace(/\[Question\s*\d+\]/gi, '')
        .replace(/^\d+\.\s*/, '')
        .trim()
    : '';

  return (
    <div className="space-y-2.5">
      {cleanPrompt && (
        <div className="text-sm font-medium text-foreground leading-relaxed">
          {cleanPrompt}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {options.map((opt: any) => {
          const optKey = opt.id || opt.key || opt.label || opt;
          const optLabel = opt.text || opt.label || opt;
          const isSelected = String(currentVal ?? '').trim().toUpperCase() === String(optKey).trim().toUpperCase();

          return (
            <button
              key={optKey}
              type="button"
              disabled={disabled}
              onClick={() => onChange(optKey)}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all border cursor-pointer ${
                isSelected
                  ? 'bg-primary text-primary-foreground border-primary shadow-xs ring-2 ring-primary/30 font-extrabold'
                  : 'bg-card text-foreground/85 border-border hover:bg-muted hover:text-foreground'
              } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
            >
              {optLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Heading Matching Renderer (Roman numerals i, ii, iii...) ─────────────────

export function HeadingMatchingRenderer({ item, value, onChange, disabled }: QuestionRendererProps) {
  const rawOpts = item.options || item.optionDefinitions;
  const options: any[] = Array.isArray(rawOpts)
    ? rawOpts
    : rawOpts?.options || rawOpts?.choices || rawOpts?.values || rawOpts?.items || [];

  let currentVal = value;
  if (typeof value === 'object' && value !== null) {
    currentVal =
      value.choiceId ||
      value.answerPayload?.choiceId ||
      value.answerPayload?.value ||
      value.textResponse ||
      value.value;
  }

  const cleanPrompt = item.prompt
    ? item.prompt
        .replace(/^Question\s*\d+:\s*/i, '')
        .replace(/\[Question\s*\d+\]/gi, '')
        .trim()
    : '';

  return (
    <div className="space-y-2.5">
      {cleanPrompt && (
        <div className="text-sm font-medium text-foreground leading-relaxed">
          {cleanPrompt}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <select
          value={currentVal || ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-full max-w-lg px-3.5 py-2 bg-background border border-input rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary shadow-xs"
        >
          <option value="">-- Choose Heading --</option>
          {options.map((opt: any) => {
            const optKey = opt.id || opt.key || opt.label || opt;
            const optText = opt.text || opt.label || opt;
            return (
              <option key={optKey} value={optKey}>
                {formatOptionDisplayLabel(optKey, optText)}
              </option>
            );
          })}
        </select>

        {currentVal && (
          <span className="text-xs font-semibold px-2.5 py-1 rounded bg-primary/10 text-primary border border-primary/20 shrink-0">
            Selected: {currentVal}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Label Assignment (label the map / plan / diagram) ───────────────────────
//
// Exams Phase 6: one canonical item per printed target (its prompt names the place / numbered target), one shared
// canonical option pool (the letters printed on or beside the figure). The figure itself is rendered once by the group
// (GroupQuestionBlock, via playback grant). The learner assigns exactly one option id per target with a native
// <select> — keyboard and screen-reader operable, no drag-and-drop. The stored answer is the option id only. The
// canonical spec scores each target independently, so the same letter may be chosen for two targets (no uniqueness
// rule is invented here).

export function LabelAssignmentRenderer({ item, value, onChange, disabled }: QuestionRendererProps) {
  const rawOpts = item.options || item.optionDefinitions;
  const options: any[] = Array.isArray(rawOpts) ? rawOpts : rawOpts?.options || rawOpts?.choices || [];
  let currentVal = value;
  if (typeof value === 'object' && value !== null) {
    currentVal = value.value ?? value.choiceId ?? value.answerPayload?.value ?? value.textResponse ?? '';
  }
  const target = (item.prompt || '').trim();
  const selectId = `label-assign-${item.placementId}`;

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3" data-interaction="LABEL_ASSIGNMENT">
      <label htmlFor={selectId} className="text-sm font-medium text-foreground leading-relaxed flex-1">
        {target || 'Vị trí'}
      </label>
      <select
        id={selectId}
        value={currentVal || ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full sm:w-56 px-3 py-2 bg-background border border-input rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <option value="">-- Chọn nhãn --</option>
        {options.map((opt: any) => {
          const optKey = String(opt.id ?? opt.key ?? opt.label ?? opt);
          const optText = opt.text ?? opt.label ?? '';
          return (
            <option key={optKey} value={optKey}>
              {formatOptionDisplayLabel(optKey, optText)}
            </option>
          );
        })}
      </select>
    </div>
  );
}

// ─── Matching Renderer (Standard option matching or composite pairs) ─────────

export function MatchingRenderer({ item, value, onChange, disabled }: QuestionRendererProps) {
  const rawOpts = item.options || item.optionDefinitions;
  const opts = (!Array.isArray(rawOpts) ? rawOpts : null) || {};
  const pairs = opts?.pairs || [];
  const targetChoices = opts?.targetChoices || [];

  // If item uses composite pairs schema
  if (pairs.length > 0) {
    let currentMap: Record<string, string> = {};
    if (typeof value === 'object' && value !== null) {
      currentMap = value.pairs || value.answerPayload?.pairs || value.answerPayload || value;
    }

    const handleSelect = (key: string, choiceVal: string) => {
      if (disabled) return;
      const updated = { ...currentMap, [key]: choiceVal };
      onChange(updated);
    };

    return (
      <div className="space-y-4">
        {item.prompt && (
          <div className="text-sm font-medium text-foreground leading-snug">
            {item.prompt}
          </div>
        )}
        <div className="space-y-3">
          {pairs.map((p: any, idx: number) => {
            const pairKey = p.key || String(idx + 1);
            const pairLabel = p.label || p.text;
            const selectedChoice = currentMap[pairKey] || '';

            return (
              <div
                key={pairKey}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-card border border-border rounded-lg shadow-xs"
              >
                <div className="text-sm text-foreground">
                  <span className="font-bold text-primary mr-2">{pairKey}.</span>
                  <span>{pairLabel}</span>
                </div>
                <select
                  value={selectedChoice}
                  disabled={disabled}
                  onChange={(e) => handleSelect(pairKey, e.target.value)}
                  className="px-3 py-1.5 bg-background border border-input rounded-md text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">-- Select option --</option>
                  {targetChoices.map((tc: any) => {
                    const tcKey = tc.id || tc.key || tc;
                    const tcText = tc.text || tc;
                    return (
                      <option key={tcKey} value={tcKey}>
                        {formatOptionDisplayLabel(tcKey, tcText)}
                      </option>
                    );
                  })}
                </select>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Standard single-placement matching: options array on item
  const options: any[] = Array.isArray(rawOpts)
    ? rawOpts
    : rawOpts?.options || rawOpts?.choices || rawOpts?.values || rawOpts?.items || [];

  let currentVal = value;
  if (typeof value === 'object' && value !== null) {
    currentVal =
      value.choiceId ||
      value.answerPayload?.choiceId ||
      value.answerPayload?.value ||
      value.textResponse ||
      value.value;
  }

  const cleanPrompt = item.prompt
    ? item.prompt
        .replace(/^Question\s*\d+:\s*/i, '')
        .replace(/\[Question\s*\d+\]/gi, '')
        .trim()
    : '';

  // Compact button pills for standard letters (A..G) or short option sets (<= 7)
  const isShortOptionSet = options.length > 0 && options.length <= 7;

  return (
    <div className="space-y-2.5">
      {cleanPrompt && (
        <div className="text-sm font-medium text-foreground leading-relaxed">
          {cleanPrompt}
        </div>
      )}

      {isShortOptionSet ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {options.map((opt: any) => {
            const optKey = opt.id || opt.key || opt.label || opt;
            const optLabel = formatOptionDisplayLabel(optKey, opt.text || opt.label);
            const isSelected = String(currentVal ?? '') === String(optKey);

            return (
              <button
                key={optKey}
                type="button"
                disabled={disabled}
                onClick={() => onChange(optKey)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all border cursor-pointer ${
                  isSelected
                    ? 'bg-primary text-primary-foreground border-primary shadow-xs ring-2 ring-primary/30 font-extrabold'
                    : 'bg-card text-foreground/85 border-border hover:bg-muted hover:text-foreground'
                } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                {optLabel}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <select
            value={currentVal || ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="w-full max-w-lg px-3.5 py-2 bg-background border border-input rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary shadow-xs"
          >
            <option value="">-- Select Option --</option>
            {options.map((opt: any) => {
              const optKey = opt.id || opt.key || opt.label || opt;
              const optText = opt.text || opt.label || opt;
              return (
                <option key={optKey} value={optKey}>
                  {formatOptionDisplayLabel(optKey, optText)}
                </option>
              );
            })}
          </select>
        </div>
      )}
    </div>
  );
}

// ─── Single Choice Renderer ───────────────────────────────────────────────────

function SingleChoiceRenderer({ item, value, onChange, disabled }: QuestionRendererProps) {
  const rawOpts = item.options || item.optionDefinitions;
  const options = Array.isArray(rawOpts)
    ? rawOpts
    : rawOpts?.options || rawOpts?.choices || rawOpts?.values || rawOpts?.items || [];

  let currentVal = value;
  if (typeof value === 'object' && value !== null) {
    currentVal =
      value.choiceId ||
      value.answerPayload?.choiceId ||
      value.answerPayload?.value ||
      value.textResponse ||
      value.value;
  }

  // Clean prompt: strip duplicate inline question numbers or bracketed markers
  const cleanPrompt = item.prompt
    ? item.prompt
        .replace(/^Question\s*\d+:\s*/i, '')
        .replace(/\[Question\s*\d+\]/gi, '')
        .replace(/\b\d+\s*\[\s*_{2,}\s*\]/g, '_______')
        .replace(/^\d+\.\s*/, '')
        .trim()
    : '';

  // For fill-in-the-blank summary matching items with large option sets (> 5 choices, e.g. A..H),
  // render a compact dropdown selector to match IELTS summary completion conventions
  const hasInlineBlank = cleanPrompt.includes('_______') || /\b_{2,}\b/.test(cleanPrompt);
  if (options.length > 5 && hasInlineBlank) {
    return (
      <div className="space-y-2.5">
        {cleanPrompt && (
          <div className="text-sm font-medium text-foreground leading-relaxed">
            {cleanPrompt}
          </div>
        )}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <select
            value={currentVal || ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="w-full max-w-lg px-3.5 py-2 bg-background border border-input rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary shadow-xs"
          >
            <option value="">-- Choose Option --</option>
            {options.map((opt: any) => {
              const optKey = opt.id || opt.key || opt.label || opt;
              const optText = opt.text || opt.label || opt;
              return (
                <option key={optKey} value={optKey}>
                  {formatOptionDisplayLabel(optKey, optText)}
                </option>
              );
            })}
          </select>
          {currentVal && (
            <span className="text-xs font-semibold px-2.5 py-1 rounded bg-primary/10 text-primary border border-primary/20 shrink-0">
              Selected: {currentVal}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {cleanPrompt && (
        <div className="text-sm font-medium text-foreground leading-relaxed">
          {cleanPrompt}
        </div>
      )}

      <div className="space-y-2">
        {options.map((opt: any, idx: number) => {
          const optKey = opt.id || opt.key || opt.label || String.fromCharCode(65 + idx);
          const optLabel = opt.text || opt.label || opt;
          const isSelected = String(currentVal ?? '') === String(optKey);

          return (
            <label
              key={optKey}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                isSelected
                  ? 'bg-primary/10 border-primary text-foreground shadow-xs ring-1 ring-primary/40 font-medium'
                  : 'bg-card border-border hover:bg-muted/60 text-foreground/90'
              } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
            >
              <input
                type="radio"
                name={`item-${item.placementId}`}
                value={optKey}
                checked={isSelected}
                disabled={disabled}
                onChange={() => onChange(optKey)}
                className="mt-0.5 h-4 w-4 text-primary focus:ring-primary border-border bg-background cursor-pointer"
              />
              <div className="flex-1 text-sm leading-relaxed">
                <span className="font-bold text-primary mr-2">{optKey}.</span>
                <span>{formatOptionCleanText(optKey, optLabel)}</span>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ─── Multiple Choice Multi-Select Renderer ────────────────────────────────────

function MultiChoiceRenderer({ item, value, onChange, disabled }: QuestionRendererProps) {
  const rawOpts = item.options || item.optionDefinitions;
  const options = Array.isArray(rawOpts)
    ? rawOpts
    : rawOpts?.options || rawOpts?.choices || rawOpts?.values || rawOpts?.items || [];

  let currentList: string[] = [];
  if (Array.isArray(value)) {
    currentList = value;
  } else if (value && typeof value === 'object') {
    const list =
      value.selectedChoices ||
      value.answerPayload?.selectedChoices ||
      value.answerPayload?.values ||
      value.values;
    if (Array.isArray(list)) currentList = list;
  }

  const handleToggle = (key: string) => {
    if (disabled) return;
    const exists = currentList.includes(key);
    let updated: string[];
    if (exists) {
      updated = currentList.filter((k) => k !== key);
    } else {
      updated = [...currentList, key];
    }
    onChange(updated);
  };

  const cleanPrompt = item.prompt
    ? item.prompt
        .replace(/^Question\s*\d+:\s*/i, '')
        .replace(/\[Question\s*\d+\]/gi, '')
        .trim()
    : '';

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-foreground leading-snug">
        {cleanPrompt}
        {item.cardinality > 1 && (
          <span className="text-xs font-semibold text-amber-600 dark:text-amber-400 ml-2">
            (Choose {item.cardinality} answers)
          </span>
        )}
      </div>
      <div className="space-y-2">
        {options.map((opt: any, idx: number) => {
          const optKey = opt.id || opt.key || String.fromCharCode(65 + idx);
          const optLabel = opt.text || opt.label || opt;
          const isSelected = currentList.includes(optKey);

          return (
            <label
              key={optKey}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                isSelected
                  ? 'bg-primary/10 border-primary text-foreground shadow-xs ring-1 ring-primary/40 font-medium'
                  : 'bg-card border-border hover:bg-muted/60 text-foreground/90'
              } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
            >
              <input
                type="checkbox"
                value={optKey}
                checked={isSelected}
                disabled={disabled}
                onChange={() => handleToggle(optKey)}
                className="mt-0.5 h-4 w-4 rounded text-primary focus:ring-primary border-border bg-background"
              />
              <div className="flex-1 text-sm leading-relaxed">
                <span className="font-bold text-primary mr-2">{optKey}.</span>
                <span>{formatOptionCleanText(optKey, optLabel)}</span>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ─── Text Entry / Fill-in-the-blank Renderer ───────────────────────────────────

function TextEntryRenderer({ item, value, onChange, disabled }: QuestionRendererProps) {
  let textVal = '';
  if (typeof value === 'string') {
    textVal = value;
  } else if (value && typeof value === 'object') {
    textVal =
      value.textResponse ||
      value.answerPayload?.value ||
      value.answerPayload?.text ||
      value.value ||
      '';
  }

  // Clean prompt: remove bracketed question numbers and duplicate blank brackets
  const rawPrompt = item.prompt || '';
  const cleanPrompt = rawPrompt
    .replace(/^Question\s*\d+:\s*/i, '')
    .replace(/\[Question\s*\d+\]/gi, '')
    .replace(/\b\d+\s*\[\s*_{2,}\s*\]/g, '_______')
    .replace(/^\d+\.\s*/, '')
    .trim();

  // Check if the prompt has an inline blank placeholder like _______ or [ _______ ]
  const blankRegex = /(\d+\s*)?\[?\s*_{2,}\s*\]?/;
  const match = cleanPrompt.match(blankRegex);

  if (match && match.index !== undefined && match[0].length > 0) {
    const prefix = cleanPrompt.slice(0, match.index).trim();
    const suffix = cleanPrompt.slice(match.index + match[0].length).trim();

    return (
      <div className="space-y-2">
        <div className="text-sm font-medium text-foreground leading-relaxed flex flex-wrap items-baseline gap-2">
          {prefix && <span>{prefix}</span>}
          <input
            type="text"
            value={textVal}
            disabled={disabled}
            placeholder=""
            onChange={(e) => onChange(e.target.value)}
            className="inline-block min-w-[140px] max-w-[220px] px-2.5 py-1 bg-background border-b-2 border-primary border-t-0 border-l-0 border-r-0 rounded-none text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary text-sm font-semibold transition-all shadow-none disabled:opacity-50"
          />
          {suffix && <span>{suffix}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {cleanPrompt && (
        <div className="text-sm font-medium text-foreground leading-relaxed">
          {cleanPrompt}
        </div>
      )}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={textVal}
          disabled={disabled}
          placeholder="Type answer here..."
          onChange={(e) => onChange(e.target.value)}
          className="w-full max-w-md px-3.5 py-2 bg-background border border-input rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-sm transition-all shadow-xs disabled:opacity-50"
        />
      </div>
    </div>
  );
}
