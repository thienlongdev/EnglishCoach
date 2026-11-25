package com.englishcoach.exams.model;

import com.englishcoach.exams.model.ExamTypes.*;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ExamScoringRecords {

    private ExamScoringRecords() {}

    // ─── Database Projections ─────────────────────────────────────────────────

    public record JobRecord(
            UUID id,
            UUID submissionId,
            String target,
            String pipelineVersion,
            int runOrdinal,
            JobStatus status,
            Instant nextRunAt,
            String leaseToken,
            Instant leaseExpiresAt,
            int attemptCount,
            int maxAttempts,
            String lastError,
            Instant createdAt,
            Instant updatedAt
    ) {}

    public record JobStageRecord(
            UUID id,
            UUID jobId,
            String stageKey,
            int executionOrdinal,
            String inputHash,
            String outputHash,
            Map<String, Object> resultPayload,
            UUID privateAssetId,
            Map<String, Object> providerVersionMeta,
            Integer durationMs,
            JobStageStatus status,
            Instant createdAt
    ) {}

    public record ScoreArtifactRecord(
            UUID id,
            UUID submissionId,
            int runOrdinal,
            UUID predecessorId,
            Map<String, Object> versionBundle,
            String evidenceHash,
            ResultStatus resultStatus,
            Map<String, Object> reviewerProvenance,
            Instant createdAt
    ) {}

    public record ScoreComponentRecord(
            UUID id,
            UUID artifactId,
            ExamFamily family,
            ScoreMetric metric,
            UUID sectionId,
            UUID responseId,
            Double rawScore,
            double scaledScore,
            String scaleName,
            Map<String, Object> uncertaintyRange,
            UUID calibrationId,
            Instant createdAt
    ) {}

    public record CriterionScoreRecord(
            UUID id,
            UUID artifactId,
            String target,
            String rubricCriterion,
            double score,
            List<Map<String, Object>> evidenceReferences,
            Map<String, Object> confidenceMeta,
            Instant createdAt
    ) {}

    public record ReviewCaseRecord(
            UUID id,
            UUID attemptId,
            UUID jobId,
            UUID artifactId,
            String reason,
            String status,
            Long assignedOperatorId,
            Map<String, Object> decisionPayload,
            Instant createdAt,
            Instant resolvedAt
    ) {}

    // ─── Scoring API DTOs ─────────────────────────────────────────────────────

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ScoringProgressDto(
            UUID attemptId,
            ResultStatus resultStatus,
            boolean isCompleted,
            List<JobStageSummaryDto> stages,
            String failureMessage,
            Instant estimatedReadyAt
    ) {}

    public record JobStageSummaryDto(
            String stageKey,
            JobStageStatus status,
            Integer durationMs
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ExamResultDto(
            UUID artifactId,
            UUID attemptId,
            ExamFamily family,
            String variant,
            String scope,
            ExamAttemptMode mode,
            ResultStatus resultStatus,
            Double overallScore,
            Map<String, Double> skillScores,
            List<ComponentScoreDto> components,
            List<CriterionScoreDto> criteria,
            Map<String, Object> versionBundle,
            Instant completedAt
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ComponentScoreDto(
            ScoreMetric metric,
            Double rawScore,
            Double scaledScore,
            String scaleName,
            Map<String, Object> uncertaintyRange,
            String status,
            Boolean isPending
    ) {
        public ComponentScoreDto(ScoreMetric metric, Double rawScore, Double scaledScore, String scaleName, Map<String, Object> uncertaintyRange) {
            this(metric, rawScore, scaledScore, scaleName, uncertaintyRange, null, false);
        }
    }

    public record CriterionScoreDto(
            String target,
            String rubricCriterion,
            double score,
            List<Map<String, Object>> evidenceReferences,
            Map<String, Object> confidenceMeta
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ItemReviewDto(
            String placementId,
            UUID itemId,
            String prompt,
            String interactionType,
            Object userAnswer,
            Object acceptedAnswers,
            String explanation,
            boolean isCorrect,
            double creditAwarded,
            double maxCredit,
            SkillType skill,
            boolean isSubjective
    ) {
        public ItemReviewDto(
                String placementId,
                UUID itemId,
                String prompt,
                String interactionType,
                Object userAnswer,
                Object acceptedAnswers,
                String explanation,
                boolean isCorrect,
                double creditAwarded,
                double maxCredit
        ) {
            this(placementId, itemId, prompt, interactionType, userAnswer, acceptedAnswers, explanation, isCorrect, creditAwarded, maxCredit, null, false);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record AttemptReviewDto(
            UUID attemptId,
            ExamFamily family,
            List<ItemReviewDto> items,
            boolean reviewEmbargoEnded,
            ExamSpeakingReviewRecords.SpeakingAttemptReviewDto speakingReview
    ) {
        public AttemptReviewDto(
                UUID attemptId,
                ExamFamily family,
                List<ItemReviewDto> items,
                boolean reviewEmbargoEnded
        ) {
            this(attemptId, family, items, reviewEmbargoEnded, null);
        }
    }
}
