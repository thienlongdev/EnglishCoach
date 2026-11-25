'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ChevronDown, ChartNoAxesCombined, LogOut, UserRound } from 'lucide-react';
import { logout } from '@/services/logout';
import { journeyWarmSignOut } from '@/lib/journey/journey';
import styles from './AccountMenu.module.css';
import { useMorphPresence } from '@/components/morph/useMorphPresence';

export function AccountMenu({ locale, children }: { locale: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 72, right: 8 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const presence = useMorphPresence(open, menuRef, { trigger: triggerRef });
  const initialItem = useRef(0);
  const id = useId();
  const vi = locale === 'vi';

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    journeyWarmSignOut();
    const positionMenu = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPosition({ top: rect.bottom + 12, right: Math.max(8, window.innerWidth - rect.right) });
    };
    positionMenu();
    menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[initialItem.current]?.focus();
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  }, [open]);

  const menuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []);
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current + items.length - 1) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={`${id}-trigger`}
        aria-label={vi ? 'Tài khoản — Hồ sơ học tập' : 'Account — Learning profile'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => { initialItem.current = 0; setOpen(!open); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); initialItem.current = event.key === 'ArrowUp' ? 2 : 0; setOpen(true);
          }
        }}
        className={`${styles.trigger} inline-flex h-11 shrink-0 items-center gap-1 rounded-full pl-1 pr-2 xl:gap-2 xl:pr-3.5 cursor-pointer`}
      >
        <span className="pointer-events-none relative flex h-10 w-10 shrink-0 items-center justify-center" aria-hidden="true">{children}</span>
        <span className="hidden xl:block text-left whitespace-nowrap">
          <span className="block text-[13px] font-bold leading-5">{vi ? 'Tài khoản' : 'Account'}</span>
          <span className={`${styles.subtitle} block text-[11px] font-medium leading-4`}>{vi ? 'Hồ sơ học tập' : 'Learning profile'}</span>
        </span>
        <ChevronDown className={`${styles.chevron} h-3.5 w-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {presence.present && createPortal(
        <div
          {...presence.panelProps}
          ref={menuRef}
          id={`${id}-menu`}
          role="menu"
          aria-labelledby={`${id}-trigger`}
          onKeyDown={menuKeyDown}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== triggerRef.current) setOpen(false); }}
          className={`${styles.menu} z-[100] w-64 max-w-[calc(100vw-16px)] rounded-[1.15rem] p-1.5`}
          style={position}
        >
          <span className={styles.notch} aria-hidden="true" />
          <div role="none" className={styles.list} style={{ maxHeight: `calc(100dvh - ${position.top + 20}px)` }}>
            <Link role="menuitem" href="/profile" className={styles.item} onClick={() => close(false)}>
              <span className={styles.well} aria-hidden="true"><UserRound size={17} /></span>{vi ? 'Hồ sơ cá nhân' : 'Personal profile'}
            </Link>
            <Link role="menuitem" href="/progress" className={styles.item} onClick={() => close(false)}>
              <span className={styles.well} aria-hidden="true"><ChartNoAxesCombined size={17} /></span>{vi ? 'Tiến trình học tập' : 'Learning progress'}
            </Link>
            <span className={styles.rule} aria-hidden="true" />
            <button role="menuitem" type="button" className={`${styles.item} ${styles.logout}`} onClick={() => { close(false); void logout(); }}>
              <span className={styles.well} aria-hidden="true"><LogOut size={17} /></span>{vi ? 'Đăng xuất' : 'Sign out'}
            </button>
          </div>
        </div>, document.body
      )}
    </>
  );
}
