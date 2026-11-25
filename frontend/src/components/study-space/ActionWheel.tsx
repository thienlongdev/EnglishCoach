'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowLeft,
  Briefcase,
  Building2,
  Bus,
  Camera,
  Ear,
  Eye,
  Footprints,
  Hammer,
  Hand,
  HandHeart,
  MessageSquare,
  Music2,
  PartyPopper,
  Smartphone,
  Smile,
  Utensils,
  X,
} from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import {
  MULTIPLAYER_EMOTES,
  MULTIPLAYER_QUICK_CHATS,
  MULTIPLAYER_QUICK_CHAT_LABELS,
  type MultiplayerEmoteId,
  type RadialActionItem,
} from './world/echoLife/gameHost';
import { useDialogFocus } from './useDialogFocus';
import s from './actionWheel.module.css';

export interface WheelAction {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  children?: WheelAction[];
  run?: () => void;
}
interface Props {
  open: boolean;
  onOpen: (open: boolean) => void;
  actions: WheelAction[];
  binding: string;
  title?: string;
  vi?: boolean;
  lifeEnabled?: boolean;
  lifeActions?: RadialActionItem[];
  onLifeAction?: (item: RadialActionItem) => void;
  onQuickChat?: (id: string) => void;
  /** Close the input overlay before invoking the existing world command. */
  onChoose: (run: () => void) => void;
}

const EMOTE_LABELS: Readonly<Record<MultiplayerEmoteId, string>> = {
  wave: 'Wave',
  clap: 'Clap',
  cheer: 'Cheer',
  laugh: 'Laugh',
  dance: 'Dance',
  point: 'Point',
  toast: 'Toast',
};

const icons: Record<string, typeof Hand> = {
  inspect: Eye,
  wave: Hand,
  clap: HandHeart,
  cheer: PartyPopper,
  laugh: Smile,
  listen: Ear,
  dance: Music2,
  'dance-simple': Music2,
  point: Eye,
  toast: PartyPopper,
  jump: Footprints,
  'life-emotes': Smile,
  'life-quickchat': MessageSquare,
  'panel:phone': Smartphone,
  'panel:photo': Camera,
  'panel:build': Hammer,
  'panel:city': Building2,
  'home:cook': Utensils,
};

function iconForAction(id: string): typeof Hand | undefined {
  if (icons[id]) return icons[id];
  if (id.startsWith('emote:')) return icons[id.slice(6)] ?? Smile;
  if (id.startsWith('qc_')) return MessageSquare;
  if (id.startsWith('transit:')) return Bus;
  if (id.startsWith('work:')) return Briefcase;
  if (id.startsWith('bistro:')) return Utensils;
  if (id.startsWith('focus:')) return Hand;
  return undefined;
}

const TAU = Math.PI * 2;
const sectorAt = (x: number, y: number, count: number) => count ? Math.floor(((Math.atan2(y, x) + Math.PI / 2 + Math.PI / count + TAU) % TAU) / TAU * count) : 0;
function sector(index: number, count: number) {
  const angle = index * TAU / count - Math.PI / 2, half = Math.PI / count - .025;
  const point = (r: number, a: number) => `${200 + r * Math.cos(a)},${200 + r * Math.sin(a)}`;
  return `M${point(192, angle - half)} A192,192 0 ${half > Math.PI / 2 ? 1 : 0},1 ${point(192, angle + half)} L${point(88, angle + half)} A88,88 0 ${half > Math.PI / 2 ? 1 : 0},0 ${point(88, angle - half)} Z`;
}

