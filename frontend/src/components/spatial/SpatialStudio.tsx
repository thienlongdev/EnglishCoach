'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Heart, Play, Search } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { PALETTES, SPATIAL_CATEGORIES, SPATIAL_PRESETS, findSpatialPreset } from '@/lib/spatial/catalog';
import type { SpatialProfile } from '@/lib/spatial/context';
import type { SpatialController, SpatialStatus } from '@/lib/spatial/engine/controller';
import StudioBar, { type StudioRoom } from '@/components/wallpaper/StudioBar';
import { accountOfKey, applySpatialAppearance, currentAppearance } from '@/lib/appearance/state';
import { DEFAULT_SPATIAL, setSpatialDraft, spatialKey, storedSpatial, type SpatialPreference } from '@/lib/spatial/preference';
import { spatialThumb } from '@/lib/spatial/thumbs';
import type { SpatialCategory, SpatialPreset } from '@/lib/spatial/types';
import styles from './SpatialStudio.module.css';
import '@/lib/spatial/spatial.css';

/**
 * Không gian 3D: the third room of the Giao diện dialog. The gallery shows stills (real frames of each preset); only the one preset in focus has a renderer, and it runs on the page itself: the
 * sample workspace on the left is walked by the same engine as the real pages, so its cards tilt, light up and take part in the scene exactly as yours will. Nothing is stored until "Áp dụng", which
 * makes this the one active appearance. "Thử trên trang" shows the preset on your real pages from memory only (a wallpaper rests meanwhile); a bar lets you keep or undo it.
 */

type Filter = 'all' | 'favourites' | 'recent' | SpatialCategory;

const PREVIEW_PROFILE: SpatialProfile = { id: 'preview', env: 'live', surfaces: 'play', transition: 'full', type: true, overlay: true, lens: false, calm: 0 };
const SAMPLE_ART = ['/assets/flashcards/deck-animals-640-203c2221.webp', '/assets/flashcards/deck-environment-640-a15da6b6.webp', '/assets/flashcards/deck-culture-640-7e0cae2b.webp', '/assets/flashcards/deck-education-640-ed77828f.webp'];

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

function useReduced(): boolean {
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

function readList(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(raw) ? raw.filter((id) => findSpatialPreset(id)) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Storage denied: it still holds for this visit.
  }
}

