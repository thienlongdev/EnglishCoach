'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useSearchParams } from 'next/navigation';
import { useLanguage } from '@/context/LanguageContext';
import { findSpatialPreset } from '@/lib/spatial/catalog';
import { spatialProfile } from '@/lib/spatial/context';
import { createSpatialController, type SpatialController, type SpatialStatus } from '@/lib/spatial/engine/controller';
import { accountOfKey, applySpatialAppearance } from '@/lib/appearance/state';
import { DEFAULT_SPATIAL, SPATIAL_SURFACE_MARK, isSpatialDraft, setSpatialDraft, setSpatialOwnsBackdrop, storedSpatial, writeSpatial, type SpatialPreference } from '@/lib/spatial/preference';
import { spatialThumb } from '@/lib/spatial/thumbs';
import { currentPreference, accountKey, isBackgroundHeld, subscribeHold, subscribePreference } from '@/lib/wallpaper/storage';
import { resolveActiveBgConfig, subscribeBgState, subscribeLiveWorkspacePreview } from '@/lib/background-studio/store';
import { useTypingQuiet } from '@/lib/wallpaper/worlds/orchestrate';
import '@/lib/spatial/spatial.css';

/**
 * The running experience on the real workspace. One controller for the whole session in the shell: route changes reach it as data, never as a remount,
 * so the chosen preset is continuous across modules, refresh (preference) and Back / Forward. SpatialHost mounts it only while 3D space is the one active appearance. It decides only two things itself:
 *  - what each screen may do (`spatialProfile`, the coverage matrix);
 *  - the marks on <html> that make the page's own surfaces see-through while a scene is the background.
 */
const SpatialGalleryRoom = dynamic(() => import('./SpatialGalleryRoom'), { ssr: false });

