'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { findPreset, posterUrl } from '@/lib/wallpaper/catalog';
import { findWorld, worldPoster, worldThumb } from '@/lib/wallpaper/worlds/catalog';
import { GLASS_TINTS, quietnessOf, useTypingQuiet, type WorldFrameParams } from '@/lib/wallpaper/worlds/orchestrate';
import { pickRendition, readScreenFacts, youtubeThumbnails } from '@/lib/wallpaper/media';
import { getDeviceVideo } from '@/lib/wallpaper/deviceVideos';
import {
  DEFAULT_PREFERENCE,
  accountKey,
  currentPreference,
  isBackgroundHeld,
  setWallpaperStatus,
  sourceKey,
  subscribeHold,
  subscribePreference,
} from '@/lib/wallpaper/storage';
import { SPATIAL_SURFACE_MARK, spatialOwnsBackdrop, subscribeSpatialBackdrop } from '@/lib/spatial/preference';
import { subscribeVfx, vfxPreference } from '@/lib/vfx/quality';
import { extractAmbientRgb } from '@/lib/background-studio/colorScience';
import { previewSwatchCss } from '@/lib/background-studio/cssRenderer';
import {
  hydrateBgPreferences,
  isStudyStageOccluded,
  resolveActiveBgConfig,
  subscribeBgState,
  subscribeLiveWorkspacePreview,
  subscribeStudyStageOccluded,
} from '@/lib/background-studio/store';
import BackgroundThemeLayer from '@/components/background-studio/BackgroundThemeLayer';
import type { WallpaperStatus } from '@/types/wallpaper';
import styles from './WallpaperStage.module.css';
import YouTubeBackdrop from './YouTubeBackdrop';

/**
 * The ONE background engine of the workspace (mounted once in ApplicationFrame; root tabs and routes inside the
 * workspace never remount it). Everything runs in the learner's browser: the file comes straight from the media CDN.
 *
 * Handoff: a new source is prepared in its own layer while the current wallpaper (or the app's own background) stays
 * on screen; it fades in only when it can be shown (poster decoded), and the video inside it fades in only once frames
 * are actually advancing. The old layer is removed after the crossfade, so at most two decoders overlap for < 1 s.
 * A source that fails (HTTP error, unsupported codec, 20 s without a frame) is dropped and the previous one stays.
 * A YouTube source (owner decision 2026-10-19) is YouTube's own muted, looping player in the layer (YouTubeBackdrop):
 * the browser streams it from YouTube; it counts as playing only from the player's own reports.
 */

const READY_TIMEOUT_MS = 20_000;
const CROSSFADE_MS = 900;

type Target = {
  /** Layer identity: source + motion + file. */
  id: string;
  source: string;
  kind: 'video' | 'image' | 'youtube' | 'world';
  url: string;
  /** Images: next URLs to try when one is missing (YouTube still frames: maxres → sd → hq). */
  fallbacks?: string[];
  /** youtube: the validated 11-character id (the player URL is rebuilt from it). */
  youtubeId?: string;
  /** Poster frame shown first for presets (decoded before the layer appears). */
  poster?: string;
  /** Video shown paused on its first frame (still motion for a custom video). */
  still: boolean;
  focus?: string;
  rendition?: { height: number; fps: number };
  /** world: which Living World this layer runs. */
  worldId?: string;
  /** The learner's video kept in this browser (IndexedDB of the account), played through a blob: URL of this layer. */
  deviceFile?: { userId: string; entryId: string };
};

/** loading (invisible) → shown; the outgoing one is "covered" (opaque, underneath) or "leaving" (fading to nothing). */
type Phase = 'loading' | 'shown' | 'covered' | 'leaving';
/**
 * `lead`: nothing else was on screen when this layer started (first load / refresh). Only then may a preset's poster
 * frame appear before its video plays; while switching, the previous wallpaper stays until the new video really plays.
 */
type Layer = { target: Target; phase: Phase; lead: boolean };

