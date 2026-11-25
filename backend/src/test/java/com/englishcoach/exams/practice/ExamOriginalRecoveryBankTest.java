package com.englishcoach.exams.practice;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.release.ExamRunnerCapabilities;
import com.englishcoach.exams.validation.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.Test;
import java.time.Instant;
import static org.junit.jupiter.api.Assertions.*;

class ExamOriginalRecoveryBankTest {
    @Test void parkingSuccessorKeepsKeysAndHistoricalClosureImmutable() throws Exception {
        var mapper = new ObjectMapper().findAndRegisterModules();
        var key = "/exams/original-practice/EC_ORIGINAL_TOEIC_LR_PRACTICE_20261006";
        var old = mapper.readValue(getClass().getResourceAsStream(key + ".json"), ExamContentPackage.class);
        var next = mapper.readValue(getClass().getResourceAsStream(key + "_V2.json"), ExamContentPackage.class);
        assertEquals(old.form().logicalKey(), next.form().logicalKey());
        assertEquals(2, next.form().version());
        assertNotEquals(old.form().id(), next.form().id());
        assertEquals(old.items().stream().map(i -> i.prompt()).toList(), next.items().stream().map(i -> i.prompt()).toList());
        assertEquals(old.answerSpecs().stream().map(a -> a.acceptedAnswers()).toList(), next.answerSpecs().stream().map(a -> a.acceptedAnswers()).toList());
        var group = next.groups().stream().filter(g -> g.logicalGroupKey().endsWith("TOEIC_LR_P7_P01_G01")).findFirst().orElseThrow();
        var id = next.groupStimuli().stream().filter(g -> g.groupId().equals(group.id())).findFirst().orElseThrow().stimulusId();
        var passage = next.stimuli().stream().filter(s -> s.id().equals(id)).findFirst().orElseThrow();
        assertEquals("Riverside Business Center parking notice", passage.title());
        assertTrue(passage.bodyPayload().get("text").toString().contains("north garage will be resurfaced"));
        assertFalse(passage.bodyPayload().get("text").toString().contains("\\n"));
        assertTrue(old.stimuli().stream().anyMatch(s -> s.title().equals("Eastwood Tool Library schedule notice")));
    }
    @Test void originalBankHasOnlyAvailableResponseScopesAndTruthfulProvenance() throws Exception {
        var mapper = new ObjectMapper().findAndRegisterModules().disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        var validator = new ExamContentPackageValidator(mapper);
        for (String key : ExamOriginalPracticeBootstrapService.PACKAGES) {
            var pkg = mapper.readValue(getClass().getResourceAsStream("/exams/original-practice/" + key + ".json"), ExamContentPackage.class);
            System.out.println("ORIGINAL_SEAL " + key + " " + validator.computeContentHash(pkg));
            var errors = validator.validate(pkg).errors();
            assertTrue(errors.isEmpty(), errors.toString());
            assertFalse((Boolean) pkg.manifest().metadata().get("humanReviewComplete"));
            assertTrue(pkg.licenses().stream().allMatch(l -> l.provenanceCategory().name().equals("ORIGINAL") && l.legalStatus().equals("PENDING")));
            var tree = ExamContentTree.fromPackage(pkg, mapper);
            var report = ExamFormValidator.validate(tree, mapper, Instant.now());
            var scopes = ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT,
                    new ExamPracticeReadiness.FormFacts(true, true), mapper);
            int expected = key.contains("WRITING") ? 2 : key.contains("LISTENING") ? 4 : 3;
            assertEquals(expected, scopes.size());
            assertTrue(scopes.stream().allMatch(ExamPracticeReadiness.ScopeReadiness::ready), scopes.toString());
            if (key.contains("WRITING") || key.contains("SPEAKING"))
                assertTrue(scopes.stream().noneMatch(s -> s.scope().objectiveScoring()));
            for (var scope : scopes) {
                var filtered = scope.scope().filterSnapshot(ExamPracticeServiceTest.snapshotOf(tree)).orElseThrow();
                var section = (java.util.Map<?, ?>) ((java.util.List<?>) filtered.get("sections")).getFirst();
                assertEquals(1, ((java.util.List<?>) section.get("parts")).size(), "independent snapshot contains only its Part");
            }
        }
    }
}
