'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { pointerLight } from '@/lib/ui/pointerLight';
import s from './odysseyEntry.module.css';

/** A miniature liquid-pearl planet. Composited CSS, sharing the existing pointer light; no renderer or navigation delay. */
export default function OdysseyEntry() {
  const { locale } = useLanguage();
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let visible = false;
    const sync = () => { el.dataset.live = String(visible && !document.hidden); };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    observer.observe(el);
    document.addEventListener('visibilitychange', sync);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync); };
  }, []);
  const vi = locale !== 'en';
  return <div className={s.placement}>
    <Link ref={ref} href="/learning-path?view=odyssey" className={s.entry} {...pointerLight}
      data-spatial-owner="odyssey-entry" data-morph="off" data-testid="odyssey-entry"
      onKeyDown={e => { if (e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}>
      <span className={s.art} aria-hidden="true"><span className={s.orbit} /><span className={s.planet}><span className={s.land} /></span><span className={s.moon} /></span>
      <span className={s.copy}><strong>{vi ? 'Khám phá Echo Odyssey' : 'Explore Echo Odyssey'}</strong><span>{vi ? 'Mở hành tinh học tập của bạn' : 'Enter your learning planet'}</span></span>
      <ArrowUpRight className={s.arrow} size={20} aria-hidden="true" />
    </Link>
  </div>;
}
