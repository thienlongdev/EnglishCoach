'use client';
/**
 * Vũ trụ tri thức — Echo Neural Cosmos. The learner's verified knowledge graph as an explorable universe:
 * Universe → Galaxy → Constellation → Star system → Knowledge star. Every star and every drawn relation is real data;
 * decoration is visibly decoration. Opening, flying, hovering and selecting make zero AI calls and zero requests beyond the
 * one evidence read; actions lead to the real modules.
 */
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { X, ArrowLeft, ArrowUp, Eye, EyeOff, Undo2, Maximize2, Minimize2, SlidersHorizontal, History, Swords, Compass, RotateCcw, Play, Pause, Volume2, BookOpen, Info, MessageCircleQuestion, Box, ListTree, CalendarClock } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { useLanguage } from '@/context/LanguageContext';
import { useWorldDisplay } from '@/lib/ui/worldDisplay';
import { useCinematicHud, useWorldHint } from '@/lib/ui/cinematicHud';
import { guideBusy, subscribeGuide } from '@/lib/guide/store';
import { destination, encodeFocus, frameOf, isLongTrip, parentOf, pickableRegions, semanticStep, UNIVERSE_DIR, universeFrame, type Target } from '@/lib/cosmos/navigate';
import { WorldHint } from '@/components/ui/hud/WorldHint';
import hud from '@/components/ui/hud/cinematicHud.module.css';
import CosmosMap from './CosmosMap';
import { apiClient } from '@/services/api-client';
import { useCosmosUniverse } from '@/lib/cosmos/useCosmosUniverse';
import { CATEGORY_COLOR, CATEGORY_LABEL, METHOD_LABEL, RELATIONS, type Category, type RelationType } from '@/lib/cosmos/ontology';
import { computeView, DEFAULT_FILTERS, FLAG, placeLabels, UNIVERSE, type Filters, type Focus } from '@/lib/cosmos/view';
import { learningGuide, type GuideAction, type GuideItem } from '@/lib/cosmos/guide';
import { explainEdge, POS_EN, POS_VI, type SenseTable } from '@/lib/cosmos/explain';
import { Timeline } from '@/lib/cosmos/timeline';
import { puzzles, check, missionCandidates, missionState, readMissions, writeMissions, type MissionTarget, type Puzzle, type SkillMission } from '@/lib/cosmos/missions';
import type { Bundle } from '@/lib/cosmos/aggregate';
import { COSMOS_LEXICON_VERSION } from '@/lib/cosmos/lexiconAsset';
import { SKILL, type CosmosGraph, type CosmosNode } from '@/lib/cosmos/types';
import { memoryOf, MEMORY_LABEL, MEMORY_WHY, type MemoryState } from '@/lib/cosmos/memory';
import type { CameraView, SceneHandle } from './CosmosScene';
import AskCosmos from './AskCosmos';
import KnowledgeTree, { MEMORY_TONE } from './KnowledgeTree';
import { PearlSegmented, PearlSwitch } from '@/components/ui/pearl/PearlControls';
import pg from '@/components/ui/pearl/pearlGlass.module.css';
import { autoQuality, QUALITY, QUALITY_LABEL, QUALITY_LEVELS, readQualityChoice, stepDown, webglSupport, writeQualityChoice, type QualityChoice, type QualityLevel } from './quality';
import s from './cosmos.module.css';

const CosmosScene = dynamic(() => import('./CosmosScene'), { ssr: false });

/** The learner's deliberate choice of view (this browser): 3D or the knowledge tree. A device without WebGL or a lost context
 *  shows the tree WITHOUT writing this choice, so a temporary failure never turns 3D off for good. */
type ViewMode = '3d' | 'tree';
const VIEW_KEY = 'ec_cosmos_view:v1';
function readViewMode(): ViewMode { try { return localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : '3d'; } catch { return '3d'; } }
function writeViewMode(v: ViewMode) { try { localStorage.setItem(VIEW_KEY, v); } catch { /* optional */ } }


type Selection = { kind: 'node'; index: number } | { kind: 'edge'; index: number } | { kind: 'bundle'; bundle: Bundle } | null;
type Mode = 'explore' | 'mission' | 'replay';
const SKILLS: [number, string, string][] = [[SKILL.flashcard, 'Thẻ', 'Cards'], [SKILL.reading, 'Đọc', 'Reading'], [SKILL.listening, 'Nghe', 'Listening'],
  [SKILL.writing, 'Viết', 'Writing'], [SKILL.speaking, 'Nói', 'Speaking'], [SKILL.grammar, 'Ngữ pháp', 'Grammar']];
/** Learning stages (from recorded evidence only): [vi, en, what it means vi, en]. "Demonstrated" is never claimed (no evidence of correct use). */
const STAGE: Record<Exclude<CosmosNode['stage'], ''>, [string, string, string, string]> = {
  discovered: ['Đã mở', 'Opened', 'Bạn đã mở bài học này; chưa có bằng chứng đã học.', 'You opened this lesson; no evidence of study yet.'],
  saved: ['Đã lưu', 'Saved', 'Bạn đã lưu thẻ nhưng chưa ôn lần nào.', 'You saved the card but have not reviewed it yet.'],
  studied: ['Đã học', 'Studied', 'Có lần ôn hoặc bài học đã ghi nhận.', 'Reviews or a studied lesson are recorded.'],
  practiced: ['Đã dùng', 'Used', 'Từ có trong bài viết hoặc lời nói của chính bạn (không phải đánh giá đúng sai).', 'The word occurs in your own writing or speech (not a correctness judgement).'],
  mastered: ['Thành thạo', 'Mastered', 'Thẻ ở trạng thái Thành thạo do bạn tự chọn Dễ, hoặc chủ điểm đã qua bài kiểm tra của Grammar Academy.', 'Card is Mastered by your own "Easy", or the topic passed its Grammar Academy check.'],
};

