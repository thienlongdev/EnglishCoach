'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';

type PageNavigation = EventTarget & { canGoBack: boolean; back: () => unknown };

/** Only product pages run in this frame. The browser owns the app's URL, history,
 * dialogs and keyboard focus independently of the room. */
export default function DeskPage({ href, title, backLabel, onMinimise }: { href: string; title: string; backLabel: string; onMinimise: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const navigation = useRef<PageNavigation | null>(null);
  const [backHost, setBackHost] = useState<HTMLElement | null>(null);
  const [canBack, setCanBack] = useState(false);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  const loaded = () => {
    cleanup.current();
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const nav = (doc.defaultView as (Window & { navigation?: PageNavigation }) | null)?.navigation;
    navigation.current = nav ?? null;
    setBackHost(frame.current?.closest('section')?.querySelector('[data-desk-back]') ?? null);
    const update = () => setCanBack(!!nav?.canGoBack);
    update();
    nav?.addEventListener('currententrychange', update);
    const link = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href);
      if (url.origin === location.origin && (anchor.target || event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1)) {
        event.preventDefault();
        event.stopPropagation();
        doc.location.assign(url.href);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !doc.querySelector('[role="dialog"],dialog[open]')) onMinimise();
    };
    doc.addEventListener('click', link, true);
    doc.addEventListener('auxclick', link, true);
    doc.addEventListener('keydown', key);
    cleanup.current = () => {
      nav?.removeEventListener('currententrychange', update);
      doc.removeEventListener('click', link, true);
      doc.removeEventListener('auxclick', link, true);
      doc.removeEventListener('keydown', key);
    };
  };
  return <>{canBack && backHost && createPortal(
    <button type="button" title={backLabel} aria-label={backLabel} data-testid="desk-window-back" onClick={() => navigation.current?.back()}><ArrowLeft size={15}/></button>,
    backHost
  )}<iframe ref={frame} title={title} data-echo-desk-page="" src={href} onLoad={loaded}
    sandbox="allow-same-origin allow-scripts allow-forms allow-downloads" allow="microphone 'self'"
    style={{ width: '100%', height: '100%', display: 'block', border: 0 }} /></>;
}

