'use client';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { KING_ART, KING_MODE_ART } from './kingArt';
import styles from './king.module.css';

type ShellMode = 'REFLEX' | 'EXPLAIN' | 'REORDER' | 'CONQUEST';

/**
 * The royal world around King Of English. Lobby (no `onQuit`): the world inside the workspace, back to the Games Library.
 * Arena (`onQuit`): a full-screen stage in the mode's own light, with its own return control (the caller portals it to <body>).
 */
export function KingShell({ vi, children, onQuit, score, progress, mode }: {
  vi: boolean; children: ReactNode; onQuit?: () => void; score?: number; progress?: string; mode?: ShellMode | null;
}) {
  const key = mode ? mode.toLowerCase() : undefined;
  return <div data-king-arena={onQuit ? "true" : undefined} data-morph={onQuit ? "off" : undefined} data-spatial-owner={onQuit ? "king-arena" : undefined} data-mode={key} className={`king-shell ${styles.world} ${onQuit ? styles.arena : ''}`}>
    {onQuit ? <div className={styles.stageBg} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.stageArt} src={mode ? KING_MODE_ART[mode] : KING_ART.hero} alt="" decoding="async" fetchPriority="low" />
      <div className={styles.stageVeil} />
    </div> : <div className={styles.lobbyBg} aria-hidden="true" />}
    {onQuit ? <div className={styles.stage}>
      <nav aria-label={vi ? 'Điều hướng trò chơi' : 'Game navigation'} className={styles.stageTop}>
        <button type="button" className={styles.quit} onClick={onQuit}><ArrowLeft className="h-4 w-4" aria-hidden="true" />{vi ? 'Về sảnh King' : 'King lobby'}</button>
        <span className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={KING_ART.crown} alt="" width={64} height={51} />King Of English
        </span>
        {score !== undefined && <span className={styles.chip}>{progress} · {vi ? 'Điểm' : 'Score'} {score}</span>}
      </nav>
      {children}
    </div> : <div className={styles.lobby}>
      <nav aria-label={vi ? 'Điều hướng trò chơi' : 'Game navigation'}>
        <Link href="/games" className={styles.backLink}><ArrowLeft className="h-4 w-4" aria-hidden="true" />{vi ? 'Thư viện trò chơi' : 'Games Library'}</Link>
      </nav>
      {children}
    </div>}
    <style>{`.king-shell button:focus-visible,.king-shell a:focus-visible{outline:3px solid #ffd97a;outline-offset:3px}.king-shell button{touch-action:manipulation}html:has([data-king-arena="true"]){overflow:hidden}body:has([data-king-arena="true"])>div:not([data-king-arena="true"]):not([data-journey-host]){visibility:hidden}@media(max-width:767px){body:has([data-king-arena="true"]) .echo-launcher,body:has([data-king-arena="true"]) .echo-discovery{display:none}}@media(max-width:639px){body:has([data-king-arena="true"]) [data-purpose="main-navigation-sidebar"]{display:none}}@media(prefers-reduced-motion:reduce){.king-shell *, .king-shell *::before,.king-shell *::after{animation:none!important;transition:none!important}}`}</style>
  </div>;
}
