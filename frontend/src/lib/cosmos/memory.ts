/**
 * Memory state of a knowledge star at a moment t — from the learner's own recorded evidence only (card creation, own review
 * ratings, completed / produced sources, grammar progress). These are DISPLAY RULES with fixed, documented thresholds; they are
 * not a forgetting-curve prediction and never a score. Nothing is inferred from the absence of evidence except "time since the
 * last evidence", which is a fact.
 *
 *   met       a word you have not saved, met in ≥ 2 of your sources or used once in your own writing / speech
 *   new       discovered within 7 days, at most one rating
 *   recent    any evidence (rating, source, lesson) within the last 7 days — a renewed pulse
 *   renewed   reactivated: new evidence within the last 7 days after a silence of ≥ 30 days (the evidence before it is at
 *             least 30 days older) — a slow renewal glow; it says only that you came back to the word, not that you remember it
 *   learning  studied, no stronger rule applies
 *   stable    "Tốt" / "Dễ" on ≥ 3 different days spanning ≥ 14 days (the Memory Tides "pearl" rule), latest rating not "Khó",
 *             a card you marked Mastered (your own "Dễ", for now only), or a Grammar Academy mastery; a stable star stays stable
 *             unless 180 days pass without evidence
 *   fading    no evidence for 30–90 days (stable: 180+ days)
 *   atRisk    no evidence for 90+ days and never stable (forgotten risk)
 *   weak      your latest rating was "Khó" (memory nebula)
 *   mistaken  ≥ 3 "Khó" ratings, the latest one too (black hole) — the only mistake evidence the platform records
 * cross (flag) — the word occurs in your own writing / speech AND you also studied it or met it in reading / listening / My Books.
 */
import { SKILL, type CosmosNode } from './types';

export type MemoryState = 'met' | 'new' | 'recent' | 'learning' | 'stable' | 'fading' | 'atRisk' | 'weak' | 'mistaken' | 'renewed';
export const MEMORY_CODE: Record<MemoryState, number> = { met: 1, new: 2, recent: 3, learning: 4, stable: 5, fading: 6, atRisk: 7, weak: 8, mistaken: 9, renewed: 10 };
export const CROSS_BIT = 16;
const DAY = 86_400_000;
export const MEMORY_RULES = { newDays: 7, recentDays: 7, fadingDays: 30, atRiskDays: 90, stableFadingDays: 180, stableDays: 3, stableSpanDays: 14, mistakeHard: 3 } as const;

export interface MemoryInfo { state: MemoryState; cross: boolean; lastAt: number; reviews: number; encounters: number; hard: number; positiveDays: number }

/** t = the moment shown; now = the moment the evidence was read (a card status has no recorded time: it counts only for now). */
export function memoryOf(n: CosmosNode, t: number, now = t): MemoryInfo {
  const R = n.ratings.filter(r => r[0] <= t);
  const touches = n.touches.filter(x => x[0] <= t);
  const hard = R.filter(r => r[1] === 0).length;
  const lastQ = R.length ? R[R.length - 1][1] : -1;
  const positives = R.filter(r => r[1] >= 1);
  const positiveDays = new Set(positives.map(r => Math.floor(r[0] / DAY))).size;
  const span = positives.length ? positives[positives.length - 1][0] - positives[0][0] : 0;
  const lastAt = Math.max(n.discoveredAt <= t ? n.discoveredAt : 0, R.length ? R[R.length - 1][0] : 0, touches.length ? touches[touches.length - 1][0] : 0);
  // the evidence moment just before the latest one (renewal = coming back after a long silence)
  const times = [...(n.discoveredAt <= t ? [n.discoveredAt] : []), ...R.map(r => r[0]), ...touches.map(x => x[0])].sort((a, b) => a - b);
  const prevAt = times.length >= 2 ? times[times.length - 2] : -1;
  const bits = touches.reduce((m, x) => m | x[1], n.cardIds.length ? SKILL.flashcard : 0);
  const produced = (bits & (SKILL.writing | SKILL.speaking)) !== 0;
  const cross = produced && (bits & (SKILL.flashcard | SKILL.reading | SKILL.listening)) !== 0;
  const info = (state: MemoryState): MemoryInfo => ({ state, cross, lastAt, reviews: R.length, encounters: touches.length, hard, positiveDays });
  const age = t - lastAt;
  if (n.kind === 'word' && !n.cardIds.length) return info('met');
  if (n.kind === 'grammar') {
    if (n.weak && t >= n.discoveredAt) return info('weak');
    const mastered = R.some(r => r[1] === 2);
    if (mastered) return info(age > MEMORY_RULES.stableFadingDays * DAY ? 'fading' : 'stable');
    if (t - n.discoveredAt <= MEMORY_RULES.newDays * DAY && !R.length) return info('new');
    if (prevAt >= 0 && age <= MEMORY_RULES.recentDays * DAY && lastAt - prevAt >= MEMORY_RULES.fadingDays * DAY) return info('renewed');
    return info(age <= MEMORY_RULES.recentDays * DAY ? 'recent' : age > MEMORY_RULES.atRiskDays * DAY ? 'atRisk' : age > MEMORY_RULES.fadingDays * DAY ? 'fading' : 'learning');
  }
  if (hard >= MEMORY_RULES.mistakeHard && lastQ === 0) return info('mistaken');
  if (lastQ === 0) return info('weak');
  if (t - n.discoveredAt <= MEMORY_RULES.newDays * DAY && R.length <= 1) return info('new');
  // card status MASTERED (set by your own "Dễ"; latest rating not Hard, checked above) is stable — only for "now": the status has no recorded time
  if (prevAt >= 0 && age <= MEMORY_RULES.recentDays * DAY && lastAt - prevAt >= MEMORY_RULES.fadingDays * DAY) return info('renewed');
  const stable = (positiveDays >= MEMORY_RULES.stableDays && span >= MEMORY_RULES.stableSpanDays * DAY) || (n.status === 'MASTERED' && t >= now);
  if (stable) return info(age > MEMORY_RULES.stableFadingDays * DAY ? 'fading' : 'stable');
  if (age <= MEMORY_RULES.recentDays * DAY) return info('recent');
  if (age > MEMORY_RULES.atRiskDays * DAY) return info('atRisk');
  if (age > MEMORY_RULES.fadingDays * DAY) return info('fading');
  return info('learning');
}

