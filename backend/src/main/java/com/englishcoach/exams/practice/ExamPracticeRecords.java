package com.englishcoach.exams.practice;

import com.englishcoach.exams.model.ExamContentRecords.PublicAssetRefDto;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Exams Phase 6 — Practice + Review API contracts (learner-safe: no keys before submission, no source metadata). */
public final class ExamPracticeRecords {

    private ExamPracticeRecords() {}

    /** Learner view of one canonical scope of a form. {@code availability} never carries internal reason codes. */
    public record PracticeScopeDto(
            String scopeCode,
            String scopeType,
            SkillType skill,
            int number,
            int questionCount,
            boolean objectiveScoring,
            String scoringMode,
            String timingMode,
            String availability,
            boolean reviewAvailable,
            boolean requiresAudio,
            boolean requiresImage
    ) {}

    public record PracticeCatalogDto(UUID formId, ExamFamily family, String title, List<PracticeScopeDto> scopes) {}

    /** Admin / operator diagnostics (structured codes, ids, counts — never exam text). */
    public record PracticeScopeDiagnosticDto(
            String scopeCode,
            String scopeType,
            SkillType skill,
            int number,
            UUID sectionId,
            UUID partId,
            String partCode,
            int groupCount,
            int questionCount,
            int objectiveItemCount,
            int audioAssets,
            int imageAssets,
            boolean ready,
            String learnerAvailability,
            List<String> reasonCodes,
            String readinessVersion
    ) {}

    public record CreatePracticeAttemptRequest(UUID formId, String scopeCode, String clientMutationId) {}

    public record PracticeAgainRequest(String clientMutationId) {}

    /** Created / resumed practice attempt. */
    public record PracticeAttemptDto(UUID attemptId, UUID formId, String scopeCode, String status, boolean resumedExisting,
                                     UUID practiceAgainOf) {}

    /**
     * Raw practice metrics only. A part / passage / section / task practice never claims a TOEIC scaled score or an
     * IELTS band ({@code standardizedScoreAvailable} is always false here).
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PracticeResultDto(
            UUID attemptId,
            String mode,
            ExamFamily family,
            String scopeCode,
            String scopeType,
            SkillType skill,
            int scopeNumber,
            String sourceTitle,
            UUID sourceFormId,
            Integer sourceFormVersion,
            String completionStatus,
            String scoringMode,
            Integer correct,
            Integer incorrect,
            Integer unanswered,
            Integer answered,
            Integer total,
            Double rawAccuracyPercent,
            Long timeSpentSeconds,
            Double averageSecondsPerQuestion,
            Integer wordCount,
            Integer minimumWords,
            String writingAssessment,
            boolean standardizedScoreAvailable,
            boolean reviewAvailable,
            Instant submittedAt
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PracticeReviewDto(
            UUID attemptId,
            ExamFamily family,
            String scopeCode,
            String scopeType,
            SkillType skill,
            int scopeNumber,
            String sourceTitle,
            UUID sourceFormId,
            Integer sourceFormVersion,
            Instant submittedAt,
            String contentBasis,
            PracticeResultDto summary,
            String partInstructions,
            List<ReviewGroupDto> groups
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ReviewGroupDto(
            UUID groupId,
            String displayNumbering,
            String questionType,
            Map<String, Object> presentation,
            List<ReviewStimulusDto> stimuli,
            List<ReviewItemDto> items
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ReviewStimulusDto(UUID id, String kind, String title, Map<String, Object> bodyPayload, List<PublicAssetRefDto> assets) {}

    /**
     * One reviewed question. {@code status}: CORRECT / INCORRECT / UNANSWERED (objective) or NOT_SCORED (writing).
     * Availability flags distinguish what the snapshot can honestly offer: a correct answer (objective, after submission),
     * a curated explanation (only when the source carries one — never generated), source evidence (the passage / document
     * shown in this review), AI assistance (not offered in Phase 6).
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ReviewItemDto(
            UUID itemId,
            String placementId,
            String logicalItemKey,
            int itemVersion,
            Integer questionNumber,
            String prompt,
            String interactionType,
            Map<String, Object> optionDefinitions,
            Object learnerAnswer,
            List<String> correctAnswers,
            String status,
            String outcome,
            boolean correctAnswerAvailable,
            boolean explanationAvailable,
            String explanation,
            boolean sourceEvidenceAvailable,
            boolean aiAssistAvailable,
            Integer wordCount,
            Integer minimumWords
    ) {}
}
