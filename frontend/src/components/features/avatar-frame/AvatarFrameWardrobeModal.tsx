'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Check,
  Lock,
  Flame,
  Award,
  BookOpen,
  History,
  ChevronRight,
  Sun,
  Crown,
  Calendar,
} from 'lucide-react';
import {
  AvatarFrameDto,
  AvatarFrameLineage,
  TIER_DISPLAY_NAMES,
} from '@/types/avatarFrame';
import { AvatarWithFrame } from '@/components/common/frame/AvatarWithFrame';
import { getTierSafeAreaConfig } from '@/components/common/frame/FrameLODPolicy';
import { frameAccent } from '@/components/features/profile/FrameCabinet';
import { formatAvatarFrameRequirement } from './formatRequirement';
import s from '@/components/features/profile/profileGlass.module.css';

export interface AvatarFrameWardrobeModalProps {
  isOpen: boolean;
  onClose: () => void;
  catalogue: AvatarFrameDto[];
  equippedFrame: AvatarFrameDto | null;
  avatarUrl?: string | null;
  displayName?: string | null;
  onEquip: (slug: string) => Promise<any>;
  onUnequip: () => Promise<any>;
  isLoading?: boolean;
}

type LineageFilter = 'ALL' | AvatarFrameLineage;
type StatusFilter = 'ALL' | 'OWNED' | 'EQUIPPED' | 'PROGRESSING' | 'LOCKED';

/** Lineage tabs of the wardrobe (Tất cả first; Echo Garden only when the catalogue has one). */
const LINEAGE_TABS: { key: AvatarFrameLineage; label: string; Icon: typeof Flame }[] = [
  { key: 'ACHIEVEMENT', label: 'Thành tựu', Icon: Flame },
  { key: 'RANKED', label: 'Xếp hạng', Icon: Award },
  { key: 'STANDARD', label: 'Chuẩn hóa', Icon: BookOpen },
  { key: 'LEGACY', label: 'Di sản', Icon: History },
  { key: 'SEASONAL', label: 'Bốn mùa', Icon: Sun },
  { key: 'PREMIUM', label: 'Hội viên', Icon: Crown },
  { key: 'EVENT', label: 'Sự kiện', Icon: Calendar },
  { key: 'GARDEN', label: 'Echo Garden', Icon: BookOpen },
];

/** Stable two-column detail rows (label column fixed, labels on one line). */
const FACT_ROW = 'grid grid-cols-[105px_1fr] items-baseline gap-x-3 text-[0.8rem]';

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'ALL', label: 'Mọi trạng thái' },
  { key: 'OWNED', label: 'Đã sở hữu' },
  { key: 'PROGRESSING', label: 'Đang tiến độ' },
  { key: 'LOCKED', label: 'Chưa mở' },
];

