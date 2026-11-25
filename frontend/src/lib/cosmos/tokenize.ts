/**
 * The client twin of backend `CosmosTokenizer` (version 1): distinct lower-case word forms and adjacent two-word forms, never
 * across sentence punctuation. Used for sources that never leave the device (My Books highlights). The contract test checks
 * both produce the same output.
 */
export const TOKENIZER_VERSION = 1;
const WORD = /[a-z]+(?:['-][a-z]+)*/g;
const BREAK = /[.!?;:,()[\]{}"“”—–\n\r]+/;

export function tokenize(text: string): string {
  const norm = (text ?? '').normalize('NFC').replace(/’/g, "'").replace(/‘/g, "'").toLowerCase();
  const uni = new Set<string>(), bi = new Set<string>();
  for (const clause of norm.split(BREAK)) {
    let prev: string | null = null;
    for (const m of clause.matchAll(WORD)) {
      let w = m[0];
      if (w.endsWith("'s")) w = w.slice(0, -2);
      if (!w || w.length > 40) { prev = null; continue; }
      if (uni.size + bi.size >= 20000) break;
      uni.add(w);
      if (prev) bi.add(`${prev}_${w}`);
      prev = w;
    }
  }
  return `${[...uni].join(' ')}|${[...bi].join(' ')}`;
}
