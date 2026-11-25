package com.englishcoach.exams.model;

import com.englishcoach.exams.model.ExamTypes.*;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ExamProfileRecords {

    private ExamProfileRecords() {}

    // ─── Database Projections ─────────────────────────────────────────────────

    public record ProfileEvidenceRecord(
            UUID id,
            Long userId,
            UUID attemptId,
            UUID artifactId,
            UUID componentId,
            ExamFamily family,
            String metric,
            String scope,
            String cohortKey,
            Instant measurementDate,
            double scoreValue,
            String exposureStatus,
            Map<String, Object> qualityMeta,
            String status,
            Instant createdAt
    ) {}

    public record EvidenceEventRecord(
            UUID id,
            UUID evidenceId,
            String eventType,
            String reason,
            UUID successorId,
            String policyVersion,
            Instant createdAt
    ) {}

    public record RecommendationRecord(
            UUID id,
            Long userId,
            UUID evidenceId,
            String diagnosticCode,
            String mappingVersion,
            TrainingModule trainingModule,
            String targetId,
            String reason,
            String status,
            Instant createdAt
    ) {}

    // ─── Separate Profile Read Models (LOCKED: No universal score) ───────────

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record IeltsProfileDto(
            MetricSummaryDto overall,
            MetricSummaryDto listening,
            MetricSummaryDto reading,
            MetricSummaryDto writing,
            MetricSummaryDto speaking,
            List<IeltsObservationDto> observations,
            String comparabilityCohort,
            String confidenceState,
            List<RecommendationDto> recommendations
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ToeicProfileDto(
            MetricSummaryDto lrTotal,
            MetricSummaryDto listening,
            MetricSummaryDto reading,
            MetricSummaryDto speaking,
            MetricSummaryDto writing,
            List<ToeicObservationDto> observations,
            String comparabilityCohort,
            String confidenceState,
            List<RecommendationDto> recommendations
    ) {}

    public record MetricSummaryDto(
            Double latest,
            Double best,
            Instant latestDate,
            Instant bestDate,
            Double trendSlope,
            String trendDirection // "IMPROVING", "STABLE", "DECLINING", "INSUFFICIENT_DATA"
    ) {}

    public record IeltsObservationDto(
            UUID attemptId,
            UUID artifactId,
            Instant date,
            String variant,
            String scope,
            Double overall,
            Double listening,
            Double reading,
            Double writing,
            Double speaking,
            String exposureStatus,
            boolean isOSR
    ) {}

    public record ToeicObservationDto(
            UUID attemptId,
            UUID artifactId,
            Instant date,
            String variant,
            Double lrTotal,
            Double listening,
            Double reading,
            Double speaking,
            Double writing,
            String exposureStatus
    ) {}

    public record RecommendationDto(
            UUID id,
            UUID evidenceId,
            String diagnosticCode,
            TrainingModule trainingModule,
            String targetId,
            String reason,
            String handoffUrl,
            String status,
            Instant createdAt
    ) {}

    public record AttemptHistoryItemDto(
            UUID attemptId,
            UUID formId,
            String formTitle,
            ExamFamily family,
            String variant,
            String scope,
            ExamAttemptMode mode,
            ExamAttemptStatus status,
            Double score,
            Instant startedAt,
            Instant completedAt,
            /** Exams Phase 7: server-pinned practice scope code (e.g. TOEIC_PART_5) of a part practice; null otherwise. */
            String practiceScopeCode
    ) {}
}