export function AvatarFrameWardrobeModal({
  isOpen,
  onClose,
  catalogue,
  equippedFrame,
  avatarUrl,
  displayName,
  onEquip,
  onUnequip,
  isLoading = false,
}: AvatarFrameWardrobeModalProps) {
  const [mounted, setMounted] = useState(false);
  const [activeLineage, setActiveLineage] = useState<LineageFilter>('ALL');
  const [activeStatus, setActiveStatus] = useState<StatusFilter>('ALL');
  const [selectedFrameSlug, setSelectedFrameSlug] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Prevent background scroll when modal is open
  useEffect(() => {
    if (!isOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Selected frame for Inspection / Preview
  const previewFrame = useMemo(() => {
    if (selectedFrameSlug) {
      const found = catalogue.find((f) => f.slug === selectedFrameSlug);
      if (found) return found;
    }
    return equippedFrame || catalogue[0] || null;
  }, [selectedFrameSlug, equippedFrame, catalogue]);

  // Filtered catalogue
  const filteredFrames = useMemo(() => {
    return catalogue.filter((f) => {
      if (activeLineage !== 'ALL' && f.lineage !== activeLineage) {
        return false;
      }
      if (activeStatus === 'EQUIPPED' && !f.ownership?.equipped) {
        return false;
      }
      if (activeStatus === 'OWNED' && !f.ownership?.owned) {
        return false;
      }
      if (activeStatus === 'PROGRESSING' && f.progress?.status !== 'PROGRESSING') {
        return false;
      }
      if (activeStatus === 'LOCKED' && f.ownership?.owned) {
        return false;
      }
      return true;
    });
  }, [catalogue, activeLineage, activeStatus]);

  if (!isOpen || !mounted) return null;

  const handleEquipClick = async (slug: string) => {
    try {
      setIsProcessing(true);
      await onEquip(slug);
    } catch (err) {
      console.error('Failed to equip frame', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnequipClick = async () => {
    try {
      setIsProcessing(true);
      await onUnequip();
    } catch (err) {
      console.error('Failed to unequip frame', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const isPreviewEquipped = !!previewFrame?.ownership?.equipped;
  const isPreviewOwned = !!previewFrame?.ownership?.owned;
  const lineageTabs = LINEAGE_TABS.filter((l) => l.key !== 'GARDEN' || catalogue.some((f) => f.lineage === 'GARDEN'));

  return createPortal(
    <div
      className={`${s.page} ${s.dialogTokens} ${s.scrim}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wardrobe-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={s.dialog} onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className={s.dialogHead}>
          <div className="flex items-center gap-3 min-w-0">
            <span className={s.icon} data-tone="gold" aria-hidden="true"><Crown className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h2 id="wardrobe-title" className={s.title}>
                Tủ Khung Danh Hiệu
              </h2>
              <p className={s.lead}>{catalogue.filter((f) => f.ownership?.owned).length} / {catalogue.length} khung đã sở hữu</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={s.closeBtn}
            aria-label="Đóng tủ đồ"
            autoFocus
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Lineage Tabs */}
        <div className={s.dialogTabs}>
          <div className={s.tabs} role="tablist" aria-label="Dòng khung">
            <button type="button" role="tab" aria-selected={activeLineage === 'ALL'} className={s.tab} onClick={() => setActiveLineage('ALL')}>
              Tất cả ({catalogue.length})
            </button>
            {lineageTabs.map(({ key, label, Icon }) => (
              <button key={key} type="button" role="tab" aria-selected={activeLineage === key} className={s.tab} onClick={() => setActiveLineage(key)}>
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Main Body: Catalogue Grid (Left) + Detail & Action Panel (Right) */}
        <div className={s.dialogBody}>
          {/* Left: Scrollable Frame Grid */}
          <div className={s.dialogGrid}>
            {/* Status Filter Badges */}
            <div className={s.statusRow}>
              <span>Lọc theo:</span>
              {STATUS_TABS.map(({ key, label }) => (
                <button key={key} type="button" aria-pressed={activeStatus === key} className={`${s.tab} ${s.btnSm}`} onClick={() => setActiveStatus(key)}>
                  {label}
                </button>
              ))}
            </div>

            {isLoading && catalogue.length === 0 ? (
              <div className={s.wardrobeGrid} aria-busy="true">
                {Array.from({ length: 6 }).map((_, i) => <span key={i} className={s.skeletonTile} />)}
              </div>
            ) : filteredFrames.length === 0 ? (
              <p className={s.cabinetEmpty}>
                Không tìm thấy khung danh hiệu phù hợp bộ lọc.
              </p>
            ) : (
              <div className={s.wardrobeGrid}>
                {filteredFrames.map((f) => {
                  const isEquipped = !!f.ownership?.equipped;
                  const isOwned = !!f.ownership?.owned;
                  const isSelected = previewFrame?.slug === f.slug;
                  const req = formatAvatarFrameRequirement(f.progress);
                  const safeAreaMd = getTierSafeAreaConfig(f.tier, 'md');

                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setSelectedFrameSlug(f.slug)}
                      aria-pressed={isSelected}
                      className={s.wardrobeCard}
                      style={{ '--fa': frameAccent(f) } as React.CSSProperties}
                    >
                      {/* Top: Tier Badge Only */}
                      <span className={s.tierChip}>
                        {TIER_DISPLAY_NAMES[f.tier]} ({f.tier})
                      </span>

                      {/* Frame Visual Stage (Safely sized for high-tier footprints, eliminating text collision) */}
                      <span
                        className="flex flex-col items-center justify-center px-1 my-1"
                        style={{ minHeight: `${safeAreaMd.stageMinHeightPx}px` }}
                      >
                        <span
                          className="relative flex items-center justify-center"
                          style={{
                            paddingTop: `${safeAreaMd.avatarPaddingTopPx}px`,
                            paddingBottom: `${safeAreaMd.avatarPaddingBottomPx}px`,
                          }}
                        >
                          <AvatarWithFrame
                            size="md"
                            context="profile"
                            frame={f}
                            avatarUrl={avatarUrl}
                            fallbackName={displayName}
                          />
                        </span>
                        <span className={s.cardTitle} style={{ marginTop: `${safeAreaMd.titleSpacingPx}px`, maxWidth: '100%' }}>
                          {f.name}
                        </span>
                      </span>

                      {/* Concise Progress Line (One short line, e.g. 7 / 500 từ, 420 / 1.000 XP) */}
                      {!isOwned && (
                        <span className="mt-1.5 flex flex-col gap-1">
                          <span className={s.tileProgress}>
                            <span className="truncate">{req.cardProgress}</span>
                            {f.progress?.status === 'PROGRESSING' && <span className="shrink-0">{Math.round(f.progress.percent)}%</span>}
                          </span>
                          {f.progress?.status === 'PROGRESSING' && (
                            <span className={s.meter} aria-hidden="true"><span style={{ width: `${Math.min(100, f.progress.percent)}%` }} /></span>
                          )}
                        </span>
                      )}

                      {/* Status Badge Footer */}
                      <span className={s.cardFoot}>
                        {isEquipped ? (
                          <span className={s.tileState} data-state="equipped"><Check className="w-3.5 h-3.5" aria-hidden="true" />Đang dùng</span>
                        ) : isOwned ? (
                          <span className={s.tileState} data-state="owned">Đã sở hữu</span>
                        ) : f.progress?.status === 'ELIGIBLE' ? (
                          <span className={s.tileState} data-state="eligible">Đủ điều kiện</span>
                        ) : (
                          <span className={s.tileState}>
                            <Lock className="w-3 h-3" aria-hidden="true" />
                            {f.progress?.status === 'PROGRESSING' ? 'Đang tiến độ' : 'Chưa mở'}
                          </span>
                        )}
                        <span className={s.tileState}>Xem <ChevronRight className="w-3 h-3" aria-hidden="true" /></span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: Detailed Inspection & Action Panel */}
          {previewFrame && (() => {
            const req = formatAvatarFrameRequirement(previewFrame.progress);
            const safeAreaXl = getTierSafeAreaConfig(previewFrame.tier, 'xl');

            return (
              <div className={s.dialogSide} style={{ '--fa': frameAccent(previewFrame) } as React.CSSProperties}>
                {/* Artwork Preview Canvas with ample safe-area for high-tier dominant footprints */}
                <div className={s.sideStage} style={{ minHeight: `${safeAreaXl.stageMinHeightPx}px` }}>
                  <div
                    className="relative flex items-center justify-center"
                    style={{
                      paddingTop: `${safeAreaXl.avatarPaddingTopPx}px`,
                      paddingBottom: `${safeAreaXl.avatarPaddingBottomPx}px`,
                    }}
                  >
                    <AvatarWithFrame
                      size="xl"
                      context="profile"
                      frame={previewFrame}
                      avatarUrl={avatarUrl}
                      fallbackName={displayName}
                    />
                  </div>
                  <div className="text-center px-2 pb-4 flex flex-col items-center gap-1.5" style={{ marginTop: `${safeAreaXl.titleSpacingPx}px` }}>
                    <span className={s.tierChip} style={{ alignSelf: 'center' }}>
                      {TIER_DISPLAY_NAMES[previewFrame.tier]} ({previewFrame.tier})
                    </span>
                    <h3 className="text-base font-extrabold">{previewFrame.name}</h3>
                  </div>
                </div>

                {/* Requirement & Progress Details (Clean 2-column fixed 3-row layout) */}
                <dl className={`${s.sideFacts} flex flex-col gap-2`}>
                  {isPreviewOwned ? (
                    <>
                      <div className={FACT_ROW}><dt className={`${s.factKey} whitespace-nowrap`}>TRẠNG THÁI</dt><dd className={s.factVal} data-tone="ok">{isPreviewEquipped ? 'Đang trang bị' : 'Đã sở hữu'}</dd></div>
                      <div className={FACT_ROW}><dt className={`${s.factKey} whitespace-nowrap`}>THỜI HẠN</dt><dd className={s.factVal}>{previewFrame.ownership?.expiresAt ? 'Có hạn' : 'Sở hữu vĩnh viễn'}</dd></div>
                    </>
                  ) : req.isMultiCondition ? (
                    <>
                      <dt className={`${s.factKey} whitespace-nowrap`}>ĐIỀU KIỆN MỞ KHÓA</dt>
                      {req.conditions.map((cond, idx) => (
                        <div key={idx} className={FACT_ROW}><dt className={`${s.factKey} whitespace-nowrap`}>{cond.label}</dt><dd className={s.factVal} data-tone="info">{cond.progressText}</dd></div>
                      ))}
                    </>
                  ) : (
                    <>
                      {/* ROW 1: MỞ KHÓA BẰNG · ROW 2: TIẾN ĐỘ · ROW 3: CÒN THIẾU */}
                      <div className={FACT_ROW}><dt className={`${s.factKey} whitespace-nowrap`}>MỞ KHÓA BẰNG</dt><dd className={s.factVal}>{req.single.unlockRequirement}</dd></div>
                      <div className={FACT_ROW}><dt className={`${s.factKey} whitespace-nowrap`}>TIẾN ĐỘ</dt><dd className={s.factVal} data-tone="info">{req.single.progressText}</dd></div>
                      <div className={FACT_ROW}><dt className={`${s.factKey} whitespace-nowrap`}>CÒN THIẾU</dt><dd className={s.factVal} data-tone="warn">{req.single.remainingText}</dd></div>
                    </>
                  )}
                  {!isPreviewOwned && previewFrame.progress?.status === 'PROGRESSING' && (
                    <span className={`${s.meter} mt-1`} aria-hidden="true"><span style={{ width: `${Math.min(100, previewFrame.progress?.percent || 0)}%` }} /></span>
                  )}
                </dl>

                {/* Action Buttons */}
                <div className={s.sideActions}>
                  {isPreviewEquipped ? (
                    <button type="button" onClick={handleUnequipClick} disabled={isProcessing} className={s.btnGhost}>
                      {isProcessing ? 'Đang xử lý...' : 'Tháo khung'}
                    </button>
                  ) : isPreviewOwned ? (
                    <button type="button" onClick={() => handleEquipClick(previewFrame.slug)} disabled={isProcessing} className={s.btn}>
                      {isProcessing ? 'Đang xử lý...' : 'Trang bị'}
                    </button>
                  ) : previewFrame.progress?.status === 'ELIGIBLE' ? (
                    <button type="button" disabled className={`${s.btnGhost} ${s.eligibleWide}`}>
                      Đủ điều kiện mở khóa
                    </button>
                  ) : (
                    <button type="button" disabled className={`${s.btnGhost} ${s.mutedWide}`}>
                      Chưa đủ điều kiện
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>,
    document.body
  );
}
