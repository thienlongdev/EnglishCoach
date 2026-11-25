/**
 * Exams Recovery Phase 4B — pure runtime presentation logic for canonical question groups (no React, no I/O), executed
 * by scripts/check-exams-phase4-runtime-contract.mjs. Functions are dependency-free on purpose.
 *
 * Contracts:
 *  - group instructions come from the server (`presentation.instructions`) and are shown ONCE per group;
 *  - a completion template (`presentation.stem`) is rendered only when every "(n) ______" blank maps to exactly one
 *    item of the group and every item has its blank; otherwise items render individually (nothing invented);
 *  - "Choose TWO": the learner picks exactly `selection.count` DISTINCT options; picks are stored one option id per
 *    item in printed question order (option order), so a duplicate can never be stored and resume is lossless;
 *  - MULTI_DOC stimuli keep document boundaries only when the extractor proved them (`documentBoundaries: SEGMENTED`).
 */

export type TemplateSegment = { type: 'text'; text: string } | { type: 'blank'; number: number };

export interface ParsedTemplate {
  lines: TemplateSegment[][];
  /** Every item number has exactly one blank and every blank belongs to an item of the group. */
  complete: boolean;
}

const BLANK_RE = /\((\d{1,3})\)\s*(?:_{2,}|…{1,}|\.{3,})/g;

export function parseCompletionTemplate(stem: string | null | undefined, itemNumbers: number[]): ParsedTemplate {
  const lines: TemplateSegment[][] = [];
  const seen = new Map<number, number>();
  const text = String(stem || '');
  for (const rawLine of text.split(/\r?\n/)) {
    const segments: TemplateSegment[] = [];
    let last = 0;
    BLANK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BLANK_RE.exec(rawLine)) !== null) {
      if (m.index > last) segments.push({ type: 'text', text: rawLine.slice(last, m.index) });
      const n = Number(m[1]);
      segments.push({ type: 'blank', number: n });
      seen.set(n, (seen.get(n) || 0) + 1);
      last = m.index + m[0].length;
    }
    if (last < rawLine.length) segments.push({ type: 'text', text: rawLine.slice(last) });
    lines.push(segments);
  }
  const wanted = new Set(itemNumbers);
  const complete =
    itemNumbers.length > 0 &&
    wanted.size === itemNumbers.length &&
    itemNumbers.every((n) => seen.get(n) === 1) &&
    Array.from(seen.keys()).every((n) => wanted.has(n));
  return { lines, complete };
}

/** Printed question number of an item (optionDefinitions.questionNumber), else null. */
export function itemQuestionNumber(item: { optionDefinitions?: any; options?: any } | null | undefined): number | null {
  const defs = (item && (item.optionDefinitions || item.options)) || null;
  const n = defs && !Array.isArray(defs) ? Number(defs.questionNumber) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Option ids of an item in printed order. */
export function optionIds(item: { optionDefinitions?: any; options?: any } | null | undefined): string[] {
  const defs = (item && (item.optionDefinitions || item.options)) || null;
  const list = Array.isArray(defs) ? defs : defs?.options || defs?.choices || [];
  return list.map((o: any) => String(o?.id ?? o?.key ?? o?.label ?? o)).filter((s: string) => s.length > 0);
}

/** The single option id stored in a response value ({value}, {choiceId}, plain string); '' when none. */
export function extractChoice(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && !Array.isArray(value)) {
    const v = value.value ?? value.choiceId ?? value.selectedOption ?? value.answerPayload?.value ?? value.textResponse;
    return typeof v === 'string' ? v.trim() : '';
  }
  return '';
}

/** Distinct selected ids across the set members, in option order. */
export function selectedFromResponses(values: any[], order: string[]): string[] {
  const picked = new Set(values.map(extractChoice).filter((v) => v.length > 0));
  return order.filter((id) => picked.has(id));
}

/**
 * Toggles one option in a choose-N selection. Never exceeds `count`, never duplicates; selecting beyond the limit is
 * refused (the learner deselects first) — returns the unchanged selection and `rejected: true`.
 */
export function toggleChooseN(selected: string[], optionId: string, count: number): { selected: string[]; rejected: boolean } {
  const unique = Array.from(new Set(selected));
  if (unique.includes(optionId)) return { selected: unique.filter((id) => id !== optionId), rejected: false };
  if (unique.length >= count) return { selected: unique, rejected: true };
  return { selected: [...unique, optionId], rejected: false };
}

/** Stored value per member (question order): selected ids sorted by option order, '' for unfilled members. */
export function distributeSelection(selected: string[], order: string[], memberCount: number): string[] {
  const sorted = order.filter((id) => selected.includes(id));
  const out: string[] = [];
  for (let i = 0; i < memberCount; i++) out.push(sorted[i] || '');
  return out;
}

export function wordLimitLabel(limit: number | null | undefined, rule: string | null | undefined, lang: 'vi' | 'en'): string | null {
  if (!limit || limit <= 0) return null;
  const allowsNumber = /NUMBER|AND\/OR/i.test(rule || '');
  if (lang === 'vi') {
    return `Tối đa ${limit} từ cho mỗi câu trả lời${allowsNumber ? ' (có thể kèm một con số)' : ''}`;
  }
  return `No more than ${limit} word${limit > 1 ? 's' : ''} per answer${allowsNumber ? ' (a number may be added)' : ''}`;
}

export interface StimulusDocument {
  label: string;
  paragraphs: string[];
}

/**
 * MULTI_DOC presentation: separate documents (in source order) only when the package proved the boundaries;
 * `segmented: false` keeps the text as one block with an explicit "boundaries under review" notice.
 */
export function stimulusDocuments(kind: string | null | undefined, body: any): { segmented: boolean; declaredCount: number; documents: StimulusDocument[] } {
  const docs = Array.isArray(body?.documents) ? body.documents : [];
  const isMulti = String(kind || '').toUpperCase() === 'MULTI_DOC';
  if (isMulti && body?.documentBoundaries === 'SEGMENTED' && docs.length >= 2) {
    return {
      segmented: true,
      declaredCount: docs.length,
      documents: docs.map((d: any, i: number) => ({
        label: String(d?.declaredType || d?.title || `Document ${i + 1}`),
        paragraphs: (Array.isArray(d?.paragraphs) ? d.paragraphs : [])
          .map((p: any) => String(p?.text ?? p ?? '').trim())
          .filter((p: string) => p.length > 0),
      })),
    };
  }
  return { segmented: false, declaredCount: docs.length, documents: [] };
}
