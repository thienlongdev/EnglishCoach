/**
 * Hỏi vũ trụ — evidence-grounded question answering over the learner's universe (GraphRAG without a generative model).
 *
 * Retrieval: entity lookup (known stars first, then the verified lexicon, grammar topics by title), typed multi-hop search over
 * Open English WordNet relations at sense / synset level (never over screen distance), the learner's own evidence (cards,
 * ratings, completed sources, own writing / speech) and, on request, source sentences from the server (owner-scoped) and from
 * My Books highlights on this device. Every claim in an answer carries its citation: a WordNet relation with its senses, a piece
 * of the learner's evidence, or a sentence with its location. When the evidence does not answer the question the answer says so.
 *
 * Deterministic and AI-free: the same question on the same universe gives the same answer. Text from sources is DATA: it is
 * shown as a quotation and never decides a claim (a sentence saying "X causes Y" creates nothing). Runs in the worker (it needs
 * the full lexicon); `composePassages` and `findSpans` run on the page.
 */
import { formsOf, posOf, type Pos } from './inflect';
import type { Lexicon } from './lexicon';
import { RELATIONS, type RelationType } from './ontology';
import { canonicalLemma, isMet, soleSense } from './build';
import { memoryOf, MEMORY_LABEL } from './memory';
import type { CosmosGraph, CosmosNode, GrammarTopicLite } from './types';

export type Intent = 'connect' | 'trace' | 'passages' | 'unlearned' | 'meaning' | 'history' | 'unsupported';
export type AskStatus = 'answered' | 'insufficient' | 'unsupported' | 'not-found';

export interface AskEntity { text: string; lemma: string; node: number; inLexicon: boolean; grammar: string; forms: string[] }
export interface HopCite { a: string; b: string; type: RelationType; dir: 'up' | 'down' | 'same'; posA: string; posB: string; glossA: string; glossB: string }
export type Citation =
  | { kind: 'relation'; hops: HopCite[]; edge: number; distant: boolean }
  | { kind: 'evidence'; text: string; node: number }
  | { kind: 'sense'; lemma: string; pos: string; gloss: string }
  | { kind: 'passage'; ref: string; title: string; text: string; spans: [number, number, number][]; at: number; segmentId: number; local: boolean };
export interface AnswerLine { text: string; cites: number[] }
/** co-mention: both concepts in one sentence; occurrence: one concept; cause: sentences read for an EXPLICIT causal connective
 *  (the source's claim, never verified); adjacent: the two words standing next to each other (attested use, not a collocation). */
export interface PassagePlan { refs: string[]; local: string[]; groups: string[][]; purpose: 'co-mention' | 'occurrence' | 'cause' | 'adjacent' }
export interface AskResult {
  question: string; intent: Intent; status: AskStatus; entities: AskEntity[];
  lines: AnswerLine[]; citations: Citation[]; plan: PassagePlan | null;
  related: { lemma: string; type: RelationType; gloss: string; core: boolean }[];
  premise: { asked: string; holds: boolean } | null;
  /** Supported question shapes, offered when the question could not be answered from evidence. */
  hints: string[];
}

const MAX_HOPS = 4;
const MAX_PATHS = 3;
const MAX_VISITED = 120_000;
/** WordNet's most general concepts: true of almost everything, so a path through them explains nothing. */
const GENERIC = new Set(['entity', 'physical entity', 'abstraction', 'abstract entity', 'thing', 'object', 'physical object', 'whole', 'unit',
  'group', 'grouping', 'attribute', 'relation', 'measure', 'quantity', 'amount', 'psychological feature', 'event', 'act', 'deed', 'human action',
  'human activity', 'activity', 'state', 'process', 'physical process', 'matter', 'causal agent', 'cause', 'being', 'organism', 'living thing',
  'animate thing', 'artifact', 'artefact', 'instrumentality', 'location', 'communication', 'cognition', 'content', 'property', 'change', 'be', 'have',
  'make', 'do', 'get', 'move', 'travel', 'go', 'act', 'interact', 'social group', 'people', 'part', 'portion', 'region', 'point', 'time', 'period',
  'person', 'individual', 'someone', 'somebody', 'mortal', 'soul', 'substance', 'condition', 'feeling', 'idea', 'concept', 'conception', 'construct']);
const STOP_EN = new Set(('a an the and or of in on at to for from with by about as is are was were be been being do does did done have has had what which who whom whose why how when where '
  + 'there here this that these those it its i me my mine you your we our they their he she him her his not no yes can could would should will shall may might must '
  + 'between related relation relationship connect connected connects connection link linked links same different similar opposite meaning mean means define '
  + 'learn learned learnt learning study studied where word words concept concepts sentence sentences passage passages example examples show tell explain '
  + 'other others more most some any all each every than then so if but also just only very much many into out up down over under please '
  + 'reading listening writing speaking grammar source sources appear appears appeared use used across through haven hasn didn don doesn isn aren t s '
  + 'cause causes caused causing synonym synonyms antonym antonyms opposite opposites kind type part whole family related relate '
  + 'meet met see saw seen find found know knew known hear heard read encounter encountered come came get got give gave first last time times').split(' '));
const STOP_VI_ASCII = new Set('an con do ma la va voi cua co gi nao toi ban the nay khi tu hai mot cho den sao vi nhu hay hoc nhung cac nghia tai sau truoc quan nam tim cung trong hon nhieu khong chua roi vao ra len xuong kia lien ket noi gap doc nghe viet noi cau doan tu'.split(' '));
const HINTS_VI = ['Vì sao "bank" và "river" liên quan?', 'Tôi đã gặp "climate" ở đâu?', 'Tuần này tôi đã học những từ nào?', 'Từ nào tôi hay vấp?', 'Câu nào có cả "water" và "river"?', '"bank" có những nghĩa nào?'];
const HINTS_EN = ['Why are "bank" and "river" related?', 'Where did I meet "climate"?', 'Which words did I study this week?', 'Which words do I find hard?', 'Which sentences have both "water" and "river"?', 'What are the senses of "bank"?'];

/** Indexes the worker keeps beside the graph (built once per graph). */
export interface AskIndex { formToNode: Map<string, number>; lemmaToNode: Map<string, number>; grammar: { slug: string; vi: string; en: string; node: number }[] }

export function buildAskIndex(lex: Lexicon, graph: CosmosGraph, topics: GrammarTopicLite[] | null): AskIndex {
  const formToNode = new Map<string, number>(), lemmaToNode = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.kind !== 'word') continue;
    lemmaToNode.set(n.label, n.i);
    for (const f of formsOf(n.label, n.pos.length ? n.pos : lex.posSet(n.label))) if (!formToNode.has(f)) formToNode.set(f, n.i);
  }
  const byNode = new Map(graph.nodes.filter(n => n.kind === 'grammar').map(n => [n.ref, n.i]));
  const grammar = (topics ?? []).map(t => ({ slug: t.slug, vi: t.vi, en: t.en, node: byNode.get(t.slug) ?? -1 }));
  for (const n of graph.nodes) if (n.kind === 'grammar' && !grammar.some(g => g.slug === n.ref)) grammar.push({ slug: n.ref, vi: n.sub, en: n.label, node: n.i });
  return { formToNode, lemmaToNode, grammar };
}

