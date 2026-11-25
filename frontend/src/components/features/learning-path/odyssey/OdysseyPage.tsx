'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import useSWR from 'swr';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Anchor, ArrowLeft, ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, Compass, Eye, EyeOff, Flag, Globe2, HelpCircle, Layers, Loader2, LockKeyhole, Map as MapIcon, Maximize2, Minimize2, Navigation, Play, RotateCcw, Search, Settings2, ShieldCheck, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { odysseyApi } from '@/lib/odyssey/api';
import { grammarApi } from '@/services/grammarApi';
import type { Catalog } from '@/types/grammar';
import { launchHref, returnHref, saveContext, takeGateSnapshot, withWritingResume } from '@/lib/odyssey/navigation';
import { goalLabel, reasonLabel, skillLabel, taskTitle } from '@/lib/learning-path/model';
import { placementQuizStore } from '@/lib/leaderboard/placementQuizStore';
import { guideBusy, startGuide, subscribeGuide } from '@/lib/guide/store';
import { useWorldDisplay } from '@/lib/ui/worldDisplay';
import { useCinematicHud, useWorldHint } from '@/lib/ui/cinematicHud';
import { WorldHint } from '@/components/ui/hud/WorldHint';
import hud from '@/components/ui/hud/cinematicHud.module.css';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import type { LaunchMode, Navigation as NavState, RegionDetail, Reward, Station, World, WorldMetrics } from '@/lib/odyssey/types';
import { CHOICES, CHOICE_LABEL, TIER_LABEL, readGraphicsChoice, saveGraphicsChoice, type GraphicsChoice, type PlanetTier } from '@/lib/odyssey/graphics';
import type { TierState } from './planet/PlanetWorld';
import type { RegionKind } from './planet/world';
import s from './odyssey.module.css';
import pg from '@/components/ui/pearl/pearlGlass.module.css';
import JourneyAtlas, { nodeState, type AtlasTab } from './JourneyAtlas';
import { learningRoutes, recommendation, ready, passed } from '@/lib/odyssey/progression';
const WorldCanvas = dynamic(() => import('./WorldCanvas'), { ssr: false, loading: () => <div className={s.loadingOcean}>Echo Odyssey…</div> });
const EMPTY: Station[] = [];
const keyFor = (account: string) => ['odyssey/world', account];
const word = (x: { vi: string; en: string }, vi: boolean) => vi ? x.vi : x.en;
function stationTitle(station: Station, vi: boolean) { return station.task ? taskTitle(station.task, vi ? 'vi' : 'en') : word(station.title, vi); }
const STATES: Record<string, [string, string]> = {
  NOT_STARTED: ['Chưa học', 'Not started'], STUDIED: ['Đã xem bài', 'Studied'], PRACTISING: ['Đang luyện', 'Practising'],
  CHECK_PASSED: ['Đã vượt kiểm tra', 'Check passed'], REVIEW_DUE: ['Đến hạn ôn', 'Review due'], REMEDIATION: ['Cần luyện lại', 'Practice needed'],
  OPEN: ['Chưa hoàn thành', 'In progress'], DONE: ['Đã hoàn thành', 'Completed'], AVAILABLE: ['Khám phá tự do', 'Free exploration'],
};
const statusText = (status: string, vi: boolean) => (STATES[status] || [status, status])[vi ? 0 : 1];
function message(error: unknown, vi: boolean) {
  const code = (error as { response?: { data?: { code?: string; error?: string } } })?.response?.data?.code;
  if (code === 'COMPETENCY_REQUIRED') return vi ? 'Hãy kiểm tra kiến thức nền hoặc làm bài thử thách để vào nhánh này.' : 'Check the prerequisite concepts or pass a challenge to enter this branch.';
  if (code === 'RATE_LIMITED') return vi ? 'Bạn đã thao tác nhiều lần. Hãy thử lại sau.' : 'Too many requests. Please try again later.';
  return vi ? 'Chưa lưu được thao tác. Kết quả học đã lưu vẫn được giữ; hãy thử lại.' : 'This action could not be saved. Saved learning results are kept; please retry.';
}

