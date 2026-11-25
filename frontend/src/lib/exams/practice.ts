/**
 * Exams Phase 6 — pure Practice + Review presentation helpers (no React, no network), shared by the scope picker,
 * the runtime header and the result / review page, and executed by scripts/check-exams-practice-contract.mjs.
 *
 * Learner copy is Vietnamese-first; internal readiness reason codes never reach these helpers (the API only sends
 * an availability state). Partial practice shows raw metrics only — never a TOEIC scaled score or an IELTS band.
 */

export type PracticeLang = 'vi' | 'en';

export interface PracticeScopeLike {
  scopeType: string;
  number: number;
  skill?: string;
}

/**
 * "TOEIC Part 5", "IELTS Listening – Section 2", "IELTS Reading – Passage 1", "IELTS Writing – Task 1".
 * Exams Phase 7: the official exam terms (Part / Section / Passage / Task) are kept in both languages.
 */
export function practiceScopeLabel(scope: PracticeScopeLike, lang: PracticeLang = 'vi'): string {
  const n = scope.number;
  switch (scope.scopeType) {
    case 'TOEIC_PART':
      return `TOEIC Part ${n}`;
    case 'IELTS_LISTENING_SECTION':
      return `IELTS Listening – Section ${n}`;
    case 'IELTS_READING_PASSAGE':
      return `IELTS Reading – Passage ${n}`;
    case 'IELTS_WRITING_TASK':
      return `IELTS Writing – Task ${n}`;
    case 'IELTS_SPEAKING_PART':
      return `IELTS Speaking – Part ${n}`;
    default:
      return lang === 'vi' ? 'Phần luyện tập' : 'Practice scope';
  }
}

/** Short learner description of what a TOEIC part / IELTS scope contains. */
export function practiceScopeHint(scope: PracticeScopeLike, lang: PracticeLang = 'vi'): string {
  if (scope.scopeType === 'TOEIC_PART') {
    const vi: Record<number, string> = {
      1: 'Mô tả tranh', 2: 'Hỏi – đáp', 3: 'Đoạn hội thoại', 4: 'Bài nói ngắn',
      5: 'Hoàn thành câu', 6: 'Hoàn thành đoạn văn', 7: 'Đọc hiểu (đơn / kép / ba văn bản)',
    };
    const en: Record<number, string> = {
      1: 'Photographs', 2: 'Question–response', 3: 'Conversations', 4: 'Talks',
      5: 'Incomplete sentences', 6: 'Text completion', 7: 'Reading (single / double / triple passages)',
    };
    return (lang === 'vi' ? vi : en)[scope.number] || '';
  }
  if (scope.scopeType === 'IELTS_WRITING_TASK') {
    return lang === 'vi' ? 'Bài viết được lưu lại, chưa chấm điểm' : 'Your response is saved, not scored';
  }
  if (scope.scopeType === 'IELTS_SPEAKING_PART') {
    return lang === 'vi' ? 'Ghi âm được lưu lại, không có band IELTS chính thức' : 'Recordings are saved, without an official IELTS band';
  }
  return '';
}

/** Natural learner state for an availability code (never a technical blocker code). */
export function practiceAvailabilityLabel(availability: string, lang: PracticeLang = 'vi'): string {
  if (availability === 'AVAILABLE') return lang === 'vi' ? 'Có thể luyện' : 'Ready to practise';
  if (availability === 'CONTENT_IN_PROGRESS') return lang === 'vi' ? 'Đang hoàn thiện nội dung' : 'Content in progress';
  return lang === 'vi' ? 'Chưa khả dụng' : 'Not available yet';
}

/** Only an AVAILABLE scope gets a start control (no dead buttons). */
export function canStartPractice(availability: string): boolean {
  return availability === 'AVAILABLE';
}

export function reviewStatusLabel(status: string, lang: PracticeLang = 'vi'): string {
  switch (status) {
    case 'CORRECT':
      return lang === 'vi' ? 'Đúng' : 'Correct';
    case 'INCORRECT':
      return lang === 'vi' ? 'Sai' : 'Incorrect';
    case 'UNANSWERED':
      return lang === 'vi' ? 'Chưa trả lời' : 'Unanswered';
    default:
      return lang === 'vi' ? 'Không chấm điểm' : 'Not scored';
  }
}

/** "18 / 30 câu đúng · 60%" — raw metrics only. */
export function rawScoreLine(correct: number | undefined, total: number | undefined, accuracy: number | undefined,
                             lang: PracticeLang = 'vi'): string {
  if (typeof correct !== 'number' || typeof total !== 'number') return '';
  const pct = typeof accuracy === 'number' ? ` · ${accuracy}%` : '';
  return lang === 'vi' ? `${correct} / ${total} câu đúng${pct}` : `${correct} / ${total} correct${pct}`;
}

/** Display form of a stored answer (option id, text, or a choose-N list). */
export function formatAnswer(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined && String(v) !== '').join(', ');
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return formatAnswer(v.value ?? v.choiceId ?? v.text ?? '');
  }
  return String(value);
}

export function formatDuration(seconds: number | undefined, lang: PracticeLang = 'vi'): string {
  if (typeof seconds !== 'number' || seconds < 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return lang === 'vi' ? `${m} phút ${s} giây` : `${m} min ${s} s`;
}

const PRACTICE_SCOPE_TYPES = ['TOEIC_PART', 'IELTS_LISTENING_SECTION', 'IELTS_READING_PASSAGE', 'IELTS_WRITING_TASK', 'IELTS_SPEAKING_PART'];

/** A history row of a practice-scoped attempt (its scope column carries the scope type). */
export function isPracticeScopeAttempt(item: { mode?: string; scope?: string }): boolean {
  return item.mode === 'PRACTICE' && PRACTICE_SCOPE_TYPES.includes(String(item.scope || ''));
}

/** Route of the practice result / review page for an attempt. */
export function practiceResultPath(family: string, attemptId: string): string {
  return `/exams/${family.toLowerCase()}/practice/result/${attemptId}`;
}
