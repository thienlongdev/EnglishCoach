'use client';

import React, { useMemo, useRef, useState } from 'react';
import {
  BookmarkPlus,
  Check,
  Cloud,
  Copy,
  HardDrive,
  Palette,
  Pencil,
  RotateCcw,
  Save,
  Shuffle,
  Sliders,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { previewSwatchCss } from '@/lib/background-studio/cssRenderer';
import {
  MAX_CUSTOM_THEMES,
  MAX_THEME_NAME_LENGTH,
  type BackgroundActiveSource,
  type SavedBackgroundTheme,
} from '@/lib/background-studio/types';
import styles from './BackgroundStudio.module.css';

export interface MyThemesSyncState {
  state: 'idle' | 'saving' | 'saved' | 'error';
  message?: string;
}

export interface MyThemesPanelProps {
  /** Saved custom themes belonging to the current account. */
  customThemes: readonly SavedBackgroundTheme[];
  /** Currently active workspace background source. */
  activeSource: BackgroundActiveSource;
  /** Currently active workspace theme/preset ID. */
  activeThemeId: string | null;
  /** ID of the custom theme currently loaded in the studio editor, if any. */
  editingThemeId: string | null;
  /** Controlled theme name input shared with studio footer Save. */
  themeNameDraft: string;
  /** True when the learner is signed into an account (enables server sync). */
  signedIn: boolean;
  /** Live sync status from the background preferences store. */
  syncStatus: MyThemesSyncState;
  /** Updates controlled theme name draft. */
  onChangeThemeNameDraft: (name: string) => void;
  /** Generates a curated harmonious OKLCH random background in Live Preview. */
  onRandomize: () => void;
  /** Restores the original English Coach Echo Ocean default background. */
  onRestoreDefault: () => void;
  /** Saves current draft as a new theme or updates the currently edited theme; returns error message or null. */
  onSaveCurrent: (opts: { asNew: boolean }) => string | null;
  /** Loads a saved custom theme into the studio live preview without mutating the active workspace. */
  onPreviewTheme: (theme: SavedBackgroundTheme) => void;
  /** Selects and immediately applies a saved custom theme to the workspace. */
  onSelectAndApplyTheme: (theme: SavedBackgroundTheme) => void;
  /** Loads a saved custom theme into the Color Studio tab for editing. */
  onEditTheme: (theme: SavedBackgroundTheme) => void;
  /** Renames a saved custom theme inline; returns validation error or null. */
  onRenameTheme: (themeId: string, nextName: string) => string | null;
  /** Duplicates a saved custom theme; returns error message or null. */
  onDuplicateTheme: (themeId: string) => string | null;
  /** Deletes a saved custom theme cleanly. */
  onDeleteTheme: (themeId: string) => void;
  /** Toggles favorite star state on a saved custom theme. */
  onToggleFavoriteTheme: (themeId: string) => void;
  /** Vietnamese UI copy when true; English UI copy when false. */
  vi: boolean;
}

type ThemeFilter = 'all' | 'favorites';

function formatTimestamp(iso: string, vi: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-US', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return '';
  }
}

/**
 * Tab 4 — My Themes Library for Echo Background Studio.
 * Provides harmonious OKLCH randomization, Echo Ocean default restoration,
 * save/update form with 40-theme quota, inline rename, duplicate, favorite,
 * inline delete confirmation, and account sync indicator.
 */