export default function OdysseyPage() {
  const { locale } = useLanguage(), vi = locale !== 'en'; const router = useRouter(), query = useSearchParams();
  const { data: session } = useSession(); const account = session?.user ? String((session.user as { id?: string | number }).id || session.user.email || '') : '';
  const { data: world, error, mutate, isLoading } = useSWR<World>(account ? keyFor(account) : null, odysseyApi.world,
    { dedupingInterval: 0, revalidateOnMount: true, revalidateOnFocus: true, focusThrottleInterval: 30000, shouldRetryOnError: false });
  // Immersive (default) or inside the website layout; the frame switches around this page without remounting it.
  const [display, toggleDisplay] = useWorldDisplay('odyssey');
  const [region, setRegion] = useState<string | null>(query.get('region'));
  const [selected, setSelected] = useState<string | null>(query.get('station'));
  const [drawerOpen, setDrawerOpen] = useState(!!query.get('region')); 
  // The journey atlas: a large centred map of the path (goal and journal are its other tabs).
  const [atlasOpen, setAtlasOpen] = useState(false), [atlasTab, setAtlasTab] = useState<AtlasTab>('map');
  const openAtlas = (tab: AtlasTab) => { setAtlasTab(tab); setAtlasOpen(true); setTravelOpen(false); };
  // ONE graphics control: Auto (default; adapts to measured frames) or a tier the learner keeps until they change it.
  const [graphics, setGraphics] = useState<GraphicsChoice>('auto');
  const [tierState, setTierState] = useState<TierState | null>(null);
  const heavyTold = useRef(false);
  useEffect(() => { setGraphics(readGraphicsChoice()); }, []);
  const onAutoChange = useCallback((direction: 'down' | 'up', tier: PlanetTier) => {
    if (direction === 'down') setNotice(vi ? `Tự động đã hạ đồ họa xuống mức ${TIER_LABEL[tier].vi} để hành tinh chạy mượt trên máy này.` : `Auto lowered the graphics to ${TIER_LABEL[tier].en} so the planet runs smoothly on this device.`);
  }, [vi]);
  const onHeavy = useCallback(() => {
    if (heavyTold.current) return; heavyTold.current = true;
    setNotice(vi ? 'Mức đồ họa bạn chọn đang nặng với máy này. Chọn “Tự động” để máy tự cân bằng, hoặc một mức thấp hơn.' : 'The graphics level you chose is heavy for this device. Choose “Auto” to balance it automatically, or a lower level.');
  }, [vi]);
  const [lightweight, setLightweight] = useState(query.get('render') === 'light');
  const [travelOpen, setTravelOpen] = useState(false);
  const [filter, setFilter] = useState(''), [domain, setDomain] = useState(''), [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [celebration, setCelebration] = useState<Reward[]>([]);
  const [metrics, setMetrics] = useState<WorldMetrics | null>(null);
  const initialized = useRef(''), request = useRef<{ key: string; id: string } | null>(null), navigationQueue = useRef(Promise.resolve());
  const quiz = useSyncExternalStore(placementQuizStore.subscribe, placementQuizStore.getSnapshot, placementQuizStore.getSnapshot), wasQuizOpen = useRef(false);
  const { data: detail, error: detailError, isLoading: detailLoading, mutate: refreshDetail } = useSWR<RegionDetail>(account && region ? ['odyssey/region', account, region] : null,
    () => odysseyApi.region(region!), { revalidateOnMount: true, revalidateOnFocus: false, dedupingInterval: 0, shouldRetryOnError: false });
  const { data: grammarCatalog } = useSWR<Catalog>(world ? ['grammar-catalog'] : null, grammarApi.catalog, { revalidateOnFocus: false, dedupingInterval: 60000, shouldRetryOnError: false });
  const graphFetchedHere = useRef(false);
  const { data: graph, error: graphError, isValidating: graphValidating, mutate: refreshGraph } = useSWR<RegionDetail[]>(world && account ? ['odyssey/graph', account] : null,
    async () => { const output: RegionDetail[] = []; for (let i = 0; i < world!.regions.length; i += 4) output.push(...await Promise.all(world!.regions.slice(i, i + 4).map(r => odysseyApi.region(r.region.id)))); graphFetchedHere.current = true; return output; },
    { dedupingInterval: 0, revalidateOnMount: true, revalidateOnFocus: true, focusThrottleInterval: 30000, shouldRetryOnError: false });
  const next = world ? recommendation(world) : null;
  const current = world?.activeLaunch?.regionId || world?.navigation.regionId || next?.regionId || null;
  const routes = useMemo(() => world ? learningRoutes(world, graph || []) : [], [world, graph]);
  const regionStates = useMemo(() => Object.fromEntries((world?.regions || []).map(({region: r, passed: checks, reviewDue}) => {
    const topics = graph?.find(d => d.region.id === r.id)?.stations.filter(v => v.kind === 'GRAMMAR') || [];
    return [r.id, r.id === next?.regionId ? (vi ? 'Điểm đến tiếp theo' : 'Next destination') : r.id === current ? (vi ? 'Bạn đang ở đây' : 'You are here') : reviewDue ? (vi ? 'Đến hạn ôn' : 'Review due') : topics.length && topics.every(passed) ? (vi ? 'Đã vượt kiểm tra' : 'Checks passed') : topics.some(v => !ready(v)) ? (vi ? 'Có nhánh thử thách' : 'Challenge branches') : checks ? (vi ? 'Đã có minh chứng' : 'Evidence recorded') : (vi ? 'Có thể học' : 'Available')];
  })), [world, graph, next?.regionId, current, vi]);
  // The same facts as the labels above, as a visual kind for beacons and label colours (never a new academic state).
  const regionKinds = useMemo(() => Object.fromEntries((world?.regions || []).map(({ region: r, passed: checks, reviewDue }) => {
    const topics = graph?.find(d => d.region.id === r.id)?.stations.filter(v => v.kind === 'GRAMMAR') || [];
    const kind: RegionKind = r.id === next?.regionId ? 'next' : r.id === current ? 'here' : reviewDue ? 'review' : topics.length && topics.every(passed) ? 'done' : topics.some(v => !ready(v)) ? 'challenge' : checks ? 'evidence' : 'open';
    return [r.id, kind];
  })) as Record<string, RegionKind>, [world, graph, next?.regionId, current]);
  const gateSnapshot = useRef<globalThis.Map<string, boolean> | null>(null);
  const [unlocked, setUnlocked] = useState<Station[]>([]);
  useEffect(() => {
    if (!graph || !graphFetchedHere.current || graphValidating || graphError) return;
    const topics = graph.flatMap(d => d.stations.filter(v => v.kind === 'GRAMMAR'));
    const previous = gateSnapshot.current;
    const beforeLaunch = new Set(takeGateSnapshot(account));
    const newlyReady = topics.filter(v => (previous?.get(v.id) === false || beforeLaunch.has(v.id)) && ready(v));
    if (newlyReady.length) setUnlocked(newlyReady);
    gateSnapshot.current = new globalThis.Map(topics.map(v => [v.id, ready(v)]));
  }, [graph, graphValidating, graphError, account]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      if (drawerOpen || travelOpen) { setDrawerOpen(false); setTravelOpen(false); } else router.push('/learning-path?view=list'); };
    addEventListener('keydown', escape); return () => removeEventListener('keydown', escape);
  }, [drawerOpen, travelOpen, router]);
  const topicTitles = useMemo(() => new globalThis.Map(grammarCatalog?.domains.flatMap(d => d.topics.map(t => [t.slug, t.title] as const)) || []), [grammarCatalog]);
  useEffect(() => {
    if (!world || initialized.current === account) return; initialized.current = account;
    const id = query.get('region') || (world.navigation.viewMode === 'REGION' ? world.navigation.regionId : null);
    setRegion(world.regions.some(r => r.region.id === id) ? id : null);
    setSelected(query.get('station') || world.navigation.stationId);
  }, [world, account, query]);
  useEffect(() => { if (world?.newlyGranted.length) setCelebration(world.newlyGranted); }, [world]);
  useEffect(() => {
    if (wasQuizOpen.current && !quiz.open) { void mutate(); void refreshDetail(); void refreshGraph(); }
    wasQuizOpen.current = quiz.open;
  }, [quiz.open, mutate, refreshDetail, refreshGraph]);
  useEffect(() => {
    if (query.get('placement') !== '1') return;
    const url = new URL(location.href); url.searchParams.delete('placement'); history.replaceState(null, '', url);
    placementQuizStore.open(vi ? 'vi' : 'en');
  }, [query, vi]);
  useEffect(() => {
    const onPop = () => { const q = new URLSearchParams(location.search); setRegion(q.get('region')); setSelected(q.get('station')); setDomain(''); setPage(0); };
    addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop);
  }, []);
  const regions = useMemo(() => world?.regions.map(r => r.region) || [], [world?.regions]);
  const discovered = useMemo(() => world?.explored.map(r => r.regionId) || [], [world?.explored]);
  const stations = useMemo(() => {
    const source = region ? detail?.stations || EMPTY : world?.recommendations || EMPTY;
    return source.filter(t => (!domain || t.domain === domain) && (!filter || stationTitle(t, vi).toLocaleLowerCase().includes(filter.toLocaleLowerCase())));
  }, [region, detail, world?.recommendations, domain, filter, vi]);
  const shown = useMemo(() => stations.slice(page * 10, page * 10 + 10), [stations, page]);
  const chosen = (detail?.stations || EMPTY).find(s => s.id === selected) || world?.recommendations.find(s => s.id === selected);
  const questRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (chosen && drawerOpen) questRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [chosen?.id, drawerOpen]);
  const currentRegion = regions.find(r => r.id === region);
  const regionFacts = world?.regions.find(r => r.region.id === region) ?? null;
  const queueNavigation = useCallback((id: string, station: string | null, mode: 'ATLAS' | 'REGION') => {
    navigationQueue.current = navigationQueue.current.catch(() => {}).then(async () => { await odysseyApi.navigate(id, station, mode); }).catch(e => setNotice(message(e, vi)));
  }, [vi]);
  const visit = useCallback((id: string, station: string | null = null) => {
    if (!regions.some(r => r.id === id)) return;
    setRegion(id); setSelected(station); setDrawerOpen(true); setTravelOpen(false); setDomain(''); setPage(0); setFilter('');
    history.pushState(null, '', returnHref(id, station) + (lightweight ? '&render=light' : '')); queueNavigation(id, station, 'REGION');
    void odysseyApi.discover(id).then(explored => mutate(w => w ? { ...w, explored } : w, { revalidate: false })).catch(e => setNotice(message(e, vi)));
  }, [regions, queueNavigation, mutate, vi, lightweight]);
  const select = useCallback((id: string) => { setDrawerOpen(true); setSelected(id); if (region) { history.replaceState(null, '', returnHref(region, id) + (lightweight ? '&render=light' : '')); queueNavigation(region, id, 'REGION'); } }, [region, queueNavigation, lightweight]);
  const atlas = () => { setRegion(null); setSelected(null); setDomain(''); setPage(0); setFilter(''); history.pushState(null, '', '/learning-path?view=odyssey' + (lightweight ? '&render=light' : '')); queueNavigation(region || 'harbor', null, 'ATLAS'); };
  const setLight = (value: boolean) => { setLightweight(value); const url = new URL(location.href); if(value)url.searchParams.set('render','light');else url.searchParams.delete('render');history.replaceState(null,'',url); };
  // The Adaptive Cinematic HUD: the controls show on entry, give the planet the screen while it is explored, and come back
  // together near an edge or a control, on keyboard focus, or from the puck. Held while a list, the atlas or the quiz is open.
  const pageRef = useRef<HTMLDivElement>(null);
  const touring = useSyncExternalStore(subscribeGuide, guideBusy, () => false); // a guide points at the controls: they stay
  const { state: hudState, shown: hudShown, reveal, conceal } = useCinematicHud(pageRef, { hold: travelOpen || atlasOpen || quiz.open || touring, enabled: !!world });
  const { hint, dismiss: dismissHint, missed, interacted } = useWorldHint('odyssey', !!world && !lightweight);
  const onTouch = useCallback((found: boolean) => { interacted(); if (!found) missed(); }, [interacted, missed]);
  const launch = async (station: Station, mode: LaunchMode = 'LEARN') => {
    if (busy || !account) return; setBusy(true); setNotice('');
    const key = `${station.id}:${mode}`; if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    try {
      const result = withWritingResume(account, await odysseyApi.launch(request.current.id, station.id, mode)); const href = launchHref(result);
      if (!href) throw new Error('INVALID_DESTINATION'); saveContext(account, result, lightweight, graph?.flatMap(d => d.stations.filter(v => !ready(v)).map(v => v.id))); request.current = null;
      if (station.kind === 'PLACEMENT') { placementQuizStore.open(vi ? 'vi' : 'en'); }
      else router.push(href);
    } catch (e) { setNotice(message(e, vi)); } finally { setBusy(false); }
  };
  if (!world) return <div className={`${pg.tokens} ${s.page}`}><div className={s.entry} role={error ? 'alert' : 'status'}><BrandWhaleIcon className="h-14 w-14" /><h1>Echo Odyssey</h1><p>{error ? (vi ? 'Hải đồ chưa tải được.' : 'The atlas could not load.') : (vi ? 'Đang nối lại hành trình của bạn…' : 'Restoring your journey…')}</p>{error && <button onClick={() => void mutate()}>{vi ? 'Thử lại' : 'Try again'}</button>}<Link href="/learning-path?view=list">{vi ? 'Mở lộ trình dạng danh sách' : 'Open the learning list'}</Link>{isLoading && <Loader2 className={s.spin} />}</div></div>;
  return <div ref={pageRef} className={`${pg.tokens} ${s.page} ${hud.root}`} key={account} data-hud={hudState}>
    <header className={s.header}>
      {/* The location puck: always on screen — the way out, the way back to the whole planet, where you are, and the controls. */}
      <Link className={s.exitWorld} data-guide="odyssey-list" href="/learning-path?view=list" aria-label={vi ? 'Rời thế giới Odyssey' : 'Exit Odyssey world'}><ArrowLeft size={18} /><span>{vi ? 'Trở về' : 'Exit'}</span></Link>
      {currentRegion && <button type="button" className={s.puckPlace} onClick={atlas} data-testid="odyssey-whole-planet" aria-label={vi ? `Về toàn cảnh hành tinh (đang ở ${word(currentRegion.name, vi)})` : `Back to the whole planet (now at ${word(currentRegion.name, vi)})`}>
        <Globe2 size={16} aria-hidden="true" /><span className={hud.fold}>{vi ? 'Toàn cảnh' : 'Whole planet'}</span><b>{word(currentRegion.name, vi)}</b></button>}
      <button type="button" className={s.puckToggle} onClick={() => (hudShown ? conceal() : reveal(6000))} aria-pressed={hudShown} data-testid="world-hud-toggle"
        aria-label={hudShown ? (vi ? 'Ẩn bảng điều khiển, để hành tinh chiếm màn hình' : 'Hide the controls, let the planet fill the screen') : (vi ? 'Hiện bảng điều khiển' : 'Show the controls')}
        title={hudShown ? (vi ? 'Ẩn bảng điều khiển' : 'Hide controls') : (vi ? 'Hiện bảng điều khiển' : 'Show controls')}>{hudShown ? <EyeOff size={17} /> : <Eye size={17} />}</button>
      <div className={`${s.brand} ${hud.chrome}`} data-hud-chrome="top"><span aria-hidden="true"><BrandWhaleIcon className="h-6 w-6" /></span><span><h1 className={s.srOnly}>Echo Odyssey</h1><strong aria-hidden="true">Echo Odyssey</strong><small>{vi ? 'Hành tinh học tập của bạn' : 'Your learning planet'}</small></span></div>
      <nav className={`${s.viewNav} ${hud.chrome}`} data-hud-chrome="top" aria-label={vi ? 'Góc nhìn lộ trình' : 'Learning path view'}>
        <button className={!atlasOpen ? s.activeTab : undefined} onClick={() => { setAtlasOpen(false); atlas(); }} data-guide="odyssey-atlas"><Globe2 size={17} />{vi ? 'Hành tinh' : 'Planet'}</button>
        <button onClick={() => openAtlas('map')} data-guide="odyssey-journey" aria-pressed={atlasOpen && atlasTab !== 'journal'}><MapIcon size={17} />{vi ? 'Hành trình' : 'Journey'}</button>
        <button onClick={() => openAtlas('journal')} data-guide="odyssey-journal" aria-pressed={atlasOpen && atlasTab === 'journal'}><BookOpen size={17} />{vi ? 'Nhật ký' : 'Journal'}</button>
      </nav>
    </header>
    <div className={s.world} data-drawer={drawerOpen} data-morph-hero="" data-spatial-owner="odyssey">
      {lightweight ? <nav className={s.lightAtlas} aria-label={vi ? 'Hải đồ không 3D' : 'Atlas without 3D'} data-guide="odyssey-map">{world.regions.map(({region:r,stations,passed})=><button key={r.id} aria-pressed={region===r.id} onClick={()=>visit(r.id)}><Compass size={22}/><strong>{word(r.name,vi)}</strong><span>{regionStates[r.id]}</span><span>{stations} {vi?'trạm':'stations'} · {passed} {vi?'đã kiểm tra':'checks passed'}</span></button>)}</nav> : <WorldCanvas celebration={unlocked.length ? { id: unlocked.map(s => s.id).join(','), region: unlocked[0].regionId } : celebration.length ? { id: celebration.map(r => `${r.sourceKind}:${r.sourceRef}:${r.grantedAt}`).join(','), region: celebration[0].regionId } : null} routes={routes} current={current} next={next?.regionId || null} nextStation={next?.id || null} states={regionStates} kinds={regionKinds} regions={regions} discovered={discovered} region={region} stations={region ? stations : EMPTY} selected={selected} graphics={graphics} vi={vi}
        paused={atlasOpen} onRegion={visit} onStation={select} onFallback={() => setLight(true)} onMetrics={setMetrics} onTier={setTierState} onAutoChange={onAutoChange} onHeavy={onHeavy} onTouch={onTouch} />}
      {currentRegion && <div className={`${s.worldHeading} ${hud.chrome}`} data-hud-chrome="left">
        <h2>{word(currentRegion.name, vi)}</h2>
        <p>{word(currentRegion.purpose, vi)}</p>
        <div className={s.regionMeta}>
          <span data-kind={regionKinds[currentRegion.id]}>{regionStates[currentRegion.id]}</span>
          <span>{currentRegion.skill === 'GRAMMAR' ? (vi ? 'Ngữ pháp' : 'Grammar') : skillLabel(currentRegion.skill, vi ? 'vi' : 'en')}</span>
          {regionFacts && <span>{regionFacts.stations} {vi ? 'trạm' : 'stations'}</span>}
          {regionFacts && regionFacts.passed > 0 && <span>{regionFacts.passed} {vi ? 'đã vượt kiểm tra' : 'checks passed'}</span>}
          {regionFacts && regionFacts.reviewDue > 0 && <span>{regionFacts.reviewDue} {vi ? 'đến hạn ôn' : 'due for review'}</span>}
        </div>
      </div>}
      <div className={`${s.topTools} ${hud.chrome}`} data-hud-chrome="top">
        <button data-guide="odyssey-travel-toggle" onClick={() => setTravelOpen(v => !v)} aria-expanded={travelOpen} aria-controls="odyssey-travel"><Navigation size={18}/><span>{vi ? 'Các vùng' : 'Regions'}</span></button>
        <label className={s.quality} data-guide="odyssey-graphics" title={tierState?.building ? (vi ? 'Đang dựng hành tinh chi tiết hơn…' : 'Building a more detailed planet…') : undefined}><Settings2 size={15} /><span className={s.qualityLabel}>{vi ? 'Đồ họa' : 'Graphics'}</span>
          <select aria-label={vi ? 'Chất lượng đồ họa của hành tinh' : 'Planet graphics quality'} value={lightweight ? 'none' : graphics} onChange={e => { const v = e.target.value; if (v === 'none') { setLight(true); return; } setLight(false); setGraphics(v as GraphicsChoice); saveGraphicsChoice(v as GraphicsChoice); }}>
            {CHOICES.map(c => <option key={c} value={c}>{c === 'auto' && tierState?.auto ? `${vi ? CHOICE_LABEL.auto.vi : CHOICE_LABEL.auto.en} · ${vi ? TIER_LABEL[tierState.tier].vi : TIER_LABEL[tierState.tier].en}` : (vi ? CHOICE_LABEL[c].vi : CHOICE_LABEL[c].en)}</option>)}
            <option value="none">{vi ? 'Không 3D' : 'No 3D'}</option>
          </select>{tierState?.building && !lightweight && <Loader2 size={14} className={s.spin} aria-hidden="true" />}</label>
        <button data-testid="world-display-toggle" data-display={display} onClick={() => toggleDisplay()} aria-pressed={display === 'immersive'}
          aria-label={display === 'immersive' ? (vi ? 'Thu về giao diện trang web, hiện thanh bên' : 'Show inside the website layout, with the sidebar') : (vi ? 'Mở toàn màn hình ứng dụng' : 'Fill the application window')}
          title={display === 'immersive' ? (vi ? 'Thu về giao diện trang web' : 'Website layout') : (vi ? 'Toàn màn hình' : 'Full view')}>{display === 'immersive' ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
        <button onClick={() => { setDrawerOpen(true); requestAnimationFrame(() => startGuide('odyssey')); }} aria-label={vi ? 'Hướng dẫn Odyssey' : 'Odyssey guide'}><HelpCircle size={19} /></button>
      </div>
      {unlocked.length > 0 && <div className={s.unlockReveal} role="status"><ShieldCheck size={28}/><strong>{vi ? 'Một nhánh mới đã mở' : 'A new branch is ready'}</strong><p>{vi ? unlocked[0].title.vi : unlocked[0].title.en}</p><button onClick={() => { visit(unlocked[0].regionId, unlocked[0].id); setUnlocked([]); }}>{vi ? 'Đến điểm học tiếp theo' : 'Go to the next station'}<ArrowRight size={16}/></button><button onClick={() => setUnlocked([])} aria-label={vi ? 'Đóng' : 'Close'}><X size={16}/></button></div>}
      {celebration.length > 0 && <div className={s.celebration} role="status"><ShieldCheck /><div><strong>{vi ? 'Một ngọn hải đăng đã sáng' : 'A lighthouse comes alive'}</strong><p>{vi ? `${celebration.length} dấu mốc được xác nhận từ kết quả đã lưu.` : `${celebration.length} milestone(s) confirmed from saved results.`}</p></div><button onClick={() => setCelebration([])} aria-label={vi ? 'Đóng thông báo' : 'Dismiss'}><X size={17} /></button></div>}
      <button className={`${s.drawerToggle} ${drawerOpen ? '' : hud.chrome}`} data-hud-chrome={drawerOpen ? undefined : 'right'} onClick={() => setDrawerOpen(v => !v)} aria-label={vi ? 'Trạm học' : 'Learning stations'} aria-expanded={drawerOpen} aria-controls="odyssey-quests"><Compass size={18} /><span>{vi ? 'Trạm học' : 'Stations'}</span>{drawerOpen ? <X size={16} /> : <ChevronLeft size={16} />}</button>
      <aside id="odyssey-quests" className={s.questPanel} data-open={drawerOpen} aria-label={vi ? 'Trạm học' : 'Learning stations'}>
        <div className={s.panelHeading}><h3>{region ? (vi ? 'Trạm học của vùng' : 'Stations in this region') : (vi ? 'Học gì tiếp theo?' : 'What’s next?')}</h3>
          <button className={s.atlasOpen} onClick={() => openAtlas('map')} data-guide="odyssey-open-atlas"><MapIcon size={15} />{vi ? 'Bản đồ hành trình' : 'Journey atlas'}</button></div>
        {!world.today.plan && <div className={s.noPlan}><p>{vi ? 'Chưa có bằng chứng đầu vào? Bạn có thể bắt đầu nhẹ nhàng hoặc làm bài xếp lớp.' : 'No starting evidence? Begin gently or take a placement quiz.'}</p><Link href="/learning-path?view=list">{vi ? 'Thiết lập mục tiêu' : 'Set your goal'}<ArrowRight size={15} /></Link><button onClick={() => placementQuizStore.open(vi ? 'vi' : 'en')}>{vi ? 'Bài xếp lớp nhanh' : 'Quick placement'}</button></div>}
        {region && <><label className={s.search}><Search size={16} /><input value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }} placeholder={vi ? 'Tìm trạm học…' : 'Find a station…'} aria-label={vi ? 'Tìm trạm học' : 'Find a station'} /></label>
          {detail && new Set(detail.stations.map(t => t.domain).filter(Boolean)).size > 1 && <label className={s.domainSelect}><span>{vi ? 'Nhánh kiến thức' : 'Knowledge branch'}</span><select value={domain} onChange={e => { setDomain(e.target.value); setPage(0); }}><option value="">{vi ? 'Tất cả các nhánh' : 'All branches'}</option>{[...new Set(detail.stations.map(t => t.domain).filter(Boolean))].map(d => <option key={d} value={d!}>{word(grammarCatalog?.domains.find(v=>v.id===d)?.title || {vi:'Nhóm chủ đề',en:'Topic group'},vi)}</option>)}</select></label>}
        </>}
        <div className={s.stationList} data-guide="odyssey-stations">
          {detailLoading && region ? <p role="status">{vi ? 'Đang mở các trạm…' : 'Opening stations…'}</p> : detailError && region ? <button onClick={() => void refreshDetail()}>{vi ? 'Tải lại các trạm' : 'Reload stations'}</button> : shown.map(station => { const st = nodeState(station, next?.id);
            return <button key={station.id} className={s.station} data-selected={selected === station.id} data-state={st} onClick={() => { if (!region) visit(station.regionId, station.id); else select(station.id); }} data-morph-source={station.id}>
            <span className={s.stationIcon} data-state={st}>{st === 'done' || st === 'taskdone' ? <Check size={17} /> : st === 'explore' ? <Anchor size={17} /> : st === 'review' ? <RotateCcw size={16} /> : st === 'prereq' ? <LockKeyhole size={16} /> : st === 'next' ? <Flag size={16} /> : station.checkAvailable ? <BookOpen size={17} /> : <Compass size={17} />}</span>
            <span><strong>{stationTitle(station, vi)}</strong><small>{station.level ? `${station.level} · ` : ''}{statusText(station.status, vi)}{st === 'next' ? (vi ? ' · Gợi ý tiếp theo' : ' · Suggested next') : ''}</small></span><ChevronRight size={14} />
          </button>; })}
          {!shown.length && !detailLoading && <p>{vi ? 'Không có trạm phù hợp bộ lọc.' : 'No station matches this filter.'}</p>}
        </div>
        {stations.length > 10 && <div className={s.pagination}><button disabled={!page} onClick={() => setPage(p => p - 1)} aria-label={vi ? 'Trang trước' : 'Previous page'}><ChevronLeft size={16} /></button><span>{page + 1} / {Math.ceil(stations.length / 10)}</span><button disabled={(page + 1) * 10 >= stations.length} onClick={() => setPage(p => p + 1)} aria-label={vi ? 'Trang sau' : 'Next page'}><ChevronRight size={16} /></button></div>}
        {graphError && <button className={s.secondary} onClick={() => void refreshGraph()}>{vi ? 'Tải lại đường học giữa các đảo' : 'Reload learning routes'}</button>}
        {chosen && <div ref={questRef} className={s.questDetail} data-guide="odyssey-quest">
          <h3>{stationTitle(chosen, vi)}</h3>
          {chosen.task && <p>{reasonLabel(chosen.task.reason, vi ? 'vi' : 'en')} · {chosen.task.minutes} {vi ? 'phút' : 'min'} · {chosen.task.progress}/{chosen.task.goalCount}</p>}
          {chosen.kind === 'GRAMMAR' && <ol className={s.activityStages}><li>{vi ? 'Khám phá khái niệm' : 'Learn the concept'}</li><li>{vi ? 'Luyện tập' : 'Practise'}</li><li data-done={passed(chosen)}>{vi ? 'Kiểm tra chủ đề' : 'Topic checkpoint'}</li><li>{vi ? 'Ôn tập và nhánh tiếp theo' : 'Review and next branches'}</li></ol>}
          {chosen.status === 'REMEDIATION' && <p className={s.remediation}>{vi ? 'Kiểm tra vừa rồi chưa đạt. Ôn kiến thức nền, luyện lại rồi thử bài kiểm tra mới; thành tích trước đây được giữ.' : 'This check needs more practice. Review the prerequisites, practise and retry; previous achievements are retained.'}</p>}
          {chosen.kind === 'GRAMMAR' && <p>{vi ? 'Học và luyện tự do. Bài kiểm tra riêng mới cung cấp bằng chứng cho chủ đề này.' : 'Study and practise freely. A separate check provides evidence for this concept.'}</p>}
          {chosen.kind === 'WORKFLOW' && <p>{vi ? 'Chọn hoạt động trong mô-đun. Việc mở không gian này không tạo thành tích hoàn thành.' : 'Choose an activity in the module. Opening this space does not earn completion credit.'}</p>}
          {chosen.kind === 'WORKFLOW' && <ol className={s.activityStages}><li>{vi ? 'Chọn bài phù hợp mục tiêu' : 'Choose a relevant activity'}</li><li>{vi ? 'Luyện và nộp bài' : 'Practise and submit'}</li><li>{vi ? 'Xem phản hồi thực tế' : 'Read the activity feedback'}</li><li>{vi ? 'Trở về để xem bước tiếp theo' : 'Return for your next step'}</li></ol>}
          {chosen.gate.missing.length > 0 && <details className={s.gate}><summary><LockKeyhole size={15} />{vi ? 'Chuẩn bị cho nhánh nâng cao' : 'Prepare for the advanced branch'}</summary><p>{vi ? 'Ôn các khái niệm bên dưới, hoặc vượt kiểm tra trực tiếp nếu bạn đã biết.' : 'Review these concepts, or pass a direct challenge if you already know them.'}</p>{chosen.gate.missing.map(slug => <Link key={slug} href={`/grammar/topics/${slug}`}>{word(topicTitles.get(slug) || {vi:'Kiến thức nền cần ôn',en:'Prerequisite concept'},vi)}</Link>)}</details>}
          <button className={s.primary} disabled={busy} onClick={() => void launch(chosen)}>{busy ? <Loader2 size={17} className={s.spin} /> : <Play size={17} />}{vi ? 'Bắt đầu học' : 'Start learning'}<ArrowRight size={17} /></button>
          {chosen.checkAvailable && <div className={s.checkActions}><button disabled={busy} onClick={() => void launch(chosen, chosen.status === 'REVIEW_DUE' ? 'REVIEW' : 'CHECK')}><ShieldCheck size={16} />{chosen.status === 'REVIEW_DUE' ? (vi ? 'Kiểm tra ôn tập' : 'Review check') : (vi ? 'Thử thách chủ đề' : 'Challenge check')}</button><button disabled={busy || chosen.gate.state !== 'READY'} onClick={() => void launch(chosen, 'ADVANCE')}><Layers size={16} />{vi ? 'Nhánh nâng cao' : 'Advanced branch'}</button></div>}
        </div>}
        {region && <button className={s.beacon} disabled={world.explored.some(e => e.regionId === region && e.beaconAt !== null)} onClick={() => void odysseyApi.discover(region, true).then(explored => mutate({ ...world, explored }, { revalidate: false })).catch(e => setNotice(message(e, vi)))}><Anchor size={16} />{world.explored.some(e => e.regionId === region && e.beaconAt !== null) ? (vi ? 'Hải đăng đã ghi dấu' : 'Beacon recorded') : (vi ? 'Ghi dấu hải đăng' : 'Activate this beacon')}</button>}
      </aside>
      {next && <button className={`${s.nextVoyage} ${hud.chrome}`} data-hud-chrome="bottom" onClick={() => visit(next.regionId, next.id)} title={(next.task ? reasonLabel(next.task.reason, vi ? 'vi' : 'en') : next.level) || undefined}><Compass size={20}/><span><small>{vi ? 'Tiếp theo' : 'Up next'}</small><strong>{stationTitle(next, vi)}</strong></span><ArrowRight size={18}/></button>}

    </div>
    {atlasOpen && <JourneyAtlas world={world} graph={graph} graphLoading={graphValidating && !graph} graphError={!!graphError} onReloadGraph={() => void refreshGraph()} catalog={grammarCatalog}
      initialRegion={region ?? next?.regionId ?? null} selected={selected} next={next} current={current} vi={vi} busy={busy} tab={atlasTab} onTab={setAtlasTab}
      goal={<PlanPanel key={world.navigation.revision} world={world} vi={vi} onSaved={n => void mutate({ ...world, navigation: n }, { revalidate: false })} />}
      journal={<Journal world={world} vi={vi} onClose={() => setAtlasTab('map')} onVisit={id => { setAtlasOpen(false); visit(id); }} />}
      onClose={() => setAtlasOpen(false)} onSelect={st => setSelected(st.id)} onLaunch={(st, mode) => void launch(st, mode)}
      onShowOnPlanet={(regionId, st) => { setAtlasOpen(false); visit(regionId, st?.id ?? null); }}
      stationTitle={st => stationTitle(st, vi)} statusText={v => statusText(v, vi)} />}
    {notice && <div className={s.notice} role="alert">{notice}<button onClick={() => setNotice('')} aria-label={vi ? 'Đóng' : 'Close'}><X size={16} /></button></div>}
    {hint && !atlasOpen && <WorldHint label={vi ? 'Cách khám phá hành tinh' : 'How to explore the planet'} closeLabel={vi ? 'Đã hiểu' : 'Got it'} onClose={dismissHint}
      items={hint === 'first' ? [{ text: vi ? 'Kéo để xoay hành tinh' : 'Drag to turn the planet' }, { text: vi ? 'Cuộn để lại gần' : 'Scroll to come closer' }, { text: vi ? 'Chạm vào biển, rừng, núi, làng… để khám phá' : 'Touch the sea, forests, mountains, villages… to explore' }, { text: vi ? 'Bấm tên một vùng để vào trạm học' : 'Press a region name to open its stations' }]
        : [{ text: vi ? 'Chạm thẳng vào mặt hành tinh: mọi vùng đất, biển và công trình đều phản hồi' : 'Touch the planet itself: every land, sea and landmark answers' }, { key: 'Enter', text: vi ? 'khám phá chỗ giữa màn hình' : 'explore the centre of the view' }]} />}
    <footer className={`${s.footer} ${hud.chrome}`} data-hud-chrome="bottom"><div className={s.legend}><span><i className={s.dotNext} />{vi ? 'Tiếp theo' : 'Up next'}</span><span><i className={s.dotHere} />{vi ? 'Bạn ở đây' : 'You are here'}</span><span><i className={s.dotDone} />{vi ? 'Có bằng chứng' : 'Evidence'}</span><span><i className={s.dotReview} />{vi ? 'Đến hạn ôn' : 'Review due'}</span><span><i className={s.dotChallenge} />{vi ? 'Nhánh cần nền tảng' : 'Needs prerequisites'}</span><span><i className={s.dotOpen} />{vi ? 'Có thể học' : 'Available'}</span></div></footer>
    <nav id="odyssey-travel" hidden={!travelOpen} className={s.fastTravel} aria-label={vi ? 'Đi nhanh đến vùng' : 'Quick regional navigation'} data-guide="odyssey-travel">{regions.map(r => <button key={r.id} onClick={() => visit(r.id)} aria-pressed={region === r.id}><Navigation size={15} /><span>{word(r.name, vi)}<small>{regionStates[r.id]}</small></span></button>)}</nav>
    <details className={s.performance} hidden={!travelOpen}><summary>{vi ? 'Thông tin hiển thị' : 'Display information'}</summary><p>{metrics ? `${metrics.fps.toFixed(1)} FPS · p95 ${metrics.frameP95.toFixed(1)} ms · ${metrics.triangles.toLocaleString()} triangles · ${metrics.calls} draw calls · ${metrics.samples} samples` : (vi ? 'Chưa đủ mẫu đo trong phiên này.' : 'Not enough measured frames yet.')}</p><p>{vi ? 'Số đo của thiết bị hiện tại, không phải cam kết hiệu năng cho mọi máy.' : 'Measurements from this device, not a performance guarantee for other devices.'}</p></details>
  </div>;
}

