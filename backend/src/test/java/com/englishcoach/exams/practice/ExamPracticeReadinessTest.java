package com.englishcoach.exams.practice;

import com.englishcoach.exams.practice.ExamPracticeReadiness.FormFacts;
import com.englishcoach.exams.practice.ExamPracticeReadiness.LearnerState;
import com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness;
import com.englishcoach.exams.release.ExamRunnerCapabilities;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamContentValidationStatus;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.englishcoach.exams.validation.ExamFormValidator;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Exams Phase 6 — scope-level practice readiness over synthetic canonical trees judged by the REAL, unchanged Phase 2
 * validator (test matrix 01–15, LABEL_ASSIGNMENT 47/52/53 at readiness level).
 */
class ExamPracticeReadinessTest {

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final FormFacts OK = new FormFacts(true, true);

    static List<ScopeReadiness> evaluate(ExamContentTree tree) {
        return evaluate(tree, ExamRunnerCapabilities.CURRENT, OK);
    }

    static List<ScopeReadiness> evaluate(ExamContentTree tree, ExamRunnerCapabilities.Capabilities caps, FormFacts facts) {
        ExamFormValidationReport report = ExamFormValidator.validate(tree, MAPPER, Instant.now());
        return ExamPracticeReadiness.evaluate(tree, report, caps, facts, MAPPER);
    }

    static ScopeReadiness scope(List<ScopeReadiness> all, String code) {
        return all.stream().filter(s -> s.scope().scopeCode().equals(code)).findFirst()
                .orElseThrow(() -> new AssertionError("scope not offered: " + code));
    }

