'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigationOverlay } from '@/lib/navigation/useAutoHideSurface';
import dynamic from 'next/dynamic';
import { useSession } from 'next-auth/react';
import { useLanguage } from '@/context/LanguageContext';
import { OPEN_STUDIO_EVENT, accountKey, setBackgroundHeld } from '@/lib/wallpaper/storage';
import { extractAmbientRgb, rgbToHex } from '@/lib/background-studio/colorScience';
import { DEFAULT_BACKGROUND_PRESET_ID, findBackgroundPreset, isBackgroundPresetId } from '@/lib/background-studio/presets';
import {
  applyCustomBackground,
  applyPresetBackground,
  currentBgState,
  getBgSyncStatus,
  getLiveWorkspacePreview,
  saveCustomTheme,
  setLiveWorkspacePreview,
  subscribeBgSyncStatus,
  subscribeLiveWorkspacePreview,
  type BgSyncStatus,
} from '@/lib/background-studio/store';
import type { StudioRoom } from './StudioBar';

const IDLE_SYNC_STATUS: BgSyncStatus = { state: 'idle' };
const getIdleSyncStatus = () => IDLE_SYNC_STATUS;
const getNullPreview = () => null;

/** The studio's code (and its poster grid) loads only when the learner opens it from the sidebar. */
const WallpaperStudio = dynamic(() => import('./WallpaperStudio'), {
  ssr: false,
  loading: () => <div className="fixed inset-0 z-[120] bg-[rgb(3_7_18/0.72)]" aria-hidden="true" />,
});

const BackgroundLivePreviewBar = dynamic(
  () => import('@/components/background-studio/BackgroundLivePreviewBar'),
  { ssr: false },
);

function ambientRgbToHex(rgbText: string): string | undefined {
  const parts = rgbText.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return rgbToHex({ r: parts[0], g: parts[1], b: parts[2] });
}

