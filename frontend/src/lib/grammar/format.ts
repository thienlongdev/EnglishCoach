/**
 * Echo Grammar Academy: wording that every screen shares. Labels exist in Vietnamese and English; values are the server's
 * (status, outcome, mastery come from the API only, nothing here computes them). Honest wording about content status lives
 * here too, so no screen can claim a review that did not happen.
 */
import type { Level, Outcome, RoleTag, TopicStatus } from '@/types/grammar';

type Pair = { vi: string; en: string };
const pick = (p: Pair, vi: boolean) => (vi ? p.vi : p.en);

/** Class names joined, falsy values dropped. */
export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

/* ── levels ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export const LEVELS: Level[] = ['preA1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const LEVEL_TEXT: Record<Level, string> = { preA1: 'Pre-A1', A1: 'A1', A2: 'A2', B1: 'B1', B2: 'B2', C1: 'C1', C2: 'C2' };
export const levelLabel = (level: Level | string | null | undefined): string => (level ? LEVEL_TEXT[level as Level] ?? String(level) : '—');
export const levelIndex = (level: Level | string): number => LEVELS.indexOf(level as Level);

const BASIS: Record<string, Pair> = {
  EGP: { vi: 'EGP', en: 'EGP' },
  BC: { vi: 'British Council', en: 'British Council' },
  editorial: { vi: 'ước lượng biên soạn', en: 'editorial estimate' },
};
/** "Gợi ý: A2 (EGP)" or "Gợi ý: A2 (ước lượng biên soạn)": a level is a suggestion, and its basis is named. */
export function suggestedLevel(level: Level | string, basis: string | undefined, vi: boolean): string {
  const lead = vi ? 'Gợi ý' : 'Suggested';
  const b = basis ? (BASIS[basis] ? pick(BASIS[basis], vi) : basis) : '';
  return `${lead}: ${levelLabel(level)}${b ? ` (${b})` : ''}`;
}

/* ── topic states (the server's word, never inferred) ───────────────────────────────────────────────────────────────── */
const STATUS: Record<TopicStatus, Pair> = {
  OPENED: { vi: 'Đã mở', en: 'Opened' },
  STUDIED: { vi: 'Đã học', en: 'Studied' },
  PRACTISING: { vi: 'Đang luyện', en: 'Practising' },
  READY: { vi: 'Sẵn sàng kiểm tra', en: 'Ready for a check' },
  MASTERED: { vi: 'Đã nắm', en: 'Mastered' },
  REVIEW_DUE: { vi: 'Đến hạn ôn', en: 'Review due' },
  NEEDS_REVIEW: { vi: 'Cần ôn lại', en: 'Needs review' },
};
export const statusLabel = (s: TopicStatus, vi: boolean): string => pick(STATUS[s], vi);

/** A coarse tone for a status chip (drives colour AND is always paired with the word and an icon). */
export type StatusTone = 'neutral' | 'progress' | 'good' | 'due';
export function statusTone(s: TopicStatus): StatusTone {
  if (s === 'MASTERED') return 'good';
  if (s === 'REVIEW_DUE' || s === 'NEEDS_REVIEW') return 'due';
  if (s === 'PRACTISING' || s === 'READY' || s === 'STUDIED') return 'progress';
  return 'neutral';
}

/* ── editorial status: the honest line, never a claim of expert review ──────────────────────────────────────────────── */
export function editorialLabel(status: 'drafted' | 'reviewed' | string | undefined, vi: boolean): string {
  if (status === 'reviewed') return vi ? 'Đã rà soát nội bộ' : 'Reviewed internally';
  return vi ? 'Bản biên soạn, chưa qua chuyên gia độc lập duyệt' : 'Editorial draft, not yet reviewed by an independent expert';
}

