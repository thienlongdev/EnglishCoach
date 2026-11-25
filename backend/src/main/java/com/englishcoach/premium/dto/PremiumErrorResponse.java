package com.englishcoach.premium.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Value;

import com.fasterxml.jackson.annotation.JsonProperty;

@Value
@Builder
@JsonInclude(JsonInclude.Include.NON_NULL)
public class PremiumErrorResponse {
    String errorCode;
    String message;
    String featureKey;
    Integer trialRemaining;
    Integer monthlyRemaining;
    String upgradePath;
    /** When the used-up free daily allowance renews (local midnight, Asia/Ho_Chi_Minh). */
    java.time.Instant resetsAt;

    @JsonProperty("feature")
    public String getFeature() {
        return featureKey;
    }
}