function Slider({ label, value, onChange, testid }: { label: string; value: number; onChange: (v: number) => void; testid: string }) {
  return (
    <label className={styles.slider}>
      <span>{label}</span>
      <input type="range" min={0} max={1} step={0.01} value={value} data-testid={testid} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Segments<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; text: string }[]; onChange: (v: T) => void }) {
  return (
    <div className={styles.segmentRow} role="group" aria-label={label}>
      <span className={styles.segmentLabel}>{label}</span>
      <div className={styles.segments}>
        {options.map((option) => (
          <button key={option.id} type="button" className={`${styles.segment} ${value === option.id ? styles.segmentOn : ''}`} aria-pressed={value === option.id} onClick={() => onChange(option.id)}>
            {option.text}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SpatialStudio({ storageKey, onClose, onOpenRoom }: { storageKey: string; onClose: () => void; onOpenRoom: (room: StudioRoom) => void }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const dark = useAppDark();
  const reduced = useReduced();
  const account = accountOfKey(storageKey);
  const key = spatialKey(account);
  const saved = useMemo(() => storedSpatial(key), [key]);
  const activeNow = useMemo(() => currentAppearance(account), [account]);
  const inUse = activeNow.mode === 'spatial' ? activeNow.selectionId : null;

  const [focusId, setFocusId] = useState(saved.presetId);
  const [draft, setDraft] = useState<SpatialPreference>({ ...saved });
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [favourites, setFavourites] = useState<string[]>(() => readList(`${key}:fav`));
  const [recent, setRecent] = useState<string[]>(() => readList(`${key}:recent`));
  const [status, setStatus] = useState<SpatialStatus>({ scene: 'idle' });
  const [panelsHidden, setPanelsHidden] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const preset = findSpatialPreset(focusId) ?? findSpatialPreset(DEFAULT_SPATIAL.presetId)!;
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const controllerRef = useRef<SpatialController | null>(null);
  const previewPref = useMemo<SpatialPreference>(() => ({ ...draft, enabled: true, presetId: preset.id }), [draft, preset.id]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // One preview engine for the whole visit; the preset in focus reaches it as data.
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    const layer = layerRef.current;
    const page = pageRef.current;
    const attrRoot = rootRef.current;
    if (!host || !layer || !page || !attrRoot) return;
    import('@/lib/spatial/engine/controller').then(({ createSpatialController }) => {
      if (cancelled) return;
      const controller = createSpatialController({
        host,
        root: page,
        scroller: page,
        layer,
        attrRoot,
        preset,
        pref: previewPref,
        profile: PREVIEW_PROFILE,
        sceneAllowed: true,
        dark,
        reduced,
        onStatus: setStatus,
      });
      controllerRef.current = controller;
      (window as unknown as { __spatialPreview?: unknown }).__spatialPreview = controller;
    });
    return () => {
      cancelled = true;
      controllerRef.current?.dispose();
      controllerRef.current = null;
      (window as unknown as { __spatialPreview?: unknown }).__spatialPreview = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    controllerRef.current?.update({ preset, pref: previewPref, dark, reduced });
  }, [preset, previewPref, dark, reduced]);

  const choose = useCallback(
    (id: string) => {
      setFocusId(id);
      setRecent((list) => {
        const next = [id, ...list.filter((other) => other !== id)].slice(0, 12);
        writeList(`${key}:recent`, next);
        return next;
      });
    },
    [key],
  );
  const toggleFavourite = (id: string) => {
    setFavourites((list) => {
      const next = list.includes(id) ? list.filter((other) => other !== id) : [id, ...list];
      writeList(`${key}:fav`, next);
      return next;
    });
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SPATIAL_PRESETS.filter((p) => {
      if (filter === 'favourites' && !favourites.includes(p.id)) return false;
      if (filter === 'recent' && !recent.includes(p.id)) return false;
      if (filter !== 'all' && filter !== 'favourites' && filter !== 'recent' && p.category !== filter) return false;
      if (!q) return true;
      return `${p.titleVi} ${p.titleEn} ${p.descVi} ${p.descEn} ${p.code}`.toLowerCase().includes(q);
    });
  }, [filter, query, favourites, recent]);

  // A preset this device could not run is not applied: what is on now stays on.
  const refuseIfFailed = () => {
    if (status.scene !== 'failed') return false;
    setProblem(vi ? 'Thiết bị này chưa chạy được cảnh 3D của mục này. Giao diện đang dùng được giữ nguyên.' : 'This device cannot run this 3D scene. What is in use stays on.');
    return true;
  };
  const apply = () => {
    if (refuseIfFailed()) return;
    applySpatialAppearance(account, { ...draft, enabled: true, presetId: preset.id });
    onClose();
  };
  const tryLive = () => {
    if (refuseIfFailed()) return;
    setSpatialDraft(key, { ...draft, enabled: true, presetId: preset.id });
    onClose();
  };

  const applied = inUse === preset.id;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input,a[href]') ?? []).filter((n) => n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const qualityOptions: { id: SpatialPreference['quality']; text: string }[] = [
    { id: 'auto', text: vi ? 'Tự động' : 'Auto' },
    { id: 'high', text: vi ? 'Cao' : 'High' },
    { id: 'balanced', text: vi ? 'Vừa' : 'Balanced' },
    { id: 'low', text: vi ? 'Nhẹ' : 'Light' },
  ];
  const focusOptions: { id: SpatialPreference['focus']; text: string }[] = [
    { id: 'auto', text: vi ? 'Theo trang' : 'By page' },
    { id: 'on', text: vi ? 'Luôn yên tĩnh' : 'Always quiet' },
    { id: 'off', text: vi ? 'Tắt' : 'Off' },
  ];

  const sceneNote =
    status.scene === 'failed'
      ? vi
        ? 'Thiết bị này chưa chạy được cảnh 3D của mục này. Thẻ, ánh sáng và chuyển cảnh vẫn hoạt động.'
        : 'This device cannot run this 3D scene. Cards, light and transitions still work.'
      : status.scene === 'loading'
        ? vi
          ? 'Đang dựng cảnh…'
          : 'Building the scene…'
        : reduced
          ? vi
            ? 'Bạn đang bật giảm chuyển động: chỉ một khung hình tĩnh, không có chuyển động.'
            : 'Reduced motion is on: one still frame, no movement.'
          : '';
  const replaces = activeNow.mode === 'wallpaper' ? (vi ? 'hình nền' : 'your wallpaper') : activeNow.mode === 'world' ? (vi ? 'thế giới sống' : 'your living world') : '';

  return (
    <div ref={rootRef} className={styles.studio} role="dialog" aria-modal="true" aria-labelledby="spatial-studio-title" data-testid="spatial-studio" onKeyDown={onKeyDown} style={{ '--accent': `rgb(${PALETTES[preset.palette].tint})` } as React.CSSProperties}>
      <div ref={hostRef} className={styles.stage} aria-hidden="true" data-testid="spatial-preview-host" data-scene={status.scene} />

      <StudioBar room="spatial" onRoom={onOpenRoom} storageKey={storageKey} vi={vi} closeRef={closeRef} onClose={onClose}>
        <button type="button" className={styles.ghostButton} onClick={() => controllerRef.current?.rehearseTransition()} data-testid="spatial-rehearse">
          <Play className="h-4 w-4" aria-hidden="true" />
          <span>{vi ? 'Xem chuyển cảnh' : 'Play the transition'}</span>
        </button>
        <button type="button" className={styles.ghostButton} onClick={() => setPanelsHidden((on) => !on)} aria-pressed={panelsHidden}>
          <span>{panelsHidden ? (vi ? 'Hiện thư viện' : 'Show library') : vi ? 'Ẩn thư viện' : 'Hide library'}</span>
        </button>
      </StudioBar>

      <div className={`${styles.body} ${panelsHidden ? styles.bodyWide : ''}`}>
        {/* The sample workspace: walked by the same engine as your real pages. */}
        <div ref={pageRef} className={styles.sample} data-testid="spatial-sample">
          <div className={styles.samplePage}>
            <p className={styles.sampleTag}>{vi ? 'Trang mẫu để xem trước' : 'A sample page, for previewing'}</p>
            <h2 className={styles.sampleTitle}>{vi ? 'Học tiếng Anh trong không gian của bạn' : 'Learn English in your own space'}</h2>
            <div className={styles.sampleStats}>
              {[vi ? 'Chuỗi ngày học' : 'Learning streak', vi ? 'Thẻ cần ôn' : 'Cards to review', vi ? 'Bài nghe' : 'Listening'].map((label, i) => (
                <div key={label} className={styles.sampleStat}>
                  <span className={styles.sampleStatValue}>{['—', '—', '—'][i]}</span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <div className={styles.sampleGrid}>
              {SAMPLE_ART.map((src, i) => (
                <a key={src} href="#preview" className={styles.sampleCard} onClick={(e) => { e.preventDefault(); controllerRef.current?.rehearseTransition(); }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" decoding="async" />
                  <strong>{[vi ? 'Thẻ từ vựng' : 'Flashcards', vi ? 'Luyện đọc' : 'Reading', vi ? 'Luyện nghe' : 'Listening', vi ? 'Thi thử' : 'Exams'][i]}</strong>
                  <span>{vi ? 'Trỏ vào hoặc bấm để xem hiệu ứng' : 'Hover or press to see the effect'}</span>
                </a>
              ))}
            </div>
            <div className={styles.sampleNote} data-spatial-exclude="">
              <p>{vi ? 'Ô nhập liệu, video và bài học được giữ nguyên: Không gian 3D không chạm vào những phần này.' : 'Fields, videos and lessons stay exactly as they are: 3D space never touches them.'}</p>
              <input type="text" aria-label={vi ? 'Ô nhập mẫu' : 'Sample field'} placeholder={vi ? 'Thử gõ ở đây' : 'Try typing here'} />
            </div>
          </div>
        </div>

        {!panelsHidden && (
          <aside className={styles.library} aria-label={vi ? 'Thư viện Không gian 3D' : '3D space library'}>
            <div className={styles.libraryHead}>
              <div>
                <h2 id="spatial-studio-title" className={styles.heading}>{vi ? 'Không gian 3D' : '3D space'}</h2>
                <p className={styles.sub}>{vi ? `${SPATIAL_PRESETS.length} trải nghiệm chạy ngay trên máy của bạn. Mặc định tắt.` : `${SPATIAL_PRESETS.length} experiences that run on your own device. Off by default.`}</p>
              </div>
            </div>

            <div className={styles.searchRow}>
              <Search className="h-4 w-4" aria-hidden="true" />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={vi ? 'Tìm hiệu ứng' : 'Search effects'} aria-label={vi ? 'Tìm hiệu ứng' : 'Search effects'} data-testid="spatial-search" />
            </div>
            <div className={styles.chips} role="group" aria-label={vi ? 'Lọc' : 'Filter'}>
              {([['all', vi ? 'Tất cả' : 'All'], ['favourites', vi ? 'Yêu thích' : 'Favourites'], ['recent', vi ? 'Gần đây' : 'Recent']] as [Filter, string][]).concat(SPATIAL_CATEGORIES.map((c) => [c.id, vi ? c.vi : c.en])).map(([id, text]) => (
                <button key={id} type="button" className={`${styles.chip} ${filter === id ? styles.chipOn : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)} data-testid={`spatial-filter-${id}`}>
                  {text}
                </button>
              ))}
            </div>

            <div className={styles.grid} data-testid="spatial-grid">
              {shown.map((p: SpatialPreset) => {
                const thumb = spatialThumb(p.id);
                const tones = PALETTES[p.palette].dark;
                return (
                  <div key={p.id} className={`${styles.card} ${p.id === preset.id ? styles.cardOn : ''}`}>
                    <button type="button" className={styles.cardMain} onClick={() => choose(p.id)} aria-pressed={p.id === preset.id} data-testid={`spatial-card-${p.id}`} data-code={p.code}>
                      <span className={styles.thumb} style={{ background: `linear-gradient(135deg, ${tones[1]}, ${tones[2]} 70%, ${tones[3]})` }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {thumb && <img src={thumb} alt="" loading="lazy" decoding="async" />}
                        {inUse === p.id && (
                          <span className={styles.usedMark} title={vi ? 'Đang dùng' : 'In use'}>
                            <Check className="h-3 w-3" aria-hidden="true" />
                          </span>
                        )}
                      </span>
                      <span className={styles.cardTitle}>{vi ? p.titleVi : p.titleEn}</span>
                    </button>
                    <button type="button" className={`${styles.heart} ${favourites.includes(p.id) ? styles.heartOn : ''}`} onClick={() => toggleFavourite(p.id)} aria-pressed={favourites.includes(p.id)} aria-label={vi ? `Yêu thích ${p.titleVi}` : `Favourite ${p.titleEn}`}>
                      <Heart className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
              {!shown.length && <p className={styles.empty}>{vi ? 'Chưa có mục nào ở đây.' : 'Nothing here yet.'}</p>}
            </div>

            <div className={styles.details}>
              <p className={styles.detailTitle}>
                <span>{vi ? preset.titleVi : preset.titleEn}</span>
                <span className={styles.detailTech}>{preset.tech}</span>
              </p>
              <p className={styles.detailText}>{vi ? preset.descVi : preset.descEn}</p>
              <p className={styles.detailTouch}>{vi ? preset.touchVi : preset.touchEn}</p>
              {preset.lens && <p className={styles.detailTouch}>{vi ? 'Ở các trang có danh sách (Đọc, Nghe, Thẻ từ vựng, Trò chơi…) sẽ có nút mở phòng trưng bày nội dung thật của trang.' : 'Pages with lists (Reading, Listening, Flashcards, Games…) get a button that opens a gallery room of their real items.'}</p>}
              {sceneNote && <p className={styles.detailTouch} role="status">{sceneNote}</p>}
              {replaces && <p className={styles.detailTouch}>{vi ? `Áp dụng sẽ thay ${replaces} đang dùng. Lựa chọn đó vẫn được nhớ.` : `Applying replaces ${replaces}. That choice stays remembered.`}</p>}
              {problem && <p className={styles.detailTouch} role="alert">{problem}</p>}
              <div className={styles.sliders}>
                <Slider label={vi ? 'Chuyển động' : 'Motion'} value={draft.motion} onChange={(motion) => setDraft((d) => ({ ...d, motion }))} testid="spatial-motion" />
                <Slider label={vi ? 'Con trỏ' : 'Pointer'} value={draft.pointer} onChange={(pointer) => setDraft((d) => ({ ...d, pointer }))} testid="spatial-pointer" />
                <Slider label={vi ? 'Chiều sâu' : 'Depth'} value={draft.depth} onChange={(depth) => setDraft((d) => ({ ...d, depth }))} testid="spatial-depth" />
                <Slider label={vi ? 'Chất liệu' : 'Material'} value={draft.material} onChange={(material) => setDraft((d) => ({ ...d, material }))} testid="spatial-material" />
              </div>
              <Segments label={vi ? 'Chất lượng' : 'Quality'} value={draft.quality} options={qualityOptions} onChange={(quality) => setDraft((d) => ({ ...d, quality }))} />
              <Segments label={vi ? 'Khi học tập trung' : 'While focusing'} value={draft.focus} options={focusOptions} onChange={(focus) => setDraft((d) => ({ ...d, focus }))} />
            </div>

            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={tryLive} data-testid="spatial-try">{vi ? 'Thử trên trang' : 'Try on my pages'}</button>
              <button type="button" className={styles.primary} onClick={apply} data-testid="spatial-apply">{applied ? (vi ? 'Lưu thay đổi' : 'Save changes') : vi ? 'Áp dụng' : 'Apply'}</button>
            </div>
            <p className={styles.keyHint}>{vi ? 'Tắt nhanh ở bất kỳ đâu: Alt + Shift + X. Lựa chọn lưu trên trình duyệt này.' : 'Quick off, anywhere: Alt + Shift + X. Your choice is kept in this browser.'}</p>
          </aside>
        )}
      </div>
      <div ref={layerRef} className={styles.layer} aria-hidden="true" />
    </div>
  );
}
