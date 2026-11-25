'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { GraduationCap, MessageCircle, BookA, BookMarked, BookOpen, CalendarDays, Compass, Headphones, Keyboard, Layers, LineChart, Minus, Mic, NotebookPen, PenLine, Power, Timer, X, FileSearch } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { echoSrc } from '@/lib/brand/echoCharacters';
import { useAccount, useDueCards, useTasks } from '../data';
import { useNow } from '../useNow';
import { useMessenger } from '@/lib/messenger/store';
import { GlobalDictionarySearch } from '@/components/features/dictionary/GlobalDictionarySearch';
import type { ActionId } from '@/lib/study-space/types';
import DeskPage from './DeskPage';
import s from './echoDesk.module.css';

const moduleLoading = () => <div className={s.loadingApp} role="status" aria-live="polite"><span/><span/><span/></div>;
const TypingPractice = dynamic(() => import('@/components/features/writing/typing/TypingPractice').then(m => m.TypingPractice), { ssr: false, loading: moduleLoading });

const EchoMessenger = dynamic(() => import('@/components/messenger/EchoMessenger'), { ssr: false, loading: moduleLoading });

export type DeskApp = 'reading' | 'mybooks' | 'flashcards' | 'typing' | 'listening' | 'writing' | 'speaking' | 'path' | 'progress' | 'grammar' | 'messenger' | 'exams' | 'games';
type AppId = DeskApp | 'focus' | 'planner' | 'notebook' | 'research' | 'dictionary';
interface AppRow { id: AppId; vi: string; en: string; icon: React.ComponentType<{ size?: number }>; tone: string; panel?: string; start?: string; assignedOnly?: boolean }

const APPS: AppRow[] = [
  { id: 'reading', vi: 'Thư viện đọc', en: 'Reading', icon: BookOpen, tone: '#6aa8ff' },
  { id: 'mybooks', vi: 'Sách của tôi', en: 'My Books', icon: BookMarked, tone: '#a78bfa' },
  { id: 'flashcards', vi: 'Thẻ từ vựng', en: 'Flashcards', icon: Layers, tone: '#f5b14c' },
  { id: 'typing', vi: 'Luyện gõ', en: 'Typing', icon: Keyboard, tone: '#4fd1b0' },
  { id: 'focus', vi: 'Tập trung', en: 'Focus', icon: Timer, tone: '#ff8f8f', panel: 'focus' },
  { id: 'planner', vi: 'Kế hoạch', en: 'Planner', icon: CalendarDays, tone: '#74c6ff', panel: 'planner' },
  { id: 'notebook', vi: 'Ghi chú', en: 'Notes', icon: NotebookPen, tone: '#ffd479', panel: 'notebook' },
  { id: 'research', vi: 'Nghiên cứu', en: 'Research', icon: FileSearch, tone: '#9fb4ff', panel: 'research' },
  { id: 'listening', vi: 'Nghe', en: 'Listening', icon: Headphones, tone: '#67d6e8', start: '/listening' },
  { id: 'writing', vi: 'Viết', en: 'Writing', icon: PenLine, tone: '#ff9fb6', start: '/writing' },
  { id: 'speaking', vi: 'Luyện nói', en: 'Speaking', icon: Mic, tone: '#c4a3ff', start: '/speaking' },
  { id: 'grammar', vi: 'Ngữ pháp', en: 'Grammar', icon: GraduationCap, tone: '#ffb37a', start: '/grammar' },
  { id: 'dictionary', vi: 'Từ điển', en: 'Dictionary', icon: BookA, tone: '#b2e36b' },
  { id: 'path', vi: 'Lộ trình học', en: 'Learning path', icon: Compass, tone: '#7fe0a8', start: '/learning-path' },
  { id: 'progress', vi: 'Tiến trình', en: 'Progress', icon: LineChart, tone: '#8fd0ff', start: '/progress' },
  { id: 'exams', vi: 'Thi thử', en: 'Exams', icon: GraduationCap, tone: '#68a4dd', start: '/exams', assignedOnly: true },
  { id: 'games', vi: 'Trò chơi', en: 'Games', icon: Compass, tone: '#7fe0a8', start: '/games', assignedOnly: true },
  { id: 'messenger', vi: 'Echo Messenger', en: 'Echo Messenger', icon: MessageCircle, tone: '#5fd3e8' },
];
const PAGE: Partial<Record<DeskApp, string>> = { reading: '/reading', mybooks: '/reading', flashcards: '/flashcards' };

