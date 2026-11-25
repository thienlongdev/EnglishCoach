'use client';

import React, { useMemo } from 'react';
import {
  Activity,
  ArrowRight,
  Eye,
  Flame,
  Layers,
  LayoutTemplate,
  Leaf,
  Moon,
  Pause,
  PauseCircle,
  Play,
  Search,
  Sun,
} from 'lucide-react';
import { estimateBackgroundLuminance } from '@/lib/background-studio/colorScience';
import type { BackgroundThemeConfig, GradientType } from '@/lib/background-studio/types';
import BackgroundThemeLayer from './BackgroundThemeLayer';
import styles from './BackgroundStudio.module.css';

export interface BackgroundLivePreviewProps {
  /** Current draft configuration rendered live without debounce or lag. */
  config: BackgroundThemeConfig;
  /** Display name of the focused preset or custom theme. */
  themeName?: string;
  /** Displays an unsaved amber indicator dot next to the theme name. */
  hasUnsavedChanges?: boolean;
  /** Optional accent hex color for stage rim lighting and mockup accents. */
  accentHex?: string;
  /** Controls visibility of the realistic English Coach UI mockup overlay. */
  showMockup: boolean;
  /** Toggles the English Coach UI mockup overlay. */
  onToggleMockup: () => void;
  /** Switches the mockup surface between Dark Abyss (true) and Light Pearl (false). */
  previewDark: boolean;
  /** Toggles Light or Dark preview surface polarity. */
  onTogglePreviewDark: () => void;
  /** Pauses animated layers inside the preview stage. */
  paused?: boolean;
  /** Optional toggle for pausing or resuming motion playback. */
  onTogglePaused?: () => void;
  /** Enables Eco low-power layer budgeting inside the preview stage. */
  lowPower?: boolean;
  /** Optional toggle for Eco mode. */
  onToggleLowPower?: () => void;
  /** Respects OS prefers-reduced-motion setting. */
  reducedMotion?: boolean;
  /** Activates Live Workspace Preview mode over the real app underneath. */
  onEnterLiveWorkspace?: () => void;
  /** Vietnamese copy when true; English copy when false. */
  vi?: boolean;
}

const GRADIENT_LABELS: Record<GradientType, { vi: string; en: string }> = {
  linear: { vi: 'Tuyến tính', en: 'Linear' },
  radial: { vi: 'Tỏa tròn', en: 'Radial' },
  conic: { vi: 'Xoáy nón', en: 'Conic' },
  mesh: { vi: 'Lưới lỏng', en: 'Mesh' },
};

const FLUENCY_BARS = [
  { height: '38%', on: true },
  { height: '54%', on: true },
  { height: '72%', on: true },
  { height: '86%', on: true },
  { height: '94%', on: true },
  { height: '66%', on: false },
] as const;

/**
 * Expansive live stage viewport for Echo Background Studio.
 * Mounts the real pure-CSS `<BackgroundThemeLayer />` with instantaneous updates on every
 * slider drag, paired with an optional realistic English Coach UI Mockup overlay and a live
 * WCAG 2.1 luminance and contrast readability meter.
 */
