'use client';

import React, { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname, useSearchParams } from 'next/navigation';
import { MusicEngine, type MusicState } from '@/lib/music/engine';
import { bindMusicAnalysis } from '@/lib/vfx/audio';
import { focusReason } from '@/lib/music/model';
import { authEnding, subscribeAuthLifecycle } from '@/lib/auth-lifecycle';

const MusicContext = createContext<MusicEngine | null>(null);
const noop = () => () => {};
const EMPTY: MusicState = { ready: false, library: [], queue: [], current: null, playing: false, loading: false,
  time: 0, duration: 0, volume: .45, shuffle: false, repeat: 'all', error: null, focus: null, importing: false, importResult: null, engaged: false };
const emptySnapshot = () => EMPTY;
export const useMusicEngine = () => useContext(MusicContext);
export function useMusic() {
  const engine = useContext(MusicContext);
  const state = useSyncExternalStore(engine?.subscribe ?? noop, engine?.snapshot ?? emptySnapshot, emptySnapshot);
  return { engine, ...state };
}
export function MusicProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const scope = status === 'authenticated' ? String((session?.user as { id?: string })?.id ?? '') : null;
  const [engine, setEngine] = useState<MusicEngine | null>(null);
  const lastAudibleVolumeRef = useRef(0.45);
  const pathname = usePathname() ?? '';
  const params = useSearchParams();
  const tab = params.get('tab') ?? '';
  useEffect(() => {
    if (status === 'loading') return;
    const instance = new MusicEngine(scope || null);
    setEngine(instance);
    const unbindAnalysis = bindMusicAnalysis(instance);
    void instance.initialize();
    const checkpoint = () => instance.checkpoint();
    const unsubscribe = subscribeAuthLifecycle(() => { if (authEnding()) instance.pause(); });
    window.addEventListener('pagehide', checkpoint);
    return () => { unbindAnalysis(); unsubscribe(); window.removeEventListener('pagehide', checkpoint); instance.dispose(); };
  }, [scope, status]);
  useEffect(() => { engine?.setFocus(focusReason(pathname, tab)); }, [engine, pathname, tab]);
  useEffect(() => {
    if (!engine) return;
    const holds = new Map<HTMLMediaElement, string>();
    const play = (event: Event) => {
      const media = event.target;
      if (!(media instanceof HTMLMediaElement) || media.dataset.echoMusic || media.muted || media.volume === 0) return;
      const id = holds.get(media) ?? crypto.randomUUID(); holds.set(media, id); engine.hold(id, true);
    };
    const release = (event: Event) => {
      const media = event.target as HTMLMediaElement;
      const id = holds.get(media); if (id) { engine.hold(id, false); holds.delete(media); }
    };
    const explicit = (event: Event) => { const detail = (event as CustomEvent).detail; if (typeof detail?.id === 'string') engine.hold(detail.id, detail.active === true); };
    const onJarvisMusic = (event: Event) => {
      const detail = (event as CustomEvent<{ command?: string; handledByHost?: boolean } | undefined>).detail;
      if (!detail?.command || detail.handledByHost === true) return;
      const snap = engine.snapshot();
      if (snap.volume > 0.02) {
        lastAudibleVolumeRef.current = snap.volume;
      }
      switch (detail.command) {
        case 'play':
          void engine.play();
          break;
        case 'pause':
          engine.pause();
          break;
        case 'toggle':
          engine.toggle();
          break;
        case 'next':
          if (!snap.queue.length) void engine.play();
          else void engine.next(1);
          break;
        case 'prev':
          if (!snap.queue.length) void engine.play();
          else void engine.next(-1);
          break;
        case 'volume_up':
          engine.volume(Math.min(1, Math.round((snap.volume + 0.15) * 100) / 100));
          break;
        case 'volume_down':
          engine.volume(Math.max(0, Math.round((snap.volume - 0.15) * 100) / 100));
          break;
        case 'mute':
          if (snap.volume > 0.02) lastAudibleVolumeRef.current = snap.volume;
          engine.volume(0);
          break;
        case 'unmute':
          engine.volume(snap.volume > 0.02 ? snap.volume : (lastAudibleVolumeRef.current || 0.45));
          break;
        case 'shuffle':
          engine.shuffle();
          break;
        default:
          break;
      }
    };
    document.addEventListener('play', play, true); document.addEventListener('pause', release, true); document.addEventListener('ended', release, true);
    window.addEventListener('ec:music-focus', explicit);
    window.addEventListener('ec:music-pause', engine.pause);
    window.addEventListener('ec:jarvis:music', onJarvisMusic);
    return () => {
      document.removeEventListener('play', play, true); document.removeEventListener('pause', release, true); document.removeEventListener('ended', release, true);
      window.removeEventListener('ec:music-focus', explicit); holds.forEach(id => engine.hold(id, false));
      window.removeEventListener('ec:music-pause', engine.pause);
      window.removeEventListener('ec:jarvis:music', onJarvisMusic);
    };
  }, [engine, pathname, tab]);
  return <MusicContext.Provider value={engine}>{children}</MusicContext.Provider>;
}
