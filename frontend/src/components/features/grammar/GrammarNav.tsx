'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Briefcase, ChevronLeft, ChevronRight, CircleAlert, Dumbbell, FlaskConical, GraduationCap, Library, Network, Route, Search, BookOpenText } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { cx } from '@/lib/grammar/format';
import styles from './grammar.module.css';

const ITEMS = [
  { slug: 'path', href: '/grammar', vi: 'Lộ trình', en: 'Path', icon: Route, also: ['/grammar/topics'] },
  { slug: 'library', href: '/grammar/library', vi: 'Thư viện', en: 'Library', icon: Library, also: [] },
  { slug: 'practice', href: '/grammar/practice', vi: 'Luyện tập', en: 'Practice', icon: Dumbbell, also: ['/grammar/check'] },
  { slug: 'mistakes', href: '/grammar/mistakes', vi: 'Lỗi của tôi', en: 'My mistakes', icon: CircleAlert, also: [] },
  { slug: 'lab', href: '/grammar/lab', vi: 'Phòng thí nghiệm', en: 'Lab', icon: FlaskConical, also: [] },
  { slug: 'stories', href: '/grammar/stories', vi: 'Câu chuyện', en: 'Stories', icon: BookOpenText, also: [] },
  { slug: 'detective', href: '/grammar/detective', vi: 'Thám tử', en: 'Detective', icon: Search, also: [] },
  { slug: 'ielts', href: '/grammar/ielts', vi: 'IELTS', en: 'IELTS', icon: GraduationCap, also: [] },
  { slug: 'toeic', href: '/grammar/toeic', vi: 'TOEIC', en: 'TOEIC', icon: Briefcase, also: [] },
] as const;

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/**
 * The section bar of Ngữ pháp. Real links, one per area; on a phone it scrolls sideways inside itself and keeps the current
 * section in view. The lesson pages (`/grammar/topics/…`) belong to the path and the running check to practice, so those
 * sections stay lit while you are inside them (only the exact page carries `aria-current`).
 */
export function GrammarNav() {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const pathname = usePathname() || '/grammar';
  const scroller = useRef<HTMLUListElement | null>(null);
  const [edges, setEdges] = useState({ before: false, after: false });
  const measure = useCallback(() => {
    const list = scroller.current;
    if (!list) return;
    const before = list.scrollLeft > 2;
    const after = list.scrollWidth - list.clientWidth - list.scrollLeft > 2;
    setEdges((old) => old.before === before && old.after === after ? old : { before, after });
  }, []);

  const lit = (item: (typeof ITEMS)[number]) =>
    item.href === '/grammar' ? pathname === '/grammar' || item.also.some((a) => under(pathname, a)) : under(pathname, item.href) || item.also.some((a) => under(pathname, a));

  useEffect(() => {
    const list = scroller.current;
    const current = list?.querySelector<HTMLElement>('[data-lit="true"]');
    if (!list || !current) return;
    const reveal = () => {
      const bounds = list.getBoundingClientRect();
      const item = current.getBoundingClientRect();
      if (item.left < bounds.left || item.right > bounds.right) {
        list.scrollLeft += item.left - bounds.left - (bounds.width - item.width) / 2;
      }
      measure();
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    list.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); list.removeEventListener('scroll', measure); };
  }, [pathname, locale, measure]);

  const scroll = (direction: number) => {
    const list = scroller.current;
    if (!list) return;
    list.scrollBy({ left: direction * list.clientWidth * 0.72, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };

  return (
    <nav className={styles.nav} aria-label={vi ? 'Các phần của Ngữ pháp' : 'Grammar sections'}>
      <Link href="/grammar" className={styles.navBrand} aria-label={vi ? 'Học viện Ngữ pháp Echo' : 'Echo Grammar Academy'}>
        <span className={styles.navMark} aria-hidden="true"><Network /></span>
        <span className={styles.navBrandText}>
          <strong>{vi ? 'Ngữ pháp' : 'Grammar'}</strong>
          <small>{vi ? 'Học viện Echo' : 'Echo Academy'}</small>
        </span>
      </Link>
      <div className={styles.navRail} data-overflow={edges.before || edges.after ? 'true' : 'false'}>
      <button type="button" className={styles.navArrow} disabled={!edges.before} onClick={() => scroll(-1)} aria-label={vi ? 'Các mục phía trước' : 'Previous sections'} aria-controls="grammar-sections"><ChevronLeft aria-hidden="true" /></button>
      <ul id="grammar-sections" ref={scroller} className={styles.navList} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const links = Array.from(scroller.current?.querySelectorAll('a') ?? []);
        const at = links.indexOf(event.target as HTMLAnchorElement);
        if (at < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + links.length) % links.length;
        links[next]?.focus();
      }}>
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const on = lit(item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cx(styles.navLink, on && styles.navLinkOn)}
                data-lit={on ? 'true' : 'false'}
                data-guide={`grammar-nav-${item.slug}`}
                aria-current={pathname === item.href ? 'page' : undefined}
              >
                <Icon aria-hidden="true" />
                <span>{vi ? item.vi : item.en}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <button type="button" className={styles.navArrow} disabled={!edges.after} onClick={() => scroll(1)} aria-label={vi ? 'Các mục phía sau' : 'Next sections'} aria-controls="grammar-sections"><ChevronRight aria-hidden="true" /></button>
      </div>
    </nav>
  );
}