/** Workspace routes that paint their own scene: the wallpaper rests there (hidden, nothing decoding). */
export function wallpaperRestsOn(pathname: string): boolean {
  if (pathname.startsWith('/games/')) return true; // standalone games keep their own scenes; the Games hub shows it
  if (pathname.startsWith('/premium')) return true;
  if (pathname.startsWith('/knowledge-universe')) return true; // Vũ trụ tri thức: its own 3D universe, one graphics context
  if (/^\/listening\/[^/]+\/practice/.test(pathname)) return true; // focused dictation surface
  return false;
}

/** Routes that own an active WebGL scene (e.g. Hall of Champions trophy): rest ONLY WebGL world layers so two WebGL contexts never compete, while image/video/YouTube wallpapers keep running. */
export function worldWallpaperRestsOn(pathname: string, tab: string | null): boolean {
  return pathname.startsWith('/leaderboard') || (pathname === '/' && tab === 'leaderboard');
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

function usePageVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

function useAppDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    },
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );
}

export default function WallpaperStage() {
  const { data: session } = useSession();
  const userId = session?.user ? String((session.user as { id?: string | number }).id ?? '') : '';
  const storageKey = accountKey(userId);
  const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const tab = searchParams.get('tab');
  // A 3D preset being tried on the page is the one appearance for now: the wallpaper or world leaves the screen and releases its decoder or context (its preference is never touched) and comes back on Undo.
  const spatialBackdrop = useSyncExternalStore(subscribeSpatialBackdrop, spatialOwnsBackdrop, () => false);
  const resting = wallpaperRestsOn(pathname) || (pathname === '/learning-path' && searchParams.get('view') === 'odyssey');
  const worldResting = worldWallpaperRestsOn(pathname, tab);

  const pref = useSyncExternalStore(
    (onChange) => subscribePreference(storageKey, onChange),
    () => currentPreference(storageKey),
    () => DEFAULT_PREFERENCE,
  );
  const subscribeBg = useCallback(
    (onChange: () => void) => {
      const offState = subscribeBgState(userId, onChange);
      const offPreview = subscribeLiveWorkspacePreview(onChange);
      return () => {
        offState();
        offPreview();
      };
    },
    [userId],
  );
  const resolvedBg = useSyncExternalStore(
    subscribeBg,
    () => resolveActiveBgConfig(userId),
    () => null,
  );
  const studyOccluded = useSyncExternalStore(subscribeStudyStageOccluded, isStudyStageOccluded, () => false);
  const vfxMode = useSyncExternalStore(subscribeVfx, vfxPreference, () => 'auto' as const);
  const held = useSyncExternalStore(subscribeHold, isBackgroundHeld, () => false);
  const reducedMotion = useReducedMotion();
  const visible = usePageVisible();
  const appDark = useAppDark();
  const typing = useTypingQuiet();

  useEffect(() => {
    if (userId) void hydrateBgPreferences(userId);
  }, [userId]);

  const bgPreviewActive = Boolean(resolvedBg?.isPreview);

  // A Living World is told how quiet to be: the route's activity, the learner's Focus Mode, typing right now.
  const quiet = pref.worldFocus === 'off' ? 0 : pref.worldFocus === 'on' ? Math.max(0.9, quietnessOf(pathname, tab)) : Math.max(quietnessOf(pathname, tab), typing ? 0.85 : 0);
  const worldParams = useMemo<WorldFrameParams>(
    () => ({
      motion: pref.worldMotion ?? 0.6,
      pointer: pref.worldInteractive === false ? 0 : pref.worldPointer ?? 0.8,
      calm: quiet,
      dark: appDark,
    }),
    [pref.worldMotion, pref.worldPointer, pref.worldInteractive, quiet, appDark],
  );

  const target = useMemo<Target | null>(() => {
    const source = sourceKey(pref);
    if (!source || spatialBackdrop) return null;
    if (bgPreviewActive) return null;
    const still = pref.motion === 'still' || reducedMotion;
    const screen = readScreenFacts();
    // One background source at a time: the preference holds exactly one `source`, so a world never runs over a video.
    if (pref.source === 'world') {
      if (worldResting) return null;
      const world = findWorld(pref.worldId);
      if (!world) return null;
      return { id: `${source}|${still ? 'still' : 'live'}`, source, kind: 'world', url: '', worldId: world.id, poster: worldPoster(world.id) || undefined, still };
    }
    if (pref.source === 'preset') {
      const preset = findPreset(pref.presetId);
      if (!preset) return null;
      const cover = Math.max(screen.width, (screen.height * 16) / 9) * Math.min(2, Math.max(1, screen.dpr));
      if (still) {
        // A still is the provider's full-resolution poster frame, resized by its image CDN: nothing to decode.
        const width = Math.min(3840, Math.max(1280, Math.round(cover / 320) * 320));
        return { id: `${source}|still|${width}`, source, kind: 'image', url: posterUrl(preset, width), still: true, focus: preset.focus };
      }
      const file = pickRendition(preset, pref.quality, screen);
      return {
        id: `${source}|live|${file.url}`,
        source,
        kind: 'video',
        url: file.url,
        poster: posterUrl(preset, Math.min(1920, Math.max(1280, Math.round(cover / 320) * 320))),
        still: false,
        focus: preset.focus,
        rendition: { height: file.height, fps: file.fps },
      };
    }
    if (pref.source === 'custom' && pref.customUrl) {
      const kind = pref.customKind === 'video' ? 'video' : 'image';
      return { id: `${source}|${still ? 'still' : 'live'}`, source, kind, url: pref.customUrl, still: kind === 'video' && still };
    }
    // YouTube's own player behind the workspace (muted, looping); still motion = YouTube's own thumbnail of the video.
    if (pref.source === 'youtube' && pref.youtubeId) {
      if (still) {
        const [first, ...fallbacks] = youtubeThumbnails(pref.youtubeId);
        return { id: `${source}|still`, source, kind: 'image', url: first, fallbacks, still: true };
      }
      return { id: `${source}|live`, source, kind: 'youtube', url: '', youtubeId: pref.youtubeId, still: false };
    }
    // The learner's own video attached to an entry of their saved-video list: a direct link, or a file kept in this browser.
    if (pref.source === 'library' && pref.entryId) {
      const mode = still ? 'still' : 'live';
      if (pref.media === 'link' && pref.customUrl) return { id: `${source}|${mode}`, source, kind: 'video', url: pref.customUrl, still };
      if (pref.media === 'file' && userId) {
        return { id: `${source}|${mode}`, source, kind: 'video', url: '', still, deviceFile: { userId, entryId: pref.entryId } };
      }
    }
    return null;
    // pref is a stable snapshot: it changes only when the learner applies something.
  }, [pref, reducedMotion, userId, spatialBackdrop, worldResting, bgPreviewActive]);

  const [layers, setLayers] = useState<Layer[]>([]);
  const layersRef = useRef<Layer[]>([]);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  // A new target: prepare it beside what is shown; a target that was still loading is simply replaced.
  useEffect(() => {
    if (!target) {
      setLayers((prev) => prev.map((layer) => ({ ...layer, phase: 'leaving' as Phase })));
      setWallpaperStatus({ state: 'idle', key: null });
      return;
    }
    // Back to what is already on screen (e.g. a failed choice was reverted): nothing to load.
    if (layersRef.current.some((layer) => layer.target.id === target.id && layer.phase === 'shown')) {
      const still = target.kind === 'image' || target.still;
      setWallpaperStatus({ state: 'ready', key: target.source, rendition: still ? null : target.rendition ?? null, still });
      return;
    }
    setLayers((prev) => {
      if (prev.some((layer) => layer.target.id === target.id && layer.phase !== 'leaving')) return prev;
      const kept = prev.filter((layer) => layer.phase === 'shown' || layer.phase === 'covered');
      return [...kept, { target, phase: 'loading', lead: kept.length === 0 }];
    });
    setWallpaperStatus({ state: 'loading', key: target.source });
  }, [target]);

  // Outgoing layers are dropped once the crossfade is over (their media is released on unmount).
  useEffect(() => {
    if (!layers.some((layer) => layer.phase === 'leaving' || layer.phase === 'covered')) return;
    const timer = window.setTimeout(
      () => setLayers((prev) => prev.filter((layer) => layer.phase !== 'leaving' && layer.phase !== 'covered')),
      CROSSFADE_MS + 60,
    );
    return () => window.clearTimeout(timer);
  }, [layers]);

  const onShown = useCallback((id: string) => {
    setLayers((prev) => {
      // A layer already on its way out stays out, however late its first frame arrives.
      if (!prev.some((layer) => layer.target.id === id && layer.phase !== 'leaving')) return prev;
      return prev.map((layer) =>
        layer.target.id === id
          ? { ...layer, phase: 'shown' as Phase }
          : { ...layer, phase: (layer.phase === 'shown' || layer.phase === 'covered' ? 'covered' : 'leaving') as Phase },
      );
    });
  }, []);

  const onPlaying = useCallback((t: Target, still: boolean) => {
    if (layersRef.current.some((layer) => layer.target.id === t.id && layer.phase === 'leaving')) return;
    const next: WallpaperStatus = { state: 'ready', key: t.source, rendition: t.kind === 'video' && !still ? t.rendition ?? null : null, still };
    setWallpaperStatus(next);
  }, []);

  const onFail = useCallback((t: Target, reason: WallpaperStatus['reason']) => {
    setLayers((prev) => prev.filter((layer) => layer.target.id !== t.id));
    setWallpaperStatus({ state: 'failed', key: t.source, reason });
  }, []);

  const shown = layers.some((layer) => layer.phase === 'shown');
  const activeBg = !spatialBackdrop && resolvedBg && (resolvedBg.isPreview || !shown) ? resolvedBg : null;
  const bgShown = Boolean(activeBg) && !resting;
  const active = (shown || bgShown) && !resting;

  // The workspace surfaces turn transparent ONLY while a wallpaper is really on screen (never over an empty layer).
  useEffect(() => {
    const root = document.documentElement;
    if (active) root.setAttribute('data-wallpaper', 'on');
    else if (root.getAttribute('data-wallpaper') !== SPATIAL_SURFACE_MARK) root.removeAttribute('data-wallpaper');
    return () => {
      if (root.getAttribute('data-wallpaper') !== SPATIAL_SURFACE_MARK) root.removeAttribute('data-wallpaper');
    };
  }, [active]);

  useEffect(() => {
    document.documentElement.style.setProperty('--wp-clarity', String(pref.clarity));
  }, [pref.clarity]);

  // Sidebar swatch: a tiny picture of what is on screen (CSS only, so the sidebar needs no extra React state).
  const shownSource = layers.find((layer) => layer.phase === 'shown')?.target.source;
  const bgAccentRgb = useMemo(
    () => (bgShown && activeBg ? extractAmbientRgb(activeBg.config) : null),
    [bgShown, activeBg],
  );
  const bgThumbCss = useMemo(
    () => (bgShown && activeBg ? previewSwatchCss(activeBg.config) : null),
    [bgShown, activeBg],
  );
  useEffect(() => {
    const root = document.documentElement;
    if (bgAccentRgb && bgThumbCss) {
      root.style.setProperty('--wp-accent', bgAccentRgb);
      root.setAttribute('data-wp-accent', '');
      root.style.setProperty('--wp-thumb', bgThumbCss);
      return;
    }
    const preset = shownSource?.startsWith('preset:') ? findPreset(shownSource.slice(7)) : undefined;
    const youtube = shownSource?.startsWith('youtube:') ? shownSource.slice(8) : null;
    const world = shownSource?.startsWith('world:') ? shownSource.slice(6) : null;
    // Echo Visual Contract: a preset's accent is the light the foreground reflects (--eo-ambient, app/echo-ocean.css).
    const accent = preset?.accent?.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (accent) {
      root.style.setProperty('--wp-accent', accent.slice(1, 4).map((h) => parseInt(h, 16)).join(' '));
      root.setAttribute('data-wp-accent', '');
    } else {
      root.style.removeProperty('--wp-accent');
      root.removeAttribute('data-wp-accent');
    }
    if (preset) root.style.setProperty('--wp-thumb', `url("${posterUrl(preset, 96)}")`);
    else if (world && worldThumb(world)) root.style.setProperty('--wp-thumb', `url("${worldThumb(world)}")`);
    else if (youtube) root.style.setProperty('--wp-thumb', `url("${youtubeThumbnails(youtube)[2]}")`);
    else if (shownSource) root.style.setProperty('--wp-thumb', 'linear-gradient(135deg, #22d3ee, #6366f1 55%, #ec4899)');
    else root.style.removeProperty('--wp-thumb');
  }, [shownSource, bgAccentRgb, bgThumbCss]);

  // The workspace glass takes the world's tint, or the learner's own glass colour (any background).
  useEffect(() => {
    const root = document.documentElement;
    if (bgShown) {
      root.removeAttribute('data-glass-tint');
      root.style.removeProperty('--glass-tint');
      root.removeAttribute('data-world');
      return;
    }
    const world = shownSource?.startsWith('world:') ? findWorld(shownSource.slice(6)) : undefined;
    const tint = pref.glass && pref.glass !== 'auto' ? GLASS_TINTS[pref.glass] : world?.tint;
    if (tint && shownSource && !resting) {
      root.setAttribute('data-glass-tint', '');
      root.style.setProperty('--glass-tint', tint);
    } else {
      root.removeAttribute('data-glass-tint');
      root.style.removeProperty('--glass-tint');
    }
    if (world) root.setAttribute('data-world', world.id);
    else root.removeAttribute('data-world');
  }, [shownSource, pref.glass, resting, bgShown]);

  // The veil thickens a little while a world is being quiet. A video or a picture keeps exactly the learner's veil.
  const worldOnScreen = !bgShown && !!shownSource?.startsWith('world:');
  useEffect(() => {
    document.documentElement.style.setProperty('--wp-quiet', worldOnScreen ? String(quiet) : '0');
  }, [quiet, worldOnScreen]);

  const playing = !held && visible && !resting;

  if (!layers.length && !activeBg) return null;
  return (
    <div className={`${styles.stage} ${resting ? styles.stageResting : ''}`} aria-hidden="true" data-testid="wallpaper-stage">
      {activeBg && (
        <BackgroundThemeLayer
          config={activeBg.config}
          playing={playing && !studyOccluded}
          reducedMotion={reducedMotion}
          lowPower={vfxMode === 'low'}
        />
      )}
      {layers.map((layer) => (
        <WallpaperLayer
          key={layer.target.id}
          target={layer.target}
          phase={layer.phase}
          lead={layer.lead}
          playing={playing && !(layer.target.kind === 'world' && worldResting)}
          worldParams={worldParams}
          onShown={onShown}
          onPlaying={onPlaying}
          onFail={onFail}
        />
      ))}
      {(!bgShown || shown) && <div className={styles.veil} />}
    </div>
  );
}