export function memoryCode(m: MemoryInfo): number { return MEMORY_CODE[m.state] | (m.cross ? CROSS_BIT : 0); }

export const MEMORY_LABEL: Record<MemoryState, [string, string]> = {
  met: ['Đã gặp trong nguồn', 'Met in your sources'], new: ['Mới khám phá', 'Newly discovered'], recent: ['Vừa ôn / vừa gặp lại', 'Recently reinforced'],
  learning: ['Đang học', 'Learning'], stable: ['Vững', 'Stable'], fading: ['Đang mờ dần', 'Fading'], atRisk: ['Có nguy cơ quên', 'At risk of forgetting'],
  weak: ['Lần gần nhất: Khó', 'Latest rating: Hard'], mistaken: ['Hay vấp', 'Repeatedly hard'], renewed: ['Vừa quay lại sau thời gian dài', 'Reactivated'],
};
export const MEMORY_WHY: Record<MemoryState, [string, string]> = {
  met: ['Bạn chưa lưu thẻ; từ có trong ít nhất 2 nguồn bạn đã học, hoặc bạn đã tự dùng nó khi viết, nói.', 'Not saved as a card; it occurs in 2+ of your sources, or you used it in your own writing or speech.'],
  new: ['Bạn gặp từ này trong 7 ngày qua.', 'You met it within the last 7 days.'],
  recent: ['Có bằng chứng mới trong 7 ngày qua (lần ôn, bài đọc, bài nghe, bài viết hay lời nói).', 'New evidence within 7 days (a review, reading, listening, writing or speech).'],
  learning: ['Đã học, chưa đủ bằng chứng để coi là vững.', 'Studied; not enough evidence to call it stable yet.'],
  stable: ['Tốt hoặc Dễ trong ít nhất 3 ngày khác nhau cách nhau từ 14 ngày, hoặc thẻ đang ở trạng thái Thành thạo do bạn chọn Dễ; lần gần nhất không phải Khó (với chủ điểm: đã đạt bài kiểm tra).', 'Good or Easy on 3+ days spanning 14+ days, or the card is Mastered by your own Easy; latest not Hard (for a topic: its check passed).'],
  fading: ['Không có bằng chứng mới trong hơn 30 ngày (với từ đã vững: hơn 180 ngày).', 'No new evidence for 30+ days (for a stable word: 180+ days).'],
  atRisk: ['Không có bằng chứng mới trong hơn 90 ngày và chưa từng vững.', 'No new evidence for 90+ days and never stable.'],
  weak: ['Lần ôn gần nhất bạn chọn Khó.', 'Your latest review rating was Hard.'],
  renewed: ['Có bằng chứng mới trong 7 ngày qua sau ít nhất 30 ngày không có bằng chứng nào. Chỉ cho biết bạn đã quay lại với từ này, không khẳng định bạn còn nhớ.', 'New evidence within 7 days after at least 30 days without any. It says only that you came back to it, not that you remember it.'],
  mistaken: ['Bạn chọn Khó ít nhất 3 lần, kể cả lần gần nhất (đánh giá của bạn, không phải lỗi dùng từ được chấm).', 'You chose Hard 3+ times, including the latest (your own rating, not a graded usage error).'],
};