function Journal({ world, vi, onClose, onVisit }: { world: World; vi: boolean; onClose: () => void; onVisit: (id: string) => void }) {
  const [older, setOlder] = useState<Reward[]>([]), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const entries = [...world.journal, ...older];
  return <div className={s.journal}><div className={s.journalTitle}><h3>{vi ? 'Nhật ký hải trình' : 'Voyage journal'}</h3><button onClick={onClose} aria-label={vi ? 'Đóng nhật ký' : 'Close journal'}><X size={17} /></button></div><p>{vi ? 'Những dấu mốc thật, từ hoạt động đã lưu. Huy hiệu trang trí không phải điểm năng lực.' : 'Real milestones from saved activities. Cosmetic marks are not proficiency scores.'}</p>
    <strong>{world.rewardCount} {vi ? 'dấu mốc hành trình' : 'voyage milestones'}</strong>
    {entries.length ? entries.map((r, i) => <button key={`${r.sourceKind}:${r.sourceRef}:${i}`} className={s.journalEntry} onClick={() => onVisit(r.regionId)}><ShieldCheck size={18} /><span><strong>{r.sourceKind === 'GRAMMAR_CHECK' ? (vi ? 'Vượt kiểm tra chủ đề' : 'Topic check passed') : (vi ? 'Hoàn thành nhiệm vụ' : 'Quest completed')}</strong><small>{new Date(r.grantedAt).toLocaleDateString(vi ? 'vi-VN' : 'en-GB')} · {word(world.regions.find(x => x.region.id === r.regionId)?.region.name || { vi: r.regionId, en: r.regionId }, vi)}</small></span></button>) : <div className={s.emptyJournal}><BookOpen /><p>{vi ? 'Trang đầu tiên đang chờ bạn. Hoàn thành một nhiệm vụ thật để ghi dấu.' : 'Your first page is waiting. Complete a real quest to leave a mark.'}</p></div>}
    {entries.length < world.rewardCount && <button disabled={busy} onClick={async () => { setBusy(true); setFailed(false); try { const next = await odysseyApi.journal(entries.length); setOlder(x => [...x, ...next]); } catch { setFailed(true); } finally { setBusy(false); } }}>{vi ? 'Xem những trang trước' : 'Read earlier pages'}</button>}{failed && <p role="alert">{vi ? 'Chưa tải được. Hãy thử lại.' : 'Could not load. Please retry.'}</p>}
  </div>;
}
function PlanPanel({ world, vi, onSaved }: { world: World; vi: boolean; onSaved: (n: NavState) => void }) {
  const [date, setDate] = useState(world.navigation.targetDate || ''), [minutes, setMinutes] = useState(world.navigation.weeklyMinutes || (world.today.plan?.dailyMinutes || 30) * 7);
  const [variant, setVariant] = useState(world.navigation.examVariant || (world.today.plan?.goal === 'TOEIC' ? 'LISTENING_READING' : 'ACADEMIC'));
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  return <div className={s.planPanel}><h3>{vi ? 'Đích đến và nhịp học' : 'Destination and study rhythm'}</h3><strong>{world.today.plan ? goalLabel(world.today.plan.goal, world.today.plan.target, vi ? 'vi' : 'en') : (vi ? 'Chưa đặt mục tiêu' : 'No goal yet')}</strong><Link href="/learning-path?view=list">{vi ? 'Đổi mục tiêu và bài mỗi ngày' : 'Change goal and daily tasks'}<ArrowRight size={14} /></Link>
    <p>{world.today.plan?.levelBasis === 'PROVISIONAL' ? (vi ? 'Chưa đủ bằng chứng xếp trình độ. Mức nội dung tạm thời không phải trình độ được xác nhận.' : 'Not enough placement evidence. A provisional content level is not a verified proficiency level.') : (vi ? 'Mức bắt đầu lấy từ hồ sơ hiện có; từng kỹ năng vẫn cần bằng chứng riêng.' : 'Starting level comes from your existing profile; each skill needs its own evidence.')}</p>
    <div className={s.skills}>{['LISTENING', 'READING', 'SPEAKING', 'WRITING'].map(skill => { const e = world.evidence.find(v => v.skill === skill); return <div key={skill}><span>{skillLabel(skill, vi ? 'vi' : 'en')}</span><strong>{e?.currentVerified ? `${e.cefr} · ${vi ? 'Hồ sơ đã xác thực' : 'Verified profile'}` : vi ? 'Cần bằng chứng phù hợp' : 'Relevant evidence needed'}</strong></div>; })}</div>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setNotice(''); try { onSaved(await odysseyApi.preferences({ targetDate: date || null, weeklyMinutes: minutes, examVariant: world.today.plan?.goal === 'IELTS' || world.today.plan?.goal === 'TOEIC' ? variant : null })); setNotice(vi ? 'Đã lưu nhịp học dự kiến.' : 'Planned study rhythm saved.'); } catch (err) { setNotice(message(err, vi)); } finally { setBusy(false); } }}>
      <label>{vi ? 'Ngày mục tiêu (không bắt buộc)' : 'Target date (optional)'}<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>{vi ? 'Số phút có thể học mỗi tuần' : 'Available study minutes per week'}<input type="number" min={15} max={2520} step={15} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></label>
      {world.today.plan?.goal === 'IELTS' && <label>{vi ? 'Hình thức IELTS' : 'IELTS variant'}<select value={variant} onChange={e => setVariant(e.target.value)}><option value="ACADEMIC">Academic</option><option value="GENERAL_TRAINING">General Training</option></select></label>}
      {variant === 'GENERAL_TRAINING' && world.today.plan?.goal === 'IELTS' && <p>{vi ? 'Kho bài hiện tại chưa chứng minh đủ bộ General Training. Kiểm tra hình thức bài trước khi làm.' : 'The current library does not establish full General Training coverage. Check each form before starting.'}</p>}
      <button className={s.secondary} disabled={busy}>{vi ? 'Lưu kế hoạch thời gian' : 'Save time plan'}</button>
    </form>
    <p className={s.honesty}>{vi ? 'Chưa có mô hình được hiệu chuẩn để dự đoán ngày đạt C1, IELTS hoặc TOEIC. Lịch này ghi lại thời gian bạn dự kiến dành cho học tập.' : 'There is no calibrated model predicting when you will reach C1, IELTS or TOEIC targets. This schedule records your planned study capacity.'}</p>
    {date && minutes < 105 && <p className={s.honesty}>{vi ? 'Thời gian dự kiến khá hạn chế. Chọn ít ưu tiên, giữ lịch ôn và đánh giá lại tiến độ trước hạn mục tiêu.' : 'Planned study time is limited. Choose a few priorities, retain review and reassess progress before the target date.'}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
