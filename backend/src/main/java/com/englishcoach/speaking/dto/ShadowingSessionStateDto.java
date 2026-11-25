package com.englishcoach.speaking.dto;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

public record ShadowingSessionStateDto(
        Long sessionId,
        String status, // "ACTIVE", "COMPLETED", "ABANDONED"
        String mode,   // "SHADOWING"
        String sourceType,
        Long sourceId,
        Integer currentUnitIndex,
        Integer completedUnitsCount,
        Integer totalUnitsCount,
        Long activeUnitId,
        String activeTargetId,
        SpeakingShadowingAttemptDto activeAttempt,
        Map<Long, String> unitStates,
        EcsmAnalysisResponseDto rehydratedEcsmResult,
        List<SpeakingShadowingAttemptDto> recentAttempts,
        LocalDateTime createdAt,
        LocalDateTime updatedAt
) {}
