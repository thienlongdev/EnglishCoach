'use client';

import React, { useMemo, useRef } from 'react';
import {
  Activity,
  Check,
  Compass,
  Droplets,
  Gem,
  Info,
  Layers,
  Leaf,
  PauseCircle,
  Sun,
  Waves,
  Wind,
} from 'lucide-react';
import {
  BACKGROUND_EFFECT_IDS,
  BG_BOUNDS,
  EFFECT_COMPATIBILITY,
  PERFORMANCE_MODES,
  estimateEffectsGpuBudget,
  isStaticOnlyEffects,
  toggleEffectSelection,
  type BackgroundEffectId,
  type BackgroundMotionConfig,
  type PerformanceMode,
} from '@/lib/background-studio/types';
import styles from './BackgroundStudio.module.css';

export interface MotionLightPanelProps {
  /** Current motion and lighting parameters in the live draft. */
  motion: BackgroundMotionConfig;
  /** Baseline motion parameters used for double-click slider resets. */
  defaultMotion: BackgroundMotionConfig;
  /** True when the OS prefers-reduced-motion media query is active. */
  reducedMotion: boolean;
  /** Emits immediate updated motion configuration (0 ms live response). */
  onChangeMotion: (next: BackgroundMotionConfig) => void;
  /** Vietnamese UI copy when true; English UI copy when false. */
  vi: boolean;
}

interface EffectMeta {
  titleVi: string;
  titleEn: string;
  descVi: string;
  descEn: string;
  icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}

const EFFECT_META: Record<BackgroundEffectId, EffectMeta> = {
  static: {
    titleVi: 'Nền tĩnh',
    titleEn: 'Static',
    descVi: 'Tắt mọi lớp chuyển động để tối đa độ tập trung và tiết kiệm năng lượng.',
    descEn: 'Turns off motion planes for pure stillness and lowest power draw.',
    icon: PauseCircle,
  },
  'color-flow': {
    titleVi: 'Dải màu trôi',
    titleEn: 'Color Flow',
    descVi: 'Dải sắc độ trượt chậm theo hướng gió và ánh sáng đã chọn.',
    descEn: 'Soft chromatic ribbon gliding continuously along your drift direction.',
    icon: Waves,
  },
  aurora: {
    titleVi: 'Cực quang',
    titleEn: 'Aurora',
    descVi: 'Hai màn lụa cực quang tầng cao uốn lượn đối pha dịu mắt.',
    descEn: 'Dual high-altitude boreal curtains undulating in calm counter-phase.',
    icon: Wind,
  },
  'liquid-flow': {
    titleVi: 'Dòng chảy lỏng',
    titleEn: 'Liquid Flow',
    descVi: 'Ba khối màu lỏng trôi theo quỹ đạo hữu cơ mượt mà.',
    descEn: 'Three feathered liquid color pools orbiting along organic paths.',
    icon: Droplets,
  },
  'pearl-shimmer': {
    titleVi: 'Ánh ngọc trai',
    titleEn: 'Pearl Shimmer',
    descVi: 'Ánh xà cừ óng ánh lướt nhẹ tạo hiệu ứng tinh thể sang trọng.',
    descEn: 'Opalescent mother-of-pearl sheen sweeping softly across the stage.',
    icon: Gem,
  },
  'ambient-glow': {
    titleVi: 'Ánh sáng lan tỏa',
    titleEn: 'Ambient Glow',
    descVi: 'Quầng sáng tâm điểm nở nhẹ theo nhịp tạo chiều sâu êm dịu.',
    descEn: 'Soft focal radiance breathing gently around the gradient center.',
    icon: Sun,
  },
  'light-drift': {
    titleVi: 'Luồng sáng trôi',
    titleEn: 'Light Drift',
    descVi: 'Hai luồng sáng dịu dịch chuyển chậm mang cảm giác sống động.',
    descEn: 'Two delicate light pools drifting lazily for atmospheric depth.',
    icon: Compass,
  },
  'color-breathing': {
    titleVi: 'Nhịp thở sắc màu',
    titleEn: 'Color Breathing',
    descVi: 'Độ sáng và sắc độ phập phồng đều đặn dễ chịu khi học lâu.',
    descEn: 'Calm harmonic luminosity pulse tuned for extended study sessions.',
    icon: Activity,
  },
  'gradient-morph': {
    titleVi: 'Biến chuyển sắc độ',
    titleEn: 'Gradient Morph',
    descVi: 'Chuyển hóa êm giữa bảng màu gốc và sắc hòa âm OKLCH.',
    descEn: 'Silky crossfade between your gradient and its OKLCH harmonic twin.',
    icon: Layers,
  },
};

