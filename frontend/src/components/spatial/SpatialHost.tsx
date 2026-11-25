'use client';

import React, { useCallback, useEffect, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { useSession } from 'next-auth/react';
import { reconcileAppearance } from '@/lib/appearance/state';
import { DEFAULT_SPATIAL, currentSpatial, isSpatialDraft, spatialKey, subscribeSpatial } from '@/lib/spatial/preference';
import { accountKey, currentPreference, subscribePreference } from '@/lib/wallpaper/storage';
import { resolveActiveBgConfig, subscribeBgState, subscribeLiveWorkspacePreview } from '@/lib/background-studio/store';

/**
 * The only part of Echo Spatial in the main bundle: it reads local preferences. Off (the default), or while a wallpaper, a Living World or a Background Studio theme is the active appearance, this renders nothing: no graphics
 * code, stylesheet, listener or context exists on the page. Mounted once in the workspace branch of ApplicationFrame, so it survives every route inside the workspace.
 */
const SpatialRuntimeView = dynamic(() => import('./SpatialRuntimeView'), { ssr: false });

export default function SpatialHost() {
  const { data: session } = useSession();
  const userId = session?.user ? String((session.user as { id?: string | number }).id ?? '') : '';
  const key = spatialKey(userId);
  const wallpaperKey = accountKey(userId);
  useEffect(() => {
    reconcileAppearance(userId);
  }, [userId]);
  const pref = useSyncExternalStore(
    (onChange) => subscribeSpatial(key, onChange),
    () => currentSpatial(key),
    () => DEFAULT_SPATIAL,
  );
  const mediaWallpaperOn = useSyncExternalStore(
    (onChange) => subscribePreference(wallpaperKey, onChange),
    () => currentPreference(wallpaperKey).source !== 'none',
    () => false,
  );
  const subscribeBg = useCallback(
    (onChange: () => void) => {
      const offBg = subscribeBgState(userId, onChange);
      const offPreview = subscribeLiveWorkspacePreview(onChange);
      return () => {
        offBg();
        offPreview();
      };
    },
    [userId],
  );
  const bgThemeOn = useSyncExternalStore(
    subscribeBg,
    () => resolveActiveBgConfig(userId) !== null,
    () => false,
  );
  const wallpaperOn = mediaWallpaperOn || bgThemeOn;
  // One active appearance: a wallpaper, world or background studio theme outranks a stored preset; only a preset being tried rests it for a moment.
  if (!pref.enabled || (wallpaperOn && !isSpatialDraft(key))) return null;
  return <SpatialRuntimeView storageKey={key} pref={pref} />;
}
