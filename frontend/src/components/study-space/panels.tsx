'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays, Columns3, Download, Eye, FileText, LayoutGrid, Link2, List, NotebookPen, PanelTopOpen, Pin, Plus, Repeat, Search,
  Shirt, SlidersHorizontal, Timer, Trash2, Waves, X,
} from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { COLOR_SWATCHES, SIGNATURE, isSignature, normalizeLook, slotItems, type AvatarLook } from '@/lib/avatar/look';
import { PRESETS, type FocusMode } from '@/lib/study-space/focus';
import { ops, useSpace } from '@/lib/study-space/store';
import type { Activity, StudyNote, StudyTask } from '@/lib/study-space/types';
import { CHANNELS, AMBIENT_PRESETS, type AmbientLevels } from '@/lib/study-space/ambient';
import { FocusFace } from './FocusControls';
import { useFocus, useFocusStats, useNotes, useTasks } from './data';
import Markdown from './Markdown';
import { MonthGrid, formatDuration, isoDay, useAmbient } from './widgets';
import { openPortableTimer } from './portable';
import s from './studySpace.module.css';
import TimePlanner from './TimePlanner';
import {useDialogFocus} from './useDialogFocus';
import { useMorphPresence } from '@/components/morph/useMorphPresence';

export function Panel({ title, icon, onClose, children, actions, side = false, closeLabel = 'Đóng' }: { title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode; side?: boolean; closeLabel?: string }) {
  const dialog=useRef<HTMLDivElement>(null);
  // The panel itself leaves on the shared spring, reversible, then tells its owner: it is the same React tree all the way out.
  const [open,setOpen]=useState(true);
  const dismiss=()=>setOpen(false);
  const presence=useMorphPresence(open,dialog,{onDismiss:dismiss});
  useEffect(()=>{if(!presence.present)onClose();},[presence.present]); // eslint-disable-line react-hooks/exhaustive-deps
  useDialogFocus(dialog,dismiss,open);
  return (
    <div className={`${s.panelWrap} ${side ? s.panelWrapSide : ''}`} data-closing={!open||undefined} onPointerDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
      <div ref={dialog} className={`${s.panel} ${s.glass} ${side ? s.panelSide : ''}`} role="dialog" aria-modal={side ? undefined : true} aria-label={title} {...presence.panelProps}>
        <header className={s.panelHead}>
          <div className={s.panelTitle}>{icon}{title}</div>
          {actions}
          <button type="button" className={s.iconBtn} onClick={dismiss} aria-label={closeLabel}><X size={18} /></button>
        </header>
        <div className={s.panelBody}>{children}</div>
      </div>
    </div>
  );
}

