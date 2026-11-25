import type { TypingMetrics, TypingSource } from './typing-engine';
export interface TypingSummary extends TypingMetrics { id: string; source: TypingSource; finishedAt: number; duration: number }
export type LegacyTypingSummary = Omit<TypingSummary, 'correctWords' | 'evaluatedWords' | 'incompleteWords' | 'correctedErrors'>;
const fields = ['id', 'source', 'finishedAt', 'duration', 'wpm', 'raw', 'accuracy', 'correct', 'incorrect', 'errors', 'corrections', 'seconds', 'consistency', 'completion', 'inactive', 'correctWords', 'evaluatedWords', 'incompleteWords', 'correctedErrors'];
// Earlier character-attempt summaries are not relabelled as word accuracy.
const key = (userId: number) => `ec_typing_history_v2:${userId}`;
export function validTypingSummary(x: unknown): x is TypingSummary {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const s = x as Record<string, unknown>;
  return Object.keys(s).length === fields.length && Object.keys(s).every(f => fields.includes(f))
    && typeof s.id === 'string' && s.id.length <= 64 && ['random','reading','writing'].includes(String(s.source))
    && typeof s.inactive === 'boolean' && [0,30,60,120,300].includes(Number(s.duration))
    && ['finishedAt','wpm','raw','correct','incorrect','errors','corrections','seconds','completion','correctWords','evaluatedWords','incompleteWords','correctedErrors'].every(f => typeof s[f] === 'number' && Number.isFinite(s[f]) && Number(s[f]) >= 0)
    && (s.accuracy === null ? s.evaluatedWords === 0 : typeof s.accuracy === 'number' && Number.isFinite(s.accuracy) && s.accuracy >= 0 && s.accuracy <= 100)
    && Number(s.correctWords) <= Number(s.evaluatedWords) && Number(s.incompleteWords) <= Number(s.evaluatedWords)
    && Number(s.completion) <= 100 && Number(s.seconds) <= 3601
    && (s.consistency === null || (typeof s.consistency === 'number' && Number.isFinite(s.consistency) && s.consistency >= 0 && s.consistency <= 100));
}
/** Same-tab, compact summaries only. Existing logout cleanup clears all sessionStorage. */
export function readTypingHistory(userId: number, storage?: Pick<Storage, 'getItem'>): TypingSummary[] {
  if (!Number.isSafeInteger(userId) || userId <= 0) return [];
  try {
    const raw = (storage ?? window.sessionStorage).getItem(key(userId));
    if (!raw || raw.length > 30000) return [];
    const value = JSON.parse(raw);
    return value.userId === userId && Array.isArray(value.items) && value.items.length <= 20 && value.items.every(validTypingSummary) ? value.items : [];
  } catch { return []; }
}
/** Preserve earlier summaries with their original character-attempt score, explicitly labelled by the UI. */
export function readLegacyTypingHistory(userId: number, storage?: Pick<Storage, 'getItem'>): LegacyTypingSummary[] {
  if (!Number.isSafeInteger(userId) || userId <= 0) return [];
  try {
    const raw = (storage ?? window.sessionStorage).getItem(`ec_typing_history_v1:${userId}`);
    if (!raw || raw.length > 30000) return [];
    const value = JSON.parse(raw);
    const legacyFields = fields.filter(f => !['correctWords','evaluatedWords','incompleteWords','correctedErrors'].includes(f));
    if (value.userId !== userId || !Array.isArray(value.items) || value.items.length > 20) return [];
    return value.items.every((s: Record<string, unknown>) => s && Object.keys(s).length === legacyFields.length
      && Object.keys(s).every(f => legacyFields.includes(f)) && typeof s.accuracy === 'number'
      && validTypingSummary({ ...s, correctWords: 0, evaluatedWords: 0, incompleteWords: 0, correctedErrors: 0 })) ? value.items : [];
  } catch { return []; }
}
export function saveTypingSummary(userId: number, summary: TypingSummary, storage?: Pick<Storage, 'getItem' | 'setItem'>): TypingSummary[] {
  const recent = readTypingHistory(userId, storage);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !validTypingSummary(summary)) return recent;
  const items = [summary, ...recent.filter(s => s.id !== summary.id)].slice(0, 20);
  try { (storage ?? window.sessionStorage).setItem(key(userId), JSON.stringify({ userId, items })); } catch { /* Current result remains usable when storage is unavailable. */ }
  return items;
}
