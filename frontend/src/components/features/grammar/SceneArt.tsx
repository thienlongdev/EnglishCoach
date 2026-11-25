'use client';

import React, { useEffect } from 'react';
import { GRAMMAR_ART } from '@/lib/grammar/art';
import { cx } from '@/lib/grammar/format';
import { useInView, usePrefersReducedMotion } from './diagrams/shared';
import a from './academy.module.css';

/** The scene keys of the stories (docs/grammar/CONTENT-SCHEMA.md): a name in both languages and the tone of its fallback. */
const SCENES: Record<string, { vi: string; en: string; tone: string }> = {
  university: { vi: 'Đại học', en: 'University', tone: 'violet' },
  supermarket: { vi: 'Siêu thị', en: 'Supermarket', tone: 'meadow' },
  interview: { vi: 'Phỏng vấn', en: 'Interview', tone: 'ocean' },
  restaurant: { vi: 'Nhà hàng', en: 'Restaurant', tone: 'ember' },
  airport: { vi: 'Sân bay', en: 'Airport', tone: 'lagoon' },
  office: { vi: 'Văn phòng', en: 'Office', tone: 'harbor' },
  home: { vi: 'Ở nhà', en: 'At home', tone: 'dawn' },
  'library-mystery': { vi: 'Thư viện bí ẩn', en: 'Library mystery', tone: 'violet' },
  starship: { vi: 'Tàu vũ trụ', en: 'Starship', tone: 'ocean' },
  lecture: { vi: 'Giảng đường', en: 'Lecture hall', tone: 'pearl' },
  station: { vi: 'Nhà ga', en: 'Station', tone: 'reef' },
  newsroom: { vi: 'Toà soạn', en: 'Newsroom', tone: 'sun' },
};

export const sceneLabel = (key: string, vi: boolean): string => {
  const s = SCENES[key];
  return s ? (vi ? s.vi : s.en) : key;
};

/**
 * A story's scene. The picture is `GRAMMAR_ART.scenes[key]` when it has shipped; until then (or for a key without a picture) a
 * typographic plate stands in: the scene's name in outline over a tinted sea, never a stock image. With `parallax` the picture
 * leans a little with a mouse pointer, only while the plate is on screen and never under reduced motion. Decoration: it takes
 * no pointer input and carries only a text alternative that names the scene.
 */
export function SceneArt({ scene, vi, size = 'plate', parallax = false, className }: {
  scene: string; vi: boolean; size?: 'plate' | 'hero' | 'thumb'; parallax?: boolean; className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>();
  const src = (GRAMMAR_ART.scenes as Record<string, string>)[scene] || '';
  const info = SCENES[scene];
  const name = sceneLabel(scene, vi);

  useEffect(() => {
    const el = ref.current;
    if (!parallax || !src || reduced || !inView || !el || typeof window === 'undefined' || !window.matchMedia('(pointer: fine)').matches) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        el.style.setProperty('--px', String(Math.max(-1, Math.min(1, (e.clientX / window.innerWidth - 0.5) * 2)).toFixed(3)));
        el.style.setProperty('--py', String(Math.max(-1, Math.min(1, (e.clientY / window.innerHeight - 0.5) * 2)).toFixed(3)));
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame) window.cancelAnimationFrame(frame);
      el.style.removeProperty('--px');
      el.style.removeProperty('--py');
    };
  }, [parallax, src, reduced, inView, ref]);

  const thumb = size === 'thumb';
  return (
    <div
      ref={ref}
      className={cx(a.scene, className)}
      data-size={size}
      data-tone={info?.tone ?? 'pearl'}
      data-spatial-owner=""
      role={thumb ? undefined : 'img'}
      aria-label={thumb ? undefined : (vi ? `Cảnh: ${name}` : `Scene: ${name}`)}
      aria-hidden={thumb ? 'true' : undefined}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={a.sceneImg} src={src} alt="" loading="lazy" decoding="async" draggable={false} />
      ) : (
        <>
          <svg className={a.sceneWaves} viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <path d="M0 22q50-18 100 0t100 0t100 0t100 0" />
            <path d="M0 40q50-18 100 0t100 0t100 0t100 0" />
          </svg>
          <p className={a.sceneWord} aria-hidden="true">{name}</p>
        </>
      )}
    </div>
  );
}
