package com.englishcoach.exams.job;

import com.englishcoach.exams.client.ExamAiClient;
import com.englishcoach.exams.model.ExamScoringRecords.ScoreComponentRecord;
import com.englishcoach.exams.model.ExamTypes.ExamAttemptMode;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ExamSnapshotState;
import com.englishcoach.exams.model.ExamTypes.ResultStatus;
import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.validation.ExamAttemptEvidenceBasis;
import com.englishcoach.exams.validation.ExamContentValidationStatus;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.englishcoach.exams.validation.ExamFormValidator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Exams Recovery Phase 0/2/4.1D: AI fallback is never authoritative; profile evidence is decided from the evidence
 * basis pinned to the attempt (never current content); legacy attempts keep their history but get nothing new.
 */
class ExamJobWorkerContainmentTest {

    private static ExamAiClient.AiScoringResponse ai(boolean success, Double band, boolean review, Map<String, Object> telemetry) {
        return new ExamAiClient.AiScoringResponse("STAGE_WRITING", success, band, List.of(), null, null, null,
                telemetry, null, review, null, null);
    }

    @Test
    @DisplayName("AI judge result: only a non-fallback, non-review, successful band is authoritative")
    void aiFallbackNotAuthoritative() {
        assertTrue(ExamJobWorker.isAuthoritativeAiScore(ai(true, 6.5, false, Map.of("model", "official-ielts-judge-v1"))));
        assertTrue(ExamJobWorker.isAuthoritativeAiScore(ai(true, 6.5, false, null)));
        // ai-service ielts_writing.py / ielts_speaking.py deterministic fallback: success=True, reviewRequired=False
        assertFalse(ExamJobWorker.isAuthoritativeAiScore(ai(true, 6.0, false,
                Map.of("model", "deterministic-ielts-rubric-v4", "fallback", "DETERMINISTIC_RUBRIC"))));
        assertFalse(ExamJobWorker.isAuthoritativeAiScore(ai(true, 6.0, true, Map.of())));
        assertFalse(ExamJobWorker.isAuthoritativeAiScore(ai(false, 6.0, false, Map.of())));
        assertFalse(ExamJobWorker.isAuthoritativeAiScore(ai(true, null, false, Map.of())));
        assertFalse(ExamJobWorker.isAuthoritativeAiScore(null));
    }

    @Test
    void uncalibratedIeltsEstimatesCannotBecomeProfileEvidence() {
        for (String scale : List.of("IELTS_AI_PRACTICE_ESTIMATE", "IELTS_BAND_ESTIMATE")) {
            var component = new ScoreComponentRecord(UUID.randomUUID(), UUID.randomUUID(), ExamFamily.IELTS,
                    ScoreMetric.WRITING, null, null, null, 6.5, scale, Map.of(), null, Instant.now());
            var decision = ExamJobWorker.firstIneligible(ExamAttemptMode.EXAM_SIMULATION, ResultStatus.COMPLETED, null, List.of(component));
            org.junit.jupiter.api.Assertions.assertEquals("UNCALIBRATED_ESTIMATE", decision.reason().name());
            org.junit.jupiter.api.Assertions.assertTrue(com.englishcoach.proficiency.RatingConverter.resolveExamScale("IELTS", ScoreMetric.WRITING, scale).isEmpty());
        }
    }

    private static ScoreComponentRecord comp(ScoreMetric metric) {
        return new ScoreComponentRecord(UUID.randomUUID(), UUID.randomUUID(), ExamFamily.TOEIC, metric, null, null, 0.0,
                5.0, "TOEIC_SCALE_5_495", Map.of(), null, Instant.now());
    }

    private static final UUID FORM = UUID.randomUUID();

    private static ExamAttemptEvidenceBasis.Resolution basis(String lifecycle, Set<SkillType> simulationSkills) {
        ExamFormValidationReport v = new ExamFormValidationReport(FORM, ExamFormValidator.VALIDATOR_VERSION, "fp",
                Instant.parse("2026-10-03T12:00:00Z"), ExamFamily.TOEIC, "FULL", null, ExamContentValidationStatus.VALID,
                true, simulationSkills, simulationSkills, simulationSkills, List.of(), List.of());
        Map<String, Object> m = ExamAttemptEvidenceBasis.pin(v, FORM, lifecycle, "EXAM_SIMULATION",
                EnumSet.of(SkillType.LISTENING, SkillType.READING), "h").toMap();
        return ExamAttemptEvidenceBasis.resolve(ExamSnapshotState.SNAPSHOTTED, m, FORM, "EXAM_SIMULATION");
    }

    private static final ExamAttemptEvidenceBasis.Resolution LEGACY =
            ExamAttemptEvidenceBasis.resolve(ExamSnapshotState.LEGACY_UNSNAPSHOTTED, null, FORM, "EXAM_SIMULATION");

    private static ExamJobWorker worker() {
        return new ExamJobWorker(null, null, null, null, null, null, null, null, null);
    }