/** A module that fails keeps the failure in its window: the room and the other windows go on. */
class WindowGuard extends React.Component<{ vi: boolean; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    const { vi } = this.props;
    return <div className={s.failed} role="alert">
      <p>{vi ? 'Ứng dụng này gặp lỗi trên màn hình nhỏ.' : 'This app hit a problem on this screen.'}</p>
      <div>
        <button type="button" onClick={() => this.setState({ failed: false })}>{vi ? 'Thử lại' : 'Try again'}</button>
      </div>
    </div>;
  }
}

export default function EchoDesk({ rect, name, onLeave, onPanel, children, onUsed, request, initialAction }: {
  rect: { left: number; top: number; width: number; height: number };
  name: string;
  onLeave: () => void;
  onPanel: (panel: string) => void;
  children?: React.ReactNode;
  /** What the learner opened, for the room's own record of the day. */
  onUsed?: (app: string) => void;
  initialAction?: ActionId | null;
  request?: { conversation: string | null } | { arena: string } | null;
}) {
  const { locale } = useLanguage(), vi = locale === 'vi';
  const account = useAccount();
  const now = useNow();
  const [open, setOpen] = useState<DeskApp[]>([]);
  const [active, setActive] = useState<DeskApp | null>(null);
  const [booted, setBooted] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const due = useDueCards(), tasks = useTasks();
  useEffect(() => { const id = window.setTimeout(() => setBooted(true), 420); return () => clearTimeout(id); }, []);
  const [starts, setStarts] = useState<Partial<Record<DeskApp, string>>>({});
  const [conversation, setConversation] = useState<string | null>(null);
  const dictionary = useRef<(() => void) | null>(null);
  const unread = useMessenger(st => st.unread);
  const launch = useCallback((app: AppRow) => {
    onUsed?.(app.id);
    if (app.panel) { onPanel(app.panel); return; }
    if (app.id === 'dictionary') { dictionary.current?.(); return; }
    const id = app.id as DeskApp;
    if (id === 'mybooks' || id === 'reading') { try { localStorage.setItem('readingActiveTab', id === 'mybooks' ? 'mybooks' : 'library'); } catch { /* the library opens */ } }
    // Reading and My Books are two tabs of one module: one window.
    setOpen(list => { const clean = list.filter(x => (id === 'mybooks' || id === 'reading') ? (x !== 'reading' && x !== 'mybooks') : x !== id); return [...clean, id]; });
    setActive(id);
  }, [onPanel, onUsed]);
  const assigned = useRef(initialAction);
  useEffect(() => {
    const action = assigned.current;
    assigned.current = undefined;
    if (action?.startsWith('open:')) onPanel(action.slice(5));
    if (action?.startsWith('route:')) {
      const app = APPS.find(item => item.id === action.slice(6));
      if (app) launch(app);
    }
  }, [launch, onPanel]);
  const follow = useCallback((id: DeskApp, href: string) => {
    setStarts(all => ({ ...all, [id]: href }));
    setOpen(list => [...list.filter(x => x !== id), id]);
    setActive(id);
  }, []);
  const enterArena = useCallback((code: string) => follow('speaking', '/speaking/arena?join=' + encodeURIComponent(code)), [follow]);
  useEffect(() => {
    if (!request) return;
    if ('arena' in request) { enterArena(request.arena); return; }
    setConversation(request.conversation);
    setOpen(list => [...list.filter(x => x !== 'messenger'), 'messenger']);
    setActive('messenger');
  }, [request, enterArena]);
  const close = useCallback((id: DeskApp) => {
    const next = open.filter(x => x !== id);
    setOpen(next);
    setActive(a => a === id ? next[next.length - 1] ?? null : a);
    setStarts(all => { const copy = { ...all }; delete copy[id]; return copy; });
  }, [open]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A dialog of the module answers Esc itself.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault(); e.stopPropagation();
      if (active) setActive(null); else onLeave();
    };
    window.addEventListener('keydown', key, { capture: true });
    return () => window.removeEventListener('keydown', key, { capture: true });
  }, [active, onLeave]);
  const userId = Number(account) || 0;
  const time = useMemo(() => new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(now), [now, vi]);
  const date = useMemo(() => new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(now), [now, vi]);
  const dueCount = typeof due.data === 'number' ? due.data : null;
  const openTasks = tasks.tasks?.filter(t => t.status !== 'DONE').length ?? null;
  const row = (id: AppId) => APPS.find(a => a.id === id)!;

  return <div ref={root} className={s.desk} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} data-booted={booted || undefined} role="application" aria-label={vi ? `Màn hình ${name}` : `${name} screen`} data-testid="echo-desk">
    <div className={s.wallpaper} aria-hidden="true"><img src={echoSrc('official', 256)} alt="" /></div>
    <div className={s.top}>
      <div className={s.clock}><b>{time}</b><span>{date}</span></div>
      <div className={s.glance}>
        {dueCount !== null && <button type="button" onClick={() => launch(row('flashcards'))}><Layers size={15}/>{vi ? `${dueCount} thẻ đến hạn` : `${dueCount} cards due`}</button>}
        {unread > 0 && <button type="button" onClick={() => launch(row('messenger'))} data-testid="desk-unread"><MessageCircle size={15}/>{vi ? `${unread} tin nhắn mới` : `${unread} new messages`}</button>}
        {openTasks !== null && <button type="button" onClick={() => launch(row('planner'))}><CalendarDays size={15}/>{vi ? `${openTasks} việc chưa xong` : `${openTasks} tasks open`}</button>}
      </div>
    </div>
    <div className={s.icons} data-testid="desk-icons">
      {APPS.filter(app => !app.assignedOnly).map(app => { const I = app.icon; return <button key={app.id} type="button" data-testid={`desk-app-${app.id}`} onClick={() => launch(app)} style={{ '--tone': app.tone } as React.CSSProperties}><span className={s.tile}><I size={24}/></span><span>{vi ? app.vi : app.en}</span></button>; })}
    </div>
    {open.map(id => {
      const app = row(id), I = app.icon;
      return <section key={id} className={s.window} hidden={active !== id} aria-label={vi ? app.vi : app.en} data-testid={`desk-window-${id}`}>
        <header className={s.bar}>
          <span className={s.barTitle} style={{ '--tone': app.tone } as React.CSSProperties}><I size={15}/>{vi ? app.vi : app.en}</span>
          <span className={s.barTools}><span data-desk-back=""/>
            <button type="button" onClick={() => setActive(null)} title={vi ? 'Thu nhỏ' : 'Minimise'} aria-label={vi ? 'Thu nhỏ' : 'Minimise'}><Minus size={16}/></button>
            <button type="button" onClick={() => close(id)} title={vi ? 'Đóng' : 'Close'} aria-label={vi ? 'Đóng' : 'Close'} data-testid="desk-window-close"><X size={16}/></button>
          </span>
        </header>
        <div className={s.body}>
          <WindowGuard vi={vi}>
            <Suspense fallback={moduleLoading()}>
              {id === 'typing' && <div className={s.pad}><TypingPractice key={userId} userId={userId} /></div>}
              {id === 'messenger' && <div className={s.fill} onClickCapture={e => {
                const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
                if (!a) return;
                const u = new URL(a.href, location.origin);
                if (u.origin !== location.origin) return;
                e.preventDefault(); e.stopPropagation();
                follow(u.pathname.startsWith('/flashcards') ? 'flashcards' : 'reading', u.pathname + u.search + u.hash);
              }}><EchoMessenger embedded initial={conversation} portalHost={root.current} onEnterArena={enterArena} /></div>}
              {id !== 'typing' && id !== 'messenger' && <DeskPage href={starts[id] ?? app.start ?? PAGE[id]!}
                title={vi ? app.vi : app.en} backLabel={vi ? 'Quay lại' : 'Back'} onMinimise={() => setActive(null)} />}
            </Suspense>
          </WindowGuard>
        </div>
      </section>;
    })}
    {children}
    <GlobalDictionarySearch portalHost={root.current} customTrigger={open => { dictionary.current = open; return null; }} />
    <footer className={s.dock}>
      {open.map(id => { const app = row(id), I = app.icon; return <button key={id} type="button" aria-pressed={active === id} onClick={() => setActive(active === id ? null : id)} style={{ '--tone': app.tone } as React.CSSProperties} title={vi ? app.vi : app.en} aria-label={vi ? app.vi : app.en}><I size={18}/></button>; })}
      <span className={s.dockRule} aria-hidden="true"/>
      <button type="button" className={s.leave} onClick={onLeave} data-testid="desk-leave"><Power size={16}/>{vi ? 'Rời máy' : 'Leave'}<kbd>Esc</kbd></button>
    </footer>
  </div>;
}