    @Test void oneFingerprintForAllCanonicalParts() {
        ExamContentTree tree = org.mockito.Mockito.spy(new PracticeTreeFixtures.Toeic().build());
        var report = ExamFormValidator.validate(tree, MAPPER, Instant.now());
        org.mockito.Mockito.clearInvocations(tree);
        var scopes = ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT, OK, MAPPER);
        assertEquals(7, scopes.size()); assertTrue(scopes.stream().allMatch(ScopeReadiness::ready));
        org.mockito.Mockito.verify(tree, org.mockito.Mockito.times(1)).fingerprint();
    }

    @Test
    @DisplayName("01–09: every TOEIC part of a sound form is a ready practice scope with its canonical shape preserved")
    void toeicPartsReady() {
        ExamContentTree tree = new PracticeTreeFixtures.Toeic().build();
        ExamFormValidationReport report = ExamFormValidator.validate(tree, MAPPER, Instant.now());
        assertEquals(ExamContentValidationStatus.VALID, report.status(), "synthetic fixture must be a valid TOEIC form: " + report.blockingCodes());
        List<ScopeReadiness> all = ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT, OK, MAPPER);
        assertEquals(List.of("TOEIC_PART_1", "TOEIC_PART_2", "TOEIC_PART_3", "TOEIC_PART_4", "TOEIC_PART_5", "TOEIC_PART_6",
                "TOEIC_PART_7"), all.stream().map(s -> s.scope().scopeCode()).toList());
        for (ScopeReadiness s : all) {
            assertTrue(s.ready(), s.scope().scopeCode() + " " + s.reasonCodes());
            assertEquals(LearnerState.AVAILABLE, s.learnerState());
            assertEquals(ExamPracticeScope.SCORING_OBJECTIVE_RAW, s.scope().scoringMode());
        }
        assertEquals(6, scope(all, "TOEIC_PART_1").scope().groupIds().size(), "Part 1: one photo per group");
        assertEquals(25, scope(all, "TOEIC_PART_2").scope().itemCount());
        assertEquals(13, scope(all, "TOEIC_PART_3").scope().groupIds().size(), "Part 3: 13 conversations of 3");
        assertEquals(39, scope(all, "TOEIC_PART_3").scope().itemCount());
        assertEquals(10, scope(all, "TOEIC_PART_4").scope().groupIds().size(), "Part 4: 10 talks of 3");
        assertEquals(30, scope(all, "TOEIC_PART_5").scope().itemCount());
        assertEquals(4, scope(all, "TOEIC_PART_6").scope().groupIds().size(), "Part 6: 4 passage sets");
        ScopeReadiness p7 = scope(all, "TOEIC_PART_7");
        assertEquals(15, p7.scope().groupIds().size(), "Part 7: 10 single + 2 double + 3 triple sets, never flattened");
        assertEquals(54, p7.scope().itemCount());
        assertEquals(SkillTypeName.READING, SkillTypeName.of(p7.scope().skill()));
        assertFalse(all.stream().anyMatch(s -> s.scope().scopeCode().contains("SPEAKING")));
    }

    @Test
    @DisplayName("02: TOEIC Part 2 is never forced to four options — a four-option Part 2 is not a ready scope")
    void part2ThreeOptions() {
        PracticeTreeFixtures.Toeic f = new PracticeTreeFixtures.Toeic();
        f.part2Options = 4;
        ScopeReadiness p2 = scope(evaluate(f.build()), "TOEIC_PART_2");
        assertFalse(p2.ready());
        assertTrue(p2.reasonCodes().contains(ExamPracticeReadiness.TOEIC_PART_SHAPE_INVALID), p2.reasonCodes().toString());
    }

    @Test
    @DisplayName("media pending: Part 1 photos / a Part 3 graphic awaiting crop approval ⇒ 'content in progress', others ready")
    void pendingMediaBlocksOnlyItsScope() {
        PracticeTreeFixtures.Toeic f = new PracticeTreeFixtures.Toeic();
        f.part1ImageState = "PENDING";
        f.graphicState = "PENDING";
        ExamContentTree tree = f.build();
        ExamFormValidationReport report = ExamFormValidator.validate(tree, MAPPER, Instant.now());
        assertEquals(ExamContentValidationStatus.VALID, report.status(), "an unvalidated visual is only a WARNING in Phase 2");
        List<ScopeReadiness> all = ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT, OK, MAPPER);
        ScopeReadiness p1 = scope(all, "TOEIC_PART_1");
        assertFalse(p1.ready(), "a structurally valid form does not make every scope practice-ready");
        assertEquals(LearnerState.CONTENT_IN_PROGRESS, p1.learnerState());
        assertEquals(List.of(ExamPracticeReadiness.MEDIA_IMAGE_PENDING), p1.reasonCodes());
        assertEquals(LearnerState.CONTENT_IN_PROGRESS, scope(all, "TOEIC_PART_3").learnerState());
        for (String ready : List.of("TOEIC_PART_2", "TOEIC_PART_4", "TOEIC_PART_5", "TOEIC_PART_6", "TOEIC_PART_7")) {
            assertTrue(scope(all, ready).ready(), ready);
        }
    }

    @Test
    @DisplayName("a blocked full form (listening audio missing) still offers sound reading parts; listening parts fail closed")
    void blockedFormDoesNotBlockSoundScopes() {
        PracticeTreeFixtures.Toeic f = new PracticeTreeFixtures.Toeic();
        f.listeningAudio = false;
        ExamContentTree tree = f.build();
        ExamFormValidationReport report = ExamFormValidator.validate(tree, MAPPER, Instant.now());
        assertFalse(report.fullSimulationEligible());
        List<ScopeReadiness> all = ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT, OK, MAPPER);
        assertTrue(scope(all, "TOEIC_PART_5").ready(), scope(all, "TOEIC_PART_5").reasonCodes().toString());
        assertTrue(scope(all, "TOEIC_PART_7").ready());
        ScopeReadiness p2 = scope(all, "TOEIC_PART_2");
        assertFalse(p2.ready());
        assertEquals(LearnerState.UNAVAILABLE, p2.learnerState());
        assertTrue(p2.reasonCodes().contains(ExamPracticeReadiness.MEDIA_AUDIO_MISSING), p2.reasonCodes().toString());
    }

    @Test
    @DisplayName("15: source-blocked content (no answer keys in the corpus) is never a practice scope")
    void sourceBlockedNoKeys() {
        PracticeTreeFixtures.Toeic f = new PracticeTreeFixtures.Toeic();
        f.keyed = false;
        for (ScopeReadiness s : evaluate(f.build())) {
            assertFalse(s.ready(), s.scope().scopeCode());
            assertEquals(LearnerState.UNAVAILABLE, s.learnerState());
            assertTrue(s.reasonCodes().contains(ExamPracticeReadiness.ANSWER_KEY_MISSING), s.reasonCodes().toString());
        }
    }

    @Test
    @DisplayName("14: lifecycle / rights / validation preconditions fail closed")
    void formPreconditions() {
        ExamContentTree tree = new PracticeTreeFixtures.Toeic().build();
        ScopeReadiness noRights = scope(evaluate(tree, ExamRunnerCapabilities.CURRENT, new FormFacts(true, false)), "TOEIC_PART_5");
        assertTrue(noRights.reasonCodes().contains(ExamPracticeReadiness.RIGHTS_OR_PROVENANCE_UNVERIFIED));
        ScopeReadiness draft = scope(evaluate(tree, ExamRunnerCapabilities.CURRENT, new FormFacts(false, true)), "TOEIC_PART_5");
        assertTrue(draft.reasonCodes().contains(ExamPracticeReadiness.FORM_NOT_ATTEMPTABLE));

        ExamFormValidationReport unknown = ExamFormValidationReport.unknown(tree.formId(), "VALIDATION_ERROR", Instant.now());
        ScopeReadiness u = scope(ExamPracticeReadiness.evaluate(tree, unknown, ExamRunnerCapabilities.CURRENT, OK, MAPPER), "TOEIC_PART_5");
        assertTrue(u.reasonCodes().contains(ExamPracticeReadiness.VALIDATION_UNAVAILABLE));

        PracticeTreeFixtures.Toeic changed = new PracticeTreeFixtures.Toeic();
        changed.part1ImageState = "PENDING";
        ExamFormValidationReport staleReport = ExamFormValidator.validate(tree, MAPPER, Instant.now());
        ScopeReadiness stale = scope(ExamPracticeReadiness.evaluate(changed.build(), staleReport, ExamRunnerCapabilities.CURRENT, OK,
                MAPPER), "TOEIC_PART_5");
        assertTrue(stale.reasonCodes().contains(ExamPracticeReadiness.VALIDATION_STALE), "validation of other content is never trusted");
    }

    @Test
    @DisplayName("IELTS listening, reading, writing and Speaking Part scopes are available")
    void ieltsScopes() {
        ExamContentTree tree = new PracticeTreeFixtures.Ielts().build();
        List<ScopeReadiness> all = evaluate(tree);
        List<String> codes = all.stream().map(s -> s.scope().scopeCode()).toList();
        assertEquals(List.of("IELTS_LISTENING_SECTION_1", "IELTS_LISTENING_SECTION_2", "IELTS_LISTENING_SECTION_3",
                "IELTS_LISTENING_SECTION_4", "IELTS_READING_PASSAGE_1", "IELTS_READING_PASSAGE_2", "IELTS_READING_PASSAGE_3",
                "IELTS_WRITING_TASK_1", "IELTS_WRITING_TASK_2", "IELTS_SPEAKING_PART_1"), codes);
        for (ScopeReadiness s : all) assertTrue(s.ready(), s.scope().scopeCode() + " " + s.reasonCodes());
        assertEquals(ExamPracticeScope.SCORING_RESPONSE_ONLY, scope(all, "IELTS_WRITING_TASK_1").scope().scoringMode());
        assertEquals(0, scope(all, "IELTS_WRITING_TASK_2").scope().objectiveItemCount());
        assertEquals(14, scope(all, "IELTS_READING_PASSAGE_3").scope().itemCount());
    }

    @Test
    @DisplayName("12: Writing Task 1 needs its visual — pending crop ⇒ in progress, missing visual ⇒ unavailable; Task 2 unaffected")
    void writingTask1Visual() {
        PracticeTreeFixtures.Ielts pending = new PracticeTreeFixtures.Ielts();
        pending.task1VisualState = "PENDING";
        List<ScopeReadiness> a = evaluate(pending.build());
        assertEquals(LearnerState.CONTENT_IN_PROGRESS, scope(a, "IELTS_WRITING_TASK_1").learnerState());
        assertTrue(scope(a, "IELTS_WRITING_TASK_2").ready());

        PracticeTreeFixtures.Ielts missing = new PracticeTreeFixtures.Ielts();
        missing.task1Visual = false;
        ScopeReadiness t1 = scope(evaluate(missing.build()), "IELTS_WRITING_TASK_1");
        assertFalse(t1.ready());
        assertTrue(t1.reasonCodes().contains(ExamPracticeReadiness.VISUAL_MISSING), t1.reasonCodes().toString());
    }

    @Test
    @DisplayName("47/53/54: LABEL_ASSIGNMENT is ready only with the declared runtime support AND a deliverable figure")
    void labelAssignment() {
        PracticeTreeFixtures.Ielts f = new PracticeTreeFixtures.Ielts();
        f.labelAssignmentPart2 = true;
        ExamContentTree tree = f.build();
        ScopeReadiness ready = scope(evaluate(tree), "IELTS_LISTENING_SECTION_2");
        assertTrue(ready.ready(), ready.reasonCodes().toString());

        Map<String, ExamRunnerCapabilities.Support> degraded = new HashMap<>(ExamRunnerCapabilities.INTERACTIONS);
        degraded.put("LABEL_ASSIGNMENT", ExamRunnerCapabilities.Support.UNSUPPORTED);
        ExamRunnerCapabilities.Capabilities old = new ExamRunnerCapabilities.Capabilities(degraded, ExamRunnerCapabilities.FEATURES,
                ExamRunnerCapabilities.MANIFEST_CONTRACT, ExamRunnerCapabilities.SCORING_CONTRACT,
                ExamRunnerCapabilities.OBJECTIVE_SCORER_INTERACTIONS);
        ScopeReadiness blocked = scope(evaluate(tree, old, OK), "IELTS_LISTENING_SECTION_2");
        assertFalse(blocked.ready());
        assertTrue(blocked.reasonCodes().contains(ExamPracticeReadiness.INTERACTION_UNSUPPORTED_PREFIX + "LABEL_ASSIGNMENT"));
        assertTrue(scope(evaluate(tree, old, OK), "IELTS_LISTENING_SECTION_1").ready(), "other sections unaffected");

        f.labelFigure = false;
        ScopeReadiness noFigure = scope(evaluate(f.build()), "IELTS_LISTENING_SECTION_2");
        assertTrue(noFigure.reasonCodes().contains(ExamPracticeReadiness.VISUAL_MISSING), noFigure.reasonCodes().toString());
        assertEquals("SUPPORTED", ExamRunnerCapabilities.INTERACTIONS.get("LABEL_ASSIGNMENT").name());
    }

    @Test
    @DisplayName("an omitted group leaves a numbering gap ⇒ the scope is not offered as complete; ambiguous scope never guessed")
    void numberingAndAmbiguity() {
        PracticeTreeFixtures.Ielts gap = new PracticeTreeFixtures.Ielts();
        gap.numberingGapPart1 = true;
        ScopeReadiness s1 = scope(evaluate(gap.build()), "IELTS_LISTENING_SECTION_1");
        assertTrue(s1.reasonCodes().contains(ExamPracticeReadiness.QUESTION_NUMBERING_UNPROVEN), s1.reasonCodes().toString());

        PracticeTreeFixtures.Ielts dup = new PracticeTreeFixtures.Ielts();
        dup.duplicateReadingPassage1 = true;
        ScopeReadiness p1 = scope(evaluate(dup.build()), "IELTS_READING_PASSAGE_1");
        assertEquals(List.of(ExamPracticeReadiness.SCOPE_AMBIGUOUS), p1.reasonCodes());
    }

    @Test
    @DisplayName("scope resolution: only canonical part codes map to scopes (client strings never decide)")
    void scopeTypeResolution() {
        assertEquals("TOEIC_PART_5", ExamPracticeScopeType.resolve(com.englishcoach.exams.model.ExamTypes.ExamFamily.TOEIC,
                com.englishcoach.exams.model.ExamTypes.SkillType.READING, "READING_PART_5").orElseThrow().scopeCode());
        assertTrue(ExamPracticeScopeType.resolve(com.englishcoach.exams.model.ExamTypes.ExamFamily.TOEIC,
                com.englishcoach.exams.model.ExamTypes.SkillType.READING, "READING_PART_3").isEmpty(), "Part 3 is listening");
        assertEquals("IELTS_SPEAKING_PART_1", ExamPracticeScopeType.resolve(com.englishcoach.exams.model.ExamTypes.ExamFamily.IELTS,
                com.englishcoach.exams.model.ExamTypes.SkillType.SPEAKING, "SPEAKING_PART_1").orElseThrow().scopeCode());
        assertTrue(ExamPracticeScopeType.resolve(com.englishcoach.exams.model.ExamTypes.ExamFamily.IELTS,
                com.englishcoach.exams.model.ExamTypes.SkillType.SPEAKING, "SPEAKING_PART_4").isEmpty());
        assertTrue(ExamPracticeScopeType.resolve(com.englishcoach.exams.model.ExamTypes.ExamFamily.IELTS,
                com.englishcoach.exams.model.ExamTypes.SkillType.WRITING, "WRITING_TASK_3").isEmpty());
    }

    /** Tiny helper keeping the assertion above readable without importing SkillType twice. */
    enum SkillTypeName {
        LISTENING, READING, WRITING, SPEAKING;

        static SkillTypeName of(com.englishcoach.exams.model.ExamTypes.SkillType s) {
            return valueOf(s.name());
        }
    }
}