function WallpaperLayer({
  target,
  phase,
  lead,
  playing,
  worldParams,
  onShown,
  onPlaying,
  onFail,
}: {
  target: Target;
  phase: Phase;
  lead: boolean;
  playing: boolean;
  worldParams: WorldFrameParams;
  onShown: (id: string) => void;
  onPlaying: (target: Target, still: boolean) => void;
  onFail: (target: Target, reason: WallpaperStatus['reason']) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoOn, setVideoOn] = useState(false);
  const [imageUrl, setImageUrl] = useState(target.url);
  const settled = useRef(false);

  // YouTube: the player's own reports decide (YouTubeBackdrop); the layer appears only once it really plays.
  const onYouTubeProven = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    setVideoOn(true);
    onShown(target.id);
    onPlaying(target, false);
  }, [target, onShown, onPlaying]);
  const onYouTubeFail = useCallback(
    (reason: WallpaperStatus['reason']) => {
      if (settled.current) return;
      settled.current = true;
      onFail(target, reason);
    },
    [target, onFail],
  );

  // Images (presets in still mode, custom images): decoded before the layer may appear.
  useEffect(() => {
    if (target.kind === 'world') return; // a world decides by its own first frame (WorldCanvas)
    if (target.kind !== 'image' && !(target.poster && lead)) return;
    let cancelled = false;
    const candidates = target.kind === 'image' ? [target.url, ...(target.fallbacks ?? [])] : [target.poster as string];
    const image = new Image();
    image.decoding = 'async';
    // A missing size of a still frame may answer 404 or a 120 px grey placeholder: try the next one.
    const load = (index: number): Promise<void> => {
      image.src = candidates[index];
      return image.decode().then(
        () => {
          if (index < candidates.length - 1 && image.naturalWidth <= 120) return load(index + 1);
          if (index !== 0) setImageUrl(candidates[index]);
        },
        (error: unknown) => {
          if (index < candidates.length - 1) return load(index + 1);
          throw error;
        },
      );
    };
    load(0)
      .then(() => {
        if (cancelled) return;
        onShown(target.id);
        if (target.kind === 'image' && !settled.current) {
          settled.current = true;
          onPlaying(target, true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        // A broken poster is not fatal for a video (the video itself may still play); a broken image is.
        if (target.kind === 'image' && !settled.current) {
          settled.current = true;
          onFail(target, 'network');
        }
      });
    return () => {
      cancelled = true;
    };
    // `lead` is fixed for the layer's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, onShown, onPlaying, onFail]);

  // Videos: playback is proven by advancing frames, never by the element existing.
  useEffect(() => {
    if (target.kind !== 'video') return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    const succeed = (still: boolean) => {
      if (cancelled || settled.current) return;
      settled.current = true;
      window.clearTimeout(timeout);
      setVideoOn(true);
      onShown(target.id);
      onPlaying(target, still);
    };
    const fail = (reason: WallpaperStatus['reason']) => {
      if (cancelled || settled.current) return;
      settled.current = true;
      window.clearTimeout(timeout);
      onFail(target, reason);
    };
    // A hidden tab may not decode: the clock only runs while the page is visible.
    const arm = (): number =>
      window.setTimeout(() => {
        if (document.visibilityState === 'hidden') timeout = arm();
        else fail('timeout');
      }, READY_TIMEOUT_MS);
    let timeout = arm();
    const onError = () => {
      const code = video.error?.code;
      fail(code === 3 ? 'decode' : 'network');
    };
    const onFrame = () => {
      if (video.currentTime > 0 && !video.paused) succeed(false);
    };
    const onLoaded = () => {
      if (target.still) succeed(true);
    };
    video.addEventListener('error', onError);
    video.addEventListener('timeupdate', onFrame);
    video.addEventListener('loadeddata', onLoaded);
    // Muted + inline is what lets browsers autoplay; set as properties (React does not reliably reflect `muted`).
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    let objectUrl: string | null = null;
    const start = (url: string) => {
      if (cancelled) return;
      video.src = url;
      if (!target.still) {
        video.play().catch((error: DOMException) => {
          // Autoplay refused (power saving, browser policy): show the first frame instead, and say so.
          if (error?.name === 'NotAllowedError') {
            const showFrame = () => succeed(true);
            if (video.readyState >= 2) showFrame();
            else video.addEventListener('loadeddata', showFrame, { once: true });
          }
        });
      }
    };
    if (target.deviceFile) {
      // A file kept on this device: read from the account's own IndexedDB, never fetched from anywhere.
      getDeviceVideo(target.deviceFile.userId, target.deviceFile.entryId)
        .then((stored) => {
          if (cancelled) return;
          if (!stored) return fail('missing');
          objectUrl = URL.createObjectURL(stored.blob);
          start(objectUrl);
        })
        .catch(() => fail('missing'));
    } else {
      start(target.url);
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      video.removeEventListener('error', onError);
      video.removeEventListener('timeupdate', onFrame);
      video.removeEventListener('loadeddata', onLoaded);
      // Release the decoder and stop the download.
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target, onShown, onPlaying, onFail]);

  // Pause while hidden / held / resting; resume after (only once the source proved it plays).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || target.kind !== 'video' || target.still || !videoOn) return;
    // Only the wallpaper on top keeps decoding; an outgoing one freezes on its frame for the last few hundred ms.
    if (playing && phase === 'shown') video.play().catch(() => {});
    else video.pause();
  }, [playing, phase, videoOn, target]);

  const style = target.focus ? { objectPosition: target.focus } : undefined;
  return (
    <div
      className={`${styles.layer} ${phase === 'shown' ? styles.layerShown : phase === 'covered' ? styles.layerCovered : ''}`}
      data-wallpaper-layer={phase}
    >
      {target.kind === 'world' && target.worldId ? (
        <WorldCanvas
          target={target}
          lead={lead}
          params={worldParams}
          active={playing && phase === 'shown'}
          onShown={() => onShown(target.id)}
          onReady={(still) => onPlaying(target, still)}
          onFail={(reason) => onFail(target, reason)}
        />
      ) : target.kind === 'youtube' && target.youtubeId ? (
        // Only the wallpaper on top plays; an outgoing one is paused for its last few hundred ms.
        <YouTubeBackdrop videoId={target.youtubeId} active={playing && phase !== 'covered' && phase !== 'leaving'} onProven={onYouTubeProven} onFail={onYouTubeFail} />
      ) : target.kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.media} src={imageUrl} alt="" decoding="async" style={style} referrerPolicy={target.fallbacks ? 'no-referrer' : undefined} />
      ) : (
        <>
          {target.poster && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={styles.media} src={target.poster} alt="" decoding="async" style={style} />
          )}
          <video
            ref={videoRef}
            className={`${styles.media} ${styles.video} ${videoOn ? styles.videoOn : ''}`}
            style={style}
            muted
            loop
            playsInline
            preload="auto"
            disablePictureInPicture
            disableRemotePlayback
            tabIndex={-1}
          />
        </>
      )}
    </div>
  );
}

