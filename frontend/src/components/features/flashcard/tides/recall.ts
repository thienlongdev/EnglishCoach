/**
 * Deep Recall helpers (Echo Memory Tides 2.0). Pure functions, no request, no AI. They only compare what the learner typed
 * with what is stored on the card and never decide the rating: the learner still rates Khó / Tốt / Dễ honestly on the
 * back, and the review schedule is unchanged. A keyword overlap is told as an overlap, never as "perfect".
 */

export type RecallMode = "flip" | "type" | "cloze";

export const RECALL_MODE_KEY = "ec.flashcard.recall-mode.v1";

export function readRecallMode(): RecallMode {
  try {
    const v = localStorage.getItem(RECALL_MODE_KEY);
    return v === "type" || v === "cloze" ? v : "flip";
  } catch {
    return "flip";
  }
}

export function writeRecallMode(mode: RecallMode) {
  try { localStorage.setItem(RECALL_MODE_KEY, mode); } catch { /* per-browser convenience only */ }
}

/** The simple regular forms of one English word (same rule as the backend's WordForms; irregular forms are never guessed). */
export function wordForms(word: string): Set<string> {
  const w = word.trim().toLowerCase();
  const out = new Set<string>();
  if (!w) return out;
  [w, `${w}s`, `${w}es`, `${w}ed`, `${w}d`, `${w}ing`, `${w}er`, `${w}est`, `${w}ly`].forEach((f) => out.add(f));
  if (w.endsWith("e") && w.length > 2) out.add(`${w.slice(0, -1)}ing`);
  if (w.endsWith("y") && w.length > 2) {
    const s = w.slice(0, -1);
    [`${s}ies`, `${s}ied`, `${s}ier`, `${s}iest`, `${s}ily`].forEach((f) => out.add(f));
  }
  if (w.length >= 3) {
    const [a, b, c] = w.slice(-3);
    const v = "aeiou";
    if (!v.includes(a) && v.includes(b) && !v.includes(c) && !"wxy".includes(c)) {
      out.add(`${w}${c}ed`);
      out.add(`${w}${c}ing`);
    }
  }
  return out;
}

export interface Cloze {
  sentence: string;
  /** The exact span hidden in the sentence (the word or its regular form). */
  answer: string;
  before: string;
  after: string;
}

/** A cloze from the first stored example that really uses the (single) word; null when none does (never invented). */
export function clozeFor(word: string, examples: string[]): Cloze | null {
  const w = word.trim();
  if (!w || /\s/.test(w)) return clozePhrase(w, examples);
  const forms = wordForms(w);
  for (const sentence of examples) {
    const re = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence)) !== null) {
      if (forms.has(m[0].toLowerCase().replace("’", "'"))) {
        return { sentence, answer: m[0], before: sentence.slice(0, m.index), after: sentence.slice(m.index + m[0].length) };
      }
    }
  }
  return null;
}

/** A phrase is hidden only when it appears exactly (case-insensitive) in an example. */
function clozePhrase(phrase: string, examples: string[]): Cloze | null {
  if (!phrase) return null;
  const lower = phrase.toLowerCase();
  for (const sentence of examples) {
    const i = sentence.toLowerCase().indexOf(lower);
    if (i >= 0) return { sentence, answer: sentence.slice(i, i + phrase.length), before: sentence.slice(0, i), after: sentence.slice(i + phrase.length) };
  }
  return null;
}

export type ClozeVerdict = "exact" | "base" | "wrong";

export function checkCloze(typed: string, cloze: Cloze, word: string): ClozeVerdict {
  const t = typed.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return "wrong";
  if (t === cloze.answer.toLowerCase()) return "exact";
  if (t === word.trim().toLowerCase()) return "base";
  return "wrong";
}

/** Lower case, no Vietnamese marks (đ → d), no punctuation: harmless typing differences disappear. */
export function foldVi(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VI_FILLER = new Set(["cai", "su", "viec", "cua", "va", "mot", "nhung", "cac", "la", "duoc", "de", "cho", "nguoi", "nay", "do", "the", "a", "an", "to", "of"]);

export type MeaningMatch = "close" | "partial" | "none";

/**
 * Overlap of content syllables between what the learner typed and the stored meaning. "close" = at least 60 % of the
 * stored meaning's content syllables appear (so a two-syllable meaning needs both); "partial" = some; "none" = none.
 * It is only a keyword comparison.
 */
export function compareMeaning(typed: string, stored: string): MeaningMatch {
  const words = (s: string) => foldVi(s).split(" ").filter((w) => w.length > 0 && !VI_FILLER.has(w));
  const target = Array.from(new Set(words(stored.split(/[;,(]/)[0] || stored)));
  const mine = new Set(words(typed));
  if (!target.length || !mine.size) return "none";
  const hit = target.filter((w) => mine.has(w)).length;
  if (hit / target.length >= 0.6) return "close";
  return hit > 0 ? "partial" : "none";
}
