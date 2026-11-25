/**
 * Echo Neural Cosmos — builds the learner's universe from evidence. Pure and deterministic: same inputs, same graph.
 *
 * Truth rules (in priority order):
 * 1. A word-to-word edge exists only if Open English WordNet states it between two SPECIFIC senses of those words. The edge
 *    keeps those senses (scopes); "bank" is never linked through a sense it does not have, and no two senses are merged.
 * 2. Grammar edges come only from the authored Grammar Academy catalog.
 * 3. A source edge only says that a form of the word occurs in that text (rule-based, part-of-speech-aware inflection).
 * 4. Nothing is created from co-occurrence, similarity or AI. A suggestion is a path of two verified relations and is
 *    always SUGGESTED, never VERIFIED.
 * 5. One canonical node per word (cards of the same word in several decks are one star), per topic, per source.
 * 6. A fixed expression ("break down") is linked to its words only because WordNet lists the phrase as ONE entry; its meaning is
 *    never derived from them. A source edge names a sense only when WordNet has exactly one sense for the word (and the matched
 *    form is not also another word): a word with several senses is never assigned one.
 */
import { GALAXIES, GALAXY_INDEX, LEXFILES, OTHER_CONSTELLATION, SOURCE_CONSTELLATIONS, type GalaxyId } from './domains';
import { formsOf, posOf, type Pos } from './inflect';
import type { Lexicon } from './lexicon';
import { RELATIONS, type RelationType } from './ontology';
import { SKILL, type Community, type CosmosEdge, type CosmosEvent, type CosmosGraph, type CosmosNode, type GrammarDomainLite, type GrammarTopicLite, type Overlay } from './types';

const STATUS_RANK: Record<string, number> = { NEW: 0, LEARNED: 1, MASTERED: 2 };
const Q: Record<string, number> = { hard: 0, good: 1, easy: 2 };
/** A knowledge black hole: at least this many of the learner's own "Khó" ratings, the latest one included. */
export const GAP_HARD_RATINGS = 3;
const MAX_FRONTIER = 8;
/** A sense among the 3 most common of its word and part of speech (WordNet sense order). */
export const COMMON_RANK = 3;
const MAX_SUGGESTIONS = 60;
/** Words of the met layer drawn at most (most-met first). */
export const MAX_MET = 300;
/** A word star the learner has not saved: met in their sources only. */
export const isMet = (n: CosmosNode) => n.kind === 'word' && n.cardIds.length === 0;
/** Function words and the most general verbs: met everywhere, telling nothing about a learner. */
const MET_STOP = new Set(('the a an and or but of in on at to for from with by about as into over after before under between through during without within '
  + 'be is are was were been being am have has had do does did done say said get got make made go went gone come came take took see saw know knew think thought '
  + 'want give gave use used find found tell told ask work seem feel felt try leave left call put mean let keep begin show hear play run move live believe bring happen '
  + 'this that these those it its i me my you your we our they them their he him his she her who whom which what when where why how there here than then so if '
  + 'not no yes all any some each every more most other such only own same also very just can could will would shall should may might must one two thing way').split(' '));
/**
 * Closed-class words (conjunctions, prepositions, particles, determiners, pronouns, quantifiers). WordNet has no such parts of
 * speech, so a single WordNet sense of "while" (a noun) says nothing about "while" in a sentence; and a particle ("by" in "pass by")
 * teaches nothing as a link. Never given a sense in context, never linked to an expression.
 */
export const CLOSED_CLASS = new Set(('while since as like before after until till because though although unless whether whereas once yet still '
  + 'many much another other others someone anyone everyone no-one something anything everything nothing nobody somebody anybody everybody '
  + 'each every either neither both few several all any some none such that this these those what which who whom whose whatever whoever '
  + 'here there then than so too very rather quite enough more most less least only even also just ever never always '
  + 'about above across against along among around behind below beneath beside besides between beyond during except inside near off outside '
  + 'over past through throughout toward towards under underneath within without upon per plus minus versus via down up out in on at by for '
  + 'from of to with into onto back forward forwards away apart aside together ahead around aboard').split(' '));
