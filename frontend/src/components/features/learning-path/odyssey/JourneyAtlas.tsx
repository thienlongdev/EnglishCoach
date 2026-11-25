'use client';
/* Echo Odyssey — Journey Atlas: the learning path as a large, centred map above the planet.
   Everything shown comes from the owner-scoped Odyssey projection (stations, statuses, gates, prerequisites,
   recommendations, today's tasks): the atlas positions it, it never decides a state, invents a link or opens a gate.
   Basic study is open for every topic; a challenge check can establish a topic directly; the advanced branch opens
   only when the server says its prerequisites are current (the same rules as the server's launch). */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, BookOpen, Check, ChevronLeft, Compass, Flag, Globe2, Layers, List, LockKeyhole, Map as MapIcon, Maximize2, Minus, Navigation, Play, Plus, RotateCcw, Search, ShieldCheck, X } from 'lucide-react';
import type { Catalog } from '@/types/grammar';
import type { LaunchMode, RegionDetail, Station, World } from '@/lib/odyssey/types';
import { layoutRegion, relations, ancestors, slugOf, NODE_W, NODE_H, type AtlasLayout } from '@/lib/odyssey/atlasLayout';
import { passed, ready } from '@/lib/odyssey/progression';
import { goalLabel, levelLabel, reasonLabel, skillLabel } from '@/lib/learning-path/model';
import a from './atlas.module.css';

export type AtlasTab = 'map' | 'goal' | 'journal';
export type NodeState = 'done' | 'review' | 'next' | 'open' | 'prereq' | 'task' | 'taskdone' | 'explore';
type W = { vi: string; en: string };

export function nodeState(s: Station, nextId?: string | null): NodeState {
  if (s.kind === 'WORKFLOW') return 'explore';
  if (s.kind !== 'GRAMMAR') return s.status === 'DONE' ? 'taskdone' : s.id === nextId ? 'next' : 'task';
  if (passed(s)) return 'done';
  if (s.status === 'REVIEW_DUE' || s.status === 'REMEDIATION') return 'review';
  if (s.id === nextId) return 'next';
  return ready(s) ? 'open' : 'prereq';
}
const STATE_TEXT: Record<NodeState, W> = {
  done: { vi: 'Đã vượt kiểm tra', en: 'Check passed' }, review: { vi: 'Cần ôn hoặc luyện lại', en: 'Review or practice needed' },
  next: { vi: 'Gợi ý tiếp theo', en: 'Suggested next' }, open: { vi: 'Sẵn sàng học', en: 'Ready to learn' },
  prereq: { vi: 'Cần kiến thức nền', en: 'Needs prerequisites' }, task: { vi: 'Nhiệm vụ hôm nay', en: 'Today’s quest' },
  taskdone: { vi: 'Đã hoàn thành hôm nay', en: 'Completed today' }, explore: { vi: 'Khám phá tự do', en: 'Free exploration' },
};

interface Props {
  world: World; graph?: RegionDetail[]; graphLoading: boolean; graphError: boolean; onReloadGraph: () => void;
  catalog?: Catalog; initialRegion: string | null; selected: string | null; next: Station | null; current: string | null;
  vi: boolean; busy: boolean; tab: AtlasTab; onTab: (t: AtlasTab) => void; goal: ReactNode; journal: ReactNode;
  onClose: () => void; onSelect: (station: Station) => void; onLaunch: (station: Station, mode: LaunchMode) => void; onShowOnPlanet: (regionId: string, station: Station | null) => void;
  stationTitle: (s: Station) => string; statusText: (status: string) => string;
}

const ICONS: Record<NodeState, typeof Check> = { done: Check, review: RotateCcw, next: Flag, open: BookOpen, prereq: LockKeyhole, task: Compass, taskdone: Check, explore: Navigation };

