'use client';

import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useNavigationOverlay } from '@/lib/navigation/useAutoHideSurface';
import { useRouter } from 'next/navigation';
import { Check, Play, X } from 'lucide-react';
import { closeGuidePanel, guideRecord, setGuideAuto, setPendingGuide, startGuide, subscribeGuide } from '@/lib/guide/store';
import { allGuides, MODULE_LABEL, routeMatches } from '@/lib/guide/registry';
import { findTarget } from '@/lib/guide/quiet';
import type { GuideDef } from '@/lib/guide/types';
import { useOverlayTitle } from '@/lib/brand/tabTitle';
import styles from './guide.module.css';

/** The one place to replay anything: what this screen offers first, every other guide below it, and the learner's own switch for automatic offers. */
export function GuidePanel({ pathname, tab, vi }: { pathname: string; tab: string | null; vi: boolean }) {
  useOverlayTitle(vi ? 'Hướng dẫn' : 'Guides');
  useNavigationOverlay(true);
  const router = useRouter();
  const record = useSyncExternalStore(subscribeGuide, guideRecord, guideRecord);
  const ref = useRef<HTMLDivElement>(null);

  const { here, groups } = useMemo(() => {
    const here: GuideDef[] = [];
    const rest = new Map<string, GuideDef[]>();
    for (const def of allGuides) {
      if (routeMatches(def, pathname, tab) && (!def.gate || def.steps.some((s) => s.advance?.on === 'click') || findTarget(def.gate))) here.push(def);
      else if (def.home) {
        const key = def.module;
        rest.set(key, [...(rest.get(key) ?? []), def]);
      }
    }
    // What belongs to this screen first; the tools that exist on every page after it.
    const everywhere = (def: GuideDef) => def.path instanceof RegExp && def.path.source.startsWith('^\\/(?!exams');
    here.sort((a, b) => Number(everywhere(a)) - Number(everywhere(b)));
    return { here, groups: [...rest.entries()] };
  }, [pathname, tab]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeGuidePanel();
        return;
      }
      if (event.key !== 'Tab' || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>('button, input'));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const open = (def: GuideDef) => {
    if (routeMatches(def, pathname, tab)) {
      startGuide(def.id);
      return;
    }
    if (!def.home) return;
    closeGuidePanel();
    setPendingGuide(def.id);
    router.push(def.home);
  };

  const row = (def: GuideDef) => {
    const state = record.guides[def.id]?.s;
    return (
      <li key={def.id}>
        <button type="button" className={styles.row} onClick={() => open(def)} data-testid={`guide-row-${def.id}`}>
          <span className={styles.rowIcon} aria-hidden="true">{state === 'done' ? <Check size={15} /> : <Play size={13} />}</span>
          <span className={styles.rowText}>
            <strong>{vi ? def.title.vi : def.title.en}</strong>
            <small>{vi ? def.summary.vi : def.summary.en}</small>
          </span>
          {state === 'done' && <span className={styles.rowState}>{vi ? 'Đã xem' : 'Seen'}</span>}
        </button>
      </li>
    );
  };

  return (
    <div className={`${styles.tokens} ${styles.panelScrim}`} data-guide-layer="" onMouseDown={(event) => { if (event.target === event.currentTarget) closeGuidePanel(); }}>
      <div ref={ref} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="ec-guide-panel-title" data-testid="guide-panel">
        <header className={styles.panelHead}>
          <h2 id="ec-guide-panel-title" className={styles.panelTitle}>{vi ? 'Hướng dẫn' : 'Guides'}</h2>
          <button type="button" className={styles.iconButton} onClick={closeGuidePanel} aria-label={vi ? 'Đóng' : 'Close'} data-testid="guide-panel-close">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.panelBody}>
          {here.length > 0 && (
            <section>
              <h3 className={styles.panelLabel}>{vi ? 'Ở trang này' : 'On this page'}</h3>
              <ul className={styles.rows}>{here.map(row)}</ul>
            </section>
          )}
          {groups.map(([key, defs]) => (
            <section key={key}>
              <h3 className={styles.panelLabel}>{vi ? MODULE_LABEL[key as GuideDef['module']].vi : MODULE_LABEL[key as GuideDef['module']].en}</h3>
              <ul className={styles.rows}>{defs.map(row)}</ul>
            </section>
          ))}
          <section>
            <h3 className={styles.panelLabel}>{vi ? 'Ngoài English Coach' : 'Beyond English Coach'}</h3>
            <p className={styles.panelLabel} style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
              <a href="/echo-anywhere" onClick={(event) => { event.preventDefault(); closeGuidePanel(); router.push('/echo-anywhere'); }} data-testid="guide-echo-anywhere">
                {vi ? 'Echo Anywhere: học tiếng Anh trên mọi website' : 'Echo Anywhere: learn English on any website'}
              </a>
            </p>
          </section>
        </div>
        <label className={styles.panelSwitch}>
          <input type="checkbox" checked={record.auto} onChange={(event) => setGuideAuto(event.target.checked)} data-testid="guide-auto" />
          <span>{vi ? 'Echo tự gợi ý khi mình mở trang mới' : 'Let Echo offer a guide when I open something new'}</span>
        </label>
      </div>
    </div>
  );
}
