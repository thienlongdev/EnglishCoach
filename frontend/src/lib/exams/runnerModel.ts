/**
 * Exams Phase 7 — pure learner-UX model shared by the library, the runner chrome (header, navigator, submit dialog),
 * the result / review page and history. No React, no imports, no network: executed directly by
 * scripts/check-exams-phase7-ux-contract.mjs (types stripped).
 *
 * Truthfulness rules encoded here:
 *  - question numbers are the PRINTED numbers carried by the canonical item (`optionDefinitions.questionNumber`);
 *    a sequential fallback is used only for legacy payloads without printed numbers;
 *  - "answered" means a real answer value exists (an object carrying only a flag is NOT an answer);
 *  - save status labels never claim "Đã lưu" before the server acknowledged the batch (status comes from the hook);
 *  - learner copy never shows internal codes (status / scope / variant codes are mapped, unknown ⇒ neutral text).
 */

export type UxLang = 'vi' | 'en';

// ─── Question numbering ──────────────────────────────────────────────────────────────────────────────────────────

export interface NumberedItemLike {
  placementId: string;
  optionDefinitions?: any;
  options?: any;
}

/** Printed question number of an item (optionDefinitions.questionNumber), else null. */
export function printedQuestionNumber(item: NumberedItemLike | null | undefined): number | null {
  const defs = (item && (item.optionDefinitions || item.options)) || null;
  const n = defs && !Array.isArray(defs) ? Number(defs.questionNumber) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * placementId → displayed number. Printed numbers win; an item without one continues from the previous number
 * (legacy payloads start at `fallbackStart`: TOEIC Reading legacy forms print 101–200).
 */
export function buildQuestionNumbers(
  parts: Array<{ groups?: Array<{ items?: NumberedItemLike[] }> }>,
  fallbackStart: number = 1
): Map<string, number> {
  const map = new Map<string, number>();
  let next = fallbackStart;
  for (const part of parts || []) {
    for (const group of part.groups || []) {
      for (const item of group.items || []) {
        const printed = printedQuestionNumber(item);
        const n = printed ?? next;
        map.set(item.placementId, n);
        next = n + 1;
      }
    }
  }
  return map;
}

/** "101–104" / "7" / '' for a list of numbers (printed order kept). */
export function numberRange(numbers: number[]): string {
  const valid = numbers.filter((n) => Number.isFinite(n));
  if (valid.length === 0) return '';
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return min === max ? `${min}` : `${min}–${max}`;
}

// ─── Answers ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** True only when a real answer value exists (choice id, text, choose-N list or recording). */
export function isAnswered(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return true;
  if (Array.isArray(value)) return value.some((v) => isAnswered(v));
  if (typeof value === 'object') {
    if (value.recordingId) return true;
    const candidates = [value.value, value.choiceId, value.selectedOption, value.textResponse, value.text, value.answerPayload];
    return candidates.some((c) => c !== value && isAnswered(c));
  }
  return false;
}

export interface ChoiceOption {
  /** Canonical option id — the value stored as the answer (never the display label). */
  id: string;
  text: string;
}

/**
 * Options of an item in printed order, from the canonical payload only. No placeholder options are ever invented:
 * an item without options returns [] (TOEIC Part 2 keeps exactly its three printed options).
 */
export function itemOptions(item: { optionDefinitions?: any; options?: any } | null | undefined): ChoiceOption[] {
  const defs = (item && (item.optionDefinitions || item.options)) || null;
  const list: any[] = Array.isArray(defs)
    ? defs
    : defs && typeof defs === 'object'
    ? defs.options || defs.choices || defs.items || defs.values || []
    : [];
  const out: ChoiceOption[] = [];
  for (const o of list) {
    if (o === null || o === undefined) continue;
    if (typeof o === 'string' || typeof o === 'number') {
      out.push({ id: String(o), text: '' });
      continue;
    }
    const id = o.id ?? o.key ?? o.label;
    if (id === null || id === undefined || String(id).trim() === '') continue;
    out.push({ id: String(id), text: String(o.text ?? o.label ?? o.content ?? o.value ?? o.body ?? '').trim() });
  }
  return out;
}

/** The single option id stored in a response value ({value}, {choiceId}, plain string); '' when none. */
export function selectedChoice(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && !Array.isArray(value)) {
    const v = value.value ?? value.choiceId ?? value.selectedOption ?? value.answerPayload?.value;
    return typeof v === 'string' ? v.trim() : '';
  }
  return '';
}

// ─── Parts / navigator ───────────────────────────────────────────────────────────────────────────────────────────

/** Printed part number from a part code ("READING_PART_7" → 7); null when the code has none. */
export function partNumberOf(partCode: string | null | undefined): number | null {
  const m = /(\d+)\s*$/.exec(partCode || '');
  return m ? Number(m[1]) : null;
}

