package com.englishcoach.speaking.dto;

import java.time.LocalDateTime;

public record SpeakingShadowingAttemptDto(
        Long id,
        Long sessionId,
        Long unitId,
        Long segmentId,
        String clientAttemptId,
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
        String analysisStatus,
        String productSafeResultJson,
        String productContractVersion,
        String artifactSetId,
        String audioRef,
        LocalDateTime createdAt
) {
    public SpeakingShadowingAttemptDto(
            Long id,
            Long sessionId,
            Long unitId,
            Long segmentId,
            String clientAttemptId,
            String learnerTranscript,
            Double accuracyScore,
            Integer durationSeconds,
            Boolean isMocked,
            String parentAttemptId,
            Integer retryIndex,
            String activeTargetId,
            String primaryIssueType,
            String targetWord,
            String retryComparisonState,
            Boolean resolvedThisSession,
            String analysisStatus,
            String productSafeResultJson,
            String productContractVersion,
            String artifactSetId,
            LocalDateTime createdAt
    ) {
        this(id, sessionId, unitId, segmentId, clientAttemptId, learnerTranscript, accuracyScore,
                null, null, durationSeconds, isMocked, parentAttemptId, retryIndex, activeTargetId,
                primaryIssueType, targetWord, retryComparisonState, resolvedThisSession,
                analysisStatus, productSafeResultJson, productContractVersion, artifactSetId, null, createdAt);
    }
}