    @Test
    @DisplayName("Profile evidence gate (shared policy, pinned basis): broken skill ⇒ none; practice ⇒ none; valid ⇒ allowed")
    void profileEvidenceContentGate() {
        ExamAttemptEvidenceBasis.Resolution readingOnly = basis("PUBLISHED", EnumSet.of(SkillType.READING));
        List<ScoreComponentRecord> lr = List.of(comp(ScoreMetric.LISTENING), comp(ScoreMetric.READING), comp(ScoreMetric.LR_TOTAL));
        ExamAttemptMode sim = ExamAttemptMode.EXAM_SIMULATION;

        assertFalse(worker().hasValidContentForEvidence(sim, ResultStatus.COMPLETED, readingOnly, lr));
        assertTrue(worker().hasValidContentForEvidence(sim, ResultStatus.COMPLETED, readingOnly, List.of(comp(ScoreMetric.READING))));
        assertFalse(worker().hasValidContentForEvidence(sim, ResultStatus.COMPLETED, LEGACY, lr), "no pinned basis ⇒ no evidence");
        assertFalse(worker().hasValidContentForEvidence(sim, ResultStatus.COMPLETED, readingOnly, List.of(comp(ScoreMetric.LR_TOTAL))),
                "no skill component ⇒ nothing to admit");
        assertFalse(worker().hasValidContentForEvidence(ExamAttemptMode.PRACTICE, ResultStatus.COMPLETED, readingOnly,
                List.of(comp(ScoreMetric.READING))), "8. practice never creates profile evidence");
        assertFalse(worker().hasValidContentForEvidence(sim, ResultStatus.REVIEW_REQUIRED, readingOnly,
                List.of(comp(ScoreMetric.READING))));
    }

    @Test
    @DisplayName("7/19. Evidence outcome is stable after the current form changes: retired / replaced ⇒ PRESERVE, never REVOKE")
    void outcomeUsesPinnedBasis() {
        ExamAttemptEvidenceBasis.Resolution lrValid = basis("PUBLISHED", EnumSet.of(SkillType.LISTENING, SkillType.READING));
        List<ScoreComponentRecord> lr = List.of(comp(ScoreMetric.LISTENING), comp(ScoreMetric.READING));
        ExamAttemptMode sim = ExamAttemptMode.EXAM_SIMULATION;
        // day 1: form PUBLISHED + calibrated ⇒ INSERT
        assertEquals(ExamJobWorker.EvidenceOutcome.INSERT,
                ExamJobWorker.profileEvidenceOutcome(sim, ResultStatus.COMPLETED, true, lrValid, lr, () -> true));
        // day 30: v1 retired (current backstop false) — the attempt keeps its evidence, nothing is revoked or re-added
        assertEquals(ExamJobWorker.EvidenceOutcome.PRESERVE,
                ExamJobWorker.profileEvidenceOutcome(sim, ResultStatus.COMPLETED, true, lrValid, lr, () -> false));
        // a form that was PILOT at attempt time was measurement, never trusted evidence (even if published later)
        assertEquals(ExamJobWorker.EvidenceOutcome.REVOKE, ExamJobWorker.profileEvidenceOutcome(sim, ResultStatus.COMPLETED,
                true, basis("PILOT", EnumSet.of(SkillType.LISTENING, SkillType.READING)), lr, () -> true));
        // pinned content not simulation-grade for a skill ⇒ REVOKE
        assertEquals(ExamJobWorker.EvidenceOutcome.REVOKE, ExamJobWorker.profileEvidenceOutcome(sim, ResultStatus.COMPLETED,
                true, basis("PUBLISHED", EnumSet.of(SkillType.READING)), lr, () -> true));
    }

    @Test
    @DisplayName("10. Legacy attempt (no pinned basis): history preserved, no new authoritative evidence; practice / review ⇒ REVOKE")
    void legacyAndGuards() {
        List<ScoreComponentRecord> lr = List.of(comp(ScoreMetric.LISTENING), comp(ScoreMetric.READING));
        assertEquals(ExamJobWorker.EvidenceOutcome.PRESERVE, ExamJobWorker.profileEvidenceOutcome(
                ExamAttemptMode.EXAM_SIMULATION, ResultStatus.COMPLETED, true, LEGACY, lr, () -> true));
        assertEquals(ExamJobWorker.EvidenceOutcome.REVOKE, ExamJobWorker.profileEvidenceOutcome(
                ExamAttemptMode.PRACTICE, ResultStatus.COMPLETED, true, basis("PUBLISHED", EnumSet.allOf(SkillType.class)), lr, () -> true));
        assertEquals(ExamJobWorker.EvidenceOutcome.REVOKE, ExamJobWorker.profileEvidenceOutcome(
                ExamAttemptMode.EXAM_SIMULATION, ResultStatus.REVIEW_REQUIRED, true, basis("PUBLISHED", EnumSet.allOf(SkillType.class)), lr, () -> true));
        assertEquals(ExamJobWorker.EvidenceOutcome.REVOKE, ExamJobWorker.profileEvidenceOutcome(
                ExamAttemptMode.EXAM_SIMULATION, ResultStatus.COMPLETED, false, basis("PUBLISHED", EnumSet.allOf(SkillType.class)), lr, () -> true),
                "incomplete full mock");
    }
}