/* ── exercise outcomes ──────────────────────────────────────────────────────────────────────────────────────────────── */
const OUTCOME: Record<Outcome, Pair> = {
  CORRECT: { vi: 'Đúng', en: 'Correct' },
  ACCEPTABLE: { vi: 'Chấp nhận được', en: 'Acceptable' },
  PARTIAL: { vi: 'Đúng một phần', en: 'Partly right' },
  WRONG: { vi: 'Chưa đúng', en: 'Not right' },
  UNRECOGNIZED: { vi: 'Hệ thống chưa nhận ra câu này', en: 'Not recognised by the system' },
  SELF_REVIEW: { vi: 'Tự đối chiếu', en: 'Compare yourself' },
};
export const outcomeLabel = (o: Outcome, vi: boolean): string => pick(OUTCOME[o], vi);
/** Outcomes that count as a point for the learner on a practice tally (an unrecognised answer never counts against). */
export const isRight = (o: Outcome): boolean => o === 'CORRECT' || o === 'ACCEPTABLE';

/* ── mastery of a finished check (the server's word) ────────────────────────────────────────────────────────────────── */
export type Mastery = 'MASTERED' | 'NOT_YET' | 'NEEDS_REVIEW' | 'KEPT' | 'INSUFFICIENT';
const MASTERY: Record<Mastery, Pair> = {
  MASTERED: { vi: 'Đạt: chủ đề này được ghi là đã nắm', en: 'Passed: this topic is recorded as mastered' },
  NOT_YET: { vi: 'Chưa đạt, chưa ghi nhận', en: 'Not yet, nothing recorded' },
  NEEDS_REVIEW: { vi: 'Cần ôn lại chủ đề này', en: 'This topic needs review' },
  KEPT: { vi: 'Giữ nguyên: chủ đề vẫn được ghi là đã nắm', en: 'Kept: the topic stays recorded as mastered' },
  INSUFFICIENT: { vi: 'Chưa đủ dữ liệu để kết luận', en: 'Not enough evidence to conclude' },
};
export const masteryLabel = (m: Mastery, vi: boolean): string => pick(MASTERY[m], vi);

/* ── relations between topics ───────────────────────────────────────────────────────────────────────────────────────── */
const REL: Record<string, Pair> = {
  contrast: { vi: 'Để đối chiếu', en: 'To compare with' },
  confusion: { vi: 'Hay bị nhầm với', en: 'Often confused with' },
  more: { vi: 'Học tiếp', en: 'Go further' },
  special: { vi: 'Trường hợp đặc biệt', en: 'Special cases' },
  alternative: { vi: 'Cách nói khác', en: 'Another way to say it' },
  application: { vi: 'Dùng trong tình huống thật', en: 'In real use' },
};
export const REL_ORDER = ['contrast', 'confusion', 'more', 'special', 'alternative', 'application'];
export const relLabel = (rel: string, vi: boolean): string => (REL[rel] ? pick(REL[rel], vi) : rel);

/* ── blocks ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */
const NOTE: Record<string, Pair> = {
  tip: { vi: 'Mẹo', en: 'Tip' },
  warn: { vi: 'Cẩn thận', en: 'Careful' },
  register: { vi: 'Mức độ trang trọng', en: 'Register' },
  regional: { vi: 'Anh Anh và Anh Mỹ', en: 'British and American' },
  vn: { vi: 'Dành cho người Việt', en: 'For Vietnamese speakers' },
};
export const noteLabel = (kind: string, vi: boolean): string => (NOTE[kind] ? pick(NOTE[kind], vi) : kind);

const EX_TAG: Record<string, Pair> = {
  BrE: { vi: 'Anh Anh', en: 'British' },
  AmE: { vi: 'Anh Mỹ', en: 'American' },
  formal: { vi: 'Trang trọng', en: 'Formal' },
  informal: { vi: 'Thân mật', en: 'Informal' },
  spoken: { vi: 'Văn nói', en: 'Spoken' },
  written: { vi: 'Văn viết', en: 'Written' },
};
export const exampleTagLabel = (tag: string, vi: boolean): string => (EX_TAG[tag] ? pick(EX_TAG[tag], vi) : tag);

