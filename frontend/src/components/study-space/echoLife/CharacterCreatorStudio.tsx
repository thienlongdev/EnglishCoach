'use client';
/**
 * Echo Life Wave 11 — AAA inZOI-Class Character Creator Studio (CAZ).
 * Transparent 360-degree turntable center stage, top floating camera/lighting/preview bar,
 * left 7-tab category rail, and right 360px sculpting and styling inspector.
 * 100% clean English copy, pure multi-stop Pearl Opal glass over WebGL, zero V3 edits.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Heart,
  Layers,
  Moon,
  RotateCcw,
  Scissors,
  Shirt,
  Shuffle,
  Smile,
  Snowflake,
  Star,
  Sun,
  Sunrise,
  Undo2,
  Redo2,
  User,
  X,
} from 'lucide-react';
import {
  ACCESSORY_CATALOG,
  BODY_PRESETS,
  BODY_SLIDER_DEFS,
  CHARACTER_PRESETS,
  DESIRED_LIFE_CATALOG,
  FABRIC_CATALOG,
  FACE_MORPH_DEFS,
  FACE_MORPH_TABS,
  FACIAL_HAIR_STYLES,
  HAIR_CATALOG,
  HAIR_COLOR_PRESETS,
  IRIS_COLOR_PRESETS,
  OUTFIT_SLOTS,
  OUTERWEAR_CATALOG,
  PATTERN_CATALOG,
  PREFERENCES_CATALOG,
  SIGNATURE,
  SKIN_TONE_PRESETS,
  TRAIT_CATALOG,
  VALUES_CATALOG,
  createDefaultCreatorProfile,
  createHistory,
  defaultFaceSculptWeights,
  getGarmentCatalogForHero,
  pushHistory,
  randomizeProfile,
  redoHistory,
  sanitizeCreatorProfile,
  sanitizeOutfitSlot,
  switchCreatorHero,
  undoHistory,
  type AccessoryId,
  type CharacterCreatorProfile,
  type CreatorHistoryStack,
  type FabricId,
  type FaceMorphTab,
  type Hero,
  type OutfitSlotId,
  type OuterwearId,
  type PatternId,
} from '@/lib/avatar/characterCreator';
import { COLOR_SWATCHES } from '@/lib/avatar/look';
import {
  CLOTHING_SKU_MAPPINGS,
  isGarmentUnlocked,
  resolveUnlockedWardrobe,
  type UnlockedWardrobeSet,
  type UnlockedWardrobeSources,
} from '@/lib/echo-life/game/wardrobeBridge';
import s from './characterCreator.module.css';

export type CreatorCameraPreset = 'full_body' | 'upper' | 'face' | 'shoes';
export type CreatorLightPreset = 'studio' | 'daylight' | 'golden' | 'night';
export type CreatorExpressionPreview = 'neutral' | 'smile' | 'talk' | 'walk';

export type CreatorCategoryTab =
  | 'presets'
  | 'face'
  | 'body'
  | 'hair'
  | 'wardrobe'
  | 'outfits'
  | 'identity';

export type WardrobeSubTab = 'outerwear' | 'top' | 'bottom' | 'shoes' | 'accessory';

export interface CharacterCreatorStudioProps {
  open: boolean;
  initialProfile: CharacterCreatorProfile;
  unlockedGarments?: UnlockedWardrobeSet | UnlockedWardrobeSources | null;
  onPreviewChange: (profile: CharacterCreatorProfile) => void;
  onCameraPreset?: (preset: CreatorCameraPreset) => void;
  onLightPreset?: (preset: CreatorLightPreset) => void;
  onExpressionChange?: (expression: CreatorExpressionPreview) => void;
  onSnowPreviewChange?: (snowEnabled: boolean) => void;
  onOrbitYaw?: (deltaRad: number) => void;
  onSave: (profile: CharacterCreatorProfile) => void;
  onClose: () => void;
}

const CAMERA_PRESETS: readonly { id: CreatorCameraPreset; label: string }[] = [
  { id: 'full_body', label: 'Full Body' },
  { id: 'upper', label: 'Upper' },
  { id: 'face', label: 'Face' },
  { id: 'shoes', label: 'Shoes' },
];

const LIGHT_PRESETS: readonly { id: CreatorLightPreset; label: string; Icon: typeof Sun }[] = [
  { id: 'studio', label: 'Studio', Icon: Camera },
  { id: 'daylight', label: 'Daylight', Icon: Sun },
  { id: 'golden', label: 'Golden', Icon: Sunrise },
  { id: 'night', label: 'Night', Icon: Moon },
];

const EXPRESSION_PREVIEWS: readonly { id: CreatorExpressionPreview; label: string }[] = [
  { id: 'neutral', label: 'Neutral' },
  { id: 'smile', label: 'Smile' },
  { id: 'talk', label: 'Talk' },
  { id: 'walk', label: 'Walk' },
];

const CATEGORY_TABS: readonly { id: CreatorCategoryTab; label: string; subtitle: string; Icon: typeof Star }[] = [
  { id: 'presets', label: 'Presets', subtitle: 'Base hero and curated Riverside templates', Icon: Star },
  { id: 'face', label: 'Face', subtitle: 'Facial sculpting, skin tone, eyes, and details', Icon: Smile },
  { id: 'body', label: 'Body', subtitle: 'Proportions, height, and athletic framing', Icon: User },
  { id: 'hair', label: 'Hair', subtitle: 'Hairstyle silhouette, root tint, and ombre blend', Icon: Scissors },
  { id: 'wardrobe', label: 'Wardrobe', subtitle: 'Layered garments, colors, fabrics, and patterns', Icon: Shirt },
  { id: 'outfits', label: 'Outfits', subtitle: '8 seasonal and activity wardrobe slots', Icon: Layers },
  { id: 'identity', label: 'Identity', subtitle: 'Personality traits, desired life, values, and tastes', Icon: Heart },
];

const WARDROBE_SUB_TABS: readonly { id: WardrobeSubTab; label: string }[] = [
  { id: 'outerwear', label: 'Outerwear' },
  { id: 'top', label: 'Tops' },
  { id: 'bottom', label: 'Bottoms' },
  { id: 'shoes', label: 'Shoes' },
  { id: 'accessory', label: 'Accessories' },
];

const OUTERWEAR_SWATCHES = [
  '#3a3430', '#294052', '#b39572', '#6f5d52', '#9c3e49', '#3d5146', '#2b2b30', '#594238',
] as const;

function isResolvedWardrobeSet(v: unknown): v is UnlockedWardrobeSet {
  return Boolean(v && typeof v === 'object' && 'outerwear' in v && (v as UnlockedWardrobeSet).outerwear instanceof Set);
}

function findBoutiqueHint(slot: WardrobeSubTab, id: string): string | null {
  for (const m of CLOTHING_SKU_MAPPINGS) {
    if (slot === 'outerwear' && m.unlockedGarments.outerwear.includes(id as OuterwearId)) return m.name;
    if (slot === 'top' && m.unlockedGarments.tops.includes(id)) return m.name;
    if (slot === 'bottom' && m.unlockedGarments.bottoms.includes(id)) return m.name;
    if (slot === 'shoes' && m.unlockedGarments.shoes.includes(id)) return m.name;
    if (slot === 'accessory' && m.unlockedGarments.accessories.includes(id as AccessoryId)) return m.name;
  }
  return null;
}

function formatSigned(v: number): string {
  const fixed = v.toFixed(2);
  return v > 0 ? `+${fixed}` : fixed;
}

export function CharacterCreatorStudio({
  open,
  initialProfile,
  unlockedGarments,
  onPreviewChange,
  onCameraPreset,
  onLightPreset,
  onExpressionChange,
  onSnowPreviewChange,
  onOrbitYaw,
  onSave,
  onClose,
}: CharacterCreatorStudioProps) {
  const [history, setHistory] = useState<CreatorHistoryStack>(() => createHistory(initialProfile));
  const [category, setCategory] = useState<CreatorCategoryTab>('presets');
  const [faceTab, setFaceTab] = useState<FaceMorphTab>('Head and Jaw');
  const [wardrobeTab, setWardrobeTab] = useState<WardrobeSubTab>('outerwear');
  const [cameraPreset, setCameraPreset] = useState<CreatorCameraPreset>('full_body');
  const [lightPreset, setLightPreset] = useState<CreatorLightPreset>('studio');
  const [expression, setExpression] = useState<CreatorExpressionPreview>('neutral');
  const [snowPreview, setSnowPreview] = useState(false);
  const [nameDraft, setNameDraft] = useState(() => sanitizeCreatorProfile(initialProfile).identity.displayName);

  const historyRef = useRef<CreatorHistoryStack>(history);
  historyRef.current = history;
  const initialCleanRef = useRef<CharacterCreatorProfile>(
    sanitizeCreatorProfile(initialProfile),
  );
  const previewDirtyRef = useRef(false);
  const wasOpenRef = useRef(false);
  const randCounterRef = useRef(1);
  const dragStateRef = useRef<{ active: boolean; pointerId: number; lastX: number }>({
    active: false,
    pointerId: -1,
    lastX: 0,
  });

  // Reset history stack only on closed -> open transition so live onPreviewChange never wipes Undo/Redo
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    const clean = sanitizeCreatorProfile(initialProfile);
    initialCleanRef.current = clean;
    previewDirtyRef.current = false;
    const freshStack = createHistory(clean);
    historyRef.current = freshStack;
    setHistory(freshStack);
    setNameDraft(clean.identity.displayName);
    setSnowPreview(false);
    setCameraPreset('full_body');
    setLightPreset('studio');
    setExpression('neutral');
  }, [open, initialProfile]);

  const profile = history.present;
  const activeSlotId = profile.activeOutfitSlot;
  const activeOutfit = profile.outfits[activeSlotId];
  const heroCatalog = useMemo(() => getGarmentCatalogForHero(profile.hero), [profile.hero]);

  const unlockedSet = useMemo<UnlockedWardrobeSet>(() => {
    if (isResolvedWardrobeSet(unlockedGarments)) return unlockedGarments;
    return resolveUnlockedWardrobe(unlockedGarments ?? undefined);
  }, [unlockedGarments]);

  const commit = useCallback(
    (updater: (prev: CharacterCreatorProfile) => CharacterCreatorProfile) => {
      const prevStack = historyRef.current;
      const rawNext = updater(prevStack.present);
      const nextHero: Hero =
        rawNext.hero === 'KAI' ? 'KAI' : rawNext.hero === 'LYRA' ? 'LYRA' : prevStack.present.hero;
      const nextProfile = sanitizeCreatorProfile(rawNext, nextHero);
      const nextStack = pushHistory(prevStack, nextProfile);
      historyRef.current = nextStack;
      previewDirtyRef.current = true;
      setHistory(nextStack);
      onPreviewChange(nextStack.present);
    },
    [onPreviewChange],
  );

  const handleCancel = useCallback(() => {
    if (previewDirtyRef.current) {
      previewDirtyRef.current = false;
      onPreviewChange(initialCleanRef.current);
    }
    onClose();
  }, [onPreviewChange, onClose]);

  const handleUndo = useCallback(() => {
    const prevStack = historyRef.current;
    if (prevStack.past.length === 0) return;
    const next = undoHistory(prevStack);
    historyRef.current = next;
    previewDirtyRef.current = true;
    setHistory(next);
    setNameDraft(next.present.identity.displayName);
    onPreviewChange(next.present);
  }, [onPreviewChange]);

  const handleRedo = useCallback(() => {
    const prevStack = historyRef.current;
    if (prevStack.future.length === 0) return;
    const next = redoHistory(prevStack);
    historyRef.current = next;
    previewDirtyRef.current = true;
    setHistory(next);
    setNameDraft(next.present.identity.displayName);
    onPreviewChange(next.present);
  }, [onPreviewChange]);

  const handleRandomize = useCallback(() => {
    const seed = Date.now() + randCounterRef.current++ * 997;
    const next = randomizeProfile(seed, historyRef.current.present.hero);
    setNameDraft(next.identity.displayName);
    commit(() => next);
  }, [commit]);

  const handleReset = useCallback(() => {
    const next = createDefaultCreatorProfile(historyRef.current.present.hero);
    setNameDraft(next.identity.displayName);
    commit(() => next);
  }, [commit]);

  const selectCamera = useCallback(
    (preset: CreatorCameraPreset) => {
      setCameraPreset(preset);
      onCameraPreset?.(preset);
    },
    [onCameraPreset],
  );

  const selectLight = useCallback(
    (preset: CreatorLightPreset) => {
      setLightPreset(preset);
      onLightPreset?.(preset);
    },
    [onLightPreset],
  );

  const selectExpression = useCallback(
    (expr: CreatorExpressionPreview) => {
      setExpression(expr);
      onExpressionChange?.(expr);
    },
    [onExpressionChange],
  );

  const toggleSnowPreview = useCallback(() => {
    setSnowPreview(prev => {
      const next = !prev;
      onSnowPreviewChange?.(next);
      return next;
    });
  }, [onSnowPreviewChange]);

  // Auto-frame helpful camera when entering Face or Hair tabs
  const handleSelectCategory = useCallback(
    (tab: CreatorCategoryTab) => {
      setCategory(tab);
      if (tab === 'face' || tab === 'hair') {
        selectCamera('face');
      } else if (tab === 'body' || tab === 'outfits' || tab === 'presets') {
        selectCamera('full_body');
      }
    },
    [selectCamera],
  );

  // Keyboard shortcuts: Escape closes, Ctrl/Cmd+Z undo, Ctrl/Cmd+Y redo
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleCancel();
        return;
      }
      const target = e.target as HTMLElement | null;
      const isTyping = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (isTyping && (target as HTMLInputElement).type === 'text') return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, handleCancel, handleUndo, handleRedo]);

  if (!open) return null;

  const activeCategoryMeta = CATEGORY_TABS.find(t => t.id === category) ?? CATEGORY_TABS[0];
  const activeSlotDef = OUTFIT_SLOTS.find(slot => slot.id === activeSlotId) ?? OUTFIT_SLOTS[0];
  const activeMorphDefs = FACE_MORPH_DEFS.filter(m => m.tab === faceTab);

  const updateActiveOutfit = (mutate: (slotCfg: CharacterCreatorProfile['outfits'][OutfitSlotId]) => CharacterCreatorProfile['outfits'][OutfitSlotId]) => {
    commit(prev => {
      const slotId = prev.activeOutfitSlot;
      const updated = sanitizeOutfitSlot(prev.hero, slotId, mutate({ ...prev.outfits[slotId] }));
      return {
        ...prev,
        outfits: {
          ...prev.outfits,
          [slotId]: updated,
        },
      };
    });
  };

  const switchHero = (hero: Hero) => {
    if (historyRef.current.present.hero === hero) return;
    const switched = switchCreatorHero(historyRef.current.present, hero);
    setNameDraft(switched.identity.displayName);
    commit(() => switched);
  };

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = { active: true, pointerId: e.pointerId, lastX: e.clientX };
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current.active || dragStateRef.current.pointerId !== e.pointerId) return;
    const dx = e.clientX - dragStateRef.current.lastX;
    dragStateRef.current.lastX = e.clientX;
    if (dx !== 0) onOrbitYaw?.(dx * 0.0085);
  };

  const handleStagePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current.pointerId !== e.pointerId) return;
    dragStateRef.current.active = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleStageKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onOrbitYaw?.(-0.26);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onOrbitYaw?.(0.26);
    }
  };

  const handleRailKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = CATEGORY_TABS.findIndex(t => t.id === category);
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      handleSelectCategory(CATEGORY_TABS[(idx + 1) % CATEGORY_TABS.length].id);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      handleSelectCategory(CATEGORY_TABS[(idx - 1 + CATEGORY_TABS.length) % CATEGORY_TABS.length].id);
    }
  };

  const wardrobeColorKey = wardrobeTab;
  const wardrobeSwatches: readonly string[] =
    wardrobeTab === 'outerwear' ? OUTERWEAR_SWATCHES
    : wardrobeTab === 'top' ? COLOR_SWATCHES.top
    : wardrobeTab === 'bottom' ? COLOR_SWATCHES.bottom
    : wardrobeTab === 'shoes' ? COLOR_SWATCHES.shoes
    : COLOR_SWATCHES.accessory;

  const selectedDesiredLife = DESIRED_LIFE_CATALOG.find(d => d.id === profile.identity.desiredLifeId) ?? DESIRED_LIFE_CATALOG[0];

  return (
    <div
      className={s.studioRoot}
      role="dialog"
      aria-modal="true"
      aria-label="Character Creator Studio"
      data-testid="caz-studio"
    >
      {/* Top Floating Studio Bar */}
      <header className={s.topBar} data-testid="caz-top-bar">
        <div className={s.topGroup} role="group" aria-label="Camera framing">
          <span className={s.groupLabel}>View</span>
          {CAMERA_PRESETS.map(cam => (
            <button
              key={cam.id}
              type="button"
              className={s.pillBtn}
              aria-pressed={cameraPreset === cam.id}
              data-testid={`caz-cam-${cam.id}`}
              onClick={() => selectCamera(cam.id)}
            >
              {cam.label}
            </button>
          ))}
          <span className={s.divider} aria-hidden="true" />
          <span className={s.groupLabel}>Light</span>
          {LIGHT_PRESETS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={s.pillBtn}
              aria-pressed={lightPreset === id}
              data-testid={`caz-light-${id}`}
              onClick={() => selectLight(id)}
            >
              <Icon size={13} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className={s.topGroup} role="group" aria-label="Live preview">
          <span className={s.groupLabel}>Preview</span>
          {EXPRESSION_PREVIEWS.map(ex => (
            <button
              key={ex.id}
              type="button"
              className={s.pillBtn}
              aria-pressed={expression === ex.id}
              data-testid={`caz-expr-${ex.id}`}
              onClick={() => selectExpression(ex.id)}
            >
              {ex.label}
            </button>
          ))}
          <button
            type="button"
            className={`${s.pillBtn} ${snowPreview ? s.snowActive : ''}`}
            aria-pressed={snowPreview}
            data-testid="caz-preview-snow"
            onClick={toggleSnowPreview}
          >
            <Snowflake size={13} aria-hidden="true" />
            <span>Winter Snow</span>
          </button>
        </div>

        <div className={s.topGroup} role="group" aria-label="Studio actions">
          <button
            type="button"
            className={s.iconActionBtn}
            aria-label="Undo character change"
            disabled={history.past.length === 0}
            data-testid="caz-undo-btn"
            onClick={handleUndo}
          >
            <Undo2 size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={s.iconActionBtn}
            aria-label="Redo character change"
            disabled={history.future.length === 0}
            data-testid="caz-redo-btn"
            onClick={handleRedo}
          >
            <Redo2 size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={s.iconActionBtn}
            aria-label="Randomize character"
            data-testid="caz-randomize-btn"
            onClick={handleRandomize}
          >
            <Shuffle size={14} aria-hidden="true" />
            <span>Randomize</span>
          </button>
          <button
            type="button"
            className={s.iconActionBtn}
            aria-label="Reset character to default"
            data-testid="caz-reset-btn"
            onClick={handleReset}
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span>Reset</span>
          </button>
          <button
            type="button"
            className={s.iconActionBtn}
            aria-label="Cancel and close Character Studio"
            data-testid="caz-cancel-btn"
            onClick={handleCancel}
          >
            <X size={14} aria-hidden="true" />
            <span>Cancel</span>
          </button>
          <button
            type="button"
            className={s.saveBtn}
            aria-label="Save Character"
            data-testid="caz-save-btn"
            onClick={() => {
              previewDirtyRef.current = false;
              onSave(sanitizeCreatorProfile(profile, profile.hero));
            }}
          >
            <Check size={15} aria-hidden="true" />
            <span>Save Character</span>
          </button>
        </div>
      </header>

      {/* Transparent 360-Degree Center Turntable Stage */}
      <div
        className={s.turntableStage}
        tabIndex={0}
        role="region"
        aria-label="3D character turntable. Drag horizontally or press left and right arrow keys to rotate."
        data-testid="caz-turntable-stage"
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerEnd}
        onPointerCancel={handleStagePointerEnd}
        onKeyDown={handleStageKeyDown}
      >
        <div className={s.stageHint}>
          <RotateCcw size={13} aria-hidden="true" />
          <span>Drag to rotate</span>
          <strong>{profile.identity.displayName}</strong>
          <span className={s.stageBadge}>{snowPreview ? 'Winter Snow Preview' : activeSlotDef.label}</span>
        </div>
      </div>

      {/* Left Vertical Category Rail (7 Clean Tabs) */}
      <nav
        className={s.leftRail}
        role="tablist"
        aria-label="Character Creator categories"
        aria-orientation="vertical"
        data-testid="caz-category-rail"
        onKeyDown={handleRailKeyDown}
      >
        {CATEGORY_TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={s.railTab}
            aria-selected={category === id}
            data-testid={`caz-tab-${id}`}
            onClick={() => handleSelectCategory(id)}
          >
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {/* Right Docked Sculpting and Styling Inspector */}
      <aside className={s.inspector} aria-label={`${activeCategoryMeta.label} inspector`} data-testid="caz-inspector">
        <div className={s.inspectorHead}>
          <div>
            <h2>{activeCategoryMeta.label}</h2>
            <p className={s.inspectorSub}>{activeCategoryMeta.subtitle}</p>
          </div>
          <span className={s.stageBadge}>{profile.hero === 'LYRA' ? 'Lyra' : 'Kai'}</span>
        </div>

        <div className={s.inspectorBody}>
          {/* ── 1. PRESETS TAB ─────────────────────────────────────────────────────────────────────────── */}
          {category === 'presets' && (
            <>
              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Base Hero</h3>
                </div>
                <div className={s.heroSwitch}>
                  {(['LYRA', 'KAI'] as const).map(hero => (
                    <button
                      key={hero}
                      type="button"
                      className={s.heroBtn}
                      aria-pressed={profile.hero === hero}
                      data-testid={`caz-hero-${hero}`}
                      onClick={() => switchHero(hero)}
                    >
                      <strong>{hero === 'LYRA' ? 'Lyra' : 'Kai'}</strong>
                      <span>{hero === 'LYRA' ? 'Expressive studio silhouette' : 'Tailored campus silhouette'}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Curated Character Presets</h3>
                  <span className={s.tagBadge}>{CHARACTER_PRESETS.length} styles</span>
                </div>
                <div className={s.presetGrid}>
                  {CHARACTER_PRESETS.map(preset => {
                    const p = preset.profile;
                    const slotCfg = p.outfits[p.activeOutfitSlot];
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={s.presetCard}
                        data-testid={`caz-preset-${preset.id}`}
                        onClick={() => {
                          setNameDraft(preset.profile.identity.displayName);
                          commit(() => preset.profile);
                        }}
                      >
                        <div className={s.presetTop}>
                          <strong>{preset.label}</strong>
                          <span className={s.tagBadge}>{p.hero === 'LYRA' ? 'Lyra' : 'Kai'}</span>
                        </div>
                        <p className={s.presetTagline}>{preset.tagline}</p>
                        <div className={s.chipRow} aria-label="Preset color palette">
                          <span className={s.colorDot} style={{ backgroundColor: p.skinHex }} title="Skin tone" />
                          <span className={s.colorDot} style={{ backgroundColor: p.hairColor }} title="Hair color" />
                          <span className={s.colorDot} style={{ backgroundColor: slotCfg.colors.top }} title="Top color" />
                          <span className={s.colorDot} style={{ backgroundColor: slotCfg.colors.outerwear }} title="Outerwear color" />
                          <span className={s.tagBadge}>{p.identity.displayName}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* ── 2. FACE TAB ────────────────────────────────────────────────────────────────────────────── */}
          {category === 'face' && (
            <>
              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Facial Sculpt Morphs</h3>
                  <button
                    type="button"
                    className={s.miniBtn}
                    onClick={() =>
                      commit(prev => {
                        const fresh = { ...prev.faceMorphs };
                        for (const def of activeMorphDefs) fresh[def.key] = def.defaultValue;
                        return { ...prev, faceMorphs: fresh };
                      })
                    }
                  >
                    Reset Tab
                  </button>
                </div>
                <div className={s.subTabBar} role="tablist" aria-label="Face morph groups">
                  {FACE_MORPH_TABS.map(tab => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      className={s.subTabBtn}
                      aria-selected={faceTab === tab}
                      data-testid={`caz-face-tab-${tab.toLowerCase().replace(/\s+/g, '-')}`}
                      onClick={() => setFaceTab(tab)}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                <div className={s.sliderList}>
                  {activeMorphDefs.map(def => {
                    const val = profile.faceMorphs[def.key];
                    return (
                      <label key={def.key} className={s.sliderRow}>
                        <span className={s.sliderMeta}>
                          <span>{def.label}</span>
                          <span className={s.sliderVal}>{formatSigned(val)}</span>
                        </span>
                        <input
                          type="range"
                          className={s.rangeInput}
                          min={def.min}
                          max={def.max}
                          step={def.step}
                          value={val}
                          aria-label={def.label}
                          data-testid={`caz-morph-${def.key}`}
                          onChange={e => {
                            const nextVal = Number(e.target.value);
                            commit(prev => ({
                              ...prev,
                              faceMorphs: { ...prev.faceMorphs, [def.key]: nextVal },
                            }));
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className={s.miniBtn}
                  onClick={() => commit(prev => ({ ...prev, faceMorphs: defaultFaceSculptWeights() }))}
                >
                  Reset All Face Morphs
                </button>
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Skin Tone (Fitzpatrick I to VI)</h3>
                  <span className={s.hexReadout}>{profile.skinHex}</span>
                </div>
                <div className={s.swatchGrid}>
                  {SKIN_TONE_PRESETS.map(skin => (
                    <button
                      key={skin.id}
                      type="button"
                      className={s.swatchBtn}
                      style={{ backgroundColor: skin.hex }}
                      aria-label={`${skin.label} skin tone`}
                      aria-pressed={profile.skinHex.toLowerCase() === skin.hex.toLowerCase()}
                      title={`${skin.label} (Type ${skin.fitzpatrick})`}
                      data-testid={`caz-skin-${skin.id}`}
                      onClick={() => commit(prev => ({ ...prev, skinHex: skin.hex }))}
                    />
                  ))}
                </div>
                <div className={s.hexPickerRow}>
                  <label className={s.hexPickerLabel}>
                    <span>Custom Skin Tone</span>
                    <input
                      type="color"
                      className={s.colorInput}
                      value={profile.skinHex}
                      aria-label="Custom skin tone color"
                      onChange={e => commit(prev => ({ ...prev, skinHex: e.target.value }))}
                    />
                  </label>
                  <span className={s.hexReadout}>{profile.skinHex}</span>
                </div>
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Eye Iris Color</h3>
                  <span className={s.hexReadout}>{profile.irisHex}</span>
                </div>
                <div className={s.swatchGrid}>
                  {IRIS_COLOR_PRESETS.map(iris => (
                    <button
                      key={iris.id}
                      type="button"
                      className={s.swatchBtn}
                      style={{ backgroundColor: iris.hex }}
                      aria-label={`${iris.label} iris color`}
                      aria-pressed={profile.irisHex.toLowerCase() === iris.hex.toLowerCase()}
                      title={iris.label}
                      data-testid={`caz-iris-${iris.id}`}
                      onClick={() => commit(prev => ({ ...prev, irisHex: iris.hex }))}
                    />
                  ))}
                </div>
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Brows, Makeup, and Facial Hair</h3>
                </div>
                <div className={s.sliderList}>
                  <label className={s.sliderRow}>
                    <span className={s.sliderMeta}>
                      <span>Brow Thickness</span>
                      <span className={s.sliderVal}>{Math.round(profile.makeup.browThickness * 100)}%</span>
                    </span>
                    <input
                      type="range"
                      className={s.rangeInput}
                      min={0}
                      max={1}
                      step={0.02}
                      value={profile.makeup.browThickness}
                      aria-label="Brow Thickness"
                      onChange={e => {
                        const v = Number(e.target.value);
                        commit(prev => ({ ...prev, makeup: { ...prev.makeup, browThickness: v } }));
                      }}
                    />
                  </label>
                  <label className={s.sliderRow}>
                    <span className={s.sliderMeta}>
                      <span>Brow Darkness</span>
                      <span className={s.sliderVal}>{Math.round(profile.makeup.browDarkness * 100)}%</span>
                    </span>
                    <input
                      type="range"
                      className={s.rangeInput}
                      min={0}
                      max={1}
                      step={0.02}
                      value={profile.makeup.browDarkness}
                      aria-label="Brow Darkness"
                      onChange={e => {
                        const v = Number(e.target.value);
                        commit(prev => ({ ...prev, makeup: { ...prev.makeup, browDarkness: v } }));
                      }}
                    />
                  </label>
                  <label className={s.sliderRow}>
                    <span className={s.sliderMeta}>
                      <span>Lip Tint Opacity</span>
                      <span className={s.sliderVal}>{Math.round(profile.makeup.lipOpacity * 100)}%</span>
                    </span>
                    <input
                      type="range"
                      className={s.rangeInput}
                      min={0}
                      max={1}
                      step={0.02}
                      value={profile.makeup.lipOpacity}
                      aria-label="Lip Tint Opacity"
                      onChange={e => {
                        const v = Number(e.target.value);
                        commit(prev => ({ ...prev, makeup: { ...prev.makeup, lipOpacity: v } }));
                      }}
                    />
                  </label>
                  <div className={s.hexPickerRow}>
                    <label className={s.hexPickerLabel}>
                      <span>Lip Color</span>
                      <input
                        type="color"
                        className={s.colorInput}
                        value={profile.makeup.lipColor}
                        aria-label="Lip color"
                        onChange={e => commit(prev => ({ ...prev, makeup: { ...prev.makeup, lipColor: e.target.value } }))}
                      />
                    </label>
                    <label className={s.hexPickerLabel}>
                      <span>Blush Color</span>
                      <input
                        type="color"
                        className={s.colorInput}
                        value={profile.makeup.blushColor}
                        aria-label="Blush color"
                        onChange={e => commit(prev => ({ ...prev, makeup: { ...prev.makeup, blushColor: e.target.value } }))}
                      />
                    </label>
                  </div>
                  <label className={s.sliderRow}>
                    <span className={s.sliderMeta}>
                      <span>Blush Intensity</span>
                      <span className={s.sliderVal}>{Math.round(profile.makeup.blushIntensity * 100)}%</span>
                    </span>
                    <input
                      type="range"
                      className={s.rangeInput}
                      min={0}
                      max={1}
                      step={0.02}
                      value={profile.makeup.blushIntensity}
                      aria-label="Blush Intensity"
                      onChange={e => {
                        const v = Number(e.target.value);
                        commit(prev => ({ ...prev, makeup: { ...prev.makeup, blushIntensity: v } }));
                      }}
                    />
                  </label>
                  <label className={s.sliderRow}>
                    <span className={s.sliderMeta}>
                      <span>Freckles</span>
                      <span className={s.sliderVal}>{Math.round(profile.makeup.freckleDensity * 100)}%</span>
                    </span>
                    <input
                      type="range"
                      className={s.rangeInput}
                      min={0}
                      max={1}
                      step={0.02}
                      value={profile.makeup.freckleDensity}
                      aria-label="Freckle Density"
                      onChange={e => {
                        const v = Number(e.target.value);
                        commit(prev => ({ ...prev, makeup: { ...prev.makeup, freckleDensity: v } }));
                      }}
                    />
                  </label>
                </div>

                <div className={s.subTabBar} role="group" aria-label="Facial hair styles">
                  {FACIAL_HAIR_STYLES.map(fh => (
                    <button
                      key={fh.id}
                      type="button"
                      className={s.subTabBtn}
                      aria-pressed={profile.makeup.facialHair === fh.id}
                      data-testid={`caz-facial-hair-${fh.id}`}
                      onClick={() => commit(prev => ({ ...prev, makeup: { ...prev.makeup, facialHair: fh.id } }))}
                    >
                      {fh.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── 3. BODY TAB ────────────────────────────────────────────────────────────────────────────── */}
          {category === 'body' && (
            <>
              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Body Presets</h3>
                </div>
                <div className={s.subTabBar} role="group" aria-label="Body type presets">
                  {BODY_PRESETS.map(bp => {
                    const matches = BODY_SLIDER_DEFS.every(
                      d => Math.abs(profile.body[d.key] - bp.values[d.key]) < 0.005,
                    );
                    return (
                      <button
                        key={bp.id}
                        type="button"
                        className={s.subTabBtn}
                        aria-pressed={matches}
                        data-testid={`caz-body-preset-${bp.id}`}
                        onClick={() => commit(prev => ({ ...prev, body: { ...bp.values } }))}
                      >
                        {bp.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Live Proportions</h3>
                  <button
                    type="button"
                    className={s.miniBtn}
                    onClick={() => commit(prev => ({ ...prev, body: { ...BODY_PRESETS[0].values } }))}
                  >
                    Balanced
                  </button>
                </div>
                <div className={s.sliderList}>
                  {BODY_SLIDER_DEFS.map(def => {
                    const val = profile.body[def.key];
                    return (
                      <label key={def.key} className={s.sliderRow}>
                        <span className={s.sliderMeta}>
                          <span>{def.label}</span>
                          <span className={s.sliderVal}>{Math.round(val * 100)}%</span>
                        </span>
                        <input
                          type="range"
                          className={s.rangeInput}
                          min={def.min}
                          max={def.max}
                          step={def.step}
                          value={val}
                          aria-label={def.label}
                          data-testid={`caz-body-${def.key}`}
                          onChange={e => {
                            const nextVal = Number(e.target.value);
                            commit(prev => ({ ...prev, body: { ...prev.body, [def.key]: nextVal } }));
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* ── 4. HAIR TAB ────────────────────────────────────────────────────────────────────────────── */}
          {category === 'hair' && (
            <>
              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Hairstyles</h3>
                  <span className={s.tagBadge}>{HAIR_CATALOG.length} styles</span>
                </div>
                <div className={s.cardGrid2}>
                  {HAIR_CATALOG.map(hair => (
                    <button
                      key={hair.id}
                      type="button"
                      className={s.choiceCard}
                      aria-pressed={profile.hairId === hair.id}
                      data-testid={`caz-hair-${hair.id}`}
                      onClick={() => commit(prev => ({ ...prev, hairId: hair.id }))}
                    >
                      <span className={s.choiceTitle}>{hair.label}</span>
                      <span className={s.choiceMetaRow}>
                        <span className={s.tagBadge}>{hair.length}</span>
                        <span className={s.tagBadge}>{hair.styleTag}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Root Hair Color</h3>
                  <span className={s.hexReadout}>{profile.hairColor}</span>
                </div>
                <div className={s.swatchGrid}>
                  {HAIR_COLOR_PRESETS.map(hc => (
                    <button
                      key={hc.id}
                      type="button"
                      className={s.swatchBtn}
                      style={{ backgroundColor: hc.hex }}
                      aria-label={`${hc.label} root hair color`}
                      aria-pressed={profile.hairColor.toLowerCase() === hc.hex.toLowerCase()}
                      title={hc.label}
                      data-testid={`caz-hair-color-${hc.id}`}
                      onClick={() => commit(prev => ({ ...prev, hairColor: hc.hex }))}
                    />
                  ))}
                </div>
                <div className={s.hexPickerRow}>
                  <label className={s.hexPickerLabel}>
                    <span>Custom Root Hue</span>
                    <input
                      type="color"
                      className={s.colorInput}
                      value={profile.hairColor}
                      aria-label="Custom root hair color"
                      onChange={e => commit(prev => ({ ...prev, hairColor: e.target.value }))}
                    />
                  </label>
                  <span className={s.hexReadout}>{profile.hairColor}</span>
                </div>
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Ombre Tip Gradient</h3>
                  <span className={s.sliderVal}>{Math.round(profile.hairTipMix * 100)}%</span>
                </div>
                <label className={s.sliderRow}>
                  <span className={s.sliderMeta}>
                    <span>Ombre Blend</span>
                    <span className={s.sliderVal}>{Math.round(profile.hairTipMix * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    className={s.rangeInput}
                    min={0}
                    max={1}
                    step={0.05}
                    value={profile.hairTipMix}
                    aria-label="Ombre Tip Blend"
                    data-testid="caz-hair-ombre-blend"
                    onChange={e => {
                      const nextVal = Number(e.target.value);
                      commit(prev => ({ ...prev, hairTipMix: nextVal }));
                    }}
                  />
                </label>
                <div className={s.swatchGrid}>
                  {HAIR_COLOR_PRESETS.slice(0, 6).map(hc => (
                    <button
                      key={`tip_${hc.id}`}
                      type="button"
                      className={s.swatchBtn}
                      style={{ backgroundColor: hc.hex }}
                      aria-label={`${hc.label} ombre tip color`}
                      aria-pressed={profile.hairTipColor.toLowerCase() === hc.hex.toLowerCase()}
                      title={`${hc.label} Tip`}
                      onClick={() =>
                        commit(prev => ({
                          ...prev,
                          hairTipColor: hc.hex,
                          hairTipMix: prev.hairTipMix < 0.15 ? 0.35 : prev.hairTipMix,
                        }))
                      }
                    />
                  ))}
                </div>
                <div className={s.hexPickerRow}>
                  <label className={s.hexPickerLabel}>
                    <span>Custom Tip Color</span>
                    <input
                      type="color"
                      className={s.colorInput}
                      value={profile.hairTipColor}
                      aria-label="Custom ombre tip color"
                      onChange={e =>
                        commit(prev => ({
                          ...prev,
                          hairTipColor: e.target.value,
                          hairTipMix: prev.hairTipMix < 0.15 ? 0.35 : prev.hairTipMix,
                        }))
                      }
                    />
                  </label>
                  <span className={s.hexReadout}>{profile.hairTipColor}</span>
                </div>
              </div>
            </>
          )}

          {/* ── 5. WARDROBE TAB ────────────────────────────────────────────────────────────────────────── */}
          {category === 'wardrobe' && (
            <>
              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Editing Slot: {activeSlotDef.label}</h3>
                  <button type="button" className={s.miniBtn} onClick={() => handleSelectCategory('outfits')}>
                    Switch Slot
                  </button>
                </div>
                <div className={s.subTabBar} role="tablist" aria-label="Wardrobe garment layers">
                  {WARDROBE_SUB_TABS.map(tab => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      className={s.subTabBtn}
                      aria-selected={wardrobeTab === tab.id}
                      data-testid={`caz-wardrobe-${tab.id}`}
                      onClick={() => {
                        setWardrobeTab(tab.id);
                        if (tab.id === 'shoes') selectCamera('shoes');
                        else if (tab.id === 'accessory') selectCamera('upper');
                        else selectCamera('full_body');
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Garment Items Grid */}
                {wardrobeTab === 'outerwear' && (
                  <div className={s.cardGrid2}>
                    {OUTERWEAR_CATALOG.map(ow => {
                      const unlocked = isGarmentUnlocked(ow.id, 'outerwear', unlockedSet);
                      const hint = findBoutiqueHint('outerwear', ow.id);
                      return (
                        <button
                          key={ow.id}
                          type="button"
                          className={s.choiceCard}
                          aria-pressed={activeOutfit.outerwear === ow.id}
                          data-testid={`caz-item-outerwear-${ow.id}`}
                          onClick={() =>
                            updateActiveOutfit(cfg => {
                              const needsModularBase =
                                ow.id !== 'none' &&
                                ow.id !== 'winter_scarf' &&
                                cfg.top === SIGNATURE;
                              return {
                                ...cfg,
                                outerwear: ow.id,
                                ...(needsModularBase
                                  ? {
                                      top: 'knit',
                                      bottom: cfg.bottom === SIGNATURE ? 'chinos' : cfg.bottom,
                                      shoes:
                                        cfg.shoes === SIGNATURE
                                          ? ow.id === 'wool_overcoat' || ow.id === 'puffer_parka'
                                            ? 'boots'
                                            : ow.id === 'trench_coat'
                                              ? 'loafers'
                                              : 'sneakers'
                                          : cfg.shoes,
                                    }
                                  : {}),
                                fabrics: { ...cfg.fabrics, outerwear: ow.defaultFabric },
                              };
                            })
                          }
                        >
                          <span className={s.choiceTitle}>{ow.label}</span>
                          <span className={s.choiceMetaRow}>
                            {ow.warmth >= 2 && <span className={s.tagBadge}>Warmth {ow.warmth}</span>}
                            {unlocked ? (
                              <span className={s.unlockedBadge}>Owned</span>
                            ) : (
                              <span className={s.boutiqueBadge} title={hint ?? 'Boutique unlock'}>
                                Boutique
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {wardrobeTab === 'top' && (
                  <div className={s.cardGrid2}>
                    <button
                      type="button"
                      className={s.choiceCard}
                      aria-pressed={activeOutfit.top === SIGNATURE}
                      data-testid="caz-item-top-signature"
                      onClick={() =>
                        updateActiveOutfit(cfg => ({
                          ...cfg,
                          outerwear: cfg.outerwear === 'winter_scarf' ? 'winter_scarf' : 'none',
                          top: SIGNATURE,
                          bottom: SIGNATURE,
                          shoes: SIGNATURE,
                        }))
                      }
                    >
                      <span className={s.choiceTitle}>Signature Look</span>
                      <span className={s.unlockedBadge}>Starter</span>
                    </button>
                    {heroCatalog.tops.map(item => {
                      const unlocked = isGarmentUnlocked(item.id, 'top', unlockedSet);
                      const hint = findBoutiqueHint('top', item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={s.choiceCard}
                          aria-pressed={activeOutfit.top === item.id}
                          data-testid={`caz-item-top-${item.id}`}
                          onClick={() =>
                            updateActiveOutfit(cfg => ({
                              ...cfg,
                              top: item.id,
                              fabrics: { ...cfg.fabrics, top: item.defaultFabric },
                            }))
                          }
                        >
                          <span className={s.choiceTitle}>{item.label}</span>
                          <span className={s.choiceMetaRow}>
                            {item.slot === 'dress' && <span className={s.tagBadge}>Full Dress</span>}
                            {unlocked ? (
                              <span className={s.unlockedBadge}>Owned</span>
                            ) : (
                              <span className={s.boutiqueBadge} title={hint ?? 'Boutique unlock'}>
                                Boutique
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {wardrobeTab === 'bottom' && (
                  <div className={s.cardGrid2}>
                    {heroCatalog.bottoms.map(item => {
                      const unlocked = isGarmentUnlocked(item.id, 'bottom', unlockedSet);
                      const hint = findBoutiqueHint('bottom', item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={s.choiceCard}
                          aria-pressed={activeOutfit.bottom === item.id}
                          data-testid={`caz-item-bottom-${item.id}`}
                          onClick={() =>
                            updateActiveOutfit(cfg => ({
                              ...cfg,
                              bottom: item.id,
                              top: cfg.top === SIGNATURE || cfg.top === 'dress' ? 'tee' : cfg.top,
                              fabrics: { ...cfg.fabrics, bottom: item.defaultFabric },
                            }))
                          }
                        >
                          <span className={s.choiceTitle}>{item.label}</span>
                          <span className={s.choiceMetaRow}>
                            {unlocked ? (
                              <span className={s.unlockedBadge}>Owned</span>
                            ) : (
                              <span className={s.boutiqueBadge} title={hint ?? 'Boutique unlock'}>
                                Boutique
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {wardrobeTab === 'shoes' && (
                  <div className={s.cardGrid2}>
                    {heroCatalog.shoes.map(item => {
                      const unlocked = isGarmentUnlocked(item.id, 'shoes', unlockedSet);
                      const hint = findBoutiqueHint('shoes', item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={s.choiceCard}
                          aria-pressed={activeOutfit.shoes === item.id}
                          data-testid={`caz-item-shoes-${item.id}`}
                          onClick={() =>
                            updateActiveOutfit(cfg => ({
                              ...cfg,
                              shoes: item.id,
                              top: cfg.top === SIGNATURE ? 'tee' : cfg.top,
                              fabrics: { ...cfg.fabrics, shoes: item.defaultFabric },
                            }))
                          }
                        >
                          <span className={s.choiceTitle}>{item.label}</span>
                          <span className={s.choiceMetaRow}>
                            {unlocked ? (
                              <span className={s.unlockedBadge}>Owned</span>
                            ) : (
                              <span className={s.boutiqueBadge} title={hint ?? 'Boutique unlock'}>
                                Boutique
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {wardrobeTab === 'accessory' && (
                  <div className={s.cardGrid2}>
                    {ACCESSORY_CATALOG.map(acc => {
                      const worn = activeOutfit.accessories.includes(acc.id);
                      const unlocked = isGarmentUnlocked(acc.id, 'accessory', unlockedSet);
                      const hint = findBoutiqueHint('accessory', acc.id);
                      return (
                        <button
                          key={acc.id}
                          type="button"
                          className={s.choiceCard}
                          aria-pressed={worn}
                          data-testid={`caz-item-accessory-${acc.id}`}
                          onClick={() =>
                            updateActiveOutfit(cfg => {
                              const exists = cfg.accessories.includes(acc.id);
                              const nextAcc = exists
                                ? cfg.accessories.filter(a => a !== acc.id)
                                : [...cfg.accessories, acc.id].slice(0, 4);
                              return { ...cfg, accessories: nextAcc };
                            })
                          }
                        >
                          <span className={s.choiceTitle}>{acc.label}</span>
                          <span className={s.choiceMetaRow}>
                            <span className={s.tagBadge}>{acc.slotKind}</span>
                            {unlocked ? (
                              <span className={s.unlockedBadge}>Owned</span>
                            ) : (
                              <span className={s.boutiqueBadge} title={hint ?? 'Boutique unlock'}>
                                Boutique
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Layer Color Swatches and Custom Picker */}
              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Color Palette</h3>
                  <span className={s.hexReadout}>{activeOutfit.colors[wardrobeColorKey]}</span>
                </div>
                <div className={s.swatchGrid}>
                  {wardrobeSwatches.map(hex => (
                    <button
                      key={`${wardrobeTab}_${hex}`}
                      type="button"
                      className={s.swatchBtn}
                      style={{ backgroundColor: hex }}
                      aria-label={`Select color ${hex}`}
                      aria-pressed={activeOutfit.colors[wardrobeColorKey].toLowerCase() === hex.toLowerCase()}
                      onClick={() =>
                        updateActiveOutfit(cfg => ({
                          ...cfg,
                          colors: { ...cfg.colors, [wardrobeColorKey]: hex },
                        }))
                      }
                    />
                  ))}
                </div>
                <div className={s.hexPickerRow}>
                  <label className={s.hexPickerLabel}>
                    <span>Custom Dye</span>
                    <input
                      type="color"
                      className={s.colorInput}
                      value={activeOutfit.colors[wardrobeColorKey]}
                      aria-label="Custom garment color"
                      onChange={e =>
                        updateActiveOutfit(cfg => ({
                          ...cfg,
                          colors: { ...cfg.colors, [wardrobeColorKey]: e.target.value },
                        }))
                      }
                    />
                  </label>
                  <span className={s.hexReadout}>{activeOutfit.colors[wardrobeColorKey]}</span>
                </div>
              </div>

              {/* 8 Fabrics and 4 Patterns (for outerwear, top, bottom, shoes) */}
              {wardrobeTab !== 'accessory' && (
                <>
                  <div className={s.sectionCard}>
                    <div className={s.sectionHeader}>
                      <h3 className={s.sectionTitle}>Fabric Material</h3>
                      <span className={s.tagBadge}>{FABRIC_CATALOG.length} fabrics</span>
                    </div>
                    <div className={s.subTabBar} role="group" aria-label="Garment fabric selector">
                      {FABRIC_CATALOG.map(fab => (
                        <button
                          key={fab.id}
                          type="button"
                          className={s.subTabBtn}
                          aria-pressed={activeOutfit.fabrics[wardrobeTab] === fab.id}
                          data-testid={`caz-fabric-${fab.id}`}
                          onClick={() =>
                            updateActiveOutfit(cfg => ({
                              ...cfg,
                              fabrics: { ...cfg.fabrics, [wardrobeTab]: fab.id as FabricId },
                            }))
                          }
                        >
                          {fab.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className={s.sectionCard}>
                    <div className={s.sectionHeader}>
                      <h3 className={s.sectionTitle}>Surface Pattern</h3>
                    </div>
                    <div className={s.subTabBar} role="group" aria-label="Garment pattern selector">
                      {PATTERN_CATALOG.map(pat => (
                        <button
                          key={pat.id}
                          type="button"
                          className={s.subTabBtn}
                          aria-pressed={activeOutfit.patterns[wardrobeTab] === pat.id}
                          data-testid={`caz-pattern-${pat.id}`}
                          onClick={() =>
                            updateActiveOutfit(cfg => ({
                              ...cfg,
                              patterns: { ...cfg.patterns, [wardrobeTab]: pat.id as PatternId },
                            }))
                          }
                        >
                          {pat.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── 6. OUTFITS TAB (8 inZOI Outfit Slots) ──────────────────────────────────────────────────── */}
          {category === 'outfits' && (
            <>
              <div className={s.toggleCard}>
                <div className={s.toggleText}>
                  <strong>Auto-Switch Seasonal Outfit</strong>
                  <small>Automatically wears Cold Weather coats in winter snow and Hot Weather layers in summer heat.</small>
                </div>
                <button
                  type="button"
                  role="switch"
                  className={s.switchBtn}
                  aria-checked={profile.autoSeasonalOutfit}
                  data-testid="caz-auto-seasonal-toggle"
                  onClick={() => commit(prev => ({ ...prev, autoSeasonalOutfit: !prev.autoSeasonalOutfit }))}
                >
                  {profile.autoSeasonalOutfit ? 'Enabled' : 'Manual'}
                </button>
              </div>

              {OUTFIT_SLOTS.map(slotDef => {
                const cfg = profile.outfits[slotDef.id];
                const isActive = profile.activeOutfitSlot === slotDef.id;
                return (
                  <div
                    key={slotDef.id}
                    className={s.outfitCard}
                    data-active={isActive ? 'true' : 'false'}
                    data-testid={`caz-outfit-slot-${slotDef.id}`}
                  >
                    <div className={s.presetTop}>
                      <strong>{slotDef.label}</strong>
                      {isActive && <span className={s.unlockedBadge}>Active</span>}
                    </div>
                    <p className={s.presetTagline}>{slotDef.summary}</p>
                    <div className={s.chipRow}>
                      <span className={s.colorDot} style={{ backgroundColor: cfg.colors.outerwear }} title="Outerwear" />
                      <span className={s.colorDot} style={{ backgroundColor: cfg.colors.top }} title="Top" />
                      <span className={s.colorDot} style={{ backgroundColor: cfg.colors.bottom }} title="Bottom" />
                      <span className={s.colorDot} style={{ backgroundColor: cfg.colors.shoes }} title="Shoes" />
                      <span className={s.tagBadge}>
                        {cfg.outerwear !== 'none' ? cfg.outerwear.replace(/_/g, ' ') : cfg.top}
                      </span>
                    </div>
                    <div className={s.outfitActions}>
                      <button
                        type="button"
                        className={`${s.outfitBtn} ${isActive ? s.outfitBtnPrimary : ''}`}
                        onClick={() => commit(prev => ({ ...prev, activeOutfitSlot: slotDef.id }))}
                      >
                        {isActive ? 'Editing Slot' : 'Apply Slot'}
                      </button>
                      {!isActive && (
                        <button
                          type="button"
                          className={s.outfitBtn}
                          onClick={() =>
                            commit(prev => ({
                              ...prev,
                              outfits: {
                                ...prev.outfits,
                                [slotDef.id]: sanitizeOutfitSlot(prev.hero, slotDef.id, prev.outfits[prev.activeOutfitSlot]),
                              },
                            }))
                          }
                        >
                          Copy Current to Slot
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {/* ── 7. IDENTITY TAB (18 Traits, 16 Desired Lives, Values, Preferences) ─────────────────────── */}
          {category === 'identity' && (
            <>
              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Character Name</h3>
                </div>
                <input
                  type="text"
                  className={s.textInput}
                  maxLength={32}
                  value={nameDraft}
                  aria-label="Character Display Name"
                  data-testid="caz-display-name-input"
                  onChange={e => {
                    const clean = e.target.value
                      .replace(/&/g, ' and ')
                      .replace(/[^a-zA-Z0-9 '\-.]/g, '')
                      .slice(0, 32);
                    setNameDraft(clean);
                    if (clean.trim().length >= 2) {
                      commit(prev => ({
                        ...prev,
                        identity: { ...prev.identity, displayName: clean },
                      }));
                    }
                  }}
                  onBlur={() => {
                    const safe = sanitizeCreatorProfile({
                      ...profile,
                      identity: { ...profile.identity, displayName: nameDraft },
                    }).identity.displayName;
                    setNameDraft(safe);
                    if (safe !== profile.identity.displayName) {
                      commit(prev => ({
                        ...prev,
                        identity: { ...prev.identity, displayName: safe },
                      }));
                    }
                  }}
                />
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Personality Traits</h3>
                  <span className={s.stageBadge}>{profile.identity.traitIds.length} / 3</span>
                </div>
                <div className={s.cardGrid2}>
                  {TRAIT_CATALOG.map(trait => {
                    const selected = profile.identity.traitIds.includes(trait.id);
                    return (
                      <button
                        key={trait.id}
                        type="button"
                        className={s.traitCard}
                        aria-pressed={selected}
                        data-testid={`caz-trait-${trait.id}`}
                        onClick={() =>
                          commit(prev => {
                            const cur = prev.identity.traitIds;
                            const next = selected
                              ? cur.length > 1 ? cur.filter(id => id !== trait.id) : cur
                              : cur.length >= 3 ? [...cur.slice(1), trait.id] : [...cur, trait.id];
                            return { ...prev, identity: { ...prev.identity, traitIds: next } };
                          })
                        }
                      >
                        <span className={s.choiceTitle}>{trait.label}</span>
                        <span className={s.choiceMetaRow}>
                          <span className={s.tagBadge}>{trait.archetype}</span>
                          <span className={s.tagBadge}>{trait.emotionBias}</span>
                        </span>
                        <p>{trait.summary}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Desired Life</h3>
                  <span className={s.stageBadge}>{selectedDesiredLife.label}</span>
                </div>
                <div className={s.presetGrid}>
                  {DESIRED_LIFE_CATALOG.map(life => {
                    const selected = profile.identity.desiredLifeId === life.id;
                    return (
                      <button
                        key={life.id}
                        type="button"
                        className={s.traitCard}
                        aria-pressed={selected}
                        data-testid={`caz-life-${life.id}`}
                        onClick={() =>
                          commit(prev => ({
                            ...prev,
                            identity: { ...prev.identity, desiredLifeId: life.id },
                          }))
                        }
                      >
                        <div className={s.presetTop}>
                          <span className={s.choiceTitle}>{life.label}</span>
                          <span className={s.tagBadge}>{life.primarySkill}</span>
                        </div>
                        <p>{life.summary}</p>
                        {selected && (
                          <ol className={s.milestoneList}>
                            {life.milestones.map(m => (
                              <li key={m}>{m}</li>
                            ))}
                          </ol>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Core Values</h3>
                  <span className={s.stageBadge}>{profile.identity.valueIds.length} / 3</span>
                </div>
                <div className={s.subTabBar} role="group" aria-label="Core values">
                  {VALUES_CATALOG.map(val => {
                    const selected = profile.identity.valueIds.includes(val.id);
                    return (
                      <button
                        key={val.id}
                        type="button"
                        className={s.subTabBtn}
                        aria-pressed={selected}
                        title={val.summary}
                        data-testid={`caz-value-${val.id}`}
                        onClick={() =>
                          commit(prev => {
                            const cur = prev.identity.valueIds;
                            const next = selected
                              ? cur.length > 1 ? cur.filter(id => id !== val.id) : cur
                              : cur.length >= 3 ? [...cur.slice(1), val.id] : [...cur, val.id];
                            return { ...prev, identity: { ...prev.identity, valueIds: next } };
                          })
                        }
                      >
                        {val.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={s.sectionCard}>
                <div className={s.sectionHeader}>
                  <h3 className={s.sectionTitle}>Favorite Preferences</h3>
                  <span className={s.tagBadge}>
                    {profile.identity.likes.length} Likes · {profile.identity.dislikes.length} Dislikes
                  </span>
                </div>
                <div className={s.prefList}>
                  {PREFERENCES_CATALOG.map(pref => {
                    const liked = profile.identity.likes.includes(pref.id);
                    const disliked = profile.identity.dislikes.includes(pref.id);
                    return (
                      <div key={pref.id} className={s.prefRow}>
                        <div className={s.prefInfo}>
                          <strong>{pref.label}</strong>
                          <small>{pref.category}</small>
                        </div>
                        <div className={s.prefBtns}>
                          <button
                            type="button"
                            className={`${s.prefBtn} ${s.prefBtnLike}`}
                            aria-pressed={liked}
                            onClick={() =>
                              commit(prev => {
                                const nextLikes = liked
                                  ? prev.identity.likes.filter(x => x !== pref.id)
                                  : [...prev.identity.likes.slice(-4), pref.id];
                                const nextDislikes = prev.identity.dislikes.filter(x => x !== pref.id);
                                return {
                                  ...prev,
                                  identity: { ...prev.identity, likes: nextLikes, dislikes: nextDislikes },
                                };
                              })
                            }
                          >
                            Like
                          </button>
                          <button
                            type="button"
                            className={`${s.prefBtn} ${s.prefBtnDislike}`}
                            aria-pressed={disliked}
                            onClick={() =>
                              commit(prev => {
                                const nextDislikes = disliked
                                  ? prev.identity.dislikes.filter(x => x !== pref.id)
                                  : [...prev.identity.dislikes.slice(-4), pref.id];
                                const nextLikes = prev.identity.likes.filter(x => x !== pref.id);
                                return {
                                  ...prev,
                                  identity: { ...prev.identity, likes: nextLikes, dislikes: nextDislikes },
                                };
                              })
                            }
                          >
                            Dislike
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
