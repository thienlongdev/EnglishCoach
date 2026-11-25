package com.englishcoach.premium.dto;

import lombok.Builder;
import lombok.Value;

import java.time.Instant;
import java.util.List;

@Value
@Builder
public class PremiumMeResponseDto {
    boolean isPremium;
    PlanSummaryDto plan;
    Instant startsAt;
    Instant expiresAt;
    long daysRemaining;
    List<PremiumFeatureEntitlementDto> featureEntitlements;
    /** Unexpired AI voucher credits of the account (0 when none). */
    int aiVoucherBalance;
    /**
     * The free daily allowances (AI = shared by every gated AI feature, COACH = Echo Coach messages, BOOK = My Books
     * imports), renewing at local midnight. Present for every account; a Premium account is not limited by them.
     */
    List<DailyAllowanceDto> freeDaily;

    @Value
    @Builder
    public static class DailyAllowanceDto {
        String pool;
        int limit;
        int used;
        int remaining;
        Instant resetsAt;
    }

    @Value
    @Builder
    public static class PlanSummaryDto {
        String code;
        String name;
        int durationMonths;
        String badge;
    }
}
