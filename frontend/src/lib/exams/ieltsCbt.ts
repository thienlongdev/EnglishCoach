/**
 * IELTS computer-delivered exam room (2026-11-13) — pure model of the CBT shell. No React, no imports, no I/O: executed
 * directly by scripts/test-ielts-cbt.mjs (types stripped). The visual reference is the REA research dataset
 * (`C:\REA\research\ielts-cbt-ui`, British Council / IDP familiarisation tests); when its summary and its raw evidence
 * disagree the raw evidence wins (docs/ielts-exam/KNOWN_DIFFERENCES.md).
 *
 * Truthfulness rules encoded here:
 *  - question numbers are the PRINTED numbers the shell already computed (canonical `questionNumber`);
 *  - a "Choose TWO" pair (`presentation.selection`) is ONE footer button "18–19", attempted only when every member is
 *    answered (observed: research 07 §2.3);
 *  - banner copy is fixed interface wording + numbers / minutes / words that come from the exam data; a value the data
 *    does not carry is omitted, never invented;
 *  - highlights are text-offset anchors per text block (never DOM surgery), merged when they overlap.
 */

export type CbtSkill = 'READING' | 'LISTENING' | 'WRITING';

// ─── Layout ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Splitter limits [MEASURED] in the raw evidence (observation-log, interaction-matrix): 20 % – 80 % of the workspace. */
export const CBT_SPLIT_MIN = 20;
export const CBT_SPLIT_MAX = 80;
export const CBT_SPLIT_DEFAULT = 50;
/** Keyboard step of the separator (arrow keys); Home / End jump to the limits. */
export const CBT_SPLIT_STEP = 5;

export function clampSplit(percent: number): number {
  if (!Number.isFinite(percent)) return CBT_SPLIT_DEFAULT;
  return Math.min(CBT_SPLIT_MAX, Math.max(CBT_SPLIT_MIN, percent));
}

/** Percentage of the left column for a pointer at `clientX` inside a workspace starting at `left` with `width`. */
export function splitFromPointer(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return CBT_SPLIT_DEFAULT;
  return clampSplit(((clientX - left) / width) * 100);
}

// ─── Answers ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Same rule as runnerModel.isAnswered: a real answer value exists (a flag alone is not an answer). */
export function cbtAnswered(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return true;
  if (Array.isArray(value)) return value.some((v) => cbtAnswered(v));
  if (typeof value === 'object') {
    if (value.recordingId) return true;
    const candidates = [value.value, value.choiceId, value.selectedOption, value.textResponse, value.text, value.answerPayload];
    return candidates.some((c) => c !== value && cbtAnswered(c));
  }
  return false;
}

/** Text of a stored text answer ('' when none). */
export function cbtText(value: any): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value.textResponse ?? value.answerPayload?.value ?? value.answerPayload?.text ?? value.text ?? value.value ?? '';
    return typeof v === 'string' ? v : '';
  }
  return '';
}

/** The single option id stored in a choice answer ('' when none). */
export function cbtChoice(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && !Array.isArray(value)) {
    const v = value.value ?? value.choiceId ?? value.selectedOption ?? value.answerPayload?.value ?? value.answerPayload?.choiceId ?? value.textResponse;
    return typeof v === 'string' ? v.trim() : '';
  }
  return '';
}

/**
 * Word counter of the CBT Writing editor. Raw evidence (writing-editor-info.json): whitespace-separated tokens —
 * "Hello world, this is a test." = 6, "Hyphenated-word test" = 2, "Line1\n\nLine2\nLine3" = 3.
 */
