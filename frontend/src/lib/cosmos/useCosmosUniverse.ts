'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cosmosApi } from '@/services/cosmosApi';
import { grammarApi } from '@/services/grammarApi';
import type { SenseTable } from './explain';
import { COSMOS_LEXICON_URL, COSMOS_LEXICON_VERSION } from './lexiconAsset';
import { myBooksSources } from './localSources';
import type { AskResult } from './rag';
import type { CosmosGraph, GrammarDomainLite, GrammarTopicLite } from './types';
import type { WorkerRequest, WorkerResponse } from './cosmos.worker';

export type Ready = { phase: 'ready'; graph: CosmosGraph; senses: SenseTable; senseLists: Record<string, number[]>; refreshing: boolean;
  timing: { evidenceMs: number; lexiconMs: number; buildMs: number } };
export type UniverseState =
  | { phase: 'loading'; stage: 'evidence' | 'lexicon' | 'building' }
  | { phase: 'error'; message: string }
  | Ready;

/**
 * Loads the learner's universe: evidence (one GET), the authored grammar catalog and the account's own My Books highlights
 * (device only), then the worker joins them with the immutable lexicon. `refresh()` rebuilds while the current universe stays
 * on screen (the layout is a pure function of identity, so stars keep their places). Nothing is cached across accounts: the
 * graph lives in this component only, keyed by the account.
 */
export type Ask = (question: string, vi: boolean, focus: number) => Promise<{ answer: AskResult; ms: number }>;

export function useCosmosUniverse(userId: string): [UniverseState, () => void, () => void, Ask] {
  const [state, setState] = useState<UniverseState>({ phase: 'loading', stage: 'evidence' });
  const [run, setRun] = useState({ n: 0, soft: false });
  const worker = useRef<Worker | null>(null);
  const asks = useRef(new Map<number, { resolve: (v: { answer: AskResult; ms: number }) => void; reject: (e: Error) => void }>());
  const askSeq = useRef(0);
  // The authored grammar catalog is public and changes only with a release: read once per visit, not on every rebuild
  // (performance release 2026-11-16, PERF-13).
  const catalogOnce = useRef<Promise<Awaited<ReturnType<typeof grammarApi.catalog>> | null> | null>(null);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    // A newer run (navigation, learning pulse, return to the tab) abandons this one's evidence request instead of letting
    // it finish only to be thrown away (PERF-13). The account's auth epoch still cancels everything on sign-out.
    const abort = new AbortController();
    const id = run.n;
    if (!run.soft) setState({ phase: 'loading', stage: 'evidence' });
    else setState(s => (s.phase === 'ready' ? { ...s, refreshing: true } : s));
    const t0 = performance.now();
    (async () => {
      const catalogRequest = catalogOnce.current ??= grammarApi.catalog().catch(() => { catalogOnce.current = null; return null; });
      const [overlay, catalog, books] = await Promise.all([cosmosApi.overlay(abort.signal), catalogRequest, myBooksSources(userId)]);
      if (!live) return;
      overlay.sources = [...overlay.sources, ...books];
      const grammar = catalog ? {
        domains: catalog.domains.map((d): GrammarDomainLite => ({ id: d.id, vi: d.title.vi, en: d.title.en })),
        topics: catalog.domains.flatMap(d => d.topics.map((t): GrammarTopicLite => ({ slug: t.slug, domain: d.id, vi: t.title.vi, en: t.title.en,
          level: t.level, prerequisites: t.prerequisites ?? [], related: t.related ?? [] }))),
      } : null;
      const evidenceMs = Math.round(performance.now() - t0);
      const w = worker.current ??= new Worker(new URL('./cosmos.worker.ts', import.meta.url), { type: 'module', name: 'cosmos' });
      w.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const m = event.data;
        if (m.id < 0) { const p = asks.current.get(m.id); if (p) { asks.current.delete(m.id); if ('answer' in m) p.resolve({ answer: m.answer, ms: m.ms }); else p.reject(new Error('error' in m ? m.error : 'ask')); } return; }
        if (!live || m.id !== id) return;
        if ('stage' in m) { if (!run.soft) setState({ phase: 'loading', stage: m.stage }); }
        else if ('error' in m) setState({ phase: 'error', message: m.error });
        else if ('answer' in m) return;
        else setState({ phase: 'ready', graph: m.graph, senses: m.senses, senseLists: m.senseLists, refreshing: false, timing: { evidenceMs, ...m.timing } });
      };
      w.onerror = () => { if (live) setState({ phase: 'error', message: 'worker' }); };
      w.postMessage({ id, url: COSMOS_LEXICON_URL, version: COSMOS_LEXICON_VERSION, overlay, grammar } satisfies WorkerRequest);
    })().catch(e => {
      if (!live) return;
      const message = e?.response?.status ? `HTTP ${e.response.status}` : 'network';
      setState(s => (run.soft && s.phase === 'ready' ? { ...s, refreshing: false } : { phase: 'error', message }));
    });
    return () => { live = false; abort.abort(); };
  }, [run, userId]);
  useEffect(() => () => { worker.current?.terminate(); worker.current = null; }, []);
  // Live growth: a learning action stored anywhere in the app (this tab or another tab of this browser) rebuilds the universe
  // from the server's evidence. Debounced; while the tab is hidden it only marks the universe stale and rebuilds on return.
  useEffect(() => {
    if (!userId) return;
    let timer: ReturnType<typeof setTimeout> | null = null, stale = false, last = 0;
    const kick = () => {
      if (document.visibilityState !== 'visible') { stale = true; return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; last = Date.now(); setRun(r => ({ n: r.n + 1, soft: true })); }, Math.max(1500, 4000 - (Date.now() - last)));
    };
    const onVisible = () => { if (document.visibilityState === 'visible' && stale) { stale = false; kick(); } };
    let channel: BroadcastChannel | null = null;
    try { channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ec-learning-evidence') : null; } catch { channel = null; }
    if (channel) channel.onmessage = kick;
    window.addEventListener('ec:learning-evidence', kick);
    document.addEventListener('visibilitychange', onVisible);
    return () => { if (timer) clearTimeout(timer); channel?.close(); window.removeEventListener('ec:learning-evidence', kick); document.removeEventListener('visibilitychange', onVisible); };
  }, [userId]);
  const retry = useCallback(() => setRun(r => ({ n: r.n + 1, soft: false })), []);
  const refresh = useCallback(() => setRun(r => ({ n: r.n + 1, soft: true })), []);
  // Questions run in the worker beside the lexicon (negative ids never collide with builds). No request, no AI.
  const ask = useCallback<Ask>((question, vi, focus) => new Promise((resolve, reject) => {
    const w = worker.current;
    if (!w) { reject(new Error('not-ready')); return; }
    const id = -(++askSeq.current);
    asks.current.set(id, { resolve, reject });
    w.postMessage({ id, ask: { question, vi, focus } } satisfies WorkerRequest);
  }), []);
  return [state, retry, refresh, ask];
}
