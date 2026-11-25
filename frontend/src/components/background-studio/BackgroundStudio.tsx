'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Bookmark,
  Check,
  LayoutGrid,
  Palette,
  RotateCcw,
  Save,
  Sliders,
  X,
} from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { accountOfKey, restoreDefaultAppearance } from '@/lib/appearance/state';
import { setBackgroundHeld } from '@/lib/wallpaper/storage';
import {
  BG_BOUNDS,
  MAX_THEME_NAME_LENGTH,
  type BackgroundColorConfig,
  type BackgroundMotionConfig,
  type BackgroundPreset,
  type BackgroundThemeConfig,
  type SavedBackgroundTheme,
} from '@/lib/background-studio/types';
import {
  cloneThemeConfig,
  extractAmbientRgb,
  generateHarmoniousTheme,
  rgbToHex,
} from '@/lib/background-studio/colorScience';
import {
  DEFAULT_BACKGROUND_PRESET_ID,
  DEFAULT_STUDIO_CONFIG,
  findBackgroundPreset,
} from '@/lib/background-studio/presets';
import {
  EMPTY_BG_STATE,
  applyCustomBackground,
  applyPresetBackground,
  currentBgState,
  deleteCustomTheme,
  duplicateCustomTheme,
  getBgSyncStatus,
  getLiveWorkspacePreview,
  hydrateBgPreferences,
  renameCustomTheme,
  saveCustomTheme,
  setLiveWorkspacePreview,
  subscribeBgState,
  subscribeBgSyncStatus,
  toggleFavoriteCustomTheme,
  toggleFavoritePreset,
  type BackgroundStudioTab,
  type BgSyncStatus,
} from '@/lib/background-studio/store';
import StudioBar, { type StudioRoom } from '@/components/wallpaper/StudioBar';
import BackgroundLivePreview from './BackgroundLivePreview';
import PresetGalleryPanel from './PresetGalleryPanel';
import ColorStudioPanel from './ColorStudioPanel';
import MotionLightPanel from './MotionLightPanel';
import MyThemesPanel from './MyThemesPanel';
import styles from './BackgroundStudio.module.css';

export interface BackgroundStudioProps {
  /** Account-scoped storage key shared across Giao diện rooms (`ec_wallpaper:v2:...`). */
  storageKey: string;
  /** Closes the studio dialog cleanly. */
  onClose: () => void;
  /** Switches to another room inside the Giao diện dialog without mutating the page. */
  onOpenRoom: (room: StudioRoom) => void;
  /** Minimizes the studio dialog into Live Workspace Preview mode over the real app. */
  onMinimizeForPreview?: () => void;
}

const IDLE_SYNC: BgSyncStatus = { state: 'idle' };

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined') return () => {};
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

function useAppDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof document === 'undefined') return () => {};
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });
      return () => observer.disconnect();
    },
    () =>
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('dark'),
    () => true,
  );
}

function ambientRgbToHex(ambientRgb: string): string {
  const parts = ambientRgb.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return '#38bdf8';
  }
  return rgbToHex({ r: parts[0], g: parts[1], b: parts[2] });
}

interface InitialStudioDraft {
  config: BackgroundThemeConfig;
  activeTab: BackgroundStudioTab;
  selectedPresetId: string | null;
  editingThemeId: string | null;
  themeNameDraft: string;
  isDefaultStart: boolean;
}

