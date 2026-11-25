/**
 * Echo Grammar Academy: instant local search over the catalog. No request, no AI. A query and a title are folded the same way
 * (lower case, diacritics and `đ` removed), so "dang tung", "đã từng" and "DA TUNG" find the same topic, and an English string
 * such as "since for" finds the topic whose aliases carry it. Scoring looks at the titles (vi, en), the subtitle, the aliases and
 * the common mistakes; every meaningful word of the query has to land somewhere.
 */
import type { TopicEntry } from '@/hooks/useGrammar';

const MARKS = /[̀-ͯ]/g;

/** One character folded: base letter, lower case, `đ` as `d`. May be empty for a lone combining mark. */
function foldChar(ch: string): string {
  const base = ch.normalize('NFD').replace(MARKS, '');
  return base.replace(/[đĐ]/g, 'd').toLowerCase();
}

/** Lower case, no diacritics, `đ` as `d`, every run of non-letters and non-digits as one space. */
export function fold(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) out += foldChar(ch);
  return out.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Words that never narrow a search on their own ("và", "of", "the"): ignored when something else was typed. */
const STOP = new Set(['va', 'cua', 'la', 'hay', 'cho', 'voi', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'vs', 'and', 'or']);

/** The words of a query, folded; stop words dropped unless the query is only stop words. */
export function tokenize(query: string): string[] {
  const all = fold(query).split(' ').filter(Boolean);
  const kept = all.filter((w) => !STOP.has(w));
  return kept.length ? kept : all;
}

interface Field { text: string; words: string[] }
const field = (s: string | undefined | null): Field => {
  const text = fold(s ?? '');
  return { text, words: text ? text.split(' ') : [] };
};

export interface SearchDoc {
  entry: TopicEntry;
  titleVi: Field; titleEn: Field; subVi: Field; subEn: Field; slug: Field;
  aliases: { raw: string; f: Field }[];
  mistakes: { raw: string; f: Field }[];
}

export function buildSearchIndex(entries: Iterable<TopicEntry>): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const entry of entries) {
    const t = entry.topic;
    docs.push({
      entry,
      titleVi: field(t.title.vi), titleEn: field(t.title.en),
      subVi: field(t.subtitle?.vi), subEn: field(t.subtitle?.en),
      slug: field(t.slug),
      aliases: (t.aliases ?? []).map((raw) => ({ raw, f: field(raw) })),
      mistakes: (t.mistakes ?? []).filter((m) => typeof m === 'string').map((raw) => ({ raw, f: field(raw) })),
    });
  }
  return docs;
}

export type Via = 'title' | 'subtitle' | 'alias' | 'mistake' | 'slug';
export interface SearchHit { doc: SearchDoc; entry: TopicEntry; score: number; via: Via; viaText: string | null }

/** Weights: [whole word, word starts with, anywhere inside] */
const W = {
  title: [12, 9, 6], alias: [9, 7, 5], subtitle: [4, 3, 2], mistake: [3, 2, 1.5], slug: [2, 1, 0.5],
} as const;

function score(f: Field, token: string, w: readonly [number, number, number]): number {
  let best = 0;
  for (const word of f.words) {
    if (word === token) return w[0];
    if (token.length >= 2 && word.startsWith(token)) best = Math.max(best, w[1]);
    else if (token.length >= 3 && word.includes(token)) best = Math.max(best, w[2]);
  }
  return best;
}

/** Ranked hits for a query, or null for an empty query (the caller then shows the whole catalog). */
export function search(index: SearchDoc[], query: string): SearchHit[] | null {
  const tokens = tokenize(query);
  if (!tokens.length) return null;
  const phrase = tokens.join(' ');
  const hits: SearchHit[] = [];
  for (const doc of index) {
    let total = 0;
    let bestVia: Via = 'slug';
    let bestViaScore = -1;
    let viaText: string | null = null;
    let ok = true;
    for (const token of tokens) {
      let best = 0;
      const consider = (s: number, via: Via, text: string | null) => {
        if (s > best) best = s;
        if (s > bestViaScore) { bestViaScore = s; bestVia = via; viaText = text; }
      };
      consider(Math.max(score(doc.titleVi, token, W.title), score(doc.titleEn, token, W.title)), 'title', null);
      consider(Math.max(score(doc.subVi, token, W.subtitle), score(doc.subEn, token, W.subtitle)), 'subtitle', null);
      for (const a of doc.aliases) consider(score(a.f, token, W.alias), 'alias', a.raw);
      for (const m of doc.mistakes) consider(score(m.f, token, W.mistake), 'mistake', m.raw);
      consider(score(doc.slug, token, W.slug), 'slug', null);
      if (best <= 0) { ok = false; break; }
      total += best;
    }
    if (!ok) continue;
    if (tokens.length > 1) {
      if (doc.titleVi.text.includes(phrase) || doc.titleEn.text.includes(phrase)) total += 14;
      for (const a of doc.aliases) if (a.f.text.includes(phrase)) { total += 12; bestVia = 'alias'; viaText = a.raw; break; }
      if (doc.subVi.text.includes(phrase) || doc.subEn.text.includes(phrase)) total += 4;
    }
    if (doc.entry.topic.available) total += 0.5;
    hits.push({ doc, entry: doc.entry, score: total, via: bestVia, viaText });
  }
  hits.sort((a, b) => b.score - a.score || Number(b.entry.topic.available) - Number(a.entry.topic.available) || (a.entry.topic.path ?? 1e9) - (b.entry.topic.path ?? 1e9));
  return hits;
}

export interface Piece { t: string; hit: boolean }

/** `text` cut into pieces, the ones that match a query word marked. Works on the original text (diacritics and case kept). */
export function highlight(text: string, tokens: string[]): Piece[] {
  if (!text || !tokens.length) return [{ t: text, hit: false }];
  let folded = '';
  const end: number[] = []; // folded index → original index just after that character
  const start: number[] = [];
  let pos = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    for (let i = 0; i < f.length; i++) { start.push(pos); end.push(pos + ch.length); }
    folded += f;
    pos += ch.length;
  }
  const spans: [number, number][] = [];
  for (const token of tokens) {
    if (!token) continue;
    let from = 0;
    for (;;) {
      const at = folded.indexOf(token, from);
      if (at < 0) break;
      const startsWord = at === 0 || !/[\p{L}\p{N}]/u.test(folded[at - 1]);
      if (startsWord || token.length >= 3) spans.push([start[at], end[at + token.length - 1]]);
      from = at + Math.max(1, token.length);
    }
  }
  if (!spans.length) return [{ t: text, hit: false }];
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  const out: Piece[] = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) out.push({ t: text.slice(at, a), hit: false });
    out.push({ t: text.slice(a, b), hit: true });
    at = b;
  }
  if (at < text.length) out.push({ t: text.slice(at), hit: false });
  return out;
}