const COMPASS_POINTS: readonly { label: string; deg: number }[] = [
  { label: 'N', deg: 0 },
  { label: 'NE', deg: 45 },
  { label: 'E', deg: 90 },
  { label: 'SE', deg: 135 },
  { label: 'S', deg: 180 },
  { label: 'SW', deg: 225 },
  { label: 'W', deg: 270 },
  { label: 'NW', deg: 315 },
];

const PERFORMANCE_LABELS: Record<PerformanceMode, { vi: string; en: string }> = {
  auto: { vi: 'Tự động (Auto)', en: 'Auto' },
  high: { vi: 'Cao (High)', en: 'High' },
  eco: { vi: 'Tiết kiệm GPU (Eco)', en: 'Eco (Low GPU)' },
};

function sliderFillPercent(value: number, min: number, max: number): string {
  if (max <= min) return '0%';
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return `${(ratio * 100).toFixed(1)}%`;
}

interface MotionSliderProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  valueText: string;
  minLabel?: string;
  maxLabel?: string;
  dimmed?: boolean;
  onChange: (next: number) => void;
  testId: string;
  resetHint: string;
}

function MotionSlider({
  id,
  label,
  value,
  min,
  max,
  step,
  defaultValue,
  valueText,
  minLabel,
  maxLabel,
  dimmed = false,
  onChange,
  testId,
  resetHint,
}: MotionSliderProps) {
  return (
    <div className={`${styles.sliderRow} ${dimmed ? styles.sliderRowDisabled : ''}`}>
      <div className={styles.sliderHeader}>
        <label htmlFor={id} className={styles.sliderLabel}>
          {label}
        </label>
        <span
          className={styles.sliderValuePill}
          title={resetHint}
          onDoubleClick={() => onChange(defaultValue)}
        >
          {valueText}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onDoubleClick={() => onChange(defaultValue)}
        className={styles.rangeInput}
        style={{ '--fill': sliderFillPercent(value, min, max) } as React.CSSProperties}
        aria-valuetext={valueText}
        title={resetHint}
        data-testid={testId}
      />
      {(minLabel || maxLabel) && (
        <div className={styles.sliderEnds} aria-hidden="true">
          <span>{minLabel ?? ''}</span>
          <span>{maxLabel ?? ''}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Tab 3 — Motion and Light Composer for Echo Background Studio.
 * Combines up to 6 compatible GPU-composited effects with all 8 motion/lighting
 * dynamics sliders, compass bearing pills, live GPU budget meter, and performance tiers.
 */
export default function MotionLightPanel({
  motion,
  defaultMotion,
  reducedMotion,
  onChangeMotion,
  vi,
}: MotionLightPanelProps) {
  const perfModeRefs = useRef<Partial<Record<PerformanceMode, HTMLButtonElement | null>>>({});
  const activeSet = useMemo(() => new Set<BackgroundEffectId>(motion.effects), [motion.effects]);
  const isStaticOnly = useMemo(() => isStaticOnlyEffects(motion.effects), [motion.effects]);
  const gpuBudget = useMemo(() => estimateEffectsGpuBudget(motion.effects), [motion.effects]);

  const updateMotion = <K extends keyof BackgroundMotionConfig>(
    key: K,
    value: BackgroundMotionConfig[K],
  ) => {
    onChangeMotion({
      ...motion,
      [key]: value,
    });
  };

  const handlePerformanceModeKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    let nextIdx: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIdx = (idx + 1) % PERFORMANCE_MODES.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIdx = (idx - 1 + PERFORMANCE_MODES.length) % PERFORMANCE_MODES.length;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = PERFORMANCE_MODES.length - 1;
    }
    if (nextIdx === null) return;
    event.preventDefault();
    const nextMode = PERFORMANCE_MODES[nextIdx];
    updateMotion('performanceMode', nextMode);
    perfModeRefs.current[nextMode]?.focus();
  };

  const handleToggleEffect = (effectId: BackgroundEffectId) => {
    const nextEffects = toggleEffectSelection(motion.effects, effectId);
    updateMotion('effects', nextEffects);
  };

  const budgetClass =
    gpuBudget.level === 'minimal'
      ? styles.gpuBudgetMinimal
      : gpuBudget.level === 'balanced'
        ? styles.gpuBudgetBalanced
        : styles.gpuBudgetRich;

  const budgetText =
    gpuBudget.level === 'minimal'
      ? vi
        ? 'GPU Nhẹ'
        : 'GPU Light'
      : gpuBudget.level === 'balanced'
        ? vi
          ? 'GPU Cân bằng'
          : 'GPU Balanced'
        : vi
          ? 'GPU Giàu lớp'
          : 'GPU Rich';

  const resetHint = vi ? 'Nhấn đúp để đặt lại mặc định' : 'Double-click to reset to default';

  return (
    <>
      {/* Reduced-motion accessibility notice */}
      {reducedMotion && (
        <div className={styles.ecoBanner} role="status" data-testid="motion-reduced-motion-banner">
          <Info size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 1 }} />
          <span>
            {vi
              ? 'Hệ điều hành đang bật Giảm chuyển động (prefers-reduced-motion). Các hiệu ứng động tự động tạm dừng để dịu mắt, nhưng lựa chọn của bạn vẫn được lưu nguyên vẹn.'
              : 'Your system prefers reduced motion. Animated layers pause automatically for comfort while your selected settings stay saved.'}
          </span>
        </div>
      )}

      {/* Multi-Effect Composer Grid (all 9 effects) */}
      <section
        className={styles.sectionCard}
        aria-label={vi ? 'Bộ phối hiệu ứng chuyển động và ánh sáng' : 'Motion and light effects composer'}
      >
        <div className={styles.sectionHead}>
          <div>
            <h3 className={styles.sectionTitle}>
              {vi ? 'Hiệu ứng Chuyển động và Ánh sáng' : 'Motion and Light Effects'}
            </h3>
            <p className={styles.sectionHint}>
              {vi
                ? 'Kết hợp nhiều hiệu ứng tương thích cùng lúc. Chọn Nền tĩnh để dừng toàn bộ chuyển động.'
                : 'Layer multiple compatible effects together. Choose Static for a still backdrop.'}
            </p>
          </div>
          <span
            className={`${styles.gpuBudgetPill} ${budgetClass}`}
            data-testid="motion-gpu-budget"
            data-budget-level={gpuBudget.level}
          >
            {budgetText} · {gpuBudget.activeAnimatedCount}
          </span>
        </div>

        <div className={styles.effectGrid} data-testid="motion-effect-grid">
          {BACKGROUND_EFFECT_IDS.map((effectId) => {
            const meta = EFFECT_META[effectId];
            const Icon = meta.icon;
            const isActive =
              effectId === 'static' ? isStaticOnly : activeSet.has(effectId);
            const ecoSafe = EFFECT_COMPATIBILITY[effectId].ecoSafe;

            return (
              <button
                key={effectId}
                type="button"
                className={`${styles.effectCard} ${isActive ? styles.effectCardActive : ''}`}
                aria-pressed={isActive}
                onClick={() => handleToggleEffect(effectId)}
                data-testid={`effect-card-${effectId}`}
              >
                <div className={styles.effectCardHead}>
                  <span className={styles.effectIconWell} aria-hidden="true">
                    <Icon size={15} aria-hidden={true} />
                  </span>
                  <span className={styles.effectRing} aria-hidden="true">
                    {isActive && <Check size={11} strokeWidth={3} />}
                  </span>
                </div>
                <span className={styles.effectTitle}>
                  {vi ? meta.titleVi : meta.titleEn}
                </span>
                <span className={styles.effectDesc}>
                  {vi ? meta.descVi : meta.descEn}
                  {motion.performanceMode === 'eco' && !ecoSafe && effectId !== 'static'
                    ? vi
                      ? ' (Tự gọn trong chế độ Eco)'
                      : ' (Simplified in Eco)'
                    : ''}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Motion and Light Dynamics (All 8 Requested Sliders) */}
      <section
        className={styles.sectionCard}
        aria-label={vi ? 'Thông số chuyển động và ánh sáng' : 'Motion and light dynamics'}
      >
        <div className={styles.sectionHead}>
          <div>
            <h3 className={styles.sectionTitle}>
              {vi ? 'Điều khiển Chuyển động và Ánh sáng' : 'Motion and Light Controls'}
            </h3>
            <p className={styles.sectionHint}>
              {isStaticOnly
                ? vi
                  ? 'Đang ở Nền tĩnh — hãy bật ít nhất một hiệu ứng bên trên để thấy chuyển động ngay.'
                  : 'Static mode is active — enable an animated effect above to preview movement live.'
                : vi
                  ? 'Kéo thanh trượt để xem phản hồi tức thì 0 ms. Nhấn đúp vào thanh trượt để đặt lại.'
                  : 'Drag any slider for instant 0 ms preview feedback. Double-click to reset.'}
            </p>
          </div>
        </div>

        <div className={styles.sliderGridTwo}>
          <MotionSlider
            id="bg-motion-speed"
            label={vi ? 'Tốc độ chuyển động' : 'Animation Speed'}
            value={motion.animationSpeed}
            min={BG_BOUNDS.animationSpeed.min}
            max={BG_BOUNDS.animationSpeed.max}
            step={BG_BOUNDS.animationSpeed.step}
            defaultValue={defaultMotion.animationSpeed}
            valueText={`${motion.animationSpeed.toFixed(2)}×`}
            minLabel="0.1×"
            maxLabel="2.5×"
            dimmed={isStaticOnly}
            onChange={(val) => updateMotion('animationSpeed', val)}
            testId="slider-animation-speed"
            resetHint={resetHint}
          />

          <MotionSlider
            id="bg-motion-intensity"
            label={vi ? 'Cường độ chuyển động' : 'Motion Intensity'}
            value={motion.motionIntensity}
            min={BG_BOUNDS.motionIntensity.min}
            max={BG_BOUNDS.motionIntensity.max}
            step={BG_BOUNDS.motionIntensity.step}
            defaultValue={defaultMotion.motionIntensity}
            valueText={`${Math.round(motion.motionIntensity)}%`}
            minLabel="0%"
            maxLabel="100%"
            dimmed={isStaticOnly}
            onChange={(val) => updateMotion('motionIntensity', val)}
            testId="slider-motion-intensity"
            resetHint={resetHint}
          />

          <MotionSlider
            id="bg-light-intensity"
            label={vi ? 'Cường độ ánh sáng' : 'Light Intensity'}
            value={motion.lightIntensity}
            min={BG_BOUNDS.lightIntensity.min}
            max={BG_BOUNDS.lightIntensity.max}
            step={BG_BOUNDS.lightIntensity.step}
            defaultValue={defaultMotion.lightIntensity}
            valueText={`${Math.round(motion.lightIntensity)}%`}
            minLabel="0%"
            maxLabel="100%"
            onChange={(val) => updateMotion('lightIntensity', val)}
            testId="slider-light-intensity"
            resetHint={resetHint}
          />

          <MotionSlider
            id="bg-movement-scale"
            label={vi ? 'Biên độ chuyển động' : 'Movement Scale'}
            value={motion.movementScale}
            min={BG_BOUNDS.movementScale.min}
            max={BG_BOUNDS.movementScale.max}
            step={BG_BOUNDS.movementScale.step}
            defaultValue={defaultMotion.movementScale}
            valueText={`${Math.round(motion.movementScale)}%`}
            minLabel="20%"
            maxLabel="200%"
            dimmed={isStaticOnly}
            onChange={(val) => updateMotion('movementScale', val)}
            testId="slider-movement-scale"
            resetHint={resetHint}
          />

          <MotionSlider
            id="bg-glow-radius"
            label={vi ? 'Bán kính quầng sáng' : 'Glow Radius'}
            value={motion.glowRadius}
            min={BG_BOUNDS.glowRadius.min}
            max={BG_BOUNDS.glowRadius.max}
            step={BG_BOUNDS.glowRadius.step}
            defaultValue={defaultMotion.glowRadius}
            valueText={`${Math.round(motion.glowRadius)}%`}
            minLabel="10%"
            maxLabel="100%"
            onChange={(val) => updateMotion('glowRadius', val)}
            testId="slider-glow-radius"
            resetHint={resetHint}
          />

          <MotionSlider
            id="bg-shimmer-intensity"
            label={vi ? 'Cường độ ánh ngọc' : 'Shimmer Intensity'}
            value={motion.shimmerIntensity}
            min={BG_BOUNDS.shimmerIntensity.min}
            max={BG_BOUNDS.shimmerIntensity.max}
            step={BG_BOUNDS.shimmerIntensity.step}
            defaultValue={defaultMotion.shimmerIntensity}
            valueText={`${Math.round(motion.shimmerIntensity)}%`}
            minLabel="0%"
            maxLabel="100%"
            dimmed={isStaticOnly}
            onChange={(val) => updateMotion('shimmerIntensity', val)}
            testId="slider-shimmer-intensity"
            resetHint={resetHint}
          />

          <MotionSlider
            id="bg-animation-smoothness"
            label={vi ? 'Độ mượt chuyển động' : 'Animation Smoothness'}
            value={motion.animationSmoothness}
            min={BG_BOUNDS.animationSmoothness.min}
            max={BG_BOUNDS.animationSmoothness.max}
            step={BG_BOUNDS.animationSmoothness.step}
            defaultValue={defaultMotion.animationSmoothness}
            valueText={`${Math.round(motion.animationSmoothness)}%`}
            minLabel={vi ? 'Nhịp rõ' : 'Crisp'}
            maxLabel={vi ? 'Êm mượt' : 'Silky'}
            dimmed={isStaticOnly}
            onChange={(val) => updateMotion('animationSmoothness', val)}
            testId="slider-animation-smoothness"
            resetHint={resetHint}
          />
        </div>

        <hr className={styles.sectionDivider} />

        {/* Movement Direction slider + 8 compass quick pills */}
        <div className={styles.sliderGrid}>
          <MotionSlider
            id="bg-movement-direction"
            label={vi ? 'Hướng chuyển động' : 'Movement Direction'}
            value={motion.movementDirection}
            min={BG_BOUNDS.movementDirection.min}
            max={BG_BOUNDS.movementDirection.max}
            step={BG_BOUNDS.movementDirection.step}
            defaultValue={defaultMotion.movementDirection}
            valueText={`${Math.round(motion.movementDirection)}°`}
            minLabel="0°"
            maxLabel="360°"
            dimmed={isStaticOnly}
            onChange={(val) => updateMotion('movementDirection', val)}
            testId="slider-movement-direction"
            resetHint={resetHint}
          />

          <div
            className={styles.pillGrid}
            role="group"
            aria-label={vi ? 'Hướng la bàn nhanh' : 'Quick compass bearings'}
          >
            {COMPASS_POINTS.map((point) => {
              const normalized = ((Math.round(motion.movementDirection) % 360) + 360) % 360;
              const isSelected = normalized === point.deg;
              return (
                <button
                  key={point.label}
                  type="button"
                  className={`${styles.pillOption} ${isSelected ? styles.pillOptionActive : ''}`}
                  aria-pressed={isSelected}
                  aria-label={
                    vi
                      ? `Hướng ${point.label}, ${point.deg} độ`
                      : `Compass bearing ${point.label}, ${point.deg} degrees`
                  }
                  onClick={() => updateMotion('movementDirection', point.deg)}
                  data-testid={`compass-${point.label.toLowerCase()}`}
                >
                  {point.label} · {point.deg}°
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Performance Mode Selector */}
      <section
        className={styles.sectionCard}
        aria-label={vi ? 'Chế độ hiệu năng GPU' : 'GPU Performance Mode'}
      >
        <div className={styles.sectionHead}>
          <div>
            <h3 className={styles.sectionTitle}>
              {vi ? 'Chế độ hiệu năng và tiết kiệm GPU' : 'Performance and GPU Budget'}
            </h3>
            <p className={styles.sectionHint}>
              {vi
                ? 'Chọn Tiết kiệm GPU (Eco) trên thiết bị yếu hoặc khi dùng pin để chỉ chạy tối đa 1 lớp nhẹ.'
                : 'Choose Eco on low-end devices or battery power to limit animation to 1 lightweight plane.'}
            </p>
          </div>
        </div>

        <div
          className={styles.segmented}
          role="radiogroup"
          aria-label={vi ? 'Chọn chế độ hiệu năng' : 'Select performance mode'}
        >
          {PERFORMANCE_MODES.map((mode, idx) => {
            const active = motion.performanceMode === mode;
            return (
              <button
                key={mode}
                ref={(node) => {
                  perfModeRefs.current[mode] = node;
                }}
                type="button"
                role="radio"
                tabIndex={active ? 0 : -1}
                aria-checked={active}
                className={`${styles.segmentBtn} ${active ? styles.segmentBtnActive : ''}`}
                onClick={() => updateMotion('performanceMode', mode)}
                onKeyDown={(event) => handlePerformanceModeKeyDown(event, idx)}
                data-testid={`performance-mode-${mode}`}
              >
                {PERFORMANCE_LABELS[mode][vi ? 'vi' : 'en']}
              </button>
            );
          })}
        </div>

        {motion.performanceMode === 'eco' && (
          <div className={styles.ecoBanner} role="status" data-testid="motion-eco-active-banner">
            <Leaf size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 1 }} />
            <span>
              {vi
                ? 'Chế độ Eco đang bật: giới hạn tối đa 1 lớp chuyển động nhẹ, tắt làm mờ và hạt mịn giúp thiết bị yếu luôn giữ 60 fps ổn định.'
                : 'Eco mode active: caps rendering to 1 lightweight motion plane and disables blur and grain for steady 60 fps on modest devices.'}
            </span>
          </div>
        )}
      </section>
    </>
  );
}
