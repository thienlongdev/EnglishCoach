'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Atom, BookOpen, Box, ChevronDown, ChevronRight, Crosshair, FileText, Maximize2, Minus, Orbit, Plus, Waypoints } from 'lucide-react';
import { layoutKnowledgeTree, type TreeBox, type TreeIndex, type TreeItem } from '@/lib/cosmos/treeLayout';
import { memoryOf, MEMORY_LABEL } from '@/lib/cosmos/memory';
import type { CosmosGraph } from '@/lib/cosmos/types';
import type { Focus } from '@/lib/cosmos/view';
import s from './livingTree.module.css';

type Camera = { x: number; y: number; k: number };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export default function LivingKnowledgeTree({ index, rows, selected, vi, graph, onActivate, onShow3D }: {
  index: TreeIndex; rows: TreeItem[]; selected: string; vi: boolean; graph: CosmosGraph;
  onActivate: (item: TreeItem) => void; onShow3D: (focus: Focus) => void;
}) {
  const T = (a: string, b: string) => vi ? a : b;
  const viewport = useRef<HTMLDivElement>(null);
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(new Map());
  const measure = useMemo(() => {
    if (typeof document === 'undefined') return undefined;
    const ctx = document.createElement('canvas').getContext('2d'); // text measurement only, no renderer/loop
    if (!ctx) return undefined;
    ctx.font = `700 14px ${getComputedStyle(document.body).fontFamily}`;
    return (text: string) => ctx.measureText(text).width;
  }, []);
  const layout = useMemo(() => layoutKnowledgeTree(index, rows, limits, selected, measure), [index, rows, limits, selected, measure]);
  const byId = useMemo(() => new Map(layout.boxes.map(b => [b.id, b])), [layout]);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [camera, setCamera] = useState<Camera>({ x: 400, y: 300, k: .7 });
  const cam = useRef(camera); cam.current = camera;
  const sizeRef = useRef(size); sizeRef.current = size;
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const [cursor, setCursor] = useState('u');
  const [moving, setMoving] = useState(false);
  const [live, setLive] = useState(false);
  const autoFit = useRef(true);
  const anchor = useRef<{ id: string; x: number; y: number } | null>(null);
  const frame = useRef(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const schedule = useCallback((next: Camera) => {
    cam.current = next;
    if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; setCamera(cam.current); });
  }, []);
  const fit = useCallback(() => {
    const { bounds: b } = layoutRef.current, { w, h } = sizeRef.current;
    const k = clamp(Math.min((w - 80) / (b.w + 40), (h - 120) / (b.h + 40)), .05, 1.05);
    autoFit.current = true;
    const next = { k, x: w / 2 - (b.x + b.w / 2) * k, y: h / 2 - (b.y + b.h / 2) * k };
    cam.current = next; setCamera(next);
  }, []);
  const focus = useCallback((id: string) => {
    const b = layoutRef.current.boxes.find(b => b.id === id); if (!b) return;
    autoFit.current = false;
    const { w, h } = sizeRef.current, k = Math.min(1.15, Math.max(.65, cam.current.k));
    const next = { k, x: w / 2 - b.x * k, y: h / 2 - b.y * k };
    cam.current = next; setCamera(next);
  }, []);
  const zoom = useCallback((factor: number, x?: number, y?: number) => {
    autoFit.current = false;
    const c = cam.current, k = clamp(c.k * factor, .05, 1.8), px = x ?? sizeRef.current.w / 2, py = y ?? sizeRef.current.h / 2;
    schedule({ k, x: px - (px - c.x) * k / c.k, y: py - (py - c.y) * k / c.k });
  }, [schedule]);
  useLayoutEffect(() => {
    const a = anchor.current;
    if (a) {
      const b = byId.get(a.id); anchor.current = null;
      if (b) { const next = { ...cam.current, x: a.x - b.x * cam.current.k, y: a.y - b.y * cam.current.k }; cam.current = next; setCamera(next); }
    } else if (autoFit.current) fit();
  }, [byId, fit]);
  useEffect(() => { if (selected) { setCursor(selected); focus(selected); } }, [selected, focus]);
  useLayoutEffect(() => {
    const el = viewport.current; if (!el) return;
    const resize = () => {
      const prev = sizeRef.current, next = { w: el.clientWidth, h: el.clientHeight };
      sizeRef.current = next; setSize(next);
      if (autoFit.current) fit();
      else { const c = { ...cam.current, x: cam.current.x + (next.w - prev.w) / 2, y: cam.current.y + (next.h - prev.h) / 2 }; cam.current = c; setCamera(c); }
    };
    const observer = new ResizeObserver(resize); observer.observe(el); resize();
    return () => observer.disconnect();
  }, [fit]);
  useEffect(() => {
    const el = viewport.current; if (!el) return;
    let visible = false;
    const sync = () => setLive(visible && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }); observer.observe(el);
    const wheel = (e: WheelEvent) => { e.preventDefault(); const b = el.getBoundingClientRect(); zoom(Math.exp(-clamp(e.deltaY, -120, 120) * .0025), e.clientX - b.left, e.clientY - b.top); };
    el.addEventListener('wheel', wheel, { passive: false }); document.addEventListener('visibilitychange', sync);
    return () => { observer.disconnect(); el.removeEventListener('wheel', wheel); document.removeEventListener('visibilitychange', sync); cancelAnimationFrame(frame.current); };
  }, [zoom]);
  const remember = (b: TreeBox) => { autoFit.current = false; anchor.current = { id: b.remaining ? b.parent : b.id, x: b.x * cam.current.k + cam.current.x, y: b.y * cam.current.k + cam.current.y }; };
  const activate = (b: TreeBox) => {
    if (b.remaining) {
      const p = byId.get(b.parent); if (p) remember(p);
      setLimits(old => new Map(old).set(b.parent, (old.get(b.parent) ?? 6) + 12));
    } else { remember(b); setCursor(b.id); onActivate(b.item); }
  };
  const point = (e: ReactPointerEvent) => ({ x: e.clientX, y: e.clientY });
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button,[role="treeitem"]') || e.button !== 0) return;
    pointers.current.set(e.pointerId, point(e)); e.currentTarget.setPointerCapture(e.pointerId); setMoving(true); autoFit.current = false;
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const old = pointers.current.get(e.pointerId); if (!old) return;
    const before = [...pointers.current.values()]; pointers.current.set(e.pointerId, point(e));
    const after = [...pointers.current.values()];
    if (before.length === 2) {
      const d0 = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y), d1 = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
      const b = e.currentTarget.getBoundingClientRect(); if (d0 > 0) zoom(d1 / d0, (after[0].x + after[1].x) / 2 - b.left, (after[0].y + after[1].y) / 2 - b.top);
    } else schedule({ ...cam.current, x: cam.current.x + e.clientX - old.x, y: cam.current.y + e.clientY - old.y });
  };
  const up = (e: ReactPointerEvent) => { pointers.current.delete(e.pointerId); if (!pointers.current.size) setMoving(false); };
  // Cull surfaces outside the visible viewport, retaining the roving focus node. Nothing is removed from the hierarchy.
  const visible = layout.boxes.filter(b => b.id === cursor || (Math.abs(b.x * camera.k + camera.x - size.w / 2) < size.w / 2 + b.w * camera.k / 2 + 100 && Math.abs(b.y * camera.k + camera.y - size.h / 2) < size.h / 2 + b.h * camera.k / 2 + 100));
  const visibleIds = new Set(visible.map(b => b.id));
  const highlighted = new Set<string>(); let parent = selected || cursor;
  while (parent) { highlighted.add(parent); parent = index.byId.get(parent)?.parent ?? ''; }
  const secondary = selected ? graph.edges.filter(e => e.status === 'VERIFIED' && (graph.nodes[e.s]?.id === selected || graph.nodes[e.t]?.id === selected)).flatMap(e => {
    const a = byId.get(graph.nodes[e.s].id), b = byId.get(graph.nodes[e.t].id);
    return a && b && visibleIds.has(a.id) && visibleIds.has(b.id) ? [{ id: e.id, d: `M${a.x},${a.y} Q${(a.x + b.x) / 2},${Math.min(a.y, b.y) - 80} ${b.x},${b.y}` }] : [];
  }) : [];
  const cursorBox = byId.get(cursor) ?? byId.get('u');
  const expanded = (id: string) => layout.boxes.some(b => b.parent === id);
  return <div className={s.map} data-live={live} data-moving={moving} data-testid="living-knowledge-tree">
    <div className={s.mapControls} aria-label={T('Điều khiển cây', 'Tree controls')}>
      <button onClick={() => zoom(1.2)} aria-label={T('Phóng to', 'Zoom in')}><Plus size={17} /></button>
      <span>{Math.round(camera.k * 100)}%</span>
      <button onClick={() => zoom(1 / 1.2)} aria-label={T('Thu nhỏ', 'Zoom out')}><Minus size={17} /></button>
      <button onClick={fit} aria-label={T('Vừa toàn bộ cây', 'Fit visible tree')} title={T('Vừa toàn bộ cây', 'Fit visible tree')}><Maximize2 size={17} /></button>
      <button onClick={() => focus(selected || cursor)} aria-label={T('Tập trung nút đã chọn', 'Focus selected node')}><Crosshair size={17} /></button>
      {cursorBox && <button onClick={() => onShow3D(cursorBox.item.focus)} title={T('Xem trong 3D', 'Show in 3D')} aria-label={T('Xem trong 3D', 'Show in 3D')}><Box size={17} /></button>}
    </div>
    <div ref={viewport} className={s.viewport} role="tree" aria-label={T('Cây tri thức không gian', 'Spatial knowledge tree')}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up}
      onKeyDown={e => {
        if ((e.target as HTMLElement).closest('button')) return;
        const i = layout.boxes.findIndex(b => b.id === cursor), b = layout.boxes[i]; if (!b) return;
        let next: TreeBox | undefined;
        if (e.key === 'ArrowDown') next = layout.boxes[Math.min(layout.boxes.length - 1, i + 1)];
        else if (e.key === 'ArrowUp') next = layout.boxes[Math.max(0, i - 1)];
        else if (e.key === 'Home') next = layout.boxes[0];
        else if (e.key === 'End') next = layout.boxes[layout.boxes.length - 1];
        else if (e.key === 'ArrowRight') { if (!expanded(b.id) && b.item.kind !== 'star') activate(b); else next = layout.boxes.find(c => c.parent === b.id); }
        else if (e.key === 'ArrowLeft') { if (expanded(b.id) && b.id !== 'u') activate(b); else next = byId.get(b.parent); }
        else if (e.key === 'Enter' || e.key === ' ') activate(b);
        else return;
        e.preventDefault(); e.stopPropagation();
        if (next) { const id = next.id; setCursor(id); focus(id); requestAnimationFrame(() => viewport.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true })); }
      }}>
      <div className={s.space} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})` }}>
        <svg className={s.connections} aria-hidden="true" width="1" height="1">
          {layout.paths.filter(p => visibleIds.has(p.id) || visibleIds.has(p.parent)).map(p => <g key={p.id} className={s.connection} data-lit={highlighted.has(p.id)} style={{ '--branch': p.color } as CSSProperties}>
            <path d={p.d} className={s.wireHalo} /><path d={p.d} className={s.wire} /><path d={p.d} pathLength={100} className={s.flow} />
          </g>)}
          {secondary.map(p => <path key={p.id} d={p.d} className={s.secondary} />)}
        </svg>
        {visible.map(b => {
          const t = b.item, n = t.node >= 0 ? graph.nodes[t.node] : null;
          const mem = t.kind === 'star' && n && (n.kind === 'word' || n.kind === 'grammar') ? memoryOf(n, graph.generatedAt) : null;
          const due = t.kind === 'star' && n?.kind === 'word' && n.dueAt > 0 && n.dueAt <= graph.generatedAt && n.stage !== 'saved';
          const isOpen = expanded(t.id), siblings = index.kids.get(t.parent) ?? [];
          return <div key={b.id} className={s.nodePosition} style={{ transform: `translate(${b.x - b.w / 2}px, ${b.y - b.h / 2}px)`, width: b.w, minHeight: b.h }}>
            <div role="treeitem" tabIndex={b.id === (byId.has(cursor) ? cursor : 'u') ? 0 : -1} data-tree-id={b.id}
              aria-level={t.depth + (b.remaining ? 2 : 1)} aria-selected={b.id === selected} aria-expanded={t.kind !== 'star' && !b.remaining ? isOpen : undefined}
              aria-setsize={siblings.length || 1} aria-posinset={Math.max(1, siblings.indexOf(t) + 1)}
              className={s.node} data-kind={b.remaining ? 'more' : t.kind} data-selected={b.id === selected} data-open={isOpen}
              style={{ '--tone': t.color, minHeight: b.h } as CSSProperties} title={b.remaining ? undefined : [t.label, t.sub].filter(Boolean).join(' · ')}
              onFocus={() => setCursor(b.id)} onClick={() => activate(b)}>
              {b.remaining ? <><Plus size={17} /><span>{T(`Hiện thêm ${b.remaining} mục`, `Show ${b.remaining} more`)}</span></> : <>
                <span className={s.orb} aria-hidden="true"><span className={s.orbRing} />{t.kind === 'universe' || t.kind === 'galaxy' ? <Orbit /> : t.kind === 'system' ? <Atom /> : t.kind === 'constellation' ? <Waypoints /> : n?.kind === 'grammar' ? <BookOpen /> : n?.kind === 'source' ? <FileText /> : <span className={s.core} />}</span>
                <span className={s.nodeText}><strong>{t.label}</strong><small>{t.kind === 'universe' ? T('Gốc tri thức', 'Knowledge root') : t.kind === 'star' ? (mem ? MEMORY_LABEL[mem.state][vi ? 0 : 1] : t.sub) : T(`${t.count} ngôi sao${t.met ? ` · +${t.met} đã gặp` : ''}`, `${t.count} stars${t.met ? ` · +${t.met} encountered` : ''}`)}</small>{due && <em>{T('Đến hạn ôn', 'Due for review')}</em>}</span>
                {t.kind !== 'star' && <span className={s.expand} aria-hidden="true">{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>}
              </>}
            </div>
          </div>;
        })}
      </div>
    </div>
    <div className={s.caption}><span>{T('Kéo để di chuyển · Cuộn để thu phóng', 'Drag to pan · Scroll to zoom')}</span><span><i />{T('Nhánh phân cấp', 'Hierarchy')}{secondary.length > 0 && <><i className={s.relationKey} />{T('Quan hệ đã kiểm chứng', 'Verified relation')}</>}</span></div>
  </div>;
}
