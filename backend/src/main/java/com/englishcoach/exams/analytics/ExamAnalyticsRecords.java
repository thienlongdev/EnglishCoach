package com.englishcoach.exams.analytics;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Exams Phase 8 — learner analytics, mistake intelligence and recommended practice (API contracts).
 *
 * <p>Learner-safe by construction: no correct answers, no answer specs, no prompts, no source / QA / readiness metadata,
 * no user ids. PRACTICE and EXAM_SIMULATION are separate blocks and never share a score line: practice carries raw
 * counts only (never a TOEIC scale or an IELTS band); simulation carries a standardized component only when the scorer
 * persisted one. Policy versions are internal (exposed for tests / support, never rendered to learners).
 */
public final class ExamAnalyticsRecords {

    private ExamAnalyticsRecords() {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ExamAnalyticsDto(
            Instant generatedAt,
            int windowDays,
            int recentDays,
            Map<String, String> policyVersions,
            List<FamilyAnalyticsDto> families
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record FamilyAnalyticsDto(
            ExamFamily family,
            PracticeOverviewDto practice,
            List<ScopeStatsDto> scopes,
            List<InteractionStatsDto> questionTypes,
            MistakeSummaryDto mistakes,
            RecommendationBlockDto recommendations,
            SimulationOverviewDto simulation,
            List<ActivityWeekDto> activity
    ) {}

    /** Totals over every PRACTICE attempt of the family in the analytics window (raw counts only). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PracticeOverviewDto(
            int attempts,
            int objectiveAttempts,
            int writingAttempts,
            int questions,
            int correct,
            int incorrect,
            int unanswered,
            Double rawAccuracyPercent,
            Long timeSpentSeconds,
            int scopesPracticed,
            int practiceDays,
            Instant lastPracticedAt,
            String signal
    ) {}

    /**
     * One canonical practice scope (TOEIC Part n, IELTS Listening Section n, Reading Passage n, Writing Task n) the learner
     * actually practised. Writing scopes never carry accuracy / signal (NOT_SCORED).
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ScopeStatsDto(
            String scopeCode,
            String scopeType,
            SkillType skill,
            int scopeNumber,
            boolean objective,
            int attempts,
            int questions,
            int answered,
            int correct,
            int incorrect,
            int unanswered,
            Double rawAccuracyPercent,
            Integer recentQuestions,
            Integer recentCorrect,
            Integer recentIncorrect,
            Integer recentUnanswered,
            Double recentAccuracyPercent,
            Double earlierAccuracyPercent,
            String signal,
            int recentAttempts,
            Long timeSpentSeconds,
            Double averageSecondsPerQuestion,
            Instant lastPracticedAt,
            Integer currentRepeatedMistakes,
            List<TrendPointDto> trend,
            WritingStatsDto writing
    ) {}

    /** One submitted practice attempt of a scope (oldest first); only sent when the scope has ≥ 2 attempts. */
    public record TrendPointDto(UUID attemptId, Instant submittedAt, int questions, int correct, double rawAccuracyPercent) {}

    /** Writing practice: response facts only — never a quality judgement, never a band. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WritingStatsDto(int submitted, Integer lastWordCount, Integer averageWordCount, Integer minimumWords,
                                  int metMinimumCount, String assessment) {}

    /** Accuracy per canonical interaction type of the snapshot item (only types that occurred). */
    public record InteractionStatsDto(String interactionType, int questions, int correct, int incorrect, int unanswered,
                                      double rawAccuracyPercent, String signal) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MistakeSummaryDto(int repeated, int single, int improved, List<MistakeItemDto> items, int totalTracked) {}

    /**
     * One item the learner missed at least once. Identity = logical item key + version (the content the learner actually
     * saw). {@code state}: REPEATED (missed ≥ 2 times, still missed last time), SINGLE (missed once, last time),
     * IMPROVED (missed before, correct in the latest attempt). The answer itself is only in the attempt-scoped Review.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MistakeItemDto(
            String logicalItemKey,
            int itemVersion,
            Integer questionNumber,
            String interactionType,
            String scopeCode,
            String formTitle,
            int occurrences,
            int missCount,
            int correctCount,
            String lastOutcome,
            Instant lastSeenAt,
            String state,
            UUID reviewAttemptId,
            List<String> outcomes
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RecommendationBlockDto(
            /** PERSONALIZED | INSUFFICIENT_DATA | NO_AVAILABLE_SCOPE */
            String status,
            List<RecommendationDto> items
    ) {}

    /**
     * A suggested canonical practice scope on a concrete AVAILABLE form (server readiness at request time). {@code kind}:
     * FOCUS (data-driven), COVERAGE (not practised yet), START (neutral starter while data is insufficient).
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RecommendationDto(
            int rank,
            String kind,
            String scopeCode,
            String scopeType,
            SkillType skill,
            int scopeNumber,
            UUID formId,
            String formTitle,
            List<ReasonDto> reasons,
            String signal,
            Integer sampleQuestions,
            Integer sampleAttempts
    ) {}

    /** Structured, data-backed reason; the frontend renders the Vietnamese / English sentence from these facts only. */
    public record ReasonDto(String code, Map<String, Object> facts) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SimulationOverviewDto(int submitted, int withStandardizedScore, List<SimulationAttemptDto> attempts) {}

    /**
     * A submitted EXAM_SIMULATION. {@code components} are the scorer's persisted standardized components only (none for an
     * incomplete / unscaled section); {@code rawSections} are the scorer's raw metrics of sections that were NOT scaled.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SimulationAttemptDto(
            UUID attemptId,
            UUID formId,
            String formTitle,
            String variant,
            String scope,
            Instant submittedAt,
            Long timeSpentSeconds,
            String resultStatus,
            List<ComponentDto> components,
            List<RawSectionDto> rawSections
    ) {}

    public record ComponentDto(String metric, double scaledScore, String scaleName, Double rawScore) {}

    public record RawSectionDto(String metric, Integer correct, Integer maxRaw, Double percent, String scale) {}

    /** Submitted attempts per week (Monday start, Asia/Ho_Chi_Minh), last weeks first-to-last. */
    public record ActivityWeekDto(LocalDate weekStart, int practiceAttempts, int simulationAttempts, int questions) {}
}