function useDark(): boolean {
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

function useReduced(): boolean {
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

export default function SpatialRuntimeView({ storageKey, pref }: { storageKey: string; pref: SpatialPreference }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const pathname = usePathname() || '';
  const search = useSearchParams();
  const profile = useMemo(() => spatialProfile(pathname, search), [pathname, search]);
  const preset = findSpatialPreset(pref.presetId) ?? findSpatialPreset(DEFAULT_SPATIAL.presetId)!;
  const dark = useDark();
  const reduced = useReduced();
  const typing = useTypingQuiet();
  const held = useSyncExternalStore(subscribeHold, isBackgroundHeld, () => false);

  // Being mounted means 3D space is the active appearance. A wallpaper or Background Studio theme can exist underneath only while a preset is being tried: it rests, its preference untouched.
  const account = accountOfKey(storageKey);
  const wallpaperKey = accountKey(account);
  const wallpaper = useSyncExternalStore(
    (onChange) => subscribePreference(wallpaperKey, onChange),
    () => currentPreference(wallpaperKey),
    () => currentPreference(wallpaperKey),
  );
  const subscribeBg = useCallback(
    (onChange: () => void) => {
      const offBg = subscribeBgState(account, onChange);
      const offPreview = subscribeLiveWorkspacePreview(onChange);
      return () => {
        offBg();
        offPreview();
      };
    },
    [account],
  );
  const hasBgTheme = useSyncExternalStore(
    subscribeBg,
    () => resolveActiveBgConfig(account) !== null,
    () => false,
  );
  const hasWallpaper = wallpaper.source !== 'none' || hasBgTheme;
  const sceneAllowed = true;

  const hostRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SpatialController | null>(null);
  const [status, setStatus] = useState<SpatialStatus>({ scene: 'idle' });
  const [lensOpen, setLensOpen] = useState(false);
  const [lensCount, setLensCount] = useState(0);
  const sceneShown = status.scene === 'running' || status.scene === 'still';
  const stillFallback = status.scene === 'failed' && profile.env !== 'off';

  const claimBackdrop = isSpatialDraft(storageKey) && hasWallpaper;
  useEffect(() => {
    setSpatialOwnsBackdrop(claimBackdrop);
    return () => setSpatialOwnsBackdrop(false);
  }, [claimBackdrop]);

  // Page surfaces let the scene through exactly like they let a wallpaper through (every module already honours this mark).
  const markSurfaces = (sceneShown || stillFallback) && !held && profile.env !== 'off';
  useEffect(() => {
    const root = document.documentElement;
    if (markSurfaces && !root.hasAttribute('data-wallpaper')) root.setAttribute('data-wallpaper', SPATIAL_SURFACE_MARK);
    if (!markSurfaces && root.getAttribute('data-wallpaper') === SPATIAL_SURFACE_MARK) root.removeAttribute('data-wallpaper');
    return () => {
      if (root.getAttribute('data-wallpaper') === SPATIAL_SURFACE_MARK) root.removeAttribute('data-wallpaper');
    };
  }, [markSurfaces]);

  useEffect(() => {
    const host = hostRef.current;
    const layer = layerRef.current;
    const scroller = document.querySelector<HTMLElement>('main[data-app-scroll]');
    if (!host || !layer || !scroller) return;
    const controller = createSpatialController({
      host,
      root: scroller,
      scroller,
      layer,
      preset,
      pref,
      profile,
      sceneAllowed,
      dark,
      reduced,
      shell: () => Array.from(document.querySelectorAll<HTMLElement>('[data-sp-shell]')),
      onStatus: setStatus,
    });
    controllerRef.current = controller;
    (window as unknown as { __spatial?: unknown }).__spatial = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
      (window as unknown as { __spatial?: unknown }).__spatial = undefined;
    };
    // One controller for the session; everything else arrives through update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    controllerRef.current?.update({ preset, pref, profile, sceneAllowed, dark, reduced });
  }, [preset, pref, profile, sceneAllowed, dark, reduced]);

  useEffect(() => {
    controllerRef.current?.setHeld(held);
  }, [held]);

  useEffect(() => {
    controllerRef.current?.setTyping(typing);
  }, [typing]);

  const routeKey = `${pathname}?${search.get('tab') ?? ''}|${search.get('materialId') ?? ''}`;
  const lastRoute = useRef(routeKey);
  useEffect(() => {
    if (lastRoute.current === routeKey) return;
    lastRoute.current = routeKey;
    setLensOpen(false);
    controllerRef.current?.routeChanged();
  }, [routeKey]);

  // How many real items would the gallery room have here? Read a little after the page settled, never during a frame.
  useEffect(() => {
    if (!preset.lens || !profile.lens) {
      setLensCount(0);
      return;
    }
    const read = () => setLensCount(controllerRef.current?.galleryItems().length ?? 0);
    const timer = window.setInterval(read, 1500);
    const first = window.setTimeout(read, 700);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [preset.lens, profile.lens, routeKey]);

  // Quick way out, from anywhere: Alt + Shift + X turns the whole experience off.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && (event.key === 'X' || event.key === 'x')) {
        event.preventDefault();
        setSpatialDraft(storageKey, null);
        writeSpatial(storageKey, { ...storedSpatial(storageKey), enabled: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [storageKey]);

  const draft = isSpatialDraft(storageKey);
  const thumb = spatialThumb(preset.id);

  return (
    <>
      <div className="ec-sp-stage" data-on={sceneShown || stillFallback ? 'true' : 'false'} data-testid="spatial-stage" data-scene={status.scene} aria-hidden="true">
        {stillFallback && thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="ec-sp-still" src={thumb} alt="" decoding="async" />
        )}
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      </div>
      <div ref={layerRef} className="ec-sp-layer-root" aria-hidden="true" />
      {preset.lens && profile.lens && lensCount >= 4 && !lensOpen && !held && (
        <button type="button" className="ec-sp-pill" onClick={() => setLensOpen(true)} data-testid="spatial-lens-open">
          {vi ? `Mở phòng trưng bày (${lensCount})` : `Open the gallery room (${lensCount})`}
        </button>
      )}
      {lensOpen && preset.lens && (
        <SpatialGalleryRoom
          layout={preset.lens}
          palette={preset.palette}
          items={controllerRef.current?.galleryItems() ?? []}
          pref={pref}
          dark={dark}
          reduced={reduced}
          vi={vi}
          onClose={() => setLensOpen(false)}
          onHold={(next) => controllerRef.current?.setHeld(next)}
        />
      )}
      {draft && (
        <div className="ec-sp-trybar" role="status" data-testid="spatial-trybar">
          <span>{vi ? `Đang thử: ${preset.titleVi}. Bạn có thể đi khắp các trang.` : `Trying: ${preset.titleEn}. You can move around the app.`}</span>
          <button type="button" className="ec-sp-apply" data-testid="spatial-try-apply" onClick={() => applySpatialAppearance(account, pref)}>
            {vi ? 'Giữ lại' : 'Keep it'}
          </button>
          <button type="button" className="ec-sp-undo" data-testid="spatial-try-undo" onClick={() => setSpatialDraft(storageKey, null)}>
            {vi ? 'Hoàn tác' : 'Undo'}
          </button>
        </div>
      )}
    </>
  );
}
