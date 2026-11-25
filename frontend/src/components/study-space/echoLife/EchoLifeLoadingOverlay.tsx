'use client';

import { useEffect, useId, useState, type CSSProperties } from 'react';
import { AlertCircle, Check, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { echoSrc } from '@/lib/brand/echoCharacters';
import { pointerLight } from '@/lib/ui/pointerLight';
import {
  BOOT_STAGE_INDEX_BY_ID,
  BOOT_STAGE_LABELS_VI,
  ECHO_LIFE_BOOT_STAGES,
  resolveBootStageId,
  type EchoLifeBootStageId,
  type EchoLifeBootStageSpec,
} from './echoLifeBootStages';
import s from './echoLifeLoading.module.css';

const WARMED_KEY = 'ec_echo_life_warmed_v1';

/**
 * Canonical 5-stage Vietnamese pre-entry progress sequence (TASK 1 §11.2, sourced from `./echoLifeBootStages`):
 * - preparing: Đang chuẩn bị Không gian học tập
 * - assets:    Đang tải môi trường và nhân vật
 * - graphics:  Đang tối ưu đồ họa
 * - sync:      Đang đồng bộ thế giới
 * - ready:     Sắp sẵn sàng khám phá
 */
export { ECHO_LIFE_BOOT_STAGES, resolveBootStageId };
export type { EchoLifeBootStageId, EchoLifeBootStageSpec };

const PRE_ENTRY_TIPS_VI: readonly string[] = [
  'Sau khi bước vào thị trấn Echo Life, toàn bộ hội thoại và giao diện trong thế giới sẽ dùng tiếng Anh để bạn thực hành tự nhiên.',
  'Dùng phím WASD để di chuyển, giữ Shift để chạy nhanh và nhấn Space để nhảy.',
  'Nhấn E khi đứng gần cư dân, xe đạp, ô tô, ghế ngồi, quầy hàng hoặc cửa ra vào để tương tác.',
  'Nhấn M bất cứ lúc nào để mở hoặc thu gọn bản đồ 31 khu vực của Riverside.',
  'Ghé Sunrise Market, Pixel Café hoặc bảng Greenway Delivery để nhận ca làm thêm và tích lũy Campus Credits.',
];

export interface EchoLifeLoadingOverlayProps {
  /** 0..100 determinate progress computed from real boot milestones. */
  progress: number;
  /** Optional stage label (legacy callers may pass English text; always mapped cleanly to Vietnamese pre-entry copy). */
  stage?: string;
  /** Canonical stage id emitted by EchoLifeBootOrchestrator. */
  stageId?: EchoLifeBootStageId;
  /** Optional real Vietnamese sub-detail (for example, `14/28 tệp môi trường` or shader readiness note). */
  detailVi?: string | null;
  /** Optional slow-load watchdog notice shown after 20 s or 60 s without visible progress. */
  slowNoticeVi?: string | null;
  /** True when the 60 s no-progress watchdog offers explicit user choices (never force-dismisses!). */
  slowState?: boolean;
  /** True when running Gate 1 (World) transition overlay after clicking Explore from Overview mode. */
  transitionMode?: boolean;
  /** Optional quick callback to switch graphics preset to Low-Spec mode. */
  onLowSpec?: () => void;
  /** User choice when `slowState` is active: keep waiting and reset watchdog. */
  onContinueWaiting?: () => void;
  /** User opt-in bypass when `slowState` is active (enters without writing `ec_echo_life_warmed_v1`). */
  onEnterNow?: () => void;
  /** Current graphics preset if known. */
  quality?: 'ultra' | 'high' | 'balanced' | 'low';
  /** Smooth dissolve-out state right before unmount once the 3D world has rendered steady frames. */
  exiting?: boolean;
  /** Recoverable Vietnamese error message if initialization stalls or WebGL fails. */
  errorVi?: string | null;
  /** Retry handler shown when errorVi is present. */
  onRetry?: () => void;
  /** Optional escape hatch back to the main dashboard on error. */
  onBackToDashboard?: () => void;
}

const RING_RADIUS = 29;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function EchoLifeLoadingOverlay({
  progress,
  stage,
  stageId,
  detailVi,
  slowNoticeVi = null,
  slowState = false,
  transitionMode = false,
  onLowSpec,
  onContinueWaiting,
  onEnterNow,
  quality,
  exiting = false,
  errorVi = null,
  onRetry,
  onBackToDashboard,
}: EchoLifeLoadingOverlayProps) {
  const gradId = useId();
  const [firstVisit, setFirstVisit] = useState(true);
  const [tipIndex, setTipIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    try {
      setFirstVisit(!localStorage.getItem(WARMED_KEY));
    } catch {
      setFirstVisit(true);
    }

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const tipTimer = reducedMotion
      ? null
      : window.setInterval(() => setTipIndex(i => (i + 1) % PRE_ENTRY_TIPS_VI.length), 5500);
    const secTimer = window.setInterval(() => setElapsed(e => e + 1), 1000);

    return () => {
      if (tipTimer !== null) clearInterval(tipTimer);
      clearInterval(secTimer);
    };
  }, []);

  const pct = Math.max(4, Math.min(100, Math.round(progress)));
  const activeStageId = resolveBootStageId(pct, stage, stageId);
  const activeStageIndex = BOOT_STAGE_INDEX_BY_ID[activeStageId];
  const displayStage = BOOT_STAGE_LABELS_VI[activeStageId];
  const dashOffset = RING_CIRCUMFERENCE * (1 - pct / 100);
  const overlayStyle = { '--el-boot-progress': (pct / 100).toFixed(3) } as CSSProperties;

  return (
    <div
      className={s.overlay}
      style={overlayStyle}
      role="status"
      aria-live="polite"
      aria-busy={errorVi ? 'false' : 'true'}
      data-testid="echo-life-loading-overlay"
      data-navigation-loading="study-space"
      data-stage={activeStageId}
      data-exiting={exiting ? 'true' : undefined}
    >
      <div className={s.atmosphere} aria-hidden="true">
        <div className={s.aurora} />
        <div className={s.stars} />
      </div>

      <section className={s.card} aria-label="Đang mở Không gian học tập" {...pointerLight}>
        <header className={s.header}>
          <div className={s.medallion} aria-hidden="true">
            <svg className={s.medallionRing} viewBox="0 0 66 66">
              <defs>
                <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#38bdf8" />
                  <stop offset="55%" stopColor="#6366f1" />
                  <stop offset="100%" stopColor="#14b8a6" />
                </linearGradient>
              </defs>
              <circle className={s.ringTrack} cx="33" cy="33" r={RING_RADIUS} />
              <circle
                className={s.ringFill}
                cx="33"
                cy="33"
                r={RING_RADIUS}
                stroke={`url(#${gradId})`}
                strokeDasharray={RING_CIRCUMFERENCE.toFixed(2)}
                strokeDashoffset={dashOffset.toFixed(2)}
              />
            </svg>
            <img
              className={s.medallionImg}
              src={echoSrc('official', 64)}
              alt=""
              width={40}
              height={40}
              draggable={false}
            />
          </div>

          <div className={s.titleBlock}>
            <div className={s.titleRow}>
              <h1 className={s.title}>Không gian học tập</h1>
              <span className={s.badge}>Echo Life · Riverside</span>
            </div>
            <p className={s.subtitle}>
              {transitionMode
                ? 'Đang mở rộng khu phố Riverside cho chế độ Khám phá'
                : firstVisit
                  ? 'Đang khởi tạo thế giới 3D tiếng Anh lần đầu cho thiết bị của bạn'
                  : 'Chào mừng bạn trở lại khu phố Riverside'}
            </p>
          </div>
        </header>

        <p className={s.notice} data-testid="echo-life-first-visit-notice">
          {firstVisit
            ? 'Lần đầu truy cập có thể mất thêm một chút thời gian để tải và lưu đệm thị trấn 3D, nhân vật và hệ thống ánh sáng. Các lần mở sau sẽ nhanh hơn rất nhiều.'
            : 'Đang khôi phục căn phòng, khu phố Riverside và tiến trình của bạn từ bộ nhớ đệm.'}
        </p>

        {errorVi ? (
          <div className={s.errorBox} role="alert" data-testid="echo-life-loading-error">
            <div className={s.errorHead}>
              <AlertCircle size={16} aria-hidden="true" />
              <span>Chưa thể hoàn tất khởi tạo Không gian học tập</span>
            </div>
            <p className={s.errorText}>{errorVi}</p>
            <div className={s.actions}>
              {onLowSpec && quality !== 'low' && (
                <button type="button" className={s.secondaryBtn} onClick={onLowSpec}>
                  <SlidersHorizontal size={14} aria-hidden="true" />
                  Chuyển sang chế độ Đồ họa nhẹ
                </button>
              )}
              {onBackToDashboard && (
                <button type="button" className={s.secondaryBtn} onClick={onBackToDashboard}>
                  Quay lại English Coach
                </button>
              )}
              {onRetry && (
                <button type="button" className={s.primaryBtn} onClick={onRetry}>
                  <RotateCcw size={14} aria-hidden="true" />
                  Thử lại
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className={s.progressPanel}>
              <div className={s.progressHead}>
                <span className={s.stageLabel} data-testid="echo-life-loading-stage">
                  <span className={s.stageDot} aria-hidden="true" />
                  {displayStage}
                </span>
                <strong className={s.pct}>{pct}%</strong>
              </div>

              {detailVi && <p className={s.stageDetail}>{detailVi}</p>}
              {slowNoticeVi && (
                <p className={s.stageDetail} data-testid="echo-life-loading-slow-notice">
                  {slowNoticeVi}
                </p>
              )}

              <div
                className={s.track}
                role="progressbar"
                aria-label="Tiến độ chuẩn bị Không gian học tập"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={`${displayStage} (${pct}%)`}
              >
                <div className={s.fill} style={{ width: `${pct}%` }} />
              </div>
            </div>

            <ol className={s.stepper} aria-label="Các bước chuẩn bị thế giới">
              {ECHO_LIFE_BOOT_STAGES.map((item, idx) => {
                const state =
                  idx < activeStageIndex || (pct >= 100 && idx === activeStageIndex)
                    ? 'done'
                    : idx === activeStageIndex
                      ? 'active'
                      : 'pending';
                return (
                  <li key={item.id} className={s.stepItem} data-state={state} data-step={item.id}>
                    <span className={s.stepMarker} aria-hidden="true">
                      {state === 'done' ? (
                        <Check size={12} strokeWidth={2.75} />
                      ) : state === 'active' ? (
                        <span className={s.stepPulseCore} />
                      ) : (
                        idx + 1
                      )}
                    </span>
                    <span>{item.label}</span>
                    <span className={s.stepStateTag}>
                      {state === 'done' ? 'Xong' : state === 'active' ? 'Đang chạy' : 'Chờ'}
                    </span>
                  </li>
                );
              })}
            </ol>

            <footer className={s.footer}>
              <p className={s.tip}>{PRE_ENTRY_TIPS_VI[tipIndex]}</p>

              {(slowState || (onLowSpec && quality !== 'low' && elapsed >= 4)) && (
                <div className={s.actions} data-testid={slowState ? 'echo-life-slow-actions' : undefined}>
                  {slowState && onContinueWaiting && (
                    <button
                      type="button"
                      className={s.primaryBtn}
                      onClick={onContinueWaiting}
                      data-testid="echo-life-continue-wait-btn"
                    >
                      Tiếp tục chờ
                    </button>
                  )}
                  {slowState && onEnterNow && (
                    <button
                      type="button"
                      className={s.secondaryBtn}
                      onClick={onEnterNow}
                      data-testid="echo-life-enter-now-btn"
                    >
                      Vào ngay (có thể giật)
                    </button>
                  )}
                  {onLowSpec && quality !== 'low' && (
                    <button
                      type="button"
                      className={s.secondaryBtn}
                      onClick={onLowSpec}
                      data-testid="echo-life-low-spec-btn"
                    >
                      <SlidersHorizontal size={14} aria-hidden="true" />
                      Chuyển sang chế độ Đồ họa nhẹ
                    </button>
                  )}
                </div>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

export function markEchoLifeWarmed() {
  try {
    localStorage.setItem(WARMED_KEY, '1');
  } catch { /* storage disabled */ }
}
