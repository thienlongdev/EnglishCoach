'use client';

import React, { useMemo, useState } from 'react';
import { Check, RotateCcw, Search, Star, Waves } from 'lucide-react';
import { BACKGROUND_PRESETS } from '@/lib/background-studio/presets';
import { previewSwatchCss } from '@/lib/background-studio/cssRenderer';
import {
  PRESET_CATEGORIES,
  type BackgroundEffectId,
  type BackgroundPreset,
  type BackgroundPresetCategory,
  type GradientType,
} from '@/lib/background-studio/types';
import styles from './BackgroundStudio.module.css';

export interface PresetGalleryPanelProps {
  /** Preset ID currently loaded in the studio live preview draft (if any). */
  selectedPresetId: string | null;
  /** Currently active workspace background source. */
  appliedSource: 'none' | 'preset' | 'custom';
  /** Currently active workspace theme/preset ID. */
  appliedThemeId: string | null;
  /** Set of favorited preset IDs for the current account. */
  favoritePresetIds: readonly string[];
  /** Loads a preset into the studio draft for live preview and editing. */
  onSelectPreset: (preset: BackgroundPreset) => void;
  /** Toggles favorite star state for a preset. */
  onToggleFavorite: (presetId: string) => void;
  /** Restores the original English Coach Echo Ocean default background. */
  onRestoreDefault: () => void;
  /** Vietnamese UI copy when true; English UI copy when false. */
  vi: boolean;
}

type GalleryFilter = 'all' | 'favorites' | BackgroundPresetCategory;

const CATEGORY_LABELS: Record<BackgroundPresetCategory, { vi: string; en: string }> = {
  abyss: { vi: 'Abyss', en: 'Abyss' },
  aurora: { vi: 'Aurora', en: 'Aurora' },
  crystal: { vi: 'Crystal', en: 'Crystal' },
  dream: { vi: 'Dream', en: 'Dream' },
  botanical: { vi: 'Botanical', en: 'Botanical' },
};

const GRADIENT_BADGES: Record<GradientType, string> = {
  linear: 'Linear',
  radial: 'Radial',
  conic: 'Conic',
  mesh: 'Mesh',
};

const EFFECT_SHORT_LABELS: Record<BackgroundEffectId, { vi: string; en: string }> = {
  static: { vi: 'Tĩnh', en: 'Static' },
  'color-flow': { vi: 'Color Flow', en: 'Color Flow' },
  aurora: { vi: 'Aurora', en: 'Aurora' },
  'liquid-flow': { vi: 'Liquid Flow', en: 'Liquid Flow' },
  'pearl-shimmer': { vi: 'Pearl Shimmer', en: 'Pearl Shimmer' },
  'ambient-glow': { vi: 'Ambient Glow', en: 'Ambient Glow' },
  'light-drift': { vi: 'Light Drift', en: 'Light Drift' },
  'color-breathing': { vi: 'Color Breathing', en: 'Color Breathing' },
  'gradient-morph': { vi: 'Gradient Morph', en: 'Gradient Morph' },
};

const DEFAULT_ECHO_OCEAN_SWATCH =
  'radial-gradient(ellipse 74% 62% at 24% 24%, rgb(56 189 248 / 0.44) 0%, rgb(30 64 175 / 0.2) 48%, rgb(7 16 40 / 0) 84%), ' +
  'radial-gradient(ellipse 68% 64% at 80% 78%, rgb(99 102 241 / 0.36) 0%, rgb(15 23 42 / 0) 82%), ' +
  'linear-gradient(155deg, rgb(7 16 40) 0%, rgb(11 26 62) 52%, rgb(4 10 26) 100%)';

const PRESET_SWATCHES: ReadonlyMap<string, string> = new Map(
  BACKGROUND_PRESETS.map((preset) => [preset.id, previewSwatchCss(preset.config)]),
);

function formatEffectBadge(effects: readonly BackgroundEffectId[], vi: boolean): string {
  if (effects.length === 0) {
    return EFFECT_SHORT_LABELS.static[vi ? 'vi' : 'en'];
  }
  const primary = EFFECT_SHORT_LABELS[effects[0]][vi ? 'vi' : 'en'];
  if (effects.length === 1) return primary;
  return `${primary} +${effects.length - 1}`;
}

/**
 * Tab 1 — Curated Preset Gallery for Echo Background Studio.
 * Displays the English Coach default Echo Ocean restore card plus all 10 handcrafted
 * atmospheric presets with category filtering, favorites, search, and live swatches.
 */
