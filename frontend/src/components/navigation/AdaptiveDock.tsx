'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { LayoutGrid, Search, SlidersHorizontal, Star, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import { useAdminFeedbackUnreadCount } from '@/hooks/useFeedback';
import { OceanGlyphDefs, type GlyphTone } from '@/components/layout/OceanCurrent';
import { openWallpaperStudio } from '@/lib/wallpaper/storage';
import { isRootModuleHref } from '@/lib/navigation/routes';
import {
  authorizedDestinations,
  handleSharedModuleNavigate,
  navCategoryLabel,
  navLabel,
  resolveActiveNavId,
  type NavCategory,
  type NavDestination,
} from '@/lib/navigation/registry';
import {
  DEFAULT_NAV_PREFERENCES,
  currentNavPreferences,
  moveDockItemByOffset,
  navStorageKey,
  reorderDockItems,
  subscribeNavPreferences,
  toggleDockPinned,
} from '@/lib/navigation/preferences';
import { useAutoHideSurface } from '@/lib/navigation/useAutoHideSurface';
import styles from './AdaptiveDock.module.css';

const MAG_RADIUS = 132;
const MAG_BOOST = 0.48;
const SPRING_K = 390;
const SPRING_C = 29;

function tonePaint(tone: GlyphTone): string {
  return `url(#ec-og-${tone})`;
}

