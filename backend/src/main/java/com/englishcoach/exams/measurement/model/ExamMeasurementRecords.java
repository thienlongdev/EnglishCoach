package com.englishcoach.exams.measurement.model;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Boundary records for the Exams measurement pipeline.  These records carry
 * provenance and consent explicitly so a caller cannot silently upgrade an
 * operational event into human-gold evidence.
 */
public final class ExamMeasurementRecords {

    private ExamMeasurementRecords() {}

    public enum ConsentStatus { GRANTED, WITHDRAWN, UNKNOWN }
    public enum ExposureStatus { FAMILIAR, UNEXPOSED, UNKNOWN }
    public enum SourceType { RUNTIME_EXPORT, OPERATOR_LINKED_IMPORT, SYNTHETIC_ENGINEERING }
    public enum EvidenceClass { RUNTIME_OPERATIONAL, ENGINEERING_SYNTHETIC }
    public enum OutcomeStatus { CORRECT, INCORRECT, OMITTED, ABSTAINED, UNKNOWN }
    public enum OutcomeSource { ANSWER_SPEC, RUNTIME_SCORE_ARTIFACT, HUMAN_RATING, UNAVAILABLE }
    public enum RunStatus { RAW, CLEAN, FINAL, INSUFFICIENT, REJECTED }
    public enum Split { DEVELOPMENT, CALIBRATION, VALIDATION, TEST }

    /** A row read from the existing attempt/response/submission runtime tables. */
    public record RuntimeObservationRow(
            UUID attemptId,
            UUID submissionId,
            UUID responseId,
            Long userId,
            UUID formId,
            int formVersion,
            String formContentHash,
            UUID itemId,
            int itemVersion,
            String itemContentHash,
            ExamFamily family,
            String variant,
            String scope,
            SkillType skill,
            String taskFamily,
            String attemptMode,
            String manifestHash,
            String submissionHash,
            long responseRevision,
            Map<String, Object> answerPayload,
            String textResponse,
            String selectedOption,
            Long responseTimeMs,
            boolean hasAnswerSpec,
            Map<String, Object> acceptedAnswers,
            Map<String, Object> normalizationPolicy,
            int cardinality,
            double creditUnits,
            ExposureStatus exposureStatus,
            Instant submittedAt
    ) {}

    public record MeasurementEvent(
            UUID id,
            UUID attemptId,
            UUID submissionId,
            UUID responseId,
            Long userId,
            UUID formId,
            UUID itemId,
            ExamFamily family,
            String variant,
            String scope,
            SkillType skill,
            String taskFamily,
            String attemptMode,
            int formVersion,
            int itemVersion,
            String formContentHash,
            String itemContentHash,
            String manifestHash,
            String submissionHash,
            long responseRevision,
            ExposureStatus exposureStatus,
            ConsentStatus consentStatus,
            UUID consentReference,
            SourceType sourceType,
            EvidenceClass evidenceClass,
            OutcomeStatus outcomeStatus,
            OutcomeSource outcomeSource,
            Double scoreAwarded,
            Double maxScore,
            Long responseTimeMs,
            String selectedOption,
            Map<String, Object> responsePayload,
            String eventHash,
            Long createdBy,
            Instant createdAt
    ) {}

    public record RunSummary(
            UUID id,
            ExamFamily family,
            SkillType skill,
            UUID formId,
            RunStatus status,
            int rawCount,
            int cleanCount,
            int excludedCount,
            String inputHash,
            String consentPolicyVersion,
            Instant createdAt,
            Instant finalizedAt
    ) {}

    public record ItemStatistic(
            UUID itemId,
            int sampleSize,
            int validCount,
            Double pValue,
            Double itemRestPointBiserial,
            Double omissionRate,
            Long medianResponseTimeMs,
            Map<String, Double> distractorRates,
            String calculationStatus,
            List<String> flags
    ) {}

    public record Reliability(
            int respondents,
            int items,
            Double kr20,
            String status,
            String reason
    ) {}

    public record AnalysisReport(
            UUID runId,
            List<ItemStatistic> itemStatistics,
            Reliability reliability,
            int rawCount,
            int cleanCount,
            int excludedCount,
            String status,
            List<String> hygieneFlags
    ) {}

    public record CalibrationPackageRequest(
            String logicalCode,
            int version,
            UUID formId,
            UUID scoringSchemeId,
            UUID measurementRunId,
            String method,
            String maturityStage,
            Map<String, Object> mappingTable,
            Map<String, Object> uncertaintyModel,
            String evidenceHash,
            String validationReport
    ) {}

    public record CalibrationPackage(
            UUID id,
            String logicalCode,
            int version,
            UUID formId,
            UUID scoringSchemeId,
            UUID measurementRunId,
            String method,
            String maturityStage,
            Map<String, Object> mappingTable,
            Map<String, Object> uncertaintyModel,
            String evidenceHash,
            String validationReport,
            String approvalState,
            Long approvedBy,
            Instant approvedAt,
            Long createdBy,
            Instant createdAt
    ) {}

    public record RaterAssignment(
            UUID id,
            UUID datasetId,
            UUID responseId,
            UUID attemptId,
            ExamFamily family,
            SkillType skill,
            Long raterUserId,
            Long assignedBy,
            boolean blindToOtherRatings,
            String status,
            Instant createdAt
    ) {}

    /** Adjudicator-only rating projection.  It intentionally omits rater identity. */
    public record RaterRatingSummary(
            UUID id,
            UUID assignmentId,
            Map<String, Object> criterionScores,
            Double overallScore,
            Double confidence,
            String ratingHash,
            Instant submittedAt
    ) {}

    /** Server-authorized recording link for an assigned rater or independent adjudicator. */
    public record RaterRecordingAccess(
            UUID assignmentId,
            UUID datasetId,
            UUID attemptId,
            UUID responseId,
            UUID recordingId
    ) {}

    /** Blind assignment view: original response/task metadata only, with no scorer output. */
    public record RaterAssignmentView(
            RaterAssignment assignment,
            UUID itemId,
            String prompt,
            String interactionType,
            Map<String, Object> optionDefinitions,
            SkillType skill,
            UUID rubricVersionId,
            Map<String, Object> responsePayload,
            String textResponse,
            UUID recordingId,
            List<Map<String, Object>> stimulusAssets
    ) {}

    public record GoldDataset(
            UUID id,
            String logicalCode,
            int version,
            ExamFamily family,
            SkillType skill,
            UUID rubricVersionId,
            String consentPolicyVersion,
            String provenanceStatement,
            String status,
            Long lockedBy,
            Instant lockedAt,
            Long createdBy,
            Instant createdAt
    ) {}

    public record RatingSubmission(
            UUID assignmentId,
            Long raterUserId,
            UUID rubricVersionId,
            Map<String, Object> criterionScores,
            Double overallScore,
            Double confidence,
            String ratingHash
    ) {}

    public record EvaluationRecord(
            UUID memberId,
            Split split,
            String criterion,
            double humanScore,
            Double aiScore,
            boolean abstained,
            String subgroup
    ) {}

    public record EvaluationMetrics(
            int sampleSize,
            int scoredCount,
            int abstainedCount,
            Double mae,
            Double rmse,
            Double exactRate,
            Double adjacentRate,
            Double kappa,
            Double correlation,
            Double abstentionRate,
            String status,
            String reason
    ) {}

    public record EvaluationReport(
            EvaluationMetrics overall,
            Map<String, EvaluationMetrics> byCriterion,
            Map<String, EvaluationMetrics> bySubgroup,
            List<String> hygieneFlags
    ) {}
}
