'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  BookOpen, CalendarDays, CheckSquare, Clock3, Compass, ExternalLink, EyeOff, Headphones, Layers, Link2, ListTodo, Lock, Mic,
  Music2, NotebookPen, Pause, PenLine, Play, Plus, Search, SkipBack, SkipForward, StickyNote, Timer, TrendingUp, Waves,
} from 'lucide-react';
import { useMusic } from '@/components/music/MusicProvider';
import { MusicArtwork } from '@/components/music/MusicArtwork';
import { widgetSize } from '@/lib/study-space/widgetGeometry';
import { learningPathApi } from '@/services/learningPathApi';
import { lookupCanonical } from '@/services/dictionaryEngine';
import type { CanonicalDictionaryEntry } from '@/services/dictionary/types';
import { ops, useSpace } from '@/lib/study-space/store';
import type { Widget, WidgetType } from '@/lib/study-space/types';
import { ambientMixer, AMBIENT_PRESETS, CHANNELS, type AmbientLevels } from '@/lib/study-space/ambient';
import useSWR from 'swr';
import { FocusFace } from './FocusControls';
import { useAccount, useDueCards, useFocus, useFocusStats, useNotes, useTasks } from './data';
import { useNow } from './useNow';
import s from './studySpace.module.css';
import FlashcardSave from './FlashcardSave';

export const WIDGET_META: Record<WidgetType, { label: string; icon: React.ComponentType<{ size?: number }> }> = {
  focus: { label: 'Đồng hồ tập trung', icon: Timer },
  tasks: { label: 'Việc cần làm', icon: ListTodo },
  note: { label: 'Ghi chú dán', icon: StickyNote },
  clock: { label: 'Đồng hồ', icon: Clock3 },
  calendar: { label: 'Lịch', icon: CalendarDays },
  music: { label: 'Âm nhạc', icon: Music2 },
  ambient: { label: 'Âm thanh nền', icon: Waves },
  flashcards: { label: 'Thẻ cần ôn', icon: Layers },
  path: { label: 'Lộ trình hôm nay', icon: Compass },
  stats: { label: 'Thống kê tập trung', icon: TrendingUp },
  dictionary: { label: 'Tra từ nhanh', icon: Search },
  links: { label: 'Lối tắt học tập', icon: Link2 },
  countdown: { label: 'Đếm ngược hạn chót', icon: Timer },
  quote: { label: 'Lời nhắc của tôi', icon: PenLine },
};

const NOTE_CLASS: Record<string, string> = { sun: s.noteSun, rose: s.noteRose, mint: s.noteMint, sky: s.noteSky, lilac: s.noteLilac, sand: s.noteSand };