/**
 * A running Living World in a layer. The still (a real frame of the same world) sits underneath: it is the first
 * paint, and it is what stays when the device has no WebGL 2 or cannot keep up. The graphics code loads only here.
 */
function WorldCanvas({
  target,
  lead,
  params,
  active,
  onShown,
  onReady,
  onFail,
}: {
  target: Target;
  lead: boolean;
  params: WorldFrameParams;
  active: boolean;
  onShown: () => void;
  onReady: (still: boolean) => void;
  onFail: (reason: WallpaperStatus['reason']) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<import('@/lib/wallpaper/worlds/runtime').WorldRuntime | null>(null);
  const [drawn, setDrawn] = useState(false);
  const callbacks = useRef({ onShown, onReady, onFail });
  const paramsRef = useRef(params);
  const activeRef = useRef(active);
  useEffect(() => {
    callbacks.current = { onShown, onReady, onFail };
    paramsRef.current = params;
    activeRef.current = active;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !target.worldId) return;
    let cancelled = false;
    let told = false;
    // A world that cannot run falls back to its picture when it has one: never an empty screen.
    const toStill = (reason: WallpaperStatus['reason']) => {
      if (cancelled || told) return;
      told = true;
      if (!target.poster) {
        callbacks.current.onFail(reason);
        return;
      }
      callbacks.current.onShown();
      callbacks.current.onReady(true);
    };
    import('@/lib/wallpaper/worlds/runtime')
      .then(({ startWorld }) => {
        if (cancelled) return;
        runtimeRef.current = startWorld({
          id: target.worldId as string,
          host,
          params: paramsRef.current,
          still: target.still,
          onFirstFrame: () => {
            if (cancelled) return;
            setDrawn(true);
            if (told) return;
            told = true;
            callbacks.current.onShown();
            callbacks.current.onReady(target.still);
          },
          onFail: (reason) => {
            setDrawn(false);
            toStill(reason === 'unsupported' ? 'unsupported' : 'decode');
          },
          onOverload: () => {
            // Too heavy for this device even at the lowest quality: the still takes over, the page stays smooth.
            setDrawn(false);
            runtimeRef.current?.dispose();
            runtimeRef.current = null;
          },
        });
      })
      .catch(() => toStill('network'));
    return () => {
      cancelled = true;
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
    // The target's identity is the layer's identity: a new world is a new layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);

  useEffect(() => {
    runtimeRef.current?.setParams(params);
  }, [params]);

  // Only the world on top runs; an outgoing one holds its last frame for the rest of the crossfade.
  useEffect(() => {
    if (drawn) runtimeRef.current?.setPlaying(active);
  }, [active, drawn]);

  return (
    <>
      {target.poster && (
        // eslint-disable-next-line @next/next/no-img-element
        // First load: the still appears at once; the running world takes over from it when its first frame is drawn.
        <img className={styles.media} src={target.poster} alt="" decoding="async" onLoad={() => { if (lead) callbacks.current.onShown(); }} />
      )}
      <div ref={hostRef} className={`${styles.world} ${drawn ? styles.worldOn : ''}`} data-world-layer={target.worldId} />
    </>
  );
}
