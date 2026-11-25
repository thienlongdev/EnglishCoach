'use client';
/**
 * Cây tri thức — the same universe as an interactive hierarchy: Universe → Galaxies → Constellations → Star systems → Knowledge
 * stars. Every row is a real node / community of the graph. The tree is the universe's PRESENTATION grouping (where a star is
 * placed); verified semantic relations stay in the inspector ("Soi"), never implied by a parent row. Lazy rows (only expanded
 * branches exist), windowed rendering (fixed row height), roving keyboard focus (WAI-ARIA tree), no request, no AI.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { BookOpen, Box, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, Info, Orbit, Atom, Search, Waypoints, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { memoryOf, MEMORY_LABEL, type MemoryState } from '@/lib/cosmos/memory';
import type { Focus } from '@/lib/cosmos/view';
import { UNIVERSE } from '@/lib/cosmos/view';
import type { CosmosGraph, CosmosNode } from '@/lib/cosmos/types';
import s from './cosmos.module.css';

import type { TreeItem as TNode } from '@/lib/cosmos/treeLayout';
import LivingKnowledgeTree from './LivingKnowledgeTree';
import tree from './livingTree.module.css';
const ROW = 38;

/** Memory dot colours on the pearl surface (paired with a text label in the title and the inspector, never colour alone). */
export const MEMORY_TONE: Record<MemoryState, string> = {
  new: '#0891b2', recent: '#0ea5b7', renewed: '#059669', learning: '#2563eb', stable: '#c2780a', fading: '#94a3b8',
  atRisk: '#64748b', weak: '#7c3aed', mistaken: '#3b0764', met: '#cbd5e1',
};