// ── Frame ─────────────────────────────────────────────────────────────────────────────────────────────────
function useViewport() {
  const [vp, setVp] = useState({ w: 1280, h: 800 });
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

export function WidgetLayer({ onOpen }: { onOpen: (panel: string) => void }) {
  const widgets = useSpace((st) => st.layout.widgets);
  const mode = useSpace((st) => st.mode);
  const selection = useSpace((st) => st.selection);
  const vp = useViewport();
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const [sheet, setSheet] = useState<string | null>(null);
  if (vp.w < 700) {
    // Phones: tools wait in a tray of chips at the bottom; one opens as a sheet, the room stays visible.
    const shown = widgets.filter((w) => !w.hidden);
    const open = shown.find((w) => w.id === sheet);
    const sheetHeight = open ? Math.min(open.h + (open.type === 'music' || open.type === 'clock' ? 42 : 0), vp.h - 100) : 0;
    return (
      <div className={s.widgets} data-testid="study-widgets">
        {open && (
          <section className={`${s.widget} ${s.glass}`} style={{ left: 10, right: 10, bottom: 74, height: sheetHeight, position: 'absolute', zIndex: 20 }} aria-label={WIDGET_META[open.type].label} data-widget={open.type}>
            <header className={s.widgetHead}>{React.createElement(WIDGET_META[open.type].icon, { size: 16 })}<span style={{ flex: 1 }}>{WIDGET_META[open.type].label}</span>
              <button type="button" className={s.iconBtn} onClick={() => setSheet(null)} aria-label="Thu gọn">×</button></header>
            <div className={s.widgetBody}><WidgetBody w={{ ...open, w: vp.w - 20, h: sheetHeight }} onOpen={onOpen} /></div>
          </section>
        )}
        {shown.length > 0 && (
          <nav className={s.glass} style={{ position: 'absolute', left: 10, right: 10, bottom: 10, padding: 6, display: 'flex', gap: 6, overflowX: 'auto', pointerEvents: 'auto', borderRadius: 18 }} aria-label="Công cụ của bạn">
            {shown.map((w) => {
              const M = WIDGET_META[w.type];
              return <button key={w.id} type="button" className={`${s.btn} ${sheet === w.id ? s.primary : ''}`} style={{ flexShrink: 0, padding: '8px 10px' }} onClick={() => setSheet(sheet === w.id ? null : w.id)} aria-pressed={sheet === w.id}><M.icon size={15} />{M.label}</button>;
            })}
          </nav>
        )}
      </div>
    );
  }
  return (
    <div className={s.widgets} data-testid="study-widgets">
      {widgets.filter((w) => !w.hidden).map((w) => (
        <WidgetFrame key={w.id} w={w} vp={vp} edit={mode === 'edit'} selected={selection.includes(`w:${w.id}`)} others={widgets} onGuides={setGuides} onOpen={onOpen} />
      ))}
      {guides.x !== undefined && <div className={s.guide} style={{ left: guides.x, top: 0, bottom: 0, width: 1 }} />}
      {guides.y !== undefined && <div className={s.guide} style={{ top: guides.y, left: 0, right: 0, height: 1 }} />}
    </div>
  );
}

function WidgetFrame({ w, vp, edit, selected, others, onGuides, onOpen }: {
  w: Widget; vp: { w: number; h: number }; edit: boolean; selected: boolean; others: Widget[];
  onGuides: (g: { x?: number; y?: number }) => void; onOpen: (panel: string) => void;
}) {
  const { w: width, h: height } = widgetSize(w.type, w.w, w.h, vp);
  const left = Math.max(8, Math.min(vp.w - width - 8, w.x * vp.w));
  const top = Math.max(8, Math.min(vp.h - height - 8, w.y * vp.h));
  const drag = useRef<{ sx: number; sy: number; x: number; y: number; w: number; h: number; kind: 'move' | 'resize'; merge: string } | null>(null);

  const start = (e: React.PointerEvent, kind: 'move' | 'resize') => {
    if (!edit || w.locked) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    useSpace.getState().select([`w:${w.id}`], e.shiftKey);
    drag.current = { sx: e.clientX, sy: e.clientY, x: left, y: top, w: width, h: height, kind, merge: `w-${w.id}-${Date.now()}` };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (d.kind === 'resize') {
      ops.widget(w.id, widgetSize(w.type, Math.round(d.w + dx), Math.round(d.h + dy), { w: vp.w - left + 8, h: vp.h - top + 8 }), d.merge);
      return;
    }
    let nx = d.x + dx, ny = d.y + dy;
    // alignment guides: viewport centre and the edges / centres of the other widgets
    const xs = [vp.w / 2 - width / 2, 16, vp.w - width - 16], ys = [vp.h / 2 - height / 2, 16, vp.h - height - 16];
    others.filter((o) => o.id !== w.id && !o.hidden).forEach((o) => {
      const ox = o.x * vp.w, oy = o.y * vp.h;
      xs.push(ox, ox + o.w - width, ox + o.w + 12, ox - width - 12);
      ys.push(oy, oy + o.h - height, oy + o.h + 12, oy - height - 12);
    });
    let gx: number | undefined, gy: number | undefined;
    for (const x of xs) if (Math.abs(nx - x) < 7) { nx = x; gx = x; break; }
    for (const y of ys) if (Math.abs(ny - y) < 7) { ny = y; gy = y; break; }
    onGuides({ x: gx, y: gy });
    ops.widget(w.id, { x: Math.max(8, Math.min(vp.w - width - 8, nx)) / vp.w, y: Math.max(8, Math.min(vp.h - height - 8, ny)) / vp.h }, d.merge);
  };
  const end = () => { drag.current = null; onGuides({}); };

  const meta = WIDGET_META[w.type];
  const Icon = meta.icon;
  const isNote = w.type === 'note';
  const noteColor = useNoteColor(w);
  return (
    <section
      className={`${s.widget} ${s.glass} ${isNote ? `${s.note} ${NOTE_CLASS[noteColor] ?? s.noteSun}` : ''} ${edit ? s.widgetEdit : ''} ${selected ? s.widgetSelected : ''}`}
      style={{ left, top, width, height, zIndex: w.z, opacity: w.opacity ?? 1 }}
      aria-label={meta.label}
      data-widget={w.type}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      {w.type !== 'music' && w.type !== 'clock' && (
        <header className={s.widgetHead}>
          <Icon size={16} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.type === 'quote' ? (String(w.settings?.title ?? '') || meta.label) : meta.label}</span>
          {w.locked && <Lock size={13} aria-label="Đã khóa vị trí" />}
          {!edit && (
            <button type="button" className={s.iconBtn} style={{ width: 24, height: 24 }} title="Ẩn công cụ này (dữ liệu vẫn được giữ)" aria-label={`Ẩn ${meta.label}`}
              onClick={() => ops.widget(w.id, { hidden: true })}><EyeOff size={13} /></button>
          )}
        </header>
      )}
      <div className={s.widgetBody} style={w.type === 'music' || w.type === 'clock' ? { padding: 12 } : undefined}>
        <WidgetBody w={{ ...w, w: width, h: height }} onOpen={onOpen} />
      </div>
      {edit && !w.locked && <button type="button" className={s.widgetCover} onPointerDown={(e) => start(e, 'move')} aria-label={`Di chuyển ${meta.label}`} onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault(); const step = e.shiftKey ? 32 : 8;
        ops.widget(w.id, { x: Math.max(8, Math.min(vp.w - width - 8, left + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0))) / vp.w,
          y: Math.max(8, Math.min(vp.h - height - 8, top + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0))) / vp.h });
      }} />}
      {edit && !w.locked && <button type="button" className={s.resize} onPointerDown={(e) => start(e, 'resize')} aria-label={`Đổi kích thước ${meta.label}`} onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault(); const step = e.shiftKey ? 32 : 8;
        ops.widget(w.id, widgetSize(w.type, width + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0), height + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0), vp));
      }} />}
    </section>
  );
}