function resolveInitialDraft(account: string): InitialStudioDraft {
  // 1. Returning from Live Workspace Preview restores the exact unsaved draft snapshot
  const existingPreview = getLiveWorkspacePreview();
  if (existingPreview && existingPreview.account === account && existingPreview.draftSnapshot) {
    const snap = existingPreview.draftSnapshot;
    return {
      config: cloneThemeConfig(snap.config),
      activeTab: snap.activeTab,
      selectedPresetId: snap.selectedPresetId,
      editingThemeId: snap.editingThemeId,
      themeNameDraft: snap.themeNameDraft,
      isDefaultStart: false,
    };
  }

  // 2. Otherwise initialize from the currently active Background Studio theme
  const state = currentBgState(account);
  if (state.activeSource === 'custom' && state.activeThemeId) {
    const theme = state.customThemes.find((item) => item.id === state.activeThemeId);
    if (theme) {
      return {
        config: cloneThemeConfig(state.activeConfig ?? theme.config),
        activeTab: 'presets',
        selectedPresetId: theme.basedOnPresetId ?? null,
        editingThemeId: theme.id,
        themeNameDraft: theme.name,
        isDefaultStart: false,
      };
    }
  }

  if (state.activeSource === 'preset' && state.activeThemeId) {
    const preset = findBackgroundPreset(state.activeThemeId);
    if (preset) {
      return {
        config: cloneThemeConfig(state.activeConfig ?? preset.config),
        activeTab: 'presets',
        selectedPresetId: preset.id,
        editingThemeId: null,
        themeNameDraft: '',
        isDefaultStart: false,
      };
    }
  }

  // 3. Default Echo Ocean active -> start with Pearlescent Abyss as an inspiring preview canvas (not yet applied)
  return {
    config: cloneThemeConfig(DEFAULT_STUDIO_CONFIG),
    activeTab: 'presets',
    selectedPresetId: DEFAULT_BACKGROUND_PRESET_ID,
    editingThemeId: null,
    themeNameDraft: '',
    isDefaultStart: true,
  };
}

function buildAutoThemeName(
  selectedPreset: BackgroundPreset | undefined,
  existingCount: number,
  vi: boolean,
): string {
  const base = selectedPreset
    ? selectedPreset.name
    : vi
      ? 'Nền tùy chỉnh'
      : 'Custom Theme';
  const suffix = ` #${existingCount + 1}`;
  const trimmedBase = base.slice(0, MAX_THEME_NAME_LENGTH - suffix.length).trimEnd();
  return `${trimmedBase}${suffix}`;
}

/**
 * Echo Background Studio — gallery-grade ambient gradient, OKLCH color science,
 * GPU-composited motion and light studio inside `Giao diện -> Background`.
 */
