'use client';

import React from 'react';
import Link from 'next/link';
import { Crown, X, ArrowRight, ShieldCheck } from 'lucide-react';
import { FREE_DAILY_LIMITS } from '@/services/premiumApi';

interface PremiumUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  featureName?: string;
  customDescription?: string;
}

export function PremiumUpgradeModal({
  isOpen,
  onClose,
  featureName = 'tính năng này',
  customDescription,
}: PremiumUpgradeModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="relative w-full max-w-md p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl space-y-5 animate-in zoom-in-95 duration-200">
        {/* Close Button */}
        <button
          onClick={onClose}
          type="button"
          className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          aria-label="Đóng"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Icon & Title */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-tr from-amber-500 to-amber-600 text-white shadow-lg shadow-amber-500/25">
            <Crown className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white">
              Hết lượt AI miễn phí hôm nay
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              English Coach Premium
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
          {customDescription ? (
            <p className="leading-relaxed">{customDescription}</p>
          ) : (
            <>
              <p>
                Tài khoản miễn phí có <strong className="text-slate-900 dark:text-white">{FREE_DAILY_LIMITS.AI} lượt AI mỗi ngày</strong>, dùng chung cho mọi tính năng AI. Bạn đã dùng hết lượt hôm nay cho <span className="font-semibold">{featureName}</span>.
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Lượt miễn phí làm mới vào 0:00. Nếu muốn dùng thêm ngay, bạn có thể nâng cấp <strong className="text-indigo-600 dark:text-indigo-400">Premium</strong>.
              </p>
            </>
          )}
        </div>

        {/* Highlights */}
        <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            <span>Premium: hạn mức AI riêng cho từng tính năng mỗi tháng</span>
          </div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            <span>Xem giá và chọn thời hạn Premium</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={onClose}
            type="button"
            className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition"
          >
            Để sau
          </button>
          <Link
            href="/premium"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 rounded-xl shadow-md shadow-indigo-600/25 transition active:scale-95"
          >
            <span>Xem Premium</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}