function useNoteColor(w: Widget) {
  const { notes } = useNotes();
  if (w.type !== 'note') return '';
  return notes.find((n) => n.id === w.refId)?.color ?? String(w.settings?.color ?? 'sun');
}

function WidgetBody({ w, onOpen }: { w: Widget; onOpen: (panel: string) => void }) {
  switch (w.type) {
    case 'focus': return <FocusWidget onOpen={onOpen} width={w.w} height={w.h} />;
    case 'tasks': return <TasksWidget onOpen={onOpen} />;
    case 'note': return <NoteWidget w={w} />;
    case 'clock': return <ClockWidget />;
    case 'calendar': return <CalendarWidget onOpen={onOpen} />;
    case 'music': return <MusicWidget />;
    case 'ambient': return <AmbientWidget onOpen={onOpen} />;
    case 'flashcards': return <FlashcardsWidget />;
    case 'path': return <PathWidget />;
    case 'stats': return <StatsWidget onOpen={onOpen} />;
    case 'dictionary': return <DictionaryWidget />;
    case 'links': return <LinksWidget />;
    case 'countdown': return <CountdownWidget w={w} />;
    case 'quote': return <QuoteWidget w={w} />;
    default: return null;
  }
}

// ── Bodies ────────────────────────────────────────────────────────────────────────────────────────────────
function FocusWidget({ onOpen, width, height }: { onOpen: (p: string) => void; width: number; height: number }) {
  const { state, engine } = useFocus();
  const { tasks } = useTasks();
  const task = tasks.find((t) => t.id === state.taskId);
  return (
    <div className={s.focusWidget}>
      <FocusFace state={state} engine={engine} size={Math.max(112, Math.min(260, height - 160, width - 40))} compact />
      <button type="button" className={s.btn} style={{ fontSize: 12, padding: '6px 10px', maxWidth: '100%' }} onClick={() => onOpen('focus')}>
        {task ? `Đang gắn: ${task.title.slice(0, 22)}` : 'Cài đặt và thống kê'}
      </button>
    </div>
  );
}

