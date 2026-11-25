'use client';
/**
 * "Hỏi vũ trụ" — questions answered only from the universe's evidence, every claim with its citation. The retrieval runs in
 * the Cosmos worker (no AI, no request); only when an answer needs source sentences does it read them: from the server for the
 * learner's own visible sources (`POST /cosmos/passages`, owner-scoped) and from My Books highlights on this device. Quoted
 * text is shown as plain text (never markup) and never decides a claim.
 */
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X, Send } from 'lucide-react';
import { cosmosApi } from '@/services/cosmosApi';
import type { Ask } from '@/lib/cosmos/useCosmosUniverse';
import { composePassages, localPassages, type AskResult, type Citation, type PassageIn } from '@/lib/cosmos/rag';
import { myBooksPassageTexts } from '@/lib/cosmos/localSources';
import { CATEGORY_COLOR, RELATIONS } from '@/lib/cosmos/ontology';
import type { CosmosGraph, CosmosNode } from '@/lib/cosmos/types';
import { POS_EN, POS_VI } from '@/lib/cosmos/explain';
import s from './cosmos.module.css';

const STATUS: Record<AskResult['status'], [string, string]> = {
  answered: ['Có bằng chứng', 'Evidence found'], insufficient: ['Chưa đủ bằng chứng', 'Not enough evidence'],
  'not-found': ['Không có trong bản đồ', 'Not in the map'], unsupported: ['Ngoài phạm vi bằng chứng', 'Outside the evidence'],
};
const HINTS = [['Vì sao "bank" và "river" liên quan?', 'Tôi đã gặp "climate" ở đâu?', 'Tuần này tôi đã học những từ nào?', 'Từ nào tôi sắp quên?'],
  ['Why are "bank" and "river" related?', 'Where did I meet "climate"?', 'Which words did I study this week?', 'Which words am I forgetting?']];

export default function AskCosmos({ g, vi, ask, userId, focusNode, onNode, onEdge, onClose, saveWord, saving }: {
  g: CosmosGraph; vi: boolean; ask: Ask; userId: string; focusNode: number;
  onNode: (n: CosmosNode) => void; onEdge: (i: number) => void; onClose: () => void;
  saveWord: (w: string) => void; saving: Record<string, 'saving' | 'saved' | 'error'>;
}) {
  const T = (a: string, b: string) => (vi ? a : b);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);
  const focus = focusNode >= 0 ? g.nodes[focusNode] : null;
  const subject = focus && (focus.kind === 'word' || focus.kind === 'grammar') ? (focus.kind === 'grammar' && vi ? focus.sub || focus.label : focus.label) : '';
  const suggestions = subject && focus?.kind === 'word'
    ? [T(`Tôi đã gặp "${subject}" ở đâu?`, `Where did I meet "${subject}"?`), T(`Từ nào liên quan đến "${subject}" mà tôi chưa học?`, `Which words related to "${subject}" have I not learned?`),
      T(`"${subject}" có những nghĩa nào?`, `What are the senses of "${subject}"?`), T(`Câu nào trong bài học của tôi có "${subject}"?`, `Which sentences in my lessons have "${subject}"?`)]
    : subject ? [T(`Tôi đã học "${subject}" thế nào?`, `How did I study "${subject}"?`)] : HINTS[vi ? 0 : 1];

  const run = async (question: string) => {
    const text = question.trim();
    if (!text) return;
    const mine = ++seq.current;
    setBusy(true); setErr(''); setFlash(-1);
    try {
      const { answer } = await ask(text, vi, focusNode);
      let out = answer;
      const plan = answer.plan;
      if (plan) {
        const [server, books] = await Promise.all([
          plan.refs.length ? cosmosApi.passages({ refs: plan.refs, groups: plan.groups, limit: 3 }).catch(() => null) : Promise.resolve({ passages: [], more: false }),
          plan.local.length ? myBooksPassageTexts(userId, plan.local).then(b => localPassages(b, plan.groups)).catch(() => [] as PassageIn[]) : Promise.resolve([] as PassageIn[]),
        ]);
        if (!server) setErr(T('Không tải được các câu trích từ nguồn; phần trả lời dưới đây chỉ dựa trên bản đồ.', 'Source sentences could not be loaded; the answer below uses the map only.'));
        const list: PassageIn[] = [...(server?.passages ?? []).map(p => ({ ...p, spans: p.spans as [number, number, number][] })), ...books];
        out = composePassages(answer, list, !!server?.more, vi);
      }
      if (mine === seq.current) setResult(out);
    } catch {
      if (mine === seq.current) setErr(T('Chưa trả lời được lúc này. Thử lại sau giây lát.', 'Could not answer right now. Try again in a moment.'));
    } finally { if (mine === seq.current) setBusy(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void run(q); };
  const pick = (h: string) => { setQ(h); void run(h); };

  return (
    <aside className={`${s.panel} ${s.ask}`} aria-label={T('Hỏi vũ trụ', 'Ask the universe')} data-ask-status={busy ? 'busy' : result?.status ?? 'idle'} data-ask-intent={result?.intent ?? ''}>
      <div className={s.inspectorHead}><div><p className={s.kicker}>{T('Trả lời bằng bằng chứng, có trích dẫn', 'Answers from evidence, with citations')}</p><h2>{T('Hỏi vũ trụ', 'Ask the universe')}</h2></div>
        <button className={s.close} onClick={onClose} aria-label={T('Đóng', 'Close')}><X size={16} /></button></div>
      <form className={s.askForm} onSubmit={submit}>
        <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} maxLength={300} placeholder={T('Ví dụ: Vì sao "bank" và "river" liên quan?', 'e.g. Why are "bank" and "river" related?')} aria-label={T('Câu hỏi', 'Question')} />
        <button className={s.btn} type="submit" disabled={busy || !q.trim()} aria-label={T('Hỏi', 'Ask')}><Send size={15} /></button>
      </form>
      <div className={s.askBody} aria-live="polite" aria-busy={busy}>
        {!result && !busy && <>
          <p className={s.muted}>{T('Vũ trụ trả lời từ quan hệ đã kiểm chứng (WordNet, Grammar Academy), thẻ và bài học của bạn, và câu trong nguồn bạn đã học. Khi bằng chứng không đủ, nó nói rõ thay vì đoán. Không dùng AI.', 'The universe answers from verified relations (WordNet, Grammar Academy), your cards and lessons, and sentences of sources you studied. When the evidence is not enough it says so instead of guessing. No AI.')}</p>
          <div className={s.chips}>{suggestions.map(h => <button key={h} className={s.hintBtn} onClick={() => pick(h)}>{h}</button>)}</div>
        </>}
        {busy && <p className={s.muted} role="status">{T('Đang tìm bằng chứng…', 'Searching the evidence…')}</p>}
        {err && <p className={s.bad} role="alert">{err}</p>}
        {result && !busy && <Answer r={result} g={g} vi={vi} flash={flash} setFlash={setFlash} onNode={onNode} onEdge={onEdge} saveWord={saveWord} saving={saving} ask={pick} />}
      </div>
    </aside>
  );
}

