/// <reference lib="webworker" />
// Echo Neural Cosmos worker: downloads the immutable lexicon once, builds and lays out the learner's universe off the main
// thread, and returns the graph plus ONLY the senses the graph refers to (the 5 MB lexicon never reaches the page).
import { buildUniverse } from './build';
import type { SenseTable } from './explain';
import { layout } from './layout';
import { Lexicon } from './lexicon';
import { answer, buildAskIndex, type AskIndex, type AskResult } from './rag';
import type { CosmosGraph, GrammarDomainLite, GrammarTopicLite, Overlay } from './types';

export type WorkerRequest =
  | { id: number; url: string; version: string; overlay: Overlay; grammar: { domains: GrammarDomainLite[]; topics: GrammarTopicLite[] } | null }
  | { id: number; ask: { question: string; vi: boolean; focus: number } };
export type WorkerResponse =
  | { id: number; stage: 'lexicon' | 'building' }
  | { id: number; graph: CosmosGraph; senses: SenseTable; senseLists: Record<string, number[]>; timing: { lexiconMs: number; buildMs: number } }
  | { id: number; answer: AskResult; ms: number }
  | { id: number; error: string };

let lexicon: Promise<Lexicon> | null = null;
let generation = 0;
const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);
/** The universe last built here, for "Hỏi vũ trụ" (retrieval needs the whole lexicon, which never leaves the worker). */
let current: { lex: Lexicon; graph: CosmosGraph; idx: AskIndex } | null = null;

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if ('ask' in msg) {
    try {
      if (!current) throw new Error('not-ready');
      const t0 = performance.now();
      const result = answer(current.lex, current.graph, current.idx, msg.ask.question, msg.ask.vi, msg.ask.focus);
      post({ id: msg.id, answer: result, ms: Math.round(performance.now() - t0) });
    } catch (e) { post({ id: msg.id, error: e instanceof Error ? e.message : String(e) }); }
    return;
  }
  const req = msg, mine = ++generation;
  try {
    post({ id: req.id, stage: 'lexicon' });
    const t0 = performance.now();
    lexicon ??= fetch(req.url, { credentials: 'same-origin' }).then(r => {
      if (!r.ok) throw new Error(`lexicon ${r.status}`);
      return r.json();
    }).then(file => new Lexicon(file));
    let lex: Lexicon;
    try { lex = await lexicon; } catch (e) { lexicon = null; throw e; }
    if (mine !== generation) return;
    const t1 = performance.now();
    post({ id: req.id, stage: 'building' });
    const graph = layout(buildUniverse(lex, req.overlay, req.grammar, req.version));
    if (mine !== generation) return;
    current = { lex, graph, idx: buildAskIndex(lex, graph, req.grammar?.topics ?? null) };
    const senses: SenseTable = {};
    const info = (s: number) => { if (s >= 0 && !(s in senses)) senses[s] = [lex.lemmaOf(s), lex.pos(lex.synOf(s)), lex.gloss(lex.synOf(s)), lex.rank(s)]; };
    const senseLists: Record<string, number[]> = {};
    for (const e of graph.edges) for (const [a, b] of e.scopes) { info(a); info(b); }
    for (const n of graph.nodes) {
      if (n.kind !== 'word') continue;
      const list = lex.senses(n.label).slice(0, 12);
      senseLists[n.label] = list;
      list.forEach(info);
      n.frontier.forEach(f => { info(f.sense); info(f.via); });
    }
    post({ id: req.id, graph, senses, senseLists, timing: { lexiconMs: Math.round(t1 - t0), buildMs: Math.round(performance.now() - t1) } });
  } catch (e) {
    if (mine === generation) post({ id: req.id, error: e instanceof Error ? e.message : String(e) });
  }
};
