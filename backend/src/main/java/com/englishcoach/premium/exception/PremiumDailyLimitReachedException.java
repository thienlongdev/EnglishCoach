package com.englishcoach.premium.exception;

import lombok.Getter;

import java.time.Instant;

/** A Premium account used its daily allowance of a daily-capped feature (Echo messages, owner policy 2026-11-20). */
@Getter
public class PremiumDailyLimitReachedException extends PremiumLimitReachedException {
    private final int dailyLimit;
    private final Instant resetsAt;

    public PremiumDailyLimitReachedException(String featureKey, int dailyLimit, Instant resetsAt) {
        super(featureKey, 0, 0);
        this.dailyLimit = dailyLimit;
        this.resetsAt = resetsAt;
    }
}