export function cbtWordCount(text: string | null | undefined): number {
  const t = String(text ?? '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

// ─── Options ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CbtOption {
  id: string;
  text: string;
}

/** Options in printed order from the canonical payload only; nothing is invented for an item without options. */
export function cbtOptions(item: { optionDefinitions?: any; options?: any } | null | undefined): CbtOption[] {
  const defs = (item && (item.optionDefinitions || item.options)) || null;
  const list: any[] = Array.isArray(defs)
    ? defs
    : defs && typeof defs === 'object'
    ? defs.options || defs.choices || defs.items || defs.values || []
    : [];
  const out: CbtOption[] = [];
  for (const o of list) {
    if (o === null || o === undefined) continue;
    if (typeof o === 'string' || typeof o === 'number') {
      out.push({ id: String(o), text: String(o) });
      continue;
    }
    const id = o.id ?? o.key ?? o.label;
    if (id === null || id === undefined || String(id).trim() === '') continue;
    out.push({ id: String(id), text: String(o.text ?? o.label ?? o.content ?? o.value ?? o.body ?? '').trim() });
  }
  return out;
}

/** Display text of an option without a duplicated leading key ("A. text" ⇒ "text"); the key itself when empty. */
export function cbtOptionText(option: CbtOption): string {
  const text = option.text.trim();
  if (!text) return option.id;
  const escaped = option.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cleaned = text.replace(new RegExp(`^\\(?${escaped}\\)?[:.\\-\\s]+`, 'i'), '').trim();
  return cleaned || text;
}

/** True when the options are the closed TRUE / FALSE / NOT GIVEN or YES / NO / NOT GIVEN set (shown without letters). */
export function isClosedTruthSet(options: CbtOption[]): boolean {
  const ids = options.map((o) => (o.text || o.id).trim().toUpperCase());
  if (ids.length !== 3) return false;
  const set = ids.join('|');
  return set === 'TRUE|FALSE|NOT GIVEN' || set === 'YES|NO|NOT GIVEN';
}

/** Strips a duplicated printed prefix from a prompt ("Question 3:", "3.", "[Question 3]"). */
export function cbtPrompt(prompt: string | null | undefined): string {
  return String(prompt ?? '')
    .replace(/^Question\s*\d+\s*:\s*/i, '')
    .replace(/\[Question\s*\d+\]/gi, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
}

// ─── Parts, footer buttons, banner ──────────────────────────────────────────────────────────────────────────────

export interface CbtItemLike {
  placementId: string;
  optionDefinitions?: any;
  options?: any;
}

export interface CbtGroupLike {
  id: string;
  items?: CbtItemLike[];
  presentation?: { selection?: { count: number; questions: number[] } | null } | null;
}

export interface CbtPartLike {
  id?: string;
  partCode?: string;
  groups?: CbtGroupLike[];
}

export interface CbtQuestionButton {
  /** First placement of the button (the one a click selects). */
  key: string;
  placementIds: string[];
  numbers: number[];
  /** "7" or "18–19". */
  label: string;
  attempted: boolean;
}

export interface CbtPartModel {
  index: number;
  /** Printed part number (code number, else position). */
  number: number;
  buttons: CbtQuestionButton[];
  /** Questions counted the way the footer counts them ("0 of 13": a pair counts as two questions). */
  total: number;
  attempted: number;
  firstNumber: number | null;
  lastNumber: number | null;
}

function partNumberFromCode(code: string | null | undefined, index: number): number {
  const m = /(\d+)\s*$/.exec(code || '');
  return m ? Number(m[1]) : index + 1;
}

export function numberLabel(numbers: number[]): string {
  const valid = numbers.filter((n) => Number.isFinite(n));
  if (valid.length === 0) return '';
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return min === max ? `${min}` : `${min}–${max}`;
}

/**
 * Footer model of a section: one entry per part, one button per printed question, and ONE button for a choose-N set
 * whose members are exactly the group's `presentation.selection.questions`.
 */
export function buildCbtParts(
  parts: CbtPartLike[],
  numbers: Map<string, number>,
  responses: Record<string, any>
): CbtPartModel[] {
  return (parts || []).map((part, index) => {
    const buttons: CbtQuestionButton[] = [];
    for (const group of part.groups || []) {
      const items = group.items || [];
      const sel = group.presentation?.selection;
      const wanted = sel && sel.count > 1 ? new Set(sel.questions || []) : null;
      const members = wanted ? items.filter((it) => wanted.has(numbers.get(it.placementId) ?? -1)) : [];
      const grouped = wanted && members.length === sel!.count ? new Set(members.map((m) => m.placementId)) : null;
      let groupButtonDone = false;
      for (const it of items) {
        if (grouped && grouped.has(it.placementId)) {
          if (groupButtonDone) continue;
          groupButtonDone = true;
          const nums = members.map((m) => numbers.get(m.placementId) ?? 0).sort((a, b) => a - b);
          buttons.push({
            key: members[0].placementId,
            placementIds: members.map((m) => m.placementId),
            numbers: nums,
            label: numberLabel(nums),
            attempted: members.every((m) => cbtAnswered(responses?.[m.placementId])),
          });
          continue;
        }
        const n = numbers.get(it.placementId) ?? 0;
        buttons.push({
          key: it.placementId,
          placementIds: [it.placementId],
          numbers: [n],
          label: String(n),
          attempted: cbtAnswered(responses?.[it.placementId]),
        });
      }
    }
    const allNumbers = buttons.flatMap((b) => b.numbers).filter((n) => n > 0);
    return {
      index,
      number: partNumberFromCode(part.partCode, index),
      buttons,
      total: buttons.reduce((acc, b) => acc + b.placementIds.length, 0),
      attempted: buttons.reduce((acc, b) => acc + (b.attempted ? b.placementIds.length : 0), 0),
      firstNumber: allNumbers.length ? Math.min(...allNumbers) : null,
      lastNumber: allNumbers.length ? Math.max(...allNumbers) : null,
    };
  });
}

/** Index of the part holding a placement (-1 when none). */
export function partIndexOf(model: CbtPartModel[], placementId: string | null | undefined): number {
  if (!placementId) return -1;
  return model.findIndex((p) => p.buttons.some((b) => b.placementIds.includes(placementId)));
}

/** Flat button list across parts, for Prev / Next (the reference moves across parts with the same buttons). */
export function flatButtons(model: CbtPartModel[]): Array<{ part: number; button: CbtQuestionButton }> {
  return model.flatMap((p) => p.buttons.map((button) => ({ part: p.index, button })));
}

/**
 * Banner line under "Part n" (fixed interface wording observed in the reference, numbers from the data):
 *  Reading  "Read the text and answer questions 1–13."
 *  Listening "Listen and answer questions 1–10."
 *  Writing  "You should spend about 20 minutes on this task. Write at least 150 words." (each sentence only when the
 *           item carries that number).
 */
export function bannerInstruction(
  skill: CbtSkill,
  part: { firstNumber: number | null; lastNumber: number | null },
  writing?: { recommendedMinutes?: number | null; minimumWords?: number | null }
): string {
  if (skill === 'WRITING') {
    const out: string[] = [];
    if (writing?.recommendedMinutes) out.push(`You should spend about ${writing.recommendedMinutes} minutes on this task.`);
    if (writing?.minimumWords) out.push(`Write at least ${writing.minimumWords} words.`);
    return out.join(' ');
  }
  if (part.firstNumber === null || part.lastNumber === null) return '';
  const range = part.firstNumber === part.lastNumber ? `question ${part.firstNumber}` : `questions ${part.firstNumber}–${part.lastNumber}`;
  return skill === 'LISTENING' ? `Listen and answer ${range}.` : `Read the text and answer ${range}.`;
}

/** "Questions 1–6" heading of a question group ("Question 7" for one). */
export function groupHeading(numbers: number[], printed?: string | null): string {
  const label = printed && /\d/.test(printed) ? printed.replace(/\s*-\s*/g, '–') : numberLabel(numbers);
  if (!label) return '';
  return label.includes('–') ? `Questions ${label}` : `Question ${label}`;
}

// ─── Timer ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** "59 minutes remaining" / "1 minute remaining" / "45 seconds remaining" (server-derived seconds). */
export function timerLabel(remainingSeconds: number): string {
  const s = Math.max(0, Math.floor(remainingSeconds || 0));
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return `${m} minute${m === 1 ? '' : 's'} remaining`;
  }
  return `${s} second${s === 1 ? '' : 's'} remaining`;
}

// ─── Highlights and notes ───────────────────────────────────────────────────────────────────────────────────────

export interface CbtHighlight {
  id: string;
  /** Text block key (stimulus id + paragraph index). */
  block: string;
  start: number;
  end: number;
  /** Excerpt shown on the note card. */
  excerpt?: string;
  /** Present when the highlight carries a note ("Note" action). */
  note?: string | null;
  /** Part number shown on the note card ("Part 1"). */
  part?: number;
  createdAt?: number;
}

export interface CbtRange {
  block: string;
  start: number;
  end: number;
}

/**
 * Adds a highlight over `ranges` (one per text block of the selection). Plain highlights overlapping the new range in the
 * same block are absorbed (merged) so the passage never shows nested marks; note-carrying highlights are kept.
 */
export function addHighlight(list: CbtHighlight[], ranges: CbtRange[], meta: Omit<CbtHighlight, 'block' | 'start' | 'end'>): CbtHighlight[] {
  let next = list.slice();
  const valid = ranges.filter((r) => r.block && r.end > r.start);
  valid.forEach((r, i) => {
    let start = r.start;
    let end = r.end;
    if (!meta.note && meta.note !== '') {
      const absorbed = next.filter((h) => h.block === r.block && h.note == null && h.start <= end && h.end >= start);
      for (const h of absorbed) {
        start = Math.min(start, h.start);
        end = Math.max(end, h.end);
      }
      next = next.filter((h) => !absorbed.includes(h));
    }
    next.push({ ...meta, id: valid.length > 1 ? `${meta.id}:${i}` : meta.id, block: r.block, start, end });
  });
  return next.sort((a, b) => (a.block === b.block ? a.start - b.start : a.block < b.block ? -1 : 1));
}

/** Removes a highlight (and every piece of a multi-block highlight sharing its base id). */
export function removeHighlight(list: CbtHighlight[], id: string): CbtHighlight[] {
  const base = id.split(':')[0];
  return list.filter((h) => h.id.split(':')[0] !== base);
}

export function setNote(list: CbtHighlight[], id: string, note: string): CbtHighlight[] {
  const base = id.split(':')[0];
  return list.map((h) => (h.id.split(':')[0] === base ? { ...h, note } : h));
}

export interface TextSegment {
  text: string;
  highlightId: string | null;
  hasNote: boolean;
}

/** Splits a block's text into plain and highlighted segments (ranges clamped to the text, overlaps resolved left-first). */
export function segmentText(text: string, highlights: CbtHighlight[]): TextSegment[] {
  const len = text.length;
  const ranges = highlights
    .map((h) => ({ id: h.id, hasNote: h.note != null, start: Math.max(0, Math.min(len, h.start)), end: Math.max(0, Math.min(len, h.end)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: TextSegment[] = [];
  let pos = 0;
  for (const r of ranges) {
    const start = Math.max(r.start, pos);
    if (start >= r.end) continue;
    if (start > pos) out.push({ text: text.slice(pos, start), highlightId: null, hasNote: false });
    out.push({ text: text.slice(start, r.end), highlightId: r.id, hasNote: r.hasNote });
    pos = r.end;
  }
  if (pos < len) out.push({ text: text.slice(pos), highlightId: null, hasNote: false });
  if (out.length === 0) out.push({ text, highlightId: null, hasNote: false });
  return out;
}

/** Storage key of an attempt's annotations (local to the device; cleared at sign-out with the rest of localStorage). */
export function annotationStorageKey(attemptId: string): string {
  return `ec_ielts_cbt_annot:v1:${attemptId}`;
}

export function parseAnnotations(raw: string | null | undefined): CbtHighlight[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    const list = Array.isArray(data?.highlights) ? data.highlights : [];
    return list.filter(
      (h: any) =>
        h && typeof h.id === 'string' && typeof h.block === 'string' && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start
    );
  } catch {
    return [];
  }
}

export function serializeAnnotations(list: CbtHighlight[]): string {
  return JSON.stringify({ version: 1, highlights: list });
}

// ─── Review screen ──────────────────────────────────────────────────────────────────────────────────────────────

/** "Part 1. 0 of 13 questions attempted." — the review (deliver) page's accessible part line (submission-page-info). */
export function reviewPartLine(part: CbtPartModel): string {
  return `Part ${part.number}. ${part.attempted} of ${part.total} questions attempted.`;
}