/* ── grammatical roles: colour AND underline AND a short tag, never colour alone ────────────────────────────────────── */
export interface RoleInfo { vi: string; en: string; group: 'main' | 'more' }
export const ROLE_INFO: Record<string, RoleInfo> = {
  S: { vi: 'Chủ ngữ', en: 'Subject', group: 'main' },
  V: { vi: 'Động từ chính', en: 'Main verb', group: 'main' },
  AUX: { vi: 'Trợ động từ', en: 'Auxiliary', group: 'main' },
  MOD: { vi: 'Động từ khuyết thiếu', en: 'Modal', group: 'main' },
  O: { vi: 'Tân ngữ', en: 'Object', group: 'main' },
  C: { vi: 'Bổ ngữ', en: 'Complement', group: 'main' },
  A: { vi: 'Trạng ngữ', en: 'Adverbial', group: 'main' },
  T: { vi: 'Từ chỉ thời gian', en: 'Time word', group: 'main' },
  SUB: { vi: 'Mệnh đề phụ', en: 'Subordinate clause', group: 'main' },
  COND: { vi: 'Điều kiện', en: 'Condition', group: 'main' },
  RES: { vi: 'Kết quả', en: 'Result', group: 'main' },
  FOCUS: { vi: 'Trọng tâm', en: 'Focus', group: 'main' },
  DET: { vi: 'Hạn định từ', en: 'Determiner', group: 'more' },
  N: { vi: 'Danh từ chính', en: 'Head noun', group: 'more' },
  ADJ: { vi: 'Tính từ', en: 'Adjective', group: 'more' },
  ADV: { vi: 'Trạng từ', en: 'Adverb', group: 'more' },
  PREP: { vi: 'Giới từ', en: 'Preposition', group: 'more' },
  CL: { vi: 'Mệnh đề', en: 'Clause', group: 'more' },
  NEG: { vi: 'Phủ định', en: 'Negation', group: 'more' },
  Q: { vi: 'Từ để hỏi', en: 'Question word', group: 'more' },
  REF: { vi: 'Từ quy chiếu', en: 'Reference', group: 'more' },
};
export const ROLE_ORDER = Object.keys(ROLE_INFO) as RoleTag[];
/** The short tag shown on hover: "S · Chủ ngữ". */
export const roleTag = (role: string, vi: boolean): string => {
  const info = ROLE_INFO[role];
  return info ? `${role} · ${vi ? info.vi : info.en}` : role;
};

/* ── references (SOURCES.md): names of works only, never a page number or a quotation ──────────────────────────────── */
export const SOURCE_NAME: Record<string, string> = {
  cgt: 'Cambridge Dictionary, English Grammar Today',
  egp: 'English Profile, English Grammar Profile',
  bc: 'British Council, LearnEnglish Grammar',
  'swan-peu': 'M. Swan, Practical English Usage',
  'purdue-owl': 'Purdue University Online Writing Lab',
  'murphy-egu': 'R. Murphy, English Grammar in Use',
  'murphy-essential': 'R. Murphy, Essential Grammar in Use',
  'hewings-agu': 'M. Hewings, Advanced Grammar in Use',
  'eastwood-opg': 'J. Eastwood, Oxford Practice Grammar',
  cgel: 'Huddleston và Pullum, The Cambridge Grammar of the English Language',
  quirk: 'Quirk và cộng sự, A Comprehensive Grammar of the English Language',
  lgswe: 'Biber và cộng sự, Longman Grammar of Spoken and Written English',
  'carter-cge': 'Carter và McCarthy, Cambridge Grammar of English',
  'ielts-bd': 'IELTS, mô tả công khai của bài thi',
  'ets-toeic': 'ETS, định dạng bài thi TOEIC Listening and Reading',
};
export const sourceName = (ref: string, vi: boolean): string => {
  const name = SOURCE_NAME[ref] ?? ref;
  return vi ? name : name.replace(' và ', ' and ');
};

/* ── dates and errors ───────────────────────────────────────────────────────────────────────────────────────────────── */
export function formatDate(iso: string | null | undefined, vi: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(vi ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export interface ApiFailure { status?: number; code?: string }
/** The stable status and code of a failed Grammar request (the server answers `{ code }`, never internals). */
export function apiFailure(err: unknown): ApiFailure {
  const e = err as { response?: { status?: number; data?: { code?: string } }; code?: string } | null | undefined;
  return { status: e?.response?.status, code: e?.response?.data?.code };
}
