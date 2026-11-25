package com.englishcoach.premium.exception;

import lombok.Getter;

import java.time.Instant;

@Getter
public class PremiumRequiredException extends RuntimeException {

    private final String featureKey;
    private final int trialRemaining;
    private final String upgradePath;
    /** When the free daily allowance that was used up renews (null when the refusal is not a daily allowance). */
    private final Instant resetsAt;

    public PremiumRequiredException(String featureKey) {
        this(featureKey, 0, "/premium");
    }

    public PremiumRequiredException(String featureKey, int trialRemaining, String upgradePath) {
        this(featureKey, trialRemaining, upgradePath,
                "Bạn đã dùng hết lượt miễn phí cho tính năng này. Hãy nâng cấp Premium để tiếp tục sử dụng.", null);
    }

    public PremiumRequiredException(String featureKey, int trialRemaining, String upgradePath, String message, Instant resetsAt) {
        super(message);
        this.featureKey = featureKey;
        this.trialRemaining = trialRemaining;
        this.upgradePath = upgradePath != null ? upgradePath : "/premium";
        this.resetsAt = resetsAt;
    }
}
