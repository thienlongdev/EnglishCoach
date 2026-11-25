package com.englishcoach.speaking.dto;

import jakarta.validation.constraints.NotBlank;

public record SpeakingShadowingAttemptRequest(
        @NotBlank(message = "clientAttemptId is required")
        String clientAttemptId,

        Long unitId,
        Long segmentId,
        String learnerTranscript,
        Double accuracyScore,
        Double pronunciationScore,
        Double fluencyScore,
        Integer durationSeconds,
        Boolean isMocked,
        String parentAttemptId,
        Integer retryIndex,
        String activeTargetId,
        String primaryIssueType,
        String targetWord,
        String retryComparisonState,
        Boolean resolvedThisSession,
        String productSafeResultJson,
        String productContractVersion,
        String artifactSetId,
        String audioRef
) {
    public SpeakingShadowingAttemptRequest(
            String clientAttemptId,
            Long unitId,
            Long segmentId,
            String learnerTranscript,
            Double accuracyScore,
            Integer durationSeconds,
            Boolean isMocked
    ) {
        this(clientAttemptId, unitId, segmentId, learnerTranscript, accuracyScore,
                null, null, durationSeconds, isMocked, null, 0, null, null, null, null, false, null, null, null, null);
    }
}
