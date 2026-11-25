package com.englishcoach.premium.dto;

import lombok.Builder;
import lombok.Value;

@Value
@Builder
public class PremiumFeatureEntitlementDto {
    String featureKey;
    String displayName;
    String description;
    boolean premiumRequired;
    int trialLimit;
    int trialUsed;
    int trialRemaining;
    boolean isPremium;
    boolean premiumAllowed;
    int premiumMonthlyLimit;
    int premiumMonthlyUsed;
    int premiumMonthlyRemaining;
    /** An AI voucher may pay for this feature once the included quota is used up. */
    boolean voucherEligible;
}