export default function PresetGalleryPanel({
  selectedPresetId,
  appliedSource,
  appliedThemeId,
  favoritePresetIds,
  onSelectPreset,
  onToggleFavorite,
  onRestoreDefault,
  vi,
}: PresetGalleryPanelProps) {
  const [filter, setFilter] = useState<GalleryFilter>('all');
  const [query, setQuery] = useState('');

  const favoriteSet = useMemo(() => new Set(favoritePresetIds), [favoritePresetIds]);
  const isDefaultActive = appliedSource === 'none';

  const visiblePresets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return BACKGROUND_PRESETS.filter((preset) => {
      if (filter === 'favorites' && !favoriteSet.has(preset.id)) {
        return false;
      }
      if (filter !== 'all' && filter !== 'favorites' && preset.category !== filter) {
        return false;
      }
      if (!normalizedQuery) return true;
      const haystack = [
        preset.name,
        preset.nameVi,
        preset.taglineEn,
        preset.taglineVi,
        preset.category,
        preset.config.color.gradientType,
        ...preset.config.motion.effects,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [favoriteSet, filter, query]);

  return (
    <>
      {/* Special English Coach Default (Echo Ocean) restore card */}
      <section className={styles.sectionCard} aria-label={vi ? 'Nền mặc định' : 'Default background'}>
        <div className={`${styles.myThemeCard} ${styles.defaultEchoCard}`} data-testid="preset-default-echo-ocean">
          <div
            className={styles.myThemeSwatch}
            style={{ backgroundImage: DEFAULT_ECHO_OCEAN_SWATCH }}
            aria-hidden="true"
          />
          <div className={styles.myThemeMeta}>
            <div className={styles.inlineRow}>
              <span className={styles.myThemeName}>
                {vi
                  ? 'Nền mặc định English Coach (Echo Ocean)'
                  : 'English Coach Default (Echo Ocean)'}
              </span>
              {isDefaultActive && (
                <span className={styles.presetActiveBadge} data-testid="preset-default-active-badge">
                  {vi ? 'Đang dùng' : 'In use'}
                </span>
              )}
            </div>
            <span className={styles.sectionHint}>
              {vi
                ? 'Khôi phục nền Echo Ocean nguyên bản mà vẫn giữ toàn bộ theme tùy chỉnh đã lưu.'
                : 'Restore the original Echo Ocean look while keeping all your saved custom themes.'}
            </span>
          </div>
          <button
            type="button"
            className={`${styles.btnSecondary} ${styles.btnSmall}`}
            onClick={onRestoreDefault}
            disabled={isDefaultActive}
            data-testid="preset-restore-default-btn"
          >
            {isDefaultActive ? (
              <>
                <Check size={13} aria-hidden="true" />
                <span>{vi ? 'Đang bật' : 'Active'}</span>
              </>
            ) : (
              <>
                <RotateCcw size={13} aria-hidden="true" />
                <span>{vi ? 'Khôi phục' : 'Restore'}</span>
              </>
            )}
          </button>
        </div>
      </section>

      {/* Filter bar and search */}
      <section className={styles.sectionCard} aria-label={vi ? 'Bộ sưu tập Preset' : 'Preset Gallery'}>
        <div className={styles.sectionHead}>
          <div>
            <h3 className={styles.sectionTitle}>
              {vi ? 'Bộ sưu tập 10 Preset thủ công' : '10 Handcrafted Studio Presets'}
            </h3>
            <p className={styles.sectionHint}>
              {vi
                ? 'Chọn một preset để xem trực tiếp ngay, sau đó tinh chỉnh màu sắc và ánh sáng theo ý bạn.'
                : 'Pick any preset for instant live preview, then tailor its colors and motion freely.'}
            </p>
          </div>
          <span className={styles.themeCountPill}>
            {visiblePresets.length} / {BACKGROUND_PRESETS.length}
          </span>
        </div>

        <div className={styles.filterBar}>
          <div
            className={styles.chipRow}
            role="group"
            aria-label={vi ? 'Lọc theo nhóm preset' : 'Filter presets by category'}
          >
            <button
              type="button"
              className={`${styles.filterChip} ${filter === 'all' ? styles.filterChipActive : ''}`}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
              data-testid="preset-filter-all"
            >
              {vi ? 'Tất cả' : 'All'}
            </button>

            <button
              type="button"
              className={`${styles.filterChip} ${filter === 'favorites' ? styles.filterChipActive : ''}`}
              aria-pressed={filter === 'favorites'}
              onClick={() => setFilter('favorites')}
              data-testid="preset-filter-favorites"
            >
              {vi ? 'Yêu thích' : 'Favorites'}
              {favoriteSet.size > 0 ? ` (${favoriteSet.size})` : ''}
            </button>

            {PRESET_CATEGORIES.map((category) => {
              const active = filter === category;
              return (
                <button
                  key={category}
                  type="button"
                  className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
                  aria-pressed={active}
                  onClick={() => setFilter(category)}
                  data-testid={`preset-filter-${category}`}
                >
                  {CATEGORY_LABELS[category][vi ? 'vi' : 'en']}
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.searchBox}>
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            className={styles.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                setQuery('');
              }
            }}
            placeholder={
              vi
                ? 'Tìm preset theo tên, màu sắc hoặc hiệu ứng...'
                : 'Search presets by name, mood or effect...'
            }
            aria-label={vi ? 'Tìm kiếm preset' : 'Search presets'}
            data-testid="preset-search-input"
          />
        </div>

        {visiblePresets.length === 0 ? (
          <div className={styles.emptyState} data-testid="preset-empty-state">
            <div className={styles.emptyStateIcon} aria-hidden="true">
              {filter === 'favorites' ? <Star size={20} /> : <Waves size={20} />}
            </div>
            <h4 className={styles.emptyStateTitle}>
              {filter === 'favorites'
                ? vi
                  ? 'Chưa có preset yêu thích nào'
                  : 'No favorite presets yet'
                : vi
                  ? 'Không tìm thấy preset phù hợp'
                  : 'No matching presets'}
            </h4>
            <p className={styles.emptyStateDesc}>
              {filter === 'favorites'
                ? vi
                  ? 'Nhấn biểu tượng ngôi sao trên bất kỳ preset nào để ghim vào danh sách yêu thích.'
                  : 'Click the star icon on any preset card to pin it to your favorites.'
                : vi
                  ? 'Thử xóa từ khóa tìm kiếm hoặc chuyển về bộ lọc Tất cả để xem đủ 10 preset.'
                  : 'Clear the search query or switch back to All to browse all 10 presets.'}
            </p>
            <button
              type="button"
              className={`${styles.btnSecondary} ${styles.btnSmall}`}
              onClick={() => {
                setFilter('all');
                setQuery('');
              }}
            >
              {vi ? 'Xem tất cả preset' : 'Show all presets'}
            </button>
          </div>
        ) : (
          <ul className={styles.presetGrid} data-testid="preset-gallery-grid">
            {visiblePresets.map((preset) => {
              const isSelected = selectedPresetId === preset.id;
              const isApplied = appliedSource === 'preset' && appliedThemeId === preset.id;
              const isFav = favoriteSet.has(preset.id);
              const swatch = PRESET_SWATCHES.get(preset.id) ?? previewSwatchCss(preset.config);
              const effectBadge = formatEffectBadge(preset.config.motion.effects, vi);

              return (
                <li
                  key={preset.id}
                  className={`${styles.presetCard} ${isSelected ? styles.presetCardActive : ''}`}
                  style={{ '--card-accent': preset.accentHex } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className={styles.presetCardBtn}
                    aria-pressed={isSelected}
                    onClick={() => onSelectPreset(preset)}
                    data-testid={`preset-card-${preset.id}`}
                  >
                    <div
                      className={styles.presetSwatch}
                      style={{ backgroundImage: swatch }}
                    >
                      <div className={styles.presetSwatchSheen} aria-hidden="true" />
                      <div className={styles.presetBadges}>
                        {isApplied && (
                          <span
                            className={styles.presetActiveBadge}
                            data-testid={`preset-applied-${preset.id}`}
                          >
                            {vi ? 'Đang dùng' : 'In use'}
                          </span>
                        )}
                        <span className={styles.presetTypeBadge}>
                          {GRADIENT_BADGES[preset.config.color.gradientType]}
                        </span>
                        <span className={styles.presetTypeBadge}>{effectBadge}</span>
                      </div>
                    </div>

                    <div className={styles.presetCardBody}>
                      <span className={styles.presetCategory}>
                        {CATEGORY_LABELS[preset.category][vi ? 'vi' : 'en']} ·{' '}
                        {vi
                          ? preset.nameVi
                          : `${preset.config.color.stops.length} stops`}
                      </span>
                      <span className={styles.presetName}>{preset.name}</span>
                      <span className={styles.presetTagline}>
                        {vi ? preset.taglineVi : preset.taglineEn}
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    className={`${styles.presetFavBtn} ${isFav ? styles.presetFavBtnOn : ''}`}
                    aria-pressed={isFav}
                    aria-label={
                      isFav
                        ? vi
                          ? `Bỏ yêu thích ${preset.name}`
                          : `Remove ${preset.name} from favorites`
                        : vi
                          ? `Thêm ${preset.name} vào yêu thích`
                          : `Add ${preset.name} to favorites`
                    }
                    onClick={() => onToggleFavorite(preset.id)}
                    data-testid={`preset-fav-${preset.id}`}
                  >
                    <Star
                      size={14}
                      fill={isFav ? 'currentColor' : 'none'}
                      aria-hidden="true"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
