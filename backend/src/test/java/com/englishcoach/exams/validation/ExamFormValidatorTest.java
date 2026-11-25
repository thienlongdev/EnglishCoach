package com.englishcoach.exams.validation;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.validation.ExamContentTree.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

import static com.englishcoach.exams.validation.ExamContentFixtures.*;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Exams Recovery Phase 2 — authoritative validator test matrix (fixtures follow the PUBLIC formats only).
 * Numbers in display names refer to the Phase 2 test matrix.
 */
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamFormValidatorTest {

    private static Set<String> codes(ExamFormValidationReport r) {
        Set<String> out = new TreeSet<>();
        r.allDiagnostics().forEach(d -> out.add(d.qualifiedCode()));
        return out;
    }

    private static ExamFormValidationReport.SectionValidation section(ExamFormValidationReport r, SkillType skill) {
        return r.sections().stream().filter(s -> s.skill() == skill).findFirst().orElseThrow();
    }

    private static ExamValidationDiagnostic diag(ExamFormValidationReport r, String qualifiedCode) {
        return r.allDiagnostics().stream().filter(d -> d.qualifiedCode().equals(qualifiedCode)).findFirst()
                .orElseThrow(() -> new AssertionError(qualifiedCode + " not in " + codes(r)));
    }

    @Nested
    class Toeic {

        @Test
        @DisplayName("1. Valid TOEIC L&R 2016 structure ⇒ FULL valid, both skills simulation-grade")
        void validToeicFull() {
            ExamFormValidationReport r = validate(toeicLr(null));
            assertEquals(ExamContentValidationStatus.VALID, r.status(), codes(r).toString());
            assertTrue(r.fullSimulationEligible());
            assertEquals(EnumSet.of(SkillType.LISTENING, SkillType.READING), r.simulationSkills());
            assertEquals(List.of("PRACTICE", "EXAM_SIMULATION"), r.availableModes());
            assertTrue(r.blockingCodes().isEmpty(), r.blockingCodes().toString());
            assertEquals("TOEIC_LR_2016", r.blueprintId());
        }

        @Test
        @DisplayName("1b. Valid pre-2016 TOEIC (10/30/30/30 · 40/12/48) is recognised and valid")
        void validLegacyToeic() {
            ExamFormValidationReport r = validate(toeicLr(k -> k.legacyFormat = true));
            assertEquals("TOEIC_LR_PRE_2016", r.blueprintId());
            assertTrue(r.fullSimulationEligible(), codes(r).toString());
        }

        @Test
        @DisplayName("2. Part 3 flattened into one 39-item group ⇒ invalid although the count (39) is right")
        void flattenedPart3() {
            ExamFormValidationReport r = validate(toeicLr(k -> k.flattenPart3 = true));
            ExamValidationDiagnostic d = diag(r, "TOEIC_PART_3_GROUP_SIZE");
            assertEquals(ExamValidationSeverity.BLOCKING, d.severity());
            assertEquals("max=3 actual=39", d.detail());
            assertFalse(codes(r).contains("TOEIC_PART_3_ITEM_COUNT"), "the count itself is correct");
            assertTrue(codes(r).contains("TOEIC_PART_3_GROUP_COUNT"));
            assertEquals(ExamContentValidationStatus.INVALID, section(r, SkillType.LISTENING).status());
            assertFalse(r.fullSimulationEligible());
            assertFalse(r.isPracticeRunnable(SkillType.LISTENING));
            assertTrue(r.isSimulationReady(SkillType.READING), "only the broken skill is blocked");
        }

        @Test
        @DisplayName("3. Part 6 set without its passage ⇒ invalid")
        void part6MissingPassage() {
            ExamFormValidationReport r = validate(toeicLr(k -> k.part6Passages = false));
            assertEquals(ExamValidationSeverity.BLOCKING, diag(r, "TOEIC_PART_6_PASSAGE_MISSING").severity());
            assertEquals(4, r.allDiagnostics().stream().filter(d -> d.qualifiedCode().equals("TOEIC_PART_6_PASSAGE_MISSING")).count(),
                    "one finding per set (4 groups)");
            assertEquals(ExamContentValidationStatus.INVALID, section(r, SkillType.READING).status());
            assertFalse(r.fullSimulationEligible());
        }

        @Test
        @DisplayName("4. Part 7 set without passage ⇒ invalid")
        void part7MissingPassage() {
            ExamFormValidationReport r = validate(toeicLr(k -> k.part7Passages = false));
            assertTrue(codes(r).contains("TOEIC_PART_7_PASSAGE_MISSING"));
            assertFalse(r.isPracticeRunnable(SkillType.READING));
        }

        @Test
        @DisplayName("5. Missing mandatory Listening audio ⇒ full invalid; Reading practice/simulation still possible")
        void missingAudio() {
            ExamFormValidationReport r = validate(toeicLr(k -> k.listeningAudio = false));
            assertTrue(codes(r).contains("REQUIRED_AUDIO_MISSING"));
            assertFalse(r.fullSimulationEligible());
            assertFalse(r.isPracticeRunnable(SkillType.LISTENING));
            assertTrue(r.isPracticeRunnable(SkillType.READING), "mode/scope aware: Reading stays practicable");
            assertEquals(ExamContentValidationStatus.NEEDS_REVIEW, r.status());
            assertEquals(List.of("PRACTICE"), r.availableModes());
        }

        @Test
        @DisplayName("5b. Audio present but never validated ⇒ UNVALIDATED_MEDIA + REQUIRED_AUDIO_MISSING")
        void unvalidatedAudio() {
            ExamFormValidationReport r = validate(toeicLr(k -> k.audioValidated = false));
            assertTrue(codes(r).containsAll(List.of("UNVALIDATED_MEDIA", "REQUIRED_AUDIO_MISSING")), codes(r).toString());
            assertFalse(r.isPracticeRunnable(SkillType.LISTENING));
        }

        @Test
        @DisplayName("5c. One Part without audio ⇒ Listening practice-only (not simulation, not evidence)")
        void partWithoutAudio() {
            ExamFormValidationReport r = validate(toeicLr(k -> k.part4Audio = false));
            assertEquals(ExamValidationSeverity.STANDARD, diag(r, "TOEIC_PART_4_AUDIO_MISSING").severity());
            assertEquals(ExamContentValidationStatus.PRACTICE_ONLY, section(r, SkillType.LISTENING).status());
            assertTrue(r.isPracticeRunnable(SkillType.LISTENING));
            assertFalse(r.isOfficialEvidenceEligible(SkillType.LISTENING));
            assertFalse(r.fullSimulationEligible());
        }

        @Test
        @DisplayName("6. Empty / debris answer keys ⇒ not evidence eligible (and not runnable)")
        void badKeys() {
            ExamFormValidationReport empty = validate(toeicLr(k -> k.readingKey = ""));
            assertTrue(codes(empty).contains("ANSWER_KEY_EMPTY"));
            assertFalse(empty.isOfficialEvidenceEligible(SkillType.READING));
            assertTrue(empty.isOfficialEvidenceEligible(SkillType.LISTENING));

            ExamFormValidationReport debris = validate(toeicLr(k -> k.listeningKey = "minutes"));
            assertTrue(codes(debris).containsAll(List.of("INVALID_TOEIC_ANSWER_KEY", "INVALID_OPTION_KEY")), codes(debris).toString());
            assertFalse(debris.isOfficialEvidenceEligible(SkillType.LISTENING));
            assertFalse(debris.fullSimulationEligible());
        }

        @Test
        @DisplayName("7. Placeholder prompt signature ⇒ invalid")
        void placeholderPrompt() {
            ExamFormValidationReport r = validate(toeicLr(k -> k.placeholderPrompts = true));
            assertEquals(ExamValidationSeverity.BLOCKING, r.allDiagnostics().stream()
                    .filter(d -> d.code() == ExamValidationCode.PLACEHOLDER_PROMPT_DETECTED).findFirst().orElseThrow().severity());
            assertTrue(r.practiceSkills().isEmpty());
            assertEquals(ExamContentValidationStatus.INVALID, r.status());
        }

        @Test
        @DisplayName("Phase 0 regression: placeholder real-corpus shape trips every Phase 0 signature")
        void phase0PlaceholderCorpus() {
            ExamFormValidationReport r = validate(toeicLr(k -> {
                k.flattenPart3 = true;
                k.placeholderPrompts = true;
                k.letterOnlyOptions = true;
                k.listeningKey = "";
                k.part7Passages = false;
            }));
            assertTrue(codes(r).containsAll(List.of("ANSWER_KEY_EMPTY", "PLACEHOLDER_PROMPT_DETECTED", "PLACEHOLDER_OPTIONS",
                    "TOEIC_PART_3_GROUP_SIZE", "TOEIC_PART_7_PASSAGE_MISSING")), codes(r).toString());
            assertTrue(r.practiceSkills().isEmpty());
        }

        @Test
        @DisplayName("Part 1 photographs are required; Part 2 'Mark your answer…' is the real printed text")
        void part1ImagesAndPart2Prompt() {
            ExamFormValidationReport r = validate(toeicLr(k -> k.part1Images = false));
            assertEquals(ExamValidationSeverity.BLOCKING, diag(r, "TOEIC_PART_1_IMAGE_MISSING").severity());
            assertFalse(codes(validate(toeicLr(null))).contains("PLACEHOLDER_PROMPT_DETECTED"));
            assertTrue(ExamFormValidator.isPlaceholderPrompt("Mark your answer on your answer sheet.", false, -1));
            assertFalse(ExamFormValidator.isPlaceholderPrompt("Mark your answer on your answer sheet.", true, 2));
        }

        @Test
        @DisplayName("TOEIC L&R form without Reading ⇒ FORM_SKILL_MISSING, never full; Listening alone still simulation-grade")
        void missingSkill() {
            ExamFormValidationReport r = validate(toeicLr(k -> k.includeReading = false));
            assertTrue(codes(r).contains("FORM_SKILL_MISSING"));
            assertFalse(r.fullSimulationEligible());
            assertTrue(r.isSimulationReady(SkillType.LISTENING));
        }
    }

    @Nested
    class Ielts {

        @Test
        @DisplayName("8. Valid IELTS Listening structure ⇒ skill valid (and a LISTENING-scope form is full)")
        void validListening() {
            UUID formId = UUID.randomUUID();
            ExamFormValidationReport r = validate(tree(formId, ExamFamily.IELTS, "ACADEMIC", "LISTENING",
                    List.of(ieltsListening(formId, true))));
            assertEquals(ExamContentValidationStatus.VALID, r.status(), codes(r).toString());
            assertTrue(r.isOfficialEvidenceEligible(SkillType.LISTENING));
        }

        @Test
        @DisplayName("8b. Valid IELTS Academic full form ⇒ VALID; Speaking reported as runtime-generated (INFO)")
        void validFull() {
            ExamFormValidationReport r = validate(ieltsFull(true, true));
            assertTrue(r.fullSimulationEligible(), codes(r).toString());
            assertEquals(ExamValidationSeverity.INFO, diag(r, "SPEAKING_PROMPTS_RUNTIME_GENERATED").severity());
        }

        @Test
        @DisplayName("9. IELTS Reading without its passage ⇒ invalid")
        void readingWithoutPassage() {
            ExamFormValidationReport r = validate(ieltsFull(true, false));
            assertEquals(ExamValidationSeverity.BLOCKING, diag(r, "IELTS_READING_PASSAGE_MISSING").severity());
            assertFalse(r.isPracticeRunnable(SkillType.READING));
            assertFalse(r.fullSimulationEligible());
            assertTrue(r.isSimulationReady(SkillType.LISTENING));
        }

        @Test
        @DisplayName("10. Writing: prompts present ⇒ valid; blank prompt ⇒ invalid; Academic without chart ⇒ practice only")
        void writing() {
            UUID formId = UUID.randomUUID();
            ExamFormValidationReport ok = validate(tree(formId, ExamFamily.IELTS, "ACADEMIC", "WRITING",
                    List.of(ieltsWriting(formId, true, true))));
            assertEquals(ExamContentValidationStatus.VALID, ok.status(), codes(ok).toString());

            ExamFormValidationReport blank = validate(tree(formId, ExamFamily.IELTS, "ACADEMIC", "WRITING",
                    List.of(ieltsWriting(formId, true, false))));
            assertTrue(codes(blank).contains("PROMPT_MISSING"));
            assertFalse(blank.isPracticeRunnable(SkillType.WRITING));

            ExamFormValidationReport noChart = validate(tree(formId, ExamFamily.IELTS, "ACADEMIC", "WRITING",
                    List.of(ieltsWriting(formId, false, true))));
            assertEquals(ExamValidationSeverity.STANDARD, diag(noChart, "IELTS_WRITING_VISUAL_MISSING").severity());
            assertTrue(noChart.isPracticeRunnable(SkillType.WRITING));
            assertFalse(noChart.isSimulationReady(SkillType.WRITING));
        }

        @Test
        @DisplayName("Choice item without options ⇒ OPTIONS_MISSING (never invent options from the prompt)")
        void choiceWithoutOptions() {
            UUID formId = UUID.randomUUID();
            ItemNode noOptions = new ItemNode(UUID.randomUUID(), "FX_NO_OPT", 1, "Synthetic choice", "single_choice",
                    "{\"options\":[]}", new AnswerNode(UUID.randomUUID(), key("A"), 1, null, null), 1);
            SectionNode reading = new SectionNode(UUID.randomUUID(), formId, SkillType.READING, 1, 3600, true, null,
                    List.of(new PartNode(UUID.randomUUID(), "P1", 1, List.of(new GroupNode(UUID.randomUUID(), UUID.randomUUID(), 0,
                            List.of(new StimulusNode(UUID.randomUUID(), "TEXT", true, List.of())), List.of(noOptions))))));
            ExamFormValidationReport r = validate(tree(formId, ExamFamily.IELTS, "ACADEMIC", "READING", List.of(reading)));
            assertTrue(codes(r).contains("OPTIONS_MISSING"));
            assertFalse(r.isPracticeRunnable(SkillType.READING));
        }
    }

    @Nested
    class FailClosedAndOperators {

        @Test
        @DisplayName("11. Unknown validation state ⇒ nothing runnable, not full, not evidence")
        void unknownFailsClosed() {
            ExamFormValidationReport u = ExamFormValidationReport.unknown(UUID.randomUUID(), "VALIDATION_ERROR", NOW);
            assertEquals(ExamContentValidationStatus.UNKNOWN, u.status());
            assertFalse(u.fullSimulationEligible());
            assertTrue(u.practiceSkills().isEmpty());
            assertFalse(u.isOfficialEvidenceEligible(SkillType.READING));
            assertTrue(u.availableModes().isEmpty());
            assertTrue(u.contentReviewRequired());
            assertEquals(ExamContentValidationStatus.UNKNOWN, ExamContentValidationStatus.parse("FULLY_PASSING"));
            assertEquals(ExamContentValidationStatus.UNKNOWN, ExamContentValidationStatus.parse(null));
            // An UNKNOWN status can never carry eligibility, even if a caller passes it in.
            ExamFormValidationReport forged = new ExamFormValidationReport(UUID.randomUUID(), "v", null, NOW, null, null, null,
                    ExamContentValidationStatus.UNKNOWN, true, Set.of(), EnumSet.allOf(SkillType.class),
                    EnumSet.allOf(SkillType.class), List.of(), List.of());
            assertFalse(forged.fullSimulationEligible());
            assertTrue(forged.simulationSkills().isEmpty());
        }

        @Test
        @DisplayName("Operator flags only restrict: DISABLED ⇒ invalid, NEEDS_REVIEW ⇒ practice only, is_runnable=false ⇒ section off")
        void operatorFlags() {
            ExamContentTree base = toeicLr(null);
            ExamContentTree disabled = new ExamContentTree(base.formId(), base.family(), base.variant(), base.scope(), "DISABLED",
                    true, Map.of(), base.sections());
            assertTrue(validate(disabled).practiceSkills().isEmpty());

            ExamContentTree review = new ExamContentTree(base.formId(), base.family(), base.variant(), base.scope(), "NEEDS_REVIEW",
                    true, Map.of(), base.sections());
            ExamFormValidationReport rr = validate(review);
            assertEquals(EnumSet.of(SkillType.LISTENING, SkillType.READING), rr.practiceSkills());
            assertTrue(rr.simulationSkills().isEmpty());
            assertFalse(rr.fullSimulationEligible());

            ExamContentTree legacyPass = new ExamContentTree(base.formId(), base.family(), base.variant(), base.scope(), "FULLY_PASSING",
                    true, Map.of(), base.sections());
            assertTrue(validate(legacyPass).fullSimulationEligible(), "a legacy PASS-like string grants nothing and takes nothing");

            SectionNode l = base.sections().get(0);
            SectionNode off = new SectionNode(l.id(), l.formId(), l.skill(), l.ordinal(), l.durationSeconds(), false, null, l.parts());
            ExamFormValidationReport ro = validate(new ExamContentTree(base.formId(), base.family(), base.variant(), base.scope(), null,
                    true, Map.of(), List.of(off, base.sections().get(1))));
            assertTrue(codes(ro).contains("OPERATOR_SECTION_DISABLED"));
            assertFalse(ro.isPracticeRunnable(SkillType.LISTENING));
            assertTrue(ro.isSimulationReady(SkillType.READING));

            // A section flag of NULL (legacy prod rows) is "not engaged": it never makes broken content runnable.
            ExamContentTree broken = toeicLr(k -> k.listeningAudio = false);
            SectionNode bl = broken.sections().get(0);
            SectionNode nullFlag = new SectionNode(bl.id(), bl.formId(), bl.skill(), bl.ordinal(), bl.durationSeconds(), null, null, bl.parts());
            assertFalse(validate(new ExamContentTree(broken.formId(), broken.family(), broken.variant(), broken.scope(), null, true,
                    Map.of(), List.of(nullFlag, broken.sections().get(1)))).isPracticeRunnable(SkillType.LISTENING));
        }

        @Test
        @DisplayName("No sections / unknown scope / zero duration all fail closed")
        void structuralFailClosed() {
            assertEquals(ExamContentValidationStatus.INVALID,
                    validate(tree(UUID.randomUUID(), ExamFamily.TOEIC, "LR", "FULL", List.of())).status());
            ExamContentTree base = toeicLr(null);
            ExamFormValidationReport unknownScope = validate(new ExamContentTree(base.formId(), base.family(), "LR", "SOMETHING", null,
                    true, Map.of(), base.sections()));
            assertTrue(codes(unknownScope).contains("FORM_SCOPE_UNKNOWN"));
            assertFalse(unknownScope.fullSimulationEligible());
        }

        @Test
        @DisplayName("Duplicate item placement ⇒ DUPLICATE_ITEM_ID")
        void duplicateItem() {
            ExamContentTree base = toeicLr(null);
            SectionNode r = base.sections().get(1);
            PartNode p5 = r.parts().get(0);
            GroupNode g = p5.groups().get(0);
            List<ItemNode> items = new ArrayList<>(g.items());
            items.set(1, items.get(0));
            SectionNode dup = new SectionNode(r.id(), r.formId(), r.skill(), r.ordinal(), r.durationSeconds(), true, null,
                    List.of(new PartNode(p5.id(), p5.partCode(), p5.ordinal(), List.of(new GroupNode(g.groupId(), g.placementId(),
                            g.ordinal(), g.stimuli(), items))), r.parts().get(1), r.parts().get(2)));
            ExamFormValidationReport rep = validate(new ExamContentTree(base.formId(), base.family(), base.variant(), base.scope(),
                    null, true, Map.of(), List.of(base.sections().get(0), dup)));
            assertTrue(codes(rep).contains("DUPLICATE_ITEM_ID"));
            assertFalse(rep.isPracticeRunnable(SkillType.READING));
        }
    }

    @Nested
    class FingerprintAndPackages {

        @Test
        @DisplayName("17. Fingerprint is deterministic and changes with content, media state and operator flags")
        void fingerprint() {
            ExamContentTree t = toeicLr(null);
            assertEquals(t.fingerprint(), t.fingerprint());
            ExamContentTree flagged = new ExamContentTree(t.formId(), t.family(), t.variant(), t.scope(), "NEEDS_REVIEW", true,
                    Map.of(), t.sections());
            assertNotEquals(t.fingerprint(), flagged.fingerprint());
            assertEquals(64, t.fingerprint().length());
            assertEquals(t.fingerprint(), validate(t).contentFingerprint());
        }

        @Test
        @DisplayName("Qualified codes: TOEIC codes carry the part; others unchanged")
        void qualifiedCodes() {
            assertEquals("TOEIC_PART_3_GROUP_SIZE", new ExamValidationDiagnostic(ExamValidationCode.TOEIC_GROUP_SIZE,
                    ExamValidationSeverity.BLOCKING, null, null, "PART_3", 3, null, null, 1, null).qualifiedCode());
            assertEquals("TOEIC_PART_7_ITEM_COUNT", new ExamValidationDiagnostic(ExamValidationCode.TOEIC_PART_ITEM_COUNT,
                    ExamValidationSeverity.STANDARD, null, null, "PART_7", 7, null, null, 1, null).qualifiedCode());
            assertEquals("REQUIRED_AUDIO_MISSING", new ExamValidationDiagnostic(ExamValidationCode.REQUIRED_AUDIO_MISSING,
                    ExamValidationSeverity.BLOCKING, null, null, null, null, null, null, 1, null).qualifiedCode());
        }

        @Test
        @DisplayName("Diagnostics never carry question text")
        void noContentText() throws Exception {
            String json = new ObjectMapper().findAndRegisterModules().writeValueAsString(validate(toeicLr(k -> {
                k.placeholderPrompts = true;
                k.readingKey = "";
            })));
            assertFalse(json.contains("Synthetic question"), "prompts must not leak into reports");
            assertFalse(json.contains("Synthetic option"), "options must not leak into reports");
        }

        @Test
        @DisplayName("Canonical package path: real pilot packages validate with the same rules")
        void pilotPackages() throws Exception {
            Path dir = Path.of("..", "content", "exams", "original-pilot");
            org.junit.jupiter.api.Assumptions.assumeTrue(Files.isDirectory(dir), "pilot content directory not present");
            ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();

            ExamContentPackage ieltsListening = mapper.readValue(dir.resolve("IELTS/IELTS_SHARED_LISTENING_PILOT_001_V2.json").toFile(),
                    ExamContentPackage.class);
            ExamFormValidationReport l = ExamFormValidator.validate(ExamContentTree.fromPackage(ieltsListening, mapper), mapper, NOW);
            assertTrue(l.isPracticeRunnable(SkillType.LISTENING), l.blockingCodes().toString());

            ExamContentPackage toeic = mapper.readValue(dir.resolve("TOEIC/TOEIC_LR_PILOT_001_V2.json").toFile(), ExamContentPackage.class);
            ExamFormValidationReport t = ExamFormValidator.validate(ExamContentTree.fromPackage(toeic, mapper), mapper, NOW);
            assertTrue(t.blockingCodes().contains("REQUIRED_AUDIO_MISSING"), "TOEIC pilot has no listening audio: " + t.blockingCodes());
            assertFalse(t.fullSimulationEligible());
            assertFalse(t.blockingCodes().contains("TOEIC_PART_7_PASSAGE_MISSING"), "pilot Part 7 sets carry passages");
        }
    }
}
