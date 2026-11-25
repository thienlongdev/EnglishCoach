'use client';

import React, { Suspense, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowLeft, ExternalLink, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useDialogFocus } from '../useDialogFocus';
import s from './echoDesk.module.css';

const VirtualRoute = dynamic(() => import('./VirtualRoute'), { ssr: false });
const EchoMessenger = dynamic(() => import('@/components/messenger/EchoMessenger'), { ssr: false });

const TITLE: Record<string, [string, string]> = {
  '/listening': ['Nghe', 'Listening'], '/writing': ['Viết', 'Writing'], '/speaking': ['Luyện nói', 'Speaking'], '/reading': ['Đọc', 'Reading'],
  '/flashcards': ['Thẻ từ vựng', 'Flashcards'], '/learning-path': ['Lộ trình học', 'Learning path'], '/progress': ['Tiến trình', 'Progress'], '/grammar': ['Ngữ pháp', 'Grammar'],
};

class Guard extends React.Component<{ vi: boolean; onFull: () => void; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    const { vi, onFull } = this.props;
    return <div className={s.failed} role="alert">
      <p>{vi ? 'Mục này gặp lỗi khi mở trong phòng.' : 'This hit a problem opening here in the room.'}</p>
      <div>
        <button type="button" onClick={() => this.setState({ failed: false })}>{vi ? 'Thử lại' : 'Try again'}</button>
        <button type="button" onClick={onFull}>{vi ? 'Mở toàn trang' : 'Open full page'}</button>
      </div>
    </div>;
  }
}

/** A thing in the room (the headphones, the flash-card box, the pen cup, the notebook) opens its real module here, with the room still standing behind it. */
export default function RoomWindow({ href, messenger, conversation, onClose, onOutside, onEnterArena }: { href?: string; messenger?: boolean; conversation?: string | null; onClose: () => void; onOutside: (href: string) => void; onEnterArena?: (code: string) => void }) {
  const { locale } = useLanguage(), vi = locale === 'vi';
  const [canBack, setCanBack] = useState(false);
  const back = useRef<(() => void) | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  useDialogFocus(root, onClose);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);
  const path = href ? new URL(href, location.origin).pathname : '';
  const title = messenger ? ['Echo Messenger', 'Echo Messenger'] : TITLE[path] ?? [vi ? 'Mở trong phòng' : 'In the room', 'In the room'];
  const full = messenger ? `/community/messages${conversation ? `?c=${conversation}` : ''}` : (href ?? '/');
  return <section ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={vi ? title[0] : title[1]} className={`${s.window} ${s.roomWindow}`} data-testid="room-window" style={{ bottom: undefined }}>
    <header className={s.bar}>
      <span className={s.barTitle}>{vi ? title[0] : title[1]}</span>
      <span className={s.barTools}>
        {canBack && <button type="button" onClick={() => back.current?.()} title={vi ? 'Quay lại' : 'Back'} aria-label={vi ? 'Quay lại' : 'Back'}><ArrowLeft size={15} /></button>}
        <button type="button" onClick={() => onOutside(full)} title={vi ? 'Mở toàn trang' : 'Open full page'} aria-label={vi ? 'Mở toàn trang' : 'Open full page'}><ExternalLink size={15} /></button>
        <button type="button" onClick={onClose} title={vi ? 'Đóng' : 'Close'} aria-label={vi ? 'Đóng' : 'Close'} data-testid="room-window-close"><X size={16} /></button>
      </span>
    </header>
    <div className={s.body}>
      <Guard vi={vi} onFull={() => onOutside(full)}>
        <Suspense fallback={null}>
          {messenger
            ? <div className={s.fill}><EchoMessenger embedded initial={conversation} onEnterArena={onEnterArena} /></div>
            : <VirtualRoute start={href ?? '/'} active back={back} onOutside={onOutside} onLocation={(_, can) => setCanBack(can)} />}
        </Suspense>
      </Guard>
    </div>
  </section>;
}