export default function AdaptiveDock() {
  const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const { locale, t } = useLanguage();
  const vi = locale === 'vi';
  const { isAdmin } = useCurrentRole();
  const { unreadCount: adminFeedbackUnread } = useAdminFeedbackUnreadCount();

  const userId = session?.user ? String((session.user as { id?: string | number }).id ?? '') : '';
  const storageKey = navStorageKey(userId);

  const prefs = useSyncExternalStore(
    (cb) => subscribeNavPreferences(storageKey, cb),
    () => currentNavPreferences(storageKey),
    () => DEFAULT_NAV_PREFERENCES,
  );

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [narrowScreen, setNarrowScreen] = useState(false);

  const capsuleRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const libraryBtnRef = useRef<HTMLButtonElement | null>(null);
  const libraryPanelRef = useRef<HTMLDivElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);
  const dragStateRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    moved: boolean;
    offsetX: number;
    el: HTMLElement;
  } | null>(null);
  const suppressClickUntilRef = useRef(0);
  const libraryTitleId = useId();

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const sync = () => setNarrowScreen(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const activeId = resolveActiveNavId(pathname, searchParams.get('tab'));
  const shownId = pendingId ?? activeId;

  useEffect(() => {
    if (pendingId === activeId) setPendingId(null);
  }, [activeId, pendingId]);

  useEffect(() => {
    if (!pendingId) return;
    const timer = window.setTimeout(() => setPendingId(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [pendingId]);

  // Close App Library on route change
  useEffect(() => {
    setLibraryOpen(false);
  }, [pathname, searchParams, prefs.layout]);

  const authorized = useMemo(() => authorizedDestinations(isAdmin), [isAdmin]);
  const authorizedMap = useMemo(() => new Map(authorized.map((d) => [d.id, d])), [authorized]);

  const pinnedItems = useMemo(() => {
    const pinnedSet = new Set(prefs.dockPinned);
    const ordered: NavDestination[] = [];
    for (const id of prefs.dockOrder) {
      if (!pinnedSet.has(id)) continue;
      const dest = authorizedMap.get(id);
      if (dest) ordered.push(dest);
    }
    return ordered;
  }, [prefs.dockOrder, prefs.dockPinned, authorizedMap]);

  // Like macOS Dock: if the active route is not pinned, surface it right before the utility cluster!
  const transientActiveItem = useMemo(() => {
    const candidate = authorizedMap.get(shownId);
    if (!candidate) return null;
    if (pinnedItems.some((item) => item.id === candidate.id)) return null;
    return candidate;
  }, [authorizedMap, shownId, pinnedItems]);

  const autoHide = useAutoHideSurface({
    surface: 'dock',
    visibility: prefs.visibility,
    lockedOpen: prefs.layout === 'dock' && (libraryOpen || draggingId !== null),
  });

  // App Library Escape + outside click
  useEffect(() => {
    if (!libraryOpen) return;
    libraryInputRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setLibraryOpen(false);
        libraryBtnRef.current?.focus({ preventScroll: true });
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (libraryPanelRef.current?.contains(target) || libraryBtnRef.current?.contains(target)) return;
      setLibraryOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [libraryOpen]);

  // ── Distance-based macOS magnification (rAF spring, zero React renders per frame) ──
  const pointerXRef = useRef<number | null>(null);
  const kickMagnifierRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (prefs.layout !== 'dock') return;
    const capsule = capsuleRef.current;
    if (!capsule) return;

    const fineMq = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');

    type SlotTrack = { el: HTMLElement; restX: number; p: number; v: number; t: number };
    let tracks: SlotTrack[] = [];
    let raf = 0;
    let lastNow = 0;

    const collectTracks = () => {
      const nodes = Array.from(capsule.querySelectorAll<HTMLElement>('[data-dock-magnify]'));
      const prevMap = new Map(tracks.map((tr) => [tr.el, tr]));
      tracks = nodes.map((el) => {
        const prev = prevMap.get(el);
        // Temporarily read layout center independent of current transform
        const rect = el.getBoundingClientRect();
        const currentScale = prev ? prev.p : 1;
        const baseW = rect.width / Math.max(0.5, currentScale);
        const cx = rect.left + rect.width / 2;
        return {
          el,
          restX: prev && Math.abs(prev.p - 1) > 0.02 ? prev.restX : cx,
          p: prev ? prev.p : 1,
          v: prev ? prev.v : 0,
          t: 1,
        };
        void baseW;
      });
      // Recompute clean restX when near rest
      if (tracks.every((tr) => Math.abs(tr.p - 1) < 0.02)) {
        tracks.forEach((tr) => {
          const r = tr.el.getBoundingClientRect();
          tr.restX = r.left + r.width / 2;
        });
      }
    };

    const applyTransforms = () => {
      const n = tracks.length;
      if (n === 0) return;
      // Compute horizontal neighbor displacement so magnified icons never overlap
      const extraWidths = tracks.map((tr) => (tr.p - 1) * 40);
      const totalExtra = extraWidths.reduce((sum, w) => sum + w, 0);
      let acc = -totalExtra / 2;
      for (let i = 0; i < n; i++) {
        const tr = tracks[i];
        if (dragStateRef.current?.el === tr.el && dragStateRef.current.moved) {
          acc += extraWidths[i];
          continue;
        }
        const dx = acc + extraWidths[i] / 2;
        acc += extraWidths[i];
        const lift = -(tr.p - 1) * 14;
        if (Math.abs(tr.p - 1) < 0.003 && Math.abs(dx) < 0.2) {
          tr.el.style.transform = '';
        } else {
          tr.el.style.transform = `translate3d(${dx.toFixed(2)}px, ${lift.toFixed(2)}px, 0) scale(${tr.p.toFixed(3)})`;
        }
      }
    };

    const updateTargets = () => {
      const px = pointerXRef.current;
      const canMagnify =
        px !== null &&
        fineMq.matches &&
        !reduceMq.matches &&
        !dragStateRef.current?.moved &&
        window.innerWidth >= 768;

      if (!canMagnify) {
        for (const tr of tracks) tr.t = 1;
        return;
      }
      for (const tr of tracks) {
        const dist = Math.abs(px - tr.restX);
        if (dist >= MAG_RADIUS) {
          tr.t = 1;
        } else {
          const wave = 0.5 * (1 + Math.cos((Math.PI * dist) / MAG_RADIUS));
          tr.t = 1 + MAG_BOOST * Math.pow(wave, 1.35);
        }
      }
    };

    const step = (now: number) => {
      raf = 0;
      const dt = Math.min(0.032, Math.max(0.001, (now - lastNow) / 1000));
      lastNow = now;
      updateTargets();

      let allSettled = true;
      for (const tr of tracks) {
        for (let sub = 0; sub < 2; sub++) {
          const h = dt / 2;
          tr.v += (SPRING_K * (tr.t - tr.p) - SPRING_C * tr.v) * h;
          tr.p += tr.v * h;
        }
        if (Math.abs(tr.t - tr.p) > 0.0025 || Math.abs(tr.v) > 0.015) {
          allSettled = false;
        } else {
          tr.p = tr.t;
          tr.v = 0;
        }
      }

      applyTransforms();

      if (allSettled && pointerXRef.current === null) {
        // Refresh clean rest centers when settled back at 1
        tracks.forEach((tr) => {
          tr.el.style.transform = '';
          const r = tr.el.getBoundingClientRect();
          tr.restX = r.left + r.width / 2;
        });
        return;
      }
      if (!allSettled) {
        raf = window.requestAnimationFrame(step);
      }
    };

    const kick = () => {
      if (tracks.length === 0) collectTracks();
      if (raf) return;
      lastNow = performance.now();
      raf = window.requestAnimationFrame(step);
    };
    kickMagnifierRef.current = kick;

    collectTracks();
    const ro = new ResizeObserver(() => {
      if (pointerXRef.current === null) collectTracks();
    });
    ro.observe(capsule);
    window.addEventListener('resize', collectTracks, { passive: true });

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', collectTracks);
      tracks.forEach((tr) => {
        tr.el.style.transform = '';
      });
    };
  }, [prefs.layout, pinnedItems, transientActiveItem]);

  const showTipFor = useCallback((el: HTMLElement, text: string) => {
    const r = el.getBoundingClientRect();
    setTip({
      text,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top - 10),
    });
  }, []);

  // ── Pointer drag-and-drop reordering for pinned items ──
  const beginPinnedDrag = (event: React.PointerEvent<HTMLElement>, itemId: string) => {
    if (event.button !== 0 || event.pointerType === 'touch' || pinnedItems.length < 2) return;
    const el = event.currentTarget;
    dragStateRef.current = {
      id: itemId,
      pointerId: event.pointerId,
      startX: event.clientX,
      moved: false,
      offsetX: 0,
      el,
    };
  };

  const movePinnedDrag = (event: React.PointerEvent<HTMLElement>) => {
    const st = dragStateRef.current;
    if (!st || st.pointerId !== event.pointerId) return;
    const dx = event.clientX - st.startX;
    if (!st.moved && Math.abs(dx) > 7) {
      st.moved = true;
      setDraggingId(st.id);
      setTip(null);
      try {
        st.el.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture error
      }
      pointerXRef.current = null;
      kickMagnifierRef.current();
    }
    if (!st.moved) return;

    st.offsetX = dx;
    st.el.style.transform = `translate3d(${dx.toFixed(1)}px, -8px, 0) scale(1.1)`;

    // Hit-test sibling pinned items to reorder live
    const strip = stripRef.current;
    if (!strip) return;
    const siblings = Array.from(strip.querySelectorAll<HTMLElement>('[data-dock-pinned-id]'));
    for (const sib of siblings) {
      const targetId = sib.getAttribute('data-dock-pinned-id');
      if (!targetId || targetId === st.id) continue;
      const box = sib.getBoundingClientRect();
      const mid = box.left + box.width / 2;
      if (
        (dx > 0 && event.clientX > mid && box.left >= st.el.getBoundingClientRect().left - 24) ||
        (dx < 0 && event.clientX < mid && box.right <= st.el.getBoundingClientRect().right + 24)
      ) {
        reorderDockItems(storageKey, st.id, targetId);
        st.startX = event.clientX;
        st.el.style.transform = 'translate3d(0px, -8px, 0) scale(1.1)';
        break;
      }
    }
  };

  const endPinnedDrag = (event: React.PointerEvent<HTMLElement>) => {
    const st = dragStateRef.current;
    if (!st || st.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    if (st.moved) {
      suppressClickUntilRef.current = performance.now() + 260;
      st.el.style.transform = '';
      setDraggingId(null);
      try {
        if (st.el.hasPointerCapture(event.pointerId)) st.el.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    }
  };

  // Filtered groups for App Library (declared before early return to obey Rules of Hooks)
  const filteredGroups = useMemo(() => {
    const q = libraryQuery.trim().toLocaleLowerCase(vi ? 'vi' : 'en');
    const categories: NavCategory[] = isAdmin
      ? ['learning', 'sharing', 'personalize', 'admin']
      : ['learning', 'sharing', 'personalize'];
    return categories
      .map((category) => {
        const items = authorized.filter((item) => {
          if (item.category !== category) return false;
          if (!q) return true;
          const label = `${navLabel(item, true)} ${navLabel(item, false)}`.toLocaleLowerCase(vi ? 'vi' : 'en');
          return label.includes(q);
        });
        return { category, items };
      })
      .filter((group) => group.items.length > 0);
  }, [authorized, isAdmin, libraryQuery, vi]);

  const pinnedSet = useMemo(() => new Set(prefs.dockPinned), [prefs.dockPinned]);

  if (prefs.layout !== 'dock') {
    return null;
  }

  const badgeCount = (id: string): number => (id === 'adminNotifications' ? adminFeedbackUnread : 0);

  const renderDockDestination = (item: NavDestination, isPinnedSlot: boolean) => {
    const Icon = item.icon;
    const baseLabel = navLabel(item, vi, t as unknown as Record<string, unknown>);
    const unread = badgeCount(item.id);
    const fullLabel = unread > 0 ? `${baseLabel} (${unread > 99 ? '99+' : unread})` : baseLabel;
    const isActive = activeId === item.id;
    const isShown = shownId === item.id && item.href !== null;
    const isPending = pendingId === item.id;
    const isDragging = draggingId === item.id;

    const onSlotKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
      if (isPinnedSlot && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        moveDockItemByOffset(
          storageKey,
          item.id,
          e.key === 'ArrowLeft' ? -1 : 1,
          pinnedItems.map((p) => p.id),
        );
      }
    };

    const sharedProps = {
      'data-dock-magnify': '',
      'data-dock-pinned-id': isPinnedSlot ? item.id : undefined,
      'data-nav-item-id': item.id,
      'data-guide': `nav-${item.id}`,
      'aria-label': fullLabel,
      className: [
        styles.slot,
        isShown ? styles.slotActive : '',
        isDragging ? styles.slotDragging : '',
      ]
        .filter(Boolean)
        .join(' '),
      onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
        setIntentId(item.id);
        if (!draggingId) showTipFor(e.currentTarget, fullLabel);
      },
      onMouseLeave: () => {
        setIntentId((cur) => (cur === item.id ? null : cur));
        setTip((cur) => (cur?.text === fullLabel ? null : cur));
      },
      onFocus: (e: React.FocusEvent<HTMLElement>) => {
        setIntentId(item.id);
        showTipFor(e.currentTarget, fullLabel);
      },
      onBlur: () => {
        setIntentId((cur) => (cur === item.id ? null : cur));
        setTip(null);
      },
      onKeyDown: onSlotKeyDown,
      onPointerDown: isPinnedSlot ? (e: React.PointerEvent<HTMLElement>) => beginPinnedDrag(e, item.id) : undefined,
      onPointerMove: isPinnedSlot ? movePinnedDrag : undefined,
      onPointerUp: isPinnedSlot ? endPinnedDrag : undefined,
      onPointerCancel: isPinnedSlot ? endPinnedDrag : undefined,
    };

    const inner = (
      <>
        <span className={styles.well} data-tone={item.tone} data-nav-morph-id={item.id} aria-hidden="true">
          {item.action === 'appearance' ? (
            <>
              <Icon className={`${styles.icon} ${isShown ? '' : item.iconColor} ${styles.wpIcon}`} stroke={tonePaint(item.tone)} />
              <span className={styles.wpSwatch} />
            </>
          ) : (
            <Icon className={`${styles.icon} ${isShown ? '' : item.iconColor}`} stroke={tonePaint(item.tone)} />
          )}
          {isPending && <span className={styles.pendingRing} />}
          {unread > 0 && <span className={styles.badge}>{unread > 99 ? '99+' : unread}</span>}
        </span>
        {isShown && <span className={styles.activeDot} aria-hidden="true" />}
      </>
    );

    if (item.action === 'appearance' || !item.href) {
      return (
        <button
          key={item.id}
          type="button"
          {...sharedProps}
          aria-haspopup="dialog"
          data-testid="dock-appearance"
          onClick={(e) => {
            if (performance.now() < suppressClickUntilRef.current) {
              e.preventDefault();
              return;
            }
            setTip(null);
            openWallpaperStudio();
          }}
        >
          {inner}
        </button>
      );
    }

    const href = item.href;
    return (
      <Link
        key={item.id}
        href={href}
        prefetch={!isRootModuleHref(href) && intentId === item.id ? null : false}
        scroll={false}
        aria-current={isActive ? 'page' : undefined}
        aria-busy={isPending || undefined}
        {...sharedProps}
        onClick={(e) => {
          if (performance.now() < suppressClickUntilRef.current) {
            e.preventDefault();
            return;
          }
          setTip(null);
        }}
        onNavigate={(event) => {
          if (performance.now() < suppressClickUntilRef.current) {
            event.preventDefault();
            return;
          }
          handleSharedModuleNavigate(event, item.id, href, activeId, pendingId, setPendingId, pathname);
        }}
      >
        {inner}
      </Link>
    );
  };

  const libraryLabel = vi ? 'Kho điều hướng' : 'App Library';

  return (
    <div className={styles.tokens} data-autohide-owner="dock">
      <OceanGlyphDefs />

      {/* Bottom viewport edge activation zone when Auto-Hide is active */}
      {autoHide.isAutoHide && (
        <button
          type="button"
          className={styles.edgeZone}
          aria-label={vi ? 'Hiện thanh Dock điều hướng' : 'Reveal navigation Dock'}
          data-testid="dock-edge-zone"
          data-nav-edge=""
          onClick={autoHide.toggleRevealTouch}
        >
          <span className={styles.touchPill} aria-hidden="true" />
        </button>
      )}

      {/* App Library / All Apps Launcher */}
      {libraryOpen && (
        <div
          ref={libraryPanelRef}
          className={styles.libraryBridge}
          data-nav-popover=""
          data-nav-hit=""
        >
          <div
            role="dialog"
            aria-modal="false"
            aria-labelledby={libraryTitleId}
            className={styles.libraryPanel}
            data-testid="dock-app-library"
          >
            <div className={styles.libraryHead}>
              <h2 id={libraryTitleId} className="sr-only">
                {libraryLabel}
              </h2>
              <label className={styles.librarySearch}>
                <Search className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
                <input
                  ref={libraryInputRef}
                  type="search"
                  value={libraryQuery}
                  onChange={(e) => setLibraryQuery(e.target.value)}
                  placeholder={vi ? 'Tìm nhanh mục điều hướng…' : 'Search destinations…'}
                  aria-label={vi ? 'Tìm mục điều hướng' : 'Search navigation'}
                  className={styles.libraryInput}
                  data-testid="dock-library-search"
                />
                {libraryQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setLibraryQuery('');
                      libraryInputRef.current?.focus();
                    }}
                    aria-label={vi ? 'Xóa tìm kiếm' : 'Clear search'}
                    className="grid h-5 w-5 place-items-center rounded-full opacity-70 hover:opacity-100 cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </label>
              <button
                type="button"
                className={styles.libraryCustomizeBtn}
                data-testid="dock-open-nav-settings"
                onClick={() => {
                  setLibraryOpen(false);
                  openWallpaperStudio('navigation');
                }}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{vi ? 'Tùy chỉnh Dock' : 'Customize Dock'}</span>
              </button>
            </div>

            <div className={styles.libraryBody}>
              {filteredGroups.map(({ category, items }) => (
                <section key={category}>
                  <h3 className={styles.librarySectionTitle}>{navCategoryLabel(category, vi)}</h3>
                  <div className={styles.libraryGrid}>
                    {items.map((item) => {
                      const Icon = item.icon;
                      const label = navLabel(item, vi, t as unknown as Record<string, unknown>);
                      const pinned = pinnedSet.has(item.id);
                      const isCurrent = activeId === item.id && item.href !== null;
                      return (
                        <div
                          key={item.id}
                          className={`${styles.libraryItem} ${isCurrent ? styles.libraryItemActive : ''}`}
                        >
                          {item.action === 'appearance' || !item.href ? (
                            <button
                              type="button"
                              className={styles.libraryLink}
                              onClick={() => {
                                setLibraryOpen(false);
                                openWallpaperStudio();
                              }}
                            >
                              <span className={styles.libraryMiniWell} data-tone={item.tone} aria-hidden="true">
                                <Icon className={`${styles.icon} ${item.iconColor}`} stroke={tonePaint(item.tone)} />
                              </span>
                              <span className="truncate">{label}</span>
                            </button>
                          ) : (
                            <Link
                              href={item.href}
                              prefetch={false}
                              scroll={false}
                              aria-current={isCurrent ? 'page' : undefined}
                              className={styles.libraryLink}
                              onNavigate={(event) =>
                                handleSharedModuleNavigate(
                                  event,
                                  item.id,
                                  item.href!,
                                  activeId,
                                  pendingId,
                                  setPendingId,
                                  pathname,
                                  () => setLibraryOpen(false),
                                )
                              }
                            >
                              <span className={styles.libraryMiniWell} data-tone={item.tone} aria-hidden="true">
                                <Icon className={`${styles.icon} ${item.iconColor}`} stroke={tonePaint(item.tone)} />
                              </span>
                              <span className="truncate">{label}</span>
                            </Link>
                          )}

                          <button
                            type="button"
                            aria-pressed={pinned}
                            title={pinned ? (vi ? 'Bỏ ghim khỏi Dock' : 'Unpin from Dock') : vi ? 'Ghim vào Dock' : 'Pin to Dock'}
                            aria-label={`${pinned ? (vi ? 'Bỏ ghim khỏi Dock' : 'Unpin from Dock') : vi ? 'Ghim vào Dock' : 'Pin to Dock'}: ${label}`}
                            onClick={() => toggleDockPinned(storageKey, item.id)}
                            className={`${styles.libraryPinBtn} ${pinned ? styles.libraryPinOn : ''}`}
                            data-testid={`dock-library-pin-${item.id}`}
                          >
                            <Star className="h-3.5 w-3.5" fill={pinned ? 'currentColor' : 'none'} aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
              {filteredGroups.length === 0 && (
                <p className={styles.libraryEmpty}>
                  {vi ? 'Không tìm thấy mục điều hướng phù hợp.' : 'No matching destination found.'}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Floating Liquid Glass Dock */}
      <nav
        aria-label={vi ? 'Điều hướng chính (Dock)' : 'Main navigation Dock'}
        data-purpose="main-navigation-dock"
        data-guide="sidebar-nav"
        data-echo-clear={narrowScreen && autoHide.isRevealed ? '' : undefined}
        className={`${styles.dockAnchor} ${!autoHide.isRevealed ? styles.dockHidden : ''}`}
        data-nav-hit=""
      >
        <span className={styles.hoverBridge} aria-hidden="true" />
        <div
          ref={capsuleRef}
          data-nav-surface="dock"
          data-sp-shell=""
          className={styles.capsule}
          onPointerMove={(e) => {
            if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
              pointerXRef.current = e.clientX;
              kickMagnifierRef.current();
            }
          }}
          onPointerLeave={() => {
            pointerXRef.current = null;
            kickMagnifierRef.current();
            setTip(null);
          }}
        >
          <div ref={stripRef} className={styles.pinnedStrip} data-testid="dock-pinned-strip">
            {pinnedItems.map((item) => renderDockDestination(item, true))}
          </div>

          {transientActiveItem && (
            <>
              <span className={styles.separator} aria-hidden="true" />
              {renderDockDestination(transientActiveItem, false)}
            </>
          )}

          <span className={styles.separator} aria-hidden="true" />

          <div className={styles.utilityCluster}>
            {/* App Library launcher */}
            <button
              ref={libraryBtnRef}
              type="button"
              data-dock-magnify=""
              data-nav-library-anchor=""
              data-testid="dock-library-trigger"
              aria-label={libraryLabel}
              aria-expanded={libraryOpen}
              aria-haspopup="dialog"
              className={`${styles.slot} ${libraryOpen ? styles.slotActive : ''}`}
              onClick={() => {
                setTip(null);
                setLibraryOpen((open) => !open);
              }}
              onMouseEnter={(e) => {
                if (!libraryOpen) showTipFor(e.currentTarget, libraryLabel);
              }}
              onMouseLeave={() => setTip((cur) => (cur?.text === libraryLabel ? null : cur))}
              onFocus={(e) => {
                if (!libraryOpen) showTipFor(e.currentTarget, libraryLabel);
              }}
              onBlur={() => setTip(null)}
            >
              <span className={styles.well} data-tone="library" aria-hidden="true">
                <LayoutGrid
                  className={`${styles.icon} ${libraryOpen ? '' : 'text-sky-600 dark:text-sky-300'}`}
                  stroke={tonePaint('home')}
                />
              </span>
            </button>
          </div>
        </div>
      </nav>

      {/* Floating Tooltip */}
      <div
        aria-hidden="true"
        className={`${styles.tooltip} ${tip && !libraryOpen ? styles.tooltipVisible : ''}`}
        style={
          tip
            ? ({
                '--dock-tip-x': `${tip.x}px`,
                '--dock-tip-y': `${tip.y}px`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {tip?.text ?? ''}
      </div>
    </div>
  );
}