export default function KnowledgeTree({ g, vi, showMet, visibleNode, selected, onSelect, onShow3D, notice, onRetry }: {
  g: CosmosGraph; vi: boolean; showMet: boolean; visibleNode?: Uint8Array | null; selected: number;
  onSelect: (n: CosmosNode) => void; onShow3D: (f: Focus) => void; notice: string; onRetry?: () => void;
}) {
  const T = (a: string, b: string) => (vi ? a : b);
  const isMet = (n: CosmosNode) => n.kind === 'word' && !n.cardIds.length;

  // ── the hierarchy, indexed once per graph ────────────────────────────────────────────────────────────────────────
  const index = useMemo(() => {
    const keep = (n: CosmosNode) => n.kind !== 'concept' && (showMet || !isMet(n)) && (!visibleNode || visibleNode[n.i] === 1);
    const stars = g.nodes.filter(keep);
    const kids = new Map<string, TNode[]>();
    const push = (p: string, c: TNode) => { const a = kids.get(p); if (a) a.push(c); else kids.set(p, [c]); };
    const count = { gal: new Map<number, number>(), con: new Map<number, number>(), sys: new Map<number, number>() };
    const inc = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1);
    const metc = { gal: new Map<number, number>(), con: new Map<number, number>(), sys: new Map<number, number>() };
    for (const n of stars) { const m = isMet(n) ? metc : count; inc(m.gal, n.galaxy); if (n.constellation >= 0) inc(m.con, n.constellation); if (n.system >= 0) inc(m.sys, n.system); }
    const real = (i: number, m: Map<number, number>) => m.get(i) ?? 0;
    const multi = new Set(g.systems.filter(y => y.count > 1 && y.center >= 0 && g.nodes[y.center]?.kind === 'concept').map(y => y.i));
    const name = (c: { vi: string; en: string }) => (vi ? c.vi : c.en);
    const root: TNode = { id: 'u', kind: 'universe', label: T('Vũ trụ của bạn', 'Your universe'), sub: '', count: stars.filter(n => !isMet(n)).length, depth: 0, parent: '', node: -1, focus: UNIVERSE, color: '#0e7490' };
    for (const gal of g.galaxies) {
      const has = stars.some(n => n.galaxy === gal.i);
      if (!has) continue;
      push('u', { id: `gal:${gal.key}`, kind: 'galaxy', label: name(gal), sub: '', count: real(gal.i, count.gal), met: real(gal.i, metc.gal), depth: 1, parent: 'u', node: -1, focus: { ...UNIVERSE, level: 'galaxy', galaxy: gal.i }, color: gal.color });
    }
    for (const c of g.constellations) {
      if (!stars.some(n => n.constellation === c.i)) continue;
      const gal = g.galaxies[c.galaxy];
      push(`gal:${gal.key}`, { id: `con:${c.key}`, kind: 'constellation', label: name(c), sub: '', count: real(c.i, count.con), met: real(c.i, metc.con), depth: 2, parent: `gal:${gal.key}`, node: -1, focus: { ...UNIVERSE, level: 'constellation', galaxy: c.galaxy, constellation: c.i }, color: gal.color });
    }
    for (const y of g.systems) {
      if (!multi.has(y.i) || !stars.some(n => n.system === y.i)) continue;
      const c = g.constellations[y.constellation];
      push(`con:${c.key}`, { id: `sys:${y.key}`, kind: 'system', label: name(y), sub: T('khái niệm WordNet chung', 'shared WordNet concept'), count: real(y.i, count.sys), met: real(y.i, metc.sys), depth: 3, parent: `con:${c.key}`, node: y.center, focus: { level: 'system', galaxy: y.galaxy, constellation: y.constellation, system: y.i, node: -1 }, color: g.galaxies[y.galaxy].color });
    }
    const label = (n: CosmosNode) => (n.kind === 'grammar' && vi ? n.sub || n.label : n.label);
    for (const n of [...stars].sort((a, b) => Number(isMet(a)) - Number(isMet(b)) || label(a).localeCompare(label(b)))) {
      const inSys = multi.has(n.system);
      const parent = inSys ? `sys:${g.systems[n.system].key}` : n.constellation >= 0 ? `con:${g.constellations[n.constellation].key}` : `gal:${g.galaxies[n.galaxy].key}`;
      push(parent, { id: n.id, kind: 'star', label: label(n), sub: n.kind === 'word' ? n.sub : n.kind === 'grammar' && vi ? n.label : n.kind === 'source' ? sourceKind(n, vi) : n.sub, count: 0, depth: inSys ? 4 : n.constellation >= 0 ? 3 : 2, parent, node: n.i,
        focus: { level: 'star', galaxy: n.galaxy, constellation: n.constellation, system: n.system, node: n.i }, color: g.galaxies[n.galaxy]?.color ?? '#64748b' });
    }
    const byId = new Map<string, TNode>([['u', root]]);
    for (const list of kids.values()) for (const t of list) byId.set(t.id, t);
    const starRow = new Map<number, string>();
    for (const t of byId.values()) if (t.kind === 'star') starRow.set(t.node, t.id);
    return { root, kids, byId, starRow };
  }, [g, vi, showMet, visibleNode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── expansion, search, selection ─────────────────────────────────────────────────────────────────────────────────
  const [open, setOpen] = useState<Set<string>>(() => new Set(['u', ...(index.kids.get('u') ?? []).slice(0, 2).map(t => t.id)]));
  const [entering, setEntering] = useState('');
  const [query, setQuery] = useState('');
  const [outline, setOutline] = useState(false);
  const q = query.trim().toLowerCase();
  const ancestors = useCallback((id: string) => { const out: string[] = []; let t = index.byId.get(id); while (t && t.parent) { out.push(t.parent); t = index.byId.get(t.parent); } return out; }, [index]);
  // a star selected elsewhere (3D, search, a guide card) opens its branch in the tree
  const selectedRow = selected >= 0 ? index.starRow.get(selected) ?? '' : '';
  useEffect(() => { if (selectedRow) setOpen(o => { const a = ancestors(selectedRow); if (a.every(x => o.has(x))) return o; const n = new Set(o); a.forEach(x => n.add(x)); return n; }); }, [selectedRow, ancestors]);
  const matches = useMemo(() => {
    if (!q) return null;
    const hit = new Set<string>(), path = new Set<string>();
    for (const t of index.byId.values()) if (t.kind !== 'universe' && (t.label.toLowerCase().includes(q) || t.sub.toLowerCase().includes(q))) { hit.add(t.id); ancestors(t.id).forEach(a => path.add(a)); }
    return { hit, path };
  }, [q, index, ancestors]);

  const rows = useMemo(() => {
    const out: TNode[] = [];
    const walk = (t: TNode) => {
      if (matches && t.id !== 'u' && !matches.hit.has(t.id) && !matches.path.has(t.id)) return;
      out.push(t);
      const expanded = matches ? matches.path.has(t.id) || t.id === 'u' : open.has(t.id);
      if (expanded) for (const c of index.kids.get(t.id) ?? []) walk(c);
    };
    walk(index.root);
    return out;
  }, [index, open, matches]);

  const toggle = (t: TNode, force?: boolean) => {
    if (t.kind === 'star') return;
    setOpen(o => { const n = new Set(o); const want = force ?? !n.has(t.id); if (want) n.add(t.id); else n.delete(t.id); return n; });
    if (force !== false && !open.has(t.id)) { setEntering(t.id); window.setTimeout(() => setEntering(e => (e === t.id ? '' : e)), 420); }
  };
  const activate = (t: TNode) => { if (t.kind === 'star') onSelect(g.nodes[t.node]); else toggle(t); };

  // ── roving focus + windowing ─────────────────────────────────────────────────────────────────────────────────────
  const [cursor, setCursor] = useState('u');
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el); setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [outline]);
  useEffect(() => { if (selectedRow) setCursor(selectedRow); }, [selectedRow]);
  const cursorIndex = Math.max(0, rows.findIndex(r => r.id === cursor));
  const reveal = (i: number) => {
    const el = box.current;
    if (!el) return;
    if (i * ROW < el.scrollTop) el.scrollTop = i * ROW;
    else if ((i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW - el.clientHeight;
  };
  // scroll a star selected elsewhere into view once its branch is open (rows change after the expansion)
  const revealed = useRef('');
  useEffect(() => {
    if (!selectedRow || revealed.current === selectedRow) return;
    const i = rows.findIndex(r => r.id === selectedRow);
    if (i >= 0) { revealed.current = selectedRow; reveal(i); }
  }, [selectedRow, rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusRow = (i: number) => {
    const t = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!t) return;
    setCursor(t.id); reveal(rows.indexOf(t));
    requestAnimationFrame(() => (box.current?.querySelector(`[data-row="${CSS.escape(t.id)}"]`) as HTMLElement | null)?.focus({ preventScroll: true }));
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const t = rows[cursorIndex];
    if (!t) return;
    const isOpen = matches ? true : open.has(t.id);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(cursorIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(cursorIndex - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusRow(0); }
    else if (e.key === 'End') { e.preventDefault(); focusRow(rows.length - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (t.kind !== 'star' && !isOpen) toggle(t, true); else if (t.kind !== 'star') focusRow(cursorIndex + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (t.kind !== 'star' && isOpen && t.id !== 'u' && !matches) toggle(t, false); else if (t.parent) focusRow(rows.findIndex(r => r.id === t.parent)); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(t); }
    else if (e.key === ' ') { e.preventDefault(); if (t.kind === 'star') onSelect(g.nodes[t.node]); else toggle(t); }
  };

  const first = Math.max(0, Math.floor(scroll / ROW) - 6), last = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 6);
  const now = g.generatedAt;
  const sizeOf = (t: TNode) => (index.kids.get(t.id)?.length ?? 0);

  return (
    <section className={`${s.panel} ${s.tree} ${tree.workspace}`} data-outline={outline} aria-label={T('Cây tri thức', 'Knowledge tree')} data-testid="cosmos-tree">
      <header className={s.treeHead}>
        <div className={s.treeTitle}>
          <h2>{T('Cây tri thức', 'Knowledge tree')}</h2>
          <span className={s.treeCount}>{T(`${index.root.count} ngôi sao`, `${index.root.count} stars`)}</span>
          <span className={s.infoTip} tabIndex={0} role="note" aria-label={T('Cây sắp xếp các ngôi sao theo vị trí trong vũ trụ (thiên hà, chòm sao, hệ sao). Một hàng cha không phải là quan hệ ngữ nghĩa; quan hệ đã kiểm chứng nằm trong ô Soi của từng ngôi sao.', 'The tree groups stars by where they sit in the universe (galaxy, constellation, system). A parent row is not a semantic relation; verified relations are in each star’s inspector.')}>
            <Info size={14} aria-hidden /><span className={s.tipText} aria-hidden>{T('Nhóm theo vị trí trong vũ trụ, không phải quan hệ ngữ nghĩa. Quan hệ đã kiểm chứng nằm trong ô Soi.', 'Grouped by place in the universe, not by meaning. Verified relations are in the inspector.')}</span>
          </span>
        </div>
        <div className={s.treeTools}>
          <button className={s.btn} aria-expanded={outline} aria-controls="cosmos-tree-outline" onClick={() => setOutline(v => !v)} title={T('Danh mục phân cấp', 'Hierarchy outline')} aria-label={T('Danh mục phân cấp', 'Hierarchy outline')}>{outline ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>
          <label className={s.treeSearch}><Search size={14} aria-hidden />
            <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }} placeholder={T('Lọc cây…', 'Filter the tree…')} aria-label={T('Lọc cây tri thức', 'Filter the knowledge tree')} /></label>
          <button className={s.btn} onClick={() => setOpen(new Set(index.byId.keys()))} title={T('Mở hết', 'Expand all')} aria-label={T('Mở hết', 'Expand all')}><ChevronsUpDown size={15} /></button>
          <button className={s.btn} onClick={() => setOpen(new Set(['u']))} title={T('Thu gọn', 'Collapse all')} aria-label={T('Thu gọn', 'Collapse all')}><ChevronsDownUp size={15} /></button>
        </div>
        {notice && <p className={s.treeNotice} role="status">{notice} {onRetry && <button className={s.btn} onClick={onRetry}>{T('Mở lại cảnh 3D', 'Reopen 3D')}</button>}</p>}
      </header>
      {matches && matches.hit.size === 0 && <p className={s.treeEmpty}>{T('Không có ngôi sao nào khớp.', 'No star matches.')}</p>}
      <div className={tree.content}>
      {outline && <div id="cosmos-tree-outline" ref={box} className={`${s.treeBody} ${tree.outline}`} role="tree" aria-label={T('Cây tri thức', 'Knowledge tree')} onKeyDown={onKey} onScroll={e => setScroll((e.target as HTMLElement).scrollTop)}>
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {/* the windowed rows, plus the roving-focus row when it is scrolled away (the tree always has one tab stop) */}
          {[...rows.slice(first, last).map((t, k) => [t, first + k] as const), ...(cursorIndex < first || cursorIndex >= last ? [[rows[cursorIndex], cursorIndex] as const] : [])].filter(([t]) => !!t).map(([t, i]) => {
            const n = t.node >= 0 ? g.nodes[t.node] : null;
            const isOpen = matches ? matches.path.has(t.id) || t.id === 'u' : open.has(t.id);
            const m = n && t.kind === 'star' && (n.kind === 'word' || n.kind === 'grammar') ? memoryOf(n, now) : null;
            const due = n && t.kind === 'star' && n.kind === 'word' && n.dueAt > 0 && n.dueAt <= now && n.stage !== 'saved';
            const siblings = index.kids.get(t.parent) ?? [];
            return (
              <div key={t.id} data-row={t.id} role="treeitem" aria-level={t.depth + 1} aria-expanded={t.kind === 'star' ? undefined : isOpen}
                aria-selected={t.kind === 'star' ? t.node === selected : undefined} aria-setsize={siblings.length || 1} aria-posinset={siblings.indexOf(t) + 1 || 1}
                tabIndex={t.id === (rows[cursorIndex]?.id ?? 'u') ? 0 : -1} className={s.treeRow} data-kind={t.kind} data-enter={t.parent && t.parent === entering ? '1' : undefined}
                data-selected={t.kind === 'star' && t.node === selected ? '1' : undefined} data-met={n && isMet(n) ? '1' : undefined}
                style={{ top: i * ROW, ['--d' as string]: t.depth, ['--tone' as string]: t.color }}
                onClick={() => { setCursor(t.id); activate(t); }} onFocus={() => setCursor(t.id)}>
                <span className={s.treeGuides} aria-hidden />
                {t.kind === 'star'
                  ? <span className={s.treeDot} aria-hidden style={{ background: m ? MEMORY_TONE[m.state] : t.color }} data-cross={m?.cross ? '1' : undefined} />
                  : <span className={s.treeChevron} data-open={isOpen ? '1' : '0'} aria-hidden><ChevronRight size={15} /></span>}
                <span className={s.treeIcon} aria-hidden>{iconOf(t, n)}</span>
                <span className={s.treeText}>
                  <span className={s.treeLabel}>{mark(t.label, q)}</span>
                  {t.sub && <span className={s.treeSub}>{mark(t.sub, q)}</span>}
                </span>
                {t.kind !== 'star' && <span className={s.treeBadge} title={T(`${t.count} ngôi sao đã học${t.met ? ` · ${t.met} từ đã gặp` : ''} · ${sizeOf(t)} mục con`, `${t.count} studied stars${t.met ? ` · ${t.met} met words` : ''} · ${sizeOf(t)} children`)}>{t.count}{t.met ? <small className={s.treeMet}>+{t.met}</small> : null}</span>}
                {m && <span className={s.treeMem} title={MEMORY_LABEL[m.state][vi ? 0 : 1]}>{MEMORY_LABEL[m.state][vi ? 0 : 1]}</span>}
                {due && <span className={s.treeDue}>{T('Đến hạn ôn', 'Due')}</span>}
                <span className={s.treeActions}>
                  {t.kind !== 'universe' && <button className={s.treeAct} tabIndex={-1} title={T('Xem trong 3D', 'Show in 3D')} aria-label={T(`Xem ${t.label} trong 3D`, `Show ${t.label} in 3D`)}
                    onClick={e => { e.stopPropagation(); onShow3D(t.focus); }}><Box size={14} /></button>}
                </span>
              </div>
            );
          })}
        </div>
      </div>}
      <LivingKnowledgeTree index={index} rows={rows} selected={selectedRow} vi={vi} graph={g} onActivate={activate} onShow3D={onShow3D} />
      </div>
    </section>
  );
}

function iconOf(t: TNode, n: CosmosNode | null) {
  if (t.kind === 'universe' || t.kind === 'galaxy') return <Orbit size={15} />;
  if (t.kind === 'constellation') return <Waypoints size={15} />;
  if (t.kind === 'system') return <Atom size={15} />;
  if (n?.kind === 'grammar') return <BookOpen size={14} />;
  if (n?.kind === 'source') return <FileText size={14} />;
  return null;
}
function sourceKind(n: CosmosNode, vi: boolean) {
  return ({ MY_BOOKS: vi ? 'sách của tôi' : 'my book', READING: vi ? 'bài đọc' : 'reading', LISTENING: vi ? 'bài nghe' : 'listening', WRITING: vi ? 'bài viết' : 'writing', SPEAKING: vi ? 'lời nói' : 'speaking' } as Record<string, string>)[n.sub] ?? n.sub;
}
function mark(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}
