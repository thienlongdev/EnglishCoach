package com.englishcoach.exams.validation;

import com.englishcoach.exams.model.ExamTypes.ExamSnapshotState;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.Reason;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Exams Phase 2 + 4.1D: the single official-evidence rule shared by ExamJobWorker and proficiency.EvidenceMapper,
 * decided from the evidence basis PINNED to the attempt — never from current form validation.
 */
class ExamEvidenceEligibilityPolicyTest {

    private final UUID form = UUID.randomUUID();
    private static final Instant AT = Instant.parse("2026-10-03T12:00:00Z");

    static ExamFormValidationReport report(UUID formId, ExamContentValidationStatus status, Set<SkillType> simulation,
                                           Set<SkillType> practice) {
        return new ExamFormValidationReport(formId, ExamFormValidator.VALIDATOR_VERSION, "fp-1", AT, null, "FULL", null,
                status, status == ExamContentValidationStatus.VALID, simulation, practice, simulation, List.of(), List.of());
    }

    private ExamAttemptEvidenceBasis.Resolution pinned(String mode, Set<SkillType> simulationSkills, Set<SkillType> scope) {
        ExamAttemptEvidenceBasis b = ExamAttemptEvidenceBasis.pin(report(form, ExamContentValidationStatus.VALID,
                simulationSkills, scope), form, "PUBLISHED", mode, scope, "hash");
        return ExamAttemptEvidenceBasis.resolve(ExamSnapshotState.SNAPSHOTTED, b.toMap(), form, mode);
    }

    private final ExamAttemptEvidenceBasis.Resolution valid = pinned("EXAM_SIMULATION",
            EnumSet.of(SkillType.LISTENING, SkillType.READING, SkillType.WRITING),
            EnumSet.of(SkillType.LISTENING, SkillType.READING, SkillType.WRITING));

    private Reason decide(String mode, String status, String metric, double score, boolean fallback,
                          ExamAttemptEvidenceBasis.Resolution basis) {
        return ExamEvidenceEligibilityPolicy.decide(mode, status, metric, score, fallback, basis).reason();
    }

    @Test
    @DisplayName("8. PRACTICE never creates official evidence, whatever the content or status")
    void practiceBlocked() {
        assertEquals(Reason.PRACTICE_MODE, decide("PRACTICE", "COMPLETED", "READING", 400, false, valid));
        assertEquals(Reason.MODE_UNKNOWN, decide(null, "COMPLETED", "READING", 400, false, valid));
        ExamAttemptEvidenceBasis practice = ExamAttemptEvidenceBasis.pin(report(form, ExamContentValidationStatus.VALID,
                EnumSet.of(SkillType.READING), EnumSet.of(SkillType.READING)), form, "PUBLISHED", "PRACTICE",
                EnumSet.of(SkillType.READING), "h");
        assertTrue(practice.evidenceSkills().isEmpty(), "a pinned PRACTICE basis grants no evidence skill");
    }

    @Test
    @DisplayName("10. Legacy attempts without a pinned basis fail safely: LEGACY_VALIDATION_UNAVAILABLE (never current content)")
    void legacyFailsSafely() {
        assertEquals(Reason.LEGACY_VALIDATION_UNAVAILABLE, decide("EXAM_SIMULATION", "COMPLETED", "READING", 400, false,
                ExamAttemptEvidenceBasis.resolve(ExamSnapshotState.LEGACY_UNSNAPSHOTTED, null, form, "EXAM_SIMULATION")));
        assertEquals(Reason.LEGACY_VALIDATION_UNAVAILABLE, decide("EXAM_SIMULATION", "COMPLETED", "READING", 400, false,
                ExamAttemptEvidenceBasis.resolveFromSnapshot(ExamSnapshotState.SNAPSHOTTED, Map.of("sections", List.of()),
                        form, "EXAM_SIMULATION")), "a pre-4.1 snapshot without a basis is legacy, not current-validated");
        assertEquals(Reason.LEGACY_VALIDATION_UNAVAILABLE, decide("EXAM_SIMULATION", "COMPLETED", "READING", 400, false, null));
    }

