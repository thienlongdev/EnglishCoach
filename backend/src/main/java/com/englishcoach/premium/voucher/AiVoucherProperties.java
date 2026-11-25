package com.englishcoach.premium.voucher;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;

/**
 * AI vouchers ({@code app.ai-voucher.*}): which gated AI features a voucher may pay for, and the spending kill switch.
 *
 * <p>A voucher pays for ONE request of a feature whose cost is already bounded by the feature's own request limits
 * (input size, model, timeout) and whose handler reports success or failure in the same HTTP request. Features without
 * that boundary are not listed: YouTube import (minutes of transcription for one request) and exam scoring (an
 * asynchronous job that reserves its quota outside the request interceptor).</p>
 */
@Data
@Configuration
@ConfigurationProperties(prefix = "app.ai-voucher")
public class AiVoucherProperties {

    /** Kill switch of voucher SPENDING ({@code APP_AI_VOUCHER_SPENDING_ENABLED}). Issuance has its own switch in the garden. */
    private boolean spendingEnabled = true;

    /** Feature keys of {@code premium_feature_definitions} a voucher may pay for ({@code APP_AI_VOUCHER_ELIGIBLE_FEATURES}). */
    private List<String> eligibleFeatures = new ArrayList<>(List.of(
            "WRITING_AI_FEEDBACK", "TRANSLATION_AI_GRADING", "READING_CONTEXT_EXPLANATION",
            "SPEAKING_ROLEPLAY", "SPEAKING_PRONUNCIATION", "SPEAKING_SHADOWING", "SPEAKING_QUICK_CHECK"));

    /** A reservation whose request never reported back (a crashed request) is released after this many minutes. */
    private int staleReservationMinutes = 30;

    public boolean eligible(String featureKey) {
        return spendingEnabled && featureKey != null && eligibleFeatures.contains(featureKey);
    }
}