export default function JourneyAtlas(p: Props) {
  const { world, graph, vi, catalog, next } = p;
  const t = (w: W) => vi ? w.vi : w.en;
  const regions = world.regions.map(r => r.region);
  const [scope, setScope] = useState<string>(() => p.initialRegion ?? next?.regionId ?? 'planet');
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [query, setQuery] = useState('');
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [sheet, setSheet] = useState(false);
  const dialog = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null), opener = useRef<Element | null>(null);
  const pendingFocus = useRef<string | null>(p.selected);
  const domainOrder = useMemo(() => catalog?.domains.map(d => d.id) ?? [], [catalog]);
  const domainTitle = useCallback((id: string) => { const d = catalog?.domains.find(v => v.id === id); return d ? t(d.title) : id === 'today' ? t({ vi: 'Nhiệm vụ hôm nay', en: 'Today’s quests' }) : id === 'explore' ? t({ vi: 'Khám phá tự do', en: 'Free exploration' }) : t({ vi: 'Nhánh kiến thức', en: 'Knowledge branch' }); }, [catalog, vi]); // eslint-disable-line react-hooks/exhaustive-deps

  // All stations once (the review region repeats topics that are due elsewhere: keep each station once).
  const all = useMemo(() => { const seen = new Map<string, Station>(); for (const d of graph ?? []) for (const s of d.stations) if (!seen.has(s.id) || d.region.id !== 'review') seen.set(s.id, s); return [...seen.values()]; }, [graph]);
  const detail = useMemo(() => graph?.find(d => d.region.id === scope) ?? null, [graph, scope]);
  const stations = useMemo(() => detail?.stations ?? [], [detail]);
  const selected = all.find(s => s.id === p.selected) ?? stations.find(s => s.id === p.selected) ?? null;
  const layout: AtlasLayout | null = useMemo(() => scope === 'planet' || !stations.length ? null : layoutRegion(stations, Math.max(NODE_W + 44, size.w / scale), domainOrder), [scope, stations, size.w, scale, domainOrder]);
  const highlight = useMemo(() => {
    if (!selected) return null;
    const set = ancestors(selected.id, all); set.add(selected.id);
    for (const s of relations(selected.id, all).after) set.add(s.id);
    return set;
  }, [selected, all]);
  const matches = useMemo(() => {
    const q = query.trim().toLocaleLowerCase(); if (!q) return [];
    return all.filter(s => s.kind !== 'WORKFLOW' && (p.stationTitle(s).toLocaleLowerCase().includes(q) || s.title.vi.toLocaleLowerCase().includes(q) || s.title.en.toLocaleLowerCase().includes(q))).slice(0, 8);
  }, [query, all, p]);

  // Dialog: focus inside, Escape closes, Tab stays inside, focus returns to the opener.
  useEffect(() => {
    opener.current = document.activeElement;
    requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
    return () => { (opener.current as HTMLElement | null)?.focus?.(); };
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (query) setQuery(''); else if (sheet && selected && matchMedia('(max-width: 1279px)').matches) setSheet(false); else p.onClose(); return; }
    if (e.key !== 'Tab' || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, [tabindex="0"]')].filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  // The graph canvas follows its own size (rows wrap to it: no horizontal scrollbar at 100 %); measured before paint.
  useLayoutEffect(() => {
    const el = canvas.current; if (!el) return;
    // Measure at once (a ResizeObserver only reports when the page renders, e.g. not in a background tab), then follow.
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el); return () => ro.disconnect();
  }, [scope, view, p.tab]);
  const focusNode = useCallback((id: string, smooth = true) => {
    const el = canvas.current, n = layout?.nodes.find(v => v.id === id); if (!el || !n) return false;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: Math.max(0, n.y * scale - el.clientHeight / 2 + NODE_H * scale / 2), left: Math.max(0, n.x * scale - el.clientWidth / 2 + NODE_W * scale / 2), behavior: smooth && !reduce ? 'smooth' : 'auto' });
    return true;
  }, [layout, scale]);
  useEffect(() => { const id = pendingFocus.current; if (id && layout && focusNode(id, false)) pendingFocus.current = null; }, [layout, focusNode]);
  const choose = (s: Station) => { p.onSelect(s); setSheet(true); };
  const goTo = (s: Station) => { setQuery(''); if (s.regionId !== scope) { pendingFocus.current = s.id; setScope(s.regionId); } else focusNode(s.id); p.onSelect(s); setSheet(true); };
  const fit = () => {
    if (!layout) return;
    for (const s of [1, 0.9, 0.8, 0.7, 0.62, 0.55]) { const l = layoutRegion(stations, Math.max(NODE_W + 44, size.w / s), domainOrder); if (l.height * s <= size.h || s === 0.55) { setScale(s); canvas.current?.scrollTo({ top: 0, left: 0 }); return; } }
  };
  const zoom = (k: number) => setScale(v => Math.round(Math.min(1.4, Math.max(0.55, v * k)) * 100) / 100);
  // Ctrl / pinch wheel zooms; plain wheel and trackpads scroll natively; a mouse drag on the background pans.
  useEffect(() => {
    const el = canvas.current; if (!el) return;
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1); };
    let drag: { x: number; y: number; l: number; t: number } | null = null;
    const down = (e: PointerEvent) => { if (e.pointerType !== 'mouse' || e.button !== 0 || (e.target as HTMLElement).closest('button, a, input')) return; drag = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop }; el.setPointerCapture(e.pointerId); el.dataset.panning = 'true'; };
    const move = (e: PointerEvent) => { if (!drag) return; el.scrollLeft = drag.l - (e.clientX - drag.x); el.scrollTop = drag.t - (e.clientY - drag.y); };
    const up = () => { drag = null; delete el.dataset.panning; };
    el.addEventListener('wheel', wheel, { passive: false }); el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    return () => { el.removeEventListener('wheel', wheel); el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
  }, [scope, view, p.tab]);

  const plan = world.today.plan;
  const totals = useMemo(() => {
    const g = all.filter(s => s.kind === 'GRAMMAR');
    return { passed: g.filter(passed).length, review: g.filter(s => s.status === 'REVIEW_DUE' || s.status === 'REMEDIATION').length, open: g.filter(s => !passed(s) && ready(s)).length, prereq: g.filter(s => !passed(s) && !ready(s)).length, total: g.length };
  }, [all]);
  const whyNext = (s: Station) => {
    if (s.task) return reasonLabel(s.task.reason, vi ? 'vi' : 'en') ?? t({ vi: 'Nhiệm vụ trong kế hoạch hôm nay', en: 'A quest in today’s plan' });
    if (s.status === 'REVIEW_DUE') return t({ vi: 'Đến hạn ôn để giữ kết quả đã đạt', en: 'Due for review to keep what you achieved' });
    if (!plan || plan.levelBasis === 'PROVISIONAL') return t({ vi: 'Chưa có bằng chứng trình độ: bắt đầu từ chủ đề nền tảng đã đủ kiến thức nền', en: 'No level evidence yet: start with a foundation topic whose prerequisites are met' });
    return vi ? `Cùng trình độ ${plan.level} của bạn, kiến thức nền cùng cấp đã đủ` : `At your ${plan.level} level, with same-level prerequisites met`;
  };
  const regionName = (id: string) => { const r = regions.find(v => v.id === id); return r ? t(r.name) : id; };

  return <div className={a.scrim} onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
    <div ref={dialog} className={a.atlas} role="dialog" aria-modal="true" aria-labelledby="odyssey-atlas-title" onKeyDown={onKey} data-guide="odyssey-journey-atlas">
      <header className={a.head}>
        <div className={a.title}><span aria-hidden="true"><MapIcon size={20} /></span><div><h2 id="odyssey-atlas-title">{t({ vi: 'Bản đồ hành trình', en: 'Journey atlas' })}</h2><small>{t({ vi: 'Lộ trình thật của bạn, từ kết quả đã lưu', en: 'Your real path, from saved results' })}</small></div></div>
        <nav className={a.tabs} aria-label={t({ vi: 'Phần của bản đồ', en: 'Atlas sections' })}>
          {(['map', 'goal', 'journal'] as AtlasTab[]).map(k => <button key={k} aria-pressed={p.tab === k} onClick={() => p.onTab(k)}>{k === 'map' ? <Layers size={16} /> : k === 'goal' ? <Flag size={16} /> : <BookOpen size={16} />}{t(k === 'map' ? { vi: 'Lộ trình', en: 'Path' } : k === 'goal' ? { vi: 'Mục tiêu', en: 'Goal' } : { vi: 'Nhật ký', en: 'Journal' })}</button>)}
        </nav>
        <button className={a.close} onClick={p.onClose} aria-label={t({ vi: 'Đóng bản đồ hành trình', en: 'Close the journey atlas' })} data-autofocus><X size={20} /></button>
      </header>
      {p.tab === 'goal' ? <div className={a.tabBody}>{p.goal}</div> : p.tab === 'journal' ? <div className={a.tabBody}>{p.journal}</div> : <div className={a.body} data-sheet={sheet && !!selected}>
        <aside className={a.summary} aria-label={t({ vi: 'Tóm tắt hành trình', en: 'Journey summary' })}>
          <section className={a.goalCard}>
            <small>{t({ vi: 'Mục tiêu', en: 'Goal' })}</small>
            <strong>{plan ? goalLabel(plan.goal, plan.target, vi ? 'vi' : 'en') : t({ vi: 'Chưa đặt mục tiêu', en: 'No goal yet' })}</strong>
            {plan && <span>{levelLabel(plan.level, plan.levelBasis, vi ? 'vi' : 'en')}</span>}
          </section>
          {next && <button className={a.nextCard} onClick={() => goTo(next)}>
            <small>{t({ vi: 'Điểm đến tiếp theo', en: 'Next destination' })}</small>
            <strong>{p.stationTitle(next)}</strong>
            <span>{regionName(next.regionId)}{next.level ? ` · ${next.level}` : ''}</span>
            <em>{whyNext(next)}</em>
            <ArrowRight size={16} aria-hidden="true" />
          </button>}
          <section className={a.counts} aria-label={t({ vi: 'Tiến độ ngữ pháp trên hành tinh', en: 'Grammar progress across the planet' })}>
            <div data-k="done"><b>{totals.passed}</b><span>{t({ vi: 'đã vượt kiểm tra', en: 'checks passed' })}</span></div>
            <div data-k="review"><b>{totals.review}</b><span>{t({ vi: 'cần ôn / luyện lại', en: 'to review / practise' })}</span></div>
            <div data-k="open"><b>{totals.open}</b><span>{t({ vi: 'sẵn sàng học', en: 'ready to learn' })}</span></div>
            <div data-k="prereq"><b>{totals.prereq}</b><span>{t({ vi: 'cần kiến thức nền', en: 'need prerequisites' })}</span></div>
          </section>
          {world.today.total > 0 && <p className={a.today}><Compass size={15} />{vi ? `Hôm nay: ${world.today.done}/${world.today.total} nhiệm vụ` : `Today: ${world.today.done}/${world.today.total} quests`}</p>}
          <ul className={a.legend} aria-label={t({ vi: 'Chú giải', en: 'Legend' })}>
            {(['next', 'open', 'prereq', 'review', 'done'] as NodeState[]).map(k => <li key={k} data-state={k}><i aria-hidden="true" />{t(STATE_TEXT[k])}</li>)}
          </ul>
          <p className={a.note}>{t({ vi: 'Học bài luôn mở. Bài thử thách có thể xác nhận một chủ đề trực tiếp. Nhánh nâng cao mở khi kiến thức nền được máy chủ xác nhận còn hiệu lực.', en: 'Studying is always open. A challenge check can establish a topic directly. The advanced branch opens when the server confirms its prerequisites are current.' })}</p>
        </aside>
        <section className={a.main} aria-label={t({ vi: 'Lộ trình theo vùng', en: 'Path by region' })}>
          <div className={a.toolbar}>
            <label className={a.regionPick}><Globe2 size={16} /><span className={a.srOnly}>{t({ vi: 'Vùng', en: 'Region' })}</span>
              <select value={scope} onChange={e => { setScope(e.target.value); setScale(1); canvas.current?.scrollTo({ top: 0, left: 0 }); }}>
                <option value="planet">{t({ vi: 'Toàn hành tinh', en: 'Whole planet' })}</option>
                {world.regions.map(({ region: r, stations: n }) => <option key={r.id} value={r.id}>{t(r.name)} · {n} {t({ vi: 'trạm', en: 'stations' })}</option>)}
              </select></label>
            <label className={a.search}><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t({ vi: 'Tìm chủ đề trên mọi vùng…', en: 'Find a topic in any region…' })} aria-label={t({ vi: 'Tìm chủ đề', en: 'Find a topic' })} aria-controls="odyssey-atlas-results" />
              {matches.length > 0 && <ul id="odyssey-atlas-results" className={a.results} role="listbox">{matches.map(s => <li key={s.id} role="option" aria-selected="false"><button onClick={() => goTo(s)}><b>{p.stationTitle(s)}</b><span>{regionName(s.regionId)}{s.level ? ` · ${s.level}` : ''} · {t(STATE_TEXT[nodeState(s, next?.id)])}</span></button></li>)}</ul>}
            </label>
            {scope !== 'planet' && <div className={a.viewSwitch} role="group" aria-label={t({ vi: 'Cách xem', en: 'View' })}>
              <button aria-pressed={view === 'graph'} onClick={() => setView('graph')}><Layers size={15} />{t({ vi: 'Sơ đồ', en: 'Map' })}</button>
              <button aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={15} />{t({ vi: 'Danh sách', en: 'List' })}</button>
            </div>}
            {scope !== 'planet' && view === 'graph' && <div className={a.zoom} role="group" aria-label={t({ vi: 'Thu phóng sơ đồ', en: 'Zoom the map' })}>
              <button onClick={() => zoom(1 / 1.15)} aria-label={t({ vi: 'Thu nhỏ', en: 'Zoom out' })}><Minus size={15} /></button>
              <span aria-live="polite">{Math.round(scale * 100)}%</span>
              <button onClick={() => zoom(1.15)} aria-label={t({ vi: 'Phóng to', en: 'Zoom in' })}><Plus size={15} /></button>
              <button onClick={fit} aria-label={t({ vi: 'Vừa khung', en: 'Fit to view' })}><Maximize2 size={15} /></button>
            </div>}
          </div>
          {p.graphError && <div className={a.state}><p>{t({ vi: 'Chưa tải được lộ trình giữa các vùng.', en: 'The path between regions could not load.' })}</p><button onClick={p.onReloadGraph}>{t({ vi: 'Tải lại', en: 'Reload' })}</button></div>}
          {!graph && !p.graphError && <div className={a.state} role="status"><p>{t({ vi: 'Đang dựng bản đồ hành trình…', en: 'Drawing the journey atlas…' })}</p></div>}
          {graph && scope === 'planet' && <div className={a.planet} ref={canvas}>
            <p className={a.planetIntro}>{t({ vi: 'Mỗi vùng là một nhóm kiến thức. Chọn một vùng để xem các nhánh, kiến thức nền và trạm học của nó.', en: 'Each region is a group of knowledge. Choose one to see its branches, prerequisites and stations.' })}</p>
            <div className={a.regionGrid}>
              {world.regions.map(({ region: r, stations: n, passed: done, reviewDue }) => {
                const g = graph.find(d => d.region.id === r.id)?.stations.filter(s => s.kind === 'GRAMMAR') ?? [];
                const blocked = g.filter(s => !passed(s) && !ready(s)).length, here = r.id === p.current, isNext = r.id === next?.regionId;
                return <button key={r.id} className={a.regionCard} data-next={isNext || undefined} data-here={here || undefined} onClick={() => { setScope(r.id); setScale(1); }}>
                  <span className={a.regionTop}><strong>{t(r.name)}</strong>{isNext ? <em>{t({ vi: 'Tiếp theo', en: 'Up next' })}</em> : here ? <em data-here>{t({ vi: 'Bạn ở đây', en: 'You are here' })}</em> : null}</span>
                  <span className={a.regionPurpose}>{t(r.purpose)}</span>
                  <span className={a.regionSkill}>{r.skill === 'GRAMMAR' ? t({ vi: 'Ngữ pháp', en: 'Grammar' }) : skillLabel(r.skill, vi ? 'vi' : 'en')} · {n} {t({ vi: 'trạm', en: 'stations' })}</span>
                  {g.length > 0 && <span className={a.bar} aria-label={vi ? `${done}/${g.length} chủ đề đã vượt kiểm tra` : `${done}/${g.length} topics passed`}><i style={{ width: `${Math.round(done / g.length * 100)}%` }} /></span>}
                  <span className={a.regionFacts}>{g.length > 0 && <span>{done}/{g.length} {t({ vi: 'đã vượt', en: 'passed' })}</span>}{reviewDue > 0 && <span data-k="review">{reviewDue} {t({ vi: 'đến hạn ôn', en: 'due' })}</span>}{blocked > 0 && <span data-k="prereq">{blocked} {t({ vi: 'cần nền', en: 'need basics' })}</span>}</span>
                </button>;
              })}
            </div>
          </div>}
          {graph && scope !== 'planet' && view === 'graph' && layout && <div className={a.canvas} ref={canvas} tabIndex={-1} data-scale={scale}>
            <div className={a.space} style={{ width: layout.width * scale, height: layout.height * scale }}>
              <div className={a.plane} style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }} data-compact={scale < 0.8 || undefined}>
                {layout.lanes.map(l => <div key={l.id} className={a.lane} data-kind={l.kind} style={{ top: l.y, height: l.h }}>
                  <h3>{domainTitle(l.id)}<small>{l.kind === 'grammar' ? `${l.stations.filter(passed).length}/${l.stations.length} ${t({ vi: 'đã vượt kiểm tra', en: 'passed' })}` : `${l.stations.length}`}</small></h3>
                </div>)}
                <svg className={a.links} width={layout.width} height={layout.height} aria-hidden="true">
                  {layout.edges.map(e => { const from = all.find(s => s.id === e.from) ?? stations.find(s => s.id === e.from); const lit = highlight ? highlight.has(e.from) && highlight.has(e.to) : false;
                    return <path key={`${e.from}>${e.to}`} d={e.path} data-met={from && passed(from) ? 'true' : 'false'} data-lit={lit || undefined} data-dim={highlight && !lit ? 'true' : undefined} />; })}
                </svg>
                {layout.nodes.map(n => { const st = nodeState(n.station, next?.id), Icon = ICONS[st], dim = highlight && !highlight.has(n.id);
                  return <button key={n.id} className={a.node} data-state={st} data-selected={n.id === p.selected || undefined} data-dim={dim || undefined} data-lit={highlight?.has(n.id) && n.id !== p.selected ? 'true' : undefined}
                    style={{ left: n.x, top: n.y, width: n.w, height: n.h }} onClick={() => choose(n.station)} aria-pressed={n.id === p.selected} data-station={n.id}
                    aria-label={`${p.stationTitle(n.station)} — ${t(STATE_TEXT[st])}${n.station.level ? `, ${n.station.level}` : ''}`}>
                    <i aria-hidden="true"><Icon size={16} /></i>
                    <span className={a.nodeTitle}>{p.stationTitle(n.station)}</span>
                    <span className={a.nodeMeta}>{n.station.level && <b>{n.station.level}</b>}<span>{n.station.kind === 'GRAMMAR' ? p.statusText(n.station.status) : t(STATE_TEXT[st])}</span>{n.outside.length > 0 && <em title={t({ vi: 'Kiến thức nền ở nhánh hoặc vùng khác', en: 'Prerequisites in another branch or region' })}>+{n.outside.length} {t({ vi: 'nền', en: 'basics' })}</em>}</span>
                  </button>; })}
              </div>
            </div>
          </div>}
          {graph && scope !== 'planet' && view === 'list' && <div className={a.list} ref={canvas}>
            {layout?.lanes.map(l => <section key={l.id}><h3>{domainTitle(l.id)}</h3><ol>
              {layout.nodes.filter(n => n.lane === l.id).map(n => { const st = nodeState(n.station, next?.id), Icon = ICONS[st];
                return <li key={n.id}><button data-state={st} aria-pressed={n.id === p.selected} onClick={() => choose(n.station)}><i aria-hidden="true"><Icon size={15} /></i>
                  <span><b>{p.stationTitle(n.station)}</b><small>{n.station.kind === 'GRAMMAR' ? `${t({ vi: 'Bước', en: 'Step' })} ${n.depth + 1} · ` : ''}{n.station.level ? `${n.station.level} · ` : ''}{t(STATE_TEXT[st])}</small></span></button></li>; })}
            </ol></section>)}
          </div>}
        </section>
        <aside className={a.detail} aria-label={t({ vi: 'Chi tiết trạm học', en: 'Station details' })} data-open={!!selected || undefined}>
          {selected ? <StationDetail station={selected} all={all} vi={vi} busy={p.busy} next={next} catalog={catalog} regionName={regionName} title={p.stationTitle} status={p.statusText} whyNext={whyNext}
            onPick={goTo} onLaunch={p.onLaunch} onPlanet={() => p.onShowOnPlanet(selected.regionId, selected)} onClose={() => setSheet(false)} />
            : <div className={a.empty}><Compass size={26} /><p>{t({ vi: 'Chọn một trạm để xem kiến thức nền, những gì nó mở ra và cách bắt đầu.', en: 'Choose a station to see its prerequisites, what it opens and how to start.' })}</p>
              {scope !== 'planet' && <button onClick={() => p.onShowOnPlanet(scope, null)}><Globe2 size={15} />{t({ vi: 'Xem vùng này trên hành tinh', en: 'See this region on the planet' })}</button>}</div>}
        </aside>
      </div>}
    </div>
  </div>;
}

