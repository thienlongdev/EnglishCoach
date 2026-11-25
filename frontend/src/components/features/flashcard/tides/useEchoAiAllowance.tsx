"use client";

import React, { useState } from "react";
import { usePremiumEntitlement } from "@/hooks/usePremiumEntitlement";
import { PremiumFeatureBadge } from "@/components/premium/PremiumFeatureBadge";
import { PremiumUpgradeModal } from "@/components/premium/PremiumUpgradeModal";
import { dailyAllowance } from "@/services/premiumApi";

/**
 * The site-wide AI allowance, as every other AI module shows and uses it (no Flashcard-specific policy): the server's
 * `/premium/me` entitlement (`usePremiumEntitlement`), the shared `PremiumFeatureBadge` ("Còn x/y lượt AI hôm nay" for
 * free accounts — ONE daily pool shared by every gated AI feature — or "PREMIUM"), a pre-check that only mirrors the
 * server (`isFeatureAllowed`: free daily pool, an AI voucher, or the Premium monthly fair use), a refresh after every
 * charged request, and the existing `PremiumUpgradeModal` when the server refuses with PREMIUM_REQUIRED /
 * PREMIUM_LIMIT_REACHED. The server's interceptor stays the only authority (reservation, refund on failure).
 */
export function useEchoAiAllowance(featureKey: string, featureName: string) {
  const { isPremium, isFeatureAllowed, mutateEntitlement, entitlement } = usePremiumEntitlement();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const allowed = isFeatureAllowed(featureKey);
  const resetsAt = dailyAllowance(entitlement, "AI")?.resetsAt;
  // the server's own reset instant, told in the platform's day boundary (Asia/Ho_Chi_Minh): "0:00 ngày 13/11"
  const resetLabel = (() => {
    if (!resetsAt) return "0:00";
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "numeric", minute: "2-digit", day: "numeric", month: "numeric", hourCycle: "h23" })
      .formatToParts(new Date(resetsAt));
    const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${Number(v("hour"))}:${v("minute")} ngày ${v("day")}/${v("month")}`;
  })();
  const exhaustedNote = allowed ? null : isPremium
    ? `Bạn đã dùng hết lượt dùng hợp lý của ${featureName} trong tháng này. Các thẻ đã có và cách thêm thẻ thủ công vẫn dùng bình thường.`
    : `Bạn đã dùng hết lượt AI miễn phí hôm nay (dùng chung cho mọi tính năng AI). Lượt mới có vào ${resetLabel}. Những gì đã tạo vẫn còn nguyên, và bạn vẫn thêm thẻ thủ công được.`;
  return {
    allowed,
    isPremium,
    exhaustedNote,
    /** after a request the server may have charged (success) or refused for quota: read the new numbers */
    refresh: () => { void mutateEntitlement(); },
    openUpgrade: () => setUpgradeOpen(true),
    badge: <PremiumFeatureBadge featureKey={featureKey} />,
    // rendered INSIDE the native dialog so it shares the dialog's top layer (a fixed z-50 layer outside it sits underneath)
    upgradeModal: <PremiumUpgradeModal isOpen={upgradeOpen} onClose={() => setUpgradeOpen(false)} featureName={featureName} />,
  };
}