export default function MyThemesPanel({
  customThemes,
  activeSource,
  activeThemeId,
  editingThemeId,
  themeNameDraft,
  signedIn,
  syncStatus,
  onChangeThemeNameDraft,
  onRandomize,
  onRestoreDefault,
  onSaveCurrent,
  onPreviewTheme,
  onSelectAndApplyTheme,
  onEditTheme,
  onRenameTheme,
  onDuplicateTheme,
  onDeleteTheme,
  onToggleFavoriteTheme,
  vi,
}: MyThemesPanelProps) {
  const [filter, setFilter] = useState<ThemeFilter>('all');
  const [formError, setFormError] = useState<string | null>(null);
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const renameTriggerRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const deleteTriggerRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  const editingTheme = useMemo(
    () => (editingThemeId ? customThemes.find((t) => t.id === editingThemeId) ?? null : null),
    [customThemes, editingThemeId],
  );

  const favoriteCount = useMemo(
    () => customThemes.filter((t) => t.favorite).length,
    [customThemes],
  );

  const visibleThemes = useMemo(
    () => (filter === 'favorites' ? customThemes.filter((t) => t.favorite) : customThemes),
    [customThemes, filter],
  );

  const atLimit = customThemes.length >= MAX_CUSTOM_THEMES;

  const handleSaveAction = (asNew: boolean) => {
    setFormError(null);
    setFeedbackNotice(null);
    const error = onSaveCurrent({ asNew });
    if (error) {
      setFormError(error);
      return;
    }
    setFeedbackNotice(
      asNew
        ? signedIn
          ? vi
            ? 'Đã lưu theme mới và đồng bộ vào tài khoản.'
            : 'Saved new theme and synced to your account.'
          : vi
            ? 'Đã lưu theme mới trên thiết bị này.'
            : 'Saved new theme on this device.'
        : signedIn
          ? vi
            ? 'Đã cập nhật theme và đồng bộ vào tài khoản.'
            : 'Updated theme and synced to your account.'
          : vi
            ? 'Đã cập nhật theme trên thiết bị này.'
            : 'Updated theme on this device.',
    );
  };

  const startRename = (theme: SavedBackgroundTheme) => {
    setConfirmDeleteId(null);
    setRenamingId(theme.id);
    setRenameValue(theme.name);
    setRenameError(null);
  };

  const cancelRename = (themeId: string) => {
    setRenamingId(null);
    setRenameError(null);
    window.setTimeout(() => {
      renameTriggerRefs.current.get(themeId)?.focus();
    }, 0);
  };

  const commitRename = (themeId: string) => {
    const error = onRenameTheme(themeId, renameValue);
    if (error) {
      setRenameError(error);
      return;
    }
    setRenamingId(null);
    setRenameValue('');
    setRenameError(null);
    window.setTimeout(() => {
      renameTriggerRefs.current.get(themeId)?.focus();
    }, 0);
  };

  const cancelDeleteConfirm = (themeId: string) => {
    setConfirmDeleteId(null);
    window.setTimeout(() => {
      deleteTriggerRefs.current.get(themeId)?.focus();
    }, 0);
  };

  const handleDuplicate = (themeId: string) => {
    setFormError(null);
    setFeedbackNotice(null);
    const error = onDuplicateTheme(themeId);
    if (error) {
      setFormError(error);
    }
  };

  return (
    <>
      {/* Top Hero Toolbar: Harmonious Randomize & Restore Default */}
      <section
        className={styles.sectionCard}
        aria-label={vi ? 'Công cụ tạo nhanh' : 'Quick composition tools'}
      >
        <div className={styles.sectionHead}>
          <div>
            <h3 className={styles.sectionTitle}>
              {vi ? 'Khởi tạo nhanh và Khôi phục' : 'Quick Creation and Restore'}
            </h3>
            <p className={styles.sectionHint}>
              {vi
                ? 'Tạo bảng màu OKLCH hài hòa ngẫu nhiên để xem trước ngay hoặc trở về nền Echo Ocean mặc định.'
                : 'Generate a curated harmonious OKLCH theme in Live Preview or restore the default Echo Ocean look.'}
            </p>
          </div>
        </div>

        <div className={styles.inlineRow}>
          <button
            type="button"
            className={`${styles.btnAccent} ${styles.btnSmall}`}
            onClick={() => {
              setFormError(null);
              setFeedbackNotice(null);
              onRandomize();
            }}
            data-testid="my-themes-randomize-btn"
          >
            <Shuffle size={14} aria-hidden="true" />
            <span>{vi ? 'Phối màu ngẫu nhiên hài hòa' : 'Harmonious Randomize'}</span>
          </button>

          <button
            type="button"
            className={`${styles.btnSecondary} ${styles.btnSmall}`}
            onClick={() => {
              setFormError(null);
              setFeedbackNotice(null);
              onRestoreDefault();
            }}
            data-testid="my-themes-restore-default-btn"
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span>{vi ? 'Khôi phục mặc định' : 'Restore Default'}</span>
          </button>
        </div>
      </section>

      {/* Save Current Creation Form + Account Sync Status */}
      <section
        className={styles.sectionCard}
        aria-label={vi ? 'Lưu nền hiện tại' : 'Save current background'}
      >
        <div className={styles.sectionHead}>
          <div>
            <h3 className={styles.sectionTitle}>
              {editingTheme
                ? vi
                  ? `Lưu chỉnh sửa cho "${editingTheme.name}"`
                  : `Save edits for "${editingTheme.name}"`
                : vi
                  ? 'Lưu thiết kế hiện tại vào Theme của tôi'
                  : 'Save Current Creation to My Themes'}
            </h3>
            <p className={styles.sectionHint}>
              {signedIn
                ? vi
                  ? 'Đã đăng nhập — thư viện theme và mục yêu thích tự động đồng bộ qua tài khoản trên mọi thiết bị.'
                  : 'Signed in — your saved themes and favorites sync automatically across your devices.'
                : vi
                  ? 'Chế độ khách — theme được lưu trên thiết bị này. Đăng nhập để đồng bộ qua tài khoản.'
                  : 'Guest mode — saved locally on this device. Sign in to sync across devices.'}
            </p>
          </div>
          <span className={styles.themeCountPill} data-testid="my-themes-count-pill">
            {customThemes.length} / {MAX_CUSTOM_THEMES}
          </span>
        </div>

        <form
          className={styles.saveForm}
          onSubmit={(event) => {
            event.preventDefault();
            handleSaveAction(!editingTheme);
          }}
        >
          <input
            type="text"
            className={styles.inputText}
            value={themeNameDraft}
            maxLength={MAX_THEME_NAME_LENGTH}
            onChange={(event) => {
              onChangeThemeNameDraft(event.target.value);
              setFormError(null);
            }}
            placeholder={
              vi ? 'Đặt tên cho theme (ví dụ: Đêm Ngọc Trai)...' : 'Name this theme (e.g. Pearl Midnight)...'
            }
            aria-label={vi ? 'Tên theme tùy chỉnh' : 'Custom theme name'}
            data-testid="my-themes-name-input"
          />

          {editingTheme ? (
            <>
              <button
                type="submit"
                className={`${styles.btnPrimary} ${styles.btnSmall}`}
                data-testid="my-themes-update-btn"
              >
                <Save size={13} aria-hidden="true" />
                <span>{vi ? 'Cập nhật' : 'Update'}</span>
              </button>
              <button
                type="button"
                className={`${styles.btnSecondary} ${styles.btnSmall}`}
                disabled={atLimit}
                onClick={() => handleSaveAction(true)}
                data-testid="my-themes-save-as-new-btn"
              >
                <BookmarkPlus size={13} aria-hidden="true" />
                <span>{vi ? 'Lưu mới' : 'Save New'}</span>
              </button>
            </>
          ) : (
            <button
              type="submit"
              className={`${styles.btnPrimary} ${styles.btnSmall}`}
              disabled={atLimit}
              data-testid="my-themes-save-btn"
            >
              <Save size={13} aria-hidden="true" />
              <span>{vi ? 'Lưu theme' : 'Save Theme'}</span>
            </button>
          )}
        </form>

        {atLimit && !editingTheme && (
          <p className={styles.inputError} role="status" data-testid="my-themes-limit-warning">
            {vi
              ? `Bạn đã đạt giới hạn ${MAX_CUSTOM_THEMES} theme tùy chỉnh. Hãy xóa bớt một theme trước khi lưu mới.`
              : `You have reached the ${MAX_CUSTOM_THEMES}-theme limit. Delete one before saving a new theme.`}
          </p>
        )}

        {formError && (
          <p className={styles.inputError} role="alert" data-testid="my-themes-form-error">
            {formError}
          </p>
        )}

        {feedbackNotice && (
          <div className={styles.successBanner} role="status" data-testid="my-themes-feedback">
            <Check size={14} aria-hidden="true" />
            <span>{feedbackNotice}</span>
          </div>
        )}

        {/* Account sync indicator pill */}
        <div className={styles.inlineRow}>
          <span
            className={`${styles.gpuBudgetPill} ${
              syncStatus.state === 'error'
                ? styles.gpuBudgetRich
                : signedIn
                  ? styles.gpuBudgetMinimal
                  : styles.gpuBudgetBalanced
            }`}
            data-testid="my-themes-sync-pill"
          >
            {signedIn ? (
              <Cloud size={12} aria-hidden="true" />
            ) : (
              <HardDrive size={12} aria-hidden="true" />
            )}
            <span>
              {syncStatus.state === 'saving'
                ? vi
                  ? 'Đang đồng bộ tài khoản...'
                  : 'Syncing to account...'
                : syncStatus.state === 'error'
                  ? syncStatus.message ||
                    (vi
                      ? 'Đã lưu tạm trên thiết bị — sẽ đồng bộ lại khi có kết nối'
                      : 'Saved locally — will retry sync when online')
                  : signedIn
                    ? vi
                      ? 'Đã đồng bộ tài khoản'
                      : 'Synced to account'
                    : vi
                      ? 'Lưu cục bộ trên thiết bị này'
                      : 'Saved on this device'}
            </span>
          </span>
        </div>
      </section>

      {/* Saved Themes Filter & List */}
      <section
        className={styles.sectionCard}
        aria-label={vi ? 'Danh sách Theme của tôi' : 'My saved themes list'}
      >
        <div className={styles.myThemesToolbar}>
          <div
            className={styles.chipRow}
            role="group"
            aria-label={vi ? 'Lọc theme của tôi' : 'Filter my themes'}
          >
            <button
              type="button"
              className={`${styles.filterChip} ${filter === 'all' ? styles.filterChipActive : ''}`}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
              data-testid="my-themes-filter-all"
            >
              {vi ? 'Tất cả' : 'All'} ({customThemes.length})
            </button>
            <button
              type="button"
              className={`${styles.filterChip} ${
                filter === 'favorites' ? styles.filterChipActive : ''
              }`}
              aria-pressed={filter === 'favorites'}
              onClick={() => setFilter('favorites')}
              data-testid="my-themes-filter-favorites"
            >
              {vi ? 'Yêu thích' : 'Favorites'} ({favoriteCount})
            </button>
          </div>
        </div>

        {visibleThemes.length === 0 ? (
          <div className={styles.emptyState} data-testid="my-themes-empty">
            <div className={styles.emptyStateIcon} aria-hidden="true">
              {filter === 'favorites' ? <Star size={20} /> : <Palette size={20} />}
            </div>
            <h4 className={styles.emptyStateTitle}>
              {filter === 'favorites'
                ? vi
                  ? 'Chưa có theme yêu thích nào'
                  : 'No favorite themes yet'
                : vi
                  ? 'Chưa có theme tùy chỉnh nào được lưu'
                  : 'No saved themes yet'}
            </h4>
            <p className={styles.emptyStateDesc}>
              {filter === 'favorites'
                ? vi
                  ? 'Đánh dấu ngôi sao cho những phối màu bạn yêu thích nhất để mở lại nhanh chóng.'
                  : 'Star your favorite custom creations to find them quickly anytime.'
                : vi
                  ? 'Hãy tinh chỉnh màu sắc hoặc nhấn Phối màu ngẫu nhiên hài hòa rồi lưu lại thành bộ sưu tập riêng của bạn.'
                  : 'Customize colors or try Harmonious Randomize, then save your composition to build your personal gallery.'}
            </p>
            {filter === 'favorites' ? (
              <button
                type="button"
                className={`${styles.btnSecondary} ${styles.btnSmall}`}
                onClick={() => setFilter('all')}
              >
                {vi ? 'Xem tất cả theme đã lưu' : 'Show all saved themes'}
              </button>
            ) : (
              <button
                type="button"
                className={`${styles.btnAccent} ${styles.btnSmall}`}
                onClick={onRandomize}
              >
                <Shuffle size={13} aria-hidden="true" />
                <span>{vi ? 'Thử phối màu ngẫu nhiên' : 'Try harmonious randomize'}</span>
              </button>
            )}
          </div>
        ) : (
          <ul className={styles.myThemeList} data-testid="my-themes-list">
            {visibleThemes.map((theme) => {
              const isApplied = activeSource === 'custom' && activeThemeId === theme.id;
              const isEditing = editingThemeId === theme.id;
              const isRenaming = renamingId === theme.id;
              const isConfirmingDelete = confirmDeleteId === theme.id;
              const swatch = previewSwatchCss(theme.config);
              const updatedText = formatTimestamp(theme.updatedAt, vi);

              return (
                <li
                  key={theme.id}
                  className={`${styles.myThemeCard} ${
                    isApplied || isEditing ? styles.myThemeCardActive : ''
                  }`}
                  style={{ flexDirection: 'column', alignItems: 'stretch', gap: 9 }}
                  data-testid={`my-theme-card-${theme.id}`}
                >
                  <div className={styles.inlineRow} style={{ flexWrap: 'nowrap' }}>
                    <button
                      type="button"
                      className={styles.myThemeSelectBtn}
                      aria-label={vi ? `Xem trước theme ${theme.name}` : `Preview theme ${theme.name}`}
                      onClick={() => onPreviewTheme(theme)}
                      disabled={isRenaming}
                      data-testid={`my-theme-select-${theme.id}`}
                    >
                      <div
                        className={styles.myThemeSwatch}
                        style={{ backgroundImage: swatch }}
                        aria-hidden="true"
                      />
                      <div className={styles.myThemeMeta}>
                        {!isRenaming && (
                          <>
                            <div className={styles.inlineRow} style={{ gap: 6 }}>
                              <span className={styles.myThemeName} title={theme.name}>
                                {theme.name}
                              </span>
                              {isApplied && (
                                <span
                                  className={styles.presetActiveBadge}
                                  data-testid={`my-theme-active-${theme.id}`}
                                >
                                  {vi ? 'Đang dùng' : 'In use'}
                                </span>
                              )}
                            </div>
                            <span className={styles.myThemeDate}>
                              {theme.config.color.gradientType.toUpperCase()} ·{' '}
                              {theme.config.color.stops.length}{' '}
                              {vi ? 'màu' : 'stops'}
                              {updatedText ? ` · ${updatedText}` : ''}
                            </span>
                          </>
                        )}
                      </div>
                    </button>

                    <button
                      type="button"
                      className={`${styles.btnIcon} ${theme.favorite ? styles.btnIconActive : ''}`}
                      aria-pressed={theme.favorite}
                      aria-label={
                        theme.favorite
                          ? vi
                            ? `Bỏ yêu thích ${theme.name}`
                            : `Unfavorite ${theme.name}`
                          : vi
                            ? `Yêu thích ${theme.name}`
                            : `Favorite ${theme.name}`
                      }
                      onClick={() => onToggleFavoriteTheme(theme.id)}
                      data-testid={`my-theme-fav-${theme.id}`}
                    >
                      <Star
                        size={14}
                        fill={theme.favorite ? 'currentColor' : 'none'}
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  {/* Inline Rename form */}
                  {isRenaming && (
                    <div className={styles.channelField}>
                      <div className={styles.saveForm}>
                        <input
                          type="text"
                          className={styles.myThemeRenameInput}
                          value={renameValue}
                          maxLength={MAX_THEME_NAME_LENGTH}
                          onChange={(event) => {
                            setRenameValue(event.target.value);
                            setRenameError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              commitRename(theme.id);
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              event.stopPropagation();
                              cancelRename(theme.id);
                            }
                          }}
                          aria-label={vi ? 'Đổi tên theme' : 'Rename theme'}
                          autoFocus
                          data-testid={`my-theme-rename-input-${theme.id}`}
                        />
                        <button
                          type="button"
                          className={`${styles.btnPrimary} ${styles.btnSmall}`}
                          onClick={() => commitRename(theme.id)}
                          data-testid={`my-theme-rename-save-${theme.id}`}
                        >
                          <Check size={13} aria-hidden="true" />
                          <span>{vi ? 'Lưu' : 'Save'}</span>
                        </button>
                        <button
                          type="button"
                          className={`${styles.btnGhost} ${styles.btnSmall}`}
                          onClick={() => cancelRename(theme.id)}
                          aria-label={vi ? 'Hủy đổi tên' : 'Cancel rename'}
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      </div>
                      {renameError && (
                        <p className={styles.inputError} role="alert">
                          {renameError}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Inline Delete confirmation */}
                  {isConfirmingDelete ? (
                    <div
                      className={styles.myThemesToolbar}
                      role="alert"
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          cancelDeleteConfirm(theme.id);
                        }
                      }}
                      data-testid={`my-theme-delete-confirm-${theme.id}`}
                    >
                      <span className={styles.inputError}>
                        {vi ? `Xóa "${theme.name}"?` : `Delete "${theme.name}"?`}
                      </span>
                      <div className={styles.inlineRow}>
                        <button
                          type="button"
                          className={`${styles.btnDanger} ${styles.btnSmall}`}
                          onClick={() => {
                            setConfirmDeleteId(null);
                            onDeleteTheme(theme.id);
                          }}
                          data-testid={`my-theme-delete-yes-${theme.id}`}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                          <span>{vi ? 'Xác nhận xóa' : 'Confirm Delete'}</span>
                        </button>
                        <button
                          type="button"
                          className={`${styles.btnGhost} ${styles.btnSmall}`}
                          autoFocus
                          onClick={() => cancelDeleteConfirm(theme.id)}
                          data-testid={`my-theme-delete-no-${theme.id}`}
                        >
                          {vi ? 'Hủy' : 'Cancel'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    !isRenaming && (
                      <div className={styles.myThemesToolbar}>
                        <div className={styles.inlineRow}>
                          <button
                            type="button"
                            className={`${styles.btnPrimary} ${styles.btnSmall}`}
                            onClick={() => onSelectAndApplyTheme(theme)}
                            data-testid={`my-theme-apply-${theme.id}`}
                          >
                            <Check size={13} aria-hidden="true" />
                            <span>{vi ? 'Áp dụng' : 'Apply'}</span>
                          </button>
                          <button
                            type="button"
                            className={`${styles.btnSecondary} ${styles.btnSmall}`}
                            onClick={() => onEditTheme(theme)}
                            data-testid={`my-theme-edit-${theme.id}`}
                          >
                            <Sliders size={13} aria-hidden="true" />
                            <span>{vi ? 'Chỉnh sửa' : 'Edit'}</span>
                          </button>
                        </div>

                        <div className={styles.myThemeActions}>
                          <button
                            ref={(node) => {
                              if (node) {
                                renameTriggerRefs.current.set(theme.id, node);
                              } else {
                                renameTriggerRefs.current.delete(theme.id);
                              }
                            }}
                            type="button"
                            className={styles.btnIcon}
                            title={vi ? 'Đổi tên' : 'Rename'}
                            aria-label={vi ? `Đổi tên ${theme.name}` : `Rename ${theme.name}`}
                            onClick={() => startRename(theme)}
                            data-testid={`my-theme-rename-${theme.id}`}
                          >
                            <Pencil size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className={styles.btnIcon}
                            disabled={atLimit}
                            title={
                              atLimit
                                ? vi
                                  ? `Đã đạt giới hạn ${MAX_CUSTOM_THEMES} theme`
                                  : `Reached ${MAX_CUSTOM_THEMES}-theme limit`
                                : vi
                                  ? 'Nhân bản'
                                  : 'Duplicate'
                            }
                            aria-label={vi ? `Nhân bản ${theme.name}` : `Duplicate ${theme.name}`}
                            onClick={() => handleDuplicate(theme.id)}
                            data-testid={`my-theme-duplicate-${theme.id}`}
                          >
                            <Copy size={14} aria-hidden="true" />
                          </button>
                          <button
                            ref={(node) => {
                              if (node) {
                                deleteTriggerRefs.current.set(theme.id, node);
                              } else {
                                deleteTriggerRefs.current.delete(theme.id);
                              }
                            }}
                            type="button"
                            className={`${styles.btnIcon} ${styles.btnIconDanger}`}
                            title={vi ? 'Xóa theme' : 'Delete theme'}
                            aria-label={vi ? `Xóa ${theme.name}` : `Delete ${theme.name}`}
                            onClick={() => {
                              setRenamingId(null);
                              setConfirmDeleteId(theme.id);
                            }}
                            data-testid={`my-theme-delete-${theme.id}`}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
