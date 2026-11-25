'use client';

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Check } from 'lucide-react';
import { AvatarFrameDto, TIER_COLORS, TIER_DISPLAY_NAMES, LINEAGE_DISPLAY_NAMES } from '@/types/avatarFrame';
import { AvatarWithFrame } from '@/components/common/frame/AvatarWithFrame';
import { getTierSafeAreaConfig } from '@/components/common/frame/FrameLODPolicy';

export interface AvatarFrameUnlockCeremonyProps {
  frame: AvatarFrameDto | null;
  avatarUrl?: string | null;
  displayName?: string | null;
  onEquip: (slug: string) => Promise<any>;
  onDismiss: () => void;
}

export function AvatarFrameUnlockCeremony({
  frame,
  avatarUrl,
  displayName,
  onEquip,
  onDismiss,
}: AvatarFrameUnlockCeremonyProps) {
  // Prevent background scrolling when ceremony is active
  useEffect(() => {
    if (!frame) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [frame]);

  // Close on Escape key
  useEffect(() => {
    if (!frame) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [frame, onDismiss]);

  if (!frame || typeof document === 'undefined') return null;

  const tierColor = TIER_COLORS[frame.tier] || TIER_COLORS.C;
  const safeAreaXl = getTierSafeAreaConfig(frame.tier, 'xl');

  return createPortal(
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-300"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ceremony-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        className="relative w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-8 shadow-2xl text-center space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onDismiss}
          className="absolute top-4 right-4 p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          aria-label="Đóng thông báo"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Ceremony Header */}
        <div>
          <span className="text-[11px] font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-400">
            THỨC TỈNH DANH HIỆU
          </span>
          <h3 id="ceremony-title" className="text-2xl font-black text-slate-900 dark:text-white mt-1">
            {frame.name}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Dòng dõi: {LINEAGE_DISPLAY_NAMES[frame.lineage]}
          </p>
        </div>

        {/* Big Avatar Frame Showcase with tier-proportional safe area */}
        <div
          className="flex flex-col items-center justify-center relative overflow-visible"
          style={{ minHeight: `${safeAreaXl.stageMinHeightPx}px` }}
        >
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
              frame={frame}
              avatarUrl={avatarUrl}
              fallbackName={displayName}
            />
          </div>
          <span
            className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-black border ${tierColor.bg} ${tierColor.text} ${tierColor.border}`}
            style={{ marginTop: `${safeAreaXl.titleSpacingPx}px` }}
          >
            {TIER_DISPLAY_NAMES[frame.tier]} ({frame.tier})
          </span>
        </div>

        {/* Story / Requirement Description */}
        <p className="text-xs text-slate-600 dark:text-slate-300 max-w-xs mx-auto leading-relaxed">
          {frame.progress?.displayTarget
            ? `Bạn đã hoàn thành xuất sắc cột mốc ${frame.progress.displayTarget.replace(/\s*\([^)]*\)/, '')}.`
            : 'Chúc mừng! Bạn đã hoàn thành xuất sắc thử thách và mở khóa thành công khung danh hiệu này trong bộ sưu tập.'}
        </p>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={onDismiss}
            className="flex-1 py-3 rounded-2xl text-xs font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition cursor-pointer"
          >
            Xem sau
          </button>
          <button
            type="button"
            onClick={async () => {
              await onEquip(frame.slug);
              onDismiss();
            }}
            className="flex-1 py-3 rounded-2xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-md transition cursor-pointer flex items-center justify-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            Trang bị ngay
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

