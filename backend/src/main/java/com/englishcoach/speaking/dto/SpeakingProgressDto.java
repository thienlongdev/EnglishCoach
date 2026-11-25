package com.englishcoach.speaking.dto;

import lombok.Builder;
import java.util.List;

@Builder
public record SpeakingProgressDto(
        Long totalQualifiedSpeakingSeconds,
        Long totalCompletedSessions,
        Long totalRoleplayTurns,
        Double averageWordAccuracy,
        Long targetVocabularyUsed,
        Integer currentStreakDays,
        Long activeRecurringTargetsCount,
        Long recentImprovementsCount,
        SpeakingWeaknessProfileDto weaknessProfile,
        List<SpeakingRecentActivityDto> recentActivity,
        Long inProgressSessionsCount
) {
    public SpeakingProgressDto(
            Long totalQualifiedSpeakingSeconds,
            Long totalCompletedSessions,
            Long totalRoleplayTurns,
            Double averageWordAccuracy,
            Long targetVocabularyUsed,
            Integer currentStreakDays,
            Long activeRecurringTargetsCount,
            Long recentImprovementsCount,
            SpeakingWeaknessProfileDto weaknessProfile,
            List<SpeakingRecentActivityDto> recentActivity
    ) {
        this(
                totalQualifiedSpeakingSeconds,
                totalCompletedSessions,
                totalRoleplayTurns,
                averageWordAccuracy,
                targetVocabularyUsed,
                currentStreakDays,
                activeRecurringTargetsCount,
                recentImprovementsCount,
                weaknessProfile,
                recentActivity != null ? recentActivity : List.of(),
                0L
        );
    }

    public SpeakingProgressDto(
            Long totalQualifiedSpeakingSeconds,
            Long totalCompletedSessions,
            Long totalRoleplayTurns,
            Double averageWordAccuracy,
            Long targetVocabularyUsed,
            Integer currentStreakDays,
            SpeakingWeaknessProfileDto weaknessProfile,
            List<SpeakingRecentActivityDto> recentActivity
    ) {
        this(
                totalQualifiedSpeakingSeconds,
                totalCompletedSessions,
                totalRoleplayTurns,
                averageWordAccuracy,
                targetVocabularyUsed,
                currentStreakDays,
                (weaknessProfile != null && weaknessProfile.issues() != null) ? (long) weaknessProfile.issues().size() : 0L,
                0L,
                weaknessProfile,
                recentActivity != null ? recentActivity : List.of(),
                0L
        );
    }
}