const TOEIC_PART_NAMES: Record<number, { vi: string; en: string }> = {
  1: { vi: 'Mô tả tranh', en: 'Photographs' },
  2: { vi: 'Hỏi – đáp', en: 'Question–Response' },
  3: { vi: 'Đoạn hội thoại', en: 'Conversations' },
  4: { vi: 'Bài nói ngắn', en: 'Talks' },
  5: { vi: 'Hoàn thành câu', en: 'Incomplete Sentences' },
  6: { vi: 'Hoàn thành đoạn văn', en: 'Text Completion' },
  7: { vi: 'Đọc hiểu', en: 'Reading Comprehension' },
};

/** Learner name of a TOEIC part ("Hoàn thành câu"); '' when unknown. */
export function toeicPartName(partNumber: number | null | undefined, lang: UxLang = 'vi'): string {
  const entry = partNumber ? TOEIC_PART_NAMES[partNumber] : undefined;
  return entry ? entry[lang] : '';
}

/** English exam term of a TOEIC part ("Incomplete Sentences") — shown as a small secondary label. */
export function toeicPartTerm(partNumber: number | null | undefined): string {
  const entry = partNumber ? TOEIC_PART_NAMES[partNumber] : undefined;
  return entry ? entry.en : '';
}

/**
 * Official short label of a part inside a section: TOEIC "Part 5", IELTS Listening "Section 2",
 * IELTS Reading "Passage 1", IELTS Writing "Task 2". `index` (0-based) is used only when the code carries no number.
 */
export function partShortLabel(family: string, skill: string, partCode: string | null | undefined, index: number): string {
  const n = partNumberOf(partCode) ?? index + 1;
  const fam = String(family || '').toUpperCase();
  const sk = String(skill || '').toUpperCase();
  if (fam === 'IELTS') {
    if (sk === 'LISTENING') return `Section ${n}`;
    if (sk === 'READING') return `Passage ${n}`;
    if (sk === 'WRITING') return `Task ${n}`;
  }
  return `Part ${n}`;
}

export interface NavigatorEntry {
  placementId: string;
  number: number;
  groupId: string;
  answered: boolean;
  flagged: boolean;
  current: boolean;
}

export interface NavigatorGroup {
  groupId: string;
  range: string;
  entries: NavigatorEntry[];
}

export interface NavigatorPart {
  key: string;
  label: string;
  groups: NavigatorGroup[];
  answered: number;
  total: number;
}

export interface NavigatorInput {
  family: string;
  skill: string;
  parts: Array<{ id?: string; partCode?: string; groups?: Array<{ id: string; items?: NumberedItemLike[] }> }>;
  numbers: Map<string, number>;
  responses: Record<string, any>;
  flagged: Iterable<string>;
  currentPlacementId?: string | null;
}

/** Navigator model: parts → printed groups → items, preserving group context (a set stays one block). */
export function buildNavigator(input: NavigatorInput): NavigatorPart[] {
  const flaggedSet = new Set(Array.from(input.flagged || []));
  return (input.parts || []).map((part, pIdx) => {
    let answered = 0;
    let total = 0;
    const groups: NavigatorGroup[] = (part.groups || []).map((g) => {
      const entries: NavigatorEntry[] = (g.items || []).map((it) => {
        const isAns = isAnswered(input.responses ? input.responses[it.placementId] : undefined);
        total += 1;
        if (isAns) answered += 1;
        return {
          placementId: it.placementId,
          number: input.numbers.get(it.placementId) ?? 0,
          groupId: g.id,
          answered: isAns,
          flagged: flaggedSet.has(it.placementId),
          current: input.currentPlacementId === it.placementId,
        };
      });
      return { groupId: g.id, range: numberRange(entries.map((e) => e.number)), entries };
    });
    return {
      key: part.id || `part-${pIdx}`,
      label: partShortLabel(input.family, input.skill, part.partCode, pIdx),
      groups,
      answered,
      total,
    };
  });
}

export interface AnswerSummary {
  total: number;
  answered: number;
  unanswered: number;
  flagged: number;
  /** Printed numbers still unanswered, in order (for the submit dialog). */
  unansweredNumbers: number[];
}

export function summarizeNavigator(parts: NavigatorPart[]): AnswerSummary {
  const entries = parts.flatMap((p) => p.groups.flatMap((g) => g.entries));
  const unanswered = entries.filter((e) => !e.answered);
  return {
    total: entries.length,
    answered: entries.length - unanswered.length,
    unanswered: unanswered.length,
    flagged: entries.filter((e) => e.flagged).length,
    unansweredNumbers: unanswered.map((e) => e.number).sort((a, b) => a - b),
  };
}

