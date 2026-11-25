/**
 * Echo Grammar Academy exercises: the learner's answer as data. Pure helpers shared by the inputs, the card, the check runner and
 * the Practice Studio. The shapes are the backend's (`GrammarEvaluator`): they are read here, never invented.
 */
import type { Answer, Exercise, Verdict } from '@/types/grammar';

export type Completeness = 'none' | 'partial' | 'full';

/** A Vietnamese sentence carries at least one of these letters; plain English does not. Used only to set `lang`. */
const VI_LETTER = /[ăâđêôơưĂÂĐÊÔƠƯẠ-ỹ]/;
export const langOf = (text: string): 'vi' | 'en' => (VI_LETTER.test(text) ? 'vi' : 'en');

/** One id per learner action (a retry of the same action reuses it, so nothing is stored twice). */
export function newRequestId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ── reading an answer without casts ─────────────────────────────────────────────────────────────────────────────────── */
export const choiceOf = (a: Answer | null | undefined): number | null => (a && 'choice' in a ? a.choice : null);
export const choicesOf = (a: Answer | null | undefined): number[] => (a && 'choices' in a ? a.choices : []);
export const blanksOf = (a: Answer | null | undefined): Record<string, string> => (a && 'blanks' in a ? a.blanks : {});
export const seqOf = (a: Answer | null | undefined): string[] => (a && 'seq' in a ? a.seq : []);
export const textOf = (a: Answer | null | undefined): string => (a && 'text' in a ? a.text : '');
export const pickedOf = (a: Answer | null | undefined): number[] => (a && 'picked' in a ? a.picked : []);
export const noneOf = (a: Answer | null | undefined): boolean => !!(a && 'picked' in a && a.none);
export const pairsOf = (a: Answer | null | undefined): Record<string, string> => (a && 'pairs' in a ? a.pairs : {});
export const catsOf = (a: Answer | null | undefined): Record<string, string> => (a && 'cats' in a ? a.cats : {});

/* ── a cloze stem: text and blanks in order ──────────────────────────────────────────────────────────────────────────── */
export type StemPart = { text: string } | { blank: string };
export function stemParts(stem: string): StemPart[] {
  const out: StemPart[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stem))) {
    if (m.index > last) out.push({ text: stem.slice(last, m.index) });
    out.push({ blank: m[1] });
    last = m.index + m[0].length;
  }
  if (last < stem.length) out.push({ text: stem.slice(last) });
  return out;
}

/** The blanks of a cloze in the order they appear in the stem (falling back to key order). */
export function blankKeys(ex: Exercise): string[] {
  const declared = Object.keys(ex.blanks ?? {});
  const inStem = stemParts(ex.stem ?? '').flatMap((p) => ('blank' in p && declared.includes(p.blank) ? [p.blank] : []));
  const seen = new Set<string>();
  const ordered = inStem.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
  for (const k of declared.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))) if (!seen.has(k)) ordered.push(k);
  return ordered;
}

/* ── how much of an exercise is answered ─────────────────────────────────────────────────────────────────────────────── */
export function completeness(ex: Exercise, a: Answer | null | undefined): Completeness {
  if (!a) return 'none';
  switch (ex.type) {
    case 'choice': return choiceOf(a) != null ? 'full' : 'none';
    case 'multi': return choicesOf(a).length ? 'full' : 'none';
    case 'cloze': {
      const keys = blankKeys(ex);
      const blanks = blanksOf(a);
      const filled = keys.filter((k) => (blanks[k] ?? '').trim()).length;
      return filled === 0 ? 'none' : filled === keys.length ? 'full' : 'partial';
    }
    case 'order': {
      const n = seqOf(a).length;
      return n === 0 ? 'none' : n === (ex.tokens?.length ?? 0) ? 'full' : 'partial';
    }
    case 'transform':
    case 'open': return textOf(a).trim() ? 'full' : 'none';
    case 'error': return noneOf(a) || pickedOf(a).length ? 'full' : 'none';
    case 'match': {
      const n = Object.keys(pairsOf(a)).length;
      const total = ex.left?.length ?? 0;
      return n === 0 ? 'none' : n >= total ? 'full' : 'partial';
    }
    case 'classify': {
      const n = Object.keys(catsOf(a)).length;
      const total = ex.items?.length ?? 0;
      return n === 0 ? 'none' : n >= total ? 'full' : 'partial';
    }
    default: return 'none';
  }
}

/**
 * What a whole check may send for one item. An order answer that is not a complete arrangement is refused by the server
 * (it would fail the entire submission), so an unfinished arrangement counts as unanswered; every other partial answer is sent
 * and judged by the server.
 */
export function sendable(ex: Exercise, a: Answer | null | undefined): Answer | null {
  const c = completeness(ex, a);
  if (!a || c === 'none') return null;
  if (ex.type === 'order' && c !== 'full') return null;
  return a;
}

/** A short text of the answer, for the "my answer is also right" report. Bounded; never more than the server keeps. */
export function answerText(ex: Exercise, a: Answer | null | undefined): string {
  if (!a) return '';
  let out = '';
  switch (ex.type) {
    case 'choice': out = ex.options?.find((o) => o.i === choiceOf(a))?.t ?? ''; break;
    case 'multi': out = choicesOf(a).map((i) => ex.options?.find((o) => o.i === i)?.t ?? '').filter(Boolean).join(' | '); break;
    case 'cloze': {
      const blanks = blanksOf(a);
      out = blankKeys(ex).map((k) => `${k}: ${blanks[k] ?? ''}`).join(' | ');
      break;
    }
    case 'order': out = `${seqOf(a).join(' ')}${ex.end ?? ''}`; break;
    case 'transform':
    case 'open': out = textOf(a); break;
    case 'error': out = noneOf(a) ? '(no error)' : pickedOf(a).map((i) => ex.segments?.[i]?.t ?? '').join(' | '); break;
    case 'match': out = Object.entries(pairsOf(a)).map(([i, b]) => `${ex.left?.[Number(i)] ?? i} = ${b}`).join(' | '); break;
    case 'classify': out = Object.entries(catsOf(a)).map(([i, c]) => `${ex.items?.find((it) => it.i === Number(i))?.t ?? i} = ${c}`).join(' | '); break;
    default: break;
  }
  return out.slice(0, 400);
}

/** The Verdict a finished check hands back for one item, in the shape the card renders. */
export function verdictOfItem(item: { exerciseId: string; outcome: Verdict['outcome']; score: number | null; explain: string; reveal: Verdict['reveal'] }): Verdict {
  return { exerciseId: item.exerciseId, outcome: item.outcome, score: item.score, explain: item.explain, reveal: item.reveal, tags: [] };
}

export const TYPE_ORDER: Exercise['type'][] = ['choice', 'multi', 'cloze', 'order', 'transform', 'error', 'match', 'classify', 'open'];