export default function WallpaperStudioHost() {
  const [open, setOpen] = useState(false);
  useNavigationOverlay(open);
  const [initialRoom, setInitialRoom] = useState<StudioRoom | undefined>(undefined);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const previousOverflowRef = useRef<string>('');
  const { data: session } = useSession();
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const userId = session?.user ? String((session.user as { id?: string | number }).id ?? '') : '';
  const livePreview = useSyncExternalStore(
    subscribeLiveWorkspacePreview,
    getLiveWorkspacePreview,
    getNullPreview,
  );
  const syncStatus = useSyncExternalStore(
    subscribeBgSyncStatus,
    getBgSyncStatus,
    getIdleSyncStatus,
  );

  // Guarantees page scroll and background hold are cleanly restored after any room unmount or live-preview minimize.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      document.body.style.overflow = previousOverflowRef.current;
      setBackgroundHeld(false);
    }
  }, [open]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const requested = (event as CustomEvent<{ room?: StudioRoom }>).detail?.room;
      const activePreview = getLiveWorkspacePreview();
      if (activePreview && activePreview.minimizedToWorkspace) {
        if (!requested || requested === 'background') {
          setLiveWorkspacePreview({ ...activePreview, minimizedToWorkspace: false });
        }
      }
      setInitialRoom(
        requested === 'media' || requested === 'background' || requested === 'worlds' || requested === 'spatial' || requested === 'navigation'
          ? requested
          : activePreview?.minimizedToWorkspace
            ? 'background'
            : undefined,
      );
      if (!wasOpenRef.current) {
        previousOverflowRef.current = document.body.style.overflow;
      }
      setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setOpen(true);
    };
    window.addEventListener(OPEN_STUDIO_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_STUDIO_EVENT, onOpen);
  }, []);

  const handleMinimizeForPreview = useCallback(() => {
    setOpen(false);
  }, []);

  const activeLiveBar =
    !open &&
    livePreview !== null &&
    livePreview.minimizedToWorkspace &&
    livePreview.account === userId.replace(/[^\w-]/g, '')
      ? livePreview
      : null;

  const handleReturnToStudio = useCallback(() => {
    const current = getLiveWorkspacePreview();
    if (current) {
      setLiveWorkspacePreview({ ...current, minimizedToWorkspace: false });
    }
    if (!wasOpenRef.current) {
      previousOverflowRef.current = document.body.style.overflow;
    }
    setInitialRoom('background');
    setOpen(true);
  }, []);

  const handleApplyLivePreview = useCallback(() => {
    const current = getLiveWorkspacePreview();
    if (!current) return;
    const state = currentBgState(userId);
    if (current.source === 'custom' && state.customThemes.some((item) => item.id === current.themeId)) {
      applyCustomBackground(userId, current.themeId, current.config);
    } else if (current.source === 'preset' && isBackgroundPresetId(current.themeId)) {
      applyPresetBackground(userId, current.themeId, current.config);
    } else {
      const saved = saveCustomTheme(userId, {
        name: current.draftSnapshot?.themeNameDraft?.trim() || current.themeName || 'Custom Background',
        config: current.config,
        basedOnPresetId: current.draftSnapshot?.selectedPresetId ?? null,
        activate: true,
      });
      if (!saved.ok) {
        applyPresetBackground(userId, DEFAULT_BACKGROUND_PRESET_ID, current.config);
      }
    }
    setLiveWorkspacePreview(null);
  }, [userId]);

  const handleSaveLivePreview = useCallback(() => {
    const current = getLiveWorkspacePreview();
    if (!current) return;
    const state = currentBgState(userId);
    const existingId =
      current.source === 'custom' && state.customThemes.some((item) => item.id === current.themeId)
        ? current.themeId
        : undefined;
    const fallbackName = vi ? 'Nền tùy chỉnh' : 'Custom Background';
    const candidateName =
      current.draftSnapshot?.themeNameDraft?.trim() || current.themeName.trim() || fallbackName;
    const result = saveCustomTheme(userId, {
      id: existingId,
      name: candidateName,
      config: current.config,
      basedOnPresetId:
        current.draftSnapshot?.selectedPresetId ??
        (current.source === 'preset' && isBackgroundPresetId(current.themeId) ? current.themeId : null),
      activate: true,
    });
    if (result.ok) {
      setLiveWorkspacePreview(null);
    } else {
      handleReturnToStudio();
    }
  }, [userId, vi, handleReturnToStudio]);

  const handleCancelLivePreview = useCallback(() => {
    setLiveWorkspacePreview(null);
  }, []);

  if (!open) {
    if (!activeLiveBar) return null;
    const accentHex =
      (activeLiveBar.source === 'preset' ? findBackgroundPreset(activeLiveBar.themeId)?.accentHex : undefined) ??
      ambientRgbToHex(extractAmbientRgb(activeLiveBar.config));
    return (
      <BackgroundLivePreviewBar
        themeName={activeLiveBar.themeName}
        hasUnsavedChanges={activeLiveBar.hasUnsavedChanges}
        accentHex={accentHex}
        saving={syncStatus.state === 'saving'}
        vi={vi}
        onReturnToStudio={handleReturnToStudio}
        onApply={handleApplyLivePreview}
        onSave={handleSaveLivePreview}
        onCancel={handleCancelLivePreview}
      />
    );
  }
  // Keyed by account: if the session changes while the studio is open, it remounts with that account's data only.
  return (
    <WallpaperStudio
      key={accountKey(userId)}
      storageKey={accountKey(userId)}
      initialRoom={initialRoom}
      onMinimizeForPreview={handleMinimizeForPreview}
      onClose={() => {
        setOpen(false);
        setInitialRoom(undefined);
        // Focus goes back to the sidebar entry that opened the studio.
        window.requestAnimationFrame(() => opener?.focus?.());
      }}
    />
  );
}