function TasksWidget({ onOpen }: { onOpen: (p: string) => void }) {
  const { tasks, create, update, loading } = useTasks();
  const [title, setTitle] = useState('');
  const open = tasks.filter((t) => t.status !== 'DONE').slice(0, 8);
  const doneToday = tasks.filter((t) => t.status === 'DONE' && t.doneAt && new Date(t.doneAt).toDateString() === new Date().toDateString()).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <form onSubmit={(e) => { e.preventDefault(); const t = title.trim(); if (!t) return; setTitle(''); void create({ title: t }); }} style={{ display: 'flex', gap: 6 }}>
        <input className={s.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Thêm việc cần làm…" aria-label="Thêm việc cần làm" maxLength={200} />
        <button type="submit" className={s.iconBtn} aria-label="Thêm"><Plus size={16} /></button>
      </form>
      {loading && <div className={s.hint}>Đang tải…</div>}
      {!loading && open.length === 0 && <div className={s.hint}>Chưa có việc nào đang mở.</div>}
      {open.map((t) => (
        <label key={t.id} className={s.row} style={{ cursor: 'pointer', padding: '6px 8px' }}>
          <input type="checkbox" className={s.check} checked={false} onChange={() => void update(t.id, { status: 'DONE' })} aria-label={`Hoàn thành ${t.title}`} />
          <span style={{ flex: 1, minWidth: 0 }}>{t.title}</span>
          {t.recurrence !== 'NONE' && <span className={s.chip}>{t.recurrence === 'DAILY' ? 'Hằng ngày' : 'Hằng tuần'}</span>}
        </label>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <span className={s.hint}>Hoàn thành hôm nay: {doneToday}</span>
        <button type="button" className={s.btn} style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => onOpen('planner')}>Mở kế hoạch</button>
      </div>
    </div>
  );
}

function NoteWidget({ w }: { w: Widget }) {
  const { notes, create, update } = useNotes();
  const note = notes.find((n) => n.id === w.refId);
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const creating = useRef(false);
  const value = text ?? note?.body ?? '';
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const save = (body: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (note) await update(note.id, { body });
      else if (!creating.current) {
        creating.current = true;
        const made = await create({ kind: 'NOTE', title: body.split('\n')[0].slice(0, 60), body, color: (w.settings?.color as never) ?? 'sun' });
        ops.widget(w.id, { refId: made.id });
        creating.current = false;
      }
    }, 700);
  };
  return (
    <textarea className={s.noteText} value={value} placeholder="Viết ghi chú…" aria-label="Nội dung ghi chú"
      onChange={(e) => { setText(e.target.value); save(e.target.value); }} />
  );
}

const VI_DAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
function ClockWidget() {
  const now = new Date(useNow(1000));
  return (
    <div className={s.clockWidget}>
      <div className={s.clockDigits}>
        {String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}
      </div>
      <div className={s.clockDate}>{VI_DAYS[now.getDay()]}, {now.getDate()}/{now.getMonth() + 1}/{now.getFullYear()}</div>
    </div>
  );
}

export function MonthGrid({ month, onPick, marks }: { month: Date; onPick?: (d: Date) => void; marks: (d: Date) => React.ReactNode }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i - startOffset + 1));
  const today = new Date().toDateString();
  return (
    <div>
      <div className={s.calendar} style={{ marginBottom: 4 }}>
        {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((d) => <div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 800, color: 'var(--ink-faint)' }}>{d}</div>)}
      </div>
      <div className={s.calendar}>
        {days.map((d) => (
          <button type="button" key={d.toISOString()} className={`${s.day} ${d.toDateString() === today ? s.dayToday : ''} ${d.getMonth() !== month.getMonth() ? s.dayMuted : ''}`}
            onClick={() => onPick?.(d)} style={{ border: 0, cursor: onPick ? 'pointer' : 'default', textAlign: 'left' }}>
            <span className={s.dayNum}>{d.getDate()}</span>
            {marks(d)}
          </button>
        ))}
      </div>
    </div>
  );
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export { isoDay };

