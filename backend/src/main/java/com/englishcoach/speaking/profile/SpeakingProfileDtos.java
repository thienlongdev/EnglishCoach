package com.englishcoach.speaking.profile;

import com.englishcoach.speaking.dto.SpeakingRecentImprovementDto;
import com.englishcoach.speaking.dto.SpeakingRecurringIssueDto;
import com.englishcoach.speaking.dto.SpeakingSessionSummaryDto;
import com.englishcoach.speaking.dto.SpeakingPronunciationMetricsDto;
import lombok.Builder;

import java.time.LocalDateTime;
import java.util.List;

/**
 * Strongly-typed DTOs for the lazy section-scoped Speaking Profile API ({@code /api/v1/speaking/profile/**}).
 * Every response is computed exclusively for the authenticated learner; no DTO exposes user IDs.
 */
public final class SpeakingProfileDtos {

    private SpeakingProfileDtos() {
    }

    @Builder
    public record SpeakingActiveContinueDto(
            Long sessionId,
            String status,
            String mode,
            String sourceType,
            Long sourceId,
            int currentUnitIndex,
            int completedUnitsCount,
            int totalUnitsCount,
            String materialTitle,
            String thumbnail,
            String youtubeVideoId,
            String cefrLevel,
            LocalDateTime createdAt,
            LocalDateTime updatedAt
    ) {
    }

    @Builder
    public record SpeakingHubEntryDto(
            int currentStreakDays,
            long activeTargetsCount,
            long lifetimeCompletedSessions,
            SpeakingActiveContinueDto activeSession,
            String activeSessionTitle,
            String activeSessionThumbnail,
            String activeSessionYoutubeVideoId,
            LocalDateTime generatedAt
    ) {
    }

    @Builder
    public record SpeakingDataSufficiencyDto(
            boolean hasAnyPractice,
            String strengthsStatus,
            String focusStatus,
            String trendStatus,
            int minScoredAttemptsForStrength,
            int minDistinctSessionsForFocus,
            int minScoredPointsForTrend
    ) {
    }

    @Builder
    public record SpeakingLifetimeStatsDto(
            long completedSessions,
            long inProgressSessions,
            long totalSessions,
            long qualifiedSpeakingSeconds,
            long roleplayLearnerTurns,
            long shadowingAttempts,
            long quickCheckAttempts,
            long targetVocabularyUsed,
            Double averageContentMatchScore
    ) {
    }

    @Builder
    public record SpeakingWindowActivityDto(
            int currentStreakDays,
            int longestStreakDays30d,
            int practiceDays7d,
            int practiceDays30d,
            long sessionsCompleted7d,
            long sessionsCompleted30d,
            long sessionsStarted30d,
            long sentencesPracticed7d,
            long sentencesPracticed30d,
            long roleplayTurns7d,
            long roleplayTurns30d,
            long quickChecks7d,
            long quickChecks30d,
            long speakingSeconds7d,
            long speakingSeconds30d,
            long totalAttempts30d,
            long v2ScoredAttempts30d,
            long sttOnlyOrAbstainedAttempts30d,
            long retries30d,
            long resolvedTargets30d,
            Double averagePronunciationScore30d,
            Double averageContentMatchScore30d
    ) {
    }

    @Builder
    public record SpeakingDailyActivityPointDto(
            String date,
            boolean active,
            int completedSessions,
            int attemptsCount,
            long speakingSeconds,
            Double averageScore
    ) {
    }

    @Builder
    public record SpeakingScoreTrendPointDto(
            long sessionId,
            String mode,
            String title,
            LocalDateTime timestamp,
            Double pronunciationScore,
            Double contentMatchScore,
            Double fluencyScore,
            int attemptCount
    ) {
    }

    @Builder
    public record SpeakingStrengthItemDto(
            String id,
            String evidenceType,
            String metricKey,
            String titleVi,
            String titleEn,
            String detailVi,
            String detailEn,
            Double score,
            String unit,
            long sampleSize,
            String windowLabelVi,
            String windowLabelEn
    ) {
    }

    @Builder
    public record SpeakingStrongPhonemePatternDto(
            String phone,
            String ipaDisplay,
            String categoryLabelVi,
            String categoryLabelEn,
            int observationsCount,
            int acceptableCount,
            double acceptableRate,
            double averageQualityScore,
            List<String> exampleWords
    ) {
    }

    @Builder
    public record SpeakingProfileOverviewDto(
            String policyVersion,
            LocalDateTime generatedAt,
            SpeakingDataSufficiencyDto dataSufficiency,
            SpeakingLifetimeStatsDto lifetime,
            SpeakingWindowActivityDto recentWindow,
            List<SpeakingDailyActivityPointDto> activityRhythm30d,
            List<SpeakingScoreTrendPointDto> scoreTrend,
            List<SpeakingStrengthItemDto> strengths,
            List<SpeakingRecurringIssueDto> focusAreas,
            List<SpeakingRecentImprovementDto> recentImprovements,
            List<SpeakingSessionSummaryDto> recentSessions
    ) {
    }

    @Builder
    public record SpeakingProfilePronunciationDto(
            String policyVersion,
            int windowDays,
            String windowLabelVi,
            String windowLabelEn,
            LocalDateTime generatedAt,
            String sufficiencyStatus,
            int minScoredAttemptsRequired,
            int minDistinctSessionsForRecurring,
            int distinctAssessedSessionsCount,
            SpeakingPronunciationMetricsDto metrics,
            List<SpeakingRecurringIssueDto> recurringIssues,
            List<SpeakingRecurringIssueDto> singleSessionObservations,
            List<SpeakingStrongPhonemePatternDto> strongPatterns
    ) {
    }
}
