package com.englishcoach.exams.practice;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.release.ExamRunnerCapabilities;
import com.englishcoach.exams.validation.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class ExamWritingScopeRecoveryTest {
    @Test void explicitPrintedTasksBecomeSeparateSafeScopes() throws Exception {
        var mapper = new ObjectMapper().findAndRegisterModules();
        var pkg = mapper.readValue(Path.of("../content/exams/original-pilot/IELTS/IELTS_GT_WRITING_PILOT_001_V1.json").toFile(), ExamContentPackage.class);
        var tree = ExamContentTree.fromPackage(pkg, mapper);
        var report = ExamFormValidator.validate(tree, mapper, Instant.now());
        var scopes = ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT,
                new ExamPracticeReadiness.FormFacts(true, true), mapper);
        assertEquals(List.of("IELTS_WRITING_TASK_1", "IELTS_WRITING_TASK_2"), scopes.stream().map(s -> s.scope().scopeCode()).toList());
        assertTrue(scopes.stream().allMatch(ExamPracticeReadiness.ScopeReadiness::ready), scopes.toString());
        var snapshot = ExamPracticeServiceTest.snapshotOf(tree);
        for (var readiness : scopes) {
            var scoped = readiness.scope().filterSnapshot(snapshot).orElseThrow();
            var section = (Map<?, ?>) ((List<?>) scoped.get("sections")).getFirst();
            var part = (Map<?, ?>) ((List<?>) section.get("parts")).getFirst();
            assertEquals(1, ((List<?>) part.get("groups")).size());
            assertFalse(readiness.scope().objectiveScoring());
        }
    }
    @Test void unlabeledGenericWritingPartIsNeverGuessed() {
        assertTrue(ExamPracticeScopeType.resolve(com.englishcoach.exams.model.ExamTypes.ExamFamily.IELTS,
                com.englishcoach.exams.model.ExamTypes.SkillType.WRITING, "GENERAL_TRAINING_WRITING").isEmpty());
    }
    @Test void writingPromptSurvivesSanitizingButAudioTranscriptNeverDoes() {
        var body = Map.<String, Object>of("prompt", "Write a letter to the library manager.",
                "transcript", "private answers", "sourcePath", "private source");
        assertEquals(Map.of("prompt", "Write a letter to the library manager."),
                ExamLearnerContentSanitizer.stimulusBody("TEXT", body));
        assertTrue(ExamLearnerContentSanitizer.stimulusBody("AUDIO", body).isEmpty());
    }
}
