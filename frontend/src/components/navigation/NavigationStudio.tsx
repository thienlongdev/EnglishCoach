'use client';

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, ArrowUp, Check, Dock, PanelLeft, Pin, PinOff, RotateCcw, Star } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import StudioBar, { type StudioRoom } from '@/components/wallpaper/StudioBar';
import { setBackgroundHeld } from '@/lib/wallpaper/storage';
import { accountOfKey } from '@/lib/appearance/state';
import { pointerLight } from '@/lib/ui/pointerLight';
import { authorizedDestinations, navLabel } from '@/lib/navigation/registry';
import {
  DEFAULT_NAV_PREFERENCES,
  currentNavPreferences,
  moveDockItemByOffset,
  navStorageKey,
  reorderDockItems,
  resetDockPreferences,
  setNavigationLayout,
  setNavigationVisibility,
  subscribeNavPreferences,
  toggleDockPinned,
} from '@/lib/navigation/preferences';
import styles from './NavigationStudio.module.css';

export default function NavigationStudio({
  storageKey,
  onClose,
  onOpenRoom,
}: {
  storageKey: string;
  onClose: () => void;
  onOpenRoom: (room: StudioRoom) => void;
}) {
  const { locale, t } = useLanguage();
  const vi = locale === 'vi';
  const { isAdmin } = useCurrentRole();

  const account = accountOfKey(storageKey);
  const navKey = navStorageKey(account);

  const prefs = useSyncExternalStore(
    (cb) => subscribeNavPreferences(navKey, cb),
    () => currentNavPreferences(navKey),
    () => DEFAULT_NAV_PREFERENCES,
  );

  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [previewEdgeRevealed, setPreviewEdgeRevealed] = useState(false);

  useEffect(() => {
    setBackgroundHeld(true);
    return () => setBackgroundHeld(false);
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    setPreviewEdgeRevealed(false);
  }, [prefs.visibility, prefs.layout]);

  const authorized = useMemo(() => authorizedDestinations(isAdmin), [isAdmin]);
  const authorizedById = useMemo(() => new Map(authorized.map((d) => [d.id, d])), [authorized]);
  const pinnedSet = useMemo(() => new Set(prefs.dockPinned), [prefs.dockPinned]);

  const orderedAuthorized = useMemo(
    () => prefs.dockOrder.map((id) => authorizedById.get(id)).filter((d): d is NonNullable<typeof d> => Boolean(d)),
    [prefs.dockOrder, authorizedById],
  );

  const orderedIds = useMemo(() => orderedAuthorized.map((item) => item.id), [orderedAuthorized]);
  const previewIcons = useMemo(() => {
    const list = orderedAuthorized.filter((item) => pinnedSet.has(item.id));
    return (list.length > 0 ? list : orderedAuthorized).slice(0, 7);
  }, [orderedAuthorized, pinnedSet]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusables = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
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

  const triggerLiveWorkspaceMorph = () => {
    const nextLayout = prefs.layout === 'sidebar' ? 'dock' : 'sidebar';
    onClose();
    window.requestAnimationFrame(() => {
      setNavigationLayout(navKey, nextLayout);
    });
  };

  const isSidebar = prefs.layout === 'sidebar';
  const isAutoHide = prefs.visibility === 'autohide';
  const previewShowingChrome = !isAutoHide || previewEdgeRevealed;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="navigation-studio-title"
      className={styles.studio}
      onKeyDown={onKeyDown}
      data-testid="navigation-studio"
    >
      <StudioBar
        room="navigation"
        onRoom={onOpenRoom}
        storageKey={storageKey}
        vi={vi}
        closeRef={closeRef}
        onClose={onClose}
      />

      <div className={styles.body}>
        {/* ─── Left Column: Live Interactive 3D Liquid Glass Workspace Preview ─── */}
        <section
          className={styles.stagePane}
          aria-label={vi ? 'Mô phỏng điều hướng trực tiếp' : 'Live navigation preview'}
          {...pointerLight}
        >
          <div className={styles.stageHeader}>
            <div>
              <span className={styles.stageEyebrow}>{vi ? 'Điều hướng thích ứng 3D' : 'Adaptive 3D Navigation'}</span>
              <h2 id="navigation-studio-title" className={styles.stageTitle}>
                {isSidebar ? (vi ? 'Thanh bên cổ điển' : 'Classic Sidebar') : 'macOS Liquid Glass Dock'}
              </h2>
              <p className={styles.stageSubtitle}>
                {isAutoHide
                  ? isSidebar
                    ? vi
                      ? 'Đưa chuột vào mép trên hoặc mép trái khung mô phỏng để mở đồng thời cả hai thanh điều hướng.'
                      : 'Hover the top or left preview edge to reveal both navigation bars simultaneously.'
                    : vi
                      ? 'Đưa chuột vào mép trên hoặc mép dưới khung mô phỏng để mở đồng thời thanh trên và Dock.'
                      : 'Hover the top or bottom preview edge to reveal both the top bar and Dock simultaneously.'
                  : vi
                    ? 'Rê chuột qua các biểu tượng bên dưới để thử hiệu ứng chiều sâu thủy tinh và phóng đại.'
                    : 'Glide across the preview icons below to test 3D Liquid Glass depth and magnification.'}
              </p>
            </div>
            <button
              type="button"
              className={styles.liveMorphBtn}
              data-testid="nav-studio-live-morph"
              onClick={triggerLiveWorkspaceMorph}
            >
              {isSidebar ? <Dock className="h-4 w-4" aria-hidden="true" /> : <PanelLeft className="h-4 w-4" aria-hidden="true" />}
              <span>
                {isSidebar
                  ? vi
                    ? 'Chuyển sang Dock trên trang'
                    : 'Morph to Dock on page'
                  : vi
                    ? 'Chuyển sang Thanh bên trên trang'
                    : 'Morph to Sidebar on page'}
              </span>
            </button>
          </div>

          <div
            className={styles.viewport}
            data-testid="nav-studio-preview"
            data-layout={prefs.layout}
            data-visibility={prefs.visibility}
            data-revealed={previewShowingChrome ? 'true' : 'false'}
            onPointerMove={pointerLight.onPointerMove}
            onPointerLeave={() => setPreviewEdgeRevealed(false)}
          >
            {isAutoHide && (
              <>
                <div
                  aria-hidden="true"
                  data-testid="nav-studio-preview-top-edge"
                  className={styles.previewTopSensor}
                  onPointerEnter={() => setPreviewEdgeRevealed(true)}
                />
                <div
                  aria-hidden="true"
                  data-testid="nav-studio-preview-main-edge"
                  className={isSidebar ? styles.previewLeftSensor : styles.previewBottomSensor}
                  onPointerEnter={() => setPreviewEdgeRevealed(true)}
                />
              </>
            )}

            <div
              onPointerEnter={() => {
                if (isAutoHide) setPreviewEdgeRevealed(true);
              }}
              className={[
                styles.miniTopBar,
                isSidebar ? styles.miniTopBarWithSidebar : '',
                !previewShowingChrome ? styles.miniTopBarHidden : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className={styles.miniSearchPill} />
              <span className={styles.miniTrayDots}>
                <span className={styles.miniTrayDot} />
                <span className={styles.miniTrayDot} />
                <span className={`${styles.miniTrayDot} ${!isAutoHide ? styles.miniTrayPinActive : ''}`} />
              </span>
            </div>

            <div
              onPointerEnter={(e) => {
                // Entering the inner workspace canvas outside the bars while not on an edge lets auto-hide rest
                if (isAutoHide && e.target === e.currentTarget) {
                  setPreviewEdgeRevealed(false);
                }
              }}
              className={[
                styles.miniContent,
                isSidebar && !isAutoHide ? styles.miniContentSidebarPinned : '',
                isAutoHide ? styles.miniContentAuto : '',
                !isSidebar && !isAutoHide ? styles.miniContentDockPinned : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className={styles.miniHeroCard}>
                <div>
                  <div className={styles.miniLineWide} />
                  <div className={styles.miniLineSub} />
                </div>
                <div className={styles.miniBadgeRow}>
                  <span className={styles.miniBadge}>
                    {isAutoHide
                      ? vi
                        ? 'Mở rộng 100% không gian học'
                        : '100% workspace reclaimed'
                      : isSidebar
                        ? vi
                          ? 'Bố cục thanh bên cố định'
                          : 'Pinned sidebar layout'
                        : vi
                          ? 'Bố cục Dock thủy tinh'
                          : 'Pinned Dock layout'}
                  </span>
                  <span className={styles.miniBadge}>
                    {isAutoHide
                      ? isSidebar
                        ? vi
                          ? 'Cảm biến: Mép trên + Mép trái'
                          : 'Edges: Top + Left'
                        : vi
                          ? 'Cảm biến: Mép trên + Mép dưới'
                          : 'Edges: Top + Bottom'
                      : vi
                        ? 'Ghim đồng bộ toàn trang'
                        : 'Global navigation pinned'}
                  </span>
                </div>
              </div>
              <div className={styles.miniCard} />
              <div className={styles.miniCard} />
              <div className={styles.miniCard} />
            </div>

            <div
              onPointerEnter={() => {
                if (isAutoHide) setPreviewEdgeRevealed(true);
              }}
              className={[
                styles.miniNav,
                isSidebar ? styles.miniNavSidebar : styles.miniNavDock,
                isSidebar && !previewShowingChrome ? styles.miniNavSidebarHidden : '',
                !isSidebar && !previewShowingChrome ? styles.miniNavDockHidden : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {previewIcons.map((item, idx) => {
                const Icon = item.icon;
                return (
                  <span
                    key={item.id}
                    className={`${styles.miniNavDot} ${idx === 0 ? styles.miniNavDotActive : ''}`}
                    title={navLabel(item, vi, t as unknown as Record<string, unknown>)}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                );
              })}
            </div>
          </div>

          <div className={styles.stageFacts}>
            <span className={styles.factChip}>
              {vi ? `Đã ghim ${prefs.dockPinned.length} biểu tượng Dock` : `${prefs.dockPinned.length} Dock icons pinned`}
            </span>
            <span className={styles.factChip}>
              {isAutoHide
                ? vi
                  ? 'Hiển thị: Tự động ẩn đồng bộ'
                  : 'Visibility: Unified auto-hide'
                : vi
                  ? 'Hiển thị: Luôn hiển thị đồng bộ'
                  : 'Visibility: Always visible'}
            </span>
            <span className={styles.factChip}>
              {vi ? 'Lưu riêng theo từng tài khoản' : 'Saved per learner account'}
            </span>
          </div>
        </section>

        {/* ─── Right Column: 3D Liquid Glass Controls ──────────────────────── */}
        <div className={styles.controlsPane}>
          {/* 1. Navigation Layout */}
          <section className={styles.card} aria-labelledby="nav-layout-heading" {...pointerLight}>
            <div className={styles.cardHead}>
              <div>
                <h3 id="nav-layout-heading" className={styles.cardTitle}>
                  {vi ? 'Kiểu bố cục điều hướng' : 'Navigation layout'}
                </h3>
                <p className={styles.cardHint}>
                  {vi
                    ? 'Áp dụng tức thì trên toàn bộ ứng dụng và giữ nguyên mọi mục học tập.'
                    : 'Updates live across the workspace while preserving every route and permission.'}
                </p>
              </div>
            </div>

            <div className={styles.modeGrid} role="radiogroup" aria-labelledby="nav-layout-heading">
              <button
                type="button"
                role="radio"
                aria-checked={isSidebar}
                data-testid="nav-studio-layout-sidebar"
                className={`${styles.modeOption} ${isSidebar ? styles.modeOptionActive : ''}`}
                onClick={() => setNavigationLayout(navKey, 'sidebar')}
                {...pointerLight}
              >
                <span className={styles.modeOptionTitle}>
                  <span className="inline-flex items-center gap-2">
                    <span className={styles.modeIconWell}>
                      <PanelLeft className="h-4 w-4 text-sky-300" aria-hidden="true" />
                    </span>
                    <span>{vi ? 'Thanh bên cổ điển' : 'Classic Sidebar'}</span>
                  </span>
                  {isSidebar && (
                    <span className={styles.modeCheckBadge} aria-hidden="true">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  )}
                </span>
                <span className={styles.modeOptionDesc}>
                  {vi
                    ? 'Thanh dọc quen thuộc bên trái màn hình với nhãn danh mục đầy đủ và thu gọn nhanh.'
                    : 'Familiar left vertical rail with categorized Vietnamese labels and quick collapse.'}
                </span>
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={!isSidebar}
                data-testid="nav-studio-layout-dock"
                className={`${styles.modeOption} ${!isSidebar ? styles.modeOptionActive : ''}`}
                onClick={() => setNavigationLayout(navKey, 'dock')}
                {...pointerLight}
              >
                <span className={styles.modeOptionTitle}>
                  <span className="inline-flex items-center gap-2">
                    <span className={styles.modeIconWell}>
                      <Dock className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                    </span>
                    <span>macOS Liquid Glass Dock</span>
                  </span>
                  {!isSidebar && (
                    <span className={styles.modeCheckBadge} aria-hidden="true">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  )}
                </span>
                <span className={styles.modeOptionDesc}>
                  {vi
                    ? 'Thanh nổi thủy tinh ở cạnh dưới với phóng đại mượt theo khoảng cách và Kho điều hướng.'
                    : 'Floating bottom Liquid Glass capsule with spring magnification and App Library.'}
                </span>
              </button>
            </div>
          </section>

          {/* 2. Unified Global Navigation Visibility */}
          <section className={styles.card} aria-labelledby="nav-visibility-heading" {...pointerLight}>
            <div className={styles.cardHead}>
              <div>
                <h3 id="nav-visibility-heading" className={styles.cardTitle}>
                  {vi ? 'Chế độ hiển thị điều hướng' : 'Global navigation visibility'}
                </h3>
                <p className={styles.cardHint}>
                  {vi
                    ? 'Một chế độ duy nhất điều khiển đồng bộ cả Thanh trên cùng và điều hướng chính từ nút ghim trên thanh đầu trang.'
                    : 'One unified setting synchronizes both the Top Bar and main navigation from the header pin button.'}
                </p>
              </div>
            </div>

            <div className={styles.visUnifiedCard} {...pointerLight}>
              <div className={styles.visInfoBlock}>
                <span className={styles.visLabel}>
                  {isSidebar
                    ? vi
                      ? 'Thanh trên cùng và Thanh bên'
                      : 'Top Bar and Classic Sidebar'
                    : vi
                      ? 'Thanh trên cùng và Liquid Glass Dock'
                      : 'Top Bar and Liquid Glass Dock'}
                </span>
                <span className={styles.visSub}>
                  {isSidebar
                    ? vi
                      ? 'Khi bật Tự động ẩn, đưa trỏ chuột sát mép trên hoặc mép trái màn hình sẽ hiện đồng thời cả hai thanh.'
                      : 'In Auto-hide mode, approaching either the top edge or left edge reveals both bars together.'
                    : vi
                      ? 'Khi bật Tự động ẩn, đưa trỏ chuột sát mép trên hoặc mép dưới màn hình sẽ hiện đồng thời cả hai thanh.'
                      : 'In Auto-hide mode, approaching either the top edge or bottom edge reveals both bars together.'}
                </span>
                <div className={styles.visEdgePills}>
                  <span className={styles.visEdgePill}>
                    {isSidebar
                      ? vi
                        ? 'Cảm biến: Mép trên + Mép trái'
                        : 'Active edges: Top + Left'
                      : vi
                        ? 'Cảm biến: Mép trên + Mép dưới'
                        : 'Active edges: Top + Bottom'}
                  </span>
                  <span className={styles.visEdgePill}>
                    {vi ? 'Nút ghim nhanh trên Thanh đầu trang' : 'Quick pin in Top Bar'}
                  </span>
                </div>
              </div>

              <div
                className={styles.segGroup}
                role="group"
                aria-label={vi ? 'Chế độ hiển thị điều hướng toàn cục' : 'Global navigation visibility mode'}
              >
                <button
                  type="button"
                  aria-pressed={!isAutoHide}
                  data-testid="nav-studio-visibility-pinned"
                  className={`${styles.segBtn} ${!isAutoHide ? styles.segBtnOn : ''}`}
                  onClick={() => setNavigationVisibility(navKey, 'pinned')}
                >
                  <Pin className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{vi ? 'Luôn hiển thị' : 'Always visible'}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={isAutoHide}
                  data-testid="nav-studio-visibility-autohide"
                  className={`${styles.segBtn} ${isAutoHide ? styles.segBtnOn : ''}`}
                  onClick={() => setNavigationVisibility(navKey, 'autohide')}
                >
                  <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{vi ? 'Tự động ẩn' : 'Auto-hide'}</span>
                </button>
              </div>
            </div>
          </section>

          {/* 3. Dock Arrangement & Favorites */}
          <section className={styles.card} aria-labelledby="nav-dock-heading" {...pointerLight}>
            <div className={styles.cardHead}>
              <div>
                <h3 id="nav-dock-heading" className={styles.cardTitle}>
                  {vi ? 'Sắp xếp biểu tượng và mục yêu thích trên Dock' : 'Dock icons and favorites'}
                </h3>
                <p className={styles.cardHint}>
                  {vi
                    ? 'Kéo thả hoặc dùng nút mũi tên để đổi thứ tự. Mục bỏ ghim vẫn luôn có trong Kho điều hướng.'
                    : 'Drag or use arrow buttons to reorder. Unpinned items remain accessible in App Library.'}
                </p>
              </div>
              <button
                type="button"
                className={styles.resetBtn}
                data-testid="nav-studio-reset-dock"
                onClick={() => resetDockPreferences(navKey)}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{vi ? 'Đặt lại bố cục Dock' : 'Reset Dock layout'}</span>
              </button>
            </div>

            <div className={styles.dockList} data-testid="nav-studio-dock-list">
              {orderedAuthorized.map((item, idx) => {
                const Icon = item.icon;
                const label = navLabel(item, vi, t as unknown as Record<string, unknown>);
                const pinned = pinnedSet.has(item.id);
                return (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={() => setDragId(item.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setDragOverId(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragId && dragId !== item.id) setDragOverId(item.id);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId && dragId !== item.id) {
                        reorderDockItems(navKey, dragId, item.id);
                      }
                      setDragId(null);
                      setDragOverId(null);
                    }}
                    onPointerMove={pointerLight.onPointerMove}
                    className={[
                      styles.dockRow,
                      pinned ? styles.dockRowPinned : '',
                      dragOverId === item.id ? styles.dockRowDragOver : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    data-testid={`nav-studio-item-${item.id}`}
                  >
                    <div className={styles.dockRowInfo}>
                      <span className={styles.dockRowIcon}>
                        <Icon className={`h-4 w-4 ${item.iconColor}`} aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <span className={styles.dockRowName}>{label}</span>
                        <span className={pinned ? styles.dockRowStatus : styles.dockRowStatusMuted}>
                          {pinned
                            ? vi
                              ? 'Đang ghim trên Dock'
                              : 'Pinned to Dock'
                            : vi
                              ? 'Trong Kho điều hướng'
                              : 'In App Library'}
                        </span>
                      </div>
                    </div>

                    <div className={styles.dockRowActions}>
                      <button
                        type="button"
                        className={styles.iconAction}
                        disabled={idx === 0}
                        aria-label={vi ? `Chuyển ${label} lên trước` : `Move ${label} earlier`}
                        data-testid={`nav-studio-move-up-${item.id}`}
                        onClick={() => moveDockItemByOffset(navKey, item.id, -1, orderedIds)}
                      >
                        <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={styles.iconAction}
                        disabled={idx === orderedAuthorized.length - 1}
                        aria-label={vi ? `Chuyển ${label} xuống sau` : `Move ${label} later`}
                        data-testid={`nav-studio-move-down-${item.id}`}
                        onClick={() => moveDockItemByOffset(navKey, item.id, 1, orderedIds)}
                      >
                        <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-pressed={pinned}
                        aria-label={
                          pinned
                            ? vi
                              ? `Bỏ ghim ${label} khỏi Dock`
                              : `Unpin ${label} from Dock`
                            : vi
                              ? `Ghim ${label} lên Dock`
                              : `Pin ${label} to Dock`
                        }
                        data-testid={`nav-studio-pin-${item.id}`}
                        className={`${styles.iconAction} ${pinned ? styles.iconActionPinned : ''}`}
                        onClick={() => toggleDockPinned(navKey, item.id)}
                      >
                        <Star className="h-3.5 w-3.5" fill={pinned ? 'currentColor' : 'none'} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
