package com.englishcoach.premium.exception;

import lombok.Getter;

@Getter
public class PremiumLimitReachedException extends RuntimeException {

    private final String featureKey;
    private final int monthlyLimit;
    private final int monthlyRemaining;
    private final String upgradePath;

    public PremiumLimitReachedException(String featureKey, int monthlyLimit, int monthlyRemaining) {
        this(featureKey, monthlyLimit, monthlyRemaining, "/premium");
    }

    public PremiumLimitReachedException(String featureKey, int monthlyLimit, int monthlyRemaining, String upgradePath) {
        super("Bạn đã đạt giới hạn sử dụng hàng tháng của gói Premium cho tính năng này.");
        this.featureKey = featureKey;
        this.monthlyLimit = monthlyLimit;
        this.monthlyRemaining = monthlyRemaining;
        this.upgradePath = upgradePath != null ? upgradePath : "/premium";
    }
}