function StationDetail({ station: s, all, vi, busy, next, catalog, regionName, title, status, whyNext, onPick, onLaunch, onPlanet, onClose }: {
  station: Station; all: Station[]; vi: boolean; busy: boolean; next: Station | null; catalog?: Catalog; regionName: (id: string) => string; title: (s: Station) => string; status: (v: string) => string;
  whyNext: (s: Station) => string; onPick: (s: Station) => void; onLaunch: (s: Station, mode: LaunchMode) => void; onPlanet: () => void; onClose: () => void;
}) {
  const t = (w: W) => vi ? w.vi : w.en;
  const st = nodeState(s, next?.id);
  const { before, after } = relations(s.id, all);
  const domain = catalog?.domains.find(d => d.id === s.domain);
  const missing = new Set(s.gate.missing);
  return <div className={a.detailBody} data-guide="odyssey-quest">
    <button className={a.sheetClose} onClick={onClose} aria-label={t({ vi: 'Đóng chi tiết', en: 'Close details' })}><ChevronLeft size={18} /></button>
    <span className={a.detailState} data-state={st}>{t(STATE_TEXT[st])}</span>
    <h3>{title(s)}</h3>
    <p className={a.detailMeta}>{regionName(s.regionId)}{domain ? ` · ${t(domain.title)}` : ''}{s.level ? ` · ${s.level}` : ''}{s.kind === 'GRAMMAR' ? ` · ${status(s.status)}` : ''}</p>
    {(st === 'next' || s.id === next?.id) && <p className={a.why}><Flag size={14} />{whyNext(s)}</p>}
    {s.task && <p className={a.why}><Compass size={14} />{s.task.minutes} {t({ vi: 'phút', en: 'min' })} · {s.task.progress}/{s.task.goalCount}</p>}
    {s.status === 'REMEDIATION' && <p className={a.remediation}>{t({ vi: 'Kiểm tra vừa rồi chưa đạt. Ôn kiến thức nền, luyện lại rồi thử bài kiểm tra mới; thành tích trước đây được giữ.', en: 'This check needs more practice. Review the prerequisites, practise and retry; previous achievements are retained.' })}</p>}
    {s.kind === 'GRAMMAR' && <>
      <h4>{t({ vi: 'Kiến thức nền', en: 'Prerequisites' })}</h4>
      {before.length ? <ul className={a.rel}>{before.map(b => <li key={b.id}><button onClick={() => onPick(b)} data-state={nodeState(b, next?.id)}><i aria-hidden="true">{passed(b) ? <Check size={13} /> : missing.has(slugOf(b.id)) ? <LockKeyhole size={13} /> : <BookOpen size={13} />}</i><span>{title(b)}<small>{b.regionId !== s.regionId ? `${regionName(b.regionId)} · ` : ''}{passed(b) ? t({ vi: 'đã xác nhận', en: 'confirmed' }) : missing.has(slugOf(b.id)) ? t({ vi: 'chưa xác nhận còn hiệu lực', en: 'not confirmed as current' }) : status(b.status)}</small></span></button></li>)}</ul>
        : <p className={a.muted}>{t({ vi: 'Không cần kiến thức nền trước.', en: 'No prerequisite needed.' })}</p>}
      {after.length > 0 && <><h4>{t({ vi: 'Mở đường cho', en: 'Leads to' })}</h4><ul className={a.rel}>{after.slice(0, 8).map(b => <li key={b.id}><button onClick={() => onPick(b)} data-state={nodeState(b, next?.id)}><i aria-hidden="true"><ArrowRight size={13} /></i><span>{title(b)}<small>{b.regionId !== s.regionId ? `${regionName(b.regionId)} · ` : ''}{b.level ?? ''}</small></span></button></li>)}{after.length > 8 && <li className={a.muted}>+{after.length - 8}</li>}</ul></>}
      <ol className={a.stages}><li>{t({ vi: 'Khám phá khái niệm', en: 'Learn the concept' })}</li><li>{t({ vi: 'Luyện tập', en: 'Practise' })}</li><li data-done={passed(s) || undefined}>{t({ vi: 'Kiểm tra chủ đề', en: 'Topic checkpoint' })}</li><li>{t({ vi: 'Ôn tập và nhánh tiếp theo', en: 'Review and next branches' })}</li></ol>
    </>}
    {s.kind === 'WORKFLOW' && <p className={a.muted}>{t({ vi: 'Chọn hoạt động trong mô-đun. Việc mở không gian này không tạo thành tích hoàn thành.', en: 'Choose an activity in the module. Opening this space does not earn completion credit.' })}</p>}
    <div className={a.actions}>
      <button className={a.primary} disabled={busy} onClick={() => onLaunch(s, 'LEARN')}><Play size={16} />{t({ vi: 'Bắt đầu học', en: 'Start learning' })}<ArrowRight size={16} /></button>
      {s.checkAvailable && <button disabled={busy} onClick={() => onLaunch(s, s.status === 'REVIEW_DUE' ? 'REVIEW' : 'CHECK')}><ShieldCheck size={15} />{s.status === 'REVIEW_DUE' ? t({ vi: 'Kiểm tra ôn tập', en: 'Review check' }) : t({ vi: 'Thử thách chủ đề', en: 'Challenge check' })}</button>}
      {s.checkAvailable && <button disabled={busy || s.gate.state !== 'READY'} onClick={() => onLaunch(s, 'ADVANCE')} title={s.gate.state !== 'READY' ? t({ vi: 'Mở khi kiến thức nền được xác nhận còn hiệu lực', en: 'Opens when the prerequisites are confirmed as current' }) : undefined}><Layers size={15} />{t({ vi: 'Nhánh nâng cao', en: 'Advanced branch' })}</button>}
      {s.checkAvailable && s.gate.state !== 'READY' && <p className={a.muted}><LockKeyhole size={13} />{t({ vi: 'Nhánh nâng cao mở khi các kiến thức nền có khóa ở trên được xác nhận còn hiệu lực (hoặc khi chủ đề này vượt kiểm tra).', en: 'The advanced branch opens when the locked prerequisites above are confirmed as current (or when this topic passes its check).' })}</p>}
      <button className={a.ghost} onClick={onPlanet}><Globe2 size={15} />{t({ vi: 'Xem trên hành tinh', en: 'See on the planet' })}</button>
    </div>
  </div>;
}
