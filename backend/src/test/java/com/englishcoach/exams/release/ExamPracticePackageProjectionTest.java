package com.englishcoach.exams.release;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.validation.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ExamPracticePackageProjectionTest {
    final ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();
    ExamContentPackage source() throws Exception { return new ExamScopedQaReadinessTest().source(); }
    @Test void independentReadingKeepsExactQuestionsAndKeysAndPrunesOtherDependencies() throws Exception {
        var source = source(); String before = mapper.writeValueAsString(source);
        var projection = ExamPracticePackageProjection.build(source, true, List.of(), Set.of("IELTS_READING_PASSAGE_2"), mapper, Instant.now());
        var pkg = projection.pkg();
        assertEquals(Set.of("IELTS_READING_PASSAGE_2"), projection.retainedScopes());
        assertEquals(1, pkg.sections().size()); assertEquals(1, pkg.parts().size());
        assertFalse(pkg.items().isEmpty()); assertTrue(pkg.assets().isEmpty());
        assertTrue(source.items().containsAll(pkg.items())); assertTrue(source.answerSpecs().containsAll(pkg.answerSpecs()));
        assertEquals(source.manifest().metadata().get("sourceProvenance"), pkg.manifest().metadata().get("sourceProvenance"));
        assertEquals(source.licenses(), pkg.licenses());
        var validator = new ExamContentPackageValidator(mapper);
        assertEquals(pkg.manifest().contentHash(), validator.computeContentHash(pkg));
        assertTrue(validator.validate(pkg).errors().stream().allMatch(e -> ExamProjectUsageAuthorization.PUBLISHER_RIGHTS_CODES.contains(e.code())),
                validator.validate(pkg).errors().toString());
        assertFalse(ExamFormValidator.validate(ExamContentTree.fromPackage(pkg, mapper), mapper, Instant.now()).fullSimulationEligible());
        assertEquals(before, mapper.writeValueAsString(source));
        assertEquals(pkg.manifest().contentHash(), ExamPracticePackageProjection.build(source, true, List.of(), Set.of("IELTS_READING_PASSAGE_2"), mapper, Instant.now()).pkg().manifest().contentHash());
        var media = ExamMediaImportPlan.plan(pkg, java.nio.file.Path.of(".."), true);
        var gate = ExamPracticeReleaseReadiness.evaluate(projection, media, mapper, Instant.now());
        assertTrue(gate.importReady(), gate.blockers().toString());
        var plan = ExamImportPlanner.planPractice(pkg, gate, media, List.of(), ExamImportPlanner.StateReader.EMPTY, ExamImportPlanner.Target.PRODUCTION);
        assertEquals(ExamImportPlanner.Operation.CREATE, plan.operation());
        assertEquals("PRACTICE", plan.releaseGate().get("releaseKind"));
        assertEquals(false, plan.expectedValidation().get("fullSimulationEligible"));
        var wrongGate = new ExamPracticeReleaseReadiness.Decision("0".repeat(64), true, gate.scopes(), gate.structural(), List.of());
        assertEquals(ExamImportPlanner.Operation.BLOCKED, ExamImportPlanner.planPractice(pkg, wrongGate, media, List.of(), ExamImportPlanner.StateReader.EMPTY, ExamImportPlanner.Target.PRODUCTION).operation());
    }
    @Test void affectedScopeAndUnknownQaFailClosedWhileIndependentScopeCanBeSelected() throws Exception {
        var source = source(); var qa = new ExamScopedQaReadinessTest().entry(source);
        qa.put("scope", "ANSWER_KEY/READING"); qa.put("questions", "9,38");
        assertThrows(IllegalArgumentException.class, () -> ExamPracticePackageProjection.build(source, true, List.of(qa), Set.of("IELTS_READING_PASSAGE_1"), mapper, Instant.now()));
        assertDoesNotThrow(() -> ExamPracticePackageProjection.build(source, true, List.of(qa), Set.of("IELTS_READING_PASSAGE_2"), mapper, Instant.now()));
        assertThrows(IllegalArgumentException.class, () -> ExamPracticePackageProjection.build(source, false, List.of(), null, mapper, Instant.now()));
        assertThrows(IllegalArgumentException.class, () -> ExamPracticePackageProjection.build(source, true, List.of(), Set.of("INVENTED_SCOPE"), mapper, Instant.now()));
    }
}