export default function CosmosPage() {
  const { locale } = useLanguage();
  const vi = locale !== 'en';
  // Immersive (default) or inside the website layout; the frame switches around this page without remounting it.
  const [display, toggleDisplay] = useWorldDisplay('cosmos');
  const T = (a: string, b: string) => (vi ? a : b);
  const { data: session } = useSession();
  const userId = session?.user ? String((session.user as { id?: string | number }).id ?? '') : '';
  const [universe, retry, refresh, ask] = useCosmosUniverse(userId);
  const graph = universe.phase === 'ready' ? universe.graph : null;
  const senses = universe.phase === 'ready' ? universe.senses : null;

  // ── device and preferences ─────────────────────────────────────────────────────────────────────────────────────
  const [reduced, setReduced] = useState(false);
  const [support, setSupport] = useState<'ok' | 'none' | 'unknown'>('unknown');
  const [contextLost, setContextLost] = useState(false);
  const [sceneKey, setSceneKey] = useState(0);
  const [qualityChoice, setQualityChoice] = useState<QualityChoice>('auto');
  const [qualityLevel, setQualityLevel] = useState<QualityLevel>('balanced');
  const [viewMode, setViewModeState] = useState<ViewMode>('3d');
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync(); mq.addEventListener('change', sync);
    setSupport(webglSupport());
    const c = readQualityChoice();
    setQualityChoice(c); setQualityLevel(c === 'auto' ? autoQuality() : c);
    setViewModeState(readViewMode());
    return () => mq.removeEventListener('change', sync);
  }, []);
  const chooseQuality = (c: QualityChoice) => { setQualityChoice(c); writeQualityChoice(c); setQualityLevel(c === 'auto' ? autoQuality() : c); };
  const onSlow = useCallback(() => { setQualityChoice(c => { if (c === 'auto') setQualityLevel(l => stepDown(l)); return c; }); }, []);
  const showTree = viewMode === 'tree' || support === 'none' || contextLost;

  // ── focus, selection, filters, modes ───────────────────────────────────────────────────────────────────────────
  const [focus, setFocus] = useState<Focus>(UNIVERSE);
  const [selection, setSelection] = useState<Selection>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [mode, setMode] = useState<Mode>('explore');
  const [menu, setMenu] = useState<'none' | 'filters' | 'legend'>('none');
  const [asking, setAsking] = useState(false);
  const [whyEdge, setWhyEdge] = useState(-1);
  const handle = useRef<SceneHandle | null>(null);
  // the camera of a scene the learner left for the tree, and a place picked in the tree, restored when 3D comes back
  const savedCam = useRef<CameraView | null>(null);
  const flyOnReturn = useRef<Focus | null>(null);

  // Neural Time Travel
  const timeline = useMemo(() => (graph ? new Timeline(graph) : null), [graph]);
  const [time, setTime] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const slice = mode === 'replay' && timeline && time !== null ? timeline.at(time) : null;
  useEffect(() => { if (mode === 'replay' && timeline && time === null) setTime(timeline.end); if (mode !== 'replay') { setPlaying(false); } }, [mode, timeline, time]);
  // The replay clock runs every frame in a ref; React hears of it only when an event boundary is crossed (the scene's slice
  // changes on that very frame) or at most ~30 times a second for the time bar (performance release 2026-11-16, PERF-07:
  // it used to re-render the whole page every frame). Same speed, same end, same exact slices.
  const timeRef = useRef<number | null>(null);
  useEffect(() => { timeRef.current = time; }, [time]);
  useEffect(() => {
    if (!playing || !timeline) return;
    let raf = 0, last = performance.now(), committedAt = 0;
    const span = timeline.end - timeline.start;
    let clock = timeRef.current ?? timeline.start;
    let slice = timeline.indexAt(clock);
    const step = (now: number) => {
      const dt = now - last; last = now;
      clock = clock + span * dt / 22000;
      if (clock >= timeline.end) { setTime(timeline.end); setPlaying(false); return; }
      const k = timeline.indexAt(clock);
      if (k !== slice || now - committedAt >= 33) { slice = k; committedAt = now; setTime(clock); }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline]);

  // ── growth: stars discovered since the last visit (per account, this browser), and stars added during this visit ──────
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [growth, setGrowth] = useState<{ stars: number; edges: number; target: number } | null>(null);
  const prevGraph = useRef<CosmosGraph | null>(null);
  const focusCode = useRef('');
  useEffect(() => {
    if (!graph || !userId) return;
    const key = `ec_cosmos_seen:v1:u${userId}`;
    const before = prevGraph.current;
    let newNodes: number[] = [];
    if (before) {
      const known = new Set(before.nodes.map(n => n.id));
      newNodes = graph.nodes.filter(n => n.kind !== 'concept' && !(n.kind === 'word' && !n.cardIds.length) && !known.has(n.id)).map(n => n.i);
      // the same place in the universe after a rebuild (indices may move, ids never do)
      setFocus(decode(focusCode.current) ?? UNIVERSE);
      setSelection(sel => {
        if (sel?.kind !== 'node') return null;
        const n = graph.nodes.find(x => x.id === before.nodes[sel.index]?.id);
        return n ? { kind: 'node', index: n.i } : null;
      });
    } else {
      let seen = 0;
      try { seen = Number(localStorage.getItem(key) || 0); } catch { /* optional */ }
      // no mark (first visit, or a cleared browser): claim nothing as new
      if (seen > 0) newNodes = graph.nodes.filter(n => n.kind !== 'concept' && !(n.kind === 'word' && !n.cardIds.length) && n.discoveredAt > seen).map(n => n.i);
    }
    try { localStorage.setItem(key, String(graph.generatedAt)); } catch { /* optional */ }
    prevGraph.current = graph;
    setFresh(new Set(newNodes));
    if (newNodes.length) {
      const newest = newNodes.reduce((a, b) => (graph.nodes[b].discoveredAt > graph.nodes[a].discoveredAt ? b : a));
      const ns = new Set(newNodes);
      setGrowth({ stars: newNodes.length, edges: graph.edges.filter(e => e.status === 'VERIFIED' && (ns.has(e.s) || ns.has(e.t))).length, target: newest });
    } else setGrowth(null);
  }, [graph, userId]); // eslint-disable-line react-hooks/exhaustive-deps
  // back from another tab (a card saved elsewhere): rebuild quietly, at most once a minute
  useEffect(() => {
    let last = Date.now();
    const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - last > 60000) { last = Date.now(); refresh(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // Missions
  const missionList = useMemo(() => (graph ? puzzles(graph) : []), [graph]);
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [solved, setSolved] = useState<Set<number>>(new Set());

  const view = useMemo(() => {
    if (!graph) return null;
    const v = computeView(graph, focus, filters, slice);
    if (mode === 'mission' && puzzle) {
      const hidden = new Set(puzzle.answers.map(a => a.edge));
      v.edges = v.edges.filter(i => !hidden.has(i) || solved.has(i));
    }
    if (!slice) for (const i of fresh) if (v.starFlag[i] !== undefined) v.starFlag[i] |= FLAG.fresh;
    return v;
  }, [graph, focus, filters, slice, mode, puzzle, solved, fresh]);

  // ── navigation: focus ↔ URL (Back / Forward), deep links from other modules ────────────────────────────────────
  const encode = useCallback((f: Focus) => (graph ? encodeFocus(graph, f) : ''), [graph]);
  const decode = useCallback((code: string | null): Focus | null => {
    if (!graph || !code) return null;
    if (code.startsWith('gal:')) { const g = graph.galaxies.find(x => x.key === code.slice(4)); return g ? { ...UNIVERSE, level: 'galaxy', galaxy: g.i } : null; }
    if (code.startsWith('con:')) { const c = graph.constellations.find(x => x.key === code.slice(4)); return c ? { ...UNIVERSE, level: 'constellation', galaxy: c.galaxy, constellation: c.i } : null; }
    if (code.startsWith('sys:')) { const y = graph.systems.find(x => x.key === code.slice(4)); return y ? { level: 'system', galaxy: y.galaxy, constellation: y.constellation, system: y.i, node: -1 } : null; }
    const n = graph.nodes.find(x => x.id === code);
    return n ? starFocus(n) : null;
  }, [graph]);
  const camFor = useCallback((f: Focus, instant = false, arc = false) => {
    const h = handle.current;
    if (!h || !graph) return;
    const fr = frameOf(graph, f);
    h.flyTo(fr.target, fr.distance, instant, f.level === 'universe' ? UNIVERSE_DIR : undefined, arc);
  }, [graph]);
  // In-app history depth (Back to the previous view is offered only over this page's own steps).
  const [depth, setDepth] = useState(0);
  const lastGo = useRef(0);
  /**
   * Go to a place. The camera travels there through the hierarchy (a trip to another galaxy arcs out and back in, its
   * destination ringed with light); `fly: false` keeps the camera where the learner put it (semantic zoom); `replace`
   * records the place without a new Back step.
   */
  const go = useCallback((f: Focus, how: { push?: boolean; fly?: boolean; replace?: boolean } = {}) => {
    const { push = true, fly = true, replace = false } = how;
    const from = focusRef.current;
    setFocus(f);
    setHover(null); // a tooltip left from the pointer's last place never stays over a panel that opens
    hovered.current = '';
    focusCode.current = encode(f);
    lastGo.current = performance.now();
    if (f.level === 'star') setFresh(prev => { if (!prev.has(f.node)) return prev; const n = new Set(prev); n.delete(f.node); return n; });
    setWhyEdge(-1);
    if (f.level === 'star') setSelection({ kind: 'node', index: f.node });
    else setSelection(sel => (sel?.kind === 'bundle' ? sel : null));
    const h = handle.current;
    if (fly && graph) {
      const arc = isLongTrip(from, f);
      camFor(f, false, arc);
      if (arc && h) { const c = f.level === 'galaxy' ? graph.galaxies[f.galaxy] : f.constellation >= 0 ? graph.constellations[f.constellation] : graph.galaxies[f.galaxy]; if (c) h.mark({ x: c.x, y: c.y, z: c.z, r: c.radius * 0.95, color: c.color, travel: true }); }
      else h?.mark(null);
    }
    if (push && typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      ['word', 'grammar', 'source', 'focus'].forEach(k => url.searchParams.delete(k));
      const code = encode(f);
      if (code) url.searchParams.set('focus', code);
      const d = (window.history.state?.cosmosDepth ?? 0) + (replace ? 0 : 1);
      if (replace) window.history.replaceState({ ...window.history.state, cosmos: code, cosmosDepth: d }, '', url.pathname + url.search);
      else window.history.pushState({ cosmos: code, cosmosDepth: d }, '', url.pathname + url.search);
      setDepth(d);
    }
  }, [camFor, encode, graph]);
  // first load: a deep link (?word= / ?grammar= / ?source= / ?focus=) opens on its star
  const arrived = useRef(false);
  const onReady = useCallback((h: SceneHandle) => {
    handle.current = h;
    // Development only (removed from production builds): lets the browser journey aim at a galaxy's body, not its name.
    if (process.env.NODE_ENV !== 'production' && graph) (window as unknown as { __cosmosQA?: unknown }).__cosmosQA = {
      at: (kind: 'galaxy' | 'constellation' | 'system' | 'node', i: number) => { const c = kind === 'node' ? graph.nodes[i] : kind === 'galaxy' ? graph.galaxies[i] : kind === 'constellation' ? graph.constellations[i] : graph.systems[i]; return c ? h.project([{ key: 'p', x: c.x, y: c.y, z: c.z }])[0] ?? null : null; },
      galaxies: () => graph.galaxies.filter(x => x.count > 0).map(x => ({ i: x.i, key: x.key, radius: x.radius })),
      constellations: (galaxy: number) => graph.constellations.filter(c => c.galaxy === galaxy && c.count > 0).map(c => ({ i: c.i, key: c.key })),
      nodes: (constellation: number) => graph.nodes.filter(n => n.constellation === constellation && n.kind === 'word' && n.cardIds.length).map(n => ({ i: n.i, id: n.id })),
      focus: () => focusRef.current, flying: () => h.flying(), view: () => h.getView(), frame: (f: Focus) => frameOf(graph, f),
    };
    if (savedCam.current) { // back from the tree: the same camera, then the place picked there (if any)
      h.setView(savedCam.current); savedCam.current = null;
      const f = flyOnReturn.current; flyOnReturn.current = null;
      if (f) setTimeout(() => camFor(f), 40);
      return;
    }
    if (flyOnReturn.current) { const f = flyOnReturn.current; flyOnReturn.current = null; arrived.current = true; setTimeout(() => camFor(f, true), 0); return; }
    if (arrived.current || !graph) return;
    arrived.current = true;
    const p = new URLSearchParams(window.location.search);
    const word = p.get('word')?.trim().toLowerCase();
    const target = p.get('focus') ? decode(p.get('focus'))
      : word ? [word, word.replace(/ies$/, 'y'), word.replace(/es$/, ''), word.replace(/s$/, '')].map(w => decode(`w:${w}`)).find(Boolean) ?? null : p.get('grammar') ? decode(`g:${p.get('grammar')}`) : p.get('source') ? decode(`s:${p.get('source')}`) : null;
    { const u = universeFrame(graph); h.flyTo(u.target, u.distance, true, UNIVERSE_DIR); }
    if (target) { setFocus(target); focusCode.current = encode(target); if (target.level === 'star') setSelection({ kind: 'node', index: target.node }); setTimeout(() => camFor(target), 60); }
    else if ((word || p.get('grammar') || p.get('source')) && !target) setNotice(T('Mục này chưa có trong vũ trụ của bạn (chưa có thẻ, chủ điểm hay bài hoàn thành tương ứng).', 'This item is not in your universe yet (no card, topic or completed lesson for it).'));
  }, [graph, decode, camFor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const pop = () => { const f = decode(new URLSearchParams(window.location.search).get('focus')) ?? UNIVERSE; const from = focusRef.current; setFocus(f); focusCode.current = encode(f); lastGo.current = performance.now(); setDepth(window.history.state?.cosmosDepth ?? 0); setSelection(f.level === 'star' ? { kind: 'node', index: f.node } : null); camFor(f, false, isLongTrip(from, f)); };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [decode, camFor]);
  const up = useCallback(() => {
    if (!graph) return;
    const p = parentOf(graph, focus);
    if (p) go(p);
  }, [focus, graph, go]);

  // ── picking ────────────────────────────────────────────────────────────────────────────────────────────────────
  const down = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string; go?: boolean } | null>(null);
  const hoverAt = useRef(0), hovered = useRef(''), userMovedAt = useRef(0);
  // The places a press may land on here, besides stars: other galaxies (from any depth), the constellations and systems in view.
  const regions = useMemo(() => (graph && view ? pickableRegions(graph, focus, view.counts) : []), [graph, view, focus]);
  const local = (e: ReactPointerEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onPointerDown = (e: ReactPointerEvent) => { down.current = { ...local(e), touch: e.pointerType === 'touch' }; userMovedAt.current = performance.now(); interacted(); };
  const communityOf = (kind: 'galaxy' | 'constellation' | 'system', i: number) => (kind === 'galaxy' ? graph!.galaxies[i] : kind === 'constellation' ? graph!.constellations[i] : graph!.systems[i]);
  const onPointerUp = (e: ReactPointerEvent) => {
    const start = down.current; down.current = null;
    const p = local(e);
    // A press that travelled is a drag of the view (a finger may wobble a little more than a mouse), never a choice.
    if (!start || Math.hypot(p.x - start.x, p.y - start.y) > (start.touch ? 10 : 5) || !handle.current || !graph) return;
    if (handle.current.flying()) handle.current.stop();
    const hit = handle.current.pick(p.x, p.y, { regions, coarse: start.touch });
    if (hit.kind === 'edge') { setSelection({ kind: 'edge', index: hit.index }); setWhyEdge(hit.index); return; }
    if (hit.kind === 'bundle') { if (view) setSelection({ kind: 'bundle', bundle: view.bundles[hit.index] }); return; }
    if (hit.kind === 'none') { missed(); return; }
    const dest = destination(graph, focus, hit as Target);
    if (dest) go(dest);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (down.current) { userMovedAt.current = performance.now(); return; }
    if (!handle.current || !graph) return;
    const now = performance.now();
    if (now - hoverAt.current < 60) return;
    hoverAt.current = now;
    const p = local(e);
    const h = handle.current, hit = h.pick(p.x, p.y, { regions });
    const key = `${hit.kind}:${'index' in hit ? hit.index : ''}`;
    const el = e.currentTarget as HTMLElement;
    const ring = (k: string, m: Parameters<SceneHandle['mark']>[0]) => { if (hovered.current !== k) { hovered.current = k; h.mark(m); } };
    if (hit.kind === 'node') {
      const n = graph.nodes[hit.index], dest = destination(graph, focus, hit);
      const where = dest && dest.level !== 'star' && dest.level !== 'system' ? (dest.level === 'galaxy' ? graph.galaxies[dest.galaxy] : graph.constellations[dest.constellation]) : null;
      setHover({ ...p, go: !!dest, text: where ? T(`${vi ? where.vi : where.en} — bấm để bay tới`, `${where.en} — press to fly there`) : n.kind === 'grammar' ? (vi ? n.sub || n.label : n.label) : n.sub ? `${n.label} · ${n.sub}` : n.label });
      ring(key, where ? { x: where.x, y: where.y, z: where.z, r: where.radius * 0.95, color: where.color } : { x: n.x, y: n.y, z: n.z, r: 6 + (view?.starScale[n.i] ?? 1) * 4, color: '#a5f3fc' });
      el.style.cursor = dest ? 'pointer' : '';
    } else if (hit.kind === 'galaxy' || hit.kind === 'constellation' || hit.kind === 'system') {
      const c = communityOf(hit.kind, hit.index), n = hit.kind === 'galaxy' ? view?.counts.galaxy[hit.index] : hit.kind === 'constellation' ? view?.counts.constellation[hit.index] : c.count;
      const what = hit.kind === 'galaxy' ? T('Thiên hà', 'Galaxy') : hit.kind === 'constellation' ? T('Chòm sao', 'Constellation') : T('Hệ sao', 'Star system');
      setHover({ ...p, go: true, text: T(`${what} ${c.vi} · ${n ?? 0} ngôi sao — bấm để bay tới`, `${what} ${c.en} · ${n ?? 0} stars — press to fly there`) });
      ring(key, { x: c.x, y: c.y, z: c.z, r: c.radius * 0.95, color: c.color });
      el.style.cursor = 'pointer';
    } else {
      if (hit.kind === 'edge') { const ed = graph.edges[hit.index]; setHover({ ...p, text: `${graph.nodes[ed.s].label} — ${relName(ed.type, ed.status, vi)} — ${graph.nodes[ed.t].label}` }); }
      else if (hit.kind === 'bundle' && view) { const b = view.bundles[hit.index]; setHover({ ...p, text: T(`${b.edges.length} quan hệ — bấm để xem`, `${b.edges.length} relations — click to list`) }); }
      else setHover(null);
      ring('', null);
      el.style.cursor = hit.kind === 'none' ? '' : 'pointer';
    }
  };

  // ── labels: projected by the scene, placed here (collision-free, priority + hysteresis) ─────────────────────────
  const [labels, setLabels] = useState<{ key: string; x: number; y: number; text: string; kind: string; node: number; community: number; selected: boolean }[]>([]);
  const prevLabels = useRef(new Set<string>());
  const stageRef = useRef<HTMLDivElement>(null);
  const onFrameLabels = useCallback(() => {
    const h = handle.current, el = stageRef.current;
    if (!h || !view || !graph || !el) return;
    const textOf = (c: typeof view.labels[number]) => c.text || (() => {
      const list = c.kind === 'galaxy' ? graph.galaxies : c.kind === 'constellation' ? graph.constellations : graph.systems;
      const co = list[c.community];
      return co ? (vi ? co.vi : co.en) : '';
    })();
    const cands = view.labels.slice(0, 400);
    const proj = h.project(cands.map(c => ({ key: c.key, x: c.x, y: c.y, z: c.z })));
    const byKey = new Map(cands.map(c => [c.key, c]));
    const sized = proj.map(p => { const c = byKey.get(p.key)!; const text = textOf(c); const big = c.kind === 'galaxy' ? 8.6 : c.kind === 'constellation' ? 7.8 : 7.4; return { ...p, w: Math.min(232, text.length * big + 24), h: c.kind === 'galaxy' ? 30 : 24, priority: c.priority, text, c }; });
    const placed = placeLabels(sized, el.clientWidth, el.clientHeight, prevLabels.current, QUALITY[qualityLevel].labels);
    prevLabels.current = new Set(placed.map(p => p.key));
    const sel = selection?.kind === 'node' ? selection.index : -1;
    const next = placed.map(p => { const z = sized.find(x => x.key === p.key)!; return { key: p.key, x: Math.round(p.x), y: Math.round(p.y), text: z.text, kind: z.c.kind, node: z.c.node, community: z.c.community, selected: z.c.node === sel }; });
    setLabels(prev => (prev.length === next.length && prev.every((l, i) => l.key === next[i].key && l.x === next[i].x && l.y === next[i].y && l.selected === next[i].selected && l.text === next[i].text) ? prev : next));
    // Where the camera is (the star map's marker), and semantic zoom: zooming far out climbs a level, zooming in on a galaxy or
    // a constellation enters it — only after the learner moved the view themselves, never during a flight, never in a mission.
    const v = h.getView();
    if (v) {
      const now = performance.now();
      if (now - camAt.current > 240) {
        camAt.current = now;
        setCam(prev => prev && Math.hypot(prev.target[0] - v.target[0], prev.target[2] - v.target[2], prev.pos[0] - v.pos[0], prev.pos[2] - v.pos[2]) < 4 ? prev : v);
      }
      if (mode !== 'mission' && !h.flying() && now - lastGo.current > 1400 && now - userMovedAt.current < 2500) {
        const dist = Math.hypot(v.pos[0] - v.target[0], v.pos[1] - v.target[1], v.pos[2] - v.target[2]);
        const W = el.clientWidth || 1, H = el.clientHeight || 1, short = Math.min(W, H);
        const next = semanticStep(graph, focusRef.current, { target: v.target, distance: dist }, (kind, i) => {
          const c = kind === 'galaxy' ? graph.galaxies[i] : graph.constellations[i], m = c && h.measure(c.x, c.y, c.z, c.radius);
          return m ? { x: m.sx / W, y: m.sy / H, r: m.pr / short } : null;
        });
        const code = next ? encode(next) + '|' + next.level : '';
        if (!next) zoomWant.current = null;
        else if (!zoomWant.current || zoomWant.current.code !== code) zoomWant.current = { code, at: now };
        else if (now - zoomWant.current.at > 280) { zoomWant.current = null; go(next, { fly: false, replace: true }); }
      }
    }
  }, [view, graph, vi, qualityLevel, selection, mode, encode, go]);
  const [cam, setCam] = useState<{ target: [number, number, number]; pos: [number, number, number] } | null>(null);
  const camAt = useRef(0), zoomWant = useRef<{ code: string; at: number } | null>(null);
  const clickLabel = (l: typeof labels[number]) => {
    if (!graph) return;
    interacted();
    if (l.node >= 0) { const n = graph.nodes[l.node]; if (l.kind === 'ghost') { setSelection({ kind: 'node', index: n.i }); return; } if (l.kind === 'system') go({ level: 'system', galaxy: n.galaxy, constellation: n.constellation, system: n.system, node: -1 }); else go(starFocus(n)); }
    else if (l.kind === 'galaxy') go({ ...UNIVERSE, level: 'galaxy', galaxy: l.community });
    else if (l.kind === 'constellation') { const c = graph.constellations[l.community]; go({ ...UNIVERSE, level: 'constellation', galaxy: c.galaxy, constellation: c.i }); }
  };

  // ── search over the loaded universe (local, no request) ─────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!graph || q.length < 1) return [];
    return graph.nodes.filter(n => n.kind !== 'concept' && (n.label.toLowerCase().includes(q) || n.sub.toLowerCase().includes(q)))
      .sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)) || a.label.length - b.label.length).slice(0, 12);
  }, [graph, query]);
  const searchRef = useRef<HTMLInputElement>(null);
  const onSearchKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(results.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && results[active]) { go(starFocus(results[active])); setQuery(''); }
    else if (e.key === 'Escape') setQuery('');
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); go(UNIVERSE); }
      else if (e.key === 'Escape') { if (handle.current?.flying()) { handle.current.stop(); return; } if (selection && selection.kind !== 'node') setSelection(null); else up(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [up, selection, go]);

  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});
  const saveWord = async (lemma: string) => {
    setSaving(m => ({ ...m, [lemma]: 'saving' }));
    // the server stores the card; the universe is then rebuilt from the evidence (a real new star, never a drawn one)
    // (the stored save sends the learning-evidence pulse: the universe rebuilds once, from the server's evidence)
    try { await apiClient.post('/flashcards', { front: lemma, back: '', example: '' }); setSaving(m => ({ ...m, [lemma]: 'saved' })); }
    catch { setSaving(m => ({ ...m, [lemma]: 'error' })); }
  };

  // ── 3D ↔ knowledge tree: the scene unmounts in the tree (GPU released) and comes back where it was ────────────────
  const setViewMode = useCallback((v: ViewMode) => {
    if (v === 'tree') { savedCam.current = handle.current?.getView() ?? savedCam.current; handle.current = null; setHover(null); }
    else {
      if (!savedCam.current) flyOnReturn.current = focusRef.current;
      if (contextLost) { setContextLost(false); setSceneKey(k => k + 1); }
    }
    writeViewMode(v); setViewModeState(v);
  }, [contextLost]);
  const focusRef = useRef<Focus>(UNIVERSE);
  focusRef.current = focus;
  const show3D = (f: Focus) => { flyOnReturn.current = f; go(f); setViewMode('3d'); };
  // a deep link opened while the tree is shown (or without WebGL) selects its star there too
  useEffect(() => {
    if (!graph || !showTree || arrived.current) return;
    arrived.current = true;
    const p = new URLSearchParams(window.location.search);
    const word = p.get('word')?.trim().toLowerCase();
    const target = p.get('focus') ? decode(p.get('focus')) : word ? decode(`w:${word}`) : p.get('grammar') ? decode(`g:${p.get('grammar')}`) : p.get('source') ? decode(`s:${p.get('source')}`) : null;
    if (target) { setFocus(target); focusCode.current = encode(target); if (target.level === 'star') setSelection({ kind: 'node', index: target.node }); }
  }, [graph, showTree, decode, encode]);
  // panels sit right under the top bar whatever its height (it wraps to two rows on narrower screens)
  const worldRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLDivElement>(null);
  const ready = universe.phase === 'ready';
  useEffect(() => {
    const bar = topbarRef.current, world = worldRef.current;
    if (!bar || !world) return;
    const sync = () => world.style.setProperty('--cz-top', `${Math.round(bar.offsetTop + bar.offsetHeight + 10)}px`);
    const ro = new ResizeObserver(sync);
    ro.observe(bar); sync();
    return () => ro.disconnect();
  }, [ready]);
  // the settings popover closes on Escape and on a press outside it
  const settingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (menu !== 'filters') return;
    const down = (e: PointerEvent) => { if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setMenu('none'); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu('none'); } };
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [menu]);

  // ── Learning guide: recommendations from evidence, dismissed for the day per account (this browser) ───────────────
  const guide = useMemo<GuideItem[]>(() => (graph ? learningGuide(graph) : []), [graph]);
  const guideKey = userId ? `ec_cosmos_guide:v1:u${userId}` : '';
  const today = new Date().toISOString().slice(0, 10);
  // The universe comes first: the guide starts as its small pill (one press opens it; it is still offered every day until dismissed).
  const [guideOpen, setGuideOpen] = useState(false);
  const closeGuide = () => { setGuideOpen(false); try { if (guideKey) localStorage.setItem(guideKey, today); } catch { /* optional */ } };
  const runGuide = (a: GuideAction) => {
    if (!graph) return;
    if (a.kind === 'focus') go(starFocus(graph.nodes[a.node]));
    else if (a.kind === 'constellation') { const c = graph.constellations[a.constellation]; go({ ...UNIVERSE, level: 'constellation', galaxy: c.galaxy, constellation: c.i }); }
    else if (a.kind === 'discover') { setFilters(f => ({ ...f, frontier: true })); go(starFocus(graph.nodes[a.node])); }
    else if (a.kind === 'mission' && userId) {
      const word = graph.nodes[a.node].label, list = readMissions(userId);
      if (!list.some(m => m.word === word && m.target === a.target)) writeMissions(userId, [...list, { word, target: a.target, startedAt: Date.now() }]);
      setAsking(false); setMode('mission');
    }
  };

  // ── the Adaptive Cinematic HUD: controls on entry, the universe alone while it is explored, all controls back near an edge,
  //    a control, on keyboard focus or from the puck; held while a menu, the search list or a guide is open ────────────────
  const touring = useSyncExternalStore(subscribeGuide, guideBusy, () => false);
  const { state: hudState, shown: hudShown, reveal, conceal } = useCinematicHud(worldRef, { hold: menu !== 'none' || results.length > 0 || touring, enabled: ready && !showTree });
  const { hint, dismiss: dismissHint, missed, interacted } = useWorldHint('cosmos', ready && !showTree);
  // a growth note leaves by itself
  useEffect(() => { if (!growth) return; const t = window.setTimeout(() => setGrowth(null), 12000); return () => clearTimeout(t); }, [growth]);

  // ── render ─────────────────────────────────────────────────────────────────────────────────────────────────────
  // The state screens have no top bar: in the immersive view they still need the way out and the layout switch.
  const corner = <div className={s.corner}>
    {display === 'immersive' && <Link className={`${s.panel} ${s.btn}`} href="/?tab=dashboard" aria-label={T('Rời Vũ trụ tri thức, về Trang chủ', 'Leave the universe, back to Home')}><ArrowLeft size={15} /><span>{T('Trở về', 'Exit')}</span></Link>}
    <button className={`${s.panel} ${s.btn}`} data-testid="world-display-toggle" data-display={display} aria-pressed={display === 'immersive'} onClick={() => toggleDisplay()}
      aria-label={display === 'immersive' ? T('Thu về giao diện trang web, hiện thanh bên', 'Show inside the website layout, with the sidebar') : T('Mở toàn màn hình ứng dụng', 'Fill the application window')}>
      {display === 'immersive' ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
  </div>;
  if (universe.phase === 'loading' || !userId) {
    const step = { evidence: T('Đang đọc bằng chứng học của bạn…', 'Reading your learning evidence…'), lexicon: T('Đang tải bản đồ từ vựng đã kiểm chứng…', 'Loading the verified word map…'), building: T('Đang dựng vũ trụ trên thiết bị của bạn…', 'Building your universe on this device…') }[universe.phase === 'loading' ? universe.stage : 'evidence'];
    return <div className={`${pg.tokens} ${s.world}`} data-cosmos="loading">{corner}<div className={s.center}><div className={s.panel} role="status" aria-live="polite"><div className={s.orbit} aria-hidden /><h2>{T('Vũ trụ tri thức', 'Knowledge universe')}</h2><p className={s.muted}>{step}</p></div></div></div>;
  }
  if (universe.phase === 'error') {
    return <div className={`${pg.tokens} ${s.world}`} data-cosmos="error">{corner}<div className={s.center}><div className={s.panel} role="alert"><h2>{T('Chưa mở được vũ trụ', 'Could not open the universe')}</h2><p className={s.muted}>{T('Không tải được dữ liệu. Kiểm tra kết nối rồi thử lại.', 'The data could not be loaded. Check your connection and try again.')} ({universe.message})</p><button className={s.btn} onClick={retry}><RotateCcw size={15} />{T('Thử lại', 'Try again')}</button></div></div></div>;
  }
  const g = graph!;
  const isMet = (n: CosmosNode) => n.kind === 'word' && !n.cardIds.length;
  const knowledgeCount = g.nodes.filter(n => n.kind !== 'concept' && !isMet(n)).length;
  const metCount = g.nodes.filter(isMet).length;
  if (!knowledgeCount) {
    return <div className={`${pg.tokens} ${s.world}`} data-cosmos="empty">{corner}<div className={s.center}><div className={s.panel}><h2>{T('Vũ trụ của bạn đang chờ ngôi sao đầu tiên', 'Your universe is waiting for its first star')}</h2>
      <p className={s.muted}>{T('Mỗi ngôi sao là một điều bạn thật sự đã học: một thẻ từ vựng, một chủ điểm ngữ pháp đã mở, một bài đọc hay bài nghe đã hoàn thành.', 'Each star is something you really studied: a vocabulary card, a grammar topic you opened, a reading or listening lesson you completed.')}</p>
      <div className={s.actions}><Link className={s.btn} href="/flashcards">{T('Thẻ từ vựng', 'Flashcards')}</Link><Link className={s.btn} href="/grammar">{T('Ngữ pháp', 'Grammar')}</Link><Link className={s.btn} href="/reading">{T('Đọc', 'Reading')}</Link></div></div></div></div>;
  }

  const crumbs: { label: string; f: Focus }[] = [{ label: T('Vũ trụ', 'Universe'), f: UNIVERSE }];
  if (focus.galaxy >= 0) { const x = g.galaxies[focus.galaxy]; crumbs.push({ label: vi ? x.vi : x.en, f: { ...UNIVERSE, level: 'galaxy', galaxy: x.i } }); }
  if (focus.constellation >= 0) { const x = g.constellations[focus.constellation]; crumbs.push({ label: vi ? x.vi : x.en, f: { ...UNIVERSE, level: 'constellation', galaxy: x.galaxy, constellation: x.i } }); }
  if (focus.system >= 0 && g.systems[focus.system]?.count > 1) { const x = g.systems[focus.system]; crumbs.push({ label: T(`Hệ "${x.vi}"`, `"${x.en}" system`), f: { level: 'system', galaxy: x.galaxy, constellation: x.constellation, system: x.i, node: -1 } }); }
  if (focus.level === 'star') crumbs.push({ label: g.nodes[focus.node].label, f: focus });

  const treeNotice = support === 'none' ? T('Thiết bị này không hỗ trợ đồ họa 3D (WebGL), nên vũ trụ hiển thị dạng cây. Mọi quan hệ vẫn đầy đủ trong ô Soi.', 'This device has no 3D graphics (WebGL), so the universe is shown as a tree. Every relation is still in the inspector.')
    : contextLost ? T('Đồ họa 3D bị gián đoạn. Bạn có thể tiếp tục với cây tri thức hoặc mở lại cảnh 3D.', 'The 3D graphics were interrupted. Continue with the tree or reopen the 3D scene.') : '';
  const verified = g.edges.filter(e => e.status === 'VERIFIED').length;

  return (
    <div ref={worldRef} className={`${pg.tokens} ${s.world} ${hud.root}`} data-hud={showTree ? 'revealed' : hudState} data-cosmos="ready" data-view={showTree ? 'tree' : '3d'} data-inspecting={!!selection} data-level={focus.level} data-quality={qualityLevel} data-reduced={reduced ? '1' : '0'}
      data-stars={knowledgeCount} data-met={metCount} data-evidence-ms={universe.timing.evidenceMs} data-lexicon-ms={universe.timing.lexiconMs} data-build-ms={universe.timing.buildMs} data-edges={view?.edges.length ?? 0} data-strands={view?.bundles.length ?? 0} data-labels={showTree ? 0 : labels.length}>
      {!showTree && (
        <div ref={stageRef} className={s.stage} tabIndex={0} aria-label={T('Vũ trụ tri thức 3D. Dùng ô tìm kiếm, nhãn hoặc Cây tri thức để điều hướng bằng bàn phím.', '3D knowledge universe. Use search, labels or the Knowledge tree to navigate by keyboard.')}
          onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerMove={onPointerMove} onPointerLeave={() => { setHover(null); if (hovered.current) { hovered.current = ''; handle.current?.mark(null); } }}
          onWheel={() => { userMovedAt.current = performance.now(); interacted(); }}>
          {view && <CosmosScene key={sceneKey} graph={g} view={view} quality={qualityLevel} reduced={reduced} selectedEdge={selection?.kind === 'edge' ? selection.index : -1}
            onReady={onReady} onFrameLabels={onFrameLabels} onSlow={onSlow} onUserMove={() => { setHover(null); userMovedAt.current = performance.now(); }} onContextLost={() => setContextLost(true)}
            orbitSystem={focus.level === 'system' || focus.level === 'star' ? focus.system : -1} />}
          <div className={s.labels}>
            {labels.map(l => (
              <button key={l.key} className={s.label} data-kind={l.kind} data-state={l.selected ? 'selected' : undefined} style={{ transform: `translate(${l.x}px, ${l.y}px)` }}
                onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onClick={() => clickLabel(l)}
                title={l.kind === 'ghost' ? T(`${l.text}: liên quan (WordNet), bạn chưa học`, `${l.text}: related (WordNet), not learned yet`) : l.text}>{l.text}</button>
            ))}
          </div>
          {hover && <div className={`${s.panel} ${s.hover}`} data-go={hover.go ? '' : undefined} style={{ left: hover.x + 14, top: hover.y + 12 }}>{hover.text}</div>}
        </div>
      )}
      {showTree && <KnowledgeTree g={g} vi={vi} showMet={filters.met} visibleNode={slice?.nodeVisible ?? null} selected={selection?.kind === 'node' ? selection.index : -1}
        onSelect={n => go(starFocus(n))} onShow3D={show3D} notice={treeNotice}
        onRetry={contextLost && support !== 'none' ? () => { setContextLost(false); setSceneKey(k => k + 1); arrived.current = true; } : undefined} />}

      <div className={s.topbar} ref={topbarRef}>
        {/* The location puck: always on screen — the way out, one level up, the previous view, where you are, the controls. */}
        <nav className={`${s.panel} ${s.crumbs}`} aria-label={T('Vị trí trong vũ trụ', 'Location in the universe')} data-testid="cosmos-puck">
          {display === 'immersive' && <Link className={s.btn} href="/?tab=dashboard" data-testid="cosmos-exit" aria-label={T('Rời Vũ trụ tri thức, về Trang chủ', 'Leave the universe, back to Home')} title={T('Trở về', 'Exit')}><ArrowLeft size={15} /></Link>}
          <button className={s.btn} onClick={up} disabled={focus.level === 'universe'} data-testid="cosmos-up" aria-label={T('Lùi ra một tầng (Esc)', 'One level out (Esc)')} title={T('Lùi ra (Esc)', 'Out (Esc)')}><ArrowUp size={15} /></button>
          {depth > 0 && <button className={s.btn} onClick={() => window.history.back()} data-testid="cosmos-back" aria-label={T('Về góc nhìn trước', 'Back to the previous view')} title={T('Góc nhìn trước', 'Previous view')}><Undo2 size={15} /></button>}
          <span className={hud.fold}>
            <span className={s.title}>{T('Vũ trụ tri thức', 'Knowledge universe')}</span>
            {crumbs.slice(0, -1).map((c, i) => (
              <span key={i} style={{ display: 'contents' }}>{i > 0 && <span className={s.sep} aria-hidden>›</span>}<button className={s.crumb} onClick={() => go(c.f)}>{c.label}</button></span>
            ))}
            {crumbs.length > 1 && <span className={s.sep} aria-hidden>›</span>}
          </span>
          <span className={s.crumbNow} aria-current="location">{crumbs[crumbs.length - 1].label}</span>
          <button className={`${s.btn} ${s.btnGhost}`} onClick={() => (hudShown ? conceal() : reveal(6000))} aria-pressed={hudShown} data-testid="world-hud-toggle"
            aria-label={hudShown ? T('Ẩn bảng điều khiển, để vũ trụ chiếm màn hình', 'Hide the controls, let the universe fill the screen') : T('Hiện bảng điều khiển', 'Show the controls')}
            title={hudShown ? T('Ẩn bảng điều khiển', 'Hide controls') : T('Hiện bảng điều khiển', 'Show controls')}>{hudShown ? <EyeOff size={15} /> : <Eye size={15} />}</button>
        </nav>
        <div className={s.spacer} />
        <div className={`${s.panel} ${s.tools} ${hud.chrome}`} data-hud-chrome="top">
          <div className={s.search}>
            <input ref={searchRef} value={query} onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={onSearchKey} placeholder={T('Tìm từ, chủ điểm, bài… ( / )', 'Find a word, topic, lesson… ( / )')}
              aria-label={T('Tìm trong vũ trụ của bạn', 'Search your universe')} role="combobox" aria-expanded={results.length > 0} aria-controls="cosmos-results" aria-autocomplete="list" />
            {results.length > 0 && (
              <div id="cosmos-results" role="listbox" className={`${s.panel} ${s.results}`}>
                {results.map((n, i) => <button key={n.id} role="option" aria-selected={i === active} className={s.result} onClick={() => { go(starFocus(n)); setQuery(''); }}>
                  <span>{n.kind === 'grammar' && vi ? n.sub || n.label : n.label}</span><small>{kindName(n, vi)}</small></button>)}
              </div>
            )}
          </div>
          <div className={s.modes} role="group" aria-label={T('Chế độ', 'Mode')}>
            <button className={s.btn} aria-pressed={mode === 'explore' && !asking} onClick={() => { setMode('explore'); setAsking(false); }} title={T('Khám phá tự do', 'Free exploration')}><Compass size={15} /><span>{T('Khám phá', 'Explore')}</span></button>
            <button className={s.btn} aria-pressed={asking} data-testid="cosmos-ask" onClick={() => { setMode('explore'); setAsking(a => !a); }} title={T('Hỏi vũ trụ: trả lời bằng bằng chứng, có trích dẫn', 'Ask the universe: answers from evidence, with citations')}><MessageCircleQuestion size={15} /><span>{T('Hỏi', 'Ask')}</span></button>
            <button className={s.btn} aria-pressed={mode === 'mission'} onClick={() => { setMode('mission'); setAsking(false); setPuzzle(null); setSolved(new Set()); }} title={T('Thử thách nối lại chòm sao', 'Rebuild a constellation')}><Swords size={15} /><span>{T('Thử thách', 'Missions')}</span></button>
            <button className={s.btn} aria-pressed={mode === 'replay'} onClick={() => { setMode('replay'); setAsking(false); }} title={T('Xem vũ trụ của bạn lớn lên theo thời gian', 'Watch your universe grow')}><History size={15} /><span>{T('Hành trình', 'Replay')}</span></button>
          </div>
          <PearlSegmented<ViewMode> label={T('Kiểu hiển thị', 'View')} value={showTree ? 'tree' : '3d'} onChange={setViewMode}
            options={[{ value: '3d', label: <><Box size={14} aria-hidden /><span>3D</span></>, title: T('Vũ trụ 3D', '3D universe') }, { value: 'tree', label: <><ListTree size={14} aria-hidden /><span>{T('Cây', 'Tree')}</span></>, title: T('Cây tri thức', 'Knowledge tree') }]} />
          <div className={s.search} ref={settingsRef}>
            <button className={s.btn} aria-pressed={menu === 'filters'} aria-expanded={menu === 'filters'} aria-haspopup="dialog" data-testid="cosmos-settings" onClick={() => setMenu(m => m === 'filters' ? 'none' : 'filters')} title={T('Hiển thị', 'Display')}><SlidersHorizontal size={15} /><span className="sr-only">{T('Hiển thị', 'Display')}</span></button>
            {menu === 'filters' && <SettingsPanel vi={vi} filters={filters} setFilters={setFilters} quality={qualityChoice} level={qualityLevel} setQuality={chooseQuality}
              view={showTree ? 'tree' : '3d'} setView={setViewMode} webgl={support !== 'none'} onClose={() => setMenu('none')} />}
          </div>
          <button className={s.btn} aria-pressed={menu === 'legend'} onClick={() => setMenu(m => m === 'legend' ? 'none' : 'legend')} title={T('Chú giải', 'Legend')} aria-label={T('Chú giải', 'Legend')}><Info size={15} /></button>
          <button className={s.btn} data-testid="world-display-toggle" data-display={display} aria-pressed={display === 'immersive'} onClick={() => toggleDisplay()}
            title={display === 'immersive' ? T('Thu về giao diện trang web', 'Website layout') : T('Toàn màn hình', 'Full view')}
            aria-label={display === 'immersive' ? T('Thu về giao diện trang web, hiện thanh bên', 'Show inside the website layout, with the sidebar') : T('Mở toàn màn hình ứng dụng', 'Fill the application window')}>
            {display === 'immersive' ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        </div>
      </div>

      {growth && mode === 'explore' && (
        <div className={`${s.panel} ${s.growth}`} role="status" aria-live="polite">
          <span>{T(`+${growth.stars} ngôi sao mới${growth.edges ? ` · ${growth.edges} quan hệ mới` : ''} từ bằng chứng học của bạn`, `+${growth.stars} new star${growth.stars > 1 ? 's' : ''}${growth.edges ? ` · ${growth.edges} new relation${growth.edges > 1 ? 's' : ''}` : ''} from your learning`)}</span>
          <button className={s.btn} onClick={() => { const n = g.nodes[growth.target]; if (n) go(starFocus(n)); setGrowth(null); }}>{T('Xem', 'Show')}</button>
          <button className={`${s.btn} ${s.btnGhost}`} onClick={() => setGrowth(null)} aria-label={T('Đóng', 'Close')}><X size={14} /></button>
        </div>
      )}
      {universe.refreshing && <div className={`${s.panel} ${s.pill}`} style={{ right: 12, left: 'auto' }} role="status">{T('Đang cập nhật vũ trụ…', 'Updating your universe…')}</div>}

      {notice && <div className={`${s.panel} ${s.notice}`} role="status">{notice} <button className={s.why} onClick={() => setNotice('')}>{T('Đóng', 'Close')}</button></div>}

      {menu === 'legend' && <Legend vi={vi} g={g} onClose={() => setMenu('none')} stats={{ stars: knowledgeCount, verified, met: metCount }} />}
      {menu !== 'legend' && mode === 'explore' && !selection && !asking && !showTree && guide.length > 0 && (
        <div className={`${s.bottomLeft} ${guideOpen ? '' : hud.chrome}`} data-hud-chrome={guideOpen ? undefined : 'bottom'}>
          {guideOpen
            ? <GuidePanel vi={vi} g={g} items={guide} run={runGuide} onClose={closeGuide} />
            : <button className={`${s.btn} ${s.guidePill}`} onClick={() => setGuideOpen(true)} data-testid="cosmos-guide-open"><CalendarClock size={15} />{T(`Gợi ý học hôm nay · ${guide.length}`, `Today's suggestions · ${guide.length}`)}</button>}
        </div>
      )}
      {/* The star map: any galaxy one press away from any depth. With the inspector open (a star chosen) it moves to the left. */}
      {!showTree && menu !== 'legend' && mode !== 'replay' && !asking && !(selection && mode === 'mission') && view && (
        <CosmosMap g={g} focus={focus} vi={vi} cam={cam} counts={view.counts.galaxy} onGo={f => { interacted(); go(f); }} className={`${hud.chrome} ${selection ? s.starMapLeft : ''}`} hudEdge={selection ? 'left' : 'right'} />
      )}
      {hint && !showTree && <WorldHint label={T('Cách khám phá vũ trụ', 'How to explore the universe')} closeLabel={T('Đã hiểu', 'Got it')} onClose={dismissHint}
        items={hint === 'first' ? [{ text: T('Kéo để xoay · cuộn để lại gần (tự vào, ra từng tầng)', 'Drag to turn · scroll to come closer (levels follow)') }, { text: T('Bấm vào đám sáng của thiên hà, chòm sao hay ngôi sao để bay tới', 'Press the light of a galaxy, constellation or star to fly there') }, { key: 'Esc', text: T('lùi ra một tầng', 'one level out') }, { key: 'Home', text: T('toàn cảnh', 'overview') }]
          : [{ text: T('Bấm thẳng vào thiên hà, chòm sao hay ngôi sao bạn thấy, hoặc dùng Bản đồ sao ở góc phải', 'Press any galaxy, constellation or star you see, or use the Star map in the corner') }, { key: 'Esc', text: T('lùi ra', 'out') }]} />}

      {mode === 'replay' && timeline && (
        <div className={`${s.panel} ${s.timebar}`}>
          <div className={s.timeRow}>
            <button className={s.btn} onClick={() => { if ((time ?? timeline.end) >= timeline.end) setTime(timeline.start); setPlaying(p => !p); }} aria-label={playing ? T('Tạm dừng', 'Pause') : T('Phát lại', 'Play')}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
            <input type="range" min={timeline.start} max={timeline.end} step={Math.max(1, (timeline.end - timeline.start) / 1000)} value={time ?? timeline.end}
              onChange={e => { setPlaying(false); setTime(Number(e.target.value)); }} aria-label={T('Thời điểm trong hành trình học', 'Point in your learning journey')}
              aria-valuetext={new Date(time ?? timeline.end).toLocaleDateString(vi ? 'vi-VN' : 'en-GB')} />
            <span className={s.timeDate}>{new Date(time ?? timeline.end).toLocaleDateString(vi ? 'vi-VN' : 'en-GB')}</span>
            <span className={s.infoTip} tabIndex={0} role="note" aria-label={T('Chỉ dùng bằng chứng ghi trước thời điểm đã chọn.', 'Only evidence recorded before the chosen moment.')}>
              <Info size={14} aria-hidden /><span className={s.tipText} aria-hidden>{T('Chỉ dùng bằng chứng ghi trước thời điểm đã chọn.', 'Only evidence recorded before the chosen moment.')}</span></span>
          </div>
          {slice && <div className={s.timeNote}>{T(`${slice.counts.stars} ngôi sao · ${slice.counts.edges} quan hệ · ${slice.counts.constellations} chòm sao`, `${slice.counts.stars} stars · ${slice.counts.edges} relations · ${slice.counts.constellations} constellations`)}</div>}
        </div>
      )}

      {asking && mode === 'explore' && <AskCosmos g={g} vi={vi} ask={ask} userId={userId} focusNode={selection?.kind === 'node' ? selection.index : focus.level === 'star' ? focus.node : -1}
        onNode={n => go(starFocus(n))} onEdge={i => { setSelection({ kind: 'edge', index: i }); setWhyEdge(i); }} onClose={() => setAsking(false)} saveWord={saveWord} saving={saving} />}

      {mode === 'mission' && <MissionPanel vi={vi} g={g} userId={userId} onNode={n => go(starFocus(n))} list={missionList} puzzle={puzzle} solved={solved}
        start={p => { setPuzzle(p); setSolved(new Set()); const n = g.nodes[p.words[0]]; go({ level: 'system', galaxy: n.galaxy, constellation: n.constellation, system: n.system, node: -1 }); }}
        onSolve={i => setSolved(prev => new Set(prev).add(i))} exit={() => { setPuzzle(null); setMode('explore'); }} />}

      {selection && <Inspector g={g} senses={senses!} senseLists={universe.senseLists} sel={selection} vi={vi} whyEdge={whyEdge} setWhyEdge={setWhyEdge}
        onNode={n => go(starFocus(n))} onEdge={i => { setSelection({ kind: 'edge', index: i }); setWhyEdge(i); }} onClose={() => setSelection(null)}
        saving={saving} saveWord={saveWord} discover={filters.frontier} setDiscover={v => setFilters(f => ({ ...f, frontier: v }))} />}
    </div>
  );
}

const hasBit = (mask: number, bits: number) => (mask & bits) !== 0;
function starFocus(n: CosmosNode): Focus { return { level: 'star', galaxy: n.galaxy, constellation: n.constellation, system: n.system, node: n.i }; }
function relName(t: RelationType, status: string, vi: boolean) { return status === 'SUGGESTED' ? (vi ? 'gợi ý' : 'suggestion') : vi ? RELATIONS[t].vi : RELATIONS[t].en; }
function kindName(n: CosmosNode, vi: boolean) {
  if (n.kind === 'word') return vi ? 'từ' : 'word';
  if (n.kind === 'grammar') return vi ? 'ngữ pháp' : 'grammar';
  if (n.kind === 'source') return { MY_BOOKS: vi ? 'sách của tôi' : 'my book', READING: vi ? 'bài đọc' : 'reading', LISTENING: vi ? 'bài nghe' : 'listening', WRITING: vi ? 'bài viết' : 'writing', SPEAKING: vi ? 'lời nói' : 'speaking' }[n.sub] ?? n.sub;
  return vi ? 'khái niệm' : 'concept';
}
function sourceHref(n: CosmosNode) {
  const [kind, id] = n.ref.split(':');
  if (kind === 'MY_BOOKS') return '/reading';
  if (kind === 'READING') return `/reading?materialId=${encodeURIComponent(id)}`;
  if (kind === 'LISTENING') return `/listening/${encodeURIComponent(id)}`;
  if (kind === 'WRITING') return '/writing';
  return '/speaking';
}

function SettingsPanel({ vi, filters, setFilters, quality, level, setQuality, view, setView, webgl, onClose }: {
  vi: boolean; filters: Filters; setFilters: (f: Filters) => void; quality: QualityChoice; level: QualityLevel; setQuality: (q: QualityChoice) => void;
  view: ViewMode; setView: (v: ViewMode) => void; webgl: boolean; onClose: () => void;
}) {
  const T = (a: string, b: string) => (vi ? a : b);
  const cats = Object.keys(CATEGORY_LABEL).filter(c => c !== 'suggested') as Category[];
  const Row = ({ id, label, note, swatch, checked, onChange, disabled }: { id: string; label: string; note?: string; swatch?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
    <div className={s.setRow} data-disabled={disabled ? '1' : undefined}>
      <span className={s.setSwatch} aria-hidden style={swatch ? { background: swatch } : undefined} data-empty={swatch ? undefined : '1'} />
      <label htmlFor={id} className={s.setLabel}>{label}{note && <small>{note}</small>}</label>
      <PearlSwitch id={id} checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
  return (
    <div className={`${s.panel} ${s.settings}`} role="dialog" aria-label={T('Hiển thị', 'Display')} data-testid="cosmos-settings-panel">
      <div className={s.setHead}><h3>{T('Hiển thị', 'Display')}</h3><button className={s.close} onClick={onClose} aria-label={T('Đóng', 'Close')}><X size={15} /></button></div>
      <section className={s.setGroup}>
        <h4>{T('Kiểu xem', 'View')}</h4>
        <PearlSegmented<ViewMode> label={T('Kiểu xem', 'View')} value={view} onChange={setView}
          options={[{ value: '3d', label: <><Box size={14} aria-hidden />{T('Vũ trụ 3D', '3D universe')}</> }, { value: 'tree', label: <><ListTree size={14} aria-hidden />{T('Cây tri thức', 'Knowledge tree')}</> }]} />
        {!webgl && <p className={s.setNote}>{T('Thiết bị này không có WebGL: cây tri thức được dùng thay cho 3D.', 'No WebGL on this device: the tree is used instead of 3D.')}</p>}
      </section>
      <section className={s.setGroup}>
        <h4>{T('Lớp tri thức', 'Knowledge layers')}</h4>
        <Row id="cz-layer-learned" label={T('Đã học', 'Learned')} note={T('Thẻ, chủ điểm, bài có bằng chứng học của bạn', 'Cards, topics, lessons with your study evidence')} swatch="radial-gradient(#fff 20%, #38bdf8 55%, transparent 72%)" checked onChange={() => {}} disabled />
        <Row id="cz-layer-met" label={T('Đã gặp', 'Encountered')} note={T('Gặp trong nguồn của bạn, chưa lưu thẻ (sao mờ)', 'Met in your sources, no card yet (dim)')} swatch="radial-gradient(#94a3b8 35%, transparent 60%)" checked={filters.met} onChange={v => setFilters({ ...filters, met: v })} />
        <Row id="cz-layer-discover" label={T('Có thể khám phá', 'Discoverable')} note={T('Từ WordNet nối với từ bạn đang xem, bạn chưa gặp (vòng nét đứt, tối đa 24)', 'WordNet neighbours of what you view, not met yet (dashed, max 24)')} swatch="radial-gradient(transparent 45%, #94a3b8 50%, transparent 66%)" checked={filters.frontier} onChange={v => setFilters({ ...filters, frontier: v })} />
      </section>
      <section className={s.setGroup}>
        <h4>{T('Loại quan hệ', 'Relation types')}</h4>
        {cats.map(c => <Row key={c} id={`cz-cat-${c}`} label={vi ? CATEGORY_LABEL[c].vi : CATEGORY_LABEL[c].en} swatch={CATEGORY_COLOR[c]} checked={filters.categories[c]} onChange={v => setFilters({ ...filters, categories: { ...filters.categories, [c]: v } })} />)}
      </section>
      <section className={s.setGroup}>
        <h4>{T('Nâng cao', 'Advanced')}</h4>
        <Row id="cz-suggest" label={T('Gợi ý khám phá', 'Exploration hints')} note={T('Nét đứt, chưa phải quan hệ đã kiểm chứng', 'Dashed; not verified relations')} swatch="repeating-linear-gradient(90deg,#64748b 0 4px,transparent 4px 8px)" checked={filters.suggestions} onChange={v => setFilters({ ...filters, suggestions: v })} />
        <Row id="cz-senses" label={T('Mọi nghĩa', 'All senses')} note={T('Cả nghĩa hiếm và từ loại khác với thẻ', 'Rare senses and other parts of speech too')} checked={filters.allSenses} onChange={v => setFilters({ ...filters, allSenses: v })} />
      </section>
      <section className={s.setGroup}>
        <h4>{T('Chất lượng hình ảnh', 'Visual quality')}</h4>
        <PearlSegmented<QualityChoice> label={T('Chất lượng hình ảnh', 'Visual quality')} value={quality} onChange={setQuality}
          options={(['auto', ...QUALITY_LEVELS] as QualityChoice[]).map(q => ({ value: q, label: vi ? QUALITY_LABEL[q].vi : QUALITY_LABEL[q].en }))} />
        {quality === 'auto' && <p className={s.setNote}>{T(`Đang dùng: ${QUALITY_LABEL[level].vi}. Tự giảm khi máy chậm.`, `In use: ${QUALITY_LABEL[level].en}. Steps down on a slow device.`)}</p>}
      </section>
    </div>
  );
}

function GuidePanel({ vi, g, items, run, onClose }: { vi: boolean; g: CosmosGraph; items: GuideItem[]; run: (a: GuideAction) => void; onClose: () => void }) {
  const L = (x: [string, string]) => x[vi ? 0 : 1];
  // one suggestion open at a time: the panel stays small over the universe
  const [open, setOpen] = useState(0);
  const Action = ({ a, primary }: { a: GuideAction; primary?: boolean }) => a.kind === 'link'
    ? <Link className={`${s.btn} ${primary ? s.btnPrimary : ''}`} href={a.href}>{L(a.label)}</Link>
    : <button className={`${s.btn} ${primary ? s.btnPrimary : ''}`} onClick={() => run(a)}>{L(a.label)}</button>;
  return (
    <aside className={`${s.panel} ${s.guide}`} aria-label={vi ? 'Gợi ý học hôm nay' : "Today's suggestions"} data-testid="cosmos-guide">
      <div className={s.guideHead}><CalendarClock size={16} aria-hidden /><b>{vi ? 'Gợi ý học hôm nay' : "Today's suggestions"}</b>
        <button className={s.close} onClick={onClose} aria-label={vi ? 'Ẩn gợi ý hôm nay' : 'Hide for today'} title={vi ? 'Ẩn đến mai' : 'Hide until tomorrow'}><X size={14} /></button></div>
      {items.map((it, k) => (
        <div key={it.id} className={s.guideItem} data-guide={it.kind} data-open={k === open ? '1' : '0'}>
          <button className={s.guideTitle} aria-expanded={k === open} onClick={() => setOpen(k)}>{L(it.title)}</button>
          {k === open && <>
            <p className={s.guideWhy}>{L(it.why)}</p>
            {it.nodes.length > 1 && <div className={s.chips}>{it.nodes.map(i => <button key={i} className={s.chipBtn} onClick={() => run({ kind: 'focus', node: i, label: ['', ''] })}>{g.nodes[i].kind === 'grammar' && vi ? g.nodes[i].sub || g.nodes[i].label : g.nodes[i].label}</button>)}</div>}
            <div className={s.actions}><Action a={it.primary} primary />{it.secondary && <Action a={it.secondary} />}</div>
          </>}
        </div>
      ))}
    </aside>
  );
}

const MEMORY_DOT: Record<MemoryState, string> = {
  new: 'radial-gradient(#fff, #a5f3fc 40%, transparent 72%)', recent: 'radial-gradient(#fff 15%, #67e8f9 35%, transparent 45%, #67e8f9 55%, transparent 70%)',
  learning: 'radial-gradient(#fff, #7dd3fc 45%, transparent 70%)', stable: 'radial-gradient(#fff7ed 25%, #fde68a 45%, transparent 62%)',
  fading: 'radial-gradient(#cbd5e1, #64748b 45%, transparent 70%)', atRisk: 'radial-gradient(#94a3b8, #475569 40%, transparent 65%)',
  met: 'radial-gradient(#94a3b8 30%, transparent 55%)', weak: '', mistaken: '',
  renewed: 'radial-gradient(#fff 18%, #a7f3d0 36%, transparent 48%, #6ee7b7 56%, transparent 72%)',
};

function dayOf(t: number, vi: boolean) { return new Date(t).toLocaleDateString(vi ? 'vi-VN' : 'en-GB'); }

function MemoryLine({ n, at, vi }: { n: CosmosNode; at: number; vi: boolean }) {
  const m = memoryOf(n, at);
  const T = (a: string, b: string) => (vi ? a : b);
  const days = m.lastAt > 0 ? Math.max(0, Math.round((at - m.lastAt) / 86400000)) : -1;
  return (
    <div data-memory={m.state} data-cross={m.cross ? '1' : '0'}>
      <p className={s.kicker}>{T('Trạng thái trí nhớ', 'Memory state')}</p>
      <div className={s.chips}><span className={`${s.chip} ${s.chipOn}`}><i className={s.memDot} style={{ background: MEMORY_TONE[m.state] }} aria-hidden />{MEMORY_LABEL[m.state][vi ? 0 : 1]}</span>{m.cross && <span className={s.chip}>{T('Dùng qua nhiều kỹ năng', 'Used across skills')}</span>}</div>
      {n.dueAt > 0 && n.stage !== 'saved' && <p className={s.schedule} data-due={n.dueAt <= at ? '1' : '0'}><CalendarClock size={14} aria-hidden />
        {n.dueAt <= at ? T(`Lịch ôn của Thẻ từ vựng: đến hạn từ ${dayOf(n.dueAt, vi)}.`, `Flashcards schedule: due since ${dayOf(n.dueAt, vi)}.`) : T(`Lần ôn tiếp theo theo lịch Thẻ từ vựng: ${dayOf(n.dueAt, vi)}.`, `Next review on your Flashcards schedule: ${dayOf(n.dueAt, vi)}.`)}
        {n.dueAt <= at && <Link className={s.why} href="/flashcards?review=learned">{T('Ôn ngay', 'Review now')}</Link>}</p>}
      <p className={s.faint}>{MEMORY_WHY[m.state][vi ? 0 : 1]} {days >= 0 && T(`Bằng chứng gần nhất: ${days} ngày trước · ${m.reviews} lần tự chấm · gặp trong ${m.encounters} nguồn.`, `Latest evidence: ${days} day(s) ago · ${m.reviews} rating(s) · met in ${m.encounters} source(s).`)}</p>
    </div>
  );
}

function Legend({ vi, g, onClose, stats }: { vi: boolean; g: CosmosGraph; onClose: () => void; stats: { stars: number; verified: number; met: number } }) {
  const T = (a: string, b: string) => (vi ? a : b);
  return (
    <aside className={`${s.panel} ${s.legend}`} aria-label={T('Chú giải', 'Legend')}>
      <div className={s.setHead}><h3>{T('Chú giải', 'Legend')}</h3><button className={s.close} onClick={onClose} aria-label={T('Đóng', 'Close')}><X size={15} /></button></div>
      {/* the numbers of the universe live here, on demand (not on screen while exploring) */}
      <p className={s.kicker}>{T('Vũ trụ của bạn', 'Your universe')}</p>
      <p className={s.legendFacts} data-testid="cosmos-facts">{T(`${stats.stars} ngôi sao tri thức · ${stats.verified} quan hệ đã kiểm chứng`, `${stats.stars} knowledge stars · ${stats.verified} verified relations`)}
        {stats.met > 0 && T(` · ${stats.met} từ đã gặp trong nguồn (chưa lưu thẻ)`, ` · ${stats.met} words met in your sources (no card)`)}
        {g.truncated.words && T(' · hiển thị 5.000 thẻ mới nhất', ' · showing the newest 5,000 cards')}</p>
      <p className={s.kicker}>{T('Ngôi sao', 'Stars')}</p>
      <div className={s.legendRow}><span className={s.dot} style={{ background: 'radial-gradient(#fff, #7dd3fc 45%, transparent 70%)' }} />{T('Từ, chủ điểm hay bài bạn đã học (sáng hơn = trạng thái thẻ cao hơn)', 'A word, topic or lesson you studied (brighter = higher card status)')}</div>
      <div className={s.legendRow}><span className={s.dot} style={{ background: 'radial-gradient(#fff 20%, #a78bfa 50%, transparent 72%)' }} />{T('Tinh vân ký ức: lần ôn gần nhất bạn chọn Khó', 'Memory nebula: your latest rating was Hard')}</div>
      <div className={s.legendRow}><span className={s.dot} style={{ background: 'radial-gradient(#000 35%, #fbbf24 40%, transparent 60%)' }} />{T('Lỗ đen: ít nhất 3 lần Khó, lần gần nhất cũng Khó', 'Black hole: 3+ Hard ratings, the latest Hard too')}</div>
      <div className={s.legendRow}><span className={s.dot} style={{ border: '2px solid #94a3b8', background: 'transparent' }} />{T('Khái niệm WordNet làm tâm hệ sao (không phải từ bạn đã học)', 'WordNet concept at a system centre (not a word you studied)')}</div>
      <div className={s.legendRow}><span className={s.dot} style={{ border: '2px dashed #64748b', background: 'transparent' }} />{T('Có thể khám phá (bật trong Hiển thị): từ WordNet liên quan bạn chưa gặp', 'Discoverable (turn on in Display): related WordNet words you have not met')}</div>
      <div className={s.legendRow}><span className={s.dot} style={{ border: '2px solid #f59e0b', background: 'radial-gradient(#fff 25%, #7dd3fc 45%, transparent 60%)' }} />{T('Vòng hổ phách: lịch ôn của Thẻ từ vựng đã đến hạn', 'Amber ring: your Flashcards schedule says it is due')}</div>
      <p className={s.kicker}>{T('Trí nhớ (từ bằng chứng của bạn)', 'Memory (from your evidence)')}</p>
      {(['new', 'recent', 'renewed', 'learning', 'stable', 'fading', 'atRisk', 'met'] as MemoryState[]).map(m => <div key={m} className={s.legendRow} title={MEMORY_WHY[m][vi ? 0 : 1]}><span className={s.dot} style={{ background: MEMORY_DOT[m] }} />{MEMORY_LABEL[m][vi ? 0 : 1]}</div>)}
      <div className={s.legendRow}><span className={s.dot} style={{ border: '2px solid #fbbf24', background: 'transparent' }} />{T('Vòng vàng: bạn đã tự dùng từ khi viết, nói và còn học, gặp nó ở kỹ năng khác', 'Gold ring: you used it in your writing or speech and also studied or met it elsewhere')}</div>
      <p className={s.faint}>{T('Ngưỡng 7 / 30 / 90 / 180 ngày là quy tắc hiển thị, không phải dự đoán đường cong quên.', 'The 7 / 30 / 90 / 180-day thresholds are display rules, not a forgetting-curve prediction.')}</p>
      <p className={s.kicker}>{T('Quan hệ', 'Relations')}</p>
      {(Object.keys(CATEGORY_LABEL) as Category[]).map(c => <div key={c} className={s.legendRow}><span className={s.swatch} style={{ background: c === 'suggested' ? 'repeating-linear-gradient(90deg,#e2e8f0 0 4px,transparent 4px 8px)' : CATEGORY_COLOR[c] }} />{vi ? CATEGORY_LABEL[c].vi : CATEGORY_LABEL[c].en}</div>)}
      <p className={s.faint}>{T('Ở xa, nhiều quan hệ giữa hai vùng gộp thành một dải; bấm dải để xem từng quan hệ. Hạt bụi nhỏ và sao nền chỉ để trang trí.', 'From afar, many relations between two regions are one strand; click it to list each one. Fine dust and background stars are decoration only.')}</p>
      <p className={s.faint}>{T('Quan hệ từ vựng: Open English WordNet 2025 (CC BY 4.0). Quan hệ ngữ pháp: danh mục Echo Grammar Academy. Bản đồ: ', 'Lexical relations: Open English WordNet 2025 (CC BY 4.0). Grammar links: Echo Grammar Academy catalog. Map: ')}{g.lexiconVersion}</p>
    </aside>
  );
}

function Inspector({ g, senses, senseLists, sel, vi, whyEdge, setWhyEdge, onNode, onEdge, onClose, saving, saveWord, discover, setDiscover }: {
  g: CosmosGraph; senses: SenseTable; senseLists: Record<string, number[]>; sel: NonNullable<Selection>; vi: boolean; whyEdge: number; setWhyEdge: (i: number) => void;
  onNode: (n: CosmosNode) => void; onEdge: (i: number) => void; onClose: () => void; saving: Record<string, 'saving' | 'saved' | 'error'>; saveWord: (w: string) => void;
  discover: boolean; setDiscover: (v: boolean) => void;
}) {
  const T = (a: string, b: string) => (vi ? a : b);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, [sel]);
  const head = (title: string, kicker: string) => (
    <div className={s.inspectorHead}><div><p className={s.kicker}>{kicker}</p><h2>{title}</h2></div>
      <button ref={closeRef} className={s.close} onClick={onClose} aria-label={T('Đóng', 'Close')}><X size={16} /></button></div>
  );
  const Explain = ({ i }: { i: number }) => {
    const e = g.edges[i], x = explainEdge(g, senses, e, vi);
    return (
      <div className={s.explain} role="note">
        <b>{x.title}{e.status === 'SUGGESTED' ? '' : ` · ${T('đã kiểm chứng', 'verified')}`}</b>
        {x.lines.map((l, k) => <span key={k}>{l}</span>)}
        {x.scopes.map((sc, k) => <span key={k} className={s.scope}>{sc.glossA ? <><b>{sc.a}</b> <em>({sc.posA})</em>: {sc.glossA}<br /></> : null}<b>{sc.b}</b> <em>({sc.posB})</em>: {sc.glossB}</span>)}
        <span className={s.faint}>{T('Cách kiểm chứng', 'Verified by')}: {x.method}. {x.limits}</span>
      </div>
    );
  };
  if (sel.kind === 'edge') {
    const e = g.edges[sel.index];
    return <aside className={`${s.panel} ${s.inspector}`} aria-label={T('Quan hệ', 'Relation')}>{head(`${g.nodes[e.s].label} — ${g.nodes[e.t].label}`, T('Vì sao hai ngôi sao này nối với nhau?', 'Why are these stars linked?'))}
      <div className={s.inspectorBody}><Explain i={sel.index} /><div className={s.actions}><button className={s.btn} onClick={() => onNode(g.nodes[e.s])}>{g.nodes[e.s].label}</button><button className={s.btn} onClick={() => onNode(g.nodes[e.t])}>{g.nodes[e.t].label}</button></div></div></aside>;
  }
  if (sel.kind === 'bundle') {
    const b = sel.bundle, list = b.kind === 'galaxy' ? g.galaxies : g.constellations;
    return <aside className={`${s.panel} ${s.inspector}`} aria-label={T('Dải quan hệ', 'Relation strand')}>{head(`${vi ? list[b.a].vi : list[b.a].en} ↔ ${vi ? list[b.b].vi : list[b.b].en}`, T(`${b.edges.length} quan hệ thật trong dải này`, `${b.edges.length} real relations in this strand`))}
      <div className={s.inspectorBody}><p className={s.faint}>{T('Dải gộp chỉ để màn hình gọn. Không quan hệ nào bị xoá; đây là toàn bộ danh sách.', 'A strand only keeps the screen clean. No relation is removed; this is the full list.')}</p>
        {b.edges.slice(0, 200).map(i => { const e = g.edges[i]; return <div key={i} className={s.rel}><span className={s.relType} style={{ background: CATEGORY_COLOR[e.category] }}>{relName(e.type, e.status, vi)}</span>
          <button className={s.relWord} onClick={() => onNode(g.nodes[e.s])}>{g.nodes[e.s].label}</button>→<button className={s.relWord} onClick={() => onNode(g.nodes[e.t])}>{g.nodes[e.t].label}</button><button className={s.why} onClick={() => onEdge(i)}>{T('Vì sao?', 'Why?')}</button></div>; })}
        {b.edges.length > 200 && <p className={s.faint}>{T(`và ${b.edges.length - 200} quan hệ nữa — lại gần vùng đó để xem.`, `and ${b.edges.length - 200} more — fly closer to see them.`)}</p>}</div></aside>;
  }
  const n = g.nodes[sel.index];
  const mine = g.edges.filter(e => e.s === n.i || e.t === n.i);
  // same rule as the scene: relations in another part of speech than the card's are kept apart (collapsed), never mixed in
  const lexicalAll = mine.filter(e => e.category !== 'source' && e.category !== 'transfer' && e.status === 'VERIFIED');
  const lexical = lexicalAll.filter(e => e.posMatch && e.common);
  const otherPos = lexicalAll.filter(e => !e.posMatch || !e.common);
  const evidence = mine.filter(e => e.category === 'source' || e.category === 'transfer');
  const hard = n.ratings.filter(r => r[1] === 0).length, good = n.ratings.filter(r => r[1] === 1).length, easy = n.ratings.filter(r => r[1] === 2).length;
  const sys = g.systems[n.system];
  return (
    <aside className={`${s.panel} ${s.inspector}`} aria-label={T('Soi ngôi sao', 'Knowledge X-ray')}>
      {head(n.kind === 'grammar' && vi ? n.sub || n.label : n.label, `${kindName(n, vi)} · ${vi ? g.constellations[n.constellation]?.vi ?? '' : g.constellations[n.constellation]?.en ?? ''}`)}
      <div className={s.inspectorBody}>
        {(n.kind === 'word' || n.kind === 'grammar') && <MemoryLine n={n} at={g.generatedAt} vi={vi} />}
        {n.kind === 'word' && <>
          {n.sub && <div><p className={s.kicker}>{T('Nghĩa trên thẻ của bạn', 'Meaning on your card')}</p><span>{n.sub}</span></div>}
          <div className={s.chips}>{n.stage && n.cardIds.length > 0 && <span className={`${s.chip} ${s.chipOn}`} title={STAGE[n.stage][vi ? 2 : 3]}>{STAGE[n.stage][vi ? 0 : 1]}</span>}{n.pos.map(p => <span key={p} className={s.chip}>{(vi ? POS_VI : POS_EN)[p]}</span>)}{n.decks.map(d => <span key={d} className={s.chip}>{d}</span>)}</div>
          {n.stage && n.cardIds.length > 0 && <p className={s.faint}>{STAGE[n.stage][vi ? 2 : 3]}</p>}
          {!n.cardIds.length && <div className={s.actions}><button className={s.btn} disabled={saving[n.label] === 'saving' || saving[n.label] === 'saved'} onClick={() => saveWord(n.label)}>{saving[n.label] === 'saved' ? T('Đã lưu', 'Saved') : T('Lưu Flashcard', 'Save card')}</button></div>}
          <div><p className={s.kicker}>{T('Bằng chứng theo kỹ năng', 'Evidence by skill')}</p><div className={s.chips}>{SKILLS.map(([bit, a, b]) => <span key={bit} className={`${s.chip} ${hasBit(n.skills, bit) ? s.chipOn : ''}`}>{vi ? a : b}</span>)}</div>
            <p className={s.faint}>{T('Sáng = có bằng chứng thật (thẻ, bài đã hoàn thành, bài viết hay lời nói của bạn). Không phải điểm thành thạo.', 'Lit = real evidence (card, completed lesson, your writing or speech). Not a mastery score.')}</p></div>
          {n.ratings.length > 0 && <div><p className={s.kicker}>{T('Các lần bạn tự chấm khi ôn', 'Your own review ratings')}</p><span>{T(`Khó ${hard} · Tốt ${good} · Dễ ${easy}`, `Hard ${hard} · Good ${good} · Easy ${easy}`)}</span>
            {n.gap ? <p className={s.muted}>{T('Lỗ đen kiến thức: bạn chọn Khó nhiều lần, kể cả lần gần nhất. Ôn lại trong Thẻ từ vựng sẽ làm nó sáng lên.', 'Knowledge black hole: you chose Hard several times, including the latest. Reviewing in Flashcards lights it up.')}</p>
              : n.weak ? <p className={s.muted}>{T('Tinh vân ký ức: lần ôn gần nhất bạn chọn Khó.', 'Memory nebula: your latest rating was Hard.')}</p> : null}</div>}
          {(senseLists[n.label]?.length ?? 0) > 0 && <div><p className={s.kicker}>{T('Các nghĩa trong WordNet (tiếng Anh, không gộp)', 'WordNet senses (English, never merged)')}</p>
            {senseLists[n.label].slice(0, 8).map((sn, k) => <div key={sn} className={s.sense}><b>{k + 1}.</b><span><em className={s.faint}>{(vi ? POS_VI : POS_EN)[senses[sn]?.[1] ?? 'n']}</em> {senses[sn]?.[2]}</span></div>)}
            <p className={s.faint}>{T('Ngôi sao được đặt theo nghĩa thông dụng nhất của từ loại trên thẻ; điều đó không khẳng định bạn học nghĩa nào.', 'The star is placed by the most common sense of the card’s part of speech; that does not claim which sense you learned.')}</p></div>}
          <div className={s.actions}>
            <button className={s.btn} onClick={() => window.dispatchEvent(new CustomEvent('ec:dictionary:lookup', { detail: { word: n.label } }))}><BookOpen size={15} />{T('Tra trong Từ điển', 'Open in dictionary')}</button>
            <button className={s.btn} onClick={() => speak(n.label)}><Volume2 size={15} />{T('Nghe', 'Listen')}</button>
            <Link className={s.btn} href="/flashcards">{T('Ôn trong Thẻ từ vựng', 'Review in Flashcards')}</Link>
          </div>
        </>}
        {n.kind === 'grammar' && <>
          <span className={s.muted}>{vi ? n.label : n.sub}</span>
          <div className={s.chips}>{n.stage && <span className={`${s.chip} ${s.chipOn}`}>{STAGE[n.stage][vi ? 0 : 1]}</span>}{n.weak && <span className={s.chip}>{T('Cần ôn lại', 'Needs review')}</span>}</div>
          {n.stage && <p className={s.faint}>{STAGE[n.stage][vi ? 2 : 3]}</p>}
          <div className={s.actions}><Link className={s.btn} href={`/grammar/topics/${encodeURIComponent(n.ref)}`}>{T('Mở chủ điểm', 'Open topic')}</Link></div>
        </>}
        {n.kind === 'source' && <>
          <span className={s.muted}>{kindName(n, vi)} · {new Date(n.discoveredAt).toLocaleDateString(vi ? 'vi-VN' : 'en-GB')}</span>
          <div className={s.actions}><Link className={s.btn} href={sourceHref(n)} onClick={() => { if (n.sub === 'MY_BOOKS') { try { localStorage.setItem('readingActiveTab', 'mybooks'); } catch { /* optional */ } } }}>{T('Mở lại', 'Open')}</Link></div>
          {n.sub === 'MY_BOOKS' && <p className={s.faint}>{T('Sách và đoạn đánh dấu chỉ nằm trên thiết bị này; vũ trụ đọc chúng tại chỗ, không gửi lên máy chủ.', 'Books and highlights stay on this device; the universe reads them here and sends nothing.')}</p>}
        </>}
        {n.kind === 'concept' && <>
          <span className={s.muted}>{n.sub}</span>
          <p className={s.faint}>{T(`Khái niệm chung trong WordNet mà ${Math.max(0, (sys?.count ?? 1) - 1)} từ của bạn cùng thuộc về. Nó là tâm của hệ sao, không phải một từ bạn đã học.`, `A WordNet concept that ${Math.max(0, (sys?.count ?? 1) - 1)} of your words belong to. It is the centre of this system, not a word you studied.`)}</p>
        </>}
        {lexical.length > 0 && <div><p className={s.kicker}>{T(`Quan hệ (${lexical.length})`, `Relations (${lexical.length})`)}</p>
          {lexical.slice(0, 60).map(e => { const other = g.nodes[e.s === n.i ? e.t : e.s]; const dir = RELATIONS[e.type].directed && e.t === n.i && e.status === 'VERIFIED' ? (vi ? RELATIONS[e.type].inverseVi : RELATIONS[e.type].inverseEn) : null; return <div key={e.i}>
            <div className={s.rel}><span className={s.relType} style={{ background: CATEGORY_COLOR[e.category] }}>{dir ?? relName(e.type, e.status, vi)}</span>
              <button className={s.relWord} onClick={() => onNode(other)}>{other.kind === 'grammar' && vi ? other.sub || other.label : other.label}</button>
              <button className={s.why} aria-expanded={whyEdge === e.i} onClick={() => setWhyEdge(whyEdge === e.i ? -1 : e.i)}>{T('Vì sao?', 'Why?')}</button></div>
            {whyEdge === e.i && <Explain i={e.i} />}</div>; })}</div>}
        {otherPos.length > 0 && <details><summary className={s.faint}>{T(`Quan hệ ở nghĩa hiếm hoặc từ loại khác với thẻ (${otherPos.length})`, `Relations in rare senses or another part of speech (${otherPos.length})`)}</summary>
          {otherPos.slice(0, 30).map(e => { const other = g.nodes[e.s === n.i ? e.t : e.s]; return <div key={e.i}><div className={s.rel}><span className={s.relType} style={{ background: CATEGORY_COLOR[e.category] }}>{relName(e.type, e.status, vi)}</span>
            <button className={s.relWord} onClick={() => onNode(other)}>{other.label}</button><button className={s.why} onClick={() => setWhyEdge(whyEdge === e.i ? -1 : e.i)}>{T('Vì sao?', 'Why?')}</button></div>{whyEdge === e.i && <Explain i={e.i} />}</div>; })}</details>}
        {evidence.length > 0 && <div><p className={s.kicker}>{T(`Trong nguồn học (${evidence.length})`, `In your sources (${evidence.length})`)}</p>
          {evidence.slice(0, 40).map(e => { const other = g.nodes[e.s === n.i ? e.t : e.s]; return <div key={e.i}><div className={s.rel}><span className={s.relType} style={{ background: CATEGORY_COLOR[e.category] }}>{relName(e.type, e.status, vi)}</span>
            <button className={s.relWord} onClick={() => onNode(other)}>{other.label}</button><button className={s.why} onClick={() => setWhyEdge(whyEdge === e.i ? -1 : e.i)}>{T('Vì sao?', 'Why?')}</button></div>{whyEdge === e.i && <Explain i={e.i} />}</div>; })}</div>}
        {n.kind === 'word' && n.frontier.length > 0 && <div><p className={s.kicker}>{T('Ngôi sao chưa học ngay cạnh', 'Unlearned stars right next to it')}</p>
          {n.frontier.map(f => <div key={f.lemma} className={s.rel}><span className={s.relType} style={{ background: CATEGORY_COLOR[RELATIONS[f.type].category] }}>{vi ? RELATIONS[f.type].vi : RELATIONS[f.type].en}</span><span>{f.lemma}</span>
            <span className={s.faint} title={senses[f.sense]?.[2]}>{senses[f.sense]?.[2]?.slice(0, 48)}</span>
            <button className={s.why} disabled={saving[f.lemma] === 'saving' || saving[f.lemma] === 'saved'} onClick={() => saveWord(f.lemma)}>{saving[f.lemma] === 'saved' ? T('Đã lưu', 'Saved') : saving[f.lemma] === 'error' ? T('Thử lại', 'Retry') : T('Lưu Flashcard', 'Save card')}</button></div>)}
          <div className={s.setRow}><span className={s.setSwatch} aria-hidden style={{ background: 'radial-gradient(transparent 45%, #94a3b8 50%, transparent 66%)' }} />
            <label htmlFor="cz-insp-discover" className={s.setLabel}>{T('Hiện quanh ngôi sao (lớp Có thể khám phá)', 'Show around the star (Discoverable layer)')}</label>
            <PearlSwitch id="cz-insp-discover" checked={discover} onChange={setDiscover} label={T('Lớp Có thể khám phá', 'Discoverable layer')} /></div>
          <p className={s.faint}>{T('Lưu thẻ chỉ khi bạn bấm; ngôi sao mới xuất hiện ở lần mở sau.', 'A card is saved only when you click; the new star appears next time.')}</p></div>}
        <p className={s.faint}>{T('Nguồn quan hệ', 'Relation sources')}: {METHOD_LABEL.OEWN_SYNSET[vi ? 'vi' : 'en'].split(':')[0]} 2025 (CC BY 4.0) · {COSMOS_LEXICON_VERSION}</p>
      </div>
    </aside>
  );
}

function MissionPanel({ vi, g, userId, onNode, list, puzzle, solved, start, onSolve, exit }: { vi: boolean; g: CosmosGraph; userId: string; onNode: (n: CosmosNode) => void; list: Puzzle[]; puzzle: Puzzle | null; solved: Set<number>; start: (p: Puzzle) => void; onSolve: (edge: number) => void; exit: () => void }) {
  const T = (a: string, b: string) => (vi ? a : b);
  const [a, setA] = useState(-1), [b, setB] = useState(-1), [type, setType] = useState<RelationType>('SYNONYM_OF');
  const [result, setResult] = useState('');
  const pick = (w: number) => { if (a < 0 || (a >= 0 && b >= 0)) { setA(w); setB(-1); } else if (w !== a) setB(w); setResult(''); };
  const types: RelationType[] = ['SYNONYM_OF', 'SIMILAR_TO', 'ANTONYM_OF', 'HYPERNYM_OF', 'PART_OF', 'DERIVED_FORM'];
  // Cross-skill missions: completion only from server evidence recorded after the mission started (missions.ts).
  const [skill, setSkill] = useState<SkillMission[]>(() => (userId ? readMissions(userId) : []));
  const [target, setTarget] = useState<MissionTarget>('WRITING');
  const states = skill.map(m => missionState(g, m));
  const candidates = missionCandidates(g, target).filter(i => !skill.some(m => m.word === g.nodes[i].label && m.target === target)).slice(0, 4);
  const startSkill = (i: number) => { const next = [...skill, { word: g.nodes[i].label, target, startedAt: Date.now() }]; setSkill(next); writeMissions(userId, next); };
  const dropSkill = (k: number) => { const next = skill.filter((_, j) => j !== k); setSkill(next); writeMissions(userId, next); };
  const TARGET_LABEL: Record<MissionTarget, [string, string, string]> = { WRITING: ['Viết', 'Write', '/writing'], SPEAKING: ['Nói', 'Speak', '/speaking'], LISTENING: ['Nghe', 'Listen', '/listening'], READING: ['Đọc', 'Read', '/reading'] };
  if (!puzzle) return (
    <aside className={`${s.panel} ${s.mission}`} aria-label={T('Thử thách', 'Missions')}>
      <h3>{T('Nối lại chòm sao', 'Rebuild a constellation')}</h3>
      <p className={s.muted}>{T('Một số quan hệ đã kiểm chứng bị ẩn. Chọn hai từ và loại quan hệ để nối lại. Đây là luyện tập: không chấm điểm, không cộng thành thạo.', 'Some verified relations are hidden. Pick two words and the relation type to link them again. Practice only: no score, no mastery.')}</p>
      {list.length === 0 && <p className={s.faint}>{T('Chưa có hệ sao nào đủ quan hệ để chơi. Học thêm vài từ cùng chủ đề nhé.', 'No star system has enough relations yet. Learn a few more words on one topic.')}</p>}
      {list.map((p, i) => <button key={i} className={s.btn} onClick={() => start(p)}>{p.words.slice(0, 4).map(w => g.nodes[w].label).join(', ')}{p.words.length > 4 ? '…' : ''} · {p.answers.length}</button>)}
      <h3>{T('Nhiệm vụ đa kỹ năng', 'Cross-skill missions')}</h3>
      <p className={s.muted}>{T('Dùng một từ bạn đã học ở kỹ năng nó chưa có bằng chứng. Nhiệm vụ chỉ hoàn thành khi máy chủ ghi nhận: một bài viết, lời nói hay bài đã hoàn thành SAU khi bắt đầu nhiệm vụ có chứa từ đó. Mở trang không tính.', 'Use a word you studied in a skill where it has no evidence yet. A mission completes only when the server records it: writing, speech or a completed lesson AFTER the mission started that contains the word. Opening a page does not count.')}</p>
      <div className={s.chips} role="radiogroup" aria-label={T('Kỹ năng', 'Skill')}>{(Object.keys(TARGET_LABEL) as MissionTarget[]).map(k => <button key={k} className={s.wordBtn} role="radio" aria-checked={target === k} aria-pressed={target === k} onClick={() => setTarget(k)}>{TARGET_LABEL[k][vi ? 0 : 1]}</button>)}</div>
      {candidates.length > 0 ? candidates.map(i => <div key={i} className={s.missionRow}><b>{g.nodes[i].label}</b><span className={s.faint}>{g.nodes[i].sub}</span><button className={s.why} onClick={() => startSkill(i)}>{T('Nhận nhiệm vụ', 'Start')}</button></div>)
        : <p className={s.faint}>{T('Không còn từ đã học nào thiếu bằng chứng ở kỹ năng này.', 'No studied word lacks evidence in this skill.')}</p>}
      {states.length > 0 && <div data-testid="skill-missions">{states.map((st, k) => <div key={k} className={s.missionRow} data-done={st.done ? '1' : '0'}>
        <span className={st.done ? s.good : s.muted}>{st.done ? T('Đã hoàn thành', 'Done') : T('Đang làm', 'Open')}</span>
        <b>{st.mission.word}</b><span className={s.faint}>· {TARGET_LABEL[st.mission.target][vi ? 0 : 1]}</span>
        {st.done && st.evidence >= 0 ? <button className={s.why} onClick={() => onNode(g.nodes[st.evidence])}>{T('Xem bằng chứng', 'Show evidence')}</button>
          : <Link className={s.why} href={TARGET_LABEL[st.mission.target][2]}>{TARGET_LABEL[st.mission.target][vi ? 0 : 1]}</Link>}
        <button className={s.why} onClick={() => dropSkill(k)} aria-label={T('Bỏ nhiệm vụ', 'Remove mission')}>×</button></div>)}</div>}
      <button className={`${s.btn} ${s.btnGhost}`} onClick={exit}>{T('Thoát', 'Exit')}</button>
    </aside>
  );
  const done = puzzle.answers.filter(x => solved.has(x.edge)).length;
  return (
    <aside className={`${s.panel} ${s.mission}`} aria-label={T('Thử thách', 'Mission')}>
      <h3>{T(`Đã nối ${done}/${puzzle.answers.length}`, `Linked ${done}/${puzzle.answers.length}`)}</h3>
      <div className={s.chips}>{puzzle.words.map(w => <button key={w} className={s.wordBtn} aria-pressed={w === a || w === b} onClick={() => pick(w)}>{g.nodes[w].label}</button>)}</div>
      <label className={s.check}>{T('Quan hệ', 'Relation')}
        <select className={s.select} value={type} onChange={e => setType(e.target.value as RelationType)}>{types.map(t => <option key={t} value={t}>{vi ? RELATIONS[t].vi : RELATIONS[t].en}{RELATIONS[t].directed ? ` (${T('từ đầu tiên là khái niệm rộng hơn / toàn thể', 'first word = broader / whole')})` : ''}</option>)}</select></label>
      <button className={s.btn} disabled={a < 0 || b < 0} onClick={() => {
        // for directed types the learner's first word is the broader concept / the whole
        const [x, y] = type === 'PART_OF' ? [b, a] : [a, b];
        const r = check(puzzle, x, y, type);
        if (r === 'correct') { const hit = puzzle.answers.find(h => h.type === type && ((h.s === x && h.t === y) || (!RELATIONS[type].directed && h.s === y && h.t === x))); if (hit) onSolve(hit.edge); setResult('good'); }
        else setResult(r);
        setA(-1); setB(-1);
      }}>{T('Nối', 'Link')}</button>
      {result === 'good' && <p className={s.good}>{T('Đúng: quan hệ này có trong WordNet.', 'Correct: WordNet states this relation.')}</p>}
      {result === 'wrong-type' && <p className={s.bad}>{T('Hai từ này có liên hệ, nhưng không phải loại (hoặc chiều) bạn chọn.', 'These words are related, but not by the type (or direction) you chose.')}</p>}
      {result === 'no-relation' && <p className={s.bad}>{T('Không có quan hệ đã kiểm chứng nào giữa hai từ này.', 'There is no verified relation between these two words.')}</p>}
      <button className={`${s.btn} ${s.btnGhost}`} onClick={exit}>{T('Kết thúc', 'Finish')}</button>
    </aside>
  );
}

function speak(word: string) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.dispatchEvent(new Event('ec:music-pause'));
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(word); u.lang = 'en-US'; u.rate = 0.9;
    window.speechSynthesis.speak(u);
  } catch { /* optional */ }
}
