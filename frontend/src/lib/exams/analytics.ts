/**
 * Exams Phase 8 — pure learner analytics / mistakes / recommendation presentation helpers (no React, no network),
 * executed by scripts/check-exams-phase8-analytics-contract.mjs.
 *
 * Every sentence is rendered ONLY from the structured facts the server sent (counts, percentages) — nothing is
 * estimated here. Practice numbers are raw counts: never a TOEIC scale, an IELTS band, a CEFR level or a "mastery".
 * Tone is neutral ("Nên luyện thêm", "Có thể tập trung") — never judgemental. Policy versions / codes stay internal.
 */
import { practiceScopeLabel, type PracticeLang } from './practice';

export type AnalyticsLang = PracticeLang;

export interface ScopeRef {
  scopeType: string;
  scopeNumber: number;
}

export function scopeName(scope: ScopeRef, lang: AnalyticsLang = 'vi'): string {
  return practiceScopeLabel({ scopeType: scope.scopeType, number: scope.scopeNumber }, lang);
}

/** Sample sufficiency, in learner words (never the policy code). */
export function signalLabel(signal: string | undefined, lang: AnalyticsLang = 'vi'): string {
  switch (signal) {
    case 'ESTABLISHED_SIGNAL':
      return lang === 'vi' ? 'Đủ dữ liệu' : 'Enough data';
    case 'EMERGING_SIGNAL':
      return lang === 'vi' ? 'Dữ liệu ban đầu' : 'Early data';
    case 'NOT_APPLICABLE':
      return lang === 'vi' ? 'Không chấm điểm' : 'Not scored';
    default:
      return lang === 'vi' ? 'Chưa đủ dữ liệu' : 'Not enough data yet';
  }
}

/** "43 câu đã làm · 4 lượt luyện" — the sample behind every number. */
export function sampleLine(questions: number | undefined, attempts: number | undefined, lang: AnalyticsLang = 'vi'): string {
  const q = typeof questions === 'number' ? questions : 0;
  const a = typeof attempts === 'number' ? attempts : 0;
  return lang === 'vi' ? `${q} câu đã làm · ${a} lượt luyện` : `${q} questions · ${a} practice ${a === 1 ? 'session' : 'sessions'}`;
}

/** "72% đúng" (raw accuracy) or '' when there is nothing scored. */
export function accuracyLine(percent: number | undefined | null, lang: AnalyticsLang = 'vi'): string {
  if (typeof percent !== 'number') return '';
  return lang === 'vi' ? `${formatPercent(percent)} đúng` : `${formatPercent(percent)} correct`;
}