/** One transient selector. Every leaf dispatches to the existing world owner. */
export default function ActionWheel(p: Props) {
  const { locale } = useLanguage();
  const lifeEnabled = Boolean(p.lifeEnabled);
  const vi = !lifeEnabled && locale === 'vi';
  const [path, setPath] = useState<string[]>([]), [page, setPage] = useState(0), [selected, setSelected] = useState(0);
  const dialog = useRef<HTMLDivElement>(null), wheel = useRef<HTMLDivElement>(null), latest = useRef<() => void>(() => {});

  const resolvedActions = useMemo<WheelAction[]>(() => {
    if (!lifeEnabled) return p.actions;
    const contextual: WheelAction[] = (p.lifeActions ?? [])
      .filter(item => item.id !== 'emote:wave')
      .slice(0, 6)
      .map(item => ({
        id: item.id,
        label: item.label,
        hint: item.hint,
        disabled: !item.enabled,
        run: () => p.onLifeAction?.(item),
      }));

    const emotesCategory: WheelAction = {
      id: 'life-emotes',
      label: 'Emotes',
      hint: 'Express with 7 multiplayer emotes',
      children: MULTIPLAYER_EMOTES.map(emoteId => ({
        id: `emote:${emoteId}`,
        label: EMOTE_LABELS[emoteId],
        hint: 'Broadcast emote to nearby players',
        run: () =>
          p.onLifeAction?.({
            id: `emote:${emoteId}`,
            label: EMOTE_LABELS[emoteId],
            category: 'social',
            enabled: true,
            emoteId,
          }),
      })),
    };

    const quickChatCategory: WheelAction = {
      id: 'life-quickchat',
      label: 'Quick Chat',
      hint: 'Send a shared-world message',
      children: MULTIPLAYER_QUICK_CHATS.map(qcId => ({
        id: qcId,
        label: MULTIPLAYER_QUICK_CHAT_LABELS[qcId],
        hint: 'Show speech bubble above your character',
        run: () => p.onQuickChat?.(qcId),
      })),
    };

    return [...contextual, emotesCategory, quickChatCategory, ...p.actions];
  }, [lifeEnabled, p.lifeActions, p.actions, p.onLifeAction, p.onQuickChat]);

  let all = resolvedActions;
  let title = p.title ?? (vi ? 'Hoạt động' : 'Activities');
  for (const id of path) { const item = all.find(a => a.id === id); if (!item?.children) break; title = item.label; all = item.children; }
  const pages = Math.max(1, Math.ceil(all.length / 8)), offset = Math.min(page, pages - 1) * 8, items = all.slice(offset, offset + 8);
  const active = items[Math.min(selected, Math.max(0, items.length - 1))];
  const turnPage = (direction: number) => {
    if (pages < 2) return;
    setPage((Math.min(page, pages - 1) + pages + direction) % pages);
    setSelected(0);
  };
  const back = () => { if (path.length) { setPath(path.slice(0, -1)); setPage(0); setSelected(0); } else p.onOpen(false); };
  const choose = (item = active) => {
    if (!item || item.disabled) return;
    if (item.children) { setPath([...path, item.id]); setPage(0); setSelected(0); }
    else if (item.run) p.onChoose(item.run);
  };
  useDialogFocus(dialog, () => p.onOpen(false), p.open);
  useEffect(() => { if (p.open) dialog.current?.querySelector<HTMLButtonElement>('[data-testid^="wheel-"]')?.focus(); }, [p.open, path, page]);
  useEffect(() => { if (!p.open) { setPath([]); setPage(0); setSelected(0); } }, [p.open]);
  useEffect(() => {
    if (!p.open) return;
    const blur = () => p.onOpen(false);
    const hide = () => { if (document.hidden) p.onOpen(false); };
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', hide);
    return () => { window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', hide); };
  }, [p.open, p.onOpen]);
  // Standard gamepads: Menu opens, left stick selects, A confirms, B returns.
  // Button edges are retained across closing; holding Menu never reopens it.
  const pad = useRef<boolean[]>([]), lastPadAt = useRef(0);
  latest.current = () => {
    const g = navigator.getGamepads?.().find(g => g?.connected && g.mapping === 'standard');
    if (!g) { pad.current = []; return; }
    const down = g.buttons.map(b => b.pressed), edge = (i: number) => down[i] && !pad.current[i];
    if (edge(9)) p.onOpen(!p.open);
    else if (p.open) {
      if (Math.hypot(g.axes[0] ?? 0, g.axes[1] ?? 0) > .35) setSelected(sectorAt(g.axes[0], g.axes[1], items.length));
      if (edge(12) || edge(14)) setSelected(i => (i + items.length - 1) % Math.max(1, items.length));
      if (edge(13) || edge(15)) setSelected(i => (i + 1) % Math.max(1, items.length));
      if (edge(4)) turnPage(-1); else if (edge(5)) turnPage(1);
      else if (edge(0)) choose(); else if (edge(1)) back();
    }
    pad.current = down;
  };
  useEffect(() => {
    let frame = 0;
    const tick = (at: number) => { if (at - lastPadAt.current >= 40) { lastPadAt.current = at; latest.current(); } frame = requestAnimationFrame(tick); };
    const start = () => { if (!frame) frame = requestAnimationFrame(tick); };
    const stop = () => { if (!Array.from(navigator.getGamepads?.() ?? []).some(Boolean)) { cancelAnimationFrame(frame); frame = 0; } };
    if (Array.from(navigator.getGamepads?.() ?? []).some(Boolean)) start();
    window.addEventListener('gamepadconnected', start); window.addEventListener('gamepaddisconnected', stop);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('gamepadconnected', start); window.removeEventListener('gamepaddisconnected', stop); };
  }, []);
  if (!p.open) return null;
  return <div className={s.backdrop} onPointerDown={e => { if (e.target === e.currentTarget) p.onOpen(false); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={vi ? 'Vòng hành động' : 'Action wheel'} className={s.dialog} data-testid="study-action-wheel"
      onKeyDown={e => {
        if (e.code === p.binding) { e.preventDefault(); e.stopPropagation(); p.onOpen(false); return; }
        if (['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); setSelected(i => (i + (['ArrowUp', 'ArrowLeft'].includes(e.key) ? items.length - 1 : 1)) % Math.max(1, items.length)); }
        if ((e.key === 'Enter' || e.key === ' ') && !(e.target as HTMLElement).closest('[data-wheel-control]')) { e.preventDefault(); e.stopPropagation(); choose(); }
        if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); e.stopPropagation(); turnPage(e.key === 'PageUp' ? -1 : 1); }
        if (e.key === 'Backspace') { e.preventDefault(); back(); }
      }}>
      <div ref={wheel} className={s.wheel} onPointerMove={e => {
        if (e.pointerType === 'touch') return;
        const box = e.currentTarget.getBoundingClientRect(), x = (e.clientX - box.left) / box.width - .5, y = (e.clientY - box.top) / box.height - .5;
        if (Math.hypot(x, y) > .23) setSelected(sectorAt(x, y, items.length));
      }} onWheel={e => { e.stopPropagation(); if (e.deltaY) setSelected(i => (i + (e.deltaY > 0 ? 1 : items.length - 1)) % Math.max(1, items.length)); }}>
        <svg viewBox="0 0 400 400" aria-hidden="true" className={s.sectors}>
          {items.map((a, i) => <path key={a.id} d={sector(i, items.length)} data-active={a === active || undefined} data-disabled={a.disabled || undefined} onClick={() => choose(a)} />)}
        </svg>
        {items.map((a, i) => {
          const Icon = iconForAction(a.id), angle = i * TAU / items.length - Math.PI / 2;
          return <button key={a.id} type="button" className={s.choice} data-testid={`wheel-${a.id}`} data-selected={a === active || undefined} aria-disabled={a.disabled || undefined} aria-haspopup={a.children ? 'menu' : undefined}
            style={{ left: `${50 + Math.cos(angle) * 35}%`, top: `${50 + Math.sin(angle) * 35}%` } as CSSProperties}
            onFocus={() => setSelected(i)} onClick={() => choose(a)}>{Icon && <Icon size={17} aria-hidden />}{a.label}{a.children && <span aria-hidden="true">›</span>}</button>;
        })}
        <div className={s.center} data-wheel-control><small>ECHO LIFE</small><strong>{title}</strong><div>
          {path.length > 0 && <button type="button" onClick={back} aria-label={vi ? 'Quay lại' : 'Back'} data-testid="wheel-back"><ArrowLeft size={17} /></button>}
          <button type="button" onClick={() => p.onOpen(false)} aria-label={vi ? 'Đóng' : 'Close'} data-testid="wheel-close"><X size={17} /></button>
        </div></div>
      </div>
      <div className={s.description} aria-live="polite"><strong>{active?.label}</strong><span>{active?.hint ?? (active?.children ? (vi ? 'Mở nhóm hành động' : 'Open category') : (vi ? 'Chọn để thực hiện' : 'Select to perform'))}</span></div>
      {pages > 1 && <div className={s.pages} data-wheel-control><button type="button" aria-label={vi ? 'Trang trước' : 'Previous page'} onClick={() => turnPage(-1)}>‹</button><span>{page + 1} / {pages}</span><button type="button" aria-label={vi ? 'Trang sau' : 'Next page'} onClick={() => turnPage(1)}>›</button></div>}
      <p className={s.help}>{vi ? 'Di chuột · Phím mũi tên · Enter chọn · Esc đóng' : 'Point · Arrow keys · Enter selects · Esc closes'}</p>
    </div>
  </div>;
}
