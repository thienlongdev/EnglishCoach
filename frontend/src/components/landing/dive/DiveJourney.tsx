'use client';

import React, { useRef } from 'react';
import { useDiveScroll } from './useDiveScroll';
import { ChartScene, MemoryScene, PageScene, SoundScene, WorldsScene } from './DiveScenes';
import styles from './dive.module.css';

const DEPTHS = [
  { id: 'tu-vung', label: 'Từ vựng' },
  { id: 'nghe-noi', label: 'Nghe và nói' },
  { id: 'doc-viet', label: 'Đọc và viết' },
  { id: 'lo-trinh', label: 'Lộ trình' },
  { id: 'the-gioi', label: 'Khám phá' },
];

/**
 * The learning journey below the hero: one dive through five depths of the same ocean. Each depth shows one way the
 * product teaches (a word becoming a memory, sound becoming speech, a page opening into context and writing, a
 * personal chart, the worlds around the lessons) with a small working example instead of a product screenshot.
 *
 * All meaning is server-rendered HTML in reading order; the scroll script (useDiveScroll) and the ocean's light
 * (data-ocean-form, drawn by the landing's one WebGL engine) only add to it.
 */
export function DiveJourney() {
  const rootRef = useRef<HTMLElement>(null);
  useDiveScroll(rootRef);

  return (
    <section ref={rootRef} id="features-section" className={`${styles.dive} relative pb-10 pt-16 lg:pt-24`} aria-labelledby="dive-title">
      <nav className={styles.gauge} data-dive-gauge data-shown="0" aria-label="Các tầng của hành trình học">
        <ol>
          {DEPTHS.map((depth) => (
            <li key={depth.id}>
              <a href={`#${depth.id}`} data-dive-mark={depth.id}>
                <span>{depth.label}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <header data-dive-track className={`${styles.track} relative mx-auto max-w-3xl space-y-5 px-5 pb-6 text-center sm:px-8 lg:pb-20`}>
        {/* Echo rests beside the title on wide screens before the dive begins. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-full top-1/2 ml-6 h-56 w-56 -translate-y-1/2"
          data-whale-lane="features"
          data-whale-path="hover"
          data-whale-size="220,0,0"
          data-whale-amp="0.12"
          data-whale-period="14"
          data-whale-min="1280"
        />
        <p className={`${styles.depth} ${styles.rise} justify-center`}>Hành trình học</p>
        <h2 id="dive-title" className={`${styles.title} ${styles.rise}`} style={{ '--lag': 0.05 } as React.CSSProperties}>
          Lặn xuống cùng Echo: mỗi tầng nước là một cách học tiếng Anh
        </h2>
        <p className={`${styles.lead} ${styles.rise}`} style={{ '--lag': 0.1 } as React.CSSProperties}>
          Đừng chỉ đọc về nó. Ở mỗi tầng bên dưới có một ví dụ nhỏ để bạn thử ngay: lật một thẻ từ, nghe một câu, chạm vào một cụm từ lạ.
        </p>
      </header>

      <MemoryScene />
      <SoundScene />
      <PageScene />
      <ChartScene />
      <WorldsScene />
    </section>
  );
}
