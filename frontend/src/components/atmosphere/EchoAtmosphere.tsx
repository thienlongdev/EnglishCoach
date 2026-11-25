'use client';

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { currentAppearance } from '@/lib/appearance/state';
import { accountKey, subscribePreference } from '@/lib/wallpaper/storage';
import { spatialKey, subscribeSpatial } from '@/lib/spatial/preference';
import { subscribeBgState, subscribeLiveWorkspacePreview } from '@/lib/background-studio/store';
import { quietnessOf, useTypingQuiet } from '@/lib/wallpaper/worlds/orchestrate';
import { vfxPreference, subscribeVfx } from '@/lib/vfx/quality';
import { wallpaperRestsOn } from '@/components/wallpaper/WallpaperStage';
import styles from './EchoAtmosphere.module.css';
import { ATMOSPHERE_ART } from './atmosphereArt';

/**
 * Echo Ocean — the workspace's default look ("Pearl × Abyss", owner brief 2026-11-14). It is the frame's own background, not a
 * background engine: a pre-painted plate per theme (CSS, on the first paint, no request but one small image), and — only while
 * it really is what the learner sees — two slow light layers (caustics drifting at the top, light shafts breathing) on the
 * compositor. Whatever the learner chose in Giao diện (a wallpaper, a Living World, a 3D preset, one being tried) is the one
 * appearance (lib/appearance/state.ts): it covers this plate and the light layers unmount. Nothing here reads learner data,
 * calls the server or runs a render loop; `aria-hidden`, `pointer-events: none`, never above the content (z 0, before the stage).
 *
 * Motion follows the screen: free on the dashboard and galleries, slower on library screens, still on lesson screens, while
 * typing, under reduced motion, with Save-Data, with the device's "Nhẹ" effects choice, in a hidden tab (the browser stops it).
 */

const url = (path: string) => `url("${path}")`;
/** The published file names, as the custom properties the stylesheet reads (atmosphereArt.ts is the one source). */
const ART_VARS = {
  '--eo-plate-pearl': url(ATMOSPHERE_ART.pearl),
  '--eo-plate-pearl-s': url(ATMOSPHERE_ART.pearl_s),
  '--eo-plate-abyss': url(ATMOSPHERE_ART.abyss),
  '--eo-plate-abyss-s': url(ATMOSPHERE_ART.abyss_s),
  '--eo-grain': url(ATMOSPHERE_ART.grain),
  '--eo-caustic-pearl': url(ATMOSPHERE_ART.caustic_pearl),
  '--eo-caustic-abyss': url(ATMOSPHERE_ART.caustic_abyss),
  '--eo-shafts-pearl': url(ATMOSPHERE_ART.shafts_pearl),
  '--eo-shafts-abyss': url(ATMOSPHERE_ART.shafts_abyss),
} as React.CSSProperties;

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

function saveData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!connection?.saveData;
}

export default function EchoAtmosphere() {
  const { data: session } = useSession();
  const account = session?.user ? String((session.user as { id?: string | number }).id ?? '') : '';
  const pathname = usePathname() || '';
  const tab = useSearchParams().get('tab');

  // The one appearance decides whether this is what is on screen (re-read whenever any stored choice or preview changes).
  const subscribe = useCallback(
    (onChange: () => void) => {
      const offWallpaper = subscribePreference(accountKey(account), onChange);
      const offSpatial = subscribeSpatial(spatialKey(account), onChange);
      const offBg = subscribeBgState(account, onChange);
      const offBgPreview = subscribeLiveWorkspacePreview(onChange);
      return () => {
        offWallpaper();
        offSpatial();
        offBg();
        offBgPreview();
      };
    },
    [account],
  );
  const mode = useSyncExternalStore(subscribe, () => currentAppearance(account).mode, () => 'default' as const);
  const effects = useSyncExternalStore(subscribeVfx, vfxPreference, () => 'auto' as const);
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const typing = useTypingQuiet();
  const resting = wallpaperRestsOn(pathname);
  const shown = mode === 'default' && !resting;

  // How quiet the light should be on this screen: the same scale the Living Worlds use (0 = roam, 1 = deep focus).
  const quiet = Math.max(quietnessOf(pathname, tab), typing ? 0.9 : 0);
  // The light layers exist only after hydration, from the client's own facts: never in the server markup, so a visitor who will
  // not see them (reduced motion, "Nhẹ", Save-Data) never downloads their textures either.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const live = mounted && shown && !reduced && effects !== 'low' && !saveData();
  // Moving light only where the learner roams (dashboard, galleries, profile, progress, path, community: quiet < 0.5). Library and
  // lesson screens and typing fade it out: at opacity 0 the compositor skips the layers entirely, so they cost nothing there.
  const still = !live || quiet >= 0.5;

  // Observability and the lighting contract: `data-atmosphere` exists only while the plate is what the learner sees.
  useEffect(() => {
    const root = document.documentElement;
    if (shown) root.setAttribute('data-atmosphere', root.classList.contains('dark') ? 'abyss' : 'pearl');
    else root.removeAttribute('data-atmosphere');
    if (!shown) return;
    const observer = new MutationObserver(() => root.setAttribute('data-atmosphere', root.classList.contains('dark') ? 'abyss' : 'pearl'));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      root.removeAttribute('data-atmosphere');
    };
  }, [shown]);

  return (
    <div className={styles.atmosphere} style={ART_VARS} aria-hidden="true" data-testid="echo-atmosphere" data-shown={shown ? '' : undefined}>
      <div className={styles.plate} />
      {live && (
        <div className={styles.light} data-still={still ? '' : undefined} style={{ '--eo-calm': quiet.toFixed(2) } as React.CSSProperties}>
          <i className={styles.shafts} />
          <i className={styles.caustics} />
        </div>
      )}
    </div>
  );
}