export default function BackgroundLivePreview({
  config,
  themeName,
  hasUnsavedChanges = false,
  accentHex,
  showMockup,
  onToggleMockup,
  previewDark,
  onTogglePreviewDark,
  paused = false,
  onTogglePaused,
  lowPower = false,
  onToggleLowPower,
  reducedMotion = false,
  onEnterLiveWorkspace,
  vi = true,
}: BackgroundLivePreviewProps) {
  const luminanceReport = useMemo(() => estimateBackgroundLuminance(config), [config]);

  const readabilityCopy =
    luminanceReport.readability === 'excellent'
      ? vi
        ? 'Độ đọc tuyệt vời'
        : 'Excellent readability'
      : luminanceReport.readability === 'good'
        ? vi
          ? 'Tốt'
          : 'Good'
        : vi
          ? 'Cần cân chỉnh độ tối'
          : 'Adjust contrast';

  const readabilityClass =
    luminanceReport.readability === 'excellent'
      ? styles.readabilityExcellent
      : luminanceReport.readability === 'good'
        ? styles.readabilityGood
        : styles.readabilityCaution;

  const bestContrast =
    luminanceReport.recommendedSurface === 'dark'
      ? luminanceReport.contrastLightText
      : luminanceReport.contrastDarkText;

  const recommendedSurfaceLabel =
    luminanceReport.recommendedSurface === 'dark'
      ? vi
        ? 'Nền tối'
        : 'Dark UI'
      : vi
        ? 'Nền sáng'
        : 'Light UI';

  const luminancePercent = Math.round(luminanceReport.luminance * 100);
  const gradientLabel = GRADIENT_LABELS[config.color.gradientType][vi ? 'vi' : 'en'];
  const stageStyle = accentHex
    ? ({ '--accent': accentHex } as React.CSSProperties)
    : undefined;

  return (
    <div
      className={styles.stageWrap}
      style={stageStyle}
      data-testid="background-live-preview"
    >
      <div className={styles.stageFrame}>
        <div className={styles.stageLayer}>
          <BackgroundThemeLayer
            config={config}
            playing={!paused}
            reducedMotion={reducedMotion}
            lowPower={lowPower}
            previewMode
          />
        </div>

        {/* Top HUD: Theme identity and real-time WCAG readability meter */}
        <div className={styles.stageTopHud}>
          <div className={styles.stageIdentity}>
            <span className={styles.stageSwatchDot} aria-hidden="true" />
            <span className={styles.stageThemeName} title={themeName}>
              {themeName || (vi ? 'Nền tùy chỉnh' : 'Custom background')}
            </span>
            <span className={styles.stageTypeTag}>{gradientLabel}</span>
            {hasUnsavedChanges && (
              <span
                className={styles.stageUnsavedDot}
                title={vi ? 'Có thay đổi chưa lưu' : 'Unsaved changes'}
                aria-label={vi ? 'Có thay đổi chưa lưu' : 'Unsaved changes'}
              />
            )}
          </div>

          <div className={styles.stageTopHudRight}>
            {reducedMotion && (
              <div
                className={styles.reducedMotionPill}
                role="status"
                aria-live="polite"
                title={
                  vi
                    ? 'Hệ thống đang bật Giảm chuyển động (prefers-reduced-motion) — các lớp chuyển động tạm dừng tự động'
                    : 'System prefers reduced motion — animated layers pause automatically'
                }
                data-testid="preview-reduced-motion-badge"
              >
                <PauseCircle size={13} aria-hidden="true" />
                <span>{vi ? 'Giảm chuyển động' : 'Reduced motion'}</span>
              </div>
            )}

            <div
              className={`${styles.readabilityPill} ${readabilityClass}`}
              role="status"
              aria-live="polite"
              title={
                vi
                  ? `Độ sáng tương đối ${luminancePercent}% · Tương phản WCAG tối ưu ${bestContrast.toFixed(1)}:1 (khuyên dùng ${recommendedSurfaceLabel})`
                  : `Relative luminance ${luminancePercent}% · Optimal WCAG contrast ${bestContrast.toFixed(1)}:1 (recommended ${recommendedSurfaceLabel})`
              }
              data-testid="background-readability-pill"
              data-readability={luminanceReport.readability}
            >
              <span className={styles.readabilityDot} aria-hidden="true" />
              <span className={styles.readabilityLabel}>{readabilityCopy}</span>
              <span className={styles.readabilityMetric}>
                L {luminancePercent}% · {bestContrast.toFixed(1)}:1 ({recommendedSurfaceLabel})
              </span>
            </div>
          </div>
        </div>

        {/* Optional realistic English Coach UI Mockup Overlay */}
        {showMockup && (
          <div
            className={`${styles.mockupCanvas} ${previewDark ? styles.mockupDark : ''}`}
            aria-hidden="true"
            data-testid="background-ui-mockup"
            data-surface={previewDark ? 'dark' : 'light'}
          >
            <div className={styles.mockupInner}>
              <div className={styles.mockupHeader}>
                <div className={styles.mockupBreadcrumb}>
                  <span className={styles.mockupBrandDot} />
                  <span>English Coach</span>
                  <span>/</span>
                  <span className={styles.mockupCrumbActive}>
                    {vi ? 'Tổng quan học tập' : 'Learning Dashboard'}
                  </span>
                </div>
                <div className={styles.mockupHeaderRight}>
                  <span className={styles.mockupMiniPill}>IELTS 7.5</span>
                  <span className={styles.mockupAvatar} />
                </div>
              </div>

              <div className={styles.mockupPlateRow}>
                <div className={styles.mockupPlate}>
                  <span className={styles.mockupEyebrow}>
                    {vi ? 'Không gian tập trung' : 'Focus workspace'}
                  </span>
                  <p className={styles.mockupHeading}>
                    {vi ? 'Chào buổi tối, giữ vững nhịp học' : 'Good evening, keep your momentum'}
                  </p>
                </div>
              </div>

              <div className={styles.mockupSearchRow}>
                <div className={styles.mockupSearch}>
                  <Search size={13} />
                  <span>
                    {vi
                      ? 'Tìm bộ thẻ từ vựng, bài đọc hoặc đề thi thử...'
                      : 'Search vocabulary decks, readings or mock exams...'}
                  </span>
                </div>
                <div className={styles.mockupCta}>
                  <span>{vi ? 'Học ngay' : 'Start now'}</span>
                  <ArrowRight size={13} />
                </div>
              </div>

              <div className={styles.mockupGrid}>
                <div className={styles.mockupCard}>
                  <div className={styles.mockupCardHead}>
                    <span>{vi ? 'Chuỗi học tập' : 'Study Streak'}</span>
                    <Flame size={13} />
                  </div>
                  <span className={styles.mockupCardValue}>
                    {vi ? '14 ngày' : '14 days'}
                  </span>
                  <div className={styles.mockupProgressTrack}>
                    <div className={styles.mockupProgressFill} style={{ width: '82%' }} />
                  </div>
                  <span className={styles.mockupCardFoot}>
                    {vi ? 'Vượt 82% mục tiêu tuần' : '82% of weekly goal'}
                  </span>
                </div>

                <div className={styles.mockupCard}>
                  <div className={styles.mockupCardHead}>
                    <span>{vi ? 'Thẻ ghi nhớ' : 'Flashcards'}</span>
                    <Layers size={13} />
                  </div>
                  <span className={styles.mockupCardValue}>
                    {vi ? '32 thẻ' : '32 cards'}
                  </span>
                  <div className={styles.mockupProgressTrack}>
                    <div className={styles.mockupProgressFill} style={{ width: '75%' }} />
                  </div>
                  <span className={styles.mockupCardFoot}>
                    {vi ? 'Đã ôn 24 trên 32 thẻ' : '24 of 32 reviewed'}
                  </span>
                </div>

                <div className={styles.mockupCard}>
                  <div className={styles.mockupCardHead}>
                    <span>{vi ? 'Trôi chảy IELTS' : 'IELTS Fluency'}</span>
                    <Activity size={13} />
                  </div>
                  <span className={styles.mockupCardValue}>Band 7.5</span>
                  <div className={styles.mockupMeterBars}>
                    {FLUENCY_BARS.map((bar, index) => (
                      <span
                        key={index}
                        className={`${styles.mockupMeterBar} ${bar.on ? styles.mockupMeterBarOn : ''}`}
                        style={{ height: bar.height }}
                      />
                    ))}
                  </div>
                  <span className={styles.mockupCardFoot}>
                    {vi ? 'Ngữ điệu và phát âm ổn định' : 'Steady rhythm and clarity'}
                  </span>
                </div>
              </div>

              <div className={styles.mockupParagraph}>
                <strong>{vi ? 'Kiểm tra độ rõ chữ:' : 'Typography check:'}</strong>{' '}
                {vi
                  ? 'Tiêu đề, thẻ bài học và đoạn văn giữ độ tương phản sắc nét trên nền màu đang chọn để bạn đọc hiểu và luyện thi thoải mái.'
                  : 'Headings, learning cards and reading copy stay crisp over your custom atmosphere for comfortable long study sessions.'}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating Quick Controls Bar (overlaid bottom-center on desktop; docked below preview on <=640px mobile) */}
      <div
        className={styles.stageQuickBar}
        role="toolbar"
        aria-label={vi ? 'Tùy chọn xem trước' : 'Preview controls'}
      >
        <button
          type="button"
          className={`${styles.quickBtn} ${showMockup ? styles.quickBtnOn : ''}`}
          aria-pressed={showMockup}
          onClick={onToggleMockup}
          data-testid="preview-toggle-mockup"
        >
          <LayoutTemplate size={14} aria-hidden="true" />
          <span>{vi ? 'Giao diện mẫu' : 'UI Mockup'}</span>
        </button>

        <button
          type="button"
          className={`${styles.quickBtn} ${previewDark ? styles.quickBtnOn : ''}`}
          aria-pressed={previewDark}
          aria-label={
            previewDark
              ? vi
                ? 'Đang xem bề mặt nền tối — nhấn để chuyển sang nền sáng'
                : 'Previewing Dark UI surface — activate to switch to Light UI'
              : vi
                ? 'Đang xem bề mặt nền sáng — nhấn để chuyển sang nền tối'
                : 'Previewing Light UI surface — activate to switch to Dark UI'
          }
          onClick={onTogglePreviewDark}
          title={
            vi
              ? 'Chuyển bề mặt thẻ xem trước giữa Sáng và Tối'
              : 'Switch preview card surface between Light and Dark'
          }
          data-testid="preview-toggle-surface"
        >
          {previewDark ? (
            <Moon size={14} aria-hidden="true" />
          ) : (
            <Sun size={14} aria-hidden="true" />
          )}
          <span>{previewDark ? (vi ? 'Nền tối' : 'Dark UI') : vi ? 'Nền sáng' : 'Light UI'}</span>
        </button>

        {onToggleLowPower && (
          <button
            type="button"
            className={`${styles.quickBtn} ${lowPower ? styles.quickBtnOn : ''}`}
            aria-pressed={lowPower}
            aria-label={
              lowPower
                ? vi
                  ? 'Tắt chế độ tiết kiệm pin và GPU (Eco)'
                  : 'Disable Eco battery and GPU saving mode'
                : vi
                  ? 'Bật chế độ tiết kiệm pin và GPU (Eco)'
                  : 'Enable Eco battery and GPU saving mode'
            }
            onClick={onToggleLowPower}
            title={
              vi
                ? 'Chế độ tiết kiệm pin và GPU'
                : 'Eco battery and GPU saving mode'
            }
            data-testid="preview-toggle-eco"
          >
            <Leaf size={14} aria-hidden="true" />
            <span>{vi ? 'Tiết kiệm' : 'Eco'}</span>
          </button>
        )}

        {onTogglePaused && (
          <button
            type="button"
            className={`${styles.quickBtn} ${paused || reducedMotion ? styles.quickBtnOn : ''}`}
            aria-pressed={paused || reducedMotion}
            disabled={reducedMotion}
            aria-label={
              reducedMotion
                ? vi
                  ? 'Chuyển động đang tạm dừng theo cài đặt Giảm chuyển động của hệ thống'
                  : 'Motion paused by system reduced-motion preference'
                : paused
                  ? vi
                    ? 'Tiếp tục chuyển động xem trước'
                    : 'Resume preview motion'
                  : vi
                    ? 'Tạm dừng chuyển động xem trước'
                    : 'Pause preview motion'
            }
            onClick={onTogglePaused}
            title={
              reducedMotion
                ? vi
                  ? 'Đang bật Giảm chuyển động hệ thống'
                  : 'Paused by system prefers-reduced-motion'
                : paused
                  ? vi
                    ? 'Tiếp tục chuyển động'
                    : 'Resume motion'
                  : vi
                    ? 'Tạm dừng chuyển động'
                    : 'Pause motion'
            }
            data-testid="preview-toggle-pause"
          >
            {paused && !reducedMotion ? (
              <Play size={14} aria-hidden="true" />
            ) : (
              <Pause size={14} aria-hidden="true" />
            )}
            <span>
              {reducedMotion
                ? vi
                  ? 'Tĩnh'
                  : 'Still'
                : paused
                  ? vi
                    ? 'Phát'
                    : 'Play'
                  : vi
                    ? 'Dừng'
                    : 'Pause'}
            </span>
          </button>
        )}

        {onEnterLiveWorkspace && (
          <>
            <span className={styles.quickDivider} aria-hidden="true" />
            <button
              type="button"
              className={`${styles.quickBtn} ${styles.quickBtnAccent}`}
              onClick={onEnterLiveWorkspace}
              data-testid="preview-enter-live-workspace"
            >
              <Eye size={14} aria-hidden="true" />
              <span>{vi ? 'Xem trên giao diện thực tế' : 'Live Workspace'}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