const formOwnerCache = new WeakMap<Lexicon, Map<string, string[]>>();
/** Every lexicon lemma a surface form could stand for (forward inflection of all lemmas, built once per lexicon). */
export function formOwners(lex: Lexicon): Map<string, string[]> {
  const hit = formOwnerCache.get(lex);
  if (hit) return hit;
  const out = new Map<string, string[]>();
  for (const lemma of lex.file.lemmas) {
    if (lemma.includes(' ')) continue;
    for (const f of formsOf(lemma, lex.posSet(lemma))) { const a = out.get(f); if (!a) out.set(f, [lemma]); else if (!a.includes(lemma)) a.push(lemma); }
  }
  formOwnerCache.set(lex, out);
  return out;
}
const metCache = new WeakMap<Lexicon, Map<string, string>>();
/** form -> lemma for the lexicon's everyday content words (forms that could stand for two lemmas are dropped). */
function metForms(lex: Lexicon): Map<string, string> {
  const hit = metCache.get(lex);
  if (hit) return hit;
  const out = new Map<string, string>(), clash = new Set<string>();
  for (const li of lex.core) {
    const lemma = lex.file.lemmas[li];
    if (lemma.length < 3 || MET_STOP.has(lemma) || !/^[a-z]+(?:[ '-][a-z]+)*$/.test(lemma)) continue;
    const pos = lex.posSet(lemma);
    if (!pos.has('n') && !pos.has('v') && !pos.has('a')) continue;
    for (const f of formsOf(lemma, pos)) {
      const k = f.replace(/ /g, '_');
      if (lex.lemmaIndex.has(f) && f !== lemma) continue; // "saw" is its own lemma too: never read it as "see"
      if (out.has(k) && out.get(k) !== lemma) clash.add(k); else out.set(k, lemma);
    }
  }
  for (const k of clash) out.delete(k);
  metCache.set(lex, out);
  return out;
}

export function buildUniverse(lex: Lexicon, overlay: Overlay, grammar: { domains: GrammarDomainLite[]; topics: GrammarTopicLite[] } | null,
  lexiconVersion: string): CosmosGraph {
  const nodes: CosmosNode[] = [];
  const edges: CosmosEdge[] = [];
  const withheld: Record<string, number> = {};
  const byId = new Map<string, number>();
  const node = (init: Partial<CosmosNode> & Pick<CosmosNode, 'id' | 'kind' | 'label'>): number => {
    const found = byId.get(init.id);
    if (found !== undefined) return found;
    const n: CosmosNode = { i: nodes.length, sub: '', galaxy: 0, constellation: -1, system: -1, x: 0, y: 0, z: 0, size: 1,
      discoveredAt: Number.MAX_SAFE_INTEGER, skills: 0, status: '', stage: '', touches: [], ratings: [], weak: false, gap: false, pos: [], anchorSense: -1,
      cardIds: [], decks: [], dueAt: 0, reviewCount: 0, frontier: [], ref: '', degree: 0, ...init };
    nodes.push(n); byId.set(n.id, n.i); return n.i;
  };

  // ── 1. Words: one canonical star per lemma, every card of it attached ───────────────────────────────────────────────
  const cardToNode = new Map<number, number>();
  // A word becomes a star only when it is genuinely the learner's: a card they saved themselves (no SYSTEM deck), or a deck
  // card they actually studied (a stored rating, a status above NEW, or a non-zero review counter). Enrolling a deck of
  // thousands of words lights nothing by itself.
  const rated = new Set(overlay.reviews.map(r => r.cardId));
  const studied = (c: Overlay['words'][number]) => !c.deckSlug || c.status !== 'NEW' || (c.reviewCount ?? 0) > 0 || rated.has(c.cardId);
  for (const card of [...overlay.words].filter(studied).sort((a, b) => a.createdAt - b.createdAt || a.cardId - b.cardId)) {
    const lemma = canonicalLemma(lex, card.word);
    if (!lemma) continue;
    const i = node({ id: `w:${lemma}`, kind: 'word', label: lemma, ref: lemma });
    const n = nodes[i];
    n.discoveredAt = Math.min(n.discoveredAt, card.createdAt);
    n.cardIds.push(card.cardId);
    if (!n.sub && card.meaning) n.sub = card.meaning;
    if (card.deckTitle && !n.decks.includes(card.deckTitle)) n.decks.push(card.deckTitle);
    if ((STATUS_RANK[card.status] ?? 0) >= (STATUS_RANK[n.status] ?? -1)) n.status = card.status;
    const p = posOf(card.partOfSpeech);
    if (p && !n.pos.includes(p)) n.pos.push(p);
    n.skills |= SKILL.flashcard;
    n.reviewCount += card.reviewCount ?? 0;
    // the scheduler's own next date, only for a card that is being studied (MASTERED cards leave the due reviews; a saved card
    // never reviewed is "saved", not "due")
    if (card.dueAt && card.status !== 'MASTERED' && (card.status !== 'NEW' || (card.reviewCount ?? 0) > 0 || rated.has(card.cardId)))
      n.dueAt = n.dueAt ? Math.min(n.dueAt, card.dueAt) : card.dueAt;
    cardToNode.set(card.cardId, i);
  }
  for (const r of overlay.reviews) {
    const i = cardToNode.get(r.cardId);
    if (i !== undefined) nodes[i].ratings.push([r.at, Q[r.q] ?? 1]);
  }
  for (const n of nodes) {
    n.ratings.sort((a, b) => a[0] - b[0]);
    const hard = n.ratings.filter(r => r[1] === 0).length;
    const last = n.ratings[n.ratings.length - 1];
    n.weak = !!last && last[1] === 0;               // the learner's own latest rating was "Khó" — never absence of evidence
    n.gap = n.weak && hard >= GAP_HARD_RATINGS;
    // Anchor = the most common sense of the card's part of speech (else of the word): a PLACE, never a claim of the sense known.
    const senses = lex.senses(n.label);
    const fit = senses.filter(s => !n.pos.length || n.pos.includes(lex.pos(lex.synOf(s))));
    n.anchorSense = (fit[0] ?? senses[0]) ?? -1;
  }
  const wordCount = nodes.length;

  // ── 2. Verified lexical relations between known words, kept at sense level ────────────────────────────────────────
  const senseOwner = new Map<number, number>(); // sense -> known word node
  for (let i = 0; i < wordCount; i++) for (const s of lex.senses(nodes[i].label)) senseOwner.set(s, i);
  const synOwners = new Map<number, number[]>();
  for (const [s, i] of senseOwner) { const syn = lex.synOf(s); const a = synOwners.get(syn); if (a) { if (!a.includes(i)) a.push(i); } else synOwners.set(syn, [i]); }
  const lexEdges = new Map<string, CosmosEdge>();
  const addLex = (type: RelationType, a: number, b: number, sa: number, sb: number, steps = 1) => {
    if (a === b) return;
    const directed = RELATIONS[type].directed;
    const [x, y, ux, uy] = !directed && a > b ? [b, a, sb, sa] : [a, b, sa, sb];
    const key = `${type}:${x}:${y}`;
    let e = lexEdges.get(key);
    if (!e) {
      e = mkEdge(type, x, y);
      e.steps = steps;
      lexEdges.set(key, e);
    }
    if (!e.scopes.some(([p, q]) => p === ux && q === uy)) e.scopes.push([ux, uy]);
  };
  for (const [syn, owners] of synOwners) {
    if (owners.length < 2) continue;
    const members = lex.membersOf.get(syn) ?? [];
    for (let p = 0; p < owners.length; p++) for (let q = p + 1; q < owners.length; q++) {
      const sa = members.find(s => senseOwner.get(s) === owners[p])!, sb = members.find(s => senseOwner.get(s) === owners[q])!;
      addLex('SYNONYM_OF', owners[p], owners[q], sa, sb);
    }
  }
  for (const [s, a] of senseOwner) {
    for (const r of lex.senseRels.get(s) ?? []) {
      const b = senseOwner.get(r.other);
      if (b === undefined) continue;
      addLex(r.code === 'A' ? 'ANTONYM_OF' : 'DERIVED_FORM', a, b, s, r.other);
    }
    const syn = lex.synOf(s);
    // adjective clusters only: OEWN also uses "similar" for verb groups, which the evidence text does not describe
    for (const other of lex.pos(syn) === 'a' ? lex.similar.get(syn) ?? [] : []) {
      for (const owner of synOwners.get(other) ?? []) {
        const os = (lex.membersOf.get(other) ?? []).find(m => senseOwner.get(m) === owner)!;
        addLex('SIMILAR_TO', a, owner, s, os);
      }
    }
    for (const parent of lex.parents.get(syn) ?? []) {
      for (const owner of synOwners.get(parent.syn) ?? []) {
        const ps = (lex.membersOf.get(parent.syn) ?? []).find(m => senseOwner.get(m) === owner)!;
        addLex('HYPERNYM_OF', owner, a, ps, s);
      }
    }
    for (const whole of lex.wholes.get(syn) ?? []) {
      for (const owner of synOwners.get(whole) ?? []) {
        const ws = (lex.membersOf.get(whole) ?? []).find(m => senseOwner.get(m) === owner)!;
        addLex('PART_OF', a, owner, s, ws);
      }
    }
  }
  for (const e of lexEdges.values()) {
    e.scopes.sort((p, q) => scopeRank(lex, nodes, e, p) - scopeRank(lex, nodes, e, q));
    e.posMatch = e.scopes.some(sc => posFits(lex, nodes[e.s], sc[0]) && posFits(lex, nodes[e.t], sc[1]));
    e.common = e.scopes.some(([a, b]) => lex.rank(a) <= COMMON_RANK && lex.rank(b) <= COMMON_RANK);
    e.at = Math.max(nodes[e.s].discoveredAt, nodes[e.t].discoveredAt);
    pushEdge(e);
  }

  // Fixed expressions: a phrase the learner knows that WordNet lists as one entry, linked to each of its words the learner also
  // knows. Exact word match only ("break down" -> "break", "down"); a hyphenated or inflected word is not split or guessed.
  for (let i = 0; i < wordCount; i++) {
    const phrase = nodes[i].label;
    if (!phrase.includes(' ') || !lex.lemmaIndex.has(phrase)) continue;
    for (const part of new Set(phrase.split(' '))) {
      if (CLOSED_CLASS.has(part)) continue; // a particle ("by" in "pass by") is true but teaches nothing as a link
      const w = byId.get(`w:${part}`);
      if (w === undefined || w === i) continue;
      const e = mkEdge('IN_EXPRESSION', w, i);
      e.at = Math.max(nodes[w].discoveredAt, nodes[i].discoveredAt);
      pushEdge(e);
    }
  }

  // Frontier: verified neighbours the learner has not met yet (shown as dim stars only around a focused word).
  for (let i = 0; i < wordCount; i++) {
    const n = nodes[i];
    const seen = new Set<string>();
    const offer = (sense: number, type: RelationType, via: number) => {
      const lemma = lex.lemmaOf(sense);
      if (n.frontier.length >= MAX_FRONTIER || byId.has(`w:${lemma}`) || seen.has(lemma) || lemma === n.label) return;
      seen.add(lemma); n.frontier.push({ lemma, type, sense, via });
    };
    for (const s of lex.senses(n.label).slice(0, 6)) {
      const syn = lex.synOf(s);
      for (const m of lex.membersOf.get(syn) ?? []) offer(m, 'SYNONYM_OF', s);
      for (const r of lex.senseRels.get(s) ?? []) offer(r.other, r.code === 'A' ? 'ANTONYM_OF' : 'DERIVED_FORM', s);
      for (const o of lex.pos(syn) === 'a' ? lex.similar.get(syn) ?? [] : []) for (const m of (lex.membersOf.get(o) ?? []).slice(0, 1)) offer(m, 'SIMILAR_TO', s);
      for (const p of lex.parents.get(syn) ?? []) for (const m of (lex.membersOf.get(p.syn) ?? []).slice(0, 1)) offer(m, 'HYPERNYM_OF', s);
      for (const w of lex.wholes.get(syn) ?? []) for (const m of (lex.membersOf.get(w) ?? []).slice(0, 1)) offer(m, 'PART_OF', s);
    }
  }

  // ── 3. Grammar: topics the learner opened; authored catalog links only ───────────────────────────────────────────
  const topicInfo = new Map((grammar?.topics ?? []).map(t => [t.slug, t]));
  for (const g of overlay.grammar) {
    const t = topicInfo.get(g.slug);
    const i = node({ id: `g:${g.slug}`, kind: 'grammar', label: t ? t.en : g.slug, sub: t ? t.vi : '', ref: g.slug });
    const n = nodes[i];
    n.discoveredAt = g.firstOpenedAt;
    n.skills |= SKILL.grammar;
    n.status = g.masteredAt ? 'MASTERED' : g.studiedAt ? 'LEARNED' : 'NEW';
    n.weak = g.needsReview;
    if (g.studiedAt) n.ratings.push([g.studiedAt, 1]);
    if (g.masteredAt) n.ratings.push([g.masteredAt, 2]);
  }
  for (const n of nodes) {
    if (n.kind !== 'grammar') continue;
    const t = topicInfo.get(n.ref);
    if (!t) continue;
    for (const pre of t.prerequisites) {
      const p = byId.get(`g:${pre}`);
      if (p !== undefined) pushEdge(withTime(mkEdge('PREREQUISITE_OF', p, n.i)));
    }
    for (const r of t.related) {
      const o = byId.get(`g:${r.slug}`);
      if (o === undefined || o === n.i) continue;
      const type: RelationType = r.rel === 'contrast' || r.rel === 'confusion' ? 'CONTRASTS_WITH' : 'ASSOCIATED_WITH';
      const [a, b] = n.i < o ? [n.i, o] : [o, n.i];
      if (edges.some(e => e.type === type && e.s === a && e.t === b)) continue;
      const e = withTime(mkEdge(type, a, b)); e.note = r.rel; pushEdge(e);
    }
  }

  // ── 4. Sources: completed / produced texts, word forms only ─────────────────────────────────────────────────────
  const formIndex = new Map<string, number[]>();
  for (let i = 0; i < wordCount; i++) {
    const n = nodes[i];
    const pos: Iterable<Pos> = n.pos.length ? n.pos : lex.posSet(n.label);
    for (const f of formsOf(n.label, pos)) { const k = f.replace(/ /g, '_'); const a = formIndex.get(k); if (a) a.push(i); else formIndex.set(k, [i]); }
  }
  const receptive = new Map<number, { t: number; src: number }>(); // word -> earliest reading / listening
  const productive: { word: number; t: number; src: number }[] = [];
  for (const s of [...overlay.sources].sort((a, b) => a.at - b.at)) {
    const i = node({ id: `s:${s.kind}:${s.id}`, kind: 'source', label: s.title, sub: s.kind, ref: `${s.kind}:${s.id}` });
    const n = nodes[i];
    n.discoveredAt = s.at;
    n.skills |= s.kind === 'READING' || s.kind === 'MY_BOOKS' ? SKILL.reading : s.kind === 'LISTENING' ? SKILL.listening : s.kind === 'WRITING' ? SKILL.writing : SKILL.speaking;
    const [uni, bi] = s.tokens.split('|');
    const hits = new Map<number, string[]>();
    for (const tok of [...(uni ? uni.split(' ') : []), ...(bi ? bi.split(' ') : [])]) {
      for (const w of formIndex.get(tok) ?? []) { const a = hits.get(w); if (a) { if (a.length < 4) a.push(tok.replace(/_/g, ' ')); } else hits.set(w, [tok.replace(/_/g, ' ')]); }
    }
    const produced = s.kind === 'WRITING' || s.kind === 'SPEAKING';
    for (const [w, forms] of hits) {
      const e = mkEdge(produced ? 'LEARNER_USED_IN' : 'APPEARS_IN_SOURCE', i, w);
      e.forms = forms; e.at = Math.max(s.at, nodes[w].discoveredAt);
      const only = soleSense(lex, nodes[w].label, forms);
      if (only >= 0) { e.scopes = [[-1, only]]; e.note = 'sole-sense'; }
      pushEdge(e);
      nodes[w].skills |= n.skills;
      nodes[w].touches.push([s.at, n.skills]);
      if (produced) productive.push({ word: w, t: s.at, src: i });
      else if (!receptive.has(w) || receptive.get(w)!.t > s.at) receptive.set(w, { t: s.at, src: i });
    }
  }
  // Wormholes: met in reading / listening FIRST, later produced in writing / speaking (server times).
  const holes = new Map<string, CosmosEdge>();
  for (const p of productive) {
    const r = receptive.get(p.word);
    if (!r || r.t >= p.t) continue;
    const key = `${r.src}:${p.src}`;
    let e = holes.get(key);
    if (!e) { e = mkEdge('CROSS_SKILL_TRANSFER', r.src, p.src); e.at = p.t; holes.set(key, e); }
    if (!e.words.includes(p.word)) e.words.push(p.word);
  }
  for (const e of holes.values()) pushEdge(e);

  // ── 4b. Met in your sources: words you have NOT saved, met in ≥ 2 of your sources or used in your own writing / speech ──
  // A separate, dim layer ("đã gặp"): never counted as learned, never given lexical relations (those stay between your
  // studied words); its only edges say where the form occurs. Everyday content words of the lexicon only, capped.
  const metIndex = metForms(lex);
  const met = new Map<string, { srcs: number[]; forms: string[]; produced: number; times: number[] }>();
  for (const s of [...overlay.sources].sort((a, b) => a.at - b.at)) {
    const si = byId.get(`s:${s.kind}:${s.id}`)!;
    const produced = s.kind === 'WRITING' || s.kind === 'SPEAKING';
    const [uni, bi] = s.tokens.split('|');
    const seenHere = new Set<string>();
    for (const tok of [...(uni ? uni.split(' ') : []), ...(bi ? bi.split(' ') : [])]) {
      const lemma = metIndex.get(tok);
      if (!lemma || seenHere.has(lemma) || byId.has(`w:${lemma}`)) continue;
      seenHere.add(lemma);
      const m = met.get(lemma) ?? { srcs: [], forms: [], produced: 0, times: [] };
      m.srcs.push(si); m.forms.push(tok.replace(/_/g, ' ')); m.times.push(s.at);
      if (produced && !m.produced) m.produced = s.at;
      met.set(lemma, m);
    }
  }
  const metPicked = [...met].filter(([, m]) => m.srcs.length >= 2 || m.produced).sort((a, b) => b[1].srcs.length - a[1].srcs.length || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_MET);
  for (const [lemma, m] of metPicked) {
    const i = node({ id: `w:${lemma}`, kind: 'word', label: lemma, ref: lemma, stage: 'discovered', size: 0.8 });
    const n = nodes[i];
    // discovered when the evidence first qualified: your own use, or the second source
    n.discoveredAt = m.produced && (m.times.length < 2 || m.produced < m.times[1]) ? m.produced : m.times[1];
    const senses = lex.senses(lemma);
    n.anchorSense = senses[0] ?? -1;
    m.srcs.forEach((si, k) => {
      const src = nodes[si], produced = src.sub === 'WRITING' || src.sub === 'SPEAKING';
      const e = mkEdge(produced ? 'LEARNER_USED_IN' : 'APPEARS_IN_SOURCE', si, i);
      e.forms = [m.forms[k]]; e.at = Math.max(src.discoveredAt, n.discoveredAt);
      pushEdge(e);
      n.skills |= src.skills;
      n.touches.push([src.discoveredAt, src.skills]);
    });
  }
  for (const n of nodes) n.touches.sort((a, b) => a[0] - b[0]);

  // Learning stages (see CosmosNode.stage): from the evidence gathered above, nothing else.
  const reviewed = new Set<number>();
  for (const c of overlay.words) if ((c.reviewCount ?? 0) > 0) reviewed.add(c.cardId);
  for (const n of nodes) {
    if (n.kind === 'word' && !n.cardIds.length) n.stage = 'discovered';
    else if (n.kind === 'word') {
      const studiedCard = n.status !== 'NEW' || n.ratings.length > 0 || n.cardIds.some(id => reviewed.has(id));
      n.stage = n.status === 'MASTERED' ? 'mastered' : (n.skills & (SKILL.writing | SKILL.speaking)) ? 'practiced' : studiedCard ? 'studied' : 'saved';
    } else if (n.kind === 'grammar') {
      n.stage = n.status === 'MASTERED' ? 'mastered' : n.status === 'LEARNED' ? 'studied' : 'discovered';
    }
  }

  // ── 5. Eureka suggestions: two known words in DIFFERENT galaxies joined through one verified intermediate ─────────
  // (computed after communities: see below)

  // ── 6. Communities ─────────────────────────────────────────────────────────────────────────────────────────────
  const constellations: Community[] = [];
  const consByKey = new Map<string, number>();
  const cons = (key: string, galaxy: GalaxyId, vi: string, en: string) => {
    let c = consByKey.get(key);
    if (c === undefined) {
      c = constellations.length;
      constellations.push(community('constellation', c, key, vi, en, GALAXY_INDEX[galaxy], c, GALAXIES[GALAXY_INDEX[galaxy]].color));
      consByKey.set(key, c);
    }
    return c;
  };
  const domainInfo = new Map((grammar?.domains ?? []).map(d => [d.id, d]));
  for (const n of nodes) {
    if (n.kind === 'word') {
      const lf = n.anchorSense >= 0 ? lex.lexfile(lex.synOf(n.anchorSense)) : '';
      const def = LEXFILES[lf];
      n.constellation = def ? cons(`lf:${lf}`, def[0], def[1], def[2]) : cons('other', 'other', OTHER_CONSTELLATION[0], OTHER_CONSTELLATION[1]);
    } else if (n.kind === 'grammar') {
      const domain = topicInfo.get(n.ref)?.domain ?? 'grammar';
      const d = domainInfo.get(domain);
      n.constellation = cons(`gd:${domain}`, 'grammar', d?.vi ?? domain, d?.en ?? domain);
    } else if (n.kind === 'source') {
      const [vi, en] = SOURCE_CONSTELLATIONS[n.sub] ?? [n.sub, n.sub];
      n.constellation = cons(`src:${n.sub}`, 'sources', vi, en);
    }
    if (n.constellation >= 0) n.galaxy = constellations[n.constellation].galaxy;
  }

  // Star systems: words of a constellation that share a WordNet ancestor (≤ 3 steps) orbit that concept.
  const systems: Community[] = [];
  const sysByKey = new Map<string, number>();
  const sys = (key: string, n: CosmosNode, vi: string, en: string) => {
    let s = sysByKey.get(key);
    if (s === undefined) {
      s = systems.length;
      systems.push(community('system', s, key, vi, en, n.galaxy, n.constellation, constellations[n.constellation].color));
      sysByKey.set(key, s);
    }
    return s;
  };
  const familiar = (syn: number) => { const li = lex.lemmaIndex.get(lex.synName(syn)); return li !== undefined && lex.core.has(li); };
  const byCons = new Map<number, CosmosNode[]>();
  for (const n of nodes) if (n.constellation >= 0) { const a = byCons.get(n.constellation); if (a) a.push(n); else byCons.set(n.constellation, [n]); }
  for (const [, members] of byCons) {
    const words = members.filter(n => n.kind === 'word' && n.anchorSense >= 0 && n.stage !== 'discovered'); // met words never shape systems
    const chains = new Map<number, number[][]>(); // node -> ancestor synsets by depth (0 = own anchor synset)
    const count = new Map<number, number>();
    for (const n of words) {
      const levels: number[][] = [[lex.synOf(n.anchorSense)]];
      // pure hypernym chains (levels 1–3); an ADJECTIVE's level 1 also holds its WordNet cluster (similar-to), which is
      // never walked further (adjectives have no hypernyms)
      const own = levels[0][0];
      for (let d = 1; d <= 3; d++) levels.push([...new Set(levels[d - 1].flatMap(s => (lex.parents.get(s) ?? []).map(p => p.syn)))]);
      if (lex.pos(own) === 'a') levels[1] = [...new Set([...levels[1], ...(lex.similar.get(own) ?? [])])];
      chains.set(n.i, levels);
      for (const syn of new Set(levels.flat())) count.set(syn, (count.get(syn) ?? 0) + 1);
    }
    for (const n of members) {
      const levels = chains.get(n.i);
      let group = -1, steps = 0;
      if (levels) {
        // The closest ancestor shared with at least one other word of the constellation (own synset counts: "dog" known
        // and "animal" known puts "dog" in the system of "animal" only through the chain, never by name).
        // Only a concept a learner can read names a group: its WordNet name must be everyday vocabulary (the deck / King core),
        // so "animal", "bird", "insect" centre systems, never "craniate" or "aerobe".
        outer: for (let d = 1; d <= 3; d++) for (const syn of levels[d]) if ((count.get(syn) ?? 0) >= 2 && familiar(syn)) { group = syn; steps = d; break outer; }
      }
      if (group < 0) { n.system = sys(`n:${n.id}`, n, n.label, n.label); continue; }
      const centerOwner = words.find(w => lex.synOf(w.anchorSense) === group);
      if (centerOwner) {
        n.system = sys(`syn:${group}:${n.constellation}`, n, centerOwner.label, centerOwner.label);
        if (centerOwner !== n) systems[n.system].center = centerOwner.i;
      } else {
        const name = lex.synName(group);
        const c = node({ id: `c:${group}:${n.constellation}`, kind: 'concept', label: name, sub: lex.gloss(group), ref: String(group),
          galaxy: n.galaxy, constellation: n.constellation });
        n.system = sys(`syn:${group}:${n.constellation}`, n, name, name);
        nodes[c].system = n.system;
        systems[n.system].center = c;
        nodes[c].discoveredAt = Math.min(nodes[c].discoveredAt, n.discoveredAt);
        // The structural link is itself a verified hypernym chain (n steps), labelled with its length.
        const anchorSyn = lex.synOf(n.anchorSense);
        const viaCluster = steps === 1 && lex.pos(anchorSyn) === 'a' && (lex.similar.get(anchorSyn) ?? []).includes(group) && !(lex.parents.get(anchorSyn) ?? []).some(p => p.syn === group);
        const e = mkEdge(viaCluster ? 'SIMILAR_TO' : 'HYPERNYM_OF', c, n.i); e.steps = steps; e.at = n.discoveredAt; e.posMatch = true;
        e.scopes = [[-1, n.anchorSense]]; e.note = 'concept';
        pushEdge(e);
      }
    }
    // A known word that is itself the centre of a system belongs to that system.
    for (const s of systems) if (s.center >= 0 && nodes[s.center].kind === 'word' && s.constellation === members[0]?.constellation) nodes[s.center].system = s.i;
  }

  // ── 5 (cont.). Suggestions ─────────────────────────────────────────────────────────────────────────────────────
  let suggestions = 0;
  const known = (i: number) => nodes[i].kind === 'word';
  const verifiedNeighbours = new Map<number, number[]>();
  for (const e of edges) if (e.status === 'VERIFIED' && known(e.s) && known(e.t)) {
    (verifiedNeighbours.get(e.s) ?? verifiedNeighbours.set(e.s, []).get(e.s)!).push(e.t);
    (verifiedNeighbours.get(e.t) ?? verifiedNeighbours.set(e.t, []).get(e.t)!).push(e.s);
  }
  outerSuggest: for (const [mid, around] of verifiedNeighbours) {
    for (let p = 0; p < around.length; p++) for (let q = p + 1; q < around.length; q++) {
      const a = around[p], b = around[q];
      if (nodes[a].galaxy === nodes[b].galaxy || nodes[a].galaxy === nodes[mid].galaxy && nodes[b].galaxy === nodes[mid].galaxy) continue;
      if (edges.some(e => (e.s === a && e.t === b) || (e.s === b && e.t === a))) continue;
      const e = mkEdge('ASSOCIATED_WITH', Math.min(a, b), Math.max(a, b));
      e.status = 'SUGGESTED'; e.method = 'PATH_SUGGESTION'; e.category = 'suggested'; e.note = `via:${mid}`;
      e.at = Math.max(nodes[a].discoveredAt, nodes[b].discoveredAt, nodes[mid].discoveredAt);
      pushEdge(e);
      if (++suggestions >= MAX_SUGGESTIONS) break outerSuggest;
    }
  }

  // ── 7. Galaxies, counts, degree, size ──────────────────────────────────────────────────────────────────────────
  const galaxies = GALAXIES.map((g, i) => community('galaxy', i, g.id, g.vi, g.en, i, -1, g.color));
  for (const e of edges) if (e.status === 'VERIFIED') { nodes[e.s].degree++; nodes[e.t].degree++; }
  for (const n of nodes) {
    if (n.kind === 'concept') { n.size = 0.9; continue; }
    if (isMet(n)) continue; // the met layer has its own small size and is not counted as knowledge
    const status = STATUS_RANK[n.status] ?? 0;
    n.size = 1.1 + Math.min(1.6, Math.sqrt(n.degree) * 0.32) + status * 0.25 + (n.kind === 'source' ? 0.5 : 0);
    galaxies[n.galaxy].count++;
    if (n.constellation >= 0) constellations[n.constellation].count++;
    if (n.system >= 0) systems[n.system].count++;
    for (const c of [galaxies[n.galaxy], constellations[n.constellation], systems[n.system]]) if (c) c.createdAt = Math.min(c.createdAt, n.discoveredAt);
  }

  // ── 8. Events (Neural Time Travel replays these; nothing is invented between them) ──────────────────────────────
  const events: CosmosEvent[] = [];
  for (const n of nodes) {
    if (n.kind === 'concept') continue;
    events.push({ t: n.discoveredAt, type: 'NODE_DISCOVERED', node: n.i, edge: -1, community: -1, detail: n.kind });
    for (const [t, q] of n.ratings) events.push({ t, type: 'MASTERY_CHANGED', node: n.i, edge: -1, community: -1, detail: String(q) });
  }
  for (const e of edges) if (e.status === 'VERIFIED' && e.note !== 'concept') {
    events.push({ t: e.at, type: e.category === 'source' || e.category === 'transfer' ? 'EVIDENCE_ADDED' : 'EDGE_VERIFIED', node: -1, edge: e.i, community: -1, detail: e.type });
  }
  for (const c of constellations) if (c.count) events.push({ t: c.createdAt, type: 'CLUSTER_CREATED', node: -1, edge: -1, community: c.i, detail: c.key });
  events.sort((a, b) => a.t - b.t || order(a.type) - order(b.type));

  return { lexiconVersion, extractorVersion: overlay.extractorVersion, generatedAt: overlay.generatedAt, nodes, edges, galaxies,
    constellations, systems, events, truncated: { words: overlay.wordsTruncated, reviews: overlay.reviewsTruncated }, withheld };

  function mkEdge(type: RelationType, s: number, t: number): CosmosEdge {
    const r = RELATIONS[type];
    return { i: -1, id: '', s, t, type, status: 'VERIFIED', method: r.method, category: r.category, scopes: [], posMatch: true, common: true,
      steps: 1, forms: [], words: [], note: '', at: 0 };
  }
  function withTime(e: CosmosEdge) { e.at = Math.max(nodes[e.s].discoveredAt, nodes[e.t].discoveredAt); return e; }
  function pushEdge(e: CosmosEdge) {
    if (e.s === e.t) { withheld.selfLoop = (withheld.selfLoop ?? 0) + 1; return; }
    e.i = edges.length; e.id = `${e.type}:${nodes[e.s].id}>${nodes[e.t].id}`; edges.push(e);
  }
}

function community(kind: Community['kind'], i: number, key: string, vi: string, en: string, galaxy: number, constellation: number, color: string): Community {
  return { i, kind, key, vi, en, galaxy, constellation, color, x: 0, y: 0, z: 0, radius: 0, count: 0, createdAt: Number.MAX_SAFE_INTEGER, center: -1 };
}

const order = (t: CosmosEvent['type']) => ['CLUSTER_CREATED', 'NODE_DISCOVERED', 'EVIDENCE_ADDED', 'EDGE_VERIFIED', 'MASTERY_CHANGED'].indexOf(t);

/** Lower is better: senses matching the cards' part of speech first, then the most common senses (WordNet order). */
function scopeRank(lex: Lexicon, nodes: CosmosNode[], e: CosmosEdge, [a, b]: [number, number]) {
  const fit = (posFits(lex, nodes[e.s], a) ? 0 : 50) + (posFits(lex, nodes[e.t], b) ? 0 : 50);
  return fit + lex.rank(a) + lex.rank(b);
}
function posFits(lex: Lexicon, n: CosmosNode, sense: number) {
  return sense < 0 || !n.pos.length || n.pos.includes(lex.pos(lex.synOf(sense)));
}

/**
 * The one WordNet sense of a word, or -1. Only for a core lemma (the lexicon keeps EVERY sense of a core lemma; a frontier lemma
 * keeps only its linking sense, so a single kept sense proves nothing); never for a closed-class word (WordNet has no conjunctions
 * or prepositions: "while" has one noun sense but is mostly a conjunction); and only if neither the word nor any matched form could
 * stand for ANOTHER lemma ("saw" is also a noun, "changing" is also a form of "change"). WordNet's coverage is the limit: a use
 * outside WordNet's senses cannot be seen.
 */
export function soleSense(lex: Lexicon, lemma: string, forms: string[]): number {
  const li = lex.lemmaIndex.get(lemma);
  if (li === undefined || !lex.core.has(li) || CLOSED_CLASS.has(lemma) || lemma.includes(' ')) return -1;
  const senses = lex.senses(lemma);
  if (senses.length !== 1) return -1;
  const owners = formOwners(lex);
  for (const f of [lemma, ...forms]) if ((owners.get(f) ?? []).some(o => o !== lemma) || (f !== lemma && lex.lemmaIndex.has(f))) return -1;
  return senses[0];
}

/** The lexicon lemma a card's word stands for: exact, else a regular plural / verb form whose base is a lexicon lemma. */
export function canonicalLemma(lex: Lexicon, raw: string): string {
  const w = raw.normalize('NFC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
  if (!w || w.length > 60) return '';
  if (lex.lemmaIndex.has(w)) return w;
  const tries = w.endsWith('ies') ? [w.slice(0, -3) + 'y'] : w.endsWith('es') ? [w.slice(0, -2), w.slice(0, -1)] : w.endsWith('s') ? [w.slice(0, -1)] : [];
  for (const t of tries) if (lex.lemmaIndex.has(t)) return t;
  return w;
}