    @Test
    @DisplayName("A basis that contradicts the attempt (other form / mode, malformed, INVALID snapshot) ⇒ SNAPSHOT_BASIS_MISMATCH")
    void mismatchBlocked() {
        Map<String, Object> m = valid.basis().toMap();
        assertEquals(Reason.SNAPSHOT_BASIS_MISMATCH, decide("EXAM_SIMULATION", "COMPLETED", "READING", 400, false,
                ExamAttemptEvidenceBasis.resolve(ExamSnapshotState.SNAPSHOTTED, m, UUID.randomUUID(), "EXAM_SIMULATION")));
        assertEquals(Reason.SNAPSHOT_BASIS_MISMATCH, decide("EXAM_SIMULATION", "COMPLETED", "READING", 400, false,
                ExamAttemptEvidenceBasis.resolve(ExamSnapshotState.SNAPSHOTTED, m, form, "PRACTICE")));
        Map<String, Object> broken = new HashMap<>(m);
        broken.put("validationStatus", "WHATEVER");
        assertEquals(Reason.SNAPSHOT_BASIS_MISMATCH, decide("EXAM_SIMULATION", "COMPLETED", "READING", 400, false,
                ExamAttemptEvidenceBasis.resolve(ExamSnapshotState.SNAPSHOTTED, broken, form, "EXAM_SIMULATION")));
        assertEquals(Reason.SNAPSHOT_BASIS_MISMATCH, decide("EXAM_SIMULATION", "COMPLETED", "READING", 400, false,
                ExamAttemptEvidenceBasis.resolve(ExamSnapshotState.INVALID, m, form, "EXAM_SIMULATION")));
    }

    @Test
    @DisplayName("Content condition = the PINNED evidence skills: practice-only / out-of-scope / UNKNOWN validation ⇒ not eligible")
    void pinnedContentCondition() {
        ExamAttemptEvidenceBasis.Resolution listeningOnly = pinned("EXAM_SIMULATION", EnumSet.of(SkillType.LISTENING),
                EnumSet.of(SkillType.LISTENING, SkillType.READING));
        assertEquals(Reason.ELIGIBLE, decide("EXAM_SIMULATION", "COMPLETED", "LISTENING", 300, false, listeningOnly));
        assertEquals(Reason.CONTENT_NOT_ELIGIBLE, decide("EXAM_SIMULATION", "COMPLETED", "READING", 300, false, listeningOnly));
        assertEquals(Reason.CONTENT_NOT_ELIGIBLE, decide("EXAM_SIMULATION", "COMPLETED", "SPEAKING", 6.0, false, valid),
                "a skill outside the attempt scope is never evidence");
        ExamAttemptEvidenceBasis unknown = ExamAttemptEvidenceBasis.pin(ExamFormValidationReport.unknown(form, "x", AT), form,
                "PUBLISHED", "EXAM_SIMULATION", EnumSet.of(SkillType.READING), "h");
        assertTrue(unknown.evidenceSkills().isEmpty(), "unknown validation grants nothing");
    }

    @Test
    @DisplayName("Valid simulation with a pinned basis ⇒ allowed; the basis survives a storage round trip unchanged")
    void validAllowedAndRoundTrip() {
        ExamEvidenceEligibilityPolicy.Decision d = ExamEvidenceEligibilityPolicy.decide("EXAM_SIMULATION", "COMPLETED",
                "READING", 350, false, valid);
        assertTrue(d.eligible());
        assertEquals(SkillType.READING, d.skill());
        assertEquals(valid.basis(), ExamAttemptEvidenceBasis.fromMap(valid.basis().toMap()).orElseThrow());
    }

    @Test
    @DisplayName("9. AI fallback, review-required, overall metrics and missing scores never become evidence")
    void otherGuards() {
        assertEquals(Reason.AI_FALLBACK, decide("EXAM_SIMULATION", "COMPLETED", "WRITING", 6.0, true, valid));
        assertEquals(Reason.NOT_COMPLETED, decide("EXAM_SIMULATION", "REVIEW_REQUIRED", "WRITING", 6.0, false, valid));
        assertEquals(Reason.NOT_COMPLETED, decide("EXAM_SIMULATION", "PENDING", "READING", 300, false, valid),
                "an incomplete attempt stays ineligible");
        assertEquals(Reason.NOT_A_SKILL_METRIC, decide("EXAM_SIMULATION", "COMPLETED", "FULL_OVERALL", 6.5, false, valid));
        assertEquals(Reason.NOT_A_SKILL_METRIC, decide("EXAM_SIMULATION", "COMPLETED", "LR_TOTAL", 700, false, valid));
        assertEquals(Reason.NO_SCORE, decide("EXAM_SIMULATION", "COMPLETED", "READING", -1, false, valid));
    }
}
