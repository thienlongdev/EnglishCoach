'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowUpRight, AudioLines, Users, Waves } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { pointerLight, releasePointer } from '@/lib/ui/pointerLight';
import styles from './arenaEntry.module.css';

/** A rendered view of the real world. The hub never loads its renderer or opens media. */
export function ArenaEntryPanel() {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    let visible = false;
    const pause = () => { el.dataset.paused = String(!visible || document.hidden); };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; pause(); });
    observer.observe(el);
    document.addEventListener('visibilitychange', pause);
    pause();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', pause); };
  }, []);

  return (
    <section ref={panel} className={styles.panel} aria-labelledby="speaking-arena-entry-title"
      data-spatial-owner="arena-entry" {...pointerLight} onPointerCancel={releasePointer}>
      <div className={styles.art} aria-hidden="true">
        <img src="/speaking/arena/tidegarden-dffbe169c559.webp" alt="" loading="lazy" decoding="async" />
        <div className={styles.artShade} />
      </div>
      <span className={styles.seal} aria-hidden="true"><Waves size={21} /><small>ECHO<br />TIDEGARDEN</small></span>
      <div className={styles.reflection} aria-hidden="true" />
      <div className={styles.content}>
        <span className={styles.eyebrow}>{vi ? 'NGƯỜI THẬT · TIẾNG ANH THẬT' : 'REAL PEOPLE · REAL ENGLISH'}</span>
        <h2 id="speaking-arena-entry-title">Speaking <em>Arena</em></h2>
        <div className={styles.features}>
          <span><Users size={14} />1v1 · 2v2</span>
          <span><AudioLines size={14} />{vi ? 'Voice trực tiếp' : 'Live voice'}</span>
          <span><Waves size={14} />{vi ? 'Không gian 3D' : '3D world'}</span>
        </div>
        <Link href="/speaking/arena" prefetch={false} className={styles.cta}>
          <span>{vi ? 'Bước vào đấu trường' : 'Enter the arena'}</span>
          <span className={styles.ctaIcon} aria-hidden="true"><ArrowUpRight size={21} /></span>
        </Link>
      </div>
    </section>
  );
}