function CalendarWidget({ onOpen }: { onOpen: (p: string) => void }) {
  const { tasks } = useTasks();
  const month = new Date();
  const due = useMemo(() => {
    const m = new Map<string, number>();
    tasks.filter((t) => t.dueOn && t.status !== 'DONE').forEach((t) => m.set(t.dueOn!, (m.get(t.dueOn!) ?? 0) + 1));
    return m;
  }, [tasks]);
  return (
    <div>
      <div style={{ fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>Tháng {month.getMonth() + 1}/{month.getFullYear()}</div>
      <div className={s.calendarWidget}>
        <MonthGrid month={month} onPick={() => onOpen('planner')} marks={(d) => (due.get(isoDay(d)) ? <span className={s.chip} style={{ padding: '0 5px' }}>{due.get(isoDay(d))}</span> : null)} />
      </div>
    </div>
  );
}

function MusicWidget() {
  const { engine, current, playing, ready } = useMusic();
  return (
    <div className={s.musicWidget}>
      {current ? <MusicArtwork track={current} className={s.musicCover} decorative /> : <div className={s.musicCover}><Music2 size={26} /></div>}
      <div className={s.musicDetails}>
        <div style={{ fontWeight: 800, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{current?.title ?? 'Echo Music'}</div>
        <div className={s.hint} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{current?.artist ?? (ready ? 'Chọn một bản nhạc để bắt đầu' : 'Đang chuẩn bị…')}</div>
        <div className={s.musicControls}>
          <button type="button" className={s.iconBtn} onClick={() => void engine?.next(-1)} aria-label="Bài trước"><SkipBack size={16} /></button>
          <button type="button" className={`${s.iconBtn}`} style={{ background: 'linear-gradient(135deg,#8b7cf0,#6a8cf5)', color: '#fff' }} onClick={() => { if (!engine) return; if (playing) engine.pause(); else if (current) void engine.play(); else { const first = engine.tracks()[0]; if (first) void engine.select(first.id); } }} aria-label={playing ? 'Tạm dừng nhạc' : 'Phát nhạc'}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button type="button" className={s.iconBtn} onClick={() => void engine?.next()} aria-label="Bài tiếp theo"><SkipForward size={16} /></button>
          <Link href="/music" className={s.iconBtn} aria-label="Mở Âm nhạc" title="Mở Âm nhạc"><ExternalLink size={15} /></Link>
        </div>
      </div>
    </div>
  );
}

export function useAmbient() {
  const mixer = ambientMixer();
  const [state, setState] = useState<AmbientLevels>(mixer.state);
  const [on, setOn] = useState(mixer.playing);
  const set = async (next: AmbientLevels) => { await mixer.start(); mixer.set(next); setState(next); setOn(mixer.playing); };
  return { state, on, set, stop: async () => { await mixer.stop(); setOn(false); } };
}

function AmbientWidget({ onOpen }: { onOpen: (p: string) => void }) {
  const { state, set, on, stop } = useAmbient();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {AMBIENT_PRESETS.map((p) => (
          <button key={p.id} type="button" className={s.btn} style={{ fontSize: 12, padding: '5px 10px' }}
            onClick={() => void set({ ...state, muted: false, levels: { ...Object.fromEntries(CHANNELS.map((c) => [c.id, 0])), ...p.levels } as AmbientLevels['levels'] })}>{p.label}</button>
        ))}
      </div>
      {CHANNELS.slice(0, 4).map((c) => (
        <label key={c.id} style={{ display: 'grid', gridTemplateColumns: '78px 1fr', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700 }}>
          {c.label}
          <input type="range" className={s.range} min={0} max={1} step={0.05} value={state.levels[c.id]}
            onChange={(e) => void set({ ...state, muted: false, levels: { ...state.levels, [c.id]: Number(e.target.value) } })} aria-label={`Âm lượng ${c.label}`} />
        </label>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        {on && <button type="button" className={s.btn} style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => void stop()}>Tắt</button>}
        <button type="button" className={s.btn} style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => onOpen('ambient')}>Bộ trộn đầy đủ</button>
      </div>
    </div>
  );
}

function FlashcardsWidget() {
  const { data, isLoading } = useDueCards();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--ink)' }}>{isLoading ? '…' : data === null || data === undefined ? '—' : data}</div>
      <div className={s.hint}>thẻ đến hạn ôn hôm nay</div>
      <Link href="/flashcards" className={`${s.btn} ${s.primary}`} style={{ alignSelf: 'flex-start' }}><Layers size={15} /> Ôn ngay</Link>
    </div>
  );
}

function PathWidget() {
  const account = useAccount();
  const { data, isLoading, error } = useSWR(account ? ['study-space/path', account] : null, () => learningPathApi.today(), { revalidateOnFocus: false });
  if (isLoading) return <div className={s.hint}>Đang tải lộ trình…</div>;
  if (error || !data) return <div className={s.hint}>Chưa đọc được lộ trình. <Link href="/learning-path" style={{ color: 'var(--accent)' }}>Mở Lộ trình học</Link></div>;
  if (!data.plan) return <div className={s.hint}>Bạn chưa đặt mục tiêu. <Link href="/learning-path" style={{ color: 'var(--accent)' }}>Bắt đầu lộ trình</Link></div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontWeight: 800, color: 'var(--ink)' }}>Đã xong {data.done}/{data.total} việc · {data.minutes} phút</div>
      {data.tasks.slice(0, 5).map((t) => (
        <div key={t.id} className={s.row} style={{ cursor: 'default' }}>
          <CheckSquare size={15} color={t.status === 'DONE' ? '#2fae84' : '#8a8db0'} />
          <span className={t.status === 'DONE' ? s.done : undefined} style={{ flex: 1 }}>{t.title}</span>
        </div>
      ))}
      <Link href="/learning-path" className={s.btn} style={{ alignSelf: 'flex-start', fontSize: 12, padding: '5px 10px' }}>Mở Lộ trình học</Link>
    </div>
  );
}