function Answer({ r, g, vi, flash, setFlash, onNode, onEdge, saveWord, saving, ask }: {
  r: AskResult; g: CosmosGraph; vi: boolean; flash: number; setFlash: (i: number) => void; onNode: (n: CosmosNode) => void; onEdge: (i: number) => void;
  saveWord: (w: string) => void; saving: Record<string, 'saving' | 'saved' | 'error'>; ask: (q: string) => void;
}) {
  const T = (a: string, b: string) => (vi ? a : b);
  const listRef = useRef<HTMLOListElement>(null);
  const jump = (k: number) => { setFlash(k); listRef.current?.querySelector(`[data-cite="${k}"]`)?.scrollIntoView({ block: 'nearest' }); };
  return (
    <>
      <span className={s.status} data-s={r.status}>{STATUS[r.status][vi ? 0 : 1]}</span>
      {r.lines.map((l, k) => <p key={k} className={s.askLine}>{l.text}{l.cites.slice(0, 8).map(c => <button key={c} className={s.citeRef} onClick={() => jump(c)} aria-label={T(`Trích dẫn ${c + 1}`, `Citation ${c + 1}`)}>{c + 1}</button>)}{l.cites.length > 8 ? ` +${l.cites.length - 8}` : ''}</p>)}
      {r.related.length > 0 && <div><p className={s.kicker}>{T('Từ liên quan bạn chưa học', 'Related words you have not learned')}</p>
        {r.related.map(x => <div key={x.lemma} className={s.rel}><span className={s.relType} style={{ background: CATEGORY_COLOR[RELATIONS[x.type].category] }}>{vi ? RELATIONS[x.type].vi : RELATIONS[x.type].en}</span><b>{x.lemma}</b>
          <span className={s.faint} title={x.gloss}>{x.gloss.slice(0, 54)}</span>
          <button className={s.why} disabled={saving[x.lemma] === 'saving' || saving[x.lemma] === 'saved'} onClick={() => saveWord(x.lemma)}>{saving[x.lemma] === 'saved' ? T('Đã lưu', 'Saved') : saving[x.lemma] === 'error' ? T('Thử lại', 'Retry') : T('Lưu Flashcard', 'Save card')}</button></div>)}</div>}
      {(r.status === 'unsupported' || r.status === 'not-found') && <div className={s.chips}>{r.hints.slice(0, 4).map(h => <button key={h} className={s.hintBtn} onClick={() => ask(h)}>{h}</button>)}</div>}
      {r.citations.length > 0 && <div><p className={s.kicker}>{T('Trích dẫn', 'Citations')}</p>
        <ol ref={listRef} className={s.citations}>{r.citations.map((c, k) => <li key={k} className={s.citation} data-cite={k} data-kind={c.kind} data-flash={flash === k ? '1' : undefined}><span className={s.citeNo}>{k + 1}</span><div><Cite c={c} g={g} vi={vi} onNode={onNode} onEdge={onEdge} /></div></li>)}</ol></div>}
      <p className={s.faint}>{T('Trả lời được ghép từ bằng chứng theo quy tắc, không do AI viết. Câu trích là dữ liệu: nội dung của nó không tạo ra quan hệ.', 'Answers are assembled from evidence by rules, not written by AI. Quoted sentences are data: what they say creates no relation.')}</p>
    </>
  );
}