// ── question understanding ──────────────────────────────────────────────────────────────────────────────────────────
const fold = (s: string) => s.normalize('NFC').toLowerCase().replace(/[’‘]/g, "'");
export function detectIntent(q: string, entityCount: number): Intent {
  const t = fold(q);
  if (/(chưa học|chưa biết|chưa gặp|nên học thêm|haven'?t (yet )?(learn|stud|met)|not (yet )?(learn|stud)|unlearned|what else|related words|từ liên quan)/.test(t)) return 'unlearned';
  if (/(câu nào|đoạn nào|trích|ví dụ trong|which (sentence|passage)|show (me )?(the )?(sentence|passage)|example sentence|passages? (with|that|where)|sentences? (with|that|where))/.test(t)) return 'passages';
  if (entityCount >= 2) return 'connect';
  if (/(liên quan|liên hệ|kết nối|nối với|quan hệ|related|connect|relationship|link between)/.test(t) && entityCount >= 2) return 'connect';
  if (/(nghĩa (của|là)|có nghĩa|nghĩa gì|là gì|những nghĩa|các nghĩa|what does .* mean|meaning|senses? of|define|definition)/.test(t)) return entityCount ? 'meaning' : 'unsupported';
  if (/(ở đâu|khi nào|gặp|đã học|đọc|nghe|viết|nói|kỹ năng|where|when|which (lesson|source|skill)|across|in (my )?(reading|listening|writing|speaking))/.test(t)) return entityCount ? 'trace' : 'unsupported';
  return entityCount === 1 ? 'trace' : 'unsupported';
}

export type HistoryKind = 'recent' | 'atRisk' | 'hard' | 'stable' | 'cross';
/** "Which words did I learn this week?" — a question about the learner's own record, answered from evidence only. */
export function historyKind(q: string): { kind: HistoryKind; days: number } | null {
  const t = fold(q);
  if (/["“”«»]/.test(t)) return null;
  if (!/(từ nào|những từ|các từ|chủ điểm nào|từ gì|which words|what words|which topics|words? (did|have|am|do) i|my words)/.test(t)) return null;
  if (/(sắp quên|nguy cơ|hay quên|đang quên|mờ dần|lâu không ôn|forget|fading|at risk)/.test(t)) return { kind: 'atRisk', days: 0 };
  if (/(hay vấp|khó nhất|chấm khó|thấy khó|struggl|difficult|hardest|find hard|rated hard)/.test(t)) return { kind: 'hard', days: 0 };
  if (/(vững|thành thạo|nắm chắc|đã thuộc|stable|mastered|know well)/.test(t)) return { kind: 'stable', days: 0 };
  if (/(nhiều kỹ năng|qua các kỹ năng|across skills|cross-skill|in my writing|in my speaking|tự dùng|đã dùng khi)/.test(t)) return { kind: 'cross', days: 0 };
  if (/(hôm nay|today)/.test(t)) return { kind: 'recent', days: 1 };
  if (/(tuần này|7 ngày|tuần qua|this week|past week|last week|last 7 days)/.test(t)) return { kind: 'recent', days: 7 };
  if (/(tháng này|30 ngày|tháng qua|this month|past month|last month|last 30 days)/.test(t)) return { kind: 'recent', days: 30 };
  if (/(gần đây|dạo này|recently|lately)/.test(t)) return { kind: 'recent', days: 14 };
  return null;
}

/** An explicit causal statement in a sentence between the spans of two concepts (groups 0 and 1): the SOURCE's claim. */
export interface CausalReading { connective: string; cause: 0 | 1; negated: boolean; hedged: boolean }
const CAUSAL: [RegExp, 'forward' | 'reverse'][] = [
  [/\b(?:is|are|was|were|been|being)?\s*(?:caused|triggered|produced) by\b/, 'reverse'],
  [/\b(?:because of|due to|as a result of|owing to)\b/, 'reverse'],
  [/\b(?:results?|resulted|resulting|stems?|stemmed|arises?|arose) from\b/, 'reverse'],
  [/\bbecause\b/, 'reverse'],
  [/\b(?:causes?|caused|causing)\b/, 'forward'],
  [/\b(?:leads?|led|leading) to\b/, 'forward'],
  [/\b(?:results?|resulted|resulting) in\b/, 'forward'],
  [/\b(?:gives?|gave|giving|given) rise to\b/, 'forward'],
  [/\b(?:brings?|brought|bringing) about\b/, 'forward'],
  [/\b(?:triggers?|triggered|triggering)\b/, 'forward'],
];
export function causalReading(sentence: string, spans: [number, number, number][] | null): CausalReading | null {
  if (!spans) return null;
  const low = sentence.normalize('NFC').replace(/’/g, "'").toLowerCase();
  const a = spans.find(x => x[2] === 0), b = spans.find(x => x[2] === 1);
  if (!a || !b) return null;
  const [first, second] = a[0] < b[0] ? [a, b] : [b, a];
  if (first[1] > second[0]) return null;
  const between = low.slice(first[1], second[0]);
  if (between.length > 140 || /[;:]/.test(between)) return null;
  const found: { text: string; dir: 'forward' | 'reverse'; start: number; end: number }[] = [];
  for (const [re, dir] of CAUSAL) {
    for (const m of between.matchAll(new RegExp(re.source, 'g'))) {
      const at = m.index!, to = at + m[0].length;
      // the NOUN "cause" / "result" / "trigger" ("the exact cause of", "a trigger for") states no link between the two words
      const lead = between.slice(0, at).trimEnd();
      if (/^(?:causes?|results?|triggers?)$/.test(m[0].trim()) && (/\b(?:the|a|an|its|their|his|her|our|my|your|this|that|main|root|exact|real|leading|primary|major|common|one|probable|likely|underlying)$/.test(lead) || /^\s+(?:of|for|behind)\b/.test(between.slice(to)))) continue;
      found.push({ text: m[0].trim(), dir, start: at + (m[0].length - m[0].trimStart().length), end: to });
    }
  }
  // one connective only ("caused by" contains "caused": the longer one is the connective); two different ones = ambiguous
  const distinct = found.filter(f => !found.some(o => o !== f && o.start <= f.start && o.end >= f.end && o.end - o.start > f.end - f.start))
    .filter((f, i, all) => all.findIndex(o => o.start === f.start && o.end === f.end) === i);
  if (distinct.length !== 1) return null;
  const c = distinct[0];
  // both words close to the connective (≤ 3 words each side: a modal, an adverb, a determiner); farther words are not its arguments
  const count = (t: string) => (t.match(/[a-z]+(?:'[a-z]+)?/g) ?? []).length;
  if (count(between.slice(0, c.start)) > 3 || count(between.slice(c.end)) > 3) return null;
  const firstGroup = first[2] as 0 | 1, secondGroup = second[2] as 0 | 1;
  return {
    connective: c.text,
    cause: c.dir === 'forward' ? firstGroup : secondGroup,
    negated: /\b(?:not|never|no|cannot|can't|doesn't|don't|didn't|isn't|aren't|wasn't|weren't|won't|neither|nor)\b|n't\b/.test(between),
    hedged: /\b(?:may|might|can|could|possibly|perhaps|likely|sometimes|often)\b/.test(between),
  };
}
/** The two concepts stand next to each other (either order), only spaces between them. */
export function adjacentPair(sentence: string, spans: [number, number, number][]): boolean {
  if (!spans) return false;
  for (const x of spans) for (const y of spans) {
    if (x[2] === y[2] || y[0] < x[1]) continue;
    if (/^\s+$/.test(sentence.slice(x[1], y[0])) && y[0] - x[1] <= 2) return true;
  }
  return false;
}

/** Words / topics named in the question: quoted text first, then known stars, then everyday lexicon words, then grammar titles. */
export function findEntities(lex: Lexicon, idx: AskIndex, q: string): AskEntity[] {
  const out: AskEntity[] = [];
  const seen = new Set<string>();
  const t = fold(q);
  const push = (text: string, lemma: string, node: number, grammar = '') => {
    const key = grammar ? `g:${grammar}` : `w:${lemma}`;
    if (seen.has(key) || out.length >= 3) return;
    seen.add(key);
    const inLexicon = !grammar && lex.lemmaIndex.has(lemma);
    out.push({ text, lemma, node, inLexicon, grammar, forms: grammar ? [] : [...formsOf(lemma, lex.posSet(lemma).size ? lex.posSet(lemma) : (['n'] as Pos[]))] });
  };
  // grammar topics by their title (the learner's own wording), longest first
  for (const g of [...idx.grammar].sort((a, b) => b.en.length - a.en.length)) {
    for (const title of [g.vi, g.en, g.slug.replace(/-/g, ' ')]) {
      const tt = fold(title || '');
      if (tt.length >= 6 && t.includes(tt)) { push(title, g.slug, g.node, g.slug); break; }
    }
  }
  const unknown: string[] = [];
  const quoted = [...t.matchAll(/["“”«»]([^"“”«»]{1,60})["“”«»]/g)].map(m => m[1].trim()).filter(Boolean);
  for (const raw of quoted) resolveWord(raw, true);
  // words the learner quoted are the question's subject; bare words are scanned only without quotes
  if (!quoted.length && out.length < 2) {
    // whole words in any script; a Vietnamese word is never cut into ASCII pieces ("giữa" is not "gi")
    const toks = (t.match(/\p{L}+(?:['-]\p{L}+)*/gu) ?? []).map(w => (/^[a-z'-]+$/.test(w) ? w : ''));
    for (let i = 0; i < toks.length && out.length < 3; i++) {
      // longest phrase first ("look after", "ice cream")
      let used = 0;
      for (let len = 3; len >= 2 && !used; len--) {
        if (i + len > toks.length) continue;
        if (toks.slice(i, i + len).some(x => !x)) continue;
        const phrase = toks.slice(i, i + len).join(' ');
        if (idx.lemmaToNode.has(phrase) || lex.lemmaIndex.has(phrase)) { resolveWord(phrase, false); used = len; }
      }
      if (used) { i += used - 1; continue; }
      const w = toks[i];
      if (!w || STOP_EN.has(w) || STOP_VI_ASCII.has(w) || w.length < 2) continue;
      if (!resolveWord(w, false) && w.length >= 4) unknown.push(w);
    }
  }
  // a two-concept question naming a word the map does not have ("although"): that word is reported as not found, never dropped
  if (out.length === 1 && unknown.length && /(liên quan|liên hệ|đồng nghĩa|trái nghĩa|giống|khác|related|synonym|antonym|same|differ| và | and )/.test(t)) push(unknown[0], unknown[0], -1);
  return out;

  function resolveWord(raw: string, quotedWord: boolean): boolean {
    const w = raw.replace(/\s+/g, ' ').trim();
    const known = idx.lemmaToNode.get(w) ?? idx.formToNode.get(w);
    if (known !== undefined) { push(raw, knownLabel(known), known); return true; }
    const lemma = canonicalLemma(lex, w);
    if (lemma && lex.lemmaIndex.has(lemma)) { push(raw, lemma, idx.lemmaToNode.get(lemma) ?? -1); return true; }
    const base = baseForm(lex, w);
    if (base) { push(raw, base, idx.lemmaToNode.get(base) ?? -1); return true; }
    if (quotedWord) { push(raw, w, -1); return true; } // named explicitly but unknown: answered as "not found", never guessed
    return false;
  }
  function knownLabel(i: number) { for (const [l, n] of idx.lemmaToNode) if (n === i) return l; return ''; }
}

/** A regular inflection back to a lexicon lemma ("studied" -> "study", "ran" -> "run"), checked by generating forms forward. */
function baseForm(lex: Lexicon, w: string): string {
  const cands = new Set<string>();
  if (w.endsWith('ies')) cands.add(w.slice(0, -3) + 'y');
  if (w.endsWith('ied')) cands.add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) cands.add(w.slice(0, -2));
  if (w.endsWith('s')) cands.add(w.slice(0, -1));
  if (w.endsWith('ed')) { cands.add(w.slice(0, -2)); cands.add(w.slice(0, -1)); cands.add(w.slice(0, -3)); }
  if (w.endsWith('ing')) { cands.add(w.slice(0, -3)); cands.add(w.slice(0, -3) + 'e'); cands.add(w.slice(0, -4)); }
  if (w.endsWith('er') || w.endsWith('est')) { const s = w.replace(/(er|est)$/, ''); cands.add(s); cands.add(s + 'e'); cands.add(s.replace(/i$/, 'y')); cands.add(s.slice(0, -1)); }
  for (const c of cands) if (c.length >= 2 && lex.lemmaIndex.has(c) && formsOf(c, lex.posSet(c)).has(w)) return c;
  // irregular forms (only verbs / nouns / adjectives the inflection table lists)
  for (const c of IRREGULAR_BASES) if (lex.lemmaIndex.has(c) && formsOf(c, lex.posSet(c)).has(w)) return c;
  return '';
}
const IRREGULAR_BASES = 'be have do go say make take see come give get know think find tell become leave feel bring begin keep hold write stand hear mean meet run pay sit speak lie lead read grow lose fall send build understand draw break spend cut rise drive buy wear choose eat drink sing swim fly teach catch fight throw sleep sell steal child man woman person foot tooth mouse goose life knife leaf half wolf good bad far little many much'.split(' ');

// ── typed multi-hop search over the verified lexicon ────────────────────────────────────────────────────────────────
interface Step { syn: number; type: RelationType; dir: 'up' | 'down' | 'same'; senses?: [number, number] }
interface Path { start: number; startSense: number; endSense: number; steps: Step[] }

function neighbours(lex: Lexicon, syn: number): Step[] {
  const out: Step[] = [];
  for (const p of lex.parents.get(syn) ?? []) out.push({ syn: p.syn, type: 'HYPERNYM_OF', dir: 'up' });
  for (const c of lex.children.get(syn) ?? []) out.push({ syn: c, type: 'HYPERNYM_OF', dir: 'down' });
  for (const w of lex.wholes.get(syn) ?? []) out.push({ syn: w, type: 'PART_OF', dir: 'up' });
  for (const p of lex.parts.get(syn) ?? []) out.push({ syn: p, type: 'PART_OF', dir: 'down' });
  if (lex.pos(syn) === 'a') for (const s of lex.similar.get(syn) ?? []) out.push({ syn: s, type: 'SIMILAR_TO', dir: 'same' });
  for (const m of lex.membersOf.get(syn) ?? []) {
    for (const r of lex.senseRels.get(m) ?? []) out.push({ syn: lex.synOf(r.other), type: r.code === 'A' ? 'ANTONYM_OF' : 'DERIVED_FORM', dir: 'same', senses: [m, r.other] });
  }
  return out;
}
const generic = (lex: Lexicon, syn: number) => GENERIC.has(lex.synName(syn));

/**
 * Shortest typed paths (≤ 4 relations) from a sense of A to a sense of B. A path never goes down a hierarchy and back up
 * (siblings of siblings say nothing) and never passes through WordNet's most general concepts. Shared synset = synonyms.
 */
export function findPaths(lex: Lexicon, a: string, b: string, posA: Pos[] = [], posB: Pos[] = []): Path[] {
  const fit = (s: number, pos: Pos[]) => !pos.length || pos.includes(lex.pos(lex.synOf(s)));
  const sa = lex.senses(a).filter(s => fit(s, posA)), sb = lex.senses(b).filter(s => fit(s, posB));
  if (!sa.length || !sb.length || a === b) return [];
  const goal = new Map<number, number>(); // synset -> best (most common) sense of B
  for (const s of sb) { const syn = lex.synOf(s); if (!goal.has(syn) || lex.rank(s) < lex.rank(goal.get(syn)!)) goal.set(syn, s); }
  const found: Path[] = [];
  // shared synset (0 relations): synonyms in that sense
  for (const s of sa) { const syn = lex.synOf(s); if (goal.has(syn)) found.push({ start: syn, startSense: s, endSense: goal.get(syn)!, steps: [] }); }
  if (found.length) return rankPaths(lex, found);
  type Q = { syn: number; prev: number; step: Step | null; depth: number; descended: boolean; startSense: number };
  const nodes: Q[] = [];
  const seen = new Map<number, number>(); // synset -> depth reached
  for (const s of sa) { const syn = lex.synOf(s); if (!seen.has(syn)) { seen.set(syn, 0); nodes.push({ syn, prev: -1, step: null, depth: 0, descended: false, startSense: s }); } }
  let head = 0, bestDepth = Infinity;
  while (head < nodes.length && nodes.length < MAX_VISITED) {
    const cur = nodes[head++];
    if (cur.depth >= MAX_HOPS || cur.depth >= bestDepth) continue;
    for (const st of neighbours(lex, cur.syn)) {
      if (cur.descended && st.dir === 'up') continue;         // no valley: down then up
      const d = cur.depth + 1;
      if (goal.has(st.syn)) {
        bestDepth = Math.min(bestDepth, d);
        const steps: Step[] = [st];
        for (let k = head - 1; nodes[k].prev >= 0; k = nodes[k].prev) steps.unshift(nodes[k].step!);
        found.push({ start: nodes[rootOf(head - 1)].syn, startSense: cur.startSense, endSense: goal.get(st.syn)!, steps });
        continue;
      }
      if (generic(lex, st.syn)) continue;
      const was = seen.get(st.syn);
      if (was !== undefined && was <= d) continue;
      seen.set(st.syn, d);
      nodes.push({ syn: st.syn, prev: head - 1, step: st, depth: d, descended: cur.descended || st.dir === 'down', startSense: cur.startSense });
    }
  }
  return rankPaths(lex, found);

  function rootOf(k: number) { while (nodes[k].prev >= 0) k = nodes[k].prev; return k; }
}
function rankPaths(lex: Lexicon, paths: Path[]): Path[] {
  const score = (p: Path) => p.steps.length * 10 + lex.rank(p.startSense) + lex.rank(p.endSense) + p.steps.filter(s => !lex.core.has(lex.lemmaIndex.get(lex.synName(s.syn)) ?? -1)).length;
  const out: Path[] = [], keys = new Set<string>();
  for (const p of [...paths].sort((x, y) => score(x) - score(y))) {
    const key = `${p.startSense}:${p.endSense}`;
    if (keys.has(key)) continue;
    keys.add(key); out.push(p);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

// ── answering ───────────────────────────────────────────────────────────────────────────────────────────────────────
const POS_VI: Record<string, string> = { n: 'danh từ', v: 'động từ', a: 'tính từ', r: 'trạng từ' };
const POS_EN: Record<string, string> = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' };
const ASKED: [RegExp, RelationType | 'CAUSES' | 'COLLOCATION_WITH', string, string][] = [
  [/(đồng nghĩa|synonym)/, 'SYNONYM_OF', 'đồng nghĩa', 'synonyms'],
  [/(trái nghĩa|ngược nghĩa|antonym|opposite)/, 'ANTONYM_OF', 'trái nghĩa', 'antonyms'],
  [/(bộ phận|một phần của|part of)/, 'PART_OF', 'bộ phận', 'part of'],
  [/(là một loại|một loại của|kind of|type of)/, 'HYPERNYM_OF', 'một loại của', 'a kind of'],
  [/(cùng gốc|word family|derived)/, 'DERIVED_FORM', 'cùng gốc', 'one word family'],
  [/(gây ra|nguyên nhân|dẫn đến|causes?|because of)/, 'CAUSES', 'nhân quả', 'cause'],
  [/(collocation|kết hợp từ|đi với|đi kèm)/, 'COLLOCATION_WITH', 'kết hợp từ', 'collocation'],
];

export function answer(lex: Lexicon, graph: CosmosGraph, idx: AskIndex, question: string, vi: boolean, focusNode = -1): AskResult {
  const T = (a: string, b: string) => (vi ? a : b);
  const q = question.trim().slice(0, 300);
  const hist = historyKind(q);
  let entities = hist ? [] : findEntities(lex, idx, q);
  // "this word" / a question without a word: the selected star is the subject
  if (entities.length < 2 && focusNode >= 0 && graph.nodes[focusNode] && /(từ này|chủ điểm này|nó|this|it\b)/i.test(q) || entities.length === 0 && focusNode >= 0 && graph.nodes[focusNode]) {
    const n = graph.nodes[focusNode];
    if (n.kind === 'word' && !entities.some(e => e.lemma === n.label)) entities = [{ text: n.label, lemma: n.label, node: n.i, inLexicon: lex.lemmaIndex.has(n.label), grammar: '', forms: [...formsOf(n.label, n.pos.length ? n.pos : lex.posSet(n.label))] }, ...entities];
    else if (n.kind === 'grammar' && !entities.some(e => e.grammar === n.ref)) entities = [{ text: n.sub || n.label, lemma: n.ref, node: n.i, inLexicon: false, grammar: n.ref, forms: [] }, ...entities];
  }
  const intent: Intent = hist ? 'history' : detectIntent(q, entities.length);
  const res: AskResult = { question: q, intent, status: 'answered', entities, lines: [], citations: [], plan: null, related: [], premise: null, hints: vi ? HINTS_VI : HINTS_EN };
  const cite = (c: Citation) => { res.citations.push(c); return res.citations.length - 1; };
  const line = (text: string, cites: number[] = []) => res.lines.push({ text, cites });
  const name = (e: AskEntity) => (e.grammar ? `"${e.text}"` : `"${e.lemma}"`);
  const missing = entities.filter(e => !e.grammar && !e.inLexicon && e.node < 0);

  if (hist) { history(hist.kind, hist.days); return res; }
  if (intent === 'unsupported' || !entities.length) {
    res.status = 'unsupported';
    line(T('Vũ trụ chỉ trả lời bằng bằng chứng của nó: quan hệ đã kiểm chứng trong WordNet và Grammar Academy, thẻ và bài học của bạn, và các câu trong nguồn bạn đã học. Câu hỏi này không nêu từ hay chủ điểm nào có trong đó, hoặc cần suy luận ngoài bằng chứng.',
      'The universe answers only from its evidence: verified WordNet and Grammar Academy relations, your cards and lessons, and sentences in sources you studied. This question names no word or topic found there, or needs reasoning beyond that evidence.'));
    return res;
  }
  if (missing.length) {
    res.status = 'not-found';
    line(T(`Không tìm thấy ${missing.map(name).join(', ')} trong bản đồ từ vựng đã kiểm chứng hay trong vũ trụ của bạn. WordNet chỉ có danh từ, động từ, tính từ và trạng từ (không có liên từ, giới từ như "although"); vũ trụ không đoán nghĩa hay quan hệ của từ nó không có.`,
      `${missing.map(name).join(', ')} is not in the verified word map or in your universe. WordNet holds nouns, verbs, adjectives and adverbs only (no conjunctions or prepositions such as "although"); the universe does not guess meanings or relations of words it does not have.`));
    return res;
  }

  if (intent === 'connect' && entities.length >= 2) {
    const [A, B] = entities;
    const asked = ASKED.find(([re]) => re.test(fold(q)));
    if (asked && (asked[1] === 'CAUSES' || asked[1] === 'COLLOCATION_WITH')) {
      res.premise = { asked: vi ? asked[2] : asked[3], holds: false };
      res.status = 'insufficient';
      line(T(`Vũ trụ chưa kiểm chứng quan hệ ${asked[2]}: chưa có nguồn bằng chứng đáng tin cho loại quan hệ này, nên nó không khẳng định cũng không phủ nhận.`,
        `The universe does not verify ${asked[3]} relations yet: there is no reliable evidence source for that type, so it neither claims nor denies one.`));
    }
    if (!asked && /^\s*(vì sao|tại sao|why)\b/.test(fold(q)) && !/(liên quan|liên hệ|kết nối|nối với|quan hệ|related|connect|relationship|link)/.test(fold(q))) {
      res.premise = { asked: vi ? 'giải thích nguyên nhân' : 'an explanation of causes', holds: false };
      res.status = 'insufficient';
      line(T('Câu hỏi "vì sao" về nguyên nhân cần kiến thức ngoài bằng chứng của vũ trụ, nên vũ trụ không trả lời phần đó. Dưới đây chỉ là các quan hệ đã kiểm chứng giữa những từ trong câu hỏi.',
        'A "why" question about causes needs knowledge beyond the universe\'s evidence, so that part is not answered. Below are only the verified relations between the words in the question.'));
    }
    if (A.grammar || B.grammar) connectGrammar(A, B);
    else connectWords(A, B, asked && asked[1] !== 'CAUSES' && asked[1] !== 'COLLOCATION_WITH' ? asked : null);
    if (asked?.[1] === 'COLLOCATION_WITH' && !A.grammar && !B.grammar) fixedPhrase(A, B);
    const causal = asked?.[1] === 'CAUSES' || (res.premise?.asked === (vi ? 'giải thích nguyên nhân' : 'an explanation of causes'));
    planSources([A, B], causal ? 'cause' : asked?.[1] === 'COLLOCATION_WITH' ? 'adjacent' : 'co-mention');
    return res;
  }

  const E = entities[0];
  if (intent === 'meaning') {
    if (E.grammar) { traceGrammar(E); return res; }
    const n = E.node >= 0 ? graph.nodes[E.node] : null;
    if (n?.sub) line(T(`Nghĩa trên thẻ của bạn: ${n.sub}.`, `Meaning on your card: ${n.sub}.`), [cite({ kind: 'evidence', text: T(`Thẻ "${n.label}"`, `Card "${n.label}"`), node: n.i })]);
    const senses = lex.senses(E.lemma).slice(0, 8);
    const byPos = new Map<string, number>();
    for (const s of senses) {
      const syn = lex.synOf(s), p = lex.pos(syn);
      byPos.set(p, (byPos.get(p) ?? 0) + 1);
      line(`${byPos.get(p)}. (${(vi ? POS_VI : POS_EN)[p]}) ${lex.gloss(syn)}`, [cite({ kind: 'sense', lemma: E.lemma, pos: p, gloss: lex.gloss(syn) })]);
    }
    if (lex.senses(E.lemma).length > senses.length) line(T(`Còn ${lex.senses(E.lemma).length - senses.length} nghĩa hiếm hơn trong WordNet.`, `${lex.senses(E.lemma).length - senses.length} rarer senses are in WordNet too.`));
    line(T('Nghĩa tiếng Anh từ Open English WordNet 2025; các nghĩa không bao giờ được gộp. Nghĩa trên thẻ không xác định bạn học nghĩa WordNet nào.', 'English senses from Open English WordNet 2025, never merged. The meaning on a card does not tell which WordNet sense you learned.'));
    return res;
  }
  if (intent === 'unlearned') {
    if (E.grammar) { unlearnedGrammar(E); return res; }
    unlearned(E);
    return res;
  }
  if (intent === 'passages') {
    if (E.grammar) { traceGrammar(E); return res; }
    planSources(entities.slice(0, 2), entities.length >= 2 ? 'co-mention' : 'occurrence');
    if (!res.plan) { res.status = 'insufficient'; line(T(`Chưa có nguồn nào bạn đã học chứa ${entities.slice(0, 2).map(name).join(' và ')}.`, `None of the sources you studied contains ${entities.slice(0, 2).map(name).join(' and ')} yet.`)); }
    else line(T(`Các câu dưới đây lấy từ nguồn bạn đã hoàn thành hoặc tự viết, nói.`, `The sentences below come from sources you completed or wrote / said yourself.`));
    return res;
  }
  // trace (where / when / across skills)
  if (E.grammar) { traceGrammar(E); return res; }
  traceWord(E);
  return res;

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
  function sensePos(s: number) { return lex.pos(lex.synOf(s)); }
  function hopCites(p: Path, a: string): HopCite[] {
    const hops: HopCite[] = [];
    let prevSyn = p.start, prevName = a, prevGloss = lex.gloss(p.start), prevPos: string = lex.pos(p.start);
    p.steps.forEach((st, k) => {
      const last = k === p.steps.length - 1;
      const name = last ? lex.lemmaOf(p.endSense) : lex.synName(st.syn);
      hops.push({ a: prevName, b: name, type: st.type, dir: st.dir, posA: prevPos, posB: lex.pos(st.syn), glossA: prevGloss, glossB: lex.gloss(st.syn) });
      prevSyn = st.syn; prevName = name; prevGloss = lex.gloss(st.syn); prevPos = lex.pos(st.syn);
    });
    void prevSyn;
    return hops;
  }
  function hopText(h: HopCite) {
    const r = RELATIONS[h.type];
    if (h.type === 'HYPERNYM_OF') return h.dir === 'up' ? T(`"${h.a}" là một loại của "${h.b}"`, `"${h.a}" is a kind of "${h.b}"`) : T(`"${h.b}" là một loại của "${h.a}"`, `"${h.b}" is a kind of "${h.a}"`);
    if (h.type === 'PART_OF') return h.dir === 'up' ? T(`"${h.a}" là một bộ phận của "${h.b}"`, `"${h.a}" is a part of "${h.b}"`) : T(`"${h.b}" là một bộ phận của "${h.a}"`, `"${h.b}" is a part of "${h.a}"`);
    return T(`"${h.a}" — ${r.vi.toLowerCase()} — "${h.b}"`, `"${h.a}" — ${r.en.toLowerCase()} — "${h.b}"`);
  }
  function clip(t: string) { return t.length > 90 ? `${t.slice(0, 88)}…` : t; }
  function directEdge(a: number, b: number) {
    return graph.edges.findIndex(e => e.status === 'VERIFIED' && e.note !== 'concept' && ((e.s === a && e.t === b) || (e.s === b && e.t === a)));
  }
  function connectWords(A: AskEntity, B: AskEntity, asked: (typeof ASKED)[number] | null) {
    const nA = A.node >= 0 ? graph.nodes[A.node] : null, nB = B.node >= 0 ? graph.nodes[B.node] : null;
    const paths = findPaths(lex, A.lemma, B.lemma);
    if (!paths.length) {
      res.status = 'insufficient';
      if (asked) res.premise = { asked: vi ? asked[2] : asked[3], holds: false };
      line(T(`Không có quan hệ đã kiểm chứng nào giữa "${A.lemma}" và "${B.lemma}" trong WordNet (tìm tới ${MAX_HOPS} bước, không đi qua các khái niệm quá chung). Vì vậy vũ trụ không nối hai từ này.`,
        `There is no verified relation between "${A.lemma}" and "${B.lemma}" in WordNet (searched up to ${MAX_HOPS} steps, not through the most general concepts). So the universe does not link them.`));
      return;
    }
    const best = paths[0];
    const direct = best.steps.length <= 1;
    if (asked) {
      const holds = best.steps.length === 0 ? asked[1] === 'SYNONYM_OF' : best.steps.length === 1 && best.steps[0].type === asked[1];
      res.premise = { asked: vi ? asked[2] : asked[3], holds };
      if (!holds) line(T(`Theo WordNet, "${A.lemma}" và "${B.lemma}" không phải ${asked[2]}. Quan hệ đã kiểm chứng gần nhất là:`, `According to WordNet, "${A.lemma}" and "${B.lemma}" are not ${asked[3]}. The closest verified relation is:`));
    }
    paths.forEach((p, k) => {
      const hops = hopCites(p, A.lemma);
      const edge = nA && nB && p.steps.length <= 1 ? directEdge(nA.i, nB.i) : -1;
      const c = cite({ kind: 'relation', hops, edge, distant: p.steps.length >= 3 });
      const one = (lemma: string, sense: number) => {
        // the sense's place in WordNet's own order (a fact), never a frequency claim
        const r = lex.rank(sense);
        return T(`nghĩa ${POS_VI[sensePos(sense)]}${r > 1 ? ` thứ ${r}` : ''} của "${lemma}": ${clip(lex.gloss(lex.synOf(sense)))}`, `${POS_EN[sensePos(sense)]} sense${r > 1 ? ` no. ${r}` : ''} of "${lemma}": ${clip(lex.gloss(lex.synOf(sense)))}`);
      };
      const senseNote = one(A.lemma, p.startSense);
      const bothNote = `${one(A.lemma, p.startSense)}; ${one(B.lemma, p.endSense)}`;
      if (!p.steps.length) line(T(`${k ? 'Ngoài ra, ' : ''}"${A.lemma}" và "${B.lemma}" đồng nghĩa trong một nghĩa cụ thể (cùng synset) — ${senseNote}.`, `${k ? 'Also, ' : ''}"${A.lemma}" and "${B.lemma}" are synonyms in one specific sense (one synset) — ${senseNote}.`), [c]);
      else {
        const shared = sharedAncestor(p);
        const chain = hops.map(hopText).join(T('; ', '; '));
        const lead = shared ? T(`"${A.lemma}" và "${B.lemma}" cùng là một loại của "${shared}"`, `"${A.lemma}" and "${B.lemma}" are both a kind of "${shared}"`) : T(`"${A.lemma}" nối với "${B.lemma}" qua ${p.steps.length} quan hệ`, `"${A.lemma}" connects to "${B.lemma}" through ${p.steps.length} relation(s)`);
        line(`${k ? T('Một đường khác: ', 'Another path: ') : ''}${lead}: ${chain} (${bothNote}).${p.steps.length >= 3 ? T(' Liên hệ xa: đúng theo từng bước, nhưng không phải hai từ gần nghĩa.', ' A distant link: each step holds, yet the words are not close in meaning.') : ''}`, [c]);
      }
    });
    if (!direct) line(T('Mỗi bước là một quan hệ WordNet giữa hai nghĩa cụ thể; một đường nhiều bước không có nghĩa là hai từ đồng nghĩa.', 'Each step is a WordNet relation between two specific senses; a multi-step path does not make the words synonyms.'));
    const known = [nA, nB].filter(n => n && n.cardIds.length) as CosmosNode[];
    if (known.length) line(T(`Trong vũ trụ của bạn: ${known.map(n => `"${n.label}"`).join(' và ')} là ngôi sao của bạn${known.length < 2 ? `; "${(known[0] === nA ? B : A).lemma}" thì chưa` : ''}.`, `In your universe: ${known.map(n => `"${n.label}"`).join(' and ')} ${known.length > 1 ? 'are' : 'is'} your star${known.length > 1 ? 's' : ''}${known.length < 2 ? `; "${(known[0] === nA ? B : A).lemma}" is not yet` : ''}.`),
      known.map(n => cite({ kind: 'evidence', text: T(`Ngôi sao "${n.label}"`, `Star "${n.label}"`), node: n.i })));
    function sharedAncestor(p: Path) {
      const ups = p.steps.findIndex(s => s.dir === 'down');
      if (ups <= 0 || !p.steps.slice(0, ups).every(s => s.type === 'HYPERNYM_OF' && s.dir === 'up') || !p.steps.slice(ups).every(s => s.type === 'HYPERNYM_OF' && s.dir === 'down')) return '';
      return lex.synName(p.steps[ups - 1].syn);
    }
  }
  function connectGrammar(A: AskEntity, B: AskEntity) {
    if (!A.grammar || !B.grammar) {
      res.status = 'insufficient';
      line(T('Vũ trụ không nối một từ với một chủ điểm ngữ pháp: chưa có bộ kiểm chứng mẫu ngữ pháp theo từ.', 'The universe does not link a word to a grammar topic: there is no word-level grammar-pattern validator yet.'));
      return;
    }
    // breadth-first over the authored catalog links between the learner's own topics
    const start = A.node, goal = B.node;
    if (start < 0 || goal < 0) { res.status = 'insufficient'; line(T('Một trong hai chủ điểm chưa có trong vũ trụ của bạn (chưa mở bài học đó).', 'One of the topics is not in your universe yet (you have not opened it).')); return; }
    const prev = new Map<number, number>([[start, -1]]);
    const via = new Map<number, number>();
    const queue = [start];
    while (queue.length && !prev.has(goal)) {
      const cur = queue.shift()!;
      for (const e of graph.edges) {
        if (e.category !== 'grammar' || (e.s !== cur && e.t !== cur)) continue;
        const o = e.s === cur ? e.t : e.s;
        if (prev.has(o)) continue;
        prev.set(o, cur); via.set(o, e.i); queue.push(o);
      }
    }
    if (!prev.has(goal)) { res.status = 'insufficient'; line(T('Danh mục Grammar Academy không nối hai chủ điểm này qua các chủ điểm bạn đã mở.', 'The Grammar Academy catalog does not link these topics through the topics you opened.')); return; }
    const chain: number[] = [];
    for (let k = goal; k !== start; k = prev.get(k)!) chain.unshift(via.get(k)!);
    for (const ei of chain) {
      const e = graph.edges[ei];
      line(T(`"${graph.nodes[e.s].sub || graph.nodes[e.s].label}" — ${RELATIONS[e.type].vi.toLowerCase()} — "${graph.nodes[e.t].sub || graph.nodes[e.t].label}"`, `"${graph.nodes[e.s].label}" — ${RELATIONS[e.type].en.toLowerCase()} — "${graph.nodes[e.t].label}"`),
        [cite({ kind: 'relation', edge: ei, distant: false, hops: [] })]);
    }
    line(T('Liên kết do người biên soạn Grammar Academy chọn, không phải đo từ kết quả của bạn.', 'Authored Grammar Academy links, not a measurement of your results.'));
  }
  function evidenceLines(n: CosmosNode) {
    const d = (t: number) => new Date(t).toLocaleDateString(vi ? 'vi-VN' : 'en-GB');
    if (n.cardIds.length) line(T(`Bạn có thẻ "${n.label}" từ ${d(n.discoveredAt)}${n.decks.length ? ` (bộ ${n.decks.join(', ')})` : ''}.`, `You have a card for "${n.label}" since ${d(n.discoveredAt)}${n.decks.length ? ` (deck ${n.decks.join(', ')})` : ''}.`),
      [cite({ kind: 'evidence', text: T('Thẻ từ vựng của bạn', 'Your flashcard'), node: n.i })]);
    if (n.ratings.length) {
      const h = n.ratings.filter(r => r[1] === 0).length, g = n.ratings.filter(r => r[1] === 1).length, e = n.ratings.filter(r => r[1] === 2).length;
      line(T(`Bạn đã tự chấm khi ôn: Khó ${h}, Tốt ${g}, Dễ ${e} (lần gần nhất ${d(n.ratings[n.ratings.length - 1][0])}).`, `Your own review ratings: Hard ${h}, Good ${g}, Easy ${e} (latest ${d(n.ratings[n.ratings.length - 1][0])}).`),
        [cite({ kind: 'evidence', text: T('Nhật ký ôn tập', 'Review log'), node: n.i })]);
    }
    const ev = graph.edges.filter(e => (e.type === 'APPEARS_IN_SOURCE' || e.type === 'LEARNER_USED_IN') && e.t === n.i).sort((x, y) => graph.nodes[x.s].discoveredAt - graph.nodes[y.s].discoveredAt);
    const groups: Record<string, CosmosNode[]> = {};
    for (const e of ev) (groups[graph.nodes[e.s].sub] ??= []).push(graph.nodes[e.s]);
    const label: Record<string, [string, string]> = { READING: ['bài đọc', 'reading'], LISTENING: ['bài nghe', 'listening lesson'], MY_BOOKS: ['sách của tôi (đoạn đánh dấu)', 'my book (highlights)'], WRITING: ['bài viết của bạn', 'your writing'], SPEAKING: ['lời nói của bạn', 'your speaking'] };
    for (const k of ['READING', 'LISTENING', 'MY_BOOKS', 'WRITING', 'SPEAKING']) {
      const list = groups[k];
      if (!list?.length) continue;
      line(T(`${label[k][0][0].toUpperCase()}${label[k][0].slice(1)}: ${list.length} — ${list.slice(0, 4).map(s => `"${s.label}" (${d(s.discoveredAt)})`).join(', ')}${list.length > 4 ? '…' : ''}.`,
        `${label[k][1][0].toUpperCase()}${label[k][1].slice(1)}: ${list.length} — ${list.slice(0, 4).map(s => `"${s.label}" (${d(s.discoveredAt)})`).join(', ')}${list.length > 4 ? '…' : ''}.`),
        list.slice(0, 4).map(s => cite({ kind: 'evidence', text: s.label, node: s.i })));
    }
    for (const e of graph.edges.filter(x => x.type === 'CROSS_SKILL_TRANSFER' && x.words.includes(n.i)).slice(0, 3)) {
      line(T(`Bạn gặp nó trong "${graph.nodes[e.s].label}" trước, rồi dùng lại khi ${graph.nodes[e.t].sub === 'WRITING' ? 'viết' : 'nói'}.`, `You met it in "${graph.nodes[e.s].label}" first, then used it in your ${graph.nodes[e.t].sub === 'WRITING' ? 'writing' : 'speaking'}.`),
        [cite({ kind: 'relation', edge: e.i, distant: false, hops: [] })]);
    }
    return ev.length;
  }
  function traceWord(E: AskEntity) {
    if (E.node < 0) {
      res.status = 'insufficient';
      line(T(`"${E.lemma}" chưa là ngôi sao của bạn: chưa có thẻ nào bạn đã lưu hay đã học cho từ này.`, `"${E.lemma}" is not one of your stars: no card of yours for it was saved or studied.`));
      // known words with a direct verified relation to it (a way in)
      const near = new Map<number, RelationType>();
      for (const s of lex.senses(E.lemma).slice(0, 16)) for (const st of [{ syn: lex.synOf(s), type: 'SYNONYM_OF' as RelationType }, ...neighbours(lex, lex.synOf(s))]) {
        for (const m of lex.membersOf.get(st.syn) ?? []) { const k = idx.lemmaToNode.get(lex.lemmaOf(m)); if (k !== undefined && !near.has(k) && lex.lemmaOf(m) !== E.lemma) near.set(k, st.type); }
      }
      if (near.size) line(T(`Ngôi sao của bạn có quan hệ trực tiếp với nó: ${[...near].slice(0, 6).map(([k, t]) => `"${graph.nodes[k].label}" (${RELATIONS[t].vi.toLowerCase()})`).join(', ')}.`, `Your stars with a direct relation to it: ${[...near].slice(0, 6).map(([k, t]) => `"${graph.nodes[k].label}" (${RELATIONS[t].en.toLowerCase()})`).join(', ')}.`),
        [...near.keys()].slice(0, 6).map(k => cite({ kind: 'evidence', text: graph.nodes[k].label, node: k })));
      return;
    }
    const n = graph.nodes[E.node];
    if (!n.cardIds.length) line(T(`Bạn chưa lưu thẻ "${n.label}": đây là ngôi sao "đã gặp" — từ có trong nguồn bạn đã học hoặc bạn đã tự dùng. Nó không được tính là đã học.`, `You have no card for "${n.label}": it is a "met" star — the word occurs in your sources or you used it yourself. It is not counted as learned.`),
      [cite({ kind: 'evidence', text: T('Ngôi sao đã gặp', 'Met star'), node: n.i })]);
    const sources = evidenceLines(n);
    if (sources) {
      const only = soleSense(lex, n.label, []);
      if (only >= 0) line(T(`WordNet chỉ có đúng một nghĩa cho "${n.label}", nên trong các nguồn này nó mang nghĩa: ${clip(lex.gloss(lex.synOf(only)))} (trong phạm vi các nghĩa WordNet ghi).`,
        `WordNet has exactly one sense for "${n.label}", so in these sources it means: ${clip(lex.gloss(lex.synOf(only)))} (within the senses WordNet records).`),
        [cite({ kind: 'sense', lemma: n.label, pos: lex.pos(lex.synOf(only)), gloss: lex.gloss(lex.synOf(only)) })]);
      else if (lex.senses(n.label).length > 1) line(T(`"${n.label}" có ${lex.senses(n.label).length} nghĩa trong WordNet; vũ trụ không đoán nghĩa nào được dùng trong từng nguồn.`,
        `"${n.label}" has ${lex.senses(n.label).length} senses in WordNet; the universe does not guess which one each source uses.`));
    }
    if (!sources) line(T('Chưa nguồn nào bạn đã hoàn thành (đọc, nghe) hay tự tạo (viết, nói) chứa dạng của từ này.', 'None of the sources you completed (reading, listening) or produced (writing, speaking) contains a form of this word yet.'));
    planSources([E], 'occurrence');
  }
  function traceGrammar(E: AskEntity) {
    if (E.node < 0) { res.status = 'insufficient'; line(T(`Chủ điểm ${name(E)} chưa có trong vũ trụ của bạn: bạn chưa mở bài học này.`, `Topic ${name(E)} is not in your universe: you have not opened this lesson.`)); return; }
    const n = graph.nodes[E.node];
    const d = (t: number) => new Date(t).toLocaleDateString(vi ? 'vi-VN' : 'en-GB');
    line(T(`Bạn mở chủ điểm "${n.sub || n.label}" lần đầu ngày ${d(n.discoveredAt)}; trạng thái: ${n.status === 'MASTERED' ? 'đã nắm vững (bài kiểm tra)' : n.status === 'LEARNED' ? 'đã học' : 'mới mở'}${n.weak ? ', cần ôn lại' : ''}.`,
      `You first opened "${n.label}" on ${d(n.discoveredAt)}; state: ${n.status === 'MASTERED' ? 'mastered (check passed)' : n.status === 'LEARNED' ? 'studied' : 'opened'}${n.weak ? ', needs review' : ''}.`),
      [cite({ kind: 'evidence', text: T('Tiến độ Grammar Academy', 'Grammar Academy progress'), node: n.i })]);
    line(T('Vũ trụ chưa tìm mẫu ngữ pháp trong câu (chưa có bộ kiểm chứng), nên không trích câu cho chủ điểm.', 'The universe does not detect grammar patterns in sentences yet (no validator), so it quotes no sentence for a topic.'));
  }
  function unlearned(E: AskEntity) {
    const known = idx.lemmaToNode;
    const out = new Map<string, { lemma: string; type: RelationType; gloss: string; core: boolean; rank: number }>();
    for (const s of lex.senses(E.lemma)) {
      if (lex.rank(s) > 4) continue;
      const syn = lex.synOf(s);
      const add = (m: number, type: RelationType, gloss: string) => {
        const lemma = lex.lemmaOf(m);
        if (lemma === E.lemma || known.has(lemma) || out.has(lemma)) return;
        const li = lex.lemmaIndex.get(lemma);
        out.set(lemma, { lemma, type, gloss, core: li !== undefined && lex.core.has(li), rank: lex.rank(s) * 10 + (li !== undefined && lex.core.has(li) ? 0 : 5) });
      };
      for (const m of lex.membersOf.get(syn) ?? []) add(m, 'SYNONYM_OF', lex.gloss(syn));
      for (const st of neighbours(lex, syn)) {
        if (generic(lex, st.syn)) continue;
        if (st.senses) add(st.senses[1], st.type, lex.gloss(st.syn));
        else for (const m of (lex.membersOf.get(st.syn) ?? []).slice(0, st.dir === 'down' ? 1 : 2)) add(m, st.type, lex.gloss(st.syn));
      }
    }
    res.related = [...out.values()].sort((a, b) => a.rank - b.rank || Number(b.core) - Number(a.core)).slice(0, 14).map(({ lemma, type, gloss, core }) => ({ lemma, type, gloss, core }));
    if (!res.related.length) { res.status = 'insufficient'; line(T(`WordNet không có từ liên quan trực tiếp nào với "${E.lemma}" mà bạn chưa học.`, `WordNet has no directly related word to "${E.lemma}" that you have not learned.`)); return; }
    line(T(`${res.related.length} từ có quan hệ đã kiểm chứng với "${E.lemma}" (ở các nghĩa thông dụng) mà bạn chưa có thẻ. Từ thông dụng (trong bộ từ của Echo) đứng trước.`, `${res.related.length} words with a verified relation to "${E.lemma}" (in its common senses) that you have no card for. Everyday words (in Echo's decks) come first.`),
      [cite({ kind: 'evidence', text: 'Open English WordNet 2025', node: -1 })]);
  }
  function unlearnedGrammar(E: AskEntity) {
    res.status = 'insufficient';
    line(T(`Gợi ý chủ điểm chưa học dựa theo danh mục có trong Grammar Academy (mở chủ điểm ${name(E)} để xem phần "liên quan").`, `For topics you have not studied, open ${name(E)} in Grammar Academy and see its related topics.`));
  }
  function fixedPhrase(A: AskEntity, B: AskEntity) {
    for (const phrase of [`${A.lemma} ${B.lemma}`, `${B.lemma} ${A.lemma}`]) {
      const senses = lex.senses(phrase);
      if (!senses.length) continue;
      const syn = lex.synOf(senses[0]);
      line(T(`WordNet ghi "${phrase}" là MỘT mục từ (cụm cố định): ${clip(lex.gloss(syn))}. Nghĩa của cụm không suy ra từ nghĩa của từng chữ.`,
        `WordNet lists "${phrase}" as ONE entry (a fixed expression): ${clip(lex.gloss(syn))}. Its meaning is not derived from its words.`),
        [cite({ kind: 'sense', lemma: phrase, pos: lex.pos(syn), gloss: lex.gloss(syn) })]);
      return;
    }
  }
  function history(kind: HistoryKind, days: number) {
    const now = graph.generatedAt || Date.now();
    const d = (t: number) => new Date(t).toLocaleDateString(vi ? 'vi-VN' : 'en-GB');
    const pool = graph.nodes.filter(n => (n.kind === 'word' && !isMet(n)) || n.kind === 'grammar');
    const picked: { n: CosmosNode; at: number; what: string }[] = [];
    if (kind === 'recent') {
      const from = now - days * 86_400_000;
      for (const n of pool) {
        const added = n.discoveredAt >= from && n.discoveredAt <= now;
        const rated = n.ratings.filter(r => r[0] >= from && r[0] <= now);
        const met = n.touches.filter(x => x[0] >= from && x[0] <= now);
        if (!added && !rated.length && !met.length) continue;
        const parts: string[] = [];
        if (added) parts.push(T(n.kind === 'grammar' ? 'mở bài' : 'lưu / bắt đầu học', n.kind === 'grammar' ? 'opened' : 'saved / started'));
        if (rated.length) parts.push(T(`ôn ${rated.length} lần`, `${rated.length} review(s)`));
        if (met.length) parts.push(T(`gặp trong ${met.length} nguồn`, `met in ${met.length} source(s)`));
        picked.push({ n, at: Math.max(added ? n.discoveredAt : 0, ...rated.map(r => r[0]), ...met.map(x => x[0])), what: parts.join(', ') });
      }
    } else {
      for (const n of pool) {
        const m = memoryOf(n, now, now);
        const hit = kind === 'atRisk' ? m.state === 'fading' || m.state === 'atRisk'
          : kind === 'hard' ? m.state === 'mistaken' || m.state === 'weak'
            : kind === 'stable' ? m.state === 'stable' : m.cross;
        if (!hit) continue;
        picked.push({ n, at: m.lastAt, what: kind === 'hard' ? T(`Khó ${m.hard} lần`, `Hard ${m.hard}×`) : MEMORY_LABEL[m.state][vi ? 0 : 1] });
      }
    }
    picked.sort((x, y) => kind === 'atRisk' ? x.at - y.at : kind === 'hard' ? (y.n.ratings.filter(r => r[1] === 0).length - x.n.ratings.filter(r => r[1] === 0).length) || y.at - x.at : y.at - x.at);
    const title: Record<HistoryKind, [string, string]> = {
      recent: [`Trong ${days === 1 ? 'hôm nay' : `${days} ngày qua`}`, days === 1 ? 'Today' : `In the last ${days} days`],
      atRisk: ['Đang mờ dần hoặc có nguy cơ quên (không có bằng chứng mới từ 30 ngày)', 'Fading or at risk (no new evidence for 30+ days)'],
      hard: ['Lần ôn gần nhất bạn chọn Khó', 'Your latest rating was Hard'],
      stable: ['Vững theo quy tắc hiển thị (Tốt / Dễ ở ít nhất 3 ngày, cách nhau từ 14 ngày)', 'Stable by the display rule (Good / Easy on 3+ days spanning 14+ days)'],
      cross: ['Bạn đã tự dùng khi viết, nói và còn học, gặp ở kỹ năng khác', 'Used in your own writing or speech and studied or met elsewhere'],
    };
    if (!picked.length) {
      res.status = 'insufficient';
      line(T(`${title[kind][0]}: chưa có từ hay chủ điểm nào trong bằng chứng của bạn.`, `${title[kind][1]}: no word or topic in your evidence.`));
      return;
    }
    line(T(`${title[kind][0]}: ${picked.length} mục.`, `${title[kind][1]}: ${picked.length} item(s).`));
    for (const p of picked.slice(0, 12)) {
      line(`"${p.n.kind === 'grammar' ? p.n.sub || p.n.label : p.n.label}" — ${p.what} (${d(p.at)})`, [cite({ kind: 'evidence', text: p.n.kind === 'grammar' ? T('Tiến độ Grammar Academy', 'Grammar Academy progress') : T('Thẻ và nhật ký ôn của bạn', 'Your card and review log'), node: p.n.i })]);
    }
    if (picked.length > 12) line(T(`… và ${picked.length - 12} mục khác.`, `… and ${picked.length - 12} more.`));
    line(T('Chỉ từ bằng chứng đã ghi (thẻ, lần tự chấm, nguồn đã hoàn thành). Các ngưỡng là quy tắc hiển thị, không phải dự đoán bạn sẽ quên.', 'Only from recorded evidence (cards, your own ratings, completed sources). Thresholds are display rules, not a prediction of forgetting.'));
  }
  function planSources(list: AskEntity[], purpose: PassagePlan['purpose']) {
    const words = list.filter(e => !e.grammar && e.forms.length).slice(0, 2);
    if (!words.length) return;
    // Sources that contain EVERY concept, by the rule-based form match the graph already made. A concept that is not a star
    // has no source edges: every source is a candidate and the server's own scan of the forms decides.
    let pool: number[] = graph.nodes.filter(n => n.kind === 'source').map(n => n.i);
    for (const e of words) {
      if (e.node < 0) continue;
      const has = new Set(graph.edges.filter(x => (x.type === 'APPEARS_IN_SOURCE' || x.type === 'LEARNER_USED_IN') && x.t === e.node).map(x => x.s));
      pool = pool.filter(i => has.has(i));
    }
    pool.sort((a, b) => graph.nodes[b].discoveredAt - graph.nodes[a].discoveredAt);
    const refs = pool.filter(i => graph.nodes[i].sub !== 'MY_BOOKS').slice(0, 12).map(i => graph.nodes[i].ref);
    const local = pool.filter(i => graph.nodes[i].sub === 'MY_BOOKS').slice(0, 6).map(i => graph.nodes[i].ref.slice('MY_BOOKS:'.length));
    if (!refs.length && !local.length) return;
    res.plan = { refs, local, groups: words.map(e => [...new Set(e.forms)].slice(0, 32)), purpose };
  }
}

// ── passages (page side) ────────────────────────────────────────────────────────────────────────────────────────────
export interface PassageIn { kind: string; id: number | string; title: string; at: number; segmentId: number; text: string; spans: [number, number, number][]; local?: boolean }

/** Adds the sentences to an answer: each one a cited quotation, with an honest reading of what co-occurrence does (not) mean. */
export function composePassages(r: AskResult, passages: PassageIn[], more: boolean, vi: boolean): AskResult {
  const T = (a: string, b: string) => (vi ? a : b);
  const out: AskResult = { ...r, lines: [...r.lines], citations: [...r.citations] };
  const seen = new Set<string>();
  const unique = passages.filter(p => { const k = `${p.kind}:${p.id}:${p.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!r.plan) return out;
  const cites = unique.map(p => { out.citations.push({ kind: 'passage', ref: `${p.kind}:${p.id}`, title: p.title, text: p.text, spans: p.spans, at: p.at, segmentId: p.segmentId, local: !!p.local }); return out.citations.length - 1; });
  const words = r.entities.filter(e => !e.grammar).slice(0, 2).map(e => `"${e.lemma}"`);
  if (!unique.length) {
    out.lines.push({ text: r.plan.purpose !== 'occurrence'
      ? T(`Không câu nào trong nguồn của bạn chứa cả ${words.join(' và ')}.`, `No sentence in your sources contains both ${words.join(' and ')}.`)
      : T(`Không tìm thấy câu nào chứa ${words.join(', ')} trong các nguồn đã kiểm tra.`, `No sentence with ${words.join(', ')} was found in the sources checked.`), cites: [] });
    if (r.intent === 'passages' && out.status === 'answered') out.status = 'insufficient';
    return out;
  }
  if (r.plan.purpose === 'cause' || r.plan.purpose === 'adjacent') {
    const names = r.entities.filter(e => !e.grammar).slice(0, 2).map(e => `"${e.lemma}"`);
    let found = 0;
    unique.forEach((p, k) => {
      if (r.plan!.purpose === 'cause') {
        const c = causalReading(p.text, p.spans);
        if (!c) return;
        found++;
        const [x, y] = c.cause === 0 ? [names[0], names[1]] : [names[1], names[0]];
        out.lines.push({ text: c.negated
          ? T(`Nguồn "${p.title}" PHỦ ĐỊNH rằng ${x} gây ra ${y} (từ nối "${c.connective}" đi cùng phủ định).`, `"${p.title}" DENIES that ${x} causes ${y} (connective "${c.connective}" with a negation).`)
          : T(`Nguồn "${p.title}" nói ${x} ${c.hedged ? 'có thể ' : ''}gây ra / dẫn đến ${y} (từ nối "${c.connective}").`, `"${p.title}" says ${x} ${c.hedged ? 'may cause' : 'causes / leads to'} ${y} (connective "${c.connective}").`), cites: [cites[k]] });
      } else if (adjacentPair(p.text, p.spans)) {
        found++;
        out.lines.push({ text: T(`Trong "${p.title}", hai từ đứng liền nhau.`, `In "${p.title}" the two words stand next to each other.`), cites: [cites[k]] });
      }
    });
    if (r.plan.purpose === 'cause') {
      out.lines.push({ text: found
        ? T('Đây là lời khẳng định của nguồn, được trích nguyên văn. Vũ trụ không tự kiểm chứng quan hệ nhân quả và không vẽ nó thành cạnh.', 'This is the source\'s claim, quoted as written. The universe does not verify causation itself and never draws it as an edge.')
        : T(`Có ${unique.length} câu chứa cả ${names.join(' và ')}, nhưng không câu nào nêu nhân quả bằng từ nối tường minh (như "gây ra", "dẫn đến", "do").`, `${unique.length} sentence(s) contain both ${names.join(' and ')}, but none states a cause with an explicit connective (such as "causes", "leads to", "because of").`), cites: found ? [] : cites.slice(0, 3) });
    } else {
      out.lines.push({ text: found
        ? T(`${names.join(' và ')} đứng liền nhau trong ${found} câu nguồn của bạn: đó là cách dùng có thật, không phải bằng chứng một kết hợp từ cố định (cần kho ngữ liệu lớn để khẳng định).`, `${names.join(' and ')} stand together in ${found} sentence(s) of your sources: attested use, not proof of a fixed collocation (that needs a large corpus).`)
        : T(`${names.join(' và ')} có cùng câu trong ${unique.length} câu nhưng không đứng liền nhau.`, `${names.join(' and ')} share ${unique.length} sentence(s) but never stand next to each other.`), cites: found ? [] : cites.slice(0, 3) });
    }
    return out;
  }
  out.lines.push({ text: r.plan.purpose === 'co-mention'
    ? T(`${words.join(' và ')} cùng xuất hiện trong ${unique.length}${more ? '+' : ''} câu của nguồn bạn đã học. Đứng chung một câu không phải là một quan hệ giữa hai khái niệm.`, `${words.join(' and ')} occur together in ${unique.length}${more ? '+' : ''} sentence(s) of your sources. Appearing in one sentence is not a relation between the concepts.`)
    : T(`${words.join(', ')} xuất hiện trong ${unique.length}${more ? '+' : ''} câu của nguồn bạn đã học (chỉ khẳng định dạng từ có mặt, không khẳng định nghĩa).`, `${words.join(', ')} occur(s) in ${unique.length}${more ? '+' : ''} sentence(s) of your sources (only the word form is claimed, not the sense).`), cites });
  return out;
}

/** Sentence ranges over a text: the page twin of the server's splitter (My Books highlights never leave the device). */
export function splitSentences(body: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /(?<=[.!?]["”’')\]]{0,2})\s+|\n\s*/g;
  let start = 0, m: RegExpExecArray | null;
  const add = (a: number, b: number) => { while (a < b && /\s/.test(body[a])) a++; while (b > a && /\s/.test(body[b - 1])) b--; if (b > a) out.push([a, b]); };
  while ((m = re.exec(body))) { add(start, m.index); start = m.index + m[0].length; if (!m[0].length) re.lastIndex++; }
  add(start, body.length);
  return out;
}

/** Spans [start, end, group] of the forms in a sentence, or null if a group is missing (same rules as the server). */
export function findSpans(sentence: string, groups: string[][]): [number, number, number][] | null {
  const low = sentence.normalize('NFC').replace(/’/g, "'").replace(/‘/g, "'").toLowerCase();
  if (low.length !== sentence.length) return null;
  const words: [number, number][] = [];
  for (const m of low.matchAll(/[a-z]+(?:['-][a-z]+)*/g)) {
    let end = m.index! + m[0].length;
    if (low.startsWith("'s", end - 2) && end - 2 > m.index!) end -= 2;
    words.push([m.index!, end]);
  }
  const spans: [number, number, number][] = [];
  const hit = groups.map(() => false);
  for (let i = 0; i < words.length; i++) {
    groups.forEach((forms, g) => {
      for (const form of forms) {
        const parts = form.split(' ');
        if (i + parts.length > words.length) continue;
        let ok = true;
        for (let k = 0; k < parts.length && ok; k++) {
          const w = words[i + k];
          ok = low.slice(w[0], w[1]) === parts[k] && (k === 0 || !low.slice(words[i + k - 1][1], w[0]).trim());
        }
        if (ok) { spans.push([words[i][0], words[i + parts.length - 1][1], g]); hit[g] = true; break; }
      }
    });
  }
  return hit.every(Boolean) ? spans : null;
}

/** Highlighted passages of My Books (read on this device only), as passages with spans. */
export function localPassages(books: { id: string; title: string; at: number; texts: string[] }[], groups: string[][], perBook = 3): PassageIn[] {
  const out: PassageIn[] = [];
  for (const b of books) {
    let n = 0, index = 0;
    for (const text of b.texts) for (const [a, z] of splitSentences(text)) {
      index++;
      if (n >= perBook) break;
      const sentence = text.slice(a, z), spans = findSpans(sentence, groups);
      if (!spans) continue;
      out.push({ kind: 'MY_BOOKS', id: b.id, title: b.title, at: b.at, segmentId: 0, text: sentence.slice(0, 420), spans: spans.filter(s => s[1] <= 420), local: true });
      n++;
    }
    void index;
  }
  return out;
}

export { posOf };