/** "3, 5, 7–9" — compact list of question numbers. */
export function compactNumberList(numbers: number[], max: number = 12): string {
  const sorted = Array.from(new Set(numbers.filter((n) => Number.isFinite(n)))).sort((a, b) => a - b);
  const ranges: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    ranges.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  if (ranges.length <= max) return ranges.join(', ');
  return `${ranges.slice(0, max).join(', ')}, …`;
}

// ─── Modes ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type RunnerMode = 'SIMULATION' | 'PRACTICE' | 'REVIEW';

export function runnerModeOf(attemptMode: string | null | undefined): RunnerMode {
  return attemptMode === 'EXAM_SIMULATION' ? 'SIMULATION' : 'PRACTICE';
}

/** Chip label of a mode. Simulation and practice must never read alike. */
export function modeLabel(mode: RunnerMode, lang: UxLang = 'vi', scoped: boolean = false): string {
  if (mode === 'SIMULATION') return lang === 'vi' ? 'Thi đầy đủ' : 'Full simulation';
  if (mode === 'REVIEW') return lang === 'vi' ? 'Xem lại bài' : 'Review';
  if (scoped) return lang === 'vi' ? 'Luyện theo phần' : 'Practice by part';
  return lang === 'vi' ? 'Luyện tập' : 'Practice';
}

// ─── Save status ─────────────────────────────────────────────────────────────────────────────────────────────────

export type SaveStatus = 'SAVED' | 'SAVING' | 'UNSAVED' | 'ERROR' | 'CLOSED';

export interface SaveStatusView {
  label: string;
  tone: 'ok' | 'busy' | 'pending' | 'error';
  retryable: boolean;
  hint: string;
}

/** Compact, truthful save state. 'SAVED' is shown only for a server-acknowledged batch (hook contract). */
export function saveStatusView(status: SaveStatus | string, lang: UxLang = 'vi'): SaveStatusView {
  switch (status) {
    case 'SAVED':
      return { label: lang === 'vi' ? 'Đã lưu' : 'Saved', tone: 'ok', retryable: false,
        hint: lang === 'vi' ? 'Máy chủ đã nhận câu trả lời của bạn.' : 'Your answers reached the server.' };
    case 'SAVING':
      return { label: lang === 'vi' ? 'Đang lưu…' : 'Saving…', tone: 'busy', retryable: false, hint: '' };
    case 'ERROR':
      return { label: lang === 'vi' ? 'Lỗi lưu bài' : 'Save failed', tone: 'error', retryable: true,
        hint: lang === 'vi'
          ? 'Chưa gửi được lên máy chủ. Câu trả lời vẫn được giữ trên thiết bị này.'
          : 'Not sent to the server yet. Your answers are kept on this device.' };
    case 'CLOSED':
      // Exams Phase 9: the server closed the attempt (time is up / already submitted) — retrying can never succeed.
      return { label: lang === 'vi' ? 'Bài đã đóng' : 'Attempt closed', tone: 'error', retryable: false,
        hint: lang === 'vi'
          ? 'Đã hết giờ hoặc bài đã được nộp — câu trả lời mới không còn được ghi nhận.'
          : 'Time is up or the attempt was submitted — new answers are no longer recorded.' };
    default:
      return { label: lang === 'vi' ? 'Chưa lưu' : 'Not saved yet', tone: 'pending', retryable: false,
        hint: lang === 'vi' ? 'Câu trả lời mới sẽ được lưu trong giây lát.' : 'New answers will be saved in a moment.' };
  }
}

// ─── Timer ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Calm timer: neutral, then a quiet warning under 10 min, critical under 2 min (no flashing). */
export function timerTone(remainingSeconds: number): 'normal' | 'warning' | 'critical' {
  if (remainingSeconds <= 120) return 'critical';
  if (remainingSeconds <= 600) return 'warning';
  return 'normal';
}

// ─── Attempt status / history ────────────────────────────────────────────────────────────────────────────────────

export function attemptStatusLabel(status: string | null | undefined, lang: UxLang = 'vi'): string {
  switch (status) {
    case 'CREATED':
    case 'READY':
      return lang === 'vi' ? 'Chưa bắt đầu' : 'Not started';
    case 'IN_PROGRESS':
      return lang === 'vi' ? 'Đang làm' : 'In progress';
    case 'SUBMITTED':
      return lang === 'vi' ? 'Đã nộp' : 'Submitted';
    case 'EXPIRED':
      return lang === 'vi' ? 'Hết thời gian' : 'Time expired';
    case 'INVALIDATED':
      return lang === 'vi' ? 'Đã hủy' : 'Cancelled';
    default:
      return lang === 'vi' ? 'Không rõ trạng thái' : 'Unknown status';
  }
}

export function isResumableStatus(status: string | null | undefined): boolean {
  return status === 'CREATED' || status === 'READY' || status === 'IN_PROGRESS';
}