export function formatDuration(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} giờ ${m} phút` : `${m} phút`;
}

function StatsWidget({ onOpen }: { onOpen: (p: string) => void }) {
  const { data } = useFocusStats(7);
  const max = Math.max(1, ...(data?.days.map((d) => d.focusedSeconds) ?? [1]));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 800, color: 'var(--ink)', fontSize: 18 }}>{data ? formatDuration(data.totalSeconds) : '…'}</div>
      <div className={s.hint}>7 ngày qua · chuỗi {data?.streakDays ?? '—'} ngày · {data?.completed ?? '—'} phiên trọn vẹn</div>
      <div className={s.bars} style={{ height: 70 }}>
        {(data?.days ?? []).map((d) => <div key={d.day} className={s.bar} style={{ height: `${(d.focusedSeconds / max) * 100}%` }} title={`${d.day}: ${formatDuration(d.focusedSeconds)}`} />)}
      </div>
      <button type="button" className={s.btn} style={{ fontSize: 12, padding: '5px 10px', alignSelf: 'flex-start' }} onClick={() => onOpen('focus')}>Xem chi tiết</button>
    </div>
  );
}

function DictionaryWidget() {
  const [q, setQ] = useState('');
  const [entry, setEntry] = useState<CanonicalDictionaryEntry | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try { setEntry(await lookupCanonical(q, 'en-vi')); } catch { setEntry(null); } finally { setBusy(false); }
  };
  const vi = entry?.generalTranslationVi ?? entry?.vietnameseSenses?.[0]?.meanings.slice(0, 3).join('; ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <form onSubmit={search} style={{ display: 'flex', gap: 6 }}>
        <input className={s.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nhập một từ tiếng Anh…" aria-label="Từ cần tra" />
        <button type="submit" className={s.iconBtn} aria-label="Tra từ"><Search size={16} /></button>
      </form>
      {busy && <div className={s.hint}>Đang tra…</div>}
      {!busy && entry === null && <div className={s.hint}>Không tìm thấy từ này.</div>}
      {!busy && entry && (
        <div>
          <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--ink)' }}>{entry.headword} <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink-faint)' }}>{entry.pronunciations[0]?.ipa}</span></div>
          {vi && <div style={{ fontWeight: 700, color: 'var(--accent)', margin: '4px 0' }}>{vi}</div>}
          {entry.partsOfSpeech.slice(0, 2).map((p) => (
            <div key={p.partOfSpeech} style={{ fontSize: 12, marginTop: 4 }}><b>{p.partOfSpeech}</b> — {p.senses[0]?.definitionEn}</div>
          ))}
          <FlashcardSave key={entry.headword} entry={entry} />
        </div>
      )}
    </div>
  );
}

const LINKS = [
  { href: '/reading', label: 'Đọc', icon: BookOpen }, { href: '/listening', label: 'Nghe', icon: Headphones }, { href: '/speaking', label: 'Luyện nói', icon: Mic },
  { href: '/writing', label: 'Viết', icon: PenLine }, { href: '/flashcards', label: 'Thẻ từ vựng', icon: Layers }, { href: '/grammar', label: 'Ngữ pháp', icon: NotebookPen },
  { href: '/learning-path', label: 'Lộ trình', icon: Compass }, { href: '/exams', label: 'Thi thử', icon: CheckSquare }, { href: '/progress', label: 'Tiến trình', icon: TrendingUp },
];
function LinksWidget() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 6 }}>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={s.row} style={{ flexDirection: 'column', gap: 4, padding: 8, textAlign: 'center', fontSize: 11.5, fontWeight: 700 }}>
          <l.icon size={18} />{l.label}
        </Link>
      ))}
    </div>
  );
}

function CountdownWidget({ w }: { w: Widget }) {
  const now = useNow(1000);
  const target = typeof w.settings?.target === 'string' ? new Date(w.settings.target) : null;
  const label = String(w.settings?.label ?? '');
  const diff = target ? target.getTime() - now : 0;
  const d = Math.floor(Math.abs(diff) / 86_400_000), h = Math.floor((Math.abs(diff) % 86_400_000) / 3_600_000), m = Math.floor((Math.abs(diff) % 3_600_000) / 60_000);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input className={s.input} value={label} placeholder="Tên mốc (ví dụ: Thi IELTS)" aria-label="Tên mốc"
        onChange={(e) => ops.widget(w.id, { settings: { ...w.settings, label: e.target.value.slice(0, 60) } }, `cd-label-${w.id}`)} />
      <input className={s.input} type="datetime-local" value={typeof w.settings?.target === 'string' ? w.settings.target : ''} aria-label="Thời điểm"
        onChange={(e) => ops.widget(w.id, { settings: { ...w.settings, target: e.target.value } })} />
      {target && !Number.isNaN(target.getTime()) && (
        <div style={{ fontWeight: 800, color: diff < 0 ? 'var(--danger)' : 'var(--ink)', fontSize: 18 }}>
          {diff < 0 ? 'Đã qua ' : 'Còn '}{d} ngày {h} giờ {m} phút
        </div>
      )}
    </div>
  );
}

function QuoteWidget({ w }: { w: Widget }) {
  return (
    <textarea className={s.noteText} style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }} placeholder="Viết lời nhắc cho chính bạn…" aria-label="Lời nhắc"
      value={String(w.settings?.text ?? '')} onChange={(e) => ops.widget(w.id, { settings: { ...w.settings, text: e.target.value.slice(0, 400) } }, `q-${w.id}`)} />
  );
}

export const WIDGET_TYPES_OFFERED: WidgetType[] = ['focus', 'tasks', 'note', 'clock', 'calendar', 'music', 'ambient', 'flashcards', 'path', 'stats', 'dictionary', 'links', 'countdown', 'quote'];