function Cite({ c, g, vi, onNode, onEdge }: { c: Citation; g: CosmosGraph; vi: boolean; onNode: (n: CosmosNode) => void; onEdge: (i: number) => void }) {
  const T = (a: string, b: string) => (vi ? a : b);
  const POS = vi ? POS_VI : POS_EN;
  if (c.kind === 'sense') return <span><b>{c.lemma}</b> <em className={s.faint}>({POS[c.pos]})</em>: {c.gloss} <span className={s.faint}>· Open English WordNet 2025</span></span>;
  if (c.kind === 'evidence') return c.node >= 0 && g.nodes[c.node]
    ? <span>{c.text} · <button className={s.relWord} onClick={() => onNode(g.nodes[c.node])}>{T('xem trên bản đồ', 'show on the map')}</button></span>
    : <span>{c.text}</span>;
  if (c.kind === 'relation') {
    if (!c.hops.length && c.edge >= 0) {
      const e = g.edges[c.edge];
      return <span>{g.nodes[e.s].sub && g.nodes[e.s].kind === 'grammar' && vi ? g.nodes[e.s].sub : g.nodes[e.s].label} — {vi ? RELATIONS[e.type].vi : RELATIONS[e.type].en} — {g.nodes[e.t].sub && g.nodes[e.t].kind === 'grammar' && vi ? g.nodes[e.t].sub : g.nodes[e.t].label} · <button className={s.relWord} onClick={() => onEdge(c.edge)}>{T('Vì sao?', 'Why?')}</button></span>;
    }
    return <div style={{ display: 'grid', gap: 4 }}>
      {c.hops.map((h, k) => <span key={k} className={s.scope}><b>{h.a}</b> <em>({POS[h.posA]})</em> — {hopLabel(h, vi)} — <b>{h.b}</b> <em>({POS[h.posB]})</em>: {h.glossB}</span>)}
      <span className={s.faint}>{T('Open English WordNet 2025: quan hệ giữa hai nghĩa cụ thể', 'Open English WordNet 2025: relations between specific senses')}{c.distant ? T(' · liên hệ xa', ' · distant link') : ''}</span>
      {c.edge >= 0 && <button className={s.relWord} onClick={() => onEdge(c.edge)}>{T('Xem cạnh này trong vũ trụ', 'Show this edge in the universe')}</button>}
    </div>;
  }
  const [kind, id] = c.ref.split(':');
  const href = kind === 'READING' ? `/reading?materialId=${encodeURIComponent(id)}` : kind === 'LISTENING' ? `/listening/${encodeURIComponent(id)}${c.segmentId ? `?segment=${c.segmentId}` : ''}`
    : kind === 'WRITING' ? '/writing' : kind === 'SPEAKING' ? '/speaking' : '/reading';
  const label = ({ READING: T('Bài đọc', 'Reading'), LISTENING: T('Bài nghe', 'Listening'), WRITING: T('Bài viết của bạn', 'Your writing'), SPEAKING: T('Lời nói của bạn', 'Your speaking'), MY_BOOKS: T('Sách của tôi · trên thiết bị này', 'My Books · this device') } as Record<string, string>)[kind] ?? kind;
  return <div style={{ display: 'grid', gap: 4 }}>
    <blockquote className={s.quote}><Marked text={c.text} spans={c.spans} /></blockquote>
    <span className={s.faint}>{label} · {c.title} · {new Date(c.at).toLocaleDateString(vi ? 'vi-VN' : 'en-GB')} · <Link className={s.relWord} href={href} onClick={() => { if (kind === 'MY_BOOKS') { try { localStorage.setItem('readingActiveTab', 'mybooks'); } catch { /* optional */ } } }}>{kind === 'LISTENING' && c.segmentId ? T('Mở đúng câu', 'Open this sentence') : T('Mở nguồn', 'Open source')}</Link></span>
  </div>;
}

/** Plain-text rendering with the matched forms marked (React text nodes only; never HTML from the source). */
function Marked({ text, spans }: { text: string; spans: [number, number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [a, b, grp] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (a < at || b > text.length) continue;
    if (a > at) parts.push(text.slice(at, a));
    parts.push(<mark key={a} data-g={grp}>{text.slice(a, b)}</mark>);
    at = b;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A hop read left to right: "dog — is a kind of — canine", "hand — has part — finger" (never a backwards label). */
function hopLabel(h: { type: keyof typeof RELATIONS; dir: 'up' | 'down' | 'same' }, vi: boolean) {
  const r = RELATIONS[h.type];
  const inverse = (h.type === 'HYPERNYM_OF' && h.dir === 'up') || (h.type === 'PART_OF' && h.dir === 'down');
  return inverse ? (vi ? r.inverseVi : r.inverseEn) ?? r.vi : vi ? r.vi : r.en;
}