export function isFinishedStatus(status: string | null | undefined): boolean {
  return status === 'SUBMITTED' || status === 'EXPIRED';
}

const PRACTICE_SCOPE_TYPE_LIST = ['TOEIC_PART', 'IELTS_LISTENING_SECTION', 'IELTS_READING_PASSAGE', 'IELTS_WRITING_TASK', 'IELTS_SPEAKING_PART'];

export interface HistoryLike {
  mode?: string;
  scope?: string;
  status?: string;
  family?: string;
  score?: number | null;
  practiceScopeCode?: string | null;
}

export function isScopedPractice(item: HistoryLike): boolean {
  return item.mode === 'PRACTICE' && PRACTICE_SCOPE_TYPE_LIST.includes(String(item.scope || ''));
}

/** Short scope label from a server scope code: "Part 5", "Listening · Section 2", … ; null when unknown. */
export function scopeLabelFromCode(code: string | null | undefined, lang: UxLang = 'vi'): string | null {
  const c = String(code || '').toUpperCase();
  let m = /^TOEIC_PART_(\d+)$/.exec(c);
  if (m) {
    const name = toeicPartName(Number(m[1]), lang);
    return name ? `Part ${m[1]} · ${name}` : `Part ${m[1]}`;
  }
  m = /^IELTS_LISTENING_SECTION_(\d+)$/.exec(c);
  if (m) return `Listening · Section ${m[1]}`;
  m = /^IELTS_READING_PASSAGE_(\d+)$/.exec(c);
  if (m) return `Reading · Passage ${m[1]}`;
  m = /^IELTS_WRITING_TASK_(\d+)$/.exec(c);
  if (m) return `Writing · Task ${m[1]}`;
  m = /^IELTS_SPEAKING_PART_([123])$/.exec(c);
  if (m) return `Speaking · Part ${m[1]}`;
  return null;
}

/** Mode label of a history row. */
export function historyModeLabel(item: HistoryLike, lang: UxLang = 'vi'): string {
  if (item.mode === 'EXAM_SIMULATION') return modeLabel('SIMULATION', lang);
  return modeLabel('PRACTICE', lang, isScopedPractice(item));
}

/**
 * Result summary of a history row. Only a SIMULATION's canonical overall component (TOEIC LR total / IELTS overall
 * band, as stored by the scorer) is ever shown as a score; practice rows never show a standardized number.
 */
export function historyScoreText(item: HistoryLike, lang: UxLang = 'vi'): string | null {
  if (item.mode !== 'EXAM_SIMULATION' || item.status !== 'SUBMITTED') return null;
  if (typeof item.score !== 'number' || !Number.isFinite(item.score)) return null;
  if (String(item.family).toUpperCase() === 'IELTS') return `Band ${item.score.toFixed(1)}`;
  return lang === 'vi' ? `${Math.round(item.score)} điểm` : `${Math.round(item.score)} points`;
}

// ─── Skills ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function skillLabel(skill: string | null | undefined, lang: UxLang = 'vi'): string {
  switch (String(skill || '').toUpperCase()) {
    case 'LISTENING':
      return lang === 'vi' ? 'Nghe' : 'Listening';
    case 'READING':
      return lang === 'vi' ? 'Đọc' : 'Reading';
    case 'WRITING':
      return lang === 'vi' ? 'Viết' : 'Writing';
    case 'SPEAKING':
      return lang === 'vi' ? 'Nói' : 'Speaking';
    default:
      return lang === 'vi' ? 'Kỹ năng khác' : 'Other';
  }
}

/** "Listening · Reading" from server skill codes (order kept, duplicates dropped, unknown codes dropped). */
export function skillList(skills: string[] | null | undefined): string {
  const known = ['LISTENING', 'READING', 'WRITING', 'SPEAKING'];
  const names: Record<string, string> = { LISTENING: 'Listening', READING: 'Reading', WRITING: 'Writing', SPEAKING: 'Speaking' };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of skills || []) {
    const u = String(s || '').toUpperCase();
    if (known.includes(u) && !seen.has(u)) {
      seen.add(u);
      out.push(names[u]);
    }
  }
  return out.join(' · ');
}

/** "2 giờ 0 phút" / "45 phút" from server minutes; '' when the server gave none (never invented). */
export function durationText(minutes: number | null | undefined, lang: UxLang = 'vi'): string {
  const m = Math.floor(Number(minutes) || 0);
  if (m <= 0) return '';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (lang === 'vi') return h > 0 ? (rest > 0 ? `${h} giờ ${rest} phút` : `${h} giờ`) : `${m} phút`;
  return h > 0 ? (rest > 0 ? `${h} h ${rest} min` : `${h} h`) : `${m} min`;
}