// ── Focus ─────────────────────────────────────────────────────────────────────────────────────────────────
export function FocusPanel({ onClose, portable = true }: { onClose: () => void; portable?: boolean }) {
  const { state, engine } = useFocus();
  const { tasks } = useTasks();
  const [days, setDays] = useState(7);
  const { data } = useFocusStats(days);
  const st = state.settings;
  const max = Math.max(1, ...(data?.days.map((d) => d.focusedSeconds) ?? [1]));
  const goalDone = data?.days[data.days.length - 1]?.completed ?? 0;
  const mode = (m: FocusMode) => engine.setMode(m);
  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || min)));
  const taskTitle = (id: string) => tasks.find((t) => t.id === id)?.title ?? 'Việc đã xóa';
  return (
    <Panel title="Đồng hồ tập trung" icon={<Timer size={20} />} onClose={onClose}
      actions={portable && <button type="button" className={s.btn} onClick={() => void openPortableTimer()} title="Đồng hồ nổi trên các tab khác"><PanelTopOpen size={15} /> Cửa sổ nổi</button>}>
      <div className={s.cols} style={{ gridTemplateColumns: 'minmax(280px, 380px) 1fr' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 6 }} role="tablist" aria-label="Chế độ">
            {([['POMODORO', 'Pomodoro'], ['COUNTDOWN', 'Đếm ngược'], ['STOPWATCH', 'Bấm giờ']] as const).map(([m, l]) => (
              <button key={m} type="button" role="tab" aria-selected={state.mode === m} disabled={state.status !== 'idle'} className={`${s.btn} ${state.mode === m ? s.primary : ''}`} onClick={() => mode(m)}>{l}</button>
            ))}
          </div>
          <FocusFace state={state} engine={engine} size={250} />
          {state.status !== 'idle' && state.status !== undefined && <div className={s.hint}>Phiên đang chạy trên mọi tab và cửa sổ của bạn.</div>}
          <div style={{ width: '100%', display: 'grid', gap: 10 }}>
            <label className={s.field}>Gắn với việc cần làm
              <select className={s.select} value={state.taskId ?? ''} onChange={(e) => { const t = tasks.find((x) => x.id === e.target.value); engine.setTask(t?.id ?? null, t?.title ?? null); }}>
                <option value="">Không gắn</option>
                {tasks.filter((t) => t.status !== 'DONE').map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            </label>
            <label className={s.field}>Môn học hoặc chủ đề
              <input className={s.input} list="focus-subjects" value={state.subject ?? ''} maxLength={40} onChange={(e) => engine.setSubject(e.target.value || null)} placeholder="Ví dụ: IELTS Reading" />
              <datalist id="focus-subjects">{['Reading', 'Listening', 'Speaking', 'Writing', 'Từ vựng', 'Ngữ pháp', 'Nghiên cứu'].map((x) => <option key={x} value={x} />)}</datalist>
            </label>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section>
            <div className={s.drawerTitle} style={{ marginBottom: 8 }}>Thiết lập</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {PRESETS.map((p) => (
                <button key={p.id} type="button" className={`${s.btn} ${st.focusMin === p.focus && st.shortMin === p.short ? s.primary : ''}`} disabled={state.status !== 'idle'}
                  onClick={() => engine.setSettings({ focusMin: p.focus, shortMin: p.short, longMin: p.long, cyclesBeforeLong: p.cycles })}>{p.label}</button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
              <label className={s.field}>Tập trung (phút)<input className={s.input} type="number" min={1} max={240} value={st.focusMin} disabled={state.status !== 'idle'} onChange={(e) => engine.setSettings({ focusMin: num(e.target.value, 1, 240) })} /></label>
              <label className={s.field}>Nghỉ ngắn (phút)<input className={s.input} type="number" min={1} max={60} value={st.shortMin} onChange={(e) => engine.setSettings({ shortMin: num(e.target.value, 1, 60) })} /></label>
              <label className={s.field}>Nghỉ dài (phút)<input className={s.input} type="number" min={1} max={90} value={st.longMin} onChange={(e) => engine.setSettings({ longMin: num(e.target.value, 1, 90) })} /></label>
              <label className={s.field}>Số phiên trước nghỉ dài<input className={s.input} type="number" min={1} max={12} value={st.cyclesBeforeLong} onChange={(e) => engine.setSettings({ cyclesBeforeLong: num(e.target.value, 1, 12) })} /></label>
              <label className={s.field}>Đếm ngược (phút)<input className={s.input} type="number" min={1} max={720} value={st.countdownMin} disabled={state.status !== 'idle'} onChange={(e) => engine.setSettings({ countdownMin: num(e.target.value, 1, 720) })} /></label>
              <label className={s.field}>Mục tiêu mỗi ngày (phiên)<input className={s.input} type="number" min={1} max={24} value={st.dailyGoal} onChange={(e) => engine.setSettings({ dailyGoal: num(e.target.value, 1, 24) })} /></label>
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13, fontWeight: 700 }}>
              <label><input type="checkbox" checked={st.autoBreaks} onChange={(e) => engine.setSettings({ autoBreaks: e.target.checked })} /> Tự bắt đầu giờ nghỉ</label>
              <label><input type="checkbox" checked={st.autoFocus} onChange={(e) => engine.setSettings({ autoFocus: e.target.checked })} /> Tự bắt đầu phiên kế tiếp</label>
              <label><input type="checkbox" checked={st.sound} onChange={(e) => engine.setSettings({ sound: e.target.checked })} /> Âm báo</label>
              <label><input type="checkbox" checked={st.notify} onChange={async (e) => {
                const want = e.target.checked;
                if (want && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
                  const p = await Notification.requestPermission();
                  engine.setSettings({ notify: p === 'granted' });
                } else engine.setSettings({ notify: want });
              }} /> Thông báo của trình duyệt</label>
            </div>
          </section>
          <section>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div className={s.drawerTitle} style={{ flex: 1 }}>Thống kê</div>
              {[7, 30].map((d) => <button key={d} type="button" className={`${s.btn} ${days === d ? s.primary : ''}`} onClick={() => setDays(d)}>{d} ngày</button>)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 10, marginBottom: 12 }}>
              <div className={s.stat}><div className={s.statNum}>{data ? formatDuration(data.totalSeconds) : '…'}</div><div className={s.hint}>tổng thời gian tập trung</div></div>
              <div className={s.stat}><div className={s.statNum}>{data?.completed ?? '…'}</div><div className={s.hint}>phiên trọn vẹn</div></div>
              <div className={s.stat}><div className={s.statNum}>{data?.interrupted ?? '…'}</div><div className={s.hint}>phiên dừng sớm</div></div>
              <div className={s.stat}><div className={s.statNum}>{data?.streakDays ?? '…'} ngày</div><div className={s.hint}>chuỗi tập trung · hôm nay {goalDone}/{st.dailyGoal}</div></div>
            </div>
            <div className={s.bars} style={{ height: 110 }}>
              {(data?.days ?? []).map((d) => <div key={d.day} className={s.bar} style={{ height: `${(d.focusedSeconds / max) * 100}%` }} title={`${d.day}: ${formatDuration(d.focusedSeconds)}`} />)}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(data?.days ?? []).map((d, i, a) => <div key={d.day} className={s.barLabel} style={{ flex: 1 }}>{a.length <= 7 || i % 5 === 0 ? d.day.slice(8) + '/' + d.day.slice(5, 7) : ''}</div>)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>Theo chủ đề</div>
                {data && Object.keys(data.bySubject).length === 0 && <div className={s.hint}>Chưa có phiên nào có chủ đề.</div>}
                {data && Object.entries(data.bySubject).map(([k, v]) => <div key={k} className={s.row} style={{ cursor: 'default' }}><span style={{ flex: 1 }}>{k}</span><b>{formatDuration(v)}</b></div>)}
              </div>
              <div>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>Theo việc cần làm</div>
                {data && Object.keys(data.byTask).length === 0 && <div className={s.hint}>Chưa có phiên nào gắn với việc cần làm.</div>}
                {data && Object.entries(data.byTask).map(([k, v]) => <div key={k} className={s.row} style={{ cursor: 'default' }}><span style={{ flex: 1 }}>{taskTitle(k)}</span><b>{formatDuration(v)}</b></div>)}
              </div>
            </div>
            <div style={{ fontWeight: 800, margin: '14px 0 6px' }}>Phiên gần đây</div>
            <div className={s.list}>
              {data?.recent.length === 0 && <div className={s.hint}>Chưa có phiên nào được ghi lại.</div>}
              {data?.recent.map((r) => (
                <div key={r.id} className={s.row} style={{ cursor: 'default' }}>
                  <span className={s.chip} style={{ color: r.status === 'COMPLETED' ? 'var(--ok)' : r.status === 'RUNNING' ? 'var(--accent)' : 'var(--danger)' }}>
                    {r.status === 'COMPLETED' ? 'Trọn vẹn' : r.status === 'RUNNING' ? 'Đang chạy' : 'Dừng sớm'}
                  </span>
                  <span style={{ flex: 1 }}>{r.label || r.subject || (r.mode === 'STOPWATCH' ? 'Bấm giờ' : 'Phiên tập trung')}</span>
                  <span className={s.hint}>{new Date(r.startedAt).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  <b>{formatDuration(r.focusedSeconds)}</b>
                </div>
              ))}
            </div>
            <p className={s.hint} style={{ marginTop: 10 }}>Thời gian được máy chủ ghi theo đồng hồ của máy chủ; một phiên chỉ tính là trọn vẹn khi thời gian thật sự đã trôi qua.</p>
          </section>
        </div>
      </div>
    </Panel>
  );
}

// ── Planner ───────────────────────────────────────────────────────────────────────────────────────────────
type PlannerView = 'list' | 'board' | 'calendar' | 'habits' | 'schedule';
export function PlannerPanel({ onClose }: { onClose: () => void }) {
  const { tasks, create, update, remove, loading } = useTasks();
  const [view, setView] = useState<PlannerView>('list');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'open' | 'all' | 'done' | 'today' | 'overdue'>('open');
  const [sort, setSort] = useState<'position' | 'due' | 'priority'>('position');
  const [project, setProject] = useState('');
  const [editing, setEditing] = useState<StudyTask | null>(null);
  const [draft, setDraft] = useState({ title: '', dueOn: '', priority: 0, project: '', recurrence: 'NONE' as StudyTask['recurrence'] });
  const [month, setMonth] = useState(() => new Date());
  const [over, setOver] = useState<string | null>(null);
  const today = isoDay(new Date());
  const projects = useMemo(() => [...new Set(tasks.map((t) => t.project).filter(Boolean) as string[])], [tasks]);
  const visible = tasks
    .filter((t) => !q || `${t.title} ${t.notes ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .filter((t) => !project || t.project === project)
    .filter((t) => filter === 'all' ? true : filter === 'done' ? t.status === 'DONE' : filter === 'today' ? t.dueOn === today && t.status !== 'DONE' : filter === 'overdue' ? !!t.dueOn && t.dueOn < today && t.status !== 'DONE' : t.status !== 'DONE')
    .sort((a, b) => sort === 'due' ? (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') : sort === 'priority' ? b.priority - a.priority : a.position - b.position);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.title.trim()) return;
    await create({ title: draft.title.trim(), dueOn: draft.dueOn || null, priority: draft.priority, project: draft.project || null, recurrence: draft.recurrence });
    setDraft({ ...draft, title: '' });
  };
  const prio = ['', s.prio1, s.prio2, s.prio3];
  const prioLabel = ['Thường', 'Thấp', 'Vừa', 'Cao'];
  const taskRow = (t: StudyTask) => (
    <div key={t.id} className={`${s.row} ${editing?.id === t.id ? s.rowActive : ''}`} onClick={() => setEditing(t)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') setEditing(t); }}>
      <input type="checkbox" className={s.check} checked={t.status === 'DONE'} onClick={(e) => e.stopPropagation()}
        onChange={() => void update(t.id, { status: t.status === 'DONE' ? 'OPEN' : 'DONE' })} aria-label={`Đánh dấu ${t.title}`} />
      <span className={t.status === 'DONE' ? s.done : undefined} style={{ flex: 1, minWidth: 0 }}>{t.title}</span>
      {t.project && <span className={s.chip}>{t.project}</span>}
      {t.priority > 0 && <span className={`${s.chip} ${prio[t.priority]}`}>{prioLabel[t.priority]}</span>}
      {t.recurrence !== 'NONE' && <span className={s.chip}><Repeat size={11} /> {t.doneCount}</span>}
      {t.dueOn && <span className={s.chip} style={t.dueOn < today && t.status !== 'DONE' ? { color: 'var(--danger)' } : undefined}>{t.dueOn.slice(8)}/{t.dueOn.slice(5, 7)}</span>}
      {t.focusedSeconds > 0 && <span className={s.chip}><Timer size={11} /> {formatDuration(t.focusedSeconds)}</span>}
    </div>
  );
  return (
    <Panel title="Kế hoạch học tập" icon={<CalendarDays size={20} />} onClose={onClose}
      actions={<div style={{ display: 'flex', gap: 4 }} role="tablist">
        {([['list', 'Danh sách', List], ['board', 'Bảng', Columns3], ['calendar', 'Lịch', CalendarDays], ['schedule', 'Khung giờ', Timer], ['habits', 'Thói quen', Repeat]] as const).map(([v, l, I]) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={`${s.btn} ${view === v ? s.primary : ''}`} onClick={() => setView(v)}><I size={14} /> {l}</button>
        ))}
      </div>}>
      {view === 'schedule' && <TimePlanner />}
      {view !== 'schedule' && <form onSubmit={add} className={s.taskForm}>
        <input className={s.input} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Việc mới…" maxLength={200} aria-label="Tên việc" />
        <input className={s.input} type="date" value={draft.dueOn} onChange={(e) => setDraft({ ...draft, dueOn: e.target.value })} aria-label="Hạn" />
        <select className={s.select} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} aria-label="Mức ưu tiên">
          {prioLabel.map((l, i) => <option key={l} value={i}>{l}</option>)}
        </select>
        <input className={s.input} list="planner-projects" value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} placeholder="Dự án / môn" maxLength={60} aria-label="Dự án" />
        <select className={s.select} value={draft.recurrence} onChange={(e) => setDraft({ ...draft, recurrence: e.target.value as StudyTask['recurrence'] })} aria-label="Lặp lại">
          <option value="NONE">Không lặp</option><option value="DAILY">Hằng ngày</option><option value="WEEKLY">Hằng tuần</option>
        </select>
        <button type="submit" className={`${s.btn} ${s.primary}`}><Plus size={15} /> Thêm</button>
        <datalist id="planner-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
      </form>}
      {loading && <div className={s.hint}>Đang tải…</div>}
      {view === 'list' && (
        <div className={s.cols}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className={s.field}><span><Search size={12} /> Tìm</span><input className={s.input} value={q} onChange={(e) => setQ(e.target.value)} /></label>
            <label className={s.field}>Lọc<select className={s.select} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="open">Đang mở</option><option value="today">Hạn hôm nay</option><option value="overdue">Quá hạn</option><option value="done">Đã xong</option><option value="all">Tất cả</option></select></label>
            <label className={s.field}>Sắp xếp<select className={s.select} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="position">Thứ tự thêm</option><option value="due">Hạn gần nhất</option><option value="priority">Ưu tiên cao</option></select></label>
            <label className={s.field}>Dự án<select className={s.select} value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Tất cả</option>{projects.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
            {editing && <TaskEditor key={editing.id} task={tasks.find((t) => t.id === editing.id) ?? editing} projects={projects} onSave={(t) => update(editing.id, t)} onDelete={async () => { await remove(editing.id); setEditing(null); }} />}
          </div>
          <div className={s.list}>{visible.length ? visible.map(taskRow) : <div className={s.hint}>Không có việc nào khớp.</div>}</div>
        </div>
      )}
      {view === 'board' && (
        <div className={s.kanban}>
          {([['OPEN', 'Cần làm'], ['DOING', 'Đang làm'], ['DONE', 'Đã xong']] as const).map(([st, label]) => (
            <div key={st} className={`${s.column} ${over === st ? s.columnOver : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(st); }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/task'); if (id) void update(id, { status: st }); }}>
              <div style={{ fontWeight: 800 }}>{label} · {tasks.filter((t) => t.status === st).length}</div>
              {tasks.filter((t) => t.status === st && t.recurrence === 'NONE').map((t) => (
                <div key={t.id} className={s.card} draggable onDragStart={(e) => e.dataTransfer.setData('text/task', t.id)}>
                  <div style={{ fontWeight: 700 }}>{t.title}</div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                    {t.project && <span className={s.chip}>{t.project}</span>}{t.dueOn && <span className={s.chip}>{t.dueOn.slice(8)}/{t.dueOn.slice(5, 7)}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                    {st !== 'OPEN' && <button type="button" className={s.btn} style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => void update(t.id, { status: st === 'DONE' ? 'DOING' : 'OPEN' })}>← Lùi</button>}
                    {st !== 'DONE' && <button type="button" className={s.btn} style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => void update(t.id, { status: st === 'OPEN' ? 'DOING' : 'DONE' })}>Tiến →</button>}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {view === 'calendar' && (
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <button type="button" className={s.btn} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>←</button>
            <div className={s.drawerTitle}>Tháng {month.getMonth() + 1}/{month.getFullYear()}</div>
            <button type="button" className={s.btn} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>→</button>
            <span className={s.hint}>Chọn một ngày để đặt hạn cho việc mới.</span>
          </div>
          <MonthGrid month={month} onPick={(d) => setDraft({ ...draft, dueOn: isoDay(d) })}
            marks={(d) => tasks.filter((t) => t.dueOn === isoDay(d)).slice(0, 3).map((t) => (
              <span key={t.id} className={t.status === 'DONE' ? s.done : undefined} style={{ fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--ink)' }}>• {t.title}</span>
            ))} />
        </div>
      )}
      {view === 'habits' && (
        <div className={s.list}>
          <p className={s.hint}>Thói quen là việc lặp lại hằng ngày hoặc hằng tuần. Đánh dấu xong sẽ ghi một lần hoàn thành và dời sang hạn tiếp theo.</p>
          {tasks.filter((t) => t.recurrence !== 'NONE').length === 0 && <div className={s.hint}>Chưa có thói quen nào. Tạo việc với “Hằng ngày” hoặc “Hằng tuần”.</div>}
          {tasks.filter((t) => t.recurrence !== 'NONE').map((t) => (
            <div key={t.id} className={s.row} style={{ cursor: 'default' }}>
              <span style={{ flex: 1, fontWeight: 700 }}>{t.title}</span>
              <span className={s.chip}>{t.recurrence === 'DAILY' ? 'Hằng ngày' : 'Hằng tuần'}</span>
              <span className={s.chip}>Đã làm {t.doneCount} lần</span>
              {t.lastDoneOn && <span className={s.hint}>Lần gần nhất {t.lastDoneOn.slice(8)}/{t.lastDoneOn.slice(5, 7)}</span>}
              <button type="button" className={`${s.btn} ${s.primary}`} disabled={t.lastDoneOn === today} onClick={() => void update(t.id, { status: 'DONE' })}>
                {t.lastDoneOn === today ? 'Đã xong hôm nay' : 'Xong hôm nay'}
              </button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function TaskEditor({ task, projects, onSave, onDelete }: { task: StudyTask; projects: string[]; onSave: (t: Partial<StudyTask> & { clearDue?: boolean }) => Promise<unknown>; onDelete: () => Promise<void> }) {
  const [t, setT] = useState(task);
  return (
    <div className={s.stat} style={{ display: 'grid', gap: 6 }}>
      <div style={{ fontWeight: 800 }}>Sửa việc</div>
      <input className={s.input} value={t.title} maxLength={200} onChange={(e) => setT({ ...t, title: e.target.value })} aria-label="Tên việc" />
      <textarea className={s.textarea} value={t.notes ?? ''} maxLength={4000} onChange={(e) => setT({ ...t, notes: e.target.value })} placeholder="Ghi chú…" aria-label="Ghi chú" />
      <input className={s.input} type="date" value={t.dueOn ?? ''} onChange={(e) => setT({ ...t, dueOn: e.target.value || null })} aria-label="Hạn" />
      <input className={s.input} list="planner-projects" value={t.project ?? ''} onChange={(e) => setT({ ...t, project: e.target.value })} placeholder="Dự án / môn" aria-label="Dự án" />
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => void onSave({ title: t.title, notes: t.notes ?? '', dueOn: t.dueOn, clearDue: !t.dueOn, project: t.project ?? '' })}>Lưu</button>
        <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => { if (window.confirm('Xóa việc này?')) void onDelete(); }}><Trash2 size={14} /> Xóa</button>
      </div>
      <datalist id="planner-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
    </div>
  );
}

// ── Notebook + knowledge board ────────────────────────────────────────────────────────────────────────────
const COLORS: StudyNote['color'][] = ['sun', 'rose', 'mint', 'sky', 'lilac', 'sand'];
const COLOR_HEX: Record<string, string> = { sun: '#ffefa1', rose: '#ffc9d9', mint: '#bff0d9', sky: '#c4ddff', lilac: '#ddd0ff', sand: '#f2dfc2' };

export function NotebookPanel({ onClose }: { onClose: () => void }) {
  const { notes, create, update, remove } = useNotes();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const note = notes.find((n) => n.id === sel) ?? null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setDraft(note ? { title: note.title, body: note.body } : null); }, [note?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (patch: { title?: string; body?: string }) => {
    if (!note) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void update(note.id, patch), 600);
  };
  const list = notes.filter((n) => !q || `${n.title} ${n.kind === 'NOTE' ? n.body : ''}`.toLowerCase().includes(q.toLowerCase()));
  const exportMd = () => {
    if (!note) return;
    const blob = new Blob([`# ${note.title}\n\n${note.body}`], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(note.title || 'ghi-chu').replace(/[^\p{L}\p{N}\- ]/gu, '').slice(0, 60) || 'ghi-chu'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const pinToSpace = () => {
    if (!note) return;
    const w = { id: `w-${Math.random().toString(36).slice(2, 10)}`, type: 'note' as const, x: 0.4, y: 0.3, w: 240, h: 220, z: 20, refId: note.id, settings: { color: note.color } };
    ops.addWidget(w);
  };
  return (
    <Panel title="Sổ ghi chú" icon={<NotebookPen size={20} />} onClose={onClose}
      actions={<div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className={s.btn} onClick={async () => { const n = await create({ kind: 'NOTE', title: 'Ghi chú mới', body: '' }); setSel(n.id); }}><FileText size={14} /> Ghi chú mới</button>
        <button type="button" className={s.btn} onClick={async () => { const n = await create({ kind: 'BOARD', title: 'Bảng tri thức mới', body: JSON.stringify({ cards: [], links: [] }) }); setSel(n.id); }}><LayoutGrid size={14} /> Bảng tri thức</button>
      </div>}>
      <div className={s.cols}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <input className={s.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm trong ghi chú…" aria-label="Tìm ghi chú" />
          <div className={s.list}>
            {list.length === 0 && <div className={s.hint}>Chưa có ghi chú nào.</div>}
            {list.map((n) => (
              <button key={n.id} type="button" className={`${s.row} ${sel === n.id ? s.rowActive : ''}`} onClick={() => setSel(n.id)}>
                <span style={{ width: 10, height: 10, borderRadius: 4, background: COLOR_HEX[n.color], flexShrink: 0 }} />
                {n.kind === 'BOARD' ? <LayoutGrid size={14} /> : <FileText size={14} />}
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title || 'Không tên'}</span>
                {n.pinned && <Pin size={12} />}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          {!note && <div className={s.hint}>Chọn hoặc tạo một ghi chú.</div>}
          {note && draft && (
            <>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className={s.input} style={{ flex: 1, minWidth: 180, fontWeight: 800, fontSize: 16 }} value={draft.title} maxLength={160}
                  onChange={(e) => { setDraft({ ...draft, title: e.target.value }); save({ title: e.target.value }); }} aria-label="Tiêu đề" />
                {COLORS.map((c) => <button key={c} type="button" className={`${s.swatch} ${note.color === c ? s.swatchOn : ''}`} style={{ background: COLOR_HEX[c] }} onClick={() => void update(note.id, { color: c })} aria-label={`Màu ${c}`} />)}
                <button type="button" className={s.iconBtn} aria-pressed={note.pinned} onClick={() => void update(note.id, { pinned: !note.pinned })} title="Ghim lên đầu"><Pin size={15} /></button>
                {note.kind === 'NOTE' && <button type="button" className={s.iconBtn} aria-pressed={preview} onClick={() => setPreview(!preview)} title="Xem trước"><Eye size={15} /></button>}
                {note.kind === 'NOTE' && <button type="button" className={s.iconBtn} onClick={exportMd} title="Tải xuống .md"><Download size={15} /></button>}
                {note.kind === 'NOTE' && <button type="button" className={s.btn} onClick={pinToSpace} title="Đặt ghi chú này lên không gian">Đặt lên không gian</button>}
                <button type="button" className={`${s.iconBtn} ${s.danger}`} onClick={() => { if (window.confirm('Xóa ghi chú này? Các ghi chú dán đang hiển thị nó sẽ trống.')) { void remove(note.id); setSel(null); } }} title="Xóa"><Trash2 size={15} /></button>
              </div>
              {note.kind === 'NOTE' && (preview
                ? <Markdown className={s.md} text={draft.body} onToggle={(line) => {
                  const lines = draft.body.split('\n');
                  lines[line] = lines[line].replace(/\[( |x|X)\]/, (m) => (m === '[ ]' ? '[x]' : '[ ]'));
                  const body = lines.join('\n');
                  setDraft({ ...draft, body });
                  save({ body });
                }} />
                : <textarea className={s.textarea} style={{ flex: 1, minHeight: 320 }} value={draft.body} maxLength={20000}
                  onChange={(e) => { setDraft({ ...draft, body: e.target.value }); save({ body: e.target.value }); }}
                  placeholder={'Viết bằng Markdown: # tiêu đề, - danh sách, - [ ] việc cần làm, **đậm**, [liên kết](https://…)'} aria-label="Nội dung" />)}
              {note.kind === 'BOARD' && <KnowledgeBoard note={note} notes={notes} onSave={(body) => void update(note.id, { body })} />}
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

interface BoardCard { id: string; x: number; y: number; text: string; color: string; noteId?: string | null }
interface BoardData { cards: BoardCard[]; links: { a: string; b: string }[]; view?: { x: number; y: number; z: number } }

function KnowledgeBoard({ note, notes, onSave }: { note: StudyNote; notes: StudyNote[]; onSave: (body: string) => void }) {
  const parse = (): BoardData => { try { const d = JSON.parse(note.body) as BoardData; return { cards: d.cards ?? [], links: d.links ?? [], view: d.view ?? { x: 0, y: 0, z: 1 } }; } catch { return { cards: [], links: [], view: { x: 0, y: 0, z: 1 } }; } };
  const [data, setData] = useState<BoardData>(parse);
  const [sel, setSel] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const drag = useRef<{ id: string | null; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const view = data.view ?? { x: 0, y: 0, z: 1 };
  const commit = (next: BoardData) => {
    setData(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onSave(JSON.stringify(next)), 600);
  };
  const addCard = () => {
    const id = `c${Date.now().toString(36)}`;
    commit({ ...data, cards: [...data.cards, { id, x: (-view.x + 80) / view.z + Math.random() * 60, y: (-view.y + 60) / view.z + Math.random() * 60, text: 'Ý tưởng mới', color: 'lilac' }] });
    setSel(id);
  };
  const card = data.cards.find((c) => c.id === sel);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 360 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className={s.btn} onClick={addCard}><Plus size={14} /> Thẻ</button>
        <button type="button" className={s.btn} disabled={!sel} aria-pressed={!!linkFrom} onClick={() => setLinkFrom(linkFrom ? null : sel)}><Link2 size={14} /> {linkFrom ? 'Chọn thẻ để nối…' : 'Nối thẻ'}</button>
        <button type="button" className={s.btn} disabled={!sel} onClick={() => { commit({ ...data, cards: data.cards.filter((c) => c.id !== sel), links: data.links.filter((l) => l.a !== sel && l.b !== sel) }); setSel(null); }}><Trash2 size={14} /> Xóa thẻ</button>
        <button type="button" className={s.btn} onClick={() => commit({ ...data, view: { ...view, z: Math.min(2, view.z + 0.15) } })}>+</button>
        <button type="button" className={s.btn} onClick={() => commit({ ...data, view: { ...view, z: Math.max(0.4, view.z - 0.15) } })}>−</button>
        <span className={s.hint}>Kéo nền để di chuyển, kéo thẻ để sắp xếp.</span>
      </div>
      {card && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className={s.input} style={{ flex: 1, minWidth: 200 }} value={card.text} maxLength={300} onChange={(e) => commit({ ...data, cards: data.cards.map((c) => (c.id === card.id ? { ...c, text: e.target.value } : c)) })} aria-label="Nội dung thẻ" />
          <select className={s.select} style={{ width: 200 }} value={card.noteId ?? ''} onChange={(e) => commit({ ...data, cards: data.cards.map((c) => (c.id === card.id ? { ...c, noteId: e.target.value || null } : c)) })} aria-label="Gắn ghi chú">
            <option value="">Không gắn ghi chú</option>
            {notes.filter((n) => n.kind === 'NOTE').map((n) => <option key={n.id} value={n.id}>{n.title || 'Không tên'}</option>)}
          </select>
          {COLORS.map((c) => <button key={c} type="button" className={`${s.swatch} ${card.color === c ? s.swatchOn : ''}`} style={{ background: COLOR_HEX[c] }} onClick={() => commit({ ...data, cards: data.cards.map((x) => (x.id === card.id ? { ...x, color: c } : x)) })} aria-label={`Màu ${c}`} />)}
        </div>
      )}
      <div className={s.board} style={{ flex: 1 }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) { drag.current = { id: null, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }; setSel(null); (e.target as HTMLElement).setPointerCapture(e.pointerId); } }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (d.id === null) setData({ ...data, view: { ...view, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy } });
          else setData({ ...data, cards: data.cards.map((c) => (c.id === d.id ? { ...c, x: d.ox + (e.clientX - d.sx) / view.z, y: d.oy + (e.clientY - d.sy) / view.z } : c)) });
        }}
        onPointerUp={() => { if (drag.current) commit(data); drag.current = null; }}
        onWheel={(e) => commit({ ...data, view: { ...view, z: Math.max(0.4, Math.min(2, view.z - e.deltaY * 0.001)) } })}>
        <div style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: '0 0' }}>
          <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }} width={1} height={1} aria-hidden="true">
            {data.links.map((l) => {
              const a = data.cards.find((c) => c.id === l.a), b = data.cards.find((c) => c.id === l.b);
              if (!a || !b) return null;
              return <line key={`${l.a}-${l.b}`} x1={a.x + 90} y1={a.y + 24} x2={b.x + 90} y2={b.y + 24} stroke="#8b7cf0" strokeWidth={2.5} strokeDasharray="6 5" />;
            })}
          </svg>
          {data.cards.map((c) => (
            <div key={c.id} className={`${s.boardCard} ${sel === c.id ? s.boardCardSel : ''}`} style={{ left: c.x, top: c.y, background: COLOR_HEX[c.color] }}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (linkFrom && linkFrom !== c.id) {
                  if (!data.links.some((l) => (l.a === linkFrom && l.b === c.id) || (l.b === linkFrom && l.a === c.id))) commit({ ...data, links: [...data.links, { a: linkFrom, b: c.id }] });
                  setLinkFrom(null);
                  return;
                }
                setSel(c.id);
                drag.current = { id: c.id, sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y };
                (e.currentTarget.parentElement?.parentElement as HTMLElement | null)?.setPointerCapture(e.pointerId);
              }}>
              <div style={{ fontWeight: 700, color: '#3b3550', whiteSpace: 'pre-wrap' }}>{c.text}</div>
              {c.noteId && <div style={{ fontSize: 11, color: '#6a5f88', marginTop: 4 }}><FileText size={11} /> {notes.find((n) => n.id === c.noteId)?.title ?? 'Ghi chú đã xóa'}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Ambient ──────────────────────────────────────────────────────────────────────────────────────────────
export function AmbientPanel({ onClose }: { onClose: () => void }) {
  const { state, set, on, stop } = useAmbient();
  const zero = Object.fromEntries(CHANNELS.map((c) => [c.id, 0])) as AmbientLevels['levels'];
  return (
    <Panel title="Âm thanh nền" icon={<Waves size={20} />} onClose={onClose}>
      <p className={s.hint} style={{ marginBottom: 12 }}>Mọi âm thanh được tổng hợp ngay trong trình duyệt của bạn, không tải tệp nào. Âm nhạc của Echo Music vẫn điều khiển riêng.</p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {AMBIENT_PRESETS.map((p) => <button key={p.id} type="button" className={s.btn} onClick={() => void set({ ...state, muted: false, levels: { ...zero, ...p.levels } })}>{p.label}</button>)}
        <button type="button" className={s.btn} onClick={() => void set({ ...state, levels: zero })}>Tắt hết kênh</button>
        {on && <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => void stop()}>Dừng âm thanh</button>}
      </div>
      <div style={{ display: 'grid', gap: 12, maxWidth: 640 }}>
        <label style={{ display: 'grid', gridTemplateColumns: '150px 1fr 60px', alignItems: 'center', gap: 10, fontWeight: 800 }}>
          Âm lượng chung
          <input type="range" className={s.range} min={0} max={1} step={0.05} value={state.master} onChange={(e) => void set({ ...state, master: Number(e.target.value) })} />
          <button type="button" className={s.btn} onClick={() => void set({ ...state, muted: !state.muted })}>{state.muted ? 'Bật' : 'Tắt'}</button>
        </label>
        {CHANNELS.map((c) => (
          <label key={c.id} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 60px', alignItems: 'center', gap: 10, fontWeight: 700 }}>
            {c.label}
            <input type="range" className={s.range} min={0} max={1} step={0.05} value={state.levels[c.id]} onChange={(e) => void set({ ...state, muted: false, levels: { ...state.levels, [c.id]: Number(e.target.value) } })} />
            <span className={s.hint}>{Math.round(state.levels[c.id] * 100)}%</span>
          </label>
        ))}
      </div>
    </Panel>
  );
}

// ── Character ────────────────────────────────────────────────────────────────────────────────────────────
export function CharacterPanel({
  onClose,
  onActivity,
  lifeEnabled = false,
  onOpenCreatorStudio,
}: {
  onClose: () => void;
  onActivity: (a: Activity) => void;
  lifeEnabled?: boolean;
  onOpenCreatorStudio?: () => void;
}) {
  const { locale } = useLanguage();
  const vi = !lifeEnabled && locale === 'vi';
  const ch = useSpace((st) => st.layout.character);
  const pet = useSpace((st) => st.layout.pet);
  const set = (patch: Partial<typeof ch>) => useSpace.getState().apply((l) => ({ ...l, character: { ...l.character, ...patch } }), `char-${Object.keys(patch).join()}`);
  const look = normalizeLook(ch.model, ch.look);
  const wear = (patch: Partial<AvatarLook>) => {
    const next = normalizeLook(ch.model, { ...look, ...patch, colors: { ...look.colors, ...patch.colors } });
    useSpace.getState().apply((l) => ({ ...l, character: { ...l.character, look: next, lookAt: Date.now() } }), 'char-look');
  };
  const hero = (model: 'LYRA' | 'KAI') => {
    const next = normalizeLook(model, look);
    useSpace.getState().apply((l) => ({ ...l, character: { ...l.character, model, look: next, lookAt: Date.now() } }), 'char-look');
  };
  const chips = (label: string, slots: ('top' | 'dress' | 'bottom' | 'shoes')[], value: string, key: 'top' | 'bottom' | 'shoes', testid: string, plain = false) => (
    <div className={s.field}>{label}
      <div className={s.fieldRow} data-testid={testid}>
        {plain && (
          <button type="button" className={`${s.btn} ${value === SIGNATURE ? s.primary : ''}`} onClick={() => wear({ top: SIGNATURE, bottom: SIGNATURE, shoes: SIGNATURE })}>
            {vi
              ? (ch.model === 'LYRA' ? 'Bộ của Lyra' : 'Bộ của Kai')
              : (ch.model === 'LYRA' ? 'Lyra Signature' : 'Kai Signature')}
          </button>
        )}
        {slots.flatMap(slot => slotItems(ch.model, slot)).map(i => (
          <button key={i.id} type="button" className={`${s.btn} ${value === i.id ? s.primary : ''}`} onClick={() => wear({ [key]: i.id })}>
            {vi ? (i.vi ?? i.en ?? i.id) : (i.en ?? i.id)}
          </button>
        ))}
      </div>
    </div>
  );
  const swatches = (label: string, key: keyof typeof COLOR_SWATCHES) => (
    <div className={s.field}>{label}
      <div className={s.fieldRow}>
        {COLOR_SWATCHES[key].map((c) => <button key={c} type="button" className={`${s.swatch} ${look.colors[key] === c ? s.swatchOn : ''}`} style={{ background: c }} onClick={() => wear({ colors: { ...look.colors, [key]: c } })} aria-label={`${label} ${c}`} />)}
        <input type="color" value={look.colors[key]} onChange={(e) => wear({ colors: { ...look.colors, [key]: e.target.value } })} aria-label={vi ? `${label} tùy chọn` : `${label} custom color`} style={{ width: 30, height: 26, border: 0, background: 'transparent' }} />
      </div>
    </div>
  );
  const signature = isSignature(look), dress = !signature && slotItems(ch.model, 'dress').some(i => i.id === look.top);
  const activities: readonly (readonly [Activity, string, string])[] = [
    ['study', 'Ngồi học', 'Study'],
    ['read', 'Đọc sách', 'Read'],
    ['write', 'Viết bài', 'Write'],
    ['listen', 'Nghe nhạc', 'Listen'],
    ['relax', 'Thư giãn', 'Relax'],
    ['stretch', 'Vươn vai', 'Stretch'],
    ['wave', 'Vẫy tay', 'Wave'],
    ['sleep', 'Nằm nghỉ', 'Rest'],
    ['idle', 'Đứng nghỉ', 'Stand'],
  ];
  return (
    <Panel
      title={vi ? 'Nhân vật và tủ đồ' : 'Character and Wardrobe'}
      icon={<Shirt size={20} />}
      onClose={onClose}
      closeLabel={vi ? 'Đóng' : 'Close'}
      side
    >
      <div style={{ display: 'grid', gap: 20 }}>
        {lifeEnabled && onOpenCreatorStudio && (
          <section>
            <button
              type="button"
              className={`${s.btn} ${s.primary}`}
              style={{ width: '100%', justifyContent: 'center', padding: '10px 14px', fontWeight: 800 }}
              data-testid="panel-open-creator-studio"
              onClick={() => {
                onClose();
                onOpenCreatorStudio();
              }}
            >
              <SlidersHorizontal size={16} aria-hidden="true" />
              Open Full Character Studio
            </button>
            <p className={s.hint} style={{ marginTop: 6 }}>
              Sculpt facial features, body proportions, layered outerwear, hairstyles, and 8 seasonal outfit slots in 3D.
            </p>
          </section>
        )}
        <section>
          <label style={{ display: 'flex', gap: 8, fontWeight: 800, marginBottom: 12 }}>
            <input type="checkbox" checked={ch.visible} onChange={(e) => set({ visible: e.target.checked })} />
            {vi ? 'Hiện nhân vật trong không gian' : 'Show character in room'}
          </label>
          <div className={s.field}>{vi ? 'Nhân vật' : 'Hero'}
            <div className={s.fieldRow}>
              {(['LYRA', 'KAI'] as const).map((m) => <button key={m} type="button" data-testid={`wardrobe-hero-${m}`} className={`${s.btn} ${ch.model === m ? s.primary : ''}`} onClick={() => hero(m)}>{m === 'LYRA' ? 'Lyra' : 'Kai'}</button>)}
            </div>
          </div>
          {chips(vi ? 'Áo' : 'Top', ['top', 'dress'], look.top, 'top', 'wardrobe-top', true)}
          {!signature && !dress && chips(vi ? 'Quần, váy' : 'Bottom', ['bottom'], look.bottom, 'bottom', 'wardrobe-bottom')}
          {!signature && chips(vi ? 'Giày' : 'Shoes', ['shoes'], look.shoes, 'shoes', 'wardrobe-shoes')}
          {!signature && swatches(vi ? 'Màu áo' : 'Top color', 'top')}
          {!signature && !dress && swatches(vi ? 'Màu quần' : 'Bottom color', 'bottom')}
          {!signature && swatches(vi ? 'Màu giày' : 'Shoe color', 'shoes')}
          {swatches(vi ? 'Màu tóc' : 'Hair color', 'hair')}
          <div className={s.field}>{vi ? 'Phụ kiện' : 'Accessories'}
            <div className={s.fieldRow} data-testid="wardrobe-accessories">
              {slotItems(ch.model, 'accessory').map(i => {
                const on = look.accessories.includes(i.id);
                return (
                  <button key={i.id} type="button" aria-pressed={on} className={`${s.btn} ${on ? s.primary : ''}`} onClick={() => wear({ accessories: on ? look.accessories.filter(a => a !== i.id) : [...look.accessories, i.id] })}>
                    {vi ? (i.vi ?? i.en ?? i.id) : (i.en ?? i.id)}
                  </button>
                );
              })}
            </div>
          </div>
          {look.accessories.length > 0 && swatches(vi ? 'Màu phụ kiện' : 'Accessory color', 'accessory')}
          <p className={s.hint}>
            {vi
              ? 'Bộ đồ đi cùng bạn sang Speaking Arena và Echo Quiz Rush.'
              : 'Your outfit travels with you to Speaking Arena and Echo Quiz Rush.'}
          </p>
        </section>
        <section>
          <div className={s.field}>{vi ? 'Hoạt động' : 'Activities'}
            <div className={s.fieldRow}>
              {activities.map(([a, lVi, lEn]) => (
                <button key={a} type="button" className={s.btn} onClick={() => onActivity(a)}>{vi ? lVi : lEn}</button>
              ))}
            </div>
          </div>
          <p className={s.hint}>
            {vi
              ? 'Bấm vào ghế, bàn, giường hay ghế bành trong phòng để nhân vật đi tới và dùng nó. Bấm lên sàn để nhân vật đi tới đó.'
              : 'Click a chair, desk, bed, or armchair in your room to walk over and use it. Click the floor to walk there.'}
          </p>
          <label style={{ display: 'flex', gap: 8, fontWeight: 700, margin: '12px 0' }}>
            <input type="checkbox" checked={ch.followFocus} onChange={(e) => set({ followFocus: e.target.checked })} />
            {vi
              ? 'Ngồi vào bàn học khi phiên tập trung bắt đầu, vươn vai khi kết thúc'
              : 'Sit at the desk when a focus session starts, and stretch when it finishes'}
          </label>
          <label style={{ display: 'flex', gap: 8, fontWeight: 700 }}>
            <input type="checkbox" checked={pet.visible} onChange={(e) => useSpace.getState().apply((l) => ({ ...l, pet: { ...l.pet, visible: e.target.checked } }))} />
            {vi ? 'Echo bơi quanh phòng' : 'Show Echo swimming around the room'}
          </label>
        </section>
      </div>
    </Panel>
  );
}