export function formatPercent(n: number | undefined | null): string {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

/** A chart needs at least two samples (never a one-point "trend"). */
export function shouldShowTrend(points: Array<unknown> | undefined | null): boolean {
  return Array.isArray(points) && points.length >= 2;
}

export function formatMinutes(seconds: number | undefined | null, lang: AnalyticsLang = 'vi'): string {
  if (typeof seconds !== 'number' || seconds < 0) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return lang === 'vi' ? `${minutes} phút` : `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return lang === 'vi' ? `${h} giờ ${m} phút` : `${h} h ${m} min`;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

/** One reason sentence, from the server's facts only. Unknown codes render nothing (never a guess). */
export function reasonText(code: string, facts: Record<string, unknown>, scope: ScopeRef, lang: AnalyticsLang = 'vi'): string {
  const s = scopeName(scope, lang);
  switch (code) {
    case 'REPEATED_MISTAKES':
      return lang === 'vi'
        ? `Có ${num(facts.count)} câu ở ${s} bạn đã trả lời chưa đúng nhiều lần.`
        : `${num(facts.count)} questions in ${s} were missed more than once.`;
    case 'MANY_BLANKS':
      return lang === 'vi'
        ? `Bạn bỏ trống ${num(facts.unanswered)}/${num(facts.total)} câu gần đây ở ${s}.`
        : `You left ${num(facts.unanswered)}/${num(facts.total)} recent questions blank in ${s}.`;
    case 'RECENT_MISSES': {
      const inc = num(facts.incorrect);
      const un = num(facts.unanswered);
      const total = num(facts.total);
      if (un > 0) {
        return lang === 'vi'
          ? `Gần đây bạn sai ${inc} câu và bỏ trống ${un} câu trên ${total} câu ở ${s}.`
          : `Recently you missed ${inc} and left ${un} blank out of ${total} questions in ${s}.`;
      }
      return lang === 'vi' ? `Bạn sai ${inc}/${total} câu gần đây ở ${s}.` : `You missed ${inc}/${total} recent questions in ${s}.`;
    }
    case 'LOWER_THAN_OTHER_SCOPES':
      return lang === 'vi'
        ? `Gần đây phần này có tỷ lệ đúng thấp hơn các phần khác bạn luyện (${formatPercent(num(facts.recentAccuracy))} so với ${formatPercent(num(facts.otherAccuracy))}).`
        : `Recently this part has a lower correct rate than your other parts (${formatPercent(num(facts.recentAccuracy))} vs ${formatPercent(num(facts.otherAccuracy))}).`;
    case 'IMPROVING':
      return lang === 'vi'
        ? `Bạn đang tiến bộ ở phần này (${formatPercent(num(facts.earlierAccuracy))} → ${formatPercent(num(facts.recentAccuracy))}).`
        : `You are improving in this part (${formatPercent(num(facts.earlierAccuracy))} → ${formatPercent(num(facts.recentAccuracy))}).`;
    case 'NOT_PRACTICED_YET':
      return lang === 'vi' ? 'Bạn chưa luyện phần này gần đây.' : 'You have not practised this part recently.';
    case 'AVAILABLE_TO_START':
      return lang === 'vi' ? 'Phần này hiện có thể luyện.' : 'This part is ready to practise.';
    default:
      return '';
  }
}

export function recommendationKindLabel(kind: string, lang: AnalyticsLang = 'vi'): string {
  if (kind === 'FOCUS') return lang === 'vi' ? 'Nên luyện thêm' : 'Worth more practice';
  if (kind === 'COVERAGE') return lang === 'vi' ? 'Chưa luyện' : 'Not practised yet';
  return lang === 'vi' ? 'Gợi ý bắt đầu' : 'Good place to start';
}

/** Status line of the recommendation block; null when personalised (the reasons speak). */
export function recommendationStatusText(status: string, lang: AnalyticsLang = 'vi'): string | null {
  if (status === 'INSUFFICIENT_DATA') {
    return lang === 'vi'
      ? 'Chưa đủ dữ liệu để đề xuất phần cần tập trung. Bạn có thể bắt đầu với một trong các phần dưới đây.'
      : 'Not enough data yet to suggest a focus area. You can start with one of the parts below.';
  }
  if (status === 'NO_AVAILABLE_SCOPE') {
    return lang === 'vi' ? 'Hiện chưa có phần luyện tập nào sẵn sàng.' : 'No practice part is ready right now.';
  }
  return null;
}

/** "Dựa trên 40 câu gần đây · 2 lượt luyện" for a data-driven suggestion; '' otherwise. */
export function recommendationSampleText(sampleQuestions: number | undefined, sampleAttempts: number | undefined,
                                         lang: AnalyticsLang = 'vi'): string {
  if (typeof sampleQuestions !== 'number' || typeof sampleAttempts !== 'number') return '';
  return lang === 'vi'
    ? `Dựa trên ${sampleQuestions} câu gần đây · ${sampleAttempts} lượt luyện`
    : `Based on ${sampleQuestions} recent questions · ${sampleAttempts} practice ${sampleAttempts === 1 ? 'session' : 'sessions'}`;
}

export function mistakeStateLabel(state: string, lang: AnalyticsLang = 'vi'): string {
  if (state === 'REPEATED') return lang === 'vi' ? 'Sai nhiều lần' : 'Missed repeatedly';
  if (state === 'SINGLE') return lang === 'vi' ? 'Sai một lần' : 'Missed once';
  return lang === 'vi' ? 'Đã làm đúng ở lần sau' : 'Correct on a later try';
}

/** Outcome glyph + text (state is never colour-only). */
export function outcomeMark(outcome: string, lang: AnalyticsLang = 'vi'): { glyph: string; label: string } {
  if (outcome === 'CORRECT') return { glyph: '✓', label: lang === 'vi' ? 'Đúng' : 'Correct' };
  if (outcome === 'INCORRECT') return { glyph: '✗', label: lang === 'vi' ? 'Sai' : 'Incorrect' };
  return { glyph: '−', label: lang === 'vi' ? 'Bỏ trống' : 'Blank' };
}

/** Learner name of a canonical interaction type; anything unknown is a neutral "other" (never a code). */
export function interactionTypeLabel(type: string | undefined, lang: AnalyticsLang = 'vi'): string {
  const vi: Record<string, string> = {
    SINGLE_CHOICE: 'Trắc nghiệm một đáp án',
    MULTIPLE_CHOICE_MULTI: 'Chọn nhiều đáp án',
    TRUTH_CLASSIFICATION: 'True / False / Not Given',
    MATCHING: 'Nối thông tin',
    HEADING_MATCHING: 'Chọn tiêu đề đoạn',
    TEXT_GAP: 'Điền vào chỗ trống',
    SHORT_ANSWER: 'Trả lời ngắn',
    LABEL_ASSIGNMENT: 'Gắn nhãn bản đồ / sơ đồ',
  };
  const en: Record<string, string> = {
    SINGLE_CHOICE: 'Single choice',
    MULTIPLE_CHOICE_MULTI: 'Choose several',
    TRUTH_CLASSIFICATION: 'True / False / Not Given',
    MATCHING: 'Matching',
    HEADING_MATCHING: 'Matching headings',
    TEXT_GAP: 'Gap fill',
    SHORT_ANSWER: 'Short answer',
    LABEL_ASSIGNMENT: 'Map / diagram labelling',
  };
  const table = lang === 'vi' ? vi : en;
  return (type && table[type]) || (lang === 'vi' ? 'Dạng câu hỏi khác' : 'Other question type');
}

/** Learner name of a scorer component (simulation only). */
export function componentLabel(metric: string, lang: AnalyticsLang = 'vi'): string {
  switch (metric) {
    case 'LR_TOTAL':
      return lang === 'vi' ? 'Tổng Listening + Reading' : 'Listening + Reading total';
    case 'FULL_OVERALL':
      return 'Overall';
    case 'LISTENING':
      return 'Listening';
    case 'READING':
      return 'Reading';
    case 'WRITING':
      return 'Writing';
    case 'SPEAKING':
      return 'Speaking';
    default:
      return metric;
  }
}

/** A scorer-persisted value: IELTS bands keep one decimal, TOEIC scales are integers. */
export function componentValue(scaledScore: number, scaleName: string | undefined): string {
  if (scaleName && /BAND/i.test(scaleName)) return scaledScore.toFixed(1);
  return String(Math.round(scaledScore));
}

export function simulationStatusLabel(resultStatus: string, lang: AnalyticsLang = 'vi'): string {
  switch (resultStatus) {
    case 'COMPLETED':
      return lang === 'vi' ? 'Đã chấm' : 'Scored';
    case 'PARTIAL':
      return lang === 'vi' ? 'Chấm một phần' : 'Partly scored';
    case 'REVIEW_REQUIRED':
      return lang === 'vi' ? 'Đang chờ xem xét' : 'Awaiting review';
    case 'PENDING':
      return lang === 'vi' ? 'Đang chấm' : 'Scoring';
    default:
      return lang === 'vi' ? 'Chưa có điểm' : 'No score';
  }
}

export interface ResumableLike {
  attemptId: string;
  formId: string;
  practiceScopeCode?: string | null;
  status: string;
  mode?: string;
}

/** CTA target: an unfinished attempt of the SAME form + scope is resumed; otherwise a new practice is started on click. */
export function recommendationCta(rec: { formId: string; scopeCode: string }, history: ResumableLike[]):
  { kind: 'resume'; attemptId: string } | { kind: 'start' } {
  const open = history.find((h) => h.mode === 'PRACTICE' && h.formId === rec.formId && h.practiceScopeCode === rec.scopeCode
    && ['CREATED', 'READY', 'IN_PROGRESS'].includes(h.status));
  return open ? { kind: 'resume', attemptId: open.attemptId } : { kind: 'start' };
}

/** "06/10" short week label (weekStart is an ISO date, Monday). */
export function weekLabel(weekStart: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(weekStart || '');
  return m ? `${m[3]}/${m[2]}` : weekStart;
}

/** Practice-result route that holds the answers of a past attempt (the only answer-view path). */
export function reviewPath(family: string, attemptId: string): string {
  return `/exams/${family.toLowerCase()}/practice/result/${attemptId}`;
}

/** SVG polyline points of a 0–100 % series in a w×h box (first → last attempt). */
export function sparklinePoints(values: number[], w: number, h: number, pad = 3): string {
  if (values.length < 2) return '';
  const step = (w - pad * 2) / (values.length - 1);
  return values
    .map((v, i) => `${(pad + i * step).toFixed(1)},${(pad + (1 - Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2)).toFixed(1)}`)
    .join(' ');
}
