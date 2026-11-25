'use client';

import React from 'react';
import { usePremiumEntitlement } from '@/hooks/usePremiumEntitlement';
import { Crown } from 'lucide-react';

interface PremiumFeatureBadgeProps {
  featureKey: string;
  className?: string;
  showIcon?: boolean;
}

export function PremiumFeatureBadge({
  featureKey,
  className = '',
  showIcon = true,
}: PremiumFeatureBadgeProps) {
  const { isPremium, getFeatureEntitlement, isLoading } = usePremiumEntitlement();

  if (isLoading) {
    return null;
  }

  const feat = getFeatureEntitlement(featureKey);
  if (!feat || !feat.premiumRequired) {
    return null;
  }

  if (isPremium) {
    return (
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-bold rounded-md bg-gradient-to-r from-amber-500/15 to-orange-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20 shadow-xs ${className}`}
        title="Tính năng Premium"
      >
        {showIcon && <Crown className="w-3 h-3 text-amber-500 shrink-0" />}
        <span>PREMIUM</span>
      </span>
    );
  }

  const remaining = feat.trialRemaining;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md ${
        remaining > 0
          ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60'
          : 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800/60 font-semibold'
      } ${className}`}
      title={remaining > 0
        ? `Còn ${remaining}/${feat.trialLimit} lượt AI miễn phí hôm nay (dùng chung cho mọi tính năng AI)`
        : `Đã dùng hết ${feat.trialLimit} lượt AI miễn phí hôm nay — làm mới vào 0:00`}
    >
      {showIcon && <Crown className="w-3 h-3 shrink-0" />}
      <span>{remaining > 0 ? `Còn ${remaining}/${feat.trialLimit} lượt AI hôm nay` : 'Hết lượt AI hôm nay'}</span>
    </span>
  );
}
