'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Eye, Heart, Search } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { WORLDS, WORLD_CATEGORIES, findWorld, worldPoster, worldThumb, type WorldMeta } from '@/lib/wallpaper/worlds/catalog';
import type { WorldRuntime } from '@/lib/wallpaper/worlds/runtime';
import type { WorldCategory } from '@/lib/wallpaper/worlds/types';
import {
  currentPreference,
  getWallpaperStatus,
  normalizePreference,
  setBackgroundHeld,
  sourceKey,
  subscribeWallpaperStatus,
  writePreference,
} from '@/lib/wallpaper/storage';
import type { GlassTint, WallpaperPreference, WorldFocusMode } from '@/types/wallpaper';
import StudioBar, { type StudioRoom } from './StudioBar';
import { accountOfKey, commitMediaAppearance } from '@/lib/appearance/state';
import styles from './WorldStudio.module.css';
import { readAppearanceTheme, applyAppearanceTheme } from '@/lib/appearance/scope';

/**
 * Echo Universe — Theme Studio. The room itself is the preview: the world in focus runs full-screen behind the gallery
 * and the controls, so moving the pointer across the panels already plays with it. The gallery shows still pictures
 * (real frames of the worlds); only the one world in focus has a renderer. Nothing is applied until "Áp dụng": the
 * background engine then starts the world, and the studio closes when its first frame is drawn.
 */

type Filter = 'all' | 'favourites' | WorldCategory;
type Appearance = 'system' | 'light' | 'dark';

const DEFAULT_MOTION = 0.6;
const DEFAULT_POINTER = 0.8;
const DEFAULT_CLARITY = 0.6;

function readAppearance(): Appearance {
  return readAppearanceTheme();
}

function applyAppearance(next: Appearance) {
  applyAppearanceTheme(next);
}

function useAppDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    },
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

const favouritesKey = (storageKey: string) => `${storageKey}:worlds:fav`;
function readFavourites(storageKey: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(favouritesKey(storageKey)) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((id) => findWorld(id)) : []);
  } catch {
    return new Set();
  }
}

