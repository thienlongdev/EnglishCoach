'use client';
import { useEffect, useState, type CSSProperties } from 'react';
import { Disc3 } from 'lucide-react';
import type { MusicTrack } from '@/lib/music/model';
import { getTrack } from '@/lib/music/storage';
import { useMusicEngine } from './MusicProvider';
import styles from './MusicArtwork.module.css';

/** Cover art: official artist artwork, or the embedded cover of a local file (a revoked blob: URL). */
export function MusicArtwork({ track, className = '', priority = false, decorative = false }: { track: MusicTrack; className?: string; priority?: boolean; decorative?: boolean }) {
  const engine = useMusicEngine();
  const [local, setLocal] = useState<{ id: string; url: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (track.source !== 'local' || !engine?.scope) return;
    let cancelled = false, url: string | null = null;
    void getTrack(engine.scope, track.id).then(row => {
      if (cancelled || !row?.cover) return;
      url = URL.createObjectURL(row.cover); setLocal({ id: track.id, url });
    }).catch(() => {});
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [track.id, track.source, engine?.scope]);
  const src = track.artwork ?? (local?.id === track.id ? local.url : null);
  return <div className={`${styles.artwork} ${className}`} style={{ '--music-accent': track.accent } as CSSProperties} aria-hidden={decorative || undefined}>
    {src && failed !== src ? <img src={src} alt={decorative ? '' : `${track.title} · ${track.artist || 'Echo Music'}`} loading={priority ? 'eager' : 'lazy'} decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(src)} />
      : <div className={styles.artFallback} aria-label={decorative ? undefined : track.title}><Disc3 aria-hidden="true" /><span>{track.title.slice(0, 1).toUpperCase()}</span></div>}
  </div>;
}