export default function BackgroundStudio({
  storageKey,
  onClose,
  onOpenRoom,
  onMinimizeForPreview,
}: BackgroundStudioProps) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const reducedMotion = useReducedMotion();
  const appDark = useAppDark();

  const account = accountOfKey(storageKey);
  const signedIn = account.length > 0;

  // Hydrate account preferences from server once per session when signed in
  useEffect(() => {
    if (signedIn) {
      void hydrateBgPreferences(account);
    }
  }, [account, signedIn]);

  const bgState = useSyncExternalStore(
    useCallback((onChange: () => void) => subscribeBgState(account, onChange), [account]),
    useCallback(() => currentBgState(account), [account]),
    () => EMPTY_BG_STATE,
  );

  const syncStatus = useSyncExternalStore(
    subscribeBgSyncStatus,
    getBgSyncStatus,
    () => IDLE_SYNC,
  );

  // Record exact pre-edit workspace snapshot on mount for Cancel integrity
  const preEditSnapshotRef = useRef<{
    activeSource: 'none' | 'preset' | 'custom';
    activeThemeId: string | null;
    activeConfig: BackgroundThemeConfig | null;
  } | null>(null);

  if (preEditSnapshotRef.current === null) {
    const initial = currentBgState(account);
    preEditSnapshotRef.current = {
      activeSource: initial.activeSource,
      activeThemeId: initial.activeThemeId,
      activeConfig: initial.activeConfig ? cloneThemeConfig(initial.activeConfig) : null,
    };
  }

  const initialDraft = useMemo(() => resolveInitialDraft(account), [account]);

  const [draftConfig, setDraftConfig] = useState<BackgroundThemeConfig>(() => initialDraft.config);
  const [activeTab, setActiveTab] = useState<BackgroundStudioTab>(() => initialDraft.activeTab);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(
    () => initialDraft.selectedPresetId,
  );
  const [editingThemeId, setEditingThemeId] = useState<string | null>(
    () => initialDraft.editingThemeId,
  );
  const [themeNameDraft, setThemeNameDraft] = useState<string>(() => initialDraft.themeNameDraft);

  const [showMockup, setShowMockup] = useState<boolean>(true);
  const [previewDark, setPreviewDark] = useState<boolean>(() => appDark);
  const [paused, setPaused] = useState<boolean>(false);
  const [footerError, setFooterError] = useState<string | null>(null);
  const [footerNotice, setFooterNotice] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tabButtonRefs = useRef<Partial<Record<BackgroundStudioTab, HTMLButtonElement | null>>>({});

  // Hold any background video/world decoder while studio is open
  useEffect(() => {
    setBackgroundHeld(true);
    return () => setBackgroundHeld(false);
  }, []);

  // Lock page scroll and focus Close control on mount
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const selectedPreset = useMemo(
    () => (selectedPresetId ? findBackgroundPreset(selectedPresetId) : undefined),
    [selectedPresetId],
  );

  const editingTheme = useMemo(
    () =>
      editingThemeId
        ? bgState.customThemes.find((item) => item.id === editingThemeId) ?? null
        : null,
    [bgState.customThemes, editingThemeId],
  );

  // Baseline config used by Reset button and double-click slider resets
  const baselineConfig = useMemo<BackgroundThemeConfig>(() => {
    if (editingTheme) return editingTheme.config;
    if (selectedPreset) return selectedPreset.config;
    return DEFAULT_STUDIO_CONFIG;
  }, [editingTheme, selectedPreset]);

  // Live ambient accent hex driving studio room rim lighting
  const accentHex = useMemo(
    () => ambientRgbToHex(extractAmbientRgb(draftConfig)),
    [draftConfig],
  );

  const currentDisplayName = useMemo(() => {
    const trimmed = themeNameDraft.trim();
    if (editingTheme) return trimmed || editingTheme.name;
    if (trimmed) return trimmed;
    if (selectedPreset) return selectedPreset.name;
    return vi ? 'Phối màu tùy chỉnh' : 'Custom Composition';
  }, [editingTheme, selectedPreset, themeNameDraft, vi]);

  // Serialized comparison for unsaved/unapplied detection
  const draftSerialized = useMemo(() => JSON.stringify(draftConfig), [draftConfig]);

  const appliedBaselineSerialized = useMemo(() => {
    if (bgState.activeSource === 'preset' && bgState.activeThemeId) {
      const preset = findBackgroundPreset(bgState.activeThemeId);
      if (preset) {
        return JSON.stringify(bgState.activeConfig ?? preset.config);
      }
    }
    if (bgState.activeSource === 'custom' && bgState.activeThemeId) {
      const theme = bgState.customThemes.find((item) => item.id === bgState.activeThemeId);
      if (theme) {
        return JSON.stringify(bgState.activeConfig ?? theme.config);
      }
    }
    return null;
  }, [bgState]);

  const hasUnsavedChanges = useMemo(() => {
    if (bgState.activeSource === 'none') return true;
    if (editingThemeId) {
      if (bgState.activeSource !== 'custom' || bgState.activeThemeId !== editingThemeId) {
        return true;
      }
      return draftSerialized !== appliedBaselineSerialized;
    }
    if (selectedPresetId) {
      if (bgState.activeSource !== 'preset' || bgState.activeThemeId !== selectedPresetId) {
        return true;
      }
      return draftSerialized !== appliedBaselineSerialized;
    }
    return draftSerialized !== appliedBaselineSerialized;
  }, [
    appliedBaselineSerialized,
    bgState.activeSource,
    bgState.activeThemeId,
    draftSerialized,
    editingThemeId,
    selectedPresetId,
  ]);

  const canReset = useMemo(
    () => draftSerialized !== JSON.stringify(baselineConfig),
    [baselineConfig, draftSerialized],
  );

  // Cancel: discard all unsaved edits, clear live preview override, restore exact prior state, close
  const handleCancel = useCallback(() => {
    setLiveWorkspacePreview(null);
    onClose();
  }, [onClose]);

  // Switching Giao diện room clears ephemeral live preview and navigates cleanly
  const handleOpenRoom = useCallback(
    (nextRoom: StudioRoom) => {
      setLiveWorkspacePreview(null);
      onOpenRoom(nextRoom);
    },
    [onOpenRoom],
  );

  // Accessible keyboard focus trap + Escape closes cleanly
  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (event.defaultPrevented) return;
      event.stopPropagation();
      event.preventDefault();
      handleCancel();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => {
      if (el.closest('[aria-hidden="true"]')) return false;
      if (el === document.activeElement) return true;
      return (
        el.getClientRects().length > 0 &&
        window.getComputedStyle(el).visibility !== 'hidden'
      );
    });

    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const currentIndex = activeEl ? focusables.indexOf(activeEl) : -1;

    if (currentIndex === -1) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && currentIndex === 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && currentIndex === focusables.length - 1) {
      event.preventDefault();
      first.focus();
    }
  };

  // Fallback window Escape listener if focus temporarily fell outside dialogRef
  useEffect(() => {
    const handleWindowEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const activeEl = document.activeElement;
      if (dialogRef.current && activeEl && dialogRef.current.contains(activeEl)) {
        return;
      }
      event.preventDefault();
      handleCancel();
    };
    window.addEventListener('keydown', handleWindowEscape);
    return () => window.removeEventListener('keydown', handleWindowEscape);
  }, [handleCancel]);

  // WAI-ARIA APG keyboard navigation for the 4-tab Inspector (ArrowLeft / ArrowRight / Home / End)
  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tabOrder: readonly BackgroundStudioTab[],
    currentIndex: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % tabOrder.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + tabOrder.length) % tabOrder.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = tabOrder.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTabId = tabOrder[nextIndex];
    setActiveTab(nextTabId);
    tabButtonRefs.current[nextTabId]?.focus();
  };

  // Enter Live Workspace Preview over real English Coach pages underneath
  const handleEnterLiveWorkspace = useCallback(() => {
    setFooterError(null);
    setLiveWorkspacePreview({
      account,
      config: cloneThemeConfig(draftConfig),
      themeName: currentDisplayName,
      source: editingTheme ? 'custom' : 'preset',
      themeId: editingTheme?.id ?? selectedPresetId ?? DEFAULT_BACKGROUND_PRESET_ID,
      hasUnsavedChanges,
      minimizedToWorkspace: true,
      draftSnapshot: {
        config: cloneThemeConfig(draftConfig),
        activeTab,
        selectedPresetId,
        editingThemeId,
        themeNameDraft,
      },
    });
    onMinimizeForPreview?.();
  }, [
    account,
    activeTab,
    currentDisplayName,
    draftConfig,
    editingTheme,
    editingThemeId,
    hasUnsavedChanges,
    onMinimizeForPreview,
    selectedPresetId,
    themeNameDraft,
  ]);

  // Reset draft back to selected preset or saved theme defaults
  const handleReset = () => {
    setDraftConfig(cloneThemeConfig(baselineConfig));
    setFooterError(null);
    setFooterNotice(
      vi
        ? 'Đã đặt lại thông số về bản gốc của mẫu đang chọn.'
        : 'Reset controls back to the selected baseline.',
    );
  };

  // Apply immediately to the real workspace (zero page reload) and close cleanly
  const handleApply = () => {
    setFooterError(null);
    if (editingTheme) {
      const differs = JSON.stringify(draftConfig) !== JSON.stringify(editingTheme.config);
      applyCustomBackground(account, editingTheme.id, differs ? draftConfig : null);
      onClose();
      return;
    }

    if (selectedPreset) {
      const differs = JSON.stringify(draftConfig) !== JSON.stringify(selectedPreset.config);
      applyPresetBackground(account, selectedPreset.id, differs ? draftConfig : null);
      onClose();
      return;
    }

    // Randomized or freeform composition without a preset ID: apply directly via Pearlescent Abyss base with override
    applyPresetBackground(account, DEFAULT_BACKGROUND_PRESET_ID, draftConfig);
    onClose();
  };

  // Save current creation to My Themes and activate immediately
  const saveCurrentCreation = useCallback(
    (opts: { asNew: boolean; allowAutoName?: boolean }): string | null => {
      setFooterError(null);
      const rawName = themeNameDraft.trim();
      const targetEdit = !opts.asNew ? editingTheme : null;
      const resolvedName =
        rawName ||
        (targetEdit
          ? targetEdit.name
          : opts.allowAutoName
            ? buildAutoThemeName(selectedPreset, bgState.customThemes.length, vi)
            : '');

      const result = saveCustomTheme(account, {
        id: targetEdit ? targetEdit.id : undefined,
        name: resolvedName,
        config: draftConfig,
        basedOnPresetId: selectedPresetId,
        favorite: targetEdit?.favorite,
        activate: true,
      });

      if (!result.ok) {
        setFooterError(result.message);
        return result.message;
      }

      setEditingThemeId(result.theme.id);
      setThemeNameDraft(result.theme.name);
      setFooterNotice(
        signedIn
          ? vi
            ? `Đã lưu "${result.theme.name}" và đồng bộ tài khoản.`
            : `Saved "${result.theme.name}" and synced to your account.`
          : vi
            ? `Đã lưu "${result.theme.name}" trên thiết bị này — đăng nhập để đồng bộ.`
            : `Saved "${result.theme.name}" on this device — sign in to sync.`,
      );
      return null;
    },
    [
      account,
      bgState.customThemes.length,
      draftConfig,
      editingTheme,
      selectedPreset,
      selectedPresetId,
      signedIn,
      themeNameDraft,
      vi,
    ],
  );

  // Handlers for Preset Gallery
  const handleSelectPreset = (preset: BackgroundPreset) => {
    setDraftConfig(cloneThemeConfig(preset.config));
    setSelectedPresetId(preset.id);
    setEditingThemeId(null);
    setFooterError(null);
    setFooterNotice(null);
  };

  const handleRestoreDefault = () => {
    setLiveWorkspacePreview(null);
    restoreDefaultAppearance(account);
    setFooterError(null);
    setFooterNotice(
      vi
        ? 'Đã khôi phục nền mặc định English Coach (Echo Ocean).'
        : 'Restored default English Coach (Echo Ocean) background.',
    );
  };

  // Handlers for Color Studio & Motion Light
  const handleChangeColor = (nextColor: BackgroundColorConfig) => {
    setDraftConfig((prev) => ({ ...prev, color: nextColor }));
    setFooterError(null);
  };

  const handleChangeGrainOpacity = (nextGrain: number) => {
    setDraftConfig((prev) => ({ ...prev, grainOpacity: nextGrain }));
  };

  const handleChangeMotion = (nextMotion: BackgroundMotionConfig) => {
    setDraftConfig((prev) => ({ ...prev, motion: nextMotion }));
    setFooterError(null);
  };

  const handleToggleLowPower = () => {
    setDraftConfig((prev) => ({
      ...prev,
      motion: {
        ...prev.motion,
        performanceMode: prev.motion.performanceMode === 'eco' ? 'auto' : 'eco',
      },
    }));
  };

  // Handlers for My Themes
  const handleRandomize = () => {
    const generated = generateHarmoniousTheme();
    setDraftConfig(generated);
    setSelectedPresetId(null);
    setEditingThemeId(null);
    setThemeNameDraft('');
    setFooterError(null);
    setFooterNotice(
      vi
        ? 'Đã tạo phối màu OKLCH hài hòa mới trong bản xem trước.'
        : 'Generated a new harmonious OKLCH composition in Live Preview.',
    );
  };

  const handlePreviewTheme = (theme: SavedBackgroundTheme) => {
    setDraftConfig(cloneThemeConfig(theme.config));
    setEditingThemeId(theme.id);
    setSelectedPresetId(theme.basedOnPresetId ?? null);
    setThemeNameDraft(theme.name);
    setFooterError(null);
    setFooterNotice(null);
  };

  const handleSelectAndApplyTheme = (theme: SavedBackgroundTheme) => {
    setDraftConfig(cloneThemeConfig(theme.config));
    setEditingThemeId(theme.id);
    setSelectedPresetId(theme.basedOnPresetId ?? null);
    setThemeNameDraft(theme.name);
    applyCustomBackground(account, theme.id, null);
    setFooterError(null);
    setFooterNotice(
      vi
        ? `Đang áp dụng "${theme.name}" trên không gian làm việc.`
        : `Applied "${theme.name}" to your workspace.`,
    );
  };

  const handleEditTheme = (theme: SavedBackgroundTheme) => {
    setDraftConfig(cloneThemeConfig(theme.config));
    setEditingThemeId(theme.id);
    setSelectedPresetId(theme.basedOnPresetId ?? null);
    setThemeNameDraft(theme.name);
    setActiveTab('color');
    setFooterError(null);
    setFooterNotice(null);
  };

  const handleRenameTheme = (themeId: string, nextName: string): string | null => {
    const result = renameCustomTheme(account, themeId, nextName);
    if (!result.ok) return result.message;
    if (editingThemeId === themeId) {
      setThemeNameDraft(result.theme.name);
    }
    return null;
  };

  const handleDuplicateTheme = (themeId: string): string | null => {
    const result = duplicateCustomTheme(account, themeId);
    if (!result.ok) return result.message;
    setFooterNotice(
      vi ? `Đã nhân bản thành "${result.theme.name}".` : `Duplicated as "${result.theme.name}".`,
    );
    return null;
  };

  const handleDeleteTheme = (themeId: string) => {
    deleteCustomTheme(account, themeId);
    if (editingThemeId === themeId) {
      setEditingThemeId(null);
    }
  };

  const tabs: Array<{
    id: BackgroundStudioTab;
    label: string;
    icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
    badge?: number;
  }> = [
    {
      id: 'presets',
      label: vi ? 'Preset' : 'Presets',
      icon: LayoutGrid,
    },
    {
      id: 'color',
      label: vi ? 'Màu sắc' : 'Color',
      icon: Palette,
    },
    {
      id: 'motion',
      label: vi ? 'Chuyển động' : 'Motion',
      icon: Sliders,
    },
    {
      id: 'themes',
      label: vi ? 'Theme của tôi' : 'My Themes',
      icon: Bookmark,
      badge: bgState.customThemes.length > 0 ? bgState.customThemes.length : undefined,
    },
  ];

  const activeTabMeta: Record<BackgroundStudioTab, { title: string; subtitle: string }> = {
    presets: {
      title: vi ? 'Bộ sưu tập Preset' : 'Preset Gallery',
      subtitle: vi
        ? '10 không gian ánh sáng OKLCH thủ công và khôi phục nền mặc định Echo Ocean.'
        : '10 handcrafted OKLCH atmospheric presets plus one-click Echo Ocean default restore.',
    },
    color: {
      title: vi ? 'Phòng màu sắc' : 'Color Studio',
      subtitle: vi
        ? 'Tùy biến 2 đến 8 điểm màu HEX, RGB, HSL, OKLCH, tâm điểm 2D và 10 thông số quang học.'
        : 'Craft 2 to 8 HEX, RGB, HSL or OKLCH stops, 2D focal geometry and 10 optical controls.',
    },
    motion: {
      title: vi ? 'Chuyển động và Ánh sáng' : 'Motion and Light',
      subtitle: vi
        ? 'Kết hợp 9 hiệu ứng GPU siêu mượt, 8 thông số động lực học và chế độ tiết kiệm Eco.'
        : 'Compose 9 GPU-composited effects, 8 motion dynamics controls and Eco GPU budgeting.',
    },
    themes: {
      title: vi ? 'Theme của tôi' : 'My Themes',
      subtitle: vi
        ? 'Lưu tối đa 40 phối màu cá nhân, tạo ngẫu nhiên hài hòa và đồng bộ tài khoản.'
        : 'Save up to 40 custom themes, generate harmonious palettes and sync with your account.',
    },
  };

  const footerStatusText = (() => {
    if (footerNotice) return footerNotice;
    if (syncStatus.state === 'saving') {
      return vi ? 'Đang đồng bộ lên tài khoản...' : 'Syncing to your account...';
    }
    if (syncStatus.state === 'error' && syncStatus.message) {
      return syncStatus.message;
    }
    if (bgState.activeSource === 'none') {
      return vi
        ? 'Đang xem trước (chưa áp dụng) — nhấn Áp dụng để bật trên toàn bộ không gian học.'
        : 'Previewing (not yet applied) — click Apply to activate across your workspace.';
    }
    if (hasUnsavedChanges) {
      return vi
        ? 'Bản xem trước cập nhật tức thì — nhấn Áp dụng hoặc Lưu để giữ thay đổi.'
        : 'Live preview updates instantly — click Apply or Save to keep your edits.';
    }
    return signedIn
      ? vi
        ? 'Đã đồng bộ tài khoản — thay đổi sẽ giữ nguyên trên mọi thiết bị.'
        : 'Synced to your account across devices.'
      : vi
        ? 'Đã lưu trên thiết bị này — đăng nhập để đồng bộ tài khoản.'
        : 'Saved on this device — sign in to sync across devices.';
  })();

  const tabOrder = tabs.map((tab) => tab.id);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bg-studio-title"
      className={styles.studio}
      style={{ '--accent': accentHex } as React.CSSProperties}
      onKeyDown={handleDialogKeyDown}
      data-testid="background-studio"
    >
      <StudioBar
        room="background"
        onRoom={handleOpenRoom}
        storageKey={storageKey}
        vi={vi}
        closeRef={closeRef}
        onClose={handleCancel}
      />

      <div className={styles.workspace}>
        {/* Left Stage Column: Live Preview */}
        <section
          className={styles.stageColumn}
          aria-label={vi ? 'Sân khấu xem trước trực tiếp' : 'Live background preview stage'}
        >
          <BackgroundLivePreview
            config={draftConfig}
            themeName={currentDisplayName}
            hasUnsavedChanges={hasUnsavedChanges}
            showMockup={showMockup}
            onToggleMockup={() => setShowMockup((prev) => !prev)}
            previewDark={previewDark}
            onTogglePreviewDark={() => setPreviewDark((prev) => !prev)}
            paused={paused}
            onTogglePaused={() => setPaused((prev) => !prev)}
            lowPower={draftConfig.motion.performanceMode === 'eco'}
            onToggleLowPower={handleToggleLowPower}
            reducedMotion={reducedMotion}
            onEnterLiveWorkspace={onMinimizeForPreview ? handleEnterLiveWorkspace : undefined}
            vi={vi}
          />
        </section>

        {/* Right Inspector Column: 4-Tab Header + Scrollable Panel */}
        <aside
          className={styles.inspectorColumn}
          aria-label={vi ? 'Bảng tùy chỉnh Echo Background Studio' : 'Echo Background Studio inspector'}
        >
          <div className={styles.inspectorHeader}>
            <div className={styles.inspectorHeadingRow}>
              <div>
                <p className={styles.inspectorEyebrow}>Echo Background Studio</p>
                <h2 id="bg-studio-title" className={styles.inspectorTitle}>
                  {activeTabMeta[activeTab].title}
                </h2>
                <p className={styles.inspectorSubtitle}>{activeTabMeta[activeTab].subtitle}</p>
              </div>
            </div>

            <div
              className={styles.tabBar}
              role="tablist"
              aria-label={vi ? 'Danh mục tùy chỉnh nền' : 'Background studio sections'}
            >
              {tabs.map((tab, idx) => {
                const Icon = tab.icon;
                const selected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    ref={(node) => {
                      tabButtonRefs.current[tab.id] = node;
                    }}
                    type="button"
                    role="tab"
                    id={`bg-tab-${tab.id}`}
                    tabIndex={selected ? 0 : -1}
                    aria-selected={selected}
                    aria-controls={`bg-tabpanel-${tab.id}`}
                    className={`${styles.tabBtn} ${selected ? styles.tabBtnActive : ''}`}
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, tabOrder, idx)}
                    data-testid={`bg-studio-tab-${tab.id}`}
                  >
                    <Icon size={14} aria-hidden={true} />
                    <span className={styles.tabLabel}>{tab.label}</span>
                    {tab.badge !== undefined && (
                      <span className={styles.tabBadge}>{tab.badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div
            className={styles.inspectorBody}
            role="tabpanel"
            id={`bg-tabpanel-${activeTab}`}
            aria-labelledby={`bg-tab-${activeTab}`}
          >
            {activeTab === 'presets' && (
              <PresetGalleryPanel
                selectedPresetId={selectedPresetId}
                appliedSource={bgState.activeSource}
                appliedThemeId={bgState.activeThemeId}
                favoritePresetIds={bgState.favoritePresetIds}
                onSelectPreset={handleSelectPreset}
                onToggleFavorite={(presetId) => toggleFavoritePreset(account, presetId)}
                onRestoreDefault={handleRestoreDefault}
                vi={vi}
              />
            )}

            {activeTab === 'color' && (
              <ColorStudioPanel
                color={draftConfig.color}
                grainOpacity={draftConfig.grainOpacity ?? BG_BOUNDS.grainOpacity.default}
                defaultColor={baselineConfig.color}
                defaultGrainOpacity={baselineConfig.grainOpacity ?? BG_BOUNDS.grainOpacity.default}
                onChangeColor={handleChangeColor}
                onChangeGrainOpacity={handleChangeGrainOpacity}
                vi={vi}
              />
            )}

            {activeTab === 'motion' && (
              <MotionLightPanel
                motion={draftConfig.motion}
                defaultMotion={baselineConfig.motion}
                reducedMotion={reducedMotion}
                onChangeMotion={handleChangeMotion}
                vi={vi}
              />
            )}

            {activeTab === 'themes' && (
              <MyThemesPanel
                customThemes={bgState.customThemes}
                activeSource={bgState.activeSource}
                activeThemeId={bgState.activeThemeId}
                editingThemeId={editingThemeId}
                themeNameDraft={themeNameDraft}
                signedIn={signedIn}
                syncStatus={syncStatus}
                onChangeThemeNameDraft={setThemeNameDraft}
                onRandomize={handleRandomize}
                onRestoreDefault={handleRestoreDefault}
                onSaveCurrent={({ asNew }) => saveCurrentCreation({ asNew, allowAutoName: false })}
                onPreviewTheme={handlePreviewTheme}
                onSelectAndApplyTheme={handleSelectAndApplyTheme}
                onEditTheme={handleEditTheme}
                onRenameTheme={handleRenameTheme}
                onDuplicateTheme={handleDuplicateTheme}
                onDeleteTheme={handleDeleteTheme}
                onToggleFavoriteTheme={(themeId) => toggleFavoriteCustomTheme(account, themeId)}
                vi={vi}
              />
            )}
          </div>
        </aside>

        {/* Grounded Sticky Action Footer (Left Column Bottom on desktop; viewport-pinned bottom bar on mobile/tablet) */}
        <footer className={styles.stageFooter} data-testid="bg-studio-footer">
          <div className={styles.stageFooterMeta}>
            {hasUnsavedChanges && (
              <span className={styles.unsavedBadge} data-testid="bg-studio-unsaved-badge">
                {bgState.activeSource === 'none'
                  ? vi
                    ? 'Chưa áp dụng'
                    : 'Not applied'
                  : vi
                    ? 'Chưa lưu'
                    : 'Unsaved'}
              </span>
            )}
            {footerError ? (
              <p className={styles.stageFooterError} role="alert" data-testid="bg-studio-error">
                {footerError}
              </p>
            ) : (
              <p className={styles.stageFooterNote} role="status" aria-live="polite">
                {footerStatusText}
              </p>
            )}
          </div>

          <div className={styles.stageFooterActions}>
            <button
              type="button"
              className={styles.btnGhost}
              onClick={handleReset}
              disabled={!canReset}
              data-testid="bg-studio-reset-btn"
            >
              <RotateCcw size={14} aria-hidden="true" />
              <span>{vi ? 'Đặt lại' : 'Reset'}</span>
            </button>

            <button
              type="button"
              className={styles.btnSecondary}
              onClick={handleCancel}
              data-testid="bg-studio-cancel-btn"
            >
              <X size={14} aria-hidden="true" />
              <span>{vi ? 'Hủy' : 'Cancel'}</span>
            </button>

            <button
              type="button"
              className={styles.btnAccent}
              onClick={() => {
                saveCurrentCreation({ asNew: !editingTheme, allowAutoName: true });
              }}
              data-testid="bg-studio-save-btn"
            >
              <Save size={14} aria-hidden="true" />
              <span>{vi ? 'Lưu' : 'Save'}</span>
            </button>

            <button
              type="button"
              className={styles.btnPrimary}
              onClick={handleApply}
              data-testid="bg-studio-apply-btn"
            >
              <Check size={14} aria-hidden="true" />
              <span>{vi ? 'Áp dụng' : 'Apply'}</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