export default function WorldStudio({ storageKey, onClose, onOpenRoom }: { storageKey: string; onClose: () => void; onOpenRoom: (room: StudioRoom) => void }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const reducedMotion = useReducedMotion();
  const appDark = useAppDark();

  const saved = useMemo(() => currentPreference(storageKey), [storageKey]);
  const appliedWorld = saved.source === 'world' ? saved.worldId : undefined;
  const [focusId, setFocusId] = useState<string>(appliedWorld ?? saved.lastWorldId ?? WORLDS[0].id);
  const [motion, setMotion] = useState(saved.worldMotion ?? DEFAULT_MOTION);
  const [pointer, setPointer] = useState(saved.worldPointer ?? DEFAULT_POINTER);
  const [interactive, setInteractive] = useState(saved.worldInteractive !== false);
  const [clarity, setClarity] = useState(saved.clarity);
  const [still, setStill] = useState(saved.motion === 'still');
  const [focusMode, setFocusMode] = useState<WorldFocusMode>(saved.worldFocus ?? 'auto');
  const [glass, setGlass] = useState<GlassTint>(saved.glass ?? 'auto');
  const [appearance, setAppearanceState] = useState<Appearance>(readAppearance);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [favourites, setFavourites] = useState<Set<string>>(() => readFavourites(storageKey));
  const [panelsHidden, setPanelsHidden] = useState(false);
  const [applying, setApplying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  const world = findWorld(focusId) ?? WORLDS[0];
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<WorldRuntime | null>(null);
  const paramsRef = useRef({ motion, pointer: interactive ? pointer : 0, calm: 0, dark: appDark });
  paramsRef.current = { motion, pointer: interactive ? pointer : 0, calm: 0, dark: appDark };
  const stillNow = still || reducedMotion;

  // One renderer: the world in focus. Changing focus destroys the previous one before the next one starts.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    setDrawn(false);
    setUnsupported(false);
    import('@/lib/wallpaper/worlds/runtime')
      .then(({ startWorld }) => {
        if (cancelled) return;
        runtimeRef.current = startWorld({
          id: focusId,
          host,
          params: paramsRef.current,
          still: stillNow,
          onFirstFrame: () => {
            if (!cancelled) setDrawn(true);
          },
          onFail: () => {
            if (!cancelled) setUnsupported(true);
          },
        });
      })
      .catch(() => {
        if (!cancelled) setUnsupported(true);
      });
    return () => {
      cancelled = true;
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, [focusId, stillNow]);

  useEffect(() => {
    runtimeRef.current?.setParams({ motion, pointer: interactive ? pointer : 0, calm: 0, dark: appDark });
  }, [motion, pointer, interactive, appDark]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const close = useCallback(() => {
    if (!applying) onClose();
  }, [applying, onClose]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (panelsHidden) setPanelsHidden(false);
      else close();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href]')).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase(vi ? 'vi' : 'en');
    return WORLDS.filter((item) => {
      if (filter === 'favourites' && !favourites.has(item.id)) return false;
      if (filter !== 'all' && filter !== 'favourites' && !item.categories.includes(filter)) return false;
      if (!q) return true;
      return `${item.title} ${item.moodVi} ${item.moodEn}`.toLocaleLowerCase(vi ? 'vi' : 'en').includes(q);
    });
  }, [filter, query, favourites, vi]);

  const toggleFavourite = (id: string) => {
    setFavourites((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(favouritesKey(storageKey), JSON.stringify([...next]));
      } catch {
        // Storage denied: favourites last for this page view.
      }
      return next;
    });
  };

  const draftPreference = (): WallpaperPreference =>
    normalizePreference({
      ...saved,
      source: 'world',
      worldId: world.id,
      worldMotion: motion,
      worldPointer: pointer,
      worldInteractive: interactive,
      worldFocus: focusMode,
      glass,
      clarity,
      motion: still ? 'still' : 'live',
    });

  const apply = () => {
    if (applying) return;
    const next = draftPreference();
    const key = sourceKey(next);
    setProblem(null);
    runtimeRef.current?.setPlaying(false);
    setBackgroundHeld(false);
    writePreference(storageKey, next);
    const now = getWallpaperStatus();
    if (now.key === key && now.state === 'ready') {
      commitMediaAppearance(accountOfKey(storageKey));
      onClose();
      return;
    }
    setApplying(true);
  };

  useEffect(() => {
    if (!applying) return;
    const key = sourceKey(draftPreference());
    const check = () => {
      const status = getWallpaperStatus();
      if (status.key !== key) return;
      if (status.state === 'ready') {
        setApplying(false);
        commitMediaAppearance(accountOfKey(storageKey));
        onClose();
      } else if (status.state === 'failed') {
        setApplying(false);
        setProblem(vi ? 'Thiết bị này chưa chạy được thế giới này. Nền cũ vẫn được giữ.' : 'This device could not run this world. The previous background stays.');
        writePreference(storageKey, saved);
        setBackgroundHeld(true);
        runtimeRef.current?.setPlaying(true);
      }
    };
    check();
    return subscribeWallpaperStatus(check);
    // draftPreference reads the same state as these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applying]);

  const backToWallpaper = () => {
    if (!saved.lastMedia) return;
    setBackgroundHeld(false);
    writePreference(storageKey, normalizePreference({ ...saved, ...saved.lastMedia, worldId: undefined }));
    commitMediaAppearance(accountOfKey(storageKey));
    onClose();
  };
  const resetTuning = () => {
    setMotion(DEFAULT_MOTION);
    setPointer(DEFAULT_POINTER);
    setInteractive(true);
    setClarity(DEFAULT_CLARITY);
    setStill(false);
    setFocusMode('auto');
    setGlass('auto');
  };

  const setAppearance = (next: Appearance) => {
    setAppearanceState(next);
    applyAppearance(next);
  };

  const weightLabel = (item: WorldMeta) =>
    item.weight === 'light' ? (vi ? 'Nhẹ cho máy' : 'Light on your device') : item.weight === 'medium' ? (vi ? 'Vừa phải' : 'Moderate') : vi ? 'Giàu hiệu ứng' : 'Rich effects';

  const veil = appDark ? `rgb(4 9 22 / ${Math.min(0.84, Math.max(0.18, 0.68 - 0.5 * clarity)).toFixed(3)})` : `rgb(246 248 252 / ${Math.min(0.34, Math.max(0.04, 0.3 - 0.3 * clarity)).toFixed(3)})`;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="world-studio-title"
      className={`${styles.studio} ${panelsHidden ? styles.panelsHidden : ''}`}
      style={{ '--accent': world.accent } as React.CSSProperties}
      onKeyDown={onKeyDown}
      data-testid="world-studio"
      data-focus-world={world.id}
      data-world-drawn={drawn ? 'yes' : 'no'}
    >
      {/* The live world, behind everything. The still of the same world shows until its first frame is drawn. */}
      <div className={styles.liveFrame} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {worldPoster(world.id) && <img key={world.id} className={styles.livePoster} src={worldPoster(world.id)} alt="" decoding="async" />}
        <div ref={hostRef} className={`${styles.liveHost} ${drawn ? styles.liveHostOn : ''}`} key={`${world.id}-${stillNow}`} data-testid="world-preview-host" />
        <div className={styles.liveVeil} style={{ background: veil }} />
        <div className={styles.liveShade} />
      </div>

      <StudioBar room="worlds" onRoom={onOpenRoom} storageKey={storageKey} vi={vi} closeRef={closeRef} onClose={close} disabled={applying}>
        <button type="button" className={styles.iconText} onClick={() => setPanelsHidden((on) => !on)} aria-pressed={panelsHidden} data-testid="world-view-whole">
          <Eye className="h-4 w-4" aria-hidden="true" />
          <span>{panelsHidden ? (vi ? 'Hiện bảng điều khiển' : 'Show controls') : vi ? 'Xem trọn khung cảnh' : 'View the whole scene'}</span>
        </button>
      </StudioBar>

      <div className={styles.body}>
        <section className={styles.gallery} aria-labelledby="world-studio-title">
          <div className={styles.hero}>
            <h2 id="world-studio-title" className={styles.heading}>{vi ? 'Thế giới giao diện' : 'Living worlds'}</h2>
            <p className={styles.brandline}>Echo Universe · Theme Studio</p>
            <p className={styles.lead}>
              {vi ? `${WORLDS.length} thế giới sống động, hình ảnh chạy ngay trên máy của bạn. Di chuyển con trỏ để chạm vào chúng.` : `${WORLDS.length} living worlds, drawn right on your device. Move your pointer to touch them.`}
            </p>
          </div>

          <div className={styles.filters}>
            <div className={styles.chips} role="group" aria-label={vi ? 'Lọc theo loại' : 'Filter by kind'}>
              {([['all', vi ? 'Tất cả' : 'All'], ...WORLD_CATEGORIES.map((c) => [c.id, vi ? c.vi : c.en]), ['favourites', vi ? 'Yêu thích' : 'Favourites']] as [Filter, string][]).map(([id, label]) => (
                <button key={id} type="button" className={`${styles.chip} ${filter === id ? styles.chipOn : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)} data-testid={`world-filter-${id}`}>
                  {label}
                </button>
              ))}
            </div>
            <label className={styles.search}>
              <Search className="h-4 w-4" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={vi ? 'Tìm thế giới…' : 'Find a world…'}
                aria-label={vi ? 'Tìm thế giới' : 'Find a world'}
                data-testid="world-search"
              />
            </label>
          </div>

          <div className={styles.grid} data-testid="world-grid">
            {visible.map((item) => {
              const number = String(WORLDS.indexOf(item) + 1).padStart(2, '0');
              const on = item.id === world.id;
              const fav = favourites.has(item.id);
              return (
                <div key={item.id} className={`${styles.card} ${on ? styles.cardOn : ''}`} style={{ '--tone': item.accent } as React.CSSProperties} data-world-card={item.id}>
                  <button type="button" className={styles.cardMain} aria-pressed={on} onClick={() => setFocusId(item.id)} data-testid={`world-card-${item.id}`}>
                    <span className={styles.thumb}>
                      {worldThumb(item.id) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={worldThumb(item.id)} alt="" loading="lazy" decoding="async" />
                      ) : (
                        <span className={styles.thumbEmpty} />
                      )}
                      <span className={styles.techBadge}>{item.tech}</span>
                      {appliedWorld === item.id && <span className={styles.usingBadge}>{vi ? 'Đang dùng' : 'In use'}</span>}
                      {on && (
                        <span className={styles.onBadge} aria-hidden="true">
                          <Check className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </span>
                    <span className={styles.cardText}>
                      <span className={styles.cardTitle}>
                        {number}. {item.title}
                      </span>
                      <span className={styles.cardMood}>{vi ? item.moodVi : item.moodEn}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.heart} ${fav ? styles.heartOn : ''}`}
                    aria-pressed={fav}
                    aria-label={`${fav ? (vi ? 'Bỏ yêu thích' : 'Remove favourite') : vi ? 'Yêu thích' : 'Favourite'}: ${item.title}`}
                    onClick={() => toggleFavourite(item.id)}
                  >
                    <Heart className="h-4 w-4" aria-hidden="true" fill={fav ? 'currentColor' : 'none'} />
                  </button>
                </div>
              );
            })}
            {visible.length === 0 && (
              <p className={styles.empty}>{filter === 'favourites' && !query ? (vi ? 'Bạn chưa chọn thế giới yêu thích nào.' : 'You have no favourite worlds yet.') : vi ? 'Không có thế giới nào khớp.' : 'No world matches.'}</p>
            )}
          </div>
        </section>

        <aside className={styles.panel} aria-label={vi ? 'Tuỳ chỉnh thế giới' : 'Tune this world'}>
          <div className={styles.panelScroll}>
            <p className={styles.panelEyebrow}>{world.tech} · {weightLabel(world)}</p>
            <h3 className={styles.panelTitle} data-testid="world-focus-title">{world.title}</h3>
            <p className={styles.panelMood}>{vi ? world.moodVi : world.moodEn}</p>
            <ul className={styles.factList}>
              <li>{vi ? world.touchVi : world.touchEn}</li>
              <li>{vi ? world.studyVi : world.studyEn}</li>
            </ul>
            {world.credit && <p className={styles.credit}>{world.credit}</p>}
            {unsupported && (
              <p className={styles.note} role="status">
                {vi ? 'Trình duyệt này chưa chạy được thế giới động: sẽ dùng ảnh tĩnh của thế giới.' : 'This browser cannot run a live world: its still picture is used instead.'}
              </p>
            )}
            {reducedMotion && (
              <p className={styles.note} role="status">
                {vi ? 'Thiết bị đang bật giảm chuyển động: thế giới hiển thị một khung hình tĩnh.' : 'Reduced motion is on: worlds show one still frame.'}
              </p>
            )}

            <div className={styles.panelHead}>
              <h4>{vi ? 'Tuỳ chỉnh' : 'Tune'}</h4>
              <button type="button" className={styles.linkButton} onClick={resetTuning} data-testid="world-reset-tuning">{vi ? 'Đặt lại' : 'Reset'}</button>
            </div>

            <Slider label={vi ? 'Cường độ chuyển động' : 'Motion intensity'} value={motion} onChange={setMotion} disabled={stillNow} testid="world-motion" />
            <Slider label={vi ? 'Tương tác con trỏ' : 'Pointer interaction'} value={pointer} onChange={setPointer} disabled={!interactive} testid="world-pointer" />
            <Slider label={vi ? 'Độ hiển thị nền' : 'Background visibility'} value={clarity} onChange={setClarity} testid="world-clarity" />

            <div className={styles.toggleRow}>
              <span>
                <span className={styles.toggleLabel}>{vi ? 'Hiệu ứng tương tác' : 'Interactive effects'}</span>
                <span className={styles.toggleHint}>{vi ? 'Tắt để giữ hình ảnh mà thế giới không phản ứng với con trỏ.' : 'Off keeps the art, without reacting to your pointer.'}</span>
              </span>
              <Switch on={interactive} onChange={setInteractive} label={vi ? 'Hiệu ứng tương tác' : 'Interactive effects'} testid="world-interactive" />
            </div>
            <div className={styles.toggleRow}>
              <span>
                <span className={styles.toggleLabel}>{vi ? 'Ảnh tĩnh' : 'Still picture'}</span>
                <span className={styles.toggleHint}>{vi ? 'Một khung hình đẹp, không chuyển động.' : 'One beautiful frame, no motion.'}</span>
              </span>
              <Switch on={still} onChange={setStill} label={vi ? 'Ảnh tĩnh' : 'Still picture'} testid="world-still" />
            </div>

            <Segmented
              label={vi ? 'Chế độ tập trung' : 'Focus mode'}
              hint={focusMode === 'auto' ? (vi ? 'Tự dịu đi khi bạn đọc, nghe, viết hay làm bài.' : 'Calms down by itself while you read, listen, write or practise.') : focusMode === 'on' ? (vi ? 'Luôn dịu, mọi lúc.' : 'Always calm.') : vi ? 'Luôn giữ nguyên như bạn chỉnh.' : 'Always stays as you set it.'}
              value={focusMode}
              onChange={setFocusMode}
              testid="world-focus"
              options={[
                { value: 'auto', label: vi ? 'Tự động' : 'Auto' },
                { value: 'on', label: vi ? 'Luôn bật' : 'Always' },
                { value: 'off', label: vi ? 'Tắt' : 'Off' },
              ]}
            />
            <Segmented
              label={vi ? 'Giao diện' : 'Appearance'}
              value={appearance}
              onChange={setAppearance}
              testid="world-appearance"
              options={[
                { value: 'system', label: vi ? 'Theo hệ thống' : 'System' },
                { value: 'light', label: vi ? 'Sáng' : 'Light' },
                { value: 'dark', label: vi ? 'Tối' : 'Dark' },
              ]}
            />
            <Segmented
              label={vi ? 'Màu kính' : 'Glass colour'}
              value={glass}
              onChange={setGlass}
              testid="world-glass"
              options={[
                { value: 'auto', label: vi ? 'Theo cảnh' : 'Scene' },
                { value: 'neutral', label: vi ? 'Trung tính' : 'Neutral' },
                { value: 'ocean', label: vi ? 'Đại dương' : 'Ocean' },
                { value: 'dusk', label: vi ? 'Hoàng hôn' : 'Dusk' },
                { value: 'forest', label: vi ? 'Rừng' : 'Forest' },
              ]}
            />
          </div>

          <div className={styles.actions}>
            {problem && <p className={styles.problem} role="alert">{problem}</p>}
            <button type="button" className={styles.primary} onClick={apply} disabled={applying} data-testid="world-apply">
              {applying ? (vi ? 'Đang khởi động thế giới…' : 'Starting the world…') : appliedWorld === world.id ? (vi ? 'Lưu tuỳ chỉnh' : 'Save tuning') : vi ? 'Áp dụng thế giới này' : 'Apply this world'}
            </button>
            <div className={styles.secondaryRow}>
              {saved.lastMedia && (
                <button type="button" className={styles.linkButton} onClick={backToWallpaper} data-testid="world-back-wallpaper">{vi ? 'Về hình nền trước' : 'Back to my wallpaper'}</button>
              )}
              <button type="button" className={styles.linkButton} onClick={close}>{vi ? 'Hủy' : 'Cancel'}</button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Slider({ label, value, onChange, disabled, testid }: { label: string; value: number; onChange: (value: number) => void; disabled?: boolean; testid: string }) {
  const percent = Math.round(value * 100);
  return (
    <label className={`${styles.slider} ${disabled ? styles.sliderOff : ''}`}>
      <span className={styles.sliderHead}>
        <span>{label}</span>
        <span className={styles.sliderValue}>{percent}%</span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        style={{ '--fill': `${percent}%` } as React.CSSProperties}
        aria-valuetext={`${percent}%`}
        data-testid={testid}
      />
    </label>
  );
}

function Switch({ on, onChange, label, testid }: { on: boolean; onChange: (next: boolean) => void; label: string; testid: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`${styles.switch} ${on ? styles.switchOn : ''}`} onClick={() => onChange(!on)} data-testid={testid}>
      <span />
    </button>
  );
}

function Segmented<T extends string>({ label, hint, value, onChange, options, testid }: { label: string; hint?: string; value: T; onChange: (value: T) => void; options: { value: T; label: string }[]; testid: string }) {
  return (
    <div className={styles.segmentBlock}>
      <span className={styles.toggleLabel}>{label}</span>
      <div className={styles.segments} role="group" aria-label={label} data-testid={testid}>
        {options.map((option) => (
          <button key={option.value} type="button" aria-pressed={value === option.value} className={`${styles.segment} ${value === option.value ? styles.segmentOn : ''}`} onClick={() => onChange(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
      {hint && <span className={styles.toggleHint}>{hint}</span>}
    </div>
  );
}
