'use client';
/**
 * Echo Life Wave 11 — Manage City Dashboard Modal (inZOI-Class City Editor).
 * Controls Atmosphere (Season, Weather, Time of Day), City Pulse (Cleanliness,
 * Pedestrian Density, Traffic Density, City Karma), and Campus Billboard
 * (<= 40 ASCII headline, 4 themes, live preview strip).
 * 100% clean English copy, pure multi-stop Pearl Opal glass over WebGL, zero V3 edits.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Cloud,
  CloudRain,
  CloudSnow,
  RotateCcw,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react';
import {
  BILLBOARD_THEMES,
  defaultManageCityConfig,
  sanitizeBillboardHeadline,
  sanitizeManageCityConfig,
  type BillboardTheme,
  type ManageCityConfig,
} from '@/lib/echo-life/game/phoneSim';
import { resolveCityKarmaBand, resolveKarmaTier } from '@/lib/echo-life/game/playerMind';
import s from './buildStudio.module.css';

export type ManageCityWeatherOption =
  | 'auto'
  | 'sunny'
  | 'cloudy'
  | 'light_rain'
  | 'heavy_rain'
  | 'snowy';

export interface ManageCityModalProps {
  open: boolean;
  seasonIndex: 0 | 1 | 2 | 3;
  weather: ManageCityWeatherOption;
  clockMinutes: number;
  cityConfig: ManageCityConfig;
  personalKarma?: number;
  onSeasonChange: (seasonIndex: 0 | 1 | 2 | 3) => void;
  onWeatherChange: (weather: ManageCityWeatherOption) => void;
  onClockChange: (clockMinutes: number) => void;
  onCityConfigChange: (next: ManageCityConfig) => void;
  onClose: () => void;
}

const SEASONS: readonly { index: 0 | 1 | 2 | 3; label: string }[] = [
  { index: 0, label: 'Spring' },
  { index: 1, label: 'Summer' },
  { index: 2, label: 'Autumn' },
  { index: 3, label: 'Winter' },
];

const WEATHERS: readonly { id: ManageCityWeatherOption; label: string; Icon: typeof Sun }[] = [
  { id: 'sunny', label: 'Sunny', Icon: Sun },
  { id: 'cloudy', label: 'Cloudy', Icon: Cloud },
  { id: 'light_rain', label: 'Rain', Icon: CloudRain },
  { id: 'heavy_rain', label: 'Heavy Rain', Icon: CloudRain },
  { id: 'snowy', label: 'Snow', Icon: CloudSnow },
];

const THEME_LABELS: Readonly<Record<BillboardTheme, string>> = {
  academic: 'Academic',
  spring: 'Spring',
  neon: 'Neon',
  eco: 'Eco',
};

const TIME_PRESETS: readonly { label: string; minutes: number }[] = [
  { label: 'Morning 08:00', minutes: 480 },
  { label: 'Noon 13:00', minutes: 780 },
  { label: 'Golden 17:30', minutes: 1050 },
  { label: 'Lanterns 21:00', minutes: 1260 },
];

function formatClock(minutes: number): string {
  const safe = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function clockPhase(minutes: number): string {
  const h = (((Math.round(minutes) % 1440) + 1440) % 1440) / 60;
  if (h < 6) return 'Pre-Dawn';
  if (h < 11) return 'Morning';
  if (h < 16.5) return 'Afternoon';
  if (h < 19.5) return 'Golden Hour';
  return 'Evening';
}

function cleanlinessLabel(value: number): string {
  if (value >= 85) return 'Pristine';
  if (value >= 65) return 'Tidy';
  if (value >= 40) return 'Lived-In';
  return 'Needs Cleanup';
}

export function ManageCityModal({
  open,
  seasonIndex,
  weather,
  clockMinutes,
  cityConfig,
  personalKarma = 12,
  onSeasonChange,
  onWeatherChange,
  onClockChange,
  onCityConfigChange,
  onClose,
}: ManageCityModalProps) {
  const [headlineDraft, setHeadlineDraft] = useState(cityConfig.billboardHeadline);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setHeadlineDraft(cityConfig.billboardHeadline);
  }, [open, cityConfig.billboardHeadline]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const updateConfig = (patch: Partial<ManageCityConfig>) => {
    onCityConfigChange(sanitizeManageCityConfig({ ...cityConfig, ...patch }));
  };

  const liveHeadline = sanitizeBillboardHeadline(headlineDraft);
  const cityKarmaBand = resolveCityKarmaBand(cityConfig.cityKarma);
  const personalTier = resolveKarmaTier(personalKarma);

  return (
    <div className={s.buildRoot}>
      <div
        className={s.cityOverlay}
        role="dialog"
        aria-modal="true"
        aria-label="Manage City Dashboard"
        data-testid="manage-city-modal"
        onClick={e => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={s.cityModal}>
          <header className={s.cityHeader}>
            <div>
              <h2>Manage City</h2>
              <p>Tune Riverside atmosphere, crowd pulse, and live campus billboards.</p>
            </div>
            <button
              type="button"
              className={s.toolBtn}
              aria-label="Close Manage City dashboard"
              data-testid="manage-city-close"
              onClick={onClose}
            >
              <X size={15} aria-hidden="true" />
              <span>Close</span>
            </button>
          </header>

          <div className={s.cityBody}>
            {/* ── SECTION 1: ATMOSPHERE ──────────────────────────────────────────────────────────────── */}
            <section className={s.citySection} aria-label="City atmosphere">
              <h3>Atmosphere</h3>

              <div className={s.filterBar} role="group" aria-label="Season selector">
                {SEASONS.map(st => (
                  <button
                    key={st.index}
                    type="button"
                    className={s.filterChip}
                    aria-pressed={seasonIndex === st.index}
                    data-testid={`city-season-${st.label.toLowerCase()}`}
                    onClick={() => onSeasonChange(st.index)}
                  >
                    {st.label}
                  </button>
                ))}
              </div>

              <div className={s.filterBar} role="group" aria-label="Weather selector">
                {WEATHERS.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    className={s.toolBtn}
                    aria-pressed={weather === id}
                    data-testid={`city-weather-${id}`}
                    onClick={() => onWeatherChange(id)}
                  >
                    <Icon size={13} aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className={s.toolBtn}
                  aria-pressed={weather === 'auto'}
                  data-testid="city-weather-auto"
                  onClick={() => onWeatherChange('auto')}
                >
                  Auto
                </button>
              </div>

              <label className={s.citySliderRow}>
                <span>Time of Day ({clockPhase(clockMinutes)})</span>
                <input
                  type="range"
                  className={s.citySlider}
                  min={0}
                  max={1435}
                  step={5}
                  value={Math.max(0, Math.min(1435, Math.round(clockMinutes)))}
                  aria-label="Time of Day"
                  data-testid="city-time-slider"
                  onChange={e => onClockChange(Number(e.target.value))}
                />
                <output>{formatClock(clockMinutes)}</output>
              </label>

              <div className={s.filterBar}>
                {TIME_PRESETS.map(tp => (
                  <button
                    key={tp.label}
                    type="button"
                    className={s.filterChip}
                    onClick={() => onClockChange(tp.minutes)}
                  >
                    {tp.label}
                  </button>
                ))}
              </div>
            </section>

            {/* ── SECTION 2: CITY PULSE ──────────────────────────────────────────────────────────────── */}
            <section className={s.citySection} aria-label="City pulse and density">
              <h3>City Pulse</h3>

              <label className={s.citySliderRow}>
                <span>Cleanliness ({cleanlinessLabel(cityConfig.cleanliness)})</span>
                <input
                  type="range"
                  className={s.citySlider}
                  min={0}
                  max={100}
                  step={1}
                  value={cityConfig.cleanliness}
                  aria-label="City Cleanliness"
                  data-testid="city-cleanliness-slider"
                  onChange={e => updateConfig({ cleanliness: Number(e.target.value) })}
                />
                <output>{cityConfig.cleanliness}%</output>
              </label>

              <label className={s.citySliderRow}>
                <span>Pedestrian Density</span>
                <input
                  type="range"
                  className={s.citySlider}
                  min={0.3}
                  max={1.5}
                  step={0.1}
                  value={cityConfig.pedestrianDensity}
                  aria-label="Pedestrian Density"
                  data-testid="city-pedestrian-slider"
                  onChange={e => updateConfig({ pedestrianDensity: Number(e.target.value) })}
                />
                <output>{cityConfig.pedestrianDensity.toFixed(1)}x</output>
              </label>

              <label className={s.citySliderRow}>
                <span>Traffic Density</span>
                <input
                  type="range"
                  className={s.citySlider}
                  min={0.3}
                  max={1.5}
                  step={0.1}
                  value={cityConfig.trafficDensity}
                  aria-label="Traffic Density"
                  data-testid="city-traffic-slider"
                  onChange={e => updateConfig({ trafficDensity: Number(e.target.value) })}
                />
                <output>{cityConfig.trafficDensity.toFixed(1)}x</output>
              </label>

              <div className={s.cardTop} style={{ paddingTop: 4 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>
                  City Karma: {cityConfig.cityKarma} / 100
                </span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className={`${s.badge} ${s.badgeGood}`} data-testid="city-karma-band">
                    {cityKarmaBand}
                  </span>
                  <span className={s.badge}>Personal: {personalTier}</span>
                </div>
              </div>
            </section>

            {/* ── SECTION 3: CAMPUS BILLBOARD ────────────────────────────────────────────────────────── */}
            <section className={s.citySection} aria-label="Campus billboard editor">
              <div className={s.cardTop}>
                <h3>Campus Billboard</h3>
                <span className={s.badge}>{headlineDraft.length} / 40</span>
              </div>

              <input
                type="text"
                className={s.cityInput}
                maxLength={40}
                value={headlineDraft}
                placeholder="Welcome to Riverside Campus"
                aria-label="Campus Billboard Headline"
                data-testid="city-billboard-input"
                onChange={e => {
                  const asciiClean = e.target.value
                    .replace(/&/g, ' and ')
                    .replace(/[^\x20-\x7E]/g, '')
                    .slice(0, 40);
                  setHeadlineDraft(asciiClean);
                  updateConfig({ billboardHeadline: asciiClean });
                }}
                onBlur={() => {
                  const safe = sanitizeBillboardHeadline(headlineDraft);
                  setHeadlineDraft(safe);
                  updateConfig({ billboardHeadline: safe });
                }}
              />

              <div className={s.filterBar} role="group" aria-label="Billboard visual theme">
                {BILLBOARD_THEMES.map(theme => (
                  <button
                    key={theme}
                    type="button"
                    className={s.filterChip}
                    aria-pressed={cityConfig.billboardTheme === theme}
                    data-testid={`city-billboard-theme-${theme}`}
                    onClick={() => updateConfig({ billboardTheme: theme })}
                  >
                    {THEME_LABELS[theme]}
                  </button>
                ))}
              </div>

              <div
                className={s.billboardPreview}
                data-theme={cityConfig.billboardTheme}
                data-testid="city-billboard-preview"
              >
                <div>
                  <div className={s.billboardKicker}>
                    Riverside Campus Kiosk · {THEME_LABELS[cityConfig.billboardTheme]} Theme
                  </div>
                  <div className={s.billboardTitle}>{liveHeadline}</div>
                </div>
                <SlidersHorizontal size={18} aria-hidden="true" />
              </div>
            </section>
          </div>

          <footer className={s.cityFooter}>
            <button
              type="button"
              className={s.toolBtn}
              data-testid="city-reset-btn"
              onClick={() => {
                const def = defaultManageCityConfig();
                setHeadlineDraft(def.billboardHeadline);
                onCityConfigChange(def);
                onWeatherChange('auto');
              }}
            >
              <RotateCcw size={13} aria-hidden="true" />
              <span>Reset Defaults</span>
            </button>

            <button
              type="button"
              className={`${s.cardBtn} ${s.cardBtnPrimary}`}
              style={{ flex: 'none', padding: '8px 18px' }}
              data-testid="city-done-btn"
              onClick={onClose}
            >
              Done
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
